import { For, Show, createEffect, createMemo } from "solid-js";
import { useKeyboard, usePaste, useTerminalDimensions } from "@opentui/solid";
import type { KeyEvent } from "@opentui/core";
import {
  closeActiveTab,
  currentRects,
  cycleTab,
  focusDirection,
  focusPane,
  newTab,
  quit,
  selectTab,
  setArea,
  setPrefixArmed,
  splitPane,
  store,
  writeToFocused,
} from "../core/state";
import { dbg } from "../core/debug";
import { PaneView } from "./PaneView";
import { StatusBar } from "./StatusBar";
import { theme } from "./theme";

const PREFIX_TIMEOUT_MS = 3000;

export function App() {
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

  useKeyboard((key: KeyEvent) => {
    if (key.eventType === "release") return;

    if (!store.prefixArmed) {
      if (key.ctrl && key.name === "a") {
        arm();
        return;
      }
      const bytes = key.raw || key.sequence;
      if (bytes) writeToFocused(bytes);
      return;
    }

    disarm();
    const focused = store.focusedPaneId;
    const ch = key.sequence || key.name;
    dbg("prefix cmd", { name: key.name, seq: key.sequence, ctrl: key.ctrl, focused });

    if (key.ctrl && key.name === "a") {
      writeToFocused("\x01"); // literal Ctrl+A
      return;
    }
    if (ch === "|" || ch === "\\" || ch === "%") {
      splitPane(focused, "row");
      return;
    }
    if (ch === "-" || ch === '"') {
      splitPane(focused, "column");
      return;
    }
    switch (key.name) {
      case "c":
        newTab(focused);
        return;
      case "n":
        cycleTab(focused, 1);
        return;
      case "p":
        cycleTab(focused, -1);
        return;
      case "x":
        closeActiveTab();
        return;
      case "q":
        quit();
        return;
      case "h":
      case "left":
        focusDirection("left");
        return;
      case "l":
      case "right":
        focusDirection("right");
        return;
      case "k":
      case "up":
        focusDirection("up");
        return;
      case "j":
      case "down":
        focusDirection("down");
        return;
    }
    if (/^[1-9]$/.test(key.name)) {
      selectTab(focused, Number(key.name) - 1);
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
    </box>
  );
}
