export const VIEW_ID = "gitSubmodule.repos";

export const GIT_SHOW_SCHEME = "gitsubmodule";

export const COMMANDS = {
  refresh: "gitSubmodule.refresh",
  openDiff: "gitSubmodule.openDiff",
  openAllChanges: "gitSubmodule.openAllChanges",
  retryRestore: "gitSubmodule.retryRestore",
  fetchRemote: "gitSubmodule.fetchRemote",
} as const;

export const CONTEXT = {
  workspaceRoot: "gitSubmodule.workspaceRoot",
  submodule: "gitSubmodule.submodule",
  adoptedGroup: "gitSubmodule.adoptedGroup",
  staged: "gitSubmodule.staged",
  unstaged: "gitSubmodule.unstaged",
  file: "gitSubmodule.file",
  message: "gitSubmodule.message",
} as const;
