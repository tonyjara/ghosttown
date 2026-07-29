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
   engine, query responder) imports nothing from `src/ui/`. The daemon/client
   split in phase 2 cuts along this seam.
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

## Architecture (MVP: single process)

```
┌──────────────────────── gt (TUI process) ───────────────────────┐
│  ui/          Solid components: App, PaneView, TabStrip, StatusBar│
│  core/        layout tree · surface runtime (PTY+VT) · status    │
│               engine · query responder · OSC observer            │
│  control/     Unix socket server (JSON lines)                    │
└───────────────▲──────────────────────────────────────────────────┘
                │ GHOSTTOWN_SOCKET
        gt CLI (report/notify/split/new-tab/send-text/read-screen)
                ▲
        Claude Code hooks (UserPromptSubmit/PreToolUse/Stop/Notification)
```

Data flow per surface: `pty.onData → query-responder (answers DSR/DA1/OSC 10/11
back to the pty) → OSC observer (title, OSC 9 notifications) → status tracker →
GhosttyTerminalRenderable.feed()`. Input: parsed `KeyEvent` → prefix state
machine → either a mux action or `pty.write(key.raw)`.

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
- done/blocked on a non-visible surface → unread badge + OSC 9 host
  notification (+ macOS notification via osascript).

## MVP scope (v0.1)

- [x] Research + stack verification
- [x] Panes with h/v splits, directional focus, click-to-focus, resize/reflow
- [x] **Per-pane tab strips**: new/close/cycle/select (keys + mouse)
- [x] Live shell/agent in every surface (default `$SHELL`, or any command)
- [x] Status glyphs per tab + status bar; unread badges; desktop notifications
- [x] Query responder (DSR 6n/5n, DA1, XTVERSION, OSC 10/11, DECRQM, kitty query → 0)
- [x] Unix socket + `gt` CLI: list, split, new-tab, select-tab, close-tab,
      send-text, read-screen, report, notify
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
| `C` / `X` (shift) | new / delete workspace |
| `r` | resize mode: h/j/k/l move the divider, esc leaves |
| `s` / `S` | switch profile / new profile (sessions; old one keeps running) |
| `d` | detach — session keeps running in the daemon |
| `R` (shift+r) | reload the TUI from source (dev loop) |
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
- ~~Session snapshots~~ (shipped: `src/core/persist.ts` writes the layout —
  workspaces, split ratios, panes, tab order, per-surface cwd — to
  `$XDG_STATE_HOME/ghosttown/<session>.session.json` on structural changes
  and every 30s; `initSession` rebuilds from it, so reload, a TUI crash and a
  reboot all come back. Processes are not restored: a restored surface is a
  fresh shell in its old directory. An explicit quit/kill drops the snapshot).
- **Phase 2 — remaining persistence:** scrollback view + search,
  worktree-per-agent helper (`gt new --worktree`).
- **Phase 2.5 — the real fix for reload:** move the surface PTYs into the
  daemon so it owns the model and the TUI is only a view. Reload then keeps
  the processes themselves (today it only rebuilds the layout around new
  shells), and a TUI crash costs nothing. Needs: a surface manager + headless
  `PersistentTerminal` per surface in the daemon (the query responder needs a
  cursor, see `runtime.ts`), surface I/O frames on the attach socket, and a
  bounded raw-output ring buffer replayed into the fresh renderable —
  ghostty exposes no screen serializer, only `getText`/`getJson`.
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
