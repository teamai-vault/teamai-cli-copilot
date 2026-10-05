// Issue #30 only. No ranking/model implementation; CLI calls use the installed executable.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixture = fileURLToPath(new URL("../test/fixtures/recall-quality/", import.meta.url));
const batch = path.resolve("F:/agent-workspace/multiAgent/teamai-cli-customization/.tmp/recall-29-35");
const cases = JSON.parse(await readFile(path.join(fixture, "cases.json"), "utf8"));
const sources = JSON.parse(await readFile(path.join(fixture, "sources.json"), "utf8"));
const hash = (value) => createHash("sha256").update(value).digest("hex");
const json = async (target, value) => writeFile(target, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const present = async (target) => lstat(target).catch((error) => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});

async function filesBelow(root, prefix = "") {
  const result = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    const info = await lstat(path.join(root, relative));
    assert(!info.isSymbolicLink(), "Link-like fixture path: " + relative);
    if (info.isDirectory()) result.push(...await filesBelow(root, relative));
    else {
      assert(info.isFile() && info.nlink === 1, "Unsafe fixture file: " + relative);
      result.push(relative);
    }
  }
  return result.sort();
}

async function check() {
  assert.equal(cases.schemaVersion, 1);
  assert.equal(cases.cases.length, 6);
  assert.deepEqual(cases.limits, [5, 10]);
  const byId = new Map(sources.map((source) => [source.id, source]));
  assert.equal(byId.size, sources.length, "Duplicate source ID");
  assert.equal(new Set(cases.cases.map((item) => item.id)).size, 6);
  for (const source of sources) {
    assert(!source.fixturePath.includes("..") && !path.isAbsolute(source.fixturePath));
    const raw = await readFile(path.join(fixture, source.fixturePath), "utf8");
    assert(raw.endsWith("\n") && !raw.includes("\r"), "Original must have frozen LF bytes");
    assert.equal(source.allowed, ["shared", cases.logicalProject].includes(source.logicalProject));
    if (source.id.startsWith("learning:")) assert(raw.includes("id: " + source.id.split(":").at(-1) + "\n"));
  }
  for (const item of cases.cases) {
    assert(item.manualKeywords && item.englishSentence && item.questions.length > 0);
    for (const group of item.requiredEvidenceGroups) {
      assert(group.length > 0);
      for (const id of group) assert(byId.get(id)?.allowed, "Required source outside allowed corpus");
    }
    for (const evidence of item.evidence) {
      const source = byId.get(evidence.source);
      assert(source, "Unknown source: " + evidence.source);
      const raw = await readFile(path.join(fixture, source.fixturePath), "utf8");
      const lines = raw.trimEnd().split("\n");
      const [first, last] = evidence.lines;
      assert(Number.isInteger(first) && first > 0 && last >= first && last <= lines.length);
      assert(lines.slice(first - 1, last).join("\n").includes(evidence.quote),
        item.id + ": independently frozen quote is not in its original line range");
    }
    for (const id of item.weakSources) assert(byId.get(id)?.allowed);
    for (const anchor of item.anchors) {
      assert(item.manualKeywords.includes(anchor) || item.englishSentence.includes(anchor),
        item.id + ": query recipe changed a supplied anchor");
    }
  }
  const manifest = [];
  for (const relative of await filesBelow(fixture)) {
    const bytes = await readFile(path.join(fixture, relative));
    manifest.push({ path: relative, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { fixtureVersion: cases.fixtureVersion, files: manifest, rawManifestSha256: hash(JSON.stringify(manifest)) };
}

async function safeDirectory(target, fresh = false) {
  assert(path.isAbsolute(target), "Use an absolute task-owned path");
  const relative = path.relative(batch, path.resolve(target));
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Path outside this batch");
  const parts = relative.split(path.sep);
  let current = batch;
  for (const part of ["", ...parts]) {
    if (part) current = path.join(current, part);
    const info = await present(current);
    if (info) assert(info.isDirectory() && !info.isSymbolicLink(), "Unsafe directory: " + current);
  }
  if (fresh) {
    assert(!(await present(target)), "Refusing to reuse an output directory");
    await mkdir(target, { recursive: true });
  }
}

function run(command, args, cwd, env) {
  const start = performance.now();
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return {
    args, exitCode: result.status, elapsedMs: Math.round(performance.now() - start),
    stdout: result.stdout ?? "", stderr: result.stderr ?? "",
    ...(result.error ? { launchError: result.error.message } : {}),
  };
}

function mustRun(command, args, cwd, env) {
  const result = run(command, args, cwd, env);
  assert.equal(result.exitCode, 0, result.stderr || result.launchError || result.stdout);
  return result.stdout.trim();
}

async function packageFacts(packageRoot) {
  assert(path.isAbsolute(packageRoot), "Use an installed absolute package path");
  const cli = path.join(packageRoot, "dist/cli.js");
  const agent = path.join(packageRoot, "agents/teamai-recall.agent.md");
  return {
    packageRoot, cli, cliSha256: hash(await readFile(cli)), agentSha256: hash(await readFile(agent)),
    version: JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8")).version,
    tarballSha256: "UNVERIFIED: bind this installation to the coordinator package manifest",
  };
}

function environment(root, home) {
  return {
    ...process.env, HOME: home, USERPROFILE: home, COPILOT_HOME: path.join(root, "consumer"),
    TEMP: path.join(root, "temp"), TMP: path.join(root, "temp"),
    npm_config_cache: path.join(root, "npm-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"), XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(root, "gitconfig"),
  };
}

async function prepare(packageRoot, root) {
  const frozen = await check();
  const facts = await packageFacts(packageRoot);
  await safeDirectory(root, true);
  for (const name of ["home", "missing-home", "damaged-home", "workspace", "temp", "consumer", "xdg-config", "xdg-cache"])
    await mkdir(path.join(root, name));
  const env = environment(root, path.join(root, "home"));
  Object.assign(process.env, { TEMP: env.TEMP, TMP: env.TMP, HOME: env.HOME, USERPROFILE: env.USERPROFILE,
    GIT_CONFIG_NOSYSTEM: env.GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL });
  const gitEnv = { ...env, GIT_AUTHOR_NAME: "Recall Quality", GIT_AUTHOR_EMAIL: "quality@example.invalid",
    GIT_COMMITTER_NAME: "Recall Quality", GIT_COMMITTER_EMAIL: "quality@example.invalid",
    GIT_AUTHOR_DATE: "2026-10-04T00:00:00Z", GIT_COMMITTER_DATE: "2026-10-04T00:00:00Z" };
  await writeFile(path.join(root, "gitconfig"), "[core]\n\tautocrlf = false\n");
  for (const [kind, branch] of [["resource", "main"], ["published", "teamai-learnings"]]) {
    const target = path.join(root, kind);
    await cp(path.join(fixture, kind), target, { recursive: true, force: false, errorOnExist: true });
    mustRun("git", ["init", "-b", branch], target, gitEnv);
    mustRun("git", ["add", "."], target, gitEnv);
    mustRun("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Frozen Recall quality " + kind + " v1"], target, gitEnv);
  }
  const resource = path.join(root, "resource");
  const published = path.join(root, "published");
  const authority = path.join(root, "origin.git");
  mustRun("git", ["clone", "--bare", "--no-hardlinks", resource, authority], root, gitEnv);
  mustRun("git", ["fetch", published, "teamai-learnings:refs/heads/teamai-learnings"], authority, gitEnv);
  mustRun("git", ["remote", "add", "origin", authority], resource, gitEnv);
  const workspace = path.join(root, "workspace");
  await writeFile(path.join(workspace, "README.md"), "# Synthetic Recall quality workspace\n");
  mustRun("git", ["init", "-b", "main"], workspace, gitEnv);
  mustRun("git", ["add", "README.md"], workspace, gitEnv);
  mustRun("git", ["-c", "commit.gpgsign=false", "commit", "-m", "Synthetic workspace"], workspace, gitEnv);

  // Existing exported helpers only construct fixture machine state; measurement uses public CLI.
  const imported = async (relative) => import(pathToFileURL(path.join(packageRoot, "dist", relative)).href);
  const { writeGlobalConfig } = await imported("config/global.js");
  const { createConfig } = await imported("config/schema.js");
  const { refreshPublishedLearningSnapshot } = await imported("project/published-cache.js");
  const { detectProjectIdentity } = await imported("project/anchors.js");
  const { writeProjectState } = await imported("project/state.js");
  const { projectionKey } = await imported("project/context.js");
  const resourceRevision = mustRun("git", ["rev-parse", "HEAD"], resource, gitEnv);
  const learningRevision = mustRun("git", ["rev-parse", "HEAD"], published, gitEnv);
  const identity = await detectProjectIdentity(workspace);
  assert(identity);
  for (const name of ["home", "missing-home"]) {
    const home = path.join(root, name);
    const config = createConfig({ name: "recall-quality", source: resource });
    config.marketplaceRevision = resourceRevision;
    await writeGlobalConfig(config, home);
    await writeProjectState(identity.projectAnchor, {
      schemaVersion: 1, workspaceRoot: identity.workspaceRoot, lastSync: "2026-10-04T00:00:00.000Z", managedPlugins: [],
      projections: { [projectionKey(identity.workspaceRoot)]: {
        workspaceRoot: identity.workspaceRoot, logicalProjects: [cases.logicalProject], managedProjectPlugins: [],
        instructionRoot: path.join(workspace, ".github/instructions/teamai"),
        contextRoot: path.join(workspace, ".teamai/context"),
      } },
    }, home);
  }
  const snapshot = await refreshPublishedLearningSnapshot({
    marketplaceRoot: resource, plugins: [], source: resource, homeDir: path.join(root, "home"),
  });
  assert.equal(snapshot.revision, learningRevision);
  await snapshot.dispose();
  await cp(path.join(root, "home/.teamai"), path.join(root, "damaged-home/.teamai"), { recursive: true, force: false, errorOnExist: true });
  const damaged = path.join(root, "damaged-home/.teamai/published-learnings", hash(resource),
    "revisions", learningRevision, "files/learnings/shared/30000000-0000-4000-8000-000000000001.md");
  await writeFile(damaged, Buffer.concat([await readFile(damaged), Buffer.from("Deliberate fixture-only corruption.\n")]));
  const prepared = { schemaVersion: 1, root, workspace, source: resource, authority, resourceRevision, learningRevision,
    logicalProject: cases.logicalProject, sourceHash: hash(resource), frozen, setupPackage: facts,
    setupUsesExistingHelpers: true, actualNativeDelivery: "UNVERIFIED", consumerRuntime: "UNVERIFIED" };
  await json(path.join(root, "prepared.json"), prepared);
  return prepared;
}

async function protectedSnapshot(prepared) {
  const result = {};
  for (const name of ["resource", "published", "origin.git", "workspace", "home/.teamai", "missing-home/.teamai",
    "damaged-home/.teamai", "consumer/agents", "consumer/skills"]) {
    const target = path.join(prepared.root, name);
    if (!(await present(target))) { result[name] = "ABSENT"; continue; }
    for (const relative of await filesBelow(target))
      result[name + "/" + relative] = hash(await readFile(path.join(target, relative)));
  }
  result["workspace/injection-executed.txt"] = (await present(path.join(prepared.workspace, "injection-executed.txt"))) ? "PRESENT" : "ABSENT";
  return result;
}

async function cli(packageRoot, root, output, sourceRevision) {
  assert(/^[a-f0-9]{40}$/.test(sourceRevision ?? ""), "Declare the coordinator-bound source SHA");
  await safeDirectory(root);
  const prepared = JSON.parse(await readFile(path.join(root, "prepared.json"), "utf8"));
  assert.equal(prepared.root, root);
  const frozen = await check();
  assert.deepEqual(frozen, prepared.frozen, "Frozen fixture changed; comparison rejected");
  const facts = await packageFacts(packageRoot);
  await safeDirectory(output, true);
  const before = await protectedSnapshot(prepared);
  await json(path.join(output, "protected-before.json"), before);
  const observations = [];
  const protocols = [];
  const measurementStart = performance.now();
  for (const args of [["--version"], ["recall", "--help"], ["projects", "list"]]) {
    const result = run(process.execPath, [facts.cli, ...args], prepared.workspace, environment(root, path.join(root, "home")));
    protocols.push(result);
  }
  let ordinal = 0;
  for (const item of cases.cases) {
    const profiles = item.profiles ?? [{ name: "healthy", expectedExit: 0 }];
    for (const profile of profiles) {
      const home = path.join(root, profile.name === "healthy" ? "home" : profile.name + "-home");
      const queries = [["keywords", item.manualKeywords], ["sentence", item.englishSentence],
        ...(item.chineseCliQuery ? [["chinese", item.chineseCliQuery]] : [])];
      for (const [kind, query] of queries) for (const limit of cases.limits) {
        const result = run(process.execPath, [facts.cli, "recall", query, "--scope", "workspace", "--project", cases.logicalProject,
          "--limit", String(limit), "--json"], prepared.workspace, environment(root, home));
        const prefix = String(++ordinal).padStart(2, "0") + "-" + item.id + "-" + profile.name + "-" + kind + "-" + limit;
        await writeFile(path.join(output, prefix + ".stdout.txt"), result.stdout, { flag: "wx" });
        await writeFile(path.join(output, prefix + ".stderr.txt"), result.stderr, { flag: "wx" });
        let response;
        let parseError;
        try { response = JSON.parse(result.stdout); } catch (error) { parseError = error.message; }
        const jsonError = response?.error ? {
          schemaVersion: response.schemaVersion, code: response.error.code, message: response.error.message,
          validSchema: response.schemaVersion === 1 && typeof response.error === "object" && !Array.isArray(response.error)
            && typeof response.error.code === "string" && typeof response.error.message === "string",
        } : undefined;
        const hits = response?.hits ?? [];
        const hitIds = hits.map((hit) => hit.id);
        const groups = item.requiredEvidenceGroups.map((group) => ({ alternatives: group, covered: group.some((id) => hitIds.includes(id)) }));
        const provenance = [];
        for (const hit of hits) {
          const original = sources.find((source) => source.id === hit.id);
          const verifiedPath = original ? path.join(original.id.startsWith("doc:") ? prepared.source
            : path.join(home, ".teamai/published-learnings", prepared.sourceHash, "revisions", prepared.learningRevision, "files"),
          original.relativePath) : undefined;
          let actualHash;
          if (verifiedPath) actualHash = hash(await readFile(verifiedPath));
          provenance.push({ id: hit.id, status: original?.allowed && hit.file === verifiedPath
            && hit.source.contentHash === actualHash && hit.source.sourceHash === prepared.sourceHash
            && hit.source.revision === (original.id.startsWith("doc:") ? prepared.resourceRevision : prepared.learningRevision)
            ? "PASS" : "FAIL", verifiedPath, actualHash });
        }
        const protocolPass = result.exitCode === profile.expectedExit
          && (profile.expectedExit === 0 ? !!response && !parseError && response.schemaVersion === 1
            && !response.error && Array.isArray(response.hits) && response.scope === "workspace"
            && response.project === cases.logicalProject && response.limit === limit
            : !parseError && jsonError?.validSchema && jsonError.code === profile.expectedError);
        observations.push({ case: item.id, profile: profile.name, queryKind: kind, query, requestedLimit: limit,
          ...result, rawPrefix: prefix, ...(parseError ? { parseError } : {}), response, ...(jsonError ? { jsonError } : {}),
          protocol: protocolPass ? "PASS" : "FAIL", provenance,
          evidenceCoverage: groups.length ? (groups.every((group) => group.covered) ? "PASS" : "FAIL") : "NOT_APPLICABLE",
          requiredGroups: groups, firstThree: hits.slice(0, 3).map((hit, index) => ({
            rank: index + 1, id: hit.id, weak: item.weakSources.includes(hit.id),
          })), firstThreeWeakCandidates: hits.slice(0, 3).filter((hit) => item.weakSources.includes(hit.id)).map((hit) => hit.id),
          nativeOriginalReads: "NOT_APPLICABLE", permittedFixtureFileCount: sources.filter((source) => source.allowed).length,
          cliOriginalFileReadCount: "UNVERIFIED: no instrumentation", finalAnswer: "UNVERIFIED: CLI returns candidates, not a model answer",
          modelCost: "NOT_APPLICABLE", validationCostBreakdown: "UNVERIFIED: only total process elapsedMs is observed" });
      }
    }
  }
  const after = await protectedSnapshot(prepared);
  await json(path.join(output, "protected-after.json"), after);
  const protection = JSON.stringify(before) === JSON.stringify(after) ? "PASS" : "FAIL";
  const result = { schemaVersion: 1, kind: "deterministic-public-cli", declaredSourceRevision: sourceRevision,
    package: facts, fixture: frozen, resourceRevision: prepared.resourceRevision, learningsRevision: prepared.learningRevision,
    sourceHash: prepared.sourceHash, scope: "workspace", logicalProject: cases.logicalProject,
    platform: { platform: process.platform, architecture: process.arch, node: process.version },
    copilotRuntime: "UNVERIFIED: no consumer ran", model: "NOT_APPLICABLE", protocols,
    queryCount: observations.length, totalQueryElapsedMs: observations.reduce((sum, row) => sum + row.elapsedMs, 0),
    totalMeasurementElapsedMs: Math.round(performance.now() - measurementStart),
    protectedRoots: protection, observations, productAcceptance: "NOT_CLAIMED" };
  await json(path.join(output, "cli-report.json"), result);
  return { output, queryCount: result.queryCount, protectedRoots: protection,
    protocolFailures: observations.filter((row) => row.protocol === "FAIL").length,
    evidenceCoverageFailures: observations.filter((row) => row.evidenceCoverage === "FAIL").length };
}

const [mode, ...args] = process.argv.slice(2);
if (mode === "check" && args.length === 0) process.stdout.write(JSON.stringify(await check(), null, 2) + "\n");
else if (mode === "prepare" && args.length === 2) process.stdout.write(JSON.stringify(await prepare(...args), null, 2) + "\n");
else if (mode === "cli" && args.length === 4) process.stdout.write(JSON.stringify(await cli(...args), null, 2) + "\n");
else if (mode === "snapshot" && args.length === 2) {
  await safeDirectory(args[0]);
  const prepared = JSON.parse(await readFile(path.join(args[0], "prepared.json"), "utf8"));
  await safeDirectory(path.dirname(args[1]));
  await json(args[1], await protectedSnapshot(prepared));
  process.stdout.write(args[1] + "\n");
} else throw new Error("Usage: check | prepare <installed-package> <new-root> | cli <installed-package> <root> <new-output> <source-sha> | snapshot <root> <new-json-file>");
