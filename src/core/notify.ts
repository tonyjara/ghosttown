/**
 * Desktop notifications: delivery, plus the pure text work that gives one
 * enough context to act on.
 *
 * Two things make an agent notification useful. **Context**: which agent, in
 * which workspace, and what it actually wants — composed by notifySurface in
 * core/state, which knows where a surface lives. **A click that takes you
 * there**: the notification carries a `gt focus` on this session's control
 * socket, which switches workspace, pane and tab, and raises the terminal.
 *
 * A click action needs a notifier that can run a command, and macOS's built-in
 * `osascript -e 'display notification'` cannot (clicking it activates Script
 * Editor). So terminal-notifier is preferred when it is installed
 * (`brew install terminal-notifier`) and osascript is the fallback — same text,
 * no click. `[notifications] command` overrides both, on any platform.
 */

import { join } from "node:path";
import { loadConfig, type NotificationsConfig } from "./config";
import { dbg } from "./debug";
import type { AgentStatus } from "./types";

/** Where a notification came from, and how to get back to it. */
export interface NotifyFocus {
  /** Control socket of the session that owns the surface. */
  socket: string;
  surface: string;
}

export interface NotifyRequest {
  /** Throttle and notification-group key — the surface id, usually. */
  key: string;
  title: string;
  subtitle?: string;
  body: string;
  /** Present when the notification has somewhere to send you. */
  focus?: NotifyFocus;
}

/** Everything a notification can say about which agent it came from. */
export interface NotifyContext {
  /** What to call the tab: the user's name for it, the agent, the program. */
  label: string;
  /** The program's own title — for an agent, the task it is on. */
  title?: string;
  workspace?: string;
  /** The profile, when it is not the one always running. */
  session?: string;
  /** Drives the headline; "custom" is a notification the program asked for. */
  kind: AgentStatus | "custom";
  /** A title from the program (OSC 777) or `gt notify --title`. */
  explicitTitle?: string;
}

/** Reads as a sentence in the notification's headline. */
const VERBS: Partial<Record<AgentStatus, string>> = {
  done: "finished",
  blocked: "needs input",
  working: "started working",
};

/**
 * Headline and location line. The headline answers "is this mine to act on"
 * (which agent, what changed); the location answers "where do I go" — the
 * program's own title earns its place there because an agent puts the task it
 * is on in it, which is the difference between two tabs called `claude`.
 */
export function notifyText(ctx: NotifyContext): { title: string; subtitle: string } {
  const verb = ctx.kind === "custom" ? "" : (VERBS[ctx.kind] ?? "");
  const parts = [ctx.session, ctx.workspace];
  // The program supplied the headline, so the location line is where the tab
  // has to be named — otherwise nothing says which one sent this.
  if (ctx.explicitTitle) parts.push(ctx.label);
  // For a plain shell the label already *is* the program's title; only say it
  // twice when they differ.
  if (ctx.title !== ctx.label) parts.push(ctx.title);
  return {
    title: ctx.explicitTitle || (verb ? `${ctx.label} ${verb}` : ctx.label),
    subtitle: parts
      .map((p) => p?.trim())
      .filter((p): p is string => !!p)
      .join(" · "),
  };
}

const THROTTLE_MS = 4000;
const lastSent = new Map<string, number>();

export function desktopNotify(req: NotifyRequest): void {
  if (process.env.GHOSTTOWN_NO_NOTIFY) return;
  const settings = loadConfig().notifications;
  if (!settings.enabled) return;
  const now = Date.now();
  const last = lastSent.get(req.key) ?? 0;
  if (now - last < THROTTLE_MS) return;
  lastSent.set(req.key, now);

  const argv = notifierArgv(req, settings, terminalNotifierPath());
  if (!argv) return;
  dbg("notify", req.title, req.subtitle ?? "", req.body.slice(0, 60));
  try {
    Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  } catch {
    // Notifications are best-effort.
  }
}

/** Looked up once: this runs on every agent transition. */
let notifierPath: string | null | undefined;

function terminalNotifierPath(): string | null {
  if (notifierPath === undefined) {
    notifierPath = process.platform === "darwin" ? Bun.which("terminal-notifier") : null;
    dbg("notify: terminal-notifier", notifierPath ?? "not found (no click-to-focus)");
  }
  return notifierPath;
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/**
 * The command line for one notification, or null when this platform has no way
 * to show it. Pure, so the three backends are testable without a screen.
 */
export function notifierArgv(
  req: NotifyRequest,
  settings: NotificationsConfig,
  notifier: string | null,
): string[] | null {
  const app = terminalApp(settings);
  const focus = settings.click_focus === false ? null : req.focus;
  const click = focus ? focusCommand(focus, app) : null;

  if (settings.command) {
    return ["/bin/sh", "-c", expandCommand(settings.command, req, settings, click)];
  }
  if (process.platform !== "darwin") return null;

  const body = req.body || "notification";
  if (notifier) {
    const argv = [notifier, "-title", clamp(req.title, 80), "-message", clamp(body, 200)];
    if (req.subtitle) argv.push("-subtitle", clamp(req.subtitle, 100));
    if (settings.sound) argv.push("-sound", settings.sound);
    // One live notification per surface: a second report replaces the first
    // instead of stacking another card in Notification Center.
    argv.push("-group", `ghosttown-${req.key}`);
    if (click) argv.push("-execute", click);
    // No click action to install, so the next best thing is looking like it
    // came from the terminal — which is also what clicking it then raises.
    else if (app && isBundleId(app)) argv.push("-sender", app);
    return argv;
  }
  return ["osascript", "-e", osascriptNotification(req, settings)];
}

function osascriptNotification(req: NotifyRequest, settings: NotificationsConfig): string {
  const parts = [
    `display notification "${escapeAppleScript(clamp(req.body || "notification", 200))}"`,
    `with title "${escapeAppleScript(clamp(req.title, 80))}"`,
  ];
  if (req.subtitle) parts.push(`subtitle "${escapeAppleScript(clamp(req.subtitle, 100))}"`);
  if (settings.sound) parts.push(`sound name "${escapeAppleScript(settings.sound)}"`);
  return parts.join(" ");
}

/**
 * `[notifications] command`, with the notification substituted in. Values are
 * shell-quoted, so `notify-send {title} {body}` is safe whatever an agent
 * printed; `{focus}` is a full command and is not.
 */
export function expandCommand(
  template: string,
  req: NotifyRequest,
  settings: NotificationsConfig,
  click: string | null,
): string {
  const values: Record<string, string> = {
    title: shellQuote(req.title),
    subtitle: shellQuote(req.subtitle ?? ""),
    body: shellQuote(req.body),
    sound: shellQuote(settings.sound ?? ""),
    surface: shellQuote(req.focus?.surface ?? ""),
    socket: shellQuote(req.focus?.socket ?? ""),
    focus: click ?? "true",
  };
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
}

// ---------------------------------------------------------------------------
// Click-to-focus
// ---------------------------------------------------------------------------

/**
 * The command a click runs: `gt focus` against the session that sent the
 * notification. Invoked as `bun <entry>` rather than `gt` — a notifier's click
 * handler gets its own environment, so nothing about the caller's PATH holds.
 * The terminal app is baked in here for the same reason: only this process can
 * still tell which terminal the session belongs to.
 */
export function focusCommand(focus: NotifyFocus, app: string | null): string {
  const entry = join(import.meta.dir, "..", "index.ts");
  const argv = [
    process.execPath,
    entry,
    "focus",
    "--socket",
    focus.socket,
    "--surface",
    focus.surface,
  ];
  if (app) argv.push("--activate", app);
  return argv.map(shellQuote).join(" ");
}

/** TERM_PROGRAM values for terminals that do not export a bundle id. */
const TERM_PROGRAM_APPS: Record<string, string> = {
  ghostty: "com.mitchellh.ghostty",
  "iTerm.app": "com.googlecode.iterm2",
  Apple_Terminal: "com.apple.Terminal",
  WezTerm: "com.github.wez.wezterm",
  vscode: "com.microsoft.VSCode",
  Hyper: "co.zeit.hyper",
  alacritty: "org.alacritty",
  kitty: "net.kovidgoyal.kitty",
  WarpTerminal: "dev.warp.Warp-Stable",
  rio: "com.raphaelamorim.rio",
};

/**
 * The app to bring forward when a notification is clicked: whatever terminal
 * this session was started from. Every surface inherits the client's
 * environment, so this holds inside the session too — but a session reattached
 * from a different terminal keeps pointing at the original one, which is what
 * `[notifications] terminal_app` is for.
 */
export function terminalApp(settings: NotificationsConfig): string | null {
  if (settings.terminal_app) return settings.terminal_app;
  const bundle = process.env.__CFBundleIdentifier;
  if (bundle) return bundle;
  const program = process.env.TERM_PROGRAM;
  // tmux/screen say nothing about the window a session is actually in.
  return (program && TERM_PROGRAM_APPS[program]) ?? null;
}

function isBundleId(app: string): boolean {
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(app);
}

/**
 * Raise a terminal, named either by bundle id or by application name. Awaited,
 * because the caller is `gt focus` — a process about to exit, which would take
 * the osascript down with it.
 */
export async function activateApp(app: string): Promise<void> {
  if (process.platform !== "darwin" || !app) return;
  const target = isBundleId(app) ? `id "${escapeAppleScript(app)}"` : `"${escapeAppleScript(app)}"`;
  try {
    await Bun.spawn(["osascript", "-e", `tell application ${target} to activate`], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }).exited;
  } catch {
    // Raising the window is a nicety; the pane is focused either way.
  }
}

// ---------------------------------------------------------------------------
// Screen context
//
// Without hooks, the only thing that knows what an agent wants is its screen.
// The last line of it is usually chrome (an input box, a hint bar), so the scan
// walks up until it finds a line that carries words.
// ---------------------------------------------------------------------------

/** Box drawing, bullets and status glyphs — decoration, not content. */
const DECORATION = /[─-╿▀-▟■-◿•●⏺✓✗✱⚑→]/g;
/** Lines a TUI paints every frame; never the reason for a notification. */
const CHROME = [
  /^\?\s*for shortcuts/i,
  /^esc to (interrupt|cancel|go back)/i,
  /^(shift\+|ctrl\+|alt\+|tab to|press )/i,
  /^bypassing permissions/i,
  /^\d+%\s|^\d+\/\d+$/,
  /^(auto-accept|plan mode|accept edits)/i,
];
/** Rows to look back through; deeper than that is scrollback, not this turn. */
const SCAN_LINES = 60;

function cleanLine(line: string): string {
  return line.replace(DECORATION, " ").replace(/\s+/g, " ").trim();
}

/** A shell prompt (`~/src %`, `$`) reads as content but says nothing. */
function isPrompt(line: string): boolean {
  return line.length <= 40 && /[$%#❯]$/.test(line);
}

function isChrome(line: string): boolean {
  const letters = line.replace(/[^A-Za-z0-9]/g, "");
  if (letters.length < 3) return true;
  if (isPrompt(line)) return true;
  return CHROME.some((re) => re.test(line));
}

/**
 * The most recent line of a surface's screen worth putting in a notification,
 * or "" when there is nothing but chrome.
 */
export function screenDetail(text: string, maxLen = 160): string {
  const lines = text.split("\n");
  const stop = Math.max(0, lines.length - SCAN_LINES);
  for (let i = lines.length - 1; i >= stop; i--) {
    const line = cleanLine(lines[i] ?? "");
    if (!line || isChrome(line)) continue;
    return clamp(line, maxLen);
  }
  return "";
}

// ---------------------------------------------------------------------------

function clamp(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Single-quoted for `sh -c`, so an agent's output cannot become a command. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
