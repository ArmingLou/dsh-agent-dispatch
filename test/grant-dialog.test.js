// v1.12.6 U1/U2/U3：「可编辑路径」授权弹框 + 面板「说实话」的行为回归测试。
//
// 这一版要钉住的现场问题：
//   U1 面板骗人——琥珀卡片上「（本会话将记住：<category>）」里的 category 只是
//      title 的 slug，**不是记忆键**（qoder 场景是一长串命令），显示它等于告诉用
//      户一件不会发生的事；
//   U2 点了就生效——「本会话总是允许 / 总是允许(项目)」过去直接按服务端自动分析
//      的结果落规则，用户看不到也改不了「到底记住了哪几个目录」，而粒度是目录级
//      （M1 裁定：含父目录，一个兄弟路径一起被放过）；
//   U3 弹框必须能滚——见 test/fab-panel-layout.test.js 同款布局契约。
//
// lib/client.js 是浏览器 classic script（依赖 window/document），无法 import。
// 沿用 test/client-form-logic.test.js 的做法：把真正跑的那几段从源码里抠出来、
// 注入假 DOM 后**执行**——源码被改坏会取不到而报错，判定被改坏会被真断言拦下。
// 取「整块」而不是逐行 grep 是刻意的：转红实验④（弹框绕过确认直接生效）必须能
// 被行为断言抓到，而不是靠字符串匹配侥幸命中。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

// ── 假 DOM（只实现弹框真正用到的那部分）──
class FakeEl {
  constructor(tag) {
    this.tagName = tag
    this.childNodes = []
    this.attrs = {}
    this._class = ''
    this._text = null
    this.title = ''
    this.value = ''
    this.placeholder = ''
    this.disabled = false
    this.wrap = ''
    this.spellcheck = true
    this.style = {}
    this.parentNode = null
    this._listeners = new Map()
    this._focused = false
  }

  set className(v) { this._class = String(v) }
  get className() { return this._class }

  set textContent(v) { this._text = String(v); this.childNodes = [] }
  get textContent() {
    return this._text !== null ? this._text : this.childNodes.map((c) => c.textContent).join('')
  }

  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c }
  remove() {
    if (!this.parentNode) return
    this.parentNode.childNodes = this.parentNode.childNodes.filter((x) => x !== this)
    this.parentNode = null
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, [])
    this._listeners.get(type).push(fn)
  }

  removeEventListener(type, fn) {
    const arr = this._listeners.get(type)
    if (!arr) return
    const i = arr.indexOf(fn)
    if (i >= 0) arr.splice(i, 1)
  }

  /** 触发事件；返回事件对象（可自定义 target，模拟点遮罩 vs 点面板内部） */
  fire(type, extra = {}) {
    const ev = Object.assign({ target: this, preventDefault() {}, stopPropagation() {} }, extra)
    for (const fn of [...(this._listeners.get(type) || [])]) fn(ev)
    return ev
  }

  click() { return this.fire('click') }
  focus() { this._focused = true }
  setSelectionRange() {}
}

function fakeDocument() {
  const doc = new FakeEl('#document')
  doc.body = new FakeEl('body')
  doc.createElement = (tag) => new FakeEl(tag)
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

function one(root, cls) {
  const list = byClass(root, cls)
  assert.equal(list.length, 1, `弹框内 .${cls} 应恰好 1 个，实际 ${list.length}`)
  return list[0]
}

/**
 * 从源码里取一段箭头函数定义并剥掉 `const 名字 =` 前缀与末尾分号，
 * 剩下的可以直接塞进 `return ( … )` 里编译。
 * endMarker 传「闭合那一行的缩进 + };」——多一个字符都会把整段截歪。
 */
function grabExpr(startMarker, endMarker) {
  const at = src.indexOf(startMarker)
  assert.ok(at >= 0, `client.js 找不到 "${startMarker}"（被改名或删除？）`)
  const close = src.indexOf(endMarker, at)
  assert.ok(close > at, `"${startMarker}" 之后找不到闭合锚点 "${endMarker}"`)
  return src.slice(at, close + endMarker.length).replace(/^const\s+\w+\s*=\s*/, '').replace(/;\s*$/, '')
}

// ── 把 v1.12.6 的共用件整块抠出来执行 ──
const HELP_START = 'function isEscalationReason(reason) {'
const HELP_END = '\n    // 返回一跳'
const iStart = src.indexOf(HELP_START)
assert.ok(iStart >= 0, `client.js 找不到 "${HELP_START}"（共用件被改名或删除？）`)
const iEnd = src.indexOf(HELP_END, iStart)
assert.ok(iEnd > iStart, `client.js 里 openGrantDialog 之后找不到锚点 "${HELP_END}"（结构变了请同步本用例）`)
const helpersSrc = src.slice(iStart, iEnd)

/**
 * 编译共用件模块：isEscalationReason / toolGrantKeyOf / parentDirOf / dirsOfPaths /
 * linesToPaths / permGrantTip / openGrantDialog（含模块级 grantDialogOpen 闩）。
 * 只注入 document 与 setTimeout，其余依赖都在这块内部自洽。
 */
function buildGrantModule(inputDoc) {
  const doc = inputDoc || fakeDocument()
  const pending = []
  const factory = new Function('document', 'setTimeout',
    helpersSrc + '\nreturn { isEscalationReason, toolGrantKeyOf, parentDirOf, resolveAgainstCwd, dirsOfPaths, absolutizeDirs, linesToPaths, permGrantTip, openGrantDialog };')
  const mod = factory(doc, (fn) => { pending.push(fn); return pending.length })
  return { mod, doc, flushTimeouts: () => pending.splice(0).forEach((f) => f()) }
}

/** 弹框挂到 body 后，返回 {mask, pop, groups, rows, hint, toolLine, add, btnCancel, btnOk} */
function dialogParts(doc) {
  const masks = byClass(doc.body, 'ad-grant-mask')
  assert.equal(masks.length, 1, '同一时刻遮罩应恰好 1 个（grantDialogOpen 闩的作用）')
  const mask = masks[0]
  const pop = one(mask, 'ad-grant-pop')
  const groups = byClass(pop, 'ad-grant-group')
  const rows = byClass(pop, 'ad-grant-row').map((box) => ({
    box,
    chk: byClass(box, 'ad-grant-chk')[0],
    dir: byClass(box, 'ad-grant-dir')[0],
    del: byClass(box, 'ad-grant-del')[0],
  }))
  return {
    mask,
    pop,
    groups,
    rows,
    hint: one(pop, 'ad-grant-hint'),
    toolLine: one(pop, 'ad-grant-tool'),
    actions: one(pop, 'ad-grant-actions'),
    add: one(pop, 'ad-grant-add'),
    btnCancel: byClass(pop, 'ad-btn')[0],
    btnOk: byClass(pop, 'ad-btn')[1],
  }
}

/** 某一组里的目录行（groups[0]=实际触达，groups[1]=文本推测） */
function rowsOfGroup(group) {
  return byClass(group, 'ad-grant-row').map((box) => ({
    box,
    chk: byClass(box, 'ad-grant-chk')[0],
    dir: byClass(box, 'ad-grant-dir')[0],
    del: byClass(box, 'ad-grant-del')[0],
  }))
}

function groupTitle(group) {
  return byClass(group, 'ad-grant-gtitle')[0].textContent
}

function groupSub(group) {
  return byClass(group, 'ad-grant-gsub')[0].textContent
}

describe('U1 permGrantTip：三态如实，不再拿 category 骗人', () => {
  const { mod } = buildGrantModule()

  it('解析得出工具名 ⇒ 显示真实记忆键 product:tool（小写归一）', () => {
    assert.equal(mod.permGrantTip({ product: 'Qoder', toolName: 'Bash' }), '（本会话将记住：qoder:bash）')
    assert.equal(mod.permGrantTip({ toolName: 'Edit' }), '（本会话将记住：edit）', '无 product 时退化为工具名，仍不能是 category')
  })

  it('只有路径 / 只有建议目录 ⇒ 明说按路径记住且粒度是目录', () => {
    const t1 = mod.permGrantTip({ suggestedDirs: ['/tmp/p7/alpha'] })
    assert.match(t1, /按路径记住/, '只有目录级记忆时不能说「记住工具」')
    assert.match(t1, /目录级/, 'M1 裁定：粒度必须写清是目录级（含父目录）')
    assert.doesNotMatch(t1, /\/tmp\/p7/, '提示里不得回显完整路径原文（路径属敏感信息，按需最小化）')
    const t2 = mod.permGrantTip({ paths: ['/tmp/p7/alpha/a.txt'] })
    assert.equal(t2, t1, '有 paths 无 suggestedDirs 时同样按路径档说话')
  })

  it('工具名与路径都没有 ⇒ 直说只放行一次、什么都不记', () => {
    assert.equal(mod.permGrantTip({}), '（本次仅放行一次，不会记住：下次仍会询问）')
    assert.equal(mod.permGrantTip({ suggestedDirs: [], paths: [] }), '（本次仅放行一次，不会记住：下次仍会询问）')
    assert.equal(mod.permGrantTip(null), '')
  })

  it('旧文案（拿 category 当记忆键）已从源码消失', () => {
    assert.doesNotMatch(src, /"（本会话将记住："\s*\+\s*[^\n]*category/, 'category 不是记忆键，不得再出现在「将记住」文案里')
    assert.match(src, /const catTip = permGrantTip\(a\.permissionPending\);/, '琥珀卡片必须改用 permGrantTip')
  })
})

// ── 交付要求 Part 3 不变量⑤：工具名档跨产品隔离 ──
// 琥珀通道（ACP 权限）的记忆键归**产品侧** product-subagents 0.7.9 所有，键形如
// `product:tool`；本插件只负责把它**如实显示**给用户。键构造一旦与产品侧不同构，
// 面板就会指着一条不存在的记忆说「将记住」，或把两个产品的同名工具说成同一条记忆。
describe('不变量⑤：工具名档跨产品隔离（真实记忆键 = product:tool）', () => {
  const { mod } = buildGrantModule()

  it('同名工具在不同产品下是**两条**记忆，互不覆盖', () => {
    const a = mod.toolGrantKeyOf('qoder', 'bash')
    const b = mod.toolGrantKeyOf('deveco', 'bash')
    assert.equal(a, 'qoder:bash')
    assert.equal(b, 'deveco:bash')
    assert.notEqual(a, b, '跨产品共用了工具名档键')
    assert.notEqual(mod.permGrantTip({ product: 'qoder', toolName: 'bash' }), mod.permGrantTip({ product: 'deveco', toolName: 'bash' }))
  })

  it('大小写与空白归一：同一产品同一工具不会写成两条', () => {
    assert.equal(mod.toolGrantKeyOf(' Qoder ', '\tBASH '), 'qoder:bash')
    assert.equal(mod.toolGrantKeyOf('qoder', 'Bash'), mod.toolGrantKeyOf('QODER', 'bash'))
  })

  it('缺 product ⇒ 退化为裸工具名（不编一个产品前缀）；缺 toolName ⇒ null', () => {
    assert.equal(mod.toolGrantKeyOf('', 'bash'), 'bash')
    assert.equal(mod.toolGrantKeyOf(null, 'Bash'), 'bash')
    assert.equal(mod.toolGrantKeyOf('qoder', ''), null)
    assert.equal(mod.toolGrantKeyOf(null, null), null)
    assert.equal(mod.permGrantTip({ product: 'qoder' }), '（本次仅放行一次，不会记住：下次仍会询问）')
  })

  it('面板说的键与产品侧同构：源码里键构造只有一处，且不带 category / paths', () => {
    const at = src.indexOf('function toolGrantKeyOf(product, toolName) {')
    assert.ok(at > 0, 'toolGrantKeyOf 定义丢失（改签名请同步本用例与产品侧 0.7.9 toolGrantKey）')
    const body = src.slice(at, src.indexOf('\n    }', at))
    assert.match(body, /return p \+ ":" \+ t;/, '键分隔符变了（产品侧用 ":"）')
    assert.doesNotMatch(body, /category|paths/, '记忆键里混进了 category 或 paths')
    assert.equal((src.match(/function toolGrantKeyOf\(/g) || []).length, 1, '键构造出现了第二份实现（必然漂移）')
  })
})

describe('U2 目录预填与文本互转（dirsOfPaths / linesToPaths / parentDirOf）', () => {  const { mod } = buildGrantModule()

  it('文件路径 ⇒ 取其父目录；本身像目录 ⇒ 原样；结果去重保序', () => {
    assert.deepEqual(
      mod.dirsOfPaths(['/tmp/p7/alpha/a.txt', '/tmp/p7/alpha', '/tmp/p7/beta/c.md', '/tmp/p7/alpha/a.txt']),
      ['/tmp/p7/alpha', '/tmp/p7/beta'],
    )
  })

  it('M2（终审）：只有**明确是文件形态**才取父目录——名字像文件的目录一律原样', () => {
    // 终审逐字复算的放大路径：`.ssh` / `my-project` / `notes_2024` 被判成「像文件」
    // ⇒ 取父目录 ⇒ 预填默认勾选 + 服务端只做词法校验 ⇒ 手快确认一次就把整份
    // 家目录 / 上级目录写进会话授权。判据现在只认「带扩展名」或显式文件白名单。
    assert.deepEqual(mod.dirsOfPaths(['/a/b/my-project']), ['/a/b/my-project'])
    assert.deepEqual(mod.dirsOfPaths(['/home/dev/.ssh']), ['/home/dev/.ssh'])
    assert.deepEqual(mod.dirsOfPaths(['/tmp/notes_2024']), ['/tmp/notes_2024'])
    assert.deepEqual(mod.dirsOfPaths(['/a/b/.github']), ['/a/b/.github'], '.github 是目录，不是 .git 系配置文件')
    assert.deepEqual(mod.dirsOfPaths(['/a/b/foo-bar']), ['/a/b/foo-bar'])
    // 明确是文件形态（带扩展名 / 白名单）照旧取其父目录
    assert.deepEqual(mod.dirsOfPaths(['/a/b/x.txt']), ['/a/b'])
    assert.deepEqual(mod.dirsOfPaths(['/home/dev/.ssh/id_ed25519']), ['/home/dev/.ssh'])
    assert.deepEqual(mod.dirsOfPaths(['/home/dev/.ssh/id_rsa.pub']), ['/home/dev/.ssh'])
    assert.deepEqual(mod.dirsOfPaths(['/home/dev/.gitconfig']), ['/home/dev'])
    assert.deepEqual(mod.dirsOfPaths(['/a/b/Makefile']), ['/a/b'])
    // 名字里的点**不是**扩展名（终审那条：`.ssh` 曾被当成带扩展名的文件）；
    // 但「末段以 .<1-8 位字母数字> 结尾」仍按文件处理（`foo-1.2` 这种版本后缀：
    // 判成文件只取一层父目录，方向比判成目录更窄）
    assert.deepEqual(mod.dirsOfPaths(['/usr/local/bin/foo-1.2']), ['/usr/local/bin'])
  })

  it('M2（第四轮终审）：裸 `.git` 是**目录**，必须原样——不得放大到项目根', () => {
    // 改前 FILE_FORM_RE 写的是 `\.git(?:config|ignore|attributes|modules|keep)?`：
    // 可选组让**裸 `.git`** 也进白名单 ⇒ `/repo/.git` 被判成文件、取父目录 `/repo`。
    // 预填默认勾选 + 服务端只做词法校验 ⇒ 用户点一次确认就把整个项目根写进会话授权。
    // `.git` 与同一段注释里刻意排除的 `.github` 同属目录，取舍原则只有一个：
    // **只收录「作为名字时必然是文件」的形态**。
    assert.deepEqual(mod.dirsOfPaths(['/repo/.git']), ['/repo/.git'])
    assert.deepEqual(mod.dirsOfPaths(['/repo/.git/']), ['/repo/.git'])
    assert.deepEqual(mod.dirsOfPaths(['/repo/.git/config']), ['/repo/.git/config'],
      '白名单按**末段**比对：`config` 不在名单里（它可能是目录名）⇒ 原样，方向只会更窄')
    assert.deepEqual(mod.dirsOfPaths(['/repo/.gitignore']), ['/repo'], '.gitignore 必然是文件')
    assert.deepEqual(mod.dirsOfPaths(['/repo/.gitattributes']), ['/repo'])
    assert.deepEqual(mod.dirsOfPaths(['/repo/.gitmodules']), ['/repo'])
    // 同族的「必然是文件」白名单照旧（这些名字当目录不存在）
    assert.deepEqual(mod.dirsOfPaths(['/srv/known_hosts']), ['/srv'])
    assert.deepEqual(mod.dirsOfPaths(['/srv/authorized_keys']), ['/srv'])
    assert.deepEqual(mod.dirsOfPaths(['/proj/.env']), ['/proj'])
    assert.deepEqual(mod.dirsOfPaths(['/proj/Makefile']), ['/proj'])
    assert.deepEqual(mod.dirsOfPaths(['/p/.gitignore']), ['/p'])
  })

  it('Minor（第四轮终审）：原始串以分隔符结尾 ⇒ 直接当目录原样，不再套文件判据', () => {
    // 改前先 `replace(/[/\\]+$/,'')` 丢掉尾斜杠，再套文件判据 ⇒ `/a/b/foo.d/` 里
    // `foo.d` 被当成带扩展名的文件、放大到 `/a/b`。用户已经用尾斜杠明说这是目录。
    assert.deepEqual(mod.dirsOfPaths(['/a/b/foo.d/']), ['/a/b/foo.d'])
    assert.deepEqual(mod.dirsOfPaths(['/a/b/foo.d']), ['/a/b'], '无尾斜杠时按文件判据照旧')
    assert.deepEqual(mod.dirsOfPaths(['/a/b/x.txt/']), ['/a/b/x.txt'])
    assert.deepEqual(mod.dirsOfPaths(['/repo/.git/']), ['/repo/.git'])
  })

  it('第五轮（用户裁定）：非绝对路径**按 cwd 拼成绝对路径**再进编辑框', () => {
    // 用户原话（paraphrase）：「相对路径，自动用工作区目录拼写完整再放入编辑区吧。」
    // 起因是终审 M-B：`./x.txt` 默认勾选 + 服务端只认绝对路径 ⇒ 声明被丢空 ⇒
    // 静默退化成工具名档（授权放大到整个工具）。预填阶段补齐就不会走到那一步。
    // **这条推翻了第四轮那组「非绝对路径原样保留」的断言**（见 CHANGELOG 第五轮）。
    const CWD = '/proj'
    assert.deepEqual(mod.dirsOfPaths(['./x.txt'], CWD), ['/proj'], '相对文件路径 ⇒ 拼 cwd 后按文件形态取父目录')
    assert.deepEqual(mod.dirsOfPaths(['src/index.ts'], CWD), ['/proj/src'], '子目录里的文件 ⇒ /proj/src')
    assert.deepEqual(mod.dirsOfPaths(['sub/dir/a.txt'], CWD), ['/proj/sub/dir'])
    assert.deepEqual(mod.dirsOfPaths(['../other/a.txt'], '/proj/sub'), ['/proj/other'], '`..` 要按词法消掉')
    assert.deepEqual(mod.dirsOfPaths(['./src/'], CWD), ['/proj/src'], '尾分隔符 ⇒ 用户已明说是目录 ⇒ 原样（不取父目录）')
    assert.deepEqual(mod.dirsOfPaths(['./a/b/../c'], CWD), ['/proj/a/c'], '`.` / `..` / 重复分隔符都要规范化')
    assert.deepEqual(mod.dirsOfPaths(['src//x/./y.txt'], CWD), ['/proj/src/x'],
      '相对段里的重复分隔符与 `.` 段一并折叠（再按文件形态取父目录）')
    // `~` 不展开：宿主与服务端都不展开它，猜错的方向是把授权挪到**别的**目录 ⇒ 降级
    assert.deepEqual(mod.dirsOfPaths(['~/.ssh/id_rsa'], CWD), ['~/.ssh/id_rsa'],
      '按用户裁定的建议：`~` 一律降级（不瞎猜家目录），由弹框负责「不勾选 + 提示」')
    assert.deepEqual(mod.dirsOfPaths(['~/.ssh/id_rsa.pub'], CWD), ['~/.ssh/id_rsa.pub'])
    // cwd 不可用时同样降级（fail-safe）：原样保留，**不默认勾选**由弹框用例钉住
    assert.deepEqual(mod.dirsOfPaths(['./x.txt'], null), ['./x.txt'])
    assert.deepEqual(mod.dirsOfPaths(['sub/dir/a.txt'], undefined), ['sub/dir/a.txt'])
    assert.deepEqual(mod.dirsOfPaths(['./x.txt'], 'relative/cwd'), ['./x.txt'], 'cwd 自身不是绝对路径 ⇒ 不拿来拼')
    // 已是绝对路径的原样走既有逻辑（钉住「本裁定没有顺手动绝对路径」）
    assert.deepEqual(mod.dirsOfPaths(['/a/b/x.txt'], CWD), ['/a/b'])
    assert.deepEqual(mod.dirsOfPaths(['C:\\a\\b\\x.txt'], CWD), ['C:\\a\\b'], '盘符路径按既有规则，不套 cwd')
    assert.deepEqual(mod.dirsOfPaths(['/repo/.git'], CWD), ['/repo/.git'])
  })

  it('第六轮 Minor 4：resolveAgainstCwd 收到**绝对路径** ⇒ 直接返回（不拼 cwd）', () => {
    // 两个调用点（absolutizeDirs / dirsOfPaths）都有 `ABS_PATH_RE` 前置，所以这条路径
    // **当前不可达**；但少了这个前置，一旦有第三个调用点就会拼出
    // `"C:/base/C:/win/x.txt"` 这种怪东西再走一遍规范化 —— 属潜在地雷。
    // 这里直接调它（harness 把这一整块共用件抠出来编译，见 buildGrantModule）。
    assert.equal(mod.resolveAgainstCwd('C:/win/x.txt', 'C:/base'), 'C:/win/x.txt',
      '盘符绝对路径必须原样返回（改前会拼成 C:/base/C:/win/x.txt）')
    assert.equal(mod.resolveAgainstCwd('/abs/x.txt', '/proj'), '/abs/x.txt',
      'POSIX 绝对路径必须原样返回（改前会拼成 /proj/abs/x.txt）')
    assert.equal(mod.resolveAgainstCwd('C:\\win\\x.txt', 'C:/base'), 'C:\\win\\x.txt')
    assert.equal(mod.resolveAgainstCwd('/', '/proj'), null, '盘根仍按 ROOT_LIKE_RE 丢弃（不进授权集）')
    assert.equal(mod.resolveAgainstCwd('C:/', 'C:/base'), null)
    // 相对路径的既有行为一字未动（本轮的改动只加前置，不改拼装与规范化）
    assert.equal(mod.resolveAgainstCwd('./x.txt', '/proj'), '/proj/x.txt')
    assert.equal(mod.resolveAgainstCwd('sub/dir/a.txt', '/proj'), '/proj/sub/dir/a.txt')
    assert.equal(mod.resolveAgainstCwd('../other/a.txt', '/proj/sub'), '/proj/other/a.txt')
    assert.equal(mod.resolveAgainstCwd('./x.txt', null), null, 'cwd 缺失 ⇒ 降级（既有行为）')
    assert.equal(mod.resolveAgainstCwd('./x.txt', 'relative/cwd'), null, 'cwd 非绝对 ⇒ 降级（既有行为）')
    assert.equal(mod.resolveAgainstCwd('~/.ssh/id_rsa', '/proj'), null, '`~` 不展开（既有行为）')
  })

  it('第五轮：absolutizeDirs 只补绝对化、不套文件形态（产品侧目录不被放大）', () => {
    assert.deepEqual(mod.absolutizeDirs(['./a', 'src/b', '/c/d', '~/.ssh'], '/proj'),
      ['/proj/a', '/proj/src/b', '/c/d', '~/.ssh'])
    assert.deepEqual(mod.absolutizeDirs(['./a'], null), ['./a'], '无 cwd ⇒ 原样（降级）')
    assert.deepEqual(mod.absolutizeDirs(['/proj/build.d'], '/proj'), ['/proj/build.d'],
      '名字像文件的**目录**不得被取父目录（那是预填变宽）')
    assert.deepEqual(mod.absolutizeDirs(['', '   ', null, 42], '/proj'), [])
  })

  it('根目录与空串被丢弃：/ 一旦进授权集＝任意路径免弹', () => {
    // v1.12.6 第五轮（终审 Minor 1）：尾分隔符分支此前只挡了字面 `/`，
    // `C:\\` 会走「原样保留」那条路 ⇒ 返回 `['C:']`，绕过 parentDirOf 的盘根守卫。
    assert.deepEqual(mod.dirsOfPaths(['/', '', '   ', null, undefined, '/x/y.p']), ['/x'])
    assert.deepEqual(mod.dirsOfPaths(['/']), [])
    assert.deepEqual(mod.dirsOfPaths(['C:\\']), [], '盘根不参与（改前是 [\'C:\']）')
    assert.deepEqual(mod.dirsOfPaths(['C:']), [])
    assert.deepEqual(mod.dirsOfPaths(['//']), [])
    assert.deepEqual(mod.dirsOfPaths(['C:\\'], '/proj'), [])
    assert.deepEqual(mod.dirsOfPaths(['/proj/x.txt'], '/proj'), ['/proj'], '非根路径不受这条影响')
    assert.equal(mod.parentDirOf('/a.txt'), null, '父级是文件系统根时返回 null')
    assert.equal(mod.parentDirOf('C:\\'), null)
    assert.equal(mod.parentDirOf('/x/y/'), '/x', '末尾斜杠先归一')
  })

  it('弹框文本 → 提交数组：按行拆分、去空行、去重保序', () => {
    assert.deepEqual(mod.linesToPaths('/a\n\n  /b  \n/a\n\n/c'), ['/a', '/b', '/c'])
    assert.deepEqual(mod.linesToPaths(''), [])
    assert.deepEqual(mod.linesToPaths(null), [])
  })

  it('isEscalationReason 与 lib/host-approval.js 的 isSandboxEscalation 同判据', () => {
    const host = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'host-approval.js'), 'utf8')
    const RE_TEXT = '/^\\s*escalate\\s+sandbox\\s+to/i'
    assert.ok(host.includes(RE_TEXT), '服务端判据正则原文必须先存在')
    assert.ok(String(mod.isEscalationReason).includes(RE_TEXT), '客户端判据必须与服务端同一条正则')
    assert.equal(mod.isEscalationReason('escalate sandbox to /tmp/x'), true)
    assert.equal(mod.isEscalationReason('Escalate  Sandbox   to root'), true)
    assert.equal(mod.isEscalationReason('需要写权限'), false)
    assert.equal(mod.isEscalationReason(undefined), false)
  })
})

describe('U2 openGrantDialog：确认才生效，取消什么都不发', () => {
  it('第一组预填 = suggestedDirs 逐行；只读工具行显示当前工具名且不可编辑', async () => {
    const { mod, doc, flushTimeouts } = buildGrantModule()
    const dirs = ['/tmp/p7/alpha', '/tmp/p7/beta']
    const p = mod.openGrantDialog({ product: 'qoder', toolName: 'Edit', suggestedDirs: dirs, projectTier: false })
    const { rows, toolLine, pop } = dialogParts(doc)
    assert.deepEqual(rows.map((r) => r.dir.value), dirs, '一行一个目录')
    assert.equal(rows.every((r) => r.dir.tagName === 'input' && r.dir.type === 'text'), true, '目录必须可编辑')
    assert.equal(rows.every((r) => r.chk.tagName === 'input' && r.chk.type === 'checkbox'), true, '每条都要有自己的勾选框')
    assert.equal(toolLine.tagName, 'div', '工具名行必须是只读容器，不能是可编辑控件')
    assert.match(toolLine.textContent, /^工具：Edit/, 'U2：最后一行只读显示当前工具名')
    assert.match(toolLine.textContent, /只读/, '必须明说它不可编辑')
    assert.match(toolLine.title, /只读/)
    assert.equal(byClass(pop, 'ad-grant-body')[0].childNodes.length >= 5, true,
      '内容区要装下两组目录 + 添加按钮 + 提示 + 只读工具行')
    flushTimeouts()
    rows[0].dir.click() // 无 click 监听，不应关闭
    assert.equal(byClass(doc.body, 'ad-grant-mask').length, 1)
    btnCancelAndResolve(mod, p, doc)
  })

  it('解析不出工具名 ⇒ 只读行如实说「解析不出」，不编一个名字', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ product: 'qoder', suggestedDirs: [] })
    const { toolLine } = dialogParts(doc)
    assert.match(toolLine.textContent, /工具：（本条解析不出工具名）/)
    btnCancelAndResolve(mod, p, doc)
  })

  it('全不勾 ⇒ 提示写明「只要工具名」并给出真实记忆键；改回勾选即恢复', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ product: 'qoder', toolName: 'Bash', suggestedDirs: ['/tmp/a'] })
    const { rows, hint } = dialogParts(doc)
    assert.match(hint.textContent, /将记住 1 个目录/)
    rows[0].chk.checked = false
    rows[0].chk.fire('change')
    assert.match(hint.textContent, /一条都没勾/, '全不勾要落到「只记住工具名」这句话')
    assert.match(hint.textContent, /只记住工具名/)
    assert.match(hint.textContent, /qoder:bash/, '全不勾后要说清退化成哪个键')
    assert.match(hint.className, /warn/)
    rows[0].dir.value = '/tmp/a\n/tmp/b'
    rows[0].dir.fire('input')
    rows[0].chk.checked = true
    rows[0].chk.fire('change')
    assert.match(hint.textContent, /将记住 2 个目录/, '同一行里换行粘贴 = 两个目录（沿用按行拆分）')
    assert.doesNotMatch(hint.className, /warn/)
    btnCancelAndResolve(mod, p, doc)
  })

  it('会话档 vs 项目档 vs 越权：档位说明各自如实（越权不落盘、不走工具名档）', async () => {
    const cases = [
      { o: { projectTier: false }, session: /会话档[\s\S]*不落盘/, project: null, esc: null },
      { o: { projectTier: true }, session: null, project: /项目档[\s\S]*落盘/, esc: null },
      { o: { projectTier: true, escalation: true }, session: null, project: null, esc: /沙箱越权[\s\S]*只到本会话[\s\S]*不落盘/ },
    ]
    for (const c of cases) {
      const { mod, doc } = buildGrantModule()
      const p = mod.openGrantDialog({ toolName: 'Bash', suggestedDirs: ['/tmp/a'], ...c.o })
      const note = one(doc.body, 'ad-grant-note').textContent
      if (c.session) assert.match(note, c.session)
      if (c.project) assert.match(note, c.project)
      if (c.esc) assert.match(note, c.esc)
      if (c.esc) {
        const { rows, hint } = dialogParts(doc)
        rows[0].chk.checked = false
        rows[0].chk.fire('change')
        assert.match(hint.textContent, /不走工具名档/, '越权全不勾时必须说清工具名档对它无效（否则是第二次骗人）')
      }
      btnCancelAndResolve(mod, p, doc)
    }
  })

  it('M3（终审）：门命中（dangerRule）时弹框必须写明「每次都会询问、不可记忆」', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Bash', suggestedDirs: ['/tmp/a'], dangerRule: 'rm -rf' })
    const danger = one(doc.body, 'ad-grant-danger')
    assert.match(danger.textContent, /每次都会询问/, '不写明就是让用户以为已经授权（终审 M3）')
    assert.match(danger.textContent, /不可记忆/, '必须点破「记忆不生效」')
    assert.match(danger.textContent, /rm -rf/, '门名要写出来，用户才知道撞的是哪条门')
    btnCancelAndResolve(mod, p, doc)
    // 对照：没命中门的请求不得贴这条（否则是谎报「每次都问」）
    const b2 = buildGrantModule()
    const p2 = b2.mod.openGrantDialog({ toolName: 'Bash', suggestedDirs: ['/tmp/a'] })
    assert.equal(byClass(b2.doc.body, 'ad-grant-danger').length, 0)
    btnCancelAndResolve(b2.mod, p2, b2.doc)
    // 球上那一行同款文案（球是主要入口，只弹框有说明不算说清）
    assert.match(src, /item\.dangerRule[\s\S]{0,200}每次都会询问/, '蓝球条目缺「每次都问」提示')
    assert.match(src, /item\.dangerRule = d\.dangerRule/, '服务端回传的 dangerRule 必须落到条目上')
  })

  it('确认 ⇒ resolve({paths})，且按用户改后的内容（不是预填）', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Edit', suggestedDirs: ['/tmp/a', '/tmp/b'] })
    const { rows, btnOk } = dialogParts(doc)
    rows[0].dir.value = '/tmp/a'
    rows[1].dir.value = '/tmp/c/'
    btnOk.click()
    const d = await p
    // 末尾斜杠不在客户端剪（客户端不判路径合法性）——服务端 validateDeclaredPaths
    // 归一，两处各剪一次必然出现"一边认一边不认"
    assert.deepEqual(d, { paths: ['/tmp/a', '/tmp/c/'] })
    assert.equal(byClass(doc.body, 'ad-grant-mask').length, 0, '确认后遮罩必须撤掉')
  })

  it('取消 / Esc / 点遮罩 ⇒ resolve(null)：不发决策、不写规则', async () => {
    const ways = [
      (parts) => parts.btnCancel.click(),
      (parts, doc) => doc.fire('keydown', { key: 'Escape' }),
      (parts, doc) => byClass(doc.body, 'ad-grant-mask')[0].click(),
    ]
    for (const act of ways) {
      const { mod, doc } = buildGrantModule()
      const p = mod.openGrantDialog({ toolName: 'Edit', suggestedDirs: ['/tmp/a'] })
      const parts = dialogParts(doc)
      parts.rows[0].dir.value = '/tmp/CHANGED-BY-USER'
      act(parts, doc)
      assert.equal(await p, null, '取消路径必须 resolve(null)')
      assert.equal(byClass(doc.body, 'ad-grant-mask').length, 0, '取消后遮罩要撤干净')
    }
  })

  it('点面板内部（非遮罩）不关闭：误触不丢用户已改的目录', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Edit', suggestedDirs: ['/tmp/a'] })
    const { pop, btnOk } = dialogParts(doc)
    pop.fire('click', { target: pop })
    assert.equal(byClass(doc.body, 'ad-grant-mask').length, 1, '点内容区不应关掉弹框')
    btnOk.click()
    assert.deepEqual((await p).paths, ['/tmp/a'])
  })

  it('同一时刻只开一个：第二个直接 resolve(null)，不会留下无人管的遮罩', async () => {
    const { mod, doc } = buildGrantModule()
    const first = mod.openGrantDialog({ toolName: 'Edit', suggestedDirs: ['/tmp/a'] })
    const second = await mod.openGrantDialog({ toolName: 'Edit', suggestedDirs: ['/tmp/z'] })
    assert.equal(second, null, '重复点击不叠加弹框')
    assert.equal(byClass(doc.body, 'ad-grant-mask').length, 1)
    dialogParts(doc).btnOk.click()
    assert.deepEqual((await first).paths, ['/tmp/a'])
  })

  it('删除按钮真的把该条从提交结果里去掉（不是只去掉勾选）', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Edit', suggestedDirs: ['/tmp/a', '/tmp/b'] })
    const { rows, btnOk } = dialogParts(doc)
    assert.match(dialogParts(doc).hint.textContent, /将记住 2 个目录/)
    rows[0].del.click()
    assert.equal(rows[0].box.parentNode, null, '删掉的行要从 DOM 摘掉')
    assert.match(dialogParts(doc).hint.textContent, /将记住 1 个目录/)
    btnOk.click()
    assert.deepEqual((await p).paths, ['/tmp/b'])
  })

  it('「+ 添加目录」补一行且默认勾选（用户自己填的当然是本意）', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Edit', suggestedDirs: [] })
    const { add, btnOk } = dialogParts(doc)
    add.click()
    const { rows } = dialogParts(doc)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].chk.checked, true, '手动补的目录默认就是用户本意，不该再让他勾一次')
    rows[0].dir.value = '/tmp/typed'
    rows[0].dir.fire('input')
    btnOk.click()
    assert.deepEqual((await p).paths, ['/tmp/typed'])
  })

  it('弹框挂在 document.body 而不是面板内容区：3s 轮询重建 popBody 不会吞掉它', () => {
    assert.match(src, /document\.body\.appendChild\(mask\);/, '遮罩必须挂 body')
    assert.doesNotMatch(src, /popBody\.appendChild\(mask\)|pop\.appendChild\(mask\)/, '挂进面板=轮询重建时一起没了')
    // 关掉后 keydown 监听必须摘掉，否则每次开弹框都留一个 Escape 处理器
    const doc = fakeDocument()
    const { mod } = buildGrantModule(doc)
    const p = mod.openGrantDialog({ toolName: 'Edit', suggestedDirs: [] })
    const before = (doc._listeners.get('keydown') || []).length
    assert.ok(before >= 1)
    dialogParts(doc).btnCancel.click()
    assert.equal((doc._listeners.get('keydown') || []).length, before - 1, 'finish 必须 removeEventListener')
    return p
  })
})

// ── 交付要求 U4：预填分两组，**未勾选的推测项不得进 paths** ──
describe('U4 两组预填：实际触达默认勾选、文本推测默认不勾选', () => {
  const SUG = ['/tmp/p7/alpha', '/tmp/p7/beta']
  const INF = ['/etc', '/home/dev/.ssh', '/Users/dev/.qoder']

  it('两组各自渲染并标注来源；勾选状态=第一组全勾、第二组全不勾', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ product: 'qoder', toolName: 'Edit', suggestedDirs: SUG, inferredDirs: INF })
    const { groups, rows } = dialogParts(doc)
    assert.equal(groups.length, 2, '必须渲染两组（合成一组就等于把不可信来源默认授权出去）')
    assert.match(groupTitle(groups[0]), /实际触达/)
    assert.match(groupTitle(groups[1]), /推测/)
    assert.match(groupTitle(groups[1]), /默认不选/, '第二组标题自己就要写明默认不选')
    assert.match(groupSub(groups[0]), /工具调用里真实的路径字段/, '要标注来源')
    assert.match(groupSub(groups[1]), /只是文本里出现的字符串/, '小字必须点明推测项的来源不可信')
    assert.match(groupSub(groups[1]), /被编辑的文件内容/)
    assert.equal(rowsOfGroup(groups[0]).length, 2)
    assert.equal(rowsOfGroup(groups[1]).length, 3)
    assert.deepEqual(rows.map((r) => r.chk.checked), [true, true, false, false, false],
      '默认勾选状态：第一组勾、第二组不勾')
    assert.deepEqual(rows.map((r) => r.dir.value), [...SUG, ...INF])
    dialogParts(doc).btnCancel.click()
    await p
  })

  it('默认渲染下点确认 ⇒ 只有 suggestedDirs 进 paths，推测项一条都不发', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ product: 'qoder', toolName: 'Edit', suggestedDirs: SUG, inferredDirs: INF })
    const { btnOk } = dialogParts(doc)
    btnOk.click()
    const d = await p
    assert.deepEqual(d, { paths: SUG }, '未勾选的推测目录不得出现在请求体里')
    for (const bad of INF) assert.equal(d.paths.includes(bad), false, `${bad} 未勾选却发了出去`)
  })

  // ── v1.12.6 第五轮（终审 M-B + 用户裁定）──────────────────────────────
  it('M-B：非绝对路径（`~` 解析不出）**强制不勾选**，行下给可读提示，且不随确认发出去', async () => {
    const { mod, doc } = buildGrantModule()
    // 上游已按 cwd 解析过一轮；`~` 走降级 ⇒ 这里原样进来
    const p = mod.openGrantDialog({
      product: 'qoder', toolName: 'Edit', cwd: '/proj',
      suggestedDirs: ['/proj', '~/.ssh/id_rsa'], inferredDirs: ['~/.ssh/id_rsa.pub'],
    })
    const { groups, rows, btnOk } = dialogParts(doc)
    assert.deepEqual(rows.map((r) => r.dir.value), ['/proj', '~/.ssh/id_rsa', '~/.ssh/id_rsa.pub'])
    assert.deepEqual(rows.map((r) => r.chk.checked), [true, false, false],
      '非绝对路径不得默认勾选（服务端只认绝对路径 ⇒ 写了也会被丢 ⇒ 静默退化成工具名档）')
    const warns = byClass(groups[0], 'ad-grant-rowwarn')
    assert.equal(warns.length, 1, '非绝对路径那行下面必须有一条提示（不能只在 title 里）')
    assert.match(warns[0].textContent, /非绝对路径/)
    assert.match(warns[0].textContent, /服务端/)
    assert.match(warns[0].textContent, /不会写入规则/)
    assert.match(warns[0].textContent, /不展开/, '`~` 的降级原因要写清')
    assert.equal(byClass(groups[1], 'ad-grant-rowwarn').length, 1, '第二组的同类行同样要提示')
    btnOk.click()
    const d = await p
    assert.deepEqual(d, { paths: ['/proj'] }, '没勾选的非绝对路径一条都不许发出去')
  })

  it('M-B：cwd 缺失时相对路径降级为「原样 + 不勾选」，提示要说明是缺 cwd', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Bash', suggestedDirs: ['./x.txt', '/abs/ok'] })
    const { groups, rows } = dialogParts(doc)
    assert.deepEqual(rows.map((r) => r.chk.checked), [false, true], '缺 cwd 的相对路径不得默认勾选')
    const warn = byClass(groups[0], 'ad-grant-rowwarn')[0]
    assert.ok(warn, '缺 cwd 的降级行必须给提示')
    assert.match(warn.textContent, /没拿到工作区目录/)
    dialogParts(doc).btnCancel.click()
    await p
  })

  it('M-B：用户把该行改成绝对路径 ⇒ 提示自动收起（那一行才可勾选）', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Bash', suggestedDirs: ['./x.txt'] })
    const { groups, rows, btnOk } = dialogParts(doc)
    const warn = byClass(groups[0], 'ad-grant-rowwarn')[0]
    assert.ok(warn)
    rows[0].dir.value = '/proj/x.txt'
    rows[0].dir.fire('input')
    assert.equal(byClass(groups[0], 'ad-grant-rowwarn').length, 0,
      '改成绝对路径后提示必须收起（否则用户以为这条仍然不能写）')
    rows[0].chk.checked = true
    rows[0].chk.fire('change')
    btnOk.click()
    const d = await p
    assert.deepEqual(d, { paths: ['/proj/x.txt'] }, '用户手改成绝对路径后应能正常写入')
  })

  it('勾选一个推测项 ⇒ 它才作为 paths 元素发出；取消勾选立刻消失', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ product: 'qoder', toolName: 'Edit', suggestedDirs: SUG, inferredDirs: INF })
    const { groups, btnOk } = dialogParts(doc)
    const inf = rowsOfGroup(groups[1])
    inf[1].chk.checked = true
    inf[1].chk.fire('change')
    assert.match(dialogParts(doc).hint.textContent, /将记住 3 个目录/)
    assert.match(dialogParts(doc).hint.textContent, /另有 2 行未勾选/, '提示要说清未勾选的不进规则')
    btnOk.click()
    const d = await p
    assert.deepEqual(d.paths, [...SUG, INF[1]], '只有被勾的那一条推测目录发得出去')
    const p2 = mod.openGrantDialog({ product: 'qoder', toolName: 'Edit', suggestedDirs: SUG, inferredDirs: INF })
    const inf2 = rowsOfGroup(dialogParts(doc).groups[1])
    inf2[0].chk.checked = true
    inf2[0].chk.fire('change')
    inf2[0].chk.checked = false
    inf2[0].chk.fire('change')
    dialogParts(doc).btnOk.click()
    assert.deepEqual((await p2).paths, SUG, '勾上又取消 ⇒ 不得残留在提交结果里')
  })

  it('两组都清空 ⇒ 发出 paths: []（＝只要工具名档）', async () => {
    for (const how of ['uncheck', 'delete']) {
      const { mod, doc } = buildGrantModule()
      const p = mod.openGrantDialog({ product: 'qoder', toolName: 'Bash', suggestedDirs: SUG, inferredDirs: INF })
      const { rows, btnOk } = dialogParts(doc)
      if (how === 'uncheck') {
        for (const r of rows) { r.chk.checked = false; r.chk.fire('change') }
      } else {
        for (const r of [...rows].reverse()) r.del.click()
      }
      assert.match(dialogParts(doc).hint.textContent, /一条都没勾/)
      assert.match(dialogParts(doc).hint.className, /warn/)
      // 行数要在**关框前**读：btnOk.click() 之后遮罩已被 finish() 撤掉，
      // 此时再 dialogParts() 只会得到「遮罩应恰好 1 个，实际 0」的假失败。
      assert.equal(how === 'uncheck' ? rows.length : dialogParts(doc).rows.length, how === 'uncheck' ? 5 : 0)
      btnOk.click()
      const d = await p
      assert.deepEqual(d, { paths: [] }, `${how}：必须发空数组（契约里空数组＝只要工具名，不能省略该键）`)
    }
  })

  it('推测档里与实触达档重名的那条不重复出现（同一目录不能两处两个勾选状态）', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({
      product: 'qoder', toolName: 'Edit',
      suggestedDirs: ['/tmp/p7/alpha'], inferredDirs: ['/tmp/p7/alpha', '/etc'],
    })
    const { groups } = dialogParts(doc)
    assert.deepEqual(rowsOfGroup(groups[0]).map((r) => r.dir.value), ['/tmp/p7/alpha'])
    assert.deepEqual(rowsOfGroup(groups[1]).map((r) => r.dir.value), ['/etc'], '重复项只在第一组出现一次')
    dialogParts(doc).btnOk.click()
    assert.deepEqual((await p).paths, ['/tmp/p7/alpha'])
  })

  it('脏输入不炸：非数组、含空项、含数字都按可渲染的字符串目录处理', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({
      toolName: 'Edit', suggestedDirs: ['/ok', '', null, 42], inferredDirs: 'not-an-array',
    })
    const { groups } = dialogParts(doc)
    assert.deepEqual(rowsOfGroup(groups[0]).map((r) => r.dir.value), ['/ok'])
    assert.equal(rowsOfGroup(groups[1]).length, 0, '推测档给了非数组 ⇒ 该组只剩占位行（组仍然渲染，标注不变）')
    dialogParts(doc).btnOk.click()
    assert.deepEqual((await p).paths, ['/ok'])
  })

  it('两档都空时仍然渲染两组 + 可添加，不给出「没什么可记住」的死框', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Edit' })
    const { groups, add } = dialogParts(doc)
    assert.equal(groups.length, 2, '两档都空也要把来源标注摊开：用户看得见「这次没有推测目录」')
    assert.equal(byClass(groups[0], 'ad-grant-gempty').length, 1)
    assert.equal(byClass(groups[1], 'ad-grant-gempty').length, 1)
    add.click()
    const { rows, btnOk } = dialogParts(doc)
    assert.equal(rows.length, 1)
    rows[0].dir.value = '/tmp/typed'
    btnOk.click()
    assert.deepEqual((await p).paths, ['/tmp/typed'])
  })

  it('确认载荷只来自勾选行：源码里不得存在「整份预填直接发出」的旁路', () => {
    const at = src.indexOf('function openGrantDialog(opts) {')
    assert.ok(at > 0, 'openGrantDialog 定义丢失')
    const body = src.slice(at, src.indexOf('\n    // 返回一跳', at))
    assert.match(body, /finish\(\{ paths: collect\(\) \}\)/,
      '确认必须发 collect()（勾选行），不能发预填数组')
    assert.match(body, /const checkedRows = \(\) => rows\.filter\(\(r\) => r\.chk\.checked\);/,
      'collect 必须以勾选状态为准')
    assert.doesNotMatch(body, /finish\(\{ paths: suggested/, '不得把第一组预填原样发出（勾选才是语义）')
    assert.doesNotMatch(body, /finish\(\{ paths: [^\n]*concat/, '不得把推测档并进发出结果')
    assert.equal((src.match(/function openGrantDialog\(/g) || []).length, 1, '弹框实现出现第二份（必然漂移）')
  })
})

// ── 通道接线：两条「记住类」按钮都必须弹框在先、POST 在后 ──
function btnCancelAndResolve(_mod, p, doc) {
  dialogParts(doc).btnCancel.click()
  return p
}

describe('U2 宿主通道（蓝球）：grantViaDialog 行为——取消零 POST，确认才带 paths', () => {
  const code = grabExpr('const grantViaDialog = (scope) => async () => {', '\n          };')
  // 目录化用**真**的 dirsOfPaths（同一份源码编译出来的），桩只做"用户改了什么"这一件事
  const realDirsOfPaths = buildGrantModule().mod.dirsOfPaths

  /** 用注入依赖编译 grantViaDialog：openGrantDialog 用可控桩，apiPost 记录调用 */
  function build(env) {
    const posts = []
    const answers = []
    const removed = []
    const item = {
      callId: 'call-1', sessionId: 'sess-1', rootSessionId: 'root-1',
      toolName: 'bash', cwd: '/tmp/proj', paths: ['/tmp/proj/a.txt'],
      answer: async (a) => { answers.push(a) },
    }
    const fn = new Function('openGrantDialog', 'dirsOfPaths', 'escalation', 'apiPost', 'item', 'removeItem',
      'return (' + code + ')')
    const grantViaDialog = fn(
      env.openGrantDialog,
      realDirsOfPaths,
      env.escalation === true,
      (url, payload) => { posts.push({ url, payload }); return Promise.resolve({}) },
      item,
      () => { removed.push(1) },
    )
    return { posts, answers, removed, item, run: (scope) => grantViaDialog(scope)() }
  }

  it('取消弹框 ⇒ 不 POST、不放行、不移除条目（转红实验④的靶子）', async () => {
    const seen = {}
    const r = build({
      escalation: false,
      openGrantDialog: (o) => { seen.suggested = o.suggestedDirs; seen.inferred = o.inferredDirs; return Promise.resolve(null) },
    })
    assert.equal(await r.run('session'), 'cancelled', 'handler 要如实告诉按钮"这次没处理"')
    assert.deepEqual(r.posts, [], '取消后一条规则都不许写')
    assert.deepEqual(r.answers, [], '取消后连本次放行都不该发生')
    assert.deepEqual(r.removed, [])
    assert.deepEqual(seen.suggested, ['/tmp/proj'], '预填来自 item.paths 的词法目录化（文件取父目录）')
    assert.deepEqual(seen.inferred, [], '宿主条目没给 inferredPaths ⇒ 第二组为空，不猜')
  })

  it('U4 全链路：structuredPaths 默认发出、inferredPaths 未勾选一条都不进请求体', async () => {
    // 用**真**弹框（同一份源码编译）驱动真 grantViaDialog：断言的是"条目 → 请求体"
    // 这条完整链路，中间没有桩替用户做勾选决定。
    const { mod, doc } = buildGrantModule()
    const posts = []
    const answers = []
    const item = {
      callId: 'call-1', sessionId: 'sess-1', rootSessionId: 'root-1', toolName: 'Edit', cwd: '/tmp/p7',
      // 服务端把同一次 Edit 的两档路径分开给：被编辑文件 vs 正文里写的假路径
      paths: ['/tmp/p7/alpha/a.txt', '/etc/passwd', '/home/dev/.ssh/id_ed25519'],
      structuredPaths: ['/tmp/p7/alpha/a.txt'],
      inferredPaths: ['/etc/passwd', '/home/dev/.ssh/id_ed25519', '/tmp/p7/alpha/a.txt'],
      answer: async (a) => { answers.push(a) },
    }
    const handler = new Function('openGrantDialog', 'dirsOfPaths', 'escalation', 'apiPost', 'item', 'removeItem',
      'return (' + code + ')')(
      mod.openGrantDialog, realDirsOfPaths, false,
      (url, payload) => { posts.push({ url, payload }); return Promise.resolve({}) }, item, () => {},
    )
    const run = handler('session')()
    const { groups } = dialogParts(doc)
    assert.deepEqual(rowsOfGroup(groups[0]).map((r) => r.dir.value), ['/tmp/p7/alpha'],
      '第一组=结构化路径的目录')
    assert.deepEqual(rowsOfGroup(groups[1]).map((r) => r.dir.value), ['/etc/passwd', '/home/dev/.ssh'],
      '第二组=正文推测路径的目录化结果：无扩展名的可执行文件名当文件取其父目录；'
      + '与第一组重复的那条不得再出现一次')
    assert.deepEqual(rowsOfGroup(groups[1]).map((r) => r.chk.checked), [false, false], '第二组默认不勾选')
    dialogParts(doc).btnOk.click()
    await run
    assert.deepEqual(posts[0].payload.paths, ['/tmp/p7/alpha'], '未勾选的 /etc、/home/dev/.ssh 不得进请求体')
    assert.deepEqual(answers, ['allowed-once'])
  })

  it('U4 全链路：在弹框里勾上推测项，它才作为 paths 元素发出', async () => {
    const { mod, doc } = buildGrantModule()
    const posts = []
    const item = {
      callId: 'call-1', sessionId: 'sess-1', rootSessionId: 'root-1', toolName: 'Edit', cwd: '/tmp/p7',
      paths: ['/tmp/p7/alpha/a.txt', '/etc/passwd'],
      structuredPaths: ['/tmp/p7/alpha/a.txt'],
      inferredPaths: ['/etc/passwd'],      answer: async () => {},
    }
    const handler = new Function('openGrantDialog', 'dirsOfPaths', 'escalation', 'apiPost', 'item', 'removeItem',
      'return (' + code + ')')(
      mod.openGrantDialog, realDirsOfPaths, false,
      (url, payload) => { posts.push({ url, payload }); return Promise.resolve({}) }, item, () => {},
    )
    const run = handler('session')()
    const inf = rowsOfGroup(dialogParts(doc).groups[1])
    inf[0].chk.checked = true
    inf[0].chk.fire('change')
    dialogParts(doc).btnOk.click()
    await run
    assert.deepEqual(posts[0].payload.paths, ['/tmp/p7/alpha', '/etc/passwd'], '勾选后才发（顺序=第一组在前）')
  })

  it('确认（有目录）⇒ POST 带用户声明的 paths，会话档键用根会话', async () => {
    const r = build({ escalation: false, openGrantDialog: () => Promise.resolve({ paths: ['/tmp/proj'] }) })
    await r.run('session')
    assert.equal(r.posts.length, 1)
    assert.equal(r.posts[0].url, '/agent-api/host-approval-rule')
    assert.deepEqual(r.posts[0].payload, {
      scope: 'session', sessionId: 'root-1', callId: 'call-1', paths: ['/tmp/proj'], toolName: 'bash',
    })
    assert.deepEqual(r.answers, ['allowed-once'], '确认后才放行本次')
    assert.equal(r.removed.length, 1)
  })

  it('删空确认 ⇒ paths:[] 原样发出（契约：空数组＝只要工具名档）', async () => {
    const r = build({ escalation: false, openGrantDialog: () => Promise.resolve({ paths: [] }) })
    await r.run('session')
    assert.deepEqual(r.posts[0].payload.paths, [], '空数组必须照发，不许省略、不许回退成自动分析')
    assert.ok('paths' in r.posts[0].payload)
  })

  it('项目档 ⇒ scope=project + cwd，sessionId 用条目自身（与 1.12.5 载荷一致）', async () => {
    const r = build({ escalation: true, openGrantDialog: (o) => {
      assert.equal(o.escalation, true, '越权标志必须传进弹框，否则档位说明会说谎')
      return Promise.resolve({ paths: ['/tmp/proj'] })
    } })
    await r.run('project')
    assert.deepEqual(r.posts[0].payload, {
      scope: 'project', sessionId: 'sess-1', callId: 'call-1', paths: ['/tmp/proj'], cwd: '/tmp/proj',
    })
    assert.ok(!('toolName' in r.posts[0].payload), '项目档条目不含工具名（与落盘结构一致）')
  })

  it('POST 失败也照样放行本次并留 warn（沿用 1.12.5 兜底）', async () => {
    const warn = []
    const orig = console.warn
    console.warn = (...a) => warn.push(a.join(' '))
    // 让 apiPost 抛错：重建一个带 reject 的桩
    const answers = []
    const removed = []
    const handler = new Function('openGrantDialog', 'dirsOfPaths', 'escalation', 'apiPost', 'item', 'removeItem',
      'return (' + code + ')')(
      () => Promise.resolve({ paths: ['/x'] }), realDirsOfPaths, false,
      () => Promise.reject(new Error('400')),
      {
        callId: 'c', sessionId: 's', rootSessionId: 'r', toolName: 'bash', paths: [],
        answer: async (a) => { answers.push(a) },
      },
      () => { removed.push(1) },
    )
    await handler('session')()
    console.warn = orig
    assert.equal(warn.length, 1, '写规则失败要留痕')
    assert.match(warn[0], /写授权规则失败/)
    assert.deepEqual(answers, ['allowed-once'], '规则没写成本次仍放行（不阻塞用户）')
    assert.equal(removed.length, 1, '条目照常收起，与 1.12.5 一致')
  })
})

describe('U2 琥珀通道：sendDecision 按契约透传 paths（不传＝产品侧自动分析）', () => {
  const code = grabExpr('const sendDecision = (a, answer, label, paths) => {', '\n      };')

  function build() {
    const posts = []
    const decided = new Set()
    const twin = []
    const fn = new Function('apiPost', 'acpTwinMarkDecided', 'isDecided', 'decidedKey', 'decidedPermIds',
      'return (' + code + ')')
    const sendDecision = fn(
      (url, payload) => { posts.push({ url, payload }); return Promise.resolve({}) },
      (id) => twin.push(id),
      (row) => decided.has(`${row.childId}::${row.permId}`),
      (row) => `${row.childId}::${row.permId}`,
      decided,
    )
    return { posts, decided, twin, sendDecision }
  }

  it('给了 paths ⇒ 载荷带 paths；未给 ⇒ 载荷里根本没有该键（三态不塌）', async () => {
    const { posts, sendDecision } = build()
    const a1 = { childId: 'c1', permId: 'p1', _btn: null }
    sendDecision(a1, 'allow-session', '本会话总是允许该工具', ['/tmp/a'])
    await Promise.resolve()
    assert.deepEqual(posts[0].payload, { childId: 'c1', permId: 'p1', answer: 'allow-session', paths: ['/tmp/a'] })
    const a2 = { childId: 'c2', permId: 'p2', _btn: null }
    sendDecision(a2, 'allow-once', '允许一次')
    await Promise.resolve()
    assert.equal('paths' in posts[1].payload, false, '老调用不传 paths 时必须整个键缺席，产品侧才走自己的自动分析')
    const a3 = { childId: 'c3', permId: 'p3', _btn: null }
    sendDecision(a3, 'allow-always', '总是允许(项目)', [])
    await Promise.resolve()
    assert.deepEqual(posts[2].payload.paths, [], '空数组是"只要工具名"的显式声明，不能被当成没传')
  })

  it('琥珀「记住类」按钮先弹框后决策，取消什么都不发（源码接线）', () => {
    const from = src.indexOf('const mkBtn = (label, answer, cls, tip, grant) => {')
    assert.ok(from >= 0, '琥珀球 mkBtn 定义锚点丢失')
    const amberBtns = src.slice(from, src.indexOf('mkBtn("拒绝", "deny", "danger"'))
    assert.equal((amberBtns.match(/\{ projectTier: (?:false|true) \}/g) || []).length, 2,
      '只有两个「记住类」按钮挂 grant，允许一次/拒绝不弹框')
    assert.match(amberBtns, /openGrantDialog\(\{[\s\S]{0,400}\}\)\.then\(\(d\) => \{\s*if \(!d\) return;\s*sendDecision\(a, answer, label, d\.paths\);/,
      '确认后才 sendDecision，且带用户声明的 paths')
    assert.match(amberBtns, /Array\.isArray\(p\.suggestedDirs\) && p\.suggestedDirs\.length > 0[\s\S]{0,160}\? absolutizeDirs\(p\.suggestedDirs, amberCwd\)[\s\S]{0,80}: dirsOfPaths\(p\.paths, amberCwd\)/,
      'ACP 通道优先用产品侧 suggestedDirs（只补绝对化、不套文件形态），缺才退回本地词法目录化')
    assert.doesNotMatch(amberBtns, /sendDecision\(a, answer, label\);\s*\n\s*\}\);\s*\n\s*openGrantDialog/,
      '不得出现"先发决策再弹框"的接线')
  })

  it('面板不得把整条 paths 原文摊到不必要的地方（U1 最小化）', () => {
    const tipBody = src.slice(src.indexOf('function permGrantTip(p) {'), src.indexOf('let grantDialogOpen'))
    assert.doesNotMatch(tipBody, /return[^;]*p\.paths/, '提示文案里不许拼原始路径')
    assert.doesNotMatch(tipBody, /join\("\\n"\)/, '提示不是路径列表')
  })
})

describe('U3 弹框布局：滚动契约与不越视口（对齐 fab-panel-layout 口径）', () => {
  function cssRule(sel) {
    const m = src.match(new RegExp('\\.' + sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]*)\\}'))
    assert.ok(m, `CSS class .${sel} not found in client.js`)
    return m[1]
  }

  it('遮罩铺满视口且自身可滚（弹框比视口高时的第一道出口）', () => {
    const css = cssRule('ad-grant-mask')
    assert.match(css, /position:\s*fixed/)
    assert.match(css, /inset:\s*0/)
    assert.match(css, /overflow:\s*auto/)
    assert.match(css, /overscroll-behavior:\s*contain/)
  })

  it('面板硬限高 + overflow:hidden：任何视口都不越出', () => {
    const css = cssRule('ad-grant-pop')
    assert.match(css, /max-height:/)
    assert.match(css, /calc\(100vh\s*-\s*24px\)/, '必须有视口硬上限')
    assert.match(css, /overflow:\s*hidden/)
    assert.match(css, /flex-direction:\s*column/)
    assert.match(css, /max-width:\s*calc\(100vw\s*-\s*24px\)/, '窄屏不横向溢出')
  })

  it('内容区 flex:1 1 auto + min-height:0 + overflow-y:auto（由它承担滚动）', () => {
    const css = cssRule('ad-grant-body')
    assert.match(css, /flex:\s*1\s+1\s+auto/)
    assert.match(css, /min-height:\s*0/, '缺了它 flex 子项不会真的收缩，滚不动')
    assert.match(css, /overflow-y:\s*auto/)
    assert.match(css, /overscroll-behavior:\s*contain/)
  })

  it('路径输入区自身限高可滚（目录几十条时不撑爆面板）', () => {
    const css = cssRule('ad-grant-input')
    assert.match(css, /max-height:/)
    assert.match(css, /overflow-y:\s*auto/)
    assert.match(css, /box-sizing:\s*border-box/)
    assert.match(css, /width:\s*100%/)
  })

  it('按钮行 flex:0 0 auto + sticky bottom：内容再长也常驻可见', () => {
    const css = cssRule('ad-grant-actions')
    assert.match(css, /flex:\s*0\s+0\s+auto/)
    assert.match(css, /position:\s*sticky/)
    assert.match(css, /bottom:\s*0/)
  })

  it('标题/档位说明/只读工具行都 flex:0 0 auto 且不换行溢出', () => {
    for (const sel of ['ad-grant-head', 'ad-grant-note', 'ad-grant-tool']) {
      assert.match(cssRule(sel), /flex:\s*0\s+0\s+auto/, `.${sel} 不该被压缩`)
    }
    for (const sel of ['ad-grant-note', 'ad-grant-tool']) {
      assert.match(cssRule(sel), /overflow-wrap:\s*anywhere|word-break:\s*break-word/, `.${sel} 必须能折长路径`)
    }
  })

  it('DOM 结构：遮罩→面板→(标题,说明,内容区,操作行)，操作行是面板直接子节点', async () => {
    const { mod, doc } = buildGrantModule()
    const p = mod.openGrantDialog({ toolName: 'Edit', dirs: ['/tmp/a'] })
    const { mask, pop, actions } = dialogParts(doc)
    assert.equal(mask.childNodes[0], pop)
    assert.ok(actions.parentNode === pop, 'sticky 只有作为滚动上下文（面板）的直接子节点才成立')
    assert.deepEqual(
      pop.childNodes.map((n) => n.className.split(/\s+/)[0]),
      ['ad-grant-head', 'ad-grant-note', 'ad-grant-body', 'ad-grant-actions'],
    )
    assert.equal(pop.getAttribute('role'), 'dialog')
    assert.equal(pop.getAttribute('aria-modal'), 'true')
    btnCancelAndResolve(mod, p, doc)
  })

  it('面板自身滚轮不应链到页面：滚动只发生在内容区/输入区', () => {
    assert.match(cssRule('ad-grant-pop'), /overflow:\s*hidden/, '面板本体不滚，滚的必须是内容区')
  })
})

// ── U5：确认按钮配色守卫（v1.12.6 UI 修复）──
//
// 现场缺陷：`.ad-btn.primary{background:var(--ad-accent)}` 里的 `--ad-accent` 只在
// `.ad-panel{…}` 里定义，而这个弹框是挂在 document.body 上的 —— 拿不到那层作用域 ⇒
// `background` 进入「计算值阶段无效」(IACVT)：背景回退 transparent、border-color 回退
// currentColor（＝该按钮的文字色 label-primary-inverted＝白）⇒ **白底白字**，真实 Chrome
// 实测对比度 1.00:1（用户反馈「灰色的，看不清」）。
//
// 修法：确认按钮额外挂 `.ad-grant-ok`，由该类的规则给出**可取到**的主色。本套用例只钉
// 三件会被改回去的事，不管样式怎么重排：
//   ⓐ className 必须含 ad-grant-ok；
//   ⓑ 该规则的背景/描边不得是裸 `var(--ad-accent)`（必须带逗号回退，或直接引宿主 --dsw-* token）；
//   ⓒ 该规则的选择器 specificity 不得低于 `.ad-btn.primary`（只有 1 个类会被它反压回白底白字）。
describe('U5 确认按钮配色：不得只依赖裸 var(--ad-accent)', () => {
  // 只认字符串常量里的 CSS 规则（`".selector{…}"`），避免命中注释里提到的同名类
  function okRule() {
    const m = src.match(/"([^"{}]*\.ad-grant-ok)\{([^}]*)\}"/)
    assert.ok(m, 'lib/client.js 的 CSS 里找不到 `.ad-grant-ok{…}` 规则（弹框确认按钮的主色规则丢了）')
    return { sel: m[1], body: m[2] }
  }
  function decl(body, prop) {
    const m = body.match(new RegExp('(?:^|;)\\s*' + prop.replace(/-/g, '\\-') + '\\s*:([^;]+)'))
    return m ? m[1].trim() : ''
  }
  // 「可取到」＝带逗号回退的 var(--ad-accent, …) 或直接引用宿主主题 token（--dsw-*）。
  // 裸 var(--ad-accent) 不算：那正是这个缺陷本身。
  const recoverable = (v) => /var\(\s*--ad-accent\s*,/.test(v) || /var\(\s*--dsw-/.test(v)

  it('① 确认按钮必须挂 .ad-grant-ok（否则落回裸 var(--ad-accent) 的透明底 + 白字）', () => {
    const m = src.match(/btnOk\.className = "([^"]+)"/)
    assert.ok(m, 'lib/client.js 里找不到 btnOk.className 赋值（确认按钮被改名或重写？）')
    assert.match(m[1], /(^|\s)ad-grant-ok(\s|$)/,
      `确认按钮的 class 必须含 ad-grant-ok，实际："${m[1]}"`)
  })

  it('② .ad-grant-ok 的背景与描边必须是可取到的色（裸 var(--ad-accent) 不算）', () => {
    const { body } = okRule()
    for (const prop of ['background', 'border-color']) {
      const v = decl(body, prop)
      assert.ok(v, `.ad-grant-ok 缺 ${prop} 声明——缺了就会回落到 .ad-btn.primary 的裸 var(--ad-accent)`)
      assert.ok(recoverable(v),
        `.ad-grant-ok 的 ${prop} 必须是 var(--ad-accent, …) 带回退或直接引宿主 --dsw-* token，实际：${v}`)
    }
  })

  it('③ 规则 specificity 不得低于 .ad-btn.primary（更弱就会被反压回透明底 + 白字）', () => {
    const { sel } = okRule()
    const classes = (sel.match(/\./g) || []).length
    assert.ok(classes >= 2,
      `.ad-grant-ok 的选择器只带 ${classes} 个类（"${sel.trim()}"）——压不过 .ad-btn.primary（2 个类）就会退回白底白字`)
  })
})
