/**
 * SurfaceRuntime owns the non-reactive half of a surface: the PTY, the output
 * scanner, the status tracker, and the (lazily attached) terminal renderable.
 * Reactive metadata lives in the store; this registry holds live handles.
 */
import { spawn, type IPty } from "bun-pty";
import type { MouseModes } from "./mouse";
import { OutputScanner } from "./queries";
import { StatusTracker } from "./status";
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

export interface SurfaceCallbacks {
  onTitle: (title: string) => void;
  onOscNotify: (title: string, body: string) => void;
  onStatusChange: (status: AgentStatus, prev: AgentStatus) => void;
  onExit: (exitCode: number) => void;
}

export interface SpawnSpec {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

export class SurfaceRuntime {
  readonly pty: IPty;
  readonly tracker: StatusTracker;
  private scanner: OutputScanner;
  private renderable: SurfaceView | null = null;
  private pending: string[] = [];
  private disposed = false;

  constructor(
    readonly id: string,
    spec: SpawnSpec,
    callbacks: SurfaceCallbacks,
  ) {
    this.tracker = new StatusTracker(callbacks.onStatusChange);
    this.pty = spawn(spec.command, spec.args, {
      name: "xterm-256color",
      cols: Math.max(2, spec.cols),
      rows: Math.max(1, spec.rows),
      cwd: spec.cwd,
      env: spec.env,
    });
    this.scanner = new OutputScanner({
      respond: (data) => {
        if (!this.disposed) this.pty.write(data);
      },
      getCursor: () => this.renderable?.getCursor() ?? [0, 0],
      onTitle: callbacks.onTitle,
      onNotify: callbacks.onOscNotify,
    });
    this.pty.onData((chunk) => {
      this.scanner.scan(chunk);
      this.tracker.recordOutput();
      if (this.renderable) this.renderable.feed(chunk);
      else this.pending.push(chunk);
    });
    this.pty.onExit(({ exitCode }) => {
      if (!this.disposed) callbacks.onExit(exitCode);
    });
  }

  attachRenderable(r: SurfaceView): void {
    this.renderable = r;
    if (this.pending.length > 0) {
      for (const chunk of this.pending) r.feed(chunk);
      this.pending = [];
    }
  }

  detachRenderable(): void {
    this.renderable = null;
  }

  write(data: string): void {
    if (this.disposed) return;
    this.tracker.recordInput();
    // Typing while scrolled back would send keys to a screen you cannot see.
    this.renderable?.snapToLive();
    this.pty.write(data);
  }

  /** Mouse reporting this surface's program has asked for. */
  mouseModes(): MouseModes {
    return this.scanner.mouseModes();
  }

  /**
   * Hand an encoded mouse event to the program. Deliberately not recorded as
   * input: ?1003 reports every motion, which would keep resetting the status
   * heuristic while the pointer merely crosses the pane.
   */
  reportMouse(data: string): void {
    if (this.disposed) return;
    this.pty.write(data);
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
    try {
      this.pty.resize(c, r);
    } catch {
      // PTY may have exited under us.
    }
  }

  screenText(): string {
    return this.renderable?.getText() ?? "";
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.pty.kill();
    } catch {
      // already dead
    }
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
