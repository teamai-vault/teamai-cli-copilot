#!/usr/bin/env node

// Public CLI joint acceptance. No product internals or hand-written cache/binding.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, lstat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import spawn from "cross-spawn";
import { parse as parseYaml } from "yaml";
import { parse as parseJsonc } from "jsonc-parser";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  assert.ok(["--marketplace", "--artifacts", "--backend", "--root", "--cli-root", "--scenario", "--tarball"].includes(key) && process.argv[i + 1] && !options[key], `Invalid option ${key}`);
  options[key] = process.argv[i + 1];
}
assert.ok(options["--marketplace"] && options["--artifacts"], "Supply --marketplace and a new --artifacts directory.");
const backend = options["--backend"] ?? "native";
const rootMode = options["--root"] ?? "custom";
const scenario = options["--scenario"] ?? "full";
assert.ok(["native", "fallback"].includes(backend) && ["default", "custom"].includes(rootMode));
assert.ok(["full", "delivery"].includes(scenario));
const artifactRoot = path.resolve(options["--artifacts"]);
assert.ok(path.isAbsolute(options["--artifacts"]), "Artifacts must use an absolute path.");
await mkdir(artifactRoot); // Refuse reuse: every failure remains independently retrievable.
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const scriptBytes = await readFile(fileURLToPath(import.meta.url));
await writeFile(path.join(artifactRoot, "script.mjs"), scriptBytes);
const records = [];
const checks = [];
const packageRoot = path.resolve(options["--cli-root"] ?? cliRoot);
const cli = path.join(packageRoot, "dist", "cli.js");
const marketplace = path.resolve(options["--marketplace"]);
const profile = path.join(artifactRoot, "profile");
const copilotRoot = rootMode === "custom" ? path.join(artifactRoot, "custom copilot") : path.join(profile, ".copilot");
const source = path.join(artifactRoot, "source");
const bare = path.join(artifactRoot, "authority.git");
const workA = path.join(artifactRoot, "工作区 A");
const workB = path.join(artifactRoot, "unbound B");
const linked = path.join(artifactRoot, "linked W");
const bin = path.join(artifactRoot, "bin");
const seamState = path.join(artifactRoot, "seam-state.json");
const seamLog = path.join(artifactRoot, "seam.jsonl");
const remote = "https://github.com/joint-fixture/teamai-marketplace.git";
const env = {
  ...process.env, HOME: profile, USERPROFILE: profile,
  APPDATA: path.join(profile, "AppData", "Roaming"), LOCALAPPDATA: path.join(profile, "AppData", "Local"),
  COPILOT_CACHE_HOME: path.join(artifactRoot, "copilot-cache"), TEMP: path.join(artifactRoot, "temp"), TMP: path.join(artifactRoot, "temp"),
  GIT_CONFIG_GLOBAL: path.join(artifactRoot, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_ALLOW_PROTOCOL: "file",
  TEAMAI_JOINT_STATE: seamState, TEAMAI_JOINT_LOG: seamLog, TEAMAI_JOINT_BARE: bare,
  TEAMAI_JOINT_IDENTITY_CONFIG: path.join(artifactRoot, "identity-gitconfig"),
};
for (const key of ["COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "COPILOT_HOME", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
for (const key of Object.keys(env)) if (/^(NODE_OPTIONS|GIT_ASKPASS|SSH_ASKPASS)$|^COPILOT_PROVIDER_|APPROVAL|AUTO.?APPROVE|ALLOW_ALL/i.test(key)) delete env[key];
if (rootMode === "custom") env.COPILOT_HOME = copilotRoot;
for (const directory of [profile, copilotRoot, bin, env.APPDATA, env.LOCALAPPDATA, env.COPILOT_CACHE_HOME, env.TEMP]) await mkdir(directory, { recursive: true });

async function put(file, bytes) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, bytes); }
async function json(file, value) { await put(file, JSON.stringify(value, null, 2) + "\n"); }
async function run(command, args, cwd = artifactRoot, commandEnv = env, expected = 0) {
  const start = new Date().toISOString();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: commandEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (data) => stdout.push(data)); child.stderr.on("data", (data) => stderr.push(data));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
  const record = { start, command, args, cwd, ...result };
  records.push(record); await json(path.join(artifactRoot, "commands", `${String(records.length).padStart(3, "0")}.json`), record);
  if (expected !== null) assert.equal(result.exitCode, expected, `${command} ${args.join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result;
}
const git = async (args, cwd = artifactRoot) => (await run("git", args, cwd)).stdout.trim();
const teamai = (args, cwd = workA, expected = 0, commandEnv = env) => run(process.execPath, [cli, ...args], cwd, commandEnv, expected);
const query = async (args, cwd = workA, expected = 0) => JSON.parse((await teamai(args, cwd, expected)).stdout);
function pass(id, detail) { checks.push({ id, result: "PASS", detail }); console.log(`PASS ${id}: ${detail}`); }
async function tree(root) {
  const entries = [];
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name); const info = await lstat(file);
      const relative = path.relative(root, file).replaceAll("\\", "/");
      if (info.isSymbolicLink()) entries.push([relative, "link"]);
      else if (info.isDirectory()) { entries.push([relative, "directory"]); await visit(file); }
      else entries.push([relative, hash(await readFile(file)), info.nlink, info.mtimeMs]);
    }
  }
  await visit(root); return entries;
}
async function state(changes) { const current = JSON.parse(await readFile(seamState, "utf8")); await json(seamState, { ...current, ...changes }); }
async function operations() {
  const directory = path.join(profile, ".teamai", "outbox", "learnings");
  return await Promise.all((await readdir(directory)).filter((file) => file.endsWith(".json")).map(async (file) => JSON.parse(await readFile(path.join(directory, file), "utf8"))));
}
async function operation(id) { return (await operations()).find((item) => item.id === id); }
async function share(name, cwd, args = [], fault = "offline") {
  const before = new Set((await operations().catch((error) => { if (error.code === "ENOENT") return []; throw error; })).map((item) => item.id));
  const body = Buffer.from(`# ${name}\r\nJointpending ${name}: preserve USER_OVERRIDE and Runtime loading was not inspected. 中文 bytes.\r\n`, "utf8");
  const file = path.join(cwd, `${name}.md`); await put(file, body); await state({ fault });
  await teamai(["learning", "share", file, ...args], cwd, 1);
  const saved = (await operations()).filter((item) => !before.has(item.id)); assert.equal(saved.length, 1);
  assert.equal(saved[0].contentHash, hash(Buffer.from(saved[0].payloadBase64, "base64")));
  assert.deepEqual(Buffer.from(saved[0].bodyBase64, "base64"), body);
  assert.equal(saved[0].baseBranch, "teamai-learnings"); assert.equal(saved[0].status, "retryable-error");
  return saved[0];
}
async function verifyHits(response, allowedProjects, expectedRevision) {
  assert.equal(response.sourceHash, hash(source), "Recall must use the configured independent source.");
  for (const hit of response.hits) {
    assert.ok(allowedProjects.includes(hit.logicalProject), `Out-of-scope hit ${hit.logicalProject}`);
    const bytes = await readFile(hit.file); assert.equal(hash(bytes), hit.source.contentHash);
    if (hit.type === "learning" && hit.publication === "published") assert.equal(hit.source.revision, expectedRevision);
    const lines = bytes.toString("utf8").split(/\r?\n/);
    assert.ok(hit.lineStart >= 1 && hit.lineEnd >= hit.lineStart && hit.lineEnd <= lines.length);
    assert.ok(lines.slice(hit.lineStart - 1, hit.lineEnd).join("\n").includes(hit.snippet), "Snippet must come from its original numbered lines.");
  }
}

try {
  const locatorEnv = { ...process.env };
  const locator = process.platform === "win32" ? "where.exe" : "which";
  const realGit = (await run(locator, ["git"], artifactRoot, locatorEnv)).stdout.trim().split(/\r?\n/)[0];
  let realCode; let codeVersion;
  if (backend === "fallback") {
    const candidates = (await run(locator, ["code"], artifactRoot, locatorEnv)).stdout.trim().split(/\r?\n/);
    for (const candidate of candidates) {
      if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".cmd")) continue;
      const probe = await run(candidate, ["--version"], artifactRoot, env, null);
      if (probe.exitCode === 0 && /^\d+\.\d+\.\d+(?:[-\w.]*)?\r?\n/.test(probe.stdout)) { realCode = candidate; codeVersion = probe; break; }
    }
    assert.ok(realCode, "Fallback requires a real VS Code version response, not an empty placeholder command.");
  }
  env.TEAMAI_JOINT_GIT = realGit;
  await put(env.GIT_CONFIG_GLOBAL, `[url "${pathToFileURL(bare).href}"]\n\tinsteadOf = ${remote}\n[core]\n\tautocrlf = false\n`);
  await put(env.TEAMAI_JOINT_IDENTITY_CONFIG, "[core]\n\tautocrlf = false\n");
  const resourceRevision = await git(["rev-parse", "HEAD"], marketplace);
  const learningRevision = await git(["rev-parse", "refs/remotes/origin/teamai-learnings"], marketplace);
  const cliSourceRevision = await git(["rev-parse", "HEAD"], cliRoot);
  const cliSourceTree = await git(["rev-parse", "HEAD^{tree}"], cliRoot);
  await git(["clone", "--no-hardlinks", "--bare", marketplace, bare]);
  await git(["--git-dir", bare, "fetch", marketplace, "refs/remotes/origin/teamai-learnings"]);
  await git(["--git-dir", bare, "update-ref", "refs/heads/main", resourceRevision]);
  await git(["--git-dir", bare, "update-ref", "refs/heads/teamai-learnings", learningRevision]);
  await git(["--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main"]);
  await git(["clone", "--no-hardlinks", "--branch", "main", bare, source]);
  await git(["remote", "set-url", "origin", remote], source);
  const sourceGitConfig = await readFile(path.join(source, ".git", "config"), "utf8");
  assert.ok(sourceGitConfig.includes(`url = ${remote}`), "Source stores the canonical GitHub identity independently of its local transport rewrite.");
  await put(path.join(artifactRoot, "source-git-config.txt"), sourceGitConfig);
  const versions = { cli: JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version,
    marketplace: JSON.parse(await readFile(path.join(source, "package.json"), "utf8")).version,
    catalog: JSON.parse(await readFile(path.join(source, ".github", "plugin", "marketplace.json"), "utf8")) };
  assert.equal(versions.cli, "0.4.0");
  assert.equal(versions.marketplace, versions.catalog.metadata.version);
  for (const entry of versions.catalog.plugins) {
    const manifest = JSON.parse(await readFile(path.join(source, entry.source, "plugin.json"), "utf8"));
    assert.equal(manifest.version, entry.version, `${entry.name} catalog/manifest version`);
  }
  assert.equal(JSON.parse(await readFile(path.join(cliRoot, "package-lock.json"), "utf8")).version, versions.cli);
  const fixture = { platform: process.platform, arch: process.arch, os: os.release(), node: process.version,
    backend, rootMode, scenario, scriptSha256: hash(scriptBytes), packageRoot, cliSha256: hash(await readFile(cli)), marketplace, source, bare, profile, copilotRoot,
    resourceRevision, learningRevision, versions, code: realCode, git: realGit };
  fixture.cliSourceRevision = cliSourceRevision; fixture.cliSourceTree = cliSourceTree;
  if (options["--tarball"]) {
    fixture.tarball = path.resolve(options["--tarball"]);
    fixture.tarballSha256 = hash(await readFile(fixture.tarball));
  }
  if (backend === "native") {
    fixture.copilot = (await run(locator, ["copilot"], artifactRoot, locatorEnv)).stdout.trim().split(/\r?\n/)[0];
    fixture.copilotLauncherSha256 = hash(await readFile(fixture.copilot));
    const siblingExecutable = path.join(path.dirname(fixture.copilot), "copilot.exe");
    if (process.platform === "win32" && path.extname(fixture.copilot).toLowerCase() === ".cmd") {
      fixture.copilotExecutable = siblingExecutable;
      fixture.copilotExecutableSha256 = hash(await readFile(siblingExecutable));
      assert.ok((await readFile(fixture.copilot, "utf8")).includes("--no-auto-update"), "Use the private launcher with --no-auto-update.");
    }
    fixture.runtime = await run("copilot", ["--version"]);
    fixture.help = await run("copilot", ["--help"], artifactRoot, env, null);
  } else {
    fixture.codeVersion = codeVersion;
    const launcherBytes = await readFile(realCode); fixture.codeLauncherSha256 = hash(launcherBytes);
    if (process.platform === "win32") {
      const executableReference = launcherBytes.toString("utf8").match(/"%~dp0([^"\r\n]+\.exe)"/i);
      assert.ok(executableReference, "Record the executable actually named by the real Code launcher.");
      fixture.codeExecutable = path.resolve(path.dirname(realCode), executableReference[1]);
      fixture.codeExecutableSha256 = hash(await readFile(fixture.codeExecutable));
    }
  }
  await json(path.join(artifactRoot, "fixture.json"), fixture);
  await json(seamState, { fault: "none", prs: {}, creates: 0, pushes: 0 });
  // This external seam never reaches real GitHub. Git is real and rewritten to the task's bare repository.
  const shim = `import fs from 'node:fs'; import {spawnSync} from 'node:child_process';
const kind=process.argv[2], file=process.env.TEAMAI_JOINT_STATE;
const args=kind==='gh'&&process.env.TEAMAI_JOINT_ENCODED_ARGS?process.env.TEAMAI_JOINT_ENCODED_ARGS.split(':').map(x=>Buffer.from(x,'base64').toString('utf8')):process.argv.slice(3);
const state=JSON.parse(fs.readFileSync(file,'utf8')); const save=()=>fs.writeFileSync(file,JSON.stringify(state));
fs.appendFileSync(process.env.TEAMAI_JOINT_LOG,JSON.stringify({kind,args,cwd:process.cwd(),fault:state.fault})+'\\n');
if(kind==='native-log')process.exit(0);
if(kind==='git'){
 if(args[0]==='clone'&&args.some(x=>x.startsWith('https://'))&&state.fault==='offline'){console.error('joint fixture offline before clone');process.exit(1);}
 // Read the real configured identity without the test-only transport rewrite.
 const identityRead=args[0]==='remote'&&args[1]==='get-url'&&args[2]==='origin';
 const childEnv=identityRead?{...process.env,GIT_CONFIG_GLOBAL:process.env.TEAMAI_JOINT_IDENTITY_CONFIG}:process.env;
 const result=spawnSync(process.env.TEAMAI_JOINT_GIT,args,{env:childEnv,encoding:'utf8',windowsHide:true});
 process.stdout.write(result.stdout??'');process.stderr.write(result.stderr??'');
 if(args[0]==='push'){state.pushes++;save();if(result.status===0&&state.fault==='lost-push'){state.fault='none';save();console.error('joint fixture lost push response');process.exit(1);}}
 process.exit(result.status??1);
}
if(kind==='gh'){
 if(args[0]==='joint-argv-smoke'){
  if(args[1]==='error'){console.error('joint forwarder stderr 中文');process.exit(7);}
  console.log(JSON.stringify(args));process.exit(0);
 }
 if(args[0]==='pr'&&args[1]==='create'){
  const get=k=>args[args.indexOf(k)+1]; if(get('--repo')!=='joint-fixture/teamai-marketplace'||get('--base')!=='teamai-learnings')throw Error('unsafe fake PR destination');
  const head=get('--head');state.creates++;const number=state.creates;state.prs[head]={number,body:get('--body'),state:'open',merged_at:null};save();
  if(state.fault==='lost-pr'){state.fault='none';save();console.error('joint fixture lost PR response');process.exit(1);}
  console.log('https://github.com/joint-fixture/teamai-marketplace/pull/'+number);process.exit(0);
 }
 if(args[0]==='api'&&args.includes('repos/joint-fixture/teamai-marketplace/pulls')){
  const head=args.find(x=>x.startsWith('head=joint-fixture:'))?.slice('head=joint-fixture:'.length);const pr=state.prs[head];
  const sha=spawnSync(process.env.TEAMAI_JOINT_GIT,['--git-dir',process.env.TEAMAI_JOINT_BARE,'rev-parse','refs/heads/'+head],{encoding:'utf8',windowsHide:true}).stdout?.trim();
  console.log(JSON.stringify(pr?[{...pr,html_url:'https://github.com/joint-fixture/teamai-marketplace/pull/'+pr.number,base:{ref:'teamai-learnings',repo:{full_name:'joint-fixture/teamai-marketplace'}},head:{ref:head,sha,repo:{full_name:'joint-fixture/teamai-marketplace',owner:{login:'joint-fixture'}}}}]:[]));process.exit(0);
 }
 throw Error('Unexpected fake gh command');
}`;
  await put(path.join(bin, "seam.mjs"), shim);
  for (const kind of ["git", "gh"]) {
    if (kind === "gh" && process.platform === "win32") continue;
    const file = path.join(bin, kind + (process.platform === "win32" ? ".cmd" : ""));
    await writeFile(file, process.platform === "win32" ? `@echo off\r\n"${process.execPath}" "%~dp0seam.mjs" ${kind} %*\r\n` : `#!/bin/sh\nexec '${process.execPath}' '${path.join(bin, "seam.mjs")}' ${kind} "$@"\n`, { mode: 0o755 });
  }
  if (process.platform === "win32") {
    // A real executable preserves multiline argv that cmd.exe would split.
    env.TEAMAI_JOINT_NODE = process.execPath;
    env.TEAMAI_JOINT_SHIM = path.join(bin, "seam.mjs");
    const forwarder = `using System; using System.Diagnostics; using System.Text;
class JointGh {
 static int Main(string[] args) {
  string[] encoded = Array.ConvertAll(args, x => Convert.ToBase64String(Encoding.UTF8.GetBytes(x)));
  ProcessStartInfo start = new ProcessStartInfo(Environment.GetEnvironmentVariable("TEAMAI_JOINT_NODE"), "\\\"" + Environment.GetEnvironmentVariable("TEAMAI_JOINT_SHIM") + "\\\" gh");
  start.UseShellExecute = false; start.CreateNoWindow = true;
  start.RedirectStandardOutput = true; start.RedirectStandardError = true;
  start.StandardOutputEncoding = Encoding.UTF8; start.StandardErrorEncoding = Encoding.UTF8;
  start.EnvironmentVariables["TEAMAI_JOINT_ENCODED_ARGS"] = String.Join(":", encoded);
  Console.OutputEncoding = new UTF8Encoding(false);
  using (Process child = Process.Start(start)) {
   var output = child.StandardOutput.ReadToEndAsync(); var error = child.StandardError.ReadToEndAsync();
   child.WaitForExit(); Console.Out.Write(output.Result); Console.Error.Write(error.Result); return child.ExitCode;
  }
 }
}`;
    const forwarderSource = path.join(bin, "gh.cs");
    await put(forwarderSource, forwarder);
    const compiler = path.join(process.env.SystemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
    await run(compiler, ["/nologo", `/out:${path.join(bin, "gh.exe")}`, forwarderSource]);
    fixture.ghForwarder = { compiler, sourceSha256: hash(forwarder), executableSha256: hash(await readFile(path.join(bin, "gh.exe"))) };
  }
  if (backend === "native" && process.platform === "win32") {
    const nativeExecutable = fixture.copilotExecutable ?? fixture.copilot;
    await put(path.join(bin, "copilot.cmd"), `@echo off\r\n"${process.execPath}" "%~dp0seam.mjs" native-log %*\r\n"${nativeExecutable}" --no-auto-update %*\r\n`);
  }
  if (backend === "fallback") {
    await put(path.join(bin, "code.cmd"), `@echo off\r\ncall "${realCode}" %*\r\n`);
    env.PATH = [bin, path.dirname(realGit), ...(process.platform === "win32" ? [path.join(process.env.SystemRoot, "System32")] : [path.dirname(realCode)])].join(path.delimiter);
    await run("code", ["--version"]);
    await assert.rejects(run("copilot", ["--version"]), (error) => error.code === "ENOENT", "Fallback fixture must make native unavailable, not merely failing.");
    fixture.nativeUnavailable = "ENOENT";
  } else env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
  fixture.backendPath = env.PATH;
  await json(path.join(artifactRoot, "fixture.json"), fixture);
  const smokeArgs = ["joint-argv-smoke", "--body", "Line one.\r\n\r\n中文 bytes.\nLine three.", "--repo", "joint-fixture/teamai-marketplace", "--base", "teamai-learnings", "--head", "teamai/fixture-head"];
  const smokeOutput = await run("gh", smokeArgs);
  assert.equal(smokeOutput.stderr, "");
  assert.deepEqual(Buffer.from(JSON.stringify(JSON.parse(smokeOutput.stdout))), Buffer.from(JSON.stringify(smokeArgs)));
  const smokeError = await run("gh", ["joint-argv-smoke", "error"], artifactRoot, env, 7);
  assert.equal(smokeError.stdout, ""); assert.equal(smokeError.stderr, "joint forwarder stderr 中文\n");
  pass("seam/argv", "External gh fixture preserves multiline UTF-8 argv and separate success/error streams before product init.");
  for (const directory of [workA, workB]) {
    await mkdir(directory); await git(["init", "-b", "main"], directory);
    await git(["config", "user.name", "Joint Fixture"], directory); await git(["config", "user.email", "joint@example.invalid"], directory);
    await put(path.join(directory, "README.md"), "# Independent joint workspace\n");
    await git(["add", "README.md"], directory); await git(["commit", "-m", "joint baseline"], directory);
  }
  await git(["worktree", "add", "-b", "linked", linked], workA);
  const personal = [path.join(copilotRoot, "agents", "teamai-recall.md"), path.join(copilotRoot, "instructions", "personal.instructions.md"),
    path.join(copilotRoot, "skills", "personal-neighbor", "SKILL.md"), path.join(workA, ".github", "skills", "personal-neighbor", "SKILL.md")];
  for (const file of personal) await put(file, "# Personal neighbor\nKeep exact bytes.\r\n");
  const personalHashes = await Promise.all(personal.map(async (file) => [file, hash(await readFile(file))]));
  const beforeA = await tree(workA); const beforeB = await tree(workB);
  assert.equal((await teamai(["--version"])).stdout.trim(), versions.cli);
  const initialized = await teamai(["init", "--marketplace", source, "--role", "api"]);
  if (backend === "fallback") assert.ok(initialized.stdout.includes("Copilot CLI: VS Code-compatible fallback"), "Public init must actually select FallbackCopilotClient.");
  await teamai(["sync"], workB);
  assert.deepEqual(await tree(workA), beforeA); assert.deepEqual(await tree(workB), beforeB);
  pass("F02", "Public init and unbound sync preserve repository files and Git metadata.");
  const agentReceipt = JSON.parse(await readFile(path.join(profile, ".teamai", "built-in-agents", "teamai-recall.json"), "utf8"));
  assert.equal(agentReceipt.version, versions.cli); assert.equal(path.resolve(agentReceipt.copilotRoot), copilotRoot);
  assert.equal(agentReceipt.contentHash, hash(await readFile(path.join(packageRoot, "agents", "teamai-recall.agent.md"))));
  assert.equal(agentReceipt.contentHash, hash(await readFile(agentReceipt.target)));
  if (rootMode === "custom") assert.equal(await lstat(path.join(profile, ".copilot")).catch((e) => e.code), "ENOENT");
  pass("F04/F09/F11", `${backend} delivery uses ${rootMode} root and exact bundled Agent ownership/version/hash.`);
  await teamai(["projects", "set", "teamai"]);
  await teamai(["projects", "set", "teamai"], linked);
  await teamai(["sync"]);
  assert.deepEqual(await readFile(path.join(workA, ".github", "skills", "teamai-project-scope-probe", "SKILL.md")),
    await readFile(path.join(source, "plugins", "teamai-project", "skills", "teamai-project-scope-probe", "SKILL.md")));
  const expectedLearningPath = "learnings/teamai/ee6f6448-70d3-405d-aa05-290b66ecfb45.md";
  const recallA = await query(["recall", "USER_OVERRIDE RUNTIME_NOT_OBSERVED", "--scope", "workspace", "--project", "teamai", "--json"]);
  await verifyHits(recallA, ["shared", "teamai"], learningRevision);
  const knownLearning = recallA.hits.find((hit) => hit.source.relativePath === expectedLearningPath); assert.ok(knownLearning, "Public sync must expose the authoritative reviewed Learning.");
  const authoritative = await run(realGit, ["show", `${learningRevision}:${expectedLearningPath}`], marketplace);
  assert.equal(knownLearning.source.contentHash, hash(Buffer.from(authoritative.stdout)));
  assert.equal(knownLearning.source.contentHash, "3beaf5e88417f426f8d2c60d7b7aba80ec8190293bcd6a83bab1713e654e7529", "Reviewed Marketplace example bytes from prerequisite authority.");
  assert.ok((await readFile(knownLearning.file, "utf8")).includes("Runtime loading was not inspected."));
  const recallB = await query(["recall", "USER_OVERRIDE", "--json"], workB);
  assert.equal(recallB.scope, "user"); assert.ok(recallB.hits.every((hit) => hit.logicalProject === "shared"));
  const sharedRecall = await query(["recall", "last-good", "--json"], workB);
  await verifyHits(sharedRecall, ["shared"], learningRevision);
  const sharedHit = sharedRecall.hits.find((hit) => hit.source.relativePath === "learnings/shared/9d8d80b6-9be4-4f4c-90fa-ac26cc66f2ef.md");
  assert.ok(sharedHit); assert.equal(sharedHit.source.contentHash, "bad8878a7845291e23714e7f65b82b801524a0e9305cb7733f9aad42b1c6e41b");
  await query(["recall", "USER_OVERRIDE", "--scope", "workspace", "--json"], workB, 1);
  pass("F06/F08", "Cache from public sync preserves authority revision/hash/bytes; bound A includes teamai, unbound B is shared-only.");
  const status = await query(["status", "--json"]); const doctor = await query(["doctor", "--json"]);
  await json(path.join(artifactRoot, "status-doctor.json"), { status, doctor });
  assert.equal(status.cliVersion, versions.cli); assert.equal(doctor.cliVersion, versions.cli);
  assert.deepEqual(status.resources, doctor.resources);
  assert.ok(status.resources.every((item) => Object.values(item.runtime).every((value) => value === "unknown")), "Unobserved consumers must remain unknown.");
  const globalConfig = parseYaml(await readFile(path.join(profile, ".teamai", "config.yaml"), "utf8"));
  assert.ok(globalConfig.managedPlugins.length >= 6);
  assert.ok(!globalConfig.managedPlugins.includes("teamai-project@teamai"));
  const configText = await readFile(path.join(copilotRoot, "config.json"), "utf8").catch((error) => {
    if (backend === "native" && error.code === "ENOENT") return "{}";
    throw error;
  });
  const copilotConfig = parseJsonc(configText);
  const settings = parseJsonc(await readFile(path.join(copilotRoot, "settings.json"), "utf8"));
  assert.equal(settings.enabledPlugins["common@teamai"], true); assert.equal(settings.enabledPlugins["api@teamai"], true);
  for (const role of ["ios", "aos", "qa", "design"]) assert.equal(settings.enabledPlugins[`${role}@teamai`], false);
  assert.ok(!(copilotConfig.installedPlugins ?? []).some((item) => item.name === "teamai-project"));
  if (backend === "fallback") {
    const rows = copilotConfig.installedPlugins;
    assert.equal(rows.length, 6, "Fallback must actually materialize all six user Plugins.");
    assert.deepEqual(rows.map((row) => row.name).sort(), ["aos", "api", "common", "design", "ios", "qa"]);
    for (const row of rows) {
      const catalogEntry = versions.catalog.plugins.find((entry) => entry.name === row.name);
      assert.equal(row.marketplace, "teamai"); assert.equal(row.version, catalogEntry.version);
      assert.equal(path.resolve(row.cache_path), path.join(copilotRoot, "installed-plugins", "teamai", row.name));
      assert.equal(row.source_sha, undefined, "Fallback must not invent native source_sha.");
      const bytesOnly = (entries) => entries.map((entry) => entry.slice(0, 2));
      assert.deepEqual(bytesOnly(await tree(row.cache_path)), bytesOnly(await tree(path.join(source, catalogEntry.source))));
    }
  }
  if (backend === "native") {
    const plugins = JSON.parse((await run("copilot", ["plugin", "list", "--json"], workA)).stdout);
    const skills = JSON.parse((await run("copilot", ["skill", "list", "--json"], workA)).stdout);
    assert.ok(Array.isArray(plugins) && Array.isArray(skills));
    for (const name of ["common", "api"]) assert.ok(plugins.some((item) => item.name === name && item.enabled === true));
    assert.ok(skills.some((item) => item.name === "teamai" && item.source === "personal-copilot" && item.enabled === true && path.resolve(item.path).toLowerCase() === path.join(copilotRoot, "skills", "teamai").toLowerCase()));
  }
  assert.equal(await lstat(path.join(workB, ".github", "skills", "teamai-project-scope-probe")).catch((e) => e.code), "ENOENT");
  pass("F01/F03/F05", "Status/doctor agree on resource facts, common/roles have ownership, Project source is not a user-installed Plugin.");
  let publishedRevision = learningRevision;
  let dryRunId;
  const dryRunFile = path.join(workB, "shared-draft.md");
  if (scenario === "full") {
  const shared = await share("shared-draft", workB);
  dryRunId = shared.id;
  const project = await share("project-draft", workA);
  const sibling = await share("sibling-draft", linked);
  const explicit = await share("explicit-unbound-project", workB, ["--project", "teamai"]);
  assert.equal(shared.logicalProject, "shared"); assert.equal(project.logicalProject, "teamai"); assert.equal(explicit.logicalProject, "teamai");
  const includedA = await query(["recall", "Jointpending", "--include-pending", "--json"]);
  assert.deepEqual(includedA.hits.map((hit) => hit.id).sort(), [`pending:${project.id}`]);
  const includedUser = await query(["recall", "Jointpending", "--scope", "user", "--include-pending", "--json"], artifactRoot);
  assert.deepEqual(includedUser.hits.map((hit) => hit.id), [`pending:${shared.id}`]);
  const includedW = await query(["recall", "Jointpending", "--include-pending", "--json"], linked);
  assert.deepEqual(includedW.hits.map((hit) => hit.id), [`pending:${sibling.id}`]);
  assert.equal((await query(["recall", "Jointpending", "--json"])).hits.length, 0);
  await verifyHits(includedA, ["shared", "teamai"], learningRevision);
  pass("F07/F08", "Public share persists exact CRLF/body bytes before failure; pending selection obeys source, origin and final Scope.");
  await state({ fault: "lost-push" }); await teamai(["learning", "retry", project.id], workB, 1);
  const pushed = await operation(project.id); assert.equal(pushed.phase, "queued"); assert.equal(pushed.status, "retryable-error");
  const pushedHead = await git(["--git-dir", bare, "rev-parse", project.branch]);
  await state({ fault: "lost-pr" }); await teamai(["learning", "retry", project.id], workB, 1);
  assert.equal((await operation(project.id)).phase, "branch-pushed");
  await teamai(["learning", "retry", project.id], workB);
  assert.equal((await operation(project.id)).phase, "pr-open");
  const transport = JSON.parse(await readFile(seamState, "utf8")); assert.equal(transport.creates, 1); assert.equal(transport.pushes, 1);
  assert.deepEqual(Buffer.from(transport.prs[project.branch].body, "utf8"), Buffer.from(project.pullRequestBody, "utf8"), "The executable fake gh must preserve every multiline body byte.");
  const createCall = (await readFile(seamLog, "utf8")).trim().split("\n").map((line) => JSON.parse(line)).find((row) => row.kind === "gh" && row.args[0] === "pr" && row.args[1] === "create");
  for (const [flag, value] of [["--repo", "joint-fixture/teamai-marketplace"], ["--base", "teamai-learnings"], ["--head", project.branch]]) assert.equal(createCall.args[createCall.args.indexOf(flag) + 1], value);
  assert.equal(await git(["--git-dir", bare, "rev-parse", project.branch]), pushedHead);
  pass("F07/checkpoint", "Actual local Git push and fake PR lost responses recover the same ID/payload with one push and one fake PR.");
  await teamai(["learning", "retry", sibling.id], workB);
  const closedState = JSON.parse(await readFile(seamState, "utf8")); closedState.prs[sibling.branch].state = "closed"; await json(seamState, closedState);
  await teamai(["learning", "retry", sibling.id], workB);
  assert.equal((await operation(sibling.id)).phase, "closed-without-merge");
  assert.equal((await operation(sibling.id)).status, "complete");
  const mergeRoot = path.join(artifactRoot, "local-merge"); await git(["clone", "--no-hardlinks", bare, mergeRoot]);
  await git(["checkout", "teamai-learnings"], mergeRoot);
  await git(["-c", "user.name=Joint Fixture", "-c", "user.email=joint@example.invalid", "merge", "--no-ff", "-m", "local fixture merge", `origin/${project.branch}`], mergeRoot);
  await git(["push", "origin", "teamai-learnings"], mergeRoot);
  publishedRevision = await git(["rev-parse", "HEAD"], mergeRoot);
  const mergedState = JSON.parse(await readFile(seamState, "utf8")); mergedState.prs[project.branch].state = "closed"; mergedState.prs[project.branch].merged_at = "2026-10-04T00:00:00Z"; await json(seamState, mergedState);
  await teamai(["learning", "retry", project.id], workB);
  assert.equal((await operation(project.id)).phase, "published"); assert.equal((await operation(project.id)).status, "complete");
  await teamai(["sync"]);
  const published = await query(["recall", "Jointpending", "--json"]);
  assert.ok(published.hits.some((hit) => hit.source.relativePath === project.destination && hit.publication === "published"));
  await verifyHits(published, ["shared", "teamai"], publishedRevision);
  const pending = await query(["learning", "pending", "--json"]);
  assert.ok(!pending.operations.some((item) => [project.id, sibling.id].includes(item.id)));
  pass("F07/terminal", "Local authority merge publishes exact payload; closed-without-merge stays distinct and absent from published cache.");
  const modified = await share("modified-draft", workA);
  await state({ fault: "none" }); await teamai(["learning", "retry", modified.id], workB);
  await git(["fetch", "origin"], mergeRoot);
  await git(["checkout", "-b", "reviewed-modification", `origin/${modified.branch}`], mergeRoot);
  const reviewedBytes = Buffer.concat([Buffer.from(modified.payloadBase64, "base64"), Buffer.from("\nReviewed changed text.\n")]);
  await put(path.join(mergeRoot, modified.destination), reviewedBytes);
  await git(["add", "--", modified.destination], mergeRoot);
  await git(["-c", "user.name=Joint Fixture", "-c", "user.email=joint@example.invalid", "commit", "-m", "local reviewed payload change"], mergeRoot);
  await git(["checkout", "teamai-learnings"], mergeRoot);
  await git(["-c", "user.name=Joint Fixture", "-c", "user.email=joint@example.invalid", "merge", "--no-ff", "-m", "local modified merge", "reviewed-modification"], mergeRoot);
  await git(["push", "origin", "teamai-learnings"], mergeRoot);
  publishedRevision = await git(["rev-parse", "HEAD"], mergeRoot);
  const modifiedState = JSON.parse(await readFile(seamState, "utf8"));
  modifiedState.prs[modified.branch].state = "closed"; modifiedState.prs[modified.branch].merged_at = "2026-10-04T00:00:01Z"; await json(seamState, modifiedState);
  await teamai(["learning", "retry", modified.id], workB, 1);
  const blocked = await operation(modified.id); assert.equal(blocked.status, "blocked"); assert.equal(blocked.lastError.code, "MERGED_CONTENT_MODIFIED");
  await teamai(["sync"]);
  const reviewedRecall = await query(["recall", "Jointpending", "--json"]);
  const reviewedHit = reviewedRecall.hits.find((hit) => hit.source.relativePath === modified.destination);
  assert.ok(reviewedHit && reviewedHit.publication === "published"); assert.equal(reviewedHit.source.contentHash, hash(reviewedBytes));
  const blockedRecall = await query(["recall", "Jointpending", "--include-pending", "--json"]);
  assert.ok(blockedRecall.hits.some((hit) => hit.id === `pending:${modified.id}` && hit.publication === "pending"));
  assert.ok(!blockedRecall.hits.some((hit) => hit.id === `pending:${sibling.id}` || hit.id === `pending:${project.id}`));
  const userTerminal = await query(["recall", "Jointpending", "--scope", "user", "--include-pending", "--json"], artifactRoot);
  assert.deepEqual(userTerminal.hits.map((hit) => hit.id), [`pending:${shared.id}`]);
  await verifyHits(reviewedRecall, ["shared", "teamai"], publishedRevision);
  pass("F07/modified", "Modified authoritative bytes are published evidence; frozen original stays blocked/pending in its origin Scope and is never claimed published by retry.");
  } else await put(dryRunFile, "# Dry run only\nKeep this body.\r\n");
  // Read-only commands use no native, gh, fetch, push or persistent target writes.
  await state({ fault: "offline" });
  env.GIT_ALLOW_PROTOCOL = ""; // Even unlogged native Git transport calls cannot use a protocol.
  const readonlyBefore = { copilotRoot: await tree(copilotRoot), profile: await tree(profile), a: await tree(workA), b: await tree(workB), w: await tree(linked), source: await tree(source), refs: await git(["--git-dir", bare, "show-ref"]) };
  const logBefore = (await readFile(seamLog, "utf8")).trim().split("\n").length;
  await teamai(["status", "--json"]); await teamai(["doctor", "--json"]); await teamai(["recall", "USER_OVERRIDE", "--json"]);
  await teamai(["learning", "pending", "--json"]);
  if (dryRunId) await teamai(["learning", "retry", dryRunId, "--dry-run"]);
  await teamai(["learning", "share", dryRunFile, "--dry-run"], workB);
  const readonlyAfter = { copilotRoot: await tree(copilotRoot), profile: await tree(profile), a: await tree(workA), b: await tree(workB), w: await tree(linked), source: await tree(source), refs: await git(["--git-dir", bare, "show-ref"]) };
  assert.deepEqual(readonlyAfter, readonlyBefore);
  const tail = (await readFile(seamLog, "utf8")).trim().split("\n").slice(logBefore).map((line) => JSON.parse(line));
  assert.ok(tail.every((row) => row.kind === "git" && !["push", "fetch", "clone"].includes(row.args[0])), "Readonly/dry-run must not invoke network or fake gh.");
  await json(path.join(artifactRoot, "readonly-protection.json"), { before: readonlyBefore, after: readonlyAfter, seamCalls: tail });
  pass("T40/F10", "Read-only and contribution dry-run preserve profile/workspaces/source/remote refs with no native mutation, network or PR.");
  env.GIT_ALLOW_PROTOCOL = "file";
  await state({ fault: "none" });
  await teamai(["projects", "set"]);
  await teamai(["sync"]);
  assert.equal((await query(["recall", "USER_OVERRIDE", "--json"])).scope, "user");
  assert.equal((await query(["recall", "USER_OVERRIDE", "--json"], linked)).scope, "workspace");
  for (const [file, expectedHash] of personalHashes) assert.equal(hash(await readFile(file)), expectedHash);
  pass("T08/F02/F05", "Unbind only affects A; linked W binding and personal neighboring files survive sync/cleanup.");
  await json(path.join(artifactRoot, "result.json"), { result: "PASS", checks, fixture, publishedRevision,
    limitations: ["Fake gh is fault/terminal evidence, not a real GitHub PR or F12/T47 acceptance.", "No model, VS Code Local/Agent Host, macOS or Linux consumer acceptance is inferred.", "T21-T23/T44/T48 responsibility evidence is audited separately; this script does not duplicate write paths or package gates."] });
} catch (error) {
  await json(path.join(artifactRoot, "result.json"), { result: "FAIL", checks, error: error.stack ?? String(error), backend, rootMode });
  throw error;
}
