import type { APIState } from "./git.js";

export interface GitApiReadiness {
  readonly state: APIState;
  readonly onDidChangeState: (listener: (state: APIState) => void) => { dispose(): void };
}

const GIT_API_TIMEOUT_MESSAGE = "Timed out waiting for vscode.git API initialization.";

/**
 * Resolves when `vscode.git` reports `initialized`.
 *
 * Subscribes before re-reading `state`, so an initialization that lands in
 * that gap is not missed. Omit `timeoutMs` to keep waiting: a large multi-root
 * workspace can stay uninitialized well past a short fixed limit.
 */
export function waitForGitApi(api: GitApiReadiness, timeoutMs?: number): Promise<void> {
  if (api.state === "initialized") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const handles: {
      timer?: ReturnType<typeof setTimeout>;
      subscription?: { dispose(): void };
    } = {};

    const finish = (settle: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (handles.timer !== undefined) {
        clearTimeout(handles.timer);
      }
      handles.subscription?.dispose();
      settle();
    };

    handles.subscription = api.onDidChangeState((state) => {
      if (state === "initialized") {
        finish(resolve);
      }
    });

    if (api.state === "initialized") {
      finish(resolve);
      return;
    }

    if (timeoutMs === undefined) {
      return;
    }

    handles.timer = setTimeout(() => {
      if (api.state === "initialized") {
        finish(resolve);
        return;
      }
      finish(() => reject(new Error(GIT_API_TIMEOUT_MESSAGE)));
    }, timeoutMs);
  });
}
