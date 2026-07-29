import { describe, expect, it } from "bun:test";
import { OutputScanner, trailingIncompleteEscape } from "./queries";

function makeScanner(cursor: [number, number] = [4, 2]) {
  const responses: string[] = [];
  const titles: string[] = [];
  const notifies: string[] = [];
  const scanner = new OutputScanner({
    respond: (d) => responses.push(d),
    getCursor: () => cursor,
    onTitle: (t) => titles.push(t),
    onNotify: (_t, b) => notifies.push(b),
  });
  return { scanner, responses, titles, notifies };
}

describe("OutputScanner", () => {
  it("answers cursor position reports", () => {
    const { scanner, responses } = makeScanner([4, 2]);
    scanner.scan("hello\x1b[6nworld");
    expect(responses).toEqual(["\x1b[3;5R"]);
  });

  it("answers DA1 but not colored DA responses", () => {
    const { scanner, responses } = makeScanner();
    scanner.scan("\x1b[c");
    expect(responses).toEqual(["\x1b[?62;22c"]);
    responses.length = 0;
    // A DA *response* embedded in output must not trigger an answer.
    scanner.scan("\x1b[?62;22c");
    expect(responses).toEqual([]);
  });

  it("answers kitty keyboard query with zero flags", () => {
    const { scanner, responses } = makeScanner();
    scanner.scan("\x1b[?u");
    expect(responses).toEqual(["\x1b[?0u"]);
  });

  it("answers DECRQM for sync mode", () => {
    const { scanner, responses } = makeScanner();
    scanner.scan("\x1b[?2026$p\x1b[?2004$p");
    expect(responses).toEqual(["\x1b[?2026;2$y", "\x1b[?2004;0$y"]);
  });

  it("answers OSC 11 background query matching the terminator", () => {
    const { scanner, responses } = makeScanner();
    scanner.scan("\x1b]11;?\x07");
    expect(responses[0]).toBe("\x1b]11;rgb:1a1a/1b1b/2626\x07");
  });

  it("observes titles and OSC 9 notifications", () => {
    const { scanner, titles, notifies } = makeScanner();
    scanner.scan("\x1b]0;my title\x07\x1b]9;job finished\x07\x1b]9;4;1;50\x07");
    expect(titles).toEqual(["my title"]);
    expect(notifies).toEqual(["job finished"]); // progress (9;4;...) ignored
  });

  it("handles escapes split across chunks without double answers", () => {
    const { scanner, responses } = makeScanner([0, 0]);
    scanner.scan("text\x1b[");
    scanner.scan("6n");
    expect(responses).toEqual(["\x1b[1;1R"]);
    scanner.scan("more text");
    expect(responses).toEqual(["\x1b[1;1R"]);
  });
});

describe("trailingIncompleteEscape", () => {
  it("detects incomplete CSI", () => {
    expect(trailingIncompleteEscape("abc\x1b[12;3")).toBe("\x1b[12;3");
    expect(trailingIncompleteEscape("abc\x1b[12;3H")).toBe("");
  });
  it("detects incomplete OSC", () => {
    expect(trailingIncompleteEscape("x\x1b]0;titl")).toBe("\x1b]0;titl");
    expect(trailingIncompleteEscape("x\x1b]0;title\x07")).toBe("");
  });
  it("lone ESC at end carries", () => {
    expect(trailingIncompleteEscape("abc\x1b")).toBe("\x1b");
  });
});
