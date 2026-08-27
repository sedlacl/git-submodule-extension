import { describe, expect, it } from "vitest";
import { buildSubmoduleChoreMessage } from "../../../src/scm/submoduleChoreMessage.js";
import {
  buildPublicGenerateCommitMessageCommandArgs,
  CURSOR_GENERATE_GIT_COMMIT_MESSAGE,
  firstCommitLine,
  generateCommitSubject,
  isPublicCommitMessageTargetSupported,
  mergeCommitDraftWithChore,
  pickPublicGenerateCommitMessageCommand,
  supportsUriCommitMessageTargeting,
} from "../../../src/scm/generateCommitMessage.js";

const chore = buildSubmoduleChoreMessage({
  updates: [
    {
      path: "submodule",
      beforeHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      afterHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      branch: "main",
      commits: [{ sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", subject: "feat: child", nestedUpdates: [] }],
      staged: true,
    },
  ],
});

const ROOT = "/ws/infra-deploy/submodules/usy_aflex_initdatag01#t1";

describe("generateCommitSubject", () => {
  it("returns the public provider and generated subject without exposing the draft elsewhere", async () => {
    let draft = "";
    const result = await generateCommitSubject(
      {
        listCommands: async () => ["git.generateCommitMessage"],
        executeCommand: async () => {
          draft = "secret generated subject\n\nsecret body";
        },
        supportsTarget: () => true,
        readDraft: () => draft,
      },
      ROOT,
    );

    expect(result).toEqual({
      result: "generated",
      command: "git.generateCommitMessage",
      subject: "secret generated subject",
    });
  });

  it("passes the root path to executeCommand for uri-targeted providers", async () => {
    let invokedRoot = "";
    await generateCommitSubject(
      {
        listCommands: async () => [CURSOR_GENERATE_GIT_COMMIT_MESSAGE],
        executeCommand: async (_command, rootPath) => {
          invokedRoot = rootPath;
        },
        supportsTarget: () => true,
        readDraft: () => "",
        waitForDraftChange: async () => "feat: delayed",
      },
      ROOT,
    );
    expect(invokedRoot).toBe(ROOT);
  });

  it("distinguishes unavailable, unsupported target, no result, cancelled, and failed paths", async () => {
    await expect(
      generateCommitSubject(
        {
          listCommands: async () => [],
          executeCommand: async () => undefined,
          supportsTarget: () => true,
          readDraft: () => "",
        },
        ROOT,
      ),
    ).resolves.toEqual({ result: "unavailable" });
    await expect(
      generateCommitSubject(
        {
          listCommands: async () => ["cursor.generateGitCommitMessage"],
          executeCommand: async () => undefined,
          supportsTarget: () => false,
          readDraft: () => "",
        },
        ROOT,
      ),
    ).resolves.toEqual({ result: "unsupported target", command: "cursor.generateGitCommitMessage" });
    await expect(
      generateCommitSubject(
        {
          listCommands: async () => ["git.generateCommitMessage"],
          executeCommand: async () => undefined,
          supportsTarget: () => true,
          readDraft: () => "",
        },
        ROOT,
      ),
    ).resolves.toEqual({ result: "no result", command: "git.generateCommitMessage" });
    const cancellation = new Error("cancelled");
    await expect(
      generateCommitSubject(
        {
          listCommands: async () => ["git.generateCommitMessage"],
          executeCommand: async () => {
            throw cancellation;
          },
          supportsTarget: () => true,
          readDraft: () => "",
          isCancellationError: (error) => error === cancellation,
        },
        ROOT,
      ),
    ).resolves.toEqual({ result: "cancelled", command: "git.generateCommitMessage" });
    const failure = new Error("provider unavailable");
    await expect(
      generateCommitSubject(
        {
          listCommands: async () => ["git.generateCommitMessage"],
          executeCommand: async () => {
            throw failure;
          },
          supportsTarget: () => true,
          readDraft: () => "",
        },
        ROOT,
      ),
    ).resolves.toEqual({ result: "failed", command: "git.generateCommitMessage", error: failure });
  });

  it("rejects an unsupported target before invoking or waiting for the side-effect command", async () => {
    let invoked = false;
    let waited = false;
    const result = await generateCommitSubject(
      {
        listCommands: async () => ["cursor.generateGitCommitMessage"],
        executeCommand: async () => {
          invoked = true;
        },
        supportsTarget: () => false,
        readDraft: () => "",
        waitForDraftChange: async () => {
          waited = true;
          return "";
        },
      },
      ROOT,
    );

    expect(result).toEqual({ result: "unsupported target", command: "cursor.generateGitCommitMessage" });
    expect(invoked).toBe(false);
    expect(waited).toBe(false);
  });

  it("observes an asynchronously side-effected target draft with a bounded waiter", async () => {
    let draft = "";
    const result = await generateCommitSubject(
      {
        listCommands: async () => ["cursor.generateGitCommitMessage"],
        executeCommand: async () => undefined,
        supportsTarget: () => true,
        readDraft: () => draft,
        waitForDraftChange: async () => {
          draft = "feat: delayed target draft";
          return draft;
        },
      },
      ROOT,
    );

    expect(result).toEqual({
      result: "generated",
      command: "cursor.generateGitCommitMessage",
      subject: "feat: delayed target draft",
    });
  });
});

describe("buildPublicGenerateCommitMessageCommandArgs", () => {
  it("passes a file Uri only for Cursor uri-targeted commands", () => {
    const fileUri = (value: string) => ({ scheme: "file", fsPath: value });
    expect(buildPublicGenerateCommitMessageCommandArgs(CURSOR_GENERATE_GIT_COMMIT_MESSAGE, ROOT, fileUri)).toEqual([
      { scheme: "file", fsPath: ROOT },
    ]);
    expect(buildPublicGenerateCommitMessageCommandArgs("git.generateCommitMessage", ROOT, fileUri)).toEqual([]);
  });
});

describe("supportsUriCommitMessageTargeting", () => {
  it("recognizes only the Cursor generate command", () => {
    expect(supportsUriCommitMessageTargeting(CURSOR_GENERATE_GIT_COMMIT_MESSAGE)).toBe(true);
    expect(supportsUriCommitMessageTargeting("git.generateCommitMessage")).toBe(false);
  });
});

describe("isPublicCommitMessageTargetSupported", () => {
  it("accepts the sole open repository for untargeted providers", () => {
    expect(isPublicCommitMessageTargetSupported([{ rootPath: "/ws/child" }], "/ws/child")).toBe(true);
    expect(isPublicCommitMessageTargetSupported([{ rootPath: "/ws/other" }], "/ws/child")).toBe(false);
  });

  it("accepts any open repository when Cursor uri targeting is selected", () => {
    expect(
      isPublicCommitMessageTargetSupported(
        [{ rootPath: "/ws/parent" }, { rootPath: "/ws/parent/child" }],
        "/ws/parent/child",
        CURSOR_GENERATE_GIT_COMMIT_MESSAGE,
      ),
    ).toBe(true);
    expect(
      isPublicCommitMessageTargetSupported(
        [{ rootPath: "/ws/parent" }, { rootPath: "/ws/parent/child" }],
        "/ws/parent/child",
      ),
    ).toBe(false);
  });
});

describe("pickPublicGenerateCommitMessageCommand", () => {
  it("prefers known public IDs and ignores extension-owned commands", () => {
    expect(
      pickPublicGenerateCommitMessageCommand([
        "git.generateCommitMessage",
        "cursor.generateGitCommitMessage",
      ]),
    ).toBe("cursor.generateGitCommitMessage");
    expect(pickPublicGenerateCommitMessageCommand(["git.generateCommitMessage"])).toBe("git.generateCommitMessage");
    expect(
      pickPublicGenerateCommitMessageCommand(["other.generateGitCommitMessage", "gitSubmodule.generateCommitMessage"]),
    ).toBeUndefined();
    expect(pickPublicGenerateCommitMessageCommand(["gitSubmodule.generateCommitMessage"])).toBeUndefined();
  });
});

describe("mergeCommitDraftWithChore", () => {
  it("keeps a user subject and appends the chore body", () => {
    const merged = mergeCommitDraftWithChore("feat: keep me\n\nnotes", chore);
    expect(firstCommitLine(merged)).toBe("feat: keep me");
    expect(merged).toContain("notes");
    expect(merged).toContain("- bbbbbbbb feat: child");
  });

  it("does not duplicate an already appended chore body", () => {
    const once = mergeCommitDraftWithChore("feat: keep me", chore);
    expect(mergeCommitDraftWithChore(once, chore)).toBe(once);
  });
});
