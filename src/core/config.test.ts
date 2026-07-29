import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIONS,
  deepMerge,
  helpRows,
  keysForAction,
  loadConfig,
  normalizeKeySpec,
  parseChord,
  setConfigForTest,
  type Action,
} from "./config";

afterEach(() => {
  setConfigForTest(null);
  delete process.env.GHOSTTOWN_CONFIG;
});

describe("parseChord", () => {
  it("parses modifiers and key", () => {
    expect(parseChord("ctrl+a")).toEqual({ ctrl: true, alt: false, shift: false, name: "a" });
    expect(parseChord("alt+shift+x")).toEqual({ ctrl: false, alt: true, shift: true, name: "x" });
    expect(parseChord("ctrl+space")).toEqual({ ctrl: true, alt: false, shift: false, name: " " });
  });
});

describe("normalizeKeySpec", () => {
  it("folds shift into the character the terminal actually sends", () => {
    expect(normalizeKeySpec("shift+c")).toBe("C");
    expect(normalizeKeySpec("shift+t")).toBe("T");
    expect(normalizeKeySpec("C")).toBe("C");
  });

  it("leaves bare keys alone", () => {
    expect(normalizeKeySpec("c")).toBe("c");
    expect(normalizeKeySpec("|")).toBe("|");
    expect(normalizeKeySpec("+")).toBe("+");
    expect(normalizeKeySpec("left")).toBe("left");
    expect(normalizeKeySpec("space")).toBe(" ");
  });

  it("keeps other modifiers in the chord", () => {
    expect(normalizeKeySpec("ctrl+x")).toBe("ctrl+x");
    expect(normalizeKeySpec("alt+shift+enter")).toBe("alt+shift+enter");
  });
});

describe("deepMerge", () => {
  it("user scalars and arrays replace, objects merge", () => {
    const base = { a: { x: 1, y: 2 }, list: [1, 2], keep: "yes" };
    const merged = deepMerge(base, { a: { y: 99 }, list: [3] });
    expect(merged).toEqual({ a: { x: 1, y: 99 }, list: [3], keep: "yes" });
  });
});

describe("loadConfig", () => {
  it("loads shipped defaults when no user config exists", () => {
    process.env.GHOSTTOWN_CONFIG = "/nonexistent/nope.toml";
    const config = loadConfig();
    expect(config.keybinds.prefix).toBe("ctrl+a");
    expect(keysForAction(config, "split-right")).toContain("|");
    expect(config.notifications.enabled).toBe(true);
    expect(config.sidebar.visible).toBe(true);
    expect(config.sidebar.width).toBe(28);
    expect(keysForAction(config, "toggle-sidebar")).toEqual(["b"]);
    // Tabs and workspaces are shifted so they need intent, and no shifted
    // binding may collide with the unshifted key of another action.
    expect(keysForAction(config, "new-tab")).toEqual(["T"]);
    expect(keysForAction(config, "close-tab")).toEqual(["D"]);
    expect(keysForAction(config, "new-workspace")).toEqual(["C"]);
    expect(keysForAction(config, "delete-workspace")).toEqual(["X"]);
    expect(keysForAction(config, "detach")).toEqual(["d"]);
    expect(keysForAction(config, "reload")).toEqual(["R"]);
    expect(keysForAction(config, "quit")).toEqual(["Q"]);
  });

  it("no two actions claim the same key", () => {
    process.env.GHOSTTOWN_CONFIG = "/nonexistent/nope.toml";
    const config = loadConfig();
    const owner = new Map<string, Action>();
    for (const action of ACTIONS) {
      for (const spec of keysForAction(config, action)) {
        const key = normalizeKeySpec(spec);
        expect(owner.get(key) ?? action).toBe(action);
        owner.set(key, action);
      }
    }
  });

  it("user config overrides defaults, rest falls through", () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-config-"));
    const userPath = join(dir, "config.toml");
    writeFileSync(
      userPath,
      `[keybinds]\nprefix = "ctrl+g"\n"split-right" = ["v"]\n\n[notifications]\nenabled = false\n`,
    );
    process.env.GHOSTTOWN_CONFIG = userPath;
    const config = loadConfig();
    expect(config.keybinds.prefix).toBe("ctrl+g"); // overridden
    expect(keysForAction(config, "split-right")).toEqual(["v"]); // replaced, not appended
    expect(keysForAction(config, "split-down")).toContain("-"); // default preserved
    expect(config.notifications.enabled).toBe(false); // overridden
    expect(config.notifications.sound).toBe("Glass"); // default preserved
  });

  it("invalid user config falls back to defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-config-"));
    const userPath = join(dir, "config.toml");
    writeFileSync(userPath, "this is not toml [[[");
    process.env.GHOSTTOWN_CONFIG = userPath;
    const config = loadConfig();
    expect(config.keybinds.prefix).toBe("ctrl+a");
  });
});

describe("helpRows", () => {
  it("reflects merged keybinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "gt-config-"));
    const userPath = join(dir, "config.toml");
    writeFileSync(userPath, `[keybinds]\n"new-tab" = ["t"]\n`);
    process.env.GHOSTTOWN_CONFIG = userPath;
    const rows = helpRows(loadConfig());
    const newTab = rows.find((r) => r.label === "new tab in pane");
    expect(newTab?.keys).toBe("t");
    expect(rows.some((r) => r.label === "select tab N")).toBe(true);
  });
});
