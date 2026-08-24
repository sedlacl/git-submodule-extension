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

export type AdoptedTreeTiming =
  | {
      phase: "roots";
      usedCachedModel: boolean;
      modelDiscoveryMs: number;
      treeBuildMs: number;
      adoptedCountHydrationMs: number;
      deferredAdoptedGroups: number;
      durationMs: number;
    }
  | {
      phase: "adopted-files";
      kind: AdoptedDiffSpec["kind"];
      durationMs: number;
      fileCount: number;
      ok: boolean;
    }
  | {
      phase: "adopted-count";
      durationMs: number;
      fileCount: number;
    };

export class AdoptedTreeController {
  private generation = 0;
  private roots: AdoptedTreeNode[] | undefined;
  private publishedRoots: AdoptedTreeNode[] | undefined;
  private rootError: string | undefined;
  private cachedModel: WorkspaceGitModel | undefined;
  private readonly lastStates = new Map<string, RepositoryStateSnapshot>();
  private readonly fileCache = new Map<string, CachedFileList>();
  private readonly fileInflight = new Map<string, InflightFileList>();
  private readonly runFileDiff = createLimiter(4);
  private inflight: Promise<AdoptedTreeNode[]> | undefined;

  constructor(
    private readonly model: GitModelProvider & AdoptedDiffReader,
    private readonly restoreStatus: (childRootPath: string) => RestoreResult | undefined = () => undefined,
    private readonly repositorySnapshots: () => readonly RepositoryStateSnapshot[] = () => [],
    private readonly settings: () => ChangesTreeSettings = () => DEFAULT_CHANGES_TREE_SETTINGS,
    private readonly onTiming?: (timing: AdoptedTreeTiming) => void,
  ) {}

  invalidateModel(): void {
    this.cachedModel = undefined;
    this.fileCache.clear();
    this.fileInflight.clear();
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
    this.rootError = undefined;
    this.inflight = undefined;
    await this.getRootNodes();
  }

  /** Last successful tree, including during an in-flight refresh. */
  peekRoots(): AdoptedTreeNode[] | undefined {
    return this.publishedRoots;
  }

  rootLoadError(): string | undefined {
    return this.rootError;
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
    const groups = await Promise.all(specs.map(async (spec) => collectFileDiffs(await this.loadFileNodes(spec))));
    return groups.flat();
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
    let modelDiscoveryMs = 0;
    let treeBuildMs = 0;
    try {
      const discoveryStarted = Date.now();
      const snapshot = this.cachedModel ?? (await this.model.snapshot());
      modelDiscoveryMs = Date.now() - discoveryStarted;
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      this.cachedModel = snapshot;
      const repositorySnapshots = this.repositorySnapshots();
      this.rememberSnapshots(repositorySnapshots);
      const buildStarted = Date.now();
      const roots = applyRestoreOverlay(
        buildAdoptedTree(toSubmoduleViewModel(snapshot), repositorySnapshots, this.settings()),
        this.restoreStatus,
      );
      treeBuildMs = Date.now() - buildStarted;
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      this.rootError = undefined;
      this.roots = roots;
      this.publishedRoots = roots;
      this.onTiming?.({
        phase: "roots",
        usedCachedModel,
        modelDiscoveryMs,
        treeBuildMs,
        adoptedCountHydrationMs: 0,
        deferredAdoptedGroups: collectAdoptedGroups(roots).filter((group) => group.diffSpec).length,
        durationMs: Date.now() - started,
      });
      return roots;
    } catch (error) {
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      const roots = [errorMessageNode("root:error", error, "Failed to load changes")];
      this.rootError = roots[0]?.tooltip ?? "Failed to load changes";
      this.roots = roots;
      this.onTiming?.({
        phase: "roots",
        usedCachedModel,
        modelDiscoveryMs,
        treeBuildMs,
        adoptedCountHydrationMs: 0,
        deferredAdoptedGroups: 0,
        durationMs: Date.now() - started,
      });
      return roots;
    }
  }

  private rememberSnapshots(snapshots: readonly RepositoryStateSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.lastStates.set(normalizeRepoPath(snapshot.rootPath), snapshot);
    }
  }

  private async getFileChildren(node: AdoptedTreeNode): Promise<AdoptedTreeNode[]> {
    if (!node.diffSpec) {
      return node.children;
    }
    const files = await this.loadFileNodes(node.diffSpec);
    const countStarted = Date.now();
    if (!files.some((child) => child.kind === "message")) {
      const fileCount = collectFileDiffs(files).length;
      node.description = String(fileCount);
      this.onTiming?.({
        phase: "adopted-count",
        durationMs: Date.now() - countStarted,
        fileCount,
      });
    }
    return files;
  }

  private async loadFileNodes(spec: AdoptedDiffSpec): Promise<AdoptedTreeNode[]> {
    return nodesFromCache(spec, await this.loadFileList(spec), this.settings());
  }

  private async loadFileList(spec: AdoptedDiffSpec): Promise<CachedFileList> {
    const key = cacheKey(spec);
    const cached = this.fileCache.get(key);
    if (cached) {
      return cached;
    }
    const existing = this.fileInflight.get(key);
    if (existing?.generation === this.generation) {
      const result = await existing.promise;
      return existing.generation === this.generation ? result : this.loadFileList(spec);
    }

    const generation = this.generation;
    const promise = this.runFileDiff(async () => {
      const started = Date.now();
      try {
        const entries = await this.model.listNameStatus(spec);
        if (generation !== this.generation) {
          return { ok: true, entries: [] } satisfies CachedFileList;
        }
        const result: CachedFileList = { ok: true, entries };
        this.fileCache.set(key, result);
        this.onTiming?.({
          phase: "adopted-files",
          kind: spec.kind,
          durationMs: Date.now() - started,
          fileCount: entries.length,
          ok: true,
        });
        return result;
      } catch (error) {
        if (generation !== this.generation) {
          return { ok: true, entries: [] } satisfies CachedFileList;
        }
        const result: CachedFileList = {
          ok: false,
          nodes: [errorMessageNode(`${spec.kind}:${spec.repoRoot}:error`, error)],
        };
        this.fileCache.set(key, result);
        this.onTiming?.({
          phase: "adopted-files",
          kind: spec.kind,
          durationMs: Date.now() - started,
          fileCount: 0,
          ok: false,
        });
        return result;
      }
    });
    const inflight = { generation, promise };
    this.fileInflight.set(key, inflight);
    try {
      const result = await promise;
      return generation === this.generation ? result : this.loadFileList(spec);
    } finally {
      if (this.fileInflight.get(key) === inflight) {
        this.fileInflight.delete(key);
      }
    }
  }
}

type CachedFileList =
  | { ok: true; entries: readonly NameStatusEntry[] }
  | { ok: false; nodes: AdoptedTreeNode[] };

interface InflightFileList {
  generation: number;
  promise: Promise<CachedFileList>;
}

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

type Limiter = <T>(task: () => Promise<T>) => Promise<T>;

function createLimiter(limit: number): Limiter {
  let active = 0;
  const pending: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => pending.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      pending.shift()?.();
    }
  };
}

