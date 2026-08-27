import { describe, expect, it } from "vitest";
import { CHANGE_GROUP_LABELS, ResourceStatus } from "../../../src/git/repositoryState.js";
import {
  DEFAULT_CHANGES_TREE_SETTINGS,
  parseSessionViewMode,
  resolveViewMode,
  withSessionViewMode,
  readChangesTreeSettings,
  applyUntrackedSettings,
  emptyChangeGroups,
  repositoryBranchDescription,
  visibleTreeGroups,
  type ChangesTreeSettings,
} from "../../../src/views/changesTreeSettings.js";
import type { ResourceChange } from "../../../src/git/repositoryState.js";

function change(relativePath: string, status: number): ResourceChange {
  return {
    uri: `/ws/${relativePath}`,
    originalUri: `/ws/${relativePath}`,
    status: status as ResourceChange["status"],
    relativePath,
  };
}

const mixedWorking = {
  merge: [change("conflict.ts", ResourceStatus.BOTH_MODIFIED)],
  index: [change("staged.ts", ResourceStatus.INDEX_ADDED)],
  workingTree: [change("dirty.ts", ResourceStatus.MODIFIED)],
  untracked: [change("new.ts", ResourceStatus.UNTRACKED)],
};

describe("applyUntrackedSettings", () => {
  it("mixes untracked into Changes and drops the Untracked group", () => {
    const applied = applyUntrackedSettings(mixedWorking, "mixed");
    expect(applied.workingTree.map((item) => item.relativePath)).toEqual(["dirty.ts", "new.ts"]);
    expect(applied.untracked).toEqual([]);
  });

  it("does not duplicate untracked files already present in workingTree", () => {
    const applied = applyUntrackedSettings(
      {
        ...emptyChangeGroups(),
        workingTree: [change("new.ts", ResourceStatus.UNTRACKED)],
        untracked: [change("new.ts", ResourceStatus.UNTRACKED)],
      },
      "mixed",
    );
    expect(applied.workingTree.map((item) => item.relativePath)).toEqual(["new.ts"]);
    expect(applied.untracked).toEqual([]);
  });

  it("keeps a separate Untracked Changes group", () => {
    const applied = applyUntrackedSettings(mixedWorking, "separate");
    expect(applied.workingTree.map((item) => item.relativePath)).toEqual(["dirty.ts"]);
    expect(applied.untracked.map((item) => item.relativePath)).toEqual(["new.ts"]);
  });

  it("extracts UNTRACKED/IGNORED from workingTree when the snapshot mixed them", () => {
    const applied = applyUntrackedSettings(
      {
        ...emptyChangeGroups(),
        workingTree: [change("dirty.ts", ResourceStatus.MODIFIED), change("new.ts", ResourceStatus.UNTRACKED)],
      },
      "separate",
    );
    expect(applied.workingTree.map((item) => item.relativePath)).toEqual(["dirty.ts"]);
    expect(applied.untracked.map((item) => item.relativePath)).toEqual(["new.ts"]);
  });

  it("hides untracked files from both groups", () => {
    const applied = applyUntrackedSettings(mixedWorking, "hidden");
    expect(applied.workingTree.map((item) => item.relativePath)).toEqual(["dirty.ts"]);
    expect(applied.untracked).toEqual([]);
  });
});

describe("visibleTreeGroups", () => {
  it("hides every empty group by default", () => {
    const groups = visibleTreeGroups(emptyChangeGroups(), DEFAULT_CHANGES_TREE_SETTINGS);
    expect(groups).toEqual([]);
  });

  it("shows empty Staged Changes when git.alwaysShowStagedChangesResourceGroup is true", () => {
    const settings: ChangesTreeSettings = { ...DEFAULT_CHANGES_TREE_SETTINGS, alwaysShowStagedChangesResourceGroup: true };
    const groups = visibleTreeGroups(emptyChangeGroups(), settings);
    expect(groups.map((group) => group.label)).toEqual([CHANGE_GROUP_LABELS.index]);
  });

  it("keeps Merge → Staged → Changes → Untracked order", () => {
    const groups = visibleTreeGroups(mixedWorking, { ...DEFAULT_CHANGES_TREE_SETTINGS, untrackedChanges: "separate" });
    expect(groups.map((group) => group.label)).toEqual([
      CHANGE_GROUP_LABELS.merge,
      CHANGE_GROUP_LABELS.index,
      CHANGE_GROUP_LABELS.workingTree,
      CHANGE_GROUP_LABELS.untracked,
    ]);
  });
});

describe("repositoryBranchDescription", () => {
  it("shows only the local branch and built-in dirty suffixes", () => {
    const head = {
      name: "main",
      detached: false,
      ahead: 2,
      behind: 1,
      upstream: { remote: "origin", name: "main" },
    };
    expect(repositoryBranchDescription(head, mixedWorking)).toBe("main*+!");
    expect(
      repositoryBranchDescription(head, {
        ...emptyChangeGroups(),
        workingTree: [change("dirty.ts", ResourceStatus.MODIFIED)],
      }),
    ).toBe("main*");
    expect(
      repositoryBranchDescription(head, {
        ...emptyChangeGroups(),
        index: [change("staged.ts", ResourceStatus.INDEX_ADDED)],
      }),
    ).toBe("main+");
  });

  it("uses an 8-character SHA when detached and + when the index has changes", () => {
    const head = { commit: "cccccccccccccccccccccccccccccccccccccccc", detached: true };
    expect(repositoryBranchDescription(head, emptyChangeGroups())).toBe("cccccccc");
    expect(
      repositoryBranchDescription(head, {
        ...emptyChangeGroups(),
        index: [change("staged.ts", ResourceStatus.INDEX_ADDED)],
      }),
    ).toBe("cccccccc+");
  });
});

describe("readChangesTreeSettings", () => {
  it("reads git.* and scm.* with built-in defaults", () => {
    const values: Record<string, unknown> = {
      "git.untrackedChanges": "separate",
      "scm.defaultViewMode": "tree",
      "scm.compactFolders": false,
    };
    const settings = readChangesTreeSettings((section, key, fallback) => values[`${section}.${key}`] ?? fallback);
    expect(settings.untrackedChanges).toBe("separate");
    expect(settings.viewMode).toBe("tree");
    expect(settings.compactFolders).toBe(false);
    expect(settings.alwaysShowStagedChangesResourceGroup).toBe(false);
    expect(settings.openDiffOnClick).toBe(true);
  });
});

describe("session view mode", () => {
  it("defaults to tree when scm.defaultViewMode is unset", () => {
    const settings = readChangesTreeSettings((_section, _key, fallback) => fallback);
    expect(settings.viewMode).toBe("tree");
    expect(resolveViewMode(settings.viewMode, undefined)).toBe("tree");
  });

  it("prefers session override over scm.defaultViewMode", () => {
    const settings = readChangesTreeSettings((_section, key) => (key === "defaultViewMode" ? "tree" : undefined));
    expect(withSessionViewMode(settings, "list").viewMode).toBe("list");
    expect(resolveViewMode(settings.viewMode, "list")).toBe("list");
  });

  it("reads scm.defaultViewMode when no session override is stored", () => {
    const settings = readChangesTreeSettings((_section, key) => (key === "defaultViewMode" ? "list" : undefined));
    expect(withSessionViewMode(settings, undefined).viewMode).toBe("list");
  });

  it("parses stored session values and ignores invalid entries", () => {
    expect(parseSessionViewMode("tree")).toBe("tree");
    expect(parseSessionViewMode("list")).toBe("list");
    expect(parseSessionViewMode("grid")).toBeUndefined();
    expect(parseSessionViewMode(undefined)).toBeUndefined();
  });
});
