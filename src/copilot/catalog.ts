import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseDocument } from "yaml";
import { teamAiHome } from "../config/global.js";
import { withFileLock } from "../utils/fs.js";
import { runProcess } from "../utils/process.js";

export const TEAM_AI_EXTENSION_NAMESPACE = "com.company.teamai";
const AGENT_PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export type TeamAiPluginKind = "common" | "role" | "project";

export interface MarketplaceLoadOptions {
  homeDir?: string;
  refresh?: boolean;
  dryRun?: boolean;
}

export interface CatalogPlugin {
  name: string;
  version: string;
  kind: TeamAiPluginKind;
  root: string;
}

export interface CatalogSkill {
  name: string;
  description: string;
  sourceType: "plugin" | "standalone";
  plugin?: string;
  sourcePath: string;
  root: string;
  owner: string;
  tags: string[];
  standalone: boolean;
}

export interface MarketplaceCatalog {
  name: string;
  root: string;
  revision?: string;
  plugins: CatalogPlugin[];
  skills: CatalogSkill[];
  dispose: () => Promise<void>;
}

interface MarketplaceManifest {
  name?: unknown;
  plugins?: Array<{ name?: unknown; version?: unknown; source?: unknown }>;
}

interface PluginManifest {
  name?: unknown;
  version?: unknown;
  extensions?: Record<string, { kind?: unknown }>;
}

interface SkillMetadata {
  owner: string;
  tags: string[];
  standalone?: boolean;
}

export async function loadMarketplaceCatalog(
  source: string,
  cwd: string,
  options: MarketplaceLoadOptions = {},
): Promise<MarketplaceCatalog> {
  const materialized = await materializeMarketplace(source, cwd, options);
  try {
    const root = await realpath(materialized.root);
    const manifest = await readJson<MarketplaceManifest>(path.join(root, ".github", "plugin", "marketplace.json"));
    if (typeof manifest.name !== "string" || !AGENT_PLUGIN_NAME.test(manifest.name) || !Array.isArray(manifest.plugins)) {
      throw new Error("Marketplace manifest requires name and plugins.");
    }

    const plugins = await Promise.all(manifest.plugins.map(async (entry) => {
      if (typeof entry.name !== "string" || !AGENT_PLUGIN_NAME.test(entry.name) || typeof entry.version !== "string" || typeof entry.source !== "string") {
        throw new Error("Marketplace plugin entries require name, version, and source.");
      }
      const pluginRoot = await realpath(path.resolve(root, entry.source));
      if (isOutside(root, pluginRoot)) throw new Error(`${entry.name}: plugin source must stay inside the Marketplace.`);
      const plugin = await readJson<PluginManifest>(path.join(pluginRoot, "plugin.json"));
      if (plugin.name !== entry.name || plugin.version !== entry.version) {
        throw new Error(`${entry.name}: Marketplace entry does not match plugin.json name/version.`);
      }
      const kind = plugin.extensions?.[TEAM_AI_EXTENSION_NAMESPACE]?.kind;
      if (kind !== "common" && kind !== "role" && kind !== "project") {
        throw new Error(`${entry.name}: plugin.json requires extensions.${TEAM_AI_EXTENSION_NAMESPACE}.kind (common, role, or project).`);
      }
      return { name: entry.name, version: entry.version, kind: kind as TeamAiPluginKind, root: pluginRoot };
    }));

    if (plugins.filter((plugin) => plugin.kind === "common").length !== 1) {
      throw new Error("Marketplace must contain exactly one Team AI common plugin.");
    }
    if (!plugins.some((plugin) => plugin.kind === "role")) {
      throw new Error("Marketplace must contain at least one Team AI role plugin.");
    }
    const skills = await loadSkills(root, plugins);
    return { name: manifest.name, root, revision: materialized.revision, plugins, skills, dispose: materialized.dispose };
  } catch (error) {
    await materialized.dispose();
    throw error;
  }
}

async function loadSkills(root: string, plugins: CatalogPlugin[]): Promise<CatalogSkill[]> {
  const metadata = await loadSkillMetadata(root);
  const discovered = [
    ...await discoverSkills(path.join(root, "skills"), root, root, "standalone"),
    ...await Promise.all(plugins.map((plugin) => discoverSkills(path.join(plugin.root, "skills"), plugin.root, root, "plugin", plugin.name))),
  ].flat();
  const names = new Set<string>();
  for (const skill of discovered) {
    if (names.has(skill.name)) throw new Error(`Duplicate Marketplace skill '${skill.name}'.`);
    names.add(skill.name);
    const entry = metadata.get(skill.name);
    if (!entry) throw new Error(`Marketplace skills.yaml is missing metadata for skill '${skill.name}'.`);
    skill.owner = entry.owner;
    skill.tags = entry.tags;
    skill.standalone = skill.sourceType === "standalone" || entry.standalone === true;
  }
  for (const name of metadata.keys()) {
    if (!names.has(name)) throw new Error(`Marketplace skills.yaml references missing skill '${name}'.`);
  }
  return discovered.sort((left, right) => left.name.localeCompare(right.name));
}

async function discoverSkills(
  sourceRoot: string,
  containmentRoot: string,
  marketplaceRoot: string,
  sourceType: CatalogSkill["sourceType"],
  plugin?: string,
): Promise<CatalogSkill[]> {
  let entries;
  try {
    const info = await lstat(sourceRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe Marketplace skills directory '${sourceRoot}'.`);
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const skills: CatalogSkill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !AGENT_PLUGIN_NAME.test(entry.name)) continue;
    const skillRoot = await realpath(path.join(sourceRoot, entry.name));
    if (isOutside(containmentRoot, skillRoot)) throw new Error(`Unsafe Marketplace skill '${entry.name}'.`);
    let skillPath: string;
    try {
      skillPath = await realpath(path.join(skillRoot, "SKILL.md"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (isOutside(containmentRoot, skillPath)) throw new Error(`Unsafe Marketplace skill '${entry.name}'.`);
    const frontmatter = await readSkillFrontmatter(skillPath);
    if (frontmatter.name !== entry.name) throw new Error(`Marketplace skill directory '${entry.name}' does not match SKILL.md name.`);
    skills.push({
      name: entry.name,
      description: frontmatter.description,
      sourceType,
      ...(plugin ? { plugin } : {}),
      sourcePath: path.relative(marketplaceRoot, skillRoot).replaceAll(path.sep, "/"),
      root: skillRoot,
      owner: "",
      tags: [],
      standalone: sourceType === "standalone",
    });
  }
  return skills;
}

export async function readSkillFrontmatter(skillPath: string): Promise<{ name: string; description: string }> {
  const contents = await readFile(skillPath, "utf8");
  const match = contents.match(/^---\s*\r?\n([\s\S]*?)^---\s*(?:\r?\n|$)/m);
  if (!match) throw new Error(`Marketplace skill '${skillPath}' requires YAML frontmatter.`);
  const document = parseDocument(match[1], { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error(`Marketplace skill '${skillPath}' has invalid frontmatter.`);
  const value = document.toJSON();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Marketplace skill '${skillPath}' has invalid frontmatter.`);
  const { name, description } = value as { name?: unknown; description?: unknown };
  if (typeof name !== "string" || !AGENT_PLUGIN_NAME.test(name)) throw new Error(`Marketplace skill '${skillPath}' requires a safe frontmatter name.`);
  if (typeof description !== "string" || description.trim().length === 0) throw new Error(`Marketplace skill '${skillPath}' requires a frontmatter description.`);
  return { name, description };
}

async function loadSkillMetadata(root: string): Promise<Map<string, SkillMetadata>> {
  const metadataPath = path.join(root, "skills.yaml");
  let contents: string;
  try {
    contents = await readFile(metadataPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("Marketplace skills.yaml is missing.");
    throw error;
  }
  const document = parseDocument(contents, { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error("Marketplace skills.yaml is invalid.");
  const value = document.toJSON();
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Marketplace skills.yaml must be a YAML object.");
  const candidate = value as { version?: unknown; skills?: unknown };
  if (candidate.version !== 1 || !candidate.skills || typeof candidate.skills !== "object" || Array.isArray(candidate.skills)) {
    throw new Error("Marketplace skills.yaml requires version: 1 and a skills object.");
  }
  const metadata = new Map<string, SkillMetadata>();
  for (const [name, entry] of Object.entries(candidate.skills)) {
    if (!AGENT_PLUGIN_NAME.test(name) || !entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Marketplace skills.yaml has invalid metadata for '${name}'.`);
    }
    const fields = entry as Record<string, unknown>;
    if (Object.keys(fields).some((key) => key !== "owner" && key !== "tags" && key !== "standalone")) {
      throw new Error(`Marketplace skills.yaml metadata for '${name}' supports only owner, tags, and standalone.`);
    }
    if (typeof fields.owner !== "string" || fields.owner.trim().length === 0) {
      throw new Error(`Marketplace skills.yaml metadata for '${name}' requires a non-empty owner.`);
    }
    if (fields.tags !== undefined && (!Array.isArray(fields.tags) || fields.tags.some((tag) => typeof tag !== "string" || tag.trim().length === 0))) {
      throw new Error(`Marketplace skills.yaml metadata for '${name}' has invalid tags.`);
    }
    if (fields.standalone !== undefined && typeof fields.standalone !== "boolean") {
      throw new Error(`Marketplace skills.yaml metadata for '${name}' has invalid standalone.`);
    }
    metadata.set(name, { owner: fields.owner, tags: fields.tags as string[] | undefined ?? [], standalone: fields.standalone as boolean | undefined });
  }
  return metadata;
}

async function materializeMarketplace(
  source: string,
  cwd: string,
  options: MarketplaceLoadOptions,
): Promise<{ root: string; revision?: string; dispose: () => Promise<void> }> {
  const local = path.resolve(cwd, source);
  try {
    if ((await stat(local)).isDirectory()) {
      return { root: local, revision: await gitRevision(local), dispose: async () => undefined };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const { url, ref } = gitSource(source);
  if (!options.refresh) {
    const cached = marketplaceCachePaths(source, options.homeDir ?? os.homedir());
    if (!await isDirectory(cached.checkout)) {
      throw new Error(`Marketplace cache is missing for '${source}'. Run \`teamai init\` or \`teamai sync\` first.`);
    }
    return {
      root: cached.checkout,
      revision: await requiredGitRevision(cached.checkout, source),
      dispose: async () => undefined,
    };
  }

  if (options.dryRun) {
    return await materializeTemporary(source, cwd, url, ref);
  }

  const cached = marketplaceCachePaths(source, options.homeDir ?? os.homedir());
  await refreshMarketplaceCache(cached, source, cwd, url, ref);
  return {
    root: cached.checkout,
    revision: await requiredGitRevision(cached.checkout, source),
    dispose: async () => undefined,
  };
}

function gitSource(source: string): { url: string; ref?: string } {
  const hash = source.indexOf("#");
  const base = hash >= 0 ? source.slice(0, hash) : source;
  const ref = hash >= 0 ? source.slice(hash + 1) || undefined : undefined;
  const shorthand = base.match(/^([^/\s]+)\/([^/#\s]+)$/);
  if (!shorthand) return { url: base, ref };
  return {
    url: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`,
    ref,
  };
}

function marketplaceCachePaths(source: string, homeDir: string): { root: string; checkout: string; lock: string } {
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const root = path.join(teamAiHome(homeDir), "marketplaces", sourceHash);
  return { root, checkout: path.join(root, "checkout"), lock: path.join(root, "lock") };
}

async function refreshMarketplaceCache(
  cache: { root: string; checkout: string; lock: string },
  source: string,
  cwd: string,
  url: string,
  ref: string | undefined,
): Promise<void> {
  await withFileLock(cache.lock, async () => {
    if (!await isDirectory(cache.checkout)) {
      const temporary = path.join(cache.root, `.checkout.${process.pid}.${Date.now()}.tmp`);
      await rm(temporary, { recursive: true, force: true });
      try {
        await cloneMarketplace(url, cwd, temporary, source);
        if (ref) await checkoutRef(temporary, ref, source);
        await rename(temporary, cache.checkout);
      } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        throw error;
      }
      return;
    }

    const fetched = await runProcess(
      "git",
      ["fetch", "--depth", "1", "origin", ...(ref ? [ref] : [])],
      { cwd: cache.checkout },
    );
    if (fetched.exitCode !== 0) {
      throw new Error(`Could not refresh Marketplace '${source}': ${fetched.stderr.trim() || fetched.stdout.trim()}`);
    }
    const reset = await runProcess("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: cache.checkout });
    if (reset.exitCode !== 0) {
      throw new Error(`Could not checkout Marketplace '${source}': ${reset.stderr.trim() || reset.stdout.trim()}`);
    }
  });
}

async function materializeTemporary(
  source: string,
  cwd: string,
  url: string,
  ref: string | undefined,
): Promise<{ root: string; revision?: string; dispose: () => Promise<void> }> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "teamai-marketplace-"));
  const checkout = path.join(temporaryRoot, "checkout");
  try {
    await cloneMarketplace(url, cwd, checkout, source);
    if (ref) await checkoutRef(checkout, ref, source);
    return {
      root: checkout,
      revision: await requiredGitRevision(checkout, source),
      dispose: async () => rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

async function cloneMarketplace(url: string, cwd: string, checkout: string, source: string): Promise<void> {
  const clone = await runProcess("git", ["clone", "-c", "core.longpaths=true", "--depth", "1", url, checkout], { cwd });
  if (clone.exitCode !== 0) {
    throw new Error(`Could not clone Marketplace '${source}': ${clone.stderr.trim() || clone.stdout.trim()}`);
  }
}

async function checkoutRef(checkout: string, ref: string, source: string): Promise<void> {
  const fetch = await runProcess("git", ["fetch", "--depth", "1", "origin", ref], { cwd: checkout });
  if (fetch.exitCode !== 0) {
    throw new Error(`Could not checkout Marketplace ref '${ref}' from '${source}': ${fetch.stderr.trim() || fetch.stdout.trim()}`);
  }
  const reset = await runProcess("git", ["reset", "--hard", "FETCH_HEAD"], { cwd: checkout });
  if (reset.exitCode !== 0) {
    throw new Error(`Could not checkout Marketplace ref '${ref}' from '${source}': ${reset.stderr.trim() || reset.stdout.trim()}`);
  }
}

async function gitRevision(root: string): Promise<string | undefined> {
  const revision = await runProcess("git", ["rev-parse", "HEAD"], { cwd: root });
  return revision.exitCode === 0 ? revision.stdout.trim() || undefined : undefined;
}

async function requiredGitRevision(root: string, source: string): Promise<string> {
  const revision = await gitRevision(root);
  if (!revision) throw new Error(`Marketplace cache for '${source}' is not a valid Git checkout.`);
  return revision;
}

async function isDirectory(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isOutside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function readJson<T>(filePath: string): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${filePath} contains invalid JSON.`);
    throw error;
  }
}
