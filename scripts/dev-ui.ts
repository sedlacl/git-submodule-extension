import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  downloadAndUnzipVSCode,
} from "@vscode/test-electron";
import { createUiFixture } from "./create-ui-fixture.js";
import { getProjectRoot, getVsCodeTestProfileArgs } from "./lib/paths.js";

export interface DevUiLaunchConfig {
  vscodeExecutablePath: string;
  workspaceFile: string;
  extensionDevelopmentPath: string;
  launchArgs: string[];
}

export function readEngineVscodeVersion(packageJsonPath: string): string {
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { engines?: { vscode?: string } };
  const raw = pkg.engines?.vscode ?? "^1.85.0";
  const match = raw.match(/(\d+\.\d+\.\d+)/);
  return match?.[1] ?? "1.85.0";
}

export function buildDevUiLaunchConfig(options: {
  projectRoot: string;
  vscodeExecutablePath: string;
  workspaceFile: string;
}): DevUiLaunchConfig {
  const extensionDevelopmentPath = options.projectRoot;
  const launchArgs = [
    options.workspaceFile,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    ...getVsCodeTestProfileArgs(options.projectRoot),
  ];

  return {
    vscodeExecutablePath: options.vscodeExecutablePath,
    workspaceFile: options.workspaceFile,
    extensionDevelopmentPath,
    launchArgs,
  };
}

function startEsbuildWatch(projectRoot: string): ChildProcess {
  const watchScript = path.join(projectRoot, "esbuild.mjs");
  return spawn(process.execPath, [watchScript, "--watch"], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
  });
}

export async function launchDevUi(options: { forceFixture?: boolean } = {}): Promise<number> {
  const projectRoot = getProjectRoot();
  const manifest = await createUiFixture({ force: options.forceFixture });
  const vscodeVersion = readEngineVscodeVersion(path.join(projectRoot, "package.json"));
  const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
  const config = buildDevUiLaunchConfig({
    projectRoot,
    vscodeExecutablePath,
    workspaceFile: manifest.workspaceFile,
  });

  const watch = startEsbuildWatch(projectRoot);

  return await new Promise<number>((resolve) => {
    const shell = process.platform === "win32";
    const child = spawn(
      shell ? `"${config.vscodeExecutablePath}"` : config.vscodeExecutablePath,
      config.launchArgs,
      {
        stdio: "inherit",
        shell,
        windowsHide: true,
      },
    );

    const shutdown = (code = 0): void => {
      if (!watch.killed) {
        watch.kill();
      }
      resolve(code);
    };

    watch.on("exit", (code) => {
      if (code && code !== 0) {
        console.error(`esbuild watch exited with code ${code}`);
      }
    });

    child.on("error", (error) => {
      console.error(error);
      shutdown(1);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        console.log(`VS Code closed (${signal})`);
      }
      shutdown(code ?? 0);
    });

    process.on("SIGINT", () => {
      child.kill("SIGTERM");
    });
  });
}

async function main(): Promise<void> {
  const forceFixture = process.argv.includes("--force-fixture");
  const code = await launchDevUi({ forceFixture });
  process.exit(code);
}

const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith("dev-ui.ts") || process.argv[1].endsWith("dev-ui.js"));

if (isMain) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
