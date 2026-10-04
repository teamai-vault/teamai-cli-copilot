import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { replaceDirectory } from "../utils/fs.js";
import { loadMarketplaceCatalog, type MarketplaceCatalog, type MarketplaceLoadOptions } from "./catalog.js";
import type { CopilotOperations, InstalledPlugin, MarketplacePluginRow, MarketplaceRow } from "./cli.js";
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

  pluginInstallIdentity(spec: string): { cachePath: string } {
    const [name, marketplace] = splitSpec(spec);
    return { cachePath: path.join(installedPluginsRoot(this.homeDir), marketplace, name) };
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
