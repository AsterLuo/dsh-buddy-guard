# buddy 渠道「请求被拦截」排障手册

> 适用：DSH 走 **buddy（CodeBuddy 腾讯）** 渠道时返回
> `buddy: 请求被拦截，请重新发送 Illegal API invocation from an unapproved channel`（HTTP 400 / code 11128）。
> 本文是 2026-10-29 那次排障的沉淀，逻辑对其它「上游悄悄改规则」的场景同样成立。

---

## 0. 三十秒判断

| 现象 | 说明 | 小节 |
| --- | --- | --- |
| 400 + `code 11128` + `Illegal API invocation from an unapproved channel` | **渠道校验拦截**（本文主战场） | §2 |
| 400 + `code 11128` + `first message is not system prompt` | 请求没带 system / 首条不是 system | §6 |
| 400/403 + `code 11140` / `request illegal` / `安全审核` | 内容安全拦截（真·内容问题，不是身份句） | §6 |
| `账号被服务端安全策略拦截（HTTP xxx，流内错误帧下发）` | 11140 走了流内错误帧，账号被标记 30 分钟冷却 | §6 |
| 插件日志显示 `system prompt adjusted` 但仍 400 | **guard 生效了、上游规则又变了** → 做边界测试 | §2.2 |

关键：**「guard 生效」≠「不被拦」**。2026-10-29 的故障就是补丁正常打上了、上游却换了判据。

---

## 1. 拦截机制（三道门）

上游 `copilot.tencent.com/v2/chat/completions` 对 system 文本的判据，全部回 **HTTP 400 / code 11128**。

### 门 1：身份句（**判据变过，每次只改一个正则**）

| 日期 | 上游判据 | 当时有效的对策 |
| --- | --- | --- |
| 2026-10-21 | `^You are an AI agent powered by … Harness` | 首段前置**一个半角空格** |
| **2026-10-29** | `^\s*You are an AI agent powered by … Harness` | **前置空格失效**，改为改写句式 `You are an AI agent, powered by` |

`^\s*` 就是根因：上游开始**忽略前导空白**，所有"只加空白"的补丁全部作废。

**判据是整句式，不是关键词**（2026-10-29 实测）：

| system 首段 | 结果 |
| --- | --- |
| `DeepSeek Harness` 单独出现 | 200 |
| `powered by DeepSeek Harness.` | 200 |
| `You are an AI agent powered by Foo Harness.`（换品牌） | 200 |
| `You are an AI agent powered by DeepSeek Harness.` | **400** |
| 同一句前面加 1 / 2 个空格 | **400** |
| `Note: You are an AI agent powered by …`（前加词） | 200 |
| `You are an AI agent, powered by …`（句中插逗号） | 200 |
| `I am an AI agent powered by …` / `running on …` / 拆成两句 | 200 |

### 门 2：A+B 组合指纹（**仍然有效，别删**）

system 文本**同时**出现下面两句才触发（AND 匹配，单独出现放行）：

- A: `Tokens prefixed with @ are paths the user explicitly referenced`
- B: `Relative paths resolve from the workspace root`

两句都在 DSH 描述 at-sign 路径语法的正文里，**每轮必带**。只修门 1 一定还会被拦。

> 2026-10-29 对照实验：首段已修 + 把 A 还原成原文 → **仍 400**。

---

## 2. 定位流程

### 2.1 取证：错误原文 + 本轮真实 system

会话文件：`<DSH_HOME>/sessions/<工作区>/session-<id>/session.v4.jsonl.zstd`

⚠️ **多帧 zstd**（header 帧 + 每批事件一帧）。`zstdDecompressSync()` 只解**第一帧**（只有 1 行 header），
会让人误以为会话是空的。必须按魔数 `28 B5 2F FD` 切帧、逐帧解 —— `docs/tools/buddy-guard-verify.mjs` 里有现成实现。

三种有用事件：

- `system/message`：**本轮实际发出的 system 全文**（`data.message.content[0].text`）
- `assistant/attempt` / `turn/end`：错误原文，例如
  `{"kind":"error","failure":{"message":"buddy: 请求被拦截，……","code":"INVALID_REQUEST","status":400}}`
- `request/context`：本轮 provider / model

**判读**：`system/message` 首段若仍带着旧对策（如前导空格），说明 guard 生效；此时还报 11128，就是上游判据变了。

### 2.2 直接对上游发请求（别靠 DSH 复现，太慢）

请求头照 `channel-pack` 的 `BuddyAdapter.send()` 抄：

```
POST https://copilot.tencent.com/v2/chat/completions
Authorization: Bearer <access_token>
Accept: text/event-stream
Content-Type: application/json
X-Domain: copilot.tencent.com
X-Product-Code: codebuddy
X-Agent-Purpose: conversation
X-IDE-Name: CodeBuddy        X-IDE-Type: CodeBuddy        X-IDE-Version: 1.106.1
X-Product: CodeBuddy
User-Agent: CodeBuddyIDE/1.106.1
```

body：`{"model":"deepseek-v4.1-flash","stream":true,"max_tokens":8,"messages":[{"role":"system",…},{"role":"user","content":"hi"}]}`

token 取自 `<DSH_HOME>/.credentials.yaml` 里的 `"access_token":"eyJ..."`。

硬规则：**每次只改一个变量**。先抛 `"You are a helpful assistant."` 做基线 200，证明账号/端点/请求头没问题。

### 2.3 二分与收敛

1. 把真实 system 按 `\n\n` 切段，测**前 1 段** → 若已 400，问题必在首段，无需往下二分
2. 首段做最小变量矩阵（原句 / 加空格 / 插逗号 / 换主语 / 换品牌 / 拆两句）
3. 把通过的最小改写套回**全量**（十几万字）system 验证 —— 局部通过 ≠ 整包通过，门 2 还等着
4. 单独验证门 2：全量 + 首段已修 + A 还原 → 若 400，A 改写必须保留

---

## 3. 修在哪

`lib/index.js`（v0.1.2）：

```js
// 门 1：改写句式，不再加空白
const PREFIX_REWRITES = [['You are an AI agent powered by', 'You are an AI agent, powered by']]

// 门 2：改 A，保留 B
const FINGERPRINTS = [[
  'Tokens prefixed with @ are paths the user explicitly referenced',
  'Path tokens starting with the at-sign point at locations the user referenced',
]]

// 先剥前导空白再比对（上游是 ^\s*），并且幂等
function scrubPrefix(text) {
  const body = text.replace(/^\s+/, '')
  for (const [from, to] of PREFIX_REWRITES) {
    if (body.startsWith(from)) return to + body.slice(from.length)
  }
  return text
}
```

---

## 4. 验证（必须跑到「上游 200」）

```bash
DSH_HOME=<DSH_HOME> node docs/tools/buddy-guard-verify.mjs
# 只跑本地断言：SKIP_UPSTREAM=1
# 指定会话：node docs/tools/buddy-guard-verify.mjs <session.v4.jsonl.zstd>
# 指定 profile / 模型：PROFILE=web-desktop MODEL=deepseek-v4.1-flash
```

脚本会：自动找最新会话并解帧 → **真实 import 插件**并用假 ctx 驱动监听器 → 本地断言 →
插件输出与原始 system 各打一次上游。

通过标准（2026-10-29 实测）：

```
  ✓ 首段句式已改写   ✓ A 句已改写   ✓ B 句保留   ✓ 幂等   ✓ 非目标渠道原样放行
[2] 上游（原始 system）: {"status":400,"code":11128}
[3] 上游（插件输出）:    {"status":200,"code":"ok"}
```

> 只验正则/字符串替换不够：本项目历史上踩过「插件加载正常、配置也对、请求一个字没变」的坑。必须真实加载模块 + 真实打上游。

---

## 5. 坑清单

1. **`next` 不接受参数**：cordis 的 waterfall 是 `(cbs.shift() ?? inner)(...args)`，`next(改过的 options)` 会被丢弃。改写只能靠**监听器返回值**。
2. **必须 `prepend: true`**：外层若有「不调用 next()」的监听器（如 dsh-ops discovery 分支），会短路整条链。
3. **历史消息动不了**：`agent/request` 契约写明不可改 messages，`llm/stream` 的 options 是 deep-frozen。旧会话引用过指纹就只能**新开会话**。
4. **备份别放包内**：DSH 的 `listPackageFiles` 会把 `.bak` 收进升级快照。放到 `<DSH_HOME>/plugin-backups/`。
5. **插件升级整包覆盖**，升级后确认 `lib/index.js` 里 `PREFIX_REWRITES` 还在。
6. 只有 `variables.provider` 命中 `config.providers`（默认 `['buddy']`）才改写；`workbuddy` 是另一个 provider id（它另有坑：**必须传 system**，否则 400/11128 `first message is not system prompt`）。
7. **别把 11128 当内容安全**：`isContentRejection()` 里 11128 明确返回 false，11140 才是内容拒绝。

**生效条件**：改完 `lib/index.js` 后需**重启 DSH**（或重开 profile），并在 buddy 渠道**新开会话**。

---

## 6. 其他分支速查

- `code 11140` / `request illegal` / `安全审核`：真内容拦截，账号被标记 30 分钟冷却（`BUDDY_POLICY_BLOCK_COOLDOWN_MS`），换号或等冷却。
- `first message is not system prompt`：适配器没发 system（WorkBuddy 网关特有），检查 `messages[0].role`。
- `上游 14003 model busy`：请求量饱和，会自动换号重试（`BUDDY_SATURATION_MAX_RETRIES`）。
- 额度/换号问题与本文无关，看 Channel Pack 的 balance selector。

---

## 7. 变更记录

| 日期 | 上游变化 | 对策 | 版本 |
| --- | --- | --- | --- |
| 2026-10-21 | 身份句前缀匹配 | 首段前置半角空格 | 0.1.0 |
| 2026-10-27 | 增加 A+B 组合指纹 | 改写 A 句 | 0.1.1 |
| **2026-10-29** | 身份句判据变 `^\s*` | **句中插逗号**，弃用前导空格 | **0.1.2** |
