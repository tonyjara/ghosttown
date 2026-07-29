# ghosttown 👻

**Agent-first terminal multiplexer.** Like tmux, but every pane has its own
tab strip (cmux-style "surfaces"), every tab shows whether its agent is
idle / working / blocked / done, and you get a desktop notification the moment
an agent finishes or needs you.

The mental model: **a pane is an agent's slot.** The agent CLI, a shell in the
same directory, the dev server — they're tabs behind one pane. Your screen
layout maps to "which agents am I running", not "which windows are open".

The hierarchy: **profile → workspaces → panes → tabs.** A profile (the
session) holds any number of workspaces; each workspace is its own pane
layout, switched instantly with everything kept alive. The left sidebar shows
the profile's workspaces on top and every active agent below (most recently
done first).

```
┌ 1:claude ✳  2:zsh  + ──────────┬ 1:claude ⚑ ●  2:lazygit  + ────┐
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
bun run start                 # start the mux (session "main"), or reattach
bun start -- --session work  # a second session
bun link                      # optional: global `gt` command
```

Sessions run in a background daemon: plain `gt` starts one, `prefix d`
detaches (everything keeps running), running `gt` again reattaches with the
screen intact. `GHOSTTOWN_NO_DAEMON=1` runs the TUI directly in the terminal
(no detach) for debugging.

Requires Bun ≥ 1.2 on macOS or Linux. All native pieces (PTY, terminal
emulation, renderer) ship prebuilt — no toolchain needed.

## Keys (prefix `Ctrl+A`, tmux-style)

| Key | Action |
|---|---|
| `\|` or `\` | split right |
| `-` | split down |
| `h j k l` / arrows | focus pane by direction |
| `r` | **resize mode** — `h j k l`/arrows move the divider, `esc` leaves |
| `T` (shift+t) | new tab in the focused pane |
| `n` / `p` | next / previous tab |
| `1`–`9` | select tab N |
| `D` (shift+d) | close tab — with its last tab, the pane closes too |
| `C` (shift+c) | **new workspace** (its terminal takes focus) |
| `X` (shift+x) | **delete workspace** (confirm dialog) |
| `b` | toggle the sidebar |
| `s` | **switch profile** — pick another running session |
| `S` (shift+s) | **new profile** — name a fresh session and jump there |
| `d` | detach — the session keeps running in the background |
| `R` (shift+r) | reload the TUI from source (dev loop; panes keep running) |
| `Q` (shift+q) | kill ghosttown and everything inside it |
| `?` | floating help pane with the effective keybinds |
| `Ctrl+A` again | send a literal Ctrl+A |

Mouse: click a pane to focus it, click a tab to select it, click a sidebar
row to move focus into the sidebar on that row (opening the workspace /
revealing the agent), **drag the gap between panes to resize them**.

Profiles are sessions: switching jumps this terminal to another session's
daemon (starting it if needed) while the current one keeps running detached —
`gt --session <name>` reattaches to any of them later.

### Reload keeps your panes

The surface PTYs belong to the background daemon, not to the TUI. So the TUI is
disposable: `prefix R` restarts it from the current source and every shell and
agent keeps running — the new instance adopts them by id and rebuilds its
emulators from the daemon's replay buffers (last 512 KB of output per surface,
`$GHOSTTOWN_REPLAY_BYTES` to change). What a reload costs is a repaint.

Detaching is the same story from the other side: the session is still running,
you just stopped looking at it.

### Session snapshots

A crash or a reboot does take the panes with it. For those, ghosttown keeps a
snapshot of the *structure* in
`~/.local/state/ghosttown/<session>.session.json`, written whenever the layout
changes and every 30s after that. On the next *cold* start it rebuilds
workspaces, split ratios, panes, tab order, and drops each surface back in the
directory it was in. Programs are **not** restarted — a restored surface is a
fresh shell, so a `claude` tab comes back as a prompt in the right repo.

`prefix Q` (and `gt kill`) deletes the snapshot: quitting is a decision, so
the next start is clean. Turn the whole thing off with `restore_session =
false` under `[general]` — reload still adopts live panes either way, since
nothing needs restoring there.

### Sidebar

`prefix h` from the leftmost pane moves focus into the sidebar (it behaves
like a pane), and so does clicking it; `prefix l` or `esc` returns to the
panes. While the sidebar is focused, keys are direct — no prefix:

| Key | Action |
|---|---|
| `j` / `k` | move down / up (flows between the two halves) |
| `enter` | open the workspace / jump to the agent |
| `a` | new workspace (focus follows into its terminal) |
| `r` | rename workspace |
| `d` | delete workspace (confirm dialog) / kill the agent |

## Configuration

Defaults live in [`config.default.toml`](config.default.toml) (documented
inline). The user config is **not** created automatically — copy the defaults
over once and edit from there:

```sh
mkdir -p ~/.config/ghosttown && cp config.default.toml ~/.config/ghosttown/config.toml
```

Your file always wins over the shipped defaults. It only *needs* the values
you change — trimming it to just those lets future default changes flow
through. `$GHOSTTOWN_CONFIG` points at an alternate file, `$XDG_CONFIG_HOME`
is respected.

**Saving applies it.** The file is watched: keybinds, theme, gaps and sidebar
width take effect on write, with no reload and no interruption to anything
running in a pane.

```toml
# ~/.config/ghosttown/config.toml
[appearance]
theme = "catppuccin-mocha"   # or: ghosttown, catppuccin-latte, tokyonight,
                             #     gruvbox, nord, dracula
pane_gap = 1                 # cells between panes (they double as drag handles)
cursor_blink = true

[theme]                      # optional per-color overrides on the theme
accent = "#f5c2e7"

[keybinds]
prefix = "ctrl+g"
"new-tab" = ["t"]     # replaces the default list for that action

[notifications]
sound = "Ping"
```

`prefix ?` shows the *merged* keybinds, so the help pane always matches
what your keys actually do.

### Sidebar agents

Any surface that ever worked (or ever reported via `gt report`) stays in the
sidebar's agents list — `✳ running`, `⚑ blocked`, `✓ done`, and `○ idle`
between runs — most recently active first, so finished agents remain one
`enter` away.

## Agent status

Tabs carry a live status glyph: `✳` working · `⚑` blocked · `✓` done ·
`●` unread. Two detection tiers:

1. **Hooks (authoritative).** `gt hooks setup` wires Claude Code so
   prompts/tool-use report *working*, Stop reports *done*, and permission
   prompts report *blocked* — via `gt report` over the control socket.
2. **Heuristic (fallback).** For anything without hooks: sustained output →
   working; several seconds of work followed by quiet → done.

Done/blocked in a non-visible tab → unread badge + macOS notification
(disable with `GHOSTTOWN_NO_NOTIFY=1`).

## The `gt` CLI

Every surface gets `GHOSTTOWN_SOCKET`, `GHOSTTOWN_PANE_ID`, and
`GHOSTTOWN_SURFACE_ID` in its environment, so agents can drive the mux
they live in:

```sh
gt list                          # panes, tabs, statuses
gt split -d right -- claude      # new pane running claude
gt new-tab -- lazygit            # new tab in the focused pane
gt send-text 'bun test\r'        # type into a surface
gt read-screen                   # what's on a surface's screen
gt report done                   # set this surface's status
gt notify "deploy finished"      # desktop notification
```

## Development

```sh
bun run dev             # live reload: the TUI restarts on save, panes keep running
bun test                # unit tests (layout, VT queries, status engine, pty host)
bun run harness         # headless end-to-end: drives the real TUI in a PTY
bun run typecheck
GHOSTTOWN_DEBUG_LOG=/tmp/gt.log bun run start   # capture errors/tracing
```

`bun run dev` is `GHOSTTOWN_DEV=1`, which makes the daemon run the TUI under
`bun --watch`. Save a file and the UI comes back a moment later with your
change; the shells and agents in the panes are untouched, because they are the
daemon's. A save that doesn't compile just leaves the UI down until the next
one — the session (and everything running in it) survives.

See `PLAN.md` for architecture, design principles, and the roadmap
(phase 2: scrollback view + search, worktree-per-agent).
