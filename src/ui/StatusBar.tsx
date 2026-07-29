import { Show, createMemo } from "solid-js";
import { loadConfig } from "../core/config";
import { activeWorkspace, focusedPaneId, store } from "../core/state";
import { theme } from "./theme";

function prefixHint(): string {
  return loadConfig()
    .keybinds.prefix.replace("ctrl+", "C-")
    .replace("alt+", "M-")
    .replace("shift+", "S-");
}

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
    const pane = store.panes[focusedPaneId()];
    const sid = pane?.surfaceIds[pane.activeIdx];
    return sid ? (store.surfaces[sid]?.title ?? "") : "";
  });

  return (
    <box
      position="absolute"
      left={0}
      top={store.screen.height - 1}
      width={store.screen.width}
      height={1}
      flexDirection="row"
      backgroundColor={theme.statusBarBg}
    >
      <text content={` ⌂ ${store.session} `} fg={theme.accent} bg={theme.statusBarBg} />
      <text
        content={` ▣ ${activeWorkspace()?.name ?? ""} `}
        fg={theme.statusBarFg}
        bg={theme.statusBarBg}
      />
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
      <Show when={store.resizeMode}>
        <text content=" RESIZE h j k l · esc " fg={theme.prefixFg} bg={theme.done} />
      </Show>
      <Show when={store.sidebar.focused}>
        <text content=" SIDEBAR " fg={theme.prefixFg} bg={theme.accent} />
      </Show>
      <text content={` ${focusedTitle()} `} fg={theme.statusBarFg} bg={theme.statusBarBg} />
      <text content={` ${prefixHint()} ? `} fg={theme.idle} bg={theme.statusBarBg} />
    </box>
  );
}
