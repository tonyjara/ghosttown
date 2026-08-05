/**
 * Workspace navigation. The store is module-global, so each test creates the
 * workspaces it needs rather than assuming an empty session.
 */
import { describe, expect, it } from "bun:test";
import {
  createWorkspace,
  deleteWorkspace,
  lastWorkspace,
  setStore,
  sidebarDragWorkspace,
  store,
  switchWorkspace,
} from "./state";

describe("last-workspace", () => {
  it("jumps back to where you came from, and back again", () => {
    const a = createWorkspace({ name: "last-a" });
    const b = createWorkspace({ name: "last-b" });
    expect(store.activeWorkspaceId).toBe(b);

    lastWorkspace();
    expect(store.activeWorkspaceId).toBe(a);
    // Pressed twice it returns: a toggle between the two, not a walk backwards.
    lastWorkspace();
    expect(store.activeWorkspaceId).toBe(b);
  });

  it("follows where you have been, not the workspace order", () => {
    const a = createWorkspace({ name: "hop-a" });
    createWorkspace({ name: "hop-b" });
    const c = createWorkspace({ name: "hop-c" });

    switchWorkspace(a);
    // b sits between a and c in the order; the jump ignores that.
    lastWorkspace();
    expect(store.activeWorkspaceId).toBe(c);
  });

  it("stays put when the workspace it would return to is gone", () => {
    const gone = createWorkspace({ name: "gone" });
    const here = createWorkspace({ name: "here" });

    deleteWorkspace(gone);
    expect(store.activeWorkspaceId).toBe(here);
    lastWorkspace();
    expect(store.activeWorkspaceId).toBe(here);
  });
});

describe("sidebar workspace drag", () => {
  /** Three fresh workspaces land adjacent at the end of the order. */
  const trio = (tag: string) => {
    const ids = [
      createWorkspace({ name: `${tag}-a` }),
      createWorkspace({ name: `${tag}-b` }),
      createWorkspace({ name: `${tag}-c` }),
    ];
    return { ids, tail: () => store.workspaceOrder.slice(-3) };
  };
  const select = (wsId: string) =>
    setStore("sidebar", {
      section: "workspaces",
      workspaceIdx: store.workspaceOrder.indexOf(wsId),
    });

  it("moves the selected workspace down, selection following it", () => {
    const { ids, tail } = trio("down");
    const [a, b, c] = ids as [string, string, string];
    select(b);

    sidebarDragWorkspace(1);
    expect(tail()).toEqual([a, c, b]);
    // The cursor stays on the row it is dragging, not on the slot it left.
    expect(store.workspaceOrder[store.sidebar.workspaceIdx]).toBe(b);
  });

  it("moves it back up again", () => {
    const { ids, tail } = trio("up");
    const [a, b, c] = ids as [string, string, string];
    select(c);

    sidebarDragWorkspace(-1);
    expect(tail()).toEqual([a, c, b]);
    sidebarDragWorkspace(-1);
    expect(tail()).toEqual([c, a, b]);
    expect(store.workspaceOrder[store.sidebar.workspaceIdx]).toBe(c);
  });

  it("stops at the ends rather than wrapping", () => {
    const { ids } = trio("edge");
    const [, , c] = ids as [string, string, string];
    const before = [...store.workspaceOrder];

    // c is the newest, so it is the bottom row of the whole list.
    select(c);
    sidebarDragWorkspace(1);
    expect([...store.workspaceOrder]).toEqual(before);

    select(store.workspaceOrder[0]!);
    sidebarDragWorkspace(-1);
    expect([...store.workspaceOrder]).toEqual(before);
  });

  it("does nothing while the agents half is selected", () => {
    trio("agents");
    const before = [...store.workspaceOrder];
    setStore("sidebar", "section", "agents");

    sidebarDragWorkspace(1);
    expect(store.workspaceOrder).toEqual(before);
    setStore("sidebar", "section", "workspaces");
  });
});
