/**
 * v1.11.24：换档测试的共享假宿主。
 *
 * 按**宿主真实语义**建模（每条都注明真源），而不是按旧实现的假设建模：
 *
 *  1. 结算通知文案与顺序 —— `dsh-subagent/lib/types/continuation-messages.js:57-63`
 *     的 `settlementSummary`：`completed` → "finished and will do no further work"、
 *     `aborted` → "was stopped before it finished"、`error` → "failed before it finished"。
 *     宿主在 Activation 结算时**先**通知父代理、**再**发 subagent/end。
 *  2. 唤醒投递规则 —— `continuation-activation.js:681` 的
 *     `sendWaking(parent, msg, parent.status === 'idle' ? 'queue' : 'steer')`
 *     ＋ `:199-203`（queue→followup / steer→steer）。
 *  3. 忙着的子代理不结算 —— `continuation-activation.js:541` 在 `settlementState()`
 *     之前先 `await whenIdle()`；`dsh-agent-loop/lib/index.js:631-641` 即使 abort 也等
 *     in-flight 工具 settle ⇒ 阻塞在 product_submit 上的失败档永不结算。
 *  4. `interrupt` 解不开被阻塞的工具 —— 调度器等 in-flight settle，故"释放"必须由
 *     编排层显式兑现 rendezvous（`dispatcher.handoff()` 内部完成）。
 *  5. `startContinuable` 只看显式传入的 `request.parent` —— 与"谁在调用"无关，因此
 *     传主代理的 Agent 即得 depth-1 直接子级。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher, gradeSubmitFailure } from '../../lib/dispatch.js'

export const AGENT_ID = 'senior-dev'
export const TASK = '修复导航栏样式问题'
export const ROUTES = [
  { provider: 'deveco', model: 'GLM-5.1' },
  { provider: 'opencode', model: 'zen-main-free' },
  { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
]
export const ACP_PROVIDERS = new Set(['deveco', 'opencode'])

/** 宿主真实文案（continuation-messages.js:57-63） */
const settlementSummary = (childId, stopReason) => {
  const subject = `Background subagent ${childId}`
  if (stopReason === 'completed') return `${subject} finished and will do no further work unless you send it more.`
  if (stopReason === 'aborted') return `${subject} was stopped before it finished.`
  if (stopReason === 'max-tokens') return `${subject} ran out of room before it finished.`
  return `${subject} failed before it finished.`
}

export const settleOk = (text) => ({ kind: 'ok', text })
export const settleFail = (code, message, extra = {}) => ({ kind: 'fail', code, message, ...extra })

/**
 * @param {object} opts
 * @param {object} opts.script           { [provider]: {kind:'ok'|'fail'|'fail-then-error', ...} }
 * @param {string} opts.failoverMode     auto | notify | notify-then-auto（默认 auto，见下）
 * @param {number} opts.notifyWaitMs
 * @param {number} opts.failoverWaitMs
 */
export function makeCase(script, opts = {}) {
  const {
    failoverMode = 'auto',
    notifyWaitMs = 60,
    failoverWaitMs = 5000,
  } = opts
  const dispatcherRef = { current: null }
  const state = {
    seq: 0,
    running: 0,
    quiescent: null,
    /** 主代理收到的宿主结算通知（按到达顺序） */
    notices: [],
    /** 主代理收到的【唤醒型投递】（{via:'followup'|'steer'|'inject', text}） */
    wakes: [],
    /** ctx.subagents.sendMessage 的投递 */
    deliveries: [],
    /** ctx.subagents.interrupt 的调用（{childId, authority}） */
    interrupts: [],
    /** dispatch() 的 spec，供断言 parentSessionId / provider / nested */
    dispatches: [],
  }
  const children = new Map()
  const agents = new Map()

  // 主代理：depth 0 的 Agent 对象。status 可切以覆盖 steer/followup 两条唤醒分支。
  const parentAgent = {
    session: { id: 'main-1' },
    options: { subagentDepth: 0 },
    status: 'idle',
    followup(msg) { state.wakes.push({ via: 'followup', to: 'main-1', text: msg.content?.[0]?.text ?? '' }) },
    steer(msg) { state.wakes.push({ via: 'steer', to: 'main-1', text: msg.content?.[0]?.text ?? '' }) },
    inject(msg) { state.wakes.push({ via: 'inject', to: 'main-1', text: msg.content?.[0]?.text ?? '' }) },
  }
  agents.set('main-1', parentAgent)

  const release = () => {
    state.running -= 1
    if (state.running === 0 && state.quiescent) { const n = state.quiescent; state.quiescent = null; n() }
  }
  const schedule = (fn) => {
    state.running += 1
    const p = new Promise((r) => { setTimeout(r, 0) }).then(fn).finally(release)
    p.catch(() => {})
  }

  const notify = (child, stopReason, output) => {
    const lines = [settlementSummary(child.id, stopReason)]
    if (output === undefined || output === null || !String(output).trim()) lines.push('It left no closing message.')
    else lines.push('Its closing message:', String(output))
    const target = agents.get(child.parentId)
    if (target) state.notices.push({ to: child.parentId, childId: child.id, stopReason, text: lines.join('\n') })
  }

  const endTurn = (child, stopReason, output) => {
    // 宿主 waiting 态：自己还有活着的子代理 → 不结算（notifySettlement 不触发）
    if (child.liveChildren > 0) {
      child.waiting = true
      child.pendingTerminal = { stopReason, output }
      return
    }
    child.settled = true
    child.endedAt = Date.now()
    notify(child, stopReason, output) // ← 先通知父代理
    dispatcherRef.current.onChildEnd(child.id, stopReason, output ?? null) // ← 再 subagent/end
  }

  const releaseChild = (parent) => {
    parent.liveChildren -= 1
    if (parent.waiting && parent.liveChildren === 0 && parent.pendingTerminal) {
      const { stopReason, output } = parent.pendingTerminal
      parent.waiting = false
      endTurn(parent, stopReason, output)
    }
  }

  const emitSubmitFailed = (child, step) => {
    const handlers = []
    ctx.emit('product-subagents/submit-failed', {
      childId: child.id,
      product: child.provider,
      code: step.code ?? null,
      message: step.message ?? '',
      grade: gradeSubmitFailure(step.code, step.message),
      onFailover: (h) => handlers.push(h),
    })
    return handlers
  }

  /** ACP relay 回合：product_submit 失败 → 走换档握手（v0.7.4 的阻塞裁决） */
  const relayTurn = async (child, step) => {
    // gate：让测试自己决定"何时发出 submit-failed"，从而能构造
    // 【两个首次 claim 并发抵达】的真实竞态（同一回合里两次 product_submit）。
    if (step.gate) await step.gate
    const handlers = emitSubmitFailed(child, step)
    let text = null
    if (step.grade !== 'fatal' && handlers.length > 0) {
      for (const handler of handlers) {
        const outcome = await handler({
          childId: child.id,
          product: child.provider,
          code: step.code ?? null,
          message: step.message ?? '',
          task: TASK,
        })
        if (outcome && typeof outcome.text === 'string' && outcome.text.trim()) {
          ctx.emit('product-subagents/submit-ok', { childId: child.id, product: child.provider, viaFailover: true })
          text = outcome.text
          break
        }
        if (outcome && outcome.handedOff) {
          // 编排层已换档并 interrupt 本档 ⇒ 宿主把本回合报成 aborted
          text = `【已换档】${step.code ?? ''} ${step.message}`
          child.handedOff = true
          break
        }
        if (outcome && outcome.exhausted) {
          text = `【任务失败】${outcome.message}`
          child.failed = { code: step.code ?? null, message: step.message ?? '', grade: 'failover' }
          break
        }
        if (outcome && outcome.timedOut) {
          // 复刻 product-submit.js v0.7.4 的真实文案拼装（含已试档 summary + 未换档说明）
          const detail = outcome.summary ? `${outcome.summary}；` : ''
          text = `【任务失败】${detail}${outcome.message ?? '换档未执行'}；本次提交按失败计`
          child.failed = { code: step.code ?? null, message: step.message ?? '', grade: 'failover' }
          break
        }
      }
    }
    if (text === null) {
      text = `【任务失败】${step.code ?? ''} ${step.message}`
      child.failed = { code: step.code ?? null, message: step.message ?? '', grade: step.grade ?? 'failover' }
    }
    endTurn(child, child.interrupted ? 'aborted' : 'completed', text)
  }

  const runTurn = async (child) => {
    const step = script[child.provider]
    if (!step) { endTurn(child, 'error', null); return }
    if (step.hold) await step.hold
    if (step.kind === 'ok') { endTurn(child, 'completed', step.text); return }
    if (step.kind === 'fail-then-error') {
      // 回合内换档已成功，随后 relay 回合本身以 stopReason='error' 结束
      const handlers = emitSubmitFailed(child, step)
      for (const handler of handlers) {
        const outcome = await handler({ childId: child.id, product: child.provider, code: step.code, message: step.message })
        if (outcome && typeof outcome.text === 'string' && outcome.text.trim()) {
          ctx.emit('product-subagents/submit-ok', { childId: child.id, product: child.provider, viaFailover: true })
          break
        }
        if (outcome && (outcome.handedOff || outcome.exhausted || outcome.timedOut)) break
      }
      endTurn(child, child.interrupted ? 'aborted' : 'error', step.tail ?? 'relay 回合在提交成功后崩了')
      return
    }
    if (!ACP_PROVIDERS.has(child.provider)) {
      // 宿主原生 spawn 档：失败只体现为 stopReason='error'，没有 product_submit 握手
      endTurn(child, child.interrupted ? 'aborted' : 'error', step.message)
      return
    }
    await relayTurn(child, step)
  }

  const ctx = {
    subagents: {
      getProvider: (name) => (ACP_PROVIDERS.has(name) ? { name } : undefined),
      startContinuable: async (spec) => {
        state.seq += 1
        const id = `child-${state.seq}`
        const parentId = spec.request.parent.session.id
        const provider = spec.provider === 'spawn'
          ? (spec.request.agentOptions?.provider ?? 'spawn')
          : spec.provider
        state.dispatches.push({
          childId: id,
          parentId,
          provider,
          depth: spec.request.agentOptions?.subagentDepth ?? null,
        })
        const child = {
          id, parentId, provider, liveChildren: 0, settled: false, waiting: false, interrupted: false,
        }
        children.set(id, child)
        // 宿主 subagentDepth：主代理之下新建的 child 一律 depth 1
        agents.set(id, {
          session: { id },
          options: { subagentDepth: parentId === 'main-1' ? 1 : 2 },
          status: 'idle',
          followup() {}, steer() {}, inject() {},
        })
        const parent = children.get(parentId)
        if (parent) parent.liveChildren += 1
        // 宿主语义：startContinuable 在"收件箱受理"即 resolve，回合启动是之后的异步步骤
        schedule(() => runTurn(child).then(() => { if (parent) releaseChild(parent) }))
        return { childId: id }
      },
      sendMessage: async (sender, targetId, content) => {
        const target = children.get(targetId)
        if (!target) throw new Error(`subagent "${targetId}" is not a direct child of "${sender.session.id}"`)
        if (target.parentId !== sender.session.id) {
          throw new Error(`subagent "${targetId}" belongs to another parent session (UNAUTHORIZED)`)
        }
        state.deliveries.push({ senderId: sender.session.id, targetId, text: content?.[0]?.text ?? '' })
        return { messageId: `msg-${state.deliveries.length}` }
      },
      // 宿主 interrupt：只置取消意图，**不**解开被阻塞的工具（调度器等 in-flight settle）
      interrupt: async (childId, authority) => {
        state.interrupts.push({ childId, authority })
        const child = children.get(childId)
        if (child) child.interrupted = true
        return { accepted: true }
      },
      drainChildren: async () => {},
    },
    get: (name) => (name === 'agents' ? { get: (id) => agents.get(id) } : undefined),
    emit: (name, payload) => {
      if (name === 'product-subagents/submit-ok') { dispatcherRef.current.markChildSubmitOk(payload); return }
      if (name === 'product-subagents/submit-failed' && typeof payload?.onFailover === 'function') {
        dispatcherRef.current.markChildSubmitFailed(payload)
        // 与 index.js:186-204 同一分流逻辑
        payload.onFailover((req) => {
          if (req && req.autoFallback === true) return dispatcherRef.current.handleSubmitFailover(req)
          const mode = typeof payload.failoverMode === 'string' ? payload.failoverMode : dispatcherRef.current.failoverMode
          if (mode === 'auto') return dispatcherRef.current.handleSubmitFailover(req)
          return dispatcherRef.current.handleSubmitFailoverNotify(req)
        })
      }
    },
  }

  const registry = {
    get: (id) => ({ id, name: '资深开发', emoji: '🛠️', systemPrompt: '你是资深开发。', reusePolicy: 'reuse' }),
    resolveRoutes: () => ROUTES.map((r) => ({ ...r })),
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-failover-'))
  const dispatcher = new Dispatcher({
    ctx, registry, dataDir, idleReleaseMs: 0,
    failoverMode, notifyWaitMs, failoverWaitMs,
  })
  dispatcherRef.current = dispatcher

  // 条目在结算时被删除，先 spy 下来供断言
  const entries = []
  const rawSet = dispatcher.activeChildren.set.bind(dispatcher.activeChildren)
  dispatcher.activeChildren.set = (key, value) => { entries.push(value); return rawSet(key, value) }
  const byAgentWrites = []
  const rawByAgentSet = dispatcher.byAgent.set.bind(dispatcher.byAgent)
  dispatcher.byAgent.set = (key, value) => { byAgentWrites.push([key, value]); return rawByAgentSet(key, value) }

  const drain = async () => {
    // 用【ref 过的】setTimeout 轮询（不能用裸 promise + unref 定时器）：
    // 编排层的 notifyWaitMs 定时器是 unref 的（不吊住宿主进程），若测试只挂裸
    // promise，事件循环会在超时定时器触发前就判定"无事可做"而提前收敛。
    for (let i = 0; i < 2000; i += 1) {
      if (state.running === 0) return
      await new Promise((resolve) => { setTimeout(resolve, 2) })
    }
    throw new Error('drain 未收敛：疑似换档死循环')
  }
  /** 轮询直到 cond 为真（宿主行为跨 tick 推进，测试不能假设同步） */
  const until = async (cond, { tries = 400, stepMs = 2 } = {}) => {
    for (let i = 0; i < tries; i += 1) {
      if (cond()) return true
      await new Promise((r) => { setTimeout(r, stepMs) })
    }
    return cond()
  }

  return {
    dispatcher, registry, ctx, parentAgent, children, entries, byAgentWrites,
    notices: state.notices, wakes: state.wakes, deliveries: state.deliveries,
    interrupts: state.interrupts, dispatches: state.dispatches,
    drain, until,
  }
}