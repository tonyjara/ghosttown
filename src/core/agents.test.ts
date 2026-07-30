/**
 * The profile-wide agent list: who gets listed, in what order, tagged with
 * where they live. The store is module-global, so each test names its own
 * workspaces and filters the list down to the surfaces it created.
 */
import { describe, expect, it } from "bun:test";
import { loadConfig, setConfigForTest } from "./config";
import {
  activeSurfaceId,
  agentCounts,
  agentEntries,
  createWorkspace,
  focusedPaneId,
  hostEvents,
  newTab,
  setStore,
  store,
} from "./state";
import type { AgentStatus } from "./types";

/** Detection arrives the way the daemon delivers it: as a host event. */
const host = hostEvents();

/** A surface in a fresh workspace, in whatever agent state the test needs. */
function surface(
  workspace: string,
  patch: Partial<{ agent: string; status: AgentStatus; everActive: boolean; hasReporter: boolean }> = {},
): string {
  createWorkspace({ name: workspace });
  const id = activeSurfaceId();
  const { agent, ...rest } = patch;
  if (Object.keys(rest).length > 0) setStore("surfaces", id, (m) => ({ ...m, ...rest }));
  if (agent) host.onAgent(id, agent);
  return id;
}

const entriesFor = (...ids: string[]) => agentEntries().filter((e) => ids.includes(e.meta.id));
const idsIn = (...ids: string[]) => entriesFor(...ids).map((e) => e.meta.id);

describe("agentEntries", () => {
  it("lists an idle agent nobody has heard from — the whole point of detection", () => {
    // No output, no report, never non-idle: before process detection this
    // surface was invisible in the sidebar even though claude was sitting in it.
    const id = surface("idle agent home", { agent: "claude" });
    const [entry] = entriesFor(id);
    expect(entry?.meta.status).toBe("idle");
    expect(entry?.live).toBe(true);
    expect(entry?.workspace).toBe("idle agent home");
  });

  it("leaves a plain shell out of the list", () => {
    const id = surface("just a shell");
    expect(idsIn(id)).toEqual([]);
  });

  it("drops a tab from the list when its agent is quit", () => {
    // The row used to linger as a shell named after its directory, which is not
    // an agent by any reading. Detection saw the agent go; that is enough.
    const id = surface("quit in here", { agent: "claude" });
    expect(entriesFor(id)[0]?.live).toBe(true);
    host.onAgent(id, null); // the user typed /exit
    expect(idsIn(id)).toEqual([]);
    expect(store.surfaces[id]?.everAgent).toBe(true); // the tab itself is untouched
  });

  it("keeps a quit agent listed, idle, when keep_exited asks for it", () => {
    const id = surface("kept in here", { agent: "claude" });
    host.onAgent(id, null);
    const config = loadConfig();
    setConfigForTest({ ...config, agents: { ...config.agents, keep_exited: true } });
    try {
      const [entry] = entriesFor(id);
      expect(entry?.live).toBe(false);
      expect(entry?.meta.status).toBe("idle");
    } finally {
      setConfigForTest(null);
    }
  });

  it("lists a surface that reports through hooks, with no process to find", () => {
    const reported = surface("reporter", { hasReporter: true });
    expect(idsIn(reported)).toEqual([reported]);
  });

  it("drops a reporting tab too once the agent detected in it is gone", () => {
    // Claude Code wired up to `gt report` is both a reporter and a process. The
    // process poll is the one that knows it exited, so it wins.
    const id = surface("hooked up", { agent: "claude", hasReporter: true });
    expect(idsIn(id)).toEqual([id]);
    host.onAgent(id, null);
    expect(idsIn(id)).toEqual([]);
  });

  it("keeps the historical signals when process detection is off", () => {
    // Nothing polls, so `agent` is never set and "it is gone" is unknowable —
    // a tab that has ever held an agent has to stay listed.
    const id = surface("no poll here", { agent: "claude" });
    host.onAgent(id, null);
    const config = loadConfig();
    setConfigForTest({ ...config, agents: { ...config.agents, detect: false } });
    try {
      expect(idsIn(id)).toEqual([id]);
    } finally {
      setConfigForTest(null);
    }
  });

  it("leaves a merely busy tab out — an nvim is not an agent", () => {
    const busy = surface("busy shell", { everActive: true });
    expect(idsIn(busy)).toEqual([]);

    // …unless you ask for the old behavior, for an agent under a name the
    // command list does not know.
    const config = loadConfig();
    setConfigForTest({ ...config, agents: { ...config.agents, include_busy: true } });
    try {
      expect(idsIn(busy)).toEqual([busy]);
    } finally {
      setConfigForTest(null);
    }
  });

  it("tags every agent with the workspace holding it", () => {
    const here = surface("workspace one", { agent: "claude" });
    const there = surface("workspace two", { agent: "codex" });
    const byId = new Map(agentEntries().map((e) => [e.meta.id, e]));
    expect(byId.get(here)?.workspace).toBe("workspace one");
    expect(byId.get(there)?.workspace).toBe("workspace two");
    // Cross-workspace: both are listed while only one workspace is active.
    expect(store.activeWorkspaceId).not.toBe(byId.get(here)?.workspaceId);
  });

  it("finds agents in every pane of a workspace, not just the focused one", () => {
    createWorkspace({ name: "three tabs" });
    const first = activeSurfaceId();
    const second = newTab(focusedPaneId())!;
    for (const id of [first, second]) host.onAgent(id, "claude");
    expect(idsIn(first, second).sort()).toEqual([first, second].sort());
  });

  it("orders by what needs you: blocked, done, working, then idle", () => {
    const idle = surface("o-idle", { agent: "claude" });
    const working = surface("o-working", { agent: "claude", status: "working" });
    const blocked = surface("o-blocked", { agent: "claude", status: "blocked" });
    const done = surface("o-done", { agent: "claude", status: "done" });
    expect(idsIn(idle, working, blocked, done)).toEqual([blocked, done, working, idle]);
  });

  it("puts a live agent ahead of one that has been quit, however recent", () => {
    const stale = surface("s-stale", { agent: "claude" });
    host.onAgent(stale, null);
    const live = surface("s-live", { agent: "claude" });
    setStore("surfaces", stale, "lastActiveAt", Date.now() + 10_000); // more recent
    // A quit agent is only in the list at all under keep_exited; that is where
    // the live-first tiebreak matters.
    const config = loadConfig();
    setConfigForTest({ ...config, agents: { ...config.agents, keep_exited: true } });
    try {
      expect(idsIn(stale, live)).toEqual([live, stale]);
    } finally {
      setConfigForTest(null);
    }
  });
});

describe("agentCounts", () => {
  it("tallies the profile, not the active workspace", () => {
    const before = agentCounts();
    surface("c-one", { agent: "claude", status: "working" });
    surface("c-two", { agent: "codex", status: "blocked" });
    surface("c-three", { agent: "claude" });
    const after = agentCounts();
    expect(after.working - before.working).toBe(1);
    expect(after.blocked - before.blocked).toBe(1);
    expect(after.idle - before.idle).toBe(1);
    expect(after.total - before.total).toBe(3);
    expect(after.live - before.live).toBe(3);
  });
});
