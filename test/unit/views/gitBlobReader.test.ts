import { describe, expect, it } from "vitest";
import type { GitCli, GitRunOptions, GitRunResult } from "../../../src/git/gitCli.js";
import { readGitPathAt } from "../../../src/views/gitBlobReader.js";

class RecordingCli implements GitCli {
  readonly calls: GitRunOptions[] = [];
  constructor(private readonly result: GitRunResult) {}
  async run(options: GitRunOptions): Promise<GitRunResult> {
    this.calls.push(options);
    return this.result;
  }
}

describe("readGitPathAt", () => {
  it("shows sha:path without a shell and returns null for missing blobs", async () => {
    const cli = new RecordingCli({ stdout: "hello\n", stderr: "", exitCode: 0 });
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await expect(readGitPathAt(cli, "/ws/lib", sha, "src/index.ts")).resolves.toBe("hello\n");
    expect(cli.calls[0]).toMatchObject({
      cwd: "/ws/lib",
      args: ["show", `${sha}:src/index.ts`],
      allowedExitCodes: [0, 128],
    });

    const missing = new RecordingCli({ stdout: "", stderr: "exists", exitCode: 128 });
    await expect(readGitPathAt(missing, "/ws/lib", sha, "gone.ts")).resolves.toBeNull();
  });

  it("rejects path traversal and incomplete SHAs before invoking git", async () => {
    const cli = new RecordingCli({ stdout: "nope", stderr: "", exitCode: 0 });
    await expect(readGitPathAt(cli, "/ws/lib", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "../secret")).resolves.toBeNull();
    await expect(readGitPathAt(cli, "/ws/lib", "not-a-sha", "src/index.ts")).rejects.toThrow(/object name/);
    expect(cli.calls).toEqual([]);
  });
});
