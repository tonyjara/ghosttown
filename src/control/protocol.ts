/**
 * Control protocol: newline-delimited JSON over a Unix socket.
 * This protocol is the stable seam for the phase-2 daemon/client split —
 * keep it additive.
 */
import type { MouseModes } from "../core/mouse";
import type { PersistedSession } from "../core/persist";
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
  /** `message` is the reporter's own words, used as the notification body. */
  report: { params: { surface?: string; status: AgentStatus; message?: string }; result: true };
  notify: { params: { title?: string; body: string; surface?: string }; result: true };
  /** Bring a surface (or pane, or workspace) on screen — see `gt focus`. */
  focus: {
    params: { surface?: string; pane?: string; workspace?: string };
    result: true;
  };
  /** Force a full (non-diffed) repaint; the daemon calls this on reattach. */
  redraw: { params: Record<string, never>; result: true };
  /** The daemon renamed this profile; adopt the new name (see server.ts). */
  "set-session": { params: { session: string }; result: true };
}

export const AGENT_STATUSES: AgentStatus[] = ["idle", "working", "blocked", "done"];

/**
 * Where every socket of every profile lives — so it is also the list of
 * profiles (see listProfiles). `GHOSTTOWN_SOCKET_DIR` moves the whole set
 * somewhere else, which is what keeps the e2e harness out of the sessions the
 * developer is actually using.
 */
export function defaultSocketDir(): string {
  if (process.env.GHOSTTOWN_SOCKET_DIR) return process.env.GHOSTTOWN_SOCKET_DIR;
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return `/tmp/ghosttown-${uid}`;
}

export function socketPathFor(session: string): string {
  return `${defaultSocketDir()}/${session}.sock`;
}

/**
 * Profile names become socket and snapshot filenames, so they are restricted to
 * a path-safe alphabet. Applied wherever a name arrives from outside (the
 * new-profile / rename-profile dialogs, an attach frame).
 */
export function sanitizeSessionName(name: string): string {
  return name
    .trim()
    .replace(/[^\w.-]/g, "")
    .slice(0, 32);
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
  | { t: "cmd"; cmd: "switch"; session: string }
  // Rename this profile in place: the daemon moves its sockets and snapshot to
  // the new name and tells its TUI to adopt it. Nothing running is disturbed.
  | { t: "cmd"; cmd: "rename"; session: string };

export type AttachDaemonFrame =
  | { t: "o"; d: string } // output bytes, base64
  | { t: "bye"; reason: "detached" | "exit" | "killed" }
  // The client should reconnect to `session` (starting its daemon if needed).
  | { t: "bye"; reason: "switch"; session: string };

// ---------------------------------------------------------------------------
// Pty host protocol. The surface PTYs (shells, agents) belong to the daemon,
// not to the TUI — that is what lets the TUI be restarted (prefix+R, or a
// `bun --watch` reload) without killing what is running inside it. The TUI is
// a client here: it spawns surfaces, streams their output, and sends input.
//
// Byte payloads (`d`) are base64. Frames are newline-delimited JSON, same as
// everything else, and the transport is either a unix socket (daemon) or a
// direct in-process pipe (GHOSTTOWN_NO_DAEMON=1).
// ---------------------------------------------------------------------------

export function hostSocketPathFor(session: string): string {
  return `${defaultSocketDir()}/${session}.host.sock`;
}

/** What the host knows about a surface, handed to a (re)starting TUI. */
export interface HostSurfaceInfo {
  id: string;
  title: string;
  /** The user's tab name, kept host-side so a rename survives a TUI restart. */
  titleOverride: string | null;
  command: string;
  status: AgentStatus;
  hasReporter: boolean;
  /** Kept host-side so the sidebar's agent list survives a TUI restart. */
  everActive: boolean;
  lastActiveAt: number | null;
  /** Agent program the host's process poll sees here now (core/procs.ts). */
  agent: string | null;
  /** True once an agent has ever been seen here — also survives a restart. */
  everAgent: boolean;
  /** The program is gone; the TUI should close the tab rather than adopt it. */
  exited: boolean;
}

export type HostClientFrame =
  /** First frame. `persist` mirrors [general] restore_session. */
  | { t: "hello"; persist: boolean }
  | {
      t: "spawn";
      id: string;
      command: string;
      args: string[];
      cwd: string;
      /**
       * "Start where this surface is." Resolved host-side, because only the host
       * has the pid whose cwd to read; `cwd` above is the fallback.
       */
      cwdFrom?: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
    }
  /** "Replay this surface from the top, then stream": sent on every attach. */
  | { t: "sub"; id: string }
  | { t: "w"; id: string; d: string } // input; counts as user activity
  | { t: "m"; id: string; d: string } // mouse report; deliberately does not
  | { t: "resize"; id: string; cols: number; rows: number }
  | { t: "kill"; id: string }
  | { t: "report"; id: string; status: AgentStatus }
  /** The user named this tab (null clears it, back to the program's title). */
  | { t: "rename"; id: string; title: string | null }
  /** Answer to a cpr-req: the emulator's live cursor, 0-based. */
  | { t: "cpr"; id: string; seq: number; x: number; y: number }
  /** Layout structure to persist (the host fills in the cwds). */
  | { t: "layout"; data: PersistedSession }
  /** Explicit quit: kill every surface and drop the snapshot. */
  | { t: "quit" };

export type HostServerFrame =
  | { t: "boot"; surfaces: HostSurfaceInfo[]; layout: PersistedSession | null }
  /** Replay buffer of a subscribed surface; feed before any further "o". */
  | { t: "snap"; id: string; d: string }
  | { t: "o"; id: string; d: string }
  | { t: "exit"; id: string; code: number }
  | { t: "status"; id: string; status: AgentStatus; hasReporter: boolean }
  /** An agent program started or stopped in this surface. `pid` is 0 for none. */
  | { t: "agent"; id: string; agent: string | null; pid: number }
  | { t: "title"; id: string; title: string }
  | { t: "notify"; id: string; title: string; body: string }
  | { t: "modes"; id: string; modes: MouseModes }
  /** The program asked where the cursor is; only the TUI's emulator knows. */
  | { t: "cpr-req"; id: string; seq: number };
