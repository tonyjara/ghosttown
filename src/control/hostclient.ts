/**
 * The TUI's end of the pty host protocol (see control/protocol.ts).
 *
 * Two transports, one interface: a unix socket to the daemon's host (the
 * normal case, and what lets the TUI restart without killing surfaces), or a
 * host created in this very process for GHOSTTOWN_NO_DAEMON=1, where there is
 * no daemon to hold anything. The in-process variant skips the socket
 * entirely — frames are handed straight to the host — so the same code path is
 * exercised either way.
 */
import type { MouseModes } from "../core/mouse";
import type { PersistedSession } from "../core/persist";
import type { AgentStatus } from "../core/types";
import type { HostClientFrame, HostServerFrame, HostSurfaceInfo } from "./protocol";
import { hostSocketPathFor } from "./protocol";
import { SocketWriter } from "./sockbuf";

export interface HostEvents {
  onOutput: (id: string, data: string) => void;
  onSnapshot: (id: string, data: string) => void;
  onExit: (id: string, code: number) => void;
  onStatus: (id: string, status: AgentStatus, hasReporter: boolean) => void;
  onTitle: (id: string, title: string) => void;
  onNotify: (id: string, title: string, body: string) => void;
  onModes: (id: string, modes: MouseModes) => void;
  onCursorRequest: (id: string, seq: number) => void;
  /** The socket died — without a host there is nothing left to render. */
  onLost: () => void;
}

export interface HostConnection {
  send(frame: HostClientFrame): void;
  /** Live surfaces and the layout to rebuild, from the host's `hello` reply. */
  boot: { surfaces: HostSurfaceInfo[]; layout: PersistedSession | null };
}

/** Route one server frame to the matching handler. */
function deliver(frame: HostServerFrame, events: HostEvents): void {
  switch (frame.t) {
    case "o":
      events.onOutput(frame.id, frame.d);
      return;
    case "snap":
      events.onSnapshot(frame.id, frame.d);
      return;
    case "exit":
      events.onExit(frame.id, frame.code);
      return;
    case "status":
      events.onStatus(frame.id, frame.status, frame.hasReporter);
      return;
    case "title":
      events.onTitle(frame.id, frame.title);
      return;
    case "notify":
      events.onNotify(frame.id, frame.title, frame.body);
      return;
    case "modes":
      events.onModes(frame.id, frame.modes);
      return;
    case "cpr-req":
      events.onCursorRequest(frame.id, frame.seq);
      return;
    case "boot":
      // Handled by the connect handshake; a second one would be a host bug.
      return;
  }
}

/**
 * Dial the daemon's pty host and complete the handshake. Resolves once the
 * host has told us what is already running.
 */
export async function connectHostSocket(opts: {
  session: string;
  persist: boolean;
  events: HostEvents;
  timeoutMs?: number;
}): Promise<HostConnection> {
  const path = process.env.GHOSTTOWN_HOST_SOCKET || hostSocketPathFor(opts.session);
  let writer: SocketWriter | undefined;
  let inbuf = "";
  let booted: HostConnection["boot"] | null = null;
  let resolveBoot: ((b: HostConnection["boot"]) => void) | null = null;
  let rejectBoot: ((err: Error) => void) | null = null;
  const bootPromise = new Promise<HostConnection["boot"]>((resolve, reject) => {
    resolveBoot = resolve;
    rejectBoot = reject;
  });

  const socket = await Bun.connect({
    unix: path,
    socket: {
      drain() {
        writer?.flush();
      },
      data(_s, data) {
        inbuf += data.toString();
        const lines = inbuf.split("\n");
        inbuf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let frame: HostServerFrame;
          try {
            frame = JSON.parse(line) as HostServerFrame;
          } catch {
            continue;
          }
          if (frame.t === "boot") {
            booted = { surfaces: frame.surfaces, layout: frame.layout };
            resolveBoot?.(booted);
            resolveBoot = null;
            continue;
          }
          deliver(frame, opts.events);
        }
      },
      close() {
        if (resolveBoot) rejectBoot?.(new Error("pty host closed during handshake"));
        else opts.events.onLost();
      },
      error() {
        if (resolveBoot) rejectBoot?.(new Error("pty host connection failed"));
        else opts.events.onLost();
      },
    },
  });
  writer = new SocketWriter(socket);

  const send = (frame: HostClientFrame): void => {
    writer!.write(JSON.stringify(frame) + "\n");
  };
  send({ t: "hello", persist: opts.persist });

  const timer = setTimeout(() => {
    rejectBoot?.(new Error("pty host did not answer hello"));
  }, opts.timeoutMs ?? 4000);
  try {
    const boot = await bootPromise;
    return { send, boot };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Wire the TUI directly to a host object in this process (no daemon, no
 * socket). Frames still go through the same handle()/deliver() pair.
 */
export function connectHostInProcess(opts: {
  host: { handle(frame: HostClientFrame, send: (f: HostServerFrame) => void): void };
  persist: boolean;
  events: HostEvents;
}): HostConnection {
  let boot: HostConnection["boot"] = { surfaces: [], layout: null };
  const sink = (frame: HostServerFrame): void => {
    if (frame.t === "boot") {
      boot = { surfaces: frame.surfaces, layout: frame.layout };
      return;
    }
    deliver(frame, opts.events);
  };
  const send = (frame: HostClientFrame): void => opts.host.handle(frame, sink);
  send({ t: "hello", persist: opts.persist });
  return { send, boot };
}
