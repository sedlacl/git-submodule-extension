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
        COMMANDS.retryRestore,
        COMMANDS.fetchRemote,
      ]),
    );
    expect(pkg.activationEvents).toContain(`onView:${VIEW_ID}`);
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === COMMANDS.refresh && entry.when.includes(VIEW_ID))).toBe(
      true,
    );
    expect(pkg.contributes.menus["view/item/context"].some((entry) => entry.command === COMMANDS.openAllChanges)).toBe(true);
    expect(CONTEXT.adoptedGroup).toContain("adoptedGroup");
  });

  it("defaults auto-safe restore on and keeps fetch/retry as native hover actions", () => {
    expect(pkg.contributes.configuration.properties[RESTORE_SETTINGS.enabled]?.default).toBe(RESTORE_DEFAULTS.enabled);
    expect(pkg.contributes.configuration.properties[RESTORE_SETTINGS.debounceMs]?.default).toBe(RESTORE_DEFAULTS.debounceMs);
    expect(pkg.contributes.commands.map((command) => command.command)).toEqual(
      expect.arrayContaining([RESTORE_COMMANDS.retry, RESTORE_COMMANDS.fetch]),
    );
    const inline = pkg.contributes.menus["view/item/context"];
    expect(inline.every((entry) => entry.group?.startsWith("inline"))).toBe(true);
    expect(inline.some((entry) => entry.command === RESTORE_COMMANDS.fetch && entry.when.includes("restoreBlocked"))).toBe(true);
    expect(pkg.contributes.menus["view/title"].some((entry) => entry.command === RESTORE_COMMANDS.retry)).toBe(true);
  });
});
