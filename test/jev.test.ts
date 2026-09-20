import { describe, expect, it } from "vitest";
import { askJev } from "../src/jev.js";
import { buildState, collectToolCalls, type MessageLike } from "../src/core.js";

const messages: MessageLike[] = [
  { role: "user", content: "Check the build." },
  { role: "assistant", content: [{ type: "toolCall", id: "bash-1", name: "bash", arguments: { command: "npm test" } }] },
  { role: "toolResult", toolCallId: "bash-1", toolName: "bash", content: [{ type: "text", text: "FAIL" }], isError: true },
];

describe("Jev HTTP transport", () => {
  it("sends both decision questions and parses probabilities", async () => {
    const calls = collectToolCalls(messages);
    const state = buildState(messages, calls, 1000);
    let request: RequestInit | undefined;
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({
        answers: {
          call_t1: { noul: 0.8 },
          result_t1: { noul: 0.2 },
        },
      }), { status: 200 });
    }) as typeof fetch;

    const answers = await askJev(fetcher, "secret", state, calls);
    expect(request?.headers).toMatchObject({ authorization: "Bearer secret" });
    expect(JSON.parse(String(request?.body))).toMatchObject({
      model: "jev-latest",
      questions: { call_t1: { type: "noul" }, result_t1: { type: "noul" } },
    });
    expect(answers.get("t1")).toEqual({ keepCall: 0.8, keepResult: 0.2 });
  });

  it("rejects malformed answers instead of making a deletion decision", async () => {
    const calls = collectToolCalls(messages);
    const state = buildState(messages, calls, 1000);
    const fetcher = (async () => new Response(JSON.stringify({ answers: { call_t1: { noul: 1 } } }), { status: 200 })) as typeof fetch;
    await expect(askJev(fetcher, "secret", state, calls)).rejects.toThrow("Invalid Jev answer for result_t1");
  });

  it("rejects probabilities outside the Jev probability range", async () => {
    const calls = collectToolCalls(messages);
    const state = buildState(messages, calls, 1000);
    const fetcher = (async () => new Response(JSON.stringify({ answers: {
      call_t1: { noul: 2 }, result_t1: { noul: 0.5 },
    } }), { status: 200 })) as typeof fetch;
    await expect(askJev(fetcher, "secret", state, calls)).rejects.toThrow("Invalid Jev answer for call_t1");
  });

  it("caps a non-success response body before adding it to an error", async () => {
    const calls = collectToolCalls(messages);
    const state = buildState(messages, calls, 1000);
    const fetcher = (async () => new Response("x".repeat(500), { status: 500 })) as typeof fetch;
    await expect(askJev(fetcher, "secret", state, calls)).rejects.toThrow(`Jev request failed (500): ${"x".repeat(200)}`);
  });

  it("returns a clear error when the request timeout aborts fetch", async () => {
    const calls = collectToolCalls(messages);
    const state = buildState(messages, calls, 1000);
    const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as typeof fetch;
    await expect(askJev(fetcher, "secret", state, calls, undefined, 5)).rejects.toThrow("Jev request timed out after 5ms");
  });
});
