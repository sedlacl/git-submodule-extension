import type { SubmodulePointerUpdate } from "./submoduleChoreTypes.js";

export const DEFAULT_SUBMODULE_CHORE_SUBJECT = "chore: update submodules";
export const MAX_SUBMODULE_COMMIT_SUBJECTS = 30;
export const UNSTAGED_SUBMODULE_CHORE_NOTE =
  "Note: Some submodule pointer updates are not staged yet; stage them before committing.";

export interface BuildSubmoduleChoreMessageInput {
  updates: readonly SubmodulePointerUpdate[];
  subject?: string;
}

export interface SubmoduleChoreMessage {
  subject: string;
  body: string;
  message: string;
  hasUnstagedUpdates: boolean;
  unstagedNote: string | null;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export function buildSubmoduleChoreMessage(input: BuildSubmoduleChoreMessageInput): SubmoduleChoreMessage {
  const subject = input.subject?.trim() || DEFAULT_SUBMODULE_CHORE_SUBJECT;
  const hasUnstagedUpdates = input.updates.some((update) => !update.staged);
  const unstagedNote = hasUnstagedUpdates ? UNSTAGED_SUBMODULE_CHORE_NOTE : null;
  const bodyLines: string[] = [];

  if (unstagedNote) {
    bodyLines.push(unstagedNote);
  }

  for (const update of input.updates) {
    if (bodyLines.length > 0) {
      bodyLines.push("");
    }

    const stagedSuffix = update.staged ? "" : " (not staged)";
    bodyLines.push(
      `${update.path} (${shortSha(update.beforeHead)} -> ${shortSha(update.afterHead)}, ${update.branch})${stagedSuffix}`,
    );

    const visibleSubjects = update.subjects.slice(0, MAX_SUBMODULE_COMMIT_SUBJECTS);
    for (const commitSubject of visibleSubjects) {
      bodyLines.push(`- ${commitSubject}`);
    }

    const remaining = update.subjects.length - visibleSubjects.length;
    if (remaining > 0) {
      bodyLines.push(`- ... ${remaining} more commits`);
    }
  }

  const body = bodyLines.length > 0 ? `\n\n${bodyLines.join("\n")}` : "";
  return {
    subject,
    body,
    message: bodyLines.length > 0 ? `${subject}${body}` : subject,
    hasUnstagedUpdates,
    unstagedNote,
  };
}
