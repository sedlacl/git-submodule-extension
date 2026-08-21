import { describe, expect, it } from "vitest";
import { parseLsFilesGitlinks, parseLsTreeGitlinks } from "../../../src/git/gitlinkParser.js";

const HEAD_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX_SHA = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const OTHER_SHA = "cccccccccccccccccccccccccccccccccccccccc";

describe("parseLsTreeGitlinks", () => {
  it("keeps only mode 160000 gitlinks from NUL-separated ls-tree output", () => {
    const stdout = [
      `160000 commit ${HEAD_SHA}\tsubmodules/usy_idsmari_commong01`,
      `100644 blob ${OTHER_SHA}\tREADME.md`,
      `160000 commit ${INDEX_SHA}\tsubmodules/usy_aflex_initdatag01#t1`,
      "",
    ].join("\0");

    expect(parseLsTreeGitlinks(stdout)).toEqual([
      { path: "submodules/usy_idsmari_commong01", sha: HEAD_SHA, stage: 0 },
      { path: "submodules/usy_aflex_initdatag01#t1", sha: INDEX_SHA, stage: 0 },
    ]);
  });
});

describe("parseLsFilesGitlinks", () => {
  it("parses index gitlinks including stage 0 and conflict stages", () => {
    const stdout = [
      `160000 ${INDEX_SHA} 0\tsubmodules/uu_energygateway_httpendpointg01`,
      `100644 ${OTHER_SHA} 0\t.gitignore`,
      `160000 ${HEAD_SHA} 1\tconflicted`,
      "",
    ].join("\0");

    expect(parseLsFilesGitlinks(stdout)).toEqual([
      { path: "submodules/uu_energygateway_httpendpointg01", sha: INDEX_SHA, stage: 0 },
      { path: "conflicted", sha: HEAD_SHA, stage: 1 },
    ]);
  });
});
