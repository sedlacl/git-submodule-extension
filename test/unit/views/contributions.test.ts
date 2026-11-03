import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESTORE_COMMANDS, RESTORE_DEFAULTS, RESTORE_SETTINGS } from "../../../src/restore/settings.js";
import { COMMANDS, CONTEXT, VIEW_ID } from "../../../src/views/constants.js";
import {
  contextActions,
  contextMenuGroup,
  contextMenuKey,
  DEFAULT_ROW_ACTION_CONFIG,
  inlineActions,
} from "../../../src/views/changesRowActions.js";

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  contributes: {
    configuration: { properties: Record<string, { default?: unknown }> };
    views: { scm: Array<{ id: string; type?: string }> };
    commands: Array<{ command: string }>;
    menus: {
      "view/title": Array<{ command: string; when: string; group?: string }>;
      "webview/context": Array<{ command: string; when: string; group?: string }>;
      "view/item/context"?: Array<{ command: string; when: string; group?: string }>;
    };
  };
  activationEvents: string[];
};

const repoUpstream = `${CONTEXT.workspaceRoot}.${CONTEXT.hasUpstream}`;
const repoNoUpstream = `${CONTEXT.workspaceRoot}.${CONTEXT.noUpstream}`;
const submodule = `${CONTEXT.submodule}.${CONTEXT.hasUpstream}`;
const restoreBlocked = `${CONTEXT.submodule}.restoreBlocked`;

describe("adopted-view contributions", () => {
  it("contributes one native row context-menu item per context action, gated by the row's menu key", () => {
    const contextValues = [
      ...[CONTEXT.workspaceRoot, CONTEXT.submodule].flatMap((root) => [
        `${root}.${CONTEXT.hasUpstream}`,
        `${root}.${CONTEXT.noUpstream}`,
      ]),
      ...Object.values(CONTEXT).filter((value) => value.startsWith("gitSubmodule.")),
      `${CONTEXT.changeIndex}.${CONTEXT.gitlink}`,
      `${CONTEXT.changeWorkingTree}.${CONTEXT.gitlink}`,
    ];
    const expected = new Map<string, string>();
    for (const untrackedChanges of ["mixed", "separate", "hidden"] as const) {
      for (const contextValue of contextValues) {
        for (const action of contextActions(contextValue, { ...DEFAULT_ROW_ACTION_CONFIG, untrackedChanges })) {
          const group = contextMenuGroup(action.order);
          expect(expected.get(action.command) ?? group).toBe(group);
          expected.set(action.command, group);
        }
      }
    }
    const menu = pkg.contributes.menus["webview/context"];
    expect(new Map(menu.map((entry) => [entry.command, entry.group]))).toEqual(expected);
    for (const entry of menu) {
      expect(entry.when).toBe(`webviewId == ${VIEW_ID} && ${contextMenuKey(entry.command)}`);
    }
  });

  it("registers the SCM webview and commands used by the view", () => {
    const view = pkg.contributes.views.scm.find((entry) => entry.id === VIEW_ID);
    expect(view?.type).toBe("webview");
    expect(pkg.contributes.commands.map((command) => command.command)).toEqual(
      expect.arrayContaining([
        COMMANDS.refresh,
        COMMANDS.openDiff,
        COMMANDS.openAllChanges,
        COMMANDS.stage,
        COMMANDS.unstage,
        COMMANDS.clean,
        COMMANDS.commit,
        COMMANDS.generateSubmoduleChore,
        COMMANDS.generateCommitMessage,
        COMMANDS.checkoutBranch,
        COMMANDS.copyBranchName,
        COMMANDS.fetch,
        COMMANDS.pull,
        COMMANDS.pullRecurseSubmodules,
        COMMANDS.sync,
        COMMANDS.publish,
        COMMANDS.viewAsTree,
        COMMANDS.viewAsList,
        COMMANDS.retryRestore,
        COMMANDS.fetchRemote,
      ]),
    );
    expect(pkg.activationEvents).toContain(`onView:${VIEW_ID}`);
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === COMMANDS.refresh && entry.when.includes(VIEW_ID))).toBe(
      true,
    );
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === COMMANDS.viewAsList && entry.group === "navigation@4")).toBe(
      true,
    );
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === COMMANDS.viewAsTree && entry.group === "navigation@4")).toBe(
      true,
    );
    expect(pkg.contributes.menus["view/item/context"]).toBeUndefined();
    expect(inlineActions(CONTEXT.changeGroupIndex).some((action) => action.command === COMMANDS.openAllChanges)).toBe(true);
    expect(inlineActions(CONTEXT.changeGroupMerge).some((action) => action.command === COMMANDS.openAllChanges)).toBe(true);
    expect(inlineActions(CONTEXT.adoptedGroup).some((action) => action.command === COMMANDS.openAllChanges)).toBe(true);
    expect(
      inlineActions(`${CONTEXT.changeWorkingTree}.${CONTEXT.gitlink}`).some(
        (action) => action.command === COMMANDS.openAllChanges && action.order === 3,
      ),
    ).toBe(true);
    const chore = contextActions(repoUpstream).find((action) => action.command === COMMANDS.generateSubmoduleChore);
    expect(chore?.order).toBe(4);
    const repositoryOpenAll = contextActions(repoUpstream).find((action) => action.command === COMMANDS.openAllChanges);
    expect(repositoryOpenAll?.order).toBe(5);
    expect(contextActions(repoUpstream).map((action) => action.command)).toEqual(
      expect.arrayContaining([
        COMMANDS.checkoutBranch,
        COMMANDS.fetch,
        COMMANDS.pull,
        COMMANDS.pullRecurseSubmodules,
      ]),
    );
    expect(contextActions(repoUpstream).slice(0, 2).map((action) => action.command)).toEqual([
      COMMANDS.checkoutBranch,
      COMMANDS.copyBranchName,
    ]);
    expect(contextActions(submodule).some((action) => action.command === COMMANDS.copyBranchName)).toBe(true);
    expect(contextActions(CONTEXT.changeIndex).some((action) => action.command === COMMANDS.copyBranchName)).toBe(false);
    expect(contextActions(repoUpstream).findIndex((action) => action.command === COMMANDS.pullRecurseSubmodules)).toBe(
      contextActions(repoUpstream).findIndex((action) => action.command === COMMANDS.pull) + 1,
    );
    expect(contextActions(repoNoUpstream).some((action) => action.command === COMMANDS.pull)).toBe(false);
    expect(contextActions(repoNoUpstream).some((action) => action.command === COMMANDS.pullRecurseSubmodules)).toBe(
      false,
    );
    expect(inlineActions(repoUpstream).some((action) => action.command === COMMANDS.sync)).toBe(true);
    expect(inlineActions(repoNoUpstream).some((action) => action.command === COMMANDS.publish)).toBe(true);
    expect(CONTEXT.adoptedGroup).toContain("adoptedGroup");
    expect(CONTEXT.adoptedPointer).toContain("adoptedPointer");
  });

  it("mirrors the built-in Git repository row toolbar and keeps inline slots unambiguous", () => {
    const upstream = inlineActions(repoUpstream).filter((action) => action.group === "inline");
    expect(upstream.map((action) => ({ command: action.command, order: action.order }))).toEqual([
      { command: COMMANDS.commit, order: 1 },
      { command: COMMANDS.sync, order: 2 },
      { command: COMMANDS.refresh, order: 3 },
    ]);
    const noUpstream = inlineActions(repoNoUpstream);
    expect(noUpstream.map((action) => action.command)).toContain(COMMANDS.publish);
    expect(noUpstream.map((action) => action.command)).not.toContain(COMMANDS.sync);

    const submoduleInline = [
      ...inlineActions(submodule),
      ...inlineActions(restoreBlocked).filter((action) => action.command === COMMANDS.fetchRemote),
    ];
    const slotOwners = new Map<number, string[]>();
    for (const action of submoduleInline) {
      slotOwners.set(action.order, [...(slotOwners.get(action.order) ?? []), action.command]);
    }
    expect([...slotOwners].filter(([, commands]) => commands.length > 1)).toEqual([]);
    expect(inlineActions(repoUpstream).some((action) => action.command === COMMANDS.sync)).toBe(true);
    expect(inlineActions(repoNoUpstream).some((action) => action.command === COMMANDS.publish)).toBe(true);
  });

  it("defaults auto-safe restore on and keeps fetch/retry as row toolbar actions", () => {
    expect(pkg.contributes.configuration.properties[RESTORE_SETTINGS.enabled]?.default).toBe(RESTORE_DEFAULTS.enabled);
    expect(pkg.contributes.configuration.properties[RESTORE_SETTINGS.debounceMs]?.default).toBe(RESTORE_DEFAULTS.debounceMs);
    expect(pkg.contributes.commands.map((command) => command.command)).toEqual(
      expect.arrayContaining([RESTORE_COMMANDS.retry, RESTORE_COMMANDS.fetch]),
    );
    expect(inlineActions(submodule).some((action) => action.command === RESTORE_COMMANDS.retry)).toBe(true);
    expect(inlineActions(restoreBlocked).some((action) => action.command === RESTORE_COMMANDS.fetch)).toBe(true);
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === RESTORE_COMMANDS.retry)).toBe(true);
  });
});
