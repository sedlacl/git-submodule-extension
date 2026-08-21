import { describe, expect, it } from "vitest";
import { ResourceStatus, type ResourceChange } from "../../../src/git/repositoryState.js";
import { changeOpenPlan, changeOpenTarget } from "../../../src/views/changeOpenPlan.js";
import { splitUriString, unsafeFileUrlFromFsPathConcat } from "../../../src/views/uriSafety.js";

function change(
  group: "merge" | "index" | "workingTree" | "untracked",
  status: number,
  paths: { uri?: string; originalUri?: string; relativePath?: string; renameUri?: string } = {},
): Parameters<typeof changeOpenPlan>[0] {
  const uri = paths.uri ?? "/ws/file.ts";
  const resource: ResourceChange = {
    uri,
    originalUri: paths.originalUri ?? uri,
    renameUri: paths.renameUri,
    status: status as ResourceChange["status"],
    relativePath: paths.relativePath ?? "file.ts",
  };
  return { rootPath: "/ws", group, resource };
}

const HASH_T1_ROOT =
  "R:\\External\\git-submodule-extension\\fixtures\\ui\\infra-deploy\\submodules\\usy_aflex_initdatag01#t1";
const HASH_T1_FILE = `${HASH_T1_ROOT}\\local\\t1-wip.txt`;

function hashT1Change(
  group: "merge" | "index" | "workingTree" | "untracked",
  status: number,
  relativePath = "local/t1-wip.txt",
  originalRelative = relativePath,
): Parameters<typeof changeOpenPlan>[0] {
  const uri = `${HASH_T1_ROOT}\\${relativePath.replaceAll("/", "\\")}`;
  const originalUri = `${HASH_T1_ROOT}\\${originalRelative.replaceAll("/", "\\")}`;
  return change(group, status, { uri, originalUri, relativePath, renameUri: uri === originalUri ? undefined : uri });
}

describe("changeOpenPlan", () => {
  it("diffs staged files as HEAD → index using public toGitUri refs", () => {
    expect(changeOpenPlan(change("index", ResourceStatus.INDEX_MODIFIED))).toEqual({
      title: "file.ts (Index)",
      leftRef: "HEAD",
      leftPath: "original",
      right: "index",
    });
  });

  it("diffs working-tree files as index (~) → working tree", () => {
    expect(changeOpenPlan(change("workingTree", ResourceStatus.MODIFIED))).toMatchObject({
      leftRef: "~",
      leftPath: "resource",
      right: "file",
    });
  });

  it("opens untracked infra-deploy #t1 files as the working-tree file, not a git index URI", () => {
    const mixed = hashT1Change("workingTree", ResourceStatus.UNTRACKED);
    const separate = hashT1Change("untracked", ResourceStatus.UNTRACKED);
    for (const input of [mixed, separate]) {
      const plan = changeOpenPlan(input);
      expect(plan.leftRef).toBeUndefined();
      expect(plan.right).toBe("file");
      expect(plan.title).toBe("t1-wip.txt (Untracked)");

      const target = changeOpenTarget(input);
      expect(target.command).toBe("vscode.open");
      expect(target.right).toEqual({ kind: "file", fsPath: HASH_T1_FILE });
      expect(target.left).toBeUndefined();
    }

    const split = splitUriString(unsafeFileUrlFromFsPathConcat(HASH_T1_FILE));
    expect(split.fragment).toBe("t1/local/t1-wip.txt");
  });

  it("keeps #t1 / % / space / ? fsPaths on staged, unstaged, deleted, and renamed opens", () => {
    const reserved = [
      { relative: "local/t1-wip.txt", fsPath: HASH_T1_FILE },
      { relative: "100%done.txt", fsPath: `${HASH_T1_ROOT}\\100%done.txt` },
      { relative: "my file.txt", fsPath: `${HASH_T1_ROOT}\\my file.txt` },
      { relative: "why?.txt", fsPath: `${HASH_T1_ROOT}\\why?.txt` },
    ];

    for (const sample of reserved) {
      const modified = hashT1Change("workingTree", ResourceStatus.MODIFIED, sample.relative);
      const modifiedTarget = changeOpenTarget(modified);
      expect(modifiedTarget.command).toBe("vscode.diff");
      expect(modifiedTarget.left).toEqual({ kind: "git", fsPath: sample.fsPath, ref: "~" });
      expect(modifiedTarget.right).toEqual({ kind: "file", fsPath: sample.fsPath });

      const staged = hashT1Change("index", ResourceStatus.INDEX_MODIFIED, sample.relative);
      const stagedTarget = changeOpenTarget(staged);
      expect(stagedTarget.command).toBe("vscode.diff");
      expect(stagedTarget.left).toEqual({ kind: "git", fsPath: sample.fsPath, ref: "HEAD" });
      expect(stagedTarget.right).toEqual({ kind: "git", fsPath: sample.fsPath, ref: "" });

      const deleted = hashT1Change("workingTree", ResourceStatus.DELETED, sample.relative);
      const deletedTarget = changeOpenTarget(deleted);
      expect(deletedTarget.command).toBe("vscode.open");
      expect(deletedTarget.right).toEqual({ kind: "git", fsPath: sample.fsPath, ref: "HEAD" });
    }

    const renamed = hashT1Change("index", ResourceStatus.INDEX_RENAMED, "local/t1-renamed.txt", "local/t1-wip.txt");
    const renamedTarget = changeOpenTarget(renamed);
    expect(renamedTarget.command).toBe("vscode.diff");
    expect(renamedTarget.left).toEqual({
      kind: "git",
      fsPath: `${HASH_T1_ROOT}\\local\\t1-wip.txt`,
      ref: "HEAD",
    });
    expect(renamedTarget.right).toEqual({
      kind: "git",
      fsPath: `${HASH_T1_ROOT}\\local\\t1-renamed.txt`,
      ref: "",
    });

    const stagedAdd = hashT1Change("index", ResourceStatus.INDEX_ADDED);
    expect(changeOpenTarget(stagedAdd)).toMatchObject({
      command: "vscode.open",
      right: { kind: "git", fsPath: HASH_T1_FILE, ref: "" },
    });
  });

  it("opens deleted resources and uses built-in conflict stage refs", () => {
    expect(changeOpenPlan(change("workingTree", ResourceStatus.DELETED)).right).toBe("HEAD");
    expect(changeOpenPlan(change("merge", ResourceStatus.BOTH_MODIFIED)).right).toBe("file");
    expect(changeOpenPlan(change("merge", ResourceStatus.DELETED_BY_US))).toMatchObject({
      leftRef: "~1",
      right: "theirs",
    });
    expect(changeOpenPlan(change("merge", ResourceStatus.DELETED_BY_THEM))).toMatchObject({
      leftRef: "~1",
      right: "ours",
    });
  });
});
