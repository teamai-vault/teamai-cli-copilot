import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runProcess, type ProcessResult } from "../utils/process.js";

type Run = (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<ProcessResult>;

export interface GitHubContributionOptions {
  remote: string;
  branch: string;
  baseBranch?: string;
  repository?: string;
  identity: GitIdentity;
  commitMessage: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  prepare: (worktree: string) => Promise<string[]>;
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  checkpoint?: (checkpoint: GitHubContributionCheckpoint) => Promise<void>;
}

export type GitHubContributionCheckpoint =
  | { phase: "base-resolved"; baseCommit: string }
  | { phase: "branch-pushed" }
  | { phase: "pr-open"; pullRequestUrl: string; pullRequestNumber: number };

export type GitHubContributionFailureCode =
  | "SOURCE_CLONE_FAILED"
  | "BASE_BRANCH_MISSING"
  | "BASE_FETCH_FAILED"
  | "BASE_RESOLVE_FAILED"
  | "WORKTREE_CREATE_FAILED"
  | "CONTRIBUTION_STAGE_FAILED"
  | "CONTRIBUTION_COMMIT_FAILED"
  | "BRANCH_PUSH_FAILED"
  | "PULL_REQUEST_FAILED"
  | "CONTRIBUTION_FAILED";

export class GitHubContributionError extends Error {
  constructor(readonly code: GitHubContributionFailureCode, message: string) {
    super(message);
    this.name = "GitHubContributionError";
  }
}

export interface GitHubMarketplaceSource {
  remote: string;
  repository: string;
}

const GITHUB_REPOSITORY = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

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
  baseCommit?: string;
  planned: string[];
}

export async function resolveGitHubMarketplaceSource(source: string, cwd: string, run: Run = runProcess): Promise<GitHubMarketplaceSource> {
  const local = path.resolve(cwd, source);
  try {
    if ((await stat(local)).isDirectory()) {
      const origin = await run("git", ["remote", "get-url", "origin"], { cwd: local });
      if (origin.exitCode !== 0 || !origin.stdout.trim()) {
        throw new Error(`Local Marketplace '${source}' has no origin remote. Set its origin to a GitHub repository before contributing.`);
      }
      return githubRepository(origin.stdout.trim());
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return githubRepository(source);
}

export async function resolveGitHubMarketplaceRemote(source: string, cwd: string, run: Run = runProcess): Promise<string> {
  return (await resolveGitHubMarketplaceSource(source, cwd, run)).remote;
}

export async function submitGitHubContribution(options: GitHubContributionOptions): Promise<GitHubContributionResult> {
  const remote = githubRemote(options.remote);
  if (!safeBranch(options.branch)) throw new Error(`Unsafe contribution branch '${options.branch}'.`);
  if (options.baseBranch && (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(options.baseBranch) || options.baseBranch.includes(".."))) {
    throw new Error(`Unsafe contribution base '${options.baseBranch}'.`);
  }
  if (options.baseBranch && (!options.repository || !GITHUB_REPOSITORY.test(options.repository))) {
    throw new Error("A GitHub repository is required for an explicit contribution base.");
  }
  if (!validIdentity(options.identity)) throw new Error("Git user.name and user.email are required to create a contribution commit.");
  const planned = [
    `git clone --bare ${remote}`,
    ...(options.baseBranch ? [`git fetch origin refs/heads/${options.baseBranch}`, `git worktree add -b ${options.branch} <base-commit>`] : [`git worktree add -b ${options.branch}`]),
    `git commit -m ${options.commitMessage}`,
    `git push -u origin ${options.branch}`,
    options.baseBranch
      ? `gh pr create --repo ${options.repository} --base ${options.baseBranch} --head ${options.branch}`
      : `gh pr create --head ${options.branch}`,
  ];
  if (options.dryRun) return { branch: options.branch, planned };

  const run = options.run ?? runProcess;
  const temporary = await mkdtemp(path.join(os.tmpdir(), "teamai-contribution-"));
  const bare = path.join(temporary, "marketplace.git");
  const worktree = path.join(temporary, "worktree");
  try {
    await required(run, "git", ["clone", "--bare", remote, bare], { env: options.env }, "Could not create isolated Marketplace clone", "SOURCE_CLONE_FAILED");
    let baseCommit: string | undefined;
    if (options.baseBranch) {
      await required(run, "git", ["fetch", "origin", `refs/heads/${options.baseBranch}`], { cwd: bare, env: options.env }, `Could not fetch contribution base '${options.baseBranch}'`, "BASE_FETCH_FAILED");
      const base = await required(run, "git", ["rev-parse", "FETCH_HEAD"], { cwd: bare, env: options.env }, "Could not resolve contribution base", "BASE_RESOLVE_FAILED");
      baseCommit = base.stdout.trim();
      if (!/^[a-f0-9]{40,64}$/i.test(baseCommit)) throw new GitHubContributionError("BASE_RESOLVE_FAILED", "Could not resolve a valid contribution base commit.");
      await options.checkpoint?.({ phase: "base-resolved", baseCommit });
      await required(run, "git", ["worktree", "add", "-b", options.branch, worktree, baseCommit], { cwd: bare, env: options.env }, "Could not create isolated Marketplace worktree", "WORKTREE_CREATE_FAILED");
    } else {
      await required(run, "git", ["worktree", "add", "-b", options.branch, worktree], { cwd: bare, env: options.env }, "Could not create isolated Marketplace worktree", "WORKTREE_CREATE_FAILED");
    }
    const files = await options.prepare(worktree);
    if (files.length === 0) throw new Error("Contribution did not produce any files.");
    const safeFiles = files.map((file) => safeWorktreeFile(worktree, file));
    await required(run, "git", ["add", "--", ...safeFiles], { cwd: worktree, env: options.env }, "Could not stage contribution", "CONTRIBUTION_STAGE_FAILED");
    await required(run, "git", ["-c", `user.name=${options.identity.name}`, "-c", `user.email=${options.identity.email}`, "commit", "-m", options.commitMessage], { cwd: worktree, env: options.env }, "Could not commit contribution", "CONTRIBUTION_COMMIT_FAILED");
    await required(run, "git", ["push", "-u", "origin", options.branch], { cwd: worktree, env: options.env }, "Could not push contribution branch", "BRANCH_PUSH_FAILED");
    if (options.baseBranch) await options.checkpoint?.({ phase: "branch-pushed" });
    const pullRequestArgs = ["pr", "create", "--title", options.pullRequestTitle, "--body", options.pullRequestBody];
    if (options.baseBranch) pullRequestArgs.push("--repo", options.repository!, "--base", options.baseBranch, "--head", options.branch);
    else pullRequestArgs.push("--head", options.branch);
    const pullRequest = await required(run, "gh", pullRequestArgs, { cwd: worktree, env: options.env }, "Could not create GitHub pull request", "PULL_REQUEST_FAILED");
    const pullRequestUrl = (pullRequest.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/) ?? [])[0];
    if (!pullRequestUrl) throw new GitHubContributionError("PULL_REQUEST_FAILED", "GitHub did not return a pull request URL.");
    const pullRequestNumber = Number(pullRequestUrl.match(/\/pull\/(\d+)$/)?.[1]);
    if (options.baseBranch) await options.checkpoint?.({ phase: "pr-open", pullRequestUrl, pullRequestNumber });
    return { branch: options.branch, pullRequestUrl, baseCommit, planned };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function githubRemote(source: string): string {
  return githubRepository(source).remote;
}

function githubRepository(source: string): GitHubMarketplaceSource {
  const remote = source.split("#", 1)[0].trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(remote)) {
    const repository = remote.replace(/\.git$/i, "");
    if (!GITHUB_REPOSITORY.test(repository)) throw new Error("Marketplace contributions require a GitHub repository source; this source is not supported.");
    return { remote: `https://github.com/${repository}.git`, repository };
  }
  const scp = remote.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (scp && GITHUB_REPOSITORY.test(`${scp[1]}/${scp[2]}`)) return { remote, repository: `${scp[1]}/${scp[2]}` };
  try {
    const url = new URL(remote);
    if (url.hostname === "github.com" && !url.port && !url.search && (url.protocol === "https:" || url.protocol === "ssh:") && url.pathname.split("/").filter(Boolean).length === 2) {
      const [owner, repo] = url.pathname.split("/").filter(Boolean);
      const repository = `${owner}/${repo.replace(/\.git$/i, "")}`;
      if (GITHUB_REPOSITORY.test(repository)) return { remote, repository };
    }
  } catch {
    // The actionable error below also covers malformed remotes.
  }
  throw new Error("Marketplace contributions require a GitHub repository source; this source is not supported.");
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

async function required(
  run: Run,
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
  message: string,
  failureCode: GitHubContributionFailureCode = "CONTRIBUTION_FAILED",
): Promise<ProcessResult> {
  let result: ProcessResult;
  try {
    result = await run(command, args, options);
  } catch (error) {
    throw new GitHubContributionError(failureCode, `${message}: ${(error as Error).message}`);
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `${command} exited ${result.exitCode}`;
    const missingBase = failureCode === "BASE_FETCH_FAILED" && /could(?:n't| not) find remote ref|remote ref .* not found/i.test(detail);
    throw new GitHubContributionError(missingBase ? "BASE_BRANCH_MISSING" : failureCode, `${message}: ${detail}`);
  }
  return result;
}
