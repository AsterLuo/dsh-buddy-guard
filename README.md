# dsh-buddy-guard

Fix the **CodeBuddy / buddy (Tencent)** channel returning HTTP 400 on every request
in DeepSeek Harness:

```
buddy: 请求被拦截，请重新发送 Illegal API invocation from an unapproved channel
```

[中文说明](README.zh-CN.md)

## The problem

Pick any model on the `buddy` channel (`hy4-preview`, `deepseek-v4.1-flash`, `hy3`, …) and every turn fails
with HTTP 400 `INVALID_REQUEST`. The same account and the same endpoint work fine as soon
as the request stops carrying the DSH system prompt.

## Root cause (measured 2026-10-21)

The upstream does a **prefix match** on the system content. If the system text starts
with

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

Boundary tests (same account, same endpoint, same user message):

| system content | result |
| --- | --- |
| `You are an AI agent powered by DeepSeek Harness.` | 400 |
| the same line with **one leading space** | 200 |
| one leading letter / period | 200 |
| trailing space / newline / period / a whole paragraph | 400 |
| the sentence inside a user message | 200 |
| only `DeepSeek Harness`, or lowercase `deepseek harness` | 200 |

It matches the **start** of the system text; prefixing any character breaks the match,
and appending anything does not help.

## How it works

The plugin listens on `system-prompt/assemble` and returns a modified assembly whose first
non-empty section gets one leading space. `renderPrompt` joins sections with `\n\n`, so the
whole rendered system text then starts with that space.

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
3. Add `"dsh-buddy-guard": "0.1.0"` to `dependencies` in the same file
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
- `providers` — which providers get the prefix. Defaults to `['buddy']`; other
  providers pass through untouched.

## Verify it worked

After restarting, switch to a `buddy` model and send a message. A normal reply means it
works. Still getting 400?

1. Re-run `--dump-config` and confirm the `buddy-guard` row is there.
2. Confirm `lib/index.js` exists and is not empty.
3. Confirm the package is listed in `dsh.profile.bundles` — the most commonly missed step.
4. Confirm you really restarted DSH.

## Caveat

This **bypasses upstream content moderation**. The rule can change at any time. If the
same error returns, re-run the boundary tests to find the new trigger before changing
`GUARD_PREFIX`.

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
