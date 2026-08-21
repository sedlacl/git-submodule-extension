import type { PorcelainStatus, RepoWorkingState } from "./types.js";
import { parseSha } from "./sha.js";

export function parsePorcelainV2(stdout: string): PorcelainStatus {
  let oid: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead: number | null = null;
  let behind: number | null = null;
  let detached = false;
  let dirty = false;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line) {
      continue;
    }
    if (line.startsWith("# branch.oid ")) {
      oid = parseSha(line.slice("# branch.oid ".length));
      continue;
    }
    if (line.startsWith("# branch.head ")) {
      const value = line.slice("# branch.head ".length).trim();
      if (value === "(detached)") {
        detached = true;
        head = null;
      } else {
        head = value || null;
      }
      continue;
    }
    if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
      continue;
    }
    if (line.startsWith("# branch.ab ")) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/);
      if (match) {
        ahead = Number(match[1]);
        behind = Number(match[2]);
      }
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    dirty = true;
  }

  return { oid, head, upstream, ahead, behind, detached, dirty };
}

export function isDiverged(ahead: number | null, behind: number | null): boolean {
  return (ahead ?? 0) !== 0 || (behind ?? 0) !== 0;
}

export function classifyWorkingState(input: {
  uninitialized: boolean;
  probeFailed?: boolean;
  detached: boolean;
  dirty: boolean;
  ahead: number | null;
  behind: number | null;
  pointerMismatch: boolean;
  operationInProgress: boolean;
}): RepoWorkingState {
  if (input.uninitialized) {
    return {
      uninitialized: true,
      dirty: false,
      detached: false,
      diverged: false,
      pointerMismatch: false,
      operationInProgress: false,
      probeFailed: false,
    };
  }

  return {
    uninitialized: false,
    dirty: input.dirty,
    detached: input.detached,
    diverged: !input.detached && isDiverged(input.ahead, input.behind),
    pointerMismatch: input.pointerMismatch,
    operationInProgress: input.operationInProgress,
    probeFailed: Boolean(input.probeFailed),
  };
}

export const GIT_IN_PROGRESS_MARKERS = [
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_HEAD",
  "rebase-merge",
  "rebase-apply",
] as const;
