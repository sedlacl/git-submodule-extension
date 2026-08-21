import { describe, expect, it } from "vitest";
import {
  CHANGE_GROUP_LABELS,
  CHANGE_GROUP_ORDER,
  bindRepositoryOperations,
  commandPaths,
  formatAheadBehind,
  headDescription,
  isRenameChange,
  resourceStatusLetter,
  resourceStatusText,
  resourceStatusThemeColorId,
  snapshotChangeGroups,
  snapshotHead,
  snapshotRepository,
  toRepositoryTreeModel,
  visibleChangeGroups,
  ResourceStatus,
  type ChangeLike,
  type ChangeCommandTarget,
} from "../../../src/git/repositoryState.js";

function uri(fsPath: string): { fsPath: string } {
  return { fsPath };
}

function change(status: number, filePath: string, originalPath = filePath, renamePath?: string): ChangeLike {
  return {
    uri: uri(filePath),
    originalUri: uri(originalPath),
    renameUri: renamePath === undefined ? undefined : uri(renamePath),
    status,
  };
}

describe("snapshotChangeGroups", () => {
  const root = "/ws/httpendpoint";

  it("keeps merge, index, working-tree, and untracked groups from vscode.git", () => {
    const groups = snapshotChangeGroups(root, {
      mergeChanges: [change(ResourceStatus.BOTH_MODIFIED, "/ws/httpendpoint/conflict.ts")],
      indexChanges: [change(ResourceStatus.INDEX_ADDED, "/ws/httpendpoint/staged.ts")],
      workingTreeChanges: [change(ResourceStatus.MODIFIED, "/ws/httpendpoint/dirty.ts")],
      untrackedChanges: [change(ResourceStatus.UNTRACKED, "/ws/httpendpoint/new.ts")],
    });

    expect(groups.merge.map((item) => item.relativePath)).toEqual(["conflict.ts"]);
    expect(groups.index.map((item) => item.relativePath)).toEqual(["staged.ts"]);
    expect(groups.workingTree.map((item) => item.relativePath)).toEqual(["dirty.ts"]);
    expect(groups.untracked.map((item) => item.relativePath)).toEqual(["new.ts"]);
  });

  it("preserves status, originalUri, and renameUri for index renames", () => {
    const groups = snapshotChangeGroups(root, {
      indexChanges: [
        change(
          ResourceStatus.INDEX_RENAMED,
          "/ws/httpendpoint/after.ts",
          "/ws/httpendpoint/before.ts",
          "/ws/httpendpoint/after.ts",
        ),
      ],
      workingTreeChanges: [],
      untrackedChanges: [],
    });

    expect(groups.index[0]).toMatchObject({
      uri: "/ws/httpendpoint/after.ts",
      originalUri: "/ws/httpendpoint/before.ts",
      renameUri: "/ws/httpendpoint/after.ts",
      status: ResourceStatus.INDEX_RENAMED,
      relativePath: "after.ts",
    });
    expect(isRenameChange(groups.index[0])).toBe(true);
  });

  it("splits UNTRACKED/IGNORED out of workingTreeChanges when untrackedChanges is missing", () => {
    const groups = snapshotChangeGroups(root, {
      workingTreeChanges: [
        change(ResourceStatus.MODIFIED, "/ws/httpendpoint/dirty.ts"),
        change(ResourceStatus.UNTRACKED, "/ws/httpendpoint/new.ts"),
        change(ResourceStatus.IGNORED, "/ws/httpendpoint/skip.ts"),
      ],
    });

    expect(groups.workingTree.map((item) => item.relativePath)).toEqual(["dirty.ts"]);
    expect(groups.untracked.map((item) => item.relativePath)).toEqual(["new.ts", "skip.ts"]);
  });

  it("does not regroup when untrackedChanges is present as an empty array", () => {
    const groups = snapshotChangeGroups(root, {
      workingTreeChanges: [change(ResourceStatus.UNTRACKED, "/ws/httpendpoint/mixed.ts")],
      untrackedChanges: [],
    });

    expect(groups.workingTree.map((item) => item.relativePath)).toEqual(["mixed.ts"]);
    expect(groups.untracked).toEqual([]);
  });
});

describe("snapshotHead", () => {
  it("captures branch name, upstream, and ahead/behind", () => {
    expect(
      snapshotHead({
        type: 0,
        name: "main",
        commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        upstream: { remote: "origin", name: "main", commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
        ahead: 2,
        behind: 1,
      }),
    ).toEqual({
      name: "main",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      upstream: { remote: "origin", name: "main", commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      ahead: 2,
      behind: 1,
      detached: false,
    });
  });

  it("treats a HEAD without a name as detached", () => {
    expect(snapshotHead({ type: 0, commit: "cccccccccccccccccccccccccccccccccccccccc" })).toMatchObject({
      detached: true,
      commit: "cccccccccccccccccccccccccccccccccccccccc",
    });
  });
});

describe("tree and command layer interfaces", () => {
  it("omits empty groups and keeps built-in Merge/Staged/Changes/Untracked order", () => {
    const snapshot = snapshotRepository({
      rootUri: uri("/ws/httpendpoint"),
      state: {
        HEAD: { type: 0, name: "main", ahead: 1, behind: 0 },
        workingTreeChanges: [change(ResourceStatus.MODIFIED, "/ws/httpendpoint/dirty.ts")],
        untrackedChanges: [change(ResourceStatus.UNTRACKED, "/ws/httpendpoint/new.ts")],
        indexChanges: [],
        mergeChanges: [],
      },
    });
    const tree = toRepositoryTreeModel(snapshot);

    expect(CHANGE_GROUP_ORDER).toEqual(["merge", "index", "workingTree", "untracked"]);
    expect(tree.groups.map((group) => group.label)).toEqual([
      CHANGE_GROUP_LABELS.workingTree,
      CHANGE_GROUP_LABELS.untracked,
    ]);
    expect(visibleChangeGroups(snapshot.groups).map((group) => group.kind)).toEqual(["workingTree", "untracked"]);
  });

  it("exposes command paths from a change target", () => {
    const target: ChangeCommandTarget = {
      rootPath: "/ws/httpendpoint",
      group: "index",
      resources: [
        snapshotChangeGroups("/ws/httpendpoint", {
          indexChanges: [change(ResourceStatus.INDEX_MODIFIED, "/ws/httpendpoint/a.ts")],
        }).index[0],
      ],
    };
    expect(commandPaths(target)).toEqual(["/ws/httpendpoint/a.ts"]);
  });

  it("formats branch ↔ upstream and ahead/behind for the tree description", () => {
    const head = snapshotHead({
      type: 0,
      name: "main",
      upstream: { remote: "origin", name: "main" },
      ahead: 2,
      behind: 1,
    });
    expect(formatAheadBehind(head!)).toBe("1↓ 2↑");
    expect(headDescription(head)).toBe("main ↔ origin/main 1↓ 2↑");
  });
});

describe("resource status mapping", () => {
  it("matches built-in Git Resource letters and decoration colors", () => {
    expect(resourceStatusLetter(ResourceStatus.MODIFIED)).toBe("M");
    expect(resourceStatusLetter(ResourceStatus.INDEX_RENAMED)).toBe("R");
    expect(resourceStatusLetter(ResourceStatus.UNTRACKED)).toBe("U");
    expect(resourceStatusLetter(ResourceStatus.BOTH_MODIFIED)).toBe("!");
    expect(resourceStatusText(ResourceStatus.INDEX_ADDED)).toBe("Index Added");
    expect(resourceStatusThemeColorId(ResourceStatus.INDEX_RENAMED)).toBe("gitDecoration.renamedResourceForeground");
    expect(resourceStatusThemeColorId(ResourceStatus.BOTH_ADDED)).toBe("gitDecoration.conflictingResourceForeground");
  });
});

describe("bindRepositoryOperations", () => {
  it("forwards add/revert/clean/commit/status/fetch/pull/push to the vscode.git repository", async () => {
    const calls: string[] = [];
    const ops = bindRepositoryOperations({
      add: async (paths) => {
        calls.push(`add:${paths.join(",")}`);
      },
      revert: async (paths) => {
        calls.push(`revert:${paths.join(",")}`);
      },
      clean: async (paths) => {
        calls.push(`clean:${paths.join(",")}`);
      },
      commit: async (message) => {
        calls.push(`commit:${message}`);
      },
      status: async () => {
        calls.push("status");
      },
      fetch: async () => {
        calls.push("fetch");
      },
      pull: async () => {
        calls.push("pull");
      },
      push: async (remote, branch, setUpstream) => {
        calls.push(`push:${remote}:${branch}:${String(setUpstream)}`);
      },
    });

    await ops.add(["/ws/a.ts"]);
    await ops.revert(["/ws/b.ts"]);
    await ops.clean(["/ws/c.ts"]);
    await ops.commit("wip");
    await ops.status();
    await ops.fetch();
    await ops.pull();
    await ops.push("origin", "main", true);

    expect(calls).toEqual([
      "add:/ws/a.ts",
      "revert:/ws/b.ts",
      "clean:/ws/c.ts",
      "commit:wip",
      "status",
      "fetch",
      "pull",
      "push:origin:main:true",
    ]);
  });
});
