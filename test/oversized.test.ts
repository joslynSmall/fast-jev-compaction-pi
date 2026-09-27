import { describe, expect, it } from "vitest";
import {
  collectToolCalls,
  fitState,
  mergeDecisions,
  splitIntoWindows,
  type MessageLike,
} from "../src/core.js";

function oversized(turns: number): MessageLike[] {
  const messages: MessageLike[] = [];
  for (let turn = 0; turn < turns; turn += 1) {
    messages.push({ role: "user", content: `step ${turn}: ${"reason ".repeat(60)}` });
    messages.push({
      role: "assistant",
      content: [
        { type: "text", text: `calling read for step ${turn}: ${"because ".repeat(40)}` },
        {
          type: "toolCall",
          id: `call-${turn}`,
          name: "read",
          arguments: { path: `/repo/module-${turn}/${"segment/".repeat(90)}file.ts` },
        },
      ],
    });
    messages.push({
      role: "toolResult",
      toolCallId: `call-${turn}`,
      toolName: "read",
      content: [{ type: "text", text: `contents of file ${turn}: ${"payload ".repeat(300)}` }],
    });
  }
  return messages;
}

describe("state fitting under an oversized history", () => {
  it("fits a 400-turn history through degradation instead of throwing", () => {
    const messages = oversized(400);
    const calls = collectToolCalls(messages);
    const fitted = fitState(messages, calls, 25_000);
    expect(fitted.tokens).toBeLessThanOrEqual(25_000);
    expect(fitted.representedCalls.size).toBeGreaterThan(0);
  });

  it("leaves old entries out instead of failing the request", () => {
    const messages = oversized(800);
    const calls = collectToolCalls(messages);
    const fitted = fitState(messages, calls, 25_000);
    expect(fitted.tokens).toBeLessThanOrEqual(25_000);
    expect(fitted.stage).toBe("old entries left out");
    expect(fitted.representedCalls.size).toBeGreaterThan(0);
    expect(fitted.representedCalls.size).toBeLessThan(calls.length);
  });

  it("keeps the newest calls in the state and leaves the oldest out", () => {
    const messages = oversized(800);
    const calls = collectToolCalls(messages);
    const fitted = fitState(messages, calls, 25_000);
    expect(fitted.representedCalls.has(calls.at(-1)!.id)).toBe(true);
    expect(fitted.representedCalls.has(calls[0]!.id)).toBe(false);
  });
});

describe("windowed scoring of a history no single Jev state can hold", () => {
  it("splits calls into windows that rejoin losslessly", () => {
    const messages = oversized(400);
    const calls = collectToolCalls(messages);
    const windows = splitIntoWindows(calls, 60_000);
    expect(windows.length).toBeGreaterThan(1);
    expect(windows.flat().map((call) => call.id)).toEqual(calls.map((call) => call.id));
  });

  it("scores every call across windows with nothing left unscored", () => {
    const messages = oversized(800);
    const calls = collectToolCalls(messages);
    const single = fitState(messages, calls, 25_000);
    expect(calls.length - single.representedCalls.size).toBeGreaterThan(0);

    const windows = splitIntoWindows(calls, 60_000);
    let unscored = 0;
    for (const window of windows) {
      const fitted = fitState(messages, window, 25_000);
      unscored += window.length - window.filter((call) => fitted.representedCalls.has(call.id)).length;
    }
    expect(unscored).toBe(0);
  });

  it("merges per-window decisions into one list", () => {
    expect(
      mergeDecisions([
        [{ id: "t1", tool: "read", keepCall: 1, keepResult: 1, action: "keep" as const }],
        [{ id: "t2", tool: "bash", keepCall: 0, keepResult: 0, action: "drop_call" as const }],
      ]).map((d) => d.id),
    ).toEqual(["t1", "t2"]);
  });
});
