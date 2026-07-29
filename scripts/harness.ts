/**
 * Headless end-to-end harness: runs the real TUI under a PTY, drives it with
 * keystrokes, and snapshots what a terminal would show (via ghostty-opentui's
 * PersistentTerminal). Usage: bun run scripts/harness.ts
 */
import { spawn } from "bun-pty";
import { PersistentTerminal } from "ghostty-opentui";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { OutputScanner } from "../src/core/queries";
import { attachSocketPathFor } from "../src/control/protocol";
import { snapshotPath } from "../src/core/persist";
import { join } from "node:path";

const COLS = 100;
const ROWS = 30;
const session = `harness-${process.pid}`;
/** Second profile created by the prefix+S (new-profile) e2e test. */
const sessionB = `harness-${process.pid}-b`;
const entry = join(import.meta.dir, "..", "src", "index.ts");

// A user config override, to prove custom settings win over defaults:
// new-tab remapped from "c" to "t", and a non-default theme.
const configDir = mkdtempSync(join(tmpdir(), "gt-harness-config-"));
const configPath = join(configDir, "config.toml");
writeFileSync(
  configPath,
  `[appearance]\ntheme = "catppuccin-mocha"\n\n[keybinds]\n"new-tab" = ["t"]\n`,
);

// Both this process (for the snapshot-path assertions) and the children.
process.env.GHOSTTOWN_STATE_DIR = join(configDir, "state");

const attachSocket = attachSocketPathFor(session);
const attachSocketB = attachSocketPathFor(sessionB);
const harnessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
  ),
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  GHOSTTOWN_NO_NOTIFY: "1",
  GHOSTTOWN_CONFIG: configPath,
  GHOSTTOWN_DAEMON_LOG: join(configDir, "daemon.log"),
  // Snapshots go in the sandbox, never the developer's ~/.local/state.
  GHOSTTOWN_STATE_DIR: join(configDir, "state"),
};

// This spawns the ATTACH CLIENT, which starts the background daemon, which
// runs the TUI in its own pty — the harness drives the whole real chain.
const term = new PersistentTerminal({ cols: COLS, rows: ROWS });
const pty = spawn(process.execPath, ["--conditions=browser", "run", entry, "--session", session], {
  name: "xterm-256color",
  cols: COLS,
  rows: ROWS,
  cwd: join(import.meta.dir, ".."),
  env: harnessEnv,
});

/** Ask a daemon to kill its session — safety net so failed runs don't leak. */
async function killDaemon(socketPath: string = attachSocket): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 600);
    Bun.connect({
      unix: socketPath,
      socket: {
        open(s) {
          s.write(JSON.stringify({ t: "cmd", cmd: "kill" }) + "\n");
          setTimeout(() => {
            try {
              s.end();
            } catch {}
            clearTimeout(timer);
            resolve();
          }, 150);
        },
        data() {},
        error() {
          clearTimeout(timer);
          resolve();
        },
        close() {},
      },
    }).catch(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Answer the app's own capability queries so startup never stalls.
const scanner = new OutputScanner({
  respond: (data) => pty.write(data),
  getCursor: () => [0, 0],
});

let exited = false;
pty.onData((chunk) => {
  scanner.scan(chunk);
  term.feed(chunk);
});
pty.onExit(({ exitCode }) => {
  exited = true;
  console.log(`\n[harness] app exited with code ${exitCode}`);
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frame(label: string, t: PersistentTerminal = term): string {
  const text = t.getText();
  const border = "─".repeat(COLS);
  return `\n┌${border}┐ ${label}\n${text
    .split("\n")
    .map((l) => `│${l.padEnd(COLS)}│`)
    .join("\n")}\n└${border}┘`;
}

const failures: string[] = [];
function expect(label: string, cond: boolean): void {
  console.log(`[harness] ${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures.push(label);
}

const PREFIX = "\x01"; // Ctrl+A

async function main(): Promise<void> {
  await sleep(4000); // two bun cold starts (client+daemon, tui) + shell prompt
  let text = term.getText();
  console.log(frame("initial"));
  expect("tab strip shows first tab", text.includes("1:"));
  expect("status bar shows session", text.includes(session.slice(0, 12)));
  expect("shell prompt appeared", /[$%#>]/.test(text));

  // The configured theme (catppuccin-mocha) must reach the actual cells.
  {
    const bgs = new Set<string>();
    for (const l of term.getJson().lines) {
      for (const s of l.spans) if (s.bg) bgs.add(s.bg.toLowerCase());
    }
    expect(
      "catppuccin theme colors reach the screen",
      bgs.has("#1e1e2e") || bgs.has("#181825"),
    );
  }

  // Type into the shell.
  pty.write("echo hello_ghosttown\r");
  await sleep(700);
  text = term.getText();
  expect("shell echoed command output", text.includes("hello_ghosttown"));

  // --- Live screen vs scrollback ---
  // A pane renders a window of its emulator buffer, not the whole thing: once
  // the inner program scrolls, the view must stay on the LIVE screen and the
  // hardware cursor must stay inside the pane (it used to be placed at an
  // absolute buffer row, which the terminal clamped to the last row).
  const visibleRows = (t: string) =>
    [...t.matchAll(/row_(\d+)/g)].map((m) => Number(m[1]));
  pty.write("printf 'row_%02d\\n' $(seq 1 60)\r");
  await sleep(1200);
  text = term.getText();
  console.log(frame("after 60 lines of output"));
  {
    const rows = visibleRows(text);
    const [, cy] = term.getJson({ limit: 1 }).cursor;
    expect("pane shows the live screen after scrolling", rows.includes(60));
    expect("pane drops lines that scrolled off", !rows.includes(1));
    expect("cursor stays inside the pane", cy < ROWS - 1);
  }
  // Wheel up walks into the scrollback; typing snaps back to the live screen.
  const wheel = async (button: number, times: number) => {
    for (let i = 0; i < times; i++) {
      pty.write(`\x1b[<${button};60;10M`);
      await sleep(70);
    }
    await sleep(400);
  };
  const liveTop = Math.min(...visibleRows(text));
  await wheel(64, 8);
  text = term.getText();
  console.log(frame("after wheel-up into the scrollback"));
  {
    const rows = visibleRows(text);
    expect("wheel up reveals scrollback", Math.min(...rows) < liveTop);
    expect("cursor hidden while scrolled back", !term.getJson({ limit: 1 }).cursorVisible);
  }
  pty.write("echo back_to_live\r");
  await sleep(800);
  text = term.getText();
  expect("input snaps the pane back to live", text.includes("back_to_live"));
  expect("cursor returns with the live screen", term.getJson({ limit: 1 }).cursorVisible);

  // --- Mouse reporting ---
  // A program that asks for the mouse (claude sets ?1000/?1002/?1003 + ?1006
  // with the alt screen) scrolls and hit-tests itself, so the pane must hand
  // the events over rather than act on them. `cat -v` shows what arrives.
  pty.write("printf '\\033[?1000h\\033[?1006h'; cat -v\r");
  await sleep(900);
  pty.write("\x1b[<0;60;10M"); // press
  await sleep(150);
  pty.write("\x1b[<0;60;10m"); // release
  await sleep(150);
  pty.write("\x1b[<64;60;10M"); // wheel up
  await sleep(700);
  text = term.getText();
  console.log(frame("mouse events handed to the program"));
  {
    const got = [...text.matchAll(/\^\[\[<[\d;]+[Mm]/g)].map((g) => g[0]);
    expect("press reaches the program", got.some((g) => /<0;\d+;\d+M$/.test(g)));
    expect("release reaches the program", got.some((g) => /<0;\d+;\d+m$/.test(g)));
    expect("wheel goes to the program, not the pane", got.some((g) => /<64;/.test(g)));
  }
  pty.write("\x03"); // leave cat
  await sleep(400);
  pty.write("printf '\\033[?1000l\\033[?1006l'\r");
  await sleep(600);

  // Split right.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("|");
  await sleep(1200);
  text = term.getText();
  console.log(frame("after split"));
  const tabMarkers = (text.match(/1:/g) ?? []).length;
  expect("two panes visible (two tab strips)", tabMarkers >= 2);

  // New tab in the focused (new) pane — via the USER-REMAPPED bind ("t",
  // overriding the default "c" through GHOSTTOWN_CONFIG).
  pty.write(PREFIX);
  await sleep(120);
  pty.write("t");
  await sleep(1200);
  text = term.getText();
  console.log(frame("after new tab"));
  expect("second tab exists (custom 't' bind)", text.includes("2:"));

  // prefix+D (close-tab) kills the active tab; the pane lives on while it
  // still has tabs. Re-created right after, so the counts below hold.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("D");
  await sleep(1000);
  text = term.getText();
  expect("close-tab removed the second tab", !text.includes("2:"));
  expect("pane survives while it has tabs", (text.match(/1:/g) ?? []).length >= 2);
  pty.write(PREFIX);
  await sleep(120);
  pty.write("t");
  await sleep(1200);
  text = term.getText();
  expect("tab re-created", text.includes("2:"));

  // Cycle back to tab 1.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("p");
  await sleep(400);

  // Exercise the control socket from outside.
  const cli = async (...args: string[]): Promise<string> => {
    const proc = Bun.spawn(
      [process.execPath, "run", entry, ...args, "--session", session],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return out + err;
  };

  const listOut = await cli("list");
  console.log(`[harness] gt list output:\n${listOut}`);
  expect("gt list shows session", listOut.includes(`session ${session}`));
  expect("gt list shows 2 panes", (listOut.match(/pane p/g) ?? []).length === 2);
  expect("gt list shows 3 surfaces", (listOut.match(/ s\d+ /g) ?? []).length === 3);

  // --- Pane gap + resize mode ---
  const parseRects = (out: string) => {
    const rects = new Map<string, { w: number; h: number; x: number; y: number; focused: boolean }>();
    const re = /pane (p\d+)( \(focused\))?\s+\[(\d+)x(\d+) @ (\d+),(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(out))) {
      rects.set(m[1]!, {
        focused: !!m[2],
        w: Number(m[3]),
        h: Number(m[4]),
        x: Number(m[5]),
        y: Number(m[6]),
      });
    }
    return rects;
  };
  const rectsBefore = parseRects(listOut);
  {
    const panes = [...rectsBefore.values()].sort((a, b) => a.x - b.x);
    expect(
      "1-cell gap between the two panes",
      panes.length === 2 && panes[1]!.x === panes[0]!.x + panes[0]!.w + 1,
    );
  }
  pty.write(PREFIX);
  await sleep(120);
  pty.write("r");
  await sleep(400);
  text = term.getText();
  expect("resize mode badge shows", text.includes("RESIZE"));
  pty.write("h");
  await sleep(150);
  pty.write("h");
  await sleep(150);
  pty.write("h");
  await sleep(400);
  pty.write("\x1b"); // esc leaves resize mode
  await sleep(400);
  text = term.getText();
  expect("resize badge cleared on esc", !text.includes("RESIZE"));
  const rectsAfter = parseRects(await cli("list"));
  {
    const focusedId = [...rectsBefore.entries()].find(([, r]) => r.focused)?.[0];
    const before = focusedId ? rectsBefore.get(focusedId) : undefined;
    const after = focusedId ? rectsAfter.get(focusedId) : undefined;
    // Focused pane is the right half; 3×h moves the divider 6 cells left.
    expect(
      "resize mode h grew the focused right pane",
      !!before && !!after && after.w >= before.w + 4,
    );
  }

  // Status reporting via socket (authoritative tier).
  const surfaceId = /\*\s+(s\d+)/.exec(listOut)?.[1];
  expect("found focused surface id", !!surfaceId);
  if (surfaceId) {
    await cli("report", "blocked", "--surface", surfaceId);
    await sleep(600);
    text = term.getText();
    console.log(frame("after report blocked"));
    expect("blocked glyph in tab strip", text.includes("⚑"));
    const listAfter = await cli("list");
    expect("gt list shows blocked", listAfter.includes("blocked"));
  }

  // read-screen and send-text round trip.
  await cli("send-text", "echo round_trip_$((6*7))\r");
  await sleep(700);
  const screen = await cli("read-screen");
  expect("read-screen sees sent command output", screen.includes("round_trip_42"));

  // Status heuristic: sustained output then quiet → working, then done.
  pty.write("i=0; while [ $i -lt 5 ]; do echo tick $i; i=$((i+1)); sleep 1; done\r");
  // Poll: the flip to `working` lands somewhere inside the loop's output,
  // and exactly where depends on how the ticks line up with the shell echo.
  let working = false;
  for (let i = 0; i < 12 && !working; i++) {
    await sleep(300);
    text = term.getText();
    working = text.includes("✳");
  }
  expect("heuristic marks working during output", working);
  expect("sidebar lists the running agent", text.includes("running"));
  await sleep(6500); // loop ends + DONE_QUIET + MIN_WORK satisfied
  text = term.getText();
  console.log(frame("after heuristic done"));
  expect("heuristic marks done after quiet", text.includes("✓"));

  // Typing clears done → idle; the agent must STAY in the sidebar, marked idle.
  pty.write("\r");
  await sleep(800);
  text = term.getText();
  console.log(frame("idle agent persists"));
  expect("agent stays listed when idle", text.includes("○"));
  expect("idle agent labeled idle", text.includes("idle"));

  // Help overlay: prefix+? opens, esc closes, input is modal meanwhile.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("?");
  await sleep(600);
  text = term.getText();
  console.log(frame("help overlay"));
  expect("help overlay lists actions", text.includes("split pane right"));
  expect("help overlay shows custom new-tab bind", /\bt\s+new tab in pane/.test(text));
  pty.write("zzz"); // modal: must not reach the shell
  await sleep(300);
  pty.write("\x1b"); // esc closes
  await sleep(500);
  text = term.getText();
  expect("help overlay closes on esc", !text.includes("split pane right"));
  expect("modal input did not reach shell", !text.includes("zzz"));

  // Override REPLACES the default list: the shipped "T" must no longer open
  // a tab now that the user config binds new-tab to "t".
  pty.write(PREFIX);
  await sleep(120);
  pty.write("T");
  await sleep(800);
  text = term.getText();
  expect("default 'T' bind replaced by override", !text.includes("3:"));

  // --- Sidebar & workspaces ---
  expect("sidebar shows profile + halves", text.includes("WORKSPACES") && text.includes("AGENTS"));
  expect("sidebar lists workspace 1", text.includes("workspace 1"));

  // Focus travels: p2 → p1 → sidebar (focus-left past the leftmost pane).
  pty.write(PREFIX);
  await sleep(120);
  pty.write("h");
  await sleep(300);
  pty.write(PREFIX);
  await sleep(120);
  pty.write("h");
  await sleep(300);

  // "a" creates workspace 2 and switches to it (old panes hidden).
  pty.write("a");
  await sleep(1500);
  text = term.getText();
  console.log(frame("after new workspace"));
  expect("workspace 2 appears in sidebar", text.includes("workspace 2"));
  expect("only new workspace's pane visible", (text.match(/1:/g) ?? []).length === 1);

  // Creating a workspace hands the keys to its terminal, so the shell — not
  // the sidebar — sees this.
  pty.write("echo focus_check_7\r");
  await sleep(900);
  text = term.getText();
  expect("new workspace focuses its terminal", text.includes("focus_check_7"));

  // Back into the sidebar (focus-left from the only pane), then "r" renames
  // the selected workspace: dialog is prefilled, clear then type a new name.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("h");
  await sleep(300);
  pty.write("r");
  await sleep(400);
  pty.write("\x7f\x7f\x7f\x7f\x7f\x7f");
  await sleep(150);
  pty.write("\x7f\x7f\x7f\x7f\x7f\x7f");
  await sleep(150);
  pty.write("agents-ws");
  await sleep(200);
  pty.write("\r");
  await sleep(500);
  text = term.getText();
  console.log(frame("after rename"));
  expect("workspace renamed", text.includes("agents-ws"));
  expect("old name gone", !text.includes("workspace 2"));

  // k + enter: back up to workspace 1 and open it → both panes return.
  pty.write("k");
  await sleep(200);
  pty.write("\r");
  await sleep(800);
  text = term.getText();
  expect("workspace 1 reopened (both panes back)", (text.match(/1:/g) ?? []).length >= 2);

  // Delete workspace 2: sidebar → j → d → confirm dialog → y.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("h");
  await sleep(300);
  pty.write("j");
  await sleep(200);
  pty.write("d");
  await sleep(400);
  text = term.getText();
  console.log(frame("delete confirm dialog"));
  expect("delete confirm dialog shows", text.includes("Kill"));
  pty.write("y");
  await sleep(800);
  text = term.getText();
  expect("workspace deleted after confirm", !text.includes("agents-ws"));

  // esc returns focus to the panes; prefix+b toggles the sidebar.
  pty.write("\x1b");
  await sleep(200);
  pty.write(PREFIX);
  await sleep(120);
  pty.write("b");
  await sleep(500);
  text = term.getText();
  console.log(frame("sidebar hidden"));
  expect("sidebar hides on prefix+b", !text.includes("WORKSPACES"));
  pty.write(PREFIX);
  await sleep(120);
  pty.write("b");
  await sleep(500);
  text = term.getText();
  expect("sidebar shows again on prefix+b", text.includes("WORKSPACES"));

  // prefix+C / prefix+X are the workspace pair (they used to fall through to
  // the unshifted "c"/"x" tab binds).
  pty.write(PREFIX);
  await sleep(120);
  pty.write("C");
  await sleep(1800);
  text = term.getText();
  console.log(frame("after prefix+C"));
  expect("prefix+C creates a workspace", text.includes("WORKSPACES (2)"));
  expect("prefix+C did not open a tab", (text.match(/2:/g) ?? []).length === 0);
  pty.write(PREFIX);
  await sleep(120);
  pty.write("X");
  await sleep(600);
  text = term.getText();
  expect("prefix+X asks before deleting the workspace", text.includes("Kill"));
  pty.write("y");
  await sleep(1000);
  text = term.getText();
  expect("prefix+X deleted the workspace", text.includes("WORKSPACES (1)"));

  // Mouse: clicking a sidebar row moves the keys into the sidebar, so the
  // unprefixed "a" there creates a workspace instead of reaching the shell.
  // Sidebar rows (1-based): 1 profile, 2 header, 3 first workspace.
  const click = (col: number, row: number) => {
    pty.write(`\x1b[<0;${col};${row}M`);
    pty.write(`\x1b[<0;${col};${row}m`);
  };
  click(5, 3);
  await sleep(500);
  pty.write("a");
  await sleep(1800);
  text = term.getText();
  console.log(frame("after sidebar click + a"));
  expect("click moves keyboard focus into the sidebar", text.includes("WORKSPACES (2)"));

  // Resize: reflow to a wider grid (travels client → daemon → tui pty).
  pty.resize(120, 34);
  term.resize(120, 34);
  let lineWidth = 0;
  for (let i = 0; i < 10 && lineWidth <= 100; i++) {
    await sleep(500);
    text = term.getText();
    lineWidth = Math.max(...text.split("\n").map((l) => l.trimEnd().length));
  }
  expect("layout reflows to new width", lineWidth > 100);

  // Every cell must carry a background after the resize. The daemon used to
  // drop the tail of big frames (partial socket writes), so the full repaint
  // never reached the client and cells outside the old area stayed unpainted.
  const grid = term.getJson();
  const unpaintedRows = grid.lines.filter((l) => {
    let painted = 0;
    for (const s of l.spans) if (s.bg) painted += s.text.length || s.width;
    return painted < 120;
  }).length;
  expect("resize repaints every cell", unpaintedRows === 0);

  // The snapshot records each surface's directory — cd somewhere findable so
  // the restored shell can be checked below. Focus is in the new workspace's
  // pane (creating a workspace hands it the keys).
  const cwdMarkerDir = join(configDir, "cwd_marker_dir");
  mkdirSync(cwdMarkerDir, { recursive: true });
  pty.write(`cd ${cwdMarkerDir}\r`);
  await sleep(800);

  // Reload: prefix+R restarts the TUI from source; daemon + client stay up.
  // The PTYs die with the old process, but the layout comes back from the
  // snapshot — workspaces, panes, tabs, and each surface's directory.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("R");
  await sleep(5000);
  text = term.getText();
  console.log(frame("after reload"));
  expect("client survives reload", !exited);
  expect("workspaces survive reload", text.includes("WORKSPACES (2)"));
  // basename, not pwd: the full temp path is wider than the pane and would
  // wrap straight through the marker.
  pty.write('basename "$PWD"\r');
  await sleep(900);
  text = term.getText();
  expect("restored surface keeps its directory", text.includes("cwd_marker_dir"));

  // Back to workspace 1 (two panes, one of them with two tabs).
  click(5, 3);
  await sleep(500);
  pty.write("\r");
  await sleep(1200);
  text = term.getText();
  console.log(frame("workspace 1 after reload"));
  expect("panes survive reload", (text.match(/1:/g) ?? []).length >= 2);
  expect("tabs survive reload", text.includes("2:"));

  // Detach: type a marker, detach, reattach with a NEW client — the session
  // (and its screen contents) must survive in the background daemon.
  pty.write("echo persist_$((5*9))\r");
  await sleep(800);
  pty.write(PREFIX);
  await sleep(120);
  pty.write("d");
  await sleep(1500);
  expect("client exited on detach", exited);

  const term2 = new PersistentTerminal({ cols: 120, rows: 34 });
  const pty2 = spawn(
    process.execPath,
    ["--conditions=browser", "run", entry, "--session", session],
    {
      name: "xterm-256color",
      cols: 120,
      rows: 34,
      cwd: join(import.meta.dir, ".."),
      env: harnessEnv,
    },
  );
  let exited2 = false;
  pty2.onData((chunk) => term2.feed(chunk));
  pty2.onExit(({ exitCode }) => {
    exited2 = true;
    console.log(`\n[harness] second client exited with code ${exitCode}`);
  });
  await sleep(3000);
  const text2 = term2.getText();
  console.log(frame("after reattach", term2));
  expect("reattach restores the screen", text2.includes("persist_45"));
  expect("sidebar back after reattach", text2.includes("WORKSPACES"));

  // --- Profile switch: prefix+S names a NEW session and jumps the client ---
  pty2.write(PREFIX);
  await sleep(120);
  pty2.write("S");
  await sleep(500);
  let text3 = term2.getText();
  console.log(frame("new profile dialog", term2));
  expect("new profile dialog shows", text3.includes("new profile"));
  pty2.write(sessionB);
  await sleep(300);
  pty2.write("\r");
  // Old daemon drops the client; it spawns session B's daemon and attaches.
  let switched = false;
  for (let i = 0; i < 24 && !switched; i++) {
    await sleep(500);
    text3 = term2.getText();
    switched = text3.includes(sessionB.slice(0, 16)) && text3.includes("WORKSPACES");
  }
  console.log(frame("after profile switch", term2));
  expect("client switched to the new profile", switched);
  expect("new profile daemon socket exists", existsSync(attachSocketB));
  expect("old profile keeps running detached", existsSync(attachSocket));

  // Kill profile B: prefix+Q tears down ITS tui, daemon, and this client.
  pty2.write(PREFIX);
  await sleep(120);
  pty2.write("Q");
  await sleep(1500);
  expect("app exited on C-a Q", exited2);
  expect("profile B socket removed on kill", !existsSync(attachSocketB));
  // Quitting is explicit: nothing to resurrect next time.
  expect("profile B snapshot removed on kill", !existsSync(snapshotPath(sessionB)));

  // Profile A is still running detached — kill it over its own socket.
  expect("detached profile A still has a snapshot", existsSync(snapshotPath(session)));
  await killDaemon();
  await sleep(600);
  expect("profile A socket removed on kill", !existsSync(attachSocket));
  expect("profile A snapshot removed on kill", !existsSync(snapshotPath(session)));

  if (!exited2) pty2.kill();
  console.log(failures.length === 0 ? "\n[harness] ALL PASS" : `\n[harness] FAILURES: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[harness] error:", err);
  await killDaemon();
  await killDaemon(attachSocketB);
  if (!exited) pty.kill();
  process.exit(1);
});
