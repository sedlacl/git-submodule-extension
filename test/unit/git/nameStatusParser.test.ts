import { describe, expect, it } from "vitest";
import { parseNameStatusZ, parseRawDiffZ } from "../../../src/git/nameStatusParser.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ZERO = "0000000000000000000000000000000000000000";

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

describe("parseRawDiffZ", () => {
  it("parses ordinary files with modes and SHAs", () => {
    const stdout = [
      `:100644 100644 ${HEAD} ${INDEX} M`,
      "src/index.js",
      `:000000 100644 ${ZERO} ${INDEX} A`,
      "added.txt",
      `:100644 000000 ${HEAD} ${ZERO} D`,
      "gone.md",
      "",
    ].join("\0");

    expect(parseRawDiffZ(stdout)).toEqual([
      {
        status: "modified",
        path: "src/index.js",
        oldMode: "100644",
        newMode: "100644",
        oldSha: HEAD,
        newSha: INDEX,
      },
      {
        status: "added",
        path: "added.txt",
        oldMode: "000000",
        newMode: "100644",
        oldSha: undefined,
        newSha: INDEX,
      },
      {
        status: "deleted",
        path: "gone.md",
        oldMode: "100644",
        newMode: "000000",
        oldSha: HEAD,
        newSha: undefined,
      },
    ]);
  });

  it("keeps gitlink modes and both SHAs for nested pointer diffs", () => {
    const stdout = [
      `:160000 160000 ${HEAD} ${INDEX} M`,
      "submodules/uu_energygateway_datagatewayg01",
      "",
    ].join("\0");

    expect(parseRawDiffZ(stdout)).toEqual([
      {
        status: "modified",
        path: "submodules/uu_energygateway_datagatewayg01",
        oldMode: "160000",
        newMode: "160000",
        oldSha: HEAD,
        newSha: INDEX,
      },
    ]);
  });

  it("parses rename and copy with similarity scores", () => {
    const stdout = [
      `:100644 100644 ${HEAD} ${INDEX} R100`,
      "old/name.ts",
      "new/name.ts",
      `:100644 100644 ${HEAD} ${INDEX} C075`,
      "src/a.ts",
      "src/b.ts",
      "",
    ].join("\0");

    expect(parseRawDiffZ(stdout)).toEqual([
      {
        status: "renamed",
        path: "new/name.ts",
        oldPath: "old/name.ts",
        similarity: 100,
        oldMode: "100644",
        newMode: "100644",
        oldSha: HEAD,
        newSha: INDEX,
      },
      {
        status: "copied",
        path: "src/b.ts",
        oldPath: "src/a.ts",
        similarity: 75,
        oldMode: "100644",
        newMode: "100644",
        oldSha: HEAD,
        newSha: INDEX,
      },
    ]);
  });

  it("returns an empty list for empty diff output", () => {
    expect(parseRawDiffZ("")).toEqual([]);
  });
});
