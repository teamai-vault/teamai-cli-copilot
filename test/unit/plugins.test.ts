import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createConfig } from "../../src/config/schema.js";
import type { CatalogPlugin } from "../../src/copilot/catalog.js";
import type { CopilotClient } from "../../src/copilot/cli.js";
import { convergeUserPlugins, enabledUserPlugins, inspectPluginDelivery, inspectPluginSkillDelivery, inspectUserPluginResources, userPlugins } from "../../src/copilot/plugins.js";
import { tempDir, TEST_MARKETPLACE_NAME, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

const catalog: CatalogPlugin[] = [
  { name: "common", version: "0.1.0", kind: "common", root: "common" },
  { name: "api", version: "0.1.0", kind: "role", root: "api" },
  { name: "qa", version: "0.1.0", kind: "role", root: "qa" },
  { name: "payments", version: "0.1.0", kind: "project", root: "payments" },
];

describe("desired plugin resolution", () => {
  test("installs common and every role but enables only common and the selected role", () => {
    expect(userPlugins(catalog, TEST_MARKETPLACE_NAME)).toEqual([
      `common@${TEST_MARKETPLACE_NAME}`,
      `api@${TEST_MARKETPLACE_NAME}`,
      `qa@${TEST_MARKETPLACE_NAME}`,
    ]);
    expect(enabledUserPlugins("qa", catalog, TEST_MARKETPLACE_NAME)).toEqual([
      `common@${TEST_MARKETPLACE_NAME}`,
      `qa@${TEST_MARKETPLACE_NAME}`,
    ]);
  });

  test("validates roles before mutation", async () => {
    let mutated = false;
    const client = {
      listMarketplaces: async () => [],
      addMarketplace: async () => { mutated = true; },
    } as unknown as CopilotClient;
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";

    expect(() => enabledUserPlugins("payments", catalog, TEST_MARKETPLACE_NAME)).toThrow("Unknown role 'payments'");
    expect(mutated).toBe(false);
  });

  test("preserves an unowned same-name Plugin when its state differs from the selected role", async () => {
    const calls: string[] = [];
    const client = {
      listMarketplaces: async () => [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
      listPlugins: async () => [{
        name: "common",
        marketplace: TEST_MARKETPLACE_NAME,
        version: "0.1.0",
        enabled: false,
        source: `live-marketplace:${TEST_MARKETPLACE_NAME}`,
      }],
      installPlugin: async (spec: string) => { calls.push(`install ${spec}`); },
      enablePlugin: async (spec: string) => { calls.push(`enable ${spec}`); },
      disablePlugin: async (spec: string) => { calls.push(`disable ${spec}`); },
      updatePlugin: async (spec: string) => { calls.push(`update ${spec}`); },
    } as unknown as CopilotClient;
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";

    const result = await convergeUserPlugins(client, config, catalog, { dryRun: true });

    expect(result.actions).not.toContainEqual({ kind: "plugin-enable", target: `common@${TEST_MARKETPLACE_NAME}` });
    expect(result.actions).not.toContainEqual({ kind: "plugin-install", target: `common@${TEST_MARKETPLACE_NAME}` });
    expect(result.managedPlugins).not.toContain(`common@${TEST_MARKETPLACE_NAME}`);
    expect(result.warnings.join("\n")).toContain("user-owned and differs from the selected role");
    expect(result.resources.find((resource) => resource.pluginSpec === `common@${TEST_MARKETPLACE_NAME}`)?.reasons).toContain("USER_OVERRIDE");
    expect(calls).toEqual([]);
  });

  test("classifies Plugin package delivery from its materialized manifest", async () => {
    const root = await tempDir("teamai-plugin-delivery-");
    const target = path.join(root, "cache", "common");
    const plugin = { name: "common", version: "1.0.0", cache_path: target };
    try {
      expect(await inspectPluginDelivery(plugin)).toBe("missing");
      expect(await inspectPluginDelivery({ name: "common", version: "1.0.0" })).toBe("unknown");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "plugin.json"), "{ invalid", "utf8");
      expect(await inspectPluginDelivery(plugin)).toBe("stale");
      await writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "common", version: "1.0.0" }), "utf8");
      expect(await inspectPluginDelivery(plugin)).toBe("present");
      await writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "common", version: "2.0.0" }), "utf8");
      expect(await inspectPluginDelivery(plugin)).toBe("stale");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("requires the referenced Skill file in an otherwise valid Plugin package", async () => {
    const root = await tempDir("teamai-plugin-skill-delivery-");
    const target = path.join(root, "cache", "api");
    const plugin = { name: "api", version: "1.0.0", cache_path: target };
    const skill = {
      name: "api-review",
      description: "API review",
      sourceType: "plugin" as const,
      plugin: "api",
      sourcePath: "plugins/api/skills/api-review",
      root: "api-review",
      owner: "api",
      tags: [],
      standalone: true,
    };
    try {
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "api", version: "1.0.0" }), "utf8");
      expect(await inspectPluginSkillDelivery(plugin, skill)).toBe("missing");
      const skillPath = path.join(target, "skills", "api-review", "SKILL.md");
      await mkdir(path.dirname(skillPath), { recursive: true });
      await writeFile(skillPath, "", "utf8");
      expect(await inspectPluginSkillDelivery(plugin, skill)).toBe("stale");
      await writeFile(skillPath, "---\nname: api-review\ndescription:\n---\n", "utf8");
      expect(await inspectPluginSkillDelivery(plugin, skill)).toBe("stale");
      await writeFile(skillPath, "---\nname: api-review\n---\n", "utf8");
      expect(await inspectPluginSkillDelivery(plugin, skill)).toBe("stale");
      await writeFile(skillPath, "---\nname: api-review\ndescription: API review\n---\n", "utf8");
      expect(await inspectPluginSkillDelivery(plugin, skill)).toBe("present");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("uses inventory enablement for the shared snapshot and convergence plan", async () => {
    const spec = `api@${TEST_MARKETPLACE_NAME}`;
    const installed = [{ name: "api", marketplace: TEST_MARKETPLACE_NAME, version: "0.1.0", enabled: true }];
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    config.managedPlugins = [spec];
    const client = {
      listMarketplaces: async () => [{ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE }],
      listPlugins: async () => installed,
      installPlugin: async () => undefined,
      enablePlugin: async () => undefined,
      disablePlugin: async () => undefined,
      updatePlugin: async () => undefined,
    } as unknown as CopilotClient;

    const plan = await convergeUserPlugins(client, config, catalog, { dryRun: true, resourceRevision: "marketplace-revision" });
    const records = await inspectUserPluginResources(catalog, TEST_MARKETPLACE_NAME, "source-hash", installed, {
      managedPlugins: config.managedPlugins,
      expectedEnabled: new Set(enabledUserPlugins("api", catalog, TEST_MARKETPLACE_NAME)),
      settingsEnabled: { [spec]: false },
      resourceRevision: "marketplace-revision",
    });
    const record = records.find((item) => item.pluginSpec === spec)!;
    const planRecord = plan.resources.find((item) => item.pluginSpec === spec)!;

    expect(record.configuredActive).toBe(true);
    expect(record.source.revision).toBe("marketplace-revision");
    expect(record.reasons).not.toContain("USER_OVERRIDE");
    expect(plan.actions).not.toContainEqual({ kind: "plugin-enable", target: spec });
    expect(planRecord.configuredActive).toBe(record.configuredActive);
    expect(planRecord.source.revision).toBe("marketplace-revision");
  });
});
