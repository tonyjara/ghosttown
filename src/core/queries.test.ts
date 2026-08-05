import { describe, expect, it } from "bun:test";
import { MOUSE_MODES_OFF, trackingLevel } from "./mouse";
import { OutputScanner, trailingIncompleteEscape } from "./queries";

function makeScanner(cursor: [number, number] = [4, 2]) {
  const responses: string[] = [];
  const titles: string[] = [];
  const notifies: string[] = [];
  const clips: string[] = [];
  const scanner = new OutputScanner({
    respond: (d) => responses.push(d),
    getCursor: () => cursor,
    onTitle: (t) => titles.push(t),
    onNotify: (_t, b) => notifies.push(b),
    onClipboard: (p) => clips.push(p),
  });
  return { scanner, responses, titles, notifies, clips };
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

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
    scanner.scan("\x1b[?2026$p\x1b[?9999$p");
    expect(responses).toEqual(["\x1b[?2026;2$y", "\x1b[?9999;0$y"]);
  });

  it("tracks bracketed paste and answers DECRQM for it", () => {
    const { scanner, responses } = makeScanner();
    expect(scanner.pasteMode()).toBe(false);
    scanner.scan("\x1b[?2004$p");
    expect(responses).toEqual(["\x1b[?2004;2$y"]);
    responses.length = 0;
    scanner.scan("\x1b[?1049;2004h");
    expect(scanner.pasteMode()).toBe(true);
    scanner.scan("\x1b[?2004$p");
    expect(responses).toEqual(["\x1b[?2004;1$y"]);
    scanner.scan("\x1b[?2004l");
    expect(scanner.pasteMode()).toBe(false);
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

describe("OutputScanner mouse modes", () => {
  it("starts with the mouse off", () => {
    const { scanner } = makeScanner();
    expect(scanner.mouseModes()).toEqual(MOUSE_MODES_OFF);
  });

  it("follows what the child sets and resets", () => {
    const { scanner } = makeScanner();
    // What claude sends when its UI comes up.
    scanner.scan("\x1b[?1049h\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h");
    expect(trackingLevel(scanner.mouseModes())).toBe("any");
    expect(scanner.mouseModes().sgr).toBe(true);
    scanner.scan("\x1b[?1003l\x1b[?1002l\x1b[?1000l");
    expect(trackingLevel(scanner.mouseModes())).toBe("off");
  });

  it("reads several modes out of one sequence", () => {
    const { scanner } = makeScanner();
    scanner.scan("\x1b[?1002;1006h");
    expect(trackingLevel(scanner.mouseModes())).toBe("drag");
    expect(scanner.mouseModes().sgr).toBe(true);
  });

  it("picks up a mode split across chunks", () => {
    const { scanner } = makeScanner();
    scanner.scan("text\x1b[?100");
    expect(trackingLevel(scanner.mouseModes())).toBe("off");
    scanner.scan("2h");
    expect(trackingLevel(scanner.mouseModes())).toBe("drag");
  });

  it("reports a clipboard write, and answers nothing back to the child", () => {
    // What claude emits at the end of every drag-select.
    const { scanner, clips, responses } = makeScanner();
    scanner.scan(`\x1b[?25l\x1b]52;c;${b64("selected text")}\x07\x1b[?25h`);
    expect(clips).toEqual([b64("selected text")]);
    expect(responses).toEqual([]);
  });

  it("ignores a clipboard read", () => {
    const { scanner, clips } = makeScanner();
    scanner.scan("\x1b]52;c;?\x07");
    expect(clips).toEqual([]);
  });

  it("reassembles a clipboard write split across chunks", () => {
    const { scanner, clips } = makeScanner();
    const payload = b64("x".repeat(9000)); // longer than the old 4096 carry cap
    const seq = `\x1b]52;c;${payload}\x07`;
    for (let i = 0; i < seq.length; i += 3000) scanner.scan(seq.slice(i, i + 3000));
    expect(clips).toEqual([payload]);
  });

  it("reassembles a clipboard write split at the ESC of its ST terminator", () => {
    // The nastiest boundary: the tail is a lone ESC with the whole unterminated
    // OSC in front of it, so carrying only the last escape lost the copy.
    const { scanner, clips } = makeScanner();
    scanner.scan(`\x1b]52;c;${b64("hi")}\x1b`);
    expect(clips).toEqual([]);
    scanner.scan("\\rest of the output");
    expect(clips).toEqual([b64("hi")]);
  });

  it("answers DECRQM with the mode the child actually set", () => {
    const { scanner, responses } = makeScanner();
    scanner.scan("\x1b[?1000h");
    scanner.scan("\x1b[?1000$p");
    expect(responses).toEqual(["\x1b[?1000;1$y"]);
    responses.length = 0;
    scanner.scan("\x1b[?1006$p");
    expect(responses).toEqual(["\x1b[?1006;2$y"]);
  });
});

describe("chunk invariance", () => {
  // The carry is what makes a split sequence work, and mouse-mode tracking is
  // what decides whether a pane hands drags to its program. Get the carry wrong
  // and a pane starts stealing the mouse from an editor, so: however the stream
  // is cut up, the scanner has to end up in the same place as one shot.
  const stream = [
    "\x1b[?1049h\x1b[?2004h", // alt screen, bracketed paste
    "\x1b]0;a title\x07",
    "\x1b[?1000h\x1b[?1002h\x1b[?1006h", // mouse on
    "some output\r\n\x1b[6n",
    `\x1b]52;c;${b64("copied while running")}\x07`,
    "\x1b]11;?\x1b\\", // OSC with an ST terminator
    "\x1b[?1002l\x1b[?1000l", // mouse off again
    "\x1b[?1003h", // ...and any-motion on
    "\x1b[5n\x1b[c",
    `\x1b]52;c;${b64("and one more")}\x1b\\`, // ST-terminated clipboard write
    "\x1b[?2004l\x1b[?1049l",
  ].join("");

  const scanIn = (size: number) => {
    const { scanner, responses, titles, clips } = makeScanner();
    for (let i = 0; i < stream.length; i += size) scanner.scan(stream.slice(i, i + size));
    return { modes: scanner.mouseModes(), paste: scanner.pasteMode(), responses, titles, clips };
  };

  const whole = scanIn(stream.length);

  it("ends up where the one-shot scan does, at every chunk size", () => {
    expect(trackingLevel(whole.modes)).toBe("any");
    expect(whole.clips).toEqual([b64("copied while running"), b64("and one more")]);
    for (const size of [1, 2, 3, 5, 7, 11, 16, 29, 64, 128]) {
      const got = scanIn(size);
      expect(got.modes, `modes at chunk ${size}`).toEqual(whole.modes);
      expect(got.paste, `paste at chunk ${size}`).toEqual(whole.paste);
      // Answers go out exactly once, not once per chunk. Sorted, because their
      // ORDER does depend on the chunking: one scan answers every CSI query it
      // finds before any OSC one, so a stream cut finely enough answers in the
      // order the queries actually arrived instead. Nothing observed so far
      // cares (each answer identifies itself), so this only pins down the set.
      expect(got.responses.toSorted(), `responses at chunk ${size}`).toEqual(
        whole.responses.toSorted(),
      );
      expect(got.titles, `titles at chunk ${size}`).toEqual(whole.titles);
      expect(got.clips, `clips at chunk ${size}`).toEqual(whole.clips);
    }
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
    // ...but not on its own when an unterminated OSC precedes it: that ESC is
    // the first half of the ST that would have ended it.
    expect(trailingIncompleteEscape("x\x1b]52;c;AAA\x1b")).toBe("\x1b]52;c;AAA\x1b");
    // A complete sequence stops the walk left.
    expect(trailingIncompleteEscape("\x1b]0;title\x07\x1b")).toBe("\x1b");
  });
});
