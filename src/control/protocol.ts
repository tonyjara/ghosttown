/**
 * Control protocol: newline-delimited JSON over a Unix socket.
 * This protocol is the stable seam for the phase-2 daemon/client split —
 * keep it additive.
 */
import type { AgentStatus, SessionSnapshot } from "../core/types";

export interface Request {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

export type Response =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

export interface Methods {
  ping: { params: Record<string, never>; result: "pong" };
  list: { params: Record<string, never>; result: SessionSnapshot };
  split: {
    params: { pane?: string; dir?: "right" | "down"; command?: string; args?: string[] };
    result: { paneId: string };
  };
  "new-tab": {
    params: { pane?: string; command?: string; args?: string[] };
    result: { surfaceId: string };
  };
  "select-tab": { params: { pane?: string; index: number }; result: true };
  "close-tab": { params: { surface?: string }; result: true };
  "send-text": { params: { surface?: string; text: string }; result: true };
  "read-screen": { params: { surface?: string }; result: { text: string } };
  report: { params: { surface?: string; status: AgentStatus }; result: true };
  notify: { params: { title?: string; body: string; surface?: string }; result: true };
  /** Force a full (non-diffed) repaint; the daemon calls this on reattach. */
  redraw: { params: Record<string, never>; result: true };
}

export const AGENT_STATUSES: AgentStatus[] = ["idle", "working", "blocked", "done"];

export function defaultSocketDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/tmp/ghosttown-${uid}`;
}

export function socketPathFor(session: string): string {
  return `${defaultSocketDir()}/${session}.sock`;
}

// ---------------------------------------------------------------------------
// Attach protocol (dtach-style daemon). The daemon owns a PTY running the
// TUI; `gt` clients proxy their terminal to it over this socket. Frames are
// newline-delimited JSON, byte payloads base64-encoded.
// ---------------------------------------------------------------------------

/** The TUI exits with this code to ask the daemon for a fresh respawn. */
export const RELOAD_EXIT_CODE = 42;

export function attachSocketPathFor(session: string): string {
  return `${defaultSocketDir()}/${session}.attach.sock`;
}

export type AttachClientFrame =
  | { t: "hello"; cols: number; rows: number }
  | { t: "i"; d: string } // input bytes, base64
  | { t: "r"; cols: number; rows: number }
  | { t: "cmd"; cmd: "detach" | "kill" }
  // Profile switch: drop the clients and tell them where to reattach.
  // This session keeps running detached, like "detach" — only the clients move.
  | { t: "cmd"; cmd: "switch"; session: string };

export type AttachDaemonFrame =
  | { t: "o"; d: string } // output bytes, base64
  | { t: "bye"; reason: "detached" | "exit" | "killed" }
  // The client should reconnect to `session` (starting its daemon if needed).
  | { t: "bye"; reason: "switch"; session: string };
