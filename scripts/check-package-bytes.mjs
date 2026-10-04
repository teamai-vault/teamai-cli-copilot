import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Only authored package text is checked. Installed files, receipts and Learning
// payloads are never rewritten to make a hash comparison pass.
const files = [
  "agents/teamai-recall.agent.md",
  "skills/teamai/SKILL.md",
  "skills/teamai/references/commands.md",
  "README.md",
  "README.zh-CN.md",
  "dist/cli.js",
];
for (const relative of files) {
  const file = new URL("../" + relative, import.meta.url);
  const bytes = await readFile(file);
  new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (bytes.includes(13) || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    throw new Error(`Package text must be UTF-8 without BOM and use LF: ${fileURLToPath(file)}. Use a clean checkout with .gitattributes; preserve installed targets, receipts and frozen payloads.`);
  }
}
