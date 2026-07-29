import type { AgentStatus } from "../core/types";

export const theme = {
  bg: "#101019",
  stripBg: "#1c1c2a",
  stripBgFocused: "#2a2a44",
  tabFg: "#8888a0",
  tabFgActive: "#e8e8f0",
  tabBgActive: "#3d3d66",
  accent: "#7aa2f7",
  statusBarBg: "#16161f",
  statusBarFg: "#9999b0",
  prefixFg: "#101019",
  prefixBg: "#e5c07b",
  working: "#e5c07b",
  blocked: "#e06c75",
  done: "#98c379",
  idle: "#555570",
};

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
