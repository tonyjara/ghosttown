/**
 * Tab order: the move primitive, arrange mode's H/L, and the mouse-drag
 * session on top of both. The store is module-global, so each test builds the
 * pane it needs rather than assuming an empty session.
 */
import { describe, expect, it } from "bun:test";
import {
  closeSurface,
  createWorkspace,
  dragFocusedTab,
  dragTabTo,
  endTabDrag,
  focusedPaneId,
  moveTab,
  newTab,
  selectTab,
  splitPane,
  startTabDrag,
  store,
  tabDragIndex,
} from "./state";

/** A workspace whose single pane holds `count` tabs, the first one active. */
function pane(name: string, count: number): { paneId: string; tabs: string[] } {
  createWorkspace({ name });
  const paneId = focusedPaneId();
  for (let i = 1; i < count; i++) newTab(paneId);
  selectTab(paneId, 0);
  return { paneId, tabs: [...store.panes[paneId]!.surfaceIds] };
}

const order = (paneId: string) => [...store.panes[paneId]!.surfaceIds];
const active = (paneId: string) => {
  const p = store.panes[paneId]!;
  return p.surfaceIds[p.activeIdx];
};

describe("moveTab", () => {
  it("moves a tab along its own strip", () => {
    const { paneId, tabs } = pane("move-along", 3);
    const [a, b, c] = tabs as [string, string, string];

    expect(moveTab(paneId, 0, paneId, 2)).toBe(true);
    expect(order(paneId)).toEqual([b, c, a]);
    expect(moveTab(paneId, 2, paneId, 1)).toBe(true);
    expect(order(paneId)).toEqual([b, a, c]);
  });

  it("keeps the same tab active, whichever one moved", () => {
    const { paneId, tabs } = pane("keep-active", 3);
    const [a, b, c] = tabs as [string, string, string];

    // Drag the active tab: the selection travels with it.
    selectTab(paneId, 0);
    moveTab(paneId, 0, paneId, 2);
    expect(active(paneId)).toBe(a);

    // Drag a different one past it: the selection stays on the same surface,
    // which is now in a different slot. Shuffling tabs must never switch the
    // one you are typing in.
    selectTab(paneId, order(paneId).indexOf(b));
    moveTab(paneId, order(paneId).indexOf(c), paneId, 0);
    expect(order(paneId)).toEqual([c, b, a]);
    expect(active(paneId)).toBe(b);
  });

  it("clamps at the ends instead of wrapping", () => {
    const { paneId, tabs } = pane("clamp", 3);
    const [a, b, c] = tabs as [string, string, string];

    expect(moveTab(paneId, 0, paneId, -3)).toBe(false);
    expect(order(paneId)).toEqual([a, b, c]);
    // Off the right end parks it last; it does not come back round the front.
    expect(moveTab(paneId, 0, paneId, 99)).toBe(true);
    expect(order(paneId)).toEqual([b, c, a]);
    expect(moveTab(paneId, 2, paneId, 99)).toBe(false);
  });

  it("says no to a slot that does not move it, and to tabs that are not there", () => {
    const { paneId } = pane("no-op", 2);
    expect(moveTab(paneId, 1, paneId, 1)).toBe(false);
    expect(moveTab(paneId, 7, paneId, 0)).toBe(false);
    expect(moveTab("nope", 0, paneId, 0)).toBe(false);
    expect(moveTab(paneId, 0, "nope", 0)).toBe(false);
  });

  it("hands a tab to another pane, focus following it", () => {
    const { paneId: left, tabs } = pane("cross-pane", 2);
    const [a, b] = tabs as [string, string];
    const right = splitPane(left, "row");
    expect(right).not.toBeNull();
    const rightTab = store.panes[right!]!.surfaceIds[0]!;

    expect(moveTab(left, 0, right!, 0)).toBe(true);
    expect(order(left)).toEqual([b]);
    expect(order(right!)).toEqual([a, rightTab]);
    // You moved it there to look at it.
    expect(focusedPaneId()).toBe(right!);
    expect(active(right!)).toBe(a);
  });

  it("closes a pane whose last tab is dragged out of it", () => {
    const { paneId: left, tabs } = pane("empty-out", 1);
    const only = tabs[0]!;
    const right = splitPane(left, "row")!;

    moveTab(left, 0, right, 0);
    expect(store.panes[left]).toBeUndefined();
    expect(order(right)).toContain(only);
    expect(store.surfaces[only]).toBeDefined();
  });
});

describe("arrange mode H/L", () => {
  it("walks the focused tab along the strip and stops at the ends", () => {
    const { paneId, tabs } = pane("hl", 3);
    const [a, b, c] = tabs as [string, string, string];
    selectTab(paneId, 1);

    dragFocusedTab(1);
    expect(order(paneId)).toEqual([a, c, b]);
    // The focus is on the tab being moved, so the next press keeps moving it.
    dragFocusedTab(1);
    expect(order(paneId)).toEqual([a, c, b]);
    expect(active(paneId)).toBe(b);

    dragFocusedTab(-1);
    dragFocusedTab(-1);
    expect(order(paneId)).toEqual([b, a, c]);
    dragFocusedTab(-1);
    expect(order(paneId)).toEqual([b, a, c]);
  });
});

describe("tab drag session", () => {
  it("tracks the tab by name, so its slot can change under it", () => {
    const { paneId, tabs } = pane("drag-track", 3);
    const [a, b, c] = tabs as [string, string, string];

    startTabDrag(paneId, 0);
    expect(tabDragIndex()).toBe(0);
    dragTabTo(2);
    expect(order(paneId)).toEqual([b, c, a]);
    // Still the same tab, now in the slot it was dragged to.
    expect(store.tabDrag?.surfaceId).toBe(a);
    expect(tabDragIndex()).toBe(2);

    dragTabTo(1);
    expect(order(paneId)).toEqual([b, a, c]);
    endTabDrag();
    expect(store.tabDrag).toBeNull();
    expect(tabDragIndex()).toBe(-1);
  });

  it("ends itself when the tab it carries is closed mid-drag", () => {
    const { paneId, tabs } = pane("drag-closed", 3);
    const [a, b, c] = tabs as [string, string, string];

    startTabDrag(paneId, 0);
    // `gt`, another client, or the program exiting — the drag has no tab left.
    closeSurface(a);
    dragTabTo(1);
    expect(store.tabDrag).toBeNull();
    expect(order(paneId)).toEqual([b, c]);
  });

  it("does nothing at all without a drag running", () => {
    const { paneId, tabs } = pane("drag-none", 2);
    endTabDrag();
    dragTabTo(1);
    expect(order(paneId)).toEqual(tabs);
  });
});
