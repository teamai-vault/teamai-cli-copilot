import { runProcess, type ProcessResult } from "../utils/process.js";
import os from "node:os";
import { normalizeLivePluginInventory } from "./user-state.js";

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

export interface NativeMcpServer {
  name: string;
  [key: string]: unknown;
}

interface PluginListResult<T> {
  plugins: T[];
  errors?: unknown[];
}

export interface CopilotOperations {
  version(): Promise<string>;
  listPlugins(cwd?: string): Promise<InstalledPlugin[]>;
  listMcpServers(cwd?: string): Promise<{ servers: NativeMcpServer[]; errors: string[] }>;
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
}

export class CopilotUnavailableError extends Error {}

export class CopilotClient implements CopilotOperations {
  constructor(
    private readonly executable = "copilot",
    private readonly prefixArgs: string[] = [],
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
      throw new Error(`copilot ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
    }
    return result;
  }

  async version(): Promise<string> {
    const result = await this.exec(["--version"]);
    return result.stdout.trim() || result.stderr.trim();
  }

  async listPlugins(cwd?: string): Promise<InstalledPlugin[]> {
    const parsed = this.parseObject<PluginListResult<InstalledPlugin>>(
      (await this.exec(["plugins", "list", "--kind", "plugin", "--json"], cwd)).stdout,
      "plugins list",
    );
    if (!Array.isArray(parsed.plugins)) {
      throw new Error("copilot plugins list returned an unexpected JSON shape.");
    }
    return await normalizeLivePluginInventory(parsed.plugins.map((plugin) => ({
      ...plugin,
      marketplace: plugin.marketplace ?? marketplaceFromSource(plugin.source),
    })), os.homedir());
  }

  async listMcpServers(cwd?: string): Promise<{ servers: NativeMcpServer[]; errors: string[] }> {
    const parsed = this.parseObject<PluginListResult<NativeMcpServer>>(
      (await this.exec(["plugins", "list", "--kind", "mcp", "--json"], cwd)).stdout,
      "plugins list --kind mcp",
    );
    if (!Array.isArray(parsed.plugins) || parsed.plugins.some((server) => !server || typeof server.name !== "string")) {
      throw new Error("copilot plugins list --kind mcp returned an unexpected JSON shape.");
    }
    return {
      servers: parsed.plugins,
      errors: (parsed.errors ?? []).map(formatInspectionError),
    };
  }

  async listMarketplaces(cwd?: string): Promise<MarketplaceRow[]> {
    return this.parseArray<MarketplaceRow>(
      (await this.exec(["plugins", "marketplace", "list", "--json"], cwd)).stdout,
      "plugins marketplace list",
    );
  }

  async browseMarketplace(name: string, cwd?: string): Promise<MarketplacePluginRow[]> {
    return this.parseArray<MarketplacePluginRow>(
      (await this.exec(["plugins", "marketplace", "browse", name, "--json"], cwd)).stdout,
      "plugins marketplace browse",
    );
  }

  async addMarketplace(source: string, cwd?: string): Promise<void> {
    await this.exec(["plugins", "marketplace", "add", source], cwd);
  }

  async removeMarketplace(name: string, cwd?: string): Promise<void> {
    await this.exec(["plugins", "marketplace", "remove", name], cwd);
  }

  async installPlugin(spec: string, cwd?: string): Promise<void> {
    await this.exec(["plugins", "install", spec], cwd);
  }

  async enablePlugin(spec: string, cwd?: string): Promise<void> {
    await this.exec(["plugins", "enable", spec], cwd);
  }

  async disablePlugin(spec: string, cwd?: string): Promise<void> {
    await this.exec(["plugins", "disable", spec], cwd);
  }

  async updatePlugin(spec: string, cwd?: string): Promise<void> {
    await this.exec(["plugins", "update", spec], cwd);
  }

  private parseArray<T>(raw: string, label: string): T[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`copilot ${label} did not return valid JSON.`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`copilot ${label} returned an unexpected JSON shape.`);
    }
    return parsed as T[];
  }

  private parseObject<T extends object>(raw: string, label: string): T {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`copilot ${label} did not return valid JSON.`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`copilot ${label} returned an unexpected JSON shape.`);
    }
    return parsed as T;
  }
}

function marketplaceFromSource(source: unknown): string | undefined {
  if (typeof source !== "string") return undefined;
  const match = source.match(/^(?:live-)?marketplace:(.+)$/);
  return match?.[1];
}

function formatInspectionError(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return JSON.stringify(error);
}
