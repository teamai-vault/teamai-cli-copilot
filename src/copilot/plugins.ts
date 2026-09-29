import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import type { TeamAiConfig } from "../config/schema.js";
import { readSkillFrontmatter, type CatalogPlugin, type CatalogSkill } from "./catalog.js";
import type { CopilotOperations, InstalledPlugin } from "./cli.js";
import { computeResourceSnapshot, resourceSourceHash, userPluginResource, type ResourceDelivery, type ResourceRecord } from "../resources/snapshot.js";
import { VERSION } from "../version.js";

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
  installed: Array<{ name: string; marketplace?: string; version?: string; cache_path?: string; enabled?: boolean }>,
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
    return userPluginResource({
      spec,
      sourceHash,
      relativePath: `plugins/${name}/plugin.json`,
      revision: options.resourceRevision,
      selected: true,
      owned: owned.has(spec),
      targetPath: current?.cache_path,
      delivery: current ? await inspectPluginDelivery(current) : "missing",
      configuredActive: current?.enabled ?? options.settingsEnabled?.[spec] ?? "unknown",
      expectedActive: options.expectedEnabled?.has(spec),
    });
  }));
}

export async function convergeUserPlugins(
  client: CopilotOperations,
  config: TeamAiConfig,
  catalog: CatalogPlugin[],
  options: { dryRun?: boolean; cwd?: string; resourceRevision?: string } = {},
): Promise<ConvergeResult> {
  if (!config.role) throw new Error("No Team AI role is configured. Run `teamai init` first.");

  const actions: PlannedAction[] = [];
  const warnings: string[] = [];
  const enabledSpecs = new Set(enabledUserPlugins(config.role, catalog, config.marketplace.name));
  const owned = new Set(config.managedPlugins ?? []);
  const marketplaces = await client.listMarketplaces(options.cwd);
  if (!marketplaces.some((item) => item.name === config.marketplace.name)) {
    actions.push({ kind: "marketplace-add", target: config.marketplace.source });
    if (!options.dryRun) await client.addMarketplace(config.marketplace.source, options.cwd);
  }

  let installed = await client.listPlugins(options.cwd);
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

  for (const resource of resourceSnapshot.resources) {
    if (!resource.selected || !resource.pluginSpec) continue;
    const spec = resource.pluginSpec;
    const [name, marketplace] = spec.split("@");
    let current = installed.find((item) => item.name === name && item.marketplace === marketplace);
    if (!current || (owned.has(spec) && (current.source === "filesystem" || resource.delivery === "missing" || resource.delivery === "stale"))) {
      actions.push({ kind: "plugin-install", target: spec });
      owned.add(spec);
      if (!options.dryRun) {
        await client.installPlugin(spec, options.cwd);
        installed = await client.listPlugins(options.cwd);
        current = installed.find((item) => item.name === name && item.marketplace === marketplace);
        if (!current) throw new Error(`${spec} was not visible after installation.`);
      } else {
        current = { name, marketplace, version: catalog.find((plugin) => plugin.name === name)?.version, enabled: true };
      }
    } else if (!resource.owned) {
      warnings.push(resource.reasons.includes("USER_OVERRIDE")
        ? `${spec} is user-owned and differs from the selected role; preserving the override.`
        : `${spec} already exists but is not Team AI managed; preserving the user's enabled/version state.`);
      continue;
    }

    const shouldEnable = enabledSpecs.has(spec);
    const mirrorOutOfSync = current !== undefined && "mirroredEnabled" in current && current.mirroredEnabled !== shouldEnable;
    if (shouldEnable && (current?.enabled === false || mirrorOutOfSync)) {
      actions.push({ kind: "plugin-enable", target: spec });
      if (!options.dryRun) await client.enablePlugin(spec, options.cwd);
    } else if (!shouldEnable && (current?.enabled !== false || mirrorOutOfSync)) {
      actions.push({ kind: "plugin-disable", target: spec });
      if (!options.dryRun) await client.disablePlugin(spec, options.cwd);
    }

    const latest = catalog.find((plugin) => plugin.name === name)?.version;
    if (latest && current?.version && latest !== current.version) {
      actions.push({ kind: "plugin-update", target: spec });
      if (!options.dryRun) await client.updatePlugin(spec, options.cwd);
    }
  }

  return { actions, catalogAvailable: true, managedPlugins: [...owned].sort(), resources: resourceSnapshot.resources, warnings };
}
