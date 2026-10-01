import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [statePath, ...args] = process.argv.slice(2);
const state = JSON.parse(await readFile(statePath, "utf8"));

async function save() {
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function json(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function materializePlugin(name, marketplace) {
  const registered = state.marketplaces.find((item) => item.name === marketplace);
  let sourceRoot = registered?.source;
  if (sourceRoot?.startsWith("file://")) {
    const checkout = path.join(path.dirname(statePath), "marketplaces", marketplace);
    await mkdir(path.dirname(checkout), { recursive: true });
    try { await readFile(path.join(checkout, ".github", "plugin", "marketplace.json")); }
    catch { execFileSync("git", ["clone", "--quiet", sourceRoot, checkout], { windowsHide: true }); }
    sourceRoot = checkout;
  }
  if (!sourceRoot || sourceRoot === "https://github.com/test-org/teamai-marketplace.git") sourceRoot = state.fixtureSourceRoot;
  let source = path.join(sourceRoot, "plugins", name);
  try {
    const manifest = JSON.parse(await readFile(path.join(sourceRoot, ".github", "plugin", "marketplace.json"), "utf8"));
    const entry = manifest.plugins.find((item) => item.name === name);
    if (!entry) throw new Error(`Fake Marketplace does not declare ${name}`);
    source = path.resolve(sourceRoot, entry.source);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const target = path.join(path.dirname(statePath), "installed-plugins", marketplace, name);
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(target, "plugin.json"), "utf8"));
  return { version: manifest.version, cache_path: target };
}

if (args[0] === "--version") {
  process.stdout.write("fake-copilot 1.0.0\n");
} else if (args.join(" ") === "plugins marketplace list --json") {
  json(state.marketplaces);
} else if (args[0] === "plugins" && args[1] === "marketplace" && args[2] === "add") {
  if (!state.marketplaces.some((item) => item.name === state.marketplaceName)) {
    state.marketplaces.push({ name: state.marketplaceName, source: args[3] });
    await save();
  }
} else if (args[0] === "plugins" && args[1] === "marketplace" && args[2] === "remove") {
  state.marketplaces = state.marketplaces.filter((item) => item.name !== args[3]);
  state.plugins = state.plugins.filter((item) => item.marketplace !== args[3]);
  await save();
} else if (args[0] === "plugins" && args[1] === "marketplace" && args[2] === "browse") {
  json(state.catalog[args[3]] ?? []);
} else if (args.join(" ") === "plugins list --kind plugin --json") {
  json({
    plugins: state.plugins.map(({ marketplace, ...item }) => ({
      ...item,
      source: item.source ?? (marketplace ? `marketplace:${marketplace}` : undefined),
    })),
    errors: [],
  });
} else if (args.join(" ") === "plugins list --kind mcp --json") {
  json({ plugins: state.mcpServers, errors: state.mcpErrors });
} else if (args[0] === "plugins" && args[1] === "install") {
  const [name, marketplace] = args[2].split("@");
  const existing = state.plugins.find((item) => item.name === name && item.marketplace === marketplace);
  const delivered = await materializePlugin(name, marketplace);
  if (existing) {
    Object.assign(existing, delivered);
    existing.enabled = true;
    await save();
  } else {
    state.plugins.push({ name, marketplace, ...delivered, enabled: true, source: `marketplace:${marketplace}` });
    await save();
  }
} else if (args[0] === "plugins" && args[1] === "enable") {
  const [name, marketplace] = args[2].split("@");
  const row = state.plugins.find((item) => item.name === name && (!marketplace || item.marketplace === marketplace));
  if (row) row.enabled = true;
  await save();
} else if (args[0] === "plugins" && args[1] === "disable") {
  const [name, marketplace] = args[2].split("@");
  const row = state.plugins.find((item) => item.name === name && (!marketplace || item.marketplace === marketplace));
  if (row) row.enabled = false;
  await save();
} else if (args[0] === "plugins" && args[1] === "update") {
  const [name, marketplace] = args[2].split("@");
  const row = state.plugins.find((item) => item.name === name && (!marketplace || item.marketplace === marketplace));
  if (row) {
    Object.assign(row, await materializePlugin(row.name, row.marketplace));
  }
  await save();
} else {
  process.stderr.write(`Unsupported fake Copilot args: ${args.join(" ")}\n`);
  process.exitCode = 2;
}
