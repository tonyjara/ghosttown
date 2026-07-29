import type { AgentStatus } from "./types";

/** Output within this window after a keystroke is treated as echo, not work. */
const ECHO_MS = 300;
/** Sustained output for this long flips a surface to `working`. */
const WORKING_AFTER_MS = 1000;
/** A gap this long ends an output burst. */
const BURST_GAP_MS = 1500;
/** Quiet for this long ends `working`. */
const DONE_QUIET_MS = 2500;
/** Work shorter than this settles to `idle` instead of `done`. */
const MIN_WORK_MS = 4000;

/**
 * Per-surface status: explicit reports (Claude Code hooks via `gt report`)
 * are authoritative and permanently disable the heuristic; otherwise output
 * activity drives idle → working → done/idle transitions.
 */
export class StatusTracker {
  status: AgentStatus = "idle";
  hasReporter = false;

  private lastOutputAt = 0;
  private lastInputAt = 0;
  private burstStartAt = 0;
  private workStartAt = 0;

  constructor(private onChange: (status: AgentStatus, prev: AgentStatus) => void) {}

  private set(status: AgentStatus): void {
    if (status === this.status) return;
    const prev = this.status;
    this.status = status;
    this.onChange(status, prev);
  }

  report(status: AgentStatus): void {
    this.hasReporter = true;
    this.set(status);
  }

  recordOutput(now = Date.now()): void {
    if (now - this.lastInputAt < ECHO_MS) return;
    if (now - this.lastOutputAt > BURST_GAP_MS) this.burstStartAt = now;
    this.lastOutputAt = now;
    if (this.hasReporter) return;
    if (this.status !== "working" && now - this.burstStartAt >= WORKING_AFTER_MS) {
      this.workStartAt = this.burstStartAt;
      this.set("working");
    }
  }

  recordInput(now = Date.now()): void {
    this.lastInputAt = now;
    // The user is interacting: done/blocked have been acted on.
    if (this.status === "done" || this.status === "blocked") this.set("idle");
  }

  /** Called on a coarse interval (~500ms) to detect end-of-work. */
  tick(now = Date.now()): void {
    if (this.hasReporter || this.status !== "working") return;
    if (now - this.lastOutputAt >= DONE_QUIET_MS) {
      const workedFor = this.lastOutputAt - this.workStartAt;
      this.set(workedFor >= MIN_WORK_MS ? "done" : "idle");
    }
  }
}
