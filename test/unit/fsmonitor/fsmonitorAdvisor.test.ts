import { describe, expect, it } from "vitest";
import {
  assessFsmonitor,
  hasFsmonitorDaemon,
  isRemotePath,
  parseNetworkDrives,
  StatusTimings,
  type FsmonitorRepoFacts,
} from "../../../src/fsmonitor/fsmonitorAdvisor.js";

const supported = { daemonSupported: true };

function facts(overrides: Partial<FsmonitorRepoFacts>): FsmonitorRepoFacts {
  return {
    rootPath: String.raw`C:\repo`,
    statusMs: undefined,
    fsmonitor: undefined,
    remote: false,
    ...overrides,
  };
}

describe("assessFsmonitor", () => {
  it("recommends fsmonitor only for a slow git status", () => {
    expect(assessFsmonitor(facts({ statusMs: 1_500 }), supported).kind).toBe("recommended");
    expect(assessFsmonitor(facts({ statusMs: 300 }), supported).kind).toBe("fast");
    expect(assessFsmonitor(facts({ statusMs: undefined }), supported).kind).toBe("unmeasured");
  });

  it("leaves out repositories where the daemon cannot or already runs", () => {
    expect(assessFsmonitor(facts({ statusMs: 5_000, fsmonitor: "true" }), supported).kind).toBe("enabled");
    expect(assessFsmonitor(facts({ statusMs: 5_000, fsmonitor: "false" }), supported).kind).toBe("recommended");
    expect(assessFsmonitor(facts({ statusMs: 5_000, remote: true }), supported).kind).toBe("unsupported");
    expect(assessFsmonitor(facts({ statusMs: 5_000 }), { daemonSupported: false }).kind).toBe("unsupported");
  });

  it("judges the median of the last three runs, so one slow run is not enough", () => {
    const timings = new StatusTimings();
    expect(timings.record("repo", 4_000)).toBeUndefined();
    expect(timings.record("repo", 200)).toBeUndefined();
    expect(timings.record("repo", 300)).toBe(300);
    expect(timings.record("repo", 1_200)).toBe(300);
    expect(timings.record("repo", 1_500)).toBe(1_200);
  });
});

describe("fsmonitor environment parsing", () => {
  it("detects the daemon in git build options and network drives in net use", () => {
    expect(hasFsmonitorDaemon("git version 2.55.0\ncpu: x86_64\nfeature: fsmonitor--daemon\n")).toBe(true);
    expect(hasFsmonitorDaemon("git version 2.55.0\ncpu: x86_64\n")).toBe(false);
    const drives = parseNetworkDrives(
      "Status       Local     Remote                    Network\r\n" +
        "-------------------------------------------------------------------------------\r\n" +
        String.raw`OK           S:        \\server\share          Microsoft Windows Network` + "\r\n" +
        String.raw`Unavailable  t:        \\other\data            Microsoft Windows Network` + "\r\n",
    );
    expect([...drives].sort()).toEqual(["S:", "T:"]);
    expect(isRemotePath(String.raw`s:\work\repo`, drives)).toBe(true);
    expect(isRemotePath(String.raw`\\server\share\repo`, drives)).toBe(true);
    expect(isRemotePath(String.raw`R:\External\repo`, drives)).toBe(false);
  });
});
