import { describe, expect, test } from "vitest";
import { pathsEqual } from "../../src/utils/fs.js";

describe("cross-platform path equality", () => {
  test("uses case-insensitive Windows semantics", () => {
    expect(pathsEqual(
      "C:\\Users\\Alice\\..\\Alice\\.copilot\\skills\\teamai",
      "c:\\users\\alice\\.copilot\\skills\\teamai",
      "win32",
    )).toBe(true);
  });

  test("uses POSIX path syntax for macOS without Windows case-folding", () => {
    expect(pathsEqual(
      "/Users/Alice/../Alice/.copilot/skills/teamai",
      "/Users/Alice/.copilot/skills/teamai",
      "darwin",
    )).toBe(true);
    expect(pathsEqual(
      "/Users/Alice/.copilot/skills/teamai",
      "/Users/alice/.copilot/skills/teamai",
      "darwin",
    )).toBe(false);
  });
});
