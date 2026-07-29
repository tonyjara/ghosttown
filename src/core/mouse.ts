/**
 * Mouse reporting for panes whose program wants the mouse itself.
 *
 * Full-screen apps (claude enables ?1000/?1002/?1003 + ?1006 with the alt
 * screen; codex enables nothing) do their own scrolling and hit-testing. For
 * those panes the mux must hand the events over instead of acting on them —
 * an alt-screen program has no host scrollback to scroll anyway.
 *
 * Only SGR (1006) and the original X10 form are produced; the utf-8 (1005) and
 * urxvt (1015) encodings are not, since every current app asks for SGR.
 */

/** DECSET modes an inner program uses to ask for mouse events. */
export interface MouseModes {
  /** ?1000 — button press/release only. */
  click: boolean;
  /** ?1002 — press/release plus motion while a button is down. */
  drag: boolean;
  /** ?1003 — every motion event, button or not. */
  any: boolean;
  /** ?1006 — SGR encoding, which lifts the 223-column limit. */
  sgr: boolean;
}

export const MOUSE_MODES_OFF: MouseModes = Object.freeze({
  click: false,
  drag: false,
  any: false,
  sgr: false,
});

export type MouseTracking = "off" | "click" | "drag" | "any";

/** The widest tracking the program asked for; the modes stack rather than replace. */
export function trackingLevel(m: MouseModes): MouseTracking {
  if (m.any) return "any";
  if (m.drag) return "drag";
  if (m.click) return "click";
  return "off";
}

/** DECSET/DECRST codes this module cares about, as seen in child output. */
export function applyMouseMode(modes: MouseModes, code: string, set: boolean): MouseModes {
  switch (code) {
    case "1000":
      return { ...modes, click: set };
    case "1002":
      return { ...modes, drag: set };
    case "1003":
      return { ...modes, any: set };
    case "1006":
      return { ...modes, sgr: set };
    default:
      return modes;
  }
}

/** State of a tracked DECSET code for DECRQM, or null when we do not track it. */
export function mouseModeState(modes: MouseModes, code: string): boolean | null {
  switch (code) {
    case "1000":
      return modes.click;
    case "1002":
      return modes.drag;
    case "1003":
      return modes.any;
    case "1006":
      return modes.sgr;
    default:
      return null;
  }
}

export interface MouseReport {
  type: "down" | "up" | "move" | "drag" | "drag-end" | "drop" | "over" | "out" | "scroll";
  /** 0 left, 1 middle, 2 right (as opentui reports it). */
  button: number;
  /** Pane-local cell, 1-based. */
  col: number;
  row: number;
  modifiers: { shift: boolean; alt: boolean; ctrl: boolean };
  scroll?: { direction: "up" | "down" | "left" | "right"; delta: number };
}

/** Wheel notches to forward at once, so a flung trackpad cannot flood the pty. */
const MAX_NOTCHES = 8;

const MOD_SHIFT = 4;
const MOD_ALT = 8;
const MOD_CTRL = 16;
const MOTION = 32;
/** X10 has no per-button release code — everything releases as button 3. */
const X10_RELEASE = 3;

/**
 * Encode one event the way the program asked for it, or "" when this event is
 * not reportable at the current tracking level.
 */
export function encodeMouseEvent(ev: MouseReport, modes: MouseModes): string {
  const level = trackingLevel(modes);
  if (level === "off") return "";
  const mods =
    (ev.modifiers.shift ? MOD_SHIFT : 0) +
    (ev.modifiers.alt ? MOD_ALT : 0) +
    (ev.modifiers.ctrl ? MOD_CTRL : 0);

  if (ev.type === "scroll") {
    const dir = ev.scroll?.direction ?? "up";
    const base = dir === "up" ? 64 : dir === "down" ? 65 : dir === "left" ? 66 : 67;
    const notches = Math.min(Math.max(1, Math.round(ev.scroll?.delta ?? 1)), MAX_NOTCHES);
    return frame(ev, modes, base + mods, false).repeat(notches);
  }

  switch (ev.type) {
    case "down":
      return frame(ev, modes, ev.button + mods, false);
    case "up":
    case "drag-end":
    case "drop":
      return frame(ev, modes, (modes.sgr ? ev.button : X10_RELEASE) + mods, true);
    case "drag":
      // Motion with a button held needs ?1002 or ?1003.
      if (level === "click") return "";
      return frame(ev, modes, ev.button + mods + MOTION, false);
    case "move":
      // Buttonless motion is ?1003 only.
      if (level !== "any") return "";
      return frame(ev, modes, X10_RELEASE + mods + MOTION, false);
    default:
      return ""; // over/out are opentui's own hover bookkeeping
  }
}

function frame(ev: MouseReport, modes: MouseModes, cb: number, release: boolean): string {
  const col = Math.max(1, Math.round(ev.col));
  const row = Math.max(1, Math.round(ev.row));
  if (modes.sgr) return `\x1b[<${cb};${col};${row}${release ? "m" : "M"}`;
  // X10 packs each field into one byte at +32, so it cannot express 224+.
  if (col > 223 || row > 223) return "";
  return `\x1b[M${String.fromCharCode(32 + cb, 32 + col, 32 + row)}`;
}
