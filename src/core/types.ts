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
  command: string;
  status: AgentStatus;
  unread: boolean;
  /** True once the surface has ever received an explicit `gt report`. */
  hasReporter: boolean;
  exited: boolean;
}

export interface PaneState {
  id: string;
  surfaceIds: string[];
  activeIdx: number;
}

export interface SessionSnapshot {
  session: string;
  focusedPaneId: string;
  panes: Array<{
    id: string;
    rect: Rect;
    focused: boolean;
    surfaces: Array<
      Pick<SurfaceMeta, "id" | "title" | "command" | "status" | "unread"> & {
        active: boolean;
      }
    >;
  }>;
}
