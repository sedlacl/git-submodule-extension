import { describe, expect, it } from "vitest";
import { ActionDiagnostics, type ActionOutcome, type ActionRun } from "../../../src/actionDiagnostics.js";
import {
  ResourceStatus,
  type GitRepositoryOperations,
  type RepositoryStateSnapshot,
  type ResourceChange,
} from "../../../src/git/repositoryState.js";
import {
  BusyRepositoryError,
  DailyGitActions,
  type DailyGitActionsUi,
  type DailyGitRepositoryHandle,
} from "../../../src/scm/dailyGitActions.js";
import type { GenerateCommitSubjectResult } from "../../../src/scm/generateCommitMessage.js";
import type { SubmoduleChoreReadService } from "../../../src/scm/submoduleChoreTypes.js";
import type { AdoptedTreeNode } from "../../../src/views/adoptedViewModel.js";
import { sameRepoPath } from "../../../src/git/pathUtils.js";

function finish(action: ActionRun, outcome: ActionOutcome): void {
  if (outcome.result === "completed") {
    action.completed(outcome.details);
  } else if (outcome.result === "unavailable") {
    action.unavailable(outcome.reason ?? "unavailable", outcome.details);
  } else if (outcome.result === "cancelled") {
    action.cancelled(outcome.reason ?? "cancelled", outcome.details);
  } else {
    action.failed(outcome.error, outcome.details);
  }
}

interface Call {
  operation: string;
  args: unknown[];
}

function resource(rootPath: string, relativePath: string, status: ResourceStatus): ResourceChange {
  const uri = `${rootPath}/${relativePath}`;
  return { uri, originalUri: uri, status, relativePath };
}

function snapshot(
  rootPath: string,
  input: Partial<RepositoryStateSnapshot["groups"]> = {},
): RepositoryStateSnapshot {
  return {
    rootPath,
    head: {
      name: "main",
      commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      upstream: { remote: "origin", name: "main" },
      ahead: 1,
      behind: 1,
      detached: false,
    },
    remotes: [{ name: "origin", pushUrl: "ssh://example/repo.git", isReadOnly: false }],
    groups: {
      merge: input.merge ?? [],
      index: input.index ?? [],
      workingTree: input.workingTree ?? [],
      untracked: input.untracked ?? [],
    },
  };
}

class FakeRepository implements DailyGitRepositoryHandle {
  readonly calls: Call[] = [];
  inputBoxValue = "";
  private readonly ops: GitRepositoryOperations;

  constructor(
    readonly rootPath: string,
    private current: RepositoryStateSnapshot,
  ) {
    const record = async (operation: string, ...args: unknown[]): Promise<void> => {
      this.calls.push({ operation, args });
    };
    this.ops = {
      add: (paths) => record("add", paths),
      revert: (paths) => record("revert", paths),
      clean: (paths) => record("clean", paths),
      commit: (message, options) => record("commit", message, options),
      status: () => record("status"),
      getBranches: async () => [
        { name: "main", commit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
        { name: "feature/test", commit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
      ],
      checkout: (branchName) => record("checkout", branchName),
      fetch: (options) => record("fetch", options),
      pull: (unshallow) => record("pull", unshallow),
      push: (remote, branch, setUpstream, force) => record("push", remote, branch, setUpstream, force),
    };
  }

  snapshot(): RepositoryStateSnapshot {
    return this.current;
  }

  operations(): GitRepositoryOperations {
    return this.ops;
  }
}

class FakeUi implements DailyGitActionsUi {
  confirmations: Array<{ message: string; actions: readonly string[] }> = [];
  inputs: Array<{ value: string; placeHolder: string; prompt: string }> = [];
  infos: string[] = [];
  nextConfirmation: string | undefined;
  confirmSync = true;
  disableConfirmSyncCalls = 0;
  nextInput: string | undefined;
  nextRemote: string | undefined;
  nextBranch: string | undefined;
  nextGeneratedSubject: string | undefined;
  nextGenerateResult: GenerateCommitSubjectResult | undefined;
  generateCalls: string[] = [];

  async confirm(message: string, actions: readonly string[]): Promise<string | undefined> {
    this.confirmations.push({ message, actions });
    return this.nextConfirmation;
  }

  gitConfirmSync(): boolean {
    return this.confirmSync;
  }

  async disableGitConfirmSync(): Promise<void> {
    this.disableConfirmSyncCalls += 1;
    this.confirmSync = false;
  }

  async input(options: { value: string; placeHolder: string; prompt: string }): Promise<string | undefined> {
    this.inputs.push(options);
    return this.nextInput;
  }

  async pickRemote(remotes: readonly { name: string; description?: string }[]): Promise<string | undefined> {
    return this.nextRemote ?? remotes[0]?.name;
  }

  async pickBranch(
    branches: readonly { name: string; description?: string; current?: boolean }[],
  ): Promise<string | undefined> {
    return this.nextBranch ?? branches[0]?.name;
  }

  info(message: string): void {
    this.infos.push(message);
  }

  async generateCommitSubject(rootPath: string): Promise<GenerateCommitSubjectResult> {
    this.generateCalls.push(rootPath);
    if (this.nextGenerateResult) {
      return this.nextGenerateResult;
    }
    return this.nextGeneratedSubject
      ? { result: "generated", command: "git.generateCommitMessage", subject: this.nextGeneratedSubject }
      : { result: "unavailable" };
  }
}

function changeNode(rootPath: string, group: "merge" | "index" | "workingTree" | "untracked", item: ResourceChange): AdoptedTreeNode {
  return {
    id: `${rootPath}:${group}:${item.relativePath}`,
    kind: "change",
    label: item.relativePath,
    tooltip: item.relativePath,
    collapsible: false,
    expandByDefault: false,
    contextValue: `test.${group}`,
    iconId: "file",
    repositoryRoot: rootPath,
    changeGroup: group,
    change: { rootPath, group, resource: item },
    children: [],
  };
}

function containerNode(
  rootPath: string,
  kind: "workspace-root" | "submodule" | "change-group" | "folder",
  children: AdoptedTreeNode[],
  group?: "merge" | "index" | "workingTree" | "untracked",
): AdoptedTreeNode {
  return {
    id: `${kind}:${rootPath}:${group ?? ""}`,
    kind,
    label: kind,
    tooltip: kind,
    collapsible: true,
    expandByDefault: true,
    contextValue: `test.${kind}`,
    iconId: "folder",
    repositoryRoot: rootPath,
    changeGroup: group,
    children,
  };
}

function harness(repositories: FakeRepository[], ui = new FakeUi(), chore?: SubmoduleChoreReadService) {
  return {
    ui,
    actions: new DailyGitActions(
      {
        getRepositoryHandle: (rootPath) =>
          repositories.find((repository) => sameRepoPath(repository.rootPath, rootPath)),
      },
      ui,
      chore,
    ),
  };
}

describe("DailyGitActions mutations", () => {
  it("stages an item through the public repository operation", async () => {
    const root = "/ws/parent";
    const dirty = resource(root, "src/a.ts", ResourceStatus.MODIFIED);
    const repository = new FakeRepository(root, snapshot(root, { workingTree: [dirty] }));
    const { actions } = harness([repository]);

    await actions.stage([changeNode(root, "workingTree", dirty)]);

    expect(repository.calls).toEqual([{ operation: "add", args: [[dirty.uri]] }]);
  });

  it("stages folder and multiselect resources in their correct repositories", async () => {
    const parentRoot = "/ws/parent";
    const childRoot = "/ws/parent/sub";
    const parentChange = resource(parentRoot, "src/a.ts", ResourceStatus.MODIFIED);
    const childChange = resource(childRoot, "src/b.ts", ResourceStatus.UNTRACKED);
    const parent = new FakeRepository(parentRoot, snapshot(parentRoot, { workingTree: [parentChange] }));
    const child = new FakeRepository(childRoot, snapshot(childRoot, { untracked: [childChange] }));
    const folder = containerNode(parentRoot, "folder", [changeNode(parentRoot, "workingTree", parentChange)], "workingTree");
    const { actions } = harness([parent, child]);

    await actions.stage([folder, changeNode(childRoot, "untracked", childChange)]);

    expect(parent.calls[0]).toEqual({ operation: "add", args: [[parentChange.uri]] });
    expect(child.calls[0]).toEqual({ operation: "add", args: [[childChange.uri]] });
  });

  it("does not let repository all-actions leak into nested repositories", async () => {
    const parentRoot = "/ws/parent";
    const childRoot = "/ws/parent/sub";
    const parentChange = resource(parentRoot, "src/a.ts", ResourceStatus.MODIFIED);
    const childChange = resource(childRoot, "src/b.ts", ResourceStatus.MODIFIED);
    const parent = new FakeRepository(parentRoot, snapshot(parentRoot, { workingTree: [parentChange] }));
    const child = new FakeRepository(childRoot, snapshot(childRoot, { workingTree: [childChange] }));
    const parentNode = containerNode(parentRoot, "workspace-root", [
      containerNode(parentRoot, "change-group", [changeNode(parentRoot, "workingTree", parentChange)], "workingTree"),
      containerNode(childRoot, "submodule", [
        containerNode(childRoot, "change-group", [changeNode(childRoot, "workingTree", childChange)], "workingTree"),
      ]),
    ]);
    const { actions } = harness([parent, child]);

    await actions.stage([parentNode]);

    expect(parent.calls).toEqual([{ operation: "add", args: [[parentChange.uri]] }]);
    expect(child.calls).toEqual([]);
  });

  it("unstages index resources through revert", async () => {
    const root = "/ws/repo";
    const staged = resource(root, "a.ts", ResourceStatus.INDEX_MODIFIED);
    const repository = new FakeRepository(root, snapshot(root, { index: [staged] }));
    const { actions } = harness([repository]);

    await actions.unstage([changeNode(root, "index", staged)]);

    expect(repository.calls).toEqual([{ operation: "revert", args: [[staged.uri]] }]);
  });

  it("requires merge-conflict confirmation before staging", async () => {
    const root = "/ws/repo";
    const conflict = resource(root, "conflict.ts", ResourceStatus.BOTH_MODIFIED);
    const repository = new FakeRepository(root, snapshot(root, { merge: [conflict] }));
    const ui = new FakeUi();
    const { actions } = harness([repository], ui);

    await actions.stage([changeNode(root, "merge", conflict)]);
    expect(repository.calls).toEqual([]);
    expect(ui.confirmations[0]?.message).toContain("merge conflicts");

    ui.nextConfirmation = "Yes";
    await actions.stage([changeNode(root, "merge", conflict)]);
    expect(repository.calls).toEqual([{ operation: "add", args: [[conflict.uri]] }]);
  });

  it("describes and confirms untracked deletion before clean", async () => {
    const root = "/ws/repo";
    const untracked = resource(root, "new.ts", ResourceStatus.UNTRACKED);
    const repository = new FakeRepository(root, snapshot(root, { untracked: [untracked] }));
    const ui = new FakeUi();
    const { actions } = harness([repository], ui);

    await actions.discard([changeNode(root, "untracked", untracked)]);
    expect(repository.calls).toEqual([]);
    expect(ui.confirmations[0]?.message).toContain("DELETE new.ts");
    expect(ui.confirmations[0]?.message).toContain("IRREVERSIBLE");

    ui.nextConfirmation = "Delete file";
    await actions.discard([changeNode(root, "untracked", untracked)]);
    expect(repository.calls).toEqual([{ operation: "clean", args: [[untracked.uri]] }]);
  });

  it("uses restore wording for deleted files and identifies renames", async () => {
    const root = "/ws/repo";
    const deleted = resource(root, "gone.ts", ResourceStatus.DELETED);
    const renamed = {
      ...resource(root, "new-name.ts", ResourceStatus.INTENT_TO_RENAME),
      originalUri: `${root}/old-name.ts`,
      renameUri: `${root}/new-name.ts`,
    };
    const repository = new FakeRepository(root, snapshot(root, { workingTree: [deleted, renamed] }));
    const ui = new FakeUi();
    const { actions } = harness([repository], ui);

    await actions.discard([changeNode(root, "workingTree", deleted)]);
    expect(ui.confirmations[0]).toMatchObject({ actions: ["Restore file"] });
    expect(ui.confirmations[0]?.message).toContain("restore gone.ts");

    await actions.discard([changeNode(root, "workingTree", renamed)]);
    expect(ui.confirmations[1]?.message).toContain("restore the original file name");
  });

  it("rejects concurrent mutations for the same repository", async () => {
    const root = "/ws/repo";
    const dirty = resource(root, "a.ts", ResourceStatus.MODIFIED);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const repository = new FakeRepository(root, snapshot(root, { workingTree: [dirty] }));
    repository.operations().add = async () => pending;
    const { actions } = harness([repository]);
    const first = actions.stage([changeNode(root, "workingTree", dirty)]);

    await expect(actions.stage([changeNode(root, "workingTree", dirty)])).rejects.toBeInstanceOf(BusyRepositoryError);
    release();
    await first;
  });
});

describe("DailyGitActions repository commands", () => {
  it("refreshes only the targeted repository", async () => {
    const first = new FakeRepository("/ws/one", snapshot("/ws/one"));
    const second = new FakeRepository("/ws/two", snapshot("/ws/two"));
    const { actions } = harness([first, second]);

    await actions.refresh(["/ws/two"]);

    expect(first.calls).toEqual([]);
    expect(second.calls).toEqual([{ operation: "status", args: [] }]);
  });

  it("logs the targeted repository.status phase with an explicit outcome", async () => {
    const repository = new FakeRepository("/ws/target", snapshot("/ws/target"));
    const { actions } = harness([repository]);
    const lines: string[] = [];
    const diagnostics = new ActionDiagnostics((line) => lines.push(line), () => 10);
    const action = diagnostics.start("refresh", { repository: "target" });

    const outcome = await actions.refresh(["/ws/target"], action);
    action.completed(outcome.details);

    expect(lines).toEqual([
      "[action #1] refresh started (repository: target)",
      "[action #1] repository.status started (repository: target)",
      "[action #1] repository.status 0ms (repository: target; outcome: completed)",
      "[action #1] refresh completed 0ms (repositories: 1)",
    ]);
    expect(repository.calls).toEqual([{ operation: "status", args: [] }]);
  });

  it("checks out the branch selected from the repository branch picker", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextBranch = "feature/test";
    const { actions } = harness([repository], ui);

    await actions.checkoutBranch(root);

    expect(repository.calls).toEqual([{ operation: "checkout", args: ["feature/test"] }]);
  });

  it("fetches and pulls the targeted repository independently", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const { actions } = harness([repository]);

    await actions.fetch(root);
    await actions.pull(root);

    expect(repository.calls.map((call) => call.operation)).toEqual(["fetch", "pull"]);
  });

  it("prompts before smart-commit and commits all only after confirmation", async () => {
    const root = "/ws/repo";
    const dirty = resource(root, "a.ts", ResourceStatus.MODIFIED);
    const repository = new FakeRepository(root, snapshot(root, { workingTree: [dirty] }));
    const ui = new FakeUi();
    ui.nextConfirmation = "Yes";
    ui.nextInput = "fix: safe commit";
    const { actions } = harness([repository], ui);

    await actions.commit(root);

    expect(ui.confirmations[0]?.message).toContain("no staged changes");
    expect(repository.calls).toEqual([
      { operation: "commit", args: ["fix: safe commit", { all: true }] },
    ]);
  });

  it("commits staged changes without staging anything else", async () => {
    const root = "/ws/repo";
    const staged = resource(root, "a.ts", ResourceStatus.INDEX_MODIFIED);
    const dirty = resource(root, "b.ts", ResourceStatus.MODIFIED);
    const repository = new FakeRepository(root, snapshot(root, { index: [staged], workingTree: [dirty] }));
    const ui = new FakeUi();
    ui.nextInput = "fix: staged only";
    const { actions } = harness([repository], ui);

    await actions.commit(root);

    expect(repository.calls).toEqual([
      { operation: "commit", args: ["fix: staged only", undefined] },
    ]);
  });

  it("commits a non-empty input-box draft without prompting", async () => {
    const root = "/ws/repo";
    const staged = resource(root, "a.ts", ResourceStatus.INDEX_MODIFIED);
    const repository = new FakeRepository(root, snapshot(root, { index: [staged] }));
    repository.inputBoxValue = "feat: from draft";
    const ui = new FakeUi();
    const { actions } = harness([repository], ui);

    await actions.commit(root);

    expect(ui.inputs).toEqual([]);
    expect(repository.calls).toEqual([{ operation: "commit", args: ["feat: from draft", undefined] }]);
    expect(repository.inputBoxValue).toBe("");
  });

  it("syncs by public pull then push after confirmation", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextConfirmation = "OK";
    const { actions } = harness([repository], ui);

    await actions.sync(root);

    expect(ui.confirmations).toEqual([
      {
        message: 'This action will pull and push commits from and to "origin/main".',
        actions: ["OK", "OK, Don't Show Again"],
      },
    ]);
    expect(repository.calls.map((call) => call.operation)).toEqual(["pull", "push"]);
    expect(repository.calls[1]?.args).toEqual(["origin", "main", false, undefined]);
  });

  it("skips the Sync confirmation when git.confirmSync is false", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.confirmSync = false;
    const { actions } = harness([repository], ui);

    await actions.sync(root);

    expect(ui.confirmations).toEqual([]);
    expect(repository.calls.map((call) => call.operation)).toEqual(["pull", "push"]);
  });

  it("writes git.confirmSync false after OK, Don't Show Again then syncs", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextConfirmation = "OK, Don't Show Again";
    const { actions } = harness([repository], ui);

    await actions.sync(root);

    expect(ui.disableConfirmSyncCalls).toBe(1);
    expect(ui.confirmSync).toBe(false);
    expect(repository.calls.map((call) => call.operation)).toEqual(["pull", "push"]);
  });

  it("skips the Sync confirmation for a read-only remote", async () => {
    const root = "/ws/repo";
    const state = snapshot(root);
    const repository = new FakeRepository(root, {
      ...state,
      remotes: [{ name: "origin", isReadOnly: true }],
    });
    const ui = new FakeUi();
    const { actions } = harness([repository], ui);

    await actions.sync(root);

    expect(ui.confirmations).toEqual([]);
    expect(repository.calls.map((call) => call.operation)).toEqual(["pull", "push"]);
  });

  it("publishes the current branch with upstream through the selected writable remote", async () => {
    const root = "/ws/repo";
    const state = snapshot(root);
    const repository = new FakeRepository(root, {
      ...state,
      head: { ...state.head!, upstream: undefined },
      remotes: [
        { name: "readonly", pushUrl: "ssh://example/readonly.git", isReadOnly: true },
        { name: "fork", pushUrl: "ssh://example/fork.git", isReadOnly: false },
      ],
    });
    const ui = new FakeUi();
    ui.nextRemote = "fork";
    const { actions } = harness([repository], ui);

    await actions.publish(root);

    expect(repository.calls).toEqual([
      { operation: "push", args: ["fork", "main", true, undefined] },
    ]);
  });

  it("prepares a message-only submodule chore and confirms it at commit time", async () => {
    const root = "/ws/repo";
    const staged = resource(root, "submodule", ResourceStatus.INDEX_MODIFIED);
    const repository = new FakeRepository(root, snapshot(root, { index: [staged] }));
    repository.inputBoxValue = "chore: update service pointers";
    const ui = new FakeUi();
    const chore: SubmoduleChoreReadService = {
      preview: async () => ({
        subject: "chore: update submodules",
        body: "\n\nsubmodule (aaaaaaaa -> bbbbbbbb, main)\n- feat: child",
        message: "chore: update submodules\n\nsubmodule (aaaaaaaa -> bbbbbbbb, main)\n- feat: child",
        updates: [{
          path: "submodule",
          beforeHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          afterHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          branch: "main",
          commits: [{
            sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            subject: "feat: child",
            nestedUpdates: [],
          }],
          staged: true,
        }],
      }),
    };
    const { actions } = harness([repository], ui, chore);

    await actions.prepareSubmoduleChore(root);

    expect(ui.inputs).toEqual([]);
    expect(ui.generateCalls).toEqual([]);
    expect(repository.inputBoxValue).toContain("chore: update service pointers");
    expect(repository.inputBoxValue).toContain("- bbbbbbbb feat: child");
    expect(repository.calls).toEqual([]);

    ui.nextConfirmation = undefined;
    await actions.commit(root);
    expect(repository.calls).toEqual([]);

    const preparedMessage = repository.inputBoxValue;
    ui.nextConfirmation = "Commit";
    await actions.commit(root);
    expect(repository.calls[0]).toMatchObject({
      operation: "commit",
      args: [preparedMessage, undefined],
    });
    expect(repository.inputBoxValue).toBe("");
  });

  it("uses a public generate subject then appends the chore body", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextGeneratedSubject = "feat: from copilot";
    const chore: SubmoduleChoreReadService = {
      preview: async () => ({
        subject: "chore: update submodules",
        body: "\n\nsubmodule (aaaaaaaa -> bbbbbbbb, main)\n- bbbbbbbb feat: child\n- cccccccc fix: follow-up",
        message: "chore: update submodules\n\nsubmodule (aaaaaaaa -> bbbbbbbb, main)\n- bbbbbbbb feat: child\n- cccccccc fix: follow-up",
        updates: [{
          path: "submodule",
          beforeHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          afterHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          branch: "main",
          commits: [
            { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", subject: "feat: child", nestedUpdates: [] },
            { sha: "cccccccccccccccccccccccccccccccccccccccc", subject: "fix: follow-up", nestedUpdates: [] },
          ],
          staged: true,
        }],
      }),
    };
    const { actions } = harness([repository], ui, chore);

    await actions.prepareSubmoduleChore(root);

    expect(ui.generateCalls).toEqual([root]);
    expect(repository.inputBoxValue.startsWith("feat: from copilot")).toBe(true);
    expect(repository.inputBoxValue).toContain("- bbbbbbbb feat: child");
    expect(ui.infos).toEqual([]);
  });

  it("reports when sparkle has no public AI command and no pointer diffs", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    const chore: SubmoduleChoreReadService = { preview: async () => null };
    const { actions } = harness([repository], ui, chore);

    const outcome = await actions.prepareSubmoduleChore(root);

    expect(ui.generateCalls).toEqual([root]);
    expect(repository.inputBoxValue).toBe("");
    expect(outcome).toMatchObject({ result: "unavailable", reason: "AI provider unavailable" });
    expect(ui.infos).toEqual([
      "No submodule pointer changes; no supported AI commit-message provider is available.",
    ]);
  });

  it("reports an unsupported ordinary child target as unavailable, never cancelled", async () => {
    const root = "/ws/infra-deploy/submodules/usy_aflex_initdatag01#t1";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextGenerateResult = {
      result: "unsupported target",
      command: "cursor.generateGitCommitMessage",
    };
    const { actions } = harness([repository], ui, { preview: async () => null });
    const lines: string[] = [];
    const action = new ActionDiagnostics((line) => lines.push(line), () => 10).start(
      "generate message",
      { repository: "usy_aflex_initdatag01#t1" },
    );

    const outcome = await actions.prepareSubmoduleChore(root, action);
    finish(action, outcome);

    expect(outcome).toMatchObject({ result: "unavailable", reason: "AI target unsupported" });
    expect(ui.infos).toEqual([
      "No submodule pointer changes. Cursor AI cannot safely target this repository from a multi-repository view. Use the sparkle in this repository's built-in Source Control input.",
    ]);
    expect(lines).toEqual([
      "[action #1] generate message started (repository: usy_aflex_initdatag01#t1)",
      "[action #1] submodule chore preview 0ms (pointer updates: 0; result: empty)",
      "[action #1] generate message AI 0ms (provider: cursor.generateGitCommitMessage; result: unsupported target)",
      "[action #1] generate message unavailable 0ms (reason: AI target unsupported; merge: unchanged; pointer updates: 0; draft changed: false; AI result: unsupported target)",
    ]);
    expect(lines.join("\n")).not.toContain("cancelled");
  });

  it("uses a chore fallback when AI cannot target the clicked repository", async () => {
    const root = "/ws/infra-deploy";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextGenerateResult = {
      result: "unsupported target",
      command: "cursor.generateGitCommitMessage",
    };
    const relativePath = "submodules/usy_aflex_initdatag01#t1";
    const chore: SubmoduleChoreReadService = {
      preview: async () => ({
        subject: "chore: update submodules",
        body: `\n\n${relativePath} (aaaaaaaa -> bbbbbbbb, feature/t1-deployment)`,
        message: `chore: update submodules\n\n${relativePath} (aaaaaaaa -> bbbbbbbb, feature/t1-deployment)`,
        updates: [{
          path: relativePath,
          beforeHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          afterHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          branch: "feature/t1-deployment",
          commits: [],
          staged: false,
        }],
      }),
    };
    const { actions } = harness([repository], ui, chore);
    const lines: string[] = [];
    const action = new ActionDiagnostics((line) => lines.push(line), () => 10).start(
      "generate message",
      { repository: "infra-deploy" },
    );

    const outcome = await actions.prepareSubmoduleChore(root, action);
    finish(action, outcome);

    expect(outcome).toMatchObject({
      result: "completed",
      details: { merge: "replaced empty draft", "pointer updates": 1, "draft changed": true },
    });
    expect(repository.inputBoxValue).toContain(relativePath);
    expect(lines).toEqual([
      "[action #1] generate message started (repository: infra-deploy)",
      "[action #1] submodule chore preview 0ms (pointer updates: 1; result: generated)",
      "[action #1] generate message AI 0ms (provider: cursor.generateGitCommitMessage; result: unsupported target)",
      "[action #1] generate message completed 0ms (merge: replaced empty draft; pointer updates: 1; draft changed: true)",
    ]);
  });

  it("treats a void provider result as no result, not cancellation", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextGenerateResult = { result: "no result", command: "cursor.generateGitCommitMessage" };
    const { actions } = harness([repository], ui, { preview: async () => null });

    const outcome = await actions.prepareSubmoduleChore(root);

    expect(outcome).toMatchObject({
      result: "completed",
      details: { reason: "no changes", "AI result": "no result", "draft changed": false },
    });
    expect(ui.infos).toEqual(["No submodule pointer changes; AI did not generate a commit message."]);
  });

  it("keeps a public AI subject when there are no pointer diffs", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextGeneratedSubject = "feat: only ai";
    const chore: SubmoduleChoreReadService = { preview: async () => null };
    const { actions } = harness([repository], ui, chore);

    await actions.prepareSubmoduleChore(root);

    expect(repository.inputBoxValue).toBe("feat: only ai");
    expect(ui.infos).toEqual([]);
  });

  it("stages through a handle whose rootPath separators differ from the tree node", async () => {
    const modelRoot = process.cwd();
    const handleRoot = modelRoot.replace(/\\/g, "/");
    const dirty = resource(modelRoot, "src/a.ts", ResourceStatus.MODIFIED);
    const repository = new FakeRepository(handleRoot, snapshot(handleRoot, { workingTree: [dirty] }));
    const { actions } = harness([repository]);

    await actions.stage([changeNode(modelRoot, "workingTree", dirty)]);

    expect(repository.calls).toEqual([{ operation: "add", args: [[dirty.uri]] }]);
  });

  it("logs AI and chore phases plus merge outcome without generated message content", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextGeneratedSubject = "secret generated subject";
    const chore: SubmoduleChoreReadService = {
      preview: async () => ({
        subject: "secret chore subject",
        body: "\n\nsubmodule (aaaaaaaa -> bbbbbbbb, main)\n- secret child subject",
        message: "secret chore subject\n\nsecret child subject",
        updates: [{
          path: "submodule",
          beforeHead: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          afterHead: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          branch: "main",
          commits: [
            { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", subject: "secret child subject", nestedUpdates: [] },
            { sha: "cccccccccccccccccccccccccccccccccccccccc", subject: "another secret subject", nestedUpdates: [] },
          ],
          staged: true,
        }],
      }),
    };
    const lines: string[] = [];
    const diagnostics = new ActionDiagnostics((line) => lines.push(line), () => 10);
    const action = diagnostics.start("generate message", { repository: "repo" });
    const { actions } = harness([repository], ui, chore);

    finish(action, await actions.prepareSubmoduleChore(root, action));

    expect(lines).toEqual([
      "[action #1] generate message started (repository: repo)",
      "[action #1] submodule chore preview 0ms (pointer updates: 1; result: generated)",
      "[action #1] generate message AI 0ms (provider: git.generateCommitMessage; result: generated)",
      "[action #1] generate message completed 0ms (merge: AI subject + appended chore; pointer updates: 1; draft changed: true)",
    ]);
    expect(lines.join("\n")).not.toContain("secret generated subject");
    expect(lines.join("\n")).not.toContain("secret chore subject");
    expect(lines.join("\n")).not.toContain("secret child subject");
  });

  it("returns representative stage, commit, and sync diagnostics", async () => {
    const root = "/ws/repo";
    const staged = resource(root, "staged.ts", ResourceStatus.INDEX_MODIFIED);
    const dirty = resource(root, "dirty.ts", ResourceStatus.MODIFIED);
    const repository = new FakeRepository(root, snapshot(root, { index: [staged], workingTree: [dirty] }));
    const ui = new FakeUi();
    ui.nextConfirmation = "OK";
    const { actions } = harness([repository], ui);
    const lines: string[] = [];
    let now = 0;
    const diagnostics = new ActionDiagnostics((line) => lines.push(line), () => now);

    let action = diagnostics.start("stage");
    now = 4;
    finish(action, await actions.stage([changeNode(root, "workingTree", dirty)]));
    action = diagnostics.start("commit");
    now = 9;
    finish(action, await actions.commit(root));
    action = diagnostics.start("sync");
    now = 15;
    finish(action, await actions.sync(root));

    expect(lines).toContain("[action #1] stage completed 4ms (resources: 1; repositories: 1)");
    expect(lines).toContain(
      "[action #2] commit cancelled 5ms (reason: empty message; staged: 1; unstaged: 1; smart commit: no)",
    );
    expect(lines).toContain("[action #3] sync completed 6ms (branch: main; remote: origin)");
  });
});
