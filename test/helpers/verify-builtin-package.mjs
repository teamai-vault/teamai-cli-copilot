// Run after build: node test/helpers/verify-builtin-package.mjs <new-absolute-evidence-directory>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import spawn from "cross-spawn";

const root = fileURLToPath(new URL("../../", import.meta.url));
const output = process.argv[2];
assert(output && path.isAbsolute(output), "An absolute task-owned evidence directory is required.");
// Exclusive creation avoids replacing another verification packet.
await mkdir(output);
const temp = path.join(output, "temp"), cache = path.join(output, "npm-cache"), install = path.join(output, "install");
await Promise.all([temp, cache, install].map((p) => mkdir(p)));
const env = { ...process.env, TEMP: temp, TMP: temp, npm_config_cache: cache };
function command(name, args, cwd = root) {
  const result = spawn.sync(name, args, { cwd, env, encoding: "utf8", windowsHide: true });
  assert.equal(result.status, 0, `${name} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}
const packed = JSON.parse(command("npm", ["pack", "--json", "--ignore-scripts", "--pack-destination", output]));
const listing = Array.isArray(packed) ? packed[0] : packed["teamai-cli-copilot"];
assert(listing?.filename && Array.isArray(listing.files), "Unexpected npm pack JSON shape.");
const tarball = path.join(output, listing.filename);
const files = new Set(listing.files.map((f) => f.path));
const referenceHashes = {};
for (const expected of ["agents/teamai-recall.agent.md", "skills/teamai/SKILL.md", "skills/teamai/references/commands.md", "dist/cli.js", "dist/copilot/builtin-agent.js"]) {
  assert(files.has(expected), "Tarball omits " + expected);
}
await writeFile(path.join(install, "package.json"), JSON.stringify({ name: "teamai-package-check", private: true }));
command("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], install);
const installed = path.join(install, "node_modules", "teamai-cli-copilot");
const pkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
assert.equal(pkg.version, "0.4.0");
assert.equal(lock.version, "0.4.0");
assert.equal(lock.packages[""].version, "0.4.0");
assert.equal(command(process.execPath, [path.join(installed, "dist", "cli.js"), "--version"]), "0.4.0");
const skill = await readFile(path.join(installed, "skills", "teamai", "SKILL.md"), "utf8");
for (const match of skill.matchAll(/\]\((references\/[^)]+)\)/g)) {
  const relative = "skills/teamai/" + match[1];
  referenceHashes[relative] = createHash("sha256").update(await readFile(path.join(installed, relative))).digest("hex");
}
for (const relative of ["agents/teamai-recall.agent.md", "skills/teamai/SKILL.md", "package.json", "dist/cli.js"]) {
  referenceHashes[relative] = createHash("sha256").update(await readFile(path.join(installed, relative))).digest("hex");
}
const source = path.join(output, "source"), cwd = path.join(output, "workspace");
await Promise.all([source, cwd].map((p) => mkdir(p)));
const plugins = [];
for (const name of ["common", "api"]) {
  const pluginRoot = path.join(source, "plugins", name);
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name, version: "0.1.0", extensions: { "com.company.teamai": { kind: name === "common" ? "common" : "role" } } }));
  plugins.push({ name, version: "0.1.0", kind: name === "common" ? "common" : "role", root: pluginRoot });
}
await mkdir(path.join(source, ".github", "plugin"), { recursive: true });
await writeFile(path.join(source, ".github", "plugin", "marketplace.json"), JSON.stringify({ name: "package-fixture", plugins: plugins.map(({ name, version }) => ({ name, version, source: `./plugins/${name}` })) }));
await writeFile(path.join(source, "skills.yaml"), "version: 1\nskills: {}\n");
const { runCli } = await import(pathToFileURL(path.join(installed, "dist", "cli.js")).href);
const { CopilotClient } = await import(pathToFileURL(path.join(installed, "dist", "copilot", "cli.js")).href);
const helper = fileURLToPath(new URL("./fake-copilot.mjs", import.meta.url));
const deliveries = [];
for (const custom of [false, true]) {
  const home = path.join(output, custom ? "custom-home" : "default-home");
  const copilotRoot = custom ? path.join(output, "custom-copilot-root") : path.join(home, ".copilot");
  if (custom) process.env.COPILOT_HOME = copilotRoot;
  else delete process.env.COPILOT_HOME;
  await mkdir(path.join(copilotRoot, "agents"), { recursive: true });
  const personal = path.join(copilotRoot, "agents", "teamai-recall.md");
  await writeFile(personal, "personal neighbor\n");
  const statePath = path.join(home, "fake-native.json");
  await mkdir(home, { recursive: true });
  await writeFile(statePath, JSON.stringify({ homeDir: home, fixtureSourceRoot: source, marketplaceName: "package-fixture", marketplaces: [], plugins: [], catalog: { "package-fixture": plugins.map(({ name, version }) => ({ name, version })) } }));
  const client = new CopilotClient(process.execPath, [helper, statePath], home);
  const stdout = [], stderr = [];
  const code = await runCli(["init", "--marketplace", source, "--role", "api"], { cwd, homeDir: home, copilot: client, loadMarketplace: async () => ({ name: "package-fixture", root: source, plugins, skills: [], dispose: async () => {} }), out: (s) => stdout.push(s), err: (s) => stderr.push(s) });
  assert.equal(code, 0, stderr.join("\n"));
  const target = path.join(copilotRoot, "agents", "teamai-recall.agent.md");
  const bytes = await readFile(target);
  assert.deepEqual(bytes, await readFile(path.join(installed, "agents", "teamai-recall.agent.md")));
  const receipt = JSON.parse(await readFile(path.join(home, ".teamai", "built-in-agents", "teamai-recall.json"), "utf8"));
  assert.equal(receipt.target, target);
  assert.equal(receipt.copilotRoot, copilotRoot);
  assert.equal(receipt.version, "0.4.0");
  assert.equal(receipt.contentHash, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(await readFile(personal, "utf8"), "personal neighbor\n");
  const bundledSkillRoot = path.join(installed, "skills", "teamai");
  for (const relative of ["SKILL.md", "references/commands.md"]) {
    assert.deepEqual(await readFile(path.join(copilotRoot, "skills", "teamai", relative)), await readFile(path.join(bundledSkillRoot, relative)));
  }
  if (custom) assert(!(await readdir(home)).includes(".copilot"), "Custom-root delivery wrote a second Copilot root.");
  deliveries.push({ custom, home, copilotRoot, target, receipt, stdout, stderr, backend: "native adapter with test fixture", consumerRuntime: "unknown" });
}
const report = { schemaVersion: 1, result: "PASS", platform: process.platform, arch: process.arch, node: process.version, cliVersion: pkg.version, tarball, tarballSha256: createHash("sha256").update(await readFile(tarball)).digest("hex"), files: [...files].sort(), installedFileHashes: referenceHashes, deliveries, consumerRuntime: "unknown" };
await writeFile(path.join(output, "package-report.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ result: report.result, tarball, tarballSha256: report.tarballSha256, installedCliVersion: pkg.version, deliveryRoots: deliveries.length, consumerRuntime: "unknown" }));
