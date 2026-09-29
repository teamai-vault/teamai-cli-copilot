import { readGlobalConfig } from "../config/global.js";
import { FallbackCopilotClient } from "../copilot/fallback.js";
import path from "node:path";
import { detectProjectIdentity } from "../project/anchors.js";
import { convergeLogicalProjectContext, markPublishedLearningComplete, markPublishedLearningPending, projectionFor, withProjection, withoutProjection } from "../project/context.js";
import { loadLogicalProjects, parseLogicalProjectIds, selectedLogicalProjects } from "../project/manifest.js";
import { readProjectState, withProjectStateLock, type ProjectState } from "../project/state.js";
import { readPublishedLearningSnapshot } from "../project/published-cache.js";
import { resolveCopilotBackend, type CommandContext } from "./context.js";

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
  await resolveCopilotBackend(context);
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const identity = await detectProjectIdentity(context.cwd);
  if (!identity) throw new Error("teamai projects set requires a Git repository.");
  const ids = parseLogicalProjectIds(values);
  const stateSnapshot = await readProjectState(identity.projectAnchor, context.homeDir);
  assertNoPendingProjectTransition(projectionFor(stateSnapshot, identity.workspaceRoot));
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
  try {
    if (catalog.name !== config.marketplace.name) throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
    const selectedProjects = selectedLogicalProjects(await loadLogicalProjects(catalog.root, catalog.plugins), ids);
    const selectedIds = selectedProjects.map((project) => project.id);
    const learningCache = selectedIds.length > 0
      ? await readPublishedLearningSnapshot(config.marketplace.source, context.homeDir)
      : undefined;
    const publishedLearningRoot = learningCache?.snapshot?.root;
    if (selectedIds.length > 0 && !publishedLearningRoot) {
      await convergeLogicalProjectContext({
        marketplaceRoot: catalog.root,
        plugins: catalog.plugins,
        marketplace: config.marketplace,
        identity,
        state: stateSnapshot,
        logicalProjects: selectedIds,
        dryRun: true,
      });
      throw new Error(learningCache?.error ?? "Published Learnings cache is unavailable. Run `teamai sync` to refresh it.");
    }
    if (context.dryRun) {
      const result = await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state: stateSnapshot, logicalProjects: selectedIds, publishedLearningRoot, unbind: selectedIds.length === 0, dryRun: true });
      for (const change of result.changes) context.out(`WOULD write: ${change}`);
      for (const warning of result.warnings) context.out(`! ${warning}`);
      if (context.copilotMode === "fallback" && context.copilot instanceof FallbackCopilotClient) {
        for (const plugin of new Set(selectedProjects.flatMap((project) => project.plugin ? [project.plugin] : []))) {
          const spec = `${plugin}@${config.marketplace.name}`;
          const packageResult = await context.copilot.materializeProjectPlugin(spec, context.cwd, true);
          context.out(packageResult.status === "unavailable"
            ? `UNAVAILABLE: ${packageResult.reason}`
            : packageResult.status === "preserved"
              ? `PRESERVE existing unowned project Plugin package ${spec} at ${packageResult.path}`
              : `WOULD write: project Plugin package ${spec} to ${packageResult.path}`);
        }
      }
      return;
    }

    let resultChanges: string[] = [];
    let warnings: string[] = [];
    let partial = false;
    try {
      await withProjectStateLock(identity.projectAnchor, context.homeDir, async (state, saveCheckpoint) => {
        const previous = projectionFor(state, identity.workspaceRoot);
        assertNoPendingProjectTransition(previous);
        const base: ProjectState = state ?? {
          schemaVersion: 1,
          workspaceRoot: identity.workspaceRoot,
          lastSync: context.now().toISOString(),
          managedPlugins: config.managedPlugins ?? [],
        };
        const learningRevision = learningCache?.snapshot?.revision;
        if (selectedIds.length > 0) {
          await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state, logicalProjects: selectedIds, publishedLearningRoot, dryRun: true });
        }
        if (selectedIds.length > 0 && learningRevision) {
          const pendingProjection = markPublishedLearningPending(previous ?? {
              workspaceRoot: identity.workspaceRoot,
              logicalProjects: [],
              managedProjectPlugins: [],
              instructionRoot: path.join(identity.workspaceRoot, ".github", "instructions", "teamai"),
              contextRoot: path.join(identity.workspaceRoot, ".teamai", "context"),
            }, learningRevision, selectedIds);
          await saveCheckpoint(withProjection(base, pendingProjection));
        }
        const result = await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state, logicalProjects: selectedIds, publishedLearningRoot, unbind: selectedIds.length === 0 });
        resultChanges = result.changes;
        warnings = result.warnings;
        partial = resultChanges.length > 0;
        if (selectedIds.length === 0) {
          const previous = projectionFor(state, identity.workspaceRoot);
          if (!previous) return { result };
          const next = withoutProjection(state!, identity.workspaceRoot);
          if (result.managedGitExcludeEntries.length > 0) next.managedGitExcludeEntries = result.managedGitExcludeEntries;
          else delete next.managedGitExcludeEntries;
          return { state: Object.keys(next.projections ?? {}).length === 0 ? null : next, result };
        }
        const finalProjection = learningRevision ? markPublishedLearningComplete(result.projection, learningRevision) : result.projection;
        const next = withProjection({ ...base, lastSync: context.now().toISOString() }, finalProjection);
        if (result.managedGitExcludeEntries.length > 0) next.managedGitExcludeEntries = result.managedGitExcludeEntries;
        else delete next.managedGitExcludeEntries;
        return { state: next, result };
      });
    } catch (error) {
      if ((error as Error).message.includes("Partial Workspace context update")) partial = true;
      if (partial) throw new Error(`Partial Workspace project update; project state could not be confirmed. ${(error as Error).message}`);
      throw error;
    }
    for (const change of resultChanges) context.out(`DONE write: ${change}`);
    for (const warning of warnings) context.out(`! ${warning}`);
    if (context.copilotMode === "fallback" && context.copilot instanceof FallbackCopilotClient) {
      for (const plugin of new Set(selectedProjects.flatMap((project) => project.plugin ? [project.plugin] : []))) {
        const spec = `${plugin}@${config.marketplace.name}`;
        const packageResult = await context.copilot.materializeProjectPlugin(spec, context.cwd);
        context.out(packageResult.status === "unavailable"
          ? `UNAVAILABLE: ${packageResult.reason}`
          : packageResult.status === "preserved"
            ? `PRESERVE existing unowned project Plugin package ${spec} at ${packageResult.path}`
            : `DONE write: project Plugin package ${spec} to ${packageResult.path}`);
      }
    }
  } finally {
    await catalog.dispose();
  }
}

function assertNoPendingProjectTransition(projection: ReturnType<typeof projectionFor>): void {
  if (!projection || (projection.pendingPublishedLearningRevision === undefined && projection.pendingLogicalProjects === undefined)) return;
  throw new Error("An interrupted Logical Project update is pending. Run `teamai sync` before retrying `teamai projects set`.");
}
