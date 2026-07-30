/**
 * In-process control server. In phase 2 this (plus core/) becomes the daemon;
 * the protocol stays identical.
 */
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dbg } from "../core/debug";
import {
  closeSurface,
  focusedPaneId,
  focusTarget,
  forceRedraw,
  newTab,
  notifySurface,
  registry,
  reportStatus,
  selectTab,
  setSessionName,
  snapshot,
  splitPane,
  store,
} from "../core/state";
import { desktopNotify } from "../core/notify";
import { request } from "./client";
import {
  AGENT_STATUSES,
  sanitizeSessionName,
  socketPathFor,
  defaultSocketDir,
  type Request,
  type Response,
} from "./protocol";
import { SocketWriter } from "./sockbuf";
import type { AgentStatus, SessionSnapshot } from "../core/types";

function resolvePaneId(pane?: unknown): string {
  if (typeof pane === "string" && store.panes[pane]) return pane;
  return focusedPaneId();
}

function resolveSurfaceId(surface?: unknown): string | null {
  if (typeof surface === "string") {
    return store.surfaces[surface] ? surface : null;
  }
  const pane = store.panes[focusedPaneId()];
  return pane?.surfaceIds[pane.activeIdx] ?? null;
}

function dispatch(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "ping":
      return "pong";
    case "list":
      return snapshot();
    case "split": {
      const dir = params.dir === "down" ? "column" : "row";
      const paneId = splitPane(
        resolvePaneId(params.pane),
        dir,
        typeof params.command === "string" ? params.command : undefined,
        Array.isArray(params.args) ? (params.args as string[]) : undefined,
      );
      if (!paneId) throw new Error("split refused: pane too small");
      return { paneId };
    }
    case "new-tab": {
      const surfaceId = newTab(
        resolvePaneId(params.pane),
        typeof params.command === "string" ? params.command : undefined,
        Array.isArray(params.args) ? (params.args as string[]) : undefined,
      );
      if (!surfaceId) throw new Error("no such pane");
      return { surfaceId };
    }
    case "select-tab": {
      const index = Number(params.index);
      if (!Number.isInteger(index) || index < 0) throw new Error("bad index");
      selectTab(resolvePaneId(params.pane), index);
      return true;
    }
    case "close-tab": {
      const sid = resolveSurfaceId(params.surface);
      if (!sid) throw new Error("no such surface");
      closeSurface(sid);
      return true;
    }
    case "send-text": {
      const sid = resolveSurfaceId(params.surface);
      if (!sid) throw new Error("no such surface");
      if (typeof params.text !== "string") throw new Error("text required");
      registry.get(sid)?.write(params.text);
      return true;
    }
    case "read-screen": {
      const sid = resolveSurfaceId(params.surface);
      if (!sid) throw new Error("no such surface");
      return { text: registry.get(sid)?.screenText() ?? "" };
    }
    case "report": {
      const sid = resolveSurfaceId(params.surface);
      if (!sid) throw new Error("no such surface");
      const status = params.status as AgentStatus;
      if (!AGENT_STATUSES.includes(status)) throw new Error("bad status");
      const message = typeof params.message === "string" ? params.message : undefined;
      if (!reportStatus(sid, status, message)) throw new Error("report failed");
      return true;
    }
    case "focus": {
      const ok = focusTarget({
        surface: typeof params.surface === "string" ? params.surface : undefined,
        pane: typeof params.pane === "string" ? params.pane : undefined,
        workspace: typeof params.workspace === "string" ? params.workspace : undefined,
      });
      if (!ok) throw new Error("no such surface, pane or workspace");
      // The click that got here came from outside the input loop, and may have
      // arrived while a detached client was away.
      forceRedraw();
      return true;
    }
    case "redraw":
      forceRedraw();
      return true;
    case "set-session": {
      const name = sanitizeSessionName(String(params.session ?? ""));
      if (!name) throw new Error("bad session name");
      if (name !== store.session) adoptSessionName(name);
      return true;
    }
    case "notify": {
      const body = typeof params.body === "string" ? params.body : "";
      const title = typeof params.title === "string" ? params.title : undefined;
      // Sent from a surface (the usual case: a script in a pane), so it gets
      // the same context and the same click-to-jump as an agent's own.
      const sid = resolveSurfaceId(params.surface);
      if (sid) notifySurface(sid, "custom", { title, body });
      else desktopNotify({ key: `manual-${title ?? ""}`, title: title ?? "ghosttown", body });
      return true;
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

/**
 * The daemon renamed this profile (see attach/daemon.ts). Start listening on
 * the new name's control socket so `gt --session <new>` reaches us, and *keep*
 * the old listener: every surface spawned before the rename has the old path
 * in its GHOSTTOWN_SOCKET, and `gt report` from an agent in one of them has to
 * keep working. Both paths lead here; only the new one is handed to surfaces
 * spawned from now on.
 */
function adoptSessionName(name: string): void {
  const path = socketPathFor(name);
  let listening = false;
  for (const attempt of [0, 1]) {
    try {
      // Second pass: a leftover file from a session that used this name before.
      if (attempt === 1 && existsSync(path)) unlinkSync(path);
      startControlServer(path);
      listening = true;
      break;
    } catch (err) {
      dbg("set-session: cannot listen on", path, err as Error);
    }
  }
  // Without a listener the name still changes (it is the daemon's now), but
  // new surfaces keep the socket we can actually be reached on.
  setSessionName(name, listening ? path : undefined);
}

/**
 * Ensure the socket dir exists and the path is free (or stale → removed).
 *
 * Retried, because a restarting TUI (prefix+R, or a `bun --watch` reload) can
 * start before the socket of the instance it replaces has closed — and giving
 * up there would take the whole session down over a few milliseconds.
 */
export async function prepareSocketPath(session: string, tries = 4): Promise<string> {
  for (let i = 1; ; i++) {
    try {
      return await claimSocketPath(session);
    } catch (err) {
      if (i >= tries) throw err;
      dbg("control socket busy, retrying", i);
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

/** Which session answers on this control socket, or null if nothing does. */
async function sessionAtSocket(path: string): Promise<string | null> {
  try {
    const snap = (await request(path, "list", {}, 1500)) as SessionSnapshot;
    return typeof snap?.session === "string" ? snap.session : null;
  } catch {
    return null; // dead file, or nobody listening
  }
}

async function claimSocketPath(session: string): Promise<string> {
  const dir = defaultSocketDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = socketPathFor(session);
  if (existsSync(path)) {
    const owner = await sessionAtSocket(path);
    // A live socket answering to a *different* name is a renamed profile still
    // serving the surfaces it spawned under this one (see adoptSessionName).
    // The name belongs to us now; its own new path is where it lives.
    if (owner === session) {
      throw new Error(
        `session "${session}" is already running (${path}). Use --session <name> for a second one.`,
      );
    }
    if (owner) dbg("taking over socket left by renamed session", owner, path);
    unlinkSync(path);
  }
  return path;
}

export function startControlServer(socketPath: string): void {
  dbg("control server listening", socketPath);
  Bun.listen<{ inbuf: string; out: SocketWriter }>({
    unix: socketPath,
    socket: {
      data(socket, data) {
        dbg("server data", data.toString().slice(0, 200));
        const buffered = socket.data.inbuf + data.toString();
        const lines = buffered.split("\n");
        socket.data.inbuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let response: Response;
          let id = 0;
          try {
            const req = JSON.parse(line) as Request;
            id = req.id ?? 0;
            const result = dispatch(req.method, req.params ?? {});
            response = { id, ok: true, result };
          } catch (err) {
            response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          socket.data.out.write(JSON.stringify(response) + "\n");
        }
      },
      open(socket) {
        socket.data = { inbuf: "", out: new SocketWriter(socket) };
      },
      drain(socket) {
        socket.data.out.flush();
      },
      error() {},
      close() {},
    },
  });
}
