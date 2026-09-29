import { lstat, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { MarketplaceConfig } from "../config/schema.js";
import { mergeManagedProjectPlugins, projectSettingsPath, readProjectSettings, type ProjectSettings } from "../copilot/project-settings.js";
import type { CatalogPlugin } from "../copilot/catalog.js";
import { atomicWriteFile, pathsEqual } from "../utils/fs.js";
import { runProcess } from "../utils/process.js";
import type { ProjectIdentity } from "./anchors.js";
import { loadLogicalProjects, selectedLogicalProjects } from "./manifest.js";
import { normalizeAnchor } from "./partition.js";
import type { ProjectProjection, ProjectState } from "./state.js";

interface FileChange {
  path: string;
  before?: Buffer;
  after?: Buffer;
  removeDirectoryIfEmpty?: boolean;
}

export function projectionKey(workspaceRoot: string): string {
  return normalizeAnchor(workspaceRoot);
}

export function projectionFor(state: ProjectState | undefined, workspaceRoot: string): ProjectProjection | undefined {
  return state?.projections?.[projectionKey(workspaceRoot)];
}

export function withProjection(state: ProjectState, projection: ProjectProjection): ProjectState {
  return {
    ...state,
    workspaceRoot: projection.workspaceRoot,
    projections: { ...(state.projections ?? {}), [projectionKey(projection.workspaceRoot)]: projection },
  };
}

export function withoutProjection(state: ProjectState, workspaceRoot: string): ProjectState {
  const projections = { ...(state.projections ?? {}) };
  delete projections[projectionKey(workspaceRoot)];
  const next: ProjectState = { ...state, projections };
  if (Object.keys(projections).length === 0) delete next.projections;
  return next;
}

export async function convergeLogicalProjectContext(options: {
  marketplaceRoot: string;
  plugins: CatalogPlugin[];
  marketplace: MarketplaceConfig;
  identity: ProjectIdentity;
  state?: ProjectState;
  logicalProjects: string[];
  unbind?: boolean;
  dryRun?: boolean;
}): Promise<{
  projection: ProjectProjection;
  changes: string[];
  warnings: string[];
  mergedSettings: ProjectSettings;
  managedGitExcludeEntries: string[];
}> {
  const previous = projectionFor(options.state, options.identity.workspaceRoot);
  const instructionRoot = path.join(options.identity.workspaceRoot, ".github", "instructions", "teamai");
  const contextRoot = path.join(options.identity.workspaceRoot, ".teamai", "context");
  const emptyProjection: ProjectProjection = {
    workspaceRoot: options.identity.workspaceRoot,
    logicalProjects: [],
    managedProjectPlugins: [],
    instructionRoot,
    contextRoot,
  };
  const noChanges = async () => ({
    projection: previous ?? emptyProjection,
    changes: [],
    warnings: [],
    mergedSettings: await readProjectSettings(options.identity.workspaceRoot),
    managedGitExcludeEntries: options.state?.managedGitExcludeEntries ?? [],
  });

  if (options.logicalProjects.length === 0 && !options.unbind) return noChanges();
  if (options.unbind && !previous) return noChanges();

  const projects = options.unbind
    ? []
    : selectedLogicalProjects(await loadLogicalProjects(options.marketplaceRoot, options.plugins), options.logicalProjects);
  if (previous && (previous.instructionRoot !== instructionRoot || previous.contextRoot !== contextRoot)) {
    throw new Error("Workspace projection ownership receipt does not match the current Git workspace.");
  }

  await assertSafeAncestors(instructionRoot, options.identity.workspaceRoot);
  await assertSafeAncestors(contextRoot, options.identity.workspaceRoot);
  await assertOwnedOrMissing(instructionRoot, previous?.instructionRoot === instructionRoot);
  await assertOwnedOrMissing(contextRoot, previous?.contextRoot === contextRoot);

  const settings = await readProjectSettings(options.identity.workspaceRoot);
  const desiredPlugins = [...new Set(projects.flatMap((project) => project.plugin ? [project.plugin] : []))];
  const priorOwnedPlugins = previous?.managedProjectPlugins ?? [];
  const mergedSettings = mergeManagedProjectPlugins(settings, options.marketplace, desiredPlugins, priorOwnedPlugins);
  const ownedPlugins = desiredPlugins
    .map((plugin) => `${plugin}@${options.marketplace.name}`)
    .filter((spec) => priorOwnedPlugins.includes(spec) || !(spec in (settings.enabledPlugins ?? {})));
  const warnings = desiredPlugins
    .map((plugin) => `${plugin}@${options.marketplace.name}`)
    .filter((spec) => !ownedPlugins.includes(spec) && settings.enabledPlugins?.[spec] === false)
    .map((spec) => `${spec} is user-owned and disabled; preserving its state.`);
  const operations: FileChange[] = [];

  if (options.unbind) {
    const ownedDirectories = new Set<string>();
    for (const id of previous?.logicalProjects ?? []) {
      const instructionProjectRoot = path.join(instructionRoot, id);
      const contextProjectRoot = path.join(contextRoot, id);
      await planDirectoryFiles(instructionProjectRoot, operations);
      await planDirectoryFiles(contextProjectRoot, operations);
      for (const directory of await targetDirectories(instructionProjectRoot)) ownedDirectories.add(directory);
      for (const directory of await targetDirectories(contextProjectRoot)) ownedDirectories.add(directory);
    }
    const sharedRoot = path.join(contextRoot, "shared");
    await planDirectoryFiles(sharedRoot, operations);
    for (const directory of await targetDirectories(sharedRoot)) ownedDirectories.add(directory);
    const pointer = path.join(instructionRoot, "context.instructions.md");
    const pointerBefore = await readSafeFile(pointer);
    const priorPointer = Buffer.from(pointerContents(previous?.logicalProjects ?? []), "utf8");
    if (pointerBefore && !pointerBefore.equals(priorPointer)) throw new Error(`Workspace context conflict at ${pointer}`);
    await planFile(pointer, undefined, pointerBefore, operations);
    const siblingBound = Object.entries(options.state?.projections ?? {}).some(
      ([key, projection]) => key !== projectionKey(options.identity.workspaceRoot) && projection.logicalProjects.length > 0,
    );
    let managedGitExcludeEntries = options.state?.managedGitExcludeEntries ?? [];
    if (!siblingBound && managedGitExcludeEntries.length > 0) {
      const exclude = await planGitExclude(options.identity.workspaceRoot);
      const after = exclude.before === undefined ? undefined : removeOwnedLines(exclude.before.toString("utf8"), managedGitExcludeEntries);
      await planFile(exclude.path, after, exclude.before, operations);
      managedGitExcludeEntries = [];
    }
    await planSettings(options.identity.workspaceRoot, settings, mergedSettings, operations);
    for (const root of [instructionRoot, contextRoot]) {
      if (await isSafeDirectory(root)) ownedDirectories.add(root);
    }
    for (const directory of [...ownedDirectories].sort((left, right) => right.length - left.length)) {
      operations.push({ path: directory, removeDirectoryIfEmpty: true });
    }
    const changes = await applyFileChanges(operations, options.dryRun);
    return {
      projection: emptyProjection,
      changes,
      warnings,
      mergedSettings,
      managedGitExcludeEntries,
    };
  }

  const previousIds = previous?.logicalProjects ?? [];
  const staleOwnedDirectories = new Set<string>();
  for (const id of previousIds.filter((id) => !options.logicalProjects.includes(id))) {
    const instructionProjectRoot = path.join(instructionRoot, id);
    const contextProjectRoot = path.join(contextRoot, id);
    await planDirectoryFiles(instructionProjectRoot, operations);
    await planDirectoryFiles(contextProjectRoot, operations);
    for (const directory of await targetDirectories(instructionProjectRoot)) staleOwnedDirectories.add(directory);
    for (const directory of await targetDirectories(contextProjectRoot)) staleOwnedDirectories.add(directory);
  }
  for (const project of projects) {
    await planMirrorTree(
      path.join(options.marketplaceRoot, "contexts", project.id, "instructions"),
      path.join(instructionRoot, project.id), true, options.marketplaceRoot, operations,
    );
    await planMirrorTree(
      path.join(options.marketplaceRoot, "contexts", project.id, "docs"),
      path.join(contextRoot, project.id, "docs"), false, options.marketplaceRoot, operations,
    );
    await planMirrorTree(
      path.join(options.marketplaceRoot, "learnings", project.id),
      path.join(contextRoot, project.id, "learnings"), false, options.marketplaceRoot, operations,
    );
  }
  await planMirrorTree(path.join(options.marketplaceRoot, "learnings", "shared"), path.join(contextRoot, "shared", "learnings"), false, options.marketplaceRoot, operations);
  const pointer = path.join(instructionRoot, "context.instructions.md");
  const pointerBefore = await readSafeFile(pointer);
  if (previous && pointerBefore && !pointerBefore.equals(Buffer.from(pointerContents(previous.logicalProjects), "utf8"))) {
    throw new Error(`Workspace context conflict at ${pointer}`);
  }
  await planFile(pointer, pointerContents(projects.map((project) => project.id)), pointerBefore, operations);

  const exclude = await planGitExclude(options.identity.workspaceRoot);
  const lines = new Set(exclude.before?.toString("utf8").split(/\r?\n/) ?? []);
  const excludeEntries = ["/.github/instructions/teamai/", "/.teamai/context/"];
  const missing = excludeEntries.filter((entry) => !lines.has(entry));
  const excludeText = appendLines(exclude.before?.toString("utf8") ?? "", missing);
  await planFile(exclude.path, excludeText, exclude.before, operations);
  const managedGitExcludeEntries = [...new Set([...(options.state?.managedGitExcludeEntries ?? []), ...missing])];

  await planSettings(options.identity.workspaceRoot, settings, mergedSettings, operations);
  for (const directory of [...staleOwnedDirectories].sort((left, right) => right.length - left.length)) {
    operations.push({ path: directory, removeDirectoryIfEmpty: true });
  }
  const changes = await applyFileChanges(operations, options.dryRun);
  return {
    projection: {
      workspaceRoot: options.identity.workspaceRoot,
      logicalProjects: projects.map((project) => project.id),
      managedProjectPlugins: ownedPlugins.sort(),
      instructionRoot,
      contextRoot,
    },
    changes,
    warnings,
    mergedSettings,
    managedGitExcludeEntries,
  };
}

async function assertOwnedOrMissing(root: string, owned: boolean): Promise<void> {
  try {
    const info = await lstat(root);
    if (!owned) throw new Error(`Reserved Team AI projection path is already occupied: ${root}`);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Team AI projection path: ${root}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertSafeAncestors(target: string, boundary: string): Promise<void> {
  const root = path.resolve(boundary);
  let current = path.resolve(target);
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe Team AI projection path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === root) return;
    const parent = path.dirname(current);
    if (parent === current || path.relative(root, parent).startsWith("..")) throw new Error(`Unsafe Team AI projection path: ${target}`);
    current = parent;
  }
}

async function planMirrorTree(
  sourceRoot: string,
  targetRoot: string,
  instructionsOnly: boolean,
  sourceBoundary: string,
  operations: FileChange[],
): Promise<void> {
  const files = await sourceFiles(sourceRoot, instructionsOnly, sourceBoundary);
  const installed = await targetFiles(targetRoot);
  const desired = new Map(files.map((file) => [file.relativePath, file]));
  for (const [relativePath, content] of installed) {
    if (desired.has(relativePath)) continue;
    await planFile(safeTargetPath(targetRoot, relativePath), undefined, content, operations);
  }
  for (const file of files) {
    await planFile(safeTargetPath(targetRoot, file.relativePath), file.content, installed.get(file.relativePath), operations);
  }
}

async function sourceFiles(sourceRoot: string, instructionsOnly: boolean, sourceBoundary: string): Promise<Array<{ relativePath: string; content: Buffer }>> {
  await assertSafeAncestors(sourceRoot, sourceBoundary);
  try {
    const info = await lstat(sourceRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Logical Project source: ${sourceRoot}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const files: Array<{ relativePath: string; content: Buffer }> = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) throw new Error(`Unsafe Logical Project source: ${entryPath}`);
      if (info.isDirectory()) await walk(entryPath);
      else if (info.isFile() && (!instructionsOnly || entry.name.endsWith(".instructions.md"))) {
        files.push({ relativePath: path.relative(sourceRoot, entryPath).split(path.sep).join("/"), content: await readFile(entryPath) });
      } else if (!info.isFile()) {
        throw new Error(`Unsafe Logical Project source: ${entryPath}`);
      }
    }
  }
  await walk(sourceRoot);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function targetFiles(targetRoot: string): Promise<Map<string, Buffer>> {
  try {
    const info = await lstat(targetRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Team AI projection path: ${targetRoot}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const files = new Map<string, Buffer>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) throw new Error(`Unsafe Team AI projection path: ${entryPath}`);
      if (info.isDirectory()) await walk(entryPath);
      else if (info.isFile() && info.nlink <= 1) files.set(path.relative(targetRoot, entryPath).split(path.sep).join("/"), await readFile(entryPath));
      else throw new Error(`Unsafe Team AI projection path: ${entryPath}`);
    }
  }
  await walk(targetRoot);
  return files;
}

async function targetDirectories(targetRoot: string): Promise<string[]> {
  try {
    const info = await lstat(targetRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Team AI projection path: ${targetRoot}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const directories = [targetRoot];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      const info = await lstat(entryPath);
      if (info.isSymbolicLink()) throw new Error(`Unsafe Team AI projection path: ${entryPath}`);
      if (info.isDirectory()) {
        directories.push(entryPath);
        await walk(entryPath);
      } else if (!info.isFile() || info.nlink > 1) {
        throw new Error(`Unsafe Team AI projection path: ${entryPath}`);
      }
    }
  }
  await walk(targetRoot);
  return directories;
}

async function isSafeDirectory(directory: string): Promise<boolean> {
  try {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe Team AI projection path: ${directory}`);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function safeTargetPath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Team AI projection destination '${relativePath}'.`);
  }
  return target;
}

async function planDirectoryFiles(root: string, operations: FileChange[]): Promise<void> {
  for (const [relativePath, content] of await targetFiles(root)) {
    await planFile(path.join(root, ...relativePath.split("/")), undefined, content, operations);
  }
}

async function planFile(filePath: string, desired: Buffer | string | undefined, beforeHint: Buffer | undefined, operations: FileChange[]): Promise<void> {
  const before = await readSafeFile(filePath);
  if (before === undefined ? beforeHint !== undefined : !beforeHint?.equals(before)) throw new Error(`Workspace context conflict at ${filePath}`);
  const after = typeof desired === "string" ? Buffer.from(desired, "utf8") : desired;
  if (before === undefined && after === undefined || before !== undefined && after !== undefined && before.equals(after)) return;
  operations.push({ path: filePath, before, after });
}

async function readSafeFile(filePath: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error(`Unsafe Team AI projection file: ${filePath}`);
    return await readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function planSettings(workspaceRoot: string, current: ProjectSettings, desired: ProjectSettings, operations: FileChange[]): Promise<void> {
  if (JSON.stringify(current) === JSON.stringify(desired)) return;
  const settingsPath = projectSettingsPath(workspaceRoot);
  const before = await readSafeFile(settingsPath);
  await planFile(settingsPath, `${JSON.stringify(desired, null, 2)}\n`, before, operations);
}

async function planGitExclude(workspaceRoot: string): Promise<{ path: string; before?: Buffer }> {
  const resolved = await runProcess("git", ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"], { cwd: workspaceRoot });
  if (resolved.exitCode !== 0) throw new Error("Could not resolve Git info/exclude.");
  const common = await runProcess("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: workspaceRoot });
  if (common.exitCode !== 0) throw new Error("Could not resolve Git common directory.");
  const commonDir = path.resolve(common.stdout.trim());
  const excludePath = path.resolve(resolved.stdout.trim());
  const expectedPath = path.join(commonDir, "info", "exclude");
  if (!pathsEqual(excludePath, expectedPath)) throw new Error(`Unsafe Git info/exclude path: ${excludePath}`);
  await assertSafeAncestors(path.dirname(excludePath), commonDir);
  return { path: excludePath, before: await readSafeFile(excludePath) };
}

function appendLines(current: string, entries: string[]): string {
  if (entries.length === 0) return current;
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  return `${current}${current && !current.endsWith("\n") ? newline : ""}${entries.join(newline)}${newline}`;
}

function removeOwnedLines(current: string, entries: string[]): string {
  const newline = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current.split(/\r?\n/);
  for (const entry of entries) {
    const index = lines.indexOf(entry);
    if (index >= 0) lines.splice(index, 1);
  }
  return lines.join(newline);
}

function pointerContents(ids: string[]): string {
  const paths = [".teamai/context/shared/learnings", ...ids.flatMap((id) => [`.teamai/context/${id}/docs`, `.teamai/context/${id}/learnings`])];
  return `---\napplyTo: "**"\n---\n\nActive Logical Projects: ${ids.join(", ") || "none"}\n\nRead these paths only when the task needs that context:\n${paths.map((entry) => `- ${entry}`).join("\n")}\n\nLearnings are historical team experience, not mandatory policy.\n`;
}

async function applyFileChanges(operations: FileChange[], dryRun: boolean | undefined): Promise<string[]> {
  if (dryRun) return operations.map((operation) => operation.path);
  const completed: string[] = [];
  try {
    for (const operation of operations) {
      if (operation.removeDirectoryIfEmpty) {
        if (!await isSafeDirectory(operation.path)) continue;
        try {
          await rmdir(operation.path);
          completed.push(operation.path);
        } catch (error) {
          if (["ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
          throw error;
        }
        continue;
      }
      const current = await readSafeFile(operation.path);
      if (operation.before === undefined ? current !== undefined : !current?.equals(operation.before)) {
        throw new Error(`Workspace context conflict at ${operation.path}`);
      }
      if (operation.after === undefined) await unlink(operation.path);
      else await atomicWriteFile(operation.path, operation.after);
      completed.push(operation.path);
    }
  } catch (error) {
    if (completed.length > 0) {
      throw new Error(`Partial Workspace context update; completed ${completed.length} change(s): ${completed.join(", ")}. ${(error as Error).message}`);
    }
    throw error;
  }
  return completed;
}
