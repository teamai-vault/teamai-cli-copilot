import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, type ProcessResult } from "../utils/process.js";

type Run = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<ProcessResult>;

export interface GitHubContributionOptions {
  remote: string;
  branch: string;
  identity: GitIdentity;
  commitMessage: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  prepare: (worktree: string) => Promise<string[]>;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  run?: Run;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export async function readGitIdentity(cwd: string, run: Run = runProcess): Promise<GitIdentity> {
  const [name, email] = await Promise.all([
    run("git", ["config", "user.name"], { cwd }),
    run("git", ["config", "user.email"], { cwd }),
  ]);
  if (name.exitCode !== 0 || !name.stdout.trim() || email.exitCode !== 0 || !email.stdout.trim()) {
    throw new Error("Git user.name and user.email are required to create a contribution commit. Configure them before retrying.");
  }
  return { name: name.stdout.trim(), email: email.stdout.trim() };
}

export interface GitHubContributionResult {
  branch: string;
  pullRequestUrl?: string;
  planned: string[];
}

export async function resolveGitHubMarketplaceRemote(source: string, cwd: string, run: Run = runProcess): Promise<string> {
  const local = path.resolve(cwd, source);
  try {
    if ((await stat(local)).isDirectory()) {
      const origin = await run("git", ["remote", "get-url", "origin"], { cwd: local });
      if (origin.exitCode !== 0 || !origin.stdout.trim()) {
        throw new Error(`Local Marketplace '${source}' has no origin remote. Set its origin to a GitHub repository before contributing.`);
      }
      return githubRemote(origin.stdout.trim());
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return githubRemote(source);
}

export async function submitGitHubContribution(options: GitHubContributionOptions): Promise<GitHubContributionResult> {
  const remote = githubRemote(options.remote);
  if (!safeBranch(options.branch)) throw new Error(`Unsafe contribution branch '${options.branch}'.`);
  if (!validIdentity(options.identity)) throw new Error("Git user.name and user.email are required to create a contribution commit.");
  const planned = [
    `git clone --bare ${remote}`,
    `git worktree add -b ${options.branch}`,
    `git commit -m ${options.commitMessage}`,
    `git push -u origin ${options.branch}`,
    `gh pr create --head ${options.branch}`,
  ];
  if (options.dryRun) return { branch: options.branch, planned };

  const run = options.run ?? runProcess;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "teamai-contribution-"));
  const bare = path.join(temporary, "marketplace.git");
  const worktree = path.join(temporary, "worktree");
  try {
    await required(run, "git", ["clone", "--bare", remote, bare], { env: options.env }, "Could not create isolated Marketplace clone");
    await required(run, "git", ["worktree", "add", "-b", options.branch, worktree], { cwd: bare, env: options.env }, "Could not create isolated Marketplace worktree");
    const files = await options.prepare(worktree);
    if (files.length === 0) throw new Error("Contribution did not produce any files.");
    const safeFiles = files.map((file) => safeWorktreeFile(worktree, file));
    await required(run, "git", ["add", "--", ...safeFiles], { cwd: worktree, env: options.env }, "Could not stage contribution");
    await required(run, "git", ["-c", `user.name=${options.identity.name}`, "-c", `user.email=${options.identity.email}`, "commit", "-m", options.commitMessage], { cwd: worktree, env: options.env }, "Could not commit contribution");
    await required(run, "git", ["push", "-u", "origin", options.branch], { cwd: worktree, env: options.env }, "Could not push contribution branch");
    const pullRequest = await required(run, "gh", ["pr", "create", "--title", options.pullRequestTitle, "--body", options.pullRequestBody, "--head", options.branch], { cwd: worktree, env: options.env }, "Could not create GitHub pull request");
    const pullRequestUrl = (pullRequest.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/\d+/) ?? [])[0];
    if (!pullRequestUrl) throw new Error("GitHub did not return a pull request URL.");
    return { branch: options.branch, pullRequestUrl, planned };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function githubRemote(source: string): string {
  const remote = source.split("#", 1)[0].trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(remote)) return `https://github.com/${remote}.git`;
  if (/^git@github\.com:[^/\s]+\/[^/\s]+(?:\.git)?$/.test(remote)) return remote;
  try {
    const url = new URL(remote);
    if (url.hostname === "github.com" && (url.protocol === "https:" || url.protocol === "ssh:") && url.pathname.split("/").filter(Boolean).length === 2) {
      return remote;
    }
  } catch {
    // The actionable error below also covers malformed remotes.
  }
  throw new Error(`Marketplace contributions require a GitHub repository source; '${source}' is not supported.`);
}

function safeBranch(branch: string): boolean {
  return /^teamai\/[a-z0-9][a-z0-9-]*$/.test(branch);
}

function validIdentity(identity: GitIdentity): boolean {
  return Boolean(identity.name.trim() && identity.email.trim()) && !/[\r\n]/.test(identity.name) && !/[\r\n]/.test(identity.email);
}

function safeWorktreeFile(worktree: string, file: string): string {
  const target = path.resolve(worktree, file);
  const relative = path.relative(worktree, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe contribution path '${file}'.`);
  }
  return relative;
}

async function required(run: Run, command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }, message: string): Promise<ProcessResult> {
  let result: ProcessResult;
  try {
    result = await run(command, args, options);
  } catch (error) {
    throw new Error(`${message}: ${(error as Error).message}`);
  }
  if (result.exitCode !== 0) throw new Error(`${message}: ${result.stderr.trim() || result.stdout.trim() || `${command} exited ${result.exitCode}`}`);
  return result;
}
