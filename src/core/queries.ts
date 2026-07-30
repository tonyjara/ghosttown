/**
 * Scans child PTY output for terminal queries that need answers (the emulator
 * is render-only, so answering is on us) and for sequences worth observing:
 * OSC (title changes, notifications) and the mouse-reporting modes that decide
 * whether a pane forwards mouse events to its program (src/core/mouse.ts).
 *
 * The stream itself is never modified — everything is still fed to the
 * emulator. We only watch it go by. A small carry buffer handles escape
 * sequences split across chunk boundaries; the carry is always an
 * *incomplete* sequence, so nothing is ever matched (and answered) twice.
 */

import { applyMouseMode, mouseModeState, MOUSE_MODES_OFF, type MouseModes } from "./mouse";

const MAX_CARRY = 4096;

/** CPR answer for a 0-based cursor — the deferred path builds it by hand. */
export function cursorReport(priv: string, x: number, y: number): string {
  return `\x1b[${priv === "?" ? "?" : ""}${y + 1};${x + 1}R`;
}

export interface ScannerHooks {
  /** Write a response back to the child PTY. */
  respond: (data: string) => void;
  /** Current cursor position as [x, y], 0-based. */
  getCursor: () => [number, number];
  /**
   * Answer a cursor position report out of band. Returning true means "I will
   * respond myself, later" and suppresses the synchronous answer — the pty
   * host uses it to ask the TUI (which owns the emulator) over the socket.
   */
  deferCursorReport?: (priv: string) => boolean;
  onTitle?: (title: string) => void;
  onNotify?: (title: string, body: string) => void;
}

const CSI_QUERY =
  // CPR / DSR / DA1 / DA2 / kitty / DECRQM / XTVERSION
  /\x1b\[(?:(\??)6n|5n|(0?)c|>0?c|\?u|\?(\d+)\$p|>0?q)/g;
const OSC = /\x1b\]([0-9]+);([^\x07\x1b]*)(\x07|\x1b\\)/g;
/** DECSET/DECRST, which may carry several modes in one sequence. */
const PRIVATE_MODE = /\x1b\[\?([\d;]+)([hl])/g;

export class OutputScanner {
  private carry = "";
  private modes: MouseModes = MOUSE_MODES_OFF;
  private bracketedPaste = false;

  constructor(private hooks: ScannerHooks) {}

  /** Mouse reporting the child has asked for, right now. */
  mouseModes(): MouseModes {
    return this.modes;
  }

  /**
   * ?2004 — whether the child wants pasted text bracketed. Only a program that
   * asked may be sent the markers: to everything else they are just bytes, and
   * `cat` would print them.
   */
  pasteMode(): boolean {
    return this.bracketedPaste;
  }

  scan(chunk: string): void {
    const text = this.carry + chunk;
    this.carry = "";

    CSI_QUERY.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CSI_QUERY.exec(text)) !== null) {
      this.answerCsi(m);
    }

    OSC.lastIndex = 0;
    while ((m = OSC.exec(text)) !== null) {
      this.handleOsc(m[1]!, m[2]!, m[3]!);
    }

    PRIVATE_MODE.lastIndex = 0;
    while ((m = PRIVATE_MODE.exec(text)) !== null) {
      const set = m[2] === "h";
      for (const code of m[1]!.split(";")) {
        this.modes = applyMouseMode(this.modes, code, set);
        if (code === "2004") this.bracketedPaste = set;
      }
    }

    this.carry = trailingIncompleteEscape(text);
  }

  private answerCsi(m: RegExpExecArray): void {
    const seq = m[0];
    const { respond } = this.hooks;
    if (seq.endsWith("6n")) {
      const priv = m[1] === "?" ? "?" : "";
      if (this.hooks.deferCursorReport?.(priv)) return;
      const [x, y] = this.hooks.getCursor();
      respond(cursorReport(priv, x, y));
    } else if (seq === "\x1b[5n") {
      respond("\x1b[0n");
    } else if (seq === "\x1b[c" || seq === "\x1b[0c") {
      respond("\x1b[?62;22c"); // VT220-class with color
    } else if (seq === "\x1b[>c" || seq === "\x1b[>0c") {
      respond("\x1b[>1;10;0c");
    } else if (seq === "\x1b[?u") {
      respond("\x1b[?0u"); // kitty keyboard: no flags (graceful degrade)
    } else if (seq.endsWith("$p")) {
      const mode = m[3]!;
      const tracked =
        mouseModeState(this.modes, mode) ?? (mode === "2004" ? this.bracketedPaste : null);
      // Mouse and bracketed-paste modes: report what the child actually set,
      // since we honour them. 2026 (sync updates): recognized but off.
      // Everything else: unknown.
      if (tracked !== null) respond(`\x1b[?${mode};${tracked ? 1 : 2}$y`);
      else respond(mode === "2026" ? "\x1b[?2026;2$y" : `\x1b[?${mode};0$y`);
    } else if (seq.endsWith("q")) {
      respond("\x1bP>|ghosttown 0.1.0\x1b\\");
    }
  }

  private handleOsc(code: string, body: string, terminator: string): void {
    switch (code) {
      case "0":
      case "2":
        this.hooks.onTitle?.(body);
        break;
      case "9":
        // OSC 9;4;... is ConEmu progress, not a notification.
        if (!body.startsWith("4;")) this.hooks.onNotify?.("", body);
        break;
      case "777": {
        const parts = body.split(";");
        if (parts[0] === "notify") {
          this.hooks.onNotify?.(parts[1] ?? "", parts.slice(2).join(";"));
        }
        break;
      }
      case "10":
      case "11":
      case "12":
        if (body === "?") {
          const color = code === "10" ? "e0e0/e0e0/e0e0" : "1a1a/1b1b/2626";
          this.hooks.respond(`\x1b]${code};rgb:${color}${terminator}`);
        }
        break;
    }
  }
}

/**
 * If `text` ends inside an unterminated escape sequence, return that suffix
 * (capped) so it can be prepended to the next chunk.
 */
export function trailingIncompleteEscape(text: string): string {
  const escIdx = text.lastIndexOf("\x1b");
  if (escIdx === -1) return "";
  const tail = text.slice(escIdx);
  if (tail.length > MAX_CARRY) return "";
  if (tail.length === 1) return tail; // lone ESC — could be anything
  const kind = tail[1];
  if (kind === "[") {
    // CSI: complete once a final byte (0x40–0x7E) appears.
    return /[\x40-\x7e]/.test(tail.slice(2)) ? "" : tail;
  }
  if (kind === "]" || kind === "P") {
    // OSC / DCS: complete on BEL or ST.
    return tail.includes("\x07") || tail.includes("\x1b\\") ? "" : tail;
  }
  return ""; // two-char escape (ESC x) — complete
}
