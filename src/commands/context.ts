import os from "node:os";
import { FallbackCopilotClient } from "../copilot/fallback.js";
import { CopilotClient, CopilotUnavailableError, type CopilotOperations } from "../copilot/cli.js";
import { loadMarketplaceCatalog, type MarketplaceCatalog, type MarketplaceLoadOptions } from "../copilot/catalog.js";
import { executableVersion } from "../utils/process.js";
import { promptText, selectRole } from "../utils/prompt.js";
import { vscodeSettingsPath } from "../copilot/vscode-settings.js";
import { submitGitHubContribution, type GitHubContributionOptions, type GitHubContributionResult } from "../contribution/github.js";
import { convergeUserPlugins } from "../copilot/plugins.js";
import type { TeamAiConfig } from "../config/schema.js";
import path from "node:path";
import { withFileLock } from "../utils/fs.js";
import { copilotHome, readCopilotState } from "../copilot/user-state.js";
import { ensureSafeTargetChain } from "../copilot/user-instructions.js";

export interface CommandContext {
  cwd: string;
  homeDir: string;
  dryRun: boolean;
  copilot: CopilotOperations;
  copilotMode: "native" | "fallback" | "unavailable";
  copilotRuntime?: string;
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
    copilot: overrides.copilot ?? new CopilotClient("copilot", [], homeDir, overrides.err ?? ((text) => process.stderr.write(text))),
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
    context.copilotRuntime = await context.copilot.version();
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
  if (context.copilotMode === "native") await preflightCopilotContract(context);
}

export async function preflightCopilotContract(context: CommandContext): Promise<void> {
  if (context.copilotMode !== "native") return;
  await readCopilotState(context.homeDir);
  await context.copilot.listMarketplaces(context.cwd);
  await context.copilot.listPlugins(context.cwd);
}

export async function preflightUserPluginDelivery(context: CommandContext, config: TeamAiConfig, catalog: MarketplaceCatalog): Promise<void> {
  if (context.copilotMode !== "native") return;
  await convergeUserPlugins(context.copilot, config, catalog.plugins, { dryRun: true, cwd: context.cwd, resourceRevision: catalog.revision });
}

/** Validate before lock creation and repeat under the shared native user-delivery lock. */
export async function withNativeUserDeliveryLock<T>(context: CommandContext, preflight: () => Promise<void>, deliver: () => Promise<T>, pluginMutations = false): Promise<T> {
  await preflight();
  if (context.copilotMode !== "native" || context.dryRun) return await deliver();
  const root = copilotHome(context.homeDir);
  await ensureSafeTargetChain(root);
  return await withFileLock(path.join(root, ".teamai.lock"), async () => {
    await preflightCopilotContract(context);
    if (pluginMutations) await context.copilot.validatePluginCommands?.(context.cwd);
    await preflight();
    return await deliver();
  });
}
