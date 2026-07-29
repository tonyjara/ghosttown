# ghosttown 👻

**Agent-first terminal multiplexer.** Like tmux, but every pane has its own
tab strip (cmux-style "surfaces"), every tab shows whether its agent is
idle / working / blocked / done, and you get a desktop notification the moment
an agent finishes or needs you.

The mental model: **a pane is an agent's slot.** The agent CLI, a shell in the
same directory, the dev server — they're tabs behind one pane. Your screen
layout maps to "which agents am I running", not "which windows are open".

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
bun run start                 # start the mux (session "main")
bun start -- --session work  # a second session
bun link                      # optional: global `gt` command
```

Requires Bun ≥ 1.2 on macOS or Linux. All native pieces (PTY, terminal
emulation, renderer) ship prebuilt — no toolchain needed.

## Keys (prefix `Ctrl+A`, tmux-style)

| Key | Action |
|---|---|
| `\|` or `\` | split right |
| `-` | split down |
| `h j k l` / arrows | focus pane by direction |
| `c` | new tab in the focused pane |
| `n` / `p` | next / previous tab |
| `1`–`9` | select tab N |
| `x` | close tab (pane closes with its last tab) |
| `q` | quit |
| `?` | floating help pane with the effective keybinds |
| `Ctrl+A` again | send a literal Ctrl+A |

Mouse: click a pane to focus it, click a tab to select it.

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

```toml
# ~/.config/ghosttown/config.toml
[keybinds]
prefix = "ctrl+g"
"new-tab" = ["t"]     # replaces the default list for that action

[notifications]
sound = "Ping"
```

`prefix ?` shows the *merged* keybinds, so the help pane always matches
what your keys actually do.

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
bun test                # unit tests (layout, VT queries, status engine)
bun run harness         # headless end-to-end: drives the real TUI in a PTY
bun run typecheck
GHOSTTOWN_DEBUG_LOG=/tmp/gt.log bun run start   # capture errors/tracing
```

See `PLAN.md` for architecture, design principles, and the roadmap
(phase 2: daemon split + detach/reattach, scrollback, worktree-per-agent).
