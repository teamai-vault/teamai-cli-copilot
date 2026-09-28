#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import spawn from "cross-spawn";
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

async function run(command, args, options) {
  try {
    return await exec(command, args, { windowsHide: true, ...options });
  } catch (error) {
    throw new Error(`${command} ${args.join(" ")} failed: ${error.stderr?.trim() || error.stdout?.trim() || error.message}`);
  }
}

async function runCopilot(args, options) {
  return process.platform === "win32"
    ? await run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", "copilot", ...args], options)
    : await run("copilot", args, options);
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

async function resolveRealCode(env) {
  const candidates = process.env.TEAM_AI_E2E_CODE_BIN
    ? [process.env.TEAM_AI_E2E_CODE_BIN]
    : (await run(process.platform === "win32" ? "where.exe" : "which", ["code"])).stdout.trim().split(/\r?\n/).filter(Boolean);
  for (const candidate of candidates) {
    try {
      const version = await runExecutable(candidate, ["--version"], env);
      if (version.stdout.trim()) return candidate;
    } catch {
      // Try the next PATH candidate. A stale shim is not a usable VS Code CLI.
    }
  }
  throw new Error("Fallback E2E requires TEAM_AI_E2E_CODE_BIN or a working code command on PATH.");
}

async function runExecutable(command, args, env) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

try {
  runRoot = await mkdtemp(path.join(os.tmpdir(), "teamai-fallback-e2e-"));
  const profile = path.join(runRoot, "profile");
  const repository = path.join(runRoot, "repository");
  const appData = path.join(profile, "AppData", "Roaming");
  const localAppData = path.join(profile, "AppData", "Local");
  await Promise.all([repository, appData, localAppData].map((directory) => mkdir(directory, { recursive: true })));
  const gitPath = (await run(process.platform === "win32" ? "where.exe" : "which", ["git"])).stdout.trim().split(/\r?\n/, 1)[0];
  const isolatedEnv = {
    ...process.env,
    HOME: profile,
    USERPROFILE: profile,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
  };
  const codePath = await resolveRealCode(isolatedEnv);
  const fallbackEnv = { ...isolatedEnv, PATH: `${path.dirname(codePath)}${path.delimiter}${path.dirname(gitPath)}` };
  delete fallbackEnv.COPILOT_HOME;

  await run("git", ["init", "-b", "main"], { cwd: repository, env: { ...fallbackEnv, PATH: process.env.PATH } });
  await run("git", ["config", "user.email", "teamai@example.invalid"], { cwd: repository, env: { ...fallbackEnv, PATH: process.env.PATH } });
  await run("git", ["config", "user.name", "Team AI Test"], { cwd: repository, env: { ...fallbackEnv, PATH: process.env.PATH } });
  await writeFile(path.join(repository, "README.md"), "# test\n", "utf8");
  await run("git", ["add", "README.md"], { cwd: repository, env: { ...fallbackEnv, PATH: process.env.PATH } });
  await run("git", ["commit", "-m", "initial"], { cwd: repository, env: { ...fallbackEnv, PATH: process.env.PATH } });

  const cli = path.join(cliRoot, "dist", "cli.js");
  await run(process.execPath, [cli, "init", "--marketplace", marketplaceRoot, "--role", "api"], { cwd: repository, env: fallbackEnv });
  await run(process.execPath, [cli, "role", "set", "qa"], { cwd: repository, env: fallbackEnv });
  await run(process.execPath, [cli, "sync"], { cwd: repository, env: fallbackEnv });
  await run(process.execPath, [cli, "doctor"], { cwd: repository, env: fallbackEnv });

  const configPath = path.join(profile, ".copilot", "config.json");
  const settingsPath = path.join(profile, ".copilot", "settings.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(config.installedPlugins.length, 6);
  assert.ok(config.installedPlugins.every((plugin) => plugin.source_sha === undefined));
  assert.equal(settings.enabledPlugins["common@teamai"], true);
  assert.equal(settings.enabledPlugins["qa@teamai"], true);
  for (const name of ["api", "ios", "aos", "design"]) assert.equal(settings.enabledPlugins[`${name}@teamai`], false);

  const nativeEnv = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: appData };
  delete nativeEnv.COPILOT_HOME;
  const nativePlugins = JSON.parse((await runCopilot(["plugins", "list", "--kind", "plugin", "--json"], { cwd: repository, env: nativeEnv })).stdout).plugins;
  for (const name of ["common", "api", "ios", "aos", "qa", "design"]) {
    assert.ok(nativePlugins.some((plugin) => plugin.name === name), `native Copilot should recognize ${name}@teamai`);
  }
  const nativeSkills = JSON.parse((await runCopilot(["skill", "list", "--json"], { cwd: repository, env: nativeEnv })).stdout);
  const builtInSkill = nativeSkills.find((skill) => skill.name === "teamai" && skill.source === "personal-copilot");
  assert.ok(builtInSkill, "native Copilot should recognize the built-in Team AI Skill");
  assert.equal(normalizedPath(builtInSkill.path), normalizedPath(path.join(profile, ".copilot", "skills", "teamai")));

  console.log(`Fallback materialization and native Copilot recognition passed on ${process.platform}.`);
} finally {
  if (runRoot) await rm(runRoot, { recursive: true, force: true });
}
