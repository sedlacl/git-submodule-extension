import type { AdoptedPointerChange, AdoptedPointerChanges, RepoPins } from "./types.js";

/**
 * Adopted pointer shifts relative to the immediate parent:
 * - staged: committed gitlink (HEAD) → index gitlink
 * - unstaged: index gitlink → child checkout HEAD
 */
export function computeAdoptedPointers(pins: RepoPins): AdoptedPointerChanges {
  const indexSha = pins.indexGitlinkSha ?? pins.headGitlinkSha;
  return {
    staged: pointerChange(pins.headGitlinkSha, pins.indexGitlinkSha),
    unstaged: pointerChange(indexSha, pins.checkoutHeadSha),
  };
}

function pointerChange(fromSha: string | null, toSha: string | null): AdoptedPointerChange | null {
  if (!fromSha || !toSha || fromSha === toSha) {
    return null;
  }
  return { fromSha, toSha };
}

export function hasPointerMismatch(pins: RepoPins): boolean {
  const expected = pins.indexGitlinkSha ?? pins.headGitlinkSha;
  return Boolean(expected && pins.checkoutHeadSha && expected !== pins.checkoutHeadSha);
}
