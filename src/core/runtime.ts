/**
 * SurfaceRuntime owns the non-reactive half of a surface: the PTY, the output
 * scanner, the status tracker, and the (lazily attached) terminal renderable.
 * Reactive metadata lives in the store; this registry holds live handles.
 */
import { spawn, type IPty } from "bun-pty";
import type { GhosttyTerminalRenderable } from "ghostty-opentui/opentui";
import { OutputScanner } from "./queries";
import { StatusTracker } from "./status";
import type { AgentStatus } from "./types";

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
  private renderable: GhosttyTerminalRenderable | null = null;
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

  attachRenderable(r: GhosttyTerminalRenderable): void {
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
    this.pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    try {
      this.pty.resize(Math.max(2, cols), Math.max(1, rows));
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
