import { stat } from "node:fs/promises";
import path from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { atomicWriteJson, readJsonIfExists, readTextIfExists, withFileLock } from "../utils/fs.js";
import { marketplaceSourceSetting } from "./project-settings.js";
import { loadMarketplaceCatalog, type MarketplaceCatalog } from "./catalog.js";
import type { InstalledPlugin } from "./cli.js";
import { pathsEqual } from "../utils/fs.js";

export interface CopilotInstalledPlugin {
  name: string;
  marketplace: string;
  version?: string;
  installed_at?: string;
  cache_path?: string;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface CopilotConfigFile {
  installedPlugins?: CopilotInstalledPlugin[];
  [key: string]: unknown;
}

export interface CopilotSettingsFile {
  extraKnownMarketplaces?: Record<string, { source: Record<string, string>; [key: string]: unknown }>;
  enabledPlugins?: Record<string, boolean>;
  [key: string]: unknown;
}

export function copilotHome(homeDir: string): string {
  const configured = process.env.COPILOT_HOME;
  if (configured === undefined || configured.length === 0) return path.join(homeDir, ".copilot");
  if (configured.includes("\0") || !path.isAbsolute(configured)) {
    throw new Error("COPILOT_HOME must be an absolute directory path.");
  }
  const resolved = path.resolve(configured);
  if (resolved === path.parse(resolved).root) {
    throw new Error("COPILOT_HOME cannot be a filesystem root.");
  }
  return resolved;
}

export function copilotDisplayPath(relativePath: string, homeDir: string): string {
  const configured = process.env.COPILOT_HOME;
  if (configured === undefined || configured.length === 0) return `~/.copilot/${relativePath.replace(/[\\/]+/g, "/")}`;
  return path.join(copilotHome(homeDir), ...relativePath.split(/[\\/]+/));
}

export function copilotConfigPath(homeDir: string): string {
  return path.join(copilotHome(homeDir), "config.json");
}

export function copilotSettingsPath(homeDir: string): string {
  return path.join(copilotHome(homeDir), "settings.json");
}

export function installedPluginsRoot(homeDir: string): string {
  return path.join(copilotHome(homeDir), "installed-plugins");
}

export async function readCopilotState(homeDir: string): Promise<{ config: CopilotConfigFile; settings: CopilotSettingsFile }> {
  return {
    config: (await readCopilotConfig(copilotConfigPath(homeDir))) ?? {},
    settings: (await readJsonIfExists<CopilotSettingsFile>(copilotSettingsPath(homeDir))) ?? {},
  };
}

/** Native live Marketplace rows describe discoverable packages, including never-installed entries. */
export async function normalizeLivePluginInventory(installed: InstalledPlugin[], homeDir: string): Promise<InstalledPlugin[]> {
  if (!installed.some((plugin) => plugin.scope === "user" && typeof plugin.installedFrom === "string" && path.isAbsolute(plugin.installedFrom)
    && typeof plugin.source === "string" && plugin.source.startsWith("live-marketplace:"))) return installed;
  const local = await readCopilotState(homeDir);
  const catalogs = new Map<string, Promise<MarketplaceCatalog>>();
  try {
    return await Promise.all(installed.map(async (plugin) => {
      if (plugin.scope !== "user" || plugin.source !== `live-marketplace:${plugin.marketplace}`
        || typeof plugin.installedFrom !== "string" || !path.isAbsolute(plugin.installedFrom)) return plugin;
      const registration = local.settings.extraKnownMarketplaces?.[plugin.marketplace ?? ""]?.source;
      if (registration?.source !== "directory" || typeof registration.path !== "string" || !pathsEqual(registration.path, plugin.installedFrom)) return plugin;
      let pending = catalogs.get(plugin.installedFrom);
      if (!pending) {
        pending = loadMarketplaceCatalog(plugin.installedFrom, plugin.installedFrom);
        catalogs.set(plugin.installedFrom, pending);
      }
      const catalog = await pending;
      const declared = catalog.plugins.find((candidate) => candidate.name === plugin.name && candidate.version === plugin.version);
      if (catalog.name !== plugin.marketplace || !declared) return plugin;
      const spec = `${plugin.name}@${plugin.marketplace}`;
      const explicitlyInstalled = local.config.installedPlugins?.some((candidate) => candidate.name === plugin.name && candidate.marketplace === plugin.marketplace);
      return {
        ...plugin,
        cache_path: declared.root,
        discoveredOnly: !explicitlyInstalled && typeof local.settings.enabledPlugins?.[spec] !== "boolean",
      };
    }));
  } finally {
    for (const pending of catalogs.values()) await (await pending).dispose();
  }
}

/** Read the same persisted live-user facts without invoking the native executable. */
export function recordedUserPluginInventory(local: { config: CopilotConfigFile; settings: CopilotSettingsFile }, catalog: MarketplaceCatalog): InstalledPlugin[] {
  const installed: InstalledPlugin[] = (local.config.installedPlugins ?? []).map((plugin) => ({
    ...plugin,
    enabled: plugin.enabled ?? local.settings.enabledPlugins?.[`${plugin.name}@${plugin.marketplace}`] ?? false,
  }));
  const registration = local.settings.extraKnownMarketplaces?.[catalog.name]?.source;
  if (registration?.source !== "directory" || typeof registration.path !== "string" || !pathsEqual(registration.path, catalog.root)) return installed;
  for (const plugin of catalog.plugins) {
    if (installed.some((candidate) => candidate.name === plugin.name && candidate.marketplace === catalog.name)) continue;
    const enabled = local.settings.enabledPlugins?.[`${plugin.name}@${catalog.name}`];
    installed.push({
      name: plugin.name, marketplace: catalog.name, version: plugin.version, cache_path: plugin.root,
      enabled: enabled ?? false, discoveredOnly: typeof enabled !== "boolean",
      scope: "user", source: `live-marketplace:${catalog.name}`, installedFrom: catalog.root,
    });
  }
  return installed;
}

async function readCopilotConfig(filePath: string): Promise<CopilotConfigFile | undefined> {
  const contents = await readTextIfExists(filePath);
  if (contents === undefined) return undefined;
  const errors: ParseError[] = [];
  const value = parse(contents, errors, { allowTrailingComma: true }) as CopilotConfigFile | undefined;
  if (errors.length > 0 || !value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath} contains invalid JSONC.`);
  }
  return value;
}

export async function updateCopilotState(
  homeDir: string,
  update: (config: CopilotConfigFile, settings: CopilotSettingsFile) => void | Promise<void>,
): Promise<void> {
  await withFileLock(path.join(copilotHome(homeDir), ".teamai.lock"), async () => {
    const { config, settings } = await readCopilotState(homeDir);
    await update(config, settings);
    await atomicWriteJson(copilotConfigPath(homeDir), config);
    await atomicWriteJson(copilotSettingsPath(homeDir), settings);
  });
}

export function registerMarketplaceState(settings: CopilotSettingsFile, name: string, source: string): void {
  const current = settings.extraKnownMarketplaces?.[name];
  const { source: _kind, path: _path, url: _url, repo: _repo, ...unknownSource } = current?.source ?? {};
  settings.extraKnownMarketplaces = {
    ...(settings.extraKnownMarketplaces ?? {}),
    [name]: {
      ...(current ?? {}),
      source: { ...unknownSource, ...marketplaceSourceSetting(source).source },
    },
  };
}

export function removeMarketplaceState(settings: CopilotSettingsFile, name: string): void {
  if (!settings.extraKnownMarketplaces?.[name]) return;
  const { [name]: _removed, ...remaining } = settings.extraKnownMarketplaces;
  settings.extraKnownMarketplaces = remaining;
}

export function upsertInstalledPlugin(
  config: CopilotConfigFile,
  settings: CopilotSettingsFile,
  plugin: Required<Pick<CopilotInstalledPlugin, "name" | "marketplace" | "version" | "cache_path" | "enabled">>,
  installedAt: string,
): void {
  const installed = config.installedPlugins ?? [];
  const index = installed.findIndex((item) => item.name === plugin.name && item.marketplace === plugin.marketplace);
  const existing = index >= 0 ? installed[index] : undefined;
  const entry: CopilotInstalledPlugin = {
    ...(existing ?? {}),
    ...plugin,
    installed_at: existing?.installed_at ?? installedAt,
  };
  config.installedPlugins = index >= 0
    ? installed.map((item, itemIndex) => itemIndex === index ? entry : item)
    : [...installed, entry];
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [`${plugin.name}@${plugin.marketplace}`]: plugin.enabled };
}

export function setPluginEnabled(
  config: CopilotConfigFile,
  settings: CopilotSettingsFile,
  name: string,
  marketplace: string,
  enabled: boolean,
): void {
  const installed = config.installedPlugins ?? [];
  const index = installed.findIndex((item) => item.name === name && item.marketplace === marketplace);
  if (index < 0) throw new Error(`${name}@${marketplace} is not installed.`);
  config.installedPlugins = installed.map((item, itemIndex) => itemIndex === index ? { ...item, enabled } : item);
  settings.enabledPlugins = { ...(settings.enabledPlugins ?? {}), [`${name}@${marketplace}`]: enabled };
}

export async function fallbackStateProblems(homeDir: string, managedPlugins: string[]): Promise<string[]> {
  const { config, settings } = await readCopilotState(homeDir);
  const problems: string[] = [];
  for (const spec of managedPlugins) {
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const marketplace = spec.slice(at + 1);
    const entry = (config.installedPlugins ?? []).find((item) => item.name === name && item.marketplace === marketplace);
    if (!entry) {
      problems.push(`${spec} is missing from ${copilotDisplayPath("config.json", homeDir)} installedPlugins.`);
      continue;
    }
    const authority = settings.enabledPlugins?.[spec];
    if (typeof authority !== "boolean") problems.push(`${spec} is missing from ${copilotDisplayPath("settings.json", homeDir)} enabledPlugins.`);
    else if (entry.enabled !== authority) problems.push(`${spec} enabled state differs between Copilot config.json and settings.json.`);
    if (typeof entry.cache_path !== "string" || !await directoryExists(entry.cache_path)) {
      problems.push(`${spec} cache_path is missing or not materialized.`);
    }
  }
  return problems;
}

export function marketplaceRegistrationMatches(settings: CopilotSettingsFile, name: string, source: string): boolean {
  const actual = settings.extraKnownMarketplaces?.[name]?.source;
  const expected = marketplaceSourceSetting(source).source;
  return Boolean(actual && Object.entries(expected).every(([key, value]) =>
    key === "path" && expected.source === "directory" && typeof actual[key] === "string"
      ? pathsEqual(actual[key], value)
      : actual[key] === value,
  ));
}

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await stat(directory)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
