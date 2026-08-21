import { parseSha } from "./sha.js";
import type { GitlinkEntry } from "./types.js";

export function splitNul(payload: string): string[] {
  return payload.split("\0").filter((part) => part.length > 0);
}

const LS_TREE_GITLINK = /^160000\s+commit\s+([0-9a-f]{40,64})\t(.+)$/i;
const LS_FILES_GITLINK = /^160000\s+([0-9a-f]{40,64})\s+(\d+)\t(.+)$/i;

/** Parse `git ls-tree -r -z HEAD` and keep only mode 160000 gitlinks. */
export function parseLsTreeGitlinks(stdout: string): GitlinkEntry[] {
  const entries: GitlinkEntry[] = [];
  for (const record of splitNul(stdout)) {
    const match = record.match(LS_TREE_GITLINK);
    if (!match) {
      continue;
    }
    const sha = parseSha(match[1]);
    const gitPath = match[2];
    if (!sha || !gitPath) {
      continue;
    }
    entries.push({ path: gitPath, sha, stage: 0 });
  }
  return entries;
}

/** Parse `git ls-files --stage -z` and keep only mode 160000 gitlinks. */
export function parseLsFilesGitlinks(stdout: string): GitlinkEntry[] {
  const entries: GitlinkEntry[] = [];
  for (const record of splitNul(stdout)) {
    const match = record.match(LS_FILES_GITLINK);
    if (!match) {
      continue;
    }
    const sha = parseSha(match[1]);
    const stage = Number(match[2]);
    const gitPath = match[3];
    if (!sha || !gitPath || Number.isNaN(stage)) {
      continue;
    }
    entries.push({ path: gitPath, sha, stage });
  }
  return entries;
}
