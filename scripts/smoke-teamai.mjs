#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { parse } from "jsonc-parser";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceRoot = process.env.TEAM_AI_E2E_MARKETPLACE_ROOT
  ? path.resolve(process.env.TEAM_AI_E2E_MARKETPLACE_ROOT)
  : path.resolve(cliRoot, "..", "teamai-marketplace");
let runRoot;
let repository;
let env;

async function run(command, args, cwd = repository) {
  try {
    return await exec(command, args, { cwd, env, windowsHide: true });
  } catch (error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  }
}

async function runCopilot(args) {
  return process.platform === "win32"
    ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "copilot", ...args])
    : await run("copilot", args);
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function parseNativeConfig(text, label) {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });
  assert.equal(errors.length, 0, `${label} must contain valid JSONC.`);
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} must contain an object.`);
  return value;
}

function assertSkillPath(skills, name, expected, source, label) {
  assert.ok(Array.isArray(skills), "Native skill listing must be an array.");
  assert.ok(skills.some((skill) => skill.name === name && skill.source === source && skill.enabled === true && typeof skill.path === "string" && normalizedPath(skill.path) === normalizedPath(expected)), `${label} was not discovered at ${expected}`);
}

function enabledPluginSkill(skills, name, expectedPath) {
  assert.ok(Array.isArray(skills), "Native skill listing must be an array.");
  const skill = skills.find((item) => item.name === name && item.source === "plugin" && item.enabled === true && typeof item.path === "string");
  assert.ok(skill, `Enabled Plugin Skill '${name}' was not discovered.`);
  assert.equal(normalizedPath(skill.path), normalizedPath(expectedPath), `Enabled Plugin Skill '${name}' did not use the installed Marketplace source.`);
  return skill;
}

async function assertProjectNotInstalled(plugins, userSettings, copilotHome) {
  // Native inventory includes disabled catalog discoveries before installation.
  assert.ok(plugins.filter((item) => item.name === "teamai-project").every((item) => item.enabled === false), "Project Plugin source must not be enabled as a user Plugin.");
  assert.equal(userSettings.enabledPlugins?.["teamai-project@teamai"], undefined, "Project selection must not change user Plugin enablement.");
  const configText = await readFile(path.join(copilotHome, "config.json"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  const userConfig = parseNativeConfig(configText, "Native Copilot config.json");
  assert.ok(!(userConfig.installedPlugins ?? []).some((item) => item.name === "teamai-project"), "Project Plugin source must not have a user installation record.");
  await assert.rejects(lstat(path.join(copilotHome, "installed-plugins", "teamai", "teamai-project")), { code: "ENOENT" }, "Project Plugin source must not have an installed package directory.");
}

try {
  runRoot = await mkdtemp(path.join(os.tmpdir(), "teamai-real-e2e-"));
  const profile = path.join(runRoot, "profile");
  repository = path.join(runRoot, "repository");
  const copilotHome = path.join(profile, ".copilot");
  const cacheHome = path.join(profile, ".cache");
  const appData = path.join(profile, "AppData", "Roaming");
  const localAppData = path.join(profile, "AppData", "Local");
  const temp = path.join(runRoot, "temp");
  await Promise.all([repository, copilotHome, cacheHome, appData, localAppData, temp].map((directory) => mkdir(directory, { recursive: true })));
  env = {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    COPILOT_HOME: copilotHome,
    COPILOT_CACHE_HOME: cacheHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
  };
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  const runtime = await runCopilot(["--version"]);
  await writeFile(path.join(runRoot, "runtime.json"), JSON.stringify({
    platform: process.platform, arch: process.arch, os: os.release(), node: process.version,
    workspaceRoot: repository, marketplaceRoot, command: "copilot", argv: ["--version"],
    stdout: runtime.stdout, stderr: runtime.stderr,
    profile, copilotHome, cacheHome, appData, localAppData, temp,
  }, null, 2), "utf8");

  await run("git", ["init", "-b", "main"]);
  await run("git", ["config", "user.email", "teamai@example.invalid"]);
  await run("git", ["config", "user.name", "Team AI Test"]);
  await writeFile(path.join(repository, "README.md"), "# test\n", "utf8");
  await run("git", ["add", "README.md"]);
  await run("git", ["commit", "-m", "initial"]);

  const cli = path.join(cliRoot, "dist", "cli.js");
  await run(process.execPath, [cli, "init", "--marketplace", marketplaceRoot, "--role", "api"]);
  await run(process.execPath, [cli, "sync"]);
  await run(process.execPath, [cli, "projects", "set", "teamai"]);
  await run(process.execPath, [cli, "skill", "install", "release-helper"]);
  await run(process.execPath, [cli, "role", "set", "qa"]);
  await run(process.execPath, [cli, "sync"]);
  await run(process.execPath, [cli, "--dry-run", "sync"]);
  await run(process.execPath, [cli, "status"]);
  await run(process.execPath, [cli, "doctor"]);

  const projectedInstruction = path.join(repository, ".github", "instructions", "teamai", "teamai", "context.instructions.md");
  const sourceInstruction = path.join(marketplaceRoot, "contexts", "teamai", "instructions", "context.instructions.md");
  assert.deepEqual(await readFile(projectedInstruction), await readFile(sourceInstruction));
  await assert.doesNotReject(readFile(path.join(repository, ".teamai", "context", "teamai", "docs", "architecture.md"), "utf8"));

  const projectPluginPath = path.join(marketplaceRoot, "plugins", "teamai-project");
  const projectAgent = path.join(repository, ".github", "agents", "teamai-teamai-project-teamai-project-probe.agent.md");
  const sourceAgent = path.join(projectPluginPath, "com.github.copilot", "agents", "teamai-project-probe.agent.md");
  assert.deepEqual(await readFile(projectAgent), await readFile(sourceAgent));
  const projectRule = path.join(repository, ".github", "instructions", "teamai", "teamai", "teamai-project-probe.instructions.md");
  const sourceRule = path.join(projectPluginPath, "com.github.copilot", "rules", "teamai-project-probe.instructions.md");
  assert.deepEqual(await readFile(projectRule), await readFile(sourceRule));
  const projectSkill = path.join(repository, ".github", "skills", "teamai-project-scope-probe", "SKILL.md");
  const sourceSkill = path.join(projectPluginPath, "skills", "teamai-project-scope-probe", "SKILL.md");
  assert.deepEqual(await readFile(projectSkill), await readFile(sourceSkill));

  const hookConfig = JSON.parse(await readFile(path.join(repository, ".github", "hooks", "teamai-teamai-teamai-project.json"), "utf8"));
  const hookRoot = path.join(repository, ".github", "hooks", ".teamai", "teamai", "teamai-project");
  const hookAsset = path.join(hookRoot, "com.github.copilot", "hooks", "teamai-project-hook-probe.mjs");
  const hookCommand = String(hookConfig.hooks.sessionStart[0].command).replaceAll("\\", "/");
  assert.ok(hookCommand.includes(hookAsset.replaceAll("\\", "/")), "Projected Hook must reference its copied workspace script using a native absolute path.");
  await assert.doesNotReject(readFile(hookAsset, "utf8"));

  const projectMcp = JSON.parse(await readFile(path.join(repository, ".mcp.json"), "utf8"));
  const projectMcpServer = projectMcp.mcpServers["teamai-project-probe"];
  const mcpAsset = path.join(repository, ".teamai", "project-components", "teamai", "teamai-project", "mcp-server.mjs");
  assert.ok(path.isAbsolute(projectMcpServer.args[0]), "Projected MCP server must use an absolute workspace path.");
  assert.equal(path.resolve(projectMcpServer.args[0]), path.resolve(mcpAsset));
  assert.equal(path.resolve(projectMcpServer.cwd), path.resolve(path.dirname(mcpAsset)));
  await assert.doesNotReject(readFile(mcpAsset, "utf8"));

  const installed = JSON.parse((await runCopilot(["plugin", "list", "--json"])).stdout);
  assert.ok(Array.isArray(installed), "Native Plugin listing must be an array.");
  const userSettings = parseNativeConfig(await readFile(path.join(copilotHome, "settings.json"), "utf8"), "Native Copilot settings.json");
  for (const name of ["common", "api", "ios", "aos", "qa", "design"]) {
    assert.ok(installed.some((item) => item.name === name), `${name}@teamai should be installed`);
    assert.equal(userSettings.enabledPlugins?.[`${name}@teamai`], name === "common" || name === "qa", `${name}@teamai must have an explicit user installation/enablement choice.`);
  }
  assert.equal(installed.find((item) => item.name === "common").enabled, true);
  assert.equal(installed.find((item) => item.name === "qa").enabled, true);
  for (const name of ["api", "ios", "aos", "design"]) {
    assert.equal(installed.find((item) => item.name === name).enabled, false);
  }
  await assertProjectNotInstalled(installed, userSettings, copilotHome);
  await assert.rejects(readFile(path.join(repository, ".github", "copilot", "settings.json")), { code: "ENOENT" });

  const instructions = JSON.parse((await runCopilot(["instruction", "list", "--json"])).stdout);
  assert.ok(Array.isArray(instructions), "Native instruction listing must be an array.");
  const contextInstructions = instructions.filter((item) => item.label === "context.instructions.md" && item.location === "working-directory");
  assert.equal(contextInstructions.length, 2, "Native Copilot should list both working-directory context instructions.");
  for (const target of [path.join(repository, ".github", "instructions", "teamai", "context.instructions.md"), projectedInstruction]) {
    const matches = contextInstructions.filter((item) => typeof item.sourcePath === "string" && normalizedPath(path.resolve(repository, item.sourcePath)) === normalizedPath(target));
    assert.equal(matches.length, 1, `Native Copilot should discover exactly one context instruction at ${target}.`);
    assert.equal(matches[0].type, "vscode", `Context instruction at ${target} must use the native VS Code instruction type.`);
    assert.equal(matches[0].defaultDisabled, false, `Context instruction at ${target} must be enabled by default.`);
  }

  const skills = JSON.parse((await runCopilot(["skill", "list", "--json"])).stdout);
  assertSkillPath(skills, "teamai", path.join(copilotHome, "skills", "teamai"), "personal-copilot", "Built-in Team AI Skill");
  assertSkillPath(skills, "release-helper", path.join(copilotHome, "skills", "release-helper"), "personal-copilot", "Managed personal Skill");
  const pluginSkillPath = path.join(marketplaceRoot, "plugins", "common", "skills", "code-review");
  const pluginSkill = enabledPluginSkill(skills, "code-review", pluginSkillPath);
  assert.deepEqual(await readFile(path.join(pluginSkill.path, "SKILL.md")), await readFile(path.join(pluginSkillPath, "SKILL.md")));
  await run(process.execPath, [cli, "skill", "remove", "release-helper"]);
  const afterRemoval = JSON.parse((await runCopilot(["skill", "list", "--json"])).stdout);
  assert.ok(!afterRemoval.some((skill) => skill.name === "release-helper" && typeof skill.path === "string" && normalizedPath(skill.path) === normalizedPath(path.join(copilotHome, "skills", "release-helper"))), "Removed personal Skill remains discoverable");
  const pluginSkillAfterRemoval = enabledPluginSkill(afterRemoval, "code-review", pluginSkillPath);
  assert.equal(normalizedPath(pluginSkillAfterRemoval.path), normalizedPath(pluginSkill.path), "Enabled Plugin Skill path changed after personal Skill removal.");

  const vscodeSettings = JSON.parse(await readFile(path.join(appData, "Code", "User", "settings.json"), "utf8"));
  assert.equal(vscodeSettings["chat.plugins.marketplaces"][0], marketplaceRoot);

  console.log(`Native common/role Copilot E2E and Project workspace projection passed on ${process.platform}.`);
} finally {
  if (runRoot) {
    if (process.env.TEAM_AI_E2E_KEEP_ARTIFACTS === "1") console.log(`E2E artifacts retained at ${runRoot}`);
    else await rm(runRoot, { recursive: true, force: true });
  }
}
