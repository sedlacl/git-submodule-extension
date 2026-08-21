import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { quotePathForDocs, toFileUrl } from "../../scripts/lib/paths.js";

describe("paths", () => {
  it("builds file URLs with three slashes after the scheme", () => {
    const existing = path.join(process.cwd(), "package.json");
    const url = toFileUrl(existing);
    expect(url.startsWith("file:///")).toBe(true);
    expect(url.toLowerCase()).toContain("package.json");
  });

  it("builds file URLs for Windows-style paths", () => {
    const existing = path.join(process.cwd(), "README.md");
    const url = toFileUrl(existing.replace(/\//g, "\\"));
    expect(url.startsWith("file:///")).toBe(true);
  });

  it("quotes paths for shell docs on the current platform", () => {
    const sample = path.join(os.tmpdir(), "ui fixture");
    const quoted = quotePathForDocs(sample);
    expect(quoted.startsWith('"') || quoted.startsWith("'")).toBe(true);
    expect(quoted).toContain("ui fixture");
  });
});
