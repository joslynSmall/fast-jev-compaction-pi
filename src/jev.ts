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
    !Number.isFinite(value.noul)
  ) {
    throw new Error(`Invalid Jev answer for ${key}`);
  }
  return value.noul;
}

export async function askJev(
  fetcher: Fetcher,
  apiKey: string,
  state: JevState,
  calls: readonly ToolCall[],
  signal?: AbortSignal,
): Promise<Map<string, CallAnswer>> {
  const questions: Record<string, JevQuestion> = Object.assign({}, ...calls.map(questionsFor));
  const response = await fetcher(SYSTEM_ONE_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "jev-latest", state, questions }),
    signal,
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Jev request failed (${response.status}): ${body.slice(0, 200)}`);

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
}
