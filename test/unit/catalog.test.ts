import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { loadMarketplaceCatalog, TEAM_AI_EXTENSION_NAMESPACE } from "../../src/copilot/catalog.js";
import { withFileLock } from "../../src/utils/fs.js";
import { runProcess } from "../../src/utils/process.js";
import { tempDir } from "../helpers/test-utils.js";

const cleanupRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanupRoots].map((root) => rm(root, { recursive: true, force: true })));
  cleanupRoots.clear();
});

async function trackedTempDir(prefix: string): Promise<string> {
  const root = await tempDir(prefix);
  cleanupRoots.add(root);
  return root;
}

async function createMarketplace(roleKind: string = "role", marketplaceName = "test-marketplace", roleName = "api"): Promise<string> {
  const root = await trackedTempDir("teamai-catalog-");
  await mkdir(path.join(root, ".github", "plugin"), { recursive: true });
  for (const [name, kind] of [["common", "common"], [roleName, roleKind]]) {
    await mkdir(path.join(root, "plugins", name), { recursive: true });
    await writeFile(path.join(root, "plugins", name, "plugin.json"), JSON.stringify({
      name,
      version: "0.1.0",
      extensions: { [TEAM_AI_EXTENSION_NAMESPACE]: { kind } },
    }), "utf8");
  }
  await writeFile(path.join(root, ".github", "plugin", "marketplace.json"), JSON.stringify({
    name: marketplaceName,
    plugins: ["common", roleName].map((name) => ({ name, version: "0.1.0", source: `./plugins/${name}` })),
  }), "utf8");
  await writeFile(path.join(root, "skills.yaml"), "version: 1\nskills: {}\n", "utf8");
  return root;
}

async function addSkill(root: string, directory: string, name = path.basename(directory)): Promise<void> {
  await mkdir(path.join(root, directory), { recursive: true });
  await writeFile(path.join(root, directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n`, "utf8");
}

async function git(cwd: string, args: string[]): Promise<void> {
  const result = await runProcess("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
}

async function createGitRemoteMarketplace(): Promise<{ root: string; source: string; bare: string }> {
  const root = await trackedTempDir("teamai-catalog-remote-work-");
  const bare = await trackedTempDir("teamai-catalog-remote-bare-");
  await git(bare, ["init", "--bare"]);
  await mkdir(path.join(root, ".github", "plugin"), { recursive: true });
  for (const [name, kind] of [["common", "common"], ["api", "role"]]) {
    await mkdir(path.join(root, "plugins", name), { recursive: true });
    await writeFile(path.join(root, "plugins", name, "plugin.json"), JSON.stringify({
      name,
      version: "0.1.0",
      extensions: { [TEAM_AI_EXTENSION_NAMESPACE]: { kind } },
    }), "utf8");
  }
  await writeFile(path.join(root, ".github", "plugin", "marketplace.json"), JSON.stringify({
    name: "remote-teamai",
    plugins: ["common", "api"].map((name) => ({ name, version: "0.1.0", source: `./plugins/${name}` })),
  }), "utf8");
  await writeFile(path.join(root, "skills.yaml"), "version: 1\nskills: {}\n", "utf8");
  await writeFile(path.join(root, "marker.txt"), "v1", "utf8");
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "teamai@example.invalid"]);
  await git(root, ["config", "user.name", "Team AI Test"]);
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "initial"]);
  await git(root, ["remote", "add", "origin", bare]);
  await git(root, ["push", "origin", "main"]);
  await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  return { root, source: pathToFileURL(bare).href, bare };
}

describe("Team AI Marketplace catalog", () => {
  test("discovers bare role names from extension metadata", async () => {
    const root = await createMarketplace();
    const catalog = await loadMarketplaceCatalog(root, process.cwd());
    expect(catalog.name).toBe("test-marketplace");
    expect(catalog.root.toLowerCase()).toBe(root.toLowerCase());
    expect(catalog.plugins.map(({ name, kind }) => ({ name, kind }))).toEqual([
      { name: "common", kind: "common" },
      { name: "api", kind: "role" },
    ]);
    await catalog.dispose();
  });

  test("rejects plugins without a supported Team AI kind", async () => {
    const root = await createMarketplace("other");
    await expect(loadMarketplaceCatalog(root, process.cwd())).rejects.toThrow(
      `extensions.${TEAM_AI_EXTENSION_NAMESPACE}.kind`,
    );
  });

  test.each([
    ["invalid Marketplace name", "../escape", "api"],
    ["invalid plugin name", "test-marketplace", "../escape"],
  ])("rejects an %s", async (_label, marketplaceName, roleName) => {
    const root = await createMarketplace("role", marketplaceName, roleName);
    await expect(loadMarketplaceCatalog(root, process.cwd())).rejects.toThrow();
  });

  test("discovers plugin and standalone skills from strict metadata", async () => {
    const root = await createMarketplace();
    await addSkill(root, path.join("plugins", "api", "skills", "api-review"));
    await addSkill(root, path.join("skills", "release-helper"));
    await writeFile(path.join(root, "skills.yaml"), [
      "version: 1",
      "skills:",
      "  api-review: { owner: api-team, tags: [review], standalone: true }",
      "  release-helper: { owner: release-team }",
      "",
    ].join("\n"), "utf8");

    const catalog = await loadMarketplaceCatalog(root, process.cwd());
    expect(catalog.skills.map(({ name, sourceType, plugin, sourcePath, standalone, tags }) => ({ name, sourceType, plugin, sourcePath, standalone, tags }))).toEqual([
      { name: "api-review", sourceType: "plugin", plugin: "api", sourcePath: "plugins/api/skills/api-review", standalone: true, tags: ["review"] },
      { name: "release-helper", sourceType: "standalone", plugin: undefined, sourcePath: "skills/release-helper", standalone: true, tags: [] },
    ]);
    await catalog.dispose();
  });

  test("rejects missing and stale skill metadata", async () => {
    const root = await createMarketplace();
    await addSkill(root, path.join("plugins", "api", "skills", "api-review"));
    await expect(loadMarketplaceCatalog(root, process.cwd())).rejects.toThrow("missing metadata");
    await writeFile(path.join(root, "skills.yaml"), "version: 1\nskills:\n  missing: { owner: api-team }\n", "utf8");
    await expect(loadMarketplaceCatalog(root, process.cwd())).rejects.toThrow("missing metadata");
  });

  test("uses a persistent shallow cache, tracks revisions, and supports qualified refs", async () => {
    const remote = await createGitRemoteMarketplace();
    const home = await trackedTempDir("teamai-catalog-cache-home-");
    const first = await loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home, refresh: true });
    const firstRevision = first.revision;
    expect(await readFile(path.join(first.root, "marker.txt"), "utf8")).toBe("v1");
    expect(firstRevision).toMatch(/^[0-9a-f]{40}$/);
    await expect(runProcess("git", ["rev-parse", "--is-shallow-repository"], { cwd: first.root }))
      .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("true") });
    await first.dispose();

    const cacheEntries = await readdir(path.join(home, ".teamai", "marketplaces"));
    expect(cacheEntries).toHaveLength(1);
    const cached = await loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home });
    expect(cached.root.toLowerCase()).toContain(path.join(home, ".teamai", "marketplaces").toLowerCase());
    expect(cached.revision).toBe(firstRevision);
    await cached.dispose();

    await writeFile(path.join(remote.root, "marker.txt"), "v2", "utf8");
    await git(remote.root, ["add", "marker.txt"]);
    await git(remote.root, ["commit", "-m", "update"]);
    await git(remote.root, ["push", "origin", "main"]);
    const refreshed = await loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home, refresh: true });
    expect(await readFile(path.join(refreshed.root, "marker.txt"), "utf8")).toBe("v2");
    expect(refreshed.revision).not.toBe(firstRevision);
    await refreshed.dispose();

    await git(remote.root, ["checkout", "-b", "feature"]);
    await writeFile(path.join(remote.root, "marker.txt"), "feature", "utf8");
    await git(remote.root, ["add", "marker.txt"]);
    await git(remote.root, ["commit", "-m", "feature"]);
    await git(remote.root, ["push", "origin", "feature"]);
    const qualified = await loadMarketplaceCatalog(`${remote.source}#feature`, process.cwd(), { homeDir: home, refresh: true });
    expect(await readFile(path.join(qualified.root, "marker.txt"), "utf8")).toBe("feature");
    await qualified.dispose();

    const localHome = await trackedTempDir("teamai-catalog-local-home-");
    const local = await loadMarketplaceCatalog(remote.root, process.cwd(), { homeDir: localHome, refresh: true });
    expect(local.root.toLowerCase()).toBe(remote.root.toLowerCase());
    expect(await readdir(path.join(localHome, ".teamai")).catch(() => [])).toEqual([]);
    await local.dispose();
  }, 30_000);

  test.skipIf(process.platform !== "win32")("clones and refreshes a cache with long checkout paths", async () => {
    const remote = await createGitRemoteMarketplace();
    const longPath = path.join("a".repeat(110), "a".repeat(110), "a".repeat(110), "marker.txt");
    await mkdir(path.join(remote.root, path.dirname(longPath)), { recursive: true });
    await writeFile(path.join(remote.root, longPath), "v1", "utf8");
    await git(remote.root, ["config", "core.longpaths", "true"]);
    await git(remote.root, ["add", longPath]);
    await git(remote.root, ["commit", "-m", "add long path"]);
    await git(remote.root, ["push", "origin", "main"]);

    const home = await trackedTempDir("teamai-catalog-long-path-home-");
    const initial = await loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home, refresh: true });
    expect(await readFile(path.join(initial.root, longPath), "utf8")).toBe("v1");
    await expect(runProcess("git", ["config", "--local", "--get", "core.longpaths"], { cwd: initial.root }))
      .resolves.toMatchObject({ exitCode: 0, stdout: expect.stringContaining("true") });
    await initial.dispose();

    await writeFile(path.join(remote.root, longPath), "v2", "utf8");
    await git(remote.root, ["add", longPath]);
    await git(remote.root, ["commit", "-m", "refresh long path"]);
    await git(remote.root, ["push", "origin", "main"]);
    const refreshed = await loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home, refresh: true });
    expect(await readFile(path.join(refreshed.root, longPath), "utf8")).toBe("v2");
    await refreshed.dispose();
  }, 30_000);

  test("keeps the previous checkout on fetch failure and never persists dry-run acquisition", async () => {
    const remote = await createGitRemoteMarketplace();
    const home = await trackedTempDir("teamai-catalog-failure-home-");
    const initial = await loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home, refresh: true });
    await initial.dispose();
    await rm(remote.bare, { recursive: true, force: true });

    await expect(loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home, refresh: true }))
      .rejects.toThrow("Could not refresh Marketplace");
    const preserved = await loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home });
    await expect(readFile(path.join(preserved.root, "marker.txt"))).resolves.toEqual(Buffer.from("v1"));
    await preserved.dispose();

    const missingHome = await trackedTempDir("teamai-catalog-missing-home-");
    await expect(loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: missingHome }))
      .rejects.toThrow("Run `teamai init` or `teamai sync` first.");
    const dryRunHome = await trackedTempDir("teamai-catalog-dry-home-");
    const dryRun = await loadMarketplaceCatalog(pathToFileURL(remote.root).href, process.cwd(), {
      homeDir: dryRunHome,
      refresh: true,
      dryRun: true,
    });
    expect(await readFile(path.join(dryRun.root, "marker.txt"))).toEqual(Buffer.from("v1"));
    await dryRun.dispose();
    await expect(readdir(path.join(dryRunHome, ".teamai"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  test("rejects a competing refresh while the cache lock is held", async () => {
    const remote = await createGitRemoteMarketplace();
    const home = await trackedTempDir("teamai-catalog-lock-home-");
    const initial = await loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home, refresh: true });
    await initial.dispose();
    const marketplaceRoot = path.join(home, ".teamai", "marketplaces");
    const [entry] = await readdir(marketplaceRoot);
    await withFileLock(path.join(marketplaceRoot, entry, "lock"), async () => {
      await expect(loadMarketplaceCatalog(remote.source, process.cwd(), { homeDir: home, refresh: true }))
        .rejects.toThrow("Another Team AI operation is already using");
    });
  }, 30_000);
});
