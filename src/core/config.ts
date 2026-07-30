/**
 * Configuration: shipped defaults (config.default.toml) deep-merged with the
 * user's file. The user's values always win; keybind lists replace the
 * default list for that action.
 */
import { existsSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { dbg } from "./debug";

export interface KeybindsConfig {
  prefix: string;
  [action: string]: string | string[];
}

/** [notifications]. See core/notify.ts for what each backend can do. */
export interface NotificationsConfig {
  enabled: boolean;
  sound: string;
  /** Clicking a notification jumps to the agent that sent it. */
  click_focus?: boolean;
  /** Terminal to raise on click; empty = the one the session was started from. */
  terminal_app?: string;
  /** Custom notifier command, replacing the built-in ones. */
  command?: string;
}

export interface Config {
  general: { shell: string; session: string; restore_session: boolean };
  appearance: { theme: string; pane_gap: number; cursor_blink: boolean };
  notifications: NotificationsConfig;
  sidebar: { visible: boolean; width: number };
  /** Agent detection: which commands count, how often to look, what else lists. */
  agents?: {
    detect?: boolean;
    commands?: string[];
    poll_ms?: number;
    include_busy?: boolean;
    /** Keep listing a tab after the agent in it exits (off: the row goes away). */
    keep_exited?: boolean;
  };
  keybinds: KeybindsConfig;
  /** Optional per-color overrides applied on top of the named theme. */
  theme?: Record<string, string>;
}

/** Actions the app dispatches; used to build the key→action map and the help overlay. */
export const ACTIONS = [
  "split-right",
  "split-down",
  "new-tab",
  "next-tab",
  "prev-tab",
  "close-tab",
  "rename-tab",
  "focus-left",
  "focus-right",
  "focus-up",
  "focus-down",
  "toggle-sidebar",
  "resize-mode",
  "switch-profile",
  "new-profile",
  "new-workspace",
  "next-workspace",
  "prev-workspace",
  "rename-workspace",
  "delete-workspace",
  "find-workspace",
  "find-agent",
  "detach",
  "reload",
  "quit",
  "help",
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Help-pane wording. Deliberately short: these are laid out in columns inside
 * a terminal, and the prose lives in config.default.toml.
 */
export const ACTION_LABELS: Record<Action, string> = {
  "split-right": "split pane right",
  "split-down": "split pane down",
  "new-tab": "new tab in pane",
  "next-tab": "next tab",
  "prev-tab": "previous tab",
  "close-tab": "close tab (pane if last)",
  "rename-tab": "rename this tab",
  "focus-left": "focus pane left",
  "focus-right": "focus pane right",
  "focus-up": "focus pane up",
  "focus-down": "focus pane down",
  "toggle-sidebar": "toggle sidebar",
  "resize-mode": "resize mode (h j k l)",
  "switch-profile": "switch profile",
  "new-profile": "new profile",
  "new-workspace": "new workspace",
  "next-workspace": "next workspace",
  "prev-workspace": "previous workspace",
  "rename-workspace": "rename this workspace",
  "delete-workspace": "delete workspace (asks)",
  "find-workspace": "find workspace (fuzzy)",
  "find-agent": "find agent (fuzzy jump)",
  detach: "detach (keeps running)",
  reload: "reload ghosttown (dev)",
  quit: "kill ghosttown entirely",
  help: "toggle this help",
};

export interface ParsedChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  name: string;
}

export function parseChord(spec: string): ParsedChord {
  const parts = spec.toLowerCase().split("+");
  const name = parts.pop() ?? "";
  return {
    ctrl: parts.includes("ctrl"),
    alt: parts.includes("alt") || parts.includes("option") || parts.includes("meta"),
    shift: parts.includes("shift"),
    name: name === "space" ? " " : name,
  };
}

/**
 * Canonical lookup key for a configured binding, matching what the terminal
 * actually sends. Bare keys pass through ("c", "C", "|", "left"); a shifted
 * letter folds into its uppercase form ("shift+c" → "C") because that is the
 * sequence a terminal emits.
 */
export function normalizeKeySpec(spec: string): string {
  if (spec.length <= 1 || !spec.includes("+")) return spec === "space" ? " " : spec;
  const { ctrl, alt, shift, name } = parseChord(spec);
  const key = shift && name.length === 1 ? name.toUpperCase() : name;
  if (!ctrl && !alt) return key;
  return `${ctrl ? "ctrl+" : ""}${alt ? "alt+" : ""}${shift && key.length > 1 ? "shift+" : ""}${key}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** User values win. Objects merge recursively; arrays and scalars replace. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

export function userConfigPath(): string {
  if (process.env.GHOSTTOWN_CONFIG) return process.env.GHOSTTOWN_CONFIG;
  const xdg = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(xdg, "ghosttown", "config.toml");
}

/** The shipped defaults, next to package.json. */
export function defaultConfigPath(): string {
  return join(import.meta.dir, "..", "..", "config.default.toml");
}

function parseToml(text: string): Record<string, unknown> {
  return (Bun as unknown as { TOML: { parse: (s: string) => Record<string, unknown> } }).TOML.parse(
    text,
  );
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const defaults = parseToml(readFileSync(defaultConfigPath(), "utf8")) as unknown as Config;

  let merged = defaults;
  const userPath = userConfigPath();
  if (existsSync(userPath)) {
    try {
      const user = parseToml(readFileSync(userPath, "utf8"));
      merged = deepMerge(defaults, user);
      dbg("config: merged user config", userPath);
    } catch (err) {
      dbg("config: failed to parse user config, using defaults", userPath, err as Error);
    }
  }
  cached = merged;
  return merged;
}

/** Test hook: force a specific config (or null to reload from disk). */
export function setConfigForTest(config: Config | null): void {
  cached = config;
}

/** Drop the cache so the next loadConfig() re-reads both files. */
export function reloadConfig(): Config {
  cached = null;
  return loadConfig();
}

/** Editors write twice (temp file, then rename) — one callback per save. */
const WATCH_DEBOUNCE_MS = 150;

/**
 * Call back when either config file changes, so a save can be applied without
 * restarting anything. The containing *directory* is watched and events are
 * filtered by filename: a watch on the file itself stops firing as soon as an
 * editor replaces it rather than writing in place. Returns a stop function.
 */
export function watchConfig(onChange: () => void): () => void {
  const watchers: FSWatcher[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const byDir = new Map<string, Set<string>>();
  for (const path of [userConfigPath(), defaultConfigPath()]) {
    const dir = dirname(path);
    if (!existsSync(dir)) continue;
    const files = byDir.get(dir) ?? new Set<string>();
    files.add(basename(path));
    byDir.set(dir, files);
  }

  for (const [dir, files] of byDir) {
    try {
      watchers.push(
        watch(dir, (_event, name) => {
          // A rename event can arrive with no name; treat that as a hit.
          if (name && !files.has(name)) return;
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            timer = null;
            onChange();
          }, WATCH_DEBOUNCE_MS);
        }),
      );
    } catch (err) {
      dbg("config: cannot watch", dir, err as Error);
    }
  }
  dbg("config: watching", watchers.length, "directories");

  return () => {
    if (timer) clearTimeout(timer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
  };
}

export function keysForAction(config: Config, action: Action): string[] {
  const v = config.keybinds[action];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

type HelpCategory =
  | "Panes"
  | "Tabs"
  | "Navigation"
  | "Workspaces"
  | "Agents"
  | "Profiles"
  | "Sidebar"
  | "Other";

const ACTION_CATEGORIES: Record<Action, HelpCategory> = {
  "split-right": "Panes",
  "split-down": "Panes",
  "new-tab": "Tabs",
  "next-tab": "Tabs",
  "prev-tab": "Tabs",
  "close-tab": "Tabs",
  "rename-tab": "Tabs",
  "focus-left": "Navigation",
  "focus-right": "Navigation",
  "focus-up": "Navigation",
  "focus-down": "Navigation",
  "toggle-sidebar": "Sidebar",
  "resize-mode": "Panes",
  "switch-profile": "Profiles",
  "new-profile": "Profiles",
  "new-workspace": "Workspaces",
  "next-workspace": "Workspaces",
  "prev-workspace": "Workspaces",
  "rename-workspace": "Workspaces",
  "delete-workspace": "Workspaces",
  "find-workspace": "Workspaces",
  "find-agent": "Agents",
  detach: "Other",
  reload: "Other",
  quit: "Other",
  help: "Other",
};

export interface HelpRow {
  keys: string;
  label: string;
}

export interface HelpSection {
  category: HelpCategory;
  rows: HelpRow[];
}

/** Rows for the help overlay, organized by category. */
export function helpSections(config: Config): HelpSection[] {
  const prefix = config.keybinds.prefix;
  const byCategory = new Map<HelpCategory, HelpRow[]>();

  const categories: HelpCategory[] = [
    "Panes",
    "Tabs",
    "Navigation",
    "Workspaces",
    "Agents",
    "Profiles",
    "Sidebar",
    "Other",
  ];
  for (const cat of categories) byCategory.set(cat, []);

  // Populate from actions
  for (const action of ACTIONS) {
    const keys = keysForAction(config, action).join(" ");
    if (!keys) continue;
    const cat = ACTION_CATEGORIES[action];
    const row = { keys, label: ACTION_LABELS[action] };
    byCategory.get(cat)?.push(row);
  }

  // Add special bindings
  byCategory.get("Tabs")?.push({ keys: "1-9", label: "select tab N" });
  // In a finder the query takes the letters, so the list moves on the arrows.
  byCategory.get("Agents")?.push({ keys: "↑ ↓", label: "move (also C-n / C-p)" });
  byCategory.get("Agents")?.push({ keys: "⏎ esc", label: "take it / cancel" });
  // The switcher doubles as the profile manager, on the sidebar's own a/r/d.
  byCategory.get("Profiles")?.push({ keys: "a r d", label: "in list: new/rename/kill" });
  byCategory.get("Sidebar")?.push({ keys: "j k ⏎", label: "move / open" });
  byCategory.get("Sidebar")?.push({ keys: "a r d", label: "new / rename / delete" });
  byCategory.get("Sidebar")?.push({ keys: "click", label: "focus that row" });
  byCategory.get("Other")?.push({ keys: prefix, label: `send literal ${prefix}` });

  return categories
    .filter((cat) => (byCategory.get(cat) ?? []).length > 0)
    .map((cat) => ({
      category: cat,
      rows: byCategory.get(cat) ?? [],
    }));
}

/** Flattened rows for backwards compatibility. */
export function helpRows(config: Config): Array<{ keys: string; label: string }> {
  return helpSections(config).flatMap((s) => s.rows);
}

// ---------------------------------------------------------------------------
// Help overlay layout
//
// The full list is ~45 rows, which is taller than most terminals — so the pane
// lays its categories out in as many columns as it takes to fit, and drops the
// blank line between them before it resorts to clipping. Pure geometry, kept
// here (and unit-tested) rather than in the renderer.
// ---------------------------------------------------------------------------

export interface HelpLayout {
  /** Categories distributed over columns, in order. */
  columns: HelpSection[][];
  /** Cells for the key column, so labels line up. */
  keyWidth: number;
  /** Cells a label may use before it has to be truncated. */
  labelWidth: number;
  /** One column, borders excluded. */
  columnWidth: number;
  /** Blank line between categories. First to go when rows are scarce. */
  spaced: boolean;
  /** Rows had to be dropped: the terminal is too small even in columns. */
  clipped: boolean;
  /** Box size, borders included. */
  width: number;
  height: number;
}

/** A label narrower than this is unreadable; use fewer columns instead. */
const MIN_LABEL_WIDTH = 14;
const MAX_COLUMNS = 3;

const blockHeight = (section: HelpSection): number => 1 + section.rows.length;

function columnHeight(column: HelpSection[], spaced: boolean): number {
  const rows = column.reduce((h, s) => h + blockHeight(s), 0);
  return rows + (spaced ? Math.max(0, column.length - 1) : 0);
}

/** Every way to cut the list into `count` runs, categories kept whole and in order. */
function partitions(sections: HelpSection[], count: number): HelpSection[][][] {
  if (count <= 1 || sections.length <= 1) return [[sections]];
  const out: HelpSection[][][] = [];
  for (let cut = 1; cut <= sections.length - count + 1; cut++) {
    for (const rest of partitions(sections.slice(cut), count - 1)) {
      out.push([sections.slice(0, cut), ...rest]);
    }
  }
  return out;
}

/** The split whose tallest column is shortest — the balanced one. */
function columnize(sections: HelpSection[], count: number, spaced: boolean): HelpSection[][] {
  let best = [sections];
  let bestHeight = Infinity;
  for (const candidate of partitions(sections, Math.min(count, sections.length))) {
    const tallest = Math.max(...candidate.map((c) => columnHeight(c, spaced)));
    if (tallest < bestHeight) {
      bestHeight = tallest;
      best = candidate;
    }
  }
  return best;
}

/**
 * Drop whatever runs past `rows` so nothing is drawn outside the box. Only
 * reached on a terminal too small to hold the list in any arrangement.
 */
function clipColumn(column: HelpSection[], spaced: boolean, rows: number): HelpSection[] {
  const out: HelpSection[] = [];
  let used = 0;
  for (const section of column) {
    used += used > 0 && spaced ? 1 : 0;
    if (used + 1 >= rows) break; // no room for a header plus a row under it
    const room = rows - used - 1;
    out.push({ category: section.category, rows: section.rows.slice(0, room) });
    used += 1 + Math.min(room, section.rows.length);
  }
  return out;
}

/**
 * Fit the help rows into the screen: the fewest columns that show everything,
 * preferring one spaced column and giving up the spacing before the content.
 */
export function helpLayout(
  config: Config,
  screen: { width: number; height: number },
): HelpLayout {
  const sections = helpSections(config);
  const rows = sections.flatMap((s) => s.rows);
  const keyWidth = Math.max(6, ...rows.map((r) => r.keys.length));
  const longestLabel = Math.max(10, ...rows.map((r) => r.label.length));
  // The box: 2 border columns, and 2 border + spacer + footer rows.
  const maxWidth = Math.max(24, screen.width - 4);
  const maxRows = Math.max(4, screen.height - 3 - 4);

  const candidate = (count: number, spaced: boolean, force = false): HelpLayout | null => {
    const columnWidth = Math.floor((maxWidth - 2) / count);
    const labelWidth = columnWidth - keyWidth - 2;
    if (labelWidth < MIN_LABEL_WIDTH && !force) return null;
    const columns = columnize(sections, count, spaced);
    const content = Math.max(...columns.map((c) => columnHeight(c, spaced)));
    const width = Math.min(
      maxWidth,
      columns.length * Math.min(columnWidth, keyWidth + longestLabel + 2) + 2,
    );
    const clipped = content > maxRows;
    return {
      columns: clipped ? columns.map((c) => clipColumn(c, spaced, maxRows)) : columns,
      keyWidth,
      labelWidth: Math.max(4, Math.min(labelWidth, longestLabel)),
      columnWidth: Math.floor((width - 2) / columns.length),
      spaced,
      clipped,
      width,
      height: Math.min(screen.height - 3, content + 4),
    };
  };

  // Fewest columns first (wider labels), and spacing before density.
  let last: HelpLayout | null = null;
  for (let count = 1; count <= MAX_COLUMNS; count++) {
    for (const spaced of [true, false]) {
      const layout = candidate(count, spaced);
      if (!layout) continue;
      last = layout;
      if (!layout.clipped) return layout;
    }
  }
  // A terminal too small for the whole list in any arrangement: show as much
  // as fits, in as many columns as stayed readable.
  return last ?? candidate(MAX_COLUMNS, false, true)!;
}
