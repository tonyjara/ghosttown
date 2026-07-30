import { Show, createMemo } from "solid-js";
import { loadConfig } from "../core/config";
import { activeSurfaceId, activeWorkspace, agentCounts, store, surfaceLabel } from "../core/state";
import { theme } from "./theme";

function prefixHint(): string {
  return loadConfig()
    .keybinds.prefix.replace("ctrl+", "C-")
    .replace("alt+", "M-")
    .replace("shift+", "S-");
}

export function StatusBar() {
  // Profile-wide, every workspace: the whole point of a status bar tally is
  // that it counts what you cannot currently see.
  const counts = createMemo(() => agentCounts());

  const focusedTitle = createMemo(() => surfaceLabel(store.surfaces[activeSurfaceId()]));

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
      {/* Agents waiting at their prompt: invisible until now, and the reason
          this tally exists. */}
      <Show when={counts().idle > 0}>
        <text content={` ○ ${counts().idle} `} fg={theme.idle} bg={theme.statusBarBg} />
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
