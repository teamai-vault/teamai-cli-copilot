import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CatalogSkill } from "../../src/copilot/catalog.js";
import { convergeManagedSkills, effectiveEnabledPluginSpecs, materializedEnabledPluginSpecs, personalSkillPath } from "../../src/copilot/skills.js";
import { tempDir } from "../helpers/test-utils.js";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map((root) => rm(root, { recursive: true, force: true })));
  cleanup.clear();
});

async function source(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(path.join(directory, "resources"), { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name}\n---\n`, "utf8");
  await writeFile(path.join(directory, "resources", "note.txt"), "bytes\n", "utf8");
  return directory;
}

describe("managed personal skills", () => {
  test("copies complete standalone resources and removes only recorded ownership", async () => {
    const root = await tempDir("teamai-skills-");
    const home = await tempDir("teamai-skills-home-");
    cleanup.add(root);
    cleanup.add(home);
    const releaseRoot = await source(root, "release-helper");
    const reviewRoot = await source(root, "api-review");
    const skills: CatalogSkill[] = [
      { name: "release-helper", description: "release", sourceType: "standalone", sourcePath: "skills/release-helper", root: releaseRoot, owner: "release", tags: [], standalone: true },
      { name: "api-review", description: "review", sourceType: "plugin", plugin: "api", sourcePath: "plugins/api/skills/api-review", root: reviewRoot, owner: "api", tags: [], standalone: true },
    ];
    const first = await convergeManagedSkills({ marketplace: { name: "test", source: "test" }, managedSkills: ["release-helper", "api-review"], managedSkillPaths: {} }, skills, new Set(["api@test"]), home, { materializedPluginSkills: new Set(["api-review"]) });
    expect(first.changes).toEqual([{ type: "create", name: "release-helper" }]);
    expect(first.available).toEqual(["api-review"]);
    expect(await readFile(path.join(personalSkillPath(home, "release-helper"), "resources", "note.txt"), "utf8")).toBe("bytes\n");
    expect(first.managedSkillPaths).toEqual({ "release-helper": personalSkillPath(home, "release-helper") });

    const current = await convergeManagedSkills({ marketplace: { name: "test", source: "test" }, managedSkills: ["release-helper", "api-review"], managedSkillPaths: first.managedSkillPaths }, skills, new Set(["api@test"]), home, { dryRun: true, materializedPluginSkills: new Set(["api-review"]) });
    expect(current.changes).toEqual([]);
    expect(current.available).toEqual(["api-review"]);

    const removed = await convergeManagedSkills({ marketplace: { name: "test", source: "test" }, managedSkills: [], managedSkillPaths: first.managedSkillPaths }, skills, new Set(), home, { materializedPluginSkills: new Set() });
    expect(removed.changes).toEqual([{ type: "remove", name: "release-helper" }]);
    await expect(readFile(path.join(personalSkillPath(home, "release-helper"), "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses an existing unowned personal skill", async () => {
    const root = await tempDir("teamai-skills-");
    const home = await tempDir("teamai-skills-home-");
    cleanup.add(root);
    cleanup.add(home);
    const releaseRoot = await source(root, "release-helper");
    await source(path.join(home, ".copilot", "skills"), "release-helper");
    await expect(convergeManagedSkills({ marketplace: { name: "test", source: "test" }, managedSkills: ["release-helper"], managedSkillPaths: {} }, [
      { name: "release-helper", description: "release", sourceType: "standalone", sourcePath: "skills/release-helper", root: releaseRoot, owner: "release", tags: [], standalone: true },
    ], new Set(), home, { materializedPluginSkills: new Set() })).rejects.toThrow("not managed");
  });

  test("uses project settings as effective plugin enablement", () => {
    expect(effectiveEnabledPluginSpecs([{ name: "api", marketplace: "test", enabled: false }], { enabledPlugins: { "qa@test": true } })).toEqual(new Set(["qa@test"]));
  });

  test("keeps an owned personal Skill when its enabled Plugin package is not materialized", async () => {
    const root = await tempDir("teamai-skill-package-missing-");
    const home = await tempDir("teamai-skill-package-missing-home-");
    cleanup.add(root);
    cleanup.add(home);
    const skillRoot = await source(root, "api-review");
    const target = await source(path.join(home, ".copilot", "skills"), "api-review");
    const skills: CatalogSkill[] = [
      { name: "api-review", description: "review", sourceType: "plugin", plugin: "api", sourcePath: "plugins/api/skills/api-review", root: skillRoot, owner: "api", tags: [], standalone: true },
    ];
    const installed = [{ name: "api", marketplace: "test", version: "1.0.0", enabled: true }];
    const materialized = await materializedEnabledPluginSpecs(installed);
    const enabled = effectiveEnabledPluginSpecs(installed);
    const result = await convergeManagedSkills({
      marketplace: { name: "test", source: "test" },
      managedSkills: ["api-review"],
      managedSkillPaths: { "api-review": target },
    }, skills, enabled, home, { materializedPluginSkills: new Set() });

    expect(materialized).toEqual(new Set());
    expect(result.changes).toEqual([]);
    expect(result.managedSkillPaths["api-review"]).toBe(target);
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toContain("name: api-review");
  });
});
