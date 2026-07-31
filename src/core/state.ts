/**
 * The reactive session state (Solid store) and every action that mutates it.
 * UI components read from here; the control server calls the same actions.
 * Core rule: this module never imports from src/ui.
 *
 * Hierarchy: profile (= the session) → workspaces → panes → tabs (surfaces).
 * Every workspace's panes stay mounted in the UI (a persistent emulator dies
 * with its renderable); only the active workspace is visible.
 *
 * The surface PTYs live in the daemon's pty host, not here — see core/runtime
 * .ts. This module drives them by id and takes their output, status and titles
 * as events; on startup it adopts whatever the host still has running.
 */
import { createStore, produce } from "solid-js/store";
import { rmSync } from "node:fs";
import type { HostEvents } from "../control/hostclient";
import {
  attachSocketPathFor,
  hostSocketPathFor,
  RELOAD_EXIT_CODE,
  runningSessions,
  sanitizeSessionName,
  socketPathFor,
  type HostSurfaceInfo,
} from "../control/protocol";
import { loadConfig, setConfigForTest } from "./config";
import { dbg } from "./debug";
import { fuzzyFilter } from "./fuzzy";
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
import { desktopNotify, notifyText, screenDetail } from "./notify";
import {
  listSaved,
  readSnapshot,
  retireSnapshot,
  SNAPSHOT_VERSION,
  type PersistedSession,
} from "./persist";
import { hostSend, RuntimeRegistry, SurfaceRuntime } from "./runtime";
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
  | { kind: "rename-tab"; surfaceId: string; value: string }
  /** The profile switcher, which is also where profiles are managed (a/r/d). */
  /**
   * `sessions` is every profile, running or merely saved; `stopped` marks which
   * of them have no daemon, so the list can say so — picking one starts it and
   * restores its layout.
   */
  | { kind: "switch-profile"; sessions: string[]; stopped: string[]; idx: number }
  /** `back`: opened from the switcher, so cancelling returns to it. */
  | { kind: "new-profile"; value: string; back?: boolean }
  | { kind: "rename-profile"; session: string; value: string }
  | { kind: "confirm-delete-profile"; session: string }
  /** Telescope-style finders: a query filters the list as you type. */
  | { kind: "find-workspace"; query: string; idx: number }
  | { kind: "find-agent"; query: string; idx: number };

/** Dialogs that are a single line of text being edited. */
export type TextDialog = Extract<
  DialogState,
  { kind: "rename-workspace" | "rename-tab" | "new-profile" | "rename-profile" }
>;

export function isTextDialog(d: DialogState | null): d is TextDialog {
  return (
    d?.kind === "rename-workspace" ||
    d?.kind === "rename-tab" ||
    d?.kind === "new-profile" ||
    d?.kind === "rename-profile"
  );
}

/** A profile name lands in a filename, so those dialogs restrict what you can type. */
const isProfileDialog = (d: DialogState | null): boolean =>
  d?.kind === "new-profile" || d?.kind === "rename-profile";

/** The dialogs that are a query + a filtered list rather than a plain input. */
export type FinderDialog = Extract<DialogState, { kind: "find-workspace" | "find-agent" }>;

export function isFinderDialog(d: DialogState | null): d is FinderDialog {
  return d?.kind === "find-workspace" || d?.kind === "find-agent";
}

/** One row of a finder: what it is, what it looks like, where it points. */
export interface FinderItem {
  /** Workspace id, or surface id for the agent finder. */
  id: string;
  label: string;
  /** Right-aligned detail (tab count, agent workspace + status). */
  hint: string;
  /** The one you are looking at right now, marked with a dot. */
  current: boolean;
  status?: AgentStatus;
  /**
   * What the query is matched against, when that is more than the label: an
   * agent is findable by its workspace and by which agent it is, not just by
   * whatever its tab happens to be called.
   */
  search?: string;
}

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
  /**
   * The divider a mouse drag is moving right now. It lives here rather than in
   * the component because the panes have to know: while a drag is running the
   * mouse belongs to it, and a surface the pointer crosses must not forward
   * the events to its program.
   */
  dividerDrag: Gutter | null;
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
  dividerDrag: null,
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

// ---------------------------------------------------------------------------
// Derived geometry & lookups
// ---------------------------------------------------------------------------

export function activeWorkspace(): WorkspaceState | undefined {
  return store.workspaces[store.activeWorkspaceId];
}

export function focusedPaneId(): string {
  return activeWorkspace()?.focusedPaneId ?? "";
}

/** What a tab is called: the user's name if they gave it one, else the title. */
export function surfaceLabel(meta: SurfaceMeta | undefined): string {
  return meta ? meta.titleOverride || meta.title : "";
}

/** The tab the keys are going to right now. */
export function activeSurfaceId(): string {
  const pane = store.panes[focusedPaneId()];
  return pane?.surfaceIds[pane.activeIdx] ?? "";
}

/**
 * The tab a pane is showing. Everything new — a split, a tab, a workspace —
 * opens in this one's directory, so you land where you were working rather
 * than wherever the TUI itself was started.
 */
function inheritFrom(paneId: string): string | undefined {
  const pane = store.panes[paneId];
  return pane?.surfaceIds[pane.activeIdx];
}

/** How many tabs a workspace holds, across all its panes. */
export function workspaceTabCount(wsId: string): number {
  const ws = store.workspaces[wsId];
  if (!ws?.layout) return 0;
  return collectPaneIds(ws.layout).reduce(
    (n, pid) => n + (store.panes[pid]?.surfaceIds.length ?? 0),
    0,
  );
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

/** An agent, plus where in the profile it lives. */
export interface AgentEntry {
  meta: SurfaceMeta;
  /** Empty for a surface no pane claims (it is being closed). */
  workspaceId: string;
  workspace: string;
  paneId: string;
  /** An agent program is running in it right now (not just historically). */
  live: boolean;
}

/**
 * What to call an agent in a list. Normally the tab's own label, which for a
 * real agent is something useful ("✳ Claude Code", or whatever it renamed
 * itself to). When the title says nothing about what is running — a bare "sh",
 * because the agent was started by hand and sets no title — the detected
 * program name is the more informative thing to show.
 */
export function agentLabel(meta: SurfaceMeta): string {
  const label = surfaceLabel(meta);
  if (!meta.agent || meta.titleOverride) return label;
  return label.toLowerCase().includes(meta.agent) ? label : meta.agent;
}

/** Surface id → the pane and workspace holding it, for the whole profile. */
function surfaceHomes(): Map<string, { paneId: string; workspaceId: string }> {
  const out = new Map<string, { paneId: string; workspaceId: string }>();
  for (const wsId of store.workspaceOrder) {
    const ws = store.workspaces[wsId];
    if (!ws?.layout) continue;
    for (const paneId of collectPaneIds(ws.layout)) {
      for (const sid of store.panes[paneId]?.surfaceIds ?? []) {
        out.set(sid, { paneId, workspaceId: wsId });
      }
    }
  }
  return out;
}

/**
 * What counts as an agent.
 *
 * Detection first: `agent` means the daemon can see an agent process in that
 * surface *right now*, which is the only way an idle one is ever found — it
 * prints nothing, so no output heuristic could. `hasReporter` covers anything
 * wired up to `gt report` through hooks.
 *
 * The list is *present tense*. Detection is the only signal that can tell an
 * agent has gone, so in a surface where it has ever worked (`everAgent`) its
 * verdict is final: quit claude and the tab drops off the list instead of
 * lingering there as a shell named after its directory. Where detection has
 * never seen anything — an agent inside a container or over ssh, or the poll
 * turned off — the historical signals still list the surface, because nothing
 * else can say whether it is still there. [agents] keep_exited = true brings
 * back the old behavior of keeping every tab that ever held an agent.
 *
 * Busy-but-unrecognized surfaces are *out* by default. Sustained output used to
 * be the main signal, which meant a `nvim` or a shell that once ran a build sat
 * in the agent list forever — noise that made the list untrustworthy in the
 * same breath as the missing agents. [agents] include_busy brings it back.
 */
function isAgentSurface(m: SurfaceMeta): boolean {
  if (m.agent) return true;
  const cfg = loadConfig().agents;
  const detecting = cfg?.detect !== false;
  if (detecting && m.everAgent && cfg?.keep_exited !== true) return false;
  if (m.everAgent || m.hasReporter) return true;
  if (cfg?.include_busy !== true) return false;
  return m.everActive || m.status !== "idle";
}

/**
 * Inbox order: what needs you, then what just finished, then what is running,
 * then what is waiting. Live agents outrank ones that have exited, and ties go
 * to whatever was active most recently.
 */
const STATUS_RANK: Record<AgentStatus, number> = { blocked: 0, done: 1, working: 2, idle: 3 };

function compareAgents(a: AgentEntry, b: AgentEntry): number {
  const byStatus = STATUS_RANK[a.meta.status] - STATUS_RANK[b.meta.status];
  if (byStatus !== 0) return byStatus;
  if (a.live !== b.live) return a.live ? -1 : 1;
  const byRecency = (b.meta.lastActiveAt ?? 0) - (a.meta.lastActiveAt ?? 0);
  if (byRecency !== 0) return byRecency;
  return a.meta.id.localeCompare(b.meta.id);
}

/**
 * Every agent in the profile, whichever workspace it sits in, tagged with
 * where to find it. This is the one list the sidebar, the finder and `gt list`
 * all read from.
 */
export function agentEntries(): AgentEntry[] {
  const homes = surfaceHomes();
  return Object.values(store.surfaces)
    .filter(isAgentSurface)
    .map((meta) => {
      const home = homes.get(meta.id);
      return {
        meta,
        workspaceId: home?.workspaceId ?? "",
        workspace: home ? (store.workspaces[home.workspaceId]?.name ?? "") : "",
        paneId: home?.paneId ?? "",
        live: !!meta.agent,
      };
    })
    .sort(compareAgents);
}

/** The same list, metadata only — what most callers want. */
export function agentSurfaces(): SurfaceMeta[] {
  return agentEntries().map((e) => e.meta);
}

/** Tally for the sidebar header and the status bar. */
export function agentCounts(): Record<AgentStatus, number> & { total: number; live: number } {
  const out = { idle: 0, working: 0, blocked: 0, done: 0, total: 0, live: 0 };
  for (const entry of agentEntries()) {
    out[entry.meta.status]++;
    out.total++;
    if (entry.live) out.live++;
  }
  return out;
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

/**
 * `silent`: the caller has already notified for this event (an OSC 9 from the
 * program itself), so the status change must not send a second one.
 */
function applyStatus(surfaceId: string, status: AgentStatus, silent = false): void {
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
  if (!silent && (status === "done" || status === "blocked") && !isVisibleActive(surfaceId)) {
    notifySurface(surfaceId, status);
  }
}

// ---------------------------------------------------------------------------
// Notifications
//
// A notification is only worth sending if it says which agent it came from and
// what it wants — you should not have to go looking to find out whether it is
// yours to act on. So each one carries the agent's name, where it lives, and a
// line of its own words, plus a click that jumps straight to its tab (see
// core/notify.ts for how the click is delivered).
// ---------------------------------------------------------------------------

/** How long a `gt report` note stays available to the status event it precedes. */
const NOTE_TTL_MS = 15_000;

/**
 * Detail from the last `gt report` on a surface. Claude Code's Notification
 * hook hands us the prompt's own message ("Claude needs your permission to run
 * git push"), which is a far better notification body than anything that can be
 * read off the screen — but it arrives on the report, one host round-trip
 * before the status event that notifies.
 */
const reportNotes = new Map<string, { text: string; at: number }>();

function takeReportNote(surfaceId: string): string {
  const note = reportNotes.get(surfaceId);
  if (!note) return "";
  reportNotes.delete(surfaceId);
  return Date.now() - note.at <= NOTE_TTL_MS ? note.text : "";
}

/** The workspace a surface lives in — the "where" of a notification. */
function workspaceNameOf(surfaceId: string): string {
  for (const pane of Object.values(store.panes)) {
    if (!pane.surfaceIds.includes(surfaceId)) continue;
    const wsId = workspaceOf(pane.id);
    return wsId ? store.workspaces[wsId]!.name : "";
  }
  return "";
}

/**
 * Notify for one surface. `kind` picks the headline; an explicit title/body
 * (from `gt notify` or the program's own OSC 9) wins over the derived ones.
 */
export function notifySurface(
  surfaceId: string,
  kind: AgentStatus | "custom",
  explicit: { title?: string; body?: string } = {},
): void {
  const meta = store.surfaces[surfaceId];
  if (!meta) return;
  const { title, subtitle } = notifyText({
    // What to call it: the name the user gave the tab, else the agent running
    // in it, else whatever the program calls itself.
    label: meta.titleOverride || meta.agent || meta.title || meta.command,
    title: meta.title,
    workspace: workspaceNameOf(surfaceId),
    // Which profile only matters when you run more than the usual one.
    session: store.session === (loadConfig().general.session || "main") ? "" : store.session,
    kind,
    explicitTitle: explicit.title,
  });

  const fallback = kind === "blocked" ? "needs your attention" : "finished working";
  desktopNotify({
    key: surfaceId,
    title,
    subtitle,
    body:
      explicit.body ||
      takeReportNote(surfaceId) ||
      screenDetail(registry.get(surfaceId)?.screenText() ?? "") ||
      fallback,
    focus: { socket: socketPath, surface: surfaceId },
  });
}

function spawnSurface(
  paneId: string,
  command?: string,
  args: string[] = [],
  cwd?: string,
  /** Surface to start next to, directory-wise; the host resolves it. */
  cwdFrom?: string,
): string {
  const surfaceId = nextId("s");
  const cmd = command || loadConfig().general.shell || process.env.SHELL || "/bin/zsh";
  const rect = allRects().get(paneId) ?? paneArea();

  setStore(
    produce((s) => {
      s.surfaces[surfaceId] = {
        id: surfaceId,
        title: cmd.split("/").pop() ?? cmd,
        command: cmd,
        status: "idle",
        unread: false,
        hasReporter: false,
        everActive: false,
        everAgent: false,
        exited: false,
      };
    }),
  );

  const rt = new SurfaceRuntime(surfaceId);
  registry.add(rt);
  rt.spawn({
    command: cmd,
    args,
    // The host drops a cwd that no longer exists; it may have been deleted
    // between the snapshot and now.
    cwd: cwd ?? process.cwd(),
    cwdFrom,
    env: surfaceEnv(paneId, surfaceId),
    cols: rect.width,
    rows: rect.height - 1,
  });
  return surfaceId;
}

/**
 * Take over a surface the pty host is already running — the reload path. The
 * program keeps running; only the emulator is new, and it is rebuilt from the
 * host's replay buffer when the renderable mounts.
 */
function adoptSurface(info: HostSurfaceInfo): string {
  setStore(
    produce((s) => {
      s.surfaces[info.id] = {
        id: info.id,
        title: info.title,
        titleOverride: info.titleOverride ?? undefined,
        command: info.command,
        status: info.status,
        unread: false,
        hasReporter: info.hasReporter,
        everActive: info.everActive,
        // The host kept detecting agents while the TUI was away, so a reload
        // comes back with the agent list already populated.
        agent: info.agent ?? undefined,
        everAgent: info.everAgent,
        exited: false,
        lastActiveAt: info.lastActiveAt ?? undefined,
      };
    }),
  );
  registry.add(new SurfaceRuntime(info.id));
  return info.id;
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
  /** What the pty host is already running, and the layout that went with it. */
  boot: { surfaces: HostSurfaceInfo[]; layout: PersistedSession | null };
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
  persistEnabled = config.general.restore_session !== false;

  const live = new Map(opts.boot.surfaces.filter((s) => !s.exited).map((s) => [s.id, s]));
  // The host holding a layout means the TUI restarted under a live session
  // (prefix+R, or a --watch reload): adopt it whatever restore_session says,
  // since those surfaces are still running and dropping them would be worse
  // than useless. Only a cold start consults the disk snapshot, and an
  // explicit `gt -- <command>` asks for that command, not for yesterday.
  let restored = !!opts.boot.layout && restoreSession(opts.boot.layout, live);
  if (!restored && persistEnabled && !opts.command) {
    const snapshot = readSnapshot(opts.session);
    restored = !!snapshot && restoreSession(snapshot, live);
  }
  if (!restored) createWorkspace({ command: opts.command, args: opts.args });

  // Surfaces the host has that no pane claimed — one that exited while we were
  // away, or a layout written before the last split — would otherwise sit there
  // invisible and unkillable.
  for (const { id } of opts.boot.surfaces) {
    if (store.surfaces[id]) continue;
    dbg("initSession: dropping unclaimed host surface", id);
    hostSend({ t: "kill", id });
  }
  pushLayout();
}

/**
 * Host → store plumbing. app.tsx hands this to the host connection; every
 * surface event the pty host produces lands here.
 */
export function hostEvents(): HostEvents {
  return {
    onOutput: (id, d) => registry.get(id)?.feed(Buffer.from(d, "base64").toString("utf8")),
    onSnapshot: (id, d) =>
      registry.get(id)?.feedSnapshot(Buffer.from(d, "base64").toString("utf8")),
    onExit: (id) => {
      // A surface dying because the session is being torn down is not the user
      // closing a tab. Acting on it walks the whole close cascade — surface →
      // pane → workspace → and, on the last one, quit() — which drops the very
      // snapshot a restart hands to the daemon replacing us.
      if (tearingDown) return;
      if (store.surfaces[id]) closeSurface(id);
    },
    onStatus: (id, status, hasReporter) => {
      if (hasReporter && store.surfaces[id] && !store.surfaces[id]!.hasReporter) {
        setStore("surfaces", id, "hasReporter", true);
      }
      applyStatus(id, status);
    },
    onAgent: (id, agent) => {
      setStore(
        produce((s) => {
          const m = s.surfaces[id];
          if (!m) return;
          m.agent = agent ?? undefined;
          if (agent) {
            m.everAgent = true;
            // Ordering needs something to work with, even for an agent that has
            // been sitting at its prompt since before we started watching.
            m.lastActiveAt ??= Date.now();
          }
        }),
      );
    },
    onTitle: (id, title) => {
      setStore(
        produce((s) => {
          const m = s.surfaces[id];
          if (m && title) m.title = title;
        }),
      );
    },
    // OSC 9 / OSC 777 from the program itself. It asked to be seen, so this one
    // goes out even if its tab is on screen — and the status change that
    // follows must not repeat it.
    onNotify: (id, title, body) => {
      notifySurface(id, "blocked", { title: title || undefined, body: body || undefined });
      applyStatus(id, "blocked", true);
    },
    onModes: (id, modes) => registry.get(id)?.setMouseModes(modes),
    onCursorRequest: (id, seq) => registry.get(id)?.answerCursor(seq),
    onLost: () => {
      // The surfaces are fine — we just lost our handle on them. Ask the daemon
      // for a fresh TUI, which reconnects and adopts them; if there is no
      // daemon, the host died with the process anyway and there is no going back.
      dbg("pty host connection lost");
      onQuit(process.env.GHOSTTOWN_ATTACH_SOCKET ? RELOAD_EXIT_CODE : 1);
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence — the structure is ours, the file is the pty host's
//
// The host writes the snapshot (it owns the pids the cwds come from) and keeps
// the last structure in memory, which is what a restarting TUI boots from. All
// this side does is hand over the shape of the session whenever it changes.
// See core/persist.ts for the file format.
// ---------------------------------------------------------------------------

/** Coalesces bursts (a drag emits a divider change per step). */
const PUSH_DEBOUNCE_MS = 100;

let persistEnabled = false;
/**
 * Set once the session is on its way down by our own decision (restartApp), so
 * the surface deaths that follow are read as teardown rather than as the user
 * closing things. Only ever set — the process it belongs to is ending.
 */
let tearingDown = false;
let pushTimer: ReturnType<typeof setTimeout> | null = null;

function serializeSession(): PersistedSession {
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
            // cwds are filled in host-side, from the pids it owns.
            surfaces: pane.surfaceIds.map((sid) => ({
              id: sid,
              cwd: null,
              title: store.surfaces[sid]?.titleOverride ?? null,
            })),
          };
        }),
      };
    }),
  };
}

/** Hand the current structure to the host, right now. */
function pushLayoutNow(): void {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  if (store.workspaceOrder.length === 0) return;
  hostSend({ t: "layout", data: serializeSession() });
}

/** Structural change: tell the host once the burst settles. */
function pushLayout(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    pushLayoutNow();
  }, PUSH_DEBOUNCE_MS);
}

/** Restored ids are reused verbatim, so fresh ones must start above them. */
function bumpIdCounter(ids: string[]): void {
  for (const id of ids) {
    const n = Number(id.replace(/^\D+/, ""));
    if (Number.isFinite(n) && n > idCounter) idCounter = n;
  }
}

/**
 * Rebuild the session from a snapshot: layout, tab order and cwds come back.
 * A surface that the pty host still has running (`live`) is adopted as it is —
 * that is the reload path, and the program in it never notices. Anything else
 * comes back as a fresh shell in its old directory. Returns false if nothing
 * usable was in the snapshot, leaving the caller to start a normal session.
 */
function restoreSession(snap: PersistedSession, live: Map<string, HostSurfaceInfo>): boolean {
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
    // Adopted surfaces keep their ids, so fresh ones must not collide.
    ...workspaces.flatMap((ws) => ws.panes.flatMap((p) => p.surfaces.map((s) => s.id ?? ""))),
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
      const surfaces =
        pane.surfaces.length > 0 ? pane.surfaces : [{ id: "", cwd: null }];
      for (const surface of surfaces) {
        const running = surface.id ? live.get(surface.id) : undefined;
        const surfaceId = running
          ? adoptSurface(running)
          : spawnSurface(pane.id, undefined, [], surface.cwd ?? undefined);
        live.delete(surfaceId);
        setStore(
          produce((s) => {
            s.panes[pane.id]!.surfaceIds.push(surfaceId);
          }),
        );
        // An adopted surface already has its name (the host kept it); a fresh
        // one gets the name back from the snapshot.
        if (!running && surface.title) renameSurface(surfaceId, surface.title);
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
  // Read before the store switches over, so it is the tab we are leaving.
  const cwdFrom = inheritFrom(focusedPaneId());
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
  const surfaceId = spawnSurface(paneId, opts.command, opts.args ?? [], undefined, cwdFrom);
  setStore(
    produce((s) => {
      s.panes[paneId]!.surfaceIds.push(surfaceId);
    }),
  );
  syncSizes();
  pushLayout();
  return wsId;
}

export function switchWorkspace(wsId: string): void {
  if (!store.workspaces[wsId]) return;
  setStore("activeWorkspaceId", wsId);
  const ws = store.workspaces[wsId]!;
  const pane = store.panes[ws.focusedPaneId];
  const active = pane?.surfaceIds[pane.activeIdx];
  if (active) clearUnread(active);
  pushLayout();
}

/**
 * Step to the next/previous workspace in `workspaceOrder`, wrapping around.
 * Like the finder, this hands the keys back to the pane: cycling is something
 * you do on your way to typing somewhere.
 */
export function cycleWorkspace(delta: 1 | -1): void {
  const order = store.workspaceOrder;
  if (order.length < 2) return;
  const idx = order.indexOf(store.activeWorkspaceId);
  const next = order[(((idx === -1 ? 0 : idx) + delta) % order.length + order.length) % order.length];
  if (!next) return;
  switchWorkspace(next);
  blurSidebar();
}

export function renameWorkspace(wsId: string, name: string): void {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed || !store.workspaces[wsId]) return;
  setStore("workspaces", wsId, "name", trimmed);
  pushLayout();
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
  pushLayout();
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
  pushLayout();
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

/** Mouse-down on a gutter: everything until the release moves this divider. */
export function startDividerDrag(gutter: Gutter): void {
  setStore("dividerDrag", gutter);
}

export function endDividerDrag(): void {
  if (store.dividerDrag) setStore("dividerDrag", null);
}

/** True while a divider is being dragged — the mouse belongs to the drag. */
export function dividerDragging(): boolean {
  return store.dividerDrag !== null;
}

/**
 * A pointer position during a divider drag: put the divider under it. The
 * gutter captured at mouse-down keeps describing its split for the whole drag
 * — moving a divider changes its own ratio, never the split's origin or size.
 */
export function dragDivider(x: number, y: number): void {
  const gutter = store.dividerDrag;
  if (!gutter) return;
  const pointer = gutter.dir === "row" ? x : y;
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
  const cwdFrom = inheritFrom(paneId);
  setStore(
    produce((s) => {
      s.panes[newPaneId] = { id: newPaneId, surfaceIds: [], activeIdx: 0 };
      const ws = s.workspaces[wsId]!;
      ws.layout = splitLeaf(ws.layout!, paneId, newPaneId, dir);
      ws.focusedPaneId = newPaneId;
    }),
  );
  const surfaceId = spawnSurface(newPaneId, command, args ?? [], undefined, cwdFrom);
  setStore(
    produce((s) => {
      s.panes[newPaneId]!.surfaceIds.push(surfaceId);
    }),
  );
  syncSizes();
  pushLayout();
  return newPaneId;
}

export function newTab(paneId: string, command?: string, args?: string[]): string | null {
  if (!store.panes[paneId]) return null;
  const surfaceId = spawnSurface(paneId, command, args ?? [], undefined, inheritFrom(paneId));
  setStore(
    produce((s) => {
      const p = s.panes[paneId]!;
      p.surfaceIds.push(surfaceId);
      p.activeIdx = p.surfaceIds.length - 1;
    }),
  );
  clearUnread(surfaceId);
  pushLayout();
  return surfaceId;
}

/**
 * Name a tab. The name sticks: it wins over whatever OSC titles the program
 * sets, the pty host keeps a copy so it survives a TUI restart, and it goes in
 * the snapshot. An empty name clears it, handing the label back to the program.
 */
export function renameSurface(surfaceId: string, name: string): void {
  if (!store.surfaces[surfaceId]) return;
  const trimmed = name.trim().slice(0, 40);
  setStore(
    produce((s) => {
      const m = s.surfaces[surfaceId];
      if (m) m.titleOverride = trimmed || undefined;
    }),
  );
  registry.get(surfaceId)?.rename(trimmed || null);
  pushLayout();
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
  pushLayout();
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
  pushLayout();
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
    pushLayout();
    return;
  }
}

/** Switch workspace + focus the pane holding this surface, on its tab. */
export function focusSurface(surfaceId: string): void {
  revealSurface(surfaceId, true);
}

/**
 * `gt focus` (and what clicking a notification runs): bring a surface, pane or
 * workspace on screen, most specific target first. A workspace may be named
 * rather than identified, since that is what a person knows it by. Returns
 * false when nothing matched — the tab may have been closed since.
 */
export function focusTarget(target: {
  surface?: string;
  pane?: string;
  workspace?: string;
}): boolean {
  if (target.surface) {
    if (!store.surfaces[target.surface]) return false;
    focusSurface(target.surface);
    return true;
  }
  if (target.pane) {
    if (!store.panes[target.pane]) return false;
    focusPane(target.pane);
    return true;
  }
  if (target.workspace) {
    const wsId = store.workspaces[target.workspace]
      ? target.workspace
      : store.workspaceOrder.find((id) => store.workspaces[id]!.name === target.workspace);
    if (!wsId) return false;
    switchWorkspace(wsId);
    return true;
  }
  return false;
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
  reportNotes.delete(surfaceId);
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
  else pushLayout();
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
  pushLayout();
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

/**
 * Paste (or a file dropped on the window, which the host terminal delivers as
 * one) goes to the focused pane as a paste, not as typing — see
 * SurfaceRuntime.paste.
 */
export function pasteToFocused(text: string): void {
  focusedRuntime()?.paste(text);
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
  pushLayout();
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
        // Agents come and go under the selection — an agent quitting shortens
        // the list — so move from where the cursor can actually be, or j/k both
        // become no-ops on an index past the end.
        const from = Math.min(Math.max(sb.agentIdx, 0), Math.max(0, agentCount - 1));
        const next = from + delta;
        if (next < 0 || agentCount === 0) {
          sb.section = "workspaces";
          sb.workspaceIdx = Math.max(0, wsCount - 1);
          sb.agentIdx = 0;
        } else if (next < agentCount) {
          sb.agentIdx = next;
        } else {
          sb.agentIdx = from;
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
// Clicking blank sidebar space moves keyboard focus there (so j/k/a/r/d work
// right away). Clicking a ROW is a jump, not a mode change: it acts and hands
// the keys straight to the terminal it took you to. Keeping focus in the
// sidebar turned the next unprefixed letter into a sidebar command — "a" after
// clicking a workspace created another one instead of reaching the shell.

export function sidebarClickWorkspace(wsId: string): void {
  const idx = store.workspaceOrder.indexOf(wsId);
  if (idx === -1) return;
  switchWorkspace(wsId);
  setStore(
    produce((s) => {
      s.sidebar.focused = false;
      s.sidebar.section = "workspaces";
      s.sidebar.workspaceIdx = idx;
    }),
  );
}

/** Jump into the agent's pane, the way enter does from the keyboard. */
export function sidebarClickAgent(surfaceId: string): void {
  const idx = agentSurfaces().findIndex((m) => m.id === surfaceId);
  if (idx === -1) return;
  setStore(
    produce((s) => {
      s.sidebar.section = "agents";
      s.sidebar.agentIdx = idx;
    }),
  );
  revealSurface(surfaceId, true);
}

export function sidebarClickProfile(): void {
  focusSidebar();
  openSwitchProfile();
}

/** r: rename the selected workspace, or the selected agent's tab. */
export function sidebarRename(): void {
  const sb = store.sidebar;
  if (sb.section === "workspaces") {
    const wsId = store.workspaceOrder[sb.workspaceIdx];
    if (wsId) openRenameWorkspace(wsId);
    return;
  }
  const agent = agentSurfaces()[sb.agentIdx];
  if (agent) openRenameTab(agent.id);
}

/** d: workspaces ask for confirmation; agents are killed immediately. */
export function sidebarDelete(): void {
  const sb = store.sidebar;
  if (sb.section === "workspaces") {
    if (store.workspaceOrder.length <= 1) return;
    const wsId = store.workspaceOrder[sb.workspaceIdx];
    if (wsId) openDeleteWorkspace(wsId);
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

/**
 * Replace the open dialog wholesale. Through `produce`, because a plain
 * setStore("dialog", {...}) *merges* into the object that is already there —
 * which leaves one dialog's fields behind on the next one.
 */
function setDialog(d: DialogState | null): void {
  setStore(
    produce((s) => {
      s.dialog = d;
    }),
  );
}

/** Deleting a workspace is a decision; the dialog is where it is taken. */
export function openDeleteWorkspace(wsId: string = store.activeWorkspaceId): void {
  if (!store.workspaces[wsId]) return;
  setDialog({ kind: "confirm-delete-workspace", workspaceId: wsId });
}

export function openRenameWorkspace(wsId: string = store.activeWorkspaceId): void {
  const ws = store.workspaces[wsId];
  if (!ws) return;
  setDialog({ kind: "rename-workspace", workspaceId: ws.id, value: ws.name });
}

export function openRenameTab(surfaceId: string = activeSurfaceId()): void {
  const meta = store.surfaces[surfaceId];
  if (!meta) return;
  setDialog({ kind: "rename-tab", surfaceId, value: surfaceLabel(meta) });
}

/** Fuzzy workspace switcher. Starts on the current workspace, so ⏎ is a no-op. */
export function openFindWorkspace(): void {
  setDialog({
    kind: "find-workspace",
    query: "",
    idx: Math.max(0, store.workspaceOrder.indexOf(store.activeWorkspaceId)),
  });
}

/** Fuzzy agent finder, over the same list the sidebar shows. */
export function openFindAgent(): void {
  setDialog({ kind: "find-agent", query: "", idx: 0 });
}

function workspaceRows(): FinderItem[] {
  return store.workspaceOrder.map((wsId) => {
    const tabs = workspaceTabCount(wsId);
    return {
      id: wsId,
      label: store.workspaces[wsId]?.name ?? "",
      hint: `${tabs} tab${tabs === 1 ? "" : "s"}`,
      current: wsId === store.activeWorkspaceId,
    };
  });
}

function agentRows(): FinderItem[] {
  const active = activeSurfaceId();
  return agentEntries().map((e) => {
    const label = agentLabel(e.meta);
    const status = e.meta.status === "working" ? "running" : e.meta.status;
    return {
      id: e.meta.id,
      label,
      // Which workspace it is in is the thing you cannot get to otherwise.
      hint: e.workspace ? `${e.workspace} · ${status}` : status,
      current: e.meta.id === active,
      status: e.meta.status,
      search: [label, e.workspace, e.meta.agent].filter(Boolean).join(" "),
    };
  });
}

/**
 * Rows of the open finder, filtered by its query. Derived from the store on
 * every read, so the list keeps up with whatever happens while it is open.
 */
export function finderItems(): FinderItem[] {
  const d = store.dialog;
  if (!isFinderDialog(d)) return [];
  const rows = d.kind === "find-workspace" ? workspaceRows() : agentRows();
  return fuzzyFilter(d.query, rows, (r) => r.search ?? r.label).map(({ item }) => item);
}

/** How many rows the open dialog's selection moves over. */
function dialogRowCount(): number {
  const d = store.dialog;
  if (d?.kind === "switch-profile") return d.sessions.length;
  return finderItems().length;
}

export function dialogChar(ch: string): void {
  setStore(
    produce((s) => {
      const d = s.dialog;
      if (isProfileDialog(d) && isTextDialog(d)) {
        // Profile names become socket filenames — keep them path-safe.
        if (d.value.length < 32 && /^[\w.-]$/.test(ch)) d.value += ch;
      } else if (isTextDialog(d)) {
        if (d.value.length < 40) d.value += ch;
      } else if (isFinderDialog(d) && d.query.length < 40) {
        d.query += ch;
        d.idx = 0; // a new query is a new list; start at the top of it
      }
    }),
  );
}

export function dialogBackspace(): void {
  setStore(
    produce((s) => {
      const d = s.dialog;
      if (isTextDialog(d)) {
        d.value = d.value.slice(0, -1);
      } else if (isFinderDialog(d)) {
        d.query = d.query.slice(0, -1);
        d.idx = 0;
      }
    }),
  );
}

/** ctrl+u: wipe the line, as in any readline prompt. */
export function dialogClear(): void {
  setStore(
    produce((s) => {
      const d = s.dialog;
      if (isTextDialog(d)) {
        d.value = "";
      } else if (isFinderDialog(d)) {
        d.query = "";
        d.idx = 0;
      }
    }),
  );
}

/** Move the selection in a list dialog (switch-profile, the finders). */
export function dialogMove(delta: 1 | -1): void {
  const count = dialogRowCount();
  if (count === 0) return;
  setStore(
    produce((s) => {
      const d = s.dialog;
      if (d?.kind === "switch-profile" || isFinderDialog(d)) {
        d.idx = (d.idx + delta + count) % count;
      }
    }),
  );
}

/** Mouse: a click on a row selects it and takes it. */
export function dialogPick(idx: number): void {
  setStore(
    produce((s) => {
      const d = s.dialog;
      if (d?.kind === "switch-profile" || isFinderDialog(d)) d.idx = idx;
    }),
  );
  dialogConfirm();
}

export function dialogCancel(): void {
  const d = store.dialog;
  // The profile dialogs are reached *from* the switcher, so esc goes back to it
  // rather than dropping you out of what you were doing.
  if (d?.kind === "rename-profile" || d?.kind === "confirm-delete-profile") {
    openSwitchProfile(d.session);
    return;
  }
  if (d?.kind === "new-profile" && d.back) {
    openSwitchProfile();
    return;
  }
  setDialog(null);
}

export function dialogConfirm(): void {
  const d = store.dialog;
  if (!d) return;
  // A name that cannot be used keeps the dialog open instead of quietly
  // throwing away what was typed. The UI says why (see Dialogs.tsx).
  if (d.kind === "rename-profile" && !canRenameProfileTo(d.session, d.value)) return;
  // Resolved before the dialog closes — finderItems() reads store.dialog.
  const picked = isFinderDialog(d) ? finderItems()[d.idx] : undefined;
  setDialog(null);
  switch (d.kind) {
    case "confirm-delete-workspace":
      deleteWorkspace(d.workspaceId);
      return;
    case "rename-workspace":
      renameWorkspace(d.workspaceId, d.value);
      return;
    case "rename-tab":
      renameSurface(d.surfaceId, d.value);
      return;
    case "switch-profile": {
      const target = d.sessions[d.idx];
      if (target) switchProfile(target);
      return;
    }
    case "new-profile":
      switchProfile(d.value);
      return;
    case "rename-profile":
      renameProfile(d.session, d.value);
      return;
    case "confirm-delete-profile":
      deleteProfile(d.session);
      return;
    case "find-workspace":
      if (picked) {
        switchWorkspace(picked.id);
        blurSidebar();
      }
      return;
    case "find-agent":
      if (picked) focusSurface(picked.id);
      return;
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

/**
 * The config file changed on disk and the cache has been dropped. Values read
 * at use time (pane_gap, sidebar width, keybinds) are already live; the pane
 * geometry they feed has to be recomputed.
 */
export function applyConfigChange(): void {
  syncSizes();
  forceRedraw();
}

export function setPrefixArmed(armed: boolean): void {
  setStore("prefixArmed", armed);
}

export function setHelpVisible(visible: boolean): void {
  setStore("helpVisible", visible);
}

/**
 * Explicit status report from `gt report` (authoritative, applied host-side).
 * `note` is the reporter's own description of what happened — Claude Code's
 * hook payload carries one — and becomes the body of the notification this
 * report triggers.
 */
export function reportStatus(surfaceId: string, status: AgentStatus, note?: string): boolean {
  const rt = registry.get(surfaceId);
  if (!rt || !store.surfaces[surfaceId]) return false;
  setStore(
    produce((s) => {
      s.surfaces[surfaceId]!.hasReporter = true;
    }),
  );
  if (note?.trim()) reportNotes.set(surfaceId, { text: note.trim(), at: Date.now() });
  rt.report(status);
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
                agent: m.agent,
                active: idx === pane.activeIdx,
              };
            }),
          };
        }),
      };
    }),
    // Flat and profile-wide: scripts (and `gt list`) should not have to walk
    // the layout to find out what is running where.
    agents: agentEntries().map((e) => ({
      surfaceId: e.meta.id,
      title: agentLabel(e.meta),
      status: e.meta.status,
      agent: e.meta.agent ?? null,
      live: e.live,
      unread: e.meta.unread,
      workspaceId: e.workspaceId,
      workspace: e.workspace,
      paneId: e.paneId,
      lastActiveAt: e.meta.lastActiveAt ?? null,
    })),
  };
}

/**
 * Quit: every surface in this profile dies, and the *arrangement* is written
 * down on the way out — the next `gt` opens the same workspaces, panes, tabs and
 * directories with fresh shells in them. Organizing a session is work, and
 * ending its processes is not a request to throw that away.
 *
 * `discard` (deleting the profile) is the one case that retires the layout, and
 * even then it lands in the archive. So does the other quit that means nothing
 * is left: the cascade that fires when the last workspace closes.
 */
export function quit(opts?: { discard?: boolean }): void {
  if (pushTimer) clearTimeout(pushTimer);
  const discard = opts?.discard === true || store.workspaceOrder.length === 0;
  // The host writes what the TUI last pushed, so make that the current layout —
  // a split or a rename from the last few hundred ms is otherwise lost.
  if (!discard) pushLayoutNow();
  persistEnabled = false;
  hostSend({ t: "quit", discard });
  registry.disposeAll();
  onQuit(0);
}

/**
 * Dev reload: exit with the magic code — the daemon respawns the TUI from the
 * current source. The surfaces are NOT ours to lose: they live in the daemon's
 * pty host and are adopted again on the way back up, so whatever is running in
 * them (agents included) keeps running across the reload. All we do here is
 * make sure the host has the current layout. No-op when not under a daemon.
 */
export function reloadApp(): void {
  if (!process.env.GHOSTTOWN_ATTACH_SOCKET) return;
  pushLayoutNow();
  setConfigForTest(null);
  // A beat for the layout frame to reach the host before the socket dies.
  setTimeout(() => onQuit(RELOAD_EXIT_CODE), 50);
}

/**
 * Restart: the daemon steps down and the attach client starts its replacement,
 * so BOTH halves come back on current source. That is the difference from a
 * reload, which respawns only the TUI and leaves the daemon — and with it the
 * pty host — running whatever code it booted with. A change under
 * src/attach/ptyhost.ts is invisible until this runs.
 *
 * The price is the thing a reload was built to avoid: the surface PTYs belong
 * to the daemon, so every shell and agent in the panes dies with it. What
 * survives is the shape of the session — the daemon flushes its snapshot on
 * the way out (while the pids are still alive, so each surface's live cwd is
 * recorded) and the next TUI restores from it, bringing back workspaces, panes,
 * tabs, names and directories with fresh shells in them.
 *
 * No-op when not under a daemon: with GHOSTTOWN_NO_DAEMON=1 there is nothing
 * to restart into.
 */
export function restartApp(): void {
  if (!process.env.GHOSTTOWN_ATTACH_SOCKET) return;
  pushLayoutNow();
  // From here the surfaces are going to die, and none of those deaths mean
  // what a death normally means (see onExit in hostEvents).
  tearingDown = true;
  // Same beat as a reload — the layout frame has to land before we ask the
  // daemon to snapshot it and go.
  setTimeout(() => sendDaemonCmd({ t: "cmd", cmd: "restart" }), 50);
}

/**
 * Fire-and-forget command frames at a session daemon's attach socket. Frames go
 * out in order on one connection, which is what lets a pair like
 * switch-then-kill be sent as a single decision.
 *
 * `onUnreachable` runs when there is no daemon at that path — for another
 * profile that means the socket is a leftover from a crash.
 */
function sendAttachCmds(
  path: string,
  frames: Record<string, unknown>[],
  onUnreachable?: () => void,
): void {
  let delivered = false;
  Bun.connect({
    unix: path,
    socket: {
      open(s) {
        delivered = true;
        for (const frame of frames) s.write(JSON.stringify(frame) + "\n");
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
      error() {
        if (!delivered) onUnreachable?.();
      },
      close() {},
    },
  }).catch(() => {
    if (!delivered) onUnreachable?.();
  });
}

/**
 * Our own daemon's attach socket. Derived from the session name rather than read
 * from GHOSTTOWN_ATTACH_SOCKET: a rename moves the file, which would leave that
 * variable pointing at a path the daemon no longer answers on. Its presence is
 * still what says whether there is a daemon at all (GHOSTTOWN_NO_DAEMON).
 */
function ownAttachSocket(): string | null {
  if (!process.env.GHOSTTOWN_ATTACH_SOCKET) return null;
  return attachSocketPathFor(store.session);
}

/** Fire-and-forget a command frame at our own attach daemon. */
function sendDaemonCmd(frame: Record<string, unknown>): void {
  const path = ownAttachSocket();
  if (!path) return; // GHOSTTOWN_NO_DAEMON: nothing to talk to
  sendAttachCmds(path, [frame]);
}

/** Detach every attached client; the session keeps running in the daemon. */
export function detachClients(): void {
  sendDaemonCmd({ t: "cmd", cmd: "detach" });
}

// ---------------------------------------------------------------------------
// Profiles (= sessions; each one is its own daemon)
// ---------------------------------------------------------------------------

/** Every profile with a daemon socket, plus the current one. Sorted. */
/**
 * Every profile the switcher can offer: the running ones, plus the ones that
 * exist only as a saved layout. That second half is what makes a stopped profile
 * findable — the sockets it used to be listed from live under /tmp and do not
 * survive a reboot, so without this an afternoon's worth of arranging would be
 * unreachable unless you happened to remember the name to pass to --session.
 */
export function listProfiles(): string[] {
  const names = new Set<string>([store.session, ...runningSessions()]);
  for (const saved of listSaved()) names.add(saved.session);
  return [...names].sort();
}

/**
 * The switcher, which doubles as the place profiles are managed from: a new one,
 * a rename, a kill. `select` puts the cursor on a specific profile (coming back
 * from one of those dialogs); `exclude` drops one that is on its way out but
 * whose socket has not disappeared yet.
 */
export function openSwitchProfile(select?: string, exclude?: string): void {
  const sessions = listProfiles().filter((name) => name !== exclude);
  const running = new Set([store.session, ...runningSessions()]);
  setDialog({
    kind: "switch-profile",
    sessions,
    stopped: sessions.filter((name) => !running.has(name)),
    idx: Math.max(0, sessions.indexOf(select ?? store.session)),
  });
}

/** `back`: opened with `a` from the switcher, so esc returns there. */
export function openNewProfile(back = false): void {
  setDialog({ kind: "new-profile", value: "", back });
}

/** The profile the switcher has selected right now, if it is open. */
function selectedProfile(): string | null {
  const d = store.dialog;
  return d?.kind === "switch-profile" ? (d.sessions[d.idx] ?? null) : null;
}

export function openRenameProfile(name = selectedProfile()): void {
  if (!name) return;
  setDialog({ kind: "rename-profile", session: name, value: name });
}

export function openDeleteProfile(name = selectedProfile()): void {
  if (!name) return;
  setDialog({ kind: "confirm-delete-profile", session: name });
}

/** True when `value` is a name this profile could actually be renamed to. */
export function canRenameProfileTo(from: string, value: string): boolean {
  const to = sanitizeSessionName(value);
  if (!to || to === from) return false;
  return !listProfiles().includes(to);
}

/**
 * Rename a profile — this one or any other running one. Its daemon owns every
 * path the name appears in, so it does the work (see attach/daemon.ts); the
 * new name comes back to us as a set-session control request.
 */
export function renameProfile(from: string, value: string): void {
  if (!canRenameProfileTo(from, value)) return;
  const to = sanitizeSessionName(value);
  if (from === store.session && !ownAttachSocket()) return; // no daemon to rename
  dbg("renameProfile", from, "→", to);
  sendAttachCmds(attachSocketPathFor(from), [{ t: "cmd", cmd: "rename", session: to }]);
}

/**
 * The TUI's own record of which profile it is. Called from the control server
 * when the daemon reports a rename; `newSocketPath` is the control socket
 * surfaces spawned from now on should be told about.
 */
export function setSessionName(name: string, newSocketPath?: string): void {
  if (!name || name === store.session) return;
  dbg("session renamed to", name);
  if (newSocketPath) socketPath = newSocketPath;
  setStore("session", name);
  // The snapshot is keyed by profile name; get the new one on disk promptly.
  pushLayoutNow();
}

/**
 * What confirming a profile delete will do. Killing the profile you are *in*
 * has to send this client somewhere: another running profile if there is one,
 * and otherwise nowhere — which makes it a quit.
 */
export function profileDeleteTarget(name: string): { self: boolean; landsOn: string | null } {
  if (name !== store.session) return { self: false, landsOn: null };
  const others = listProfiles().filter((n) => n !== name);
  return { self: true, landsOn: others[0] ?? null };
}

/**
 * Delete a profile and everything in it: its daemon stops every surface (agents
 * included), removes its sockets and retires the session snapshot. The layout
 * goes to the archive rather than /dev/null, so `gt restore` can undo a
 * mis-aimed confirm — but as far as the switcher is concerned the profile is
 * gone. Merely *stopping* a profile is `kill`, which keeps everything.
 */
export function deleteProfile(name: string): void {
  const target = sanitizeSessionName(name);
  if (!target) return;
  const { self, landsOn } = profileDeleteTarget(target);
  dbg("deleteProfile", target, { self, landsOn });

  if (!self) {
    // Another profile: tell its daemon to tear itself down and retire its own
    // snapshot — it owns that file, and doing it from here would race the flush
    // on its way out. A socket nothing answers on is the leftover of a crash (or
    // a profile that only exists on disk) — clean up after it ourselves.
    sendAttachCmds(attachSocketPathFor(target), [{ t: "cmd", cmd: "delete" }], () =>
      forgetDeadProfile(target),
    );
    // Its socket lingers for a moment; keep managing profiles without it.
    openSwitchProfile(undefined, target);
    return;
  }
  const own = ownAttachSocket();
  // Nowhere to send the clients — the only profile left, or no daemon to move
  // them with — makes this a quit. `discard` because it is still a delete: an
  // ordinary quit would keep the layout for next time.
  if (!own || !landsOn) {
    quit({ discard: true });
    return;
  }
  // Move the clients to the surviving profile first, then pull this one down:
  // a delete on its own would drop the user out of ghosttown altogether.
  sendAttachCmds(own, [
    { t: "cmd", cmd: "switch", session: landsOn },
    { t: "cmd", cmd: "delete" },
  ]);
}

/** A profile whose daemon is gone: remove what it left behind. */
function forgetDeadProfile(name: string): void {
  dbg("deleteProfile: no daemon, cleaning up after", name);
  for (const path of [
    attachSocketPathFor(name),
    hostSocketPathFor(name),
    socketPathFor(name),
  ]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // already gone
    }
  }
  retireSnapshot(name);
}

/**
 * Jump this client to another profile. The daemon tells the attach clients
 * to reconnect to the target session (starting its daemon if needed); this
 * session keeps running detached in the background.
 */
export function switchProfile(name: string): void {
  const target = sanitizeSessionName(name);
  if (!target || target === store.session) return;
  dbg("switchProfile", target);
  sendDaemonCmd({ t: "cmd", cmd: "switch", session: target });
}
