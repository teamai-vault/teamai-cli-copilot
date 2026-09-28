import { lstat, mkdir, readFile, readdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type { MarketplaceConfig } from "../config/schema.js";
import { mergeManagedProjectPlugins, readProjectSettings, writeProjectSettings, type ProjectSettings } from "../copilot/project-settings.js";
import type { CatalogPlugin } from "../copilot/catalog.js";
import { atomicWriteFile, atomicWriteText, readTextIfExists } from "../utils/fs.js";
import { runProcess } from "../utils/process.js";
import type { ProjectIdentity } from "./anchors.js";
import { loadLogicalProjects, selectedLogicalProjects } from "./manifest.js";
import { normalizeAnchor } from "./partition.js";
import type { ProjectProjection, ProjectState } from "./state.js";

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

export async function convergeLogicalProjectContext(options: {
  marketplaceRoot: string;
  plugins: CatalogPlugin[];
  marketplace: MarketplaceConfig;
  identity: ProjectIdentity;
  state?: ProjectState;
  logicalProjects: string[];
  dryRun?: boolean;
}): Promise<{ projection: ProjectProjection; changes: string[]; warnings: string[]; mergedSettings: ProjectSettings }> {
  const projects = selectedLogicalProjects(await loadLogicalProjects(options.marketplaceRoot, options.plugins), options.logicalProjects);
  const previous = projectionFor(options.state, options.identity.workspaceRoot);
  const instructionRoot = path.join(options.identity.workspaceRoot, ".github", "instructions", "teamai");
  const contextRoot = path.join(options.identity.workspaceRoot, ".teamai", "context");
  await assertSafeAncestors(instructionRoot, options.identity.workspaceRoot);
  await assertSafeAncestors(contextRoot, options.identity.workspaceRoot);
  await assertOwnedOrMissing(instructionRoot, previous?.instructionRoot === instructionRoot);
  await assertOwnedOrMissing(contextRoot, previous?.contextRoot === contextRoot);

  const desiredPlugins = [...new Set(projects.flatMap((project) => project.plugin ? [project.plugin] : []))];
  const settings = await readProjectSettings(options.identity.workspaceRoot);
  const mergedSettings = mergeManagedProjectPlugins(settings, options.marketplace, desiredPlugins, previous?.managedProjectPlugins ?? []);
  const ownedPlugins = desiredPlugins
    .map((plugin) => `${plugin}@${options.marketplace.name}`)
    .filter((spec) => (previous?.managedProjectPlugins ?? []).includes(spec) || !(spec in (settings.enabledPlugins ?? {})));
  const changes: string[] = [];
  const warnings = desiredPlugins
    .map((plugin) => `${plugin}@${options.marketplace.name}`)
    .filter((spec) => !ownedPlugins.includes(spec) && settings.enabledPlugins?.[spec] === false)
    .map((spec) => `${spec} is user-owned and disabled; preserving its state.`);
  if (JSON.stringify(settings) !== JSON.stringify(mergedSettings)) {
    changes.push(".github/copilot/settings.json");
    if (!options.dryRun) await writeProjectSettings(options.identity.workspaceRoot, mergedSettings);
  }

  const previousIds = previous?.logicalProjects ?? [];
  for (const id of previousIds.filter((id) => !options.logicalProjects.includes(id))) {
    await removeOwned(path.join(instructionRoot, id), options.dryRun, changes);
    await removeOwned(path.join(contextRoot, id), options.dryRun, changes);
  }
  for (const project of projects) {
    await mirrorTree(path.join(options.marketplaceRoot, "contexts", project.id, "instructions"), path.join(instructionRoot, project.id), true, options.marketplaceRoot, options.dryRun, changes);
    await mirrorTree(path.join(options.marketplaceRoot, "contexts", project.id, "docs"), path.join(contextRoot, project.id, "docs"), false, options.marketplaceRoot, options.dryRun, changes);
    await mirrorTree(path.join(options.marketplaceRoot, "learnings", project.id), path.join(contextRoot, project.id, "learnings"), false, options.marketplaceRoot, options.dryRun, changes);
  }
  await mirrorTree(path.join(options.marketplaceRoot, "learnings", "shared"), path.join(contextRoot, "shared", "learnings"), false, options.marketplaceRoot, options.dryRun, changes);
  await writePointer(instructionRoot, projects.map((project) => project.id), options.dryRun, changes);
  await updateGitExclude(options.identity.workspaceRoot, ["/.github/instructions/teamai/", "/.teamai/context/"], options.dryRun, changes);

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

async function mirrorTree(sourceRoot: string, targetRoot: string, instructionsOnly: boolean, sourceBoundary: string, dryRun: boolean | undefined, changes: string[]): Promise<void> {
  const files = await sourceFiles(sourceRoot, instructionsOnly, sourceBoundary);
  const installed = await targetFiles(targetRoot);
  const desired = new Map(files.map((file) => [file.relativePath, file]));
  for (const [relativePath] of installed) {
    if (desired.has(relativePath)) continue;
    const target = safeTargetPath(targetRoot, relativePath);
    changes.push(target);
    if (!dryRun) await unlink(target);
  }
  for (const file of files) {
    const target = safeTargetPath(targetRoot, file.relativePath);
    if (installed.get(file.relativePath)?.equals(file.content)) continue;
    changes.push(target);
    if (!dryRun) await atomicWriteFile(target, file.content);
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
      else if (info.isFile()) files.set(path.relative(targetRoot, entryPath).split(path.sep).join("/"), await readFile(entryPath));
    }
  }
  await walk(targetRoot);
  return files;
}

function safeTargetPath(root: string, relativePath: string): string {
  const target = path.resolve(root, ...relativePath.split("/"));
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Team AI projection destination '${relativePath}'.`);
  }
  return target;
}

async function removeOwned(target: string, dryRun: boolean | undefined, changes: string[]): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error(`Unsafe Team AI projection path: ${target}`);
    changes.push(target);
    if (!dryRun) await rm(target, { recursive: info.isDirectory(), force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function writePointer(instructionRoot: string, ids: string[], dryRun: boolean | undefined, changes: string[]): Promise<void> {
  const pointer = path.join(instructionRoot, "context.instructions.md");
  const paths = [".teamai/context/shared/learnings", ...ids.flatMap((id) => [`.teamai/context/${id}/docs`, `.teamai/context/${id}/learnings`])];
  const contents = `---\napplyTo: "**"\n---\n\nActive Logical Projects: ${ids.join(", ") || "none"}\n\nRead these paths only when the task needs that context:\n${paths.map((entry) => `- ${entry}`).join("\n")}\n\nLearnings are historical team experience, not mandatory policy.\n`;
  if (await readTextIfExists(pointer) !== contents) {
    changes.push(pointer);
    if (!dryRun) await atomicWriteText(pointer, contents);
  }
}

async function updateGitExclude(workspaceRoot: string, entries: string[], dryRun: boolean | undefined, changes: string[]): Promise<void> {
  const resolved = await runProcess("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: workspaceRoot });
  if (resolved.exitCode !== 0) throw new Error("Could not resolve Git info/exclude.");
  const excludePath = path.resolve(workspaceRoot, resolved.stdout.trim());
  const current = await readTextIfExists(excludePath) ?? "";
  const missing = entries.filter((entry) => !current.split(/\r?\n/).includes(entry));
  if (missing.length === 0) return;
  changes.push(excludePath);
  if (!dryRun) await atomicWriteText(excludePath, `${current}${current && !current.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`);
}
