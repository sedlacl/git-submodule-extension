import { execFile } from "node:child_process";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import * as vscode from "vscode";
import { safeError, type ActionDiagnostics, type ActionWriter } from "../actionDiagnostics.js";
import type { GitCli, GitRunRecord } from "../git/gitCli.js";
import { canonicalizeRepoPath } from "../git/pathUtils.js";
import type { VsCodeGitApiAdapter } from "../git/vscodeGitApi.js";
import {
  assessFsmonitor,
  hasFsmonitorDaemon,
  isRemotePath,
  parseNetworkDrives,
  SLOW_STATUS_MS,
  StatusTimings,
  type FsmonitorEnvironment,
  type FsmonitorRepoFacts,
  type FsmonitorVerdict,
} from "./fsmonitorAdvisor.js";

export const FSMONITOR_COMMAND = "gitSubmodule.analyzeFsmonitor";
const SUGGEST_SETTING = "fsmonitor.suggest";
const NEVER_KEY = "gitSubmodule.fsmonitor.neverSuggest";

export interface RegisterFsmonitorAdvisorOptions {
  cli: GitCli & { onDidRun(listener: (record: GitRunRecord) => void): { dispose(): void } };
  gitApi: VsCodeGitApiAdapter;
  output: vscode.OutputChannel;
  writeDiagnostic: ActionWriter;
  actionDiagnostics: ActionDiagnostics;
  /** Holds the repositories the user asked never to be offered fsmonitor for. */
  workspaceState: vscode.Memento;
}

interface Assessed {
  readonly facts: FsmonitorRepoFacts;
  readonly verdict: FsmonitorVerdict;
}

/**
 * Times the `git status` runs the extension makes anyway (loading CHANGES, branch restore).
 * When a repository's typical status is slow, it offers to turn on fsmonitor there, once per
 * window. The command analyzes every open repository on request.
 */
export function registerFsmonitorAdvisor(options: RegisterFsmonitorAdvisorOptions): vscode.Disposable {
  const timings = new StatusTimings();
  const offered = new Set<string>();
  const facts = new FactsReader(options.cli);

  const observer = options.cli.onDidRun((record) => {
    if (record.args[0] !== "status" || record.exitCode !== 0) {
      return;
    }
    const key = canonicalizeRepoPath(record.cwd);
    const median = timings.record(key, record.durationMs);
    if (median === undefined || median < SLOW_STATUS_MS || offered.has(key)) {
      return;
    }
    if (!suggestionsEnabled() || neverList(options.workspaceState).includes(key)) {
      return;
    }
    offered.add(key);
    void suggest(options, facts, record.cwd, median).catch((error: unknown) =>
      options.writeDiagnostic(`[fsmonitor] ${path.basename(record.cwd)}: ${safeError(error)}`),
    );
  });

  const command = vscode.commands.registerCommand(FSMONITOR_COMMAND, () => analyze(options, facts, timings));
  return new vscode.Disposable(() => {
    observer.dispose();
    command.dispose();
  });
}

async function suggest(options: RegisterFsmonitorAdvisorOptions, facts: FactsReader, rootPath: string, statusMs: number): Promise<void> {
  const assessed = await facts.assess(rootPath, statusMs);
  if (assessed.verdict.kind !== "recommended") {
    return;
  }
  const name = path.basename(rootPath);
  options.writeDiagnostic(`[fsmonitor] ${name}: suggested (${assessed.verdict.reason})`);
  const choice = await vscode.window.showInformationMessage(
    `git status in '${name}' takes ${(statusMs / 1000).toFixed(1)}s. Turn on Git's fsmonitor there? ` +
      "It writes core.fsmonitor=true and core.untrackedCache=true to the repository's local config and runs one fsmonitor daemon for it.",
    "Turn On",
    "Not Now",
    "Never for This Repository",
  );
  if (choice === "Turn On") {
    await turnOn(options, [rootPath], "fsmonitor suggestion");
  } else if (choice === "Never for This Repository") {
    const key = canonicalizeRepoPath(rootPath);
    await options.workspaceState.update(NEVER_KEY, [...new Set([...neverList(options.workspaceState), key])]);
  }
}

async function analyze(options: RegisterFsmonitorAdvisorOptions, facts: FactsReader, timings: StatusTimings): Promise<void> {
  const roots = [...new Set(options.gitApi.getOpenRepositoryPaths())].sort((a, b) => a.localeCompare(b));
  const action = options.actionDiagnostics.start("analyze fsmonitor", { repositories: roots.length });
  if (roots.length === 0) {
    action.cancelled("no open repositories");
    void vscode.window.showInformationMessage("Git has no open repositories to analyze.");
    return;
  }

  let assessed: Assessed[];
  try {
    assessed = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Timing git status for fsmonitor", cancellable: true },
      async (progress, token) => {
        const results: Assessed[] = [];
        for (const rootPath of roots) {
          if (token.isCancellationRequested) {
            break;
          }
          progress.report({ message: path.basename(rootPath), increment: 100 / roots.length });
          // The user asked for this analysis, so a repository not timed yet is timed now.
          const statusMs = timings.median(canonicalizeRepoPath(rootPath)) ?? (await timeStatus(options.cli, rootPath));
          results.push(await facts.assess(rootPath, statusMs));
        }
        return results;
      },
    );
  } catch (error) {
    action.failed(error);
    void vscode.window.showErrorMessage(`fsmonitor analysis failed: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  report(options.output, assessed);
  const recommended = assessed.filter((item) => item.verdict.kind === "recommended");
  const pickable = assessed.filter((item) => item.verdict.kind === "recommended" || item.verdict.kind === "fast");
  const enabled = assessed.filter((item) => item.verdict.kind === "enabled").length;
  const summary = { recommended: recommended.length, enabled, analyzed: assessed.length };

  if (recommended.length === 0) {
    action.completed(summary);
    const choice = await vscode.window.showInformationMessage(
      `No repository has a slow git status (${enabled} already use fsmonitor). Details are in the Output channel Git Submodule.`,
      "Show Output",
    );
    if (choice === "Show Output") {
      options.output.show(true);
    }
    return;
  }

  const picked = await vscode.window.showQuickPick(
    pickable.map((item) => ({
      label: path.basename(item.facts.rootPath),
      description: item.facts.rootPath,
      detail: `${item.verdict.kind === "recommended" ? "Recommended" : "Not needed"}: ${item.verdict.reason}`,
      picked: item.verdict.kind === "recommended",
      item,
    })),
    {
      canPickMany: true,
      title: "Turn on fsmonitor",
      placeHolder: `${recommended.length} of ${assessed.length} repositories have a slow git status; pick where to turn fsmonitor on`,
      matchOnDescription: true,
    },
  );
  if (!picked || picked.length === 0) {
    action.cancelled("nothing picked", summary);
    return;
  }
  const confirmed = await vscode.window.showWarningMessage(
    `Turn on fsmonitor in ${count(picked.length)}?`,
    {
      modal: true,
      detail:
        "Writes core.fsmonitor=true and core.untrackedCache=true to each repository's local Git config. " +
        "Git then starts one fsmonitor daemon per repository on its next command. " +
        "Undo with: git config --local --unset core.fsmonitor",
    },
    "Turn On",
  );
  if (confirmed !== "Turn On") {
    action.cancelled("confirmation dismissed", summary);
    return;
  }
  action.completed(summary);
  await turnOn(
    options,
    picked.map(({ item }) => item.facts.rootPath),
    "turn on fsmonitor",
  );
}

async function turnOn(options: RegisterFsmonitorAdvisorOptions, roots: readonly string[], kind: string): Promise<void> {
  const action = options.actionDiagnostics.start(kind, { repositories: roots.length });
  const failed: string[] = [];
  for (const rootPath of roots) {
    try {
      await options.cli.run({ cwd: rootPath, args: ["config", "--local", "core.fsmonitor", "true"] });
      await options.cli.run({ cwd: rootPath, args: ["config", "--local", "core.untrackedCache", "true"] });
      options.writeDiagnostic(`[fsmonitor] ${path.basename(rootPath)}: turned on`);
    } catch (error) {
      failed.push(path.basename(rootPath));
      options.writeDiagnostic(`[fsmonitor] ${path.basename(rootPath)}: ${safeError(error)}`);
    }
  }
  if (failed.length > 0) {
    action.failed(new Error(`failed in ${failed.length} of ${roots.length}`));
    void vscode.window.showErrorMessage(`fsmonitor could not be turned on in: ${failed.join(", ")}. Details are in the Output channel.`);
    return;
  }
  action.completed({ turnedOn: roots.length });
  void vscode.window.showInformationMessage(`fsmonitor is on in ${count(roots.length)}.`);
}

/** Reads what the verdict needs besides the status time; the Git build and drives are read once. */
class FactsReader {
  private environment: Promise<FsmonitorEnvironment> | undefined;
  private networkDrives: Promise<Set<string>> | undefined;

  constructor(private readonly cli: GitCli) {}

  async assess(rootPath: string, statusMs: number | undefined): Promise<Assessed> {
    this.environment ??= this.cli
      .run({ cwd: rootPath, args: ["version", "--build-options"], allowedExitCodes: [0, 129] })
      .then((result) => ({ daemonSupported: result.exitCode === 0 && hasFsmonitorDaemon(result.stdout) }));
    this.networkDrives ??= readNetworkDrives();
    const [environment, drives, fsmonitor] = await Promise.all([
      this.environment,
      this.networkDrives,
      this.cli
        .run({ cwd: rootPath, args: ["config", "--get", "core.fsmonitor"], allowedExitCodes: [0, 1] })
        .then((result) => (result.exitCode === 0 ? result.stdout.trim() : undefined)),
    ]);
    const facts: FsmonitorRepoFacts = { rootPath, statusMs, fsmonitor, remote: isRemotePath(rootPath, drives) };
    return { facts, verdict: assessFsmonitor(facts, environment) };
  }
}

async function timeStatus(cli: GitCli, cwd: string): Promise<number | undefined> {
  const started = performance.now();
  const result = await cli
    .run({
      cwd,
      args: ["status", "--porcelain=v2", "--untracked-files=all", "--ignore-submodules=all"],
      timeoutMs: 60_000,
    })
    .catch(() => undefined);
  return result ? performance.now() - started : undefined;
}

function readNetworkDrives(): Promise<Set<string>> {
  if (process.platform !== "win32") {
    return Promise.resolve(new Set());
  }
  return new Promise((resolve) => {
    execFile("net", ["use"], { windowsHide: true, timeout: 5_000, encoding: "utf8" }, (error, stdout) => {
      resolve(error ? new Set() : parseNetworkDrives(String(stdout)));
    });
  });
}

function suggestionsEnabled(): boolean {
  return vscode.workspace.getConfiguration("gitSubmodule").get<boolean>(SUGGEST_SETTING, true) !== false;
}

function neverList(state: vscode.Memento): string[] {
  const value = state.get<unknown>(NEVER_KEY);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function report(channel: vscode.OutputChannel, assessed: readonly Assessed[]): void {
  channel.appendLine("[fsmonitor] analysis:");
  for (const { facts, verdict } of assessed) {
    channel.appendLine(`[fsmonitor]   ${verdict.kind.padEnd(11)} ${path.basename(facts.rootPath)}: ${verdict.reason}`);
  }
}

function count(repositories: number): string {
  return `${repositories} ${repositories === 1 ? "repository" : "repositories"}`;
}
