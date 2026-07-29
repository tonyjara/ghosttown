import { appendFileSync } from "node:fs";

const path = process.env.GHOSTTOWN_DEBUG_LOG;

/** Append a debug line to GHOSTTOWN_DEBUG_LOG if set. Never throws. */
export function dbg(...args: unknown[]): void {
  if (!path) return;
  try {
    const line = `[${new Date().toISOString()}] ${args
      .map((a) =>
        a instanceof Error ? (a.stack ?? a.message) : typeof a === "string" ? a : JSON.stringify(a),
      )
      .join(" ")}\n`;
    appendFileSync(path, line);
  } catch {
    // best effort
  }
}
