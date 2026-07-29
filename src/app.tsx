/**
 * TUI bootstrap: registers the terminal renderable, starts the session,
 * the control socket, and the renderer.
 */
import { render, useRenderer } from "@opentui/solid";
import { createSignal, onCleanup, onMount, Show } from "solid-js";
import type { CliRenderer } from "@opentui/core";
import { unlinkSync } from "node:fs";
import { loadConfig, reloadConfig, watchConfig } from "./core/config";
import { dbg } from "./core/debug";
import { applyConfigChange, hostEvents, initSession, setRedrawHandler } from "./core/state";
import { refreshTheme } from "./ui/theme";
import { setHostSender } from "./core/runtime";
import { connectHostInProcess, connectHostSocket, type HostConnection } from "./control/hostclient";
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
  /**
   * The UI is torn down and rebuilt on a config save. Keybinds and geometry are
   * read at use time and are already live by then, but colors are baked into
   * renderables when they are constructed, so new theme values only reach the
   * screen through fresh ones. It costs a repaint and nothing more: the
   * surfaces belong to the pty host and replay into the new emulators.
   *
   * Off-then-on rather than a keyed swap — a truthy→truthy change builds the
   * new tree without ever attaching it, leaving the old one on screen.
   */
  const [uiMounted, setUiMounted] = createSignal(true);
  onMount(() => {
    const stop = watchConfig(() => {
      dbg("config changed on disk; reapplying");
      reloadConfig();
      refreshTheme();
      applyConfigChange();
      setUiMounted(false);
      setTimeout(() => setUiMounted(true), 0);
    });
    onCleanup(stop);
  });

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
  // The Show sits inside a box on purpose: at the very root of the render tree
  // a dynamic child is inserted once and never reconciled.
  return (
    <box width="100%" height="100%">
      <Show when={uiMounted()}>
        <App />
      </Show>
    </box>
  );
}

/**
 * Reach the pty host that owns the surface PTYs. Normally that is the daemon's
 * (which is what makes a TUI restart survivable); with GHOSTTOWN_NO_DAEMON=1
 * there is no daemon to hold anything, so one runs in this process and dies
 * with it.
 */
async function connectPtyHost(session: string, persist: boolean): Promise<HostConnection> {
  const events = hostEvents();
  if (process.env.GHOSTTOWN_ATTACH_SOCKET || process.env.GHOSTTOWN_HOST_SOCKET) {
    return await connectHostSocket({ session, persist, events });
  }
  const { createPtyHost } = await import("./attach/ptyhost");
  return connectHostInProcess({ host: createPtyHost({ session }), persist, events });
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

  const persist = loadConfig().general.restore_session !== false;
  const host = await connectPtyHost(opts.session, persist);
  setHostSender(host.send);

  initSession({
    session: opts.session,
    socketPath,
    quit: (code) => shutdown(code),
    command: opts.command,
    args: opts.args,
    boot: host.boot,
  });
  startControlServer(socketPath);

  // Being signalled is NOT a decision to end the session: `bun --watch` kills
  // us on every source change, and the daemon does its own teardown (surfaces,
  // snapshot) when a kill is what was actually meant. So just leave quietly
  // and let the surfaces outlive us. prefix+Q is the path that means quit.
  process.on("SIGTERM", () => shutdown(0));

  await render(() => <Root />, {
    exitOnCtrlC: false,
    useMouse: true,
    useKittyKeyboard: null,
    targetFps: 30,
  });
}
