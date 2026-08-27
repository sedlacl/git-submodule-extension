import * as path from "node:path";
import {
  safeError,
  type ActionDetails,
  type ActionOutcome,
  type ActionRun,
} from "../actionDiagnostics.js";
import { normalizeRepoPath } from "../git/pathUtils.js";
import {
  ResourceStatus,
  isRenameChange,
  type GitRepositoryHandle,
  type GitRepositoryProvider,
  type RepositoryRemote,
  type ResourceChange,
} from "../git/repositoryState.js";
import {
  firstCommitLine,
  mergeCommitDraftWithChore,
  type GenerateCommitSubjectResult,
} from "./generateCommitMessage.js";
import { buildSubmoduleChoreMessage, needsAiSubjectForChore } from "./submoduleChoreMessage.js";
import type { SubmoduleChoreReadService } from "./submoduleChoreTypes.js";
import type { AdoptedTreeNode, ChangeFileRef } from "../views/adoptedViewModel.js";

export type DailyGitRepositoryHandle = GitRepositoryHandle;
export type DailyGitRepositoryProvider = GitRepositoryProvider;

export const SYNC_CONFIRM_OK = "OK";
export const SYNC_CONFIRM_NEVER_AGAIN = "OK, Don't Show Again";

export interface DailyGitActionsUi {
  confirm(message: string, actions: readonly string[]): Promise<string | undefined>;
  input(options: { value: string; placeHolder: string; prompt: string }): Promise<string | undefined>;
  pickRemote(remotes: readonly { name: string; description?: string }[]): Promise<string | undefined>;
  pickBranch(
    branches: readonly { name: string; description?: string; current?: boolean }[],
  ): Promise<string | undefined>;
  info(message: string): void;
  /** Built-in `git.confirmSync`. When true, Sync shows the pull/push warning. */
  gitConfirmSync(): boolean;
  /** Persist `git.confirmSync = false` (user/global), matching built-in "Don't Show Again". */
  disableGitConfirmSync(): Promise<void>;
  generateCommitSubject?(rootPath: string): Promise<GenerateCommitSubjectResult>;
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

  async stage(nodes: readonly AdoptedTreeNode[]): Promise<ActionOutcome> {
    const changes = actionChanges(nodes, new Set(["merge", "workingTree", "untracked"]));
    const conflicts = changes.filter((change) => CONFLICT_STATUSES.has(change.resource.status));
    if (conflicts.length > 0) {
      const message =
        conflicts.length === 1
          ? `Are you sure you want to stage ${path.basename(conflicts[0]!.resource.uri)} with merge conflicts?`
          : `Are you sure you want to stage ${conflicts.length} files with merge conflicts?`;
      if ((await this.ui.confirm(message, ["Yes"])) !== "Yes") {
        return cancelled("confirmation dismissed", { resources: changes.length });
      }
    }
    await this.mutate("stage", changes);
    return completed(changeDetails(changes));
  }

  async unstage(nodes: readonly AdoptedTreeNode[]): Promise<ActionOutcome> {
    const changes = actionChanges(nodes, new Set(["index"]));
    await this.mutate("unstage", changes);
    return completed(changeDetails(changes));
  }

  async discard(nodes: readonly AdoptedTreeNode[]): Promise<ActionOutcome> {
    const changes = actionChanges(nodes, new Set(["workingTree", "untracked"]));
    if (changes.length === 0) {
      return completed({ resources: 0 });
    }
    const confirmation = discardConfirmation(changes.map((change) => change.resource));
    if ((await this.ui.confirm(confirmation.message, [confirmation.action])) !== confirmation.action) {
      return cancelled("confirmation dismissed", { resources: changes.length });
    }
    await this.mutate("discard", changes);
    return completed(changeDetails(changes));
  }

  async refresh(rootPaths: readonly string[], action?: ActionRun): Promise<ActionOutcome> {
    const targets = unique(rootPaths).map((rootPath) => this.requireRepository(rootPath));
    await this.runBusy(targets, async (repository) => {
      const details = { repository: path.basename(repository.rootPath) };
      const startedAt = action?.beginPhase("repository.status", details);
      try {
        await repository.operations().status();
        if (startedAt !== undefined) {
          action?.phase("repository.status", startedAt, { ...details, outcome: "completed" });
        }
      } catch (error) {
        if (startedAt !== undefined) {
          action?.phase("repository.status", startedAt, {
            ...details,
            outcome: "failed",
            error: safeError(error),
          });
        }
        throw error;
      }
    });
    return completed({ repositories: targets.length });
  }

  async commit(rootPath: string): Promise<ActionOutcome> {
    const repository = this.requireRepository(rootPath);
    let outcome: ActionOutcome = completed();
    await this.runBusy([repository], async (target) => {
      const state = target.snapshot();
      const noStagedChanges = state.groups.index.length === 0;
      const unstagedCount = state.groups.workingTree.length + state.groups.untracked.length;
      const baseDetails = {
        staged: state.groups.index.length,
        unstaged: unstagedCount,
      };

      if (noStagedChanges && state.groups.merge.length > 0) {
        this.ui.info("Resolve and stage merge conflicts before committing.");
        outcome = cancelled("unresolved merge conflicts", { ...baseDetails, "smart commit": "no" });
        return;
      }

      let commitAll = false;
      if (noStagedChanges) {
        if (unstagedCount === 0) {
          this.ui.info("There are no changes to commit.");
          outcome = cancelled("no changes", { ...baseDetails, "smart commit": "no" });
          return;
        }
        const message =
          "There are no staged changes to commit.\n\nWould you like to stage all your changes and commit them directly?";
        if ((await this.ui.confirm(message, ["Yes"])) !== "Yes") {
          outcome = cancelled("smart commit dismissed", { ...baseDetails, "smart commit": "yes" });
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
        outcome = cancelled("empty message", { ...baseDetails, "smart commit": commitAll ? "yes" : "no" });
        return;
      }

      target.inputBoxValue = message;
      if (this.preparedChoreMessages.has(normalizeRepoPath(rootPath))) {
        const confirmation = await this.ui.confirm(
          "Commit the prepared submodule chore message?",
          ["Commit"],
        );
        if (confirmation !== "Commit") {
          outcome = cancelled("prepared chore dismissed", {
            ...baseDetails,
            "smart commit": commitAll ? "yes" : "no",
          });
          return;
        }
      }

      await target.operations().commit(message, commitAll ? { all: true } : undefined);
      target.inputBoxValue = "";
      this.preparedChoreMessages.delete(normalizeRepoPath(rootPath));
      outcome = completed({ ...baseDetails, "smart commit": commitAll ? "yes" : "no", branch });
    });
    return outcome;
  }

  async prepareSubmoduleChore(rootPath: string, action?: ActionRun): Promise<ActionOutcome> {
    const repository = this.requireRepository(rootPath);
    let outcome: ActionOutcome = completed();
    await this.runBusy([repository], async (target) => {
      const existing = target.inputBoxValue;
      let aiSubject: string | undefined;
      let aiResult: GenerateCommitSubjectResult = { result: "unavailable" };

      const choreStartedAt = action?.mark();
      const preview = this.choreService ? await this.choreService.preview(rootPath) : null;
      if (choreStartedAt !== undefined) {
        action?.phase("submodule chore preview", choreStartedAt, {
          "pointer updates": preview?.updates.length ?? 0,
          result: preview ? "generated" : "empty",
        });
      }

      if (
        !existing.trim()
        && this.ui.generateCommitSubject
        && (!preview || needsAiSubjectForChore(preview.updates))
      ) {
        const aiStartedAt = action?.mark();
        aiResult = await this.ui.generateCommitSubject(rootPath);
        aiSubject = aiResult.result === "generated" ? aiResult.subject.trim() || undefined : undefined;
        if (aiStartedAt !== undefined) {
          action?.phase("generate message AI", aiStartedAt, {
            provider: aiResult.command ?? "none",
            result: aiResult.result,
            error: aiResult.result === "failed" ? safeError(aiResult.error) : undefined,
          });
        }
      }

      if (preview) {
        const seed = existing.trim() ? existing : (aiSubject ?? "");
        const chore = buildSubmoduleChoreMessage({
          updates: preview.updates,
          subject: firstCommitLine(seed).trim() || preview.subject,
        });
        const message = mergeCommitDraftWithChore(seed, chore);
        target.inputBoxValue = message;
        this.preparedChoreMessages.set(normalizeRepoPath(rootPath), message);
        const merge = existing.trim()
          ? message === existing
            ? "unchanged"
            : "appended to existing draft"
          : aiSubject
            ? "AI subject + appended chore"
            : "replaced empty draft";
        outcome = completed({
          merge,
          "pointer updates": preview.updates.length,
          "draft changed": message !== existing,
        });
        return;
      }

      if (aiSubject && !target.inputBoxValue.trim()) {
        target.inputBoxValue = aiSubject;
        outcome = completed({ merge: "replaced empty draft", "pointer updates": 0, "draft changed": true });
        return;
      }
      if (aiSubject || target.inputBoxValue.trim()) {
        outcome = completed({
          merge: "unchanged",
          "pointer updates": 0,
          "draft changed": target.inputBoxValue !== existing,
        });
        return;
      }
      const details = {
        merge: "unchanged",
        "pointer updates": 0,
        "draft changed": false,
        "AI result": aiResult.result,
      };
      if (aiResult.result === "failed") {
        this.ui.info("No submodule pointer changes; AI commit message generation failed.");
        outcome = { result: "failed", error: aiResult.error, details };
      } else if (aiResult.result === "cancelled") {
        this.ui.info("No submodule pointer changes; AI commit message generation was cancelled.");
        outcome = cancelled("AI generation cancelled", details);
      } else if (aiResult.result === "unsupported target") {
        this.ui.info(
          "No submodule pointer changes. Cursor AI cannot safely target this repository from a multi-repository view. Use the sparkle in this repository's built-in Source Control input.",
        );
        outcome = unavailable("AI target unsupported", details);
      } else if (aiResult.result === "unavailable") {
        this.ui.info("No submodule pointer changes; no supported AI commit-message provider is available.");
        outcome = unavailable("AI provider unavailable", details);
      } else {
        this.ui.info("No submodule pointer changes; AI did not generate a commit message.");
        outcome = completed({ reason: "no changes", ...details });
      }
    });
    return outcome;
  }

  async sync(rootPath: string): Promise<ActionOutcome> {
    const repository = this.requireRepository(rootPath);
    let outcome: ActionOutcome = completed();
    await this.runBusy([repository], async (target) => {
      const head = target.snapshot().head;
      if (!head?.upstream) {
        this.ui.info("The current branch has no upstream. Publish the branch first.");
        outcome = cancelled("no upstream");
        return;
      }

      const remote = target.snapshot().remotes.find((entry) => entry.name === head.upstream!.remote);
      const shouldPrompt = !remote?.isReadOnly && this.ui.gitConfirmSync();
      if (shouldPrompt) {
        const message = `This action will pull and push commits from and to "${head.upstream.remote}/${head.upstream.name}".`;
        const pick = await this.ui.confirm(message, [SYNC_CONFIRM_OK, SYNC_CONFIRM_NEVER_AGAIN]);
        if (pick === SYNC_CONFIRM_NEVER_AGAIN) {
          await this.ui.disableGitConfirmSync();
        } else if (pick !== SYNC_CONFIRM_OK) {
          outcome = cancelled("confirmation dismissed", {
            branch: head.upstream.name,
            remote: head.upstream.remote,
          });
          return;
        }
      }

      await target.operations().pull();
      await target.operations().push(head.upstream.remote, head.upstream.name, false);
      outcome = completed({ branch: head.upstream.name, remote: head.upstream.remote });
    });
    return outcome;
  }

  async checkoutBranch(rootPath: string): Promise<ActionOutcome> {
    const repository = this.requireRepository(rootPath);
    let outcome: ActionOutcome = completed();
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
        outcome = cancelled(selected ? "branch unchanged" : "branch picker dismissed");
        return;
      }
      await target.operations().checkout(selected);
      outcome = completed({ branch: selected });
    });
    return outcome;
  }

  async fetch(rootPath: string): Promise<ActionOutcome> {
    const repository = this.requireRepository(rootPath);
    await this.runBusy([repository], async (target) => {
      await target.operations().fetch();
    });
    return completed();
  }

  async pull(rootPath: string): Promise<ActionOutcome> {
    const repository = this.requireRepository(rootPath);
    let outcome: ActionOutcome = completed();
    await this.runBusy([repository], async (target) => {
      const upstream = target.snapshot().head?.upstream;
      if (!upstream) {
        this.ui.info("The current branch has no upstream to pull from.");
        outcome = cancelled("no upstream");
        return;
      }
      await target.operations().pull();
      outcome = completed({ branch: upstream.name, remote: upstream.remote });
    });
    return outcome;
  }

  async publish(rootPath: string): Promise<ActionOutcome> {
    const repository = this.requireRepository(rootPath);
    let outcome: ActionOutcome = completed();
    await this.runBusy([repository], async (target) => {
      const state = target.snapshot();
      const branch = state.head?.name;
      if (!branch) {
        this.ui.info("Check out a branch before publishing.");
        outcome = cancelled("no branch");
        return;
      }

      const remotes = writableRemotes(state.remotes);
      if (remotes.length === 0) {
        this.ui.info("Your repository has no writable remotes configured to publish to.");
        outcome = cancelled("no writable remote", { branch });
        return;
      }

      const remote =
        remotes.length === 1
          ? remotes[0]!.name
          : await this.ui.pickRemote(
              remotes.map((item) => ({ name: item.name, description: item.pushUrl })),
            );
      if (!remote) {
        outcome = cancelled("remote picker dismissed", { branch });
        return;
      }
      await target.operations().push(remote, branch, true);
      outcome = completed({ branch, remote });
    });
    return outcome;
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
    const roots = unique(repositories.map((repository) => normalizeRepoPath(repository.rootPath))).sort();
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
      if ((repositoryRoot && normalizeRepoPath(change.rootPath) !== normalizeRepoPath(repositoryRoot)) || !allowedGroups.has(change.group)) {
        continue;
      }
      const key = `${normalizeRepoPath(change.rootPath)}\0${change.group}\0${change.resource.uri}`;
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
    const key = normalizeRepoPath(change.rootPath);
    const list = grouped.get(key) ?? [];
    list.push(change);
    grouped.set(key, list);
  }
  return grouped;
}

function changesForRepository(
  grouped: ReadonlyMap<string, ChangeFileRef[]>,
  rootPath: string,
): ChangeFileRef[] {
  return grouped.get(normalizeRepoPath(rootPath)) ?? [];
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
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = normalizeRepoPath(value);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(key);
  }
  return out;
}

function changeDetails(changes: readonly ChangeFileRef[]): ActionDetails {
  return {
    resources: changes.length,
    repositories: new Set(changes.map((change) => normalizeRepoPath(change.rootPath))).size,
  };
}

function completed(details?: ActionDetails): ActionOutcome {
  return { result: "completed", details };
}

function cancelled(reason: string, details?: ActionDetails): ActionOutcome {
  return { result: "cancelled", reason, details };
}

function unavailable(reason: string, details?: ActionDetails): ActionOutcome {
  return { result: "unavailable", reason, details };
}
