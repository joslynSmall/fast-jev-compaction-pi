# Plan: fast-jev-compaction-pi 1000k  robustness (port omp 4件套)

Goal: 让 `fast-jev-compaction-pi` 在 1000k 会话下压缩成功，不再 `Jev state exceeds 25000 after truncation` 后连带 Pi 原生总结撞帽。做法：移植 omp-jev-compaction 已验证的 4 件套——`fitState` 七级降级、分窗评分、spill 可恢复、诊断 + 连续缩减预研。

Architecture: 保持现有 `session_before_compact -> collect/build/batch/ask/decide/render` 流水线不变，只换掉三处 owner：`core.buildState`（全量或全丢）-> `fitState`（渐进降级 + representedCalls）；`index` 单 state 全量 -> 按 60k chars 分窗 + merge；`renderEvidence` 截断丢弃 -> spill 落盘可恢复。第 4 点只做开关 + 日志，不动 Pi session tree。

Tech Stack: TypeScript ESM, Node 18+, vitest, tsx benchmark, Pi `0.86.0` extension API (`session_before_compact`), TypeSafe SystemOne `jev-latest` (`noul`)。

Baseline/Authority Refs:
- 本仓 `README.md`（扩展语义、预算 25k/30k/12k、fallback 不阻断）
- 本仓 `src/core.ts:145-195 buildState`（4级后 throw，根因）、`src/index.ts:101-169`（fallback 交回原生）、`src/jev.ts:68-122`（接口无辜）
- omp `src/vendor/fast-jev/state.ts:231-365 fitState`、`compact.ts:277-334`（unscored keep）、`src/context.ts:218-300 splitIntoWindows/buildReplacements`、`src/hook.ts:152-234 jevCompaction/mergeResults`、`tests/oversized-history.test.ts`（400 turns 期望）
- Claude Code `compactConversation + truncateHeadForPTLRetry`（按 API round 丢最老重试，summary+tail+文件重读）

Compatibility Boundary:
- Pi `SessionManager` append-only，不改 session tree、不改切点算法、不改 JSONL，只返回 `{summary, firstKeptEntryId, tokensBefore, usage, details}`。
- 外部行为保持 fail-soft：缺 key、无调用、Jev 失败、预算不足、缩减不足一律 `return undefined` 交回 Pi，不抛给用户。
- `TYPESAFE_API_KEY` 只读 env，不存盘；新增 env 全带默认值，旧配置零迁移。
- `compactionSummary` 仍是单 string，`## Verbatim Tool Evidence` 区块格式不变，只是内容来源变稳。

TDD Route:
- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Strict signals: 无（修的是本地降级策略，非共享契约/持久化/权限）
- Light eligibility: —
- TDD-fit exception: —
- Test posture: post-change regression（oversized 400-turns 回归 + 现有 vitest）
- Reason: 用户未显式要求 strict，Aegis TDD mode off，风险用回归测试覆盖即可。
- Verification: `npm run typecheck && npm test && npm run benchmark -- --calls 2000 --result-chars 4000`

Verification (global): `npm run typecheck` 零错；`npm test` 全绿（含新增 oversized）；`npm run benchmark` 本地路径 P95 < 5ms 量级且证据缩减可观测；400-turns 合成会话 `fitState.tokens<=25000 && unscored>=0 && 不 throw`。

Requirement Ready Check:
- Requirement source refs: 本会话 4 点（fitState/分窗/spill/诊断+连续预研）+ 线上两报错。
- Goals and scope refs: 1000k 可压成功；25k 判定预算内永不 throw（除 envelope 自超）；分窗后 unscored=0（compaction 层）或显式 keep。
- User / scenario refs: 1000k 上下文自动压缩用户，工具证据（测试日志/报错）优先保留。
- Requirement item refs: P0 fitState / P1 windowing / P2 spill / P3 observability+continuous 预研。
- Acceptance / verification criteria refs: oversized 400-turns 不 throw；hook 层 requests>1 且 reduction>0.2（合成低分 asker）；现有 22 类测试语义不退化。
- Open blocker questions: 无，spill 目录默认放 `~/.pi/jev-spill/` 还是仓内可配？默认前者，可配（见 Task 3）。
- Decision: ready

Change Necessity:
- User-visible need: 1000k 会话自动压缩成功，会话不卡死，重要报错日志仍逐字保留。
- No-change / non-code option: 调大 `FAST_JEV_MAX_STATE_TOKENS=100000` 可缓解小超，但 4000 条调用仍挂且 Jev 成本爆炸；等 Pi 原生修 1000k 总结不可控。均不足。
- Why code change is necessary: 根因在 `core.buildState` 全量或全丢 + 单 state 全量重发 + 截断不可恢复，三处都是本地 owner，无配置可绕。
- Minimum change boundary: `src/core.ts`（fitState+windowing 纯函数）、`src/index.ts`（分窗编排+spill 接线+日志）、新增 `src/spill.ts` + `test/oversized.test.ts`。不动 `src/jev.ts` 协议。
- Decision: code-change

Existence Check: 无新增 owner/skill/artifact 分发面。`spill` 复用 omp 语义（hash 文件 + notice），属现有 pattern 移植；`sticky/context` 连续缩减本计划只做预研开关，不新增常驻 owner。Decision: reuse-existing。

Architecture Integrity Lens:
- 不变量：fail-soft + append-only + 单 summary string。
- Canonical owner：`buildState` 是判定输入 owner，`renderEvidence` 是证据输出 owner，`index` 是编排 owner，不越位到 `jev.ts` 改协议。
- 无 caller-side fallback 新增，只是把必 throw 改成分级降级；无重复 owner。
- Verdict: proceed。

Complexity Budget:
- Artifact class: Pi extension（小仓，src 3 文件 ~680 行）。
- Target files: `src/core.ts` (~388 行)、`src/index.ts` (~170 行)、新增 `src/spill.ts` (~60 行)。
- Current pressure: `core.ts` 中度（纯函数集中），`index.ts` 轻。
- Projected: `core.ts` +~120 行（fitState 状态机）有膨胀风险，用抽 helper + 复用 omp 分级函数控制；`index.ts` +~40 行分窗循环。
- Budget result: at-risk（core 增函数多但皆纯函数可测）。
- Planned governance: fitState 按 omp 切 `entryTokens/rebuild/shrink/order` 小函数，不在 `buildState` 里堆 if；沿用现有 `estimateTokens=len/4` 不换 tokenizer。

Files:
- 修改 `src/core.ts`：保留 `collectToolCalls/estimateTokens/decideCall/renderEvidence` 签名；新增 `fitState/representedCalls/FittedState/splitIntoWindows/mergeResults/compactCall/abridge`，`buildState` 改为 `fitState` 薄包装（兼容旧 import）。
- 修改 `src/index.ts`：`buildState+batches` 改为 `fitState -> scorable过滤 -> batchCalls -> askJev -> decisions`；compaction region 超窗时按 60k chars 分窗多 `compact` 再 merge；`renderEvidence` 前接 spill；fallback `notify` 带 `stateTokens/calls/messages/stage`。
- 新增 `src/spill.ts`：`spillPayload(dir, text)->{hash, notice}` + `isSpillNotice`，默认 `~/.pi/jev-spill/`，`FAST_JEV_SPILL=0` 关闭。
- 新增 `test/oversized.test.ts`：移植 omp `oversized-history.test.ts` 三断言（fit 不抛/新旧取舍/unscored keep）。
- 修改 `README.md`：补分窗/spill/诊断日志 + `FAST_JEV_MAX_WINDOW_CHARS/FAST_JEV_SPILL*` 三变量。
- 不碰 `src/jev.ts`、`package.json` 依赖（除非 spill 需 node:crypto，已内置）。

Execution Readiness View:
- Intent Lock: 1000k 可压，证据逐字优先，fail-soft 不变。
- Scope Fence: 只动判定输入+编排+证据落盘；不改 Pi 触发时机、不改 session tree、不改 Jev 协议、不做连续 context 常驻（P3 只预研）。
- Baseline Lock: 上述 Baseline Refs 锁定；`estimateTokens=len/4` 不变。
- Approved Behavior: oversized 不 throw；低分 asker 下 reduction>0.2（合成）；spill 关时行为回退到现有 note。
- Owner / Contract Constraints: `collect/decide/render` 签名稳定；`details` 追加 `stage/unscored/windows/spill` 不删旧字段。
- Compatibility Boundary: 见上。
- Retirement Boundary: 旧 `buildState throw` 路径删除，无保留；`truncateResult` 文案保留（spill 关时用）。
- Task Batches: T1 fitState -> T2 windowing -> T3 spill -> T4 docs/bench（T1/T2 可并行起草，合入顺序 T1先）。
- Test Obligations: `typecheck + vitest + benchmark(2000 calls)`；oversized 三断言必过。
- Review Gates: 每 Task 一次自查（签名/预算/无占位）；T1 后跑全量测试。
- Drift / Rewind Rules: 若 Pi 升级改 `session_before_compact` 结构，停手回本计划；若 Jev 改 `noul` 协议，停手（`jev.ts` 外）。
- Evidence Required Before Completion: oversized 日志 + benchmark P95 + fallback notify 样例。
- Advisory Boundary: 本计划只给实现切片与验证，不授予完成权威。

Tasks:

Task 1 — P0 fitState 七级降级（替代 throw）
Files: 修改 `src/core.ts`；新增 `test/oversized.test.ts` 前两用例；验证 `npm run typecheck && npx vitest run test/oversized.test.ts`。
Why: 根因修复，没有它 1000k 必 fallback。
Change Necessity: 同全局，最小边界 `core.ts` 纯函数。
Impact/Compatibility: `buildState(messages,calls,maxTokens)` 保留为 `fitState(...).state` 薄包装，老 import 不坏；`estimateTokens` 不变。
Verification: oversized 400-turns `tokens<=25000 && stage='old entries left out' && 新est含、老不含`。
Steps:
1. 在 `src/core.ts` 追加（照抄 omp `state.ts` 语义，token 函数换成本仓 `estimateTokens`）：
```ts
export type FittedState = { state: JevState; tokens: number; stage: string; representedCalls: Set<string> };
const INPUT_CHARS = [1000, 200, 60] as const;
const TEXT_HEAD = 400, TEXT_TAIL = 150;
function compactCallLine(call: ToolCall): string {
  const input = Object.entries(call.input).map(([k,v]) => `${k}=${String(typeof v==='string'?v:JSON.stringify(v)).replace(/\s+/g,' ')}`).join(' ');
  const s = `${call.id} ${call.tool} ${input} → ${call.isError?'error':'ok'} ${call.result.length}ch`;
  return s.length<=62 ? s : s.slice(0,61)+'…';
}
export function fitState(messages: readonly MessageLike[], calls: readonly ToolCall[], maxTokens: number, preserveRecent: number, goal?: string): FittedState {
  // 1) rebuild(inputLimit) x3 -> fits return 'full'/'inputs<=N'
  // 2) abridge oldest-first -> 'texts abridged'
  // 3) 旧消息折叠 `[… N chars omitted …]` -> 'old messages collapsed'
  // 4) 旧调用 one-line -> 'old calls compacted'
  // 5) 无调用旧消息 left out -> 'old messages left out'
  // 6) mergeCallRuns -> 'old calls merged'
  // 7) 整条目 oldest-first left out，记录 representedCalls -> 'old entries left out'
  // 8) 仍超才 throw `envelope alone ~N over M`
}
export function splitIntoWindows<T>(items: readonly T[], maxChars: number, sizeOf:(t:T)=>number, canSplitBefore:(t:T)=>boolean): T[][] { /* 按 size 累加、可 split 点切分 */ }
```
2. `buildState` 改为：`return fitState(messages,calls,maxTokens,0).state;`（先保兼容，调用方后续传 preserveRecent）。
3. 新增 `test/oversized.test.ts`（合成 400 turns，与 omp 同形，result 3000 chars）：
```ts
import { describe, expect, it } from "vitest";
import { collectToolCalls, fitState } from "../src/core.js";
// oversized(400) 构造略；断言 tokens<=25000 && stage==='old entries left out' && represented含新不含旧
```
4. 运行 `npm run typecheck && npx vitest run test/oversized.test.ts`，期望全绿。
5. 若 `envelope alone` 抛，接受（单条消息超 25k 属配置问题，调大 `FAST_JEV_MAX_STATE_TOKENS`）。

Task 2 — P1 分窗评分 + unscored keep（hook/index 层）
Files: 修改 `src/core.ts`（`batchCalls` 返回 + `unscored` 语义）、`src/index.ts`（分窗编排+merge）；复用 Task1 测试加第三用例。
Why: 单 state 装不下 400 calls 时全量问 Jev 既贵又必超 30k request 预算。
Change Necessity: 最小边界编排层，不改协议；`batchCalls` 单 question 超预算仍 throw（真装不下，非策略问题）。
Impact/Compatibility: `details` 追加 `windows/requests/unscored/stage`；旧字段保留。
Verification: 合成低分 asker（noul=0.05）下 `calls=400, unscored>=0, dropped>0 且 dropped⊆asked, requests>1`。
Steps:
1. `src/core.ts` 新增：
```ts
export function mergeDecisions(windows: {decisions: CallDecision[]}[]): CallDecision[] {
  return windows.flatMap((w,i)=> w.decisions.map(d=> windows.length>1?{...d,id:`w${i+1}.${d.id}`}:d));
}
```
2. `src/index.ts` 把 `const state=buildState(...); const batches=batchCalls(...)` 换成：
```ts
import { fitState, splitIntoWindows } from "./core.js";
const MAX_WINDOW = Number(process.env.FAST_JEV_MAX_WINDOW_CHARS ?? 60000);
const wins = splitIntoWindows(calls, MAX_WINDOW, c=>JSON.stringify(c).length, ()=>true);
// 每窗独立 fitState(windowMessages, windowCalls) -> scorable=represented∩candidates -> batchCalls -> askJev -> 合并 answers
// unscored（被 fit 丢掉的老调用）decisions 置 {keepCall:1,keepResult:1} 即 keep，不盲删
```
3. 测试加 `compact 400` 用例（fake asker 全回 0.05），断言上文 Verification 行。
4. 运行 `npm test`，期望 requests>1 且证据 reduction>0（合成全低分时）。
5. fallback notify 改为 `fast-jev-compaction-pi fallback: ${msg} (state=${tokens} calls=${n} stage=${stage})`，方便下次盲调。

Task 3 — P2 spill 可恢复截断
Files: 新增 `src/spill.ts`；修改 `src/core.ts:renderEvidence` 调用点（`src/index.ts:138` 前）；新增 `test/spill.test.ts`；`README` 补 env。
Why: 没 spill 就不敢截，截了就永久丢，这是你“截断丢上下文”担心的实体解。
Change Necessity: 最小边界输出层；`FAST_JEV_SPILL=0` 时行为与今天完全一致。
Impact/Compatibility: 默认开 spill 时 evidence 里是 `head + [spill ~/.pi/jev-spill/<sha>.txt]`，agent 一 read 即回；同 payload 同 hash 复用。
Verification: `spill.test.ts` 断言同内容同文件、notice 含路径、`enabled=false` 回退旧文案。
Steps:
1. 新增 `src/spill.ts`：
```ts
import { createHash } from "node:crypto"; import { mkdirSync, writeFileSync } from "node:fs"; import { homedir } from "node:os"; import { join } from "node:path";
export function spillPayload(text: string, dir = process.env.FAST_JEV_SPILL_DIR ?? join(homedir(), ".pi/jev-spill")) {
  const hash = createHash("sha256").update(text).digest("hex").slice(0,16);
  mkdirSync(dir,{recursive:true}); try{writeFileSync(join(dir,`${hash}.txt`),text,{flag:"wx"});}catch{}
  return { hash, notice: `[fast-jev-compaction-pi spilled ${text.length} chars → ${join(dir,`${hash}.txt`)}; read it back instead of re-running]` };
}
export const isSpillNotice = (s:string)=>s.includes("fast-jev-compaction-pi spilled");
```
2. `src/index.ts` 在 `renderEvidence` 前：对 `decideCall=drop_result` 且 `result.length>head+120` 的，先 `spillPayload(result)` 取 head+notice 拼证据（复用现有 `truncateHeadChars` 做 head）。
3. 新增 `test/spill.test.ts` 三断言（同文同 hash / notice 可读 / 关闭回退）。
4. `npm test` 全绿；手动 `cat ~/.pi/jev-spill/*.txt | head` 可见。
5. 磁盘只写、失败吞掉（try/catch 回退旧 note），不因 spill 坏 turn。

Task 4 — P3 诊断 + 文档 + 基准（收尾，不碰行为）
Files: 修改 `README.md`、`scripts/benchmark.ts`（加 `--calls 2000` oversized 档）、`src/index.ts` 日志行。
Why: 下次 1000k 不再盲猜；给连续缩减预研留口子但本期不做常驻。
Change Necessity: docs/config-only 为主 + 一行日志；无行为变更。
Impact/Compatibility: 新增 env `FAST_JEV_MAX_WINDOW_CHARS`（默认 60000）、`FAST_JEV_SPILL/FAST_JEV_SPILL_DIR`，全可选。
Verification: `npm run typecheck && npm test && npm run benchmark -- --calls 2000 --result-chars 4000 --iterations 50` 输出 stateTokens/stage/windows/reduction。
Steps:
1. `README` 在“失败回退”后加 `诊断` 小节：fallback 样例 `state=24880 calls=412 stage=old entries left out` 含义 + 三变量表。
2. `scripts/benchmark.ts` 加打印 `stateTokens/stage/windows`（复用 fitState 返回，不改计时口径）。
3. 跑 `npm run benchmark -- --calls 200 --result-chars 8000 --iterations 200`（现有基线）+ oversized 档，对比 P95。
4. 在 plan 留 `连续缩减预研` 一段（不实现）：Pi 无 `context` 事件，常驻需上游支持，本期只记录结论，不加 owner。

Risks:
- fitState 移植把 `estimateTokens` 语义搞漂：锁死沿用 `len/4`，不引 omp 的词法 estimator，避免与 Pi reserve 对不齐。
- 分窗后 `t1` 重名：merge 加 `wN.` 前缀，`details.decisions` 保持唯一，测试覆盖。
- spill 写盘权限/满盘：try/catch 回退旧 note，默认 dir 可配，`FAST_JEV_SPILL=0` 一键关。
- Jev 成本：分窗后 requests 增多，用 Task2 的 `unscored keep + minReduction 0.25` 挡，确保省不够就交回原生，不亏钱。

Retirement:
- 旧 `buildState throw` 路径删除，不保留开关；`buildState` 本体保留为兼容薄包装，待调用方全切 `fitState` 后再删（下个小版本）。
- 旧纯截断 note 文案保留为 spill 关闭时的 fallback，不删。
- 若 Pi 上游加 `context` 事件，P3 预研转正式计划，spill/sticky 可复用。

Self-review: 已对 spec（4点）逐条有 Task；无 TBD；签名跨 Task 一致（fitState/FittedState/split/merge/spill）；兼容边界显式；Change Necessity/Existence/Complexity 已记；验证命令精确到 flag；dual-track（Repair=fit+windowing+spill，Retirement=旧 throw 路径删）已分。
