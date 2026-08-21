import { describe, expect, it } from "vitest";
import { GitCliError, GitCliRunner, type ExecFileUtf8 } from "../../../src/git/gitCli.js";
import { GitRepositoryReader } from "../../../src/git/gitRepositoryReader.js";

describe("GitCliRunner", () => {
  it("runs execFile with shell disabled and an argv array", async () => {
    const calls: Array<{ file: string; args: readonly string[]; shell: boolean | string | undefined; cwd: string }> = [];
    const execFileUtf8: ExecFileUtf8 = async (file, args, options) => {
      calls.push({ file, args, shell: options.shell, cwd: String(options.cwd) });
      return { stdout: "true\n", stderr: "" };
    };
    const runner = new GitCliRunner("C:/Program Files/Git/cmd/git.exe", execFileUtf8);

    const result = await runner.run({
      cwd: "C:/repo with spaces",
      args: ["rev-parse", "--", "submodules/foo#t1"],
    });

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      file: "C:/Program Files/Git/cmd/git.exe",
      args: ["rev-parse", "--", "submodules/foo#t1"],
      shell: false,
      cwd: "C:/repo with spaces",
    });
  });

  it("keeps shell metacharacters as literal argv entries", async () => {
    const seen: string[][] = [];
    const execFileUtf8: ExecFileUtf8 = async (_file, args) => {
      seen.push([...args]);
      return { stdout: "", stderr: "" };
    };
    const runner = new GitCliRunner("git", execFileUtf8);

    await runner.run({
      cwd: "/tmp",
      args: ["show", "$(touch pwned)", "; rm -rf /"],
    });

    expect(seen[0]).toEqual(["show", "$(touch pwned)", "; rm -rf /"]);
  });

  it("rejects NUL bytes instead of interpolating them", async () => {
    const runner = new GitCliRunner("git", async () => ({ stdout: "", stderr: "" }));
    await expect(runner.run({ cwd: "/tmp", args: ["show", "HEAD:.gitmodules\0-c"] })).rejects.toThrow(/NUL/);
  });

  it("wraps non-zero exits unless they are allowed", async () => {
    const execFileUtf8: ExecFileUtf8 = async () => {
      const error = Object.assign(new Error("failed"), {
        code: 128,
        stdout: "",
        stderr: "exists",
      });
      throw error;
    };
    const runner = new GitCliRunner("git", execFileUtf8);

    await expect(runner.run({ cwd: "/tmp", args: ["show", "HEAD:.gitmodules"] })).rejects.toBeInstanceOf(GitCliError);

    const allowed = await runner.run({
      cwd: "/tmp",
      args: ["show", "HEAD:.gitmodules"],
      allowedExitCodes: [0, 128],
    });
    expect(allowed.exitCode).toBe(128);
  });
});

describe("GitRepositoryReader.listNameStatus", () => {
  it("rejects revision arguments that are not object names", async () => {
    const reader = new GitRepositoryReader({
      run: async () => {
        throw new Error("git should not run");
      },
    });

    await expect(reader.listNameStatus("/tmp/repo", "--output=/tmp/x", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toThrow(
      /fromSha/,
    );
  });
});
