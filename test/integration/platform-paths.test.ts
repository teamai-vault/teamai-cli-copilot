import os from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { tempDir } from "../helpers/test-utils.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line: string) => stdout.push(line), err: (line: string) => stderr.push(line) };
}

describe("unsupported long paths", () => {
  test.skipIf(process.platform !== "win32").each(["homeDir", "cwd", "COPILOT_HOME"] as const)("rejects a long %s with guidance and preserves user files", async (field) => {
    const home = await tempDir("teamai-path-home-");
    const workspace = await tempDir("teamai-path-workspace-");
    const marker = path.join(home, "personal.txt");
    const original = Buffer.from("personal content\r\n");
    await writeFile(marker, original);
    const longPath = path.join(home, "a".repeat(100), "b".repeat(100), "c".repeat(60));
    vi.stubEnv("COPILOT_HOME", field === "COPILOT_HOME" ? longPath : "");
    const output = capture();
    const exit = await runCli(["status"], {
      homeDir: field === "homeDir" ? longPath : home,
      cwd: field === "cwd" ? longPath : workspace,
      copilotMode: "unavailable",
      out: output.out,
      err: output.err,
    });
    expect(exit).toBe(1);
    expect(output.stderr.join("\n")).toMatch(/too long.*Windows/i);
    expect(output.stderr.join("\n")).toMatch(/shorter path/i);
    expect(await readFile(marker)).toEqual(original);
  });

  test("reports an OS home-directory length error through the JSON command contract", async () => {
    vi.spyOn(os, "homedir").mockImplementation(() => {
      throw Object.assign(new Error("ENOBUFS: uv_os_homedir failed"), { code: "ENOBUFS" });
    });
    const output = capture();
    expect(await runCli(["recall", "query", "--json"], output)).toBe(1);
    expect(output.stderr).toEqual([]);
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0])).toMatchObject({
      schemaVersion: 1,
      error: { code: "RECALL_FAILED", message: expect.stringMatching(/long paths are not supported.*shorter/i) },
    });
  });

  test.each([{ argv: [] }, { argv: ["--help"] }, { argv: ["--version"] }])("help/version remain available without initializing an unusable home: $argv", async ({ argv }) => {
    const home = vi.spyOn(os, "homedir").mockImplementation(() => {
      throw Object.assign(new Error("ENOBUFS: uv_os_homedir failed"), { code: "ENOBUFS" });
    });
    const output = capture();
    expect(await runCli(argv, output)).toBe(0);
    expect(output.stdout).toHaveLength(1);
    expect(output.stderr).toEqual([]);
    expect(home).not.toHaveBeenCalled();
  });
});
