import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { parse } from "jsonc-parser";

const [statePath, ...args] = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, "utf8"));
const root = process.env.COPILOT_HOME || path.join(state.homeDir, ".copilot");
const exact = (...expected) => args.length === expected.length && args.every((arg, index) => arg === expected[index]);
const command = args.join(" ");
const helpCommands = ["plugin install --help", "plugin enable --help", "plugin disable --help", "plugin update --help", "plugin marketplace add --help", "plugin marketplace remove --help"];

function json(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
async function save() { await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`); }

function sourceSetting(source) {
  source = source.replace(/^(?:GitHub|URL|Directory):\s*/, "");
  return path.isAbsolute(source) ? { source: "directory", path: source }
    : source.includes("://") ? { source: "git", url: source }
    : { source: "github", repo: source };
}

async function readNative(name) {
  try { return parse(await readFile(path.join(root, name), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; return {}; }
}

async function persistMarketplace(name, source) {
  await mkdir(root, { recursive: true });
  const settings = await readNative("settings.json");
  settings.extraKnownMarketplaces ??= {};
  if (source === undefined) delete settings.extraKnownMarketplaces[name];
  else {
    const prior = settings.extraKnownMarketplaces[name];
    settings.extraKnownMarketplaces[name] = { ...prior, source: { ...prior?.source, ...sourceSetting(source) } };
  }
  await writeFile(path.join(root, "settings.json"), `${JSON.stringify(settings)}\n`);
}

async function persistPlugin(row, action) {
  await mkdir(root, { recursive: true });
  const settings = await readNative("settings.json");
  settings.enabledPlugins = { ...settings.enabledPlugins, [`${row.name}@${row.marketplace}`]: row.enabled };
  await writeFile(path.join(root, "settings.json"), `${JSON.stringify(settings)}\n`);
  if (!row.cache_path) return;
  const config = await readNative("config.json");
  const installed = config.installedPlugins ?? [];
  const prior = installed.find((item) => item.name === row.name && item.marketplace === row.marketplace);
  const packageMutation = action === "install" || action === "update";
  if (!packageMutation && !prior) throw new Error(`${row.name}@${row.marketplace} has no installed record`);
  const record = packageMutation ? { ...prior, name: row.name, marketplace: row.marketplace, version: row.version, enabled: row.enabled,
    installed_at: prior?.installed_at ?? "2026-10-03T00:00:00.000Z", cache_path: state.recordCachePathOverride ?? row.cache_path, source_sha: "test-package-digest" } : { ...prior, enabled: row.enabled };
  config.installedPlugins = prior ? installed.map((item) => item === prior ? record : item) : [...installed, record];
  await writeFile(path.join(root, "config.json"), `// Native configuration\n// Installed package records\n${JSON.stringify(config)}\n`);
}

async function sourcePlugin(name, marketplace) {
  const registered = state.marketplaces.find((row) => row.name === marketplace);
  let sourceRoot = registered?.source;
  if (sourceRoot?.startsWith("file://")) {
    const checkout = path.join(path.dirname(statePath), "marketplaces", marketplace);
    await mkdir(path.dirname(checkout), { recursive: true });
    try {
      await readFile(path.join(checkout, ".github", "plugin", "marketplace.json"));
      execFileSync("git", ["-C", checkout, "pull", "--quiet", "--ff-only"], { windowsHide: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      execFileSync("git", ["clone", "--quiet", sourceRoot, checkout], { windowsHide: true });
    }
    sourceRoot = checkout;
  }
  if (!sourceRoot || !path.isAbsolute(sourceRoot)) sourceRoot = state.fixtureSourceRoot;
  const catalog = JSON.parse(await readFile(path.join(sourceRoot, ".github", "plugin", "marketplace.json"), "utf8"));
  const entry = catalog.plugins.find((row) => row.name === name);
  if (!entry) throw new Error(`Fake Marketplace does not declare ${name}`);
  const source = path.resolve(sourceRoot, entry.source);
  const manifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));
  return { source, version: manifest.version, directory: path.isAbsolute(registered?.source ?? "") };
}

async function materializePlugin(name, marketplace) {
  const plugin = await sourcePlugin(name, marketplace);
  if (plugin.directory) return { version: plugin.version };
  const target = path.join(root, "installed-plugins", marketplace, name);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(plugin.source, target, { recursive: true });
  return { version: plugin.version, cache_path: target };
}

async function inventory() {
  const settings = await readNative("settings.json");
  const config = await readNative("config.json");
  const rows = (config.installedPlugins ?? []).map((row) => ({ name: row.name, marketplace: row.marketplace, version: row.version, enabled: row.enabled, source: "installed" }));
  rows.push(...state.plugins.filter((row) => row.source === "filesystem" || row.source?.startsWith("workspace")));
  for (const [name, registered] of Object.entries(settings.extraKnownMarketplaces ?? {}).filter(([, row]) => row.source?.source === "directory")) {
    const catalog = JSON.parse(await readFile(path.join(registered.source.path, ".github", "plugin", "marketplace.json"), "utf8"));
    for (const plugin of catalog.plugins) {
      rows.push({ name: plugin.name, marketplace: name, version: plugin.version, enabled: settings.enabledPlugins?.[`${plugin.name}@${name}`] ?? false, source: "live", installedFrom: registered.source.path });
    }
  }
  return rows;
}

if (state.warning) process.stderr.write(state.warning);
if (state.failCommand === command) {
  process.stderr.write("Native fixture command failure\n"); process.exitCode = 3;
} else if (exact("--version")) {
  process.stdout.write(state.versionOutput ?? "GitHub Copilot CLI 1.0.91.\nRun 'copilot update' to check for updates.\n");
} else if (helpCommands.includes(command)) {
  process.stdout.write(`Usage: copilot ${command.replace(" --help", "")}\n`);
} else if (exact("plugin", "marketplace", "list", "--json")) {
  json("marketplaceListOutput" in state ? state.marketplaceListOutput : state.marketplaces.map((row) => ({ ...row, source: /^(?:GitHub|URL|Directory):/.test(row.source) ? row.source : path.isAbsolute(row.source) ? `Directory: ${row.source}` : `URL: ${row.source}` })));
} else if (args.length === 4 && args[0] === "plugin" && args[1] === "marketplace" && ["add", "remove"].includes(args[2])) {
  if (args[2] === "add" && !state.marketplaces.some((row) => row.name === state.marketplaceName)) state.marketplaces.push({ name: state.marketplaceName, source: args[3] });
  if (args[2] === "remove") {
    state.marketplaces = state.marketplaces.filter((row) => row.name !== args[3]);
    state.plugins = state.plugins.filter((row) => row.marketplace !== args[3]);
  }
  await persistMarketplace(args[2] === "add" ? state.marketplaceName : args[3], args[2] === "add" ? args[3] : undefined); await save();
} else if (args.length === 5 && args[0] === "plugin" && args[1] === "marketplace" && args[2] === "browse" && args[4] === "--json") {
  json("browseOutput" in state ? state.browseOutput : (state.catalog[args[3]] ?? []).map(({ name }) => ({ name, description: `Plugin ${name}` })));
} else if (exact("plugin", "list", "--json")) {
  if ("pluginListText" in state) process.stdout.write(state.pluginListText);
  else json("pluginListOutput" in state ? state.pluginListOutput : await inventory());
} else if (args.length === 3 && args[0] === "plugin" && ["install", "enable", "disable", "update"].includes(args[1]) && /^[^@]+@[^@]+$/.test(args[2])) {
  const [name, marketplace] = args[2].split("@");
  let row = state.plugins.find((item) => item.name === name && item.marketplace === marketplace);
  if (args[1] === "install") {
    if (!row) { row = { name, marketplace, enabled: true }; state.plugins.push(row); }
    Object.assign(row, await materializePlugin(name, marketplace), { enabled: true });
  } else {
    if (!row) throw new Error(`${args[2]} is not installed`);
    if (args[1] === "update") Object.assign(row, await materializePlugin(name, marketplace));
    else row.enabled = args[1] === "enable";
  }
  await persistPlugin(row, args[1]); await save();
} else {
  process.stderr.write(`Unsupported fake Copilot args: ${command}\n`);
  process.exitCode = 2;
}
