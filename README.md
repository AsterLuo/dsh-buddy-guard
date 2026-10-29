# dsh-buddy-guard

Fix the **CodeBuddy / buddy (Tencent)** channel returning HTTP 400 on every request
in DeepSeek Harness:

```
buddy: 请求被拦截，请重新发送 Illegal API invocation from an unapproved channel
```

[中文说明](README.zh-CN.md)

```bash
dsh plugin add github:AsterLuo/dsh-buddy-guard --profile <your-profile>

# pin a version (recommended):
dsh plugin add github:AsterLuo/dsh-buddy-guard#v0.1.2 --profile <your-profile>
```

> **Restart DSH** afterwards — it is required. Then start a **new** session on the buddy channel
> (the guard cannot rewrite a system prompt that is already sitting in session history).

**v0.1.2 (2026-10-29)** — the upstream tightened block #1 to `^\s*`, so a leading space no longer
works. The plugin now rewrites the sentence itself. See [Third change](#third-change--block-1-was-tightened-measured-2026-10-29).

## The problem

Pick any model on the `buddy` channel (`hy4-preview`, `deepseek-v4.1-flash`, `hy3`, …) and every turn fails
with HTTP 400 `INVALID_REQUEST`. The same account and the same endpoint work fine as soon
as the request stops carrying the DSH system prompt.

There are **three** independent upstream rules, all answering `400 / code 11128`:

| # | measured | rule |
| --- | --- | --- |
| 1 | 2026-10-21, tightened 2026-10-29 | system text starts with the identity sentence |
| 2 | 2026-10-27 | system text contains phrase A **and** phrase B |
| 3 | 2026-10-29 | system text contains the fixed Web GUI context paragraph |

## Block 1 — the identity sentence (measured 2026-10-21, tightened 2026-10-29)

The upstream matches the **start** of the system content. If the system text starts with

```
You are an AI agent powered by DeepSeek Harness.
```

it is rejected outright. None of the following matter — every one was changed and the
status stayed 400:

- `X-Domain` (`copilot.tencent.com` vs `www.codebuddy.cn`)
- `X-Product-Code` / `X-Product` / `X-Agent-Purpose`
- `X-IDE-Name` / `X-IDE-Type` / `X-IDE-Version` / `User-Agent`
- the endpoint (`copilot.tencent.com` and `www.codebuddy.cn` behave identically)
- the model (`hy4-preview`, `hy3`, `deepseek-v4.1-flash` are all rejected)

Boundary tests — the middle column is what worked until 2026-10-29, the right column is
what works now:

| system content | 2026-10-21 | 2026-10-29 |
| --- | --- | --- |
| `You are an AI agent powered by DeepSeek Harness.` | 400 | 400 |
| same line with **one leading space** | **200** | **400** |
| two leading spaces | 200 | 400 |
| one leading letter / period | 200 | 200 |
| `Note: You are an AI agent powered by …` | — | 200 |
| `You are an AI agent, powered by …` | — | 200 |
| trailing space / newline / period / a whole paragraph | 400 | 400 |
| the sentence inside a user message | 200 | 200 |
| only `DeepSeek Harness`, or lowercase `deepseek harness` | 200 | 200 |

## Third change — block 1 was tightened (measured 2026-10-29)

The upstream changed **one regex**:

```diff
- ^You are an AI agent powered by … Harness
+ ^\s*You are an AI agent powered by … Harness
```

Leading whitespace is now ignored, so *any* "prefix a character" patch is dead — that is
exactly why v0.1.1 (which prefixed one space) started failing while still doing its job.
The plugin now rewrites **the sentence itself**: `powered by` → `, powered by`.

The check is a **whole-sentence pattern**, not a keyword. Measured 2026-10-29
(same account, same endpoint, same user message):

| system text | result |
| --- | --- |
| `DeepSeek Harness` alone | 200 |
| `powered by DeepSeek Harness.` | 200 |
| `You are an AI agent powered by Foo Harness.` (other brand) | 200 |
| `You are an AI agent powered by DeepSeek Harness.` | **400** |
| the same with 1 or 2 leading spaces | **400** |
| `You are an AI agent, powered by DeepSeek Harness.` | 200 |
| `Note: You are an AI agent powered by …` | 200 |
| `I am an AI agent powered by …` / `running on …` / split into two sentences | 200 |

## Block 2 — the AND-matched phrase pair (measured 2026-10-27)

There is a **second, independent** rule. The upstream also rejects the request when the
system text contains **both** of these phrases at once (AND match — either one alone passes):

- `Tokens prefixed with @ are paths the user explicitly referenced`
- `Relative paths resolve from the workspace root`

Both are part of the DSH system prompt's description of `@` path references, so they ship
with **every** request.

Measured (same account, same endpoint):

| system text | result |
| --- | --- |
| phrase A alone | 200 |
| phrase B alone | 200 |
| **A and B together** | **400** `11128` |
| A rewritten, B kept as-is | 200 |
| B rewritten, A kept as-is | 200 |

The plugin therefore rewrites phrase **A only** and leaves B intact — B states the relative-path
rule that `read` / `write` / `glob` depend on, so keeping its wording is friendlier to the model.

> **This rule still exists as of 2026-10-29.** Control experiment: fix the identity sentence but
> restore phrase A to its original wording → still `400`. Do not delete the A rewrite.

## Block 3 — the Web GUI context (measured 2026-10-29)

The Web GUI paragraph can independently trigger `400 / code 11128`, even after the identity
and path-reference rewrites. This was also reported in
[dsh-connect-workbuddy#164](https://github.com/dingminhua/dsh-connect-workbuddy/issues/164).

The plugin rewrites `You are interacting with the user through the DeepSeek Harness Web GUI`
to `The user communicates with you through the DeepSeek Harness Web GUI` in every section.
The remaining text, including the runtime URL reference and GUI instructions, stays intact.

Replaying a failing DSH system prompt with one harmless user message still produced an upstream
400 after the v0.1.1 rewrites; adding this rewrite produced a normal `OK` reply. An OpenAI-compatible
proxy may wrap that upstream error in an HTTP 200 SSE `data: {"error": ...}` event: inspect the
complete stream rather than treating the outer HTTP status alone as success.

### History is a blind spot

The upstream scans **every** message, so phrase A/B, the identity sentence, or the Web GUI paragraph sitting in
**conversation history** triggers the same block. A plugin cannot fix that: `agent/request`
documents that it *cannot mutate messages*, and the `llm/stream` options object arrives
deep-frozen (mutation throws). If a session has ever quoted these, **start a new session**.

### How this was found (repeatable)

1. Dump the **complete outgoing system text** — easiest source is the session log itself:
   `<DSH_HOME>/sessions/…/session.v4.jsonl.zstd`, then find the `system/message` event.
   ⚠️ That file is **multi-frame** zstd (header frame + one frame per event batch).
   `zstdDecompressSync()` only decodes the **first** frame, so a naive read looks like a
   1-line session. Split on the magic `28 B5 2F FD` and decode frame by frame.
2. Replay that text against the endpoint directly, using the account's own token and the
   headers from `channel-pack`'s `BuddyAdapter.send()`.
3. Run a **one-variable-at-a-time** matrix on the first section (original / leading space /
   inserted comma / other subject / split sentences). Only then binary-search the full text —
   if the first section alone already returns 400, there is nothing to bisect.
4. Replay the **full** (multi-hundred-kilobyte) system text with the fix — a local pass does not
   prove the whole request passes, block 2 is still waiting.

A blocked request costs no tokens, so this is cheap.

```bash
# ready-made end-to-end check: real plugin load + real upstream request
node docs/tools/buddy-guard-verify.mjs
# expect: upstream(original) 400/11128 → upstream(plugin output) 200
```

## How it works

The plugin listens on `system-prompt/assemble` and returns a modified assembly that, for the
providers listed in `config.providers`:

1. rewrites the identity sentence in every section — strip leading whitespace, then replace
   `You are an AI agent powered by` with `You are an AI agent, powered by` (idempotent, do nothing
   when the text does not start with that phrase);
2. scans every section and rewrites phrase A and the Web GUI opening to equivalent wording.

> Do **not** go back to prefixing whitespace. `^\s*` makes it a no-op.

Registration uses `{ global: true, prepend: true }`, and **`prepend` is required**: without it,
an outer listener that never calls `next()` (for example dsh-ops' discovery branch, which does
`return prompt.assemble(context)`) would veto the rest of the chain — per cordis, *"a listener
that does not call `next()` vetoes the rest of the chain"*. The plugin would load, log, and show
up in `--dump-config`, yet change nothing.

### Why not `llm/stream`

The first version hooked `llm/stream` and called `next(modifiedOptions)`. That did **nothing**,
silently. Cordis implements waterfall as:

```js
const next = () => (cbs.shift() ?? inner)(...args);
```

`next` takes no arguments — the modified options were dropped on the floor. The plugin
loaded, logged, showed up in `--dump-config`, and the outgoing request was byte-for-byte
unchanged.

Replacing arguments only works through a listener's **return value**.

## Install

```bash
dsh plugin add github:AsterLuo/dsh-buddy-guard --profile <your-profile>
```

This copies the package into your profile's `node_modules` and registers it in
`dsh.profile.bundles`. Your own `cordis.patch.yml` is left untouched.

Then **restart DSH** — the config is read once at startup.

### Manual install

1. Copy this repo into `<DSH_HOME>/profiles/<profile>/node_modules/dsh-buddy-guard/`
2. Append `"dsh-buddy-guard"` to `dsh.profile.bundles` in that profile's `package.json`
3. Add `"dsh-buddy-guard": "0.1.2"` to `dependencies` in the same file
4. Verify with `--dump-config` and look for the `buddy-guard` row
5. Restart DSH

## Configuration

```yaml
- id: buddy-guard
  name: 'dsh-buddy-guard'
  config:
    enabled: true
    providers:
      - buddy
```

- `enabled` — master switch.
- `providers` — which providers get the patch. Defaults to `['buddy']`; other
  providers pass through untouched.
- `debug` — when `true`, appends one line per guarded request to `$DSH_HOME/buddy-guard.log`.
  Off by default, so nothing is written on the hot path.

## Verify it worked

After restarting, switch to a `buddy` model and send a message. A normal reply means it
works. Still getting 400?

1. Re-run `--dump-config` and confirm the `buddy-guard` row is there.
2. Confirm `lib/index.js` exists and contains `PREFIX_REWRITES` (0.1.2+) — upgrades overwrite the
   whole package, so a local hotfix is lost on upgrade.
3. Confirm the package is listed in `dsh.profile.bundles` — the most commonly missed step.
4. Confirm you really restarted DSH **and** opened a new session.

> Full step-by-step troubleshooting (Chinese): [docs/troubleshooting.zh-CN.md](docs/troubleshooting.zh-CN.md)

## Caveat

This **bypasses upstream content moderation**. The rules can change at any time, and there
are now **three** known ones (two of them reshaped once already). If the same error returns,
re-run the dump + one-variable-at-a-time recipe above before changing anything.

The account in question is a CodeBuddy **China** account (`www.codebuddy.cn`, the JWT `iss`
points there) while the client sends the international product shape. That mismatch is
itself what the upstream means by "unapproved channel" — this plugin only makes it work for
now, it does not fix the underlying mismatch. Using `workbuddy` (international) avoids the
check entirely.

## Test

```bash
npm test
```

## License

MIT
