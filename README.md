# fast-jev-compaction-pi

[Pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) 的 Jev 引导上下文压缩扩展。它在 Pi 压缩旧会话记录前，让 TypeSafe Jev 分别判断每个已完成工具调用及其完整结果是否仍有价值，并由本地确定性规则执行保留、截短或删除。

与普通摘要不同，Jev 判定需要保留的工具证据不会再次由摘要模型改写，而是以原始文本写入 Pi 的 compaction summary。这尤其适合保留测试失败日志、关键命令输出、配置内容、文件读取结果和精确错误信息。

## 工作方式

Pi 发起手动或自动上下文压缩时，本扩展监听 `session_before_compact`：

1. 用 Pi 的 `toolCall.id` 和 `toolResult.toolCallId` 配对已完成调用及其结果。
2. 构造不含工具输出正文的会话状态：包含用户/助手文本、工具名称、参数、结果长度及错误标记。
3. 对每一个调用向 Jev 提出两个 `noul` 概率问题：
   - `keepCall`：是否仍需知道该工具曾被调用及其参数。
   - `keepResult`：是否仍需保留完整、逐字的工具结果。
4. 根据本地 `keepThreshold` 规则应用决策：

| 条件 | 本地动作 |
| --- | --- |
| `keepResult >= keepThreshold` | 保留调用与完整原始结果。 |
| `keepResult < keepThreshold` 且 `keepCall >= keepThreshold` | 保留调用，结果仅保留前缀和“可重新运行”提示。 |
| 两个概率都低于阈值 | 调用与结果都不写入压缩摘要。 |

5. 使用当前 Pi 模型为普通会话文本生成结构化摘要，并附上 `## Verbatim Tool Evidence` 原文证据区块。

## 自动压缩

扩展覆盖 Pi 原生的全部 compaction 入口：

- 手动 `/compact`
- 接近上下文窗口阈值时的自动压缩
- 上下文溢出后的自动压缩与重试

触发时机仍由 Pi 的 `compaction` 设置管理。扩展不修改 Pi 的 session tree、切点算法或 JSONL 会话格式。

## 安装

### 前置条件

- Node.js 18 或更新版本
- 已安装并可运行 Pi
- TypeSafe API key，可访问 Jev 的 System One API

### 克隆并安装依赖

```sh
git clone https://github.com/joslynSmall/fast-jev-compaction-pi.git
cd fast-jev-compaction-pi
npm install
```

### 配置 TypeSafe key

扩展仅从启动 Pi 的进程环境读取 `TYPESAFE_API_KEY`，不会读取、复制或保存 API key。

Bash 用户可用以下命令写入用户级环境配置，输入时 key 不会显示：

```sh
mkdir -p ~/.config/environment.d
umask 077
read -rsp 'TypeSafe API key: ' TYPESAFE_API_KEY; echo
printf 'TYPESAFE_API_KEY=%s\n' "$TYPESAFE_API_KEY" > ~/.config/environment.d/90-typesafe.conf
chmod 600 ~/.config/environment.d/90-typesafe.conf
systemctl --user set-environment TYPESAFE_API_KEY="$TYPESAFE_API_KEY"
unset TYPESAFE_API_KEY
```

重新登录桌面会话或打开新终端后，确认变量已加载但不显示其值：

```sh
test -n "$TYPESAFE_API_KEY" && echo 'TYPESAFE_API_KEY configured'
```

### 配置 Pi 全局加载

在 `~/.pi/agent/settings.json` 的 `extensions` 数组中加入扩展入口。请替换为你的克隆绝对路径：

```json
{
  "extensions": [
    "/absolute/path/to/fast-jev-compaction-pi/src/index.ts"
  ]
}
```

临时测试时，也可以不修改 Pi 设置：

```sh
pi -e /absolute/path/to/fast-jev-compaction-pi/src/index.ts
```

重启 Pi 后生效。可在一个有若干 `read`、`bash`、`edit` 等工具调用的会话中运行 `/compact` 验证。

## 配置项

所有选项从环境变量读取，未设置时使用默认值：

| 变量 | 默认值 | 说明 |
| --- | ---: | --- |
| `TYPESAFE_API_KEY` | 必填 | TypeSafe API key。 |
| `FAST_JEV_KEEP_THRESHOLD` | `0.5` | 调用或完整结果被保留的最低 Jev 概率。 |
| `FAST_JEV_MAX_STATE_TOKENS` | `25000` | 发送给 Jev 的会话状态估算 token 上限。 |
| `FAST_JEV_MAX_REQUEST_TOKENS` | `30000` | 一次 Jev 请求中状态和决策问题的估算 token 上限。 |
| `FAST_JEV_TRUNCATE_HEAD_CHARS` | `300` | 仅保留调用时，结果原文保留的前缀字符数。 |
| `FAST_JEV_MIN_EVIDENCE_REDUCTION` | `0.25` | 只有候选工具结果的字符缩减比例达到该值，才使用自定义压缩。 |

例如：

```sh
export FAST_JEV_KEEP_THRESHOLD=0.65
export FAST_JEV_TRUNCATE_HEAD_CHARS=500
pi
```

## 输出示例

压缩成功后，Pi 的 summary 会同时有任务摘要与经过本地规则筛选的原文工具证据：

```markdown
## Goal
修复认证测试失败。

## Critical Context
测试预期需要保持 401 状态码。

## Verbatim Tool Evidence

### bash (t2)

Arguments:
```json
{
  "command": "npm test"
}
```

Result (error):
````text
FAIL src/auth.test.ts
Expected: 401
Received: 200
````
```

## 失败回退

以下任一情况，扩展会返回控制权给 Pi 的内置压缩，不会阻断会话：

- `TYPESAFE_API_KEY` 未配置。
- 没有可处理的已完成工具调用。
- Jev 请求失败、返回非 JSON 或回答字段不完整。
- 会话状态或决策问题超过配置的 token 预算。
- 当前 Pi 模型无法生成普通文本摘要。
- 筛选后工具证据的缩减比例低于 `FAST_JEV_MIN_EVIDENCE_REDUCTION`。

这意味着该扩展优化的是工具证据保留质量，而不接管 Pi 的可靠性边界。

## 已知限制

- Pi 的扩展 API 只能写入一个 `compactionSummary`，保留的工具输出是 summary 内的原文区块，不是独立的 `toolResult` message。
- 用户和助手的普通文本仍由当前 Pi 模型摘要，不保证逐字保留。
- Jev 会收到摘要范围内的会话状态、工具名称、参数、结果长度和错误标记；工具输出正文不会进入 Jev 判定 state。
- 在工具调用非常多的长会话中，决策问题可能拆分为多个并发 Jev 请求，完整状态会随每个批次重复发送。

## 开发与验证

```sh
npm run typecheck
npm test
```

测试包含 Pi 调用/结果配对、输出排除状态、请求批处理、三态本地决策、截短渲染，以及 Jev HTTP 协议和错误回答处理。

## 许可证

[MIT](LICENSE)
