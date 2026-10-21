import { test } from 'node:test'
import assert from 'node:assert/strict'

import { name, inject, apply } from '../lib/index.js'

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

function asm(provider, text = 'You are an AI agent powered by DeepSeek Harness.') {
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

test('buddy 渠道：首个 section 加前导空格', async () => {
  const out = await assemble(mount(), asm('buddy'), 'buddy')
  assert.equal(out.sections[0].text, ' You are an AI agent powered by DeepSeek Harness.')
})

test('非目标渠道：原样透传', async () => {
  const out = await assemble(mount(), asm('workbuddy'), 'workbuddy')
  assert.equal(out.sections[0].text, 'You are an AI agent powered by DeepSeek Harness.')
})

test('幂等：已带空格不重复叠加', async () => {
  const handler = mount()
  const once = await assemble(handler, asm('buddy'), 'buddy')
  const twice = await assemble(handler, once, 'buddy')
  assert.equal(twice.sections[0].text, once.sections[0].text)
})

test('variables 缺 provider 时回落到 agent.options', async () => {
  const handler = mount()
  const a = { sections: [{ name: 'x', text: 'Hello' }], variables: {} }
  const out = await assemble(handler, a, 'buddy')
  assert.equal(out.sections[0].text, ' Hello')
})

test('不改动其它 section', async () => {
  const out = await assemble(mount(), asm('buddy'), 'buddy')
  assert.equal(out.sections[1].text, 'rest of prompt')
})

test('跳过空 section，改首个非空', async () => {
  const handler = mount()
  const a = {
    sections: [
      { name: 'empty', order: -1000, text: '' },
      { name: 'real', order: 0, text: 'Real prompt' },
    ],
    variables: { provider: 'buddy' },
  }
  const out = await assemble(handler, a, 'buddy')
  assert.equal(out.sections[0].text, '')
  assert.equal(out.sections[1].text, ' Real prompt')
})

test('渲染后整段以空格开头（renderPrompt 的 join 语义）', async () => {
  const out = await assemble(mount(), asm('buddy'), 'buddy')
  const rendered = out.sections.map((s) => s.text).filter((t) => t.length > 0).join('\n\n')
  assert.ok(rendered.startsWith(' '))
  assert.equal(rendered[0], ' ')
  // 去掉前导空格后应与原句一致，证明只加了一个字符
  assert.equal(rendered.slice(1).split('\n\n')[0], 'You are an AI agent powered by DeepSeek Harness.')
})

test('providers 可配置', async () => {
  const handler = mount({ enabled: true, providers: ['workbuddy'] })
  const out = await assemble(handler, asm('workbuddy'), 'workbuddy')
  assert.equal(out.sections[0].text, ' You are an AI agent powered by DeepSeek Harness.')
  const out2 = await assemble(handler, asm('buddy'), 'buddy')
  assert.equal(out2.sections[0].text, 'You are an AI agent powered by DeepSeek Harness.')
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
