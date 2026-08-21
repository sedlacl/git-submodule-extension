import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHANGE_GROUP_LABELS } from "../../../src/git/repositoryState.js";
import {
  BUILTIN_COMMAND_TITLES,
  BUILTIN_GIT_DEVIATIONS,
  BUILTIN_GROUP_LABELS,
  BUILTIN_PANE_NAME,
} from "../../../src/views/builtinGitParity.js";
import { COMMANDS, CONTEXT, VIEW_ID } from "../../../src/views/constants.js";

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  contributes: {
    views: { scm: Array<{ id: string; name: string; contextualTitle?: string }> };
    commands: Array<{ command: string; title: string }>;
    menus: {
      "view/title": Array<{ command: string; when: string; group?: string }>;
      "view/item/context": Array<{ command: string; when: string; group?: string }>;
    };
  };
};

const docs = readFileSync(path.join(process.cwd(), "docs", "builtin-git-parity.md"), "utf8");

function commandTitle(command: string): string | undefined {
  return pkg.contributes.commands.find((entry) => entry.command === command)?.title;
}

function menu(command: string, groupPrefix: string, whenIncludes: string): boolean {
  return pkg.contributes.menus["view/item/context"].some(
    (entry) => entry.command === command && (entry.group ?? "").startsWith(groupPrefix) && entry.when.includes(whenIncludes),
  );
}

describe("built-in Git parity", () => {
  it("names the SCM pane CHANGES with submodules", () => {
    const view = pkg.contributes.views.scm.find((entry) => entry.id === VIEW_ID);
    expect(BUILTIN_PANE_NAME).toBe("CHANGES with submodules");
    expect(view?.name).toBe(BUILTIN_PANE_NAME);
    expect(view?.contextualTitle).toBe(BUILTIN_PANE_NAME);
  });

  it("uses built-in group titles", () => {
    expect(CHANGE_GROUP_LABELS).toEqual(BUILTIN_GROUP_LABELS);
    expect(BUILTIN_GROUP_LABELS).toEqual({
      merge: "Merge Changes",
      index: "Staged Changes",
      workingTree: "Changes",
      untracked: "Untracked Changes",
    });
  });

  it("declares built-in command titles on gitSubmodule.* IDs", () => {
    expect(commandTitle(COMMANDS.refresh)).toBe(BUILTIN_COMMAND_TITLES.refresh);
    expect(commandTitle(COMMANDS.openChange)).toBe(BUILTIN_COMMAND_TITLES.openChange);
    expect(commandTitle(COMMANDS.openAllChanges)).toBe(BUILTIN_COMMAND_TITLES.openAllChanges);
    expect(commandTitle(COMMANDS.openFile)).toBe(BUILTIN_COMMAND_TITLES.openFile);
    expect(commandTitle(COMMANDS.openHEADFile)).toBe(BUILTIN_COMMAND_TITLES.openHEADFile);
    expect(commandTitle(COMMANDS.stage)).toBe(BUILTIN_COMMAND_TITLES.stage);
    expect(commandTitle(COMMANDS.stageAll)).toBe(BUILTIN_COMMAND_TITLES.stageAll);
    expect(commandTitle(COMMANDS.stageAllTracked)).toBe(BUILTIN_COMMAND_TITLES.stageAllTracked);
    expect(commandTitle(COMMANDS.stageAllUntracked)).toBe(BUILTIN_COMMAND_TITLES.stageAllUntracked);
    expect(commandTitle(COMMANDS.stageAllMerge)).toBe(BUILTIN_COMMAND_TITLES.stageAllMerge);
    expect(commandTitle(COMMANDS.unstage)).toBe(BUILTIN_COMMAND_TITLES.unstage);
    expect(commandTitle(COMMANDS.unstageAll)).toBe(BUILTIN_COMMAND_TITLES.unstageAll);
    expect(commandTitle(COMMANDS.clean)).toBe(BUILTIN_COMMAND_TITLES.clean);
    expect(commandTitle(COMMANDS.cleanAll)).toBe(BUILTIN_COMMAND_TITLES.cleanAll);
    expect(commandTitle(COMMANDS.cleanAllTracked)).toBe(BUILTIN_COMMAND_TITLES.cleanAllTracked);
    expect(commandTitle(COMMANDS.cleanAllUntracked)).toBe(BUILTIN_COMMAND_TITLES.cleanAllUntracked);
    expect(commandTitle(COMMANDS.commit)).toBe(BUILTIN_COMMAND_TITLES.commit);
    expect(commandTitle(COMMANDS.sync)).toBe(BUILTIN_COMMAND_TITLES.sync);
    expect(commandTitle(COMMANDS.publish)).toBe(BUILTIN_COMMAND_TITLES.publish);
  });

  it("mirrors built-in inline and context menu slots", () => {
    expect(menu(COMMANDS.stageAllMerge, "inline", CONTEXT.changeGroupMerge)).toBe(true);
    expect(menu(COMMANDS.unstageAll, "inline", CONTEXT.changeGroupIndex)).toBe(true);
    expect(menu(COMMANDS.stageAll, "inline", "config.git.untrackedChanges == mixed")).toBe(true);
    expect(menu(COMMANDS.cleanAll, "inline", "config.git.untrackedChanges == mixed")).toBe(true);
    expect(menu(COMMANDS.stageAllTracked, "inline", "config.git.untrackedChanges != mixed")).toBe(true);
    expect(menu(COMMANDS.cleanAllTracked, "inline", "config.git.untrackedChanges != mixed")).toBe(true);
    expect(menu(COMMANDS.stageAllUntracked, "inline", CONTEXT.changeGroupUntracked)).toBe(true);
    expect(menu(COMMANDS.cleanAllUntracked, "inline", CONTEXT.changeGroupUntracked)).toBe(true);
    expect(menu(COMMANDS.stage, "inline", "change")).toBe(true);
    expect(menu(COMMANDS.unstage, "inline", "index")).toBe(true);
    expect(menu(COMMANDS.clean, "inline", "workingTree")).toBe(true);
    expect(menu(COMMANDS.openFile, "inline", "config.git.openDiffOnClick")).toBe(true);
    expect(menu(COMMANDS.stageAllMerge, "1_modification", CONTEXT.changeGroupMerge)).toBe(true);
    expect(menu(COMMANDS.openChange, "navigation", "change")).toBe(true);
    expect(menu(COMMANDS.commit, "1_modification", "workspaceRoot")).toBe(true);
    expect(menu(COMMANDS.sync, "1_modification", "workspaceRoot")).toBe(true);
    expect(menu(COMMANDS.publish, "1_modification", "workspaceRoot")).toBe(true);
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === COMMANDS.commit && entry.group === "navigation@1")).toBe(
      true,
    );
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === COMMANDS.refresh && entry.group === "navigation@2")).toBe(
      true,
    );
  });

  it("documents every intentional deviation", () => {
    for (const deviation of BUILTIN_GIT_DEVIATIONS) {
      expect(docs).toContain(deviation.id);
    }
    expect(docs).toContain("1.96.0");
    expect(docs).toContain("Hide it manually");
  });
});
