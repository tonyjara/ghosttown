import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  deleteSnapshot,
  readCwds,
  readCwdsAsync,
  readSnapshot,
  snapshotPath,
  stateDir,
  writeSnapshot,
  SNAPSHOT_VERSION,
  type PersistedSession,
} from "./persist";

beforeEach(() => {
  process.env.GHOSTTOWN_STATE_DIR = mkdtempSync(join(tmpdir(), "gt-state-"));
});

afterEach(() => {
  delete process.env.GHOSTTOWN_STATE_DIR;
});

function sample(session = "main"): PersistedSession {
  return {
    version: SNAPSHOT_VERSION,
    session,
    savedAt: 1_700_000_000_000,
    activeWorkspaceId: "w1",
    sidebarVisible: true,
    workspaces: [
      {
        id: "w1",
        name: "workspace 1",
        layout: {
          type: "split",
          dir: "row",
          ratio: 0.4,
          a: { type: "leaf", paneId: "p1" },
          b: { type: "leaf", paneId: "p2" },
        },
        focusedPaneId: "p2",
        panes: [
          { id: "p1", activeIdx: 0, surfaces: [{ cwd: "/tmp" }] },
          { id: "p2", activeIdx: 1, surfaces: [{ cwd: "/tmp" }, { cwd: null }] },
        ],
      },
    ],
  };
}

describe("snapshots", () => {
  it("round-trips the layout, tab order and cwds", () => {
    const snap = sample();
    writeSnapshot(snap);
    expect(readSnapshot("main")).toEqual(snap);
  });

  it("ignores a snapshot written by another version", () => {
    writeSnapshot({ ...sample(), version: SNAPSHOT_VERSION + 1 });
    expect(readSnapshot("main")).toBeNull();
  });

  it("ignores unreadable, empty and missing snapshots", () => {
    expect(readSnapshot("never-existed")).toBeNull();
    writeFileSync(snapshotPath("broken"), "{not json");
    expect(readSnapshot("broken")).toBeNull();
    writeSnapshot({ ...sample("empty"), workspaces: [] });
    expect(readSnapshot("empty")).toBeNull();
  });

  it("deletes on quit", () => {
    writeSnapshot(sample());
    expect(existsSync(snapshotPath("main"))).toBe(true);
    deleteSnapshot("main");
    expect(existsSync(snapshotPath("main"))).toBe(false);
    deleteSnapshot("main"); // idempotent
  });

  it("keeps a session name from escaping the state dir", () => {
    // Separators are the danger, not dots: the file must stay in the dir.
    expect(dirname(snapshotPath("../../etc/passwd"))).toBe(stateDir());
    expect(dirname(snapshotPath("a/b"))).toBe(stateDir());
  });
});

describe("readCwds", () => {
  it("reads the working directory of a live process", () => {
    const cwds = readCwds([process.pid]);
    // macOS lsof reports the resolved path (/private/... for /tmp symlinks).
    expect(cwds.get(process.pid)).toContain("ghosttown");
  });

  it("agrees with the async variant used off the render thread", async () => {
    expect(await readCwdsAsync([process.pid])).toEqual(readCwds([process.pid]));
  });

  it("is empty for no pids and survives dead ones", async () => {
    expect(readCwds([]).size).toBe(0);
    expect(readCwds([-1, 0]).size).toBe(0);
    expect((await readCwdsAsync([])).size).toBe(0);
  });
});
