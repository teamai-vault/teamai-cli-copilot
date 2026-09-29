import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { runProcess } from "../../src/utils/process.js";

const scriptPath = fileURLToPath(new URL("../../scripts/init-learnings-branch.mjs", import.meta.url));
const BRANCH_REF = "refs/heads/teamai-learnings";
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function git(args: string[], cwd?: string): Promise<string> {
  const result = await runProcess("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

async function fixture(withExistingLearnings = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "teamai-learnings-branch-test-"));
  cleanup.push(root);
  const remote = path.join(root, "marketplace.git");
  const checkout = path.join(root, "user-checkout");
  const tempParent = path.join(root, "script-temp");

  await git(["init", "--bare", remote]);
  await git(["init", "-b", "main", checkout]);
  await git(["config", "user.name", "Fixture User"], checkout);
  await git(["config", "user.email", "fixture@example.invalid"], checkout);
  await writeFile(path.join(checkout, "README.md"), "fixture\n", "utf8");
  await git(["add", "README.md"], checkout);
  await git(["commit", "-m", "fixture base"], checkout);
  await git(["remote", "add", "origin", remote], checkout);
  await git(["push", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/preserved"], checkout);
  await git(["tag", "fixture-tag"], checkout);
  await git(["push", "origin", "refs/tags/fixture-tag"], checkout);
  await git(["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);

  if (withExistingLearnings) {
    await writeFile(path.join(checkout, "existing-learning.md"), "existing\n", "utf8");
    await git(["add", "existing-learning.md"], checkout);
    await git(["commit", "-m", "existing learnings branch"], checkout);
    await git(["push", "origin", `HEAD:${BRANCH_REF}`], checkout);
  }

  const userFile = path.join(checkout, "user-untracked.txt");
  await writeFile(userFile, "leave this checkout alone\n", "utf8");
  await mkdir(tempParent);

  return { root, remote, checkout, tempParent, userFile };
}

async function remoteRefs(remote: string): Promise<string[]> {
  const refs = await git(["--git-dir", remote, "for-each-ref", "--format=%(refname) %(objectname)"]);
  return refs ? refs.split(/\r?\n/).sort() : [];
}

async function checkoutState(checkout: string, userFile: string) {
  return {
    head: await git(["rev-parse", "HEAD"], checkout),
    refs: await git(["for-each-ref", "--format=%(refname) %(objectname)"], checkout),
    status: await git(["status", "--porcelain", "--untracked-files=all"], checkout),
    userFile: await readFile(userFile, "utf8"),
  };
}

function scriptEnv(tempParent: string, extraEnv: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    TEMP: tempParent,
    TMP: tempParent,
    TMPDIR: tempParent,
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "user.name",
    GIT_CONFIG_VALUE_0: "Fixture User",
    GIT_CONFIG_KEY_1: "user.email",
    GIT_CONFIG_VALUE_1: "fixture@example.invalid",
    ...extraEnv,
  };
}

async function runBootstrap(
  source: string,
  checkout: string,
  tempParent: string,
  apply = false,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return await runProcess(process.execPath, [
    scriptPath,
    "--marketplace",
    source,
    ...(apply ? ["--apply"] : []),
  ], { cwd: checkout, env: scriptEnv(tempParent, extraEnv) });
}

describe("Learnings branch bootstrap tool", () => {
  test("previews without changing refs or the caller checkout", async () => {
    const { remote, checkout, tempParent, userFile } = await fixture();
    const refsBefore = await remoteRefs(remote);
    const checkoutBefore = await checkoutState(checkout, userFile);

    const result = await runBootstrap(remote, checkout, tempParent);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Preview");
    expect(result.stdout).toContain("teamai-learnings");
    expect(await remoteRefs(remote)).toEqual(refsBefore);
    expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
    expect(await readdir(tempParent)).toEqual([]);
  }, 20_000);

  test("applies a parentless root commit and pushes only the new branch", async () => {
    const { remote, checkout, tempParent, userFile } = await fixture();
    const refsBefore = await remoteRefs(remote);
    const checkoutBefore = await checkoutState(checkout, userFile);

    const result = await runBootstrap(remote, checkout, tempParent, true);

    expect(result.exitCode).toBe(0);
    const newRef = await git(["--git-dir", remote, "rev-list", "--parents", "-n", "1", BRANCH_REF]);
    expect(newRef.split(" ")).toHaveLength(1);
    expect(await remoteRefs(remote)).toEqual([...refsBefore, `${BRANCH_REF} ${newRef}`].sort());
    expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
    expect(await readdir(tempParent)).toEqual([]);
  }, 20_000);

  test("previews and applies from a non-Git directory without changing the caller checkout", async () => {
    const { root, remote, checkout, tempParent, userFile } = await fixture();
    const nonGitCwd = path.join(root, "non-git-cwd");
    await mkdir(nonGitCwd);
    const refsBefore = await remoteRefs(remote);
    const checkoutBefore = await checkoutState(checkout, userFile);

    const preview = await runBootstrap(remote, nonGitCwd, tempParent);
    expect(preview.exitCode).toBe(0);
    expect(preview.stdout).toContain("Preview");
    expect(await remoteRefs(remote)).toEqual(refsBefore);
    expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
    expect(await readdir(tempParent)).toEqual([]);

    const apply = await runBootstrap(remote, nonGitCwd, tempParent, true);
    expect(apply.exitCode).toBe(0);
    const rootCommit = await git(["--git-dir", remote, "rev-list", "--parents", "-n", "1", BRANCH_REF]);
    expect(rootCommit.split(" ")).toHaveLength(1);
    expect(await remoteRefs(remote)).toEqual([...refsBefore, `${BRANCH_REF} ${rootCommit}`].sort());
    expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
    expect(await readdir(tempParent)).toEqual([]);
  }, 30_000);

  test("rejects a checkout path even when injected Git config claims it is bare", async () => {
    const { remote, checkout, tempParent, userFile } = await fixture();
    const refsBefore = await remoteRefs(remote);
    const checkoutBefore = await checkoutState(checkout, userFile);
    const injectedConfig: NodeJS.ProcessEnv = {
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.bare",
      GIT_CONFIG_VALUE_2: "true",
    };

    for (const apply of [false, true]) {
      const result = await runBootstrap(checkout, checkout, tempParent, apply, injectedConfig);
      expect(result.exitCode).not.toBe(0);
      expect(`${result.stdout}\n${result.stderr}`).toContain("must be a bare repository");
      expect(await remoteRefs(remote)).toEqual(refsBefore);
      expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
      expect(await readdir(tempParent)).toEqual([]);
    }
  }, 30_000);

  test("stops when the authority branch already exists", async () => {
    const { remote, checkout, tempParent, userFile } = await fixture(true);
    const refsBefore = await remoteRefs(remote);
    const checkoutBefore = await checkoutState(checkout, userFile);

    const result = await runBootstrap(remote, checkout, tempParent, true);

    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("already exists");
    expect(await remoteRefs(remote)).toEqual(refsBefore);
    expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
    expect(await readdir(tempParent)).toEqual([]);
  }, 20_000);

  test("concurrent initialization never overwrites the winning branch", async () => {
    const { remote, checkout, tempParent } = await fixture();
    const firstTemp = path.join(tempParent, "first");
    const secondTemp = path.join(tempParent, "second");
    await Promise.all([mkdir(firstTemp), mkdir(secondTemp)]);
    const refsBefore = await remoteRefs(remote);

    const results = await Promise.all([
      runBootstrap(remote, checkout, firstTemp, true),
      runBootstrap(remote, checkout, secondTemp, true),
    ]);

    expect(results.filter((result) => result.exitCode === 0)).toHaveLength(1);
    expect(results.filter((result) => result.exitCode !== 0)).toHaveLength(1);
    const newRef = await git(["--git-dir", remote, "rev-list", "--parents", "-n", "1", BRANCH_REF]);
    expect(newRef.split(" ")).toHaveLength(1);
    expect(await remoteRefs(remote)).toEqual([...refsBefore, `${BRANCH_REF} ${newRef}`].sort());
    expect(await readdir(firstTemp)).toEqual([]);
    expect(await readdir(secondTemp)).toEqual([]);
  }, 30_000);

  test.each([
    "local fetch insteadOf",
    "local pushInsteadOf",
  ])("ignores caller-local %s while targeting only the supplied remote", async (attack) => {
    const { root, remote, checkout, tempParent, userFile } = await fixture();
    const wrongRemote = path.join(root, "wrong-marketplace.git");
    await git(["init", "--bare", wrongRemote]);
    await git(["push", wrongRemote, "HEAD:refs/heads/main", "HEAD:refs/heads/preserved"], checkout);
    await git(["--git-dir", wrongRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);

    if (attack === "local fetch insteadOf") {
      await git(["config", "--add", `url.${wrongRemote}.insteadOf`, remote], checkout);
    } else {
      await git(["config", "--add", `url.${wrongRemote}.pushInsteadOf`, remote], checkout);
    }

    const targetRefsBefore = await remoteRefs(remote);
    const wrongRefsBefore = await remoteRefs(wrongRemote);
    const checkoutBefore = await checkoutState(checkout, userFile);

    for (const apply of [false, true]) {
      const result = await runBootstrap(remote, checkout, tempParent, apply);
      expect(result.exitCode).toBe(0);
      if (apply) {
        const rootCommit = await git(["--git-dir", remote, "rev-list", "--parents", "-n", "1", BRANCH_REF]);
        expect(rootCommit.split(" ")).toHaveLength(1);
        expect(await remoteRefs(remote)).toEqual([...targetRefsBefore, `${BRANCH_REF} ${rootCommit}`].sort());
      } else {
        expect(result.stdout).toContain("Preview");
        expect(await remoteRefs(remote)).toEqual(targetRefsBefore);
      }
      expect(await remoteRefs(wrongRemote)).toEqual(wrongRefsBefore);
      expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
      expect(await readdir(tempParent)).toEqual([]);
    }
  }, 30_000);

  test.each([
    "GIT_CONFIG_COUNT insteadOf",
    "GIT_CONFIG_COUNT pushInsteadOf",
    "GIT_NAMESPACE",
  ])(
    "rejects %s for preview and apply without touching either remote",
    async (attack) => {
      const { root, remote, checkout, tempParent, userFile } = await fixture();
      const wrongRemote = path.join(root, "wrong-marketplace.git");
      await git(["init", "--bare", wrongRemote]);
      await git(["push", wrongRemote, "HEAD:refs/heads/main", "HEAD:refs/heads/preserved"], checkout);
      await git(["--git-dir", wrongRemote, "symbolic-ref", "HEAD", "refs/heads/main"]);

      const extraEnv: NodeJS.ProcessEnv = {};
      if (attack === "GIT_CONFIG_COUNT insteadOf" || attack === "GIT_CONFIG_COUNT pushInsteadOf") {
        extraEnv.GIT_CONFIG_COUNT = "3";
        extraEnv.GIT_CONFIG_KEY_2 = `url.${wrongRemote}.${attack.endsWith("pushInsteadOf") ? "pushInsteadOf" : "insteadOf"}`;
        extraEnv.GIT_CONFIG_VALUE_2 = remote;
      } else {
        extraEnv.GIT_NAMESPACE = "fixture-namespace";
      }

      const targetRefsBefore = await remoteRefs(remote);
      const wrongRefsBefore = await remoteRefs(wrongRemote);
      const checkoutBefore = await checkoutState(checkout, userFile);

      for (const apply of [false, true]) {
        const result = await runBootstrap(remote, checkout, tempParent, apply, extraEnv);
        expect(result.exitCode).not.toBe(0);
        expect(`${result.stdout}\n${result.stderr}`).toMatch(/resolution|GIT_NAMESPACE/);
        expect(await remoteRefs(remote)).toEqual(targetRefsBefore);
        expect(await remoteRefs(wrongRemote)).toEqual(wrongRefsBefore);
        expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
        expect(await readdir(tempParent)).toEqual([]);
      }
    },
    30_000,
  );

  test("does not overwrite a branch created after the second existence check", async () => {
    const { root, remote, checkout, tempParent, userFile } = await fixture();
    const hooksPath = path.join(root, "hooks");
    await mkdir(hooksPath);
    const hook = path.join(hooksPath, "pre-push");
    await writeFile(hook, [
      "#!/bin/sh",
      `git --git-dir=\"$TEAMAI_FIXTURE_REMOTE\" update-ref ${BRANCH_REF} \"$TEAMAI_FIXTURE_COMPETING_SHA\"`,
      "",
    ].join("\n"), "utf8");
    await chmod(hook, 0o755);
    const competingSha = await git(["rev-parse", "HEAD"], checkout);
    const refsBefore = await remoteRefs(remote);
    const checkoutBefore = await checkoutState(checkout, userFile);
    const result = await runBootstrap(remote, checkout, tempParent, true, {
      TEAMAI_FIXTURE_REMOTE: remote,
      TEAMAI_FIXTURE_COMPETING_SHA: competingSha,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_2: "core.hooksPath",
      GIT_CONFIG_VALUE_2: hooksPath,
    });

    expect(result.exitCode).not.toBe(0);
    expect(await remoteRefs(remote)).toEqual([...refsBefore, `${BRANCH_REF} ${competingSha}`].sort());
    expect(await checkoutState(checkout, userFile)).toEqual(checkoutBefore);
    expect(await readdir(tempParent)).toEqual([]);
  }, 30_000);
});
