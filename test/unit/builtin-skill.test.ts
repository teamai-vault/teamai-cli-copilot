import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  builtInTeamAiSkillOwnershipPath,
  builtInTeamAiSkillSource,
  builtInTeamAiSkillTarget,
  convergeBuiltInTeamAiSkill,
  inspectBuiltInTeamAiSkill,
} from "../../src/copilot/builtin-skill.js";
import { tempDir } from "../helpers/test-utils.js";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map((root) => rm(root, { recursive: true, force: true })));
  cleanup.clear();
});

describe("built-in Team AI Skill", () => {
  test("installs the bundled Skill, records ownership, and is idempotent", async () => {
    const home = await tempDir("teamai-builtin-skill-home-");
    cleanup.add(home);

    const first = await convergeBuiltInTeamAiSkill(home);
    expect(first.change).toBe("create");
    expect(first.state.status).toBe("current");

    const target = builtInTeamAiSkillTarget(home);
    expect(await readFile(path.join(target, "SKILL.md"))).toEqual(
      await readFile(path.join(builtInTeamAiSkillSource(), "SKILL.md")),
    );
    const ownership = JSON.parse(await readFile(builtInTeamAiSkillOwnershipPath(home), "utf8")) as {
      managedBy: string;
      skill: string;
      version: string;
      target: string;
    };
    const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    expect(ownership).toMatchObject({ managedBy: "teamai-cli", skill: "teamai", version: packageJson.version, target });

    const before = (await stat(path.join(target, "SKILL.md"))).mtimeMs;
    const second = await convergeBuiltInTeamAiSkill(home);
    const after = (await stat(path.join(target, "SKILL.md"))).mtimeMs;
    expect(second.change).toBeUndefined();
    expect(second.state.status).toBe("current");
    expect(after).toBe(before);
  });

  test("repairs owned stale content", async () => {
    const home = await tempDir("teamai-builtin-skill-update-home-");
    cleanup.add(home);
    await convergeBuiltInTeamAiSkill(home);

    const skillFile = path.join(builtInTeamAiSkillTarget(home), "SKILL.md");
    await writeFile(skillFile, "modified\n", "utf8");
    expect((await inspectBuiltInTeamAiSkill(home)).status).toBe("stale");

    const result = await convergeBuiltInTeamAiSkill(home);
    expect(result.change).toBe("update");
    expect(result.state.status).toBe("current");
    expect(await readFile(skillFile)).toEqual(await readFile(path.join(builtInTeamAiSkillSource(), "SKILL.md")));
  });

  test("refuses an existing unowned target", async () => {
    const home = await tempDir("teamai-builtin-skill-collision-home-");
    cleanup.add(home);
    const target = builtInTeamAiSkillTarget(home);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "user owned\n", "utf8");

    expect((await inspectBuiltInTeamAiSkill(home)).status).toBe("collision");
    await expect(convergeBuiltInTeamAiSkill(home)).rejects.toThrow("collision");
    expect(await readFile(path.join(target, "SKILL.md"), "utf8")).toBe("user owned\n");
  });

  test("dry-run previews creation without writing target or ownership", async () => {
    const home = await tempDir("teamai-builtin-skill-dry-home-");
    cleanup.add(home);

    const result = await convergeBuiltInTeamAiSkill(home, { dryRun: true });
    expect(result.change).toBe("create");
    await expect(stat(builtInTeamAiSkillTarget(home))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(builtInTeamAiSkillOwnershipPath(home))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("bundled Skill is self-contained and does not point at Marketplace internals", async () => {
    const source = builtInTeamAiSkillSource();
    const contents = [
      await readFile(path.join(source, "SKILL.md"), "utf8"),
      await readFile(path.join(source, "references", "commands.md"), "utf8"),
    ].join("\n");
    expect(contents).not.toContain("teamai-marketplace");
    expect(contents).not.toContain("manifest/projects.yaml");
    expect(contents).not.toContain("skills.yaml");
    expect(contents).toContain("**Physical Project** - the current Git repository/workspace.");
    expect(contents).toContain("Initialize Team AI for the user -> `teamai init` (user scope only)");
    expect(contents).not.toContain("â");
  });
});
