/**
 * The finder dialogs and tab renames, driven through the same actions the keys
 * call. The store is module-global, so each test works with names of its own
 * rather than assuming an empty session.
 */
import { describe, expect, it } from "bun:test";
import {
  activeSurfaceId,
  createWorkspace,
  dialogChar,
  dialogClear,
  dialogConfirm,
  dialogMove,
  finderItems,
  isFinderDialog,
  openFindAgent,
  openFindWorkspace,
  openRenameTab,
  renameSurface,
  setStore,
  store,
  surfaceLabel,
  switchWorkspace,
} from "./state";

const type = (text: string) => {
  for (const ch of text) dialogChar(ch);
};

const labels = () => finderItems().map((i) => i.label);
const selectedIdx = () => (isFinderDialog(store.dialog) ? store.dialog.idx : -1);

describe("workspace finder", () => {
  it("filters as you type and switches to the match on confirm", () => {
    const api = createWorkspace({ name: "api server" });
    createWorkspace({ name: "notes" });
    const other = createWorkspace({ name: "zzz other" });
    expect(store.activeWorkspaceId).toBe(other);

    openFindWorkspace();
    expect(labels()).toContain("api server");
    // It opens on the workspace you are in, so enter alone changes nothing.
    expect(finderItems()[selectedIdx()]?.id).toBe(other);

    type("apis");
    expect(labels()).toEqual(["api server"]);
    dialogConfirm();
    expect(store.dialog).toBeNull();
    expect(store.activeWorkspaceId).toBe(api);
  });

  it("marks the current workspace and counts its tabs", () => {
    const wsId = createWorkspace({ name: "tab counter" });
    openFindWorkspace();
    type("tab counter");
    const [row] = finderItems();
    expect(row?.id).toBe(wsId);
    expect(row?.current).toBe(true);
    expect(row?.hint).toBe("1 tab");
    dialogConfirm();
  });

  it("wraps the selection and restarts it when the query changes", () => {
    createWorkspace({ name: "wrap a" });
    createWorkspace({ name: "wrap b" });
    openFindWorkspace();
    type("wrap");
    expect(finderItems().length).toBe(2);
    expect(selectedIdx()).toBe(0);
    dialogMove(-1);
    expect(selectedIdx()).toBe(1); // wrapped to the end
    dialogMove(1);
    expect(selectedIdx()).toBe(0);
    dialogMove(1);
    expect(selectedIdx()).toBe(1);
    type("x"); // no longer matches anything
    expect(finderItems()).toEqual([]);
    expect(selectedIdx()).toBe(0);
    dialogMove(1); // must not move past an empty list
    expect(selectedIdx()).toBe(0);
    dialogClear();
    expect(labels().length).toBe(store.workspaceOrder.length);
    dialogConfirm();
  });
});

describe("agent finder", () => {
  it("finds an agent by name and jumps to its tab", () => {
    const home = createWorkspace({ name: "agent home" });
    const surfaceId = activeSurfaceId();
    // What makes a surface an agent: it has reported at least once.
    setStore("surfaces", surfaceId, "hasReporter", true);
    renameSurface(surfaceId, "claude refactor");

    const elsewhere = createWorkspace({ name: "elsewhere" });
    expect(store.activeWorkspaceId).toBe(elsewhere);

    openFindAgent();
    type("refac");
    expect(finderItems()[0]?.id).toBe(surfaceId);
    // The hint names the workspace: an agent you are looking for is usually
    // somewhere else, and that is what you need to know about it.
    expect(finderItems()[0]?.hint).toBe("agent home · idle");
    dialogConfirm();
    expect(store.activeWorkspaceId).toBe(home);
    expect(activeSurfaceId()).toBe(surfaceId);
  });

  it("finds an agent by its workspace and by which agent it is", () => {
    createWorkspace({ name: "payments api" });
    const surfaceId = activeSurfaceId();
    renameSurface(surfaceId, "tab-with-no-useful-name");
    setStore("surfaces", surfaceId, "agent", "codex");
    createWorkspace({ name: "somewhere else" });

    openFindAgent();
    type("payments");
    expect(finderItems().map((i) => i.id)).toContain(surfaceId);
    dialogClear();
    type("codex");
    expect(finderItems().map((i) => i.id)).toContain(surfaceId);
    dialogConfirm();
  });

  it("lists nothing for a query that matches no agent", () => {
    openFindAgent();
    type("no-such-agent-anywhere");
    expect(finderItems()).toEqual([]);
    dialogConfirm(); // an empty list confirms to a no-op
    expect(store.dialog).toBeNull();
  });
});

describe("tab renames", () => {
  it("wins over the program's title and clears back to it when emptied", () => {
    createWorkspace({ name: "rename host" });
    const surfaceId = activeSurfaceId();
    renameSurface(surfaceId, "  build watcher  ");
    expect(surfaceLabel(store.surfaces[surfaceId])).toBe("build watcher");

    // An OSC 0/2 title arriving from the program must not take the name back.
    setStore("surfaces", surfaceId, "title", "vim");
    expect(surfaceLabel(store.surfaces[surfaceId])).toBe("build watcher");

    renameSurface(surfaceId, "");
    expect(store.surfaces[surfaceId]?.titleOverride).toBeUndefined();
    expect(surfaceLabel(store.surfaces[surfaceId])).toBe("vim");
  });

  it("prefills the dialog with the current name and saves what you type", () => {
    const wsId = createWorkspace({ name: "dialog host" });
    switchWorkspace(wsId);
    const surfaceId = activeSurfaceId();
    renameSurface(surfaceId, "before");

    openRenameTab();
    expect(store.dialog).toEqual({ kind: "rename-tab", surfaceId, value: "before" });
    dialogClear();
    type("after");
    dialogConfirm();
    expect(surfaceLabel(store.surfaces[surfaceId])).toBe("after");
  });
});
