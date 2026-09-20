import { performance } from "node:perf_hooks";
import {
  batchCalls,
  buildState,
  collectToolCalls,
  decideCall,
  estimateTokens,
  renderEvidence,
  type MessageLike,
} from "../src/core.js";

type BenchmarkOptions = {
  calls: number;
  resultChars: number;
  iterations: number;
};

function option(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

function fixture(options: BenchmarkOptions): MessageLike[] {
  const messages: MessageLike[] = [
    { role: "user", content: "Investigate a test failure without changing generated code." },
  ];
  for (let index = 0; index < options.calls; index += 1) {
    const id = `tool-${index}`;
    messages.push({
      role: "assistant",
      content: [{
        type: "toolCall",
        id,
        name: index % 2 === 0 ? "read" : "bash",
        arguments: index % 2 === 0
          ? { path: `src/module-${index}.ts` }
          : { command: `npm test -- module-${index}` },
      }],
    });
    messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: index % 2 === 0 ? "read" : "bash",
      content: [{ type: "text", text: `${index}: ${"x".repeat(options.resultChars - `${index}: `.length)}` }],
      isError: index % 5 === 0,
    });
  }
  messages.push({ role: "assistant", content: [{ type: "text", text: "The next step is to inspect the retained evidence." }] });
  return messages;
}

function percentile(values: readonly number[], value: number): number {
  return values[Math.min(values.length - 1, Math.ceil(values.length * value) - 1)] ?? 0;
}

const options = {
  calls: option("calls", 100),
  resultChars: option("result-chars", 4_000),
  iterations: option("iterations", 100),
};
const messages = fixture(options);
const samples: number[] = [];
let stateTokens = 0;
let batches = 0;
let candidateChars = 0;
let evidenceChars = 0;

for (let iteration = 0; iteration < options.iterations; iteration += 1) {
  const started = performance.now();
  const calls = collectToolCalls(messages);
  const state = buildState(messages, calls, 25_000);
  const decisions = calls.map((call, index) =>
    decideCall(call, { keepCall: index % 3 === 0 ? 0.9 : 0.1, keepResult: index % 10 === 0 ? 0.9 : 0.1 }, 0.5),
  );
  const evidence = renderEvidence(calls, decisions, 300);
  const elapsed = performance.now() - started;
  samples.push(elapsed);
  stateTokens = estimateTokens(JSON.stringify(state));
  batches = batchCalls(calls, stateTokens, 30_000).length;
  candidateChars = evidence.candidateChars;
  evidenceChars = evidence.keptChars;
}

samples.sort((a, b) => a - b);
console.log(JSON.stringify({
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  scenario: {
    calls: options.calls,
    resultCharsPerCall: options.resultChars,
    candidateResultChars: candidateChars,
    stateTokens,
    requestBatchesAt30kTokenLimit: batches,
    iterations: options.iterations,
    decisions: "10% keep full result, 23% retain call with truncated result, 67% drop call",
  },
  localOnlyMilliseconds: {
    min: Number(samples[0]?.toFixed(3)),
    median: Number(percentile(samples, 0.5).toFixed(3)),
    p95: Number(percentile(samples, 0.95).toFixed(3)),
    max: Number(samples.at(-1)?.toFixed(3)),
  },
  output: {
    evidenceChars,
    evidenceReductionRatio: Number((1 - evidenceChars / candidateChars).toFixed(4)),
  },
  excluded: [
    "Jev HTTP latency and API processing",
    "Pi model narrative-summary latency and usage",
    "Pi session serialization, disk I/O, and terminal rendering",
  ],
}, null, 2));
