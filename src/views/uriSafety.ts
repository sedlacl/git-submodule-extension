/**
 * RFC 3986 URI splitting. `Uri.parse('file://' + fsPath)` is unsafe when the
 * path contains `#` (fragment) or `?` (query). Always use `Uri.file(fsPath)`.
 *
 * Upstream documents this in `src/vs/base/common/uri.ts` (`URI.file` vs `URI.parse`).
 */
const RFC3986 = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/;

export interface SplitUriString {
  readonly scheme: string;
  readonly path: string;
  readonly query: string;
  readonly fragment: string;
}

export function splitUriString(value: string): SplitUriString {
  const match = RFC3986.exec(value);
  return {
    scheme: match?.[2] ?? "",
    path: match?.[5] ?? "",
    query: match?.[7] ?? "",
    fragment: match?.[9] ?? "",
  };
}

/** Concatenate `file://` + fsPath the way that loses `#t1` and `?` segments. */
export function unsafeFileUrlFromFsPathConcat(fsPath: string): string {
  const posix = fsPath.replace(/\\/g, "/");
  return posix.startsWith("/") ? `file://${posix}` : `file:///${posix}`;
}
