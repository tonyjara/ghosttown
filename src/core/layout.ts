import type { LayoutNode, LayoutSplit, Rect, SplitDir } from "./types";

/** Minimum pane size: tab strip + at least a few usable cells. */
const MIN_W = 8;
const MIN_H = 3;

export function leaf(paneId: string): LayoutNode {
  return { type: "leaf", paneId };
}

export function minSize(dir: SplitDir): number {
  return dir === "row" ? MIN_W : MIN_H;
}

/** Gap shrinks to keep both sides at least MIN-sized on small rects. */
function effectiveGap(node: LayoutSplit, rect: Rect, gap: number): number {
  const size = node.dir === "row" ? rect.width : rect.height;
  return Math.max(0, Math.min(gap, size - 2 * minSize(node.dir)));
}

/**
 * Split geometry, shared by rect computation, gutter collection, and resize
 * targeting so they can never disagree: `a` gets floor(usable * ratio)
 * (integer math, at least MIN), then the gap, then `b` gets the rest.
 */
function splitSizes(node: LayoutSplit, rect: Rect, gap: number): { a: number; g: number; b: number } {
  const size = node.dir === "row" ? rect.width : rect.height;
  const g = effectiveGap(node, rect, gap);
  const a = Math.max(minSize(node.dir), Math.floor((size - g) * node.ratio));
  return { a, g, b: size - g - a };
}

/** Compute pane rects by walking the split tree. Gap cells stay unassigned. */
export function computeRects(
  node: LayoutNode,
  rect: Rect,
  out: Map<string, Rect>,
  gap = 0,
): void {
  if (node.type === "leaf") {
    out.set(node.paneId, rect);
    return;
  }
  const { a, g, b } = splitSizes(node, rect, gap);
  if (node.dir === "row") {
    computeRects(node.a, { ...rect, width: a }, out, gap);
    computeRects(node.b, { x: rect.x + a + g, y: rect.y, width: b, height: rect.height }, out, gap);
  } else {
    computeRects(node.a, { ...rect, height: a }, out, gap);
    computeRects(node.b, { x: rect.x, y: rect.y + a + g, width: rect.width, height: b }, out, gap);
  }
}

/**
 * A draggable divider between the two children of a split. `path` addresses
 * the split from the root ("a"/"b" per level); `start` and `total` turn a
 * pointer coordinate back into a ratio: aw = pointer - start, ratio = aw/total.
 */
export interface Gutter {
  path: string;
  dir: SplitDir;
  /** The strip of cells between the two children (may be 0-wide if gap=0). */
  rect: Rect;
  /** Origin of the split on its axis (x for row, y for column). */
  start: number;
  /** Usable size on the axis: split size minus the gap. */
  total: number;
}

/** Collect every split's gutter strip, mirroring computeRects geometry. */
export function collectGutters(
  node: LayoutNode,
  rect: Rect,
  gap: number,
  out: Gutter[] = [],
  path = "",
): Gutter[] {
  if (node.type === "leaf") return out;
  const { a, g, b } = splitSizes(node, rect, gap);
  if (node.dir === "row") {
    out.push({
      path,
      dir: "row",
      rect: { x: rect.x + a, y: rect.y, width: g, height: rect.height },
      start: rect.x,
      total: rect.width - g,
    });
    collectGutters(node.a, { ...rect, width: a }, gap, out, path + "a");
    collectGutters(node.b, { x: rect.x + a + g, y: rect.y, width: b, height: rect.height }, gap, out, path + "b");
  } else {
    out.push({
      path,
      dir: "column",
      rect: { x: rect.x, y: rect.y + a, width: rect.width, height: g },
      start: rect.y,
      total: rect.height - g,
    });
    collectGutters(node.a, { ...rect, height: a }, gap, out, path + "a");
    collectGutters(node.b, { x: rect.x, y: rect.y + a + g, width: rect.width, height: b }, gap, out, path + "b");
  }
  return out;
}

/** The split node addressed by a collectGutters/findResizeTarget path. */
export function splitAtPath(node: LayoutNode, path: string): LayoutSplit | null {
  let cur: LayoutNode = node;
  for (const step of path) {
    if (cur.type !== "split") return null;
    cur = step === "a" ? cur.a : cur.b;
  }
  return cur.type === "split" ? cur : null;
}

export interface ResizeTarget {
  path: string;
  dir: SplitDir;
  /** Usable size on the split axis (excludes the gap). */
  total: number;
  /** Current size of the `a` side — the divider position. */
  aw: number;
}

/**
 * The divider that h/j/k/l should move for a pane: the nearest ancestor
 * split along the given axis. Moving it left/up shrinks `a`, right/down
 * grows it, regardless of which side the pane is on — the divider is the
 * thing that moves, which stays intuitive under repeated presses.
 */
export function findResizeTarget(
  node: LayoutNode,
  rect: Rect,
  gap: number,
  paneId: string,
  axis: SplitDir,
  path = "",
): ResizeTarget | null {
  if (node.type === "leaf") return null;
  const { a, g, b } = splitSizes(node, rect, gap);
  const rectA: Rect =
    node.dir === "row" ? { ...rect, width: a } : { ...rect, height: a };
  const rectB: Rect =
    node.dir === "row"
      ? { x: rect.x + a + g, y: rect.y, width: b, height: rect.height }
      : { x: rect.x, y: rect.y + a + g, width: rect.width, height: b };

  const inA = collectPaneIds(node.a).includes(paneId);
  const inB = !inA && collectPaneIds(node.b).includes(paneId);
  if (!inA && !inB) return null;

  const deeper = inA
    ? findResizeTarget(node.a, rectA, gap, paneId, axis, path + "a")
    : findResizeTarget(node.b, rectB, gap, paneId, axis, path + "b");
  if (deeper) return deeper;
  if (node.dir !== axis) return null;
  const size = axis === "row" ? rect.width : rect.height;
  return { path, dir: node.dir, total: size - g, aw: a };
}

/** Replace the leaf for `paneId` with a split of (old pane, new pane). */
export function splitLeaf(
  node: LayoutNode,
  paneId: string,
  newPaneId: string,
  dir: SplitDir,
): LayoutNode {
  if (node.type === "leaf") {
    if (node.paneId !== paneId) return node;
    const split: LayoutSplit = {
      type: "split",
      dir,
      ratio: 0.5,
      a: node,
      b: { type: "leaf", paneId: newPaneId },
    };
    return split;
  }
  return {
    ...node,
    a: splitLeaf(node.a, paneId, newPaneId, dir),
    b: splitLeaf(node.b, paneId, newPaneId, dir),
  };
}

/** Remove a leaf; its sibling takes the parent's place. Returns null if tree empties. */
export function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.type === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
  if (a === null) return b;
  if (b === null) return a;
  if (a === node.a && b === node.b) return node;
  return { ...node, a, b };
}

export function collectPaneIds(node: LayoutNode, out: string[] = []): string[] {
  if (node.type === "leaf") out.push(node.paneId);
  else {
    collectPaneIds(node.a, out);
    collectPaneIds(node.b, out);
  }
  return out;
}

/**
 * Directional focus: from the focused pane's center, pick the nearest pane
 * whose center lies in the given direction.
 */
export function neighbor(
  rects: Map<string, Rect>,
  fromId: string,
  dir: "left" | "right" | "up" | "down",
): string | null {
  const from = rects.get(fromId);
  if (!from) return null;
  const fcx = from.x + from.width / 2;
  const fcy = from.y + from.height / 2;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const [id, r] of rects) {
    if (id === fromId) continue;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const dx = cx - fcx;
    const dy = cy - fcy;
    const inDir =
      dir === "left" ? dx < 0 : dir === "right" ? dx > 0 : dir === "up" ? dy < 0 : dy > 0;
    if (!inDir) continue;
    // Weight the off-axis distance heavily so we prefer aligned panes.
    const dist =
      dir === "left" || dir === "right"
        ? Math.abs(dx) + Math.abs(dy) * 3
        : Math.abs(dy) + Math.abs(dx) * 3;
    if (dist < bestDist) {
      bestDist = dist;
      best = id;
    }
  }
  return best;
}
