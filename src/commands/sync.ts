import { readGlobalConfig, writeGlobalConfig } from "../config/global.js";
import { convergeBuiltInTeamAiSkill } from "../copilot/builtin-skill.js";
import { convergeUserPlugins, type PlannedAction } from "../copilot/plugins.js";
import { effectiveEnabledPluginSpecs, convergeManagedSkills } from "../copilot/skills.js";
import type { InstalledPlugin } from "../copilot/cli.js";
import { convergeMarketplaceUserInstructions } from "../copilot/user-instructions.js";
import { registerVsCodeMarketplace } from "../copilot/vscode-settings.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { convergeLogicalProjectContext, projectionFor, withProjection } from "../project/context.js";
import { readProjectState, writeProjectState } from "../project/state.js";
import type { CommandContext } from "./context.js";
import { printActions, printUserInstructionActions, printWarnings } from "./helpers.js";

export async function syncCommand(context: CommandContext): Promise<void> {
  const config = await readGlobalConfig(context.homeDir);
  if (!config?.role) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const originalConfig = JSON.stringify(config);
  let persistedConfig = originalConfig;

  const builtInSkill = await convergeBuiltInTeamAiSkill(context.homeDir, { dryRun: context.dryRun });
  if (builtInSkill.change) {
    context.out((context.dryRun ? "WOULD" : "DONE") + " " + builtInSkill.change + ": ~/.copilot/skills/teamai");
  }
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd, { refresh: true });
  if (catalog.name !== config.marketplace.name) {
    await catalog.dispose();
    throw new Error(`Configured Marketplace name '${config.marketplace.name}' does not match source manifest '${catalog.name}'.`);
  }
  let converged;
  let userInstructions;
  try {
    userInstructions = await convergeMarketplaceUserInstructions(catalog.root, context.homeDir, { dryRun: context.dryRun });
    if (context.copilotMode === "unavailable") {
      printUserInstructionActions(userInstructions, context.dryRun, context.out);
      throw new Error("Copilot CLI and VS Code backends are unavailable; Marketplace user instructions were synchronized, but plugin convergence could not run.");
    }
    converged = await convergeUserPlugins(context.copilot, config, catalog.plugins, { dryRun: context.dryRun, cwd: context.cwd });
    printActions(converged.actions, context.dryRun, context.out);
    printWarnings(converged.warnings, context.out);
    printUserInstructionActions(userInstructions, context.dryRun, context.out);
    if (await registerVsCodeMarketplace(context.vscodeSettingsPath, config.marketplace.source, context.dryRun)) {
      context.out(`${context.dryRun ? "WOULD" : "DONE"} write: VS Code User Settings chat.plugins.marketplaces`);
    }
    config.managedPlugins = converged.managedPlugins;
    if (catalog.revision) config.marketplaceRevision = catalog.revision;
    else delete config.marketplaceRevision;
    if (!context.dryRun && JSON.stringify(config) !== persistedConfig) {
      await writeGlobalConfig(config, context.homeDir);
      persistedConfig = JSON.stringify(config);
    }
    const identity = await detectProjectIdentity(context.cwd);
    let mergedProjectSettings;
    if (identity) {
      const priorState = await readProjectState(identity.projectAnchor, context.homeDir);
      const ids = projectionFor(priorState, identity.workspaceRoot)?.logicalProjects ?? [];
      const projectContext = await convergeLogicalProjectContext({ marketplaceRoot: catalog.root, plugins: catalog.plugins, marketplace: config.marketplace, identity, state: priorState, logicalProjects: ids, dryRun: context.dryRun });
      mergedProjectSettings = projectContext.mergedSettings;
      for (const change of projectContext.changes) context.out(`${context.dryRun ? "WOULD" : "DONE"} write: ${change}`);
      for (const warning of projectContext.warnings) context.out(`! ${warning}`);
      if (!context.dryRun) {
        const baseState = { ...(priorState ?? { schemaVersion: 1 as const, workspaceRoot: identity.workspaceRoot, managedPlugins: [] }), lastSync: context.now().toISOString(), managedPlugins: converged.managedPlugins };
        await writeProjectState(identity.projectAnchor, withProjection(baseState, projectContext.projection), context.homeDir);
      } else {
        context.out("WOULD write: project machine state");
      }
    }
    const installed = await context.copilot.listPlugins(context.cwd);
    const enabled = effectiveEnabledPluginSpecs(context.dryRun ? applyPlannedPluginActions(installed, converged.actions) : installed, mergedProjectSettings);
    const skillResult = await convergeManagedSkills(config, catalog.skills, enabled, context.homeDir, { dryRun: context.dryRun });
    config.managedSkillPaths = skillResult.managedSkillPaths;
    for (const change of skillResult.changes) context.out(`${context.dryRun ? "WOULD" : "DONE"} ${change.type}: ${change.name}`);
    if (!context.dryRun && JSON.stringify(config) !== persistedConfig) await writeGlobalConfig(config, context.homeDir);
    if (context.dryRun && JSON.stringify(config) !== originalConfig) context.out("WOULD write: ~/.teamai/config.yaml");
  } finally {
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
