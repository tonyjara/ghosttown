/**
 * Configuration: shipped defaults (config.default.toml) deep-merged with the
 * user's file. The user's values always win; keybind lists replace the
 * default list for that action.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { dbg } from "./debug";

export interface KeybindsConfig {
  prefix: string;
  [action: string]: string | string[];
}

export interface Config {
  general: { shell: string; session: string; restore_session: boolean };
  appearance: { theme: string; pane_gap: number; cursor_blink: boolean };
  notifications: { enabled: boolean; sound: string };
  sidebar: { visible: boolean; width: number };
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
  "focus-left",
  "focus-right",
  "focus-up",
  "focus-down",
  "toggle-sidebar",
  "resize-mode",
  "switch-profile",
  "new-profile",
  "new-workspace",
  "delete-workspace",
  "detach",
  "reload",
  "quit",
  "help",
] as const;
export type Action = (typeof ACTIONS)[number];

export const ACTION_LABELS: Record<Action, string> = {
  "split-right": "split pane right",
  "split-down": "split pane down",
  "new-tab": "new tab in pane",
  "next-tab": "next tab",
  "prev-tab": "previous tab",
  "close-tab": "close tab (last tab closes the pane)",
  "focus-left": "focus pane left",
  "focus-right": "focus pane right",
  "focus-up": "focus pane up",
  "focus-down": "focus pane down",
  "toggle-sidebar": "toggle sidebar",
  "resize-mode": "resize mode (h j k l, esc leaves)",
  "switch-profile": "switch profile (running sessions)",
  "new-profile": "new profile (fresh session)",
  "new-workspace": "new workspace (new layout)",
  "delete-workspace": "delete workspace (confirm required)",
  detach: "detach (keeps running in background)",
  reload: "reload ghosttown (dev)",
  quit: "kill ghosttown & everything in it",
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

function parseToml(text: string): Record<string, unknown> {
  return (Bun as unknown as { TOML: { parse: (s: string) => Record<string, unknown> } }).TOML.parse(
    text,
  );
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const defaultsPath = join(import.meta.dir, "..", "..", "config.default.toml");
  const defaults = parseToml(readFileSync(defaultsPath, "utf8")) as unknown as Config;

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

export function keysForAction(config: Config, action: Action): string[] {
  const v = config.keybinds[action];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

type HelpCategory = "Panes" | "Tabs" | "Profiles" | "Navigation" | "Sidebar" | "Other";

const ACTION_CATEGORIES: Record<Action, HelpCategory> = {
  "split-right": "Panes",
  "split-down": "Panes",
  "new-tab": "Tabs",
  "next-tab": "Tabs",
  "prev-tab": "Tabs",
  "close-tab": "Tabs",
  "focus-left": "Navigation",
  "focus-right": "Navigation",
  "focus-up": "Navigation",
  "focus-down": "Navigation",
  "toggle-sidebar": "Sidebar",
  "resize-mode": "Panes",
  "switch-profile": "Profiles",
  "new-profile": "Profiles",
  "new-workspace": "Panes",
  "delete-workspace": "Panes",
  detach: "Other",
  reload: "Other",
  quit: "Other",
  help: "Other",
};

interface HelpRow {
  keys: string;
  label: string;
}

interface HelpSection {
  category: HelpCategory;
  rows: HelpRow[];
}

/** Rows for the help overlay, organized by category. */
export function helpSections(config: Config): HelpSection[] {
  const prefix = config.keybinds.prefix;
  const byCategory = new Map<HelpCategory, HelpRow[]>();

  const categories: HelpCategory[] = ["Panes", "Tabs", "Navigation", "Sidebar", "Profiles", "Other"];
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
  byCategory.get("Sidebar")?.push({ keys: "j k ⏎ a r d", label: "move/open/new/rename/delete" });
  byCategory.get("Sidebar")?.push({ keys: "click", label: "focus the sidebar on that row" });
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
