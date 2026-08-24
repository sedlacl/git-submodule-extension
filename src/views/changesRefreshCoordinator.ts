import type { ChangesLoadReason } from "./changesLoadDiagnostics.js";

export interface ChangesRefreshRequest {
  reason: ChangesLoadReason;
  rediscover: boolean;
  immediate?: boolean;
}

export interface ChangesRefreshBatch {
  readonly requestedAt: number;
  readonly startedAt: number;
  readonly inFlightWaitMs: number;
  readonly rediscover: boolean;
  readonly eventCounts: ReadonlyMap<ChangesLoadReason, number>;
  readonly reason: string;
  hasFollowUp(): boolean;
}

export interface ChangesRefreshCoordinatorOptions {
  quietMinMs?: number;
  quietMaxMs?: number;
  maxWaitMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

const DEFAULT_QUIET_MIN_MS = 250;
const DEFAULT_QUIET_MAX_MS = 500;
const DEFAULT_MAX_WAIT_MS = 1_000;

/**
 * Coalesces raw Git/workspace events before starting a single refresh. Events
 * arriving during a refresh become one follow-up and never cancel active work.
 */
export class ChangesRefreshCoordinator {
  private readonly quietMinMs: number;
  private readonly quietMaxMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimer: (timer: unknown) => void;
  private pending: PendingRefresh | undefined;
  private timer: unknown;
  private running = false;
  private runningFollowUp = false;
  private disposed = false;

  constructor(
    private readonly runRefresh: (batch: ChangesRefreshBatch) => Promise<void>,
    options: ChangesRefreshCoordinatorOptions = {},
  ) {
    this.quietMinMs = options.quietMinMs ?? DEFAULT_QUIET_MIN_MS;
    this.quietMaxMs = options.quietMaxMs ?? DEFAULT_QUIET_MAX_MS;
    this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.now = options.now ?? (() => performance.now());
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  request(request: ChangesRefreshRequest): void {
    if (this.disposed) {
      return;
    }
    const now = this.now();
    if (!this.pending) {
      this.pending = {
        firstAt: now,
        lastAt: now,
        inFlightSince: this.running ? now : undefined,
        inFlightWaitMs: 0,
        followUp: this.running && !this.runningFollowUp,
        explicit: Boolean(request.immediate),
        rediscover: request.rediscover,
        eventCounts: new Map(),
      };
    }
    this.pending.lastAt = now;
    this.pending.explicit ||= Boolean(request.immediate);
    this.pending.rediscover ||= request.rediscover;
    increment(this.pending.eventCounts, request.reason);

    if (this.running) {
      return;
    }
    if (request.immediate) {
      this.clearScheduledTimer();
      this.startPending();
      return;
    }
    this.schedulePending();
  }

  hasPendingRefresh(): boolean {
    return Boolean(
      this.pending &&
        !(this.runningFollowUp && !this.pending.explicit),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
    this.clearScheduledTimer();
  }

  private schedulePending(): void {
    const pending = this.pending;
    if (!pending || this.running || this.disposed) {
      return;
    }
    this.clearScheduledTimer();
    const now = this.now();
    const eventCount = totalEvents(pending.eventCounts);
    const adaptiveQuietMs = Math.min(
      this.quietMaxMs,
      this.quietMinMs + Math.max(0, eventCount - 1) * 25,
    );
    const quietDue = pending.lastAt + adaptiveQuietMs;
    const maxDue = pending.firstAt + this.maxWaitMs;
    const delayMs = Math.max(0, Math.min(quietDue, maxDue) - now);
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.startPending();
    }, delayMs);
  }

  private startPending(): void {
    const pending = this.pending;
    if (!pending || this.running || this.disposed) {
      return;
    }
    this.pending = undefined;
    this.running = true;
    this.runningFollowUp = pending.followUp;
    const startedAt = this.now();
    if (pending.inFlightSince !== undefined) {
      pending.inFlightWaitMs += Math.max(0, startedAt - pending.inFlightSince);
    }
    const batch: ChangesRefreshBatch = {
      requestedAt: pending.firstAt,
      startedAt,
      inFlightWaitMs: pending.inFlightWaitMs,
      rediscover: pending.rediscover,
      eventCounts: new Map(pending.eventCounts),
      reason: formatChangesRefreshReason(pending.eventCounts),
      hasFollowUp: () =>
        Boolean(
          this.pending &&
            !(pending.followUp && !this.pending.explicit),
        ),
    };
    void this.runRefresh(batch)
      .catch(() => undefined)
      .finally(() => {
        this.running = false;
        this.runningFollowUp = false;
        if (!this.pending || this.disposed) {
          return;
        }
        if (pending.followUp && !this.pending.explicit) {
          this.pending = undefined;
          return;
        }
        if (this.pending.inFlightSince !== undefined) {
          this.pending.inFlightWaitMs += Math.max(0, this.now() - this.pending.inFlightSince);
          this.pending.inFlightSince = undefined;
        }
        this.schedulePending();
      });
  }

  private clearScheduledTimer(): void {
    if (this.timer === undefined) {
      return;
    }
    this.clearTimer(this.timer);
    this.timer = undefined;
  }
}

export class BootstrapPostGuard {
  private published = false;

  claim(): boolean {
    if (this.published) {
      return false;
    }
    this.published = true;
    return true;
  }
}

export function formatChangesRefreshReason(
  counts: ReadonlyMap<ChangesLoadReason, number>,
): string {
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => formatReasonCount(reason, count))
    .join(" + ");
}

export function formatChangesRefreshEvents(
  counts: ReadonlyMap<ChangesLoadReason, number>,
): string {
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${eventLabel(reason)} x${count}`)
    .join(", ");
}

interface PendingRefresh {
  firstAt: number;
  lastAt: number;
  inFlightSince: number | undefined;
  inFlightWaitMs: number;
  followUp: boolean;
  explicit: boolean;
  rediscover: boolean;
  eventCounts: Map<ChangesLoadReason, number>;
}

function increment(counts: Map<ChangesLoadReason, number>, reason: ChangesLoadReason): void {
  counts.set(reason, (counts.get(reason) ?? 0) + 1);
}

function totalEvents(counts: ReadonlyMap<ChangesLoadReason, number>): number {
  let total = 0;
  for (const count of counts.values()) {
    total += count;
  }
  return total;
}

function formatReasonCount(reason: ChangesLoadReason, count: number): string {
  if (count === 1) {
    return reason;
  }
  switch (reason) {
    case "Git state event":
      return `${count} Git state events`;
    case "workspace change":
      return `${count} workspace changes`;
    case "config change":
      return `${count} config changes`;
    case "restore update":
      return `${count} restore updates`;
    default:
      return `${count} ${reason} events`;
  }
}

function eventLabel(reason: ChangesLoadReason): string {
  switch (reason) {
    case "Git state event":
      return "Git state";
    case "workspace change":
      return "workspace";
    case "config change":
      return "config";
    case "restore update":
      return "restore";
    default:
      return reason;
  }
}
