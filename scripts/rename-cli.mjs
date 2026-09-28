#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const OLD_REPO = "teamai-cli-customization";
const OLD_COMMAND = "team-ai";
const OLD_NAMESPACE = "com.company.teamai";
const EXCLUDED = new Set(["scripts/rename-cli.mjs", "scripts/rename-cli.md", "test/integration/rename-cli.test.ts"]);
const IDENTITY = /com\.company\.teamai|teamai-cli-customization|TEAM_AI|TeamAi|teamAi|Team AI|team-ai/g;

function usage() {
  return `Rename the CLI product in both repositories and optionally on GitHub.

Run from the workspace parent, after committing or stashing work in both repositories:
  node ${OLD_REPO}/scripts/rename-cli.mjs --repo <github-repo> --command <bin-name> --display <product-name> --namespace <extension-namespace> [--package <npm-name>] [--rename-directory] [--apply]

The default is a read-only preview. --apply edits tracked source, renames the GitHub
repository, updates origin and its Pages homepage, and leaves commits/pushes to review.
--rename-directory also renames the local CLI checkout, but requires no linked worktrees.
--skip-github is for rehearsal in a disposable local fixture only.`;
}

function parseArgs(argv) {
  const values = {};
  const flags = new Set(["--apply", "--rename-directory", "--skip-github"]);
  const named = new Set(["--repo", "--command", "--display", "--namespace", "--package", "--workspace"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (flags.has(arg)) { values[arg.slice(2)] = true; continue; }
    if (!named.has(arg)) throw new Error(`Unknown option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
    values[arg.slice(2)] = value;
  }
  for (const required of ["repo", "command", "display", "namespace"]) {
    if (!values[required]) throw new Error(`--${required} is required.\n\n${usage()}`);
  }
  values.package ??= values.repo;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(values.repo)) throw new Error("--repo must be a lowercase GitHub repository name.");
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(values.command)) throw new Error("--command must be a lowercase hyphenated executable name.");
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(values.package)) throw new Error("--package must be a valid lowercase npm package name.");
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/.test(values.namespace)) throw new Error("--namespace must be a dotted lowercase identifier.");
  if (!values.display.trim()) throw new Error("--display must not be empty.");
  if (values.repo === OLD_REPO || values.command === OLD_COMMAND) {
    throw new Error("Provide new repository and command names.");
  }
  return values;
}

function run(command, args, cwd, allowFailure = false) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result;
}

function trackedFiles(root) {
  return run("git", ["ls-files", "-z"], root).stdout.split("\0").filter(Boolean);
}

function ensureClean(root) {
  const status = run("git", ["status", "--porcelain", "--untracked-files=normal"], root).stdout.trim();
  if (status) throw new Error(`${root} has uncommitted or untracked files. Commit or stash them before --apply.`);
}

function replacementMap(options) {
  const words = options.display.trim().split(/\s+/).map((word) => word.toLowerCase());
  const pascal = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return {
    [OLD_NAMESPACE]: options.namespace,
    [OLD_REPO]: options.repo,
    TEAM_AI: words.join("_").toUpperCase(),
    TeamAi: pascal,
    teamAi: pascal[0].toLowerCase() + pascal.slice(1),
    "Team AI": options.display,
    [OLD_COMMAND]: options.command,
  };
}

function replaceIdentity(source, options, marketplace = false) {
  const sibling = "\uE000OLD_CLI_SIBLING\uE000";
  const protectedSource = marketplace && !options["rename-directory"]
    ? source.replaceAll(`../${OLD_REPO}`, sibling).replaceAll(`..\\${OLD_REPO}`, sibling)
    : source;
  const map = replacementMap(options);
  return protectedSource.replace(IDENTITY, (match) => map[match]).replaceAll(sibling, `../${OLD_REPO}`);
}

function changedPath(relative, options) {
  const map = replacementMap(options);
  return relative.replace(IDENTITY, (match) => map[match]);
}

function planRepository(root, options, marketplace) {
  const planned = [];
  for (const relative of trackedFiles(root)) {
    if (!marketplace && EXCLUDED.has(relative)) continue;
    const source = path.join(root, relative);
    const original = readFileSync(source);
    if (original.includes(0)) continue;
    let decoded;
    try { decoded = new TextDecoder("utf-8", { fatal: true }).decode(original); }
    catch { continue; }
    let next = replaceIdentity(decoded, options, marketplace);
    if (!marketplace && (relative === "package.json" || relative === "package-lock.json")) {
      next = next.replaceAll(`"name": "${options.repo}"`, `"name": "${options.package}"`);
    }
    const targetRelative = changedPath(relative, options);
    if (next !== decoded || targetRelative !== relative) planned.push({ source, relative, targetRelative, next });
  }
  const sources = new Set(planned.map((item) => path.resolve(item.source)));
  const targets = new Set();
  for (const item of planned) {
    const target = path.resolve(root, item.targetRelative);
    if (targets.has(target)) throw new Error(`Multiple files would become ${target}`);
    if (target !== path.resolve(item.source) && existsSync(target) && !sources.has(target)) {
      throw new Error(`Target already exists: ${target}`);
    }
    targets.add(target);
  }
  return planned;
}

function applyRepository(root, planned) {
  const emptyParents = new Set();
  for (const item of planned) {
    const target = path.resolve(root, item.targetRelative);
    if (target !== path.resolve(item.source)) {
      mkdirSync(path.dirname(target), { recursive: true });
      renameSync(item.source, target);
      emptyParents.add(path.dirname(item.source));
    }
    writeFileSync(target, item.next, "utf8");
  }
  for (const directory of [...emptyParents].sort((a, b) => b.length - a.length)) {
    if (directory !== root) {
      try { rmdirSync(directory); }
      catch (error) { if (error.code !== "ENOTEMPTY" && error.code !== "ENOENT") throw error; }
    }
  }
}

function githubRepository(cliRoot) {
  const remote = run("git", ["remote", "get-url", "origin"], cliRoot).stdout.trim();
  const match = remote.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (!match || match[2] !== OLD_REPO) throw new Error(`origin must point to a GitHub repository named ${OLD_REPO}: ${remote}`);
  return { owner: match[1], remote };
}

function checkGithub(owner, options) {
  const current = run("gh", ["repo", "view", `${owner}/${OLD_REPO}`, "--json", "nameWithOwner,homepageUrl"], process.cwd());
  const details = JSON.parse(current.stdout);
  if (details.nameWithOwner !== `${owner}/${OLD_REPO}`) throw new Error("GitHub repository identity did not match origin.");
  const target = run("gh", ["repo", "view", `${owner}/${options.repo}`, "--json", "nameWithOwner"], process.cwd(), true);
  if (target.status === 0) throw new Error(`GitHub repository already exists: ${owner}/${options.repo}`);
  if (!(target.stderr || "").includes("Could not resolve to a Repository")) {
    throw new Error(`Could not confirm GitHub target availability: ${(target.stderr || target.stdout || "").trim()}`);
  }
  return details.homepageUrl;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { console.log(usage()); return; }
  const workspace = path.resolve(options.workspace ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
  const cliRoot = path.join(workspace, OLD_REPO);
  const marketplaceRoot = path.join(workspace, "teamai-marketplace");
  if (!existsSync(cliRoot) || !existsSync(marketplaceRoot)) throw new Error("Both sibling repositories must exist in the workspace.");
  const cliPlan = planRepository(cliRoot, options, false);
  const marketplacePlan = planRepository(marketplaceRoot, options, true);
  const rootInstructions = path.join(workspace, "AGENTS.md");
  const rootBefore = existsSync(rootInstructions) ? readFileSync(rootInstructions, "utf8") : undefined;
  const protectedRepo = "\uE000OLD_LOCAL_REPO\uE000";
  const rootAfter = rootBefore === undefined ? undefined : (options["rename-directory"]
    ? replaceIdentity(rootBefore, options)
    : replaceIdentity(rootBefore.replaceAll(OLD_REPO, protectedRepo), options).replaceAll(protectedRepo, OLD_REPO));
  const { owner, remote } = githubRepository(cliRoot);

  console.log(`${options.apply ? "Apply" : "Preview"}: ${OLD_COMMAND} -> ${options.command}, ${OLD_REPO} -> ${options.repo}`);
  for (const [label, planned] of [[OLD_REPO, cliPlan], ["teamai-marketplace", marketplacePlan]]) {
    console.log(`${label}: ${planned.length} tracked file(s)`);
    for (const item of planned) console.log(`  ${item.relative}${item.relative === item.targetRelative ? "" : ` -> ${item.targetRelative}`}`);
  }
  if (rootAfter !== rootBefore) console.log("Workspace AGENTS.md: update");
  console.log(options["skip-github"] ? "GitHub rename: skipped for local rehearsal" : `GitHub rename: ${owner}/${OLD_REPO} -> ${owner}/${options.repo}`);
  console.log(options["rename-directory"] ? `Local CLI directory: ${OLD_REPO} -> ${options.repo}` : `Local CLI directory: remains ${OLD_REPO}`);
  if (!options.apply) return;

  ensureClean(cliRoot);
  ensureClean(marketplaceRoot);
  if (options["rename-directory"]) {
    if (existsSync(path.join(workspace, options.repo))) throw new Error("New local CLI directory already exists.");
    const worktrees = run("git", ["worktree", "list", "--porcelain"], cliRoot).stdout.match(/^worktree /gm) ?? [];
    if (worktrees.length !== 1) throw new Error("Local directory rename requires removing linked CLI worktrees first.");
    if (path.resolve(process.cwd()).startsWith(path.resolve(cliRoot) + path.sep)) {
      throw new Error("Run from the workspace parent, outside the CLI directory, to rename it.");
    }
  }
  const homepage = options["skip-github"] ? undefined : checkGithub(owner, options);
  applyRepository(cliRoot, cliPlan);
  applyRepository(marketplaceRoot, marketplacePlan);
  if (rootAfter !== rootBefore) writeFileSync(rootInstructions, rootAfter, "utf8");
  if (!options["skip-github"]) {
    run("gh", ["repo", "rename", "-R", `${owner}/${OLD_REPO}`, options.repo, "--yes"], workspace);
    run("git", ["remote", "set-url", "origin", remote.replace(OLD_REPO, options.repo)], cliRoot);
    const oldPages = `https://${owner}.github.io/${OLD_REPO}/`;
    if (homepage === oldPages) {
      run("gh", ["repo", "edit", "-R", `${owner}/${options.repo}`, "--homepage", `https://${owner}.github.io/${options.repo}/`], workspace);
    }
  }
  if (options["rename-directory"]) renameSync(cliRoot, path.join(workspace, options.repo));
  console.log("Rename applied. Review both Git diffs, run both repository gates, then commit and push.");
}

try { main(); }
catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
