import * as vscode from "vscode";
import type { API, GitExtension, Repository } from "./git.js";

export interface GitRepositoryHandle {
  rootPath: string;
}

export interface GitApiListener {
  onOpenRepository?(rootPath: string): void;
  onCloseRepository?(rootPath: string): void;
  onDidChangeRepository?(rootPath: string): void;
}

/**
 * Thin adapter over the public `vscode.git` API (version 1). Git binary path
 * comes from `api.git.path`; repository events are forwarded without exposing
 * internal Git extension types to the rest of the model.
 */
export class VsCodeGitApiAdapter {
  private readonly repoDisposables = new Map<string, vscode.Disposable>();

  constructor(
    private readonly api: API,
    private readonly workspace: typeof vscode.workspace = vscode.workspace,
  ) {}

  get gitPath(): string {
    return this.api.git.path;
  }

  getWorkspaceFolderPaths(): string[] {
    return this.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  }

  getOpenRepositoryPaths(): string[] {
    return this.api.repositories.map((repository) => repository.rootUri.fsPath);
  }

  getOpenRepositories(): GitRepositoryHandle[] {
    return this.getOpenRepositoryPaths().map((rootPath) => ({ rootPath }));
  }

  subscribe(listener: GitApiListener): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];

    const attachRepo = (repository: Repository): void => {
      const rootPath = repository.rootUri.fsPath;
      this.repoDisposables.get(rootPath)?.dispose();
      this.repoDisposables.set(
        rootPath,
        repository.state.onDidChange(() => listener.onDidChangeRepository?.(rootPath)),
      );
    };

    for (const repository of this.api.repositories) {
      attachRepo(repository);
    }

    disposables.push(
      this.api.onDidOpenRepository((repository) => {
        attachRepo(repository);
        listener.onOpenRepository?.(repository.rootUri.fsPath);
      }),
    );
    disposables.push(
      this.api.onDidCloseRepository((repository) => {
        const rootPath = repository.rootUri.fsPath;
        this.repoDisposables.get(rootPath)?.dispose();
        this.repoDisposables.delete(rootPath);
        listener.onCloseRepository?.(rootPath);
      }),
    );

    return new vscode.Disposable(() => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
      for (const disposable of this.repoDisposables.values()) {
        disposable.dispose();
      }
      this.repoDisposables.clear();
    });
  }
}

export async function activateVsCodeGitApi(
  getExtension: typeof vscode.extensions.getExtension = vscode.extensions.getExtension.bind(vscode.extensions),
  timeoutMs = 15_000,
): Promise<VsCodeGitApiAdapter> {
  const extension = getExtension<GitExtension>("vscode.git");
  if (!extension) {
    throw new Error("Required built-in extension vscode.git is not available.");
  }

  const exported = extension.isActive ? extension.exports : await extension.activate();
  if (!exported.enabled) {
    throw new Error("vscode.git is disabled.");
  }

  const api = exported.getAPI(1);
  await waitForGitApi(api, timeoutMs);
  return new VsCodeGitApiAdapter(api);
}

export function waitForGitApi(api: API, timeoutMs: number): Promise<void> {
  if (api.state === "initialized") {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error("Timed out waiting for vscode.git API initialization."));
    }, timeoutMs);
    const subscription = api.onDidChangeState((state) => {
      if (state === "initialized") {
        clearTimeout(timer);
        subscription.dispose();
        resolve();
      }
    });
  });
}
