import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile, pathsEqual } from "../utils/fs.js";
import { copilotHome } from "./user-state.js";

const INSTRUCTION_SUFFIX = ".instructions.md";

export interface ManagedUserInstruction {
  relativePath: string;
  content: Buffer;
}

export type UserInstructionChange =
  | { type: "create"; relativePath: string }
  | { type: "update"; relativePath: string }
  | { type: "remove"; relativePath: string };

export interface UserInstructionPlan {
  targetRoot: string;
  desired: ManagedUserInstruction[];
  changes: UserInstructionChange[];
}

export interface UserInstructionState {
  desiredCount: number;
  changes: UserInstructionChange[];
  current: boolean;
  targetWritable: boolean;
}

export function userInstructionTargetRoot(homeDir: string): string {
  return path.join(copilotHome(homeDir), "instructions", "teamai");
}

export function userInstructionDisplayPath(relativePath: string, homeDir: string): string {
  if (process.env.COPILOT_HOME === undefined || process.env.COPILOT_HOME.length === 0) {
    return `~/.copilot/instructions/teamai/${relativePath}`;
  }
  return path.join(userInstructionTargetRoot(homeDir), ...relativePath.split(/[\\/]+/));
}

export async function discoverMarketplaceUserInstructions(marketplaceRoot: string): Promise<ManagedUserInstruction[]> {
  const sourceRoot = path.resolve(marketplaceRoot, "instructions");
  let sourceStat;
  try {
    sourceStat = await lstat(sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw sourceReadError(sourceRoot, error);
  }
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || await isLinkLike(sourceRoot, sourceStat)) {
    throw unsafeSourceError(sourceRoot);
  }
  const discovered: ManagedUserInstruction[] = [];
  await walkSource(sourceRoot, sourceRoot, discovered);
  discovered.sort((left, right) => comparePaths(left.relativePath, right.relativePath));
  return discovered;
}

export async function planUserInstructionChanges(
  desired: ManagedUserInstruction[],
  targetRoot: string,
): Promise<UserInstructionPlan> {
  const normalizedTargetRoot = path.resolve(targetRoot);
  const desiredByPath = new Map<string, ManagedUserInstruction>();
  for (const instruction of desired) {
    assertSafeRelativePath(instruction.relativePath);
    const relativePath = toPortableRelativePath(instruction.relativePath);
    if (desiredByPath.has(relativePath)) {
      throw new Error(`Duplicate Marketplace user instruction path '${relativePath}'.`);
    }
    desiredByPath.set(relativePath, { ...instruction, relativePath });
  }

  const installed = await readInstalledInstructions(normalizedTargetRoot);
  const changes: UserInstructionChange[] = [];
  for (const instruction of [...desiredByPath.values()].sort((left, right) => comparePaths(left.relativePath, right.relativePath))) {
    const existing = installed.get(instruction.relativePath);
    if (!existing) {
      changes.push({ type: "create", relativePath: instruction.relativePath });
    } else if (!existing.equals(instruction.content)) {
      changes.push({ type: "update", relativePath: instruction.relativePath });
    }
  }
  for (const relativePath of [...installed.keys()].sort(comparePaths)) {
    if (!desiredByPath.has(relativePath)) changes.push({ type: "remove", relativePath });
  }
  return { targetRoot: normalizedTargetRoot, desired: [...desiredByPath.values()], changes };
}

export async function applyUserInstructionChanges(
  plan: UserInstructionPlan,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  if (options.dryRun || plan.changes.length === 0) return;
  await ensureTargetRoot(plan.targetRoot, true);
  const desired = new Map(plan.desired.map((instruction) => [instruction.relativePath, instruction]));
  for (const change of plan.changes) {
    const targetPath = safeTargetPath(plan.targetRoot, change.relativePath);
    if (change.type === "remove") {
      await unlink(targetPath).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      continue;
    }
    const instruction = desired.get(change.relativePath);
    if (!instruction) throw new Error(`Missing desired Marketplace user instruction '${change.relativePath}'.`);
    await ensureSafeTargetChain(path.dirname(targetPath));
    await atomicWriteFile(targetPath, instruction.content);
  }
}

export async function convergeMarketplaceUserInstructions(
  marketplaceRoot: string,
  homeDir: string,
  options: { dryRun?: boolean } = {},
): Promise<UserInstructionPlan> {
  const desired = await discoverMarketplaceUserInstructions(marketplaceRoot);
  const plan = await planUserInstructionChanges(desired, userInstructionTargetRoot(homeDir));
  await applyUserInstructionChanges(plan, options);
  return plan;
}

export async function checkUserInstructionState(
  desired: ManagedUserInstruction[],
  targetRoot: string,
): Promise<UserInstructionState> {
  const plan = await planUserInstructionChanges(desired, targetRoot);
  return {
    desiredCount: desired.length,
    changes: plan.changes,
    current: plan.changes.length === 0,
    targetWritable: plan.changes.length === 0 || await plannedChangesAreWritable(plan),
  };
}

async function walkSource(
  directory: string,
  root: string,
  result: ManagedUserInstruction[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw sourceReadError(directory, error);
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    let entryStat;
    try {
      entryStat = await lstat(entryPath);
    } catch (error) {
      throw sourceReadError(entryPath, error);
    }
    if (await isLinkLike(entryPath, entryStat)) continue;
    if (entryStat.isDirectory()) {
      await walkSource(entryPath, root, result);
      continue;
    }
    if (!entryStat.isFile() || entryStat.nlink !== 1 || !entry.name.endsWith(INSTRUCTION_SUFFIX)) continue;
    let content: Buffer;
    try {
      content = await readFile(entryPath);
    } catch (error) {
      throw sourceReadError(entryPath, error);
    }
    result.push({
      relativePath: toPortableRelativePath(path.relative(root, entryPath)),
      content,
    });
  }
}

async function readInstalledInstructions(targetRoot: string): Promise<Map<string, Buffer>> {
  try {
    await ensureTargetRoot(targetRoot, false);
    const installed = new Map<string, Buffer>();
    await walkTarget(targetRoot, targetRoot, installed);
    return installed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map<string, Buffer>();
    throw error;
  }
}

async function walkTarget(
  directory: string,
  root: string,
  result: Map<string, Buffer>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Could not read managed user instruction target '${directory}': ${(error as Error).message}`);
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    let entryStat;
    try {
      entryStat = await lstat(entryPath);
    } catch (error) {
      throw new Error(`Could not read managed user instruction target '${entryPath}': ${(error as Error).message}`);
    }
    if (await isLinkLike(entryPath, entryStat)) throw unsafeTargetError(entryPath);
    if (entryStat.isDirectory()) {
      if (entry.name.endsWith(INSTRUCTION_SUFFIX)) throw unsafeTargetError(entryPath);
      await walkTarget(entryPath, root, result);
      continue;
    }
    if (!entry.name.endsWith(INSTRUCTION_SUFFIX)) continue;
    if (!entryStat.isFile() || entryStat.nlink !== 1) throw unsafeTargetError(entryPath);
    try {
      result.set(toPortableRelativePath(path.relative(root, entryPath)), await readFile(entryPath));
    } catch (error) {
      throw new Error(`Could not read managed user instruction target '${entryPath}': ${(error as Error).message}`);
    }
  }
}

async function ensureTargetRoot(targetRoot: string, create: boolean): Promise<void> {
  await ensureSafeTargetChain(targetRoot);
  try {
    const info = await lstat(targetRoot);
    if (await isLinkLike(targetRoot, info) || !info.isDirectory()) throw unsafeTargetError(targetRoot);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) throw error;
  }
  await mkdir(targetRoot, { recursive: true });
  await ensureSafeTargetChain(targetRoot);
  const info = await lstat(targetRoot);
  if (await isLinkLike(targetRoot, info) || !info.isDirectory()) throw unsafeTargetError(targetRoot);
}

async function ensureSafeTargetChain(targetRoot: string): Promise<void> {
  let current = path.resolve(targetRoot);
  while (true) {
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = path.dirname(current);
        if (parent === current) return;
        current = parent;
        continue;
      }
      throw error;
    }
    if (await isLinkLike(current, info) || !info.isDirectory()) throw unsafeTargetError(current);
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function plannedChangesAreWritable(plan: UserInstructionPlan): Promise<boolean> {
  for (const change of plan.changes) {
    const targetPath = safeTargetPath(plan.targetRoot, change.relativePath);
    if (!await operationDirectoryIsWritable(path.dirname(targetPath))) return false;
  }
  return true;
}

async function operationDirectoryIsWritable(directory: string): Promise<boolean> {
  let current = path.resolve(directory);
  while (true) {
    try {
      const info = await lstat(current);
      if (await isLinkLike(current, info) || !info.isDirectory()) return false;
      await access(current, constants.W_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
      const parent = path.dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

function safeTargetPath(targetRoot: string, relativePath: string): string {
  assertSafeRelativePath(relativePath);
  const root = path.resolve(targetRoot);
  const target = path.resolve(root, ...relativePath.split(/[\\/]+/));
  const relative = path.relative(root, target);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Marketplace user instruction destination '${relativePath}'.`);
  }
  return target;
}

function assertSafeRelativePath(relativePath: string): void {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    /^[A-Za-z]:/.test(relativePath) ||
    relativePath.split(/[\\/]+/).some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    !relativePath.endsWith(INSTRUCTION_SUFFIX)
  ) {
    throw new Error(`Unsafe Marketplace user instruction destination '${relativePath}'.`);
  }
}

function toPortableRelativePath(relativePath: string): string {
  return relativePath.split(/[\\/]+/).join("/");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function isLinkLike(filePath: string, info: { isSymbolicLink(): boolean }): Promise<boolean> {
  if (info.isSymbolicLink()) return true;
  try {
    return !pathsEqual(filePath, await realpath(filePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function sourceReadError(filePath: string, error: unknown): Error {
  return new Error(`Could not read Marketplace user instructions at '${filePath}': ${(error as Error).message}`);
}

function unsafeSourceError(filePath: string): Error {
  return new Error(`Unsafe Marketplace user instructions source '${filePath}'.`);
}

function unsafeTargetError(filePath: string): Error {
  return new Error(`Unsafe managed user instruction target '${filePath}'.`);
}
