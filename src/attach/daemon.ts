/**
 * Headless session daemon (dtach-style). Owns a PTY that runs the real TUI
 * and a unix socket that `gt` clients proxy their terminal through. Detach =
 * clients drop, the TUI keeps running here. TUI exit 42 = respawn with fresh
 * code (dev reload); any other exit tears the session down.
 *
 * It also hosts the surface PTYs (src/attach/ptyhost.ts). That is what makes
 * reloading cheap: the TUI can be restarted — by prefix+R, or by `bun --watch`
 * under GHOSTTOWN_DEV=1 — and the shells and agents in the panes keep running,
 * to be adopted again by the TUI that comes back up.
 *
 * The flip side is that OUR own code can only change by dying: a running
 * daemon keeps the pty host it booted with. `cmd:"restart"` is that, made
 * deliberate — we flush the snapshot and exit, the client starts a replacement,
 * and the session is rebuilt from the snapshot with fresh shells. The PTYs
 * cannot come along (bun-pty hands out an opaque handle, never the master fd,
 * so there is nothing to pass to a successor).
 *
 * Deliberately lean: no solid/opentui imports — the TUI child does the UI.
 */
import { spawn, type IPty } from "bun-pty";
import { appendFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  attachSocketPathFor,
  defaultSocketDir,
  hostSocketPathFor,
  sanitizeSessionName,
  socketPathFor,
  RELOAD_EXIT_CODE,
  type AttachClientFrame,
  type AttachDaemonFrame,
} from "../control/protocol";
import { SocketWriter } from "../control/sockbuf";
import { createPtyHost, listenPtyHost } from "./ptyhost";

export interface DaemonOpts {
  session: string;
  cols: number;
  rows: number;
  command?: string;
  args?: string[];
}

type Sock = { data: ClientState; end(): void };

/**
 * How long the daemon lingers after its clients are gone, so a pane program has
 * a moment to act on the hangup before the host makes sure of it (see
 * PtyHost.killSurvivors). Invisible from the outside: the sockets are already
 * closed and the shell prompt is already back by then.
 */
const SURVIVOR_GRACE_MS = 500;

/**
 * Why the daemon is going down. All of them flush the session snapshot and keep
 * it — including "killed", which stops the processes and nothing else — except
 * "delete", the switcher's `d`, which retires the layout to the archive.
 * "signal" is a SIGTERM: a shutdown, a `kill`, or the machine rebooting.
 */
type ShutdownReason = "exit" | "killed" | "restart" | "signal" | "delete";

interface ClientState {
  /** Partial inbound line, waiting for its newline. */
  inbuf: string;
  /** Outbound frames survive partial writes (see SocketWriter). */
  out: SocketWriter;
}

function log(...parts: unknown[]): void {
  const path = process.env.GHOSTTOWN_DAEMON_LOG;
  if (!path) return;
  try {
    appendFileSync(
      path,
      `[${new Date().toISOString()}] ${parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : typeof p === "string" ? p : JSON.stringify(p))).join(" ")}\n`,
    );
  } catch {
    // best effort
  }
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  return env;
}

async function socketAlive(path: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 300);
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          clearTimeout(timer);
          resolve(true);
          setTimeout(() => s.end(), 10);
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
}

export async function runDaemon(opts: DaemonOpts): Promise<void> {
  const entry = join(import.meta.dir, "..", "index.ts");
  // The session name is the daemon's identity: it names every socket and the
  // snapshot. A rename moves all of them, so none of this is const.
  let session = opts.session;
  let attachPath = attachSocketPathFor(session);
  mkdirSync(defaultSocketDir(), { recursive: true, mode: 0o700 });
  if (existsSync(attachPath)) {
    if (await socketAlive(attachPath)) {
      log("daemon already running for", session);
      process.exit(1);
    }
    unlinkSync(attachPath);
  }

  let cols = Math.max(2, opts.cols);
  let rows = Math.max(2, opts.rows);
  let tui: IPty | null = null;
  let shuttingDown = false;
  // Outlives every TUI in this session: the surfaces belong to it, not to the UI.
  const host = createPtyHost({ session, log });
  let hostPath = listenPtyHost(host, session);
  const clients = new Set<Sock>();
  // DECSET/DECRST private modes the TUI has toggled (alt screen, mouse,
  // cursor…), replayed to late-attaching clients so their terminal matches.
  const modes = new Map<string, boolean>();
  let modeTail = "";

  const send = (sock: Sock, frame: AttachDaemonFrame): void => {
    sock.data.out.write(JSON.stringify(frame) + "\n");
  };
  const broadcast = (frame: AttachDaemonFrame): void => {
    for (const c of clients) send(c, frame);
  };

  const trackModes = (chunk: string): void => {
    const s = modeTail + chunk;
    modeTail = s.slice(-16);
    const re = /\x1b\[\?([0-9;]+)([hl])/g;
    let m: RegExpExecArray | null;
    // Re-scanning the tail can apply a mode twice — idempotent, harmless.
    while ((m = re.exec(s))) {
      for (const mode of m[1]!.split(";")) modes.set(mode, m[2] === "h");
    }
  };

  /**
   * Fire-and-forget a control request at the TUI. `path` is explicit because a
   * rename has to reach the TUI on the socket it is still listening on.
   */
  const tuiRequest = (path: string, method: string, params?: Record<string, unknown>): void => {
    Bun.connect({
      unix: path,
      socket: {
        open(s) {
          s.write(JSON.stringify({ id: 0, method, params }) + "\n");
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
      // TUI may be mid-respawn; the next resize will repaint anyway
    });
  };

  /**
   * Rename this profile in place. The daemon's identity is a set of paths, so
   * that is all a rename really is: the sockets are *moved* (an open unix socket
   * keeps serving under its new name, and the clients' connections never
   * notice), the host moves its snapshot, and the TUI adopts the new name over
   * its control socket. Nothing running in the panes is touched.
   *
   * The TUI keeps listening on its old control socket as well — surfaces
   * spawned before the rename carry that path in their environment, and their
   * `gt` calls have to keep working. See control/server.ts.
   */
  const renameSession = (raw: string): void => {
    const next = sanitizeSessionName(String(raw ?? ""));
    if (!next || next === session) return;
    const nextAttach = attachSocketPathFor(next);
    if (existsSync(nextAttach)) {
      log("rename refused: profile already exists", next);
      return;
    }
    const nextHost = hostSocketPathFor(next);
    try {
      renameSync(attachPath, nextAttach);
      renameSync(hostPath, nextHost);
    } catch (err) {
      log("rename failed", err as Error);
      return;
    }
    const prev = session;
    session = next;
    attachPath = nextAttach;
    hostPath = nextHost;
    host.setSession(next);
    tuiRequest(socketPathFor(prev), "set-session", { session: next });
    log("renamed", prev, "→", next);
  };

  const shutdown = (reason: ShutdownReason): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown", reason);
    // Only an explicit profile *delete* retires the layout. Everything else —
    // a kill, a signal, a crash, a reboot — ends the processes and leaves the
    // snapshot where it is, because a stopped session is still a saved one.
    if (reason === "delete") host.discardSnapshot();
    // A TUI that exited on its own may have moved things since the last
    // 30s heartbeat; catch up before the pids are gone. A restart depends on
    // this even more than an exit does: the snapshot IS the handover to the
    // daemon that replaces us, and it is read while the pids are still alive
    // (that is where each surface's live cwd comes from). Under a signal the
    // OS is already timing us out, so skip the lsof and write what we have.
    else host.flushSnapshotSync(reason !== "signal");
    host.closeAll();
    // The clients only care about where to go next; a signal or a delete is a
    // teardown like any other kill as far as they are concerned.
    broadcast({ t: "bye", reason: reason === "signal" || reason === "delete" ? "killed" : reason });
    setTimeout(() => {
      for (const c of clients) {
        try {
          c.end();
        } catch {
          // already gone
        }
      }
      try {
        tui?.kill();
      } catch {
        // already dead
      }
      // The TUI's control socket goes too: it is dead as of now, and leaving
      // the file behind makes the name look taken to whoever reuses it.
      for (const path of [attachPath, hostPath, socketPathFor(session)]) {
        try {
          unlinkSync(path);
        } catch {
          // already removed
        }
      }
      // Nobody is attached anymore, so this last wait costs the user nothing:
      // it is the grace a pane program gets to act on the hangup closeAll sent
      // before we make sure it is really gone. Surviving this process is how a
      // program that ignores hangups becomes an orphan nothing ever reaps.
      setTimeout(() => {
        host.killSurvivors();
        process.exit(0);
      }, SURVIVOR_GRACE_MS);
    }, 100);
  };

  const spawnTui = (): void => {
    modes.clear();
    modeTail = "";
    const args = ["--conditions=browser", "run"];
    // GHOSTTOWN_DEV=1: bun restarts the TUI itself whenever a source file
    // changes (and survives a crash until the next save). The surfaces are the
    // host's, so a reload costs a repaint and nothing else — this is the whole
    // point of moving them out of the TUI.
    if (process.env.GHOSTTOWN_DEV === "1") args.push("--watch");
    args.push(entry, "__tui", "--session", session);
    if (opts.command) args.push("--", opts.command, ...(opts.args ?? []));
    log("spawning tui", { cols, rows, args });
    tui = spawn(process.execPath, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: {
        ...cleanEnv(),
        GHOSTTOWN_ATTACH_SOCKET: attachPath,
        GHOSTTOWN_HOST_SOCKET: hostPath,
      },
    });
    tui.onData((chunk) => {
      trackModes(chunk);
      broadcast({ t: "o", d: Buffer.from(chunk).toString("base64") });
    });
    tui.onExit(({ exitCode }) => {
      if (shuttingDown) return;
      if (exitCode === RELOAD_EXIT_CODE) {
        log("tui asked for reload");
        spawnTui();
      } else {
        log("tui exited", exitCode);
        shutdown("exit");
      }
    });
  };
  spawnTui();

  // A reboot is a SIGTERM to every process on the machine, and macOS gives you
  // a couple of seconds before SIGKILL. This used to be treated as a deliberate
  // kill and *deleted* the snapshot, so restarting the computer wiped every
  // workspace arrangement in every profile. It is now the opposite: the last
  // thing the daemon does is write the layout down.
  for (const sig of ["SIGTERM", "SIGINT", "SIGQUIT"] as const) {
    process.on(sig, () => shutdown("signal"));
  }
  process.on("SIGHUP", () => {
    // Survive terminal hangups — backgrounding is the whole point.
  });
  // Last resort for the paths no handler above covers (an uncaught throw, or a
  // SIGKILL'd TUI taking us with it): a snapshot write is idempotent, and the
  // guard means the normal shutdowns don't do it twice.
  process.on("exit", () => {
    if (shuttingDown) return;
    try {
      host.flushSnapshotSync(false);
    } catch {
      // going down anyway
    }
  });

  Bun.listen<ClientState>({
    unix: attachPath,
    socket: {
      open(socket) {
        socket.data = { inbuf: "", out: new SocketWriter(socket) };
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
          let frame: AttachClientFrame;
          try {
            frame = JSON.parse(line) as AttachClientFrame;
          } catch {
            continue;
          }
          if (frame.t === "hello") {
            clients.add(socket as unknown as Sock);
            log("client attached", { cols: frame.cols, rows: frame.rows });
            // Replay terminal modes (alt screen, mouse, …), match the size,
            // then ask the TUI for a full frame — its diff renderer thinks
            // this (blank) terminal is already painted.
            let replay = "";
            for (const [mode, on] of modes) replay += `\x1b[?${mode}${on ? "h" : "l"}`;
            if (replay) send(socket as unknown as Sock, { t: "o", d: Buffer.from(replay).toString("base64") });
            cols = Math.max(2, Number(frame.cols) || cols);
            rows = Math.max(2, Number(frame.rows) || rows);
            try {
              tui?.resize(cols, rows);
            } catch {
              // tui may be mid-respawn
            }
            setTimeout(() => tuiRequest(socketPathFor(session), "redraw"), 150);
          } else if (frame.t === "i") {
            try {
              tui?.write(Buffer.from(String(frame.d), "base64").toString("utf8"));
            } catch {
              // tui may be mid-respawn
            }
          } else if (frame.t === "r") {
            cols = Math.max(2, Number(frame.cols) || cols);
            rows = Math.max(2, Number(frame.rows) || rows);
            try {
              tui?.resize(cols, rows);
            } catch (err) {
              log("tui resize failed (mid-respawn?)", err as Error);
            }
          } else if (frame.t === "cmd") {
            if (frame.cmd === "detach" || frame.cmd === "switch") {
              // Same mechanics for both: this session keeps running headless;
              // switch additionally tells the clients where to go next.
              if (frame.cmd === "switch") {
                log("switch requested", frame.session);
                broadcast({ t: "bye", reason: "switch", session: frame.session });
              } else {
                log("detach requested");
                broadcast({ t: "bye", reason: "detached" });
              }
              // end() inside the handler aborts the rest of it — defer.
              const toClose = [...clients];
              clients.clear();
              setTimeout(() => {
                for (const c of toClose) {
                  try {
                    c.end();
                  } catch {
                    // already gone
                  }
                }
              }, 50);
            } else if (frame.cmd === "rename") {
              renameSession(frame.session);
            } else if (frame.cmd === "kill") {
              // Stop everything running in here. The layout stays on disk:
              // `gt --session <name>` brings this profile back as it was.
              shutdown("killed");
            } else if (frame.cmd === "delete") {
              // The destructive one: the profile itself is going away, so the
              // snapshot is retired to the archive (recoverable, not gone).
              shutdown("delete");
            } else if (frame.cmd === "restart") {
              // Same teardown as a clean exit — the snapshot is kept, so the
              // daemon the client starts next restores the session. What dies
              // is everything in the panes: the surface PTYs are ours.
              log("restart requested");
              shutdown("restart");
            }
          }
        }
      },
      close(socket) {
        clients.delete(socket as unknown as Sock);
        log("client closed, remaining", clients.size);
      },
      error() {},
    },
  });
  log("daemon listening", attachPath);
}
