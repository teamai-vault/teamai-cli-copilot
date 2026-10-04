import { expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { CopilotClient } from "../../src/copilot/cli.js";
import { runProcess } from "../../src/utils/process.js";
import { readCopilotState, recordedUserPluginInventory } from "../../src/copilot/user-state.js";
import { createFakeCopilot, loadFakeMarketplace, tempDir, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

const helper = fileURLToPath(new URL("../helpers/fake-copilot.mjs", import.meta.url));

test("current adapter preserves unknown metadata, full runtime output, and successful stderr", async () => {
  const home = await tempDir("teamai-adapter-contract-home-");
  const row = { name: "personal", enabled: false, source: "filesystem", future: { preserved: [1, 2] } };
  const fake = await createFakeCopilot({ pluginListOutput: [row], versionOutput: "Runtime 9.8.7\nActual executable details\n", warning: "Native warning\n", browseOutput: [{ name: "common", future: true }] }, home);
  const warnings: string[] = [];
  const client = new CopilotClient(process.execPath, [helper, fake.statePath], home, (text) => warnings.push(text));
  expect(await client.version()).toBe("Runtime 9.8.7\nActual executable details");
  expect(await client.listPlugins()).toEqual([row]);
  expect(await client.browseMarketplace("test-teamai")).toEqual([{ name: "common", future: true }]);
  expect(warnings).toEqual(["Native warning\n", "Native warning\n", "Native warning\n"]);
});

test.each([{ args: ["plugins", "list", "--json"] }, { args: ["plugin", "list", "--json", "--kind", "user"] }])("current fake rejects unrecognized argv %j", async ({ args }) => {
  const fake = await createFakeCopilot();
  const result = await runProcess(process.execPath, [helper, fake.statePath, ...args]);
  expect(result.exitCode).toBe(2);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("Unsupported fake Copilot args");
});

test("a non-JSON stdout prefix is rejected with its original diagnostic", async () => {
  const fake = await createFakeCopilot({ pluginListText: "Native stdout diagnostic\n[]\n" });
  await expect(fake.client.listPlugins()).rejects.toThrow("Native stdout diagnostic\n[]");
});

test("a receipt without a delivery path cannot authorize an occupied native target", async () => {
  const home = await tempDir("teamai-missing-receipt-path-");
  const fake = await createFakeCopilot(undefined, home);
  const catalog = await loadFakeMarketplace();
  const target = path.join(home, ".copilot", "installed-plugins", catalog.name, "common");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "personal.txt"), "preserve personal content");
  await expect(fake.client.preparePluginDelivery({ name: catalog.name, source: TEST_MARKETPLACE_SOURCE }, catalog.plugins, [{
    spec: `common@${catalog.name}`, version: "0.1.0", enabled: true, manifestHash: "fixture-hash",
    marketplaceSource: TEST_MARKETPLACE_SOURCE, source: `marketplace:${catalog.name}`, installedFrom: TEST_MARKETPLACE_SOURCE,
  }])).rejects.toThrow("Native Plugin target collision");
  expect(await readFile(path.join(target, "personal.txt"), "utf8")).toBe("preserve personal content");
}, 60_000);

test("raw plugin listing never repairs records or replaces package content", async () => {
  const home = await tempDir("teamai-raw-list-home-");
  const fake = await createFakeCopilot({ marketplaces: [{ name: "test-teamai", source: TEST_MARKETPLACE_SOURCE }], plugins: [{ name: "common", marketplace: "test-teamai", version: "0.1.0", enabled: true }] }, home);
  const target = path.join(home, ".copilot", "installed-plugins", "test-teamai", "common");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "plugin.json"), "personal package bytes");
  await writeFile(path.join(target, "personal.txt"), "preserve marker");
  const configPath = path.join(home, ".copilot", "config.json");
  const config = `// Preserve this diagnostic record\n${JSON.stringify({ unknownConfig: true, installedPlugins: [{ name: "common", marketplace: "test-teamai", version: "9.9.9", enabled: false, cache_path: target, unknownRecord: { preserve: true } }] })}\n`;
  await writeFile(configPath, config);
  const stateBefore = await readFile(fake.statePath, "utf8");
  const result = await runProcess(process.execPath, [helper, fake.statePath, "plugin", "list", "--json"]);
  expect(result.exitCode).toBe(0);
  expect(await readFile(configPath, "utf8")).toBe(config);
  expect(await readFile(fake.statePath, "utf8")).toBe(stateBefore);
  expect(await readFile(path.join(target, "plugin.json"), "utf8")).toBe("personal package bytes");
  expect(await readFile(path.join(target, "personal.txt"), "utf8")).toBe("preserve marker");
  expect(JSON.parse(result.stdout)[0]).toMatchObject({ version: "9.9.9", enabled: false, source: "installed" });
  await unlink(path.join(target, "plugin.json"));
  const missing = await runProcess(process.execPath, [helper, fake.statePath, "plugin", "list", "--json"]);
  expect(missing.exitCode).toBe(0);
  await expect(readFile(path.join(target, "plugin.json"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(configPath, "utf8")).toBe(config);
  expect(await readFile(fake.statePath, "utf8")).toBe(stateBefore);
  expect(await readFile(path.join(target, "personal.txt"), "utf8")).toBe("preserve marker");
}, 60_000);

test.each(["slashes", "case", "different"])("directory native installedFrom keeps its validated producer identity: %s", async (scenario) => {
  const home = await tempDir("teamai-directory-identity-home-");
  const source = await tempDir("teamai-directory-identity-source-");
  const catalog = await loadFakeMarketplace(source);
  const nativeSource = source.replaceAll("\\", "/");
  const fake = await createFakeCopilot({ fixtureSourceRoot: source, marketplaces: [{ name: catalog.name, source: nativeSource }] }, home);
  const configuredSource = scenario === "different" ? await tempDir("teamai-other-directory-") : scenario === "case" && process.platform === "win32" ? source.toUpperCase() : source;
  const prepare = () => fake.client.preparePluginDelivery({ name: catalog.name, source: configuredSource }, catalog.plugins, []);
  if (scenario === "different") await expect(prepare()).rejects.toThrow("Marketplace source conflict");
  else {
    await prepare();
    expect(fake.client.pluginInstallIdentity(`common@${catalog.name}`).installedFrom).toBe(nativeSource);
    const recorded = await recordedUserPluginInventory(await readCopilotState(home), catalog, home);
    expect(recorded.every((row) => row.installedFrom === nativeSource)).toBe(true);
  }
}, 60_000);

test("native enable and disable preserve package bytes and unknown persisted fields", async () => {
  const home = await tempDir("teamai-native-enable-home-");
  const fake = await createFakeCopilot({ marketplaces: [{ name: "test-teamai", source: TEST_MARKETPLACE_SOURCE }], plugins: [{ name: "common", marketplace: "test-teamai", version: "0.1.0", enabled: true }] }, home);
  const root = path.join(home, ".copilot");
  const target = path.join(root, "installed-plugins", "test-teamai", "common");
  const manifest = await readFile(path.join(target, "plugin.json"), "utf8");
  await writeFile(path.join(target, "personal.txt"), "marker");
  const configFile = path.join(root, "config.json");
  const settingsFile = path.join(root, "settings.json");
  const config = (await readCopilotState(home)).config;
  config.unknownConfig = { keep: true };
  config.installedPlugins![0]!.unknownRecord = ["preserve"];
  config.installedPlugins![0]!.source_sha = "opaque-native-package-digest";
  await writeFile(configFile, `// Native JSONC\n${JSON.stringify(config)}\n`);
  const settings = (await readCopilotState(home)).settings;
  settings.unknownSettings = { preserve: true };
  settings.extraKnownMarketplaces!["test-teamai"]!.source.unknownSource = "keep";
  await writeFile(settingsFile, JSON.stringify(settings));
  await fake.client.disablePlugin("common@test-teamai");
  expect((await fake.client.listPlugins())[0]?.enabled).toBe(false);
  await fake.client.enablePlugin("common@test-teamai");
  expect((await fake.client.listPlugins())[0]?.enabled).toBe(true);
  const after = await readCopilotState(home);
  expect(after.config).toEqual(config);
  expect(after.settings).toEqual(settings);
  expect(await readFile(path.join(target, "plugin.json"), "utf8")).toBe(manifest);
  expect(await readFile(path.join(target, "personal.txt"), "utf8")).toBe("marker");
}, 60_000);
