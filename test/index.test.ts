import type { CompactionResult, ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

vi.mock("../src/jev.js", () => ({
  askJev: vi.fn(async () => new Map([["t1", { keepCall: 1, keepResult: 0 }]])),
}));

function fixture(stopReason = "stop", errorMessage?: string) {
  vi.stubEnv("TYPESAFE_API_KEY", "synthetic-test-key");
  vi.stubEnv("FAST_JEV_SPILL", "0");
  const response = {
    stopReason,
    errorMessage,
    content: [{ type: "text", text: "## Goal\nFix the coding task." }],
    usage: { input: 100, output: 10 },
  };
  const complete = vi.fn(async () => response);
  const streamSimple = vi.fn(() => ({ result: async () => response }));
  const notify = vi.fn();
  const controller = new AbortController();
  const model = { provider: "test-provider", id: "test-model", maxTokens: 8192 };
  const ctx = {
    model,
    hasUI: true,
    modelRegistry: { complete, streamSimple, hasConfiguredAuth: () => true },
    ui: { notify },
  } as unknown as ExtensionContext;
  const event = {
    signal: controller.signal,
    preparation: {
      settings: { reserveTokens: 12000 },
      messagesToSummarize: [
        { role: "user", content: "Fix the coding task." },
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "/repo/file.ts" } }] },
        { role: "toolResult", toolCallId: "t1", toolName: "read", content: [{ type: "text", text: "evidence ".repeat(1000) }] },
      ],
      turnPrefixMessages: [],
      firstKeptEntryId: "kept-entry",
      tokensBefore: 50000,
    },
  } as unknown as SessionBeforeCompactEvent;
  let handler!: (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => Promise<{ compaction: CompactionResult } | undefined>;
  extension({ on: (_name: string, callback: typeof handler) => { handler = callback; } } as unknown as ExtensionAPI);
  return { run: () => handler(event, ctx), response, complete, streamSimple, notify, controller, model };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("narrative compaction boundary", () => {
  it("uses the authenticated provider-neutral stream and preserves evidence and usage", async () => {
    const f = fixture();
    const result = await f.run();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.streamSimple).toHaveBeenCalledWith(f.model, expect.any(Object), {
      maxTokens: 4096,
      signal: f.controller.signal,
      cacheRetention: "none",
    });
    expect(result?.compaction.summary).toContain("## Goal");
    expect(result?.compaction.summary).toContain("## Verbatim Tool Evidence");
    expect(result?.compaction.firstKeptEntryId).toBe("kept-entry");
    expect(result?.compaction.usage).toEqual(f.response.usage);
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("preserves the provider error in the fallback warning", async () => {
    const f = fixture("error", "server_error: connection lost mid-reply (unexpected EOF)");
    expect(await f.run()).toBeUndefined();
    expect(f.notify).toHaveBeenCalledWith(
      expect.stringContaining("narrative summary failed (error): server_error: connection lost mid-reply (unexpected EOF)"),
      "warning",
    );
  });

  it("still falls back when the provider supplies no error detail", async () => {
    const f = fixture("error");
    expect(await f.run()).toBeUndefined();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("narrative summary failed (error)"), "warning");
  });

  it("rejects partial text when the provider aborted the summary", async () => {
    const f = fixture("aborted", "Operation aborted");
    expect(await f.run()).toBeUndefined();
  });

  it("does not publish a summary after the compaction signal was cancelled", async () => {
    const f = fixture();
    f.streamSimple.mockImplementation(() => ({
      result: async () => { f.controller.abort(); return f.response; },
    }));
    expect(await f.run()).toBeUndefined();
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("rejects a truncated summary with a useful token-cap reason", async () => {
    const f = fixture("length");
    expect(await f.run()).toBeUndefined();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("token cap"), "warning");
  });

  it("respects the active model's output limit", async () => {
    const f = fixture();
    f.model.maxTokens = 1024;
    await f.run();
    expect(f.streamSimple).toHaveBeenCalledWith(f.model, expect.any(Object), expect.objectContaining({ maxTokens: 1024 }));
  });

  it("rejects an empty summary", async () => {
    const f = fixture();
    f.response.content = [{ type: "text", text: "  " }];
    expect(await f.run()).toBeUndefined();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("narrative summary was empty"), "warning");
  });

  it("falls back when the stream throws instead of returning an error response", async () => {
    const f = fixture();
    f.streamSimple.mockImplementation(() => ({
      result: async () => { throw new Error("Connection error."); },
    }));
    expect(await f.run()).toBeUndefined();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining("Connection error."), "warning");
  });
});
