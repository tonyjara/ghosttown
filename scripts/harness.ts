/**
 * Headless end-to-end harness: runs the real TUI under a PTY, drives it with
 * keystrokes, and snapshots what a terminal would show (via ghostty-opentui's
 * PersistentTerminal). Usage: bun run scripts/harness.ts
 */
import { spawn } from "bun-pty";
import { PersistentTerminal } from "ghostty-opentui";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { OutputScanner } from "../src/core/queries";
import { attachSocketPathFor, socketPathFor } from "../src/control/protocol";
import { listArchived, readSnapshot, snapshotPath } from "../src/core/persist";
import { join } from "node:path";

const COLS = 100;
const ROWS = 30;
const session = `harness-${process.pid}`;
/** Second profile created by the prefix+S (new-profile) e2e test. */
const sessionB = `harness-${process.pid}-b`;
/** What profile B is renamed to by the switcher's "r" e2e test. */
const sessionC = `harness-${process.pid}-c`;
/** A throwaway profile, created with "a" and then deleted from the inside. */
const sessionD = `harness-${process.pid}-d`;
/** Started fresh at the end, to have a daemon to SIGTERM (the reboot test). */
const sessionE = `harness-${process.pid}-e`;
const entry = join(import.meta.dir, "..", "src", "index.ts");

// A user config override, to prove custom settings win over defaults:
// new-tab remapped from "c" to "t", and a non-default theme.
const configDir = mkdtempSync(join(tmpdir(), "gt-harness-config-"));
const configPath = join(configDir, "config.toml");
// Notifications go to a file instead of the desktop: `[notifications] command`
// replaces the built-in notifiers, so nothing pops up while the harness runs
// and what would have been shown is there to assert on. It has to be repeated
// in every config this run writes — a config REPLACES the shipped default.
const notifyLog = join(configDir, "notify.log");
const NOTIFY_TOML = `[notifications]\ncommand = 'printf "%s~%s~%s\\n" {title} {subtitle} {body} >> ${notifyLog}'\n`;
writeFileSync(
  configPath,
  `[appearance]\ntheme = "catppuccin-mocha"\n\n[keybinds]\n"new-tab" = ["t"]\n\n${NOTIFY_TOML}`,
);

// Both this process (for the snapshot-path assertions) and the children.
process.env.GHOSTTOWN_STATE_DIR = join(configDir, "state");
// Sockets go in a sandbox of their own, which is what makes the profile tests
// safe: listing (and killing) profiles walks this directory, and the real one
// holds whatever sessions the developer is running right now. Short path on
// purpose — a unix socket path is capped at ~104 bytes.
const socketDir = `/tmp/gt-harness-${process.pid}`;
mkdirSync(socketDir, { recursive: true, mode: 0o700 });
/** A shell cd's here to prove a new tab opens in its neighbour's directory. */
const inheritDir = join(socketDir, "inh");
process.env.GHOSTTOWN_SOCKET_DIR = socketDir;

const attachSocket = attachSocketPathFor(session);
const attachSocketB = attachSocketPathFor(sessionB);
const attachSocketC = attachSocketPathFor(sessionC);
const attachSocketD = attachSocketPathFor(sessionD);
const attachSocketE = attachSocketPathFor(sessionE);
// Every GHOSTTOWN_* var is dropped first: running the harness from inside a
// real ghosttown session would otherwise leak that session's GHOSTTOWN_SOCKET
// into the children, and `gt send-text` would type into the developer's own
// pane instead of the sandbox.
const harnessEnv = {
  ...Object.fromEntries(
    Object.entries(process.env).filter(
      ([k, v]) => v !== undefined && !k.startsWith("GHOSTTOWN_"),
    ) as [string, string][],
  ),
  SHELL: "/bin/sh",
  TERM: "xterm-256color",
  GHOSTTOWN_CONFIG: configPath,
  GHOSTTOWN_DAEMON_LOG: join(configDir, "daemon.log"),
  GHOSTTOWN_DEBUG_LOG: process.env.HARNESS_DEBUG_LOG ?? "",
  // Snapshots go in the sandbox, never the developer's ~/.local/state.
  GHOSTTOWN_STATE_DIR: join(configDir, "state"),
  // ...and so do the sockets, so this run's profiles are the only ones any
  // profile list (or profile *delete*) in here can see.
  GHOSTTOWN_SOCKET_DIR: socketDir,
};

// This spawns the ATTACH CLIENT, which starts the background daemon, which
// runs the TUI in its own pty — the harness drives the whole real chain.
const term = new PersistentTerminal({ cols: COLS, rows: ROWS });
// ghostty-opentui emulators start with LNM on (LF acts as CR+LF); a real
// terminal has it off. These stand in for the developer's terminal, so they
// have to agree with one. (Surfaces do the same — see ui/MuxTerminal.)
const LNM_OFF = "\x1b[20l";
term.feed(LNM_OFF);
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
/** Everything the TUI wrote to its "terminal" — for asserting on sequences. */
let hostBytes = "";
pty.onData((chunk) => {
  hostBytes += chunk;
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
function expect(label: string, cond: boolean, detail = ""): void {
  const suffix = detail && !cond ? ` (${detail})` : "";
  console.log(`[harness] ${cond ? "PASS" : "FAIL"}: ${label}${suffix}`);
  if (!cond) failures.push(label + suffix);
}

const PREFIX = "\x01"; // Ctrl+A

/** A session's daemon pid, or 0 — the proof that a restart really replaced it. */
function daemonPid(name: string): number {
  const out = Bun.spawnSync(["ps", "-eo", "pid,args"]).stdout.toString();
  for (const line of out.split("\n")) {
    if (!line.includes(`__daemon --session ${name}`)) continue;
    return Number(line.trim().split(/\s+/)[0]) || 0;
  }
  return 0;
}

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

  // --- Kitty keyboard protocol stays off ---
  // A keypress is forwarded to the child as the bytes it arrived as, and
  // children are told kitty is unsupported (queries answers `CSI ? u` with
  // `CSI ? 0 u`). So the host must not be asked for it either: with the
  // protocol on, ctrl+c arrives as `CSI 99;5u` and that is what the child
  // gets — no SIGINT, just `^[[99;5u` at the prompt. Same for escape and
  // every other ctrl/alt chord. See the render options in src/app.tsx.
  {
    const pushes = [...hostBytes.matchAll(/\x1b\[[>=]([\d;]*)u/g)].map((m) => m[1]);
    expect(
      "no kitty keyboard enhancements are pushed to the host",
      pushes.every((flags) => !flags || /^0+$/.test(flags)),
      `pushed ${JSON.stringify(pushes)}`,
    );
  }

  // And the byte itself: ctrl+c must reach the child as 0x03, so that sending
  // SIGINT is the pty's job. Raw mode (no isig) keeps the reader alive to show
  // it, and `head -c 1` ends the pipeline after exactly one keypress.
  pty.write("stty raw -echo; head -c 1 | cat -v; stty sane\r");
  await sleep(900);
  pty.write("\x03");
  await sleep(600);
  expect(
    "ctrl+c arrives at the child as 0x03, not an escape sequence",
    term.getText().includes("^C"),
  );
  pty.write("\r");
  await sleep(500);

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

  // --- Copying (agent panes only) ---
  // Both ways a copy can happen, checked where it has to land: hostBytes is what
  // the user's terminal receives, and OSC 52 is the only way to reach its
  // clipboard from in here. Both are scoped to panes running an agent, so the
  // pane needs one — a symlink named `claude`, which a real `ps` really does
  // report (the process poll is not mocked).
  const copies = () =>
    [...hostBytes.matchAll(/\x1b\]52;c;([A-Za-z0-9+/=]*)\x07/g)].map((m) =>
      Buffer.from(m[1]!, "base64").toString("utf8"),
    );
  const settleText = async (re: RegExp): Promise<boolean> => {
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      if (re.test(term.getText())) return true;
    }
    return false;
  };
  {
    // In a tab of its own, closed again at the end. A surface that has ever had
    // an agent in it is not the same thing as a plain shell afterwards, and the
    // agent-tally checks further down are counting.
    pty.write(PREFIX);
    await sleep(120);
    pty.write("t"); // new-tab, remapped from "c" by the harness config
    await sleep(1200);
    // Named `codex` rather than `claude`: the detected-agent test further down
    // owns a `claude` symlink of its own, pointed at a different program.
    const fakeAgent = join(configDir, "codex");
    if (!existsSync(fakeAgent)) symlinkSync("/bin/sh", fakeAgent);
    // A shell that ps calls "codex": detected as an agent, and still a shell,
    // so it can be told to print things and have text to select.
    pty.write(`${fakeAgent} -i\r`);
    expect("fake agent is detected in the pane", await settleText(/AGENTS \(1\)/));

    // 1. The program copies for itself. This is claude's path: it owns the
    //    mouse, draws its own selection, and emits OSC 52 on release. The
    //    pane's emulator has no clipboard, so it has to be relayed out.
    const beforeProgram = copies().length;
    pty.write("printf '\\033]52;c;%s\\007' \"$(printf 'from-the-program' | base64)\"\r");
    await sleep(900);
    expect(
      "an agent's own copy is relayed to the host terminal",
      copies().slice(beforeProgram).includes("from-the-program"),
      JSON.stringify(copies()),
    );

    // 2. The mux's own selection. This is the codex path: the program never asks
    //    for the mouse, so dragging selects in the pane and release copies.
    const MARK = "COPYME-0123456789-ENDMARK";
    pty.write(`echo ${MARK}\r`);
    await sleep(900);
    const total = term.getJson({ limit: 1 }).totalLines;
    const lines = term.getJson({ offset: Math.max(0, total - ROWS), limit: ROWS }).lines;
    const row = lines.findIndex((l) => (l.spans ?? []).some((s) => s.text.includes(MARK)));
    expect("marker text is on screen to select", row >= 0, `row ${row}`);
    if (row >= 0) {
      const before = copies().length;
      const lineText = (lines[row]!.spans ?? []).map((s) => s.text).join("");
      const startCol = lineText.indexOf(MARK) + 1; // mouse cols/rows are 1-based
      const y = row + 1;
      pty.write(`\x1b[<0;${startCol};${y}M`); // press
      // The selection's focus is where the last MOTION event was, not where the
      // button came up, so the drag has to reach past the final character.
      for (const i of [6, 12, 18, 24, MARK.length]) {
        pty.write(`\x1b[<32;${startCol + i};${y}M`); // drag
        await sleep(60);
      }
      pty.write(`\x1b[<0;${startCol + MARK.length};${y}m`); // release
      await sleep(700);
      const fresh = copies().slice(before);
      expect(
        "releasing a drag-selection in an agent pane copies it",
        fresh.some((t) => t.includes(MARK)),
        JSON.stringify(fresh),
      );
      // Selection changes are notified per drag step; only the release copies.
      expect("a drag copies exactly once", fresh.length === 1, `${fresh.length} writes`);
    }

    // Out of the fake agent, and the tab is a plain shell again: nothing here is
    // allowed to touch the clipboard.
    pty.write("exit\r");
    expect("fake agent leaves the pane", await settleText(/AGENTS \(0\)/));
    const beforeShell = copies().length;
    pty.write("printf '\\033]52;c;%s\\007' \"$(printf 'from-a-shell' | base64)\"\r");
    await sleep(900);
    expect(
      "a non-agent's copy is left alone",
      !copies().slice(beforeShell).includes("from-a-shell"),
      JSON.stringify(copies().slice(beforeShell)),
    );

    // Close the tab, taking the ex-agent surface with it.
    pty.write(PREFIX);
    await sleep(120);
    pty.write("D"); // close-tab
    await sleep(1200);
  }

  // --- Cursor position report ---
  // The scanner lives in the pty host, the emulator lives in the TUI, so a
  // DSR 6n has to round-trip between processes. `ABC` leaves the cursor in
  // column 4, which is what the answer must say (a fallback would say 1).
  pty.write("printf 'ABC'; printf '\\033[6n'; cat -v\r");
  await sleep(1000);
  text = term.getText();
  console.log(frame("cursor query answered"));
  expect("cursor query answered from the emulator", /\^\[\[\d+;4R/.test(text));
  pty.write("\x03");
  await sleep(400);

  // Split right.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("|");
  await sleep(1200);
  text = term.getText();
  console.log(frame("after split"));
  const tabMarkers = (text.match(/1:/g) ?? []).length;
  expect("two panes visible (two tab strips)", tabMarkers >= 2);

  // A new tab opens where the tab to its left is sitting, so move that shell
  // somewhere recognizable first. Short path on purpose: a ~48-column pane
  // wraps a long `pwd` and the assertion below would never see it whole.
  mkdirSync(inheritDir, { recursive: true });
  pty.write(`cd ${inheritDir}\r`);
  await sleep(700);

  // New tab in the focused (new) pane — via the USER-REMAPPED bind ("t",
  // overriding the default "c" through GHOSTTOWN_CONFIG).
  pty.write(PREFIX);
  await sleep(120);
  pty.write("t");
  await sleep(1200);
  text = term.getText();
  console.log(frame("after new tab"));
  expect("second tab exists (custom 't' bind)", text.includes("2:"));

  pty.write("pwd\r");
  await sleep(900);
  text = term.getText();
  console.log(frame("new tab's directory"));
  // /tmp is a symlink on macOS, and the host reads the physical path.
  expect("new tab inherits the previous tab's directory", /\/inh\b/.test(text));

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

  const click = (col: number, row: number) => {
    pty.write(`\x1b[<0;${col};${row}M`);
    pty.write(`\x1b[<0;${col};${row}m`);
  };

  // --- The tab strip's "+" ------------------------------------------------
  // It opens a tab in ITS pane on DOUBLE click; a single click only focuses
  // the pane (otherwise every mis-aimed tab click would spawn a terminal).
  // Both strips sit on terminal row 1; the focused pane is the right one.
  {
    const plusCol = (term.getText().split("\n")[0] ?? "").lastIndexOf("+") + 1;
    expect("tab strip shows a + affordance", plusCol > 0);
    click(plusCol, 1);
    await sleep(700); // longer than the double-click window
    text = term.getText();
    expect("single click on + opens nothing", !text.includes("3:"));
    click(plusCol, 1);
    await sleep(80);
    click(plusCol, 1);
    await sleep(1500);
    text = term.getText();
    console.log(frame("after double-clicking +"));
    expect("double click on + opens a tab in that pane", text.includes("3:"));

    // --- A tab's own × ----------------------------------------------------
    // One click, on the tab it belongs to: the rightmost × on the strip is the
    // tab just opened. prefix+D is tested above; this is the mouse route.
    const closeCol = (term.getText().split("\n")[0] ?? "").lastIndexOf("×") + 1;
    expect("tabs show an × affordance", closeCol > 0);
    click(closeCol, 1);
    await sleep(1000);
    console.log(frame("after clicking a tab's ×"));
    expect("clicking × closes that tab", !term.getText().includes("3:"));
    expect("the other tabs stay", term.getText().includes("2:"));
  }

  // Cycle back to tab 1.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("p");
  await sleep(400);

  // Exercise the control socket from outside.
  const cli = async (...args: string[]): Promise<string> => {
    const proc = Bun.spawn(
      [process.execPath, "run", entry, ...args, "--session", session],
      { stdout: "pipe", stderr: "pipe", env: harnessEnv },
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

  // --- gt focus: what clicking a notification runs -------------------------
  // A notification names the surface that sent it, and getting there means
  // switching workspace, pane AND tab from outside the app. Focus is put back
  // where it was afterwards, so the tests below still start where they expect.
  const paneSurfaces = (out: string) => {
    const panes = new Map<string, { ids: string[]; active: string; focused: boolean }>();
    let pane: string | null = null;
    for (const line of out.split("\n")) {
      const p = /^\s{4}pane (p\d+)( \(focused\))?/.exec(line);
      if (p) {
        pane = p[1]!;
        panes.set(pane, { ids: [], active: "", focused: !!p[2] });
        continue;
      }
      const s = /^\s{6}([* ])[● ] (s\d+)/.exec(line);
      if (s && pane) {
        const entry = panes.get(pane)!;
        entry.ids.push(s[2]!);
        if (s[1] === "*") entry.active = s[2]!;
      }
    }
    return panes;
  };
  {
    const before = paneSurfaces(listOut);
    const [herePane, here] = [...before].find(([, v]) => v.focused)!;
    const [therePane, there] = [...before].find(([, v]) => !v.focused)!;

    await cli("focus", "--surface", there.ids[0]!);
    await sleep(500);
    expect("gt focus moves to the surface's pane", !!paneSurfaces(await cli("list")).get(therePane)?.focused);

    // ...and a tab that was sitting behind another one comes to the front.
    const background = here.ids.find((id) => id !== here.active)!;
    await cli("focus", "--surface", background);
    await sleep(500);
    const landed = paneSurfaces(await cli("list")).get(herePane);
    console.log(frame("after gt focus"));
    expect(
      "gt focus selects the surface's tab",
      !!landed?.focused && landed.active === background,
    );
    await cli("focus", "--surface", here.active);
    await sleep(500);
    expect(
      "focus restored for the tests below",
      paneSurfaces(await cli("list")).get(herePane)?.active === here.active,
    );
  }

  // --- Pane gap + arrange mode (divider sizes and tab order) ---
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
  const tabsBeforeArrange = paneSurfaces(listOut);
  // Shift moves the active tab along the strip, so which way depends on where
  // it currently sits: the focused pane has two tabs, and either direction has
  // to swap them.
  const arrangeTabKey =
    [...tabsBeforeArrange.values()].find((p) => p.focused)?.active ===
    [...tabsBeforeArrange.values()].find((p) => p.focused)?.ids[0]
      ? "L"
      : "H";
  pty.write(PREFIX);
  await sleep(120);
  pty.write("r");
  await sleep(400);
  text = term.getText();
  expect("arrange mode badge shows", text.includes("ARRANGE"));
  pty.write("h");
  await sleep(150);
  pty.write("h");
  await sleep(150);
  pty.write("h");
  await sleep(400);
  // Shifted, in the same mode session: the tab half of arranging.
  pty.write(arrangeTabKey);
  await sleep(400);
  const tabsAfterL = paneSurfaces(await cli("list"));
  pty.write("\x1b"); // esc leaves arrange mode
  await sleep(400);
  text = term.getText();
  expect("arrange badge cleared on esc", !text.includes("ARRANGE"));
  const rectsAfter = parseRects(await cli("list"));
  {
    const focusedId = [...rectsBefore.entries()].find(([, r]) => r.focused)?.[0];
    const before = focusedId ? rectsBefore.get(focusedId) : undefined;
    const after = focusedId ? rectsAfter.get(focusedId) : undefined;
    // Focused pane is the right half; 3×h moves the divider 6 cells left.
    expect(
      "arrange mode h grew the focused right pane",
      !!before && !!after && after.w >= before.w + 4,
    );

    const was = focusedId ? tabsBeforeArrange.get(focusedId) : undefined;
    const now = focusedId ? tabsAfterL.get(focusedId) : undefined;
    expect(
      `arrange mode ${arrangeTabKey} moved the focused tab along the strip`,
      !!was && !!now && was.ids.length === 2 && now.ids.join() === [...was.ids].reverse().join(),
      `${was?.ids.join()} → ${now?.ids.join()}`,
    );
    // Reordering tabs must not switch the one you are typing in.
    expect("...without changing which tab is active", !!now && now.active === was?.active);
  }

  // --- Dragging the divider with the mouse --------------------------------
  {
    const leftOf = (rs: Map<string, { w: number; h: number; x: number; y: number }>) =>
      [...rs.values()].sort((a, b) => a.x - b.x)[0]!;
    const left = leftOf(rectsAfter);
    const gutterCol = left.x + left.w; // 0-based column of the gap
    const midRow = left.y + Math.floor(left.h / 2);

    // The gap is the drag handle, so it has to be visible: it is painted with
    // the strip color, not the background the panes sit on.
    const bgAt = (col: number, row: number): string => {
      const total = term.getJson({ limit: 1 }).totalLines;
      const line = term.getJson({ offset: Math.max(0, total - ROWS), limit: ROWS }).lines[row];
      let at = 0;
      for (const span of line?.spans ?? []) {
        at += span.text.length;
        if (at > col) return (span.bg ?? "").toLowerCase();
      }
      return "";
    };
    const gutterBg = bgAt(gutterCol, midRow);
    expect(
      "the gap between panes is painted as a divider",
      gutterBg !== "" && gutterBg !== bgAt(gutterCol - 2, midRow),
      `gutter ${gutterBg} vs pane ${bgAt(gutterCol - 2, midRow)}`,
    );

    // A careful, one-cell-at-a-time drag: every motion event lands on the
    // divider's NEW column, so opentui captures the gutter renderable itself.
    // Rebuilding those renderables per frame used to kill the drag after a
    // single cell — the whole feature looked broken to anyone who dragged
    // slowly. Mouse reporting is on in this pane (the program owns the mouse),
    // which must not change who the drag belongs to.
    pty.write("printf '\\033[?1000h\\033[?1002h\\033[?1006h'; cat -v\r");
    await sleep(900);
    // The other pane still shows the escapes the mouse-reporting test asked
    // for, so count rather than look for any.
    const reports = (t: string) => (t.match(/\^\[\[</g) ?? []).length;
    // A wheel notch inside the focused pane, before anything is dragged. It is
    // the baseline the two assertions below are measured against — and it is a
    // regression test in its own right: this pane has TWO tabs and the visible
    // one is not the last, which is exactly the case where the hidden tab's
    // container used to sit on top of it in the hit grid and eat the wheel. The
    // symptom was that scrolling inside an agent did nothing at all.
    const paneCol = COLS - 4;
    const baseline = reports(term.getText());
    pty.write(`\x1b[<64;${paneCol};${midRow + 1}M`);
    await sleep(600);
    expect(
      "the wheel reaches the visible tab's program, not a hidden tab",
      reports(term.getText()) > baseline,
      `${baseline} → ${reports(term.getText())} mouse reports on screen`,
    );
    const reportsBefore = reports(term.getText());
    const STEPS = 8;
    pty.write(`\x1b[<0;${gutterCol + 1};${midRow + 1}M`); // press on the gutter
    await sleep(150);
    for (let i = 0; i <= STEPS; i++) {
      pty.write(`\x1b[<32;${gutterCol + 1 - i};${midRow + 1}M`);
      await sleep(70);
    }
    await sleep(200);
    pty.write(`\x1b[<0;${gutterCol + 1 - STEPS};${midRow + 1}m`);
    await sleep(700);
    const dragged = leftOf(parseRects(await cli("list")));
    console.log(frame("after dragging the divider left"));
    expect(
      "dragging the gutter moves the divider all the way",
      dragged.w === left.w - STEPS,
      `${left.w} → ${dragged.w}, wanted ${left.w - STEPS}`,
    );
    expect(
      "a divider drag stays out of the pane's program",
      reports(term.getText()) === reportsBefore,
      `${reportsBefore} → ${reports(term.getText())} mouse reports on screen`,
    );

    // ...and a drag whose RELEASE never arrives must not leave the mouse
    // wedged. Releasing outside the window looks exactly like this, and while
    // the stale drag lasted every pane swallowed everything — scrolling inside
    // an agent stopped working until the next click landed somewhere.
    const stale = reports(term.getText());
    pty.write(`\x1b[<0;${gutterCol + 1 - STEPS};${midRow + 1}M`); // press
    await sleep(150);
    pty.write(`\x1b[<32;${gutterCol - STEPS};${midRow + 1}M`); // one cell, no up
    await sleep(300);
    // Over the FOCUSED pane — the one running `cat -v` with the mouse on. It is
    // the right half, so a column near the screen edge is inside it whatever
    // the drag above did to the divider.
    for (let i = 0; i < 3; i++) {
      pty.write(`\x1b[<64;${paneCol};${midRow + 1}M`); // wheel up
      await sleep(120);
    }
    await sleep(600);
    console.log(frame("wheel after a drag that never got its release"));
    expect(
      "a lost mouse-up does not leave the panes deaf to the wheel",
      reports(term.getText()) > stale,
      `${stale} → ${reports(term.getText())} mouse reports on screen`,
    );

    // --- Dragging a tab along its strip ------------------------------------
    // Same machinery as the divider, aimed at the one-row strip: press a tab,
    // move, and the order follows the pointer. `cat -v` still owns the mouse in
    // this pane, so this also proves a tab drag is not input for it.
    {
      const focused = [...parseRects(await cli("list")).entries()].find(([, r]) => r.focused)![1];
      const stripRow = focused.y + 1; // SGR rows are 1-based
      // Columns come from the pane's rect, never from the strip text: a status
      // glyph in a label is one character but can be two cells wide, and every
      // column after it would be off by one.
      const firstTabCol = focused.x + 2; // inside the first tab's label
      const stripEndCol = focused.x + focused.w - 1; // bare strip, right of the +
      // The test above leaves a drag without its release on purpose, and opentui
      // goes on dispatching to the renderable it captured until a button comes
      // up — a press now would be delivered there instead of to the tab under
      // it. A bare release clears that capture and nothing else: no press means
      // nothing gets focused or selected behind our back.
      pty.write(`\x1b[<0;${firstTabCol};${stripRow}m`);
      await sleep(400);
      const before = [...paneSurfaces(await cli("list")).values()].find((p) => p.focused)!;
      const quiet = reports(term.getText());

      /** Press on `fromCol`, walk to `toCol`, release — a real drag, not a jump. */
      const dragStrip = async (fromCol: number, toCol: number) => {
        pty.write(`\x1b[<0;${fromCol};${stripRow}M`);
        await sleep(150);
        const step = fromCol <= toCol ? 3 : -3;
        let n = 0;
        for (let col = fromCol; step > 0 ? col <= toCol : col >= toCol; col += step) {
          // A couple of steps in, wander off the one-row strip and down into the
          // pane's terminal area, where `cat -v` is asking for the mouse. The
          // drag owns the pointer, so those motions must not reach it — and the
          // tab has to keep following the column regardless of the row.
          const row = ++n === 3 || n === 4 ? stripRow + 4 : stripRow;
          pty.write(`\x1b[<32;${col};${row}M`);
          await sleep(60);
        }
        pty.write(`\x1b[<0;${toCol};${stripRow}m`);
        await sleep(700);
      };

      // Off the right end of the strip: the tab parks last rather than wrapping.
      await dragStrip(firstTabCol, stripEndCol);
      const dragged = [...paneSurfaces(await cli("list")).values()].find((p) => p.focused)!;
      console.log(frame("after dragging the first tab to the end"));
      expect(
        "dragging a tab right moves it down the strip",
        dragged.ids.at(-1) === before.ids[0] && dragged.ids.length === before.ids.length,
        `${before.ids.join()} → ${dragged.ids.join()}`,
      );
      // Not `===`: grabbing a tab also selects it, so a different tab of this
      // pane may be on screen now. A leak would ADD escapes, which is the thing
      // being ruled out — the drag dipped into the pane on its way across.
      expect(
        "a tab drag crossing the pane adds nothing to its program",
        reports(term.getText()) <= quiet,
        `${quiet} → ${reports(term.getText())} mouse reports on screen`,
      );

      // The same drag again takes whatever is first now to the end — with two
      // tabs that puts back the order the tests below were set up with.
      await dragStrip(firstTabCol, stripEndCol);
      const restored = [...paneSurfaces(await cli("list")).values()].find((p) => p.focused)!;
      expect(
        "dragging the next tab out restores the order",
        restored.ids.join() === before.ids.join(),
        `${dragged.ids.join()} → ${restored.ids.join()}`,
      );
    }

    pty.write("\x03"); // leave cat
    await sleep(400);
    pty.write("printf '\\033[?1000l\\033[?1002l\\033[?1006l'; clear\r");
    await sleep(600);
  }

  // --- A file dropped on the window ---------------------------------------
  // Every terminal delivers a drag-and-drop as a bracketed paste, which is how
  // the path of a dropped file reaches an agent. `cat -v` never asks for ?2004,
  // so it must get the text alone — the markers would be printed as garbage.
  {
    pty.write("cat -v\r");
    await sleep(900);
    const dropped = "/tmp/dropped by mouse.txt";
    pty.write(`\x1b[200~${dropped}\x1b[201~`);
    await sleep(700);
    text = term.getText();
    console.log(frame("after dropping a file on the pane"));
    expect("a dropped file's path reaches the program", text.includes(dropped));
    expect("...without the paste markers a program never asked for", !text.includes("^[[200~"));

    // A program that DOES ask for bracketed paste gets the brackets, which is
    // what tells it the newlines were pasted rather than typed.
    pty.write("\x03");
    await sleep(400);
    pty.write("clear; printf '\\033[?2004h'; cat -v\r");
    await sleep(900);
    pty.write("\x1b[200~pasted line\x1b[201~");
    await sleep(700);
    text = term.getText();
    console.log(frame("paste into a program that asked for ?2004"));
    expect("a program that asked for ?2004 gets bracketed text", text.includes("^[[200~pasted line^[[201~"));
    pty.write("\x03");
    await sleep(300);
    pty.write("printf '\\033[?2004l'; clear\r");
    await sleep(600);
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
  // The sidebar lists *agents*, and a shell running a loop is not one — but the
  // surface that reported above is, and the header tallies its status.
  expect("sidebar header tallies the blocked agent", /AGENTS \(1\)/.test(text));
  expect("sidebar tally shows the blocked glyph", /⚑\s*1/.test(text));
  expect("busy shell is not listed as an agent", !/○\s*sh/.test(text));
  await sleep(6500); // loop ends + DONE_QUIET + MIN_WORK satisfied
  text = term.getText();
  console.log(frame("after heuristic done"));
  expect("heuristic marks done after quiet", text.includes("✓"));

  // An agent that goes idle must STAY in the sidebar, marked idle — finished
  // work has to remain one `enter` away.
  if (surfaceId) {
    await cli("report", "idle", "--surface", surfaceId);
    await sleep(800);
    text = term.getText();
    console.log(frame("idle agent persists"));
    expect("agent stays listed when idle", /○\s*\S/.test(text));
    expect("gt list still reports it as an agent", (await cli("list")).includes("agents (1)"));

    // A thinking agent's sidebar glyph PULSES, and that needs a real two-frame
    // comparison: a prop that silently stops updating is this stack's normal
    // failure (JSX props are evaluated once without the compiler plugin), and a
    // frozen frame looks exactly like the static glyph it replaced.
    await cli("report", "working", "--surface", surfaceId);
    // `✳` is also the *still* glyph, in the tab strip and the status-bar tally;
    // the other four frames appear nowhere else in the UI, so catching one of
    // them on screen is the animation itself, wherever the row has scrolled to.
    const pulse = new Set<string>();
    const moved = () => [...pulse].some((g) => g !== "✳");
    for (let i = 0; i < 20 && !moved(); i++) {
      await sleep(150);
      for (const g of term.getText().match(/[✢✳✶✻✽]/g) ?? []) pulse.add(g);
    }
    console.log(frame("working pulse"));
    expect(`a working agent's sidebar glyph pulses (saw ${[...pulse].join("")})`, moved());
    await cli("report", "idle", "--surface", surfaceId);
    await sleep(500);
  }

  // A *detected* agent, on the other hand, is listed exactly while it is running:
  // quit it and the row goes away instead of lingering as a shell named after its
  // directory. In a tab of its own, so the reporter surface above stays out of it.
  {
    // A symlink to sleep, so a real `ps` really does show "…/claude 45" under
    // the tab's shell — the process poll is not mocked here.
    const fakeAgent = join(configDir, "claude");
    if (!existsSync(fakeAgent)) symlinkSync("/bin/sleep", fakeAgent);
    pty.write(PREFIX);
    await sleep(120);
    pty.write("t");
    await sleep(1200);
    // The pid goes in a variable: a non-interactive `sh` has no job control.
    pty.write(`${fakeAgent} 45 & AGENT=$!\r`);
    const settle = async (re: RegExp): Promise<boolean> => {
      for (let i = 0; i < 20; i++) {
        await sleep(400);
        if (re.test(term.getText())) return true;
      }
      return false;
    };
    const listed = await settle(/AGENTS \(2\)/);
    console.log(frame("detected agent joins the list"));
    expect("process detection lists an agent that printed nothing", listed);
    // It is running in the tab that has the keys, so its row is the one marked
    // "you are here" — the bar sits before the status glyph, never over it.
    // Any status glyph, pulse frames included — the point is the bar sits
    // *before* the glyph rather than over it.
    expect("the agent you are in is marked in the sidebar", /▌[·○✳✢✶✻✽✓⚑]/.test(term.getText()));

    // The second line of a row is what the agent is working on: the tab's own
    // OSC title, minus the status glyph the agent leads it with (claude puts a
    // braille spinner frame there, which would flicker). Set one for real, from
    // inside the agent's tab, and read it back off the sidebar.
    pty.write("printf '\\033]2;\\342\\234\\263 Fix the sidebar rows\\007'\r");
    await settle(/Fix the sidebar rows/);
    console.log(frame("agent row with its context line"));
    const lines = term.getText().split("\n");
    const ctxAt = lines.findIndex((l) => l.includes("Fix the sidebar rows"));
    expect("an agent row carries a line of what it is working on", ctxAt > 0);
    const ctxLine = lines[ctxAt] ?? "";
    // Sidebar rows are (bar)(glyph)(unread)(label), and the context hangs under
    // the label — so it is indented, and the row above it is the agent itself.
    expect("...indented under the row it belongs to", /^ {3}Fix the sidebar rows/.test(ctxLine));
    expect("...with the agent's own spinner glyph stripped off", !ctxLine.includes("✳"));
    expect("...directly under the agent it describes", (lines[ctxAt - 1] ?? "").includes("claude"));

    // Both lines are one click target. The wrapper box holding them claims the
    // hit grid (a box does, even empty), so a press on the *context* line has to
    // reach the same jump the name line does — otherwise it bubbles to the
    // sidebar and only takes the keys.
    click(5, 2); // sidebar chrome: hand the keys to the sidebar first
    await sleep(400);
    click(5, ctxAt + 1); // getText is 0-indexed, mouse rows are 1-based
    await sleep(600);
    pty.write("echo ctx_click\r");
    await sleep(1000);
    console.log(frame("after clicking an agent's context line"));
    expect("clicking the context line jumps into that agent", term.getText().includes("ctx_click"));

    // `[-]` on a row hides it; `[+n]` in the header brings them all back. Both
    // are found by searching the line rather than by counting columns, so the
    // test says nothing about how wide the sidebar happens to be.
    {
      const rowsNow = () => term.getText().split("\n");
      const rowAt = rowsNow().findIndex((l) => l.includes("Fix the sidebar rows")) - 1;
      const hideCol = (rowsNow()[rowAt] ?? "").indexOf("[-]") + 2; // on the `-`
      expect("an agent row carries a [-] to hide it", hideCol > 1);
      click(hideCol, rowAt + 1);
      const hid = await settle(/\[\+1\]/);
      console.log(frame("after hiding an agent row"));
      // The sidebar's own copy of the title — the tab strip and the status bar
      // keep showing it, which is the point: only the *list* got shorter.
      const listed = () => rowsNow().some((l) => /^ {3}Fix the sidebar rows/.test(l));
      expect("clicking [-] takes the row off the list", hid && !listed());
      // Off the list, not out of the profile — the header still counts it, and
      // the click never moved the keys out of the pane they were in.
      expect("...while the header still counts it", /AGENTS \(2\)/.test(term.getText()));
      const headerAt = rowsNow().findIndex((l) => l.includes("AGENTS ("));
      const unhideCol = (rowsNow()[headerAt] ?? "").indexOf("[+1]") + 2;
      click(unhideCol, headerAt + 1);
      const back = await settle(/Fix the sidebar rows/);
      console.log(frame("after unhiding from the header"));
      expect("the header's [+n] puts every hidden row back", back);
    }

    pty.write('kill "$AGENT"\r');
    const gone = await settle(/AGENTS \(1\)/);
    console.log(frame("quit agent leaves the list"));
    expect("the row goes away when the agent exits", gone);
    // Leave the pane as it was found: the tab counts below assume two.
    pty.write(PREFIX);
    await sleep(120);
    pty.write("D");
    await sleep(1000);
  }

  // --- What a notification actually says -----------------------------------
  // Blocking where you cannot see it is the case notifications exist for, and
  // the point is that the card alone tells you which agent, where it lives and
  // what it wants — `--message` carries what Claude Code's hook passes on.
  // [notifications] command sends it to a file instead of the desktop.
  {
    const panes = paneSurfaces(await cli("list"));
    const hidden = [...panes.values()].find((p) => !p.focused)!.active;
    await cli("report", "blocked", "--surface", hidden, "--message", "may I run git push?");
    await sleep(1000);
    const notified = existsSync(notifyLog) ? readFileSync(notifyLog, "utf8") : "";
    console.log(`[harness] notifications:\n${notified}`);
    const card = notified.trim().split("\n").pop() ?? "";
    expect("a pane you cannot see blocking notifies", card.split("~").length === 3);
    expect("the notification names the tab and what changed", card.startsWith("sh needs input~"));
    expect("...says which profile and workspace it is in", card.includes(`~${session} · workspace 1~`));
    expect("...and carries the reporter's own message", card.endsWith("~may I run git push?"));
    await cli("report", "idle", "--surface", hidden);
    await sleep(300);
  }

  // Help overlay: prefix+? opens, esc closes, input is modal meanwhile.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("?");
  await sleep(600);
  text = term.getText();
  console.log(frame("help overlay"));
  expect("help overlay lists actions", text.includes("split pane right"));
  expect("help overlay shows custom new-tab bind", /\bt\s+new tab in pane/.test(text));
  // It must fit: the workspace/agent keys and the LAST category both visible,
  // which is what a single overflowing column used to cut off.
  expect(
    "help overlay shows the workspace and agent keys",
    text.includes("Workspaces") && text.includes("find workspace") && text.includes("Agents"),
  );
  expect(
    "help overlay fits the screen (last category visible)",
    text.includes("Other") && text.includes("send literal"),
  );
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

  // --- Fuzzy finders (prefix+w workspaces, prefix+a agents) --------------
  // Type to filter, enter jumps. The footer's n/total is the reliable proof
  // that filtering happened — the names themselves also live in the sidebar.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("w");
  await sleep(500);
  text = term.getText();
  console.log(frame("workspace finder"));
  expect("workspace finder opens", text.includes("find workspace"));
  // Footer reads "<selected>/<total>"; the selection starts on the current one.
  expect("workspace finder lists both workspaces", /\d\/2 ·/.test(text));
  pty.write("agen"); // matches "agents-ws" only
  await sleep(400);
  text = term.getText();
  console.log(frame("workspace finder filtered"));
  expect("query filters the list", text.includes("1/1"));
  pty.write("\r");
  await sleep(800);
  text = term.getText();
  expect("finder switched workspace on enter", text.includes("▣ agents-ws"));

  // Back to workspace 1 the same way, this time with ctrl+u clearing a
  // no-match query first.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("w");
  await sleep(400);
  pty.write("zzzz");
  await sleep(300);
  text = term.getText();
  expect("no-match query says so", text.includes("no match") && text.includes("0/0"));
  pty.write("\x15"); // ctrl+u
  await sleep(300);
  pty.write("space 1");
  await sleep(300);
  pty.write("\r");
  await sleep(900);
  text = term.getText();
  console.log(frame("back in workspace 1 via the finder"));
  expect("ctrl+u clears the query", text.includes("▣ workspace 1"));

  // prefix+, renames the focused tab. The name overrides the program's own
  // title, so it must survive the reload further down.
  pty.write(PREFIX);
  await sleep(120);
  pty.write(",");
  await sleep(500);
  text = term.getText();
  console.log(frame("rename tab dialog"));
  expect("rename tab dialog opens", text.includes("rename tab"));
  pty.write("\x15"); // ctrl+u clears the prefilled title
  await sleep(200);
  pty.write("renamed_tab");
  await sleep(200);
  pty.write("\r");
  await sleep(600);
  text = term.getText();
  console.log(frame("after tab rename"));
  expect("tab strip shows the new name", text.includes(":renamed_tab"));

  // prefix+a finds agents (the surface the status heuristic ran in earlier).
  pty.write(PREFIX);
  await sleep(120);
  pty.write("a");
  await sleep(500);
  text = term.getText();
  console.log(frame("agent finder"));
  expect("agent finder opens", text.includes("find agent"));
  expect("agent finder found the agent", text.includes("⏎ open") && !text.includes("no match"));
  pty.write("\x1b"); // esc: nothing to jump to that we are not already on
  await sleep(400);
  text = term.getText();
  expect("agent finder closes on esc", !text.includes("find agent"));

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

  // prefix+N / prefix+P cycle workspaces, wrapping. The new workspace is the
  // active one, so N wraps forward onto workspace 1 and P comes back.
  expect("the new workspace is the active one", !text.includes("▣ workspace 1"));
  pty.write(PREFIX);
  await sleep(120);
  pty.write("N");
  await sleep(600);
  text = term.getText();
  console.log(frame("after prefix+N"));
  expect("prefix+N wraps to the first workspace", text.includes("▣ workspace 1"));
  pty.write(PREFIX);
  await sleep(120);
  pty.write("P");
  await sleep(600);
  text = term.getText();
  expect("prefix+P goes back the other way", !text.includes("▣ workspace 1"));

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

  // Mouse: clicking a workspace ROW opens it and hands the keys to its
  // terminal. Leaving them in the sidebar turned the next letter into a
  // sidebar command — "a" made another workspace instead of reaching the shell.
  // Sidebar rows (1-based): 1 profile, 2 header, 3 first workspace.
  click(5, 3);
  await sleep(600);
  pty.write("echo click_to_shell\r");
  await sleep(1000);
  text = term.getText();
  console.log(frame("after clicking a workspace row"));
  expect("workspace click hands the keys to its terminal", text.includes("click_to_shell"));
  expect("workspace click created nothing", text.includes("WORKSPACES (1)"));

  // Clicking the sidebar's own chrome still takes the keys, which is what
  // makes j/k/a/r/d reachable with the mouse: "a" creates workspace 2.
  click(5, 2);
  await sleep(500);
  pty.write("a");
  await sleep(1800);
  text = term.getText();
  console.log(frame("after sidebar header click + a"));
  expect("clicking sidebar chrome takes the keys", text.includes("WORKSPACES (2)"));

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

  // A shell variable is the proof that matters: only the very same process can
  // still have it. A fresh shell in the same directory would print nothing.
  pty.write("SURVIVOR=alive_$$\r");
  await sleep(600);
  // ...and a background job whose output must keep landing in this surface
  // across the reload, which is what an agent left running really does.
  pty.write("(i=0; while [ $i -lt 40 ]; do echo beat_$i; i=$((i+1)); sleep 1; done) &\r");
  await sleep(2500);
  const beatsBefore = [...term.getText().matchAll(/beat_(\d+)/g)].map((m) => Number(m[1]));
  expect("background job is printing before the reload", beatsBefore.length > 0);

  // Reload: prefix+R restarts the TUI from source; daemon + client stay up.
  // The surface PTYs belong to the daemon's pty host, so nothing running in
  // them is disturbed — the new TUI adopts them and rebuilds its emulators
  // from the host's replay buffers.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("R");
  await sleep(5000);
  text = term.getText();
  console.log(frame("after reload"));
  expect("client survives reload", !exited);
  expect("workspaces survive reload", text.includes("WORKSPACES (2)"));
  expect("scrollback survives reload (replayed)", text.includes("beat_0"));
  {
    const after = [...text.matchAll(/beat_(\d+)/g)].map((m) => Number(m[1]));
    expect(
      "background job kept running through the reload",
      after.length > 0 && Math.max(...after) > Math.max(...beatsBefore),
    );
  }
  pty.write('echo "survivor=$SURVIVOR"\r');
  await sleep(900);
  text = term.getText();
  console.log(frame("same shell after reload"));
  expect("the very same shell survived the reload", /survivor=alive_\d+/.test(text));
  // basename, not pwd: the full temp path is wider than the pane and would
  // wrap straight through the marker.
  pty.write('basename "$PWD"\r');
  await sleep(900);
  text = term.getText();
  expect("adopted surface keeps its directory", text.includes("cwd_marker_dir"));
  // Kill the background job so its output stops polluting later frames.
  pty.write("kill %1 2>/dev/null; wait 2>/dev/null\r");
  await sleep(600);

  // --- Restart (prefix+B) --------------------------------------------------
  // The other half of the dev loop: a reload respawns the TUI, a restart takes
  // the daemon with it, so pty-host changes actually land. Only the client
  // survives. The session is rebuilt from the snapshot the daemon flushes on
  // the way out — same workspaces, tabs, names and directories — but every
  // shell in it is new, which is the whole trade and worth asserting both ways.
  {
    const pidBefore = daemonPid(session);
    expect("found the daemon before the restart", pidBefore > 0);
    pty.write(PREFIX);
    await sleep(120);
    pty.write("B");
    // Daemon teardown, then two bun cold starts (daemon, tui) and a prompt.
    await sleep(11000);
    text = term.getText();
    console.log(frame("after restart"));
    const pidAfter = daemonPid(session);
    expect("client survives the restart", !exited);
    expect(
      "the daemon itself was replaced",
      pidAfter > 0 && pidAfter !== pidBefore,
      `before=${pidBefore} after=${pidAfter}`,
    );
    expect("workspaces come back from the snapshot", text.includes("WORKSPACES (2)"));
    // A fresh shell in the same directory: the cwd is restored (and with it the
    // active workspace, since that shell lives in the second one), the process
    // is not. $SURVIVOR only exists in the shell that set it before the reload.
    pty.write('echo "survivor=[$SURVIVOR]"; basename "$PWD"\r');
    await sleep(1200);
    text = term.getText();
    console.log(frame("fresh shell after restart"));
    expect("restored surface keeps its directory", text.includes("cwd_marker_dir"));
    expect(
      "the shell is a new process (panes do not survive a restart)",
      text.includes("survivor=[]"),
    );
  }

  // --- Config hot reload -------------------------------------------------
  // Saving the config applies it in place: no reload, no restart, and the
  // surfaces (which the pty host owns) replay into the remounted UI.
  writeFileSync(
    configPath,
    `[appearance]\ntheme = "gruvbox"\n\n[keybinds]\n"new-tab" = ["y"]\n\n${NOTIFY_TOML}`,
  );
  await sleep(2000);
  text = term.getText();
  console.log(frame("after config save"));
  {
    const bgs = new Set<string>();
    for (const l of term.getJson().lines) {
      for (const s of l.spans) if (s.bg) bgs.add(s.bg.toLowerCase());
    }
    expect("saved theme reaches the screen without a reload", bgs.has("#282828"));
  }
  expect("surfaces survive the config remount", text.includes("cwd_marker_dir"));
  pty.write(PREFIX);
  await sleep(120);
  pty.write("y");
  await sleep(1500);
  text = term.getText();
  console.log(frame("after rebound new-tab"));
  expect("rebound keys work without a reload", text.includes("2:"));
  pty.write(PREFIX);
  await sleep(120);
  pty.write("D");
  await sleep(1000);

  // Back to workspace 1 (two panes, one of them with two tabs) — one click.
  click(5, 3);
  await sleep(1200);
  text = term.getText();
  console.log(frame("workspace 1 after reload"));
  expect("panes survive reload", (text.match(/1:/g) ?? []).length >= 2);
  expect("tabs survive reload", text.includes("2:"));
  // The rename is held in the pty host, so a restarted TUI adopts it back.
  expect("tab rename survives the reload", text.includes(":renamed_tab"));

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
  term2.feed(LNM_OFF);
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

  // --- Profile management from the switcher (prefix+s): a / r / d ----------
  // Two profiles are running now: A (detached) and B (this client's).
  pty2.write(PREFIX);
  await sleep(120);
  pty2.write("s");
  await sleep(600);
  text3 = term2.getText();
  console.log(frame("profile switcher", term2));
  expect("switcher lists both profiles", text3.includes("a new · r rename · d delete"));

  // "a" is the new-profile input again — no second daemon, just the dialog.
  pty2.write("a");
  await sleep(400);
  expect("a opens the new-profile input", term2.getText().includes("new profile"));
  pty2.write("\x1b"); // esc goes BACK to the switcher, not away
  await sleep(400);
  text3 = term2.getText();
  expect("esc returns to the switcher", text3.includes("d delete") && !text3.includes("new profile"));

  // "r" renames the selected profile — B, the one we are in — in place. The
  // panes are untouched: the daemon just moves its sockets and snapshot.
  pty2.write("r");
  await sleep(500);
  console.log(frame("rename profile dialog", term2));
  expect("rename dialog opens prefilled", term2.getText().includes(sessionB.slice(0, 16)));
  pty2.write("\x15"); // ctrl+u
  await sleep(200);
  pty2.write(sessionC);
  await sleep(200);
  pty2.write("\r");
  let renamed = false;
  for (let i = 0; i < 20 && !renamed; i++) {
    await sleep(400);
    renamed = existsSync(attachSocketC) && term2.getText().includes(sessionC.slice(0, 18));
  }
  console.log(frame("after profile rename", term2));
  expect("rename moved the daemon socket", renamed);
  expect("old profile name is gone", !existsSync(attachSocketB));
  // The rename is a real one: the control socket under the NEW name reaches
  // this same session. (--socket, because cli() always names session A.)
  const listC = await cli("list", "--socket", socketPathFor(sessionC));
  expect("gt reaches the profile under its new name", listC.includes(`session ${sessionC}`));
  // The snapshot follows the name, so a restore lands in the right profile.
  let snapshotMoved = false;
  for (let i = 0; i < 12 && !snapshotMoved; i++) {
    await sleep(400);
    snapshotMoved = existsSync(snapshotPath(sessionC)) && !existsSync(snapshotPath(sessionB));
  }
  expect("session snapshot follows the rename", snapshotMoved);

  // "d" deletes the OTHER profile (A, detached) with everything inside it. This
  // is the only destructive one: stopping a profile keeps its layout, deleting it
  // retires the layout to the archive.
  expect("detached profile A still has a snapshot", existsSync(snapshotPath(session)));
  pty2.write(PREFIX);
  await sleep(120);
  pty2.write("s");
  await sleep(500);
  // Profiles are listed sorted, so A ("…-<pid>") sits above C ("…-<pid>-c").
  pty2.write("k");
  await sleep(200);
  pty2.write("d");
  await sleep(500);
  text3 = term2.getText();
  console.log(frame("delete profile confirm", term2));
  expect(
    "delete asks before killing a profile",
    text3.includes(`Delete "${session}"`) && text3.includes("layout is archived"),
  );
  pty2.write("y");
  let killedA = false;
  for (let i = 0; i < 20 && !killedA; i++) {
    await sleep(400);
    killedA = !existsSync(attachSocket) && !existsSync(snapshotPath(session));
  }
  console.log(frame("after deleting the other profile", term2));
  expect("delete killed profile A's daemon and snapshot", killedA);
  expect("this client stayed in its own profile", !exited2);
  // ...and the layout it took is recoverable: `gt restore` reads this.
  expect(
    "the deleted profile's layout went to the archive",
    listArchived(session).length > 0,
    `archive: ${listArchived(session).map((a) => a.path).join(", ") || "empty"}`,
  );

  // Killing the profile you are IN has to move the client somewhere first —
  // otherwise "delete this profile" would drop you out of ghosttown. Make a
  // second one with "a", jump there, and delete it from the inside.
  pty2.write("a");
  await sleep(400);
  pty2.write(sessionD);
  await sleep(200);
  pty2.write("\r");
  let inD = false;
  for (let i = 0; i < 24 && !inD; i++) {
    await sleep(500);
    text3 = term2.getText();
    inD = text3.includes(sessionD.slice(0, 18)) && text3.includes("WORKSPACES");
  }
  console.log(frame("in the profile about to delete itself", term2));
  expect("a created and switched to another profile", inD && existsSync(attachSocketD));
  pty2.write(PREFIX);
  await sleep(120);
  pty2.write("s");
  await sleep(500);
  pty2.write("d"); // the switcher opens on the current profile
  await sleep(500);
  text3 = term2.getText();
  console.log(frame("delete the profile we are in", term2));
  expect(
    "the confirm says where this client will land",
    text3.includes(`Delete "${sessionD}"`) && text3.includes("this client moves to"),
  );
  pty2.write("y");
  let backInC = false;
  for (let i = 0; i < 24 && !backInC; i++) {
    await sleep(500);
    text3 = term2.getText();
    backInC =
      !existsSync(attachSocketD) &&
      text3.includes(sessionC.slice(0, 18)) &&
      text3.includes("WORKSPACES");
  }
  console.log(frame("landed back in the surviving profile", term2));
  expect("deleting the current profile lands the client in another one", backInC);
  expect("the client is still attached to something", !exited2);
  expect("the deleted profile left no snapshot", !existsSync(snapshotPath(sessionD)));

  // Kill what is left: prefix+Q tears down ITS tui, daemon, and this client.
  pty2.write(PREFIX);
  await sleep(120);
  pty2.write("Q");
  await sleep(1500);
  expect("app exited on C-a Q", exited2);
  expect("profile socket removed on quit", !existsSync(attachSocketC));
  // A quit ends what is *running*, not the arrangement. The layout stays on
  // disk and `gt --session <name>` opens it again — it used to be deleted here,
  // which made every quit a small demolition.
  expect("quit keeps the session snapshot", existsSync(snapshotPath(sessionC)));

  if (!exited2) pty2.kill();

  // --- Reboot (SIGTERM) ----------------------------------------------------
  // The signal the machine sends every process on its way down. This used to be
  // read as a deliberate kill, and deliberate kills deleted the snapshot: one
  // restart wiped the workspace arrangement of every profile at once. It must be
  // the opposite — the last thing a daemon does is write the layout down.
  {
    const term3 = new PersistentTerminal({ cols: COLS, rows: ROWS });
    term3.feed(LNM_OFF);
    const pty3 = spawn(
      process.execPath,
      ["--conditions=browser", "run", entry, "--session", sessionE],
      { name: "xterm-256color", cols: COLS, rows: ROWS, cwd: join(import.meta.dir, ".."), env: harnessEnv },
    );
    let exited3 = false;
    pty3.onData((d) => term3.feed(d));
    pty3.onExit(() => {
      exited3 = true;
    });
    await sleep(5000);
    // Something worth keeping: a split, so the layout is more than a default.
    pty3.write(PREFIX);
    await sleep(120);
    pty3.write("|");
    await sleep(1600); // past the layout push + the host's save debounce
    console.log(frame("profile about to be SIGTERM'd", term3));
    const before = readSnapshot(sessionE);
    expect(
      "the running session wrote a snapshot with both panes",
      before?.workspaces[0]?.panes.length === 2,
      `panes: ${before?.workspaces[0]?.panes.length ?? "none"}`,
    );

    const pid = daemonPid(sessionE);
    expect("found the daemon to signal", pid > 0);
    if (pid > 0) process.kill(pid, "SIGTERM");
    for (let i = 0; i < 20 && daemonPid(sessionE) > 0; i++) await sleep(300);
    expect("the daemon went down on SIGTERM", daemonPid(sessionE) === 0);
    expect("its socket went with it", !existsSync(attachSocketE));

    const after = readSnapshot(sessionE);
    expect("a reboot keeps the snapshot", !!after);
    expect(
      "...with the layout intact",
      after?.workspaces[0]?.panes.length === 2,
      `panes: ${after?.workspaces[0]?.panes.length ?? "none"}`,
    );
    // Nothing was retired or clobbered on the way out, either.
    expect("nothing was archived by the signal", listArchived(sessionE).length === 0);
    if (!exited3) pty3.kill();
  }
  console.log(failures.length === 0 ? "\n[harness] ALL PASS" : `\n[harness] FAILURES: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error("[harness] error:", err);
  for (const socket of [
    attachSocket,
    attachSocketB,
    attachSocketC,
    attachSocketD,
    attachSocketE,
  ]) {
    await killDaemon(socket);
  }
  if (!exited) pty.kill();
  process.exit(1);
});
