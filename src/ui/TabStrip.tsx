import { For, createSignal } from "solid-js";
import { focusPane, newTab, selectTab, surfaceLabel } from "../core/state";
import type { PaneState } from "../core/types";
import { store } from "../core/state";
import { statusGlyph, theme } from "./theme";

/** How close two presses on `+` have to be to count as a double click. */
const DOUBLE_CLICK_MS = 400;

export function TabStrip(props: { pane: PaneState; focused: boolean }) {
  const stripBg = () => (props.focused ? theme.stripBgFocused : theme.stripBg);

  // `+` opens a tab on DOUBLE click: a single click there is already "focus
  // this pane", and a mis-aimed tab click should never spawn a terminal.
  const [plusHot, setPlusHot] = createSignal(false);
  let lastPlusDown = 0;
  const onPlusDown = () => {
    const now = Date.now();
    const isDouble = now - lastPlusDown <= DOUBLE_CLICK_MS;
    lastPlusDown = isDouble ? 0 : now;
    if (isDouble) newTab(props.pane.id);
  };

  return (
    <box
      height={1}
      width="100%"
      flexDirection="row"
      backgroundColor={stripBg()}
      flexShrink={0}
    >
      <For each={props.pane.surfaceIds}>
        {(sid, idx) => {
          const meta = () => store.surfaces[sid];
          const active = () => idx() === props.pane.activeIdx;
          const glyph = () => statusGlyph(meta()?.status ?? "idle");
          const label = () => {
            const m = meta();
            if (!m) return "";
            const g = glyph().glyph;
            const dot = m.unread ? "●" : "";
            return ` ${idx() + 1}:${surfaceLabel(m).slice(0, 18)}${g ? " " + g : ""}${dot ? " " + dot : ""} `;
          };
          return (
            <text
              content={label()}
              fg={active() ? theme.tabFgActive : glyph().glyph ? glyph().color : theme.tabFg}
              bg={active() ? theme.tabBgActive : stripBg()}
              selectable={false}
              onMouseDown={() => {
                focusPane(props.pane.id);
                selectTab(props.pane.id, idx());
              }}
            />
          );
        }}
      </For>
      <text
        content=" + "
        fg={plusHot() || props.focused ? theme.tabFg : theme.idle}
        bg={plusHot() ? theme.tabBgActive : stripBg()}
        selectable={false}
        onMouseDown={onPlusDown}
        onMouseOver={() => setPlusHot(true)}
        onMouseOut={() => setPlusHot(false)}
      />
    </box>
  );
}
