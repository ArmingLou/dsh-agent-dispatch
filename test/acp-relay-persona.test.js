/**
 * v1.12.18 回归测试：ACP 档「静默退化为本地 LLM 执行」的两条修复。
 *
 * 现场（宿主 0.2.1-alpha.3，已实测复现）：派发 ACP 档子代理，它成功返回，但
 *   · `product_submit` 工具调用 **0 次**；
 *   · 系统提示词里中继指示与 agent.systemPrompt **全部缺失**；
 *   · 手里 64 个工具（与父会话相同，含 write/edit/bash），直接调本地 grep/read/bash 干活。
 * 根因：中继指示与角色 persona 都只经 `request.persona` 传递，而宿主 0.2.1-alpha.3 的
 * `SubagentStartRequest` 已移除该字段并**静默忽略**；`toolFilter:{allow:[...]}` 同因失效。
 *
 * 本文件的三组断言各自钉住一个"会静默失败"的点：
 *   A. persona 内容必须出现在**初始 prompt** 里（宿主必然投递的通道）；
 *   B. ACP 档 child 必须被登记为 relay，且其本地工具调用在执行期被拒；
 *   C. 非 ACP 档与父代理不受 relay 闸影响（防"修过头"把正常档位也锁死）。
 *
 * ⚠ 这些断言在**未打补丁**的版本上必然失败（见文件末的说明与交付报告的自证结果）：
 * 旧代码的 initialPrompt 里根本没有 persona，也没有 relayChildren 登记。
 */
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../lib/dispatch.js'
import { relayChildren, relayDenialReason, RELAY_ALLOWED_TOOLS } from '../lib/relay-guard.js'

const AGENT_ID = 'senior-dev'
/** Agent 的 systemPrompt 全文——它承载角色语义 + 两条硬护栏，必须完整送达 */
const SYSTEM_PROMPT = '你是资深开发（中坚）。严禁再向下委派；权限不足必须上报，绝不自行扩大权限。'
const ROUTES = [
  { provider: 'deveco', model: 'GLM-5.1' }, // ACP 档（宿主已注册 provider）
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, // LLM 档
]
const ACP_PROVIDERS = new Set(['deveco'])

function makeHarness() {
  const started = []
  const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 }, inject: () => {} }
  const ctx = {
    subagents: {
      getProvider: (name) => (ACP_PROVIDERS.has(name) ? { name } : undefined),
      // v1.12.17：宿主 0.2.1-alpha.3 把 startContinuable 改名为 startActivation
      startActivation: async (spec) => {
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
    get: (id) => ({ id, name: '资深开发（中坚）', emoji: '🛠️', systemPrompt: SYSTEM_PROMPT, reusePolicy: 'fresh' }),
    resolveRoutes: () => ROUTES.map((r) => ({ ...r })),
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-acp-relay-test-'))
  const dispatcher = new Dispatcher({ ctx, registry, dataDir, idleReleaseMs: 0 })
  return { dispatcher, started, parentAgent }
}

beforeEach(() => {
  relayChildren.clear() // 模块级单例：每个用例从干净状态起（防跨用例串味）
})

describe('v1.12.18 A：persona 内容改由初始 prompt 送达（宿主必然投递的通道）', () => {
  it('ACP 档：初始 prompt 同时含 agent.systemPrompt 与中继指示，且中继指示只出现一次', async () => {
    const { dispatcher, started, parentAgent } = makeHarness()
    await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})

    const spec = started[0]
    assert.equal(spec.provider, 'deveco')
    const prompt = spec.request.prompt[0].text

    // ① 角色 systemPrompt 必须送达（旧代码只走已失效的 persona ⇒ 这里会失败）
    assert.ok(
      prompt.includes(SYSTEM_PROMPT),
      'agent.systemPrompt（角色语义 + 递归/权限护栏）必须出现在初始 prompt 中',
    )
    // ② 中继指示必须送达
    assert.match(prompt, /【ACP 执行模式】/, 'ACP 中继指示必须出现在初始 prompt 中')
    assert.match(prompt, /product_submit/, '中继指示必须点名 product_submit')
    // ③ 不得重复注入：中继指示只出现一次（防止"systemPrompt+directive"被拼两遍）
    assert.equal(
      prompt.split('【ACP 执行模式】').length - 1,
      1,
      '中继指示必须只出现一次（单一真源，不得重复拼接）',
    )
    assert.equal(prompt.split(SYSTEM_PROMPT).length - 1, 1, 'systemPrompt 必须只出现一次')
    // ④ 顺序：角色 → 中继 → 任务本体
    assert.ok(
      prompt.indexOf(SYSTEM_PROMPT) < prompt.indexOf('【ACP 执行模式】'),
      '顺序必须是「角色语义先立身份，中继指示再立规矩」',
    )
    assert.ok(
      prompt.indexOf('【ACP 执行模式】') < prompt.indexOf('【任务】'),
      '任务本体必须在所有前置段之后（不得被前缀挤掉）',
    )
    assert.match(prompt, /【输出要求】\s*\n完成后输出结构化结论/, '任务包装（buildTaskText）必须保持完整')
  })

  it('LLM 档同样修复：agent.systemPrompt 也必须经初始 prompt 送达（旧代码两条路径都在丢）', async () => {
    const { dispatcher, started, parentAgent } = makeHarness()
    // 让 ACP 档冷却，迫使落到 LLM 档
    dispatcher.health.recordFailure(AGENT_ID, 'deveco', { hard: true })
    await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})

    const spec = started[0]
    assert.equal(spec.provider, 'spawn', '第二档是宿主 spawn（LLM 路由）')
    const prompt = spec.request.prompt[0].text
    assert.ok(prompt.includes(SYSTEM_PROMPT), 'LLM 档的角色 persona 同样必须送达')
    assert.ok(!prompt.includes('【ACP 执行模式】'), 'LLM 档不得带 ACP 中继指示')
  })
})

describe('v1.12.18 B：ACP relay 闸——执行期只放行 product_submit', () => {
  it('dispatch 一个 ACP 档后，该 childId 必须被登记为 relay', async () => {
    const { dispatcher, parentAgent } = makeHarness()
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})
    assert.ok(
      relayChildren.has(res.childId),
      'ACP 档 child 必须登记进 relayChildren，否则 guard 认不出它是中继',
    )
  })

  it('relay child 调本地工具（bash/write/edit/grep）被拒；product_submit 与 send_message 放行', () => {
    relayChildren.add('c-relay')
    const exec = (name) => ({ name, agent: { session: { id: 'c-relay' }, options: { subagentDepth: 1 } } })

    for (const tool of ['bash', 'write', 'edit', 'grep', 'read', 'glob', 'agent_dispatch']) {
      const reason = relayDenialReason(exec(tool))
      assert.ok(typeof reason === 'string' && reason.length > 0, `relay child 调 ${tool} 必须被拒`)
      assert.match(reason, /product_submit/, `拒绝原因必须告诉模型正确路径（调 product_submit），而不是只说不许`)
    }
    for (const tool of RELAY_ALLOWED_TOOLS) {
      assert.equal(relayDenialReason(exec(tool)), undefined, `relay child 必须能用 ${tool}`)
    }
  })

  it('未登记为 relay 的 child 与父代理不受 relay 闸影响（防"修过头"锁死正常档位）', () => {
    relayChildren.add('c-relay')
    // 同深度的普通（LLM 档）子代理：relay 闸不适用
    assert.equal(
      relayDenialReason({ name: 'bash', agent: { session: { id: 'c-normal' }, options: { subagentDepth: 1 } } }),
      undefined,
      '非 relay 子代理的 bash 不得被 relay 闸拒绝',
    )
    // 父代理（depth 0）
    assert.equal(
      relayDenialReason({ name: 'bash', agent: { session: { id: 'parent-1' }, options: { subagentDepth: 0 } } }),
      undefined,
      '父代理的 bash 不得被 relay 闸拒绝',
    )
  })

  it('relay 登记不因单轮结束而清除（续聊/冷恢复后仍是 relay 语义）', async () => {
    const { dispatcher, parentAgent } = makeHarness()
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})
    // 模拟该轮结算
    dispatcher.onChildEnd(res.childId, 'completed', '做完了')
    assert.ok(
      relayChildren.has(res.childId),
      '结算后仍必须保留 relay 登记——否则续聊/冷恢复的第二次调用就重新获得全部本地工具',
    )
  })
})

/**
 * v1.12.20：fail-open 修复（Blocker A / Blocker B）。
 *
 * 缺陷形态：登记原来只有首建一条路径（dispatch.js 的 `if (acpMode) relayChildren.add`），
 * 而续聊/恢复有三条独立入口且都不补登记 ⇒ 闸 fail-open：
 *   · Blocker A：插件重载/HMR/升级后对存量 relay child 续聊 ⇒ 闸全消失；
 *   · Blocker B：DSH 重启后父级用持久化 childId 定向续聊 ⇒ 冷恢复的 relay 无闸。
 * 两种情况下该 child 都能调用全部本地工具（bash/write/edit…），中继语义静默丢失。
 *
 * 修法：把"补登记"收敛到 `Dispatcher#followup` 这一个**所有续聊的公共通道**
 * （定向 childId 续聊与复用池续聊都经它），按插件账本的 acpMode 判定补登记。
 *
 * 下面 5 组断言把"登记必须在哪些时刻存在 / 哪些时刻消失"钉死。
 */
describe('v1.12.20 D：续聊/恢复路径必须补登记 relay（fail-open 修复，Blocker A/B）', () => {
  /** 构造一个"已被登记过的 ACP relay child"——模拟存量线程（重载前的 dispatch） */
  function seedRelayChild(dispatcher, childId, { inPool = false, inHistory = false, inActive = false } = {}) {
    relayChildren.add(childId)
    if (inPool) {
      dispatcher.childPool.set(`parent-1::${AGENT_ID}::${childId}`, {
        key: `parent-1::${AGENT_ID}::${childId}`,
        childId,
        agentId: AGENT_ID,
        parentSessionId: 'parent-1',
        provider: 'deveco',
        acpMode: true,
        lastUsedAt: Date.now(),
        releaseTimer: null,
        lastTasks: ['上一个任务'],
        viaSquad: null,
        squadRunId: null,
        keep: false,
      })
    }
    if (inActive) {
      dispatcher.activeChildren.set(childId, {
        agentId: AGENT_ID,
        childId,
        taskLabel: '上一个任务',
        provider: 'deveco',
        acpMode: true,
        startedAt: Date.now(),
        parentSessionId: 'parent-1',
      })
    }
    if (inHistory) {
      dispatcher.completedFresh.set(childId, {
        childId,
        agentId: AGENT_ID,
        taskLabels: ['上一个任务'],
        parentSessionId: 'parent-1',
        provider: 'deveco',
        acpMode: true,
        completedAt: Date.now(),
      })
    }
  }

  it('① 首建后登记生效（基线：未修前就对，修后不得回归）', async () => {
    const { dispatcher, parentAgent } = makeHarness()
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})
    assert.ok(relayChildren.has(res.childId), '首建 ACP child 必须登记')
    // 且闸真的在拦（不是只登记不生效）
    assert.ok(
      typeof relayDenialReason({ name: 'bash', agent: { session: { id: res.childId }, options: { subagentDepth: 1 } } }) === 'string',
      '登记必须同时让 guard 认得出它',
    )
  })

  it('② 定向续聊（childId）后登记仍生效——池内 ACP 线程', async () => {
    const { dispatcher, parentAgent } = makeHarness()
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})
    seedRelayChild(dispatcher, res.childId, { inPool: true })
    // 模拟"重载/重启后 Set 空"：保留池账本，清掉进程内登记
    relayChildren.clear()
    assert.equal(relayChildren.has(res.childId), false, '前置条件：清空后不应有登记')

    await dispatcher.dispatch(parentAgent, AGENT_ID, '追加：继续同一线程', { childId: res.childId })

    assert.ok(
      relayChildren.has(res.childId),
      '定向续聊命中池内 ACP 线程后必须补登记——否则续聊后的 relay child 重新获得全部本地工具',
    )
    assert.ok(
      typeof relayDenialReason({ name: 'write', agent: { session: { id: res.childId }, options: { subagentDepth: 1 } } }) === 'string',
      '补登记后闸必须真的在拦 write',
    )
  })

  it('③ 定向续聊后登记仍生效——池外/历史（completedFresh）线程', async () => {
    const { dispatcher, parentAgent } = makeHarness()
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})
    // fresh 策略 ⇒ 不进复用池；结算后进 completedFresh（onChildEnd 已带 acpMode）
    dispatcher.onChildEnd(res.childId, 'completed', '做完了')
    assert.ok(dispatcher.completedFresh.has(res.childId), '前置条件：fresh 线程应进 completedFresh')
    relayChildren.clear()
    assert.equal(relayChildren.has(res.childId), false, '前置条件：清空后不应有登记')

    await dispatcher.dispatch(parentAgent, AGENT_ID, '追加：继续历史线程', { childId: res.childId })

    assert.ok(
      relayChildren.has(res.childId),
      '历史线程定向续聊后必须补登记（completedFresh 必须带 acpMode 才能判定）',
    )
    assert.equal(
      dispatcher.activeChildren.get(res.childId)?.acpMode,
      true,
      '从历史重建 activeChildren 时必须继承 acpMode（否则后续续聊/面板判定全丢）',
    )
  })

  it('④ 复用池续聊后登记仍生效', async () => {
    const { dispatcher, parentAgent } = makeHarness()
    // 该 harness 的 registry.get 返回 reusePolicy:'fresh' ⇒ 改为 reuse 才能进池被复用。
    // 这里直接人工播种一条池内 ACP 线程（与 childid-continuation.test.js 同手法），
    // 走 auto 复用路径触发 followup。
    const { dispatcher: d2, parentAgent: p2 } = makeHarness()
    seedRelayChild(d2, 'pooled-relay', { inPool: true })
    d2.registry.get = (id) => ({ id, name: '资深开发（中坚）', emoji: '🛠️', systemPrompt: SYSTEM_PROMPT, reusePolicy: 'reuse' })
    relayChildren.clear()
    assert.equal(relayChildren.has('pooled-relay'), false, '前置条件：清空后不应有登记')

    await d2.dispatch(p2, AGENT_ID, '继续：同一线程第二步')

    assert.ok(
      relayChildren.has('pooled-relay'),
      '复用池续聊 ACP 线程后必须补登记',
    )
  })

  it('⑤ dispose / closeChild 结算 / purgeParent 后登记正确失效', async () => {
    // 5a. dispose：插件卸载 ⇒ 全部登记作废（防模块级单例跨重载残留陈旧 childId）
    const { dispatcher, parentAgent } = makeHarness()
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})
    assert.ok(relayChildren.has(res.childId), '前置条件：首建已登记')
    dispatcher.dispose()
    assert.equal(relayChildren.has(res.childId), false, 'dispose 后必须注销（单例不得残留陈旧 childId）')
    assert.equal(
      relayDenialReason({ name: 'bash', agent: { session: { id: res.childId }, options: { subagentDepth: 1 } } }),
      undefined,
      'dispose 后闸必须对该 child 失效（child 已被宿主拆掉，留着会误伤）',
    )

    // 5b. closeChild 在【已结算】线程上 ⇒ 注销（刻意设计：:3268 if (!running) delete）
    const { dispatcher: d2, parentAgent: p2 } = makeHarness()
    const r2 = await d2.dispatch(p2, AGENT_ID, '梳理一下 dispatch 流程', {})
    d2.onChildEnd(r2.childId, 'completed', '做完了') // 先结算 ⇒ 不再 running
    await d2.closeChild(p2, { childId: r2.childId })
    assert.equal(relayChildren.has(r2.childId), false, '已结算线程 closeChild 后必须注销')

    // 5c. closeChild 在【运行中】线程上 ⇒ 保留登记（刻意设计：线程还活着，闸必须还在）
    const { dispatcher: d3, parentAgent: p3 } = makeHarness()
    const r3 = await d3.dispatch(p3, AGENT_ID, '梳理一下 dispatch 流程', {})
    await d3.closeChild(p3, { childId: r3.childId })
    assert.ok(relayChildren.has(r3.childId), '运行中线程 closeChild 不得注销（child 仍可执行工具）')

    // 5d. purgeParent：父会话结束 ⇒ 该会话下 ACP 登记全部注销
    const { dispatcher: d4, parentAgent: p4 } = makeHarness()
    const r4 = await d4.dispatch(p4, AGENT_ID, '梳理一下 dispatch 流程', {})
    d4.purgeParent('parent-1')
    assert.equal(relayChildren.has(r4.childId), false, 'purgeParent 后必须注销该父会话的 relay 登记')
  })

  it('⑥ 反向：非 ACP 线程续聊不得被登记（防"修过头"把 LLM 档也锁死）', async () => {
    // LLM 档（health 让 ACP 档冷却）⇒ acpMode=false ⇒ 不得登记
    const { dispatcher, parentAgent } = makeHarness()
    dispatcher.health.recordFailure(AGENT_ID, 'deveco', { hard: true })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '梳理一下 dispatch 流程', {})
    assert.equal(relayChildren.has(res.childId), false, 'LLM 档 child 不得登记为 relay')

    // 再对它定向续聊一次：仍不得登记
    await dispatcher.dispatch(parentAgent, AGENT_ID, '追加：继续同一线程', { childId: res.childId })
    assert.equal(relayChildren.has(res.childId), false, 'LLM 档线程续聊后也不得被补登记')
    assert.equal(
      relayDenialReason({ name: 'bash', agent: { session: { id: res.childId }, options: { subagentDepth: 1 } } }),
      undefined,
      'LLM 档子代理的 bash 不得被 relay 闸拒绝',
    )
  })
})

describe('v1.12.18 C：relay 闸经 index.js 的全局 tools.guard 真正生效', () => {
  it('apply() 注册的 guard 对 relay child 的本地工具返回拒绝原因，对父代理放行', async () => {
    const guards = []
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dad-relay-guard-'))
    try {
      const mod = await import('../index.js')
      const services = { webServer: { register: () => () => {} } }
      const ctx = {
        tools: {
          register: () => () => {},
          guard: (fn) => { guards.push(fn); return () => {} },
          view: () => ({ knownNames: [] }),
        },
        systemPrompt: { section: () => () => {} },
        commands: { register: () => () => {} },
        subagents: { list: () => [], getProvider: () => undefined },
        get: (k) => services[k],
        on: () => () => {},
        emit: () => {},
        effect: () => {},
        waterfall: (_t, _e, value) => value,
      }
      const dispose = mod.apply(ctx)
      try {
        assert.ok(guards.length > 0, 'apply() 必须注册全局 tools.guard')

        relayChildren.add('c-relay')
        const bash = { name: 'bash', agent: { session: { id: 'c-relay' }, options: { subagentDepth: 1 } } }
        const reason = guards.map((g) => g(bash)).find((r) => r !== undefined)
        assert.ok(typeof reason === 'string' && reason.length > 0, 'guard 必须拒绝 relay child 调 bash')
        assert.match(reason, /product_submit/, '拒绝原因必须指向 product_submit')

        const submit = { name: 'product_submit', agent: { session: { id: 'c-relay' }, options: { subagentDepth: 1 } } }
        assert.ok(
          guards.every((g) => g(submit) === undefined),
          'guard 必须放行 relay child 调 product_submit（否则中继无法转发任务）',
        )

        const parentBash = { name: 'bash', agent: { session: { id: 'parent-1' }, options: { subagentDepth: 0 } } }
        assert.ok(
          guards.every((g) => g(parentBash) === undefined),
          'guard 必须放行父代理调 bash',
        )
      } finally {
        try { dispose?.() } catch { /* ignore */ }
      }
    } finally {
      process.env.DSH_HOME = prevHome
    }
  })
})
