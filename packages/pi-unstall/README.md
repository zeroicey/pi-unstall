# pi-unstall

A [Pi](https://pi.dev) extension that notices when an agent run **stopped without
finishing** — a provider error, a truncated response, an expired key, a model
that trailed off mid-sentence — and nudges it back into motion by sending a
`continue` message, exactly as if you had typed it.

```bash
pi install npm:pi-unstall
```

Then `/reload` if Pi is already running. The footer shows `♻` while it is armed.

---

## Why

Pi already retries transient failures itself: `retry.enabled` with
`retry.maxRetries = 3` and exponential backoff covers `429`, `500`, `502`, `503`,
`504`, `520`, `524`, `overloaded`, `rate limit`, timeouts, connection resets and
premature stream endings.

What it deliberately does **not** retry:

- quota, budget and billing exhaustion (`insufficient_quota`, `quota exceeded`,
  `billing`, subscription limits) — these fail fast on purpose;
- status codes that match no transient pattern, such as `400` and `401`;
- a run that ends with `stopReason: "stop"` while the model was actually
  mid-sentence, or after announcing a next step it never took.

Those are the cases that leave you staring at a prompt that will not move until
you type `continue` yourself. `pi-unstall` covers exactly that last mile.

## What it does

It hooks Pi's `agent_settled` event — the point at which Pi has confirmed there
is no automatic retry, compaction recovery or queued work left. It does **not**
hook `agent_end`, which fires *before* those retries and would waste the budget
during backoff.

A decision is made in two stages, cheapest first:

```
agent_settled
  ├─ guards: user abort? pending messages? config disabled?   -> stand down
  ├─ detectors (deterministic, no model call)
  │    stopReason ∈ {error, length}          -> stalled
  │    stopReason = stop with no prose       -> stalled
  │    stopReason ∈ {toolUse, pending, ...}  -> healthy, stop
  │    anything else                         -> unknown
  ├─ judge (one model call, only for `stop` with prose)
  │    "did it finish, or is it waiting for a human?"
  └─ recovery: send the continue text as a user message
```

The split matters: the certain failures are decided without a model call, so
they still work when the thing that broke **is** the model, key or provider.

### Discipline

- **Bounded.** At most `maxConsecutive` back-to-back recoveries (default 3). Any
  healthy stop, or anything you type, resets the counter.
- **Escape is a brake.** After you abort a turn, it stays quiet until you speak
  again. It will not fight you for the wheel.
- **Re-guarded before it acts.** The judge runs asynchronously; before sending,
  the engine re-checks that Pi is idle, that nothing is queued, and that the
  final assistant message is still the one it judged.
- **Fails safe.** If the judge call fails or its answer cannot be parsed, the
  default is to do nothing, so a broken judge cannot turn every normal answer
  into an infinite loop.

## Configuration

`~/.pi/agent/pi-unstall.json`. Every field is optional; anything missing or
invalid falls back to its default.

```json
{
  "enabled": true,
  "continueText": "continue",
  "maxConsecutive": 3,
  "judge": {
    "model": null,
    "tailMessages": 12,
    "maxTailChars": 6000,
    "timeoutMs": 60000,
    "promptFile": null
  },
  "stalledStopReasons": ["error", "length"],
  "stalledOnEmptyText": true,
  "onJudgeFailure": "skip",
  "onUnparsable": "skip",
  "suppressAfterAbort": true,
  "notify": true,
  "debug": false
}
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `continueText` | `"continue"` | The message sent on a confirmed stall. |
| `maxConsecutive` | `3` | Give up after this many back-to-back recoveries. |
| `judge.model` | `null` | `null` uses the session's current model. Set `{"provider":"…","model":"…"}` to decouple the judge — see below. |
| `judge.tailMessages` | `12` | How many trailing messages the judge sees. |
| `judge.maxTailChars` | `6000` | Hard cap on the tail. |
| `judge.timeoutMs` | `60000` | Abort the judge call after this long. |
| `judge.promptFile` | `null` | `null` uses `pi-unstall-prompt.md` in the agent directory. |
| `stalledStopReasons` | `["error","length"]` | Stop reasons that mean "stalled" with no model call. |
| `stalledOnEmptyText` | `true` | A `stop` with no prose at all counts as stalled. |
| `onJudgeFailure` | `"skip"` | `"recover"` to continue anyway when the judge call fails. |
| `onUnparsable` | `"skip"` | `"recover"` to continue when the judge's answer is unreadable. |
| `suppressAfterAbort` | `true` | Stay quiet after Escape until you type again. |
| `notify` | `true` | Show a notification for each recovery and give-up. |
| `debug` | `false` | Log every decision to Pi's log. |

The config is re-read on every decision, so edits apply without a reload.

### Tuning the judge prompt

The prompt is a plain Markdown file: `~/.pi/agent/pi-unstall-prompt.md`. Create
it to override the built-in default — any language works.

```
/unstall judge      # dry-run the judge on the current conversation, without sending
```

That prints the verdict, the reason, and how big the tail was. Edit the file,
run it again: no reload needed.

### Decoupling the judge model

By default the judge uses the session's model, which is zero-config but has a
structural weakness: when a key expires or a provider goes down, the judge is
down too — exactly when you need it. The deterministic detectors still work in
that case, but "prose that happens to sit next to a 400" will be missed.

Point `judge.model` at a model on a different provider to remove the coupling:

```json
{ "judge": { "model": { "provider": "some-other-provider", "model": "a-cheap-model" } } }
```

## Commands

| Command | Effect |
| --- | --- |
| `/unstall` | Status: enabled, streak, detector chain, judge model, prompt path, config path, last verdict. |
| `/unstall on` / `off` | Toggle for this session (not persisted). |
| `/unstall judge` | Dry-run the judge on the current conversation. Sends nothing. |
| `/unstall send` | Send the continue text by hand. |

## Extending it

The engine is host-free and three-stage, so new stall shapes are additive. The
package exports its pieces and a factory that takes replacements:

```ts
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  createUnstall,
  defaultDetectors,
  defaultRecoveries,
  type Detector,
} from "pi-unstall";

/** Treat a leftover TODO as an unfinished run. */
const todoDetector: Detector = {
  name: "leftover-todo",
  detect: (evidence) =>
    /\bTODO\b/.test(evidence.text)
      ? { verdict: "stalled", reason: "left a TODO behind" }
      : { verdict: "unknown" },
};

export default (pi) =>
  createUnstall({
    agentDir: getAgentDir(),
    // `defaultDetectors()` already contains the guard, so put custom rules first.
    detectors: [todoDetector, ...defaultDetectors()],
    recoveries: [
      ...defaultRecoveries(),
      {
        name: "notify-only",
        run(context) {
          context.notify("still stalled", "warning");
          return false; // returning false lets the next recovery try
        },
      },
    ],
  })(pi);
```

- **Detectors** are synchronous and cheap. Return `unknown` to hand the decision
  to the next detector, and finally to the judge.
- **The judge** is one injected model call; replace it wholesale with `judge:`.
- **Recoveries** run in order; the first one that returns `true` wins. The
  built-in one sends `continueText`.

## How it works, precisely

- **Hook**: `agent_settled`. Pi documents it as the point where no automatic
  retry, compaction recovery or queued continuation remains.
- **Delivery**: `pi.sendUserMessage()`, which Pi records as an extension-sourced
  user message. The model sees a normal turn; nothing special is injected.
- **TUI vs headless**: in the TUI the handler returns immediately and the judge
  runs in the background, because Pi defers prompts submitted while
  `agent_settled` handlers are running — awaiting a model call there would
  visibly stall your next message. Headless modes (`rpc`, `json`, `print`) await
  it, because print mode disposes the runtime the moment `prompt()` resolves.
- **Cancellation**: an in-flight judge is aborted by any human input, by
  `agent_start`, and by session shutdown.
- **Footer**: `♻` armed, `♻ 2/3` after consecutive recoveries, `♻ ⏸` suppressed
  after Escape, and nothing at all when disabled.

## Limitations

- One recovery strategy ships today: send a message. Waiting-and-retrying,
  switching models, or resuming from a checkpoint would be new `Recovery`
  implementations.
- No project-level config: settings are global to the agent directory.
- The judge costs one model call per ambiguous settled turn. Certain failures
  and normal completions with tool calls cost nothing.
- It cannot help when there is genuinely nothing left to continue — a stalled
  run that repeats will hit `maxConsecutive` and stop.

## Development

```bash
bun test          # 85 tests, no model calls, no network
bun run typecheck # needs the peer packages installed
```

The engine is fully injected: tests drive the real pipeline with a stub `pi` and
a stub `ctx`, so every guard, the streak bookkeeping, both modes, and the
extension points are covered without a Pi process.

## License

MIT
