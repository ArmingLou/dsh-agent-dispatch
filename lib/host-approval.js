// lib/host-approval.js — v1.10.0 主代理宿主审批分档规则引擎。
//
// 背景：主代理（宿主 ApprovalService 层）的审批请求（dsh-sandbox 的 bash 越权
// 重试、PreToolUse hook 的 ask 等）原先只有宿主标准面板的「允许一次 / 拒绝」。
// 本模块提供两个作用域档的路径白名单，供 index.js 的 'approval/request'
// waterfall 监听器（prepend，dsh-user-approval ApprovalService.decide 的
// ctx.waterfall 链头）做自动放行判定：
//
//   - 「本会话总是允许」：内存规则，键 = 发起请求的 session id，值为路径规则
//     集合；会话 dispose 时由 index.js 清理。
//   - 「总是允许(项目)」：落盘共用文件
//     $DSH_HOME/data/dsh-plugin-product-subagents/allowlist.json
//     （{version, rules:[{cwd, product?, paths, grantedAt, note}]}，tmp+rename 原子写），
//     键 = cwd + 路径，同项目跨会话生效。
//     与 product-subagents（ACP 层）共用同一文件，双向复用：
//     主代理落盘的条目 ACP 层可命中，ACP 层落盘的条目主代理也可命中。
//     覆盖判定忽略 product 字段——只比 cwd+paths。
//
// 路径来源：审批请求 req 只有 {agent, toolName, callId?, reason?, signal}
// （dsh-user-approval/lib/types/types.d.ts:55-66）；路径经 callId 反查会话记录
// ——session.eventAt(seq) 从 seq-1 向前扫 type==='tool/call' &&
// data.callId===callId 的记录（dsh-session/lib/index.js:1331 eventAt、
// dsh-agent-loop/lib/index.js:294-301 appendToolCall：落盘先于执行先于审批）。
// data.arguments 是模型原始 JSON 字符串，parse 后按 edit/write 的路径字段 +
// bash 命令文本正则提取（对齐 dsh-plugin-product-subagents/lib/bridges/acp.js
// 的 extractPaths 做法）。
//
// 语义对齐（与 product-subagents lib/allowlist.js、lib/user-allowlist.js 保持
// 一致，可直接比对）：normalizeCandidate（~ 展开、去尾标点）、pathAllowed
// （目录边界前缀匹配）、allowlistDecision（全部路径被覆盖才放行；解析不出
// 任何路径的请求不参与规则匹配）。规则写入只由用户在授权球点选触发
// （REST /agent-api/host-approval-rule），服务端按 callId 重取路径，不信任
// 客户端提交的路径。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// ── 路径规范化与匹配（与 product-subagents lib/allowlist.js 逐行同语义）──

/** 规范化候选路径：展开 ~、去尾部分隔符与常见干扰符号 */
export function normalizeCandidate(raw) {
  if (typeof raw !== 'string') return null
  let p = raw.trim().replace(/^["']|["']$/g, '')
  p = p.replace(/[,;:)\]}>，。；]+$/, '')
  if (!p) return null
  if (p === '~') return os.homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * v1.10.2：规则路径补直接父目录。
 * ACP 子代理的权限请求形态为 [文件, 直接父目录]（external_directory patterns），
 * 而主代理宿主审批从工具调用解析出的路径常只有文件级——若只记文件，
 * 子代理复用主代理落盘规则时会因"父目录未被覆盖"而弹窗。
 * 对每条路径：本身 + 直接父目录（若路径是已存在目录则不再向上补）；
 * 若父目录与自身相同（根路径）则跳过。返回去重后的绝对路径列表。
 */
export function expandPathsWithParents(paths) {
  const out = []
  for (const raw of paths || []) {
    const p = normalizeCandidate(raw)
    if (!p || !path.isAbsolute(p)) continue
    const normP = path.normalize(p)
    out.push(normP)
    let isDir = false
    try { isDir = fs.statSync(normP).isDirectory() } catch { /* 路径不存在视为文件 */ }
    if (!isDir) {
      const parent = path.dirname(normP)
      if (parent && parent !== normP) out.push(parent)
    }
  }
  return [...new Set(out)]
}

/**
 * 判断路径是否命中某条白名单规则。
 * 规则支持：目录前缀（含尾部 /** 或 *）、精确文件路径；~ 展开；目录边界匹配
 * （/a/b 规则命中 /a/b/x 但不命中 /a/bc）。
 */
export function pathAllowed(candidate, rules) {
  const p = normalizeCandidate(candidate)
  if (!p || !Array.isArray(rules) || rules.length === 0) return false
  for (const rawRule of rules) {
    if (typeof rawRule !== 'string' || !rawRule.trim()) continue
    let rule = rawRule.trim().replace(/["']/g, '')
    const isDir = /[/\\]\*\*$|[/\\]\*$/.test(rule) || /[/\\]$/.test(rule)
    rule = rule.replace(/[/\\]\*\*$|[/\\]\*$/, '')
    if (rule.length > 1) rule = rule.replace(/[/\\]+$/, '')
    rule = normalizeCandidate(rule)
    if (!rule) continue
    if (!path.isAbsolute(rule) || !path.isAbsolute(p)) continue
    const normP = path.normalize(p)
    const normRule = path.normalize(rule)
    if (normP === normRule) return true
    if (isDir && (normP.startsWith(normRule + path.sep) || normP.startsWith(normRule + '/'))) return true
    if (!isDir && !/\.[A-Za-z0-9]{1,8}$/.test(normRule) && (normP.startsWith(normRule + path.sep) || normP.startsWith(normRule + '/'))) {
      return true
    }
  }
  return false
}

/**
 * 白名单决策：请求涉及的所有路径是否全部命中白名单。
 * @param {string[]} paths  提取的请求路径（可能为空）
 * @param {string[]} rules  白名单规则
 * @returns {{allowed: boolean, covered: string[], uncovered: string[]}}
 */
export function allowlistDecision(paths, rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return { allowed: false, covered: [], uncovered: [...(paths || [])] }
  }
  const covered = []
  const uncovered = []
  for (const p of paths || []) {
    if (pathAllowed(p, rules)) covered.push(p)
    else uncovered.push(p)
  }
  if ((paths || []).length === 0) return { allowed: false, covered: [], uncovered: [] }
  return { allowed: uncovered.length === 0, covered, uncovered }
}

// ── 路径提取（对齐 product-subagents lib/bridges/acp.js 的 extractPaths）──

const PATH_KEY = /(^|_)(path|file|dir|directory|target|src|dest|source|uri|location)(_|$)/i
const PATH_RE = /(~|\/Users\/|\/Volumes\/|\/tmp\/|\/private\/|\/home\/|\/etc\/|\/usr\/|\/var\/|\/opt\/|\/workspace\/|\/workspaces\/)[^\s"'`]+/g

/**
 * 从工具调用参数对象中提取涉及的文件路径。
 * edit/write 系走路径字段（file_path/path/dir/...），bash 系从 command 文本
 * 正则抓绝对/家目录路径；递归遍历数组与嵌套对象。去重、保序。
 * @param {object|null} args 已 parse 的工具参数对象
 * @returns {string[]}
 */
export function extractToolPaths(args) {
  const out = new Set()
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      for (const m of node.matchAll(PATH_RE)) out.add(m[0].replace(/[,;:)\]}>]+$/, ''))
      return
    }
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (PATH_KEY.test(k) && typeof v === 'string' && v.length > 0 && !v.includes(' ')) {
          out.add(v)
        }
        walk(v)
      }
    }
  }
  walk(args)
  return [...out]
}

// ── callId → 会话记录反查 ──

/**
 * 从会话事件日志反查 tool/call 记录：从 session.seq-1 向前扫
 * type==='tool/call' && data.callId===callId 的最近一条。
 * 事件结构 {turn, step, callId, name, arguments(JSON 字符串)}
 * （dsh-session/lib/types/types.d.ts:303-309）。工具落盘先于执行先于审批，
 * 时序有保证；找不到返回 null。
 * @param {object} session 宿主 Session（有 eventAt/seq）
 * @param {string} callId
 * @returns {{name: string, arguments: string}|null}
 */
export function findToolCallRecord(session, callId) {
  if (!session || typeof session.eventAt !== 'function' || typeof session.seq !== 'number' || !callId) return null
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const ev = session.eventAt(seq)
    if (ev && ev.type === 'tool/call' && ev.data && ev.data.callId === callId) {
      return { name: ev.data.name, arguments: ev.data.arguments }
    }
  }
  return null
}

/**
 * 解析一次宿主审批请求的完整上下文（供规则判定与浮球展示）。
 * 路径一律由服务端从会话记录解析，不信任客户端。
 * @param {object} params {session, callId?, toolName?, reason?}
 * @returns {{toolName: string|null, paths: string[], reason: string|null, cwd: string|null, callId: string|null, callFound: boolean}}
 */
export function resolveApprovalContext({ session, callId, toolName, reason }) {
  const cwd = session?.header?.cwd ?? null
  const paths = []
  let resolvedToolName = typeof toolName === 'string' && toolName ? toolName : null
  let callFound = false
  const rec = findToolCallRecord(session, callId)
  if (rec) {
    callFound = true
    if (!resolvedToolName && rec.name) resolvedToolName = rec.name
    let args = null
    if (typeof rec.arguments === 'string' && rec.arguments.trim()) {
      try { args = JSON.parse(rec.arguments) } catch { args = null }
    } else if (rec.arguments && typeof rec.arguments === 'object') {
      args = rec.arguments
    }
    if (args && typeof args === 'object') {
      for (const p of extractToolPaths(args)) paths.push(p)
    }
  }
  return {
    toolName: resolvedToolName,
    paths: [...new Set(paths)],
    reason: typeof reason === 'string' && reason ? reason : null,
    cwd,
    callId: typeof callId === 'string' && callId ? callId : null,
    callFound,
  }
}

// ── 规则存储：会话（内存）+ 项目（共用落盘）──

const FILE_NAME = 'allowlist.json'
const VERSION = 1

function getSharedDir() {
  return path.join(
    process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    'data',
    'dsh-plugin-product-subagents',
  )
}

/**
 * 宿主审批分档规则引擎。
 * - 会话规则：Map<sessionId, Set<规则路径>>，进程内存，session dispose 清理；
 * - 项目规则：共用 $DSH_HOME/data/dsh-plugin-product-subagents/allowlist.json
 *   （与 product-subagents 同文件，原子写 tmp+rename），
 *   {version, rules:[{cwd, product?, paths, grantedAt, note}]}
 *   主代理写入的条目 product 省略（或 'main'，仅展示/审计用）；
 *   覆盖判定忽略 product——双向复用：主代理落盘的条目 ACP 层可命中，反之亦然。
 *   判定：cwd 规范化相同 + 请求全部路径被覆盖（语义对齐 product-subagents
 *   lib/user-allowlist.js + lib/allowlist.js）。
 */
export class HostApprovalRules {
  /** @type {Map<string, Set<string>>} */
  #sessionRules = new Map()
  /** @type {Map<string, object>} 暂存审批请求解析上下文（callId → resolveApprovalContext 结果），供 REST 端点查询 */
  #pendingContexts = new Map()
  #sharedDir
  #file

  constructor(dataDir) {
    this.#sharedDir = getSharedDir()
    this.#file = path.join(this.#sharedDir, FILE_NAME)
  }

  /** 项目规则文件路径（测试与诊断用） */
  get filePath() { return this.#file }

  /** 暂存审批请求解析上下文（供客户端 GET/POST 时服务端重取路径） */
  pushPendingContext(callId, ctx) {
    if (!callId || !ctx) return
    this.#pendingContexts.set(callId, ctx)
  }

  /** 取出并删除暂存上下文（单次消费） */
  popPendingContext(callId) {
    if (!callId) return null
    const ctx = this.#pendingContexts.get(callId)
    if (ctx) this.#pendingContexts.delete(callId)
    return ctx ?? null
  }

  /** 窥视暂存上下文（不删除；供客户端 GET context 后仍可 POST rule 重取路径） */
  peekPendingContext(callId) {
    if (!callId) return null
    return this.#pendingContexts.get(callId) ?? null
  }

  // ── 会话规则（内存）──

  /** 追加一条会话规则（路径规则去重合并） */
  addSessionRule(sessionId, paths) {
    if (!sessionId || typeof sessionId !== 'string' || !Array.isArray(paths)) {
      return { ok: false, error: 'sessionId 或 paths 缺失' }
    }
    const clean = [...new Set(paths.filter((p) => typeof p === 'string' && p.trim()))]
    if (clean.length === 0) return { ok: false, error: 'paths 为空' }
    // v1.10.2：补直接父目录——ACP 子代理权限请求形态为 [文件, 父目录]，
    // 主代理工具调用解析出的路径常只有文件级；不补父目录则子代理无法复用主代理规则。
    const expanded = expandPathsWithParents(clean)
    let set = this.#sessionRules.get(sessionId)
    if (!set) { set = new Set(); this.#sessionRules.set(sessionId, set) }
    for (const p of expanded) set.add(p)
    return { ok: true, count: set.size }
  }

  /** 某会话的规则路径列表（只读快照） */
  sessionRules(sessionId) {
    const set = this.#sessionRules.get(sessionId)
    return set ? [...set] : []
  }

  /** 会话结束清理；返回是否存在过规则 */
  purgeSession(sessionId) {
    return this.#sessionRules.delete(sessionId)
  }

  /** 会话规则是否覆盖全部请求路径 */
  sessionRulesCover(sessionId, reqPaths) {
    if (!sessionId || !Array.isArray(reqPaths) || reqPaths.length === 0) return false
    const set = this.#sessionRules.get(sessionId)
    if (!set || set.size === 0) return false
    return allowlistDecision(reqPaths, [...set]).allowed
  }

  // ── 项目规则（共用落盘）──

  /** 读项目授权白名单（只读；损坏/缺失 → 空规则 + 告警） */
  readProjectRules() {
    try {
      if (!fs.existsSync(this.#file)) return []
      const raw = JSON.parse(fs.readFileSync(this.#file, 'utf8'))
      const rules = Array.isArray(raw && raw.rules) ? raw.rules : []
      return rules.filter((r) => r && typeof r === 'object' && Array.isArray(r.paths))
    } catch (err) {
      console.warn(`[dsh-agent-dispatch] 宿主审批共用白名单读取失败（按空处理，下次写入自愈）: ${err.message}`)
      return []
    }
  }

  /**
   * 追加一条项目规则（原子写共用文件）。cwd 为必填作用域（会话工作目录）；
   * 相同 (cwd, paths 集合) 幂等合并（只更新时间与 note，忽略 product 差异）。
   * 主代理条目 product 省略；product-subagents 条目可能带 product 字段——
   * 判定与去重均忽略 product（双向复用语义）。
   */
  appendProjectRule(rule) {
    const rules = this.readProjectRules()
    const norm = {
      cwd: typeof rule.cwd === 'string' && rule.cwd.trim() ? path.normalize(rule.cwd.trim()) : null,
      paths: [...new Set(expandPathsWithParents(Array.isArray(rule.paths) ? rule.paths.filter((p) => typeof p === 'string' && p.trim()) : []))],
      grantedAt: rule.grantedAt || new Date().toISOString(),
      note: typeof rule.note === 'string' ? rule.note : '用户在授权球点击总是允许(项目)',
    }
    if (!norm.cwd || norm.paths.length === 0) return { ok: false, error: 'cwd 或 paths 缺失' }
    if (!path.isAbsolute(norm.cwd)) return { ok: false, error: 'cwd 必须是绝对路径' }
    // 去重：忽略 product——(cwd, paths集合) 相同即视为同一条规则
    const dup = rules.find((r) =>
      r.cwd === norm.cwd &&
      JSON.stringify([...(r.paths || [])].sort()) === JSON.stringify([...norm.paths].sort()),
    )
    if (dup) {
      dup.grantedAt = norm.grantedAt
      dup.note = norm.note
      // 主代理不覆盖已有 product 字段（保留子代理审计信息）
    } else {
      // 主代理条目不带 product（product-subagents 条目会带）
      rules.push(norm)
    }
    try {
      fs.mkdirSync(this.#sharedDir, { recursive: true })
      const tmp = path.join(this.#sharedDir, `.${FILE_NAME}.tmp`)
      fs.writeFileSync(tmp, JSON.stringify({ version: VERSION, rules }, null, 2), 'utf8')
      fs.renameSync(tmp, this.#file)
      return { ok: true, count: rules.length }
    } catch (err) {
      console.error(`[dsh-agent-dispatch] 宿主审批共用白名单写入失败: ${err.message}`)
      return { ok: false, error: err.message }
    }
  }

  /**
   * 项目规则是否覆盖本次请求（cwd 相同 + 全部路径命中该规则）。
   * 判定忽略 product 字段——与 product-subagents userRulesCover 同语义：
   * 遍历全部规则，只要 cwd 匹配且 paths 全覆盖即放行。
   */
  projectRulesCover(cwd, reqPaths) {
    if (!cwd || !Array.isArray(reqPaths) || reqPaths.length === 0) return false
    const normCwd = path.normalize(String(cwd))
    for (const rule of this.readProjectRules()) {
      if (!rule.cwd) continue
      if (path.normalize(String(rule.cwd)) !== normCwd) continue
      if (allowlistDecision(reqPaths, rule.paths).allowed) return true
    }
    return false
  }

  // ── 判定 ──

  /**
   * 分档判定：会话规则 → 项目规则（cwd 匹配 + 全部路径被覆盖）。
   * 解析不出路径（paths 为空）的请求不参与规则匹配。
   * @param {{sessionId?: string, cwd?: string|null, paths: string[]}} req
   * @returns {{allowed: boolean, scope: 'session'|'project'|null, covered: string[], uncovered: string[]}}
   */
  decide({ sessionId, cwd, paths }) {
    if (!Array.isArray(paths) || paths.length === 0) {
      return { allowed: false, scope: null, covered: [], uncovered: [] }
    }
    if (sessionId) {
      const set = this.#sessionRules.get(sessionId)
      if (set && set.size > 0) {
        const d = allowlistDecision(paths, [...set])
        if (d.allowed) return { allowed: true, scope: 'session', covered: d.covered, uncovered: [] }
      }
    }
    if (cwd && this.projectRulesCover(cwd, paths)) {
      return { allowed: true, scope: 'project', covered: [...paths], uncovered: [] }
    }
    const d = allowlistDecision(paths, [])
    return { allowed: false, scope: null, covered: [], uncovered: d.uncovered }
  }
}
