# ghosttown — user guide

The full reference. The [README](../README.md) is the short version; this is
everything else. Architecture and roadmap live in [PLAN.md](../PLAN.md).

- [Keys](#keys)
- [Mouse, paste and drag-and-drop](#mouse-paste-and-drag-and-drop)
- [Workspaces and finders](#workspaces-and-finders)
- [Sidebar](#sidebar)
- [Profiles](#profiles)
- [Reload keeps your panes](#reload-keeps-your-panes)
- [Session snapshots](#session-snapshots)
- [Agent status](#agent-status)
- [Notifications](#notifications)
- [Configuration](#configuration)
- [The `gt` CLI](#the-gt-cli)
- [Development](#development)

## Keys

Prefix is `Ctrl+A`, tmux-style. `prefix ?` shows the *merged* keybinds, so the
help pane always matches what your keys actually do.

| Key | Action |
|---|---|
| `\|` or `\` | split right |
| `-` | split down |
| `h j k l` / arrows | focus pane by direction |
| `r` | **arrange mode** — `h j k l`/arrows move the divider, `H`/`L` move the focused tab along its strip, `esc` leaves |
| `T` (shift+t) | new tab in the focused pane |
| `n` / `p` | next / previous tab |
| `1`–`9` | select tab N |
| `D` (shift+d) | close tab — with its last tab, the pane closes too |
| `,` | rename this tab (sticks; empty restores the program's title) |
| `w` | **find workspace** — fuzzy switcher with an input |
| `N` / `P` (shift+n / shift+p) | next / previous workspace (wraps) |
| `z` | back to the **last workspace** you were in (press again to return) |
| `C` (shift+c) | **new workspace** (its terminal takes focus) |
| `W` (shift+w) | **rename workspace** |
| `X` (shift+x) | **delete workspace** (confirm dialog) |
| `a` | **find agent** — fuzzy jump to any agent in this profile |
| `b` | toggle the sidebar |
| `s` | **profiles** — switch, and manage them with `a` / `r` / `d` |
| `S` (shift+s) | **new profile** — name a fresh session and jump there |
| `d` | detach — the session keeps running in the background |
| `R` (shift+r) | reload the TUI from source (dev loop; panes keep running) |
| `Q` (shift+q) | kill ghosttown and everything inside it |
| `?` | floating help pane with the effective keybinds |
| `Ctrl+A` again | send a literal Ctrl+A |

Anything new — a split, a tab, a workspace — opens in the directory of the tab
you were on, read live from that shell (so a `cd` counts). Same for `gt split`
and `gt new-tab`. When that directory is gone, it falls back to where the
session was started.

Tab names come from the program (OSC 0/2) until you set one with `prefix ,`.
A name you typed wins from then on, and it lasts: the pty host holds it, so it
survives a reload, and it goes in the session snapshot. Save an empty name to
hand the label back to the program.

## Mouse, paste and drag-and-drop

Click a pane to focus it, click a tab to select it, click the `×` at a tab's
right end to close it (double-click the strip's `+` to open one), click a
sidebar row to move focus into the sidebar on that row (opening the workspace /
revealing the agent) or the `[-]` at its end to hide that agent from the list
(`[+n]` in the `AGENTS` header brings them back), **drag the divider between
panes to resize them** — the gap is drawn as a seam and lights up under the
pointer. It stays a drag even
when it crosses a pane whose program owns the mouse.

**Drag a tab along its strip to sort it.** Press it and move: the tab is
highlighted while you hold it and the strip reorders as you go, so what you see
before letting go is what you get. It displaces a neighbour once you pass that
neighbour's middle, and parks at the end rather than wrapping if you overshoot.
Only the column matters — the pointer wandering off the one-row strip does not
drop the tab. Keyboard equivalent: `prefix r` then `H`/`L`. The order is part of
the session snapshot, so it survives a reload.

Paste and drag-and-drop go to the focused pane: dropping a file on the window
types its path into whatever is running there (that is a bracketed paste, which
is how your terminal delivers a drop), and it is bracketed on the way to the
program only if that program asked for `?2004`.

## Copying

**Select text in an agent pane and it is on your clipboard when you let go.**
There is nothing to press afterwards — and nothing that *could* be: ⌘C belongs to
the terminal ghosttown runs in, which has no idea a selection inside a pane
exists. The copy leaves through OSC 52 instead, the same escape sequence tmux
relays with `set-clipboard on`, so it works over ssh and needs no helper binary.
Ghostty allows clipboard writes by default (`clipboard-write = allow`); a
terminal set to `deny` will drop them.

Two things happen depending on what the agent does with the mouse:

| The agent | Selecting | Copying |
| --- | --- | --- |
| asks for the mouse (`?1000`/`?1002`/`?1003`) — claude | the agent's own selection, drawn by the agent | the agent emits OSC 52 itself; ghosttown relays it out |
| never asks — codex | ghosttown's selection, drawn by the pane | ghosttown copies it when the drag ends |

**This is scoped to agent panes** — the same list that puts a tab in the sidebar,
`[agents] commands` (claude, codex, gemini, aider, … — see the config). A pane
running a shell, neovim, a pager or anything else behaves exactly as it did
before: selection still highlights, and nothing reaches your clipboard unless
that program's own copy path does it. Editors have their own ideas about the
mouse and their own clipboard integration, and a mux that intercepts either one
gets in the way.

Clipboard *reads* (`OSC 52` with `?`) are never relayed, from any pane: the
answer would arrive on ghosttown's stdin, indistinguishable from you typing your
clipboard into the focused pane.

If you want a selection outside an agent pane, hold **shift** while dragging —
that bypasses ghosttown entirely and gives you your terminal's own selection,
where ⌘C works as usual (Ghostty's `mouse-shift-capture = false` default).

## Workspaces and finders

A profile (the session) holds any number of workspaces; each workspace is its
own pane layout, switched instantly with everything kept alive.

`prefix w` and `prefix a` open a telescope-style picker over this profile's
workspaces and its agents: type to fuzzy-filter (whitespace separates terms,
so `api srv` works), `↑`/`↓` or `Ctrl+N`/`Ctrl+P` move, `Ctrl+U` clears the
query, `enter` jumps, `esc` cancels. Clicking a row takes it. The workspace
finder opens on the workspace you are in — so `enter` right away is a no-op —
and the agent finder lists the same agents as the sidebar, marked with their
status and workspace, jumping to the pane and tab that holds the one you pick.
It matches on more than the tab name: `w frontend` finds the agents in your
FrontendV2 workspace, `codex` finds the codex ones whatever their tabs are
called.

## Sidebar

The left sidebar shows the profile's workspaces on top and, below them, every
agent running anywhere in the profile.

`prefix h` from the leftmost pane moves focus into the sidebar (it behaves
like a pane), and so does clicking it; `prefix l` or `esc` returns to the
panes. While the sidebar is focused, keys are direct — no prefix:

| Key | Action |
|---|---|
| `j` / `k` | move down / up (flows between the two halves) |
| `J` / `K` (shift+j / shift+k) | **reorder** — drag the selected workspace *or agent* down / up |
| `enter` | open the workspace / jump to the agent |
| `a` | new workspace (focus follows into its terminal) |
| `r` | rename the workspace / the selected agent's tab |
| `d` | delete workspace (confirm dialog) / kill the agent |
| `h` / `u` | hide the selected agent from the list / unhide all of them |

### Sidebar agents

The bottom half lists **every agent in the profile, in every workspace** —
`⚑ blocked`, `✓ done`, `✳ running`, `○ idle`, tagged with the workspace it lives
in. It gets all the room the workspace list above it does not need, and the
header tallies what scrolled out of view. `enter` (or a click) jumps straight to
one, switching workspace on the way.

Each agent takes **two lines**: who it is, then what it is working on — the tab's
own title, which for a real agent is the turn it is in the middle of
(`Merge twonary_mercado changes`). The agent's own spinner is stripped off the
front of it: our status glyph already says that, and better.

```
 AGENTS (3)              ⚑1 ✳1 [+1]
▌✳•claude          Ghosttown      [-]
   Add thinking indicator to agents s…
 ✓•claude          T-Runner       [-]
   Test OOS cancel sequence with Esqu…
```

A **running** agent's glyph pulses — `✢ ✳ ✶ ✻ ✽` and back down — so "still
thinking" reads off the row without having to remember what it said a second
ago; a still glyph and a hung agent look the same. It is the only thing in the
UI that animates, and the clock only runs while something is working, so an
idle sidebar costs nothing.

**Rows hold still.** The order is where the agent *is* — workspace order, then
pane, then tab — so the list you learned is the list you keep. It deliberately
does not rank itself by status: acting on a row is what changes its status, so a
self-sorting list moves the row you just clicked out from under the pointer.
`shift+J` / `shift+K` drags a row where you want it, the same keys the
workspaces use, and that arrangement survives a `prefix R` reload. New agents
join at the end.

**Hiding a row** (`[-]` at its end, or `h`) declutters the list without touching
the agent: it keeps running, keeps its slot for when it comes back, keeps
counting in the header's `AGENTS (n)` and its tally, and `prefix a` still finds
it — it just stops taking up two rows of a sidebar you are trying to read at a
glance. The header says how many are hidden and takes them all back: `[+2]`, or
`u`. Hides survive a `prefix R` reload, like the order does.

The agent **you are in** is marked like the workspace you are in, but out of the
way of its status: a `▌` bar down the left of the row and a dimmer highlight
behind it, leaving the glyph and its color to say how it is doing. It stays
marked while you browse the sidebar — you are still in that agent — and the
cursor's own highlight wins the row it is on. The agent finder (`prefix a`)
marks its rows the same way.

An agent is found by looking for it, not by waiting for it to say something: the
session daemon walks each pane's process tree every couple of seconds. So a
`claude` sitting at its prompt with nothing to print is listed the moment it
starts, in every workspace, with no hooks and no setup — see `[agents]` in
[`config.default.toml`](../config.default.toml) for the command list, the
interval, and how to add your own. The list is present tense, for the same
reason: quit the agent and its tab leaves the list within one poll instead of
sitting there as a shell named after its directory. `[agents] keep_exited =
true` keeps them listed (dimmed, `·`) if you would rather the finished
conversation stayed one `enter` away.

## Profiles

Profiles are sessions: switching jumps this terminal to another session's
daemon (starting it if needed) while the current one keeps running detached —
`gt --session <name>` reattaches to any of them later.

`prefix s` is also where profiles are managed, on the same keys as the sidebar:

- **`a`** — new profile: name it and jump there (same as `prefix S`).
- **`r`** — rename the selected profile, running or not, *in place*: its daemon
  moves its sockets and its session snapshot to the new name and nothing in the
  panes is disturbed. `gt --session <new name>` works from then on; shells that
  were already open keep reaching the session under the old name too.
- **`d`** — delete the selected profile after a confirm: every surface in it
  dies, its sockets go, and its layout is retired to the archive (`gt restore`
  brings it back). Doing this to the profile you are in moves this client to
  another one first; if it is the only profile left, that is a quit.

The list also includes profiles that are **not running**, marked `saved` — the
ones with a layout on disk and no daemon, which is what every profile looks like
after a reboot. Picking one starts it and restores its workspaces.

## Reload keeps your panes

The surface PTYs belong to the background daemon, not to the TUI. So the TUI is
disposable: `prefix R` restarts it from the current source and every shell and
agent keeps running — the new instance adopts them by id and rebuilds its
emulators from the daemon's replay buffers (last 512 KB of output per surface,
`$GHOSTTOWN_REPLAY_BYTES` to change). What a reload costs is a repaint.

Detaching is the same story from the other side: the session is still running,
you just stopped looking at it.

## Closing a tab ends what was in it

Closing a tab (`prefix D`, or the `×` on the tab) hangs its program up — the same
SIGHUP a real terminal sends when its window goes away — and it goes to the whole
process group, so the shell, the agent inside it and whatever that agent spawned
all leave together. Nothing keeps running behind a tab you can no longer see.

A program that ignores hangups doesn't get to stay: 1.5s later it gets SIGTERM,
and 4s after the close, SIGKILL. The wait is for the agent that is mid-write when
you close its tab; the escalation is for the graceful-shutdown handler that never
gets around to exiting, which would otherwise hold its memory (and its children's)
until you reboot. `prefix Q` and a profile kill sweep the same way, just as the
daemon goes. The one thing that *does* outlive the TUI is a detached session —
that one is on purpose, and `gt profiles` is where you find it again.

## Session snapshots

A crash or a reboot does take the panes with it. For those, ghosttown keeps a
snapshot of the *structure* in
`~/.local/state/ghosttown/<session>.session.json`, written whenever the layout
changes and every 30s after that. On the next *cold* start it rebuilds
workspaces, split ratios, panes, tab order, and drops each surface back in the
directory it was in. Programs are **not** restarted — a restored surface is a
fresh shell, so a `claude` tab comes back as a prompt in the right repo.

**Ending a session never throws its layout away.** `prefix Q`, a profile kill, a
SIGTERM, the machine rebooting: the daemon's last act is to write the snapshot,
and `gt --session <name>` opens the same arrangement again. Arranging workspaces
is work, and stopping the processes is not a request to undo it.

The two places a layout is retired both move the file to
`~/.local/state/ghosttown/archive/` instead of deleting it — deleting a profile
(`prefix s`, then `d`), and a write that would shrink a layout, which is what a
session that started fresh over an unreadable snapshot does. The last 20 per
profile are kept:

```sh
gt profiles          # every profile: running, or saved and openable
gt profiles -a       # what is in the archive
gt restore <name>    # put its newest archived layout back
```

Turn snapshots off entirely with `restore_session = false` under `[general]` —
reload still adopts live panes either way, since nothing needs restoring there.

## Agent status

Tabs carry a live status glyph: `✳` working · `⚑` blocked · `✓` done ·
`●` unread.

**Which tabs are agents** is answered by process detection: the daemon looks for
a known agent command running in each pane (`[agents] commands`), so presence
never depends on activity — an idle agent is still an agent, and a tab the agent
has left is not. Failing that, a surface that reports via `gt report` counts too
(and stays counted: nothing there can tell us the agent left).

**What an agent is doing** has two tiers:

1. **Hooks (authoritative).** `gt hooks setup` wires Claude Code so
   prompts/tool-use report *working*, Stop reports *done*, and permission
   prompts report *blocked* — via `gt report` over the control socket.
2. **Heuristic (fallback).** For anything without hooks: sustained output →
   working; work followed by quiet → done.

Done/blocked in a non-visible tab → unread badge, and a desktop notification if
the tab is an agent (disable with `GHOSTTOWN_NO_NOTIFY=1`).

## Notifications

A notification tells you **which agent, where, and what it wants** — and
clicking it takes you there:

```
┌──────────────────────────────────────────────┐
│ claude needs input                           │  the agent + what changed
│ ghosttown · rewriting the notifier           │  workspace · the tab's own title
│ Claude needs your permission to run git push │  its own words
└──────────────────────────────────────────────┘
        ↓ click
   workspace switched, pane focused, tab selected, terminal raised
```

The body is the agent's own account of what happened, in order of preference:
the message from Claude Code's `Notification` hook (which is the actual
permission prompt), the program's own `OSC 9` notification text, or the last
meaningful line of its screen — input boxes, hint bars and shell prompts are
skipped.

**Only agents notify.** The status behind a notification is derived — from hooks,
or from output going quiet — and quiet means different things in different tabs:
in an agent a turn ended, in a shell a build compiled or a dev server finished
serving a request. So the filter is the same "which tabs are agents" above, and a
`pnpm dev` in a background workspace stays silent no matter how it churns. If you
run an agent under a command name detection does not know, `[agents]
include_busy = true` puts busy tabs back in the list, notifications included.
A program that asks for a notification *by name* is never filtered: its own
`OSC 9`/`OSC 777` and `gt notify "deploy finished"` always go out.

**Click-to-focus needs `terminal-notifier`** (`brew install terminal-notifier`):
macOS's built-in `osascript` notifications cannot carry a click action, so
without it notifications still arrive, just with nothing to click. The click
runs `gt focus` on the session's control socket, which is a normal command —
`gt focus --surface s3` does the same thing from anywhere, and any agent can
send a notification for its own tab with `gt notify "waiting on you"`.

See `[notifications]` in [`config.default.toml`](../config.default.toml) for the
sound, the app a click raises (`terminal_app`, for when you reattach from a
different terminal), and `command`, which replaces the notifier entirely —
that's the Linux path:

```toml
[notifications]
command = "notify-send {title} {body}"   # {subtitle} {surface} {socket} {focus}
```

## Configuration

Defaults live in [`config.default.toml`](../config.default.toml) (documented
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
theme = "tokyonight"         # default catppuccin-mocha; also catppuccin-latte,
                             # ghosttown, gruvbox, nord, dracula
pane_gap = 1                 # cells between panes (the divider you drag to resize)
cursor_blink = true

[theme]                      # optional per-color overrides on the theme
accent = "#f5c2e7"

[keybinds]
prefix = "ctrl+g"
"new-tab" = ["t"]     # replaces the default list for that action

[notifications]
sound = "Ping"
click_focus = true           # click a notification → jump to that agent's tab
```

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
gt notify "deploy finished"      # desktop notification, from this tab
gt focus --surface s3            # jump to a tab: workspace, pane and tab
```

Two of them need no session at all — they read the state dir, which is the point:
they are what you reach for when nothing is running.

```sh
gt profiles                      # every profile, running or saved, + its layout
gt profiles -a                   # retired layouts, newest first
gt restore <profile>             # put a retired layout back, then gt --session <profile>
```

## Development

```sh
bun run dev             # live reload: the TUI restarts on save, panes keep running
bun test                # unit tests (layout, VT queries, status engine, pty host)
bun run harness         # headless end-to-end: drives the real TUI in a PTY
bun run typecheck
GHOSTTOWN_DEBUG_LOG=/tmp/gt.log bun run start   # capture errors/tracing
```

The sockets of every profile live in `/tmp/ghosttown-<uid>`, and the profile list
is that directory plus the saved snapshots in the state dir — `/tmp` is wiped on
reboot, so sockets alone would lose track of every profile that is not running.
`GHOSTTOWN_SOCKET_DIR` moves the whole set elsewhere, and with
`GHOSTTOWN_STATE_DIR` (snapshots) that is what keeps the harness — and the unit
tests, which also *send* to whatever answers — from listing, renaming or killing
the sessions you are working in.

`bun run dev` is `GHOSTTOWN_DEV=1`, which makes the daemon run the TUI under
`bun --watch`. Save a file and the UI comes back a moment later with your
change; the shells and agents in the panes are untouched, because they are the
daemon's. A save that doesn't compile just leaves the UI down until the next
one — the session (and everything running in it) survives.

`GHOSTTOWN_NO_DAEMON=1` runs the TUI directly in the terminal (no detach) for
debugging.
