import { mkdir, readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { resolveGitHubMarketplaceRemote, submitGitHubContribution } from "../../src/contribution/github.js";
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
        await options.prepare(staging);
        return { branch: options.branch, planned: ["fixture contribution"] };
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
    expect(contributionBranch).toBe(`teamai/learning-payments-v2-${now.getTime()}`);
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
