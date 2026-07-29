#!/usr/bin/env bun
/**
 * Entry point: `gt` with a known subcommand acts as a socket-client CLI;
 * otherwise it starts the mux TUI.
 */
const argv = process.argv.slice(2);
const first = argv[0];

async function main(): Promise<void> {
  if (first && !first.startsWith("-")) {
    const { CLI_SUBCOMMANDS, runCli } = await import("./control/cli");
    if (CLI_SUBCOMMANDS.has(first)) {
      await runCli(argv);
      return;
    }
    console.error(`unknown subcommand: ${first} (try: gt help)`);
    process.exit(1);
  }

  // TUI mode: gt [--session <name>] [-- <command> [args...]]
  const { loadConfig } = await import("./core/config");
  let session = loadConfig().general.session || "main";
  let command: string | undefined;
  let commandArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--session" && argv[i + 1]) {
      session = argv[++i]!;
    } else if (a === "--help" || a === "-h") {
      const { runCli } = await import("./control/cli");
      await runCli(["help"]);
      return;
    } else if (a === "--") {
      command = argv[i + 1];
      commandArgs = argv.slice(i + 2);
      break;
    }
  }

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
  await startApp({ session, command, args: commandArgs });
}

await main();
