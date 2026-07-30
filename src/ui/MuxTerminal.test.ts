import { describe, expect, it } from "bun:test";
import { PersistentTerminal } from "ghostty-opentui";
import { clampScrollUp, LNM_OFF, viewWindow } from "./MuxTerminal";

const ROWS = 24;
const live = (total: number, scrollUp = 0, prevTotal = total) =>
  viewWindow({ total, rows: ROWS, scrollUp, prevTotal });

describe("LNM_OFF", () => {
  it("leaves a bare LF stepping down a row without touching the column", () => {
    // What a mux surface needs and ghostty-opentui does not ship with: `\n` is
    // `cud1` for any full-screen app in raw mode, so a CR+LF here drags the
    // cursor (and the app's next writes) to the left edge.
    const term = new PersistentTerminal({ cols: 20, rows: 5 });
    term.feed(LNM_OFF);
    term.feed("ABC\n");
    expect(term.getJson({ limit: 1 }).cursor).toEqual([3, 1]);
    // CR+LF and NEL still return to column 0.
    term.feed("\r\nX\x1bE");
    expect(term.getJson({ limit: 1 }).cursor).toEqual([0, 3]);
  });
});

describe("clampScrollUp", () => {
  it("stops at the oldest line in the buffer", () => {
    expect(clampScrollUp(1000, 100, ROWS)).toBe(76);
    expect(clampScrollUp(10, 100, ROWS)).toBe(10);
  });

  it("never goes past the live screen", () => {
    expect(clampScrollUp(-5, 100, ROWS)).toBe(0);
  });

  it("is zero while the buffer is only the screen", () => {
    expect(clampScrollUp(5, ROWS, ROWS)).toBe(0);
  });
});

describe("viewWindow", () => {
  it("shows the live screen by default", () => {
    expect(live(100)).toEqual({ scrollUp: 0, offset: 76, limit: ROWS });
  });

  it("starts at line 0 when nothing has scrolled yet", () => {
    expect(live(ROWS)).toEqual({ scrollUp: 0, offset: 0, limit: ROWS });
  });

  it("follows the tail as output arrives", () => {
    expect(live(140, 0, 100).offset).toBe(116);
  });

  it("holds the view still when output arrives while scrolled back", () => {
    const before = live(100, 10);
    const after = viewWindow({ total: 110, rows: ROWS, scrollUp: 10, prevTotal: 100 });
    expect(after.offset).toBe(before.offset);
    expect(after.scrollUp).toBe(20);
  });

  it("clamps to the top of the scrollback", () => {
    const w = live(100, 500);
    expect(w).toEqual({ scrollUp: 76, offset: 0, limit: ROWS });
  });

  it("drops back to live when the buffer shrinks under the view (clear/reset)", () => {
    expect(viewWindow({ total: ROWS, rows: ROWS, scrollUp: 40, prevTotal: 100 })).toEqual({
      scrollUp: 0,
      offset: 0,
      limit: ROWS,
    });
  });

  it("keeps the window exactly one screen tall at every position", () => {
    for (const scrollUp of [0, 1, 37, 76]) {
      const w = live(100, scrollUp);
      expect(w.limit).toBe(ROWS);
      expect(w.offset + w.limit + w.scrollUp).toBe(100);
    }
  });
});
