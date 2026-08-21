import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  downloadAndUnzipVSCode,
} from "@vscode/test-electron";
import { createUiFixture } from "./create-ui-fixture.js";
import { getProjectRoot } from "./lib/paths.js";

export type DevUiHost = "vscode" | "cursor";

export interface DevUiLaunchConfig {
  vscodeExecutablePath: string;
  workspaceFile: string;
  extensionDevelopmentPath: string;
  launchArgs: string[];
}

export function parseDevUiHost(argv: readonly string[]): DevUiHost {
  const flag = argv.find((arg) => arg.startsWith("--host="));
  if (flag === "--host=cursor" || argv.includes("--cursor")) {
    return "cursor";
  }
  return "vscode";
}

/**
 * Resolve the Cursor Electron app binary (not the CLI shim).
 * The `cursor` shell wrapper talks to an existing window over IPC and exits
 * immediately, so Extension Development Host + fixture workspace never open.
 */
export function resolveCursorExecutable(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CURSOR_BIN?.trim() || env.CURSOR?.trim();
  if (fromEnv) {
    if (fs.existsSync(fromEnv)) {
      return resolveCursorElectronBinary(fromEnv);
    }
    return path.resolve(fromEnv);
  }

  const whichCmd = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(whichCmd, ["cursor"], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  });
  const candidates = (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const candidate of candidates) {
    try {
      return resolveCursorElectronBinary(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }

  const fallbacks =
    process.platform === "darwin"
      ? ["/Applications/Cursor.app/Contents/MacOS/Cursor"]
      : process.platform === "win32"
        ? [
            path.join(env.LOCALAPPDATA ?? "", "Programs", "cursor", "Cursor.exe"),
            path.join(env.LOCALAPPDATA ?? "", "Programs", "Cursor", "Cursor.exe"),
          ]
        : ["/usr/share/cursor/cursor", "/opt/Cursor/cursor", "/opt/cursor/cursor"];

  for (const fallback of fallbacks) {
    if (fallback && fs.existsSync(fallback)) {
      return resolveCursorElectronBinary(fallback);
    }
  }

  throw new Error(
    "Cursor Electron app not found. Set CURSOR_BIN to the app binary (e.g. /usr/share/cursor/cursor), not the CLI shim.",
  );
}

/** Prefer the Electron binary when `cursor` on PATH is the bin/ CLI wrapper. */
export function resolveCursorElectronBinary(candidate: string): string {
  const resolved = fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate);
  const siblingApp = path.resolve(path.dirname(resolved), "..", process.platform === "win32" ? "Cursor.exe" : "cursor");
  if (isCursorCliShim(resolved) && fs.existsSync(siblingApp) && !isCursorCliShim(siblingApp)) {
    return siblingApp;
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Cursor binary does not exist: ${candidate}`);
  }
  if (isCursorCliShim(resolved)) {
    throw new Error(
      `Refusing Cursor CLI shim at ${resolved}; need the Electron app binary (set CURSOR_BIN).`,
    );
  }
  return resolved;
}

function isCursorCliShim(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(64);
      const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
      const head = buf.subarray(0, bytes).toString("utf8");
      return head.startsWith("#!") && /cursor|env sh|bash/i.test(head);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
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
  host?: DevUiHost;
}): DevUiLaunchConfig {
  const extensionDevelopmentPath = options.projectRoot;
  const host = options.host ?? "vscode";
  const profileBase = path.join(options.projectRoot, ".vscode-test", host === "cursor" ? "cursor-profile" : "ui-profile");
  const launchArgs = [
    options.workspaceFile,
    `--extensionDevelopmentPath=${extensionDevelopmentPath}`,
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
    `--extensions-dir=${path.join(profileBase, "extensions")}`,
    `--user-data-dir=${path.join(profileBase, "user-data")}`,
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

export async function launchDevUi(options: { forceFixture?: boolean; host?: DevUiHost } = {}): Promise<number> {
  const projectRoot = getProjectRoot();
  const manifest = await createUiFixture({ force: options.forceFixture });
  const host = options.host ?? "vscode";
  const vscodeExecutablePath =
    host === "cursor"
      ? resolveCursorExecutable()
      : await downloadAndUnzipVSCode(readEngineVscodeVersion(path.join(projectRoot, "package.json")));
  const config = buildDevUiLaunchConfig({
    projectRoot,
    vscodeExecutablePath,
    workspaceFile: manifest.workspaceFile,
    host,
  });

  console.log(`Launching ${host} Extension Development Host`);
  console.log(`  executable: ${config.vscodeExecutablePath}`);
  console.log(`  workspace:  ${config.workspaceFile}`);

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
        console.log(`${host === "cursor" ? "Cursor" : "VS Code"} closed (${signal})`);
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
  const code = await launchDevUi({ forceFixture, host: parseDevUiHost(process.argv) });
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
