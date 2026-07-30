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
 */
import { existsSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  workspaces: PersistedWorkspace[];
}

/** Durable, unlike the socket dir under /tmp (wiped on reboot). */
export function stateDir(): string {
  if (process.env.GHOSTTOWN_STATE_DIR) return process.env.GHOSTTOWN_STATE_DIR;
  const xdg = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "ghosttown");
}

export function snapshotPath(session: string): string {
  // Profile names are already path-safe (see dialogChar), but a stray slash
  // from --session would escape the directory.
  return join(stateDir(), `${session.replace(/[^\w.-]/g, "_")}.session.json`);
}

/** Atomic: a half-written snapshot is worse than a stale one. */
export function writeSnapshot(snap: PersistedSession): void {
  const path = snapshotPath(snap.session);
  try {
    mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap), { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    dbg("persist: write failed", path, err as Error);
  }
}

export function readSnapshot(session: string): PersistedSession | null {
  const path = snapshotPath(session);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedSession;
    if (parsed?.version !== SNAPSHOT_VERSION) {
      dbg("persist: ignoring snapshot from another version", parsed?.version);
      return null;
    }
    if (!Array.isArray(parsed.workspaces) || parsed.workspaces.length === 0) return null;
    return parsed;
  } catch (err) {
    dbg("persist: unreadable snapshot", path, err as Error);
    return null;
  }
}

/** An explicit quit means "this session is over" — don't resurrect it. */
export function deleteSnapshot(session: string): void {
  try {
    rmSync(snapshotPath(session), { force: true });
  } catch (err) {
    dbg("persist: delete failed", err as Error);
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
