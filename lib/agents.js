/**
 * dsh-agent-dispatch —— Agent 注册表
 *
 * 本模块管理 Agent 注册表，负责 Agent 的持久化存储、读取与增删改查。
 * 数据文件存于 $DSH_HOME/data/dsh-agent-dispatch/agents.json
 * （$DSH_HOME 缺省 ~/.dsh，即 process.env.DSH_HOME 不存在时回退 os.homedir()/.dsh；
 *  本插件运行在 DSH 宿主 Node 进程内，可安全使用 process.env.DSH_HOME）。
 *
 * 职责：
 *   - init()：读 agents.json；文件不存在时用 defaults.js 的 DEFAULT_AGENTS 生成
 *             （v1.1 起 DEFAULT_AGENTS 为空数组，即全新安装从空列表开始）。
 *   - list/get/upsert/remove/setEnabled/resolveRoutes：内存同步操作 + 异步写盘。
 *   - 写盘必须原子：先写同目录临时文件 .agents.json.tmp，再 rename 覆盖正式文件；
 *     写盘内容为 JSON.stringify(payload, null, 2)。读只发生在 init，之后全内存操作。
 *   - 校验失败抛 Error（中文消息）。
 *
 * 纯 JavaScript ESM 模块，仅依赖 node 内置模块（node:fs/node:path/node:os），无外部依赖。
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { DEFAULT_AGENTS, DEFAULT_CONFIG } from './defaults.js'

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

/** v1.5.0：reusePolicy 合法值——'reuse' 复用同角色子代理（默认）/ 'fresh' 每次新开 */
const REUSE_POLICIES = ['reuse', 'fresh']

/** 校验 upsert 传入的 Agent 必填字段 */
function validateAgent(agent) {
  if (agent === null || typeof agent !== 'object' || Array.isArray(agent)) {
    throw new Error('Agent 必须是对象')
  }
  if (typeof agent.id !== 'string' || agent.id.trim() === '' || !ID_PATTERN.test(agent.id)) {
    throw new Error(`Agent id 必须为非空 kebab-case 字符串（小写字母/数字，连字符分段）: ${JSON.stringify(agent.id)}`)
  }
  if (typeof agent.name !== 'string' || agent.name.trim() === '') {
    throw new Error(`Agent ${agent.id} 的 name 必须为非空字符串`)
  }
  if (typeof agent.systemPrompt !== 'string' || agent.systemPrompt.trim() === '') {
    throw new Error(`Agent ${agent.id} 的 systemPrompt 必须为非空字符串`)
  }
  if (agent.reusePolicy !== undefined && !REUSE_POLICIES.includes(agent.reusePolicy)) {
    throw new Error(`Agent ${agent.id} 的 reusePolicy 只能是 'reuse' 或 'fresh'（实际: ${JSON.stringify(agent.reusePolicy)}）`)
  }
  if (agent.routing !== undefined && (agent.routing === null || typeof agent.routing !== 'object' || Array.isArray(agent.routing))) {
    throw new Error(`Agent ${agent.id} 的 routing 必须是对象（quality/upgrade 配置）`)
  }
  validateRoutes(agent.routes)
}

export class AgentRegistry {
  /** 串行写盘队列，避免并发写覆盖临时文件造成竞态 */
  #writeChain = Promise.resolve()

  /**
   * @param {string} [dataDir] 数据目录，缺省 $DSH_HOME/data/dsh-agent-dispatch
   */
  constructor(dataDir = DEFAULT_DATA_DIR) {
    this.dataDir = dataDir
    this.filePath = path.join(dataDir, 'agents.json')
    this.tmpPath = path.join(dataDir, '.agents.json.tmp')
    /** 内存中的 Agent 数组 */
    this.agents = []
    this.config = { ...DEFAULT_CONFIG }
  }

  /**
   * 初始化：读盘（仅此方法读盘），必要时生成初始文件。
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

    // 文件不存在或结构不合法：用默认（空）Agent 列表生成初始文件
    if (stored === null || !Array.isArray(stored.agents)) {
      this.agents = cloneAgents(DEFAULT_AGENTS)
      this.config = { ...DEFAULT_CONFIG }
      await this.#write()
      return
    }

    // 文件存在：直接采用
    const byId = new Map()
    for (const a of stored.agents) {
      if (a && typeof a === 'object' && typeof a.id === 'string') byId.set(a.id, a)
    }
    this.agents = [...byId.values()]

    // version 升级处理从简：直接采用当前默认配置，不迁移旧数据
    this.config = { ...DEFAULT_CONFIG, ...(stored.config && typeof stored.config === 'object' ? stored.config : {}) }
    this.config.version = DEFAULT_CONFIG.version
  }

  /** 返回 Agent 数组（浅拷贝） */
  list() {
    return [...this.agents]
  }

  /** 按 id 取单个 Agent，不存在返回 undefined */
  get(id) {
    return this.agents.find((a) => a.id === id)
  }

  /**
   * 新增或更新 Agent：校验必填字段后写盘。
   * 已存在则覆盖（保留排序位置），不存在则追加到末尾。
   */
  async upsert(agent) {
    validateAgent(agent)

    // 规整为固定结构的存储对象，丢弃无关字段
    const normalized = {
      id: agent.id,
      name: agent.name,
      emoji: typeof agent.emoji === 'string' ? agent.emoji : '',
      triggers: typeof agent.triggers === 'string' ? agent.triggers : '',
      systemPrompt: agent.systemPrompt,
      routes: agent.routes.map((r) => ({ provider: r.provider, model: r.model, ...(r.effort !== undefined ? { effort: r.effort } : {}) })),
      reusePolicy: agent.reusePolicy === 'fresh' ? 'fresh' : 'reuse', // v1.5.0
      // P1/P2：routing 配置（quality 冷却参数 / upgrade 回归开关）——有则透传
      routing: agent.routing !== undefined && agent.routing !== null ? JSON.parse(JSON.stringify(agent.routing)) : undefined,
      enabled: agent.enabled !== false,
    }
    if (normalized.routing === undefined) delete normalized.routing

    const idx = this.agents.findIndex((a) => a.id === normalized.id)
    if (idx === -1) this.agents.push(normalized)
    else this.agents[idx] = normalized

    await this.#write()
    return normalized
  }

  /** 删除 Agent；存在则删除并写盘返回 true，不存在返回 false。 */
  async remove(id) {
    const idx = this.agents.findIndex((a) => a.id === id)
    if (idx === -1) return false
    this.agents.splice(idx, 1)
    await this.#write()
    return true
  }

  /** 启用/禁用 Agent；存在则更新并写盘返回 true，不存在返回 false */
  async setEnabled(id, enabled) {
    const agent = this.agents.find((a) => a.id === id)
    if (!agent) return false
    agent.enabled = enabled !== false
    await this.#write()
    return true
  }

  /** 返回 Agent 路由数组（浅拷贝，可为空数组）；Agent 不存在时返回空数组 */
  resolveRoutes(id) {
    const agent = this.agents.find((a) => a.id === id)
    if (!agent) return []
    return [...(agent.routes || [])]
  }

  /** P1/P2：返回 Agent 的 routing 配置对象（可能 undefined）；不存在返回 undefined */
  resolveRouting(id) {
    const agent = this.agents.find((a) => a.id === id)
    return agent?.routing
  }

  /** 原子写盘：写临时文件后 rename；所有写经串行队列，防并发竞态 */
  async #write() {
    const run = async () => {
      await fs.mkdir(this.dataDir, { recursive: true })
      const payload = {
        version: this.config.version ?? DEFAULT_CONFIG.version,
        config: this.config,
        agents: this.agents,
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

/** 深度浅拷贝 Agent 数组（对象字段复制，routes 数组复制） */
function cloneAgents(list) {
  return list.map((a) => ({ ...a, routes: [...(a.routes || [])] }))
}
