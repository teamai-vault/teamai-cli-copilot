import { createHash } from "node:crypto";
import { copyFile, link, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDirectoryLink, tempDir } from "../helpers/test-utils.js";
import {
  builtInRecallAgentSource, builtInRecallAgentTarget, builtInRecallAgentOwnershipPath,
  convergeBuiltInRecallAgent, inspectBuiltInRecallAgent,
} from "../../src/copilot/builtin-agent.js";

const cleanup: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function home() { const root = await tempDir("teamai-agent-"); cleanup.push(root); return root; }

describe("bundled Recall Agent delivery", () => {
  test("delivers exact bundled bytes and hash receipt to only the resolved root", async () => {
    const root = await home();
    const custom = path.join(root, "custom root");
    vi.stubEnv("COPILOT_HOME", custom);
    await mkdir(path.join(custom, "agents"), { recursive: true });
    const personal = path.join(custom, "agents", "teamai-recall.md");
    await writeFile(personal, "personal\n");
    const result = await convergeBuiltInRecallAgent(root);
    expect(result.change).toBe("create");
    expect(result.state).toMatchObject({ status: "current", owned: true, pending: false });
    const target = path.join(custom, "agents", "teamai-recall.agent.md");
    const bytes = await readFile(target);
    expect(bytes).toEqual(await readFile(builtInRecallAgentSource()));
    expect(JSON.parse(await readFile(builtInRecallAgentOwnershipPath(root), "utf8"))).toMatchObject({
      schemaVersion: 1, managedBy: "teamai-cli", agent: "teamai-recall", version: "0.4.0",
      target, copilotRoot: custom, contentHash: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(await readFile(personal, "utf8")).toBe("personal\n");
    await expect(stat(path.join(root, ".copilot"))).rejects.toMatchObject({ code: "ENOENT" });
    const before = (await stat(target)).mtimeMs;
    expect((await convergeBuiltInRecallAgent(root)).change).toBeUndefined();
    expect((await stat(target)).mtimeMs).toBe(before);
  });

  test("never claims an unowned byte-identical target and preserves neighboring personal files", async () => {
    const root = await home();
    const target = builtInRecallAgentTarget(root);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(builtInRecallAgentSource(), target);
    await writeFile(path.join(path.dirname(target), "teamai-recall.md"), "personal");
    expect(await inspectBuiltInRecallAgent(root)).toMatchObject({ status: "collision", owned: false });
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("collision");
    expect(await readFile(path.join(path.dirname(target), "teamai-recall.md"), "utf8")).toBe("personal");
    await expect(stat(builtInRecallAgentOwnershipPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("dry-run has no persistent writes and root mismatch refuses a second delivery", async () => {
    const root = await home();
    expect((await convergeBuiltInRecallAgent(root, { dryRun: true })).change).toBe("create");
    await expect(stat(path.join(root, ".teamai"))).rejects.toMatchObject({ code: "ENOENT" });
    await convergeBuiltInRecallAgent(root);
    vi.stubEnv("COPILOT_HOME", path.join(root, "second"));
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("root mismatch");
    await expect(stat(path.join(root, "second"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects linked Agent directories and hardlinked targets without changing external files", async () => {
    const root = await home(), external = await home();
    const target = builtInRecallAgentTarget(root);
    await mkdir(path.dirname(path.dirname(target)), { recursive: true });
    await createDirectoryLink(external, path.dirname(target));
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("collision");
    await expect(stat(path.join(external, "teamai-recall.agent.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(path.dirname(target), { recursive: true });
    await mkdir(path.dirname(target));
    const personal = path.join(external, "personal.agent.md");
    await writeFile(personal, "personal hardlink\n");
    await link(personal, target);
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("Unsafe Recall Agent file");
    expect(await readFile(personal, "utf8")).toBe("personal hardlink\n");
    await expect(stat(builtInRecallAgentOwnershipPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
