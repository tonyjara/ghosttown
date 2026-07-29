/**
 * Desktop notifications. MVP channel is macOS osascript (built in, no deps);
 * other platforms silently no-op. OSC 9 forwarding to the host terminal is
 * phase 2 (opentui owns stdout, so raw writes could tear frames).
 */

import { loadConfig } from "./config";

const THROTTLE_MS = 4000;
const lastSent = new Map<string, number>();

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export function desktopNotify(key: string, title: string, body: string): void {
  if (process.env.GHOSTTOWN_NO_NOTIFY) return;
  const settings = loadConfig().notifications;
  if (!settings.enabled) return;
  const now = Date.now();
  const last = lastSent.get(key) ?? 0;
  if (now - last < THROTTLE_MS) return;
  lastSent.set(key, now);

  if (process.platform !== "darwin") return;
  const sound = settings.sound ? ` sound name "${escapeAppleScript(settings.sound)}"` : "";
  const script = `display notification "${escapeAppleScript(body.slice(0, 200))}" with title "${escapeAppleScript(title.slice(0, 80))}"${sound}`;
  try {
    Bun.spawn(["osascript", "-e", script], {
      stdout: "ignore",
      stderr: "ignore",
    });
  } catch {
    // Notifications are best-effort.
  }
}
