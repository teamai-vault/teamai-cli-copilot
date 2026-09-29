import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { resolveGitHubMarketplaceRemote, submitGitHubContribution } from "../../src/contribution/github.js";
import { learningHash, learningOutboxDirectory } from "../../src/contribution/learning-outbox.js";
import { writeGlobalConfig } from "../../src/config/global.js";
import { createConfig } from "../../src/config/schema.js";
import { detectProjectIdentity } from "../../src/project/anchors.js";
import { projectionKey } from "../../src/project/context.js";
import { writeProjectState } from "../../src/project/state.js";
import { runProcess } from "../../src/utils/process.js";
import { createFakeCopilot, createGitRepo, loadFakeMarketplace, tempDir, TEST_MARKETPLACE_NAME } from "../helpers/test-utils.js";

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

describe("learning share", () => {
  test("routes one active project and creates minimal frontmatter in the contribution worktree", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-learning-home-");
    const source = await marketplace();
    const body = path.join(repo, "payment-retry.md");
    const staging = await tempDir("teamai-learning-staging-");
    const fake = await createFakeCopilot();
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

    const shared = await readFile(path.join(staging, "learnings", "payments.v2", "payment-retry.md"), "utf8");
    expect(shared).toContain("title: payment retry");
    expect(shared).toContain("owner: Team AI Test");
    expect(shared).toContain("logicalProject: payments.v2");
    expect(shared).toContain("tags:\n  - payment\n  - retry");
    expect(shared).toContain("Retry only after token refresh.");
    expect(output.stdout.some((line) => line.includes("learnings/payments.v2/payment-retry.md"))).toBe(true);
    expect(contributionBranch).toMatch(/^teamai\/learning-[0-9a-f-]{36}$/);
    const outboxFiles = await readdir(learningOutboxDirectory(home));
    const operation = JSON.parse(await readFile(path.join(learningOutboxDirectory(home), outboxFiles[0]), "utf8"));
    expect(operation).toMatchObject({
      remoteIdentity: "test-org/teamai-marketplace",
      logicalProject: "payments.v2",
      destination: "learnings/payments.v2/payment-retry.md",
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
  });

  test("routes zero active projects to shared and requires an explicit target for multiple", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-learning-routing-home-");
    const source = await marketplace();
    const fake = await createFakeCopilot();
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
    expect(zero.stdout.some((line) => line.includes("learnings/shared/note.md"))).toBe(true);

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
    expect(explicit.stdout.some((line) => line.includes("learnings/risk/note.md"))).toBe(true);
  }, 15_000);

  test("learning pending is read-only and rejects its own invalid arguments", async () => {
    const home = await tempDir("teamai-learning-pending-home-");
    const source = await marketplace();
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source }), home);
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
  });

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
  });

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
  });

  test.each(["fetch", "missing-base", "push", "pr"] as const)("first share checkpoints %s failures without losing its outbox", async (failure) => {
    const repo = await createGitRepo();
    const home = await tempDir(`teamai-learning-${failure}-home-`);
    const { root: source, remote, baseCommit } = await marketplaceWithLearningRemote();
    const body = Buffer.from("Keep the original CRLF and UTF-8: café.\r\n", "utf8");
    await writeFile(path.join(repo, "note.md"), body);
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source }), home);
    const fake = await createFakeCopilot();
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
      destination: "learnings/shared/note.md",
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
    expect(output.stderr[0]).toContain("command is not available yet");
    expect(output.stderr[0]).toContain("teamai learning pending");

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
  }, 20_000);

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
  });

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
    const withoutOrigin = await createGitRepo();
    await expect(resolveGitHubMarketplaceRemote(withoutOrigin, withoutOrigin)).rejects.toThrow("has no origin remote");
  });
});
