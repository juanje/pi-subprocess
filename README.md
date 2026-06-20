# pi-subprocess

Minimal subprocess isolation for [Pi](https://pi.dev) agents. Spawns isolated Pi subprocesses and returns curated results — keeps the parent's context clean.

## Install

From npm:

```bash
pi install npm:pi-subprocess
```

From git:

```bash
pi install git+https://github.com/juanje/pi-subprocess.git
```

Or load directly without installing:

```bash
pi -e /path/to/pi-subprocess/extensions/subprocess.ts
```

## Quick start

Once installed, a `subprocess` tool becomes available in your Pi session:

```
> Use subprocess to investigate how error handling works in the tools/ directory
```

The agent spawns an isolated Pi subprocess that investigates independently and returns a summary. The parent session's context grows by the summary size only, not by all the files the subagent read.

## How it works

The extension registers a `subprocess` tool that:

1. **Spawns** a child Pi process in JSON mode with its own system prompt
2. **Streams** the child's JSONL output, collecting `message_end` events
3. **Extracts** the final assistant text from the child session
4. **Truncates** the output to a configurable maximum (default: 100 lines)
5. **Returns** the curated text + stats (turns, tool calls, tokens, cost, duration)

### Context isolation

The child runs in its own process with a fresh context window. It inherits the parent's working directory and environment (including permission policies from `pi-permission-gate` if installed), but none of the parent's conversation history.

### Recursion prevention

The extension sets `PI_SUBPROCESS_CHILD=1` in the child's environment. If this variable is already set, the extension skips registration entirely — no infinite recursion.

### Session persistence

Child sessions are saved alongside the parent session for post-hoc analysis:

```
~/.pi/agent/sessions/my-project/
├── 2026-06-19_abc123.jsonl          # parent session
└── 2026-06-19_abc123/
    └── subprocess-x7k9m2/           # child session
        ├── session.jsonl
        └── ...
```

## Tool parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `task` | string | yes | — | What the worker should do |
| `system_prompt` | string | no | — | Custom prompt appended to the default worker prompt |
| `tools` | string | no | `read,bash,grep,find,ls` | Comma-separated tools for the worker |
| `max_lines` | number | no | `100` | Maximum output lines returned |
| `effort` | `fast` \| `balanced` \| `thorough` | no | — | Thinking depth (maps to Pi `--thinking` low/medium/high) |
| `timeout_ms` | number | no | `900000` (15 min) | Kill the subprocess after this duration |

## Tool result

The tool returns:

- **`content`** — the subprocess's final text (truncated if over `max_lines`)
- **`details`** — stats object:

| Field | Type | Description |
|-------|------|-------------|
| `turns` | number | Assistant turns in the child session |
| `toolCalls` | number | Total tool invocations |
| `totalTokens` | number | Token consumption |
| `cost` | number | API cost |
| `durationMs` | number | Wall-clock duration |
| `sessionDir` | string | Path to child session JSONL |
| `timedOut` | boolean | Whether the timeout killed the child |
| `outputTruncated` | boolean | Whether output exceeded `max_lines` |
| `fullOutputFile` | string? | Path to untruncated output (only when truncated) |

The `details` field is visible to the parent agent but not injected into the context text. When output is truncated, the full text is saved to `full-output.md` in the session directory for post-hoc review.

## When to use

- **Investigation would flood context** — reading multiple files, grepping large codebases, fetching logs
- **Research before synthesis** — delegate the fact-finding, keep the parent focused on analysis
- **Skill-directed isolation** — skills can explicitly invoke `subprocess` for specific substeps

## When NOT to use

- Simple file reads or single tool calls — the overhead of spawning a subprocess isn't worth it
- Tasks requiring parent conversation history — the child starts fresh
- Tasks requiring write access to parent state — the child's writes don't propagate back

## Development

```bash
git clone https://github.com/juanje/pi-subprocess.git
cd pi-subprocess
npm install
npm run check    # typecheck + lint + test
```

## License

MIT — see [LICENSE](LICENSE).
