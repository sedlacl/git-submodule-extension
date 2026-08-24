import { describe, expect, it } from "vitest";
import {
  createChangesDiagnosticWriter,
  formatAdoptedCountBatch,
  formatAdoptedExpansion,
  formatChangesLoadSummary,
  slowestPhase,
} from "../../../src/views/changesLoadDiagnostics.js";

describe("changes load diagnostics", () => {
  it("formats the generation, propagated reason, phases, result, and bottleneck", () => {
    const lines: string[] = [];
    const write = createChangesDiagnosticWriter((line) => lines.push(line), fixedNow);
    write(
      formatChangesLoadSummary({
        generation: 7,
        reason: "Git state event",
        result: "final",
        totalMs: 825,
        queuedCoalescedMs: 100,
        inFlightWaitMs: 50,
        eventSummary: "Git state x8, workspace x3",
        followUp: true,
        bootstrapSnapshotMs: 5,
        bootstrapBuildMs: 3,
        bootstrapPostMs: 2,
        discoveryMs: 611,
        treeBuildMs: 18,
        serializationMs: 12,
        finalPostMs: 4,
        renderAckMs: 20,
      }),
    );
    const line = lines[0]!;

    expect(line).toContain("[15:25:41.382] [changes #7] final 825ms");
    expect(line).toContain("reason: Git state event");
    expect(line).toContain("events: Git state x8, workspace x3");
    expect(line).toContain("follow-up: yes");
    expect(line).toContain("queued/coalesced 100ms");
    expect(line).toContain("in-flight wait 50ms");
    expect(line).toContain("discovery 611ms");
    expect(line).toContain("slowest: discovery 611ms");
  });

  it("formats safe errors and cancelled adopted-count batches", () => {
    const lines: string[] = [];
    const write = createChangesDiagnosticWriter((line) => lines.push(line), fixedNow);
    const error = formatChangesLoadSummary({
      generation: 3,
      reason: "retry",
      result: "error",
      totalMs: 20,
      bootstrapSnapshotMs: 0,
      bootstrapBuildMs: 0,
      bootstrapPostMs: 1,
      discoveryMs: 15,
      treeBuildMs: 0,
      serializationMs: 1,
      finalPostMs: 1,
      renderAckMs: 2,
      errorPhase: "recursive discovery",
      errorMessage: "git failed\nwithout leaking another line",
    });
    write(error);
    expect(lines[0]).toContain("[15:25:41.382] [changes #3] error 20ms");
    expect(lines[0]).toContain("phase: recursive discovery");
    expect(lines[0]).toContain("error: git failed without leaking another line");

    const adopted = formatAdoptedCountBatch({
      generation: 3,
      durationMs: 1_920,
      queuedCount: 12,
      cacheHits: 3,
      cacheMisses: 9,
      gitCalls: 9,
      concurrencyLimit: 4,
      peakConcurrency: 4,
      slowestCallMs: 487,
      errors: 0,
      cancelled: true,
    });
    write(adopted);
    expect(lines[1]).toBe(
      "[15:25:41.382] [changes #3] adopted counts 1.92s (12 groups; cache 3/12; misses 9; git calls 9; concurrency 4/4; slowest call 487ms stale/cancelled)",
    );
  });

  it("timestamps stale, lazy-expansion, and slow-call diagnostic lines centrally", () => {
    const lines: string[] = [];
    const write = createChangesDiagnosticWriter((line) => lines.push(line), fixedNow);

    write("[changes #8] stale/cancelled 40ms");
    write(
      formatAdoptedExpansion({
        generation: 8,
        durationMs: 25,
        fileCount: 4,
        cacheHit: false,
        ok: true,
      }),
    );
    write("[changes] adopted git diff slow 300ms (kind staged; files 4)");

    expect(lines).toEqual([
      "[15:25:41.382] [changes #8] stale/cancelled 40ms",
      "[15:25:41.382] [changes #8] adopted expansion final 25ms (4 files; cache miss)",
      "[15:25:41.382] [changes] adopted git diff slow 300ms (kind staged; files 4)",
    ]);
  });

  it("aggregates the slowest phase without mutating input", () => {
    const phases = [["build", 18], ["discovery", 611], ["ack", 24]] as const;
    expect(slowestPhase(phases)).toEqual(["discovery", 611]);
    expect(phases[0]).toEqual(["build", 18]);
  });
});

function fixedNow(): Date {
  return new Date(2026, 7, 24, 15, 25, 41, 382);
}
