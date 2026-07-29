/**
 * Headless session daemon (dtach-style). Owns a PTY that runs the real TUI
 * and a unix socket that `gt` clients proxy their terminal through. Detach =
 * clients drop, the TUI keeps running here. TUI exit 42 = respawn with fresh
 * code (dev reload); any other exit tears the session down.
 *
 * Deliberately lean: no solid/opentui imports — the TUI child does the UI.
 */
import { spawn, type IPty } from "bun-pty";
import { appendFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import {
  attachSocketPathFor,
  defaultSocketDir,
  socketPathFor,
  RELOAD_EXIT_CODE,
  type AttachClientFrame,
  type AttachDaemonFrame,
} from "../control/protocol";
import { SocketWriter } from "../control/sockbuf";
import { deleteSnapshot } from "../core/persist";

export interface DaemonOpts {
  session: string;
  cols: number;
  rows: number;
  command?: string;
  args?: string[];
}

type Sock = { data: ClientState; end(): void };

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
  const attachPath = attachSocketPathFor(opts.session);
  mkdirSync(defaultSocketDir(), { recursive: true, mode: 0o700 });
  if (existsSync(attachPath)) {
    if (await socketAlive(attachPath)) {
      log("daemon already running for", opts.session);
      process.exit(1);
    }
    unlinkSync(attachPath);
  }

  let cols = Math.max(2, opts.cols);
  let rows = Math.max(2, opts.rows);
  let tui: IPty | null = null;
  let shuttingDown = false;
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

  /** Ask the TUI (over its control socket) for a full non-diffed frame. */
  const requestTuiRedraw = (): void => {
    Bun.connect({
      unix: socketPathFor(opts.session),
      socket: {
        open(s) {
          s.write(JSON.stringify({ id: 0, method: "redraw" }) + "\n");
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

  const shutdown = (reason: "exit" | "killed"): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("shutdown", reason);
    // A kill is deliberate, so the session shouldn't come back on the next
    // start. The TUI does the same on prefix+Q, but a killed TUI never gets
    // to run its handler — and a daemon *crash* must leave the snapshot
    // alone, which is exactly why this lives here and not in the signal path.
    if (reason === "killed") deleteSnapshot(opts.session);
    broadcast({ t: "bye", reason });
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
      try {
        unlinkSync(attachPath);
      } catch {
        // already removed
      }
      process.exit(0);
    }, 100);
  };

  const spawnTui = (): void => {
    modes.clear();
    modeTail = "";
    const args = ["--conditions=browser", "run", entry, "__tui", "--session", opts.session];
    if (opts.command) args.push("--", opts.command, ...(opts.args ?? []));
    log("spawning tui", { cols, rows, args });
    tui = spawn(process.execPath, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: process.cwd(),
      env: { ...cleanEnv(), GHOSTTOWN_ATTACH_SOCKET: attachPath },
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

  process.on("SIGTERM", () => shutdown("killed"));
  process.on("SIGHUP", () => {
    // Survive terminal hangups — backgrounding is the whole point.
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
            setTimeout(requestTuiRedraw, 150);
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
            } else if (frame.cmd === "kill") {
              shutdown("killed");
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
