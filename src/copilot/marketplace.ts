import path from "node:path";
import type { MarketplaceConfig } from "../config/schema.js";
import type { CopilotOperations, MarketplaceRow } from "./cli.js";

export function normalizeMarketplaceSource(source: string, cwd: string): string {
  if (/^[A-Za-z]:[\\/]/.test(source) || source.startsWith("/") || source.startsWith("./") || source.startsWith("../") || source.startsWith(".\\") || source.startsWith("..\\")) {
    return path.resolve(cwd, source);
  }
  return source;
}

export function marketplaceRowMatchesSource(row: MarketplaceRow, source: string): boolean {
  if (typeof row.source !== "string") return false;
  const registered = row.source.replace(/^(?:GitHub|URL|Local|Directory):\s*/, "");
  if (process.platform === "win32" && (/^[A-Za-z]:[\\/]/.test(source) || /^[A-Za-z]:[\\/]/.test(registered))) {
    return path.normalize(registered).toLowerCase() === path.normalize(source).toLowerCase();
  }
  return registered === source;
}

export async function resolveMarketplaceConfig(
  client: CopilotOperations,
  source: string,
  marketplaceName: string,
  options: { cwd: string; dryRun?: boolean },
): Promise<{ config: MarketplaceConfig; added: boolean }> {
  const before = await client.listMarketplaces(options.cwd);
  const existing = before.filter((item) => marketplaceRowMatchesSource(item, source));
  if (existing.length === 1) {
    if (existing[0].name !== marketplaceName) {
      throw new Error(`Marketplace source '${source}' is registered as '${existing[0].name}', not '${marketplaceName}'.`);
    }
    return { config: { name: marketplaceName, source }, added: false };
  }
  if (existing.length > 1) {
    throw new Error(`Marketplace source '${source}' matches multiple existing Copilot registrations.`);
  }
  if (before.some((item) => item.name === marketplaceName)) {
    throw new Error(`Marketplace name '${marketplaceName}' is already registered from a different source.`);
  }
  if (options.dryRun) return { config: { name: marketplaceName, source }, added: true };

  await client.addMarketplace(source, options.cwd);
  const after = await client.listMarketplaces(options.cwd);
  if (!after.some((item) => item.name === marketplaceName && marketplaceRowMatchesSource(item, source))) {
    throw new Error(`Marketplace '${marketplaceName}' was not visible after registering '${source}'.`);
  }
  return { config: { name: marketplaceName, source }, added: true };
}
