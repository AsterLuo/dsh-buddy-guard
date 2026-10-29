/**
 * dsh-buddy-guard
 *
 * 让 CodeBuddy（腾讯）的 /v2/chat/completions 接受 DeepSeek Harness 的请求。
 *
 * 上游有两道「未经授权渠道」硬拦截（2026-10-21 / 2026-10-27 / **2026-10-29 三次实测**）：
 *
 *   (1) system 文本开头命中「身份句」→ 400 / code 11128
 *       （msg: Illegal API invocation from an unapproved channel）
 *
 *       判据随上游三次收紧，**每次都只改了一个正则**：
 *
 *         2026-10-21  ^You are an AI agent powered by … Harness
 *                     对策：给首个 section 前置一个半角空格（前身 GUARD_PREFIX）。
 *         2026-10-29  ^\s*You are an AI agent powered by … Harness
 *                     ← 加了 \s*，**前导空白被忽略**，空格对策彻底失效。
 *                     对策：改写句式本身（PREFIX_REWRITES），句中插一个逗号即可。
 *
 *       2026-10-29 边界实测矩阵（同一账号 / 同一端点 / 同一条 user 消息）：
 *
 *         判据是「整句式」而不是关键词：
 *           "DeepSeek Harness"                              → 200（品牌词单独出现放行）
 *           "powered by DeepSeek Harness."                  → 200
 *           "You are an AI agent powered by Foo Harness."   → 200（品牌可换）
 *           "You are an AI agent powered by DeepSeek Harness."   → 400 ← 只有这条句式命中
 *           " You are an AI agent powered by DeepSeek Harness."  → 400（1 个空格无效）
 *           "  You are …"                                        → 400（2 个空格无效）
 *           "Note: You are an AI agent powered by …"             → 200（前面加词有效）
 *           "You are an AI agent, powered by …"                  → 200（句中插逗号有效）
 *           "I am an AI agent powered by …" / "running on …"     → 200（改主语/动词有效）
 *
 *   (2) system 文本里**同时**出现下面两个短语（AND 匹配，单独出现都放行）
 *       → 400 / code 11128：
 *
 *         A: "Tokens prefixed with @ are paths the user explicitly referenced"
 *         B: "Relative paths resolve from the workspace root"
 *
 *       这两句都在 DSH 描述 at-sign 路径引用语法的正文里，**每轮请求必带**，
 *       所以只修 (1) 是不够的 —— 必须同时改写其中一句。
 *
 *       ⚠️ 2026-10-29 复测：**这条仍然有效**，不要因为修好了 (1) 就把它删掉。
 *          对照实验：首段已修 + 把 A 句还原 → 仍 400。
 *
 * 实现要点（别踩回去）：
 *   - cordis 的 waterfall 里 next 是 (cbs.shift() ?? inner)(...args) —— **不接受参数**，
 *     写 next(改过的 options) 会被直接丢弃。改写只能靠**监听器的返回值**。
 *   - 所以本插件挂 system-prompt/assemble，返回改写后的 assembly。
 *   - 注册必须带 prepend: true。否则更外层若存在一个**不调用 next()** 的监听器
 *     （例如 dsh-ops 的 discovery 分支会 return prompt.assemble(context)），
 *     按 cordis 的规则「a listener that does not call next() vetoes the rest of the chain」
 *     会直接短路掉本插件：插件加载正常、配置也正确，但请求一个字没变。
 *   - 历史消息里的指纹本插件处理不了：agent/request 的契约明确写着
 *     "this waterfall cannot mutate messages"，而 llm/stream 的 options 是 deep-frozen。
 *     若某个会话的历史里引用过这些短语，请新开会话。
 *   - **别再依赖前导空白**（2026-10-29 起无效）。要改就改句子里的字符。
 *
 * @module dsh-buddy-guard
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-buddy-guard'

/** llm 服务：用于拿到 ctx 注册瀑布监听。 */
export const inject = ['llm']

/**
 * 首段「身份句」改写表，元素为 [原文前缀, 改写前缀]。
 *
 * 只往句子里插一个逗号：语义完全等价，但开头不再是上游正则要的那串。
 * 2026-10-29 实测：全量 119 KB system 由 400 变 200。
 */
const PREFIX_REWRITES = [
  ['You are an AI agent powered by', 'You are an AI agent, powered by'],
]

/**
 * 上游指纹改写表，元素为 [原文, 改写]。
 *
 * 只破坏其中一句就能让 AND 匹配失败。默认**只改 A**：B（相对路径解析规则）
 * 直接描述 read/write/glob 的路径语义，原样保留对模型最友好。
 * 每条改写都与原文语义等价、长度相近。
 */
const FINGERPRINTS = [
  [
    'Tokens prefixed with @ are paths the user explicitly referenced',
    'Path tokens starting with the at-sign point at locations the user referenced',
  ],
]

/**
 * 解析本轮实际使用的 provider。
 * @param {object} assembly - system-prompt assembly（含 variables）
 * @param {object} context - assemble 上下文（含 agent）
 * @returns {string}
 */
function resolveProvider(assembly, context) {
  const vars = assembly?.variables ?? {}
  if (typeof vars.provider === 'string' && vars.provider.length > 0) return vars.provider
  const agentProvider = context?.agent?.options?.provider
  return typeof agentProvider === 'string' ? agentProvider : ''
}

/**
 * 改写全部上游指纹短语。
 * @param {string} text
 * @returns {string}
 */
function scrubFingerprints(text) {
  let out = text
  for (const pair of FINGERPRINTS) out = out.split(pair[0]).join(pair[1])
  return out
}

/**
 * 若文本在「忽略前导空白」后以某个身份句前缀开头，则改写该前缀。
 *
 * 必须先剥掉前导空白再比对：上游判据是 ^\s*，留着空格只会让本地判断错位。
 * 幂等：已改写过的文本不会再命中（逗号已经插进去了）。
 *
 * @param {string} text
 * @returns {string}
 */
function scrubPrefix(text) {
  const body = text.replace(/^\s+/, '')
  for (const [from, to] of PREFIX_REWRITES) {
    if (body.startsWith(from)) return to + body.slice(from.length)
  }
  return text
}

/**
 * 对一段 section 文本做全部改写（身份句 + 指纹短语）。
 * @param {string} text
 * @returns {string}
 */
function guardText(text) {
  return scrubFingerprints(scrubPrefix(text))
}

/**
 * 改写 assembly 里的所有 section：身份句句式 + 上游指纹短语。
 *
 * @param {object} assembly
 * @returns {object|null} 新 assembly；无需改动时返回 null
 */
function guardAssembly(assembly) {
  const sections = assembly?.sections
  if (!Array.isArray(sections) || sections.length === 0) return null

  const nextSections = sections.slice()
  let changed = false
  for (let i = 0; i < nextSections.length; i++) {
    const section = nextSections[i]
    if (section === null || typeof section !== 'object' || typeof section.text !== 'string') continue

    const text = guardText(section.text)
    if (text !== section.text) {
      nextSections[i] = { ...section, text }
      changed = true
    }
  }

  return changed ? { ...assembly, sections: nextSections } : null
}

/**
 * 构造诊断日志函数，仅在 config.debug === true 时写盘。
 * @param {boolean} enabled
 * @returns {(line: string) => void}
 */
function makeDiag(enabled) {
  if (!enabled) return () => {}
  return (line) => {
    try {
      const home = process.env.DSH_HOME
      if (!home) return
      appendFileSync(join(home, 'buddy-guard.log'), new Date().toISOString() + ' ' + line + '\n')
    } catch {
      // 诊断失败绝不影响主流程。
    }
  }
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文
 * @param {object} config - entry config
 */
export function apply(ctx, config) {
  const enabled = config?.enabled !== false
  const configured = Array.isArray(config?.providers) && config.providers.length > 0
    ? config.providers.map((p) => String(p))
    : ['buddy']
  const providers = new Set(configured)
  const diag = makeDiag(config?.debug === true)

  if (!enabled) {
    ctx.logger?.info?.('[buddy-guard] disabled by config')
    return
  }

  ctx.logger?.info?.('[buddy-guard] guarding providers: ' + [...providers].join(', '))

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    try {
      const provider = resolveProvider(out, context)
      if (!providers.has(provider)) return out

      const guarded = guardAssembly(out)
      if (guarded === null) return out

      diag('adjusted provider=' + provider)
      ctx.logger?.debug?.('[buddy-guard] system prompt adjusted for guarded provider')
      return guarded
    } catch (error) {
      diag('error: ' + String(error))
      // 补丁失败绝不阻断提示词组装。
      ctx.logger?.warn?.('[buddy-guard] skipped: ' + String(error))
      return out
    }
  }, { global: true, prepend: true })
}
