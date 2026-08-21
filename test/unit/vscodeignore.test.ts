import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const vscodeignore = readFileSync(path.join(process.cwd(), ".vscodeignore"), "utf8");
const lines = vscodeignore
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.length > 0 && !line.startsWith("#"));

describe("vscodeignore packaging exclusions", () => {
  it("excludes editor metadata, tests, fixtures, temp, and node_modules from VSIX", () => {
    for (const pattern of [".cursor/**", "test/**", "fixtures/**", "temp/**", "node_modules/**"]) {
      expect(lines).toContain(pattern);
    }
  });
});
