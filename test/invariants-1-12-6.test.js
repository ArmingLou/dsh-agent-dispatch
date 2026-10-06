// test/invariants-1-12-6.test.js — v1.12.6 交付要求 Part 3：七条「不得回归」不变量，逐条命名自测。
//
// 本文件是**汇总守卫**，不是重复劳动：每条都只补该不变量在仓库里最薄弱的那一环，
// 其余覆盖面在注释里点名到既有用例（改坏了该红的那条必须存在且被命名）。
//
//   ① 沙箱越权读取侧：**吃**工具名档与落盘会话路径档、**不吃**落盘项目档
//      （v1.12.7 用户第三次裁定收窄：越权不再被排除出工具名档；唯一保留的约束是
//        sessionOnly——不写跨会话落盘白名单。危险命令门/超长门/执行类无正文门
//        排在最前，与档位无关，永远走交互；见 test/invariants-1-12-7.test.js）
//      （既有覆盖：tool-grant-session.test.js「decide disallowToolGrant」5 例、
//        host-approval-endpoint.test.js:568/595/784/795；本文件补 decide 三档开关的
//        **组合真值表**——单开关各自生效、双开关互不牵连）
//   ② ACP 孪生：读取侧仍完全绕过（早退门排在所有档位**之前**）；写入侧恢复 1.12.4 落盘
//      （既有覆盖：host-approval-endpoint.test.js「B1」describe 第 1 条；
//        tool-grant-session.test.js:796「③ 已授权 product_submit + [ACP …] → next()」；
//        本文件补「即使会话路径规则覆盖得到也不放行」的端点级早退门守卫——
//        挪门到路径档之后必须转红）
//   ③ auto-review / hook「ask」**有意不排除**（用户裁定，不许顺手收紧）
//      （既有覆盖：无——1.12.5 之前这类请求从未被单独钉过；本文件为唯一守卫）
//   ④ fork 判据：只有 origin==='subagent' 或 delegationDepth>0 才沿 parentSession 上溯
//      （既有覆盖：tool-grant-session.test.js「fork 会话不得上溯到源会话」；
//        本文件补**端点侧**的根 id 断言——上溯判据一改，POST 回来的 rootSessionId 就变）
//   ⑤ 工具名档跨产品隔离（真实记忆键 = product:tool）
//      → 守卫在 test/grant-dialog.test.js「不变量⑤」（共用件从 lib/client.js 抽取编译）
//   ⑥ decide / appendProjectRule 各只有一个调用点
//      （既有覆盖：无；本文件为唯一守卫）
//   ⑦ 非越权落盘与命中行为逐字不变
//      （既有覆盖：host-approval-endpoint.test.js「B1」第 2 条 sha256 比对；
//        本文件补落盘**字节形态**：信封版本、键顺序、幂等合并）
//
// 运行：node --test test/invariants-1-12-6.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, mkSession } from './agent-api-harness.js'
import {
  HostApprovalRules,
  isSandboxEscalation,
  isAcpTwinApproval,
  isDisallowedAutoGrant,
  isDelegatedSession,
} from '../lib/host-approval.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const ESC = 'escalate sandbox to read-write: need to write outside the sandbox'

const approve = async (b, session, { callId = null, toolName = null, reason = 'tool requires approval' } = {}) => {
  let nextCalled = false
  const outs = b.fireEvent(
    'approval/request',
    { agent: { session }, callId, toolName, reason },
    () => { nextCalled = true; return 'NEXT' },
  )
  return { res: await outs[0], nextCalled }
}
const postRule = (b, body) => b.req('POST', '/agent-api/host-approval-rule', body)
const logRows = (home) => {
  const f = path.join(home, 'data', 'dsh-agent-dispatch', 'dispatches.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
const writeCall = (callId, file, name = 'write') => [{ callId, name, arguments: { file_path: file } }]

/**
 * 去掉 `//` 行注释与 `/* … *\/` 块注释（v1.12.6 第六轮 · 终审 Minor 1 的守卫用）。
 * **不跟踪字符串字面量**：本守卫只问「这个**标识符**有没有出现在写侧**可执行代码**里」，
 * 注释里提到名字（index.js 里 B1 的说明确实提到了 `isDisallowedAutoGrant`）不算复发。
 * `(^|[^:])//` 那个 `[^:]` 是刻意留给 `https://` 这类 URL 的（避免把字符串切坏）。
 */
const stripComments = (src) => String(src)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')

/**
 * 执行类调用记录：**name 与 arguments 必须自洽**。
 * v1.12.6 危险命令门要求「执行类调用解析不出命令文本 ⇒ 不自动放行」，所以
 * 「声明 bash、却只给 write 的参数体」这种拼接夹具会先被那道门拦下，断言就在错误的
 * 层上转红（测的不再是项目档）。这里给 bash 一条真实命令文本（命令里带同一个路径，
 * 路径口径与 writeCall 一致）。
 */
const bashCall = (callId, file) => [{ callId, name: 'bash', arguments: { command: `cat ${file}` } }]

/** 隔离的临时 DSH_HOME：本文件的落盘断言一律不许碰 ~/.dsh */
function tempRules() {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dad-inv-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return {
    home,
    rules: new HostApprovalRules(),
    restore() {
      process.env.DSH_HOME = prev
      rmSync(home, { recursive: true, force: true })
    },
  }
}

// ─────────────────────────────────────────────────────────────────
describe('不变量①：v1.12.14 起本插件不再做「档位级排除」（用户裁定：显式点项目档不降级 ⇒ 写侧照落盘、读侧照消费）', () => {
  it('decide 真值表：只剩 disallowToolGrant 一个开关（关工具两档），项目档照常参与', () => {
    const t = tempRules()
    try {
      const r = t.rules
      r.addToolGrant('root-1', 'bash')
      r.addSessionRule('root-1', ['/tmp/inv1/alpha/a.txt'])
      r.appendProjectRule({ cwd: '/proj', paths: ['/tmp/inv1/gamma'], note: '项目档' })

      const base = { sessionId: 'root-1', rootSessionId: 'root-1', cwd: '/proj', paths: ['/tmp/inv1/gamma/x.txt'], toolName: 'bash' }
      // A 全开：内存工具档先短路
      assert.equal(r.decide({ ...base, disallowToolGrant: false }).scope, 'session-tool')
      // B 只关工具档：落到落盘项目档
      const b1 = r.decide({ ...base, disallowToolGrant: true })
      assert.equal(b1.allowed, true)
      assert.equal(b1.scope, 'project', 'disallowToolGrant 把项目档也一起关了（两档开关串味）')
      // C 项目档覆盖、会话路径不覆盖 ⇒ **放行**（v1.12.14 读侧对称放开的靶子）
      const d = r.decide({ ...base, disallowToolGrant: true })
      assert.equal(d.allowed, true, '落盘项目档没被消费（读侧 sessionOnly 若被加回来，这里转红）')
      assert.equal(d.scope, 'project')
      // E 会话路径档覆盖得到 ⇒ 只剩这一档命中
      const e = r.decide({ ...base, paths: ['/tmp/inv1/alpha/c.txt'], disallowToolGrant: true })
      assert.equal(e.allowed, true, '会话路径记忆被废了（1.12.x 一刀切回归）')
      assert.equal(e.scope, 'session', '命中不该来自别的档位')
      // F 无任何覆盖 ⇒ 不放行
      const f = r.decide({ ...base, paths: ['/tmp/other/q.txt'], disallowToolGrant: true })
      assert.equal(f.allowed, false, '请求被通配规则白嫖了')
      // G 落盘工具档（v1.12.14 新档）：disallowToolGrant 必须关得住它
      r.appendProjectToolRule({ cwd: '/proj', toolName: 'write' })
      const gBase = { sessionId: 'root-1', rootSessionId: 'root-1', cwd: '/proj', paths: ['/tmp/other/q.txt'], toolName: 'write' }
      const g1 = r.decide({ ...gBase, disallowToolGrant: false })
      assert.equal(g1.allowed, true, '落盘工具档没被消费（二级选择②的靶子）')
      assert.equal(g1.scope, 'project-tool')
      assert.equal(r.decide({ ...gBase, disallowToolGrant: true }).allowed, false,
        'disallowToolGrant 没关掉落盘工具档（工具两档必须同门）')
    } finally { t.restore() }
  })

  it('判据侧（v1.12.7 拆开）：越权**不再**关工具名档，只剩 ACP 孪生一种来源', () => {
    assert.equal(isSandboxEscalation(ESC), true)
    // 反转点：v1.12.5/1.12.6 这里期望 true。用户裁定「工具档不受越权限制」后
    // isDisallowedAutoGrant 拆开 ⇒ 越权为 false，改回 true 即「越权又被排除出工具档」
    // （1.12.x 的实战失效原样复发）。
    assert.equal(isDisallowedAutoGrant('bash', ESC), false,
      'v1.12.7：越权不得再被算进「不得用工具名档」——工具档是它唯一能记住的档')
    assert.equal(isAcpTwinApproval('bash', ESC), false)
    // 孪生仍必须被排（且它在 index.js 有更早的 return next() 早退门，见不变量②）
    assert.equal(isDisallowedAutoGrant('product_submit', '[ACP qoder] x'), true)
  })
})

// ─────────────────────────────────────────────────────────────────
describe('不变量②：ACP 孪生——读取侧早退门排在所有档位之前，写入侧不落盘抑制与它无关', () => {
  it('即使会话路径规则**覆盖得到**，孪生仍交回宿主与琥珀球（挪门即红）', async () => {
    const b = await boot()
    try {
      // 先在**非孪生**请求上把路径规则 + 工具名档写到根键
      const plain = mkSession({ id: 'R', toolCalls: writeCall('p1', '/tmp/inv2/alpha/a.txt', 'read') })
      await approve(b, plain, { callId: 'p1', toolName: 'read' })
      const w = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'p1', toolName: 'read' })
      assert.equal(w.status, 200)

      // 孪生：同一路径、同一根会话，product_submit + [ACP 开头 reason
      const twin = mkSession({ id: 'R', toolCalls: [{ callId: 't1', name: 'product_submit', arguments: { file_path: '/tmp/inv2/alpha/a.txt' } }] })
      const hit = await approve(b, twin, { callId: 't1', toolName: 'product_submit', reason: '[ACP qoder] 请求权限：submit' })
      assert.equal(hit.nextCalled, true, '早退门被挪到了档位之后——孪生被本插件判掉了（不变量②）')
      assert.notEqual(hit.res, 'allowed-once')

      // 对照组：同样的路径与档位，非孪生请求必须命中（证明上一条不是「根本没写进规则」）
      const ctrl = mkSession({ id: 'R', toolCalls: writeCall('p2', '/tmp/inv2/alpha/b.txt', 'read') })
      const c = await approve(b, ctrl, { callId: 'p2', toolName: 'read' })
      assert.equal(c.res, 'allowed-once', '对照组没命中 ⇒ 上一条的断言强度不足')

      // 早退门的位置（源码级）：isAcpTwinApproval 必须排在 disallowToolGrant 计算之前
      const idx = readFileSync(path.join(root, 'index.js'), 'utf8')
      const twinAt = idx.indexOf('if (isAcpTwinApproval(ctxInfo.toolName, ctxInfo.reason)) return next()')
      const disAt = idx.indexOf('const disallowToolGrant = isDisallowedAutoGrant')
      assert.ok(twinAt > 0 && disAt > twinAt, 'ACP 孪生早退门不再排在档位判据之前')
    } finally { await b.close() }
  })

  it('写入侧：落盘抑制的判据是 isSandboxEscalation 单独一条（不含孪生）', () => {
    const idx = readFileSync(path.join(root, 'index.js'), 'utf8')
    assert.match(
      idx,
      /const sandboxEscalated = !!approvalCtx && isSandboxEscalation\(approvalCtx\.reason\)/,
      '写侧判据不再是 isSandboxEscalation 单独一条（B1 回归）',
    )
    // v1.12.6 第六轮（终审 Minor 1，独立证实）：下面这条反向断言改前是**空转**的 ——
    // 旧写法 `/scope === 'project'[\s\S]{0,1200}isDisallowedAutoGrant/` 的窗口从
    // `case '/agent-api/host-approval-rule'` 起算只有 1200 字符，而 `scope === 'project'`
    // 的三个出现点在 +9413 / +9679 / +9766（`isDisallowedAutoGrant` 只在 +426 / +4860，
    // 都在窗口之前）⇒ 正则**永不匹配** ⇒ `=== false` 恒真，守卫名不副实。
    // 改法（二选一里选「锚定到项目档分支整体」）：把**整个端点体**（= 写侧）切出来、
    // **去掉注释**后查这个标识符；再补两条**正向锚**证明窗口真的是写侧 ——
    // 否则窗口一旦跑空（锚点改名/移位），这条又会退化成空转断言。
    const start = idx.indexOf("case '/agent-api/host-approval-rule'")
    const end = idx.indexOf("'/agent-api/active'")
    assert.ok(start > 0 && end > start, '找不到写侧端点体的起止锚点（改端点后请同步本守卫）')
    const writePath = stripComments(idx.slice(start, end))
    assert.match(
      writePath,
      /const sandboxEscalated = !!approvalCtx && isSandboxEscalation\(approvalCtx\.reason\)/,
      '正向锚：切出来的窗口里必须有写侧判据那一行（否则窗口跑空 = 空转断言）',
    )
    assert.match(writePath, /appendProjectRule\(/, '正向锚：窗口里必须有项目档落盘点')
    assert.equal(
      /isDisallowedAutoGrant/.test(writePath),
      false,
      '写侧（端点）又出现含 ACP 孪生的 isDisallowedAutoGrant（B1 的原样复发）',
    )
  })
})

// ─────────────────────────────────────────────────────────────────
describe('不变量③：auto-review / hook「ask」有意**不**排除（用户裁定，不许顺手收紧）', () => {
  const HOOK = 'hook "PreToolUse: Bash" asked for confirmation'
  const REVIEW = 'auto-review flagged this command as risky'

  it('这类 reason 既不判越权、也不判孪生 ⇒ 判据为 false', () => {
    for (const reason of [HOOK, REVIEW]) {
      assert.equal(isSandboxEscalation(reason), false, `${reason} 被判成了沙箱越权`)
      assert.equal(isDisallowedAutoGrant('bash', reason), false, `${reason} 被排除了工具名档`)
      assert.equal(isAcpTwinApproval('bash', reason), false)
    }
  })

  it('端点级：hook ask 请求照常吃工具名档（换个路径也不弹）', async () => {
    const b = await boot()
    try {
      const s1 = mkSession({ id: 'R', toolCalls: writeCall('h1', '/tmp/inv3/alpha/a.txt') })
      assert.equal((await approve(b, s1, { callId: 'h1', toolName: 'write', reason: HOOK })).nextCalled, true)
      assert.equal((await postRule(b, { scope: 'session', sessionId: 'R', callId: 'h1', toolName: 'write' })).status, 200)

      // 工具名档的证据：路径落在授权目录**之外**，allowed-once 只能来自工具名档
      const s2 = mkSession({ id: 'R', toolCalls: writeCall('h2', '/tmp/inv3-unrelated/b.txt') })
      const hit = await approve(b, s2, { callId: 'h2', toolName: 'write', reason: HOOK })
      assert.equal(hit.res, 'allowed-once', 'auto-review / hook ask 被排除门吞掉了工具名档（不变量③）')
      const row = logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'auto-grant').at(-1)
      assert.equal(row.scope, 'session-tool')
    } finally { await b.close() }
  })

  it('端点级：auto-review 请求照样能落盘（scope=project 不被抑制）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: writeCall('r1', '/tmp/inv3/gamma/c.txt') })
      await approve(b, s, { callId: 'r1', toolName: 'write', reason: REVIEW })
      const { status, json } = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'r1' })
      assert.equal(status, 200)
      assert.equal(json.scope, 'project', 'auto-review 的项目档被降级成了会话档')
      assert.equal(json.projectSuppressed, undefined)
      const file = path.join(b.home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')
      assert.equal(existsSync(file), true, 'auto-review 点「总是允许(项目)」没落盘')
      assert.equal(logRows(b.home).filter((r) => r.action === 'rule-downgraded').length, 0)
    } finally { await b.close() }
  })

  it('门的数量：读取侧只有「无 session id / ACP 孪生 / 无路径」三道 return next() 早退', () => {
    const idx = readFileSync(path.join(root, 'index.js'), 'utf8')
    const start = idx.indexOf("ctx.on('approval/request'")
    const end = idx.indexOf('}, { prepend: true })', start)
    assert.ok(start > 0 && end > start, 'approval/request 监听器边界定位失败')
    const body = idx.slice(start, end)
    const gates = [...body.matchAll(/^\s*if \((.{0,120}?)\) return next\(\)$/gm)].map((m) => m[1])
    assert.deepEqual(
      gates,
      ['!sessionId', 'isAcpTwinApproval(ctxInfo.toolName, ctxInfo.reason)', 'ctxInfo.paths.length === 0'],
      `排除门数量/内容变了（现值 ${JSON.stringify(gates)}）：新增「auto-review/hook ask」类排除门属用户明令禁止的自行收紧`,
    )
  })
})

// ─────────────────────────────────────────────────────────────────
describe('不变量④：fork 判据——只有委派子会话才上溯 parentSession', () => {
  it('真值表：origin 主判据 + delegationDepth 兜底，fork 两者皆无 ⇒ 自身即根', () => {
    assert.equal(isDelegatedSession({ header: { parentSession: 'R' } }), false, 'fork 被判成委派子会话')
    assert.equal(isDelegatedSession({ header: { parentSession: 'R', origin: 'subagent', delegationDepth: 1 } }), true)
    assert.equal(isDelegatedSession({ header: { parentSession: 'R', origin: 'subagent' } }), true)
    assert.equal(isDelegatedSession({ header: { parentSession: 'R', delegationDepth: 2 } }), true, 'delegationDepth 兜底被删')
    assert.equal(isDelegatedSession({ header: { parentSession: 'R', delegationDepth: 0 } }), false)
    assert.equal(isDelegatedSession({ header: { origin: 'user' } }), false)
    assert.equal(isDelegatedSession({}), false, '无 header 时抛错/误判')
  })

  it('端点级：POST 回来的 rootSessionId——fork 是自身、委派子会话是源会话', async () => {
    const b = await boot()
    try {
      const fork = mkSession({ id: 'F', fork: true, toolCalls: writeCall('f1', '/tmp/inv4/a.txt') })
      await approve(b, fork, { callId: 'f1', toolName: 'write' })
      const fp = await postRule(b, { scope: 'session', sessionId: 'F', callId: 'f1', toolName: 'write' })
      assert.equal(fp.json.rootSessionId, 'F', 'fork 的授权写到了源会话键上（跨会话静默放行）')

      const child = mkSession({ id: 'C', parentSession: 'R', toolCalls: writeCall('c1', '/tmp/inv4/b.txt') })
      await approve(b, child, { callId: 'c1', toolName: 'write' })
      const cp = await postRule(b, { scope: 'session', sessionId: 'C', callId: 'c1', toolName: 'write' })
      assert.equal(cp.json.rootSessionId, 'R', '委派子会话没上溯到根')
    } finally { await b.close() }
  })
})

// ─────────────────────────────────────────────────────────────────
describe('不变量⑥：decide / appendProjectRule 各只有一个调用点（单一写者）', () => {
  const countIn = (rel, re) => (readFileSync(path.join(root, rel), 'utf8').match(re) || []).length

  it('宿主半（index.js）：判定一处、落盘一处、工具名档两处且同分支', () => {
    assert.equal(countIn('index.js', /\.decide\(/g), 1, 'index.js 里 decide 出现了多处调用点')
    assert.equal(countIn('index.js', /\.appendProjectRule\(/g), 1, 'index.js 里 appendProjectRule 出现了多处调用点')
    // addToolGrant 的两处是「删空 ⇒ 只写工具名」与「老载荷 ⇒ 工具名 + 路径」，同属一个端点分支
    assert.equal(countIn('index.js', /\.addToolGrant\(/g), 2, 'index.js 里 addToolGrant 调用点数量变了')
  })

  it('浏览器半（lib/client.js）不得自带判定/落盘逻辑', () => {
    assert.equal(countIn('lib/client.js', /\.decide\(|\.appendProjectRule\(/g), 0, '客户端自己判档或落盘了')
  })

  it('其余模块不得绕过 index.js 直接写共用白名单', () => {
    const files = ['lib/dispatch.js', 'lib/registry.js', 'lib/fab-config.js', 'lib/acp.js']
    for (const f of files) {
      const p = path.join(root, f)
      if (!existsSync(p)) continue
      assert.equal(countIn(f, /appendProjectRule|allowlist\.json/g), 0, `${f} 里出现了第二个落盘写者`)
    }
    // 唯一的落盘实现留在 lib/host-approval.js（定义 + 无调用）
    assert.equal(countIn('lib/host-approval.js', /\.appendProjectRule\(/g), 0, 'lib/host-approval.js 内部自调了 appendProjectRule')
  })
})

// ─────────────────────────────────────────────────────────────────
describe('不变量⑦：非越权的落盘与命中行为逐字不变', () => {
  it('落盘字节形态：信封 {version:1, rules}、两空格缩进、键序 cwd→paths→grantedAt→note、主代理条目不带 product', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: writeCall('k1', '/tmp/inv7/alpha/a.txt') })
      await approve(b, s, { callId: 'k1', toolName: 'write' })
      const { status, json } = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'k1' })
      assert.equal(status, 200)
      assert.equal(json.scope, 'project')

      const file = path.join(b.home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')
      const raw = readFileSync(file, 'utf8')
      const env = JSON.parse(raw)
      assert.deepEqual(Object.keys(env), ['version', 'rules'], '落盘信封变了')
      assert.equal(env.version, 1)
      assert.equal(raw, JSON.stringify(env, null, 2), '落盘缩进/格式变了（product-subagents 直接读同一文件）')
      assert.deepEqual(Object.keys(env.rules[0]), ['cwd', 'paths', 'grantedAt', 'note'], '条目键序/键集变了')
      assert.equal('product' in env.rules[0], false, '主代理条目带上了 product 字段')
      assert.equal(env.rules[0].note, '用户在授权球点击总是允许(项目)')
      // 自动分析（未声明 paths）⇒ 文件连带直接父目录（M1 目录级语义）
      assert.deepEqual([...env.rules[0].paths].sort(), ['/tmp/inv7/alpha', '/tmp/inv7/alpha/a.txt'])
      assert.match(env.rules[0].grantedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'grantedAt 不是 ISO 串')
    } finally { await b.close() }
  })

  it('同 (cwd, paths) 重复点项目档 ⇒ 幂等合并（只刷时间与 note，不增条目）', async () => {
    const b = await boot()
    try {
      const file = path.join(b.home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')
      for (let i = 1; i <= 2; i++) {
        const s = mkSession({ id: 'R', toolCalls: writeCall(`k${i}`, '/tmp/inv7/beta/b.txt') })
        await approve(b, s, { callId: `k${i}`, toolName: 'write' })
        const r = await postRule(b, { scope: 'project', sessionId: 'R', callId: `k${i}` })
        assert.equal(r.status, 200)
        assert.equal(r.json.count, 1, `第 ${i} 次项目档写入多出一条规则（幂等合并失效）`)
      }
      const env = JSON.parse(readFileSync(file, 'utf8'))
      assert.equal(env.rules.length, 1)
    } finally { await b.close() }
  })

  it('命中行为：非越权授权过项目档后，**新会话**同路径仍放行且留痕 scope=project', async () => {
    const b = await boot()
    try {
      const s1 = mkSession({ id: 'R', toolCalls: writeCall('m1', '/tmp/inv7/gamma/c.txt') })
      await approve(b, s1, { callId: 'm1', toolName: 'edit' })
      assert.equal((await postRule(b, { scope: 'project', sessionId: 'R', callId: 'm1' })).status, 200)

      // 换个工具名（bash 从未授权过）+ 另一个根会话 ⇒ 只可能命中落盘项目档
      // cwd 必须与授权时一致：项目档按 (cwd, paths) 双条件匹配
      const s2 = mkSession({ id: 'R2', toolCalls: bashCall('m2', '/tmp/inv7/gamma/d.txt') })
      const hit = await approve(b, s2, { callId: 'm2', toolName: 'bash' })
      assert.equal(hit.res, 'allowed-once', '落盘项目档不再被新会话命中（⑦ 的读侧腿）')
      const row = logRows(b.home).filter((r) => r.action === 'auto-grant').at(-1)
      assert.equal(row.scope, 'project')
    } finally { await b.close() }
  })
})

// ── v1.12.6（终审 Major 1）：CI 用例守卫必须对 .skip / cancelled / todo 免疫 ──
// 终审实测：`it.skip(...)` 之后 `# tests 497 / # skipped 1`，只比 `# tests` 的守卫照样绿
// ——pass 悄悄少一条，没人知道。守卫改成比 `# pass` 下限（= MIN_TESTS - 已登记准跳数 K），
// 并同时钉住 cancelled == 0 / todo == 0。这里把 ci.yml 里那几行钉住：
// 有人把守卫改回「只比 # tests」时，本用例先红。
describe('CI 用例守卫：对 .skip / cancelled / todo 免疫（终审 Major 1）', () => {
  const ci = readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')

  it('断言 # pass 下限（而不是只比 # tests），并同时断言 cancelled / todo == 0', () => {
    assert.match(ci, /p=\$\(num pass\)/, '守卫必须取 # pass 计数')
    assert.match(ci, /floor=\$\(\(MIN_TESTS - SKIPPED_ALLOWED\)\)/, '下限 = MIN_TESTS - 已登记准跳数')
    assert.match(ci, /if \[ "\$p" -lt "\$floor" \]/, '必须按 # pass 与下限比较（只比 # tests 就拦不住 .skip）')
    assert.match(ci, /if \[ "\$c" != "0" \]/, '必须断言 cancelled == 0（取消不是通过）')
    assert.match(ci, /if \[ "\$td" != "0" \]/, '必须断言 todo == 0（todo 不是通过）')
  })

  it('准跳数 K 的来源被登记在注释里：只有 host-0.2-compat 那条按环境跳过', () => {
    assert.match(ci, /SKIPPED_ALLOWED: 1/, 'K 的当前值必须是 1（只登记了一条准跳）')
    assert.match(ci, /host-0\.2-compat\.test\.js:334-340/, 'K 的来源（文件:行号）必须写在 ci.yml 注释里')
    assert.match(ci, /\/Users\/arming\/\.nvm/, '要写清它为什么按环境跳过（硬编码的宿主包路径）')
    // MIN_TESTS 必须与仓内实际用例数同步到一个「够挡住删一条」的值
    const declared = Number((ci.match(/MIN_TESTS: (\d+)/) || [])[1])
    assert.ok(declared >= 507, `MIN_TESTS 被下调到 ${declared}：新增用例后必须一起抬上去`)
  })
})
