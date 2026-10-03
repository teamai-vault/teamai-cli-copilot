import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { CopilotUnavailableError } from "../../src/copilot/cli.js";
import { builtInRecallAgentOwnershipPath, builtInRecallAgentTarget } from "../../src/copilot/builtin-agent.js";
import { createFakeCopilot, createGitRepo, loadFakeMarketplace, tempDir, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";
const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function capture() {
  const stdout: string[] = [], stderr: string[] = [];
  return { stdout, stderr, out: (s: string) => stdout.push(s), err: (s: string) => stderr.push(s) };
}
describe("native builtin Recall Agent public commands", () => {
  test("init and sync deliver the Agent and status/doctor separate delivery from unknown consumer runtime", async () => {
    const cwd = await createGitRepo(), homeDir = await tempDir("teamai-agent-cli-");
    cleanup.push(cwd, homeDir);
    const custom = path.join(homeDir, "custom home");
    vi.stubEnv("COPILOT_HOME", custom);
    const fake = await createFakeCopilot(undefined, homeDir);
    const base = { cwd, homeDir, copilot: fake.client, loadMarketplace: async () => loadFakeMarketplace() };
    const output = capture();
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { ...base, ...output })).toBe(0);
    const target = builtInRecallAgentTarget(homeDir);
    expect(await readFile(target, "utf8")).toContain("tools: [read, execute]");
    const receiptFile = builtInRecallAgentOwnershipPath(homeDir);
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    await writeFile(receiptFile, JSON.stringify({ ...receipt, version: "0.3.0", extra: "preserved" }));
    expect(await runCli(["sync"], { ...base, ...capture() })).toBe(0);
    expect(JSON.parse(await readFile(receiptFile, "utf8"))).toMatchObject({ version: "0.4.0", extra: "preserved" });
    const before = (await stat(target)).mtimeMs;
    const status = capture(), doctor = capture();
    expect(await runCli(["status", "--json"], { ...base, ...status })).toBe(0);
    await runCli(["doctor", "--json"], { ...base, ...doctor });
    const row = JSON.parse(status.stdout[0]).resources.find((r: { kind: string; name: string }) => r.kind === "agent" && r.name === "teamai-recall");
    expect(row).toMatchObject({ delivery: "present", owned: true, targetPath: target, configuredActive: "unknown", runtime: { copilotCli: "unknown", vscodeLocal: "unknown", vscodeAgentHost: "unknown" } });
    expect(JSON.parse(doctor.stdout[0]).resources).toEqual(JSON.parse(status.stdout[0]).resources);
    expect((await stat(target)).mtimeMs).toBe(before);
    expect(status.stdout).toHaveLength(1);
    expect(doctor.stdout).toHaveLength(1);
    expect(status.stderr).toEqual([]);
  }, 60_000);

  test("Agent collision is preflighted before any Skill/native mutation", async () => {
    const cwd = await tempDir("teamai-agent-collision-cwd-"), homeDir = await tempDir("teamai-agent-collision-home-");
    cleanup.push(cwd, homeDir);
    const target = builtInRecallAgentTarget(homeDir);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "personal Agent\n");
    const fake = await createFakeCopilot(undefined, homeDir);
    const output = capture();
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd, homeDir, copilot: fake.client, loadMarketplace: async () => loadFakeMarketplace(), ...output,
    })).toBe(1);
    expect(output.stderr.join("\n")).toContain("Recall Agent collision");
    expect(await readFile(target, "utf8")).toBe("personal Agent\n");
    await expect(stat(path.join(homeDir, ".copilot", "skills", "teamai"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await fake.readState()).plugins).toEqual([]);
    await expect(stat(path.join(homeDir, ".teamai", "config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  test("fallback delivers to the custom root and preserves personal neighbors and unknown Copilot fields", async () => {
    const cwd = await tempDir("teamai-agent-fallback-cwd-"), homeDir = await tempDir("teamai-agent-fallback-home-");
    cleanup.push(cwd, homeDir);
    const custom = path.join(homeDir, "custom");
    vi.stubEnv("COPILOT_HOME", custom);
    await mkdir(path.join(custom, "agents"), { recursive: true });
    await mkdir(path.join(custom, "skills", "personal"), { recursive: true });
    await writeFile(path.join(custom, "agents", "teamai-recall.md"), "personal Agent");
    await writeFile(path.join(custom, "skills", "personal", "SKILL.md"), "personal Skill");
    await writeFile(path.join(custom, "config.json"), JSON.stringify({ personalConfig: { untouched: true } }));
    await writeFile(path.join(custom, "settings.json"), JSON.stringify({ personalSettings: 42 }));
    const fake = await createFakeCopilot(undefined, homeDir);
    fake.client.version = async () => { throw new CopilotUnavailableError("fixture native unavailable"); };
    const output = capture();
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd, homeDir, copilot: fake.client, vscodeAvailable: async () => true,
      loadMarketplace: async () => loadFakeMarketplace(), ...output,
    })).toBe(0);
    expect(await readFile(builtInRecallAgentTarget(homeDir), "utf8")).toContain("name: teamai-recall");
    expect(await readFile(path.join(custom, "agents", "teamai-recall.md"), "utf8")).toBe("personal Agent");
    expect(await readFile(path.join(custom, "skills", "personal", "SKILL.md"), "utf8")).toBe("personal Skill");
    expect(JSON.parse(await readFile(path.join(custom, "config.json"), "utf8"))).toMatchObject({ personalConfig: { untouched: true } });
    expect(JSON.parse(await readFile(path.join(custom, "settings.json"), "utf8"))).toMatchObject({ personalSettings: 42 });
  }, 30_000);

  test("native policy failure does not invoke fallback or deliver an Agent", async () => {
    const cwd = await tempDir("teamai-agent-native-fail-cwd-"), homeDir = await tempDir("teamai-agent-native-fail-home-");
    cleanup.push(cwd, homeDir);
    const fake = await createFakeCopilot(undefined, homeDir);
    fake.client.version = async () => { throw new Error("native enterprise policy denial"); };
    const vscodeAvailable = vi.fn(async () => true);
    const output = capture();
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd, homeDir, copilot: fake.client, vscodeAvailable, loadMarketplace: async () => loadFakeMarketplace(), ...output,
    })).toBe(1);
    expect(output.stderr.join("\n")).toContain("native enterprise policy denial");
    expect(vscodeAvailable).not.toHaveBeenCalled();
    await expect(stat(builtInRecallAgentTarget(homeDir))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
