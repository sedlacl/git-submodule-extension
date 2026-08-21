import { GitCliRunner, type GitCli } from "./gitCli.js";
import { GitRepositoryReader } from "./gitRepositoryReader.js";
import { discoverWorkspaceGitModel } from "./workspaceDiscovery.js";
import type { AdoptedDiffReader, AdoptedDiffSpec, GitModelProvider } from "./interfaces.js";
import type { NameStatusEntry, WorkspaceGitModel } from "./types.js";

export interface GitModelServiceOptions {
  gitPath: string;
  getWorkspaceFolderPaths: () => readonly string[];
  cli?: GitCli;
  reader?: GitRepositoryReader;
}

/**
 * Workspace git graph used by the SCM view and restore. Discovery is rooted at
 * workspace folders and nested exclusively by gitlink parenthood — vscode.git's
 * flat repository list is not used as the tree shape.
 */
export class GitModelService implements GitModelProvider, AdoptedDiffReader {
  private readonly reader: GitRepositoryReader;
  private readonly getWorkspaceFolderPaths: () => readonly string[];

  constructor(options: GitModelServiceOptions) {
    const cli = options.cli ?? new GitCliRunner(options.gitPath);
    this.reader = options.reader ?? new GitRepositoryReader(cli);
    this.getWorkspaceFolderPaths = options.getWorkspaceFolderPaths;
  }

  snapshot(): Promise<WorkspaceGitModel> {
    return discoverWorkspaceGitModel(this.reader, {
      workspaceFolderPaths: this.getWorkspaceFolderPaths(),
    });
  }

  listNameStatus(spec: AdoptedDiffSpec): Promise<readonly NameStatusEntry[]> {
    return this.reader.listNameStatus(spec.repoRoot, spec.fromSha, spec.toSha);
  }
}

export function createGitModelService(options: GitModelServiceOptions): GitModelService {
  return new GitModelService(options);
}
