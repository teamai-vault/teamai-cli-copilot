import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { runProcess } from "../../src/utils/process.js";
import { tempDir } from "../helpers/test-utils.js";

describe("rename-marketplace development tool", () => {
  test("renames standalone marketplace identity tokens without renaming repository identities", async () => {
    const root = await tempDir("teamai-rename-tool-");
    const cliRepo = path.join(root, "teamai-cli-copilot");
    const marketplaceRepo = path.join(root, "teamai-marketplace");
    await mkdir(path.join(cliRepo, "src"), { recursive: true });
    await mkdir(path.join(marketplaceRepo, ".github", "plugin"), { recursive: true });

    await writeFile(path.join(marketplaceRepo, ".github", "plugin", "marketplace.json"), JSON.stringify({
      name: "test-marketplace-old",
      owner: { name: "Team AI" },
      plugins: [],
    }, null, 2), "utf8");
    await writeFile(path.join(marketplaceRepo, "README.md"), [
      "# Marketplace",
      "common@test-marketplace-old",
      "marketplace:test-marketplace-old",
      "teamai-vault",
      "teamai-marketplace",
      "",
    ].join("\n"), "utf8");
    await writeFile(path.join(cliRepo, "src", "identity.ts"), 'export const untouched = "test-marketplace-old";\n', "utf8");

    const script = fileURLToPath(new URL("../../scripts/rename-marketplace.mjs", import.meta.url));
    const result = await runProcess(process.execPath, [
      script,
      "--from", "test-marketplace-old",
      "--to", "test-marketplace-new",
      "--display-name", "Payments Platform AI",
      "--marketplace-repo", marketplaceRepo,
    ]);

    expect(result.exitCode).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(marketplaceRepo, ".github", "plugin", "marketplace.json"), "utf8"));
    expect(manifest.name).toBe("test-marketplace-new");
    expect(manifest.owner.name).toBe("Payments Platform AI");

    const marketplaceReadme = await readFile(path.join(marketplaceRepo, "README.md"), "utf8");
    expect(marketplaceReadme).toContain("common@test-marketplace-new");
    expect(marketplaceReadme).toContain("marketplace:test-marketplace-new");
    expect(marketplaceReadme).toContain("teamai-vault");
    expect(marketplaceReadme).toContain("teamai-marketplace");

    const cliIdentity = await readFile(path.join(cliRepo, "src", "identity.ts"), "utf8");
    expect(cliIdentity).toContain('untouched = "test-marketplace-old"');
  }, 10_000);
});
