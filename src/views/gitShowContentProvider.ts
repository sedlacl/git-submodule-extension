import * as vscode from "vscode";
import type { GitCli } from "../git/gitCli.js";
import { parseGitShowUri } from "./adoptedDiffPrep.js";
import { GIT_SHOW_SCHEME } from "./constants.js";
import { readGitPathAt } from "./gitBlobReader.js";

export class GitShowContentProvider implements vscode.TextDocumentContentProvider {
  constructor(private readonly cli: GitCli) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (uri.scheme !== GIT_SHOW_SCHEME) {
      return "";
    }
    const parsed = parseGitShowUri(uri);
    if (!parsed.repoRoot || !parsed.sha || !parsed.gitPath || parsed.empty) {
      return "";
    }
    return (await readGitPathAt(this.cli, parsed.repoRoot, parsed.sha, parsed.gitPath)) ?? "";
  }
}
