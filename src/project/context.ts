import { createHash } from "node:crypto";
import { lstat, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse as parseJsonc, type ParseError } from "jsonc-parser";
import type { MarketplaceConfig } from "../config/schema.js";
import { projectSettingsPath, readProjectSettings, type ProjectSettings } from "../copilot/project-settings.js";
import type { CatalogPlugin } from "../copilot/catalog.js";
import { atomicWriteFile, pathsEqual } from "../utils/fs.js";
import { runProcess } from "../utils/process.js";
import type { ProjectIdentity } from "./anchors.js";
import { loadLogicalProjects, selectedLogicalProjects } from "./manifest.js";
import { normalizeAnchor } from "./partition.js";
import type { ProjectContextFileReceipt, ProjectProjection, ProjectState } from "./state.js";
import { convergeProjectComponents } from "./components.js";

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

export function markPublishedLearningPending(projection: ProjectProjection, revision: string, logicalProjects = projection.logicalProjects): ProjectProjection {
  return { ...projection, pendingPublishedLearningRevision: revision, pendingLogicalProjects: [...logicalProjects] };
}

export function markPublishedLearningComplete(projection: ProjectProjection, revision: string): ProjectProjection {
  const next = { ...projection, publishedLearningRevision: revision };
  delete next.pendingPublishedLearningRevision;
  delete next.pendingLogicalProjects;
  delete next.pendingProjectComponents;
  return next;
}

export function markProjectUpdatePending(
  current: ProjectProjection,
  planned: ProjectProjection,
  logicalProjects: string[],
  learningRevision?: string,
): ProjectProjection {
  return {
    ...current,
    pendingLogicalProjects: [...logicalProjects],
    pendingProjectComponents: mergeReceipts(
      current.managedProjectComponents,
      current.pendingProjectComponents,
      planned.managedProjectComponents,
    ),
    pendingContextFiles: mergeReceipts(
      current.managedContextFiles,
      current.pendingContextFiles,
      planned.managedContextFiles,
    ),
    ...(learningRevision ? { pendingPublishedLearningRevision: learningRevision } : {}),
  };
}

function mergeReceipts<T extends { targetPath: string; contentHash: string }>(...groups: Array<T[] | undefined>): T[] {
  const receipts = new Map<string, T>();
  for (const receipt of groups.flatMap((group) => group ?? [])) {
    receipts.set(`${receipt.targetPath}\0${receipt.contentHash}`, receipt);
  }
  return [...receipts.values()];
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
  homeDir?: string;
  sourceRevision?: string;
  publishedLearningRoot?: string;
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
    managedContextFiles: [],
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
  const mergedSettings = settings;
  const warnings: string[] = [];
  const operations: FileChange[] = [];

  if (options.unbind) {
    const ownedDirectories = new Set<string>();
    for (const id of previous?.logicalProjects ?? []) {
      const instructionProjectRoot = path.join(instructionRoot, id);
      const contextProjectRoot = path.join(contextRoot, id);
      for (const directory of await targetDirectories(instructionProjectRoot)) ownedDirectories.add(directory);
      for (const directory of await targetDirectories(contextProjectRoot)) ownedDirectories.add(directory);
    }
    const sharedRoot = path.join(contextRoot, "shared");
    for (const directory of await targetDirectories(sharedRoot)) ownedDirectories.add(directory);
    const contextPlan = await planContextFiles({
      workspaceRoot: options.identity.workspaceRoot,
      marketplaceRoot: options.marketplaceRoot,
      projects: [],
      publishedLearningRoot: undefined,
      sourceRevision: options.sourceRevision,
      previousReceipts: mergeReceipts(previous?.managedContextFiles, previous?.pendingContextFiles),
      operations,
      unbind: true,
    });
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
    const componentOptions = {
      workspaceRoot: options.identity.workspaceRoot,
      homeDir: options.homeDir ?? process.env.USERPROFILE ?? process.cwd(),
      marketplaceName: options.marketplace.name,
      plugins: options.plugins,
      projects: [],
      sourceRevision: options.sourceRevision,
      previousReceipts: previous?.managedProjectComponents,
      pendingReceipts: previous?.pendingProjectComponents,
      dryRun: true,
    };
    const componentPlan = await convergeProjectComponents(componentOptions);
    if (!options.dryRun) await convergeProjectComponents({ ...componentOptions, dryRun: false });
    warnings.push(...componentPlan.warnings);
    warnings.push(...contextPlan.warnings);
    warnings.push(...await planRetiredProjectSettings(options.identity.workspaceRoot, previous?.managedProjectPlugins ?? [], settings, operations));
    for (const root of [instructionRoot, contextRoot]) {
      if (await isSafeDirectory(root)) ownedDirectories.add(root);
    }
    for (const directory of [...ownedDirectories].sort((left, right) => right.length - left.length)) {
      operations.push({ path: directory, removeDirectoryIfEmpty: true });
    }
    const changes = await applyFileChanges(operations, options.dryRun);
    return {
      projection: emptyProjection,
      changes: [...changes, ...componentPlan.changes],
      warnings,
      mergedSettings,
      managedGitExcludeEntries,
    };
  }

  const previousIds = previous?.logicalProjects ?? [];
  const staleOwnedDirectories = new Set<string>();
  const contextInstructionTargets = new Set<string>();
  for (const id of previousIds.filter((id) => !options.logicalProjects.includes(id))) {
    const instructionProjectRoot = path.join(instructionRoot, id);
    const contextProjectRoot = path.join(contextRoot, id);
    for (const directory of await targetDirectories(instructionProjectRoot)) staleOwnedDirectories.add(directory);
    for (const directory of await targetDirectories(contextProjectRoot)) staleOwnedDirectories.add(directory);
  }
  const contextPlan = await planContextFiles({
    workspaceRoot: options.identity.workspaceRoot,
    marketplaceRoot: options.marketplaceRoot,
    projects,
    publishedLearningRoot: options.publishedLearningRoot,
    sourceRevision: options.sourceRevision,
    previousReceipts: mergeReceipts(previous?.managedContextFiles, previous?.pendingContextFiles),
    operations,
    unbind: false,
  });
  for (const target of contextPlan.instructionTargets) contextInstructionTargets.add(target);
  const pointer = path.join(instructionRoot, "context.instructions.md");
  contextInstructionTargets.add(path.resolve(pointer));
  const pointerBefore = await readSafeFile(pointer);
  const ownedPointerStates = previous
    ? [previous.logicalProjects, ...(previous.pendingLogicalProjects ? [previous.pendingLogicalProjects] : [])]
    : [];
  if (pointerBefore && !ownedPointerStates.some((ids) => pointerBefore.equals(Buffer.from(pointerContents(ids), "utf8")))) {
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

  const componentOptions = {
    workspaceRoot: options.identity.workspaceRoot,
    homeDir: options.homeDir ?? process.env.USERPROFILE ?? process.cwd(),
    marketplaceName: options.marketplace.name,
    plugins: options.plugins,
    projects,
    sourceRevision: options.sourceRevision,
    previousReceipts: previous?.managedProjectComponents,
    pendingReceipts: previous?.pendingProjectComponents,
    dryRun: true,
  };
  const componentPlan = await convergeProjectComponents(componentOptions);
  for (const receipt of componentPlan.receipts.filter((item) => item.kind === "instruction")) {
    const target = path.resolve(options.identity.workspaceRoot, ...receipt.targetPath.split("/"));
    if (contextInstructionTargets.has(target)) {
      throw new Error("Logical Project context and Project Plugin Rule target the same Workspace file: " + target);
    }
  }
  if (!options.dryRun) await convergeProjectComponents({ ...componentOptions, dryRun: false });
  warnings.push(...componentPlan.warnings);
  warnings.push(...contextPlan.warnings);
  warnings.push(...await planRetiredProjectSettings(options.identity.workspaceRoot, previous?.managedProjectPlugins ?? [], settings, operations));
  for (const directory of [...staleOwnedDirectories].sort((left, right) => right.length - left.length)) {
    operations.push({ path: directory, removeDirectoryIfEmpty: true });
  }
  const changes = await applyFileChanges(operations, options.dryRun);
  return {
    projection: {
      workspaceRoot: options.identity.workspaceRoot,
      logicalProjects: projects.map((project) => project.id),
      selectedProjectPlugins: componentPlan.projectPlugins,
      managedProjectComponents: componentPlan.receipts,
      managedContextFiles: contextPlan.receipts,
      instructionRoot,
      contextRoot,
    },
    changes: [...changes, ...componentPlan.changes],
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

interface DesiredContextFile {
  receipt: ProjectContextFileReceipt;
  target: string;
  content: Buffer;
}

async function planContextFiles(options: {
  workspaceRoot: string;
  marketplaceRoot: string;
  projects: Array<{ id: string }>;
  publishedLearningRoot?: string;
  sourceRevision?: string;
  previousReceipts: ProjectContextFileReceipt[];
  operations: FileChange[];
  unbind: boolean;
}): Promise<{ receipts: ProjectContextFileReceipt[]; warnings: string[]; instructionTargets: Set<string> }> {
  const desired = new Map<string, DesiredContextFile>();
  const instructionTargets = new Set<string>();
  const warnings: string[] = [];
  const add = async (
    kind: ProjectContextFileReceipt["kind"],
    projectId: string,
    sourceRoot: string,
    sourceBoundary: string,
    targetRoot: string,
    instructionsOnly: boolean,
  ) => {
    for (const file of await sourceFiles(sourceRoot, instructionsOnly, sourceBoundary)) {
      const target = safeTargetPath(targetRoot, file.relativePath);
      const absolute = path.resolve(target);
      const normalized = normalizeAnchor(absolute);
      const sourcePath = path.relative(sourceBoundary, path.join(sourceRoot, ...file.relativePath.split("/"))).split(path.sep).join("/");
      const receipt: ProjectContextFileReceipt = {
        kind,
        projectIds: [projectId],
        sourcePath,
        targetPath: path.relative(options.workspaceRoot, absolute).split(path.sep).join("/"),
        sourceHash: createHash("sha256").update(file.content).digest("hex"),
        ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
        contentHash: createHash("sha256").update(file.content).digest("hex"),
      };
      if (kind === "instruction") instructionTargets.add(absolute);
      const previous = desired.get(normalized);
      if (previous && !previous.content.equals(file.content)) throw new Error(`Logical Project context sources collide at ${absolute}.`);
      if (previous) {
        previous.receipt.projectIds = [...new Set([...previous.receipt.projectIds, projectId])].sort();
      } else {
        desired.set(normalized, { receipt, target, content: file.content });
      }
    }
  };

  if (!options.unbind) {
    for (const project of options.projects) {
      await add(
        "instruction", project.id,
        path.join(options.marketplaceRoot, "contexts", project.id, "instructions"), options.marketplaceRoot,
        path.join(options.workspaceRoot, ".github", "instructions", "teamai", project.id), true,
      );
      await add(
        "document", project.id,
        path.join(options.marketplaceRoot, "contexts", project.id, "docs"), options.marketplaceRoot,
        path.join(options.workspaceRoot, ".teamai", "context", project.id, "docs"), false,
      );
      if (options.publishedLearningRoot) {
        await add(
          "learning", project.id,
          path.join(options.publishedLearningRoot, "learnings", project.id), options.publishedLearningRoot,
          path.join(options.workspaceRoot, ".teamai", "context", project.id, "learnings"), false,
        );
      }
    }
    if (options.publishedLearningRoot) {
      await add(
        "learning", "shared",
        path.join(options.publishedLearningRoot, "learnings", "shared"), options.publishedLearningRoot,
        path.join(options.workspaceRoot, ".teamai", "context", "shared", "learnings"), false,
      );
    }
  }

  const oldByTarget = new Map<string, ProjectContextFileReceipt[]>();
  for (const receipt of options.previousReceipts) {
    const absolute = path.resolve(options.workspaceRoot, ...receipt.targetPath.split("/"));
    const normalized = normalizeAnchor(absolute);
    const values = oldByTarget.get(normalized) ?? [];
    if (!values.some((item) => item.contentHash === receipt.contentHash)) values.push(receipt);
    oldByTarget.set(normalized, values);
  }

  const nextReceipts: ProjectContextFileReceipt[] = [];
  for (const [normalized, file] of desired) {
    const old = oldByTarget.get(normalized) ?? [];
    await assertSafeAncestors(path.dirname(file.target), options.workspaceRoot);
    const current = await readSafeFile(file.target);
    if (current === undefined) {
      options.operations.push({ path: file.target, after: file.content });
      nextReceipts.push(file.receipt);
      continue;
    }
    if (!old.some((receipt) => createHash("sha256").update(current).digest("hex") === receipt.contentHash)) {
      if (old.length === 0) throw new Error(`Logical Project context target is occupied without Team AI ownership: ${file.target}`);
      warnings.push(`Preserving user-modified Logical Project context file: ${file.target}`);
      nextReceipts.push(...old);
      continue;
    }
    if (!current.equals(file.content)) options.operations.push({ path: file.target, before: current, after: file.content });
    nextReceipts.push(file.receipt);
  }

  for (const [normalized, old] of oldByTarget) {
    if (desired.has(normalized)) continue;
    if (!options.unbind && !options.publishedLearningRoot && old.every((receipt) => receipt.kind === "learning")) {
      nextReceipts.push(...old);
      continue;
    }
    const target = path.resolve(options.workspaceRoot, ...old[0]!.targetPath.split("/"));
    await assertSafeAncestors(path.dirname(target), options.workspaceRoot);
    const current = await readSafeFile(target);
    if (current === undefined) continue;
    const contentHash = createHash("sha256").update(current).digest("hex");
    if (old.some((receipt) => receipt.contentHash === contentHash)) {
      options.operations.push({ path: target, before: current });
    } else {
      warnings.push(`Preserving user-modified Logical Project context file: ${target}`);
    }
  }

  const uniqueReceipts = new Map<string, ProjectContextFileReceipt>();
  for (const receipt of nextReceipts) uniqueReceipts.set(`${normalizeAnchor(path.resolve(options.workspaceRoot, ...receipt.targetPath.split("/")))}\0${receipt.contentHash}`, receipt);
  return { receipts: [...uniqueReceipts.values()], warnings: [...new Set(warnings)], instructionTargets };
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

async function planRetiredProjectSettings(
  workspaceRoot: string,
  retiredSpecs: string[],
  settings: ProjectSettings,
  operations: FileChange[],
): Promise<string[]> {
  const owned = [...new Set(retiredSpecs)];
  if (owned.length === 0) return [];
  const settingsPath = projectSettingsPath(workspaceRoot);
  const before = await readSafeFile(settingsPath);
  if (!before) return [];
  const current = settings.enabledPlugins ?? {};
  let text = before.toString("utf8");
  const errors: ParseError[] = [];
  const parsed = parseJsonc(text, errors, { allowTrailingComma: false, disallowComments: false }) as ProjectSettings | undefined;
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(settingsPath + " contains invalid JSON/JSONC.");
  }
  const preserved: string[] = [];
  for (const spec of owned) {
    if (current[spec] !== true) {
      if (spec in current) preserved.push("Legacy project Plugin state " + spec + " is user-modified; preserving it.");
      continue;
    }
    text = applyEdits(text, modify(text, ["enabledPlugins", spec], undefined, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
  }
  if (text !== before.toString("utf8")) await planFile(settingsPath, Buffer.from(text, "utf8"), before, operations);
  return preserved;
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
