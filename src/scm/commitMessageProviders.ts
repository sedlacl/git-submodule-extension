import { existsSync } from "node:fs";
import * as os from "node:os";
import * as vscode from "vscode";
import type { GitCli } from "../git/gitCli.js";
import {
  buildClaudeCommitMessageArgs,
  CLAUDE_CODE_EXTENSION_ID,
  collectCommitMessageContext,
  DEFAULT_CLAUDE_COMMIT_MESSAGE_MODEL,
  resolveClaudeExecutable,
  runClaudeCommitMessage,
} from "./claudeCommitMessage.js";
import {
  CLAUDE_CLI_COMMIT_MESSAGE,
  GITLENS_GENERATE_COMMIT_MESSAGE,
  parseCommitMessageProviderPreference,
  pickPublicGenerateCommitMessageCommand,
  type CommitMessageProviderPreference,
} from "./generateCommitMessage.js";

/** Context key: show Generate Commit Message in the built-in SCM title, where the host has no own sparkle. */
export const COMMIT_MESSAGE_SCM_TITLE_CONTEXT = "gitSubmodule.commitMessageScmTitleAction";

export function readCommitMessageProviderPreference(): CommitMessageProviderPreference {
  return parseCommitMessageProviderPreference(
    vscode.workspace.getConfiguration("gitSubmodule").get("commitMessage.provider"),
  );
}

function readClaudeModel(): string {
  return vscode.workspace
    .getConfiguration("gitSubmodule")
    .get<string>("commitMessage.claudeModel", DEFAULT_CLAUDE_COMMIT_MESSAGE_MODEL);
}

export function findClaudeExecutable(): string | undefined {
  return resolveClaudeExecutable({
    extensionPath: vscode.extensions.getExtension(CLAUDE_CODE_EXTENSION_ID)?.extensionPath,
    platform: process.platform,
    pathEnv: process.env.PATH,
    exists: existsSync,
  });
}

/** Registered command IDs plus the internal Claude CLI provider when its executable exists. */
export async function listCommitMessageProviderIds(): Promise<string[]> {
  const commands = await vscode.commands.getCommands(true);
  return findClaudeExecutable() ? [...commands, CLAUDE_CLI_COMMIT_MESSAGE] : commands;
}

/** Picks the configured provider and updates the SCM title context key. */
export async function refreshCommitMessageProvider(): Promise<string | undefined> {
  const provider = pickPublicGenerateCommitMessageCommand(
    await listCommitMessageProviderIds(),
    readCommitMessageProviderPreference(),
  );
  // Cursor and Copilot already put a sparkle into the built-in commit input.
  const scmTitleAction = provider === CLAUDE_CLI_COMMIT_MESSAGE || provider === GITLENS_GENERATE_COMMIT_MESSAGE;
  await vscode.commands.executeCommand("setContext", COMMIT_MESSAGE_SCM_TITLE_CONTEXT, scmTitleAction);
  return provider;
}

/**
 * Runs the Claude Code CLI for `rootPath` and returns the message, or `undefined`
 * when the repository has no changes to describe.
 */
export async function generateCommitMessageWithClaude(cli: GitCli, rootPath: string): Promise<string | undefined> {
  const executable = findClaudeExecutable();
  if (!executable) {
    throw new Error("Claude Code CLI not found. Install the Claude Code extension or put claude on PATH.");
  }
  const input = await collectCommitMessageContext(cli, rootPath);
  if (!input) {
    return undefined;
  }
  return await runClaudeCommitMessage({
    executable,
    args: buildClaudeCommitMessageArgs(readClaudeModel()),
    input,
    cwd: os.tmpdir(),
  });
}
