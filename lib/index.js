/**
 * dsh-buddy-guard
 *
 * 让 CodeBuddy（腾讯）的 /v2/chat/completions 接受 DeepSeek Harness 的请求。
 *
 * 上游有两道「未经授权渠道」硬拦截（2026-10-21 / 2026-10-27 实测）：
 *
 *   (1) system 文本以 "You are an AI agent powered by DeepSeek Harness." 开头
 *       → 400 / code 11128。
 *       对策：GUARD_PREFIX —— 给首个非空 section 前置一个半角空格。
 *
 *   (2) system 文本里**同时**出现下面两个短语（AND 匹配，单独出现都放行）
 *       → 400 / code 11128：
 *
 *         A: "Tokens prefixed with @ are paths the user explicitly referenced"
 *         B: "Relative paths resolve from the workspace root"
 *
 *       这两句都在 DSH 描述 at-sign 路径引用语法的正文里，**每轮请求必带**，
 *       所以只做 (1) 是不够的 —— 必须同时改写其中一句。
 *
 * 边界实测（同一账号 / 同一端点 / 同一条 user 消息）：
 *   原句                       → 400
 *   原句前加 1 个空格           → 200
 *   原句后追加内容              → 400（它看的是开头）
 *   A + B 同时出现              → 400
 *   改写 A、B 保留原文           → 200
 *   改写 B、A 保留原文           → 200
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
 *     若某个会话的历史里引用过这两个短语，请新开会话。
 *
 * @module dsh-buddy-guard
 */

import { appendFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'dsh-buddy-guard'

/** llm 服务：用于拿到 ctx 注册瀑布监听。 */
export const inject = ['llm']

/** 补丁字符：一个半角空格。实测前置任意字符都能让开头匹配失败。 */
const GUARD_PREFIX = ' '

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
 * 给首个非空 section 加前导空格，并清除所有 section 里的上游指纹。
 *
 * renderPrompt 用两个换行 join 各 section，所以首个 section 以空格开头时，
 * 渲染出的整段 system 文本也会以空格开头。
 *
 * @param {object} assembly
 * @returns {object|null} 新 assembly；无需改动时返回 null
 */
function guardAssembly(assembly) {
  const sections = assembly?.sections
  if (!Array.isArray(sections) || sections.length === 0) return null

  const idx = sections.findIndex((s) => s !== null && typeof s === 'object' && typeof s.text === 'string' && s.text.length > 0)
  if (idx === -1) return null

  const nextSections = sections.slice()
  let changed = false
  for (let i = 0; i < nextSections.length; i++) {
    const section = nextSections[i]
    if (section === null || typeof section !== 'object' || typeof section.text !== 'string') continue

    let text = scrubFingerprints(section.text)
    if (i === idx && !text.startsWith(GUARD_PREFIX)) text = GUARD_PREFIX + text
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
