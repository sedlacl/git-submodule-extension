import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkout, commitFile, runGit, writeFile } from "../../scripts/lib/git-fixture.js";
import { BranchReconciler } from "../../src/restore/branchReconciler.js";
import { SafeBranchRestoreService } from "../../src/restore/branchRestoreService.js";
import { RestoreCoordinator } from "../../src/restore/restoreCoordinator.js";
import {
  createGitCli,
  createRestoreRepos,
  FORBIDDEN_AUTO_GIT_VERBS,
  makeTempRoot,
  RecordingCli,
  removeTempRoot,
  sha,
} from "./helpers.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    removeTempRoot(root);
  }
});

function tempDir(): string {
  const root = makeTempRoot("git-submodule-int-restore-");
  tempRoots.push(root);
  return root;
}

describe("branch restore integration", () => {
  it("attaches a clean detached pin, then no-ops when already attached", async () => {
    const repos = createRestoreRepos(tempDir());
    checkout(repos.child, repos.pin);
    expect(runGit(repos.child, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("HEAD");

    const recording = new RecordingCli(createGitCli());
    const service = new SafeBranchRestoreService(recording);
    const request = {
      parentRootPath: repos.parent,
      relativePath: repos.childRel,
      childRootPath: repos.child,
      branch: "main",
      pin: repos.pin,
    };

    const attached = await service.reconcile(request);
    expect(attached.action).toBe("attached");
    expect(runGit(repos.child, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(sha(repos.child)).toBe(repos.pin);
    expect(recording.verbs().some((verb) => FORBIDDEN_AUTO_GIT_VERBS.includes(verb as (typeof FORBIDDEN_AUTO_GIT_VERBS)[number]))).toBe(
      false,
    );

    const again = await service.reconcile(request);
    expect(again.action).toBe("already-attached");
    expect(recording.calls.filter((args) => args[0] === "switch")).toHaveLength(1);
  }, 60_000);

  it("fails closed for dirty, diverged unique commits, and a missing remote ref", async () => {
    const dirtyRoot = createRestoreRepos(tempDir());
    checkout(dirtyRoot.child, dirtyRoot.pin);
    writeFile(path.join(dirtyRoot.child, "wip.txt"), "dirty\n");

    const divergedRoot = createRestoreRepos(tempDir());
    commitFile(divergedRoot.child, "unique.txt", "keep me\n", "local unique commit");
    checkout(divergedRoot.child, divergedRoot.pin);

    const missingRoot = createRestoreRepos(tempDir());
    checkout(missingRoot.child, missingRoot.pin);
    runGit(missingRoot.child, ["update-ref", "-d", "refs/remotes/origin/main"]);

    const service = new SafeBranchRestoreService(createGitCli());
    const dirty = await service.reconcile({
      parentRootPath: dirtyRoot.parent,
      relativePath: dirtyRoot.childRel,
      childRootPath: dirtyRoot.child,
      branch: "main",
      pin: dirtyRoot.pin,
    });
    expect(dirty.action).toBe("blocked");
    expect(dirty.detail).toMatch(/dirty/i);

    const diverged = await service.reconcile({
      parentRootPath: divergedRoot.parent,
      relativePath: divergedRoot.childRel,
      childRootPath: divergedRoot.child,
      branch: "main",
      pin: divergedRoot.pin,
    });
    expect(diverged.action).toBe("blocked");
    expect(diverged.detail).toMatch(/commits not on origin/i);

    const recording = new RecordingCli(createGitCli());
    const missing = await new SafeBranchRestoreService(recording).reconcile({
      parentRootPath: missingRoot.parent,
      relativePath: missingRoot.childRel,
      childRootPath: missingRoot.child,
      branch: "main",
      pin: missingRoot.pin,
    });
    expect(missing.action).toBe("blocked");
    expect(missing.detail).toMatch(/missing refs\/remotes\/origin\/main/i);
    expect(recording.verbs()).not.toContain("fetch");
    expect(recording.verbs()).not.toContain("switch");
  }, 90_000);

  it("reconciles through the event coordinator without auto-fetch and honors disabled auto-safe", async () => {
    const repos = createRestoreRepos(tempDir());
    checkout(repos.child, repos.pin);
    const recording = new RecordingCli(createGitCli());
    const service = new SafeBranchRestoreService(recording);
    const reconciler = new BranchReconciler(recording, service, { debounceMs: 0 });
    let enabled = true;
    const coordinator = new RestoreCoordinator(reconciler, service, () => enabled);

    coordinator.onRepositoryEvent(repos.parent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await reconciler.retry(repos.parent);
    expect(runGit(repos.child, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");
    expect(recording.verbs()).not.toContain("fetch");

    enabled = false;
    const before = recording.calls.length;
    coordinator.onRepositoryEvent(repos.parent);
    expect(recording.calls.length).toBe(before);
  }, 60_000);
});
