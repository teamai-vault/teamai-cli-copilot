import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient } from "../../src/copilot/cli.js";
import type { MarketplaceCatalog } from "../../src/copilot/catalog.js";
import { runProcess } from "../../src/utils/process.js";
import { parse } from "jsonc-parser";
import type { CopilotConfigFile, CopilotInstalledPlugin, CopilotSettingsFile } from "../../src/copilot/user-state.js";

export const TEST_MARKETPLACE_NAME = "test-teamai";
export const TEST_MARKETPLACE_SOURCE = "https://github.com/test-org/teamai-marketplace.git";
let fakeAuthorityPreparation: Promise<string> | undefined;
const fakeFixtureId = `${process.pid}-${Date.now()}`;
const fakeTempRoot = realpathSync.native(os.tmpdir());
const fakeAuthorityRoot = path.join(fakeTempRoot, `teamai-test-authority-${fakeFixtureId}.git`);
const fakeMarketplaceRoot = path.join(fakeTempRoot, `teamai-fake-marketplace-${fakeFixtureId}`);
process.once("exit", () => {
  for (const root of [fakeAuthorityRoot, fakeMarketplaceRoot]) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Test cleanup must not mask the process result.
    }
  }
});

export function isPermissionError(error: unknown): boolean {
  return ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

export interface FakeCopilotState {
  homeDir: string;
  fixtureSourceRoot: string;
  marketplaceName: string;
  marketplaces: Array<{ name: string; source?: string }>;
  plugins: Array<{ name: string; marketplace?: string; version?: string; enabled: boolean; source?: string; cache_path?: string }>;
  pluginListOutput?: unknown;
  pluginListText?: string;
  marketplaceListOutput?: unknown;
  browseOutput?: unknown;
  warning?: string;
  versionOutput?: string;
  failCommand?: string;
  recordCachePathOverride?: string;
  catalog: Record<string, Array<{ name: string; version: string }>>;
}

export async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function createFakeCopilot(initial?: Partial<FakeCopilotState>, homeDir?: string): Promise<{
  client: CopilotClient;
  statePath: string;
  readState: () => Promise<FakeCopilotState>;
}> {
  await ensureFakePluginFiles(fakeMarketplaceRoot);
  const directory = await tempDir("teamai-fake-copilot-");
  const statePath = path.join(directory, "state.json");
  const state: FakeCopilotState = {
    homeDir: homeDir ?? directory,
    fixtureSourceRoot: initial?.fixtureSourceRoot ?? fakeMarketplaceRoot,
    marketplaceName: initial?.marketplaceName ?? TEST_MARKETPLACE_NAME,
    marketplaces: initial?.marketplaces ?? [],
    plugins: initial?.plugins ?? [],
    ...(initial && "pluginListOutput" in initial ? { pluginListOutput: initial.pluginListOutput } : {}),
    ...(initial && "pluginListText" in initial ? { pluginListText: initial.pluginListText } : {}),
    ...(initial && "marketplaceListOutput" in initial ? { marketplaceListOutput: initial.marketplaceListOutput } : {}),
    ...(initial && "browseOutput" in initial ? { browseOutput: initial.browseOutput } : {}),
    warning: initial?.warning,
    versionOutput: initial?.versionOutput,
    failCommand: initial?.failCommand,
    recordCachePathOverride: initial?.recordCachePathOverride,
    catalog: initial?.catalog ?? {
      [initial?.marketplaceName ?? TEST_MARKETPLACE_NAME]: [
        { name: "common", version: "0.1.0" },
        { name: "api", version: "0.1.0" },
        { name: "ios", version: "0.1.0" },
        { name: "aos", version: "0.1.0" },
        { name: "qa", version: "0.1.0" },
        { name: "design", version: "0.1.0" },
      ],
    },
  };
  await seedFakeCopilot(state);
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const helperPath = fileURLToPath(new URL("./fake-copilot.mjs", import.meta.url));
  const client = new CopilotClient(process.execPath, [helperPath, statePath], state.homeDir);
  return {
    client,
    statePath,
    readState: async () => JSON.parse(await readFile(statePath, "utf8")) as FakeCopilotState,
  };
}

export async function loadFakeMarketplace(root?: string): Promise<MarketplaceCatalog> {
  const catalogRoot = root && !/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(root)
    ? root
    : fakeMarketplaceRoot;
  await prepareFakePublishedAuthority(catalogRoot);
  const plugins = await ensureFakePluginFiles(catalogRoot);
  return {
    name: TEST_MARKETPLACE_NAME,
    root: catalogRoot,
    plugins,
    skills: [],
    dispose: async () => undefined,
  };
}

async function ensureFakePluginFiles(root: string): Promise<MarketplaceCatalog["plugins"]> {
  const plugins: MarketplaceCatalog["plugins"] = [];
  for (const name of ["common", "api", "ios", "aos", "qa", "design", "payments"]) {
    const kind = name === "common" ? "common" : name === "payments" ? "project" : "role";
    const pluginRoot = path.join(root, "plugins", name);
    await mkdir(pluginRoot, { recursive: true });
    const manifestPath = path.join(pluginRoot, "plugin.json");
    try {
      await readFile(manifestPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeFile(manifestPath, JSON.stringify({ name, version: "0.1.0", extensions: { "com.company.teamai": { kind } } }), "utf8");
    }
    plugins.push({ name, version: "0.1.0", kind, root: pluginRoot });
  }
  const catalogPath = path.join(root, ".github", "plugin", "marketplace.json");
  await mkdir(path.dirname(catalogPath), { recursive: true });
  try { await readFile(catalogPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(catalogPath, JSON.stringify({ name: TEST_MARKETPLACE_NAME, plugins: plugins.map((plugin) => ({ name: plugin.name, version: plugin.version, source: `./plugins/${plugin.name}` })) }), "utf8");
  }
  const skillsPath = path.join(root, "skills.yaml");
  try { await readFile(skillsPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await writeFile(skillsPath, "version: 1\nskills: {}\n", "utf8");
  }
  return plugins;
}

/** Explicit fixture setup; native read commands never seed or repair persisted delivery. */
async function seedFakeCopilot(state: FakeCopilotState): Promise<void> {
  if (state.marketplaces.length === 0 && state.plugins.length === 0) return;
  const root = process.env.COPILOT_HOME || path.join(state.homeDir, ".copilot");
  await mkdir(root, { recursive: true });
  const read = async <T>(name: string): Promise<T> => {
    try { return parse(await readFile(path.join(root, name), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return {} as T; }
  };
  const settings = await read<CopilotSettingsFile>("settings.json");
  const config = await read<CopilotConfigFile>("config.json");
  settings.extraKnownMarketplaces ??= {};
  settings.enabledPlugins ??= {};
  config.installedPlugins ??= [];
  for (const row of state.marketplaces) {
    if (!row.source) continue;
    const source = row.source.replace(/^(?:GitHub|URL|Directory):\s*/, "");
    const previous = settings.extraKnownMarketplaces[row.name];
    settings.extraKnownMarketplaces[row.name] = { ...previous, source: { ...previous?.source, ...(path.isAbsolute(source) ? { source: "directory", path: source } : source.includes("://") ? { source: "git", url: source } : { source: "github", repo: source }) } };
  }
  for (const row of state.plugins) {
    const source = state.marketplaces.find((item) => item.name === row.marketplace)?.source?.replace(/^(?:GitHub|URL|Directory):\s*/, "");
    if (row.source === "filesystem" || row.source?.startsWith("workspace")) continue;
    if (!row.marketplace) throw new Error(`Seeded installed Plugin '${row.name}' requires a Marketplace identity.`);
    if (!source || !path.isAbsolute(source)) {
      const target = row.cache_path ?? path.join(root, "installed-plugins", row.marketplace ?? state.marketplaceName, row.name);
      try { await lstat(target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const manifest = JSON.parse(await readFile(path.join(state.fixtureSourceRoot, ".github", "plugin", "marketplace.json"), "utf8"));
        const entry = manifest.plugins.find((item: { name: string }) => item.name === row.name);
        await mkdir(path.dirname(target), { recursive: true });
        if (entry) await cp(path.resolve(state.fixtureSourceRoot, entry.source), target, { recursive: true });
        else await mkdir(target);
        const manifestPath = path.join(target, "plugin.json");
        const seededManifest = entry ? JSON.parse(await readFile(manifestPath, "utf8")) : {};
        await writeFile(manifestPath, JSON.stringify({ ...seededManifest, name: row.name, version: row.version ?? seededManifest.version ?? "0.1.0" }), "utf8");
      }
      row.cache_path = target;
      row.version ??= JSON.parse(await readFile(path.join(target, "plugin.json"), "utf8")).version;
      const prior: CopilotInstalledPlugin | undefined = config.installedPlugins.find((item: { name: string; marketplace: string }) => item.name === row.name && item.marketplace === row.marketplace);
      const record: CopilotInstalledPlugin = { ...prior, name: row.name, marketplace: row.marketplace, version: row.version, enabled: row.enabled, cache_path: target, installed_at: prior?.installed_at ?? "2026-10-03T00:00:00.000Z", source_sha: prior?.source_sha ?? "test-package-digest" };
      config.installedPlugins = [...config.installedPlugins.filter((item: { name: string; marketplace: string }) => item.name !== row.name || item.marketplace !== row.marketplace), record];
    }
    settings.enabledPlugins[`${row.name}@${row.marketplace}`] = row.enabled;
  }
  await writeFile(path.join(root, "settings.json"), `${JSON.stringify(settings)}\n`);
  if (config.installedPlugins.length) await writeFile(path.join(root, "config.json"), `// Native configuration\n// Installed package records\n${JSON.stringify(config)}\n`);
}

export async function prepareFakePublishedAuthority(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const topLevel = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  if (topLevel.exitCode === 0) {
    if (!samePath(topLevel.stdout.trim(), root)) return;
    const origin = await runProcess("git", ["remote", "get-url", "origin"], { cwd: root });
    if (origin.exitCode === 0) return;
  } else {
    const init = await runProcess("git", ["init", "-b", "main"], { cwd: root });
    if (init.exitCode !== 0) throw new Error(init.stderr);
  }

  if (!fakeAuthorityPreparation) {
    fakeAuthorityPreparation = createFakePublishedAuthority();
    void fakeAuthorityPreparation.catch(() => { fakeAuthorityPreparation = undefined; });
  }
  const bare = await fakeAuthorityPreparation;
  const remote = await runProcess("git", ["remote", "add", "origin", bare], { cwd: root });
  if (remote.exitCode !== 0) throw new Error(remote.stderr);
}

async function createFakePublishedAuthority(): Promise<string> {
  const bareCheck = await runProcess("git", ["--git-dir", fakeAuthorityRoot, "rev-parse", "--is-bare-repository"]);
  if (bareCheck.exitCode !== 0 || bareCheck.stdout.trim() !== "true") {
    const initializedBare = await runProcess("git", ["init", "--bare", fakeAuthorityRoot]);
    if (initializedBare.exitCode !== 0) throw new Error(initializedBare.stderr);
  }

  const branch = await runProcess("git", ["ls-remote", fakeAuthorityRoot, "refs/heads/teamai-learnings"]);
  if (branch.exitCode !== 0) throw new Error(branch.stderr);
  if (!branch.stdout.trim()) {
    const seed = await tempDir("teamai-fake-authority-seed-");
    try {
      const init = await runProcess("git", ["init", "-b", "teamai-learnings"], { cwd: seed });
      if (init.exitCode !== 0) throw new Error(init.stderr);
      await runProcess("git", ["config", "user.email", "teamai@example.invalid"], { cwd: seed });
      await runProcess("git", ["config", "user.name", "Team AI Test"], { cwd: seed });
      await writeFile(path.join(seed, "README.md"), "Test published Learnings\n", "utf8");
      await mkdir(path.join(seed, ".github"), { recursive: true });
      await writeFile(path.join(seed, ".github", "CODEOWNERS"), "* @teamai\n", "utf8");
      await mkdir(path.join(seed, "learnings", "shared"), { recursive: true });
      await writeFile(path.join(seed, "learnings", "shared", "test.md"), "Test published learning\n", "utf8");
      await runProcess("git", ["add", "."], { cwd: seed });
      const commit = await runProcess("git", ["commit", "-m", "test published authority"], { cwd: seed });
      if (commit.exitCode !== 0) throw new Error(commit.stderr);
      const push = await runProcess("git", ["push", fakeAuthorityRoot, "HEAD:refs/heads/teamai-learnings"], { cwd: seed });
      if (push.exitCode !== 0) throw new Error(push.stderr);
    } finally {
      await rm(seed, { recursive: true, force: true });
    }
  }
  return fakeAuthorityRoot;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

export async function createGitRepo(): Promise<string> {
  const root = await tempDir("teamai-git-");
  const init = await runProcess("git", ["init", "-b", "main"], { cwd: root });
  if (init.exitCode !== 0) throw new Error(init.stderr);
  await runProcess("git", ["config", "user.email", "teamai@example.invalid"], { cwd: root });
  await runProcess("git", ["config", "user.name", "Team AI Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# test\n", "utf8");
  await runProcess("git", ["add", "README.md"], { cwd: root });
  const commit = await runProcess("git", ["commit", "-m", "initial"], { cwd: root });
  if (commit.exitCode !== 0) throw new Error(commit.stderr);
  return root;
}
