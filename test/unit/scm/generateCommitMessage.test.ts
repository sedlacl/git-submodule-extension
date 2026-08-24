import { describe, expect, it } from "vitest";
import { buildSubmoduleChoreMessage } from "../../../src/scm/submoduleChoreMessage.js";
import {
  firstCommitLine,
  mergeCommitDraftWithChore,
  pickPublicGenerateCommitMessageCommand,
} from "../../../src/scm/generateCommitMessage.js";

const chore = buildSubmoduleChoreMessage({
  updates: [
    {
      path: "submodule",
      beforeHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      afterHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      branch: "main",
      subjects: ["feat: child"],
      staged: true,
    },
  ],
});

describe("pickPublicGenerateCommitMessageCommand", () => {
  it("prefers known public IDs and ignores extension-owned commands", () => {
    expect(pickPublicGenerateCommitMessageCommand(["git.generateCommitMessage"])).toBe("git.generateCommitMessage");
    expect(
      pickPublicGenerateCommitMessageCommand(["other.generateGitCommitMessage", "gitSubmodule.generateCommitMessage"]),
    ).toBe("other.generateGitCommitMessage");
    expect(pickPublicGenerateCommitMessageCommand(["gitSubmodule.generateCommitMessage"])).toBeUndefined();
  });
});

describe("mergeCommitDraftWithChore", () => {
  it("keeps a user subject and appends the chore body", () => {
    const merged = mergeCommitDraftWithChore("feat: keep me\n\nnotes", chore);
    expect(firstCommitLine(merged)).toBe("feat: keep me");
    expect(merged).toContain("notes");
    expect(merged).toContain("- feat: child");
  });

  it("does not duplicate an already appended chore body", () => {
    const once = mergeCommitDraftWithChore("feat: keep me", chore);
    expect(mergeCommitDraftWithChore(once, chore)).toBe(once);
  });
});
