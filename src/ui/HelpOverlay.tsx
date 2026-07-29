import { For, createMemo } from "solid-js";
import { helpSections, loadConfig } from "../core/config";
import { setHelpVisible, store } from "../core/state";
import { theme } from "./theme";

/** Floating pane listing the effective (defaults + user overrides) keybinds, organized by category. */
export function HelpOverlay() {
  const sections = createMemo(() => helpSections(loadConfig()));

  const keyColWidth = createMemo(() => {
    let max = 6;
    for (const section of sections()) {
      for (const row of section.rows) {
        max = Math.max(max, row.keys.length);
      }
    }
    return max;
  });

  const contentHeight = createMemo(() => {
    let height = 0;
    const sectionList = sections();
    for (let i = 0; i < sectionList.length; i++) {
      const section = sectionList[i]!;
      if (i > 0) height += 1; // blank line before each category (except first)
      height += 1; // category header
      height += section.rows.length;
    }
    return height;
  });

  const width = createMemo(() =>
    Math.min(store.screen.width - 4, keyColWidth() + 42),
  );
  const height = createMemo(() =>
    Math.min(store.screen.height - 3, contentHeight() + 4),
  );
  const left = createMemo(() => Math.max(0, Math.floor((store.screen.width - width()) / 2)));
  const top = createMemo(() =>
    Math.max(0, Math.floor((store.screen.height - 1 - height()) / 2)),
  );
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
      <For each={sections()}>
        {(section, i) => (
          <>
            {i() > 0 && <box height={1} backgroundColor={theme.stripBgFocused} />}
            <text
              content={` ${section.category}`}
              fg={theme.accent}
              bg={theme.stripBgFocused}
              height={1}
            />
            <For each={section.rows}>
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
          </>
        )}
      </For>
      <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
      <text content=" esc to close" fg={theme.tabFg} bg={theme.stripBgFocused} />
    </box>
  );
}
