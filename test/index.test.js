import { test } from 'node:test'
import assert from 'node:assert/strict'

import { name, inject, apply } from '../lib/index.js'

const IDENTITY = 'You are an AI agent powered by DeepSeek Harness.'
const REWRITTEN = 'You are an AI agent, powered by DeepSeek Harness.'
const PH_A = 'Tokens prefixed with @ are paths the user explicitly referenced'
const PH_A_NEW = 'Path tokens starting with the at-sign point at locations the user referenced'
const PH_B = 'Relative paths resolve from the workspace root'

/** 捕获插件注册的 system-prompt/assemble 监听器。 */
function mount(config = { enabled: true, providers: ['buddy'] }) {
  let handler = null
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(event, fn) { if (event === 'system-prompt/assemble') handler = fn },
  }
  apply(ctx, config)
  assert.equal(typeof handler, 'function', 'apply 应注册 system-prompt/assemble 监听器')
  return handler
}

/** 走一次 waterfall 语义：next 不接受参数，结果靠返回值传递。 */
async function assemble(handler, assembly, provider) {
  return await handler(assembly, { agent: { options: { provider } } }, async () => assembly)
}

function asm(provider, text = IDENTITY) {
  return {
    sections: [
      { name: 'harness:identity', order: -1000, text },
      { name: 'body', order: 0, text: 'rest of prompt' },
    ],
    contexts: [],
    tools: [],
    variables: { provider },
  }
}

test('导出 name / inject / apply', () => {
  assert.equal(name, 'dsh-buddy-guard')
  assert.deepEqual(inject, ['llm'])
  assert.equal(typeof apply, 'function')
})

test('buddy 渠道：身份句改为句中型式（前缀不再靠空白）', async () => {
  const out = await assemble(mount(), asm('buddy'), 'buddy')
  assert.equal(out.sections[0].text, REWRITTEN)
})

test('2026-10-29 回归：改写结果里不再出现 "^You are an AI agent powered by"', async () => {
  const out = await assemble(mount(), asm('buddy'), 'buddy')
  assert.ok(!out.sections[0].text.startsWith('You are an AI agent powered by'))
})

test('前导空格不再是对策：带空格也要被剥掉并改写', async () => {
  const out = await assemble(mount(), asm('buddy', ` ${IDENTITY}`), 'buddy')
  assert.equal(out.sections[0].text, REWRITTEN)
  assert.ok(!/^\s/.test(out.sections[0].text), '结果不应以空白开头')
})

test('无句号的变体同样改写（上游按前缀匹配，不看结尾）', async () => {
  const out = await assemble(mount(), asm('buddy', 'You are an AI agent powered by DeepSeek Harness'), 'buddy')
  assert.equal(out.sections[0].text, 'You are an AI agent, powered by DeepSeek Harness')
})

test('已带逗号的文本保持原样（幂等）', async () => {
  const out = await assemble(mount(), asm('buddy', REWRITTEN), 'buddy')
  assert.equal(out.sections[0].text, REWRITTEN)
})

test('非目标渠道：原样透传', async () => {
  const out = await assemble(mount(), asm('workbuddy'), 'workbuddy')
  assert.equal(out.sections[0].text, IDENTITY)
})

test('variables 缺 provider 时回落到 agent.options', async () => {
  const handler = mount()
  const a = { sections: [{ name: 'x', text: IDENTITY }], variables: {} }
  const out = await assemble(handler, a, 'buddy')
  assert.equal(out.sections[0].text, REWRITTEN)
})

test('不是身份句的 section 不会被改动', async () => {
  const out = await assemble(mount(), asm('buddy', 'Hello there'), 'buddy')
  assert.equal(out.sections[0].text, 'Hello there')
})

test('不改动其它 section', async () => {
  const out = await assemble(mount(), asm('buddy'), 'buddy')
  assert.equal(out.sections[1].text, 'rest of prompt')
})

test('空 section 保持为空', async () => {
  const handler = mount()
  const a = {
    sections: [
      { name: 'empty', order: -1000, text: '' },
      { name: 'real', order: 0, text: IDENTITY },
    ],
    variables: { provider: 'buddy' },
  }
  const out = await assemble(handler, a, 'buddy')
  assert.equal(out.sections[0].text, '')
  assert.equal(out.sections[1].text, REWRITTEN)
})

test('渲染后整段以改写句开头，且不带前导空白', async () => {
  const out = await assemble(mount(), asm('buddy'), 'buddy')
  const rendered = out.sections.map((s) => s.text).filter((t) => t.length > 0).join('\n\n')
  assert.ok(rendered.startsWith(REWRITTEN))
  assert.equal(rendered[0], 'Y')
})

test('providers 可配置', async () => {
  const handler = mount({ enabled: true, providers: ['workbuddy'] })
  const out = await assemble(handler, asm('workbuddy'), 'workbuddy')
  assert.equal(out.sections[0].text, REWRITTEN)
  const out2 = await assemble(handler, asm('buddy'), 'buddy')
  assert.equal(out2.sections[0].text, IDENTITY)
})

test('enabled:false 时不注册监听器', () => {
  let handler = null
  apply(
    { logger: { info() {}, warn() {}, debug() {} }, on(e, fn) { if (e === 'system-prompt/assemble') handler = fn } },
    { enabled: false },
  )
  assert.equal(handler, null)
})

test('异常时回退到原始 assembly（不阻断）', async () => {
  const handler = mount()
  const a = asm('buddy')
  const broken = { ...a, sections: null }
  const out = await assemble(handler, broken, 'buddy')
  assert.equal(out, broken)
})

test('清除上游指纹 A（AND 匹配的一半），B 保留原文', async () => {
  const handler = mount()
  const a = {
    sections: [
      { name: 'identity', text: IDENTITY },
      { name: 'paths', text: `${PH_A}. ${PH_B};` },
    ],
    variables: { provider: 'buddy' },
  }
  const out = await assemble(handler, a, 'buddy')
  assert.ok(!out.sections[1].text.includes(PH_A), 'A 必须被改写（否则上游 AND 匹配成立）')
  assert.ok(out.sections[1].text.includes(PH_A_NEW))
  assert.ok(out.sections[1].text.includes(PH_B), 'B 应保留原文（它描述路径语义，对模型最有用）')
  assert.equal(out.sections[0].text, REWRITTEN)
})

test('指纹清理覆盖所有 section，不只首个', async () => {
  const handler = mount()
  const a = {
    sections: [
      { name: 'head', text: 'head' },
      { name: 'tail', text: `tail mentions ${PH_A} here` },
    ],
    variables: { provider: 'buddy' },
  }
  const out = await assemble(handler, a, 'buddy')
  assert.ok(!out.sections[1].text.includes(PH_A))
  assert.equal(out.sections[0].text, 'head')
})

test('非目标渠道：指纹原样保留', async () => {
  const handler = mount()
  const a = { sections: [{ name: 'x', text: PH_A }], variables: { provider: 'workbuddy' } }
  const out = await assemble(handler, a, 'workbuddy')
  assert.equal(out.sections[0].text, PH_A)
})

test('注册选项：prepend 必须在（否则会被不调 next 的监听器短路）', () => {
  let opts = null
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    on(event, _fn, o) { if (event === 'system-prompt/assemble') opts = o },
  }
  apply(ctx, { enabled: true, providers: ['buddy'] })
  assert.deepEqual(opts, { global: true, prepend: true })
})

test('幂等：二次经过不再产生任何变化', async () => {
  const handler = mount()
  const once = await assemble(handler, asm('buddy'), 'buddy')
  const twice = await assemble(handler, once, 'buddy')
  assert.deepEqual(twice.sections, once.sections)
})

test('组合：身份句 + 指纹 A 同时被处理', async () => {
  const handler = mount()
  const a = {
    sections: [
      { name: 'identity', text: IDENTITY },
      { name: 'paths', text: `See ${PH_A} for details.` },
    ],
    variables: { provider: 'buddy' },
  }
  const out = await assemble(handler, a, 'buddy')
  const rendered = out.sections.map((s) => s.text).filter((t) => t.length > 0).join('\n\n')
  assert.ok(rendered.startsWith(REWRITTEN))
  assert.ok(!rendered.includes(PH_A))
})
