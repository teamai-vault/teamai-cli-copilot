#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCommandContext, resolveCopilotBackend, type CommandContext } from "./commands/context.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { learningPendingCommand, learningRetryCommand, learningShareCommand } from "./commands/learning.js";
import { RecallCommandError, recallCommand } from "./commands/recall.js";
import { RecallInputError } from "./project/recall.js";
import { projectsListCommand, projectsSetCommand } from "./commands/projects.js";
import { roleListCommand, roleSetCommand } from "./commands/role.js";
import { skillInstallCommand, skillListCommand, skillRemoveCommand, skillShowCommand } from "./commands/skill.js";
import { skillContributeCommand } from "./commands/skill-contribute.js";
import { statusCommand } from "./commands/status.js";
import { syncCommand } from "./commands/sync.js";
import { tagsListCommand } from "./commands/tags.js";
import { assertCopilotHomeMatchesOwnership } from "./copilot/builtin-skill.js";
import { copilotHome } from "./copilot/user-state.js";
import { VERSION } from "./version.js";

function usage(): string {
  return [
    "teamai <command> [options]",
    "",
    "Commands:",
    "  init [--marketplace <source>] [--role api|ios|aos|qa|design]",
    "  projects [list|set <ids...>]",
    "  learning share <file> [--project <id>|--shared] [--tags <tag...>]",
    "  learning pending [--json]",
    "  learning retry <id>",
    "  recall <query> [--scope auto|user|workspace] [--project <id>] [--limit <n>] [--include-pending] [--json]",
    "  Example: teamai recall 支付 重试",
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
    "  status [--resources] [--json]",
    "  doctor [--json]",
    "",
    "Global options:",
    "  --dry-run   Preview writes and Copilot mutations",
    "  --help      Show help",
    "  --version   Show version",
  ].join("\n");
}

class UsageError extends Error {}

type OptionRule = { kind: "boolean" | "single" | "many"; choices?: readonly string[] };
type ParsedOptions = Map<string, true | string[]>;
type Invocation = { command: string; subcommand?: string; positionals: string[]; options: ParsedOptions };

const optionRules: Record<string, Record<string, OptionRule>> = {
  init: { "--marketplace": { kind: "single" }, "--role": { kind: "single" } },
  "skill list": {
    "--tag": { kind: "single" },
    "--owner": { kind: "single" },
    "--source": { kind: "single", choices: ["plugin", "standalone"] },
  },
  "skill install": { "--tag": { kind: "single" }, "--yes": { kind: "boolean" } },
  "skill contribute": {
    "--owner": { kind: "single" },
    "--tags": { kind: "many" },
    "--target": { kind: "single", choices: ["standalone", "plugin"] },
    "--plugin": { kind: "single" },
  },
  "learning share": {
    "--project": { kind: "single" },
    "--shared": { kind: "boolean" },
    "--tags": { kind: "many" },
  },
  "learning retry": {},
  recall: {
    "--scope": { kind: "single", choices: ["auto", "user", "workspace"] },
    "--project": { kind: "single" },
    "--limit": { kind: "single" },
    "--include-pending": { kind: "boolean" },
    "--json": { kind: "boolean" },
  },
  status: { "--resources": { kind: "boolean" }, "--json": { kind: "boolean" } },
  doctor: { "--json": { kind: "boolean" } },
  "learning pending": { "--json": { kind: "boolean" } },
};

function parseOptions(tokens: string[], rules: Record<string, OptionRule>, command: string): { positionals: string[]; options: ParsedOptions } {
  const positionals: string[] = [];
  const options: ParsedOptions = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals < 0 ? token : token.slice(0, equals);
    const inlineValue = equals < 0 ? undefined : token.slice(equals + 1);
    const rule = rules[name];
    if (!rule) throw new UsageError(`Unknown option '${name}' for '${command}'.`);
    if (options.has(name)) throw new UsageError(`${name} may be supplied only once.`);
    if (rule.kind === "boolean") {
      if (inlineValue !== undefined) throw new UsageError(`${name} does not take a value.`);
      options.set(name, true);
      continue;
    }

    const values: string[] = [];
    if (inlineValue !== undefined) {
      if (!inlineValue) throw new UsageError(`${name} requires a value.`);
      values.push(inlineValue);
    }
    if (rule.kind === "single") {
      if (values.length === 0) {
        const value = tokens[index + 1];
        if (!value || value.startsWith("-")) throw new UsageError(name + " requires a value.");
        values.push(value);
        index += 1;
      }
    } else {
      while (index + 1 < tokens.length && !tokens[index + 1].startsWith("-")) {
        values.push(tokens[index + 1]);
        index += 1;
      }
      if (values.length === 0) throw new UsageError(`${name} requires a value.`);
    }
    if (rule.choices && !rule.choices.includes(values[0])) {
      throw new UsageError(`${name} must be ${rule.choices.join(" or ")}.`);
    }
    options.set(name, values);
  }
  return { positionals, options };
}

function parseInvocation(argv: string[]): Invocation {
  const dryRunCount = argv.filter((arg) => arg === "--dry-run").length;
  if (dryRunCount > 1) throw new UsageError("--dry-run may be supplied only once.");
  const args = argv.filter((arg) => arg !== "--dry-run");
  if (args.length === 0) return { command: "help", positionals: [], options: new Map() };
  if (args[0] === "help") {
    if (args.length !== 1) throw new UsageError("Use teamai help.");
    return { command: "help", positionals: [], options: new Map() };
  }

  if (args.some((arg) => arg === "--product" || arg.startsWith("--product="))) {
    throw new UsageError(args[0] === "init"
      ? "--product has been removed.\nUse `teamai projects set <ids...>` inside the target Git repository."
      : "--product has been removed. Use --project <id>.");
  }
  if (args[0] === "init" && args.some((arg) => arg === "--project" || arg.startsWith("--project="))) {
    throw new UsageError("--project is not supported by init.\nUse `teamai projects set <ids...>` inside the target Git repository.");
  }

  const command = args[0];
  let subcommand: string | undefined;
  let optionKey = command;
  let optionArgs = args.slice(1);
  if (["role", "skill", "tags", "learning", "projects"].includes(command)) {
    subcommand = args[1];
    if (command === "projects" && subcommand === undefined) subcommand = "list";
    if (command === "projects" && args[1] === undefined) optionArgs = [];
    else optionArgs = args.slice(2);
    optionKey = `${command} ${subcommand ?? ""}`.trim();
  }

  const supported = ["init", "sync", "role list", "role set", "projects list", "projects set", "learning share", "learning pending", "learning retry", "recall", "skill list", "skill show", "skill install", "skill remove", "skill contribute", "tags list", "status", "doctor"];
  if (!supported.includes(optionKey)) throw new UsageError(`Unknown command or subcommand.\n${usage()}`);
  const parsed = parseOptions(optionArgs, optionRules[optionKey] ?? {}, optionKey);
  const positionals = parsed.positionals;
  const exact = (count: number, form: string) => {
    if (positionals.length !== count) throw new UsageError(`Use ${form}.`);
  };
  const atLeast = (count: number, form: string) => {
    if (positionals.length < count) throw new UsageError(`Use ${form}.`);
  };

  switch (optionKey) {
    case "init": exact(0, "teamai init [--marketplace <source>] [--role <role>]"); break;
    case "sync": exact(0, "teamai sync"); break;
    case "role list": exact(0, "teamai role list"); break;
    case "role set": exact(1, "teamai role set <role>"); break;
    case "projects list": exact(0, "teamai projects list"); break;
    case "projects set": break;
    case "learning share":
      exact(1, "teamai learning share <file> [--project <id>|--shared] [--tags <tag...>]");
      if (parsed.options.has("--project") && parsed.options.has("--shared")) throw new UsageError("Use either --project <id> or --shared.");
      break;
    case "learning pending": exact(0, "teamai learning pending [--json]"); break;
    case "learning retry":
      exact(1, "teamai learning retry <id>");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(positionals[0])) {
        throw new UsageError("Learning operation ID must be a UUID.");
      }
      break;
    case "recall": atLeast(1, "teamai recall <query> [--scope auto|user|workspace] [--project <id>] [--limit <n>] [--include-pending] [--json]"); break;
    case "skill list": exact(0, "teamai skill list [--tag <tag>] [--owner <owner>] [--source plugin|standalone]"); break;
    case "skill show": exact(1, "teamai skill show <name>"); break;
    case "skill install": {
      const hasTag = parsed.options.has("--tag");
      if ((positionals.length === 0) === !hasTag) throw new UsageError("Use teamai skill install <name...> or teamai skill install --tag <tag>.");
      break;
    }
    case "skill remove": atLeast(1, "teamai skill remove <name...>"); break;
    case "skill contribute":
      exact(1, "teamai skill contribute <path> --owner <owner> --target standalone|plugin [--plugin <plugin>]");
      if (!parsed.options.has("--owner") || !parsed.options.has("--target")) {
        throw new UsageError("skill contribute requires one --owner and one --target.");
      }
      if (option(parsed.options, "--target") === "plugin" && !parsed.options.has("--plugin")) {
        throw new UsageError("--target plugin requires --plugin <name>.");
      }
      if (option(parsed.options, "--target") === "standalone" && parsed.options.has("--plugin")) {
        throw new UsageError("--plugin is only valid with --target plugin.");
      }
      break;
    case "tags list": exact(0, "teamai tags list"); break;
    case "status": exact(0, "teamai status [--resources] [--json]"); break;
    case "doctor": exact(0, "teamai doctor [--json]"); break;
  }

  return { command, subcommand, positionals, options: parsed.options };
}

function option(options: ParsedOptions, name: string): string | undefined {
  const value = options.get(name);
  return Array.isArray(value) ? value[0] : undefined;
}

function optionValues(options: ParsedOptions, name: string): string[] {
  const value = options.get(name);
  return Array.isArray(value) ? value : [];
}

function hasOption(options: ParsedOptions, name: string): boolean {
  return options.has(name);
}

function usesCopilotRoot(invocation: Invocation): boolean {
  return ["init", "sync", "status", "doctor"].includes(invocation.command) ||
    (invocation.command === "role" && invocation.subcommand === "set") ||
    (invocation.command === "skill" && ["list", "show", "install", "remove"].includes(invocation.subcommand ?? ""));
}

function needsCopilotBackend(invocation: Invocation): boolean {
  return ["init", "sync"].includes(invocation.command) ||
    (invocation.command === "role" && invocation.subcommand === "set") ||
    (invocation.command === "skill" && ["list", "show", "install", "remove"].includes(invocation.subcommand ?? ""));
}

function requestsLearningPendingJson(argv: string[]): boolean {
  const args = argv.filter((argument) => argument !== "--dry-run");
  return args[0] === "learning" && args[1] === "pending" &&
    args.some((argument) => argument === "--json" || argument.startsWith("--json="));
}

function requestsRecallJson(argv: string[]): boolean {
  const args = argv.filter((argument) => argument !== "--dry-run");
  return args[0] === "recall" && args.some((argument) => argument === "--json" || argument.startsWith("--json="));
}

export async function runCli(argv: string[], overrides: Partial<CommandContext> = {}): Promise<number> {
  const dryRun = argv.includes("--dry-run");
  const jsonLearningPending = requestsLearningPendingJson(argv);
  const jsonRecall = requestsRecallJson(argv);
  const context = createCommandContext({ ...overrides, dryRun });
  if (argv.length === 0) {
    context.out(usage());
    return 0;
  }

  try {
    if (argv.filter((arg) => arg === "--help").length > 1) throw new UsageError("--help may be supplied only once.");
    if (argv.filter((arg) => arg === "--version").length > 1) throw new UsageError("--version may be supplied only once.");
    const showHelp = argv.includes("--help") || argv[0] === "help";
    const showVersion = argv.includes("--version");
    const parseArgs = argv.filter((arg) => arg !== "--help" && arg !== "--version");
    const invocation = parseInvocation(parseArgs);
    if (showHelp) {
      context.out(usage());
      return 0;
    }
    if (showVersion) {
      context.out(VERSION);
      return 0;
    }
    if (invocation.command === "help") {
      context.out(usage());
      return 0;
    }
    if (usesCopilotRoot(invocation)) {
      copilotHome(context.homeDir);
      await assertCopilotHomeMatchesOwnership(context.homeDir);
    }
    if (needsCopilotBackend(invocation)) await resolveCopilotBackend(context);

    switch (invocation.command) {
      case "init":
        await initCommand(context, { marketplace: option(invocation.options, "--marketplace"), role: option(invocation.options, "--role") });
        return 0;
      case "sync":
        await syncCommand(context);
        return 0;
      case "recall":
        await recallCommand(context, {
          query: invocation.positionals.join(" "),
          scope: option(invocation.options, "--scope") as "auto" | "user" | "workspace" | undefined,
          project: option(invocation.options, "--project"),
          limit: option(invocation.options, "--limit"),
          includePending: hasOption(invocation.options, "--include-pending"),
          json: hasOption(invocation.options, "--json"),
        });
        return 0;
      case "role":
        if (invocation.subcommand === "list") await roleListCommand(context);
        else await roleSetCommand(context, invocation.positionals[0]);
        return 0;
      case "projects":
        if (invocation.subcommand === "set") await projectsSetCommand(context, invocation.positionals);
        else await projectsListCommand(context);
        return 0;
      case "skill":
        switch (invocation.subcommand) {
          case "list":
            await skillListCommand(context, { tag: option(invocation.options, "--tag"), owner: option(invocation.options, "--owner"), source: option(invocation.options, "--source") });
            break;
          case "show":
            await skillShowCommand(context, invocation.positionals[0]);
            break;
          case "install":
            await skillInstallCommand(context, invocation.positionals, option(invocation.options, "--tag"), hasOption(invocation.options, "--yes"));
            break;
          case "remove":
            await skillRemoveCommand(context, invocation.positionals);
            break;
          case "contribute":
            await skillContributeCommand(context, {
              path: invocation.positionals[0],
              owner: option(invocation.options, "--owner")!,
              tags: optionValues(invocation.options, "--tags"),
              target: option(invocation.options, "--target") as "standalone" | "plugin",
              plugin: option(invocation.options, "--plugin"),
            });
            break;
        }
        return 0;
      case "tags":
        await tagsListCommand(context);
        return 0;
      case "learning":
        if (invocation.subcommand === "pending") await learningPendingCommand(context, hasOption(invocation.options, "--json"));
        else if (invocation.subcommand === "retry") await learningRetryCommand(context, invocation.positionals[0]);
        else await learningShareCommand(context, {
          file: invocation.positionals[0],
          project: option(invocation.options, "--project"),
          shared: hasOption(invocation.options, "--shared"),
          tags: optionValues(invocation.options, "--tags"),
        });
        return 0;
      case "status":
        await statusCommand(context, { resources: hasOption(invocation.options, "--resources"), json: hasOption(invocation.options, "--json") });
        return 0;
      case "doctor": {
        const result = await doctorCommand(context, hasOption(invocation.options, "--json"));
        return result.errors > 0 ? 1 : 0;
      }
      default:
        throw new UsageError(`Unknown command '${invocation.command}'.\n${usage()}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const command = argv.find((arg) => arg !== "--dry-run" && arg !== "--help");
    const jsonOutput = argv.includes("--json") && (command === "status" || command === "doctor");
    if (jsonRecall) {
      const usageError = error instanceof UsageError || error instanceof RecallInputError;
      const code = usageError ? "INVALID_ARGUMENT" : error instanceof RecallCommandError ? error.code : "RECALL_FAILED";
      context.out(JSON.stringify({ schemaVersion: 1, error: { code, message } }));
    } else if (jsonLearningPending) {
      const code = error instanceof UsageError ? "INVALID_ARGUMENT" : "LEARNING_PENDING_FAILED";
      context.out(JSON.stringify({ schemaVersion: 1, error: { code, message } }));
    } else if (jsonOutput) {
      context.out(JSON.stringify({
        schemaVersion: 1,
        error: {
          code: error instanceof UsageError ? "USAGE_ERROR" : "COMMAND_ERROR",
          message,
        },
      }));
    } else context.err(`ERROR: ${message}`);
    return error instanceof UsageError || error instanceof RecallInputError ? 2 : 1;
  }
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  process.exitCode = await runCli(process.argv.slice(2));
}
