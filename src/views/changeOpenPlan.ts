import { ResourceStatus, type ChangeGroupKind, type ResourceChange } from "../git/repositoryState.js";
import type { ChangeFileRef } from "./adoptedViewModel.js";

export interface ChangeOpenPlan {
  readonly title: string;
  readonly leftRef?: string;
  readonly leftPath?: "resource" | "original";
  readonly right: "file" | "index" | "HEAD" | "ours" | "theirs";
}

/**
 * Open-diff sides using only public `API.toGitUri(uri, ref)` refs.
 * Built-in also uses internal `submoduleOf` for gitlinks; that is intentionally omitted.
 *
 * Upstream: `ResourceCommandResolver.getLeftResource` / `getRightResource`
 * in microsoft/vscode `extensions/git/src/repository.ts` tag 1.96.0.
 */
export function changeOpenPlan(change: ChangeFileRef): ChangeOpenPlan {
  const title = diffTitle(change.group, change.resource);
  const status = change.resource.status;

  if (
    status === ResourceStatus.INDEX_DELETED ||
    status === ResourceStatus.DELETED ||
    status === ResourceStatus.BOTH_DELETED
  ) {
    return { title, right: "HEAD" };
  }

  if (change.group === "index") {
    return { title, leftRef: "HEAD", leftPath: "original", right: "index" };
  }

  if (change.group === "merge") {
    if (status === ResourceStatus.DELETED_BY_US) {
      return { title, leftRef: "~1", leftPath: "resource", right: "theirs" };
    }
    if (status === ResourceStatus.DELETED_BY_THEM) {
      return { title, leftRef: "~1", leftPath: "resource", right: "ours" };
    }
    return { title, right: "file" };
  }

  if (status === ResourceStatus.IGNORED || status === ResourceStatus.INTENT_TO_ADD) {
    return { title, right: "file" };
  }

  return { title, leftRef: "~", leftPath: "resource", right: "file" };
}

function diffTitle(group: ChangeGroupKind, resource: ResourceChange): string {
  const name = resource.relativePath.split("/").pop() ?? resource.relativePath;
  if (group === "index") {
    return `${name} (Index)`;
  }
  if (group === "merge") {
    return `${name} (Merge)`;
  }
  return `${name} (Working Tree)`;
}
