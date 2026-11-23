import * as vscode from "vscode";
import type { ActionWriter } from "../actionDiagnostics.js";
import type { GitCli } from "../git/gitCli.js";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import { AutoFetcher, type AutoFetchSettings } from "./autoFetcher.js";

export const AUTOFETCH_SETTINGS = {
  enabled: "autofetch.enabled",
  periodSeconds: "autofetch.periodSeconds",
  startupDelaySeconds: "autofetch.startupDelaySeconds",
} as const;

export const AUTOFETCH_DEFAULTS = {
  enabled: false,
  periodSeconds: 180,
  startupDelaySeconds: 120,
} as const;

export interface RegisterAutoFetchOptions {
  cli: GitCli;
  gitApi: VsCodeGitApiAdapter;
  writeDiagnostic: ActionWriter;
  /** Passes start only after `vscode.git` has opened the workspace repositories. */
  gitReady: Promise<void>;
  onFetched?(rootPath: string): void;
}

export function registerAutoFetch(options: RegisterAutoFetchOptions): vscode.Disposable {
  const fetcher = new AutoFetcher({
    cli: options.cli,
    settings: readSettings,
    repositories: () =>
      options.gitApi
        .snapshotAll()
        .filter((snapshot) => snapshot.remotes.length > 0)
        .map((snapshot) => snapshot.rootPath),
    whenFocused,
    onFetched: options.onFetched,
    log: options.writeDiagnostic,
  });
  let ready = false;
  void options.gitReady.then(
    () => {
      ready = true;
      fetcher.reschedule();
    },
    () => undefined,
  );
  const configuration = vscode.workspace.onDidChangeConfiguration((event) => {
    if (ready && event.affectsConfiguration("gitSubmodule.autofetch")) {
      fetcher.reschedule();
    }
  });
  return new vscode.Disposable(() => {
    configuration.dispose();
    fetcher.dispose();
  });
}

function readSettings(): AutoFetchSettings {
  const config = vscode.workspace.getConfiguration("gitSubmodule");
  return {
    enabled: config.get<boolean>(AUTOFETCH_SETTINGS.enabled, AUTOFETCH_DEFAULTS.enabled) === true,
    periodMs: seconds(config.get(AUTOFETCH_SETTINGS.periodSeconds), AUTOFETCH_DEFAULTS.periodSeconds, 60, 86_400) * 1000,
    startupDelayMs:
      seconds(config.get(AUTOFETCH_SETTINGS.startupDelaySeconds), AUTOFETCH_DEFAULTS.startupDelaySeconds, 0, 3_600) * 1000,
  };
}

function seconds(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function whenFocused(): Promise<void> {
  if (vscode.window.state.focused) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const listener = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) {
        listener.dispose();
        resolve();
      }
    });
  });
}
