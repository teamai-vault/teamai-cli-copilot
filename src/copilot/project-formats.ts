import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";

export interface ProjectPluginResource {
  relativePath: string;
  sourceHash: string;
  content: Buffer;
}

export interface ProjectHookFormat {
  sourceHash: string;
  content: Buffer;
  resources: ProjectPluginResource[];
}

export interface ProjectMcpFormat {
  resources: ProjectPluginResource[];
  servers: Array<{ name: string; sourcePath: string; sourceHash: string; value: unknown }>;
}

export interface WorkspaceMcpDocument {
  servers: Record<string, unknown>;
  set(name: string, value: unknown): void;
  toBuffer(): Buffer;
}

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

/** Read and validate Copilot's numeric-version Hook file and rebase its local Plugin resources. */
export async function readProjectHookFormat(pluginRoot: string, destinationRoot: string): Promise<ProjectHookFormat | undefined> {
  const sourceRoot = path.join(pluginRoot, "com.github.copilot", "hooks");
  const configPath = path.join(sourceRoot, "hooks.json");
  await assertSafePluginPath(pluginRoot, sourceRoot);
  const raw = await readSafePluginFile(pluginRoot, configPath);
  if (!raw) return undefined;
  const parsed = parseNativeJson(raw.toString("utf8"), configPath) as { version?: unknown; hooks?: unknown };
  if (parsed.version !== 1 || !parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) {
    throw new Error("Unsupported Project Hook format in " + configPath + "; expected version: 1 and a hooks object.");
  }
  const hooks = parsed.hooks as Record<string, unknown>;
  for (const [event, declarations] of Object.entries(hooks)) {
    if (!/^[a-z][A-Za-z0-9]*$/.test(event) || !Array.isArray(declarations)) {
      throw new Error("Unsupported Project Hook event '" + event + "' in " + configPath + "; each event must map to an array.");
    }
    for (const declaration of declarations) {
      if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
        throw new Error("Unsupported Project Hook declaration for '" + event + "' in " + configPath + "; expected a command Hook object.");
      }
      const hook = declaration as { type?: unknown; command?: unknown; timeoutSec?: unknown; cwd?: unknown; env?: unknown };
      if (hook.type !== "command" || typeof hook.command !== "string" || hook.command.trim().length === 0) {
        throw new Error("Unsupported Project Hook declaration for '" + event + "' in " + configPath + "; expected type: command and a non-empty command string.");
      }
      if (hook.timeoutSec !== undefined && (typeof hook.timeoutSec !== "number" || !Number.isFinite(hook.timeoutSec) || hook.timeoutSec <= 0)) {
        throw new Error("Invalid Project Hook timeoutSec for '" + event + "' in " + configPath + ".");
      }
      if (hook.cwd !== undefined && typeof hook.cwd !== "string") throw new Error("Invalid Project Hook cwd for '" + event + "' in " + configPath + ".");
      if (hook.env !== undefined && (!hook.env || typeof hook.env !== "object" || Array.isArray(hook.env) || Object.values(hook.env).some((value) => typeof value !== "string"))) {
        throw new Error("Invalid Project Hook env for '" + event + "' in " + configPath + ".");
      }
    }
  }
  const resources = await copyReferencedResources(pluginRoot, hooks);
  const rebased = rewritePluginRoot(parsed, destinationRoot);
  return { sourceHash: hash(raw), content: Buffer.from(JSON.stringify(rebased, null, 2) + "\n", "utf8"), resources };
}

/** Read and validate Copilot's workspace MCP declaration and rebase local Plugin resources. */
export async function readProjectMcpFormat(pluginRoot: string, destinationRoot: string): Promise<ProjectMcpFormat | undefined> {
  const configPath = path.join(pluginRoot, "mcp.json");
  const raw = await readSafePluginFile(pluginRoot, configPath);
  if (!raw) return undefined;
  const parsed = parseNativeJson(raw.toString("utf8"), configPath) as { mcpServers?: unknown };
  if (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers) || Object.keys(parsed.mcpServers).length === 0) {
    throw new Error("Unsupported Project MCP format in " + configPath + "; expected a non-empty mcpServers object.");
  }
  const sourceServers = parsed.mcpServers as Record<string, unknown>;
  for (const [name, value] of Object.entries(sourceServers)) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name)) throw new Error("Unsafe Project MCP server name '" + name + "'.");
    validateMcpServer(name, value, configPath);
  }
  const resources = await copyReferencedResources(pluginRoot, sourceServers);
  const rebased = rewritePluginRoot(sourceServers, destinationRoot) as Record<string, unknown>;
  return {
    resources,
    servers: Object.entries(rebased).map(([name, value]) => ({
      name,
      sourcePath: "mcp.json#/mcpServers/" + name,
      sourceHash: hash(JSON.stringify(sourceServers[name])),
      value,
    })),
  };
}

/** Keep JSONC parsing and edits for Copilot's workspace MCP file inside its native-format boundary. */
export function readWorkspaceMcpDocument(raw: Buffer | undefined, configPath: string): WorkspaceMcpDocument {
  let text = raw?.toString("utf8") ?? "{}\n";
  const parsed = parseNativeJson(text, configPath) as { mcpServers?: unknown };
  if (parsed.mcpServers !== undefined && (!parsed.mcpServers || typeof parsed.mcpServers !== "object" || Array.isArray(parsed.mcpServers))) {
    throw new Error(configPath + " must contain an object-valued mcpServers property.");
  }
  const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
  return {
    servers,
    set(name, value) {
      text = applyEdits(text, modify(text, ["mcpServers", name], value, { formattingOptions: { insertSpaces: true, tabSize: 2 } }));
    },
    toBuffer: () => Buffer.from(text, "utf8"),
  };
}

/** Reject a link or non-directory at every source ancestor under the confirmed Plugin root. */
export async function assertSafePluginPath(pluginRoot: string, target: string): Promise<void> {
  const root = path.resolve(pluginRoot);
  const absolute = path.resolve(target);
  const relative = path.relative(root, absolute);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
    throw new Error("Project Plugin source path escapes its confirmed root: " + target);
  }
  let current = root;
  const rootInfo = await lstat(current);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Unsafe confirmed Project Plugin root: " + root);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe Project Plugin source path: " + current);
  }
}

async function copyReferencedResources(pluginRoot: string, value: unknown): Promise<ProjectPluginResource[]> {
  const resources: ProjectPluginResource[] = [];
  for (const relativePath of pluginRootReferences(value)) {
    if (relativePath === "") continue;
    const content = await readPluginResource(pluginRoot, relativePath);
    resources.push({ relativePath, sourceHash: hash(content), content });
  }
  return resources;
}

function validateMcpServer(name: string, value: unknown, source: string): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unsupported Project MCP server '" + name + "' in " + source + "; expected a server object.");
  }
  const server = value as { type?: unknown; command?: unknown; args?: unknown; cwd?: unknown; env?: unknown; url?: unknown; headers?: unknown };
  if (server.type !== undefined && server.type !== "stdio" && server.type !== "http" && server.type !== "sse") {
    throw new Error("Unsupported Project MCP server type for '" + name + "' in " + source + ".");
  }
  if (server.type === "http" || server.type === "sse") {
    if (typeof server.url !== "string" || server.url.trim().length === 0) throw new Error("Project MCP server '" + name + "' requires a URL in " + source + ".");
    if (server.headers !== undefined && (!server.headers || typeof server.headers !== "object" || Array.isArray(server.headers) || Object.values(server.headers).some((entry) => typeof entry !== "string"))) {
      throw new Error("Invalid Project MCP headers for '" + name + "' in " + source + ".");
    }
  } else {
    if (typeof server.command !== "string" || server.command.trim().length === 0) throw new Error("Project MCP stdio server '" + name + "' requires a command in " + source + ".");
    if (server.args !== undefined && (!Array.isArray(server.args) || server.args.some((entry) => typeof entry !== "string"))) {
      throw new Error("Invalid Project MCP args for '" + name + "' in " + source + ".");
    }
    if (server.cwd !== undefined && typeof server.cwd !== "string") throw new Error("Invalid Project MCP cwd for '" + name + "' in " + source + ".");
    if (server.env !== undefined && (!server.env || typeof server.env !== "object" || Array.isArray(server.env) || Object.values(server.env).some((entry) => typeof entry !== "string"))) {
      throw new Error("Invalid Project MCP env for '" + name + "' in " + source + ".");
    }
  }
}

async function readPluginResource(pluginRoot: string, relative: string): Promise<Buffer> {
  const segments = relative.replaceAll("\\", "/").split("/");
  if (path.isAbsolute(relative) || segments.some((segment) => segment === ".." || segment === "." || segment.includes("\0"))) {
    throw new Error("Project Plugin resource path escapes its source root: " + relative);
  }
  let current = path.resolve(pluginRoot);
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try { info = await lstat(current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Project Plugin resource is missing: " + relative); throw error; }
    if (info.isSymbolicLink() || (current === path.resolve(pluginRoot, ...segments) ? !info.isFile() || info.nlink > 1 : !info.isDirectory())) {
      throw new Error("Unsafe Project Plugin resource: " + current);
    }
  }
  return await readFile(current);
}

async function readSafePluginFile(pluginRoot: string, file: string): Promise<Buffer | undefined> {
  const parent = path.dirname(file);
  await assertSafePluginPath(pluginRoot, parent);
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Unsafe Project Plugin format file: " + file);
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseNativeJson(text: string, source: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parse(text, errors, { allowTrailingComma: false, disallowComments: false });
  if (errors.length > 0 || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(source + " contains invalid JSON/JSONC.");
  }
  return parsed;
}

function pluginRootReferences(value: unknown): string[] {
  const references = new Set<string>();
  const visit = (current: unknown) => {
    if (typeof current === "string") {
      const matches = [...current.matchAll(/\$\{PLUGIN_ROOT\}((?:[\\/][^"'`]*)?)/g)];
      if (current.includes("PLUGIN_ROOT") && matches.length === 0) throw new Error("Unsupported Project Plugin resource placeholder.");
      for (const match of matches) {
        const relative = (match[1] ?? "").replace(/^[\\/]+/, "").replaceAll("\\", "/");
        if (relative.split("/").some((segment) => segment === ".." || segment === "." || segment.includes("\0"))) {
          throw new Error("Project Plugin resource path escapes its source root.");
        }
        references.add(relative);
      }
      return;
    }
    if (Array.isArray(current)) for (const item of current) visit(item);
    else if (current && typeof current === "object") for (const item of Object.values(current)) visit(item);
  };
  visit(value);
  return [...references].sort((left, right) => left.localeCompare(right));
}

function rewritePluginRoot(value: unknown, destinationRoot: string): unknown {
  if (typeof value === "string") return value.replaceAll("${PLUGIN_ROOT}", destinationRoot);
  if (Array.isArray(value)) return value.map((item) => rewritePluginRoot(item, destinationRoot));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewritePluginRoot(item, destinationRoot)]));
}
