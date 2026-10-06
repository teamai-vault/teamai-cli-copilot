import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runCli } from "../../src/cli.js";
import { createConfig } from "../../src/config/schema.js";
import { writeGlobalConfig } from "../../src/config/global.js";
import { publishedLearningSourceHash, readPublishedLearningSnapshot, readPublishedLearningSnapshotAt } from "../../src/project/published-cache.js";
import { detectProjectIdentity } from "../../src/project/anchors.js";
import { projectionFor } from "../../src/project/context.js";
import { readProjectState } from "../../src/project/state.js";
import { refreshPublishedLearningSnapshot } from "../../src/project/published-cache.js";
import { createFakeCopilot, createGitRepo, loadFakeMarketplace, tempDir } from "../helpers/test-utils.js";
import { runProcess } from "../../src/utils/process.js";
import * as fsHelpers from "../../src/utils/fs.js";
import { loadMarketplaceCatalog } from "../../src/copilot/catalog.js";

const cleanup = new Set<string>();

afterEach(async () => {
  await Promise.all([...cleanup].map((root) => rm(root, { recursive: true, force: true })));
  cleanup.clear();
});

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}

async function readIfExists(filePath: string): Promise<Buffer | undefined> {
  try {
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeMarketplaceResources(root: string): Promise<void> {
  await write(root, ".github/plugin/marketplace.json", JSON.stringify({
    name: "test-teamai",
    plugins: [
      { name: "common", version: "0.1.0", source: "./plugins/common" },
      { name: "api", version: "0.1.0", source: "./plugins/api" },
      { name: "payments", version: "0.1.0", source: "./plugins/payments" },
    ],
  }, null, 2));
  for (const [name, kind] of [["common", "common"], ["api", "role"], ["payments", "project"]]) {
    await write(root, `plugins/${name}/plugin.json`, JSON.stringify({
      name,
      version: "0.1.0",
      extensions: { "com.company.teamai": { kind } },
    }, null, 2));
  }
  await write(root, "skills.yaml", "version: 1\nskills: {}\n");
  await write(root, "manifest/projects.yaml", "version: 1\nprojects:\n  - id: payments\n    name: Payments\n    description: Payments\n    owners: [payments]\n    plugin: payments\n  - id: risk\n    name: Risk\n    description: Risk\n    owners: [risk]\n");
  await write(root, "learnings/shared/resource-main-only.md", "wrong source\n");
  await write(root, "learnings/payments/resource-main-only.md", "wrong project source\n");
}

async function createMarketplaceRemote(): Promise<{ source: string; authorityRevision: string; resourceRepo: string; learningRepo: string; bare: string }> {
  const root = await tempDir("teamai-published-marketplace-");
  cleanup.add(root);
  const bare = path.join(root, "marketplace.git");
  const resourceRepo = path.join(root, "resource");
  const learningRepo = path.join(root, "learning");
  await mkdir(resourceRepo);
  await mkdir(learningRepo);
  await git(root, ["init", "--bare", bare]);
  for (const repo of [resourceRepo, learningRepo]) {
    await git(repo, ["init", "-b", "main"]);
    await git(repo, ["config", "user.email", "teamai@example.invalid"]);
    await git(repo, ["config", "user.name", "Team AI Test"]);
    await git(repo, ["remote", "add", "origin", bare]);
  }

  await writeMarketplaceResources(resourceRepo);
  await git(resourceRepo, ["add", "."]);
  await git(resourceRepo, ["commit", "-m", "resource branch"]);
  await git(resourceRepo, ["push", "origin", "main"]);
  await git(bare, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  await write(learningRepo, "README.md", "Published Learnings\n");
  await write(learningRepo, ".github/CODEOWNERS", "* @teamai\n");
  await write(learningRepo, "learnings/shared/31a67c90-f875-4dce-9d7d-1812b9bc23ef.md", "---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nShared published evidence\n");
  await write(learningRepo, "learnings/payments/8a54f331-4b1e-4a60-8a01-597d358433bd.md", "---\nid: 8a54f331-4b1e-4a60-8a01-597d358433bd\n---\nPayments published evidence\n");
  await write(learningRepo, "learnings/risk/88a8bddb-ad61-48ab-8879-c8d736962631.md", "---\nid: 88a8bddb-ad61-48ab-8879-c8d736962631\n---\nInactive project evidence\n");
  await git(learningRepo, ["add", "."]);
  await git(learningRepo, ["commit", "-m", "published authority snapshot"]);
  await git(learningRepo, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
  const authorityRevision = await git(learningRepo, ["rev-parse", "HEAD"]);
  return { source: resourceRepo, authorityRevision, resourceRepo, learningRepo, bare };
}

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (line: string) => stdout.push(line), err: (line: string) => stderr.push(line) };
}

describe("published Learnings sync", () => {
  describe.sequential("rejects noncanonical Learning identities before replacing last-good or projection", () => {
    const ownedRoots = new Set<string>();
    let source: string;
    let learningRepo: string;
    let authorityRevision: string;
    let homeDir: string;
    let pointer: string;
    let projected: string;
    let beforePointer: Buffer;
    let beforeProjection: Buffer;
    let options: { cwd: string; homeDir: string; copilot: Awaited<ReturnType<typeof createFakeCopilot>>["client"] };
    beforeAll(async () => {
      const priorCleanup = new Set(cleanup);
      try {
        const workspace = await createGitRepo();
        homeDir = await tempDir("teamai-uuid-admission-");
        cleanup.add(workspace);
        cleanup.add(homeDir);
        ({ source, learningRepo, authorityRevision } = await createMarketplaceRemote());
        const config = createConfig({ name: "test-teamai", source });
        config.role = "api";
        await writeGlobalConfig(config, homeDir);
        const fake = await createFakeCopilot(undefined, homeDir);
        cleanup.add(path.dirname(fake.statePath));
        options = { cwd: workspace, homeDir, copilot: fake.client };
        const initial = capture();
        expect(await runCli(["sync"], { ...options, ...initial }), initial.stderr.join("\n")).toBe(0);
        expect(await runCli(["projects", "set", "payments"], { ...options, ...capture() })).toBe(0);
        pointer = path.join(homeDir, ".teamai", "published-learnings", publishedLearningSourceHash(source), "current.json");
        projected = path.join(workspace, ".teamai", "context", "shared", "learnings", "31a67c90-f875-4dce-9d7d-1812b9bc23ef.md");
        beforePointer = await readFile(pointer);
        beforeProjection = await readFile(projected);
      } finally {
        for (const root of cleanup) if (!priorCleanup.has(root)) { ownedRoots.add(root); cleanup.delete(root); }
      }
    }, 60_000);
    afterAll(async () => {
      await Promise.all([...ownedRoots].map((root) => rm(root, { recursive: true, force: true })));
    }, 60_000);
    const uuid = "bcdba1e3-2ab5-4f49-8f90-e4f97a97889a";
    const cases = [
      { kind: "slug", name: "reviewed-learning-publication.md", content: `---\nid: ${uuid}\n---\nRejected slug\n` },
      { kind: "missing id", name: `${uuid}.md`, content: "---\ntitle: Missing id\n---\nRejected missing id\n" },
      { kind: "invalid id", name: `${uuid}.md`, content: "---\nid: invalid-id\n---\nRejected invalid id\n" },
      { kind: "mismatched id", name: `${uuid}.md`, content: "---\nid: 83b76d3b-0701-4ab5-8fea-808f24a563fe\n---\nRejected mismatched id\n" },
    ];
    test.each(cases)("rejects $kind at $name", async (invalid) => {
      const relativePath = `learnings/shared/${invalid.name}`;
      await write(learningRepo, relativePath, invalid.content);
      await git(learningRepo, ["add", "-A"]);
      await git(learningRepo, ["commit", "-m", `invalid Learning identity ${invalid.name}`]);
      await git(learningRepo, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
      const rejected = capture();
      expect(await runCli(["sync"], { ...options, ...rejected }), invalid.name).toBe(1);
      expect(await readFile(pointer)).toEqual(beforePointer);
      expect(await readFile(projected)).toEqual(beforeProjection);
      expect((await readPublishedLearningSnapshot(source, homeDir)).snapshot?.revision).toBe(authorityRevision);
      await rm(path.join(learningRepo, ...relativePath.split("/")));
    }, 60_000);
  });

  test("last-good reads reject invalid frontmatter even when manifest hashes match", async () => {
    const { source, authorityRevision, resourceRepo } = await createMarketplaceRemote();
    const homeDir = await tempDir("teamai-uuid-cache-");
    cleanup.add(homeDir);
    const catalog = await loadMarketplaceCatalog(resourceRepo, resourceRepo, { homeDir });
    await (await refreshPublishedLearningSnapshot({ marketplaceRoot: resourceRepo, plugins: catalog.plugins, source, homeDir })).dispose();
    await catalog.dispose();
    const cacheRoot = path.join(homeDir, ".teamai", "published-learnings", publishedLearningSourceHash(source));
    const revisionRoot = path.join(cacheRoot, "revisions", authorityRevision);
    const manifestPath = path.join(revisionRoot, "snapshot.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = manifest.files.find((file: { relativePath: string }) => file.relativePath.startsWith("learnings/shared/"));
    const target = path.join(revisionRoot, "files", ...entry.relativePath.split("/"));
    const pointerBefore = await readFile(path.join(cacheRoot, "current.json"));
    for (const content of ["No frontmatter id\n", "---\nid: invalid\n---\nInvalid id\n", "---\nid: bcdba1e3-2ab5-4f49-8f90-e4f97a97889a\n---\nDifferent UUID\n"]) {
      await writeFile(target, content);
      entry.byteLength = Buffer.byteLength(content);
      entry.contentHash = createHash("sha256").update(content).digest("hex");
      await writeFile(manifestPath, JSON.stringify(manifest));
      expect((await readPublishedLearningSnapshot(source, homeDir)).snapshot, content).toBeUndefined();
      expect((await readPublishedLearningSnapshotAt(source, homeDir, authorityRevision)).snapshot, content).toBeUndefined();
      expect(await readFile(path.join(cacheRoot, "current.json"))).toEqual(pointerBefore);
    }
    const slug = "learnings/shared/reviewed-learning-publication.md";
    const validBytes = "---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nValid UUID under a slug filename\n";
    entry.relativePath = slug;
    entry.byteLength = Buffer.byteLength(validBytes);
    entry.contentHash = createHash("sha256").update(validBytes).digest("hex");
    await rm(target);
    await writeFile(path.join(revisionRoot, "files", ...slug.split("/")), validBytes);
    await writeFile(manifestPath, JSON.stringify(manifest));
    expect((await readPublishedLearningSnapshot(source, homeDir)).snapshot).toBeUndefined();
    expect((await readPublishedLearningSnapshotAt(source, homeDir, authorityRevision)).snapshot).toBeUndefined();
    expect(await readFile(path.join(cacheRoot, "current.json"))).toEqual(pointerBefore);
  }, 60_000);

  test("accepts authority UUID versions independently of generated operation UUID v4", async () => {
    const { source, resourceRepo, learningRepo } = await createMarketplaceRemote();
    const homeDir = await tempDir("teamai-uuid-versions-");
    cleanup.add(homeDir);
    const ids = ["6ba7b810-9dad-11d1-80b4-00c04fd430c8", "019f8bf2-22e1-7e01-a4f8-47b5d9176fb6"];
    for (const id of ids) await write(learningRepo, `learnings/shared/${id}.md`, `---\nid: ${id}\n---\nAuthority UUID evidence\n`);
    await git(learningRepo, ["add", "-A"]);
    await git(learningRepo, ["commit", "-m", "authority UUID versions fixture"]);
    await git(learningRepo, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
    const catalog = await loadMarketplaceCatalog(resourceRepo, resourceRepo, { homeDir });
    const snapshot = await refreshPublishedLearningSnapshot({ marketplaceRoot: resourceRepo, plugins: catalog.plugins, source, homeDir });
    for (const id of ids) expect(snapshot.files.find((file) => file.relativePath === `learnings/shared/${id}.md`)?.content.toString("utf8"))
      .toBe(`---\nid: ${id}\n---\nAuthority UUID evidence\n`);
    expect((await readPublishedLearningSnapshot(source, homeDir)).snapshot?.revision).toBe(await git(learningRepo, ["rev-parse", "HEAD"]));
    await snapshot.dispose();
    await catalog.dispose();
  }, 60_000);

  describe("active role preflight", () => {
    let workspace: string;
    let source: string;
    let setupMs: number;
    beforeAll(async () => {
      const started = performance.now();
      workspace = await tempDir("teamai-role-preflight-cwd-");
      cleanup.add(workspace);
      const resource = await tempDir("teamai-role-preflight-source-");
      cleanup.add(resource);
      await write(resource, ".github/plugin/marketplace.json", JSON.stringify({ name: "test-teamai", plugins: [
        { name: "common", version: "0.1.0", source: "plugins/common" },
        { name: "api", version: "0.1.0", source: "plugins/api" },
      ] }));
      for (const [name, kind] of [["common", "common"], ["api", "role"]]) await write(resource, `plugins/${name}/plugin.json`, JSON.stringify({ name, version: "0.1.0", extensions: { "com.company.teamai": { kind } } }));
      await write(resource, "skills.yaml", "version: 1\nskills: {}\n");
      await git(resource, ["init", "--quiet"]);
      await git(resource, ["add", "."]);
      await git(resource, ["-c", "user.name=Team AI Test", "-c", "user.email=teamai@example.invalid", "commit", "--quiet", "-m", "role preflight fixture"]);
      source = pathToFileURL(resource).href;
      setupMs = performance.now() - started;
    });
  test("missing active role rejects public sync before native, config, files or cache writes", async () => {
    const fake = await createFakeCopilot();
    cleanup.add(path.dirname(fake.statePath));
    const mutations: string[] = [];
    for (const method of ["addMarketplace", "removeMarketplace", "installPlugin", "enablePlugin", "disablePlugin", "updatePlugin"] as const) {
      vi.spyOn(fake.client, method).mockImplementation(async () => { mutations.push(method); throw new Error("unexpected native mutation"); });
    }
    async function tree(root: string): Promise<Record<string, string>> {
      const files: Record<string, string> = {};
      async function visit(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const target = path.join(directory, entry.name);
          if (entry.isDirectory()) { files[path.relative(root, target)] = "directory"; await visit(target); }
          else files[path.relative(root, target)] = createHash("sha256").update(await readFile(target)).digest("hex");
        }
      }
      await visit(root);
      return files;
    }
    for (const seededCache of [false, true]) {
      const started = performance.now();
      const homeDir = await tempDir("teamai-retired-active-role-");
      cleanup.add(homeDir);
      if (seededCache) await (await loadMarketplaceCatalog(source, workspace, { homeDir, refresh: true })).dispose();
      const config = createConfig({ name: "test-teamai", source });
      config.role = "retired-role";
      await writeGlobalConfig(config, homeDir);
      const homeBefore = await tree(homeDir);
      const workspaceBefore = await tree(workspace);
      const nativeBefore = await readFile(fake.statePath);
      const output = capture();
      const commandStarted = performance.now();
      expect(await runCli(["sync"], { cwd: workspace, homeDir, copilot: fake.client, ...output })).toBe(1);
      const commandMs = performance.now() - commandStarted;
      expect(output.stderr.join("\n")).toContain("Unknown role 'retired-role'");
      expect(mutations).toEqual([]);
      expect(await tree(homeDir)).toEqual(homeBefore);
      expect(await tree(workspace)).toEqual(workspaceBefore);
      expect(await readFile(fake.statePath)).toEqual(nativeBefore);
      console.info("T16 timings", JSON.stringify({ setupMs, seededCache, caseSetupMs: commandStarted - started, commandMs, assertionsMs: performance.now() - commandStarted - commandMs }));
    }
    vi.restoreAllMocks();
  }, 20_000);
  });

  test("fake Marketplace fixture preserves an existing local origin", async () => {
    const source = await createGitRepo();
    cleanup.add(source);
    await git(source, ["remote", "add", "origin", "https://github.com/test-org/teamai-marketplace.git"]);
    const originBefore = await git(source, ["remote", "get-url", "origin"]);
    const refsBefore = await git(source, ["show-ref", "--head"]);
    const fetchHeadPath = path.join(source, ".git", "FETCH_HEAD");
    const fetchHeadBefore = await readIfExists(fetchHeadPath);

    await loadFakeMarketplace(source);

    expect(await git(source, ["remote", "get-url", "origin"])).toBe(originBefore);
    expect(await git(source, ["show-ref", "--head"])).toBe(refsBefore);
    expect(await readIfExists(fetchHeadPath)).toEqual(fetchHeadBefore);
  });

  test("dry-run leaves a local Marketplace source repository untouched", async () => {
    const workspace = await createGitRepo();
    cleanup.add(workspace);
    const homeDir = await tempDir("teamai-published-dry-run-home-");
    cleanup.add(homeDir);
    const { resourceRepo } = await createMarketplaceRemote();
    const config = createConfig({ name: "test-teamai", source: resourceRepo });
    config.role = "api";
    await writeGlobalConfig(config, homeDir);
    const fake = await createFakeCopilot(undefined, homeDir);
    cleanup.add(path.dirname(fake.statePath));
    const options = { cwd: workspace, homeDir, copilot: fake.client };
    const refsBefore = await git(resourceRepo, ["show-ref", "--head"]);
    const fetchHeadPath = path.join(resourceRepo, ".git", "FETCH_HEAD");
    const fetchHeadBefore = await readIfExists(fetchHeadPath);
    const output = capture();

    expect(await runCli(["--dry-run", "sync"], { ...options, out: output.out, err: output.err })).toBe(0);
    expect(await git(resourceRepo, ["show-ref", "--head"])).toBe(refsBefore);
    expect(await readIfExists(fetchHeadPath)).toEqual(fetchHeadBefore);
    expect(output.stderr).toEqual([]);
  }, 60_000);

  test("rejects a Marketplace source nested under another Git repository before fetching its origin", async () => {
    const workspace = await createGitRepo();
    cleanup.add(workspace);
    const homeDir = await tempDir("teamai-published-parent-git-home-");
    cleanup.add(homeDir);
    const bare = await tempDir("teamai-published-parent-origin-");
    cleanup.add(bare);
    await git(bare, ["init", "--bare"]);
    const nestedMarketplace = path.join(workspace, "marketplace");
    await writeMarketplaceResources(nestedMarketplace);
    await git(workspace, ["remote", "add", "origin", bare]);
    const config = createConfig({ name: "test-teamai", source: nestedMarketplace });
    config.role = "api";
    await writeGlobalConfig(config, homeDir);
    const fake = await createFakeCopilot(undefined, homeDir);
    cleanup.add(path.dirname(fake.statePath));
    const options = { cwd: workspace, homeDir, copilot: fake.client };
    const refsBefore = await git(workspace, ["show-ref", "--head"]);
    const fetchHeadPath = path.join(workspace, ".git", "FETCH_HEAD");
    const fetchHeadBefore = await readIfExists(fetchHeadPath);
    const output = capture();

    expect(await runCli(["sync"], { ...options, out: output.out, err: output.err })).toBe(1);
    expect(output.stderr.join("\n")).toContain("inside a parent Git repository");
    expect(await git(workspace, ["show-ref", "--head"])).toBe(refsBefore);
    expect(await readIfExists(fetchHeadPath)).toEqual(fetchHeadBefore);
  }, 60_000);

  describe.sequential("projects only shared and active Project files from the verified authority branch", () => {
    const scenario = "projects only shared and active Project files from the verified authority branch";
    const ownedRoots = new Set<string>();
    let firstPhaseComplete = false;
    let workspace: string;
    let homeDir: string;
    let source: string;
    let authorityRevision: string;
    let learningRepo: string;
    let options: { cwd: string; homeDir: string; copilot: Awaited<ReturnType<typeof createFakeCopilot>>["client"] };
    let context: string;

    beforeAll(async () => {
      const started = performance.now();
      const priorCleanup = new Set(cleanup);
      console.info("published phase", JSON.stringify({ scenario, phase: "setup", event: "start" }));
      try {
        workspace = await createGitRepo();
        cleanup.add(workspace);
        homeDir = await tempDir("teamai-published-home-");
        cleanup.add(homeDir);
        ({ source, authorityRevision, learningRepo } = await createMarketplaceRemote());
        const config = createConfig({ name: "test-teamai", source });
        config.role = "api";
        await writeGlobalConfig(config, homeDir);
        const fake = await createFakeCopilot(undefined, homeDir);
        cleanup.add(path.dirname(fake.statePath));
        options = { cwd: workspace, homeDir, copilot: fake.client };
        context = path.join(workspace, ".teamai", "context");
      } finally {
        // Transfer only this setup's registrations; outer afterEach retains other cases.
        for (const root of cleanup) {
          if (!priorCleanup.has(root)) { ownedRoots.add(root); cleanup.delete(root); }
        }
        console.info("published phase", JSON.stringify({ scenario, phase: "setup", event: "end", elapsedMs: performance.now() - started }));
      }
    }, 60_000);

    afterAll(async () => {
      vi.restoreAllMocks();
      await Promise.all([...ownedRoots].map((root) => rm(root, { recursive: true, force: true })));
      ownedRoots.clear();
    }, 60_000);

    test("projects selected Scope and repairs its published cache", async () => {
      const started = performance.now();
      console.info("published phase", JSON.stringify({ scenario, phase: "projects selected Scope and repairs its published cache", event: "start" }));
      try {
        const sync = capture();
        const bind = capture();

        expect(await runCli(["sync"], { ...options, out: sync.out, err: sync.err }), sync.stderr.join("\n")).toBe(0);
        expect(await runCli(["projects", "set", "payments"], { ...options, out: bind.out, err: bind.err })).toBe(0);

        expect(await readFile(path.join(context, "shared", "learnings", "31a67c90-f875-4dce-9d7d-1812b9bc23ef.md"), "utf8")).toBe("---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nShared published evidence\n");
        expect(await readFile(path.join(context, "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md"), "utf8")).toBe("---\nid: 8a54f331-4b1e-4a60-8a01-597d358433bd\n---\nPayments published evidence\n");
        await expect(readFile(path.join(context, "risk", "learnings", "88a8bddb-ad61-48ab-8879-c8d736962631.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(path.join(context, "shared", "learnings", "resource-main-only.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const status = capture();
        expect(await runCli(["status", "--json"], { ...options, out: status.out, err: status.err })).toBe(0);
        const snapshot = JSON.parse(status.stdout.join("\n"));
        expect(snapshot.learningsRevision).toBe(authorityRevision);
        expect(snapshot.resources.filter((resource: { kind: string }) => resource.kind === "learning").map((resource: { source: { revision?: string } }) => resource.source.revision))
          .toEqual([authorityRevision, authorityRevision]);
        expect(sync.stderr).toEqual([]);
        expect(bind.stderr).toEqual([]);
        expect(status.stderr).toEqual([]);

        const cachedSharedFile = path.join(homeDir, ".teamai", "published-learnings", publishedLearningSourceHash(source), "revisions", authorityRevision, "files", "learnings", "shared", "31a67c90-f875-4dce-9d7d-1812b9bc23ef.md");
        await writeFile(cachedSharedFile, "damaged cache entry\n", "utf8");
        const repaired = capture();
        expect(await runCli(["sync"], { ...options, out: repaired.out, err: repaired.err })).toBe(0);
        expect(await readFile(cachedSharedFile, "utf8")).toBe("---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nShared published evidence\n");
        firstPhaseComplete = true;
      } finally {
        console.info("published phase", JSON.stringify({ scenario, phase: "projects selected Scope and repairs its published cache", event: "end", elapsedMs: performance.now() - started }));
      }
    }, 60_000);

    test("rejects invalid authority updates and preserves last-good files and revision", async () => {
      const started = performance.now();
      console.info("published phase", JSON.stringify({ scenario, phase: "rejects invalid authority updates and preserves last-good files and revision", event: "start" }));
      try {
        expect(firstPhaseComplete, "The preceding phase must complete before this continuation.").toBe(true);
        await write(learningRepo, "learnings/not-in-manifest/unapproved.md", "reject the whole snapshot\n");
        await git(learningRepo, ["add", "."]);
        await git(learningRepo, ["commit", "-m", "invalid published authority update"]);
        await git(learningRepo, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
        const failedRefresh = capture();
        expect(await runCli(["sync"], { ...options, out: failedRefresh.out, err: failedRefresh.err })).toBe(1);
        expect(failedRefresh.stderr.join("\n")).toContain("unknown Logical Project 'not-in-manifest'");
        expect(await readFile(path.join(context, "shared", "learnings", "31a67c90-f875-4dce-9d7d-1812b9bc23ef.md"), "utf8")).toBe("---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nShared published evidence\n");
        const afterFailure = capture();
        expect(await runCli(["status", "--json"], { ...options, out: afterFailure.out, err: afterFailure.err })).toBe(0);
        expect(JSON.parse(afterFailure.stdout.join("\n")).learningsRevision).toBe(authorityRevision);

        await rm(path.join(learningRepo, "learnings", "not-in-manifest", "unapproved.md"), { force: true });
        await writeFile(path.join(learningRepo, "learnings", "shared", "8344e1e3-6763-49f3-b426-2cb62ea2ae25.md"), Buffer.from([65, 0, 66]));
        await git(learningRepo, ["add", "-A"]);
        await git(learningRepo, ["commit", "-m", "invalid binary authority update"]);
        await git(learningRepo, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
        const binaryRefresh = capture();
        expect(await runCli(["sync"], { ...options, out: binaryRefresh.out, err: binaryRefresh.err })).toBe(1);
        expect(binaryRefresh.stderr.join("\n")).toContain("binary NUL data");
        expect(await readFile(path.join(context, "shared", "learnings", "31a67c90-f875-4dce-9d7d-1812b9bc23ef.md"), "utf8")).toBe("---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nShared published evidence\n");
        const afterBinary = capture();
        expect(await runCli(["status", "--json"], { ...options, out: afterBinary.out, err: afterBinary.err })).toBe(0);
        expect(JSON.parse(afterBinary.stdout.join("\n")).learningsRevision).toBe(authorityRevision);

        await rm(path.join(learningRepo, "learnings", "shared", "8344e1e3-6763-49f3-b426-2cb62ea2ae25.md"), { force: true });
        await writeFile(path.join(learningRepo, "learnings", "shared", "351496b9-a91f-4077-a58c-ddc953d7ad76.md"), Buffer.alloc(1024 * 1024 + 1, 65));
        await git(learningRepo, ["add", "-A"]);
        await git(learningRepo, ["commit", "-m", "oversized authority update"]);
        await git(learningRepo, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
        const oversizedRefresh = capture();
        expect(await runCli(["sync"], { ...options, out: oversizedRefresh.out, err: oversizedRefresh.err })).toBe(1);
        expect(oversizedRefresh.stderr.join("\n")).toContain("exceeds 1 MiB");
        const afterOversized = capture();
        expect(await runCli(["status", "--json"], { ...options, out: afterOversized.out, err: afterOversized.err })).toBe(0);
        expect(JSON.parse(afterOversized.stdout.join("\n")).learningsRevision).toBe(authorityRevision);
      } finally {
        console.info("published phase", JSON.stringify({ scenario, phase: "rejects invalid authority updates and preserves last-good files and revision", event: "end", elapsedMs: performance.now() - started }));
      }
    }, 60_000);
  });

  test("a local Marketplace directory without a usable Git origin fails before sync writes", async () => {
    const repo = await createGitRepo();
    cleanup.add(repo);
    const homeDir = await tempDir("teamai-published-no-origin-home-");
    cleanup.add(homeDir);
    const source = path.join(await tempDir("teamai-published-local-marketplace-"), "local-marketplace");
    cleanup.add(path.dirname(source));
    await writeMarketplaceResources(source);
    const config = createConfig({ name: "test-teamai", source });
    config.role = "api";
    await writeGlobalConfig(config, homeDir);
    const fake = await createFakeCopilot(undefined, homeDir);
    cleanup.add(path.dirname(fake.statePath));
    const options = { cwd: repo, homeDir, copilot: fake.client };
    const initial = await fake.readState();
    const configBefore = await readFile(path.join(homeDir, ".teamai", "config.yaml"), "utf8");
    const output = capture();

    expect(await runCli(["sync"], { ...options, out: output.out, err: output.err })).toBe(1);
    expect(output.stderr.join("\n")).toContain("Git repository with a usable `origin` remote");
    expect(await fake.readState()).toEqual(initial);
    expect(await readFile(path.join(homeDir, ".teamai", "config.yaml"), "utf8")).toBe(configBefore);
    await expect(readFile(path.join(homeDir, ".copilot", "skills", "teamai", "SKILL.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const bind = capture();
    expect(await runCli(["projects", "set", "payments"], { ...options, out: bind.out, err: bind.err })).toBe(1);
    expect(bind.stderr.join("\n")).toContain("No verified published Learnings snapshot is cached");
    await expect(readFile(path.join(repo, ".teamai", "context", "shared", "learnings", "resource-main-only.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  test("records an interrupted projection and reports a removed owned Learning", async () => {
    const workspace = await createGitRepo();
    cleanup.add(workspace);
    const homeDir = await tempDir("teamai-published-checkpoint-home-");
    cleanup.add(homeDir);
    const { source, learningRepo, authorityRevision } = await createMarketplaceRemote();
    const config = createConfig({ name: "test-teamai", source });
    config.role = "api";
    await writeGlobalConfig(config, homeDir);
    const fake = await createFakeCopilot(undefined, homeDir);
    cleanup.add(path.dirname(fake.statePath));
    const options = { cwd: workspace, homeDir, copilot: fake.client };
    const initialSync = capture();
    expect(await runCli(["sync"], { ...options, out: initialSync.out, err: initialSync.err })).toBe(0);
    const bind = capture();
    expect(await runCli(["projects", "set", "payments"], { ...options, out: bind.out, err: bind.err })).toBe(0);

    await write(learningRepo, "learnings/payments/8a54f331-4b1e-4a60-8a01-597d358433bd.md", "---\nid: 8a54f331-4b1e-4a60-8a01-597d358433bd\n---\nPayments published evidence, revised\n");
    await write(learningRepo, "learnings/shared/31a67c90-f875-4dce-9d7d-1812b9bc23ef.md", "---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nShared published evidence, revised\n");
    await git(learningRepo, ["add", "-A"]);
    await git(learningRepo, ["commit", "-m", "revise published Learnings"]);
    await git(learningRepo, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
    const newRevision = await git(learningRepo, ["rev-parse", "HEAD"]);
    const removedTarget = path.join(workspace, ".teamai", "context", "shared", "learnings", "31a67c90-f875-4dce-9d7d-1812b9bc23ef.md");
    const contextRoot = path.join(workspace, ".teamai", "context");
    const originalAtomicWrite = fsHelpers.atomicWriteFile;
    let learningWrites = 0;
    const atomicWrite = vi.spyOn(fsHelpers, "atomicWriteFile").mockImplementation(async (filePath, contents) => {
      const relative = path.relative(contextRoot, path.resolve(filePath));
      if (relative !== ".." && !relative.startsWith(".." + path.sep) && relative.split(path.sep).includes("learnings")) {
        learningWrites += 1;
        if (learningWrites === 2) throw new Error("injected projection interruption");
      }
      return originalAtomicWrite(filePath, contents);
    });
    try {
      const interrupted = capture();
      expect(await runCli(["sync"], { ...options, out: interrupted.out, err: interrupted.err })).toBe(1);
      expect(interrupted.stderr.join("\n")).toContain("Partial sync; Workspace update did not complete");
    } finally {
      atomicWrite.mockRestore();
    }
    expect(learningWrites).toBe(2);
    await expect(readFile(path.join(contextRoot, "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md"), "utf8")).resolves.toBe("---\nid: 8a54f331-4b1e-4a60-8a01-597d358433bd\n---\nPayments published evidence, revised\n");
    await expect(readFile(removedTarget, "utf8")).resolves.toBe("---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nShared published evidence\n");

    await rm(path.join(learningRepo, "learnings", "shared", "31a67c90-f875-4dce-9d7d-1812b9bc23ef.md"), { force: true });
    await git(learningRepo, ["add", "-A"]);
    await git(learningRepo, ["commit", "-m", "remove published shared Learning"]);
    await git(learningRepo, ["push", "origin", "HEAD:refs/heads/teamai-learnings"]);
    const removedRevision = await git(learningRepo, ["rev-parse", "HEAD"]);
    const catalog = await loadMarketplaceCatalog(source, workspace, { refresh: true });
    try {
      const refreshed = await refreshPublishedLearningSnapshot({
        marketplaceRoot: catalog.root,
        plugins: catalog.plugins,
        source,
        homeDir,
      });
      expect(refreshed.revision).toBe(removedRevision);
      await refreshed.dispose();
    } finally {
      await catalog.dispose();
    }

    const statusOutput = capture();
    expect(await runCli(["status", "--json"], { ...options, out: statusOutput.out, err: statusOutput.err })).toBe(0);
    const status = JSON.parse(statusOutput.stdout.join("\n"));
    expect(status.learningsRevision).toBe(removedRevision);
    const incomplete = status.diagnostics.find((item: { code: string; message: string }) => item.code === "LEARNINGS_PROJECTION_INCOMPLETE");
    expect(incomplete?.message).toContain(newRevision);
    const removed = status.resources.find((item: { kind: string; name: string; reasons?: string[] }) =>
      item.kind === "learning" && item.name === "learnings/shared/31a67c90-f875-4dce-9d7d-1812b9bc23ef.md" && item.reasons?.includes("PUBLISHED_SOURCE_REMOVED"),
    );
    expect(removed).toMatchObject({ delivery: "stale", selected: false, source: { revision: authorityRevision } });
    await expect(readFile(removedTarget, "utf8")).resolves.toBe("---\nid: 31a67c90-f875-4dce-9d7d-1812b9bc23ef\n---\nShared published evidence\n");

    const doctorOutput = capture();
    expect(await runCli(["doctor", "--json"], { ...options, out: doctorOutput.out, err: doctorOutput.err })).toBe(0);
    const doctor = JSON.parse(doctorOutput.stdout.join("\n"));
    expect(doctor.learningsRevision).toBe(removedRevision);
    expect(doctor.resources).toEqual(status.resources);
    expect(doctor.diagnostics.some((item: { code: string }) => item.code === "LEARNINGS_PROJECTION_INCOMPLETE")).toBe(true);

    const completed = capture();
    expect(await runCli(["sync"], { ...options, out: completed.out, err: completed.err })).toBe(0);
    await expect(readFile(removedTarget, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    const finalStatus = capture();
    expect(await runCli(["status", "--json"], { ...options, out: finalStatus.out, err: finalStatus.err })).toBe(0);
    expect(JSON.parse(finalStatus.stdout.join("\n")).diagnostics.some((item: { code: string }) => item.code === "LEARNINGS_PROJECTION_INCOMPLETE")).toBe(false);
  }, 120_000);

  describe.sequential("sync resumes an interrupted A-to-B Projects change from the pending target", () => {
    const scenario = "sync resumes an interrupted A-to-B Projects change from the pending target";
    const ownedRoots = new Set<string>();
    let firstPhaseComplete = false;
    let workspace: string;
    let homeDir: string;
    let source: string;
    let authorityRevision: string;
    let options: { cwd: string; homeDir: string; copilot: Awaited<ReturnType<typeof createFakeCopilot>>["client"] };
    let riskLearning: string;
    let contextPointer: string;
    let identity: Awaited<ReturnType<typeof detectProjectIdentity>>;

    beforeAll(async () => {
      const started = performance.now();
      const priorCleanup = new Set(cleanup);
      console.info("published phase", JSON.stringify({ scenario, phase: "setup", event: "start" }));
      try {
        workspace = await createGitRepo();
        cleanup.add(workspace);
        homeDir = await tempDir("teamai-published-project-transition-home-");
        cleanup.add(homeDir);
        ({ source, authorityRevision } = await createMarketplaceRemote());
        const config = createConfig({ name: "test-teamai", source });
        config.role = "api";
        await writeGlobalConfig(config, homeDir);
        const fake = await createFakeCopilot(undefined, homeDir);
        cleanup.add(path.dirname(fake.statePath));
        options = { cwd: workspace, homeDir, copilot: fake.client };
      } finally {
        // Transfer only this setup's registrations; outer afterEach retains other cases.
        for (const root of cleanup) {
          if (!priorCleanup.has(root)) { ownedRoots.add(root); cleanup.delete(root); }
        }
        console.info("published phase", JSON.stringify({ scenario, phase: "setup", event: "end", elapsedMs: performance.now() - started }));
      }
    }, 60_000);

    afterAll(async () => {
      vi.restoreAllMocks();
      await Promise.all([...ownedRoots].map((root) => rm(root, { recursive: true, force: true })));
      ownedRoots.clear();
    }, 60_000);

    test("records the pending target and guards all Projects retries", async () => {
      const started = performance.now();
      console.info("published phase", JSON.stringify({ scenario, phase: "records the pending target and guards all Projects retries", event: "start" }));
      try {
        expect(await runCli(["sync"], { ...options, ...capture() })).toBe(0);
        expect(await runCli(["projects", "set", "payments"], { ...options, ...capture() })).toBe(0);

        riskLearning = path.join(workspace, ".teamai", "context", "risk", "learnings", "88a8bddb-ad61-48ab-8879-c8d736962631.md");
        contextPointer = path.join(workspace, ".github", "instructions", "teamai", "context.instructions.md");
        identity = await detectProjectIdentity(workspace);
        const beforeDryRun = await readProjectState(identity!.projectAnchor, homeDir);
        const dryRun = capture();
        expect(await runCli(["--dry-run", "projects", "set", "risk"], { ...options, out: dryRun.out, err: dryRun.err })).toBe(0);
        expect(dryRun.stdout.some((line) => line.startsWith("WOULD write:"))).toBe(true);
        expect(await readProjectState(identity!.projectAnchor, homeDir)).toEqual(beforeDryRun);
        await expect(readFile(path.join(workspace, ".teamai", "context", "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md"), "utf8")).resolves.toBe("---\nid: 8a54f331-4b1e-4a60-8a01-597d358433bd\n---\nPayments published evidence\n");
        await expect(readFile(riskLearning, "utf8")).rejects.toMatchObject({ code: "ENOENT" });

        const originalAtomicWrite = fsHelpers.atomicWriteFile;
        const interruptedWrite = vi.spyOn(fsHelpers, "atomicWriteFile").mockImplementation(async (filePath, contents) => {
          if (path.resolve(filePath) === path.resolve(contextPointer)) {
            await originalAtomicWrite(filePath, contents);
            throw new Error("injected project context pointer interruption");
          }
          return originalAtomicWrite(filePath, contents);
        });
        try {
          const transition = capture();
          expect(await runCli(["projects", "set", "risk"], { ...options, out: transition.out, err: transition.err })).toBe(1);
          expect(transition.stderr.join("\n")).toContain("Partial Workspace project update");
          expect(transition.stderr.join("\n")).toContain("injected project context pointer interruption");
        } finally {
          interruptedWrite.mockRestore();
        }

        const checkpointState = await readProjectState(identity!.projectAnchor, homeDir);
        const checkpoint = projectionFor(checkpointState, identity!.workspaceRoot);
        expect(checkpoint?.logicalProjects).toEqual(["payments"]);
        expect(checkpoint?.pendingLogicalProjects).toEqual(["risk"]);
        expect(checkpoint?.pendingPublishedLearningRevision).toBe(authorityRevision);
        await expect(readFile(contextPointer, "utf8")).resolves.toContain("Active Logical Projects: risk");
        await expect(readFile(path.join(workspace, ".teamai", "context", "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(riskLearning, "utf8")).resolves.toBe("---\nid: 88a8bddb-ad61-48ab-8879-c8d736962631\n---\nInactive project evidence\n");

        const retries = [
          ["projects", "set", "payments"],
          ["projects", "set", "payments,risk"],
          ["projects", "set"],
          ["--dry-run", "projects", "set", "payments"],
        ];
        for (const args of retries) {
          const rejected = capture();
          expect(await runCli(args, { ...options, out: rejected.out, err: rejected.err })).toBe(1);
          expect(rejected.stderr.join("\n")).toContain("Run `teamai sync` before retrying `teamai projects set`");
          expect(await readProjectState(identity!.projectAnchor, homeDir)).toEqual(checkpointState);
          await expect(readFile(contextPointer, "utf8")).resolves.toContain("Active Logical Projects: risk");
          await expect(readFile(path.join(workspace, ".teamai", "context", "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          await expect(readFile(riskLearning, "utf8")).resolves.toBe("---\nid: 88a8bddb-ad61-48ab-8879-c8d736962631\n---\nInactive project evidence\n");
          await expect(readFile(path.join(workspace, ".github", "copilot", "settings.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        }
        firstPhaseComplete = true;
      } finally {
        console.info("published phase", JSON.stringify({ scenario, phase: "records the pending target and guards all Projects retries", event: "end", elapsedMs: performance.now() - started }));
      }
    }, 60_000);

    test("recovers through sync and preserves tamper, switching and unbind behavior", async () => {
      const started = performance.now();
      console.info("published phase", JSON.stringify({ scenario, phase: "recovers through sync and preserves tamper, switching and unbind behavior", event: "start" }));
      try {
        expect(firstPhaseComplete, "The preceding phase must complete before this continuation.").toBe(true);
        const resumed = capture();
        expect(await runCli(["sync"], { ...options, out: resumed.out, err: resumed.err })).toBe(0);
        await expect(readFile(path.join(workspace, ".teamai", "context", "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(riskLearning, "utf8")).resolves.toBe("---\nid: 88a8bddb-ad61-48ab-8879-c8d736962631\n---\nInactive project evidence\n");

        const completedState = await readProjectState(identity!.projectAnchor, homeDir);
        const completed = projectionFor(completedState, identity!.workspaceRoot);
        expect(completed?.logicalProjects).toEqual(["risk"]);
        expect(completed?.publishedLearningRevision).toBe(authorityRevision);
        expect(completed?.pendingPublishedLearningRevision).toBeUndefined();
        expect(completed?.pendingLogicalProjects).toBeUndefined();

        const completedPointer = await readFile(contextPointer, "utf8");
        await writeFile(contextPointer, "user edited pointer\n", "utf8");
        const tampered = capture();
        expect(await runCli(["projects", "set", "risk"], { ...options, out: tampered.out, err: tampered.err })).toBe(1);
        expect(tampered.stderr.join("\n")).toContain("Workspace context conflict");
        await expect(readFile(contextPointer, "utf8")).resolves.toBe("user edited pointer\n");

        await writeFile(contextPointer, completedPointer, "utf8");
        const switchBack = capture();
        expect(await runCli(["projects", "set", "payments"], { ...options, out: switchBack.out, err: switchBack.err })).toBe(0);
        await expect(readFile(path.join(workspace, ".teamai", "context", "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md"), "utf8")).resolves.toBe("---\nid: 8a54f331-4b1e-4a60-8a01-597d358433bd\n---\nPayments published evidence\n");
        await expect(readFile(riskLearning, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        const switchState = await readProjectState(identity!.projectAnchor, homeDir);
        expect(projectionFor(switchState, identity!.workspaceRoot)?.logicalProjects).toEqual(["payments"]);
        expect(projectionFor(switchState, identity!.workspaceRoot)?.pendingLogicalProjects).toBeUndefined();

        const unbound = capture();
        expect(await runCli(["projects", "set"], { ...options, out: unbound.out, err: unbound.err })).toBe(0);
        await expect(readFile(path.join(workspace, ".teamai", "context", "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
        expect(projectionFor(await readProjectState(identity!.projectAnchor, homeDir), identity!.workspaceRoot)).toBeUndefined();
      } finally {
        console.info("published phase", JSON.stringify({ scenario, phase: "recovers through sync and preserves tamper, switching and unbind behavior", event: "end", elapsedMs: performance.now() - started }));
      }
    }, 60_000);
  });

  test("sync recovers a first Project binding after a late context projection failure", async () => {
    const workspace = await createGitRepo();
    cleanup.add(workspace);
    const homeDir = await tempDir("teamai-published-first-binding-home-");
    cleanup.add(homeDir);
    const { source, resourceRepo, authorityRevision } = await createMarketplaceRemote();
    await write(resourceRepo, "contexts/payments/docs/guide.md", "Project guide v1\n");
    await git(resourceRepo, ["add", "."]);
    await git(resourceRepo, ["commit", "-m", "add Project guide v1"]);
    await git(resourceRepo, ["push", "origin", "main"]);
    const config = createConfig({ name: "test-teamai", source });
    config.role = "api";
    await writeGlobalConfig(config, homeDir);
    const fake = await createFakeCopilot(undefined, homeDir);
    cleanup.add(path.dirname(fake.statePath));
    const options = { cwd: workspace, homeDir, copilot: fake.client };
    expect(await runCli(["sync"], { ...options, ...capture() })).toBe(0);

    const identity = await detectProjectIdentity(workspace);
    const contextPointer = path.join(workspace, ".github", "instructions", "teamai", "context.instructions.md");
    const gitExclude = await git(workspace, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]);
    const paymentLearning = path.join(workspace, ".teamai", "context", "payments", "learnings", "8a54f331-4b1e-4a60-8a01-597d358433bd.md");
    const paymentDocument = path.join(workspace, ".teamai", "context", "payments", "docs", "guide.md");
    async function cachedDocumentBytes(): Promise<Buffer> {
      const catalog = await loadMarketplaceCatalog(source, workspace, { homeDir });
      try {
        expect(catalog.revision).toBe(await git(resourceRepo, ["rev-parse", "HEAD"]));
        return await readFile(path.join(catalog.root, "contexts", "payments", "docs", "guide.md"));
      } finally {
        await catalog.dispose();
      }
    }
    const v1Bytes = await cachedDocumentBytes();
    const originalAtomicWrite = fsHelpers.atomicWriteFile;
    const interruptedWrite = vi.spyOn(fsHelpers, "atomicWriteFile").mockImplementation(async (filePath, contents) => {
      if (path.resolve(filePath) === path.resolve(gitExclude)) throw new Error("injected first-binding Git exclude interruption");
      return originalAtomicWrite(filePath, contents);
    });
    try {
      const binding = capture();
      expect(await runCli(["projects", "set", "payments"], { ...options, out: binding.out, err: binding.err })).toBe(1);
      expect(binding.stderr.join("\n")).toContain("injected first-binding Git exclude interruption");
    } finally {
      interruptedWrite.mockRestore();
    }

    const pendingState = await readProjectState(identity!.projectAnchor, homeDir);
    const pending = projectionFor(pendingState, identity!.workspaceRoot);
    expect(pending?.logicalProjects).toEqual([]);
    expect(pending?.pendingLogicalProjects).toEqual(["payments"]);
    expect(pending?.pendingPublishedLearningRevision).toBe(authorityRevision);
    await expect(readFile(contextPointer, "utf8")).resolves.toContain("Active Logical Projects: payments");
    await expect(readFile(paymentLearning, "utf8")).resolves.toBe("---\nid: 8a54f331-4b1e-4a60-8a01-597d358433bd\n---\nPayments published evidence\n");
    await expect(readFile(paymentDocument)).resolves.toEqual(v1Bytes);
    const v1Hash = createHash("sha256").update(v1Bytes).digest("hex");
    const relativeDocument = ".teamai/context/payments/docs/guide.md";
    expect(pending?.pendingContextFiles?.some((item) => item.targetPath === relativeDocument && item.contentHash === v1Hash)).toBe(true);

    await write(resourceRepo, "contexts/payments/docs/guide.md", "Project guide v2\n");
    await git(resourceRepo, ["add", "."]);
    await git(resourceRepo, ["commit", "-m", "revise Project guide to v2"]);
    await git(resourceRepo, ["push", "origin", "main"]);
    const originalAtomicWriteV2 = fsHelpers.atomicWriteFile;
    const interruptedV2 = vi.spyOn(fsHelpers, "atomicWriteFile").mockImplementation(async (filePath, contents) => {
      if (path.resolve(filePath) === path.resolve(paymentDocument)) throw new Error("injected v2 Project document interruption");
      return originalAtomicWriteV2(filePath, contents);
    });
    try {
      const v2Interrupted = capture();
      expect(await runCli(["sync"], { ...options, out: v2Interrupted.out, err: v2Interrupted.err })).toBe(1);
      expect(v2Interrupted.stderr.join("\n")).toContain("injected v2 Project document interruption");
    } finally {
      interruptedV2.mockRestore();
    }
    const v2Pending = projectionFor(await readProjectState(identity!.projectAnchor, homeDir), identity!.workspaceRoot);
    const v2Bytes = await cachedDocumentBytes();
    expect(v2Bytes).not.toEqual(v1Bytes);
    const v2Hash = createHash("sha256").update(v2Bytes).digest("hex");
    expect(v2Pending?.pendingContextFiles?.some((item) => item.targetPath === relativeDocument && item.contentHash === v1Hash)).toBe(true);
    expect(v2Pending?.pendingContextFiles?.some((item) => item.targetPath === relativeDocument && item.contentHash === v2Hash)).toBe(true);
    await expect(readFile(paymentDocument)).resolves.toEqual(v1Bytes);

    expect(await runCli(["sync"], { ...options, ...capture() })).toBe(0);
    const completed = projectionFor(await readProjectState(identity!.projectAnchor, homeDir), identity!.workspaceRoot);
    expect(completed?.logicalProjects).toEqual(["payments"]);
    expect(completed?.publishedLearningRevision).toBe(authorityRevision);
    expect(completed?.pendingPublishedLearningRevision).toBeUndefined();
    expect(completed?.pendingLogicalProjects).toBeUndefined();
    expect(completed?.managedContextFiles?.some((item) => item.targetPath === relativeDocument && item.contentHash === v2Hash)).toBe(true);
    expect(completed?.pendingContextFiles).toBeUndefined();
    await expect(readFile(paymentDocument)).resolves.toEqual(v2Bytes);
  }, 180_000);
});
