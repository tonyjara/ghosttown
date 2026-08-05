/**
 * The one animated thing in the UI: a working agent's glyph pulses instead of
 * sitting still, so "it is thinking" reads from the sidebar without having to
 * remember what the row said a second ago. A still `✳` and a hung agent look
 * identical; a pulse does not.
 *
 * One clock for the whole app, so every indicator on screen pulses in phase —
 * two rows breathing out of step would read as two different things happening.
 */
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js";
import { store } from "../core/state";

/**
 * Claude's own asterisk pulse, which is what the `✳` in every other status
 * readout is a still frame of: animating it is the same symbol breathing, not a
 * second vocabulary. Symmetric on purpose — it swells and settles rather than
 * snapping back to the smallest frame. `·` is left out, since the sidebar
 * already spends that character on "idle, and no agent is running here".
 */
const FRAMES = ["✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳"] as const;

/** Slow enough to read as a pulse rather than a flicker (renderer is 30fps). */
const FRAME_MS = 140;

const [tick, setTick] = createSignal(0);

/**
 * Anything working at all. Nothing on screen animates otherwise, so this is
 * also the switch that keeps the renderer still: with every agent idle, no
 * timer runs and the UI repaints exactly as rarely as it did before.
 */
export function anyWorking(): boolean {
  for (const meta of Object.values(store.surfaces)) {
    if (meta.status === "working") return true;
  }
  return false;
}

/** Frame for a tick count. Pure, so the cycle is testable without waiting. */
export function pulseFrame(tick: number): string {
  const len = FRAMES.length;
  return FRAMES[((tick % len) + len) % len]!;
}

/**
 * Rooted at module scope rather than inside a component: the UI is torn down
 * and rebuilt on a config save (see app.tsx), and the clock has no reason to
 * stop and restart with it. Untracked reads are not a concern — the effect
 * reads only the store, so it re-runs when work starts or stops and never on
 * its own tick.
 */
createRoot(() => {
  createEffect(() => {
    if (!anyWorking()) return;
    const timer = setInterval(() => setTick((t) => t + 1), FRAME_MS);
    // A pulse is never a reason to hold the process open (tests, mostly).
    (timer as unknown as { unref?: () => void }).unref?.();
    onCleanup(() => clearInterval(timer));
  });
});

/**
 * The current frame. Reactive: read it inside a prop and that prop animates,
 * which is the whole mechanism — there is no per-row timer anywhere.
 */
export function workingPulse(): string {
  return pulseFrame(tick());
}
