/**
 * v1.11.24 行为变更后的核心回归：`auto` 模式下换档的通知序列与派生拓扑。
 *
 * 【v1.11.24 的用户可见语义变更】（不是内部重构，必须写死断言）
 *   旧（1.11.22/1.11.23）：替补档是失败档的**孙代**（parent = 失败档），在失败档自己的
 *     回合里把链走完，主代理**恰好收到 1 条**终局通知（替补的答案），看不到任何中间态。
 *   新（1.11.24）：替补档是主代理的**直接子级**（depth-1，同级），其结算通知**直接回
 *     主代理**；失败档被显式中止并释放。于是主代理会读到：
 *       ① （notify 模式下还有）唤醒型换档信号
 *       ② 失败档的结算通知："…was stopped before it finished."
 *       ③ 替补档的结算通知（带替补的答案）
 *     这是**刻意**的：主代理必须对替补有完全的可及性（双向 send_message / agent_children
 *     可见 / interrupt_agent 生效），孙代做不到这一点。
 *
 * 假宿主的语义与真源对照见 test/helpers/failover-host.js 顶部注释。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  AGENT_ID, TASK, makeCase, settleOk, settleFail,
} from './helpers/failover-host.js'
import { gradeSubmitFailure } from '../lib/dispatch.js'

/** 抽取"替补档"的 entry（v1.11.24 下除首档外全部是同级替补） */
const replacement = (entries) => entries.find((e) => e.childId !== 'child-1')

describe('gradeSubmitFailure（编排层本地兜底，与 product-subagents 同构）', () => {
  it('限额/限流/空正文 = failover；认证/参数 = fatal；人为取消 = interrupted', () => {
    assert.equal(gradeSubmitFailure('RATE_LIMITED', '429'), 'failover')
    assert.equal(gradeSubmitFailure(null, 'insufficient_quota'), 'failover')
    assert.equal(gradeSubmitFailure('EMPTY_RESPONSE', '空正文'), 'failover')
    assert.equal(gradeSubmitFailure('INVALID_API_KEY', 'invalid api key'), 'fatal')
    assert.equal(gradeSubmitFailure(null, 'HTTP 401 Unauthorized'), 'fatal')
    assert.equal(gradeSubmitFailure('SUBMIT_ABORTED', 'aborted'), 'interrupted')
    // v1.11.24：交接完成的收尾码必须归入 interrupted，绝不可再触发一条换档链
    assert.equal(gradeSubmitFailure('FAILOVER_HANDED_OFF', '本档已由编排层换档'), 'interrupted')
  })
})

describe('auto 模式：替补档是主代理的同级子级（孙代已彻底移除）', () => {
  it('① 第一档空正文 → 替补档成功：主代理读到【旧档被停止 → 替补结果】两条，无孙代', async () => {
    const h = makeCase({
      deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文（无任何文本输出）'),
      opencode: settleOk('第二档产出的完整答案'),
      'deepseek-official': settleOk('不该被用到'),
    })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()

    // —— 拓扑：替补是主代理的 depth-1 直接子级 ——
    assert.deepEqual(h.dispatches.map((d) => [d.childId, d.parentId]), [
      ['child-1', 'main-1'],
      ['child-2', 'main-1'],
    ], `两条派发都必须挂在主代理之下，实际 ${JSON.stringify(h.dispatches)}`)
    assert.equal(h.entries.length, 2, '全程只应派生两个 entry（首档 + 替补）')
    assert.equal(h.entries.filter((e) => e.nested).length, 0,
      '孙代形态已彻底移除：任何 entry 都不许有 nested=true')
    assert.equal(replacement(h.entries).parentSessionId, 'main-1', '替补的 parentSessionId 必须是主代理会话')

    // —— 通知序列：旧档先被停止，替补的结果随后 ——
    assert.equal(h.notices.length, 2, `主代理应读到 2 条通知（旧档 + 替补），实际 ${h.notices.length}：${JSON.stringify(h.notices.map((n) => n.text))}`)
    const [stopped, result] = h.notices
    assert.match(stopped.text, /Background subagent child-1 was stopped before it finished\./,
      '第一条必须是旧档的"was stopped before it finished."（真实且预期内）')
    assert.match(result.text, /finished and will do no further work/, '第二条必须是替补档的完成通知')
    assert.match(result.text, /第二档产出的完整答案/, '替补的通知必须携带替补的答案')
    assert.equal(h.wakes.length, 0, 'auto 模式不发唤醒信号（不等待主代理）')

    // —— 旧档确实被 interrupt 且只 interrupt 一次 ——
    assert.deepEqual(h.interrupts.map((i) => i.childId), ['child-1'],
      `旧档必须恰好被 interrupt 一次，实际 ${JSON.stringify(h.interrupts)}`)
  })

  it('② 第一档 429/额度不足 → 替补成功：同样只有"旧档停止 + 替补结果"两条', async () => {
    const h = makeCase({
      deveco: settleFail('RATE_LIMITED', 'HTTP 429 rate limit exceeded for deveco'),
      opencode: settleOk('换到第二档后的答案'),
      'deepseek-official': settleOk('不该被用到'),
    })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()

    assert.equal(h.notices.length, 2)
    assert.match(h.notices[0].text, /child-1 was stopped before it finished\./)
    assert.match(h.notices[1].text, /换到第二档后的答案/)
    assert.ok(!h.notices.some((n) => /步骤失败|EMPTY_RESPONSE|所有路由均失败/.test(n.text)),
      '成功路径不得泄漏任何失败文本')
  })

  it('③ 整条 routes 链全失败：旧档停止 + 各档依次失败，终局文本自解释已试档与各自最后错误', async () => {
    const h = makeCase({
      deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文'),
      opencode: settleFail('RATE_LIMITED', 'HTTP 429 opencode 限流'),
      'deepseek-official': settleFail('SUBMIT_TIMEOUT', 'deepseek-official 提交超时'),
    })
    const { output } = await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, { waitResult: true })
    await h.drain()

    assert.deepEqual(h.dispatches.map((d) => [d.childId, d.parentId]), [
      ['child-1', 'main-1'], ['child-2', 'main-1'], ['child-3', 'main-1'],
    ], `链必须逐档推进，且每档都是主代理的同级子级，实际 ${JSON.stringify(h.dispatches)}`)
    assert.equal(h.notices.length, 3, `主代理应读到 3 条（旧档 + 两档替补失败），实际 ${h.notices.length}`)
    assert.match(h.notices[0].text, /child-1 was stopped before it finished\./, '第一条必须是旧档被停止')
    assert.match(h.notices[2].text, /child-3 failed before it finished\./, '末档必须如实报失败')
    // 宿主结算通知携带的是子代理自己的最后一条消息；编排层的自解释终局文本落在 waiters 上
    assert.match(output, /已尝试 3 档: deveco → EMPTY_RESPONSE deveco 返回空正文；opencode → RATE_LIMITED HTTP 429 opencode 限流；deepseek-official → deepseek-official 提交超时/,
      `终局文本必须自解释（逐档 provider + 各自最后错误），实际：${output}`)
  })

  it('④ 不可重试错误（认证失败）：不换档，只有旧档自己的失败通知，且无替补', async () => {
    const h = makeCase({
      deveco: settleFail('INVALID_API_KEY', 'invalid api key'),
      opencode: settleOk('不该被用到'),
      'deepseek-official': settleOk('不该被用到'),
    })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()

    assert.equal(h.dispatches.length, 1, 'fatal 分级不得换档')
    assert.equal(h.notices.length, 1, '只有旧档自己的失败通知')
    assert.match(h.notices[0].text, /INVALID_API_KEY/)
    assert.equal(h.interrupts.length, 0, 'fatal 分级不换档 ⇒ 不得 interrupt 旧档')
  })

  it('⑤ byAgent 与同任务去重都认替补（旧档的"孙代豁免"已删除）', async () => {
    const h = makeCase({
      deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文'),
      opencode: settleOk('第二档答案'),
      'deepseek-official': settleOk('不该被用到'),
    })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()

    // 替补是同级线程 ⇒ 必须进 byAgent（可被 agent_followup --childId 定向）与 activeTasks
    assert.deepEqual(h.byAgentWrites, [['senior-dev', 'child-1'], ['senior-dev', 'child-2']],
      '替补是主代理的直接子级，必须与首档一样登记 byAgent（孙代豁免已删除）')
    const rep = replacement(h.entries)
    assert.equal(rep.failoverCount, 1)
    assert.deepEqual(rep.failoverTried, ['deveco'], '替补必须记得已试档，避免下一跳选回失败档')
    assert.equal(rep.chainRootId, 'child-1', '替补必须与首档共用链裁决键（追加消息改投用）')
  })

  it('⑥ 同一回合重复失败不得起第二条链（幂等：并发调用复用同一裁决）', async () => {
    const h = makeCase({
      deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文'),
      opencode: settleOk('第二档答案'),
      'deepseek-official': settleOk('不该被用到'),
    })
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    const req = { childId: 'child-1', code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文', grade: 'failover' }
    const [a, b] = await Promise.all([
      h.dispatcher.handleSubmitFailover(req),
      h.dispatcher.handleSubmitFailover(req),
    ])
    await h.drain()
    assert.deepEqual(a, b, '并发重复调用必须复用同一条链的裁决')
    assert.equal(h.dispatches.length, 2, '并发重复调用只许派生一个替补（首档 + 替补）')
  })
})

describe('换档期间的追加消息：不丢、且改投到当前档', () => {
  it('⑦ 追加消息改投到替补档（主代理的同级 thread），且只投一次、不投回失败档', async () => {
    let release = null
    const hold = new Promise((r) => { release = r })
    const h = makeCase({
      deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文'),
      opencode: { kind: 'ok', text: '替补档的答案', hold },
      'deepseek-official': settleOk('不该被用到'),
    })

    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.dispatcher.chainLiveChild.get('child-1') === 'child-2')
    assert.ok(h.children.get('child-2'), '替补档必须已被派生')
    assert.equal(h.dispatcher.chainLiveChild.get('child-1'), 'child-2', '链上当前活跃档必须是替补档')

    await h.dispatcher.followup(h.parentAgent, 'child-1', '补充：只看移动端')
    assert.deepEqual(h.deliveries, [
      { senderId: 'main-1', targetId: 'child-2', text: '补充：只看移动端' },
    ], `换档期间落向失败档的追加消息必须改投给当前档，实际 ${JSON.stringify(h.deliveries)}`)

    release()
    await h.drain()
  })

  it('⑧ 追加消息绝不投回已失败的档（否则会绕回坏产品再触发一轮换档）', async () => {
    let release = null
    const hold = new Promise((r) => { release = r })
    const h = makeCase({
      deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文'),
      opencode: { kind: 'ok', text: '替补档的答案', hold },
      'deepseek-official': settleOk('不该被用到'),
    })

    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.until(() => h.dispatcher.chainLiveChild.get('child-1') === 'child-2')
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, '第二条独立任务', { reuse: 'fresh' })
    await h.dispatcher.followup(h.parentAgent, 'child-1', '第二条的补充')
    assert.ok(!h.deliveries.some((d) => d.targetId === 'child-1'),
      `追加消息绝不可投回已失败的档，实际投递：${JSON.stringify(h.deliveries)}`)

    release()
    await h.drain()
  })
})

describe('回合内换档已处理过 → 回合外不得再起第二条重试链（不双份换档）', () => {
  it('⑨ 换档成功后 relay 回合随后 error：不得用同一任务文本再派第三个 child', async () => {
    const h = makeCase({
      deveco: { kind: 'fail-then-error', code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文' },
      opencode: settleOk('第二档产出的完整答案'),
      'deepseek-official': settleOk('不该被用到'),
    })

    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()

    assert.deepEqual(h.dispatches.map((d) => d.childId), ['child-1', 'child-2'],
      `回合内已处理过，只应派生【一个】替补，实际派了 ${h.dispatches.length} 个：${JSON.stringify(h.dispatches)}`)
    const topLevel = h.dispatches.filter((d) => d.parentId === 'main-1')
    assert.equal(topLevel.length, 2, `主代理之下必须只有首档 + 一个替补，实际 ${topLevel.length} 个`)
    assert.equal(h.entries.filter((e) => !e.nested).length, 2, '不得派生任何额外兄弟 child')
  })

  it('⑩ 链推进到末档后必须停住，不得派生第四个 child；终局文本自解释"已是最末档"', async () => {
    const h = makeCase({
      deveco: { kind: 'fail-then-error', code: 'EMPTY_RESPONSE', message: 'deveco 返回空正文', tail: '' },
      opencode: settleFail('RATE_LIMITED', 'HTTP 429 opencode 限流'),
      // 末档也失败：routes 到尽头，必须停住
      'deepseek-official': settleFail('SUBMIT_TIMEOUT', 'deepseek-official 提交超时'),
    })

    const { output } = await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, { waitResult: true })
    await h.drain()

    assert.deepEqual(h.dispatches.map((d) => d.childId), ['child-1', 'child-2', 'child-3'],
      `链逐档推进到末档后必须停住，实际派了 ${h.dispatches.length} 个：${JSON.stringify(h.dispatches.map((d) => d.childId))}`)
    assert.match(output, /自动换档已停止: 当前已是最末档，无后续路由/,
      `停止原因必须自解释，而不是含糊的"换档已停止"，实际：${output}`)
    assert.match(output, /已尝试 3 档/, `终局文本必须逐档自解释，实际：${output}`)
  })

  it('⑪ 根档被中止（inTurnChain 已置位）后，onChildEnd 绝不再为同一任务派生第二个替补', async () => {
    const h = makeCase({
      deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文'),
      opencode: settleOk('替补档的答案'),
      'deepseek-official': settleOk('不该被用到'),
    })

    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()

    assert.deepEqual(h.dispatches.map((d) => d.childId), ['child-1', 'child-2'],
      `根档结束时不得再自动派生替补（双份换档），实际 ${JSON.stringify(h.dispatches.map((d) => d.childId))}`)
    assert.equal(h.entries.length, 2, '不得存在第三个 entry')
    assert.equal(replacement(h.entries).parentSessionId, 'main-1', '替补必须是主代理的同级子级')
  })
})

describe('兼容：failoverInTurn=false 退回旧的结算后兜底换档（用于对照排障）', () => {
  it('关掉开关 → 不阻塞、不发信号，旧档先结算，替补随后由 onChildEnd 派出（仍是同级）', async () => {
    const h = makeCase({
      deveco: settleFail('EMPTY_RESPONSE', 'deveco 返回空正文'),
      opencode: settleOk('第二档答案'),
      'deepseek-official': settleOk('不该被用到'),
    }, {})
    h.dispatcher.failoverInTurn = false
    await h.dispatcher.dispatch(h.parentAgent, AGENT_ID, TASK, {})
    await h.drain()

    assert.equal(h.wakes.length, 0, '关掉开关 ⇒ 没有任何阻塞握手，也没有唤醒信号')
    assert.equal(h.interrupts.length, 0, '关掉开关 ⇒ 兜底路径不 interrupt 旧档（旧档自己结算）')
    assert.deepEqual(h.dispatches.map((d) => [d.childId, d.parentId]), [
      ['child-1', 'main-1'],
      ['child-2', 'main-1'],
    ], '兜底换档同样派主代理的同级子级（孙代已移除）')
    assert.match(h.notices[0].text, /child-1 finished and will do no further work/,
      '关掉开关 ⇒ 旧档没有被 interrupt，它如实转达失败后以 completed 结束（v1.11.21 的中间态语义）')
    assert.match(h.notices[0].text, /EMPTY_RESPONSE/, '旧档的通知里带着失败原因')
    assert.match(h.notices[1].text, /第二档答案/, '替补档的结果随后送达')
  })
})