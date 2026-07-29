#!/usr/bin/env bun
/**
 * Entry point, four hats:
 *   gt <subcommand>        socket-client CLI (list, split, report, …)
 *   gt [--session <name>]  attach client — starts or reattaches to a session
 *   gt __daemon …          headless session daemon (spawned by the client)
 *   gt __tui …             the actual TUI (spawned by the daemon in a PTY)
 * GHOSTTOWN_NO_DAEMON=1 skips the daemon and runs the TUI directly.
 */
const argv = process.argv.slice(2);
const first = argv[0];

interface StartOpts {
  session: string;
  command?: string;
  commandArgs: string[];
  cols?: number;
  rows?: number;
  help: boolean;
}

async function parseStartArgs(args: string[]): Promise<StartOpts> {
  const { loadConfig } = await import("./core/config");
  const out: StartOpts = {
    session: loadConfig().general.session || "main",
    commandArgs: [],
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--session" && args[i + 1]) {
      out.session = args[++i]!;
    } else if (a === "--cols" && args[i + 1]) {
      out.cols = Number(args[++i]);
    } else if (a === "--rows" && args[i + 1]) {
      out.rows = Number(args[++i]);
    } else if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--") {
      out.command = args[i + 1];
      out.commandArgs = args.slice(i + 2);
      break;
    }
  }
  return out;
}

async function startTui(opts: StartOpts): Promise<void> {
  // Solid must resolve to its client build (dist/solid.js). Under Bun's
  // default "node" condition it resolves to the SSR server build and the UI
  // breaks — re-exec with the browser condition when that happens.
  if (import.meta.resolve("solid-js").includes("/dist/server.")) {
    const proc = Bun.spawn(
      [process.execPath, "--conditions=browser", "run", import.meta.path, ...argv],
      { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env },
    );
    process.exit(await proc.exited);
  }
  const { startApp } = await import("./app");
  await startApp({ session: opts.session, command: opts.command, args: opts.commandArgs });
}

async function main(): Promise<void> {
  if (first === "__daemon") {
    const opts = await parseStartArgs(argv.slice(1));
    const { runDaemon } = await import("./attach/daemon");
    await runDaemon({
      session: opts.session,
      cols: opts.cols || 80,
      rows: opts.rows || 24,
      command: opts.command,
      args: opts.commandArgs,
    });
    return;
  }
  if (first === "__tui") {
    await startTui(await parseStartArgs(argv.slice(1)));
    return;
  }

  if (first && !first.startsWith("-")) {
    const { CLI_SUBCOMMANDS, runCli } = await import("./control/cli");
    if (CLI_SUBCOMMANDS.has(first)) {
      await runCli(argv);
      return;
    }
    console.error(`unknown subcommand: ${first} (try: gt help)`);
    process.exit(1);
  }

  const opts = await parseStartArgs(argv);
  if (opts.help) {
    const { runCli } = await import("./control/cli");
    await runCli(["help"]);
    return;
  }

  if (process.env.GHOSTTOWN_NO_DAEMON === "1") {
    await startTui(opts);
    return;
  }
  const { runAttachClient } = await import("./attach/client");
  await runAttachClient({
    session: opts.session,
    command: opts.command,
    args: opts.commandArgs,
  });
}

await main();
