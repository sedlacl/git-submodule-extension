import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUBMODULE_CHORE_SUBJECT,
  buildDeterministicChoreSubject,
  buildSubmoduleChoreMessage,
  shortSha,
} from "../../../src/scm/submoduleChoreMessage.js";
import type { SubmoduleCommitEntry, SubmodulePointerUpdate } from "../../../src/scm/submoduleChoreTypes.js";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SHA_C = "cccccccccccccccccccccccccccccccccccccccc";
const SHA_D = "dddddddddddddddddddddddddddddddddddddddd";
const SHA_E = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

function commit(
  sha: string,
  subject: string,
  nestedUpdates: SubmodulePointerUpdate[] = [],
): SubmoduleCommitEntry {
  return { sha, subject, nestedUpdates };
}

function update(
  overrides: Partial<SubmodulePointerUpdate> & Pick<SubmodulePointerUpdate, "path">,
): SubmodulePointerUpdate {
  return {
    beforeHead: SHA_A,
    afterHead: SHA_B,
    branch: "main",
    commits: [],
    staged: true,
    ...overrides,
  };
}

describe("shortSha", () => {
  it("returns the first 8 characters", () => {
    expect(shortSha(SHA_A)).toBe("aaaaaaaa");
  });
});

describe("buildDeterministicChoreSubject", () => {
  it("builds a subject from the sole leaf commit and direct submodule name", () => {
    const nested = update({
      path: "submodules/parent/submodules/nested",
      beforeHead: SHA_C,
      afterHead: SHA_D,
      branch: "aflex/6.3-production",
      commits: [commit(SHA_D, "T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support")],
    });
    const updates = [
      update({
        path: "submodules/parent",
        beforeHead: SHA_A,
        afterHead: SHA_B,
        branch: "development/AFLEX",
        commits: [
          commit(SHA_B, "chore: update submodule nested to latest commit 9ee3d41", [nested]),
        ],
      }),
    ];

    expect(buildDeterministicChoreSubject(updates)).toBe(
      "chore: update parent: T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support",
    );
  });

  it("returns null when multiple leaf commits exist", () => {
    const updates = [
      update({
        path: "submodules/foo",
        commits: [
          commit(SHA_B, "first"),
          commit(SHA_C, "second"),
        ],
      }),
    ];
    expect(buildDeterministicChoreSubject(updates)).toBeNull();
  });
});

describe("buildSubmoduleChoreMessage", () => {
  it("uses the fallback subject when none is provided and leaves are ambiguous", () => {
    const result = buildSubmoduleChoreMessage({ updates: [] });
    expect(result.subject).toBe(DEFAULT_SUBMODULE_CHORE_SUBJECT);
    expect(result.message).toBe(DEFAULT_SUBMODULE_CHORE_SUBJECT);
  });

  it("formats nested submodule updates with short SHAs and indentation", () => {
    const nested = update({
      path: "submodules/usy_idsmari_commong01/submodules/uu_energygateway_datagatewayg01",
      beforeHead: SHA_C,
      afterHead: SHA_D,
      branch: "aflex/6.3-production",
      commits: [commit(SHA_D, "T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support")],
    });
    const result = buildSubmoduleChoreMessage({
      updates: [
        update({
          path: "submodules/usy_idsmari_commong01",
          beforeHead: SHA_A,
          afterHead: SHA_B,
          branch: "development/AFLEX",
          commits: [
            commit(SHA_B, "chore: update submodule uu_energygateway_datagatewayg01 to latest commit 9ee3d41", [nested]),
          ],
        }),
      ],
    });

    expect(result.subject).toBe(
      "chore: update usy_idsmari_commong01: T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support",
    );
    expect(result.message).toBe(
      [
        "chore: update usy_idsmari_commong01: T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support",
        "",
        "submodules/usy_idsmari_commong01 (aaaaaaaa -> bbbbbbbb, development/AFLEX)",
        "- bbbbbbbb chore: update submodule uu_energygateway_datagatewayg01 to latest commit 9ee3d41",
        "  - nested submodule submodules/usy_idsmari_commong01/submodules/uu_energygateway_datagatewayg01 (cccccccc -> dddddddd, aflex/6.3-production)",
        "    - dddddddd T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support",
      ].join("\n"),
    );
  });

  it("formats a single staged submodule update with short SHA commit subjects", () => {
    const result = buildSubmoduleChoreMessage({
      updates: [
        update({
          path: "submodules/foo",
          commits: [
            commit(SHA_B, "first commit"),
            commit(SHA_C, "second commit"),
          ],
        }),
      ],
    });

    expect(result.subject).toBe(DEFAULT_SUBMODULE_CHORE_SUBJECT);
    expect(result.message).toBe(
      [
        "chore: update submodules",
        "",
        "submodules/foo (aaaaaaaa -> bbbbbbbb, main)",
        "- bbbbbbbb first commit",
        "- cccccccc second commit",
      ].join("\n"),
    );
    expect(result.message).not.toMatch(/not staged/i);
    expect(result.message).not.toContain("Note:");
  });

  it("caps visible commit subjects at 30 and adds a remainder line", () => {
    const commits = Array.from({ length: 35 }, (_, index) =>
      commit(`${index.toString().padStart(40, "0")}`, `commit ${index + 1}`),
    );
    const result = buildSubmoduleChoreMessage({
      updates: [update({ path: "submodules/foo", commits })],
    });

    const lines = result.message.split("\n");
    expect(lines.filter((line) => /^- [0-9]{8} commit/.test(line))).toHaveLength(30);
    expect(lines).toContain("- ... 5 more commits");
  });

  it("omits staging notes for unstaged pointer updates", () => {
    const result = buildSubmoduleChoreMessage({
      updates: [
        update({
          path: "submodules/foo",
          afterHead: SHA_E,
          staged: false,
          commits: [commit(SHA_E, "pending change")],
        }),
      ],
    });

    expect(result.message).toContain("submodules/foo (aaaaaaaa -> eeeeeeee, main)");
    expect(result.message).toContain("- eeeeeeee pending change");
    expect(result.message).not.toMatch(/not staged/i);
    expect(result.message).not.toContain("Note:");
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
