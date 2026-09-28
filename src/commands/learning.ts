import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { readGlobalConfig } from "../config/global.js";
import { readGitIdentity, resolveGitHubMarketplaceRemote } from "../contribution/github.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { projectionFor } from "../project/context.js";
import { loadLogicalProjects, selectedLogicalProjects } from "../project/manifest.js";
import { readProjectState } from "../project/state.js";
import { atomicWriteText, readTextIfExists } from "../utils/fs.js";
import type { CommandContext } from "./context.js";

export interface LearningShareOptions {
  file: string;
  project?: string;
  shared?: boolean;
  tags: string[];
}

export async function learningShareCommand(context: CommandContext, options: LearningShareOptions): Promise<void> {
  if (options.project && options.shared) throw new Error("Use either --project <id> or --shared.");
  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new Error("Team AI is not initialized. Run `teamai init` first.");
  const identity = await detectProjectIdentity(context.cwd);
  if (!identity) throw new Error("teamai learning share requires a Git repository.");
  const learning = await readLearning(options.file, context.cwd);
  const gitIdentity = await readGitIdentity(identity.workspaceRoot);
  const catalog = await context.loadMarketplace(config.marketplace.source, context.cwd);
  try {
    if (catalog.name !== config.marketplace.name) throw new Error(`Marketplace name changed from '${config.marketplace.name}' to '${catalog.name}'.`);
    const state = await readProjectState(identity.projectAnchor, context.homeDir);
    const active = projectionFor(state, identity.workspaceRoot)?.logicalProjects ?? [];
    const target = resolveTarget(options, active, await loadLogicalProjects(catalog.root, catalog.plugins));
    const destination = path.posix.join("learnings", target, learning.name);
    const frontmatter = stringify({
      title: learning.title,
      owner: gitIdentity.name,
      logicalProject: target,
      sourceRepo: path.basename(identity.projectAnchor),
      createdAt: context.now().toISOString(),
      tags: normalizeTags(options.tags),
    });
    const contents = `---\n${frontmatter}---\n\n${learning.contents}`;
    const remote = await resolveGitHubMarketplaceRemote(config.marketplace.source, context.cwd);
    const branch = `teamai/learning-${target.replace(/[^a-z0-9]+/g, "-")}-${context.now().getTime()}`;
    const result = await context.contributeGitHub({
      remote,
      branch,
      identity: gitIdentity,
      commitMessage: `teamai: share learning ${learning.title}`,
      pullRequestTitle: `Share learning: ${learning.title}`,
      pullRequestBody: `Share learning '${learning.title}' for ${target}.`,
      dryRun: context.dryRun,
      prepare: async (worktree) => {
        const targetPath = safeContributionPath(worktree, destination);
        if (await readTextIfExists(targetPath) !== undefined) throw new Error(`Learning already exists at '${destination}'. Choose a different file name.`);
        await atomicWriteText(targetPath, contents);
        return [destination];
      },
    });
    context.out(`${context.dryRun ? "WOULD" : "DONE"} learning share: ${learning.path} -> ${destination}`);
    for (const action of result.planned) context.out(`${context.dryRun ? "WOULD" : "DONE"} contribution: ${action}`);
    if (result.pullRequestUrl) context.out(`Pull request: ${result.pullRequestUrl}`);
  } finally {
    await catalog.dispose();
  }
}

function resolveTarget(options: LearningShareOptions, active: string[], projects: Awaited<ReturnType<typeof loadLogicalProjects>>): string {
  if (options.shared) return "shared";
  if (options.project) return selectedLogicalProjects(projects, [options.project])[0].id;
  selectedLogicalProjects(projects, active);
  if (active.length === 0) return "shared";
  if (active.length === 1) return active[0];
  throw new Error("Multiple Logical Projects are active. Use --project <id> or --shared.");
}

function normalizeTags(tags: string[]): string[] {
  const normalized = tags.flatMap((tag) => tag.split(",")).map((tag) => tag.trim()).filter(Boolean);
  if (normalized.some((tag) => /[\r\n]/.test(tag))) throw new Error("Learning tags must be single-line values.");
  return [...new Set(normalized)];
}

async function readLearning(input: string, cwd: string): Promise<{ path: string; name: string; title: string; contents: string }> {
  const filePath = path.resolve(cwd, input);
  const info = await lstat(filePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Learning source must be a regular file: ${input}`);
  const name = path.basename(filePath);
  if (!/^[a-z0-9][a-z0-9._-]*\.md$/i.test(name)) throw new Error("Learning source file name must be a safe Markdown file name.");
  const contents = await readFile(filePath, "utf8");
  if (contents.startsWith("---\n") || contents.startsWith("---\r\n")) {
    throw new Error("Learning source must contain Markdown body only; Team AI creates its frontmatter.");
  }
  return { path: filePath, name, title: path.basename(name, ".md").replace(/[-_]+/g, " "), contents };
}

function safeContributionPath(worktree: string, destination: string): string {
  const target = path.resolve(worktree, ...destination.split("/"));
  const relative = path.relative(worktree, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Unsafe learning destination '${destination}'.`);
  }
  return target;
}
