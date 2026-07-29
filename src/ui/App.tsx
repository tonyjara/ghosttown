import { For, Show, createEffect, createMemo } from "solid-js";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import type { KeyEvent } from "@opentui/core";
import {
  ACTIONS,
  keysForAction,
  loadConfig,
  parseChord,
  type Action,
} from "../core/config";
import {
  closeActiveTab,
  currentRects,
  cycleTab,
  focusDirection,
  newTab,
  quit,
  selectTab,
  setArea,
  setHelpVisible,
  setPrefixArmed,
  splitPane,
  store,
  writeToFocused,
} from "../core/state";
import { dbg } from "../core/debug";
import { HelpOverlay } from "./HelpOverlay";
import { PaneView } from "./PaneView";
import { StatusBar } from "./StatusBar";
import { theme } from "./theme";

const PREFIX_TIMEOUT_MS = 3000;

function runAction(action: Action): void {
  const focused = store.focusedPaneId;
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
    case "quit":
      quit();
      return;
    case "help":
      setHelpVisible(!store.helpVisible);
      return;
  }
}

export function App() {
  const config = loadConfig();
  const prefixChord = parseChord(config.keybinds.prefix);
  // key string ("h", "left", "|") → action, from the merged config.
  const actionByKey = new Map<string, Action>();
  for (const action of ACTIONS) {
    for (const key of keysForAction(config, action)) {
      actionByKey.set(key, action);
    }
  }

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

    // Help overlay is modal: nothing reaches the pty while it's open.
    if (store.helpVisible) {
      if (isPrefix(key)) {
        arm();
        return;
      }
      if (store.prefixArmed) {
        disarm();
        if (actionByKey.get(key.sequence || key.name) === "help") {
          setHelpVisible(false);
          return;
        }
      }
      if (key.name === "escape" || key.name === "q" || key.sequence === "?") {
        setHelpVisible(false);
      }
      return;
    }

    if (!store.prefixArmed) {
      if (isPrefix(key)) {
        arm();
        return;
      }
      const bytes = key.raw || key.sequence;
      if (bytes) writeToFocused(bytes);
      return;
    }

    disarm();
    dbg("prefix cmd", { name: key.name, seq: key.sequence, ctrl: key.ctrl });

    if (isPrefix(key)) {
      // Prefix twice → send it literally.
      writeToFocused(key.raw || key.sequence || "");
      return;
    }
    const action = actionByKey.get(key.sequence || key.name) ?? actionByKey.get(key.name);
    if (action) {
      runAction(action);
      return;
    }
    if (/^[1-9]$/.test(key.name)) {
      selectTab(store.focusedPaneId, Number(key.name) - 1);
    }
  });

  usePaste((event) => {
    const text: string = (event as unknown as { text: string }).text ?? "";
    if (text) writeToFocused(`\x1b[200~${text}\x1b[201~`);
  });

  const rects = createMemo(() => {
    // Track layout + area so the memo recomputes on any structural change.
    void store.layout;
    void store.area.width;
    void store.area.height;
    return currentRects();
  });

  return (
    <box width="100%" height="100%" backgroundColor={theme.bg}>
      <For each={Object.keys(store.panes)}>
        {(paneId) => {
          const rect = () => rects().get(paneId);
          return (
            <Show when={rect() && store.panes[paneId]}>
              <PaneView
                pane={store.panes[paneId]!}
                rect={rect()!}
                focused={paneId === store.focusedPaneId}
              />
            </Show>
          );
        }}
      </For>
      <StatusBar />
      <Show when={store.helpVisible}>
        <HelpOverlay />
      </Show>
    </box>
  );
}
