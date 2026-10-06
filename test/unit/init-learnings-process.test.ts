import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { runProcess } from "../../src/utils/process.js";

const scriptUrl = new URL("../../scripts/init-learnings-branch.mjs", import.meta.url).href;

async function runHarness(source: string) {
  const result = await runProcess(process.execPath, ["--input-type=module", "--eval", source]);
  expect(result.exitCode, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
  return JSON.parse(result.stdout);
}

describe("Learnings bootstrap Git subprocess", () => {
  test.each([23, 0, null])("waits for close after a stdin error with child exit %s", async (exitCode) => {
    const result = await runHarness(`
      import childProcess from "node:child_process";
      import { EventEmitter } from "node:events";
      import { PassThrough } from "node:stream";
      import { syncBuiltinESMExports } from "node:module";
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      childProcess.spawn = () => child;
      syncBuiltinESMExports();
      const { runGit } = await import(${JSON.stringify(scriptUrl)});
      let settled = false;
      const pending = runGit([], { input: "payload" }).then(
        (value) => { settled = true; return { value }; },
        (error) => { settled = true; return { error: { code: error.code, message: error.message } }; },
      );
      child.stdin.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      await new Promise((resolve) => setImmediate(resolve));
      const settledBeforeClose = settled;
      child.stdout.end("git stdout after stdin error");
      child.stderr.end("git rejection after stdin error");
      child.emit("close", ${exitCode});
      console.log(JSON.stringify({ settledBeforeClose, ...await pending }));
    `);
    expect(result.settledBeforeClose).toBe(false);
    if (exitCode !== 0) {
      expect(result.value).toEqual({
        exitCode: exitCode ?? 1,
        stdout: "git stdout after stdin error",
        stderr: "git rejection after stdin error",
      });
    } else {
      expect(result.error).toEqual({ code: "EPIPE", message: "write EPIPE" });
    }
  });

  test("keeps the real early-exit child status and output when a large input breaks its pipe", async () => {
    const result = await runHarness(`
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const spawn = childProcess.spawn;
      childProcess.spawn = (_command, _args, options) => spawn(process.execPath, ["--eval", ${JSON.stringify(
        'process.stdout.write("early stdout"); process.stderr.write("early rejection"); process.exitCode = 29;',
      )}], options);
      syncBuiltinESMExports();
      const { runGit } = await import(${JSON.stringify(scriptUrl)});
      console.log(JSON.stringify(await runGit([], { input: "x".repeat(8 * 1024 * 1024) })));
    `);
    expect(result).toEqual({ exitCode: 29, stdout: "early stdout", stderr: "early rejection" });
  });

  test("sends only EOF for omitted or empty input and preserves spawn errors", async () => {
    const result = await runHarness(`
      import childProcess from "node:child_process";
      import { syncBuiltinESMExports } from "node:module";
      const spawn = childProcess.spawn;
      const endArguments = [];
      childProcess.spawn = (_command, args, options) => {
        const child = args[0] === "missing"
          ? spawn(${JSON.stringify(fileURLToPath(new URL("../../.tmp/nonexistent-bootstrap-git", import.meta.url)))}, [], options)
          : spawn(process.execPath, ["--eval", 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("EOF"));'], options);
        const end = child.stdin.end.bind(child.stdin);
        child.stdin.end = (...args) => { endArguments.push(args); return end(...args); };
        return child;
      };
      syncBuiltinESMExports();
      const { runGit } = await import(${JSON.stringify(scriptUrl)});
      const omitted = await runGit([]);
      const empty = await runGit([], { input: "" });
      const missing = await runGit(["missing"]).catch((error) => error.code);
      console.log(JSON.stringify({ omitted, empty, missing, endArguments }));
    `);
    expect(result).toEqual({
      omitted: { exitCode: 0, stdout: "EOF", stderr: "" },
      empty: { exitCode: 0, stdout: "EOF", stderr: "" },
      missing: "ENOENT",
      endArguments: [[], [], []],
    });
  });
});
