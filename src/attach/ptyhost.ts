/**
 * The pty host: owner of every surface PTY (shells, agents) in a session.
 *
 * This lives in the daemon, not in the TUI, and that is the whole point — the
 * TUI can be restarted (prefix+R, or a `bun --watch` reload while developing)
 * and the programs running in the panes never notice. The TUI reconnects,
 * re-adopts each surface by id, and rebuilds its emulators from the replay
 * buffers kept here.
 *
 * It also owns everything about a surface that must outlive the UI: the output
 * scanner (terminal query answers, OSC titles, mouse modes), the status
 * tracker, and the layout snapshot on disk (the pids the cwds come from are
 * here).
 *
 * Deliberately UI-free: nothing in this file may import solid/opentui, so the
 * daemon stays a lean process that cannot be broken by a UI-side error.
 */
import { spawn, type IPty } from "bun-pty";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import {
  hostSocketPathFor,
  defaultSocketDir,
  type HostClientFrame,
  type HostServerFrame,
  type HostSurfaceInfo,
} from "../control/protocol";
import { SocketWriter } from "../control/sockbuf";
import { MOUSE_MODES_OFF, type MouseModes } from "../core/mouse";
import {
  cwdsOf,
  deleteSnapshot,
  readCwds,
  readCwdsAsync,
  withCwds,
  writeSnapshot,
  type PersistedSession,
} from "../core/persist";
import { cursorReport, OutputScanner } from "../core/queries";
import { StatusTracker } from "../core/status";
import type { AgentStatus } from "../core/types";

/** Replay kept per surface. 512 KB reconstructs a full screen many times over. */
const DEFAULT_REPLAY_BYTES = 512 * 1024;
/** How long a deferred cursor report waits for the TUI before guessing. */
const CPR_TIMEOUT_MS = 80;
/** Status heuristic tick, matching what the TUI used to run. */
const TICK_MS = 500;
/** Coalesces layout bursts (a divider drag emits one per step). */
const SAVE_DEBOUNCE_MS = 750;
/** Continuum-style heartbeat, mostly to notice `cd`s nothing else reports. */
const SAVE_INTERVAL_MS = 30_000;

export type Sender = (frame: HostServerFrame) => void;

function replayBytes(): number {
  const raw = Number(process.env.GHOSTTOWN_REPLAY_BYTES);
  if (Number.isFinite(raw) && raw >= 4096) return Math.floor(raw);
  return DEFAULT_REPLAY_BYTES;
}

/**
 * Raw output kept so a restarting TUI can rebuild an emulator by re-feeding
 * the same bytes. Whole chunks are dropped from the front once the cap is hit.
 *
 * Two details make a trimmed buffer replay cleanly. The window is opened at
 * the first ESC in what is left, because a window that starts in the middle of
 * an escape sequence has its first bytes eaten as that sequence's parameters.
 * And the private modes the program has set (alt screen, mouse reporting,
 * cursor visibility) are replayed as a prelude, since the bytes that set them
 * are usually the first thing to be trimmed away.
 */
export class ReplayBuffer {
  private chunks: string[] = [];
  private bytes = 0;
  private trimmed = false;
  private modes = new Map<string, boolean>();
  private modeTail = "";

  constructor(private cap = replayBytes()) {}

  push(chunk: string): void {
    this.trackModes(chunk);
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.cap && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()!.length;
      this.trimmed = true;
    }
  }

  /** Bytes to feed a fresh emulator so it shows what this surface shows. */
  replay(): string {
    const tail = this.chunks.join("");
    if (!this.trimmed) return tail;
    let prelude = "";
    for (const [mode, on] of this.modes) prelude += `\x1b[?${mode}${on ? "h" : "l"}`;
    const esc = tail.indexOf("\x1b");
    return `${prelude}\x1b[m${esc === -1 ? tail : tail.slice(esc)}`;
  }

  private trackModes(chunk: string): void {
    const s = this.modeTail + chunk;
    this.modeTail = s.slice(-16);
    const re = /\x1b\[\?([0-9;]+)([hl])/g;
    let m: RegExpExecArray | null;
    // Re-scanning the carried tail can apply a mode twice — idempotent.
    while ((m = re.exec(s))) {
      for (const mode of m[1]!.split(";")) this.modes.set(mode, m[2] === "h");
    }
  }
}

interface HostedSurface {
  id: string;
  command: string;
  title: string;
  pty: IPty | null;
  tracker: StatusTracker;
  scanner: OutputScanner;
  replay: ReplayBuffer;
  modes: MouseModes;
  /** Last cursor the TUI reported, used when no TUI is attached to ask. */
  cursor: [number, number];
  cols: number;
  rows: number;
  everActive: boolean;
  lastActiveAt: number | null;
  exited: boolean;
}

export interface PtyHost {
  /** Feed one client frame. `send` is that client's reply channel. */
  handle(frame: HostClientFrame, send: Sender): void;
  /** A client went away; stop streaming to it. */
  detach(send: Sender): void;
  /** Kill every surface and stop the timers (daemon shutdown). */
  closeAll(): void;
  /** Blocking snapshot write, for the way out. */
  flushSnapshotSync(): void;
  surfaceCount(): number;
}

export interface PtyHostOpts {
  session: string;
  log?: (...parts: unknown[]) => void;
}

export function createPtyHost(opts: PtyHostOpts): PtyHost {
  const log = opts.log ?? (() => {});
  const surfaces = new Map<string, HostedSurface>();
  /** The attached TUI, or null while it is restarting. */
  let client: Sender | null = null;
  let persist = false;
  let layout: PersistedSession | null = null;
  let cprSeq = 0;
  const pendingCpr = new Map<
    number,
    { id: string; priv: string; timer: ReturnType<typeof setTimeout> }
  >();
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let savingNow = false;

  const emit = (frame: HostServerFrame): void => {
    client?.(frame);
  };

  const write = (s: HostedSurface, data: string): void => {
    if (!s.pty) return;
    try {
      s.pty.write(data);
    } catch {
      // pty exited under us
    }
  };

  const info = (s: HostedSurface): HostSurfaceInfo => ({
    id: s.id,
    title: s.title,
    command: s.command,
    status: s.tracker.status,
    hasReporter: s.tracker.hasReporter,
    everActive: s.everActive,
    lastActiveAt: s.lastActiveAt,
    exited: s.exited,
  });

  // --- snapshot -----------------------------------------------------------

  /** Live pids, and which surface each belongs to. */
  const pids = (): Array<[string, number]> =>
    [...surfaces.values()].filter((s) => s.pty).map((s) => [s.id, s.pty!.pid]);

  const cwdBySurface = (owners: Array<[string, number]>, byPid: Map<number, string>) => {
    const out = new Map<string, string>();
    for (const [id, pid] of owners) {
      const cwd = byPid.get(pid);
      if (cwd) out.set(id, cwd);
    }
    return out;
  };

  /** Keep the in-memory copy current too: it is what a reload boots from. */
  const stamp = (owners: Array<[string, number]>, byPid: Map<number, string>): void => {
    if (!layout) return;
    layout = withCwds(layout, cwdBySurface(owners, byPid));
  };

  const saveSnapshot = async (): Promise<void> => {
    if (savingNow || !layout) return;
    savingNow = true;
    try {
      const owners = pids();
      stamp(owners, await readCwdsAsync(owners.map(([, pid]) => pid)));
      if (layout && persist) writeSnapshot(layout);
    } finally {
      savingNow = false;
    }
  };

  const scheduleSave = (): void => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void saveSnapshot();
    }, SAVE_DEBOUNCE_MS);
  };

  const flushSnapshotSync = (): void => {
    if (!layout) return;
    const owners = pids();
    stamp(owners, readCwds(owners.map(([, pid]) => pid)));
    if (layout && persist) writeSnapshot(layout);
  };

  // --- surfaces -----------------------------------------------------------

  const setStatus = (s: HostedSurface, status: AgentStatus): void => {
    if (status !== "idle") {
      s.everActive = true;
      s.lastActiveAt = Date.now();
    }
    emit({ t: "status", id: s.id, status, hasReporter: s.tracker.hasReporter });
  };

  const spawnSurface = (frame: Extract<HostClientFrame, { t: "spawn" }>): void => {
    if (surfaces.has(frame.id)) return;
    const cols = Math.max(2, frame.cols);
    const rows = Math.max(1, frame.rows);
    const s: HostedSurface = {
      id: frame.id,
      command: frame.command,
      title: frame.command.split("/").pop() ?? frame.command,
      pty: null,
      // Both need `s` itself in their callbacks; assigned right below.
      tracker: null as unknown as StatusTracker,
      scanner: null as unknown as OutputScanner,
      replay: new ReplayBuffer(),
      modes: MOUSE_MODES_OFF,
      cursor: [0, 0],
      cols,
      rows,
      everActive: false,
      lastActiveAt: null,
      exited: false,
    };
    s.tracker = new StatusTracker((status) => setStatus(s, status));
    s.scanner = new OutputScanner({
      respond: (data) => write(s, data),
      getCursor: () => s.cursor,
      deferCursorReport: (priv) => {
        if (!client) return false; // no TUI to ask; answer from the cache
        const seq = ++cprSeq;
        const timer = setTimeout(() => {
          pendingCpr.delete(seq);
          write(s, cursorReport(priv, s.cursor[0], s.cursor[1]));
        }, CPR_TIMEOUT_MS);
        pendingCpr.set(seq, { id: s.id, priv, timer });
        emit({ t: "cpr-req", id: s.id, seq });
        return true;
      },
      onTitle: (title) => {
        const trimmed = title.trim().slice(0, 60);
        if (!trimmed || trimmed === s.title) return;
        s.title = trimmed;
        emit({ t: "title", id: s.id, title: trimmed });
      },
      onNotify: (title, body) => emit({ t: "notify", id: s.id, title, body }),
    });
    surfaces.set(s.id, s);

    try {
      s.pty = spawn(frame.command, frame.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: frame.cwd && existsSync(frame.cwd) ? frame.cwd : process.cwd(),
        env: frame.env,
      });
    } catch (err) {
      log("spawn failed", frame.command, err as Error);
      s.exited = true;
      emit({ t: "exit", id: s.id, code: 1 });
      return;
    }

    s.pty.onData((chunk) => {
      // Out to the TUI *before* scanning: frames arrive in order and are fed
      // synchronously, so a cursor query inside this chunk is answered from an
      // emulator that has already consumed the chunk. Scanning first would
      // report the position from before it.
      s.replay.push(chunk);
      emit({ t: "o", id: s.id, d: Buffer.from(chunk).toString("base64") });
      s.scanner.scan(chunk);
      s.tracker.recordOutput();
      const modes = s.scanner.mouseModes();
      if (modes !== s.modes) {
        s.modes = modes;
        emit({ t: "modes", id: s.id, modes });
      }
    });
    s.pty.onExit(({ exitCode }) => {
      s.pty = null;
      s.exited = true;
      // Kept in the map: a TUI that is mid-restart still has to hear about it.
      emit({ t: "exit", id: s.id, code: exitCode });
    });
    log("spawned surface", s.id, frame.command);
  };

  const killSurface = (id: string): void => {
    const s = surfaces.get(id);
    if (!s) return;
    surfaces.delete(id);
    try {
      s.pty?.kill();
    } catch {
      // already dead
    }
  };

  const tick = setInterval(() => {
    for (const s of surfaces.values()) s.tracker.tick();
  }, TICK_MS);
  const saveInterval = setInterval(() => void saveSnapshot(), SAVE_INTERVAL_MS);

  // --- frame handling -----------------------------------------------------

  const handle = (frame: HostClientFrame, send: Sender): void => {
    switch (frame.t) {
      case "hello": {
        client = send;
        persist = !!frame.persist;
        log("tui attached", { surfaces: surfaces.size, hasLayout: !!layout });
        send({
          t: "boot",
          surfaces: [...surfaces.values()].map(info),
          layout,
        });
        return;
      }
      case "spawn":
        spawnSurface(frame);
        return;
      case "sub": {
        // Whoever subscribes becomes the stream target: a reconnecting TUI
        // must not have its output still going to a dead socket.
        client = send;
        const s = surfaces.get(frame.id);
        if (!s) return;
        send({ t: "snap", id: frame.id, d: Buffer.from(s.replay.replay()).toString("base64") });
        return;
      }
      case "w": {
        const s = surfaces.get(frame.id);
        if (!s) return;
        s.tracker.recordInput();
        write(s, Buffer.from(frame.d, "base64").toString("utf8"));
        return;
      }
      case "m": {
        const s = surfaces.get(frame.id);
        // Not recorded as input: ?1003 reports every motion, which would keep
        // resetting the status heuristic as the pointer crosses the pane.
        if (s) write(s, Buffer.from(frame.d, "base64").toString("utf8"));
        return;
      }
      case "resize": {
        const s = surfaces.get(frame.id);
        if (!s) return;
        const cols = Math.max(2, frame.cols);
        const rows = Math.max(1, frame.rows);
        if (cols === s.cols && rows === s.rows) return;
        s.cols = cols;
        s.rows = rows;
        try {
          s.pty?.resize(cols, rows);
        } catch {
          // pty exited under us
        }
        return;
      }
      case "kill":
        killSurface(frame.id);
        return;
      case "report": {
        const s = surfaces.get(frame.id);
        if (!s) return;
        const changed = s.tracker.status !== frame.status;
        s.tracker.report(frame.status); // emits through onChange when it changed
        // Reported-but-unchanged still has to go out, so the TUI learns this
        // surface has a reporter (and stops guessing from output).
        if (!changed) setStatus(s, frame.status);
        return;
      }
      case "cpr": {
        const pending = pendingCpr.get(frame.seq);
        if (!pending) return; // timed out; already answered from the cache
        clearTimeout(pending.timer);
        pendingCpr.delete(frame.seq);
        const s = surfaces.get(pending.id);
        if (!s) return;
        s.cursor = [Math.max(0, frame.x), Math.max(0, frame.y)];
        write(s, cursorReport(pending.priv, s.cursor[0], s.cursor[1]));
        return;
      }
      case "layout":
        // The TUI sends structure only; the directories we already know about
        // carry over until the next lsof pass fills them in again.
        layout = withCwds(frame.data, cwdsOf(layout));
        scheduleSave();
        return;
      case "quit":
        // An explicit quit is a decision: nothing to resurrect next time.
        persist = false;
        layout = null;
        deleteSnapshot(opts.session);
        for (const id of [...surfaces.keys()]) killSurface(id);
        return;
    }
  };

  return {
    handle,
    detach(send) {
      if (client === send) {
        client = null;
        log("tui detached; surfaces keep running");
      }
    },
    closeAll() {
      clearInterval(tick);
      clearInterval(saveInterval);
      if (saveTimer) clearTimeout(saveTimer);
      for (const { timer } of pendingCpr.values()) clearTimeout(timer);
      pendingCpr.clear();
      for (const id of [...surfaces.keys()]) killSurface(id);
      client = null;
    },
    flushSnapshotSync,
    surfaceCount: () => surfaces.size,
  };
}

/** Serve a host over a unix socket. The TUI is the only expected client. */
export function listenPtyHost(host: PtyHost, session: string): string {
  const path = hostSocketPathFor(session);
  mkdirSync(defaultSocketDir(), { recursive: true, mode: 0o700 });
  if (existsSync(path)) {
    try {
      unlinkSync(path);
    } catch {
      // best effort; listen will fail loudly if it is really in use
    }
  }
  Bun.listen<{ inbuf: string; out: SocketWriter; send: Sender }>({
    unix: path,
    socket: {
      open(socket) {
        const out = new SocketWriter(socket);
        socket.data = {
          inbuf: "",
          out,
          send: (frame) => out.write(JSON.stringify(frame) + "\n"),
        };
      },
      drain(socket) {
        socket.data.out.flush();
      },
      data(socket, data) {
        const buffered = socket.data.inbuf + data.toString();
        const lines = buffered.split("\n");
        socket.data.inbuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            host.handle(JSON.parse(line) as HostClientFrame, socket.data.send);
          } catch {
            // malformed frame; ignore it rather than take the daemon down
          }
        }
      },
      close(socket) {
        host.detach(socket.data.send);
      },
      error() {},
    },
  });
  return path;
}
