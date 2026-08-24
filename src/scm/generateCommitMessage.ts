import type { SubmoduleChoreMessage } from "./submoduleChoreMessage.js";

/** Public command IDs that fill a commit subject without creating a commit. */
export const KNOWN_GENERATE_COMMIT_MESSAGE_COMMANDS = [
  "git.generateCommitMessage",
  "github.copilot.git.generateCommitMessage",
  "github.copilot.command.generateCommitMessage",
] as const;

const GENERATE_COMMIT_MESSAGE_PATTERN = /(?:^|\.)generate(?:Git)?CommitMessage$/i;

export function pickPublicGenerateCommitMessageCommand(commands: readonly string[]): string | undefined {
  const available = new Set(commands);
  for (const id of KNOWN_GENERATE_COMMIT_MESSAGE_COMMANDS) {
    if (available.has(id)) {
      return id;
    }
  }
  return commands.find(
    (id) => GENERATE_COMMIT_MESSAGE_PATTERN.test(id) && !id.startsWith("gitSubmodule."),
  );
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
