import type { LayoutNode, LayoutSplit, Rect, SplitDir } from "./types";

/** Minimum pane size: tab strip + at least a few usable cells. */
const MIN_W = 8;
const MIN_H = 3;

export function leaf(paneId: string): LayoutNode {
  return { type: "leaf", paneId };
}

/**
 * Compute pane rects by walking the split tree. Integer math: `a` gets
 * floor(space * ratio), `b` the remainder. A 1-cell gutter is not reserved —
 * panes touch, and the tab strip row visually separates them.
 */
export function computeRects(node: LayoutNode, rect: Rect, out: Map<string, Rect>): void {
  if (node.type === "leaf") {
    out.set(node.paneId, rect);
    return;
  }
  if (node.dir === "row") {
    const aw = Math.max(MIN_W, Math.floor(rect.width * node.ratio));
    const bw = rect.width - aw;
    computeRects(node.a, { ...rect, width: aw }, out);
    computeRects(node.b, { x: rect.x + aw, y: rect.y, width: bw, height: rect.height }, out);
  } else {
    const ah = Math.max(MIN_H, Math.floor(rect.height * node.ratio));
    const bh = rect.height - ah;
    computeRects(node.a, { ...rect, height: ah }, out);
    computeRects(node.b, { x: rect.x, y: rect.y + ah, width: rect.width, height: bh }, out);
  }
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
