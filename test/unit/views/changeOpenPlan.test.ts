import { describe, expect, it } from "vitest";
import { ResourceStatus, type ResourceChange } from "../../../src/git/repositoryState.js";
import { changeOpenPlan } from "../../../src/views/changeOpenPlan.js";

function change(group: "merge" | "index" | "workingTree" | "untracked", status: number): Parameters<typeof changeOpenPlan>[0] {
  const resource: ResourceChange = {
    uri: "/ws/file.ts",
    originalUri: "/ws/file.ts",
    status: status as ResourceChange["status"],
    relativePath: "file.ts",
  };
  return { rootPath: "/ws", group, resource };
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

  it("diffs working-tree and untracked files as index (~) → working tree", () => {
    expect(changeOpenPlan(change("workingTree", ResourceStatus.MODIFIED))).toMatchObject({
      leftRef: "~",
      leftPath: "resource",
      right: "file",
    });
    expect(changeOpenPlan(change("untracked", ResourceStatus.UNTRACKED))).toMatchObject({
      leftRef: "~",
      leftPath: "resource",
      right: "file",
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
