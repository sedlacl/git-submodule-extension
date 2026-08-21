/*---------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
/**
 * Public `vscode.git` API (version 1) used by this extension.
 *
 * Source: microsoft/vscode `extensions/git/src/api/git.d.ts`
 * Tag: 1.96.0
 * File revision: d085816005ae61fc8f39b3720b3ec4594b35ecd0
 *
 * This is a focused public subset: repository state, change resources, and the
 * mutation/diff methods the command layer will call. Proposed SCM APIs
 * (`scmActionButton`, `scmMultiDiffEditor`, `scmValidation`) and internal
 * Git command IDs are intentionally omitted.
 *
 * `RepositoryState.untrackedChanges` is optional so hosts that still match
 * `engines.vscode` ^1.85.0 typecheck; the adapter splits UNTRACKED/IGNORED
 * out of `workingTreeChanges` when the property is missing.
 */
import type { Event, Uri } from "vscode";

export type APIState = "uninitialized" | "initialized";

export interface Git {
  readonly path: string;
}

export interface InputBox {
  value: string;
}

export const enum ForcePushMode {
  Force = 0,
  ForceWithLease = 1,
  ForceWithLeaseIfIncludes = 2,
}

export const enum RefType {
  Head = 0,
  RemoteHead = 1,
  Tag = 2,
}

export interface Ref {
  readonly type: RefType;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface UpstreamRef {
  readonly remote: string;
  readonly name: string;
  readonly commit?: string;
}

export interface Branch extends Ref {
  readonly upstream?: UpstreamRef;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface BranchQuery {
  readonly remote?: boolean;
  readonly contains?: string;
  readonly sort?: "alphabetically" | "committerdate";
  readonly count?: number;
}

export interface CommitShortStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
  readonly shortStat?: CommitShortStat;
}

export interface Remote {
  readonly name: string;
  readonly fetchUrl?: string;
  readonly pushUrl?: string;
  readonly isReadOnly: boolean;
}

/**
 * Numeric values match microsoft/vscode `Status` in
 * `extensions/git/src/api/git.d.ts` (tag 1.96.0).
 */
export const enum Status {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,

  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  INTENT_TO_RENAME = 10,
  TYPE_CHANGED = 11,

  ADDED_BY_US = 12,
  ADDED_BY_THEM = 13,
  DELETED_BY_US = 14,
  DELETED_BY_THEM = 15,
  BOTH_ADDED = 16,
  BOTH_DELETED = 17,
  BOTH_MODIFIED = 18,
}

export interface Change {
  /**
   * Returns either `originalUri` or `renameUri`, depending on whether this
   * change is a rename. When in doubt always use `uri` over the other two.
   */
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: Status;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly remotes: Remote[];
  readonly rebaseCommit: Commit | undefined;

  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  /** Present from VS Code 1.90+ public API; treat as missing on 1.85 hosts. */
  readonly untrackedChanges?: Change[];

  readonly onDidChange: Event<void>;
}

export interface CommitOptions {
  all?: boolean | "tracked";
  amend?: boolean;
  signoff?: boolean;
  signCommit?: boolean;
  empty?: boolean;
  noVerify?: boolean;
  requireUserConfig?: boolean;
  useEditor?: boolean;
  verbose?: boolean;
  postCommitCommand?: string | null;
}

export interface FetchOptions {
  remote?: string;
  ref?: string;
  all?: boolean;
  prune?: boolean;
  depth?: number;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly inputBox: InputBox;
  readonly state: RepositoryState;

  add(paths: string[]): Promise<void>;
  revert(paths: string[]): Promise<void>;
  clean(paths: string[]): Promise<void>;
  commit(message: string, opts?: CommitOptions): Promise<void>;
  status(): Promise<void>;
  getBranches(query: BranchQuery): Promise<Ref[]>;
  checkout(treeish: string): Promise<void>;

  diffWithHEAD(): Promise<Change[]>;
  diffWithHEAD(path: string): Promise<string>;
  diffIndexWithHEAD(): Promise<Change[]>;
  diffIndexWithHEAD(path: string): Promise<string>;
  diffBetween(ref1: string, ref2: string): Promise<Change[]>;
  diffBetween(ref1: string, ref2: string, path: string): Promise<string>;
  show(ref: string, path: string): Promise<string>;

  fetch(options?: FetchOptions): Promise<void>;
  fetch(remote?: string, ref?: string, depth?: number): Promise<void>;
  pull(unshallow?: boolean): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean, force?: ForcePushMode): Promise<void>;
}

export interface API {
  readonly state: APIState;
  readonly git: Git;
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  readonly onDidChangeState: Event<APIState>;
  toGitUri(uri: Uri, ref: string): Uri;
  getRepository(uri: Uri): Repository | null;
}

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}
