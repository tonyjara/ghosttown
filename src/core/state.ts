/**
 * The reactive session state (Solid store) and every action that mutates it.
 * UI components read from here; the control server calls the same actions.
 * Core rule: this module never imports from src/ui.
 *
 * Hierarchy: profile (= the session) → workspaces → panes → tabs (surfaces).
 * Every workspace's panes stay mounted in the UI (a persistent emulator dies
 * with its renderable); only the active workspace is visible.
 */
import { createStore, produce } from "solid-js/store";
import { existsSync, readdirSync } from "node:fs";
import { defaultSocketDir, RELOAD_EXIT_CODE } from "../control/protocol";
import { loadConfig, setConfigForTest } from "./config";
import { dbg } from "./debug";
import {
  collectGutters,
  collectPaneIds,
  computeRects,
  findResizeTarget,
  leaf,
  minSize,
  neighbor,
  removeLeaf,
  splitAtPath,
  splitLeaf,
  type Gutter,
} from "./layout";
import { desktopNotify } from "./notify";
import {
  deleteSnapshot,
  readCwds,
  readCwdsAsync,
  readSnapshot,
  writeSnapshot,
  SNAPSHOT_VERSION,
  type PersistedSession,
} from "./persist";
import { RuntimeRegistry, SurfaceRuntime } from "./runtime";
import type {
  AgentStatus,
  LayoutNode,
  PaneState,
  Rect,
  SessionSnapshot,
  SplitDir,
  SurfaceMeta,
  WorkspaceState,
} from "./types";

export type SidebarSection = "workspaces" | "agents";

export type DialogState =
  | { kind: "confirm-delete-workspace"; workspaceId: string }
  | { kind: "rename-workspace"; workspaceId: string; value: string }
  | { kind: "switch-profile"; sessions: string[]; idx: number }
  | { kind: "new-profile"; value: string };

interface SidebarState {
  visible: boolean;
  /** The sidebar receives keys instead of the focused pane. */
  focused: boolean;
  section: SidebarSection;
  workspaceIdx: number;
  agentIdx: number;
}

interface StoreShape {
  /** Profile name — also the session identity on the control socket. */
  session: string;
  workspaces: Record<string, WorkspaceState>;
  workspaceOrder: string[];
  activeWorkspaceId: string;
  panes: Record<string, PaneState>;
  surfaces: Record<string, SurfaceMeta>;
  /** Full terminal size; pane area is derived via paneArea(). */
  screen: { width: number; height: number };
  prefixArmed: boolean;
  /** Prefix+r toggles this; h/j/k/l then move dividers until esc/enter. */
  resizeMode: boolean;
  helpVisible: boolean;
  sidebar: SidebarState;
  dialog: DialogState | null;
}

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}${++idCounter}`;
let workspaceNameCounter = 0;

export const registry = new RuntimeRegistry();

export const [store, setStore] = createStore<StoreShape>({
  session: "main",
  workspaces: {},
  workspaceOrder: [],
  activeWorkspaceId: "",
  panes: {},
  surfaces: {},
  screen: { width: 80, height: 24 },
  prefixArmed: false,
  resizeMode: false,
  helpVisible: false,
  sidebar: {
    visible: true,
    focused: false,
    section: "workspaces",
    workspaceIdx: 0,
    agentIdx: 0,
  },
  dialog: null,
});

let socketPath = "";
let onQuit: (code: number) => void = (code) => process.exit(code);
let tickTimer: ReturnType<typeof setInterval> | null = null;

// ---------------------------------------------------------------------------
// Derived geometry & lookups
// ---------------------------------------------------------------------------

export function activeWorkspace(): WorkspaceState | undefined {
  return store.workspaces[store.activeWorkspaceId];
}

export function focusedPaneId(): string {
  return activeWorkspace()?.focusedPaneId ?? "";
}

export function workspaceOf(paneId: string): string | null {
  for (const wsId of store.workspaceOrder) {
    const ws = store.workspaces[wsId];
    if (ws?.layout && collectPaneIds(ws.layout).includes(paneId)) return wsId;
  }
  return null;
}

export function sidebarWidth(): number {
  const cfg = loadConfig().sidebar.width;
  return Math.min(cfg, Math.max(16, Math.floor(store.screen.width * 0.3)));
}

/** Area available to panes: terminal minus status bar row minus the sidebar. */
export function paneArea(): Rect {
  const sb = store.sidebar.visible ? sidebarWidth() : 0;
  return {
    x: sb,
    y: 0,
    width: Math.max(10, store.screen.width - sb),
    height: Math.max(3, store.screen.height - 1),
  };
}

/** Cells of spacing between panes ([appearance] pane_gap). */
export function paneGap(): number {
  const g = loadConfig().appearance?.pane_gap ?? 1;
  return Math.max(0, Math.min(4, Math.floor(g)));
}

export function workspaceRects(wsId: string): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const ws = store.workspaces[wsId];
  if (ws?.layout) computeRects(ws.layout, paneArea(), out, paneGap());
  return out;
}

/** Rects for the active workspace (directional focus operates here). */
export function currentRects(): Map<string, Rect> {
  return workspaceRects(store.activeWorkspaceId);
}

/** Rects for every workspace — all share the pane area, so sizes stay synced. */
export function allRects(): Map<string, Rect> {
  const out = new Map<string, Rect>();
  for (const wsId of store.workspaceOrder) {
    const ws = store.workspaces[wsId];
    if (ws?.layout) computeRects(ws.layout, paneArea(), out, paneGap());
  }
  return out;
}

/** Divider strips of the active workspace (mouse drag handles). */
export function activeGutters(): Gutter[] {
  const ws = activeWorkspace();
  if (!ws?.layout) return [];
  return collectGutters(ws.layout, paneArea(), paneGap());
}

/**
 * Surfaces that are (or ever were) agents: reporting, non-idle now, or
 * non-idle at any point in the past. Idle agents stay listed (with an idle
 * marker) so finished work remains reachable. Most recently active first.
 */
export function agentSurfaces(): SurfaceMeta[] {
  return Object.values(store.surfaces)
    .filter((m) => m.hasReporter || m.everActive || m.status !== "idle")
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0));
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

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
  const ws = activeWorkspace();
  if (!ws?.layout) return false;
  for (const paneId of collectPaneIds(ws.layout)) {
    const pane = store.panes[paneId];
    if (!pane) continue;
    const idx = pane.surfaceIds.indexOf(surfaceId);
    if (idx === -1) continue;
    return idx === pane.activeIdx && paneId === ws.focusedPaneId;
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
      if (status !== "idle") {
        m.everActive = true;
        m.lastActiveAt = Date.now();
      }
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

function spawnSurface(
  paneId: string,
  command?: string,
  args: string[] = [],
  cwd?: string,
): string {
  const surfaceId = nextId("s");
  const cmd = command || loadConfig().general.shell || process.env.SHELL || "/bin/zsh";
  const rect = allRects().get(paneId) ?? paneArea();

  const meta: SurfaceMeta = {
    id: surfaceId,
    title: cmd.split("/").pop() ?? cmd,
    command: cmd,
    status: "idle",
    unread: false,
    hasReporter: false,
    everActive: false,
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
      // A restored cwd may have been deleted since the snapshot.
      cwd: cwd && existsSync(cwd) ? cwd : process.cwd(),
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

// ---------------------------------------------------------------------------
// Session & workspaces
// ---------------------------------------------------------------------------

export function initSession(opts: {
  session: string;
  socketPath: string;
  quit: (code: number) => void;
  command?: string;
  args?: string[];
}): void {
  socketPath = opts.socketPath;
  onQuit = opts.quit;
  const config = loadConfig();
  setStore(
    produce((s) => {
      s.session = opts.session;
      s.sidebar.visible = config.sidebar.visible;
    }),
  );

  // An explicit `gt -- <command>` asks for that command, not for yesterday.
  persistEnabled = config.general.restore_session !== false;
  const snapshot = persistEnabled && !opts.command ? readSnapshot(opts.session) : null;
  if (!snapshot || !restoreSession(snapshot)) {
    createWorkspace({ command: opts.command, args: opts.args });
  }

  void saveSnapshot();
  saveInterval = setInterval(() => void saveSnapshot(), SAVE_INTERVAL_MS);
  tickTimer = setInterval(() => {
    for (const rt of registry.all()) rt.tracker.tick();
  }, 500);
}

// ---------------------------------------------------------------------------
// Persistence — see core/persist.ts for the why and the file format
// ---------------------------------------------------------------------------

/** Coalesces bursts (a drag emits a divider change per step). */
const SAVE_DEBOUNCE_MS = 750;
/** Continuum-style heartbeat, mostly to notice `cd`s nothing else reports. */
const SAVE_INTERVAL_MS = 30_000;

let persistEnabled = false;
let savingNow = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveInterval: ReturnType<typeof setInterval> | null = null;

function surfacePids(): Map<string, number> {
  const out = new Map<string, number>();
  for (const rt of registry.all()) out.set(rt.id, rt.pty.pid);
  return out;
}

function serializeSession(
  pidBySurface: Map<string, number>,
  cwds: Map<number, string>,
): PersistedSession {
  return {
    version: SNAPSHOT_VERSION,
    session: store.session,
    savedAt: Date.now(),
    activeWorkspaceId: store.activeWorkspaceId,
    sidebarVisible: store.sidebar.visible,
    workspaces: store.workspaceOrder.map((wsId) => {
      const ws = store.workspaces[wsId]!;
      const paneIds = ws.layout ? collectPaneIds(ws.layout) : [];
      return {
        id: ws.id,
        name: ws.name,
        // JSON round-trip: the store hands out proxies, not plain objects.
        layout: (ws.layout ? JSON.parse(JSON.stringify(ws.layout)) : null) as LayoutNode | null,
        focusedPaneId: ws.focusedPaneId,
        panes: paneIds.map((paneId) => {
          const pane = store.panes[paneId]!;
          return {
            id: paneId,
            activeIdx: pane.activeIdx,
            surfaces: pane.surfaceIds.map((sid) => ({
              cwd: cwds.get(pidBySurface.get(sid) ?? -1) ?? null,
            })),
          };
        }),
      };
    }),
  };
}

/**
 * Write the snapshot synchronously. Reserved for the way out (reload), where
 * an awaited read would never come back — reading cwds blocks ~40ms.
 */
export function saveSnapshotNow(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!persistEnabled || store.workspaceOrder.length === 0) return;
  const pids = surfacePids();
  writeSnapshot(serializeSession(pids, readCwds([...pids.values()])));
}

/** The normal path: nothing blocks the render loop while lsof runs. */
async function saveSnapshot(): Promise<void> {
  if (!persistEnabled || savingNow || store.workspaceOrder.length === 0) return;
  savingNow = true;
  try {
    const pids = surfacePids();
    const cwds = await readCwdsAsync([...pids.values()]);
    // The layout is read after the await, so it is whatever is on screen now.
    if (store.workspaceOrder.length > 0) writeSnapshot(serializeSession(pids, cwds));
  } finally {
    savingNow = false;
  }
}

/** Structural change: save soon, once the burst settles. */
function scheduleSave(): void {
  if (!persistEnabled) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveSnapshot();
  }, SAVE_DEBOUNCE_MS);
}

/** Restored ids are reused verbatim, so fresh ones must start above them. */
function bumpIdCounter(ids: string[]): void {
  for (const id of ids) {
    const n = Number(id.replace(/^\D+/, ""));
    if (Number.isFinite(n) && n > idCounter) idCounter = n;
  }
}

/**
 * Rebuild the session from a snapshot: layout, tab order and cwds come back,
 * every surface as a fresh shell. Returns false if nothing usable was in it,
 * leaving the caller to start a normal session.
 */
function restoreSession(snap: PersistedSession): boolean {
  const workspaces = snap.workspaces.filter((ws) => {
    if (!ws.layout || ws.panes.length === 0) return false;
    // The tree addresses panes by id — drop a workspace that disagrees with
    // its own pane list rather than rendering a layout full of holes.
    const known = new Set(ws.panes.map((p) => p.id));
    return collectPaneIds(ws.layout).every((id) => known.has(id));
  });
  if (workspaces.length === 0) return false;
  dbg("restore", { workspaces: workspaces.length, savedAt: snap.savedAt });

  bumpIdCounter([
    ...workspaces.map((ws) => ws.id),
    ...workspaces.flatMap((ws) => ws.panes.map((p) => p.id)),
  ]);
  // "workspace 3" stays workspace 3; the next new one continues from there.
  workspaceNameCounter = workspaces.length;

  const activeId = workspaces.some((ws) => ws.id === snap.activeWorkspaceId)
    ? snap.activeWorkspaceId
    : workspaces[0]!.id;

  setStore(
    produce((s) => {
      for (const ws of workspaces) {
        const paneIds = collectPaneIds(ws.layout!);
        s.workspaces[ws.id] = {
          id: ws.id,
          name: ws.name,
          layout: ws.layout,
          focusedPaneId: paneIds.includes(ws.focusedPaneId) ? ws.focusedPaneId : paneIds[0]!,
        };
        s.workspaceOrder.push(ws.id);
        for (const pane of ws.panes) {
          s.panes[pane.id] = { id: pane.id, surfaceIds: [], activeIdx: 0 };
        }
      }
      s.activeWorkspaceId = activeId;
      s.sidebar.visible = snap.sidebarVisible;
    }),
  );

  for (const ws of workspaces) {
    for (const pane of ws.panes) {
      // A pane always owns at least one surface, or it could never be closed.
      const surfaces = pane.surfaces.length > 0 ? pane.surfaces : [{ cwd: null }];
      for (const surface of surfaces) {
        const surfaceId = spawnSurface(pane.id, undefined, [], surface.cwd ?? undefined);
        setStore(
          produce((s) => {
            s.panes[pane.id]!.surfaceIds.push(surfaceId);
          }),
        );
      }
      setStore(
        produce((s) => {
          const p = s.panes[pane.id]!;
          p.activeIdx = Math.max(0, Math.min(pane.activeIdx, p.surfaceIds.length - 1));
        }),
      );
    }
  }
  syncSizes();
  return true;
}

/** Create a workspace with one pane + surface and switch to it. */
export function createWorkspace(opts: { name?: string; command?: string; args?: string[] } = {}): string {
  const wsId = nextId("w");
  const paneId = nextId("p");
  const name = opts.name ?? `workspace ${++workspaceNameCounter}`;
  setStore(
    produce((s) => {
      s.workspaces[wsId] = { id: wsId, name, layout: leaf(paneId), focusedPaneId: paneId };
      s.workspaceOrder.push(wsId);
      s.panes[paneId] = { id: paneId, surfaceIds: [], activeIdx: 0 };
      s.activeWorkspaceId = wsId;
      // A new workspace is made to be typed in — keys go to its terminal,
      // not to the sidebar that may have triggered this.
      s.sidebar.focused = false;
    }),
  );
  const surfaceId = spawnSurface(paneId, opts.command, opts.args ?? []);
  setStore(
    produce((s) => {
      s.panes[paneId]!.surfaceIds.push(surfaceId);
    }),
  );
  syncSizes();
  scheduleSave();
  return wsId;
}

export function switchWorkspace(wsId: string): void {
  if (!store.workspaces[wsId]) return;
  setStore("activeWorkspaceId", wsId);
  const ws = store.workspaces[wsId]!;
  const pane = store.panes[ws.focusedPaneId];
  const active = pane?.surfaceIds[pane.activeIdx];
  if (active) clearUnread(active);
  scheduleSave();
}

export function renameWorkspace(wsId: string, name: string): void {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed || !store.workspaces[wsId]) return;
  setStore("workspaces", wsId, "name", trimmed);
  scheduleSave();
}

/** Kill every surface in the workspace and remove it. Refuses on the last one. */
export function deleteWorkspace(wsId: string): boolean {
  const ws = store.workspaces[wsId];
  if (!ws || store.workspaceOrder.length <= 1) return false;
  const paneIds = ws.layout ? collectPaneIds(ws.layout) : [];
  const surfaceIds = paneIds.flatMap((pid) => store.panes[pid]?.surfaceIds ?? []);
  // dispose() sets the disposed flag, so pty onExit callbacks stay silent.
  for (const sid of surfaceIds) registry.remove(sid);
  setStore(
    produce((s) => {
      for (const sid of surfaceIds) delete s.surfaces[sid];
      for (const pid of paneIds) delete s.panes[pid];
      s.workspaces[wsId]!.layout = null;
    }),
  );
  removeEmptyWorkspace(wsId);
  return true;
}

function removeEmptyWorkspace(wsId: string): void {
  setStore(
    produce((s) => {
      const idx = s.workspaceOrder.indexOf(wsId);
      if (idx !== -1) s.workspaceOrder.splice(idx, 1);
      delete s.workspaces[wsId];
      if (s.activeWorkspaceId === wsId) {
        s.activeWorkspaceId =
          s.workspaceOrder[Math.min(idx, s.workspaceOrder.length - 1)] ?? "";
      }
      s.sidebar.workspaceIdx = Math.max(
        0,
        Math.min(s.sidebar.workspaceIdx, s.workspaceOrder.length - 1),
      );
    }),
  );
  if (store.workspaceOrder.length === 0) {
    quit();
    return;
  }
  syncSizes();
  scheduleSave();
}

// ---------------------------------------------------------------------------
// Geometry & panes
// ---------------------------------------------------------------------------

export function setArea(width: number, height: number): void {
  setStore("screen", { width, height });
  syncSizes();
}

export function syncSizes(): void {
  const rects = allRects();
  for (const [paneId, rect] of rects) {
    const pane = store.panes[paneId];
    if (!pane) continue;
    for (const sid of pane.surfaceIds) {
      registry.get(sid)?.resize(rect.width, rect.height - 1);
    }
  }
}

export function setResizeMode(active: boolean): void {
  setStore("resizeMode", active);
}

/** h/j/k/l steps in resize mode. Horizontal cells are ~half as wide as tall. */
const RESIZE_STEP_COLS = 2;
const RESIZE_STEP_ROWS = 1;

/** Move a split's divider to an absolute `a`-side size, clamped to minimums. */
function applyDivider(
  wsId: string,
  target: { path: string; dir: SplitDir; total: number },
  aw: number,
): void {
  const min = minSize(target.dir);
  if (target.total < 2 * min) return;
  const ratio = Math.max(min, Math.min(target.total - min, aw)) / target.total;
  setStore(
    produce((s) => {
      const layout = s.workspaces[wsId]?.layout;
      const split = layout ? splitAtPath(layout, target.path) : null;
      if (split) split.ratio = ratio;
    }),
  );
  syncSizes();
  scheduleSave();
}

/** Resize-mode step: move the focused pane's nearest divider on that axis. */
export function resizeFocused(dir: "left" | "right" | "up" | "down"): void {
  const ws = activeWorkspace();
  if (!ws?.layout) return;
  const axis: SplitDir = dir === "left" || dir === "right" ? "row" : "column";
  const target = findResizeTarget(ws.layout, paneArea(), paneGap(), ws.focusedPaneId, axis);
  if (!target) return;
  const step = axis === "row" ? RESIZE_STEP_COLS : RESIZE_STEP_ROWS;
  const delta = dir === "left" || dir === "up" ? -step : step;
  applyDivider(ws.id, target, target.aw + delta);
}

/** Mouse drag on a gutter: put the divider at the pointer's cell. */
export function dragDivider(gutter: Gutter, pointer: number): void {
  applyDivider(store.activeWorkspaceId, gutter, pointer - gutter.start);
}

export function splitPane(paneId: string, dir: SplitDir, command?: string, args?: string[]): string | null {
  const wsId = workspaceOf(paneId);
  dbg("splitPane", { paneId, dir, wsId, hasPane: !!store.panes[paneId] });
  if (!wsId || !store.panes[paneId]) return null;
  const rect = workspaceRects(wsId).get(paneId);
  // Refuse splits that would produce unusably small panes.
  if (rect && (dir === "row" ? rect.width < 20 : rect.height < 8)) return null;

  const newPaneId = nextId("p");
  setStore(
    produce((s) => {
      s.panes[newPaneId] = { id: newPaneId, surfaceIds: [], activeIdx: 0 };
      const ws = s.workspaces[wsId]!;
      ws.layout = splitLeaf(ws.layout!, paneId, newPaneId, dir);
      ws.focusedPaneId = newPaneId;
    }),
  );
  const surfaceId = spawnSurface(newPaneId, command, args ?? []);
  setStore(
    produce((s) => {
      s.panes[newPaneId]!.surfaceIds.push(surfaceId);
    }),
  );
  syncSizes();
  scheduleSave();
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
  scheduleSave();
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
  scheduleSave();
}

export function cycleTab(paneId: string, delta: number): void {
  const pane = store.panes[paneId];
  if (!pane || pane.surfaceIds.length < 2) return;
  const idx = (pane.activeIdx + delta + pane.surfaceIds.length) % pane.surfaceIds.length;
  selectTab(paneId, idx);
}

/** Focus a pane; switches to its workspace and takes focus off the sidebar. */
export function focusPane(paneId: string): void {
  const wsId = workspaceOf(paneId);
  if (!wsId) return;
  setStore(
    produce((s) => {
      s.activeWorkspaceId = wsId;
      s.workspaces[wsId]!.focusedPaneId = paneId;
      s.sidebar.focused = false;
    }),
  );
  const pane = store.panes[paneId]!;
  const active = pane.surfaceIds[pane.activeIdx];
  if (active) clearUnread(active);
  scheduleSave();
}

/**
 * Bring a surface on screen: its workspace active, its pane current, its tab
 * selected. `focus` also hands the keys to that pane (taking them off the
 * sidebar); without it the sidebar keeps focus and only the view moves.
 */
function revealSurface(surfaceId: string, focus: boolean): void {
  for (const pane of Object.values(store.panes)) {
    const idx = pane.surfaceIds.indexOf(surfaceId);
    if (idx === -1) continue;
    const wsId = workspaceOf(pane.id);
    if (!wsId) return;
    setStore(
      produce((s) => {
        s.panes[pane.id]!.activeIdx = idx;
        s.activeWorkspaceId = wsId;
        s.workspaces[wsId]!.focusedPaneId = pane.id;
        if (focus) s.sidebar.focused = false;
      }),
    );
    clearUnread(surfaceId);
    scheduleSave();
    return;
  }
}

/** Switch workspace + focus the pane holding this surface, on its tab. */
export function focusSurface(surfaceId: string): void {
  revealSurface(surfaceId, true);
}

export function focusDirection(dir: "left" | "right" | "up" | "down"): void {
  if (store.sidebar.focused) {
    if (dir === "right") blurSidebar();
    return;
  }
  const target = neighbor(currentRects(), focusedPaneId(), dir);
  if (target) {
    focusPane(target);
    return;
  }
  // No pane in that direction: left of the leftmost pane sits the sidebar.
  if (dir === "left" && store.sidebar.visible) focusSidebar();
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
  else scheduleSave();
}

function closePane(paneId: string): void {
  const wsId = workspaceOf(paneId);
  if (!wsId) return;
  let workspaceEmptied = false;
  setStore(
    produce((s) => {
      const ws = s.workspaces[wsId]!;
      if (!ws.layout) return;
      ws.layout = removeLeaf(ws.layout, paneId);
      delete s.panes[paneId];
      if (!ws.layout) {
        workspaceEmptied = true;
        return;
      }
      if (ws.focusedPaneId === paneId) {
        ws.focusedPaneId = collectPaneIds(ws.layout)[0] ?? "";
      }
    }),
  );
  if (workspaceEmptied) {
    removeEmptyWorkspace(wsId);
    return;
  }
  syncSizes();
  scheduleSave();
  const ws = store.workspaces[wsId]!;
  const pane = store.panes[ws.focusedPaneId];
  const active = pane?.surfaceIds[pane.activeIdx];
  if (active && wsId === store.activeWorkspaceId) clearUnread(active);
}

export function closeActiveTab(): void {
  const pane = store.panes[focusedPaneId()];
  const active = pane?.surfaceIds[pane.activeIdx];
  if (active) closeSurface(active);
}

export function focusedRuntime(): SurfaceRuntime | undefined {
  const pane = store.panes[focusedPaneId()];
  const active = pane?.surfaceIds[pane.activeIdx];
  return active ? registry.get(active) : undefined;
}

export function writeToFocused(data: string): void {
  focusedRuntime()?.write(data);
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function toggleSidebar(): void {
  setStore(
    produce((s) => {
      s.sidebar.visible = !s.sidebar.visible;
      if (!s.sidebar.visible) s.sidebar.focused = false;
    }),
  );
  syncSizes();
  scheduleSave();
}

export function focusSidebar(): void {
  if (!store.sidebar.visible) return;
  setStore(
    produce((s) => {
      s.sidebar.focused = true;
      if (s.sidebar.section === "workspaces") {
        const idx = s.workspaceOrder.indexOf(s.activeWorkspaceId);
        if (idx !== -1) s.sidebar.workspaceIdx = idx;
      }
    }),
  );
}

export function blurSidebar(): void {
  setStore("sidebar", "focused", false);
}

/** j/k: move within a half; walking past the edge crosses into the other half. */
export function sidebarMove(delta: 1 | -1): void {
  const wsCount = store.workspaceOrder.length;
  const agentCount = agentSurfaces().length;
  setStore(
    produce((s) => {
      const sb = s.sidebar;
      if (sb.section === "workspaces") {
        const next = sb.workspaceIdx + delta;
        if (next >= wsCount) {
          if (agentCount > 0) {
            sb.section = "agents";
            sb.agentIdx = 0;
          }
        } else if (next >= 0) {
          sb.workspaceIdx = next;
        }
      } else {
        const next = sb.agentIdx + delta;
        if (next < 0) {
          sb.section = "workspaces";
          sb.workspaceIdx = Math.max(0, wsCount - 1);
        } else if (next < agentCount) {
          sb.agentIdx = next;
        }
      }
    }),
  );
}

/** Enter: open the selected workspace, or jump to the selected agent. */
export function sidebarEnter(): void {
  const sb = store.sidebar;
  if (sb.section === "workspaces") {
    const wsId = store.workspaceOrder[sb.workspaceIdx];
    if (wsId) {
      switchWorkspace(wsId);
      blurSidebar();
    }
  } else {
    const agent = agentSurfaces()[sb.agentIdx];
    if (agent) focusSurface(agent.id);
  }
}

export function sidebarCreate(): void {
  // createWorkspace blurs the sidebar (the new terminal takes the keys); the
  // selection still follows along for when focus comes back.
  createWorkspace();
  setStore(
    produce((s) => {
      s.sidebar.section = "workspaces";
      s.sidebar.workspaceIdx = s.workspaceOrder.length - 1;
    }),
  );
}

// --- Mouse ---------------------------------------------------------------
// Clicking anywhere in the sidebar moves keyboard focus there (so j/k/a/r/d
// work right away) and selects the row that was clicked.

export function sidebarClickWorkspace(wsId: string): void {
  const idx = store.workspaceOrder.indexOf(wsId);
  if (idx === -1) return;
  switchWorkspace(wsId);
  setStore(
    produce((s) => {
      s.sidebar.focused = true;
      s.sidebar.section = "workspaces";
      s.sidebar.workspaceIdx = idx;
    }),
  );
}

/** Reveal the agent but keep the keys in the sidebar; enter jumps into it. */
export function sidebarClickAgent(surfaceId: string): void {
  const idx = agentSurfaces().findIndex((m) => m.id === surfaceId);
  if (idx === -1) return;
  revealSurface(surfaceId, false);
  setStore(
    produce((s) => {
      s.sidebar.focused = true;
      s.sidebar.section = "agents";
      s.sidebar.agentIdx = idx;
    }),
  );
}

export function sidebarClickProfile(): void {
  focusSidebar();
  openSwitchProfile();
}

export function sidebarRename(): void {
  if (store.sidebar.section !== "workspaces") return;
  const wsId = store.workspaceOrder[store.sidebar.workspaceIdx];
  const ws = wsId ? store.workspaces[wsId] : undefined;
  if (!ws) return;
  setStore("dialog", { kind: "rename-workspace", workspaceId: ws.id, value: ws.name });
}

/** d: workspaces ask for confirmation; agents are killed immediately. */
export function sidebarDelete(): void {
  const sb = store.sidebar;
  if (sb.section === "workspaces") {
    if (store.workspaceOrder.length <= 1) return;
    const wsId = store.workspaceOrder[sb.workspaceIdx];
    if (wsId) setStore("dialog", { kind: "confirm-delete-workspace", workspaceId: wsId });
    return;
  }
  const agent = agentSurfaces()[sb.agentIdx];
  if (!agent) return;
  closeSurface(agent.id);
  const remaining = agentSurfaces().length;
  setStore(
    produce((s) => {
      if (remaining === 0) {
        s.sidebar.section = "workspaces";
        s.sidebar.agentIdx = 0;
      } else {
        s.sidebar.agentIdx = Math.min(s.sidebar.agentIdx, remaining - 1);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------

export function dialogChar(ch: string): void {
  setStore(
    produce((s) => {
      if (s.dialog?.kind === "rename-workspace" && s.dialog.value.length < 40) {
        s.dialog.value += ch;
      }
      // Profile names become socket filenames — keep them path-safe.
      if (s.dialog?.kind === "new-profile" && s.dialog.value.length < 32 && /^[\w.-]$/.test(ch)) {
        s.dialog.value += ch;
      }
    }),
  );
}

export function dialogBackspace(): void {
  setStore(
    produce((s) => {
      if (s.dialog?.kind === "rename-workspace" || s.dialog?.kind === "new-profile") {
        s.dialog.value = s.dialog.value.slice(0, -1);
      }
    }),
  );
}

/** j/k in the switch-profile list. */
export function dialogMove(delta: 1 | -1): void {
  setStore(
    produce((s) => {
      if (s.dialog?.kind === "switch-profile" && s.dialog.sessions.length > 0) {
        const n = s.dialog.sessions.length;
        s.dialog.idx = (s.dialog.idx + delta + n) % n;
      }
    }),
  );
}

export function dialogCancel(): void {
  setStore("dialog", null);
}

export function dialogConfirm(): void {
  const d = store.dialog;
  if (!d) return;
  setStore("dialog", null);
  if (d.kind === "confirm-delete-workspace") {
    deleteWorkspace(d.workspaceId);
  } else if (d.kind === "rename-workspace") {
    renameWorkspace(d.workspaceId, d.value);
  } else if (d.kind === "switch-profile") {
    const target = d.sessions[d.idx];
    if (target) switchProfile(target);
  } else if (d.kind === "new-profile") {
    switchProfile(d.value);
  }
}

// ---------------------------------------------------------------------------
// Misc app state
// ---------------------------------------------------------------------------

let onRedraw: () => void = () => {};

/** app.tsx registers a hook that forces a full (non-diffed) frame. */
export function setRedrawHandler(fn: () => void): void {
  onRedraw = fn;
}

/** Force a full repaint — used when a detached client reattaches. */
export function forceRedraw(): void {
  onRedraw();
}

export function setPrefixArmed(armed: boolean): void {
  setStore("prefixArmed", armed);
}

export function setHelpVisible(visible: boolean): void {
  setStore("helpVisible", visible);
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
  return {
    session: store.session,
    workspaces: store.workspaceOrder.map((wsId) => {
      const ws = store.workspaces[wsId]!;
      const rects = workspaceRects(wsId);
      const paneIds = ws.layout ? collectPaneIds(ws.layout) : [];
      return {
        id: ws.id,
        name: ws.name,
        active: wsId === store.activeWorkspaceId,
        panes: paneIds.map((paneId) => {
          const pane = store.panes[paneId]!;
          return {
            id: pane.id,
            rect: rects.get(pane.id) ?? { x: 0, y: 0, width: 0, height: 0 },
            focused: pane.id === ws.focusedPaneId,
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
          };
        }),
      };
    }),
  };
}

/** Kill ghosttown and everything inside it (surfaces, daemon, clients). */
export function quit(): void {
  if (tickTimer) clearInterval(tickTimer);
  if (saveInterval) clearInterval(saveInterval);
  if (saveTimer) clearTimeout(saveTimer);
  // Quitting is a decision, not an accident — don't resurrect this session,
  // and make sure no save in flight writes the file back.
  persistEnabled = false;
  deleteSnapshot(store.session);
  registry.disposeAll();
  onQuit(0);
}

/**
 * Dev reload: exit with the magic code — the daemon respawns the TUI from the
 * current source. The surface PTYs are children of this process, so they die
 * with it; the respawned TUI rebuilds the layout from the snapshot we write
 * here (fresh cwds and all). No-op when not under a daemon. Clears the cached
 * config so the reloaded instance picks up fresh changes.
 */
export function reloadApp(): void {
  if (!process.env.GHOSTTOWN_ATTACH_SOCKET) return;
  if (tickTimer) clearInterval(tickTimer);
  if (saveInterval) clearInterval(saveInterval);
  saveSnapshotNow();
  setConfigForTest(null);
  onQuit(RELOAD_EXIT_CODE);
}

/** Fire-and-forget a command frame at our own attach daemon. */
function sendDaemonCmd(frame: Record<string, unknown>): void {
  const path = process.env.GHOSTTOWN_ATTACH_SOCKET;
  if (!path) return; // GHOSTTOWN_NO_DAEMON: nothing to talk to
  Bun.connect({
    unix: path,
    socket: {
      open(s) {
        s.write(JSON.stringify(frame) + "\n");
        // end() mid-handler aborts the rest of the handler — defer it.
        setTimeout(() => {
          try {
            s.end();
          } catch {
            // already gone
          }
        }, 50);
      },
      data() {},
      error() {},
      close() {},
    },
  }).catch(() => {
    // daemon unreachable
  });
}

/** Detach every attached client; the session keeps running in the daemon. */
export function detachClients(): void {
  sendDaemonCmd({ t: "cmd", cmd: "detach" });
}

// ---------------------------------------------------------------------------
// Profiles (= sessions; each one is its own daemon)
// ---------------------------------------------------------------------------

/** Every profile with a daemon socket, plus the current one. Sorted. */
export function listProfiles(): string[] {
  const names = new Set<string>([store.session]);
  try {
    for (const f of readdirSync(defaultSocketDir())) {
      if (f.endsWith(".attach.sock")) names.add(f.slice(0, -".attach.sock".length));
    }
  } catch {
    // socket dir may not exist yet
  }
  return [...names].sort();
}

export function openSwitchProfile(): void {
  const sessions = listProfiles();
  setStore("dialog", {
    kind: "switch-profile",
    sessions,
    idx: Math.max(0, sessions.indexOf(store.session)),
  });
}

export function openNewProfile(): void {
  setStore("dialog", { kind: "new-profile", value: "" });
}

/**
 * Jump this client to another profile. The daemon tells the attach clients
 * to reconnect to the target session (starting its daemon if needed); this
 * session keeps running detached in the background.
 */
export function switchProfile(name: string): void {
  const target = name.trim();
  if (!target || target === store.session) return;
  dbg("switchProfile", target);
  sendDaemonCmd({ t: "cmd", cmd: "switch", session: target });
}
