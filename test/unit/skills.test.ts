import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CatalogSkill } from "../../src/copilot/catalog.js";
import { convergeManagedSkills, effectiveEnabledPluginSpecs, personalSkillPath } from "../../src/copilot/skills.js";
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
    const first = await convergeManagedSkills({ marketplace: { name: "test", source: "test" }, managedSkills: ["release-helper", "api-review"], managedSkillPaths: {} }, skills, new Set(["api@test"]), home);
    expect(first.changes).toEqual([{ type: "create", name: "release-helper" }]);
    expect(first.available).toEqual(["api-review"]);
    expect(await readFile(path.join(personalSkillPath(home, "release-helper"), "resources", "note.txt"), "utf8")).toBe("bytes\n");
    expect(first.managedSkillPaths).toEqual({ "release-helper": personalSkillPath(home, "release-helper") });

    const current = await convergeManagedSkills({ marketplace: { name: "test", source: "test" }, managedSkills: ["release-helper", "api-review"], managedSkillPaths: first.managedSkillPaths }, skills, new Set(["api@test"]), home, { dryRun: true });
    expect(current.changes).toEqual([]);
    expect(current.available).toEqual(["api-review"]);

    const removed = await convergeManagedSkills({ marketplace: { name: "test", source: "test" }, managedSkills: [], managedSkillPaths: first.managedSkillPaths }, skills, new Set(), home);
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
    ], new Set(), home)).rejects.toThrow("not managed");
  });

  test("uses project settings as effective plugin enablement", () => {
    expect(effectiveEnabledPluginSpecs([{ name: "api", marketplace: "test", enabled: false }], { enabledPlugins: { "qa@test": true } })).toEqual(new Set(["qa@test"]));
  });
});
