import { describe, expect, it } from "bun:test";
import { StatusTracker } from "./status";

function makeTracker() {
  const changes: string[] = [];
  const tracker = new StatusTracker((status) => changes.push(status));
  return { tracker, changes };
}

describe("StatusTracker heuristic", () => {
  it("sustained output → working, long work + quiet → done", () => {
    const { tracker } = makeTracker();
    let t = 1_000_000;
    for (let i = 0; i < 12; i++) tracker.recordOutput((t += 500)); // 6s of output
    expect(tracker.status).toBe("working");
    tracker.tick(t + 3000); // quiet past DONE_QUIET_MS
    expect(tracker.status).toBe("done");
  });

  it("short burst settles to idle, not done", () => {
    const { tracker } = makeTracker();
    let t = 1_000_000;
    for (let i = 0; i < 4; i++) tracker.recordOutput((t += 500)); // 2s of output
    expect(tracker.status).toBe("working");
    tracker.tick(t + 3000);
    expect(tracker.status).toBe("idle");
  });

  it("echo right after input does not count as work", () => {
    const { tracker } = makeTracker();
    let t = 1_000_000;
    for (let i = 0; i < 10; i++) {
      tracker.recordInput((t += 400));
      tracker.recordOutput(t + 50); // echo 50ms after keypress
    }
    expect(tracker.status).toBe("idle");
  });

  it("explicit report disables the heuristic", () => {
    const { tracker } = makeTracker();
    tracker.report("working");
    let t = 1_000_000;
    tracker.tick((t += 60_000));
    expect(tracker.status).toBe("working"); // no auto-done
    tracker.report("done");
    expect(tracker.status).toBe("done");
  });

  it("user input clears done/blocked to idle", () => {
    const { tracker } = makeTracker();
    tracker.report("blocked");
    tracker.recordInput();
    expect(tracker.status).toBe("idle");
  });
});
