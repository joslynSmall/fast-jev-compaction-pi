export type ToolBlock = {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type MessageLike = {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
};

export type ToolCall = {
  id: string;
  toolCallId: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  messageIndex: number;
};

export type CallAnswer = {
  keepCall: number;
  keepResult: number;
};

export type CallDecision = CallAnswer & {
  id: string;
  tool: string;
  action: "keep" | "drop_result" | "drop_call";
};

export type JevQuestion = {
  type: "noul";
  instructions: string;
};

export type JevState = {
  context: string;
  goal: string;
  history: Array<{
    i: number;
    role: string;
    text: string;
    tool_calls?: Array<{
      id: string;
      tool: string;
      input: string;
      result: string;
    }>;
  }>;
};

export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text?: string } =>
      typeof block === "object" && block !== null && "type" in block,
    )
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n");
}

function toolBlocks(content: unknown): ToolBlock[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block): block is ToolBlock => {
    if (typeof block !== "object" || block === null) return false;
    const candidate = block as Partial<ToolBlock>;
    return (
      candidate.type === "toolCall" &&
      typeof candidate.id === "string" &&
      typeof candidate.name === "string" &&
      typeof candidate.arguments === "object" &&
      candidate.arguments !== null
    );
  });
}

export function collectToolCalls(messages: readonly MessageLike[]): ToolCall[] {
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const message of messages) {
    if (message.role !== "toolResult" || !message.toolCallId) continue;
    results.set(message.toolCallId, {
      text: contentText(message.content),
      isError: message.isError ?? false,
    });
  }

  const calls: ToolCall[] = [];
  messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant") return;
    for (const block of toolBlocks(message.content)) {
      const result = results.get(block.id);
      if (!result) continue;
      calls.push({
        id: `t${calls.length + 1}`,
        toolCallId: block.id,
        tool: block.name,
        input: block.arguments,
        result: result.text,
        isError: result.isError,
        messageIndex,
      });
    }
  });
  return calls;
}

export function estimateTokens(text: string): number {
  // Match Pi's conservative compaction estimate so local limits compose with Pi's budget.
  return Math.ceil(text.length / 4);
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}...`;
}

function abridge(text: string): string {
  if (text.length <= 600) return text;
  return `${text.slice(0, 400)}\n[... ${text.length - 550} chars omitted ...]\n${text.slice(-150)}`;
}

function inputText(input: Record<string, unknown>, limit: number): string {
  try {
    return truncate(JSON.stringify(input), limit);
  } catch {
    return "[unserializable input]";
  }
}

function goalFromMessages(messages: readonly MessageLike[]): string {
  return messages
    .filter((message) => message.role === "user" && contentText(message.content).trim().length > 0)
    .slice(-3)
    .map((message) => truncate(contentText(message.content), 500))
    .join("\n");
}

export function buildState(
  messages: readonly MessageLike[],
  calls: readonly ToolCall[],
  maxTokens: number,
): JevState {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const group = byMessage.get(call.messageIndex) ?? [];
    group.push(call);
    byMessage.set(call.messageIndex, group);
  }

  const makeState = (inputLimit: number, abridgeTexts: boolean): JevState => ({
    context:
      "A coding-agent history is being compacted. Tool outputs are omitted from this state. " +
      "For each question, decide whether the call or its original result must remain available.",
    goal: goalFromMessages(messages),
    history: messages.flatMap((message, i) => {
      if (message.role === "toolResult") return [];
      const callsForMessage = byMessage.get(i) ?? [];
      const text = contentText(message.content);
      if (text.trim().length === 0 && callsForMessage.length === 0) return [];
      return [{
        i,
        role: message.role,
        text: abridgeTexts ? abridge(text) : text,
        ...(callsForMessage.length > 0
          ? {
              tool_calls: callsForMessage.map((call) => ({
                id: call.id,
                tool: call.tool,
                input: inputText(call.input, inputLimit),
                result: `${call.isError ? "error" : "ok"}, ${call.result.length} chars (omitted)`,
              })),
            }
          : {}),
      }];
    }),
  });

  for (const [inputLimit, abridgeTexts] of [
    [1000, false],
    [200, false],
    [60, false],
    [60, true],
  ] as const) {
    const state = makeState(inputLimit, abridgeTexts);
    if (estimateTokens(JSON.stringify(state)) <= maxTokens) return state;
  }
  throw new Error(`Jev state exceeds ${maxTokens} tokens after truncation`);
}

export function questionsFor(call: ToolCall): Record<string, JevQuestion> {
  return {
    [`call_${call.id}`]: {
      type: "noul",
      instructions: `Tool call ${call.id} (${call.tool}) should remain in history: knowing the call occurred and retaining its input still matters to the current task.`,
    },
    [`result_${call.id}`]: {
      type: "noul",
      instructions: `The complete original result of tool call ${call.id} (${call.tool}, ${call.result.length} chars) should remain verbatim: its contents are still needed and rerunning the tool would not be sufficient.`,
    },
  };
}

export function batchCalls(
  calls: readonly ToolCall[],
  stateTokens: number,
  maxRequestTokens: number,
): ToolCall[][] {
  const budget = maxRequestTokens - stateTokens - 20;
  if (budget <= 0) throw new Error("Jev state leaves no room for decision questions");
  const batches: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let currentTokens = 0;
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)));
    if (tokens > budget) throw new Error(`Decision question for ${call.id} exceeds request budget`);
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(call);
    currentTokens += tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function decideCall(
  call: Pick<ToolCall, "id" | "tool">,
  answer: CallAnswer,
  keepThreshold: number,
): CallDecision {
  if (answer.keepResult >= keepThreshold) return { ...call, ...answer, action: "keep" };
  if (answer.keepCall >= keepThreshold) return { ...call, ...answer, action: "drop_result" };
  return { ...call, ...answer, action: "drop_call" };
}

export function truncateResult(text: string, isError: boolean, headChars: number): string {
  if (text.length <= headChars + 120) return text;
  const head = headChars > 0 ? `${text.slice(0, headChars)}\n` : "";
  return `${head}[fast-jev-compaction-pi omitted ${text.length - headChars} chars${
    isError ? " from this error result" : " from this tool result"
  }; re-run the tool if needed]`;
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '"[unserializable input]"';
  }
}

function fenceFor(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

function evidenceSection(call: ToolCall, result: string): string {
  const input = jsonText(call.input);
  const inputFence = fenceFor(input);
  const resultFence = fenceFor(result);
  return [
    `### ${call.tool} (${call.id})`,
    "",
    "Arguments:",
    `${inputFence}json`,
    input,
    inputFence,
    "",
    `Result${call.isError ? " (error)" : ""}:`,
    `${resultFence}text`,
    result,
    resultFence,
  ].join("\n");
}

function renderWithinBudget(
  call: ToolCall,
  isFullResult: boolean,
  headChars: number,
  prefix: string,
  selected: readonly string[],
  maxTokens: number,
): { section: string; result: string } | undefined {
  const candidate = isFullResult
    ? call.result
    : truncateResult(call.result, call.isError, headChars);
  const fits = (result: string) => {
    const section = evidenceSection(call, result);
    const text = [prefix, ...selected, section].join("\n\n");
    return estimateTokens(text) <= maxTokens ? { section, result } : undefined;
  };

  const whole = fits(candidate);
  if (whole) return whole;

  let low = 0;
  let high = Math.min(call.result.length, isFullResult ? call.result.length : headChars);
  let best: { section: string; result: string } | undefined;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const rendered = fits(truncateResult(call.result, call.isError, mid));
    if (rendered) {
      best = rendered;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

export function renderEvidence(
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  headChars: number,
  maxTokens = Number.POSITIVE_INFINITY,
): { text: string; candidateChars: number; keptChars: number } {
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  const prefix = "## Verbatim Tool Evidence";
  const sections = new Map<string, string>();
  let candidateChars = 0;
  let keptChars = 0;

  for (const call of calls) candidateChars += call.result.length;

  const selected = calls
    .map((call, index) => ({ call, decision: decisionById.get(call.id), index }))
    .filter((entry): entry is { call: ToolCall; decision: CallDecision; index: number } =>
      entry.decision !== undefined && entry.decision.action !== "drop_call",
    )
    .sort((left, right) =>
      Number(right.call.isError) - Number(left.call.isError)
      || Number(right.decision.action === "keep") - Number(left.decision.action === "keep")
      || left.index - right.index,
    );

  for (const { call, decision } of selected) {
    const rendered = renderWithinBudget(
      call,
      decision.action === "keep",
      headChars,
      prefix,
      Array.from(sections.values()),
      maxTokens,
    );
    if (!rendered) continue;
    sections.set(call.id, rendered.section);
    keptChars += rendered.result.length;
  }

  const orderedSections = calls.flatMap((call) => {
    const section = sections.get(call.id);
    return section ? [section] : [];
  });
  return {
    text: orderedSections.length > 0 ? `${prefix}\n\n${orderedSections.join("\n\n")}` : "",
    candidateChars,
    keptChars,
  };
}

export async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      results[index] = await mapper(values[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return results;
}
