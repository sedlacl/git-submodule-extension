import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalizeRepoPath,
  displayNameFromRepoPath,
  joinRepoPath,
  normalizeGitRelativePath,
  normalizeRepoPath,
  repoMapGet,
  repoSetHas,
  sameRepoPath,
} from "../../../src/git/pathUtils.js";

describe("pathUtils", () => {
  it("keeps infra-deploy #t1 segments and rejects traversal", () => {
    expect(normalizeGitRelativePath("submodules/usy_aflex_initdatag01#t1")).toBe(
      "submodules/usy_aflex_initdatag01#t1",
    );
    expect(normalizeGitRelativePath("../outside")).toBeNull();
    expect(normalizeGitRelativePath("/abs")).toBeNull();
  });

  it("joins POSIX git paths onto a parent root and keeps the # suffix in the display name", () => {
    const parent = path.join(process.cwd(), "infra");
    const joined = joinRepoPath(parent, "submodules/usy_aflex_initdatag01#t1");
    expect(joined).toBe(path.join(parent, "submodules", "usy_aflex_initdatag01#t1"));
    expect(displayNameFromRepoPath(joined)).toBe("usy_aflex_initdatag01#t1");
  });

  it("looks up repository maps and sets across slash and drive-letter spellings", () => {
    const root = path.join(process.cwd(), "submodules", "usy_aflex_initdatag01#t1");
    const alias = normalizeRepoPath(root);
    expect(repoSetHas(new Set([root]), alias)).toBe(true);
    expect(repoMapGet(new Map([[root, "ok"]]), alias)).toBe("ok");
    expect(repoSetHas(new Set([alias]), root)).toBe(true);
    expect(normalizeRepoPath(root.replace(/\\/g, "/"))).toBe(alias);
  });

  it("canonicalizes existing directories so 8.3 short names match Git toplevel paths", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-submodule-path-"));
    try {
      const real = fs.realpathSync.native(root);
      expect(sameRepoPath(root, real)).toBe(true);
      expect(canonicalizeRepoPath(root)).toBe(canonicalizeRepoPath(real));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
