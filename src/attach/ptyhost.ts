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
import { loadConfig, reloadConfig, watchConfig, type Config } from "../core/config";
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
import { DEFAULT_AGENT_COMMANDS, findAgents, readProcTable } from "../core/procs";
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
/** How often the process table is walked looking for agents ([agents] poll_ms). */
const DEFAULT_AGENT_POLL_MS = 2000;
/** A pane can churn, but a poll cheaper than this is just burning CPU. */
const MIN_AGENT_POLL_MS = 500;

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
  /** Name the user gave this tab; wins over `title` in the UI. */
  titleOverride: string | null;
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
  /** Agent program running in here right now, per the process poll. */
  agent: string | null;
  agentPid: number;
  /** True once an agent has ever been seen here; it stays listed after. */
  everAgent: boolean;
  exited: boolean;
}

export interface PtyHost {
  /** Feed one client frame. `send` is that client's reply channel. */
  handle(frame: HostClientFrame, send: Sender): void;
  /** A client went away; stop streaming to it. */
  detach(send: Sender): void;
  /** The profile was renamed: move the snapshot to the new name. */
  setSession(session: string): void;
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
  /** Not const: a profile can be renamed under us (see setSession). */
  let session = opts.session;
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
  // The daemon reads the config too, so [agents] changes apply to a running
  // session the same way every other setting does.
  let config: Config = loadConfig();
  const stopConfigWatch = watchConfig(() => {
    config = reloadConfig();
    restartAgentPoll();
  });

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
    titleOverride: s.titleOverride,
    command: s.command,
    status: s.tracker.status,
    hasReporter: s.tracker.hasReporter,
    everActive: s.everActive,
    lastActiveAt: s.lastActiveAt,
    agent: s.agent,
    everAgent: s.everAgent,
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

  // --- agent detection ----------------------------------------------------

  const agentNames = (): string[] => {
    const configured = config.agents?.commands;
    return Array.isArray(configured) && configured.length > 0
      ? configured.map(String)
      : DEFAULT_AGENT_COMMANDS;
  };

  const setAgent = (s: HostedSurface, agent: string | null, pid: number): void => {
    if (s.agent === agent && s.agentPid === pid) return;
    s.agent = agent;
    s.agentPid = pid;
    s.tracker.setAgent(agent);
    if (agent) {
      s.everAgent = true;
      // An agent that has never printed anything still deserves a place in the
      // list, so give it a timestamp to be ordered by.
      s.lastActiveAt ??= Date.now();
    }
    log("agent", s.id, agent ?? "gone", pid || "");
    emit({ t: "agent", id: s.id, agent, pid });
  };

  /**
   * One `ps` pass for the whole session: every surface learns whether an agent
   * is running in it, whether or not it has printed a single byte. This is what
   * puts an idle `claude` in the sidebar — see core/procs.ts.
   */
  const pollAgents = async (): Promise<void> => {
    const roots = pids();
    if (roots.length === 0) return;
    const table = await readProcTable();
    if (table.size === 0) return; // ps failed; keep what we know
    const found = findAgents(roots, table, agentNames());
    for (const [id] of roots) {
      const s = surfaces.get(id);
      if (!s) continue; // closed while ps ran
      const agent = found.get(id);
      setAgent(s, agent?.kind ?? null, agent?.pid ?? 0);
    }
  };

  let agentTimer: ReturnType<typeof setInterval> | null = null;

  function restartAgentPoll(): void {
    if (agentTimer) clearInterval(agentTimer);
    const raw = Number(config.agents?.poll_ms ?? DEFAULT_AGENT_POLL_MS);
    const every = Number.isFinite(raw) ? Math.max(MIN_AGENT_POLL_MS, Math.floor(raw)) : DEFAULT_AGENT_POLL_MS;
    if (config.agents?.detect === false) {
      agentTimer = null;
      // Nothing will refresh these now, so stop claiming they are running.
      for (const s of surfaces.values()) setAgent(s, null, 0);
      return;
    }
    agentTimer = setInterval(() => void pollAgents(), every);
  }

  /**
   * Where a sibling surface is sitting right now. A new tab starts next to the
   * one before it, so this is read live rather than taken from the snapshot —
   * the last save can predate a `cd`. Blocking, but it is one lsof (~40ms, and
   * a readlink on Linux) per new tab, on the daemon rather than the render loop.
   */
  const cwdOfSurface = (id: string): string | null => {
    const pid = surfaces.get(id)?.pty?.pid;
    const live = pid ? readCwds([pid]).get(pid) : undefined;
    // No pid (it exited), or lsof failed: the snapshot's last known directory
    // for it still beats falling back to wherever the daemon was started.
    return live ?? cwdsOf(layout).get(id) ?? null;
  };

  const spawnSurface = (frame: Extract<HostClientFrame, { t: "spawn" }>): void => {
    if (surfaces.has(frame.id)) return;
    const cols = Math.max(2, frame.cols);
    const rows = Math.max(1, frame.rows);
    const s: HostedSurface = {
      id: frame.id,
      command: frame.command,
      title: frame.command.split("/").pop() ?? frame.command,
      titleOverride: null,
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
      agent: null,
      agentPid: 0,
      everAgent: false,
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

    // A directory can be deleted under a live shell, so whichever one we land
    // on has to be checked before handing it to the pty.
    const wanted = (frame.cwdFrom && cwdOfSurface(frame.cwdFrom)) || frame.cwd;
    try {
      s.pty = spawn(frame.command, frame.args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: wanted && existsSync(wanted) ? wanted : process.cwd(),
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
      // Nothing is running here anymore, and the poll skips dead ptys — so say
      // so now rather than leaving a stale agent behind.
      setAgent(s, null, 0);
      // Kept in the map: a TUI that is mid-restart still has to hear about it.
      emit({ t: "exit", id: s.id, code: exitCode });
    });
    log("spawned surface", s.id, frame.command);
    // `gt new-tab -- claude` should show up as an agent now, not on the next
    // tick; a shell that has an agent typed into it is caught by the interval.
    void pollAgents();
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
  restartAgentPoll();

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
      case "rename": {
        // Held here, not in the TUI, so the name outlives a TUI restart. The
        // program's own OSC titles keep updating s.title underneath it.
        const s = surfaces.get(frame.id);
        if (!s) return;
        s.titleOverride = frame.title?.trim().slice(0, 60) || null;
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
        deleteSnapshot(session);
        for (const id of [...surfaces.keys()]) killSurface(id);
        return;
    }
  };

  return {
    handle,
    /**
     * The snapshot is named after the profile, so a rename has to move it —
     * otherwise the session would restore under a name nothing points at
     * anymore. The in-memory layout is retagged and written back out under the
     * new name; the old file goes.
     */
    setSession(next) {
      if (!next || next === session) return;
      log("session renamed", session, "→", next);
      deleteSnapshot(session);
      session = next;
      if (layout) {
        layout = { ...layout, session: next };
        scheduleSave();
      }
    },
    detach(send) {
      if (client === send) {
        client = null;
        log("tui detached; surfaces keep running");
      }
    },
    closeAll() {
      clearInterval(tick);
      clearInterval(saveInterval);
      if (agentTimer) clearInterval(agentTimer);
      stopConfigWatch();
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
