import { cp, mkdir, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, test } from "vitest";
import { runProcess } from "../../src/utils/process.js";
import { tempDir } from "../helpers/test-utils.js";

describe("published package", () => {
  test("packs and installs an unbuilt source tree with the CLI and built-in resources", async (context) => {
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const fresh = await tempDir("teamai-unbuilt-package-");
    context.onTestFinished(() => rm(fresh, { recursive: true, force: true }));
    for (const relative of ["src", "agents", "skills/teamai", "scripts/check-package-bytes.mjs", ".gitattributes", "package.json", "package-lock.json", "tsconfig.json", "tsconfig.build.json", "README.md", "README.zh-CN.md"]) {
      await mkdir(path.dirname(path.join(fresh, relative)), { recursive: true });
      await cp(path.join(root, relative), path.join(fresh, relative), { recursive: true });
    }
    // Reuse installed build dependencies; the source copy intentionally has no dist.
    await symlink(path.join(root, "node_modules"), path.join(fresh, "node_modules"), process.platform === "win32" ? "junction" : "dir");

    const result = await runProcess("npm", ["pack", "--json"], { cwd: fresh });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);

    const parsed = JSON.parse(result.stdout) as
      | Array<{ files?: Array<{ path?: string }> }>
      | Record<string, { files?: Array<{ path?: string }> }>;
    const entry = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
    const paths = (entry?.files ?? []).map((file) => file.path).filter((value): value is string => typeof value === "string");

    expect(paths).toContain("skills/teamai/SKILL.md");
    expect(paths).toContain("skills/teamai/references/commands.md");
    expect(paths).toContain("dist/copilot/builtin-skill.js");
    expect(paths).toContain("dist/cli.js");
    expect(paths).toContain("agents/teamai-recall.agent.md");
    expect(paths.filter((value) => value.startsWith("skills/")).sort()).toEqual([
      "skills/teamai/SKILL.md",
      "skills/teamai/references/commands.md",
    ]);

    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
    const packageLock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8")) as {
      version: string;
      packages: Record<string, { version?: string; resolved?: string }>;
    };
    const cliVersion = await runProcess(process.execPath, ["dist/cli.js", "--version"], { cwd: fresh });
    expect(cliVersion.exitCode, cliVersion.stderr || cliVersion.stdout).toBe(0);
    expect(packageLock.version).toBe(packageJson.version);
    expect(packageLock.packages[""]?.version).toBe(packageJson.version);
    expect(cliVersion.stdout.trim()).toBe(packageJson.version);

    // Git installation must prepare its own dependencies. Directory-only ignore
    // rules do not exclude POSIX symlinks, so remove the borrowed link first.
    await unlink(path.join(fresh, "node_modules"));
    await writeFile(path.join(fresh, ".gitignore"), "dist/\nnode_modules/\n*.tgz\n", "utf8");
    for (const args of [["init", "-b", "main"], ["config", "user.name", "Package test"], ["config", "user.email", "package@example.invalid"], ["add", "."], ["commit", "-m", "Unbuilt package source"]]) {
      const git = await runProcess("git", args, { cwd: fresh });
      expect(git.exitCode, git.stderr || git.stdout).toBe(0);
    }
    const trackedArtifacts = await runProcess("git", ["ls-files", "dist", "node_modules"], { cwd: fresh });
    expect(trackedArtifacts.exitCode, trackedArtifacts.stderr || trackedArtifacts.stdout).toBe(0);
    expect(trackedArtifacts.stdout.trim()).toBe("");
    const revision = await runProcess("git", ["rev-parse", "HEAD"], { cwd: fresh });
    expect(revision.exitCode, revision.stderr || revision.stdout).toBe(0);
    const installed = await tempDir("teamai-git-package-install-");
    context.onTestFinished(() => rm(installed, { recursive: true, force: true }));
    const source = "git+" + pathToFileURL(fresh).href + "#" + revision.stdout.trim();
    await writeFile(path.join(installed, "package.json"), JSON.stringify({ private: true, dependencies: { [packageJson.name]: source } }), "utf8");
    const lockedTarball = Object.values(packageLock.packages).find((entry) => entry.resolved?.startsWith("https://"))?.resolved;
    expect(lockedTarball).toBeDefined();
    const registry = new URL(lockedTarball!).origin;
    // npm 12 requires a per-command opt-in for this task-owned local Git fixture.
    const fromGit = await runProcess("npm", ["install", "--allow-git=root", "--registry=" + registry, "--no-audit", "--no-fund", "--no-package-lock"], { cwd: installed });
    expect(fromGit.exitCode, fromGit.stderr || fromGit.stdout).toBe(0);
    const gitVersion = await runProcess(process.execPath, [path.join(installed, "node_modules", packageJson.name, "dist", "cli.js"), "--version"], { cwd: installed });
    expect(gitVersion.exitCode, gitVersion.stderr || gitVersion.stdout).toBe(0);
    expect(gitVersion.stdout.trim()).toBe(packageJson.version);
  }, 120_000);
});
