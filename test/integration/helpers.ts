import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GitCliRunner, type GitCli, type GitRunOptions, type GitRunResult } from "../../src/git/gitCli.js";
import {
  addSubmodule,
  commitFile,
  initRepo,
  runGit,
} from "../../scripts/lib/git-fixture.js";
import { toFileUrl } from "../../scripts/lib/paths.js";

export const GIT_PATH = "git";

export const FORBIDDEN_AUTO_GIT_VERBS = [
  "fetch",
  "pull",
  "push",
  "commit",
  "merge",
  "rebase",
  "reset",
  "clean",
  "stash",
  "checkout",
  "restore",
] as const;

export class RecordingCli implements GitCli {
  readonly calls: string[][] = [];

  constructor(private readonly inner: GitCli) {}

  async run(options: GitRunOptions): Promise<GitRunResult> {
    this.calls.push([...options.args]);
    return this.inner.run(options);
  }

  verbs(): string[] {
    return this.calls.map((args) => args[0] ?? "");
  }
}

export function createGitCli(): GitCliRunner {
  return new GitCliRunner(GIT_PATH);
}

export function makeTempRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeTempRoot(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

export function sha(cwd: string, spec = "HEAD"): string {
  return runGit(cwd, ["rev-parse", spec]).trim();
}

export function createRestoreRepos(root: string): {
  source: string;
  parent: string;
  childRel: string;
  child: string;
  pin: string;
} {
  const source = path.join(root, "source");
  const parent = path.join(root, "parent");
  const childRel = "modules/child";
  initRepo(source, "main");
  commitFile(source, "README.md", "# source\n", "init source");
  initRepo(parent, "main");
  commitFile(parent, "README.md", "# parent\n", "init parent");
  addSubmodule(parent, childRel, toFileUrl(source), "main");
  runGit(parent, ["add", "-A"]);
  runGit(parent, ["commit", "-m", "add child"]);
  const child = path.join(parent, childRel);
  const pin = sha(parent, `HEAD:${childRel}`);
  return { source, parent, childRel, child, pin };
}
