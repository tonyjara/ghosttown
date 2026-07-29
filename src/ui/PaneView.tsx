import { For } from "solid-js";
import { focusPane } from "../core/state";
import type { PaneState, Rect } from "../core/types";
import { TabStrip } from "./TabStrip";
import { TerminalSurface } from "./TerminalSurface";
import { theme } from "./theme";

/**
 * One pane: a 1-row tab strip on top, then the terminal area. All surfaces
 * of the pane stay mounted (a persistent emulator dies with its renderable);
 * only the active tab is visible.
 */
export function PaneView(props: { pane: PaneState; rect: Rect; focused: boolean }) {
  return (
    <box
      position="absolute"
      left={props.rect.x}
      top={props.rect.y}
      width={props.rect.width}
      height={props.rect.height}
      flexDirection="column"
      backgroundColor={theme.bg}
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
              visible={idx() === props.pane.activeIdx}
              showCursor={idx() === props.pane.activeIdx && props.focused}
            />
          )}
        </For>
      </box>
    </box>
  );
}
