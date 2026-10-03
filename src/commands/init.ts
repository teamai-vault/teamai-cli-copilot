import { readGlobalConfig, writeGlobalConfig } from "../config/global.js";
import { createConfig } from "../config/schema.js";
import { convergeBuiltInTeamAiSkill } from "../copilot/builtin-skill.js";
import { convergeBuiltInRecallAgent } from "../copilot/builtin-agent.js";
import { normalizeMarketplaceSource, resolveMarketplaceConfig } from "../copilot/marketplace.js";
import { convergeUserPlugins, enabledUserPlugins } from "../copilot/plugins.js";
import { convergeMarketplaceUserInstructions } from "../copilot/user-instructions.js";
import { registerVsCodeMarketplace } from "../copilot/vscode-settings.js";
import { copilotDisplayPath } from "../copilot/user-state.js";
import { preflightUserPluginDelivery, withNativeUserDeliveryLock, type CommandContext } from "./context.js";
import { printActions, printUserInstructionActions, printWarnings } from "./helpers.js";

export interface InitOptions {
  marketplace?: string;
  role?: string;
}

export async function initCommand(context: CommandContext, options: InitOptions): Promise<void> {
  let config = await readGlobalConfig(context.homeDir);
  let source = options.marketplace
    ? normalizeMarketplaceSource(options.marketplace, context.cwd)
    : config?.marketplace.source;
  if (!source) {
    if (!context.interactive) throw new Error(nonInteractiveRequirement("Marketplace URL"));
    source = normalizeMarketplaceSource(await context.promptMarketplace(), context.cwd);
  }
  if (config && source !== config.marketplace.source) {
    throw new Error([
      "A different Marketplace is already configured.",
      `Current: ${config.marketplace.name} (${config.marketplace.source})`,
      `Requested: ${source}`,
      "Refusing to switch Marketplace during init.",
    ].join("\n"));
  }

  let catalog = await context.loadMarketplace(source, context.cwd, { refresh: true, dryRun: true });
  try {
    context.out(`Marketplace discovered: ${catalog.name}`);
    let role = options.role ?? config?.role;
    if (!role) {
      if (!context.interactive) throw new Error(nonInteractiveRequirement("Role"));
      role = await context.promptRole(catalog.plugins.filter((plugin) => plugin.kind === "role").map((plugin) => plugin.name));
    }
    enabledUserPlugins(role, catalog.plugins, catalog.name);
    const plannedConfig = config ?? createConfig({ name: catalog.name, source });
    plannedConfig.role = role;
    await preflightUserPluginDelivery(context, plannedConfig, catalog);
    await convergeBuiltInTeamAiSkill(context.homeDir, { dryRun: true });
    await convergeBuiltInRecallAgent(context.homeDir, { dryRun: true });
    await convergeMarketplaceUserInstructions(catalog.root, context.homeDir, { dryRun: true });
    await withNativeUserDeliveryLock(context, async () => {
      await preflightUserPluginDelivery(context, plannedConfig, catalog);
      await convergeBuiltInTeamAiSkill(context.homeDir, { dryRun: true });
      await convergeBuiltInRecallAgent(context.homeDir, { dryRun: true });
      await convergeMarketplaceUserInstructions(catalog.root, context.homeDir, { dryRun: true });
    }, async () => {
      if (!context.dryRun) {
        const preflightCatalog = catalog;
        try {
          catalog = await context.loadMarketplace(source, context.cwd, { refresh: true });
        } finally {
          await preflightCatalog.dispose();
        }
        if (config && config.marketplace.name !== catalog.name) throw new Error(`Configured Marketplace name '${config.marketplace.name}' does not match source manifest '${catalog.name}'.`);
        enabledUserPlugins(role, catalog.plugins, catalog.name);
        await preflightUserPluginDelivery(context, plannedConfig, catalog);
        await convergeMarketplaceUserInstructions(catalog.root, context.homeDir, { dryRun: true });
      }

      // Recheck both reserved targets after source preparation, before the first delivery.
      await convergeBuiltInRecallAgent(context.homeDir, { dryRun: true });
      await convergeBuiltInTeamAiSkill(context.homeDir, { dryRun: true });
      const builtInAgent = await convergeBuiltInRecallAgent(context.homeDir, { dryRun: context.dryRun });
      if (builtInAgent.change) {
        context.out((context.dryRun ? "WOULD" : "DONE") + " " + builtInAgent.change + ": " + copilotDisplayPath("agents/teamai-recall.agent.md", context.homeDir));
      }
      const builtInSkill = await convergeBuiltInTeamAiSkill(context.homeDir, { dryRun: context.dryRun });
      if (builtInSkill.change) {
        context.out((context.dryRun ? "WOULD" : "DONE") + " " + builtInSkill.change + ": " + copilotDisplayPath("skills/teamai", context.homeDir));
      }
      const userInstructions = await convergeMarketplaceUserInstructions(catalog.root, context.homeDir, { dryRun: context.dryRun });
      if (context.copilotMode === "unavailable") {
        printUserInstructionActions(userInstructions, context.dryRun, context.homeDir, context.out);
        throw new Error("Copilot CLI and VS Code backends are unavailable; Marketplace user instructions were synchronized, but plugin convergence could not run.");
      }

      const version = context.copilotRuntime ?? await context.copilot.version();
      context.out(`Copilot CLI: ${version}`);
      let marketplaceAdded = false;
      if (!config) {
        const marketplace = await resolveMarketplaceConfig(context.copilot, source, catalog.name, {
          cwd: context.cwd,
          dryRun: context.dryRun,
        });
        config = createConfig(marketplace.config);
        marketplaceAdded = marketplace.added;
      } else if (config.marketplace.name !== catalog.name) {
        throw new Error(`Configured Marketplace name '${config.marketplace.name}' does not match source manifest '${catalog.name}'.`);
      }
      config.role = role;
      if (catalog.revision) config.marketplaceRevision = catalog.revision;
      else delete config.marketplaceRevision;

      let converged;
      let mutationCheckpointed = false;
      try {
        converged = await convergeUserPlugins(context.copilot, config, catalog.plugins, {
          dryRun: context.dryRun,
          cwd: context.cwd,
          resourceRevision: catalog.revision,
          checkpoint: async (checkpoint) => {
            await writeGlobalConfig(checkpoint, context.homeDir);
            mutationCheckpointed = true;
          },
        });
      } catch (error) {
        if (marketplaceAdded && !context.dryRun && !mutationCheckpointed) {
          try {
            await context.copilot.removeMarketplace(config.marketplace.name, context.cwd);
          } catch (cleanupError) {
            throw new Error(`${(error as Error).message} Cleanup also failed: ${(cleanupError as Error).message}`);
          }
        }
        throw error;
      }
      printActions(converged.actions, context.dryRun, context.out);
      printWarnings(converged.warnings, context.out);
      printUserInstructionActions(userInstructions, context.dryRun, context.homeDir, context.out);
      config.managedPlugins = converged.managedPlugins;
      if (await registerVsCodeMarketplace(context.vscodeSettingsPath, source, context.dryRun)) {
        context.out(`${context.dryRun ? "WOULD" : "DONE"} write: VS Code User Settings chat.plugins.marketplaces`);
      }

      if (!context.dryRun) await writeGlobalConfig(config, context.homeDir);
      else context.out("WOULD write: ~/.teamai/config.yaml");
    }, true);
  } finally {
    await catalog.dispose();
  }
}

function nonInteractiveRequirement(missing: string): string {
  return `${missing} is required in non-interactive mode. Use: teamai init --marketplace <source> --role <role>`;
}
