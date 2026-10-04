import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import { loadMarketplaceCatalog } from "../../src/copilot/catalog.js";
import { normalizeLivePluginInventory, recordedUserPluginInventory, readCopilotState, copilotSettingsPath } from "../../src/copilot/user-state.js";
import { loadFakeMarketplace, tempDir } from "../helpers/test-utils.js";

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
  const native = declared.map((plugin) => ({ name: plugin.name, marketplace: "live-test", version: "1.0.0", enabled: false, source: "live", installedFrom: root }));
  const discovered = await normalizeLivePluginInventory(native, home);
  expect(discovered.map((plugin) => plugin.discoveredOnly)).toEqual([true, true]);
  expect(discovered.map((plugin) => plugin.cache_path)).toEqual(declared.map((plugin) => path.join(root, plugin.source)));
  await writeFile(copilotSettingsPath(home), JSON.stringify({ ...settings, enabledPlugins: { "common@live-test": true, "api@live-test": false } }));
  const installed = await normalizeLivePluginInventory([{ ...native[0]!, enabled: true }, native[1]!], home);
  expect(installed.map((plugin) => plugin.discoveredOnly)).toEqual([false, false]);
  expect(installed[1]?.enabled).toBe(false);
  const catalog = await loadMarketplaceCatalog(root, root);
  const local = await readCopilotState(home);
  expect((await recordedUserPluginInventory(local, catalog, home)).map(({ scope: _scope, ...row }) => row)).toEqual(installed);
  const unverified = await normalizeLivePluginInventory([
    { ...native[0]!, version: "9.0.0" },
    { ...native[0]!, installedFrom: "https://example.invalid/source" },
    { ...native[0]!, source: "filesystem" },
  ], home);
  expect(unverified.every((plugin) => plugin.cache_path === undefined && plugin.discoveredOnly === undefined)).toBe(true);
  await catalog.dispose();
});

test("local Git JSONC records use exact registration and native target without modifying unknown fields", async () => {
  const home = await tempDir("teamai-recorded-git-home-");
  const catalog = await loadFakeMarketplace();
  const root = path.join(home, ".copilot");
  const target = path.join(root, "installed-plugins", catalog.name, "common");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "common", version: "0.1.0" }));
  const record = { name: "common", marketplace: catalog.name, version: "0.1.0", enabled: false, cache_path: target,
    source_sha: "opaque-package-digest-not-a-git-revision", future: { preserved: true } };
  const configText = `// Native comment\n${JSON.stringify({ installedPlugins: [record], unknownConfig: [1] })}\n`;
  await writeFile(path.join(root, "config.json"), configText);
  const settings = { extraKnownMarketplaces: { [catalog.name]: { source: { source: "git", url: "https://example.invalid/teamai.git", unknownSource: "keep" } } }, enabledPlugins: { [`common@${catalog.name}`]: false }, unknownSettings: { keep: true } };
  const settingsText = JSON.stringify(settings);
  await writeFile(path.join(root, "settings.json"), settingsText);
  const local = await readCopilotState(home);
  const rows = await recordedUserPluginInventory(local, catalog, home);
  expect(rows).toEqual([{ ...record, source: `marketplace:${catalog.name}`, installedFrom: "https://example.invalid/teamai.git", discoveredOnly: false }]);
  expect(local.settings).toEqual(settings);
  expect(await readFile(path.join(root, "config.json"), "utf8")).toBe(configText);
  expect(await readFile(path.join(root, "settings.json"), "utf8")).toBe(settingsText);
}, 60_000);
