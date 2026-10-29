#!/usr/bin/env node
/**
 * dsh-buddy-guard 端到端校验
 *
 * 做四件事：
 *   1. 从 <DSH_HOME>/sessions 里找最新的会话文件，按多帧 zstd 切帧，取出真实 system 全文；
 *   2. 真实 import 本插件，用假 ctx 驱动 system-prompt/assemble 监听器（不依赖 DSH 进程）；
 *   3. 本地断言：身份句已改写、A 已改写、B 保留、幂等、非目标渠道放行；
 *   4. 拿「原始 system」和「插件输出」各打一次上游，期望 400 → 200。
 *
 * 用法：
 *   $env:DSH_HOME = "<DSH_HOME>"; node docs/tools/buddy-guard-verify.mjs [会话文件]
 *   # 可选：$env:OUT_FILE 指定插件输出的落盘位置
 *
 * 环境：
 *   DSH_HOME     必填，用来找会话、凭据、插件
 *   PROFILE      可选，插件所在 profile 名；默认自动发现
 *   OUT_FILE     可选，插件输出 system 的落盘路径
 *   MODEL        可选，默认 deepseek-v4.1-flash
 *   SKIP_UPSTREAM=1  只跑本地断言，不发请求
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import { pathToFileURL } from 'node:url'

const HOME = process.env.DSH_HOME
if (!HOME) {
  console.error('缺少 DSH_HOME')
  process.exit(2)
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 递归找出所有 session.v4.jsonl.zstd，按 mtime 倒序。 */
function findSessions(root) {
  const found = []
  const walk = (dir) => {
    let ents = []
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const en of ents) {
      const full = dir + '\\' + en.name
      if (en.isDirectory()) walk(full)
      else if (en.name === 'session.v4.jsonl.zstd') {
        try {
          found.push({ full, mtime: fs.statSync(full).mtimeMs })
        } catch {}
      }
    }
  }
  walk(root + '\\sessions')
  return found.sort((a, b) => b.mtime - a.mtime)
}

/** 多帧 zstd：按魔数切帧，逐帧解压后拼接。 */
function decodeSession(file) {
  const buf = fs.readFileSync(file)
  const offsets = []
  let i = 0
  while (true) {
    const j = buf.indexOf(ZSTD_MAGIC, i)
    if (j === -1) break
    offsets.push(j)
    i = j + 4
  }
  const chunks = []
  for (let k = 0; k < offsets.length; k++) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'))
    } catch {}
  }
  return chunks
    .join('')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

/** 找到含 dsh-buddy-guard 的 profile 里的 index.js。 */
function findPlugin() {
  const named = process.env.PROFILE
  if (named) return HOME + '\\profiles\\' + named + '\\node_modules\\dsh-buddy-guard\\lib\\index.js'
  const dir = HOME + '\\profiles'
  for (const profile of fs.readdirSync(dir)) {
    const p = dir + '\\' + profile + '\\node_modules\\dsh-buddy-guard\\lib\\index.js'
    if (fs.existsSync(p)) return p
  }
  throw new Error('在 profiles/*/node_modules 里找不到 dsh-buddy-guard')
}

// ---- 1. 取真实 system ----
const explicit = process.argv[2]
const sessions = explicit ? [{ full: explicit, mtime: 0 }] : findSessions(HOME)
if (sessions.length === 0) throw new Error('找不到会话文件')
let systemText = null
let usedSession = null
for (const s of sessions) {
  const evs = decodeSession(s.full)
  const sysEv = [...evs].reverse().find((e) => e.type === 'system/message')
  if (sysEv) {
    systemText = sysEv.data.message.content[0].text
    usedSession = s.full
    break
  }
}
if (!systemText) throw new Error('会话里没有 system/message 事件')
console.log('[0] 会话:', usedSession)
console.log('[0] system 长度:', systemText.length, '| 首段:', JSON.stringify(systemText.slice(0, 60)))

// ---- 2. 真实加载插件 ----
const pluginPath = findPlugin()
const mod = await import(pathToFileURL(pluginPath).href)
let captured = null
const ctx = { on(name, fn, opts) { captured = { name, fn, opts } }, logger: { info() {}, warn() {}, debug() {} } }
mod.apply(ctx, { enabled: true, providers: ['buddy'] })
if (!captured) throw new Error('监听器未注册')
console.log('[1] 插件:', pluginPath)
console.log('[1] 监听器:', captured.name, '| prepend:', captured.opts?.prepend, '| global:', captured.opts?.global)

const assembly = { sections: [{ text: systemText }], variables: { provider: 'buddy' } }
const context = { agent: { options: { provider: 'buddy' } } }
const out = await captured.fn(assembly, context, async () => assembly)
const guarded = out.sections[0].text

// ---- 3. 本地断言 ----
const twice = await captured.fn(
  { sections: [{ text: guarded }], variables: { provider: 'buddy' } },
  context,
  async () => ({ sections: [{ text: guarded }], variables: { provider: 'buddy' } }),
)
const otherAsm = { sections: [{ text: systemText }], variables: { provider: 'codearts' } }
const other = await captured.fn(otherAsm, { agent: { options: { provider: 'codearts' } } }, async () => otherAsm)

const checks = [
  ['首段不再以身份句原样开头', !guarded.startsWith('You are an AI agent powered by')],
  ['首段句式已改写', guarded.startsWith('You are an AI agent, powered by')],
  ['首段无前导空白', !/^\s/.test(guarded)],
  ['A 句已改写', !guarded.includes('Tokens prefixed with @ are paths the user explicitly referenced')],
  ['B 句保留', guarded.includes('Relative paths resolve from the workspace root')],
  ['幂等（二次经过不再变）', twice.sections[0].text === guarded],
  ['非目标渠道原样放行', other.sections[0].text === systemText],
]
let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed++
  console.log((ok ? '  \u2713 ' : '  \u2717 ') + label)
}

const outFile = process.env.OUT_FILE
if (outFile) {
  fs.writeFileSync(outFile, guarded, 'utf8')
  console.log('[i] 插件输出已写入:', outFile)
}

if (failed > 0) {
  console.log('\n=== 本地断言失败 ===')
  process.exit(1)
}

// ---- 4. 真实上游 ----
if (process.env.SKIP_UPSTREAM === '1') {
  console.log('\n=== 跳过上游验证（SKIP_UPSTREAM=1）===')
  process.exit(0)
}

const credentialFile = HOME + '\\.credentials.yaml'
const creds = fs.readFileSync(credentialFile, 'utf8')
const token = [...creds.matchAll(/"access_token":"([^"\\]+)"/g)]
  .map((m) => m[1])
  .find((t) => t.startsWith('eyJ'))
if (!token) throw new Error('没有找到 BUDDY access_token')

async function call(sys, model) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 120000)
  try {
    const res = await fetch('https://copilot.tencent.com/v2/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'X-Domain': 'copilot.tencent.com',
        'X-Product-Code': 'codebuddy',
        'X-Agent-Purpose': 'conversation',
        'X-IDE-Name': 'CodeBuddy',
        'X-IDE-Type': 'CodeBuddy',
        'X-IDE-Version': '1.106.1',
        'X-Product': 'CodeBuddy',
        'User-Agent': 'CodeBuddyIDE/1.106.1',
      },
      body: JSON.stringify({
        model,
        stream: true,
        max_tokens: 8,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: 'hi' },
        ],
      }),
      signal: ac.signal,
    })
    const text = await res.text()
    let code = 'ok'
    try {
      code = JSON.parse(text).code ?? 'ok'
    } catch {}
    return { status: res.status, code }
  } finally {
    clearTimeout(timer)
  }
}

const model = process.env.MODEL || 'deepseek-v4.1-flash'
const before = await call(systemText, model)
console.log('[2] 上游（原始 system）:', JSON.stringify(before))
const after = await call(guarded, model)
console.log('[3] 上游（插件输出）:', JSON.stringify(after))

if (after.status === 200) {
  console.log('\n=== 通过：插件输出已被上游放行 ===')
} else {
  console.log('\n=== 失败：仍被拦截，上游规则可能又变了（重做一次一变量边界测试）===')
  process.exit(1)
}
