import { describe, expect, it } from "vitest";
import { parseGitmodules } from "../../../src/git/gitmodulesParser.js";

describe("parseGitmodules", () => {
  it("parses direct submodules with branch and url", () => {
    const parsed = parseGitmodules(`
[submodule "submodules/uu_energygateway_httpendpointg01"]
	path = submodules/uu_energygateway_httpendpointg01
	url = ssh://git@example/httpendpointg01.git
	branch = aflex/6.3
[submodule "submodules/usy_idsmari_commong01"]
	path = submodules/usy_idsmari_commong01
	url = ssh://git@example/commong01.git
	branch = development/AFLEX
`);

    expect(parsed).toEqual([
      {
        name: "submodules/uu_energygateway_httpendpointg01",
        path: "submodules/uu_energygateway_httpendpointg01",
        url: "ssh://git@example/httpendpointg01.git",
        branch: "aflex/6.3",
      },
      {
        name: "submodules/usy_idsmari_commong01",
        path: "submodules/usy_idsmari_commong01",
        url: "ssh://git@example/commong01.git",
        branch: "development/AFLEX",
      },
    ]);
  });

  it("strips quotes so infra-deploy paths with # stay intact", () => {
    const parsed = parseGitmodules(`
[submodule "submodules/usy_aflex_initdatag01#t1"]
	path = "submodules/usy_aflex_initdatag01#t1"
	url = "ssh://git@example/initdata.git"
	branch = "feature/t1-deployment"
`);

    expect(parsed).toEqual([
      {
        name: "submodules/usy_aflex_initdatag01#t1",
        path: "submodules/usy_aflex_initdatag01#t1",
        url: "ssh://git@example/initdata.git",
        branch: "feature/t1-deployment",
      },
    ]);
  });

  it("ignores comments, unknown keys, and entries without a path", () => {
    const parsed = parseGitmodules(`
# comment
; another
[submodule "orphan"]
	url = ssh://example/orphan.git
[submodule "kept"]
	path = kept
	update = none
`);

    expect(parsed).toEqual([
      {
        name: "kept",
        path: "kept",
        url: null,
        branch: null,
      },
    ]);
  });

  it("returns an empty list for blank content", () => {
    expect(parseGitmodules("")).toEqual([]);
  });
});
