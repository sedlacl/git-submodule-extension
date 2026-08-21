import type { Event, Uri } from "vscode";

export type APIState = "uninitialized" | "initialized";

export interface Git {
  readonly path: string;
}

export interface RepositoryState {
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
}

export interface API {
  readonly state: APIState;
  readonly git: Git;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  readonly onDidChangeState: Event<APIState>;
  getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}
