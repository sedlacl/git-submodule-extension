import { sameRepoPath } from "../git/pathUtils.js";
import type { SubmoduleChoreMessage } from "./submoduleChoreMessage.js";

/** Public command IDs that fill a commit subject without creating a commit. */
export const KNOWN_GENERATE_COMMIT_MESSAGE_COMMANDS = [
  "cursor.generateGitCommitMessage",
  "git.generateCommitMessage",
  "github.copilot.git.generateCommitMessage",
  "github.copilot.command.generateCommitMessage",
] as const;

export const CURSOR_GENERATE_GIT_COMMIT_MESSAGE = "cursor.generateGitCommitMessage";

export const COMMIT_DRAFT_WAIT_TIMEOUT_MS = 1_500;

export type GenerateCommitSubjectResult =
  | { result: "generated"; command: string; subject: string }
  | { result: "unavailable"; command?: undefined }
  | { result: "unsupported target"; command: string }
  | { result: "no result"; command: string }
  | { result: "cancelled"; command: string }
  | { result: "failed"; command?: string; error: unknown };

export interface PublicCommitMessageCommandRunner {
  listCommands(): Promise<readonly string[]>;
  /** Known providers resolve without message text and side-effect the SCM draft. */
  executeCommand(command: string, rootPath: string): Promise<void>;
  supportsTarget(command: string, rootPath: string): boolean;
  readDraft(): string | undefined;
  waitForDraftChange?(before: string, timeoutMs: number): Promise<string | undefined>;
  isCancellationError?(error: unknown): boolean;
}

/** Cursor resolves the first command argument by matching `rootUri.toString()` to SCM `provider.rootUri`. */
export function supportsUriCommitMessageTargeting(command: string): boolean {
  return command === CURSOR_GENERATE_GIT_COMMIT_MESSAGE;
}

export function buildPublicGenerateCommitMessageCommandArgs(
  command: string,
  rootPath: string,
  fileUri: (path: string) => unknown = (value) => ({ scheme: "file", path: value }),
): readonly unknown[] {
  if (supportsUriCommitMessageTargeting(command)) {
    return [fileUri(rootPath)];
  }
  return [];
}

/**
 * Untargeted public commands are safe only when the requested repository is
 * the sole open Git repository. Cursor accepts a repository root `Uri` in
 * multi-repository workspaces.
 */
export function isPublicCommitMessageTargetSupported(
  repositories: readonly { rootPath: string }[],
  rootPath: string,
  command?: string,
): boolean {
  const inOpen = repositories.some((repo) => sameRepoPath(repo.rootPath, rootPath));
  if (!inOpen) {
    return false;
  }
  if (command && supportsUriCommitMessageTargeting(command)) {
    return true;
  }
  return repositories.length === 1 && sameRepoPath(repositories[0]!.rootPath, rootPath);
}

export function pickPublicGenerateCommitMessageCommand(commands: readonly string[]): string | undefined {
  const available = new Set(commands);
  for (const id of KNOWN_GENERATE_COMMIT_MESSAGE_COMMANDS) {
    if (available.has(id)) {
      return id;
    }
  }
  return undefined;
}

export async function generateCommitSubject(
  runner: PublicCommitMessageCommandRunner,
  rootPath: string,
): Promise<GenerateCommitSubjectResult> {
  let commands: readonly string[];
  try {
    commands = await runner.listCommands();
  } catch (error) {
    return { result: "failed", error };
  }
  const command = pickPublicGenerateCommitMessageCommand(commands);
  if (!command) {
    return { result: "unavailable" };
  }
  if (!runner.supportsTarget(command, rootPath)) {
    return { result: "unsupported target", command };
  }

  const before = runner.readDraft();
  if (before === undefined) {
    return { result: "unsupported target", command };
  }
  try {
    await runner.executeCommand(command, rootPath);
  } catch (error) {
    return runner.isCancellationError?.(error)
      ? { result: "cancelled", command }
      : { result: "failed", command, error };
  }
  let after = runner.readDraft();
  if (after === before && runner.waitForDraftChange) {
    after = await runner.waitForDraftChange(before, COMMIT_DRAFT_WAIT_TIMEOUT_MS);
  }
  if (after === undefined || after === before) {
    return { result: "no result", command };
  }
  const subject = firstCommitLine(after).trim();
  return subject
    ? { result: "generated", command, subject }
    : { result: "no result", command };
}

export function firstCommitLine(message: string): string {
  return message.split(/\r?\n/, 1)[0] ?? "";
}

/** Keep the existing subject (or chore default) and append a missing chore body. */
export function mergeCommitDraftWithChore(existing: string, chore: SubmoduleChoreMessage): string {
  const subject = firstCommitLine(existing).trim() || chore.subject;
  const existingBody = existing.split(/\r?\n/).slice(1).join("\n").trim();
  const choreBody = chore.body.trim();
  if (!choreBody) {
    return existing.trim() ? existing : chore.message;
  }
  const marker = choreBody.split(/\r?\n/, 1)[0] ?? "";
  if (existingBody && marker && existingBody.includes(marker)) {
    return existing;
  }
  const parts = [subject];
  if (existingBody) {
    parts.push("", existingBody);
  }
  parts.push("", choreBody);
  return parts.join("\n");
}
