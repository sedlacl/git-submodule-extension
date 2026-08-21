import { describe, expect, it } from "vitest";
import { computeAdoptedPointers, hasPointerMismatch } from "../../../src/git/adoptedPointers.js";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const INDEX = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CHECKOUT = "cccccccccccccccccccccccccccccccccccccccc";

describe("computeAdoptedPointers", () => {
  it("reports staged HEAD gitlink → index gitlink", () => {
    expect(
      computeAdoptedPointers({
        headGitlinkSha: HEAD,
        indexGitlinkSha: INDEX,
        checkoutHeadSha: INDEX,
      }),
    ).toEqual({
      staged: { fromSha: HEAD, toSha: INDEX },
      unstaged: null,
    });
  });

  it("reports unstaged index gitlink → checkout HEAD", () => {
    expect(
      computeAdoptedPointers({
        headGitlinkSha: HEAD,
        indexGitlinkSha: HEAD,
        checkoutHeadSha: CHECKOUT,
      }),
    ).toEqual({
      staged: null,
      unstaged: { fromSha: HEAD, toSha: CHECKOUT },
    });
  });

  it("reports both staged and unstaged pointer shifts", () => {
    expect(
      computeAdoptedPointers({
        headGitlinkSha: HEAD,
        indexGitlinkSha: INDEX,
        checkoutHeadSha: CHECKOUT,
      }),
    ).toEqual({
      staged: { fromSha: HEAD, toSha: INDEX },
      unstaged: { fromSha: INDEX, toSha: CHECKOUT },
    });
  });

  it("treats a missing index gitlink as matching HEAD for unstaged comparison", () => {
    expect(
      computeAdoptedPointers({
        headGitlinkSha: HEAD,
        indexGitlinkSha: null,
        checkoutHeadSha: CHECKOUT,
      }),
    ).toEqual({
      staged: null,
      unstaged: { fromSha: HEAD, toSha: CHECKOUT },
    });
  });

  it("omits unstaged when the child is uninitialized", () => {
    expect(
      computeAdoptedPointers({
        headGitlinkSha: HEAD,
        indexGitlinkSha: HEAD,
        checkoutHeadSha: null,
      }),
    ).toEqual({ staged: null, unstaged: null });
    expect(
      hasPointerMismatch({
        headGitlinkSha: HEAD,
        indexGitlinkSha: HEAD,
        checkoutHeadSha: null,
      }),
    ).toBe(false);
  });

  it("is a no-op when all pins match", () => {
    expect(
      computeAdoptedPointers({
        headGitlinkSha: HEAD,
        indexGitlinkSha: HEAD,
        checkoutHeadSha: HEAD,
      }),
    ).toEqual({ staged: null, unstaged: null });
    expect(
      hasPointerMismatch({
        headGitlinkSha: HEAD,
        indexGitlinkSha: HEAD,
        checkoutHeadSha: HEAD,
      }),
    ).toBe(false);
  });
});
