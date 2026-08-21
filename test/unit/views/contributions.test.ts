import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESTORE_COMMANDS, RESTORE_DEFAULTS, RESTORE_SETTINGS } from "../../../src/restore/settings.js";
import { COMMANDS, CONTEXT, VIEW_ID } from "../../../src/views/constants.js";

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  contributes: {
    configuration: { properties: Record<string, { default?: unknown }> };
    views: { scm: Array<{ id: string }> };
    commands: Array<{ command: string }>;
    menus: {
      "view/title": Array<{ command: string; when: string; group?: string }>;
      "view/item/context": Array<{ command: string; when: string; group?: string }>;
    };
  };
  activationEvents: string[];
};

describe("adopted-view contributions", () => {
  it("registers the SCM tree and commands used by the view", () => {
    expect(pkg.contributes.views.scm.map((view) => view.id)).toContain(VIEW_ID);
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
        COMMANDS.checkoutBranch,
        COMMANDS.fetch,
        COMMANDS.pull,
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
    expect(pkg.contributes.menus["view/item/context"].some((entry) => entry.command === COMMANDS.openAllChanges)).toBe(true);
    const openAll = pkg.contributes.menus["view/item/context"].find(
      (entry) => entry.command === COMMANDS.openAllChanges && entry.when.includes("changeGroup"),
    );
    expect(openAll?.when).toContain("changeGroup");
    expect(openAll?.when).toContain("staged");
    expect(openAll?.when).toContain("adoptedGroup");
    const gitlinkOpenAll = pkg.contributes.menus["view/item/context"].find(
      (entry) => entry.command === COMMANDS.openAllChanges && entry.when.includes("gitlink"),
    );
    expect(gitlinkOpenAll?.group).toBe("inline@3");
    const chore = pkg.contributes.menus["view/item/context"].find(
      (entry) => entry.command === COMMANDS.generateSubmoduleChore,
    );
    expect(chore?.when).toContain("workspaceRoot");
    expect(chore?.when).toContain("submodule");
    expect(chore?.group).toBe("1_modification@4");
    const repositoryOpenAll = pkg.contributes.menus["view/item/context"].find(
      (entry) => entry.command === COMMANDS.openAllChanges && entry.when.includes("workspaceRoot"),
    );
    expect(repositoryOpenAll?.group).toBe("1_modification@5");
    const checkout = pkg.contributes.menus["view/item/context"].find(
      (entry) => entry.command === COMMANDS.checkoutBranch,
    );
    const fetch = pkg.contributes.menus["view/item/context"].find(
      (entry) => entry.command === COMMANDS.fetch,
    );
    const pull = pkg.contributes.menus["view/item/context"].find(
      (entry) => entry.command === COMMANDS.pull,
    );
    expect(checkout?.group).toBe("1_modification@1");
    expect(fetch?.group).toBe("1_modification@2");
    expect(pull?.group).toBe("1_modification@3");
    expect(pull?.when).toContain("hasUpstream");
    const sync = pkg.contributes.menus["view/item/context"].find((entry) => entry.command === COMMANDS.sync);
    const publish = pkg.contributes.menus["view/item/context"].find((entry) => entry.command === COMMANDS.publish);
    expect(sync?.when).toContain("hasUpstream");
    expect(publish?.when).toContain("noUpstream");
    expect(CONTEXT.adoptedGroup).toContain("adoptedGroup");
    expect(CONTEXT.adoptedPointer).toContain("adoptedPointer");
  });

  it("mirrors the built-in Git repository row toolbar and keeps inline slots unambiguous", () => {
    const repositoryRow = /workspaceRoot\|submodule/;
    const inlineOnRepositoryRows = pkg.contributes.menus["view/item/context"]
      .filter((entry) => entry.group?.startsWith("inline") && repositoryRow.test(entry.when))
      .map((entry) => ({ command: entry.command, group: entry.group }));
    expect(inlineOnRepositoryRows).toEqual([
      { command: COMMANDS.commit, group: "inline@1" },
      { command: COMMANDS.sync, group: "inline@2" },
      { command: COMMANDS.publish, group: "inline@2" },
      { command: COMMANDS.refresh, group: "inline@3" },
    ]);

    const submoduleInline = pkg.contributes.menus["view/item/context"].filter(
      (entry) => entry.group?.startsWith("inline") && (repositoryRow.test(entry.when) || /submodule|restoreBlocked/.test(entry.when)),
    );
    const slotOwners = new Map<string, string[]>();
    for (const entry of submoduleInline) {
      slotOwners.set(entry.group ?? "", [...(slotOwners.get(entry.group ?? "") ?? []), entry.command]);
    }
    // Only sync/publish may share a slot; they are mutually exclusive via the upstream context key.
    expect([...slotOwners].filter(([, commands]) => commands.length > 1)).toEqual([
      ["inline@2", [COMMANDS.sync, COMMANDS.publish]],
    ]);
  });

  it("defaults auto-safe restore on and keeps fetch/retry as native hover actions", () => {
    expect(pkg.contributes.configuration.properties[RESTORE_SETTINGS.enabled]?.default).toBe(RESTORE_DEFAULTS.enabled);
    expect(pkg.contributes.configuration.properties[RESTORE_SETTINGS.debounceMs]?.default).toBe(RESTORE_DEFAULTS.debounceMs);
    expect(pkg.contributes.commands.map((command) => command.command)).toEqual(
      expect.arrayContaining([RESTORE_COMMANDS.retry, RESTORE_COMMANDS.fetch]),
    );
    const inline = pkg.contributes.menus["view/item/context"];
    expect(inline.some((entry) => entry.command === RESTORE_COMMANDS.retry && entry.group?.startsWith("inline"))).toBe(true);
    expect(inline.some((entry) => entry.command === RESTORE_COMMANDS.fetch && entry.when.includes("restoreBlocked"))).toBe(true);
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === RESTORE_COMMANDS.retry)).toBe(true);
  });
});
