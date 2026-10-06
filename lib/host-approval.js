// lib/host-approval.js — v1.10.0 主代理宿主审批分档规则引擎。
//
// 背景：主代理（宿主 ApprovalService 层）的审批请求（dsh-sandbox 的 bash 越权
// 重试、PreToolUse hook 的 ask 等）原先只有宿主标准面板的「允许一次 / 拒绝」。
// 本模块提供两个作用域档的路径白名单，供 index.js 的 'approval/request'
// waterfall 监听器（prepend，dsh-user-approval ApprovalService.decide 的
// ctx.waterfall 链头）做自动放行判定：
//
//   - 「本会话总是允许」：内存规则，键 = 主会话根 id（非子代理自身 id），
//     值为路径规则集合 + 工具名授权集合；会话 dispose 时由 index.js 清理
//     （purgeSession 只清自身键：子会话 dispose 不删根授权，根会话 dispose 才清根授权
//     及所有指向该根的子会话映射。授权寿命 = 该主代理会话存续期间）。
//     「主会话根 id」的口径见 resolveRootSessionId：只有**委派子会话**
//     （header.origin==='subagent' 或 delegationDepth>0）才上溯父级；
//     fork（分叉会话）只带 parentSession、不带 origin/delegationDepth，
//     它是一个新的用户可见会话 → 自身即根，既不继承源会话授权，也不把自己的
//     授权写到源会话键上。
//   - 「总是允许(项目)」：落盘共用文件
//     $DSH_HOME/data/dsh-plugin-product-subagents/allowlist.json
//     （{version, rules:[{cwd, product?, paths, grantedAt, note}]}，tmp+rename 原子写），
//     键 = cwd + 路径（落盘条目不含工具名字段——工具名级放行只走内存 #toolGrants），
//     同项目跨会话生效。
//     与 product-subagents（ACP 层）共用同一文件，双向复用：
//     主代理落盘的条目 ACP 层可命中，ACP 层落盘的条目主代理也可命中。
//     覆盖判定忽略 product 字段——只比 cwd+paths。
//
// 工具名授权双通道边界：本插件的 #toolGrants 覆盖宿主审批链路
// （PreToolUse hook ask 等；**沙箱越权除外**——它既不得按工具名放行，也不得走
// 落盘项目档，只能走会话路径档，见 isDisallowedAutoGrant 与 decide 的
// disallowToolGrant / sessionOnly），键为主代理会话 id；
// product-subagents 的 sessionRules.toolGrants 覆盖 ACP 权限链路
// （product_submit 的权限请求），键也为主代理会话 id。两者互不感知、
// 互不干扰——同一工具名可能在两套各自命中或未命中，排障时需区分来源链路。
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
// 任何路径的请求不参与规则匹配）。规则写入由用户在授权球点选触发
// （REST /agent-api/host-approval-rule）：
//   - v1.12.5 及以前：路径一律服务端按 callId 重取，不信任客户端提交的路径；
//   - v1.12.6「可编辑路径」弹框：用户可以在弹框里改目录 / 删条目 / 删空，所以
//     客户端会**声明**路径。声明值仍以服务端 callId 解析为默认预填，提交回来的
//     列表按 validateDeclaredPaths 逐条校验（只认绝对路径、拒根目录、非法丢弃、
//     全非法 ⇒ 视同空），并且**不再补父目录**——用户声明的已经是目录。
// 「不信任客户端」在这里的含义从「不接受客户端路径」变成「接受但必须服务端校验」，
// 授权主体是用户本人。

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
 *
 * v1.12.6（终审 M1，用户裁定「接受目录级」）：**路径级记忆的粒度是目录，不是单个文件。**
 * 本函数补直接父目录、`pathAllowed`（:98）按目录前缀匹配，两者合起来的效果是
 * 「对 `/a/b/x.txt` 授权一次 ⇒ `/a/b/` 整个目录（含其后所有层级）在本档内不再弹」，
 * 换目录仍要问。这不是漏口而是设计：用户口径就是「把文件路径提取为上一级目录，
 * 指定路径往后的一切工具调用都放行」。写测试时按这条语义断言，别按"只记一个文件"断言。
 * 唯一的例外是 1.12.6「可编辑路径」弹框：用户已经**声明的是目录**，那条通道
 * 显式 `expand:false`（见 validateDeclaredPaths 与 addSessionRule / appendProjectRule），
 * 因为对一个目录再取父目录会把「放行 /tmp/newproj」放大成「放行 /tmp」。
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
 * v1.12.6 U2：校验客户端「可编辑路径」弹框提交的目录声明（**不可盲信客户端**）。
 *
 * 与 dsh-plugin-product-subagents 0.7.9 lib/permission-rules.js 的
 * validateDeclaredPaths **逐条同口径**（两侧必须对齐，否则同一份弹框结果在两条
 * 链路上被判成不同形态）：
 *   · `given=false`（未给 / 非数组）⇒ 老客户端 ⇒ 沿用服务端自动分析，行为一字不变；
 *   · `given=true` 且 declared 非空 ⇒ 只按用户声明的目录写路径档，**不补父目录**；
 *   · `given=true` 且 declared 为空（`[]` 或全被丢弃）⇒ 与「只要工具名」同义。
 * 只做**词法**规范化（解析 `.`/`..`、去尾部分隔符、展开 `~`），不做 realpath：
 * 客户端声明的是目录意图而不是磁盘真相，跟着软链走反而把授权挪到链外。
 * 根目录（`/`、`C:\`、UNC 根）单独拒掉——写进授权集等于该会话任意路径免弹。
 *
 * @param {unknown} raw 请求体里的 `paths`
 * @returns {{given: boolean, declared: string[], dropped: {reason: string, value: string}[]}}
 */
export function validateDeclaredPaths(raw) {
  const given = Array.isArray(raw)
  const declared = []
  const dropped = []
  if (!given) return { given, declared, dropped }
  for (const entry of raw) {
    const label = typeof entry === 'string' ? entry : `${typeof entry}:${String(entry).slice(0, 80)}`
    if (typeof entry !== 'string') {
      dropped.push({ reason: '非字符串', value: label })
      continue
    }
    const trimmed = entry.replace(/^["']|["']$/g, '').trim()
    if (!trimmed) {
      dropped.push({ reason: '空字符串', value: label })
      continue
    }
    if (trimmed.includes('\0') || trimmed.includes('\r') || trimmed.includes('\n')) {
      dropped.push({ reason: trimmed.includes('\0') ? '含 NUL' : '含换行', value: label })
      continue
    }
    const expanded = normalizeCandidate(trimmed)
    if (!expanded || !path.isAbsolute(expanded)) {
      dropped.push({ reason: '非绝对路径', value: label })
      continue
    }
    const norm = path.resolve(expanded).replace(/[/\\]+$/, '') || path.sep
    if (norm && path.dirname(norm) === norm) {
      dropped.push({ reason: '根目录', value: label })
      continue
    }
    if (!declared.includes(norm)) declared.push(norm)
  }
  return { given, declared, dropped }
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
 *
 * **返回值是「结构化字段 + 全文扫描」的并集**，与 1.12.6 之前的口径逐字节一致：
 * `paths` 同时是 `decide()` 的判定集与 `addSessionRule` 的 expand 输入，收窄它会
 * 连带改变自动放行范围。UI 要按可信度分档，用 extractToolPathGroups。
 * @param {object|null} args 已 parse 的工具参数对象
 * @returns {string[]}
 */
export function extractToolPaths(args) {
  const g = extractToolPathGroups(args)
  return [...new Set([...g.structured, ...g.inferred])]
}

/**
 * 同 extractToolPaths，但把两个来源**分开**返回：
 *   · `structured`——路径类字段（`PATH_KEY`）的**值**，即工具真正要操作的对象；
 *   · `inferred`——`PATH_RE` 从参数里**所有字符串**扫出来的路径，包括 `content` /
 *     `new_string` / `prompt` 这类**正文**字段。
 * 为什么要分开：正文是被编辑的**内容**，仓库里谁都能在里面写 `/etc/passwd`、
 * `~/.ssh`、`~/.qoder/settings.json`。混成一档交给 UI 预填，等于让用户
 * 一次「确认」就把这些敏感目录授权出去。同一字符串既是结构化值又被扫到一次时
 * 归结构化（不重复计入推测档）。
 * @param {object|null} args 已 parse 的工具参数对象
 * @returns {{structured: string[], inferred: string[]}}
 */
export function extractToolPathGroups(args) {
  const structured = []
  const loose = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      for (const m of node.matchAll(PATH_RE)) pushUnique(loose, m[0].replace(/[,;:)\]}>]+$/, ''))
      return
    }
    if (Array.isArray(node)) { for (const x of node) walk(x); return }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (PATH_KEY.test(k) && typeof v === 'string' && v.length > 0 && !v.includes(' ')) {
          pushUnique(structured, v)
        }
        walk(v)
      }
    }
  }
  walk(args)
  return { structured, inferred: loose.filter((p) => !structured.includes(p)) }
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value)
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
 * @returns {{toolName: string|null, paths: string[], structuredPaths: string[], inferredPaths: string[], reason: string|null, cwd: string|null, callId: string|null, callFound: boolean, commandText: string, argsText: string, execLikely: boolean}}
 */
export function resolveApprovalContext({ session, callId, toolName, reason }) {
  const cwd = session?.header?.cwd ?? null
  const paths = []
  let structured = []
  let inferred = []
  let resolvedToolName = typeof toolName === 'string' && toolName ? toolName : null
  let callFound = false
  let commandText = ''
  let argsText = ''
  const rec = findToolCallRecord(session, callId)
  if (rec) {
    callFound = true
    if (!resolvedToolName && rec.name) resolvedToolName = rec.name
    // v1.12.6 危险命令门：执行类的 shell 正文与路径取自**同一条记录**（口径同源）
    commandText = commandTextOf(rec.arguments)
    // 自定义执行工具（工具名/参数键都不在各自名单里）只跑 commandTextOf 会漏 ——
    // 这里把 args 里所有字符串值也带上，由门统一判（见 argsTextOf 的注释）
    argsText = argsTextOf(rec.arguments)
    let args = null
    if (typeof rec.arguments === 'string' && rec.arguments.trim()) {
      try { args = JSON.parse(rec.arguments) } catch { args = null }
    } else if (rec.arguments && typeof rec.arguments === 'object') {
      args = rec.arguments
    }
    if (args && typeof args === 'object') {
      const g = extractToolPathGroups(args)
      structured = g.structured
      inferred = g.inferred
      for (const p of [...g.structured, ...g.inferred]) paths.push(p)
    }
  }
  return {
    toolName: resolvedToolName,
    paths: [...new Set(paths)],
    // 与产品侧 0.7.9 的 suggestedDirs / inferredDirs **同一口径的两份来源**：
    // 产品侧给目录、宿主通道只给到路径原文，目录化留给客户端（dirsOfPaths）。
    // paths 仍是并集，自动判定与 1.12.6 之前逐字节一致。
    structuredPaths: structured,
    inferredPaths: inferred,
    reason: typeof reason === 'string' && reason ? reason : null,
    cwd,
    callId: typeof callId === 'string' && callId ? callId : null,
    callFound,
    // 危险命令门判据（命令文本解析不出来时为 '' ⇒ 执行类一律不自动放行）
    commandText,
    // 危险命令门的第二个来源：args 里所有字符串值（自定义执行工具那格）
    argsText,
    execLikely: isExecuteTool(resolvedToolName, rec ? rec.arguments : null),
  }
}

// ── 排除门判据：沙箱越权 / ACP 孪生不得被工具名直放；越权也不得走落盘项目档 ──

/**
 * 判断审批请求的 reason 是否为沙箱越权（不得被工具名授权直放）。
 * 宿主 dsh-sandbox 的越权审批 reason 形态为 `escalate sandbox to ${mode}: ${justification}`
 * （dsh-sandbox/lib/index.js:109）。用宽松正则匹配（容许前导空白/换行/多空格/大小写）：
 * 宿主文案可能变化，但「escalate sandbox to」前缀是宿主审批协议的一部分，短期内不会变。
 * 前导空白匹配只收紧方向（多弹窗），属安全侧。
 * @param {string|null} reason
 * @returns {boolean}
 */
export function isSandboxEscalation(reason) {
  return typeof reason === 'string' && /^\s*escalate\s+sandbox\s+to/i.test(reason)
}

/**
 * 判断审批请求是否为 ACP 孪生审批（不得被工具名授权直放）。
 * ACP 孪生的判据：toolName === 'product_submit' && reason 以 '[ACP ' 开头
 * （lib/client.js:3901-3902、test/acp-twin.test.js:61-62 先例）。
 * @param {string|null} toolName
 * @param {string|null} reason
 * @returns {boolean}
 */
export function isAcpTwinApproval(toolName, reason) {
  return toolName === 'product_submit' && typeof reason === 'string' && reason.startsWith('[ACP ')
}

/**
 * 综合判据：该审批请求是否**不得被工具名级授权直放**。
 * v1.12.6（终审 B1 修复后）这一判据只管**读取侧的工具名档**，与落盘无关：
 *   - 沙箱越权：不走工具名短路，也**不走落盘项目档**，只走会话路径档
 *     （decide 的 disallowToolGrant + sessionOnly）；
 *   - ACP 孪生：更严——调用方在它上面还有一道「本插件一档都不判」的早退门
 *     （index.js 的 isAcpTwinApproval 分支），根本走不到任何档位。
 * **写入侧不再用它**（v1.12.5 曾误用它，导致 ACP 孪生的项目档落盘被顺带吞掉）：
 * 落盘抑制的判据是「是不是沙箱越权」，即 isSandboxEscalation(reason) 单独一条——
 * 用户口径只要求越权受限，ACP 孪生「完全绕过、不动它」是明示要求。
 * @param {string|null} toolName
 * @param {string|null} reason
 * @returns {boolean}
 */
export function isDisallowedAutoGrant(toolName, reason) {
  return isSandboxEscalation(reason) || isAcpTwinApproval(toolName, reason)
}

// ── v1.12.6 危险命令排除门：与 product-subagents 侧同一份名单（单点常量）──

/**
 * 被视为「执行类」工具名的 slug（宿主侧 tool/call 记录的 name 字段：`bash`/`shell`/…）。
 * 与产品侧的 kind slug（'execute'/'exec'/…）**不是**同一个东西：产品侧拿 ACP 的
 * `kind` 字段，宿主侧只有工具名。两边判据各自成立，名单也各自维护。
 */
export const EXECUTE_TOOL_SLUGS = new Set([
  'bash', 'shell', 'sh', 'zsh', 'exec', 'execute', 'command', 'run', 'run_command',
  'terminal', 'powershell', 'pwsh', 'cmd',
])

/** 工具参数里装 shell 正文的键（按优先级） */
const COMMAND_ARG_KEYS = ['command', 'cmd', 'commandLine', 'commandline', 'script']

/**
 * 危险命令名单——**与 product-subagents 的 lib/dangerous-commands.js:79-83 同一份，
 * 需人工保持同步**（那边是 ACP toolCall 通道，这边是宿主 tool/call 通道，判据实现
 * 无法直接复用，故各自留一份并按同一口径维护）。
 *
 * 用户裁决：这三类命令**在任何档位下都必须走交互授权**——工具名档、会话路径档、
 * 落盘项目档都不许静默放行。
 *
 * 覆盖边界（诚实声明，与产品侧逐条对齐）：
 * - 覆盖：`rm -rf` / `rm -fr` / `rm -r -f` / `rm -f -R` / `rm --recursive --force`
 *   （必须**同时**具备递归与强制，`rm -r`、`rm -f` 单旗帜不触发，任意组合与顺序都认）；
 *   `npm publish` / `git push`（含前置全局选项：`npm --silent publish`、`git --no-pager push`）。
 * - 分段：按 `;`、`|`、`||`、`&`、`&&`、换行切子命令，**只对每段开头那条命令**判；
 *   引号内不切分。故 `echo "git push"`、`grep "git push" f`、`# rm -rf` 都不算危险。
 * - 大小写：命令名与子命令动词按小写比对（macOS 大小写不敏感卷上 `RM -RF x` 真的会执行）。
 * - 前导环境变量赋值会被跳过（`FOO=1 rm -rf x` 仍判危险）。
 * - **等价写法 / 包装写法同属一类**（v1.12.6 终审阻断修复，用户裁定「任何档位都必须
 *   走交互」）：
 *   · 透明包装：`sudo` / `command` / `env` / `nohup` / `nice` / `time` / `timeout` /
 *     `stdbuf` / `xargs`，含各自的选项与数值参数（`sudo -u root rm …`、`nice -n 10 rm …`、
 *     `timeout 5 rm …`），可叠加；**多调用二进制** `busybox` / `toybox` / `coreutils`
 *     （`busybox rm -rf x` 与 `rm -rf x` 同语义，程序名在**后一个** token 上）；
 *     v1.12.6 第五轮再补同族的 `doas` / `setsid` / `chroot` / `ionice` / `taskset`
 *     （`chroot` 的**第一个位置参数是新根**，由 `WRAPPER_POSITIONAL_ARGS` 跳过）；
 *     v1.12.6 第六轮再补**同族的另外 9 个**（`unshare` / `nsenter` / `strace` / `firejail` /
 *     `systemd-run` / `su` / `runuser` / `setarch` / `prlimit`）——它们同样是「换个身份/
 *     环境/跟踪器跑**同一条**命令」，词法可判定，各自的取值选项与位置参数按**真实 CLI
 *     语义**登记（`nsenter -t 1 -m rm …`、`strace -f rm …`、`systemd-run --user rm …`、
 *     `setarch x86_64 rm …`、`prlimit --pid 1 rm …`；`firejail` 的取值选项一律
 *     `--opt=value` 形态，不吃下一个 token）；`su` / `runuser` 另有 `-c '<正文>'`
 *     一条**与 `shell -c` 同原则**的路径：解析正文再喂给同一份规则，解不出正文
 *     （没有 `-c`，启动的是交互登录 shell）按 `SU_SHELL_RULE`（**可疑**）保守转交互；
 *   · 程序名按 **basename** 比对：`/bin/rm -rf`、`./rm -rf`、`/usr/bin/env rm -rf`；
 *   · 解一层 shell 包装：`sh|bash|zsh|dash|ksh -c '<body>'` 把 body 再喂给同一份规则，
 *     **递归上限 2 层**（`MAX_SHELL_UNWRAP_DEPTH`），第 3 层起按「可疑」保守转交互，
 *     不做无限展开、也不做完整 shell 解析器；`-c` 与正文**粘连**的写法
 *     （`bash -c'rm -rf /x'`、`sh -c"rm -rf /x"`）把粘连的首词拼回正文再判；
 *     反斜杠转义的引号（`bash -c "bash -c \"rm -rf /x\""`）按引号归一后再判；
 *   · 段首是 shell 解释器却**没有 `-c`**（裸解释器读 stdin：`printf '…' | bash`、
 *     `bash <<< '…'`；或读脚本文件：`bash deploy.sh`）：正文静态不可判定 ⇒ 按
 *     `SHELL_STDIN_RULE`（**可疑**）保守转交互，与 shell 深度上限同一原则；
 *   · 段首是 `source` 或 POSIX 的 `.`（`source deploy.sh` / `. deploy.sh` —— 与上面
 *     `bash deploy.sh` **同义**，都在当前 shell 里读脚本文件执行）⇒ 按
 *     `SHELL_SOURCE_RULE`（**可疑**）保守转交互（v1.12.6 第五轮补上，消除口径冲突）；
 *   · 透明包装**跳数用尽**（`MAX_WRAPPER_UNWRAP_HOPS`）且段首仍是包装器
 *     （`sudo`×9 + `rm -rf x`）⇒ 按 `WRAPPER_DEPTH_RULE`（**可疑**）保守转交互；
 *   · 命令动词判定跳过该命令自己的选项**与选项值**：`git -C <dir> push`、
 *     `git -c k=v push`、`npm --prefix <p> publish`、`pnpm -C <dir> publish`；
 *     选项表**短选项按真实大小写精确比对、长选项小写归一**（`optionKey`）——
 *     否则 `-C` 与 `-c` 比对不上（第四轮的形态），或者反过来把小写同形**开关**
 *     也命中（第七轮的形态：`unshare -r`、`strace -A` 吃掉真程序名 ⇒ 整段漏判）；
 *   · 剥壳结束后**仍可判可疑的兜底**（`WRAPPER_OPTION_AMBIGUITY_RULE`）：交给规则的
 *     头 token 以 `-` 开头（把选项当成了程序名），或某个被当成「取值」吃掉的 token
 *     其实自己就能起一条危险命令 ⇒ 保守转交互（详见 `wrapperOptionAmbiguity`）；
 *   · `pnpm publish` / `yarn publish` / `yarn npm publish` 与 npm 同语义，一并纳入（用户裁定）；
 *   · `find … -exec rm -rf {} +`（`-exec`/`-execdir`/`-ok`/`-okdir`）之后的子命令再喂给同一份
 *     规则 —— 同一份名单、另一条调用路径，不新增名单条目；**下标从 0 起扫**（v1.12.6 第五轮
 *     修掉的下标 0 盲区：`;` 会把 `-exec … {} \;` 切成子段，第二段**段首就是 `-exec`**）；
 *   · 自定义执行工具（工具名不在 EXECUTE_TOOL_SLUGS、参数键也不在 COMMAND_ARG_KEYS，
 *     例如 `{shell: 'rm -rf …'}`）：由 argsTextOf 把 args 里**所有字符串值**拼起来再判一次。
 * - **不覆盖（刻意的边界：静态不可判定）**：`python -c 'os.system("rm -rf")'`、
 *   把命令写进脚本/构建目标再执行（`make deploy`、`./deploy.sh` 这类**脚本文件直执行**；
 *   注意 `bash deploy.sh` **已按上面的 `SHELL_STDIN_RULE` 保守转交互**、`source deploy.sh`
 *   与 `. deploy.sh` 已按 `SHELL_SOURCE_RULE` 保守转交互——那些是「判不出它要执行什么」
 *   而不是放行）、`sh -c "$(curl …)"`、变量间接（`S=rm; $S -rf x`）、`eval`、argv 拆词数组
 *   （`{argv: ['rm','-rf','/']}`：按值分别判、不拼回一条命令）、把命令包给**会自己重建命令行**
 *   的工具（`npx` / `yarn dlx` / `docker run … <容器内命令>` / `parallel` / `watch`）。
 *   要覆盖这些需要真正的 shell 解析器 + 变量求值 + 读脚本文件 + 容器/包管理器语义，
 *   本门只做**词法级**判定，判不出的方向不在这里兜底，而是交给 index.js 那条保守策略
 *   （执行类解析不出正文 ⇒ 也不自动放行）。逐条清单见 CHANGELOG「第五轮 · M-C③」。
 * - **第 256KB 附近及之后不判**（v1.12.6 第五轮 · 终审 Minor 2 的取舍；第六轮把声明说准）：
 *   调用点用 `boundDangerText` 做有界截断（`MAX_DANGER_TEXT_CHARS` = 262144 **字符**），
 *   只判前段。边界是**字符下标上的硬切**、不是「切在命令边界上」：危险命令起点落在
 *   262136（= 上限 - 8）时仍完整命中，起点在 262141 / 262143 的会被切残
 *   （`rm -rf` 只剩 `r`）⇒ MISS。所以准话是「**第 256KB 附近及之后**首次出现的危险命令
 *   不保证转交互」（残余风险，方向是少弹）。两侧口径**不同**且是刻意的：
 *   `argsText`（args 里所有字符串值的拼接，含 `write` 的正文，大正文是常态）只截断；
 *   `commandText`（`command`/`cmd`/`script` 这类**真正的 shell 正文**，超长不是常态）
 *   自第六轮起**超限即保守转交互**（`COMMAND_TOO_LONG_RULE`）。
 * - 已知**多弹一次**的保守误报（安全方向，用户裁定不修，只登记）：
 *   · heredoc 正文里出现 `rm -rf`（正文按普通文本参与词法判定）；
 *   · `write`/`edit` 的正文参数里出现这三条命令，且**危险命令位于某一行/某一段的开头**
 *     （argsTextOf 把 args 里所有字符串值换行拼接，每条值自成一段、判定只看段首
 *     ⇒ `content='see git push docs'` 这种夹在中间的照旧放行）；
 *   · 裸解释器的纯信息调用（`bash --version` / `bash --help` / `sh -n script.sh`）按
 *     `SHELL_STDIN_RULE` 多弹一次；开窄口子是后续可选优化，本轮不做（见 CHANGELOG）。
 */
export const DANGEROUS_COMMAND_RULES = [
  { id: 'rm -rf', match: (tokens) => isRecursiveForceRemove(tokens) },
  { id: 'npm publish', match: (tokens) => subCommandVerb(tokens, 'npm', 'publish') },
  { id: 'pnpm publish', match: (tokens) => subCommandVerb(tokens, 'pnpm', 'publish') },
  { id: 'yarn publish', match: (tokens) => subCommandVerb(tokens, 'yarn', 'publish') },
  { id: 'git push', match: (tokens) => subCommandVerb(tokens, 'git', 'push') },
]

/** shell 包装最多展开 2 层（用户裁定：不做无限展开），再深按 SHELL_DEPTH_RULE 保守转交互 */
export const MAX_SHELL_UNWRAP_DEPTH = 2

/** 超过展开深度上限时给的门名：**可疑**（保守转交互），不是「确认危险」 */
export const SHELL_DEPTH_RULE = 'shell-nesting'

/**
 * 段首是 shell 解释器却**没有 `-c`**（`bash <<< 'rm -rf /x'`、`printf '…' | bash`、
 * `bash deploy.sh`）时给的门名：同样只到「**可疑**」这一档。
 * 裸解释器读 stdin / 读脚本文件，正文静态不可判定 ⇒ 与 shell 深度上限同一原则：保守转交互。
 */
export const SHELL_STDIN_RULE = 'shell-stdin'

/**
 * 段首是 `source`（或 POSIX 的 `.`）时给的门名：同样只到「**可疑**」这一档。
 * `source deploy.sh` / `. deploy.sh` 与 `bash deploy.sh` **同义**（都在当前 shell 里
 * 读一个脚本文件执行），正文静态不可判定——`bash deploy.sh` 第四轮已按
 * `SHELL_STDIN_RULE` 保守转交互，同义的 `source` 却放行，是**口径冲突**
 * （v1.12.6 第五轮 · 终审 M-C②）。两者同一原则：判不出不是放行。
 */
export const SHELL_SOURCE_RULE = 'shell-source'

/**
 * 段首是 `su` / `runuser` 却**没有 `-c`**（`su - root`、`su root`、`runuser -l root`、
 * `su --version`）时给的门名：它们启动的是**交互登录 shell**（或只打印用法/版本），
 * 正文静态不可判定 ⇒ 与 `SHELL_STDIN_RULE` / `SHELL_SOURCE_RULE` 同一原则：
 * 判不出不是放行，只到「**可疑**」这一档（保守转交互）。
 *
 * v1.12.6 第六轮（终审 M-D）：改前 `su root -c "rm -rf /x"` 与 `su root` 在判据层与
 * 监听器层都是**静默放行**——`su` / `runuser` 既不在包装器表、也不在危险命令规则里。
 * `su` / `runuser` 多了一条与 `shell -c` 同原则的路径（解析 `-c` 正文再判），
 * 只有**没有 `-c`** 时才落到这条「可疑」门（见 `matchSuShell`）。
 */
export const SU_SHELL_RULE = 'su-shell'

/** 透明包装最多剥 8 跳（`sudo sudo … rm -rf x`）；用尽后段首仍是包装器 ⇒ 见 WRAPPER_DEPTH_RULE */
export const MAX_WRAPPER_UNWRAP_HOPS = 8

/**
 * 透明包装剥了 `MAX_WRAPPER_UNWRAP_HOPS` 跳、段首**仍是包装器**时给的门名：**可疑**。
 * 与 shell 深度上限（SHELL_DEPTH_RULE）同一原则——到顶不是放行，是保守转交互；
 * 改前这里是静默放行（`sudo`×9 + `rm -rf` 判不出来 ⇒ 自动放行）。
 */
export const WRAPPER_DEPTH_RULE = 'wrapper-nesting'

/** 前导环境变量赋值 token（`FOO=1 rm -rf x` 里的 `FOO=1`） */
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * 透明包装器：不改变被包装命令的语义，剥掉后继续判（`sudo rm -rf x`）。
 * `busybox` / `toybox` / `coreutils` 是**多调用二进制**（`busybox rm -rf x` = `rm -rf x`），
 * 程序名与被执行的命令**不在同一个 token** 里，`basenameOf` 那类推法救不了 ⇒ 只能在此登记。
 * （`/bin/rm` 这种同 token 形态由 basenameOf 处理，与本表无关。）
 *
 * v1.12.6 第五轮（终审 M-C①）：补 `doas` / `setsid` / `chroot` / `ionice` / `taskset`
 * —— 同族的「换个身份/环境跑**同一条**命令」包装器，改前 `doas rm -rf /tmp/x`、
 * `setsid rm -rf /tmp/x` 等在判据层与监听器层都是**静默放行**。
 * 加进这张表只会**多**弹（把包装后的命令交给同一份规则判），不会少弹。
 * 其中 `chroot` 的**第一个位置参数是新根**（`chroot /mnt rm -rf x`），必须一起跳过 ——
 * 见 `WRAPPER_POSITIONAL_ARGS`；漏掉它会让「真程序名」变成 `/mnt` ⇒ 仍然静默放行。
 *
 * v1.12.6 第六轮（终审 M-D）：再补**同族的另外 9 个**（`unshare` / `nsenter` / `strace` /
 * `firejail` / `systemd-run` / `su` / `runuser` / `setarch` / `prlimit`）—— 改前这 9 条
 * （`unshare -m rm -rf /x`、`nsenter -t 1 -m rm -rf /x`、`strace -f rm -rf /x`、
 * `firejail rm -rf /x`、`systemd-run --user rm -rf /x`、`su root -c "rm -rf /x"`、
 * `runuser -u root -- rm -rf /x`、`setarch x86_64 rm -rf /x`、`prlimit rm -rf /x`）
 * 在判据层 MISS、监听器层 `allowed-once`（**静默放行**），而它们与 `setsid` 同类：
 * 「换个身份/环境/跟踪器跑**同一条**命令」，**词法可判定**。
 * 各自真实 CLI 语义的取值选项/位置参数见 `WRAPPER_VALUE_OPTIONS` / `WRAPPER_POSITIONAL_ARGS`
 * 两张表的注释（含「哪些选项**不**吃下一个 token」的取舍）。
 * `su` / `runuser` 是**唯一两条不走通用剥壳**的：`-c '<正文>'` 的正文会被空白切碎，
 * 通用剥壳会把正文拼坏 ⇒ 由 `matchSuShell` 专门处理（`-c` 正文递归同一份规则、
 * 没有 `-c` 则保守转交互）。见 `SU_WRAPPERS`。
 *
 * v1.12.6 第七轮（设计裁定第 10 条）：`su` / `runuser` **从本表移出**（原先它们登记在表里、
 * 却靠 `unwrapTransparentWrappers` 里一条「一见就原样交回」的早返回绕开剥壳 —— 两处事实
 * 来源）。移出后那条早返回**随之变死**，一并删掉：跳词逻辑改成由 `TRANSPARENT_WRAPPERS`
 * 那一次查表统一回答「这条要不要剥」。终审已实测「移出 + 删早返回」前后**逐字段相同**
 * （全量用例 538/538 全绿、156 条判据层探针逐行相同），故这里是**单一事实来源**的清理，
 * 不是行为变更。
 */
const TRANSPARENT_WRAPPERS = new Set([
  'sudo', 'doas', 'command', 'env', 'nohup', 'nice', 'time', 'timeout', 'stdbuf', 'xargs',
  'setsid', 'chroot', 'ionice', 'taskset',
  'unshare', 'nsenter', 'strace', 'firejail', 'systemd-run', 'setarch', 'prlimit',
  'busybox', 'toybox', 'coreutils',
  // ── v1.12.6 第八轮（终审 B2）：macOS 本机**同类**的 4 个「跑下一条命令」包装器 ──
  // 终审在部署平台（本机 macOS）用无害的 `/bin/echo HI` 逐条证实它们会把后面的命令跑起来，
  // 而这些形态改前在判据层 null、监听器层 allowed-once（**静默放行**）：
  //   `arch -x86_64 rm -rf /x`、`arch -arm64 git push`、`caffeinate -d rm -rf /x`、
  //   `script -q /dev/null rm -rf /x`、`xcrun rm -rf /x`。
  // 口径旁证：Linux 的孪生 `setarch` 早在名单里，macOS 的 `arch` 漏了（同一语义、两个平台名）。
  // 各自的取值选项/位置参数与**本机双向核对证据**见下面两张表。
  'arch', 'caffeinate', 'script', 'xcrun',
])

/**
 * `su` / `runuser`：**与透明包装同族、但不走通用剥壳**（段首是它们 ⇒ 由 `matchSuShell` 判）。
 * 理由：`-c` 的正文经空白切分后是**半个词**（`su root -c "rm -rf /x"` → `-c`、`"rm`、`-rf`、`/x"`），
 * 通用剥壳（把 `-c` 当普通开关、或用取值表吃掉它的下一个 token）都会把正文拼坏 ⇒ 漏判。
 * 取值表（`WRAPPER_VALUE_OPTIONS.su` / `.runuser`）被 `matchSuShell` 的跳词逻辑复用 ——
 * 表本身是**同一个事实来源**，这也是它们不必再登记进 `TRANSPARENT_WRAPPERS` 的原因
 * （v1.12.6 第七轮移出，见上面那张表的注释）。
 */
const SU_WRAPPERS = new Set(['su', 'runuser'])

/**
 * 选项查表键：**短选项（单个 `-`）原样**、**长选项（`--`）小写归一**。
 *
 * v1.12.6 第四轮（终审 B1）：查表前一律 `toLowerCase()`，而表里原先写着大小写原样的
 * `'-C'` / `'-S'` ⇒ `'-C' !== '-c'` ⇒ 该选项**吃掉的那个取值**（`pnpm -C /tmp publish`
 * 里的 `/tmp`）被当成程序名，`basenameOf(tokens[0])` 不再是 `pnpm`/`rm` ⇒ 整段不命中、
 * 静默放行。那轮改成「一律小写归一」。
 *
 * ⚠️ v1.12.6 第七轮（终审阻断 A）：**「一律小写归一」把短选项的大小写也抹平了** ——
 * 表里按真实大小写登记的 `-R` / `-N` / `-a` / `-p` 会同时命中它们的**小写同形开关**：
 * `unshare -R`↔`-r`（`--map-root-user` 是开关）、`nsenter -N`↔`-n`、
 * `strace -a`↔`-A`（`--output-append-mode` 是开关）、`systemd-run -p`↔`-P`
 * （`--pipe` 是开关）、`xargs -L`↔`-l`（`-l[max-lines]` 是**可选附着**）、
 * `xargs -P`↔`-p`（`--interactive` 是开关）⇒ 那个开关被误当成「取值选项」，
 * 紧跟其后的**真程序名被吃掉**（`unshare -r rm -rf /x` 里 `rm` 被当成 `-R` 的取值）
 * ⇒ 判据层 `null`、监听器层 `allowed-once`（**静默放行**）。
 * 修法：**短选项原样比对**（表内拼写必须是该选项的真实大小写），**长选项仍归一**
 * （GNU 长选项本该区分大小写，保留归一是为了兼容历史表内拼写，方向只影响"吃不吃取值"）。
 * 旁证：`git` 那张表第四轮把 `-C` 删成了「只留 `-c` 一个拼写」（当时两者归一成同一个键）
 * ⇒ 本轮必须把它写回来（`git -C <path>` 是取值选项，见下面的 `PROGRAM_VALUE_OPTIONS`）。
 */
const optionKey = (token) => {
  const t = String(token == null ? '' : token)
  return t.startsWith('--') ? t.toLowerCase() : t
}

/** 选项表构造：逐条走 `optionKey`（短选项保持原样、长选项小写） */
const optionSet = (arr) => new Set(arr.map(optionKey))

/** 会**吃掉下一个 token 作为取值**的包装器选项（`sudo -u root rm …`、`nice -n 10 rm …`） */
const WRAPPER_VALUE_OPTIONS = {
  // v1.12.6 第七轮（终审阻断 A）：短选项改成**大小写精确**（见 optionKey）后，必须把
  // `sudo` 真实大小写的取值选项补齐 —— 否则第四轮那种「靠小写折叠侥幸命中」的写法会**反向**丢命中：
  // `-R dir`(=`--chroot`)、`-T timeout`(=`--command-timeout`)、`-U user`(=`--other-user`)
  // 改前是撞上小写的 `-r` / `-t` / `-u` 才恰好把取值吃掉（`sudo -R /mnt rm -rf /x` 因此命中），
  // `-D dir`(=`--chdir`) 则本来就漏。四条都在本机 `man sudo`（sudo 1.9.x）的取值选项表里逐字核对过。
  sudo: optionSet(['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-R', '-T', '-U', '-D',
    '--user', '--group', '--prompt', '--close-from', '--host', '--role', '--type',
    '--chroot', '--command-timeout', '--other-user', '--chdir']),
  // v1.12.6 第八轮（终审 B1）：补 BSD/macOS 的 `-P utilpath`。
  // 本机双向核对（/usr/bin/env 是 macOS 自带，usage：`env [-0iv] [-C workdir] [-P utilpath] [-S string]`）：
  //   `env -P` → `env: option requires an argument -- P`（确实吃取值）；
  //   `env -P /bin /bin/echo HI` → `HI`（吃饱后真程序名才在命令位置）；
  //   `env -P /bin rm -rf /x` 改前判据层 null、监听器层 allowed-once —— 终审用真二进制执行过 `rm -rf`。
  env: optionSet(['-u', '-C', '-S', '-P', '--unset', '--chdir', '--split-string']),
  nice: optionSet(['-n', '--adjustment']),
  time: optionSet(['-o', '-f', '--output', '--format']),
  timeout: optionSet(['-k', '-s', '--kill-after', '--signal']),
  stdbuf: optionSet(['-i', '-o', '-e', '--input', '--output', '--error']),
  // v1.12.6 第七轮：**删掉 `-i`**（不是漏登记，是第四轮把它归错了类别）。GNU xargs 的
  // `-i[replace-str]` / `-l[max-lines]` / `-e[eof-str]` 是**可选参数、只能附着写**
  // （man 原文就带方括号：`-i[replace-str]`、`-l[max-lines]`，与 `-I replace-str` /
  // `-L max-lines` / `-E eof-str` 的区别正在这里）⇒ 它们**不吃下一个 token**。
  // 列进来的代价正是本轮的阻断形态：`xargs -i rm -rf /x` 里的 `rm` 被当取值吃掉 ⇒ 漏判。
  // `-I`/`-L`/`-P`/`-E` 继续列（它们真吃取值，`-p`/`-l` 是开关/可选附着，不列）。
  // v1.12.6 第八轮（终审 B1）：补 BSD 拼写 `-J replstr` / `-R replacements` / `-S replsize`
  // （macOS `/usr/bin/xargs` usage：`[-I replstr [-R replacements] [-S replsize]] [-J replstr]`）。
  // 本机双向核对（三条各自 `xargs -X` 都报 `option requires an argument`）：
  //   `printf 'a\n' | xargs -J % /bin/echo HI` → `HI a`；
  //   `printf 'a\nb\n' | xargs -I {} -R 2 /bin/echo HI` → `HI`×2；
  //   `printf 'a\n' | xargs -I {} -S 100 /bin/echo HI` → `HI`；
  //   `printf 'a\n' | xargs -J /bin/echo HI` → `xargs: HI: No such file or directory`
  //   （把真程序名当取值吃掉 ⇒ 反向证明 `-J` 恰好只吃一个 token）。
  // GNU 侧只有 `-S`（`--max-chars`）同名；`-J`/`-R` 在 GNU 上不存在（真机报错、不执行），
  // 登记它们只影响「吃不吃取值」，方向是**多弹**，不是漏。
  // 仍**不得**把 `-i` 加回来（见上面第七轮那段：`-i[replace-str]` 是可选附着、不吃下一个 token）。
  xargs: optionSet(['-I', '-n', '-L', '-s', '-P', '-E', '-d', '-a', '-J', '-R', '-S', '--replace', '--max-lines', '--max-args', '--max-chars', '--max-procs', '--eof', '--delimiter', '--arg-file', '--process-slot-var']),
  // v1.12.6 第五轮（终审 M-C①）：新增包装器各自的取值选项。
  // 表里**只列「吃掉下一个 token」的**（`-u root`、`-c 3`）；`-n`/`-s`/`-f`/`-w` 这类
  // 自带即完的开关不列（列了会把真程序名当成取值吃掉 ⇒ 反而漏判）。
  doas: optionSet(['-u', '-C', '--user', '--config']),
  ionice: optionSet(['-c', '-n', '-p', '-P', '--class', '--classdata', '--pid', '--pgid']),
  taskset: optionSet(['-c', '-p', '--cpu-list', '--pid']),
  // ── v1.12.6 第六轮（终审 M-D）：新增 9 个包装器的取值选项，**按各自真实 CLI 语义** ──
  // 取舍与第五轮相同：**只列「吃掉下一个 token」的**。两类**不列**：
  //   ① 自带即完的开关（`strace -f`、`unshare -m/-p/-n`、`nsenter -m/-u/-i/-n`、
  //      `systemd-run --user`、`prlimit -n` …）；
  //   ② 取值**必须用 `=`/粘连形态附着**的可选参数（`nsenter -m[=file]`、`unshare --kill-child[=sig]`、
  //      `prlimit -c/-n/-m…[=limits]`、`setarch --show[=persona]`）—— 它们不占下一个 token，
  //      而循环里 `t.includes('=')` 那一条已经把 `--nofile=1024` 这类形态跳过了。
  // 列错的方向是**把真程序名当取值吃掉**（`strace -f rm -rf /x` 里的 `-f` 若登记成取值选项，
  // `rm` 就被吃掉 ⇒ 反而漏判），所以宁可少列、不可多列。
  nsenter: optionSet(['-t', '--target', '-N', '--net-socket', '-G', '--setgid', '-S', '--setuid']),
  // `-m/-u/-i/-n/-p/-U/-C/-T/-r/-w/-W` 全是 `[=file]` 可选附着形态（man：`-m, --mount[=file|=:nsid]`）
  unshare: optionSet(['--map-user', '--map-users', '--map-group', '--map-groups', '--owner', '--propagation', '--setgroups', '-R', '--root', '-w', '--wd', '-S', '--setuid', '-G', '--setgid', '-l', '--load-interp', '--monotonic', '--boottime', '--whitelist-env']),
  // `-r` 是 `--map-root-user`（**开关**），`-R` 才是 `--root <dir>`（取值）——别写反
  strace: optionSet(['-e', '-E', '-p', '-u', '-b', '-I', '-P', '-a', '-o', '-s', '-U', '-O', '-S', '-X', '--trace', '--env', '--attach', '--user', '--detach-on', '--interruptible', '--trace-path', '--columns', '--output', '--string-limit', '--syscall-limit', '--stack-trace-frame-limit', '--argv0', '--namespace']),
  // `-f/-F/-D/-i/-n/-N/-k/-q/-r/-t/-T/-v/-x/-y/-c/-C/-d/-A/-z/-Z` 全是开关（含 `-c` = --count；
  // `-A` = `--output-append-mode` 也是开关 —— 正是它在下标为「大写形态」处被小写折叠成 `-a`
  // 才吃掉了真程序名）。v1.12.6 第七轮补齐真实大小写的取值选项：`-U columns`(=`--summary-columns`)、
  // `-O overhead`(=`--summary-syscall-overhead`)、`-S sortby`(=`--summary-sort-by`)、
  // `-X format`(=`--const-print-style`) —— 前三条改前同样是撞上小写的 `-u`/`-o`/`-s` 才侥幸命中，
  // 第四条本来就漏。四条都在 man7 的 strace(1) 取值选项表里逐字核对过（带 `--长选项=`）。
  // 注意 `-E`↔`-e`、`-P`↔`-p` 是**两个都真吃取值**的同形对（`--env`/`--trace`、`--trace-path`/`--attach`）
  // ⇒ 两条拼写都必须留在表里（测试里有显式豁免清单，见 test/dangerous-command-gate.test.js）。
  // firejail：man 页里**所有**取值选项都是 `--opt=value` 形态（`--profile=file`、`--net=eth0`、
  // `--timeout=10`…），没有「吃掉下一个 token」的；唯一沾边的 `-c` 是
  // 「login shell 兼容开关，目前不改变执行」⇒ **这条不登记任何取值选项**（不是漏了）。
  firejail: new Set(),
  'systemd-run': optionSet(['-u', '--unit', '-p', '--property', '-E', '--setenv', '-H', '--host', '-M', '--machine', '--description', '--slice', '--service-type', '--uid', '--gid', '--nice', '--working-directory', '--on-active', '--on-boot', '--on-startup', '--on-unit-active', '--on-unit-inactive', '--on-calendar', '--path-property', '--socket-property', '--timer-property']),
  // `--user`（就是验收用例里那条）是**开关**（`--system` 的对偶）；`-d`=--same-dir、`-t`=--pty、
  // `-P`=--pipe、`-S`=--shell、`-q`=--quiet、`-G`=--collect、`-r`=--remain-after-exit 也全是开关
  su: optionSet(['-c', '--command', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment', '--session-command']),
  runuser: optionSet(['-c', '--command', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment', '--session-command', '-u', '--user']),
  // `su` 没有 `-u`（用户是位置参数）；`runuser` 的 `-u` 与位置参数用户名**互斥**（见 matchSuShell）
  // `-p/--pid` 按 man 的例子 `setarch --show --pid 9284` 是**空格分隔取值**，要列
  setarch: optionSet(['-p', '--pid']),
  // `-p/--pid PID[:_inode_]`、`-o/--output list` 取值；`-n` 是 `--nofile[=limits]`（**可选附着**，
  // 不吞下一个 token）⇒ 不列；`-c/-d/-f/…` 同理全是资源选项的可选附着形态
  prlimit: optionSet(['-o', '--output', '-p', '--pid']),
  // ── v1.12.6 第八轮（终审 B1/B2）：本机（macOS，即部署平台）真二进制双向核对 ──
  // 口径与第五/六轮相同：**只列「吃掉下一个 token」的**；列错的方向是把真程序名当取值吃掉
  // ⇒ 反而漏判，所以每条都做了「该选项确实吃取值」+「吃饱后真程序名才在命令位置」两向核对。
  //
  // `chroot`：本机 usage 是 `chroot [-g group] [-G group,group,...] [-u user] newroot [command]`，
  // 三个选项各自 `chroot -u` / `-g` / `-G` 都报 `option requires an argument`；
  // `chroot -u root / /bin/echo HI` → `chroot: /: Operation not permitted`（解析成功，只是非 root）、
  // `chroot -u root /nonexistent-xyz /bin/echo HI` → 报的是 NEWROOT `/nonexistent-xyz` 不存在
  // ⇒ `-u` 吃的是 `root`、`/`（或 `/nonexistent-xyz`）才是新根。位置参数见 `WRAPPER_POSITIONAL_ARGS`。
  // GNU 的 `--userspec`/`--groups`（空格形态）**本机核不到**（macOS chroot 对 `--…` 一律
  // `illegal option -- -`）⇒ 不猜着写进表，列在 CHANGELOG 第八轮的「未在本机核对」清单里。
  chroot: optionSet(['-u', '-g', '-G']),
  // `caffeinate`：usage `caffeinate [-disu] [-t timeout] [-w Process ID] [command arguments...]`。
  // `-t` 单独写 → `option requires an argument -- t`；`caffeinate -t 1 /bin/echo HI` → `HI`；
  // `caffeinate -t /bin/echo HI` → 报 usage（`/bin/echo` 被当成 timeout 吃掉）；
  // `-w /bin/echo HI` 同理被吃 ⇒ `-t`/`-w` 吃取值；`-d/-i/-s/-u` 是开关（`-disu /bin/echo HI` → `HI`）。
  caffeinate: optionSet(['-t', '-w']),
  // `script`：本机 man SYNOPSIS 两行 —— `script [-aeFkqr] [-t time] [file [command ...]]` 与
  // `script -p [-deq] [-T fmt] [file]`。故：`-t`/`-T` 吃取值（各自报 option requires an argument；
  // `script -t 2 /dev/null /bin/echo HI` → `HI`）；`-F` 在本机是**开关**（"Immediately flush output"，
  // 实测 `script -F /dev/null /bin/echo HI` 把 `/dev/null` 当**记录文件**、不是 `-F` 的取值）
  // ⇒ `-F` 不列（列了会把记录文件/程序名吃掉 ⇒ 漏判）。位置参数见 `WRAPPER_POSITIONAL_ARGS`。
  script: optionSet(['-t', '-T']),
  // `xcrun`：本机 `xcrun --help` 的取值选项是 `--sdk <sdk name>` / `--toolchain <name>`，
  // 短拼写 `-sdk` 同样吃取值（`xcrun -sdk /bin/echo HI` → 去开 `/bin/echo/SDKSettings.plist`，
  // 即 `/bin/echo` 被吃掉）；三者各自单独写都报 "argument … is missing"。
  // `xcrun --sdk macosx /bin/echo HI`、`xcrun --toolchain default /bin/echo HI` → `HI`。
  // 其余（`-v/-l/-f/-r/-n/-k/--run/--find/--show-sdk-*`）全是开关，不列。
  xcrun: optionSet(['-sdk', '--sdk', '--toolchain']),
  // `arch`：**空集是判定结果，不是漏登记**。本机 usage/行为：`arch [-x86_64|-arm64|…] [prog [arg…]]`
  // —— `arch -x86_64 /bin/echo HI` → `HI`（`-x86_64` 只是架构选择器，**不吃**下一个 token）；
  // `arch -x86_64` 单独写 → `arch: No command to execute`（若是取值选项会报 option requires an argument）。
  // 所以这里**不能**把 `-x86_64`/`-arm64` 登记成取值选项：登记了会把真程序名（`rm`）当取值吃掉 ⇒ 漏判。
  // 通用剥壳对未知 `-…` 一律跳过 ⇒ `arch -x86_64 rm -rf /x` 的头 token 正确落到 `rm`。
  // 旁证：`arch --help` → `arch: Unknown architecture: help`（任何 `-名字` 都被当架构名）。
  arch: new Set(),
}

/**
 * 包装器**位置参数**个数候选（不是选项、但也不属于被执行的命令，必须先跳过）。
 * `chroot NEWROOT COMMAND…`：第一个位置参数是**新根目录**，跳过它才是真程序名；
 * 漏掉 ⇒ `basenameOf(tokens[0])` 变成 `/mnt` ⇒ `chroot /mnt rm -rf /x` 整段漏判。
 * 其余第五轮的包装器（`doas`/`setsid`/`ionice`/`taskset`）没有这样的位置参数。
 *
 * 值是**候选数组**（v1.12.6 第六轮）：`setarch [arch] [options] [program [argument...]]`
 * 的 `arch` 自 util-linux 2.33 起**可选** —— man 页例子 `setarch --addr-no-randomize
 * mytestprog` 里第一个位置参数就是程序名，而 `setarch ppc32 rpmbuild …` 里是 arch，
 * 词法上分不出是哪种 ⇒ 两个候选**都判一遍**（并集，只多弹不少弹：
 * `setarch x86_64 rm -rf /x` 与 `setarch -R rm -rf /x` 都命中）。
 * `nsenter`/`unshare`/`strace`/`systemd-run`/`prlimit`/`firejail` 的第一个非选项
 * token 就是被执行的命令（`prlimit` 的数值位置参数是 **PID 列表模式**、不执行命令），
 * 故不在此表。`su`/`runuser` 的可选用户名由 `matchSuShell` 自己跳（`runuser -u` 时没有它）。
 */
const WRAPPER_POSITIONAL_ARGS = {
  chroot: [1],
  setarch: [1, 0],
  // v1.12.6 第八轮（终审 B2）：macOS `script` 的**第一个位置参数是记录文件**，其后才是命令
  // （本机 man SYNOPSIS：`script [-aeFkqr] [-t time] [file [command ...]]`）。
  // 本机核对：`script -q /dev/null /bin/echo HI` → `HI`（`/dev/null` 被当记录文件、`/bin/echo` 是真程序名）、
  // `script -q /dev/null /bin/echo HI extra` → `HI extra`（命令参数照传）。
  // 漏掉这个位置参数 ⇒ `script -q /dev/null rm -rf /x` 的头 token 变成 `/dev/null` ⇒ 静默放行。
  // 残余（登记在 CHANGELOG 第八轮残余风险）：`script [file]` **不带命令**时起一个交互 shell，
  // 本机实测 `printf 'echo X\n' | script -q /dev/null` 只回显、**未执行**（非 tty 下 shell 立刻退出）
  // ⇒ 不按 `SHELL_STDIN_RULE` 处理；这条差异是**如实登记的边界**，不是漏判危险命令。
  script: [1],
}

/** 子命令动词之前**会吃掉下一个 token 作为取值**的选项（值可能长得像动词，必须跳过） */
const PROGRAM_VALUE_OPTIONS = {
  // 第七轮：短选项**按真实大小写各写一条**（`-c` 与 `-C` 在 git 里是两个不同选项：
  // `-c <name>=<value>` 与 `-C <path>`，第四轮把 `-C` 删掉是因为当时两者归一成同一个键；
  // 归一取消后 `git -C /tmp push` 会因 `-C` 不在表里而丢掉命中 ⇒ 必须写回来。
  git: optionSet(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix']),
  npm: optionSet(['--prefix', '-C', '--registry', '--userconfig', '--cache', '--loglevel', '--tag', '--workspace', '-w', '--otp', '--omit', '--include', '--before']),
  pnpm: optionSet(['--prefix', '--dir', '-C', '--registry', '--filter', '-F', '--config-dir', '--store-dir', '--workspace-root']),
  yarn: optionSet(['--cwd', '--registry', '--cache-folder', '--modules-folder', '--network-timeout', '--mutex']),
}

const NO_VALUE_OPTIONS = new Set()

/** `timeout 5 rm …` / `timeout 1m rm …`：时长是位置参数，不是被包装的命令 */
const TIMEOUT_DURATION = /^\d+(?:\.\d+)?[smhd]?$/

/** shell 解释器名：`bash -c '<body>'` 解一层包装用（不做完整 shell 解析） */
const SHELL_WRAPPERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])

/**
 * 去掉**紧邻引号的反斜杠**（`\"rm` → `"rm`、`\'rm` → `'rm`）。
 *
 * v1.12.6 第四轮（终审 M1-④）：嵌套解包装会拼出这种 token——
 * `bash -c "bash -c \"rm -rf /x\""` 的第二层正文经空白切分后是 `\"rm`、`-rf`、`/x\"`；
 * 首字符是 `\` ⇒ `basenameOf` 的 `lastIndexOf('\\')` 切出 `"rm` ≠ `rm`、
 * `stripOuterQuotes` 也认不出外层引号 ⇒ 整段 MISS（不是深度上限问题）。
 * 只解「反斜杠 + 引号」这一种，不动其它转义（避免把 `\n`、`\;` 之类语义改掉）。
 */
const unescapeQuoted = (s) => String(s).replace(/\\(["'])/g, '$1')

/** 去掉首尾包裹引号（`"'rm -rf /'"` 这类拼回来的正文） */
function stripOuterQuotes(s) {
  const t = unescapeQuoted(String(s == null ? '' : s)).trim()
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t[t.length - 1] === t[0]) return t.slice(1, -1)
  return t
}

/**
 * 程序名归一：先解「反斜杠+引号」转义，再去掉路径前缀与包裹引号后小写。
 * `'/bin/rm'` / `'./rm'` / `'/usr/bin/env'` / `'"rm"'` / `'\"rm'`
 *   → `rm` / `rm` / `env` / `rm` / `rm`。
 * 先解转义再切路径：`\"rm` 若不先解，末个反斜杠会把它切成 `"rm`（引号剥不掉 ⇒ 不再等于 `rm`）。
 */
function basenameOf(token) {
  const raw = unescapeQuoted(String(token == null ? '' : token)).replace(/^["']+|["']+$/g, '')
  const cut = Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\'))
  return (cut >= 0 ? raw.slice(cut + 1) : raw).toLowerCase()
}

/**
 * 兜底探针的条数上限（一个段最多记这么多条「被当成取值/位置参数跳过的 token」的候选命令）。
 * 动机是**热路径成本**：危险门跑在每次审批上、判据文本有界截断到 256KB，
 * 探针只在「主路径没命中」时才逐条重判一次，条数封顶 ⇒ 单段最坏开销仍是 O(段长) 量级，
 * 不会退化成「每个 token 都重扫一遍后缀」的平方级。
 * 取 8：够覆盖 `sudo -u a -g b -p c … rm -rf` 这种真实叠加（选项取值不会排成长队）。
 *
 * v1.12.6 第七轮补：这个条数是**每段共享的预算**（`{ probes: MAX_OPTION_PROBES }`，
 * 段入口 `matchSegment` 创建、一路传给嵌套剥壳与探针自己的判定）——否则
 * `runuser -u x ` ×N 这类**嵌套剥壳链**会在每一层 MISS 后各重判一次后缀 ⇒ 段内二次方
 * （实测 n=1000 时探针把既有 O(n²) 的常数抬高约 1.6×）。共享后**单段兜底重判硬封顶 8 次**，
 * 代价只是超长病态链的深层探针可能不跑（方向仍是「少弹」，且只影响兜底这一层）。
 */
const MAX_OPTION_PROBES = 8

/** 记一条兜底探针（超出 `MAX_OPTION_PROBES` 直接丢，见常量注释） */
function pushProbe(probes, suffix) {
  if (probes.length < MAX_OPTION_PROBES && suffix.length > 0) probes.push(suffix)
}

/**
 * 剥壳后**仍判不出的结构性可疑**时的门名：**可疑**档（保守转交互），不是「确认危险」。
 *
 * v1.12.6 第七轮（终审阻断 A/B）：上一版的取值选项表用 `toLowerCase()` 查表，
 * 把小写同形的**开关**也当成取值选项 ⇒ 吃掉紧跟其后的**真程序名**：
 * `unshare -r rm -rf /x`、`nsenter -n rm -rf /x`、`strace -A rm -rf /x`、
 * `systemd-run -P rm -rf /x`、`xargs -l rm -rf /x`、`xargs -p rm -rf /x` 全部
 * 判据层 `null`、监听器层 `allowed-once`（**静默放行**）。查表侧已改成大小写精确，
 * 这条门是**不依赖任何工具 man 语义**的第二道防线（`wrapperOptionAmbiguity`）：
 *   · 交给规则的头 token 以 `-` 开头 ⇒ 我们把某个**选项**当成了程序名，
 *     真程序名必然在别处被吃掉过；
 *   · 剥壳时被当成「取值 / 位置参数」跳过的某个 token，自己就能起一条危险命令
 *     （`rm -rf /x`）⇒ 那个「取值」其实就是程序名，命令正文是被这一跳吃掉的。
 * 两个判据都只看**结构**（谁站在程序名的位置上），不看任何工具「某开关吃不吃值」的知识，
 * 所以同族再出现新的错登记也会在这里被兜住 —— 方向仍是**只多弹不少弹**。
 */
export const WRAPPER_OPTION_AMBIGUITY_RULE = 'wrapper-option-ambiguity'

/**
 * 剥掉透明包装（可叠加：`env FOO=1 sudo -u root nice -n 10 rm -rf x`）。
 * @param {string[]} tokens
 * @param {number} [pick] 位置参数候选下标（见 `WRAPPER_POSITIONAL_ARGS` 的候选数组；
 *   只有 `setarch` 有两个候选，`matchSegment` 首个候选没命中时会用 `pick=1` 再判一遍）。
 * @returns {{tokens: string[], exhausted: boolean, ambiguous: boolean, probes: string[][]}}
 *   `tokens`：剥完剩下的命令 token；后面什么都没有（`command`、`timeout 5`）时是空数组。
 *   `exhausted`：**跳数用尽**（`MAX_WRAPPER_UNWRAP_HOPS`）且段首仍是包装器
 *   （`sudo`×9 + `rm -rf …`）—— 调用方据此按 `WRAPPER_DEPTH_RULE` 保守转交互；
 *   改前这里是**静默放行**（剥不动就交回规则表，规则表只认段首程序名 ⇒ 不命中）。
 *   `ambiguous`：本次剥壳**用了有多候选位置参数的包装器**（当前只有 `setarch`）
 *   ⇒ 调用方在首个候选没命中时还要试第二个候选（并集，只多弹不少弹）。
 *   `probes`：**被当成「取值/位置参数」跳过的那些 token 各自的候选命令**（`maxOptionProbes` 条封顶）
 *   —— 万一某个开关被表误登记成取值选项（第七轮阻断的形态），真程序名就在这里，
 *   调用方按 `WRAPPER_OPTION_AMBIGUITY_RULE` 兜底（见 `wrapperOptionAmbiguity`）。
 */
function unwrapTransparentWrappers(tokens, pick = 0) {
  let out = tokens
  let ambiguous = false
  const probes = []
  for (let hop = 0; ; hop += 1) {
    if (out.length === 0) return { tokens: [], exhausted: false, ambiguous, probes }
    const head = basenameOf(out[0])
    // `su` / `runuser` **不在这张表里**（v1.12.6 第七轮移出）：它们在这里就被这一行原样交回，
    // 由 `matchSegment` 的 `matchSuShell` 判 —— 原先那条「一见 su/runuser 就 return」的早返回
    // 因此成了死代码，已删（同一件事只留一个事实来源）。
    if (!TRANSPARENT_WRAPPERS.has(head)) return { tokens: out, exhausted: false, ambiguous, probes }
    if (hop >= MAX_WRAPPER_UNWRAP_HOPS) {
      // 段首仍是包装器：**它后面还有东西**（`sudo`×9 + `rm -rf …`）才算「剥不动、判不出」
      // ⇒ 交给调用方按可疑处理；只剩包装器自己（`sudo`×9 后面什么都没有）没有可执行的
      // 命令，照旧不命中（不发假警报）。
      return { tokens: out, exhausted: out.length > 1, ambiguous, probes }
    }
    const valueOpts = WRAPPER_VALUE_OPTIONS[head] || NO_VALUE_OPTIONS
    // 包装器自己的位置参数（`chroot NEWROOT` / `setarch [arch]`）：不是选项，
    // 但也不属于被执行的命令。候选表可能有多项 ⇒ 按 pick 取，并记下「有歧义」。
    const candidates = WRAPPER_POSITIONAL_ARGS[head] || []
    if (candidates.length > 1) ambiguous = true
    let positional = candidates.length > 0 ? candidates[Math.min(pick, candidates.length - 1)] : 0
    let i = 1
    for (; i < out.length; i += 1) {
      const t = stripOuterQuotes(out[i])
      if (ENV_ASSIGNMENT.test(t)) continue // env FOO=1 cmd
      if (t.startsWith('-')) {
        // `--opt=value` 自带取值（不占下一个 token）；反之要连同它的取值一起跳过。
        // 查表键：**短选项原样（大小写精确）、长选项小写归一**（见 `optionKey` 的注释）。
        if (!t.includes('=') && valueOpts.has(optionKey(t))) {
          pushProbe(probes, out.slice(i + 1))
          i += 1
        }
        continue
      }
      if (positional > 0) { pushProbe(probes, out.slice(i)); positional -= 1; continue }
      if (head === 'timeout' && TIMEOUT_DURATION.test(t)) continue
      break
    }
    if (i >= out.length) return { tokens: [], exhausted: false, ambiguous, probes }
    out = out.slice(i)
  }
}

/**
 * `sh|bash|zsh|dash|ksh -c <body>` 的 body 起点（**没有 `-c` 返回 null**）。
 * `-lc` / `-ec` 这类组合短选项也认；`--xxx` 长选项不认。
 *
 * 还认「短选项与正文**粘连**」的写法：`bash -c'rm -rf /x'` / `sh -c"rm -rf /x"`——
 * 空白切分后是 `-c'rm`、`-rf`、`/x'`，正文首词被吞进标志 token 里；
 * 只取 `tokens.slice(i+1)` 会让 body 变成 `-rf /x'`（MISS）。
 * @returns {{at: number, inline: string}|null}
 *   `at`：正文起始的 token 下标；`inline`：标志 token 里紧跟在标志字符之后的残段
 *   （`-c'rm` → `'rm`；普通 `-c` → `''`）。组装正文时 `inline` 必须拼在最前面。
 */
function shellBodyIndex(tokens) {
  for (let i = 1; i < tokens.length; i += 1) {
    const raw = stripOuterQuotes(tokens[i])
    const t = raw.toLowerCase()
    if (t === '-' || t === '--' || !t.startsWith('-') || t.startsWith('--')) continue
    const cAt = t.slice(1).indexOf('c')
    if (cAt < 0) continue
    // 原文按同一下标切（标志都是 ASCII，大小写不改变下标）
    return { at: i + 1, inline: raw.slice(cAt + 2) }
  }
  return null
}

/**
 * `su` / `runuser` 的 `-c` 正文起点（没有 `-c` / `--command` / `--session-command` 返回 null）。
 * 短选项那一半与 shell 的 `-c` **同形**（`-c '<body>'`，粘连写法 `-c'rm -rf /x'`）⇒
 * 直接复用 `shellBodyIndex`；su/runuser 额外认长选项（`--command <body>`、
 * `--session-command=<body>`，man 页写的是 `--session-command=command`）。
 * `--` 之后一律算位置参数（`su - root -- ls` 里的 `ls` 不是正文）⇒ 不认 `--` 之后的。
 */
function suBodyIndex(tokens) {
  const short = shellBodyIndex(tokens)
  if (short) return short
  for (let i = 1; i < tokens.length; i += 1) {
    const raw = stripOuterQuotes(tokens[i])
    const t = raw.toLowerCase()
    if (t === '--') return null
    for (const long of ['--command', '--session-command']) {
      if (t === long) return { at: i + 1, inline: '' }
      if (t.startsWith(long + '=')) return { at: i + 1, inline: raw.slice(long.length + 1) }
    }
  }
  return null
}

/**
 * `su` / `runuser` 段里**被执行的命令**的起点（只在没有 `-c` 时用）：
 * 跳过包装器自己的选项（连同取值）与**可选用户名**（`su root rm …` 里的 `root`）。
 * `runuser` 有两条 synopsis —— `runuser [options] -u user [[--] command …]` 与
 * `runuser [options] [-] [user [argument …]]` —— `-u` 与位置参数用户名**互斥**，
 * 所以「位置参数用户名」只在没见过 `-u` 时才存在（见过 `-u` 时位置参数 0 个）。
 * @returns {{tokens: string[], probes: string[][]}}
 *   剩下的 token（**空数组** = 只会启动交互 shell，没东西可判）+ 兜底探针
 *   （被当成「选项取值 / 位置参数用户名」跳过的那些 token 各自的候选命令，
 *   见 `MAX_OPTION_PROBES`；`su -G grp rm -rf /x` 这种「真程序名被当用户名吃掉」的形态
 *   就靠它兜底）。
 */
function suCommandTokens(head, tokens) {
  const valueOpts = WRAPPER_VALUE_OPTIONS[head] || NO_VALUE_OPTIONS
  const probes = []
  let positional = 1
  let i = 1
  for (; i < tokens.length; i += 1) {
    const t = stripOuterQuotes(tokens[i])
    if (ENV_ASSIGNMENT.test(t)) continue
    if (t.startsWith('-')) {
      // 查表键与包装器剥壳**同一把尺子**：短选项原样（大小写精确）、长选项小写（见 optionKey）
      const key = optionKey(t)
      if (t !== '--' && !t.includes('=') && valueOpts.has(key)) {
        if (key === '-u' || key === '--user') positional = 0 // runuser -u user COMMAND…
        pushProbe(probes, tokens.slice(i + 1))
        i += 1
      }
      continue
    }
    if (positional > 0) { pushProbe(probes, tokens.slice(i)); positional -= 1; continue }
    break
  }
  return { tokens: tokens.slice(i), probes }
}

/**
 * `su` / `runuser` 段判定（v1.12.6 第六轮 · 终审 M-D）。
 *
 * 它们与 `setsid` / `chroot` 同族（换身份跑**同一条**命令），但多一条路径：
 * `su root -c '<正文>'` / `runuser -u root -c '<正文>'` 按 **`shell -c` 同原则** ——
 * 解析出正文后再喂给**同一份规则**（`matchText`，递归深度与 shell 包装同一把尺子、
 * 用尽时同样按 `SHELL_DEPTH_RULE` 保守转交互）。判不出正文（没有 `-c`）时按
 * `SU_SHELL_RULE`（**可疑**）保守转交互，**不是放行**。
 */
function matchSuShell(tokens, depth, trace, budget) {
  const head = basenameOf(tokens[0])
  const bodyAt = suBodyIndex(tokens)
  if (bodyAt) {
    if (depth >= MAX_SHELL_UNWRAP_DEPTH) return { rule: SHELL_DEPTH_RULE, segment: trace() }
    const body = stripOuterQuotes([bodyAt.inline, ...tokens.slice(bodyAt.at)].join(' '))
    const inner = body ? matchText(body, depth + 1) : null
    // 规则用内层命中的那条；留痕用**外层**那段（排障时要看到 `su … -c` 包装本身）
    return inner ? { rule: inner.rule, segment: trace() } : null
  }
  const rest = suCommandTokens(head, tokens)
  // 什么都不剩（`su`、`su - root`、`su --version`）：交互登录 shell ⇒ 保守转交互
  if (rest.tokens.length === 0) return { rule: SU_SHELL_RULE, segment: trace() }
  // 还有东西（`runuser -u root -- rm -rf /x`）：剥掉包装器自己的词之后按同一份规则判。
  // 留痕用**外层**那段（v1.12.6 第七轮 Minor m3）：同族（shell -c 正文、`-exec`、包装器）
  // 都留外层，只有这条 no-`-c` 分支原先让 `matchSegment` 用自己的 `trace()` 重算 ⇒
  // `runuser -u root -- rm -rf /x` 的日志里只有 `segment="rm -rf /x"`，排障时看不到
  // 「这条是被 runuser 包着跑的」。规则名仍用内层命中的那条。
  const inner = matchSegment(rest.tokens.join(' '), depth, 0, budget)
  if (inner) return { rule: inner.rule, segment: trace() }
  // 主路径没命中：与透明包装同一条结构性兜底（见 wrapperOptionAmbiguity）
  return wrapperOptionAmbiguity(tokens, rest.probes, trace, depth, budget)
}

/**
 * `find … -exec <cmd> …` 的**子命令起点**（`-exec` / `-execdir` / `-ok` / `-okdir`；无则 -1）。
 * `find /tmp -exec rm -rf {} +` 与 `rm -rf /tmp` 同语义，只是危险程序不在段首。
 * 这里**不新增名单条目**——危险**命令**名单仍是单点常量（`DANGEROUS_COMMAND_RULES`），
 * `-exec` 只是「同一条命令的另一条调用路径」，命中后仍报原来的规则名（`rm -rf`）。
 *
 * **下标从 0 起（v1.12.6 第五轮 · 终审 M-A）**：`-exec` 不只在 `find` 段里出现——
 * `splitSubCommands` 会把 `;` 切成子段，而 `;` 正是 `-exec … {} \;` 的终止符：
 * `find /tmp -exec echo {} \; -exec rm -rf {} +` 的第二段是 `" -exec rm -rf {} +"`
 * （**段首就是 `-exec`**）。改前从 1 起扫 ⇒ 下标 0 永不参与识别 ⇒ 判据层 MISS、
 * 监听器层 `allowed-once`（**静默放行**）；单独一条 `-exec rm -rf {} +` 同理。
 * 从 0 起扫只会**多**识别出「段首就是 -exec」的写法，不会让任何原本命中的写法失效。
 */
function execSubcommandIndex(tokens) {
  for (let i = 0; i < tokens.length; i += 1) {
    const t = stripOuterQuotes(tokens[i]).toLowerCase()
    if (t === '-exec' || t === '-execdir' || t === '-ok' || t === '-okdir') {
      return i + 1 < tokens.length ? i + 1 : -1
    }
  }
  return -1
}

/**
 * `rm` 是否同时具备递归与强制。
 * 程序名按 basename 比对（`/bin/rm`、`./rm`）；短选项按字符扫（`-rf`/`-fr`/`-Rf`），
 * 长选项精确匹配 `--recursive`/`--force`；选项与路径的**顺序无关**（`rm /tmp/x -rf` 也认）。
 */
function isRecursiveForceRemove(tokens) {
  if (basenameOf(tokens[0]) !== 'rm') return false
  let recursive = false
  let force = false
  for (const token of tokens.slice(1)) {
    const t = stripOuterQuotes(token).toLowerCase()
    if (t.startsWith('--')) {
      if (t === '--recursive') recursive = true
      else if (t === '--force') force = true
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      const chars = t.slice(1)
      if (chars.includes('r')) recursive = true
      if (chars.includes('f')) force = true
    }
  }
  return recursive && force
}

/**
 * `git`/`npm`/`pnpm`/`yarn` 的子命令动词：程序名（basename）之后**第一个非选项 token**，
 * 且跳过该命令自己**会吃掉取值**的选项（`git -C <dir> push`、`git -c k=v push`、
 * `npm --prefix <p> publish`）。`--opt=value` 是单个 token，不再吃掉下一个。
 * 这样 `pnpm publish` / `git --no-pager push` 能覆盖，而 `git log --grep push` 不会误伤。
 * 另一个例外：`yarn npm publish`（yarn 0.2+ 的 `npm` 子命令）与 `yarn publish` 同语义，
 * 故 yarn 的 `npm` 子命令要再看下一个非选项 token（见函数内注释）。
 */
function subCommandVerb(tokens, program, verb) {
  if (basenameOf(tokens[0]) !== program) return false
  const valueOpts = PROGRAM_VALUE_OPTIONS[program] || NO_VALUE_OPTIONS
  for (let i = 1; i < tokens.length; i += 1) {
    const raw = stripOuterQuotes(tokens[i])
    const t = raw.toLowerCase()
    if (t.startsWith('-')) {
      // 查表键与包装器剥壳同一把尺子：**短选项原样**（`-C` 与 `-c` 在 git/npm/pnpm 里是
      // 两个不同选项）、长选项小写（见 `optionKey`）。
      if (!t.includes('=') && valueOpts.has(optionKey(raw))) i += 1
      continue
    }
    // `yarn npm publish` 与 `yarn publish` 同语义：`npm` 是 yarn 的子命令时，动词在下一个
    // 非选项 token 上（`yarn npm run publish` 仍不命中——那里动词是 `run`）。
    if (program === 'yarn' && t === 'npm') continue
    return t === verb
  }
  return false
}

/**
 * 按 shell 分隔符切子命令：`;` `|` `||` `&` `&&` 与换行。
 * 单引号/双引号内部不切分（`curl 'a=1&rm -rf'` 保持一段）。
 */
export function splitSubCommands(text) {
  const segments = []
  let buffer = ''
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      buffer += ch
      if (ch === quote && text[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (ch === ';' || ch === '\n' || ch === '|' || ch === '&') {
      if ((ch === '|' || ch === '&') && text[i + 1] === ch) i += 1
      segments.push(buffer)
      buffer = ''
      continue
    }
    buffer += ch
  }
  segments.push(buffer)
  return segments
}

/**
 * 折叠空白切 token、跳过前导环境变量赋值。
 * **保留原大小写**：`-c '<body>'` 解包装后正文会被原样再喂给同一份规则，
 * 小写化会污染留痕里的那段命令（判定侧各自按小写比对，见 basenameOf/subCommandVerb）。
 */
function tokenizeSegment(segment) {
  const raw = segment.trim().split(/\s+/).filter(Boolean)
  let start = 0
  while (start < raw.length && ENV_ASSIGNMENT.test(raw[start])) start += 1
  return raw.slice(start)
}

/**
 * `command -v <name>` / `command -V <name>`：`command` 这个 shell 内建的**查询**开关
 * （打印路径/类型，**不执行**任何东西）⇒ 整段不是一次执行，直接不命中。
 *
 * v1.12.6 第六轮（终审 M-D 附带）：这条守卫原先只是 `source` 分支 `tokens.length > 1`
 * 的**副作用**（剥掉 `command` 后只剩 `['source']` ⇒ 不满足 >1 ⇒ 不命中）。第六轮加进来的
 * `su` / `runuser` **必须在「只剩它自己」时也成立**（`su` 就是启动一个交互登录 shell
 * ⇒ 按 SU_SHELL_RULE 保守转交互），两者剥壳后长得**一模一样** ⇒ 只能在按**原文**这一层
 * 把查询形态认出来，否则 `command -v su` 会被误伤成「启动交互 shell」。
 * 只认 `command` 打头且紧邻 `-p`（POSIX 允许）后的 `-v`/`-V` 两个形态，别的都不豁免。
 */
function isCommandQuery(tokens) {
  if (basenameOf(tokens[0] || '') !== 'command') return false
  let i = 1
  if (stripOuterQuotes(tokens[i] || '').toLowerCase() === '-p') i += 1
  const t = stripOuterQuotes(tokens[i] || '').toLowerCase()
  // `t` 已小写 ⇒ `-v` 与 `-V` 归一到同一个键（两个拼写都认）
  return t === '-v'
}

/**
 * 剥壳之后的**结构性兜底**（v1.12.6 第七轮 · 终审阻断 A/B；门名见
 * `WRAPPER_OPTION_AMBIGUITY_RULE`）。只在**主路径一个字都没命中**时调用 ——
 * 因此它只会把「静默放行」改成「保守转交互」，永远不会改掉既有命中的规则名。
 *
 * 两个判据都不依赖任何工具的 man 语义（谁吃取值、哪条是开关都不需要知道）：
 *   ① **程序名的位置站着选项**：交给规则的头 token 以 `-` 开头。剥壳循环对每个
 *      `-…` token 都 `continue`，正常情况下结果的头 token 不可能是选项 ⇒ 只能是
 *      「段首本来就是个选项 token」（`splitSubCommands` 按 `;` 切开后剩下的那段、
 *      `argsText` 里以 `-` 开头的值、或将来某次改动把选项漏给了规则）——那时
 *      真程序名必然在别处被吃掉过。`-exec` 系段除外：它们的判定通道是
 *      `execSubcommandIndex`（「真程序名」在上一段，第五轮既定口径，`-exec ls {} +`
 *      必须仍 MISS）。
 *   ② **被当成「取值 / 位置参数」跳过的 token 自己能起一条危险命令**：`probes` 里
 *      存着每个被吃掉 token 之后的候选命令，逐条用同一份规则**不带兜底**地重判；
 *      命中即说明那个「取值」其实是程序名（`env -S 'rm -rf /x'` 是真实一例：
 *      `-S` 的取值就是整条命令）。探针条数封顶见 `MAX_OPTION_PROBES`。
 * @returns {{rule: string, segment: string}|null} 命中即**可疑**档（保守转交互）
 */
function wrapperOptionAmbiguity(tokens, probes, trace, depth, budget) {
  const head = stripOuterQuotes(tokens[0] || '')
  // `tokens.length > 1`：**光秃秃一个选项 token**（`{argv: ['ls','-la']}` 被 argsTextOf
  // 按值拆出来的 `-la` 段）不算「把选项当成了程序名」—— 它后面没有别的东西，
  // 不可能是「吃掉程序名」的形态，判它会白白多弹一次（既有用例把 argv 拆词形态
  // 钉成**登记在案的残留边界**，这里保持那条边界不动）。
  if (tokens.length > 1 && head.startsWith('-') && execSubcommandIndex(tokens) < 0) {
    return { rule: WRAPPER_OPTION_AMBIGUITY_RULE, segment: trace() }
  }
  for (const probe of probes) {
    // 每段共享的**预算**（见 `MAX_OPTION_PROBES`）：探针内部若再触发兜底，花的是同一份预算
    // ⇒ 嵌套剥壳链（`runuser -u x` ×N）不会把重判次数放大成段内平方级；预算用尽即停。
    if (budget.probes <= 0) break
    budget.probes -= 1
    if (matchSegment(probe.join(' '), depth, 0, budget)) {
      return { rule: WRAPPER_OPTION_AMBIGUITY_RULE, segment: trace() }
    }
  }
  return null
}

/**
 * 单段子命令判定。包装/引号是**文本级**结构，剥完再交给规则 —— 规则只该看到
 * 「真正的程序名 + 它的参数」这一层。
 * @param {string} segment
 * @param {number} depth 已经解开过几层 shell 包装
 * @param {number} [pick] 位置参数候选下标（见 `WRAPPER_POSITIONAL_ARGS`）：
 *   包装器的位置参数个数在词法上可能不唯一（`setarch [arch] …`，arch 自 2.33 起可选）
 *   ⇒ 首个候选没命中时用 `pick=1` 把整段再判一遍（**并集**，只多弹不少弹）。
 * @param {{probes: number}} [budget] 本段共享的兜底探针预算（段入口创建，见 `MAX_OPTION_PROBES`）
 */
function matchSegment(segment, depth, pick = 0, budget = null) {
  const probeBudget = budget || { probes: MAX_OPTION_PROBES }
  const raw = tokenizeSegment(segment)
  // `command -v su` / `command -V source`：查询形态，不执行（见 isCommandQuery）
  if (isCommandQuery(raw)) return null
  const unwrapped = unwrapTransparentWrappers(raw, pick)
  const trace = () => segment.trim().slice(0, 200)
  if (unwrapped.exhausted) {
    // 跳数用尽、段首**仍是包装器**（`sudo`×9 + `rm -rf …`）：剥不动不等于没危险
    // ⇒ 与 shell 深度上限同一原则：**可疑**（保守转交互）。改前这里是静默放行。
    return { rule: WRAPPER_DEPTH_RULE, segment: trace() }
  }
  const tokens = unwrapped.tokens
  if (tokens.length === 0) return null
  // `su` / `runuser`（v1.12.6 第六轮 · 终审 M-D）：与透明包装同族，但 `-c` 的正文会被
  // 空白切碎 ⇒ 不走通用剥壳，由 `matchSuShell` 单独判（正文递归同一份规则）。
  if (SU_WRAPPERS.has(basenameOf(tokens[0]))) return matchSuShell(tokens, depth, trace, probeBudget)
  // v1.12.6 第五轮（终审 M-C②）：`source deploy.sh` / `. deploy.sh` 与 `bash deploy.sh`
  // 同义（在当前 shell 里读脚本文件执行），正文静态不可判定 ⇒ 与 SHELL_STDIN_RULE
  // 同一原则保守转交互。改前 `.`/`source` 不在任何名单里 ⇒ 静默放行，而同义的
  // `bash deploy.sh` 已转交互 —— 口径冲突。`basenameOf` 已按 basename 比对，
  // 所以 `/usr/bin/source`、`./source` 这类写法一并覆盖；`.` 只匹配**恰好**一个点
  // （`.gitignore`、`./foo` 的 basename 都不是 `.`，不会误伤）。
  {
    const head = basenameOf(tokens[0])
    // `tokens.length > 1`：`source` / `.` **不带参数**时不做任何事（`source` 打印用法、
    // `.` 报错），不该发假警报。这条同时也挡住 `command -v source`（`-v` 是查询开关、
    // 不是执行：剥掉 `command` 后只剩 `['source']`）——它是既有的误伤守卫家族之一。
    if (tokens.length > 1 && (head === 'source' || head === '.')) {
      return { rule: SHELL_SOURCE_RULE, segment: trace() }
    }
  }
  if (SHELL_WRAPPERS.has(basenameOf(tokens[0]))) {
    const bodyAt = shellBodyIndex(tokens)
    if (!bodyAt) {
      // 段首是 shell 解释器却**没有 `-c`**：裸解释器读 stdin（`printf '…' | bash`、
      // `bash <<< '…'`）或执行脚本文件（`bash deploy.sh`），正文静态不可判定
      // ⇒ **可疑**（保守转交互），不是「放行」。
      return { rule: SHELL_STDIN_RULE, segment: trace() }
    }
    if (depth >= MAX_SHELL_UNWRAP_DEPTH) {
      // 第 3 层起不再展开：**可疑**（保守转交互），不做无限展开
      return { rule: SHELL_DEPTH_RULE, segment: trace() }
    }
    // `inline` 是「短选项与正文粘连」时被吞进标志 token 的首词（`-c'rm` → `'rm`）
    const body = stripOuterQuotes([bodyAt.inline, ...tokens.slice(bodyAt.at)].join(' '))
    const inner = body ? matchText(body, depth + 1) : null
    // 规则用内层命中的那条；留痕用**外层**那段（排障时要看到 `bash -c` 包装本身）
    return inner ? { rule: inner.rule, segment: trace() } : null
  }
  // `find … -exec rm -rf {} +`：危险程序不在段首，但调用路径是**可判定**的
  // （不新增名单条目，命中仍报原来的规则名）
  const execAt = execSubcommandIndex(tokens)
  if (execAt >= 0) {
    const inner = matchSegment(tokens.slice(execAt).join(' '), depth, 0, probeBudget)
    if (inner) return { rule: inner.rule, segment: trace() }
  }
  for (const rule of DANGEROUS_COMMAND_RULES) {
    if (rule.match(tokens)) return { rule: rule.id, segment: trace() }
  }
  // 位置参数有歧义的包装器（当前只有 `setarch`：arch 可省）⇒ 换另一个候选再判一遍。
  // 只在**首个候选没命中**时发生，且只在本次确实用到多候选包装器时（`ambiguous`）
  // ⇒ 对绝大多数命令是零开销。方向仍是**只多弹不少弹**。
  if (pick === 0 && unwrapped.ambiguous) return matchSegment(segment, depth, 1, probeBudget)
  // 结构性兜底（v1.12.6 第七轮）：主路径一个字都没命中时，才检查「程序名的位置是不是
  // 站着一个选项 / 命令是不是被当成某个选项的取值吃掉了」（见 wrapperOptionAmbiguity）。
  // 放在最后 ⇒ 既有命中的规则名一个都不变，只把**静默放行**换成**保守转交互**。
  return wrapperOptionAmbiguity(tokens, unwrapped.probes, trace, depth, probeBudget)
}

/** 逐段判定（`dangerousCommandMatch` 的递归实现，深度由 depth 携带） */
function matchText(text, depth) {
  for (const segment of splitSubCommands(text)) {
    const hit = matchSegment(segment, depth)
    if (hit) return hit
  }
  return null
}

/**
 * 这段命令文本里是否含用户裁决必须交互的命令（**词法级**，覆盖边界见上方名单注释）。
 * @param {string|null} text shell 正文
 * @returns {{rule: string, segment: string}|null}
 */
export function dangerousCommandMatch(text) {
  if (typeof text !== 'string' || !text.trim()) return null
  return matchText(text, 0)
}

/**
 * 危险命令门的**文本上限**（字符数；判据是词法级的，按字符计与字节同量级）。
 *
 * v1.12.6 第五轮（终审 Minor 2）：`dangerousCommandMatch` 是 O(文本长度) 的
 * （`splitSubCommands` 全量扫 + 每段 `split(/\s+/)`），而它跑在**每次审批**的热路径上、
 * 且同步阻塞宿主事件循环。终审实测 `dangerousCommandMatch(argsText)`：
 * 0.1MB=25ms / 1MB=268ms / **4MB=889ms**。`argsText` 是 args 里**所有字符串值**的拼接，
 * 而 `write` 的 `content`、`edit` 的 `new_string` 动辄几百 KB～几 MB ⇒ 这条路径现实可及。
 *
 * **取舍（本轮明确登记）**：超过上限只判定**前 256KB**。边界是**字符下标上的硬切**、
 * 不是「切在命令边界上」——危险命令起点落在 262136（= 上限 - 8）时仍完整命中，
 * 落在 262141 / 262143 时会被切残（`rm -rf` 只剩 `r`）⇒ MISS。所以准话是
 * 「**第 256KB 附近及之后**首次出现的危险命令不保证转交互」（残余风险，方向是**少弹**）。
 * 另一条路（超限即保守转交互）被否掉：argsText 里包含 `write` 的正文，
 * 大正文是**常态**，那条路会让每次大写入都强制弹框，代价远大于收益。
 * 真正要堵这个残余，需要「按段有界扫描」或「流式词法扫描」，本轮不做，登记在 CHANGELOG。
 * 截断发生在**调用点**（`resolveApprovalContext` 返回的原文不动：`index.js` 的
 * 「执行类解析不出正文 ⇒ 不自动放行」要按**完整** `commandText` 判定）。
 *
 * v1.12.6 第六轮（终审 Minor 2 / Minor 3）把两侧口径**分开**并说准：
 * · `argsText`（args 里所有字符串值的拼接，含 `write` 的正文）——**保持截断**，
 *   就是上面那段取舍；
 * · `commandText`（`command`/`cmd`/`commandLine`/`script` 这类**真正的 shell 正文**，
 *   超长不是常态）——**超限即保守转交互**，门名见 `COMMAND_TOO_LONG_RULE`。
 */
export const MAX_DANGER_TEXT_CHARS = 256 * 1024

/**
 * 按 `MAX_DANGER_TEXT_CHARS` 有界截断门判据文本（超限只取前段，并如实报告截掉多少）。
 *
 * **边界不是命令边界**（v1.12.6 第六轮 · 终审 Minor 2 把声明说准）：切点在**字符下标**
 * 262144 上，被切残的尾部不参与判定 ⇒ 危险命令**起点**落在 262136 时仍命中，
 * 落在 262141 / 262143 时会 MISS。调用方按 `omitted > 0` 决定怎么处置
 * （`commandText` ⇒ 保守转交互；`argsText` ⇒ 只留痕）。
 * @param {string|null|undefined} text
 * @returns {{text: string, omitted: number}} `omitted` > 0 表示被截断（调用方据此留痕）
 */
export function boundDangerText(text) {
  if (typeof text !== 'string') return { text: '', omitted: 0 }
  if (text.length <= MAX_DANGER_TEXT_CHARS) return { text, omitted: 0 }
  return { text: text.slice(0, MAX_DANGER_TEXT_CHARS), omitted: text.length - MAX_DANGER_TEXT_CHARS }
}

/**
 * `commandText`（执行类调用的**真正的 shell 正文**）超过 `MAX_DANGER_TEXT_CHARS` 时给的门名：
 * 同样只到「**可疑**」这一档 —— 后段没扫过，判不出不等于放行（v1.12.6 第六轮 · 终审 Minor 3）。
 *
 * 为什么只对 `commandText` 走这条路、`argsText` 不走：`argsText` 是 args 里**所有**字符串值
 * 的拼接，`write` 的 `content` / `edit` 的 `new_string` 动辄几 MB，大正文是**常态**
 * ⇒ 超限即转交互会让每次大写入都弹框；而 `commandText` 只认
 * `command`/`cmd`/`commandLine`/`commandline`/`script` 五个键，超长不是常态，
 * 一旦超长就是真的「有一大段 shell 正文没判」。判据在 index.js 的危险命令门里
 * （与危险命令命中同一个位置、同一方向：门前置、早于一切档位）。
 */
export const COMMAND_TOO_LONG_RULE = 'command-too-long'

/**
 * 从宿主 `tool/call` 记录的 arguments（JSON 字符串或已 parse 的对象）里取 shell 正文。
 * 只认自身的属性（`command`/`cmd`/`script`…），数组形态（`command: [{command}]`）也认。
 * @param {string|object|null} args
 * @returns {string} 取不到时返回空串
 */
export function commandTextOf(args) {
  let parsed = args
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return ''
    try { parsed = JSON.parse(parsed) } catch { return '' }
  }
  if (!parsed || typeof parsed !== 'object') return ''
  for (const key of COMMAND_ARG_KEYS) {
    const value = parsed[key]
    if (typeof value === 'string' && value.trim()) return value
    if (Array.isArray(value)) {
      for (const item of value) {
        const nested = item && typeof item === 'object' ? item[key === 'script' ? 'script' : 'command'] : null
        if (typeof nested === 'string' && nested.trim()) return nested
      }
    }
  }
  return ''
}

/** 该次调用是否是执行类（工具名属执行类 slug，或参数里带 shell 正文） */
export function isExecuteTool(toolName, args) {
  if (typeof toolName === 'string' && EXECUTE_TOOL_SLUGS.has(toolName.toLowerCase())) return true
  return !!commandTextOf(args)
}

/**
 * 该次调用 args 里**所有字符串值**拼成的文本（换行分隔，递归上限 4 层）。
 *
 * 用途：工具名不在 EXECUTE_TOOL_SLUGS、参数键也不在 COMMAND_ARG_KEYS 时（自定义执行
 * 工具，例如 `{shell: 'rm -rf /tmp/x'}`），只跑
 * commandTextOf 等于什么都不判 —— 那是一次**静默放行**（v1.12.6 终审阻断的最后一格）。
 * **注意动机别写错**：`{argv: ['rm','-rf','/']}` **不在**这一格能救的范围里——argv 会被
 * 按值分别判、不拼回一条命令，实测判不出来；它是**登记在案的残留边界**（静态不可判定，
 * 见 DANGEROUS_COMMAND_RULES 的覆盖边界），不是本函数存在的理由。
 * 刻意取「所有字符串值」而不是「猜哪个键装命令」：猜错的方向是放行，属安全侧；
 * 代价是正文类参数（`write` 的 `content`、`edit` 的 `new_string`）里出现这三条命令也会
 * 弹一次（且只有它位于某行/段首时）—— 已知的多弹，与 heredoc 同属一类。
 * **递归上限 4 层**（`depth > 4` 即不再下探）：更深的结构里的字符串不可见，属登记在案的
 * 边界（嵌套 5 层以上的自定义工具参数判不出来），见 CHANGELOG。
 * @param {string|object|null} args 工具调用记录里的 arguments
 * @returns {string} 没有任何字符串值时返回空串
 */
export function argsTextOf(args) {
  let parsed = args
  if (typeof parsed === 'string') {
    if (!parsed.trim()) return ''
    try { parsed = JSON.parse(parsed) } catch { return parsed } // 解析不出：原文本身就是待判文本
  }
  if (!parsed || typeof parsed !== 'object') return ''
  const out = []
  const walk = (node, depth) => {
    if (depth > 4 || node == null) return
    if (typeof node === 'string') {
      if (node.trim()) out.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1)
      return
    }
    if (typeof node !== 'object') return
    for (const v of Object.values(node)) walk(v, depth + 1)
  }
  walk(parsed, 0)
  return out.join('\n')
}

// ── 子代理 → 主会话根 id 解析 ──

/**
 * 该会话是否宿主**委派**出来的子会话（只有它才允许沿 parentSession 上溯）。
 * 宿主字段口径（可在宿主源码复核）：
 *   - 子代理子会话必带 origin:'subagent' + delegationDepth>0
 *     （dsh-subagent/lib/index.js 的 childSessionMeta → SessionStore.create({meta})）；
 *   - fork（分叉会话）带 parentSession（cwd 可选），**不带** origin / delegationDepth。
 *     fork 另带一个「血统标记」，但该标记**随宿主版本而变**，判据从不读它。本机两个
 *     宿主版本都在，已就地复核：DSH 运行时安装树
 *     （~/.nvm/.../node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/）里是
 *     **dsh-session@0.2.0-rc.2**，其 SessionStore.fork() 落 `isSeeded: true`，且
 *     `validateSessionHeader` 对 `seedLength` 直接抛
 *     `session header has invalid field "seedLength"`；**0.1.0-rc.6** 只是
 *     `third/dsh-plugin-product-subagents/node_modules/` 里的插件开发副本，它的 fork()
 *     落 `seedLength`（该副本 lib/index.js:1849，:1121 承认其为合法头字段）。
 *     两种形态的共同不变量只有一个：**没有 origin / delegationDepth**——那正是本判据
 *     据此判定「自身即根」的依据，也是判据跨宿主版本稳健的原因。
 *   - 普通新会话两者皆无。
 * header 校验只放宽「多弹窗」方向（把 fork/普通会话判成非委派 → 它自己就是根），
 * 不放行跨会话放行。
 * @param {object} session 宿主 Session（或任何带 .header 的对象）
 * @returns {boolean}
 */
export function isDelegatedSession(session) {
  const header = session && typeof session === 'object' ? session.header : null
  if (!header || typeof header !== 'object') return false
  // 主判据：origin === 'subagent'（宿主 dsh-subagent 的子会话必带该字段）
  if (header.origin === 'subagent') return true
  // 兜底判据：delegationDepth > 0 —— **不要删**。origin 为主、深度为备：
  // 生产数据里真子代理恒带 origin='subagent'，但宿主版本差异/旧会话记录可能只落深度
  // 字段（届时缺兜底会把真子代理判成「自身即根」→ 同一根会话反复弹窗，属可用性退化）。
  // 兜底只放宽「继续上溯」这一方向，不会把 fork 拉进来：fork 两个字段都不带。
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

/**
 * 从 req.agent.session 出发，解析主会话根 id。
 * 只有**委派子会话**（isDelegatedSession：header.origin==='subagent' 或
 * delegationDepth>0）才沿 session.header.parentSession（dsh-session/lib/types/
 * types.d.ts:71，指向直接父级的 id 而非根 id）上溯；fork 与普通新会话直接返回自身 id。
 *
 * 上溯策略：header.parentSession 只到直接父级，孙→子→根 的完整链路靠
 * sessionRootOf（HostApprovalRules.#sessionRoots）链式补齐——该映射只由
 * index.js 的 approval/request 注册点写入，且注册点用同一 isDelegatedSession 判据，
 * 所以映射里不可能出现 fork→源会话 这类边，链式上溯的每一跳都天然满足同一判据。
 * 循环保护：已访问集合防环，深度上限 MAX_DEPTH 防过长链。
 * 无 sessionRootOf 时退化为只取直接父级。
 *
 * 回退链：header.parentSession 取不到 → 插件自有 dispatch.js 的
 * entry.parentSessionId 映射（由调用方传入 dispatcher，当前宿主版本下不可达——
 * 宿主恒会设置 header.parentSession，此回退仅作防御；entry.childId 只可能是
 * 本插件派出的子会话 id，不可能是 fork id，因此这一跳无需再加判据）→
 * 都取不到则 fallback 为自身 sessionId（绝不抛错）。
 *
 * 为什么用根 id（或最接近根的已知 id）做键：同一主代理会话内，所有子代理（含宿主原生
 * spawn 的）应共享工具名授权——bash 在路径 A 授权后，路径 B 的同类请求也自动放行，
 * 不再因路径不同或子代理不同而重复弹窗。根 id 保证所有子代理映射到同一个授权集合。
 * 反过来，fork 是**另一个用户可见会话**，不在「该主代理会话」的寿命口径内，
 * 若把它当作子会话上溯，就会让 fork 的授权写到源会话键上（跨会话静默放行），
 * 且源会话 dispose 后再写下的键没有任何 purge 路径（泄漏到进程结束）。
 *
 * @param {object} session 宿主 Session（有 header.parentSession / origin / delegationDepth）
 * @param {object} [dispatcher] 插件 Dispatcher（有 activeChildren）
 * @param {function} [sessionRootOf] 查询函数 (sessionId) => rootSessionId|null，
 *   由 HostApprovalRules.sessionRootOf 提供，支持链式上溯
 * @returns {string} 根会话 id 或自身 id（缺失时返回空串）
 */
export function resolveRootSessionId(session, dispatcher, sessionRootOf) {
  if (!session || typeof session.id !== 'string') return ''
  const visited = new Set()
  let current = session
  let depth = 0
  const MAX_DEPTH = 10
  while (depth < MAX_DEPTH) {
    const sid = current.id
    if (visited.has(sid)) break
    visited.add(sid)
    // 仅委派子会话才沿 parentSession 上溯：fork（只有 parentSession、无 origin/
    // delegationDepth）与普通新会话一律「自身即根」，绝不借用源会话的授权集合
    const parent = isDelegatedSession(current) ? current.header?.parentSession : undefined
    if (typeof parent === 'string' && parent && parent !== sid) {
      // 有 parentSession → 构造一个虚拟 session 继续上溯
      current = { id: parent, header: {} }
      depth++
      continue
    }
    // parentSession 取不到 → 尝试 dispatcher 映射
    if (dispatcher && typeof dispatcher.activeChildren === 'object') {
      let found = false
      for (const [, entry] of dispatcher.activeChildren.entries()) {
        if (entry?.childId === sid && entry.parentSessionId) {
          current = { id: entry.parentSessionId, header: {} }
          depth++
          found = true
          break
        }
      }
      if (found) continue
    }
    // 都取不到 → 尝试 sessionRootOf 链式上溯
    if (typeof sessionRootOf === 'function') {
      const rootId = sessionRootOf(sid)
      if (rootId && rootId !== sid) {
        current = { id: rootId, header: {} }
        depth++
        continue
      }
    }
    // 所有上溯路径都到头 → 当前 id 即为根
    break
  }
  return current.id
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
  /**
   * 工具名级会话授权：Map<rootSessionId, Set<toolName>>。
   * 键为主会话根 id（非子代理自身 id），使同一主代理会话内所有子代理
   * （含宿主原生 spawn 的）共享工具名授权。值是该根会话已授权的工具名集合。
   * 一次授权 bash 后，同一根会话下所有子代理的 bash 调用都自动放行，
   * 不再因路径不同而重复弹窗。会话结束即失效（purgeSession 清理）。
   * @type {Map<string, Set<string>>}
   */
  #toolGrants = new Map()
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

  /**
   * 追加一条会话规则（路径规则去重合并）。
   * @param {string} sessionId 键（根会话 id 或子会话 id，与 decide 读取侧一致）
   * @param {string[]} paths 路径列表
   * @param {{expand?: boolean}} [opts] expand=false 用于 v1.12.6「可编辑路径」弹框：
   *   用户声明的已经是目录，再补一次父目录会把授权放大（/tmp/newproj ⇒ /tmp）
   */
  addSessionRule(sessionId, paths, { expand = true } = {}) {
    if (!sessionId || typeof sessionId !== 'string' || !Array.isArray(paths)) {
      return { ok: false, error: 'sessionId 或 paths 缺失' }
    }
    const clean = [...new Set(paths.filter((p) => typeof p === 'string' && p.trim()))]
    if (clean.length === 0) return { ok: false, error: 'paths 为空' }
    // v1.10.2：补直接父目录——ACP 子代理权限请求形态为 [文件, 父目录]，
    // 主代理工具调用解析出的路径常只有文件级；不补父目录则子代理无法复用主代理规则。
    const expanded = expand ? expandPathsWithParents(clean) : [...new Set(clean.map((p) => path.normalize(p)))]
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

  /**
   * 注册「会话 id → 根会话 id」映射，供 purgeSession 与 resolveRootSessionId 使用。
   * purgeSession(子会话) 时只清自身映射项，不删根授权；
   * purgeSession(根会话) 时清理所有指向该根的子会话映射；
   * resolveRootSessionId 用此做链式上溯（孙→子→根）。
   * v1.12.4：调用方（index.js 的 approval/request 注册点）必须先用
   * isDelegatedSession 判据把关——本方法只挡自环（sessionId===rootSessionId），
   * 挡不住 fork→源会话 这类边；一旦登记，fork 的子代理会经此映射链回源会话，
   * 等于把阻断 1 换条路重新打开。
   * @param {string} sessionId
   * @param {string} rootSessionId
   */
  #sessionRoots = new Map()
  registerSessionRoot(sessionId, rootSessionId) {
    if (sessionId && rootSessionId && sessionId !== rootSessionId) {
      this.#sessionRoots.set(sessionId, rootSessionId)
    }
  }
  /** 查询已注册的根会话 id（仅供测试与 purgeSession 使用） */
  sessionRootOf(sessionId) {
    return this.#sessionRoots.get(sessionId) ?? null
  }

  /**
   * 会话结束清理：只清理「属于该 sessionId 自身」的键。
   * - 子会话 dispose：删自身路径规则、自身工具名授权（通常没有）、自身 sessionRoot 映射；
   *   **不删**根会话的工具名授权和路径规则——否则子代理跑完就丢授权，
   *   恰好制造本需求要消灭的「每个子代理跑完就丢授权、用户被迫重复点」现象。
   * - 根会话 dispose：删根的路径规则和工具名授权，并清理所有指向该根的子会话 sessionRoot 映射。
   * 参考：dsh-plugin-product-subagents/lib/permission-state.js:270-290 dispose()
   *   只匹配 key===sid || key.startsWith(sid+'::')，不越权清理其他会话的键。
   *
   * 本方法只返回清理摘要、不打日志：排障时「授权为什么没了」必须能事后回溯，
   * 而 console 在宿主重启后不留痕迹 → 由 index.js 的 session/disposed 监听器把这条
   * 摘要写进插件既有决策日志（dispatches.jsonl）。
   * @param {string} sessionId
   * @returns {{sid: string, rootId: string|null, hadRules: boolean, hadGrants: boolean, childMappings: number, isRoot: boolean}}
   */
  purgeSession(sessionId) {
    const hadRules = this.#sessionRules.delete(sessionId)
    const hadGrants = this.#toolGrants.delete(sessionId)
    const rootId = this.#sessionRoots.get(sessionId) ?? null
    this.#sessionRoots.delete(sessionId)
    let childMappings = 0
    if (!rootId) {
      // 根会话 dispose：清理所有指向该根的子会话 sessionRoot 映射
      for (const [sid, rid] of this.#sessionRoots) {
        if (rid === sessionId) { this.#sessionRoots.delete(sid); childMappings++ }
      }
    }
    return { sid: sessionId, rootId, hadRules, hadGrants, childMappings, isRoot: !rootId }
  }

  // ── 工具名级会话授权（内存，根会话键）──

  /**
   * 追加一条工具名授权（根会话内该工具名自动放行）。
   * @param {string} rootSessionId 主会话根 id（非子代理自身 id）
   * @param {string} toolName 工具名（如 'bash'）
   * @returns {{ ok: boolean, error?: string, count?: number }}
   */
  addToolGrant(rootSessionId, toolName) {
    if (!rootSessionId || typeof rootSessionId !== 'string') {
      return { ok: false, error: 'rootSessionId 缺失' }
    }
    if (!toolName || typeof toolName !== 'string') {
      return { ok: false, error: 'toolName 缺失' }
    }
    let set = this.#toolGrants.get(rootSessionId)
    if (!set) { set = new Set(); this.#toolGrants.set(rootSessionId, set) }
    set.add(toolName)
    return { ok: true, count: set.size }
  }

  /** 某根会话的工具名授权列表（只读快照） */
  toolGrants(rootSessionId) {
    const set = this.#toolGrants.get(rootSessionId)
    return set ? [...set] : []
  }

  /** 工具名授权是否覆盖该请求 */
  toolGrantCovers(rootSessionId, toolName) {
    if (!rootSessionId || !toolName) return false
    const set = this.#toolGrants.get(rootSessionId)
    return set ? set.has(toolName) : false
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
   * v1.12.6：`rule.expand === false` 表示路径来自「可编辑路径」弹框的用户声明
   * （已是目录，不再补父目录）；缺省 true，落盘内容与 1.12.5 逐字节一致。
   */
  appendProjectRule(rule) {
    const rules = this.readProjectRules()
    const expand = rule.expand !== false
    const rawPaths = Array.isArray(rule.paths) ? rule.paths.filter((p) => typeof p === 'string' && p.trim()) : []
    const norm = {
      cwd: typeof rule.cwd === 'string' && rule.cwd.trim() ? path.normalize(rule.cwd.trim()) : null,
      paths: [...new Set(expand ? expandPathsWithParents(rawPaths) : rawPaths.map((p) => path.normalize(p)))],
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
   * 分档判定：工具名授权 → 会话路径规则 → 项目路径规则。
   * 工具名授权（#toolGrants）优先短路：根会话已授权该工具名 → 直接 allowed，
   * 完全不依赖 paths（即使 paths 为空也不影响）。
   * disallowToolGrant=true 时**只跳过工具名这一档**，路径两档照旧判定（单独使用时）。
   * 沙箱越权走这条（v1.12.5 用户裁定：工具名级授权不适用于越权，但路径级记忆必须生效）；
   * ACP 孪生根本不会到这里——调用方在它上面有一道早退门，直接 next()。
   * sessionOnly=true 时**再跳过落盘的项目档**，只剩会话路径规则：越权的
   * 「同一路径不再弹」因此只在本次主代理会话内成立，新会话必须重新问
   * （v1.12.5 二次裁定：不允许把「某路径可提权到 danger-full-access」静默落盘长期留存）。
   * @param {{sessionId?: string, rootSessionId?: string, cwd?: string|null, paths: string[], toolName?: string|null, disallowToolGrant?: boolean, sessionOnly?: boolean}} req
   * @returns {{allowed: boolean, scope: 'session-tool'|'session'|'project'|null, covered: string[], uncovered: string[]}}
   */
  decide({ sessionId, rootSessionId, cwd, paths, toolName, disallowToolGrant = false, sessionOnly = false }) {
    // 优先短路：工具名授权（根会话键，不依赖 paths）
    const rootId = rootSessionId || sessionId
    if (!disallowToolGrant && rootId && toolName && this.toolGrantCovers(rootId, toolName)) {
      return { allowed: true, scope: 'session-tool', covered: [], uncovered: [] }
    }
    // 路径规则：解析不出路径的请求不参与路径规则匹配
    if (!Array.isArray(paths) || paths.length === 0) {
      return { allowed: false, scope: null, covered: [], uncovered: [] }
    }
    if (sessionId) {
      // v1.12.1：路径规则写入键可能是 rootSessionId（前端 POST 时传 rootSessionId），
      // 也可能是 sessionId（老数据）。读取时先查 rootId，再查 sessionId，保证两种键都能命中。
      const lookupId = rootId || sessionId
      let set = this.#sessionRules.get(lookupId)
      if (!set && lookupId !== sessionId) set = this.#sessionRules.get(sessionId)
      if (set && set.size > 0) {
        const d = allowlistDecision(paths, [...set])
        if (d.allowed) return { allowed: true, scope: 'session', covered: d.covered, uncovered: [] }
      }
    }
    // 落盘项目档：sessionOnly（越权）不参与——见上方 JSDoc 的二次裁定
    if (!sessionOnly && cwd && this.projectRulesCover(cwd, paths)) {
      return { allowed: true, scope: 'project', covered: [...paths], uncovered: [] }
    }
    const d = allowlistDecision(paths, [])
    return { allowed: false, scope: null, covered: [], uncovered: d.uncovered }
  }
}
