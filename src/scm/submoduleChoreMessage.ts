import { displayNameFromRepoPath } from "../git/pathUtils.js";
import type { SubmoduleCommitEntry, SubmodulePointerUpdate } from "./submoduleChoreTypes.js";

export const DEFAULT_SUBMODULE_CHORE_SUBJECT = "chore: update submodules";
export const MAX_SUBMODULE_COMMIT_SUBJECTS = 30;
export const MAX_NESTED_SUBMODULE_DEPTH = 8;

export interface BuildSubmoduleChoreMessageInput {
  updates: readonly SubmodulePointerUpdate[];
  subject?: string;
}

export interface SubmoduleChoreMessage {
  subject: string;
  body: string;
  message: string;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}

export interface LeafCommitRef {
  directUpdatePath: string;
  commit: SubmoduleCommitEntry;
}

export function collectLeafCommits(updates: readonly SubmodulePointerUpdate[]): LeafCommitRef[] {
  const leaves: LeafCommitRef[] = [];
  for (const update of updates) {
    walkUpdateLeaves(update, update.path, leaves);
  }
  return leaves;
}

function walkUpdateLeaves(
  update: SubmodulePointerUpdate,
  directUpdatePath: string,
  leaves: LeafCommitRef[],
): void {
  for (const commit of update.commits) {
    if (commit.nestedUpdates.length === 0) {
      leaves.push({ directUpdatePath, commit });
      continue;
    }
    for (const nested of commit.nestedUpdates) {
      walkUpdateLeaves(nested, directUpdatePath, leaves);
    }
  }
}

export function needsAiSubjectForChore(updates: readonly SubmodulePointerUpdate[]): boolean {
  return collectLeafCommits(updates).length !== 1;
}

export function buildDeterministicChoreSubject(updates: readonly SubmodulePointerUpdate[]): string | null {
  const leaves = collectLeafCommits(updates);
  if (leaves.length !== 1) {
    return null;
  }
  const { directUpdatePath, commit } = leaves[0]!;
  const submoduleName = displayNameFromRepoPath(directUpdatePath);
  const leafSubject = commit.subject.trim();
  if (!leafSubject) {
    return null;
  }
  return `chore: update ${submoduleName}: ${leafSubject}`;
}

export function submoduleUpdateHeaderLine(update: SubmodulePointerUpdate): string {
  return `${update.path} (${shortSha(update.beforeHead)} -> ${shortSha(update.afterHead)}, ${update.branch})`;
}

export function resolveChoreSubject(
  updates: readonly SubmodulePointerUpdate[],
  subject?: string,
): string {
  const trimmed = subject?.trim();
  if (trimmed) {
    return trimmed;
  }
  return buildDeterministicChoreSubject(updates) ?? DEFAULT_SUBMODULE_CHORE_SUBJECT;
}

function renderNestedSubmoduleLine(update: SubmodulePointerUpdate, depth: number): string {
  const indent = "  ".repeat(depth + 1);
  return `${indent}- nested submodule ${update.path} (${shortSha(update.beforeHead)} -> ${shortSha(update.afterHead)}, ${update.branch})`;
}

function renderCommitSubjects(
  update: SubmodulePointerUpdate,
  depth: number,
  lines: string[],
  remaining: { count: number },
): void {
  const visible = update.commits.slice(0, remaining.count);
  remaining.count -= visible.length;

    for (const commit of visible) {
    const indent = depth === 0 ? "" : "  ".repeat(depth + 1);
    lines.push(`${indent}- ${shortSha(commit.sha)} ${commit.subject}`);
    for (const nested of commit.nestedUpdates) {
      lines.push(renderNestedSubmoduleLine(nested, depth));
      renderCommitSubjects(nested, depth + 1, lines, remaining);
    }
  }

  const hidden = update.commits.length - visible.length;
  if (hidden > 0) {
    const indent = depth === 0 ? "" : "  ".repeat(depth + 1);
    lines.push(`${indent}- ... ${hidden} more commits`);
  }
}

export function buildSubmoduleChoreMessage(input: BuildSubmoduleChoreMessageInput): SubmoduleChoreMessage {
  const subject = resolveChoreSubject(input.updates, input.subject);
  const bodyLines: string[] = [];

  for (let index = 0; index < input.updates.length; index += 1) {
    if (index > 0) {
      bodyLines.push("");
    }
    const update = input.updates[index]!;
    bodyLines.push(submoduleUpdateHeaderLine(update));
    renderCommitSubjects(update, 0, bodyLines, { count: MAX_SUBMODULE_COMMIT_SUBJECTS });
  }

  const body = bodyLines.length > 0 ? `\n\n${bodyLines.join("\n")}` : "";
  return {
    subject,
    body,
    message: bodyLines.length > 0 ? `${subject}${body}` : subject,
  };
}
