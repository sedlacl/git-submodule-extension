import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { GitCli, GitRunOptions, GitRunResult } from "../../../src/git/gitCli.js";
import { normalizeRepoPath } from "../../../src/git/pathUtils.js";
import { BranchReconciler } from "../../../src/restore/branchReconciler.js";
import { SafeBranchRestoreService, type BranchRestoreExecutor, type RestoreRequest } from "../../../src/restore/branchRestoreService.js";

const PIN = "a".repeat(40);
const LOCAL = "b".repeat(40);
const parent = path.resolve("/repo/parent");
const child = path.resolve(parent, "modules/child");
const request: RestoreRequest = {
  parentRootPath: parent,
  relativePath: "modules/child",
  childRootPath: child,
  branch: "main",
  pin: PIN,
};

class FakeGit implements GitCli {
  readonly calls: GitRunOptions[] = [];
  readonly overrides = new Map<string, GitRunResult>();
  status = statusOutput({ oid: PIN, head: "(detached)" });
  localExists = false;
  localSha = PIN;
  uniqueSubjects = "";

  async run(options: GitRunOptions): Promise<GitRunResult> {
    this.calls.push(options);
    const key = options.args.join("\0");
    const override = this.overrides.get(key);
    if (override) return override;
    if (key === "rev-parse\0--is-inside-work-tree") return ok("true\n");
    if (key === "rev-parse\0--show-toplevel") return ok(`${child}\n`);
    if (key === "rev-parse\0--absolute-git-dir") return ok(`${child}/.git\n`);
    if (key.startsWith("status\0")) return ok(this.status);
    if (key === "remote\0get-url\0origin") return ok("git@example/child.git\n");
    if (key.startsWith("cat-file\0-e")) return ok("");
    if (key === "show-ref\0--verify\0--quiet\0refs/remotes/origin/main") return ok("");
    if (key === "merge-base\0--is-ancestor\0" + PIN + "\0origin/main") return ok("");
    if (key === "show-ref\0--verify\0--quiet\0refs/heads/main") return { stdout: "", stderr: "", exitCode: this.localExists ? 0 : 1 };
    if (key === "rev-parse\0refs/heads/main") return ok(`${this.localSha}\n`);
    if (key === "log\0--format=%s\0origin/main..main") return ok(this.uniqueSubjects);
    if (key === "switch\0-C\0main\0" + PIN || key === "branch\0--set-upstream-to\0origin/main\0main") return ok("");
    if (key === "fetch\0origin\0main") return ok("");
    throw new Error(`Unexpected git: ${key}`);
  }

  writes(): string[] {
    return this.calls.filter((call) => call.args[0] === "switch" || call.args[0] === "branch").map((call) => call.args.join(" "));
  }
}

function ok(stdout: string): GitRunResult {
  return { stdout, stderr: "", exitCode: 0 };
}

function statusOutput(input: { oid: string; head: string; dirty?: boolean; upstream?: string }): string {
  const lines = [`# branch.oid ${input.oid}`, `# branch.head ${input.head}`];
  if (input.head !== "(detached)") {
    lines.push(`# branch.upstream ${input.upstream ?? `origin/${input.head}`}`, "# branch.ab +0 -0");
  }
  if (input.dirty) lines.push("1 .M N... 100644 100644 100644 sha sha file");
  return `${lines.join("\n")}\n`;
}

describe("SafeBranchRestoreService safety matrix", () => {
  it("switches, assigns upstream, and verifies only after every safety check", async () => {
    const git = new FakeGit();
    let statusReads = 0;
    const originalRun = git.run.bind(git);
    git.run = async (options) => {
      if (options.args[0] === "status") {
        statusReads++;
        if (statusReads > 2) git.status = statusOutput({ oid: PIN, head: "main" });
      }
      return originalRun(options);
    };

    const result = await new SafeBranchRestoreService(git, { exists: () => false }).reconcile(request);
    expect(result.action).toBe("attached");
    expect(git.writes()).toEqual([`switch -C main ${PIN}`, "branch --set-upstream-to origin/main main"]);
  });

  it.each([
    ["uninitialized child", "rev-parse\0--is-inside-work-tree", { stdout: "", stderr: "", exitCode: 128 }],
    ["different worktree root", "rev-parse\0--show-toplevel", ok("/other\n")],
    ["missing origin", "remote\0get-url\0origin", { stdout: "", stderr: "", exitCode: 2 }],
    ["missing pin", `cat-file\0-e\0${PIN}^{commit}`, { stdout: "", stderr: "", exitCode: 1 }],
    ["missing remote ref", "show-ref\0--verify\0--quiet\0refs/remotes/origin/main", { stdout: "", stderr: "", exitCode: 1 }],
    ["pin outside remote ancestry", `merge-base\0--is-ancestor\0${PIN}\0origin/main`, { stdout: "", stderr: "", exitCode: 1 }],
  ])("fails closed for %s", async (_name, command, response) => {
    const git = new FakeGit();
    git.overrides.set(command, response);
    const result = await new SafeBranchRestoreService(git, { exists: () => false }).reconcile(request);
    expect(result.action).toBe("blocked");
    expect(git.writes()).toEqual([]);
  });

  it("fails closed for dirty tree, operation marker, and local unique commits", async () => {
    for (const scenario of ["dirty", "operation", "unique"] as const) {
      const git = new FakeGit();
      const paths = { exists: (_file: string) => scenario === "operation" };
      if (scenario === "dirty") git.status = statusOutput({ oid: PIN, head: "(detached)", dirty: true });
      if (scenario === "unique") {
        git.localExists = true;
        git.localSha = LOCAL;
        git.uniqueSubjects = "do not lose me\n";
      }
      const result = await new SafeBranchRestoreService(git, paths).reconcile(request);
      expect(result.action).toBe("blocked");
      expect(git.writes()).toEqual([]);
    }
  });

  it("does not mutate an already attached checkout and fetches only explicitly", async () => {
    const git = new FakeGit();
    git.status = statusOutput({ oid: PIN, head: "main" });
    const service = new SafeBranchRestoreService(git, { exists: () => false });
    expect((await service.reconcile(request)).action).toBe("already-attached");
    await service.fetch(request);
    expect(git.writes()).toEqual([]);
    expect(git.calls.at(-1)?.args).toEqual(["fetch", "origin", "main"]);
  });
});

class ParentGit implements GitCli {
  async run(options: GitRunOptions): Promise<GitRunResult> {
    if (normalizeRepoPath(options.cwd) !== normalizeRepoPath(parent)) {
      return { stdout: "", stderr: "", exitCode: 128 };
    }
    if (options.args.join("\0") === "show\0HEAD:.gitmodules") return ok('[submodule "child"]\n\tpath = child\n\tbranch = main\n');
    if (options.args.join("\0") === "ls-tree\0-r\0-z\0HEAD") return ok(`160000 commit ${PIN}\tchild\0`);
    throw new Error(`Unexpected parent command ${options.args.join(" ")}`);
  }
}

describe("BranchReconciler event loop", () => {
  it("blocks incomplete committed targets and walks initialized descendants", async () => {
    const directChild = path.resolve(parent, "child");
    const nested = path.resolve(directChild, "nested");
    const seen: string[] = [];
    const git: GitCli = {
      run: async (options) => {
        const key = options.args.join("\0");
        if (normalizeRepoPath(options.cwd) === normalizeRepoPath(parent) && key === "show\0HEAD:.gitmodules") {
          return ok('[submodule "child"]\n\tpath = child\n\tbranch = main\n[submodule "broken"]\n\tpath = broken\n');
        }
        if (normalizeRepoPath(options.cwd) === normalizeRepoPath(parent) && key === "ls-tree\0-r\0-z\0HEAD") {
          return ok(`160000 commit ${PIN}\tchild\0`);
        }
        if (normalizeRepoPath(options.cwd) === normalizeRepoPath(directChild) && key === "show\0HEAD:.gitmodules") {
          return ok('[submodule "nested"]\n\tpath = nested\n\tbranch = main\n');
        }
        if (normalizeRepoPath(options.cwd) === normalizeRepoPath(directChild) && key === "ls-tree\0-r\0-z\0HEAD") {
          return ok(`160000 commit ${PIN}\tnested\0`);
        }
        return { stdout: "", stderr: "", exitCode: 128 };
      },
    };
    const restore: BranchRestoreExecutor = {
      reconcile: async (target) => {
        seen.push(target.childRootPath);
        return { path: target.relativePath, parentRootPath: target.parentRootPath, childRootPath: target.childRootPath, action: "already-attached", detail: "ok" };
      },
      fetch: async () => undefined,
    };
    const results: string[] = [];
    const reconciler = new BranchReconciler(git, restore, { onResult: (result) => results.push(result.detail) });
    await reconciler.retry(parent);
    expect(seen).toEqual([normalizeRepoPath(directChild), normalizeRepoPath(nested)]);
    expect(results).toContain("committed .gitmodules has no branch");
  });

  it("debounces/coalesces events and deduplicates identical blocked errors", async () => {
    vi.useFakeTimers();
    const results: string[] = [];
    const restore: BranchRestoreExecutor = {
      reconcile: async () => ({
        path: "child",
        parentRootPath: parent,
        childRootPath: path.resolve(parent, "child"),
        action: "blocked",
        detail: "missing ref",
      }),
      fetch: async () => undefined,
    };
    const reconciler = new BranchReconciler(new ParentGit(), restore, {
      debounceMs: 25,
      onResult: (result) => results.push(`${result.action}:${result.detail}`),
    });
    reconciler.schedule(parent);
    reconciler.schedule(parent);
    await vi.advanceTimersByTimeAsync(25);
    expect(results).toEqual(["blocked:missing ref"]);
    await reconciler.retry(parent);
    expect(results).toEqual(["blocked:missing ref"]);
    vi.useRealTimers();
  });

  it("replays only the newest generation after an active run", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const restore: BranchRestoreExecutor = {
      reconcile: async () => {
        calls.push("start");
        markStarted();
        await gate;
        calls.push("finish");
        return { path: "child", parentRootPath: parent, childRootPath: path.resolve(parent, "child"), action: "attached", detail: "ok" };
      },
      fetch: async () => undefined,
    };
    const reconciler = new BranchReconciler(new ParentGit(), restore);
    const first = reconciler.retry(parent);
    await started;
    const second = reconciler.retry(parent);
    release();
    await Promise.all([first, second]);
    expect(calls).toEqual(["start", "finish", "start", "finish"]);
  });

  it("reads nested gitlink paths with recursive ls-tree and never fetches", async () => {
    const nestedRel = "submodules/child";
    const nestedRoot = path.resolve(parent, nestedRel);
    const seen: string[] = [];
    const git: GitCli = {
      run: async (options) => {
        const key = options.args.join("\0");
        if (normalizeRepoPath(options.cwd) === normalizeRepoPath(parent) && key === "show\0HEAD:.gitmodules") {
          return ok(`[submodule "child"]\n\tpath = ${nestedRel}\n\tbranch = main\n`);
        }
        if (normalizeRepoPath(options.cwd) === normalizeRepoPath(parent) && key === "ls-tree\0-r\0-z\0HEAD") {
          return ok(`160000 commit ${PIN}\t${nestedRel}\0`);
        }
        return { stdout: "", stderr: "", exitCode: 128 };
      },
    };
    const restore: BranchRestoreExecutor = {
      reconcile: async (target) => {
        seen.push(normalizeRepoPath(target.childRootPath));
        return {
          path: target.relativePath,
          parentRootPath: target.parentRootPath,
          childRootPath: target.childRootPath,
          action: "already-attached",
          detail: "ok",
        };
      },
      fetch: async () => {
        throw new Error("fetch must not be called by the reconciler");
      },
    };
    await new BranchReconciler(git, restore).retry(parent);
    expect(seen).toEqual([normalizeRepoPath(nestedRoot)]);
  });

  it("stops unbounded nesting with a depth loop guard", async () => {
    const git: GitCli = {
      run: async (options) => {
        const key = options.args.join("\0");
        if (key === "show\0HEAD:.gitmodules") {
          return ok('[submodule "child"]\n\tpath = child\n\tbranch = main\n');
        }
        if (key === "ls-tree\0-r\0-z\0HEAD") {
          return ok(`160000 commit ${PIN}\tchild\0`);
        }
        return { stdout: "", stderr: "", exitCode: 128 };
      },
    };
    let restores = 0;
    const details: string[] = [];
    const restore: BranchRestoreExecutor = {
      reconcile: async (target) => {
        restores += 1;
        return {
          path: target.relativePath,
          parentRootPath: target.parentRootPath,
          childRootPath: target.childRootPath,
          action: "already-attached",
          detail: "ok",
        };
      },
      fetch: async () => undefined,
    };
    await new BranchReconciler(git, restore, { onResult: (result) => details.push(result.detail) }).retry(parent);
    expect(restores).toBeLessThanOrEqual(32);
    expect(details).toContain("restore depth limit exceeded");
  });
});
