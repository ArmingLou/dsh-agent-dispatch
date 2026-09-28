/**
 * v1.11.17 回归测试：人为中断不得被当成产品故障 → 不得触发换档重跑同一任务
 * v1.11.18 追加：封死两处残留——① willFailover 硬闸也显式排除中断（堵住
 * `reason === 'error'` 这一支）；② 被取消的 child 不参与 provider 失败计次。
 *
 * 缺陷链（取证自 1.11.16 运行副本）：
 *   index.js '/agent-api/cancel' 与 interrupt_agent 都只调 ctx.subagents.interrupt，
 *   无"标记已取消"的伴随动作 → ACP bridge 抛 SUBMIT_ABORTED/WATCHDOG_CLOSED，
 *   product-submit.js 在 submit-failed 事件里带 interrupted:true →
 *   markChildSubmitFailed 旧实现从不读 interrupted，一律写成 _submitFailed →
 *   onChildEnd 的 (reason === 'error' || productFailed) 被 productFailed 旁路，
 *   #retryOnChildFailure 用原始任务文本 + reuse:'fresh' 在下一档复活同一任务。
 *
 * 本测试走【真实事件入口】markChildSubmitFailed（而非直接塞 _submitFailed），
 * 并钉住两条必须同时成立的语义：中断不换档、真失败仍换档。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../lib/dispatch.js'

const AGENT_ID = 'senior-dev'
const ROUTES = [
  { provider: 'deveco', model: 'GLM-5.1' },
  { provider: 'opencode', model: 'zen-main-free' },
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
]
const ACP_PROVIDERS = new Set(['deveco', 'opencode'])

function makeHarness() {
  const started = []
  const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 }, inject: () => {} }
  const ctx = {
    subagents: {
      getProvider: (name) => (ACP_PROVIDERS.has(name) ? { name } : undefined),
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
  const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-interrupt-test-'))
  const dispatcher = new Dispatcher({ ctx, registry, dataDir, idleReleaseMs: 0 })
  return { dispatcher, started, parentAgent, dataDir }
}

/** 首建一个真实 child（deveco 档），返回其 childId */
async function seedRealChild({ dispatcher, parentAgent }) {
  await dispatcher.dispatch(parentAgent, AGENT_ID, '修复导航栏样式问题', {})
  return 'child-1'
}

function armWaiter(dispatcher, childId) {
  let settle
  const promise = new Promise((resolve) => { settle = resolve })
  dispatcher.waiters.set(childId, { resolve: settle, timer: setTimeout(() => {}, 1000) })
  return promise
}

/** 读回 kind:'result' 行（落盘留痕是本次修复的可观测面） */
function resultRows(dataDir) {
  const raw = readFileSync(join(dataDir, 'dispatches.jsonl'), 'utf8').trim()
  return raw.split('\n').map((l) => JSON.parse(l)).filter((r) => r.kind === 'result')
}

describe('v1.11.17：中断不进产品故障通道', () => {
  it('SUBMIT_ABORTED + interrupted:true（面板取消的真实形态：stopReason=aborted）→ 不换档、立即兑现', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const settled = armWaiter(h.dispatcher, childId)

    h.dispatcher.markChildSubmitFailed({
      childId,
      product: 'deveco',
      code: 'SUBMIT_ABORTED',
      message: 'deveco ACP prompt 被 abort 信号中断',
      interrupted: true,
    })
    h.dispatcher.onChildEnd(childId, 'aborted', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 1, '中断后不得复活同一任务（不应新建下一档 child）')
    const text = await settled
    assert.match(text, /步骤失败: aborted/, `兑现失败占位而非结果：${text}`)
    assert.match(text, /已被取消\/中断: SUBMIT_ABORTED/, `占位文本需说明是人为中断：${text}`)
    assert.ok(!/产品故障/.test(text), '中断绝不得被描述为产品故障')
    assert.ok(!/自动换档已停止/.test(text), '中断本就不具备换档资格，不该给出"换档被卡住"的提示')

    const [row] = resultRows(h.dataDir)
    assert.equal(row.productFailed, undefined, 'result 行不得带 productFailed')
    assert.equal(row.interrupted, 'SUBMIT_ABORTED', 'result 行必须留痕中断码')
    assert.equal(row.ok, false, 'completed 之外的中断按未成功结算')
  })

  it('只带 code、不带 interrupted 布尔（兼容旧上游）→ 同样识别为中断', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    armWaiter(h.dispatcher, childId)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'SUBMIT_ABORTED', message: 'aborted' })
    h.dispatcher.onChildEnd(childId, 'aborted', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 1, '仅凭 code ∈ INTERRUPT_CODES 也必须判定为中断')
  })

  it('WATCHDOG_CLOSED（agent_close）且回合 completed → 不换档，且不得误记为成功', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const settled = armWaiter(h.dispatcher, childId)

    h.dispatcher.markChildSubmitFailed({
      childId,
      product: 'deveco',
      code: 'WATCHDOG_CLOSED',
      message: 'deveco ACP prompt 被终止——child 已关闭',
      interrupted: true,
    })
    h.dispatcher.onChildEnd(childId, 'completed', '我已停止该任务')
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 1, '关闭 child 后不得换档复活')
    const text = await settled
    assert.match(text, /已被取消\/中断: WATCHDOG_CLOSED/, `completed 也必须给出中断原因：${text}`)

    const [row] = resultRows(h.dataDir)
    assert.equal(row.ok, false, 'completed + 中断不得被当成执行成功（否则会洗掉该档故障计数）')
    assert.equal(row.interrupted, 'WATCHDOG_CLOSED')
    assert.equal(row.productFailed, undefined)
  })

  it('此前的产品故障后被人为取消覆盖 → 不换档', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    armWaiter(h.dispatcher, childId)

    h.dispatcher.markChildSubmitFailed({ childId, code: 'EMPTY_RESPONSE', message: '空正文', interrupted: false })
    h.dispatcher.markChildSubmitFailed({ childId, code: 'SUBMIT_ABORTED', message: '用户取消', interrupted: true })
    h.dispatcher.onChildEnd(childId, 'aborted', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 1, '后到的中断必须清除先前失败标记，取消不得被绕过')
  })

  it('中断后同回合再次提交成功（submit-ok）→ 清标记，正常按 completed 结算', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const settled = armWaiter(h.dispatcher, childId)

    h.dispatcher.markChildSubmitFailed({ childId, code: 'SUBMIT_ABORTED', message: 'aborted', interrupted: true })
    h.dispatcher.markChildSubmitOk({ childId, product: 'deveco' })
    h.dispatcher.onChildEnd(childId, 'completed', '任务已完成')

    const text = await settled
    assert.equal(text, '任务已完成', '陈旧中断标记不得把一次正常成功压成失败')
    const [row] = resultRows(h.dataDir)
    assert.equal(row.ok, true)
    assert.equal(row.interrupted, undefined)
  })
})

describe('v1.11.17 对照：真产品故障仍须换档（不得一起砍掉）', () => {
  it('EMPTY_RESPONSE + completed → 沿 fallback 链换到下一档', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)

    h.dispatcher.markChildSubmitFailed({
      childId,
      product: 'deveco',
      code: 'EMPTY_RESPONSE',
      message: 'product_submit: deveco 返回空正文（无任何文本输出）',
      interrupted: false,
    })
    h.dispatcher.onChildEnd(childId, 'completed', '产品返回空正文')
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 2, '非中断的真失败必须换档')
    assert.equal(h.started[1].provider, 'opencode', '必须推进到下一档')

    const [row] = resultRows(h.dataDir)
    assert.equal(row.productFailed, 'EMPTY_RESPONSE')
    assert.equal(row.interrupted, undefined)
  })

  it('SUBMIT_TIMEOUT + completed → 仍换档（同为非中断故障）', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'SUBMIT_TIMEOUT', message: '超时' })
    h.dispatcher.onChildEnd(childId, 'completed', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 2, 'SUBMIT_TIMEOUT 不在 INTERRUPT_CODES 内，必须照旧换档')
  })
})

/**
 * v1.11.18 新增：封死上一轮留下的两处残留。
 *
 *   残留一（1b）：onChildEnd 里 `else recordFailure(...)`——被取消的 child 走这一支，
 *     用户点一次"停止"= 该 provider 记一次失败；ACP relay 档传 `{hard:true}`，
 *     threshold=1 → **一次取消即开 60s 冷却**，下一轮被迫从第二档起跑。
 *   残留二（1a）：willFailover 的 `(reason === 'error' || productFailed)` 里
 *     `reason === 'error'` 这一支与 productFailed 同构——上一版只堵了后者。宿主哪天
 *     把 abort 报成 stopReason='error'（而不是 aborted），换档就从这一支重新漏出来。
 *
 * 观测面：health 是 Dispatcher 实例上的公开字段，这里包一层**透传 spy**——语义仍走
 * 真实现（不 stub 冷却公式），既能断"调没调"，也能断"计次有没有真的推进"。
 */
function armHealthSpies(dispatcher) {
  const calls = { failure: [], success: [] }
  const realFailure = dispatcher.health.recordFailure.bind(dispatcher.health)
  const realSuccess = dispatcher.health.recordSuccess.bind(dispatcher.health)
  dispatcher.health.recordFailure = (agentId, provider, opts) => {
    calls.failure.push({ agentId, provider, opts: opts ?? {} })
    return realFailure(agentId, provider, opts)
  }
  dispatcher.health.recordSuccess = (agentId, provider) => {
    calls.success.push({ agentId, provider })
    return realSuccess(agentId, provider)
  }
  return calls
}

/** provider 健康状态是纯内存 Map，key 形如 `senior-dev::deveco`（未记过 = undefined） */
function healthStateOf(dispatcher, provider = 'deveco') {
  return dispatcher.health.state.get(`${AGENT_ID}::${provider}`)
}

describe('v1.11.18（1b）：人为取消不计入 provider 失败，不进冷却', () => {
  it('SUBMIT_ABORTED + aborted → recordFailure 零调用、该档无健康记录', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'SUBMIT_ABORTED', message: '用户取消', interrupted: true })
    h.dispatcher.onChildEnd(childId, 'aborted', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.deepEqual(calls.failure, [], '取消绝不该给该档记一次失败（旧版这里必记一笔）')
    assert.equal(healthStateOf(h.dispatcher), undefined, '取消后该档不得出现任何失败计数/冷却')
  })

  it('WATCHDOG_CLOSED + completed → recordFailure 零调用（completed 也不能记失败）', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'WATCHDOG_CLOSED', message: 'child 已关闭', interrupted: true })
    h.dispatcher.onChildEnd(childId, 'completed', '我已停止该任务')
    await new Promise((r) => setTimeout(r, 50))

    assert.deepEqual(calls.failure, [], `completed + 中断同样不得计次：${JSON.stringify(calls.failure)}`)
    assert.equal(healthStateOf(h.dispatcher), undefined)
  })

  it('该档已有故障计数时被取消 → 计数与冷却时刻一字不动（既不加刀也不洗白）', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const before = h.dispatcher.health.recordFailure(AGENT_ID, 'deveco', { hard: true })
    assert.ok(before.opened, '前置条件：一次 hard 失败已开冷却')
    const st = healthStateOf(h.dispatcher)
    const snapshot = { failCount: st.failCount, cooldownUntil: st.cooldownUntil }
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'SUBMIT_ABORTED', message: '用户取消', interrupted: true })
    h.dispatcher.onChildEnd(childId, 'aborted', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.deepEqual(calls.failure, [], '取消不得再推一格故障计数（否则冷却时长被指数放大）')
    assert.deepEqual(calls.success, [], '取消也不得记成功（那会洗掉真实的既有故障）')
    const after = healthStateOf(h.dispatcher)
    assert.equal(after.failCount, snapshot.failCount, `既有故障计数必须保持 ${snapshot.failCount}`)
    assert.equal(after.cooldownUntil, snapshot.cooldownUntil, '既有冷却窗口不得被取消改动')
  })

  it('中断 → recordSuccess 不被误调（completed + 中断这条最容易"顺手"记成成功）', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'SUBMIT_ABORTED', message: '用户取消', interrupted: true })
    h.dispatcher.onChildEnd(childId, 'completed', '（取消前的残留输出）')
    await new Promise((r) => setTimeout(r, 50))

    assert.deepEqual(calls.success, [], '中断不是成功：记成功会清零该档既有故障计数')
    assert.deepEqual(calls.failure, [], '中断也不是失败')
  })

  it('真 completed（无中断）仍照常 recordSuccess —— 豁免不能扩大到正常路径', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.onChildEnd(childId, 'completed', '任务已完成')
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(calls.success.length, 1, '正常成功必须照旧清零冷却')
    assert.deepEqual(calls.failure, [])
  })
})

describe('v1.11.18（1a）：stopReason=error 也不得被中断拉起换档', () => {
  it('host 把取消报成 error + SUBMIT_ABORTED → 不换档、不记失败、不给假的"换档已停止"', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const settled = armWaiter(h.dispatcher, childId)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'SUBMIT_ABORTED', message: 'deveco ACP prompt 被 abort 信号中断', interrupted: true })
    h.dispatcher.onChildEnd(childId, 'error', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 1, 'error 支也必须在硬闸上排除中断（旧版此处换档复活）')
    assert.deepEqual(calls.failure, [], 'error + 中断同样不得计入 provider 失败')
    const text = await settled
    assert.match(text, /步骤失败: error/, `仍应如实回传终态：${text}`)
    assert.match(text, /已被取消\/中断: SUBMIT_ABORTED/, '占位文本必须说明是人为中断')
    assert.ok(!/产品故障/.test(text), '中断不得被描述为产品故障')
    assert.ok(!/自动换档已停止/.test(text), '本就不具换档资格，不该给出假的"换档被卡住"提示')

    const [row] = resultRows(h.dataDir)
    assert.equal(row.stopReason, 'error')
    assert.equal(row.interrupted, 'SUBMIT_ABORTED')
    assert.equal(row.productFailed, undefined)
    assert.equal(row.ok, false)
  })

  it('host 把关闭报成 error + WATCHDOG_CLOSED（只带 code 的兼容形态）→ 不换档', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    armWaiter(h.dispatcher, childId)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'WATCHDOG_CLOSED', message: 'agent_close' })
    h.dispatcher.onChildEnd(childId, 'error', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 1, 'code ∈ INTERRUPT_CODES 也要在 error 支被挡住')
  })

  it('对照：error 且无中断标记（宿主真报错）→ 仍换档且仍计次', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.onChildEnd(childId, 'error', '产品进程崩溃')
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 2, '没有中断标记的 error 必须照旧换档')
    assert.equal(calls.failure.length, 1, 'error 真失败仍须记一次失败')
    assert.equal(calls.failure[0].opts.hard, true, 'ACP relay 档必须照旧按 hard 传参')
    assert.equal(healthStateOf(h.dispatcher).failCount, 1)
  })
})

describe('v1.11.18 对照：真失败的换档与计次都不得被顺手砍掉', () => {
  it('EMPTY_RESPONSE + completed → 换档 + recordFailure 一次 + hard:true + 冷却开', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文', interrupted: false })
    h.dispatcher.onChildEnd(childId, 'completed', '产品返回空正文')
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 2, '真失败必须换档')
    assert.equal(h.started[1].provider, 'opencode', '必须推进到下一档')
    assert.equal(calls.failure.length, 1, '真失败必须记一次 provider 失败')
    assert.equal(calls.failure[0].opts.hard, true, 'ACP relay 档 hard 语义不变（一次即冷却）')
    assert.deepEqual(calls.success, [], '真失败不得记成功')
    const st = healthStateOf(h.dispatcher)
    assert.equal(st.failCount, 1)
    assert.ok(st.cooldownUntil > Date.now(), 'hard 失败必须真的开出冷却（冷却公式未被改动）')
  })

  it('SUBMIT_TIMEOUT + aborted → 换档 + 计次（aborted 不等于取消，故障标记才是判据）', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'SUBMIT_TIMEOUT', message: 'product_submit 超时' })
    h.dispatcher.onChildEnd(childId, 'aborted', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 2, 'SUBMIT_TIMEOUT 不是中断，aborted 形态下也要照旧换档')
    assert.equal(calls.failure.length, 1, '并且照旧计入该档失败')
  })

  it('限流耗尽（RATE_LIMITED）+ error → 换档 + 计次', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'RATE_LIMITED', message: '限流重试预算耗尽', interrupted: false })
    h.dispatcher.onChildEnd(childId, 'error', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 2, '限流耗尽是真故障，必须沿 fallback 链换档')
    assert.equal(calls.failure.length, 1)
    assert.equal(healthStateOf(h.dispatcher).failCount, 1)
  })

  it('真失败后紧接人为取消 → 取消赢：不换档、也不计次（后到意图覆盖前到故障）', async () => {
    const h = makeHarness()
    const childId = await seedRealChild(h)
    const calls = armHealthSpies(h.dispatcher)

    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'EMPTY_RESPONSE', message: '空正文', interrupted: false })
    h.dispatcher.markChildSubmitFailed({ childId, product: 'deveco', code: 'SUBMIT_ABORTED', message: '用户取消', interrupted: true })
    h.dispatcher.onChildEnd(childId, 'error', null)
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(h.started.length, 1, '取消是人的决定，覆盖此前的产品故障')
    assert.deepEqual(calls.failure, [], '覆盖后不得再以产品故障计次')
  })
})
