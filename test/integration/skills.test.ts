import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { readGlobalConfig, writeGlobalConfig } from "../../src/config/global.js";
import { createConfig } from "../../src/config/schema.js";
import type { MarketplaceCatalog } from "../../src/copilot/catalog.js";
import { personalSkillPath } from "../../src/copilot/skills.js";
import { createFakeCopilot, loadFakeMarketplace, tempDir, TEST_MARKETPLACE_NAME, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map((root) => rm(root, { recursive: true, force: true })));
  cleanup.clear();
});

test("skill read, tag selection, installation, and removal use explicit managed IDs", async () => {
  const home = await tempDir("teamai-skill-home-");
  const source = await tempDir("teamai-skill-source-");
  cleanup.add(home);
  cleanup.add(source);
  const skillRoot = path.join(source, "skills", "release-helper");
  await mkdir(path.join(skillRoot, "resources"), { recursive: true });
  await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: release-helper\ndescription: Release help\n---\n", "utf8");
  await writeFile(path.join(skillRoot, "resources", "note.txt"), "resource\n", "utf8");
  await writeGlobalConfig(createConfig({ name: "skills-test", source: "skills-test" }), home);
  const catalog: MarketplaceCatalog = {
    name: "skills-test",
    root: source,
    plugins: [
      { name: "common", version: "0.1.0", kind: "common", root: path.join(source, "plugins", "common") },
      { name: "api", version: "0.1.0", kind: "role", root: path.join(source, "plugins", "api") },
    ],
    skills: [{ name: "release-helper", description: "Release help", sourceType: "standalone", sourcePath: "skills/release-helper", root: skillRoot, owner: "release", tags: ["release"], standalone: true }],
    dispose: async () => undefined,
  };
  const fake = await createFakeCopilot({ marketplaceName: "skills-test" });
  const stdout: string[] = [];
  const base = { homeDir: home, cwd: source, copilot: fake.client, loadMarketplace: async () => catalog, out: (line: string) => stdout.push(line), err: () => undefined };

  expect(await runCli(["skill", "list", "--tag", "release"], base)).toBe(0);
  expect(stdout[0]).toContain("release-helper");
  stdout.length = 0;
  expect(await runCli(["tags", "list"], base)).toBe(0);
  expect(stdout).toEqual(["release\t1"]);
  stdout.length = 0;
  expect(await runCli(["skill", "install", "--tag", "release", "--yes"], base)).toBe(0);
  expect(await readFile(path.join(personalSkillPath(home, "release-helper"), "resources", "note.txt"), "utf8")).toBe("resource\n");
  expect(await runCli(["skill", "remove", "release-helper"], base)).toBe(0);
  await expect(readFile(path.join(personalSkillPath(home, "release-helper"), "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });

  await mkdir(personalSkillPath(home, "release-helper"), { recursive: true });
  await writeFile(path.join(personalSkillPath(home, "release-helper"), "SKILL.md"), "user owned\n", "utf8");
  stdout.length = 0;
  expect(await runCli(["skill", "show", "release-helper"], base)).toBe(0);
  expect(stdout).toContain("Local status: unmanaged personal");

  await writeGlobalConfig({ ...(await readGlobalConfig(home))!, managedSkills: ["removed-via-plugin"], managedSkillPaths: {} }, home);
  expect(await runCli(["skill", "remove", "removed-via-plugin"], { ...base, loadMarketplace: async () => ({ ...catalog, skills: [] }) })).toBe(0);
  expect((await readGlobalConfig(home))?.managedSkills).toEqual([]);
});

test("dry-run sync uses planned plugin enablement for selected plugin skills", async () => {
  const home = await tempDir("teamai-skill-sync-home-");
  const source = await tempDir("teamai-skill-sync-source-");
  cleanup.add(home);
  cleanup.add(source);
  const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
  config.role = "api";
  config.managedSkills = ["api-review"];
  await writeGlobalConfig(config, home);
  const baseCatalog = await loadFakeMarketplace(source);
  const catalog: MarketplaceCatalog = {
    ...baseCatalog,
    skills: [{ name: "api-review", description: "API review", sourceType: "plugin", plugin: "api", sourcePath: "plugins/api/skills/api-review", root: path.join(source, "plugins", "api", "skills", "api-review"), owner: "api", tags: [], standalone: false }],
  };
  const fake = await createFakeCopilot();

  expect(await runCli(["--dry-run", "sync"], { cwd: source, homeDir: home, copilot: fake.client, loadMarketplace: async () => catalog, out: () => undefined, err: () => undefined })).toBe(0);
  expect((await readGlobalConfig(home))?.managedPlugins).toEqual([]);
});

test("sync preserves converged plugin ownership when a later skill convergence fails", async () => {
  const home = await tempDir("teamai-skill-failure-home-");
  const source = await tempDir("teamai-skill-failure-source-");
  cleanup.add(home);
  cleanup.add(source);
  const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
  config.role = "api";
  config.managedSkills = ["ios-review"];
  await writeGlobalConfig(config, home);
  const baseCatalog = await loadFakeMarketplace(source);
  const catalog: MarketplaceCatalog = {
    ...baseCatalog,
    skills: [{ name: "ios-review", description: "iOS review", sourceType: "plugin", plugin: "ios", sourcePath: "plugins/ios/skills/ios-review", root: path.join(source, "plugins", "ios", "skills", "ios-review"), owner: "ios", tags: [], standalone: false }],
  };
  const fake = await createFakeCopilot();

  expect(await runCli(["sync"], { cwd: source, homeDir: home, copilot: fake.client, loadMarketplace: async () => catalog, out: () => undefined, err: () => undefined })).toBe(1);
  expect((await readGlobalConfig(home))?.managedPlugins).toEqual([
    "aos@test-teamai",
    "api@test-teamai",
    "common@test-teamai",
    "design@test-teamai",
    "ios@test-teamai",
    "qa@test-teamai",
  ]);
});
