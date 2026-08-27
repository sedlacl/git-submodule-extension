import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addSubmodule,
  commitAll,
  commitFile,
  initRepo,
  runGit,
  stageGitlink,
  submoduleUpdate,
} from "../../scripts/lib/git-fixture.js";
import { toFileUrl } from "../../scripts/lib/paths.js";
import { SubmoduleChoreReadService } from "../../src/scm/submoduleChoreService.js";
import { createGitCli, makeTempRoot, removeTempRoot, sha } from "./helpers.js";

describe("nested submodule chore integration", () => {
  let root: string;
  let parent: string;

  beforeAll(() => {
    root = makeTempRoot("git-submodule-chore-nested-");
    const nestedLeaf = path.join(root, "nested-leaf");
    const middle = path.join(root, "middle");
    parent = path.join(root, "parent");
    const middleRel = "submodules/middle";
    const nestedRel = "submodules/nested-leaf";

    initRepo(nestedLeaf, "aflex/6.3-production");
    commitFile(nestedLeaf, "README.md", "# nested\n", "init nested");

    initRepo(middle, "development/AFLEX");
    commitFile(middle, "README.md", "# middle\n", "init middle");
    addSubmodule(middle, nestedRel, toFileUrl(nestedLeaf), "aflex/6.3-production");
    submoduleUpdate(middle);
    const middleOldSha = commitAll(middle, "add nested submodule");

    initRepo(parent, "main");
    commitFile(parent, "README.md", "# parent\n", "init parent");
    addSubmodule(parent, middleRel, toFileUrl(middle), "development/AFLEX");
    submoduleUpdate(parent);
    commitAll(parent, "pin middle submodule");

    commitFile(
      nestedLeaf,
      "feature.txt",
      "enabled\n",
      "T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support",
    );
    runGit(middle, ["checkout", "development/AFLEX"]);
    runGit(middle, ["submodule", "update", "--remote", nestedRel]);
    runGit(middle, ["add", nestedRel]);
    const middleNewSha = commitAll(
      middle,
      "chore: update submodule nested-leaf to latest commit daa114b",
    );

    runGit(middle, ["checkout", middleNewSha]);
    stageGitlink(parent, middleRel, middleNewSha);
    runGit(parent, ["submodule", "update", middleRel]);

    expect(sha(parent, `HEAD:${middleRel}`)).toBe(middleOldSha);
    expect(sha(parent, `:${middleRel}`)).toBe(middleNewSha);
    expect(sha(path.join(parent, middleRel))).toBe(middleNewSha);
  }, 120_000);

  afterAll(() => {
    removeTempRoot(root);
  });

  it("renders parent → submodule → nested gitlink ranges with a deterministic single-leaf subject", async () => {
    const preview = await new SubmoduleChoreReadService(createGitCli()).preview(parent);
    expect(preview).not.toBeNull();
    expect(preview!.updates).toHaveLength(1);
    expect(preview!.subject).toBe(
      "chore: update middle: T8054 - Add SaveMessagePipelineProcessor tests and savePayloadType support",
    );
    expect(preview!.message).toContain("submodules/middle (");
    expect(preview!.message).toContain(
      "nested submodule submodules/middle/submodules/nested-leaf",
    );
    expect(preview!.message).toMatch(/T8054 - Add SaveMessagePipelineProcessor/);
    expect(preview!.message).not.toContain("Note:");
    expect(preview!.message).not.toMatch(/not staged/i);
  }, 60_000);
});
