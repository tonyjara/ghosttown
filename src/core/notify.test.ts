import { afterEach, describe, expect, it } from "bun:test";
import {
  expandCommand,
  focusCommand,
  notifierArgv,
  notifyText,
  screenDetail,
  shellQuote,
  terminalApp,
  type NotifyRequest,
} from "./notify";
import type { NotificationsConfig } from "./config";

const SETTINGS: NotificationsConfig = { enabled: true, sound: "Glass" };

const REQ: NotifyRequest = {
  key: "s3",
  title: "claude needs input",
  subtitle: "ghosttown · fixing the parser",
  body: "Claude needs your permission to run git push",
  focus: { socket: "/tmp/ghosttown-501/main.sock", surface: "s3" },
};

const flagValue = (argv: string[], flag: string): string | undefined =>
  argv[argv.indexOf(flag) + 1];

afterEach(() => {
  delete process.env.__CFBundleIdentifier;
  delete process.env.TERM_PROGRAM;
});

describe("terminalApp", () => {
  it("prefers the configured app", () => {
    process.env.__CFBundleIdentifier = "com.apple.Terminal";
    expect(terminalApp({ ...SETTINGS, terminal_app: "iTerm" })).toBe("iTerm");
  });

  it("falls back to the bundle id of the terminal the session started in", () => {
    process.env.__CFBundleIdentifier = "com.mitchellh.ghostty";
    process.env.TERM_PROGRAM = "Apple_Terminal";
    expect(terminalApp(SETTINGS)).toBe("com.mitchellh.ghostty");
  });

  it("maps TERM_PROGRAM when there is no bundle id", () => {
    process.env.TERM_PROGRAM = "iTerm.app";
    expect(terminalApp(SETTINGS)).toBe("com.googlecode.iterm2");
  });

  it("has nothing to raise for a terminal it cannot place", () => {
    process.env.TERM_PROGRAM = "tmux";
    expect(terminalApp(SETTINGS)).toBeNull();
  });
});

describe("notifyText", () => {
  it("says which agent and what changed, and where to find it", () => {
    expect(
      notifyText({
        label: "claude",
        title: "rewiring notifications",
        workspace: "ghosttown",
        kind: "blocked",
      }),
    ).toEqual({ title: "claude needs input", subtitle: "ghosttown · rewiring notifications" });
  });

  it("uses the verb for the status", () => {
    const at = (kind: "done" | "blocked") =>
      notifyText({ label: "codex", workspace: "api", kind }).title;
    expect(at("done")).toBe("codex finished");
    expect(at("blocked")).toBe("codex needs input");
  });

  it("does not repeat the label as the program's title", () => {
    const text = notifyText({ label: "claude", title: "claude", workspace: "api", kind: "done" });
    expect(text.subtitle).toBe("api");
  });

  it("names the profile only when it is not the usual one", () => {
    expect(notifyText({ label: "claude", workspace: "api", kind: "done", session: "" }).subtitle)
      .toBe("api");
    expect(
      notifyText({ label: "claude", workspace: "api", kind: "done", session: "review" }).subtitle,
    ).toBe("review · api");
  });

  it("keeps a program's own title as the headline", () => {
    const text = notifyText({
      label: "zsh",
      workspace: "api",
      kind: "custom",
      explicitTitle: "deploy finished",
    });
    expect(text.title).toBe("deploy finished");
    expect(text.subtitle).toBe("api · zsh");
  });
});

describe("focusCommand", () => {
  it("names the session's own socket and surface", () => {
    const cmd = focusCommand(REQ.focus!, "com.mitchellh.ghostty");
    expect(cmd).toContain("focus");
    expect(cmd).toContain(shellQuote("/tmp/ghosttown-501/main.sock"));
    expect(cmd).toContain(`'--surface' 's3'`);
    expect(cmd).toContain(`'--activate' 'com.mitchellh.ghostty'`);
  });

  it("leaves out the app when there is none to raise", () => {
    expect(focusCommand(REQ.focus!, null)).not.toContain("--activate");
  });

  it("quotes a path a shell would otherwise split", () => {
    const cmd = focusCommand({ socket: "/tmp/a b/'; rm -rf .", surface: "s1" }, null);
    expect(cmd).toContain(`'/tmp/a b/'\\''; rm -rf .'`);
  });
});

describe("notifierArgv", () => {
  it("hands terminal-notifier the text, the group and the click command", () => {
    const argv = notifierArgv(REQ, SETTINGS, "/opt/homebrew/bin/terminal-notifier")!;
    expect(argv[0]).toBe("/opt/homebrew/bin/terminal-notifier");
    expect(flagValue(argv, "-title")).toBe(REQ.title);
    expect(flagValue(argv, "-subtitle")).toBe(REQ.subtitle);
    expect(flagValue(argv, "-message")).toBe(REQ.body);
    expect(flagValue(argv, "-sound")).toBe("Glass");
    // One live card per surface, so a second report replaces the first.
    expect(flagValue(argv, "-group")).toBe("ghosttown-s3");
    expect(flagValue(argv, "-execute")).toContain(`'focus' '--socket'`);
    expect(flagValue(argv, "-execute")).toContain(`'--surface' 's3'`);
  });

  it("installs no click action when click_focus is off", () => {
    const argv = notifierArgv(REQ, { ...SETTINGS, click_focus: false }, "/bin/terminal-notifier")!;
    expect(argv).not.toContain("-execute");
  });

  it("shows an unclickable notification as coming from the terminal", () => {
    process.env.__CFBundleIdentifier = "com.mitchellh.ghostty";
    const argv = notifierArgv({ ...REQ, focus: undefined }, SETTINGS, "/bin/terminal-notifier")!;
    expect(argv).not.toContain("-execute");
    expect(flagValue(argv, "-sender")).toBe("com.mitchellh.ghostty");
  });

  it("falls back to osascript, which cannot carry a click", () => {
    if (process.platform !== "darwin") return;
    const argv = notifierArgv(REQ, SETTINGS, null)!;
    expect(argv[0]).toBe("osascript");
    expect(argv[2]).toContain(`display notification "Claude needs your permission`);
    expect(argv[2]).toContain(`with title "claude needs input"`);
    expect(argv[2]).toContain(`subtitle "ghosttown · fixing the parser"`);
    expect(argv[2]).toContain(`sound name "Glass"`);
  });

  it("escapes quotes an agent printed", () => {
    if (process.platform !== "darwin") return;
    const argv = notifierArgv({ ...REQ, body: 'say "hi" \\ bye' }, SETTINGS, null)!;
    expect(argv[2]).toContain('say \\"hi\\" \\\\ bye');
  });

  it("uses the configured command on any platform, ahead of the built-ins", () => {
    const settings = { ...SETTINGS, command: "notify-send {title} {body} && {focus}" };
    const argv = notifierArgv(REQ, settings, "/bin/terminal-notifier")!;
    expect(argv.slice(0, 2)).toEqual(["/bin/sh", "-c"]);
    expect(argv[2]).toContain(`notify-send 'claude needs input'`);
    expect(argv[2]).toContain(`&& '${process.execPath}'`);
    expect(argv[2]).toContain(`'focus' '--socket'`);
  });
});

describe("expandCommand", () => {
  it("shell-quotes every substituted value", () => {
    const out = expandCommand("send {title} {body} {surface}", REQ, SETTINGS, null);
    expect(out).toBe(
      `send 'claude needs input' 'Claude needs your permission to run git push' 's3'`,
    );
  });

  it("cannot be turned into a second command by an agent's output", () => {
    const req = { ...REQ, body: "'; touch /tmp/pwned; echo '" };
    const out = expandCommand("send {body}", req, SETTINGS, null);
    expect(out).toBe(`send ''\\''; touch /tmp/pwned; echo '\\'''`);
  });

  it("leaves unknown placeholders alone and stubs a missing click", () => {
    expect(expandCommand("x {nope} {focus}", REQ, SETTINGS, null)).toBe("x {nope} true");
  });
});

describe("screenDetail", () => {
  it("skips a TUI's input box and hint bar for the last real line", () => {
    const screen = [
      "● Fixed the off-by-one in MuxTerminal.",
      "",
      "╭──────────────────────────────────────╮",
      "│ >                                    │",
      "╰──────────────────────────────────────╯",
      "  ? for shortcuts",
      "",
    ].join("\n");
    expect(screenDetail(screen)).toBe("Fixed the off-by-one in MuxTerminal.");
  });

  it("reads the question out of a permission prompt", () => {
    const screen = [
      "╭─ Bash command ───────────╮",
      "│ git push --force         │",
      "│ Do you want to proceed?  │",
      "╰──────────────────────────╯",
    ].join("\n");
    expect(screenDetail(screen)).toBe("Do you want to proceed?");
  });

  it("ignores a shell prompt sitting at the bottom", () => {
    expect(screenDetail("bun test: 42 pass\n~/src/ghosttown %\n")).toBe("bun test: 42 pass");
  });

  it("has nothing to say about a screen of chrome", () => {
    expect(screenDetail("╭────╮\n│ >  │\n╰────╯\n")).toBe("");
    expect(screenDetail("")).toBe("");
  });

  it("truncates a long line rather than filling the notification", () => {
    const detail = screenDetail("x".repeat(400));
    expect(detail).toHaveLength(160);
    expect(detail.endsWith("…")).toBe(true);
  });
});
