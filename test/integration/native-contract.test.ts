import { expect, test, vi } from "vitest";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCli } from "../../src/cli.js";
import { createFakeCopilot, loadFakeMarketplace, tempDir, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";
import { readGlobalConfig } from "../../src/config/global.js";
import * as globalConfig from "../../src/config/global.js";
import { copilotHome } from "../../src/copilot/user-state.js";
import { parse } from "jsonc-parser";

test("current native arrays support public init planning", async () => {
  const home = await tempDir("teamai-current-contract-home-");
  const fake = await createFakeCopilot(undefined, home);
  const errors: string[] = [];
  const result = await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api", "--dry-run"], {
    homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace,
    out: () => undefined, err: (line) => errors.push(line),
  });
  expect(errors).toEqual([]);
  expect(result).toBe(0);
}, 60_000);

test.each(["default", "custom"])("public init verifies native Git records and read-only facts at the %s root", async (scenario) => {
  const home = await tempDir("teamai-git-contract-home-");
  const previous = process.env.COPILOT_HOME;
  if (scenario === "custom") process.env.COPILOT_HOME = await tempDir("teamai-git-contract-custom-");
  try {
    const fake = await createFakeCopilot(undefined, home);
    const errors: string[] = [];
    const result = await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
      homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace,
      out: () => undefined, err: (line) => errors.push(line),
    });
    expect(errors).toEqual([]);
    expect(result).toBe(0);
    const config = await readGlobalConfig(home);
    expect(config?.pendingPluginMutation).toBeUndefined();
    expect(config?.managedPluginReceipts).toHaveLength(6);
    expect(config?.managedPluginReceipts?.every((receipt) => receipt.cachePath === path.join(copilotHome(home), "installed-plugins", config.marketplace.name, receipt.spec.split("@")[0]!)
      && receipt.source === `marketplace:${config.marketplace.name}` && receipt.installedFrom === TEST_MARKETPLACE_SOURCE)).toBe(true);
    const installed = await fake.client.listPlugins();
    expect(installed.filter((row) => row.enabled).map((row) => row.name).sort()).toEqual(["api", "common"]);
    expect(await readFile(path.join(copilotHome(home), "config.json"), "utf8")).toContain("// Native configuration");
    const version = vi.spyOn(fake.client, "version").mockRejectedValue(new Error("Unexpected native process"));
    const list = vi.spyOn(fake.client, "listPlugins").mockRejectedValue(new Error("Unexpected native process"));
    const marketplaces = vi.spyOn(fake.client, "listMarketplaces").mockRejectedValue(new Error("Unexpected native process"));
    const output: string[] = [];
    const readonly = { homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: (line: string) => output.push(line), err: (line: string) => errors.push(line) };
    expect(await runCli(["status", "--json"], readonly)).toBe(0);
    expect(output).toHaveLength(1);
    const resources = JSON.parse(output[0]!).resources.filter((resource: { kind: string }) => resource.kind === "plugin");
    expect(resources).toHaveLength(6);
    expect(resources.every((resource: { delivery: string }) => resource.delivery === "present")).toBe(true);
    output.length = 0;
    await runCli(["doctor", "--json"], readonly);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!).error).toBeUndefined();
    expect(version).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(marketplaces).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  } finally {
    if (previous === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = previous;
  }
}, 120_000);

test("public directory init distinguishes discovery from explicit installation without copying packages", async () => {
  const home = await tempDir("teamai-directory-contract-home-");
  const source = await tempDir("teamai-directory-contract-source-");
  const catalog = await loadFakeMarketplace(source);
  const fake = await createFakeCopilot({ fixtureSourceRoot: source, marketplaces: [{ name: catalog.name, source }] }, home);
  const discovered = await fake.client.listPlugins();
  expect(discovered).toHaveLength(7);
  expect(discovered.every((row) => row.discoveredOnly && row.source === `live-marketplace:${catalog.name}`)).toBe(true);
  const errors: string[] = [];
  expect(await runCli(["init", "--marketplace", source, "--role", "api"], {
    homeDir: home, copilot: fake.client, loadMarketplace: () => loadFakeMarketplace(source),
    out: () => undefined, err: (line) => errors.push(line),
  })).toBe(0);
  expect(errors).toEqual([]);
  const config = await readGlobalConfig(home);
  expect(config?.managedPluginReceipts).toHaveLength(6);
  expect(config?.managedPluginReceipts?.every((receipt) => receipt.source === `live-marketplace:${catalog.name}` && receipt.installedFrom === source
    && receipt.cachePath === catalog.plugins.find((plugin) => plugin.name === receipt.spec.split("@")[0])?.root)).toBe(true);
  const installed = await fake.client.listPlugins();
  expect(installed.filter((row) => !row.discoveredOnly)).toHaveLength(6);
  expect(installed.filter((row) => row.enabled).map((row) => row.name).sort()).toEqual(["api", "common"]);
  await expect(readFile(path.join(copilotHome(home), "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readdir(path.join(copilotHome(home), "installed-plugins"))).rejects.toMatchObject({ code: "ENOENT" });
}, 120_000);

test("an unrecorded native target collision fails before Agent or Skill delivery", async () => {
  const home = await tempDir("teamai-target-contract-home-");
  const fake = await createFakeCopilot(undefined, home);
  const target = path.join(copilotHome(home), "installed-plugins", "test-teamai", "common");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "personal.txt"), "personal content");
  const errors: string[] = [];
  expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
    homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace,
    out: () => undefined, err: (line) => errors.push(line),
  })).toBe(1);
  expect(errors.join("\n")).toContain("target collision");
  expect(await readdir(copilotHome(home))).toEqual(["installed-plugins"]);
  expect(await readFile(path.join(target, "personal.txt"), "utf8")).toBe("personal content");
}, 60_000);

test("unsupported native inventory fails before the first managed delivery without fallback", async () => {
  const home = await tempDir("teamai-invalid-contract-home-");
  const marketplace = await tempDir("teamai-invalid-contract-source-");
  await mkdir(path.join(marketplace, "instructions"));
  await writeFile(path.join(marketplace, "instructions", "global.instructions.md"), "managed instruction\n");
  const fake = await createFakeCopilot({ pluginListOutput: { plugins: [], errors: [] } }, home);
  const errors: string[] = [];
  let fallbackChecks = 0;
  const result = await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
    homeDir: home, copilot: fake.client, loadMarketplace: () => loadFakeMarketplace(marketplace),
    vscodeAvailable: async () => { fallbackChecks++; return true; },
    out: () => undefined, err: (line) => errors.push(line),
  });
  expect(result).toBe(1);
  expect(errors.join("\n")).toContain("unexpected JSON shape");
  expect(fallbackChecks).toBe(0);
  expect(await readdir(home)).toEqual([]);
}, 60_000);

test("failed native installation readback retains a pending checkpoint without ownership", async () => {
  const home = await tempDir("teamai-readback-contract-home-");
  const fake = await createFakeCopilot({ recordCachePathOverride: path.join(home, "unverified-target") }, home);
  const errors: string[] = [];
  expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
    homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace,
    out: () => undefined, err: (line) => errors.push(line),
  })).toBe(1);
  expect(errors.join("\n")).toContain("Partial Copilot plugin-install");
  const pending = await readGlobalConfig(home);
  expect(pending?.managedPlugins).toEqual([]);
  expect(pending?.managedPluginReceipts).toEqual([]);
  expect(pending?.pendingPluginMutation?.expectedAfter).toMatchObject({
    cachePath: path.join(copilotHome(home), "installed-plugins", "test-teamai", pending!.pendingPluginMutation!.spec.split("@")[0]!),
    source: "marketplace:test-teamai", installedFrom: TEST_MARKETPLACE_SOURCE,
  });
  const state = await fake.readState();
  delete state.recordCachePathOverride;
  await writeFile(fake.statePath, JSON.stringify(state));
  const nativeConfigPath = path.join(copilotHome(home), "config.json");
  const nativeConfig = parse(await readFile(nativeConfigPath, "utf8"));
  nativeConfig.installedPlugins.find((record: { name: string; marketplace: string }) => `${record.name}@${record.marketplace}` === pending!.pendingPluginMutation!.spec).cache_path = pending!.pendingPluginMutation!.expectedAfter.cachePath;
  await writeFile(nativeConfigPath, `// Explicit repair of the interrupted native record\n${JSON.stringify(nativeConfig)}\n`);
  expect(await runCli(["sync"], { homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: () => undefined, err: (line) => errors.push(line) })).toBe(0);
  expect((await readGlobalConfig(home))?.pendingPluginMutation).toBeUndefined();
  expect((await readGlobalConfig(home))?.managedPluginReceipts).toHaveLength(6);
}, 120_000);

test.each([
  { pluginListOutput: [{ name: "common", enabled: "true", source: "installed" }] },
  { pluginListOutput: [null] },
  { marketplaceListOutput: [{ name: "test-teamai", source: 42 }] },
])("invalid native required types fail before any managed write: %j", async (invalid) => {
  const home = await tempDir("teamai-type-contract-home-");
  const fake = await createFakeCopilot(invalid, home);
  const errors: string[] = [];
  let fallback = 0;
  expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
    homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace,
    vscodeAvailable: async () => { fallback++; return true; }, out: () => undefined, err: (line) => errors.push(line),
  })).toBe(1);
  expect(errors.join("\n")).toContain("invalid required field types");
  expect(fallback).toBe(0);
  expect(await readdir(home)).toEqual([]);
}, 30_000);

test("public init preserves a personal same-name installed Plugin without taking ownership", async () => {
  const home = await tempDir("teamai-personal-contract-home-");
  const fake = await createFakeCopilot({ marketplaces: [{ name: "test-teamai", source: TEST_MARKETPLACE_SOURCE }], plugins: [{ name: "common", marketplace: "test-teamai", version: "0.1.0", enabled: false }] }, home);
  const errors: string[] = [];
  expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
    homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: () => undefined, err: (line) => errors.push(line),
  })).toBe(0);
  expect(errors).toEqual([]);
  expect((await fake.client.listPlugins()).find((row) => row.name === "common")?.enabled).toBe(false);
  const config = await readGlobalConfig(home);
  expect(config?.managedPlugins).not.toContain("common@test-teamai");
  expect(config?.managedPluginReceipts).toHaveLength(5);
}, 120_000);

test("completion save failure recovers only the native delivered identity", async () => {
  const home = await tempDir("teamai-save-contract-home-");
  const fake = await createFakeCopilot(undefined, home);
  const write = globalConfig.writeGlobalConfig;
  let saves = 0;
  const checkpoint = vi.spyOn(globalConfig, "writeGlobalConfig").mockImplementation(async (config, target) => {
    if (++saves === 2) throw new Error("Injected completion save failure");
    await write(config, target);
  });
  const errors: string[] = [];
  try {
      expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
        homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: () => undefined, err: (line) => errors.push(line),
      })).toBe(1);
      expect(errors.join("\n")).toContain("Injected completion save failure");
      const pending = await readGlobalConfig(home);
      expect(pending?.managedPlugins).toEqual([]);
      expect(pending?.managedPluginReceipts).toEqual([]);
      expect(pending?.pendingPluginMutation).toBeDefined();
  } finally { checkpoint.mockRestore(); }
  expect(await runCli(["sync"], { homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: () => undefined, err: (line) => errors.push(line) })).toBe(0);
  expect((await readGlobalConfig(home))?.pendingPluginMutation).toBeUndefined();
  expect((await readGlobalConfig(home))?.managedPluginReceipts).toHaveLength(6);
}, 120_000);

test("native mutation help is rechecked under the user lock before managed delivery", async () => {
  const home = await tempDir("teamai-locked-contract-home-");
  const fake = await createFakeCopilot(undefined, home);
  let checks = 0;
  fake.client.validatePluginCommands = async () => {
    if (++checks === 2) throw new Error("Mutation command contract changed under lock");
  };
  const errors: string[] = [];
  expect(await runCli(["init", "--marketplace", TEST_MARKETPLACE_SOURCE, "--role", "api"], {
    homeDir: home, copilot: fake.client, loadMarketplace: loadFakeMarketplace, out: () => undefined, err: (line) => errors.push(line),
  })).toBe(1);
  expect(errors.join("\n")).toContain("Mutation command contract changed under lock");
  expect(checks).toBe(2);
  expect(await readdir(copilotHome(home))).toEqual([]);
  expect(await readGlobalConfig(home)).toBeUndefined();
}, 60_000);
