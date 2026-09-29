import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { mergeManagedProjectPlugins, readProjectSettings } from "../../src/copilot/project-settings.js";
import { tempDir, TEST_MARKETPLACE_NAME, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

describe("repository Copilot settings", () => {
  test("preserves unknown fields and unrelated plugins", async () => {
    const root = await tempDir("teamai-settings-");
    const settingsPath = path.join(root, ".github", "copilot", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify({
      customFutureField: { keep: true },
      enabledPlugins: { "user-plugin@other": true },
      extraKnownMarketplaces: { other: { source: { source: "github", repo: "other/repo" } } },
    }), "utf8");

    const current = await readProjectSettings(root);
    const merged = mergeManagedProjectPlugins(current, { name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }, ["payments"], []);

    expect(merged.customFutureField).toEqual({ keep: true });
    expect(merged.enabledPlugins?.["user-plugin@other"]).toBe(true);
    expect(merged.enabledPlugins?.[`payments@${TEST_MARKETPLACE_NAME}`]).toBe(true);
    expect(merged.extraKnownMarketplaces?.other).toBeDefined();
    expect(merged.extraKnownMarketplaces?.[TEST_MARKETPLACE_NAME]).toEqual({
      source: { source: "git", url: TEST_MARKETPLACE_SOURCE },
    });
  });

  test("reports invalid JSON clearly", async () => {
    const root = await tempDir("teamai-settings-bad-");
    const settingsPath = path.join(root, ".github", "copilot", "settings.json");
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, "{", "utf8");
    await expect(readProjectSettings(root)).rejects.toThrow("contains invalid JSON");
  });
});
