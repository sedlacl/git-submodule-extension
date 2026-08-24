import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { createUiFixture } from "./create-ui-fixture.js";
import { resolveCursorExecutable } from "./dev-ui.js";
import { bundleExtensionHostTests } from "./run-extension-tests.js";
import { getProjectRoot } from "./lib/paths.js";

interface ProfileRun {
  run: number;
  timingFile: string;
  remoteDebuggingPort: number;
  warmRefreshesRequested: number;
  cdpConnected: boolean;
  cdpTargets: Array<{ type: string; title: string }>;
  exitCode: number;
}

async function main(): Promise<void> {
  const projectRoot = getProjectRoot();
  const runs = positiveIntegerArg("--runs=", 3);
  const refreshes = positiveIntegerArg("--refreshes=", 3);
  const manifest = await createUiFixture();
  const build = spawnSync(process.execPath, [path.join(projectRoot, "esbuild.mjs")], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (build.status !== 0) {
    throw new Error(`esbuild failed with exit ${build.status ?? "unknown"}`);
  }
  const extensionTestsPath = await bundleExtensionHostTests(projectRoot);
  const cursor = resolveCursorExecutable();
  const outputRoot = path.join(projectRoot, ".vscode-test", "cursor-ui-profile");
  fs.mkdirSync(outputRoot, { recursive: true });

  const results: ProfileRun[] = [];
  for (let run = 1; run <= runs; run += 1) {
    const runRefreshes =
      Math.floor(refreshes / runs) + (run <= refreshes % runs ? 1 : 0);
    const profileRoot = path.join(outputRoot, `run-${run}`);
    fs.rmSync(profileRoot, { recursive: true, force: true });
    fs.mkdirSync(profileRoot, { recursive: true });
    const timingFile = path.join(profileRoot, "timings.log");
    fs.writeFileSync(timingFile, "", "utf8");
    const remoteDebuggingPort = await freePort();
    const args = [
      manifest.workspaceFile,
      `--extensionDevelopmentPath=${projectRoot}`,
      `--extensionTestsPath=${extensionTestsPath}`,
      `--user-data-dir=${path.join(profileRoot, "user-data")}`,
      `--extensions-dir=${path.join(profileRoot, "extensions")}`,
      `--remote-debugging-port=${remoteDebuggingPort}`,
      "--new-window",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
    ];
    console.log(`Cursor profile run ${run}/${runs} on CDP port ${remoteDebuggingPort}`);
    const child = spawn(cursor, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        GIT_SUBMODULE_TIMING_FILE: timingFile,
        GIT_SUBMODULE_PROFILE_REFRESHES: String(runRefreshes),
      },
      stdio: "inherit",
      shell: false,
      windowsHide: true,
    });
    const cdpTargetsPromise = probeCdp(remoteDebuggingPort, 30_000);
    const exitCode = await waitForExit(child, 120_000);
    const cdpTargets = await cdpTargetsPromise;
    validateTimingEvidence(timingFile, runRefreshes);
    results.push({
      run,
      timingFile,
      remoteDebuggingPort,
      warmRefreshesRequested: runRefreshes,
      cdpConnected: cdpTargets.length > 0,
      cdpTargets: cdpTargets.map((target) => ({ type: target.type, title: target.title })),
      exitCode,
    });
    if (exitCode !== 0) {
      throw new Error(`Cursor profile run ${run} exited with ${exitCode}`);
    }
  }

  const reportPath = path.join(outputRoot, "runs.json");
  fs.writeFileSync(reportPath, `${JSON.stringify({ refreshes, results }, null, 2)}\n`, "utf8");
  console.log(`Cursor UI profile evidence: ${reportPath}`);
}

function validateTimingEvidence(timingFile: string, refreshes: number): void {
  const content = fs.readFileSync(timingFile, "utf8");
  const finals = [...content.matchAll(/\[changes #\d+\] final .*\)/g)].length;
  const explicitFinals = [...content.matchAll(/\[changes #\d+\] final .*reason: [^;]*explicit refresh/g)].length;
  const adoptedBatches = [...content.matchAll(/adopted counts .*\)/g)].length;
  if (finals < refreshes + 1 || explicitFinals < refreshes || adoptedBatches < refreshes + 1) {
    throw new Error(
      `Incomplete timing evidence: final=${finals}, explicit=${explicitFinals}, adopted=${adoptedBatches}`,
    );
  }
}

async function probeCdp(
  port: number,
  timeoutMs: number,
): Promise<Array<{ type: string; title: string }>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = (await response.json()) as Array<{ type?: string; title?: string }>;
        if (targets.length > 0) {
          return targets.map((target) => ({
            type: target.type ?? "unknown",
            title: target.title ?? "",
          }));
        }
      }
    } catch {
      // Cursor has not opened the Chromium endpoint yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return [];
}

function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Cursor profile process timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function positiveIntegerArg(prefix: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
