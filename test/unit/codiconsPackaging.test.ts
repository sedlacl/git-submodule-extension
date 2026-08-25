import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PACKAGED_CODICONS_SEGMENTS } from "../../src/views/codiconsAssets.js";
import { copyCodicons } from "../../scripts/lib/copyCodicons.js";

describe("packaged codicons", () => {
  it("copies Codicon CSS and font next to the extension bundle", () => {
    const dest = copyCodicons(process.cwd());
    expect(path.basename(path.dirname(dest))).toBe(PACKAGED_CODICONS_SEGMENTS[0]);
    expect(path.basename(dest)).toBe(PACKAGED_CODICONS_SEGMENTS[1]);
    expect(fs.existsSync(path.join(dest, "codicon.css"))).toBe(true);
    expect(fs.existsSync(path.join(dest, "codicon.ttf"))).toBe(true);
    expect(fs.readFileSync(path.join(process.cwd(), "esbuild.mjs"), "utf8")).toContain(
      PACKAGED_CODICONS_SEGMENTS.map((segment) => `"${segment}"`).join(", "),
    );
  });

  it("includes the copied Codicon assets in the VSIX file list", { timeout: 60_000 }, () => {
    copyCodicons(process.cwd());
    const vsce = path.join(process.cwd(), "node_modules", "@vscode", "vsce", "vsce");
    const listed = execFileSync(process.execPath, [vsce, "ls", "--no-dependencies"], { encoding: "utf8" }).replaceAll(
      "\\",
      "/",
    );
    expect(listed).toContain("dist/codicons/codicon.css");
    expect(listed).toContain("dist/codicons/codicon.ttf");
    expect(listed).not.toContain("node_modules/@vscode/codicons");
  });
});
