import { For, Show, createMemo } from "solid-js";
import { collectPaneIds } from "../core/layout";
import { store } from "../core/state";
import { theme } from "./theme";

/**
 * Modal dialogs: workspace delete confirm, workspace rename, profile switch
 * (list of running sessions), new profile (name input). Keys are routed in
 * App: enter/y confirm, esc/n cancel, j/k move in lists, text edits inputs.
 */
export function DialogOverlay() {
  const dialog = () => store.dialog;

  const workspace = createMemo(() => {
    const d = dialog();
    return d && "workspaceId" in d ? store.workspaces[d.workspaceId] : undefined;
  });

  const tabCount = createMemo(() => {
    const ws = workspace();
    if (!ws?.layout) return 0;
    return collectPaneIds(ws.layout).reduce(
      (n, pid) => n + (store.panes[pid]?.surfaceIds.length ?? 0),
      0,
    );
  });

  const sessions = createMemo(() => {
    const d = dialog();
    return d?.kind === "switch-profile" ? d.sessions : [];
  });

  const width = () => Math.min(store.screen.width - 4, 52);
  const height = createMemo(() => {
    const d = dialog();
    if (d?.kind === "switch-profile") {
      return Math.min(store.screen.height - 3, sessions().length + 4);
    }
    return 6;
  });
  const left = () => Math.max(0, Math.floor((store.screen.width - width()) / 2));
  const top = () => Math.max(0, Math.floor((store.screen.height - 1 - height()) / 2));

  const title = () => {
    switch (dialog()?.kind) {
      case "confirm-delete-workspace":
        return " delete workspace ";
      case "rename-workspace":
        return " rename workspace ";
      case "switch-profile":
        return " switch profile ";
      case "new-profile":
        return " new profile ";
      default:
        return "";
    }
  };

  const inputValue = () => {
    const d = dialog();
    return d?.kind === "rename-workspace" || d?.kind === "new-profile" ? d.value : "";
  };

  const selectedIdx = () => {
    const d = dialog();
    return d?.kind === "switch-profile" ? d.idx : -1;
  };

  return (
    <box
      position="absolute"
      left={left()}
      top={top()}
      width={width()}
      height={height()}
      zIndex={200}
      flexDirection="column"
      backgroundColor={theme.stripBgFocused}
      border={true}
      borderColor={dialog()?.kind === "confirm-delete-workspace" ? theme.blocked : theme.accent}
      title={title()}
    >
      <Show when={dialog()?.kind === "confirm-delete-workspace"}>
        <text
          content={` Kill "${workspace()?.name ?? "?"}" and its ${tabCount()} tab(s)?`}
          fg={theme.tabFgActive}
          bg={theme.stripBgFocused}
        />
        <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
        <text content=" y / enter confirm · esc cancel" fg={theme.tabFg} bg={theme.stripBgFocused} />
      </Show>
      <Show when={dialog()?.kind === "rename-workspace" || dialog()?.kind === "new-profile"}>
        <text
          content={` ${inputValue()}▉`}
          fg={theme.tabFgActive}
          bg={theme.stripBgFocused}
        />
        <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
        <text
          content={
            dialog()?.kind === "new-profile"
              ? " enter create & switch · esc cancel"
              : " enter save · esc cancel"
          }
          fg={theme.tabFg}
          bg={theme.stripBgFocused}
        />
      </Show>
      <Show when={dialog()?.kind === "switch-profile"}>
        <For each={sessions()}>
          {(name, i) => {
            const selected = () => i() === selectedIdx();
            const current = () => name === store.session;
            return (
              <text
                content={` ${current() ? "●" : " "} ${name}`.padEnd(width() - 2)}
                fg={selected() ? theme.tabFgActive : current() ? theme.accent : theme.tabFg}
                bg={selected() ? theme.sidebarSelBg : theme.stripBgFocused}
              />
            );
          }}
        </For>
        <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
        <text
          content=" j/k move · enter switch · esc cancel"
          fg={theme.tabFg}
          bg={theme.stripBgFocused}
        />
      </Show>
    </box>
  );
}
