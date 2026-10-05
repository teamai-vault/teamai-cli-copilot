import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { runProcess } from "../utils/process.js";

const MAX_QUERY_CODEPOINTS = 1024;
const MAX_QUERY_TERMS = 32;
const SHA = /^[a-f0-9]{40,64}$/i;
export const MAX_RECALL_FILES = 5000;
export const MAX_RECALL_BYTES = 64 * 1024 * 1024;
export const MAX_RECALL_FILE_BYTES = 1024 * 1024;

export interface RecallTerm {
  display: string;
  normalized: string;
}

export interface RecallCandidate {
  id: string;
  type: "doc" | "learning";
  publication: "published" | "pending";
  logicalProject: string;
  title: string;
  tags: string[];
  body: string;
  rawContent: string;
  source: {
    sourceHash: string;
    revision?: string;
    relativePath: string;
    contentHash: string;
  };
  file: string;
}

export interface RecallHit extends Omit<RecallCandidate, "tags" | "body" | "rawContent"> {
  matchedTerms: string[];
  lineStart: number;
  lineEnd: number;
  snippet: string;
}

export class RecallInputError extends Error {}

export function parseRecallQuery(query: string, requiredLiterals: string[] = []): RecallTerm[] {
  if (requiredLiterals.some((literal) => !literal.trim())) throw new RecallInputError("--require must contain a non-whitespace literal.");
  const codePoints = [...query].length + requiredLiterals.reduce((total, literal) => total + [...literal].length, 0);
  if (codePoints > MAX_QUERY_CODEPOINTS) throw new RecallInputError(requiredLiterals.length > 0
    ? "Recall query and required literals must total at most 1024 Unicode code points."
    : "Recall query must be at most 1024 Unicode code points.");
  const rawTerms = query.normalize("NFC").trim().split(/\s+/u).filter(Boolean);
  if (rawTerms.length === 0) throw new RecallInputError("Recall query must contain at least one non-whitespace term.");
  if (rawTerms.length + requiredLiterals.length > MAX_QUERY_TERMS) throw new RecallInputError(requiredLiterals.length > 0
    ? "Recall query terms and required literals must total at most 32 items."
    : "Recall query must contain at most 32 terms.");
  const terms: RecallTerm[] = [];
  const seen = new Set<string>();
  for (const raw of rawTerms) {
    const display = raw.normalize("NFC");
    const normalized = normalizeSearchText(display);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push({ display, normalized });
  }
  return terms;
}

export function parseRecallMarkdown(content: Buffer, fallbackTitle: string): {
  text: string;
  id?: string;
  title: string;
  tags: string[];
  body: string;
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error("Recall source contains non-UTF-8 content.");
  }
  if (content.includes(0)) throw new Error("Recall source contains binary NUL data.");
  const lines = text.split(/\r\n|\n|\r/);
  let body = text;
  let title: string | undefined;
  let id: string | undefined;
  let tags: string[] = [];
  if (lines[0]?.trim() === "---") {
    const closing = lines.findIndex((line, index) => index > 0 && (line.trim() === "---" || line.trim() === "..."));
    if (closing < 0) throw new Error("Recall Markdown frontmatter is not terminated.");
    const document = parseDocument(lines.slice(1, closing).join("\n"));
    if (document.errors.length > 0) throw new Error("Recall Markdown frontmatter is invalid YAML.");
    const metadata = document.toJS() as unknown;
    if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
      const record = metadata as { id?: unknown; title?: unknown; tags?: unknown };
      if (typeof record.id === "string") id = record.id;
      if (typeof record.title === "string" && record.title.trim()) title = record.title;
      if (typeof record.tags === "string") tags = record.tags.split(",").map((tag) => tag.trim()).filter(Boolean);
      else if (Array.isArray(record.tags)) tags = record.tags.filter((tag): tag is string => typeof tag === "string");
    }
    body = lines.slice(closing + 1).join("\n");
  }
  if (!title) title = lines.find((line) => /^#\s+\S/.test(line))?.replace(/^#\s+/, "").trim();
  return { text, ...(id === undefined ? {} : { id }), title: title || fallbackTitle, tags, body };
}

export function rankRecallCandidates(candidates: RecallCandidate[], terms: RecallTerm[], limit: number, requiredLiterals: string[] = []): RecallHit[] {
  const required = requiredLiterals.map(normalizeSearchText);
  const ranked: Array<{ candidate: RecallCandidate; matchedTerms: RecallTerm[]; score: number }> = [];
  for (const candidate of candidates) {
    const title = normalizeSearchText(candidate.title);
    const tags = normalizeSearchText(candidate.tags.join(" "));
    const body = normalizeSearchText(candidate.body);
    if (required.length > 0) {
      const individualTags = candidate.tags.map(normalizeSearchText);
      if (!required.every((literal) => title.includes(literal) || individualTags.some((tag) => tag.includes(literal)) || body.includes(literal))) continue;
    }
    const matchedTerms = terms.filter((term) => title.includes(term.normalized) || tags.includes(term.normalized) || body.includes(term.normalized));
    if (matchedTerms.length === 0) continue;
    const score = matchedTerms.reduce((total, term) => total
      + (title.includes(term.normalized) ? 3 : 0)
      + (tags.includes(term.normalized) ? 2 : 0)
      + (body.includes(term.normalized) ? 1 : 0), 0);
    ranked.push({ candidate, matchedTerms, score });
  }
  return ranked
    .sort((left, right) => right.matchedTerms.length - left.matchedTerms.length || right.score - left.score || compare(left.candidate.id, right.candidate.id))
    .slice(0, limit)
    .map(({ candidate, matchedTerms }) => {
      const evidence = evidenceFor(candidate.rawContent, matchedTerms);
      const { tags: _tags, body: _body, rawContent: _rawContent, ...hit } = candidate;
      return { ...hit, matchedTerms: matchedTerms.map((term) => term.display), ...evidence };
    });
}

export async function readVerifiedProjectDocs(options: {
  root: string;
  revision: string;
  projectIds: string[];
  maxFiles: number;
  maxBytes: number;
}): Promise<Array<{ relativePath: string; file: string; content: Buffer }>> {
  if (!SHA.test(options.revision)) throw new Error("The configured Marketplace resource revision is invalid.");
  const rootInfo = await lstat(options.root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("The configured Marketplace source is not a safe local directory.");
  const head = await git(options.root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (head !== options.revision) throw new Error("The local Marketplace source does not match its configured resource revision. Run `teamai sync` to refresh it.");

  const docs: Array<{ relativePath: string; file: string; content: Buffer }> = [];
  const selectedFiles: Array<{ projectId: string; relativePath: string; file: string; objectId: string; byteLength: number }> = [];
  let totalBytes = 0;
  for (const projectId of [...new Set(options.projectIds)].sort(compare)) {
    const relativeRoot = `contexts/${projectId}/docs`;
    await assertSafeDocsPath(options.root, relativeRoot, "directory");
    const expected = await expectedMarkdownFiles(options.root, options.revision, relativeRoot);
    const actual = await actualMarkdownFiles(options.root, relativeRoot);
    if (expected.size !== actual.size || [...expected.keys()].some((relativePath) => !actual.has(relativePath))) {
      throw new Error(`Project docs for '${projectId}' do not match the configured Marketplace resource revision. Run teamai sync to refresh it.`);
    }
    if (selectedFiles.length + expected.size > options.maxFiles) throw new Error(`Recall corpus exceeds the ${MAX_RECALL_FILES}-file limit.`);
    for (const [relativePath, entry] of [...expected].sort(([left], [right]) => compare(left, right))) {
      await assertSafeDocsPath(options.root, relativePath, "file");
      const file = path.join(options.root, ...relativePath.split("/"));
      const info = await lstat(file);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error(`Marketplace Project docs contain an unsafe file: '${relativePath}'.`);
      if (info.size > MAX_RECALL_FILE_BYTES) throw new Error(`Recall source exceeds 1 MiB: '${relativePath}'.`);
      totalBytes += info.size;
      if (totalBytes > options.maxBytes) throw new Error("Recall corpus exceeds the 64 MiB limit.");
      selectedFiles.push({ projectId, relativePath, file, objectId: entry.objectId, byteLength: info.size });
    }
  }
  for (const entry of selectedFiles) {
    const { projectId, relativePath, file } = entry;
    const content = await readFile(file);
    if (content.byteLength !== entry.byteLength) throw new Error(`Marketplace Project docs changed while being read: '${relativePath}'.`);
    if (!matchesGitBlob(content, entry.objectId)) {
      throw new Error(`Project docs for '${projectId}' changed after resource revision ${options.revision}. Run teamai sync to refresh it.`);
    }
    docs.push({ relativePath, file, content });
  }
  return docs;
}

function matchesGitBlob(content: Buffer, expectedObjectId: string): boolean {
  if (gitBlobObjectId(content, expectedObjectId.length) === expectedObjectId) return true;
  if (!content.includes(13)) return false;
  // Accept only Git's built-in CRLF-to-LF normalization; hashes reported to Recall remain over raw file bytes.
  const normalized = Buffer.allocUnsafe(content.length);
  let outputLength = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === 13 && content[index + 1] === 10) continue;
    normalized[outputLength] = content[index]!;
    outputLength += 1;
  }
  return gitBlobObjectId(normalized.subarray(0, outputLength), expectedObjectId.length) === expectedObjectId;
}

function gitBlobObjectId(content: Buffer, objectIdLength: number): string {
  const algorithm = objectIdLength === 64 ? "sha256" : "sha1";
  return createHash(algorithm).update(`blob ${content.length}\0`).update(content).digest("hex");
}

export function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

function evidenceFor(rawContent: string, matchedTerms: RecallTerm[]): { lineStart: number; lineEnd: number; snippet: string } {
  const lines = rawContent.split(/\r\n|\n|\r/);
  const matchingLine = lines.findIndex((line) => {
    const normalized = normalizeSearchText(line);
    return matchedTerms.some((term) => normalized.includes(term.normalized));
  });
  const focus = matchingLine >= 0 ? matchingLine : 0;
  let first = Math.max(0, focus - 1);
  let last = Math.min(lines.length - 1, focus + 1);
  let snippet = lines.slice(first, last + 1).join("\n");
  while ([...snippet].length > 1200 && (first < focus || last > focus)) {
    if (last > focus) last -= 1;
    else first += 1;
    snippet = lines.slice(first, last + 1).join("\n");
  }
  if ([...snippet].length > 1200) {
    const line = lines[focus] ?? "";
    const codepoints = [...line];
    const normalized = normalizeSearchText(line);
    const term = matchedTerms.find((candidate) => normalized.includes(candidate.normalized));
    const matchStart = term ? normalized.indexOf(term.normalized) : 0;
    const termPosition = rawCodePointOffset(line, normalized, matchStart);
    const start = Math.max(0, Math.min(codepoints.length - 1200, termPosition - 600));
    snippet = codepoints.slice(start, start + 1200).join("");
    first = focus;
    last = focus;
  }
  return { lineStart: first + 1, lineEnd: last + 1, snippet };
}

function rawCodePointOffset(rawLine: string, normalizedLine: string, normalizedUtf16Offset: number): number {
  const normalizedCodePointOffset = [...normalizedLine.slice(0, normalizedUtf16Offset)].length;
  if (normalizedCodePointOffset === 0) return 0;
  let rawOffset = 0;
  let normalizedOffset = 0;
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  for (const segment of segmenter.segment(rawLine)) {
    const segmentLength = [...normalizeSearchText(segment.segment)].length;
    if (normalizedOffset + segmentLength > normalizedCodePointOffset) return rawOffset;
    normalizedOffset += segmentLength;
    rawOffset += [...segment.segment].length;
  }
  return rawOffset;
}

async function expectedMarkdownFiles(root: string, revision: string, relativeRoot: string): Promise<Map<string, { objectId: string; byteLength: number }>> {
  const output = await git(root, ["ls-tree", "-r", "-l", "-z", "--full-tree", revision, "--", relativeRoot]);
  const files = new Map<string, { objectId: string; byteLength: number }>();
  for (const entry of output.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0) throw new Error("Marketplace Project docs tree contains a malformed Git entry.");
    const [mode, type, objectId, rawSize] = entry.slice(0, tab).trim().split(/\s+/);
    const relativePath = entry.slice(tab + 1);
    if (!relativePath.startsWith(`${relativeRoot}/`) || relativePath.includes("\\") || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("Marketplace Project docs tree contains an unsafe Git path.");
    }
    if (!relativePath.toLowerCase().endsWith(".md")) continue;
    const byteLength = Number(rawSize);
    if ((mode !== "100644" && mode !== "100755") || type !== "blob" || !objectId || !SHA.test(objectId) || !Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > MAX_RECALL_FILE_BYTES) {
      throw new Error(`Marketplace Project docs contain an unsupported file type at '${relativePath}'.`);
    }
    files.set(relativePath, { objectId, byteLength });
  }
  return files;
}

async function actualMarkdownFiles(root: string, relativeRoot: string): Promise<Set<string>> {
  const targetRoot = path.join(root, ...relativeRoot.split("/"));
  const files = new Set<string>();
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`Marketplace Project docs contain an unsafe link: '${path.relative(root, target)}'.`);
      if (info.isDirectory()) await walk(target);
      else if (info.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        if (info.nlink > 1) throw new Error(`Marketplace Project docs contain an unsafe hard link: '${path.relative(root, target)}'.`);
        files.add(path.relative(root, target).split(path.sep).join("/"));
      } else if (!info.isFile()) {
        throw new Error(`Marketplace Project docs contain an unsupported filesystem entry: '${path.relative(root, target)}'.`);
      }
    }
  }
  let info;
  try {
    info = await lstat(targetRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Marketplace Project docs path is unsafe: '${relativeRoot}'.`);
  await walk(targetRoot);
  return files;
}

async function assertSafeDocsPath(root: string, relativePath: string, finalType: "directory" | "file"): Promise<void> {
  const segments = relativePath.split("/");
  if (relativePath.startsWith("/") || relativePath.includes("\\") || segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Marketplace Project docs path is unsafe.");
  }
  let current = path.resolve(root);
  let info = await lstat(current);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("The configured Marketplace source is not a safe local directory.");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]!;
    current = path.join(current, segment);
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Marketplace Project docs contain an unsafe link: '${segments.slice(0, index + 1).join("/")}'.`);
    }
    const last = index === segments.length - 1;
    if (last) {
      if (finalType === "directory" && !info.isDirectory() || finalType === "file" && !info.isFile()) {
        throw new Error(`Marketplace Project docs path is unsafe: '${relativePath}'.`);
      }
      if (finalType === "file" && info.nlink > 1) {
        throw new Error(`Marketplace Project docs contain an unsafe hard link: '${relativePath}'.`);
      }
    } else if (!info.isDirectory()) {
      throw new Error(`Marketplace Project docs path is unsafe: '${segments.slice(0, index + 1).join("/")}'.`);
    }
  }
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd: root });
  if (result.exitCode !== 0) throw new Error(`Git could not verify the local Marketplace docs (exit code ${result.exitCode}).`);
  return result.stdout.trim();
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
