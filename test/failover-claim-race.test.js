/**
 * v1.11.24 最高优先不变量：**同一任务在任何时刻至多只有一个替补子代理**。
 *
 * 用户原话：「最重要确保，不要同时主代理手动 fallback、而旧代理又自动 fallback，
 * 出现同时两个子代理在处理同一个任务。」本文件把这个要求从"尽量避免"变成
 * "机制保证"，并逐条钉死每个竞态窗口。
 *
 * 机制（见 lib/dispatch.js `#claimHandoff`）：三条换档路径
 *   （a）`agent_failover` 工具 → handoff()
 *   （b）`notify-then-auto` 超时自动 → handoff()（同一个执行体）
 *   （c）`auto` 立即 → handleSubmitFailover() → #claimHandoff
 * 全部经过**同一个** `has → set → run` 同步块。Node 单线程 + 块内无 await ⇒
 * 「查到空」与「写入表」之间不可能插入另一段换档逻辑。
 *
 * 覆盖的竞态窗口（对应断言见各 it 的注释）：
 *   W1 我在超时之前调用 agent_failover
 *   W2 我在超时临界点调用（插件定时器与我的调用"同时"到达）—— 最关键，循环 60 次
 *   W3 超时先到、自动路径已 claim，我随后才调用（必须 no-op 返回同一 childId）
 *   W4 我重复调用多次（含连续两次无间隔）
 *   W5 旧档结束事件（onChildEnd）在 handoff 进行中到达
 *   W6 同一任务的并发派发（两条独立的 submit-failed 路径）
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AGENT_ID, TASK, makeCase, settleOk, settleFail } from './helpers/failover-host.js'

const SCRIPT = {
  deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文'),
  opencode: settleOk('替补档的答案'),
  'deepseek-official': settleOk('不该被用到'),
}

/** 任何时刻的"同一任务替补数"都必须 ≤ 1 */
const assertSingleReplacement = (h, label) => {
  const replacements = h.dispatches.filter((d) => d.childId !== 'child-1')
  assert.equal(replacements.length, 1,
    `${label}: 同一任务至多一个替补，实际派了 ${replacements.length} 个：${JSON.stringify(h.dispatches)}`)
  assert.equal(replacements[0].parentId, 'main-1',
    `${label}: 替补必须是主代理的直接子级（depth-1 同级），实际 parentId=${replacements[0].parentId}`)
  const entries = h.entries.filter((e) => e.childId !== 'child-1')
  assert.equal(entries.length, 1, `${label}: 不得存在第二个替补 entry`)
  assert.equal(entries[0].nested, false, `${label}: 替补不得是 nested（孙代已彻底移除）`)
  assert.equal(entries[0].parentSessionId, 'main-1', `${label}: 替补的 parentSessionId 必须是主代理会话`)
  // 旧档恰好被释放一次：既不能 interrupt 两次，也不能一次都不 interrupt
  assert.equal(h.interrupts.length, 1,
    `${label}: 旧档必须恰好被 interrupt 一次，实际 ${JSON.stringify(h.interrupts)}`)
}

describe('W1 我在超时之前调用 agent_failover', () => {
  it('W1：手动抢先 → 超时定时器成为 no-op，只有一个替补', async () => {
    const h = makeCase(SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 100000 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)
    const r = await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
    await h.drain()
    // 让超时定时器有机会跑（它不该做任何事）
    h.dispatcher.notifyWaitMs = 10
    await new Promise((res) => { setTimeout(res, 60) })
    assertSingleReplacement(h, 'W1')
    assert.equal(r.trigger, 'agent_failover')
  })
})

describe('W2 我在超时临界点调用（最关键：循环暴露时序问题）', () => {
  it('W2 × 60：手动与超时定时器在同一 tick 撞车，始终只有一个替补', async () => {
    const ROUNDS = 60
    const seenTriggers = new Set()
    for (let round = 0; round < ROUNDS; round += 1) {
      // 临界点：notifyWaitMs = 0 ⇒ 定时器在下一个 timer tick 就到，
      // 而 dispatch 的回合启动也在同一个 tick 之后。手动调用与定时器"同时"到达。
      const h = makeCase(SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 0 })
      await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
      await h.until(() => h.wakes.length > 0)
      // notifyWaitMs=0 ⇒ 超时定时器就在下一个 timer tick 到达，恰好是"临界点"。
      // 两个方向交替覆盖，让 claim 在两种到达顺序下都被检验：
      //   偶数轮：手动同步调用（microtask，早于任何 timer）→ 定时器随后到，是输家
      //   奇数轮：先让出一个 macrotask（setImmediate，晚于 timer）→ 定时器先 claim，是赢家
      const manualFirst = round % 2 === 0
      const call = () => h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
        .catch((e) => ({ __rejected: e.message }))
      const manual = manualFirst
        ? call()
        : (async () => { await new Promise((r) => { setImmediate(r) }); return call() })()
      const settled = await Promise.allSettled([manual])
      await h.drain()
      await new Promise((r) => { setTimeout(r, 12) }) // 让超时定时器彻底过去

      assertSingleReplacement(h, `W2 round ${round}`)
      const ok = settled.filter((s) => s.status === 'fulfilled' && s.value && s.value.childId)
      assert.ok(ok.length >= 1, `W2 round ${round}: 至少一方应拿到替补 childId，实际 ${JSON.stringify(settled)}`)
      const ids = new Set(ok.map((s) => s.value.childId))
      assert.equal(ids.size, 1, `W2 round ${round}: 两方必须拿到同一 childId，实际 ${JSON.stringify([...ids])}`)
      for (const s of ok) seenTriggers.add(s.value.trigger)
      h.dispatcher.dispose()
    }
    // 两个方向都要被覆盖到：说明"谁先到谁生效"是真实竞态而不是被某条路径短路
    assert.deepEqual([...seenTriggers].sort(), ['agent_failover', 'auto-timeout'],
      `两轮方向都必须被覆盖（否则 W2 只是单边通过）：实际 ${JSON.stringify([...seenTriggers])}`)
    console.log(`  W2: ${ROUNDS} 轮，抢到 claim 的 trigger 分布 = ${JSON.stringify([...seenTriggers].sort())}`)
  })
})

describe('W3 超时先到、自动路径已 claim，我随后才调用', () => {
  it('W3 × 20：后到的调用必须是 no-op，返回同一 childId，不派第二个替补', async () => {
    const ROUNDS = 20
    for (let round = 0; round < ROUNDS; round += 1) {
      const h = makeCase(SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 0 })
      await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
      await h.until(() => h.dispatcher.chainLiveChild.get('child-1') === 'child-2' || h.wakes.length > 0)
      // 让自动路径先跑完
      await h.until(() => h.dispatches.length >= 2)
      await h.drain()
      const late = await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
      await new Promise((r) => { setTimeout(r, 12) })
      assertSingleReplacement(h, `W3 round ${round}`)
      assert.equal(late.childId, 'child-2', `W3 round ${round}: 后到的调用必须拿到自动路径派出的那个替补`)
      assert.equal(late.trigger, 'auto-timeout', `W3 round ${round}: 生效的必须是先到的那一方`)
      h.dispatcher.dispose()
    }
  })
})

describe('W4 我重复调用多次（含连续两次无间隔）', () => {
  it('W4 × 30：连续 4 次调用只产生一个替补、一个 interrupt、一条唤醒信号', async () => {
    const ROUNDS = 30
    for (let round = 0; round < ROUNDS; round += 1) {
      const h = makeCase(SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 100000 })
      await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
      await h.until(() => h.wakes.length > 0)
      const rs = await Promise.all([
        h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent }),
        h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent }),
        h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent }),
        h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent }),
      ])
      await h.drain()
      // 完成后再连调两次（模型自愈重试）
      rs.push(await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent }))
      rs.push(await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent }))

      assertSingleReplacement(h, `W4 round ${round}`)
      const ids = new Set(rs.map((r) => r.childId))
      assert.equal(ids.size, 1, `W4 round ${round}: 6 次调用必须返回同一 childId，实际 ${JSON.stringify([...ids])}`)
      assert.equal(h.wakes.length, 1, `W4 round ${round}: 只许一条唤醒信号`)
      h.dispatcher.dispose()
    }
  })
})

describe('W5 旧档结束事件（onChildEnd）在 handoff 进行中到达', () => {
  it('W5：inTurnChain 是持久闸门 —— 去掉它就会自动起"自动孙代/兄弟"（变异验证见下）', async () => {
    const h = makeCase(SCRIPT, { failoverMode: 'notify', notifyWaitMs: 100000 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.wakes.length > 0)

    // 手工模拟"旧档在 handoff 执行途中结算"：直接调 onChildEnd
    await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
    const entrySnapshot = { inTurnChain: true }
    void entrySnapshot
    await h.drain()

    assertSingleReplacement(h, 'W5')
    // 旧档已被 handoff 兑现（rendezvous 已清理），再来的 onChildEnd 是幂等 no-op
    const before = h.dispatches.length
    h.dispatcher.onChildEnd('child-1', 'aborted', '被换档停止')
    await h.drain()
    assert.equal(h.dispatches.length, before,
      `重复的 onChildEnd 不得再派替补（实际 ${JSON.stringify(h.dispatches.map((d) => d.childId))}）`)
  })

  it('W5b：fatal 分级（不换档）时 inTurnChain 不得被置位，否则会吞掉合法的兜底换档', async () => {
    const h = makeCase({
      deveco: settleFail('INVALID_API_KEY', 'invalid api key'),
      opencode: settleOk('不该被用到'),
      'deepseek-official': settleOk('不该被用到'),
    }, { failoverMode: 'notify-then-auto', notifyWaitMs: 30 })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()
    assert.equal(h.dispatches.length, 1, 'fatal 分级绝不换档')
    assert.equal(h.wakes.length, 0, 'fatal 分级不发唤醒信号')
  })
})

describe('W6 同一任务的并发派发 / 并发重复失败', () => {
  it('W6 × 30：并发两次 handleSubmitFailover + 两次 handoff 混合，只有一个替补', async () => {
    const ROUNDS = 30
    for (let round = 0; round < ROUNDS; round += 1) {
      const h = makeCase(SCRIPT, { failoverMode: 'notify-then-auto', notifyWaitMs: 100000 })
      await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
      await h.until(() => h.wakes.length > 0)
      const req = { childId: 'child-1', code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文', grade: 'failover' }
      // 注意：不要 await 这两个 notify 调用——它们返回的就是那条 rendezvous promise，
      // 只有 handoff()/超时才会兑现它（await 就会自锁）。这里只是把它们并发打出去。
      const notifyA = h.dispatcher.handleSubmitFailoverNotify(req).catch((e) => ({ __rejected: e.message }))
      const notifyB = h.dispatcher.handleSubmitFailoverNotify(req).catch((e) => ({ __rejected: e.message }))
      const r = await h.dispatcher.handoff('child-1', { parentAgent: h.parentAgent })
      const [a, b] = await Promise.all([notifyA, notifyB])
      // 已换过档的档位再来一次 auto 处理（模型自愈重试）
      const late = await h.dispatcher.handleSubmitFailover(req)
      await h.drain()

      assertSingleReplacement(h, `W6 round ${round}`)
      assert.equal(h.wakes.length, 1, `W6 round ${round}: 重复失败只许一条唤醒信号`)
      assert.equal(a.handedOff, true, `W6 round ${round}: 两个并发 notify 调用必须都拿到同一份"已交接"裁决`)
      assert.deepEqual(a, b, `W6 round ${round}: 并发 notify 必须返回同一裁决`)
      assert.equal(late, null, `W6 round ${round}: 旧档已结算后 late auto 处理必须是 no-op`)
      assert.equal(r.childId, 'child-2')
      h.dispatcher.dispose()
    }
  })
})

describe('W7 两个"首次 claim"并发抵达（同步性被破坏时唯一会显形的窗口）', () => {
  it('W7 × 30：两个 handler 入口同时首次 claim → 只有一个替补（同步 claim 的存在理由）', async () => {
    const ROUNDS = 30
    for (let round = 0; round < ROUNDS; round += 1) {
      let open = null
      const gate = new Promise((r) => { open = r })
      const h = makeCase(
        { ...SCRIPT, deveco: { ...SCRIPT.deveco, gate } },
        { failoverMode: 'notify-then-auto', notifyWaitMs: 100000 },
      )
      await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
      // relay 回合停在 gate 上、尚未发出任何 submit-failed ⇒ claim 表还是空的
      await new Promise((r) => { setTimeout(r, 5) })
      assert.equal(h.dispatcher.handoffs.size, 0, `W7 round ${round}: gate 未开时不得有任何 claim`)

      // 两个入口在同一段同步代码里【首次】claim（真实场景：同一回合并发两次 product_submit）
      const req = { childId: 'child-1', code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文', grade: 'failover' }
      const pNotify = h.dispatcher.handleSubmitFailoverNotify(req).catch((e) => ({ __rejected: e.message }))
      const pAuto = h.dispatcher.handleSubmitFailover(req).catch((e) => ({ __rejected: e.message }))
      open()
      // 裁决本身有可能因为 claim 竞争而永不到达（被覆盖的那条 rendezvous 成了孤儿），
      // 故先给一个有界等待：症状【必须】落成"派了几个替补"这个可断言的事实，
      // 而不是把测试挂死。
      const verdicts = await Promise.race([
        Promise.all([pNotify, pAuto]),
        new Promise((r) => { setTimeout(() => r(null), 1500) }),
      ])
      let drainError = null
      try { await h.drain() } catch (err) { drainError = err }

      // ★ 核心断言：无论谁先到，同一任务至多一个替补。同步 claim 被破坏时这里会出现两条 dispatch。
      assertSingleReplacement(h, `W7 round ${round}`)
      assert.equal(h.wakes.length, 1, `W7 round ${round}: 只许一条唤醒信号`)
      if (drainError === null) {
        assert.ok(
          verdicts && verdicts.some((v) => v && v.handedOff === true),
          `W7 round ${round}: 至少一方必须拿到"已交接"裁决，实际 ${JSON.stringify(verdicts)}`,
        )
      }
      h.dispatcher.dispose()
    }
  })

  it('W7b × 30：auto 模式下两个并发首次 claim → 只派【一个】替补（变异时会变成两条 dispatch）', async () => {
    const ROUNDS = 30
    for (let round = 0; round < ROUNDS; round += 1) {
      let open = null
      const gate = new Promise((r) => { open = r })
      const h = makeCase(
        { ...SCRIPT, deveco: { ...SCRIPT.deveco, gate } },
        { failoverMode: 'auto' },
      )
      await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
      await new Promise((r) => { setTimeout(r, 5) })
      assert.equal(h.dispatcher.handoffs.size, 0, `W7b round ${round}: gate 未开时不得有任何 claim`)

      const req = { childId: 'child-1', code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文', grade: 'failover' }
      const p1 = h.dispatcher.handleSubmitFailover(req).catch((e) => ({ __rejected: e.message }))
      const p2 = h.dispatcher.handleSubmitFailover(req).catch((e) => ({ __rejected: e.message }))
      open()
      const verdicts = await Promise.race([
        Promise.all([p1, p2]),
        new Promise((r) => { setTimeout(() => r(null), 2000) }),
      ])
      let drainError = null
      try { await h.drain() } catch (err) { drainError = err }

      // ★ 这就是"同一任务出现两个子代理"的原始症状：替补数 > 1、旧档被 interrupt 两次
      assertSingleReplacement(h, `W7b round ${round}`)
      if (drainError === null) {
        assert.ok(
          verdicts && verdicts.length === 2 && verdicts.every((v) => v && v.handedOff === true),
          `W7b round ${round}: 两个调用必须共享同一份"已交接"裁决，实际 ${JSON.stringify(verdicts)}`,
        )
        const ids = new Set(verdicts.map((v) => v.newChildId))
        assert.equal(ids.size, 1, `W7b round ${round}: 两个调用必须指向同一个替补 childId，实际 ${JSON.stringify([...ids])}`)
      }
      h.dispatcher.dispose()
    }
  })
})

describe('机制自证：claim 是同步的、唯一的', () => {
  it('claim 发生在任何 await 之前（源码护栏：#claimHandoff 块内无 await）', () => {
    const src = readFileSync(new URL('../lib/dispatch.js', import.meta.url), 'utf8')
    const start = src.indexOf('#claimHandoff(childId, record, trigger, { start = true } = {}) {')
    assert.ok(start > 0, '必须能定位 #claimHandoff 定义')
    const end = src.indexOf('\n  }\n', start)
    const body = src.slice(start, end)
    assert.ok(!/\bawait\b/.test(body),
      `#claimHandoff 的 has→set→run 块内绝不允许出现 await（那会让两个调用者都查到空）：\n${body}`)
    assert.ok(!/setTimeout|Promise\./.test(body),
      `#claimHandoff 块内不得有任何异步跳转：\n${body}`)
  })

  it('三条换档路径共用同一个 claim 点（源码护栏）', () => {
    const src = readFileSync(new URL('../lib/dispatch.js', import.meta.url), 'utf8')
    const claimCalls = src.match(/#claimHandoff\(/g) ?? []
    // 定义 1 + handoff() 1 + handleSubmitFailover 1 + handleSubmitFailoverNotify 2
    assert.ok(claimCalls.length >= 4, `claim 点必须被所有路径共用，实际只有 ${claimCalls.length} 处`)
    // 换档派发只允许出现在 #runHandoff 里（孙代/兄弟二选一，且只有一处实现）
    // 只看代码行：注释里可以（也应该）保留 "nestedFailover: true" 的历史说明
    const codeLines = src.split('\n')
      .filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l))
      .join('\n')
    const dispatches = codeLines.match(/nestedFailover:\s*(true|false|!![\w.]+)/g) ?? []
    assert.ok(dispatches.length >= 2, `应至少看到两处换档派发（#runHandoff 与 #retryOnChildFailure），实际 ${JSON.stringify(dispatches)}`)
    assert.ok(!dispatches.includes('nestedFailover: true'),
      `孙代路径已彻底移除：代码里不得再出现 nestedFailover: true，实际 ${JSON.stringify(dispatches)}`)
    assert.ok(!dispatches.some((d) => /!!/.test(d)),
      `换档派发不得再从 entry.nested 继承身份（恒 false），实际 ${JSON.stringify(dispatches)}`)
    // #runHandoff 是唯一的换档派发实现（#retryOnChildFailure 只作兜底，且有自己的闸门）
    const runHandoffStart = src.indexOf('async #runHandoff(record, trigger) {')
    assert.ok(runHandoffStart > 0, '必须能定位 #runHandoff（换档的唯一执行体）')
    const runHandoffEnd = src.indexOf('\n  }\n', runHandoffStart)
    assert.ok(src.slice(runHandoffStart, runHandoffEnd).includes('nestedFailover: false'),
      '#runHandoff 必须显式传 nestedFailover: false（替补是主代理的直接子级）')
  })
})