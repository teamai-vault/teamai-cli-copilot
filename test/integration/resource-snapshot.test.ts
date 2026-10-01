import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { createConfig, } from "../../src/config/schema.js";
import { runCli } from "../../src/cli.js";
import { writeGlobalConfig } from "../../src/config/global.js";
import { copilotConfigPath, copilotSettingsPath } from "../../src/copilot/user-state.js";
import { personalSkillPath } from "../../src/copilot/skills.js";
import type { MarketplaceCatalog } from "../../src/copilot/catalog.js";
import { CopilotClient } from "../../src/copilot/cli.js";
import { createGitRepo, createFakeCopilot, loadFakeMarketplace, tempDir, TEST_MARKETPLACE_NAME, TEST_MARKETPLACE_SOURCE } from "../helpers/test-utils.js";

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (value: string) => stdout.push(value), err: (value: string) => stderr.push(value) };
}

describe("resource snapshot CLI", () => {
  test("status and doctor JSON share the same snapshot and report preserved overrides", async () => {
    const cwd = await createGitRepo();
    const homeDir = await tempDir("teamai-resource-json-home-");
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    config.managedPlugins = [`api@${TEST_MARKETPLACE_NAME}`];
    await writeGlobalConfig(config, homeDir);
    await mkdir(path.dirname(copilotConfigPath(homeDir)), { recursive: true });
    const commonCache = path.join(homeDir, "native-plugin-cache", "common");
    await mkdir(commonCache, { recursive: true });
    await writeFile(path.join(commonCache, "plugin.json"), JSON.stringify({ name: "common", version: "0.1.0" }), "utf8");
    await writeFile(copilotConfigPath(homeDir), JSON.stringify({ installedPlugins: [
      { name: "common", marketplace: TEST_MARKETPLACE_NAME, version: "0.1.0", enabled: false, source: `marketplace:${TEST_MARKETPLACE_NAME}`, cache_path: commonCache },
      { name: "api", marketplace: TEST_MARKETPLACE_NAME, version: "0.1.0", enabled: true },
    ] }), "utf8");
    await writeFile(copilotSettingsPath(homeDir), JSON.stringify({ enabledPlugins: {
      [`common@${TEST_MARKETPLACE_NAME}`]: false,
      [`api@${TEST_MARKETPLACE_NAME}`]: true,
    } }), "utf8");
    const fake = await createFakeCopilot();
    const overrides = { cwd, homeDir, copilot: fake.client, loadMarketplace: async () => loadFakeMarketplace(), };
    const statusOutput = capture();
    const resourceList = capture();
    const doctorOutput = capture();
    const textDoctorOutput = capture();

    expect(await runCli(["status", "--resources"], { ...overrides, out: resourceList.out, err: resourceList.err })).toBe(0);
    expect(await runCli(["status", "--json"], { ...overrides, out: statusOutput.out, err: statusOutput.err })).toBe(0);
    expect(await runCli(["doctor", "--json"], { ...overrides, out: doctorOutput.out, err: doctorOutput.err })).toBe(1);
    await runCli(["doctor"], { ...overrides, out: textDoctorOutput.out, err: textDoctorOutput.err });

    const status = JSON.parse(statusOutput.stdout.join("\n"));
    const doctor = JSON.parse(doctorOutput.stdout.join("\n"));
    expect(doctor.resources).toEqual(status.resources);
    expect(doctor.diagnostics).not.toEqual(status.diagnostics);
    expect(doctor.diagnostics.some((diagnostic: { code: string; message: string }) =>
      diagnostic.code === "DOCTOR_ERROR" && diagnostic.message.includes("VS Code Marketplace registration is missing or not first"),
    )).toBe(true);
    expect(doctorOutput.stdout).toHaveLength(1);
    expect(statusOutput.stderr).toEqual([]);
    expect(doctorOutput.stderr).toEqual([]);
    expect(resourceList.stdout[0]).toBe("Team AI resources");
    const commonText = resourceList.stdout.find((line) => line.includes("plugin common@" + TEST_MARKETPLACE_NAME))!;
    expect(commonText).toContain("source-revision=");
    expect(commonText).toContain("target=");
    expect(commonText).toContain("reasons=");
    const common = status.resources.find((resource: { pluginSpec?: string }) => resource.pluginSpec === `common@${TEST_MARKETPLACE_NAME}`);
    expect(common.owned).toBe(false);
    expect(common.configuredActive).toBe(false);
    expect(common.delivery).toBe("present");
    expect(common.reasons).toContain("USER_OVERRIDE");
    const api = status.resources.find((resource: { pluginSpec?: string }) => resource.pluginSpec === `api@${TEST_MARKETPLACE_NAME}`);
    expect(api.owned).toBe(true);
    expect(api.configuredActive).toBe(true);
    expect(status.diagnostics.some((diagnostic: { code: string; resourceId?: string }) => diagnostic.code === "CONFIGURATION_MISMATCH" && diagnostic.resourceId === api.id)).toBe(false);
    expect(status.diagnostics.some((diagnostic: { code: string; message: string }) => diagnostic.code === "USER_OVERRIDE" && !diagnostic.message.includes("sync"))).toBe(true);
    const overrideText = textDoctorOutput.stdout.find((line) => line.includes(`common@${TEST_MARKETPLACE_NAME} is user-owned`));
    expect(overrideText).toBeDefined();
    expect(overrideText).not.toContain("Run teamai sync");
    expect(textDoctorOutput.stdout.some((line) => line.includes(`api@${TEST_MARKETPLACE_NAME} has incorrect configured enablement`))).toBe(false);
  }, 15_000);

  test("reports a missing Plugin Skill file separately from its managed personal fallback", async () => {
    const started = performance.now();
    const cwd = await tempDir("teamai-resource-skill-cwd-");
    const homeDir = await tempDir("teamai-resource-skill-home-");
    const source = await tempDir("teamai-resource-skill-source-");
    const cache = path.join(source, "cache", "api");
    const skillRoot = path.join(source, "plugins", "api", "skills", "api-review");
    const target = personalSkillPath(homeDir, "api-review");
    await mkdir(skillRoot, { recursive: true });
    await writeFile(path.join(skillRoot, "SKILL.md"), "---\nname: api-review\n---\n", "utf8");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "SKILL.md"), "---\nname: api-review\n---\n", "utf8");
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, "plugin.json"), JSON.stringify({ name: "api", version: "0.1.0" }), "utf8");
    const config = createConfig({ name: TEST_MARKETPLACE_NAME, source: TEST_MARKETPLACE_SOURCE });
    config.role = "api";
    config.managedPlugins = [`api@${TEST_MARKETPLACE_NAME}`];
    config.managedSkills = ["api-review"];
    config.managedSkillPaths = { "api-review": target };
    await writeGlobalConfig(config, homeDir);
    await mkdir(path.dirname(copilotConfigPath(homeDir)), { recursive: true });
    await writeFile(copilotConfigPath(homeDir), JSON.stringify({ installedPlugins: [
      { name: "common", marketplace: TEST_MARKETPLACE_NAME, version: "0.1.0", enabled: true },
      { name: "api", marketplace: TEST_MARKETPLACE_NAME, version: "0.1.0", enabled: true, cache_path: cache },
    ] }), "utf8");
    await writeFile(copilotSettingsPath(homeDir), JSON.stringify({ enabledPlugins: {
      [`common@${TEST_MARKETPLACE_NAME}`]: true,
      [`api@${TEST_MARKETPLACE_NAME}`]: true,
    } }), "utf8");
    const catalog: MarketplaceCatalog = {
      name: TEST_MARKETPLACE_NAME, root: source, revision: "fixed-skill-observation-fixture",
      plugins: [
        { name: "common", version: "0.1.0", kind: "common", root: path.join(source, "plugins", "common") },
        { name: "api", version: "0.1.0", kind: "role", root: path.join(source, "plugins", "api") },
      ],
      skills: [{ name: "api-review", description: "API review", sourceType: "plugin" as const, plugin: "api", sourcePath: "plugins/api/skills/api-review", root: skillRoot, owner: "api", tags: [], standalone: true }],
      dispose: async () => {},
    };
    const nativeCalls: string[] = [];
    const client = new CopilotClient("readonly-native-must-not-run");
    for (const method of ["version", "listPlugins", "listMarketplaces", "addMarketplace", "removeMarketplace", "installPlugin", "enablePlugin", "disablePlugin", "updatePlugin"] as const) {
      client[method] = async () => { nativeCalls.push(method); throw new Error("readonly native call"); };
    }
    const output = capture();
    const setupMs = performance.now() - started;
    const commandStarted = performance.now();

    expect(await runCli(["status", "--json"], {
      cwd,
      homeDir,
      copilot: client,
      loadMarketplace: async () => catalog,
      out: output.out,
      err: output.err,
    })).toBe(0);
    const snapshot = JSON.parse(output.stdout[0]);
    const pluginSkill = snapshot.resources.find((resource: { kind: string; name: string; scope: string }) =>
      resource.kind === "skill" && resource.name === "api-review" && resource.scope === "plugin",
    );
    const personalSkill = snapshot.resources.find((resource: { kind: string; name: string; scope: string }) =>
      resource.kind === "skill" && resource.name === "api-review" && resource.scope === "user",
    );
    expect(pluginSkill.delivery).toBe("missing");
    expect(pluginSkill.targetPath).toBe(path.join(cache, "skills", "api-review", "SKILL.md"));
    expect(personalSkill.delivery).toBe("present");
    expect(personalSkill.owned).toBe(true);
    expect(nativeCalls).toEqual([]);
    console.info("Snapshot timings", JSON.stringify({ setupMs, commandMs: performance.now() - commandStarted }));
  });

  test("JSON usage errors remain a single object on stdout", async () => {
    const output = capture();
    expect(await runCli(["status", "--json", "--unknown"], { ...output })).toBe(2);
    expect(output.stdout).toHaveLength(1);
    expect(output.stderr).toEqual([]);
    expect(JSON.parse(output.stdout[0])).toEqual({
      schemaVersion: 1,
      error: { code: "USAGE_ERROR", message: "Unknown option '--unknown' for 'status'." },
    });
  });
});
