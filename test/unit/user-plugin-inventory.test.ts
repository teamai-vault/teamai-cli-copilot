import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { loadMarketplaceCatalog } from "../../src/copilot/catalog.js";
import { normalizeLivePluginInventory, recordedUserPluginInventory, readCopilotState, copilotSettingsPath } from "../../src/copilot/user-state.js";
import { tempDir } from "../helpers/test-utils.js";

test("live user inventory follows declared source paths and preserves explicit disabled choices", async () => {
  const home = await tempDir("teamai-live-inventory-home-");
  const root = await tempDir("teamai-live-inventory-source-");
  const declared = [
    { name: "common", source: "packages/shared-content", kind: "common" },
    { name: "api", source: "roles/backend", kind: "role" },
  ];
  for (const plugin of declared) {
    await mkdir(path.join(root, plugin.source), { recursive: true });
    await writeFile(path.join(root, plugin.source, "plugin.json"), JSON.stringify({ name: plugin.name, version: "1.0.0", extensions: { "com.company.teamai": { kind: plugin.kind } } }));
  }
  await mkdir(path.join(root, ".github", "plugin"), { recursive: true });
  await writeFile(path.join(root, ".github", "plugin", "marketplace.json"), JSON.stringify({ name: "live-test", plugins: declared.map((plugin) => ({ name: plugin.name, version: "1.0.0", source: plugin.source })) }));
  await writeFile(path.join(root, "skills.yaml"), "version: 1\nskills: {}\n");
  await mkdir(path.dirname(copilotSettingsPath(home)), { recursive: true });
  const settings = { extraKnownMarketplaces: { "live-test": { source: { source: "directory", path: root } } } };
  await writeFile(copilotSettingsPath(home), JSON.stringify(settings));
  const native = declared.map((plugin) => ({ name: plugin.name, marketplace: "live-test", version: "1.0.0", enabled: false, scope: "user", source: "live-marketplace:live-test", installedFrom: root }));
  const discovered = await normalizeLivePluginInventory(native, home);
  expect(discovered.map((plugin) => plugin.discoveredOnly)).toEqual([true, true]);
  expect(discovered.map((plugin) => plugin.cache_path)).toEqual(declared.map((plugin) => path.join(root, plugin.source)));
  await writeFile(copilotSettingsPath(home), JSON.stringify({ ...settings, enabledPlugins: { "common@live-test": true, "api@live-test": false } }));
  const installed = await normalizeLivePluginInventory([{ ...native[0]!, enabled: true }, native[1]!], home);
  expect(installed.map((plugin) => plugin.discoveredOnly)).toEqual([false, false]);
  expect(installed[1]?.enabled).toBe(false);
  const catalog = await loadMarketplaceCatalog(root, root);
  const local = await readCopilotState(home);
  expect(recordedUserPluginInventory(local, catalog)).toEqual(installed);
  const unverified = await normalizeLivePluginInventory([
    { ...native[0]!, version: "9.0.0" },
    { ...native[0]!, installedFrom: "https://example.invalid/source" },
    { ...native[0]!, source: "filesystem" },
  ], home);
  expect(unverified.every((plugin) => plugin.cache_path === undefined && plugin.discoveredOnly === undefined)).toBe(true);
  await catalog.dispose();
});
