import os from "node:os";
import { FallbackCopilotClient } from "../copilot/fallback.js";
import { CopilotClient, CopilotUnavailableError, type CopilotOperations } from "../copilot/cli.js";
import { loadMarketplaceCatalog, type MarketplaceCatalog, type MarketplaceLoadOptions } from "../copilot/catalog.js";
import { executableVersion } from "../utils/process.js";
import { promptText, selectRole } from "../utils/prompt.js";
import { vscodeSettingsPath } from "../copilot/vscode-settings.js";
import { submitGitHubContribution, type GitHubContributionOptions, type GitHubContributionResult } from "../contribution/github.js";

export interface CommandContext {
  cwd: string;
  homeDir: string;
  dryRun: boolean;
  copilot: CopilotOperations;
  copilotMode: "native" | "fallback" | "unavailable";
  vscodeAvailable: () => Promise<boolean>;
  vscodeSettingsPath: string;
  interactive: boolean;
  loadMarketplace: (source: string, cwd: string, options?: MarketplaceLoadOptions) => Promise<MarketplaceCatalog>;
  promptMarketplace: () => Promise<string>;
  promptRole: (roles: string[]) => Promise<string>;
  contributeGitHub: (options: GitHubContributionOptions) => Promise<GitHubContributionResult>;
  now: () => Date;
  out: (message: string) => void;
  err: (message: string) => void;
}

export function createCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  const homeDir = overrides.homeDir ?? os.homedir();
  const dryRun = overrides.dryRun ?? false;
  const loadMarketplace = overrides.loadMarketplace ?? loadMarketplaceCatalog;
  return {
    cwd: overrides.cwd ?? process.cwd(),
    homeDir,
    dryRun,
    copilot: overrides.copilot ?? new CopilotClient(),
    copilotMode: overrides.copilotMode ?? "native",
    vscodeAvailable: overrides.vscodeAvailable ?? (async () => (await executableVersion("code", ["--version"])) !== undefined),
    vscodeSettingsPath: overrides.vscodeSettingsPath ?? vscodeSettingsPath(homeDir),
    interactive: overrides.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY),
    loadMarketplace: (source, cwd, options) => loadMarketplace(source, cwd, {
      ...options,
      homeDir,
      dryRun: options?.dryRun ?? dryRun,
    }),
    promptMarketplace: overrides.promptMarketplace ?? (() => promptText("? Department Marketplace URL: ")),
    promptRole: overrides.promptRole ?? ((roles) => selectRole(roles)),
    contributeGitHub: overrides.contributeGitHub ?? submitGitHubContribution,
    now: overrides.now ?? (() => new Date()),
    out: overrides.out ?? ((message) => console.log(message)),
    err: overrides.err ?? ((message) => console.error(message)),
  };
}

export async function resolveCopilotBackend(context: CommandContext): Promise<void> {
  try {
    await context.copilot.version();
  } catch (error) {
    if (error instanceof CopilotUnavailableError && await context.vscodeAvailable()) {
      context.copilot = new FallbackCopilotClient(context.homeDir, context.now, context.loadMarketplace);
      context.copilotMode = "fallback";
    } else if (error instanceof CopilotUnavailableError) {
      context.copilotMode = "unavailable";
    } else {
      throw error;
    }
  }
}
