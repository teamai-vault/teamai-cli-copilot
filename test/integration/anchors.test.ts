import { mkdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { detectProjectIdentity } from "../../src/project/anchors.js";
import { runProcess } from "../../src/utils/process.js";
import { createGitRepo, tempDir } from "../helpers/test-utils.js";

describe("Git project identity", () => {
  test("normal repository and nested cwd share workspace root and anchor", async () => {
    const root = await createGitRepo();
    const nested = path.join(root, "src", "nested");
    await mkdir(nested, { recursive: true });
    const identity = await detectProjectIdentity(nested);
    expect(identity?.workspaceRoot.toLowerCase()).toBe(root.toLowerCase());
    expect(identity?.projectAnchor.toLowerCase()).toBe(root.toLowerCase());
  }, 15_000);

  test("Git worktree has a distinct workspaceRoot and stable main anchor", async () => {
    const root = await createGitRepo();
    const parent = await tempDir("teamai-worktree-parent-");
    const worktree = path.join(parent, "feature-worktree");
    const result = await runProcess("git", ["worktree", "add", "-b", "feature-test", worktree], { cwd: root });
    expect(result.exitCode).toBe(0);
    const identity = await detectProjectIdentity(worktree);
    expect(identity?.workspaceRoot.toLowerCase()).toBe(worktree.toLowerCase());
    expect(identity?.projectAnchor.toLowerCase()).toBe(root.toLowerCase());
  }, 15_000);
});
