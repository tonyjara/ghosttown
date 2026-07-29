/**
 * The `gt` CLI: a thin client for the control socket, plus `gt hooks` for
 * wiring Claude Code status reports.
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config";
import { request } from "./client";
import { socketPathFor } from "./protocol";
import type { SessionSnapshot } from "../core/types";

const HELP = `ghosttown — agent-first terminal multiplexer

usage:
  gt [--session <name>] [-- <command> [args...]]   start the mux, or reattach
                                                   to a detached session
  gt <subcommand> [options]

subcommands (run from inside a session, or with GHOSTTOWN_SOCKET set):
  list                          show panes, tabs, and agent status
  split [-d right|down] [--pane <id>] [-- <cmd> [args...]]
  new-tab [--pane <id>] [-- <cmd> [args...]]
  select-tab <n> [--pane <id>]
  close-tab [--surface <id>]
  send-text <text> [--surface <id>]
  read-screen [--surface <id>]
  report <idle|working|blocked|done> [--surface <id>]
  notify <body...>
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

function findSocket(flags: Record<string, string | boolean>): string {
  if (typeof flags["socket"] === "string") return flags["socket"];
  if (process.env.GHOSTTOWN_SOCKET) return process.env.GHOSTTOWN_SOCKET;
  const session =
    typeof flags["session"] === "string"
      ? flags["session"]
      : loadConfig().general.session || "main";
  return socketPathFor(session);
}

function surfaceParam(flags: Record<string, string | boolean>): string | undefined {
  if (typeof flags["surface"] === "string") return flags["surface"];
  return process.env.GHOSTTOWN_SURFACE_ID;
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
        lines.push(`      ${marks} ${s.id}  ${s.status.padEnd(7)}  ${s.title}`);
      }
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
          });
        } catch {
          return; // never break a hook
        }
        return;
      }
      case "notify":
        await request(socket, "notify", { body: parsed.positional.join(" ") });
        return;
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
  "hooks",
]);
