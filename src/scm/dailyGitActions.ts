import * as path from "node:path";
import { sameRepoPath } from "../git/pathUtils.js";
import {
  ResourceStatus,
  isRenameChange,
  type GitRepositoryHandle,
  type GitRepositoryProvider,
  type RepositoryRemote,
  type ResourceChange,
} from "../git/repositoryState.js";
import { firstCommitLine, mergeCommitDraftWithChore } from "./generateCommitMessage.js";
import { buildSubmoduleChoreMessage } from "./submoduleChoreMessage.js";
import type { SubmoduleChoreReadService } from "./submoduleChoreTypes.js";
import type { AdoptedTreeNode, ChangeFileRef } from "../views/adoptedViewModel.js";

export type DailyGitRepositoryHandle = GitRepositoryHandle;
export type DailyGitRepositoryProvider = GitRepositoryProvider;

export interface DailyGitActionsUi {
  confirm(message: string, actions: readonly string[]): Promise<string | undefined>;
  input(options: { value: string; placeHolder: string; prompt: string }): Promise<string | undefined>;
  pickRemote(remotes: readonly { name: string; description?: string }[]): Promise<string | undefined>;
  pickBranch(
    branches: readonly { name: string; description?: string; current?: boolean }[],
  ): Promise<string | undefined>;
  info(message: string): void;
  generateCommitSubject?(rootPath: string): Promise<string | undefined>;
}

export class BusyRepositoryError extends Error {
  constructor(readonly rootPath: string) {
    super(`A Git operation is already running for ${rootPath}.`);
    this.name = "BusyRepositoryError";
  }
}

export function commitMessagePlaceholder(branchName: string | undefined): string {
  return branchName ? `Message (commit on "${branchName}")` : "Commit message";
}

const CONFLICT_STATUSES = new Set<ResourceStatus>([
  ResourceStatus.ADDED_BY_US,
  ResourceStatus.ADDED_BY_THEM,
  ResourceStatus.DELETED_BY_US,
  ResourceStatus.DELETED_BY_THEM,
  ResourceStatus.BOTH_ADDED,
  ResourceStatus.BOTH_DELETED,
  ResourceStatus.BOTH_MODIFIED,
]);

type MutationKind = "stage" | "unstage" | "discard";

/**
 * Repository-scoped daily Git operations. Every mutation is routed through a
 * public vscode.git repository handle; this layer never invokes Git commands.
 *
 * Behavioral reference: microsoft/vscode extensions/git/src/commands.ts,
 * tag 1.96.0 (stage, unstage, clean, smartCommit, sync, publish).
 */
export class DailyGitActions {
  private readonly busy = new Set<string>();
  private readonly preparedChoreMessages = new Map<string, string>();

  constructor(
    private readonly repositories: DailyGitRepositoryProvider,
    private readonly ui: DailyGitActionsUi,
    private readonly choreService?: SubmoduleChoreReadService,
  ) {}

  async stage(nodes: readonly AdoptedTreeNode[]): Promise<void> {
    const changes = actionChanges(nodes, new Set(["merge", "workingTree", "untracked"]));
    const conflicts = changes.filter((change) => CONFLICT_STATUSES.has(change.resource.status));
    if (conflicts.length > 0) {
      const message =
        conflicts.length === 1
          ? `Are you sure you want to stage ${path.basename(conflicts[0]!.resource.uri)} with merge conflicts?`
          : `Are you sure you want to stage ${conflicts.length} files with merge conflicts?`;
      if ((await this.ui.confirm(message, ["Yes"])) !== "Yes") {
        return;
      }
    }
    await this.mutate("stage", changes);
  }

  async unstage(nodes: readonly AdoptedTreeNode[]): Promise<void> {
    await this.mutate("unstage", actionChanges(nodes, new Set(["index"])));
  }

  async discard(nodes: readonly AdoptedTreeNode[]): Promise<void> {
    const changes = actionChanges(nodes, new Set(["workingTree", "untracked"]));
    if (changes.length === 0) {
      return;
    }
    const confirmation = discardConfirmation(changes.map((change) => change.resource));
    if ((await this.ui.confirm(confirmation.message, [confirmation.action])) !== confirmation.action) {
      return;
    }
    await this.mutate("discard", changes);
  }

  async refresh(rootPaths: readonly string[]): Promise<void> {
    const targets = unique(rootPaths).map((rootPath) => this.requireRepository(rootPath));
    await this.runBusy(targets, async (repository) => repository.operations().status());
  }

  async commit(rootPath: string): Promise<void> {
    const repository = this.requireRepository(rootPath);
    await this.runBusy([repository], async (target) => {
      const state = target.snapshot();
      const noStagedChanges = state.groups.index.length === 0;
      const unstagedCount = state.groups.workingTree.length + state.groups.untracked.length;

      if (noStagedChanges && state.groups.merge.length > 0) {
        this.ui.info("Resolve and stage merge conflicts before committing.");
        return;
      }

      let commitAll = false;
      if (noStagedChanges) {
        if (unstagedCount === 0) {
          this.ui.info("There are no changes to commit.");
          return;
        }
        const message =
          "There are no staged changes to commit.\n\nWould you like to stage all your changes and commit them directly?";
        if ((await this.ui.confirm(message, ["Yes"])) !== "Yes") {
          return;
        }
        commitAll = true;
      }

      const branch = state.head?.name;
      const draft = target.inputBoxValue;
      const message = draft.trim()
        ? draft
        : await this.ui.input({
            value: draft,
            placeHolder: commitMessagePlaceholder(branch),
            prompt: "Please provide a commit message",
          });
      if (!message?.trim()) {
        return;
      }

      target.inputBoxValue = message;
      if (this.preparedChoreMessages.has(rootPath)) {
        const confirmation = await this.ui.confirm(
          "Commit the prepared submodule chore message?",
          ["Commit"],
        );
        if (confirmation !== "Commit") {
          return;
        }
      }

      await target.operations().commit(message, commitAll ? { all: true } : undefined);
      target.inputBoxValue = "";
      this.preparedChoreMessages.delete(rootPath);
    });
  }

  async prepareSubmoduleChore(rootPath: string): Promise<void> {
    const repository = this.requireRepository(rootPath);
    await this.runBusy([repository], async (target) => {
      const existing = target.inputBoxValue;
      let aiSubject: string | undefined;
      if (!existing.trim() && this.ui.generateCommitSubject) {
        aiSubject = (await this.ui.generateCommitSubject(rootPath))?.trim() || undefined;
      }

      const preview = this.choreService ? await this.choreService.preview(rootPath) : null;
      if (preview) {
        const seed = existing.trim() ? existing : (aiSubject ?? "");
        const chore = buildSubmoduleChoreMessage({
          updates: preview.updates,
          subject: firstCommitLine(seed).trim() || preview.subject,
        });
        const message = mergeCommitDraftWithChore(seed, chore);
        target.inputBoxValue = message;
        this.preparedChoreMessages.set(rootPath, message);
        return;
      }

      if (aiSubject && !target.inputBoxValue.trim()) {
        target.inputBoxValue = aiSubject;
        return;
      }
      if (aiSubject || target.inputBoxValue.trim()) {
        return;
      }
      this.ui.info("No submodule pointer changes");
    });
  }

  async sync(rootPath: string): Promise<void> {
    const repository = this.requireRepository(rootPath);
    await this.runBusy([repository], async (target) => {
      const head = target.snapshot().head;
      if (!head?.upstream) {
        this.ui.info("The current branch has no upstream. Publish the branch first.");
        return;
      }

      const message = `This action will pull and push commits from and to "${head.upstream.remote}/${head.upstream.name}".`;
      if ((await this.ui.confirm(message, ["OK"])) !== "OK") {
        return;
      }

      await target.operations().pull();
      await target.operations().push(head.upstream.remote, head.upstream.name, false);
    });
  }

  async checkoutBranch(rootPath: string): Promise<void> {
    const repository = this.requireRepository(rootPath);
    await this.runBusy([repository], async (target) => {
      const current = target.snapshot().head?.name;
      const branches = await target.operations().getBranches();
      const selected = await this.ui.pickBranch(
        branches.map((branch) => ({
          name: branch.name,
          description: branch.commit?.slice(0, 8),
          current: branch.name === current,
        })),
      );
      if (!selected || selected === current) {
        return;
      }
      await target.operations().checkout(selected);
    });
  }

  async fetch(rootPath: string): Promise<void> {
    const repository = this.requireRepository(rootPath);
    await this.runBusy([repository], async (target) => {
      await target.operations().fetch();
    });
  }

  async pull(rootPath: string): Promise<void> {
    const repository = this.requireRepository(rootPath);
    await this.runBusy([repository], async (target) => {
      if (!target.snapshot().head?.upstream) {
        this.ui.info("The current branch has no upstream to pull from.");
        return;
      }
      await target.operations().pull();
    });
  }

  async publish(rootPath: string): Promise<void> {
    const repository = this.requireRepository(rootPath);
    await this.runBusy([repository], async (target) => {
      const state = target.snapshot();
      const branch = state.head?.name;
      if (!branch) {
        this.ui.info("Check out a branch before publishing.");
        return;
      }

      const remotes = writableRemotes(state.remotes);
      if (remotes.length === 0) {
        this.ui.info("Your repository has no writable remotes configured to publish to.");
        return;
      }

      const remote =
        remotes.length === 1
          ? remotes[0]!.name
          : await this.ui.pickRemote(
              remotes.map((item) => ({ name: item.name, description: item.pushUrl })),
            );
      if (!remote) {
        return;
      }
      await target.operations().push(remote, branch, true);
    });
  }

  private async mutate(kind: MutationKind, changes: readonly ChangeFileRef[]): Promise<void> {
    const grouped = groupChanges(changes);
    const repositories = [...grouped.keys()].map((rootPath) => this.requireRepository(rootPath));
    await this.runBusy(repositories, async (repository) => {
      const paths = changesForRepository(grouped, repository.rootPath).map((change) => change.resource.uri);
      const operations = repository.operations();
      switch (kind) {
        case "stage":
          await operations.add(paths);
          break;
        case "unstage":
          await operations.revert(paths);
          break;
        case "discard":
          await operations.clean(paths);
          break;
      }
    });
  }

  private requireRepository(rootPath: string): DailyGitRepositoryHandle {
    const repository = this.repositories.getRepositoryHandle(rootPath);
    if (!repository) {
      throw new Error(`Git repository is not open: ${rootPath}`);
    }
    return repository;
  }

  private async runBusy(
    repositories: readonly DailyGitRepositoryHandle[],
    operation: (repository: DailyGitRepositoryHandle) => Promise<void>,
  ): Promise<void> {
    if (repositories.length === 0) {
      return;
    }
    const roots = unique(repositories.map((repository) => repository.rootPath)).sort();
    const alreadyBusy = roots.find((rootPath) => this.busy.has(rootPath));
    if (alreadyBusy) {
      throw new BusyRepositoryError(alreadyBusy);
    }
    for (const rootPath of roots) {
      this.busy.add(rootPath);
    }
    try {
      for (const repository of repositories) {
        await operation(repository);
      }
    } finally {
      for (const rootPath of roots) {
        this.busy.delete(rootPath);
      }
    }
  }
}

function actionChanges(
  nodes: readonly AdoptedTreeNode[],
  allowedGroups: ReadonlySet<ChangeFileRef["group"]>,
): ChangeFileRef[] {
  const changes: ChangeFileRef[] = [];
  const seen = new Set<string>();
  for (const node of nodes) {
    const repositoryRoot = node.repositoryRoot;
    for (const change of collectNodeChanges(node)) {
      if ((repositoryRoot && change.rootPath !== repositoryRoot) || !allowedGroups.has(change.group)) {
        continue;
      }
      const key = `${change.rootPath}\0${change.group}\0${change.resource.uri}`;
      if (!seen.has(key)) {
        seen.add(key);
        changes.push(change);
      }
    }
  }
  return changes;
}

function collectNodeChanges(node: AdoptedTreeNode): ChangeFileRef[] {
  if (node.change) {
    return [node.change];
  }
  return node.children.flatMap(collectNodeChanges);
}

function groupChanges(changes: readonly ChangeFileRef[]): Map<string, ChangeFileRef[]> {
  const grouped = new Map<string, ChangeFileRef[]>();
  for (const change of changes) {
    const list = grouped.get(change.rootPath) ?? [];
    list.push(change);
    grouped.set(change.rootPath, list);
  }
  return grouped;
}

function changesForRepository(
  grouped: ReadonlyMap<string, ChangeFileRef[]>,
  rootPath: string,
): ChangeFileRef[] {
  const matched: ChangeFileRef[] = [];
  for (const [key, list] of grouped) {
    if (key === rootPath || sameRepoPath(key, rootPath)) {
      matched.push(...list);
    }
  }
  return matched;
}

function discardConfirmation(resources: readonly ResourceChange[]): { message: string; action: string } {
  const untracked = resources.filter(
    (resource) => resource.status === ResourceStatus.UNTRACKED || resource.status === ResourceStatus.IGNORED,
  );
  if (resources.length === 1) {
    const resource = resources[0]!;
    const name = path.basename(resource.uri);
    if (untracked.length === 1) {
      return {
        message: `Are you sure you want to DELETE ${name}?\nThis is IRREVERSIBLE!\nThis file will be FOREVER LOST if you proceed.`,
        action: "Delete file",
      };
    }
    if (resource.status === ResourceStatus.DELETED) {
      return { message: `Are you sure you want to restore ${name}?`, action: "Restore file" };
    }
    if (isRenameChange(resource)) {
      return {
        message: `Are you sure you want to discard changes in ${name}? This will restore the original file name.`,
        action: "Discard Changes",
      };
    }
    return { message: `Are you sure you want to discard changes in ${name}?`, action: "Discard Changes" };
  }

  let message = `Are you sure you want to discard changes in ${resources.length} files?`;
  if (untracked.length > 0) {
    message += `\n\nThis will DELETE ${untracked.length} untracked files!\nThis is IRREVERSIBLE!\nThese files will be FOREVER LOST.`;
  }
  return { message, action: "Discard Changes" };
}

function writableRemotes(remotes: readonly RepositoryRemote[]): RepositoryRemote[] {
  return remotes.filter((remote) => !remote.isReadOnly && Boolean(remote.pushUrl));
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
