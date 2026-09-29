import { lstat } from "node:fs/promises";
import path from "node:path";
import { readJsonIfExists } from "../utils/fs.js";
import type { MarketplaceConfig } from "../config/schema.js";

export interface MarketplaceSetting {
  source: Record<string, string>;
  autoUpdate?: boolean;
  [key: string]: unknown;
}

export interface ProjectSettings {
  extraKnownMarketplaces?: Record<string, MarketplaceSetting>;
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

export function projectSettingsPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".github", "copilot", "settings.json");
}

export async function readProjectSettings(workspaceRoot: string): Promise<ProjectSettings> {
  await assertSafeProjectSettingsPath(workspaceRoot);
  try {
    return (await readJsonIfExists<ProjectSettings>(projectSettingsPath(workspaceRoot))) ?? {};
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${projectSettingsPath(workspaceRoot)} contains invalid JSON.`);
    }
    throw error;
  }
}

export function marketplaceSourceSetting(source: string): MarketplaceSetting {
  if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith("/") || source.startsWith("./") || source.startsWith("../")) {
    return { source: { source: "directory", path: path.resolve(source) } };
  }
  if (/^(?:https?:\/\/|ssh:\/\/|git@)/.test(source)) {
    return { source: { source: "git", url: source } };
  }
  return { source: { source: "github", repo: source } };
}

export function mergeManagedProjectPlugins(
  current: ProjectSettings,
  marketplace: MarketplaceConfig,
  projectPlugins: string[],
  ownedPlugins: string[],
): ProjectSettings {
  const desired = new Set(projectPlugins.map((plugin) => `${plugin}@${marketplace.name}`));
  const owned = new Set(ownedPlugins);
  const enabledPlugins = { ...(current.enabledPlugins ?? {}) };
  for (const spec of owned) if (!desired.has(spec) && enabledPlugins[spec] === true) delete enabledPlugins[spec];
  for (const spec of desired) if (owned.has(spec) || !(spec in enabledPlugins)) enabledPlugins[spec] = true;
  const ownsNewPlugin = [...desired].some((spec) => owned.has(spec) || !(spec in (current.enabledPlugins ?? {})));
  if (!ownsNewPlugin && owned.size === 0) return current;
  return {
    ...current,
    ...(ownsNewPlugin ? { extraKnownMarketplaces: { ...(current.extraKnownMarketplaces ?? {}), [marketplace.name]: marketplaceSourceSetting(marketplace.source) } } : {}),
    enabledPlugins,
  };
}

async function assertSafeProjectSettingsPath(workspaceRoot: string): Promise<void> {
  const root = path.resolve(workspaceRoot);
  const target = projectSettingsPath(root);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe repository Copilot settings path: ${target}`);
  }
  let current = root;
  try {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe repository Copilot settings path: ${current}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const segments = relative.split(path.sep);
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe repository Copilot settings path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error(`Unsafe repository Copilot settings file: ${target}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
