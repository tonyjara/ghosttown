/**
 * SurfaceRuntime owns the non-reactive half of a surface: the pty (by proxy),
 * and the terminal renderable it feeds. Reactive metadata lives in the store;
 * this registry holds live handles.
 *
 * The pty itself is NOT here — it belongs to the pty host in the daemon
 * (src/attach/ptyhost.ts), which is what lets the TUI restart without killing
 * anything. A runtime is a thin proxy: writes and resizes go out as frames,
 * output comes back as frames, and status/title/mouse-mode bookkeeping happens
 * host-side. What stays local is the emulator, because only the renderable can
 * hold one.
 */
import type { HostClientFrame } from "../control/protocol";
import { MOUSE_MODES_OFF, type MouseModes } from "./mouse";
import type { AgentStatus } from "./types";

/**
 * The slice of a surface's terminal renderable a runtime drives — keeps core
 * off the renderer. src/ui/MuxTerminal implements it.
 */
export interface SurfaceView {
  feed(data: string): void;
  getCursor(): [number, number];
  getText(): string;
  snapToLive(): void;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** How a runtime reaches the host. Set once at startup by app.tsx. */
let sendToHost: (frame: HostClientFrame) => void = () => {};

export function setHostSender(send: (frame: HostClientFrame) => void): void {
  sendToHost = send;
}

/** Session-level frames (layout, quit) that belong to no single surface. */
export function hostSend(frame: HostClientFrame): void {
  sendToHost(frame);
}

export class SurfaceRuntime {
  private renderable: SurfaceView | null = null;
  private modes: MouseModes = MOUSE_MODES_OFF;
  private disposed = false;
  /**
   * Set between asking the host for a replay and receiving it. Live output in
   * that window is dropped on purpose: it is already inside the replay the
   * host is building, so feeding it first would show it twice.
   */
  private awaitingSnapshot = false;

  constructor(readonly id: string) {}

  /** Ask the host to start this surface. Failures come back as an exit frame. */
  spawn(spec: SpawnSpec): void {
    sendToHost({
      t: "spawn",
      id: this.id,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      cols: Math.max(2, spec.cols),
      rows: Math.max(1, spec.rows),
    });
    this.lastCols = Math.max(2, spec.cols);
    this.lastRows = Math.max(1, spec.rows);
  }

  /**
   * Attach a (fresh) renderable and rebuild it from the host's replay buffer.
   * Every attach re-subscribes: this runs on the first mount, and again after
   * anything that remounts the UI (a config reload), where the old emulator
   * died with its renderable.
   */
  attachRenderable(r: SurfaceView): void {
    this.renderable = r;
    if (this.disposed) return;
    this.awaitingSnapshot = true;
    sendToHost({ t: "sub", id: this.id });
  }

  /**
   * Let go of a renderable. The argument matters on a remount, where the new
   * renderable can mount before the old one is cleaned up — dropping whatever
   * happens to be attached would blank the pane until its next byte of output.
   */
  detachRenderable(r?: SurfaceView): void {
    if (r && this.renderable !== r) return;
    this.renderable = null;
  }

  /** Live output from the host. */
  feed(data: string): void {
    if (this.awaitingSnapshot) return;
    this.renderable?.feed(data);
  }

  /** The replay buffer, in one piece: everything this surface has printed. */
  feedSnapshot(data: string): void {
    this.awaitingSnapshot = false;
    if (data) this.renderable?.feed(data);
  }

  write(data: string): void {
    if (this.disposed) return;
    // Typing while scrolled back would send keys to a screen you cannot see.
    this.renderable?.snapToLive();
    sendToHost({ t: "w", id: this.id, d: Buffer.from(data).toString("base64") });
  }

  /** Mouse reporting this surface's program has asked for (host-tracked). */
  mouseModes(): MouseModes {
    return this.modes;
  }

  setMouseModes(modes: MouseModes): void {
    this.modes = modes;
  }

  /** Hand an encoded mouse event to the program. */
  reportMouse(data: string): void {
    if (this.disposed) return;
    sendToHost({ t: "m", id: this.id, d: Buffer.from(data).toString("base64") });
  }

  /** Answer the host's deferred cursor position report (see core/queries). */
  answerCursor(seq: number): void {
    const [x, y] = this.renderable?.getCursor() ?? [0, 0];
    sendToHost({ t: "cpr", id: this.id, seq, x, y });
  }

  /** Explicit status report from `gt report` (authoritative, host-side). */
  report(status: AgentStatus): void {
    if (this.disposed) return;
    sendToHost({ t: "report", id: this.id, status });
  }

  private lastCols = 0;
  private lastRows = 0;

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    const c = Math.max(2, cols);
    const r = Math.max(1, rows);
    // syncSizes runs on every divider drag step — skip no-op resizes.
    if (c === this.lastCols && r === this.lastRows) return;
    this.lastCols = c;
    this.lastRows = r;
    sendToHost({ t: "resize", id: this.id, cols: c, rows: r });
  }

  screenText(): string {
    return this.renderable?.getText() ?? "";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.renderable = null;
    sendToHost({ t: "kill", id: this.id });
  }
}

export class RuntimeRegistry {
  private map = new Map<string, SurfaceRuntime>();

  add(rt: SurfaceRuntime): void {
    this.map.set(rt.id, rt);
  }

  get(id: string): SurfaceRuntime | undefined {
    return this.map.get(id);
  }

  remove(id: string): void {
    this.map.get(id)?.dispose();
    this.map.delete(id);
  }

  all(): SurfaceRuntime[] {
    return [...this.map.values()];
  }

  disposeAll(): void {
    for (const rt of this.map.values()) rt.dispose();
    this.map.clear();
  }
}
