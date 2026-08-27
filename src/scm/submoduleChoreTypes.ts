export interface SubmoduleCommitEntry {
  sha: string;
  subject: string;
  nestedUpdates: readonly SubmodulePointerUpdate[];
}

export interface SubmodulePointerUpdate {
  path: string;
  beforeHead: string;
  afterHead: string;
  branch: string;
  /** True when the pointer change is staged (HEAD → index). */
  staged: boolean;
  commits: readonly SubmoduleCommitEntry[];
}

export interface SubmoduleChorePreviewOptions {
  /** Optional subject line for Quick Input wiring; defaults to a deterministic or fallback subject. */
  subject?: string;
}

export interface SubmoduleChorePreview {
  subject: string;
  body: string;
  message: string;
  updates: readonly SubmodulePointerUpdate[];
}

export interface SubmoduleChoreReadService {
  preview(parentRepoPath: string, options?: SubmoduleChorePreviewOptions): Promise<SubmoduleChorePreview | null>;
}
