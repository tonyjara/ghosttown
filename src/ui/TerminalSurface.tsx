import { createEffect, onCleanup, onMount } from "solid-js";
import { useRenderer } from "@opentui/solid";
import type { BoxRenderable, RenderContext } from "@opentui/core";
import { MOUSE_MODES_OFF } from "../core/mouse";
import { registry } from "../core/state";
import { MuxTerminal } from "./MuxTerminal";

/**
 * Mounts a persistent MuxTerminal imperatively. The Solid JSX path constructs
 * elements with no options and sprays props through setters, but `persistent`
 * is constructor-only — so the renderable is created by hand and added to a
 * container box.
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
  let term: MuxTerminal | undefined;

  onMount(() => {
    term = new MuxTerminal(renderer as unknown as RenderContext, {
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
    const rt = registry.get(props.sid);
    rt?.attachRenderable(term);
    // Apps that ask for the mouse (?1000/?1002/?1003) get the events instead
    // of the pane acting on them — that is how scrolling works in claude.
    term.attachMouse({
      modes: () => rt?.mouseModes() ?? MOUSE_MODES_OFF,
      report: (data) => rt?.reportMouse(data),
    });
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
    if (!term) return;
    term.showCursor = s;
    if (!s) term.releaseCursor();
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
