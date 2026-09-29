import { lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { teamAiHome } from "../config/global.js";
import { atomicWriteJson, atomicWriteText, withFileLock } from "../utils/fs.js";
import { normalizeAnchor, partitionPath } from "./partition.js";

export interface ProjectState {
  schemaVersion: 1;
  workspaceRoot: string;
  lastSync: string;
  managedPlugins: string[];
  managedGitExcludeEntries?: string[];
  projections?: Record<string, ProjectProjection>;
}

export interface ProjectProjection {
  workspaceRoot: string;
  logicalProjects: string[];
  managedProjectPlugins: string[];
  instructionRoot: string;
  contextRoot: string;
  publishedLearningRevision?: string;
  pendingPublishedLearningRevision?: string;
  pendingLogicalProjects?: string[];
}

export interface PartitionDiagnostic {
  partition: string;
  kind: "orphan" | "stale";
  anchor?: string;
}

export async function readProjectState(projectAnchor: string, homeDir: string): Promise<ProjectState | undefined> {
  const root = partitionPath(projectAnchor, homeDir);
  const anchorFile = path.join(root, "anchor");
  const statePath = path.join(root, "state.json");
  await assertSafePartitionPath(projectAnchor, homeDir);
  await assertSafeStateFile(anchorFile);
  await assertSafeStateFile(statePath);
  const contents = await readOptionalFile(statePath);
  return contents === undefined ? undefined : JSON.parse(contents) as ProjectState;
}

export async function writeProjectState(
  projectAnchor: string,
  state: ProjectState,
  homeDir: string,
): Promise<void> {
  await withProjectStateLock(projectAnchor, homeDir, async () => ({ state, result: undefined }));
}

export async function withProjectStateLock<T>(
  projectAnchor: string,
  homeDir: string,
  action: (state: ProjectState | undefined, saveCheckpoint: (state: ProjectState) => Promise<void>) => Promise<{ state?: ProjectState | null; result: T }>,
): Promise<T> {
  const root = partitionPath(projectAnchor, homeDir);
  const projectsRoot = path.dirname(root);
  const statePath = path.join(root, "state.json");
  const anchorFile = path.join(root, "anchor");
  const lockPath = `${root}.lock`;
  await assertSafeDirectoryPath(homeDir, projectsRoot);
  await mkdir(projectsRoot, { recursive: true });
  await assertSafeDirectoryPath(homeDir, projectsRoot);
  await assertSafeLockFile(lockPath);
  try {
    return await withFileLock(lockPath, async () => {
      await assertSafePartitionPath(projectAnchor, homeDir);
      await assertSafeStateFile(anchorFile);
      await assertSafeStateFile(statePath);
      const existingAnchor = await readOptionalFile(anchorFile);
      if (existingAnchor !== undefined && normalizeAnchor(existingAnchor.trim()) !== normalizeAnchor(projectAnchor)) {
        throw new Error(`Partition collision detected at ${root}`);
      }
      const stateContents = await readOptionalFile(statePath);
      const state = stateContents === undefined ? undefined : JSON.parse(stateContents) as ProjectState;
      const saveCheckpoint = async (checkpoint: ProjectState): Promise<void> => {
        await persistProjectState(projectAnchor, homeDir, root, anchorFile, statePath, checkpoint);
      };
      const update = await action(state, saveCheckpoint);
      await assertSafePartitionPath(projectAnchor, homeDir);
      await assertSafeStateFile(anchorFile);
      await assertSafeStateFile(statePath);
      if (update.state === null) {
        await rm(statePath, { force: true });
      } else if (update.state) {
        await persistProjectState(projectAnchor, homeDir, root, anchorFile, statePath, update.state);
      }
      return update.result;
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Another Team AI operation is already using ")) {
      throw new Error(`Project state conflict: ${error.message}`);
    }
    throw error;
  }
}

async function persistProjectState(
  projectAnchor: string,
  homeDir: string,
  root: string,
  anchorFile: string,
  statePath: string,
  state: ProjectState,
): Promise<void> {
  await assertSafeDirectoryPath(homeDir, root);
  await atomicWriteText(anchorFile, `${projectAnchor}\n`);
  await assertSafePartitionPath(projectAnchor, homeDir);
  await assertSafeStateFile(anchorFile);
  await assertSafeStateFile(statePath);
  await atomicWriteJson(statePath, state);
}

export async function inspectProjectPartitions(homeDir: string): Promise<PartitionDiagnostic[]> {
  const projectsRoot = path.join(teamAiHome(homeDir), "projects");
  await assertSafeDirectoryPath(homeDir, projectsRoot);
  let entries;
  try {
    entries = await readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const diagnostics: PartitionDiagnostic[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const partition = path.join(projectsRoot, entry.name);
    await assertSafeDirectoryPath(homeDir, partition);
    const anchorFile = path.join(partition, "anchor");
    await assertSafeStateFile(anchorFile);
    const rawAnchor = await readOptionalFile(anchorFile);
    const anchor = rawAnchor?.trim();
    if (!anchor) {
      diagnostics.push({ partition, kind: "orphan" });
      continue;
    }
    try {
      await stat(anchor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        diagnostics.push({ partition, kind: "stale", anchor });
        continue;
      }
      throw error;
    }
  }
  return diagnostics;
}

async function assertSafePartitionPath(projectAnchor: string, homeDir: string): Promise<void> {
  const root = partitionPath(projectAnchor, homeDir);
  await assertSafeDirectoryPath(homeDir, root);
}

async function assertSafeDirectoryPath(boundary: string, target: string): Promise<void> {
  const root = path.resolve(boundary);
  const destination = path.resolve(target);
  const relative = path.relative(root, destination);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Team AI project state path: ${destination}`);
  }

  let current = root;
  const paths = [root, ...relative.split(path.sep).filter(Boolean)];
  for (let index = 0; index < paths.length; index += 1) {
    if (index > 0) current = path.join(current, paths[index]!);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Unsafe Team AI project state path: ${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

async function assertSafeStateFile(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) {
      throw new Error(`Unsafe Team AI project state file: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function assertSafeLockFile(filePath: string): Promise<void> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) {
      throw new Error(`Unsafe Team AI project state lock: ${filePath}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
