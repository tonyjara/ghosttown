```
   ▄▄▄▄▄▄
▄██████████▄   ╔═╗╦ ╦╔═╗╔═╗╔╦╗╔╦╗╔═╗╦ ╦╔╗╔
███  ██  ███   ║ ╦╠═╣║ ║╚═╗ ║  ║ ║ ║║║║║║║
███  ██  ███   ╚═╝╩ ╩╚═╝╚═╝ ╩  ╩ ╚═╝╚╩╝╝╚╝
████████████
█▀▀██▀▀██▀▀█   a   t o w n   f o r   y o u r   a g e n t s
```

**A terminal multiplexer built for AI coding agents.** Like tmux, but every pane
has its own tab strip, every tab shows whether its agent is idle / working /
blocked / done, and you get a desktop notification the moment one finishes or
needs you — one that says which agent and what it wants, and takes you to its
tab when you click it.

The mental model: **a pane is an agent's slot.** The agent CLI, a shell in the
same directory, the dev server — they're tabs behind one pane. Your screen
layout maps to "which agents am I running", not "which windows are open".

The hierarchy is **profile → workspaces → panes → tabs**: a profile is a
session, each workspace is its own pane layout switched instantly with
everything kept alive, and a sidebar lists both — plus every agent running
anywhere in the profile.

```
┌ 1:claude ✳ ×  2:zsh × + ───────┬ 1:claude ⚑ ● ×  2:lazygit × + ─┐
│                                │                                │
│  (claude working…)             │  (claude blocked on a          │
│                                │   permission prompt)           │
│                                │                                │
├────────────────────────────────┴────────────────────────────────┤
│ ⌂ main  ✳ 1  ⚑ 1                                       zsh  C-a │
└──────────────────────────────────────────────────────────────────┘
```

## Run

```sh
bun install
bun run start                      # start the mux (session "main"), or reattach
bun run start -- --session work    # a second session
bun link                           # optional: global `gt` command
```

Requires Bun ≥ 1.2 on macOS or Linux. All native pieces (PTY, terminal
emulation, renderer) ship prebuilt — no toolchain needed.

Sessions run in a background daemon: plain `gt` starts one, `prefix d` detaches
(everything keeps running), running `gt` again reattaches with the screen intact.

## Keys

Prefix is `Ctrl+A`, tmux-style. The essentials:

| Key | Action |
|---|---|
| `\|` / `-` | split right / down |
| `h j k l` / arrows | focus pane by direction |
| `T` / `n` / `p` / `1`–`9` | new tab · next · previous · select tab N |
| `w` / `a` | fuzzy-find a **workspace** / an **agent** |
| `C` / `N` / `P` | new workspace · next · previous |
| `s` | profiles: switch, add, rename, delete |
| `d` / `R` / `Q` | detach · reload the TUI · quit everything |
| `?` | the full list, merged with your config |

Mouse works throughout: click a pane or tab to focus, drag the gap between
panes to resize, drop a file to type its path. Full table, plus the finders and
the sidebar: **[docs/guide.md](docs/guide.md)**.

## What you get

- **Per-pane tab strips.** Tabs live *inside* each pane, not above it — so a
  pane is one unit of work with everything that job needs behind it.
- **Agents found, not announced.** The daemon walks each pane's process tree, so
  a `claude` sitting idle at its prompt is listed the moment it starts — no
  hooks, no setup. The sidebar is an inbox: blocked first, then done, running,
  idle, across every workspace.
- **Status you can trust.** Explicit reports from Claude Code hooks
  (`gt hooks setup`) are authoritative; output heuristics are the fallback.
  `blocked` never comes from scraping spinner text.
- **Notifications that take you there.** Title, workspace, and the agent's own
  words; clicking one switches workspace, focuses the pane, selects the tab and
  raises the terminal.
- **Reload keeps your panes.** The PTYs belong to the daemon, so `prefix R`
  rebuilds the UI from source and every shell and agent survives — a reload
  costs a repaint. Crashes and reboots fall back to a layout snapshot.
- **Scriptable.** Everything the UI can do is a JSON message over a Unix
  socket, and the `gt` CLI is just a client — so agents can drive the mux they
  live in (`gt split -- claude`, `gt read-screen`, `gt notify`).
- **Config that applies on save.** Keybinds, themes, gaps — watched and merged
  live, no restart.

## How it differs from what's out there

**vs. tmux / Zellij.** They're general-purpose and agent-blind: a pane shows you
text, not state, so *you* are the dashboard. ghosttown adds the agent model —
per-tab status, the agent inbox, notifications — and keeps the tmux muscle
memory. It is not yet a tmux replacement for everything: scrollback view and
search are phase 2, and there's no session sharing.

**vs. cmux, Muxy, agterm, Zentty** (native macOS apps). Same layout ideas, but
they're GUIs you install and live inside. ghosttown runs in the terminal you
already have, over SSH, and detaches like tmux.

**vs. herdr.** The closest thing in spirit — terminal-native, Rust, socket API.
The difference is the hierarchy: herdr is workspaces → tabs → panes (a tab
contains panes); ghosttown is profile → workspaces → panes → tabs, so each pane
carries its own tab strip.

**vs. claude-squad / workmux.** Those orchestrate agents across git worktrees on
top of tmux — you get isolation, not a layout. ghosttown *is* the mux
(worktree-per-agent is on the roadmap).

**vs. openmux.** Same stack (Bun + OpenTUI + libghostty-vt), and proof it ships;
openmux is a general-purpose mux with master-stack tiling and no agent model.

## Similar projects

- [herdr](https://github.com/ogulcancelik/herdr) — agent multiplexer in the terminal (Rust)
- [cmux](https://github.com/manaflow-ai/cmux) — Ghostty-based macOS terminal with vertical tabs for agents
- [claude-squad](https://github.com/smtg-ai/claude-squad) — manages agents in isolated git worktrees over tmux
- [openmux](https://github.com/monotykamary/openmux) — Bun + libghostty-vt mux, master-stack layout
- [tuidoscope](https://github.com/shuv1337/tuidoscope) · [vanish](https://github.com/psyclyx/vanish) · [ykmx](https://github.com/Yukaii/ykmx) — other libghostty-vt muxes

More of the ecosystem: [**awesome-libghostty**](https://github.com/Uzaaft/awesome-libghostty).

## Development

```sh
bun run dev        # live reload: the TUI restarts on save, panes keep running
bun test           # unit tests (layout, VT queries, status engine, pty host)
bun run harness    # headless end-to-end: drives the real TUI in a PTY
bun run typecheck
```

Stack: Bun · `@opentui/core` + `@opentui/solid` (native Zig renderer, Solid
runtime JSX) · libghostty-vt via `ghostty-opentui` · `bun-pty` · newline-JSON
over Unix sockets.

## Docs

- **[docs/guide.md](docs/guide.md)** — every key, config option, `gt` command,
  and how profiles, snapshots, notifications and the sidebar work
- **[PLAN.md](PLAN.md)** — architecture, design principles, roadmap
- **[config.default.toml](config.default.toml)** — the shipped defaults, documented inline

MIT.
