import * as esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";
import { createUiFixture } from "./create-ui-fixture.js";
import { readEngineVscodeVersion } from "./dev-ui.js";
import { getProjectRoot } from "./lib/paths.js";

export async function bundleExtensionHostTests(projectRoot: string): Promise<string> {
  const outfile = path.join(projectRoot, ".vscode-test", "extension-tests.js");
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(projectRoot, "test", "extension-host", "index.ts")],
    bundle: true,
    outfile,
    external: ["vscode"],
    format: "cjs",
    platform: "node",
    sourcemap: true,
    logLevel: "info",
  });
  return outfile;
}

export async function runExtensionHostTests(): Promise<number> {
  const projectRoot = getProjectRoot();
  const build = spawnSync(process.execPath, [path.join(projectRoot, "esbuild.mjs")], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (build.status !== 0) {
    throw new Error(`esbuild failed with exit ${build.status ?? "unknown"}`);
  }

  const fixtureRoot = path.join(projectRoot, "fixtures", "ui");
  const manifest = await createUiFixture({ fixtureRoot });
  const extensionTestsPath = await bundleExtensionHostTests(projectRoot);
  const vscodeVersion = readEngineVscodeVersion(path.join(projectRoot, "package.json"));
  const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
  const profileRoot = path.join(projectRoot, ".vscode-test", "ext-host-profile");

  try {
    await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath: projectRoot,
      extensionTestsPath,
      launchArgs: [
        manifest.workspaceFile,
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--no-sandbox",
        `--user-data-dir=${path.join(profileRoot, "user-data")}`,
        `--extensions-dir=${path.join(profileRoot, "extensions")}`,
      ],
    });
    return 0;
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error("Extension Development Host tests failed.");
    console.error(detail);
    if (/spawn .* ENOENT/i.test(detail)) {
      console.error("VS Code executable was not found after downloadAndUnzipVSCode.");
    } else if (/Exited with code/i.test(detail) || /Failed to run tests/i.test(detail)) {
      console.error("The isolated VS Code window started but the extension-host suite failed or crashed.");
    }
    return 1;
  }
}

async function main(): Promise<void> {
  process.exit(await runExtensionHostTests());
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("run-extension-tests.ts") || process.argv[1].endsWith("run-extension-tests.js"));

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
