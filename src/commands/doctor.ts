import { access, lstat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readGlobalConfig } from "../config/global.js";
import { inspectBuiltInTeamAiSkill } from "../copilot/builtin-skill.js";
import { enabledUserPlugins, pluginSpec, userPlugins } from "../copilot/plugins.js";
import { effectiveEnabledPluginSpecs, convergeManagedSkills } from "../copilot/skills.js";
import { readProjectSettings } from "../copilot/project-settings.js";
import type { MarketplaceCatalog } from "../copilot/catalog.js";
import { checkUserInstructionState, discoverMarketplaceUserInstructions, userInstructionTargetRoot } from "../copilot/user-instructions.js";
import { fallbackStateProblems, marketplaceRegistrationMatches, readCopilotState } from "../copilot/user-state.js";
import { vscodeMarketplaceIsFirst } from "../copilot/vscode-settings.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { convergeLogicalProjectContext, projectionFor } from "../project/context.js";
import { loadLogicalProjects, selectedLogicalProjects } from "../project/manifest.js";
import { partitionPath } from "../project/partition.js";
import { inspectProjectPartitions, readProjectState } from "../project/state.js";
import { executableVersion } from "../utils/process.js";
import { readTextIfExists } from "../utils/fs.js";
import type { CommandContext } from "./context.js";

export interface DoctorResult {
  errors: number;
  warnings: number;
}

async function reportManagedUserInstructions(
  catalogRoot: string,
  homeDir: string,
  ok: (message: string) => void,
  warn: (message: string) => void,
  fail: (message: string) => void,
): Promise<void> {
  try {
    const desired = await discoverMarketplaceUserInstructions(catalogRoot);
    const state = await checkUserInstructionState(desired, userInstructionTargetRoot(homeDir));
    if (state.current) {
      ok(`Managed user instructions: current (${state.desiredCount})`);
      return;
    }
    const missing = state.changes.filter((change) => change.type === "create").length;
    const stale = state.changes.filter((change) => change.type === "remove").length;
    if (missing > 0 && stale === 0) warn(`Managed user instructions: ${missing} missing. Run teamai sync.`);
    else if (stale > 0 && missing === 0) warn("Managed user instructions: stale managed files present. Run teamai sync.");
    else warn("Managed user instructions: stale. Run teamai sync.");
    if (!state.targetWritable) fail("Managed user instruction target is not writable; cannot repair with teamai sync.");
  } catch (error) {
    fail(`Marketplace user instructions could not be read: ${(error as Error).message}`);
  }
}

export async function doctorCommand(context: CommandContext): Promise<DoctorResult> {
  let errors = 0;
  let warnings = 0;
  const ok = (message: string) => context.out(`✓ ${message}`);
  const warn = (message: string) => {
    warnings += 1;
    context.out(`! ${message}`);
  };
  const fail = (message: string) => {
    errors += 1;
    context.out(`✗ ${message}`);
  };

  const gitVersion = await executableVersion("git", ["--version"]);
  if (gitVersion) ok(`Git: ${gitVersion}`);
  else fail("Git is not available on PATH.");

  try {
    const builtInSkill = await inspectBuiltInTeamAiSkill(context.homeDir);
    if (builtInSkill.status === "current") ok("Built-in Team AI Skill: current (" + builtInSkill.version + ").");
    else if (builtInSkill.status === "collision") fail("Built-in Team AI Skill collision: " + builtInSkill.reason + ".");
    else if (builtInSkill.status === "missing") warn("Built-in Team AI Skill: missing. Run teamai init or teamai sync.");
    else warn("Built-in Team AI Skill: stale. Run teamai sync.");
  } catch (error) {
    fail("Built-in Team AI Skill diagnostics failed: " + (error as Error).message);
  }

  let copilotAvailable = true;
  try {
    ok(`Copilot backend: ${await context.copilot.version()}`);
  } catch (error) {
    copilotAvailable = false;
    fail((error as Error).message);
  }

  if (copilotAvailable) {
    try {
      const mcp = await context.copilot.listMcpServers(context.cwd);
      if (mcp.errors.length > 0) {
        for (const error of mcp.errors) fail(`Native MCP inspection: ${error}`);
      } else {
        ok(`Native MCP inspection: ${mcp.servers.length > 0 ? mcp.servers.map((server) => server.name).join(", ") : "no configured servers"}`);
      }
    } catch (error) {
      fail(`Native MCP inspection failed: ${(error as Error).message}`);
    }
    warn("Native Plugin Hook runtime inspection is unavailable; Team AI validates declarations but never executes Hooks.");
  }

  let config;
  try {
    config = await readGlobalConfig(context.homeDir);
    if (!config) warn("Team AI config is missing. Run `teamai init --marketplace <source> --role <role>`. ");
    else if (!config.role) warn("Team AI role is not configured.");
    else ok(`Team AI config: role=${config.role}`);
  } catch (error) {
    fail(`Team AI config is invalid: ${(error as Error).message}`);
  }

  if (config) {
    try {
      if (vscodeMarketplaceIsFirst(await readTextIfExists(context.vscodeSettingsPath), config.marketplace.source)) {
        ok("VS Code Marketplace registration is first in chat.plugins.marketplaces.");
      } else {
        fail("VS Code Marketplace registration is missing or not first. Run teamai sync.");
      }
      if (context.copilotMode === "fallback") {
        const { settings } = await readCopilotState(context.homeDir);
        if (marketplaceRegistrationMatches(settings, config.marketplace.name, config.marketplace.source)) {
          ok(`Copilot user Marketplace ${config.marketplace.name} is registered.`);
        } else {
          fail(`Copilot user Marketplace ${config.marketplace.name} is inconsistent. Run teamai sync.`);
        }
        for (const problem of await fallbackStateProblems(context.homeDir, config.managedPlugins ?? [])) fail(problem);
      }
    } catch (error) {
      fail(`User-level Copilot/VS Code settings diagnostics failed: ${(error as Error).message}`);
    }
  }

  let catalogSnapshot: Pick<MarketplaceCatalog, "root" | "plugins" | "skills" | "revision"> | undefined;
  if (config) {
    let catalog: MarketplaceCatalog | undefined;
    try {
      catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
      if (catalog.name !== config.marketplace.name) {
        throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
      }
      catalogSnapshot = { root: catalog.root, plugins: catalog.plugins, skills: catalog.skills, revision: catalog.revision };
      ok(`Marketplace cache/catalog: ${catalog.revision ?? "local source"}.`);
      await reportManagedUserInstructions(catalog.root, context.homeDir, ok, warn, fail);

      if (copilotAvailable) {
        const marketplaces = await context.copilot.listMarketplaces(context.cwd);
        if (!marketplaces.some((item) => item.name === config.marketplace.name)) {
          fail(`Marketplace ${config.marketplace.name} is not registered. Run teamai sync.`);
        } else {
          ok(`Marketplace ${config.marketplace.name} is registered.`);
        }
        if (config.role) {
          const plugins = await context.copilot.listPlugins(context.cwd);
          const expectedEnabled = new Set(enabledUserPlugins(config.role, catalog.plugins, config.marketplace.name));
          for (const desired of userPlugins(catalog.plugins, config.marketplace.name)) {
            const row = plugins.find((item) => pluginSpec(item) === desired);
            if (!row) fail(`${desired} is not installed. Run teamai sync.`);
            else if (row.enabled !== expectedEnabled.has(desired)) fail(`${desired} has incorrect enablement. Run teamai sync.`);
            else ok(`${desired} is ${row.enabled ? "enabled" : "installed and disabled"}.`);
          }
        }
      }
    } catch (error) {
      fail(`${copilotAvailable ? "Copilot plugin diagnostics failed" : "Marketplace user instructions could not be read"}: ${(error as Error).message}`);
    } finally {
      await catalog?.dispose();
    }
  }

  let projectSettings;
  const identity = gitVersion ? await detectProjectIdentity(context.cwd) : undefined;
  if (!identity) {
    warn("Current directory is not inside a Git repository; project checks were skipped.");
  } else {
    ok(`Workspace root: ${identity.workspaceRoot}`);
    if (identity.projectAnchor !== identity.workspaceRoot) ok(`Git worktree anchor: ${identity.projectAnchor}`);
    try {
      projectSettings = await readProjectSettings(identity.workspaceRoot);
      ok("Repository Copilot settings are parseable.");
    } catch (error) {
      fail((error as Error).message);
    }
    const state = await readProjectState(identity.projectAnchor, context.homeDir);
    const projection = projectionFor(state, identity.workspaceRoot);
    for (const root of [path.join(identity.workspaceRoot, ".github", "instructions", "teamai"), path.join(identity.workspaceRoot, ".teamai", "context")]) {
      try {
        await lstat(root);
        if (!projection || (projection.instructionRoot !== root && projection.contextRoot !== root)) {
          fail(`Reserved Team AI projection path is occupied without ownership: ${root}`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail((error as Error).message);
      }
    }
    if (config && catalogSnapshot) {
      try {
        const projects = await loadLogicalProjects(catalogSnapshot.root, catalogSnapshot.plugins);
        if (projection) {
          selectedLogicalProjects(projects, projection.logicalProjects);
          const result = await convergeLogicalProjectContext({
            marketplaceRoot: catalogSnapshot.root,
            plugins: catalogSnapshot.plugins,
            marketplace: config.marketplace,
            identity,
            state,
            logicalProjects: projection.logicalProjects,
            dryRun: true,
          });
          const projectionStateChanged = JSON.stringify(result.projection) !== JSON.stringify(projection);
          if (result.changes.length === 0 && !projectionStateChanged) ok("Logical Project context: current.");
          else warn("Logical Project context is stale. Run teamai sync.");
          for (const message of result.warnings) warn(`Logical Project Plugin: ${message}`);
          projectSettings = result.mergedSettings;
        } else {
          ok(`Logical Project manifest: ${projects.length} available, no workspace binding.`);
        }
      } catch (error) {
        fail(`Logical Project/Skill diagnostics failed: ${(error as Error).message}`);
      }
    }
    try {
      await access(context.homeDir, constants.W_OK);
      ok(`Machine state location is writable: ${partitionPath(identity.projectAnchor, context.homeDir)}`);
    } catch {
      fail(`Home directory is not writable; cannot create ${partitionPath(identity.projectAnchor, context.homeDir)}`);
    }
  }

  if (config && catalogSnapshot) {
    try {
      const installed = copilotAvailable ? await context.copilot.listPlugins(context.cwd) : [];
      const skillResult = await convergeManagedSkills(config, catalogSnapshot.skills, effectiveEnabledPluginSpecs(installed, projectSettings), context.homeDir, { dryRun: true });
      const skillStateChanged = JSON.stringify(skillResult.managedSkillPaths) !== JSON.stringify(config.managedSkillPaths ?? {});
      if (skillResult.changes.length === 0 && !skillStateChanged) ok("Managed personal skills: current.");
      else warn("Managed personal skills are stale. Run teamai sync.");
    } catch (error) {
      fail(`Managed personal skill diagnostics failed: ${(error as Error).message}`);
    }
  }

  try {
    const partitionDiagnostics = await inspectProjectPartitions(context.homeDir);
    for (const diagnostic of partitionDiagnostics) {
      if (diagnostic.kind === "orphan") warn(`Orphan machine partition has no anchor: ${diagnostic.partition}`);
      else warn(`Stale machine partition anchor no longer exists: ${diagnostic.anchor}`);
    }
    if (partitionDiagnostics.length === 0) ok("No stale or orphan Team AI project partitions detected.");
  } catch (error) {
    warn(`Could not inspect Team AI project partitions: ${(error as Error).message}`);
  }

  return { errors, warnings };
}
