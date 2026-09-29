import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { replaceDirectory } from "../utils/fs.js";
import { loadMarketplaceCatalog, TEAM_AI_EXTENSION_NAMESPACE, type MarketplaceCatalog, type MarketplaceLoadOptions } from "./catalog.js";
import type { CopilotOperations, InstalledPlugin, MarketplacePluginRow, MarketplaceRow, NativeMcpServer } from "./cli.js";
import {
  installedPluginsRoot,
  readCopilotState,
  registerMarketplaceState,
  removeMarketplaceState,
  setPluginEnabled,
  updateCopilotState,
  upsertInstalledPlugin,
} from "./user-state.js";

export class FallbackCopilotClient implements CopilotOperations {
  private readonly loadMarketplace: (source: string, cwd: string, options?: MarketplaceLoadOptions) => Promise<MarketplaceCatalog>;

  constructor(
    private readonly homeDir: string,
    private readonly now: () => Date,
    loadMarketplace?: (source: string, cwd: string, options?: MarketplaceLoadOptions) => Promise<MarketplaceCatalog>,
  ) {
    this.loadMarketplace = loadMarketplace ?? ((source, cwd, options) => loadMarketplaceCatalog(source, cwd, {
      ...options,
      homeDir: this.homeDir,
    }));
  }

  async version(): Promise<string> {
    return "VS Code-compatible fallback";
  }

  async listPlugins(): Promise<InstalledPlugin[]> {
    const { config, settings } = await readCopilotState(this.homeDir);
    const configured: InstalledPlugin[] = (config.installedPlugins ?? []).map((plugin) => ({
      ...plugin,
      mirroredEnabled: plugin.enabled,
      enabled: settings.enabledPlugins?.[`${plugin.name}@${plugin.marketplace}`] ?? plugin.enabled ?? false,
    }));
    for (const materialized of await discoverMaterializedPlugins(installedPluginsRoot(this.homeDir))) {
      if (!configured.some((plugin) => plugin.name === materialized.name && plugin.marketplace === materialized.marketplace)) {
        configured.push({
          ...materialized,
          enabled: settings.enabledPlugins?.[`${materialized.name}@${materialized.marketplace}`] ?? false,
          source: "filesystem",
        });
      }
    }
    return configured;
  }

  async listMcpServers(): Promise<{ servers: NativeMcpServer[]; errors: string[] }> {
    const servers: NativeMcpServer[] = [];
    const errors: string[] = [];
    for (const plugin of await this.listPlugins()) {
      if (!plugin.enabled || typeof plugin.cache_path !== "string") continue;
      try {
        const config = JSON.parse(await readFile(path.join(plugin.cache_path, "mcp.json"), "utf8")) as { mcpServers?: Record<string, unknown> };
        for (const name of Object.keys(config.mcpServers ?? {})) servers.push({ name, source: `plugin:${plugin.name}` });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`${plugin.name}: invalid mcp.json`);
      }
    }
    return { servers, errors };
  }

  async listMarketplaces(): Promise<MarketplaceRow[]> {
    const { settings } = await readCopilotState(this.homeDir);
    return Object.entries(settings.extraKnownMarketplaces ?? {}).map(([name, value]) => ({
      name,
      source: sourceValue(value.source),
    }));
  }

  async browseMarketplace(name: string, cwd?: string): Promise<MarketplacePluginRow[]> {
    const catalog = await this.catalog(name, cwd);
    try {
      return catalog.plugins.map((plugin) => ({ name: plugin.name, version: plugin.version }));
    } finally {
      await catalog.dispose();
    }
  }

  async addMarketplace(source: string, cwd = process.cwd()): Promise<void> {
    const catalog = await this.loadMarketplace(source, cwd);
    try {
      await updateCopilotState(this.homeDir, (_config, settings) => registerMarketplaceState(settings, catalog.name, source));
    } finally {
      await catalog.dispose();
    }
  }

  async removeMarketplace(name: string): Promise<void> {
    await updateCopilotState(this.homeDir, (_config, settings) => removeMarketplaceState(settings, name));
  }

  async installPlugin(spec: string, cwd?: string): Promise<void> {
    const [name, marketplace] = splitSpec(spec);
    const catalog = await this.catalog(marketplace, cwd);
    try {
      const plugin = catalog.plugins.find((item) => item.name === name);
      if (!plugin) throw new Error(`${spec} is not present in the Marketplace.`);
      const target = await installTarget(installedPluginsRoot(this.homeDir), marketplace, name);
      await updateCopilotState(this.homeDir, async (config, settings) => {
        await replaceDirectory(plugin.root, target);
        upsertInstalledPlugin(config, settings, {
          name,
          marketplace,
          version: plugin.version,
          cache_path: target,
          enabled: true,
        }, this.now().toISOString());
      });
    } finally {
      await catalog.dispose();
    }
  }

  async enablePlugin(spec: string): Promise<void> {
    await this.setEnabled(spec, true);
  }

  async disablePlugin(spec: string): Promise<void> {
    await this.setEnabled(spec, false);
  }

  async updatePlugin(spec: string, cwd?: string): Promise<void> {
    const current = (await this.listPlugins()).find((plugin) => `${plugin.name}@${plugin.marketplace}` === spec);
    if (!current) throw new Error(`${spec} is not installed.`);
    await this.installPlugin(spec, cwd);
    if (!current.enabled) await this.disablePlugin(spec);
  }

  async materializeProjectPlugin(spec: string, cwd: string, dryRun = false): Promise<{ path: string; status: "materialized" | "preserved" | "unavailable"; reason?: string }> {
    const [name, marketplace] = splitSpec(spec);
    const catalog = await this.catalog(marketplace, cwd);
    try {
      const plugin = catalog.plugins.find((item) => item.name === name);
      if (!plugin || plugin.kind !== "project") throw new Error(`${spec} is not an available project Plugin.`);
      const target = path.join(installedPluginsRoot(this.homeDir), marketplace, name);
      const existing = (await readCopilotState(this.homeDir)).config.installedPlugins?.find((item) => item.name === name && item.marketplace === marketplace);
      if (existing) {
        if (existing.cache_path && path.resolve(existing.cache_path) === path.resolve(target) && await isProjectPluginPackage(target, name)) {
          return { path: target, status: "preserved" };
        }
        return { path: target, status: "unavailable", reason: `${spec} already has a user-owned installedPlugins record at ${existing.cache_path ?? "an unspecified cache path"}.` };
      }
      if (await pathExists(target)) {
        return await isProjectPluginPackage(target, name)
          ? { path: target, status: "preserved" }
          : { path: target, status: "unavailable", reason: `Existing path is not a valid ${spec} package.` };
      }
      if (dryRun) return { path: target, status: "materialized" };
      const safeTarget = await installTarget(installedPluginsRoot(this.homeDir), marketplace, name);
      try {
        await updateCopilotState(this.homeDir, async (config, settings) => {
          if (config.installedPlugins?.some((item) => item.name === name && item.marketplace === marketplace)) {
            throw new Error("PROJECT_PLUGIN_OWNERSHIP_CONFLICT");
          }
          if (await pathExists(safeTarget)) throw new Error("PROJECT_PLUGIN_TARGET_CONFLICT");
          await replaceDirectory(plugin.root, safeTarget);
          const enabled = settings.enabledPlugins?.[spec] ?? false;
          upsertInstalledPlugin(config, settings, {
            name,
            marketplace,
            version: plugin.version,
            cache_path: safeTarget,
            enabled,
          }, this.now().toISOString());
        });
      } catch (error) {
        if (error instanceof Error && error.message === "PROJECT_PLUGIN_OWNERSHIP_CONFLICT") {
          return { path: safeTarget, status: "unavailable", reason: `${spec} acquired an installedPlugins record during package delivery; preserved it.` };
        }
        if (error instanceof Error && error.message === "PROJECT_PLUGIN_TARGET_CONFLICT") {
          return { path: safeTarget, status: "unavailable", reason: `Package target appeared during delivery; preserved ${safeTarget}.` };
        }
        throw error;
      }
      return { path: safeTarget, status: "materialized" };
    } finally {
      await catalog.dispose();
    }
  }

  private async setEnabled(spec: string, enabled: boolean): Promise<void> {
    const [name, marketplace] = splitSpec(spec);
    await updateCopilotState(this.homeDir, (config, settings) => setPluginEnabled(config, settings, name, marketplace, enabled));
  }

  private async catalog(name: string, cwd = process.cwd()): Promise<MarketplaceCatalog> {
    const { settings } = await readCopilotState(this.homeDir);
    const source = settings.extraKnownMarketplaces?.[name]?.source;
    if (!source) throw new Error(`Marketplace ${name} is not registered.`);
    return await this.loadMarketplace(sourceValue(source), cwd);
  }
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

async function isProjectPluginPackage(target: string, name: string): Promise<boolean> {
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    const manifest = JSON.parse(await readFile(path.join(target, "plugin.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
      extensions?: Record<string, { kind?: unknown }>;
    };
    return manifest.name === name && typeof manifest.version === "string" && manifest.extensions?.[TEAM_AI_EXTENSION_NAMESPACE]?.kind === "project";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) return false;
    throw error;
  }
}

function splitSpec(spec: string): [string, string] {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) throw new Error(`Plugin spec must be <name>@<marketplace>: ${spec}`);
  return [spec.slice(0, at), spec.slice(at + 1)];
}

function sourceValue(source: Record<string, string>): string {
  return source.path ?? source.url ?? source.repo ?? "";
}

async function installTarget(root: string, marketplace: string, plugin: string): Promise<string> {
  await mkdir(root, { recursive: true });
  const resolvedRoot = await realpath(root);
  const marketplaceRoot = path.join(resolvedRoot, marketplace);
  await mkdir(marketplaceRoot, { recursive: true });
  const resolvedMarketplace = await realpath(marketplaceRoot);
  if (isOutside(resolvedRoot, resolvedMarketplace)) throw new Error(`Marketplace install path escapes ${resolvedRoot}.`);
  const target = path.join(resolvedMarketplace, plugin);
  if (isOutside(resolvedMarketplace, target)) throw new Error(`Plugin install path escapes ${resolvedMarketplace}.`);
  return target;
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function discoverMaterializedPlugins(root: string): Promise<InstalledPlugin[]> {
  const plugins: InstalledPlugin[] = [];
  let marketplaces;
  try {
    marketplaces = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return plugins;
    throw error;
  }
  for (const marketplace of marketplaces.filter((entry) => entry.isDirectory())) {
    const marketplaceRoot = path.join(root, marketplace.name);
    for (const plugin of (await readdir(marketplaceRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory())) {
      const pluginRoot = path.join(marketplaceRoot, plugin.name);
      try {
        const manifest = JSON.parse(await readFile(path.join(pluginRoot, "plugin.json"), "utf8")) as { name?: unknown; version?: unknown };
        if (manifest.name === plugin.name && typeof manifest.version === "string") {
          plugins.push({ name: plugin.name, marketplace: marketplace.name, version: manifest.version, enabled: false, cache_path: pluginRoot });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      }
    }
  }
  return plugins;
}
