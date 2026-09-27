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
    tool_calls?: Array<
      | {
          id: string;
          tool: string;
          input: string;
          result: string;
        }
      | string
    >;
  }>;
};

export type FittedState = {
  state: JevState;
  tokens: number;
  stage: string;
  representedCalls: Set<string>;
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

export function isPinned(index: number, total: number, preserveRecentMessages: number): boolean {
  return index === 0 || index >= total - preserveRecentMessages;
}

function compactCallLine(call: ToolCall): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : inputText({ [key]: value }, 200);
      return `${key}=${text.replace(/\s+/g, " ")}`;
    })
    .join(" ");
  return truncate(`${call.id} ${call.tool} ${input} → ${call.isError ? "error" : "ok"} ${call.result.length}ch`, 60);
}

type HistoryEntry = JevState["history"][number];

function representedCallIds(history: readonly HistoryEntry[]): Set<string> {
  const ids = new Set<string>();
  for (const entry of history) {
    for (const call of entry.tool_calls ?? []) {
      ids.add(typeof call === "string" ? (call.split(" ", 1)[0] ?? "") : call.id);
    }
  }
  return ids;
}

function mergeCallRuns(history: readonly HistoryEntry[], pinned: (e: HistoryEntry) => boolean): HistoryEntry[] {
  const merged: HistoryEntry[] = [];
  for (const entry of history) {
    const previous = merged[merged.length - 1];
    const foldable = (e: HistoryEntry): boolean =>
      !pinned(e) && e.text.length === 0 && typeof e.tool_calls?.[0] === "string";
    if (previous && foldable(previous) && foldable(entry) && previous.role === entry.role) {
      previous.tool_calls = [...(previous.tool_calls as string[]), ...(entry.tool_calls as string[])];
      continue;
    }
    merged.push({ ...entry });
  }
  return merged;
}

/**
 * Builds the Jev state and shrinks it in stages until it fits `maxTokens`:
 * tool inputs are truncated, then long texts are abridged oldest-first, then
 * old messages collapse to a one-line note, then old tool calls shrink to one
 * line each, then old messages that carry no call are left out, then runs of
 * old call-only messages are folded, and finally whole entries are left out
 * oldest-first. Calls those entries carried are reported as unrepresented
 * rather than scored blind, so the state always fits; only a state whose
 * fixed envelope alone exceeds the limit throws.
 */
export function fitState(
  messages: readonly MessageLike[],
  calls: readonly ToolCall[],
  maxTokens: number,
  preserveRecentMessages = 0,
  goal?: string,
): FittedState {
  const byMessage = new Map<number, ToolCall[]>();
  for (const call of calls) {
    const group = byMessage.get(call.messageIndex) ?? [];
    group.push(call);
    byMessage.set(call.messageIndex, group);
  }
  const resolvedGoal = goal || goalFromMessages(messages);
  const context =
    "A coding-agent history is being compacted. Tool outputs are omitted from this state. " +
    "For each question, decide whether the call or its original result must remain available.";
  const stateOf = (history: HistoryEntry[]): JevState => ({ context, goal: resolvedGoal, history });
  const entryTokens = (entry: HistoryEntry): number => estimateTokens(JSON.stringify(entry)) + 1;
  const baseTokens = estimateTokens(JSON.stringify(stateOf([])));
  const fitted = (history: HistoryEntry[], tokens: number, stage: string): FittedState => ({
    state: stateOf(history),
    tokens,
    stage,
    representedCalls: representedCallIds(history),
  });

  const buildEntries = (inputLimit: number): HistoryEntry[] =>
    messages.flatMap((message, i) => {
      if (message.role === "toolResult") return [];
      const callsForMessage = byMessage.get(i) ?? [];
      const text = contentText(message.content);
      if (text.trim().length === 0 && callsForMessage.length === 0) return [];
      const entry: HistoryEntry = { i, role: message.role, text };
      if (callsForMessage.length > 0) {
        entry.tool_calls = callsForMessage.map((call) => ({
          id: call.id,
          tool: call.tool,
          input: inputText(call.input, inputLimit),
          result: `${call.isError ? "error" : "ok"}, ${call.result.length} chars (omitted)`,
        }));
      }
      return [entry];
    });

  let history: HistoryEntry[] = [];
  let perEntry: number[] = [];
  let tokens = 0;
  const rebuild = (inputChars: number): void => {
    history = buildEntries(inputChars);
    perEntry = history.map(entryTokens);
    tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  };
  const fits = (): boolean => tokens <= maxTokens;
  const shrink = (index: number, change: (entry: HistoryEntry) => void): void => {
    const entry = history[index];
    if (!entry) return;
    change(entry);
    const now = entryTokens(entry);
    tokens += now - (perEntry[index] ?? 0);
    perEntry[index] = now;
  };

  const INPUT_LIMITS = [1000, 200, 60] as const;
  rebuild(INPUT_LIMITS[0]);
  if (fits()) return fitted(history, tokens, "full");
  for (const limit of INPUT_LIMITS.slice(1)) {
    rebuild(limit);
    if (fits()) return fitted(history, tokens, `inputs<=${limit}`);
  }

  const pinned = (entry: HistoryEntry): boolean => isPinned(entry.i, messages.length, preserveRecentMessages);
  const indices = history.map((_, index) => index);
  const order = [...indices.filter((index) => !pinned(history[index]!)), ...indices.filter((index) => pinned(history[index]!))];

  for (const index of order) {
    const entry = history[index]!;
    if (entry.text.length <= 600) continue;
    shrink(index, (e) => {
      e.text = abridge(e.text);
    });
    if (fits()) return fitted(history, tokens, "texts abridged");
  }

  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.text.length === 0) continue;
    const original = contentText(messages[entry.i]?.content).length || entry.text.length;
    shrink(index, (e) => {
      e.text = `[… ${original} chars omitted …]`;
    });
    if (fits()) return fitted(history, tokens, "old messages collapsed");
  }

  for (const index of order) {
    const entry = history[index]!;
    const own = byMessage.get(entry.i);
    if (pinned(entry) || !own) continue;
    shrink(index, (e) => {
      e.tool_calls = own.map(compactCallLine);
    });
    if (fits()) return fitted(history, tokens, "old calls compacted");
  }

  const left = new Set<number>();
  for (const index of order) {
    const entry = history[index]!;
    if (pinned(entry) || entry.tool_calls) continue;
    left.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !left.has(i)),
        tokens,
        "old messages left out",
      );
    }
  }

  history = mergeCallRuns(
    history.filter((_, i) => !left.has(i)),
    pinned,
  );
  perEntry = history.map(entryTokens);
  tokens = baseTokens + perEntry.reduce((sum, n) => sum + n, 0);
  if (fits()) return fitted(history, tokens, "old calls merged");

  const dropOrder = [
    ...history.map((_, index) => index).filter((index) => !pinned(history[index]!)),
    ...history.map((_, index) => index).filter((index) => pinned(history[index]!)),
  ];
  const dropped = new Set<number>();
  for (const index of dropOrder) {
    dropped.add(index);
    tokens -= perEntry[index] ?? 0;
    if (fits()) {
      return fitted(
        history.filter((_, i) => !dropped.has(i)),
        tokens,
        "old entries left out",
      );
    }
  }

  throw new Error(`Jev state envelope alone is ~${tokens} tokens, over the ${maxTokens} limit`);
}

export function buildState(
  messages: readonly MessageLike[],
  calls: readonly ToolCall[],
  maxTokens: number,
): JevState {
  return fitState(messages, calls, maxTokens).state;
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

/** Roughly 15k tokens of call metadata per window, inside Jev's 32k window. */
export const DEFAULT_MAX_WINDOW_CHARS = 60_000;

/**
 * Splits calls into consecutive windows bounded by `maxChars` of estimated
 * metadata, so each window's Jev state stays small and independently fittable.
 * A single call larger than the window still forms its own window.
 */
export function splitIntoWindows(
  calls: readonly ToolCall[],
  maxChars: number,
): ToolCall[][] {
  const sizeOf = (call: ToolCall): number =>
    JSON.stringify(call.input).length + call.tool.length + String(call.result.length).length + 32;
  const windows: ToolCall[][] = [];
  let current: ToolCall[] = [];
  let size = 0;
  for (const call of calls) {
    const chars = sizeOf(call);
    if (current.length > 0 && size + chars > maxChars) {
      windows.push(current);
      current = [];
      size = 0;
    }
    current.push(call);
    size += chars;
  }
  if (current.length > 0) windows.push(current);
  return windows;
}

/**
 * Folds per-window decisions into one list. Ids are already globally unique
 * (`t1..tn` assigned once by `collectToolCalls`), so no prefixing is needed.
 */
export function mergeDecisions(windows: readonly (readonly CallDecision[])[]): CallDecision[] {
  return windows.flat();
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
  spilled?: ReadonlyMap<string, string>,
): { section: string; result: string } | undefined {
  const candidate = isFullResult
    ? call.result
    : (spilled?.get(call.id) ?? truncateResult(call.result, call.isError, headChars));
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
  spilled?: ReadonlyMap<string, string>,
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
      spilled,
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
