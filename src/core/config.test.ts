import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTION_LABELS,
  ACTIONS,
  deepMerge,
  helpRows,
  helpLayout,
  helpSections,
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
    expect(keysForAction(config, "rename-workspace")).toEqual(["W"]);
    expect(keysForAction(config, "rename-tab")).toEqual([","]);
    // The two fuzzy finders, lowercase next to their shifted mutating pair.
    expect(keysForAction(config, "find-workspace")).toEqual(["w"]);
    expect(keysForAction(config, "find-agent")).toEqual(["a"]);
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

describe("helpSections", () => {
  it("lists every bound action, each under a category", () => {
    process.env.GHOSTTOWN_CONFIG = "/nonexistent/nope.toml";
    const config = loadConfig();
    const listed = new Set(helpSections(config).flatMap((s) => s.rows.map((r) => r.label)));
    for (const action of ACTIONS) {
      if (keysForAction(config, action).length === 0) continue;
      expect(listed).toContain(ACTION_LABELS[action]);
    }
  });

  it("gives workspaces and agents their own categories", () => {
    process.env.GHOSTTOWN_CONFIG = "/nonexistent/nope.toml";
    const sections = helpSections(loadConfig());
    const workspaces = sections.find((s) => s.category === "Workspaces");
    expect(workspaces?.rows.map((r) => r.keys)).toEqual(["C", "N", "P", "W", "X", "w"]);
    expect(sections.some((s) => s.category === "Agents")).toBe(true);
  });
});

describe("helpLayout", () => {
  const layoutFor = (width: number, height: number) => {
    process.env.GHOSTTOWN_CONFIG = "/nonexistent/nope.toml";
    return helpLayout(loadConfig(), { width, height });
  };
  const contentRows = (column: { rows: unknown[] }[], spaced: boolean) =>
    column.reduce((h, s) => h + 1 + s.rows.length, 0) + (spaced ? column.length - 1 : 0);

  it("uses one spaced column when the terminal is tall enough", () => {
    const layout = layoutFor(120, 60);
    expect(layout.columns.length).toBe(1);
    expect(layout.spaced).toBe(true);
    expect(layout.height).toBeLessThanOrEqual(60 - 3);
  });

  it("splits into columns rather than clipping on a short terminal", () => {
    const layout = layoutFor(100, 30);
    expect(layout.columns.length).toBeGreaterThan(1);
    for (const column of layout.columns) {
      expect(contentRows(column, layout.spaced)).toBeLessThanOrEqual(30 - 7);
    }
    expect(layout.width).toBeLessThanOrEqual(100 - 4);
    // Every category still has a home, and none is split across columns.
    const categories = layout.columns.flat().map((s) => s.category);
    expect(new Set(categories).size).toBe(categories.length);
    expect(categories).toContain("Workspaces");
    expect(categories).toContain("Agents");
  });

  it("keeps labels readable, truncating only what a column cannot hold", () => {
    const wide = layoutFor(160, 30);
    const narrow = layoutFor(84, 30);
    expect(wide.labelWidth).toBeGreaterThanOrEqual(narrow.labelWidth);
    for (const layout of [wide, narrow]) {
      expect(layout.labelWidth).toBeGreaterThanOrEqual(14);
      expect(layout.columnWidth).toBeGreaterThanOrEqual(layout.keyWidth + layout.labelWidth);
    }
  });

  it("still returns a usable box on a terminal too small for everything", () => {
    const layout = layoutFor(40, 12);
    expect(layout.columns.flat().length).toBeGreaterThan(0);
    expect(layout.width).toBeLessThanOrEqual(40);
    expect(layout.height).toBeLessThanOrEqual(12 - 3);
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
