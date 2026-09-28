import { chmod, link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  applyUserInstructionChanges,
  checkUserInstructionState,
  convergeMarketplaceUserInstructions,
  discoverMarketplaceUserInstructions,
  planUserInstructionChanges,
  userInstructionTargetRoot,
} from "../../src/copilot/user-instructions.js";
import { createDirectoryLink, isPermissionError, tempDir } from "../helpers/test-utils.js";

describe("Marketplace-managed user instructions", () => {
  test("discovers nested instruction files in deterministic order and ignores other files", async () => {
    const marketplace = await tempDir("teamai-instructions-source-");
    await mkdir(path.join(marketplace, "instructions", "git"), { recursive: true });
    await writeFile(path.join(marketplace, "instructions", "README.md"), "ignore\n", "utf8");
    await writeFile(path.join(marketplace, "instructions", "git", "pull.instructions.md"), "pull\r\n", "utf8");
    await writeFile(path.join(marketplace, "instructions", "global.instructions.md"), Buffer.from([0x67, 0x6c, 0x6f, 0x62, 0x61, 0x6c, 0x00]));

    const instructions = await discoverMarketplaceUserInstructions(marketplace);

    expect(instructions.map((item) => item.relativePath)).toEqual([
      "git/pull.instructions.md",
      "global.instructions.md",
    ]);
    expect(instructions[0].content).toEqual(Buffer.from("pull\r\n"));
    expect(instructions[1].content).toEqual(Buffer.from([0x67, 0x6c, 0x6f, 0x62, 0x61, 0x6c, 0x00]));
  });

  test("treats a missing source directory as an empty desired state", async () => {
    const marketplace = await tempDir("teamai-instructions-missing-source-");

    await expect(discoverMarketplaceUserInstructions(marketplace)).resolves.toEqual([]);
  });

  test("does not follow source symlinks", async ({ skip }) => {
    const marketplace = await tempDir("teamai-instructions-link-source-");
    const external = await tempDir("teamai-instructions-link-external-");
    await mkdir(path.join(marketplace, "instructions"), { recursive: true });
    await writeFile(path.join(external, "outside.instructions.md"), "outside\n", "utf8");
    try {
      await createDirectoryLink(external, path.join(marketplace, "instructions", "external"));
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }

    await expect(discoverMarketplaceUserInstructions(marketplace)).resolves.toEqual([]);
  });

  test("ignores hard-linked source instructions", async ({ skip }) => {
    const marketplace = await tempDir("teamai-instructions-hard-source-");
    const external = await tempDir("teamai-instructions-hard-external-");
    const sourceRoot = path.join(marketplace, "instructions");
    const externalFile = path.join(external, "outside.instructions.md");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(externalFile, "outside\n", "utf8");
    try {
      await link(externalFile, path.join(sourceRoot, "outside.instructions.md"));
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }

    await expect(discoverMarketplaceUserInstructions(marketplace)).resolves.toEqual([]);
  });

  test("rejects an existing non-directory source root", async () => {
    const marketplace = await tempDir("teamai-instructions-file-source-");
    await writeFile(path.join(marketplace, "instructions"), "not a directory\n", "utf8");

    await expect(discoverMarketplaceUserInstructions(marketplace)).rejects.toThrow(/unsafe/i);
  });

  test("rejects a link-like source root", async ({ skip }) => {
    const marketplace = await tempDir("teamai-instructions-link-root-");
    const external = await tempDir("teamai-instructions-link-root-external-");
    const sourceRoot = path.join(marketplace, "instructions");
    await writeFile(path.join(external, "outside.instructions.md"), "outside\n", "utf8");
    try {
      await createDirectoryLink(external, sourceRoot);
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }

    await expect(discoverMarketplaceUserInstructions(marketplace)).rejects.toThrow(/unsafe/i);
  });

  test("plans and applies byte-preserving create, update, and remove changes", async () => {
    const marketplace = await tempDir("teamai-instructions-plan-");
    const home = await tempDir("teamai-instructions-home-");
    const sourceDir = path.join(marketplace, "instructions");
    const targetRoot = userInstructionTargetRoot(home);
    await mkdir(path.join(sourceDir, "git"), { recursive: true });
    await writeFile(path.join(sourceDir, "git", "commit.instructions.md"), Buffer.from([0x63, 0x72, 0x6c, 0x66, 0x0d, 0x0a]));
    await writeFile(path.join(sourceDir, "global.instructions.md"), "new\n", "utf8");
    await mkdir(path.join(targetRoot, "old"), { recursive: true });
    await writeFile(path.join(targetRoot, "old", "gone.instructions.md"), "remove me\n", "utf8");
    await writeFile(path.join(targetRoot, "global.instructions.md"), "old\n", "utf8");
    await writeFile(path.join(targetRoot, "personal.txt"), "leave me\n", "utf8");

    const desired = await discoverMarketplaceUserInstructions(marketplace);
    const plan = await planUserInstructionChanges(desired, targetRoot);

    expect(plan.changes).toEqual([
      { type: "create", relativePath: "git/commit.instructions.md" },
      { type: "update", relativePath: "global.instructions.md" },
      { type: "remove", relativePath: "old/gone.instructions.md" },
    ]);

    await applyUserInstructionChanges(plan);

    expect(await readFile(path.join(targetRoot, "git", "commit.instructions.md"))).toEqual(Buffer.from([0x63, 0x72, 0x6c, 0x66, 0x0d, 0x0a]));
    expect(await readFile(path.join(targetRoot, "global.instructions.md"), "utf8")).toBe("new\n");
    await expect(readFile(path.join(targetRoot, "old", "gone.instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(targetRoot, "personal.txt"), "utf8")).toBe("leave me\n");
  });

  test("dry-run plans changes without writing", async () => {
    const marketplace = await tempDir("teamai-instructions-dry-source-");
    const home = await tempDir("teamai-instructions-dry-home-");
    await mkdir(path.join(marketplace, "instructions"), { recursive: true });
    await writeFile(path.join(marketplace, "instructions", "global.instructions.md"), "secret body\n", "utf8");

    const plan = await planUserInstructionChanges(
      await discoverMarketplaceUserInstructions(marketplace),
      userInstructionTargetRoot(home),
    );
    await applyUserInstructionChanges(plan, { dryRun: true });

    await expect(readFile(path.join(userInstructionTargetRoot(home), "global.instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unsafe relative destinations", async () => {
    const home = await tempDir("teamai-instructions-unsafe-home-");

    await expect(planUserInstructionChanges([{
      relativePath: "../outside.instructions.md",
      content: Buffer.from("unsafe"),
    }], userInstructionTargetRoot(home))).rejects.toThrow(/unsafe/i);
  });

  test("rejects a link in the managed target tree", async ({ skip }) => {
    const home = await tempDir("teamai-instructions-link-target-home-");
    const external = await tempDir("teamai-instructions-link-target-external-");
    const targetRoot = userInstructionTargetRoot(home);
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(external, "outside.instructions.md"), "outside\n", "utf8");
    try {
      await createDirectoryLink(external, path.join(targetRoot, "external"));
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }

    await expect(planUserInstructionChanges([], targetRoot)).rejects.toThrow(/unsafe/i);
  });

  test("rejects hard-linked managed target instructions without modifying the external file", async ({ skip }) => {
    const home = await tempDir("teamai-instructions-hard-target-home-");
    const external = await tempDir("teamai-instructions-hard-target-external-");
    const targetRoot = userInstructionTargetRoot(home);
    const externalFile = path.join(external, "outside.instructions.md");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(externalFile, "outside\n", "utf8");
    try {
      await link(externalFile, path.join(targetRoot, "outside.instructions.md"));
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }

    await expect(planUserInstructionChanges([], targetRoot)).rejects.toThrow(/unsafe/i);
    expect(await readFile(externalFile, "utf8")).toBe("outside\n");
  });

  test("rejects link-like target ancestors without writing outside the managed root", async ({ skip }) => {
    const home = await tempDir("teamai-instructions-link-ancestor-home-");
    const external = await tempDir("teamai-instructions-link-ancestor-external-");
    const marketplace = await tempDir("teamai-instructions-link-ancestor-marketplace-");
    const sourceRoot = path.join(marketplace, "instructions");
    const externalCopilot = path.join(external, ".copilot");
    await mkdir(sourceRoot, { recursive: true });
    await writeFile(path.join(sourceRoot, "global.instructions.md"), "managed\n", "utf8");
    await mkdir(externalCopilot, { recursive: true });
    const externalTarget = path.join(externalCopilot, "instructions", "teamai", "global.instructions.md");
    await mkdir(path.dirname(externalTarget), { recursive: true });
    await writeFile(externalTarget, "external\n", "utf8");
    try {
      await createDirectoryLink(externalCopilot, path.join(home, ".copilot"));
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }

    await expect(convergeMarketplaceUserInstructions(marketplace, home)).rejects.toThrow(/unsafe/i);
    expect(await readFile(externalTarget, "utf8")).toBe("external\n");
  });

  test("reports an unwritable planned destination when its existing parent is not a directory", async () => {
    const home = await tempDir("teamai-instructions-unwritable-parent-home-");
    const targetRoot = userInstructionTargetRoot(home);
    const blockedParent = path.join(targetRoot, "blocked");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(blockedParent, "not a directory\n", "utf8");

    const state = await checkUserInstructionState([{
      relativePath: "blocked/new.instructions.md",
      content: Buffer.from("new\n"),
    }], targetRoot);

    expect(state.changes).toEqual([{ type: "create", relativePath: "blocked/new.instructions.md" }]);
    expect(state.targetWritable).toBe(false);
    expect(await readFile(blockedParent, "utf8")).toBe("not a directory\n");
  });

  test.skipIf(process.platform === "win32")("reports an unwritable existing parent without writing", async () => {
    const home = await tempDir("teamai-instructions-unwritable-parent-permissions-home-");
    const targetRoot = userInstructionTargetRoot(home);
    const targetPath = path.join(targetRoot, "global.instructions.md");
    await mkdir(targetRoot, { recursive: true });
    await writeFile(targetPath, "old\n", "utf8");
    await chmod(targetRoot, 0o555);
    try {
      const state = await checkUserInstructionState([{
        relativePath: "global.instructions.md",
        content: Buffer.from("new\n"),
      }], targetRoot);

      expect(state.changes).toEqual([{ type: "update", relativePath: "global.instructions.md" }]);
      expect(state.targetWritable).toBe(false);
      expect(await readFile(targetPath, "utf8")).toBe("old\n");
    } finally {
      await chmod(targetRoot, 0o755);
    }
  });

  test("uses platform-safe target paths for POSIX-style homes", () => {
    const expected = process.platform === "win32"
      ? "\\Users\\example\\.copilot\\instructions\\teamai"
      : "/Users/example/.copilot/instructions/teamai";
    expect(userInstructionTargetRoot("/Users/example")).toBe(expected);
  });

  test("normalizes Windows-style relative paths before planning", async () => {
    const home = await tempDir("teamai-instructions-windows-path-home-");
    const plan = await planUserInstructionChanges([{
      relativePath: "git\\commit.instructions.md",
      content: Buffer.from("commit\n"),
    }], userInstructionTargetRoot(home));

    expect(plan.changes).toEqual([{ type: "create", relativePath: "git/commit.instructions.md" }]);
  });
});
