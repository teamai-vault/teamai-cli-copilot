#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCommandContext, resolveCopilotBackend, type CommandContext } from "./commands/context.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { learningShareCommand } from "./commands/learning.js";
import { projectsListCommand, projectsSetCommand } from "./commands/projects.js";
import { roleListCommand, roleSetCommand } from "./commands/role.js";
import { skillInstallCommand, skillListCommand, skillRemoveCommand, skillShowCommand } from "./commands/skill.js";
import { skillContributeCommand } from "./commands/skill-contribute.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { tagsListCommand } from "./commands/tags.js";

const VERSION = "0.3.0";

function usage(): string {
  return [
    "teamai <command> [options]",
    "",
    "Commands:",
    "  init [--marketplace <source>] [--role api|ios|aos|qa|design]",
    "  projects [list|set <ids...>]",
    "  learning share <file> [--project <id>|--shared] [--tags <tag...>]",
    "  sync",
    "  role list",
    "  role set <role>",
    "  skill list [--tag <tag>] [--owner <owner>] [--source plugin|standalone]",
    "  skill show <name>",
    "  skill install <name...> [--yes]",
    "  skill install --tag <tag> [--yes]",
    "  skill remove <name...>",
    "  skill contribute <path> --owner <owner> [--tags <tag...>] --target standalone|plugin [--plugin <plugin>]",
    "  tags list",
    "  status",
    "  doctor",
    "",
    "Global options:",
    "  --dry-run   Preview writes and Copilot mutations",
    "  --help      Show help",
    "  --version   Show version",
  ].join("\n");
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function optionValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

function trailingOptionValues(args: string[], name: string): string[] {
  const index = args.indexOf(name);
  if (index < 0) return [];
  const values: string[] = [];
  for (let cursor = index + 1; cursor < args.length && !args[cursor].startsWith("--"); cursor += 1) values.push(args[cursor]);
  if (values.length === 0) throw new Error(`${name} requires a value.`);
  return values;
}

export async function runCli(argv: string[], overrides: Partial<CommandContext> = {}): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const args = argv.filter((arg) => arg !== "--dry-run");
  const context = createCommandContext({ ...overrides, dryRun });

  if (args.length === 0 || args.includes("--help") || args[0] === "help") {
    context.out(usage());
    return 0;
  }
  if (args.includes("--version")) {
    context.out(VERSION);
    return 0;
  }

  try {
    if (args.includes("--product") || args.some((arg) => arg.startsWith("--product="))) {
      throw new Error(args[0] === "init"
        ? "--product has been removed.\nUse `teamai projects set <ids...>` inside the target Git repository."
        : "--product has been removed. Use --project <id>.");
    }
    if (args[0] === "init" && args.some((arg) => arg === "--project" || arg.startsWith("--project="))) {
      throw new Error("--project is not supported by init.\nUse `teamai projects set <ids...>` inside the target Git repository.");
    }
    await resolveCopilotBackend(context);
    switch (args[0]) {
      case "init":
        await initCommand(context, {
          marketplace: optionValue(args, "--marketplace"),
          role: optionValue(args, "--role"),
        });
        return 0;
      case "sync":
        await syncCommand(context);
        return 0;
      case "role":
        if (args[1] === "list") {
          await roleListCommand(context);
          return 0;
        }
        if (args[1] === "set" && args[2]) {
          await roleSetCommand(context, args[2]);
          return 0;
        }
        throw new Error("Use `teamai role list` or `teamai role set <role>`. ");
      case "projects":
        if (args.length === 1 || args[1] === "list") {
          await projectsListCommand(context);
          return 0;
        }
        if (args[1] === "set") {
          await projectsSetCommand(context, args.slice(2));
          return 0;
        }
        throw new Error("Use `teamai projects [list]` or `teamai projects set <ids...>`. ");
      case "skill":
        if (args[1] === "list") {
          await skillListCommand(context, { tag: optionValue(args, "--tag"), owner: optionValue(args, "--owner"), source: optionValue(args, "--source") });
          return 0;
        }
        if (args[1] === "show" && args[2]) {
          await skillShowCommand(context, args[2]);
          return 0;
        }
        if (args[1] === "install") {
          const tag = optionValue(args, "--tag");
          const names = args.slice(2).filter((arg, index, values) => arg !== "--tag" && arg !== "--yes" && values[index - 1] !== "--tag");
          await skillInstallCommand(context, names, tag, args.includes("--yes"));
          return 0;
        }
        if (args[1] === "remove") {
          await skillRemoveCommand(context, args.slice(2));
          return 0;
        }
        if (args[1] === "contribute" && args[2] && !args[2].startsWith("--")) {
          const owners = optionValues(args, "--owner");
          const targets = optionValues(args, "--target");
          const plugins = optionValues(args, "--plugin");
          if (owners.length !== 1 || targets.length !== 1 || plugins.length > 1) {
            throw new Error("skill contribute requires one --owner and one --target; --plugin may be supplied once.");
          }
          if (targets[0] !== "standalone" && targets[0] !== "plugin") throw new Error("--target must be standalone or plugin.");
          await skillContributeCommand(context, {
            path: args[2],
            owner: owners[0],
            tags: trailingOptionValues(args, "--tags"),
            target: targets[0],
            plugin: plugins[0],
          });
          return 0;
        }
        throw new Error("Use `teamai skill list`, `show`, `install`, `remove`, or `contribute`.");
      case "tags":
        if (args[1] === "list") {
          await tagsListCommand(context);
          return 0;
        }
        throw new Error("Use `teamai tags list`.");
      case "learning":
        if (args[1] === "share" && args[2] && !args[2].startsWith("--")) {
          const projects = optionValues(args, "--project");
          if (projects.length > 1) throw new Error("--project may be supplied once.");
          await learningShareCommand(context, {
            file: args[2],
            project: projects[0],
            shared: args.includes("--shared"),
            tags: trailingOptionValues(args, "--tags"),
          });
          return 0;
        }
        throw new Error("Use `teamai learning share <file> [--project <id>|--shared] [--tags <tag...>]`.");
      case "status":
        await statusCommand(context);
        return 0;
      case "doctor": {
        const result = await doctorCommand(context);
        return result.errors > 0 ? 1 : 0;
      }
      default:
        throw new Error(`Unknown command '${args[0]}'.\n${usage()}`);
    }
  } catch (error) {
    context.err(`ERROR: ${(error as Error).message}`);
    return 1;
  }
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
