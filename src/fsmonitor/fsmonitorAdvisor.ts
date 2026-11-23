/**
 * Decides where Git's builtin file system monitor (`core.fsmonitor=true`) is worth turning on.
 * The daemon lets `git status` skip scanning the whole worktree folder. That pays off only where
 * the scan is slow, and every repository with it on runs its own daemon process, so the decision
 * rests on how long `git status` actually takes: the extension times the status runs it makes
 * anyway, without walking any folder itself.
 */

/** A repository whose typical `git status` takes at least this long gains from fsmonitor. */
export const SLOW_STATUS_MS = 1_000;
/** Timings kept per repository; the decision uses their median, so one slow run is not enough. */
export const STATUS_SAMPLES = 3;

export interface FsmonitorRepoFacts {
  readonly rootPath: string;
  /** Median duration of recent `git status` runs; undefined when none was timed yet. */
  readonly statusMs: number | undefined;
  /** Raw `core.fsmonitor` value, undefined when unset. */
  readonly fsmonitor: string | undefined;
  /** The worktree is on a network share, where the daemon refuses to run. */
  readonly remote: boolean;
}

export interface FsmonitorEnvironment {
  /** `git version --build-options` lists `feature: fsmonitor--daemon`. */
  readonly daemonSupported: boolean;
}

export type FsmonitorVerdictKind = "recommended" | "fast" | "unmeasured" | "enabled" | "unsupported";

export interface FsmonitorVerdict {
  readonly kind: FsmonitorVerdictKind;
  readonly reason: string;
}

export function assessFsmonitor(facts: FsmonitorRepoFacts, environment: FsmonitorEnvironment): FsmonitorVerdict {
  if (isFsmonitorEnabled(facts.fsmonitor)) {
    return { kind: "enabled", reason: `core.fsmonitor is already ${facts.fsmonitor}` };
  }
  if (!environment.daemonSupported) {
    return { kind: "unsupported", reason: "this Git build has no builtin fsmonitor daemon" };
  }
  if (facts.remote) {
    return { kind: "unsupported", reason: "the repository is on a network share; the daemon does not watch those" };
  }
  if (facts.statusMs === undefined) {
    return { kind: "unmeasured", reason: "git status was not timed" };
  }
  const seconds = `git status takes ${(facts.statusMs / 1000).toFixed(1)}s`;
  return facts.statusMs >= SLOW_STATUS_MS
    ? { kind: "recommended", reason: seconds }
    : { kind: "fast", reason: `${seconds}; fast enough without a daemon` };
}

/** Recent `git status` durations per repository. */
export class StatusTimings {
  private readonly samples = new Map<string, number[]>();

  /** Records one run and returns the median once `STATUS_SAMPLES` runs were timed. */
  record(key: string, durationMs: number): number | undefined {
    const list = this.samples.get(key) ?? [];
    list.push(durationMs);
    if (list.length > STATUS_SAMPLES) {
      list.shift();
    }
    this.samples.set(key, list);
    return this.median(key);
  }

  median(key: string): number | undefined {
    const list = this.samples.get(key);
    if (!list || list.length < STATUS_SAMPLES) {
      return undefined;
    }
    const sorted = [...list].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }
}

export function isFsmonitorEnabled(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "false" && normalized !== "no" && normalized !== "off" && normalized !== "0";
}

/** True when `git version --build-options` output says the builtin daemon is compiled in. */
export function hasFsmonitorDaemon(buildOptions: string): boolean {
  return /^feature:\s*fsmonitor--daemon\s*$/m.test(buildOptions);
}

/** Drive letters (upper case, with colon) mapped to network shares, from `net use` output. */
export function parseNetworkDrives(netUse: string): Set<string> {
  const drives = new Set<string>();
  for (const line of netUse.split(/\r?\n/)) {
    const match = /(?:^|\s)([A-Za-z]:)\s+\\\\/.exec(line);
    if (match) {
      drives.add(match[1]!.toUpperCase());
    }
  }
  return drives;
}

/** UNC paths and paths on a mapped network drive. */
export function isRemotePath(rootPath: string, networkDrives: ReadonlySet<string>): boolean {
  if (rootPath.startsWith("\\\\") || rootPath.startsWith("//")) {
    return true;
  }
  const drive = /^([A-Za-z]:)/.exec(rootPath)?.[1]?.toUpperCase();
  return drive !== undefined && networkDrives.has(drive);
}
