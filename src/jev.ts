import type { CallAnswer, JevQuestion, JevState, ToolCall } from "./core.js";
import { questionsFor } from "./core.js";

const SYSTEM_ONE_URL = "https://api.typesafe.ai/v1/systemone";

export type Fetcher = typeof fetch;

function readAnswer(value: unknown, key: string): number {
  if (
    typeof value !== "object" ||
    value === null ||
    !("noul" in value) ||
    typeof value.noul !== "number" ||
    !Number.isFinite(value.noul) ||
    value.noul < 0 ||
    value.noul > 1
  ) {
    throw new Error(`Invalid Jev answer for ${key}`);
  }
  return value.noul;
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal | undefined;
  didTimeout: () => boolean;
  dispose: () => void;
} {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    return { signal, didTimeout: () => false, dispose: () => {} };
  }
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    },
  };
}

async function readErrorBody(response: Response, limit = 200): Promise<string> {
  if (!response.body) return (await response.text()).slice(0, limit);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text.slice(0, limit);
  } finally {
    await reader.cancel();
  }
}

export async function askJev(
  fetcher: Fetcher,
  apiKey: string,
  state: JevState,
  calls: readonly ToolCall[],
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<Map<string, CallAnswer>> {
  const questions: Record<string, JevQuestion> = Object.assign({}, ...calls.map(questionsFor));
  const request = requestSignal(signal, timeoutMs);
  try {
    const response = await fetcher(SYSTEM_ONE_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "jev-latest", state, questions }),
      signal: request.signal,
    });
    if (!response.ok) {
      throw new Error(`Jev request failed (${response.status}): ${await readErrorBody(response)}`);
    }
    const body = await response.text();

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error("Jev returned malformed JSON");
    }
    if (typeof parsed !== "object" || parsed === null || !("answers" in parsed)) {
      throw new Error("Jev response is missing answers");
    }
    const answers = parsed.answers as Record<string, unknown>;
    if (typeof answers !== "object" || answers === null) {
      throw new Error("Jev response has invalid answers");
    }

    return new Map(
      calls.map((call) => [
        call.id,
        {
          keepCall: readAnswer(answers[`call_${call.id}`], `call_${call.id}`),
          keepResult: readAnswer(answers[`result_${call.id}`], `result_${call.id}`),
        },
      ]),
    );
  } catch (error) {
    if (request.didTimeout()) throw new Error(`Jev request timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    request.dispose();
  }
}
