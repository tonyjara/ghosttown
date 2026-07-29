/**
 * TUI bootstrap: registers the terminal renderable, starts the session,
 * the control socket, and the renderer.
 */
import { render, useRenderer } from "@opentui/solid";
import type { CliRenderer } from "@opentui/core";
import { unlinkSync } from "node:fs";
import { initSession, quit, setRedrawHandler } from "./core/state";
import { startControlServer, prepareSocketPath } from "./control/server";
import { App } from "./ui/App";

let renderer: CliRenderer | null = null;
let socketPathForCleanup = "";

// GHOSTTOWN_DEBUG_LOG=/path/to/file captures full errors that the in-TUI
// console overlay would clip.
const debugLog = process.env.GHOSTTOWN_DEBUG_LOG;
if (debugLog) {
  const append = (label: string, args: unknown[]) => {
    const line = `[${new Date().toISOString()}] ${label} ${args
      .map((a) => (a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : JSON.stringify(a)))
      .join(" ")}\n`;
    try {
      require("node:fs").appendFileSync(debugLog, line);
    } catch {
      // best effort
    }
  };
  for (const level of ["error", "warn", "log"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      append(level, args);
      original(...args);
    };
  }
  process.on("uncaughtException", (err) => append("uncaught", [err]));
  process.on("unhandledRejection", (err) => append("unhandledRejection", [err]));
}

function shutdown(code: number): never {
  try {
    renderer?.destroy();
  } catch {
    // renderer may already be gone
  }
  try {
    if (socketPathForCleanup) unlinkSync(socketPathForCleanup);
  } catch {
    // socket already removed
  }
  process.exit(code);
}

function Root() {
  renderer = useRenderer();
  setRedrawHandler(() => {
    // Private flag (pinned @opentui/core 0.4.5): the diff renderer's only
    // full-frame switch. Needed when a detached client reattaches to a
    // blank terminal that the diff thinks is already painted.
    const r = renderer as unknown as {
      forceFullRepaintRequested?: boolean;
      requestRender?: () => void;
    } | null;
    if (!r) return;
    r.forceFullRepaintRequested = true;
    r.requestRender?.();
  });
  return <App />;
}

export async function startApp(opts: {
  session: string;
  command?: string;
  args?: string[];
}): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error("ghosttown must run in a terminal (stdout is not a TTY)");
    process.exit(1);
  }

  const socketPath = await prepareSocketPath(opts.session);
  socketPathForCleanup = socketPath;

  initSession({
    session: opts.session,
    socketPath,
    quit: (code) => shutdown(code),
    command: opts.command,
    args: opts.args,
  });
  startControlServer(socketPath);

  // The daemon SIGTERMs us when the session is killed — same deal as
  // prefix+Q, so tear down properly (surfaces, snapshot) instead of vanishing.
  process.on("SIGTERM", () => quit());

  await render(() => <Root />, {
    exitOnCtrlC: false,
    useMouse: true,
    useKittyKeyboard: null,
    targetFps: 30,
  });
}
