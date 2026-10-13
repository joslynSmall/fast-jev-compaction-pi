import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import {
  batchCalls,
  collectToolCalls,
  contentText,
  decideCall,
  estimateTokens,
  fitState,
  mapWithConcurrency,
  renderEvidence,
  splitIntoWindows,
} from "./core.js";
import { askJev } from "./jev.js";
import { isSpillNotice, spillPayload } from "./spill.js";

const DEFAULTS = {
  keepThreshold: 0.5,
  maxStateTokens: 25_000,
  maxRequestTokens: 30_000,
  maxSummaryTokens: 12_000,
  jevConcurrency: 3,
  jevTimeoutMs: 20_000,
  maxWindowChars: 60_000,
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
    maxWindowChars: positiveIntegerEnv("FAST_JEV_MAX_WINDOW_CHARS", DEFAULTS.maxWindowChars),
    truncateHeadChars: Math.max(0, Math.floor(numberEnv("FAST_JEV_TRUNCATE_HEAD_CHARS", DEFAULTS.truncateHeadChars))),
    minEvidenceReduction: probabilityEnv("FAST_JEV_MIN_EVIDENCE_REDUCTION", DEFAULTS.minEvidenceReduction),
  };
}

import type { JevState } from "./core.js";

async function summarizeNarrative(
  state: JevState,
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
  const response = await ctx.modelRegistry.streamSimple(
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
    {
      maxTokens: Math.min(maxTokens, model.maxTokens > 0 ? model.maxTokens : maxTokens),
      signal,
      cacheRetention: "none",
    },
  ).result();
  if (signal.aborted || response.stopReason === "aborted") {
    throw new Error("narrative summary aborted");
  }
  if (response.stopReason === "error" || response.stopReason === "length") {
    const detail = response.errorMessage || (response.stopReason === "length"
      ? "generation hit the token cap and the summary is incomplete"
      : "provider returned no error detail");
    throw new Error(`narrative summary failed (${response.stopReason}): ${detail}`);
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

    let diag = "n/a";
    try {
      // Narrative + diagnostics use a state fitted over everything; it always
      // fits now (fitState degrades instead of throwing) and never asks blind.
      const fittedAll = fitState(messages, calls, config.maxStateTokens);
      diag = `state=${fittedAll.tokens} stage=${fittedAll.stage} calls=${calls.length}`;
      const state = fittedAll.state;
      // Score per window so each Jev request carries a small state: a call the
      // fitted window state had to leave out cannot be judged from it, so it
      // stays unscored and keeps its output verbatim (fail safe, never blind).
      const windows = splitIntoWindows(calls, config.maxWindowChars);
      const perWindow = await mapWithConcurrency(
        windows,
        config.jevConcurrency,
        async (window) => {
          const fitted = windows.length > 1 ? fitState(messages, window, config.maxStateTokens) : fittedAll;
          const scorable = window.filter((call) => fitted.representedCalls.has(call.id));
          const batches = scorable.length > 0 ? batchCalls(scorable, fitted.tokens, config.maxRequestTokens) : [];
          const answers = new Map<string, { keepCall: number; keepResult: number }>();
          const batchAnswers = await mapWithConcurrency(
            batches,
            1,
            (batch) => askJev(fetch, apiKey, fitted.state, batch, event.signal, config.jevTimeoutMs),
          );
          for (const batch of batchAnswers) {
            for (const [id, answer] of batch) answers.set(id, answer);
          }
          return { answers, requests: batches.length, stateTokens: fitted.tokens, unscored: window.length - scorable.length };
        },
      );
      const answers = new Map<string, { keepCall: number; keepResult: number }>();
      let requests = 0;
      let unscored = 0;
      let maxWindowStateTokens = fittedAll.tokens;
      for (const outcome of perWindow) {
        for (const [id, answer] of outcome.answers) answers.set(id, answer);
        requests += outcome.requests;
        unscored += outcome.unscored;
        maxWindowStateTokens = Math.max(maxWindowStateTokens, outcome.stateTokens);
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
      // Park dropped payloads on disk so truncation stays recoverable with one
      // read. A read-only or full disk must not cost the turn: fall back to the
      // inline note. `FAST_JEV_SPILL=0` restores the old inline-only behavior.
      const spilled = new Map<string, string>();
      if (process.env.FAST_JEV_SPILL !== "0") {
        const decisionById = new Map(decisions.map((d) => [d.id, d]));
        for (const call of calls) {
          if (decisionById.get(call.id)?.action !== "drop_result") continue;
          if (call.result.length <= config.truncateHeadChars + 120) continue;
          if (isSpillNotice(call.result)) continue;
          try {
            const { notice } = spillPayload(call.result);
            const head = config.truncateHeadChars > 0 ? `${call.result.slice(0, config.truncateHeadChars)}\n` : "";
            spilled.set(call.id, `${head}${notice}`);
          } catch {
            continue;
          }
        }
      }
      const evidence = renderEvidence(calls, decisions, config.truncateHeadChars, evidenceBudget, spilled);
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
            stateStage: fittedAll.stage,
            stateTokens: fittedAll.tokens,
            windows: windows.length,
            requests,
            unscored,
          },
        },
      };
    } catch (error) {
      if (!event.signal.aborted && ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`fast-jev-compaction-pi fallback: ${message} (${diag})`, "warning");
      }
      return;
    }
  });
}
