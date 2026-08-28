/**
 * dsh-agent-dispatch —— 预置专家注册表
 *
 * 本模块管理"预置专家"注册表，负责专家的持久化存储、读取与增删改查。
 * 数据文件存于 $DSH_HOME/data/dsh-agent-dispatch/experts.json
 * （$DSH_HOME 缺省 ~/.dsh，即 process.env.DSH_HOME 不存在时回退 os.homedir()/.dsh；
 *  本插件运行在 DSH 宿主 Node 进程内，可安全使用 process.env.DSH_HOME）。
 *
 * 职责：
 *   - init()：读 experts.json；文件不存在时用 defaults.js 的 DEFAULT_EXPERTS 生成；
 *             存在时合并（新增内置专家补进去，用户已删的不复活——删除标记持久化在
 *             deletedIds；文件里已存在的内置专家保留用户覆盖；version 字段升级处理从简，
 *             直接采用当前默认版本号）。
 *   - list/get/upsert/remove/setEnabled/resolveRoutes：内存同步操作 + 异步写盘。
 *   - 写盘必须原子：先写同目录临时文件 .experts.json.tmp，再 rename 覆盖正式文件；
 *     写盘内容为 JSON.stringify(payload, null, 2)。读只发生在 init，之后全内存操作。
 *   - 校验失败抛 Error（中文消息）。
 *
 * 纯 JavaScript ESM 模块，仅依赖 node 内置模块（node:fs/node:path/node:os），无外部依赖。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_EXPERTS, DEFAULT_CONFIG } from './defaults.js'

/** 缺省数据目录：$DSH_HOME/data/dsh-agent-dispatch，$DSH_HOME 缺省 ~/.dsh */
const DEFAULT_DATA_DIR = path.join(
  process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
  'data',
  'dsh-agent-dispatch',
)

/** id 必须为 kebab-case：小写字母/数字开头，段间用单个连字符分隔 */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** 校验单个路由项 {provider, model, effort?} */
function validateRoutes(routes) {
  if (!Array.isArray(routes)) {
    throw new Error('routes 必须是数组')
  }
  for (const r of routes) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`路由项必须是对象: ${JSON.stringify(r)}`)
    }
    if (typeof r.provider !== 'string' || r.provider.trim() === '') {
      throw new Error(`路由项缺少非空 provider: ${JSON.stringify(r)}`)
    }
    if (typeof r.model !== 'string' || r.model.trim() === '') {
      throw new Error(`路由项缺少非空 model: ${JSON.stringify(r)}`)
    }
    if (r.effort !== undefined && (typeof r.effort !== 'string' || r.effort.trim() === '')) {
      throw new Error(`路由项 effort 必须是非空字符串: ${JSON.stringify(r)}`)
    }
  }
}

/** 校验 upsert 传入的专家必填字段 */
function validateExpert(expert) {
  if (expert === null || typeof expert !== 'object' || Array.isArray(expert)) {
    throw new Error('专家必须是对象')
  }
  if (typeof expert.id !== 'string' || expert.id.trim() === '' || !ID_PATTERN.test(expert.id)) {
    throw new Error(`专家 id 必须为非空 kebab-case 字符串（小写字母/数字，连字符分段）: ${JSON.stringify(expert.id)}`)
  }
  if (typeof expert.name !== 'string' || expert.name.trim() === '') {
    throw new Error(`专家 ${expert.id} 的 name 必须为非空字符串`)
  }
  if (typeof expert.systemPrompt !== 'string' || expert.systemPrompt.trim() === '') {
    throw new Error(`专家 ${expert.id} 的 systemPrompt 必须为非空字符串`)
  }
  validateRoutes(expert.routes)
}

export class ExpertRegistry {
  /** 串行写盘队列，避免并发写覆盖临时文件造成竞态 */
  #writeChain = Promise.resolve()

  /**
   * @param {string} [dataDir] 数据目录，缺省 $DSH_HOME/data/dsh-agent-dispatch
   */
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir
    this.filePath = path.join(dataDir, 'experts.json')
    this.tmpPath = path.join(dataDir, '.experts.json.tmp')
    /** 内存中的专家数组（含用户自定义与内置） */
    this.experts = []
    /** 用户删除过的内置专家 id 列表（持久化，防止 init 合并时复活） */
    this.deletedIds = []
    this.config = { ...DEFAULT_CONFIG }
  }

  /**
   * 初始化：读盘（仅此方法读盘），合并默认专家，必要时生成初始文件。
   */
  async init() {
    await fs.mkdir(this.dataDir, { recursive: true })

    let stored = null
    try {
      stored = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err // 文件损坏等异常直接抛出，不静默覆盖
      stored = null
    }

    // 文件不存在或结构不合法：用默认专家生成初始文件
    if (stored === null || !Array.isArray(stored.experts)) {
      this.experts = cloneExperts(DEFAULT_EXPERTS)
      this.deletedIds = []
      this.config = { ...DEFAULT_CONFIG }
      // 初始生成的专家为内置，打上 builtin 标记
      for (const e of this.experts) e.builtin = true
      await this.#write()
      return
    }

    // 读取用户删除过的内置专家 id（v1 起持久化；旧文件无此字段则视为未删除过）
    this.deletedIds = Array.isArray(stored.deletedIds) ? stored.deletedIds.filter((x) => typeof x === 'string') : []

    // 文件存在：合并。内置专家若已被用户删除（在 deletedIds 或不在文件里）不复活；
    // 已存在的内置专家保留用户在文件中的版本（可能被修改或禁用），但补上 builtin 标记。
    const byId = new Map()
    for (const e of stored.experts) {
      if (e && typeof e === 'object' && typeof e.id === 'string') byId.set(e.id, e)
    }
    const builtinIds = new Set(DEFAULT_EXPERTS.map((d) => d.id))
    // v0.8.9：内置 Agent 不再预置 emoji（UI 无 emoji 时显示 DSH logo）。
    // 一次性迁移：内置项且 emoji 仍是历史预置值 → 清空；用户自设 emoji 不动。
    const LEGACY_EMOJI = new Set(['📋', '🔍', '🛠️', '🗄️'])
    for (const e of byId.values()) {
      if (builtinIds.has(e.id)) {
        e.builtin = true
        if (LEGACY_EMOJI.has(e.emoji)) e.emoji = ''
      }
    }
    for (const d of DEFAULT_EXPERTS) {
      if (this.deletedIds.includes(d.id)) continue
      if (!byId.has(d.id)) byId.set(d.id, { ...d, routes: [...d.routes], builtin: true })
    }
    this.experts = [...byId.values()]

    // version 升级处理从简：直接采用当前默认配置，不迁移旧数据
    this.config = { ...DEFAULT_CONFIG, ...(stored.config && typeof stored.config === 'object' ? stored.config : {}) }
    this.config.version = DEFAULT_CONFIG.version
  }

  /** 返回专家数组（浅拷贝） */
  list() {
    return [...this.experts]
  }

  /** 按 id 取单个专家，不存在返回 undefined */
  get(id) {
    return this.experts.find((e) => e.id === id)
  }

  /**
   * 新增或更新专家：校验必填字段后写盘。
   * 已存在则覆盖（保留排序位置），不存在则追加到末尾。
   */
  async upsert(expert) {
    validateExpert(expert)

    // 规整为固定结构的存储对象，丢弃无关字段
    const normalized = {
      id: expert.id,
      name: expert.name,
      emoji: typeof expert.emoji === 'string' ? expert.emoji : '',
      triggers: typeof expert.triggers === 'string' ? expert.triggers : '',
      systemPrompt: expert.systemPrompt,
      routes: expert.routes.map((r) => ({ provider: r.provider, model: r.model, ...(r.effort !== undefined ? { effort: r.effort } : {}) })),
      enabled: expert.enabled !== false,
      // id 命中内置专家定义即视为内置（用户恢复删除的内置时也保持 builtin）
      builtin: expert.builtin === true || DEFAULT_EXPERTS.some((d) => d.id === expert.id),
    }

    const idx = this.experts.findIndex((e) => e.id === normalized.id)
    if (idx === -1) this.experts.push(normalized)
    else this.experts[idx] = normalized

    // upsert 同名 id 视为用户主动恢复，清除删除标记
    this.deletedIds = this.deletedIds.filter((x) => x !== normalized.id)

    await this.#write()
    return normalized
  }

  /** 删除专家；存在则删除并写盘返回 true，不存在返回 false。
   *  内置专家删除会记入 deletedIds 持久化，init 合并时不再复活；用户再次
   *  upsert 同名 id 视为主动恢复，清除删除标记。 */
  async remove(id) {
    const idx = this.experts.findIndex((e) => e.id === id)
    if (idx === -1) return false
    const expert = this.experts[idx]
    this.experts.splice(idx, 1)
    if (expert.builtin) this.deletedIds.push(id)
    await this.#write()
    return true
  }

  /** 启用/禁用专家；存在则更新并写盘返回 true，不存在返回 false */
  async setEnabled(id, enabled) {
    const expert = this.experts.find((e) => e.id === id)
    if (!expert) return false
    expert.enabled = enabled !== false
    await this.#write()
    return true
  }

  /** 返回专家路由数组（浅拷贝，可为空数组）；专家不存在时返回空数组 */
  resolveRoutes(id) {
    const expert = this.experts.find((e) => e.id === id)
    if (!expert) return []
    return [...(expert.routes || [])]
  }

  /** 原子写盘：写临时文件后 rename；所有写经串行队列，防并发竞态 */
  async #write() {
    const run = async () => {
      await fs.mkdir(this.dataDir, { recursive: true })
      const payload = {
        version: this.config.version ?? DEFAULT_CONFIG.version,
        config: this.config,
        deletedIds: this.deletedIds,
        experts: this.experts,
      }
      const json = JSON.stringify(payload, null, 2)
      await fs.writeFile(this.tmpPath, json, 'utf8')
      await fs.rename(this.tmpPath, this.filePath)
    }
    // 队列中前序写失败不阻塞后续写
    this.#writeChain = this.#writeChain.catch(() => {}).then(run)
    return this.#writeChain
  }
}

/** 深度浅拷贝专家数组（对象字段复制，routes 数组复制） */
function cloneExperts(list) {
  return list.map((e) => ({ ...e, routes: [...(e.routes || [])] }))
}
