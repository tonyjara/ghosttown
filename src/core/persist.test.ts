import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  archiveSnapshot,
  ARCHIVE_KEEP,
  dropSnapshot,
  listArchived,
  listSaved,
  readCwds,
  readCwdsAsync,
  readSnapshot,
  restoreArchived,
  retireSnapshot,
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
          { id: "p1", activeIdx: 0, surfaces: [{ id: "s1", cwd: "/tmp" }] },
          { id: "p2", activeIdx: 1, surfaces: [{ id: "s2", cwd: "/tmp" }, { id: "s3", cwd: null }] },
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

  it("keeps a snapshot it cannot read instead of letting it be overwritten", () => {
    // The loss that used to be silent: a version bump makes the file unreadable,
    // then the fresh session that starts in its place writes over it.
    writeSnapshot({ ...sample(), version: SNAPSHOT_VERSION - 1 });
    expect(readSnapshot("main")).toBeNull();
    expect(existsSync(snapshotPath("main"))).toBe(false); // moved, not deleted
    const archived = listArchived("main");
    expect(archived.length).toBe(1);
    expect(archived[0]!.version).toBe(SNAPSHOT_VERSION - 1);
  });
});

describe("retiring a snapshot", () => {
  it("archives rather than deletes, and can put it back", () => {
    writeSnapshot(sample());
    const to = retireSnapshot("main");
    expect(to).not.toBeNull();
    expect(existsSync(snapshotPath("main"))).toBe(false);
    expect(existsSync(to!)).toBe(true);
    expect(retireSnapshot("main")).toBeNull(); // nothing left to retire

    const back = restoreArchived(to!);
    expect(back?.session).toBe("main");
    expect(readSnapshot("main")).toEqual(sample());
  });

  it("restoring archives whatever was live, so it is undoable too", () => {
    writeSnapshot(sample());
    const first = retireSnapshot("main")!;
    // A different layout in place now: one workspace, one pane, one tab.
    const smaller = {
      ...sample(),
      savedAt: 1_700_000_500_000,
      workspaces: [
        {
          id: "w9",
          name: "workspace 9",
          layout: { type: "leaf", paneId: "p9" } as const,
          focusedPaneId: "p9",
          panes: [{ id: "p9", activeIdx: 0, surfaces: [{ id: "s9", cwd: "/tmp" }] }],
        },
      ],
    };
    writeSnapshot(smaller);
    restoreArchived(first);
    expect(readSnapshot("main")?.workspaces[0]!.id).toBe("w1");
    // The one we replaced is in the archive, not gone.
    expect(listArchived("main").some((a) => a.savedAt === smaller.savedAt)).toBe(true);
  });

  it("drops without archiving, for a rename", () => {
    writeSnapshot(sample());
    dropSnapshot("main");
    expect(existsSync(snapshotPath("main"))).toBe(false);
    expect(listArchived("main")).toEqual([]);
    dropSnapshot("main"); // idempotent
  });

  it("keeps ARCHIVE_KEEP per profile, newest first, without evicting others", () => {
    for (let i = 0; i < ARCHIVE_KEEP + 5; i++) {
      writeSnapshot({ ...sample(), savedAt: 1_700_000_000_000 + i });
      archiveSnapshot("main");
    }
    writeSnapshot(sample("other"));
    archiveSnapshot("other");

    const mine = listArchived("main");
    expect(mine.length).toBe(ARCHIVE_KEEP);
    expect(mine[0]!.savedAt).toBeGreaterThan(mine[1]!.savedAt); // newest first
    expect(mine.at(-1)!.savedAt).toBe(1_700_000_000_000 + 5); // oldest fell off
    expect(listArchived("other").length).toBe(1);
    expect(listArchived().length).toBe(ARCHIVE_KEEP + 1);
  });
});

describe("archive-on-shrink", () => {
  it("keeps the old copy when a smaller layout lands on a bigger one", () => {
    writeSnapshot(sample()); // 1 workspace, 2 panes, 3 tabs
    // What a session that started fresh over an unreadable snapshot writes.
    writeSnapshot({
      ...sample(),
      savedAt: 1_700_000_900_000,
      workspaces: [
        {
          id: "w1",
          name: "workspace 1",
          layout: { type: "leaf", paneId: "p1" },
          focusedPaneId: "p1",
          panes: [{ id: "p1", activeIdx: 0, surfaces: [{ id: "s1", cwd: null }] }],
        },
      ],
    });
    const archived = listArchived("main");
    expect(archived.length).toBe(1);
    expect(archived[0]!.surfaces).toBe(3);
    // The live file is still the new one — this is a backup, not a veto.
    expect(readSnapshot("main")?.workspaces[0]!.panes.length).toBe(1);
  });

  it("does not archive a growing layout, or one closed tab", () => {
    writeSnapshot(sample());
    const grown = structuredClone(sample());
    grown.workspaces[0]!.panes[0]!.surfaces.push({ id: "s4", cwd: "/tmp" });
    writeSnapshot(grown);
    expect(listArchived("main")).toEqual([]);
    // Back down by exactly one tab: cheap to redo, not worth a file.
    writeSnapshot(sample());
    expect(listArchived("main")).toEqual([]);
  });
});

describe("listSaved", () => {
  it("finds every restorable profile, newest first", () => {
    writeSnapshot({ ...sample("alpha"), savedAt: 1_700_000_000_000 });
    writeSnapshot({ ...sample("beta"), savedAt: 1_700_000_100_000 });
    // Not restorable: no workspaces, or a version this build cannot read.
    writeSnapshot({ ...sample("gone"), workspaces: [] });
    writeSnapshot({ ...sample("ancient"), version: SNAPSHOT_VERSION - 1 });
    expect(listSaved().map((s) => s.session)).toEqual(["beta", "alpha"]);
    expect(listSaved()[0]!.surfaces).toBe(3);
  });
});

describe("paths", () => {
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
