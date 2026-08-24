import { describe, expect, it } from "vitest";
import { ActionDiagnostics, safeError } from "../../src/actionDiagnostics.js";
import { createChangesDiagnosticWriter } from "../../src/views/changesLoadDiagnostics.js";

describe("ActionDiagnostics", () => {
  it("uses deterministic wall-clock timestamps and monotonic durations", () => {
    const lines: string[] = [];
    let monotonicNow = 100;
    const write = createChangesDiagnosticWriter(
      (line) => lines.push(line),
      () => new Date(2026, 7, 24, 15, 57, 12, 184),
    );
    const diagnostics = new ActionDiagnostics(write, () => monotonicNow);

    const action = diagnostics.start("stage", { repository: "httpendpoint" });
    monotonicNow = 134;
    action.completed({ resources: 2 });

    expect(lines).toEqual([
      "[15:57:12.184] [action #1] stage started (repository: httpendpoint)",
      "[15:57:12.184] [action #1] stage completed 34ms (resources: 2)",
    ]);
  });

  it("emits one terminal result even when callers finish repeatedly", () => {
    const lines: string[] = [];
    let now = 0;
    const action = new ActionDiagnostics((line) => lines.push(line), () => now).start("commit");
    now = 1_200;

    action.started({ repository: "duplicate" });
    expect(action.cancelled("empty message")).toBe(true);
    expect(action.completed()).toBe(false);
    expect(action.failed(new Error("late"))).toBe(false);
    expect(lines).toEqual([
      "[action #1] commit started",
      "[action #1] commit cancelled 1.20s (reason: empty message)",
    ]);
  });

  it("keeps concurrent action ids and phase lines attributable", () => {
    const lines: string[] = [];
    let now = 10;
    const diagnostics = new ActionDiagnostics((line) => lines.push(line), () => now);
    const first = diagnostics.start("fetch");
    now = 12;
    const second = diagnostics.start("sync");
    now = 20;
    first.completed();
    now = 25;
    second.cancelled("confirmation dismissed");

    expect(lines).toEqual([
      "[action #1] fetch started",
      "[action #2] sync started",
      "[action #1] fetch completed 10ms",
      "[action #2] sync cancelled 13ms (reason: confirmation dismissed)",
    ]);
  });

  it("records unavailable separately from user cancellation", () => {
    const lines: string[] = [];
    const action = new ActionDiagnostics((line) => lines.push(line), () => 5).start("generate message");

    action.unavailable("AI unavailable for target", { "pointer updates": 0 });

    expect(lines).toEqual([
      "[action #1] generate message started",
      "[action #1] generate message unavailable 0ms (reason: AI unavailable for target; pointer updates: 0)",
    ]);
  });

  it("redacts credentials, authorization, URLs, paths, and line breaks", () => {
    const sanitized = safeError(
      new Error(
        "Authorization: Bearer abc123\npassword=hunter2 token=secret https://user:pass@example.test/repo.git git@example.test:repo.git /home/me/private/repo",
      ),
    );

    expect(sanitized).not.toContain("abc123");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("secret");
    expect(sanitized).not.toContain("user:pass");
    expect(sanitized).not.toContain("git@example.test");
    expect(sanitized).not.toContain("/home/me/private/repo");
    expect(sanitized).toContain("[redacted]");
  });
});
