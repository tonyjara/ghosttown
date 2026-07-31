/**
 * Where a new surface starts: every creation path (split, tab, workspace) asks
 * the host to inherit the directory of the tab it was created from, instead of
 * dropping the user back in whatever directory the TUI was launched from.
 */
import { beforeEach, describe, expect, it } from "bun:test";
import type { HostClientFrame } from "../control/protocol";
import { setHostSender } from "./runtime";
import {
  activeSurfaceId,
  createWorkspace,
  focusedPaneId,
  newTab,
  selectTab,
  splitPane,
  store,
} from "./state";

type SpawnFrame = Extract<HostClientFrame, { t: "spawn" }>;

let spawns: SpawnFrame[] = [];

beforeEach(() => {
  spawns = [];
  setHostSender((frame) => {
    if (frame.t === "spawn") spawns.push(frame);
  });
});

/** What the host was told to inherit from, for a surface we just created. */
const inheritedBy = (surfaceId: string) => spawns.find((f) => f.id === surfaceId)?.cwdFrom;

describe("new surfaces inherit a directory", () => {
  it("gives a split pane the directory of the pane it came out of", () => {
    createWorkspace({ name: "split source" });
    const source = activeSurfaceId();
    const paneId = splitPane(focusedPaneId(), "row")!;
    const created = store.panes[paneId]!.surfaceIds[0]!;
    expect(inheritedBy(created)).toBe(source);
  });

  it("gives a new tab the directory of the tab that was on screen", () => {
    // Not the last tab in the strip: a tab opens where you were working, and
    // that is whichever one you were looking at when you asked for it.
    createWorkspace({ name: "tab source" });
    const first = activeSurfaceId();
    const paneId = focusedPaneId();
    newTab(paneId);
    selectTab(paneId, 0);
    const third = newTab(paneId)!;
    expect(inheritedBy(third)).toBe(first);
  });

  it("gives a new workspace the directory of the one being left behind", () => {
    createWorkspace({ name: "workspace source" });
    const leaving = activeSurfaceId();
    createWorkspace({ name: "workspace target" });
    expect(inheritedBy(activeSurfaceId())).toBe(leaving);
  });
});
