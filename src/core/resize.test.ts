/**
 * Arrange-mode resizing. The divider is stored as a ratio but moved in whole
 * cells, so the round trip cell → ratio → cell has to be exact; the store is
 * module-global, so each test builds its own workspace.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
  createWorkspace,
  currentRects,
  focusedPaneId,
  resizeFocused,
  setArea,
  splitPane,
  store,
} from "./state";

/** Heights of a column split's two panes. */
const heights = (top: string, bottom: string) => {
  const rects = currentRects();
  return [rects.get(top)?.height ?? 0, rects.get(bottom)?.height ?? 0] as const;
};

describe("resizeFocused", () => {
  // Other files assume the default screen; hand it back.
  afterAll(() => setArea(80, 24));

  it("moves the divider on every press, all the way to the far pane's minimum", () => {
    // 24 rows minus the status bar is 23, minus the 1-cell gap leaves 22 usable
    // — a size where several cell positions have no exact ratio. Stepping onto
    // one used to render the divider back where it started, and since the next
    // press recomputed from that same position, it stuck there for good: resize
    // simply stopped part way down while dragging the same divider still worked.
    setArea(100, 24);
    createWorkspace({ name: "step-down" });
    const top = focusedPaneId();
    const bottom = splitPane(top, "column")!;
    expect(bottom).not.toBeNull();

    let [topH, bottomH] = heights(top, bottom);
    // Down until the bottom pane cannot give up another row.
    for (let press = 1; bottomH > 3; press++) {
      resizeFocused("down");
      const [nowTop, nowBottom] = heights(top, bottom);
      expect([nowTop, nowBottom], `press ${press} from top=${topH} bottom=${bottomH}`).toEqual([
        topH + 1,
        bottomH - 1,
      ]);
      [topH, bottomH] = [nowTop, nowBottom];
    }
    expect(bottomH).toBe(3);

    // ...and it stops there rather than squeezing the pane out of existence.
    resizeFocused("down");
    expect(heights(top, bottom)).toEqual([topH, 3]);

    // The same, back up: every press moves, until the top pane is at its own
    // minimum.
    for (let press = 1; topH > 3; press++) {
      resizeFocused("up");
      const [nowTop, nowBottom] = heights(top, bottom);
      expect([nowTop, nowBottom], `up press ${press} from top=${topH}`).toEqual([
        topH - 1,
        bottomH + 1,
      ]);
      [topH, bottomH] = [nowTop, nowBottom];
    }
    expect(topH).toBe(3);
  });

  it("steps sideways on every press too", () => {
    // Same round trip on the other axis, where the minimum is wider.
    setArea(101, 30);
    createWorkspace({ name: "step-right" });
    const left = focusedPaneId();
    const right = splitPane(left, "row")!;
    const widths = () => {
      const rects = currentRects();
      return [rects.get(left)?.width ?? 0, rects.get(right)?.width ?? 0] as const;
    };

    let [leftW, rightW] = widths();
    for (let press = 1; rightW > 8 && press < 200; press++) {
      resizeFocused("right");
      const [nowLeft, nowRight] = widths();
      // Horizontal cells are half as wide as tall, so a press is 2 columns —
      // until the last one, which lands on the far pane's minimum.
      expect(nowLeft + nowRight, `press ${press}`).toBe(leftW + rightW);
      expect(nowLeft, `press ${press} from left=${leftW}`).toBeGreaterThan(leftW);
      [leftW, rightW] = [nowLeft, nowRight];
    }
    expect(rightW).toBe(8);
  });

  it("does nothing when the pane has no divider on that axis", () => {
    setArea(100, 30);
    createWorkspace({ name: "no-divider" });
    const only = focusedPaneId();
    const before = currentRects().get(only);
    resizeFocused("down");
    resizeFocused("right");
    expect(currentRects().get(only)).toEqual(before);
  });

  it("leaves the panes where they are when the split is too small to divide", () => {
    // A pane area under two minimums has no legal divider position at all.
    setArea(100, 30);
    createWorkspace({ name: "too-small" });
    const top = focusedPaneId();
    const bottom = splitPane(top, "column")!;
    setArea(100, 6); // 5 rows for two panes that each want 3
    const before = heights(top, bottom);
    resizeFocused("down");
    expect(heights(top, bottom)).toEqual(before);
  });
});
