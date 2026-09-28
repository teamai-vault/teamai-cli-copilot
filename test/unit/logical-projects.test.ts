import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { detectProjectIdentity } from "../../src/project/anchors.js";
import { convergeLogicalProjectContext } from "../../src/project/context.js";
import { loadLogicalProjects } from "../../src/project/manifest.js";
import { createGitRepo, tempDir, TEST_MARKETPLACE_NAME, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

async function marketplace(): Promise<string> {
  const root = await tempDir("teamai-logical-project-unit-");
  await mkdir(path.join(root, "manifest"), { recursive: true });
  await mkdir(path.join(root, "contexts", "payments", "instructions"), { recursive: true });
  await mkdir(path.join(root, "learnings", "shared"), { recursive: true });
  await writeFile(path.join(root, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payment domain\n    owners: [payments]\n", "utf8");
  await writeFile(path.join(root, "contexts", "payments", "instructions", "payments.instructions.md"), "---\napplyTo: \"**\"\n---\n\npayments\n", "utf8");
  await writeFile(path.join(root, "learnings", "shared", "shared.md"), "shared\n", "utf8");
  return root;
}

describe("Logical Project projection", () => {
  test.each(["id: 7", "null"]) ("rejects invalid manifest entry %s", async (entry) => {
    const source = await marketplace();
    await writeFile(path.join(source, "manifest", "projects.yaml"), `version: 1\nprojects:\n  - ${entry}\n`, "utf8");
    await expect(loadLogicalProjects(source, [])).rejects.toThrow("Logical Project entry 1");
  });

  test("refuses an unowned reserved path", async () => {
    const repo = await createGitRepo();
    const source = await marketplace();
    await mkdir(path.join(repo, ".github", "instructions", "teamai"), { recursive: true });
    await writeFile(path.join(repo, ".github", "instructions", "teamai", "user.instructions.md"), "user\n", "utf8");
    const identity = await detectProjectIdentity(repo);
    await expect(convergeLogicalProjectContext({ marketplaceRoot: source, plugins: [], marketplace: { name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }, identity: identity!, logicalProjects: ["payments"] }))
      .rejects.toThrow("Reserved Team AI projection path is already occupied");
  }, 15_000);

  test("dry run reports projections without writing bytes", async () => {
    const repo = await createGitRepo();
    const source = await marketplace();
    const identity = await detectProjectIdentity(repo);
    const result = await convergeLogicalProjectContext({ marketplaceRoot: source, plugins: [], marketplace: { name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }, identity: identity!, logicalProjects: ["payments"], dryRun: true });
    expect(result.changes.some((change) => change.endsWith("payments.instructions.md"))).toBe(true);
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "payments", "payments.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 15_000);
});
