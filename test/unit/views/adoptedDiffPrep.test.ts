import { describe, expect, it } from "vitest";
import type { AdoptedFileDiff } from "../../../src/views/adoptedViewModel.js";
import { GIT_SHOW_SCHEME } from "../../../src/views/constants.js";
import {
  gitShowUriParts,
  openAllTitle,
  openPreparedChanges,
  parseGitShowUri,
  prepareFileDiff,
  prepareOpenAll,
} from "../../../src/views/adoptedDiffPrep.js";

const FROM = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TO = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function file(overrides: Partial<AdoptedFileDiff> & Pick<AdoptedFileDiff, "status" | "path">): AdoptedFileDiff {
  return {
    repoRoot: "/ws/http/httplib",
    kind: "unstaged",
    fromSha: FROM,
    toSha: TO,
    ...overrides,
  };
}

describe("prepareFileDiff", () => {
  it("uses an empty original side for added files and empty modified side for deletes", () => {
    const added = prepareFileDiff(file({ status: "added", path: "src/new.ts" }));
    expect(parseGitShowUri(added.original)).toMatchObject({ gitPath: "src/new.ts", sha: FROM, empty: true });
    expect(parseGitShowUri(added.modified)).toMatchObject({ gitPath: "src/new.ts", sha: TO, empty: false, status: "added" });

    const deleted = prepareFileDiff(file({ status: "deleted", path: "gone.md" }));
    expect(parseGitShowUri(deleted.original)).toMatchObject({ gitPath: "gone.md", sha: FROM, empty: false });
    expect(parseGitShowUri(deleted.modified)).toMatchObject({ gitPath: "gone.md", sha: TO, empty: true });
    expect(deleted.reveal).toEqual(deleted.original);
  });

  it("diffs rename and copy against the old path at the from SHA", () => {
    const renamed = prepareFileDiff(
      file({ status: "renamed", path: "new/name.ts", oldPath: "old/name.ts", similarity: 90 }),
    );
    expect(parseGitShowUri(renamed.original).gitPath).toBe("old/name.ts");
    expect(parseGitShowUri(renamed.modified).gitPath).toBe("new/name.ts");
    expect(renamed.title).toContain("old/name.ts → new/name.ts");
    expect(renamed.title).toContain("unstaged");

    const copied = prepareFileDiff(file({ status: "copied", path: "src/b.ts", oldPath: "src/a.ts" }));
    expect(parseGitShowUri(copied.original).gitPath).toBe("src/a.ts");
    expect(parseGitShowUri(copied.modified).gitPath).toBe("src/b.ts");
  });

  it("round-trips the custom git-show URI including Windows repo roots", () => {
    const parts = gitShowUriParts({
      repoRoot: "R:\\External\\repo",
      sha: FROM,
      gitPath: "submodules/foo#t1/README.md",
      status: "modified",
    });
    expect(parts.scheme).toBe(GIT_SHOW_SCHEME);
    expect(parseGitShowUri(parts)).toEqual({
      repoRoot: "R:\\External\\repo",
      sha: FROM,
      gitPath: "submodules/foo#t1/README.md",
      empty: false,
      status: "modified",
    });
  });
});

describe("openPreparedChanges", () => {
  it("opens vscode.changes with original/modified/reveal triples", async () => {
    const prepared = prepareOpenAll("Adopted Changes", [
      file({ status: "modified", path: "a.ts" }),
      file({ status: "added", path: "b.ts" }),
    ]);
    const calls: unknown[] = [];
    const result = await openPreparedChanges(
      prepared.title,
      prepared.files,
      (parts) => parts,
      async (command, ...args) => {
        calls.push([command, ...args]);
      },
      true,
    );

    expect(result).toBe("changes");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "vscode.changes",
      prepared.title,
      [
        [prepared.files[0]?.original, prepared.files[0]?.modified, prepared.files[0]?.reveal],
        [prepared.files[1]?.original, prepared.files[1]?.modified, prepared.files[1]?.reveal],
      ],
    ]);
    expect(openAllTitle("Unstaged", 2)).toBe("Unstaged (2 changes)");
  });

  it("falls back to sequential vscode.diff when vscode.changes is missing or throws", async () => {
    const prepared = prepareOpenAll("Staged", [
      file({ status: "modified", path: "a.ts" }),
      file({ status: "deleted", path: "b.ts" }),
    ]);

    const missing: unknown[] = [];
    await expect(
      openPreparedChanges(
        prepared.title,
        prepared.files,
        (parts) => parts.query,
        async (command, ...args) => {
          missing.push([command, ...args]);
        },
        false,
      ),
    ).resolves.toBe("diff-fallback");
    expect(missing.map((call) => (call as unknown[])[0])).toEqual(["vscode.diff", "vscode.diff"]);
    expect((missing[0] as unknown[])[3]).toBe(prepared.files[0]?.title);

    const failed: unknown[] = [];
    await expect(
      openPreparedChanges(
        prepared.title,
        prepared.files,
        (parts) => parts,
        async (command) => {
          failed.push(command);
          if (command === "vscode.changes") {
            throw new Error("command not found");
          }
        },
        true,
      ),
    ).resolves.toBe("diff-fallback");
    expect(failed).toEqual(["vscode.changes", "vscode.diff", "vscode.diff"]);
  });

  it("is a no-op when there are no file diffs", async () => {
    const calls: string[] = [];
    await expect(
      openPreparedChanges("Adopted Changes", [], (parts) => parts, async (command) => {
        calls.push(command);
      }, true),
    ).resolves.toBe("empty");
    expect(calls).toEqual([]);
  });
});
