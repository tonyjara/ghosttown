import { For } from "solid-js";
import { focusPane, store } from "../core/state";
import type { PaneState, Rect } from "../core/types";
import { TabStrip } from "./TabStrip";
import { TerminalSurface } from "./TerminalSurface";
import { theme } from "./theme";

/**
 * One pane: a 1-row tab strip on top, then the terminal area. All surfaces
 * of the pane stay mounted (a persistent emulator dies with its renderable);
 * only the active tab is visible. Panes of hidden workspaces stay mounted
 * too, with visible=false.
 */
export function PaneView(props: {
  pane: PaneState;
  rect: Rect;
  visible: boolean;
  focused: boolean;
}) {
  return (
    <box
      position="absolute"
      left={props.rect.x}
      top={props.rect.y}
      width={props.rect.width}
      height={props.rect.height}
      flexDirection="column"
      backgroundColor={theme.bg}
      visible={props.visible}
      onMouseDown={() => focusPane(props.pane.id)}
    >
      <TabStrip pane={props.pane} focused={props.focused} />
      <box position="relative" width="100%" flexGrow={1}>
        <For each={props.pane.surfaceIds}>
          {(sid, idx) => (
            <TerminalSurface
              sid={sid}
              cols={props.rect.width}
              rows={props.rect.height - 1}
              visible={props.visible && idx() === props.pane.activeIdx}
              showCursor={
                idx() === props.pane.activeIdx &&
                props.focused &&
                !store.helpVisible &&
                !store.dialog
              }
            />
          )}
        </For>
      </box>
    </box>
  );
}
