export const RESTORE_SETTINGS = {
  enabled: "gitSubmodule.restore.enabled",
  debounceMs: "gitSubmodule.restore.debounceMs",
} as const;

export const RESTORE_DEFAULTS = {
  enabled: true,
  debounceMs: 250,
} as const;

export const RESTORE_COMMANDS = {
  retry: "gitSubmodule.retryRestore",
  fetch: "gitSubmodule.fetchRemote",
} as const;

export interface RestoreCommandContext {
  parentRootPath: string;
  relativePath: string;
  childRootPath: string;
  branch: string | null;
  pin: string | null;
}

export function fetchConfirmMessage(relativePath: string, branch: string): string {
  return (
    `Fetch origin/${branch} for '${relativePath}'? ` +
    "This contacts the configured remote and is never done automatically. " +
    "The extension will not pull, push, commit, or discard files."
  );
}

export function restoreOutputLine(result: {
  action: string;
  path: string;
  detail: string;
}): string {
  return `[${result.action}] ${result.path}: ${result.detail}`;
}
