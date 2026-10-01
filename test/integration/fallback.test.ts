import { createHash } from "node:crypto";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";
import { runCli } from "../../src/cli.js";
import { readGlobalConfig } from "../../src/config/global.js";
import { FallbackCopilotClient } from "../../src/copilot/fallback.js";
import { TEAM_AI_EXTENSION_NAMESPACE } from "../../src/copilot/catalog.js";
import { CopilotClient } from "../../src/copilot/cli.js";
import { copilotConfigPath, copilotSettingsPath, installedPluginsRoot, registerMarketplaceState } from "../../src/copilot/user-state.js";
import { createDirectoryLink, createGitRepo, prepareFakePublishedAuthority, tempDir } from "../helpers/test-utils.js";
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
  test("recovers public CLI Plugin install and role-disable checkpoints after config-save failures", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-fallback-plugin-checkpoint-home-");
    const marketplace = await createMarketplace();
    const client = new FallbackCopilotClient(home, () => new Date("2026-09-15T00:00:00.000Z"));
    const lockPath = path.join(home, ".teamai", "config.yaml.lock");
    const base = {
      cwd: repo,
      homeDir: home,
      copilot: client,
      copilotMode: "fallback" as const,
      vscodeAvailable: async () => true,
      out: () => undefined,
      err: () => undefined,
    };
    const install = client.installPlugin.bind(client);
    vi.spyOn(client, "installPlugin").mockImplementation(async (spec) => {
      await install(spec);
      if (spec === "common@fallback-teamai") await writeFile(lockPath, "injected completion checkpoint failure", "utf8");
    });
    expect(await runCli(["init", "--marketplace", marketplace, "--role", "api"], base)).toBe(1);
    const pendingInstall = await readGlobalConfig(home);
    expect(pendingInstall?.pendingPluginMutation).toMatchObject({ spec: "common@fallback-teamai", action: "install" });
    expect(pendingInstall?.managedPlugins).not.toContain("common@fallback-teamai");
    await expect(readFile(path.join(installedPluginsRoot(home), "fallback-teamai", "common", "plugin.json"), "utf8")).resolves.toContain('"name":"common"');
    await unlink(lockPath);
    expect(await runCli(["sync"], base)).toBe(0);
    const recoveredInstall = await readGlobalConfig(home);
    expect(recoveredInstall?.pendingPluginMutation).toBeUndefined();
    expect(recoveredInstall?.managedPlugins).toContain("common@fallback-teamai");
    expect(recoveredInstall?.managedPluginReceipts?.some((receipt) => receipt.spec === "common@fallback-teamai" && receipt.enabled)).toBe(true);

    const disable = client.disablePlugin.bind(client);
    vi.spyOn(client, "disablePlugin").mockImplementation(async (spec) => {
      await disable(spec);
      if (spec === "api@fallback-teamai") await writeFile(lockPath, "injected role checkpoint failure", "utf8");
    });
    expect(await runCli(["role", "set", "qa"], base)).toBe(1);
    const pendingDisable = await readGlobalConfig(home);
    expect(pendingDisable?.role).toBe("qa");
    expect(pendingDisable?.pendingPluginMutation).toMatchObject({ spec: "api@fallback-teamai", action: "disable" });
    await unlink(lockPath);
    expect(await runCli(["sync"], base)).toBe(0);
    const recoveredDisable = await readGlobalConfig(home);
    expect(recoveredDisable?.pendingPluginMutation).toBeUndefined();
    expect(recoveredDisable?.managedPluginReceipts?.find((receipt) => receipt.spec === "api@fallback-teamai")?.enabled).toBe(false);
  }, 60_000);

  test("reads Copilot-managed config.json with a comment header", async () => {
    const home = await tempDir("teamai-fallback-commented-config-");
    const configPath = copilotConfigPath(home);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '// User settings belong in settings.json.\n// This file is managed automatically.\n{\n  "installedPlugins": []\n}\n', "utf8");

    const client = new FallbackCopilotClient(home, () => new Date("2026-09-15T00:00:00.000Z"));
    await expect(client.listPlugins()).resolves.toEqual([]);
  });

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
    const repairErrors: string[] = [];
    expect(await runCli(["sync"], { ...base, err: (message) => repairErrors.push(message) }), repairErrors.join("\n")).toBe(0);
    expect(JSON.parse(await readFile(configPath, "utf8")).installedPlugins.some((item: { name: string }) => item.name === "qa")).toBe(true);
    expect(await runCli(["doctor"], base)).toBe(0);
    const vscode = await readFile(vscodePath, "utf8");
    expect(vscode).toContain("// keep");
    expect(vscode.indexOf(marketplace)).toBeLessThan(vscode.indexOf("existing"));
  }, 30_000);

  test("projects set delivers project Plugin components into the workspace only", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-fallback-project-plugin-home-");
    const marketplace = await createMarketplace();
    const pluginRoot = path.join(marketplace, "plugins", "payments");
    const pluginRootToken = "$" + "{PLUGIN_ROOT}";
    await mkdir(path.join(pluginRoot, "com.github.copilot", "agents"), { recursive: true });
    await mkdir(path.join(pluginRoot, "com.github.copilot", "rules"), { recursive: true });
    await mkdir(path.join(pluginRoot, "skills", "payments-scope"), { recursive: true });
    await mkdir(path.join(pluginRoot, "com.github.copilot", "hooks"), { recursive: true });
    await writeFile(path.join(pluginRoot, "com.github.copilot", "agents", "project-probe.agent.md"), "---\nname: payments-project-probe\ndescription: Project Agent probe\n---\n\nTEAMAI_PROJECT_AGENT\n", "utf8");
    await writeFile(path.join(pluginRoot, "com.github.copilot", "rules", "project-probe.instructions.md"), "---\nname: Payments Rule\ndescription: Project Rule probe\napplyTo: \"**\"\n---\n\nTEAMAI_PROJECT_RULE\n", "utf8");
    await writeFile(path.join(pluginRoot, "skills", "payments-scope", "SKILL.md"), "---\nname: payments-scope\ndescription: Project Skill probe\n---\n\nTEAMAI_PROJECT_SKILL\n", "utf8");
    await writeFile(path.join(marketplace, "skills.yaml"), "version: 1\nskills:\n  payments-scope:\n    owner: teamai\n    tags: []\n", "utf8");
    await writeFile(path.join(pluginRoot, "com.github.copilot", "hooks", "hooks.json"), JSON.stringify({
      version: 1,
      hooks: { sessionStart: [{ type: "command", command: 'node "' + pluginRootToken + '/com.github.copilot/hooks/probe.mjs"', timeoutSec: 10 }] },
    }), "utf8");
    await writeFile(path.join(pluginRoot, "com.github.copilot", "hooks", "probe.mjs"), "process.stdout.write('TEAMAI_PROJECT_HOOK');\n", "utf8");
    await writeFile(path.join(pluginRoot, "mcp.json"), JSON.stringify({
      mcpServers: { paymentsProbe: { type: "stdio", command: "node", args: [pluginRootToken + "/mcp-server.mjs"], cwd: pluginRootToken } },
    }), "utf8");
    await writeFile(path.join(pluginRoot, "mcp-server.mjs"), "process.stdout.write('TEAMAI_PROJECT_MCP');\n", "utf8");
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
    expect(await runCli(["--dry-run", "projects", "set", "payments"], base)).toBe(0);
    await expect(readFile(path.join(installedPluginsRoot(home), "fallback-teamai", "payments", "plugin.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const occupiedAgent = path.join(repo, ".github", "agents", "payments-payments-project-probe.agent.md");
    await mkdir(path.dirname(occupiedAgent), { recursive: true });
    await writeFile(occupiedAgent, "user-owned collision\n", "utf8");
    expect(await runCli(["projects", "set", "payments"], base)).toBe(1);
    await expect(readFile(occupiedAgent, "utf8")).resolves.toBe("user-owned collision\n");
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "payments", "project-probe.instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "hooks", "teamai-payments-payments.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(installedPluginsRoot(home), "fallback-teamai", "payments", "plugin.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await unlink(occupiedAgent);

    expect(await runCli(["projects", "set", "payments"], base)).toBe(0);
    await expect(readFile(path.join(repo, ".github", "agents", "payments-payments-project-probe.agent.md"), "utf8")).resolves.toContain("TEAMAI_PROJECT_AGENT");
    await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "payments", "project-probe.instructions.md"), "utf8")).resolves.toContain("TEAMAI_PROJECT_RULE");
    await expect(readFile(path.join(repo, ".github", "skills", "payments-scope", "SKILL.md"), "utf8")).resolves.toContain("TEAMAI_PROJECT_SKILL");
    const hook = JSON.parse(await readFile(path.join(repo, ".github", "hooks", "teamai-payments-payments.json"), "utf8"));
    expect(hook.version).toBe(1);
    const hookCommand = hook.hooks.sessionStart[0].command as string;
    const hookPath = hookCommand.match(/"([^"]+\.mjs)"/)?.[1];
    expect(hookPath).toBeDefined();
    expect(path.isAbsolute(hookPath!)).toBe(true);
    await expect(readFile(hookPath!, "utf8")).resolves.toContain("TEAMAI_PROJECT_HOOK");
    const mcp = JSON.parse(await readFile(path.join(repo, ".mcp.json"), "utf8"));
    const mcpScript = mcp.mcpServers.paymentsProbe.args[0] as string;
    expect(path.isAbsolute(mcpScript)).toBe(true);
    expect(path.isAbsolute(mcp.mcpServers.paymentsProbe.cwd)).toBe(true);
    await expect(readFile(mcpScript, "utf8")).resolves.toContain("TEAMAI_PROJECT_MCP");

    const globalConfig = await readGlobalConfig(home);
    expect(globalConfig?.managedPlugins).not.toContain("payments@fallback-teamai");
    expect(globalConfig?.managedPlugins).toContain("api@fallback-teamai");
    const copilotState = JSON.parse(await readFile(copilotConfigPath(home), "utf8"));
    expect(copilotState.installedPlugins.some((plugin: { name: string }) => plugin.name === "payments")).toBe(false);
    const globalSettings = JSON.parse(await readFile(copilotSettingsPath(home), "utf8"));
    expect(globalSettings.enabledPlugins["payments@fallback-teamai"]).toBeUndefined();
    await expect(readFile(path.join(repo, ".github", "copilot", "settings.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  test("unbind removes only owned Project components and preserves user MCP entries and same-name user packages", async () => {
    const repo = await createGitRepo();
    const home = await tempDir("teamai-fallback-unowned-project-plugin-home-");
    const marketplace = await createMarketplace();
    const pluginRoot = path.join(marketplace, "plugins", "payments");
    const pluginRootToken = "$" + "{PLUGIN_ROOT}";
    await mkdir(path.join(pluginRoot, "com.github.copilot", "agents"), { recursive: true });
    await mkdir(path.join(pluginRoot, "com.github.copilot", "rules"), { recursive: true });
    await mkdir(path.join(pluginRoot, "com.github.copilot", "hooks"), { recursive: true });
    await mkdir(path.join(pluginRoot, "skills", "payments-scope"), { recursive: true });
    await writeFile(path.join(pluginRoot, "com.github.copilot", "agents", "probe.agent.md"), "TEAMAI_PROJECT_AGENT\n", "utf8");
    await writeFile(path.join(pluginRoot, "com.github.copilot", "rules", "probe.instructions.md"), "TEAMAI_PROJECT_RULE\n", "utf8");
    await writeFile(path.join(pluginRoot, "skills", "payments-scope", "SKILL.md"), "---\nname: payments-scope\ndescription: Project Skill probe\n---\n", "utf8");
    await writeFile(path.join(marketplace, "skills.yaml"), "version: 1\nskills:\n  payments-scope:\n    owner: teamai\n    tags: []\n", "utf8");
    await writeFile(path.join(pluginRoot, "com.github.copilot", "hooks", "hooks.json"), JSON.stringify({ version: 1, hooks: { sessionStart: [] } }), "utf8");
    await writeFile(path.join(pluginRoot, "mcp.json"), JSON.stringify({ mcpServers: { paymentsProbe: { type: "stdio", command: "node", args: [pluginRootToken + "/mcp-server.mjs"], cwd: pluginRootToken } } }), "utf8");
    await writeFile(path.join(pluginRoot, "mcp-server.mjs"), "TEAMAI_PROJECT_MCP\n", "utf8");
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
    const userPackage = path.join(installedPluginsRoot(home), "fallback-teamai", "payments");
    await mkdir(userPackage, { recursive: true });
    const userOwnedManifest = JSON.stringify({ name: "payments", version: "9.9.9", userOwned: true, extensions: { "com.company.teamai": { kind: "project" } } });
    await writeFile(path.join(userPackage, "plugin.json"), userOwnedManifest, "utf8");
    await writeFile(path.join(userPackage, "user-marker.txt"), "preserve this package", "utf8");
    await writeFile(path.join(repo, ".mcp.json"), '{\n  // user entry\n  "mcpServers": { "userServer": { "command": "node", "args": ["user.mjs"] } }\n}\n', "utf8");
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
    expect(await runCli(["projects", "set", "payments"], base)).toBe(0);
    expect(output.some((line) => line.includes("user-level Plugin with the same name is installed"))).toBe(true);
    await expect(readFile(path.join(userPackage, "plugin.json"), "utf8")).resolves.toBe(userOwnedManifest);
    await expect(readFile(path.join(userPackage, "user-marker.txt"), "utf8")).resolves.toBe("preserve this package");

    const userInstruction = path.join(repo, ".github", "instructions", "teamai", "payments", "user-added.instructions.md");
    const userDocument = path.join(repo, ".teamai", "context", "payments", "docs", "user-added.md");
    await mkdir(path.dirname(userInstruction), { recursive: true });
    await mkdir(path.dirname(userDocument), { recursive: true });
    await writeFile(userInstruction, "personal instruction\n", "utf8");
    await writeFile(userDocument, "personal document\n", "utf8");
    expect(await runCli(["sync"], base)).toBe(0);
    await expect(readFile(userInstruction, "utf8")).resolves.toBe("personal instruction\n");
    await expect(readFile(userDocument, "utf8")).resolves.toBe("personal document\n");
    const projectRule = path.join(repo, ".github", "instructions", "teamai", "payments", "probe.instructions.md");
    await writeFile(projectRule, "user edited rule\n", "utf8");

    expect(await runCli(["projects", "set"], base)).toBe(0);
    await expect(readFile(path.join(repo, ".github", "agents", "payments-payments-probe.agent.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".github", "skills", "payments-scope", "SKILL.md"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(repo, ".teamai", "project-components", "payments", "payments", "mcp-server.mjs"))).rejects.toMatchObject({ code: "ENOENT" });
    const remainingMcp = await readFile(path.join(repo, ".mcp.json"), "utf8");
    expect(remainingMcp).toContain("// user entry");
    expect(remainingMcp).toContain("userServer");
    expect(remainingMcp).not.toContain("paymentsProbe");
    await expect(readFile(projectRule, "utf8")).resolves.toBe("user edited rule\n");
    await expect(readFile(path.join(userPackage, "plugin.json"), "utf8")).resolves.toBe(userOwnedManifest);
    await expect(readFile(userInstruction, "utf8")).resolves.toBe("personal instruction\n");
    await expect(readFile(userDocument, "utf8")).resolves.toBe("personal document\n");
  }, 30_000);

  test("preflights malformed Project Hook and MCP declarations before writing Workspace files", async () => {
    for (const malformed of ["hook", "mcp"] as const) {
      const repo = await createGitRepo();
      const home = await tempDir(`teamai-fallback-invalid-${malformed}-home-`);
      const marketplace = await createMarketplace();
      const pluginRoot = path.join(marketplace, "plugins", "payments");
      if (malformed === "hook") {
        await mkdir(path.join(pluginRoot, "com.github.copilot", "hooks"), { recursive: true });
        await writeFile(path.join(pluginRoot, "com.github.copilot", "hooks", "hooks.json"), JSON.stringify({ version: 1, hooks: { sessionStart: "bad" } }), "utf8");
      } else {
        await writeFile(path.join(pluginRoot, "mcp.json"), JSON.stringify({ mcpServers: { paymentsProbe: null } }), "utf8");
      }
      await mkdir(path.join(marketplace, "manifest"), { recursive: true });
      await writeFile(path.join(marketplace, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payments\n    owners: [teamai]\n    plugin: payments\n", "utf8");
      const errors: string[] = [];
      const base = {
        cwd: repo,
        homeDir: home,
        copilot: new CopilotClient("teamai-command-that-does-not-exist"),
        vscodeAvailable: async () => true,
        out: () => undefined,
        err: (line: string) => errors.push(line),
      };
      try {
        expect(await runCli(["init", "--marketplace", marketplace, "--role", "api"], base)).toBe(0);
        expect(await runCli(["sync"], base)).toBe(0);
        expect(await runCli(["projects", "set", "payments"], base)).toBe(1);
        expect(errors.join("\n")).toContain(malformed === "hook" ? "each event must map to an array" : "expected a server object");
        await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(repo, ".teamai", "context", "shared", "learnings", "test.md"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(repo, ".mcp.json"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(repo, ".github", "agents", "payments-payments-probe.agent.md"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await Promise.all([repo, home, marketplace].map((root) => rm(root, { recursive: true, force: true })));
      }
    }
  }, 90_000);

  test("rejects Agent and Rule sources beneath Plugin ancestor junctions", async () => {
    for (const kind of ["agent", "rule"] as const) {
      const repo = await createGitRepo();
      const home = await tempDir(`teamai-fallback-source-${kind}-junction-home-`);
      const marketplace = await createMarketplace();
      const pluginRoot = path.join(marketplace, "plugins", "payments");
      const externalRoot = path.join(marketplace, `.external-${kind}`);
      const copilotRoot = path.join(pluginRoot, "com.github.copilot");
      if (kind === "agent") {
        await mkdir(path.join(externalRoot, "agents"), { recursive: true });
        await writeFile(path.join(externalRoot, "agents", "probe.agent.md"), "junctioned agent\n", "utf8");
        await createDirectoryLink(externalRoot, copilotRoot);
      } else {
        await mkdir(copilotRoot, { recursive: true });
        await mkdir(externalRoot, { recursive: true });
        await writeFile(path.join(externalRoot, "probe.instructions.md"), "junctioned rule\n", "utf8");
        await createDirectoryLink(externalRoot, path.join(copilotRoot, "rules"));
      }
      await mkdir(path.join(marketplace, "manifest"), { recursive: true });
      await writeFile(path.join(marketplace, "manifest", "projects.yaml"), "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payments\n    owners: [teamai]\n    plugin: payments\n", "utf8");
      const errors: string[] = [];
      const base = {
        cwd: repo,
        homeDir: home,
        copilot: new CopilotClient("teamai-command-that-does-not-exist"),
        vscodeAvailable: async () => true,
        out: () => undefined,
        err: (line: string) => errors.push(line),
      };
      try {
        expect(await runCli(["init", "--marketplace", marketplace, "--role", "api"], base)).toBe(0);
        expect(await runCli(["sync"], base)).toBe(0);
        expect(await runCli(["projects", "set", "payments"], base)).toBe(1);
        expect(errors.join("\n")).toContain("Unsafe Project Plugin source path");
        await expect(readFile(path.join(repo, ".github", "instructions", "teamai", "context.instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(repo, ".teamai", "context", "shared", "learnings", "test.md"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(repo, ".github", "agents", "payments-payments-probe.agent.md"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await Promise.all([repo, home, marketplace].map((root) => rm(root, { recursive: true, force: true })));
      }
    }
  }, 90_000);

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
