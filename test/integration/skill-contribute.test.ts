import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { submitGitHubContribution } from "../../src/contribution/github.js";
import { writeGlobalConfig } from "../../src/config/global.js";
import { createConfig } from "../../src/config/schema.js";
import { TEAM_AI_EXTENSION_NAMESPACE } from "../../src/copilot/catalog.js";
import { runProcess } from "../../src/utils/process.js";
import { createFakeCopilot, createGitRepo, tempDir, TEST_MARKETPLACE_NAME } from "../helpers/test-utils.js";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map(async (target) => await rm(target, { recursive: true, force: true })));
  cleanup.clear();
});

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}

async function marketplace(): Promise<{ root: string; bare: string }> {
  const root = await tempDir("teamai-skill-contribute-marketplace-");
  const bareParent = await tempDir("teamai-skill-contribute-remote-");
  cleanup.add(root);
  cleanup.add(bareParent);
  const bare = path.join(bareParent, "marketplace.git");
  await git(bareParent, ["init", "--bare", bare]);
  await mkdir(path.join(root, ".github", "plugin"), { recursive: true });
  for (const [name, kind] of [["common", "common"], ["api", "role"]]) {
    await mkdir(path.join(root, "plugins", name), { recursive: true });
    await writeFile(path.join(root, "plugins", name, "plugin.json"), JSON.stringify({
      name,
      version: "0.1.0",
      extensions: { [TEAM_AI_EXTENSION_NAMESPACE]: { kind } },
    }), "utf8");
  }
  await writeFile(path.join(root, ".github", "plugin", "marketplace.json"), JSON.stringify({
    name: TEST_MARKETPLACE_NAME,
    plugins: ["common", "api"].map((name) => ({ name, version: "0.1.0", source: `./plugins/${name}` })),
  }), "utf8");
  await writeFile(path.join(root, "skills.yaml"), "version: 1\nskills: {}\n", "utf8");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.name", "Marketplace Test"]);
  await git(root, ["config", "user.email", "marketplace@example.invalid"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "origin", bare]);
  await git(root, ["push", "-u", "origin", "main"]);
  await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(root, ["remote", "set-url", "origin", "https://github.com/test-org/teamai-marketplace.git"]);
  return { root, bare };
}

test("integration: skill contribute uses an isolated worktree and mocked gh", async () => {
  const business = await createGitRepo();
  const home = await tempDir("teamai-skill-contribute-home-");
  cleanup.add(business);
  cleanup.add(home);
  const remote = await marketplace();
  const source = path.join(business, "release-helper");
  await mkdir(path.join(source, "resources"), { recursive: true });
  await writeFile(path.join(source, "SKILL.md"), "---\nname: release-helper\ndescription: Release help\n---\n", "utf8");
  await writeFile(path.join(source, "resources", "note.txt"), "resource\n", "utf8");
  await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source: remote.root }), home);
  const fake = await createFakeCopilot();
  cleanup.add(path.dirname(fake.statePath));
  const gitConfigRoot = await tempDir("teamai-skill-contribute-git-config-");
  cleanup.add(gitConfigRoot);
  const gitConfig = path.join(gitConfigRoot, "config");
  await writeFile(gitConfig, `[url \"${pathToFileURL(remote.bare).href}\"]\n\tinsteadOf = https://github.com/test-org/teamai-marketplace.git\n`, "utf8");
  const environment = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const resourceBase = (await runProcess("git", ["--git-dir", remote.bare, "rev-parse", "refs/heads/main"])).stdout.trim();
  const now = new Date("2026-09-22T00:00:00.000Z");
  const stdout: string[] = [];
  const ghCalls: string[][] = [];
  const context = {
    cwd: business,
    homeDir: home,
    copilot: fake.client,
    now: () => now,
    out: (line: string) => stdout.push(line),
    err: () => undefined,
    contributeGitHub: async (options: Parameters<typeof submitGitHubContribution>[0]) => await submitGitHubContribution({
      ...options,
      env: environment,
      run: async (command, args, options) => {
        if (command === "gh") {
          ghCalls.push(args);
          return { exitCode: 0, stdout: "https://github.com/test-org/teamai-marketplace/pull/77\n", stderr: "" };
        }
        return await runProcess(command, args, options);
      },
    }),
  };

  expect(await runCli(["--dry-run", "skill", "contribute", "release-helper", "--owner", "release-team", "--tags", "release", "--target", "plugin", "--plugin", "api"], context)).toBe(0);
  expect(stdout.some((line) => line.includes("WOULD contribution: git push"))).toBe(true);
  stdout.length = 0;

  expect(await runCli(["skill", "contribute", "release-helper", "--owner", "release-team", "--tags", "release", "experimental", "--target", "standalone"], context)).toBe(0);
  expect(stdout).toContain("Pull request: https://github.com/test-org/teamai-marketplace/pull/77");
  const branch = `teamai/skill-release-helper-${now.getTime()}`;
  const branchBase = await runProcess("git", ["--git-dir", remote.bare, "rev-parse", `${branch}^`]);
  expect(branchBase.stdout.trim()).toBe(resourceBase);
  expect(ghCalls[0]).not.toContain("teamai-learnings");
  const skill = await runProcess("git", ["--git-dir", remote.bare, "show", `${branch}:skills/release-helper/SKILL.md`]);
  expect(skill.stdout).toContain("name: release-helper");
  const metadata = await runProcess("git", ["--git-dir", remote.bare, "show", `${branch}:skills.yaml`]);
  expect(metadata.stdout).toContain("release-helper:");
  expect(metadata.stdout).toContain("owner: release-team");
  expect(metadata.stdout).toContain("standalone: true");
}, 30_000);
