import { createHash } from "node:crypto";
import { lstat, readFile, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { teamAiHome } from "../config/global.js";
import { atomicCreateFile, atomicWriteFile, atomicWriteJson, pathsEqual, withFileLock } from "../utils/fs.js";
import { VERSION } from "../version.js";
import { ensureSafeTargetChain } from "./user-instructions.js";
import { copilotHome } from "./user-state.js";

const AGENT = "teamai-recall";
const OWNER = "teamai-cli";
interface AgentReceipt {
  schemaVersion: 1;
  managedBy: typeof OWNER;
  agent: typeof AGENT;
  copilotRoot: string;
  target: string;
  version: string;
  contentHash: string;
  [key: string]: unknown;
}
interface AgentCheckpoint extends AgentReceipt {
  phase: "planned" | "delivered";
  beforeHash: string | null;
  beforeOwned: boolean;
  beforeReceiptHash: string | null;
}
export interface BuiltInRecallAgentState {
  status: "current" | "missing" | "stale" | "collision";
  target: string;
  copilotRoot: string;
  version: string;
  contentHash: string;
  owned: boolean;
  pending: boolean;
  reason?: string;
}

const hash = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export function builtInRecallAgentSource(): string {
  return fileURLToPath(new URL("../../agents/teamai-recall.agent.md", import.meta.url));
}
export function builtInRecallAgentTarget(homeDir: string): string {
  return path.join(copilotHome(homeDir), "agents", AGENT + ".agent.md");
}
export function builtInRecallAgentOwnershipPath(homeDir: string): string {
  return path.join(teamAiHome(homeDir), "built-in-agents", AGENT + ".json");
}
export function builtInRecallAgentCheckpointPath(homeDir: string): string {
  return path.join(teamAiHome(homeDir), "built-in-agents", AGENT + ".pending.json");
}

/** Inspection never creates state or calls a consumer. A pending plan is not ownership. */
export async function inspectBuiltInRecallAgent(homeDir: string): Promise<BuiltInRecallAgentState> {
  const source = await safeRead(builtInRecallAgentSource());
  if (!source) throw new Error("Bundled Recall Agent is missing.");
  const target = builtInRecallAgentTarget(homeDir);
  const root = copilotHome(homeDir);
  const receipt = await readRecord(builtInRecallAgentOwnershipPath(homeDir));
  const pending = await readRecord(builtInRecallAgentCheckpointPath(homeDir), true) as AgentCheckpoint | undefined;
  for (const record of [receipt, pending]) {
    if (record && (!pathsEqual(record.target, target) || !pathsEqual(record.copilotRoot, root))) {
      throw new Error(`COPILOT_HOME root mismatch: Recall Agent record owns '${record.target}' under '${record.copilotRoot}', but current target is '${target}' under '${root}'. Refusing to move or reassign it.`);
    }
  }
  const state: BuiltInRecallAgentState = {
    status: "missing", target, copilotRoot: root, version: VERSION,
    contentHash: hash(source), owned: receipt !== undefined, pending: pending !== undefined,
  };
  let actualHash: string | null;
  try {
    actualHash = await targetHash(target);
  } catch (error) {
    return { ...state, status: "collision", reason: (error as Error).message };
  }
  if (pending) {
    const receiptMatches = pending.beforeOwned
      ? receipt !== undefined && (receipt.contentHash === pending.beforeReceiptHash
        || pending.phase === "delivered" && receipt.contentHash === pending.contentHash && receipt.version === pending.version)
      : receipt === undefined || pending.phase === "delivered" && receipt.contentHash === pending.contentHash && receipt.version === pending.version;
    if (pending.phase === "delivered" && actualHash === pending.contentHash && receiptMatches) {
      return { ...state, status: "stale", reason: "Partial Recall Agent delivery: delivered checkpoint awaits receipt confirmation. Run teamai init or teamai sync to revalidate and recover." };
    }
    if (pending.phase === "planned" && actualHash === pending.beforeHash
      && receiptMatches && (pending.beforeOwned || pending.beforeHash === null)) {
      return { ...state, status: "stale", reason: "Partial Recall Agent delivery: planned checkpoint is ready to resume. Run teamai init or teamai sync." };
    }
    return { ...state, status: "collision", reason: "Partial Recall Agent delivery conflicts with the checkpoint; target changed or delivery is ambiguous. Preserve the file and inspect the exact checkpoint; no automatic claim or repair." };
  }
  if (!receipt) return actualHash === null ? state : { ...state, status: "collision", reason: "target exists without Team AI CLI ownership" };
  if (actualHash === null) return { ...state, status: "stale", reason: "owned target is missing" };
  if (actualHash !== receipt.contentHash) return { ...state, status: "collision", reason: "owned target changed since its receipt; preserving personal changes" };
  if (actualHash === state.contentHash && receipt.version === VERSION) return { ...state, status: "current" };
  return { ...state, status: "stale", reason: "bundled Recall Agent or receipt version changed" };
}

export async function assertRecallAgentRootMatchesOwnership(homeDir: string): Promise<void> {
  // This read-only preflight also validates exact-root pending checkpoints before any command writes.
  await inspectBuiltInRecallAgent(homeDir);
}

export async function convergeBuiltInRecallAgent(homeDir: string, options: { dryRun?: boolean } = {}) {
  const state = await inspectBuiltInRecallAgent(homeDir);
  assertNoCollision(state);
  if (state.status === "current") return { state };
  const change = state.owned ? "update" as const : "create" as const;
  if (options.dryRun) return { state, change };
  const receiptPath = builtInRecallAgentOwnershipPath(homeDir);
  const checkpointPath = builtInRecallAgentCheckpointPath(homeDir);
  const lockPath = path.join(path.dirname(receiptPath), ".teamai.lock");
  await ensureSafeTargetChain(path.dirname(lockPath));
  await withFileLock(lockPath, async () => {
    let checkpointWritten = false;
    try {
      const current = await inspectBuiltInRecallAgent(homeDir);
      assertNoCollision(current);
      if (current.status === "current") return;
      const previous = await readRecord(receiptPath);
      let checkpoint = await readRecord(checkpointPath, true) as AgentCheckpoint | undefined;
      await ensureSafeTargetChain(path.dirname(current.target));
      if (!checkpoint) {
        checkpoint = {
          schemaVersion: 1, managedBy: OWNER, agent: AGENT, copilotRoot: current.copilotRoot,
          target: current.target, version: VERSION, contentHash: current.contentHash,
          phase: "planned", beforeHash: await targetHash(current.target), beforeOwned: current.owned,
          beforeReceiptHash: previous?.contentHash ?? null,
        };
        await atomicWriteJson(checkpointPath, checkpoint);
      }
      checkpointWritten = true;
      if (checkpoint.phase === "planned") {
        // Do not reinterpret a plan from another package as permission to overwrite different bytes.
        const bytes = await safeRead(builtInRecallAgentSource());
        if (!bytes || hash(bytes) !== checkpoint.contentHash || checkpoint.version !== VERSION) {
          throw new Error("Pending Recall Agent plan belongs to a different bundle; resume with its recorded CLI version.");
        }
        await ensureSafeTargetChain(path.dirname(current.target));
        if (await targetHash(current.target) !== checkpoint.beforeHash) throw new Error("Recall Agent target changed after preflight; refusing to overwrite it.");
        if (checkpoint.beforeHash === null) await atomicCreateFile(current.target, bytes);
        else await atomicWriteFile(current.target, bytes);
        checkpoint = { ...checkpoint, phase: "delivered" };
        await atomicWriteJson(checkpointPath, checkpoint);
      }
      if (await targetHash(current.target) !== checkpoint.contentHash) throw new Error("Recall Agent target changed after delivery; refusing receipt confirmation.");
      await safeRead(receiptPath);
      const receipt: AgentReceipt = {
        ...previous, schemaVersion: 1, managedBy: OWNER, agent: AGENT,
        copilotRoot: checkpoint.copilotRoot, target: checkpoint.target,
        version: checkpoint.version, contentHash: checkpoint.contentHash,
      };
      await atomicWriteJson(receiptPath, receipt);
      await unlink(checkpointPath);
    } catch (error) {
      throw new Error(`${checkpointWritten ? "Partial Recall Agent delivery" : "Recall Agent delivery did not start"}; checkpoint: '${checkpointPath}'. ${(error as Error).message}`);
    }
  });
  // A delivered older checkpoint is confirmed first; a new bundle converges only after that fact is durable.
  const final = await inspectBuiltInRecallAgent(homeDir);
  if (final.status === "stale" && !final.pending) return await convergeBuiltInRecallAgent(homeDir);
  return { state: final, change };
}

function assertNoCollision(state: BuiltInRecallAgentState): void {
  if (state.status === "collision") throw new Error(`Built-in Recall Agent collision at '${state.target}': ${state.reason}.`);
}
async function targetHash(target: string): Promise<string | null> {
  await ensureSafeTargetChain(path.dirname(target));
  const bytes = await safeRead(target);
  return bytes ? hash(bytes) : null;
}
async function safeRead(file: string): Promise<Buffer | undefined> {
  await ensureSafeTargetChain(path.dirname(file));
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !pathsEqual(file, await realpath(file))) {
      throw new Error("Unsafe Recall Agent file: " + file);
    }
    return await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function readRecord(file: string, pending = false): Promise<AgentReceipt | undefined> {
  const bytes = await safeRead(file);
  if (!bytes) return undefined;
  const record = JSON.parse(bytes.toString("utf8")) as Partial<AgentCheckpoint>;
  if (!record || record.schemaVersion !== 1 || record.managedBy !== OWNER || record.agent !== AGENT
    || typeof record.target !== "string" || !path.isAbsolute(record.target)
    || typeof record.copilotRoot !== "string" || !path.isAbsolute(record.copilotRoot)
    || typeof record.version !== "string" || record.version.length === 0
    || typeof record.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(record.contentHash)
    || (pending && (record.phase !== "planned" && record.phase !== "delivered"
      || typeof record.beforeOwned !== "boolean"
      || record.beforeReceiptHash !== null && (typeof record.beforeReceiptHash !== "string" || !/^[a-f0-9]{64}$/.test(record.beforeReceiptHash))
      || record.beforeOwned !== (record.beforeReceiptHash !== null)
      || record.beforeHash !== null && (typeof record.beforeHash !== "string" || !/^[a-f0-9]{64}$/.test(record.beforeHash))))) {
    throw new Error("Invalid Recall Agent " + (pending ? "checkpoint" : "ownership record") + " at '" + file + "'.");
  }
  return record as AgentReceipt;
}
