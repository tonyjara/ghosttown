/**
 * Built-in color themes. Pick one with [appearance] theme = "<name>" in the
 * config; override individual keys via the [theme] table. Palettes follow
 * each scheme's published spec (catppuccin.com, tokyonight, gruvbox, nord,
 * draculatheme.com).
 */

export interface Theme {
  /** Root background (also fills the gaps between panes). */
  bg: string;
  /** Tab strip background of unfocused panes. */
  stripBg: string;
  /** Tab strip background of the focused pane; also overlay/dialog bg. */
  stripBgFocused: string;
  /** Inactive tab text. */
  tabFg: string;
  /** Active tab / emphasized text. */
  tabFgActive: string;
  /** Active tab background. */
  tabBgActive: string;
  /** Accent (session name, dialog borders, selected workspace). */
  accent: string;
  statusBarBg: string;
  statusBarFg: string;
  /** PREFIX/RESIZE badge text (on prefixBg / accent). */
  prefixFg: string;
  prefixBg: string;
  /** Agent status colors. */
  working: string;
  blocked: string;
  done: string;
  /** Muted text: idle agents, section headers, hints. */
  idle: string;
  sidebarBg: string;
  sidebarSelBg: string;
  /**
   * The row you are *in* (the current agent), as opposed to the row the cursor
   * is on (sidebarSelBg). Deliberately quieter than that one: it is there all
   * the time, and it has to leave the status color the loudest thing in a row.
   */
  sidebarCurBg: string;
}

export const THEMES: Record<string, Theme> = {
  ghosttown: {
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
    sidebarBg: "#13131e",
    sidebarSelBg: "#3d3d66",
    sidebarCurBg: "#222237",
  },
  "catppuccin-mocha": {
    bg: "#1e1e2e", // base
    stripBg: "#181825", // mantle
    stripBgFocused: "#313244", // surface0
    tabFg: "#a6adc8", // subtext0
    tabFgActive: "#cdd6f4", // text
    tabBgActive: "#45475a", // surface1
    accent: "#89b4fa", // blue
    statusBarBg: "#11111b", // crust
    statusBarFg: "#a6adc8",
    prefixFg: "#11111b",
    prefixBg: "#f9e2af", // yellow
    working: "#f9e2af",
    blocked: "#f38ba8", // red
    done: "#a6e3a1", // green
    idle: "#6c7086", // overlay0
    sidebarBg: "#181825",
    sidebarSelBg: "#45475a",
    sidebarCurBg: "#313244", // surface0
  },
  "catppuccin-latte": {
    bg: "#eff1f5", // base
    stripBg: "#e6e9ef", // mantle
    stripBgFocused: "#ccd0da", // surface0
    tabFg: "#6c6f85", // subtext0
    tabFgActive: "#4c4f69", // text
    tabBgActive: "#bcc0cc", // surface1
    accent: "#1e66f5", // blue
    statusBarBg: "#dce0e8", // crust
    statusBarFg: "#6c6f85",
    prefixFg: "#eff1f5",
    prefixBg: "#df8e1d", // yellow
    working: "#df8e1d",
    blocked: "#d20f39", // red
    done: "#40a02b", // green
    idle: "#9ca0b0", // overlay0
    sidebarBg: "#e6e9ef",
    sidebarSelBg: "#bcc0cc",
    sidebarCurBg: "#ccd0da", // surface0
  },
  tokyonight: {
    bg: "#1a1b26",
    stripBg: "#16161e",
    stripBgFocused: "#292e42",
    tabFg: "#a9b1d6",
    tabFgActive: "#c0caf5",
    tabBgActive: "#3b4261",
    accent: "#7aa2f7",
    statusBarBg: "#16161e",
    statusBarFg: "#a9b1d6",
    prefixFg: "#1a1b26",
    prefixBg: "#e0af68",
    working: "#e0af68",
    blocked: "#f7768e",
    done: "#9ece6a",
    idle: "#565f89",
    sidebarBg: "#16161e",
    sidebarSelBg: "#3b4261",
    sidebarCurBg: "#292e42",
  },
  gruvbox: {
    bg: "#282828",
    stripBg: "#1d2021",
    stripBgFocused: "#3c3836",
    tabFg: "#a89984",
    tabFgActive: "#ebdbb2",
    tabBgActive: "#504945",
    accent: "#83a598",
    statusBarBg: "#1d2021",
    statusBarFg: "#a89984",
    prefixFg: "#282828",
    prefixBg: "#fabd2f",
    working: "#fabd2f",
    blocked: "#fb4934",
    done: "#b8bb26",
    idle: "#928374",
    sidebarBg: "#1d2021",
    sidebarSelBg: "#504945",
    sidebarCurBg: "#3c3836",
  },
  nord: {
    bg: "#2e3440",
    stripBg: "#292e39",
    stripBgFocused: "#3b4252",
    tabFg: "#9aa5b8",
    tabFgActive: "#eceff4",
    tabBgActive: "#434c5e",
    accent: "#88c0d0",
    statusBarBg: "#292e39",
    statusBarFg: "#9aa5b8",
    prefixFg: "#2e3440",
    prefixBg: "#ebcb8b",
    working: "#ebcb8b",
    blocked: "#bf616a",
    done: "#a3be8c",
    idle: "#616e88",
    sidebarBg: "#292e39",
    sidebarSelBg: "#434c5e",
    sidebarCurBg: "#3b4252",
  },
  dracula: {
    bg: "#282a36",
    stripBg: "#21222c",
    stripBgFocused: "#343746",
    tabFg: "#9ba3c7",
    tabFgActive: "#f8f8f2",
    tabBgActive: "#44475a",
    accent: "#bd93f9",
    statusBarBg: "#21222c",
    statusBarFg: "#9ba3c7",
    prefixFg: "#282a36",
    prefixBg: "#f1fa8c",
    working: "#f1fa8c",
    blocked: "#ff5555",
    done: "#50fa7b",
    idle: "#6272a4",
    sidebarBg: "#21222c",
    sidebarSelBg: "#44475a",
    sidebarCurBg: "#343746",
  },
};
