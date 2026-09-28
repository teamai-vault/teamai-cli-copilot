import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient } from "../../src/copilot/cli.js";
import type { MarketplaceCatalog } from "../../src/copilot/catalog.js";
import { runProcess } from "../../src/utils/process.js";

export const TEST_MARKETPLACE_NAME = "test-teamai";
export const TEST_MARKETPLACE_SOURCE = "https://github.com/test-org/teamai-marketplace.git";

export function isPermissionError(error: unknown): boolean {
  return ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

export interface FakeCopilotState {
  marketplaceName: string;
  marketplaces: Array<{ name: string; source?: string }>;
  plugins: Array<{ name: string; marketplace?: string; version?: string; enabled: boolean; source?: string }>;
  mcpServers: Array<{ name: string; enabled?: boolean; source?: string }>;
  mcpErrors: unknown[];
  catalog: Record<string, Array<{ name: string; version: string }>>;
}

export async function tempDir(prefix: string): Promise<string> {
  return await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

export async function createFakeCopilot(initial?: Partial<FakeCopilotState>): Promise<{
  client: CopilotClient;
  statePath: string;
  readState: () => Promise<FakeCopilotState>;
}> {
  const directory = await tempDir("teamai-fake-copilot-");
  const statePath = path.join(directory, "state.json");
  const state: FakeCopilotState = {
    marketplaceName: initial?.marketplaceName ?? TEST_MARKETPLACE_NAME,
    marketplaces: initial?.marketplaces ?? [],
    plugins: initial?.plugins ?? [],
    mcpServers: initial?.mcpServers ?? [],
    mcpErrors: initial?.mcpErrors ?? [],
    catalog: initial?.catalog ?? {
      [initial?.marketplaceName ?? TEST_MARKETPLACE_NAME]: [
        { name: "common", version: "0.1.0" },
        { name: "api", version: "0.1.0" },
        { name: "ios", version: "0.1.0" },
        { name: "aos", version: "0.1.0" },
        { name: "qa", version: "0.1.0" },
        { name: "design", version: "0.1.0" },
      ],
    },
  };
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  const helperPath = fileURLToPath(new URL("./fake-copilot.mjs", import.meta.url));
  return {
    client: new CopilotClient(process.execPath, [helperPath, statePath]),
    statePath,
    readState: async () => JSON.parse(await readFile(statePath, "utf8")) as FakeCopilotState,
  };
}

export async function loadFakeMarketplace(root = path.join(os.tmpdir(), "teamai-fake-marketplace-without-instructions")): Promise<MarketplaceCatalog> {
  return {
    name: TEST_MARKETPLACE_NAME,
    root,
    plugins: [
      { name: "common", version: "0.1.0", kind: "common", root: "common" },
      { name: "api", version: "0.1.0", kind: "role", root: "api" },
      { name: "ios", version: "0.1.0", kind: "role", root: "ios" },
      { name: "aos", version: "0.1.0", kind: "role", root: "aos" },
      { name: "qa", version: "0.1.0", kind: "role", root: "qa" },
      { name: "design", version: "0.1.0", kind: "role", root: "design" },
      { name: "payments", version: "0.1.0", kind: "project", root: "payments" },
    ],
    skills: [],
    dispose: async () => undefined,
  };
}

export async function createGitRepo(): Promise<string> {
  const root = await tempDir("teamai-git-");
  const init = await runProcess("git", ["init", "-b", "main"], { cwd: root });
  if (init.exitCode !== 0) throw new Error(init.stderr);
  await runProcess("git", ["config", "user.email", "teamai@example.invalid"], { cwd: root });
  await runProcess("git", ["config", "user.name", "Team AI Test"], { cwd: root });
  await writeFile(path.join(root, "README.md"), "# test\n", "utf8");
  await runProcess("git", ["add", "README.md"], { cwd: root });
  const commit = await runProcess("git", ["commit", "-m", "initial"], { cwd: root });
  if (commit.exitCode !== 0) throw new Error(commit.stderr);
  return root;
}
