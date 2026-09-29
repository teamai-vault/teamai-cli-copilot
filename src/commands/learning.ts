import { randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { readGlobalConfig } from "../config/global.js";
import { learningHash, listLearningOperations, createLearningOperation, updateLearningOperation, type LearningMetadata, type LearningOperation } from "../contribution/learning-outbox.js";
import { GitHubContributionError, readGitIdentity, resolveGitHubMarketplaceSource } from "../contribution/github.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { projectionFor } from "../project/context.js";
import { loadLogicalProjects, selectedLogicalProjects } from "../project/manifest.js";
import { readProjectState } from "../project/state.js";
import { atomicWriteFile } from "../utils/fs.js";
import type { CommandContext } from "./context.js";

export interface LearningShareOptions {
  file: string;
  project?: string;
  shared?: boolean;
  tags: string[];
}

export async function learningShareCommand(context: CommandContext, options: LearningShareOptions): Promise<void> {
  if (options.project && options.shared) throw new Error("Use either --project <id> or --shared.");
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const identity = await detectProjectIdentity(context.cwd);
  if (!identity) throw new Error("teamai learning share requires a Git repository.");
  const learning = await readLearning(options.file, context.cwd);
  const gitIdentity = await readGitIdentity(identity.workspaceRoot);
  if (!gitIdentity.name || !gitIdentity.email || /[\r\n\0]/.test(gitIdentity.name) || /[\r\n\0]/.test(gitIdentity.email)) {
    throw new Error("Git user.name and user.email must be non-empty single-line values.");
  }
  const source = await resolveGitHubMarketplaceSource(config.marketplace.source, context.cwd);
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd, { refresh: false });
  try {
    if (catalog.name !== config.marketplace.name) throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
    const state = await readProjectState(identity.projectAnchor, context.homeDir);
    const active = projectionFor(state, identity.workspaceRoot)?.logicalProjects ?? [];
    const target = resolveTarget(options, active, await loadLogicalProjects(catalog.root, catalog.plugins));
    const destination = path.posix.join("learnings", target, learning.name);
    const id = randomUUID();
    const createdAt = context.now().toISOString();
    const sourceRepo = path.basename(identity.projectAnchor);
    if (!sourceRepo || /[\r\n\0]/.test(sourceRepo)) throw new Error("Workspace repository name is not a safe learning metadata value.");
    const metadata: LearningMetadata = {
      id,
      title: learning.title,
      owner: gitIdentity.name,
      logicalProject: target,
      sourceRepo,
      createdAt,
      tags: normalizeTags(options.tags),
    };
    const prefix = Buffer.from(`---\n${stringify(metadata)}---\n\n`, "utf8");
    const payload = Buffer.concat([prefix, learning.body]);
    const operation: LearningOperation = {
      schemaVersion: 1,
      id,
      sourceHash: learningHash(config.marketplace.source),
      remoteIdentity: source.repository,
      sourceRemote: source.remote,
      commitIdentity: gitIdentity,
      ...(catalog.revision ? { resourceRevision: catalog.revision } : {}),
      metadata,
      fileName: learning.name,
      logicalProject: target,
      originWorkspaceKey: learningHash(normalizeWorkspace(identity.workspaceRoot)),
      contentHash: learningHash(payload),
      bodyBase64: learning.body.toString("base64"),
      payloadBase64: payload.toString("base64"),
      destination,
      branch: `teamai/learning-${id}`,
      baseBranch: "teamai-learnings",
      pullRequestTitle: `Share learning: ${learning.title}`,
      pullRequestBody: `Share learning '${learning.title}' for ${target}.\n\nOperation ID: ${id}\nPayload SHA-256: ${learningHash(payload)}`,
      phase: "queued",
      status: "ready",
    };

    if (!context.dryRun) await createLearningOperation(context.homeDir, operation);
    try {
      const result = await context.contributeGitHub({
        remote: source.remote,
        repository: source.repository,
        branch: operation.branch,
        baseBranch: operation.baseBranch,
        identity: gitIdentity,
        commitMessage: `teamai: share learning ${learning.title}`,
        pullRequestTitle: operation.pullRequestTitle,
        pullRequestBody: operation.pullRequestBody,
        dryRun: context.dryRun,
        checkpoint: async (checkpoint) => {
          const updated = { ...operation };
          if (checkpoint.phase === "base-resolved") updated.baseCommit = checkpoint.baseCommit;
          if (checkpoint.phase === "branch-pushed") updated.phase = "branch-pushed";
          if (checkpoint.phase === "pr-open") {
            updated.phase = "pr-open";
            updated.pullRequest = { number: checkpoint.pullRequestNumber, url: checkpoint.pullRequestUrl };
          }
          if (!context.dryRun) await updateLearningOperation(context.homeDir, updated);
          Object.assign(operation, updated);
        },
        prepare: async (worktree) => await prepareLearningContribution(worktree, destination, payload),
      });
      if (context.dryRun) {
        context.out(`WOULD learning share: ${learning.name} -> ${destination}`);
        for (const action of result.planned) context.out(`WOULD contribution: ${action.replace(source.remote, source.repository)}`);
        return;
      }
      if (result.baseCommit) operation.baseCommit = result.baseCommit;
      if (result.pullRequestUrl && operation.phase !== "pr-open") {
        const number = Number(result.pullRequestUrl.match(/\/pull\/(\d+)$/)?.[1]);
        if (!Number.isInteger(number) || number <= 0) throw new GitHubContributionError("PULL_REQUEST_FAILED", "GitHub returned an invalid pull request URL.");
        operation.phase = "pr-open";
        operation.pullRequest = { number, url: result.pullRequestUrl };
        await updateLearningOperation(context.homeDir, operation);
      }
      if (!result.pullRequestUrl) throw new GitHubContributionError("PULL_REQUEST_FAILED", "Contribution did not confirm an open pull request.");
      context.out(`DONE learning share: ${learning.name} -> ${destination}`);
      context.out(`Learning contribution ${id}: ${operation.phase}`);
      for (const action of result.planned) context.out(`DONE contribution: ${action.replace(source.remote, source.repository)}`);
      context.out(`Pull request: ${result.pullRequestUrl}`);
    } catch (error) {
      if (context.dryRun) throw error;
      const failure = classifyLearningFailure(error);
      operation.status = failure.status;
      operation.lastError = {
        code: failure.code,
        message: failure.message,
      };
      try {
        await updateLearningOperation(context.homeDir, operation);
      } catch {
        // Keep the already durable initial record if a later checkpoint cannot be saved.
      }
      throw new Error(
        `Learning contribution failed (${failure.code}): ${failure.message} Last confirmed phase: ${operation.phase}. ` +
        `Saved operation ID: ${id}. ${failure.nextStep} Run \`teamai learning retry ${id}\` to resume this operation; ` +
        "do not rerun `learning share` because it creates a new operation.",
      );
    }
  } finally {
    await catalog.dispose();
  }
}

export async function learningPendingCommand(context: CommandContext, json: boolean): Promise<void> {
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const source = await resolveGitHubMarketplaceSource(config.marketplace.source, context.cwd);
  const sourceHash = learningHash(config.marketplace.source);
  const operations = (await listLearningOperations(context.homeDir))
    .filter((operation) => operation.remoteIdentity === source.repository && operation.sourceHash === sourceHash)
    .filter((operation) => operation.status !== "complete")
    .map(({ id, remoteIdentity, logicalProject, destination, contentHash, branch, baseBranch, baseCommit, phase, status, pullRequest, lastError }) => ({
      id, remoteIdentity, logicalProject, destination, contentHash, branch, baseBranch, ...(baseCommit ? { baseCommit } : {}), phase, status,
      ...(pullRequest ? { pullRequest } : {}), ...(lastError ? { lastError } : {}),
    }));
  if (json) {
    context.out(JSON.stringify({ schemaVersion: 1, operations }));
    return;
  }
  if (operations.length === 0) {
    context.out("No pending learning operations for this Marketplace.");
    return;
  }
  for (const operation of operations) {
    const failure = operation.lastError ? ` | ${operation.lastError.code}: ${operation.lastError.message}` : "";
    context.out(`${operation.id} | ${operation.logicalProject} | ${operation.phase} | ${operation.status} | ${operation.destination}${failure}`);
  }
}

export async function learningRetryCommand(context: CommandContext, id: string): Promise<void> {
  const operation = (await listLearningOperations(context.homeDir)).find((candidate) => candidate.id === id.toLowerCase());
  if (!operation) throw new Error(`No saved learning operation '${id}' exists.`);
  if (operation.status === "complete") {
    context.out(`Learning contribution ${operation.id}: ${operation.phase}`);
    if (operation.phase === "closed-without-merge") context.out("The pull request was closed without merging; no new pull request was created.");
    return;
  }
  if (operation.status === "blocked") {
    throw new Error(`Learning contribution ${operation.id} is blocked${operation.lastError ? ` (${operation.lastError.code}: ${operation.lastError.message})` : ""}.`);
  }
  if (context.dryRun) {
    context.out(`WOULD learning retry: ${operation.id} -> ${operation.remoteIdentity}:${operation.baseBranch}/${operation.branch}`);
    context.out(`WOULD learning payload: ${operation.destination} sha256:${operation.contentHash}`);
    return;
  }

  try {
    const payload = Buffer.from(operation.payloadBase64, "base64");
    if (learningHash(payload) !== operation.contentHash) throw new GitHubContributionError("REMOTE_CONTENT_CONFLICT", "The saved learning payload hash does not match.");
    if (!operation.sourceRemote || !operation.commitIdentity) {
      throw new GitHubContributionError("FROZEN_RETRY_METADATA_MISSING", "This saved operation predates frozen retry source and commit identity metadata.");
    }
    const result = await context.contributeGitHub({
      remote: operation.sourceRemote,
      repository: operation.remoteIdentity,
      branch: operation.branch,
      baseBranch: operation.baseBranch,
      identity: operation.commitIdentity,
      commitMessage: `teamai: share learning ${operation.metadata.title}`,
      pullRequestTitle: operation.pullRequestTitle,
      pullRequestBody: operation.pullRequestBody,
      learningRetry: { id: operation.id, destination: operation.destination, payload, contentHash: operation.contentHash, baseCommit: operation.baseCommit },
      dryRun: false,
      checkpoint: async (checkpoint) => {
        const updated: LearningOperation = { ...operation, status: "ready" };
        delete updated.lastError;
        if (checkpoint.phase === "base-resolved") updated.baseCommit = checkpoint.baseCommit;
        if (checkpoint.phase === "branch-pushed" || checkpoint.phase === "pr-open" ||
            checkpoint.phase === "published" || checkpoint.phase === "closed-without-merge") {
          updated.phase = checkpoint.phase;
        }
        if (checkpoint.phase === "pr-open") {
          updated.pullRequest = { number: checkpoint.pullRequestNumber, url: checkpoint.pullRequestUrl };
        }
        if (checkpoint.phase === "published" || checkpoint.phase === "closed-without-merge") updated.status = "complete";
        await updateLearningOperation(context.homeDir, updated);
        Object.assign(operation, updated);
      },
      prepare: async (worktree) => await prepareLearningContribution(worktree, operation.destination, payload),
    });
    if (result.outcome === "published" || result.outcome === "closed-without-merge") {
      context.out(`Learning contribution ${operation.id}: ${result.outcome}`);
      if (result.outcome === "closed-without-merge") context.out("The pull request was closed without merging; no new pull request was created.");
    } else {
      context.out(`DONE learning retry: ${operation.id} (${operation.phase})`);
      if (result.pullRequestUrl) context.out(`Pull request: ${result.pullRequestUrl}`);
    }
  } catch (error) {
    const failure = classifyLearningFailure(error);
    operation.status = failure.status;
    operation.lastError = { code: failure.code, message: failure.message };
    try {
      await updateLearningOperation(context.homeDir, operation);
    } catch {
      // Preserve the last durable phase if its error checkpoint also fails.
    }
    throw new Error(
      `Learning retry failed (${failure.code}): ${failure.message} Last confirmed phase: ${operation.phase}. ` +
      `Saved operation ID: ${operation.id}. ${failure.nextStep}`,
    );
  }
}

function classifyLearningFailure(error: unknown): {
  code: string;
  status: LearningOperation["status"];
  message: string;
  nextStep: string;
} {
  const errorMessage = error instanceof Error ? error.message : "";
  if (errorMessage.startsWith("Learning already exists at '")) {
    return {
      code: "TARGET_EXISTS",
      status: "blocked",
      message: "The learning destination already exists.",
      nextStep: "Choose a different source filename for a new share; this saved operation cannot replace the existing file.",
    };
  }

  const code = error instanceof GitHubContributionError ? error.code : "CONTRIBUTION_FAILED";
  if (code === "REMOTE_CONTENT_CONFLICT") {
    return {
      code,
      status: "blocked",
      message: errorMessage || "The remote branch differs from the saved operation.",
      nextStep: "Review the remote branch and pull request manually; Team AI did not overwrite it.",
    };
  }
  if (code === "MERGED_CONTENT_MODIFIED") {
    return {
      code,
      status: "blocked",
      message: "The merged learning differs from the saved payload on the authoritative Learnings branch.",
      nextStep: "Review the merged content manually; Team AI did not overwrite it.",
    };
  }
  const steps: Record<string, { message: string; nextStep: string }> = {
    FROZEN_RETRY_METADATA_MISSING: {
      message: "This saved operation does not contain the frozen source transport and commit identity required for safe retry.",
      nextStep: "Review the Marketplace and Git identity manually; Team AI will not infer missing retry metadata from the current directory.",
    },
    PAYLOAD_CONTENT_CHANGED: {
      message: "Git filters changed the saved learning bytes while staging.",
      nextStep: "Review repository attributes or filters, then retry the same saved operation.",
    },
    SOURCE_CLONE_FAILED: {
      message: "Could not access the configured Marketplace repository.",
      nextStep: "Check network connectivity and GitHub read access to the repository.",
    },
    BASE_BRANCH_MISSING: {
      message: "The required `teamai-learnings` branch was not found.",
      nextStep: "Confirm that the Marketplace maintainer has created this branch; do not use another base branch.",
    },
    BASE_FETCH_FAILED: {
      message: "Could not fetch the required `teamai-learnings` branch.",
      nextStep: "Check network connectivity and GitHub read access; do not use another base branch.",
    },
    BASE_RESOLVE_FAILED: {
      message: "The fetched `teamai-learnings` commit could not be confirmed.",
      nextStep: "Check the Marketplace branch state before continuing.",
    },
    WORKTREE_CREATE_FAILED: {
      message: "Could not create the isolated contribution worktree.",
      nextStep: "Check local Git state; no branch push was confirmed.",
    },
    CONTRIBUTION_STAGE_FAILED: {
      message: "Could not stage the learning in the isolated worktree.",
      nextStep: "Check the learning destination and local Git state.",
    },
    CONTRIBUTION_COMMIT_FAILED: {
      message: "Could not commit the learning contribution.",
      nextStep: "Check local Git state and the configured Git identity.",
    },
    BRANCH_PUSH_FAILED: {
      message: "The contribution branch push was not confirmed.",
      nextStep: "The remote outcome may be uncertain; check the branch in GitHub before taking manual action.",
    },
    PULL_REQUEST_FAILED: {
      message: "The branch push was confirmed, but pull request creation was not confirmed.",
      nextStep: "Check GitHub for an existing pull request from this branch before taking manual action.",
    },
    BRANCH_LOOKUP_FAILED: {
      message: "Could not verify the saved contribution branch or pull request head.",
      nextStep: "Check GitHub read access and retry; no branch was force-pushed.",
    },
    PULL_REQUEST_LOOKUP_FAILED: {
      message: "Could not verify existing pull requests for this operation.",
      nextStep: "Check GitHub read access and retry before creating another pull request.",
    },
    CONTRIBUTION_FAILED: {
      message: "The contribution stopped before another phase was confirmed.",
      nextStep: "Check GitHub access and the local Git state.",
    },
  };
  if (code === "FROZEN_RETRY_METADATA_MISSING") {
    return { code, status: "blocked", ...steps[code] };
  }
  return {
    code,
    status: "retryable-error",
    ...(steps[code] ?? steps.CONTRIBUTION_FAILED),
  };
}

function resolveTarget(options: LearningShareOptions, active: string[], projects: Awaited<ReturnType<typeof loadLogicalProjects>>): string {
  if (options.shared) return "shared";
  if (options.project) return selectedLogicalProjects(projects, [options.project])[0].id;
  selectedLogicalProjects(projects, active);
  if (active.length === 0) return "shared";
  if (active.length === 1) return active[0];
  throw new Error("Multiple Logical Projects are active. Use --project <id> or --shared.");
}

function normalizeTags(tags: string[]): string[] {
  const normalized = tags.flatMap((tag) => tag.split(",")).map((tag) => tag.trim()).filter(Boolean);
  if (normalized.some((tag) => /[\r\n]/.test(tag))) throw new Error("Learning tags must be single-line values.");
  return [...new Set(normalized)];
}

async function readLearning(input: string, cwd: string): Promise<{ name: string; title: string; body: Buffer }> {
  const filePath = path.resolve(cwd, input);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error(`Learning source must be a regular file: ${input}`);
  const name = path.basename(filePath);
  if (!/^[a-z0-9][a-z0-9._-]*\.md$/i.test(name)) throw new Error("Learning source file name must be a safe Markdown file name.");
  const body = await readFile(filePath);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error("Learning source must contain valid UTF-8 Markdown.");
  }
  if (body.includes(0)) throw new Error("Learning source must contain text Markdown without NUL bytes.");
  if (body.subarray(0, 4).equals(Buffer.from("---\n")) || body.subarray(0, 5).equals(Buffer.from("---\r\n"))) {
    throw new Error("Learning source must contain Markdown body only; Team AI creates its frontmatter.");
  }
  return { name, title: path.basename(name).replace(/\.md$/i, "").replace(/[-_]+/g, " "), body };
}

function normalizeWorkspace(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot).replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function safeContributionPath(worktree: string, destination: string): string {
  const target = path.resolve(worktree, ...destination.split("/"));
  const relative = path.relative(worktree, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe learning destination '${destination}'.`);
  }
  return target;
}

async function assertSafeContributionAncestors(worktree: string, target: string): Promise<void> {
  const root = path.resolve(worktree);
  let current = path.dirname(target);
  while (current !== root) {
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe learning destination '${path.relative(root, target)}'.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current || path.relative(root, parent).startsWith("..")) throw new Error("Unsafe learning destination.");
    current = parent;
  }
}

async function prepareLearningContribution(worktree: string, destination: string, payload: Uint8Array): Promise<string[]> {
  const targetPath = safeContributionPath(worktree, destination);
  await assertSafeContributionAncestors(worktree, targetPath);
  try {
    const existing = await lstat(targetPath);
    if (existing.isSymbolicLink() || !existing.isFile() || existing.nlink > 1) {
      throw new Error(`Unsafe learning destination '${destination}'.`);
    }
    throw new Error(`Learning already exists at '${destination}'. Choose a different file name.`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await atomicWriteFile(targetPath, payload);
  return [destination];
}
