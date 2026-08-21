import { describe, expect, it } from "vitest";
import { splitUriString, unsafeFileUrlFromFsPathConcat } from "../../../src/views/uriSafety.js";

const HASH_T1 =
  "R:\\External\\git-submodule-extension\\fixtures\\ui\\infra-deploy\\submodules\\usy_aflex_initdatag01#t1\\local\\t1-wip.txt";

describe("uriSafety", () => {
  it("shows file:// concatenation treats infra-deploy #t1 as a URI fragment", () => {
    const split = splitUriString(unsafeFileUrlFromFsPathConcat(HASH_T1));
    expect(split.scheme).toBe("file");
    expect(split.path).toBe(
      "/R:/External/git-submodule-extension/fixtures/ui/infra-deploy/submodules/usy_aflex_initdatag01",
    );
    expect(split.fragment).toBe("t1/local/t1-wip.txt");
    expect(split.path).not.toContain("t1-wip.txt");
  });

  it("shows other reserved characters: ? starts query, % stays in path, space stays in path", () => {
    expect(splitUriString(unsafeFileUrlFromFsPathConcat("R:\\repo\\why?\\file.txt"))).toMatchObject({
      path: "/R:/repo/why",
      query: "/file.txt",
      fragment: "",
    });
    expect(splitUriString(unsafeFileUrlFromFsPathConcat("R:\\repo\\100%done\\file.txt"))).toMatchObject({
      path: "/R:/repo/100%done/file.txt",
      query: "",
      fragment: "",
    });
    expect(splitUriString(unsafeFileUrlFromFsPathConcat("R:\\repo\\my file\\file.txt"))).toMatchObject({
      path: "/R:/repo/my file/file.txt",
      query: "",
      fragment: "",
    });
  });
});
