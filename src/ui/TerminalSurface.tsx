import { createEffect, onCleanup, onMount } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { BoxRenderable, RenderContext } from "@opentui/core";
import { GhosttyTerminalRenderable } from "ghostty-opentui/opentui";
import { registry } from "../core/state";

/**
 * Mounts a persistent GhosttyTerminalRenderable imperatively. The Solid JSX
 * path constructs elements with no options and sprays props through setters,
 * but `persistent` is constructor-only — so the renderable is created by
 * hand and added to a container box.
 */
export function TerminalSurface(props: {
  sid: string;
  cols: number;
  rows: number;
  visible: boolean;
  showCursor: boolean;
}) {
  const renderer = useRenderer();
  let container: BoxRenderable | undefined;
  let term: GhosttyTerminalRenderable | undefined;

  onMount(() => {
    term = new GhosttyTerminalRenderable(renderer as unknown as RenderContext, {
      id: `term-${props.sid}`,
      persistent: true,
      cols: props.cols,
      rows: props.rows,
      showCursor: props.showCursor,
      visible: props.visible,
      width: "100%",
      height: "100%",
    });
    container!.add(term);
    registry.get(props.sid)?.attachRenderable(term);
  });

  createEffect(() => {
    const c = props.cols;
    const r = props.rows;
    if (term) {
      term.cols = c;
      term.rows = r;
    }
  });
  createEffect(() => {
    const v = props.visible;
    if (term) term.visible = v;
  });
  createEffect(() => {
    const s = props.showCursor;
    if (term) term.showCursor = s;
  });

  onCleanup(() => {
    registry.get(props.sid)?.detachRenderable();
    if (term && container) {
      try {
        container.remove(term);
        term.destroy();
      } catch {
        // teardown is best-effort
      }
    }
    term = undefined;
  });

  return (
    <box
      // Runtime JSX (no Solid compiler): refs must be callbacks.
      ref={(el: BoxRenderable) => (container = el)}
      position="absolute"
      left={0}
      top={0}
      width="100%"
      height="100%"
    />
  );
}
