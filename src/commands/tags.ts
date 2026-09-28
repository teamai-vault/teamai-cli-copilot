import { readGlobalConfig } from "../config/global.js";
import type { CommandContext } from "./context.js";

export async function tagsListCommand(context: CommandContext): Promise<void> {
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
  try {
    if (catalog.name !== config.marketplace.name) throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
    const counts = new Map<string, number>();
    for (const skill of catalog.skills) for (const tag of skill.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    for (const [tag, count] of [...counts].sort(([left], [right]) => left.localeCompare(right))) context.out(`${tag}\t${count}`);
  } finally {
    await catalog.dispose();
  }
}
