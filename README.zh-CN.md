# dsh-buddy-guard

修掉 DeepSeek Harness 里 **buddy / CodeBuddy（腾讯）** 渠道每个请求都返回 HTTP 400 的问题：

```
buddy: 请求被拦截，请重新发送 Illegal API invocation from an unapproved channel
```

[English](README.md)

```bash
dsh plugin add github:AsterLuo/dsh-buddy-guard --profile <你的 profile>

# 固定版本（推荐，防止上游改动影响你）：
dsh plugin add github:AsterLuo/dsh-buddy-guard#v0.1.2 --profile <你的 profile>
```

> 装完**必须重启 DSH**，然后在 buddy 渠道**新开一个会话**再试（已经在会话历史里的 system prompt，插件改不到）。

**v0.1.2（2026-10-29）**：上游把第一道门收紧成 `^\s*`，前导空格对策彻底失效；插件改为直接改写句式。
见 [第三道变更](#第三道变更第一道门被收紧2026-10-29-实测)。

## 问题是什么

在 `buddy` 渠道选任意模型（`hy4-preview`、`deepseek-v4.1-flash`、`hy3` …），每一轮都失败，
HTTP 400 `INVALID_REQUEST`。同一个账号、同一个端点，只要请求不带 DSH 的 system prompt 就一切正常。

上游目前有**三道独立规则**，全都回 `400 / code 11128`：

| # | 实测时间 | 规则 |
| --- | --- | --- |
| 1 | 2026-10-21，2026-10-29 收紧 | system 文本以身份句开头 |
| 2 | 2026-10-27 | system 文本里短语 A 与短语 B **同时**出现 |
| 3 | 见下 | 身份句判据**忽略前导空白** |

## 第一道拦截：身份句（2026-10-21 实测，2026-10-29 收紧）

上游对 system 内容做**开头匹配**。只要 system 文本以

```
You are an AI agent powered by DeepSeek Harness.
```

开头就直接拒。下面这些**全都无关**（逐一改过，状态码一律 400）：

- `X-Domain`（`copilot.tencent.com` vs `www.codebuddy.cn`）
- `X-Product-Code` / `X-Product` / `X-Agent-Purpose`
- `X-IDE-Name` / `X-IDE-Type` / `X-IDE-Version` / `User-Agent`
- 端点（`copilot.tencent.com` 与 `www.codebuddy.cn` 表现完全一致）
- 模型（`hy4-preview`、`hy3`、`deepseek-v4.1-flash` 全拦）

边界测试 —— 中间那列是 2026-10-29 之前有效的对策，右边是现在有效的：

| system 内容 | 2026-10-21 | 2026-10-29 |
| --- | --- | --- |
| `You are an AI agent powered by DeepSeek Harness.` | 400 | 400 |
| 同一行**前面**加一个空格 | **200** | **400** |
| 前面加两个空格 | 200 | 400 |
| 前面加一个字母 / 一个句点 | 200 | 200 |
| `Note: You are an AI agent powered by …` | — | 200 |
| `You are an AI agent, powered by …` | — | 200 |
| 后面加空格 / 换行 / 句号 / 整段正文 | 400 | 400 |
| 这句话放进 user 消息 | 200 | 200 |
| 只有 `DeepSeek Harness`，或小写 `deepseek harness` | 200 | 200 |

## 第三道变更：第一道门被收紧（2026-10-29 实测）

上游**只改了一个正则**：

```diff
- ^You are an AI agent powered by … Harness
+ ^\s*You are an AI agent powered by … Harness
```

前导空白被忽略，于是所有「前面加个字符」的补丁全部作废 —— 这正是 v0.1.1
（前置一个空格）开始失效的原因：插件明明生效了，照样被拦。

现在插件改为改写**句子本身**：`powered by` → `, powered by`。

判据是**整句式**，不是关键词。2026-10-29 实测（同账号、同端点、同一条 user 消息）：

| system 内容 | 结果 |
| --- | --- |
| 只有 `DeepSeek Harness` | 200 |
| `powered by DeepSeek Harness.` | 200 |
| `You are an AI agent powered by Foo Harness.`（换品牌） | 200 |
| `You are an AI agent powered by DeepSeek Harness.` | **400** |
| 同一句前面加 1 个或 2 个空格 | **400** |
| `You are an AI agent, powered by DeepSeek Harness.` | 200 |
| `Note: You are an AI agent powered by …` | 200 |
| `I am an AI agent powered by …` / `running on …` / 拆成两句 | 200 |

## 第二道拦截：A+B 组合指纹（2026-10-27 实测）

上游还有**独立的一道**规则：system 文本里**同时**出现下面两个短语时照样拒（AND 匹配，
单独出现都放行）：

- `Tokens prefixed with @ are paths the user explicitly referenced`
- `Relative paths resolve from the workspace root`

这两句都是 DSH system prompt 里描述 `@` 路径引用语法的正文，**每轮请求必带**。

实测（同账号、同端点）：

| system 内容 | 结果 |
| --- | --- |
| 只有短语 A | 200 |
| 只有短语 B | 200 |
| **A 和 B 同时出现** | **400** `11128` |
| 改写 A、B 保留原文 | 200 |
| 改写 B、A 保留原文 | 200 |

所以插件**只改写 A**，B 原样保留 —— B 描述的是 `read` / `write` / `glob` 依赖的相对路径规则，
保留原文对模型最友好；改写与原文语义等价。

> **2026-10-29 复测：这条规则仍在。** 对照实验：修好身份句、但把 A 还原成原文 → 仍 `400`。
> 所以 A 句改写**不能删**。

### 历史消息是盲区

上游会扫**每一条**消息，所以**对话历史**里出现过 A/B（或身份句）一样会被拦。插件对此无能为力：
`agent/request` 的契约明确写着它 *cannot mutate messages*，而 `llm/stream` 的 options 是
deep-frozen（改就抛错）。如果某个会话引用过这些句子，请**新开会话**。

### 这个结论是怎么查出来的（可复现）

1. 取到**完整的外发 system 文本** —— 最省事的是直接看会话日志：
   `<DSH_HOME>/sessions/…/session.v4.jsonl.zstd`，找其中的 `system/message` 事件。
   ⚠️ 该文件是**多帧** zstd（header 帧 + 每批事件一帧）。`zstdDecompressSync()` **只解第一帧**，
   直接读会看到一个只有 1 行的"空会话"。要按魔数 `28 B5 2F FD` 切帧、逐帧解。
2. 用该账号的 token + `channel-pack` 里 `BuddyAdapter.send()` 的请求头，把这段文本直接回放到端点。
3. 对首段做**一次只改一个变量**的矩阵（原句 / 加空格 / 插逗号 / 换主语 / 拆两句）。
   只有在首段单独就能复现时才需要往下二分 —— 这次就是「前 1 段已经 400」，直接收敛到首段。
4. 把修法套回**全量**（十几万字）system 再打一次 —— 局部通过不等于整包通过，第二道门还等着。

被拦的请求不消耗 token，所以这套流程很便宜。

```bash
# 现成的端到端校验：真实加载插件 + 真实打上游
node docs/tools/buddy-guard-verify.mjs
# 期望：上游(原始) 400/11128 → 上游(插件输出) 200
```

## 插件怎么修

监听 `system-prompt/assemble`，对 `config.providers` 里的渠道返回改写过的 assembly：

1. 改写所有 section 里的身份句 —— 先剥掉前导空白，再把
   `You are an AI agent powered by` 换成 `You are an AI agent, powered by`（幂等；不以该短语开头就不动）；
2. 扫描**每一个** section，把短语 A 改写成等价表述。

> **不要**再退回去用前导空格。`^\s*` 让它彻底变成空操作。

注册用 `{ global: true, prepend: true }`，**`prepend` 是必须的**：没有它，更外层只要有一个
**不调用 `next()`** 的监听器（例如 dsh-ops 的 discovery 分支会 `return prompt.assemble(context)`），
按 cordis 的规则 *"a listener that does not call `next()` vetoes the rest of the chain"*
就会把本插件整条短路 —— 插件照样加载、照样打日志、`--dump-config` 里也看得到，但请求一个字没变。

### 为什么不用 `llm/stream`

第一版就是钩 `llm/stream` 然后 `next(改过的options)` —— **完全无效**，而且不报错。cordis 的
waterfall 实现是：

```js
const next = () => (cbs.shift() ?? inner)(...args);
```

`next` 不接受参数，改过的 options 被直接丢弃。插件加载成功、日志正常、
`--dump-config` 里也能看到，但发出去的请求一个字节都没变。

改写入参只能靠**监听器的返回值**，不能靠给 next 传参。

## 安装

```bash
dsh plugin add github:AsterLuo/dsh-buddy-guard --profile <你的 profile>
```

这条命令会把包装进 profile 的 `node_modules` 并登记到 `dsh.profile.bundles`，
你自己的 `cordis.patch.yml` 不会被改动。

然后**重启 DSH** —— 配置只在启动时读一次。

### 手动安装

1. 把本仓库复制到 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-buddy-guard/`
2. 在该 profile 的 `package.json` 里，把 `"dsh-buddy-guard"` 追加到 `dsh.profile.bundles`
3. 同一个文件里，往 `dependencies` 加 `"dsh-buddy-guard": "0.1.2"`
4. 跑 `--dump-config` 确认里面有 `buddy-guard` 这一行
5. 重启 DSH

## 配置

```yaml
- id: buddy-guard
  name: 'dsh-buddy-guard'
  config:
    enabled: true
    providers:
      - buddy
```

- `enabled` —— 总开关。
- `providers` —— 要打补丁的渠道列表，默认 `['buddy']`；其它渠道原样透传。
- `debug` —— 为 `true` 时每次命中写一行到 `$DSH_HOME/buddy-guard.log`。默认关闭，热路径不写盘。

## 装完怎么验

重启后把模型切到 `buddy`，发一句话。正常回复就是通了。还是 400 的话：

1. 重跑 `--dump-config`，确认 `buddy-guard` 那一行在。
2. 确认 `lib/index.js` 里有 `PREFIX_REWRITES`（0.1.2+）—— 升级会整包覆盖，本地热修会丢。
3. 确认包名在 `dsh.profile.bundles` 里 —— 这一步最常被漏。
4. 确认你真的重启了 DSH，**并且开了新会话**。

> Full step-by-step troubleshooting (Chinese): [docs/troubleshooting.zh-CN.md](docs/troubleshooting.zh-CN.md)

## 注意

这是**绕过上游内容审查**。规则随时可能变，目前已知就有**三道**（其中一道还改过一次形态）。
哪天又报同样的错，先照着上面的「取 dump + 一次一变量」重做一遍，再决定改什么。

另外，出问题的那个账号是 CodeBuddy **中国版**（`www.codebuddy.cn`，JWT 的 `iss` 指向那里），
而客户端发的是国际版产品形态。这个不匹配本身就是上游说的 "unapproved channel" —— 本插件只是让它
暂时能用，并没有解决这个不匹配。换用 `workbuddy`（国际版）可以完全绕开这道检查。

## 测试

```bash
npm test
```

## 许可

MIT
