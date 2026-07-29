import { For, Show } from "solid-js";
import { focusPane, selectTab } from "../core/state";
import type { PaneState } from "../core/types";
import { store } from "../core/state";
import { statusGlyph, theme } from "./theme";

export function TabStrip(props: { pane: PaneState; focused: boolean }) {
  const stripBg = () => (props.focused ? theme.stripBgFocused : theme.stripBg);
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
            return ` ${idx() + 1}:${m.title.slice(0, 18)}${g ? " " + g : ""}${dot ? " " + dot : ""} `;
          };
          return (
            <text
              content={label()}
              fg={active() ? theme.tabFgActive : glyph().glyph ? glyph().color : theme.tabFg}
              bg={active() ? theme.tabBgActive : stripBg()}
              onMouseDown={() => {
                focusPane(props.pane.id);
                selectTab(props.pane.id, idx());
              }}
            />
          );
        }}
      </For>
      <Show when={props.focused}>
        <text content=" +" fg={theme.tabFg} bg={stripBg()} />
      </Show>
    </box>
  );
}
