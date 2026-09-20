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

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

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
  let tokens = 0;
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const code = piece.charCodeAt(0);
    if (code >= 48 && code <= 57) tokens += piece.length / 2;
    else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6);
    } else tokens += 0.9;
  }
  return Math.ceil(tokens);
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

export function renderEvidence(
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  headChars: number,
): { text: string; candidateChars: number; keptChars: number } {
  const decisionById = new Map(decisions.map((decision) => [decision.id, decision]));
  const sections: string[] = [];
  let candidateChars = 0;
  let keptChars = 0;

  for (const call of calls) {
    candidateChars += call.result.length;
    const decision = decisionById.get(call.id);
    if (!decision || decision.action === "drop_call") continue;
    const result =
      decision.action === "keep"
        ? call.result
        : truncateResult(call.result, call.isError, headChars);
    keptChars += result.length;
    sections.push([
      `### ${call.tool} (${call.id})`,
      "",
      "Arguments:",
      "```json",
      JSON.stringify(call.input, null, 2),
      "```",
      "",
      `Result${call.isError ? " (error)" : ""}:`,
      "````text",
      result,
      "````",
    ].join("\n"));
  }

  return {
    text: sections.length > 0 ? `## Verbatim Tool Evidence\n\n${sections.join("\n\n")}` : "",
    candidateChars,
    keptChars,
  };
}
