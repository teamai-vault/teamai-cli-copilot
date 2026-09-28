import type { TeamAiConfig } from "../config/schema.js";
import type { CatalogPlugin } from "./catalog.js";
import type { CopilotOperations, InstalledPlugin } from "./cli.js";

export interface PlannedAction {
  kind: "marketplace-add" | "plugin-install" | "plugin-enable" | "plugin-update" | "plugin-disable";
  target: string;
}

export interface ConvergeResult {
  actions: PlannedAction[];
  catalogAvailable: boolean;
  managedPlugins: string[];
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

export async function convergeUserPlugins(
  client: CopilotOperations,
  config: TeamAiConfig,
  catalog: CatalogPlugin[],
  options: { dryRun?: boolean; cwd?: string } = {},
): Promise<ConvergeResult> {
  if (!config.role) throw new Error("No Team AI role is configured. Run `teamai init` first.");

  const actions: PlannedAction[] = [];
  const warnings: string[] = [];
  const installSpecs = userPlugins(catalog, config.marketplace.name);
  const enabledSpecs = new Set(enabledUserPlugins(config.role, catalog, config.marketplace.name));
  const owned = new Set(config.managedPlugins ?? []);
  const marketplaces = await client.listMarketplaces(options.cwd);
  if (!marketplaces.some((item) => item.name === config.marketplace.name)) {
    actions.push({ kind: "marketplace-add", target: config.marketplace.source });
    if (!options.dryRun) await client.addMarketplace(config.marketplace.source, options.cwd);
  }

  let installed = await client.listPlugins(options.cwd);
  for (const spec of installSpecs) {
    const [name, marketplace] = spec.split("@");
    let current = installed.find((item) => item.name === name && item.marketplace === marketplace);
    if (!current || (owned.has(spec) && current.source === "filesystem") || (!owned.has(spec) && current.enabled === false && current.source === `live-marketplace:${marketplace}`)) {
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
    } else if (!owned.has(spec)) {
      warnings.push(`${spec} already exists but is not Team AI managed; preserving the user's enabled/version state.`);
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

  return { actions, catalogAvailable: true, managedPlugins: [...owned].sort(), warnings };
}
