import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { runProcess } from "../../src/utils/process.js";

describe("published package", () => {
  test("ships the built-in Team AI Skill and its runtime support", async () => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const build = await runProcess("npm", ["run", "build"], { cwd: root });
    expect(build.exitCode, build.stderr || build.stdout).toBe(0);

    const result = await runProcess("npm", ["pack", "--dry-run", "--json"], { cwd: root });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);

    const parsed = JSON.parse(result.stdout) as
      | Array<{ files?: Array<{ path?: string }> }>
      | Record<string, { files?: Array<{ path?: string }> }>;
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const paths = (entry?.files ?? []).map((file) => file.path).filter((value): value is string => typeof value === "string");

    expect(paths).toContain("skills/teamai/SKILL.md");
    expect(paths).toContain("skills/teamai/references/commands.md");
    expect(paths).toContain("dist/copilot/builtin-skill.js");
    expect(paths.filter((value) => value.startsWith("skills/")).sort()).toEqual([
      "skills/teamai/SKILL.md",
      "skills/teamai/references/commands.md",
    ]);

    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    const packageLock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    const cliVersion = await runProcess(process.execPath, ["dist/cli.js", "--version"], { cwd: root });
    expect(cliVersion.exitCode, cliVersion.stderr || cliVersion.stdout).toBe(0);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""]?.version).toBe(packageJson.version);
    expect(cliVersion.stdout.trim()).toBe(packageJson.version);
  }, 30_000);
});
