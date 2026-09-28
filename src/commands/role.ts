import { readGlobalConfig, writeGlobalConfig } from "../config/global.js";
import type { CatalogPlugin } from "../copilot/catalog.js";
import { convergeUserPlugins, enabledUserPlugins } from "../copilot/plugins.js";
import type { CommandContext } from "./context.js";
import { printActions, printWarnings } from "./helpers.js";

export async function roleListCommand(context: CommandContext): Promise<void> {
  const current = await readGlobalConfig(context.homeDir);
  if (!current) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const { catalog, dispose } = await roleCatalog(context, current.marketplace.source, current.marketplace.name);
  try {
    for (const plugin of catalog.filter((item) => item.kind === "role")) context.out(plugin.name);
  } finally {
    await dispose();
  }
}

export async function roleSetCommand(context: CommandContext, role: string): Promise<void> {
  const current = await readGlobalConfig(context.homeDir);
  if (!current) throw new Error("Team AI is not initialized. Run `teamai init` first.");

  const { catalog, dispose } = await roleCatalog(context, current.marketplace.source, current.marketplace.name);
  try {
    enabledUserPlugins(role, catalog, current.marketplace.name);
    const next = { ...current, role };
    const converged = await convergeUserPlugins(context.copilot, next, catalog, {
      dryRun: context.dryRun,
      cwd: context.cwd,
    });
    printActions(converged.actions, context.dryRun, context.out);
    printWarnings(converged.warnings, context.out);
    next.managedPlugins = converged.managedPlugins;
    if (!context.dryRun) await writeGlobalConfig(next, context.homeDir);
    else context.out("WOULD write: ~/.teamai/config.yaml");
    context.out(`Role: ${role}`);
  } finally {
    await dispose();
  }
}

async function roleCatalog(
  context: CommandContext,
  source: string,
  marketplaceName: string,
): Promise<{ catalog: CatalogPlugin[]; dispose: () => Promise<void> }> {
  const loaded = await context.loadMarketplace(source, context.cwd);
  if (loaded.name !== marketplaceName) {
    await loaded.dispose();
    throw new Error(`Marketplace name changed from '${marketplaceName}' to '${loaded.name}'.`);
  }
  return { catalog: loaded.plugins, dispose: loaded.dispose };
}
