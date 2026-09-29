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

/**
 * 「不指定模型 / 不指定档位」的唯一判据（v1.11.12 增量 3）：
 * 字段缺失、空串、字符串 'default'（大小写不敏感）三者同义。
 *
 * 存在的意义是**单点判定**：手写 agents.json 的用户无论写哪种，GUI 回显、
 * 落盘归一化、派发期是否下发 set_config_option 必须走同一个判断，否则
 * 「空串当不指定、'default' 却下发出一个名为 default 的模型」这类分叉迟早出现。
 * 非字符串一律按"已指定"处理，交给各自的类型校验去报错（不在此处兜错）。
 */
export function isUnspecifiedSetting(value) {
  if (typeof value !== 'string') return value === undefined || value === null
  const s = value.trim().toLowerCase()
  return s === '' || s === 'default'
}

/**
 * 校验单个路由项 {provider, model, effort?}。
 *
 * model 是否必填取决于路由类型：
 *   - LLM 路由：必须指定（缺 model 无法激活适配器；'default'/空串都算未指定 → 报错）；
 *   - ACP（subagent provider）路由：允许 isUnspecifiedSetting 的任一形态，
 *     语义是"用产品自己的默认模型"（派发期不向产品下发 model，由 ACP 用自身默认值）。
 * 类型判定与 dispatch 一致，由调用方注入 isSubagentProvider（通常是
 * (p) => !!ctx.subagents?.getProvider?.(p)）。谓词缺失或抛错时按 LLM 处理（从严）。
 *
 * @param {Array} routes
 * @param {(provider: string) => boolean} [isSubagentProvider]
 */
function validateRoutes(routes, isSubagentProvider) {
  if (!Array.isArray(routes)) {
    throw new Error('routes 必须是数组')
  }
  const acpOnly = typeof isSubagentProvider === 'function'
  for (const r of routes) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      throw new Error(`路由项必须是对象: ${JSON.stringify(r)}`)
    }
    if (typeof r.provider !== 'string' || r.provider.trim() === '') {
      throw new Error(`路由项缺少非空 provider: ${JSON.stringify(r)}`)
    }
    let isAcp = false
    if (acpOnly) {
      try {
        isAcp = !!isSubagentProvider(r.provider.trim())
      } catch {
        isAcp = false
      }
    }
    const hasModel = !isUnspecifiedSetting(r.model)
    if (!hasModel && !isAcp) {
      throw new Error(`路由项缺少有效 model（缺失 / 空串 / 'default' 都表示未指定；仅 ACP 路由可用它表示产品默认模型）: ${JSON.stringify(r)}`)
    }
    // v1.11.21：显式要求 model 是字符串。此前只在归一化时调 `.model.trim()`，非字符串会以
    // `TypeError: r.model.trim is not a function` 这种看不出所以然的形态炸在写盘路径上；
    // 而读盘路径又不能抛（一条坏记录不该让整个注册表初始化失败），于是被归一化悄悄写成
    // `String(123)` = '123'。这里把类型判定收到门禁上：**写路径响亮拒绝**，读路径按"未指定"处理。
    if (hasModel && typeof r.model !== 'string') {
      throw new Error(`路由项 model 必须是字符串（空串或 'default' 表示不指定）: ${JSON.stringify(r)}`)
    }
    if (r.effort !== undefined && r.effort !== null && typeof r.effort !== 'string') {
      // 空串 / 'default' = 不指定档位（GUI「默认」项提交 ""），与 undefined 同义
      throw new Error(`路由项 effort 必须是字符串（空串或 'default' 表示不指定）: ${JSON.stringify(r)}`)
    }
  }
}

/** v1.5.0：reusePolicy 合法值——'reuse' 复用同角色子代理（默认）/ 'fresh' 每次新开 */
const REUSE_POLICIES = ['reuse', 'fresh']

/** 校验 upsert 传入的 Agent 必填字段 */
function validateAgent(agent, isSubagentProvider) {
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
  validateRoutes(agent.routes, isSubagentProvider)
}

/**
 * v1.11.21：把一条 Agent 规整为固定结构的存储对象（**写盘与读盘共用同一口径**）。
 *
 * 为什么读盘也必须过这一手：磁盘上的 agents.json 可能被手工编辑、或由旧版本写入，
 * 缺 `emoji` / `triggers` 之类的可选字段。这些字段会原样进 `agent_list` 的工具出参，
 * 而宿主对工具出参做「无损 JSON」校验（`snapshotJsonValue`）——值为 `undefined` 的
 * 自有属性会在 JSON 往返中被丢弃，于是**整次调用**失败：
 *   tool "agent_list" returned invalid output: value is not lossless JSON
 * 升级前只校验 `id` 就采用磁盘对象，属于"写路径安全、读路径暴露"的不对称；
 * 现在两条路径都走这里，缺字段一律落成空串/默认值，出参形状恒定。
 *
 * 与 `validateAgent` 的分工：validateAgent 是**写路径的准入门禁**（不合格就抛错，
 * 不落盘）；本函数是**形状归一化**（不抛错，尽力把对象填成合法形状）——读盘时不能用
 * 门禁，否则一条坏记录会让整个注册表初始化失败。
 *
 * @param {object} agent 待规整的 Agent（可来自 upsert 入参或磁盘）
 * @returns {object} 固定键集、无 undefined 值的存储对象
 */
export function normalizeAgent(agent) {
  const id = typeof agent?.id === 'string' ? agent.id : ''
  const name = typeof agent?.name === 'string' && agent.name.trim() !== '' ? agent.name : id
  const normalized = {
    id,
    name,
    emoji: typeof agent?.emoji === 'string' ? agent.emoji : '',
    triggers: typeof agent?.triggers === 'string' ? agent.triggers : '',
    systemPrompt: typeof agent?.systemPrompt === 'string' ? agent.systemPrompt : '',
    // 「不指定」的三种形态（缺失 / 空串 / 'default'）统一不落键：手写 agents.json
    // 与 GUI 选「默认」得到同一个存储对象，派发期也就必然走"不发 set_config_option"。
    routes: (Array.isArray(agent?.routes) ? agent.routes : [])
      .filter((r) => r && typeof r === 'object' && typeof r.provider === 'string' && r.provider.trim() !== '')
      .map((r) => {
        const out = { provider: r.provider }
        // v1.11.21：只接受字符串形态的 model/effort。写路径由 validateRoutes 门禁兜住
        // （非字符串直接抛错）；读盘路径遇到手写文件里的数字/布尔值时按"未指定"处理——
        // 不替它编造 `String(123)`='123' 这种看着合法、实则用户从未配过的值。
        if (typeof r.model === 'string' && !isUnspecifiedSetting(r.model)) out.model = r.model.trim()
        if (typeof r.effort === 'string' && !isUnspecifiedSetting(r.effort)) out.effort = r.effort.trim()
        return out
      }),
    reusePolicy: agent?.reusePolicy === 'fresh' ? 'fresh' : 'reuse', // v1.5.0
    enabled: agent?.enabled !== false,
  }
  // P1/P2：routing 配置（quality 冷却参数 / upgrade 回归开关）——有则深拷贝透传。
  // 刻意不 try/catch：读盘输入来自 JSON.parse（结构上不可能有循环引用），能在这里抛错的
  // 只有写路径传入的畸形对象——那种情况应当照旧抛给调用方，而不是静默丢掉用户配置。
  if (agent?.routing !== undefined && agent.routing !== null && typeof agent.routing === 'object' && !Array.isArray(agent.routing)) {
    normalized.routing = JSON.parse(JSON.stringify(agent.routing))
  }
  return normalized
}

/**
 * 磁盘对象是否**已偏离**规整形状。
 *
 * v1.11.21 现状：读盘只归一化内存、不据此回写磁盘（见 `init()` 的说明），因此本判定
 * 目前**没有生产调用点**，仅作为"本条是否需要规整"的显式契约保留给测试与后续诊断。
 * 保留理由：它把"什么算偏离"写成了可测的形式，比隐式比较 JSON 文本可靠——手写文件的
 * 键序不同不应被当成偏离。
 * @param {object} raw 磁盘上的原始条目
 * @returns {boolean} true = 存在会被 normalizeAgent 改写的字段
 */
export function needsNormalize(raw) {
  if (!raw || typeof raw !== 'object') return true
  if (typeof raw.id !== 'string' || raw.id === '') return true // id 为空：归一化后 name 会退回 id=''，与磁盘不同
  if (typeof raw.emoji !== 'string') return true
  if (typeof raw.triggers !== 'string') return true
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return true
  if (typeof raw.systemPrompt !== 'string') return true
  if (!Array.isArray(raw.routes)) return true
  if (raw.routes.some((r) => !r || typeof r !== 'object' || typeof r.provider !== 'string' || r.provider.trim() === '')) return true
  if (raw.routes.some((r) => typeof r.model === 'string' ? false : r.model !== undefined && r.model !== null)) return true
  if (raw.routes.some((r) => typeof r.effort === 'string' ? false : r.effort !== undefined && r.effort !== null)) return true
  if (raw.reusePolicy !== 'reuse' && raw.reusePolicy !== 'fresh') return true
  if (typeof raw.enabled !== 'boolean') return true
  if (raw.routing !== undefined && (raw.routing === null || typeof raw.routing !== 'object' || Array.isArray(raw.routing))) return true
  return false
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

    // 文件存在：逐条规整后采用（v1.11.21——读盘与写盘同口径，磁盘对象缺
    // emoji/triggers 等可选字段时不再把 undefined 带进工具出参，见 normalizeAgent）
    const byId = new Map()
    for (const a of stored.agents) {
      if (a && typeof a === 'object' && typeof a.id === 'string') byId.set(a.id, normalizeAgent(a))
    }
    this.agents = [...byId.values()]

    // version 升级处理从简：直接采用当前默认配置，不迁移旧数据
    this.config = { ...DEFAULT_CONFIG, ...(stored.config && typeof stored.config === 'object' ? stored.config : {}) }
    this.config.version = DEFAULT_CONFIG.version
    // v1.11.21 决定：读盘**只归一化内存、不回写磁盘**。
    // 回写曾被认为能"让内存与磁盘一致"，但它是**整文件**重写：只要有一条偏离形状，
    // 全部条目都会按 normalizeAgent 口径落盘（未知键被清除、无效路由项被丢弃）——
    // 启动期发生无声的数据变更，代价大于收益（工具出参的 undefined 问题在内存里就已解决，
    // 下一次正常写盘（upsert/setEnabled）自然会带上规整后的形状）。
    // 另：`id:''` 这类条目曾让回写判定恒真 → 每次启动白写一次盘，去掉回写也一并消除。
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
   *
   * @param {object} agent
   * @param {{isSubagentProvider?: (provider: string) => boolean}} [opts]
   *        ACP 路由判定谓词（见 validateRoutes）；不传则所有路由按 LLM 从严校验。
   */
  async upsert(agent, opts = {}) {
    validateAgent(agent, opts?.isSubagentProvider)

    // 规整为固定结构的存储对象，丢弃无关字段
    const normalized = normalizeAgent(agent)

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
