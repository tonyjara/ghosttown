import { describe, expect, it } from "bun:test";
import { computeRects, leaf, neighbor, removeLeaf, splitLeaf, collectPaneIds } from "./layout";
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
