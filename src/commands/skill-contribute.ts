import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { readGlobalConfig } from "../config/global.js";
import { readGitIdentity, resolveGitHubMarketplaceRemote } from "../contribution/github.js";
import { loadMarketplaceCatalog, readSkillFrontmatter } from "../copilot/catalog.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { atomicWriteText, replaceDirectory } from "../utils/fs.js";
import type { CommandContext } from "./context.js";

export interface SkillContributeOptions {
  path: string;
  owner: string;
  tags: string[];
  target: "standalone" | "plugin";
  plugin?: string;
}

export async function skillContributeCommand(context: CommandContext, options: SkillContributeOptions): Promise<void> {
  if (!options.owner.trim() || /[\r\n]/.test(options.owner)) throw new Error("--owner must be a non-empty single-line value.");
  if (options.target === "standalone" && options.plugin) throw new Error("--plugin is only valid with --target plugin.");
  if (options.target === "plugin" && !options.plugin) throw new Error("--target plugin requires --plugin <name>.");
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const identity = await detectProjectIdentity(context.cwd);
  if (!identity) throw new Error("teamai skill contribute requires a Git repository.");
  const skill = await readLocalSkill(options.path, context.cwd);
  const gitIdentity = await readGitIdentity(identity.workspaceRoot);
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
  try {
    if (catalog.name !== config.marketplace.name) throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
    assertTarget(catalog, skill.name, options);
    const remote = await resolveGitHubMarketplaceRemote(config.marketplace.source, context.cwd);
    const branch = `teamai/skill-${skill.name.replace(/[^a-z0-9]+/g, "-")}-${context.now().getTime()}`;
    const result = await context.contributeGitHub({
      remote,
      branch,
      identity: gitIdentity,
      commitMessage: `teamai: contribute skill ${skill.name}`,
      pullRequestTitle: `Contribute skill: ${skill.name}`,
      pullRequestBody: `Contribute skill '${skill.name}' as ${options.target}.`,
      dryRun: context.dryRun,
      prepare: async (worktree) => await prepareSkillContribution(worktree, skill.root, skill.name, options),
    });
    context.out(`${context.dryRun ? "WOULD" : "DONE"} skill contribute: ${skill.root}`);
    for (const action of result.planned) context.out(`${context.dryRun ? "WOULD" : "DONE"} contribution: ${action}`);
    if (result.pullRequestUrl) context.out(`Pull request: ${result.pullRequestUrl}`);
  } finally {
    await catalog.dispose();
  }
}

async function readLocalSkill(input: string, cwd: string): Promise<{ root: string; name: string }> {
  const root = path.resolve(cwd, input);
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Skill source must be a regular directory: ${input}`);
  await assertSafeTree(root);
  const skillPath = path.join(root, "SKILL.md");
  let skillInfo;
  try {
    skillInfo = await lstat(skillPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Skill source requires a regular SKILL.md: ${input}`);
    throw error;
  }
  if (!skillInfo.isFile() || skillInfo.isSymbolicLink()) throw new Error(`Skill source requires a regular SKILL.md: ${input}`);
  return { root, name: (await readSkillFrontmatter(skillPath)).name };
}

async function prepareSkillContribution(
  worktree: string,
  source: string,
  name: string,
  options: SkillContributeOptions,
): Promise<string[]> {
  const catalog = await loadMarketplaceCatalog(worktree, worktree);
  try {
    assertTarget(catalog, name, options);
    const plugin = options.target === "plugin" ? catalog.plugins.find((candidate) => candidate.name === options.plugin) : undefined;
    const destination = options.target === "standalone"
      ? path.join("skills", name)
      : path.join(path.relative(worktree, plugin!.root), "skills", name);
    const target = safePath(worktree, destination);
    try {
      await lstat(target);
      throw new Error(`Marketplace skill target '${destination.replaceAll(path.sep, "/")}' already exists.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await replaceDirectory(source, target);
    await addMetadata(worktree, name, options);
    const updated = await loadMarketplaceCatalog(worktree, worktree);
    try {
      const contributed = updated.skills.find((skill) => skill.name === name);
      if (!contributed || contributed.sourceType !== options.target || contributed.plugin !== options.plugin || contributed.owner !== options.owner.trim()) {
        throw new Error(`Marketplace skill contribution '${name}' did not validate after update.`);
      }
    } finally {
      await updated.dispose();
    }
    return [destination.replaceAll(path.sep, "/"), "skills.yaml"];
  } finally {
    await catalog.dispose();
  }
}

function assertTarget(catalog: Awaited<ReturnType<typeof loadMarketplaceCatalog>>, name: string, options: SkillContributeOptions): void {
  if (catalog.skills.some((skill) => skill.name === name)) throw new Error(`Marketplace already contains skill '${name}'.`);
  if (options.target === "plugin" && !catalog.plugins.some((plugin) => plugin.name === options.plugin)) {
    throw new Error(`Marketplace plugin '${options.plugin}' does not exist.`);
  }
}

async function addMetadata(worktree: string, name: string, options: SkillContributeOptions): Promise<void> {
  const metadataPath = safePath(worktree, "skills.yaml");
  const info = await lstat(metadataPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Marketplace skills.yaml is unsafe.");
  const document = parseDocument(await readFile(metadataPath, "utf8"), { uniqueKeys: true });
  if (document.errors.length > 0) throw new Error("Marketplace skills.yaml is invalid.");
  document.setIn(["skills", name], {
    owner: options.owner.trim(),
    tags: normalizeTags(options.tags),
    standalone: options.target === "standalone",
  });
  await atomicWriteText(metadataPath, document.toString());
}

function normalizeTags(tags: string[]): string[] {
  const normalized = tags.flatMap((tag) => tag.split(",")).map((tag) => tag.trim()).filter(Boolean);
  if (normalized.some((tag) => /[\r\n]/.test(tag))) throw new Error("Skill tags must be single-line values.");
  return [...new Set(normalized)];
}

function safePath(root: string, relativePath: string): string {
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe Marketplace path '${relativePath}'.`);
  }
  return target;
}

async function assertSafeTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    const info = await lstat(child);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) throw new Error(`Unsafe skill source path: ${child}`);
    if (info.isDirectory()) await assertSafeTree(child);
  }
}
