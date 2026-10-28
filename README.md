# dsh-todo-progress-guard

English | [中文](README.zh-CN.md)

[![CI](https://github.com/LaochenFEIZHAI/dsh-todo-progress-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/LaochenFEIZHAI/dsh-todo-progress-guard/actions/workflows/ci.yml)

Gives the DeepSeek Harness (DSH) todo list a way to advance on its own: it nudges the model to
refresh `todo_write` during multi-step tool work, and completes stranded tasks when a turn ends
normally.

---

## The problem

DSH's `todo_write` replaces the whole list, and the list is only a session projection:

```js
// @deepseek-ai/dsh-tool-todo
apply: (state, event) => {
  if (event.type === "todo/write") return event.data.todos;
  if (event.type === "turn/start") return null;
  return state;
}
```

So **the panel only changes when the model calls `todo_write` again**. Long tool-heavy turns show
two familiar symptoms:

1. **Frozen mid-turn** — the model writes a plan once, then runs dozens of `bash` / `read` / `edit`
   calls while its attention stays on tool output. The panel keeps showing the first item as
   `in_progress` for the rest of the turn.
2. **Stuck after the answer** — the model finishes the work and answers in a step with no tool
   calls, so it never gets to send one last `todo_write`. The turn is over and the panel still
   reads `1 in progress · N pending`.

This bundle closes both gaps with one Host-side Cordis plugin. It changes no DSH core package and
invents no new session event types.

## Two mechanisms

### 1. Mid-turn reminder (`tools/post-execute`)

When the current turn owns an **incomplete** todo list and the model spends several steps or tool
calls without calling `todo_write`, the plugin injects one context message
(`source.kind = "todo-progress-reminder"`, `form: "notice"`, rendered as a collapsible injected row
in the chat stream) after the **last** tool result of that step.

The body repeats the current list verbatim, because `todo_write` replaces the whole list — the model
can copy it forward without re-reading distant history:

```text
Task progress reminder (1/3 completed; 2 step(s) / 4 tool call(s) since the last todo_write):
1. [completed] Recon the repository
2. [in_progress] Implement the fix
3. [pending] Run the test suite
If any task above is now completed or in progress, call `todo_write` with the COMPLETE
updated list in your next step. It can run in parallel alongside your next tool call at no
extra step cost, or mark every finished task `completed` before your final reply.
```

### 2. Turn-end completion (`agent/turn-stopping`)

As a turn **ends normally** — before `turn/end` is written, while the turn is still legitimately
open — any leftover `in_progress` / `pending` items are written back as `completed` through one final
`todo/write` snapshot. The panel can never outlive the work it describes.

## Install

Install as a profile bundle (any of the three):

```bash
# 1. straight from GitHub (this repository)
dsh plugin install github:LaochenFEIZHAI/dsh-todo-progress-guard

# 2. a local checkout (development; edits take effect immediately)
dsh plugin install /absolute/path/to/dsh-todo-progress-guard

# 3. from npm once published
dsh plugin install dsh-todo-progress-guard
```

The same specs work in the Web UI under **Plugins → Install**. The bundle's `cordis.patch.yml`
inserts one `todo-progress-guard` row, which is live immediately.

## Configuration

Defaults are usable as-is. To tune them, override this row's `config` by id in the profile's own
`cordis.patch.yml` (a patch layer replaces `config` wholesale, so restate all three keys):

```yaml
- id: todo-progress-guard
  config:
    stepThreshold: 2
    callThreshold: 5
    autoCompleteOnTurnEnd: true
```

| Field | Default | Meaning |
|---|---|---|
| `stepThreshold` | `2` | Remind after this many model steps without a `todo_write` |
| `callThreshold` | `5` | Remind after this many other tool calls without a `todo_write` (needs at least one step) |
| `autoCompleteOnTurnEnd` | `true` | Complete leftover items when a turn ends normally |

The two thresholds are OR-ed: whichever is reached first reminds. At most one reminder per step, and
counters reset at every turn boundary. Invalid values (non-positive integers, non-booleans) fall back
to the defaults instead of failing activation.

## Safety boundaries

Completion only happens when the turn really did work. The plugin appends nothing when:

- the turn was aborted (`signal.aborted`) or the last assistant message was interrupted;
- a next step is already queued (`agent.inbox.nextStep` is non-empty) — the turn is not over;
- the step called `ask_user_question` or `exit_plan_mode` — the turn is waiting on a human, who
  alone can decide whether the work is done;
- every item is already `completed`;
- the list was just created and no other tool ran yet — that is a stated plan, not a result.

The plugin only **appends** `todo/write` events, never rewrites history, and always writes inside a
legitimately open turn, so it stays compatible with the durable-log invariants owned by
`@deepseek-ai/dsh-tool-todo`.

## Compatibility

- Requires the Host `sessions` and `sessionProjections` services; the plugin stays inactive where
  they are absent (plain `inject` semantics) instead of failing the composition.
- Verified on DSH `0.2.0-rc.2`. Every extension point it uses — `additionalContexts` on
  `tools/post-execute`, `agent/turn-stopping`, and the `todos` projection — is public contract there.
- **Zero runtime dependencies**: the plugin imports no DSH package, so a `link:` checkout and a
  registry install behave identically. (Exporting a Schemastery `Config` would break `link:`
  installs, because a symlinked realpath cannot resolve DSH packages; configuration is therefore
  validated inside the plugin.)

## Development

```bash
npm test        # node --test; 13 cases cover reminders, completion and every boundary
```

The tests drive the real plugin code through a minimal Host stand-in (session log + `todos`
projection + tool waterfall) and import nothing from DSH.

## License

[MIT](LICENSE)
