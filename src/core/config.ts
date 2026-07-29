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
  general: { shell: string; session: string };
  notifications: { enabled: boolean; sound: string };
  keybinds: KeybindsConfig;
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
  "close-tab": "close tab",
  "focus-left": "focus pane left",
  "focus-right": "focus pane right",
  "focus-up": "focus pane up",
  "focus-down": "focus pane down",
  quit: "quit session",
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

/** Rows for the help overlay, from the merged (i.e. effective) keybinds. */
export function helpRows(config: Config): Array<{ keys: string; label: string }> {
  const prefix = config.keybinds.prefix;
  const rows = ACTIONS.map((action) => ({
    keys: keysForAction(config, action).join(" "),
    label: ACTION_LABELS[action],
  }));
  rows.push({ keys: "1-9", label: "select tab N" });
  rows.push({ keys: prefix, label: `send literal ${prefix}` });
  return rows;
}
