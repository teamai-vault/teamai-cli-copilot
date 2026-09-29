import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { inspectProjectPartitions, readProjectState, withProjectStateLock, writeProjectState } from "../../src/project/state.js";
import { partitionPath } from "../../src/project/partition.js";
import { createDirectoryLink, isPermissionError, tempDir } from "../helpers/test-utils.js";

describe("project partition diagnostics", () => {
  test("reports orphan and stale partitions without mutating them", async () => {
    const home = await tempDir("teamai-partitions-");
    const projects = path.join(home, ".teamai", "projects");
    const orphan = path.join(projects, "orphan-partition");
    const stale = path.join(projects, "stale-partition");
    await mkdir(orphan, { recursive: true });
    await mkdir(stale, { recursive: true });
    await writeFile(path.join(stale, "anchor"), `${path.join(home, "missing-repo")}\n`, "utf8");

    const diagnostics = await inspectProjectPartitions(home);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics).toEqual(expect.arrayContaining([
      { partition: orphan, kind: "orphan" },
      { partition: stale, kind: "stale", anchor: path.join(home, "missing-repo") },
    ]));
  });

  test("rejects linked partition paths and hard-linked receipts for reads and writes", async ({ skip }) => {
    const home = await tempDir("teamai-linked-project-home-");
    const external = await tempDir("teamai-linked-project-external-");
    const projectAnchor = path.join(home, "repo");
    const projectsRoot = path.join(home, ".teamai", "projects");
    const outside = path.join(external, "keep.txt");
    await mkdir(path.dirname(projectsRoot), { recursive: true });
    await writeFile(outside, "outside state\n", "utf8");
    try {
      await createDirectoryLink(external, projectsRoot);
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }

    await expect(readProjectState(projectAnchor, home)).rejects.toThrow("Unsafe Team AI project state path");
    await expect(withProjectStateLock(projectAnchor, home, async () => ({ result: "unexpected" }))).rejects.toThrow("Unsafe Team AI project state path");
    await expect(writeProjectState(projectAnchor, {
      schemaVersion: 1,
      workspaceRoot: projectAnchor,
      lastSync: "now",
      managedPlugins: [],
    }, home)).rejects.toThrow("Unsafe Team AI project state path");
    await expect(readFile(outside, "utf8")).resolves.toBe("outside state\n");
    await expect(readFile(path.join(external, "anchor"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const linkedHome = await tempDir("teamai-linked-receipt-home-");
    const linkedExternal = await tempDir("teamai-linked-receipt-external-");
    const linkedAnchor = path.join(linkedHome, "repo");
    const partition = partitionPath(linkedAnchor, linkedHome);
    const anchorFile = path.join(partition, "anchor");
    const stateFile = path.join(partition, "state.json");
    const externalReceipt = path.join(linkedExternal, "receipt.json");
    await mkdir(partition, { recursive: true });
    await writeFile(path.join(linkedExternal, "anchor.txt"), `${linkedAnchor}\n`, "utf8");
    await writeFile(externalReceipt, "{\"outside\":true}\n", "utf8");
    try {
      await link(path.join(linkedExternal, "anchor.txt"), anchorFile);
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }
    await expect(readProjectState(linkedAnchor, linkedHome)).rejects.toThrow("Unsafe Team AI project state file");
    await expect(withProjectStateLock(linkedAnchor, linkedHome, async () => ({ result: "unexpected" }))).rejects.toThrow("Unsafe Team AI project state file");
    await expect(readFile(path.join(linkedExternal, "anchor.txt"), "utf8")).resolves.toBe(`${linkedAnchor}\n`);

    await unlink(anchorFile);
    await writeFile(anchorFile, `${linkedAnchor}\n`, "utf8");
    try {
      await link(externalReceipt, stateFile);
    } catch (error) {
      if (isPermissionError(error)) return skip();
      throw error;
    }
    await expect(readProjectState(linkedAnchor, linkedHome)).rejects.toThrow("Unsafe Team AI project state file");
    await expect(writeProjectState(linkedAnchor, {
      schemaVersion: 1,
      workspaceRoot: linkedAnchor,
      lastSync: "now",
      managedPlugins: [],
    }, linkedHome)).rejects.toThrow("Unsafe Team AI project state file");
    await expect(readFile(externalReceipt, "utf8")).resolves.toBe("{\"outside\":true}\n");
  });
});
