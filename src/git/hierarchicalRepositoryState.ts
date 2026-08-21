import type { GitNodeKind, GitRepoNode, WorkspaceGitModel } from "./types.js";
import {
  indexSnapshots,
  lookupSnapshot,
  toRepositoryTreeModel,
  type ChangeGroupViewModel,
  type RepositoryHead,
  type RepositoryStateSnapshot,
} from "./repositoryState.js";

/**
 * Hierarchical repository view: discovered gitlink parenthood plus vscode.git
 * change groups for each node. Adopted pointer groups stay on the existing
 * graph and are composed by the tree layer later.
 */
export interface HierarchicalRepositoryView {
  readonly rootPath: string;
  readonly displayName: string;
  readonly nodeKind: GitNodeKind;
  readonly handlePresent: boolean;
  readonly head: RepositoryHead | undefined;
  readonly groups: readonly ChangeGroupViewModel[];
  readonly children: readonly HierarchicalRepositoryView[];
}

export function overlayHierarchicalRepositoryState(
  model: WorkspaceGitModel,
  snapshots: readonly RepositoryStateSnapshot[],
): HierarchicalRepositoryView[] {
  const byRoot = indexSnapshots(snapshots);
  return model.roots.map((root) => overlayNode(root, byRoot));
}

function overlayNode(
  node: GitRepoNode,
  snapshots: ReadonlyMap<string, RepositoryStateSnapshot>,
): HierarchicalRepositoryView {
  const snapshot = lookupSnapshot(node.rootPath, snapshots);
  const tree = snapshot ? toRepositoryTreeModel(snapshot) : undefined;
  return {
    rootPath: node.rootPath,
    displayName: node.displayName,
    nodeKind: node.kind,
    handlePresent: Boolean(snapshot),
    head: tree?.head,
    groups: tree?.groups ?? [],
    children: node.children.map((child) => overlayNode(child, snapshots)),
  };
}
