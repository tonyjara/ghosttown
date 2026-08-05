import { For, Show, createMemo } from "solid-js";
import type { MouseEvent } from "@opentui/core";
import {
  activeSurfaceId,
  agentContext,
  agentCounts,
  agentEntries,
  agentLabel,
  focusSidebar,
  sidebarClickAgent,
  sidebarClickProfile,
  sidebarClickWorkspace,
  sidebarWidth,
  store,
  type AgentEntry,
} from "../core/state";
import { truncate, twoColumnRow, windowStart } from "./list";
import { workingPulse } from "./spinner";
import { agentGlyph, statusGlyph, theme } from "./theme";

/** Rows the agents half keeps even when there are many workspaces (header + 2). */
const MIN_AGENT_ROWS = 5;

/** An agent is two rows: who it is, then what it is working on. */
const AGENT_ROWS = 2;

/**
 * Left sidebar: profile name on top, then two halves — workspaces and every
 * agent in the profile, whichever workspace it lives in, in the order they sit
 * in (see agentSort: layout order, or wherever shift+J/K put them). Focused via
 * focus-left from the leftmost pane; keys are handled in App and act on
 * core/state.
 *
 * The agents half is the point of the sidebar, so it gets all the room the
 * workspace list does not need.
 */
export function Sidebar() {
  const width = () => sidebarWidth();
  const height = () => Math.max(4, store.screen.height - 1);
  // Row 0 is the profile. Workspaces take what they need (header + one row
  // each); everything left over goes to the agents.
  const topH = () => {
    const wanted = 1 + store.workspaceOrder.length;
    const cap = Math.max(2, height() - 1 - (MIN_AGENT_ROWS + 1));
    return Math.max(2, Math.min(wanted, cap));
  };
  const bottomH = () => Math.max(2, height() - 1 - topH());

  const agents = createMemo(() => agentEntries());
  const counts = createMemo(() => agentCounts());

  /**
   * The agent you are *in*: the tab the keys go to, which survives focus moving
   * into the sidebar — you are still "in" that agent while you browse the list.
   * A plain shell has an id like any other tab, it just matches no row here, so
   * nothing is marked while you are in one.
   */
  const here = () => activeSurfaceId();

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

  /**
   * In *agents*, not rows — each one costs AGENT_ROWS of the half's height. Room
   * for half a row is room for none: on a terminal too short for even one agent
   * the half keeps its header and stops, rather than drawing a line past its own
   * box and over a pane.
   */
  const agentVisible = () => Math.floor((bottomH() - 1) / AGENT_ROWS);
  const agentWindow = createMemo(() => {
    const start = windowStart(store.sidebar.agentIdx, agents().length, agentVisible());
    return agents()
      .slice(start, start + agentVisible())
      .map((e, i) => ({ e, idx: start + i }));
  });

  const wsRow = (idx: number, name: string, active: boolean) => {
    const marker = active ? "●" : " ";
    return truncate(` ${marker} ${idx + 1} ${name}`, width()).padEnd(width());
  };

  /**
   * `▌✳ claude          FrontendV2` — the status is in the glyph and its color,
   * which leaves the right-hand column for the workspace. That column is what
   * makes the list usable across a profile: without it, five agents called
   * "claude" are indistinguishable.
   *
   * The leading bar is the one you are in. It goes in the row's own margin
   * rather than the marker column, so it costs no width and — unlike the `●` a
   * workspace gets — never has to compete with the status glyph: "where am I"
   * and "how is it doing" stay two separate readings of the same row.
   *
   * Reactive by being read inside a prop: `workingPulse()` ticks, so the rows
   * of the agents that are thinking animate and every other row stays put.
   */
  const agentRow = (e: AgentEntry) => {
    // An agent sitting at its prompt (○) and one no process poll can see (·) —
    // a reporter-only tab, or a quit agent under [agents] keep_exited — are both
    // "idle", and the difference is worth one character.
    const glyph =
      e.meta.status === "working"
        ? workingPulse()
        : e.meta.status === "idle" && !e.live
          ? "·"
          : agentGlyph(e.meta.status).glyph;
    const unread = e.meta.unread ? "•" : " ";
    const ws = store.workspaceOrder.length > 1 ? truncate(e.workspace, 12) : "";
    const bar = e.meta.id === here() ? "▌" : " ";
    return twoColumnRow(`${bar}${glyph}${unread}${agentLabel(e.meta)}`, ws ? `${ws} ` : "", width());
  };

  /**
   * Second line: what it is working on, which is the tab's own title — the thing
   * the tab strip shows and the sidebar used to throw away in favor of the bare
   * agent name. `claude` alone tells you nothing about which of five claudes this
   * is; "Merge twonary_mercado changes" does.
   *
   * Indented to hang under the label, and left blank rather than dropped when
   * there is nothing to add (a renamed tab whose name IS the title): every agent
   * costs the same two rows, so the list has one rhythm and the window arithmetic
   * has one row height.
   */
  const agentContextRow = (e: AgentEntry) => {
    const ctx = agentContext(e.meta);
    if (!ctx || ctx === agentLabel(e.meta)) return "".padEnd(width());
    return truncate(`   ${ctx}`, width()).padEnd(width());
  };

  /**
   * Status color while there is a status to show; otherwise brightness carries
   * the difference between an agent waiting at its prompt and a tab whose agent
   * is no longer running.
   */
  const agentRowFg = (e: AgentEntry) => {
    if (e.meta.status !== "idle") return agentGlyph(e.meta.status).color;
    return e.live ? theme.tabFg : theme.idle;
  };

  /**
   * Highlight, in order: the cursor (only while the sidebar has the keys), then
   * the agent you are in. Two different questions, so the cursor wins the
   * background it lands on — the bar in the row still says which one is home.
   */
  const agentRowBg = (e: AgentEntry, idx: number) => {
    if (agentSelected(idx)) return theme.sidebarSelBg;
    return e.meta.id === here() ? theme.sidebarCurBg : theme.sidebarBg;
  };

  /** `AGENTS (5)  ⚑1 ✳2` — the tally covers the ones scrolled out of view. */
  const agentHeader = () => {
    const c = counts();
    const tally = (["blocked", "working", "done"] as const)
      .filter((s) => c[s] > 0)
      .map((s) => `${statusGlyph(s).glyph}${c[s]}`)
      .join(" ");
    return twoColumnRow(` AGENTS (${c.total})`, tally ? `${tally} ` : "", width());
  };

  /**
   * A row click acts on its own; without this it would bubble to the sidebar
   * box, whose job is only to catch clicks on blank space and take the keys.
   */
  const rowClick = (act: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    act();
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
        selectable={false}
        onMouseDown={rowClick(sidebarClickProfile)}
      />
      <box height={topH()} flexDirection="column" backgroundColor={theme.sidebarBg} flexShrink={0}>
        <text
          content={` WORKSPACES (${store.workspaceOrder.length})`}
          fg={theme.idle}
          bg={theme.sidebarBg}
          selectable={false}
        />
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
                  selectable={false}
                  onMouseDown={rowClick(() => sidebarClickWorkspace(entry.id))}
                />
              </Show>
            );
          }}
        </For>
      </box>
      <box height={bottomH()} flexDirection="column" backgroundColor={theme.sidebarBg} flexShrink={0}>
        <text content={agentHeader()} fg={theme.idle} bg={theme.sidebarBg} selectable={false} />
        <Show
          when={agents().length > 0}
          fallback={
            <text content="  (none)" fg={theme.idle} bg={theme.sidebarBg} selectable={false} />
          }
        >
          <For each={agentWindow()}>
            {(entry) => (
              // Both rows are one target: the click belongs to the agent, not to
              // whichever of its two lines the pointer happened to land on. The
              // texts carry no handler, so the press bubbles up to here.
              <box
                height={AGENT_ROWS}
                flexDirection="column"
                flexShrink={0}
                onMouseDown={rowClick(() => sidebarClickAgent(entry.e.meta.id))}
              >
                <text
                  content={agentRow(entry.e)}
                  fg={agentSelected(entry.idx) ? theme.tabFgActive : agentRowFg(entry.e)}
                  bg={agentRowBg(entry.e, entry.idx)}
                  selectable={false}
                />
                <text
                  content={agentContextRow(entry.e)}
                  fg={agentSelected(entry.idx) ? theme.tabFg : theme.idle}
                  bg={agentRowBg(entry.e, entry.idx)}
                  selectable={false}
                />
              </box>
            )}
          </For>
        </Show>
      </box>
    </box>
  );
}
