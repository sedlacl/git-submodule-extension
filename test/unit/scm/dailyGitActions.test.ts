import { describe, expect, it } from "vitest";
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
import type { SubmoduleChoreReadService } from "../../../src/scm/submoduleChoreTypes.js";
import type { AdoptedTreeNode } from "../../../src/views/adoptedViewModel.js";

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
  nextInput: string | undefined;
  nextRemote: string | undefined;

  async confirm(message: string, actions: readonly string[]): Promise<string | undefined> {
    this.confirmations.push({ message, actions });
    return this.nextConfirmation;
  }

  async input(options: { value: string; placeHolder: string; prompt: string }): Promise<string | undefined> {
    this.inputs.push(options);
    return this.nextInput;
  }

  async pickRemote(remotes: readonly { name: string; description?: string }[]): Promise<string | undefined> {
    return this.nextRemote ?? remotes[0]?.name;
  }

  info(message: string): void {
    this.infos.push(message);
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
  const byRoot = new Map(repositories.map((repository) => [repository.rootPath, repository]));
  return {
    ui,
    actions: new DailyGitActions(
      { getRepositoryHandle: (rootPath) => byRoot.get(rootPath) },
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

  it("syncs by public pull then push after confirmation", async () => {
    const root = "/ws/repo";
    const repository = new FakeRepository(root, snapshot(root));
    const ui = new FakeUi();
    ui.nextConfirmation = "OK";
    const { actions } = harness([repository], ui);

    await actions.sync(root);

    expect(repository.calls.map((call) => call.operation)).toEqual(["pull", "push"]);
    expect(repository.calls[1]?.args).toEqual(["origin", "main", false, undefined]);
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
    const ui = new FakeUi();
    ui.nextInput = "chore: update service pointers";
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
          subjects: ["feat: child"],
          staged: true,
        }],
        hasUnstagedUpdates: false,
        unstagedNote: null,
      }),
    };
    const { actions } = harness([repository], ui, chore);

    await actions.prepareSubmoduleChore(root);

    expect(repository.inputBoxValue).toContain("chore: update service pointers");
    expect(repository.inputBoxValue).toContain("- feat: child");
    expect(repository.calls).toEqual([]);

    ui.nextInput = repository.inputBoxValue;
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
});
