import { describe, expect, it } from "vitest";
import type { GitCli, GitRunOptions } from "../../../src/git/gitCli.js";
import {
  buildClaudeCommitMessageArgs,
  cleanClaudeCommitMessage,
  collectCommitMessageContext,
  resolveClaudeExecutable,
  runClaudeCommitMessage,
} from "../../../src/scm/claudeCommitMessage.js";

class FakeGitCli implements GitCli {
  calls: string[] = [];
  constructor(private readonly outputs: Record<string, string>) {}

  async run(options: GitRunOptions) {
    const key = options.args.join(" ");
    this.calls.push(key);
    const match = Object.keys(this.outputs).find((prefix) => key.startsWith(prefix));
    if (match === undefined) {
      throw new Error(`unexpected git ${key}`);
    }
    return { stdout: this.outputs[match]!, stderr: "", exitCode: 0 };
  }
}

const STAGED = "diff --no-color --no-ext-diff --submodule=short --cached";
const UNSTAGED = "diff --no-color --no-ext-diff --submodule=short";
const UNTRACKED = "ls-files --others --exclude-standard";
const LOG = "log -n10 --format=%s";

describe("resolveClaudeExecutable", () => {
  it("prefers the CLI bundled with the Claude Code extension", () => {
    const bundled = "C:\\ext\\claude\\resources\\native-binary\\claude.exe";
    expect(
      resolveClaudeExecutable({
        extensionPath: "C:\\ext\\claude",
        platform: "win32",
        pathEnv: "C:\\bin",
        exists: () => true,
      }),
    ).toBe(bundled);
  });

  it("falls back to a native claude on PATH and skips missing candidates", () => {
    const existing = new Set(["/usr/local/bin/claude"]);
    expect(
      resolveClaudeExecutable({
        extensionPath: "/ext/claude",
        platform: "linux",
        pathEnv: "/usr/bin:/usr/local/bin",
        exists: (candidate) => existing.has(candidate),
      }),
    ).toBe("/usr/local/bin/claude");
    expect(resolveClaudeExecutable({ platform: "linux", pathEnv: "/usr/bin", exists: () => false })).toBeUndefined();
  });

  it("strips quotes from Windows PATH entries", () => {
    expect(
      resolveClaudeExecutable({
        platform: "win32",
        pathEnv: '"C:\\Users\\me\\.local\\bin";C:\\Windows',
        exists: (candidate) => candidate === "C:\\Users\\me\\.local\\bin\\claude.exe",
      }),
    ).toBe("C:\\Users\\me\\.local\\bin\\claude.exe");
  });
});

describe("buildClaudeCommitMessageArgs", () => {
  it("runs headless without tools, settings, MCP servers or session files", () => {
    const args = buildClaudeCommitMessageArgs("sonnet");
    expect(args.slice(0, 3)).toEqual(["-p", "--model", "sonnet"]);
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--no-session-persistence"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("--bare");
    expect(buildClaudeCommitMessageArgs("  ")[2]).toBe("haiku");
  });
});

describe("collectCommitMessageContext", () => {
  it("describes staged changes only when something is staged", async () => {
    const cli = new FakeGitCli({ [STAGED]: "+staged line\n", [LOG]: "feat: one\nfix: two\n" });
    const context = await collectCommitMessageContext(cli, "/repo");

    expect(context).toBe("Recent commit subjects:\nfeat: one\nfix: two\n\nStaged changes:\n+staged line");
    expect(cli.calls).not.toContain(UNTRACKED);
  });

  it("falls back to working-tree changes and untracked files", async () => {
    const cli = new FakeGitCli({ [STAGED]: "", [UNSTAGED]: "+tracked\n", [UNTRACKED]: "new.txt\n", [LOG]: "" });
    const context = await collectCommitMessageContext(cli, "/repo");

    expect(context).toBe(
      "New untracked files:\nnew.txt\n\nWorking tree changes (nothing is staged):\n+tracked",
    );
  });

  it("returns undefined without changes and truncates large diffs", async () => {
    const empty = new FakeGitCli({ [STAGED]: "", [UNSTAGED]: "", [UNTRACKED]: "" });
    await expect(collectCommitMessageContext(empty, "/repo")).resolves.toBeUndefined();

    const large = new FakeGitCli({ [STAGED]: "x".repeat(50), [LOG]: "" });
    await expect(collectCommitMessageContext(large, "/repo", 10)).resolves.toBe(
      `Staged changes:\n${"x".repeat(10)}\n[diff truncated]`,
    );
  });

  it("tolerates a repository without commits", async () => {
    const cli = new FakeGitCli({ [STAGED]: "+a\n" });
    await expect(collectCommitMessageContext(cli, "/repo")).resolves.toBe("Staged changes:\n+a");
  });
});

describe("cleanClaudeCommitMessage", () => {
  it("removes code fences and surrounding whitespace", () => {
    expect(cleanClaudeCommitMessage("\n```text\nfeat: x\n\nbody\n```\n")).toBe("feat: x\n\nbody");
    expect(cleanClaudeCommitMessage("  fix: y \n")).toBe("fix: y");
  });
});

describe("runClaudeCommitMessage", () => {
  it("pipes the context to stdin and returns the cleaned stdout", async () => {
    const message = await runClaudeCommitMessage({
      executable: process.execPath,
      args: ["-e", "process.stdin.pipe(process.stdout)"],
      input: "```\nfeat: from stdin\n```",
      cwd: process.cwd(),
    });
    expect(message).toBe("feat: from stdin");
  });

  it("rejects with stderr on a non-zero exit and on timeout", async () => {
    await expect(
      runClaudeCommitMessage({
        executable: process.execPath,
        args: ["-e", "process.stderr.write('not logged in'); process.exit(1)"],
        input: "",
        cwd: process.cwd(),
      }),
    ).rejects.toThrow("Claude CLI failed: not logged in");
    await expect(
      runClaudeCommitMessage({
        executable: process.execPath,
        args: ["-e", "setTimeout(() => {}, 10000)"],
        input: "",
        cwd: process.cwd(),
        timeoutMs: 200,
      }),
    ).rejects.toThrow("timed out");
  });
});
