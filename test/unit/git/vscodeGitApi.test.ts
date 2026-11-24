import { describe, expect, it, vi } from "vitest";
import { VsCodeGitApiAdapter } from "../../../src/git/vscodeGitApi.js";

// Hoisted above the import by vitest.
vi.mock("vscode", () => ({
  Disposable: class {
    constructor(private readonly callOnDispose: () => void) {}
    dispose(): void {
      this.callOnDispose();
    }
  },
  workspace: {},
}));

function fakeRepository(rootPath: string) {
  const listeners = new Set<() => void>();
  return {
    rootUri: { fsPath: rootPath },
    state: {
      HEAD: { name: "main", commit: "a".repeat(40), type: 0 },
      remotes: [],
      mergeChanges: [],
      indexChanges: [],
      workingTreeChanges: [],
      untrackedChanges: [],
      onDidChange(listener: () => void) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
    },
    fire(): void {
      for (const listener of [...listeners]) listener();
    },
  };
}

describe("VsCodeGitApiAdapter.getRootPaths", () => {
  it("adds repositories vscode.git has open outside the workspace folders", () => {
    // A repository opened through one of its files is in vscode.git's Repositories list but in no
    // workspace folder; CHANGES with submodules left it out.
    const api = { repositories: [fakeRepository("/ws/app"), fakeRepository("/ws/app/sub"), fakeRepository("/other/am")] };
    const workspace = { workspaceFolders: [{ uri: { fsPath: "/ws/app" } }, { uri: { fsPath: "/ws/lib" } }] };
    const adapter = new VsCodeGitApiAdapter(api as never, workspace as never);
    expect(adapter.getRootPaths()).toEqual(["/ws/app", "/ws/lib", "/ws/app/sub", "/other/am"]);
  });
});

describe("VsCodeGitApiAdapter.subscribe", () => {
  it("keeps every subscription's repository listeners", () => {
    // The CHANGES view subscribes at activation and branch restore after vscode.git is ready.
    // A shared listener map let the later subscription dispose the view's listeners, so the view
    // stopped following branch switches once restore no longer refreshed it in a loop.
    const repository = fakeRepository("/repo");
    const noEvent = () => ({ dispose() {} });
    const api = { repositories: [repository], onDidOpenRepository: noEvent, onDidCloseRepository: noEvent };
    const adapter = new VsCodeGitApiAdapter(api as never, {} as never);
    const view = vi.fn();
    const restore = vi.fn();
    adapter.subscribe({ onDidChangeRepositoryState: view });
    const restoreSubscription = adapter.subscribe({ onDidChangeRepositoryState: restore });

    repository.fire();
    expect(view).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);

    restoreSubscription.dispose();
    repository.fire();
    expect(view).toHaveBeenCalledTimes(2);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
