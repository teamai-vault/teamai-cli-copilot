import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { builtInTeamAiSkillTarget } from "../../src/copilot/builtin-skill.js";
import {
  createFakeCopilot,
  createGitRepo,
  loadFakeMarketplace,
  tempDir,
  TEST_MARKETPLACE_SOURCE,
} from "../helpers/test-utils.js";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map((root) => rm(root, { recursive: true, force: true })));
  cleanup.clear();
});

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (message: string) => stdout.push(message),
    err: (message: string) => stderr.push(message),
  };
}

describe("built-in Team AI Skill CLI convergence", () => {
  test("init installs it independently of Marketplace Skills and sync repairs it", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-builtin-cli-home-");
    cleanup.add(repo);
    cleanup.add(home);
    const fake = await createFakeCopilot(undefined, home);
    const loadMarketplace = async () => await loadFakeMarketplace();
    const base = { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace };

    const initOutput = capture();
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      ...base,
      out: initOutput.out,
      err: initOutput.err,
    })).toBe(0);
    expect(initOutput.stdout).toContain("DONE create: ~/.copilot/skills/teamai");

    const skillFile = path.join(builtInTeamAiSkillTarget(home), "SKILL.md");
    expect(await readFile(skillFile, "utf8")).toContain("name: teamai");

    await writeFile(skillFile, "stale\n", "utf8");
    const syncOutput = capture();
    expect(await runCli(["sync"], { ...base, out: syncOutput.out, err: syncOutput.err })).toBe(0);
    expect(syncOutput.stdout).toContain("DONE update: ~/.copilot/skills/teamai");
    expect(await readFile(skillFile, "utf8")).toContain("name: teamai");

    const doctorOutput = capture();
    expect(await runCli(["doctor"], { ...base, out: doctorOutput.out, err: doctorOutput.err })).toBe(0);
    expect(doctorOutput.stdout.some((line) => line.includes("Built-in Team AI Skill: current"))).toBe(true);
  }, 60_000);
});
