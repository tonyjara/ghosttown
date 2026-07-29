/**
 * Headless end-to-end harness: runs the real TUI under a PTY, drives it with
 * keystrokes, and snapshots what a terminal would show (via ghostty-opentui's
 * PersistentTerminal). Usage: bun run scripts/harness.ts
 */
import { spawn } from "bun-pty";
import { PersistentTerminal } from "ghostty-opentui";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { OutputScanner } from "../src/core/queries";
import { join } from "node:path";

const COLS = 100;
const ROWS = 30;
const session = `harness-${process.pid}`;
const entry = join(import.meta.dir, "..", "src", "index.ts");

// A user config override, to prove custom settings win over defaults:
// new-tab remapped from "c" to "t".
const configDir = mkdtempSync(join(tmpdir(), "gt-harness-config-"));
const configPath = join(configDir, "config.toml");
writeFileSync(configPath, `[keybinds]\n"new-tab" = ["t"]\n`);

const term = new PersistentTerminal({ cols: COLS, rows: ROWS });
const pty = spawn(process.execPath, ["--conditions=browser", "run", entry, "--session", session], {
  name: "xterm-256color",
  cols: COLS,
  rows: ROWS,
  cwd: join(import.meta.dir, ".."),
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, v]) => v !== undefined) as [string, string][],
    ),
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    GHOSTTOWN_NO_NOTIFY: "1",
    GHOSTTOWN_CONFIG: configPath,
  },
});

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

function frame(label: string): string {
  const text = term.getText();
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
  await sleep(2500); // bun cold start + renderer init + shell prompt
  let text = term.getText();
  console.log(frame("initial"));
  expect("tab strip shows first tab", text.includes("1:"));
  expect("status bar shows session", text.includes(session.slice(0, 12)));
  expect("shell prompt appeared", /[$%#>]/.test(text));

  // Type into the shell.
  pty.write("echo hello_ghosttown\r");
  await sleep(700);
  text = term.getText();
  expect("shell echoed command output", text.includes("hello_ghosttown"));

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
  await sleep(2500);
  text = term.getText();
  expect("heuristic marks working during output", text.includes("✳"));
  await sleep(6500); // loop ends + DONE_QUIET + MIN_WORK satisfied
  text = term.getText();
  console.log(frame("after heuristic done"));
  expect("heuristic marks done after quiet", text.includes("✓"));

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

  // Override REPLACES the default list: "c" must no longer open a tab.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("c");
  await sleep(800);
  text = term.getText();
  expect("default 'c' bind replaced by override", !text.includes("3:"));

  // Resize: reflow to a wider grid.
  pty.resize(120, 34);
  term.resize(120, 34);
  await sleep(900);
  text = term.getText();
  const lineWidth = Math.max(...text.split("\n").map((l) => l.trimEnd().length));
  expect("layout reflows to new width", lineWidth > 100);

  // Quit.
  pty.write(PREFIX);
  await sleep(120);
  pty.write("q");
  await sleep(1000);
  expect("app exited on C-a q", exited);

  if (!exited) pty.kill();
  console.log(failures.length === 0 ? "\n[harness] ALL PASS" : `\n[harness] FAILURES: ${failures.length}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("[harness] error:", err);
  if (!exited) pty.kill();
  process.exit(1);
});
