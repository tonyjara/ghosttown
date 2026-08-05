/**
 * Session snapshots — tmux-resurrect/continuum, minus the guesswork.
 *
 * A crash or a reboot takes the whole layout with it, so this module keeps a
 * small JSON snapshot of the *structure* in the XDG state dir and hands it
 * back on the next start: workspaces, split ratios, panes, tab order, and the
 * directory each surface was sitting in.
 *
 * What it deliberately does NOT do is restore processes — a restored surface
 * is a fresh shell in its old cwd. A TUI *reload* doesn't come through here at
 * all: the pty host still holds those surfaces, so they are adopted alive
 * (src/attach/ptyhost.ts), and the snapshot is only the cold-start fallback.
 *
 * The pty host writes the file, since it owns the pids the cwds come from;
 * state.ts serializes the structure and sends it over.
 *
 * A layout is *organized work* — it can take longer to arrange than the panes
 * take to fill — so nothing here destroys one outright. Ending processes never
 * touches the file (that is what stopping a session means), and the two places
 * that do retire a snapshot — deleting a profile, and a write that would shrink
 * one — move it into `archive/` instead of unlinking it. `gt profiles -a` lists
 * what is in there and `gt restore` puts one back.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dbg } from "./debug";
import type { LayoutNode } from "./types";

/** Bumped whenever the shape below changes; older files are ignored. */
export const SNAPSHOT_VERSION = 3;

export interface PersistedSurface {
  /** Host-side surface id — how a reloaded TUI finds the live pty again. */
  id: string;
  /** Where the shell was; null when it could not be read. */
  cwd: string | null;
  /** The name the user gave this tab (rename-tab), if any. */
  title?: string | null;
}

export interface PersistedPane {
  id: string;
  activeIdx: number;
  surfaces: PersistedSurface[];
}

export interface PersistedWorkspace {
  id: string;
  name: string;
  /** Split tree, referencing the pane ids above — restored verbatim. */
  layout: LayoutNode | null;
  focusedPaneId: string;
  panes: PersistedPane[];
}

export interface PersistedSession {
  version: number;
  session: string;
  savedAt: number;
  activeWorkspaceId: string;
  sidebarVisible: boolean;
  /**
   * Sidebar agent order, by surface id — only the rows shift+J/K moved. Optional
   * on purpose, so it needs no version bump: an older file simply has none, and
   * an older daemon writing this one back drops it. Surface ids survive a reload
   * (the host still owns those ptys) but not a cold start, where every surface is
   * respawned — so this is a reload-scoped nicety, and stale ids are pruned on
   * the next write.
   */
  agentOrder?: string[];
  workspaces: PersistedWorkspace[];
}

/** Durable, unlike the socket dir under /tmp (wiped on reboot). */
export function stateDir(): string {
  if (process.env.GHOSTTOWN_STATE_DIR) return process.env.GHOSTTOWN_STATE_DIR;
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "ghosttown");
}

const SUFFIX = ".session.json";

/**
 * Profile names are already path-safe (see dialogChar), but a stray slash from
 * --session would escape the directory.
 */
const safeName = (session: string) => session.replace(/[^\w.-]/g, "_");

export function snapshotPath(session: string): string {
  return join(stateDir(), `${safeName(session)}${SUFFIX}`);
}

/** Retired snapshots, kept beside the live ones. See archiveSnapshot. */
export function archiveDir(): string {
  return join(stateDir(), "archive");
}

/** How many retired snapshots to keep — per profile, so one cannot evict another. */
export const ARCHIVE_KEEP = 20;

const archivePathAt = (session: string, stamp: number) =>
  join(archiveDir(), `${safeName(session)}.${stamp}${SUFFIX}`);

/** Workspaces + panes + tabs: the unit a "this layout got smaller" check counts in. */
function structureSize(snap: PersistedSession): number {
  let n = 0;
  for (const ws of snap.workspaces ?? []) {
    n += 1;
    for (const pane of ws.panes ?? []) n += 1 + (pane.surfaces?.length ?? 0);
  }
  return n;
}

/** Parse with no version gate: a file this build cannot use is still worth keeping. */
function readRaw(path: string): PersistedSession | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedSession;
    return parsed && Array.isArray(parsed.workspaces) ? parsed : null;
  } catch {
    return null;
  }
}

export interface ArchivedSnapshot {
  path: string;
  /** Profile it belonged to — read from the file, not parsed out of the name. */
  session: string;
  savedAt: number;
  version: number;
  workspaces: number;
  surfaces: number;
}

/**
 * Retire the live snapshot instead of deleting it: it moves to
 * `archive/<profile>.<savedAt>.session.json`, oldest falling off past
 * ARCHIVE_KEEP. Returns where it landed, or null if there was nothing to move.
 */
export function archiveSnapshot(session: string): string | null {
  const from = snapshotPath(session);
  if (!existsSync(from)) return null;
  try {
    mkdirSync(archiveDir(), { recursive: true, mode: 0o700 });
    const saved = readRaw(from)?.savedAt;
    const stamp = Math.round(Number(saved) || statSync(from).mtimeMs);
    let to = archivePathAt(session, stamp);
    // Two retirements can share a millisecond; nudge rather than overwrite.
    for (let n = 1; existsSync(to) && n < 1000; n++) to = archivePathAt(session, stamp + n);
    renameSync(from, to);
    pruneArchive(session);
    dbg("persist: archived", from, "→", to);
    return to;
  } catch (err) {
    dbg("persist: archive failed", from, err as Error);
    return null;
  }
}

/**
 * Remove the file outright. Only for a rename, where the very same layout is
 * rewritten under the new profile name a moment later — everything else that
 * retires a snapshot goes through retireSnapshot.
 */
export function dropSnapshot(session: string): void {
  try {
    rmSync(snapshotPath(session), { force: true });
  } catch (err) {
    dbg("persist: drop failed", err as Error);
  }
}

/**
 * This profile is going away for good (an explicit delete). Archive rather than
 * unlink so a mis-aimed confirm stays recoverable — but if the archive cannot
 * be written, the file still has to go, or the profile would come back.
 */
export function retireSnapshot(session: string): string | null {
  const to = archiveSnapshot(session);
  if (!to && existsSync(snapshotPath(session))) dropSnapshot(session);
  return to;
}

/** Archived snapshots, newest first; for one profile or all of them. */
export function listArchived(session?: string): ArchivedSnapshot[] {
  const out: ArchivedSnapshot[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(archiveDir());
  } catch {
    return out; // nothing retired yet
  }
  const prefix = session ? `${safeName(session)}.` : "";
  for (const f of files) {
    if (!f.endsWith(SUFFIX) || !f.startsWith(prefix)) continue;
    const path = join(archiveDir(), f);
    const snap = readRaw(path);
    if (!snap) continue;
    if (session && snap.session !== session) continue;
    out.push(describe(path, snap));
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

function describe(path: string, snap: PersistedSession): ArchivedSnapshot {
  let surfaces = 0;
  for (const ws of snap.workspaces) for (const p of ws.panes ?? []) surfaces += p.surfaces?.length ?? 0;
  let savedAt = Number(snap.savedAt) || 0;
  if (!savedAt) {
    try {
      savedAt = statSync(path).mtimeMs;
    } catch {
      savedAt = 0;
    }
  }
  return {
    path,
    session: snap.session,
    savedAt,
    version: Number(snap.version) || 0,
    workspaces: snap.workspaces.length,
    surfaces,
  };
}

function pruneArchive(session: string): void {
  for (const old of listArchived(session).slice(ARCHIVE_KEEP)) {
    try {
      rmSync(old.path, { force: true });
    } catch {
      // already gone
    }
  }
}

/**
 * Every profile with a snapshot this build could actually restore. What makes a
 * stopped profile findable: the sockets it was listed from live in /tmp and do
 * not survive a reboot, but this does.
 */
export function listSaved(): ArchivedSnapshot[] {
  const out: ArchivedSnapshot[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(stateDir());
  } catch {
    return out;
  }
  for (const f of files) {
    if (!f.endsWith(SUFFIX)) continue;
    const path = join(stateDir(), f);
    const snap = readRaw(path);
    if (!snap?.session || snap.version !== SNAPSHOT_VERSION || snap.workspaces.length === 0) continue;
    out.push(describe(path, snap));
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Put an archived snapshot back as its profile's live one, retiring whatever is
 * there now — so this is itself undoable. The file is copied verbatim: a
 * version this build cannot read is the caller's problem to report.
 */
export function restoreArchived(path: string): ArchivedSnapshot | null {
  const snap = readRaw(path);
  if (!snap?.session) return null;
  archiveSnapshot(snap.session);
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    writeFileSync(snapshotPath(snap.session), JSON.stringify(snap), { mode: 0o600 });
  } catch (err) {
    dbg("persist: restore failed", path, err as Error);
    return null;
  }
  return describe(path, snap);
}

/** Atomic: a half-written snapshot is worse than a stale one. */
export function writeSnapshot(snap: PersistedSession): void {
  const path = snapshotPath(snap.session);
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    archiveIfShrinking(path, snap);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    dbg("persist: write failed", path, err as Error);
  }
}

/**
 * The write that can cost real work is a *smaller* layout landing on a bigger
 * one: a session that started fresh over a snapshot it could not read, or a
 * whole workspace closed by accident. Keep the old copy before it goes under.
 * A single closed tab is not worth a file — losing a workspace, or two units of
 * structure at once, is.
 */
function archiveIfShrinking(path: string, next: PersistedSession): void {
  if (!existsSync(path)) return;
  const prev = readRaw(path);
  if (!prev) return;
  const lost = structureSize(prev) - structureSize(next);
  if (lost < 2 && prev.workspaces.length <= next.workspaces.length) return;
  dbg("persist: layout shrank, archiving first", {
    was: structureSize(prev),
    now: structureSize(next),
  });
  archiveSnapshot(next.session);
}

export function readSnapshot(session: string): PersistedSession | null {
  const path = snapshotPath(session);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedSession;
    if (parsed?.version !== SNAPSHOT_VERSION) {
      // Used to be a silent loss: unreadable here, then overwritten by the
      // fresh session that started in its place.
      dbg("persist: ignoring snapshot from another version", parsed?.version);
      archiveSnapshot(session);
      return null;
    }
    if (!Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) return null;
    return parsed;
  } catch (err) {
    dbg("persist: unreadable snapshot", path, err as Error);
    archiveSnapshot(session);
    return null;
  }
}

/** -Fpn prints "p<pid>" then "n<path>" per open file; -d cwd keeps one each. */
const LSOF_ARGS = (pids: number[]) => ["lsof", "-a", "-d", "cwd", "-p", pids.join(","), "-Fpn"];

function parseLsof(stdout: string): Map<number, string> {
  const out = new Map<number, string>();
  let pid = 0;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1)) || 0;
    else if (line.startsWith("n") && pid) out.set(pid, line.slice(1));
  }
  return out;
}

/** /proc is a cheap syscall; only macOS needs to shell out. */
function procCwds(pids: number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const pid of pids) {
    try {
      out.set(pid, readlinkSync(`/proc/${pid}/cwd`));
    } catch {
      // process gone, or not ours
    }
  }
  return out;
}

const livePids = (pids: number[]) => pids.filter((p) => Number.isInteger(p) && p > 0);

/**
 * Working directory of each pid, blocking (~40ms for an `lsof` on macOS).
 * Only for the exit paths, where there is no later to write in.
 */
export function readCwds(pids: number[]): Map<number, string> {
  const live = livePids(pids);
  if (live.length === 0) return new Map();
  if (process.platform === "linux") return procCwds(live);
  try {
    const res = Bun.spawnSync(LSOF_ARGS(live));
    return parseLsof(new TextDecoder().decode(res.stdout));
  } catch (err) {
    dbg("persist: lsof failed", err as Error);
    return new Map();
  }
}

/**
 * Fill in each surface's cwd from a surface-id → directory map. Surfaces
 * missing from it keep the directory already in the snapshot, so a transient
 * lsof failure never erases what we knew a minute ago.
 */
export function withCwds(
  snap: PersistedSession,
  cwdBySurface: Map<string, string>,
): PersistedSession {
  return {
    ...snap,
    workspaces: snap.workspaces.map((ws) => ({
      ...ws,
      panes: ws.panes.map((pane) => ({
        ...pane,
        surfaces: pane.surfaces.map((s) => ({
          ...s,
          cwd: cwdBySurface.get(s.id) ?? s.cwd ?? null,
        })),
      })),
    })),
  };
}

/** Surface id → cwd, for everything the snapshot already knows about. */
export function cwdsOf(snap: PersistedSession | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const ws of snap?.workspaces ?? []) {
    for (const pane of ws.panes) {
      for (const s of pane.surfaces) if (s.cwd) out.set(s.id, s.cwd);
    }
  }
  return out;
}

/** Same, off the render thread — every save but the last one takes this path. */
export async function readCwdsAsync(pids: number[]): Promise<Map<number, string>> {
  const live = livePids(pids);
  if (live.length === 0) return new Map();
  if (process.platform === "linux") return procCwds(live);
  try {
    const proc = Bun.spawn(LSOF_ARGS(live), { stdout: "pipe", stderr: "ignore" });
    return parseLsof(await new Response(proc.stdout).text());
  } catch (err) {
    dbg("persist: lsof failed", err as Error);
    return new Map();
  }
}
