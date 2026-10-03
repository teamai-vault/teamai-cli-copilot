import { readFile, rm, stat, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tempDir } from "../helpers/test-utils.js";
import { runCli } from "../../src/cli.js";

const failure = vi.hoisted(() => ({ stage: "" }));
vi.mock("../../src/utils/fs.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/fs.js")>("../../src/utils/fs.js");
  return {
    ...actual,
    atomicCreateFile: async (file: string, bytes: Uint8Array) => {
      if (failure.stage === "target") throw new Error("injected target failure");
      return await actual.atomicCreateFile(file, bytes);
    },
    atomicWriteJson: async (file: string, value: { phase?: string }) => {
      if (failure.stage === "receipt" && file.endsWith("teamai-recall.json")) throw new Error("injected receipt failure");
      if (failure.stage === "delivered" && value.phase === "delivered") throw new Error("injected delivered checkpoint failure");
      if (failure.stage === "planned" && value.phase === "planned") throw new Error("injected planned checkpoint failure");
      return await actual.atomicWriteJson(file, value);
    },
  };
});
import {
  builtInRecallAgentTarget, builtInRecallAgentSource, builtInRecallAgentOwnershipPath,
  builtInRecallAgentCheckpointPath, convergeBuiltInRecallAgent, inspectBuiltInRecallAgent,
} from "../../src/copilot/builtin-agent.js";
const cleanup: string[] = [];
afterEach(async () => {
  failure.stage = "";
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function home() { const root = await tempDir("teamai-agent-failure-"); cleanup.push(root); return root; }
describe("Recall Agent partial delivery recovery", () => {
  test("receipt failure keeps a delivered checkpoint, reports unconfirmed ownership, then safely confirms it", async () => {
    const root = await home();
    failure.stage = "receipt";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("Partial Recall Agent delivery");
    expect(JSON.parse(await readFile(builtInRecallAgentCheckpointPath(root), "utf8"))).toMatchObject({ phase: "delivered", beforeHash: null });
    await expect(stat(builtInRecallAgentOwnershipPath(root))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await inspectBuiltInRecallAgent(root)).toMatchObject({ status: "stale", owned: false, pending: true });
    const before = await readFile(builtInRecallAgentCheckpointPath(root));
    const status: string[] = [], doctor: string[] = [];
    const base = { cwd: root, homeDir: root, err: () => {} };
    expect(await runCli(["status", "--json"], { ...base, out: (s) => status.push(s) })).toBe(0);
    await runCli(["doctor", "--json"], { ...base, out: (s) => doctor.push(s) });
    const snapshot = JSON.parse(status[0]);
    expect(snapshot.resources.find((r: { name: string }) => r.name === "teamai-recall")).toMatchObject({ delivery: "stale", owned: false });
    expect(snapshot.diagnostics.some((d: { code: string }) => d.code === "BUILTIN_AGENT_DELIVERY_PENDING")).toBe(true);
    expect(JSON.parse(doctor[0]).resources).toEqual(snapshot.resources);
    expect(await readFile(builtInRecallAgentCheckpointPath(root))).toEqual(before);
    failure.stage = "";
    expect((await convergeBuiltInRecallAgent(root)).state).toMatchObject({ status: "current", owned: true, pending: false });
    expect(await readFile(builtInRecallAgentTarget(root))).toEqual(await readFile(builtInRecallAgentSource()));
    await expect(stat(builtInRecallAgentCheckpointPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a personal edit after delivered checkpoint is preserved and cannot be claimed", async () => {
    const root = await home();
    failure.stage = "receipt";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("Partial");
    await writeFile(builtInRecallAgentTarget(root), "personal replacement\n");
    failure.stage = "";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("collision");
    expect(await readFile(builtInRecallAgentTarget(root), "utf8")).toBe("personal replacement\n");
    expect((await inspectBuiltInRecallAgent(root)).owned).toBe(false);
  });

  test("failure between target and delivered checkpoint is ambiguous, even with exact bundled bytes", async () => {
    const root = await home();
    failure.stage = "delivered";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("Partial");
    expect(JSON.parse(await readFile(builtInRecallAgentCheckpointPath(root), "utf8")).phase).toBe("planned");
    expect(await readFile(builtInRecallAgentTarget(root))).toEqual(await readFile(builtInRecallAgentSource()));
    failure.stage = "";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("ambiguous");
    await expect(stat(builtInRecallAgentOwnershipPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a planned checkpoint before target delivery can resume after revalidation", async () => {
    const root = await home();
    failure.stage = "target";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("Partial");
    await expect(stat(builtInRecallAgentTarget(root))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await inspectBuiltInRecallAgent(root)).toMatchObject({ status: "stale", pending: true, owned: false });
    failure.stage = "";
    expect((await convergeBuiltInRecallAgent(root)).state.status).toBe("current");
  });

  test("a failed initial checkpoint never writes the target or receipt", async () => {
    const root = await home();
    failure.stage = "planned";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("delivery did not start");
    await expect(stat(builtInRecallAgentTarget(root))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(builtInRecallAgentOwnershipPath(root))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("a missing owned target resumes its plan, but a changed ownership receipt is refused", async () => {
    const root = await home();
    await convergeBuiltInRecallAgent(root);
    await rm(builtInRecallAgentTarget(root));
    failure.stage = "target";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("Partial");
    expect(await inspectBuiltInRecallAgent(root)).toMatchObject({ status: "stale", owned: true, pending: true });
    failure.stage = "";
    expect((await convergeBuiltInRecallAgent(root)).state.status).toBe("current");
    const receiptFile = builtInRecallAgentOwnershipPath(root);
    const receipt = JSON.parse(await readFile(receiptFile, "utf8"));
    await writeFile(receiptFile, JSON.stringify({ ...receipt, version: "0.3.0" }));
    failure.stage = "receipt";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("Partial");
    await writeFile(receiptFile, JSON.stringify({ ...receipt, contentHash: "0".repeat(64) }));
    failure.stage = "";
    await expect(convergeBuiltInRecallAgent(root)).rejects.toThrow("collision");
    expect(JSON.parse(await readFile(receiptFile, "utf8")).contentHash).toBe("0".repeat(64));
  });

  test("owned version convergence preserves unknown receipt fields", async () => {
    const root = await home();
    await convergeBuiltInRecallAgent(root);
    const file = builtInRecallAgentOwnershipPath(root);
    const receipt = JSON.parse(await readFile(file, "utf8"));
    receipt.version = "0.3.0";
    receipt.personalExtension = { keep: true };
    await writeFile(file, JSON.stringify(receipt));
    await convergeBuiltInRecallAgent(root);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: "0.4.0", personalExtension: { keep: true } });
  });
});
