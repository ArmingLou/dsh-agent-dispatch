/**
 * dsh-agent-dispatch —— Agent 派遣核心模块
 *
 * 本模块封装 DSH 宿主的 ctx.subagents 服务，负责把任务委派给"预置 Agent"
 * 可续聊子 agent，并处理模型路由互备与决策日志：
 *
 *   - dispatch()：取Agent 定义 → 构造任务文本 → 按 routes 优先级依次尝试
 *     ctx.subagents.startContinuable（provider 固定 'spawn'，maxDepth 按深度记账）；
 *     某 route 抛错时自动换下一个 route 重试（互备），全部失败抛出最后一个
 *     错误并附已尝试的 provider/model 列表。
 *   - 同角色子代理复用（v1.5.0）：Agent 的 reusePolicy 为 'reuse'（默认）时，
 *     同一父会话内同 Agent 复用同一个可续聊子代理——直接 sendMessage 续聊
 *     （驻留时 steer、已释放时冷恢复），不重复新建；'fresh'（探索型角色）
 *     每次都新建专属子代理。小队步骤 dedicatedChild=true 强制新建（并发安全）。
 *   - 空闲回收（v1.5.0）：子代理完成一轮（subagent/end）后进入空闲复用池，
 *     idleReleaseMs（默认 10 分钟）内未被复用则调用 ctx.subagents.drainChildren
 *     释放驻留 Activation（子代理降为 ready，持久会话保留，后续 sendMessage
 *     冷恢复续聊）——解决"子代理长时间不回收"。ACP 子代理的进程回收由
 *     dsh-plugin-product-subagents 的 idleTimeoutMs 负责，本模块不重复处理。
 *   - followup()：对已存在的Agent child 追问（v1.5.0 走 sendMessage——
 *     旧 ctx.subagents.followup 已从宿主删除，signal 为硬性字段）。
 *   - 递归护栏（v1.5.0）：宿主删除 registerContinuableSetup 后，护栏改为
 *     index.js 注册的全局 tools.guard（按 exec.agent.options.subagentDepth
 *     拒绝委派工具执行）+ 本模块 dispatch() 入口的硬检查（callerDepth>=1
 *     直接抛错）+ startContinuable toolFilter.deny（动态求交集——新宿主
 *     tools.restrict 对未知工具名 loud throw）三保险。
 *   - 决策日志：每次尝试追加一行到 dataDir/dispatches.jsonl，写盘失败仅
 *     console.error，不向上抛。
 *
 * 依赖：
 *   - ctx.subagents：宿主原生服务（startContinuable / sendMessage /
 *     drainChildren / interrupt / getProvider），无外部依赖；
 *   - ctx.tools：view(undefined).knownNames 用于动态 deny 名单求交集；
 *   - ctx.agents：drainChildren 需要"确切在线"的父 agent 引用；
 *   - registry：AgentRegistry 实例（lib/agents.js），提供 get(id) /
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
 * Agent的 systemPrompt 完整注入 persona，这里只放任务本体。
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

/**
 * 子代理禁止调用的委派/树管理工具候选名单（v1.5.0）。
 * 与旧版静态 deny 的区别：
 *   - 保留 send_message（子代理→父级回传结果，替代旧 report，宿主服务本身
 *     强制相邻关系，子代理只能发给直接父级）与 product_submit（ACP 中继）。
 *   - 名单在运行时与"子代理实际可见的工具"求交集（#safeDenyList），
 *     新宿主 tools.restrict() 对未知工具名 loud throw，静态名单会炸掉子代理创建。
 */
const DENY_CANDIDATES = [
  // 本插件委派工具（子代理再派下级会成本泄漏）
  'agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue',
  'agent_squad_upsert', 'agent_upsert', 'agent_import_skill',
  // 宿主通用子代理/编排工具
  'subagent', 'subagent_fork', 'subagent_progress', 'list_agents', 'interrupt_agent',
  'workflow', 'ralph', 'create_goal', 'get_goal', 'update_goal',
  // product-subagents 委派面（ACP 中继的 product_submit 除外）
  'product_delegate', 'product_wait', 'product_roles', 'product_agents',
]

/** 本插件自己注册的工具名（dispatch 前必然可见，属"own 层"补集） */
const OWN_TOOL_NAMES = [
  'agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue',
  'agent_squad_upsert', 'agent_upsert', 'agent_import_skill',
]

/** 空闲回收默认时长：子代理完成一轮后多久释放驻留 Activation（ms） */
const DEFAULT_IDLE_RELEASE_MS = 600000 // 10 分钟，与 product-subagents idleTimeoutMs 对齐

export class Dispatcher {
  /**
   * @param {object} opts
   * @param {object} opts.ctx        Cordis 上下文（必须含 ctx.subagents）
   * @param {object} opts.registry   AgentRegistry 实例（get / resolveRoutes）
   * @param {string} opts.dataDir    数据目录，决策日志写于此
   * @param {number} [opts.idleReleaseMs] 空闲回收时长（默认 10 分钟；0 关闭自动释放）
   */
  constructor({ ctx, registry, dataDir, idleReleaseMs = DEFAULT_IDLE_RELEASE_MS }) {
    this.ctx = ctx
    this.registry = registry
    this.dataDir = dataDir
    this.idleReleaseMs = Number.isFinite(idleReleaseMs) && idleReleaseMs > 0 ? idleReleaseMs : 0
    /**
     * v0.9.40：活跃子 agent 映射——childId → entry（entry.agentId 记录Agent）。
     * 旧版用 agentId 做 key：同Agent多步并发（如 dev-pipeline 的 S2/S6 都是 code-reviewer）
     * 互相覆盖，先派步骤的 entry 丢失 → onChildEnd 找不到匹配 → waiter 永不兑现 →
     * agent_squad 的 Promise.all 永挂（用户现场：6 步只出 3 卡、主代理卡死）。
     * 改 childId key 后多个子代理可并存；Agent复用续聊走 byAgent 二级索引（仅直接委派用）。
     */
    this.activeChildren = new Map()
    /** v0.9.40：agentId → childId 二级索引（同一Agent最新活跃 child，供 /agent-api/cancel 兜底） */
    this.byAgent = new Map()
    /**
     * v1.5.0：同角色子代理复用池——`${parentSessionId}::${agentId}` → entry。
     * entry = { key, childId, agentId, parentSessionId, lastUsedAt, releaseTimer }。
     * 与旧 byAgent 复用（仅活跃期）的区别：child 完成一轮后仍留在池中，
     * 下次 dispatch 直接 sendMessage（驻留 steer / 已释放冷恢复），上下文延续；
     * 空闲 idleReleaseMs 后 drainChildren 释放驻留（child 降为 ready）。
     */
    this.childPool = new Map()
    /** 正在被 dispatch 占用的池 key（同 key 并发 dispatch 串行化，防重复 sendMessage） */
    this.poolBusy = new Set()
    /**
     * v0.9.36：等待结果注册表 childId → { resolve, timer, agentId }
     * dispatch(waitResult:true) 挂起的 Promise 由 subagent/end 事件（onChildEnd）或超时兜底兑现。
     */
    this.waiters = new Map()
  }

  /**
   * 委派任务给Agent子 agent。
   *
   * 流程：
   *   1. 取Agent 定义，不存在抛 Error（中文）；
   *   2. 递归护栏硬检查：调用方 subagentDepth>=1 直接拒绝（三保险之一）；
   *   3. 同角色复用（reusePolicy='reuse' 且非 dedicatedChild）：复用池命中 →
   *      sendMessage 续聊（驻留 steer / 已释放冷恢复）；失败视为 child 失效，
   *      丢弃池条目后走新建流程；
   *   4. 新建：解析 routes——有 routes[0] 则 agentOptions 用其 provider/model
   *      连同 effort 透传（映射为宿主新字段 reasoningEffort，xhigh/max 底层钳到
   *      high，空=模型默认）；无 routes 则不传 agentOptions（继承父会话）；
   *   5. startContinuable 抛错时若有下一个 route 则换下一个重试（互备），
   *      全部失败抛出最后一个错误（附已尝试的 provider/model 列表）；
   *   6. 每次尝试（成功与失败）各记一行决策日志。
   *
   * @param {object} parentAgent           调用方 agent（工具调用时的 exec.agent）
   * @param {string} agentId              Agent id（kebab-case）
   * @param {string} task                  任务全文
   * @param {object} [opts]
   * @param {boolean} [opts.runInBackground=true] v1 无实际差异：
   *        startContinuable 本身就立即返回 childId、不阻塞执行，后台语义天然成立
   * @param {boolean} [opts.waitResult=false] v0.9.36/0.9.38：默认**不等待**（直接调 Agent 立即返回，
   *        主代理不阻塞）；仅 agent_squad 小队步骤显式传 true 等结果（结果级串行）。
   *        置 true 时等子 agent 真正结束取回结果文本（subagent/end lastAssistantMessage），
   *        超时（waitTimeoutMs）兜底。
   * @param {boolean} [opts.dedicatedChild=false] v0.9.40：强制新建专属子代理，跳过同Agent复用续聊。
   *        小队并发步骤必传——复用同一Agent会撞同一 child（followup 抢任务 + 孤儿等待器永久挂起，
   *        用户现场：6 步只出 3 卡、主代理卡死）。
   * @param {number} [opts.waitTimeoutMs=3600000] 等待结果超时（默认 1 小时，用户：10 分钟太短）
   * @returns {Promise<{agentId: string, agentName: string, childId: string, taskLabel: string, output: string|null, ok: boolean}>}
   */
  async dispatch(parentAgent, agentId, task, { runInBackground = true, viaSquad = null, squadRunId = null, stepIndex = null, totalSteps = null, waitResult = false, dedicatedChild = false, waitTimeoutMs = 3600000 } = {}) {
    void runInBackground // v1 语义见 JSDoc：startContinuable 天然后台，参数保留供工具层传递

    const agent = this.registry.get(agentId)
    if (!agent) {
      throw new Error(`Agent不存在: ${agentId}`)
    }

    // v1.4.1 递归护栏（硬）：子代理（subagentDepth>=1）不得再向下委派，必须自己完成。
    // v1.5.0：宿主删除 registerContinuableSetup 后此入口检查仍是最后一道物理闸
    //（tools.guard 与 toolFilter.deny 之外），防止低成本子代理把任务再派回付费模型。
    const callerDepth = parentAgent?.options?.subagentDepth ?? 0
    if (callerDepth >= 1) {
      throw new Error(
        `子代理深度 ${callerDepth} 禁止再向下委派：你必须自己完成被指派的任务；超出能力时明确说明卡在哪、需要什么，向上（父级）汇报，绝不调用 agent_dispatch/agent_squad/subagent/workflow 等再起新代理。`,
      )
    }

    const taskLabel = summarizeTask(task)
    const taskText = buildTaskText(task)
    const parentSessionId = parentAgent?.session?.id ?? null

    // ── v1.5.0 同角色复用：池命中且未被并发占用 → sendMessage 续聊 ──
    // 复用条件：非 dedicatedChild（小队步骤强制专属）+ reusePolicy 非 'fresh'
    //（探索型角色每次独立新开，避免上下文污染）。
    const reuseKey = `${parentSessionId}::${agentId}`
    const reusePolicy = agent.reusePolicy === 'fresh' ? 'fresh' : 'reuse'
    if (!dedicatedChild && reusePolicy !== 'fresh') {
      const pooled = this.childPool.get(reuseKey)
      if (pooled && !this.poolBusy.has(reuseKey)) {
        this.poolBusy.add(reuseKey)
        try {
          // sendMessage：驻留子代理 steer 到最近 step；已释放（ready）子代理
          // 自动冷恢复（持久会话保留全部上下文）。
          await this.followup(parentAgent, pooled.childId, taskText)
          // 续聊成功：取消空闲释放定时器、回写活跃映射（面板"运行中"）
          if (pooled.releaseTimer) {
            clearTimeout(pooled.releaseTimer)
            pooled.releaseTimer = null
          }
          pooled.lastUsedAt = Date.now()
          this.activeChildren.set(pooled.childId, {
            agentId,
            childId: pooled.childId,
            taskLabel,
            startedAt: Date.now(),
            parentSessionId: pooled.parentSessionId ?? parentSessionId,
            viaSquad: pooled.viaSquad ?? viaSquad ?? null,
            squadRunId: pooled.squadRunId ?? squadRunId ?? null,
          })
          this.byAgent.set(agentId, pooled.childId)
          this.#log({
            kind: 'dispatch',
            agentId,
            agentName: agent.name,
            childId: pooled.childId,
            provider: null,
            model: null,
            reused: true, // v1.5.0：历史页可区分"复用续聊"与"新建"
            taskLabel,
            parentSessionId: pooled.parentSessionId ?? parentSessionId,
            ok: true,
          })
          const output = waitResult
            ? await this.#waitFor(pooled.childId, waitTimeoutMs)
            : null
          return { agentId, agentName: agent.name, childId: pooled.childId, taskLabel, output, ok: true }
        } catch (err) {
          // 复用失败（child 已不可恢复/父级身份失效）→ 丢弃池条目，按新建流程重来
          this.#dropPool(reuseKey, err)
        } finally {
          this.poolBusy.delete(reuseKey)
        }
      }
    }

    // 互备路由：无 routes 时尝试一次（不传 agentOptions，继承父会话）
    const routes = this.registry.resolveRoutes(agentId)
    const candidates = routes.length > 0 ? routes : [null]
    const attempts = [] // 已尝试的 provider/model 列表，供最终报错展示
    let lastError = null

    for (const route of candidates) {
      // v1.4.0：ACP/subagent provider 路由——若 route.provider 是宿主已注册的
      // subagent provider（如 product-subagents 插件注册的 deveco ACP 服务，
      // 或 claude-code / codex 桥），走 ACP relay 模式（spec.provider 直接传
      // route.provider + product_submit 转发），而不是把它当 LLM 模型路由塞进
      // agentOptions——LLM 路由表里不存在该 provider，激活会报 NO_ADAPTER。
      // 判断依据：ctx.subagents.getProvider(name) 命中即 subagent provider。
      const subProvider = route ? this.ctx.subagents?.getProvider?.(route.provider) : undefined
      const acpMode = !!subProvider
      // v1.5.0：宿主 AgentOptions 字段为 reasoningEffort（旧 effort 字段已弃用）
      const agentOptions = route && !acpMode
        ? {
            provider: route.provider,
            model: route.model,
            ...(route.effort ? { reasoningEffort: route.effort } : {}),
          }
        : undefined
      if (route) attempts.push({ provider: route.provider, model: route.model })

      try {
        // spec.signal 是宿主 startContinuable 的硬性字段（continuation.js spec.signal.throwIfAborted()），
        // 缺失会抛 "Cannot read properties of undefined (reading 'throwIfAborted')"。
        const ac = new AbortController()
        // v0.9.16：宿主子代理会话标题带Agent 名前缀——better-sidebar「任务管理」/ 会话列表
        // 只能看到宿主 label，加上Agent 名才能认出是哪个 agent 在执行；日志 taskLabel 保持纯任务摘要不变
        // v0.9.35：小队步骤子代理 label 再拼「S{n}/{total}」——任务管理面板一眼看出这是小队第几步/共几步
        const squadMark = viaSquad && totalSteps != null && stepIndex != null
          ? ` [S${stepIndex + 1}/${totalSteps}]`
          : ''
        const childLabel = agent.name
          ? `${agent.name}${squadMark} · ${taskLabel}`
          : taskLabel
        // v1.4.0：ACP relay 模式构造——persona 拼接 agent.systemPrompt + 转发指示；
        // toolFilter 只放行 product_submit（与 product-subagents 的 relay 管道一致），
        // 物理阻断子代理在 ACP 模式下用其他工具；agentOptions 不传（ACP 服务自带模型配置）。
        const acpPersona = acpMode
          ? `${agent.systemPrompt}\n\n【ACP 执行模式】\n你是到 ${route.provider}（ACP CLI 代理）的中继。对每个收到的任务，调用 product_submit 把任务原样转发给 ${route.provider} 执行；${route.provider} 返回后，把它的回答如实转达给发起方。不要自己用本地工具完成任务，也不要调用其他工具。`
          : agent.systemPrompt
        // v1.5.0：非 ACP 模式的 deny 名单动态求交集（#safeDenyList）——
        // 新宿主 tools.restrict() 对未知工具名 loud throw（旧宿主无此校验，
        // 静态名单可用；新宿主下静态名单会把 product_delegate 等未加载工具
        // 名塞进 restrict → 子代理创建直接失败）。
        const deny = acpMode ? null : this.#safeDenyList()
        const { childId } = await this.ctx.subagents.startContinuable({
          provider: acpMode ? route.provider : 'spawn',
          label: childLabel,
          signal: ac.signal,
          request: {
            label: childLabel,
            prompt: [{ type: 'text', text: taskText }],
            parent: parentAgent,
            persona: acpPersona,
            ...(agentOptions ? { agentOptions } : {}), // 无 routes：缺省继承父会话
            ...(acpMode
              ? { toolFilter: { allow: ['product_submit'] } }
              : deny.length > 0
                ? { toolFilter: { deny } }
                : {}), // v1.1.2 递归护栏：子代理看不到委派工具，物理阻断再派下级；v1.2.0 加 agent_upsert 防子代理改注册表；v1.3.0 加 agent_squad_continue 防子代理续跑小队；v1.3.1 加 agent_squad_upsert 防子代理改小队注册表；v1.4.0 ACP 模式改用 allow 白名单；v1.4.1 扩展通用工具 deny 名单；v1.5.0 名单动态求交集 + send_message/product_submit 豁免
            maxDepth: Math.max(2, callerDepth + 1), // 委派深度记账；递归由 toolFilter.deny + tools.guard + dispatch 入口硬检查阻断
          },
        })
        // v0.9.40：childId 为主 key（多子代理并存）；byAgent 二级索引供 /agent-api/cancel 兜底
        this.activeChildren.set(childId, {
          agentId,
          childId,
          taskLabel,
          startedAt: Date.now(),
          parentSessionId, // cancel 时构造 user-authority 用
          viaSquad: viaSquad ?? null, // v0.9.32：小队发起存小队 id（悬浮球运行中聚合展示）
          squadRunId: squadRunId ?? null,
        })
        if (!dedicatedChild) this.byAgent.set(agentId, childId)
        // v1.5.0：非专属且非 fresh 的 child 登记进复用池（含小队步骤中非专属的——目前无此路径）
        if (!dedicatedChild && reusePolicy !== 'fresh') {
          this.childPool.set(reuseKey, {
            key: reuseKey,
            childId,
            agentId,
            parentSessionId,
            lastUsedAt: Date.now(),
            releaseTimer: null,
            viaSquad: viaSquad ?? null,
            squadRunId: squadRunId ?? null,
          })
        }
        this.#log({
          kind: 'dispatch',
          agentId,
          agentName: agent.name,
          childId,
          provider: acpMode ? route.provider : (agentOptions?.provider ?? null), // v1.4.0：ACP 模式记录 route.provider
          model: acpMode ? null : (agentOptions?.model ?? null),
          reused: false,
          taskLabel,
          taskText: taskText.slice(0, 4000), // v0.9.13：历史页任务详情（截断防膨胀）
          viaSquad, // v0.9.14：小队触发的委派带小队 id（历史页「类型」列）
          squadRunId, stepIndex, // v0.9.17：小队运行 id + 步骤序号（历史页执行流图）
          parentSessionId, // v0.8.4：历史页跳转主会话
          ok: true,
        })
        // v0.9.36：默认等子 agent 真正结束取回结果（subagent/end lastAssistantMessage）
        const output = waitResult
          ? await this.#waitFor(childId, waitTimeoutMs)
          : null
        return { agentId, agentName: agent.name, childId, taskLabel, output, ok: true }
      } catch (err) {
        lastError = err
        this.#log({
          kind: 'dispatch',
          agentId,
          agentName: agent.name,
          childId: null,
          provider: acpMode ? route.provider : (agentOptions?.provider ?? null), // v1.4.0：ACP 模式记录 route.provider
          model: acpMode ? null : (agentOptions?.model ?? null),
          reused: false,
          taskLabel,
          taskText: taskText.slice(0, 4000), // v0.9.13：历史页任务详情（截断防膨胀）
          viaSquad, // v0.9.14：小队触发的委派带小队 id（历史页「类型」列）
          squadRunId, stepIndex, // v0.9.17：小队运行 id + 步骤序号（历史页执行流图）
          parentSessionId, // v0.8.4：历史页跳转主会话
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
      `Agent ${agent.name}(${agentId}) 所有路由均失败，已尝试: ${tried}；最后一个错误: ${lastError?.message ?? '未知'}`,
    )
  }

  /**
   * 对已存在的Agent child 追问（续聊，上下文延续）。
   *
   * v1.5.0：宿主已删除 ctx.subagents.followup，改为 sendMessage——
   *   sendMessage(sender, targetId, content, { signal })：sender 为确切在线的
   *   调用方 agent（exec.agent），targetId 为直接子代理；驻留目标 steer 到最近
   *   step，空闲/冷状态目标自动冷恢复（持久会话）。signal 为硬性字段。
   *
   * @param {object} parentAgent 调用方 agent（exec.agent）
   * @param {string} childId     目标 child（来自 startContinuable 或复用池）
   * @param {string} message     追问消息全文
   * @returns {Promise<{childId: string}>}
   */
  async followup(parentAgent, childId, message) {
    const ac = new AbortController()
    await this.ctx.subagents.sendMessage(
      parentAgent,
      childId,
      [{ type: 'text', text: message }],
      { signal: ac.signal },
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
   * v1.5.0：child 完成一轮后若仍在复用池 → 排空闲释放定时器（idleReleaseMs 后
   * drainChildren 释放驻留 Activation，child 降为 ready 仍可冷恢复复用）。
   * @param {string} childId      终结的 child session id
   * @param {string} stopReason   completed / aborted / error（宿主 dsh-subagent 契约）
   * @param {string|null} lastAssistantMessage 子代理最后输出文本（subagent/end 事件字段）
   */
  onChildEnd(childId, stopReason, lastAssistantMessage) {
    if (!childId) return
    // v0.9.40：childId 直查（旧版遍历 agentId key，同Agent并发覆盖时先派步骤找不到 → 卡死）
    const entry = this.activeChildren.get(childId)
    if (!entry) return // 不是本插件派遣的（或其他来源的 subagent），忽略
    this.activeChildren.delete(childId)
    if (this.byAgent.get(entry.agentId) === childId) this.byAgent.delete(entry.agentId)
    const agent = this.registry.get(entry.agentId)
    const norm = this.#normOutput(lastAssistantMessage)
    // 补记真实执行结果行（kind:'result'，与派遣行 kind:'dispatch' 区分）
    this.#log({
      kind: 'result',
      agentId: entry.agentId,
      agentName: agent?.name ?? entry.agentId,
      emoji: agent?.emoji ?? '',
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
    // v1.5.0：空闲回收——child 完成一轮且仍在复用池 → 排释放定时器
    this.#scheduleReleaseFor(childId)
  }

  /**
   * v1.5.0：为指定 childId 排空闲释放定时器（若该 child 在复用池中）。
   * 定时器触发时调用宿主 ctx.subagents.drainChildren 释放驻留 Activation——
   * 子代理降为 ready（持久会话保留），下次 sendMessage 冷恢复续聊，上下文不丢。
   * 复用（followup 成功）会取消定时器。idleReleaseMs=0 时关闭自动释放。
   */
  #scheduleReleaseFor(childId) {
    if (this.idleReleaseMs <= 0) return
    for (const pooled of this.childPool.values()) {
      if (pooled.childId !== childId) continue
      if (pooled.releaseTimer) clearTimeout(pooled.releaseTimer)
      pooled.releaseTimer = setTimeout(() => {
        pooled.releaseTimer = null
        this.#releasePooled(pooled)
      }, this.idleReleaseMs)
      pooled.releaseTimer.unref?.()
      return
    }
  }

  /**
   * v1.5.0：释放一个复用池条目的【驻留 Activation】——drainChildren 把驻留的
   * 子代理 Agent 交给宿主回收（内存/注册表槽位释放），子代理降为 ready。
   * 注意：池条目【保留】——ready 子代理的持久会话还在，后续 sendMessage 会
   * 自动冷恢复（上下文不丢），这正是"复用 + 回收"共存的关键。
   * 父 agent 已不在线（会话已结束）时不再调用 drainChildren：宿主在父级
   * teardown 时已递归回收整个 lineage，这里只清插件侧状态。
   */
  async #releasePooled(pooled) {
    if (this.childPool.get(pooled.key) !== pooled) return
    if (pooled.releaseTimer) { clearTimeout(pooled.releaseTimer); pooled.releaseTimer = null }
    if (this.byAgent.get(pooled.agentId) === pooled.childId) this.byAgent.delete(pooled.agentId)
    if (this.activeChildren.has(pooled.childId)) return // 释放瞬间又被复用/运行中，让位
    try {
      const agents = this.ctx.get?.('agents')
      const parent = agents?.get?.(pooled.parentSessionId)
      // v1.5.0：宿主公开的释放 API 是 drainContinuableChildren（drainChildren 未暴露）
      if (parent && typeof this.ctx.subagents.drainContinuableChildren === 'function') {
        await this.ctx.subagents.drainContinuableChildren(parent, [pooled.childId])
        console.log(`[dsh-agent-dispatch] 已释放空闲子代理 ${pooled.childId}（${pooled.agentId}）的驻留资源，会话保留可冷恢复复用`)
      }
    } catch (err) {
      // 子代理已消失/父级身份失效：harness 自行处理，忽略
      if (String(err?.message || err).includes('UNAUTHORIZED')) return
      console.error(`[dsh-agent-dispatch] 释放子代理 ${pooled.childId} 失败:`, err?.message ?? err)
    }
  }

  /**
   * v1.5.0：丢弃一个复用池条目（复用失败/父会话结束/插件卸载）。
   * 注意：丢弃不等于释放驻留——驻留回收仍由 idle 定时器或宿主 lineage 回收负责。
   */
  #dropPool(reuseKey, err) {
    const pooled = this.childPool.get(reuseKey)
    if (!pooled) return
    if (pooled.releaseTimer) clearTimeout(pooled.releaseTimer)
    this.childPool.delete(reuseKey)
    if (this.byAgent.get(pooled.agentId) === pooled.childId) this.byAgent.delete(pooled.agentId)
    if (err) {
      console.error(`[dsh-agent-dispatch] 复用子代理 ${pooled.childId} 失败，将新建:`, err?.message ?? err)
    }
  }

  /**
   * v1.5.0：父会话结束时清理其全部复用池条目（session/disposed 事件触发）。
   * 宿主在会话/agent teardown 时已递归回收该 lineage 的子代理，这里只清插件侧状态。
   * @param {string} parentSessionId
   */
  purgeParent(parentSessionId) {
    if (!parentSessionId) return
    for (const [key, pooled] of [...this.childPool.entries()]) {
      if (pooled.parentSessionId !== parentSessionId) continue
      if (pooled.releaseTimer) clearTimeout(pooled.releaseTimer)
      this.childPool.delete(key)
      if (this.byAgent.get(pooled.agentId) === pooled.childId) this.byAgent.delete(pooled.agentId)
    }
  }

  /**
   * v1.5.0：插件卸载清理——清空全部复用池定时器与映射。
   * 驻留子代理的回收由宿主在插件 scope teardown 时统一处理（continuation drain）。
   */
  dispose() {
    for (const pooled of this.childPool.values()) {
      if (pooled.releaseTimer) clearTimeout(pooled.releaseTimer)
    }
    this.childPool.clear()
    this.poolBusy.clear()
  }

  /**
   * v1.5.0：动态 deny 名单——候选名单 ∩（宿主全局已知工具 ∪ 本插件自有工具）。
   * 新宿主 tools.restrict() 在子代理创建窗口内校验名单：未知工具名 loud throw，
   * 静态名单会把"未加载的插件工具名"（如 product_delegate）塞进 restrict 导致
   * 子代理创建直接失败。求交集后剩余名单必然可 restrict；跨插件工具（如
   * product_delegate）即便不在 deny 名单，也会被 index.js 的全局 tools.guard
   * （subagentDepth>=1）执行期拒绝——可见性 + 执行期双保险。
   * @returns {string[]}
   */
  #safeDenyList() {
    const known = new Set()
    try {
      const view = this.ctx.tools?.view?.(undefined)
      if (view?.knownNames) {
        for (const n of view.knownNames) known.add(n)
      }
    } catch { /* 老宿主无 view()：退化为空名单（执行期守卫兜底） */ }
    for (const n of OWN_TOOL_NAMES) known.add(n)
    return DENY_CANDIDATES.filter((n) => known.has(n))
  }

  /**
   * v0.9.38：把 subagent/end 的 lastAssistantMessage 归一化为纯文本。
   * 宿主该字段形态不稳定：字符串 / 消息块数组（[{type:'text',text:'..'},...]）/
   * null。数组若原样透传，下游 .trim() 抛 TypeError（用户现场：agent_dispatch
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
