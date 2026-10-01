import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { ManagedPluginReceipt, PluginMutationAction, PluginMutationJournal, PluginObservedState, TeamAiConfig } from "../config/schema.js";
import { readSkillFrontmatter, type CatalogPlugin, type CatalogSkill } from "./catalog.js";
import type { CopilotOperations, InstalledPlugin } from "./cli.js";
import { computeResourceSnapshot, resourceSourceHash, userPluginResource, type ResourceDelivery, type ResourceRecord } from "../resources/snapshot.js";
import { VERSION } from "../version.js";
import { pathsEqual } from "../utils/fs.js";

export interface PlannedAction {
  kind: "marketplace-add" | "plugin-install" | "plugin-enable" | "plugin-update" | "plugin-disable";
  target: string;
}

export interface ConvergeResult {
  actions: PlannedAction[];
  catalogAvailable: boolean;
  managedPlugins: string[];
  resources: ResourceRecord[];
  warnings: string[];
}

export function userPlugins(catalog: CatalogPlugin[], marketplaceName: string): string[] {
  return catalog
    .filter((plugin) => plugin.kind === "common" || plugin.kind === "role")
    .map((plugin) => `${plugin.name}@${marketplaceName}`);
}

export function enabledUserPlugins(role: string, catalog: CatalogPlugin[], marketplaceName: string): string[] {
  const common = catalog.find((plugin) => plugin.kind === "common");
  const selected = catalog.find((plugin) => plugin.kind === "role" && plugin.name === role);
  if (!common) throw new Error("Marketplace does not contain a Team AI common plugin.");
  if (!selected) {
    const roles = catalog.filter((plugin) => plugin.kind === "role").map((plugin) => plugin.name);
    throw new Error(`Unknown role '${role}'. Expected one of: ${roles.join(", ")}.`);
  }
  return [`${common.name}@${marketplaceName}`, `${selected.name}@${marketplaceName}`];
}

export function pluginSpec(plugin: Pick<InstalledPlugin, "name" | "marketplace">): string {
  return plugin.marketplace ? `${plugin.name}@${plugin.marketplace}` : plugin.name;
}

export async function inspectPluginDelivery(
  plugin: Pick<InstalledPlugin, "name" | "version" | "cache_path">,
): Promise<ResourceDelivery> {
  if (typeof plugin.cache_path !== "string" || plugin.cache_path.length === 0 || !plugin.version) return "unknown";
  try {
    const root = await lstat(plugin.cache_path);
    if (root.isSymbolicLink() || !root.isDirectory()) return "stale";
    const manifestPath = `${plugin.cache_path}/plugin.json`;
    const manifestFile = await lstat(manifestPath);
    if (!manifestFile.isFile() || manifestFile.isSymbolicLink()) return "stale";
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) return "stale";
      throw error;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return "stale";
    const identity = manifest as { name?: unknown; version?: unknown };
    return identity.name === plugin.name && identity.version === plugin.version ? "present" : "stale";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function inspectPluginSkillDelivery(
  plugin: Pick<InstalledPlugin, "name" | "version" | "cache_path">,
  skill: CatalogSkill,
): Promise<ResourceDelivery> {
  if (skill.sourceType !== "plugin" || skill.plugin !== plugin.name) return "unknown";
  const packageDelivery = await inspectPluginDelivery(plugin);
  if (packageDelivery !== "present") return packageDelivery;
  const skillPath = path.join(plugin.cache_path!, "skills", skill.name, "SKILL.md");
  try {
    const file = await lstat(skillPath);
    if (!file.isFile()) return "stale";
    try {
      const frontmatter = await readSkillFrontmatter(skillPath);
      return frontmatter.name === skill.name ? "present" : "stale";
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.startsWith(`Marketplace skill '${skillPath}' `)) return "stale";
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export async function inspectUserPluginResources(
  catalog: CatalogPlugin[],
  marketplaceName: string,
  sourceHash: string,
  installed: Array<{ name: string; marketplace?: string; version?: string; cache_path?: string; enabled?: boolean; discoveredOnly?: boolean }>,
  options: {
    managedPlugins?: Iterable<string>;
    expectedEnabled?: ReadonlySet<string>;
    settingsEnabled?: Record<string, boolean>;
    resourceRevision?: string;
  } = {},
): Promise<ResourceRecord[]> {
  const owned = new Set(options.managedPlugins ?? []);
  return await Promise.all(userPlugins(catalog, marketplaceName).map(async (spec) => {
    const [name] = spec.split("@");
    const current = installed.find((candidate) => candidate.name === name && candidate.marketplace === marketplaceName);
    const resource = userPluginResource({
      spec,
      sourceHash,
      relativePath: `plugins/${name}/plugin.json`,
      revision: options.resourceRevision,
      selected: true,
      owned: owned.has(spec),
      targetPath: current?.cache_path,
      delivery: current ? await inspectPluginDelivery(current) : "missing",
      configuredActive: current?.enabled ?? options.settingsEnabled?.[spec] ?? "unknown",
      expectedActive: current?.discoveredOnly ? undefined : options.expectedEnabled?.has(spec),
    });
    if (current?.discoveredOnly) resource.reasons.push("DISCOVERED_ONLY");
    return resource;
  }));
}

export async function convergeUserPlugins(
  client: CopilotOperations,
  config: TeamAiConfig,
  catalog: CatalogPlugin[],
  options: { dryRun?: boolean; cwd?: string; resourceRevision?: string; checkpoint?: (config: TeamAiConfig) => Promise<void> } = {},
): Promise<ConvergeResult> {
  if (!config.role) throw new Error("No Team AI role is configured. Run `teamai init` first.");

  const actions: PlannedAction[] = [];
  const warnings: string[] = [];
  const enabledSpecs = new Set(enabledUserPlugins(config.role, catalog, config.marketplace.name));
  let owned = new Set(config.managedPlugins ?? []);
  const marketplaces = await client.listMarketplaces(options.cwd);
  let installed = await client.listPlugins(options.cwd);
  if (!options.dryRun && config.pendingPluginMutation) {
    await recoverPendingMutation(config, installed, options.checkpoint);
    owned = new Set(config.managedPlugins ?? []);
  }
  if (!marketplaces.some((item) => item.name === config.marketplace.name)) {
    actions.push({ kind: "marketplace-add", target: config.marketplace.source });
    if (!options.dryRun) {
      await client.addMarketplace(config.marketplace.source, options.cwd);
      if (!(await client.listMarketplaces(options.cwd)).some((item) => item.name === config.marketplace.name)) {
        throw new Error(`Marketplace '${config.marketplace.name}' was not visible after registration.`);
      }
    }
  }

  installed = await client.listPlugins(options.cwd);
  for (const receipt of config.managedPluginReceipts ?? []) {
    const plugin = installed.find((item) => pluginSpec(item) === receipt.spec);
    if (!plugin || !receipt.cachePath) continue;
    const observed = await observePlugin(installed, receipt.spec);
    const planned = client.pluginInstallIdentity?.(receipt.spec);
    // Fallback discovery marks a missing config record as filesystem; its owned destination is unchanged.
    if (plugin.source === "filesystem" && planned && pathsEqual(planned.cachePath, receipt.cachePath)
      && planned.source === undefined && receipt.source === undefined
      && planned.installedFrom === undefined && receipt.installedFrom === undefined && observed.installedFrom === undefined) {
      observed.source = undefined;
    }
    if (!sameSource(config.marketplace.source, receipt.marketplaceSource) || !sameDeliveryIdentity(observed, receipt)) {
      throw new Error(`Copilot Plugin ownership source/target conflict for '${receipt.spec}'; preserving its receipt.`);
    }
  }
  const records = await inspectUserPluginResources(catalog, config.marketplace.name, resourceSourceHash(config.marketplace.source), installed, {
    managedPlugins: owned,
    expectedEnabled: enabledSpecs,
    resourceRevision: options.resourceRevision,
  });
  const resourceSnapshot = computeResourceSnapshot({
    cliVersion: VERSION,
    scope: "user",
    resources: records,
  });

  const execute = async (
    kind: PlannedAction["kind"],
    spec: string,
    catalogPlugin: CatalogPlugin | undefined,
    action: () => Promise<void>,
  ): Promise<void> => {
    actions.push({ kind, target: spec });
    if (options.dryRun) {
      if (kind === "plugin-install") owned.add(spec);
      return;
    }
    const currentObservation = await observePlugin(installed, spec);
    const sourceManifestHash = catalogPlugin
      ? await pluginManifestHash(catalogPlugin.root)
      : currentObservation.manifestHash;
    if (!sourceManifestHash) throw new Error(`Cannot verify the Plugin package manifest for '${spec}'.`);
    const expectedAfter = expectedPluginState(kind, currentObservation, catalogPlugin, sourceManifestHash);
    if (kind === "plugin-install" || kind === "plugin-update") {
      const row = installed.find((item) => pluginSpec(item) === spec);
      const planned = client.pluginInstallIdentity?.(spec);
      const root = planned?.cachePath ?? row?.cache_path;
      if (root) expectedAfter.cachePath = path.resolve(root);
      if (planned) {
        expectedAfter.source = planned.source;
        expectedAfter.installedFrom = planned.installedFrom;
      } else {
        if (typeof row?.source === "string") expectedAfter.source = row.source;
        if (typeof row?.installedFrom === "string") expectedAfter.installedFrom = row.installedFrom;
      }
    }
    if (!expectedAfter.cachePath) throw new Error(`Cannot verify the Plugin delivery target for '${spec}'; no mutation was performed.`);
    const journal: PluginMutationJournal = {
      spec,
      action: mutationAction(kind),
      sourceManifestHash,
      marketplaceSource: config.marketplace.source,
      expectedBefore: currentObservation,
      expectedAfter,
    };
    config.pendingPluginMutation = journal;
    await options.checkpoint?.(config);
    let actionError: unknown;
    try {
      await action();
    } catch (error) {
      actionError = error;
    }
    installed = await client.listPlugins(options.cwd);
    const observed = await observePlugin(installed, spec);
    if (matchesPluginState(observed, expectedAfter) && sameDeliveryIdentity(observed, expectedAfter)) {
      recordCompletedMutation(config, journal, observed);
      await options.checkpoint?.(config);
      if (kind === "plugin-install") owned.add(spec);
      return;
    }
    if (matchesPluginState(observed, currentObservation)) {
      delete config.pendingPluginMutation;
      await options.checkpoint?.(config);
      if (actionError) throw actionError;
      throw new Error(`Copilot ${kind} did not change '${spec}' to its expected state.`);
    }
    const cause = actionError instanceof Error ? ` ${actionError.message}` : "";
    throw new Error(`Partial Copilot ${kind} for '${spec}': readback matched neither the expected before nor after state.${cause}`);
  };

  for (const resource of resourceSnapshot.resources) {
    if (!resource.selected || !resource.pluginSpec) continue;
    const spec = resource.pluginSpec;
    const [name, marketplace] = spec.split("@");
    let current = installed.find((item) => item.name === name && item.marketplace === marketplace);
    const catalogPlugin = catalog.find((plugin) => plugin.name === name && (plugin.kind === "common" || plugin.kind === "role"));
    if (!current || current.discoveredOnly || (owned.has(spec) && (current.source === "filesystem" || resource.delivery === "missing" || resource.delivery === "stale"))) {
      await execute("plugin-install", spec, catalogPlugin, () => client.installPlugin(spec, options.cwd));
      current = options.dryRun
        ? { name, marketplace, version: catalogPlugin?.version, enabled: true }
        : installed.find((item) => item.name === name && item.marketplace === marketplace);
      if (!current) throw new Error(`${spec} was not visible after installation.`);
    } else if (!resource.owned) {
      warnings.push(resource.reasons.includes("USER_OVERRIDE")
        ? `${spec} is user-owned and differs from the selected role; preserving the override.`
        : `${spec} already exists but is not Team AI managed; preserving the user's enabled/version state.`);
      continue;
    }

    const shouldEnable = enabledSpecs.has(spec);
    const mirrorOutOfSync = current !== undefined && "mirroredEnabled" in current && current.mirroredEnabled !== shouldEnable;
    if (shouldEnable && (current?.enabled === false || mirrorOutOfSync)) {
      await execute("plugin-enable", spec, undefined, () => client.enablePlugin(spec, options.cwd));
      current = installed.find((item) => item.name === name && item.marketplace === marketplace) ?? current;
    } else if (!shouldEnable && (current?.enabled !== false || mirrorOutOfSync)) {
      await execute("plugin-disable", spec, undefined, () => client.disablePlugin(spec, options.cwd));
      current = installed.find((item) => item.name === name && item.marketplace === marketplace) ?? current;
    }

    const latest = catalog.find((plugin) => plugin.name === name)?.version;
    if (latest && current?.version && latest !== current.version) {
      await execute("plugin-update", spec, catalogPlugin, () => client.updatePlugin(spec, options.cwd));
      current = installed.find((item) => item.name === name && item.marketplace === marketplace) ?? current;
    }
  }

  const catalogUserSpecs = new Set(userPlugins(catalog, config.marketplace.name));
  for (let current of installed) {
    const spec = `${current.name}@${current.marketplace ?? ""}`;
    if (!owned.has(spec) || current.marketplace !== config.marketplace.name || enabledSpecs.has(spec) || catalogUserSpecs.has(spec) || current.source === "filesystem") continue;
    const role = await isOwnedRolePackage(current);
    if (!role) {
      warnings.push(`${spec} is no longer present in the Marketplace catalog, but its cached manifest does not confirm a Team AI role Plugin; preserving its state.`);
      continue;
    }
    if (current.enabled === false && (!("mirroredEnabled" in current) || current.mirroredEnabled === false)) continue;

    await execute("plugin-disable", spec, undefined, () => client.disablePlugin(spec, options.cwd));
    if (options.dryRun) continue;
    current = installed.find((plugin) => plugin.name === current.name && plugin.marketplace === current.marketplace)!;
    if (!current || current.enabled !== false || ("mirroredEnabled" in current && current.mirroredEnabled !== false)) {
      throw new Error(`Retired Team AI role Plugin '${spec}' did not remain disabled after verification.`);
    }
  }

  return { actions, catalogAvailable: true, managedPlugins: [...owned].sort(), resources: resourceSnapshot.resources, warnings };
}

function mutationAction(kind: PlannedAction["kind"]): PluginMutationAction {
  if (kind === "plugin-install") return "install";
  if (kind === "plugin-enable") return "enable";
  if (kind === "plugin-disable") return "disable";
  if (kind === "plugin-update") return "update";
  throw new Error(`Unsupported Plugin mutation '${kind}'.`);
}

async function pluginManifestHash(pluginRoot: string): Promise<string> {
  return createHash("sha256").update(await readFile(path.join(pluginRoot, "plugin.json"))).digest("hex");
}

async function observePlugin(installed: InstalledPlugin[], spec: string): Promise<PluginObservedState> {
  const at = spec.lastIndexOf("@");
  const name = spec.slice(0, at);
  const marketplace = spec.slice(at + 1);
  const plugin = installed.find((item) => item.name === name && item.marketplace === marketplace);
  if (!plugin || plugin.discoveredOnly) return { installed: false };
  let manifestHash: string | undefined;
  if (plugin.cache_path) {
    try {
      manifestHash = createHash("sha256").update(await readFile(path.join(plugin.cache_path, "plugin.json"))).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    installed: true,
    ...(plugin.version ? { version: plugin.version } : {}),
    enabled: plugin.enabled,
    ...(plugin.cache_path ? { cachePath: path.resolve(plugin.cache_path) } : {}),
    ...(manifestHash ? { manifestHash } : {}),
    ...(typeof plugin.source === "string" ? { source: plugin.source } : {}),
    ...(typeof plugin.installedFrom === "string" ? { installedFrom: plugin.installedFrom } : {}),
  };
}

function expectedPluginState(
  kind: PlannedAction["kind"],
  before: PluginObservedState,
  catalogPlugin: CatalogPlugin | undefined,
  sourceManifestHash: string,
): PluginObservedState {
  if (kind === "plugin-install" || kind === "plugin-update") {
    if (!catalogPlugin) throw new Error(`Marketplace catalog cannot verify '${kind}'.`);
    return {
      installed: true,
      version: catalogPlugin.version,
      enabled: kind === "plugin-install" ? true : before.enabled,
      manifestHash: sourceManifestHash,
    };
  }
  if (!before.installed) throw new Error(`Cannot ${kind} an uninstalled Plugin.`);
  return { ...before, enabled: kind === "plugin-enable" };
}

function matchesPluginState(actual: PluginObservedState, expected: PluginObservedState): boolean {
  if (actual.installed !== expected.installed) return false;
  for (const key of ["version", "enabled", "manifestHash", "source"] as const) {
    if (expected[key] !== undefined && actual[key] !== expected[key]) return false;
  }
  if (expected.cachePath !== undefined && path.resolve(actual.cachePath ?? "") !== path.resolve(expected.cachePath)) return false;
  if (expected.installedFrom !== undefined && !sameSource(actual.installedFrom, expected.installedFrom)) return false;
  return true;
}

function recordCompletedMutation(config: TeamAiConfig, journal: PluginMutationJournal, observed: PluginObservedState): void {
  if (!observed.installed || !observed.version || !observed.manifestHash || observed.enabled === undefined || !observed.cachePath) {
    throw new Error(`Copilot did not return complete Plugin readback for '${journal.spec}'.`);
  }
  const receipts = (config.managedPluginReceipts ?? []).filter((item) => item.spec !== journal.spec);
  receipts.push({ spec: journal.spec, manifestHash: observed.manifestHash, version: observed.version, enabled: observed.enabled,
    marketplaceSource: journal.marketplaceSource, cachePath: observed.cachePath, source: observed.source, installedFrom: observed.installedFrom });
  config.managedPluginReceipts = receipts;
  if (journal.action === "install" && !config.managedPlugins?.includes(journal.spec)) {
    config.managedPlugins = [...(config.managedPlugins ?? []), journal.spec].sort();
  }
  delete config.pendingPluginMutation;
}

async function recoverPendingMutation(
  config: TeamAiConfig,
  installed: InstalledPlugin[],
  checkpoint?: (config: TeamAiConfig) => Promise<void>,
): Promise<void> {
  const journal = config.pendingPluginMutation;
  if (!journal) return;
  if (!sameSource(config.marketplace.source, journal.marketplaceSource) || !journal.expectedAfter.cachePath) {
    throw new Error(`Pending Copilot ${journal.action} for '${journal.spec}' lacks verified source/target identity; preserving its ownership evidence.`);
  }
  const actual = await observePlugin(installed, journal.spec);
  if (actual.installed && !sameDeliveryIdentity(actual, journal.expectedAfter)) {
    throw new Error(`Pending Copilot ${journal.action} for '${journal.spec}' has a source/target conflict; preserving its ownership evidence.`);
  }
  if (matchesPluginState(actual, journal.expectedAfter) && actual.manifestHash === journal.sourceManifestHash) {
    recordCompletedMutation(config, journal, actual);
  } else if (matchesPluginState(actual, journal.expectedBefore)) {
    delete config.pendingPluginMutation;
  } else {
    throw new Error(`Pending Copilot ${journal.action} for '${journal.spec}' has ambiguous readback; preserving its ownership evidence.`);
  }
  await checkpoint?.(config);
}

function sameSource(actual: string | undefined, expected: string | undefined): boolean {
  if (actual === undefined || expected === undefined) return actual === expected;
  return path.isAbsolute(actual) && path.isAbsolute(expected) ? pathsEqual(actual, expected) : actual === expected;
}

function sameDeliveryIdentity(actual: PluginObservedState, expected: Pick<PluginObservedState, "cachePath" | "source" | "installedFrom">): boolean {
  return !!actual.cachePath && !!expected.cachePath && pathsEqual(actual.cachePath, expected.cachePath)
    && actual.source === expected.source && sameSource(actual.installedFrom, expected.installedFrom);
}

async function isOwnedRolePackage(plugin: InstalledPlugin): Promise<boolean> {
  if (typeof plugin.cache_path !== "string" || plugin.cache_path.length === 0) return false;
  try {
    const root = await lstat(plugin.cache_path);
    if (!root.isDirectory() || root.isSymbolicLink()) return false;
    const manifestPath = path.join(plugin.cache_path, "plugin.json");
    const manifestInfo = await lstat(manifestPath);
    if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink()) return false;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      name?: unknown;
      extensions?: Record<string, { kind?: unknown }>;
    };
    return manifest.name === plugin.name && manifest.extensions?.["com.company.teamai"]?.kind === "role";
  } catch (error) {
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
