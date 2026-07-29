import { describe, expect, it } from "bun:test";
import {
  collectGutters,
  collectPaneIds,
  computeRects,
  findResizeTarget,
  leaf,
  neighbor,
  removeLeaf,
  splitAtPath,
  splitLeaf,
} from "./layout";
import type { Rect } from "./types";

const AREA: Rect = { x: 0, y: 0, width: 100, height: 30 };

describe("layout tree", () => {
  it("single leaf fills the area", () => {
    const out = new Map<string, Rect>();
    computeRects(leaf("p1"), AREA, out);
    expect(out.get("p1")).toEqual(AREA);
  });

  it("row split divides width", () => {
    const tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    const out = new Map<string, Rect>();
    computeRects(tree, AREA, out);
    expect(out.get("p1")).toEqual({ x: 0, y: 0, width: 50, height: 30 });
    expect(out.get("p2")).toEqual({ x: 50, y: 0, width: 50, height: 30 });
  });

  it("column split divides height", () => {
    const tree = splitLeaf(leaf("p1"), "p1", "p2", "column");
    const out = new Map<string, Rect>();
    computeRects(tree, AREA, out);
    expect(out.get("p1")).toEqual({ x: 0, y: 0, width: 100, height: 15 });
    expect(out.get("p2")).toEqual({ x: 0, y: 15, width: 100, height: 15 });
  });

  it("removeLeaf collapses to sibling", () => {
    const tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    const collapsed = removeLeaf(tree, "p1");
    expect(collapsed).toEqual(leaf("p2"));
    expect(removeLeaf(leaf("p1"), "p1")).toBeNull();
  });

  it("collects pane ids in order", () => {
    let tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    tree = splitLeaf(tree, "p2", "p3", "column");
    expect(collectPaneIds(tree)).toEqual(["p1", "p2", "p3"]);
  });

  it("row split with a gap leaves unassigned cells between panes", () => {
    const tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    const out = new Map<string, Rect>();
    computeRects(tree, AREA, out, 1);
    expect(out.get("p1")).toEqual({ x: 0, y: 0, width: 49, height: 30 });
    expect(out.get("p2")).toEqual({ x: 50, y: 0, width: 50, height: 30 });
  });

  it("gap shrinks to zero rather than starving tiny panes", () => {
    const tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    const out = new Map<string, Rect>();
    computeRects(tree, { x: 0, y: 0, width: 16, height: 10 }, out, 2);
    // 16 wide can't fit 2×MIN_W(8) plus a gap — the gap collapses.
    expect(out.get("p1")!.width + out.get("p2")!.width).toBe(16);
  });

  it("collectGutters mirrors computeRects geometry", () => {
    let tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    tree = splitLeaf(tree, "p2", "p3", "column");
    const gutters = collectGutters(tree, AREA, 1);
    expect(gutters).toHaveLength(2);
    const row = gutters.find((g) => g.dir === "row")!;
    expect(row.rect).toEqual({ x: 49, y: 0, width: 1, height: 30 });
    expect(row.start).toBe(0);
    expect(row.total).toBe(99);
    const col = gutters.find((g) => g.dir === "column")!;
    // Right half: x 50..99, height split 14/1gap/15.
    expect(col.rect).toEqual({ x: 50, y: 14, width: 50, height: 1 });
    expect(col.path).toBe("b");
  });

  it("findResizeTarget picks the nearest ancestor split on the axis", () => {
    let tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    tree = splitLeaf(tree, "p2", "p3", "column");
    // p3 vertical resize: the column split inside the right half.
    const col = findResizeTarget(tree, AREA, 1, "p3", "column")!;
    expect(col.path).toBe("b");
    expect(col.total).toBe(29);
    // p3 horizontal resize: falls back to the root row split.
    const row = findResizeTarget(tree, AREA, 1, "p3", "row")!;
    expect(row.path).toBe("");
    expect(row.aw).toBe(49);
    // p1 has no column ancestor at all.
    expect(findResizeTarget(tree, AREA, 1, "p1", "column")).toBeNull();
  });

  it("splitAtPath addresses the node findResizeTarget names", () => {
    let tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    tree = splitLeaf(tree, "p2", "p3", "column");
    expect(splitAtPath(tree, "")!.dir).toBe("row");
    expect(splitAtPath(tree, "b")!.dir).toBe("column");
    expect(splitAtPath(tree, "a")).toBeNull();
  });

  it("neighbor finds the pane in a direction", () => {
    let tree = splitLeaf(leaf("p1"), "p1", "p2", "row");
    tree = splitLeaf(tree, "p2", "p3", "column");
    const out = new Map<string, Rect>();
    computeRects(tree, AREA, out);
    expect(neighbor(out, "p1", "right")).toBe("p2");
    expect(neighbor(out, "p2", "down")).toBe("p3");
    expect(neighbor(out, "p3", "up")).toBe("p2");
    expect(neighbor(out, "p1", "left")).toBeNull();
  });
});
