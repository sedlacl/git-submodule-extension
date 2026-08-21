import type { GitCli } from "../git/gitCli.js";
import { normalizeGitRelativePath } from "../git/pathUtils.js";
import { assertSha } from "../git/sha.js";

/**
 * Read a blob from `sha:path` inside a child repository. Missing paths return
 * null so add/delete diffs can render an empty side.
 */
export async function readGitPathAt(
  cli: GitCli,
  repoRoot: string,
  sha: string,
  gitPath: string,
): Promise<string | null> {
  const objectName = assertSha(sha, "sha");
  const relative = normalizeGitRelativePath(gitPath);
  if (!relative) {
    return null;
  }

  const result = await cli.run({
    cwd: repoRoot,
    args: ["show", `${objectName}:${relative}`],
    allowedExitCodes: [0, 128],
  });
  if (result.exitCode !== 0) {
    return null;
  }
  return result.stdout;
}
