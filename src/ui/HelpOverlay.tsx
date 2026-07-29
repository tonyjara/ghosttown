import { For, createMemo } from "solid-js";
import { helpRows, loadConfig } from "../core/config";
import { setHelpVisible, store } from "../core/state";
import { theme } from "./theme";

/** Floating pane listing the effective (defaults + user overrides) keybinds. */
export function HelpOverlay() {
  const rows = createMemo(() => helpRows(loadConfig()));
  const keyColWidth = createMemo(() =>
    Math.max(...rows().map((r) => r.keys.length), 6),
  );
  const width = createMemo(() =>
    Math.min(store.area.width - 4, keyColWidth() + 30),
  );
  const height = createMemo(() => Math.min(store.area.height - 2, rows().length + 4));
  const left = createMemo(() => Math.max(0, Math.floor((store.area.width - width()) / 2)));
  const top = createMemo(() => Math.max(0, Math.floor((store.area.height - height()) / 2)));
  const prefix = loadConfig().keybinds.prefix;

  return (
    <box
      position="absolute"
      left={left()}
      top={top()}
      width={width()}
      height={height()}
      zIndex={100}
      flexDirection="column"
      backgroundColor={theme.stripBgFocused}
      border={true}
      borderColor={theme.accent}
      title={` ghosttown · after ${prefix} `}
      onMouseDown={() => setHelpVisible(false)}
    >
      <For each={rows()}>
        {(row) => (
          <box height={1} flexDirection="row" backgroundColor={theme.stripBgFocused}>
            <text
              content={` ${row.keys.padEnd(keyColWidth())} `}
              fg={theme.accent}
              bg={theme.stripBgFocused}
            />
            <text content={row.label} fg={theme.tabFgActive} bg={theme.stripBgFocused} />
          </box>
        )}
      </For>
      <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
      <text content=" esc to close" fg={theme.tabFg} bg={theme.stripBgFocused} />
    </box>
  );
}
