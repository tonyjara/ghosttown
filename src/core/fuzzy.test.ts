import { describe, expect, it } from "bun:test";
import { fuzzyFilter, fuzzyMatch } from "./fuzzy";

const names = ["workspace 1", "agents-ws", "api-server", "notes", "web-app"];
const filtered = (q: string) => fuzzyFilter(q, names, (n) => n).map((r) => r.item);

describe("fuzzyMatch", () => {
  it("matches an in-order subsequence, case-insensitively", () => {
    expect(fuzzyMatch("ws", "workspace 1")?.positions).toEqual([0, 4]);
    expect(fuzzyMatch("AGT", "agents-ws")).not.toBeNull();
  });

  it("rejects characters that are out of order or missing", () => {
    expect(fuzzyMatch("sw", "workspace 1")).toBeNull();
    expect(fuzzyMatch("zzz", "workspace 1")).toBeNull();
  });

  it("matches everything on an empty query", () => {
    expect(fuzzyMatch("", "anything")).toEqual({ score: 0, positions: [] });
    expect(fuzzyMatch("   ", "anything")).toEqual({ score: 0, positions: [] });
  });

  it("treats whitespace as separate terms, each of which must match", () => {
    expect(fuzzyMatch("ws 1", "workspace 1")).not.toBeNull();
    expect(fuzzyMatch("ws zz", "workspace 1")).toBeNull();
    // Terms are independent, so they may appear in any order in the text.
    expect(fuzzyMatch("1 ws", "workspace 1")).not.toBeNull();
  });

  it("scores consecutive runs and word starts above scattered hits", () => {
    const run = fuzzyMatch("age", "agents-ws")!.score;
    const scattered = fuzzyMatch("age", "a-great-escape")!.score;
    expect(run).toBeGreaterThan(scattered);
  });
});

describe("fuzzyFilter", () => {
  it("keeps the original order when the query is empty", () => {
    expect(filtered("")).toEqual(names);
  });

  it("drops non-matches", () => {
    // "ws" is a consecutive run in agents-ws and scattered in workspace 1.
    expect(filtered("ws")).toEqual(["agents-ws", "workspace 1"]);
  });

  it("ranks the best match first", () => {
    expect(filtered("ap")[0]).toBe("api-server");
    expect(filtered("web")[0]).toBe("web-app");
  });

  it("prefers the shorter label when the match is otherwise equal", () => {
    expect(fuzzyFilter("note", ["notes-and-more", "notes"], (n) => n)[0]!.item).toBe("notes");
  });
});
