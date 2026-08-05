/**
 * Tab-strip geometry, for dragging a tab along its strip.
 *
 * A drag is dispatched to whatever renderable opentui captured at the first
 * drag event and bubbles up to the root, so the handler that sees the pointer
 * is nowhere near the strip it is over — it has to be told where the tabs were
 * drawn. Rather than re-deriving that from the label strings (whose cell width
 * is a guess the moment a title holds a wide glyph), each tab registers its own
 * box here and the numbers come off the renderable that yoga just laid out.
 */

import { dragTabTo, endTabDrag, store, tabDragIndex } from "../core/state";

/** A live tab box: absolute screen column and measured width. */
export interface TabBox {
  screenX: number;
  width: number;
}

/** Where a tab sits in its strip right now. */
export interface TabBounds {
  idx: number;
  x: number;
  width: number;
}

const boxes = new Map<string, TabBox>();

/** A tab has been laid out — called from its ref. */
export function registerTabBox(surfaceId: string, box: TabBox): void {
  boxes.set(surfaceId, box);
}

/**
 * ...and let go of it. The box matters: a tab that moves to another pane
 * remounts, and the new row can register before the old one is cleaned up —
 * dropping whatever happens to be registered would leave that strip unhittable
 * until something else re-rendered it.
 */
export function releaseTabBox(surfaceId: string, box: TabBox): void {
  if (boxes.get(surfaceId) === box) boxes.delete(surfaceId);
}

/**
 * Measured bounds for one strip, in tab order. Empty when any of the tabs has
 * no box yet: a strip that is half laid out (a tab opened this frame) would
 * hit-test to the wrong slot, and a drag can simply wait a frame.
 */
export function tabBounds(surfaceIds: string[]): TabBounds[] {
  const out: TabBounds[] = [];
  for (const [idx, sid] of surfaceIds.entries()) {
    const box = boxes.get(sid);
    if (!box || box.width <= 0) return [];
    out.push({ idx, x: box.screenX, width: box.width });
  }
  return out;
}

/**
 * The slot a tab being dragged from `from` belongs in with the pointer at `x`:
 * as many slots along as there are *other* tabs whose middle the pointer has
 * passed. Ignoring the dragged tab's own slot is what keeps this steady — the
 * pointer has to cross the whole of a neighbour to displace it, and cannot sit
 * on a boundary swapping the two back and forth. Off either end of the strip it
 * clamps, so a sloppy drag parks the tab first or last instead of wrapping.
 */
export function dropIndex(bounds: TabBounds[], from: number, x: number): number {
  let idx = 0;
  for (const b of bounds) {
    if (b.idx === from) continue;
    if (x >= b.x + b.width / 2) idx++;
  }
  return Math.max(0, Math.min(bounds.length - 1, idx));
}

/**
 * Pointer at column `x` while a tab is held: put the tab where the pointer
 * says. Only the column matters — a drag that wanders off the strip vertically
 * is still a drag along it, which is how sloppy one-row drags stay usable.
 */
export function dragTabAt(x: number): void {
  const drag = store.tabDrag;
  if (!drag) return;
  const from = tabDragIndex();
  if (from === -1) {
    endTabDrag();
    return;
  }
  const bounds = tabBounds(store.panes[drag.paneId]?.surfaceIds ?? []);
  if (bounds.length === 0) return;
  dragTabTo(dropIndex(bounds, from, x));
}
