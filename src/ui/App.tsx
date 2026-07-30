import { For, Index, Show, createEffect, createMemo, createSignal } from "solid-js";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import type { KeyEvent } from "@opentui/core";
import {
  ACTIONS,
  keysForAction,
  loadConfig,
  normalizeKeySpec,
  parseChord,
  type Action,
} from "../core/config";
import {
  activeGutters,
  allRects,
  blurSidebar,
  closeActiveTab,
  createWorkspace,
  cycleTab,
  cycleWorkspace,
  deleteWorkspace,
  dialogBackspace,
  dialogCancel,
  detachClients,
  dialogChar,
  dialogClear,
  dialogConfirm,
  dialogMove,
  dragDivider,
  endDividerDrag,
  focusDirection,
  focusedPaneId,
  isFinderDialog,
  newTab,
  openDeleteProfile,
  openDeleteWorkspace,
  openFindAgent,
  openFindWorkspace,
  openNewProfile,
  openRenameProfile,
  openRenameTab,
  openRenameWorkspace,
  openSwitchProfile,
  pasteToFocused,
  quit,
  reloadApp,
  resizeFocused,
  selectTab,
  setArea,
  setHelpVisible,
  setPrefixArmed,
  setResizeMode,
  sidebarCreate,
  sidebarDelete,
  sidebarEnter,
  sidebarMove,
  sidebarRename,
  splitPane,
  startDividerDrag,
  store,
  toggleSidebar,
  workspaceOf,
  writeToFocused,
} from "../core/state";
import { dbg } from "../core/debug";
import { DialogOverlay } from "./Dialogs";
import { HelpOverlay } from "./HelpOverlay";
import { PaneView } from "./PaneView";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { theme } from "./theme";

const PREFIX_TIMEOUT_MS = 3000;

function runAction(action: Action): void {
  const focused = focusedPaneId();
  switch (action) {
    case "split-right":
      splitPane(focused, "row");
      return;
    case "split-down":
      splitPane(focused, "column");
      return;
    case "new-tab":
      newTab(focused);
      return;
    case "next-tab":
      cycleTab(focused, 1);
      return;
    case "prev-tab":
      cycleTab(focused, -1);
      return;
    case "close-tab":
      closeActiveTab();
      return;
    case "rename-tab":
      openRenameTab();
      return;
    case "focus-left":
      focusDirection("left");
      return;
    case "focus-right":
      focusDirection("right");
      return;
    case "focus-up":
      focusDirection("up");
      return;
    case "focus-down":
      focusDirection("down");
      return;
    case "toggle-sidebar":
      toggleSidebar();
      return;
    case "resize-mode":
      setResizeMode(true);
      return;
    case "switch-profile":
      openSwitchProfile();
      return;
    case "new-profile":
      openNewProfile();
      return;
    case "new-workspace":
      createWorkspace();
      return;
    case "next-workspace":
      cycleWorkspace(1);
      return;
    case "prev-workspace":
      cycleWorkspace(-1);
      return;
    case "rename-workspace":
      openRenameWorkspace();
      return;
    case "find-workspace":
      openFindWorkspace();
      return;
    case "find-agent":
      openFindAgent();
      return;
    case "delete-workspace":
      openDeleteWorkspace();
      return;
    case "detach":
      detachClients();
      return;
    case "reload":
      reloadApp();
      return;
    case "quit":
      quit();
      return;
    case "help":
      setHelpVisible(!store.helpVisible);
      return;
  }
}

const isEnter = (key: KeyEvent) =>
  key.name === "return" || key.name === "enter" || key.sequence === "\r";

function handleDialogKey(key: KeyEvent): void {
  const dialog = store.dialog;
  if (!dialog) return;
  if (key.name === "escape") {
    dialogCancel();
    return;
  }
  if (isEnter(key)) {
    dialogConfirm();
    return;
  }
  if (dialog.kind === "confirm-delete-workspace" || dialog.kind === "confirm-delete-profile") {
    if (key.name === "y") dialogConfirm();
    else if (key.name === "n" || key.name === "q") dialogCancel();
    return;
  }
  // The switcher is also where profiles are managed, on the same a/r/d as the
  // sidebar: no query to type here, so the letters are free.
  if (dialog.kind === "switch-profile") {
    if (key.name === "j" || key.name === "down") dialogMove(1);
    else if (key.name === "k" || key.name === "up") dialogMove(-1);
    else if (key.name === "a") openNewProfile(true);
    else if (key.name === "r") openRenameProfile();
    else if (key.name === "d") openDeleteProfile();
    return;
  }
  // Finders are an input plus a list, so j/k are letters: the selection moves
  // with the arrows or ctrl+n/ctrl+p, the way telescope and fzf do it.
  if (isFinderDialog(dialog)) {
    if (key.name === "down" || (key.ctrl && key.name === "n")) {
      dialogMove(1);
      return;
    }
    if (key.name === "up" || (key.ctrl && key.name === "p")) {
      dialogMove(-1);
      return;
    }
  }
  if (key.ctrl && key.name === "u") {
    dialogClear();
    return;
  }
  // Text dialogs (rename-workspace, rename-tab, new-profile, rename-profile)
  // and the finder query: plain editing.
  if (key.name === "backspace" || key.sequence === "\x7f") {
    dialogBackspace();
    return;
  }
  const ch = key.sequence ?? "";
  if (ch.length === 1 && ch >= " " && ch !== "\x7f" && !key.ctrl && !key.meta) {
    dialogChar(ch);
  }
}

/** Keys while resize mode is active: h/j/k/l move dividers, esc/enter leave. */
function handleResizeModeKey(key: KeyEvent): void {
  switch (key.name) {
    case "h":
    case "left":
      resizeFocused("left");
      return;
    case "l":
    case "right":
      resizeFocused("right");
      return;
    case "j":
    case "down":
      resizeFocused("down");
      return;
    case "k":
    case "up":
      resizeFocused("up");
      return;
    case "escape":
    case "q":
      setResizeMode(false);
      return;
  }
  if (isEnter(key)) setResizeMode(false);
  // Everything else is swallowed — it's a mode.
}

/** Direct (un-prefixed) keys while the sidebar has focus. */
function handleSidebarKey(key: KeyEvent): void {
  switch (key.name) {
    case "j":
    case "down":
      sidebarMove(1);
      return;
    case "k":
    case "up":
      sidebarMove(-1);
      return;
    case "a":
      sidebarCreate();
      return;
    case "r":
      sidebarRename();
      return;
    case "d":
      sidebarDelete();
      return;
    case "escape":
      blurSidebar();
      return;
  }
  if (isEnter(key)) sidebarEnter();
}

export function App() {
  const config = loadConfig();
  const prefixChord = parseChord(config.keybinds.prefix);
  // key string ("h", "left", "|", "C") → action, from the merged config.
  const actionByKey = new Map<string, Action>();
  for (const action of ACTIONS) {
    for (const key of keysForAction(config, action)) {
      actionByKey.set(normalizeKeySpec(key), action);
    }
  }

  /**
   * A shifted letter arrives as name "c" + shift, sequence "C". Match the
   * uppercase form *only* — falling back to the lowercase name would make
   * prefix+shift+C run whatever "c" is bound to.
   */
  const actionFor = (key: KeyEvent): Action | undefined => {
    if (key.shift && key.name?.length === 1) {
      return actionByKey.get(key.name.toUpperCase());
    }
    return actionByKey.get(key.sequence || key.name) ?? actionByKey.get(key.name);
  };

  const dims = useTerminalDimensions();
  createEffect(() => {
    const d = dims();
    setArea(d.width, d.height);
  });

  let prefixTimer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (prefixTimer) clearTimeout(prefixTimer);
    prefixTimer = null;
    setPrefixArmed(false);
  };
  const arm = () => {
    setPrefixArmed(true);
    if (prefixTimer) clearTimeout(prefixTimer);
    prefixTimer = setTimeout(disarm, PREFIX_TIMEOUT_MS);
  };

  const isPrefix = (key: KeyEvent) =>
    key.ctrl === prefixChord.ctrl &&
    (key.option || key.meta) === prefixChord.alt &&
    key.name === prefixChord.name;

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;

    // Dialogs are modal above everything.
    if (store.dialog) {
      handleDialogKey(key);
      return;
    }

    // Help overlay is modal: nothing reaches the pty while it's open.
    if (store.helpVisible) {
      if (isPrefix(key)) {
        arm();
        return;
      }
      if (store.prefixArmed) {
        disarm();
        if (actionFor(key) === "help") {
          setHelpVisible(false);
          return;
        }
      }
      if (key.name === "escape" || key.name === "q" || key.sequence === "?") {
        setHelpVisible(false);
      }
      return;
    }

    // Resize mode: modal over the ptys, but the prefix still works.
    if (store.resizeMode) {
      if (isPrefix(key)) {
        setResizeMode(false);
        arm();
        return;
      }
      handleResizeModeKey(key);
      return;
    }

    if (!store.prefixArmed) {
      if (isPrefix(key)) {
        arm();
        return;
      }
      if (store.sidebar.visible && store.sidebar.focused) {
        handleSidebarKey(key);
        return;
      }
      const bytes = key.raw || key.sequence;
      if (bytes) writeToFocused(bytes);
      return;
    }

    disarm();
    dbg("prefix cmd", { name: key.name, seq: key.sequence, ctrl: key.ctrl });

    if (isPrefix(key)) {
      // Prefix twice → send it literally (unless the sidebar eats keys).
      if (!store.sidebar.focused) writeToFocused(key.raw || key.sequence || "");
      return;
    }
    const action = actionFor(key);
    if (action) {
      runAction(action);
      return;
    }
    if (/^[1-9]$/.test(key.name)) {
      selectTab(focusedPaneId(), Number(key.name) - 1);
    }
  });

  // Pastes — and file drops, which every terminal delivers as one — arrive
  // here rather than as keys, because opentui enables ?2004 on the host and
  // parses the brackets out. A PasteEvent carries `bytes`, NOT text: reading a
  // `.text` that does not exist is how dropping a file onto a pane did nothing.
  usePaste((event) => {
    const text = new TextDecoder().decode(event.bytes);
    if (text && !store.dialog && !store.sidebar.focused && !store.resizeMode) {
      pasteToFocused(text);
    }
  });

  const rects = createMemo(() => {
    // Track screen, sidebar, and every workspace layout for structural changes.
    void store.screen.width;
    void store.screen.height;
    void store.sidebar.visible;
    for (const wsId of store.workspaceOrder) void store.workspaces[wsId]?.layout;
    return allRects();
  });

  // Divider drag: mousedown on a gutter starts a session (in the store, so the
  // panes know not to touch the mouse while it runs); the ROOT box sees every
  // drag/up event via bubbling. Opentui captures the renderable the pointer is
  // over on the FIRST drag event and dispatches the rest of the drag to it, so
  // the target is either a gutter or a pane — either way propagation reaches
  // the root, as long as the captured renderable stays alive (see <Index>).
  const [hoveredGutter, setHoveredGutter] = createSignal<string | null>(null);
  const gutters = createMemo(() => {
    void store.screen.width;
    void store.screen.height;
    void store.sidebar.visible;
    void store.workspaces[store.activeWorkspaceId]?.layout;
    return activeGutters().filter((g) => g.rect.width > 0 && g.rect.height > 0);
  });
  const onGutter = (x: number, y: number) =>
    gutters().some(
      (g) =>
        x >= g.rect.x &&
        x < g.rect.x + g.rect.width &&
        y >= g.rect.y &&
        y < g.rect.y + g.rect.height,
    );

  return (
    <box
      width="100%"
      height="100%"
      backgroundColor={theme.bg}
      onMouseDrag={(e: { x: number; y: number }) => dragDivider(e.x, e.y)}
      onMouseUp={endDividerDrag}
      onMouseDragEnd={endDividerDrag}
      onMouseDrop={endDividerDrag}
      // Insurance, and it matters more than it sounds: a drag whose release
      // never arrives — released outside the window, or the event was lost —
      // would go on swallowing the mouse in every pane, and scrolling inside
      // an agent would simply stop working until the next click. So anything
      // that cannot be part of a drag ends it: a wheel notch, buttonless
      // motion (nothing is held), or a press off the gutters (a press ON one
      // starts the next drag, below).
      onMouseScroll={endDividerDrag}
      onMouseMove={endDividerDrag}
      onMouseDown={(e: { x: number; y: number }) => {
        if (!onGutter(e.x, e.y)) endDividerDrag();
      }}
    >
      <For each={Object.keys(store.panes)}>
        {(paneId) => {
          const rect = () => rects().get(paneId);
          const inActiveWorkspace = createMemo(
            () => workspaceOf(paneId) === store.activeWorkspaceId,
          );
          return (
            <Show when={rect() && store.panes[paneId]}>
              <PaneView
                pane={store.panes[paneId]!}
                rect={rect()!}
                visible={inActiveWorkspace()}
                focused={
                  inActiveWorkspace() &&
                  paneId === focusedPaneId() &&
                  !store.sidebar.focused
                }
              />
            </Show>
          );
        }}
      </For>
      {/*
        Index, not For: the gutter list is rebuilt on every ratio change, and
        For (keyed by reference) would destroy and recreate these boxes mid-
        drag. Opentui had captured one of them, so the drag died after a single
        cell — which is exactly what a careful, one-cell-at-a-time drag does.
        Index reuses the renderables and only updates their props.
      */}
      <Index each={gutters()}>
        {(g) => (
          <box
            position="absolute"
            left={g().rect.x}
            top={g().rect.y}
            width={g().rect.width}
            height={g().rect.height}
            // The gap is the drag handle, so it has to look like one: a seam
            // at rest, lit on hover, accent while it is being dragged.
            backgroundColor={
              store.dividerDrag?.path === g().path
                ? theme.accent
                : hoveredGutter() === g().path
                  ? theme.sidebarSelBg
                  : theme.stripBg
            }
            onMouseDown={() => startDividerDrag(g())}
            onMouseOver={() => setHoveredGutter(g().path)}
            onMouseOut={() => setHoveredGutter((h) => (h === g().path ? null : h))}
          />
        )}
      </Index>
      <Show when={store.sidebar.visible}>
        <Sidebar />
      </Show>
      <StatusBar />
      <Show when={store.helpVisible}>
        <HelpOverlay />
      </Show>
      <Show when={store.dialog}>
        <DialogOverlay />
      </Show>
    </box>
  );
}
