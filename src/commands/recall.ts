import path from "node:path";
import { readGlobalConfig } from "../config/global.js";
import { listLearningOperationHeaders, readLearningOperation, readLearningPayload } from "../contribution/learning-outbox.js";
import { resourceSourceHash } from "../resources/snapshot.js";
import { detectProjectIdentity } from "../project/anchors.js";
import { projectionFor } from "../project/context.js";
import { loadLogicalProjects, selectedLogicalProjects } from "../project/manifest.js";
import {
  parseRecallMarkdown,
  parseRecallQuery,
  rankRecallCandidates,
  readVerifiedProjectDocs,
  sha256,
  MAX_RECALL_BYTES,
  MAX_RECALL_FILES,
  MAX_RECALL_FILE_BYTES,
  RecallInputError,
  type RecallCandidate,
} from "../project/recall.js";
import { readProjectState } from "../project/state.js";
import { publishedLearningSourceHash, readPublishedLearningFiles, readPublishedLearningIndex } from "../project/published-cache.js";
import type { CommandContext } from "./context.js";

const PROJECT_ID = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export interface RecallOptions {
  query: string;
  scope?: "auto" | "user" | "workspace";
  project?: string;
  limit?: string;
  requiredLiterals?: string[];
  includePending?: boolean;
  json?: boolean;
}

export class RecallCommandError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function recallCommand(context: CommandContext, options: RecallOptions): Promise<void> {
  const query = options.query;
  const requiredLiterals = options.requiredLiterals ?? [];
  const terms = parseRecallQuery(query, requiredLiterals);
  const limit = parseLimit(options.limit);
  const requestedScope = options.scope ?? "auto";
  if (options.project && !PROJECT_ID.test(options.project)) throw new RecallInputError("--project must be a safe Logical Project ID.");
  if (requestedScope === "user" && options.project) throw new RecallInputError("--project is not allowed with --scope user.");

  const config = await readGlobalConfig(context.homeDir);
  if (!config) throw new RecallCommandError("CONFIG_MISSING", "Team AI is not initialized. Run `teamai init` first.");
  const sourceHash = publishedLearningSourceHash(config.marketplace.source);

  const scope = await resolveScope(context, requestedScope, Boolean(options.project));
  let resourceRevision: string | undefined;
  let selectedProjects: string[] = [];
  let marketplaceRoot: string | undefined;
  if (scope.kind === "workspace") {
    const marketplace = await context.loadMarketplace(config.marketplace.source, context.cwd, { refresh: false });
    try {
      if (marketplace.name !== config.marketplace.name) {
        throw new RecallCommandError("SOURCE_MISMATCH", `Configured Marketplace '${config.marketplace.name}' does not match source '${marketplace.name}'.`);
      }
      if (!marketplace.revision || !/^[a-f0-9]{40,64}$/i.test(marketplace.revision)) {
        throw new RecallCommandError("RESOURCE_CACHE_UNAVAILABLE", "The Marketplace resource cache has no verifiable Git revision. Run `teamai sync` to refresh it.");
      }
      if (config.marketplaceRevision && config.marketplaceRevision !== marketplace.revision) {
        throw new RecallCommandError("RESOURCE_CACHE_STALE", "The Marketplace resource cache differs from the configured revision. Run `teamai sync` to refresh it.");
      }
      resourceRevision = marketplace.revision;
      marketplaceRoot = marketplace.root;
      const projects = await loadLogicalProjects(marketplace.root, marketplace.plugins);
      try {
        selectedLogicalProjects(projects, scope.activeProjects);
        selectedProjects = options.project
          ? selectedLogicalProjects(projects, [options.project]).map((project) => project.id)
          : [...scope.activeProjects];
      } catch (error) {
        throw new RecallCommandError("PROJECT_SCOPE_INVALID", error instanceof Error ? error.message : String(error));
      }
      if (options.project && !scope.activeProjects.includes(options.project)) {
        throw new RecallCommandError("PROJECT_NOT_ACTIVE", `Logical Project '${options.project}' is not active in this Workspace.`);
      }
    } finally {
      await marketplace.dispose();
    }
  }

  const indexRead = await readPublishedLearningIndex(config.marketplace.source, context.homeDir);
  if (!indexRead.index) throw new RecallCommandError("CACHE_UNAVAILABLE", indexRead.error ?? "Published Learnings cache is unavailable. Run `teamai sync` to refresh it.");
  const index = indexRead.index;
  const allowedProjects = new Set(selectedProjects);
  if (scope.kind === "workspace" && (!index.projectIds || selectedProjects.some((project) => !index.projectIds!.includes(project)))) {
    throw new RecallCommandError("CACHE_SCOPE_STALE", "Published Learnings cache does not include the active Logical Project scope. Run teamai sync to refresh the cache.");
  }
  const learningMetadata = index.files.filter((file) => file.logicalProject === "shared" || (scope.kind === "workspace" && allowedProjects.has(file.logicalProject)));

  const pendingHeaders = options.includePending
    ? (await listLearningOperationHeaders(context.homeDir)).filter((operation) =>
      operation.status !== "complete"
      && operation.sourceHash === sourceHash
      && (operation.logicalProject === "shared" || (scope.kind === "workspace" && allowedProjects.has(operation.logicalProject)))
      && (scope.kind === "user" || operation.originWorkspaceKey === scope.originWorkspaceKey))
    : [];

  const learningBytes = sumBytes(learningMetadata.map((file) => file.byteLength));
  const pendingBytes = pendingHeaders.reduce((total, operation) => {
    if (operation.payloadByteLength === undefined) throw new RecallCommandError("PENDING_CORRUPT", `Pending Learning '${operation.id}' has invalid payload metadata.`);
    if (operation.payloadByteLength > MAX_RECALL_FILE_BYTES) throw new RecallCommandError("PENDING_TOO_LARGE", `Pending Learning '${operation.id}' exceeds the 1 MiB file limit.`);
    return total + operation.payloadByteLength;
  }, 0);
  const knownFiles = learningMetadata.length + pendingHeaders.length;
  const knownBytes = learningBytes + pendingBytes;
  if (knownFiles > MAX_RECALL_FILES) throw new RecallCommandError("CORPUS_TOO_LARGE", "Recall corpus exceeds the 5000-file limit.");
  if (knownBytes > MAX_RECALL_BYTES) throw new RecallCommandError("CORPUS_TOO_LARGE", "Recall corpus exceeds the 64 MiB limit.");

  let docs: Array<{ relativePath: string; file: string; content: Buffer }> = [];
  if (scope.kind === "workspace") {
    docs = await readVerifiedProjectDocs({
      root: marketplaceRoot!,
      revision: resourceRevision!,
      projectIds: selectedProjects,
      maxFiles: MAX_RECALL_FILES - knownFiles,
      maxBytes: MAX_RECALL_BYTES - knownBytes,
    });
  }

  let publishedFiles;
  try {
    publishedFiles = await readPublishedLearningFiles(index, learningMetadata.map((file) => file.relativePath));
  } catch (error) {
    throw new RecallCommandError("CACHE_UNAVAILABLE", `A permitted published Learning could not be verified (${safeMessage(error)}). Run teamai sync to refresh the cache.`);
  }

  let pendingReadBudget = MAX_RECALL_BYTES
    - sumBytes(publishedFiles.map((file) => file.content.byteLength))
    - sumBytes(docs.map((doc) => doc.content.byteLength));
  const candidates: RecallCandidate[] = [];
  for (const file of publishedFiles) {
    const parsed = parseRecallMarkdown(file.content, fallbackTitle(file.relativePath));
    candidates.push({
      id: `learning:${file.logicalProject}:${parsed.id}`,
      type: "learning",
      publication: "published",
      logicalProject: file.logicalProject,
      title: parsed.title,
      tags: parsed.tags,
      body: parsed.body,
      rawContent: parsed.text,
      source: {
        sourceHash: index.sourceHash,
        revision: index.revision,
        relativePath: file.relativePath,
        contentHash: file.contentHash,
      },
      file: path.resolve(index.root, ...file.relativePath.split("/")),
    });
  }

  const docsSourceHash = resourceSourceHash(config.marketplace.source);
  for (const doc of docs) {
    const parsed = parseRecallMarkdown(doc.content, fallbackTitle(doc.relativePath));
    const projectId = doc.relativePath.split("/")[1]!;
    candidates.push({
      id: `doc:${projectId}:${doc.relativePath}`,
      type: "doc",
      publication: "published",
      logicalProject: projectId,
      title: parsed.title,
      tags: parsed.tags,
      body: parsed.body,
      rawContent: parsed.text,
      source: {
        sourceHash: docsSourceHash,
        revision: resourceRevision,
        relativePath: doc.relativePath,
        contentHash: sha256(doc.content),
      },
      file: path.resolve(doc.file),
    });
  }

  for (const header of pendingHeaders) {
    const expectedPayloadByteLength = header.payloadByteLength;
    if (expectedPayloadByteLength === undefined) {
      throw new RecallCommandError("PENDING_CORRUPT", `Pending Learning '${header.id}' has invalid payload metadata.`);
    }
    const payloadReadBudget = Math.min(MAX_RECALL_FILE_BYTES, pendingReadBudget);
    let operation;
    try {
      operation = await readLearningOperation(context.homeDir, header.id);
    } catch (error) {
      throw new RecallCommandError("PENDING_CORRUPT", `Pending Learning '${header.id}' could not be verified (${safeMessage(error)}).`);
    }
    let payload: Buffer;
    let payloadFile: string;
    try {
      const savedPayload = await readLearningPayload(
        context.homeDir,
        operation.id,
        operation.contentHash,
        expectedPayloadByteLength,
        payloadReadBudget,
      );
      payload = savedPayload.content;
      payloadFile = savedPayload.file;
    } catch (error) {
      throw new RecallCommandError("PENDING_CORRUPT", `Pending Learning '${header.id}' payload could not be verified (${safeMessage(error)}).`);
    }
    pendingReadBudget -= expectedPayloadByteLength;
    let parsed;
    try {
      parsed = parseRecallMarkdown(payload, header.metadata.title);
    } catch (error) {
      throw new RecallCommandError("PENDING_CORRUPT", `Pending Learning '${header.id}' payload is not readable Markdown (${safeMessage(error)}).`);
    }
    if (parsed.id !== operation.id || parsed.title !== header.metadata.title || !sameStrings(parsed.tags, header.metadata.tags)) {
      throw new RecallCommandError("PENDING_CORRUPT", `Pending Learning '${header.id}' metadata does not match its saved payload.`);
    }
    candidates.push({
      id: `learning:${operation.logicalProject}:${parsed.id}`,
      type: "learning",
      publication: "pending",
      logicalProject: operation.logicalProject,
      title: header.metadata.title,
      tags: header.metadata.tags,
      body: parsed.body,
      rawContent: parsed.text,
      source: {
        sourceHash: operation.sourceHash,
        relativePath: operation.destination,
        contentHash: sha256(payload),
      },
      file: path.resolve(payloadFile),
    });
  }

  if (candidates.length > MAX_RECALL_FILES || sumBytes(candidates.map((candidate) => Buffer.byteLength(candidate.rawContent, "utf8"))) > MAX_RECALL_BYTES) {
    throw new RecallCommandError("CORPUS_TOO_LARGE", "Recall corpus exceeds its 5000-file or 64 MiB limit.");
  }
  const hits = rankRecallCandidates(candidates, terms, limit, requiredLiterals);
  if (options.json) {
    context.out(JSON.stringify({
      schemaVersion: 1,
      query,
      ...(requiredLiterals.length > 0 ? { requiredLiterals } : {}),
      scope: scope.kind,
      ...(scope.kind === "workspace" && options.project ? { project: options.project } : {}),
      sourceHash,
      ...(resourceRevision ? { resourceRevision } : {}),
      learningsRevision: index.revision,
      limit,
      hits,
    }));
    return;
  }
  context.out(renderRecallText(query, scope.kind, hits, requiredLiterals));
}

async function resolveScope(
  context: CommandContext,
  requested: "auto" | "user" | "workspace",
  projectRequested: boolean,
): Promise<{ kind: "user" } | { kind: "workspace"; activeProjects: string[]; originWorkspaceKey: string }> {
  if (requested === "user") return { kind: "user" };
  const identity = await detectProjectIdentity(context.cwd);
  if (!identity) {
    if (requested === "workspace" || projectRequested) {
      throw new RecallCommandError("UNBOUND_WORKSPACE", "Workspace Recall requires a Git Workspace with an active Logical Project binding.");
    }
    return { kind: "user" };
  }
  const state = await readProjectState(identity.projectAnchor, context.homeDir);
  const projection = projectionFor(state, identity.workspaceRoot);
  const activeProjects = projection?.logicalProjects ?? [];
  if (activeProjects.length === 0) {
    if (requested === "workspace" || projectRequested) {
      throw new RecallCommandError("UNBOUND_WORKSPACE", "Workspace Recall requires an active Logical Project binding. Run `teamai projects set <id>` first.");
    }
    return { kind: "user" };
  }
  return {
    kind: "workspace",
    activeProjects: [...new Set(activeProjects)],
    originWorkspaceKey: workspaceKey(identity.workspaceRoot),
  };
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 5;
  if (!/^[0-9]+$/.test(value)) throw new RecallInputError("--limit must be an integer from 1 to 20.");
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new RecallInputError("--limit must be an integer from 1 to 20.");
  return limit;
}

function workspaceKey(workspaceRoot: string): string {
  const normalized = path.resolve(workspaceRoot).replaceAll("\\", "/");
  return publishedLearningSourceHash(process.platform === "win32" ? normalized.toLowerCase() : normalized);
}

function fallbackTitle(relativePath: string): string {
  return path.posix.basename(relativePath).replace(/\.md$/i, "").replace(/[-_]+/g, " ");
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sumBytes(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function safeMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replaceAll(/[\r\n]/g, " ").slice(0, 240);
  return "verification failed";
}

function renderRecallText(query: string, scope: "user" | "workspace", hits: ReturnType<typeof rankRecallCandidates>, requiredLiterals: string[]): string {
  const required = requiredLiterals.length > 0 ? `\nRequired literals (all): ${JSON.stringify(requiredLiterals)}` : "";
  if (hits.length === 0) return `No Recall matches for ${JSON.stringify(query)} in ${scope} scope.${required}`;
  const lines = [`Recall found ${hits.length} result(s) in ${scope} scope for ${JSON.stringify(query)}.${required}`];
  hits.forEach((hit, index) => {
    lines.push(
      "",
      `[${index + 1}] ${hit.type} · ${hit.publication} · ${hit.logicalProject} · ${oneLine(hit.title)}`,
      `Source: ${hit.source.relativePath}${hit.source.revision ? ` @ ${hit.source.revision}` : ""}`,
      `File: ${oneLine(hit.file)}`,
      `SHA-256: ${hit.source.contentHash}`,
      `Lines: ${hit.lineStart}-${hit.lineEnd}`,
      `Matched terms: ${hit.matchedTerms.join(", ")}`,
      "⟦evidence⟧",
      safeEvidence(hit.snippet),
      "⟦/evidence⟧",
    );
  });
  return lines.join("\n");
}

function oneLine(value: string): string {
  return value.replace(/[\r\n\t]/g, " ").replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "?");
}

function safeEvidence(value: string): string {
  return value
    .replaceAll("⟦", "\\u27e6")
    .replaceAll("⟧", "\\u27e7")
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
