import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { teamAiHome } from "../config/global.js";
import { atomicCreateFile, atomicWriteJson } from "../utils/fs.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_PROJECT = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export type LearningPhase = "queued" | "branch-pushed" | "pr-open" | "published" | "closed-without-merge";
export type LearningStatus = "ready" | "retryable-error" | "blocked" | "complete";

export interface LearningMetadata {
  id: string;
  title: string;
  owner: string;
  logicalProject: string;
  sourceRepo: string;
  createdAt: string;
  tags: string[];
}

export interface LearningOperation {
  schemaVersion: 1;
  id: string;
  sourceHash: string;
  remoteIdentity: string;
  sourceRemote?: string;
  commitIdentity?: { name: string; email: string };
  resourceRevision?: string;
  metadata: LearningMetadata;
  fileName: string;
  logicalProject: string;
  originWorkspaceKey: string;
  contentHash: string;
  bodyBase64: string;
  payloadBase64: string;
  destination: string;
  branch: string;
  baseBranch: "teamai-learnings";
  baseCommit?: string;
  pullRequestTitle: string;
  pullRequestBody: string;
  phase: LearningPhase;
  status: LearningStatus;
  pullRequest?: { number: number; url: string };
  lastError?: { code: string; message: string };
}

export interface LearningOperationHeader {
  id: string;
  sourceHash: string;
  resourceRevision?: string;
  metadata: Pick<LearningMetadata, "title" | "tags">;
  fileName: string;
  logicalProject: string;
  originWorkspaceKey: string;
  contentHash: string;
  destination: string;
  phase: LearningPhase;
  status: LearningStatus;
  payloadByteLength?: number;
}

export function learningHash(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isFrozenLearningPullRequestBody(body: string, id: string, contentHash: string): boolean {
  return hasExactMarker(body, "Operation ID", id) && hasExactMarker(body, "Payload SHA-256", contentHash);
}

export function learningOutboxDirectory(homeDir: string): string {
  return path.join(teamAiHome(homeDir), "outbox", "learnings");
}

export async function createLearningOperation(homeDir: string, operation: LearningOperation): Promise<void> {
  const directory = (await safeOutboxDirectory(homeDir, true))!;
  validateOperation(operation, `${operation.id}.json`);
  const target = path.join(directory, `${operation.id}.json`);
  try {
    await lstat(target);
    throw new Error(`Learning outbox ID already exists: ${operation.id}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const payloadDirectory = (await safeLearningPayloadDirectory(homeDir, true))!;
  const payloadPath = path.join(payloadDirectory, `${operation.id}.md`);
  const payload = Buffer.from(operation.payloadBase64, "base64");
  try {
    await atomicCreateFile(payloadPath, payload);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Learning payload already exists: ${operation.id}`);
    }
    throw error;
  }
  await atomicWriteJson(target, operation);
}

export async function updateLearningOperation(homeDir: string, operation: LearningOperation): Promise<void> {
  const directory = await safeOutboxDirectory(homeDir, false);
  if (!directory) throw new Error("Learning outbox record is missing.");
  const target = path.join(directory, `${operation.id}.json`);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Learning outbox record is unsafe.");
  await atomicWriteJson(target, operation);
}

export async function listLearningOperations(homeDir: string): Promise<LearningOperation[]> {
  const directory = await safeOutboxDirectory(homeDir, false);
  if (!directory) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const operations: LearningOperation[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Learning outbox contains an unsafe record.");
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    operations.push(validateOperation(value, entry.name));
  }
  return operations.sort((left, right) => left.id.localeCompare(right.id));
}

export async function listLearningOperationHeaders(homeDir: string): Promise<LearningOperationHeader[]> {
  const directory = await safeOutboxDirectory(homeDir, false);
  if (!directory) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const headers: LearningOperationHeader[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    const target = path.join(directory, entry.name);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Learning outbox contains an unsafe record.");
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    headers.push(validateOperationHeader(value, entry.name));
  }
  return headers.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

export async function readLearningOperation(homeDir: string, id: string): Promise<LearningOperation> {
  if (!UUID.test(id)) throw new Error("Learning operation ID must be a UUID.");
  const directory = await safeOutboxDirectory(homeDir, false);
  if (!directory) throw new Error(`No saved learning operation '${id}' exists.`);
  const target = path.join(directory, `${id}.json`);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Learning outbox record is unsafe.");
  return validateOperation(JSON.parse(await readFile(target, "utf8")) as unknown, `${id}.json`);
}

export async function readLearningPayload(
  homeDir: string,
  id: string,
  expectedHash: string,
  expectedByteLength: number,
  maxBytes: number,
): Promise<{ file: string; content: Buffer }> {
  if (!UUID.test(id)) throw new Error("Learning operation ID must be a UUID.");
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("Learning payload hash is invalid.");
  if (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new Error("Learning payload byte limits are invalid.");
  }
  const directory = await safeLearningPayloadDirectory(homeDir, false);
  if (!directory) throw new Error(`Learning payload '${id}' is missing.`);
  const file = path.join(directory, `${id}.md`);
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1) throw new Error("Learning payload file is unsafe.");
  if (info.size !== expectedByteLength) throw new Error("Learning payload size does not match its frozen byte length.");
  if (info.size > maxBytes) throw new Error("Learning payload exceeds its Recall byte budget.");
  const content = await readFile(file);
  if (content.byteLength !== expectedByteLength || content.byteLength > maxBytes || learningHash(content) !== expectedHash) {
    throw new Error("Learning payload does not match its frozen content hash.");
  }
  return { file, content };
}

async function safeOutboxDirectory(homeDir: string, create: boolean): Promise<string | undefined> {
  const base = teamAiHome(homeDir);
  const directories = [base, path.join(base, "outbox"), path.join(base, "outbox", "learnings")];
  for (const directory of directories) {
    if (create) await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return undefined;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Learning outbox path is unsafe.");
  }
  return directories[2];
}

async function safeLearningPayloadDirectory(homeDir: string, create: boolean): Promise<string | undefined> {
  const base = teamAiHome(homeDir);
  const outbox = path.join(base, "outbox");
  const payloads = path.join(outbox, "learning-payloads");
  for (const directory of [base, outbox, payloads]) {
    if (create) await mkdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
    let info;
    try {
      info = await lstat(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && !create) return undefined;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Learning payload path is unsafe.");
  }
  return payloads;
}

function validateOperation(value: unknown, filename: string): LearningOperation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Learning outbox record is invalid.");
  const operation = value as LearningOperation;
  if (operation.schemaVersion !== 1 || !UUID.test(operation.id) || filename !== `${operation.id}.json`) {
    throw new Error("Learning outbox record is invalid.");
  }
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(operation.remoteIdentity) || !/^[a-f0-9]{64}$/.test(operation.sourceHash)) {
    throw new Error("Learning outbox source identity is invalid.");
  }
  const expectedRemotes = [
    `https://github.com/${operation.remoteIdentity}.git`,
    `git@github.com:${operation.remoteIdentity}.git`,
    `ssh://git@github.com/${operation.remoteIdentity}.git`,
  ];
  if ((operation.sourceRemote === undefined) !== (operation.commitIdentity === undefined) ||
      operation.sourceRemote !== undefined && !expectedRemotes.includes(operation.sourceRemote) ||
      operation.commitIdentity !== undefined && (!operation.commitIdentity ||
        typeof operation.commitIdentity.name !== "string" || !operation.commitIdentity.name.trim() || /[\r\n\0]/.test(operation.commitIdentity.name) ||
        typeof operation.commitIdentity.email !== "string" || !operation.commitIdentity.email.trim() || /[\r\n\0]/.test(operation.commitIdentity.email))) {
    throw new Error("Learning outbox frozen retry metadata is invalid.");
  }
  const project = operation.logicalProject;
  const fileName = operation.fileName;
  if (!project || project === "." || project === ".." || /[\\/\0]/.test(project) ||
      typeof fileName !== "string" || !/^[a-z0-9][a-z0-9._-]*\.md$/i.test(fileName) ||
      operation.destination !== path.posix.join("learnings", project, fileName) ||
      !/^[a-f0-9]{64}$/.test(operation.originWorkspaceKey) ||
      operation.baseCommit !== undefined && !/^[a-f0-9]{40,64}$/i.test(operation.baseCommit) ||
      !operation.metadata || operation.metadata.id !== operation.id || operation.metadata.logicalProject !== project ||
      typeof operation.metadata.title !== "string" || typeof operation.metadata.owner !== "string" ||
      typeof operation.metadata.sourceRepo !== "string" || typeof operation.metadata.createdAt !== "string" ||
      !Array.isArray(operation.metadata.tags) || operation.metadata.tags.some((tag) => typeof tag !== "string")) {
    throw new Error("Learning outbox target or metadata is invalid.");
  }
  if (operation.branch !== `teamai/learning-${operation.id}` || operation.baseBranch !== "teamai-learnings" ||
      !["queued", "branch-pushed", "pr-open", "published", "closed-without-merge"].includes(operation.phase) ||
      !["ready", "retryable-error", "blocked", "complete"].includes(operation.status)) {
    throw new Error("Learning outbox state is invalid.");
  }
  if ((operation.phase === "published" || operation.phase === "closed-without-merge") !== (operation.status === "complete")) {
    throw new Error("Learning outbox terminal state is invalid.");
  }
  if (!/^[a-f0-9]{64}$/.test(operation.contentHash) ||
      typeof operation.bodyBase64 !== "string" || typeof operation.payloadBase64 !== "string" ||
      typeof operation.pullRequestTitle !== "string" || typeof operation.pullRequestBody !== "string") {
    throw new Error("Learning outbox payload is invalid.");
  }
  const body = Buffer.from(operation.bodyBase64, "base64");
  const payload = Buffer.from(operation.payloadBase64, "base64");
  if (body.toString("base64") !== operation.bodyBase64 || payload.toString("base64") !== operation.payloadBase64 ||
      learningHash(payload) !== operation.contentHash || payload.length < body.length ||
      !payload.subarray(payload.length - body.length).equals(body)) {
    throw new Error("Learning outbox payload hash does not match.");
  }
  if (operation.sourceRemote && !isFrozenLearningPullRequestBody(operation.pullRequestBody, operation.id, operation.contentHash)) {
    throw new Error("Learning outbox pull request identity is invalid.");
  }
  return operation;
}

function validateOperationHeader(value: unknown, filename: string): LearningOperationHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Learning outbox record is invalid.");
  const operation = value as Partial<LearningOperation>;
  const metadata = operation.metadata as Partial<LearningMetadata> | undefined;
  const project = operation.logicalProject;
  const fileName = operation.fileName;
  if (operation.schemaVersion !== 1 || typeof operation.id !== "string" || !UUID.test(operation.id) || filename !== `${operation.id}.json`) {
    throw new Error("Learning outbox record is invalid.");
  }
  if (typeof operation.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(operation.sourceHash) ||
      typeof operation.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(operation.contentHash)) {
    throw new Error("Learning outbox source identity is invalid.");
  }
  if (typeof project !== "string" || !SAFE_PROJECT.test(project) ||
      typeof fileName !== "string" || !/^[a-z0-9][a-z0-9._-]*\.md$/i.test(fileName) ||
      operation.destination !== path.posix.join("learnings", project, fileName) ||
      typeof operation.originWorkspaceKey !== "string" || !/^[a-f0-9]{64}$/.test(operation.originWorkspaceKey) ||
      !metadata || metadata.id !== operation.id || metadata.logicalProject !== project ||
      typeof metadata.title !== "string" || !metadata.title || !Array.isArray(metadata.tags) || metadata.tags.some((tag) => typeof tag !== "string")) {
    throw new Error("Learning outbox target or metadata is invalid.");
  }
  if (!(["queued", "branch-pushed", "pr-open", "published", "closed-without-merge"] as unknown[]).includes(operation.phase) ||
      !(["ready", "retryable-error", "blocked", "complete"] as unknown[]).includes(operation.status) ||
      ((operation.phase === "published" || operation.phase === "closed-without-merge") !== (operation.status === "complete"))) {
    throw new Error("Learning outbox state is invalid.");
  }
  if (operation.resourceRevision !== undefined && (typeof operation.resourceRevision !== "string" || !/^[a-f0-9]{40,64}$/i.test(operation.resourceRevision))) {
    throw new Error("Learning outbox resource revision is invalid.");
  }
  const payload = operation.payloadBase64;
  const payloadPadding = typeof payload === "string" ? payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0 : 0;
  // Header selection needs a byte estimate without scanning or validating excluded bodies.
  // A selected operation is fully base64-validated by validateOperation after scope filtering.
  const payloadByteLength = typeof payload === "string" && payload.length % 4 === 0
    ? payload.length / 4 * 3 - payloadPadding
    : undefined;
  return {
    id: operation.id,
    sourceHash: operation.sourceHash,
    ...(operation.resourceRevision ? { resourceRevision: operation.resourceRevision } : {}),
    metadata: { title: metadata.title, tags: metadata.tags },
    fileName,
    logicalProject: project,
    originWorkspaceKey: operation.originWorkspaceKey,
    contentHash: operation.contentHash,
    destination: operation.destination,
    phase: operation.phase as LearningPhase,
    status: operation.status as LearningStatus,
    ...(payloadByteLength === undefined ? {} : { payloadByteLength }),
  };
}

function hasExactMarker(body: string, label: string, value: string): boolean {
  const marker = `${label}: ${value}`;
  const matchingLines = body.split(/\r?\n/).filter((line) => line.startsWith(`${label}:`));
  return matchingLines.length === 1 && matchingLines[0] === marker;
}
