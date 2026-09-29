import { readdir } from "node:fs/promises";
import path from "node:path";
import type { PlannedAction } from "../copilot/plugins.js";
import { userInstructionDisplayPath, type UserInstructionPlan } from "../copilot/user-instructions.js";

export function printActions(actions: PlannedAction[], dryRun: boolean, out: (message: string) => void): void {
  if (actions.length === 0) {
    out("Copilot plugin state is already converged.");
    return;
  }
  for (const action of actions) {
    const prefix = dryRun ? "WOULD" : "DONE";
    out(`${prefix} ${action.kind}: ${action.target}`);
  }
}

export function printWarnings(warnings: string[], out: (message: string) => void): void {
  for (const warning of warnings) out(`! ${warning}`);
}

export function printUserInstructionActions(plan: UserInstructionPlan, dryRun: boolean, homeDir: string, out: (message: string) => void): void {
  if (plan.changes.length === 0) {
    out(`Managed user instructions are already converged (${plan.desired.length}).`);
    return;
  }
  for (const change of plan.changes) {
    out(`${dryRun ? "WOULD" : "DONE"} ${change.type}: ${userInstructionDisplayPath(change.relativePath, homeDir)}`);
  }
}

async function countEntries(directory: string, predicate: (name: string) => boolean = () => true): Promise<number> {
  try {
    return (await readdir(directory, { withFileTypes: true })).filter((entry) => predicate(entry.name)).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

export async function projectCustomizationCounts(workspaceRoot: string): Promise<{
  skills: number;
  agents: number;
  hooks: number;
  instructions: number;
  rootInstructions: boolean;
}> {
  const github = path.join(workspaceRoot, ".github");
  return {
    skills: await countEntries(path.join(github, "skills")),
    agents: await countEntries(path.join(github, "agents"), (name) => name.endsWith(".agent.md")),
    hooks: await countEntries(path.join(github, "hooks"), (name) => name.endsWith(".json")),
    instructions: await countEntries(path.join(github, "instructions"), (name) => name.endsWith(".instructions.md")),
    rootInstructions: (await countEntries(github, (name) => name === "copilot-instructions.md")) > 0,
  };
}
