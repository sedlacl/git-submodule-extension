import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GitCliError, type GitCli, type GitRunOptions, type GitRunResult } from "../../../src/git/gitCli.js";
import { normalizeRepoPath } from "../../../src/git/pathUtils.js";
import { SubmoduleChoreReadService } from "../../../src/scm/submoduleChoreService.js";

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD_C = "cccccccccccccccccccccccccccccccccccccccc";
const CHILD_NEW = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const NESTED_OLD = "1111111111111111111111111111111111111111";
const NESTED_NEW = "2222222222222222222222222222222222222222";

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

function logRange(cwd: string, cli: ScriptedGitCli, range: string, entries: Array<{ sha: string; subject: string }>): void {
  cli.on(
    cwd,
    ["log", "--format=%H%x00%s", "--reverse", range],
    `${entries.map((entry) => `${entry.sha}\0${entry.subject}`).join("\n")}\n`,
  );
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
    logRange(childA, cli, `${HEAD_A}..${HEAD_C}`, [
      { sha: HEAD_B, subject: "feat: child change" },
      { sha: HEAD_C, subject: "fix: follow-up" },
    ]);
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
        commits: [
          { sha: HEAD_B, subject: "feat: child change", nestedUpdates: [] },
          { sha: HEAD_C, subject: "fix: follow-up", nestedUpdates: [] },
        ],
        staged: true,
      },
    ]);
    expect(preview!.message).toContain("submodules/foo (aaaaaaaa -> cccccccc, main)");
    expect(preview!.message).toContain("- bbbbbbbb feat: child change");
    expect(preview!.message).not.toContain("Note:");
  });

  it("reports unstaged pointer updates without staging metadata in the message", async () => {
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
    logRange(childA, cli, `${HEAD_A}..${CHILD_NEW}`, [{ sha: CHILD_NEW, subject: "wip: local work" }]);
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
        commits: [{ sha: CHILD_NEW, subject: "wip: local work", nestedUpdates: [] }],
        staged: false,
      },
    ]);
    expect(preview!.message).toContain("- eeeeeeee wip: local work");
    expect(preview!.message).not.toMatch(/not staged/i);
    expect(preview!.message).not.toContain("Note:");
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
    logRange(childRoot, cli, `${HEAD_A}..${CHILD_NEW}`, [{ sha: CHILD_NEW, subject: "chore: pointer-only bump" }]);

    const preview = await new SubmoduleChoreReadService(cli).preview(parent);

    expect(preview?.updates).toHaveLength(1);
    expect(preview?.updates[0]).toMatchObject({
      path: relativePath,
      beforeHead: HEAD_A,
      afterHead: CHILD_NEW,
      staged: false,
    });
    expect(preview?.message).toContain(relativePath);
    expect(preview?.message).toContain("- eeeeeeee chore: pointer-only bump");
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
    logRange(childA, cli, `${HEAD_A}..${HEAD_C}`, [{ sha: HEAD_C, subject: "staged bump" }]);
    logRange(childA, cli, `${HEAD_C}..${CHILD_NEW}`, [{ sha: CHILD_NEW, subject: "unstaged bump" }]);
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
    cli.on(childA, ["log", "--format=%H%x00%s", "--reverse", `${HEAD_A}..${HEAD_C}`], {
      stdout: "",
      stderr: "fatal: Invalid revision range",
      exitCode: 128,
    });
    cli.on(childB, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(childB, ["branch", "--show-current"], "develop\n");

    const service = new SubmoduleChoreReadService(cli);
    const preview = await service.preview(parent);

    expect(preview!.updates[0]?.commits).toEqual([]);
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
      logRange(child, cli, `${HEAD_B}..${HEAD_C}`, [{ sha: HEAD_C, subject: "update" }]);
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
    logRange(childA, cli, `${HEAD_A}..${HEAD_C}`, [{ sha: HEAD_C, subject: "detached work" }]);
    cli.on(childB, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(childB, ["branch", "--show-current"], "develop\n");

    const service = new SubmoduleChoreReadService(cli);
    const preview = await service.preview(parent);

    expect(preview!.updates[0]?.branch).toBe("detached HEAD");
  });

  it("recursively reports nested gitlink updates under the parent commit", async () => {
    const cli = new ScriptedGitCli();
    const mariPath = "submodules/usy_idsmari_commong01";
    const nestedPath = "submodules/uu_energygateway_datagatewayg01";
    const nestedRepoPath = path.join(parent, mariPath, nestedPath);
    const mariRoot = path.join(parent, mariPath);
    const modules = gitmodules([
      { name: "mari", path: mariPath, branch: "development/AFLEX" },
    ]);
    cli.on(parent, ["show", ":.gitmodules"], modules);
    cli.on(parent, ["show", "HEAD:.gitmodules"], modules);
    cli.on(parent, ["ls-tree", "-r", "-z", "HEAD"], lsTree([{ path: mariPath, sha: HEAD_A }]));
    cli.on(parent, ["ls-files", "--stage", "-z"], lsFiles([{ path: mariPath, sha: HEAD_B }]));
    stubChildWorkTree(cli, mariRoot);
    stubChildWorkTree(cli, nestedRepoPath);
    cli.on(mariRoot, ["rev-parse", "HEAD"], `${HEAD_B}\n`);
    cli.on(mariRoot, ["branch", "--show-current"], "development/AFLEX\n");
    logRange(mariRoot, cli, `${HEAD_A}..${HEAD_B}`, [
      { sha: HEAD_B, subject: "chore: update submodule uu_energygateway_datagatewayg01 to latest commit 9ee3d41" },
    ]);
    cli.on(mariRoot, ["ls-tree", "-r", "-z", `${HEAD_B}^`], lsTree([{ path: nestedPath, sha: NESTED_OLD }]));
    cli.on(mariRoot, ["ls-tree", "-r", "-z", HEAD_B], lsTree([{ path: nestedPath, sha: NESTED_NEW }]));
    cli.on(nestedRepoPath, ["branch", "--show-current"], "aflex/6.3-production\n");
    cli.on(nestedRepoPath, ["ls-tree", "-r", "-z", `${NESTED_NEW}^`], lsTree([]));
    cli.on(nestedRepoPath, ["ls-tree", "-r", "-z", NESTED_NEW], lsTree([]));
    logRange(nestedRepoPath, cli, `${NESTED_OLD}..${NESTED_NEW}`, [
      { sha: NESTED_NEW, subject: "T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support" },
    ]);

    const preview = await new SubmoduleChoreReadService(cli).preview(parent);

    expect(preview?.subject).toBe(
      "chore: update usy_idsmari_commong01: T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support",
    );
    expect(preview?.message).toContain(
      "  - nested submodule submodules/usy_idsmari_commong01/submodules/uu_energygateway_datagatewayg01",
    );
    expect(preview?.message).toContain("- 22222222 T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support");
    expect(preview?.message).not.toContain("Note:");
  });
});
