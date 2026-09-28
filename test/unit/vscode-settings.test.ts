import { describe, expect, test } from "vitest";
import { parse } from "jsonc-parser";
import { mergeVsCodeMarketplace } from "../../src/copilot/vscode-settings.js";

describe("VS Code User Settings merge", () => {
  test("prepends the Marketplace while preserving comments, unknown fields, and trailing commas", () => {
    const current = `{
  // keep this comment
  "editor.fontSize": 14,
  "chat.plugins.marketplaces": [
    // existing marketplace
    "https://example.com/existing.git",
  ],
}
`;
    const merged = mergeVsCodeMarketplace(current, "https://example.com/teamai.git");
    expect(merged).toContain("// keep this comment");
    expect(merged).toContain("// existing marketplace");
    expect(merged).toContain('"editor.fontSize": 14');
    expect((parse(merged) as Record<string, string[]>)["chat.plugins.marketplaces"]).toEqual([
      "https://example.com/teamai.git",
      "https://example.com/existing.git",
    ]);
  });

  test("moves an existing Marketplace to the front without replacing other values", () => {
    const current = `{
  "chat.plugins.marketplaces": [
    "first",
    // keep second
    "second",
    "teamai",
  ],
}
`;
    const merged = mergeVsCodeMarketplace(current, "teamai");
    expect(merged).toContain("// keep second");
    expect((parse(merged) as Record<string, string[]>)["chat.plugins.marketplaces"]).toEqual(["teamai", "first", "second"]);
  });
});
