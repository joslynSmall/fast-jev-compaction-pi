import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import {
  contentText,
  buildState,
  batchCalls,
  collectToolCalls,
  decideCall,
  estimateTokens,
  mapWithConcurrency,
  renderEvidence,
} from "./core.js";
import { askJev } from "./jev.js";

const DEFAULTS = {
  keepThreshold: 0.5,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  maxSummaryTokens: 12_000,
  jevConcurrency: 3,
  jevTimeoutMs: 20_000,
  maxNarrativeTokens: 4_096,
  truncateHeadChars: 300,
  minEvidenceReduction: 0.25,
};

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = numberEnv(name, fallback);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function probabilityEnv(name: string, fallback: number): number {
  const value = numberEnv(name, fallback);
  return value >= 0 && value <= 1 ? value : fallback;
}

function settings() {
  return {
    keepThreshold: probabilityEnv("FAST_JEV_KEEP_THRESHOLD", DEFAULTS.keepThreshold),
    maxStateTokens: positiveIntegerEnv("FAST_JEV_MAX_STATE_TOKENS", DEFAULTS.maxStateTokens),
    maxRequestTokens: positiveIntegerEnv("FAST_JEV_MAX_REQUEST_TOKENS", DEFAULTS.maxRequestTokens),
    maxSummaryTokens: positiveIntegerEnv("FAST_JEV_MAX_SUMMARY_TOKENS", DEFAULTS.maxSummaryTokens),
    jevConcurrency: positiveIntegerEnv("FAST_JEV_CONCURRENCY", DEFAULTS.jevConcurrency),
    jevTimeoutMs: positiveIntegerEnv("FAST_JEV_TIMEOUT_MS", DEFAULTS.jevTimeoutMs),
    truncateHeadChars: Math.max(0, Math.floor(numberEnv("FAST_JEV_TRUNCATE_HEAD_CHARS", DEFAULTS.truncateHeadChars))),
    minEvidenceReduction: probabilityEnv("FAST_JEV_MIN_EVIDENCE_REDUCTION", DEFAULTS.minEvidenceReduction),
  };
}

async function summarizeNarrative(
  state: ReturnType<typeof buildState>,
  previousSummary: string | undefined,
  ctx: ExtensionContext,
  signal: AbortSignal,
  maxTokens: number,
): Promise<{ summary: string; usage: ReturnType<typeof ctx.modelRegistry.complete> extends Promise<infer T> ? T extends { usage: infer U } ? U : never : never }> {
  const model = ctx.model;
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) {
    throw new Error("active Pi model is unavailable for custom compaction");
  }
  const previous = previousSummary ? `\n<previous-summary>\n${previousSummary}\n</previous-summary>\n` : "";
  const prompt = [
    "Create a concise structured context checkpoint for a coding task.",
    "Do not rewrite or infer tool outputs; separate verbatim tool evidence will be attached after this summary.",
    "Preserve exact paths, commands, errors, constraints, completed work, current work, decisions, and next steps.",
    "Use these headings: Goal, Constraints & Preferences, Progress, Key Decisions, Next Steps, Critical Context.",
    previous,
    "<compaction-state>",
    JSON.stringify(state),
    "</compaction-state>",
  ].join("\n");
  const response = await ctx.modelRegistry.complete(
    model,
    {
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { maxTokens, signal, cacheRetention: "none" },
  );
  if (response.stopReason === "error" || response.stopReason === "length") {
    throw new Error(`narrative summary failed (${response.stopReason})`);
  }
  if (response.content.some((block) => block.type === "toolCall")) {
    throw new Error("narrative summary attempted a tool call");
  }
  const summary = contentText(response.content).trim();
  if (!summary) throw new Error("narrative summary was empty");
  return { summary, usage: response.usage };
}

export default function (pi: ExtensionAPI) {
  pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx: ExtensionContext) => {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) return;

    const config = settings();
    const summaryTokenBudget = Math.min(config.maxSummaryTokens, event.preparation.settings.reserveTokens);
    const narrativeTokenBudget = Math.min(DEFAULTS.maxNarrativeTokens, summaryTokenBudget);
    if (narrativeTokenBudget < 1 || summaryTokenBudget - narrativeTokenBudget < 2) return;

    const messages = [...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages];
    const calls = collectToolCalls(messages);
    if (calls.length === 0) return;

    try {
      const state = buildState(messages, calls, config.maxStateTokens);
      const batches = batchCalls(calls, estimateTokens(JSON.stringify(state)), config.maxRequestTokens);
      const answers = new Map<string, { keepCall: number; keepResult: number }>();
      const batchAnswers = await mapWithConcurrency(
        batches,
        config.jevConcurrency,
        (batch) => askJev(fetch, apiKey, state, batch, event.signal, config.jevTimeoutMs),
      );
      for (const batch of batchAnswers) {
        for (const [id, answer] of batch) answers.set(id, answer);
      }

      const decisions = calls.map((call) =>
        decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, config.keepThreshold),
      );
      const narrative = await summarizeNarrative(
        state,
        event.preparation.previousSummary,
        ctx,
        event.signal,
        narrativeTokenBudget,
      );
      const evidenceBudget = summaryTokenBudget - estimateTokens(narrative.summary) - 1;
      const evidence = renderEvidence(calls, decisions, config.truncateHeadChars, evidenceBudget);
      if (!evidence.text || evidence.candidateChars === 0) return;
      const reduction = 1 - evidence.keptChars / evidence.candidateChars;
      if (reduction < config.minEvidenceReduction) return;

      const summary = `${narrative.summary}\n\n${evidence.text}`;
      if (estimateTokens(summary) > summaryTokenBudget) {
        throw new Error("custom compaction exceeds its Pi-aligned summary budget");
      }
      return {
        compaction: {
          summary,
          firstKeptEntryId: event.preparation.firstKeptEntryId,
          tokensBefore: event.preparation.tokensBefore,
          usage: narrative.usage,
          details: {
            scheme: "fast-jev-compaction-pi/v1",
            decisions,
            candidateResultChars: evidence.candidateChars,
            evidenceChars: evidence.keptChars,
            evidenceReduction: reduction,
          },
        },
      };
    } catch (error) {
      if (!event.signal.aborted && ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`fast-jev-compaction-pi fallback: ${message}`, "warning");
      }
      return;
    }
  });
}
