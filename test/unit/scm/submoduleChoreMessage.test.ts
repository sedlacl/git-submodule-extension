import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBMODULE_CHORE_SUBJECT,
  buildSubmoduleChoreMessage,
  shortSha,
} from "../../../src/scm/submoduleChoreMessage.js";
import type { SubmodulePointerUpdate } from "../../../src/scm/submoduleChoreTypes.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";

function update(overrides: Partial<SubmodulePointerUpdate> & Pick<SubmodulePointerUpdate, "path">): SubmodulePointerUpdate {
  return {
    beforeHead: SHA_A,
    afterHead: SHA_B,
    branch: "main",
    subjects: [],
    staged: true,
    ...overrides,
  };
}

describe("shortSha", () => {
  it("returns the first 8 characters", () => {
    expect(shortSha(SHA_A)).toBe("aaaaaaaa");
  });
});

describe("buildSubmoduleChoreMessage", () => {
  it("uses the default subject when none is provided", () => {
    const result = buildSubmoduleChoreMessage({ updates: [] });
    expect(result.subject).toBe(DEFAULT_SUBMODULE_CHORE_SUBJECT);
    expect(result.message).toBe(DEFAULT_SUBMODULE_CHORE_SUBJECT);
    expect(result.hasUnstagedUpdates).toBe(false);
  });

  it("formats a single staged submodule update with commit subjects", () => {
    const result = buildSubmoduleChoreMessage({
      updates: [
        update({
          path: "submodules/foo",
          subjects: ["first commit", "second commit"],
        }),
      ],
    });

    expect(result.message).toBe(
      [
        "chore: update submodules",
        "",
        "submodules/foo (aaaaaaaa -> bbbbbbbb, main)",
        "- first commit",
        "- second commit",
      ].join("\n"),
    );
    expect(result.hasUnstagedUpdates).toBe(false);
  });

  it("caps visible commit subjects at 30 and adds a remainder line", () => {
    const subjects = Array.from({ length: 35 }, (_, index) => `commit ${index + 1}`);
    const result = buildSubmoduleChoreMessage({
      updates: [update({ path: "submodules/foo", subjects })],
    });

    const lines = result.message.split("\n");
    expect(lines.filter((line) => line.startsWith("- commit"))).toHaveLength(30);
    expect(lines).toContain("- ... 5 more commits");
  });

  it("marks unstaged updates and sets the preview note", () => {
    const result = buildSubmoduleChoreMessage({
      updates: [
        update({
          path: "submodules/foo",
          afterHead: SHA_C,
          staged: false,
          subjects: ["pending change"],
        }),
      ],
    });

    expect(result.hasUnstagedUpdates).toBe(true);
    expect(result.unstagedNote).toMatch(/not staged/i);
    expect(result.message).toContain("submodules/foo (aaaaaaaa -> cccccccc, main) (not staged)");
    expect(result.message).toContain(result.unstagedNote!);
  });

  it("preserves deterministic update order from the input array", () => {
    const result = buildSubmoduleChoreMessage({
      updates: [
        update({ path: "submodules/a" }),
        update({ path: "submodules/b", beforeHead: SHA_B, afterHead: SHA_C }),
      ],
    });

    const aIndex = result.message.indexOf("submodules/a");
    const bIndex = result.message.indexOf("submodules/b");
    expect(aIndex).toBeGreaterThan(-1);
    expect(bIndex).toBeGreaterThan(aIndex);
  });

  it("allows a custom subject line for Quick Input wiring", () => {
    const result = buildSubmoduleChoreMessage({
      subject: "chore: bump deps",
      updates: [update({ path: "submodules/foo" })],
    });

    expect(result.subject).toBe("chore: bump deps");
    expect(result.message.startsWith("chore: bump deps\n")).toBe(true);
    expect(result.body.startsWith("\n\n")).toBe(true);
  });
});
