/** Row helpers shared by the scrolling lists (sidebar halves, finder dialogs). */

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}

/** First index of a window of `visible` rows that keeps `sel` inside it. */
export function windowStart(sel: number, count: number, visible: number): number {
  if (count <= visible || visible <= 0) return 0;
  return Math.max(0, Math.min(sel - visible + 1, count - visible));
}

/**
 * `left` padded out to `width`, with `right` sitting flush against the end.
 * The left side is truncated when the two would collide.
 */
export function twoColumnRow(left: string, right: string, width: number): string {
  if (!right) return truncate(left, width).padEnd(width);
  const room = Math.max(1, width - right.length - 1);
  return truncate(left, room).padEnd(room) + " " + right;
}
