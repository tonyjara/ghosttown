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
}

export const AGENT_STATUSES: AgentStatus[] = ["idle", "working", "blocked", "done"];

export function defaultSocketDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/tmp/ghosttown-${uid}`;
}

export function socketPathFor(session: string): string {
  return `${defaultSocketDir()}/${session}.sock`;
}
