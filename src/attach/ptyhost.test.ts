import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPtyHost, ReplayBuffer, type Sender } from "./ptyhost";
import type { HostClientFrame, HostServerFrame } from "../control/protocol";
import { reloadConfig } from "../core/config";
import { readSnapshot, SNAPSHOT_VERSION, type PersistedSession } from "../core/persist";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const decode = (d: string) => Buffer.from(d, "base64").toString("utf8");
const encode = (s: string) => Buffer.from(s).toString("base64");

describe("ReplayBuffer", () => {
  it("returns the whole history untouched while it fits", () => {
    const buf = new ReplayBuffer(1024);
    buf.push("\x1b[?1049hhello ");
    buf.push("world");
    expect(buf.replay()).toBe("\x1b[?1049hhello world");
  });

  it("drops the oldest chunks past the cap", () => {
    const buf = new ReplayBuffer(16);
    buf.push("a".repeat(10));
    buf.push("b".repeat(10));
    buf.push("c".repeat(10));
    const out = buf.replay();
    expect(out).not.toContain("a");
    expect(out).toContain("c".repeat(10));
  });

  it("replays the private modes it has trimmed away, and opens on an escape", () => {
    const buf = new ReplayBuffer(32);
    // Entering the alt screen and asking for the mouse happens once, at the
    // start — exactly the bytes a cap is going to throw out first.
    buf.push("\x1b[?1049h\x1b[?1000h\x1b[?1006h");
    buf.push("x".repeat(40));
    buf.push("\x1b[32mgreen");
    const out = buf.replay();
    expect(out).toContain("\x1b[?1049h");
    expect(out).toContain("\x1b[?1000h");
    expect(out).toContain("\x1b[?1006h");
    // The window must not start mid-sequence: its first bytes would be eaten
    // as that sequence's parameters.
    expect(out.slice(out.indexOf("\x1b[m") + 3).startsWith("\x1b")).toBe(true);
    expect(out).toEndWith("\x1b[32mgreen");
  });

  it("keeps the last state of a mode that was turned back off", () => {
    const buf = new ReplayBuffer(8);
    buf.push("\x1b[?1049h\x1b[?1049l");
    buf.push("y".repeat(20));
    expect(buf.replay()).toContain("\x1b[?1049l");
    expect(buf.replay()).not.toContain("\x1b[?1049h");
  });
});

describe("pty host", () => {
  let received: HostServerFrame[] = [];
  let send: Sender;
  let host: ReturnType<typeof createPtyHost>;
  let stateDir: string;

  const feed = (frame: HostClientFrame) => host.handle(frame, send);
  const framesOf = <T extends HostServerFrame["t"]>(t: T) =>
    received.filter((f): f is Extract<HostServerFrame, { t: T }> => f.t === t);
  const outputOf = (id: string) =>
    framesOf("o")
      .filter((f) => f.id === id)
      .map((f) => decode(f.d))
      .join("");

  /** Wait until `check` holds, or give up (the pty is a real process). */
  const until = async (check: () => boolean, ms = 4000): Promise<boolean> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await sleep(25);
    }
    return false;
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "gt-host-"));
    process.env.GHOSTTOWN_STATE_DIR = stateDir;
    // The agent poll runs on a timer; asking for the floor keeps the tests that
    // wait for it honest without making them slow.
    const configPath = join(stateDir, "config.toml");
    writeFileSync(configPath, "[agents]\npoll_ms = 500\n");
    process.env.GHOSTTOWN_CONFIG = configPath;
    reloadConfig();
    received = [];
    send = (frame) => received.push(frame);
    host = createPtyHost({ session: "test" });
  });

  afterEach(() => {
    host.closeAll();
    delete process.env.GHOSTTOWN_STATE_DIR;
    delete process.env.GHOSTTOWN_CONFIG;
    reloadConfig();
  });

  const spawnSh = (id: string): void => {
    feed({
      t: "spawn",
      id,
      command: "/bin/sh",
      args: [],
      cwd: stateDir,
      env: { TERM: "xterm-256color", PS1: "$ " },
      cols: 40,
      rows: 10,
    });
  };

  it("boots empty, then reports what it is running", async () => {
    feed({ t: "hello", persist: false });
    expect(framesOf("boot")[0]).toEqual({ t: "boot", surfaces: [], layout: null });

    spawnSh("s1");
    received = [];
    feed({ t: "hello", persist: false });
    const boot = framesOf("boot")[0]!;
    expect(boot.surfaces.map((s) => s.id)).toEqual(["s1"]);
    expect(boot.surfaces[0]!.command).toBe("/bin/sh");
    expect(boot.surfaces[0]!.exited).toBe(false);
  });

  it("keeps a tab's name across a TUI restart, alongside the program's title", () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    feed({ t: "rename", id: "s1", title: "  build watcher  " });

    received = [];
    feed({ t: "hello", persist: false });
    const named = framesOf("boot")[0]!.surfaces[0]!;
    expect(named.titleOverride).toBe("build watcher");
    expect(named.title).toBe("sh"); // the program's own title is untouched

    // An empty rename hands the label back to the program.
    feed({ t: "rename", id: "s1", title: null });
    received = [];
    feed({ t: "hello", persist: false });
    expect(framesOf("boot")[0]!.surfaces[0]!.titleOverride).toBeNull();
  });

  it("runs a program and streams its output", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    feed({ t: "w", id: "s1", d: encode("echo host_works\n") });
    expect(await until(() => outputOf("s1").includes("host_works"))).toBe(true);
  });

  it("replays a surface's screen to a client that attaches later", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    feed({ t: "w", id: "s1", d: encode("echo before_reload\n") });
    expect(await until(() => outputOf("s1").includes("before_reload"))).toBe(true);

    // A restarting TUI: new client, same host, surfaces untouched.
    received = [];
    const second: Sender = (frame) => received.push(frame);
    host.detach(send);
    host.handle({ t: "hello", persist: false }, second);
    host.handle({ t: "sub", id: "s1" }, second);

    const snap = framesOf("snap")[0];
    expect(snap).toBeDefined();
    expect(decode(snap!.d)).toContain("before_reload");
    // And it is still the same shell: it answers on the new client.
    host.handle({ t: "w", id: "s1", d: encode("echo after_reload\n") }, second);
    expect(await until(() => outputOf("s1").includes("after_reload"))).toBe(true);
  });

  it("asks the client where the cursor is, since only it has an emulator", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    // `\033[6n` makes the program ask where the cursor is.
    feed({ t: "w", id: "s1", d: encode("printf '\\033[6n'; cat -v\n") });
    expect(await until(() => framesOf("cpr-req").length > 0)).toBe(true);
    const req = framesOf("cpr-req")[0]!;
    // The chunk carrying the query must already have gone out, or the client
    // would measure a cursor that has not seen it yet.
    const askedAt = received.indexOf(req);
    const streamed = received
      .slice(0, askedAt)
      .filter((f): f is Extract<HostServerFrame, { t: "o" }> => f.t === "o")
      .map((f) => decode(f.d))
      .join("");
    expect(streamed).toContain("\x1b[6n");
    feed({ t: "cpr", id: req.id, seq: req.seq, x: 4, y: 2 });
    // The answer goes to the program, which echoes it back through cat -v.
    expect(await until(() => outputOf("s1").includes("[3;5R"))).toBe(true);
  });

  it("still answers a cursor query with no client attached", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    await sleep(200);
    host.detach(send); // the TUI is restarting: nobody to ask
    feed({ t: "w", id: "s1", d: encode("printf '\\033[6n'; cat -v\n") });
    await sleep(400);

    // Nothing was streamed anywhere, but the replay has it: the program was
    // answered from the last cursor the host knew about (top-left by default).
    received = [];
    const second: Sender = (frame) => received.push(frame);
    host.handle({ t: "sub", id: "s1" }, second);
    expect(decode(framesOf("snap")[0]!.d)).toContain("[1;1R");
  });

  it("reports an explicit status even when it did not change", () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    received = [];
    feed({ t: "report", id: "s1", status: "idle" });
    expect(framesOf("status")[0]).toEqual({
      t: "status",
      id: "s1",
      status: "idle",
      hasReporter: true,
    });
    feed({ t: "report", id: "s1", status: "blocked" });
    expect(framesOf("status").at(-1)!.status).toBe("blocked");
  });

  it("tells the client when a program exits, and keeps the record until asked", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    feed({ t: "w", id: "s1", d: encode("exit\n") });
    expect(await until(() => framesOf("exit").length > 0)).toBe(true);
    expect(host.surfaceCount()).toBe(1);
    feed({ t: "kill", id: "s1" });
    expect(host.surfaceCount()).toBe(0);
  });

  /** Two polls at the configured 500 ms floor, plus slack for `ps` itself. */
  const AGENT_POLL_GRACE_MS = 1500;

  /**
   * A stand-in agent: a symlink named after a real agent pointing at `sleep`,
   * so a real `ps` really does show `…/claude 30` running under the surface's
   * shell. Nothing is mocked — this exercises the poll end to end.
   */
  const fakeAgentPath = (name: string): string => {
    const path = join(stateDir, name);
    symlinkSync("/bin/sleep", path);
    return path;
  };

  it("finds an agent running in a surface, whether or not it prints anything", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    // No output at all after the command: an idle agent is exactly this, and it
    // is what the output heuristic can never see.
    feed({ t: "w", id: "s1", d: encode(`exec ${fakeAgentPath("claude")} 30\n`) });

    expect(await until(() => framesOf("agent").length > 0)).toBe(true);
    const found = framesOf("agent")[0]!;
    expect(found.id).toBe("s1");
    expect(found.agent).toBe("claude");
    expect(found.pid).toBeGreaterThan(0);

    // Still idle — detection and status are separate questions.
    received = [];
    feed({ t: "hello", persist: false });
    const surface = framesOf("boot")[0]!.surfaces[0]!;
    expect(surface.agent).toBe("claude");
    expect(surface.everAgent).toBe(true);
    expect(surface.status).toBe("idle");
  });

  it("says so when the agent goes away, and remembers there was one", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    // Keep the pid in a shell variable rather than using job control, which a
    // non-interactive `sh` does not have.
    feed({ t: "w", id: "s1", d: encode(`${fakeAgentPath("codex")} 30 & AGENT=$!\n`) });
    expect(await until(() => framesOf("agent").some((f) => f.agent === "codex"))).toBe(true);

    feed({ t: "w", id: "s1", d: encode('kill "$AGENT"\n') });
    expect(await until(() => framesOf("agent").some((f) => f.agent === null))).toBe(true);

    received = [];
    feed({ t: "hello", persist: false });
    const surface = framesOf("boot")[0]!.surfaces[0]!;
    expect(surface.agent).toBeNull();
    // The history survives a TUI restart; whether a quit agent is still listed
    // is core/state's call ([agents] keep_exited), not the host's.
    expect(surface.everAgent).toBe(true);
  });

  it("leaves a plain shell alone", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    feed({ t: "w", id: "s1", d: encode("sleep 30 &\n") });
    await sleep(AGENT_POLL_GRACE_MS);
    expect(framesOf("agent")).toEqual([]);
    received = [];
    feed({ t: "hello", persist: false });
    expect(framesOf("boot")[0]!.surfaces[0]!.everAgent).toBe(false);
  });

  it("starts a surface in the live directory of the one it inherits from", async () => {
    feed({ t: "hello", persist: false });
    mkdirSync(join(stateDir, "inherit-me"));
    spawnSh("s1");
    // The `cd` is the point: the sibling's directory has to be read now, not
    // taken from a snapshot written before it moved.
    feed({ t: "w", id: "s1", d: encode("cd inherit-me && echo moved\n") });
    expect(await until(() => outputOf("s1").includes("moved"))).toBe(true);

    feed({
      t: "spawn",
      id: "s2",
      command: "/bin/sh",
      args: [],
      cwd: stateDir,
      cwdFrom: "s1",
      env: { TERM: "xterm-256color", PS1: "$ " },
      cols: 40,
      rows: 10,
    });
    feed({ t: "w", id: "s2", d: encode("pwd\n") });
    expect(await until(() => outputOf("s2").includes("/inherit-me"))).toBe(true);
  });

  it("falls back to the frame's cwd when there is nothing to inherit from", async () => {
    feed({ t: "hello", persist: false });
    feed({
      t: "spawn",
      id: "s1",
      command: "/bin/sh",
      args: [],
      cwd: stateDir,
      cwdFrom: "gone",
      env: { TERM: "xterm-256color", PS1: "$ " },
      cols: 40,
      rows: 10,
    });
    feed({ t: "w", id: "s1", d: encode("pwd\n") });
    expect(await until(() => outputOf("s1").includes("gt-host-"))).toBe(true);
  });

  const layout = (surfaceId: string): PersistedSession => ({
    version: SNAPSHOT_VERSION,
    session: "test",
    savedAt: 1,
    activeWorkspaceId: "w1",
    sidebarVisible: true,
    workspaces: [
      {
        id: "w1",
        name: "workspace 1",
        layout: { type: "leaf", paneId: "p1" },
        focusedPaneId: "p1",
        panes: [{ id: "p1", activeIdx: 0, surfaces: [{ id: surfaceId, cwd: null }] }],
      },
    ],
  });

  it("hands a restarting client the layout, with the cwds filled in", async () => {
    feed({ t: "hello", persist: true });
    spawnSh("s1");
    feed({ t: "layout", data: layout("s1") });
    // The debounced write is also what stamps the directories.
    expect(await until(() => !!readSnapshot("test"))).toBe(true);

    received = [];
    feed({ t: "hello", persist: true });
    const booted = framesOf("boot")[0]!.layout;
    const surface = booted!.workspaces[0]!.panes[0]!.surfaces[0]!;
    expect(surface.id).toBe("s1");
    expect(surface.cwd).toContain("gt-host-");
  });

  it("keeps the snapshot off disk when persistence is off", async () => {
    feed({ t: "hello", persist: false });
    spawnSh("s1");
    feed({ t: "layout", data: layout("s1") });
    await sleep(1200);
    expect(readSnapshot("test")).toBeNull();
    // ...but a reload still gets the layout, which is the point.
    received = [];
    feed({ t: "hello", persist: false });
    expect(framesOf("boot")[0]!.layout).not.toBeNull();
  });

  it("drops the snapshot and every surface on an explicit quit", async () => {
    feed({ t: "hello", persist: true });
    spawnSh("s1");
    feed({ t: "layout", data: layout("s1") });
    expect(await until(() => !!readSnapshot("test"))).toBe(true);

    feed({ t: "quit" });
    expect(host.surfaceCount()).toBe(0);
    expect(readSnapshot("test")).toBeNull();
    received = [];
    feed({ t: "hello", persist: true });
    expect(framesOf("boot")[0]).toEqual({ t: "boot", surfaces: [], layout: null });
  });
});
