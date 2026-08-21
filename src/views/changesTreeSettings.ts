import {
  CHANGE_GROUP_LABELS,
  CHANGE_GROUP_ORDER,
  ResourceStatus,
  type ChangeGroupKind,
  type ChangeGroupViewModel,
  type RepositoryChangeGroups,
  type RepositoryHead,
  type ResourceChange,
} from "../git/repositoryState.js";

/** Built-in `git.untrackedChanges` (microsoft/vscode Git, tag 1.96.0). */
export type UntrackedChangesMode = "mixed" | "separate" | "hidden";

/** Built-in `git.countBadge`. */
export type CountBadgeMode = "all" | "tracked" | "off";

/** Built-in `scm.defaultViewMode`. */
export type ScmViewMode = "list" | "tree";

export interface ChangesTreeSettings {
  readonly untrackedChanges: UntrackedChangesMode;
  readonly alwaysShowStagedChangesResourceGroup: boolean;
  readonly countBadge: CountBadgeMode;
  readonly openDiffOnClick: boolean;
  readonly showInlineOpenFileAction: boolean;
  readonly decorationsEnabled: boolean;
  readonly viewMode: ScmViewMode;
  readonly compactFolders: boolean;
}

export const DEFAULT_CHANGES_TREE_SETTINGS: ChangesTreeSettings = {
  untrackedChanges: "mixed",
  alwaysShowStagedChangesResourceGroup: false,
  countBadge: "all",
  openDiffOnClick: true,
  showInlineOpenFileAction: true,
  decorationsEnabled: true,
  viewMode: "list",
  compactFolders: true,
};

const UNTRACKED_OR_IGNORED = new Set<number>([ResourceStatus.UNTRACKED, ResourceStatus.IGNORED]);

export function emptyChangeGroups(): RepositoryChangeGroups {
  return { merge: [], index: [], workingTree: [], untracked: [] };
}

/**
 * Apply built-in `git.untrackedChanges` on top of a vscode.git snapshot.
 *
 * The public API already groups files on hosts that expose `untrackedChanges`.
 * On older hosts the adapter splits UNTRACKED/IGNORED out of `workingTree`.
 * Re-applying the setting here is idempotent for mixed/separate/hidden.
 *
 * Upstream: microsoft/vscode `extensions/git/src/repository.ts` tag 1.96.0
 * (`getStatus` cases `??` / `!!` and `hideWhenEmpty` on merge/index/untracked).
 */
export function applyUntrackedSettings(
  groups: RepositoryChangeGroups,
  mode: UntrackedChangesMode,
): RepositoryChangeGroups {
  if (mode === "mixed") {
    const workingHasUntracked = groups.workingTree.some((change) => UNTRACKED_OR_IGNORED.has(change.status));
    return {
      merge: groups.merge,
      index: groups.index,
      workingTree: workingHasUntracked ? groups.workingTree : [...groups.workingTree, ...groups.untracked],
      untracked: [],
    };
  }

  if (mode === "hidden") {
    return {
      merge: groups.merge,
      index: groups.index,
      workingTree: groups.workingTree.filter((change) => !UNTRACKED_OR_IGNORED.has(change.status)),
      untracked: [],
    };
  }

  const trackedWorking = groups.workingTree.filter((change) => !UNTRACKED_OR_IGNORED.has(change.status));
  const untrackedFromWorking = groups.workingTree.filter((change) => UNTRACKED_OR_IGNORED.has(change.status));
  return {
    merge: groups.merge,
    index: groups.index,
    workingTree: trackedWorking,
    untracked: groups.untracked.length > 0 ? groups.untracked : untrackedFromWorking,
  };
}

/**
 * Groups shown under a repository node, in built-in order.
 *
 * - Merge Changes: hide when empty (`hideWhenEmpty = true`)
 * - Staged Changes: hide when empty unless `git.alwaysShowStagedChangesResourceGroup`
 * - Changes: always shown (`workingTreeGroup.hideWhenEmpty` is left at the default `false`)
 * - Untracked Changes: hide when empty (`hideWhenEmpty = true`); only filled in `separate` mode
 */
export function visibleTreeGroups(
  groups: RepositoryChangeGroups,
  settings: ChangesTreeSettings,
): ChangeGroupViewModel[] {
  const applied = applyUntrackedSettings(groups, settings.untrackedChanges);
  const shown: ChangeGroupViewModel[] = [];
  for (const kind of CHANGE_GROUP_ORDER) {
    const resources = applied[kind];
    if (!shouldShowGroup(kind, resources.length, settings)) {
      continue;
    }
    shown.push({ kind, label: CHANGE_GROUP_LABELS[kind], resources });
  }
  return shown;
}

export function shouldShowGroup(
  kind: ChangeGroupKind,
  count: number,
  settings: ChangesTreeSettings,
): boolean {
  if (kind === "workingTree") {
    return true;
  }
  if (kind === "index") {
    return count > 0 || settings.alwaysShowStagedChangesResourceGroup;
  }
  return count > 0;
}

/** Compact branch label shown on the right side of a repository row. */
export function repositoryBranchDescription(
  head: RepositoryHead | undefined,
  groups: RepositoryChangeGroups,
): string {
  if (!head) {
    return "";
  }
  const name = head.detached ? shortCommit(head.commit) : (head.name ?? shortCommit(head.commit));
  if (!name) {
    return "";
  }
  const dirty =
    groups.workingTree.length + groups.untracked.length > 0
      ? "*"
      : "";
  return `${name}${dirty}`;
}

/**
 * Built-in `setCountBadge` over one repository's applied groups.
 * Upstream: `Repository.setCountBadge` in `extensions/git/src/repository.ts` tag 1.96.0.
 */
export function repositoryCountBadge(
  groups: RepositoryChangeGroups,
  settings: ChangesTreeSettings,
): number {
  const applied = applyUntrackedSettings(groups, settings.untrackedChanges);
  if (settings.countBadge === "off") {
    return 0;
  }
  let count = applied.merge.length + applied.index.length + applied.workingTree.length;
  if (settings.countBadge === "tracked" && settings.untrackedChanges === "mixed") {
    count -= applied.workingTree.filter((change) => UNTRACKED_OR_IGNORED.has(change.status)).length;
  }
  if (settings.countBadge === "all" && settings.untrackedChanges === "separate") {
    count += applied.untracked.length;
  }
  return count;
}

export function isUntrackedOrIgnored(change: ResourceChange): boolean {
  return UNTRACKED_OR_IGNORED.has(change.status);
}

function shortCommit(commit: string | undefined): string {
  return commit && commit.length >= 8 ? commit.slice(0, 8) : (commit ?? "");
}

export function readChangesTreeSettings(get: (section: string, key: string, fallback: unknown) => unknown): ChangesTreeSettings {
  return {
    untrackedChanges: readEnum(get("git", "untrackedChanges", DEFAULT_CHANGES_TREE_SETTINGS.untrackedChanges), [
      "mixed",
      "separate",
      "hidden",
    ], DEFAULT_CHANGES_TREE_SETTINGS.untrackedChanges),
    alwaysShowStagedChangesResourceGroup: Boolean(
      get("git", "alwaysShowStagedChangesResourceGroup", DEFAULT_CHANGES_TREE_SETTINGS.alwaysShowStagedChangesResourceGroup),
    ),
    countBadge: readEnum(get("git", "countBadge", DEFAULT_CHANGES_TREE_SETTINGS.countBadge), ["all", "tracked", "off"], DEFAULT_CHANGES_TREE_SETTINGS.countBadge),
    openDiffOnClick: Boolean(get("git", "openDiffOnClick", DEFAULT_CHANGES_TREE_SETTINGS.openDiffOnClick)),
    showInlineOpenFileAction: Boolean(
      get("git", "showInlineOpenFileAction", DEFAULT_CHANGES_TREE_SETTINGS.showInlineOpenFileAction),
    ),
    decorationsEnabled: Boolean(get("git", "decorations.enabled", DEFAULT_CHANGES_TREE_SETTINGS.decorationsEnabled)),
    viewMode: readEnum(get("scm", "defaultViewMode", DEFAULT_CHANGES_TREE_SETTINGS.viewMode), ["list", "tree"], DEFAULT_CHANGES_TREE_SETTINGS.viewMode),
    compactFolders: Boolean(get("scm", "compactFolders", DEFAULT_CHANGES_TREE_SETTINGS.compactFolders)),
  };
}

function readEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}
