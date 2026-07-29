import { Show, createMemo } from "solid-js";
import { store } from "../core/state";
import { theme } from "./theme";

export function StatusBar() {
  const counts = createMemo(() => {
    let working = 0;
    let blocked = 0;
    let done = 0;
    for (const m of Object.values(store.surfaces)) {
      if (m.status === "working") working++;
      else if (m.status === "blocked") blocked++;
      else if (m.status === "done") done++;
    }
    return { working, blocked, done };
  });

  const focusedTitle = createMemo(() => {
    const pane = store.panes[store.focusedPaneId];
    const sid = pane?.surfaceIds[pane.activeIdx];
    return sid ? (store.surfaces[sid]?.title ?? "") : "";
  });

  return (
    <box
      position="absolute"
      left={0}
      top={store.area.height}
      width={store.area.width}
      height={1}
      flexDirection="row"
      backgroundColor={theme.statusBarBg}
    >
      <text content={` ⌂ ${store.session} `} fg={theme.accent} bg={theme.statusBarBg} />
      <Show when={counts().working > 0}>
        <text content={` ✳ ${counts().working} `} fg={theme.working} bg={theme.statusBarBg} />
      </Show>
      <Show when={counts().blocked > 0}>
        <text content={` ⚑ ${counts().blocked} `} fg={theme.blocked} bg={theme.statusBarBg} />
      </Show>
      <Show when={counts().done > 0}>
        <text content={` ✓ ${counts().done} `} fg={theme.done} bg={theme.statusBarBg} />
      </Show>
      <box flexGrow={1} backgroundColor={theme.statusBarBg} />
      <Show when={store.prefixArmed}>
        <text content=" PREFIX " fg={theme.prefixFg} bg={theme.prefixBg} />
      </Show>
      <text content={` ${focusedTitle()} `} fg={theme.statusBarFg} bg={theme.statusBarBg} />
      <text content=" C-a " fg={theme.idle} bg={theme.statusBarBg} />
    </box>
  );
}
