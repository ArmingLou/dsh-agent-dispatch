/**
 * v1.11.10 回归测试：自动换档（P2 failover）的三处修复
 *
 *   缺陷 A：换档前缀硬编码"（ACP 产品）"，末档 spawn child 因此误调 product_submit，
 *          报 `no remote product session is bound to this agent (recovery failed)`。
 *   缺陷 B-1：`entry.acpMode` 前置条件让非 ACP 档完全拿不到 fallback。
 *   缺陷 B-2：换档被卡住时静默兑现失败占位，上层看不出原因。
 *
 * 用最小假宿主（ctx.subagents）驱动真实 Dispatcher，不依赖任何 ACP 产品可用性。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher, buildFailoverTaskText, normalizeTaskForDedup } from '../lib/dispatch.js'

const AGENT_ID = 'senior-dev'
const ROUTES = [
  { provider: 'deveco', model: 'GLM-5.1' },
  { provider: 'opencode', model: 'zen-main-free' },
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
]
/** 宿主已注册的 ACP 产品 provider；deepseek-official 不在其中 ⇒ 走 spawn 档 */
const ACP_PROVIDERS = new Set(['deveco', 'opencode'])
const isAcp = (name) => ACP_PROVIDERS.has(name)

function makeHarness() {
  const started = []
  const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 }, inject: () => {} }
  const ctx = {
    subagents: {
      getProvider: (name) => (isAcp(name) ? { name } : undefined),
      startContinuable: async (spec) => {
        started.push(spec)
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
    get: (id) => ({ id, name: '资深开发（中坚）', emoji: '🛠️', systemPrompt: '你是资深开发。', reusePolicy: 'reuse' }),
    resolveRoutes: () => ROUTES.map((r) => ({ ...r })),
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-failover-test-'))
  const dispatcher = new Dispatcher({ ctx, registry, dataDir, idleReleaseMs: 0 })
  return { dispatcher, started, parentAgent }
}

/** 手动挂一个 waiter，返回兑现文本的 Promise */
function armWaiter(dispatcher, childId) {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  dispatcher.waiters.set(childId, { resolve: settle, timer: setTimeout(() => {}, 1000) })
  return promise
}

function seedEntry(dispatcher, patch = {}) {
  const entry = {
    agentId: AGENT_ID,
    childId: 'c1',
    taskLabel: '任务',
    task: '修复导航栏样式问题',
    provider: 'deveco',
    acpMode: true,
    failoverCount: 0,
    parentSessionId: 'parent-1',
    ...patch,
  }
  dispatcher.activeChildren.set(entry.childId, entry)
  return entry
}

describe('buildFailoverTaskText', () => {
  const base = '【任务】\n修复导航栏样式问题'

  it('目标档非 ACP 时追加执行模式说明，并劝止中继工具', () => {
    const text = buildFailoverTaskText(base, {
      failoverFrom: 'opencode',
      failoverError: 'EMPTY_RESPONSE: 空正文',
      fromAcp: true,
      targetAcp: false,
    })
    assert.match(text, /opencode（ACP 产品）/)
    assert.match(text, /【执行模式】/)
    assert.match(text, /不要调用 product_submit/)
    // 关键回归：不得再出现"目标档是 ACP"的语境
    assert.ok(!text.includes('deepseek-official（ACP 产品）'), 'target must not be described as ACP')
    assert.ok(text.endsWith(base), 'original task text must stay intact at the tail')
  })

  it('目标档是 ACP 时不追加执行模式说明（保持原 relay 语义）', () => {
    const text = buildFailoverTaskText(base, {
      failoverFrom: 'deveco',
      failoverError: '空正文',
      fromAcp: true,
      targetAcp: true,
    })
    assert.match(text, /deveco（ACP 产品）/)
    assert.ok(!text.includes('【执行模式】'), 'ACP target needs no spawn-mode hint')
  })

  it('来源档是模型路由时标注为"模型路由"', () => {
    const text = buildFailoverTaskText(base, {
      failoverFrom: 'deepseek-official',
      failoverError: 'boom',
      fromAcp: false,
      targetAcp: false,
    })
    assert.match(text, /deepseek-official（模型路由）/)
    assert.ok(!text.includes('（ACP 产品）'))
  })

  it('无 failoverFrom 时原样返回（首建不拼前缀）', () => {
    assert.equal(buildFailoverTaskText(base, { failoverFrom: null, fromAcp: false, targetAcp: false }), base)
  })

  it('新前缀块仍可被去重归一化剥离', () => {
    const text = buildFailoverTaskText(base, {
      failoverFrom: 'opencode',
      failoverError: '空正文',
      fromAcp: true,
      targetAcp: false,
    })
    const norm = normalizeTaskForDedup(text)
    assert.ok(norm.includes('修复导航栏样式问题'), `normalized should contain original task: ${norm}`)
    assert.ok(!norm.startsWith('【前情提示】'))
    assert.ok(!norm.includes('【执行模式】'), 'spawn-mode hint must be part of the strippable prefix')
  })

  it('缺省 failoverError 时回退为"执行失败"', () => {
    const text = buildFailoverTaskText(base, { failoverFrom: 'deveco', fromAcp: true, targetAcp: true })
    assert.match(text, /执行失败/)
  })
})

describe('dispatch：末档 spawn 档不再被当成 ACP 中继（缺陷 A 回归）', () => {
  it('前两档冷却 → 末档 spawn：prompt 带执行模式说明、persona 不带 ACP relay', async () => {
    const { dispatcher, started, parentAgent } = makeHarness()
    dispatcher.health.recordFailure(AGENT_ID, 'deveco', { hard: true })
    dispatcher.health.recordFailure(AGENT_ID, 'opencode', { hard: true })

    await dispatcher.dispatch(parentAgent, AGENT_ID, '修复导航栏样式问题', {
      failoverFrom: 'opencode',
      failoverCount: 1,
      failoverError: 'EMPTY_RESPONSE: deveco/opencode 均无文本输出',
    })

    assert.equal(started.length, 1)
    const spec = started[0]
    assert.equal(spec.provider, 'spawn', 'last slot must be a host-side spawn child')
    const prompt = spec.request.prompt[0].text
    assert.match(prompt, /opencode（ACP 产品）/, 'source slot stays described as ACP product')
    assert.match(prompt, /【执行模式】/)
    assert.match(prompt, /不要调用 product_submit/)
    assert.ok(!spec.request.persona.includes('【ACP 执行模式】'), 'spawn child must not get the ACP relay persona')
    assert.equal(spec.request.toolFilter?.allow, undefined, 'spawn child must not be allow-listed to product_submit')
  })

  it('对照：目标档是 ACP 时，仍走 relay 模式（未被本次修复影响）', async () => {
    const { dispatcher, started, parentAgent } = makeHarness()

    await dispatcher.dispatch(parentAgent, AGENT_ID, '修复导航栏样式问题', {
      failoverFrom: 'deveco',
      failoverCount: 1,
      failoverError: '空正文',
    })

    assert.equal(started.length, 1)
    const spec = started[0]
    // 换档链去重：目标档跳过刚失败的 deveco，落到下一档 opencode（ACP relay）
    assert.equal(spec.provider, 'opencode')
    assert.match(spec.request.persona, /【ACP 执行模式】/)
    assert.deepEqual(spec.request.toolFilter.allow, ['product_submit'])
    assert.match(spec.request.prompt[0].text, /deveco（ACP 产品）/, '来源档仍如实标注为 ACP 产品')
    assert.ok(
      !spec.request.prompt[0].text.includes('【执行模式】'),
      'ACP 目标档不得收到"无 ACP 产品会话"说明（否则会自相矛盾）',
    )
  })
})

describe('失败后换档停止不再静默（缺陷 B 回归）', () => {
  it('已是最末档：失败占位文本给出明确原因', async () => {
    const { dispatcher } = makeHarness()
    seedEntry(dispatcher, {
      provider: 'deepseek-official',
      acpMode: false,
      _submitFailed: { code: 'EMPTY_RESPONSE', message: '空正文' },
    })
    const settled = armWaiter(dispatcher, 'c1')

    dispatcher.onChildEnd('c1', 'completed', null)
    const text = await settled

    assert.match(text, /步骤失败/)
    assert.match(text, /自动换档已停止: 当前已是最末档，无后续路由/)
  })

  it('后续档位全部冷却：失败占位文本说明是冷却而非静默', async () => {
    const { dispatcher } = makeHarness()
    dispatcher.health.recordFailure(AGENT_ID, 'opencode', { hard: true })
    dispatcher.health.recordFailure(AGENT_ID, 'deepseek-official', { hard: true })
    seedEntry(dispatcher, {
      provider: 'deveco',
      acpMode: true,
      _submitFailed: { code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文' },
    })
    const settled = armWaiter(dispatcher, 'c1')

    dispatcher.onChildEnd('c1', 'completed', null)
    const text = await settled

    assert.match(text, /产品故障: EMPTY_RESPONSE/)
    assert.match(text, /自动换档已停止: 后续档位全部处于冷却中/)
  })

  it('仍有可用档位时确实换档：waiter 不兑现，新 child 被创建', async () => {
    const { dispatcher, started } = makeHarness()
    seedEntry(dispatcher, {
      provider: 'deveco',
      acpMode: true,
      _submitFailed: { code: 'EMPTY_RESPONSE', message: '空正文' },
    })
    let settled = false
    dispatcher.waiters.set('c1', { resolve: () => { settled = true }, timer: setTimeout(() => {}, 1000) })

    dispatcher.onChildEnd('c1', 'completed', null)
    await new Promise((r) => setTimeout(r, 50)) // 换档是 fire-and-forget

    assert.equal(settled, false, 'waiter must migrate to the failover child, not settle in failure')
    assert.equal(started.length, 1, 'failover must actually dispatch the next slot')
    assert.equal(started[0].provider, 'opencode')
  })

  it('末档失败：不换档、立即兑现，并带上停止原因', async () => {
    const { dispatcher, started } = makeHarness()
    seedEntry(dispatcher, {
      provider: 'deepseek-official',
      acpMode: false,
      childId: 'c2',
      _submitFailed: { code: 'NO_ADAPTER', message: '模型路由失败' },
    })
    let settled = false
    dispatcher.waiters.set('c2', { resolve: () => { settled = true }, timer: setTimeout(() => {}, 1000) })

    dispatcher.onChildEnd('c2', 'completed', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(started.length, 0, '末档失败不换档（无后续路由）')
    assert.equal(settled, true, '末档失败立即兑现，并带上停止原因')
  })
})

describe('换档链端到端推进（deveco → opencode → deepseek 末档 spawn）', () => {
  it('逐档推进不重选已失败档位，末档 spawn 文案正确且停止原因明确', async () => {
    const { dispatcher, started, parentAgent } = makeHarness()

    // 第 1 跳：首建落到 deveco（ACP relay）
    await dispatcher.dispatch(parentAgent, AGENT_ID, '修复导航栏样式问题', {})
    assert.equal(started.length, 1)
    assert.equal(started[0].provider, 'deveco')

    // 第 2 跳：deveco 空正文 → 换到 opencode（而非重选 deveco）
    dispatcher.activeChildren.get('child-1')._submitFailed = { code: 'EMPTY_RESPONSE', message: 'deveco 空正文' }
    dispatcher.onChildEnd('child-1', 'completed', null)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(started.length, 2, '必须真实换到下一档')
    assert.equal(started[1].provider, 'opencode', '不得重选刚失败的 deveco')

    // 第 3 跳：opencode 也空正文 → 末档 deepseek-official（宿主 spawn，非 ACP）
    dispatcher.activeChildren.get('child-2')._submitFailed = { code: 'EMPTY_RESPONSE', message: 'opencode 空正文' }
    dispatcher.onChildEnd('child-2', 'completed', null)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(started.length, 3, '必须推进到末档')
    assert.equal(started[2].provider, 'spawn')
    assert.equal(started[2].request.agentOptions?.provider, 'deepseek-official')
    const prompt = started[2].request.prompt[0].text
    assert.match(prompt, /【执行模式】/, '末档 spawn child 必须被告知"无 ACP 产品会话"')
    assert.match(prompt, /不要调用 product_submit/)
    assert.ok(
      !started[2].request.persona.includes('【ACP 执行模式】'),
      '末档 spawn child 不得拿到 ACP relay persona（缺陷 A 的核心回归点）',
    )

    // 第 4 跳：末档失败 → 链走完，明确回传停止原因（缺陷 B-2）
    dispatcher.activeChildren.get('child-3')._submitFailed = { code: 'MODEL_ERROR', message: '末档也失败' }
    const settled = armWaiter(dispatcher, 'child-3')
    dispatcher.onChildEnd('child-3', 'completed', null)
    const text = await settled
    assert.equal(started.length, 3, '末档之后不得再新建 child')
    assert.match(text, /自动换档已停止: 当前已是最末档，无后续路由/)
  })
})
