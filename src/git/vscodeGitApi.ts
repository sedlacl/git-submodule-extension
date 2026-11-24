import * as vscode from "vscode";
import type { API, GitExtension, Repository } from "./git.js";
import { overlayHierarchicalRepositoryState, type HierarchicalRepositoryView } from "./hierarchicalRepositoryState.js";
import { normalizeRepoPath, sameRepoPath } from "./pathUtils.js";
import {
  bindRepositoryOperations,
  snapshotRepository,
  type GitRepositoryHandle,
  type RepositoryStateSnapshot,
} from "./repositoryState.js";
import { waitForGitApi } from "./gitApiReady.js";
import type { WorkspaceGitModel } from "./types.js";

export type { GitRepositoryHandle } from "./repositoryState.js";

export interface GitApiListener {
  onOpenRepository?(rootPath: string): void;
  onCloseRepository?(rootPath: string): void;
  onDidChangeRepository?(rootPath: string): void;
  onDidChangeRepositoryState?(snapshot: RepositoryStateSnapshot): void;
}

/**
 * Thin adapter over the public `vscode.git` API (version 1). Git binary path
 * comes from `api.git.path`; repository events are forwarded without exposing
 * internal Git extension types to the rest of the model.
 */
export class VsCodeGitApiAdapter {
  constructor(
    private readonly api: API,
    private readonly workspace: typeof vscode.workspace = vscode.workspace,
  ) {}

  get gitPath(): string {
    return this.api.git.path;
  }

  /**
   * Resolves when `vscode.git` finishes its initial repository scan. Repositories it opens
   * before then are already in `getOpenRepositories()` and still raise `onOpenRepository`.
   */
  whenInitialized(): Promise<void> {
    return waitForGitApi(this.api);
  }

  toGitUri(filePath: string, ref: string): vscode.Uri {
    return this.api.toGitUri(vscode.Uri.file(filePath), ref);
  }

  getWorkspaceFolderPaths(): string[] {
    return this.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
  }

  /**
   * Where CHANGES with submodules starts discovery: the workspace folders, then every repository
   * `vscode.git` has open, as in its own Repositories list. That includes a repository outside the
   * workspace, opened because a file of it was opened or via Git: Open Repository. Discovery shows
   * an open repository that is a submodule of another root under its parent, not as a root.
   */
  getRootPaths(): string[] {
    const seen = new Set<string>();
    const roots: string[] = [];
    for (const rootPath of [...this.getWorkspaceFolderPaths(), ...this.getOpenRepositoryPaths()]) {
      const key = normalizeRepoPath(rootPath);
      if (!seen.has(key)) {
        seen.add(key);
        roots.push(rootPath);
      }
    }
    return roots;
  }

  getOpenRepositoryPaths(): string[] {
    return this.api.repositories.map((repository) => repository.rootUri.fsPath);
  }

  getOpenRepositories(): GitRepositoryHandle[] {
    return this.api.repositories.map((repository) => this.toHandle(repository));
  }

  getRepositoryHandle(rootPath: string): GitRepositoryHandle | undefined {
    const repository = this.findRepository(rootPath);
    return repository ? this.toHandle(repository) : undefined;
  }

  snapshotAll(): RepositoryStateSnapshot[] {
    return this.api.repositories.map((repository) => snapshotRepository(repository));
  }

  snapshotRepository(rootPath: string): RepositoryStateSnapshot | undefined {
    const repository = this.findRepository(rootPath);
    return repository ? snapshotRepository(repository) : undefined;
  }

  overlayHierarchicalState(model: WorkspaceGitModel): HierarchicalRepositoryView[] {
    return overlayHierarchicalRepositoryState(model, this.snapshotAll());
  }

  /**
   * Each subscription keeps its own per-repository listeners: the CHANGES view and branch restore
   * subscribe separately, and a later subscription must not replace an earlier one's.
   */
  subscribe(listener: GitApiListener): vscode.Disposable {
    const disposables: vscode.Disposable[] = [];
    const repoDisposables = new Map<string, vscode.Disposable>();

    const attachRepo = (repository: Repository): void => {
      const rootPath = repository.rootUri.fsPath;
      const key = normalizeRepoPath(rootPath);
      repoDisposables.get(key)?.dispose();
      repoDisposables.set(
        key,
        repository.state.onDidChange(() => {
          const snapshot = snapshotRepository(repository);
          listener.onDidChangeRepository?.(rootPath);
          listener.onDidChangeRepositoryState?.(snapshot);
        }),
      );
    };

    for (const repository of this.api.repositories) {
      attachRepo(repository);
    }

    disposables.push(
      this.api.onDidOpenRepository((repository) => {
        attachRepo(repository);
        listener.onOpenRepository?.(repository.rootUri.fsPath);
        listener.onDidChangeRepositoryState?.(snapshotRepository(repository));
      }),
    );
    disposables.push(
      this.api.onDidCloseRepository((repository) => {
        const rootPath = repository.rootUri.fsPath;
        const key = normalizeRepoPath(rootPath);
        repoDisposables.get(key)?.dispose();
        repoDisposables.delete(key);
        listener.onCloseRepository?.(rootPath);
      }),
    );

    return new vscode.Disposable(() => {
      for (const disposable of disposables) {
        disposable.dispose();
      }
      for (const disposable of repoDisposables.values()) {
        disposable.dispose();
      }
      repoDisposables.clear();
    });
  }

  private findRepository(rootPath: string): Repository | undefined {
    return this.api.repositories.find((repository) => sameRepoPath(repository.rootUri.fsPath, rootPath));
  }

  private toHandle(repository: Repository): GitRepositoryHandle {
    return {
      rootPath: repository.rootUri.fsPath,
      get inputBoxValue() {
        return repository.inputBox.value;
      },
      set inputBoxValue(value: string) {
        repository.inputBox.value = value;
      },
      snapshot: () => snapshotRepository(repository),
      operations: () => bindRepositoryOperations(repository),
    };
  }
}

/**
 * Returns as soon as `vscode.git` is active, without waiting for its initial repository scan
 * (that can take tens of seconds in a large multi-root workspace). Use `whenInitialized()`
 * for work that needs every repository open.
 */
export async function activateVsCodeGitApi(
  getExtension: typeof vscode.extensions.getExtension = vscode.extensions.getExtension.bind(vscode.extensions),
): Promise<VsCodeGitApiAdapter> {
  const extension = getExtension<GitExtension>("vscode.git");
  if (!extension) {
    throw new Error("Required built-in extension vscode.git is not available.");
  }

  const exported = extension.isActive ? extension.exports : await extension.activate();
  if (!exported.enabled) {
    throw new Error("vscode.git is disabled.");
  }

  return new VsCodeGitApiAdapter(exported.getAPI(1));
}
