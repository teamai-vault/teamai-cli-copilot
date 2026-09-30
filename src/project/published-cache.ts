import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { teamAiHome } from "../config/global.js";
import type { CatalogPlugin } from "../copilot/catalog.js";
import { atomicWriteJson, pathsEqual, withFileLock } from "../utils/fs.js";
import { loadLogicalProjects } from "./manifest.js";

export const PUBLISHED_LEARNINGS_BRANCH = "teamai-learnings";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const SAFE_ID = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;

export interface PublishedLearningFile {
  relativePath: string;
  logicalProject: string;
  contentHash: string;
  byteLength: number;
  content: Buffer;
}

export interface PublishedLearningSnapshot {
  sourceHash: string;
  branch: typeof PUBLISHED_LEARNINGS_BRANCH;
  revision: string;
  projectIds?: string[];
  root: string;
  files: PublishedLearningFile[];
}

export interface PublishedLearningIndex {
  sourceHash: string;
  branch: typeof PUBLISHED_LEARNINGS_BRANCH;
  revision: string;
  projectIds?: string[];
  root: string;
  files: Array<Omit<PublishedLearningFile, "content">>;
}

interface SnapshotManifest {
  schemaVersion: 1;
  sourceHash: string;
  branch: typeof PUBLISHED_LEARNINGS_BRANCH;
  revision: string;
  projectIds?: string[];
  files: Array<Omit<PublishedLearningFile, "content">>;
}

export interface PublishedLearningRead {
  snapshot?: PublishedLearningSnapshot;
  error?: string;
}

export interface PublishedLearningIndexRead {
  index?: PublishedLearningIndex;
  error?: string;
}

export function publishedLearningSourceHash(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

export async function readPublishedLearningSnapshot(source: string, homeDir: string): Promise<PublishedLearningRead> {
  const result = await readPublishedLearningIndex(source, homeDir);
  if (!result.index) return { error: result.error ?? "Published Learnings snapshot is unavailable. Run `teamai sync` to refresh it." };
  try {
    const files = await readPublishedLearningFiles(result.index, result.index.files.map((file) => file.relativePath));
    return { snapshot: { ...result.index, files } };
  } catch (error) {
    return { error: `The cached published Learnings snapshot is unavailable (${safeMessage(error)}). Run \`teamai sync\` to refresh it.` };
  }
}

export async function readPublishedLearningIndex(source: string, homeDir: string): Promise<PublishedLearningIndexRead> {
  const sourceHash = publishedLearningSourceHash(source);
  const cacheRoot = cachePath(sourceHash, homeDir);
  try {
    await assertNoSymlinkPath(homeDir, cacheRoot);
    const pointerPath = path.join(cacheRoot, "current.json");
    await assertRegularFile(pointerPath);
    const pointer = JSON.parse(await readFile(pointerPath, "utf8")) as Partial<SnapshotManifest>;
    if (pointer.schemaVersion !== 1 || pointer.sourceHash !== sourceHash || pointer.branch !== PUBLISHED_LEARNINGS_BRANCH || typeof pointer.revision !== "string" || !SHA.test(pointer.revision)) {
      throw new Error("The current pointer is invalid.");
    }
    return { index: await readSnapshotIndexDirectory(cacheRoot, sourceHash, pointer.revision) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { error: "No verified published Learnings snapshot is cached. Run `teamai sync` to refresh it." };
    return { error: `The cached published Learnings snapshot is unavailable (${safeMessage(error)}). Run \`teamai sync\` to refresh it.` };
  }
}

export async function readPublishedLearningFiles(
  index: PublishedLearningIndex,
  relativePaths: string[],
): Promise<PublishedLearningFile[]> {
  const byPath = new Map(index.files.map((file) => [file.relativePath, file]));
  const seen = new Set<string>();
  const files: PublishedLearningFile[] = [];
  for (const relativePath of relativePaths) {
    const entry = byPath.get(relativePath);
    if (!entry || seen.has(relativePath)) throw new Error(`Published Learning is not present in the verified cache index: '${relativePath}'.`);
    seen.add(relativePath);
    const target = path.join(index.root, ...relativePath.split("/"));
    await assertRegularFile(target);
    const content = await readFile(target);
    verifyLearningBytes(relativePath, entry, content);
    files.push({ ...entry, content });
  }
  return files;
}

export async function readPublishedLearningSnapshotAt(source: string, homeDir: string, revision: string): Promise<PublishedLearningRead> {
  const sourceHash = publishedLearningSourceHash(source);
  const cacheRoot = cachePath(sourceHash, homeDir);
  try {
    await assertNoSymlinkPath(homeDir, cacheRoot);
    if (!SHA.test(revision)) throw new Error("Published Learnings revision is invalid.");
    return { snapshot: await readSnapshotDirectory(cacheRoot, sourceHash, revision) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { error: `Published Learnings revision ${revision} is not cached.` };
    return { error: `Published Learnings revision ${revision} is unavailable (${safeMessage(error)}).` };
  }
}

export async function refreshPublishedLearningSnapshot(options: {
  marketplaceRoot: string;
  plugins: CatalogPlugin[];
  source: string;
  homeDir: string;
  dryRun?: boolean;
}): Promise<PublishedLearningSnapshot & { dispose: () => Promise<void> }> {
  const sourceHash = publishedLearningSourceHash(options.source);
  const projectIds = (await loadLogicalProjects(options.marketplaceRoot, options.plugins)).map((project) => project.id).sort(compare);
  await assertMarketplaceRoot(options.marketplaceRoot);
  let remote: Buffer;
  try {
    remote = await git(options.marketplaceRoot, ["remote", "get-url", "origin"]);
  } catch {
    throw new Error("Published Learnings require a usable Git `origin` remote for the Marketplace source. Configure `origin` or use the Marketplace Git URL, then retry `teamai sync`.");
  }
  if (!remote.toString("utf8").trim()) {
    throw new Error("Published Learnings require a usable Git `origin` remote for the Marketplace source. Configure `origin` or use the Marketplace Git URL, then retry `teamai sync`.");
  }

  const remoteUrl = remote.toString("utf8").trim();
  if (/[\r\n]/.test(remoteUrl)) {
    throw new Error("Published Learnings require a usable Git `origin` remote for the Marketplace source. Configure `origin` or use the Marketplace Git URL, then retry `teamai sync`.");
  }
  const authority = await fetchAuthoritySnapshot(remoteUrl, projectIds);
  const { revision, files: sourceFiles } = authority;

  if (options.dryRun) {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "teamai-published-learnings-"));
    try {
      await writeSnapshotDirectory(temporaryRoot, sourceHash, revision, projectIds, sourceFiles);
      const snapshot = await readSnapshotDirectory(temporaryRoot, sourceHash, revision);
      return { ...snapshot, dispose: async () => rm(temporaryRoot, { recursive: true, force: true }) };
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  const cacheRoot = cachePath(sourceHash, options.homeDir);
  await assertNoSymlinkPath(options.homeDir, cacheRoot);
  await withFileLock(path.join(cacheRoot, "refresh.lock"), async () => {
    let reusable = false;
    let damaged = false;
    try {
      const existing = await readSnapshotDirectory(cacheRoot, sourceHash, revision);
      reusable = existing.revision === revision
        && existing.projectIds?.join("\0") === projectIds.join("\0")
        && sameAuthorityFiles(existing.files, sourceFiles);
      damaged = !reusable;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") damaged = true;
    }
    if (!reusable) {
      await writeSnapshotDirectory(cacheRoot, sourceHash, revision, projectIds, sourceFiles, damaged);
    }
    await atomicWriteJson(path.join(cacheRoot, "current.json"), {
      schemaVersion: 1,
      sourceHash,
      branch: PUBLISHED_LEARNINGS_BRANCH,
      revision,
    });
  });

  const read = await readPublishedLearningSnapshot(options.source, options.homeDir);
  if (!read.snapshot) throw new Error(`Published Learnings snapshot could not be verified after refresh. ${read.error ?? "Run teamai sync and retry."}`);
  return { ...read.snapshot, dispose: async () => undefined };
}

function sameAuthorityFiles(
  cached: PublishedLearningFile[],
  authority: Array<{ relativePath: string; logicalProject: string; content: Buffer }>,
): boolean {
  return cached.length === authority.length && authority.every((file, index) => {
    const candidate = cached[index];
    return candidate?.relativePath === file.relativePath
      && candidate.logicalProject === file.logicalProject
      && candidate.content.equals(file.content);
  });
}

async function assertMarketplaceRoot(marketplaceRoot: string): Promise<void> {
  let root: string;
  try {
    root = await realpath(marketplaceRoot);
  } catch {
    throw new Error("Marketplace source must be a readable Git repository root before published Learnings can be fetched.");
  }
  const topLevel = await git(marketplaceRoot, ["rev-parse", "--show-toplevel"]).catch(() => {
    throw new Error("Local Marketplace source must be the root of a Git repository with a usable `origin` remote, or use a Marketplace Git URL.");
  });
  let gitRoot: string;
  try {
    gitRoot = await realpath(topLevel.toString("utf8").trim());
  } catch {
    throw new Error("Local Marketplace source must be the root of a Git repository with a usable `origin` remote, or use a Marketplace Git URL.");
  }
  if (!pathsEqual(root, gitRoot)) {
    throw new Error("Marketplace source is inside a parent Git repository, not its root. Use the Marketplace repository root so published Learnings come from the same repository.");
  }
}

async function fetchAuthoritySnapshot(remoteUrl: string, projectIds: string[]): Promise<{
  revision: string;
  files: Array<{ relativePath: string; logicalProject: string; content: Buffer }>;
}> {
  const authorityRoot = await mkdtemp(path.join(os.tmpdir(), "teamai-authority-git-"));
  try {
    await git(authorityRoot, ["init", "--bare", "--quiet"]);
    await git(authorityRoot, ["remote", "add", "origin", remoteUrl]);
    const fetch = await gitResult(
      authorityRoot,
      ["fetch", "--no-tags", "--depth=1", "origin", `refs/heads/${PUBLISHED_LEARNINGS_BRANCH}`],
      { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    );
    if (fetch.exitCode !== 0) {
      throw new Error(`Could not fetch published Learnings branch '${PUBLISHED_LEARNINGS_BRANCH}' from the Marketplace Git origin (git exit code ${fetch.exitCode}). Check remote access and that the branch exists.`);
    }
    const revision = (await git(authorityRoot, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"])).toString("ascii").trim();
    if (!SHA.test(revision)) throw new Error("Git returned an invalid published Learnings revision.");
    return { revision, files: await readAuthorityFiles(authorityRoot, revision, projectIds) };
  } finally {
    await rm(authorityRoot, { recursive: true, force: true });
  }
}

async function readAuthorityFiles(root: string, revision: string, projectIds: string[]): Promise<Array<{ relativePath: string; logicalProject: string; content: Buffer }>> {
  const allowedProjects = new Set(projectIds);
  const listing = await git(root, ["ls-tree", "-r", "-l", "-z", revision]);
  const entries = listing.toString("utf8").split("\0").filter(Boolean);
  const files: Array<{ relativePath: string; logicalProject: string; content: Buffer }> = [];
  let totalBytes = 0;
  const decode = new TextDecoder("utf-8", { fatal: true });
  for (const entry of entries) {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Published Learnings tree contains a malformed Git entry.");
    const [mode, type, objectId, rawSize] = entry.slice(0, tab).trim().split(/\s+/);
    const relativePath = entry.slice(tab + 1);
    if (mode !== "100644" || type !== "blob" || !objectId || !SHA.test(objectId) || !rawSize || rawSize === "-") {
      throw new Error(`Published Learnings contains an unsupported file type at '${relativePath}'.`);
    }
    const byteLength = Number(rawSize);
    if (!Number.isSafeInteger(byteLength) || byteLength < 0) throw new Error(`Published Learnings has an invalid blob size at '${relativePath}'.`);
    const projectDirectory = relativePath.match(/^learnings\/([^/]+)\//)?.[1];
    if (projectDirectory && projectDirectory !== "shared" && SAFE_ID.test(projectDirectory) && !allowedProjects.has(projectDirectory)) {
      throw new Error(`Published Learnings references unknown Logical Project '${projectDirectory}'.`);
    }
    const logicalProject = learningProject(relativePath, allowedProjects);
    const metadataFile = relativePath === "README.md" || relativePath === ".github/CODEOWNERS";
    if (!metadataFile && logicalProject === undefined) {
      throw new Error(`Published Learnings contains a path outside the authority allowlist: '${relativePath}'.`);
    }
    if (byteLength > MAX_FILE_BYTES) throw new Error(`Published Learnings file exceeds 1 MiB: '${relativePath}'.`);
    if (logicalProject !== undefined) {
      if (files.length >= MAX_FILES) throw new Error(`Published Learnings exceeds the ${MAX_FILES}-file snapshot limit.`);
      if (totalBytes + byteLength > MAX_TOTAL_BYTES) throw new Error("Published Learnings exceeds the 64 MiB snapshot limit.");
    }
    const content = await git(root, ["cat-file", "blob", objectId]);
    if (content.byteLength !== byteLength) throw new Error(`Published Learnings blob size changed while reading '${relativePath}'.`);
    try {
      decode.decode(content);
    } catch {
      throw new Error(`Published Learnings contains non-UTF-8 content at '${relativePath}'.`);
    }
    if (logicalProject !== undefined && content.includes(0)) throw new Error(`Published Learning contains binary NUL data at '${relativePath}'.`);
    if (logicalProject === undefined) continue;
    totalBytes += byteLength;
    files.push({ relativePath, logicalProject, content });
  }
  return files.sort((left, right) => compare(left.relativePath, right.relativePath));
}

function learningProject(relativePath: string, allowedProjects?: ReadonlySet<string>): string | undefined {
  const match = relativePath.match(/^learnings\/([^/]+)\/([^/]+)\.md$/);
  if (!match || !SAFE_ID.test(match[2]!)) return undefined;
  if (match[1] === "shared") return "shared";
  return SAFE_ID.test(match[1]!) && (!allowedProjects || allowedProjects.has(match[1]!)) ? match[1] : undefined;
}

async function writeSnapshotDirectory(
  cacheRoot: string,
  sourceHash: string,
  revision: string,
  projectIds: string[],
  files: Array<{ relativePath: string; logicalProject: string; content: Buffer }>,
  replaceInvalid = false,
): Promise<void> {
  const revisions = path.join(cacheRoot, "revisions");
  await mkdir(revisions, { recursive: true });
  const destination = path.join(revisions, revision);
  const staging = path.join(revisions, `.${revision}.${process.pid}.${randomUUID()}.tmp`);
  await mkdir(path.join(staging, "files"), { recursive: true });
  try {
    const manifestFiles: SnapshotManifest["files"] = [];
    for (const file of files) {
      const target = path.join(staging, "files", ...file.relativePath.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: "wx" });
      manifestFiles.push({
        relativePath: file.relativePath,
        logicalProject: file.logicalProject,
        contentHash: sha256(file.content),
        byteLength: file.content.byteLength,
      });
    }
    const manifest: SnapshotManifest = {
      schemaVersion: 1,
      sourceHash,
      branch: PUBLISHED_LEARNINGS_BRANCH,
      revision,
      projectIds,
      files: manifestFiles,
    };
    await writeFile(path.join(staging, "snapshot.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await verifyManifestDirectory(staging, manifest);
    let existing = false;
    try {
      await lstat(destination);
      existing = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing && !replaceInvalid) throw new Error(`Published Learnings cache already contains an invalid snapshot for ${revision}.`);
    if (existing) {
      const backup = path.join(revisions, `.${revision}.${process.pid}.${randomUUID()}.invalid`);
      await rename(destination, backup);
      try {
        await rename(staging, destination);
      } catch (error) {
        await rename(backup, destination).catch(() => undefined);
        throw error;
      }
      await rm(backup, { recursive: true, force: true });
    } else {
      await rename(staging, destination);
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function readSnapshotDirectory(cacheRoot: string, sourceHash: string, revision: string): Promise<PublishedLearningSnapshot> {
  const index = await readSnapshotIndexDirectory(cacheRoot, sourceHash, revision);
  const files = await readPublishedLearningFiles(index, index.files.map((file) => file.relativePath));
  return { ...index, files };
}

async function readSnapshotIndexDirectory(cacheRoot: string, sourceHash: string, revision: string): Promise<PublishedLearningIndex> {
  if (!SHA.test(revision)) throw new Error("Published Learnings revision is invalid.");
  const directory = path.join(cacheRoot, "revisions", revision);
  await assertNoSymlinkPath(cacheRoot, directory);
  const manifestPath = path.join(directory, "snapshot.json");
  await assertRegularFile(manifestPath);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
  if (manifest.schemaVersion !== 1 || manifest.sourceHash !== sourceHash || manifest.branch !== PUBLISHED_LEARNINGS_BRANCH || manifest.revision !== revision || !Array.isArray(manifest.files)) {
    throw new Error("Published Learnings snapshot metadata does not match its current pointer.");
  }
  if (manifest.projectIds !== undefined && (
    !Array.isArray(manifest.projectIds)
    || manifest.projectIds.some((id) => typeof id !== "string" || id === "shared" || !SAFE_ID.test(id))
    || new Set(manifest.projectIds).size !== manifest.projectIds.length
  )) {
    throw new Error("Published Learnings snapshot has invalid Logical Project IDs.");
  }
  return await verifyManifestMetadataDirectory(directory, manifest);
}

async function verifyManifestDirectory(
  directory: string,
  manifest: SnapshotManifest,
): Promise<PublishedLearningFile[]> {
  const index = await verifyManifestMetadataDirectory(directory, manifest);
  return await readPublishedLearningFiles(index, index.files.map((file) => file.relativePath));
}

async function verifyManifestMetadataDirectory(
  directory: string,
  manifest: SnapshotManifest,
): Promise<PublishedLearningIndex> {
  if (manifest.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(manifest.sourceHash) || manifest.branch !== PUBLISHED_LEARNINGS_BRANCH || !SHA.test(manifest.revision) || !Array.isArray(manifest.files)) {
    throw new Error("Published Learnings snapshot metadata is invalid.");
  }
  if (manifest.projectIds !== undefined && (
    !Array.isArray(manifest.projectIds)
    || manifest.projectIds.some((id) => typeof id !== "string" || id === "shared" || !SAFE_ID.test(id))
    || new Set(manifest.projectIds).size !== manifest.projectIds.length
  )) {
    throw new Error("Published Learnings snapshot has invalid Logical Project IDs.");
  }
  const allowedProjects = manifest.projectIds ? new Set(manifest.projectIds) : undefined;
  const seen = new Set<string>();
  const files: PublishedLearningIndex["files"] = [];
  let totalBytes = 0;
  const filesRoot = path.join(directory, "files");
  const filesRootInfo = await lstat(filesRoot);
  if (filesRootInfo.isSymbolicLink() || !filesRootInfo.isDirectory()) throw new Error(`Unsafe published Learnings cache directory: ${filesRoot}`);
  const actual = await listRegularFiles(filesRoot);
  for (const entry of manifest.files) {
    if (!entry || typeof entry.relativePath !== "string" || typeof entry.logicalProject !== "string") {
      throw new Error("Published Learnings snapshot contains invalid file metadata.");
    }
    const logicalProject = learningProject(entry.relativePath, allowedProjects);
    if (logicalProject === undefined || logicalProject !== entry.logicalProject || seen.has(entry.relativePath)) {
      throw new Error("Published Learnings snapshot contains invalid or duplicate paths.");
    }
    if (!Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 || entry.byteLength > MAX_FILE_BYTES || !/^[a-f0-9]{64}$/.test(entry.contentHash)) {
      throw new Error(`Published Learnings snapshot has invalid metadata for '${entry.relativePath}'.`);
    }
    seen.add(entry.relativePath);
    totalBytes += entry.byteLength;
    if (seen.size > MAX_FILES || totalBytes > MAX_TOTAL_BYTES) throw new Error("Published Learnings snapshot exceeds its file or byte limit.");
    const target = path.join(filesRoot, ...entry.relativePath.split("/"));
    await assertRegularFile(target);
    const info = await lstat(target);
    if (info.size !== entry.byteLength) throw new Error(`Published Learnings snapshot size verification failed for '${entry.relativePath}'.`);
    files.push({ ...entry });
  }
  if (files.some((file, index) => index > 0 && compare(files[index - 1]!.relativePath, file.relativePath) > 0)) {
    throw new Error("Published Learnings snapshot paths are not sorted.");
  }
  const expected = new Set(seen);
  if (actual.size !== expected.size || [...actual.keys()].some((relativePath) => !expected.has(relativePath))) {
    throw new Error("Published Learnings snapshot directory does not match its manifest.");
  }
  return {
    sourceHash: manifest.sourceHash,
    branch: PUBLISHED_LEARNINGS_BRANCH,
    revision: manifest.revision,
    projectIds: manifest.projectIds,
    root: filesRoot,
    files,
  };
}

async function listRegularFiles(root: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) throw new Error(`Unsafe published Learnings cache entry: ${target}`);
      if (info.isDirectory()) await walk(target);
      else if (info.isFile()) files.set(path.relative(path.join(root, ".."), target).split(path.sep).join("/"), info.size);
      else throw new Error(`Unsafe published Learnings cache entry: ${target}`);
    }
  }
  await walk(root);
  return new Map([...files].map(([file, size]) => [file.slice("files/".length), size]));
}

function verifyLearningBytes(relativePath: string, entry: Omit<PublishedLearningFile, "content">, content: Buffer): void {
  if (content.byteLength !== entry.byteLength || sha256(content) !== entry.contentHash) {
    throw new Error(`Published Learnings snapshot hash verification failed for '${relativePath}'.`);
  }
  if (content.includes(0)) throw new Error(`Published Learning snapshot contains binary NUL data at '${relativePath}'.`);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`Published Learnings snapshot contains non-UTF-8 content at '${relativePath}'.`);
  }
}

async function assertRegularFile(filePath: string): Promise<void> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error(`Unsafe published Learnings cache file: ${filePath}`);
}

async function assertNoSymlinkPath(boundary: string, target: string): Promise<void> {
  const root = path.resolve(boundary);
  let current = path.resolve(target);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe published Learnings cache path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === root) return;
    const parent = path.dirname(current);
    if (parent === current || path.relative(root, parent).startsWith("..")) throw new Error(`Unsafe published Learnings cache path: ${target}`);
    current = parent;
  }
}

function cachePath(sourceHash: string, homeDir: string): string {
  return path.join(teamAiHome(homeDir), "published-learnings", sourceHash);
}

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replaceAll(/[\r\n]/g, " ").slice(0, 200);
  return "verification failed";
}

async function git(root: string, args: string[]): Promise<Buffer> {
  const result = await gitResult(root, args);
  if (result.exitCode !== 0) throw new Error(`Git command failed (exit code ${result.exitCode}).`);
  return result.stdout;
}

async function gitResult(root: string, args: string[], env?: NodeJS.ProcessEnv): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer }> {
  return await new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}
