/**
 * Copies, on their way out of the mux.
 *
 * A program inside a pane copies by writing OSC 52 to its terminal —
 * `ESC ] 52 ; c ; <base64> BEL`. claude does exactly that on every
 * drag-select (it grabs the mouse, draws its own highlight, and prints
 * "copied N chars to clipboard" as it emits the sequence). But a pane's
 * emulator is render-only: the sequence lands in ghostty-vt, which has no
 * system clipboard to put it on, and the copy dies there. The toast is telling
 * the truth about what the program did and a lie about what happened.
 *
 * So the mux relays it to the terminal ghosttown itself runs in — the same job
 * as tmux's `set-clipboard on`, minus the switch: a mux that silently eats
 * copies is broken, not configurable. Ghostty allows clipboard *writes*
 * unconditionally (`clipboard-write = allow`), so a relayed one needs no
 * prompt.
 *
 * Reads (`ESC ] 52 ; c ; ?`) are deliberately NOT relayed. The answer would
 * come back on our stdin — indistinguishable from the user typing it into
 * whichever pane is focused.
 */

/** Base64 (with padding), which is all an OSC 52 payload may contain. */
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * Cap on one relayed payload. Ghostty takes large OSC strings, but the point of
 * a cap is that a program spewing megabytes at the clipboard cannot make us
 * spew them at the host terminal too. ~700KB of text once decoded.
 */
export const MAX_CLIPBOARD_BASE64 = 1 << 20;

/**
 * The base64 payload of an OSC 52 *write*, or null if this is not one.
 *
 * `body` is everything between `52;` and the terminator: a selection field
 * (`c`, `p`, `s`, several of them, or empty for "the default one") then `;`
 * then the data. The selection is dropped on the way through — panes copy for a
 * user who pressed nothing, so the clipboard they mean is the system one.
 */
export function parseClipboardWrite(body: string): string | null {
  const semi = body.indexOf(";");
  if (semi === -1) return null;
  const payload = body.slice(semi + 1);
  if (payload === "?") return null; // a read; see the header
  if (!payload || payload.length > MAX_CLIPBOARD_BASE64) return null;
  if (!BASE64.test(payload)) return null;
  return payload;
}

/** An OSC 52 write for an already-encoded payload. */
export function osc52(payloadBase64: string): string {
  return `\x1b]52;c;${payloadBase64}\x07`;
}

/** An OSC 52 write for text ghosttown itself selected. */
export function osc52Text(text: string): string {
  return osc52(Buffer.from(text, "utf8").toString("base64"));
}

/**
 * Put a sequence on the host terminal's stdout.
 *
 * Only the TUI process may call this: its stdout is the terminal (no daemon) or
 * a pty the daemon forwards to the attach client verbatim, which is the one path
 * that reaches the user's Ghostty. Called from event handlers, never mid-render,
 * so it cannot land inside a frame the renderer is still writing.
 */
export function relayToHostTerminal(sequence: string): void {
  process.stdout.write(sequence);
}
