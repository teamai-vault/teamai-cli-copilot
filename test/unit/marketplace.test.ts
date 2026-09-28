import path from "node:path";
import { describe, expect, test } from "vitest";
import { marketplaceRowMatchesSource, normalizeMarketplaceSource, resolveMarketplaceConfig } from "../../src/copilot/marketplace.js";
import { createFakeCopilot, tempDir, TEST_MARKETPLACE_NAME, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

describe("marketplace source handling", () => {
  test("passes remote Git URLs through unchanged and resolves local relative paths", async () => {
    const cwd = await tempDir("teamai-marketplace-cwd-");
    expect(normalizeMarketplaceSource(TEST_MARKETPLACE_SOURCE, cwd)).toBe(TEST_MARKETPLACE_SOURCE);
    expect(normalizeMarketplaceSource("../department-marketplace", cwd)).toBe(path.resolve(cwd, "../department-marketplace"));
  });

  test("matches Copilot source labels and reuses an existing registration", async () => {
    expect(marketplaceRowMatchesSource({
      name: TEST_MARKETPLACE_NAME,
      source: `URL: ${TEST_MARKETPLACE_SOURCE}`,
    }, TEST_MARKETPLACE_SOURCE)).toBe(true);

    const fake = await createFakeCopilot({
      marketplaces: [{ name: TEST_MARKETPLACE_NAME, source: `URL: ${TEST_MARKETPLACE_SOURCE}` }],
    });
    await expect(resolveMarketplaceConfig(fake.client, TEST_MARKETPLACE_SOURCE, TEST_MARKETPLACE_NAME, {
      cwd: process.cwd(),
    })).resolves.toEqual({
      config: {
        name: TEST_MARKETPLACE_NAME,
        source: TEST_MARKETPLACE_SOURCE,
      },
      added: false,
    });
  });
});
