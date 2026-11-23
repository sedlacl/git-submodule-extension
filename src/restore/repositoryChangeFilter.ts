import { canonicalizeRepoPath } from "../git/pathUtils.js";
import { CHANGE_GROUP_ORDER, type RepositoryStateSnapshot } from "../git/repositoryState.js";

/**
 * `vscode.git` raises `state.onDidChange` after every status run, even when nothing changed.
 * Restore's own Git reads can cause such runs, so reacting to each one keeps restore running in
 * a loop. This filter passes a repository event on only when the state restore depends on
 * changed: HEAD (branch, commit, detached, upstream) or the list of changed files, which covers
 * gitlinks moved by `git submodule update` and a dirty tree that was blocking an attach.
 */
export class RepositoryChangeFilter {
  private readonly fingerprints = new Map<string, string>();

  /** True for the first snapshot of a repository and whenever its fingerprint differs. */
  changed(snapshot: RepositoryStateSnapshot): boolean {
    const key = canonicalizeRepoPath(snapshot.rootPath);
    const next = fingerprint(snapshot);
    if (this.fingerprints.get(key) === next) {
      return false;
    }
    this.fingerprints.set(key, next);
    return true;
  }

  forget(rootPath: string): void {
    this.fingerprints.delete(canonicalizeRepoPath(rootPath));
  }
}

export function fingerprint(snapshot: RepositoryStateSnapshot): string {
  const head = snapshot.head;
  const parts: string[] = [
    head
      ? [
          head.name ?? "",
          head.commit ?? "",
          head.detached ? "detached" : "attached",
          head.upstream ? `${head.upstream.remote}/${head.upstream.name}@${head.upstream.commit ?? ""}` : "",
        ].join("\0")
      : "no-head",
  ];
  for (const group of CHANGE_GROUP_ORDER) {
    const entries = snapshot.groups[group].map((change) => `${change.status}\0${change.uri}`).sort();
    parts.push(`${group}\n${entries.join("\n")}`);
  }
  return parts.join("\n\n");
}
