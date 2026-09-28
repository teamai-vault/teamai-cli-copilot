import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const script = fileURLToPath(new URL("../../scripts/rename-cli.mjs", import.meta.url));

async function fixture() {
  const parent = process.env.TEST_TMP_ROOT ?? os.tmpdir();
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(path.join(parent, "rename-cli-"));
  const cli = path.join(root, "teamai-cli-customization");
  const marketplace = path.join(root, "teamai-marketplace");
  await mkdir(path.join(cli, "skills", "team-ai"), { recursive: true });
  await mkdir(path.join(marketplace, ".github", "plugin"), { recursive: true });
  await writeFile(path.join(root, "AGENTS.md"), "teamai-cli-customization is the Team AI CLI.\n");
  await writeFile(path.join(cli, "package.json"), '{"name": "teamai-cli-customization", "bin": {"team-ai": "dist/cli.js"}}\n');
  await writeFile(path.join(cli, "package-lock.json"), '{"name": "teamai-cli-customization", "packages": {"": {"name": "teamai-cli-customization"}}}\n');
  await writeFile(path.join(cli, "skills", "team-ai", "SKILL.md"), "name: team-ai\nTeam AI uses ~/.team-ai and com.company.teamai.\n");
  await writeFile(path.join(marketplace, "AGENTS.md"), "Read ../teamai-cli-customization/docs. Run team-ai.\n");
  await writeFile(path.join(marketplace, ".github", "plugin", "marketplace.json"), '{"name": "teamai", "owner": {"name": "Team AI"}}\n');
  await writeFile(path.join(marketplace, "README.md"), "https://github.com/teamai-vault/teamai-cli-customization and common@teamai\n");
  for (const repo of [cli, marketplace]) {
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
    execFileSync("git", ["config", "user.email", "rename@example.invalid"], { cwd: repo });
    execFileSync("git", ["config", "user.name", "Rename Test"], { cwd: repo });
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: repo });
  }
  execFileSync("git", ["remote", "add", "origin", "https://github.com/teamai-vault/teamai-cli-customization.git"], { cwd: cli });
  return { root, cli, marketplace };
}

test("previews and applies a full local identity rename without changing Marketplace IDs", async () => {
  const { root, cli, marketplace } = await fixture();
  try {
    const args = [script, "--workspace", root, "--repo", "nova-cli", "--package", "@example/nova-cli", "--command", "nova", "--display", "Nova", "--namespace", "com.example.nova", "--skip-github"];
    const preview = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
    expect(preview.status).toBe(0);
    expect(preview.stdout).toContain("skills/team-ai/SKILL.md -> skills/nova/SKILL.md");
    expect(existsSync(path.join(cli, "skills", "team-ai", "SKILL.md"))).toBe(true);

    const apply = spawnSync(process.execPath, [...args, "--apply"], { cwd: root, encoding: "utf8" });
    expect(apply.status, apply.stderr).toBe(0);
    expect(JSON.parse(await readFile(path.join(cli, "package.json"), "utf8"))).toMatchObject({ name: "@example/nova-cli", bin: { nova: "dist/cli.js" } });
    expect(JSON.parse(await readFile(path.join(cli, "package-lock.json"), "utf8")).packages[""].name).toBe("@example/nova-cli");
    expect(await readFile(path.join(cli, "skills", "nova", "SKILL.md"), "utf8")).toContain("Nova uses ~/.nova and com.example.nova.");
    expect(await readFile(path.join(marketplace, "AGENTS.md"), "utf8")).toContain("../teamai-cli-customization/docs. Run nova.");
    expect(JSON.parse(await readFile(path.join(marketplace, ".github", "plugin", "marketplace.json"), "utf8")).name).toBe("teamai");
    expect(await readFile(path.join(marketplace, "README.md"), "utf8")).toContain("teamai-vault/nova-cli and common@teamai");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("teamai-cli-customization is the Nova CLI.\n");
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(process.env.TEST_TMP_ROOT ?? os.tmpdir()) + path.sep)) throw new Error("Unsafe fixture cleanup path.");
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);

test("renames the local checkout and sibling references when explicitly requested", async () => {
  const { root, marketplace } = await fixture();
  try {
    const result = spawnSync(process.execPath, [script, "--workspace", root, "--repo", "nova-cli", "--command", "nova", "--display", "Nova", "--namespace", "com.example.nova", "--rename-directory", "--skip-github", "--apply"], { cwd: root, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(path.join(root, "nova-cli", "skills", "nova", "SKILL.md"))).toBe(true);
    expect(await readFile(path.join(marketplace, "AGENTS.md"), "utf8")).toContain("../nova-cli/docs");
    expect(await readFile(path.join(root, "AGENTS.md"), "utf8")).toBe("nova-cli is the Nova CLI.\n");
  } finally {
    if (!path.resolve(root).startsWith(path.resolve(process.env.TEST_TMP_ROOT ?? os.tmpdir()) + path.sep)) throw new Error("Unsafe fixture cleanup path.");
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
