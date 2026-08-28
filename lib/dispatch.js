/**
 * dsh-agent-dispatch —— 专家派遣核心模块
 *
 * 本模块封装 DSH 宿主的 ctx.subagents 服务，负责把任务委派给"预置专家"
 * 可续聊子 agent，并处理模型路由互备与决策日志：
 *
 *   - dispatch()：取专家定义 → 构造任务文本 → 按 routes 优先级依次尝试
 *     ctx.subagents.startContinuable（provider 固定 'spawn'，maxDepth 1）；
 *     某 route 抛错时自动换下一个 route 重试（互备），全部失败抛出最后一个
 *     错误并附已尝试的 provider/model 列表。同一专家已有活跃 child 时复用
 *     旧 child 走 followup 续聊，不重复新建。
 *   - followup()：对已存在的专家 child 追问，上下文延续。
 *   - 决策日志：每次尝试追加一行到 dataDir/dispatches.jsonl，写盘失败仅
 *     console.error，不向上抛。
 *
 * 依赖：
 *   - ctx.subagents：宿主原生服务（startContinuable / followup），无外部依赖；
 *   - registry：ExpertRegistry 实例（lib/experts.js），提供 get(id) /
 *     resolveRoutes(id)。
 *
 * 纯 JavaScript ESM 模块，仅使用 node:fs / node:path，无外部依赖。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 决策日志文件名（追加写，每行一条 JSON） */
const LOG_FILE = 'dispatches.jsonl'

/**
 * 构造任务文本：把原始任务包装成"任务 + 输出要求"两段式。
 * 专家的 systemPrompt 完整注入 persona，这里只放任务本体。
 */
function buildTaskText(task) {
  return `【任务】\n${task}\n\n【输出要求】\n完成后输出结构化结论；如需用户提供更多信息，明确列出问题清单。`
}

/**
 * 从任务原文提取短标签（首个非空行，压缩空白并截断），
 * 用于 startContinuable 的 label 与决策日志 taskLabel。
 */
function summarizeTask(task, max = 40) {
  const raw = String(task ?? '')
  const line = raw
    .split('\n')
    .map((s) => s.trim())
    .find((s) => s.length > 0)
  if (!line) return ''
  const compact = line.replace(/\s+/g, ' ')
  return compact.length > max ? `${compact.slice(0, max)}…` : compact
}

export class Dispatcher {
  /**
   * @param {object} opts
   * @param {object} opts.ctx        Cordis 上下文（必须含 ctx.subagents）
   * @param {object} opts.registry   ExpertRegistry 实例（get / resolveRoutes）
   * @param {string} opts.dataDir    数据目录，决策日志写于此
   */
  constructor({ ctx, registry, dataDir }) {
    this.ctx = ctx
    this.registry = registry
    this.dataDir = dataDir
    /**
     * v0.9.40：活跃子 agent 映射——childId → entry（entry.expertId 记录专家）。
     * 旧版用 expertId 做 key：同专家多步并发（如 dev-pipeline 的 S2/S6 都是 code-reviewer）
     * 互相覆盖，先派步骤的 entry 丢失 → onChildEnd 找不到匹配 → waiter 永不兑现 →
     * expert_squad 的 Promise.all 永挂（用户现场：6 步只出 3 卡、主代理卡死）。
     * 改 childId key 后多个子代理可并存；专家复用续聊走 byExpert 二级索引（仅直接委派用）。
     */
    this.activeChildren = new Map()
    /** v0.9.40：expertId → childId 二级索引（同一专家最新活跃 child，供复用续聊） */
    this.byExpert = new Map()
    /**
     * v0.9.36：等待结果注册表 childId → { resolve, timer, expertId }
     * dispatch(waitResult:true) 挂起的 Promise 由 subagent/end 事件（onChildEnd）或超时兜底兑现。
     */
    this.waiters = new Map()
  }

  /**
   * 委派任务给专家子 agent。
   *
   * 流程：
   *   1. 取专家定义，不存在抛 Error（中文）；
   *   2. 同一专家已有活跃 child → 复用旧 child 走 followup 续聊（续聊失败
   *      视为 child 失效，清映射后走新建流程）；
   *   3. 解析 routes：有 routes[0] 则 agentOptions 用其 provider/model
   *      连同 effort 透传（xhigh/max 底层钳到 high，空=模型默认）；无 routes 则不传 agentOptions（继承父会话）；
   *   4. startContinuable 抛错时若有下一个 route 则换下一个重试（互备），
   *      全部失败抛出最后一个错误（附已尝试的 provider/model 列表）；
   *   5. 每次尝试（成功与失败）各记一行决策日志。
   *
   * @param {object} parentAgent           调用方 agent（工具调用时的 exec.agent）
   * @param {string} expertId              专家 id（kebab-case）
   * @param {string} task                  任务全文
   * @param {object} [opts]
   * @param {boolean} [opts.runInBackground=true] v1 无实际差异：
   *        startContinuable 本身就立即返回 childId、不阻塞执行，后台语义天然成立
   * @param {boolean} [opts.waitResult=false] v0.9.36/0.9.38：默认**不等待**（直接调 Agent 立即返回，
   *        主代理不阻塞）；仅 expert_squad 小队步骤显式传 true 等结果（结果级串行）。
   *        置 true 时等子 agent 真正结束取回结果文本（subagent/end lastAssistantMessage），
   *        超时（waitTimeoutMs）兜底。
   * @param {boolean} [opts.dedicatedChild=false] v0.9.40：强制新建专属子代理，跳过同专家复用续聊。
   *        小队并发步骤必传——复用同一专家会撞同一 child（followup 抢任务 + 孤儿等待器永久挂起，
   *        用户现场：6 步只出 3 卡、主代理卡死）。
   * @param {number} [opts.waitTimeoutMs=3600000] 等待结果超时（默认 1 小时，用户：10 分钟太短）
   * @returns {Promise<{expertId: string, expertName: string, childId: string, taskLabel: string, output: string|null, ok: boolean}>}
   */
  async dispatch(parentAgent, expertId, task, { runInBackground = true, viaSquad = null, squadRunId = null, stepIndex = null, totalSteps = null, waitResult = false, dedicatedChild = false, waitTimeoutMs = 3600000 } = {}) {
    void runInBackground // v1 语义见 JSDoc：startContinuable 天然后台，参数保留供工具层传递

    const expert = this.registry.get(expertId)
    if (!expert) {
      throw new Error(`专家不存在: ${expertId}`)
    }

    const taskLabel = summarizeTask(task)
    const taskText = buildTaskText(task)

    // 同一专家已有活跃 child：复用续聊，把任务作为消息发过去，不新建
    // v0.9.40：byExpert 二级索引（expertId → childId）替代旧的 expertId 主 key；
    // dedicatedChild=true（小队步骤）跳过复用，强制新建专属子代理
    const existingChildId = dedicatedChild ? undefined : this.byExpert.get(expertId)
    const existingEntry = existingChildId ? this.activeChildren.get(existingChildId) : undefined
    if (existingChildId && existingEntry) {
      try {
        await this.followup(parentAgent, existingChildId, taskText)
        this.#log({
          kind: 'dispatch',
          expertId,
          expertName: expert.name,
          childId: existingChildId,
          provider: null,
          model: null,
          taskLabel,
          parentSessionId: existingEntry.parentSessionId ?? parentAgent?.session?.id ?? null, // v0.8.4：历史页跳转主会话
          ok: true,
        })
        // v0.7.1：续聊重置 startedAt 为本次续聊时间——面板"运行中"时长应反映当前任务，
        // 而不是子 agent 诞生时间（否则休息 2 小时后追问会显示"运行中 2h"）
        // v0.9.32：存 viaSquad/squadRunId——悬浮球运行中分区按小队聚合展示需要
        // v0.9.40：以 childId 为主 key 回写（专家索引同步指向该 child）
        this.activeChildren.set(existingChildId, {
          expertId,
          childId: existingChildId,
          taskLabel,
          startedAt: Date.now(),
          parentSessionId: existingEntry.parentSessionId ?? parentAgent?.session?.id ?? null,
          viaSquad: existingEntry.viaSquad ?? viaSquad ?? null,
          squadRunId: existingEntry.squadRunId ?? squadRunId ?? null,
        })
        this.byExpert.set(expertId, existingChildId)
        // v0.9.36：续聊同样默认等结果
        const output = waitResult
          ? await this.#waitFor(existingChildId, waitTimeoutMs)
          : null
        return { expertId, expertName: expert.name, childId: existingChildId, taskLabel, output, ok: true }
      } catch (err) {
        // 续聊失败（child 可能已结束）→ 清映射，按新建流程重来
        this.activeChildren.delete(existingChildId)
        this.byExpert.delete(expertId)
      }
    }

    // 互备路由：无 routes 时尝试一次（不传 agentOptions，继承父会话）
    const routes = this.registry.resolveRoutes(expertId)
    const candidates = routes.length > 0 ? routes : [null]
    const attempts = [] // 已尝试的 provider/model 列表，供最终报错展示
    let lastError = null

    for (const route of candidates) {
      // effort 透传（pi-ai 规整：xhigh/max 钳到 high；空 = 模型默认）
      const agentOptions = route
        ? {
            provider: route.provider,
            model: route.model,
            ...(route.effort ? { effort: route.effort } : {}),
          }
        : undefined
      if (route) attempts.push({ provider: route.provider, model: route.model })

      try {
        // spec.signal 是宿主 startContinuable 的硬性字段（continuation.js spec.signal.throwIfAborted()），
        // 缺失会抛 "Cannot read properties of undefined (reading 'throwIfAborted')"。
        const ac = new AbortController()
        // v0.9.16：宿主子代理会话标题带专家名前缀——better-sidebar「任务管理」/ 会话列表
        // 只能看到宿主 label，加上专家名才能认出是哪个 agent 在执行；日志 taskLabel 保持纯任务摘要不变
        // v0.9.35：小队步骤子代理 label 再拼「S{n}/{total}」——任务管理面板一眼看出这是小队第几步/共几步
        const squadMark = viaSquad && totalSteps != null && stepIndex != null
          ? ` [S${stepIndex + 1}/${totalSteps}]`
          : ''
        const childLabel = expert.name
          ? `${expert.name}${squadMark} · ${taskLabel}`
          : taskLabel
        const { childId } = await this.ctx.subagents.startContinuable({
          provider: 'spawn',
          label: childLabel,
          signal: ac.signal,
          request: {
            label: childLabel,
            prompt: [{ type: 'text', text: taskText }],
            parent: parentAgent,
            persona: expert.systemPrompt,
            ...(agentOptions ? { agentOptions } : {}), // 无 routes：缺省继承父会话
            maxDepth: Math.max(2, (parentAgent?.options?.subagentDepth ?? 0) + 1), // 专家不派下级；2 容许自身已是子代理的调用方（孙代链）
          },
        })
        // v0.9.40：childId 为主 key（多子代理并存）；byExpert 二级索引供直接委派复用续聊
        this.activeChildren.set(childId, {
          expertId,
          childId,
          taskLabel,
          startedAt: Date.now(),
          parentSessionId: parentAgent?.session?.id ?? null, // cancel 时构造 user-authority 用
          viaSquad: viaSquad ?? null, // v0.9.32：小队发起存小队 id（悬浮球运行中聚合展示）
          squadRunId: squadRunId ?? null,
        })
        if (!dedicatedChild) this.byExpert.set(expertId, childId)
        this.#log({
          kind: 'dispatch',
          expertId,
          expertName: expert.name,
          childId,
          provider: agentOptions?.provider ?? null,
          model: agentOptions?.model ?? null,
          taskLabel,
          taskText: taskText.slice(0, 4000), // v0.9.13：历史页任务详情（截断防膨胀）
          viaSquad, // v0.9.14：小队触发的委派带小队 id（历史页「类型」列）
          squadRunId, stepIndex, // v0.9.17：小队运行 id + 步骤序号（历史页执行流图）
          parentSessionId: parentAgent?.session?.id ?? null, // v0.8.4：历史页跳转主会话
          ok: true,
        })
        // v0.9.36：默认等子 agent 真正结束取回结果（subagent/end lastAssistantMessage）
        const output = waitResult
          ? await this.#waitFor(childId, waitTimeoutMs)
          : null
        return { expertId, expertName: expert.name, childId, taskLabel, output, ok: true }
      } catch (err) {
        lastError = err
        this.#log({
          kind: 'dispatch',
          expertId,
          expertName: expert.name,
          childId: null,
          provider: agentOptions?.provider ?? null,
          model: agentOptions?.model ?? null,
          taskLabel,
          taskText: taskText.slice(0, 4000), // v0.9.13：历史页任务详情（截断防膨胀）
          viaSquad, // v0.9.14：小队触发的委派带小队 id（历史页「类型」列）
          squadRunId, stepIndex, // v0.9.17：小队运行 id + 步骤序号（历史页执行流图）
          parentSessionId: parentAgent?.session?.id ?? null, // v0.8.4：历史页跳转主会话
          ok: false,
          error: err.message,
        })
        // 还有下一个 route 则继续循环重试；循环结束自然落入全部失败分支
      }
    }

    // 全部尝试失败：抛出最后一个错误，附已尝试的 provider/model 列表
    const tried =
      attempts.length > 0
        ? attempts.map((a) => `${a.provider}/${a.model}`).join(', ')
        : '（无 routes，继承父会话）'
    throw new Error(
      `专家 ${expert.name}(${expertId}) 所有路由均失败，已尝试: ${tried}；最后一个错误: ${lastError?.message ?? '未知'}`,
    )
  }

  /**
   * 对已存在的专家 child 追问（续聊，上下文延续）。
   *
   * @param {object} parentAgent 调用方 agent（exec.agent）
   * @param {string} childId     目标 child（来自 startContinuable 或 activeChildren）
   * @param {string} message     追问消息全文
   * @returns {Promise<{childId: string}>}
   */
  async followup(parentAgent, childId, message) {
    await this.ctx.subagents.followup(
      parentAgent,
      childId,
      [{ type: 'text', text: message }],
      { source: 'tool' },
    )
    return { childId }
  }

  /**
   * v0.9.36：等待子 agent 结束并取回结果文本。
   * 挂起 Promise 存 waiters（childId → { resolve, timer }），由 onChildEnd 兑现；
   * 超时（默认 1 小时）兜底返回占位文本，不让调用方无限挂起。
   * @param {string} childId
   * @param {number} timeoutMs
   * @returns {Promise<string|null>} 结果文本；超时返回「（等待结果超时）」；child 未产出消息返回 null
   */
  #waitFor(childId, timeoutMs) {
    if (!childId) return Promise.resolve(null)
    // 已在等待（同一 child 并发 dispatch）→ 复用同一 Promise，避免悬挂
    const existing = this.waiters.get(childId)
    if (existing) return existing.promise
    const waiter = {}
    waiter.promise = new Promise((resolve) => {
      waiter.resolve = resolve
      waiter.timer = setTimeout(() => {
        this.waiters.delete(childId)
        resolve('（等待结果超时）')
      }, timeoutMs)
    })
    this.waiters.set(childId, waiter)
    return waiter.promise
  }

  /**
   * v0.7.1：子 agent 生命周期终结回调（由 index.js 订阅宿主 'subagent/end' 事件调用）。
   * 修复根因：activeChildren 此前只在派遣时 set，正常完成的 child 永远留在映射，
   * 导致活动面板永远"运行中"、FAB 完成检测（集合差）永远不触发。
   * v0.9.36：顺带兑现 waiters——dispatch(waitResult:true) 挂起的 Promise 在这里拿到
   * lastAssistantMessage（子代理最后一条非空 assistant 消息）与 stopReason。
   * @param {string} childId      终结的 child session id
   * @param {string} stopReason   completed / aborted / error（宿主 dsh-subagent 契约）
   * @param {string|null} lastAssistantMessage 子代理最后输出文本（subagent/end 事件字段）
   */
  /**
   * v0.9.38：把 subagent/end 的 lastAssistantMessage 归一化为纯文本。
   * 宿主该字段形态不稳定：字符串 / 消息块数组（[{type:'text',text:'..'},...]）/
   * null。数组若原样透传，下游 .trim() 抛 TypeError（用户现场：expert_dispatch
   * 报 'value.output' is not a declared property、小队步骤卡死）。
   */
  #normOutput(msg) {
    if (msg == null) return null
    if (typeof msg === 'string') return msg
    if (Array.isArray(msg)) {
      const parts = []
      for (const m of msg) {
        if (m == null) continue
        if (typeof m === 'string') { parts.push(m); continue }
        if (typeof m === 'object') {
          const t = m.text ?? m.content ?? m.value
          if (typeof t === 'string') parts.push(t)
        }
      }
      return parts.join('\n') || null
    }
    return String(msg)
  }

  onChildEnd(childId, stopReason, lastAssistantMessage) {
    if (!childId) return
    // v0.9.40：childId 直查（旧版遍历 expertId key，同专家并发覆盖时先派步骤找不到 → 卡死）
    const entry = this.activeChildren.get(childId)
    if (!entry) return // 不是本插件派遣的（或其他来源的 subagent），忽略
    this.activeChildren.delete(childId)
    if (this.byExpert.get(entry.expertId) === childId) this.byExpert.delete(entry.expertId)
    const expert = this.registry.get(entry.expertId)
    const norm = this.#normOutput(lastAssistantMessage)
    // 补记真实执行结果行（kind:'result'，与派遣行 kind:'dispatch' 区分）
    this.#log({
      kind: 'result',
      expertId: entry.expertId,
      expertName: expert?.name ?? entry.expertId,
      emoji: expert?.emoji ?? '',
      childId,
      taskLabel: entry.taskLabel ?? '',
      parentSessionId: entry.parentSessionId ?? null, // v0.8.4：历史页跳转主会话
      stopReason: stopReason ?? 'completed',
      ok: (stopReason ?? 'completed') === 'completed',
      output: norm ? norm.slice(0, 4000) : null, // v0.9.36：结果文本入日志（v0.9.38 归一化）
    })
    // v0.9.36：兑现等待者（若有）——completed 返回结果文本；非 completed 返回失败占位
    const w = this.waiters.get(childId)
    if (w) {
      clearTimeout(w.timer)
      this.waiters.delete(childId)
      const ok = (stopReason ?? 'completed') === 'completed'
      w.resolve(ok ? norm : `（步骤失败: ${stopReason ?? 'unknown'}）`)
    }
  }

  /**
   * 追加一行决策日志到 dataDir/dispatches.jsonl。
   * 写盘失败不抛：catch 后 console.error，不影响主流程。
   */
  #log(row) {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...row }) + '\n'
    try {
      fs.mkdirSync(this.dataDir, { recursive: true })
      fs.appendFileSync(path.join(this.dataDir, LOG_FILE), line, 'utf8')
    } catch (err) {
      console.error('[dsh-agent-dispatch] 决策日志写盘失败:', err.message)
    }
  }

  /**
   * v0.9.17：写一行小队运行日志（kind:'squad-run'）。
   * start：拓扑快照（步骤+依赖+名称），供历史页重绘执行流图。
   * end：各步终态（status: done/failed/skipped/running/waiting）。
   */
  logSquadRun(row) {
    this.#log(row)
  }
}
