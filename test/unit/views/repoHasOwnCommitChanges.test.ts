import { describe, expect, it } from "vitest";
import { repoHasOwnCommitChanges, type AdoptedTreeNode } from "../../../src/views/adoptedViewModel.js";

function node(partial: Partial<AdoptedTreeNode> & Pick<AdoptedTreeNode, "id" | "kind" | "label">): AdoptedTreeNode {
  return {
    tooltip: partial.label,
    collapsible: true,
    expandByDefault: false,
    contextValue: "test",
    iconId: "repo",
    children: [],
    ...partial,
  };
}

function group(kind: "merge" | "index" | "workingTree" | "untracked", files: number): AdoptedTreeNode {
  return node({
    id: `g:${kind}`,
    kind: "change-group",
    changeGroup: kind,
    label: kind,
    children: Array.from({ length: files }, (_, index) =>
      node({
        id: `f:${kind}:${index}`,
        kind: "change",
        label: `${kind}-${index}`,
        collapsible: false,
      }),
    ),
  });
}

describe("repoHasOwnCommitChanges", () => {
  it("is true only for a repo's own staged, unstaged, or untracked files", () => {
    expect(
      repoHasOwnCommitChanges(
        node({
          id: "root",
          kind: "workspace-root",
          label: "app",
          children: [group("workingTree", 1)],
        }),
      ),
    ).toBe(true);
    expect(
      repoHasOwnCommitChanges(
        node({
          id: "root",
          kind: "workspace-root",
          label: "app",
          children: [group("merge", 1)],
        }),
      ),
    ).toBe(false);
    expect(
      repoHasOwnCommitChanges(
        node({
          id: "root",
          kind: "workspace-root",
          label: "parent",
          children: [
            node({
              id: "child",
              kind: "submodule",
              label: "mod",
              children: [group("index", 1)],
            }),
          ],
        }),
      ),
    ).toBe(false);
  });
});
