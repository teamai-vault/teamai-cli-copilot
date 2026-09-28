import { stat } from "node:fs/promises";
import { afterEach, describe, expect, test, vi } from "vitest";
import { tempDir } from "../helpers/test-utils.js";

vi.mock("../../src/utils/fs.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/utils/fs.js")>("../../src/utils/fs.js");
  return {
    ...actual,
    atomicWriteJson: async () => {
      throw new Error("forced ownership write failure");
    },
  };
});

import {
  builtInTeamAiSkillOwnershipPath,
  builtInTeamAiSkillTarget,
  convergeBuiltInTeamAiSkill,
} from "../../src/copilot/builtin-skill.js";

const cleanup: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("built-in Team AI Skill ownership failure", () => {
  test("rolls back a fresh install when ownership persistence fails", async () => {
    const home = await tempDir("teamai-builtin-ownership-failure-home-");
    cleanup.push(home);

    await expect(convergeBuiltInTeamAiSkill(home)).rejects.toThrow("forced ownership write failure");
    await expect(stat(builtInTeamAiSkillTarget(home))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(builtInTeamAiSkillOwnershipPath(home))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
