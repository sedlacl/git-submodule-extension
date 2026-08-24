import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { GitCliError, type GitCli, type GitRunOptions, type GitRunResult } from "../../../src/git/gitCli.js";
import { GitRepositoryReader } from "../../../src/git/gitRepositoryReader.js";
import { toBranchRestoreTarget } from "../../../src/git/interfaces.js";
import { normalizeRepoPath } from "../../../src/git/pathUtils.js";
import { discoverWorkspaceGitModel } from "../../../src/git/workspaceDiscovery.js";

const HEAD_HTTP = "1111111111111111111111111111111111111111";
const HEAD_COMMON = "2222222222222222222222222222222222222222";
const HEAD_DATA = "3333333333333333333333333333333333333333";
const INDEX_HTTP = "4444444444444444444444444444444444444444";
const CHECKOUT_DATA = "5555555555555555555555555555555555555555";
const HEAD_T1 = "6666666666666666666666666666666666666666";
const HEAD_T2 = "7777777777777777777777777777777777777777";
const UNINIT = "8888888888888888888888888888888888888888";

class ScriptedGitCli implements GitCli {
  private readonly scripts = new Map<string, GitRunResult>();
  private activeStatus = 0;
  maxConcurrentStatus = 0;

  constructor(private readonly delayMs = 0) {}

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
    const isStatus = options.args[0] === "status";
    if (isStatus) {
      this.activeStatus += 1;
      this.maxConcurrentStatus = Math.max(this.maxConcurrentStatus, this.activeStatus);
    }
    try {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      return found;
    } finally {
      if (isStatus) {
        this.activeStatus -= 1;
      }
    }
  }

  private key(cwd: string, args: readonly string[]): string {
    return `${normalizeRepoPath(cwd)}::${args.join("\0")}`;
  }
}

function gitmodules(entries: Array<{ name: string; path: string; branch?: string }>): string {
  return entries
    .map((entry) => {
      const quotedPath = entry.path.includes("#") ? `"${entry.path}"` : entry.path;
      const branch = entry.branch ? `\tbranch = ${entry.branch}\n` : "";
      return `[submodule "${entry.name}"]\n\tpath = ${quotedPath}\n\turl = ssh://git@example/${entry.name}.git\n${branch}`;
    })
    .join("");
}

function lsTree(links: Array<{ path: string; sha: string }>): string {
  return `${links.map((link) => `160000 commit ${link.sha}\t${link.path}`).join("\0")}\0`;
}

function lsFiles(links: Array<{ path: string; sha: string }>): string {
  return `${links.map((link) => `160000 ${link.sha} 0\t${link.path}`).join("\0")}\0`;
}

function porcelain(input: {
  oid: string;
  head: string | "(detached)";
  dirty?: boolean;
  ahead?: number;
  behind?: number;
}): string {
  const detached = input.head === "(detached)";
  const lines = [`# branch.oid ${input.oid}`, `# branch.head ${input.head}`];
  if (!detached) {
    lines.push(`# branch.upstream origin/${input.head}`);
    lines.push(`# branch.ab +${input.ahead ?? 0} -${input.behind ?? 0}`);
  }
  if (input.dirty) {
    lines.push("1 .M N... 100644 100644 100644 sha sha README.md");
  }
  return `${lines.join("\n")}\n`;
}

function stubWorkTree(cli: ScriptedGitCli, root: string): void {
  cli.on(root, ["rev-parse", "--is-inside-work-tree"], "true\n");
  cli.on(root, ["rev-parse", "--show-toplevel"], `${root}\n`);
  cli.on(root, ["rev-parse", "--absolute-git-dir"], path.join(root, ".git") + "\n");
}

function stubMissingWorkTree(cli: ScriptedGitCli, root: string): void {
  cli.on(root, ["rev-parse", "--is-inside-work-tree"], { stdout: "", stderr: "not a git repository", exitCode: 128 });
}

function stubEmptyDeclared(cli: ScriptedGitCli, root: string): void {
  cli.on(root, ["show", ":.gitmodules"], { stdout: "", stderr: "exists", exitCode: 128 });
  cli.on(root, ["show", "HEAD:.gitmodules"], { stdout: "", stderr: "exists", exitCode: 128 });
  cli.on(root, ["ls-tree", "-r", "-z", "HEAD"], "");
  cli.on(root, ["ls-files", "--stage", "-z"], "");
}

function stubDeclared(
  cli: ScriptedGitCli,
  root: string,
  spec: {
    modules: Array<{ name: string; path: string; branch?: string }>;
    links: Array<{ path: string; sha: string }>;
    indexLinks?: Array<{ path: string; sha: string }>;
  },
): void {
  const blob = gitmodules(spec.modules);
  cli.on(root, ["show", ":.gitmodules"], blob);
  cli.on(root, ["show", "HEAD:.gitmodules"], blob);
  cli.on(root, ["ls-tree", "-r", "-z", "HEAD"], lsTree(spec.links));
  cli.on(root, ["ls-files", "--stage", "-z"], lsFiles(spec.indexLinks ?? spec.links));
}

describe("discoverWorkspaceGitModel", () => {
  const base = path.join(process.cwd(), "__git_model_ws__");
  const httpendpoint = path.join(base, "httpendpoint");
  const httplibRel = "submodules/uu_energygateway_httpendpointg01";
  const commonRel = "submodules/usy_idsmari_commong01";
  const dataRel = "submodules/uu_energygateway_datagatewayg01";
  const httplib = path.join(httpendpoint, "submodules", "uu_energygateway_httpendpointg01");
  const commong01 = path.join(httpendpoint, "submodules", "usy_idsmari_commong01");
  const datagateway = path.join(commong01, "submodules", "uu_energygateway_datagatewayg01");
  const plain = path.join(base, "plain-app");
  const prefixSibling = path.join(httpendpoint, "not-a-gitlink");

  it("nests direct and nested submodules and dedups a workspace folder that is a gitlink child", async () => {
    const cli = new ScriptedGitCli();
    stubWorkTree(cli, httpendpoint);
    stubWorkTree(cli, commong01);
    stubWorkTree(cli, httplib);
    stubWorkTree(cli, datagateway);
    stubWorkTree(cli, plain);
    stubWorkTree(cli, prefixSibling);

    stubDeclared(cli, httpendpoint, {
      modules: [
        { name: httplibRel, path: httplibRel, branch: "aflex/6.3" },
        { name: commonRel, path: commonRel, branch: "development/AFLEX" },
      ],
      links: [
        { path: httplibRel, sha: HEAD_HTTP },
        { path: commonRel, sha: HEAD_COMMON },
      ],
      indexLinks: [
        { path: httplibRel, sha: INDEX_HTTP },
        { path: commonRel, sha: HEAD_COMMON },
      ],
    });
    stubDeclared(cli, commong01, {
      modules: [{ name: dataRel, path: dataRel, branch: "aflex/6.3-production" }],
      links: [{ path: dataRel, sha: HEAD_DATA }],
    });
    stubEmptyDeclared(cli, httplib);
    stubEmptyDeclared(cli, datagateway);
    stubEmptyDeclared(cli, plain);
    stubEmptyDeclared(cli, prefixSibling);

    cli.on(httplib, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: INDEX_HTTP, head: "aflex/6.3" }));
    cli.on(commong01, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_COMMON, head: "development/AFLEX" }));
    cli.on(datagateway, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: CHECKOUT_DATA, head: "(detached)" }));
    cli.on(plain, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_T1, head: "main" }));
    cli.on(prefixSibling, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_T2, head: "main" }));

    const model = await discoverWorkspaceGitModel(new GitRepositoryReader(cli, { exists: () => false }), {
      workspaceFolderPaths: [httpendpoint, commong01, plain, prefixSibling],
    });

    expect(model.roots.map((root) => root.displayName)).toEqual(["httpendpoint", "plain-app", "not-a-gitlink"]);

    const httpRoot = model.roots[0];
    expect(httpRoot?.children.map((child) => child.relativePath)).toEqual([httplibRel, commonRel]);

    const commonNode = httpRoot?.children.find((child) => child.relativePath === commonRel);
    expect(commonNode?.children.map((child) => child.relativePath)).toEqual([dataRel]);
    expect(model.nodesByRootPath.get(normalizeRepoPath(commong01))?.kind).toBe("submodule");

    const httplibNode = httpRoot?.children.find((child) => child.relativePath === httplibRel);
    expect(httplibNode?.adoptedChanges.staged).toEqual({ fromSha: HEAD_HTTP, toSha: INDEX_HTTP });
    expect(httplibNode?.workingState.pointerMismatch).toBe(false);

    const dataNode = commonNode?.children[0];
    expect(dataNode?.workingState.detached).toBe(true);
    expect(dataNode?.adoptedChanges.unstaged).toEqual({ fromSha: HEAD_DATA, toSha: CHECKOUT_DATA });
    expect(toBranchRestoreTarget(dataNode!)).toMatchObject({
      parentRootPath: normalizeRepoPath(commong01),
      relativePath: dataRel,
      targetBranch: "aflex/6.3-production",
      targetPin: HEAD_DATA,
    });
  });

  it("keeps independent workspace folders as siblings even when one path prefixes another", async () => {
    const cli = new ScriptedGitCli();
    stubWorkTree(cli, httpendpoint);
    stubWorkTree(cli, prefixSibling);
    stubEmptyDeclared(cli, httpendpoint);
    stubEmptyDeclared(cli, prefixSibling);

    const model = await discoverWorkspaceGitModel(new GitRepositoryReader(cli, { exists: () => false }), {
      workspaceFolderPaths: [httpendpoint, prefixSibling],
    });

    expect(model.roots.map((root) => root.rootPath)).toEqual([
      normalizeRepoPath(httpendpoint),
      normalizeRepoPath(prefixSibling),
    ]);
    expect(model.roots[0]?.children).toEqual([]);
  });

  it("records uninitialized, dirty, and diverged child states", async () => {
    const cli = new ScriptedGitCli();
    const uninitPath = path.join(httpendpoint, "submodules", "missing");
    const dirtyPath = path.join(httpendpoint, "submodules", "dirty");
    const divergedPath = path.join(httpendpoint, "submodules", "diverged");

    stubWorkTree(cli, httpendpoint);
    stubMissingWorkTree(cli, uninitPath);
    stubWorkTree(cli, dirtyPath);
    stubWorkTree(cli, divergedPath);

    stubDeclared(cli, httpendpoint, {
      modules: [
        { name: "submodules/missing", path: "submodules/missing", branch: "main" },
        { name: "submodules/dirty", path: "submodules/dirty", branch: "main" },
        { name: "submodules/diverged", path: "submodules/diverged", branch: "main" },
      ],
      links: [
        { path: "submodules/missing", sha: UNINIT },
        { path: "submodules/dirty", sha: HEAD_COMMON },
        { path: "submodules/diverged", sha: HEAD_DATA },
      ],
    });
    stubEmptyDeclared(cli, dirtyPath);
    stubEmptyDeclared(cli, divergedPath);

    cli.on(dirtyPath, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_COMMON, head: "main", dirty: true }));
    cli.on(divergedPath, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_DATA, head: "main", ahead: 2, behind: 1 }));

    const model = await discoverWorkspaceGitModel(new GitRepositoryReader(cli, { exists: () => false }), {
      workspaceFolderPaths: [httpendpoint],
    });

    const byRel = new Map(model.roots[0]?.children.map((child) => [child.relativePath, child]));
    expect(byRel.get("submodules/missing")?.workingState).toMatchObject({ uninitialized: true, dirty: false });
    expect(byRel.get("submodules/missing")?.children).toEqual([]);
    expect(byRel.get("submodules/dirty")?.workingState.dirty).toBe(true);
    expect(byRel.get("submodules/diverged")?.workingState.diverged).toBe(true);
    expect(byRel.get("submodules/diverged")?.branch.ahead).toBe(2);
    expect(byRel.get("submodules/diverged")?.branch.behind).toBe(1);
  });

  it("distinguishes two checkouts of the same source under #t1 and #t2", async () => {
    const infra = path.join(base, "infra-deploy");
    const t1Rel = "submodules/usy_aflex_initdatag01#t1";
    const t2Rel = "submodules/usy_aflex_initdatag01#t2";
    const t1 = path.join(infra, "submodules", "usy_aflex_initdatag01#t1");
    const t2 = path.join(infra, "submodules", "usy_aflex_initdatag01#t2");

    const cli = new ScriptedGitCli();
    stubWorkTree(cli, infra);
    stubWorkTree(cli, t1);
    stubWorkTree(cli, t2);
    stubDeclared(cli, infra, {
      modules: [
        { name: t1Rel, path: t1Rel, branch: "feature/t1-deployment" },
        { name: t2Rel, path: t2Rel, branch: "feature/t2-deployment" },
      ],
      links: [
        { path: t1Rel, sha: HEAD_T1 },
        { path: t2Rel, sha: HEAD_T2 },
      ],
    });
    stubEmptyDeclared(cli, t1);
    stubEmptyDeclared(cli, t2);
    cli.on(t1, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_T1, head: "feature/t1-deployment" }));
    cli.on(t2, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_T2, head: "feature/t2-deployment" }));

    const model = await discoverWorkspaceGitModel(new GitRepositoryReader(cli, { exists: () => false }), {
      workspaceFolderPaths: [infra],
    });

    expect(model.roots[0]?.children.map((child) => child.displayName)).toEqual([
      "usy_aflex_initdatag01#t1",
      "usy_aflex_initdatag01#t2",
    ]);
    expect(model.roots[0]?.children.map((child) => child.branch.configuredBranch)).toEqual([
      "feature/t1-deployment",
      "feature/t2-deployment",
    ]);
    expect(model.roots[0]?.children[0]?.rootPath).not.toBe(model.roots[0]?.children[1]?.rootPath);
  });

  it("probes sibling submodules concurrently", async () => {
    const leftRel = "modules/left";
    const rightRel = "modules/right";
    const left = path.join(httpendpoint, leftRel);
    const right = path.join(httpendpoint, rightRel);
    const cli = new ScriptedGitCli(5);
    stubWorkTree(cli, httpendpoint);
    stubWorkTree(cli, left);
    stubWorkTree(cli, right);
    stubDeclared(cli, httpendpoint, {
      modules: [{ name: leftRel, path: leftRel }, { name: rightRel, path: rightRel }],
      links: [{ path: leftRel, sha: HEAD_T1 }, { path: rightRel, sha: HEAD_T2 }],
    });
    stubEmptyDeclared(cli, left);
    stubEmptyDeclared(cli, right);
    cli.on(left, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_T1, head: "main" }));
    cli.on(right, ["status", "--porcelain=v2", "--branch", "--untracked-files=all", "--ignore-submodules=all"], porcelain({ oid: HEAD_T2, head: "main" }));

    const model = await discoverWorkspaceGitModel(new GitRepositoryReader(cli, { exists: () => false }), {
      workspaceFolderPaths: [httpendpoint],
    });

    expect(model.roots[0]?.children).toHaveLength(2);
    expect(cli.maxConcurrentStatus).toBe(2);
  });

  it("ignores a gitlink whose path resolves to the parent itself", async () => {
    const cli = new ScriptedGitCli();
    stubWorkTree(cli, httpendpoint);
    stubDeclared(cli, httpendpoint, {
      modules: [{ name: "self", path: ".", branch: "main" }],
      links: [{ path: ".", sha: HEAD_T1 }],
    });

    const model = await discoverWorkspaceGitModel(new GitRepositoryReader(cli, { exists: () => false }), {
      workspaceFolderPaths: [httpendpoint],
    });

    expect(model.roots).toHaveLength(1);
    expect(model.roots[0]?.children).toEqual([]);
  });
});
