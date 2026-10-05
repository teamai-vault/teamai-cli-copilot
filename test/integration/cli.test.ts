import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { readGlobalConfig, writeGlobalConfig } from "../../src/config/global.js";
import { createConfig } from "../../src/config/schema.js";
import type { CatalogSkill } from "../../src/copilot/catalog.js";
import { CopilotClient } from "../../src/copilot/cli.js";
import { partitionPath } from "../../src/project/partition.js";
import { projectionKey } from "../../src/project/context.js";
import { detectProjectIdentity } from "../../src/project/anchors.js";
import { writeProjectState } from "../../src/project/state.js";
import { runProcess } from "../../src/utils/process.js";
import {
  createFakeCopilot,
  createGitRepo,
  createDirectoryLink,
  isPermissionError,
  loadFakeMarketplace,
  tempDir,
  TEST_MARKETPLACE_NAME,
  TEST_MARKETPLACE_SOURCE,
} from "../helpers/test-utils.js";

// Windows subprocess startup can exceed the historic per-test budgets under serialized load.
const CLI_PROCESS_TEST_TIMEOUT = 60_000;

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line: string) => stdout.push(line), err: (line: string) => stderr.push(line) };
}

async function snapshotFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isFile()) files.push(`${path.relative(root, target)}:${(await readFile(target)).toString("base64")}`);
    }
  };
  await walk(root);
  return files.sort();
}

function trackCopilotCalls<T extends object>(client: T): { client: T; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    client: new Proxy(client, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== "function") return value;
        return (...args: unknown[]) => {
          calls.push(String(key));
          return Reflect.apply(value, target, args);
        };
      },
    }),
  };
}

describe("CLI integration with fake Copilot executable", () => {
  test("first init requires an explicit marketplace source", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-no-marketplace-home-");
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();

    expect(await runCli(["init", "--role", "api"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: loadFakeMarketplace,
      out: output.out,
      err: output.err,
    })).toBe(1);

    expect(await readGlobalConfig(home)).toBeUndefined();
    expect(output.stderr.some((line) => line.includes("--marketplace <source>"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("init and sync in an unbound Git workspace leave project state and exclude untouched", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-unbound-project-home-");
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();
    const excludePath = path.join(repo, ".git", "info", "exclude");
    await writeFile(excludePath, "# user exclude\n", "utf8");
    const identity = await detectProjectIdentity(repo);
    const projectStatePath = path.join(partitionPath(identity!.projectAnchor, home), "state.json");

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: output.out, err: output.err })).toBe(0);
    expect(await readFile(excludePath, "utf8")).toBe("# user exclude\n");
    await expect(readFile(projectStatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    expect(await runCli(["sync"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: output.out, err: output.err })).toBe(0);
    expect(await readFile(excludePath, "utf8")).toBe("# user exclude\n");
    await expect(readFile(projectStatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".teamai", "context", "shared", "learnings"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("projects set rejects a symlink escape before writing any workspace projection", async ({ skip }) => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-project-escape-home-");
    const marketplace = await tempDir("teamai-project-escape-marketplace-");
    const external = await tempDir("teamai-project-escape-external-");
    const excludePath = path.join(repo, ".git", "info", "exclude");
    const initialExclude = "# user exclude\n";
    await writeFile(excludePath, initialExclude, "utf8");
    await mkdir(path.join(marketplace, "manifest"), { recursive: true });
    await writeFile(path.join(marketplace, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payment domain\n    owners: [payments]\n", "utf8");
    await writeFile(path.join(external, "personal.md"), "external user content\n", "utf8");
    await mkdir(path.join(repo, ".teamai"), { recursive: true });
    try {
      await createDirectoryLink(external, path.join(repo, ".teamai", "context"));
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();
    const loadMarketplace = async () => loadFakeMarketplace(marketplace);
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    const sync = capture();
    expect(await runCli(["sync"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: sync.out, err: sync.err })).toBe(0);
    expect(sync.stderr).toEqual([]);

    const state = await detectProjectIdentity(repo);
    const statePath = path.join(partitionPath(state!.projectAnchor, home), "state.json");
    expect(await runCli(["projects", "set", "payments"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(1);
    expect(output.stderr.join("\n")).toContain("Unsafe Team AI projection path");
    await expect(readFile(path.join(external, "personal.md"), "utf8")).resolves.toBe("external user content\n");
    await expect(readFile(excludePath, "utf8")).resolves.toBe(initialExclude);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "copilot", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("projects set rejects a linked Team AI state root before changing Workspace or external files", async ({ skip }) => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-state-escape-home-");
    const marketplace = await tempDir("teamai-state-escape-marketplace-");
    const external = await tempDir("teamai-state-escape-external-");
    const projectsPath = path.join(home, ".teamai", "projects");
    const excludePath = path.join(repo, ".git", "info", "exclude");
    const initialExclude = "# user exclude\n";
    await writeFile(excludePath, initialExclude, "utf8");
    await mkdir(path.join(marketplace, "manifest"), { recursive: true });
    await writeFile(path.join(marketplace, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payment domain\n    owners: [payments]\n", "utf8");
    await writeFile(path.join(external, "keep.txt"), "outside content\n", "utf8");
    await mkdir(path.dirname(projectsPath), { recursive: true });
    try {
      await createDirectoryLink(external, projectsPath);
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();
    const loadMarketplace = async () => loadFakeMarketplace(marketplace);
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    const sync = capture();
    expect(await runCli(["sync"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: sync.out, err: sync.err })).toBe(1);
    expect(sync.stderr.join("\n")).toContain("Unsafe Team AI project state path");
    const identity = await detectProjectIdentity(repo);
    expect(await runCli(["projects", "set", "payments"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(1);
    expect(output.stderr.join("\n")).toContain("Unsafe Team AI project state path");
    await expect(readFile(path.join(external, "keep.txt"), "utf8")).resolves.toBe("outside content\n");
    await expect(readFile(excludePath, "utf8")).resolves.toBe(initialExclude);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "copilot", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(external)).toEqual(["keep.txt"]);
    expect(identity).toBeDefined();
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("sync preflights an owned Workspace projection before changing user resources", async ({ skip }) => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-sync-project-preflight-home-");
    const marketplace = await tempDir("teamai-sync-project-preflight-marketplace-");
    const external = await tempDir("teamai-sync-project-preflight-external-");
    const excludePath = path.join(repo, ".git", "info", "exclude");
    const initialExclude = "# user exclude\n";
    await writeFile(excludePath, initialExclude, "utf8");
    await mkdir(path.join(marketplace, "manifest"), { recursive: true });
    await mkdir(path.join(marketplace, "contexts", "payments", "instructions"), { recursive: true });
    await writeFile(path.join(marketplace, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payment domain\n    owners: [payments]\n", "utf8");
    await writeFile(path.join(marketplace, "contexts", "payments", "instructions", "payments.instructions.md"), "payments\n", "utf8");
    await writeFile(path.join(external, "personal.md"), "external user content\n", "utf8");
    await mkdir(path.join(repo, ".teamai"), { recursive: true });
    try {
      await createDirectoryLink(external, path.join(repo, ".teamai", "context"));
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }
    const identity = await detectProjectIdentity(repo);
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    await writeGlobalConfig(config, home);
    const state = {
      schemaVersion: 1 as const,
      workspaceRoot: identity!.workspaceRoot,
      lastSync: "before-sync",
      managedPlugins: [],
      projections: {
        [projectionKey(identity!.workspaceRoot)]: {
          workspaceRoot: identity!.workspaceRoot,
          logicalProjects: ["payments"],
          managedProjectPlugins: [],
          instructionRoot: path.join(repo, ".github", "instructions", "teamai"),
          contextRoot: path.join(repo, ".teamai", "context"),
        },
      },
    };
    await writeProjectState(identity!.projectAnchor, state, home);
    const statePath = path.join(partitionPath(identity!.projectAnchor, home), "state.json");
    const stateBefore = await readFile(statePath, "utf8");
    const configBefore = await readFile(path.join(home, ".teamai", "config.yaml"), "utf8");
    const fake = await createFakeCopilot(undefined, home);
    const copilotBefore = await fake.readState();
    const output = capture();
    const loadMarketplace = async () => loadFakeMarketplace(marketplace);

    expect(await runCli(["sync"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(1);
    expect(output.stderr.join("\n")).toContain("Unsafe Team AI projection path");
    expect(await fake.readState()).toEqual(copilotBefore);
    await expect(readFile(statePath, "utf8")).resolves.toBe(stateBefore);
    await expect(readFile(path.join(home, ".teamai", "config.yaml"), "utf8")).resolves.toBe(configBefore);
    await expect(readFile(path.join(home, ".copilot", "instructions", "teamai", "payments.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(home, ".copilot", "skills", "teamai"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(excludePath, "utf8")).resolves.toBe(initialExclude);
    await expect(readFile(path.join(external, "personal.md"), "utf8")).resolves.toBe("external user content\n");
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("sync reports partial user convergence when a later Workspace lock conflicts", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-sync-project-conflict-home-");
    const marketplace = await tempDir("teamai-sync-project-conflict-marketplace-");
    await mkdir(path.join(marketplace, "manifest"), { recursive: true });
    await mkdir(path.join(marketplace, "instructions"), { recursive: true });
    await mkdir(path.join(marketplace, "contexts", "payments", "instructions"), { recursive: true });
    await writeFile(path.join(marketplace, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payment domain\n    owners: [payments]\n", "utf8");
    await writeFile(path.join(marketplace, "instructions", "global.instructions.md"), "user instruction\n", "utf8");
    await writeFile(path.join(marketplace, "contexts", "payments", "instructions", "payments.instructions.md"), "payments\n", "utf8");
    const identity = await detectProjectIdentity(repo);
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    await writeGlobalConfig(config, home);
    const state = {
      schemaVersion: 1 as const,
      workspaceRoot: identity!.workspaceRoot,
      lastSync: "before-sync",
      managedPlugins: [],
      projections: {
        [projectionKey(identity!.workspaceRoot)]: {
          workspaceRoot: identity!.workspaceRoot,
          logicalProjects: ["payments"],
          managedProjectPlugins: [],
          instructionRoot: path.join(repo, ".github", "instructions", "teamai"),
          contextRoot: path.join(repo, ".teamai", "context"),
        },
      },
    };
    await writeProjectState(identity!.projectAnchor, state, home);
    const statePath = path.join(partitionPath(identity!.projectAnchor, home), "state.json");
    const stateBefore = await readFile(statePath, "utf8");
    const excludePath = path.join(repo, ".git", "info", "exclude");
    const excludeBefore = await readFile(excludePath, "utf8");
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
      plugins: [
        { name: "common", marketplace: TEST_MARKETPLACE_NAME, enabled: true, source: `live-marketplace:${TEST_MARKETPLACE_NAME}` },
        { name: "api", marketplace: TEST_MARKETPLACE_NAME, enabled: true, source: `live-marketplace:${TEST_MARKETPLACE_NAME}` },
      ],
    }, home);
    const copilot = Object.create(fake.client) as CopilotClient;
    const originalListMarketplaces = fake.client.listMarketplaces.bind(fake.client);
    const projectLock = `${partitionPath(identity!.projectAnchor, home)}.lock`;
    copilot.listMarketplaces = async (cwd) => {
      await writeFile(projectLock, "other process lock\n", "utf8");
      return originalListMarketplaces(cwd);
    };
    const output = capture();
    const loadMarketplace = async () => loadFakeMarketplace(marketplace);

    expect(await runCli(["sync"], { cwd: repo, homeDir: home, copilot, loadMarketplace, out: output.out, err: output.err })).toBe(1);
    expect(output.stderr.join("\n")).toContain("Partial sync; Workspace update did not complete.");
    expect(output.stderr.join("\n")).toContain("Project state conflict");
    await rm(projectLock, { force: true });
    await expect(readFile(path.join(home, ".copilot", "instructions", "teamai", "global.instructions.md"), "utf8")).resolves.toBe("user instruction\n");
    await expect(readdir(path.join(home, ".copilot", "skills", "teamai"))).resolves.toContain("SKILL.md");
    await expect(readFile(statePath, "utf8")).resolves.toBe(stateBefore);
    await expect(readFile(excludePath, "utf8")).resolves.toBe(excludeBefore);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("rejects the removed Product option", async () => {
    const repo = await createGitRepo();
    const output = capture();
    expect(await runCli(["init", "--product=payments"], { cwd: repo, out: output.out, err: output.err })).toBe(2);
    expect(output.stderr.join("\n")).toContain("ERROR: --product has been removed.\nUse `teamai projects set <ids...>` inside the target Git repository.");
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("init converges instructions when Copilot and VS Code backends are unavailable", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-no-backend-home-");
    const marketplace = await tempDir("teamai-instructions-no-backend-marketplace-");
    const source = path.join(marketplace, "instructions");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), "managed without backend\n", "utf8");
    const output = capture();

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd: repo,
      homeDir: home,
      copilot: new CopilotClient("teamai-command-not-installed"),
      vscodeAvailable: async () => false,
      loadMarketplace: async () => loadFakeMarketplace(marketplace),
      out: output.out,
      err: output.err,
    })).toBe(1);

    expect(await readFile(path.join(home, ".copilot", "instructions", "teamai", "global.instructions.md"), "utf8"))
      .toBe("managed without backend\n");
    expect(output.stderr.some((line) => line.includes("plugin convergence could not run"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("non-interactive init reports each missing required value", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-no-role-home-");
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: loadFakeMarketplace,
      out: output.out,
      err: output.err,
    })).toBe(1);
    expect(output.stderr.some((line) => line.includes("Role is required in non-interactive mode"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("interactive init prompts only for missing values", async () => {
    const cases = [
      { args: ["init"], marketplacePrompts: 1, rolePrompts: 1 },
      { args: ["init", "--marketplace", TEST_MARKETPLACE_SOURCE], marketplacePrompts: 0, rolePrompts: 1 },
      { args: ["init", "--role", "qa"], marketplacePrompts: 1, rolePrompts: 0 },
    ];
    for (const item of cases) {
      const repo = await createGitRepo();
      const home = await tempDir("teamai-interactive-home-");
      const fake = await createFakeCopilot(undefined, home);
      const output = capture();
      let marketplacePrompts = 0;
      let rolePrompts = 0;
      expect(await runCli(item.args, {
        cwd: repo,
        homeDir: home,
        copilot: fake.client,
        interactive: true,
        loadMarketplace: loadFakeMarketplace,
        promptMarketplace: async () => { marketplacePrompts += 1; return TEST_MARKETPLACE_SOURCE; },
        promptRole: async () => { rolePrompts += 1; return "qa"; },
        out: output.out,
        err: output.err,
      })).toBe(0);
      expect(marketplacePrompts).toBe(item.marketplacePrompts);
      expect(rolePrompts).toBe(item.rolePrompts);
      expect((await readGlobalConfig(home))?.role).toBe("qa");
    }
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("init discovers marketplace name from Copilot and remains repeatable", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-home-");
    const fake = await createFakeCopilot({
      plugins: [
        { name: "personal-tool", marketplace: "other", version: "9.9.9", enabled: true, source: "user" },
        { name: "api", marketplace: "other", version: "8.8.8", enabled: true, source: "user" },
      ],
    }, home);
    const first = capture();
    const base = { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: first.out, err: first.err };

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], base)).toBe(0);
    expect(first.stderr).toEqual([]);
    const config = await readGlobalConfig(home);
    expect(config?.version).toBe(1);
    expect(config?.marketplace).toEqual({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    expect(config?.role).toBe("api");
    expect(config?.managedPlugins).toEqual([
      `aos@${TEST_MARKETPLACE_NAME}`,
      `api@${TEST_MARKETPLACE_NAME}`,
      `common@${TEST_MARKETPLACE_NAME}`,
      `design@${TEST_MARKETPLACE_NAME}`,
      `ios@${TEST_MARKETPLACE_NAME}`,
      `qa@${TEST_MARKETPLACE_NAME}`,
    ]);

    const identity = await detectProjectIdentity(repo);
    const statePath = path.join(partitionPath(identity!.projectAnchor, home), "state.json");
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "copilot", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".teamai", "context"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const repeat = capture();
    expect(await runCli(["init"], { ...base, out: repeat.out, err: repeat.err })).toBe(0);
    expect(repeat.stdout).toContain("Copilot plugin state is already converged.");

    const reinitRole = capture();
    expect(await runCli(["init", "--role", "ios"], { ...base, out: reinitRole.out, err: reinitRole.err })).toBe(0);
    const afterReinit = await fake.readState();
    expect(afterReinit.plugins.find((item) => item.name === "api" && item.marketplace === TEST_MARKETPLACE_NAME)?.enabled).toBe(false);
    expect(afterReinit.plugins.find((item) => item.name === "ios" && item.marketplace === TEST_MARKETPLACE_NAME)?.enabled).toBe(true);

    const switched = capture();
    expect(await runCli(["role", "set", "qa"], { ...base, out: switched.out, err: switched.err })).toBe(0);
    const afterSwitch = await fake.readState();
    expect(afterSwitch.plugins.find((item) => item.name === "api" && item.marketplace === TEST_MARKETPLACE_NAME)?.enabled).toBe(false);
    expect(afterSwitch.plugins.find((item) => item.name === "qa")?.enabled).toBe(true);
    expect(afterSwitch.plugins.find((item) => item.name === "personal-tool")?.enabled).toBe(true);
    expect(afterSwitch.plugins.find((item) => item.name === "api" && item.marketplace === "other")?.enabled).toBe(true);

    const synced = capture();
    expect(await runCli(["sync"], { ...base, out: synced.out, err: synced.err })).toBe(0);
    expect(synced.stdout).toContain("Copilot plugin state is already converged.");

    const status = capture();
    expect(await runCli(["status"], { ...base, out: status.out, err: status.err })).toBe(0);
    expect(status.stdout.some((line) => line.includes(`qa@${TEST_MARKETPLACE_NAME}: configured enabled; runtime unobserved`))).toBe(true);
    expect(status.stdout).toContain("  Marketplace revision: unknown");
    expect(status.stdout).toContain("  Managed personal skills: none");
    expect(status.stdout.some((line) => line.startsWith("  Project context: "))).toBe(true);
    expect(status.stdout.some((line) => line.startsWith("  Learnings projection: "))).toBe(true);

    const doctor = capture();
    expect(await runCli(["doctor"], { ...base, out: doctor.out, err: doctor.err })).toBe(0);
    expect(doctor.stdout.some((line) => line.includes("Copilot runtime and native MCP state are unobserved"))).toBe(true);
    expect(doctor.stdout).toContain("✓ Logical Project manifest: 0 available, no workspace binding.");
    expect(doctor.stdout.some((line) => line.includes("Managed personal Skill availability is unknown"))).toBe(true);
    await expect(readFile(statePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const unavailableStatus = capture();
    expect(await runCli(["status"], {
      ...base,
      loadMarketplace: async () => { throw new Error("cache unavailable"); },
      out: unavailableStatus.out,
      err: unavailableStatus.err,
    })).toBe(0);
    expect(unavailableStatus.stdout).toContain("  Marketplace revision: unknown");
    expect(unavailableStatus.stdout).toContain("  Managed personal skills: none");
    expect(unavailableStatus.stdout.some((line) => line.includes("Marketplace cache: unavailable"))).toBe(true);

  }, CLI_PROCESS_TEST_TIMEOUT);

  test("first-time dry-run discovers metadata without mutating Copilot", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-dry-home-");
    const fake = await createFakeCopilot(undefined, home);
    const before = await fake.readState();
    const output = capture();

    expect(await runCli(["--dry-run", "init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: loadFakeMarketplace,
      out: output.out,
      err: output.err,
    })).toBe(0);

    expect(await fake.readState()).toEqual(before);
    expect(await readGlobalConfig(home)).toBeUndefined();
    expect(output.stdout).toContain(`WOULD marketplace-add: ${TEST_MARKETPLACE_SOURCE}`);
    expect(output.stdout).toContain(`WOULD plugin-install: api@${TEST_MARKETPLACE_NAME}`);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("refuses a different marketplace source after initialization", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-switch-home-");
    const fake = await createFakeCopilot(undefined, home);
    const first = capture();
    const base = { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: first.out, err: first.err };

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], base)).toBe(0);

    const next = capture();
    expect(await runCli(["init", "--marketplace", "https://github.com/other-org/other-marketplace.git"], {
      ...base,
      out: next.out,
      err: next.err,
    })).toBe(1);
    expect(next.stderr.some((line) => line.includes("Refusing to switch Marketplace during init"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("does not claim or mutate a pre-existing user-owned Team AI role plugin", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-owned-home-");
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
      plugins: [{ name: "api", marketplace: TEST_MARKETPLACE_NAME, version: "0.0.1", enabled: false, source: `marketplace:${TEST_MARKETPLACE_NAME}` }],
    }, home);
    const output = capture();

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: loadFakeMarketplace,
      out: output.out,
      err: output.err,
    })).toBe(0);

    const state = await fake.readState();
    expect(state.plugins.find((item) => item.name === "api")).toMatchObject({ version: "0.0.1", enabled: false });
    const config = await readGlobalConfig(home);
    expect(config?.managedPlugins).not.toContain(`api@${TEST_MARKETPLACE_NAME}`);
    expect(config?.managedPlugins).toHaveLength(5);
    expect(output.stdout.some((line) => line.includes("preserving the override"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("warns when an enabled desired plugin remains user-owned", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-enabled-owned-home-");
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
      plugins: [{ name: "api", marketplace: TEST_MARKETPLACE_NAME, version: "0.1.0", enabled: true, source: `marketplace:${TEST_MARKETPLACE_NAME}` }],
    }, home);
    const output = capture();

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: loadFakeMarketplace,
      out: output.out,
      err: output.err,
    })).toBe(0);

    expect((await fake.readState()).plugins.find((item) => item.name === "api")).toMatchObject({ version: "0.1.0", enabled: true });
    expect((await readGlobalConfig(home))?.managedPlugins).not.toContain(`api@${TEST_MARKETPLACE_NAME}`);
    expect(output.stdout.some((line) => line.includes("not Team AI managed"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("preserves unowned disabled live-marketplace plugins as role overrides", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-live-marketplace-home-");
    const catalog = await loadFakeMarketplace();
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: catalog.root }],
      plugins: [
        { name: "common", marketplace: TEST_MARKETPLACE_NAME, version: "0.1.0", enabled: false, source: `live-marketplace:${TEST_MARKETPLACE_NAME}` },
        { name: "design", marketplace: TEST_MARKETPLACE_NAME, version: "0.1.0", enabled: false, source: `live-marketplace:${TEST_MARKETPLACE_NAME}` },
      ],
    }, home);
    const output = capture();

    expect(await runCli(["init", "--marketplace", catalog.root, "--role", "design"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => catalog,
      out: output.out,
      err: output.err,
    })).toBe(0);

    const state = await fake.readState();
    expect(state.plugins.find((item) => item.name === "common")?.enabled).toBe(false);
    expect(state.plugins.find((item) => item.name === "design")?.enabled).toBe(false);
    const config = await readGlobalConfig(home);
    expect(config?.managedPlugins).toHaveLength(4);
    expect(config?.managedPlugins).not.toContain(`common@${TEST_MARKETPLACE_NAME}`);
    expect(config?.managedPlugins).not.toContain(`design@${TEST_MARKETPLACE_NAME}`);
    expect(output.stdout.filter((line) => line.includes("plugin-install")).length).toBe(4);
    expect(output.stdout.some((line) => line.includes("user-owned and differs from the selected role"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("binds Logical Projects only through projects set and removes only owned components when switched", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-logical-project-home-");
    const excludePath = path.join(repo, ".git", "info", "exclude");
    const initialExclude = "# user project exclude\n";
    await writeFile(excludePath, initialExclude, "utf8");
    const marketplace = await tempDir("teamai-logical-project-marketplace-");
    await mkdir(path.join(marketplace, "manifest"), { recursive: true });
    await mkdir(path.join(marketplace, "contexts", "payments", "instructions"), { recursive: true });
    await mkdir(path.join(marketplace, "contexts", "risk", "docs"), { recursive: true });
    await mkdir(path.join(marketplace, "learnings", "shared"), { recursive: true });
    await writeFile(path.join(marketplace, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payment domain\n    owners: [payments]\n    plugin: payments\n  - id: risk\n    name: Risk\n    description: Risk domain\n    owners: [risk]\n", "utf8");
    await writeFile(path.join(marketplace, "contexts", "payments", "instructions", "payments.instructions.md"), "---\napplyTo: \"**\"\n---\n\npayments\n", "utf8");
    await writeFile(path.join(marketplace, "contexts", "risk", "docs", "risk.md"), "risk\n", "utf8");
    await writeFile(path.join(marketplace, "learnings", "shared", "shared.md"), "shared\n", "utf8");
    const settingsPath = path.join(repo, ".github", "copilot", "settings.json");
    const loadMarketplace = async () => loadFakeMarketplace(marketplace);
    const skillSource = path.join(marketplace, "plugins", "payments", "skills", "payments-probe", "SKILL.md");
    await mkdir(path.dirname(skillSource), { recursive: true });
    await writeFile(skillSource, "---\nname: payments-probe\ndescription: Payments workspace probe\n---\n\nPayments component\n", "utf8");
    const projectedSkill = path.join(repo, ".github", "skills", "payments-probe", "SKILL.md");
    const sharedLearning = path.join(repo, ".teamai", "context", "shared", "learnings", "5c624d53-d6f2-4645-9225-b52d41e9e6af.md");
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();

    const rejected = capture();
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api", "--project", "payments"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: rejected.out, err: rejected.err })).toBe(2);
    expect(rejected.stderr.join("\n")).toContain("--project is not supported by init.\nUse `teamai projects set <ids...>` inside the target Git repository.");
    expect(await readGlobalConfig(home)).toBeUndefined();

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readFile(path.join(repo, ".github", "copilot", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await runCli(["sync"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);

    await mkdir(path.join(repo, ".github", "instructions"), { recursive: true });
    await writeFile(path.join(repo, ".github", "instructions", "personal.instructions.md"), "personal instruction\n", "utf8");
    await mkdir(path.join(repo, ".teamai"), { recursive: true });
    await writeFile(path.join(repo, ".teamai", "notes.md"), "personal note\n", "utf8");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({ custom: { keep: true }, enabledPlugins: { "user-plugin@other": true } }), "utf8");
    const personalSettings = await readFile(settingsPath);

    expect(await runCli(["projects", "set", "payments,risk"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "payments", "payments.instructions.md"), "utf8")).resolves.toContain("applyTo: \"**\"");
    await expect(readFile(path.join(repo, ".teamai", "context", "risk", "docs", "risk.md"), "utf8")).resolves.toBe("risk\n");
    await expect(readFile(projectedSkill)).resolves.toEqual(await readFile(skillSource));
    await expect(readFile(sharedLearning, "utf8")).resolves.toBe("---\nid: 5c624d53-d6f2-4645-9225-b52d41e9e6af\n---\nTest published learning\n");
    await expect(readFile(settingsPath)).resolves.toEqual(personalSettings);
    const settings = JSON.parse(await readFile(path.join(repo, ".github", "copilot", "settings.json"), "utf8"));
    expect(settings.enabledPlugins[`payments@${TEST_MARKETPLACE_NAME}`]).toBeUndefined();
    expect((await fake.readState()).plugins.some((plugin) => plugin.name === "payments")).toBe(false);

    const otherRepo = await createGitRepo();
    expect(await runCli(["projects", "set", "risk"], { cwd: otherRepo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    const otherIdentity = await detectProjectIdentity(otherRepo);
    const otherStatePath = path.join(partitionPath(otherIdentity!.projectAnchor, home), "state.json");
    const otherState = await readFile(otherStatePath, "utf8");
    await expect(readFile(path.join(otherRepo, ".github", "skills", "payments-probe", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const siblingRepo = path.join(await tempDir("teamai-linked-worktree-parent-"), "sibling");
    const worktreeResult = await runProcess("git", ["worktree", "add", "-b", "sibling-test", siblingRepo], { cwd: repo });
    expect(worktreeResult.exitCode).toBe(0);
    const workerPath = fileURLToPath(new URL("../helpers/project-state-worker.ts", import.meta.url));
    const viteNodePath = path.join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs");
    const runProjectSetProcess = (workspace: string, ids: string) => runProcess(process.execPath, [viteNodePath, "--script", workerPath, workspace, home, marketplace, ids], { cwd: workspace });
    const [mainResult, siblingResult] = await Promise.all([
      runProjectSetProcess(repo, "payments,risk"),
      runProjectSetProcess(siblingRepo, "risk"),
    ]);
    if (mainResult.exitCode !== 0) {
      expect(mainResult.exitCode).toBe(1);
      expect(mainResult.stderr).toContain("Project state conflict");
      expect((await runProjectSetProcess(repo, "payments,risk")).exitCode).toBe(0);
    }
    if (siblingResult.exitCode !== 0) {
      expect(siblingResult.exitCode).toBe(1);
      expect(siblingResult.stderr).toContain("Project state conflict");
      expect((await runProjectSetProcess(siblingRepo, "risk")).exitCode).toBe(0);
    }
    const repoIdentity = await detectProjectIdentity(repo);
    const repoStatePath = path.join(partitionPath(repoIdentity!.projectAnchor, home), "state.json");
    const siblingIdentity = await detectProjectIdentity(siblingRepo);
    const stateWithSibling = JSON.parse(await readFile(repoStatePath, "utf8"));
    expect(stateWithSibling.projections[projectionKey(repoIdentity!.workspaceRoot)].logicalProjects).toEqual(["payments", "risk"]);
    expect(stateWithSibling.projections[projectionKey(siblingIdentity!.workspaceRoot)].logicalProjects).toEqual(["risk"]);
    await expect(readFile(path.join(siblingRepo, ".github", "skills", "payments-probe", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });

    const staleState = JSON.parse(await readFile(repoStatePath, "utf8"));
    const component = staleState.projections[projectionKey(repoIdentity!.workspaceRoot)].managedProjectComponents[0];
    expect(component.targetPath).toBe(".github/skills/payments-probe/SKILL.md");
    component.sourceHash = "0".repeat(64);
    await writeFile(repoStatePath, `${JSON.stringify(staleState, null, 2)}\n`, "utf8");
    const staleDoctor = capture();
    expect(await runCli(["doctor"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: staleDoctor.out, err: staleDoctor.err })).toBe(0);
    expect(staleDoctor.stdout).toContain("! Logical Project context is stale. Run teamai sync.");
    expect(JSON.parse(await readFile(repoStatePath, "utf8")).projections[projectionKey(repoIdentity!.workspaceRoot)].managedProjectComponents[0].sourceHash).toBe("0".repeat(64));

    await writeFile(path.join(marketplace, "contexts", "payments", "instructions", "payments.instructions.md"), "---\napplyTo: \"**\"\n---\n\npayments v2\n", "utf8");
    expect(await runCli(["sync"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "payments", "payments.instructions.md"), "utf8")).resolves.toContain("payments v2");
    await expect(readFile(path.join(repo, ".teamai", "context", "risk", "docs", "risk.md"), "utf8")).resolves.toBe("risk\n");
    await expect(readFile(otherStatePath, "utf8")).resolves.toBe(otherState);
    expect(JSON.parse(await readFile(repoStatePath, "utf8")).projections[projectionKey(repoIdentity!.workspaceRoot)].managedProjectComponents[0].sourceHash).not.toBe("0".repeat(64));
    await expect(readFile(projectedSkill)).resolves.toEqual(await readFile(skillSource));
    await expect(readFile(path.join(otherRepo, ".github", "instructions", "teamai", "payments", "payments.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    expect(await runCli(["init"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    const listed = capture();
    expect(await runCli(["projects"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: listed.out, err: listed.err })).toBe(0);
    expect(listed.stdout.some((line) => line.startsWith("* payments"))).toBe(true);
    expect(listed.stdout.some((line) => line.startsWith("* risk"))).toBe(true);

    expect(await runCli(["projects", "set", "risk"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "payments", "payments.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(projectedSkill)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sharedLearning, "utf8")).resolves.toBe("---\nid: 5c624d53-d6f2-4645-9225-b52d41e9e6af\n---\nTest published learning\n");
    const excludeBeforeUnbind = await readFile(excludePath, "utf8");
    expect(await runCli(["projects", "set"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readFile(path.join(repo, ".teamai", "context", "risk", "docs", "risk.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(sharedLearning)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(repo, ".teamai", "context"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(repo, ".github", "instructions", "teamai"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "instructions", "personal.instructions.md"), "utf8")).resolves.toBe("personal instruction\n");
    await expect(readFile(path.join(repo, ".teamai", "notes.md"), "utf8")).resolves.toBe("personal note\n");
    const unboundSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(unboundSettings.custom).toEqual({ keep: true });
    expect(unboundSettings.enabledPlugins["user-plugin@other"]).toBe(true);
    expect(unboundSettings.enabledPlugins["payments@" + TEST_MARKETPLACE_NAME]).toBeUndefined();
    await expect(readFile(settingsPath)).resolves.toEqual(personalSettings);
    const unboundState = JSON.parse(await readFile(repoStatePath, "utf8"));
    expect(Object.keys(unboundState.projections)).toEqual([projectionKey(siblingIdentity!.workspaceRoot)]);
    await expect(readFile(path.join(siblingRepo, ".teamai", "context", "risk", "docs", "risk.md"), "utf8")).resolves.toBe("risk\n");

    expect(await runCli(["sync"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(excludePath, "utf8")).toBe(excludeBeforeUnbind);
    expect(JSON.parse(await readFile(repoStatePath, "utf8")).projections[projectionKey(siblingIdentity!.workspaceRoot)].logicalProjects).toEqual(["risk"]);

    expect(await runCli(["projects", "set", "risk"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"), "utf8")).resolves.toContain("Active Logical Projects: risk");
    await expect(readFile(path.join(repo, ".teamai", "context", "risk", "docs", "risk.md"), "utf8")).resolves.toBe("risk\n");
    expect(JSON.parse(await readFile(repoStatePath, "utf8")).projections[projectionKey(siblingIdentity!.workspaceRoot)].logicalProjects).toEqual(["risk"]);
    expect(await runCli(["projects", "set"], { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readdir(path.join(repo, ".teamai", "context"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readdir(path.join(repo, ".github", "instructions", "teamai"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(repoStatePath, "utf8")).projections[projectionKey(siblingIdentity!.workspaceRoot)].logicalProjects).toEqual(["risk"]);

    expect(await runCli(["projects", "set"], { cwd: siblingRepo, homeDir: home, copilot: fake.client, loadMarketplace, out: output.out, err: output.err })).toBe(0);
    await expect(readFile(repoStatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(excludePath, "utf8")).toBe(initialExclude);
    expect(JSON.parse(await readFile(path.join(repo, ".github", "copilot", "settings.json"), "utf8")).enabledPlugins[`payments@${TEST_MARKETPLACE_NAME}`]).toBeUndefined();
  }, 120_000);

  test("status and doctor do not start Copilot to inspect runtime-only state", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-capabilities-home-");
    const fake = await createFakeCopilot(undefined, home);
    const tracked = trackCopilotCalls(fake.client);

    const status = capture();
    expect(await runCli(["status"], {
      cwd: repo,
      homeDir: home,
      copilot: tracked.client,
      loadMarketplace: loadFakeMarketplace,
      out: status.out,
      err: status.err,
    })).toBe(0);
    expect(status.stdout).toContain("  Native MCP servers: runtime unobserved (status is read-only)");
    expect(status.stdout).toContain("  Native Plugin Hooks: declaration validation only; runtime inspection unavailable");

    const doctor = capture();
    expect(await runCli(["doctor"], {
      cwd: repo,
      homeDir: home,
      copilot: tracked.client,
      loadMarketplace: loadFakeMarketplace,
      out: doctor.out,
      err: doctor.err,
    })).toBe(0);
    expect(doctor.stdout).toContain("! Copilot runtime and native MCP state are unobserved by this read-only diagnostic.");
    expect(tracked.calls).toEqual([]);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("status and doctor leave persistent state unchanged", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-read-only-home-");
    const fake = await createFakeCopilot(undefined, home);
    const tracked = trackCopilotCalls(fake.client);
    const output = capture();

    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }), home);
    const vscodeSettingsPath = path.join(home, "Code", "settings.json");
    await mkdir(path.dirname(vscodeSettingsPath), { recursive: true });
    await writeFile(vscodeSettingsPath, JSON.stringify({ "chat.plugins.marketplaces": [TEST_MARKETPLACE_SOURCE] }), "utf8");
    const before = await snapshotFiles(home);
    let refreshRequested = false;
    const loadReadOnlyCatalog = async (_source: string, _cwd: string, options?: { refresh?: boolean }) => {
      refreshRequested ||= options?.refresh === true;
      return loadFakeMarketplace();
    };
    expect(await runCli(["status"], {
      cwd: repo,
      homeDir: home,
      copilot: tracked.client,
      vscodeSettingsPath,
      loadMarketplace: loadReadOnlyCatalog,
      out: output.out,
      err: output.err,
    })).toBe(0);
    expect(await runCli(["doctor"], {
      cwd: repo,
      homeDir: home,
      copilot: tracked.client,
      vscodeSettingsPath,
      loadMarketplace: loadReadOnlyCatalog,
      out: output.out,
      err: output.err,
    })).toBe(0);
    expect(tracked.calls).toEqual([]);
    expect(refreshRequested).toBe(false);
    expect(await snapshotFiles(home)).toEqual(before);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("invalid flags fail before backend or Marketplace work and use usage exit code 2", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-invalid-flags-home-");
    const fake = await createFakeCopilot(undefined, home);
    const tracked = trackCopilotCalls(fake.client);
    let marketplaceLoads = 0;
    let vscodeChecks = 0;
    const invalidArgs = [
      ["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api", "--unknown"],
      ["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api", "--role", "qa"],
      ["init", "--marketplace"],
      ["skill", "list", "--tag"],
      ["learning", "share"],
      ["learning", "retry"],
      ["recall"],
      ["role", "set"],
      ["skill", "show"],
      ["skill", "contribute"],
    ];
    for (const args of invalidArgs) {
      const output = capture();
      expect(await runCli(args, {
        cwd: repo,
        homeDir: home,
        copilot: tracked.client,
        vscodeAvailable: async () => { vscodeChecks += 1; return true; },
        loadMarketplace: async () => { marketplaceLoads += 1; return loadFakeMarketplace(); },
        out: output.out,
        err: output.err,
      })).toBe(2);
      expect(output.stderr[0]).toContain("ERROR:");
    }
    expect(tracked.calls).toEqual([]);
    expect(vscodeChecks).toBe(0);
    expect(marketplaceLoads).toBe(0);
    expect(await snapshotFiles(home)).toEqual([]);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("validates malformed options before help and business arguments before version", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-help-validation-home-");
    const fake = await createFakeCopilot(undefined, home);
    const tracked = trackCopilotCalls(fake.client);
    let marketplaceLoads = 0;
    let vscodeChecks = 0;
    const invalidArgs = [
      ["init", "--bogus", "--help"],
      ["unknown-command", "--help"],
      ["help", "unknown-command"],
      ["recall", "--bogus", "--help"],
      ["recall", "--scope", "invalid", "--help"],
      ["recall", "--scope", "auto", "--scope", "user", "--help"],
      ["recall", "--help", "--help"],
      ["recall", "--version"],
      ["init", "--role", "--help"],
      ["init", "--role", "api", "--role", "qa", "--version"],
      ["--dry-run", "--dry-run"],
      ["--help", "--dry-run", "--dry-run"],
      ["--version", "--dry-run", "--dry-run"],
    ];
    for (const args of invalidArgs) {
      const output = capture();
      expect(await runCli(args, {
        cwd: repo,
        homeDir: home,
        copilot: tracked.client,
        vscodeAvailable: async () => { vscodeChecks += 1; return true; },
        loadMarketplace: async () => { marketplaceLoads += 1; return loadFakeMarketplace(); },
        out: output.out,
        err: output.err,
      })).toBe(2);
      expect(output.stderr[0]).toContain("ERROR:");
    }
    const help = capture();
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api", "--help"], {
      out: help.out,
      err: help.err,
    })).toBe(0);
    expect(help.stdout.join("\n")).toContain("teamai <command> [options]");
    const version = capture();
    expect(await runCli(["--version"], { out: version.out, err: version.err })).toBe(0);
    expect(version.stdout).toEqual(["0.5.0"]);
    const dryRunHelp = capture();
    expect(await runCli(["--dry-run"], { out: dryRunHelp.out, err: dryRunHelp.err })).toBe(0);
    expect(dryRunHelp.stdout.join("\n")).toContain("teamai <command> [options]");
    expect(tracked.calls).toEqual([]);
    expect(vscodeChecks).toBe(0);
    expect(marketplaceLoads).toBe(0);
    expect(await snapshotFiles(home)).toEqual([]);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("supported command help is text-only without business arguments or runtime access", async () => {
    const root = await tempDir("teamai-command-help-");
    const home = path.join(root, "uninitialized-home");
    const cwd = path.join(root, "uninitialized-workspace");
    const tracked = trackCopilotCalls(new CopilotClient("must-not-run-copilot", [], home));
    let marketplaceLoads = 0;
    let vscodeChecks = 0;
    let contributions = 0;
    const overrides = {
      cwd,
      homeDir: home,
      copilot: tracked.client,
      vscodeAvailable: async () => { vscodeChecks += 1; throw new Error("Help must not probe VS Code."); },
      loadMarketplace: async () => { marketplaceLoads += 1; throw new Error("Help must not load a Marketplace."); },
      contributeGitHub: async () => { contributions += 1; throw new Error("Help must not submit a contribution."); },
    };
    const commandForms = [
      ["recall"],
      ["init"],
      ["sync"],
      ["role"],
      ["role", "list"],
      ["role", "set"],
      ["projects"],
      ["projects", "list"],
      ["projects", "set"],
      ["learning"],
      ["learning", "share"],
      ["learning", "pending"],
      ["learning", "retry"],
      ["skill"],
      ["skill", "list"],
      ["skill", "show"],
      ["skill", "install"],
      ["skill", "remove"],
      ["skill", "contribute"],
      ["tags"],
      ["tags", "list"],
      ["status"],
      ["doctor"],
    ];
    for (const command of commandForms) {
      for (const args of [[...command, "--help"], ["help", ...command]]) {
        const output = capture();
        expect(await runCli(args, { ...overrides, out: output.out, err: output.err }), args.join(" ")).toBe(0);
        expect(output.stderr).toEqual([]);
        const text = output.stdout.join("\n");
        expect(text).toContain("recall <query>");
        expect(text).toContain("--scope auto|user|workspace");
        expect(() => JSON.parse(text)).toThrow();
      }
    }
    for (const args of [["recall", "--help", "--json"], ["--dry-run", "help", "recall"]]) {
      const output = capture();
      expect(await runCli(args, { ...overrides, out: output.out, err: output.err })).toBe(0);
      expect(output.stderr).toEqual([]);
      expect(output.stdout.join("\n")).toContain("recall <query>");
      expect(() => JSON.parse(output.stdout.join("\n"))).toThrow();
    }
    expect(tracked.calls).toEqual([]);
    expect(vscodeChecks).toBe(0);
    expect(marketplaceLoads).toBe(0);
    expect(contributions).toBe(0);
    expect(await readdir(root)).toEqual([]);
  });

  test("status returns failure when Copilot local state cannot be parsed", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-status-invalid-copilot-state-home-");
    const fake = await createFakeCopilot(undefined, home);
    const tracked = trackCopilotCalls(fake.client);
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }), home);
    const copilotRoot = path.join(home, ".copilot");
    await mkdir(copilotRoot, { recursive: true });
    await writeFile(path.join(copilotRoot, "settings.json"), "{ invalid json", "utf8");
    const output = capture();
    expect(await runCli(["status"], {
      cwd: repo,
      homeDir: home,
      copilot: tracked.client,
      out: output.out,
      err: output.err,
    })).toBe(1);
    expect(output.stdout.some((line) => line.includes("Copilot local settings: unavailable"))).toBe(true);
    expect(output.stderr.some((line) => line.startsWith("ERROR:"))).toBe(true);
    expect(tracked.calls).toEqual([]);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("doctor verifies installed plugin manifest identity before reporting managed skills current", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-doctor-unmaterialized-plugin-home-");
    const catalogRoot = await tempDir("teamai-doctor-unmaterialized-plugin-catalog-");
    const skillRoot = path.join(catalogRoot, "plugins", "api", "skills", "api-review");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: api-review\ndescription: Review API changes\n---\n", "utf8");
    const skill: CatalogSkill = {
      name: "api-review",
      description: "Review API changes",
      sourceType: "plugin",
      plugin: "api",
      sourcePath: "plugins/api/skills/api-review",
      root: skillRoot,
      owner: "api",
      tags: [],
      standalone: true,
    };
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    config.managedSkills = ["api-review"];
    await writeGlobalConfig(config, home);
    const copilotRoot = path.join(home, ".copilot");
    const apiCache = path.join(copilotRoot, "installed-plugins", "marketplace", "api");
    const commonCache = path.join(copilotRoot, "installed-plugins", "marketplace", "common");
    await mkdir(apiCache, { recursive: true });
    await mkdir(commonCache, { recursive: true });
    await writeFile(path.join(apiCache, "plugin.json"), JSON.stringify({ name: "api", version: "0.9.0" }), "utf8");
    await writeFile(path.join(commonCache, "plugin.json"), JSON.stringify({ name: "not-common", version: "1.0.0" }), "utf8");
    await writeFile(path.join(copilotRoot, "config.json"), JSON.stringify({
      installedPlugins: [
        { name: "api", marketplace: TEST_MARKETPLACE_NAME, version: "1.0.0", enabled: true, cache_path: apiCache },
        { name: "common", marketplace: TEST_MARKETPLACE_NAME, version: "1.0.0", enabled: true, cache_path: commonCache },
      ],
    }), "utf8");
    await writeFile(path.join(copilotRoot, "settings.json"), JSON.stringify({
      enabledPlugins: {
        ["api@" + TEST_MARKETPLACE_NAME]: true,
        ["common@" + TEST_MARKETPLACE_NAME]: true,
      },
    }), "utf8");
    const vscodeSettingsPath = path.join(home, "Code", "settings.json");
    await mkdir(path.dirname(vscodeSettingsPath), { recursive: true });
    await writeFile(vscodeSettingsPath, JSON.stringify({ "chat.plugins.marketplaces": [TEST_MARKETPLACE_SOURCE] }), "utf8");
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();
    const loadMarketplace = async () => ({
      ...(await loadFakeMarketplace(catalogRoot)),
      skills: [skill],
    });

    expect(await runCli(["doctor"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      vscodeSettingsPath,
      loadMarketplace,
      out: output.out,
      err: output.err,
    })).toBe(0);
    expect(output.stdout.some((line) =>
      line.includes("Managed personal Skill availability is unknown") &&
      line.includes("api@" + TEST_MARKETPLACE_NAME) &&
      line.includes("common@" + TEST_MARKETPLACE_NAME),
    )).toBe(true);
    expect(output.stdout).not.toContain("✓ Managed personal skills: current.");
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("does not choose fallback when the native Copilot executable fails", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-native-copilot-failure-home-");
    const fake = await createFakeCopilot(undefined, home);
    const calls: string[] = [];
    let vscodeChecks = 0;
    let marketplaceLoads = 0;
    const nativeFailure = new Proxy(fake.client, {
      get(target, key, receiver) {
        if (key === "version") {
          return async () => {
            calls.push("version");
            throw new Error("native Copilot is installed but rejected --version");
          };
        }
        return Reflect.get(target, key, receiver);
      },
    });
    const output = capture();
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd: repo,
      homeDir: home,
      copilot: nativeFailure,
      vscodeAvailable: async () => { vscodeChecks += 1; return true; },
      loadMarketplace: async () => { marketplaceLoads += 1; return loadFakeMarketplace(); },
      out: output.out,
      err: output.err,
    })).toBe(1);
    expect(output.stderr.join("\n")).toContain("native Copilot is installed but rejected --version");
    expect(calls).toEqual(["version"]);
    expect(vscodeChecks).toBe(0);
    expect(marketplaceLoads).toBe(0);
    expect(await snapshotFiles(home)).toEqual([]);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("invalid COPILOT_HOME fails before read-only command work", async () => {
    const prior = process.env.COPILOT_HOME;
    const repo = await createGitRepo();
    const home = await tempDir("teamai-invalid-copilot-root-home-");
    const fake = await createFakeCopilot(undefined, home);
    const tracked = trackCopilotCalls(fake.client);
    let marketplaceLoads = 0;
    process.env.COPILOT_HOME = "relative/copilot";
    try {
      const output = capture();
      expect(await runCli(["status"], {
        cwd: repo,
        homeDir: home,
        copilot: tracked.client,
        loadMarketplace: async () => { marketplaceLoads += 1; return loadFakeMarketplace(); },
        out: output.out,
        err: output.err,
      })).toBe(1);
      expect(output.stderr.join("\n")).toContain("COPILOT_HOME must be an absolute directory path.");
      expect(tracked.calls).toEqual([]);
      expect(marketplaceLoads).toBe(0);
      expect(await snapshotFiles(home)).toEqual([]);

      process.env.COPILOT_HOME = path.parse(path.resolve(path.sep)).root;
      const unsafeRoot = capture();
      expect(await runCli(["status"], {
        cwd: repo,
        homeDir: home,
        copilot: tracked.client,
        loadMarketplace: async () => { marketplaceLoads += 1; return loadFakeMarketplace(); },
        out: unsafeRoot.out,
        err: unsafeRoot.err,
      })).toBe(1);
      expect(unsafeRoot.stderr.join("\n")).toContain("COPILOT_HOME cannot be a filesystem root.");
      expect(tracked.calls).toEqual([]);
      expect(marketplaceLoads).toBe(0);
      expect(await snapshotFiles(home)).toEqual([]);
    } finally {
      if (prior === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = prior;
    }
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("init mirrors nested user instructions byte-for-byte and preserves personal files", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-init-home-");
    const marketplace = await tempDir("teamai-instructions-init-marketplace-");
    const source = path.join(marketplace, "instructions");
    await mkdir(path.join(source, "git"), { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), Buffer.from("global\r\n\0", "utf8"));
    await writeFile(path.join(source, "git", "commit.instructions.md"), "commit rules\n", "utf8");
    const personalPath = path.join(home, ".copilot", "instructions", "personal.instructions.md");
    const privatePath = path.join(home, ".copilot", "instructions", "private", "team.instructions.md");
    const rootPersonalPath = path.join(home, ".copilot", "copilot-instructions.md");
    const personalContent = Buffer.from("personal\r\n\0", "utf8");
    const privateContent = Buffer.from("private\n\0", "utf8");
    const rootPersonalContent = Buffer.from("root personal\r\n\0", "utf8");
    await mkdir(path.dirname(personalPath), { recursive: true });
    await mkdir(path.dirname(privatePath), { recursive: true });
    await writeFile(personalPath, personalContent);
    await writeFile(privatePath, privateContent);
    await writeFile(rootPersonalPath, rootPersonalContent);
    const fake = await createFakeCopilot(undefined, home);
    const output = capture();

    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(marketplace),
      out: output.out,
      err: output.err,
    })).toBe(0);

    const target = path.join(home, ".copilot", "instructions", "teamai");
    expect(await readFile(path.join(target, "global.instructions.md"))).toEqual(Buffer.from("global\r\n\0", "utf8"));
    expect(await readFile(path.join(target, "git", "commit.instructions.md"), "utf8")).toBe("commit rules\n");
    expect(await readFile(personalPath)).toEqual(personalContent);
    expect(await readFile(privatePath)).toEqual(privateContent);
    expect(await readFile(rootPersonalPath)).toEqual(rootPersonalContent);
    expect(output.stdout).toContain("DONE create: ~/.copilot/instructions/teamai/global.instructions.md");
    expect(output.stdout.join("\n")).not.toContain("commit rules");
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("sync converges changes and dry-run performs no instruction writes", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-sync-home-");
    const marketplace = await tempDir("teamai-instructions-sync-marketplace-");
    const source = path.join(marketplace, "instructions");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), "v1\n", "utf8");
    const fake = await createFakeCopilot(undefined, home);
    const loadMarketplace = async () => loadFakeMarketplace(marketplace);
    const base = { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace };
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { ...base, ...capture() })).toBe(0);

    const target = path.join(home, ".copilot", "instructions", "teamai");
    await writeFile(path.join(source, "global.instructions.md"), "v2\n", "utf8");
    await writeFile(path.join(source, "nested.instructions.md"), "new body\n", "utf8");
    await writeFile(path.join(target, "global.instructions.md"), "local edit\n", "utf8");
    const dry = capture();
    expect(await runCli(["--dry-run", "sync"], { ...base, out: dry.out, err: dry.err })).toBe(0);
    expect(await readFile(path.join(target, "global.instructions.md"), "utf8")).toBe("local edit\n");
    expect(await readFile(path.join(target, "nested.instructions.md")).catch((error: NodeJS.ErrnoException) => error.code)).toBe("ENOENT");
    expect(dry.stdout).toContain("WOULD update: ~/.copilot/instructions/teamai/global.instructions.md");
    expect(dry.stdout).not.toContain("new body");

    const actual = capture();
    expect(await runCli(["sync"], { ...base, out: actual.out, err: actual.err })).toBe(0);
    expect(await readFile(path.join(target, "global.instructions.md"), "utf8")).toBe("v2\n");
    expect(await readFile(path.join(target, "nested.instructions.md"), "utf8")).toBe("new body\n");

    await rm(source, { recursive: true, force: true });
    const removed = capture();
    expect(await runCli(["sync"], { ...base, out: removed.out, err: removed.err })).toBe(0);
    await expect(readFile(path.join(target, "global.instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(target, "nested.instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(removed.stdout).toContain("DONE remove: ~/.copilot/instructions/teamai/global.instructions.md");

    await mkdir(source, { recursive: true });
    await writeFile(path.join(target, "stale.instructions.md"), "stale\n", "utf8");
    const emptied = capture();
    expect(await runCli(["sync"], { ...base, out: emptied.out, err: emptied.err })).toBe(0);
    await expect(readFile(path.join(target, "stale.instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(emptied.stdout).toContain("DONE remove: ~/.copilot/instructions/teamai/stale.instructions.md");
  }, 120_000);

  test("status and doctor report current and stale managed instructions", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-doctor-home-");
    const marketplace = await tempDir("teamai-instructions-doctor-marketplace-");
    const source = path.join(marketplace, "instructions");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), "global\n", "utf8");
    const fake = await createFakeCopilot(undefined, home);
    const loadMarketplace = async () => loadFakeMarketplace(marketplace);
    const base = { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace };
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { ...base, ...capture() })).toBe(0);

    const status = capture();
    expect(await runCli(["status"], { ...base, out: status.out, err: status.err })).toBe(0);
    expect(status.stdout.some((line) => line.includes("User instructions: 1 managed, current"))).toBe(true);

    await writeFile(path.join(home, ".copilot", "instructions", "teamai", "global.instructions.md"), "modified\n", "utf8");
    const doctor = capture();
    expect(await runCli(["doctor"], { ...base, out: doctor.out, err: doctor.err })).toBe(0);
    expect(doctor.stdout.some((line) => line.includes("Managed user instructions: stale"))).toBe(true);

    const staleStatus = capture();
    expect(await runCli(["status"], { ...base, out: staleStatus.out, err: staleStatus.err })).toBe(0);
    expect(staleStatus.stdout.some((line) => line.includes("User instructions: stale"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("status reports an empty desired and installed instruction state", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-empty-status-home-");
    const marketplace = await tempDir("teamai-instructions-empty-status-marketplace-");
    await mkdir(path.join(marketplace, "instructions"), { recursive: true });
    await mkdir(path.join(home, ".copilot", "instructions", "teamai"), { recursive: true });
    await writeGlobalConfig(createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }), home);
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
    }, home);
    const output = capture();

    expect(await runCli(["status"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(marketplace),
      out: output.out,
      err: output.err,
    })).toBe(0);
    expect(output.stdout).toContain("  User instructions: 0 managed, current");
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("doctor reports an unwritable planned instruction directory without repairing", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-unwritable-doctor-home-");
    const marketplace = await tempDir("teamai-instructions-unwritable-doctor-marketplace-");
    const source = path.join(marketplace, "instructions", "blocked");
    const targetRoot = path.join(home, ".copilot", "instructions", "teamai");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "new.instructions.md"), "managed\n", "utf8");
    await mkdir(targetRoot, { recursive: true });
    const blockedParent = path.join(targetRoot, "blocked");
    await writeFile(blockedParent, "not a directory\n", "utf8");
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    await writeGlobalConfig(config, home);
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
    }, home);
    const output = capture();

    expect(await runCli(["doctor"], {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(marketplace),
      out: output.out,
      err: output.err,
    })).toBe(1);
    expect(output.stdout.some((line) => line.includes("Managed user instruction target is not writable"))).toBe(true);
    expect(await readFile(blockedParent, "utf8")).toBe("not a directory\n");
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("doctor and sync reject a non-file managed instruction path before writing", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-occupied-path-home-");
    const marketplace = await tempDir("teamai-instructions-occupied-path-marketplace-");
    const source = path.join(marketplace, "instructions");
    const targetRoot = path.join(home, ".copilot", "instructions", "teamai");
    const occupiedPath = path.join(targetRoot, "global.instructions.md");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), "managed\n", "utf8");
    await mkdir(occupiedPath, { recursive: true });
    await writeFile(path.join(occupiedPath, "keep.txt"), "keep\n", "utf8");
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    await writeGlobalConfig(config, home);
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
    }, home);
    const base = {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(marketplace),
    };

    const doctor = capture();
    expect(await runCli(["doctor"], { ...base, out: doctor.out, err: doctor.err })).toBe(1);
    expect(doctor.stdout.some((line) => line.includes("Unsafe managed user instruction target") && line.includes("global.instructions.md"))).toBe(true);
    expect(await readFile(path.join(occupiedPath, "keep.txt"), "utf8")).toBe("keep\n");

    const sync = capture();
    expect(await runCli(["sync"], { ...base, out: sync.out, err: sync.err })).toBe(1);
    expect(sync.stderr.some((line) => line.includes("Unsafe managed user instruction target") && line.includes("global.instructions.md"))).toBe(true);
    expect(await readFile(path.join(occupiedPath, "keep.txt"), "utf8")).toBe("keep\n");
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("sync converges instructions when Copilot and VS Code backends are unavailable", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-sync-no-backend-home-");
    const marketplace = await tempDir("teamai-sync-no-backend-marketplace-");
    const source = path.join(marketplace, "instructions");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), "sync without backend\n", "utf8");
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    await writeGlobalConfig(config, home);
    const output = capture();

    expect(await runCli(["sync"], {
      cwd: repo,
      homeDir: home,
      copilot: new CopilotClient("teamai-command-not-installed"),
      vscodeAvailable: async () => false,
      loadMarketplace: async () => loadFakeMarketplace(marketplace),
      out: output.out,
      err: output.err,
    })).toBe(1);

    expect(await readFile(path.join(home, ".copilot", "instructions", "teamai", "global.instructions.md"), "utf8"))
      .toBe("sync without backend\n");
    expect(output.stderr.some((line) => line.includes("plugin convergence could not run"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("status and doctor report an unsafe managed target boundary", async ({ skip }) => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-unsafe-boundary-home-");
    const marketplace = await tempDir("teamai-instructions-unsafe-boundary-marketplace-");
    const external = await tempDir("teamai-instructions-unsafe-boundary-external-");
    const source = path.join(marketplace, "instructions");
    const externalCopilot = path.join(external, ".copilot");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), "managed\n", "utf8");
    await mkdir(externalCopilot, { recursive: true });
    try {
      await createDirectoryLink(externalCopilot, path.join(home, ".copilot"));
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    await writeGlobalConfig(config, home);
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
    }, home);
    const base = {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(marketplace),
    };

    const status = capture();
    expect(await runCli(["status"], { ...base, out: status.out, err: status.err })).toBe(0);
    expect(status.stdout.some((line) => line.includes("User instructions: unavailable") && line.includes("Unsafe managed user instruction target"))).toBe(true);

    const doctor = capture();
    expect(await runCli(["doctor"], { ...base, out: doctor.out, err: doctor.err })).toBe(1);
    expect(doctor.stdout.some((line) => line.includes("Marketplace user instructions could not be read") && line.includes("Unsafe managed user instruction target"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("doctor reports unsafe or unreadable instruction sources without repairing", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-unsafe-source-home-");
    const marketplace = await tempDir("teamai-instructions-unsafe-source-marketplace-");
    const source = path.join(marketplace, "instructions");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), "managed\n", "utf8");
    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
    }, home);
    const base = {
      cwd: repo,
      homeDir: home,
      copilot: fake.client,
      loadMarketplace: async () => loadFakeMarketplace(marketplace),
    };
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { ...base, ...capture() })).toBe(0);
    const targetPath = path.join(home, ".copilot", "instructions", "teamai", "global.instructions.md");
    const managedContent = await readFile(targetPath);

    await rm(source, { recursive: true, force: true });
    await writeFile(source, "not a directory\n", "utf8");
    const unsafeDoctor = capture();
    expect(await runCli(["doctor"], { ...base, out: unsafeDoctor.out, err: unsafeDoctor.err })).toBe(1);
    expect(unsafeDoctor.stdout.some((line) => line.includes("Marketplace user instructions could not be read") && line.includes("Unsafe Marketplace user instructions source"))).toBe(true);
    expect(await readFile(targetPath)).toEqual(managedContent);

    const unreadableDoctor = capture();
    expect(await runCli(["doctor"], {
      ...base,
      loadMarketplace: async () => { throw new Error("Marketplace acquisition failed"); },
      out: unreadableDoctor.out,
      err: unreadableDoctor.err,
    })).toBe(1);
    expect(unreadableDoctor.stdout.some((line) => line.includes("Marketplace/Copilot local diagnostics failed") && line.includes("Marketplace acquisition failed"))).toBe(true);
    expect(await readFile(targetPath)).toEqual(managedContent);
  }, CLI_PROCESS_TEST_TIMEOUT);

  test("sync keeps installed instructions when Marketplace acquisition fails", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-instructions-failure-home-");
    const marketplace = await tempDir("teamai-instructions-failure-marketplace-");
    const source = path.join(marketplace, "instructions");
    await mkdir(source, { recursive: true });
    await writeFile(path.join(source, "global.instructions.md"), "keep me\n", "utf8");
    const fake = await createFakeCopilot(undefined, home);
    const base = { cwd: repo, homeDir: home, copilot: fake.client, loadMarketplace: async () => loadFakeMarketplace(marketplace) };
    expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], { ...base, ...capture() })).toBe(0);

    const failingOutput = capture();
    expect(await runCli(["sync"], {
      ...base,
      loadMarketplace: async () => { throw new Error("Marketplace acquisition failed"); },
      out: failingOutput.out,
      err: failingOutput.err,
    })).toBe(1);
    expect(await readFile(path.join(home, ".copilot", "instructions", "teamai", "global.instructions.md"), "utf8")).toBe("keep me\n");
    expect(failingOutput.stderr.some((line) => line.includes("Marketplace acquisition failed"))).toBe(true);
  }, CLI_PROCESS_TEST_TIMEOUT);
});
