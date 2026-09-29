import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
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

  test("reports partial Workspace changes when an injected later write fails", async () => {
    const repo = await createGitRepo();
    const source = await marketplace();
    const identity = await detectProjectIdentity(repo);
    const excludePath = path.join(repo, ".git", "info", "exclude");
    await writeFile(excludePath, "# user exclude\n", "utf8");
    const fs = await import("../../src/utils/fs.js");
    const write = fs.atomicWriteFile;
    let calls = 0;
    const injected = vi.spyOn(fs, "atomicWriteFile").mockImplementation(async (target, contents) => {
      calls += 1;
      if (calls === 2) throw new Error("injected second write failure");
      return write(target, contents);
    });
    try {
      await expect(convergeLogicalProjectContext({
        marketplaceRoot: source,
        plugins: [],
        marketplace: { name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE },
        identity: identity!,
        logicalProjects: ["payments"],
      })).rejects.toThrow("Partial Workspace context update; completed 1 change(s)");
    } finally {
      injected.mockRestore();
    }

    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "payments", "payments.instructions.md"), "utf8")).resolves.toContain("payments");
    await expect(readFile(path.join(repo, ".teamai", "context", "shared", "learnings", "shared.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(excludePath, "utf8")).resolves.toBe("# user exclude\n");
  }, 15_000);
});
