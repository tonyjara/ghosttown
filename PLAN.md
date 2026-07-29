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
- [ ] Panes with h/v splits, directional focus, click-to-focus, resize/reflow
- [ ] **Per-pane tab strips**: new/close/cycle/select (keys + mouse)
- [ ] Live shell/agent in every surface (default `$SHELL`, or any command)
- [ ] Status glyphs per tab + status bar; unread badges; OSC 9 + desktop notifications
- [ ] Query responder (DSR 6n/5n, DA1, XTVERSION, OSC 10/11, DECRQM, kitty query → 0)
- [ ] Unix socket + `gt` CLI: list, split, new-tab, select-tab, close-tab,
      send-text, read-screen, report, notify
- [ ] `gt hooks setup` for Claude Code
- [ ] Scripted PTY harness test (app driven under bun-pty, frames snapshotted)

### Keybindings (prefix `Ctrl+A`, tmux-style; `Ctrl+A Ctrl+A` sends literal)

| Key | Action |
|---|---|
| `\|` / `-` | split right / down |
| `h j k l` / arrows | focus pane by direction |
| `c` | new tab in focused pane |
| `n` / `p` | next / previous tab |
| `1`–`9` | select tab N |
| `x` | close tab (pane closes with last tab) |
| `q` | quit session |

Mouse: click pane → focus; click tab → select; scroll → (phase 2: scrollback).

## Roadmap

- **Phase 2 — daemon split & persistence:** move `core/` + PTYs into a
  `gt daemon` process (the socket protocol already exists); `gt attach`,
  detach on client death, session restore. Scrollback view + search.
  Interactive pane resize. Config file. Worktree-per-agent helper
  (`gt new --worktree`).
- **Phase 3 — the flexes:** kitty keyboard passthrough (per-child re-encoding),
  DECRQM/mode mirroring per pane, workspaces (multiple layouts), remote attach
  over SSH, `bun build --compile` single-binary releases.

## Reference material

- openmux (`monotykamary/openmux`, MIT) — proof that this exact stack ships a
  real mux; study its shim protocol, query passthrough, and key encoder when
  building phase 2/3. Cloned in scratchpad during development.
- cmux surfaces model: https://cmux.com/docs — workspaces → panes → surfaces.
- herdr status model: https://herdr.dev/docs — strict blocked-detection.
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks
