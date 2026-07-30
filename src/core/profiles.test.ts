/**
 * The profile switcher as a management panel: a / r / d, driven through the same
 * actions the keys call. Nothing here touches another profile's daemon — that
 * chain (rename over the attach socket, kill, snapshot cleanup) is covered end
 * to end by scripts/harness.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canRenameProfileTo,
  dialogCancel,
  dialogChar,
  dialogClear,
  dialogConfirm,
  listProfiles,
  openDeleteProfile,
  openNewProfile,
  openRenameProfile,
  openSwitchProfile,
  profileDeleteTarget,
  store,
} from "./state";

// deleteProfile cleans up after a profile whose daemon is gone; keep that (and
// any snapshot write) inside a sandbox rather than the developer's state dir.
beforeEach(() => {
  process.env.GHOSTTOWN_STATE_DIR = mkdtempSync(join(tmpdir(), "gt-profiles-"));
});

afterEach(() => {
  delete process.env.GHOSTTOWN_STATE_DIR;
  dialogCancel();
  if (store.dialog) dialogCancel(); // the profile dialogs cancel back to the switcher
});

const type = (text: string) => {
  for (const ch of text) dialogChar(ch);
};

describe("profile switcher", () => {
  it("opens on the profile you are in and lists it", () => {
    openSwitchProfile();
    const d = store.dialog;
    expect(d?.kind).toBe("switch-profile");
    if (d?.kind !== "switch-profile") return;
    expect(d.sessions).toContain(store.session);
    // Enter right away is a no-op, like the workspace finder.
    expect(d.sessions[d.idx]).toBe(store.session);
  });

  it("hides a profile that is on its way out", () => {
    openSwitchProfile(undefined, store.session);
    const d = store.dialog;
    expect(d?.kind === "switch-profile" && d.sessions).not.toContain(store.session);
  });

  it("a opens the new-profile input and esc comes back to the list", () => {
    openSwitchProfile();
    openNewProfile(true);
    expect(store.dialog).toEqual({ kind: "new-profile", value: "", back: true });
    // Names land in filenames: only path-safe characters make it in.
    type("side/quest 2");
    expect(store.dialog).toEqual({ kind: "new-profile", value: "sidequest2", back: true });
    dialogCancel();
    expect(store.dialog?.kind).toBe("switch-profile");
  });

  it("prefix+S opens the same input, but esc closes it outright", () => {
    openNewProfile();
    expect(store.dialog).toEqual({ kind: "new-profile", value: "", back: false });
    dialogCancel();
    expect(store.dialog).toBeNull();
  });
});

describe("profile rename", () => {
  it("prefills the selected profile and returns to the list on esc", () => {
    openSwitchProfile();
    openRenameProfile();
    expect(store.dialog).toEqual({
      kind: "rename-profile",
      session: store.session,
      value: store.session,
    });
    dialogCancel();
    const d = store.dialog;
    // Back on the same row you came from.
    expect(d?.kind === "switch-profile" && d.sessions[d.idx]).toBe(store.session);
  });

  it("refuses a name that is empty, unchanged, or another profile", () => {
    expect(canRenameProfileTo(store.session, "")).toBe(false);
    expect(canRenameProfileTo(store.session, "  ")).toBe(false);
    expect(canRenameProfileTo(store.session, store.session)).toBe(false);
    expect(canRenameProfileTo("some-other", store.session)).toBe(false);
    expect(canRenameProfileTo(store.session, "a-name-nothing-else-has")).toBe(true);
  });

  it("keeps the dialog open when the name cannot be used", () => {
    openRenameProfile(store.session);
    dialogClear();
    // Its own name: nothing to do, and dropping what was typed would be rude.
    type(store.session);
    dialogConfirm();
    expect(store.dialog?.kind).toBe("rename-profile");
    dialogClear();
    type("renamed-to-something-new");
    dialogConfirm();
    // Accepted: the daemon does the actual rename, so all that happens here is
    // that the dialog closes.
    expect(store.dialog).toBeNull();
  });

  it("does nothing for a profile that is not there", () => {
    openRenameProfile(null);
    expect(store.dialog).toBeNull();
    openDeleteProfile(null);
    expect(store.dialog).toBeNull();
  });
});

describe("profile delete", () => {
  it("asks first, and esc comes back to the list", () => {
    openSwitchProfile();
    openDeleteProfile();
    expect(store.dialog).toEqual({
      kind: "confirm-delete-profile",
      session: store.session,
    });
    dialogCancel();
    expect(store.dialog?.kind).toBe("switch-profile");
  });

  it("knows deleting the profile you are in has to move you somewhere", () => {
    const self = profileDeleteTarget(store.session);
    expect(self.self).toBe(true);
    // Whatever else is running (this dev box may have profiles of its own): the
    // landing profile is never the one being killed.
    expect(self.landsOn).not.toBe(store.session);
    const others = listProfiles().filter((n) => n !== store.session);
    expect(self.landsOn).toBe(others[0] ?? null);

    const other = profileDeleteTarget("not-the-current-profile");
    expect(other).toEqual({ self: false, landsOn: null });
  });
});
