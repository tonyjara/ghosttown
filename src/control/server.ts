/**
 * In-process control server. In phase 2 this (plus core/) becomes the daemon;
 * the protocol stays identical.
 */
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dbg } from "../core/debug";
import {
  closeSurface,
  focusedPaneId,
  forceRedraw,
  newTab,
  registry,
  reportStatus,
  selectTab,
  snapshot,
  splitPane,
  store,
} from "../core/state";
import { desktopNotify } from "../core/notify";
import { AGENT_STATUSES, socketPathFor, defaultSocketDir, type Request, type Response } from "./protocol";
import { SocketWriter } from "./sockbuf";
import type { AgentStatus } from "../core/types";

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
      if (!reportStatus(sid, status)) throw new Error("report failed");
      return true;
    }
    case "redraw":
      forceRedraw();
      return true;
    case "notify": {
      const body = typeof params.body === "string" ? params.body : "";
      const title = typeof params.title === "string" ? params.title : "ghosttown";
      desktopNotify(`manual-${title}`, title, body);
      return true;
    }
    default:
      throw new Error(`unknown method: ${method}`);
  }
}

/** Ensure the socket dir exists and the path is free (or stale → removed). */
export async function prepareSocketPath(session: string): Promise<string> {
  const dir = defaultSocketDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = socketPathFor(session);
  if (existsSync(path)) {
    const alive = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 300);
      Bun.connect({
        unix: path,
        socket: {
          open(s) {
            clearTimeout(timer);
            s.end();
            resolve(true);
          },
          data() {},
          error() {
            clearTimeout(timer);
            resolve(false);
          },
          close() {},
        },
      }).catch(() => {
        clearTimeout(timer);
        resolve(false);
      });
    });
    if (alive) {
      throw new Error(
        `session "${session}" is already running (${path}). Use --session <name> for a second one.`,
      );
    }
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
