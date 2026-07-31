/**
 * Attach client: the process the user actually runs. Puts the terminal in
 * raw mode and proxies bytes to/from the session daemon. If no daemon is
 * running for the session, starts one (detached, own process group) first —
 * so plain `gt` means "start or reattach".
 *
 * Profile switch (prefix+s / prefix+S in the TUI): the daemon drops us with
 * a `bye reason:"switch"` naming the target session; we reset the terminal
 * and re-enter the attach loop against that session, starting its daemon if
 * needed. The old session keeps running detached.
 *
 * Restart (prefix+B): the same trick pointed back at the session we are
 * already on. The daemon tears itself down and we start its replacement, which
 * is how the pty host gets to come back on current source — a reload only
 * reaches the TUI. This client process is the one thing that survives both, so
 * the terminal never leaves raw mode and the user keeps their window.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  attachSocketPathFor,
  type AttachClientFrame,
  type AttachDaemonFrame,
} from "../control/protocol";
import { SocketWriter } from "../control/sockbuf";

export interface AttachOpts {
  session: string;
  command?: string;
  args?: string[];
}

/** Undo everything the TUI plausibly turned on before we hand the tty back. */
const RESTORE =
  "\x1b[?1049l\x1b[?25h\x1b[0m\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?2004l";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait for a daemon to release its attach socket — it unlinks all three of its
 * paths on the way out. Bounded, because a daemon wedged in teardown must not
 * strand the client here: on timeout we try to reattach anyway and fail there,
 * where there is an error message for it.
 */
async function waitForSocketGone(path: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (existsSync(path) && Date.now() < deadline) await sleep(60);
}

type AttachOutcome =
  | { kind: "no-daemon" }
  | { kind: "closed"; reason: string; target?: string };

interface TtyIo {
  /** Where stdin bytes go right now (null between attachments). */
  sendInput: ((chunk: Buffer) => void) | null;
  sendResize: (() => void) | null;
}

export async function runAttachClient(opts: AttachOpts): Promise<void> {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    console.error("ghosttown must run in a terminal (stdout is not a TTY)");
    process.exit(1);
  }

  // Raw mode + stdin/resize handlers live for the whole client lifetime and
  // are re-pointed at each new daemon connection via `io`.
  const io: TtyIo = { sendInput: null, sendResize: null };
  const stdin = process.stdin as unknown as {
    setRawMode(v: boolean): void;
    resume(): void;
    on(ev: "data", cb: (chunk: Buffer) => void): void;
  };
  stdin.setRawMode(true);
  stdin.resume();
  stdin.on("data", (chunk) => io.sendInput?.(chunk));
  process.stdout.on("resize", () => io.sendResize?.());
  process.on("SIGWINCH", () => io.sendResize?.());

  const exit = (reason: string, session: string): never => {
    try {
      stdin.setRawMode(false);
    } catch {
      // not a tty anymore
    }
    process.stdout.write(RESTORE);
    if (reason === "detached") {
      console.log(
        `[ghosttown] detached — session "${session}" keeps running. Reattach: gt --session ${session}`,
      );
    } else if (reason === "error") {
      console.error("[ghosttown] connection to the session daemon was lost");
    }
    process.exit(reason === "error" ? 1 : 0);
  };
  process.on("SIGTERM", () => exit("exit", opts.session));

  let session = opts.session;
  // The startup command only applies to the very first daemon we create;
  // switched-to profiles always start with the default shell.
  let command = opts.command;
  let args = opts.args;

  for (;;) {
    let outcome = await attachOnce(session, io);
    if (outcome.kind === "no-daemon") {
      spawnDaemon(session, command, args);
      const deadline = Date.now() + 6000;
      while (outcome.kind === "no-daemon" && Date.now() < deadline) {
        await sleep(120);
        outcome = await attachOnce(session, io);
      }
      if (outcome.kind === "no-daemon") {
        try {
          stdin.setRawMode(false);
        } catch {
          // not a tty anymore
        }
        process.stdout.write(RESTORE);
        console.error(`ghosttown: daemon for session "${session}" did not start`);
        process.exit(1);
      }
    }
    if (outcome.kind === "closed" && outcome.reason === "switch" && outcome.target) {
      // Reset modes the old TUI enabled; the next daemon replays its own.
      process.stdout.write(RESTORE);
      session = outcome.target;
      command = undefined;
      args = undefined;
      continue;
    }
    if (outcome.kind === "closed" && outcome.reason === "restart") {
      // The daemon is stepping aside so the next one comes up on current
      // source. Unlike a switch we go back to the SAME name, which means
      // waiting for the old daemon to let go of the socket first: reconnecting
      // to one that is on its way out reads as an ordinary close, and we would
      // quit instead of coming back. Once it is gone the loop finds no daemon
      // and starts one, which restores the session from the snapshot.
      process.stdout.write(RESTORE);
      await waitForSocketGone(attachSocketPathFor(session));
      command = undefined;
      args = undefined;
      continue;
    }
    exit(outcome.kind === "closed" ? outcome.reason : "exit", session);
  }
}

/** Start a session daemon in its own process group so closing this terminal
 *  never takes the session with it. */
function spawnDaemon(session: string, command?: string, args?: string[]): void {
  const entry = join(import.meta.dir, "..", "index.ts");
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const daemonArgs = [
    entry,
    "__daemon",
    "--session",
    session,
    "--cols",
    String(cols),
    "--rows",
    String(rows),
  ];
  if (command) daemonArgs.push("--", command, ...(args ?? []));
  const child = spawn(process.execPath, daemonArgs, {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

/** One attachment: proxy bytes until the daemon drops us. Never exits. */
async function attachOnce(session: string, io: TtyIo): Promise<AttachOutcome> {
  const attachPath = attachSocketPathFor(session);
  let byeReason = "";
  let byeTarget: string | undefined;
  let buffered = "";

  let writer: SocketWriter | undefined;
  let resolveClosed: (o: AttachOutcome) => void;
  const closed = new Promise<AttachOutcome>((r) => (resolveClosed = r));
  let settled = false;
  const settle = (o: AttachOutcome): void => {
    if (settled) return;
    settled = true;
    io.sendInput = null;
    io.sendResize = null;
    resolveClosed(o);
  };

  try {
    const sock = await Bun.connect({
      unix: attachPath,
      socket: {
        drain() {
          writer?.flush();
        },
        data(_s, data) {
          buffered += data.toString();
          const lines = buffered.split("\n");
          buffered = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            let frame: AttachDaemonFrame;
            try {
              frame = JSON.parse(line) as AttachDaemonFrame;
            } catch {
              continue;
            }
            if (frame.t === "o") {
              process.stdout.write(Buffer.from(String(frame.d), "base64"));
            } else if (frame.t === "bye") {
              byeReason = String(frame.reason ?? "exit");
              if (frame.reason === "switch") byeTarget = frame.session;
            }
          }
        },
        close() {
          settle({ kind: "closed", reason: byeReason || "exit", target: byeTarget });
        },
        error() {
          settle({ kind: "closed", reason: "error" });
        },
      },
    });
    writer = new SocketWriter(sock);
  } catch {
    return { kind: "no-daemon" };
  }

  const send = (frame: AttachClientFrame): void => {
    writer!.write(JSON.stringify(frame) + "\n");
  };

  send({
    t: "hello",
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24,
  });
  io.sendInput = (chunk) => send({ t: "i", d: Buffer.from(chunk).toString("base64") });
  io.sendResize = () =>
    send({
      t: "r",
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24,
    });

  return closed;
}
