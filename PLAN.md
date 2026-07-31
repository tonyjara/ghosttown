# ghosttown

An **agent-first terminal multiplexer**. Like tmux, but built around AI coding
agents: every pane has its own **tab strip** (cmux-style "surfaces"), every
surface knows whether its agent is **idle / working / blocked / done**, and you
get notified the moment an agent finishes or needs you.

## Why this exists

- **cmux** proved the tabs-per-pane layout (workspaces → panes → surfaces) — but
  it's a native macOS GUI.
- **herdr** proved the terminal-native agent mux — but its hierarchy is
  workspaces → tabs → panes; tabs contain panes, not the reverse.
- Nobody ships a **terminal-native mux with per-pane tabs**. That's ghosttown.

The mental model: **a pane is an agent's slot**. The agent CLI, a shell in the
same directory, the dev server, lazygit — they're tabs behind one pane. Your
screen layout maps to "which agents am I running," not "which windows are open."

## Design principles

These keep the design portable (e.g. a future Rust port) and honest:

1. **Protocol-first.** Everything the UI can do is expressible as a JSON message
   over the Unix control socket. The `gt` CLI is just a socket client. Agents
   inside the mux can drive the mux itself (they get `GHOSTTOWN_SOCKET`,
   `GHOSTTOWN_PANE_ID`, `GHOSTTOWN_SURFACE_ID` in their environment).
2. **VT state lives behind a native core.** Terminal emulation is
   libghostty-vt (via `ghostty-opentui`), never TypeScript. If we ever rewrite,
   we rewrite the orchestration, not the emulator.
3. **Chrome vs grid boundary.** SolidJS components render *chrome* (tab strips,
   status bar). Terminal grids render through the native
   `GhosttyTerminalRenderable` buffer path. Per-frame cell data never touches
   the reconciler.
4. **Core is UI-agnostic.** `src/core/` (layout tree, surface lifecycle, status
   engine, query responder) imports nothing from `src/ui/`. The daemon/TUI split
   cut along this seam, and the daemon must stay that way: it imports no
   solid/opentui, so a UI-side error can never take the surfaces down with it.
5. **Status is hook-first, heuristic-fallback.** Explicit agent reports (Claude
   Code hooks → `gt report`) are authoritative. Output-activity heuristics are
   the fallback for anything without hooks. Never scrape spinner text.

## Stack (verified working, 2026-07)

| Layer | Choice | Notes |
|---|---|---|
| Runtime | Bun | runs TS directly; single-file executable later via `bun build --compile` |
| PTY | `bun-pty` | prebuilt native binaries (incl. darwin-arm64), node-pty-compatible API |
| VT emulation | `ghostty-opentui` | libghostty-vt as prebuilt NAPI module; `PersistentTerminal` + ready-made OpenTUI renderable with reflow-on-resize |
| UI | `@opentui/core` + `@opentui/solid` | native Zig renderer; Solid runtime-JSX (no build step); flexbox + absolute layout; mouse support |
| Control | Bun `Bun.listen` Unix socket | newline-delimited JSON |

Host kitty-keyboard is deliberately **disabled** (`useKittyKeyboard: null`) so
`KeyEvent.raw` stays legacy-encoded and can be forwarded to children verbatim.
Child apps that *query* for kitty protocol get "not supported" — they degrade
gracefully. Proper KKP passthrough is a phase-3 differentiator.

## Architecture (model in the daemon, view in the TUI)

```
    gt (attach client: raw bytes ⇄ tty)
                │  <session>.attach.sock
┌───────────────▼──── daemon (owns the session) ───────────────────┐
│  attach/daemon    PTY running the TUI · client fan-out · modes    │
│  attach/ptyhost   THE SURFACES: pty per surface · query responder │
│                   · OSC observer · status engine · replay buffer  │
│                   · layout snapshot on disk                      │
└───────────────▲──────────────────────────────────────────────────┘
                │  <session>.host.sock   (spawn/sub/w/resize/kill ⇄ o/snap/status)
┌───────────────▼──── gt __tui (the view, restartable) ────────────┐
│  ui/          Solid components: App, PaneView, TabStrip, StatusBar│
│  core/        layout tree · surface proxies · store               │
│  control/     Unix socket server (JSON lines)                     │
└───────────────▲──────────────────────────────────────────────────┘
                │ GHOSTTOWN_SOCKET
        gt CLI (report/notify/split/new-tab/send-text/read-screen)
                ▲
        Claude Code hooks (UserPromptSubmit/PreToolUse/Stop/Notification)
```

The split is what makes the TUI disposable: `prefix R` (or a `bun --watch`
restart under `GHOSTTOWN_DEV=1`) replaces the view while the model keeps
running, and the new view adopts each surface by id.

Data flow per surface, host-side: `pty.onData → query-responder (answers
DSR/DA1/OSC 10/11 back to the pty) → OSC observer (title, OSC 9) → status
tracker → replay buffer → `o` frame`. TUI-side: `o` frame →
`GhosttyTerminalRenderable.feed()`. Input: parsed `KeyEvent` → prefix state
machine → either a mux action or a `w` frame the host writes to the pty.

The one thing the host cannot answer alone is DSR 6n: only the view has an
emulator, so a cursor query becomes a `cpr-req`/`cpr` round trip (falling back
to the last known cursor if no view is attached — the reload window).

Layout is a binary split tree; rects are computed manually from terminal
dimensions (deterministic cols/rows for `pty.resize`), panes are
absolutely-positioned boxes: 1-row tab strip + terminal.

## Status model

`idle | working | blocked | done` (herdr's vocabulary — "blocked" fires only on
explicit signals, never guessed from text).

- **Tier 1 (authoritative):** `gt report <status>` over the socket, wired to
  Claude Code hooks by `gt hooks setup`. UserPromptSubmit/PreToolUse → working,
  Stop → done, Notification → blocked.
- **Tier 2 (fallback):** output activity. Output flowing → working; ≥4s of
  activity followed by ≥2s quiet → done (one notification), brief activity →
  idle. Disabled for a surface once it has ever reported explicitly.
- Typing into a surface clears done/blocked → idle. Focusing clears unread.
- done/blocked on a non-visible surface → unread badge + a desktop notification
  naming the agent, its workspace and its own title, bodied with the hook
  message / OSC 9 text / last meaningful screen line. Clicking it runs
  `gt focus --surface <id>` (terminal-notifier `-execute`), which switches
  workspace, pane and tab and raises the terminal; osascript is the fallback
  when terminal-notifier is not installed, and cannot carry a click.

## MVP scope (v0.1)

- [x] Research + stack verification
- [x] Panes with h/v splits, directional focus, click-to-focus, resize/reflow
- [x] **Per-pane tab strips**: new/close/cycle/select (keys + mouse)
- [x] Live shell/agent in every surface (default `$SHELL`, or any command)
- [x] Status glyphs per tab + status bar; unread badges; desktop notifications
- [x] Query responder (DSR 6n/5n, DA1, XTVERSION, OSC 10/11, DECRQM, kitty query → 0)
- [x] Unix socket + `gt` CLI: list, split, new-tab, select-tab, close-tab,
      send-text, read-screen, report, notify, focus
- [x] `gt hooks setup` for Claude Code
- [x] Scripted PTY harness test (app driven under bun-pty, frames snapshotted)
- [x] TOML config: shipped defaults (`config.default.toml`) deep-merged with
      `~/.config/ghosttown/config.toml`; keybinds fully remappable
- [x] `prefix ?` floating help pane showing the merged keybinds

### Keybindings (prefix `Ctrl+A`, tmux-style; `Ctrl+A Ctrl+A` sends literal)

| Key | Action |
|---|---|
| `\|` / `-` | split right / down |
| `h j k l` / arrows | focus pane by direction |
| `T` (shift+t) | new tab in focused pane |
| `n` / `p` | next / previous tab |
| `1`–`9` | select tab N |
| `D` (shift+d) | close tab (pane closes with last tab) |
| `,` | rename tab (sticks over the program's title) |
| `C` / `W` / `X` (shift) | new / rename / delete workspace |
| `w` / `a` | find workspace / find agent (fuzzy pickers with an input) |
| `r` | resize mode: h/j/k/l move the divider, esc leaves |
| `s` / `S` | profiles (switch, and a/r/d to add/rename/kill) / new profile |
| `d` | detach — session keeps running in the daemon |
| `R` (shift+r) | reload the TUI from source (dev loop; panes keep running) |
| `Q` (shift+q) | kill ghosttown and everything inside it |

Mouse: click pane → focus; click tab → select; click the sidebar → focus it
on that row; drag the gap between panes → resize; scroll → (phase 2:
scrollback).

## Roadmap

- ~~Config file~~ (shipped), ~~workspaces (multiple layouts)~~ (shipped, with
  the profile→workspaces→panes→tabs sidebar), ~~detach/reattach~~ (shipped as
  a dtach-style daemon: `src/attach/` owns a PTY running the TUI; `gt`
  proxies raw bytes over `<session>.attach.sock`, replays DECSET modes and
  forces a full repaint via the `redraw` control method on reattach; TUI
  exit 42 = dev reload respawn).
- ~~Interactive pane resize~~ (shipped: `prefix r` resize mode with h/j/k/l,
  plus mouse-draggable gutters between panes — pane_gap cells wide).
- ~~Theming~~ (shipped: `[appearance] theme` with ghosttown/catppuccin
  (mocha+latte)/tokyonight/gruvbox/nord/dracula palettes in `src/ui/themes.ts`,
  `[theme]` per-color overrides).
- ~~Profile switching~~ (shipped: `prefix s` / `prefix S` — the daemon sends
  `bye reason:"switch"` and the attach client re-enters its connect loop
  against the target session, spawning that daemon if needed; the old
  session keeps running detached).
- ~~Profile management~~ (shipped: `a` / `r` / `d` inside `prefix s`. A rename is
  the daemon moving its own sockets and snapshot to the new name and telling its
  TUI over `set-session` — nothing in the panes notices; the TUI keeps its old
  control socket alive for surfaces that were spawned with it in their env. A
  delete is that profile's daemon killing everything it owns, with the client
  moved to a surviving profile first when it is the one being deleted).
- ~~Session snapshots~~ (shipped: the layout — workspaces, split ratios, panes,
  tab order, per-surface id and cwd — goes to
  `$XDG_STATE_HOME/ghosttown/<session>.session.json`. The TUI serializes the
  structure and the pty host writes the file, since it owns the pids the cwds
  come from; on structural changes and every 30s. Consulted only on a *cold*
  start now, where a restored surface is a fresh shell in its old directory.
  Nothing that merely *stops* a session touches the file — quit, kill, SIGTERM
  and reboot all flush it and leave it, and the profile list reads the state dir
  so a stopped profile is still offered. Only deleting a profile retires a
  layout, and that moves it to `archive/`, where `gt profiles -a` and
  `gt restore` can reach it).
- ~~Surfaces in the daemon~~ (shipped as `src/attach/ptyhost.ts`: the daemon
  owns every surface pty, the scanner, the status engine and a bounded raw
  replay buffer; the TUI is a client over `<session>.host.sock` and adopts live
  surfaces by id on start. Reload and `--watch` restarts keep the processes,
  and the disk snapshot dropped from being the reload mechanism to being the
  crash/reboot fallback.
  Two deviations from the original sketch: no headless `PersistentTerminal` in
  the daemon — a cursor query round-trips to the TUI instead, which is both
  cheaper and more accurate — and surface frames got their own socket rather
  than sharing the attach socket, which carries the outer terminal's bytes.
  Replay is trimmed to whole chunks and re-opened at an escape boundary, with
  the private modes it trimmed away replayed as a prelude.)
- ~~Config hot reload~~ (shipped: the config files are watched; a save
  re-merges them, re-resolves the theme in place and remounts the UI. Safe
  because a remount no longer costs anything — the surfaces are the host's and
  replay into the new emulators).
- **Phase 2 — remaining persistence:** scrollback view + search,
  worktree-per-agent helper (`gt new --worktree`).
- **Phase 3 — the flexes:** kitty keyboard passthrough (per-child re-encoding),
  DECRQM/mode mirroring per pane, remote attach over SSH,
  `bun build --compile` single-binary releases.

## Reference material

- openmux (`monotykamary/openmux`, MIT) — proof that this exact stack ships a
  real mux; study its shim protocol, query passthrough, and key encoder when
  building phase 2/3. Cloned in scratchpad during development.
- cmux surfaces model: https://cmux.com/docs — workspaces → panes → surfaces.
- herdr status model: https://herdr.dev/docs — strict blocked-detection.
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
