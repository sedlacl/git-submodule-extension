import { BUILTIN_COMMAND_TITLES } from "./builtinGitParity.js";
import { COMMANDS, CONTEXT } from "./constants.js";

export type UntrackedChangesMode = "mixed" | "separate" | "hidden";

export interface RowActionConfig {
  untrackedChanges: UntrackedChangesMode;
  showInlineOpenFileAction: boolean;
  openDiffOnClick: boolean;
}

export const DEFAULT_ROW_ACTION_CONFIG: RowActionConfig = {
  untrackedChanges: "mixed",
  showInlineOpenFileAction: true,
  openDiffOnClick: true,
};

export type RowActionGroup = "inline" | "context";

export interface RowAction {
  command: string;
  title: string;
  icon: string;
  group: RowActionGroup;
  order: number;
}

const REPO = /gitSubmodule\.(workspaceRoot|submodule)/;
const REPO_UPSTREAM = /gitSubmodule\.hasUpstream/;
const REPO_NO_UPSTREAM = /gitSubmodule\.noUpstream/;
const CHANGE_GROUP = /gitSubmodule\.(staged|unstaged|changeGroup|adoptedGroup)/;
const GITLINK_CHANGE = /gitSubmodule\.change\..*\.gitlink/;
const ANY_CHANGE = /gitSubmodule\.change\./;
const CHANGE_OR_FOLDER_UNSTAGE = /gitSubmodule\.(change|resourceFolder)\.index/;
const CHANGE_OR_FOLDER_STAGE = /gitSubmodule\.(change|resourceFolder)\.(merge|workingTree|untracked)/;
const CHANGE_OR_FOLDER_CLEAN = /gitSubmodule\.(change|resourceFolder)\.(workingTree|untracked)/;
const NAV_CHANGE = /gitSubmodule\.change\.(index|workingTree|untracked)/;
const RESTORE_BLOCKED = /restoreBlocked/;
const SUBMODULE = /gitSubmodule\.submodule/;

/** Row toolbar actions. Repo rows stay visible; files/folders/groups are hover-only in CSS. */
export function inlineActions(contextValue: string, config: RowActionConfig = DEFAULT_ROW_ACTION_CONFIG): RowAction[] {
  const actions: RowAction[] = [];
  const mixed = config.untrackedChanges === "mixed";

  if (REPO.test(contextValue)) {
    push(actions, COMMANDS.commit, BUILTIN_COMMAND_TITLES.commit, "check", "inline", 1);
    if (REPO_UPSTREAM.test(contextValue)) {
      push(actions, COMMANDS.sync, BUILTIN_COMMAND_TITLES.sync, "sync", "inline", 2);
    }
    if (REPO_NO_UPSTREAM.test(contextValue)) {
      push(actions, COMMANDS.publish, BUILTIN_COMMAND_TITLES.publish, "cloud-upload", "inline", 2);
    }
    push(actions, COMMANDS.refresh, BUILTIN_COMMAND_TITLES.refresh, "refresh", "inline", 3);
  }

  if (CHANGE_GROUP.test(contextValue)) {
    push(actions, COMMANDS.openAllChanges, BUILTIN_COMMAND_TITLES.openAllChanges, "diff-multiple", "inline", 1);
  }
  if (GITLINK_CHANGE.test(contextValue)) {
    push(actions, COMMANDS.openAllChanges, BUILTIN_COMMAND_TITLES.openAllChanges, "diff-multiple", "inline", 3);
  }

  if (ANY_CHANGE.test(contextValue) && config.showInlineOpenFileAction) {
    if (config.openDiffOnClick) {
      push(actions, COMMANDS.openFile, BUILTIN_COMMAND_TITLES.openFile, "go-to-file", "inline", 1);
    } else {
      push(actions, COMMANDS.openChange, BUILTIN_COMMAND_TITLES.openChange, "diff", "inline", 1);
    }
  }

  if (contextValue === CONTEXT.changeGroupMerge) {
    push(actions, COMMANDS.stageAllMerge, BUILTIN_COMMAND_TITLES.stageAllMerge, "add", "inline", 2);
  }
  if (contextValue === CONTEXT.changeGroupIndex) {
    push(actions, COMMANDS.unstageAll, BUILTIN_COMMAND_TITLES.unstageAll, "remove", "inline", 2);
  }
  if (contextValue === CONTEXT.changeGroupWorkingTree && mixed) {
    push(actions, COMMANDS.stageAll, BUILTIN_COMMAND_TITLES.stageAll, "add", "inline", 2);
    push(actions, COMMANDS.cleanAll, BUILTIN_COMMAND_TITLES.cleanAll, "discard", "inline", 2);
  }
  if (contextValue === CONTEXT.changeGroupWorkingTree && !mixed) {
    push(actions, COMMANDS.stageAllTracked, BUILTIN_COMMAND_TITLES.stageAllTracked, "add", "inline", 2);
    push(actions, COMMANDS.cleanAllTracked, BUILTIN_COMMAND_TITLES.cleanAllTracked, "discard", "inline", 2);
  }
  if (contextValue === CONTEXT.changeGroupUntracked) {
    push(actions, COMMANDS.stageAllUntracked, BUILTIN_COMMAND_TITLES.stageAllUntracked, "add", "inline", 2);
    push(actions, COMMANDS.cleanAllUntracked, BUILTIN_COMMAND_TITLES.cleanAllUntracked, "discard", "inline", 2);
  }

  if (CHANGE_OR_FOLDER_STAGE.test(contextValue)) {
    push(actions, COMMANDS.stage, BUILTIN_COMMAND_TITLES.stage, "add", "inline", 2);
  }
  if (CHANGE_OR_FOLDER_UNSTAGE.test(contextValue)) {
    push(actions, COMMANDS.unstage, BUILTIN_COMMAND_TITLES.unstage, "remove", "inline", 2);
  }
  if (CHANGE_OR_FOLDER_CLEAN.test(contextValue)) {
    push(actions, COMMANDS.clean, BUILTIN_COMMAND_TITLES.clean, "discard", "inline", 2);
  }

  if (SUBMODULE.test(contextValue)) {
    push(actions, COMMANDS.retryRestore, "Retry Branch Restore", "debug-restart", "inline", 4);
  }
  if (RESTORE_BLOCKED.test(contextValue)) {
    push(actions, COMMANDS.fetchRemote, "Fetch Submodule Remote", "cloud-download", "inline", 5);
  }

  return sortActions(actions);
}

/** Right-click / QuickPick actions for a tree row. Same slots as the former view/item/context groups. */
export function contextActions(contextValue: string, config: RowActionConfig = DEFAULT_ROW_ACTION_CONFIG): RowAction[] {
  const actions: RowAction[] = [];
  const mixed = config.untrackedChanges === "mixed";

  if (REPO.test(contextValue)) {
    push(actions, COMMANDS.checkoutBranch, "Checkout Branch...", "git-branch", "context", 1);
    push(actions, COMMANDS.fetch, "Fetch", "cloud-download", "context", 2);
    if (REPO_UPSTREAM.test(contextValue)) {
      push(actions, COMMANDS.pull, "Pull", "arrow-down", "context", 3);
    }
    push(actions, COMMANDS.generateSubmoduleChore, "Generate Submodule Chore", "sparkle", "context", 4);
    push(actions, COMMANDS.openAllChanges, BUILTIN_COMMAND_TITLES.openAllChanges, "diff-multiple", "context", 5);
  }

  if (contextValue === CONTEXT.changeGroupMerge) {
    push(actions, COMMANDS.stageAllMerge, BUILTIN_COMMAND_TITLES.stageAllMerge, "add", "context", 10);
  }
  if (contextValue === CONTEXT.changeGroupIndex) {
    push(actions, COMMANDS.unstageAll, BUILTIN_COMMAND_TITLES.unstageAll, "remove", "context", 10);
  }
  if (contextValue === CONTEXT.changeGroupWorkingTree && mixed) {
    push(actions, COMMANDS.stageAll, BUILTIN_COMMAND_TITLES.stageAll, "add", "context", 10);
    push(actions, COMMANDS.cleanAll, BUILTIN_COMMAND_TITLES.cleanAll, "discard", "context", 11);
  }
  if (contextValue === CONTEXT.changeGroupWorkingTree && !mixed) {
    push(actions, COMMANDS.stageAllTracked, BUILTIN_COMMAND_TITLES.stageAllTracked, "add", "context", 10);
    push(actions, COMMANDS.cleanAllTracked, BUILTIN_COMMAND_TITLES.cleanAllTracked, "discard", "context", 11);
  }
  if (contextValue === CONTEXT.changeGroupUntracked) {
    push(actions, COMMANDS.stageAllUntracked, BUILTIN_COMMAND_TITLES.stageAllUntracked, "add", "context", 10);
    push(actions, COMMANDS.cleanAllUntracked, BUILTIN_COMMAND_TITLES.cleanAllUntracked, "discard", "context", 11);
  }

  if (NAV_CHANGE.test(contextValue)) {
    push(actions, COMMANDS.openChange, BUILTIN_COMMAND_TITLES.openChange, "diff", "context", 20);
  }
  if (ANY_CHANGE.test(contextValue)) {
    push(actions, COMMANDS.openFile, BUILTIN_COMMAND_TITLES.openFile, "go-to-file", "context", 21);
  }
  if (NAV_CHANGE.test(contextValue)) {
    push(actions, COMMANDS.openHEADFile, BUILTIN_COMMAND_TITLES.openHEADFile, "file", "context", 22);
  }

  if (CHANGE_OR_FOLDER_STAGE.test(contextValue)) {
    push(actions, COMMANDS.stage, BUILTIN_COMMAND_TITLES.stage, "add", "context", 30);
  }
  if (CHANGE_OR_FOLDER_UNSTAGE.test(contextValue)) {
    push(actions, COMMANDS.unstage, BUILTIN_COMMAND_TITLES.unstage, "remove", "context", 30);
  }
  if (CHANGE_OR_FOLDER_CLEAN.test(contextValue)) {
    push(actions, COMMANDS.clean, BUILTIN_COMMAND_TITLES.clean, "discard", "context", 30);
  }

  return sortActions(actions);
}

export function rowActions(contextValue: string, config: RowActionConfig = DEFAULT_ROW_ACTION_CONFIG): RowAction[] {
  return [...inlineActions(contextValue, config), ...contextActions(contextValue, config)];
}

function push(
  actions: RowAction[],
  command: string,
  title: string,
  icon: string,
  group: RowActionGroup,
  order: number,
): void {
  if (actions.some((action) => action.command === command && action.group === group)) {
    return;
  }
  actions.push({ command, title, icon, group, order });
}

function sortActions(actions: RowAction[]): RowAction[] {
  return [...actions].sort((left, right) => left.order - right.order || left.command.localeCompare(right.command));
}
