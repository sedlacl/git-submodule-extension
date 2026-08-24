import { describe, expect, it } from "vitest";
import { COMMANDS, CONTEXT } from "../../../src/views/constants.js";
import {
  DEFAULT_ROW_ACTION_CONFIG,
  contextActions,
  inlineActions,
} from "../../../src/views/changesRowActions.js";

describe("changesRowActions", () => {
  it("shows mixed working-tree stage/discard and switches when untracked are separate", () => {
    const mixed = inlineActions(CONTEXT.changeGroupWorkingTree);
    expect(mixed.map((action) => action.command)).toEqual(
      expect.arrayContaining([COMMANDS.openAllChanges, COMMANDS.stageAll, COMMANDS.cleanAll]),
    );
    const separate = inlineActions(CONTEXT.changeGroupWorkingTree, {
      ...DEFAULT_ROW_ACTION_CONFIG,
      untrackedChanges: "separate",
    });
    expect(separate.map((action) => action.command)).toEqual(
      expect.arrayContaining([COMMANDS.stageAllTracked, COMMANDS.cleanAllTracked]),
    );
    expect(separate.map((action) => action.command)).not.toContain(COMMANDS.stageAll);
  });

  it("offers the opposite inline open action from git.openDiffOnClick", () => {
    const diffClick = inlineActions(CONTEXT.changeWorkingTree);
    expect(diffClick.some((action) => action.command === COMMANDS.openFile)).toBe(true);
    const fileClick = inlineActions(CONTEXT.changeWorkingTree, {
      ...DEFAULT_ROW_ACTION_CONFIG,
      openDiffOnClick: false,
    });
    expect(fileClick.some((action) => action.command === COMMANDS.openChange)).toBe(true);
  });

  it("keeps context navigation actions for change rows", () => {
    const actions = contextActions(CONTEXT.changeIndex);
    expect(actions.map((action) => action.command)).toEqual(
      expect.arrayContaining([COMMANDS.openChange, COMMANDS.openFile, COMMANDS.openHEADFile, COMMANDS.unstage]),
    );
  });
});
