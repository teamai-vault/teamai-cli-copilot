import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { runCli } from "../../src/cli.js";
import { readGlobalConfig } from "../../src/config/global.js";
import { FallbackCopilotClient } from "../../src/copilot/fallback.js";
import { TEAM_AI_EXTENSION_NAMESPACE } from "../../src/copilot/catalog.js";
import { CopilotClient } from "../../src/copilot/cli.js";
import { copilotConfigPath, copilotSettingsPath, installedPluginsRoot, registerMarketplaceState } from "../../src/copilot/user-state.js";
import { createGitRepo, prepareFakePublishedAuthority, tempDir } from "../helpers/test-utils.js";
import { runProcess } from "../../src/utils/process.js";

async function createMarketplace(): Promise<string> {
  const root = await tempDir("teamai-fallback-marketplace-");
  await mkdir(path.join(root, ".github", "plugin"), { recursive: true });
  const plugins = [
    { name: "common", kind: "common" },
    { name: "api", kind: "role" },
    { name: "qa", kind: "role" },
    { name: "payments", kind: "project" },
  ];
  for (const plugin of plugins) {
    const pluginRoot = path.join(root, "plugins", plugin.name);
    await mkdir(pluginRoot, { recursive: true });
    await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
      name: plugin.name,
      version: "0.1.0",
      extensions: { "com.company.teamai": { kind: plugin.kind } },
    }), "utf8");
    await writeFile(path.join(pluginRoot, "content.txt"), plugin.name, "utf8");
    if (plugin.name === "api") {
      await mkdir(path.join(pluginRoot, "com.github.copilot", "rules"), { recursive: true });
      await writeFile(path.join(pluginRoot, "com.github.copilot", "rules", "api.instructions.md"), "---\napplyTo: \"**\"\n---\n\napi rule\n", "utf8");
    }
  }
  await writeFile(path.join(root, ".github", "plugin", "marketplace.json"), JSON.stringify({
    name: "fallback-teamai",
    plugins: plugins.map((plugin) => ({ name: plugin.name, version: "0.1.0", source: `./plugins/${plugin.name}` })),
  }), "utf8");
  await writeFile(path.join(root, "skills.yaml"), "version: 1\nskills: {}\n", "utf8");
  await prepareFakePublishedAuthority(root);
  return root;
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}

async function createCachedMarketplace(home: string, source: string): Promise<void> {
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const root = path.join(home, ".teamai", "marketplaces", sourceHash, "checkout");
  await mkdir(path.join(root, ".github", "plugin"), { recursive: true });
  for (const [name, kind] of [["common", "common"], ["api", "role"]]) {
    await mkdir(path.join(root, "plugins", name), { recursive: true });
    await writeFile(path.join(root, "plugins", name, "plugin.json"), JSON.stringify({
      name,
      version: "0.1.0",
      extensions: { [TEAM_AI_EXTENSION_NAMESPACE]: { kind } },
    }), "utf8");
  }
  await writeFile(path.join(root, ".github", "plugin", "marketplace.json"), JSON.stringify({
    name: "fallback-cache-teamai",
    plugins: ["common", "api"].map((name) => ({ name, version: "0.1.0", source: `./plugins/${name}` })),
  }), "utf8");
  await writeFile(path.join(root, "skills.yaml"), "version: 1\nskills: {}\n", "utf8");
  await git(root, ["init"]);
  await git(root, ["config", "user.email", "teamai@example.invalid"]);
  await git(root, ["config", "user.name", "Team AI Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "cached marketplace"]);
}

describe("VS Code-only Copilot fallback", () => {
  test("direct fallback clients read the caller's persistent Marketplace cache", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-fallback-cache-home-");
    const source = "https://example.invalid/teamai-marketplace.git";
    await createCachedMarketplace(home, source);
    const settings = { extraKnownMarketplaces: {} as Record<string, { source: Record<string, string> }> };
    registerMarketplaceState(settings, "fallback-cache-teamai", source);
    await mkdir(path.dirname(copilotSettingsPath(home)), { recursive: true });
    await writeFile(copilotSettingsPath(home), JSON.stringify(settings), "utf8");

    const client = new FallbackCopilotClient(home, () => new Date("2026-09-15T00:00:00.000Z"));
    await expect(client.browseMarketplace("fallback-cache-teamai", repo)).resolves.toEqual([
      { name: "common", version: "0.1.0" },
      { name: "api", version: "0.1.0" },
    ]);
  }, 60_000);

  test("materializes all user plugins and keeps Copilot enablement metadata synchronized", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-fallback-home-");
    const marketplace = await createMarketplace();
    const configPath = copilotConfigPath(home);
    const settingsPath = copilotSettingsPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ nativeField: "keep", installedPlugins: [{ name: "personal", marketplace: "other", enabled: true, source_sha: "keep" }] }), "utf8");
    const initialSettings = {
      unknownSetting: true,
      enabledPlugins: { "personal@other": true },
      extraKnownMarketplaces: {
        "fallback-teamai": {
          source: { source: "github", repo: "old/source", nativeField: "keep" },
          entryField: "keep",
        },
      },
    };
    registerMarketplaceState(initialSettings, "fallback-teamai", marketplace);
    await writeFile(settingsPath, JSON.stringify(initialSettings), "utf8");
    const vscodePath = path.join(home, "Code", "settings.json");
    await mkdir(path.dirname(vscodePath), { recursive: true });
    await writeFile(vscodePath, `{
  // keep
  "chat.plugins.marketplaces": ["existing",],
}
`, "utf8");
    const base = {
      cwd: repo,
      homeDir: home,
      copilot: new CopilotClient("teamai-command-that-does-not-exist"),
      vscodeAvailable: async () => true,
      vscodeSettingsPath: vscodePath,
      now: () => new Date("2026-09-15T00:00:00.000Z"),
      out: () => undefined,
      err: () => undefined,
    };

    expect(await runCli(["init", "--marketplace", marketplace, "--role", "api"], base)).toBe(0);
    expect((await readGlobalConfig(home))?.managedPlugins).toEqual([
      "api@fallback-teamai",
      "common@fallback-teamai",
      "qa@fallback-teamai",
    ]);

    const copilotConfig = JSON.parse(await readFile(configPath, "utf8"));
    const copilotSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(copilotConfig.nativeField).toBe("keep");
    expect(copilotConfig.installedPlugins).toHaveLength(4);
    expect(copilotConfig.installedPlugins.find((item: { name: string }) => item.name === "personal").source_sha).toBe("keep");
    for (const name of ["common", "api", "qa"]) {
      const installed = copilotConfig.installedPlugins.find((item: { name: string }) => item.name === name);
      expect(installed).toMatchObject({
        marketplace: "fallback-teamai",
        version: "0.1.0",
        installed_at: "2026-09-15T00:00:00.000Z",
      });
      expect(installed.source_sha).toBeUndefined();
    }
    expect(copilotSettings.unknownSetting).toBe(true);
    expect(copilotSettings.enabledPlugins).toMatchObject({
      "personal@other": true,
      "common@fallback-teamai": true,
      "api@fallback-teamai": true,
      "qa@fallback-teamai": false,
    });
    expect(copilotSettings.extraKnownMarketplaces["fallback-teamai"].source.path).toBe(marketplace);
    expect(copilotSettings.extraKnownMarketplaces["fallback-teamai"].source.nativeField).toBe("keep");
    expect(copilotSettings.extraKnownMarketplaces["fallback-teamai"].source.repo).toBeUndefined();
    expect(copilotSettings.extraKnownMarketplaces["fallback-teamai"].entryField).toBe("keep");
    await expect(readFile(path.join(installedPluginsRoot(home), "fallback-teamai", "qa", "content.txt"), "utf8")).resolves.toBe("qa");
    await expect(readFile(path.join(installedPluginsRoot(home), "fallback-teamai", "api", "com.github.copilot", "rules", "api.instructions.md"), "utf8")).resolves.toContain("api rule");
    await expect(readFile(path.join(home, ".copilot", "instructions", "teamai", "api.instructions.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    expect(await runCli(["role", "set", "qa"], base)).toBe(0);
    const switchedConfig = JSON.parse(await readFile(configPath, "utf8"));
    const switchedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
    expect(switchedSettings.enabledPlugins["api@fallback-teamai"]).toBe(false);
    expect(await readFile(path.join(installedPluginsRoot(home), "fallback-teamai", "api", "com.github.copilot", "rules", "api.instructions.md"), "utf8")).toContain("api rule");
    expect(switchedSettings.enabledPlugins["qa@fallback-teamai"]).toBe(true);
    expect(switchedConfig.installedPlugins.find((item: { name: string }) => item.name === "api").enabled).toBe(false);
    expect(switchedConfig.installedPlugins.find((item: { name: string }) => item.name === "qa").enabled).toBe(true);

    switchedConfig.installedPlugins.find((item: { name: string }) => item.name === "api").enabled = true;
    delete switchedConfig.installedPlugins.find((item: { name: string }) => item.name === "qa").enabled;
    await writeFile(configPath, JSON.stringify(switchedConfig), "utf8");
    expect(await runCli(["sync"], base)).toBe(0);
    const repairedConfig = JSON.parse(await readFile(configPath, "utf8"));
    expect(repairedConfig.installedPlugins.find((item: { name: string }) => item.name === "api").enabled).toBe(false);
    expect(repairedConfig.installedPlugins.find((item: { name: string }) => item.name === "qa").enabled).toBe(true);

    repairedConfig.installedPlugins = repairedConfig.installedPlugins.filter((item: { name: string }) => item.name !== "qa");
    await writeFile(configPath, JSON.stringify(repairedConfig), "utf8");
    expect(await runCli(["sync"], base)).toBe(0);
    expect(JSON.parse(await readFile(configPath, "utf8")).installedPlugins.some((item: { name: string }) => item.name === "qa")).toBe(true);
    expect(await runCli(["doctor"], base)).toBe(0);
    const vscode = await readFile(vscodePath, "utf8");
    expect(vscode).toContain("// keep");
    expect(vscode.indexOf(marketplace)).toBeLessThan(vscode.indexOf("existing"));
  }, 30_000);

  test("materializes selected project Plugin packages without enabling them globally", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-fallback-project-plugin-home-");
    const marketplace = await createMarketplace();
    await mkdir(path.join(marketplace, "manifest"), { recursive: true });
    await writeFile(path.join(marketplace, "manifest", "projects.yaml"), [
      "version: 1",
      "projects:",
      "  - id: payments",
      "    name: Payments",
      "    description: Payments project",
      "    owners: [teamai]",
      "    plugin: payments",
      "",
    ].join("\n"), "utf8");
    const output: string[] = [];
    const base = {
      cwd: repo,
      homeDir: home,
      copilot: new CopilotClient("teamai-command-that-does-not-exist"),
      vscodeAvailable: async () => true,
      out: (line: string) => output.push(line),
      err: () => undefined,
    };

    expect(await runCli(["init", "--marketplace", marketplace, "--role", "api"], base)).toBe(0);
    expect(await runCli(["sync"], base)).toBe(0);
    const target = path.join(installedPluginsRoot(home), "fallback-teamai", "payments");
    output.length = 0;
    expect(await runCli(["--dry-run", "projects", "set", "payments"], base)).toBe(0);
    expect(output.some((line) => line.includes(`project Plugin package payments@fallback-teamai to ${target}`))).toBe(true);
    await expect(readFile(path.join(target, "plugin.json"))).rejects.toMatchObject({ code: "ENOENT" });

    expect(await runCli(["projects", "set", "payments"], base)).toBe(0);
    await expect(readFile(path.join(target, "plugin.json"), "utf8")).resolves.toContain('"kind":"project"');
    const copilotConfig = JSON.parse(await readFile(copilotConfigPath(home), "utf8"));
    const copilotSettings = JSON.parse(await readFile(copilotSettingsPath(home), "utf8"));
    expect(copilotConfig.installedPlugins.find((plugin: { name: string; marketplace: string }) => plugin.name === "payments" && plugin.marketplace === "fallback-teamai")).toMatchObject({ enabled: false, version: "0.1.0" });
    expect(copilotSettings.enabledPlugins["payments@fallback-teamai"]).toBe(false);
    expect(JSON.parse(await readFile(path.join(repo, ".github", "copilot", "settings.json"), "utf8")).enabledPlugins["payments@fallback-teamai"]).toBe(true);
    expect((await readGlobalConfig(home))?.managedPlugins).not.toContain("payments@fallback-teamai");

    expect(await runCli(["sync"], base)).toBe(0);
    expect(JSON.parse(await readFile(copilotConfigPath(home), "utf8")).installedPlugins.find((plugin: { name: string; marketplace: string }) => plugin.name === "payments" && plugin.marketplace === "fallback-teamai").enabled).toBe(false);
    expect(JSON.parse(await readFile(copilotSettingsPath(home), "utf8")).enabledPlugins["payments@fallback-teamai"]).toBe(false);
    await expect(readFile(path.join(target, "plugin.json"), "utf8")).resolves.toContain('"kind":"project"');
  }, 30_000);

  test("preserves a pre-existing user Project package through projects set and sync", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-fallback-unowned-project-plugin-home-");
    const marketplace = await createMarketplace();
    await mkdir(path.join(marketplace, "manifest"), { recursive: true });
    await writeFile(path.join(marketplace, "manifest", "projects.yaml"), [
      "version: 1",
      "projects:",
      "  - id: payments",
      "    name: Payments",
      "    description: Payments project",
      "    owners: [teamai]",
      "    plugin: payments",
      "",
    ].join("\n"), "utf8");
    const target = path.join(installedPluginsRoot(home), "fallback-teamai", "payments");
    const userOwnedManifest = JSON.stringify({ name: "payments", version: "9.9.9", userOwned: true, extensions: { [TEAM_AI_EXTENSION_NAMESPACE]: { kind: "project" } } });
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "plugin.json"), userOwnedManifest, "utf8");
    await writeFile(path.join(target, "user-marker.txt"), "leave this package untouched", "utf8");
    await mkdir(path.dirname(copilotSettingsPath(home)), { recursive: true });
    await writeFile(copilotSettingsPath(home), JSON.stringify({ enabledPlugins: { "payments@fallback-teamai": true } }), "utf8");
    const output: string[] = [];
    const base = {
      cwd: repo,
      homeDir: home,
      copilot: new CopilotClient("teamai-command-that-does-not-exist"),
      vscodeAvailable: async () => true,
      out: (line: string) => output.push(line),
      err: () => undefined,
    };

    expect(await runCli(["init", "--marketplace", marketplace, "--role", "api"], base)).toBe(0);
    expect(await runCli(["sync"], base)).toBe(0);
    output.length = 0;
    expect(await runCli(["projects", "set", "payments"], base)).toBe(0);
    expect(output.some((line) => line.includes(`PRESERVE existing unowned project Plugin package payments@fallback-teamai at ${target}`))).toBe(true);
    await expect(readFile(path.join(target, "plugin.json"), "utf8")).resolves.toBe(userOwnedManifest);
    await expect(readFile(path.join(target, "user-marker.txt"), "utf8")).resolves.toBe("leave this package untouched");
    expect(JSON.parse(await readFile(copilotSettingsPath(home), "utf8")).enabledPlugins["payments@fallback-teamai"]).toBe(true);

    output.length = 0;
    expect(await runCli(["sync"], base)).toBe(0);
    expect(output.some((line) => line.includes(`PRESERVE existing unowned project Plugin package payments@fallback-teamai at ${target}`))).toBe(true);
    await expect(readFile(path.join(target, "plugin.json"), "utf8")).resolves.toBe(userOwnedManifest);
    await expect(readFile(path.join(target, "user-marker.txt"), "utf8")).resolves.toBe("leave this package untouched");
    expect(JSON.parse(await readFile(copilotSettingsPath(home), "utf8")).enabledPlugins["payments@fallback-teamai"]).toBe(true);
  }, 30_000);

  test("reports conflicting installed records and invalid package targets as unavailable", async () => {
    const repo = await createGitRepo();
    const marketplace = await createMarketplace();
    const spec = "payments@fallback-teamai";
    const configuredHome = await tempDir("teamai-fallback-configured-project-package-home-");
    const alternateCache = path.join(configuredHome, "personal-cache", "payments");
    await mkdir(alternateCache, { recursive: true });
    await writeFile(path.join(alternateCache, "plugin.json"), JSON.stringify({ name: "payments", version: "9.0.0" }), "utf8");
    await mkdir(path.dirname(copilotSettingsPath(configuredHome)), { recursive: true });
    const configuredSettings = { extraKnownMarketplaces: {} as Record<string, { source: Record<string, string> }>, enabledPlugins: { [spec]: true } };
    registerMarketplaceState(configuredSettings, "fallback-teamai", marketplace);
    await writeFile(copilotSettingsPath(configuredHome), JSON.stringify(configuredSettings), "utf8");
    const installedRecord = { name: "payments", marketplace: "fallback-teamai", version: "9.0.0", cache_path: alternateCache, enabled: true, userField: "keep" };
    await writeFile(copilotConfigPath(configuredHome), JSON.stringify({ installedPlugins: [installedRecord] }), "utf8");
    const configuredClient = new FallbackCopilotClient(configuredHome, () => new Date("2026-09-15T00:00:00.000Z"));
    const configuredResult = await configuredClient.materializeProjectPlugin(spec, repo);
    expect(configuredResult.status).toBe("unavailable");
    expect(configuredResult.reason).toContain(alternateCache);
    expect(JSON.parse(await readFile(copilotConfigPath(configuredHome), "utf8")).installedPlugins[0]).toEqual(installedRecord);
    await expect(readFile(path.join(installedPluginsRoot(configuredHome), "fallback-teamai", "payments", "plugin.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const invalidHome = await tempDir("teamai-fallback-invalid-project-package-home-");
    const invalidTarget = path.join(installedPluginsRoot(invalidHome), "fallback-teamai", "payments");
    await mkdir(invalidTarget, { recursive: true });
    await writeFile(path.join(invalidTarget, "user-marker.txt"), "preserve invalid directory", "utf8");
    await mkdir(path.dirname(copilotSettingsPath(invalidHome)), { recursive: true });
    const invalidSettings = { extraKnownMarketplaces: {} as Record<string, { source: Record<string, string> }> };
    registerMarketplaceState(invalidSettings, "fallback-teamai", marketplace);
    await writeFile(copilotSettingsPath(invalidHome), JSON.stringify(invalidSettings), "utf8");
    const invalidClient = new FallbackCopilotClient(invalidHome, () => new Date("2026-09-15T00:00:00.000Z"));
    const invalidResult = await invalidClient.materializeProjectPlugin(spec, repo);
    expect(invalidResult.status).toBe("unavailable");
    expect(invalidResult.reason).toContain("not a valid");
    await expect(readFile(path.join(invalidTarget, "user-marker.txt"), "utf8")).resolves.toBe("preserve invalid directory");
    await expect(readFile(copilotConfigPath(invalidHome))).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("uses one custom COPILOT_HOME for fallback state and generated targets, then rejects a changed root", async () => {
    const prior = process.env.COPILOT_HOME;
    const repo = await createGitRepo();
    const home = await tempDir("teamai-fallback-custom-root-home-");
    const customRoot = path.join(home, "custom-copilot");
    const otherRoot = path.join(home, "other-copilot");
    const marketplace = await createMarketplace();
    await mkdir(path.join(marketplace, "instructions"), { recursive: true });
    await writeFile(path.join(marketplace, "instructions", "api.instructions.md"), "api user instructions\n", "utf8");
    const client = new CopilotClient("teamai-command-that-does-not-exist");
    const output: string[] = [];
    const errors: string[] = [];
    const base = {
      cwd: repo,
      homeDir: home,
      copilot: client,
      vscodeAvailable: async () => true,
      loadMarketplace: async (source: string, cwd: string, options?: { homeDir?: string; dryRun?: boolean; refresh?: boolean }) => {
        const { loadMarketplaceCatalog } = await import("../../src/copilot/catalog.js");
        return await loadMarketplaceCatalog(source, cwd, { ...options, homeDir: home });
      },
      out: (line: string) => output.push(line),
      err: (line: string) => errors.push(line),
    };
    process.env.COPILOT_HOME = customRoot;
    try {
      expect(await runCli(["--dry-run", "init", "--marketplace", marketplace, "--role", "api"], base)).toBe(0);
      expect(output).toContain("WOULD create: " + path.join(customRoot, "skills", "teamai"));
      expect(output).toContain("WOULD create: " + path.join(customRoot, "instructions", "teamai", "api.instructions.md"));
      await expect(readFile(path.join(customRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(path.join(home, ".copilot", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readGlobalConfig(home)).toBeUndefined();

      output.length = 0;
      expect(await runCli(["init", "--marketplace", marketplace, "--role", "api"], base)).toBe(0);
      expect(output).toContain("DONE create: " + path.join(customRoot, "skills", "teamai"));
      expect(output).toContain("DONE create: " + path.join(customRoot, "instructions", "teamai", "api.instructions.md"));
      expect(JSON.parse(await readFile(path.join(customRoot, "config.json"), "utf8")).installedPlugins.length).toBeGreaterThan(0);
      expect(await readFile(path.join(customRoot, "skills", "teamai", "SKILL.md"), "utf8")).toContain("Team AI");
      await expect(readFile(path.join(customRoot, "instructions", "teamai", "api.instructions.md"), "utf8")).resolves.toContain("api user instructions");
      await expect(readFile(path.join(home, ".copilot", "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await readGlobalConfig(home))?.role).toBe("api");

      process.env.COPILOT_HOME = otherRoot;
      const mismatch = await runCli(["role", "set", "qa"], base);
      expect(mismatch).toBe(1);
      expect(errors.join("\n")).toContain("COPILOT_HOME root mismatch");
      expect(JSON.parse(await readFile(path.join(customRoot, "config.json"), "utf8")).installedPlugins.length).toBeGreaterThan(0);
      await expect(readFile(path.join(otherRoot, "config.json"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (prior === undefined) delete process.env.COPILOT_HOME;
      else process.env.COPILOT_HOME = prior;
    }
  }, 30_000);
});
