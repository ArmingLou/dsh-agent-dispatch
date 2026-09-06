#!/usr/bin/env node
// P1/P2 集成冒烟：桩化宿主 subagents，驱动 Dispatcher 的
// 派发 → child error → 自动换档 → 换档 child completed 全链路。
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dad-p1p2-'))
process.env.DSH_HOME = tmp

const { AgentRegistry } = await import(path.join(root, 'lib/agents.js'))
const { Dispatcher } = await import(path.join(root, 'lib/dispatch.js'))

let failures = 0
function assert(name, cond, extra = '') {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}${extra ? ` (${extra})` : ''}`)
  if (!cond) failures += 1
}

// ── 注册表：一个 ACP relay agent，3 档 routes ──
const reg = new AgentRegistry(path.join(tmp, 'data', 'dsh-agent-dispatch'))
await reg.init()
await reg.upsert({
  id: 'explorer',
  name: '测试探索者',
  triggers: '',
  systemPrompt: '测试 persona',
  reusePolicy: 'fresh',
  routes: [
    { provider: 'deveco', model: 'deveco/GLM-5.1' },
    { provider: 'opencode', model: 'opencode/zen-main-free' },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  ],
  routing: { quality: { failThreshold: 1, cooldownMs: 120, cooldownBackoff: 2, maxCooldownMs: 5000, resumeHoldMs: 20 } },
  enabled: true,
})

// ── 宿主桩：subagents.startContinuable 记录创建序列 ──
let childSeq = 0
const created = [] // { provider, prompt, childId }
const parentAgent = { id: 'parent-session', session: { id: 'parent-session' }, options: { subagentDepth: 0 } }
const agentsStore = new Map([['parent-session', parentAgent]])
const subagentsStub = {
  getProvider: (name) => (name === 'deveco' || name === 'opencode' ? { name } : undefined),
  async startContinuable({ provider, request }) {
    childSeq += 1
    const childId = `child-${childSeq}`
    const promptText = request?.prompt?.[0]?.text ?? ''
    // spawn 模式（LLM provider 如 deepseek-official）下实际 provider 在 request.agentOptions
    const effectiveProvider = request?.agentOptions?.provider ?? provider
    created.push({ provider: effectiveProvider, prompt: promptText, childId })
    return { childId }
  },
  async sendMessage() { return { id: 'inbox-1' } },
  async drainContinuableChildren() {},
  async listChildren() { return [] },
  async interrupt() {},
}
const ctx = {
  subagents: subagentsStub,
  get: (k) => (k === 'agents' ? { get: (id) => agentsStore.get(id) } : undefined),
  emit: () => {},
  tools: { view: () => ({ knownNames: [] }) },
  logger: { warn: () => {}, info: () => {} },
}
const dispatcher = new Dispatcher({ ctx, registry: reg, dataDir: path.join(tmp, 'data', 'dsh-agent-dispatch'), idleReleaseMs: 0 })

// ── 1. 首次派发：deveco 档，正常 completed → 健康记成功 ──
const r1 = await dispatcher.dispatch(parentAgent, 'explorer', '调研任务A', { waitResult: false })
assert('1a. 首次派发建 child-1', r1.childId === 'child-1', r1.childId)
assert('1b. child-1 走 deveco', created[0].provider === 'deveco', created[0].provider)
dispatcher.onChildEnd('child-1', 'completed', '调研完成')
assert('1c. deveco 记成功（未冷却）', !dispatcher.health.isCooling('explorer', 'deveco'))

// ── 2. 第二次派发（新任务，fresh 策略 → 新建 child-2），child error → 自动换档 ──
const r2 = await dispatcher.dispatch(parentAgent, 'explorer', '独立调研任务B', { waitResult: false })
assert('2a. child-2 已建', r2.childId === 'child-2', r2.childId)
assert('2b. child-2 走 deveco', created[1].provider === 'deveco', created[1].provider)
dispatcher.onChildEnd('child-2', 'error', 'deveco 429 熔断耗尽')
// 自动换档应 fire-and-forget 新建 child-3（opencode）
await new Promise((r) => setTimeout(r, 50))
assert('2c. 自动换档建 child-3', created.length === 3, `created=${created.length}`)
assert('2d. child-3 走 opencode', created[2].provider === 'opencode', created[2].provider)
assert('2e. child-3 带前情提示', created[2].prompt.includes('前情提示'), 'prompt 前缀')
assert('2f. deveco 已冷却', dispatcher.health.isCooling('explorer', 'deveco'))

// ── 3. 换档 child-3 也 error → 再换 deepseek-official ──
dispatcher.onChildEnd('child-3', 'error', 'opencode 也失败')
await new Promise((r) => setTimeout(r, 50))
assert('3a. 二次换档建 child-4', created.length === 4, `created=${created.length}`)
assert('3b. child-4 走 deepseek-official', created[3].provider === 'deepseek-official', created[3].provider)
assert('3c. opencode 已冷却', dispatcher.health.isCooling('explorer', 'opencode'))

// ── 4. 最后一档 child-4 completed → 整链成功，冷却清理 ──
dispatcher.onChildEnd('child-4', 'completed', 'deepseek 完成')
assert('4a. deepseek 记成功', !dispatcher.health.isCooling('explorer', 'deepseek-official'))
// 冷却期内的档位不因 deepseek 成功而解除（各自独立记录）——deveco/opencode 仍冷却
assert('4b. deveco 仍冷却（成功只清本档）', dispatcher.health.isCooling('explorer', 'deveco'))

// ── 5. 新任务派发：冷却过滤 → 跳过 deveco/opencode → 直接 deepseek？  ──
// fresh 策略 → 新建；availableRoutes 过滤冷却档 → routes[0]=deepseek-official
const r5 = await dispatcher.dispatch(parentAgent, 'explorer', '独立调研任务C', { waitResult: false })
const created5 = created[created.length - 1]
assert('5a. 冷却过滤后新建走 deepseek', created5.provider === 'deepseek-official', created5.provider)

// ── 6. aborted 不触发换档 ──
const r6 = await dispatcher.dispatch(parentAgent, 'explorer', '独立调研任务D', { waitResult: false })
const nBefore = created.length
dispatcher.onChildEnd(r6.childId, 'aborted', '用户取消')
await new Promise((r) => setTimeout(r, 30))
assert('6a. aborted 不自动换档', created.length === nBefore, `created=${created.length}`)

// ── 7. 真实链路场景（v1.7.1）：submit-failed 事件（completed 回合）→ 自动换档 ──
// relay child 是 LLM：product_submit 报错后它以 completed 结束回合——宿主 stopReason
// 看不到产品故障。模拟 product-subagents 的 'product-subagents/submit-failed' 事件路径：
// 先等冷却过期让 deveco 恢复可用
await new Promise((r) => setTimeout(r, 400))
for (const p of ['deveco', 'opencode', 'deepseek-official']) dispatcher.health.recordSuccess('explorer', p)
const n7 = created.length
const r7 = await dispatcher.dispatch(parentAgent, 'explorer', '独立调研任务E', { waitResult: false })
assert('7a. child 已建且走 deveco', !!r7.childId && created[created.length - 1].provider === 'deveco', r7.childId)
// 工具抛错 → 编排层收到事件标记（child 仍在跑，尚未结算）
dispatcher.markChildSubmitFailed({ childId: r7.childId, product: 'deveco', code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文（无任何文本输出）' })
// child 结算：回合是 completed（relay 转达错误）——但带失败标记必须按失败处理
dispatcher.onChildEnd(r7.childId, 'completed', 'deveco 返回空正文，我将自动换档重试')
await new Promise((r) => setTimeout(r, 80))
const last7 = created[created.length - 1]
assert('7b. completed+失败标记 → 自动换档', created.length === n7 + 2 && last7.provider === 'opencode',
  `created=${created.length} last=${last7.provider}（期望 deveco 失败后建 opencode）`)
assert('7c. deveco 记失败冷却', dispatcher.health.isCooling('explorer', 'deveco'))
assert('7d. 换档 prompt 带前情提示', (last7.prompt || '').includes('前情提示'))

// ── 8. submit-ok 清除失败标记（relay 同一回合二次提交成功 → 不误判）──
await new Promise((r) => setTimeout(r, 400))
for (const p of ['deveco', 'opencode', 'deepseek-official']) dispatcher.health.recordSuccess('explorer', p)
const n8 = created.length
const r8 = await dispatcher.dispatch(parentAgent, 'explorer', '独立调研任务F', { waitResult: false })
assert('8a. child 已建走 deveco', created[created.length - 1].provider === 'deveco')
dispatcher.markChildSubmitFailed({ childId: r8.childId, product: 'deveco', code: 'EMPTY_RESPONSE', message: 'x' })
dispatcher.markChildSubmitOk({ childId: r8.childId, product: 'deveco' }) // 二次提交成功
dispatcher.onChildEnd(r8.childId, 'completed', '成功结果')
await new Promise((r) => setTimeout(r, 60))
assert('8b. submit-ok 后 completed 不换档', created.length === n8 + 1, `created=${created.length}（期望只建 r8 一个）`)
assert('8c. deveco 失败标记清除后记成功', !dispatcher.health.isCooling('explorer', 'deveco'))

console.log(failures === 0 ? `\nPASS all (${childSeq} children)` : `\nFAILURES: ${failures}`)
rmSync(tmp, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
