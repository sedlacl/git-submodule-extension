import type { AdoptedDiffReader, AdoptedDiffSpec, GitModelProvider } from "../git/interfaces.js";
import { toSubmoduleViewModel } from "../git/interfaces.js";
import type { RestoreResult } from "../restore/branchRestoreService.js";
import {
  type AdoptedFileDiff,
  type AdoptedTreeNode,
  applyRestoreOverlay,
  buildAdoptedTree,
  collectDiffSpecs,
  errorMessageNode,
  fileNodesFromNameStatus,
} from "./adoptedViewModel.js";

export class AdoptedTreeController {
  private generation = 0;
  private roots: AdoptedTreeNode[] | undefined;
  private readonly fileCache = new Map<string, AdoptedTreeNode[]>();
  private inflight: Promise<AdoptedTreeNode[]> | undefined;

  constructor(
    private readonly model: GitModelProvider & AdoptedDiffReader,
    private readonly restoreStatus: (childRootPath: string) => RestoreResult | undefined = () => undefined,
  ) {}

  async refresh(): Promise<void> {
    this.generation += 1;
    this.roots = undefined;
    this.inflight = undefined;
    this.fileCache.clear();
  }

  async getRootNodes(): Promise<AdoptedTreeNode[]> {
    if (this.roots) {
      return this.roots;
    }
    if (this.inflight) {
      return this.inflight;
    }

    const generation = this.generation;
    this.inflight = this.loadRoots(generation);
    try {
      return await this.inflight;
    } finally {
      if (this.generation === generation) {
        this.inflight = undefined;
      }
    }
  }

  async getChildren(node?: AdoptedTreeNode): Promise<AdoptedTreeNode[]> {
    if (!node) {
      return this.getRootNodes();
    }
    if (node.kind === "staged" || node.kind === "unstaged") {
      return this.getFileChildren(node);
    }
    return node.children;
  }

  async filesForOpenAll(node: AdoptedTreeNode): Promise<AdoptedFileDiff[]> {
    if (node.fileDiff) {
      return [node.fileDiff];
    }

    const specs = collectDiffSpecs(node);
    const files: AdoptedFileDiff[] = [];
    for (const spec of specs) {
      const children = await this.loadFileNodes(spec);
      for (const child of children) {
        if (child.fileDiff) {
          files.push(child.fileDiff);
        }
      }
    }
    return files;
  }

  private async loadRoots(generation: number): Promise<AdoptedTreeNode[]> {
    try {
      const snapshot = await this.model.snapshot();
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      const roots = applyRestoreOverlay(buildAdoptedTree(toSubmoduleViewModel(snapshot)), this.restoreStatus);
      this.roots = roots;
      return roots;
    } catch (error) {
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      const roots = [errorMessageNode("root:error", error, "Failed to load submodule tree")];
      this.roots = roots;
      return roots;
    }
  }

  private async getFileChildren(node: AdoptedTreeNode): Promise<AdoptedTreeNode[]> {
    if (!node.diffSpec) {
      return node.children;
    }
    return this.loadFileNodes(node.diffSpec);
  }

  private async loadFileNodes(spec: AdoptedDiffSpec): Promise<AdoptedTreeNode[]> {
    const key = cacheKey(spec);
    const cached = this.fileCache.get(key);
    if (cached) {
      return cached;
    }

    const generation = this.generation;
    try {
      const entries = await this.model.listNameStatus(spec);
      if (generation !== this.generation) {
        return this.loadFileNodes(spec);
      }
      const nodes = fileNodesFromNameStatus(spec, entries);
      this.fileCache.set(key, nodes);
      return nodes;
    } catch (error) {
      if (generation !== this.generation) {
        return this.loadFileNodes(spec);
      }
      const nodes = [errorMessageNode(`${spec.kind}:${spec.repoRoot}:error`, error)];
      this.fileCache.set(key, nodes);
      return nodes;
    }
  }
}

function cacheKey(spec: AdoptedDiffSpec): string {
  return `${spec.repoRoot}|${spec.kind}|${spec.fromSha}|${spec.toSha}`;
}
