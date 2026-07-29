/**
 * The reactive session state (Solid store) and every action that mutates it.
 * UI components read from here; the control server calls the same actions.
 * Core rule: this module never imports from src/ui.
 */
import { createStore, produce } from "solid-js/store";
import { dbg } from "./debug";
import { computeRects, leaf, neighbor, removeLeaf, splitLeaf, collectPaneIds } from "./layout";
import { desktopNotify } from "./notify";
import { RuntimeRegistry, SurfaceRuntime } from "./runtime";
import type {
  AgentStatus,
  LayoutNode,
  PaneState,
  Rect,
  SessionSnapshot,
  SplitDir,
  SurfaceMeta,
} from "./types";

interface StoreShape {
  session: string;
  layout: LayoutNode | null;
  panes: Record<string, PaneState>;
  surfaces: Record<string, SurfaceMeta>;
  focusedPaneId: string;
  /** Area available to panes (terminal minus the status bar row). */
  area: Rect;
  prefixArmed: boolean;
}

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}${++idCounter}`;

export const registry = new RuntimeRegistry();

export const [store, setStore] = createStore<StoreShape>({
  session: "main",
  layout: null,
  panes: {},
  surfaces: {},
  focusedPaneId: "",
  area: { x: 0, y: 0, width: 80, height: 23 },
  prefixArmed: false,
});

let socketPath = "";
let onQuit: () => void = () => process.exit(0);
let tickTimer: ReturnType<typeof setInterval> | null = null;

export function currentRects(): Map<string, Rect> {
  const out = new Map<string, Rect>();
  if (store.layout) computeRects(store.layout, store.area, out);
  return out;
}

function surfaceEnv(paneId: string, surfaceId: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env["TERM"] = "xterm-256color";
  env["COLORTERM"] = "truecolor";
  env["GHOSTTOWN_SESSION"] = store.session;
  env["GHOSTTOWN_SOCKET"] = socketPath;
  env["GHOSTTOWN_PANE_ID"] = paneId;
  env["GHOSTTOWN_SURFACE_ID"] = surfaceId;
  return env;
}

function isVisibleActive(surfaceId: string): boolean {
  const meta = store.surfaces[surfaceId];
  if (!meta) return false;
  for (const pane of Object.values(store.panes)) {
    const idx = pane.surfaceIds.indexOf(surfaceId);
    if (idx === -1) continue;
    return idx === pane.activeIdx && pane.id === store.focusedPaneId;
  }
  return false;
}

function applyStatus(surfaceId: string, status: AgentStatus): void {
  const meta = store.surfaces[surfaceId];
  if (!meta) return;
  setStore(
    produce((s) => {
      const m = s.surfaces[surfaceId];
      if (!m) return;
      m.status = status;
      if ((status === "done" || status === "blocked") && !isVisibleActive(surfaceId)) {
        m.unread = true;
      }
    }),
  );
  if (status === "done" || status === "blocked") {
    if (!isVisibleActive(surfaceId)) {
      const title = store.surfaces[surfaceId]?.title || "agent";
      desktopNotify(
        surfaceId,
        `ghosttown · ${title}`,
        status === "done" ? "finished working" : "needs your attention",
      );
    }
  }
}

function spawnSurface(paneId: string, command?: string, args: string[] = []): string {
  const surfaceId = nextId("s");
  const cmd = command ?? process.env.SHELL ?? "/bin/zsh";
  const rects = currentRects();
  const rect = rects.get(paneId) ?? store.area;

  const meta: SurfaceMeta = {
    id: surfaceId,
    title: cmd.split("/").pop() ?? cmd,
    command: cmd,
    status: "idle",
    unread: false,
    hasReporter: false,
    exited: false,
  };
  setStore(
    produce((s) => {
      s.surfaces[surfaceId] = meta;
    }),
  );

  const rt = new SurfaceRuntime(
    surfaceId,
    {
      command: cmd,
      args,
      cwd: process.cwd(),
      env: surfaceEnv(paneId, surfaceId),
      cols: rect.width,
      rows: rect.height - 1,
    },
    {
      onTitle: (title) => {
        if (title.trim()) {
          setStore(
            produce((s) => {
              const m = s.surfaces[surfaceId];
              if (m) m.title = title.trim().slice(0, 60);
            }),
          );
        }
      },
      onOscNotify: (title, body) => {
        desktopNotify(
          surfaceId,
          title ? `ghosttown · ${title}` : "ghosttown",
          body || "notification",
        );
        applyStatus(surfaceId, "blocked");
      },
      onStatusChange: (status) => applyStatus(surfaceId, status),
      onExit: () => closeSurface(surfaceId),
    },
  );
  registry.add(rt);
  return surfaceId;
}

export function initSession(opts: {
  session: string;
  socketPath: string;
  quit: () => void;
  command?: string;
  args?: string[];
}): void {
  socketPath = opts.socketPath;
  onQuit = opts.quit;
  const paneId = nextId("p");
  setStore(
    produce((s) => {
      s.session = opts.session;
      s.panes[paneId] = { id: paneId, surfaceIds: [], activeIdx: 0 };
      s.layout = leaf(paneId);
      s.focusedPaneId = paneId;
    }),
  );
  const surfaceId = spawnSurface(paneId, opts.command, opts.args ?? []);
  setStore(
    produce((s) => {
      s.panes[paneId]!.surfaceIds.push(surfaceId);
    }),
  );
  tickTimer = setInterval(() => {
    for (const rt of registry.all()) rt.tracker.tick();
  }, 500);
}

export function setArea(width: number, height: number): void {
  setStore("area", { x: 0, y: 0, width, height: Math.max(3, height - 1) });
  syncSizes();
}

export function syncSizes(): void {
  const rects = currentRects();
  for (const [paneId, rect] of rects) {
    const pane = store.panes[paneId];
    if (!pane) continue;
    for (const sid of pane.surfaceIds) {
      registry.get(sid)?.resize(rect.width, rect.height - 1);
    }
  }
}

export function splitPane(paneId: string, dir: SplitDir, command?: string, args?: string[]): string | null {
  dbg("splitPane", { paneId, dir, hasLayout: !!store.layout, hasPane: !!store.panes[paneId] });
  if (!store.layout || !store.panes[paneId]) return null;
  const rect = currentRects().get(paneId);
  // Refuse splits that would produce unusably small panes.
  if (rect && (dir === "row" ? rect.width < 20 : rect.height < 8)) return null;

  const newPaneId = nextId("p");
  setStore(
    produce((s) => {
      s.panes[newPaneId] = { id: newPaneId, surfaceIds: [], activeIdx: 0 };
      s.layout = splitLeaf(s.layout!, paneId, newPaneId, dir);
      s.focusedPaneId = newPaneId;
    }),
  );
  const surfaceId = spawnSurface(newPaneId, command, args ?? []);
  setStore(
    produce((s) => {
      s.panes[newPaneId]!.surfaceIds.push(surfaceId);
    }),
  );
  syncSizes();
  return newPaneId;
}

export function newTab(paneId: string, command?: string, args?: string[]): string | null {
  const pane = store.panes[paneId];
  if (!pane) return null;
  const surfaceId = spawnSurface(paneId, command, args ?? []);
  setStore(
    produce((s) => {
      const p = s.panes[paneId]!;
      p.surfaceIds.push(surfaceId);
      p.activeIdx = p.surfaceIds.length - 1;
    }),
  );
  clearUnread(surfaceId);
  return surfaceId;
}

export function selectTab(paneId: string, idx: number): void {
  const pane = store.panes[paneId];
  if (!pane || idx < 0 || idx >= pane.surfaceIds.length) return;
  setStore(
    produce((s) => {
      s.panes[paneId]!.activeIdx = idx;
    }),
  );
  clearUnread(pane.surfaceIds[idx]!);
}

export function cycleTab(paneId: string, delta: number): void {
  const pane = store.panes[paneId];
  if (!pane || pane.surfaceIds.length < 2) return;
  const idx = (pane.activeIdx + delta + pane.surfaceIds.length) % pane.surfaceIds.length;
  selectTab(paneId, idx);
}

export function focusPane(paneId: string): void {
  if (!store.panes[paneId]) return;
  setStore("focusedPaneId", paneId);
  const pane = store.panes[paneId]!;
  const active = pane.surfaceIds[pane.activeIdx];
  if (active) clearUnread(active);
}

export function focusDirection(dir: "left" | "right" | "up" | "down"): void {
  const target = neighbor(currentRects(), store.focusedPaneId, dir);
  if (target) focusPane(target);
}

function clearUnread(surfaceId: string): void {
  setStore(
    produce((s) => {
      const m = s.surfaces[surfaceId];
      if (m) {
        m.unread = false;
        if (m.status === "done") m.status = "idle";
      }
    }),
  );
}

export function closeSurface(surfaceId: string): void {
  registry.remove(surfaceId);
  let emptyPaneId: string | null = null;
  setStore(
    produce((s) => {
      delete s.surfaces[surfaceId];
      for (const pane of Object.values(s.panes)) {
        const idx = pane.surfaceIds.indexOf(surfaceId);
        if (idx === -1) continue;
        pane.surfaceIds.splice(idx, 1);
        pane.activeIdx = Math.min(pane.activeIdx, Math.max(0, pane.surfaceIds.length - 1));
        if (pane.surfaceIds.length === 0) emptyPaneId = pane.id;
        break;
      }
    }),
  );
  if (emptyPaneId) closePane(emptyPaneId);
}

function closePane(paneId: string): void {
  setStore(
    produce((s) => {
      if (!s.layout) return;
      s.layout = removeLeaf(s.layout, paneId);
      delete s.panes[paneId];
      if (s.focusedPaneId === paneId && s.layout) {
        s.focusedPaneId = collectPaneIds(s.layout)[0] ?? "";
      }
    }),
  );
  if (!store.layout) {
    quit();
    return;
  }
  syncSizes();
  const pane = store.panes[store.focusedPaneId];
  const active = pane?.surfaceIds[pane.activeIdx];
  if (active) clearUnread(active);
}

export function closeActiveTab(): void {
  const pane = store.panes[store.focusedPaneId];
  const active = pane?.surfaceIds[pane.activeIdx];
  if (active) closeSurface(active);
}

export function focusedRuntime(): SurfaceRuntime | undefined {
  const pane = store.panes[store.focusedPaneId];
  const active = pane?.surfaceIds[pane.activeIdx];
  return active ? registry.get(active) : undefined;
}

export function writeToFocused(data: string): void {
  focusedRuntime()?.write(data);
}

export function setPrefixArmed(armed: boolean): void {
  setStore("prefixArmed", armed);
}

/** Explicit status report from `gt report` (authoritative). */
export function reportStatus(surfaceId: string, status: AgentStatus): boolean {
  const rt = registry.get(surfaceId);
  if (!rt || !store.surfaces[surfaceId]) return false;
  setStore(
    produce((s) => {
      s.surfaces[surfaceId]!.hasReporter = true;
    }),
  );
  rt.tracker.report(status);
  return true;
}

export function snapshot(): SessionSnapshot {
  const rects = currentRects();
  return {
    session: store.session,
    focusedPaneId: store.focusedPaneId,
    panes: Object.values(store.panes).map((pane) => ({
      id: pane.id,
      rect: rects.get(pane.id) ?? { x: 0, y: 0, width: 0, height: 0 },
      focused: pane.id === store.focusedPaneId,
      surfaces: pane.surfaceIds.map((sid, idx) => {
        const m = store.surfaces[sid]!;
        return {
          id: m.id,
          title: m.title,
          command: m.command,
          status: m.status,
          unread: m.unread,
          active: idx === pane.activeIdx,
        };
      }),
    })),
  };
}

export function quit(): void {
  if (tickTimer) clearInterval(tickTimer);
  registry.disposeAll();
  onQuit();
}
