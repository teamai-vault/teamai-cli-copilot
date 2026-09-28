#!/usr/bin/env node

import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const TEXT_EXTENSIONS = new Set([".json", ".md", ".mjs", ".js", ".ts", ".txt", ".yaml", ".yml"]);
const EXCLUDED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage"]);

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (["--to", "--from", "--display-name", "--marketplace-repo"].includes(arg)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      options[arg.slice(2).replaceAll("-", "_")] = value;
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return `Rename the logical Copilot Marketplace ID inside one Marketplace repository.

Usage:
  npm run rename:marketplace -- --to <new-id> [options]

Options:
  --to <id>                 Required new Marketplace ID.
  --from <id>               Optional safety guard; must match the manifest's current ID.
  --display-name <name>     Optional marketplace owner display name.
  --marketplace-repo <path> Marketplace repository path. Default: sibling ../teamai-marketplace.
  --dry-run                 Preview changes without writing.
  --help                    Show this help.

Safety:
  The tool renames only standalone Marketplace identity tokens. It deliberately does NOT rename
  repository/package identities such as teamai-vault or teamai-marketplace. The Team AI CLI is
  intentionally independent from any department Marketplace and is not modified by this tool.`;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function marketplaceTokenPattern(value) {
  return new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(value)}(?![A-Za-z0-9_-])`, "g");
}

async function collectTextFiles(root) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRECTORIES.has(entry.name)) await visit(path.join(current, entry.name));
        continue;
      }
      if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.join(current, entry.name));
      }
    }
  }
  await visit(root);
  return files;
}

function countMatches(contents, pattern) {
  return [...contents.matchAll(pattern)].length;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  if (!options.to) throw new Error("--to <new-id> is required.\n\n" + usage());
  if (!NAME_PATTERN.test(options.to)) {
    throw new Error(`Invalid Marketplace ID '${options.to}'. Use lowercase Agent Plugin-compatible naming.`);
  }

  const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const marketplaceRoot = path.resolve(options.marketplace_repo ?? path.join(scriptRoot, "..", "teamai-marketplace"));
  const manifestPath = path.join(marketplaceRoot, ".github", "plugin", "marketplace.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const currentName = manifest.name;

  if (typeof currentName !== "string" || !currentName) {
    throw new Error(`${manifestPath} does not contain a valid marketplace name.`);
  }
  if (options.from && options.from !== currentName) {
    throw new Error(`--from '${options.from}' does not match the manifest Marketplace ID '${currentName}'.`);
  }
  if (currentName === options.to && !options.display_name) {
    console.log(`Marketplace ID is already '${currentName}'. Nothing to change.`);
    return;
  }

  manifest.name = options.to;
  if (options.display_name) {
    manifest.owner ??= {};
    manifest.owner.name = options.display_name;
  }

  const manifestReplacement = `${JSON.stringify(manifest, null, 2)}\n`;
  const files = await collectTextFiles(marketplaceRoot);
  const oldPattern = marketplaceTokenPattern(currentName);
  const planned = [];

  for (const file of files) {
    const original = await readFile(file, "utf8");
    const source = path.resolve(file) === path.resolve(manifestPath) ? manifestReplacement : original;
    const replacements = countMatches(source, oldPattern);
    const updated = source.replace(oldPattern, options.to);
    if (updated !== original) planned.push({ file, updated, replacements });
  }

  console.log(`Marketplace ID: ${currentName} -> ${options.to}`);
  if (options.display_name) console.log(`Owner display name -> ${options.display_name}`);
  console.log(`Marketplace repo: ${marketplaceRoot}`);
  console.log(`${options.dryRun ? "Would update" : "Updating"} ${planned.length} file(s):`);
  for (const item of planned) {
    console.log(`  ${path.relative(marketplaceRoot, item.file)} (${item.replacements} token replacement${item.replacements === 1 ? "" : "s"})`);
  }

  if (!options.dryRun) {
    for (const item of planned) await writeFile(item.file, item.updated, "utf8");
  }

  const plannedByFile = new Map(planned.map((item) => [item.file, item.updated]));
  const residuals = [];
  for (const file of files) {
    const contents = options.dryRun ? plannedByFile.get(file) ?? await readFile(file, "utf8") : await readFile(file, "utf8");
    const count = countMatches(contents, marketplaceTokenPattern(currentName));
    if (count > 0) residuals.push({ file, count });
  }

  if (residuals.length > 0) {
    console.error(`Old Marketplace ID '${currentName}' still appears as a standalone token:`);
    for (const item of residuals) console.error(`  ${item.file}: ${item.count}`);
    process.exitCode = 1;
    return;
  }

  console.log(options.dryRun
    ? "Dry-run verification passed: no standalone old-ID tokens would remain."
    : "Rename complete: no standalone old-ID tokens remain.");
  console.log("Repository/package names containing the old text as part of a larger hyphenated identifier were intentionally preserved.");
  console.log("The Team AI CLI repository is not modified because CLI identity is independent from Marketplace identity.");
  console.log("This tool updates source repositories only. If the old Marketplace ID has already been used by developers or business repositories, migrate local Copilot registrations, ~/.teamai/config.yaml, and repository .github/copilot/settings.json separately.");
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exitCode = 1;
});
