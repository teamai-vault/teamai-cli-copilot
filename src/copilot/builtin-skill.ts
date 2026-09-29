import { lstat, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teamAiHome } from "../config/global.js";
import { atomicWriteJson, directoriesEqual, pathsEqual, readJsonIfExists, replaceDirectory, withFileLock } from "../utils/fs.js";
import { copilotHome } from "./user-state.js";

const BUILT_IN_SKILL_NAME = "teamai";
const OWNER = "teamai-cli";

interface BuiltInSkillOwnership {
  schemaVersion: 1;
  managedBy: typeof OWNER;
  skill: typeof BUILT_IN_SKILL_NAME;
  version: string;
  target: string;
}

export interface BuiltInSkillState {
  status: "current" | "missing" | "stale" | "collision";
  target: string;
  version: string;
  reason?: string;
}

export interface BuiltInSkillConvergence {
  state: BuiltInSkillState;
  change?: "create" | "update";
}

export function builtInTeamAiSkillSource(): string {
  return fileURLToPath(new URL("../../skills/teamai/", import.meta.url));
}

export function builtInTeamAiSkillTarget(homeDir: string): string {
  return path.join(copilotHome(homeDir), "skills", BUILT_IN_SKILL_NAME);
}

export function builtInTeamAiSkillOwnershipPath(homeDir: string): string {
  return path.join(teamAiHome(homeDir), "built-in-skills", BUILT_IN_SKILL_NAME + ".json");
}

export async function inspectBuiltInTeamAiSkill(homeDir: string): Promise<BuiltInSkillState> {
  const source = builtInTeamAiSkillSource();
  await assertDirectory(source, "Bundled Team AI Skill source");
  const version = await bundledCliVersion();
  const target = builtInTeamAiSkillTarget(homeDir);
  const ownership = await readOwnership(homeDir);
  const targetExists = await exists(target);

  if (!ownership) {
    if (targetExists) {
      return {
        status: "collision",
        target,
        version,
        reason: "target exists without Team AI CLI ownership",
      };
    }
    return { status: "missing", target, version };
  }

  if (!pathsEqual(ownership.target, target)) throw copilotHomeMismatch(ownership.target, target);
  if (!targetExists) return { status: "stale", target, version, reason: "owned target is missing" };

  try {
    await assertDirectory(target, "Built-in Team AI Skill target");
  } catch (error) {
    return { status: "collision", target, version, reason: (error as Error).message };
  }

  const contentCurrent = await directoriesEqual(source, target);
  if (contentCurrent && ownership.version === version) return { status: "current", target, version };
  return {
    status: "stale",
    target,
    version,
    reason: contentCurrent
      ? "ownership version is " + ownership.version
      : "installed content differs from the bundled Skill",
  };
}

export async function assertCopilotHomeMatchesOwnership(homeDir: string): Promise<void> {
  const ownership = await readOwnership(homeDir);
  if (!ownership) return;
  const target = builtInTeamAiSkillTarget(homeDir);
  if (!pathsEqual(ownership.target, target)) throw copilotHomeMismatch(ownership.target, target);
}

export async function convergeBuiltInTeamAiSkill(
  homeDir: string,
  options: { dryRun?: boolean } = {},
): Promise<BuiltInSkillConvergence> {
  const state = await inspectBuiltInTeamAiSkill(homeDir);
  if (state.status === "collision") {
    throw new Error("Built-in Team AI Skill collision at '" + state.target + "': " + state.reason + ".");
  }
  if (state.status === "current") return { state };

  const change = state.status === "missing" ? "create" : "update";
  if (options.dryRun) return { state, change };

  const source = builtInTeamAiSkillSource();
  const lockPath = path.join(copilotHome(homeDir), "skills", ".teamai.lock");
  await withFileLock(lockPath, async () => {
    const current = await inspectBuiltInTeamAiSkill(homeDir);
    if (current.status === "collision") {
      throw new Error("Built-in Team AI Skill collision at '" + current.target + "': " + current.reason + ".");
    }
    if (current.status === "current") return;
    const ownership: BuiltInSkillOwnership = {
      schemaVersion: 1,
      managedBy: OWNER,
      skill: BUILT_IN_SKILL_NAME,
      version: current.version,
      target: current.target,
    };
    await replaceDirectory(source, current.target);
    try {
      await atomicWriteJson(builtInTeamAiSkillOwnershipPath(homeDir), ownership);
    } catch (error) {
      if (current.status === "missing") {
        try {
          await rm(current.target, { recursive: true, force: true });
        } catch (rollbackError) {
          throw new Error(
            "Built-in Team AI Skill ownership write failed and install rollback also failed. " +
            `Ownership error: ${(error as Error).message}. Rollback error: ${(rollbackError as Error).message}`,
          );
        }
      }
      throw error;
    }
  });
  return { state: await inspectBuiltInTeamAiSkill(homeDir), change };
}

function copilotHomeMismatch(ownedTarget: string, expectedTarget: string): Error {
  return new Error(`COPILOT_HOME root mismatch: Team AI owns the built-in Skill at '${ownedTarget}', but the current target is '${expectedTarget}'. Refusing to move or reassign it.`);
}

async function readOwnership(homeDir: string): Promise<BuiltInSkillOwnership | undefined> {
  const filePath = builtInTeamAiSkillOwnershipPath(homeDir);
  const value = await readJsonIfExists<unknown>(filePath);
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    (value as Partial<BuiltInSkillOwnership>).schemaVersion !== 1 ||
    (value as Partial<BuiltInSkillOwnership>).managedBy !== OWNER ||
    (value as Partial<BuiltInSkillOwnership>).skill !== BUILT_IN_SKILL_NAME ||
    typeof (value as Partial<BuiltInSkillOwnership>).version !== "string" ||
    typeof (value as Partial<BuiltInSkillOwnership>).target !== "string"
  ) {
    throw new Error("Invalid built-in Team AI Skill ownership record at '" + filePath + "'.");
  }
  return value as BuiltInSkillOwnership;
}

async function bundledCliVersion(): Promise<string> {
  const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const value = JSON.parse(await readFile(packagePath, "utf8")) as { version?: unknown };
  if (typeof value.version !== "string" || value.version.length === 0) {
    throw new Error("Team AI package version is missing from '" + packagePath + "'.");
  }
  return value.version;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertDirectory(target: string, label: string): Promise<void> {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(label + " is not a regular directory: " + target);
  }
}

