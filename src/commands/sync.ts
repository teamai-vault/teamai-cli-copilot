import { readGlobalConfig, writeGlobalConfig } from "../config/global.js";
import { FallbackCopilotClient } from "../copilot/fallback.js";
import { convergeBuiltInTeamAiSkill } from "../copilot/builtin-skill.js";
import { convergeUserPlugins, type PlannedAction } from "../copilot/plugins.js";
import { effectiveEnabledPluginSpecs, materializedEnabledPluginSkillNames, convergeManagedSkills } from "../copilot/skills.js";
import type { InstalledPlugin } from "../copilot/cli.js";
import { convergeMarketplaceUserInstructions } from "../copilot/user-instructions.js";
import { registerVsCodeMarketplace } from "../copilot/vscode-settings.js";
import { copilotDisplayPath } from "../copilot/user-state.js";
import { refreshPublishedLearningSnapshot } from "../project/published-cache.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { loadLogicalProjects, selectedLogicalProjects } from "../project/manifest.js";
import { convergeLogicalProjectContext, markPublishedLearningComplete, markPublishedLearningPending, projectionFor, withProjection } from "../project/context.js";
import { readProjectState, withProjectStateLock, type ProjectState } from "../project/state.js";
import type { CommandContext } from "./context.js";
import { printActions, printUserInstructionActions, printWarnings } from "./helpers.js";

export async function syncCommand(context: CommandContext): Promise<void> {
  const config = await readGlobalConfig(context.homeDir);
  if (!config?.role) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const originalConfig = JSON.stringify(config);
  let persistedConfig = originalConfig;

  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd, { refresh: true, dryRun: context.dryRun });
  if (catalog.name !== config.marketplace.name) {
    await catalog.dispose();
    throw new Error(`Configured Marketplace name '${config.marketplace.name}' does not match source manifest '${catalog.name}'.`);
  }
  let converged: Awaited<ReturnType<typeof convergeUserPlugins>>;
  let userInstructions;
  let publishedSnapshot: Awaited<ReturnType<typeof refreshPublishedLearningSnapshot>> | undefined;
  const persistentUserChanges: string[] = [];
  try {
    publishedSnapshot = await refreshPublishedLearningSnapshot({
      marketplaceRoot: catalog.root,
      plugins: catalog.plugins,
      source: config.marketplace.source,
      homeDir: context.homeDir,
      dryRun: context.dryRun,
    });
    const identity = await detectProjectIdentity(context.cwd);
    if (identity) {
      const snapshot = await readProjectState(identity.projectAnchor, context.homeDir);
      const projection = projectionFor(snapshot, identity.workspaceRoot);
      if (projection && (projection.pendingLogicalProjects ?? projection.logicalProjects).length > 0) {
        const preflight = async (state: ProjectState | undefined) => {
          const active = projectionFor(state, identity.workspaceRoot);
          if (!active) return { result: undefined };
          const logicalProjects = active.pendingLogicalProjects ?? active.logicalProjects;
          if (logicalProjects.length === 0) return { result: undefined };
          await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state, logicalProjects, publishedLearningRoot: publishedSnapshot!.root, dryRun: true });
          return { result: undefined };
        };
        if (context.dryRun) await preflight(snapshot);
        else await withProjectStateLock(identity.projectAnchor, context.homeDir, preflight);
      }
    }

    const builtInSkill = await convergeBuiltInTeamAiSkill(context.homeDir, { dryRun: context.dryRun });
    if (builtInSkill.change) {
      context.out((context.dryRun ? "WOULD" : "DONE") + " " + builtInSkill.change + ": " + copilotDisplayPath("skills/teamai", context.homeDir));
      if (!context.dryRun) persistentUserChanges.push("built-in Team AI Skill");
    }
    userInstructions = await convergeMarketplaceUserInstructions(catalog.root, context.homeDir, { dryRun: context.dryRun });
    if (!context.dryRun && userInstructions.changes.length > 0) persistentUserChanges.push("Marketplace user instructions");
    if (context.copilotMode === "unavailable") {
      printUserInstructionActions(userInstructions, context.dryRun, context.homeDir, context.out);
      throw new Error("Copilot CLI and VS Code backends are unavailable; Marketplace user instructions were synchronized, but plugin convergence could not run.");
    }
    converged = await convergeUserPlugins(context.copilot, config, catalog.plugins, { dryRun: context.dryRun, cwd: context.cwd, resourceRevision: catalog.revision });
    if (!context.dryRun && converged.actions.length > 0) persistentUserChanges.push("Copilot plugins");
    printActions(converged.actions, context.dryRun, context.out);
    printWarnings(converged.warnings, context.out);
    printUserInstructionActions(userInstructions, context.dryRun, context.homeDir, context.out);
    if (await registerVsCodeMarketplace(context.vscodeSettingsPath, config.marketplace.source, context.dryRun)) {
      context.out(`${context.dryRun ? "WOULD" : "DONE"} write: VS Code User Settings chat.plugins.marketplaces`);
      if (!context.dryRun) persistentUserChanges.push("VS Code User Settings");
    }
    config.managedPlugins = converged.managedPlugins;
    if (catalog.revision) config.marketplaceRevision = catalog.revision;
    else delete config.marketplaceRevision;
    if (!context.dryRun && JSON.stringify(config) !== persistedConfig) {
      await writeGlobalConfig(config, context.homeDir);
      persistedConfig = JSON.stringify(config);
      persistentUserChanges.push("Team AI config");
    }
    let mergedProjectSettings;
    if (identity) {
      const snapshot = await readProjectState(identity.projectAnchor, context.homeDir);
      const snapshotProjection = projectionFor(snapshot, identity.workspaceRoot);
      if (snapshotProjection && (snapshotProjection.pendingLogicalProjects ?? snapshotProjection.logicalProjects).length > 0) {
        let projectChanges: string[] = [];
        let projectWarnings: string[] = [];
        let partial = false;
        if (context.dryRun) {
          const projectContext = await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state: snapshot, logicalProjects: snapshotProjection.pendingLogicalProjects ?? snapshotProjection.logicalProjects, publishedLearningRoot: publishedSnapshot.root, dryRun: true });
          mergedProjectSettings = projectContext.mergedSettings;
          projectChanges = projectContext.changes;
          projectWarnings = projectContext.warnings;
          context.out("WOULD write: project machine state");
        } else {
          try {
            const projectContext = await withProjectStateLock(identity.projectAnchor, context.homeDir, async (priorState, saveCheckpoint) => {
              const projection = projectionFor(priorState, identity.workspaceRoot);
              if (!projection) return { result: undefined };
              const logicalProjects = projection.pendingLogicalProjects ?? projection.logicalProjects;
              if (logicalProjects.length === 0) return { result: undefined };
              await saveCheckpoint(withProjection(
                priorState ?? { schemaVersion: 1, workspaceRoot: identity.workspaceRoot, lastSync: context.now().toISOString(), managedPlugins: [] },
                markPublishedLearningPending(projection, publishedSnapshot!.revision, logicalProjects),
              ));
              const result = await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state: priorState, logicalProjects, publishedLearningRoot: publishedSnapshot!.root });
              mergedProjectSettings = result.mergedSettings;
              projectChanges = result.changes;
              projectWarnings = result.warnings;
              partial = projectChanges.length > 0;
              const baseState: ProjectState = {
                ...(priorState ?? { schemaVersion: 1, workspaceRoot: identity.workspaceRoot, managedPlugins: [] }),
                lastSync: context.now().toISOString(),
                managedPlugins: converged.managedPlugins,
              };
              const next = withProjection(baseState, markPublishedLearningComplete(result.projection, publishedSnapshot!.revision));
              if (result.managedGitExcludeEntries.length > 0) next.managedGitExcludeEntries = result.managedGitExcludeEntries;
              else delete next.managedGitExcludeEntries;
              return { state: next, result };
            });
            if (!projectContext) {
              mergedProjectSettings = undefined;
              projectChanges = [];
              projectWarnings = [];
            }
          } catch (error) {
            if ((error as Error).message.includes("Partial Workspace context update")) partial = true;
            if (partial || persistentUserChanges.length > 0) {
              const userWrites = persistentUserChanges.length > 0 ? ` User-scope changes already applied: ${persistentUserChanges.join(", ")}.` : "";
              throw new Error(`Partial sync; Workspace update did not complete.${userWrites} ${(error as Error).message}`);
            }
            throw error;
          }
        }
        for (const change of projectChanges) context.out(`${context.dryRun ? "WOULD" : "DONE"} write: ${change}`);
        for (const warning of projectWarnings) context.out(`! ${warning}`);
        if (context.copilotMode === "fallback" && context.copilot instanceof FallbackCopilotClient) {
          const selected = selectedLogicalProjects(await loadLogicalProjects(catalog.root, catalog.plugins), snapshotProjection.pendingLogicalProjects ?? snapshotProjection.logicalProjects);
          for (const plugin of new Set(selected.flatMap((project) => project.plugin ? [project.plugin] : []))) {
            const spec = `${plugin}@${config.marketplace.name}`;
            const packageResult = await context.copilot.materializeProjectPlugin(spec, context.cwd, context.dryRun);
            context.out(packageResult.status === "unavailable"
              ? `UNAVAILABLE: ${packageResult.reason}`
              : packageResult.status === "preserved"
                ? `PRESERVE existing unowned project Plugin package ${spec} at ${packageResult.path}`
                : `${context.dryRun ? "WOULD" : "DONE"} write: project Plugin package ${spec} to ${packageResult.path}`);
          }
        }
      }
    }
    const installed = await context.copilot.listPlugins(context.cwd);
    const plannedMaterialized = context.dryRun
      ? converged.actions.filter((action) => action.kind === "plugin-install").map((action) => action.target)
      : [];
    const effectivePlugins = context.dryRun ? applyPlannedPluginActions(installed, converged.actions) : installed;
    const enabled = effectiveEnabledPluginSpecs(effectivePlugins, mergedProjectSettings);
    const materializedPluginSkills = await materializedEnabledPluginSkillNames(
      effectivePlugins,
      catalog.skills,
      config.marketplace.name,
      mergedProjectSettings,
      plannedMaterialized,
    );
    const skillResult = await convergeManagedSkills(config, catalog.skills, enabled, context.homeDir, {
      dryRun: context.dryRun,
      materializedPluginSkills,
    });
    config.managedSkillPaths = skillResult.managedSkillPaths;
    if (!context.dryRun && skillResult.changes.length > 0) persistentUserChanges.push("managed personal Skills");
    for (const change of skillResult.changes) context.out(`${context.dryRun ? "WOULD" : "DONE"} ${change.type}: ${change.name}`);
    if (!context.dryRun && JSON.stringify(config) !== persistedConfig) {
      await writeGlobalConfig(config, context.homeDir);
      persistentUserChanges.push("Team AI config");
    }
    if (context.dryRun && JSON.stringify(config) !== originalConfig) context.out("WOULD write: ~/.teamai/config.yaml");
  } finally {
    await publishedSnapshot?.dispose();
    await catalog.dispose();
  }
}

function applyPlannedPluginActions(installed: InstalledPlugin[], actions: PlannedAction[]): InstalledPlugin[] {
  const planned = installed.map((plugin) => ({ ...plugin }));
  for (const action of actions) {
    if (action.kind !== "plugin-install" && action.kind !== "plugin-enable" && action.kind !== "plugin-disable") continue;
    const at = action.target.lastIndexOf("@");
    if (at <= 0 || at === action.target.length - 1) continue;
    const name = action.target.slice(0, at);
    const marketplace = action.target.slice(at + 1);
    const index = planned.findIndex((plugin) => plugin.name === name && plugin.marketplace === marketplace);
    const enabled = action.kind !== "plugin-disable";
    if (index < 0) planned.push({ name, marketplace, enabled });
    else planned[index] = { ...planned[index], enabled };
  }
  return planned;
}
