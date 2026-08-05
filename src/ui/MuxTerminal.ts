import type { OptimizedBuffer } from "@opentui/core";
import type { PersistentTerminal, TerminalData } from "ghostty-opentui";
import {
  GhosttyTerminalRenderable,
  terminalDataToStyledText,
  type HighlightRegion,
} from "ghostty-opentui/opentui";
import { osc52Text, relayToHostTerminal } from "../core/clipboard";
import { loadConfig } from "../core/config";
import {
  encodeMouseEvent,
  trackingLevel,
  type MouseModes,
  type MouseReport,
} from "../core/mouse";

/**
 * A terminal surface sized to its pane.
 *
 * GhosttyTerminalRenderable renders the WHOLE emulator buffer — scrollback
 * included — into its text buffer, and reports the cursor as an absolute row
 * in that buffer. That is right for a log view inside a ScrollBox, and wrong
 * for a mux pane: the moment the inner program scrolls the screen, the pane
 * keeps showing the OLDEST lines and the hardware cursor is placed far below
 * the pane, where the host terminal clamps it to the last row. (Only some
 * agents trip it: codex writes its transcript into the scrollback, while
 * claude repaints inside the screen and never scrolls it.)
 *
 * So this subclass renders a `rows`-tall WINDOW of the buffer instead — the
 * live screen, or `scrollUp` lines above it while the user is scrolled back.
 * The cursor row then lands in pane coordinates, and the per-frame cost stops
 * growing with the scrollback (15ms/frame at 20k lines before, 0.1ms after).
 *
 * Reaching into library privates is pinned to ghostty-opentui 1.5.0 — recheck
 * on upgrade. Everything we touch is listed in `Internals`.
 */
interface Internals {
  _ansiDirty: boolean;
  _showCursor: boolean;
  _cursorStyle?: "block" | "underline";
  _highlights?: HighlightRegion[];
  _lineCount: number;
  _renderCursor: { x: number; y: number; visible: boolean; style: string };
  _persistentTerminal: PersistentTerminal | null;
  x: number;
  y: number;
  ctx: {
    setCursorPosition(x: number, y: number, visible: boolean): void;
    setCursorStyle(opts: { style: string; blinking: boolean }): void;
  };
}

/** Highest scrollback position: total lines minus the screen we render. */
export function clampScrollUp(scrollUp: number, total: number, rows: number): number {
  return Math.min(Math.max(0, Math.round(scrollUp)), Math.max(0, total - rows));
}

/**
 * The slice of the buffer a pane shows. `scrollUp` is how many lines above the
 * live screen the view sits; while it is non-zero, new output must not drag the
 * view along, so growth since the last frame is added back to it.
 */
export function viewWindow(opts: {
  total: number;
  rows: number;
  scrollUp: number;
  prevTotal: number;
}): { scrollUp: number; offset: number; limit: number } {
  const grown = opts.total - opts.prevTotal;
  const held = opts.scrollUp > 0 && grown > 0 ? opts.scrollUp + grown : opts.scrollUp;
  const scrollUp = clampScrollUp(held, opts.total, opts.rows);
  return {
    scrollUp,
    offset: Math.max(0, opts.total - opts.rows - scrollUp),
    limit: opts.rows,
  };
}

/**
 * Only the surface that owns the cursor may touch it, and DECSCUSR is sent
 * only on change: re-sending it every frame resets the blink phase in some
 * terminals, which makes the cursor look solid.
 */
let appliedCursorStyle = "";

/**
 * RM 20 (LNM off), fed to every fresh emulator.
 *
 * ghostty-opentui creates its terminals with LNM *on*, so a bare LF behaves
 * like CR+LF. That is right for rendering a text blob, and wrong for a mux
 * surface: a full-screen app in raw mode (which clears ONLCR) writes bare LF
 * as `cud1` — "down one row, keep the column". With LNM on, every one of those
 * slid the cursor to the left edge, and everything the app drew after it landed
 * in the wrong columns. In neovim, walking down a list moved the cursor to
 * column 0 and, at the bottom of the screen, parked it there.
 */
export const LNM_OFF = "\x1b[20l";

/** The selection argument opentui hands to onSelectionChanged. */
type SelectionArg = Parameters<GhosttyTerminalRenderable["onSelectionChanged"]>[0];

/** The two bits of a live selection copy-on-select needs. */
interface SelectionState {
  isDragging: boolean;
  isActive: boolean;
}

/**
 * A drag that just ended is the moment "selected" becomes "copied": dragging on
 * the previous notification, not dragging now. The renderable is told about
 * every step of a drag, so without the transition the same text would be copied
 * again on each one.
 */
export function selectionFinished(wasDragging: boolean, selection: SelectionState | null): boolean {
  if (!selection) return false;
  return wasDragging && selection.isActive && !selection.isDragging;
}

/** How a surface reaches the program behind it for mouse reporting. */
export interface MouseDelegate {
  modes: () => MouseModes;
  report: (data: string) => void;
  /**
   * True while the mouse belongs to something outside the pane — a pane
   * divider being dragged. The pointer crosses surfaces on its way, and
   * neither the pane nor its program may act on those events.
   */
  grabbed?: () => boolean;
}

export class MuxTerminal extends GhosttyTerminalRenderable {
  private scrollUp = 0;
  private prevTotal = 0;
  private mouse: MouseDelegate | null = null;
  /** Whether this surface holds a press the program has not been released of. */
  private pressed = false;
  /** Whether the last selection notification arrived mid-drag. */
  private selectionDragging = false;
  /** Set for agent surfaces only; see onSelectionChanged. */
  private copyOnSelect: (() => boolean) | null = null;

  constructor(...args: ConstructorParameters<typeof GhosttyTerminalRenderable>) {
    super(...args);
    // Before any child bytes (including the host's replay) reach the emulator.
    if ((this as unknown as Internals)._persistentTerminal) this.feed(LNM_OFF);
  }

  /** Let this surface forward mouse events to its program (see core/mouse). */
  attachMouse(delegate: MouseDelegate): void {
    this.mouse = delegate;
  }

  /**
   * True while the program asked for the mouse: it scrolls and hit-tests
   * itself, so the pane must not also act on the event. Full-screen apps that
   * do this (claude) run on the alt screen, which has no scrollback to lose.
   */
  private appOwnsMouse(): boolean {
    return !!this.mouse && trackingLevel(this.mouse.modes()) !== "off";
  }

  /** Move the view `lines` up the scrollback; negative goes back toward live. */
  scrollLines(lines: number): void {
    const next = clampScrollUp(this.scrollUp + lines, this.prevTotal, this.rows);
    if (next === this.scrollUp) return;
    this.scrollUp = next;
    this.invalidate();
  }

  /** Back to the live screen — typing should never leave you reading history. */
  snapToLive(): void {
    if (this.scrollUp === 0) return;
    this.scrollUp = 0;
    this.invalidate();
  }

  /**
   * Give up cursor ownership (focus left the pane, a dialog opened, the tab
   * switched). Nobody else hides it for us, hence the explicit call.
   */
  releaseCursor(): void {
    (this as unknown as Internals).ctx.setCursorPosition(0, 0, false);
    appliedCursorStyle = "";
  }

  /**
   * Keep the program's idea of the buttons honest. Opentui ends a drag with
   * more than one event and to more than one renderable — `drag-end` and `up`
   * to whichever it captured, `drop` and `up` to whichever is under the
   * pointer — and a release for a press the program never saw leaves it
   * believing a button is still down. False means "do not forward this one".
   */
  private trackPress(type: MouseReport["type"]): boolean {
    if (type === "down") {
      this.pressed = true;
      return true;
    }
    if (type === "up" || type === "drag-end" || type === "drop") {
      if (!this.pressed) return false;
      this.pressed = false;
    }
    return true;
  }

  protected override onMouseEvent(event: MouseReport & { x: number; y: number }): void {
    // A pane divider is being dragged across us. Returning without calling
    // super still bubbles, and the drag listens at the root.
    //
    // A wheel notch is exempt: it cannot be part of a drag, and if one shows up
    // while a drag is still "running" then that drag's release went missing.
    // Swallowing it would cost the pane the notch AND read as "scrolling is
    // broken" for as long as the stale drag lasts. The root ends it.
    if (event.type !== "scroll" && this.mouse?.grabbed?.()) return;
    if (this.mouse && this.appOwnsMouse()) {
      if (!this.trackPress(event.type)) return;
      // Pane-local, 1-based — what the protocol expects.
      const data = encodeMouseEvent(
        { ...event, col: event.x - this.x + 1, row: event.y - this.y + 1 },
        this.mouse.modes(),
      );
      if (data) this.mouse.report(data);
      return; // still bubbles, so clicking an unfocused pane focuses it
    }
    if (event.type === "scroll") {
      // The pane owns scrollback; the base class's scrollY would slide a
      // viewport over the full buffer, which is not what we render.
      const dir = event.scroll?.direction;
      const delta = event.scroll?.delta ?? 0;
      if (dir === "up") this.scrollLines(delta);
      else if (dir === "down") this.scrollLines(-delta);
      return;
    }
    super.onMouseEvent(event);
  }

  /** Dragging belongs to the program when it owns the mouse, not to selection. */
  override shouldStartSelection(x: number, y: number): boolean {
    if (this.appOwnsMouse()) return false;
    return super.shouldStartSelection(x, y);
  }

  /**
   * Copy on select, the way a native terminal does it: letting go of the mouse
   * puts the selection on the system clipboard, via OSC 52 to the terminal
   * ghosttown runs in (core/clipboard).
   *
   * Agent panes only, hence the gate — a pane running neovim, a shell or a pager
   * behaves exactly as it did before, selection highlight and all, and nothing
   * touches the clipboard behind the user's back.
   *
   * Panes whose program owns the mouse never reach this anyway:
   * shouldStartSelection keeps us out of their way, and they copy themselves —
   * claude selects with its own highlight and emits its own OSC 52, which
   * core/state relays.
   */
  override onSelectionChanged(selection: SelectionArg): boolean {
    const result = super.onSelectionChanged(selection);
    const sel = selection as SelectionState | null;
    // hasSelection(): a drag that merely *crossed* this pane on its way
    // elsewhere ends here too, and copying then would hand the clipboard to
    // whichever pane the release happened to be notified last.
    if (selectionFinished(this.selectionDragging, sel) && this.copyOnSelect?.() && this.hasSelection()) {
      const text = this.getSelectedText();
      if (text) relayToHostTerminal(osc52Text(text));
    }
    this.selectionDragging = !!sel?.isDragging;
    return result;
  }

  /**
   * Whether releasing a selection in this pane copies it. Set per surface, from
   * whether an agent is running in it.
   */
  setCopyOnSelect(enabled: () => boolean): void {
    this.copyOnSelect = enabled;
  }

  protected override renderSelf(buffer: OptimizedBuffer): void {
    const int = this as unknown as Internals;
    const term = int._persistentTerminal;
    if (int._ansiDirty && term) {
      const rows = this.rows;
      // A probe for the buffer size (it serializes one line), then the window.
      const total = term.getJson({ limit: 1 }).totalLines;
      const view = viewWindow({ total, rows, scrollUp: this.scrollUp, prevTotal: this.prevTotal });
      this.scrollUp = view.scrollUp;
      this.prevTotal = total;

      const data = term.getJson({ offset: view.offset, limit: view.limit });
      this.textBuffer.setStyledText(terminalDataToStyledText(data, int._highlights));
      this.updateTextInfo();
      int._lineCount = data.lines.length;
      this.placeCursor(data, view.scrollUp, rows);
      // Consume the flag: the base class would re-fetch the whole buffer.
      int._ansiDirty = false;
    }
    super.renderSelf(buffer);
  }

  /** Cursor position in window rows: scrolling back pushes it off the bottom. */
  private placeCursor(data: TerminalData, scrollUp: number, rows: number): void {
    const int = this as unknown as Internals;
    const row = data.cursor[1] + scrollUp;
    int._renderCursor.x = data.cursor[0];
    int._renderCursor.y = row;
    int._renderCursor.visible = int._showCursor && data.cursorVisible && row < rows;
    const ts = data.cursorStyle;
    int._renderCursor.style =
      ts === "default" ? "default" : ts === "bar" ? "line" : ts === "underline" ? "underline" : "block";
  }

  private invalidate(): void {
    (this as unknown as Internals)._ansiDirty = true;
    this.requestRender();
  }
}

/**
 * The stock cursor pass hides the hardware cursor from every surface that does
 * NOT own it, so with more than one pane whichever renders last wins and no
 * cursor shows at all. It also hardcodes blinking off. `renderTerminalCursor`
 * is private, so it cannot be overridden as a normal method — but the base
 * class calls it through `this`, so defining it on our prototype wins.
 */
Object.defineProperty(MuxTerminal.prototype, "renderTerminalCursor", {
  value: function (this: MuxTerminal) {
    const self = this as unknown as Internals;
    if (!self._showCursor) return; // not the owner: never show OR hide
    if (!self._renderCursor.visible) {
      self.ctx.setCursorPosition(0, 0, false);
      appliedCursorStyle = "";
      return;
    }
    const blinking = loadConfig().appearance?.cursor_blink ?? true;
    const style = self._cursorStyle ?? self._renderCursor.style;
    const key = `${style}:${blinking}`;
    if (key !== appliedCursorStyle) {
      appliedCursorStyle = key;
      self.ctx.setCursorStyle({ style, blinking });
    }
    self.ctx.setCursorPosition(
      self.x + self._renderCursor.x + 1,
      self.y + self._renderCursor.y + 1,
      true,
    );
  },
  writable: true,
  configurable: true,
});
