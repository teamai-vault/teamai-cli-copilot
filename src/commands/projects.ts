import { readGlobalConfig } from "../config/global.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { convergeLogicalProjectContext, projectionFor, withProjection } from "../project/context.js";
import { loadLogicalProjects, parseLogicalProjectIds, selectedLogicalProjects } from "../project/manifest.js";
import { readProjectState, writeProjectState } from "../project/state.js";
import type { CommandContext } from "./context.js";

export async function projectsListCommand(context: CommandContext): Promise<void> {
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
  try {
    if (catalog.name !== config.marketplace.name) throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
    const identity = await detectProjectIdentity(context.cwd);
    const state = identity ? await readProjectState(identity.projectAnchor, context.homeDir) : undefined;
    const active = new Set(identity ? projectionFor(state, identity.workspaceRoot)?.logicalProjects : []);
    for (const project of await loadLogicalProjects(catalog.root, catalog.plugins)) {
      context.out(`${active.has(project.id) ? "*" : " "} ${project.id} | ${project.owners.join(", ")}${project.plugin ? ` | plugin: ${project.plugin}` : ""}`);
    }
  } finally {
    await catalog.dispose();
  }
}

export async function projectsSetCommand(context: CommandContext, values: string[]): Promise<void> {
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const identity = await detectProjectIdentity(context.cwd);
  if (!identity) throw new Error("teamai projects set requires a Git repository.");
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
  try {
    if (catalog.name !== config.marketplace.name) throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
    const ids = parseLogicalProjectIds(values);
    selectedLogicalProjects(await loadLogicalProjects(catalog.root, catalog.plugins), ids);
    const state = await readProjectState(identity.projectAnchor, context.homeDir);
    const result = await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state, logicalProjects: ids, dryRun: context.dryRun });
    for (const change of result.changes) context.out(`${context.dryRun ? "WOULD" : "DONE"} write: ${change}`);
    for (const warning of result.warnings) context.out(`! ${warning}`);
    if (!context.dryRun) await writeProjectState(identity.projectAnchor, withProjection(state ?? {
      schemaVersion: 1,
      workspaceRoot: identity.workspaceRoot,
      lastSync: context.now().toISOString(),
      managedPlugins: config.managedPlugins ?? [],
    }, result.projection), context.homeDir);
  } finally {
    await catalog.dispose();
  }
}
