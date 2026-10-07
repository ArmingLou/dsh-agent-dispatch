// v1.12.15（用户裁定）：高危操作授权弹框——专用形态的行为回归测试。
//
// 用户原话：「碰到是高危情况下 的悬浮球弹出，只需要提示 **高危操作权限申请**，
// 这种情况下，按钮操作 只需要提供 **允许一次** 和 **拒绝**。」
// 追加硬要求：「需要保留**相关命令的操作内容**」——上一轮用户就是因为球上看不到
// `rm -rf` 才误判（旧渲染把 description 截到 160 字符，命中片段在尾部时完全看不见）。
//
// 要钉住的四件事：
//   ① 归因（askReason==='danger' 或 dangerRule 非空，两条通道任一信号都算）⇒ 专用形态：
//      标题「高危操作权限申请」+ 命中规则名 + **触发片段原文** + 命令内容，按钮集合
//      恰好 = {允许一次, 拒绝}；
//   ② 专用形态**不得**出现任何记住类入口（本会话/项目/路径/工具档/落盘），也不得出现
//      「本会话将记住」这类承诺文案——点「允许一次」不许打开目录编辑弹框、不许 POST 规则；
//   ③ 命令内容原样呈现：空白不折叠、不二次加工，危险片段在**命令尾部**时也必须在渲染结果里
//      能原样找到（这条就是 160 字符截断的回归点）；
//   ④ 非高危询问**一字不变**地保留原有完整按钮集合（防回归）。
//
// lib/client.js 是浏览器 classic script（依赖 window/document），无法 import——
// 沿用 test/grant-dialog.test.js 与 test/perm-fab-jump.test.js 的做法：把真正跑的
// 那段源码从源码里整块抠出来执行（编译对象是本仓库第一方源码，仅测试进程内），
// 数据半用**生产版** serializePermissionPending 组装，这样"产品侧字段 → REST 序列化 →
// 渲染"整条链一起被钉住。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { serializePermissionPending } from '../lib/dispatch.js'

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(path.join(repoRoot, 'lib', 'client.js'), 'utf8')

/** 抠出 [startMarker, 首个 closeMarker) 的原文；找不到即失败——结构被改写会立刻暴露 */
function grab(startMarker, closeMarker, label) {
  const i = src.indexOf(startMarker)
  assert.ok(i >= 0, `client.js 中找不到 "${startMarker}"（${label} 被改名或删除？）`)
  const j = src.indexOf(closeMarker, i + startMarker.length)
  assert.ok(j > i, `${label} 之后找不到闭合锚点 "${closeMarker}"（结构被改写请同步本用例）`)
  return src.slice(i, j)
}

// ── 生产源码切片（渲染半全部用真代码，不复刻实现）──
const PERM_ROWS_SLICE = grab('function permRowsOf(arr) {', '\n    // ── v1.12.6 U1/U2', 'permRowsOf')
const DANGER_SLICE = grab('const DANGER_ASK_TITLE', '\n    let grantDialogOpen', 'v1.12.15 高危共用件')
const PERM_FAB_SLICE = grab('function mountPermFab() {', '\n    // ── v1.11.4：授权双球去重共享状态', 'mountPermFab')
const HOST_FAB_SLICE = grab('function mountHostApprovalFab(clientCtx) {', '\n    module.exports = {', 'mountHostApprovalFab')

// ── 假 DOM（只实现两条面板真正用到的那部分）──
class FakeEl {
  constructor(tag) {
    this.tagName = tag
    this.childNodes = []
    this.attrs = {}
    this._class = ''
    this._text = null
    this.id = ''
    this.title = ''
    this.type = ''
    this.className = ''
    this.disabled = false
    this.style = {}
    this.parentNode = null
    this._listeners = new Map()
  }

  set className(v) { this._class = String(v) }
  get className() { return this._class }

  /** 面板用 classList 控制展开/可见，替身按 _class 字符串实现同一套语义 */
  get classList() {
    const self = this
    const tokens = () => String(self._class || '').split(/\s+/).filter(Boolean)
    const write = (list) => { self._class = list.join(' ') }
    return {
      add(...cs) { const t = tokens(); for (const c of cs) if (!t.includes(c)) t.push(c); write(t) },
      remove(...cs) { write(tokens().filter((c) => !cs.includes(c))) },
      contains(c) { return tokens().includes(c) },
      toggle(c, force) {
        const has = tokens().includes(c)
        const on = force === undefined ? !has : Boolean(force)
        if (on) this.add(c); else this.remove(c)
        return on
      },
    }
  }

  set textContent(v) { this._text = String(v); this.childNodes = [] }
  get textContent() {
    return this._text !== null ? this._text : this.childNodes.map((c) => c.textContent).join('')
  }

  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false }
  remove() {
    if (!this.parentNode) return
    this.parentNode.childNodes = this.parentNode.childNodes.filter((x) => x !== this)
    this.parentNode = null
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(fn)
  }

  removeEventListener() {}

  fire(type, extra = {}) {
    const ev = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, extra)
    for (const fn of [...(this._listeners.get(type) || [])]) fn(ev)
    return ev
  }

  click() { return this.fire('click') }
}

function fakeDocument() {
  const doc = new FakeEl('#document')
  doc.body = new FakeEl('body')
  doc.createElement = (tag) => new FakeEl(tag)
  doc.getElementById = (id) => {
    const hit = walk(doc.body).find((n) => n.id === id)
    return hit || null
  }
  return doc
}

function walk(node, out = []) {
  out.push(node)
  for (const c of node.childNodes || []) walk(c, out)
  return out
}

function byClass(root, cls) {
  return walk(root).filter((n) => String(n.className || '').split(/\s+/).includes(cls))
}

/** 面板内所有真按钮（`ad-btn` 类）的文案，顺序 = 渲染顺序 */
function buttonLabels(root) {
  return byClass(root, 'ad-btn').map((b) => b.textContent)
}

const flush = async (n = 30) => { for (let i = 0; i < n; i += 1) await Promise.resolve() }

// ── 编译两条面板：注入替身依赖，真代码执行 ──
/** 记住类入口的替身：被调用即记账（专用形态一条都不许碰到） */
function spies() {
  const calls = []
  const mark = (name) => (...args) => { calls.push([name, ...args]); return Promise.resolve(null) }
  return {
    calls,
    openGrantDialog: mark('openGrantDialog'),
    apiPostRule: (route, body) => { calls.push(['apiPost', route, body]); return Promise.resolve({ ok: true }) },
  }
}

function compilePermFab(opts) {
  const doc = opts.document
  const names = [
    'document', 'console', 'setInterval', 'clearInterval', 'apiGet', 'apiPost', 'openAgentSession',
    'permGrantTip', 'absolutizeDirs', 'dirsOfPaths', 'nonEmptyArray', 'openGrantDialog', 'acpTwinSync', 'acpTwinMarkDecided',
  ]
  const factory = new Function(...names,
    `${PERM_ROWS_SLICE}\n${DANGER_SLICE}\n${PERM_FAB_SLICE}\nreturn mountPermFab`)
  const timers = []
  return factory(
    doc,
    { warn: () => {} },
    (fn) => { timers.push(fn); return timers.length },
    () => {},
    opts.apiGet,
    opts.apiPost,
    opts.openAgentSession || (() => Promise.resolve(true)),
    () => '（本会话将记住：qoder:bash）', // 生产版 permGrantTip 的替身：非高危行才走到，用它验证"专用形态不得出现将记住"
    (v) => v,
    (v) => v,
    (v) => Array.isArray(v) && v.length > 0,
    opts.openGrantDialog,
    () => {},
    () => {},
  )
}

function compileHostFab(opts) {
  const doc = opts.document
  // 注入值的**类型**逐个对齐生产绑定（lib/client.js:4578-4583）：
  // hold/decided 是 Map、lastAmberKeys 是 Set、blueOps 由本面板自己赋值（初值 null）。
  // 类型错了不会让用例立刻红，但会把"面板真跑到了孪生分支"这件事糊掉。
  const names = [
    'document', 'console', 'setTimeout', 'clearTimeout', 'apiGet', 'apiPost',
    'isEscalationReason', 'dirsOfPaths', 'openGrantDialog',
    'acpTwinHold', 'acpTwinHolds', 'acpTwinSeq', 'acpTwinLastAmberKeys', 'acpTwinPromote', 'acpTwinDrop',
    'acpTwinMarkDecided', 'acpTwinDecided', 'acpTwinBlueOps',
  ]
  const factory = new Function(...names,
    `${DANGER_SLICE}\n${HOST_FAB_SLICE}\nreturn mountHostApprovalFab`)
  return factory(
    doc,
    { warn: () => {} },
    (fn) => { opts.timers.push(fn); return opts.timers.length },
    () => {},
    opts.apiGet,
    opts.apiPost,
    () => false,
    (v) => v,
    opts.openGrantDialog,
    new Map(),
    () => new Set(),
    0,
    new Set(),
    () => {},
    () => {},
    () => {},
    new Map(),
    null,
  )
}

/** 琥珀球：挂面板 → 轮询到 rows → 点球展开列表，返回该行的 DOM */
async function mountAmberRow(permissionPending, extra = {}) {
  const doc = fakeDocument()
  const sp = spies()
  const posts = []
  const entry = {
    childId: extra.childId || 'child-A',
    agentId: extra.agentId || 'coder',
    agentName: extra.agentName || '编码子代理',
    parentSessionId: 'parent-1',
    ...serializePermissionPending([permissionPending], null),
  }
  const mount = compilePermFab({
    document: doc,
    openGrantDialog: sp.openGrantDialog,
    apiGet: () => Promise.resolve({ active: [entry] }),
    apiPost: (route, body) => { posts.push([route, body]); return Promise.resolve({ ok: true }) },
  })
  mount()
  await flush()
  const ball = doc.getElementById('ad-perm-fab')
  assert.ok(ball, '琥珀球根节点应已挂载')
  ball.click()
  const rows = byClass(doc.body, 'ad-perm-item')
  assert.equal(rows.length, 1, `琥珀球列表应恰好渲染 1 行，实际 ${rows.length}`)
  return { doc, row: rows[0], posts, spyCalls: sp.calls, ball }
}

/** 蓝球：注册 approval/request → 服务端上下文回传 → 点球展开列表 */
async function mountHostRow(ctxFromServer, request = {}) {
  const doc = fakeDocument()
  const sp = spies()
  const posts = []
  let handler = null
  const req = {
    toolName: 'Bash',
    callId: 'call-1',
    reason: 'Run a shell command',
    ...request,
  }
  const mount = compileHostFab({
    document: doc,
    openGrantDialog: sp.openGrantDialog,
    timers: [],
    apiGet: () => Promise.resolve({ ok: true, ...ctxFromServer }),
    apiPost: (route, body) => { posts.push([route, body]); return Promise.resolve({ ok: true }) },
  })
  const dispose = mount({
    remote: {
      $on: (name, fn) => { if (name === 'approval/request') handler = fn; return () => {} },
    },
    sessions: { scopeOf: () => 'session-1' },
  })
  assert.ok(handler, 'approval/request 监听器应已注册')
  // 监听器返回的就是 answerPromise——用户点哪个按钮，它的兑现值就是哪个 outcome
  const settled = handler(req, () => 'next')
  await flush()
  const ball = doc.getElementById('ad-host-approval-fab')
  assert.ok(ball, '蓝球根节点应已挂载')
  ball.click()
  const rows = byClass(doc.body, 'ad-ha-item')
  assert.equal(rows.length, 1, `蓝球列表应恰好渲染 1 行，实际 ${rows.length}`)
  return { doc, row: rows[0], posts, spyCalls: sp.calls, settled, dispose }
}

/** 等 answerPromise 落定（超时视为"没有应答"，由断言转红而不是让用例挂死） */
const settle = async (p) => Promise.race([p, new Promise((res) => setTimeout(() => res('TIMEOUT'), 200))])

/** 高危 pending 载荷（B 侧 0.7.16 的字段形状，逐字照抄契约） */
const dangerPending = (over = {}) => ({
  permId: 'tc-1#1',
  product: 'qoder',
  toolName: 'Bash',
  description: 'Allow bash?',
  paths: ['/tmp/a'],
  suggestedDirs: ['/tmp'],
  askReason: 'danger',
  dangerRule: 'rm -rf',
  dangerSegment: 'rm -rf /tmp/a',
  dangerCommand: 'rm -rf /tmp/a',
  ...over,
})

const clickBtn = async (row, label) => {
  const btn = byClass(row, 'ad-btn').find((b) => b.textContent === label)
  assert.ok(btn, `行内应有按钮「${label}」，实际按钮：${buttonLabels(row).join(' / ')}`)
  btn.click()
  await flush()
  return btn
}

/**
 * 高危行的**形态**断言。点击类用例也钉它：普通行同样有「允许一次」「拒绝」，
 * 只断言投递结果的话，"高危按普通行渲染"这种退化是抓不住的（变异①实测就漏过去了）。
 */
const assertDangerRow = (row) => {
  assert.equal(byClass(row, 'ad-danger-item').length, 1, '该行必须是高危专用形态')
}

describe('v1.12.15 高危归因判据 dangerAskOf：两条通道任一信号都算，缺信号才回退普通卡', () => {
  const mod = new Function(`${DANGER_SLICE}\nreturn { dangerAskOf }`)()

  it('askReason=danger ⇒ 判为高危，并给出规则名/片段/命令', () => {
    const d = mod.dangerAskOf(dangerPending())
    assert.ok(d, 'askReason=danger 必须判为高危')
    assert.equal(d.rule, 'rm -rf')
    assert.equal(d.segment, 'rm -rf /tmp/a')
    assert.equal(d.command, 'rm -rf /tmp/a')
  })

  it('只有 dangerRule（老 B 载荷没有 askReason）⇒ 仍判高危，不得悄悄回退成"可记忆的普通询问"', () => {
    const legacy = { dangerRule: 'git push', commandText: 'git push origin main' }
    const d = mod.dangerAskOf(legacy)
    assert.ok(d, '归因信号有一个就够：A 已知道原因时绝不能按普通询问渲染')
    assert.equal(d.rule, 'git push')
    assert.equal(d.command, 'git push origin main', '原生通道没有 dangerCommand，命令正文取 commandText')
  })

  it('两个信号都没有 ⇒ 判 null（这是"老产品侧不透传归因"的既定降级：渲染原普通卡，由用例 A 侧字段先钉住）', () => {
    assert.equal(mod.dangerAskOf({ toolName: 'Bash', description: 'Allow bash?' }), null)
    assert.equal(mod.dangerAskOf({ askReason: 'sandbox-escalation', dangerRule: '' }), null, 'askReason 只认 danger；空 dangerRule 不算信号')
    assert.equal(mod.dangerAskOf(null), null)
  })

  it('命令正文取值优先级：dangerCommand → commandText → argsText；超长只截展示并如实报省略数', () => {
    assert.equal(mod.dangerAskOf({ dangerRule: 'rm -rf', commandText: 'CMD', argsText: 'ARGS' }).command, 'CMD')
    assert.equal(mod.dangerAskOf({ dangerRule: 'rm -rf', argsText: 'ARGS' }).command, 'ARGS')
    const long = 'echo start && ' + 'x'.repeat(30000) + ' && rm -rf /tmp/a'
    const d = mod.dangerAskOf({ dangerRule: 'rm -rf', dangerSegment: 'rm -rf /tmp/a', dangerCommand: long })
    assert.equal(d.command.length, 20000, '展示上限 20000 字符（几 MB 正文不得整块塞进 DOM）')
    assert.equal(d.commandOmitted, long.length - 20000)
    assert.equal(d.segment, 'rm -rf /tmp/a', '片段本身不截断，永远原样给')
  })

  it('片段/命令一律原样：连续空白与换行不得被折叠或 trim', () => {
    const raw = 'cd /tmp   &&   rm  -rf    /tmp/a'
    const d = mod.dangerAskOf({ dangerRule: 'rm -rf', dangerSegment: raw, dangerCommand: 'line1\nline2   tail' })
    assert.equal(d.segment, raw)
    assert.equal(d.command, 'line1\nline2   tail')
  })
})

describe('v1.12.15 琥珀球（ACP 通道）：高危 ⇒ 专用形态，只有「允许一次」「拒绝」', () => {
  it('标题「高危操作权限申请」+ 规则名 + 触发片段，按钮集合恰好 = {允许一次, 拒绝}', async () => {
    const { row } = await mountAmberRow(dangerPending())
    const text = row.textContent
    assert.match(text, /高危操作权限申请/, '标题必须是用户指定的那句')
    assert.match(text, /rm -rf/, '必须显示命中的危险规则名')
    assert.deepEqual(buttonLabels(row), ['允许一次', '拒绝'], `高危行只允许两个按钮，实际：${buttonLabels(row).join(' / ')}`)
    assert.doesNotMatch(text, /本会话总是允许|总是允许\(项目\)|总是允许该工具|落盘|将记住/, '不得出现任何记住类入口或承诺文案')
    assert.equal(byClass(row, 'ad-perm-actions').length, 0, '高危行走独立操作行，不得复用普通行的四按钮容器')
  })

  it('硬要求：危险命令在**尾部**时，片段必须原样出现在弹框内容里（160 字符截断的回归点）', async () => {
    const long = 'cd /x && echo "一大段说明文字" && grep -R "needle" . && rm -rf /tmp/a'
    const { row } = await mountAmberRow(dangerPending({
      description: 'Allow bash?',
      dangerCommand: long,
      dangerSegment: 'rm -rf /tmp/a',
    }))
    assert.ok(row.textContent.includes('rm -rf /tmp/a'), '尾部命中必须可见')
    assert.ok(row.textContent.includes(long), '命令内容要整条原样呈现，不得只给 description 的前 160 字符')
  })

  it('点「允许一次」⇒ 只投 allow-once，不带 paths、不开目录弹框、不写任何规则', async () => {
    const { row, posts, spyCalls } = await mountAmberRow(dangerPending())
    assertDangerRow(row)
    await clickBtn(row, '允许一次')
    assert.equal(posts.length, 1, '只应投递一次决策')
    assert.equal(posts[0][0], '/agent-api/permission-decision')
    assert.deepEqual(posts[0][1], { childId: 'child-A', permId: 'tc-1#1', answer: 'allow-once' }, '高危的 allow-once 不得附带 paths')
    assert.deepEqual(spyCalls, [], '高危行不得打开目录编辑弹框，也不得 POST 授权规则')
  })

  it('点「拒绝」⇒ deny', async () => {
    const { row, posts } = await mountAmberRow(dangerPending())
    assertDangerRow(row)
    await clickBtn(row, '拒绝')
    assert.equal(posts.length, 1)
    assert.equal(posts[0][1].answer, 'deny')
  })

  it('同一列表里混一条非高危请求 ⇒ 高危行走专用形态，非高危行的四按钮集合一字不变（防回归）', async () => {
    const doc = fakeDocument()
    const sp = spies()
    const posts = []
    const entries = [
      { childId: 'c1', agentName: 'A', ...serializePermissionPending([dangerPending({ permId: 'tc-d#1' })], null) },
      { childId: 'c2', agentName: 'B', ...serializePermissionPending([{ permId: 'tc-n#1', product: 'qoder', toolName: 'Bash', description: 'Allow bash?', paths: ['/x'], suggestedDirs: ['/x'] }], null) },
    ]
    const mount = compilePermFab({
      document: doc,
      openGrantDialog: sp.openGrantDialog,
      apiGet: () => Promise.resolve({ active: entries }),
      apiPost: (route, body) => { posts.push([route, body]); return Promise.resolve({ ok: true }) },
    })
    mount()
    await flush()
    doc.getElementById('ad-perm-fab').click()
    const rows = byClass(doc.body, 'ad-perm-item')
    assert.equal(rows.length, 2)
    const [dRow, nRow] = rows
    assert.deepEqual(buttonLabels(dRow), ['允许一次', '拒绝'])
    assert.deepEqual(buttonLabels(nRow), ['允许一次', '本会话总是允许该工具', '总是允许(项目)', '拒绝'],
      `非高危询问必须保持原有完整按钮集合，实际：${buttonLabels(nRow).join(' / ')}`)
    assert.match(nRow.textContent, /本会话将记住/, '非高危行仍走 permGrantTip 的原文案')
    await clickBtn(nRow, '本会话总是允许该工具')
    assert.ok(sp.calls.some((c) => c[0] === 'openGrantDialog'), '非高危的记住类按钮仍必须先开目录确认弹框（原行为不变）')
  })

  it('只有 askReason 没有规则名（B 侧异常）⇒ 仍是专用形态，规则位如实说"未标注规则名"', async () => {
    const { row } = await mountAmberRow(dangerPending({ dangerRule: '', dangerSegment: '', dangerCommand: '' }))
    assert.deepEqual(buttonLabels(row), ['允许一次', '拒绝'])
    assert.match(row.textContent, /高危操作权限申请/)
    assert.match(row.textContent, /未标注规则名/)
  })
})

describe('v1.12.15 蓝球（宿主原生审批通道）：dangerRule 命中同样走专用形态', () => {
  const nativeCtx = {
    toolName: 'Bash',
    paths: ['/tmp/a'],
    structuredPaths: ['/tmp/a'],
    inferredPaths: [],
    cwd: '/proj',
    home: '/Users/x',
    rootSessionId: 'root-1',
    callId: 'call-1',
    askReason: 'danger',
    dangerRule: 'rm -rf',
    dangerSegment: 'rm -rf /tmp/a',
    commandText: 'cd /proj && echo "很长的说明" && rm -rf /tmp/a',
  }

  it('标题 + 规则 + 完整命令可见，按钮集合恰好 = {允许一次, 拒绝}', async () => {
    const { row } = await mountHostRow(nativeCtx)
    assert.match(row.textContent, /高危操作权限申请/)
    assert.ok(row.textContent.includes('rm -rf /tmp/a'), '尾部命中必须可见')
    assert.ok(row.textContent.includes(nativeCtx.commandText), '原生通道要展示完整命令正文，不是只给规则名')
    assert.deepEqual(buttonLabels(row), ['允许一次', '拒绝'], `蓝球高危行只允许两个按钮，实际：${buttonLabels(row).join(' / ')}`)
    assert.doesNotMatch(row.textContent, /本会话总是允许|总是允许\(项目\)|将记住/, '不得出现记住类入口')
  })

  it('点「允许一次」⇒ answer(allowed-once) 且不 POST 任何授权规则；点「拒绝」⇒ answer(rejected)', async () => {
    const a = await mountHostRow(nativeCtx)
    assertDangerRow(a.row)
    await clickBtn(a.row, '允许一次')
    assert.equal(await settle(a.settled), 'allowed-once')
    assert.equal(a.posts.length, 0, '高危行不得写会话档/项目档')
    assert.deepEqual(a.spyCalls, [], '高危行不得打开目录编辑弹框')
    const b = await mountHostRow(nativeCtx)
    assertDangerRow(b.row)
    await clickBtn(b.row, '拒绝')
    assert.equal(await settle(b.settled), 'rejected')
  })

  it('超长命令（command-too-long）⇒ 截到展示上限并如实标注省略，片段仍原样给出', async () => {
    const huge = 'python3 - <<EOF\n' + 'x'.repeat(40000)
    const { row } = await mountHostRow({
      ...nativeCtx,
      dangerRule: 'command-too-long',
      dangerSegment: 'commandText 超长（40014 字符 > 262144）',
      commandText: huge,
    })
    assert.match(row.textContent, /高危操作权限申请/)
    assert.deepEqual(buttonLabels(row), ['允许一次', '拒绝'])
    assert.match(row.textContent, /另有 .* 个字符未展示/, '截断必须如实说明，不能假装是完整命令')
  })

  it('没有归因（非高危）⇒ 蓝球四按钮 + 原警告文案一字不变（防回归）', async () => {
    const { row } = await mountHostRow({ ...nativeCtx, askReason: null, dangerRule: null, dangerSegment: null, commandText: '' })
    assert.deepEqual(buttonLabels(row), ['允许一次', '本会话总是允许该工具', '总是允许(项目)', '拒绝'])
    assert.doesNotMatch(row.textContent, /高危操作权限申请/)
  })
})
