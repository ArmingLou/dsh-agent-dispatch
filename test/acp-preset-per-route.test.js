/**
 * v1.12.19 回归测试：**逐档（per-route）Agent Preset 选择**。
 *
 * 契约（用户原话）：一套角色定义 + 插件按档位自动选择落地机制。
 *   · ACP 档 = 中继收窄 ⇒ 用 `agent.acpPreset`（如 'acp-relay'）；
 *   · LLM/spawn 档 = 宿主真过滤 ⇒ 用 `agent.agentPreset`；
 *   · 两者未配置 ⇒ **不设该键**（宿主照旧 composeFrom 继承父会话，零回归）。
 *
 * 为什么必须逐档而不是给 agent 钉死一个 preset：宿主 `agentPreset` 是单个标量，
 * 而 failover 链会**跨 provider 类型**（ACP ↔ LLM）。本文件第 5 条即核心断言。
 *
 * ⚠ 本文件的"零回归"断言（第 2/4 条）刻意用 `'agentPreset' in request` 而非
 *   `=== undefined`：后者对"键存在但值为 undefined"同样为真，会放过"多展开了一个
 *   值为 undefined 的键"这种形态。宿主 assertCapabilities 判的是 `!== void 0`，
 *   故两者行为等价；但契约上我们承诺的是**键根本不出现**，断言就该盯住这一点。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../lib/dispatch.js'

const AGENT_ID = 'explorer'
/** 宿主已注册的 ACP 产品 provider；不在其中 ⇒ 走 LLM/spawn 档 */
const ACP_PROVIDERS = new Set(['deveco', 'opencode'])

const BASE_AGENT = {
  id: AGENT_ID,
  name: '探索专家',
  emoji: '🔍',
  systemPrompt: '你是探索专家。',
  reusePolicy: 'fresh',
}

/**
 * 最小假宿主。
 *
 * ⚠ 关键：`started` 在 **failOn 判定之前** 记录 spec。这样混合链用例里"失败的首档"
 *   也留下痕迹，否则只能看到成功那档，第 5 条断言会退化成"只测了一档"的假绿。
 */
function makeHarness({ routes, agent = {}, failOn = null } = {}) {
  const started = []
  const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 }, inject: () => {} }
  const ctx = {
    subagents: {
      getProvider: (name) => (ACP_PROVIDERS.has(name) ? { name } : undefined),
      startActivation: async (spec) => {
        started.push(spec) // 先记账：失败档也要被看见
        if (failOn && spec.provider === failOn) throw new Error(`${spec.provider} 起不来`)
        return { childId: `child-${started.length}` }
      },
      sendMessage: async () => {},
      drainChildren: async () => {},
      interrupt: async () => {},
    },
    get: (name) => (name === 'agents' ? { get: (id) => (id === 'parent-1' ? parentAgent : undefined) } : undefined),
    emit: () => {},
  }
  const registry = {
    get: (id) => ({ ...BASE_AGENT, id, ...agent }),
    resolveRoutes: () => routes.map((r) => ({ ...r })),
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-acp-preset-'))
  const dispatcher = new Dispatcher({ ctx, registry, dataDir, idleReleaseMs: 0 })
  return { dispatcher, started, parentAgent }
}

const ACP_ROUTE = { provider: 'deveco', model: 'GLM-5.1' }
const LLM_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

describe('v1.12.19：逐档 Agent Preset 选择', () => {
  it('① ACP 档 + 配了 acpPreset ⇒ request.agentPreset === 该值', async () => {
    const { dispatcher, started, parentAgent } = makeHarness({
      routes: [ACP_ROUTE],
      agent: { acpPreset: 'acp-relay' },
    })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '转发一个任务', { reuse: 'fresh' })

    assert.equal(res.ok, true)
    assert.equal(started.length, 1)
    assert.equal(started[0].request.agentPreset, 'acp-relay')
    // 既有 ACP 分支语义不得被新键挤掉（agentPreset 是**新增**键，不是替换）
    assert.equal(started[0].provider, 'deveco', 'ACP 档仍直接传 route.provider')
    assert.deepEqual(started[0].request.toolFilter, { allow: ['product_submit'] }, 'ACP 档 toolFilter 不变')
  })

  it('② ACP 档 + 未配 acpPreset ⇒ request **无** agentPreset 键（零回归）', async () => {
    const { dispatcher, started, parentAgent } = makeHarness({
      routes: [ACP_ROUTE],
      agent: { agentPreset: 'explorer-preset' }, // 只配了 LLM 侧，ACP 侧必须不受影响
    })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '转发一个任务', { reuse: 'fresh' })

    assert.equal(res.ok, true)
    assert.equal('agentPreset' in started[0].request, false, 'ACP 档不得借用 agentPreset')
  })

  it('③ LLM 档 + agent 配了 agentPreset ⇒ 用 agent 的值', async () => {
    const { dispatcher, started, parentAgent } = makeHarness({
      routes: [LLM_ROUTE],
      agent: { agentPreset: 'explorer-preset' },
    })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '一个普通任务', { reuse: 'fresh' })

    assert.equal(res.ok, true)
    assert.equal(started[0].provider, 'spawn', '非 ACP provider 走 spawn')
    assert.equal(started[0].request.agentPreset, 'explorer-preset')
    assert.equal(started[0].request.toolFilter.allow, undefined, 'LLM 档是 deny 形态，不是 allow')
  })

  it('④ LLM 档 + agent 未配 ⇒ request **无** agentPreset 键（零回归）', async () => {
    const { dispatcher, started, parentAgent } = makeHarness({
      routes: [LLM_ROUTE],
      agent: { acpPreset: 'acp-relay' }, // 只配了 ACP 侧，LLM 侧必须不受影响
    })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '一个普通任务', { reuse: 'fresh' })

    assert.equal(res.ok, true)
    assert.equal('agentPreset' in started[0].request, false, 'LLM 档不得借用 acpPreset')
  })

  it('⑤ 混合 failover 链（ACP 档失败 → LLM 档接管）⇒ 两档拿到的 preset **不同**', async () => {
    const { dispatcher, started, parentAgent } = makeHarness({
      routes: [ACP_ROUTE, LLM_ROUTE],
      agent: { acpPreset: 'acp-relay', agentPreset: 'explorer-preset' },
      failOn: 'deveco', // 首档 ACP 起不来 ⇒ 换到 LLM 档
    })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '跨档换档任务', { reuse: 'fresh' })

    assert.equal(res.ok, true, '首档失败后必须换档成功')
    assert.equal(started.length, 2, '两档都要留下 spec 痕迹（失败档亦记账）')

    const acpTier = started.find((s) => s.provider === 'deveco')
    const llmTier = started.find((s) => s.provider === 'spawn')
    assert.ok(acpTier && llmTier, '必须同时观察到 ACP 档与 LLM 档')

    assert.equal(acpTier.request.agentPreset, 'acp-relay', 'ACP 档取 acpPreset')
    assert.equal(llmTier.request.agentPreset, 'explorer-preset', 'LLM 档取 agentPreset')
    assert.notEqual(
      acpTier.request.agentPreset,
      llmTier.request.agentPreset,
      '★ 核心断言：两档 preset 必须不同（不对称语义，不能共用）',
    )
  })
})
