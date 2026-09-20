# fast-jev-compaction-pi

Pi extension prototype for selective, verbatim tool-evidence compaction.

The extension intercepts Pi's `session_before_compact` lifecycle event. Jev
scores each completed tool call twice: whether the call matters and whether the
complete result matters. Local code then keeps, truncates, or drops the pair.
Kept evidence is attached verbatim to Pi's compaction summary.

The extension never modifies Pi's session tree. Missing credentials, Jev
errors, malformed responses, an unavailable active model, and insufficient
tool-output reduction all return control to Pi's built-in compaction.

## Configuration

The extension reads configuration only from its process environment:

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | required | TypeSafe API key used for Jev requests |
| `FAST_JEV_KEEP_THRESHOLD` | `0.5` | Probability at which a call or full result stays |
| `FAST_JEV_MAX_STATE_TOKENS` | `25000` | Approximate Jev state budget |
| `FAST_JEV_MAX_REQUEST_TOKENS` | `30000` | Approximate state-plus-question request budget |
| `FAST_JEV_TRUNCATE_HEAD_CHARS` | `300` | Result prefix retained when only the call matters |
| `FAST_JEV_MIN_EVIDENCE_REDUCTION` | `0.25` | Required reduction in candidate tool-result characters |

For isolated loading during development:

```sh
TYPESAFE_API_KEY=... pi -e /home/joslyn/code/pi/fast-jev-compaction-pi/src/index.ts
```

## Limits

Pi's extension API writes a single compaction summary. Kept evidence is raw
text inside that summary, not a retained standalone `toolResult` session
message. User and assistant text is summarized by the active Pi model.
