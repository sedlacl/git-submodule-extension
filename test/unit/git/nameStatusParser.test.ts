import { describe, expect, it } from "vitest";
import { parseNameStatusZ } from "../../../src/git/nameStatusParser.js";

describe("parseNameStatusZ", () => {
  it("parses add, modify, and delete", () => {
    const stdout = ["A", "added.txt", "M", "src/index.js", "D", "gone.md", ""].join("\0");

    expect(parseNameStatusZ(stdout)).toEqual([
      { status: "added", path: "added.txt" },
      { status: "modified", path: "src/index.js" },
      { status: "deleted", path: "gone.md" },
    ]);
  });

  it("parses rename and copy with similarity scores", () => {
    const stdout = ["R100", "old/name.ts", "new/name.ts", "C075", "src/a.ts", "src/b.ts", ""].join("\0");

    expect(parseNameStatusZ(stdout)).toEqual([
      { status: "renamed", path: "new/name.ts", oldPath: "old/name.ts", similarity: 100 },
      { status: "copied", path: "src/b.ts", oldPath: "src/a.ts", similarity: 75 },
    ]);
  });

  it("maps typechange and unknown codes", () => {
    const stdout = ["T", "link-or-file", "X", "mystery", ""].join("\0");

    expect(parseNameStatusZ(stdout)).toEqual([
      { status: "typechange", path: "link-or-file" },
      { status: "unknown", path: "mystery" },
    ]);
  });

  it("returns an empty list for empty diff output", () => {
    expect(parseNameStatusZ("")).toEqual([]);
  });
});
