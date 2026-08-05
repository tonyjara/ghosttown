/**
 * Which events are allowed to reach the desktop. The status heuristic runs in
 * every kind of tab — a dev server compiling looks exactly like an agent
 * thinking — so what keeps Notification Center honest is the filter in front of
 * it, and that is what these tests pin down.
 *
 * desktopNotify is replaced before state.ts is imported: the real one spawns a
 * notifier, and a test suite has no business putting cards on your screen.
 */
import { beforeEach, describe, expect, it, mock } from "bun:test";
import { loadConfig, setConfigForTest } from "./config";
import type { NotifyRequest } from "./notify";

const sent: NotifyRequest[] = [];
const realNotify = await import("./notify");
mock.module("./notify", () => ({
  ...realNotify,
  desktopNotify: (req: NotifyRequest) => {
    sent.push(req);
  },
}));

const { activeSurfaceId, createWorkspace, hostEvents, setStore } = await import("./state");
const host = hostEvents();

/**
 * A surface in its own workspace, left off screen — the tab you are looking at
 * never notifies, so every case here has to happen somewhere else.
 */
function offscreen(
  name: string,
  patch: Partial<{ agent: string; everActive: boolean; hasReporter: boolean }> = {},
): string {
  createWorkspace({ name });
  const id = activeSurfaceId();
  const { agent, ...rest } = patch;
  if (Object.keys(rest).length > 0) setStore("surfaces", id, (m) => ({ ...m, ...rest }));
  if (agent) host.onAgent(id, agent);
  createWorkspace({ name: `${name} (looking away)` });
  return id;
}

const notifiedFor = (id: string) => sent.filter((req) => req.key === id);

beforeEach(() => {
  sent.length = 0;
});

describe("status notifications", () => {
  it("notifies when an agent finishes a turn", () => {
    const id = offscreen("agent finishing", { agent: "claude" });
    host.onStatus(id, "done", false);
    expect(notifiedFor(id)).toHaveLength(1);
  });

  it("notifies when an agent blocks on a prompt", () => {
    const id = offscreen("agent blocking", { agent: "claude" });
    host.onStatus(id, "blocked", false);
    expect(notifiedFor(id)).toHaveLength(1);
  });

  it("stays quiet for a dev server between requests", () => {
    // The bug this filter exists for: `pnpm dev` prints for a few seconds
    // serving a request, goes quiet, and the heuristic calls that done. Nothing
    // there is waiting on the user.
    const id = offscreen("pnpm dev");
    host.onStatus(id, "done", false);
    expect(notifiedFor(id)).toEqual([]);
  });

  it("stays quiet for a shell that has merely been busy", () => {
    const id = offscreen("long build", { everActive: true });
    host.onStatus(id, "done", false);
    expect(notifiedFor(id)).toEqual([]);
  });

  it("notifies a busy shell again when include_busy widens what an agent is", () => {
    // The knob for an agent running under a command name the list does not
    // know: it is in the agent list, so it is in the notifications too.
    const id = offscreen("unrecognized agent", { everActive: true });
    const config = loadConfig();
    setConfigForTest({ ...config, agents: { ...config.agents, include_busy: true } });
    try {
      host.onStatus(id, "done", false);
      expect(notifiedFor(id)).toHaveLength(1);
    } finally {
      setConfigForTest(null);
    }
  });

  it("notifies a hooked-up surface with no process to find", () => {
    // `gt report` is an explicit claim to agent treatment — an agent over ssh or
    // in a container, which the process poll cannot see.
    const id = offscreen("reporter", { hasReporter: true });
    host.onStatus(id, "done", true);
    expect(notifiedFor(id)).toHaveLength(1);
  });

  it("follows the agent list: a quit agent's shell goes quiet again", () => {
    const id = offscreen("quit in here", { agent: "claude" });
    host.onAgent(id, null);
    host.onStatus(id, "done", false);
    expect(notifiedFor(id)).toEqual([]);
  });

  it("passes on a notification the program asked for, whatever runs there", () => {
    // OSC 9 / OSC 777 is not derived from anything — the program said "tell
    // them", so it is told, and the status change behind it must not repeat it.
    const id = offscreen("noisy script");
    host.onNotify(id, "deploy finished", "3 services up");
    expect(notifiedFor(id)).toHaveLength(1);
    expect(notifiedFor(id)[0]?.title).toBe("deploy finished");
  });
});
