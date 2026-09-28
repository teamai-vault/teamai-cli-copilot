import { lstat, rm } from "node:fs/promises";
import path from "node:path";
import type { TeamAiConfig } from "../config/schema.js";
import type { CatalogSkill } from "./catalog.js";
import type { InstalledPlugin } from "./cli.js";
import type { ProjectSettings } from "./project-settings.js";
import { directoriesEqual, pathsEqual, replaceDirectory, withFileLock } from "../utils/fs.js";

export interface ManagedSkillChange {
  type: "create" | "update" | "remove" | "available-via-plugin";
  name: string;
}

export function personalSkillsRoot(homeDir: string): string {
  return path.join(homeDir, ".copilot", "skills");
}

export function personalSkillPath(homeDir: string, name: string): string {
  return path.join(personalSkillsRoot(homeDir), name);
}

export function enabledPluginSkillNames(skills: CatalogSkill[], enabledPlugins: Set<string>, marketplace: string): Set<string> {
  return new Set(skills
    .filter((skill) => skill.sourceType === "plugin" && skill.plugin && enabledPlugins.has(`${skill.plugin}@${marketplace}`))
    .map((skill) => skill.name));
}

export function effectiveEnabledPluginSpecs(installed: InstalledPlugin[], projectSettings?: ProjectSettings): Set<string> {
  const enabled = new Set(installed.filter((plugin) => plugin.enabled && plugin.marketplace).map((plugin) => `${plugin.name}@${plugin.marketplace}`));
  for (const [spec, value] of Object.entries(projectSettings?.enabledPlugins ?? {})) {
    if (value) enabled.add(spec);
    else enabled.delete(spec);
  }
  return enabled;
}

export async function convergeManagedSkills(
  config: Pick<TeamAiConfig, "managedSkills" | "managedSkillPaths" | "marketplace">,
  skills: CatalogSkill[],
  enabledPlugins: Set<string>,
  homeDir: string,
  options: { dryRun?: boolean } = {},
): Promise<{ changes: ManagedSkillChange[]; available: string[]; managedSkillPaths: Record<string, string> }> {
  const desired = [...new Set(config.managedSkills ?? [])].sort();
  const catalog = new Map(skills.map((skill) => [skill.name, skill]));
  const records = { ...(config.managedSkillPaths ?? {}) };
  const available = enabledPluginSkillNames(skills, enabledPlugins, config.marketplace.name);
  const changes: ManagedSkillChange[] = [];

  for (const name of desired) {
    const skill = catalog.get(name);
    if (!skill) throw new Error(`Managed skill '${name}' is missing from the current Marketplace catalog.`);
    if (skill.sourceType === "plugin" && !skill.standalone && !available.has(name)) {
      throw new Error(`Skill '${name}' requires its containing plugin '${skill.plugin}' to be enabled.`);
    }
  }

  const action = async () => {
    for (const [name, record] of Object.entries(records)) {
      const target = personalSkillPath(homeDir, name);
      if (!pathsEqual(record, target)) throw new Error(`Managed skill '${name}' has an unsafe ownership record.`);
      const skill = catalog.get(name);
      if (!desired.includes(name) || !skill || available.has(name)) {
        if (await pathExists(target)) changes.push({ type: "remove", name });
        if (!options.dryRun) await rm(target, { recursive: true, force: true });
        delete records[name];
      }
    }

    for (const name of desired) {
      const skill = catalog.get(name)!;
      if (available.has(name)) continue;
      const target = personalSkillPath(homeDir, name);
      const owned = records[name] !== undefined;
      if (await pathExists(target) && !owned) {
        throw new Error(`Personal skill '${name}' already exists and is not managed by Team AI.`);
      }
      const current = owned && await directoriesEqual(skill.root, target);
      if (!current) changes.push({ type: owned ? "update" : "create", name });
      if (!options.dryRun) {
        if (!current) await replaceDirectory(skill.root, target);
      }
      records[name] = target;
    }
  };

  if (options.dryRun) await action();
  else await withFileLock(path.join(personalSkillsRoot(homeDir), ".teamai.lock"), action);
  return { changes, available: [...available].filter((name) => desired.includes(name)).sort(), managedSkillPaths: records };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
