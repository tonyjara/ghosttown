import { describe, expect, it } from "bun:test";
import {
  applyMouseMode,
  encodeMouseEvent,
  mouseModeState,
  MOUSE_MODES_OFF,
  trackingLevel,
  type MouseModes,
  type MouseReport,
} from "./mouse";

const modes = (over: Partial<MouseModes> = {}): MouseModes => ({ ...MOUSE_MODES_OFF, ...over });
const sgrClick = modes({ click: true, sgr: true });
const noMods = { shift: false, alt: false, ctrl: false };
const ev = (over: Partial<MouseReport> = {}): MouseReport => ({
  type: "down",
  button: 0,
  col: 5,
  row: 3,
  modifiers: noMods,
  ...over,
});

describe("mouse modes", () => {
  it("tracks each DECSET mode independently", () => {
    let m = applyMouseMode(MOUSE_MODES_OFF, "1002", true);
    m = applyMouseMode(m, "1006", true);
    expect(m).toEqual(modes({ drag: true, sgr: true }));
    expect(applyMouseMode(m, "1002", false).drag).toBe(false);
  });

  it("ignores modes it does not model", () => {
    expect(applyMouseMode(MOUSE_MODES_OFF, "1049", true)).toEqual(MOUSE_MODES_OFF);
  });

  it("reports the widest tracking asked for", () => {
    expect(trackingLevel(MOUSE_MODES_OFF)).toBe("off");
    expect(trackingLevel(modes({ click: true }))).toBe("click");
    expect(trackingLevel(modes({ click: true, drag: true }))).toBe("drag");
    expect(trackingLevel(modes({ click: true, drag: true, any: true }))).toBe("any");
  });

  it("resetting any-motion leaves narrower tracking in place", () => {
    const m = applyMouseMode(modes({ click: true, drag: true, any: true }), "1003", false);
    expect(trackingLevel(m)).toBe("drag");
  });

  it("answers DECRQM only for the modes it honours", () => {
    expect(mouseModeState(modes({ click: true }), "1000")).toBe(true);
    expect(mouseModeState(MOUSE_MODES_OFF, "1006")).toBe(false);
    expect(mouseModeState(MOUSE_MODES_OFF, "2026")).toBeNull();
  });
});

describe("encodeMouseEvent", () => {
  it("sends nothing while the program has not asked for the mouse", () => {
    expect(encodeMouseEvent(ev(), MOUSE_MODES_OFF)).toBe("");
  });

  it("encodes press and release in SGR", () => {
    expect(encodeMouseEvent(ev(), sgrClick)).toBe("\x1b[<0;5;3M");
    expect(encodeMouseEvent(ev({ type: "up" }), sgrClick)).toBe("\x1b[<0;5;3m");
    expect(encodeMouseEvent(ev({ button: 2 }), sgrClick)).toBe("\x1b[<2;5;3M");
  });

  it("encodes the wheel, one frame per notch", () => {
    const up = encodeMouseEvent(
      ev({ type: "scroll", scroll: { direction: "up", delta: 1 } }),
      sgrClick,
    );
    expect(up).toBe("\x1b[<64;5;3M");
    const down = encodeMouseEvent(
      ev({ type: "scroll", scroll: { direction: "down", delta: 3 } }),
      sgrClick,
    );
    expect(down).toBe("\x1b[<65;5;3M".repeat(3));
  });

  it("caps a flung wheel so it cannot flood the pty", () => {
    const many = encodeMouseEvent(
      ev({ type: "scroll", scroll: { direction: "down", delta: 500 } }),
      sgrClick,
    );
    expect(many.match(/M/g)?.length).toBe(8);
  });

  it("folds modifiers into the button byte", () => {
    expect(
      encodeMouseEvent(ev({ modifiers: { shift: true, alt: false, ctrl: true } }), sgrClick),
    ).toBe("\x1b[<20;5;3M");
  });

  it("gates motion on the tracking level", () => {
    const drag = ev({ type: "drag" });
    const move = ev({ type: "move" });
    expect(encodeMouseEvent(drag, sgrClick)).toBe("");
    expect(encodeMouseEvent(drag, modes({ drag: true, sgr: true }))).toBe("\x1b[<32;5;3M");
    expect(encodeMouseEvent(move, modes({ drag: true, sgr: true }))).toBe("");
    expect(encodeMouseEvent(move, modes({ any: true, sgr: true }))).toBe("\x1b[<35;5;3M");
  });

  it("falls back to X10 when the program did not ask for SGR", () => {
    expect(encodeMouseEvent(ev(), modes({ click: true }))).toBe("\x1b[M\x20%#");
    // X10 has no per-button release: everything comes back as button 3.
    expect(encodeMouseEvent(ev({ type: "up" }), modes({ click: true }))).toBe("\x1b[M#%#");
  });

  it("drops X10 frames that cannot fit a cell past column 223", () => {
    expect(encodeMouseEvent(ev({ col: 400 }), modes({ click: true }))).toBe("");
    expect(encodeMouseEvent(ev({ col: 400 }), sgrClick)).toBe("\x1b[<0;400;3M");
  });

  it("ignores opentui's own hover bookkeeping", () => {
    expect(encodeMouseEvent(ev({ type: "over" }), sgrClick)).toBe("");
    expect(encodeMouseEvent(ev({ type: "out" }), sgrClick)).toBe("");
  });
});
