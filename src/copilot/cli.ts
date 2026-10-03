import { runProcess, type ProcessResult } from "../utils/process.js";
import os from "node:os";
import path from "node:path";
import { lstat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { normalizeLivePluginInventory, readCopilotState, marketplaceRegistrationMatches, nativeInstalledPluginTarget } from "./user-state.js";
import { ensureSafeTargetChain } from "./user-instructions.js";
import type { CatalogPlugin } from "./catalog.js";
import type { MarketplaceConfig, ManagedPluginReceipt } from "../config/schema.js";
import { pathsEqual } from "../utils/fs.js";
import { marketplaceRowMatchesSource } from "./marketplace.js";

export interface InstalledPlugin {
  name: string;
  marketplace?: string;
  version?: string;
  enabled: boolean;
  mirroredEnabled?: boolean;
  source?: unknown;
  installedFrom?: unknown;
  cache_path?: string;
  scope?: string;
  /** Live catalog discovery without a persisted user installation/enablement choice. */
  discoveredOnly?: boolean;
  [key: string]: unknown;
}

export interface MarketplaceRow {
  name: string;
  source?: string;
  [key: string]: unknown;
}

export interface MarketplacePluginRow {
  name: string;
  version?: string;
  [key: string]: unknown;
}

export interface CopilotOperations {
  version(): Promise<string>;
  listPlugins(cwd?: string): Promise<InstalledPlugin[]>;
  listMarketplaces(cwd?: string): Promise<MarketplaceRow[]>;
  browseMarketplace(name: string, cwd?: string): Promise<MarketplacePluginRow[]>;
  addMarketplace(source: string, cwd?: string): Promise<void>;
  removeMarketplace(name: string, cwd?: string): Promise<void>;
  installPlugin(spec: string, cwd?: string): Promise<void>;
  enablePlugin(spec: string, cwd?: string): Promise<void>;
  disablePlugin(spec: string, cwd?: string): Promise<void>;
  updatePlugin(spec: string, cwd?: string): Promise<void>;
  /** A producer-defined install destination, when it can be known before mutation. */
  pluginInstallIdentity?(spec: string): { cachePath: string; source?: string; installedFrom?: string };
  preparePluginDelivery?(marketplace: MarketplaceConfig, catalog: CatalogPlugin[], receipts: ManagedPluginReceipt[], cwd?: string): Promise<void>;
  validatePluginCommands?(cwd?: string): Promise<void>;
}

export class CopilotUnavailableError extends Error {}

export class CopilotClient implements CopilotOperations {
  private readonly targets = new Map<string, { cachePath: string; source: string; installedFrom: string }>();
  constructor(
    private readonly executable = "copilot",
    private readonly prefixArgs: string[] = [],
    private readonly homeDir = os.homedir(),
    private readonly warning: (text: string) => void = (text) => process.stderr.write(text),
  ) {}

  private async exec(args: string[], cwd?: string): Promise<ProcessResult> {
    let result: ProcessResult;
    try {
      result = await runProcess(this.executable, [...this.prefixArgs, ...args], { cwd });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new CopilotUnavailableError("GitHub Copilot CLI is not installed or is not available on PATH.");
      }
      throw error;
    }
    if (result.exitCode !== 0) {
      throw new Error(`copilot ${args.join(" ")} failed (${result.exitCode}): ${[result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n")}`);
    }
    if (result.stderr) this.warning(result.stderr);
    return result;
  }

  async version(): Promise<string> {
    const result = await this.exec(["--version"]);
    return result.stdout.trim() || result.stderr.trim();
  }

  async listPlugins(cwd?: string): Promise<InstalledPlugin[]> {
    const parsed = this.parseArray<InstalledPlugin>(
      (await this.exec(["plugin", "list", "--json"], cwd)).stdout,
      "plugin list",
    );
    if (parsed.some((row) => !isRecord(row) || typeof row.name !== "string" || !row.name
      || typeof row.enabled !== "boolean" || typeof row.source !== "string" || !row.source
      || ["marketplace", "version", "installedFrom"].some((key) => row[key] !== undefined && typeof row[key] !== "string"))) {
      throw new Error("copilot plugin list returned invalid required field types.");
    }
    if (new Set(parsed.map((row) => `${row.name}@${row.marketplace ?? ""}`)).size !== parsed.length) throw new Error("copilot plugin list returned duplicate Plugin identities.");
    const normalized = await normalizeLivePluginInventory(parsed, this.homeDir);
    for (const row of normalized) {
      if (typeof row.cache_path === "string" && (row.source === `marketplace:${row.marketplace}` || row.source === `live-marketplace:${row.marketplace}`)) await ensureSafeTargetChain(row.cache_path);
    }
    return normalized;
  }

  async listMarketplaces(cwd?: string): Promise<MarketplaceRow[]> {
    const rows = this.parseArray<MarketplaceRow>(
      (await this.exec(["plugin", "marketplace", "list", "--json"], cwd)).stdout,
      "plugin marketplace list",
    );
    if (rows.some((row) => !isRecord(row) || typeof row.name !== "string" || !row.name || row.source !== undefined && typeof row.source !== "string")) throw new Error("copilot plugin marketplace list returned invalid required field types.");
    if (new Set(rows.map((row) => row.name)).size !== rows.length) throw new Error("copilot plugin marketplace list returned duplicate Marketplace names.");
    return rows;
  }

  async browseMarketplace(name: string, cwd?: string): Promise<MarketplacePluginRow[]> {
    const rows = this.parseArray<MarketplacePluginRow>(
      (await this.exec(["plugin", "marketplace", "browse", name, "--json"], cwd)).stdout,
      "plugin marketplace browse",
    );
    if (rows.some((row) => !isRecord(row) || typeof row.name !== "string" || !row.name || row.version !== undefined && typeof row.version !== "string")) throw new Error("copilot plugin marketplace browse returned invalid required field types.");
    return rows;
  }

  async addMarketplace(source: string, cwd?: string): Promise<void> {
    await this.exec(["plugin", "marketplace", "add", source], cwd);
  }

  async removeMarketplace(name: string, cwd?: string): Promise<void> {
    await this.exec(["plugin", "marketplace", "remove", name], cwd);
  }

  async installPlugin(spec: string, cwd?: string): Promise<void> {
    await this.exec(["plugin", "install", spec], cwd);
  }

  async enablePlugin(spec: string, cwd?: string): Promise<void> {
    await this.exec(["plugin", "enable", spec], cwd);
  }

  async disablePlugin(spec: string, cwd?: string): Promise<void> {
    await this.exec(["plugin", "disable", spec], cwd);
  }

  async updatePlugin(spec: string, cwd?: string): Promise<void> {
    await this.exec(["plugin", "update", spec], cwd);
  }

  async validatePluginCommands(cwd?: string): Promise<void> {
    for (const args of [["plugin", "install"], ["plugin", "enable"], ["plugin", "disable"], ["plugin", "update"], ["plugin", "marketplace", "add"], ["plugin", "marketplace", "remove"]]) {
      const result = await this.exec([...args, "--help"], cwd);
      if (!new RegExp(`^Usage:\\s+copilot\\s+${args.join("\\s+")}(?:\\s|$)`, "m").test(result.stdout)) throw new Error(`copilot ${args.join(" ")} --help returned an unsupported command contract.`);
    }
  }

  async preparePluginDelivery(marketplace: MarketplaceConfig, catalog: CatalogPlugin[], receipts: ManagedPluginReceipt[], cwd?: string): Promise<void> {
    this.targets.clear();
    const local = await readCopilotState(this.homeDir);
    const registration = local.settings.extraKnownMarketplaces?.[marketplace.name];
    const installed = await this.listPlugins(cwd);
    if (registration && !marketplaceRegistrationMatches(local.settings, marketplace.name, marketplace.source)) throw new Error(`Native Marketplace source conflict for '${marketplace.name}'.`);
    const marketplaces = await this.listMarketplaces(cwd);
    const registered = marketplaces.find((row) => row.name === marketplace.name);
    if (registered && (!registration || !marketplaceRowMatchesSource(registered, marketplace.source))) throw new Error(`Native Marketplace registration readback conflict for '${marketplace.name}'.`);
    if (registration && !registered) throw new Error(`Native Marketplace registration is absent from inventory for '${marketplace.name}'.`);
    if (registered) {
      const available = await this.browseMarketplace(marketplace.name, cwd);
      for (const plugin of catalog.filter((row) => row.kind === "common" || row.kind === "role")) {
        const rows = available.filter((row) => row.name === plugin.name);
        const prior = installed.find((row) => row.name === plugin.name && row.marketplace === marketplace.name);
        if (rows.length !== 1 || rows[0]?.version !== undefined && rows[0].version !== plugin.version && rows[0].version !== prior?.version) throw new Error(`Native Marketplace catalog identity conflict for '${plugin.name}@${marketplace.name}'.`);
      }
    }
    const directory = path.isAbsolute(marketplace.source);
    for (const row of installed) {
      if (row.marketplace === marketplace.name && typeof row.cache_path === "string" && typeof row.source === "string" && typeof row.installedFrom === "string") {
        this.targets.set(`${row.name}@${row.marketplace}`, { cachePath: row.cache_path, source: row.source, installedFrom: row.installedFrom });
      }
    }
    for (const plugin of catalog.filter((row) => row.kind === "common" || row.kind === "role")) {
      await ensureSafeTargetChain(plugin.root);
      const sourceFile = path.join(plugin.root, "plugin.json");
      const sourceInfo = await lstat(sourceFile);
      if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.nlink > 1) throw new Error(`Unsafe native Plugin source manifest for '${plugin.name}'.`);
      const manifest = JSON.parse(await readFile(sourceFile, "utf8")) as { name?: unknown; version?: unknown };
      if (manifest.name !== plugin.name || manifest.version !== plugin.version) throw new Error(`Native Plugin source manifest identity conflict for '${plugin.name}'.`);
      const spec = `${plugin.name}@${marketplace.name}`;
      const row = installed.find((candidate) => candidate.name === plugin.name && candidate.marketplace === marketplace.name);
      const target = directory ? plugin.root : nativeInstalledPluginTarget(this.homeDir, marketplace.name, plugin.name);
      await ensureSafeTargetChain(target);
      const observedFrom = directory && typeof row?.installedFrom === "string" && pathsEqual(row.installedFrom, marketplace.source) ? row.installedFrom : marketplace.source;
      const identity = { cachePath: target, source: `${directory ? "live-" : ""}marketplace:${marketplace.name}`, installedFrom: observedFrom };
      if (row && (row.cache_path === undefined || !pathsEqual(row.cache_path, target) || row.source !== identity.source || row.installedFrom !== identity.installedFrom)) throw new Error(`Cannot verify native Plugin source/target for '${spec}'.`);
      if (!directory && !row) {
        let present = false;
        try { present = (await lstat(target)).isDirectory(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (present) {
          const receipt = receipts.find((record) => record.spec === spec);
          const conflict = () => new Error(`Native Plugin target collision for '${spec}'; preserving personal content.`);
          if (!receipt || typeof receipt.cachePath !== "string" || !receipt.cachePath || !pathsEqual(receipt.cachePath, target) || receipt.marketplaceSource !== marketplace.source || receipt.source !== identity.source || receipt.installedFrom !== identity.installedFrom) throw conflict();
          const manifestPath = path.join(target, "plugin.json");
          const info = await lstat(manifestPath);
          if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw conflict();
          if (createHash("sha256").update(await readFile(manifestPath)).digest("hex") !== receipt.manifestHash) throw conflict();
        }
      }
      this.targets.set(spec, identity);
    }
  }

  pluginInstallIdentity(spec: string): { cachePath: string; source?: string; installedFrom?: string } {
    const target = this.targets.get(spec);
    if (!target) throw new Error(`Cannot verify the native Plugin delivery target for '${spec}'; preflight is required.`);
    return target;
  }

  private parseArray<T>(raw: string, label: string): T[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`copilot ${label} did not return valid JSON.\n${raw}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`copilot ${label} returned an unexpected JSON shape.`);
    }
    return parsed as T[];
  }

}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
