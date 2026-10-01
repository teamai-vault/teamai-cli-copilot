import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { readProjectSettings } from "../../src/copilot/project-settings.js";
import { tempDir } from "../helpers/test-utils.js";

describe("repository Copilot settings", () => {
  test("reads JSONC comments and preserves unknown fields and plugin state", async () => {
    const root = await tempDir("teamai-settings-");
    const settingsPath = path.join(root, ".github", "copilot", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, '{\n  // This user state must be read without taking ownership.\n  "customFutureField": { "keep": true },\n  "enabledPlugins": { "user-plugin@other": true },\n  "extraKnownMarketplaces": { "other": { "source": { "source": "github", "repo": "other/repo" } } }\n}\n', "utf8");

    const current = await readProjectSettings(root);

    expect(current.customFutureField).toEqual({ keep: true });
    expect(current.enabledPlugins?.["user-plugin@other"]).toBe(true);
    expect(current.extraKnownMarketplaces?.other).toBeDefined();
  });

  test("reports invalid JSON clearly", async () => {
    const root = await tempDir("teamai-settings-bad-");
    const settingsPath = path.join(root, ".github", "copilot", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, "{", "utf8");
    await expect(readProjectSettings(root)).rejects.toThrow("contains invalid JSON");
  });
});
