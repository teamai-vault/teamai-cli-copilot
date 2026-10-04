import { lstat } from "node:fs/promises";
import path from "node:path";
import { readGlobalConfig, writeGlobalConfig } from "../config/global.js";
import type { TeamAiConfig } from "../config/schema.js";
import type { MarketplaceCatalog } from "../copilot/catalog.js";
import { convergeManagedSkills, effectiveEnabledPluginSpecs, materializedEnabledPluginSkillNames, personalSkillPath, userScopePluginInventory } from "../copilot/skills.js";
import { promptText } from "../utils/prompt.js";
import { withNativeUserDeliveryLock, type CommandContext } from "./context.js";

export async function skillListCommand(context: CommandContext, options: { tag?: string; owner?: string; source?: string }): Promise<void> {
  const { config, catalog } = await configuredCatalog(context);
  try {
    if (options.source && options.source !== "plugin" && options.source !== "standalone") throw new Error("--source must be plugin or standalone.");
    const available = await pluginSkillAvailability(context, catalog);
    for (const skill of catalog.skills.filter((skill) =>
      (!options.tag || skill.tags.includes(options.tag)) &&
      (!options.owner || skill.owner === options.owner) &&
      (!options.source || skill.sourceType === options.source),
    )) {
      context.out(`${skill.name}\t${skill.sourceType === "plugin" ? `plugin:${skill.plugin}` : "standalone"}\t${skill.owner}\t${skill.tags.join(",")}\t${await localStatus(config, context.homeDir, skill.name, available.materializedPluginSkills.has(skill.name))}`);
    }
  } finally {
    await catalog.dispose();
  }
}

export async function skillShowCommand(context: CommandContext, name: string): Promise<void> {
  const { config, catalog } = await configuredCatalog(context);
  try {
    const skill = catalog.skills.find((candidate) => candidate.name === name);
    if (!skill) throw new Error(`Unknown skill '${name}'.`);
    context.out(`Name: ${skill.name}`);
    context.out(`Description: ${skill.description}`);
    context.out(`Owner: ${skill.owner}`);
    context.out(`Tags: ${skill.tags.join(", ") || "none"}`);
    context.out(`Source: ${skill.sourceType === "plugin" ? `plugin:${skill.plugin}` : "standalone"}`);
    context.out(`Containing plugin: ${skill.plugin ?? "none"}`);
    context.out(`Source path: ${skill.sourcePath}`);
    const available = await pluginSkillAvailability(context, catalog);
    context.out(`Local status: ${await localStatus(config, context.homeDir, skill.name, available.materializedPluginSkills.has(skill.name))}`);
    context.out(`Managed personal path: ${config.managedSkillPaths?.[skill.name] ?? "none"}`);
  } finally {
    await catalog.dispose();
  }
}

export async function skillInstallCommand(context: CommandContext, names: string[], tag?: string, yes = false): Promise<void> {
  const { config, catalog } = await configuredCatalog(context);
  try {
    if ((names.length === 0) === !tag) throw new Error("Use skill install <name...> or skill install --tag <tag>.");
    const selected = tag ? catalog.skills.filter((skill) => skill.tags.includes(tag)).map((skill) => skill.name) : [...new Set(names)];
    if (selected.length === 0) throw new Error(tag ? `No skills match tag '${tag}'.` : "Select at least one skill.");
    for (const name of selected) if (!catalog.skills.some((skill) => skill.name === name)) throw new Error(`Unknown skill '${name}'.`);
    context.out(`Selected skills: ${selected.join(", ")}`);
    if (tag && !yes && !context.dryRun) {
      if (!context.interactive) throw new Error("Use --yes to install selected skills non-interactively.");
      if ((await promptText("? Install selected skills? [y/N]: ")).toLowerCase() !== "y") throw new Error("Skill installation cancelled.");
    }
    const next: TeamAiConfig = { ...config, managedSkills: [...new Set([...(config.managedSkills ?? []), ...selected])].sort() };
    const preflight = async () => {
      const availability = await pluginSkillAvailability(context, catalog);
      await convergeManagedSkills(next, catalog.skills, availability.enabledPlugins, context.homeDir, { dryRun: true, materializedPluginSkills: availability.materializedPluginSkills });
    };
    await withNativeUserDeliveryLock(context, preflight, async () => {
      const availability = await pluginSkillAvailability(context, catalog);
      const result = await convergeManagedSkills(next, catalog.skills, availability.enabledPlugins, context.homeDir, {
        dryRun: context.dryRun,
        materializedPluginSkills: availability.materializedPluginSkills,
      });
      next.managedSkillPaths = result.managedSkillPaths;
      printChanges(result.changes, context);
      for (const name of result.available) context.out(`AVAILABLE via plugin: ${name}`);
      if (context.dryRun) context.out("WOULD write: ~/.teamai/config.yaml");
      else await writeGlobalConfig(next, context.homeDir);
    });
  } finally {
    await catalog.dispose();
  }
}

export async function skillRemoveCommand(context: CommandContext, names: string[]): Promise<void> {
  const { config, catalog } = await configuredCatalog(context);
  try {
    if (names.length === 0) throw new Error("Use skill remove <name...>.");
    const selected = [...new Set(names)];
    for (const name of selected) if (!catalog.skills.some((skill) => skill.name === name) && !config.managedSkills?.includes(name) && !config.managedSkillPaths?.[name]) throw new Error(`Unknown skill '${name}'.`);
    const next: TeamAiConfig = { ...config, managedSkills: (config.managedSkills ?? []).filter((name) => !selected.includes(name)) };
    const preflight = async () => {
      const availability = await pluginSkillAvailability(context, catalog);
      await convergeManagedSkills(next, catalog.skills, availability.enabledPlugins, context.homeDir, { dryRun: true, materializedPluginSkills: availability.materializedPluginSkills });
    };
    await withNativeUserDeliveryLock(context, preflight, async () => {
      const availability = await pluginSkillAvailability(context, catalog);
      const result = await convergeManagedSkills(next, catalog.skills, availability.enabledPlugins, context.homeDir, {
        dryRun: context.dryRun,
        materializedPluginSkills: availability.materializedPluginSkills,
      });
      next.managedSkillPaths = result.managedSkillPaths;
      printChanges(result.changes, context);
      if (context.dryRun) context.out("WOULD write: ~/.teamai/config.yaml");
      else await writeGlobalConfig(next, context.homeDir);
    });
  } finally {
    await catalog.dispose();
  }
}

async function configuredCatalog(context: CommandContext): Promise<{ config: TeamAiConfig; catalog: MarketplaceCatalog }> {
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
  if (catalog.name !== config.marketplace.name) {
    await catalog.dispose();
    throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
  }
  return { config, catalog };
}

async function pluginSkillAvailability(context: CommandContext, catalog: MarketplaceCatalog): Promise<{
  enabledPlugins: Set<string>;
  materializedPluginSkills: Set<string>;
}> {
  const installed = await userScopePluginInventory(await context.copilot.listPlugins(context.cwd), context.homeDir);
  return {
    enabledPlugins: effectiveEnabledPluginSpecs(installed),
    materializedPluginSkills: await materializedEnabledPluginSkillNames(installed, catalog.skills, catalog.name),
  };
}

async function localStatus(config: TeamAiConfig, homeDir: string, name: string, available: boolean): Promise<string> {
  const target = config.managedSkillPaths?.[name];
  if (target) {
    try {
      if ((await lstat(target)).isDirectory()) return "managed personal";
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return "managed personal missing";
  }
  try {
    if ((await lstat(path.join(personalSkillPath(homeDir, name), "SKILL.md"))).isFile()) return "unmanaged personal";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (available) return "available via plugin";
  return config.managedSkills?.includes(name) ? "selected" : "not installed";
}

function printChanges(changes: Awaited<ReturnType<typeof convergeManagedSkills>>["changes"], context: CommandContext): void {
  for (const change of changes) context.out(`${context.dryRun ? "WOULD" : "DONE"} ${change.type}: ${change.name}`);
}
