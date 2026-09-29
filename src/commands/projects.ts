import { readGlobalConfig } from "../config/global.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { convergeLogicalProjectContext, projectionFor, withProjection, withoutProjection } from "../project/context.js";
import { loadLogicalProjects, parseLogicalProjectIds, selectedLogicalProjects } from "../project/manifest.js";
import { readProjectState, withProjectStateLock, type ProjectState } from "../project/state.js";
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
    if (context.dryRun) {
      const state = await readProjectState(identity.projectAnchor, context.homeDir);
      const result = await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state, logicalProjects: ids, unbind: ids.length === 0, dryRun: true });
      for (const change of result.changes) context.out(`WOULD write: ${change}`);
      for (const warning of result.warnings) context.out(`! ${warning}`);
      return;
    }

    let resultChanges: string[] = [];
    let warnings: string[] = [];
    let partial = false;
    try {
      await withProjectStateLock(identity.projectAnchor, context.homeDir, async (state) => {
        const result = await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state, logicalProjects: ids, unbind: ids.length === 0 });
        resultChanges = result.changes;
        warnings = result.warnings;
        partial = resultChanges.length > 0;
        if (ids.length === 0) {
          const previous = projectionFor(state, identity.workspaceRoot);
          if (!previous) return { result };
          const next = withoutProjection(state!, identity.workspaceRoot);
          if (result.managedGitExcludeEntries.length > 0) next.managedGitExcludeEntries = result.managedGitExcludeEntries;
          else delete next.managedGitExcludeEntries;
          return { state: Object.keys(next.projections ?? {}).length === 0 ? null : next, result };
        }
        const base: ProjectState = state ?? {
          schemaVersion: 1,
          workspaceRoot: identity.workspaceRoot,
          lastSync: context.now().toISOString(),
          managedPlugins: config.managedPlugins ?? [],
        };
        const next = withProjection({ ...base, lastSync: context.now().toISOString() }, result.projection);
        if (result.managedGitExcludeEntries.length > 0) next.managedGitExcludeEntries = result.managedGitExcludeEntries;
        else delete next.managedGitExcludeEntries;
        return { state: next, result };
      });
    } catch (error) {
      if (partial) throw new Error(`Partial Workspace project update; project state could not be confirmed. ${(error as Error).message}`);
      throw error;
    }
    for (const change of resultChanges) context.out(`DONE write: ${change}`);
    for (const warning of warnings) context.out(`! ${warning}`);
  } finally {
    await catalog.dispose();
  }
}
