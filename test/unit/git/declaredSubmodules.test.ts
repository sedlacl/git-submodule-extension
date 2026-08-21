import { describe, expect, it } from "vitest";
import { mergeDeclaredSubmodules } from "../../../src/git/declaredSubmodules.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

describe("mergeDeclaredSubmodules", () => {
  it("unions gitmodules and gitlinks and keeps the committed branch for restore", () => {
    const merged = mergeDeclaredSubmodules({
      indexGitmodules: [
        {
          name: "submodules/usy_idsmari_commong01",
          path: "submodules/usy_idsmari_commong01",
          url: "ssh://git@example/common.git",
          branch: "development/AFLEX",
        },
      ],
      headGitmodules: [
        {
          name: "submodules/usy_idsmari_commong01",
          path: "submodules/usy_idsmari_commong01",
          url: "ssh://git@example/common.git",
          branch: "development/AFLEX",
        },
      ],
      headGitlinks: [{ path: "submodules/usy_idsmari_commong01", sha: HEAD, stage: 0 }],
      indexGitlinks: [{ path: "submodules/usy_idsmari_commong01", sha: INDEX, stage: 0 }],
    });

    expect(merged).toEqual([
      {
        relativePath: "submodules/usy_idsmari_commong01",
        name: "submodules/usy_idsmari_commong01",
        url: "ssh://git@example/common.git",
        configuredBranch: "development/AFLEX",
        committedConfiguredBranch: "development/AFLEX",
        headGitlinkSha: HEAD,
        indexGitlinkSha: INDEX,
      },
    ]);
  });

  it("includes gitlink-only paths and rejects absolute or parent-escaping paths", () => {
    const merged = mergeDeclaredSubmodules({
      indexGitmodules: [
        {
          name: "evil",
          path: "../outside",
          url: null,
          branch: null,
        },
      ],
      headGitmodules: [],
      headGitlinks: [{ path: "submodules/only-in-tree", sha: HEAD, stage: 0 }],
      indexGitlinks: [],
    });

    expect(merged.map((entry) => entry.relativePath)).toEqual(["submodules/only-in-tree"]);
  });
});
