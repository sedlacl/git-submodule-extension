import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { PACKAGED_CODICONS_SEGMENTS } from "../../src/views/codiconsAssets.js";

export function copyCodicons(projectRoot = process.cwd()): string {
  const src = path.join(projectRoot, "node_modules", "@vscode", "codicons", "dist");
  const dest = path.join(projectRoot, ...PACKAGED_CODICONS_SEGMENTS);
  if (!fs.existsSync(src)) {
    throw new Error(`Missing @vscode/codicons at ${src}`);
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    if (fs.statSync(from).isFile()) {
      fs.copyFileSync(from, path.join(dest, name));
    }
  }
  return dest;
}
