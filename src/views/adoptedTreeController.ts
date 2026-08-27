import type { AdoptedDiffReader, AdoptedDiffSpec, GitModelProvider } from "../git/interfaces.js";
import { toSubmoduleViewModel } from "../git/interfaces.js";
import { normalizeRepoPath, repoMapGet } from "../git/pathUtils.js";
import type { RepositoryStateSnapshot } from "../git/repositoryState.js";
import type { NameStatusEntry, SubmoduleNode, WorkspaceGitModel } from "../git/types.js";
import type { RestoreResult } from "../restore/branchRestoreService.js";
import {
  DEFAULT_CHANGES_TREE_SETTINGS,
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
import type { ChangesLoadReason } from "./changesLoadDiagnostics.js";

export type AdoptedTreeTiming =
  | {
      phase: "roots";
      generation: number;
      reason: ChangesLoadReason;
      startedAt: number;
      usedCachedModel: boolean;
      modelDiscoveryMs: number;
      treeBuildMs: number;
      deferredAdoptedGroups: number;
      durationMs: number;
    }
  | {
      phase: "adopted-files";
      kind: AdoptedDiffSpec["kind"];
      durationMs: number;
      fileCount: number;
      ok: boolean;
    };

export interface AdoptedCountHydrationTiming {
  durationMs: number;
  queuedCount: number;
  cacheHits: number;
  cacheMisses: number;
  gitCalls: number;
  concurrencyLimit: number;
  peakConcurrency: number;
  slowestCallMs: number;
  errors: number;
  cancelled: boolean;
}

export type AdoptedCountPatch =
  | { id: string; state: "loading" }
  | { id: string; state: "resolved"; count: number }
  | { id: string; state: "error"; message: string };

export class AdoptedTreeController {
  static readonly FILE_DIFF_CONCURRENCY = 4;

  private generation = 0;
  private reason: ChangesLoadReason = "activation";
  private roots: AdoptedTreeNode[] | undefined;
  private publishedRoots: AdoptedTreeNode[] | undefined;
  private rootError: string | undefined;
  private cachedModel: WorkspaceGitModel | undefined;
  private readonly lastStates = new Map<string, RepositoryStateSnapshot>();
  private readonly fileCache = new Map<string, CachedFileList>();
  private readonly fileInflight = new Map<string, InflightFileList>();
  private readonly runFileDiff = createLimiter(AdoptedTreeController.FILE_DIFF_CONCURRENCY);
  private inflight: Promise<AdoptedTreeNode[]> | undefined;
  private lastRootTiming: Extract<AdoptedTreeTiming, { phase: "roots" }> | undefined;
  private materialStateVersion = 0;
  private discoveredMaterialStateVersion = -1;
  private discoveredWorkspaceRootsSignature: string | undefined;

  constructor(
    private readonly model: GitModelProvider & AdoptedDiffReader,
    private readonly restoreStatus: (childRootPath: string) => RestoreResult | undefined = () => undefined,
    private readonly repositorySnapshots: () => readonly RepositoryStateSnapshot[] = () => [],
    private readonly settings: () => ChangesTreeSettings = () => DEFAULT_CHANGES_TREE_SETTINGS,
    private readonly onTiming?: (timing: AdoptedTreeTiming) => void,
    private readonly workspaceRootPaths: () => readonly string[] = () => [],
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
    if (!previous) {
      return false;
    }
    const material = this.cachedModel
      ? gitModelNeedsRediscovery(this.cachedModel, previous, snapshot)
      : repositoryHeadChanged(previous, snapshot);
    if (material) {
      this.materialStateVersion += 1;
    }
    return material;
  }

  repositoryStateNeedsRediscovery(): boolean {
    return this.materialStateVersion !== this.discoveredMaterialStateVersion;
  }

  repositoryOpenNeedsRediscovery(rootPath: string): boolean {
    if (!this.cachedModel) {
      return false;
    }
    const normalized = normalizeRepoPath(rootPath);
    for (const knownRootPath of this.cachedModel.nodesByRootPath.keys()) {
      if (normalizeRepoPath(knownRootPath) === normalized) {
        return false;
      }
    }
    return true;
  }

  workspaceFoldersNeedRediscovery(): boolean {
    if (this.discoveredWorkspaceRootsSignature === undefined) {
      return false;
    }
    return pathSetSignature(this.workspaceRootPaths()) !== this.discoveredWorkspaceRootsSignature;
  }

  async refresh(reason: ChangesLoadReason = "explicit refresh"): Promise<void> {
    this.generation += 1;
    this.reason = reason;
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

  rootTiming(): Extract<AdoptedTreeTiming, { phase: "roots" }> | undefined {
    return this.lastRootTiming;
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

  async hydrateAdoptedCounts(
    roots: readonly AdoptedTreeNode[],
    onPatch: (patch: AdoptedCountPatch) => void,
  ): Promise<AdoptedCountHydrationTiming> {
    const generation = this.generation;
    const started = performance.now();
    const groups = collectAdoptedGroups(roots).filter(
      (group): group is AdoptedTreeNode & { diffSpec: AdoptedDiffSpec } => Boolean(group.diffSpec),
    );
    const cacheHits = groups.filter((group) => this.fileCache.has(cacheKey(group.diffSpec))).length;
    let gitCalls = 0;
    let active = 0;
    let peakConcurrency = 0;
    let slowestCallMs = 0;
    const observer: FileLoadObserver = {
      onStart: () => {
        gitCalls += 1;
        active += 1;
        peakConcurrency = Math.max(peakConcurrency, active);
      },
      onEnd: (durationMs) => {
        active -= 1;
        slowestCallMs = Math.max(slowestCallMs, durationMs);
      },
    };
    const patches = await Promise.all(
      groups.map(async (group) => {
        const patch = await this.loadAdoptedCount(group, generation, observer);
        if (patch && generation === this.generation) {
          onPatch(patch);
        }
        return patch;
      }),
    );
    return {
      durationMs: performance.now() - started,
      queuedCount: groups.length,
      cacheHits,
      cacheMisses: groups.length - cacheHits,
      gitCalls,
      concurrencyLimit: AdoptedTreeController.FILE_DIFF_CONCURRENCY,
      peakConcurrency,
      slowestCallMs,
      errors: patches.filter((patch) => patch?.state === "error").length,
      cancelled: generation !== this.generation,
    };
  }

  async retryAdoptedCount(node: AdoptedTreeNode): Promise<AdoptedCountPatch | undefined> {
    if (!node.diffSpec || node.kind !== "adopted-group") {
      return undefined;
    }
    const generation = this.generation;
    this.fileCache.delete(cacheKey(node.diffSpec));
    node.description = undefined;
    node.adoptedCountError = undefined;
    return this.loadAdoptedCount(node, generation);
  }

  hasCachedFiles(node: AdoptedTreeNode): boolean {
    return Boolean(node.diffSpec && this.fileCache.has(cacheKey(node.diffSpec)));
  }

  private async loadRoots(generation: number): Promise<AdoptedTreeNode[]> {
    const started = performance.now();
    const usedCachedModel = this.cachedModel !== undefined;
    const discovering = !usedCachedModel;
    const discoveryWorkspaceRootsSignature = discovering
      ? pathSetSignature(this.workspaceRootPaths())
      : this.discoveredWorkspaceRootsSignature;
    let modelDiscoveryMs = 0;
    let treeBuildMs = 0;
    try {
      const discoveryStarted = performance.now();
      const snapshot = this.cachedModel ?? (await this.model.snapshot());
      modelDiscoveryMs = performance.now() - discoveryStarted;
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      this.cachedModel = snapshot;
      const repositorySnapshots = this.repositorySnapshots();
      if (discovering) {
        this.discoveredMaterialStateVersion = this.materialStateVersion;
        this.discoveredWorkspaceRootsSignature = discoveryWorkspaceRootsSignature;
      }
      this.rememberSnapshots(repositorySnapshots);
      const buildStarted = performance.now();
      const roots = applyRestoreOverlay(
        buildAdoptedTree(toSubmoduleViewModel(snapshot), repositorySnapshots, this.settings()),
        this.restoreStatus,
      );
      treeBuildMs = performance.now() - buildStarted;
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      this.rootError = undefined;
      this.roots = roots;
      this.publishedRoots = roots;
      const timing: Extract<AdoptedTreeTiming, { phase: "roots" }> = {
        phase: "roots",
        generation,
        reason: this.reason,
        startedAt: started,
        usedCachedModel,
        modelDiscoveryMs,
        treeBuildMs,
        deferredAdoptedGroups: collectAdoptedGroups(roots).filter((group) => group.diffSpec).length,
        durationMs: performance.now() - started,
      };
      this.lastRootTiming = timing;
      this.onTiming?.(timing);
      return roots;
    } catch (error) {
      if (generation !== this.generation) {
        return this.getRootNodes();
      }
      const roots = [errorMessageNode("root:error", error, "Failed to load changes")];
      this.rootError = roots[0]?.tooltip ?? "Failed to load changes";
      this.roots = roots;
      const timing: Extract<AdoptedTreeTiming, { phase: "roots" }> = {
        phase: "roots",
        generation,
        reason: this.reason,
        startedAt: started,
        usedCachedModel,
        modelDiscoveryMs,
        treeBuildMs,
        deferredAdoptedGroups: 0,
        durationMs: performance.now() - started,
      };
      this.lastRootTiming = timing;
      this.onTiming?.(timing);
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
    const cached = await this.loadFileList(node.diffSpec);
    this.applyAdoptedCount(node, cached);
    return nodesFromCache(node.diffSpec, cached, this.settings(), this.childReposFor(node.diffSpec.repoRoot));
  }

  private async loadFileNodes(spec: AdoptedDiffSpec): Promise<AdoptedTreeNode[]> {
    return nodesFromCache(
      spec,
      await this.loadFileList(spec),
      this.settings(),
      this.childReposFor(spec.repoRoot),
    );
  }

  private childReposFor(repoRoot: string): readonly SubmoduleNode[] {
    const node = this.cachedModel ? repoMapGet(this.cachedModel.nodesByRootPath, repoRoot) : undefined;
    return node?.children ?? [];
  }

  private async loadFileList(spec: AdoptedDiffSpec, observer?: FileLoadObserver): Promise<CachedFileList> {
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
      const started = performance.now();
      observer?.onStart();
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
          durationMs: performance.now() - started,
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
          durationMs: performance.now() - started,
          fileCount: 0,
          ok: false,
        });
        return result;
      } finally {
        observer?.onEnd(performance.now() - started);
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

  private async loadAdoptedCount(
    node: AdoptedTreeNode,
    generation: number,
    observer?: FileLoadObserver,
  ): Promise<AdoptedCountPatch | undefined> {
    if (!node.diffSpec) {
      return undefined;
    }
    const cached = await this.loadFileList(node.diffSpec, observer);
    if (generation !== this.generation) {
      return undefined;
    }
    return this.applyAdoptedCount(node, cached);
  }

  private applyAdoptedCount(
    node: AdoptedTreeNode,
    cached: CachedFileList,
  ): AdoptedCountPatch {
    if (!cached.ok) {
      const message = cached.nodes[0]?.tooltip ?? "Failed to list changes";
      node.description = undefined;
      node.adoptedCountError = message;
      return { id: node.id, state: "error", message };
    }
    const count = cached.entries.length;
    node.description = String(count);
    node.adoptedCountError = undefined;
    return { id: node.id, state: "resolved", count };
  }
}

type CachedFileList =
  | { ok: true; entries: readonly NameStatusEntry[] }
  | { ok: false; nodes: AdoptedTreeNode[] };

interface InflightFileList {
  generation: number;
  promise: Promise<CachedFileList>;
}

interface FileLoadObserver {
  onStart(): void;
  onEnd(durationMs: number): void;
}

function cacheKey(spec: AdoptedDiffSpec): string {
  return `${spec.repoRoot}|${spec.kind}|${spec.fromSha}|${spec.toSha}`;
}

function nodesFromCache(
  spec: AdoptedDiffSpec,
  cached: CachedFileList,
  settings: ChangesTreeSettings,
  childRepos: readonly SubmoduleNode[] = [],
): AdoptedTreeNode[] {
  return cached.ok ? fileNodesFromNameStatus(spec, cached.entries, settings, childRepos) : cached.nodes;
}

function collectAdoptedGroups(nodes: readonly AdoptedTreeNode[]): AdoptedTreeNode[] {
  return nodes.flatMap((node) =>
    node.kind === "adopted-group" ? [node, ...collectAdoptedGroups(node.children)] : collectAdoptedGroups(node.children),
  );
}

function pathSetSignature(paths: readonly string[]): string {
  return [...new Set(paths.map(normalizeRepoPath))].sort().join("|");
}

function repositoryHeadChanged(
  previous: RepositoryStateSnapshot,
  next: RepositoryStateSnapshot,
): boolean {
  return (
    (previous.head?.commit ?? "") !== (next.head?.commit ?? "") ||
    (previous.head?.name ?? "") !== (next.head?.name ?? "") ||
    Boolean(previous.head?.detached) !== Boolean(next.head?.detached)
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

