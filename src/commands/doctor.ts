import { access, lstat, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { readGlobalConfig } from "../config/global.js";
import { inspectBuiltInTeamAiSkill } from "../copilot/builtin-skill.js";
import { enabledUserPlugins, pluginSpec, userPlugins } from "../copilot/plugins.js";
import { effectiveEnabledPluginSpecs, convergeManagedSkills } from "../copilot/skills.js";
import { readProjectSettings } from "../copilot/project-settings.js";
import type { MarketplaceCatalog } from "../copilot/catalog.js";
import { checkUserInstructionState, discoverMarketplaceUserInstructions, userInstructionTargetRoot } from "../copilot/user-instructions.js";
import { marketplaceRegistrationMatches, readCopilotState, type CopilotInstalledPlugin } from "../copilot/user-state.js";
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

async function isMaterializedPlugin(plugin: CopilotInstalledPlugin): Promise<boolean> {
  if (typeof plugin.cache_path !== "string" || plugin.cache_path.length === 0) return false;
  if (typeof plugin.version !== "string" || plugin.version.length === 0) return false;
  try {
    const root = await lstat(plugin.cache_path);
    if (root.isSymbolicLink() || !root.isDirectory()) return false;
    const manifestPath = path.join(plugin.cache_path, "plugin.json");
    const manifestFile = await lstat(manifestPath);
    if (!manifestFile.isFile() || manifestFile.isSymbolicLink()) return false;
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
    const identity = manifest as { name?: unknown; version?: unknown };
    return identity.name === plugin.name && identity.version === plugin.version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
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

  warn("Copilot runtime and native MCP state are unobserved by this read-only diagnostic.");

  let config;
  let copilotConfig;
  let copilotSettings;
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
      ({ config: copilotConfig, settings: copilotSettings } = await readCopilotState(context.homeDir));
      if (vscodeMarketplaceIsFirst(await readTextIfExists(context.vscodeSettingsPath), config.marketplace.source)) {
        ok("VS Code Marketplace registration is first in chat.plugins.marketplaces.");
      } else {
        fail("VS Code Marketplace registration is missing or not first. Run teamai sync.");
      }
      if (copilotSettings?.extraKnownMarketplaces?.[config.marketplace.name]) {
        if (marketplaceRegistrationMatches(copilotSettings, config.marketplace.name, config.marketplace.source)) {
          ok(`Copilot user Marketplace ${config.marketplace.name} is registered in local settings.`);
        } else {
          fail(`Copilot user Marketplace ${config.marketplace.name} has a source mismatch in local settings. Run teamai sync.`);
        }
      } else {
        warn(`Copilot user Marketplace ${config.marketplace.name} is not recorded in local settings; runtime state is unobserved.`);
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

      if (config.role && copilotConfig && copilotSettings) {
        const expectedEnabled = new Set(enabledUserPlugins(config.role, catalog.plugins, config.marketplace.name));
        const inventory = copilotConfig.installedPlugins ?? [];
        if (inventory.length === 0) {
          warn("Copilot Plugin inventory is not recorded in local settings; installed/runtime state is unobserved.");
        } else {
          for (const desired of userPlugins(catalog.plugins, config.marketplace.name)) {
            const row = inventory.find((item) => pluginSpec(item) === desired);
            if (!row) warn(`${desired} is absent from local Plugin inventory; runtime state is unobserved.`);
            else {
              const enabled = copilotSettings.enabledPlugins?.[desired] ?? row.enabled;
              if (typeof enabled !== "boolean") warn(`${desired} enablement is unknown in local settings.`);
              else if (enabled !== expectedEnabled.has(desired)) fail(`${desired} has incorrect configured enablement. Run teamai sync.`);
              else ok(`${desired} is configured ${enabled ? "enabled" : "installed and disabled"}; runtime unobserved.`);
            }
          }
        }
      }
    } catch (error) {
      fail(`Marketplace/Copilot local diagnostics failed: ${(error as Error).message}`);
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
      if (!copilotConfig || !copilotSettings || !(copilotConfig.installedPlugins?.length)) {
        warn("Managed personal Skill availability is unknown because no local Plugin inventory is recorded.");
      } else {
        const installed = copilotConfig.installedPlugins.map((plugin) => ({
          ...plugin,
          enabled: copilotSettings.enabledPlugins?.[`${plugin.name}@${plugin.marketplace}`] ?? plugin.enabled ?? false,
        }));
        const enabledPlugins = effectiveEnabledPluginSpecs(installed, projectSettings);
        const unavailable: string[] = [];
        for (const spec of enabledPlugins) {
          const plugin = installed.find((item) => pluginSpec(item) === spec);
          if (!plugin || !await isMaterializedPlugin(plugin)) unavailable.push(spec);
        }
        if (unavailable.length > 0) {
          warn("Managed personal Skill availability is unknown because enabled Plugin package delivery could not be verified: " + unavailable.join(", ") + ".");
        } else {
          const skillResult = await convergeManagedSkills(config, catalogSnapshot.skills, enabledPlugins, context.homeDir, { dryRun: true });
          const skillStateChanged = JSON.stringify(skillResult.managedSkillPaths) !== JSON.stringify(config.managedSkillPaths ?? {});
          if (skillResult.changes.length === 0 && !skillStateChanged) ok("Managed personal skills: current.");
          else warn("Managed personal skills are stale. Run teamai sync.");
        }
      }
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
