#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdtemp, mkdir, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const BRANCH_REF = "refs/heads/teamai-learnings";
const BLOCKED_GIT_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
];

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--apply") {
      if (options.apply) throw new UsageError("--apply may only be specified once.");
      options.apply = true;
      continue;
    }
    if (arg === "--marketplace") {
      if (options.marketplace !== undefined) throw new UsageError("--marketplace may only be specified once.");
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new UsageError("--marketplace requires a source.");
      options.marketplace = value;
      index += 1;
      continue;
    }
    throw new UsageError(`Unknown option: ${arg}`);
  }
  if (!options.help && options.marketplace === undefined) {
    throw new UsageError("--marketplace <source> is required.");
  }
  return options;
}

function usage() {
  return `Initialize the Marketplace Learnings authority branch.

Usage:
  node scripts/init-learnings-branch.mjs --marketplace <source>          # preview
  node scripts/init-learnings-branch.mjs --marketplace <source> --apply  # explicit write

Options:
  --marketplace <source>  Git URL or local bare repository.
  --apply                 Create and push the root commit; default is preview.
  --help                  Show this help.

Safety:
  Only refs/heads/teamai-learnings is pushed. The commit has no parent. Existing or
  concurrently created branches are never overwritten, and the caller's checkout is not changed.`;
}

function gitEnvironment() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  for (const name of BLOCKED_GIT_ENV) delete env[name];
  return env;
}

function gitEnvironmentWithoutInjectedConfig() {
  const env = gitEnvironment();
  for (const name of Object.keys(env)) {
    if (name === "GIT_CONFIG_PARAMETERS" || /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name)) {
      delete env[name];
    }
  }
  return env;
}

function assertNoGitNamespace() {
  if (process.env.GIT_NAMESPACE !== undefined) {
    throw new UsageError("GIT_NAMESPACE is set; unset it before initializing the authority branch.");
  }
}

export function runGit(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd ?? process.cwd(),
      env: options.env ?? gitEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stdinError;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", (error) => { stdinError = error; });
    child.on("error", reject);
    child.on("close", (code) => {
      // Git can close stdin early. Wait for its status and all diagnostic output.
      if (stdinError && code === 0) reject(stdinError);
      else resolve({ exitCode: code ?? 1, stdout, stderr });
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function git(args, { cwd, input, env, operation } = {}) {
  const result = await runGit(args, { cwd, input, env });
  if (result.exitCode !== 0) {
    throw new Error(operation ?? "Git operation failed.");
  }
  return result.stdout.trim();
}

function isWindowsPath(source) {
  return /^[a-z]:[\\/]/i.test(source);
}

function isScpRemote(source) {
  return !isWindowsPath(source)
    && !source.includes("://")
    && !source.includes("::")
    && /^(?:[^/\\@\s]+@)?[^/\\:\s]+:.+$/.test(source);
}

function localSourcePath(source) {
  if (/^file:\/\//i.test(source)) return fileURLToPath(source);
  if (/^(?:https?|ssh|git):\/\//i.test(source) || isScpRemote(source)) return undefined;
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !isWindowsPath(source)) {
    throw new UsageError("Marketplace source must be a Git URL or local bare repository path.");
  }
  return path.resolve(source);
}

async function normalizeSource(source) {
  if (!source || source.trim() !== source || source.startsWith("-") || /[\r\n\0]/.test(source)) {
    throw new UsageError("--marketplace must be a non-empty Git URL or repository path.");
  }
  const localPath = localSourcePath(source);
  if (localPath) {
    const hasWorktreeMarkers = path.basename(localPath).toLowerCase() === ".git"
      || await pathExists(path.join(localPath, ".git"))
      || await pathExists(path.join(localPath, "gitdir"))
      || await pathExists(path.join(localPath, "commondir"));
    const config = await runGit([
      "config", "--file", path.join(localPath, "config"), "--bool", "--get", "core.bare",
    ], { env: gitEnvironmentWithoutInjectedConfig() });
    const result = await runGit(["-C", localPath, "rev-parse", "--is-bare-repository"], {
      env: gitEnvironmentWithoutInjectedConfig(),
    });
    if (hasWorktreeMarkers || config.exitCode !== 0 || config.stdout.trim() !== "true"
      || result.exitCode !== 0 || result.stdout.trim() !== "true") {
      throw new Error("A local Marketplace source must be a bare repository. Use its remote URL to avoid changing a checkout.");
    }
    return localPath;
  }
  return source;
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function resolvedTargetMatches(resolved, source) {
  const expectedPath = localSourcePath(source);
  if (!expectedPath) return resolved === source;
  let resolvedPath;
  try {
    resolvedPath = localSourcePath(resolved);
  } catch {
    return false;
  }
  if (!resolvedPath) return false;
  const expected = path.resolve(expectedPath);
  const actual = path.resolve(resolvedPath);
  return process.platform === "win32"
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

async function assertResolvedTarget(repository, remoteName, source, push) {
  const result = await runGit([
    "-C", repository,
    "remote",
    "get-url",
    ...(push ? ["--push"] : []),
    "--all",
    remoteName,
  ]);
  const urls = result.stdout.split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
  if (result.exitCode !== 0 || urls.length !== 1 || !resolvedTargetMatches(urls[0], source)) {
    const direction = push ? "push" : "fetch";
    throw new Error(`Git ${direction} URL resolution does not match the specified Marketplace source; refusing to continue.`);
  }
}

async function assertResolvedTargets(repository, remoteName, source) {
  await assertResolvedTarget(repository, remoteName, source, false);
  await assertResolvedTarget(repository, remoteName, source, true);
}

async function remoteBranch(repository, remoteName, source) {
  await assertResolvedTargets(repository, remoteName, source);
  const result = await runGit([
    "-C", repository,
    "ls-remote",
    "--heads",
    remoteName,
    BRANCH_REF,
  ]);
  if (result.exitCode !== 0) throw new Error("Could not inspect the Marketplace source with git ls-remote.");
  for (const line of result.stdout.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (ref === BRANCH_REF) return sha;
  }
  return undefined;
}

async function configuredIdentity(repository) {
  const name = await git(["-C", repository, "config", "--get", "user.name"], { operation: "Git user.name is not configured." });
  const email = await git(["-C", repository, "config", "--get", "user.email"], { operation: "Git user.email is not configured." });
  if (!name || !email || /[\r\n]/.test(name) || /[\r\n]/.test(email)) {
    throw new Error("Configure a valid Git user.name and user.email before applying this operation.");
  }
  return { name, email };
}

async function initializeTemporaryRepository(repository) {
  const templates = path.join(path.dirname(repository), "templates");
  await mkdir(templates);
  await git(["init", "--bare", "--quiet", "--template", templates, repository], {
    operation: "Could not initialize the isolated temporary Git repository.",
  });
}

async function configureTemporaryRemote(repository, remoteName, source) {
  await git(["-C", repository, "remote", "add", remoteName, source], {
    operation: "Could not configure the Marketplace source in the isolated Git repository.",
  });
}

async function createRootCommit(repository, remoteName, source, identity) {
  const emptyTree = await git(["-C", repository, "mktree"], { input: "", operation: "Could not create the empty root tree." });
  const commit = await git([
    "-C", repository,
    "-c", `user.name=${identity.name}`,
    "-c", `user.email=${identity.email}`,
    "commit-tree", emptyTree,
    "-m", `Initialize teamai-learnings (${randomUUID()})`,
  ], {
    env: {
      ...gitEnvironment(),
      GIT_AUTHOR_NAME: identity.name,
      GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name,
      GIT_COMMITTER_EMAIL: identity.email,
    },
    operation: "Could not create the parentless root commit.",
  });
  const parents = await git(["-C", repository, "rev-list", "--parents", "-n", "1", commit]);
  if (parents.trim() !== commit) throw new Error("The temporary commit unexpectedly has a parent.");

  const existing = await remoteBranch(repository, remoteName, source);
  if (existing) throw new Error(`Remote branch teamai-learnings already exists (${existing}); no changes made.`);

  await assertResolvedTargets(repository, remoteName, source);
  const pushed = await runGit([
    "-C", repository,
    "push", "--porcelain", "--no-follow-tags", remoteName, `${commit}:${BRANCH_REF}`,
  ]);
  const observed = await remoteBranch(repository, remoteName, source);
  if (observed === commit) return commit;
  if (pushed.exitCode !== 0 && observed) {
    throw new Error("The remote branch was created concurrently; no force push was attempted.");
  }
  if (pushed.exitCode !== 0) {
    throw new Error("Push was rejected; no force push was attempted.");
  }
  throw new Error("Push completed, but the remote branch no longer points at the bootstrap commit.");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  assertNoGitNamespace();

  const source = await normalizeSource(options.marketplace);
  const remoteName = `teamai-learnings-bootstrap-${randomUUID()}`;
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "teamai-learnings-bootstrap-"));
  try {
    const repository = path.join(tempRoot, "repository.git");
    await initializeTemporaryRepository(repository);
    await configureTemporaryRemote(repository, remoteName, source);

    const current = await remoteBranch(repository, remoteName, source);
    if (current) throw new Error(`Remote branch teamai-learnings already exists (${current}); no changes made.`);

    if (!options.apply) {
      console.log("Preview: teamai-learnings does not exist on the Marketplace source.");
      console.log("Would create one parentless root commit and push only refs/heads/teamai-learnings.");
      console.log("Re-run with --apply to perform this operation.");
      return;
    }

    const identity = await configuredIdentity(repository);
    const commit = await createRootCommit(repository, remoteName, source, identity);
    console.log(`Created teamai-learnings at root commit ${commit}. Only the new branch was pushed.`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`ERROR: ${message}`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
