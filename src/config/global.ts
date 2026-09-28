import os from "node:os";
import path from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteText, readTextIfExists } from "../utils/fs.js";
import { type TeamAiConfig, validateConfig } from "./schema.js";

export function teamAiHome(homeDir = os.homedir()): string {
  return path.join(homeDir, ".teamai");
}

export function configPath(homeDir = os.homedir()): string {
  return path.join(teamAiHome(homeDir), "config.yaml");
}

export async function readGlobalConfig(homeDir = os.homedir()): Promise<TeamAiConfig | undefined> {
  const contents = await readTextIfExists(configPath(homeDir));
  if (contents === undefined) return undefined;
  return validateConfig(parse(contents));
}

export async function writeGlobalConfig(config: TeamAiConfig, homeDir = os.homedir()): Promise<void> {
  const ordered = {
    version: config.version,
    marketplace: config.marketplace,
    ...(config.marketplaceRevision ? { marketplaceRevision: config.marketplaceRevision } : {}),
    ...(config.role ? { role: config.role } : {}),
    managedPlugins: config.managedPlugins ?? [],
    managedSkills: config.managedSkills ?? [],
    managedSkillPaths: config.managedSkillPaths ?? {},
  };
  await atomicWriteText(configPath(homeDir), stringify(ordered));
}
