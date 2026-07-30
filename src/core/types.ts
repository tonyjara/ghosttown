export type AgentStatus = "idle" | "working" | "blocked" | "done";

export type SplitDir = "row" | "column"; // row = side-by-side, column = stacked

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutNode = LayoutLeaf | LayoutSplit;

export interface LayoutLeaf {
  type: "leaf";
  paneId: string;
}

export interface LayoutSplit {
  type: "split";
  dir: SplitDir;
  ratio: number; // fraction of space given to `a`
  a: LayoutNode;
  b: LayoutNode;
}

/** Reactive surface metadata (lives in the Solid store). */
export interface SurfaceMeta {
  id: string;
  /** Title from OSC 0/2, falling back to the command name. */
  title: string;
  /**
   * A name the user typed (rename-tab). Wins over `title` everywhere a tab is
   * labelled, and unlike it is never overwritten by the program's OSC titles.
   */
  titleOverride?: string;
  command: string;
  status: AgentStatus;
  unread: boolean;
  /** True once the surface has ever received an explicit `gt report`. */
  hasReporter: boolean;
  /** True once the surface has ever been non-idle — it stays in the agents
   * list forever after, shown as idle between runs. */
  everActive: boolean;
  /**
   * The agent program the daemon's process poll can see running in this
   * surface right now ("claude", "codex", …), or undefined for none. This is
   * what makes an *idle* agent visible: it never printed anything, so no
   * amount of output watching would have found it. See core/procs.ts.
   */
  agent?: string;
  /** True once an agent has ever been seen here (survives it being quit). */
  everAgent: boolean;
  exited: boolean;
  /** Last status change away from idle (drives agent list ordering). */
  lastActiveAt?: number;
}

export interface PaneState {
  id: string;
  surfaceIds: string[];
  activeIdx: number;
}

/** A workspace: one split-tree of panes. The profile is a list of these. */
export interface WorkspaceState {
  id: string;
  name: string;
  layout: LayoutNode | null;
  focusedPaneId: string;
}

export interface PaneSnapshot {
  id: string;
  rect: Rect;
  focused: boolean;
  surfaces: Array<
    Pick<SurfaceMeta, "id" | "title" | "command" | "status" | "unread" | "agent"> & {
      active: boolean;
    }
  >;
}

/**
 * One agent in the profile, wherever it lives. Flat and workspace-tagged on
 * purpose: agents are the thing you look for across a whole session, not
 * inside one layout.
 */
export interface AgentSnapshot {
  surfaceId: string;
  title: string;
  status: AgentStatus;
  /** Detected agent program, or null for one only known from its activity. */
  agent: string | null;
  /** An agent program is running in it right now. */
  live: boolean;
  unread: boolean;
  workspaceId: string;
  workspace: string;
  paneId: string;
  lastActiveAt: number | null;
}

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  active: boolean;
  panes: PaneSnapshot[];
}

export interface SessionSnapshot {
  session: string;
  workspaces: WorkspaceSnapshot[];
  /** Every agent in the profile, across all workspaces. */
  agents: AgentSnapshot[];
}
