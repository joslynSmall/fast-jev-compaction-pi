import { describe, expect, it } from "vitest";
import {
  batchCalls,
  buildState,
  collectToolCalls,
  decideCall,
  estimateTokens,
  mapWithConcurrency,
  renderEvidence,
  truncateResult,
  type MessageLike,
} from "../src/core.js";

const messages: MessageLike[] = [
  { role: "user", content: "Fix the failing test. Do not edit generated files." },
  {
    role: "assistant",
    content: [
      { type: "toolCall", id: "read-1", name: "read", arguments: { path: "src/a.ts" } },
      { type: "toolCall", id: "test-1", name: "bash", arguments: { command: "npm test" } },
    ],
  },
  { role: "toolResult", toolCallId: "read-1", toolName: "read", content: [{ type: "text", text: "export const a = 1;\n".repeat(100) }], isError: false },
  { role: "toolResult", toolCallId: "test-1", toolName: "bash", content: [{ type: "text", text: "FAIL src/a.test.ts: expected 2, received 1" }], isError: true },
  { role: "assistant", content: [{ type: "text", text: "The test failure is real." }] },
];

describe("tool-call collection", () => {
  it("pairs Pi tool calls with results by toolCallId", () => {
    const calls = collectToolCalls(messages);
    expect(calls).toHaveLength(2);
    expect(calls.map((call) => [call.id, call.tool, call.result.length, call.isError])).toEqual([
      ["t1", "read", "export const a = 1;\n".repeat(100).length, false],
      ["t2", "bash", "FAIL src/a.test.ts: expected 2, received 1".length, true],
    ]);
  });

  it("ignores incomplete calls", () => {
    expect(
      collectToolCalls([
        { role: "assistant", content: [{ type: "toolCall", id: "pending", name: "read", arguments: {} }] },
      ]),
    ).toEqual([]);
  });
});

describe("Jev decision inputs", () => {
  it("builds an output-free state with task text and tool metadata", () => {
    const calls = collectToolCalls(messages);
    const state = buildState(messages, calls, 10_000);
    const json = JSON.stringify(state);
    expect(json).toContain("Fix the failing test");
    expect(json).toContain('"tool":"read"');
    expect(json).toContain("2000 chars (omitted)");
    expect(json).not.toContain("export const a = 1;");
  });

  it("batches questions without losing calls", () => {
    const calls = collectToolCalls(messages);
    const batches = batchCalls(calls, 9_800, 10_000);
    expect(batches.flat().map((call) => call.id)).toEqual(["t1", "t2"]);
    expect(batches.length).toBeGreaterThan(1);
  });
});

describe("local policy", () => {
  it("maps Jev probabilities to keep, truncate, or drop", () => {
    const [read, test] = collectToolCalls(messages);
    expect(decideCall(read!, { keepCall: 0.1, keepResult: 0.9 }, 0.5).action).toBe("keep");
    expect(decideCall(read!, { keepCall: 0.9, keepResult: 0.1 }, 0.5).action).toBe("drop_result");
    expect(decideCall(test!, { keepCall: 0.1, keepResult: 0.1 }, 0.5).action).toBe("drop_call");
  });

  it("renders only selected original evidence and annotates truncation", () => {
    const calls = collectToolCalls(messages);
    const decisions = [
      decideCall(calls[0]!, { keepCall: 0.9, keepResult: 0.1 }, 0.5),
      decideCall(calls[1]!, { keepCall: 0.1, keepResult: 0.1 }, 0.5),
    ];
    const evidence = renderEvidence(calls, decisions, 20);
    expect(evidence.text).toContain("## Verbatim Tool Evidence");
    expect(evidence.text).toContain("### read (t1)");
    expect(evidence.text).toContain("omitted");
    expect(evidence.text).not.toContain("### bash (t2)");
    expect(evidence.keptChars).toBeLessThan(evidence.candidateChars);
  });

  it("keeps short results unchanged when truncation is unnecessary", () => {
    expect(truncateResult("short", false, 300)).toBe("short");
  });

  it("keeps rendered evidence within its token budget and prioritizes error results", () => {
    const calls = collectToolCalls(messages);
    const decisions = calls.map((call) => decideCall(call, { keepCall: 1, keepResult: 1 }, 0.5));
    const evidence = renderEvidence(calls, decisions, 20, 60);
    expect(estimateTokens(evidence.text)).toBeLessThanOrEqual(60);
    expect(evidence.text).toContain("### bash (t2)");
    expect(evidence.text).not.toContain("### read (t1)");
  });

  it("uses a fence longer than the evidence content", () => {
    const calls = collectToolCalls(messages);
    calls[0]!.result = "````\ncontent\n````";
    const evidence = renderEvidence(calls, [decideCall(calls[0]!, { keepCall: 1, keepResult: 1 }, 0.5)], 20);
    expect(evidence.text).toContain("`````text");
    expect(evidence.text).toContain("\n`````");
  });

  it("bounds concurrent async work", async () => {
    let active = 0;
    let peak = 0;
    const values = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return value * 2;
    });
    expect(values).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });
});
