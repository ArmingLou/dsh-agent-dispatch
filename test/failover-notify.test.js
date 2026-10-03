/**
 * v1.11.24：`notify` / `notify-then-auto` 两种模式的换档语义。
 *
 * 覆盖用户逐条追问的验收项：
 *  1) `agent_failover` 一次做完三件事：interrupt 旧档 → 兑现 rendezvous → 派同级替补；
 *     **不需要**主代理额外单独调 `interrupt_agent`；
 *  2) `notify-then-auto` 超时走**同一套** handoff（旧档不会挂到 failoverWaitMs 15 分钟）；
 *  3) `notify` 模式超时同样释放旧档，再按失败收尾且信息自解释；
 *  4) 两条路径（手动 vs 超时自动）的结果与通知序列**等价**；
 *  5) `agent_failover` 幂等（重复调用 / 与超时自动路径撞车都只产生一个替补）。
 *
 * 假宿主语义与真源对照见 test/helpers/failover-host.js 顶部注释。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AGENT_ID, TASK, makeCase, settleOk, settleFail } from './helpers/failover-host.js'

const FAIL_SCRIPT = {
  deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文（无任何文本输出）'),
  opencode: settleOk('替补档产出的完整答案'),
  'deepseek-official': settleOk('不该被用到'),
}

describe('notify / notify-then-auto：失败 → 唤醒型信号 + 主代理显式换档', () => {
  it('① notify：失败 → 产生【唤醒型】投递（idle 走 followup），旧档仍未结算（仍阻塞）', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 100000 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})

    await h.until(() => h.wakes.length > 0)
    assert.equal(h.wakes.length, 1, `必须恰好发一条换档信号，实际 ${h.wakes.length}：${JSON.stringify(h.wakes)}`)
    const [wake] = h.wakes
    // —— 唤醒型投递（inject 是 non-waking，主代理空闲时读不到）——
    assert.equal(wake.via, 'followup', '主代理 idle 时必须用 followup 唤醒（inject 是 non-waking）')
    assert.equal(wake.to, 'main-1', '信号必须投给主代理会话')
    // —— 信号文本必须自解释且可执行 ——
    assert.match(wake.text, /换档待决/, '信号必须明确是换档请求')
    assert.match(wake.text, /failoverMode=notify/, '信号必须报出当前模式，主代理据此判断不响应会怎样')
    assert.match(wake.text, /不会自动换档/, 'notify 模式必须明说"不会自动换档"')
    assert.match(wake.text, /agent_failover\(\{ childId: "child-1" \}\)/, '信号必须给出可直接照抄的工具调用')
    assert.match(wake.text, /deveco/, '信号必须点名失败档 provider')
    assert.match(wake.text, /opencode/, '信号必须给出下一档候选（主代理据此判断值不值得换）')

    // —— 旧档仍阻塞：未结算、未 interrupt、无任何通知 ——
    assert.equal(h.notices.length, 0, '等待期间旧档不得结算（宿主 whenIdle() 不返回 ⇒ 不发通知）')
    assert.equal(h.interrupts.length, 0, '等待期间不得 interrupt 旧档')
    assert.equal(h.dispatches.length, 1, '等待期间不得派任何替补（决定权在主代理）')
    assert.equal(h.dispatcher.hasPendingHandoff('child-1'), true, '必须登记 rendezvous，供 agent_failover 兑现')

    await h.dispatcher.dispatcher_dispose?.()
    h.dispatcher.dispose()
  })

  it('①b notify：主代理 running 时改用 steer 唤醒（照抄宿主 settlement 通知的规则）', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 100000 })
    h.parentAgent.status = 'running'
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)
    assert.equal(h.wakes[0].via, 'steer', '主代理 running 时必须用 steer（下一个 step 边界插入，不打断当前工具）')
    h.dispatcher.dispose()
  })

  it('② agent_failover 一次做完三件事：interrupt 旧档 + 派同级替补 + 旧档随后被停止', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 100000 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)

    const r = await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
    await h.drain()

    // ① interrupt 旧档，且恰好一次
    assert.deepEqual(h.interrupts.map((i) => i.childId), ['child-1'],
      `agent_failover 必须自己 interrupt 旧档（主代理无需另调 interrupt_agent），实际 ${JSON.stringify(h.interrupts)}`)
    assert.equal(r.interrupted, 'accepted')
    // ② 派同级替补：parentSessionId 必须是主代理会话
    assert.equal(r.childId, 'child-2')
    assert.equal(r.fromProvider, 'deveco')
    assert.equal(r.toProvider, 'opencode')
    assert.equal(r.trigger, 'agent_failover')
    assert.deepEqual(h.dispatches.map((d) => [d.childId, d.parentId]), [
      ['child-1', 'main-1'], ['child-2', 'main-1'],
    ], '替补必须是主代理的直接子级（同级），不是失败档的孙代')
    const rep = h.entries.find((e) => e.childId === 'child-2')
    assert.ok(rep, '替补 entry 必须被登记')
    assert.equal(rep.nested, false, '替补不得是 nested（孙代已彻底移除）')
    assert.equal(rep.parentSessionId, 'main-1', '替补的 parentSessionId 必须是主代理会话')
    assert.equal(rep.failoverCount, 1)
    // ③ 通知序列：信号 → 旧档 was stopped → 替补结果
    assert.deepEqual(
      [
        h.wakes.length === 1 ? 'signal' : 'signal?',
        h.notices[0]?.stopReason,
        h.notices[1]?.stopReason,
      ],
      ['signal', 'aborted', 'completed'],
      `通知顺序必须恒为 信号 → 旧档被停止 → 替补结果，实际 ${JSON.stringify(h.notices.map((n) => n.stopReason))}`,
    )
    assert.match(h.notices[0].text, /child-1 was stopped before it finished\./)
    assert.match(h.notices[1].text, /替补档产出的完整答案/)
    assert.equal(h.dispatcher.hasPendingHandoff('child-1'), false, 'rendezvous 必须已被兑现并清理')
  })

  it('③ agent_failover 幂等：重复调用返回同一 childId，且只产生一条新 dispatch', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 100000 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)

    const [a, b] = await Promise.all([
      h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent }),
      h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent }),
    ])
    const c = await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
    await h.drain()

    assert.equal(a.childId, b.childId, '并发重复调用必须返回同一 childId')
    assert.equal(a.childId, c.childId, '顺序重复调用必须返回同一 childId')
    assert.deepEqual(a, b, '并发重复调用必须返回同一条结果')
    assert.deepEqual(h.dispatches.map((d) => d.childId), ['child-1', 'child-2'],
      `幂等：只许派生【一个】替补，实际 ${JSON.stringify(h.dispatches.map((d) => d.childId))}`)
    assert.equal(h.wakes.length, 1, '幂等：不得重复发换档信号')
    assert.deepEqual(h.interrupts.map((i) => i.childId), ['child-1'], '幂等：旧档只被 interrupt 一次')
  })

  it('④ 交接路径不得再 emit 一次 submit-failed（否则重复登记 onFailover、再跑一条链）', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 100000 })
    let submitFailedEmits = 0
    const origEmit = h.ctx.emit
    h.ctx.emit = (name, payload) => {
      if (name === 'product-subagents/submit-failed') submitFailedEmits += 1
      return origEmit(name, payload)
    }
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)
    const before = submitFailedEmits
    await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
    await h.drain()

    assert.equal(before, 1, '本档失败只应 emit 一次 submit-failed')
    assert.equal(submitFailedEmits, 1,
      `交接完成后不得再 emit submit-failed（FAILOVER_HANDED_OFF 是未知码，兜底分级是 failover，会再跑一条链）：实际 ${submitFailedEmits} 次`)
  })

  it('⑤ 已完成的换档重复调用返回同一结果（不报失败）；未知 childId 则报自解释错误', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 100000 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)
    const first = await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
    await h.drain()

    // 已完成过的换档：模型自愈重试必须拿到同一结果，而不是"没有待交接的换档请求"
    const again = await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
    assert.deepEqual(again, first, '重复调用已完成的换档必须返回同一结果')
    assert.deepEqual(h.dispatches.map((d) => d.childId), ['child-1', 'child-2'],
      '重复调用绝不许派第二个替补')

    await assert.rejects(
      () => h.dispatcher.handoff('child-does-not-exist'),
      /不在本插件的活跃映射中/,
      '未知 childId 必须自解释',
    )
  })

  it('⑤b 非该子代理父会话的调用方被拒（adjacency 由编排层自查）', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 100000 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)
    const stranger = { session: { id: 'other-session' }, options: { subagentDepth: 0 } }
    await assert.rejects(
      () => h.dispatcher.handoff('child-1', { parentAgent: stranger }),
      /不属于当前会话/,
    )
    h.dispatcher.dispose()
  })
})

describe('notify-then-auto：超时自动换档走与手动完全相同的执行体', () => {
  it('⑥ 超时 → 插件自动派同级替补；旧档在合理时间内结束（不是 15 分钟）', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 40, failoverWaitMs: 900000 })
    const t0 = Date.now()
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()
    const elapsed = Date.now() - t0

    assert.ok(elapsed < 5000, `超时自动换档必须在 notifyWaitMs 量级内完成，绝不能挂到 failoverWaitMs（15 分钟）：实际 ${elapsed}ms`)
    assert.equal(h.wakes.length, 1, '必须先发一条唤醒信号给主代理（给它机会显式换档）')
    assert.equal(h.wakes[0].via, 'followup')
    assert.match(h.wakes[0].text, /插件会自动派一个同级替补档/, 'notify-then-auto 的信号必须明说超时会自动换档')
    assert.deepEqual(h.interrupts.map((i) => i.childId), ['child-1'], '超时路径必须同样 interrupt 旧档')
    assert.deepEqual(h.dispatches.map((d) => [d.childId, d.parentId]), [
      ['child-1', 'main-1'], ['child-2', 'main-1'],
    ], '超时路径派出的替补同样必须是主代理的同级子级')
    assert.equal(h.entries.find((e) => e.childId === 'child-2').nested, false)
    assert.equal(h.entries.find((e) => e.childId === 'child-2').parentSessionId, 'main-1')
  })

  it('⑦ 手动与超时自动两条路径：通知序列等价（除 trigger 字段）', async () => {
    const manual = makeCase(FAIL_SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 100000 })
    await manual.dispatcher.dispatch(manual.parentAgent, AGENT_ID, TASK, {})
    await manual.until(() => manual.wakes.length > 0)
    const m = await manual.dispatcher.handoff('child-1', { parentAgent: manual.parentAgent })
    await manual.drain()

    const auto = makeCase(FAIL_SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 40 })
    await auto.dispatcher.dispatch(auto.parentAgent, AGENT_ID, TASK, {})
    await auto.drain()

    const shape = (h) => ({
      wakes: h.wakes.map((w) => w.via),
      interrupts: h.interrupts.map((i) => i.childId),
      dispatches: h.dispatches.map((d) => [d.childId, d.parentId]),
      notices: h.notices.map((n) => `${n.childId}:${n.stopReason}`),
    })
    assert.deepEqual(shape(auto), shape(manual),
      `手动与超时自动必须产生完全相同的信号/中断/派发/通知序列\n  手动: ${JSON.stringify(shape(manual))}\n  自动: ${JSON.stringify(shape(auto))}`)
    assert.deepEqual(auto.notices.map((n) => n.stopReason), ['aborted', 'completed'])
    assert.equal(m.trigger, 'agent_failover')
  })

  it('⑧ 手动在超时临界点抢先：只产生一个替补（抢到 claim 的一方生效）', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 40 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)
    const manual = await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
    await h.drain()
    // 超时定时器此时才到（next-tick 让它跑完）
    await new Promise((r) => { setTimeout(r, 80) })

    assert.deepEqual(h.dispatches.map((d) => d.childId), ['child-1', 'child-2'],
      `手动抢先后超时定时器必须是 no-op，实际 ${JSON.stringify(h.dispatches.map((d) => d.childId))}`)
    assert.deepEqual(h.interrupts.map((i) => i.childId), ['child-1'], '旧档只被 interrupt 一次')
    assert.equal(manual.childId, 'child-2')
  })
})

describe('notify：超时按失败收尾（旧档被释放，不挂 15 分钟）', () => {
  it('⑨ 超时 → 不派替补，旧档正常结束并报失败，信息自解释（含已试档与原因）', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 40, failoverWaitMs: 900000 })
    const t0 = Date.now()
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()
    const elapsed = Date.now() - t0

    assert.ok(elapsed < 5000, `notify 超时必须在 notifyWaitMs 量级内收尾，绝不能挂到 failoverWaitMs（15 分钟）：实际 ${elapsed}ms`)
    assert.deepEqual(h.dispatches.map((d) => d.childId), ['child-1'],
      `notify 超时绝不自动换档，实际派了 ${JSON.stringify(h.dispatches.map((d) => d.childId))}`)
    assert.equal(h.interrupts.length, 0, 'notify 超时不 interrupt 旧档——它要如实报失败，而不是被停止')
    assert.equal(h.notices.length, 1, '旧档必须正常结算（一条通知）')
    assert.equal(h.notices[0].stopReason, 'completed', 'notify 超时按失败收尾，不是"被停止"')
    assert.match(h.notices[0].text, /已尝试 1 档: deveco → EMPTY_RESPONSE deveco 返回空正文（无任何文本输出）/,
      `失败信息必须自解释（含已试档与原因），实际：${h.notices[0].text}`)
    assert.match(h.notices[0].text, /主代理在 40ms 内未调用 agent_failover/,
      `必须说明"为什么没换档"，实际：${h.notices[0].text}`)
    assert.match(h.notices[0].text, /本次提交按失败计/, '必须明说结果是失败')
    assert.equal(h.dispatcher.hasPendingHandoff('child-1'), false, 'rendezvous 必须已被作废并清理')
  })

  it('⑩ 超时后的失败信息自解释：含已试档、原因、以及"未换档"的说明', async () => {
    const h = makeCase(FAIL_SCRIPT, { failoverMode: 'notify', notifyWaitMs: 40 })
    const outcome = await (async () => {
      let captured = null
      const orig = h.dispatcher.handleSubmitFailoverNotify.bind(h.dispatcher)
      h.dispatcher.handleSubmitFailoverNotify = async (req) => {
        const r = await orig(req)
        captured = r
        return r
      }
      await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
      await h.drain()
      return captured
    })()

    assert.ok(outcome && outcome.timedOut === true, `超时裁决必须自带 timedOut 标记，实际 ${JSON.stringify(outcome)}`)
    assert.notEqual(outcome.handedOff, true, 'notify 超时不得声称已交接（不得派替补）')
    assert.match(outcome.summary, /已尝试 1 档: deveco → EMPTY_RESPONSE/, `summary 必须自解释（含已试档与原因），实际：${outcome.summary}`)
    assert.match(outcome.message, /未调用 agent_failover/, `message 必须说明"主代理没决定"，实际：${outcome.message}`)
  })
})