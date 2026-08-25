export type ChangesLoadReason =
  | "activation"
  | "view resolve"
  | "view visible"
  | "Git state event"
  | "post-action overlay"
  | "explicit refresh"
  | "repository opened"
  | "repository closed"
  | "workspace folders changed"
  | "config change"
  | "file icon theme"
  | "restore update"
  | "retry";

export type ChangesLoadResult = "final" | "stale/cancelled" | "error";

export interface ChangesLoadSummary {
  generation: number;
  reason: string;
  result: ChangesLoadResult;
  totalMs: number;
  queuedCoalescedMs?: number;
  inFlightWaitMs?: number;
  eventSummary?: string;
  followUp?: boolean;
  bootstrapSnapshotMs: number;
  bootstrapBuildMs: number;
  bootstrapPostMs: number;
  discoveryMs: number;
  treeBuildMs: number;
  serializationMs: number;
  finalPostMs: number;
  renderAckMs: number;
  errorPhase?: string;
  errorMessage?: string;
}

export interface AdoptedCountBatchSummary {
  generation: number;
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

export interface AdoptedExpansionSummary {
  generation: number;
  durationMs: number;
  fileCount: number;
  cacheHit: boolean;
  ok: boolean;
}

export type ChangesDiagnosticWriter = (line: string) => void;

export function createChangesDiagnosticWriter(
  writeLine: ChangesDiagnosticWriter,
  now: () => Date = () => new Date(),
): ChangesDiagnosticWriter {
  return (line) => writeLine(`${formatWallClockTimestamp(now())} ${line}`);
}

export function formatWallClockTimestamp(date: Date): string {
  return `[${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}]`;
}

export function formatChangesLoadSummary(summary: ChangesLoadSummary): string {
  const phases = phaseEntries(summary);
  const slowest = slowestPhase(phases);
  const details = phases.map(([name, duration]) => `${name} ${formatDuration(duration)}`).join(", ");
  const events = summary.eventSummary ? `; events: ${summary.eventSummary}` : "";
  const followUp = summary.followUp === undefined ? "" : `; follow-up: ${summary.followUp ? "yes" : "no"}`;
  const error =
    summary.result === "error"
      ? `; phase: ${safeText(summary.errorPhase ?? "unknown")}; error: ${safeText(summary.errorMessage ?? "Unknown error")}`
      : "";
  return `[changes #${summary.generation}] ${summary.result} ${formatDuration(summary.totalMs)} (reason: ${summary.reason}${events}${followUp}; ${details}; slowest: ${slowest[0]} ${formatDuration(slowest[1])}${error})`;
}

export function formatAdoptedCountBatch(summary: AdoptedCountBatchSummary): string {
  const result = summary.cancelled ? " stale/cancelled" : summary.errors > 0 ? `; errors ${summary.errors}` : "";
  return `[changes #${summary.generation}] adopted counts ${formatDuration(summary.durationMs)} (${summary.queuedCount} groups; cache ${summary.cacheHits}/${summary.queuedCount}; misses ${summary.cacheMisses}; git calls ${summary.gitCalls}; concurrency ${summary.peakConcurrency}/${summary.concurrencyLimit}; slowest call ${formatDuration(summary.slowestCallMs)}${result})`;
}

export function formatAdoptedExpansion(summary: AdoptedExpansionSummary): string {
  return `[changes #${summary.generation}] adopted expansion ${summary.ok ? "final" : "error"} ${formatDuration(summary.durationMs)} (${summary.fileCount} files; cache ${summary.cacheHit ? "hit" : "miss"})`;
}

export function formatDuration(durationMs: number): string {
  const value = Math.max(0, durationMs);
  return value >= 1_000 ? `${(value / 1_000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

export function slowestPhase(
  phases: readonly (readonly [name: string, durationMs: number])[],
): readonly [name: string, durationMs: number] {
  return phases.reduce<readonly [string, number]>(
    (slowest, phase) => (phase[1] > slowest[1] ? phase : slowest),
    ["none", 0],
  );
}

function phaseEntries(summary: ChangesLoadSummary): Array<readonly [string, number]> {
  return [
    ["queued/coalesced", summary.queuedCoalescedMs ?? 0],
    ["in-flight wait", summary.inFlightWaitMs ?? 0],
    ["bootstrap snapshot", summary.bootstrapSnapshotMs],
    ["bootstrap build", summary.bootstrapBuildMs],
    ["bootstrap post", summary.bootstrapPostMs],
    ["discovery", summary.discoveryMs],
    ["tree build", summary.treeBuildMs],
    ["serialization", summary.serializationMs],
    ["final post", summary.finalPostMs],
    ["render ack", summary.renderAckMs],
  ];
}

function safeText(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, "0");
}
