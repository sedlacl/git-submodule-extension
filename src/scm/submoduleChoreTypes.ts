export interface SubmodulePointerUpdate {
  path: string;
  beforeHead: string;
  afterHead: string;
  branch: string;
  subjects: readonly string[];
  /** True when the pointer change is staged (HEAD → index). */
  staged: boolean;
}

export interface SubmoduleChorePreviewOptions {
  /** Optional subject line for Quick Input wiring; defaults to `chore: update submodules`. */
  subject?: string;
}

export interface SubmoduleChorePreview {
  subject: string;
  body: string;
  message: string;
  updates: readonly SubmodulePointerUpdate[];
  hasUnstagedUpdates: boolean;
  unstagedNote: string | null;
}

export interface SubmoduleChoreReadService {
  preview(parentRepoPath: string, options?: SubmoduleChorePreviewOptions): Promise<SubmoduleChorePreview | null>;
}
