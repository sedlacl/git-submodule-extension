import type { AdoptedDiffReader, AdoptedDiffSpec, GitModelProvider } from "../git/interfaces.js";
import { toSubmoduleViewModel } from "../git/interfaces.js";
import { normalizeRepoPath } from "../git/pathUtils.js";
import type { RepositoryStateSnapshot } from "../git/repositoryState.js";
import type { NameStatusEntry, WorkspaceGitModel } from "../git/types.js";
import type { RestoreResult } from "../restore/branchRestoreService.js";
import {
  DEFAULT_CHANGES_TREE_SETTINGS,
  repositoryCountBadge,
  type ChangesTreeSettings,
} from "./changesTreeSettings.js";
import {
  type AdoptedFileDiff,
  type AdoptedTreeNode,
  type ChangeFileRef,
  applyRestoreOverlay,
  buildAdoptedTree,
  collectChangeRefs,
  collectDiffSpecs,
  collectFileDiffs,
  errorMessageNode,
  fileNodesFromNameStatus,
} from "./adoptedViewModel.js";
import { gitModelNeedsRediscovery } from "./gitModelRefresh.js";

export interface AdoptedTreeRefreshTimings {
  usedCachedModel: boolean;
  durationMs: number;
}

export class AdoptedTreeController {
  private generation = 0;
  private roots: AdoptedTreeNode[] | undefined;
  private cachedModel: WorkspaceGitModel | undefined;
  private readonly lastStates = new Map<string, RepositoryStateSnapshot>();
  private readonly fileCache = new Map<string, CachedFileList>();
  private inflight: Promise<AdoptedTreeNode[]> | undefined;

  constructor(
    private readonly model: GitModelProvider & AdoptedDiffReader,
    private readonly restoreStatus: (childRootPath: string) => RestoreResult | undefined = () => undefined,
    private readonly repositorySnapshots: () => readonly RepositoryStateSnapshot[] = () => [],
    private readonly settings: () => ChangesTreeSettings = () => DEFAULT_CHANGES_TREE_SETTINGS,
    private readonly onRefresh?: (timings: AdoptedTreeRefreshTimings) => void,
  ) {}

  invalidateModel(): void {
    this.cachedModel = undefined;
    this.fileCache.clear();
  }

  consumeRepositoryState(snapshot: RepositoryStateSnapshot): boolean {
    const key = normalizeRepoPath(snapshot.rootPath);
    const previous = this.lastStates.get(key);
    this.lastStates.set(key, snapshot);
    if (!this.cachedModel) {
      return false;
    }
    return gitModelNeedsRediscovery(this.cachedModel, previous, snapshot);
  }

  async refresh(): Promise<void> {
    this.generation += 1;
    this.roots = undefined;
    this.inflight = undefined;
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
    if (node.diffSpec && (node.kind === "staged" || node.kind === "unstaged" || node.kind === "adopted-group")) {
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
      files.push(...collectFileDiffs(await this.loadFileNodes(spec)));
    }
    return files;
  }

  changesForOpenAll(node: AdoptedTreeNode): ChangeFileRef[] {
    return collectChangeRefs(node);
  }

  countBadge(): number {
    const settings = this.settings();
    return this.repositorySnapshots().reduce((total, snapshot) => total + repositoryCountBadge(snapshot.groups, settings), 0);
  }

  private async loadRoots(generation: number): Promise<AdoptedTreeNode[]> {
    const started = Date.now();
    const usedCachedModel = this.cachedModel !== undefined;
    try {
      const snapshot = this.cachedModel ?? (await this.model.snapshot());
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      this.cachedModel = snapshot;
      this.rememberSnapshots(this.repositorySnapshots());
      const roots = applyRestoreOverlay(
        buildAdoptedTree(toSubmoduleViewModel(snapshot), this.repositorySnapshots(), this.settings()),
        this.restoreStatus,
      );
      await this.hydrateAdoptedCounts(roots, generation);
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      this.roots = roots;
      this.onRefresh?.({ usedCachedModel, durationMs: Date.now() - started });
      return roots;
    } catch (error) {
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      const roots = [errorMessageNode("root:error", error, "Failed to load changes")];
      this.roots = roots;
      this.onRefresh?.({ usedCachedModel, durationMs: Date.now() - started });
      return roots;
    }
  }

  private rememberSnapshots(snapshots: readonly RepositoryStateSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.lastStates.set(normalizeRepoPath(snapshot.rootPath), snapshot);
    }
  }

  private async hydrateAdoptedCounts(roots: readonly AdoptedTreeNode[], generation: number): Promise<void> {
    await Promise.all(
      collectAdoptedGroups(roots).map(async (group) => {
        if (!group.diffSpec) {
          group.description = "0";
          return;
        }
        const files = await this.loadFileNodes(group.diffSpec);
        if (generation !== this.generation) {
          return;
        }
        group.description = String(collectFileDiffs(files).length);
      }),
    );
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
      return nodesFromCache(spec, cached, this.settings());
    }

    const generation = this.generation;
    try {
      const entries = await this.model.listNameStatus(spec);
      if (generation !== this.generation) {
        return this.loadFileNodes(spec);
      }
      this.fileCache.set(key, { ok: true, entries });
      return fileNodesFromNameStatus(spec, entries, this.settings());
    } catch (error) {
      if (generation !== this.generation) {
        return this.loadFileNodes(spec);
      }
      const nodes = [errorMessageNode(`${spec.kind}:${spec.repoRoot}:error`, error)];
      this.fileCache.set(key, { ok: false, nodes });
      return nodes;
    }
  }
}

type CachedFileList =
  | { ok: true; entries: readonly NameStatusEntry[] }
  | { ok: false; nodes: AdoptedTreeNode[] };

function cacheKey(spec: AdoptedDiffSpec): string {
  return `${spec.repoRoot}|${spec.kind}|${spec.fromSha}|${spec.toSha}`;
}

function nodesFromCache(spec: AdoptedDiffSpec, cached: CachedFileList, settings: ChangesTreeSettings): AdoptedTreeNode[] {
  return cached.ok ? fileNodesFromNameStatus(spec, cached.entries, settings) : cached.nodes;
}

function collectAdoptedGroups(nodes: readonly AdoptedTreeNode[]): AdoptedTreeNode[] {
  return nodes.flatMap((node) =>
    node.kind === "adopted-group" ? [node, ...collectAdoptedGroups(node.children)] : collectAdoptedGroups(node.children),
  );
}

