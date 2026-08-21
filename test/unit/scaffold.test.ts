import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("scaffold", () => {
  it("runs the test runner", () => {
    expect(true).toBe(true);
  });

  it("exposes verification scripts for unit, extension-host, build, and package", () => {
    expect(pkg.scripts.test).toBe("vitest run");
    expect(pkg.scripts["test:extension-host"]).toContain("run-extension-tests.ts");
    expect(pkg.scripts.build).toBe("node esbuild.mjs");
    expect(pkg.scripts.package).toContain("vsce package");
    expect(pkg.scripts["dev:cursor"]).toContain("--host=cursor");
  });
});
