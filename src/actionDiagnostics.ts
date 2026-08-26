import { performance } from "node:perf_hooks";
import { formatDuration } from "./views/changesLoadDiagnostics.js";

export type ActionDetail = string | number | boolean | undefined;
export type ActionDetails = Readonly<Record<string, ActionDetail>>;
export type ActionResult = "completed" | "unavailable" | "cancelled" | "failed";
export type ActionWriter = (line: string) => void;

export interface ActionOutcome {
  result: ActionResult;
  reason?: string;
  details?: ActionDetails;
  error?: unknown;
}

export class ActionDiagnostics {
  private nextId = 1;

  constructor(
    private readonly writeLine: ActionWriter,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(kind: string, details: ActionDetails = {}): ActionRun {
    const run = new ActionRun(this.nextId++, kind, this.writeLine, this.now);
    run.started(details);
    return run;
  }
}

export class ActionRun {
  private readonly startedAt: number;
  private startedWritten = false;
  private terminalResult: ActionResult | undefined;

  constructor(
    readonly id: number,
    readonly kind: string,
    private readonly writeLine: ActionWriter,
    private readonly now: () => number,
  ) {
    this.startedAt = now();
  }

  mark(): number {
    return this.now();
  }

  started(details: ActionDetails = {}): void {
    if (this.startedWritten) {
      return;
    }
    this.startedWritten = true;
    this.writeLine(`${this.prefix()} started${formatDetails(details)}`);
  }

  beginPhase(label: string, details: ActionDetails = {}): number {
    const startedAt = this.now();
    if (!this.terminalResult) {
      this.writeLine(`${this.prefix(label)} started${formatDetails(details)}`);
    }
    return startedAt;
  }

  phase(label: string, startedAt: number, details: ActionDetails = {}): void {
    if (this.terminalResult) {
      return;
    }
    this.writeLine(
      `${this.prefix(label)} ${formatDuration(elapsed(startedAt, this.now()))}${formatDetails(details)}`,
    );
  }

  completed(details: ActionDetails = {}): boolean {
    return this.terminal("completed", details);
  }

  unavailable(reason: string, details: ActionDetails = {}): boolean {
    return this.terminal("unavailable", { reason, ...details });
  }

  cancelled(reason: string, details: ActionDetails = {}): boolean {
    return this.terminal("cancelled", { reason, ...details });
  }

  failed(error: unknown, details: ActionDetails = {}): boolean {
    return this.terminal("failed", { ...details, error: safeError(error) });
  }

  private terminal(result: ActionResult, details: ActionDetails): boolean {
    if (this.terminalResult) {
      return false;
    }
    this.terminalResult = result;
    this.writeLine(
      `${this.prefix()} ${result} ${formatDuration(elapsed(this.startedAt, this.now()))}${formatDetails(details)}`,
    );
    return true;
  }

  private prefix(label = this.kind): string {
    return `[action #${this.id}] ${safeDiagnosticText(label)}`;
  }
}

export function safeError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return safeDiagnosticText(value).replace(
    /(^|\s)(?:[A-Za-z]:[\\/]|\/)[^\s;,)]*/g,
    "$1[path redacted]",
  );
}

export function safeDiagnosticText(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\b(authorization|proxy-authorization)\s*:\s*\S+(?:\s+\S+)?/gi, "$1: [redacted]")
    .replace(/\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[authorization redacted]")
    .replace(
      /\b(password|passwd|token|access[_-]?token|refresh[_-]?token|secret|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi, "[url redacted]")
    .replace(/\b[\w.+-]+@[\w.-]+:[^\s)]+/g, "[remote redacted]")
    .slice(0, 300);
}

function formatDetails(details: ActionDetails): string {
  const entries = Object.entries(details).filter((entry): entry is [string, string | number | boolean] =>
    entry[1] !== undefined
  );
  if (entries.length === 0) {
    return "";
  }
  return ` (${entries
    .map(([key, value]) => `${safeDiagnosticText(key)}: ${safeDiagnosticText(String(value))}`)
    .join("; ")})`;
}

function elapsed(startedAt: number, endedAt: number): number {
  const value = endedAt - startedAt;
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
