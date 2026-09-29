import { describe, expect, test } from "vitest";
import { computeResourceSnapshot, resourceSourceHash, type ResourceRecordInput } from "../../src/resources/snapshot.js";

describe("resource snapshots", () => {
  test("are deterministic, sort records, and leave input facts untouched", () => {
    const resource = (name: string): ResourceRecordInput => ({
      kind: "plugin",
      name,
      scope: "user",
      pluginSpec: `${name}@marketplace`,
      source: { sourceHash: resourceSourceHash("marketplace"), relativePath: `plugins/${name}/plugin.json`, revision: "abc" },
      selected: true,
      owned: true,
      delivery: "present",
      configuredActive: name === "common",
    });
    const inputResources = [resource("role"), resource("common")];
    const input = { cliVersion: "0.3.0", scope: "user" as const, resources: inputResources };

    const first = computeResourceSnapshot(input);
    const second = computeResourceSnapshot(input);

    expect(first).toEqual(second);
    expect(first.resources.map((item) => item.name)).toEqual(["common", "role"]);
    expect(input.resources).toEqual(inputResources);
    expect(first.diagnostics).toEqual([{
      code: "RUNTIME_NOT_OBSERVED",
      severity: "info",
      message: "Runtime loading was not inspected.",
    }]);
  });

  test("reports an unowned override without suggesting sync", () => {
    const snapshot = computeResourceSnapshot({
      cliVersion: "0.3.0",
      scope: "user",
      resources: [{
        kind: "plugin",
        name: "common@marketplace",
        scope: "user",
        pluginSpec: "common@marketplace",
        source: { sourceHash: resourceSourceHash("marketplace"), relativePath: "plugins/common/plugin.json" },
        selected: true,
        owned: false,
        delivery: "present",
        configuredActive: false,
        reasons: ["USER_OVERRIDE"],
      }],
    });

    expect(snapshot.diagnostics).toContainEqual(expect.objectContaining({ code: "USER_OVERRIDE", severity: "warning" }));
    expect(JSON.stringify(snapshot.diagnostics)).not.toContain("sync");
  });
});
