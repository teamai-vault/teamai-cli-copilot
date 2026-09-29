import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isFrozenLearningPullRequestBody, learningHash } from "./learning-outbox.js";
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
  learningRetry?: { id: string; destination: string; payload: Uint8Array; contentHash: string; baseCommit?: string };
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  run?: Run;
  checkpoint?: (checkpoint: GitHubContributionCheckpoint) => Promise<void>;
}

export type GitHubContributionCheckpoint =
  | { phase: "base-resolved"; baseCommit: string }
  | { phase: "branch-pushed" }
  | { phase: "pr-open"; pullRequestUrl: string; pullRequestNumber: number }
  | { phase: "published" }
  | { phase: "closed-without-merge" };

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
  | "BRANCH_LOOKUP_FAILED"
  | "PULL_REQUEST_LOOKUP_FAILED"
  | "PAYLOAD_CONTENT_CHANGED"
  | "REMOTE_CONTENT_CONFLICT"
  | "MERGED_CONTENT_MODIFIED"
  | "FROZEN_RETRY_METADATA_MISSING"
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
  outcome?: "pr-open" | "published" | "closed-without-merge";
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
    if (options.learningRetry) return await resumeLearningContribution(options, run, bare, worktree, planned);
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
    await stageCommitAndPush(options, run, worktree, safeFiles);
    const pullRequest = await createContributionPullRequest(options, run, worktree);
    return { branch: options.branch, pullRequestUrl: pullRequest.url, baseCommit, planned };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function stageCommitAndPush(options: GitHubContributionOptions, run: Run, worktree: string, files: string[]): Promise<void> {
  const addArgs = options.baseBranch ? ["-c", "core.autocrlf=false", "add", "--", ...files] : ["add", "--", ...files];
  await required(run, "git", addArgs, { cwd: worktree, env: options.env }, "Could not stage contribution", "CONTRIBUTION_STAGE_FAILED");
  if (options.baseBranch) await assertStagedBytes(run, worktree, files, options.env);
  await required(run, "git", ["-c", `user.name=${options.identity.name}`, "-c", `user.email=${options.identity.email}`, "commit", "-m", options.commitMessage], { cwd: worktree, env: options.env }, "Could not commit contribution", "CONTRIBUTION_COMMIT_FAILED");
  await required(run, "git", ["push", "-u", "origin", options.branch], { cwd: worktree, env: options.env }, "Could not push contribution branch", "BRANCH_PUSH_FAILED");
  if (options.baseBranch) await options.checkpoint?.({ phase: "branch-pushed" });
}

async function createContributionPullRequest(options: GitHubContributionOptions, run: Run, worktree: string): Promise<{ url: string; number: number }> {
  const args = ["pr", "create", "--title", options.pullRequestTitle, "--body", options.pullRequestBody];
  if (options.baseBranch) args.push("--repo", options.repository!, "--base", options.baseBranch, "--head", options.branch);
  else args.push("--head", options.branch);
  const pullRequest = await required(run, "gh", args, { cwd: worktree, env: options.env }, "Could not create GitHub pull request", "PULL_REQUEST_FAILED");
  const url = (pullRequest.stdout.match(/https:\/\/github\.com\/[^\s]+\/pull\/(\d+)/) ?? [])[0];
  if (!url) throw new GitHubContributionError("PULL_REQUEST_FAILED", "GitHub did not return a pull request URL.");
  const number = Number(url.match(/\/pull\/(\d+)$/)?.[1]);
  if (options.baseBranch) await options.checkpoint?.({ phase: "pr-open", pullRequestUrl: url, pullRequestNumber: number });
  return { url, number };
}

interface PullRequestRecord {
  number: number;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  baseRefName: string;
  headRefName: string;
  headRefOid: string | null;
  mergedAt: string | null;
}

async function resumeLearningContribution(
  options: GitHubContributionOptions,
  run: Run,
  bare: string,
  worktree: string,
  planned: string[],
): Promise<GitHubContributionResult> {
  const retry = options.learningRetry!;
  const baseBranch = options.baseBranch;
  const repository = options.repository;
  if (!baseBranch || !repository || options.branch !== `teamai/learning-${retry.id}` ||
      learningHash(retry.payload) !== retry.contentHash) {
    throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning operation is inconsistent.");
  }
  const destination = safeWorktreeFile(bare, retry.destination).replaceAll(path.sep, "/");
  const baseRef = `refs/heads/${baseBranch}`;
  const branchRef = `refs/heads/${options.branch}`;
  await required(run, "git", ["fetch", "origin", baseRef], { cwd: bare, env: options.env }, "Could not fetch the saved learning base", "BASE_FETCH_FAILED");
  const base = await required(run, "git", ["rev-parse", "FETCH_HEAD"], { cwd: bare, env: options.env }, "Could not resolve the saved learning base", "BASE_RESOLVE_FAILED");
  const currentBase = base.stdout.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(currentBase)) {
    throw new GitHubContributionError("BASE_RESOLVE_FAILED", "Could not resolve a valid learning base commit.");
  }

  const remoteBranch = await required(
    run,
    "git",
    ["ls-remote", "--heads", "origin", branchRef],
    { cwd: bare, env: options.env },
    "Could not inspect the saved learning branch",
    "BRANCH_LOOKUP_FAILED",
  );
  const branchRows = remoteBranch.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => line.trim().split(/\s+/));
  const branchRow = branchRows.find((parts) => parts[1] === branchRef);
  if (branchRows.length > 1 || branchRow && !/^[a-f0-9]{40,64}$/i.test(branchRow[0])) {
    throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning branch reference is ambiguous.");
  }
  let branchHead = branchRow?.[0];
  if (branchHead) {
    await required(
      run,
      "git",
      ["fetch", "origin", `${branchRef}:${branchRef}`],
      { cwd: bare, env: options.env },
      "Could not fetch the saved learning branch",
      "BRANCH_LOOKUP_FAILED",
    );
    const fetched = await required(run, "git", ["rev-parse", branchRef], { cwd: bare, env: options.env }, "Could not verify the saved learning branch", "BRANCH_LOOKUP_FAILED");
    if (fetched.stdout.trim() !== branchHead) {
      throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning branch changed during retry inspection.");
    }
  }

  const pullRequests = await findLearningPullRequests(run, bare, options, baseBranch, repository);
  const matching = pullRequests.filter((pullRequest) => pullRequest.baseRefName === baseBranch && pullRequest.headRefName === options.branch);
  const merged = matching.filter((pullRequest) => pullRequest.state === "MERGED" || pullRequest.mergedAt !== null);
  if (merged.length > 0) {
    const pullRequest = latestPullRequest(merged);
    const published = await readGitFile(run, bare, `${currentBase}:${destination}`, options.env);
    if (published && published.equals(Buffer.from(retry.payload)) && learningHash(published) === retry.contentHash) {
      await options.checkpoint?.({ phase: "published" });
      return { branch: options.branch, pullRequestUrl: pullRequest.url, baseCommit: currentBase, planned, outcome: "published" };
    }
    throw new GitHubContributionError("MERGED_CONTENT_MODIFIED", "The merged learning differs from the saved payload on the authoritative Learnings branch.");
  }

  const open = matching.filter((pullRequest) => pullRequest.state === "OPEN");
  if (open.length > 1) {
    throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "More than one open pull request matches this learning operation.");
  }
  if (open.length === 1) {
    const pullRequest = open[0];
    if (!branchHead) {
      const ref = `refs/teamai/retry/pr-${pullRequest.number}`;
      await required(
        run,
        "git",
        ["fetch", "origin", `refs/pull/${pullRequest.number}/head:${ref}`],
        { cwd: bare, env: options.env },
        "Could not verify the open learning pull request head",
        "BRANCH_LOOKUP_FAILED",
      );
      const fetched = await required(run, "git", ["rev-parse", ref], { cwd: bare, env: options.env }, "Could not verify the open learning pull request head", "BRANCH_LOOKUP_FAILED");
      branchHead = fetched.stdout.trim();
    }
    if (!pullRequest.headRefOid || pullRequest.headRefOid !== branchHead) {
      throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The open pull request head does not match its saved branch.");
    }
    await assertLearningBranch(run, bare, branchHead, retry.baseCommit, destination, retry.payload, retry.contentHash, options.env);
    await options.checkpoint?.({ phase: "pr-open", pullRequestUrl: pullRequest.url, pullRequestNumber: pullRequest.number });
    return { branch: options.branch, pullRequestUrl: pullRequest.url, baseCommit: retry.baseCommit, planned, outcome: "pr-open" };
  }

  const closed = matching.filter((pullRequest) => pullRequest.state === "CLOSED");
  if (closed.length > 0) {
    const pullRequest = latestPullRequest(closed);
    if (branchHead) await assertLearningBranch(run, bare, branchHead, retry.baseCommit, destination, retry.payload, retry.contentHash, options.env);
    await options.checkpoint?.({ phase: "closed-without-merge" });
    return { branch: options.branch, pullRequestUrl: pullRequest.url, baseCommit: retry.baseCommit, planned, outcome: "closed-without-merge" };
  }

  let baseCommit = retry.baseCommit;
  if (branchHead) {
    await assertLearningBranch(run, bare, branchHead, baseCommit, destination, retry.payload, retry.contentHash, options.env);
    await options.checkpoint?.({ phase: "branch-pushed" });
    await required(run, "git", ["worktree", "add", worktree, options.branch], { cwd: bare, env: options.env }, "Could not check out the saved learning branch", "WORKTREE_CREATE_FAILED");
  } else {
    baseCommit ??= currentBase;
    await assertAncestor(run, bare, baseCommit, currentBase, options.env);
    if (!retry.baseCommit) await options.checkpoint?.({ phase: "base-resolved", baseCommit });
    await required(run, "git", ["worktree", "add", "-b", options.branch, worktree, baseCommit], { cwd: bare, env: options.env }, "Could not create the saved learning branch", "WORKTREE_CREATE_FAILED");
    const files = await options.prepare(worktree);
    if (files.length !== 1 || files[0].replaceAll("\\", "/") !== destination) {
      throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning payload did not produce its exact destination file.");
    }
    const safeFiles = files.map((file) => safeWorktreeFile(worktree, file));
    await stageCommitAndPush(options, run, worktree, safeFiles);
  }

  const pullRequest = await createContributionPullRequest(options, run, worktree);
  return { branch: options.branch, pullRequestUrl: pullRequest.url, baseCommit, planned, outcome: "pr-open" };
}

async function findLearningPullRequests(
  run: Run,
  cwd: string,
  options: GitHubContributionOptions,
  baseBranch: string,
  repository: string,
): Promise<PullRequestRecord[]> {
  const headOwner = repository.split("/", 1)[0];
  const result = await required(
    run,
    "gh",
    ["api", "--method", "GET", `repos/${repository}/pulls`, "-f", "state=all", "-f", `base=${baseBranch}`, "-f", `head=${headOwner}:${options.branch}`, "-f", "per_page=100"],
    { cwd, env: options.env },
    "Could not inspect existing learning pull requests",
    "PULL_REQUEST_LOOKUP_FAILED",
  );
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    throw new GitHubContributionError("PULL_REQUEST_LOOKUP_FAILED", "GitHub returned an invalid pull request list.");
  }
  if (!Array.isArray(value)) throw new GitHubContributionError("PULL_REQUEST_LOOKUP_FAILED", "GitHub returned an invalid pull request list.");
  return value.map((entry): PullRequestRecord => {
    if (!entry || typeof entry !== "object") throw new GitHubContributionError("PULL_REQUEST_LOOKUP_FAILED", "GitHub returned an invalid pull request record.");
    const pr = entry as Record<string, unknown>;
    const state = typeof pr.state === "string" ? pr.state.toUpperCase() : "";
    const number = pr.number;
    const url = pr.html_url;
    const base = pr.base && typeof pr.base === "object" ? pr.base as Record<string, unknown> : undefined;
    const baseRepo = base?.repo && typeof base.repo === "object" ? base.repo as Record<string, unknown> : undefined;
    const head = pr.head && typeof pr.head === "object" ? pr.head as Record<string, unknown> : undefined;
    const headRepo = head?.repo && typeof head.repo === "object" ? head.repo as Record<string, unknown> : undefined;
    const headOwnerRecord = headRepo?.owner && typeof headRepo.owner === "object" ? headRepo.owner as Record<string, unknown> : undefined;
    const baseRefName = base?.ref;
    const headRefName = head?.ref;
    const headRefOid = head?.sha;
    const headRepositoryOwner = headOwnerRecord?.login;
    const headRepositoryFullName = headRepo?.full_name;
    const body = pr.body;
    const mergedAt = pr.merged_at;
    if (!Number.isInteger(number) || (number as number) <= 0 || typeof url !== "string" ||
        typeof baseRefName !== "string" || typeof headRefName !== "string" ||
        !["OPEN", "CLOSED"].includes(state) ||
        !(headRefOid === null || typeof headRefOid === "string" && /^[a-f0-9]{40,64}$/i.test(headRefOid)) ||
        typeof headRepositoryOwner !== "string" || typeof headRepositoryFullName !== "string" ||
        typeof body !== "string" || !(mergedAt === null || typeof mergedAt === "string") ||
        typeof baseRepo?.full_name !== "string") {
      throw new GitHubContributionError("PULL_REQUEST_LOOKUP_FAILED", "GitHub returned an invalid pull request record.");
    }
    const expectedUrl = `https://github.com/${repository}/pull/${number}`;
    const retry = options.learningRetry!;
    if (url.toLowerCase() !== expectedUrl.toLowerCase() ||
        baseRepo.full_name.toLowerCase() !== repository.toLowerCase() || baseRefName !== baseBranch ||
        headRepositoryOwner.toLowerCase() !== headOwner.toLowerCase() ||
        headRepositoryFullName.toLowerCase() !== repository.toLowerCase() || headRefName !== options.branch ||
        !isFrozenLearningPullRequestBody(body, retry.id, retry.contentHash)) {
      throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "An existing pull request did not match the frozen learning operation, repository, base, and payload.");
    }
    return {
      number: number as number,
      url,
      state: mergedAt === null ? state as PullRequestRecord["state"] : "MERGED",
      baseRefName,
      headRefName,
      headRefOid: headRefOid as string | null,
      mergedAt: mergedAt as string | null,
    };
  });
}

function latestPullRequest(pullRequests: PullRequestRecord[]): PullRequestRecord {
  return [...pullRequests].sort((left, right) => right.number - left.number)[0];
}

async function assertLearningBranch(
  run: Run,
  bare: string,
  branchHead: string,
  baseCommit: string | undefined,
  destination: string,
  payload: Uint8Array,
  contentHash: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (!baseCommit) throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning branch has no confirmed base commit.");
  await assertAncestor(run, bare, baseCommit, branchHead, env);
  const changed = await required(run, "git", ["diff", "--name-only", `${baseCommit}..${branchHead}`], { cwd: bare, env }, "Could not inspect saved learning branch changes", "BRANCH_LOOKUP_FAILED");
  const files = changed.stdout.trim().split(/\r?\n/).filter(Boolean).map((file) => file.replaceAll("\\", "/"));
  if (files.length !== 1 || files[0] !== destination) {
    throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning branch contains changes outside its frozen destination.");
  }
  const actual = await readGitFile(run, bare, `${branchHead}:${destination}`, env);
  if (!actual || !actual.equals(Buffer.from(payload)) || learningHash(actual) !== contentHash) {
    throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning branch does not match its frozen ID and content hash.");
  }
}

async function assertAncestor(run: Run, cwd: string, ancestor: string, commit: string, env?: NodeJS.ProcessEnv): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/i.test(ancestor) || !/^[a-f0-9]{40,64}$/i.test(commit)) {
    throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning branch has an invalid base commit.");
  }
  const result = await run("git", ["merge-base", "--is-ancestor", ancestor, commit], { cwd, env });
  if (result.exitCode !== 0) throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning branch is not based on its frozen Learnings commit.");
}

async function readGitFile(run: Run, cwd: string, spec: string, env?: NodeJS.ProcessEnv): Promise<Buffer | undefined> {
  const result = await run("git", ["show", spec], { cwd, env });
  return result.exitCode === 0 ? Buffer.from(result.stdout, "utf8") : undefined;
}

async function assertStagedBytes(run: Run, worktree: string, files: string[], env?: NodeJS.ProcessEnv): Promise<void> {
  for (const file of files) {
    const relative = file.replaceAll(path.sep, "/");
    const staged = await required(run, "git", ["show", `:${relative}`], { cwd: worktree, env }, "Could not verify staged contribution bytes", "CONTRIBUTION_STAGE_FAILED");
    const working = await readFile(path.resolve(worktree, file));
    if (!Buffer.from(staged.stdout, "utf8").equals(working)) {
      throw new GitHubContributionError("PAYLOAD_CONTENT_CHANGED", "Git filters changed the saved learning bytes while staging.");
    }
  }
}

function githubRemote(source: string): string {
  return githubRepository(source).remote;
}

function githubRepository(source: string): GitHubMarketplaceSource {
  const remote = source.split("#", 1)[0].trim();
  const scp = remote.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (scp && GITHUB_REPOSITORY.test(`${scp[1]}/${scp[2]}`)) {
    const repository = `${scp[1]}/${scp[2]}`;
    return { remote: `git@github.com:${repository}.git`, repository };
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(remote)) {
    const repository = remote.replace(/\.git$/i, "");
    if (!GITHUB_REPOSITORY.test(repository)) throw new Error("Marketplace contributions require a GitHub repository source; this source is not supported.");
    return { remote: `https://github.com/${repository}.git`, repository };
  }
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw new Error("Marketplace contributions require a GitHub repository source; this source is not supported.");
  }
  if (url.username && (url.protocol !== "ssh:" || url.username !== "git") || url.password) {
    throw new Error("Marketplace source URLs must not contain credentials. Configure GitHub authentication through Git instead.");
  }
  if (url.hostname === "github.com" && !url.port && !url.search && (url.protocol === "https:" || url.protocol === "ssh:") && url.pathname.split("/").filter(Boolean).length === 2) {
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    const repository = `${owner}/${repo.replace(/\.git$/i, "")}`;
    if (GITHUB_REPOSITORY.test(repository)) {
      const sanitizedRemote = url.protocol === "https:"
        ? `https://github.com/${repository}.git`
        : `ssh://git@github.com/${repository}.git`;
      return { remote: sanitizedRemote, repository };
    }
  }
  throw new Error("Marketplace contributions require a GitHub repository source; this source is not supported.");
}

function safeBranch(branch: string): boolean {
  return /^teamai\/[a-z0-9][a-z0-9-]*$/.test(branch);
}

function validIdentity(identity: GitIdentity): boolean {
  return Boolean(identity.name.trim() && identity.email.trim()) && !/[\r\n\0]/.test(identity.name) && !/[\r\n\0]/.test(identity.email);
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
