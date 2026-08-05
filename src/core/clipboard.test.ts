import { describe, expect, it } from "bun:test";
import { MAX_CLIPBOARD_BASE64, osc52, osc52Text, parseClipboardWrite } from "./clipboard";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

describe("parseClipboardWrite", () => {
  it("takes the payload of a write, whatever selection it names", () => {
    expect(parseClipboardWrite(`c;${b64("hello")}`)).toBe(b64("hello"));
    expect(parseClipboardWrite(`p;${b64("hello")}`)).toBe(b64("hello"));
    expect(parseClipboardWrite(`cs;${b64("hello")}`)).toBe(b64("hello"));
    // Empty selection field means "the default one".
    expect(parseClipboardWrite(`;${b64("hello")}`)).toBe(b64("hello"));
  });

  it("refuses a read", () => {
    // Relaying it would send the terminal's answer to our stdin, i.e. it would
    // arrive as if the user had typed the clipboard into the focused pane.
    expect(parseClipboardWrite("c;?")).toBeNull();
  });

  it("refuses anything that is not a payload", () => {
    expect(parseClipboardWrite("c")).toBeNull(); // no separator at all
    expect(parseClipboardWrite("c;")).toBeNull(); // nothing to copy
    expect(parseClipboardWrite("c;not base64!")).toBeNull();
    expect(parseClipboardWrite(`c;${"A".repeat(MAX_CLIPBOARD_BASE64 + 1)}`)).toBeNull();
  });
});

describe("osc52", () => {
  it("addresses the system clipboard and ends on BEL", () => {
    expect(osc52(b64("hi"))).toBe("\x1b]52;c;aGk=\x07");
  });

  it("encodes text as utf-8 base64", () => {
    expect(osc52Text("café ☕")).toBe(`\x1b]52;c;${b64("café ☕")}\x07`);
    // Round-trips through the payload a terminal would decode.
    const payload = osc52Text("café ☕").slice("\x1b]52;c;".length, -1);
    expect(Buffer.from(payload, "base64").toString("utf8")).toBe("café ☕");
  });
});
