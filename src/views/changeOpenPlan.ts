import { ResourceStatus, type ResourceChange } from "../git/repositoryState.js";
import type { ChangeFileRef } from "./adoptedViewModel.js";

export interface ChangeOpenPlan {
  readonly title: string;
  readonly leftRef?: string;
  readonly leftPath?: "resource" | "original";
  readonly right: "file" | "index" | "HEAD" | "ours" | "theirs";
}

export interface ChangeOpenGitSide {
  readonly kind: "git";
  readonly fsPath: string;
  readonly ref: string;
}

export interface ChangeOpenFileSide {
  readonly kind: "file";
  readonly fsPath: string;
}

export type ChangeOpenSide = ChangeOpenGitSide | ChangeOpenFileSide;

export interface ChangeOpenTarget {
  readonly command: "vscode.diff" | "vscode.open";
  readonly title: string;
  readonly left?: ChangeOpenGitSide;
  readonly right: ChangeOpenSide;
}

/**
 * Open-diff sides using only public `API.toGitUri(uri, ref)` refs.
 * Built-in also uses internal `submoduleOf` for gitlinks; that is intentionally omitted.
 *
 * Upstream: `ResourceCommandResolver.getLeftResource` / `getRightResource`
 * in microsoft/vscode `extensions/git/src/repository.ts` tag 1.96.0.
 *
 * Callers must turn `fsPath` into URIs with `Uri.file` / `API.toGitUri(Uri.file(fsPath), ref)`.
 * Never concatenate `file://` + path: `#` and `?` are URI reserved (see `uriSafety.ts`).
 */
export function changeOpenPlan(change: ChangeFileRef): ChangeOpenPlan {
  const status = change.resource.status;
  const title = diffTitle(change.resource);

  if (
    status === ResourceStatus.INDEX_DELETED ||
    status === ResourceStatus.DELETED ||
    status === ResourceStatus.BOTH_DELETED
  ) {
    return { title, right: "HEAD" };
  }

  if (status === ResourceStatus.INDEX_MODIFIED || status === ResourceStatus.INDEX_RENAMED) {
    return { title, leftRef: "HEAD", leftPath: "original", right: "index" };
  }

  if (status === ResourceStatus.INDEX_ADDED || status === ResourceStatus.INDEX_COPIED) {
    return { title, right: "index" };
  }

  if (status === ResourceStatus.INTENT_TO_RENAME || status === ResourceStatus.TYPE_CHANGED) {
    return { title, leftRef: "HEAD", leftPath: "original", right: "file" };
  }

  if (status === ResourceStatus.MODIFIED) {
    return { title, leftRef: "~", leftPath: "resource", right: "file" };
  }

  if (status === ResourceStatus.DELETED_BY_US) {
    return { title, leftRef: "~1", leftPath: "resource", right: "theirs" };
  }

  if (status === ResourceStatus.DELETED_BY_THEM) {
    return { title, leftRef: "~1", leftPath: "resource", right: "ours" };
  }

  return { title, right: "file" };
}

export function changeOpenTarget(change: ChangeFileRef): ChangeOpenTarget {
  const plan = changeOpenPlan(change);
  const resourcePath = change.resource.uri;
  const originalPath = change.resource.originalUri;
  const right = toRightSide(plan.right, resourcePath);
  if (!plan.leftRef) {
    return { command: "vscode.open", title: plan.title, right };
  }
  const leftPath = plan.leftPath === "original" ? originalPath : resourcePath;
  return {
    command: "vscode.diff",
    title: plan.title,
    left: { kind: "git", fsPath: leftPath, ref: plan.leftRef },
    right,
  };
}

function toRightSide(right: ChangeOpenPlan["right"], fsPath: string): ChangeOpenSide {
  if (right === "file") {
    return { kind: "file", fsPath };
  }
  if (right === "index") {
    return { kind: "git", fsPath, ref: "" };
  }
  if (right === "ours") {
    return { kind: "git", fsPath, ref: "~2" };
  }
  if (right === "theirs") {
    return { kind: "git", fsPath, ref: "~3" };
  }
  return { kind: "git", fsPath, ref: "HEAD" };
}

function diffTitle(resource: ResourceChange): string {
  const name = resource.relativePath.split("/").pop() ?? resource.relativePath;
  switch (resource.status) {
    case ResourceStatus.INDEX_MODIFIED:
    case ResourceStatus.INDEX_RENAMED:
    case ResourceStatus.INDEX_ADDED:
    case ResourceStatus.INDEX_COPIED:
      return `${name} (Index)`;
    case ResourceStatus.INDEX_DELETED:
    case ResourceStatus.DELETED:
    case ResourceStatus.BOTH_DELETED:
      return `${name} (Deleted)`;
    case ResourceStatus.DELETED_BY_US:
      return `${name} (Theirs)`;
    case ResourceStatus.DELETED_BY_THEM:
      return `${name} (Ours)`;
    case ResourceStatus.UNTRACKED:
      return `${name} (Untracked)`;
    case ResourceStatus.INTENT_TO_ADD:
    case ResourceStatus.INTENT_TO_RENAME:
      return `${name} (Intent to add)`;
    case ResourceStatus.TYPE_CHANGED:
      return `${name} (Type changed)`;
    default:
      return `${name} (Working Tree)`;
  }
}
