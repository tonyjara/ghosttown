import { describe, expect, it } from "bun:test";
import {
  dropIndex,
  registerTabBox,
  releaseTabBox,
  tabBounds,
  type TabBounds,
  type TabBox,
} from "./tabs";

/** Tabs of the given widths, laid out end to end from column `x`. */
function strip(widths: number[], x = 0): TabBounds[] {
  let at = x;
  return widths.map((width, idx) => {
    const bounds = { idx, x: at, width };
    at += width;
    return bounds;
  });
}

// The registry is module-global, so each test names its own tabs rather than
// unregistering the previous one's.
describe("tabBounds", () => {
  const box = (screenX: number, width: number): TabBox => ({ screenX, width });

  it("reports the boxes in tab order, not registration order", () => {
    registerTabBox("order-b", box(10, 6));
    registerTabBox("order-a", box(0, 10));

    expect(tabBounds(["order-a", "order-b"])).toEqual([
      { idx: 0, x: 0, width: 10 },
      { idx: 1, x: 10, width: 6 },
    ]);
  });

  it("gives up on a half-laid-out strip rather than guessing a slot", () => {
    registerTabBox("half-a", box(0, 10));
    // The second tab mounted this frame: no box at all...
    expect(tabBounds(["half-a", "half-b"])).toEqual([]);
    // ...or one yoga has not measured yet.
    registerTabBox("half-b", box(0, 0));
    expect(tabBounds(["half-a", "half-b"])).toEqual([]);
  });

  it("forgets a tab that unmounts", () => {
    const b = box(0, 10);
    registerTabBox("gone", b);
    releaseTabBox("gone", b);
    expect(tabBounds(["gone"])).toEqual([]);
  });

  it("keeps the live box when a remount releases the old one after it", () => {
    // A tab moved to another pane: the new row registers, then the old row's
    // cleanup runs. Releasing a box that is no longer the registered one must
    // not blank the strip out from under the drag.
    const old = box(0, 10);
    registerTabBox("remount", old);
    registerTabBox("remount", box(40, 10));
    releaseTabBox("remount", old);
    expect(tabBounds(["remount"])).toEqual([{ idx: 0, x: 40, width: 10 }]);
  });
});

describe("dropIndex", () => {
  const tabs = strip([10, 10, 10]); // 0-9, 10-19, 20-29

  it("keeps the tab put while the pointer is still on it", () => {
    expect(dropIndex(tabs, 0, 0)).toBe(0);
    expect(dropIndex(tabs, 0, 9)).toBe(0);
    expect(dropIndex(tabs, 1, 15)).toBe(1);
  });

  it("moves once the pointer passes a neighbour's middle", () => {
    expect(dropIndex(tabs, 0, 14)).toBe(0);
    expect(dropIndex(tabs, 0, 15)).toBe(1);
    // Dragging leftwards: past the middle of tab 1 it sits between 0 and 1,
    // and only past the middle of tab 0 does it take the front.
    expect(dropIndex(tabs, 2, 14)).toBe(1);
    expect(dropIndex(tabs, 2, 5)).toBe(1);
    expect(dropIndex(tabs, 2, 4)).toBe(0);
  });

  it("skips several slots when the pointer is flung across the strip", () => {
    expect(dropIndex(tabs, 0, 27)).toBe(2);
    expect(dropIndex(tabs, 2, 2)).toBe(0);
  });

  it("clamps off either end instead of wrapping", () => {
    expect(dropIndex(tabs, 1, -40)).toBe(0);
    expect(dropIndex(tabs, 1, 400)).toBe(2);
  });

  it("holds steady after a swap, so the strip cannot oscillate", () => {
    // A wide tab dragged over a narrow one: the pointer that triggered the swap
    // must still say "stay" once the two have traded places.
    const before = strip([12, 4]);
    expect(dropIndex(before, 0, 14)).toBe(1);
    const after = strip([4, 12]); // narrow tab first now, dragged one at 4-15
    expect(dropIndex(after, 1, 14)).toBe(1);
    // Coming back means dragging all the way to the narrow tab's middle — a
    // wide dead zone between the two triggers, which is what stops the jitter.
    expect(dropIndex(after, 1, 3)).toBe(1);
    expect(dropIndex(after, 1, 1)).toBe(0);
  });

  it("offsets with the strip: a pane further right hit-tests in screen columns", () => {
    const right = strip([10, 10], 40); // 40-49, 50-59
    expect(dropIndex(right, 0, 44)).toBe(0);
    expect(dropIndex(right, 0, 55)).toBe(1);
    // Columns left of this pane belong to another strip; clamped, not negative.
    expect(dropIndex(right, 1, 5)).toBe(0);
  });

  it("has nowhere to go in a one-tab strip", () => {
    expect(dropIndex(strip([10]), 0, 500)).toBe(0);
  });
});
