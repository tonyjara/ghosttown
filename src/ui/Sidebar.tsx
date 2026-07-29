import { For, Show, createMemo } from "solid-js";
import {
  agentSurfaces,
  focusSidebar,
  sidebarClickAgent,
  sidebarClickProfile,
  sidebarClickWorkspace,
  sidebarWidth,
  store,
} from "../core/state";
import type { SurfaceMeta } from "../core/types";
import { agentGlyph, theme } from "./theme";

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(1, n - 1)) + "…" : s;
}

/** Keep the selected row inside a window of `visible` rows. */
function windowStart(sel: number, count: number, visible: number): number {
  if (count <= visible || visible <= 0) return 0;
  return Math.max(0, Math.min(sel - visible + 1, count - visible));
}

/**
 * Left sidebar: profile name on top, then two halves — workspaces and the
 * profile's agents (most recently done first). Focused via focus-left from
 * the leftmost pane; keys are handled in App and act on core/state.
 */
export function Sidebar() {
  const width = () => sidebarWidth();
  const height = () => Math.max(4, store.screen.height - 1);
  // Row 0 is the profile; the rest splits into the two halves.
  const topH = () => Math.max(2, Math.floor((height() - 1) / 2));
  const bottomH = () => Math.max(2, height() - 1 - topH());

  const agents = createMemo(() => agentSurfaces());

  const wsSelected = (i: number) =>
    store.sidebar.focused && store.sidebar.section === "workspaces" && i === store.sidebar.workspaceIdx;
  const agentSelected = (i: number) =>
    store.sidebar.focused && store.sidebar.section === "agents" && i === store.sidebar.agentIdx;

  const wsVisibleRows = () => topH() - 1;
  const wsWindow = createMemo(() => {
    const start = windowStart(store.sidebar.workspaceIdx, store.workspaceOrder.length, wsVisibleRows());
    return store.workspaceOrder
      .slice(start, start + wsVisibleRows())
      .map((id, i) => ({ id, idx: start + i }));
  });

  const agentVisibleRows = () => bottomH() - 1;
  const agentWindow = createMemo(() => {
    const start = windowStart(store.sidebar.agentIdx, agents().length, agentVisibleRows());
    return agents()
      .slice(start, start + agentVisibleRows())
      .map((m, i) => ({ m, idx: start + i }));
  });

  const wsRow = (idx: number, name: string, active: boolean) => {
    const marker = active ? "●" : " ";
    return truncate(` ${marker} ${idx + 1} ${name}`, width()).padEnd(width());
  };

  const agentRow = (m: SurfaceMeta) => {
    const glyph = agentGlyph(m.status).glyph;
    const word = m.status === "working" ? "running" : m.status;
    const titleRoom = Math.max(3, width() - word.length - 5);
    const left = ` ${glyph} ${truncate(m.title, titleRoom)}`;
    return left.padEnd(Math.max(left.length, width() - word.length - 1)) + word;
  };

  return (
    <box
      position="absolute"
      left={0}
      top={0}
      width={width()}
      height={height()}
      flexDirection="column"
      backgroundColor={theme.sidebarBg}
      onMouseDown={() => focusSidebar()}
    >
      <text
        content={truncate(` ⌂ ${store.session}`, width()).padEnd(width())}
        fg={theme.accent}
        bg={store.sidebar.focused ? theme.stripBgFocused : theme.sidebarBg}
        onMouseDown={() => sidebarClickProfile()}
      />
      <box height={topH()} flexDirection="column" backgroundColor={theme.sidebarBg} flexShrink={0}>
        <text content={` WORKSPACES (${store.workspaceOrder.length})`} fg={theme.idle} bg={theme.sidebarBg} />
        <For each={wsWindow()}>
          {(entry) => {
            const ws = () => store.workspaces[entry.id];
            const active = () => entry.id === store.activeWorkspaceId;
            return (
              <Show when={ws()}>
                <text
                  content={wsRow(entry.idx, ws()!.name, active())}
                  fg={wsSelected(entry.idx) ? theme.tabFgActive : active() ? theme.accent : theme.tabFg}
                  bg={wsSelected(entry.idx) ? theme.sidebarSelBg : theme.sidebarBg}
                  onMouseDown={() => sidebarClickWorkspace(entry.id)}
                />
              </Show>
            );
          }}
        </For>
      </box>
      <box height={bottomH()} flexDirection="column" backgroundColor={theme.sidebarBg} flexShrink={0}>
        <text content={` AGENTS (${agents().length})`} fg={theme.idle} bg={theme.sidebarBg} />
        <Show
          when={agents().length > 0}
          fallback={<text content="  (none)" fg={theme.idle} bg={theme.sidebarBg} />}
        >
          <For each={agentWindow()}>
            {(entry) => (
              <text
                content={agentRow(entry.m)}
                fg={agentSelected(entry.idx) ? theme.tabFgActive : agentGlyph(entry.m.status).color}
                bg={agentSelected(entry.idx) ? theme.sidebarSelBg : theme.sidebarBg}
                onMouseDown={() => sidebarClickAgent(entry.m.id)}
              />
            )}
          </For>
        </Show>
      </box>
    </box>
  );
}
