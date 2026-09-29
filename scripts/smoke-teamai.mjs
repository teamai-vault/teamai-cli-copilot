#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

try {
  runRoot = await mkdtemp(path.join(os.tmpdir(), "teamai-real-e2e-"));
  const profile = path.join(runRoot, "profile");
  repository = path.join(runRoot, "repository");
  const copilotHome = path.join(profile, ".copilot");
  const cacheHome = path.join(profile, ".cache");
  const appData = path.join(profile, "AppData", "Roaming");
  const localAppData = path.join(profile, "AppData", "Local");
  await Promise.all([repository, copilotHome, cacheHome, appData, localAppData].map((directory) => mkdir(directory, { recursive: true })));
  env = {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    COPILOT_HOME: copilotHome,
    COPILOT_CACHE_HOME: cacheHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
  delete env.COPILOT_GITHUB_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;

  await run("git", ["init", "-b", "main"]);
  await run("git", ["config", "user.email", "teamai@example.invalid"]);
  await run("git", ["config", "user.name", "Team AI Test"]);
  await writeFile(path.join(repository, "README.md"), "# test\n", "utf8");
  await run("git", ["add", "README.md"]);
  await run("git", ["commit", "-m", "initial"]);

  const cli = path.join(cliRoot, "dist", "cli.js");
  await run(process.execPath, [cli, "init", "--marketplace", marketplaceRoot, "--role", "api"]);
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

  const installed = JSON.parse((await runCopilot(["plugins", "list", "--kind", "plugin", "--json"])).stdout).plugins;
  for (const name of ["common", "api", "ios", "aos", "qa", "design"]) {
    assert.ok(installed.some((item) => item.name === name), `${name}@teamai should be installed`);
  }
  assert.equal(installed.find((item) => item.name === "common").enabled, true);
  assert.equal(installed.find((item) => item.name === "qa").enabled, true);
  for (const name of ["api", "ios", "aos", "design"]) {
    assert.equal(installed.find((item) => item.name === name).enabled, false);
  }

  const instructions = JSON.parse((await runCopilot(["plugins", "list", "--kind", "instruction", "--json"])).stdout);
  const contextInstructions = instructions.plugins.filter((item) => item.name === "context.instructions.md" && item.scope === "working-directory" && item.source === "working-directory");
  assert.equal(contextInstructions.length, 2, "Native Copilot should list both working-directory context instructions.");

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

  console.log(`Real teamai native Copilot E2E passed on ${process.platform}.`);
} finally {
  if (runRoot) await rm(runRoot, { recursive: true, force: true });
}
