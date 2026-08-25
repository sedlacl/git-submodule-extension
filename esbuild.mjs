import * as esbuild from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const watch = process.argv.includes("--watch");
const projectRoot = path.dirname(fileURLToPath(import.meta.url));
copyCodicons(projectRoot);

/** Destination must stay in sync with `PACKAGED_CODICONS_SEGMENTS`. */

function copyCodicons(root) {
  const src = path.join(root, "node_modules", "@vscode", "codicons", "dist");
  const dest = path.join(root, "dist", "codicons");
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
}

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  sourcemap: true,
  minify: !watch,
  logLevel: "info",
};

if (watch) {
  const context = await esbuild.context(buildOptions);
  await context.watch();
  console.log("Watching for changes...");
} else {
  await esbuild.build(buildOptions);
}
