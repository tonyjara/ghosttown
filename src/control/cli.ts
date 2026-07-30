/**
 * The `gt` CLI: a thin client for the control socket, plus `gt hooks` for
 * wiring Claude Code status reports.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config";
import { activateApp, terminalApp } from "../core/notify";
import { request } from "./client";
import { socketPathFor } from "./protocol";
import type { SessionSnapshot } from "../core/types";

const HELP = `ghosttown — agent-first terminal multiplexer

usage:
  gt [--session <name>] [-- <command> [args...]]   start the mux, or reattach
                                                   to a detached session
  gt <subcommand> [options]

subcommands (run from inside a session, or with GHOSTTOWN_SOCKET set):
  list                          panes, tabs, and every agent in the profile
  split [-d right|down] [--pane <id>] [-- <cmd> [args...]]
  new-tab [--pane <id>] [-- <cmd> [args...]]
  select-tab <n> [--pane <id>]
  close-tab [--surface <id>]
  send-text <text> [--surface <id>]
  read-screen [--surface <id>]
  report <idle|working|blocked|done> [--surface <id>] [--message <text>]
  notify <body...> [--title <text>] [--surface <id>]
  focus [--surface <id>] [--pane <id>] [--workspace <id|name>] [--activate <app>]
                                jump to a surface: its workspace, pane and tab
  hooks print                   show Claude Code hooks JSON
  hooks setup                   merge hooks into ~/.claude/settings.json
`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
  command?: string;
  commandArgs: string[];
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { positional: [], flags: {}, commandArgs: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === "--") {
      out.command = argv[i + 1];
      out.commandArgs = argv.slice(i + 2);
      break;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        out.flags[key] = next;
        i += 2;
      } else {
        out.flags[key] = true;
        i += 1;
      }
      continue;
    }
    if (a === "-d") {
      out.flags["dir"] = argv[i + 1] ?? "";
      i += 2;
      continue;
    }
    out.positional.push(a);
    i += 1;
  }
  return out;
}

/**
 * Explicit flags beat the ambient environment. `GHOSTTOWN_SOCKET` is exported
 * into every surface so an in-session `gt` needs no arguments — but a command
 * that names its target must not be redirected to whatever session the shell
 * running it happens to live in. (It was: `gt send-text --session other` typed
 * into the caller's own pane instead.)
 */
function findSocket(flags: Record<string, string | boolean>): string {
  if (typeof flags["socket"] === "string") return flags["socket"];
  if (typeof flags["session"] === "string") return socketPathFor(flags["session"]);
  if (process.env.GHOSTTOWN_SOCKET) return process.env.GHOSTTOWN_SOCKET;
  return socketPathFor(loadConfig().general.session || "main");
}

function surfaceParam(flags: Record<string, string | boolean>): string | undefined {
  if (typeof flags["surface"] === "string") return flags["surface"];
  return process.env.GHOSTTOWN_SURFACE_ID;
}

/**
 * What to put in the notification this report triggers: `--message`, or the
 * hook payload Claude Code writes to our stdin. Its Notification event carries
 * the prompt's own message ("Claude needs your permission to run git push"),
 * which is the whole point of a blocked notification — nothing read off the
 * screen comes close.
 *
 * Only for the statuses that notify: `working` fires on every tool call and has
 * nothing to say. Racing a timeout because a hook must never hang; a manual
 * `gt report` has a TTY on stdin and skips this entirely.
 */
async function reportMessage(
  flags: Record<string, string | boolean>,
  status: string | undefined,
): Promise<string | undefined> {
  if (typeof flags["message"] === "string") return flags["message"];
  if (status !== "blocked" && status !== "done") return undefined;
  if (process.stdin.isTTY) return undefined;
  try {
    const text = await Promise.race([
      Bun.stdin.text(),
      new Promise<string>((r) => setTimeout(() => r(""), 250)),
    ]);
    if (!text.trimStart().startsWith("{")) return undefined;
    const payload = JSON.parse(text) as { message?: unknown };
    const message = typeof payload.message === "string" ? payload.message.trim() : "";
    return message || undefined;
  } catch {
    return undefined; // not JSON, or nothing on stdin: the screen will do
  }
}

function formatList(snap: SessionSnapshot): string {
  const lines: string[] = [`session ${snap.session}`];
  for (const ws of snap.workspaces) {
    lines.push(`  workspace ${ws.id} "${ws.name}"${ws.active ? " (active)" : ""}`);
    for (const pane of ws.panes) {
      lines.push(
        `    pane ${pane.id}${pane.focused ? " (focused)" : ""}  [${pane.rect.width}x${pane.rect.height} @ ${pane.rect.x},${pane.rect.y}]`,
      );
      for (const s of pane.surfaces) {
        const marks = [s.active ? "*" : " ", s.unread ? "●" : " "].join("");
        const agent = s.agent ? `  (${s.agent})` : "";
        lines.push(`      ${marks} ${s.id}  ${s.status.padEnd(7)}  ${s.title}${agent}`);
      }
    }
  }
  // Flat and profile-wide, so `gt list | grep blocked` is a useful thing to run.
  if (snap.agents?.length) {
    lines.push(`  agents (${snap.agents.length})`);
    for (const a of snap.agents) {
      const kind = a.agent ?? "-";
      lines.push(
        `    ${a.live ? "▸" : " "} ${a.surfaceId.padEnd(5)} ${a.status.padEnd(7)} ${kind.padEnd(12)} ${a.workspace}  ${a.title}`,
      );
    }
  }
  return lines.join("\n");
}

function hooksConfig(): Record<string, unknown> {
  // Hooks run in a shell: plain `bun` survives brew upgrades, the absolute
  // entry path makes it work without `gt` on PATH.
  const entry = join(import.meta.dir, "..", "index.ts");
  const gt = `bun ${entry}`;
  const hook = (status: string) => [
    { hooks: [{ type: "command", command: `${gt} report ${status} >/dev/null 2>&1 || true` }] },
  ];
  return {
    hooks: {
      UserPromptSubmit: hook("working"),
      PreToolUse: hook("working"),
      Stop: hook("done"),
      Notification: hook("blocked"),
    },
  };
}

function setupHooks(): void {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    copyFileSync(settingsPath, settingsPath + ".ghosttown-backup");
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  }
  const ours = hooksConfig().hooks as Record<string, unknown[]>;
  const hooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
  for (const [event, entries] of Object.entries(ours)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const already = JSON.stringify(existing).includes("ghosttown") ||
      JSON.stringify(existing).includes("report ");
    hooks[event] = already ? existing : [...existing, ...entries];
  }
  settings.hooks = hooks;
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
  console.log(`updated ${settingsPath} (backup: ${settingsPath}.ghosttown-backup)`);
}

export async function runCli(argv: string[]): Promise<void> {
  const sub = argv[0]!;
  const parsed = parseArgs(argv.slice(1));
  const socket = findSocket(parsed.flags);

  try {
    switch (sub) {
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return;
      case "list": {
        const snap = (await request(socket, "list")) as SessionSnapshot;
        console.log(formatList(snap));
        return;
      }
      case "split": {
        const dir = parsed.flags["dir"] === "down" ? "down" : "right";
        const res = await request(socket, "split", {
          dir,
          pane: parsed.flags["pane"],
          command: parsed.command,
          args: parsed.commandArgs,
        });
        console.log(JSON.stringify(res));
        return;
      }
      case "new-tab": {
        const res = await request(socket, "new-tab", {
          pane: parsed.flags["pane"],
          command: parsed.command,
          args: parsed.commandArgs,
        });
        console.log(JSON.stringify(res));
        return;
      }
      case "select-tab":
        await request(socket, "select-tab", {
          pane: parsed.flags["pane"],
          index: Number(parsed.positional[0]) - 1,
        });
        return;
      case "close-tab":
        await request(socket, "close-tab", { surface: surfaceParam(parsed.flags) });
        return;
      case "send-text":
        await request(socket, "send-text", {
          surface: surfaceParam(parsed.flags),
          text: parsed.positional.join(" "),
        });
        return;
      case "read-screen": {
        const res = (await request(socket, "read-screen", {
          surface: surfaceParam(parsed.flags),
        })) as { text: string };
        console.log(res.text);
        return;
      }
      case "report": {
        const status = parsed.positional[0];
        // Hooks fire outside sessions too — stay silent and succeed.
        if (!process.env.GHOSTTOWN_SOCKET && !existsSync(socket)) return;
        try {
          await request(socket, "report", {
            surface: surfaceParam(parsed.flags),
            status,
            message: await reportMessage(parsed.flags, status),
          });
        } catch {
          return; // never break a hook
        }
        return;
      }
      case "notify":
        await request(socket, "notify", {
          body: parsed.positional.join(" "),
          title: typeof parsed.flags["title"] === "string" ? parsed.flags["title"] : undefined,
          surface: surfaceParam(parsed.flags),
        });
        return;
      case "focus": {
        const pane = parsed.flags["pane"];
        const workspace = parsed.flags["workspace"];
        // Nothing named: the caller's own surface, which is what a script in a
        // background tab wants when it needs the user to look at it.
        const surface =
          typeof parsed.flags["surface"] === "string" || (!pane && !workspace)
            ? surfaceParam(parsed.flags)
            : undefined;
        await request(socket, "focus", {
          surface,
          pane: typeof pane === "string" ? pane : undefined,
          workspace: typeof workspace === "string" ? workspace : undefined,
        });
        // Focus first, then raise the window: whatever comes forward is already
        // showing the right pane. --activate names the app because a notifier's
        // click handler has no environment worth reading.
        const app = parsed.flags["activate"];
        if (typeof app === "string") await activateApp(app);
        else if (app === true) {
          const resolved = terminalApp(loadConfig().notifications);
          if (resolved) await activateApp(resolved);
        }
        return;
      }
      case "hooks": {
        const action = parsed.positional[0] ?? "print";
        if (action === "setup") setupHooks();
        else console.log(JSON.stringify(hooksConfig(), null, 2));
        return;
      }
      default:
        console.error(`unknown subcommand: ${sub}\n`);
        console.log(HELP);
        process.exit(1);
    }
  } catch (err) {
    console.error(`gt ${sub}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

export const CLI_SUBCOMMANDS = new Set([
  "help",
  "--help",
  "-h",
  "list",
  "split",
  "new-tab",
  "select-tab",
  "close-tab",
  "send-text",
  "read-screen",
  "report",
  "notify",
  "focus",
  "hooks",
]);
