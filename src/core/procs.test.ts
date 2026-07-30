/**
 * Agent detection by process tree. The command lines here are shaped like the
 * real ones — including Claude Code's kilobyte `--settings` blob, which mentions
 * "claude" many times and must not be mistaken for the program name.
 */
import { describe, expect, it } from "bun:test";
import {
  childIndex,
  DEFAULT_AGENT_COMMANDS,
  findAgentUnder,
  findAgents,
  matchAgentCommand,
  parseProcTable,
  type ProcTable,
} from "./procs";

const names = DEFAULT_AGENT_COMMANDS;
const match = (args: string) => matchAgentCommand(args, names);

/** The tail of a real `claude --settings {...}` line, abbreviated. */
const SETTINGS_BLOB =
  '--settings {"hooks":{"Stop":[{"hooks":[{"command":"cmux hooks claude stop"}]}]}} --dangerously-skip-permissions';

describe("matchAgentCommand", () => {
  it("matches a bare command, an absolute path, and flags after it", () => {
    expect(match("claude")).toBe("claude");
    expect(match("claude --dangerously-skip-permissions")).toBe("claude");
    expect(match("/Users/x/.local/bin/claude --session-id abc")).toBe("claude");
    expect(match("codex exec")).toBe("codex");
    expect(match("/opt/homebrew/bin/aider --model sonnet")).toBe("aider");
  });

  it("matches a hyphenated variant of a configured name", () => {
    expect(match("/usr/local/bin/claude-code")).toBe("claude");
    expect(match("cursor-agent")).toBe("cursor-agent");
  });

  it("looks past an interpreter at the script it was given", () => {
    expect(match("node /Users/x/.npm/lib/@anthropic-ai/claude-code/cli.js --print")).toBe("claude");
    expect(match("bun /Users/x/src/codex/bin/codex.ts")).toBe("codex");
    expect(match("python3 /opt/aider/aider.py")).toBe("aider");
    expect(match("sh -c 'claude --resume'")).toBe("claude");
    expect(match("env NODE_ENV=production claude")).toBe("claude");
  });

  it("ignores names that appear in arguments rather than as the program", () => {
    // The single most important false positive to avoid: every hook command in
    // Claude Code's own --settings payload contains the word "claude".
    expect(match(`/Users/x/.local/bin/npm run build ${SETTINGS_BLOB}`)).toBeNull();
    expect(match("vim /Users/x/projects/claude/notes.md")).toBeNull();
    expect(match("git commit -m claude")).toBeNull();
    expect(match("tail -f /var/log/codex.log")).toBeNull();
    expect(match("/bin/zsh")).toBeNull();
    expect(match("")).toBeNull();
  });

  it("respects the configured name list", () => {
    expect(matchAgentCommand("claude", ["codex"])).toBeNull();
    expect(matchAgentCommand("my-bot --serve", ["my-bot"])).toBe("my-bot");
  });
});

describe("parseProcTable", () => {
  const stdout = [
    "  17731 17724 Ss   /opt/homebrew/bin/bun src/index.ts __daemon --session main",
    "  17761 17731 Ss   /bin/zsh",
    "  18147 17761 S+   claude --dangerously-skip-permissions",
    "bogus line without pids",
    "",
  ].join("\n");

  it("reads pid, ppid, foreground flag and args", () => {
    const table = parseProcTable(stdout);
    expect(table.size).toBe(3);
    expect(table.get(18147)).toEqual({
      pid: 18147,
      ppid: 17761,
      foreground: true,
      args: "claude --dangerously-skip-permissions",
    });
    // A shell with an agent in the foreground is itself backgrounded ("Ss").
    expect(table.get(17761)!.foreground).toBe(false);
  });

  it("caps how much of a command line it keeps", () => {
    const long = `  42 1 S+   claude ${"x".repeat(4000)}`;
    expect(parseProcTable(long).get(42)!.args.length).toBe(300);
  });
});

/** pid, ppid, args, foreground — in the order ps would print them. */
function table(rows: Array<[number, number, string, boolean?]>): ProcTable {
  return parseProcTable(
    rows.map(([pid, ppid, args, fg]) => `${pid} ${ppid} S${fg === false ? "" : "+"}   ${args}`).join("\n"),
  );
}

describe("findAgentUnder", () => {
  it("finds an agent started inside the surface's shell", () => {
    const t = table([
      [100, 1, "/bin/zsh", false],
      [200, 100, "claude --dangerously-skip-permissions"],
    ]);
    const found = findAgentUnder(100, t, childIndex(t), names);
    expect(found).toEqual({ kind: "claude", pid: 200, depth: 1, foreground: true });
  });

  it("finds an agent the host spawned as the surface itself", () => {
    const t = table([[100, 1, "claude"]]);
    expect(findAgentUnder(100, t, childIndex(t), names)?.depth).toBe(0);
  });

  it("returns the agent, not the hook subprocess it spawned", () => {
    const t = table([
      [100, 1, "/bin/zsh", false],
      [200, 100, `claude ${SETTINGS_BLOB}`],
      // A Stop hook, running while claude waits: also "claude", one hop deeper.
      [300, 200, "/bin/sh -c 'cmux hooks claude stop'"],
    ]);
    expect(findAgentUnder(100, t, childIndex(t), names)?.pid).toBe(200);
  });

  it("prefers the foreground match when two sit at the same depth", () => {
    const t = table([
      [100, 1, "/bin/zsh", false],
      [200, 100, "claude --resume", false],
      [201, 100, "claude", true],
    ]);
    expect(findAgentUnder(100, t, childIndex(t), names)?.pid).toBe(201);
  });

  it("finds nothing in a plain shell, or for a pid that is gone", () => {
    const t = table([
      [100, 1, "/bin/zsh"],
      [200, 100, "npm run dev"],
      [300, 200, "node /Users/x/app/server.js"],
    ]);
    expect(findAgentUnder(100, t, childIndex(t), names)).toBeNull();
    expect(findAgentUnder(999, t, childIndex(t), names)).toBeNull();
  });

  it("stops descending at a depth limit rather than walking a deep tree", () => {
    // A chain of 12 shells with an agent at the very bottom.
    const rows: Array<[number, number, string]> = [[100, 1, "/bin/zsh"]];
    for (let i = 1; i <= 12; i++) rows.push([100 + i, 99 + i, "/bin/zsh"]);
    rows.push([200, 112, "claude"]);
    const t = table(rows);
    expect(findAgentUnder(100, t, childIndex(t), names)).toBeNull();
  });
});

describe("findAgents", () => {
  it("resolves every surface from one table, skipping the ones with no agent", () => {
    const t = table([
      [10, 1, "/bin/zsh", false],
      [11, 10, "claude"],
      [20, 1, "/bin/zsh"],
      [30, 1, "/bin/zsh", false],
      [31, 30, "codex exec --full-auto"],
    ]);
    const found = findAgents(
      [
        ["s1", 10],
        ["s2", 20],
        ["s3", 30],
        ["s4", 404],
      ],
      t,
      names,
    );
    expect([...found.keys()]).toEqual(["s1", "s3"]);
    expect(found.get("s1")!.kind).toBe("claude");
    expect(found.get("s3")!.kind).toBe("codex");
  });

  it("returns nothing when the process table could not be read", () => {
    expect(findAgents([["s1", 10]], new Map(), names).size).toBe(0);
  });
});
