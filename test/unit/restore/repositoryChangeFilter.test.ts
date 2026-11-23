import { describe, expect, it } from "vitest";
import type { RepositoryStateSnapshot } from "../../../src/git/repositoryState.js";
import { RepositoryChangeFilter } from "../../../src/restore/repositoryChangeFilter.js";

function snapshot(commit: string, modified: string[] = []): RepositoryStateSnapshot {
  return {
    rootPath: "/repo",
    head: { name: undefined, commit, detached: true },
    remotes: [],
    groups: {
      merge: [],
      index: [],
      workingTree: modified.map((file) => ({ uri: file, originalUri: file, status: 5, relativePath: file })),
      untracked: [],
    },
  };
}

describe("RepositoryChangeFilter", () => {
  it("passes on only snapshots whose HEAD or changed files differ", () => {
    // vscode.git fires state.onDidChange after every status run; reacting to each one kept
    // restore running in a loop.
    const filter = new RepositoryChangeFilter();
    expect(filter.changed(snapshot("a"))).toBe(true);
    expect(filter.changed(snapshot("a"))).toBe(false);
    expect(filter.changed(snapshot("b"))).toBe(true);
    expect(filter.changed(snapshot("b", ["/repo/mod"]))).toBe(true);
    expect(filter.changed(snapshot("b", ["/repo/mod"]))).toBe(false);
    filter.forget("/repo");
    expect(filter.changed(snapshot("b", ["/repo/mod"]))).toBe(true);
  });
});
