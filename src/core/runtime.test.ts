import { beforeEach, describe, expect, it } from "bun:test";
import type { HostClientFrame } from "../control/protocol";
import { scanPasteMode, setHostSender, SurfaceRuntime } from "./runtime";

const decode = (d: string) => Buffer.from(d, "base64").toString("utf8");

describe("scanPasteMode", () => {
  it("keeps the previous state when nothing says otherwise", () => {
    expect(scanPasteMode(false, "plain output\x1b[32m")).toBe(false);
    expect(scanPasteMode(true, "plain output")).toBe(true);
  });

  it("follows the last ?2004 in the text", () => {
    expect(scanPasteMode(false, "\x1b[?2004h")).toBe(true);
    expect(scanPasteMode(true, "\x1b[?2004l")).toBe(false);
    expect(scanPasteMode(false, "\x1b[?2004h...\x1b[?2004l...\x1b[?2004h")).toBe(true);
  });

  it("reads it out of a batch of modes, as claude sends them", () => {
    expect(scanPasteMode(false, "\x1b[?1049;1000;2004h")).toBe(true);
  });

  it("ignores modes that merely contain the digits", () => {
    expect(scanPasteMode(false, "\x1b[?12004h\x1b[?200h")).toBe(false);
  });
});

describe("SurfaceRuntime paste", () => {
  let sent: HostClientFrame[] = [];

  beforeEach(() => {
    sent = [];
    setHostSender((frame) => sent.push(frame));
  });

  const written = () =>
    sent
      .filter((f): f is Extract<HostClientFrame, { t: "w" }> => f.t === "w")
      .map((f) => decode(f.d))
      .join("");

  it("sends the text alone to a program that never asked for ?2004", () => {
    const rt = new SurfaceRuntime("s1");
    rt.feed("$ ");
    rt.paste("/tmp/dropped file.txt");
    expect(written()).toBe("/tmp/dropped file.txt");
  });

  it("brackets it for a program that did ask", () => {
    const rt = new SurfaceRuntime("s1");
    rt.feed("\x1b[?1049h\x1b[?2004h");
    rt.paste("two\nlines");
    expect(written()).toBe("\x1b[200~two\nlines\x1b[201~");
  });

  it("stops bracketing once the program turns it back off", () => {
    const rt = new SurfaceRuntime("s1");
    rt.feed("\x1b[?2004h");
    rt.feed("\x1b[?2004l");
    rt.paste("plain");
    expect(written()).toBe("plain");
  });

  it("picks the mode up from a replay, so an adopted surface pastes right", () => {
    const rt = new SurfaceRuntime("s1");
    rt.attachRenderable({
      feed: () => {},
      getCursor: () => [0, 0],
      getText: () => "",
      snapToLive: () => {},
    });
    sent = [];
    rt.feedSnapshot("\x1b[?2004h\x1b[?1049hclaude was already running");
    rt.paste("path");
    expect(written()).toBe("\x1b[200~path\x1b[201~");
  });

  it("catches a mode split across two chunks", () => {
    const rt = new SurfaceRuntime("s1");
    rt.feed("output\x1b[?20");
    rt.feed("04h");
    rt.paste("x");
    expect(written()).toBe("\x1b[200~x\x1b[201~");
  });
});
