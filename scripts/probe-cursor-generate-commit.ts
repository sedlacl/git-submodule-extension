import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createUiFixture } from "./create-ui-fixture.js";
import { resolveCursorExecutable } from "./dev-ui.js";
import { bundleExtensionHostTests } from "./run-extension-tests.js";
import { getProjectRoot } from "./lib/paths.js";
import type { ProbeReport } from "../test/extension-host/probeGenerateCommitMessage.js";

async function main(): Promise<void> {
  const projectRoot = getProjectRoot();
  const build = spawnSync(process.execPath, [path.join(projectRoot, "esbuild.mjs")], {
    cwd: projectRoot,
    stdio: "inherit",
    windowsHide: true,
  });
  if (build.status !== 0) {
    throw new Error(`esbuild failed with exit ${build.status ?? "unknown"}`);
  }

  const manifest = await createUiFixture();
  const extensionTestsPath = await bundleExtensionHostTests(projectRoot);
  const cursor = resolveCursorExecutable();
  const profileRoot = path.join(projectRoot, ".vscode-test", "cursor-generate-probe");
  fs.rmSync(profileRoot, { recursive: true, force: true });
  fs.mkdirSync(profileRoot, { recursive: true });
  const reportPath = path.join(profileRoot, "probe-report.json");

  const args = [
    manifest.workspaceFile,
    `--extensionDevelopmentPath=${projectRoot}`,
    `--extensionTestsPath=${extensionTestsPath}`,
    `--user-data-dir=${path.join(profileRoot, "user-data")}`,
    `--extensions-dir=${path.join(profileRoot, "extensions")}`,
    "--new-window",
    "--no-sandbox",
    "--disable-gpu-sandbox",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust",
  ];

  console.log(`Probing ${cursor} with workspace ${manifest.workspaceFile}`);
  const exitCode = await runCursor(cursor, args, {
    ...process.env,
    GIT_SUBMODULE_PROBE_GENERATE_COMMIT: reportPath,
    GIT_SUBMODULE_FIXTURE_ROOT: manifest.fixtureRoot,
    GIT_SUBMODULE_PROBE_ISOLATED_PROFILE: "1",
  });
  if (exitCode !== 0) {
    throw new Error(`Cursor probe exited with ${exitCode}`);
  }
  if (!fs.existsSync(reportPath)) {
    throw new Error(`Probe report missing at ${reportPath}`);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as ProbeReport;
  printReport(report);
  console.log(`Full report: ${reportPath}`);
}

function printReport(report: ProbeReport): void {
  console.log(`Command registered: ${report.commandAvailable}`);
  console.log(`Live verification inconclusive (auth): ${report.liveVerificationInconclusive}`);
  console.log(`Auth signals: ${report.authState.signals.join(", ") || "none"}`);
  console.log(`Target: ${path.basename(report.targetRoot)}`);
  console.log(`Sibling: ${path.basename(report.siblingRoot)}`);
  console.log(`Open repositories: ${report.openRepositories.length}`);
  console.log("");
  console.log("Static analysis (installed Cursor):");
  console.log(`  menu: ${report.staticAnalysis.menuContribution}`);
  console.log(`  arg:  ${report.staticAnalysis.expectedFirstArgument}`);
  console.log(`  resolve: ${report.staticAnalysis.handlerResolution}`);
  console.log("");
  console.log("| Attempt | Outcome | Error | Target | Sibling ok | Changed repos |");
  console.log("| --- | --- | --- | --- | --- | --- |");
  for (const attempt of report.attempts) {
    console.log(
      `| ${attempt.label} | ${attempt.outcome} | ${attempt.error ?? "—"} | ${attempt.targetChanged} | ${attempt.siblingUnchanged} | ${attempt.changedRoots.join(", ") || "—"} |`,
    );
  }
  if (report.liveVerificationInconclusive) {
    console.log("");
    console.log(
      "Note: isolated profile is not signed in to Cursor. Draft outcomes are inconclusive for targeting verification.",
    );
    console.log("Implementation uses bundled-handler rootUri targeting; confirm manually in a signed-in Cursor.");
  }
}

function runCursor(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      shell: false,
      windowsHide: true,
      env,
    });
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Cursor probe timed out after 180s"));
    }, 180_000);
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

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
