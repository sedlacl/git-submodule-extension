import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GitCliError, type GitCli, type GitRunOptions, type GitRunResult } from "../../../src/git/gitCli.js";
import { normalizeRepoPath } from "../../../src/git/pathUtils.js";
import { SubmoduleChoreReadService } from "../../../src/scm/submoduleChoreService.js";

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD_C = "cccccccccccccccccccccccccccccccccccccccc";
const CHILD_NEW = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

class ScriptedGitCli implements GitCli {
  private readonly scripts = new Map<string, GitRunResult>();

  on(cwd: string, args: readonly string[], result: string | GitRunResult): this {
    const resolved: GitRunResult = typeof result === "string" ? { stdout: result, stderr: "", exitCode: 0 } : result;
    this.scripts.set(this.key(cwd, args), resolved);
    return this;
  }

  async run(options: GitRunOptions): Promise<GitRunResult> {
    const found = this.scripts.get(this.key(options.cwd, options.args));
    if (!found) {
      throw new Error(`Unexpected git ${options.args.join(" ")} in ${options.cwd}`);
    }
    const allowed = options.allowedExitCodes ?? [0];
    if (!allowed.includes(found.exitCode)) {
      throw new GitCliError("git", options.args, options.cwd, found.exitCode, found.stdout, found.stderr);
    }
    return found;
  }

  private key(cwd: string, args: readonly string[]): string {
    return `${normalizeRepoPath(cwd)}::${args.join("\0")}`;
  }
}

function gitmodules(entries: Array<{ name: string; path: string; branch?: string }>): string {
  return entries
    .map((entry) => {
      const branch = entry.branch ? `\tbranch = ${entry.branch}\n` : "";
      return `[submodule "${entry.name}"]\n\tpath = ${entry.path}\n\turl = ssh://git@example/${entry.name}.git\n${branch}`;
    })
    .join("");
}

function lsTree(links: Array<{ path: string; sha: string }>): string {
  return `${links.map((link) => `160000 commit ${link.sha}\t${link.path}`).join("\0")}\0`;
}

function lsFiles(links: Array<{ path: string; sha: string }>): string {
  return `${links.map((link) => `160000 ${link.sha} 0\t${link.path}`).join("\0")}\0`;
}

function stubChildWorkTree(cli: ScriptedGitCli, childRoot: string): void {
  cli.on(childRoot, ["rev-parse", "--is-inside-work-tree"], "true\n");
  cli.on(childRoot, ["rev-parse", "--show-toplevel"], `${childRoot}\n`);
}

describe("SubmoduleChoreReadService", () => {
  const parent = path.join(process.cwd(), "__submodule_chore_parent__");
  const childA = path.join(parent, "submodules", "foo");
  const childB = path.join(parent, "submodules", "bar");

  function stubParent(cli: ScriptedGitCli): void {
    const modules = gitmodules([
      { name: "foo", path: "submodules/foo", branch: "main" },
      { name: "bar", path: "submodules/bar", branch: "develop" },
    ]);
    cli.on(parent, ["show", ":.gitmodules"], modules);
    cli.on(parent, ["show", "HEAD:.gitmodules"], modules);
    cli.on(parent, ["ls-tree", "-r", "-z", "HEAD"], lsTree([
      { path: "submodules/foo", sha: HEAD_A },
      { path: "submodules/bar", sha: HEAD_B },
    ]));
  }

  it("returns null when no direct submodule pointers changed", async () => {
    const cli = new ScriptedGitCli();
    stubParent(cli);
    cli.on(parent, ["ls-files", "--stage", "-z"], lsTree([
      { path: "submodules/foo", sha: HEAD_A },
      { path: "submodules/bar", sha: HEAD_B },
    ]));
    stubChildWorkTree(cli, childA);
    stubChildWorkTree(cli, childB);
    cli.on(childA, ["rev-parse", "HEAD"], `${HEAD_A}\n`);
    cli.on(childA, ["branch", "--show-current"], "main\n");
    cli.on(childB, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(childB, ["branch", "--show-current"], "develop\n");

    const service = new SubmoduleChoreReadService(cli);
    await expect(service.preview(parent)).resolves.toBeNull();
  });

  it("reports staged pointer updates using HEAD to index", async () => {
    const cli = new ScriptedGitCli();
    stubParent(cli);
    cli.on(parent, ["ls-files", "--stage", "-z"], lsFiles([
      { path: "submodules/foo", sha: HEAD_C },
      { path: "submodules/bar", sha: HEAD_B },
    ]));
    stubChildWorkTree(cli, childA);
    stubChildWorkTree(cli, childB);
    cli.on(childA, ["rev-parse", "HEAD"], `${HEAD_C}\n`);
    cli.on(childA, ["branch", "--show-current"], "main\n");
    cli.on(childA, ["log", "--format=%s", `${HEAD_A}..${HEAD_C}`], "feat: child change\nfix: follow-up\n");
    cli.on(childB, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(childB, ["branch", "--show-current"], "develop\n");

    const service = new SubmoduleChoreReadService(cli);
    const preview = await service.preview(parent);

    expect(preview).not.toBeNull();
    expect(preview!.updates).toEqual([
      {
        path: "submodules/foo",
        beforeHead: HEAD_A,
        afterHead: HEAD_C,
        branch: "main",
        subjects: ["feat: child change", "fix: follow-up"],
        staged: true,
      },
    ]);
    expect(preview!.hasUnstagedUpdates).toBe(false);
    expect(preview!.message).toContain("submodules/foo (aaaaaaaa -> cccccccc, main)");
    expect(preview!.message).toContain("- feat: child change");
  });

  it("reports unstaged pointer updates using HEAD to checkout with a note", async () => {
    const cli = new ScriptedGitCli();
    stubParent(cli);
    cli.on(parent, ["ls-files", "--stage", "-z"], lsFiles([
      { path: "submodules/foo", sha: HEAD_A },
      { path: "submodules/bar", sha: HEAD_B },
    ]));
    stubChildWorkTree(cli, childA);
    stubChildWorkTree(cli, childB);
    cli.on(childA, ["rev-parse", "HEAD"], `${CHILD_NEW}\n`);
    cli.on(childA, ["branch", "--show-current"], "feature/x\n");
    cli.on(childA, ["log", "--format=%s", `${HEAD_A}..${CHILD_NEW}`], "wip: local work\n");
    cli.on(childB, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(childB, ["branch", "--show-current"], "develop\n");

    const service = new SubmoduleChoreReadService(cli);
    const preview = await service.preview(parent);

    expect(preview!.updates).toEqual([
      {
        path: "submodules/foo",
        beforeHead: HEAD_A,
        afterHead: CHILD_NEW,
        branch: "feature/x",
        subjects: ["wip: local work"],
        staged: false,
      },
    ]);
    expect(preview!.hasUnstagedUpdates).toBe(true);
    expect(preview!.unstagedNote).toMatch(/not staged/i);
    expect(preview!.message).toContain("(not staged)");
  });

  it("keeps a # path pointer update when its old and new commits have identical trees", async () => {
    const cli = new ScriptedGitCli();
    const relativePath = "submodules/usy_aflex_initdatag01#t1";
    const childRoot = path.join(parent, relativePath);
    const modules = gitmodules([{ name: "aflex-t1", path: relativePath, branch: "feature/t1-deployment" }]);
    cli.on(parent, ["show", ":.gitmodules"], modules);
    cli.on(parent, ["show", "HEAD:.gitmodules"], modules);
    cli.on(parent, ["ls-tree", "-r", "-z", "HEAD"], lsTree([{ path: relativePath, sha: HEAD_A }]));
    cli.on(parent, ["ls-files", "--stage", "-z"], lsFiles([{ path: relativePath, sha: HEAD_A }]));
    stubChildWorkTree(cli, childRoot);
    cli.on(childRoot, ["rev-parse", "HEAD"], `${CHILD_NEW}\n`);
    cli.on(childRoot, ["branch", "--show-current"], "feature/t1-deployment\n");
    cli.on(childRoot, ["log", "--format=%s", `${HEAD_A}..${CHILD_NEW}`], "chore: pointer-only bump\n");

    const preview = await new SubmoduleChoreReadService(cli).preview(parent);

    expect(preview?.updates).toHaveLength(1);
    expect(preview?.updates[0]).toMatchObject({
      path: relativePath,
      beforeHead: HEAD_A,
      afterHead: CHILD_NEW,
      staged: false,
    });
    expect(preview?.message).toContain(relativePath);
    expect(preview?.message).toContain("chore: pointer-only bump");
  });

  it("reports staged HEAD-to-index and unstaged index-to-checkout ranges separately", async () => {
    const cli = new ScriptedGitCli();
    stubParent(cli);
    cli.on(parent, ["ls-files", "--stage", "-z"], lsFiles([
      { path: "submodules/foo", sha: HEAD_C },
      { path: "submodules/bar", sha: HEAD_B },
    ]));
    stubChildWorkTree(cli, childA);
    stubChildWorkTree(cli, childB);
    cli.on(childA, ["rev-parse", "HEAD"], `${CHILD_NEW}\n`);
    cli.on(childA, ["branch", "--show-current"], "feature/x\n");
    cli.on(childA, ["log", "--format=%s", `${HEAD_A}..${HEAD_C}`], "staged bump\n");
    cli.on(childA, ["log", "--format=%s", `${HEAD_C}..${CHILD_NEW}`], "unstaged bump\n");
    cli.on(childB, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(childB, ["branch", "--show-current"], "develop\n");

    const preview = await new SubmoduleChoreReadService(cli).preview(parent);

    expect(preview?.updates.map(({ beforeHead, afterHead, staged }) => ({ beforeHead, afterHead, staged }))).toEqual([
      { beforeHead: HEAD_A, afterHead: HEAD_C, staged: true },
      { beforeHead: HEAD_C, afterHead: CHILD_NEW, staged: false },
    ]);
  });

  it("fail-softs missing commit log ranges", async () => {
    const cli = new ScriptedGitCli();
    stubParent(cli);
    cli.on(parent, ["ls-files", "--stage", "-z"], lsFiles([{ path: "submodules/foo", sha: HEAD_C }]));
    stubChildWorkTree(cli, childA);
    stubChildWorkTree(cli, childB);
    cli.on(childA, ["rev-parse", "HEAD"], `${HEAD_C}\n`);
    cli.on(childA, ["branch", "--show-current"], "main\n");
    cli.on(childA, ["log", "--format=%s", `${HEAD_A}..${HEAD_C}`], {
      stdout: "",
      stderr: "fatal: Invalid revision range",
      exitCode: 128,
    });
    cli.on(childB, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(childB, ["branch", "--show-current"], "develop\n");

    const service = new SubmoduleChoreReadService(cli);
    const preview = await service.preview(parent);

    expect(preview!.updates[0]?.subjects).toEqual([]);
    expect(preview!.message).toContain("submodules/foo (aaaaaaaa -> cccccccc, main)");
  });

  it("orders updates by declared submodule path", async () => {
    const cli = new ScriptedGitCli();
    stubParent(cli);
    cli.on(parent, ["ls-files", "--stage", "-z"], lsFiles([
      { path: "submodules/foo", sha: HEAD_C },
      { path: "submodules/bar", sha: HEAD_C },
    ]));
    for (const child of [childA, childB]) {
      stubChildWorkTree(cli, child);
      cli.on(child, ["rev-parse", "HEAD"], `${HEAD_C}\n`);
      cli.on(child, ["branch", "--show-current"], "main\n");
      cli.on(child, ["log", "--format=%s", `${HEAD_B}..${HEAD_C}`], "update\n");
    }

    const service = new SubmoduleChoreReadService(cli);
    const preview = await service.preview(parent);

    expect(preview!.updates.map((entry) => entry.path)).toEqual(["submodules/foo", "submodules/bar"]);
  });

  it("uses detached HEAD when the child checkout has no branch", async () => {
    const cli = new ScriptedGitCli();
    stubParent(cli);
    cli.on(parent, ["ls-files", "--stage", "-z"], lsFiles([{ path: "submodules/foo", sha: HEAD_C }]));
    stubChildWorkTree(cli, childA);
    stubChildWorkTree(cli, childB);
    cli.on(childA, ["rev-parse", "HEAD"], `${HEAD_C}\n`);
    cli.on(childA, ["branch", "--show-current"], "\n");
    cli.on(childA, ["log", "--format=%s", `${HEAD_A}..${HEAD_C}`], "detached work\n");
    cli.on(childB, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(childB, ["branch", "--show-current"], "develop\n");

    const service = new SubmoduleChoreReadService(cli);
    const preview = await service.preview(parent);

    expect(preview!.updates[0]?.branch).toBe("detached HEAD");
  });
});
