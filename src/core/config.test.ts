import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deepMerge,
  helpRows,
  keysForAction,
  loadConfig,
  parseChord,
  setConfigForTest,
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
