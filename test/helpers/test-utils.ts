import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CopilotClient } from "../../src/copilot/cli.js";
import type { MarketplaceCatalog } from "../../src/copilot/catalog.js";
import { runProcess } from "../../src/utils/process.js";

export const TEST_MARKETPLACE_NAME = "test-teamai";
export const TEST_MARKETPLACE_SOURCE = "https://github.com/test-org/teamai-marketplace.git";
let fakeAuthorityPreparation: Promise<string> | undefined;
const fakeFixtureId = `${process.pid}-${Date.now()}`;
const fakeAuthorityRoot = path.join(os.tmpdir(), `teamai-test-authority-${fakeFixtureId}.git`);
const fakeMarketplaceRoot = path.join(os.tmpdir(), `teamai-fake-marketplace-${fakeFixtureId}`);
process.once("exit", () => {
  for (const root of [fakeAuthorityRoot, fakeMarketplaceRoot]) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Test cleanup must not mask the process result.
    }
  }
});

export function isPermissionError(error: unknown): boolean {
  return ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "");
}

export async function createDirectoryLink(target: string, linkPath: string): Promise<void> {
  await symlink(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

export interface FakeCopilotState {
  marketplaceName: string;
  marketplaces: Array<{ name: string; source?: string }>;
  plugins: Array<{ name: string; marketplace?: string; version?: string; enabled: boolean; source?: string; cache_path?: string }>;
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

export async function loadFakeMarketplace(root?: string): Promise<MarketplaceCatalog> {
  const catalogRoot = root && !/^(?:[a-z][a-z0-9+.-]*:\/\/|git@)/i.test(root)
    ? root
    : fakeMarketplaceRoot;
  await prepareFakePublishedAuthority(catalogRoot);
  return {
    name: TEST_MARKETPLACE_NAME,
    root: catalogRoot,
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

export async function prepareFakePublishedAuthority(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const topLevel = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: root });
  if (topLevel.exitCode === 0) {
    if (!samePath(topLevel.stdout.trim(), root)) return;
    const origin = await runProcess("git", ["remote", "get-url", "origin"], { cwd: root });
    if (origin.exitCode === 0) return;
  } else {
    const init = await runProcess("git", ["init", "-b", "main"], { cwd: root });
    if (init.exitCode !== 0) throw new Error(init.stderr);
  }

  if (!fakeAuthorityPreparation) {
    fakeAuthorityPreparation = createFakePublishedAuthority();
    void fakeAuthorityPreparation.catch(() => { fakeAuthorityPreparation = undefined; });
  }
  const bare = await fakeAuthorityPreparation;
  const remote = await runProcess("git", ["remote", "add", "origin", bare], { cwd: root });
  if (remote.exitCode !== 0) throw new Error(remote.stderr);
}

async function createFakePublishedAuthority(): Promise<string> {
  const bareCheck = await runProcess("git", ["--git-dir", fakeAuthorityRoot, "rev-parse", "--is-bare-repository"]);
  if (bareCheck.exitCode !== 0 || bareCheck.stdout.trim() !== "true") {
    const initializedBare = await runProcess("git", ["init", "--bare", fakeAuthorityRoot]);
    if (initializedBare.exitCode !== 0) throw new Error(initializedBare.stderr);
  }

  const branch = await runProcess("git", ["ls-remote", fakeAuthorityRoot, "refs/heads/teamai-learnings"]);
  if (branch.exitCode !== 0) throw new Error(branch.stderr);
  if (!branch.stdout.trim()) {
    const seed = await tempDir("teamai-fake-authority-seed-");
    try {
      const init = await runProcess("git", ["init", "-b", "teamai-learnings"], { cwd: seed });
      if (init.exitCode !== 0) throw new Error(init.stderr);
      await runProcess("git", ["config", "user.email", "teamai@example.invalid"], { cwd: seed });
      await runProcess("git", ["config", "user.name", "Team AI Test"], { cwd: seed });
      await writeFile(path.join(seed, "README.md"), "Test published Learnings\n", "utf8");
      await mkdir(path.join(seed, ".github"), { recursive: true });
      await writeFile(path.join(seed, ".github", "CODEOWNERS"), "* @teamai\n", "utf8");
      await mkdir(path.join(seed, "learnings", "shared"), { recursive: true });
      await writeFile(path.join(seed, "learnings", "shared", "test.md"), "Test published learning\n", "utf8");
      await runProcess("git", ["add", "."], { cwd: seed });
      const commit = await runProcess("git", ["commit", "-m", "test published authority"], { cwd: seed });
      if (commit.exitCode !== 0) throw new Error(commit.stderr);
      const push = await runProcess("git", ["push", fakeAuthorityRoot, "HEAD:refs/heads/teamai-learnings"], { cwd: seed });
      if (push.exitCode !== 0) throw new Error(push.stderr);
    } finally {
      await rm(seed, { recursive: true, force: true });
    }
  }
  return fakeAuthorityRoot;
}

function samePath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
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
