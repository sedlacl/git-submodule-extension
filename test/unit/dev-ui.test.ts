import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDevUiLaunchConfig,
  parseDevUiHost,
  readEngineVscodeVersion,
  resolveCursorElectronBinary,
  resolveCursorExecutable,
} from "../../scripts/dev-ui.js";
import { getProjectRoot } from "../../scripts/lib/paths.js";

describe("dev-ui launch config", () => {
  it("reads the engine vscode version from package.json", () => {
    const version = readEngineVscodeVersion(path.join(getProjectRoot(), "package.json"));
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("builds isolated launch args without disabling development extensions", () => {
    const projectRoot = getProjectRoot();
    const workspaceFile = path.join(projectRoot, "fixtures", "ui", "ui-dev.code-workspace");
    const config = buildDevUiLaunchConfig({
      projectRoot,
      vscodeExecutablePath: "/tmp/vscode/Code.exe",
      workspaceFile,
    });

    expect(config.launchArgs[0]).toBe(workspaceFile);
    expect(config.launchArgs).not.toContain("--disable-extensions");
    expect(config.launchArgs.some((arg) => arg.startsWith("--extensionDevelopmentPath="))).toBe(true);
    expect(config.launchArgs.some((arg) => arg.startsWith("--user-data-dir="))).toBe(true);
    expect(config.launchArgs.some((arg) => arg.startsWith("--extensions-dir="))).toBe(true);
    expect(config.launchArgs).toContain("--disable-workspace-trust");
    expect(config.launchArgs).not.toContain("--install-extension");
  });

  it("uses a separate Cursor profile directory under .vscode-test", () => {
    const projectRoot = getProjectRoot();
    const workspaceFile = path.join(projectRoot, "fixtures", "ui", "ui-dev.code-workspace");
    const config = buildDevUiLaunchConfig({
      projectRoot,
      vscodeExecutablePath: "/usr/share/cursor/cursor",
      workspaceFile,
      host: "cursor",
    });

    expect(config.launchArgs[0]).toBe(workspaceFile);
    expect(config.launchArgs.some((arg) => arg.includes(`${path.sep}cursor-profile${path.sep}`))).toBe(true);
  });

  it("parses --host=cursor without disabling development extensions", () => {
    expect(parseDevUiHost(["tsx", "scripts/dev-ui.ts"])).toBe("vscode");
    expect(parseDevUiHost(["tsx", "scripts/dev-ui.ts", "--host=cursor"])).toBe("cursor");
    expect(parseDevUiHost(["tsx", "scripts/dev-ui.ts", "--cursor"])).toBe("cursor");
  });

  it("resolves Cursor from CURSOR_BIN and rewrites the CLI shim to the Electron app", () => {
    expect(resolveCursorExecutable({ CURSOR_BIN: "/opt/cursor/cursor" })).toBe("/opt/cursor/cursor");
    if (process.platform === "linux" && fs.existsSync("/usr/bin/cursor")) {
      const electron = resolveCursorElectronBinary("/usr/bin/cursor");
      expect(electron).toBe("/usr/share/cursor/cursor");
      expect(resolveCursorExecutable({})).toBe(electron);
    }
  });

  it("does not require user extensions.json recommendations", () => {
    const extensionsJson = path.join(getProjectRoot(), ".vscode", "extensions.json");
    const parsed = JSON.parse(fs.readFileSync(extensionsJson, "utf8")) as { recommendations?: string[] };
    expect(parsed.recommendations).toEqual(["vscode.git"]);
  });
});
