/**
 * The working pulse. What is worth pinning down is the cycle (it has to come
 * back to where it started, or the animation stutters) and the cell width of
 * every frame: sidebar rows are padded with `padEnd` on string length, so a
 * two-cell glyph would shove the workspace column off the end of the row.
 */
import { describe, expect, it } from "bun:test";
import { activeSurfaceId, createWorkspace, setStore } from "../core/state";
import { anyWorking, pulseFrame } from "./spinner";

describe("pulseFrame", () => {
  it("cycles and wraps", () => {
    const cycle = Array.from({ length: 8 }, (_, i) => pulseFrame(i));
    expect(new Set(cycle).size).toBeGreaterThan(1);
    // The wrap is the point: frame N and frame N+len are the same glyph, so a
    // tick counter that runs for hours never lands on a hole.
    for (let i = 0; i < 8; i++) expect(pulseFrame(i + cycle.length)).toBe(cycle[i]!);
    expect(pulseFrame(0)).toBe(pulseFrame(cycle.length * 1000));
  });

  it("swells and settles rather than snapping back", () => {
    // Symmetric: the second half retraces the first, so there is no jump
    // between the last frame and the first.
    const cycle = Array.from({ length: 8 }, (_, i) => pulseFrame(i));
    const half = cycle.length / 2;
    expect(cycle.slice(half + 1)).toEqual(cycle.slice(1, half).reverse());
  });

  it("stays one cell wide, whatever the frame", () => {
    for (let i = 0; i < 16; i++) expect(Bun.stringWidth(pulseFrame(i))).toBe(1);
  });
});

describe("anyWorking", () => {
  // Only the true direction is asserted: the store is module-global across test
  // files, so "nothing is working" is not this file's to claim — a sibling test
  // may have left an agent mid-run.
  it("sees a working surface, which is what starts the clock", () => {
    createWorkspace({ name: "pulse home" });
    const id = activeSurfaceId();
    setStore("surfaces", id, "status", "working");
    expect(anyWorking()).toBe(true);
    setStore("surfaces", id, "status", "idle");
  });
});
