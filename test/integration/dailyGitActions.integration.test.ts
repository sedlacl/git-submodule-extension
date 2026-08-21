import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { commitFile, initRepo, runGit } from "../../scripts/lib/git-fixture.js";
import { sameRepoPath } from "../../src/git/pathUtils.js";
import {
  ResourceStatus,
  type GitRepositoryOperations,
  type RepositoryStateSnapshot,
  type ResourceChange,
} from "../../src/git/repositoryState.js";
import {
  DailyGitActions,
  type DailyGitActionsUi,
  type DailyGitRepositoryHandle,
} from "../../src/scm/dailyGitActions.js";
import { SubmoduleChoreReadService } from "../../src/scm/submoduleChoreService.js";
import type { AdoptedTreeNode } from "../../src/views/adoptedViewModel.js";
import { buildAdoptedTree } from "../../src/views/adoptedViewModel.js";
import { createGitCli, createRestoreRepos, makeTempRoot, removeTempRoot, snapshotRepositoryFromGit } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeTempRoot(root);
  }
});

describe("DailyGitActions temporary repository fixture", () => {
  it("stages a parent/child multiselect in each owning repository only", async () => {
    const fixture = makeTempRoot("git-submodule-actions-");
    roots.push(fixture);
    const parentRoot = path.join(fixture, "parent");
    const childRoot = path.join(parentRoot, "modules", "child");

    initRepo(parentRoot, "main");
    commitFile(parentRoot, "parent.txt", "parent base\n", "parent init");
    initRepo(childRoot, "main");
    commitFile(childRoot, "child.txt", "child base\n", "child init");
    fs.writeFileSync(path.join(parentRoot, "parent.txt"), "parent changed\n");
    fs.writeFileSync(path.join(childRoot, "child.txt"), "child changed\n");

    const parentChange = change(parentRoot, "parent.txt");
    const childChange = change(childRoot, "child.txt");
    const parent = new GitBackedRepository(parentRoot);
    const child = new GitBackedRepository(childRoot);
    const actions = actionsFor([parent, child], NO_PROMPT_UI);

    await actions.stage([node(parentRoot, parentChange), node(childRoot, childChange)]);

    expect(runGit(parentRoot, ["diff", "--cached", "--name-only"]).trim()).toBe("parent.txt");
    expect(runGit(childRoot, ["diff", "--cached", "--name-only"]).trim()).toBe("child.txt");
  });

  it("stages folder and group resources into the correct repository", async () => {
    const fixture = makeTempRoot("git-submodule-folder-");
    roots.push(fixture);
    const root = path.join(fixture, "repo");
    initRepo(root, "main");
    commitFile(root, "src/a.ts", "a\n", "init a");
    commitFile(root, "src/b.ts", "b\n", "init b");
    fs.writeFileSync(path.join(root, "src/a.ts"), "a2\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "b2\n");

    const a = change(root, "src/a.ts");
    const b = change(root, "src/b.ts");
    const folder: AdoptedTreeNode = {
      id: `${root}:folder:src`,
      kind: "folder",
      repositoryRoot: root,
      changeGroup: "workingTree",
      label: "src",
      tooltip: "src",
      collapsible: true,
      expandByDefault: true,
      contextValue: "test.folder",
      iconId: "folder",
      children: [node(root, a), node(root, b)],
    };
    const repository = new GitBackedRepository(root);
    const actions = actionsFor([repository], NO_PROMPT_UI);

    await actions.stage([folder]);
    expect(runGit(root, ["diff", "--cached", "--name-only"]).replace(/\\/g, "/").trim().split(/\r?\n/)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("discards rename, delete, and untracked files only after confirmation", async () => {
    const fixture = makeTempRoot("git-submodule-discard-");
    roots.push(fixture);
    const root = path.join(fixture, "repo");
    initRepo(root, "main");
    commitFile(root, "old-name.ts", "keep\n", "init");
    commitFile(root, "gone.ts", "gone\n", "add gone");
    runGit(root, ["mv", "old-name.ts", "new-name.ts"]);
    runGit(root, ["restore", "--staged", "--", "old-name.ts", "new-name.ts"]);
    fs.unlinkSync(path.join(root, "gone.ts"));
    fs.writeFileSync(path.join(root, "scratch.ts"), "temp\n");

    const renamed = {
      ...change(root, "new-name.ts", ResourceStatus.INTENT_TO_RENAME),
      originalUri: path.join(root, "old-name.ts"),
      renameUri: path.join(root, "new-name.ts"),
    };
    const deleted = change(root, "gone.ts", ResourceStatus.DELETED);
    const untracked = change(root, "scratch.ts", ResourceStatus.UNTRACKED);
    const repository = new GitBackedRepository(root);
    const ui = new RecordingUi();
    const actions = actionsFor([repository], ui);

    await actions.discard([node(root, renamed, "workingTree")]);
    expect(fs.existsSync(path.join(root, "new-name.ts"))).toBe(true);
    expect(ui.confirmations[0]?.message).toContain("restore the original file name");
    expect(ui.confirmations[0]?.actions).toEqual(["Discard Changes"]);

    ui.nextConfirmation = "Restore file";
    await actions.discard([node(root, deleted, "workingTree")]);
    expect(fs.existsSync(path.join(root, "gone.ts"))).toBe(true);

    ui.nextConfirmation = "Delete file";
    await actions.discard([node(root, untracked, "untracked")]);
    expect(fs.existsSync(path.join(root, "scratch.ts"))).toBe(false);
  });

  it("requires confirmation before staging a conflict and then stages through the handle", async () => {
    const fixture = makeTempRoot("git-submodule-conflict-");
    roots.push(fixture);
    const root = path.join(fixture, "repo");
    initRepo(root, "main");
    commitFile(root, "conflict.ts", "base\n", "base");
    runGit(root, ["checkout", "-b", "other"]);
    commitFile(root, "conflict.ts", "theirs\n", "theirs");
    runGit(root, ["checkout", "main"]);
    commitFile(root, "conflict.ts", "ours\n", "ours");
    try {
      runGit(root, ["merge", "other"]);
    } catch {
      // Merge conflict is the setup.
    }

    const conflict = change(root, "conflict.ts", ResourceStatus.BOTH_MODIFIED);
    const repository = new GitBackedRepository(root);
    const ui = new RecordingUi();
    const actions = actionsFor([repository], ui);

    await actions.stage([node(root, conflict, "merge")]);
    expect(runGit(root, ["ls-files", "-u"]).trim().length).toBeGreaterThan(0);

    ui.nextConfirmation = "Yes";
    await actions.stage([node(root, conflict, "merge")]);
    expect(runGit(root, ["ls-files", "-u"]).trim()).toBe("");
    expect(runGit(root, ["diff", "--cached", "--name-only"]).trim()).toBe("conflict.ts");
    expect(ui.confirmations[0]?.message).toContain("merge conflicts");
  });

  it("commits staged files and smart-commits unstaged files only after confirmation", async () => {
    const fixture = makeTempRoot("git-submodule-commit-");
    roots.push(fixture);
    const root = path.join(fixture, "repo");
    initRepo(root, "main");
    commitFile(root, "a.ts", "a\n", "init");
    commitFile(root, "b.ts", "b\n", "add b");
    fs.writeFileSync(path.join(root, "a.ts"), "staged\n");
    runGit(root, ["add", "--", "a.ts"]);
    fs.writeFileSync(path.join(root, "b.ts"), "unstaged\n");

    const repository = new GitBackedRepository(root);
    const ui = new RecordingUi();
    ui.nextInput = "fix: staged only";
    const actions = actionsFor([repository], ui);
    await actions.commit(root);
    expect(runGit(root, ["log", "-1", "--format=%s"]).trim()).toBe("fix: staged only");
    expect(runGit(root, ["diff", "--name-only"]).trim()).toBe("b.ts");

    ui.nextConfirmation = "Yes";
    ui.nextInput = "fix: smart commit";
    await actions.commit(root);
    expect(runGit(root, ["log", "-1", "--format=%s"]).trim()).toBe("fix: smart commit");
    expect(runGit(root, ["status", "--porcelain"]).trim()).toBe("");
  });

  it("syncs and publishes through the public handle, never by spawning git directly", async () => {
    const fixture = makeTempRoot("git-submodule-sync-");
    roots.push(fixture);
    const root = path.join(fixture, "repo");
    initRepo(root, "main");
    commitFile(root, "a.ts", "a\n", "init");
    const repository = new GitBackedRepository(root, {
      head: {
        name: "main",
        detached: false,
        upstream: { remote: "origin", name: "main" },
        ahead: 1,
        behind: 0,
      },
      remotes: [{ name: "origin", pushUrl: "ssh://example/repo.git", isReadOnly: false }],
    });
    const ui = new RecordingUi();
    ui.nextConfirmation = "OK";
    const actions = actionsFor([repository], ui);

    await actions.sync(root);
    expect(repository.calls.map((call) => call.operation)).toEqual(["pull", "push"]);

    repository.overrideHead({ name: "main", detached: false });
    ui.nextRemote = "origin";
    await actions.publish(root);
    expect(repository.calls[2]).toEqual({ operation: "push", args: ["origin", "main", true, undefined] });
  });

  it("prepares a submodule chore message without staging or committing", async () => {
    const fixture = makeTempRoot("git-submodule-chore-");
    roots.push(fixture);
    const repos = createRestoreRepos(fixture);
    const childHead = runGit(repos.child, ["rev-parse", "HEAD"]).trim();
    commitFile(repos.child, "extra.txt", "pointer bump\n", "child bump");
    const after = runGit(repos.child, ["rev-parse", "HEAD"]).trim();
    runGit(repos.parent, ["update-index", "--cacheinfo", `160000,${after},${repos.childRel}`]);
    const beforeCommit = runGit(repos.parent, ["rev-parse", "HEAD"]).trim();

    const repository = new GitBackedRepository(repos.parent);
    const ui = new RecordingUi();
    ui.nextInput = "chore: update service pointers";
    const actions = new DailyGitActions(
      { getRepositoryHandle: (rootPath) => (sameRepoPath(rootPath, repos.parent) ? repository : undefined) },
      ui,
      new SubmoduleChoreReadService(createGitCli()),
    );

    await actions.prepareSubmoduleChore(repos.parent);
    expect(repository.inputBoxValue).toContain("chore: update service pointers");
    expect(repository.inputBoxValue).toContain(repos.childRel.replace(/\\/g, "/"));
    expect(runGit(repos.parent, ["rev-parse", "HEAD"]).trim()).toBe(beforeCommit);
    expect(repository.calls.filter((call) => call.operation === "commit")).toEqual([]);
    expect(childHead).not.toBe(after);
  });

  it("routes a mutation when the handle path and model path differ only by separators", async () => {
    const fixture = makeTempRoot("git-submodule-sep-");
    roots.push(fixture);
    const root = path.join(fixture, "repo");
    initRepo(root, "main");
    commitFile(root, "a.ts", "a\n", "init");
    fs.writeFileSync(path.join(root, "a.ts"), "changed\n");

    const handleRoot = root.replace(/\\/g, "/");
    const dirty = change(root, "a.ts");
    const repository = new GitBackedRepository(handleRoot);
    const actions = actionsFor([repository], NO_PROMPT_UI);
    await actions.stage([node(root, dirty)]);
    expect(runGit(root, ["diff", "--cached", "--name-only"]).trim()).toBe("a.ts");
  });

  it("puts rename, delete, untracked, and conflict into built-in groups on a temporary repo", async () => {
    const fixture = makeTempRoot("git-submodule-groups-");
    roots.push(fixture);
    const root = path.join(fixture, "repo");
    initRepo(root, "main");
    commitFile(root, "keep.ts", "keep\n", "init");
    commitFile(root, "old.ts", "old\n", "add old");
    commitFile(root, "gone.ts", "gone\n", "add gone");
    commitFile(root, "conflict.ts", "base\n", "conflict base");
    runGit(root, ["checkout", "-b", "other"]);
    commitFile(root, "conflict.ts", "theirs\n", "theirs");
    runGit(root, ["checkout", "main"]);
    commitFile(root, "conflict.ts", "ours\n", "ours");
    try {
      runGit(root, ["merge", "other"]);
    } catch {
      // Merge conflict is the setup.
    }
    runGit(root, ["mv", "old.ts", "renamed.ts"]);
    fs.unlinkSync(path.join(root, "gone.ts"));
    fs.writeFileSync(path.join(root, "fresh.ts"), "new\n");

    const snapshot = snapshotRepositoryFromGit(root);
    const tree = buildAdoptedTree(
      {
        roots: [
          {
            id: root,
            kind: "workspace-root",
            rootPath: root,
            workspaceFolderPath: root,
            displayName: "httpendpoint-like",
            children: [],
          },
        ],
      },
      [snapshot],
    );
    const repo = tree[0];
    expect(repo?.children.map((child) => child.label)).toEqual([
      "Merge Changes",
      "Staged Changes",
      "Changes",
    ]);
    expect(repo?.children.find((child) => child.label === "Merge Changes")?.children.map((child) => child.label)).toContain(
      "conflict.ts",
    );
    expect(repo?.children.find((child) => child.label === "Staged Changes")?.children.map((child) => child.label)).toContain(
      "renamed.ts",
    );
    const working = repo?.children.find((child) => child.label === "Changes")?.children.map((child) => child.label) ?? [];
    expect(working).toEqual(expect.arrayContaining(["gone.ts", "fresh.ts"]));
  });
});

class GitBackedRepository implements DailyGitRepositoryHandle {
  readonly calls: Array<{ operation: string; args: unknown[] }> = [];
  inputBoxValue = "";
  private headOverride: RepositoryStateSnapshot["head"] | undefined;
  private remotesOverride: RepositoryStateSnapshot["remotes"] | undefined;

  constructor(
    readonly rootPath: string,
    overrides: { head?: RepositoryStateSnapshot["head"]; remotes?: RepositoryStateSnapshot["remotes"] } = {},
  ) {
    this.headOverride = overrides.head;
    this.remotesOverride = overrides.remotes;
  }

  overrideHead(head: RepositoryStateSnapshot["head"]): void {
    this.headOverride = head;
  }

  snapshot(): RepositoryStateSnapshot {
    const current = snapshotRepositoryFromGit(this.rootPath);
    return {
      ...current,
      head: this.headOverride ?? current.head,
      remotes: this.remotesOverride ?? current.remotes,
    };
  }

  operations(): GitRepositoryOperations {
    return {
      add: async (paths) => {
        this.calls.push({ operation: "add", args: [paths] });
        runGit(this.rootPath, ["add", "--", ...relativize(this.rootPath, paths)]);
      },
      revert: async (paths) => {
        this.calls.push({ operation: "revert", args: [paths] });
        runGit(this.rootPath, ["restore", "--staged", "--", ...relativize(this.rootPath, paths)]);
      },
      clean: async (paths) => {
        this.calls.push({ operation: "clean", args: [paths] });
        const rels = relativize(this.rootPath, paths);
        try {
          runGit(this.rootPath, ["checkout", "--", ...rels]);
        } catch {
          // Deleted or untracked paths are cleaned below.
        }
        try {
          runGit(this.rootPath, ["clean", "-fd", "--", ...rels]);
        } catch {
          // Tracked restores already succeeded.
        }
      },
      commit: async (message, options) => {
        this.calls.push({ operation: "commit", args: [message, options] });
        if (options?.all) {
          runGit(this.rootPath, ["add", "-A"]);
        }
        runGit(this.rootPath, ["commit", "-m", message]);
      },
      status: async () => {
        this.calls.push({ operation: "status", args: [] });
      },
      fetch: async (options) => {
        this.calls.push({ operation: "fetch", args: [options] });
      },
      pull: async (unshallow) => {
        this.calls.push({ operation: "pull", args: [unshallow] });
      },
      push: async (remote, branch, setUpstream, force) => {
        this.calls.push({ operation: "push", args: [remote, branch, setUpstream, force] });
      },
    };
  }
}

class RecordingUi implements DailyGitActionsUi {
  confirmations: Array<{ message: string; actions: readonly string[] }> = [];
  nextConfirmation: string | undefined;
  nextInput: string | undefined;
  nextRemote: string | undefined;

  async confirm(message: string, actions: readonly string[]): Promise<string | undefined> {
    this.confirmations.push({ message, actions });
    return this.nextConfirmation;
  }

  async input(): Promise<string | undefined> {
    return this.nextInput;
  }

  async pickRemote(): Promise<string | undefined> {
    return this.nextRemote;
  }

  info(): void {}
}

function actionsFor(repositories: GitBackedRepository[], ui: DailyGitActionsUi): DailyGitActions {
  return new DailyGitActions(
    {
      getRepositoryHandle: (rootPath) =>
        repositories.find((repository) => sameRepoPath(repository.rootPath, rootPath)),
    },
    ui,
  );
}

function change(rootPath: string, relativePath: string, status: ResourceStatus = ResourceStatus.MODIFIED): ResourceChange {
  const uri = path.join(rootPath, relativePath);
  return {
    uri,
    originalUri: uri,
    relativePath: relativePath.replace(/\\/g, "/"),
    status,
  };
}

function node(
  rootPath: string,
  item: ResourceChange,
  group: "merge" | "index" | "workingTree" | "untracked" = "workingTree",
): AdoptedTreeNode {
  return {
    id: `${rootPath}:${item.relativePath}`,
    kind: "change",
    repositoryRoot: rootPath,
    changeGroup: group,
    label: item.relativePath,
    tooltip: item.relativePath,
    collapsible: false,
    expandByDefault: false,
    contextValue: "test.change",
    iconId: "file",
    change: { rootPath, group, resource: item },
    children: [],
  };
}

function relativize(rootPath: string, files: readonly string[]): string[] {
  return files.map((file) => path.relative(rootPath, file) || file);
}

const NO_PROMPT_UI: DailyGitActionsUi = {
  confirm: async () => undefined,
  input: async () => undefined,
  pickRemote: async () => undefined,
  info: () => undefined,
};
