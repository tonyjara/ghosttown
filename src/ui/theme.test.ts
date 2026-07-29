import { describe, expect, it } from "bun:test";
import { loadConfig, setConfigForTest, type Config } from "../core/config";
import { resolveTheme } from "./theme";
import { THEMES } from "./themes";

function cfg(appearance: Partial<Config["appearance"]>, theme?: Record<string, string>): Config {
  setConfigForTest(null);
  const base = structuredClone(loadConfig());
  Object.assign(base.appearance, appearance);
  if (theme) base.theme = theme;
  return base;
}

describe("resolveTheme", () => {
  it("returns the named palette", () => {
    const t = resolveTheme(cfg({ theme: "catppuccin-mocha" }));
    expect(t.bg).toBe("#1e1e2e");
    expect(t.accent).toBe("#89b4fa");
  });

  it("falls back to ghosttown for unknown names", () => {
    const t = resolveTheme(cfg({ theme: "no-such-theme" }));
    expect(t).toEqual(THEMES["ghosttown"]!);
  });

  it("[theme] overrides win over the named palette, unknown keys ignored", () => {
    const t = resolveTheme(cfg({ theme: "nord" }, { accent: "#ff00ff", bogus: "#123456" }));
    expect(t.accent).toBe("#ff00ff");
    expect(t.bg).toBe(THEMES["nord"]!.bg);
    expect("bogus" in t).toBe(false);
  });

  it("every built-in theme has every key", () => {
    const keys = Object.keys(THEMES["ghosttown"]!).sort();
    for (const [name, palette] of Object.entries(THEMES)) {
      expect(Object.keys(palette).sort(), `theme ${name}`).toEqual(keys);
    }
  });
});
