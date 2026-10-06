import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { resolveGitHubMarketplaceRemote, submitGitHubContribution } from "../../src/contribution/github.js";
import { createLearningOperation, learningHash, learningOutboxDirectory, type LearningOperation } from "../../src/contribution/learning-outbox.js";
import { writeGlobalConfig } from "../../src/config/global.js";
import { createConfig } from "../../src/config/schema.js";
import { detectProjectIdentity } from "../../src/project/anchors.js";
import { projectionKey } from "../../src/project/context.js";
import { writeProjectState } from "../../src/project/state.js";
import { runProcess } from "../../src/utils/process.js";
import { createFakeCopilot, createGitRepo, loadFakeMarketplace, tempDir as createTempDir, TEST_MARKETPLACE_NAME, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

const cleanup = new Set<string>();
// Includes local Git fixture setup, the first share, remote edits, and retry.
const GIT_INTEGRATION_TIMEOUT = 60_000;

afterEach(async () => {
  await Promise.all([...cleanup].map(async (target) => await rm(target, { recursive: true, force: true })));
  cleanup.clear();
});

async function tempDir(prefix: string): Promise<string> {
  const root = await createTempDir(prefix);
  cleanup.add(root);
  return root;
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line: string) => stdout.push(line), err: (line: string) => stderr.push(line) };
}

async function marketplace(): Promise<string> {
  const root = await tempDir("teamai-learning-marketplace-");
  const initialized = await runProcess("git", ["init", "-b", "main"], { cwd: root });
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
  await runProcess("git", ["config", "user.email", "teamai@example.invalid"], { cwd: root });
  await runProcess("git", ["config", "user.name", "Team AI Test"], { cwd: root });
  await runProcess("git", ["remote", "add", "origin", "https://github.com/test-org/teamai-marketplace.git"], { cwd: root });
  await mkdir(path.join(root, "manifest"), { recursive: true });
  await writeFile(path.join(root, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments.v2\n    name: Payments\n    description: Payment domain\n    owners: [payments]\n  - id: risk\n    name: Risk\n    description: Risk domain\n    owners: [risk]\n", "utf8");
  return root;
}

async function setActiveProjects(repo: string, home: string, ids: string[]): Promise<void> {
  const identity = await detectProjectIdentity(repo);
  if (!identity) throw new Error("fixture is not a Git repository");
  await writeProjectState(identity.projectAnchor, {
    schemaVersion: 1,
    workspaceRoot: identity.workspaceRoot,
    lastSync: "2026-09-22T00:00:00.000Z",
    managedPlugins: [],
    projections: {
      [projectionKey(identity.workspaceRoot)]: {
        workspaceRoot: identity.workspaceRoot,
        logicalProjects: ids,
        managedProjectPlugins: [],
        instructionRoot: path.join(identity.workspaceRoot, ".github", "instructions", "teamai"),
        contextRoot: path.join(identity.workspaceRoot, ".teamai", "context"),
      },
    },
  }, home);
}

async function marketplaceWithLearningRemote(): Promise<{ root: string; remote: string; baseCommit: string }> {
  const root = await marketplace();
  const remote = path.join(await tempDir("teamai-learning-bare-"), "marketplace.git");
  const initialized = await runProcess("git", ["init", "--bare", remote]);
  if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
  const git = async (args: string[]) => {
    const result = await runProcess("git", args, { cwd: root });
    if (result.exitCode !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  await git(["remote", "set-url", "origin", remote]);
  await git(["add", "-A"]);
  await git(["commit", "-m", "marketplace resource baseline"]);
  await git(["push", "origin", "main"]);
  await git(["checkout", "--orphan", "teamai-learnings"]);
  await git(["rm", "-rf", "."]);
  await writeFile(path.join(root, "README.md"), "# Team learnings\n", "utf8");
  await git(["add", "README.md"]);
  await git(["commit", "-m", "learning branch root"]);
  const baseCommit = await git(["rev-parse", "HEAD"]);
  await git(["push", "origin", "teamai-learnings"]);
  const defaultBranch = await runProcess("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  if (defaultBranch.exitCode !== 0) throw new Error(defaultBranch.stderr);
  await git(["checkout", "main"]);
  await git(["remote", "set-url", "origin", "https://github.com/test-org/teamai-marketplace.git"]);
  return { root, remote, baseCommit };
}

// Dry-run consumes an already-frozen outbox record; remote recovery uses retryFixture below.
async function frozenRetryFixture() {
  const home = await tempDir("teamai-learning-frozen-retry-home-");
  const retryCwd = await tempDir("teamai-learning-frozen-retry-cwd-");
  const id = "00000000-0000-4000-8000-000000000001";
  const body = Buffer.from("Keep this exact learning.\r\n", "utf8");
  const prefix = Buffer.from([
    "---", `id: ${id}`, "title: note", "owner: Retry User", "logicalProject: shared",
    "sourceRepo: consumer", "createdAt: 2026-09-22T00:00:00.000Z", "tags: []", "---", "", "",
  ].join("\n"), "utf8");
  const payload = Buffer.concat([prefix, body]);
  const contentHash = learningHash(payload);
  const operation: LearningOperation = {
    schemaVersion: 1,
    id,
    sourceHash: learningHash(TEST_MARKETPLACE_SOURCE),
    remoteIdentity: "test-org/teamai-marketplace",
    sourceRemote: TEST_MARKETPLACE_SOURCE,
    commitIdentity: { name: "Retry User", email: "retry@example.invalid" },
    metadata: {
      id, title: "note", owner: "Retry User", logicalProject: "shared",
      sourceRepo: "consumer", createdAt: "2026-09-22T00:00:00.000Z", tags: [],
    },
    fileName: `${id}.md`,
    logicalProject: "shared",
    originWorkspaceKey: learningHash(retryCwd),
    contentHash,
    bodyBase64: body.toString("base64"),
    payloadBase64: payload.toString("base64"),
    destination: `learnings/shared/${id}.md`,
    branch: `teamai/learning-${id}`,
    baseBranch: "teamai-learnings",
    baseCommit: "a".repeat(40),
    pullRequestTitle: "teamai: share learning note",
    pullRequestBody: `Share learning note.\n\nOperation ID: ${id}\nPayload SHA-256: ${contentHash}`,
    phase: "queued",
    status: "retryable-error",
    lastError: { code: "BRANCH_PUSH_FAILED", message: "The contribution branch push was not confirmed." },
  };
  await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }), home);
  await createLearningOperation(home, operation);
  const payloadPath = path.join(home, ".teamai", "outbox", "learning-payloads", `${id}.md`);
  return { home, retryCwd, operation, payloadPath, payload };
}

interface RetryFixture {
  repo: string;
  retryCwd: string;
  home: string;
  source: string;
  remote: string;
  env: NodeJS.ProcessEnv;
  operation: LearningOperation;
  counters: { pushes: number; prLists: number; prCreates: number };
  ghQueries: string[][];
  run: (command: string, args: string[], options?: { cwd?: string; env?: NodeJS.ProcessEnv }) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
  setPullRequest: (state: "OPEN" | "CLOSED" | "MERGED" | undefined, mergedAt?: string | null, overrides?: { headOwner?: string; body?: string }) => void;
  pullRequestBody: () => string;
}

async function retryFixture(initialFailure: "push" | "pr" | "push-before", transport: "https" | "ssh" = "https"): Promise<RetryFixture> {
  const repo = await createGitRepo();
  cleanup.add(repo);
  const retryCwd = await createGitRepo();
  cleanup.add(retryCwd);
  const home = await tempDir("teamai-learning-retry-home-");
  const { root: source, remote } = await marketplaceWithLearningRemote();
  const sourceRemote = transport === "ssh" ? "ssh://git@github.com/test-org/teamai-marketplace.git" : "https://github.com/test-org/teamai-marketplace.git";
  if (transport === "ssh") await runProcess("git", ["remote", "set-url", "origin", sourceRemote], { cwd: source });
  await writeFile(path.join(repo, "note.md"), "Keep this exact learning.\r\n", "utf8");
  await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source }), home);
  await runProcess("git", ["config", "user.name", "Retry User"], { cwd: retryCwd });
  await runProcess("git", ["config", "user.email", "retry@example.invalid"], { cwd: retryCwd });
  const gitConfig = path.join(await tempDir("teamai-learning-retry-git-config-"), "config");
  await writeFile(gitConfig, `[url "${pathToFileURL(remote).href}"]\n\tinsteadOf = ${sourceRemote}\n`, "utf8");
  const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const counters = { pushes: 0, prLists: 0, prCreates: 0 };
  const ghQueries: string[][] = [];
  let pullRequestState: "OPEN" | "CLOSED" | "MERGED" | undefined;
  let mergedAt: string | null = null;
  let pullRequestHeadOwner = "test-org";
  let pullRequestBody = "";
  let firstPushLost = false;
  let firstPrLost = false;
  const run: RetryFixture["run"] = async (command, args, options) => {
    if (command === "git" && args[0] === "push") {
      counters.pushes += 1;
      if (initialFailure === "push-before" && !firstPushLost) {
        firstPushLost = true;
        return { exitCode: 1, stdout: "", stderr: "simulated push failure before remote update" };
      }
      const pushed = await runProcess(command, args, { ...options, env });
      if (initialFailure === "push" && !firstPushLost) {
        firstPushLost = true;
        return { ...pushed, exitCode: 1, stderr: "simulated lost push response" };
      }
      return pushed;
    }
    if (command === "gh" && args[0] === "api" && args.includes("repos/test-org/teamai-marketplace/pulls")) {
      counters.prLists += 1;
      ghQueries.push([...args]);
      if (!pullRequestState) return { exitCode: 0, stdout: "[]", stderr: "" };
      const headFilter = args.find((argument) => argument.startsWith("head=test-org:"));
      const branch = headFilter?.slice("head=test-org:".length) ?? "";
      const head = await runProcess("git", ["--git-dir", remote, "rev-parse", `refs/heads/${branch}`]);
      return {
        exitCode: 0,
        stdout: JSON.stringify([{
          number: 42,
          html_url: "https://github.com/test-org/teamai-marketplace/pull/42",
          state: pullRequestState === "MERGED" ? "closed" : pullRequestState.toLowerCase(),
          base: { ref: "teamai-learnings", repo: { full_name: "test-org/teamai-marketplace" } },
          head: {
            ref: branch,
            sha: head.exitCode === 0 ? head.stdout.trim() : null,
            repo: { full_name: `${pullRequestHeadOwner}/teamai-marketplace`, owner: { login: pullRequestHeadOwner } },
          },
          body: pullRequestBody,
          merged_at: mergedAt,
        }]),
        stderr: "",
      };
    }
    if (command === "gh" && args[0] === "pr" && args[1] === "create") {
      counters.prCreates += 1;
      pullRequestState ??= "OPEN";
      pullRequestBody = args[args.indexOf("--body") + 1] ?? "";
      if (initialFailure === "pr" && !firstPrLost) {
        firstPrLost = true;
        return { exitCode: 1, stdout: "", stderr: "simulated lost pull request response" };
      }
      return { exitCode: 0, stdout: "https://github.com/test-org/teamai-marketplace/pull/42\n", stderr: "" };
    }
    return await runProcess(command, args, { ...options, env });
  };

  const output = capture();
  const exitCode = await runCli(["learning", "share", "note.md"], {
    cwd: repo,
    homeDir: home,
    loadMarketplace: async () => loadFakeMarketplace(source),
    contributeGitHub: async (options) => await submitGitHubContribution({ ...options, env, run }),
    out: output.out,
    err: output.err,
  });
  expect(exitCode, [...output.stderr, ...output.stdout].join("\n")).toBe(1);
  const files = await readdir(learningOutboxDirectory(home));
  expect(files).toHaveLength(1);
  const operation = JSON.parse(await readFile(path.join(learningOutboxDirectory(home), files[0]), "utf8")) as LearningOperation;
  return {
    repo,
    retryCwd,
    home,
    source,
    remote,
    env,
    operation,
    counters,
    ghQueries,
    run,
    setPullRequest: (state, date = null, overrides = {}) => {
      pullRequestState = state;
      mergedAt = date;
      pullRequestHeadOwner = overrides.headOwner ?? "test-org";
      if (overrides.body !== undefined) pullRequestBody = overrides.body;
    },
    pullRequestBody: () => pullRequestBody,
  };
}

async function updateRemoteFile(fixture: RetryFixture, branch: string, destination: string, content: Uint8Array): Promise<void> {
  const work = await tempDir("teamai-learning-retry-edit-");
  const cloned = await runProcess("git", ["clone", fixture.remote, work]);
  if (cloned.exitCode !== 0) throw new Error(cloned.stderr);
  const checkout = await runProcess("git", ["checkout", "-b", branch, `origin/${branch}`], { cwd: work });
  if (checkout.exitCode !== 0) throw new Error(checkout.stderr);
  await mkdir(path.dirname(path.join(work, destination)), { recursive: true });
  await writeFile(path.join(work, destination), content);
  const added = await runProcess("git", ["-c", "core.autocrlf=false", "add", "--", destination], { cwd: work });
  if (added.exitCode !== 0) throw new Error(added.stderr);
  const commit = await runProcess("git", ["-c", "user.name=Retry User", "-c", "user.email=retry@example.invalid", "commit", "-m", "change learning fixture"], { cwd: work });
  if (commit.exitCode !== 0) throw new Error(commit.stderr);
  const pushed = await runProcess("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: work });
  if (pushed.exitCode !== 0) throw new Error(pushed.stderr);
}

async function readRemoteFile(fixture: RetryFixture, branch: string, destination: string): Promise<Buffer> {
  const shown = await runProcess("git", ["--git-dir", fixture.remote, "show", `refs/heads/${branch}:${destination}`]);
  if (shown.exitCode !== 0) throw new Error(shown.stderr);
  return Buffer.from(shown.stdout, "utf8");
}

async function retry(fixture: RetryFixture, argv = ["learning", "retry"]): Promise<{ exitCode: number; output: ReturnType<typeof capture> }> {
  const output = capture();
  const exitCode = await runCli([...argv, fixture.operation.id], {
    cwd: fixture.retryCwd,
    homeDir: fixture.home,
    contributeGitHub: async (options) => await submitGitHubContribution({ ...options, env: fixture.env, run: fixture.run }),
    out: output.out,
    err: output.err,
  });
  return { exitCode, output };
}

async function uuidJointFixture(logicalProject: string) {
  const repo = await createGitRepo();
  cleanup.add(repo);
  const home = await tempDir("teamai-uuid-producer-");
  const secondHome = await tempDir("teamai-uuid-consumer-");
  const secondWorkspace = await createGitRepo();
  cleanup.add(secondWorkspace);
  const { remote } = await marketplaceWithLearningRemote();
  const resource = await tempDir("teamai-uuid-resource-");
  const authority = await tempDir("teamai-uuid-authority-");
  const git = async (cwd: string, args: string[]) => {
    const result = await runProcess("git", args, { cwd });
    expect(result.exitCode, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  await git(resource, ["clone", "--no-hardlinks", remote, "."]);
  await git(authority, ["clone", "--no-hardlinks", "--branch", "teamai-learnings", "--single-branch", remote, "."]);
  const resourceRevision = await git(resource, ["rev-parse", "HEAD"]);
  const source = "https://github.com/test-org/teamai-marketplace.git";
  const config = createConfig({ name: TEST_MARKETPLACE_NAME, source });
  config.role = "api";
  await writeGlobalConfig(config, home);
  await writeGlobalConfig(config, secondHome);
  const fake = await createFakeCopilot({ fixtureSourceRoot: resource }, home);
  const secondFake = await createFakeCopilot({ fixtureSourceRoot: resource }, secondHome);
  cleanup.add(path.dirname(fake.statePath));
  cleanup.add(path.dirname(secondFake.statePath));
  const loadMarketplace = async () => ({ ...await loadFakeMarketplace(resource), revision: resourceRevision });
  const producer = { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace };
  const consumer = { cwd: secondWorkspace, homeDir: secondHome, copilot: secondFake.client, loadMarketplace };
  const initialSync = capture();
  expect(await runCli(["sync"], { ...producer, ...initialSync }), initialSync.stderr.join("\n")).toBe(0);
  if (logicalProject !== "shared") expect(await runCli(["projects", "set", logicalProject], { ...producer, ...capture() })).toBe(0);
  return { repo, home, authority, producer, consumer, git };
}

describe("learning share", () => {
  for (const logicalProject of ["shared", "payments.v2"]) describe.sequential(`keeps ${logicalProject} UUID identity through public share, pending and second-home published Recall`, () => {
    const ownedRoots = new Set<string>();
    let fixture: Awaited<ReturnType<typeof uuidJointFixture>>;
    let operation: LearningOperation;
    let frozenOutbox: Buffer;
    let outboxPath: string;
    let payload: Buffer;
    let expectedId: string;
    let expectedHash: string;
    let firstComplete = false;
    beforeAll(async () => {
      const priorCleanup = new Set(cleanup);
      try { fixture = await uuidJointFixture(logicalProject); }
      finally {
        for (const root of cleanup) if (!priorCleanup.has(root)) { ownedRoots.add(root); cleanup.delete(root); }
      }
    }, GIT_INTEGRATION_TIMEOUT);
    afterAll(async () => {
      await Promise.all([...ownedRoots].map((root) => rm(root, { recursive: true, force: true })));
    }, GIT_INTEGRATION_TIMEOUT);

    test("public share and pending preserve the same UUID and original body", async () => {
      const { repo, home, authority, producer, git } = fixture;
      const body = Buffer.from("NeedleUUID retry after token refresh.\r\n", "utf8");
      await writeFile(path.join(repo, "reviewed-learning-publication.md"), body);
      const baseCommit = await git(authority, ["rev-parse", "HEAD"]);
      const shared = capture();
      expect(await runCli(["learning", "share", "reviewed-learning-publication.md", ...(logicalProject === "shared" ? ["--shared"] : [])], {
        ...producer, ...shared,
        contributeGitHub: async (options) => {
          await options.prepare(authority);
          return { branch: options.branch, baseCommit, pullRequestUrl: "https://github.com/test-org/teamai-marketplace/pull/42", planned: [] };
        },
      }), shared.stderr.join("\n")).toBe(0);
      const files = await readdir(learningOutboxDirectory(home));
      outboxPath = path.join(learningOutboxDirectory(home), files[0]!);
      frozenOutbox = await readFile(outboxPath);
      operation = JSON.parse(frozenOutbox.toString("utf8"));
      expect(operation.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(operation.destination).toBe(`learnings/${logicalProject}/${operation.id}.md`);
      payload = Buffer.from(operation.payloadBase64, "base64");
      expectedHash = createHash("sha256").update(payload).digest("hex");
      expect(operation.contentHash).toBe(expectedHash);
      expect(payload.subarray(payload.length - body.length)).toEqual(body);
      expect(payload.toString("utf8")).toContain(`id: ${operation.id}\n`);
      expect(await readFile(path.join(authority, ...operation.destination.split("/")))).toEqual(payload);
      expectedId = `learning:${logicalProject}:${operation.id}`;
      const pending = capture();
      expect(await runCli(["recall", "NeedleUUID", "--include-pending", "--json"], { ...producer, ...pending }), pending.stderr.join("\n")).toBe(0);
      expect(JSON.parse(pending.stdout.join("\n")).hits[0]).toMatchObject({ id: expectedId, publication: "pending", source: { relativePath: operation.destination, contentHash: expectedHash } });
      firstComplete = true;
    }, GIT_INTEGRATION_TIMEOUT);

    test("second-home published Recall preserves identity, source bytes and the frozen outbox", async () => {
      expect(firstComplete, "The producer phase must complete before publication.").toBe(true);
      const { authority, producer, consumer, git } = fixture;
      // Local Git authority publication is a controlled fixture, not a real reviewed PR.
      await git(authority, ["-c", "core.autocrlf=false", "add", "-A"]);
      await git(authority, ["-c", "user.name=Team AI Test", "-c", "user.email=teamai@example.invalid", "-c", "core.autocrlf=false", "commit", "-m", "publish exact Learning payload fixture"]);
      await git(authority, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
      const revision = await git(authority, ["rev-parse", "HEAD"]);
      const sync = capture();
      expect(await runCli(["sync"], { ...consumer, ...sync }), sync.stderr.join("\n")).toBe(0);
      if (logicalProject !== "shared") expect(await runCli(["projects", "set", logicalProject], { ...consumer, ...capture() })).toBe(0);
      const recalled = capture();
      expect(await runCli(["recall", "NeedleUUID", "--json"], { ...consumer, ...recalled }), recalled.stderr.join("\n")).toBe(0);
      const hit = JSON.parse(recalled.stdout.join("\n")).hits[0];
      expect(hit).toMatchObject({ id: expectedId, publication: "published", logicalProject, source: { relativePath: operation.destination, revision, contentHash: expectedHash } });
      expect(await readFile(hit.file)).toEqual(payload);
      expect(hit.snippet).toBe(payload.toString("utf8").split(/\r\n|\n|\r/).slice(hit.lineStart - 1, hit.lineEnd).join("\n"));
      expect(await readFile(outboxPath)).toEqual(frozenOutbox);
      expect(await runCli(["sync"], { ...producer, ...capture() })).toBe(0);
      const both = capture();
      expect(await runCli(["recall", "NeedleUUID", "--include-pending", "--json"], { ...producer, ...both }), both.stderr.join("\n")).toBe(0);
      expect(JSON.parse(both.stdout.join("\n")).hits.map((item: { id: string; publication: string }) => ({ id: item.id, publication: item.publication })))
        .toEqual([{ id: expectedId, publication: "published" }, { id: expectedId, publication: "pending" }]);
    }, GIT_INTEGRATION_TIMEOUT);
  });

  test("routes one active project and creates minimal frontmatter in the contribution worktree", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-learning-home-");
    const source = await marketplace();
    const body = path.join(repo, "payment-retry.md");
    const staging = await tempDir("teamai-learning-staging-");
    const fake = await createFakeCopilot(undefined, home);
    await writeFile(body, "Retry only after token refresh.\n", "utf8");
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source }), home);
    await setActiveProjects(repo, home, ["payments.v2"]);
    const output = capture();
    const now = new Date("2026-09-22T00:00:00.000Z");
    let contributionBranch = "";

    expect(await runCli(["learning", "share", "payment-retry.md", "--tags", "payment,retry"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      now: () => now,
      loadMarketplace: async () => loadFakeMarketplace(source),
      contributeGitHub: async (options) => {
        contributionBranch = options.branch;
        expect(await readdir(learningOutboxDirectory(home))).toHaveLength(1);
        await options.checkpoint?.({ phase: "base-resolved", baseCommit: "a".repeat(40) });
        await options.prepare(staging);
        await options.checkpoint?.({ phase: "branch-pushed" });
        await options.checkpoint?.({ phase: "pr-open", pullRequestUrl: "https://github.com/test-org/teamai-marketplace/pull/42", pullRequestNumber: 42 });
        return { branch: options.branch, baseCommit: "a".repeat(40), pullRequestUrl: "https://github.com/test-org/teamai-marketplace/pull/42", planned: ["fixture contribution"] };
      },
      out: output.out,
      err: output.err,
    })).toBe(0);

    const outboxFiles = await readdir(learningOutboxDirectory(home));
    const operation = JSON.parse(await readFile(path.join(learningOutboxDirectory(home), outboxFiles[0]), "utf8"));
    const shared = await readFile(path.join(staging, "learnings", "payments.v2", `${operation.id}.md`), "utf8");
    expect(shared).toContain(`id: ${operation.id}`);
    expect(shared).toContain("title: payment retry");
    expect(shared).toContain("owner: Team AI Test");
    expect(shared).toContain("logicalProject: payments.v2");
    expect(shared).toContain("tags:\n  - payment\n  - retry");
    expect(shared).toContain("Retry only after token refresh.");
    expect(output.stdout.some((line) => line.includes(`learnings/payments.v2/${operation.id}.md`))).toBe(true);
    expect(contributionBranch).toMatch(/^teamai\/learning-[0-9a-f-]{36}$/);
    expect(operation).toMatchObject({
      remoteIdentity: "test-org/teamai-marketplace",
      logicalProject: "payments.v2",
      destination: `learnings/payments.v2/${operation.id}.md`,
      phase: "pr-open",
      status: "ready",
      baseBranch: "teamai-learnings",
      baseCommit: "a".repeat(40),
    });
    expect(operation.contentHash).toBe(learningHash(Buffer.from(operation.payloadBase64, "base64")));

    const pending = capture();
    expect(await runCli(["learning", "pending", "--json"], {
      cwd: repo,
      homeDir: home,
      loadMarketplace: async () => loadFakeMarketplace(source),
      out: pending.out,
      err: pending.err,
    })).toBe(0);
    expect(JSON.parse(pending.stdout[0]).operations[0]).toMatchObject({ id: operation.id, phase: "pr-open", status: "ready" });
  }, GIT_INTEGRATION_TIMEOUT);

  test("routes zero active projects to shared and requires an explicit target for multiple", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-learning-routing-home-");
    const source = await marketplace();
    const fake = await createFakeCopilot(undefined, home);
    await writeFile(path.join(repo, "note.md"), "A note.\n", "utf8");
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source }), home);
    const zero = capture();
    expect(await runCli(["--dry-run", "learning", "share", "note.md"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(source),
      out: zero.out,
      err: zero.err,
    })).toBe(0);
    await expect(readdir(learningOutboxDirectory(home))).rejects.toMatchObject({ code: "ENOENT" });
    expect(zero.stdout.some((line) => /^WOULD learning share: note\.md -> learnings\/shared\/[0-9a-f-]{36}\.md$/.test(line))).toBe(true);

    await setActiveProjects(repo, home, ["payments.v2", "risk"]);
    const multiple = capture();
    expect(await runCli(["learning", "share", "note.md"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(source),
      out: multiple.out,
      err: multiple.err,
    })).toBe(1);
    expect(multiple.stderr).toContain("ERROR: Multiple Logical Projects are active. Use --project <id> or --shared.");
    await expect(readdir(learningOutboxDirectory(home))).rejects.toMatchObject({ code: "ENOENT" });

    const explicit = capture();
    expect(await runCli(["--dry-run", "learning", "share", "note.md", "--project", "risk"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(source),
      out: explicit.out,
      err: explicit.err,
    })).toBe(0);
    expect(explicit.stdout.some((line) => /^WOULD learning share: note\.md -> learnings\/risk\/[0-9a-f-]{36}\.md$/.test(line))).toBe(true);
  }, GIT_INTEGRATION_TIMEOUT);

  test("learning pending is read-only and rejects its own invalid arguments", async () => {
    const home = await tempDir("teamai-learning-pending-home-");
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }), home);
    const output = capture();

    expect(await runCli(["learning", "pending", "--json"], { homeDir: home, cwd: process.cwd(), out: output.out, err: output.err })).toBe(0);
    expect(output.stdout).toEqual([JSON.stringify({ schemaVersion: 1, operations: [] })]);
    await expect(readdir(learningOutboxDirectory(home))).rejects.toMatchObject({ code: "ENOENT" });

    const invalid = capture();
    expect(await runCli(["learning", "pending", "--unknown"], { homeDir: home, cwd: process.cwd(), out: invalid.out, err: invalid.err })).toBe(2);
    expect(invalid.stderr[0]).toContain("Unknown option '--unknown'");
    await expect(readdir(learningOutboxDirectory(home))).rejects.toMatchObject({ code: "ENOENT" });

    const invalidJson = capture();
    expect(await runCli(["learning", "pending", "--json", "--unknown"], {
      homeDir: home,
      cwd: process.cwd(),
      out: invalidJson.out,
      err: invalidJson.err,
    })).toBe(2);
    expect(invalidJson.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      error: { code: "INVALID_ARGUMENT", message: "Unknown option '--unknown' for 'learning pending'." },
    })]);
    expect(invalidJson.stderr).toEqual([]);

    const freshHome = await tempDir("teamai-learning-pending-uninitialized-");
    const missingConfig = capture();
    expect(await runCli(["learning", "pending", "--json"], {
      homeDir: freshHome,
      cwd: process.cwd(),
      out: missingConfig.out,
      err: missingConfig.err,
    })).toBe(1);
    expect(missingConfig.stdout).toEqual([JSON.stringify({
      schemaVersion: 1,
      error: { code: "LEARNING_PENDING_FAILED", message: "Team AI is not initialized. Run `teamai init` first." },
    })]);
    expect(missingConfig.stderr).toEqual([]);
  }, GIT_INTEGRATION_TIMEOUT);

  test("invalid learning body and unknown manifest target fail before outbox or contribution", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-learning-validation-home-");
    const source = await marketplace();
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source }), home);
    await writeFile(path.join(repo, "note.md"), "A note.\n", "utf8");
    await writeFile(path.join(repo, "unsafe.md"), "---\ntitle: not body\n---\n\ntext\n", "utf8");
    let contributionCalls = 0;
    const overrides = {
      cwd: repo,
      homeDir: home,
      loadMarketplace: async () => loadFakeMarketplace(source),
      contributeGitHub: async () => {
        contributionCalls += 1;
        return { branch: "teamai/learning-test", planned: [] };
      },
    };

    expect(await runCli(["learning", "share", "unsafe.md"], overrides)).toBe(1);
    expect(await runCli(["learning", "share", "note.md", "--project", "missing"], overrides)).toBe(1);
    expect(contributionCalls).toBe(0);
    await expect(readdir(learningOutboxDirectory(home))).rejects.toMatchObject({ code: "ENOENT" });
  }, GIT_INTEGRATION_TIMEOUT);

  test("rejects NUL bytes before creating an outbox record or contributing", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-learning-nul-home-");
    const source = await marketplace();
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source }), home);
    await writeFile(path.join(repo, "binary.md"), Buffer.from("Markdown\0binary data\n"));
    let contributionCalls = 0;
    const output = capture();

    expect(await runCli(["learning", "share", "binary.md"], {
      cwd: repo,
      homeDir: home,
      loadMarketplace: async () => loadFakeMarketplace(source),
      contributeGitHub: async () => {
        contributionCalls += 1;
        return { branch: "teamai/learning-test", planned: [] };
      },
      out: output.out,
      err: output.err,
    })).toBe(1);
    expect(output.stderr[0]).toContain("without NUL bytes");
    expect(contributionCalls).toBe(0);
    await expect(readdir(learningOutboxDirectory(home))).rejects.toMatchObject({ code: "ENOENT" });
  }, GIT_INTEGRATION_TIMEOUT);

  test.each(["fetch", "missing-base", "push", "pr"] as const)("first share checkpoints %s failures without losing its outbox", async (failure) => {
    const repo = await createGitRepo();
    const home = await tempDir(`teamai-learning-${failure}-home-`);
    const { root: source, remote, baseCommit } = await marketplaceWithLearningRemote();
    const body = Buffer.from("Keep the original CRLF and UTF-8: café.\r\n", "utf8");
    await writeFile(path.join(repo, "note.md"), body);
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source }), home);
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();
    const ghCalls: string[][] = [];
    let sawDurableRecordBeforeClone = false;

    const exitCode = await runCli(["learning", "share", "note.md"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(source),
      contributeGitHub: async (options) => await submitGitHubContribution({
        ...options,
        run: async (command, args, runOptions) => {
          if (command === "git" && args[0] === "clone" && args[1] === "--bare") {
            const files = await readdir(learningOutboxDirectory(home));
            sawDurableRecordBeforeClone = files.length === 1;
            args = [...args.slice(0, 2), remote, ...args.slice(3)];
          }
          if ((failure === "fetch" || failure === "missing-base") && command === "git" && args[0] === "fetch") {
            return { exitCode: 1, stdout: "", stderr: failure === "missing-base" ? "fatal: couldn't find remote ref refs/heads/teamai-learnings" : "offline fixture" };
          }
          if (failure === "push" && command === "git" && args[0] === "push") {
            return { exitCode: 1, stdout: "", stderr: "offline fixture" };
          }
          if (command === "gh") {
            ghCalls.push(args);
            if (failure === "pr") return { exitCode: 1, stdout: "", stderr: "offline fixture" };
            return { exitCode: 0, stdout: "https://github.com/test-org/teamai-marketplace/pull/43\n", stderr: "" };
          }
          return await runProcess(command, args, runOptions);
        },
      }),
      out: output.out,
      err: output.err,
    });

    expect(sawDurableRecordBeforeClone).toBe(true);
    const files = await readdir(learningOutboxDirectory(home));
    expect(files).toHaveLength(1);
    const operation = JSON.parse(await readFile(path.join(learningOutboxDirectory(home), files[0]), "utf8"));
    expect(operation).toMatchObject({
      remoteIdentity: "test-org/teamai-marketplace",
      logicalProject: "shared",
      destination: `learnings/shared/${operation.id}.md`,
      baseBranch: "teamai-learnings",
    });
    const payload = Buffer.from(operation.payloadBase64, "base64");
    expect(payload.subarray(payload.length - body.length)).toEqual(body);
    expect(operation.contentHash).toBe(learningHash(payload));
    expect(operation.bodyBase64).toBe(body.toString("base64"));
    expect(operation.baseCommit).toBe(failure === "fetch" || failure === "missing-base" ? undefined : baseCommit);
    expect(operation.phase).toBe(failure === "pr" ? "branch-pushed" : "queued");
    expect(operation.status).toBe("retryable-error");
    expect(exitCode).toBe(1);
    const failureCode = {
      fetch: "BASE_FETCH_FAILED",
      "missing-base": "BASE_BRANCH_MISSING",
      push: "BRANCH_PUSH_FAILED",
      pr: "PULL_REQUEST_FAILED",
    }[failure];
    expect(operation.lastError.code).toBe(failureCode);
    expect(output.stderr[0]).toContain(`Learning contribution failed (${failureCode})`);
    expect(output.stderr[0]).toContain(`Saved operation ID: ${operation.id}`);
    expect(output.stderr[0]).toContain(`Last confirmed phase: ${operation.phase}`);
    expect(output.stderr[0]).toContain(`teamai learning retry ${operation.id}`);

    const remoteBranches = await runProcess("git", ["--git-dir", remote, "for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    expect(remoteBranches.exitCode).toBe(0);
    expect(remoteBranches.stdout.includes(operation.branch)).toBe(failure === "pr");
    expect(ghCalls.length).toBe(failure === "pr" ? 1 : 0);
    if (failure === "pr") {
      const branchParent = await runProcess("git", ["--git-dir", remote, "rev-parse", `${operation.branch}^`]);
      expect(branchParent.stdout.trim()).toBe(baseCommit);
      expect(ghCalls[0]).toEqual(expect.arrayContaining(["--repo", "test-org/teamai-marketplace", "--base", "teamai-learnings", "--head", operation.branch]));
    }

    const pending = capture();
    expect(await runCli(["learning", "pending", "--json"], {
      cwd: repo,
      homeDir: home,
      loadMarketplace: async () => loadFakeMarketplace(source),
      out: pending.out,
      err: pending.err,
    })).toBe(0);
    expect(JSON.parse(pending.stdout[0]).operations[0]).toMatchObject({
      id: operation.id,
      phase: operation.phase,
      status: "retryable-error",
      lastError: { code: failureCode },
    });
  }, GIT_INTEGRATION_TIMEOUT);

  test("learning retry validates its operation ID and argument count", async () => {
    const home = await tempDir("teamai-learning-retry-args-home-");
    const output = capture();
    expect(await runCli(["learning", "retry"], { homeDir: home, out: output.out, err: output.err })).toBe(2);
    expect(await runCli(["learning", "retry", "bad-id"], { homeDir: home, out: output.out, err: output.err })).toBe(2);
    expect(await runCli(["learning", "retry", "00000000-0000-4000-8000-000000000001", "extra"], { homeDir: home, out: output.out, err: output.err })).toBe(2);
    expect(await runCli(["learning", "retry", "00000000-0000-4000-8000-000000000001", "--unknown"], { homeDir: home, out: output.out, err: output.err })).toBe(2);
    expect(output.stderr.every((line) => line.startsWith("ERROR:"))).toBe(true);
    await expect(readdir(learningOutboxDirectory(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("learning retry dry-run previews the frozen operation without reading or writing remotely", async () => {
    const fixture = await frozenRetryFixture();
    const outboxPath = path.join(learningOutboxDirectory(fixture.home), `${fixture.operation.id}.json`);
    const before = await readFile(outboxPath);
    const output = capture();
    let contributionCalls = 0;
    const exitCode = await runCli(["--dry-run", "learning", "retry", fixture.operation.id], {
      cwd: fixture.retryCwd,
      homeDir: fixture.home,
      contributeGitHub: async () => {
        contributionCalls += 1;
        throw new Error("dry-run must not reach the contribution helper");
      },
      out: output.out,
      err: output.err,
    });
    expect(exitCode).toBe(0);
    expect(output.stdout.join("\n")).toContain(fixture.operation.destination);
    expect(contributionCalls).toBe(0);
    expect(await readFile(outboxPath)).toEqual(before);
    expect(await readFile(fixture.payloadPath)).toEqual(fixture.payload);
  }, GIT_INTEGRATION_TIMEOUT);

  test("learning retry preserves an existing frozen slug destination without renaming it", async () => {
    const fixture = await frozenRetryFixture();
    const outboxPath = path.join(learningOutboxDirectory(fixture.home), `${fixture.operation.id}.json`);
    const frozen = { ...fixture.operation, fileName: "note.md", destination: "learnings/shared/note.md" };
    await writeFile(outboxPath, JSON.stringify(frozen));
    const before = await readFile(outboxPath);
    const output = capture();
    let contributionCalls = 0;
    expect(await runCli(["--dry-run", "learning", "retry", frozen.id], {
      cwd: fixture.retryCwd, homeDir: fixture.home, ...output,
      contributeGitHub: async () => { contributionCalls += 1; throw new Error("dry-run must not contribute"); },
    }), [...output.stderr, ...output.stdout].join("\n")).toBe(0);
    expect(output.stdout.join("\n")).toContain(`WOULD learning payload: ${frozen.destination} sha256:${frozen.contentHash}`);
    expect(await readFile(outboxPath)).toEqual(before);
    expect(await readFile(fixture.payloadPath)).toEqual(fixture.payload);
    expect(contributionCalls).toBe(0);
  }, GIT_INTEGRATION_TIMEOUT);

  test.each(["push", "pr"] as const)("learning retry recovers a lost %s response without repeating it", async (lostResponse) => {
    const fixture = await retryFixture(lostResponse);
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source: "https://github.com/other-org/other-marketplace.git" }), fixture.home);
    const before = { ...fixture.counters };
    const result = await retry(fixture);
    expect(result.exitCode).toBe(0);
    expect(result.output.stderr).toEqual([]);
    expect(fixture.counters.pushes).toBe(before.pushes);
    expect(fixture.counters.prCreates).toBe(lostResponse === "push" ? 1 : before.prCreates);
    expect(fixture.counters.prLists).toBe(1);
    expect(fixture.ghQueries[0]).toEqual(expect.arrayContaining([
      "--method", "GET", "repos/test-org/teamai-marketplace/pulls", "-f", "state=all", "-f", "base=teamai-learnings", "-f", `head=test-org:${fixture.operation.branch}`,
    ]));
    expect(fixture.pullRequestBody()).toContain(`Operation ID: ${fixture.operation.id}`);
    expect(fixture.pullRequestBody()).toContain(`Payload SHA-256: ${fixture.operation.contentHash}`);
    const updated = JSON.parse(await readFile(path.join(learningOutboxDirectory(fixture.home), `${fixture.operation.id}.json`), "utf8")) as LearningOperation;
    expect(updated).toMatchObject({
      id: fixture.operation.id,
      sourceHash: fixture.operation.sourceHash,
      originWorkspaceKey: fixture.operation.originWorkspaceKey,
      logicalProject: fixture.operation.logicalProject,
      destination: fixture.operation.destination,
      contentHash: fixture.operation.contentHash,
      phase: "pr-open",
      status: "ready",
    });
    expect(Buffer.from(updated.payloadBase64, "base64")).toEqual(Buffer.from(fixture.operation.payloadBase64, "base64"));
    expect(await readRemoteFile(fixture, fixture.operation.branch, fixture.operation.destination))
      .toEqual(Buffer.from(fixture.operation.payloadBase64, "base64"));
  }, GIT_INTEGRATION_TIMEOUT);

  test.each([
    ["same-name fork PR", { headOwner: "attacker" }],
    ["PR with a different payload marker", { body: "Operation ID: 00000000-0000-4000-8000-000000000001\nPayload SHA-256: wrong" }],
  ] as const)("learning retry blocks an unrelated %s without pushing or creating another PR", async (_label, overrides) => {
    const fixture = await retryFixture("pr");
    fixture.setPullRequest("OPEN", null, overrides);
    const before = { ...fixture.counters };
    const result = await retry(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output.stderr.join("\n")).toContain("REMOTE_CONTENT_CONFLICT");
    expect(fixture.counters.pushes).toBe(before.pushes);
    expect(fixture.counters.prCreates).toBe(before.prCreates);
    const updated = JSON.parse(await readFile(path.join(learningOutboxDirectory(fixture.home), `${fixture.operation.id}.json`), "utf8")) as LearningOperation;
    expect(updated).toMatchObject({ status: "blocked", lastError: { code: "REMOTE_CONTENT_CONFLICT" } });
  }, GIT_INTEGRATION_TIMEOUT);

  test("learning retry uses frozen SSH source and author from a different directory without Git identity", async () => {
    const fixture = await retryFixture("push-before", "ssh");
    expect(fixture.operation.sourceRemote).toBe("ssh://git@github.com/test-org/teamai-marketplace.git");
    expect(fixture.operation.commitIdentity).toEqual({ name: "Team AI Test", email: "teamai@example.invalid" });
    await runProcess("git", ["config", "--unset-all", "user.name"], { cwd: fixture.retryCwd });
    await runProcess("git", ["config", "--unset-all", "user.email"], { cwd: fixture.retryCwd });

    const emptyGlobalConfig = path.join(await tempDir("teamai-learning-empty-git-config-"), "config");
    await writeFile(emptyGlobalConfig, "", "utf8");
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
    process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    try {
      const result = await retry(fixture);
      expect(result.exitCode, result.output.stderr.join("\n")).toBe(0);
      const author = await runProcess("git", ["--git-dir", fixture.remote, "show", "-s", "--format=%an%n%ae", fixture.operation.branch]);
      expect(author.stdout.trim().split(/\r?\n/)).toEqual(["Team AI Test", "teamai@example.invalid"]);
      expect(await readRemoteFile(fixture, fixture.operation.branch, fixture.operation.destination))
        .toEqual(Buffer.from(fixture.operation.payloadBase64, "base64"));
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
      else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
    }
  }, GIT_INTEGRATION_TIMEOUT);

  test("learning retry blocks a same-name branch with different content and never force-pushes", async () => {
    const fixture = await retryFixture("push");
    const payload = Buffer.from(fixture.operation.payloadBase64, "base64");
    await updateRemoteFile(fixture, fixture.operation.branch, fixture.operation.destination, Buffer.concat([payload, Buffer.from("remote edit\n")]));
    const remoteHead = await runProcess("git", ["--git-dir", fixture.remote, "rev-parse", `refs/heads/${fixture.operation.branch}`]);
    const result = await retry(fixture);
    expect(result.exitCode).toBe(1);
    expect(result.output.stderr.join("\n")).toContain("REMOTE_CONTENT_CONFLICT");
    expect(fixture.counters.pushes).toBe(1);
    expect(fixture.counters.prCreates).toBe(0);
    const after = await runProcess("git", ["--git-dir", fixture.remote, "rev-parse", `refs/heads/${fixture.operation.branch}`]);
    expect(after.stdout.trim()).toBe(remoteHead.stdout.trim());
    const updated = JSON.parse(await readFile(path.join(learningOutboxDirectory(fixture.home), `${fixture.operation.id}.json`), "utf8")) as LearningOperation;
    expect(updated).toMatchObject({ status: "blocked", lastError: { code: "REMOTE_CONTENT_CONFLICT" } });
  }, GIT_INTEGRATION_TIMEOUT);

  test.each([
    ["merged exact content", "MERGED", "exact", 0, "published", "complete"],
    ["merged modified content", "MERGED", "modified", 1, "branch-pushed", "blocked"],
    ["closed without merge", "CLOSED", "unchanged", 0, "closed-without-merge", "complete"],
  ] as const)("learning retry classifies %s separately", async (_label, state, content, expectedExit, phase, status) => {
    const fixture = await retryFixture("pr");
    fixture.setPullRequest(state, state === "MERGED" ? "2026-09-29T00:00:00Z" : null);
    if (content !== "unchanged") {
      const payload = Buffer.from(fixture.operation.payloadBase64, "base64");
      await updateRemoteFile(
        fixture,
        "teamai-learnings",
        fixture.operation.destination,
        content === "exact" ? payload : Buffer.concat([payload, Buffer.from("reviewed edit\n")]),
      );
      expect(await readRemoteFile(fixture, "teamai-learnings", fixture.operation.destination)).toEqual(
        content === "exact" ? payload : Buffer.concat([payload, Buffer.from("reviewed edit\n")]),
      );
    }
    const result = await retry(fixture);
    expect(result.exitCode, result.output.stderr.join("\n")).toBe(expectedExit);
    expect(fixture.counters.pushes).toBe(1);
    expect(fixture.counters.prCreates).toBe(1);
    const updated = JSON.parse(await readFile(path.join(learningOutboxDirectory(fixture.home), `${fixture.operation.id}.json`), "utf8")) as LearningOperation;
    expect(updated).toMatchObject({ phase, status });
    if (state === "MERGED" && content === "modified") {
      expect(updated.lastError?.code).toBe("MERGED_CONTENT_MODIFIED");
    }
    if (content === "exact") expect(result.output.stdout.join("\n")).toContain("published");
    if (state === "CLOSED") expect(result.output.stdout.join("\n")).toContain("closed without merging");
  }, GIT_INTEGRATION_TIMEOUT);

  test("integration: isolated local Git worktree and mocked gh create a branch contribution", async () => {
    const source = await createGitRepo();
    const remote = path.join(await tempDir("teamai-learning-remote-"), "marketplace.git");
    const initialized = await runProcess("git", ["init", "--bare", remote]);
    if (initialized.exitCode !== 0) throw new Error(initialized.stderr);
    await runProcess("git", ["remote", "add", "origin", remote], { cwd: source });
    const pushed = await runProcess("git", ["push", "-u", "origin", "main"], { cwd: source });
    if (pushed.exitCode !== 0) throw new Error(pushed.stderr);
    const defaultBranch = await runProcess("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
    if (defaultBranch.exitCode !== 0) throw new Error(defaultBranch.stderr);
    const gitConfig = path.join(await tempDir("teamai-learning-git-config-"), "config");
    await writeFile(gitConfig, `[url \"${pathToFileURL(remote).href}\"]\n\tinsteadOf = https://github.com/test-org/teamai-marketplace.git\n`, "utf8");
    const environment = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
    const ghCalls: string[][] = [];

    const result = await submitGitHubContribution({
      remote: "https://github.com/test-org/teamai-marketplace.git",
      branch: "teamai/learning-shared-123",
      identity: { name: "Team AI Test", email: "teamai@example.invalid" },
      commitMessage: "teamai: share learning example",
      pullRequestTitle: "Share learning: example",
      pullRequestBody: "fixture",
      env: environment,
      run: async (command, args, options) => {
        if (command === "gh") {
          ghCalls.push(args);
          return { exitCode: 0, stdout: "https://github.com/test-org/teamai-marketplace/pull/42\n", stderr: "" };
        }
        return await runProcess(command, args, options);
      },
      prepare: async (worktree) => {
        const target = path.join(worktree, "learnings", "shared", "example.md");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "example\n", "utf8");
        return ["learnings/shared/example.md"];
      },
    });

    expect(result.pullRequestUrl).toBe("https://github.com/test-org/teamai-marketplace/pull/42");
    expect(ghCalls).toEqual([["pr", "create", "--title", "Share learning: example", "--body", "fixture", "--head", "teamai/learning-shared-123"]]);
    const committed = await runProcess("git", ["--git-dir", remote, "show", "teamai/learning-shared-123:learnings/shared/example.md"]);
    expect(committed.stdout).toBe("example\n");
  }, GIT_INTEGRATION_TIMEOUT);

  test("dry run creates no branch, commit, push, or pull request", async () => {
    let calls = 0;
    const result = await submitGitHubContribution({
      remote: "https://github.com/test-org/teamai-marketplace.git",
      branch: "teamai/learning-shared-123",
      identity: { name: "Team AI Test", email: "teamai@example.invalid" },
      commitMessage: "teamai: share learning example",
      pullRequestTitle: "Share learning: example",
      pullRequestBody: "fixture",
      dryRun: true,
      run: async () => {
        calls += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      prepare: async () => {
        throw new Error("dry run must not prepare a worktree");
      },
    });
    expect(calls).toBe(0);
    expect(result.planned).toContain("git push -u origin teamai/learning-shared-123");
  });

  test("resolves a local Marketplace through its GitHub origin", async () => {
    const source = await marketplace();
    await expect(resolveGitHubMarketplaceRemote(source, source)).resolves.toBe("https://github.com/test-org/teamai-marketplace.git");
    await expect(resolveGitHubMarketplaceRemote("git@github.com:test-org/teamai-marketplace", source))
      .resolves.toBe("git@github.com:test-org/teamai-marketplace.git");
    let credentialError = "";
    try {
      await resolveGitHubMarketplaceRemote("https://token:secret@github.com/test-org/teamai-marketplace.git", source);
    } catch (error) {
      credentialError = (error as Error).message;
    }
    expect(credentialError).toContain("must not contain credentials");
    expect(credentialError).not.toContain("secret");
    const withoutOrigin = await createGitRepo();
    await expect(resolveGitHubMarketplaceRemote(withoutOrigin, withoutOrigin)).rejects.toThrow("has no origin remote");
  }, GIT_INTEGRATION_TIMEOUT);
});
