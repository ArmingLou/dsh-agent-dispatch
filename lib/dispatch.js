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
import { randomUUID } from 'node:crypto'
import { ProviderHealth } from './health.js'

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
  'agent_squad_upsert', 'agent_upsert', 'agent_import_skill', 'agent_close', 'agent_children',
  // 宿主通用子代理/编排工具
  'subagent', 'subagent_fork', 'subagent_progress', 'list_agents', 'interrupt_agent',
  'workflow', 'ralph', 'create_goal', 'get_goal', 'update_goal',
  // product-subagents 委派面（ACP 中继的 product_submit 除外）
  'product_delegate', 'product_wait', 'product_roles', 'product_agents',
]

/** 本插件自己注册的工具名（dispatch 前必然可见，属"own 层"补集） */
const OWN_TOOL_NAMES = [
  'agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue',
  'agent_squad_upsert', 'agent_upsert', 'agent_import_skill', 'agent_close', 'agent_children',
]

/** 空闲回收默认时长：子代理完成一轮后多久释放驻留 Activation（ms） */
const DEFAULT_IDLE_RELEASE_MS = 600000 // 10 分钟，与 product-subagents idleTimeoutMs 对齐

/**
 * v1.5.1：每 (父会话, Agent) 复用池保留的子代理上限（多线程 LRU）。
 * 超过上限按最近使用时间淘汰最旧 child（淘汰即失去复用资格；驻留资源由宿主
 * settled 自动回收，不再额外 drain）。
 */
const POOL_CAP = 3

/** v1.5.4：非复用池（fresh 策略/小队专属）已完成线程的历史记录上限（全局） */
const COMPLETED_FRESH_CAP = 50

/** 每个 child 在池中保留的最近任务文本数（延续性启发式的比对语料） */
const LAST_TASKS_CAP = 2
/** 存入池的任务文本截断长度（防内存膨胀） */
const LAST_TASK_MAX_LEN = 500

/**
 * v1.5.1：续写标记词——新任务命中任一标记即视为"上一任务的延续"（强制复用）。
 * 中文优先精确短语，避免单字误伤；英文全小写匹配。
 */
const CONTINUATION_MARKERS = [
  '继续', '接着', '追加', '补充', '在此基础上', '接下来', '下一步', '上一步',
  '上次', '刚才', '之前', '前面', '上述', '上面', '同上', '按之前', '继续刚才',
  '之前说的', '刚才的', '上一步的', '再查', '再分析', '再检查', '再优化', '再完善',
  '继续做', '继续写', '继续改', '继续修', '继续审查', '继续排查', '接着做', '接着写',
  '接着改', '接着修', '还有', '另外', '再', '然后', '同样', '照旧', '如前',
  '同上次', '和上次一样', '和之前一样',
  'continue', 'continuing', 'follow-up', 'followup', 'further', 'as before',
  'same as', 'keep going', 'one more', 'revise', 'refine', 'on top of',
  'iterate', 'extend', 'again', 'likewise', 'similarly',
]

/** ASCII 停用词（不参与词汇重叠判定） */
const ASCII_STOP = new Set([
  'the', 'and', 'for', 'with', 'from', 'this', 'that', 'then', 'next', 'also',
  'but', 'not', 'you', 'your', 'please', 'help', 'need', 'want', 'would',
  'should', 'could', 'have', 'has', 'had', 'will', 'was', 'were', 'are', 'is',
  'it', 'its', 'we', 'our', 'they', 'them', 'their', 'there', 'here', 'when',
  'what', 'which', 'who', 'how', 'why', 'into', 'onto', 'about', 'after',
  'before', 'during', 'while', 'each', 'every', 'some', 'any', 'all', 'one',
  'two', 'new', 'old', 'get', 'set', 'make', 'use', 'using', 'used', 'like',
  'just', 'can', 'could', 'will', 'would', 'should', 'must', 'may', 'might',
  'does', 'did', 'done', 'doing', 'do', 'be', 'been', 'being', 'am',
])

/**
 * v1.5.1：提取文本的"显著词汇"集合——文件路径/文件名、ASCII 标识符（≥3 字符，
 * 去停用词）、CJK 双字词（相邻两字滑动窗口）。用于延续性重叠判定。
 */
function significantTokens(text) {
  const set = new Set()
  const t = String(text || '')
  // 路径 / 文件名（含扩展名）
  for (const m of t.matchAll(/[A-Za-z0-9_\-./\\]{2,}\.[A-Za-z]{1,6}\b/g)) {
    const p = m[0].toLowerCase()
    set.add(p)
    const base = p.split(/[\\/]/).pop()
    if (base && base.length >= 3) set.add(base)
  }
  // ASCII 标识符
  for (const m of t.matchAll(/[A-Za-z][A-Za-z0-9_\-]{2,}/g)) {
    const w = m[0].toLowerCase()
    if (ASCII_STOP.has(w) || /^[\d\-]+$/.test(w)) continue
    set.add(w)
  }
  // CJK 双字词（滑动窗口）
  const cjk = t.match(/[\u4e00-\u9fff]{2,}/g) || []
  for (const seg of cjk) {
    for (let i = 0; i + 1 < seg.length; i++) set.add(seg.slice(i, i + 2))
  }
  return set
}

/**
 * v1.5.1：延续性打分——0 = 独立新任务（应新开子代理）；分值 = 续写标记词（+1）+
 * 词汇重叠（+2，文件路径/标识符/CJK 双字词命中即得）。
 * 组合语义：3 = 标记词+重叠（强延续）；2 = 仅重叠；1 = 仅标记词（"继续"无具体指向
 * 时按最近使用兜底）；0 = 独立新任务。比对对象是池中该 child 的最近任务文本（lastTasks）。
 * 注意：比对用【原始任务】而非 buildTaskText 包装文本——任务/输出要求样板会污染词法判定。
 */
function continuationScore(newText, prevTexts) {
  const text = String(newText || '')
  let score = CONTINUATION_MARKERS.some((m) => text.toLowerCase().includes(m)) ? 1 : 0
  const a = significantTokens(text)
  if (a.size > 0) {
    for (const prev of prevTexts || []) {
      const b = significantTokens(prev)
      if (b.size === 0) continue
      let shared = 0
      for (const tok of a) if (b.has(tok)) shared++
      const ratio = shared / Math.max(a.size, b.size)
      if (shared >= 3 || (shared >= 2 && ratio >= 0.3)) {
        score += 2
        break
      }
    }
  }
  return score
}

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
     * P1/P2：provider 健康状态机（运行期失败冷却 + 向上回归决策）。
     * 由本模块持有，registry 传入以读 agent.routing 配置。
     */
    this.health = new ProviderHealth({ registry })
    /**
     * v1.5.0：同角色子代理复用池；v1.5.1 升级为多线程 LRU。
     * Map<entryKey, entry>，entryKey = `${parentSessionId}::${agentId}::${childId}`；
     * entry = { key, childId, agentId, parentSessionId, lastUsedAt, releaseTimer,
     *           lastTasks: string[] }（lastTasks = 该 child 最近任务文本，延续性判定语料）。
     * 与旧 byAgent 复用（仅活跃期）的区别：child 完成一轮后仍留在池中，
     * 下次 dispatch 按延续性启发式决定复用哪个 child（sendMessage：驻留 steer /
     * 已释放冷恢复，上下文延续）或新开（独立新任务）；空闲 idleReleaseMs 后
     * drainContinuableChildren 释放驻留（child 降为 ready）。同 (父会话,Agent) 最多
     * 保留 POOL_CAP 个 child，不同任务线程的续聊各自命中正确的子代理。
     */
    this.childPool = new Map()
    /** v1.5.4：非复用池已完成线程的历史记录——fresh 策略/小队专属 child 完成后
     * 不进 childPool（不可自动复用），但 agent_children 仍需展示（status: ready，
     * 可冷恢复续聊）。Map<childId, {childId, agentId, taskLabels: string[],
     * parentSessionId, completedAt}>。与 childPool 互斥：同一 childId 不同时出现在两处。 */
    this.completedFresh = new Map()
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
   * @param {'auto'|'reuse'|'fresh'} [opts.reuse='auto'] v1.5.1：子代理复用模式——
   *        'auto'（默认）智能判断：新任务是上一任务的延续（续写标记词 / 词汇重叠）→ 复用对应
   *        child；独立新任务 → 新开。'reuse' 强制复用最近同角色 child；'fresh' 强制新开。
   *        Agent 级 reusePolicy 是 auto 的兜底（fresh 策略的 Agent 在 auto 下永远新开）。
   * @param {string} [opts.childId] v1.5.3：定向续聊——显式指定子代理 session id，
   *        最高优先级（覆盖 reuse）。直接 sendMessage 续聊该子代理（服务端校验本会话
   *        相邻关系；冷恢复自动，进程是否新启动无关）。典型场景：要复用的不是最近
   *        一个子代理，而是隔开的旧线程。id 来源：agent_dispatch 返回的 childId /
   *        agent_children / 宿主 list_agents。失败抛错不静默降级。
   * @param {number} [opts.waitTimeoutMs=3600000] 等待结果超时（默认 1 小时，用户：10 分钟太短）
   * @returns {Promise<{agentId: string, agentName: string, childId: string, taskLabel: string, output: string|null, ok: boolean}>}
   */
  async dispatch(parentAgent, agentId, task, { runInBackground = true, viaSquad = null, squadRunId = null, stepIndex = null, totalSteps = null, waitResult = false, dedicatedChild = false, reuse = 'auto', childId = null, waitTimeoutMs = 3600000, failoverFrom = null, failoverCount = 0, failoverError = null } = {}) {
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
    let taskText = buildTaskText(task)
    // P2 failover（同任务自动换档重试）：来自 #retryOnChildFailure 的重试——
    // 在任务文本里带上换档说明，让新档 relay child 与主代理都明白这是链内重试
    // （relay child 只会如实转发任务文本；主代理看到的仍是同一任务的继续）。
    if (failoverFrom && failoverCount > 0) {
      const prev = failoverError ? String(failoverError).replace(/\s+/g, ' ').slice(0, 500) : '执行失败'
      taskText = `【前情提示】此任务此前尝试由 ${failoverFrom}（ACP 产品）执行，${prev}。请以全新会话执行本任务（注意：此前的中间产物可能不存在或不可靠，请自行校验后重新完成）。\n\n${taskText}`
    }
    const parentSessionId = parentAgent?.session?.id ?? null

    // P2：routes 提前解析一次，供复用分支的"向上回归"决策与下方新建路径共用。
    // 原始顺序 = 优先级（routes[0] 最优先）；健康状态机只做"冷却过滤 + 最高可用档查询"。
    const rawRoutes = this.registry.resolveRoutes(agentId)
    // P1：新建时跳过冷却中的 provider。全部冷却时保留原序硬试（宁试不空等，
    // 冷却指数加深 + resumeHold 会自然保护后续轮次）。skipped 仅作日志。
    const { available: healthyRoutes, skipped: cooledRoutes } = this.health.availableRoutes(agentId, rawRoutes)
    const routes = healthyRoutes.length > 0 ? healthyRoutes : rawRoutes
    if (cooledRoutes.length > 0 && healthyRoutes.length > 0) {
      this.#log({
        kind: 'dispatch',
        agentId,
        agentName: agent.name,
        childId: null,
        taskLabel,
        parentSessionId,
        ok: false,
        error: `冷却中跳过 provider: ${cooledRoutes.map((r) => r.provider).join(', ')}（P1 失败冷却）`,
      })
    }
    /** P2：upgrade fall-through 新建时注入的前情摘要（源：旧低档 child 的池条目） */
    let upgradeHandoff = null

    // ── v1.5.3 定向续聊：显式指定子代理 session id ──
    // 最高优先级：调用方给出 childId 时，不经过 auto 启发式/最近复用，
    // 直接 sendMessage 续聊该子代理（服务端校验相邻关系——必须是本会话的直接
    // 子代理；冷恢复自动：驻留/ready/进程已回收都能续，上下文按持久会话延续）。
    // 典型场景：要复用的不是最近一个子代理，而是隔开的旧线程。
    if (!dedicatedChild && childId) {
      let pooled = null
      for (const e of this.childPool.values()) {
        if (e.childId === childId) { pooled = e; break }
      }
      try {
        await this.followup(parentAgent, childId, taskText)
        // P1/P2：定向续聊也应记录/复用该 child 的 provider（从池条目取；
        // 若原池条目有 provider 则继续带，未知则标 null 并尝试从活跃记录继承）
        const knownProvider = pooled?.provider ?? this.activeChildren.get(childId)?.provider ?? null
        const knownAcp = pooled?.acpMode ?? this.activeChildren.get(childId)?.acpMode ?? false
        if (pooled) {
          // 池内线程：续聊即复活（更新任务语料/时间、取消释放定时器）
          if (pooled.releaseTimer) { clearTimeout(pooled.releaseTimer); pooled.releaseTimer = null }
          pooled.lastUsedAt = Date.now()
          pooled.lastTasks = [...(pooled.lastTasks || []), task.slice(0, LAST_TASK_MAX_LEN)].slice(-LAST_TASKS_CAP)
          pooled.keep = false // P2：定向续聊命中保底档 → 解除 LRU 豁免
        } else {
          // 池外线程（如 list_agents 里看到的、或已被淘汰的、或 completedFresh 历史记录）
          // → 补记一条池条目，使后续 auto 复用也能命中它
          this.completedFresh.delete(childId) // v1.5.4：池条目与历史记录互斥，进池即移除历史
          const entry = {
            key: `${reuseKey}::${childId}`,
            childId,
            agentId,
            parentSessionId,
            provider: knownProvider,
            acpMode: knownAcp,
            lastUsedAt: Date.now(),
            releaseTimer: null,
            lastTasks: [task.slice(0, LAST_TASK_MAX_LEN)],
            viaSquad: viaSquad ?? null,
            squadRunId: squadRunId ?? null,
            keep: false,
          }
          this.childPool.set(entry.key, entry)
          this.#evictPool(reuseKey, entry.key)
        }
        this.activeChildren.set(childId, {
          agentId,
          childId,
          taskLabel,
          task: task,
          taskText,
          provider: knownProvider,
          acpMode: knownAcp,
          startedAt: Date.now(),
          parentSessionId,
          viaSquad: viaSquad ?? null,
          squadRunId: squadRunId ?? null,
        })
        this.byAgent.set(agentId, childId)
        this.#log({
          kind: 'dispatch',
          agentId,
          agentName: agent.name,
          childId,
          provider: null,
          model: null,
          reused: true,
          reuseReason: 'explicit-child', // v1.5.3：调用方指定 session id 定向续聊
          taskLabel,
          parentSessionId,
          ok: true,
        })
        const output = waitResult
          ? await this.#waitFor(childId, waitTimeoutMs)
          : null
        return { agentId, agentName: agent.name, childId, taskLabel, output, ok: true }
      } catch (err) {
        throw new Error(
          `续聊指定子代理 ${childId} 失败：${err?.message ?? err}。该子代理必须属于当前会话（跨会话不可续，宿主强制相邻关系）；可用 agent_children 查看本会话可用线程，或去掉 childId 参数让 auto 智能决策。`,
        )
      }
    }

    // ── v1.5.0 同角色复用（v1.5.1 智能决策）──
    // 决策链（非 dedicatedChild 时）：
    //   1. 调用方 reuse 参数：'reuse' 强制复用最近同角色 child；'fresh' 强制新开；
    //      'auto'（默认）进入智能判断。
    //   2. auto 下 Agent 级 reusePolicy='fresh'（探索型角色）→ 视为 fresh。
    //   3. auto 下延续性启发式（continuationScore）：新任务与某 child 的最近任务
    //      有延续关系（续写标记词 / 词汇重叠：文件路径、标识符、CJK 双字词）→
    //      复用匹配度最高的该 child；否则视为独立新任务 → 新开子代理。
    // 池为多线程 LRU：(父会话, Agent) 下保留最近 POOL_CAP 个 child，不同任务线程
    // 的续聊各自命中正确的子代理，不互串。
    const reuseKey = `${parentSessionId}::${agentId}`
    const callReuse = reuse === 'reuse' || reuse === 'fresh' ? reuse : 'auto'
    const reusePolicy = agent.reusePolicy === 'fresh' ? 'fresh' : 'reuse'
    const reuseMode = callReuse === 'auto' && reusePolicy === 'fresh' ? 'fresh' : callReuse
    if (!dedicatedChild && reuseMode !== 'fresh') {
      // 候选：同 (父会话, Agent) 的池条目（非繁忙），按最近使用降序
      const candidates = [...this.childPool.values()]
        .filter((e) => e.parentSessionId === parentSessionId && e.agentId === agentId && !this.poolBusy.has(reuseKey))
        .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      let pooled = null
      let reuseReason = null
      if (reuseMode === 'reuse') {
        // 显式强制复用：取最近使用的 child（模型明确知道是续聊）
        pooled = candidates[0] ?? null
        reuseReason = pooled ? 'explicit' : null
      } else {
        // auto：延续性启发式 —— 选匹配度最高的候选；无匹配（score 0）→ 新开（独立新任务）
        let best = 0
        for (const c of candidates) {
          const score = continuationScore(task, c.lastTasks)
          if (score > best) { best = score; pooled = c }
        }
        if (pooled) {
          // 3 = 标记词+重叠；2 = 仅重叠；1 = 仅标记词（无具体指向，按最近使用兜底）
          reuseReason = best >= 3 ? 'continuation' : best === 2 ? 'continuation-overlap' : 'continuation-marker'
        }
      }
      if (pooled) {
        // ── P2：向上回归决策（v1.7.0）──
        // 复用命中的 child 绑定的 provider 可能不是当前最高可用档——例如上次
        // deveco 失败后任务降级到 opencode 执行，这轮 deveco 冷却已过：应尽量
        // 回到 routes 优先顺序里最优先的可用档（"每轮尽量回归最优先配置"）。
        // 规则：
        //   a. 高档有 ready child（池中同 agent 同档位）→ 改道定向续聊它
        //      （零成本、历史完整，无需摘要）；
        //   b. 高档无现成 child → 放弃续聊语义 fall-through 新建（routes[0]=高档），
        //      旧低档 child 留池保底（keep 标记防 LRU 淘汰），新 child 注入【前情摘要】；
        //   c. 当前档已是最高可用档 / 无 routes / 显式定向（childId 分支已先行返回）/
        //      squad dedicatedChild（不进本分支）→ 维持现状。
        const hi = this.health.highestReadyProvider(agentId, rawRoutes)
        const curProvider = pooled.provider ?? null
        const canUpgrade = hi && curProvider && hi !== curProvider && !dedicatedChild && reuseMode !== 'fresh'
        if (canUpgrade) {
          // a. 高档 ready child 优先（零成本完整回归）
          const hiChild = [...this.childPool.values()].find(
            (e) => e.agentId === agentId && e.parentSessionId === parentSessionId && e.provider === hi && !this.activeChildren.has(e.childId),
          )
          if (hiChild) {
            pooled = hiChild
            reuseReason = 'upgrade-existing' // 改道续聊高档 ready child
            this.#log({
              kind: 'dispatch',
              agentId,
              agentName: agent.name,
              childId: hiChild.childId,
              taskLabel,
              parentSessionId,
              ok: true,
              error: null,
              note: `P2 回归：续聊目标从 ${curProvider} 升档到 ${hi}（复用高档 ready child）`,
            })
          } else {
            // b. 高档无现成 child：fall-through 新建；低档 child 留池保底防淘汰
            upgradeHandoff = {
              fromProvider: curProvider,
              toProvider: hi,
              summary: this.#buildHandoffSummary(pooled),
            }
            if (pooled.releaseTimer) { clearTimeout(pooled.releaseTimer); pooled.releaseTimer = null }
            pooled.keep = true // 保底档：LRU 淘汰时豁免（见 #evictPool）
            pooled = null // 放弃复用 → 下方新建路径从 routes[0]=高档 开始
            this.#log({
              kind: 'dispatch',
              agentId,
              agentName: agent.name,
              childId: null,
              taskLabel,
              parentSessionId,
              ok: true,
              error: null,
              note: `P2 回归：从 ${upgradeHandoff.fromProvider} 升档新建 ${upgradeHandoff.toProvider}（带前情摘要，低档 child 留池保底）`,
            })
          }
        }
      }
      if (pooled) {
        this.poolBusy.add(reuseKey)
        try {
          // sendMessage：驻留子代理 steer 到最近 step；已释放（ready）子代理
          // 自动冷恢复（持久会话保留全部上下文）。
          const resumeText = upgradeHandoff
            ? `${upgradeHandoff.summary}\n\n${taskText}`
            : taskText
          await this.followup(parentAgent, pooled.childId, resumeText)
          // 续聊成功：取消空闲释放定时器、回写活跃映射（面板"运行中"）
          if (pooled.releaseTimer) {
            clearTimeout(pooled.releaseTimer)
            pooled.releaseTimer = null
          }
          pooled.lastUsedAt = Date.now()
          pooled.lastTasks = [...(pooled.lastTasks || []), task.slice(0, LAST_TASK_MAX_LEN)].slice(-LAST_TASKS_CAP)
          pooled.keep = false // P2：复用续聊命中保底档 → 解除 LRU 豁免
          this.activeChildren.set(pooled.childId, {
            agentId,
            childId: pooled.childId,
            taskLabel,
            task: task,
            taskText,
            provider: pooled.provider ?? null,
            acpMode: pooled.acpMode ?? false,
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
            reuseReason, // v1.5.1：explicit / continuation-marker / continuation-overlap
            taskLabel,
            parentSessionId: pooled.parentSessionId ?? parentSessionId,
            ok: true,
          })
          const output = waitResult
            ? await this.#waitFor(pooled.childId, waitTimeoutMs)
            : null
          return { agentId, agentName: agent.name, childId: pooled.childId, taskLabel, output, ok: true }
        } catch (err) {
          // 复用失败（child 已不可恢复/父级身份失效）→ 丢弃该池条目，按新建流程重来
          this.#dropPool(pooled.key, err)
        } finally {
          this.poolBusy.delete(reuseKey)
        }
      }
    }

    // 互备路由：无 routes 时尝试一次（不传 agentOptions，继承父会话）。
    // routes 已在方法顶部经 health.availableRoutes 冷却过滤（P1）——此处直接使用。
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
          ? `${agent.systemPrompt}\n\n【ACP 执行模式】\n你是到 ${route.provider}（ACP CLI 代理）的中继。对每个收到的任务，调用 product_submit 把任务原样转发给 ${route.provider} 执行；${route.provider} 返回后，把它的回答如实转达给发起方。不要自己用本地工具完成任务，也不要调用其他工具。\n\n【失败语义（P2）】若 product_submit 报错（如 ${route.provider} 限流/超时/无响应/空回复），这属于产品侧暂时性故障：dsh-agent-dispatch 会按该 Agent 的 routes fallback 链自动换档（如 deveco → opencode）并重试本任务，发起方无需重新派发。请把错误信息转达上来并说明"将自动换档重试"，不要尝试自己用其他手段完成任务。`
          : agent.systemPrompt
        // v1.6.2：ACP relay 模式支持按 agent 路由指定产品模型与推理强度——route.model /
        // route.effort 经 request.productSettings 交给 product-subagents 的
        // prepareContinuable 写入 binding settings，由 ACP 桥在每次 prompt 前发
        // session/set_config_option（model / effort）生效（best-effort：产品不支持或
        // 取值非法时回退产品自己的默认并告警）。"default" 是模型占位符：不指定模型。
        const productSettings = (() => {
          if (!acpMode || !route) return undefined
          const s = {}
          if (route.model && route.model !== 'default') s.model = route.model
          if (route.effort) s.reasoningEffort = route.effort
          return Object.keys(s).length > 0 ? s : undefined
        })()
        // v1.5.0：非 ACP 模式的 deny 名单动态求交集（#safeDenyList）——
        // 新宿主 tools.restrict() 对未知工具名 loud throw（旧宿主无此校验，
        // 静态名单可用；新宿主下静态名单会把 product_delegate 等未加载工具
        // 名塞进 restrict → 子代理创建直接失败）。
        const deny = acpMode ? null : this.#safeDenyList()
        // P2 upgrade fall-through：新建时把旧线程的前情摘要拼进初始 prompt
        const initialPrompt = upgradeHandoff
          ? `${upgradeHandoff.summary}\n\n${taskText}`
          : taskText
        const { childId } = await this.ctx.subagents.startContinuable({
          provider: acpMode ? route.provider : 'spawn',
          label: childLabel,
          signal: ac.signal,
          request: {
            label: childLabel,
            prompt: [{ type: 'text', text: initialPrompt }],
            parent: parentAgent,
            persona: acpPersona,
            ...(agentOptions ? { agentOptions } : {}), // 无 routes：缺省继承父会话
            ...(productSettings ? { productSettings } : {}), // v1.6.1：ACP relay 按 agent 路由指定产品模型
            ...(acpMode
              ? { toolFilter: { allow: ['product_submit'] } }
              : deny.length > 0
                ? { toolFilter: { deny } }
                : {}), // v1.1.2 递归护栏：子代理看不到委派工具，物理阻断再派下级；v1.2.0 加 agent_upsert 防子代理改注册表；v1.3.0 加 agent_squad_continue 防子代理续跑小队；v1.3.1 加 agent_squad_upsert 防子代理改小队注册表；v1.4.0 ACP 模式改用 allow 白名单；v1.4.1 扩展通用工具 deny 名单；v1.5.0 名单动态求交集 + send_message/product_submit 豁免
            maxDepth: Math.max(2, callerDepth + 1), // 委派深度记账；递归由 toolFilter.deny + tools.guard + dispatch 入口硬检查阻断
          },
        })
        // v1.6.3：宿主 startContinuable 只把 {sessionId,parent,signal} 传给 provider 的
        // prepareContinuable（白名单），request.productSettings 无法到达 product-subagents；
        // 且 cordis ctx 属性受 inject 门禁，跨插件共享改走事件总线：product-subagents 在
        // 'product-subagents/apply-child-settings' 事件里写入 binding settings（与
        // product_delegate 的 bindings.set 同序同效）。binding 在宿主 resolve 前已由
        // prepareContinuable 建立，因此事件触发时必然已存在。
        if (acpMode && productSettings) {
          try {
            this.ctx.emit('product-subagents/apply-child-settings', { childId, settings: productSettings })
          } catch (error) {
            this.#log({
              kind: 'dispatch',
              agentId,
              agentName: agent.name,
              childId,
              taskLabel,
              parentSessionId,
              viaSquad: viaSquad ?? null,
              squadRunId: squadRunId ?? null,
              ok: false,
              error: `apply-child-settings failed: ${error && error.message ? error.message : error}`,
            })
          }
        }
        // v0.9.40：childId 为主 key（多子代理并存）；byAgent 二级索引供 /agent-api/cancel 兜底
        // P1/P2：记录该 child 绑定的 provider 与 acpMode（onChildEnd 健康记录与自动换档用）
        this.activeChildren.set(childId, {
          agentId,
          childId,
          taskLabel,
          task: task, // P2：完整任务原文（自动换档重试时重放；轻量引用，非拷贝）
          taskText, // P2：包装后的任务文本（同上）
          provider: route?.provider ?? null,
          acpMode,
          failoverCount, // P2：本任务已换档次数（首建 0；#retryOnChildFailure 递增）
          startedAt: Date.now(),
          parentSessionId, // cancel 时构造 user-authority 用
          viaSquad: viaSquad ?? null, // v0.9.32：小队发起存小队 id（悬浮球运行中聚合展示）
          squadRunId: squadRunId ?? null,
        })
        if (!dedicatedChild) this.byAgent.set(agentId, childId)
        // v1.5.0：非专属且非 fresh 的 child 登记进复用池；v1.5.1 改为多线程 LRU——
        // entryKey 含 childId，同 (父会话,Agent) 可并存多个线程的 child；超 POOL_CAP
        // 淘汰最旧（清除其释放定时器；驻留资源由宿主 settled 自动回收）。
        if (!dedicatedChild && reuseMode !== 'fresh') {
          const entry = {
            key: `${reuseKey}::${childId}`,
            childId,
            agentId,
            parentSessionId,
            provider: route?.provider ?? null,
            acpMode,
            lastUsedAt: Date.now(),
            releaseTimer: null,
            lastTasks: [task.slice(0, LAST_TASK_MAX_LEN)],
            viaSquad: viaSquad ?? null,
            squadRunId: squadRunId ?? null,
            keep: false, // P2：保底档豁免 LRU 淘汰（upgrade fall-through 时置 true）
          }
          this.childPool.set(entry.key, entry)
          this.#evictPool(reuseKey, entry.key)
        }
        this.#log({
          kind: 'dispatch',
          agentId,
          agentName: agent.name,
          childId,
          provider: acpMode ? route.provider : (agentOptions?.provider ?? null), // v1.4.0：ACP 模式记录 route.provider
          model: acpMode ? (productSettings?.model ?? null) : (agentOptions?.model ?? null), // v1.6.1：ACP 记录 route 指定的产品模型
          reused: false,
          reuseReason: dedicatedChild ? 'dedicated' : (reuseMode === 'fresh' ? (reusePolicy === 'fresh' ? 'policy-fresh' : 'fresh') : 'fresh-task'), // v1.5.1：新开原因
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
        // P1：创建期失败（startContinuable reject）也记健康失败——ACP CLI 起不来/
        // 握手失败说明该 provider 当前不可用，冷却后后续派发会跳过它（硬失败：立即冷却）
        if (route?.provider) {
          try {
            this.health.recordFailure(agentId, route.provider, { hard: true })
          } catch { /* 健康记录失败不影响主流程 */ }
        }
        this.#log({
          kind: 'dispatch',
          agentId,
          agentName: agent.name,
          childId: null,
          provider: acpMode ? route.provider : (agentOptions?.provider ?? null), // v1.4.0：ACP 模式记录 route.provider
          model: acpMode ? (productSettings?.model ?? null) : (agentOptions?.model ?? null), // v1.6.1：ACP 记录 route 指定的产品模型
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
   * v1.5.4：续聊完成后更新插件侧状态——若目标在 completedFresh 历史记录中，
   *   移除历史条目（互斥）并写 activeChildren（使 listChildren 展示 running
   *   而非 ready）；若目标在复用池中，取消释放定时器（与 dispatch childId
   *   分支逻辑一致）。续聊失败时不修改状态（宿主已拒绝，线程不可用）。
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
    // v1.5.4：续聊成功后更新插件侧状态
    // 池内线程：取消释放定时器（与 dispatch childId 分支一致）
    for (const e of this.childPool.values()) {
      if (e.childId === childId) {
        if (e.releaseTimer) { clearTimeout(e.releaseTimer); e.releaseTimer = null }
        break
      }
    }
    // completedFresh 历史记录中的线程：移除（互斥）+ 写 activeChildren
    const hist = this.completedFresh.get(childId)
    if (hist) {
      this.completedFresh.delete(childId)
      if (!this.activeChildren.has(childId)) {
        this.activeChildren.set(childId, {
          agentId: hist.agentId,
          childId,
          taskLabel: summarizeTask(message),
          startedAt: Date.now(),
          parentSessionId: hist.parentSessionId,
          viaSquad: null,
          squadRunId: null,
        })
        if (!this.byAgent.has(hist.agentId)) this.byAgent.set(hist.agentId, childId)
      }
    }
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
   * P2（v1.7.1）：product-subagents 事件总线通知——product_submit 工具抛错
   * （EMPTY_RESPONSE / SUBMIT_TIMEOUT / 限流耗尽等产品侧故障）。relay child 是
   * LLM agent：工具报错后它会把错误"转达"并以 completed 正常结束回合，编排层
   * 无法从 stopReason 感知产品故障；必须靠本结构性标记，onChildEnd 时按失败处理
   * （记健康失败 + 触发自动换档）。
   * @param {{childId: string, product?: string, code?: string|null, message?: string}} info
   */
  markChildSubmitFailed(info) {
    if (!info || !info.childId) return
    const entry = this.activeChildren.get(info.childId)
    if (!entry) return // child 已结算/非本插件派遣 → 忽略
    entry._submitFailed = {
      product: info.product ?? null,
      code: info.code ?? null,
      message: info.message ?? '',
      at: Date.now(),
    }
  }

  /**
   * P2（v1.7.1）：清除失败标记——relay child 一次失败后若在同一回合内再次调用
   * product_submit 成功（模型自愈重试），不应再按失败处理。
   */
  markChildSubmitOk(info) {
    if (!info || !info.childId) return
    const entry = this.activeChildren.get(info.childId)
    if (!entry) return
    entry._submitFailed = null
  }

  /**
   * v1.8.0（方案 A：主窗口感知待授权）：product-subagents 在 ACP 权限审批
   * 挂起/决议时发跨插件事件。编排层在 activeChildren entry 上标记
   * permissionPending——REST /agent-api/active 透出后，主窗口 FAB/面板可显示
   * 「⏳ 待授权」徽标（审批弹窗按宿主 scope 设计落在子代理会话 UI，用户需切
   * 过去点允许；本标记让主代理环境先知道"有子代理在等授权"）。
   * @param {{childId: string, product?: string, description?: string, at?: number}} info
   */
  markPermissionPending(info) {
    if (!info || !info.childId) return
    const entry = this.activeChildren.get(info.childId)
    if (!entry) return
    entry.permissionPending = {
      product: info.product ?? null,
      description: info.description ?? '未知操作',
      at: info.at ?? Date.now(),
    }
    const agent = this.registry.get(entry.agentId)
    this.#notifyParent(entry, `⏳ 子代理「${agent?.name ?? entry.agentId}」正在请求 ACP 权限：${entry.permissionPending.product ? `[${entry.permissionPending.product}] ` : ''}${entry.permissionPending.description}。审批弹窗在该子代理的会话界面（运行中列表可见），请提醒用户前往点击允许/拒绝；未决前任务保持暂停。`)
  }

  /** 清除待授权标记（审批已决议，无论允许/拒绝） */
  markPermissionResolved(info) {
    if (!info || !info.childId) return
    const entry = this.activeChildren.get(info.childId)
    if (!entry) return
    const was = entry.permissionPending
    entry.permissionPending = null
    if (was) {
      const agent = this.registry.get(entry.agentId)
      const ok = info && info.outcome === 'allowed-once'
      this.#notifyParent(entry, `${ok ? '✅' : '⛔'} 子代理「${agent?.name ?? entry.agentId}」的 ACP 权限请求已${ok ? '获批准' : `结束(${info?.outcome ?? 'unknown'})`}：${was.description}${ok ? '，任务继续执行。' : '，任务将按产品失败处理（自动换档或上报）。'}`)
    }
  }

  /**
   * v1.8.0：向父级（主代理）会话注入一条不唤醒的用户消息——主代理对话内
   * 提示。宿主 Agent.inject 无 wakeup 参数（区别于 send/steer）：只入会话，
   * 不触发回合；主代理空闲时不会被打断烧模型，下次自然唤醒（用户发言/子代理
   * 结算通知）时可见。消息结构仿 user-approval 的 createUserMessage（role=user
   * + content + source.plugin）。
   */
  #notifyParent(entry, text) {
    try {
      if (!entry || !entry.parentSessionId) return
      const agents = this.ctx.get?.('agents')
      const parent = agents?.get?.(entry.parentSessionId)
      if (!parent || typeof parent.inject !== 'function') return
      parent.inject({
        id: randomUUID(),
        role: 'user',
        content: [{ type: 'text', text: String(text).slice(0, 500) }],
        source: { kind: 'plugin', plugin: 'dsh-agent-dispatch' },
      })
    } catch (err) {
      console.warn(`[dsh-agent-dispatch] 父级通知失败（不影响审批）: ${err?.message ?? err}`)
    }
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
    const reason = stopReason ?? 'completed'
    // P2（v1.7.1）：产品侧故障的结构性信号优先于回合 stopReason——relay child 是
    // LLM agent，product_submit 工具报错（空正文/超时/限流耗尽）后它会"转达错误"
    // 并以 completed 正常结束回合，宿主 stopReason 无从感知产品故障。markChildSubmitFailed
    // 已把 _submitFailed 标记在 entry 上：凡带此标记，即使回合 completed 也按失败处理。
    const productFailed = !!entry._submitFailed
    const ok = reason === 'completed' && !productFailed
    // P1/P2：健康记录——completed → 该 provider 记成功（清零冷却）；
    // error/aborted 或产品故障标记 → 记失败。ACP relay 模式（acpMode）子代理的
    // error/空响应只来自 product_submit 抛错（产品侧 429/超时/空响应），视为
    // hard failure 立即冷却；spawn LLM 模式的 error 可能是任务本身难，按配置
    // failThreshold 累计。
    const routedProvider = entry.provider && this.health.isRoutedProvider(entry.agentId, entry.provider)
      ? entry.provider
      : null
    if (routedProvider) {
      if (ok) this.health.recordSuccess(entry.agentId, routedProvider)
      else this.health.recordFailure(entry.agentId, routedProvider, { hard: !!entry.acpMode })
    }
    // 补记真实执行结果行（kind:'result'，与派遣行 kind:'dispatch' 区分）
    this.#log({
      kind: 'result',
      agentId: entry.agentId,
      agentName: agent?.name ?? entry.agentId,
      emoji: agent?.emoji ?? '',
      childId,
      taskLabel: entry.taskLabel ?? '',
      parentSessionId: entry.parentSessionId ?? null, // v0.8.4：历史页跳转主会话
      stopReason: reason,
      ok,
      provider: routedProvider, // P1：结果行也带 provider（失败冷却依据）
      productFailed: productFailed ? (entry._submitFailed.code ?? entry._submitFailed.message ?? true) : undefined, // v1.7.1
      output: norm ? norm.slice(0, 4000) : null, // v0.9.36：结果文本入日志（v0.9.38 归一化）
    })
    // v0.9.36：兑现等待者（若有）——completed 返回结果文本；非 completed 返回失败占位。
    // P2：失败时若将自动换档（#canFailover），等待者【不兑现】——它被迁移到换档后
    // 的新 child 上（见 #retryOnChildFailure），链全部走完仍失败才收到失败占位。
    // 这是"fallback 链走完前不让上层（主代理/squad）误判失败"的硬保证。
    const w = this.waiters.get(childId)
    // P2：自动换档条件——回合 error 或产品故障标记（真实故障信号）；
    // aborted 是用户/主代理主动取消，尊重意图不重跑。
    const willFailover = !ok && (reason === 'error' || productFailed) && entry.acpMode && entry.task && this.#canFailover(entry)
    if (w && !willFailover) {
      clearTimeout(w.timer)
      this.waiters.delete(childId)
      w.resolve(ok ? norm : `（步骤失败: ${reason}${productFailed ? `; 产品故障: ${entry._submitFailed?.code ?? ''} ${entry._submitFailed?.message ?? ''}`.trim() : ''}）`)
    }
    // P2：自动换档重试（核心：fallback 链走完前不让主代理看到"最终失败"）——
    // 规则：ACP relay 模式、产品故障/error 结束、任务文本仍在、换档次数未耗尽、
    // 且 routes 中本档之后存在未冷却的 provider → 从下一可用档重新派发同一任务
    // （fire-and-forget）。deveco 故障会先在 deveco → opencode → deepseek 链内自动
    // 消化；整条链都失败，上层才会收到一次带"所有路由均失败"语义的最终错误。
    if (willFailover) {
      const failDetail = productFailed
        ? `${entry._submitFailed?.code ?? 'PRODUCT_FAILED'}: ${entry._submitFailed?.message ?? ''}`.trim()
        : `${reason}${norm ? `: ${norm.slice(0, 200)}` : ''}`
      this.#retryOnChildFailure(childId, entry, failDetail, norm).catch((err) => {
        console.error(`[dsh-agent-dispatch] 自动换档重试失败: ${err?.message ?? err}`)
        // 兜底：换档本身失败时，等待者不能再挂着——兑现失败占位
        const waiter = this.waiters.get(childId)
        if (waiter) {
          clearTimeout(waiter.timer)
          this.waiters.delete(childId)
          waiter.resolve(`（步骤失败: ${reason}；自动换档未启动: ${err?.message ?? err}）`)
        }
      })
    }
    // v1.5.0：空闲回收——child 完成一轮且仍在复用池 → 排释放定时器
    this.#scheduleReleaseFor(childId)
    // v1.5.4：非复用池线程（fresh 策略/小队专属）完成后保留历史记录——
    // agent_children 仍需展示（status: ready，可冷恢复续聊）。
    // 与 childPool 互斥：池内线程由池条目驱动显示，不重复记录。
    if (!this.#isInPool(childId)) {
      this.completedFresh.set(childId, {
        childId,
        agentId: entry.agentId,
        taskLabels: [entry.taskLabel || ''].filter(Boolean),
        parentSessionId: entry.parentSessionId ?? null,
        completedAt: Date.now(),
      })
      this.#pruneCompletedFresh()
    }
  }

  /**
   * P2：判断某失败 child 是否满足"自动换档重试"条件——
   *   1) 有 provider（routes 内）且是 ACP relay 模式；
   *   2) routes 中该 provider 之后存在【未冷却】的档位；
   *   3) 已换档次数未超过 routes 总档数（防无限循环）。
   * 注意：换档目标是"之后的档位"，不回头（deveco 失败 → 试 opencode/deepseek；
   * 冷却期内的档位跳过，全冷却则不再自动换档，等上层决策）。
   * @param {object} entry activeChildren 条目（含 provider/acpMode/failoverCount/task）
   */
  #canFailover(entry) {
    if (!entry || !entry.provider || !entry.acpMode || !entry.task) return false
    const routes = this.registry.resolveRoutes(entry.agentId)
    if (!routes || routes.length < 2) return false
    const idx = routes.findIndex((r) => r && r.provider === entry.provider)
    if (idx < 0 || idx >= routes.length - 1) return false // 已是最末档，无后续可换
    const tries = entry.failoverCount ?? 0
    if (tries >= routes.length - 1) return false // 换档次数上限（链长度-1）
    const nextReady = routes.slice(idx + 1).find((r) => r && !this.health.isCooling(entry.agentId, r.provider))
    return !!nextReady
  }

  /**
   * P2：同任务自动换档重试（fire-and-forget，由 onChildEnd 调用）。
   * 取 routes 中失败档之后的第一个未冷却档，用【同一任务文本】重新 dispatch
   * （reuse:'fresh' 强制新建，不撞复用池）；把原 waiters（若有，squad waitResult）
   * 迁移到新 child，使上层在链未走完前不会收到失败。失败档已由 onChildEnd 记入
   * health 冷却，重试新建时 pickRoutes 会自然跳过它。
   */
  async #retryOnChildFailure(childId, entry, reason, norm) {
    const routes = this.registry.resolveRoutes(entry.agentId)
    const idx = routes.findIndex((r) => r && r.provider === entry.provider)
    if (idx < 0) return
    const next = routes.slice(idx + 1).find((r) => r && !this.health.isCooling(entry.agentId, r.provider))
    if (!next) return
    // 父 agent 必须仍在线上（宿主强制相邻关系；父下线则无法再建 child）
    const agents = this.ctx.get?.('agents')
    const parent = agents?.get?.(entry.parentSessionId)
    if (!parent) return
    const prevErr = norm || reason || ''
    const tries = (entry.failoverCount ?? 0) + 1
    // 同一任务文本（带 failover 前缀说明在 dispatch 内拼装）
    const { childId: nextChildId } = await this.dispatch(parent, entry.agentId, entry.task, {
      reuse: 'fresh', // 强制新建：换档必须新 child（新 provider），绝不续聊旧线程
      dedicatedChild: false,
      viaSquad: entry.viaSquad ?? null,
      squadRunId: entry.squadRunId ?? null,
      stepIndex: entry.stepIndex ?? null,
      totalSteps: entry.totalSteps ?? null,
      waitResult: false, // 不在此处等待——结果走子代理 notice 或原 waiter 迁移
      failoverFrom: entry.provider,
      failoverCount: tries,
      failoverError: prevErr.slice(0, 500),
    })
    this.#log({
      kind: 'dispatch',
      agentId: entry.agentId,
      agentName: this.registry.get(entry.agentId)?.name ?? entry.agentId,
      childId: nextChildId,
      taskLabel: entry.taskLabel ?? '',
      parentSessionId: entry.parentSessionId ?? null,
      viaSquad: entry.viaSquad ?? null,
      squadRunId: entry.squadRunId ?? null,
      ok: true,
      note: `P2 自动换档：${entry.provider} 失败(${reason}) → ${next.provider}（第 ${tries} 次换档）`,
    })
    // P2：failover 新 child 继承池位——原 child 属于复用策略线程（在池中）时，
    // 换档成功的新线程也应入池，使后续延续任务能续聊"成功线程"；原低档线程
    // 留池打保底（keep），供降级/定向续回。
    if (!entry.viaSquad && this.#isInPool(childId)) {
      const reuseKey2 = `${entry.parentSessionId}::${entry.agentId}`
      const nextAcp = !!this.ctx.subagents?.getProvider?.(next.provider)
      const pooledEntry = {
        key: `${reuseKey2}::${nextChildId}`,
        childId: nextChildId,
        agentId: entry.agentId,
        parentSessionId: entry.parentSessionId,
        provider: next.provider,
        acpMode: nextAcp,
        lastUsedAt: Date.now(),
        releaseTimer: null,
        lastTasks: [String(entry.task ?? entry.taskLabel ?? '').slice(0, LAST_TASK_MAX_LEN)],
        viaSquad: entry.viaSquad ?? null,
        squadRunId: entry.squadRunId ?? null,
        keep: false,
      }
      this.childPool.set(pooledEntry.key, pooledEntry)
      // 原低档条目保底：标记 keep 防 LRU 立即挤出
      for (const e of this.childPool.values()) {
        if (e.childId === childId) e.keep = true
      }
      this.#evictPool(reuseKey2, pooledEntry.key)
    }
    // 迁移等待者：原 child 的 waiter（若有）挂到新 child 上，链未走完不兑现
    const w = this.waiters.get(childId)
    if (w) {
      this.waiters.delete(childId)
      clearTimeout(w.timer)
      // 重新起计时（沿用 waitTimeoutMs 语义：以换档后的新 child 为起点）
      const waiter = this.waiters.get(nextChildId)
      if (waiter) {
        // 新 child 已被并发 dispatch 挂过 waiter（罕见）→ 直接兑现旧的，避免悬挂
        clearTimeout(waiter.timer)
        this.waiters.delete(nextChildId)
        w.resolve('（换档重试中，结果由新子代理回传）')
      } else {
        const timer = setTimeout(() => {
          this.waiters.delete(nextChildId)
          w.resolve('（等待结果超时）')
        }, 3600000) // 同 #waitFor 默认 1h
        timer.unref?.()
        this.waiters.set(nextChildId, { resolve: w.resolve, timer })
      }
    }
  }

  /**
   * P2：从旧低档 child 的池条目构造"前情摘要"（upgrade fall-through 新建时注入）。
   * 池条目无完整对话历史，这里拼最近任务标签与换档说明，让新档 relay child 理解
   * 线程目的。低档 child 仍留池保底，可随时定向续回（历史零丢失）。
   */
  #buildHandoffSummary(pooled) {
    const prevTasks = (pooled?.lastTasks || []).filter(Boolean)
    const taskTail = prevTasks.length > 0 ? prevTasks[prevTasks.length - 1].slice(0, 300) : ''
    const parts = []
    if (taskTail) parts.push(`线程最近任务：${taskTail}`)
    parts.push(`此前该线程由 ${pooled?.provider ?? '原 provider'} 执行（档位低于当前目标）`)
    return `【前情摘要（自动换档续接）】${parts.join('；')}。请基于线程目的继续完成本任务；如与上下文相关，可自行校验后继续。`
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
    await this.#drainChild(pooled.parentSessionId, pooled.childId)
    // 幂等 drain：无论驻留是否仍在，都算完成一次回收（ready 态为 no-op）
    console.log(`[dsh-agent-dispatch] 已释放空闲子代理 ${pooled.childId}（${pooled.agentId}）的驻留资源，会话保留可冷恢复复用`)
  }

  /**
   * v1.5.1：多线程 LRU 淘汰——同 (父会话, Agent) 的池条目超过 POOL_CAP 时，
   * 淘汰最近使用时间最旧的条目（清除其释放定时器）。被淘汰 child 失去复用资格；
   * v1.5.2：淘汰即回收——不在运行中的被淘汰 child 立即 drain 驻留资源
   *（in-process 中继 agent 即刻释放；ACP 后台进程仍由 product-subagents 的
   * idleTimeoutMs 收尾；宿主 settled 也会自动回收驻留）。
   * @param {string} reuseKey ${parentSessionId}::${agentId}
   * @param {string} keepKey  本次新登记的 entryKey（不参与淘汰）
   */
  #evictPool(reuseKey, keepKey) {
    const sameKey = [...this.childPool.values()].filter((e) => {
      const k = e.key
      return k && k.startsWith(reuseKey + '::') && k !== keepKey
    })
    if (sameKey.length < POOL_CAP) return
    // P2：LRU 淘汰豁免 keep 保底档（upgrade fall-through 时低档 child 打 keep，
    // 防止升级新建瞬间被同 key 淘汰挤出——它是保底，随时可定向续回）
    const droppable = sameKey.filter((e) => !e.keep)
    const pool = droppable.length >= POOL_CAP - 1 ? droppable : sameKey
    pool.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
    const evicted = pool.slice(0, pool.length - POOL_CAP + 1)
    for (const e of evicted) {
      if (e.releaseTimer) clearTimeout(e.releaseTimer)
      this.childPool.delete(e.key)
      if (this.byAgent.get(e.agentId) === e.childId) this.byAgent.delete(e.agentId)
      if (!this.activeChildren.has(e.childId)) {
        // v1.5.2：确定不再复用 → 立即释放驻留（fire-and-forget，失败不阻断淘汰）
        this.#drainChild(e.parentSessionId, e.childId).catch(() => {})
      }
    }
  }

  /**
   * v1.5.2：释放指定子代理的驻留 Activation（drainContinuableChildren）。
   * 幂等：目标已 ready / 父级已下线 / 无公开 API 时安全降级（宿主 settled 自动回收兜底）。
   * ACP 后台进程的回收由 product-subagents 的 idleTimeoutMs 定时器负责，本方法不涉及。
   * @param {string} parentSessionId 委派方（父）会话 id
   * @param {string} childId         子代理会话 id
   */
  async #drainChild(parentSessionId, childId) {
    try {
      const agents = this.ctx.get?.('agents')
      const parent = agents?.get?.(parentSessionId)
      if (parent && typeof this.ctx.subagents.drainContinuableChildren === 'function') {
        await this.ctx.subagents.drainContinuableChildren(parent, [childId])
      }
    } catch (err) {
      // 子代理已消失/父级身份失效：harness 自行处理，忽略
      if (String(err?.message || err).includes('UNAUTHORIZED')) return
      console.error(`[dsh-agent-dispatch] 释放子代理 ${childId} 失败:`, err?.message ?? err)
    }
  }

  /**
   * v1.5.3→v1.5.4：列出当前会话的子代理线程（agent_children 工具）——复用池条目 +
   * 活跃但不在池的 child（fresh 策略/小队专属）+ 已完成但不在池的历史线程
   * （v1.5.4 completedFresh），附最近任务标签与状态。
   * 供主模型挑选定向续聊的 childId（agent_dispatch(childId=...)）。
   * 状态：running = 正在执行任务；idle = 驻留空闲；ready = 仅持久会话
   * （驻留已释放，可冷恢复续聊）。宿主 listChildren 不可用时按活跃映射派生。
   * @param {object} parentAgent 调用方 agent（exec.agent）
   * @param {{agentId?: string}} [opts] 可选按 Agent 过滤
   * @returns {Promise<{children: Array<{childId: string, agentId: string, taskLabels: string[], status: string}>}>}
   */
  async listChildren(parentAgent, { agentId } = {}) {
    const parentSessionId = parentAgent?.session?.id ?? null
    const rows = []
    const seen = new Set()
    // 池条目（含空闲/驻留/已释放的线程视图）
    for (const e of this.childPool.values()) {
      if (e.parentSessionId !== parentSessionId) continue
      if (agentId && e.agentId !== agentId) continue
      seen.add(e.childId)
      rows.push({
        childId: e.childId,
        agentId: e.agentId,
        taskLabels: [...(e.lastTasks || [])].map((t) => summarizeTask(t, 40)),
        status: this.activeChildren.has(e.childId) ? 'running' : 'idle',
      })
    }
    // 活跃但不在池（fresh 策略 / 小队专属 / 定向续聊补录前）
    for (const a of this.activeChildren.values()) {
      if (a.parentSessionId !== parentSessionId) continue
      if (agentId && a.agentId !== agentId) continue
      if (seen.has(a.childId)) continue
      seen.add(a.childId)
      rows.push({
        childId: a.childId,
        agentId: a.agentId,
        taskLabels: [a.taskLabel || ''],
        status: 'running',
      })
    }
    // v1.5.4：非复用池已完成线程（fresh 策略/小队专属完成后历史记录）
    for (const h of this.completedFresh.values()) {
      if (h.parentSessionId !== parentSessionId) continue
      if (agentId && h.agentId !== agentId) continue
      if (seen.has(h.childId)) continue
      seen.add(h.childId)
      rows.push({
        childId: h.childId,
        agentId: h.agentId,
        taskLabels: h.taskLabels || [],
        status: 'ready',
      })
    }
    // 状态细化：宿主 listChildren（resident vs persisted-only）
    try {
      if (parentAgent && typeof this.ctx.subagents.listChildren === 'function') {
        const entries = await this.ctx.subagents.listChildren(parentAgent.session.id)
        const byId = new Map((entries || []).map((en) => [en && en.id, en]))
        for (const r of rows) {
          const en = byId.get(r.childId)
          if (!en) continue
          if (r.status !== 'running') r.status = en.activity === 'running' ? 'idle' : 'ready'
        }
      }
    } catch { /* 宿主无 listChildren 时保留派生状态 */ }
    rows.sort((a, b) => (a.agentId === b.agentId ? (a.taskLabels[0] || '').localeCompare(b.taskLabels[0] || '') : a.agentId.localeCompare(b.agentId)))
    return { children: rows }
  }

  /**
   * v1.5.2→v1.5.4：显式关闭子代理线程（agent_close 工具）——主模型在确认某条线程
   * "不再继续"时调用：立即停止复用（移除池条目、清释放定时器/历史记录）并释放驻留资源。
   * 参数二选一：
   *   - childId：关闭指定子代理（必须在复用池、活跃映射或历史记录中且属于当前会话）；
   *   - agentId：关闭该 Agent 在当前会话的全部闲置子代理（复用池条目 + 历史记录）。
   * 运行中的子代理不打断当前任务：只移除复用资格，任务结束后由宿主 settled /
   * product-subagents idleTimeoutMs 自然回收。
   * ACP 后台进程：本方法释放 in-process 中继 agent；ACP 进程本身仍由
   * product-subagents 的 idleTimeoutMs 定时器收尾（最后一轮 subagent/end 时已启动倒计时）。
   * @param {object} parentAgent 调用方 agent（exec.agent）
   * @param {{childId?: string, agentId?: string}} sel 关闭目标
   * @returns {Promise<{closed: Array<{childId: string, agentId: string, closing: 'drained'|'running'}>}>}
   */
  async closeChild(parentAgent, { childId, agentId } = {}) {
    const parentSessionId = parentAgent?.session?.id ?? null
    const targets = []
    if (childId) {
      const entry = [...this.childPool.values()].find((e) => e.childId === childId)
      if (entry) {
        if (entry.parentSessionId !== parentSessionId) {
          throw new Error(`子代理 ${childId} 不属于当前会话，无法关闭`)
        }
        targets.push(entry)
      } else {
        const active = this.activeChildren.get(childId)
        if (active) {
          if (active.parentSessionId !== parentSessionId) {
            throw new Error(`子代理 ${childId} 不属于当前会话，无法关闭`)
          }
          targets.push({ key: null, childId, agentId: active.agentId, parentSessionId, releaseTimer: null })
        } else {
          // v1.5.4：也查找 completedFresh 历史记录
          const hist = this.completedFresh.get(childId)
          if (hist) {
            if (hist.parentSessionId !== parentSessionId) {
              throw new Error(`子代理 ${childId} 不属于当前会话，无法关闭`)
            }
            targets.push({ key: null, childId, agentId: hist.agentId, parentSessionId, releaseTimer: null, fromHistory: true })
          } else {
            throw new Error(`未找到子代理 ${childId}（不在复用池/活跃映射/历史记录中）`)
          }
        }
      }
    } else if (agentId) {
      const seen = new Set()
      for (const e of this.childPool.values()) {
        if (e.agentId === agentId && e.parentSessionId === parentSessionId) {
          seen.add(e.childId)
          targets.push(e)
        }
      }
      // v1.5.4：也关闭该 Agent 在历史记录中的条目（去重：同一 childId 可能同时在池和活跃映射中）
      for (const h of this.completedFresh.values()) {
        if (h.agentId === agentId && h.parentSessionId === parentSessionId && !seen.has(h.childId)) {
          seen.add(h.childId)
          targets.push({ key: null, childId: h.childId, agentId: h.agentId, parentSessionId, releaseTimer: null, fromHistory: true })
        }
      }
      if (targets.length === 0) {
        throw new Error(`Agent ${agentId} 当前没有可关闭的闲置子代理（复用池/历史记录为空）`)
      }
    } else {
      throw new Error('agent_close 需要 childId 或 agentId 之一')
    }
    const closed = []
    for (const t of targets) {
      if (t.key && this.childPool.get(t.key) === t) {
        if (t.releaseTimer) clearTimeout(t.releaseTimer)
        this.childPool.delete(t.key)
        if (this.byAgent.get(t.agentId) === t.childId) this.byAgent.delete(t.agentId)
      }
      // v1.5.4：也清理 completedFresh 历史记录
      this.completedFresh.delete(t.childId)
      const running = this.activeChildren.has(t.childId)
      if (!running) await this.#drainChild(t.parentSessionId, t.childId)
      closed.push({ childId: t.childId, agentId: t.agentId, closing: running ? 'running' : 'drained' })
      this.#log({
        kind: 'close',
        agentId: t.agentId,
        childId: t.childId,
        parentSessionId,
        closing: running ? 'running' : 'drained',
        ok: true,
      })
    }
    return { closed }
  }

  /**
   * v1.5.0：丢弃一个复用池条目（复用失败/父会话结束/插件卸载）。
   * 注意：丢弃不等于释放驻留——驻留回收仍由 idle 定时器或宿主 lineage 回收负责。
   */
  #dropPool(entryKey, err) {
    const pooled = this.childPool.get(entryKey)
    if (!pooled) return
    if (pooled.releaseTimer) clearTimeout(pooled.releaseTimer)
    this.childPool.delete(entryKey)
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
    // v1.5.4：也清理该父会话的 completedFresh 历史记录
    for (const [childId, h] of [...this.completedFresh.entries()]) {
      if (h.parentSessionId === parentSessionId) this.completedFresh.delete(childId)
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
    this.completedFresh.clear() // v1.5.4
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
   * v1.5.4：检查 childId 是否在复用池中（用于 onChildEnd 判断是否需要插入
   * completedFresh 历史记录——池内线程由池条目驱动显示，不重复记录）。
   */
  #isInPool(childId) {
    for (const e of this.childPool.values()) {
      if (e.childId === childId) return true
    }
    return false
  }

  /**
   * v1.5.4：淘汰 completedFresh 超限条目（全局 COMPLETED_FRESH_CAP=50），
   * 按 completedAt 降序保留最新的，最旧的被移除。
   */
  #pruneCompletedFresh() {
    if (this.completedFresh.size <= COMPLETED_FRESH_CAP) return
    const entries = [...this.completedFresh.values()].sort((a, b) => a.completedAt - b.completedAt)
    const remove = entries.slice(0, entries.length - COMPLETED_FRESH_CAP)
    for (const e of remove) this.completedFresh.delete(e.childId)
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
