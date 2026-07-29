import { loadConfig, type Config } from "../core/config";
import { dbg } from "../core/debug";
import type { AgentStatus } from "../core/types";
import { THEMES, type Theme } from "./themes";

export type { Theme } from "./themes";

/** Named theme from [appearance], then [theme] color overrides on top. */
export function resolveTheme(config: Config): Theme {
  const name = config.appearance?.theme || "ghosttown";
  const base = THEMES[name];
  if (!base) dbg("theme: unknown theme, using ghosttown", name);
  const out: Theme = { ...(base ?? THEMES["ghosttown"]!) };
  for (const [key, value] of Object.entries(config.theme ?? {})) {
    if (key in out && typeof value === "string" && value) {
      (out as unknown as Record<string, string>)[key] = value;
    }
  }
  return out;
}

/** Resolved once at startup; prefix+R (reload) picks up config changes. */
export const theme: Theme = resolveTheme(loadConfig());

export function statusGlyph(status: AgentStatus): { glyph: string; color: string } {
  switch (status) {
    case "working":
      return { glyph: "✳", color: theme.working };
    case "blocked":
      return { glyph: "⚑", color: theme.blocked };
    case "done":
      return { glyph: "✓", color: theme.done };
    default:
      return { glyph: "", color: theme.idle };
  }
}

/** Sidebar variant: idle agents get an explicit glyph instead of nothing. */
export function agentGlyph(status: AgentStatus): { glyph: string; color: string } {
  if (status === "idle") return { glyph: "○", color: theme.idle };
  return statusGlyph(status);
}
