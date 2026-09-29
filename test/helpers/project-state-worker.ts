import { runCli } from "../../src/cli.js";
import { CopilotClient } from "../../src/copilot/cli.js";
import { loadFakeMarketplace } from "./test-utils.js";

const [workspaceRoot, homeDir, marketplaceRoot, projectIds] = process.argv.slice(2);
if (!workspaceRoot || !homeDir || !marketplaceRoot || projectIds === undefined) {
  throw new Error("Expected workspace, home, marketplace, and project ID arguments.");
}

process.exitCode = await runCli(["projects", "set", ...projectIds.split(",").filter(Boolean)], {
  cwd: workspaceRoot,
  homeDir,
  copilot: new CopilotClient("teamai-project-state-worker-unused"),
  loadMarketplace: async () => loadFakeMarketplace(marketplaceRoot),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
