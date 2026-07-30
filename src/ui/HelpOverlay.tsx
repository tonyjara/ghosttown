import { For, createMemo } from "solid-js";
import { helpLayout, loadConfig } from "../core/config";
import { setHelpVisible, store } from "../core/state";
import { truncate } from "./list";
import { theme } from "./theme";

/**
 * Floating pane listing the effective (defaults + user overrides) keybinds by
 * category. The full list is taller than most terminals, so core/config lays
 * the categories out over as many columns as it takes to fit — see helpLayout.
 */
export function HelpOverlay() {
  const layout = createMemo(() => helpLayout(loadConfig(), store.screen));

  const left = createMemo(() => Math.max(0, Math.floor((store.screen.width - layout().width) / 2)));
  const top = createMemo(() =>
    Math.max(0, Math.floor((store.screen.height - 1 - layout().height) / 2)),
  );
  const prefix = loadConfig().keybinds.prefix;

  return (
    <box
      position="absolute"
      left={left()}
      top={top()}
      width={layout().width}
      height={layout().height}
      zIndex={100}
      flexDirection="column"
      backgroundColor={theme.stripBgFocused}
      border={true}
      borderColor={theme.accent}
      title={` ghosttown · after ${prefix} `}
      onMouseDown={() => setHelpVisible(false)}
    >
      <box flexDirection="row" flexGrow={1} backgroundColor={theme.stripBgFocused}>
        <For each={layout().columns}>
          {(column) => (
            <box
              flexDirection="column"
              width={layout().columnWidth}
              flexShrink={0}
              backgroundColor={theme.stripBgFocused}
            >
              <For each={column}>
                {(section, i) => (
                  <>
                    {layout().spaced && i() > 0 && (
                      <box height={1} backgroundColor={theme.stripBgFocused} />
                    )}
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
                            content={` ${row.keys.padEnd(layout().keyWidth)} `}
                            fg={theme.accent}
                            bg={theme.stripBgFocused}
                          />
                          <text
                            content={truncate(row.label, layout().labelWidth)}
                            fg={theme.tabFgActive}
                            bg={theme.stripBgFocused}
                          />
                        </box>
                      )}
                    </For>
                  </>
                )}
              </For>
            </box>
          )}
        </For>
      </box>
      <text
        content={
          layout().clipped
            ? " esc to close · a taller terminal shows the rest"
            : " esc to close"
        }
        fg={theme.tabFg}
        bg={theme.stripBgFocused}
      />
    </box>
  );
}
