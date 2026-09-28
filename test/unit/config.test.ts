import { describe, expect, test } from "vitest";
import { readGlobalConfig, writeGlobalConfig } from "../../src/config/global.js";
import { createConfig, validateConfig } from "../../src/config/schema.js";
import { tempDir, TEST_MARKETPLACE_NAME, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

describe("global config", () => {
  test("reads and writes config.yaml", async () => {
    const home = await tempDir("teamai-home-");
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.marketplaceRevision = "0123456789abcdef";
    config.role = "api";
    config.managedPlugins = [`common@${TEST_MARKETPLACE_NAME}`, `api@${TEST_MARKETPLACE_NAME}`];
    await writeGlobalConfig(config, home);
    await expect(readGlobalConfig(home)).resolves.toEqual(config);
  });

  test("rejects unsupported schemas and the removed repository field", () => {
    expect(() => validateConfig({ version: 2 })).toThrow("Unsupported Team AI config version: 2");
    expect(() => validateConfig({
      version: 1,
      marketplace: { name: TEST_MARKETPLACE_NAME, repository: TEST_MARKETPLACE_SOURCE },
    })).toThrow("Team AI config requires marketplace.source");
  });
});
