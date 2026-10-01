import { createHash } from "node:crypto";
import { lstat, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { TEAM_AI_EXTENSION_NAMESPACE, type CatalogPlugin } from "../copilot/catalog.js";
import { assertSafePluginPath, readProjectHookFormat, readProjectMcpFormat, readWorkspaceMcpDocument } from "../copilot/project-formats.js";
import { installedPluginsRoot, readCopilotState } from "../copilot/user-state.js";
import { atomicWriteFile } from "../utils/fs.js";
import type { LogicalProject } from "./manifest.js";
import type { ProjectComponentKind, ProjectComponentReceipt, ProjectPluginSource } from "./state.js";

interface FileOperation {
  path: string;
  before?: Buffer;
  after?: Buffer;
}

export interface ProjectComponentPlan {
  projectPlugins: ProjectPluginSource[];
  receipts: ProjectComponentReceipt[];
  changes: string[];
  warnings: string[];
}

export interface ProjectComponentOptions {
  workspaceRoot: string;
  homeDir: string;
  marketplaceName: string;
  plugins: CatalogPlugin[];
  projects: LogicalProject[];
  sourceRevision?: string;
  previousReceipts?: ProjectComponentReceipt[];
  pendingReceipts?: ProjectComponentReceipt[];
  dryRun?: boolean;
}

interface DesiredFile {
  kind: ProjectComponentKind;
  projectId: string;
  plugin: string;
  sourcePath: string;
  sourceHash: string;
  sourceRevision?: string;
  targetPath: string;
  content: Buffer;
}

interface DesiredMcpEntry {
  projectId: string;
  plugin: string;
  sourcePath: string;
  sourceHash: string;
  sourceRevision?: string;
  name: string;
  value: unknown;
}

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");
const safeId = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;
/** Plans every selected source and target before applying any workspace file changes. */
export async function convergeProjectComponents(options: ProjectComponentOptions): Promise<ProjectComponentPlan> {
  const sourcePlugins = new Map(options.plugins.filter((plugin) => plugin.kind === "project").map((plugin) => [plugin.name, plugin]));
  const desiredFiles: DesiredFile[] = [];
  const desiredMcp: DesiredMcpEntry[] = [];
  const projectPlugins: ProjectPluginSource[] = [];

  for (const project of options.projects) {
    if (!project.plugin) continue;
    const plugin = sourcePlugins.get(project.plugin);
    if (!plugin) throw new Error("Logical Project '" + project.id + "' references unavailable project Plugin '" + project.plugin + "'.");
    if (!safeId.test(project.id) || !safeId.test(plugin.name)) throw new Error("Unsafe Project component identity '" + project.id + "/" + plugin.name + "'.");
    await assertSafePluginPath(plugin.root, plugin.root);
    const manifest = await readSafeFile(path.join(plugin.root, "plugin.json"));
    if (!manifest) throw new Error(plugin.name + ": project Plugin manifest is missing.");
    projectPlugins.push({
      projectId: project.id,
      plugin: plugin.name,
      version: plugin.version,
      sourceHash: hash(manifest),
      ...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
    });

    await collectSimpleFiles(plugin, project.id, "agent", "com.github.copilot/agents", path.join(options.workspaceRoot, ".github", "agents"), options.workspaceRoot, desiredFiles, options.sourceRevision, (relative) => project.id + "-" + plugin.name + "-" + path.basename(relative));
    await collectSimpleFiles(plugin, project.id, "instruction", "com.github.copilot/rules", path.join(options.workspaceRoot, ".github", "instructions", "teamai", project.id), options.workspaceRoot, desiredFiles, options.sourceRevision, (relative) => relative);
    await collectSkills(plugin, project.id, options.workspaceRoot, desiredFiles, options.sourceRevision);
    await collectHooks(plugin, project.id, options.workspaceRoot, desiredFiles, options.sourceRevision);
    await collectMcp(plugin, project.id, options.workspaceRoot, desiredFiles, desiredMcp, options.sourceRevision);
  }

  const prior = [...(options.previousReceipts ?? []), ...(options.pendingReceipts ?? [])];
  const priorByTarget = new Map<string, ProjectComponentReceipt[]>();
  for (const receipt of prior) {
    const existing = priorByTarget.get(receipt.targetPath) ?? [];
    if (!existing.some((candidate) => candidate.contentHash === receipt.contentHash)) existing.push(receipt);
    priorByTarget.set(receipt.targetPath, existing);
  }

  const desiredByTarget = new Map<string, DesiredFile>();
  for (const file of desiredFiles) {
    const duplicate = desiredByTarget.get(file.targetPath);
    if (duplicate && !duplicate.content.equals(file.content)) throw new Error("Selected Project components collide at " + file.targetPath + ".");
    if (!duplicate) desiredByTarget.set(file.targetPath, file);
  }
  const operations: FileOperation[] = [];
  const receipts: ProjectComponentReceipt[] = [];
  const warnings: string[] = [];
  for (const [targetPath, file] of desiredByTarget) {
    const oldReceipts = priorByTarget.get(targetPath) ?? [];
    const absolute = path.resolve(options.workspaceRoot, targetPath);
    assertInside(options.workspaceRoot, absolute);
    await assertSafeAncestors(absolute, options.workspaceRoot);
    const current = await readSafeFile(absolute);
    if (current !== undefined && oldReceipts.length === 0) throw new Error("Project component target is occupied without Team AI ownership: " + absolute);
    if (current !== undefined && oldReceipts.length > 0 && !oldReceipts.some((receipt) => hash(current) === receipt.contentHash)) {
      throw new Error("Project component ownership conflict at " + absolute + "; the file changed after delivery.");
    }
    const related = desiredFiles.filter((candidate) => candidate.targetPath === targetPath);
    receipts.push({
      kind: file.kind,
      projectIds: [...new Set(related.map((candidate) => candidate.projectId))].sort(),
      plugin: file.plugin,
      sourcePath: file.sourcePath,
      targetPath,
      sourceHash: file.sourceHash,
      ...(file.sourceRevision ? { sourceRevision: file.sourceRevision } : {}),
      contentHash: hash(file.content),
    });
    if (current === undefined || !current.equals(file.content)) operations.push({ path: absolute, before: current, after: file.content });
  }

  for (const [targetPath, oldReceipts] of priorByTarget) {
    if (desiredByTarget.has(targetPath) || targetPath.startsWith(".mcp.json#mcpServers/")) continue;
    const absolute = path.resolve(options.workspaceRoot, targetPath);
    assertInside(options.workspaceRoot, absolute);
    await assertSafeAncestors(absolute, options.workspaceRoot);
    const current = await readSafeFile(absolute);
    if (current === undefined) continue;
    if (!oldReceipts.some((receipt) => hash(current) === receipt.contentHash)) {
      warnings.push("Preserving user-modified Project component: " + absolute);
      continue;
    }
    operations.push({ path: absolute, before: current });
  }

  const mcp = await planMcp(options.workspaceRoot, desiredMcp, priorByTarget, receipts, operations);
  warnings.push(...mcp.warnings);
  warnings.push(...await globalProjectPluginWarnings(projectPlugins, options.homeDir, options.marketplaceName));
  const unique = deduplicateOperations(operations);
  if (!options.dryRun) await applyOperations(unique);
  const changes = unique.map((operation) => operation.path);
  if (mcp.changed && !changes.includes(mcp.path)) changes.push(mcp.path);
  return {
    projectPlugins: projectPlugins.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.plugin.localeCompare(b.plugin)),
    receipts: receipts.sort((a, b) => a.targetPath.localeCompare(b.targetPath)),
    changes: [...new Set(changes)].sort(),
    warnings,
  };
}

async function collectSimpleFiles(
  plugin: CatalogPlugin,
  projectId: string,
  kind: "agent" | "instruction",
  sourceRelative: string,
  targetRoot: string,
  workspaceRoot: string,
  files: DesiredFile[],
  revision: string | undefined,
  targetName: (relative: string) => string,
): Promise<void> {
  const sourceRoot = path.join(plugin.root, ...sourceRelative.split("/"));
  await assertSafePluginPath(plugin.root, sourceRoot);
  for (const file of await sourceFiles(sourceRoot)) {
    if (kind === "agent" && !file.relative.endsWith(".agent.md")) continue;
    if (kind === "instruction" && !file.relative.endsWith(".instructions.md")) continue;
    const target = path.join(targetRoot, ...targetName(file.relative).split("/"));
    assertInside(targetRoot, target);
    files.push({
      kind, projectId, plugin: plugin.name,
      sourcePath: sourceRelative + "/" + file.relative,
      sourceHash: hash(file.content), ...(revision ? { sourceRevision: revision } : {}),
      targetPath: relativeTarget(workspaceRoot, target), content: file.content,
    });
  }
}

async function collectSkills(plugin: CatalogPlugin, projectId: string, workspaceRoot: string, files: DesiredFile[], revision?: string): Promise<void> {
  const sourceRoot = path.join(plugin.root, "skills");
  await assertSafePluginPath(plugin.root, sourceRoot);
  for (const entry of await safeDirectories(sourceRoot)) {
    const skillRoot = path.join(sourceRoot, entry);
    await assertSafePluginPath(plugin.root, skillRoot);
    const skillFiles = await sourceFiles(skillRoot);
    if (!skillFiles.some((file) => file.relative === "SKILL.md")) continue;
    for (const file of skillFiles) {
      const target = path.join(workspaceRoot, ".github", "skills", entry, ...file.relative.split("/"));
      files.push({
        kind: "skill", projectId, plugin: plugin.name,
        sourcePath: "skills/" + entry + "/" + file.relative,
        sourceHash: hash(file.content), ...(revision ? { sourceRevision: revision } : {}),
        targetPath: relativeTarget(workspaceRoot, target), content: file.content,
      });
    }
  }
}

async function collectHooks(plugin: CatalogPlugin, projectId: string, workspaceRoot: string, files: DesiredFile[], revision?: string): Promise<void> {
  const destinationRoot = physicalWorkspacePath(workspaceRoot, ".github", "hooks", ".teamai", projectId, plugin.name);
  const hook = await readProjectHookFormat(plugin.root, destinationRoot);
  if (!hook) return;
  const assets = path.join(workspaceRoot, ".github", "hooks", ".teamai", projectId, plugin.name);
  for (const resource of hook.resources) {
    files.push({
      kind: "hook", projectId, plugin: plugin.name,
      sourcePath: resource.relativePath,
      sourceHash: resource.sourceHash, ...(revision ? { sourceRevision: revision } : {}),
      targetPath: relativeTarget(workspaceRoot, path.join(assets, ...resource.relativePath.split("/"))), content: resource.content,
    });
  }
  const target = path.join(workspaceRoot, ".github", "hooks", "teamai-" + projectId + "-" + plugin.name + ".json");
  files.push({
    kind: "hook", projectId, plugin: plugin.name,
    sourcePath: "com.github.copilot/hooks/hooks.json", sourceHash: hook.sourceHash,
    ...(revision ? { sourceRevision: revision } : {}),
    targetPath: relativeTarget(workspaceRoot, target),
    content: hook.content,
  });
}

async function collectMcp(plugin: CatalogPlugin, projectId: string, workspaceRoot: string, files: DesiredFile[], entries: DesiredMcpEntry[], revision?: string): Promise<void> {
  const resourceRoot = path.join(workspaceRoot, ".teamai", "project-components", projectId, plugin.name);
  const mcp = await readProjectMcpFormat(plugin.root, physicalWorkspacePath(workspaceRoot, ".teamai", "project-components", projectId, plugin.name));
  if (!mcp) return;
  for (const resource of mcp.resources) {
    files.push({
      kind: "mcp", projectId, plugin: plugin.name,
      sourcePath: resource.relativePath, sourceHash: resource.sourceHash, ...(revision ? { sourceRevision: revision } : {}),
      targetPath: relativeTarget(workspaceRoot, path.join(resourceRoot, ...resource.relativePath.split("/"))), content: resource.content,
    });
  }
  for (const server of mcp.servers) {
    entries.push({
      projectId, plugin: plugin.name,
      sourcePath: server.sourcePath, sourceHash: server.sourceHash,
      ...(revision ? { sourceRevision: revision } : {}), name: server.name, value: server.value,
    });
  }
}

async function planMcp(
  workspaceRoot: string,
  desired: DesiredMcpEntry[],
  previous: Map<string, ProjectComponentReceipt[]>,
  receipts: ProjectComponentReceipt[],
  operations: FileOperation[],
): Promise<{ path: string; changed: boolean; warnings: string[] }> {
  const configPath = path.join(workspaceRoot, ".mcp.json");
  const hasPreviousMcp = [...previous.keys()].some((targetPath) => targetPath.startsWith(".mcp.json#mcpServers/"));
  if (desired.length === 0 && !hasPreviousMcp) return { path: configPath, changed: false, warnings: [] };
  await assertSafeAncestors(configPath, workspaceRoot);
  const raw = await readSafeFile(configPath);
  const document = readWorkspaceMcpDocument(raw, configPath);
  const currentServers = document.servers;
  const desiredByName = new Map<string, DesiredMcpEntry>();
  const warnings: string[] = [];
  for (const entry of desired) {
    const existing = desiredByName.get(entry.name);
    if (existing && canonical(existing.value) !== canonical(entry.value)) throw new Error("Selected Project MCP servers collide at .mcp.json#mcpServers/" + entry.name + ".");
    desiredByName.set(entry.name, entry);
  }
  for (const [name, entry] of desiredByName) {
    const targetPath = ".mcp.json#mcpServers/" + name;
    const oldReceipts = previous.get(targetPath) ?? [];
    const current = currentServers[name];
    if (current !== undefined && oldReceipts.length === 0) throw new Error("Project MCP server '" + name + "' is present in " + configPath + " without Team AI ownership.");
    if (current !== undefined && oldReceipts.length > 0 && !oldReceipts.some((receipt) => hash(canonical(current)) === receipt.contentHash)) throw new Error("Project MCP server '" + name + "' changed after Team AI delivery.");
    receipts.push({
      kind: "mcp",
      projectIds: [...new Set(desired.filter((candidate) => candidate.name === name).map((candidate) => candidate.projectId))].sort(),
      plugin: entry.plugin, sourcePath: entry.sourcePath, targetPath, sourceHash: entry.sourceHash,
      ...(entry.sourceRevision ? { sourceRevision: entry.sourceRevision } : {}),
      contentHash: hash(canonical(entry.value)),
    });
    if (canonical(current) !== canonical(entry.value)) {
      document.set(name, entry.value);
    }
  }
  for (const [targetPath, oldReceipts] of previous) {
    if (!targetPath.startsWith(".mcp.json#mcpServers/")) continue;
    const name = targetPath.slice(".mcp.json#mcpServers/".length);
    if (desiredByName.has(name) || currentServers[name] === undefined) continue;
    if (!oldReceipts.some((receipt) => hash(canonical(currentServers[name])) === receipt.contentHash)) {
      warnings.push("Preserving user-modified Project MCP server '" + name + "' in " + configPath + ".");
      continue;
    }
    document.set(name, undefined);
  }
  if (raw === undefined && desiredByName.size === 0) return { path: configPath, changed: false, warnings };
  const after = document.toBuffer();
  if (raw === undefined || !raw.equals(after)) operations.push({ path: configPath, before: raw, after });
  return { path: configPath, changed: raw === undefined || !raw.equals(after), warnings };
}

async function globalProjectPluginWarnings(projectPlugins: ProjectPluginSource[], homeDir: string, marketplaceName: string): Promise<string[]> {
  if (projectPlugins.length === 0) return [];
  const { config } = await readCopilotState(homeDir);
  const installed = config.installedPlugins ?? [];
  const warnings: string[] = [];
  for (const item of projectPlugins) {
    const packagePath = path.join(installedPluginsRoot(homeDir), marketplaceName, item.plugin);
    let filesystemPackage = false;
    try {
      const info = await lstat(packagePath);
      filesystemPackage = info.isDirectory() || info.isSymbolicLink();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (installed.some((plugin) => plugin.name === item.plugin) || filesystemPackage) {
      warnings.push(item.plugin + ": a user-level Plugin with the same name is installed; preserving it. Workspace Project delivery is isolated from user-level Plugin state.");
    }
  }
  return [...new Set(warnings)];
}

function physicalWorkspacePath(workspaceRoot: string, ...segments: string[]): string {
  return path.resolve(workspaceRoot, ...segments).replaceAll("\\", "/");
}

function deduplicateOperations(operations: FileOperation[]): FileOperation[] {
  const byPath = new Map<string, FileOperation>();
  for (const operation of operations) {
    const existing = byPath.get(operation.path);
    if (existing) {
      if (!buffersEqual(existing.after, operation.after)) throw new Error("Selected Project components conflict at " + operation.path + ".");
      continue;
    }
    byPath.set(operation.path, operation);
  }
  return [...byPath.values()];
}

async function applyOperations(operations: FileOperation[]): Promise<void> {
  const completed: string[] = [];
  try {
    for (const operation of operations) {
      const current = await readSafeFile(operation.path);
      if (!buffersEqual(current, operation.before)) throw new Error("Project component changed during delivery: " + operation.path);
      if (operation.after === undefined) await unlink(operation.path);
      else await atomicWriteFile(operation.path, operation.after);
      completed.push(operation.path);
    }
  } catch (error) {
    if (completed.length > 0) throw new Error("Partial Project component update; completed " + completed.length + " change(s): " + completed.join(", ") + ". " + (error as Error).message);
    throw error;
  }
}

async function sourceFiles(root: string): Promise<Array<{ relative: string; content: Buffer }>> {
  const files: Array<{ relative: string; content: Buffer }> = [];
  async function walk(directory: string): Promise<void> {
    try {
      const rootInfo = await lstat(directory);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Unsafe Project Plugin source directory: " + directory);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; else return; }
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      const info = await lstat(file);
      if (info.isSymbolicLink() || info.nlink > 1) throw new Error("Unsafe Project Plugin source resource: " + file);
      if (info.isDirectory()) await walk(file);
      else if (info.isFile()) files.push({ relative: path.relative(root, file).split(path.sep).join("/"), content: await readFile(file) });
      else throw new Error("Unsupported Project Plugin resource type: " + file);
    }
  }
  await walk(root);
  return files.sort((a, b) => a.relative.localeCompare(b.relative));
}

async function safeDirectories(root: string): Promise<string[]> {
  try {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Unsafe Project Plugin source directory: " + root);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; else return []; }
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const directories: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw new Error("Unsafe Project Plugin source resource: " + target);
    if (info.isDirectory()) directories.push(entry.name);
  }
  return directories.sort();
}

async function readSafeFile(file: string): Promise<Buffer | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Unsafe Project component path: " + file);
    return await readFile(file);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

async function assertSafeAncestors(target: string, boundary: string): Promise<void> {
  const root = path.resolve(boundary);
  const absolute = path.resolve(target);
  assertInside(root, absolute);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Unsafe Project workspace directory: " + root);
  const relative = path.relative(root, path.dirname(absolute));
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Project component directory: " + current);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; else return; }
  }
}

function canonical(value: unknown): string { return JSON.stringify(value); }
function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.equals(right);
}
function relativeTarget(workspaceRoot: string, target: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(target)).split(path.sep).join("/");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Project component path escapes its workspace: " + target);
  return relative;
}
function assertInside(root: string, target: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) throw new Error("Project component path escapes its workspace: " + target);
}
