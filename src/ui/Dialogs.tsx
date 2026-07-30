import { For, Show, createMemo } from "solid-js";
import {
  canRenameProfileTo,
  dialogPick,
  finderItems,
  isFinderDialog,
  isTextDialog,
  profileDeleteTarget,
  store,
  workspaceTabCount,
  type FinderItem,
} from "../core/state";
import { truncate, twoColumnRow, windowStart } from "./list";
import { agentGlyph, theme } from "./theme";

/**
 * Modal dialogs. Three shapes:
 *  - confirm (workspace delete, profile delete)
 *  - text input (rename workspace, rename tab, new / rename profile)
 *  - list: switch-profile (j/k over running sessions, a/r/d to manage them) and
 *    the telescope-style finders for workspaces and agents, where a query
 *    filters as you type.
 * Keys are routed in App; the state lives in core/state.
 */
export function DialogOverlay() {
  const dialog = () => store.dialog;
  const finder = () => isFinderDialog(dialog());
  const confirm = () =>
    dialog()?.kind === "confirm-delete-workspace" || dialog()?.kind === "confirm-delete-profile";

  const workspace = createMemo(() => {
    const d = dialog();
    return d && "workspaceId" in d ? store.workspaces[d.workspaceId] : undefined;
  });

  const sessions = createMemo(() => {
    const d = dialog();
    return d?.kind === "switch-profile" ? d.sessions : [];
  });

  const items = createMemo(() => (finder() ? finderItems() : []));

  const selectedIdx = () => {
    const d = dialog();
    return d?.kind === "switch-profile" || isFinderDialog(d) ? d.idx : -1;
  };

  const query = () => {
    const d = dialog();
    return isFinderDialog(d) ? d.query : "";
  };

  const inputValue = () => {
    const d = dialog();
    return isTextDialog(d) ? d.value : "";
  };

  const width = () => Math.min(store.screen.width - 4, finder() ? 58 : 52);
  /** Rows a finder can show: everything but the border, query and footer. */
  const listRows = createMemo(() =>
    Math.max(1, Math.min(items().length || 1, store.screen.height - 3 - 4)),
  );
  const height = createMemo(() => {
    const d = dialog();
    if (isFinderDialog(d)) return listRows() + 4;
    if (d?.kind === "switch-profile") {
      // Two footer lines: moving/taking one, and managing them.
      return Math.min(store.screen.height - 3, sessions().length + 5);
    }
    return 6;
  });
  const left = () => Math.max(0, Math.floor((store.screen.width - width()) / 2));
  const top = () => Math.max(0, Math.floor((store.screen.height - 1 - height()) / 2));

  // Keep the selected row on screen when the list is longer than the box.
  const shown = createMemo(() => {
    const start = windowStart(selectedIdx(), items().length, listRows());
    return items()
      .slice(start, start + listRows())
      .map((item, i) => ({ item, idx: start + i }));
  });

  const title = () => {
    switch (dialog()?.kind) {
      case "confirm-delete-workspace":
        return " delete workspace ";
      case "rename-workspace":
        return " rename workspace ";
      case "rename-tab":
        return " rename tab ";
      case "switch-profile":
        return " profiles ";
      case "new-profile":
        return " new profile ";
      case "rename-profile":
        return " rename profile ";
      case "confirm-delete-profile":
        return " delete profile ";
      case "find-workspace":
        return " find workspace ";
      case "find-agent":
        return " find agent ";
      default:
        return "";
    }
  };

  /** Why the name being typed cannot be used, if it cannot. */
  const nameProblem = createMemo(() => {
    const d = dialog();
    if (d?.kind !== "rename-profile") return "";
    const value = d.value.trim();
    if (!value || value === d.session) return "";
    return canRenameProfileTo(d.session, value) ? "" : ` "${value}" is already a profile`;
  });

  const inputHint = () => {
    switch (dialog()?.kind) {
      case "new-profile":
        return " enter create & switch · esc cancel";
      case "rename-profile":
        return " enter rename · esc back";
      case "rename-tab":
        return " enter save · empty restores the title · esc cancel";
      default:
        return " enter save · esc cancel";
    }
  };

  /** Two lines: what the kill takes with it, and where it leaves you. */
  const deleteProfileLines = createMemo((): string[] => {
    const d = dialog();
    if (d?.kind !== "confirm-delete-profile") return [];
    const { self, landsOn } = profileDeleteTarget(d.session);
    const head = ` Kill "${d.session}" and everything in it?`;
    if (!self) return [head, " Its agents and shells are stopped for good."];
    if (landsOn) return [head, ` You are in it — this client moves to "${landsOn}".`];
    return [head, " It is the only one: this quits ghosttown."];
  });

  const finderFooter = () =>
    ` ${items().length === 0 ? 0 : selectedIdx() + 1}/${items().length} · ↑↓ move · ⏎ open · esc`;

  const rowFg = (selected: boolean, item: FinderItem) => {
    if (selected) return theme.tabFgActive;
    if (item.status) return agentGlyph(item.status).color;
    return item.current ? theme.accent : theme.tabFg;
  };

  /** ● for the workspace you are in, a status glyph for an agent. */
  const rowMarker = (item: FinderItem) => {
    if (item.status) return agentGlyph(item.status).glyph;
    return item.current ? "●" : " ";
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
      borderColor={confirm() ? theme.blocked : theme.accent}
      title={title()}
    >
      <Show when={dialog()?.kind === "confirm-delete-workspace"}>
        <text
          content={` Kill "${workspace()?.name ?? "?"}" and its ${workspaceTabCount(workspace()?.id ?? "")} tab(s)?`}
          fg={theme.tabFgActive}
          bg={theme.stripBgFocused}
        />
        <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
        <text content=" y / enter confirm · esc cancel" fg={theme.tabFg} bg={theme.stripBgFocused} />
      </Show>
      <Show when={dialog()?.kind === "confirm-delete-profile"}>
        <For each={deleteProfileLines()}>
          {(line, i) => (
            <text
              content={truncate(line, width() - 2)}
              fg={i() === 0 ? theme.tabFgActive : theme.blocked}
              bg={theme.stripBgFocused}
            />
          )}
        </For>
        <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
        <text content=" y / enter confirm · esc back" fg={theme.tabFg} bg={theme.stripBgFocused} />
      </Show>
      <Show when={isTextDialog(dialog())}>
        <text content={` ${inputValue()}▉`} fg={theme.tabFgActive} bg={theme.stripBgFocused} />
        <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
        <Show when={nameProblem()}>
          <text
            content={truncate(nameProblem(), width() - 2)}
            fg={theme.blocked}
            bg={theme.stripBgFocused}
          />
        </Show>
        <text content={inputHint()} fg={theme.tabFg} bg={theme.stripBgFocused} />
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
                onMouseDown={() => dialogPick(i())}
              />
            );
          }}
        </For>
        <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
        <text
          content={truncate(" j/k move · ⏎ switch · esc cancel", width() - 2)}
          fg={theme.tabFg}
          bg={theme.stripBgFocused}
        />
        <text
          content={truncate(" a new · r rename · d kill", width() - 2)}
          fg={theme.tabFg}
          bg={theme.stripBgFocused}
        />
      </Show>
      <Show when={finder()}>
        <text
          content={truncate(` ❯ ${query()}▉`, width() - 2).padEnd(width() - 2)}
          fg={theme.tabFgActive}
          bg={theme.stripBgFocused}
        />
        <Show
          when={items().length > 0}
          fallback={<text content="   no match" fg={theme.idle} bg={theme.stripBgFocused} />}
        >
          <For each={shown()}>
            {(entry) => {
              const selected = () => entry.idx === selectedIdx();
              return (
                <text
                  content={twoColumnRow(
                    ` ${selected() ? "❯" : " "} ${rowMarker(entry.item)} ${entry.item.label}`,
                    `${entry.item.hint} `,
                    width() - 2,
                  )}
                  fg={rowFg(selected(), entry.item)}
                  bg={selected() ? theme.sidebarSelBg : theme.stripBgFocused}
                  onMouseDown={() => dialogPick(entry.idx)}
                />
              );
            }}
          </For>
        </Show>
        <box flexGrow={1} backgroundColor={theme.stripBgFocused} />
        <text content={finderFooter()} fg={theme.tabFg} bg={theme.stripBgFocused} />
      </Show>
    </box>
  );
}
