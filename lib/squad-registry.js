// dsh-agent-dispatch — 小队注册表（v0.2.2）。
//
// 内置小队模板与用户自定义小队统一存 $DSH_HOME/data/dsh-agent-dispatch/squads.json，
// 编辑保存即生效（与 agents.json 同机制）。内置 3 队 + 用户扩展；
// deletedIds 防内置复活机制与Agent 注册表一致。
//
// SquadTemplate 结构：
//   { id, name, emoji, description, builtin?, steps: [{ agentId, phase, dependsOn: [idx], instruction }] }
//   — dependsOn 为步骤下标数组，空数组 = 首批并行
//   — instruction 支持 {input}（用户目标）与 {prev:N}（第 N 步结果摘要）占位符

import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_SQUADS, topoLayers } from './squads.js'

/**
 * rename 重试：杀软、网络盘、并发清理等场景下偶发 ENOENT/EPERM/EBUSY。
 * 短暂退避后重试；仍失败则抛出，由调用方降级处理（绝不致命）。
 */
async function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; ; i += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (err) {
      const retriable = err && ['ENOENT', 'EPERM', 'EBUSY', 'EACCES'].includes(err.code)
      if (!retriable || i >= attempts - 1) throw err
      await new Promise((r) => setTimeout(r, 10 * (i + 1)))
    }
  }
}

export class SquadRegistry {
  /** 串行写盘队列（私有字段先声明后使用） */
  #writeChain = Promise.resolve()

  /** @param {string} dataDir 数据目录 */
  constructor(dataDir) {
    this.file = path.join(dataDir, 'squads.json')
    /** @type {Array<object>} */
    this.squads = []
    /** @type {string[]} 用户删除的内置小队 id（防复活） */
    this.deletedIds = []
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (Array.isArray(raw.squads)) this.squads = raw.squads
      if (Array.isArray(raw.deletedIds)) this.deletedIds = raw.deletedIds
    } catch {
      // 首次启动/损坏：重建
    }
    // 合入未删除且未覆盖的内置小队
    const present = new Set(this.squads.map((s) => s.id))
    for (const d of DEFAULT_SQUADS) {
      if (!this.deletedIds.includes(d.id) && !present.has(d.id)) this.squads.push({ ...d, builtin: true })
    }
    // 标记 builtin（用户恢复内置 id 时保持）+ 兼容旧数据缺 enabled 字段（默认启用）
    // v0.8.9：内置小队不再预置 emoji——一次性迁移：内置项且仍是历史预置值则清空（用户自设不动）
    const LEGACY_SQUAD_EMOJI = new Set(['🏗️', '🛠️', '🔍'])
    for (const s of this.squads) {
      if (DEFAULT_SQUADS.some((d) => d.id === s.id)) {
        s.builtin = true
        if (LEGACY_SQUAD_EMOJI.has(s.emoji)) s.emoji = ''
      }
      if (s.enabled === undefined) s.enabled = true
    }
    await this.#write()
    return this
  }

  list() {
    return this.squads.map((s) => ({
      ...s,
      steps: (s.steps || []).map((st) => ({ ...st, dependsOn: [...(st.dependsOn || [])] })),
    }))
  }

  get(id) {
    return this.list().find((s) => s.id === id) ?? null
  }

  /**
   * 校验小队定义：id kebab-case、steps 非空、agentId 非空、dependsOn 引用合法下标、无环。
   * 不校验Agent存在性（Agent 可后配；执行时缺 Agent按跳过处理）。
   */
  validate(squad) {
    if (!squad || typeof squad !== 'object') throw new Error('小队必须是对象')
    if (typeof squad.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(squad.id)) {
      throw new Error(`小队 id 必须为 kebab-case: ${JSON.stringify(squad.id)}`)
    }
    if (typeof squad.name !== 'string' || !squad.name.trim()) throw new Error(`小队 ${squad.id} 的 name 必填`)
    if (!Array.isArray(squad.steps) || squad.steps.length === 0) throw new Error(`小队 ${squad.id} 至少需要一个步骤`)
    squad.steps.forEach((st, i) => {
      if (typeof st.agentId !== 'string' || !st.agentId.trim()) throw new Error(`步骤 ${i + 1} 缺 agentId`)
      if (typeof st.phase !== 'string' || !st.phase.trim()) throw new Error(`步骤 ${i + 1} 缺 phase`)
      if (typeof st.instruction !== 'string' || !st.instruction.trim()) throw new Error(`步骤 ${i + 1} 缺 instruction`)
      // checkpoint 可选布尔：true = 该步执行完暂停等用户确认，不继续后续步骤（结果级停等）
      if (st.checkpoint !== undefined && typeof st.checkpoint !== 'boolean') {
        throw new Error(`步骤 ${i + 1} 的 checkpoint 必须是布尔值`)
      }
      for (const d of st.dependsOn ?? []) {
        if (!Number.isInteger(d) || d < 0 || d >= squad.steps.length) {
          throw new Error(`步骤 ${i + 1} 依赖 ${d} 越界`)
        }
      }
    })
    topoLayers(squad.steps) // 抛错即有环
  }

  async upsert(squad) {
    this.validate(squad)
    const normalized = {
      id: squad.id,
      name: squad.name,
      emoji: typeof squad.emoji === 'string' ? squad.emoji : '',
      description: typeof squad.description === 'string' ? squad.description : '',
      enabled: squad.enabled !== false, // v0.8.2：小队开关（默认启用）
      steps: squad.steps.map((st) => ({
        agentId: st.agentId,
        phase: st.phase,
        dependsOn: [...(st.dependsOn || [])],
        instruction: st.instruction,
        checkpoint: st.checkpoint === true, // v1.3.0：结果级停等开关（默认 false）
      })),
      builtin: squad.builtin === true || DEFAULT_SQUADS.some((d) => d.id === squad.id),
    }
    const idx = this.squads.findIndex((s) => s.id === normalized.id)
    if (idx === -1) this.squads.push(normalized)
    else this.squads[idx] = normalized
    this.deletedIds = this.deletedIds.filter((x) => x !== normalized.id)
    await this.#write()
    return normalized
  }

  /** v0.8.2：启用/禁用小队；存在则更新并写盘返回 true，不存在返回 false */
  async setEnabled(id, enabled) {
    const squad = this.squads.find((s) => s.id === id)
    if (!squad) return false
    squad.enabled = enabled !== false
    await this.#write()
    return true
  }

  /** @returns {Promise<boolean>} 是否真删了 */
  async remove(id) {
    const idx = this.squads.findIndex((s) => s.id === id)
    if (idx === -1) return false
    this.squads.splice(idx, 1)
    this.deletedIds.push(id)
    await this.#write()
    return true
  }

  /**
   * 原子写盘（tmp + rename），串行队列防并发覆盖。
   *
   * v1.12.x：临时文件名原先固定为 `squads.json.tmp`，但多个 dsh 实例（多窗口 /
   * 多端口）共用同一数据目录：实例 A 的 rename 会把 B 的 tmp 移走，B 随后 rename
   * 得到 ENOENT；该异常在插件加载阶段未被兜住，导致 `dsh: fatal load failure`
   * 让整个服务起不来（用户现场：端口回退到 3081）。
   * 现改为：① tmp 名带 pid + 时间戳 + 随机串，每个写者独占；② rename 失败短暂重试；
   * ③ 写盘失败降级为「内存状态 + 告警」，绝不上抛拖垮 dsh 启动。
   */
  async #write() {
    const run = async () => {
      const payload = JSON.stringify({ version: 1, squads: this.squads, deletedIds: this.deletedIds }, null, 2)
      const tmp = path.join(
        path.dirname(this.file),
        `squads.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
      )
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(tmp, payload, 'utf8')
      try {
        await renameWithRetry(tmp, this.file)
      } finally {
        try { fs.unlinkSync(tmp) } catch { /* 已 rename 走或不存在：忽略 */ }
      }
    }
    this.#writeChain = this.#writeChain.catch(() => {}).then(run)
    try {
      return await this.#writeChain
    } catch (err) {
      console.warn('[dsh-agent-dispatch] 小队注册表写盘失败（已降级为内存状态，服务继续运行）:', err?.message ?? err)
    }
  }
}
