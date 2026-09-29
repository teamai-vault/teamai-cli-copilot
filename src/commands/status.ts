import { readGlobalConfig } from "../config/global.js";
import path from "node:path";
import { checkUserInstructionState, discoverMarketplaceUserInstructions, userInstructionTargetRoot } from "../copilot/user-instructions.js";
import { marketplaceRegistrationMatches, readCopilotState } from "../copilot/user-state.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { projectionFor } from "../project/context.js";
import { partitionPath } from "../project/partition.js";
import { readProjectState } from "../project/state.js";
import type { CommandContext } from "./context.js";
import { projectCustomizationCounts } from "./helpers.js";
import { collectResourceSnapshot } from "./resource-snapshot.js";

export async function statusCommand(context: CommandContext, options: { resources?: boolean; json?: boolean } = {}): Promise<void> {
  if (options.resources || options.json) {
    const snapshot = await collectResourceSnapshot(context);
    if (options.json) context.out(JSON.stringify(snapshot, null, 2));
    else {
      context.out("Team AI resources");
      for (const resource of snapshot.resources) {
        const runtime = Object.entries(resource.runtime).map(([consumer, value]) => `${consumer}=${value}`).join(",");
        const sourceRevision = resource.source.revision ?? snapshot.resourceRevision ?? "unknown";
        const target = resource.targetPath ?? "unknown";
        const reasons = resource.reasons.length > 0 ? resource.reasons.join(",") : "none";
        context.out(`${resource.scope} ${resource.kind} ${resource.name} selected=${resource.selected} owned=${resource.owned} source-revision=${sourceRevision} delivery=${resource.delivery} target=${target} configured-active=${resource.configuredActive} runtime=${runtime} reasons=${reasons}`);
      }
      for (const diagnostic of snapshot.diagnostics) {
        context.out(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
      }
    }
    return;
  }

  const config = await readGlobalConfig(context.homeDir);
  context.out("Team AI");
  context.out("");
  context.out("Global");
  if (!config) {
    context.out("  Config: not initialized");
    context.out("  User instructions: not initialized");
  } else {
    context.out(`  Marketplace: ${config.marketplace.name} (${config.marketplace.source})`);
    context.out(`  Marketplace revision: ${config.marketplaceRevision ?? "unknown"}`);
    context.out(`  Role: ${config.role ?? "not set"}`);
    context.out(`  Managed personal skills: ${config.managedSkills?.join(", ") || "none"}`);
    try {
      const { config: copilotConfig, settings } = await readCopilotState(context.homeDir);
      const marketplace = settings.extraKnownMarketplaces?.[config.marketplace.name];
      context.out(`  Marketplace registered: ${marketplace
        ? marketplaceRegistrationMatches(settings, config.marketplace.name, config.marketplace.source) ? "yes (local settings)" : "source differs (local settings)"
        : "unknown (no local registration)"}`);
      for (const desired of config.managedPlugins ?? []) {
        const at = desired.lastIndexOf("@");
        const name = desired.slice(0, at);
        const marketplaceName = desired.slice(at + 1);
        const row = (copilotConfig.installedPlugins ?? []).find((item) => item.name === name && item.marketplace === marketplaceName);
        const enabled = settings.enabledPlugins?.[desired] ?? row?.enabled;
        context.out(`  ${desired}: ${row
          ? typeof enabled === "boolean" ? `configured ${enabled ? "enabled" : "disabled"}; runtime unobserved` : "configured state unknown; runtime unobserved"
          : "not present in local inventory; runtime unobserved"}`);
      }
    } catch (error) {
      context.out(`  Copilot local settings: unavailable (${(error as Error).message})`);
      throw error;
    }
    try {
      const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
      try {
        if (catalog.revision && catalog.revision !== config.marketplaceRevision) context.out(`  Marketplace cache revision: ${catalog.revision}`);
        try {
          const desired = await discoverMarketplaceUserInstructions(catalog.root);
          const state = await checkUserInstructionState(desired, userInstructionTargetRoot(context.homeDir));
          context.out(`  User instructions: ${state.current ? `${state.desiredCount} managed, current` : "stale"}`);
        } catch (error) {
          context.out(`  User instructions: unavailable (${(error as Error).message})`);
        }
      } finally {
        await catalog.dispose();
      }
    } catch (error) {
      context.out(`  Marketplace cache: unavailable (${(error as Error).message})`);
      context.out("  User instructions: unavailable (Marketplace cache unavailable)");
    }
  }

  context.out("");
  context.out("Copilot-native capabilities");
  context.out("  Native MCP servers: runtime unobserved (status is read-only)");
  context.out("  Native Plugin Hooks: declaration validation only; runtime inspection unavailable");

  const identity = await detectProjectIdentity(context.cwd);
  context.out("");
  context.out("Project");
  if (!identity) {
    context.out("  Git project: none");
    return;
  }
  context.out(`  Root: ${identity.workspaceRoot}`);
  context.out(`  Anchor: ${identity.projectAnchor}`);
  const counts = await projectCustomizationCounts(identity.workspaceRoot);
  context.out(`  Native skills: ${counts.skills}`);
  context.out(`  Native agents: ${counts.agents}`);
  context.out(`  Native hooks: ${counts.hooks}`);
  context.out(`  Native instructions: ${counts.instructions}`);
  context.out(`  copilot-instructions.md: ${counts.rootInstructions ? "present" : "missing"}`);
  const state = await readProjectState(identity.projectAnchor, context.homeDir);
  const projection = projectionFor(state, identity.workspaceRoot);
  context.out(`  Logical Projects: ${projection?.logicalProjects.join(", ") || "none"}`);
  context.out(`  Project plugins: ${projection?.managedProjectPlugins.join(", ") || "none"}`);
  context.out(`  Project context: ${projection ? projection.contextRoot : "not initialized"}`);
  context.out(`  Learnings projection: ${projection ? path.join(projection.contextRoot, "shared", "learnings") : "not initialized"}`);
  context.out("");
  context.out("Machine state");
  context.out(`  Partition: ${partitionPath(identity.projectAnchor, context.homeDir)}`);
  context.out(`  Last sync: ${state?.lastSync ?? "never"}`);
}
