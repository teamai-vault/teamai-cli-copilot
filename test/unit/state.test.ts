import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { inspectProjectPartitions } from "../../src/project/state.js";
import { tempDir } from "../helpers/test-utils.js";

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
});
