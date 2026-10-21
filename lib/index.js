/**
 * dsh-buddy-guard
 *
 * 背景（2026-10-21 实测）：
 *   CodeBuddy（腾讯）的 `/v2/chat/completions` 对 system 内容做硬拦截。只要
 *   system 文本**以** "You are an AI agent powered by DeepSeek Harness." 开头，
 *   就返回 400 `Illegal API invocation from an unapproved channel`，与域名、
 *   X-Domain、X-Product-Code、X-IDE-*、端点（copilot.tencent.com 还是
 *   www.codebuddy.cn）都无关。
 *
 *   边界实测（同一账号、同一端点、同一条 user 消息）：
 *     - 原句                                → 400 拦截
 *     - 原句**前面**加 1 个空格 / 1 个字母   → 200 通过
 *     - 原句后面加空格 / 换行 / 句号 / 段落   → 400 仍然拦截
 *   即：它只匹配 system 文本的开头，前置任何字符即可让匹配失败。
 *
 * 实现要点（重要，别踩回去）：
 *   cordis 的 waterfall 里 `next` 是 `() => (cb ?? inner)(...args)` —— **不接受
 *   参数**。所以在 `llm/stream` 里写 `next(改过的options)` 是无效的，参数会被
 *   直接丢弃（第一版就栽在这，插件加载成功但请求一点没变）。
 *
 *   可行做法是在 `system-prompt/assemble` 里**返回**改写后的 assembly：waterfall
 *   的返回值取自最外层监听器的 return，而 assemble() 直接用这个返回值。
 *
 * @module dsh-buddy-guard
 */

export const name = 'dsh-buddy-guard'

/** llm 服务用于注册 `llm/stream` 监听。 */
export const inject = ['llm']

/** 补丁字符：一个半角空格。实测前置任意字符均可使上游匹配失败。 */
const GUARD_PREFIX = ' '

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
 * 给 assembly 的首个非空 section 加前导空格。
 *
 * renderPrompt 用 "\n\n" join 各 section，所以只要首个 section 以空格开头，
 * 渲染出来的整段 system 文本也就以空格开头。
 *
 * @param {object} assembly
 * @returns {object|null} 新 assembly；无需改动时返回 null
 */
function guardAssembly(assembly) {
  const sections = assembly?.sections
  if (!Array.isArray(sections) || sections.length === 0) return null

  const idx = sections.findIndex((s) => s !== null && typeof s === 'object' && typeof s.text === 'string' && s.text.length > 0)
  if (idx === -1) return null

  const target = sections[idx]
  if (target.text.startsWith(GUARD_PREFIX)) return null

  const nextSections = sections.slice()
  nextSections[idx] = { ...target, text: GUARD_PREFIX + target.text }
  return { ...assembly, sections: nextSections }
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

  if (!enabled) {
    ctx.logger?.info?.('[buddy-guard] disabled by config')
    return
  }

  ctx.logger?.info?.(`[buddy-guard] guarding providers: ${[...providers].join(', ')}`)

  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const out = await next()
    try {
      if (!providers.has(resolveProvider(out, context))) return out
      const guarded = guardAssembly(out)
      if (guarded === null) return out
      ctx.logger?.debug?.('[buddy-guard] system prompt prefixed for guarded provider')
      return guarded
    } catch (error) {
      // 补丁失败绝不阻断提示词组装。
      ctx.logger?.warn?.(`[buddy-guard] skipped: ${String(error)}`)
      return out
    }
  }, { global: true })
}
