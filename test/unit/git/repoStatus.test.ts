import { describe, expect, it } from "vitest";
import { classifyWorkingState, parsePorcelainV2 } from "../../../src/git/repoStatus.js";

describe("parsePorcelainV2", () => {
  it("reads branch, upstream, ahead/behind, and dirty entries", () => {
    const status = parsePorcelainV2(`# branch.oid aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
# branch.head development/AFLEX
# branch.upstream origin/development/AFLEX
# branch.ab +2 -1
1 .M N... 100644 100644 100644 sha sha README.md
`);

    expect(status).toEqual({
      oid: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      head: "development/AFLEX",
      upstream: "origin/development/AFLEX",
      ahead: 2,
      behind: 1,
      detached: false,
      dirty: true,
    });
  });

  it("detects detached HEAD and a clean tree", () => {
    const status = parsePorcelainV2(`# branch.oid bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
# branch.head (detached)
`);

    expect(status.detached).toBe(true);
    expect(status.head).toBeNull();
    expect(status.dirty).toBe(false);
    expect(status.oid).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});

describe("classifyWorkingState", () => {
  it("clears other flags for uninitialized checkouts", () => {
    expect(
      classifyWorkingState({
        uninitialized: true,
        detached: true,
        dirty: true,
        ahead: 3,
        behind: 1,
        pointerMismatch: true,
        operationInProgress: true,
      }),
    ).toEqual({
      uninitialized: true,
      dirty: false,
      detached: false,
      diverged: false,
      pointerMismatch: false,
      operationInProgress: false,
      probeFailed: false,
    });
  });

  it("marks diverged only when attached and ahead/behind is non-zero", () => {
    expect(
      classifyWorkingState({
        uninitialized: false,
        detached: false,
        dirty: false,
        ahead: 1,
        behind: 0,
        pointerMismatch: false,
        operationInProgress: false,
      }).diverged,
    ).toBe(true);

    expect(
      classifyWorkingState({
        uninitialized: false,
        detached: true,
        dirty: false,
        ahead: 1,
        behind: 0,
        pointerMismatch: true,
        operationInProgress: false,
      }),
    ).toMatchObject({ detached: true, diverged: false, pointerMismatch: true });
  });
});
