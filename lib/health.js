/**
 * dsh-agent-dispatch —— Provider 健康状态机（P1/P2：失败冷却 + 向上回归）
 *
 * routes 互备原本只在"创建期"生效（startContinuable reject 才换下一路由）；
 * 运行期失败（ACP 子代理 429 熔断耗尽 / 空正文 / 超时，child 以 error 结束）
 * 不会触发任何换路——任务失败后下一个任务仍从 routes[0] 开始，哪怕它刚失败过。
 *
 * 本模块给运行期失败加上记忆：
 *
 *   - recordFailure(agentId, provider)：连续失败计数；ACP relay 子代理以 error
 *     结束视为 hard failure（立即开冷却，因为 relay 子代理本身不产生任务逻辑
 *     错误，error 只可能来自 product_submit 抛错 = 产品侧失败）；spawn LLM
 *     模式的任务失败可能只是任务本身难，连续 failThreshold 次才开冷却。
 *     冷却时长 = min(maxCooldownMs, cooldownMs * backoff^(n-threshold))，
 *     + resumeHoldMs 延迟一拍（防冷却刚到期立即回归造成 flap）。
 *   - recordSuccess(agentId, provider)：清零（恢复后下一个 429 从基准重新开始）。
 *   - availableRoutes(agentId, routes)：过滤掉冷却中的 provider（保留原序）。
 *   - highestReadyProvider(agentId, routes)：routes 中第一个未冷却的 provider
 *     （= 当前应回归到的最高档）。
 *
 * 配置（agents.json 的 agent.routing.quality，读盘原样保留；upsert 透传）：
 *   {
 *     "routing": {
 *       "quality": { "failThreshold": 2, "cooldownMs": 60000,
 *                    "cooldownBackoff": 3, "maxCooldownMs": 600000,
 *                    "resumeHoldMs": 30000 },
 *       "upgrade": { "onNewRound": true, "preferExistingChild": true,
 *                    "handoff": "summary", "keepDegradedChild": true }
 *     }
 *   }
 *
 * 纯 JavaScript ESM 模块，无外部依赖；状态仅存内存（重启清零可接受——
 * 冷却本来就是短时保护，不是持久惩罚）。
 */

const DEFAULT_QUALITY = {
  failThreshold: 2, // spawn LLM 模式：连续失败多少次才开冷却
  cooldownMs: 60000, // 基准冷却 60s（与 product-subagents rateLimitBackoffMs 对齐）
  cooldownBackoff: 3, // 每次额外失败冷却 ×3（60s → 180s → 540s…）
  maxCooldownMs: 600000, // 单步冷却上限 10 分钟
  resumeHoldMs: 30000, // 冷却到期后再延迟一拍才允许回归（防 flap）
}

export class ProviderHealth {
  /** @param {{registry?: object}} [opts] registry 用于读 agent.routing 配置 */
  constructor({ registry } = {}) {
    this.registry = registry ?? null
    /** Map<`${agentId}::${provider}`, {failCount, cooldownUntil, lastOkAt}> */
    this.state = new Map()
  }

  /** 读 agent 的 routing.quality 配置（缺省默认） */
  qualityCfg(agentId) {
    try {
      const agent = this.registry?.get?.(agentId)
      const q = agent?.routing?.quality
      if (!q || typeof q !== 'object') return DEFAULT_QUALITY
      return {
        failThreshold: Number.isFinite(q.failThreshold) && q.failThreshold > 0 ? q.failThreshold : DEFAULT_QUALITY.failThreshold,
        cooldownMs: Number.isFinite(q.cooldownMs) && q.cooldownMs > 0 ? q.cooldownMs : DEFAULT_QUALITY.cooldownMs,
        cooldownBackoff: Number.isFinite(q.cooldownBackoff) && q.cooldownBackoff > 0 ? q.cooldownBackoff : DEFAULT_QUALITY.cooldownBackoff,
        maxCooldownMs: Number.isFinite(q.maxCooldownMs) && q.maxCooldownMs > 0 ? q.maxCooldownMs : DEFAULT_QUALITY.maxCooldownMs,
        resumeHoldMs: Number.isFinite(q.resumeHoldMs) && q.resumeHoldMs >= 0 ? q.resumeHoldMs : DEFAULT_QUALITY.resumeHoldMs,
      }
    } catch {
      return DEFAULT_QUALITY
    }
  }

  #key(agentId, provider) {
    return `${agentId}::${provider ?? ''}`
  }

  /**
   * 记录一次 provider 失败。
   * @param {string} agentId
   * @param {string} provider  route.provider（deveco / opencode / deepseek-official…）
   * @param {{hard?: boolean}} [opts] hard=true：ACP relay error（产品侧失败）立即开冷却
   * @returns {{cooldownUntil: number, cooldownMs: number, opened: boolean}} opened=本次是否进入冷却
   */
  recordFailure(agentId, provider, { hard = false } = {}) {
    if (!agentId || !provider) return { cooldownUntil: 0, cooldownMs: 0, opened: false }
    const cfg = this.qualityCfg(agentId)
    const key = this.#key(agentId, provider)
    const st = this.state.get(key) ?? { failCount: 0, cooldownUntil: 0, lastOkAt: 0 }
    st.failCount += 1
    const n = st.failCount
    const threshold = hard ? 1 : cfg.failThreshold
    let opened = false
    let cooldownMs = 0
    if (n >= threshold) {
      const extra = Math.max(0, n - threshold)
      cooldownMs = Math.min(cfg.maxCooldownMs, cfg.cooldownMs * cfg.cooldownBackoff ** extra)
      st.cooldownUntil = Date.now() + cooldownMs + cfg.resumeHoldMs
      opened = true
    }
    this.state.set(key, st)
    return { cooldownUntil: st.cooldownUntil, cooldownMs, opened, failCount: n }
  }

  /** 记录一次成功：清零失败计数与冷却（下一次失败从基准开始） */
  recordSuccess(agentId, provider) {
    if (!agentId || !provider) return
    const key = this.#key(agentId, provider)
    const st = this.state.get(key)
    if (!st) return
    st.failCount = 0
    st.cooldownUntil = 0
    st.lastOkAt = Date.now()
  }

  /** 某 (agent, provider) 当前是否在冷却中 */
  isCooling(agentId, provider) {
    if (!agentId || !provider) return false
    const st = this.state.get(this.#key(agentId, provider))
    return !!st && st.cooldownUntil > Date.now()
  }

  /**
   * 过滤冷却中的路由（保留原序）。全部冷却时返回空数组——
   * 调用方决定是等待还是按原路由硬试（见 dispatch）。
   * @returns {{available: object[], skipped: object[]}}
   */
  availableRoutes(agentId, routes) {
    const available = []
    const skipped = []
    for (const r of routes || []) {
      if (r && r.provider && this.isCooling(agentId, r.provider)) skipped.push(r)
      else available.push(r)
    }
    return { available, skipped }
  }

  /** routes 中第一个未冷却的 provider（= 应回归到的最高可用档）；无则 null */
  highestReadyProvider(agentId, routes) {
    const { available } = this.availableRoutes(agentId, routes)
    const top = available[0]
    return top && top.provider ? top.provider : null
  }

  /** 某 child 使用的 provider 是否属于该 agent 的 routes（区分 ACP relay / 外部 child） */
  isRoutedProvider(agentId, provider) {
    try {
      const routes = this.registry?.resolveRoutes?.(agentId) ?? []
      return routes.some((r) => r && r.provider === provider)
    } catch {
      return false
    }
  }

  /** 调试/面板：当前冷却中的 provider 快照 */
  snapshot() {
    const now = Date.now()
    const rows = []
    for (const [key, st] of this.state.entries()) {
      if (st.cooldownUntil > now) {
        const [agentId, provider] = key.split('::')
        rows.push({ agentId, provider, failCount: st.failCount, remainingMs: st.cooldownUntil - now })
      }
    }
    return rows.sort((a, b) => a.remainingMs - b.remainingMs)
  }
}
