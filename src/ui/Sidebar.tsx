import { For, Show, createMemo, createSignal } from "solid-js";
import type { MouseEvent } from "@opentui/core";
import {
  activeSurfaceId,
  agentContext,
  agentCounts,
  agentLabel,
  focusSidebar,
  hiddenAgentCount,
  hideAgent,
  sidebarAgents,
  sidebarClickAgent,
  sidebarClickProfile,
  sidebarClickWorkspace,
  sidebarWidth,
  store,
  unhideAllAgents,
  type AgentEntry,
} from "../core/state";
import { truncate, twoColumnRow, windowStart } from "./list";
import { workingPulse } from "./spinner";
import { agentGlyph, statusGlyph, theme } from "./theme";

/** Rows the agents half keeps even when there are many workspaces (header + 2). */
const MIN_AGENT_ROWS = 5;

/** An agent is two rows: who it is, then what it is working on. */
const AGENT_ROWS = 2;

/** Takes the row off the list, not the agent off the machine. */
const HIDE = "[-]";

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

  // The rows: hidden agents are out of this list and out of every index that
  // counts in it — but still in `counts`, which is the whole profile.
  const agents = createMemo(() => sidebarAgents());
  const counts = createMemo(() => agentCounts());
  const hidden = createMemo(() => hiddenAgentCount());

  // Which button the pointer is on. Kept here rather than per row: the rows are
  // rebuilt whenever an agent changes status, and a highlight that dies under a
  // motionless pointer looks like the button stopped working.
  const [hotHide, setHotHide] = createSignal("");
  const [hotUnhide, setHotUnhide] = createSignal(false);

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
   *
   * The last three columns belong to the row's `[-]`, which is drawn beside this
   * text rather than in it — so the workspace column ends where the button
   * begins instead of underneath it.
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
    return twoColumnRow(
      `${bar}${glyph}${unread}${agentLabel(e.meta)}`,
      ws ? `${ws} ` : "",
      Math.max(1, width() - HIDE.length),
    );
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

  /**
   * `AGENTS (5)  ⚑1 ✳2` — the count and the tally are the whole profile, hidden
   * rows included: the point of hiding one is to stop reading it, not to stop
   * knowing about it. What it is doing still lands in this line.
   */
  const agentHeader = () => {
    const c = counts();
    const tally = (["blocked", "working", "done"] as const)
      .filter((s) => c[s] > 0)
      .map((s) => `${statusGlyph(s).glyph}${c[s]}`)
      .join(" ");
    const room = width() - (hidden() > 0 ? unhide().length : 0);
    return twoColumnRow(` AGENTS (${c.total})`, tally ? `${tally} ` : "", Math.max(1, room));
  };

  /** `[+2]` — how many rows are hidden, and the button that brings them back. */
  const unhide = () => `[+${hidden()}]`;

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
        <box height={1} flexDirection="row" flexShrink={0} backgroundColor={theme.sidebarBg}>
          <text content={agentHeader()} fg={theme.idle} bg={theme.sidebarBg} selectable={false} />
          {/* Only there when it has something to do — an empty `[+0]` in the
              header of a list nobody has hidden from is just noise. */}
          <Show when={hidden() > 0}>
            <text
              content={unhide()}
              fg={hotUnhide() ? theme.accent : theme.idle}
              bg={theme.sidebarBg}
              selectable={false}
              onMouseDown={rowClick(unhideAllAgents)}
              onMouseOver={() => setHotUnhide(true)}
              onMouseOut={() => setHotUnhide(false)}
            />
          </Show>
        </box>
        <Show
          when={agents().length > 0}
          fallback={
            <text
              content={hidden() > 0 ? "  (all hidden)" : "  (none)"}
              fg={theme.idle}
              bg={theme.sidebarBg}
              selectable={false}
            />
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
                <box height={1} flexDirection="row" flexShrink={0}>
                  <text
                    content={agentRow(entry.e)}
                    fg={agentSelected(entry.idx) ? theme.tabFgActive : agentRowFg(entry.e)}
                    bg={agentRowBg(entry.e, entry.idx)}
                    selectable={false}
                  />
                  {/* Always drawn, so no row shifts under the pointer; it lights
                      up on hover, which is what says it is a button. Dim, and in
                      the accent rather than the kill red `×` uses: hiding is the
                      reversible one. */}
                  <text
                    content={HIDE}
                    fg={hotHide() === entry.e.meta.id ? theme.accent : theme.idle}
                    bg={agentRowBg(entry.e, entry.idx)}
                    selectable={false}
                    onMouseDown={rowClick(() => hideAgent(entry.e.meta.id))}
                    onMouseOver={() => setHotHide(entry.e.meta.id)}
                    onMouseOut={() => setHotHide("")}
                  />
                </box>
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
