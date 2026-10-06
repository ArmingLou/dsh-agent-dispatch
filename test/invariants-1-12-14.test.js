// test/invariants-1-12-14.test.js — v1.12.14：用户裁定「显式点项目档不降级 ⇒ 照落盘、读侧照消费」。
//
// 两份裁定（父子代理转述的用户口径，不得自行更改）：
//   ①「空路径集 + 二级选择『落盘工具放行任意路径』」⇒ **必须落盘一条工具档**
//      （`{cwd, product:'main', paths:[], tools:['main:<工具>'], grantedAt, note}`，
//       原子写共用 allowlist.json、只追加不覆盖），重载宿主后同工具仍免弹；
//       「仅本次放行」才是不落盘的一次性放行。
//   ②「勾了 ≥1 个绝对目录 + 点项目档」⇒ 照旧落盘路径档，且**不再因沙箱越权而降级**
//      （有意放开 v1.12.5/1.12.7 的那条守卫；放开条件仅此一条——用户显式点项目档）。
//
// 保留不变的守卫：全非法声明 400 且什么都不写；「仅本次」不落盘；cwd 缺失不落；
// 落盘失败 400/回退会话档且如实上报；危险命令门排在所有档位之前（命中的请求不写任何档）。
//
// 运行：node --test test/invariants-1-12-14.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, mkSession } from './agent-api-harness.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel) => readFileSync(path.join(root, rel), 'utf8')
const allowlistFile = (home) => path.join(home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')
const allowlistBytes = (home) => (existsSync(allowlistFile(home)) ? readFileSync(allowlistFile(home)) : null)
const allowlistRules = (home) => {
  const b = allowlistBytes(home)
  return b ? JSON.parse(b.toString('utf8')).rules : null
}
const logRows = (home) => {
  const f = path.join(home, 'data', 'dsh-agent-dispatch', 'dispatches.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
const grantRows = (home, action) =>
  logRows(home).filter((r) => r.kind === 'host-approval' && (!action || r.action === action))

const postRule = (b, body) => b.req('POST', '/agent-api/host-approval-rule', body)

async function approve(b, session, { callId = null, toolName = null, reason = 'tool requires approval' } = {}) {
  let nextCalled = false
  const outs = b.fireEvent(
    'approval/request',
    { agent: { session }, callId, toolName, reason },
    () => { nextCalled = true; return 'NEXT' },
  )
  return { res: await outs[0], nextCalled }
}

const bashCall = (callId, command = 'echo hi') => [{ callId, name: 'bash', arguments: { command } }]
const writeCall = (callId, file) => [{ callId, name: 'write', arguments: { file_path: file } }]
const ESC = 'escalate sandbox to read-write: need to write outside the sandbox'

/** 在同一个 DSH_HOME 上造一个全新实例（等价「宿主重载：内存档全丢」） */
async function freshRules(home) {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    const ha = await import('../lib/host-approval.js')
    return new ha.HostApprovalRules()
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

// ─────────────────────────────────────────────────────────────────
describe('v1.12.14 ①：空路径集 + 二级选择「落盘工具放行任意路径」⇒ 落盘工具档', () => {
  it('端点级：落盘 {cwd, product:"main", paths:[], tools:["main:write"]}，清空内存态后仍命中', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: writeCall('k1', '/tmp/inv14/alpha/a.txt') })
      assert.equal((await approve(b, s, { callId: 'k1', toolName: 'write' })).nextCalled, true, '前置：首次请求交交互层')

      const { status, json } = await postRule(b, {
        scope: 'project', sessionId: 'R', callId: 'k1', paths: [], toolName: 'write', cwd: '/home/test',
      })
      assert.equal(status, 200)
      assert.equal(json.written, true)
      assert.equal(json.scope, 'project', '工具档已落盘 ⇒ 不得再谎报 session（用户实测的缺口）')
      assert.equal(json.toolOnly, true)
      assert.equal(json.toolPersisted, true)
      assert.deepEqual(json.toolRule, { cwd: '/home/test', key: 'main:write' })

      const rules = allowlistRules(b.home)
      assert.equal(rules.length, 1)
      assert.deepEqual(Object.keys(rules[0]), ['cwd', 'product', 'paths', 'tools', 'grantedAt', 'note'])
      assert.equal(rules[0].cwd, '/home/test')
      assert.equal(rules[0].product, 'main')
      assert.deepEqual(rules[0].paths, [], '工具档条目不得带任何路径')
      assert.deepEqual(rules[0].tools, ['main:write'])
      assert.match(rules[0].note, /落盘工具放行任意路径/)
      assert.equal(grantRows(b.home, 'rule-tool-disk').length, 1)
      assert.equal(grantRows(b.home, 'rule-tool-only').length, 0, '落盘的那一支不该再写会话档留痕')

      // 清空内存态（新实例 = 宿主重载）：只凭盘上的条目就必须命中，且不依赖请求路径
      const fresh = await freshRules(b.home)
      const d = fresh.decide({ sessionId: 'N', rootSessionId: 'N', cwd: '/home/test', paths: ['/outside/anywhere.txt'], toolName: 'write' })
      assert.equal(d.allowed, true, '宿主重载后落盘工具档不再命中（本次要修的缺口原样复发）')
      assert.equal(d.scope, 'project-tool')
      assert.deepEqual(fresh.toolGrants('N'), [], '这条命中必须来自落盘档，不是内存档')
    } finally { await b.close() }
  })

  it('会话档（scope=session）仍不落盘：只写内存工具档 + rule-tool-only 留痕（不变量③）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1') })
      await approve(b, s, { callId: 'c1', toolName: 'bash' })
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'c1', paths: [], toolName: 'bash' })
      assert.equal(status, 200)
      assert.equal(json.scope, 'session')
      assert.equal(json.toolPersisted, undefined, '会话档不该带落盘标记')
      assert.equal(existsSync(allowlistFile(b.home)), false, '会话档（本会话总是允许该工具）不该产生落盘')
      assert.equal(grantRows(b.home, 'rule-tool-only').length, 1)
      assert.equal(grantRows(b.home, 'rule-tool-disk').length, 0)
      // 内存档仍生效（同一根会话内任意路径）
      const sib = mkSession({ id: 'R', toolCalls: bashCall('c2', 'cat /outside/x.txt') })
      const hit = await approve(b, sib, { callId: 'c2', toolName: 'bash' })
      assert.equal(hit.res, 'allowed-once')
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'session-tool')
    } finally { await b.close() }
  })
})

// ─────────────────────────────────────────────────────────────────
describe('v1.12.14 ②：勾路径 + 越权 + 项目档 ⇒ 照落盘（放开条件仅「用户显式点项目档」）', () => {
  it('端点级：落盘路径档、响应 scope=project、留痕 rule-project-written(escalation:true)、重载后命中', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', 'cat /tmp/inv14b/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash', reason: ESC })
      const { status, json } = await postRule(b, {
        scope: 'project', sessionId: 'R', callId: 'c1', paths: ['/tmp/inv14b/alpha'], cwd: '/home/test',
      })
      assert.equal(status, 200)
      assert.equal(json.scope, 'project')
      assert.equal(json.projectSuppressed, undefined, '降级已放开，不得再回 projectSuppressed')
      const rules = allowlistRules(b.home)
      assert.equal(rules.length, 1)
      assert.ok(rules[0].paths.includes('/tmp/inv14b/alpha'))
      assert.equal(grantRows(b.home, 'rule-downgraded').length, 0, '越权降级留痕还在（守卫没真正放开）')
      const row = grantRows(b.home, 'rule-project-written').at(-1)
      assert.ok(row, '显式点项目档必须留痕 action=rule-project-written')
      assert.equal(row.escalation, true, '越权场景必须在留痕里标出')
      assert.match(row.message, /不降级/)

      // 重载后（新实例）同 cwd + 同路径被落盘档放行；越权 reason 不再影响读取侧
      const fresh = await freshRules(b.home)
      const d = fresh.decide({
        sessionId: 'N', rootSessionId: 'N', cwd: '/home/test', paths: ['/tmp/inv14b/alpha/b.txt'],
      })
      assert.equal(d.allowed, true, '宿主重载后落盘路径档不再命中（读侧仍被抑制）')
      assert.equal(d.scope, 'project')
    } finally { await b.close() }
  })
})

// ─────────────────────────────────────────────────────────────────
describe('v1.12.14 ③：保留不变的守卫（一个都没放松）', () => {
  it('④ 「仅本次放行」（paths:null）⇒ 200 written:false，且不写盘', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1') })
      await approve(b, s, { callId: 'c1', toolName: 'bash' })
      const { status, json } = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'c1', paths: null, toolName: 'bash' })
      assert.equal(status, 200)
      assert.equal(json.written, false)
      assert.equal(existsSync(allowlistFile(b.home)), false, '「仅本次」落了盘')
      assert.equal(grantRows(b.home, 'rule-none-declared-null').length, 1)
    } finally { await b.close() }
  })

  it('⑤ 全丢弃声明 ⇒ 400 且 allowlist.json 一个字节都不变', async () => {
    const b = await boot()
    try {
      // 先造一条既有条目，才能断言「字节不变」（而不是「文件不存在」）
      const w = mkSession({ id: 'R', toolCalls: writeCall('w1', '/tmp/inv14c/base.txt') })
      await approve(b, w, { callId: 'w1', toolName: 'write' })
      await postRule(b, { scope: 'project', sessionId: 'R', callId: 'w1', toolName: 'write' })
      const before = allowlistBytes(b.home)
      assert.ok(before, '前置：既有条目要落盘')

      const s = mkSession({ id: 'R', toolCalls: writeCall('k1', '/tmp/inv14c/a.txt') })
      await approve(b, s, { callId: 'k1', toolName: 'read' })
      const { status, json } = await postRule(b, {
        scope: 'project', sessionId: 'R', callId: 'k1', paths: ['./x.txt'], toolName: 'read', cwd: '/home/test',
      })
      assert.equal(status, 400, '全非法声明被接受 ⇒ 会静默退化成工具档（M-B 的放大路径）')
      assert.ok(Array.isArray(json.dropped) && json.dropped.length === 1)
      assert.deepEqual(allowlistBytes(b.home), before, '400 却动了落盘文件')
      assert.equal(grantRows(b.home, 'rule-rejected-all-paths-dropped').length, 1, '拒写要留痕')
    } finally { await b.close() }
  })

  it('⑥ 危险命令门命中 ⇒ 不写任何档（allowlist 不变、无 auto-grant / rule-* 留痕）', async () => {
    const b = await boot()
    try {
      // 先造一条既有条目（含同工具的工具档）——门必须仍然压过一切档位
      const w = mkSession({ id: 'R', toolCalls: writeCall('w1', '/tmp/inv14d/base.txt') })
      await approve(b, w, { callId: 'w1', toolName: 'write' })
      await postRule(b, { scope: 'project', sessionId: 'R', callId: 'w1', paths: [], toolName: 'bash', cwd: '/home/test' })
      const before = allowlistBytes(b.home)
      assert.equal(allowlistRules(b.home).length, 1, '前置：工具档已落盘')

      const d = mkSession({ id: 'R', toolCalls: bashCall('d1', 'rm -rf /tmp/inv14d') })
      const gated = await approve(b, d, { callId: 'd1', toolName: 'bash' })
      assert.equal(gated.nextCalled, true, '危险命令被落盘工具档放行了（门必须排在档位判定之前）')
      assert.notEqual(gated.res, 'allowed-once')
      assert.ok(grantRows(b.home, 'danger-command-block').length >= 1, '门命中的留痕丢失')
      assert.deepEqual(allowlistBytes(b.home), before, '门命中的请求改动了落盘文件')
      assert.equal(grantRows(b.home, 'auto-grant').length, 0, '门命中的请求被记成了自动放行')
      assert.equal(grantRows(b.home, 'rule-tool-disk').length, 1, '门命中的请求又写了一条规则')
    } finally { await b.close() }
  })
})

// ─────────────────────────────────────────────────────────────────
describe('v1.12.14 ④：工具键与 cwd 的两仓共识语义', () => {
  it('toolGrantKey / compileRuleTools 与 product-subagents 逐字同构', async () => {
    const ha = await import('../lib/host-approval.js')
    assert.equal(ha.NATIVE_PRODUCT, 'main')
    assert.equal(ha.toolGrantKey('main', 'Write'), 'main:write', '归一化必须小写去空白')
    assert.equal(ha.toolGrantKey(' main ', ' bash '), 'main:bash')
    assert.equal(ha.toolGrantKey('', 'bash'), null, '空产品维度 ⇒ null（不写通配键）')
    assert.equal(ha.toolGrantKey('main', 'other'), null, '占位类别不得当工具名（写下去等于通配授权）')
    assert.equal(ha.toolGrantKey('main', 'unknown'), null)
    // 带前缀原样归一；裸名只在规则自带 product 时补前缀；脏数据丢弃
    assert.deepEqual(ha.compileRuleTools(['main:Bash'], null), ['main:bash'])
    assert.deepEqual(ha.compileRuleTools(['Bash'], 'qoder'), ['qoder:bash'])
    assert.deepEqual(ha.compileRuleTools(['Bash'], null), [], '裸名 + 无 product ⇒ 丢弃（不许当通配）')
    assert.deepEqual(ha.compileRuleTools([':x', 'x:', 'a:b:c', '', 42], 'main'), [])
    // 反向：ACP 产品维度不可能命中主代理工具档
    assert.deepEqual(ha.compileRuleTools(['main:bash'], 'main').includes(ha.toolGrantKey('qoder', 'bash')), false)
  })

  it('cwd 真身等价：软链入口与真实目录是同一个项目；不同目录一律不命中', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'dad-inv14-home-'))
    const proj = mkdtempSync(path.join(os.tmpdir(), 'dad-inv14-proj-'))
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'dad-inv14-link-')), 'proj-link')
    symlinkSync(proj, link)
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const { HostApprovalRules } = await import('../lib/host-approval.js')
      const rules = new HostApprovalRules()
      const w = rules.appendProjectToolRule({ cwd: proj, toolName: 'write' })
      assert.equal(w.ok, true)
      const viaLink = rules.decide({ sessionId: 'S', rootSessionId: 'S', cwd: link, paths: ['/outside/x.txt'], toolName: 'write' })
      assert.equal(viaLink.allowed, true, '软链入口没被当成同一个项目（cwd 判定退回了字面比较）')
      assert.equal(viaLink.scope, 'project-tool')
      const other = rules.decide({ sessionId: 'S', rootSessionId: 'S', cwd: os.tmpdir(), paths: ['/outside/x.txt'], toolName: 'write' })
      assert.equal(other.allowed, false, '不同 cwd 也命中了（工具档变成通配）')
      const otherTool = rules.decide({ sessionId: 'S', rootSessionId: 'S', cwd: proj, paths: ['/outside/x.txt'], toolName: 'bash' })
      assert.equal(otherTool.allowed, false, '不同工具命中了（工具档变成全放行）')
      const noCwd = rules.decide({ sessionId: 'S', rootSessionId: 'S', cwd: null, paths: ['/outside/x.txt'], toolName: 'write' })
      assert.equal(noCwd.allowed, false, '请求无 cwd 却命中项目级工具档（项目隔离被破）')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(home, { recursive: true, force: true })
      rmSync(proj, { recursive: true, force: true })
    }
  })

  it('只追加不覆盖 + 归一化幂等：同 (cwd, 键) 二次写不新增条目，既有路径档原样保留', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'dad-inv14-idem-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const { HostApprovalRules } = await import('../lib/host-approval.js')
      const rules = new HostApprovalRules()
      rules.appendProjectRule({ cwd: '/proj', paths: ['/proj/a.txt'] })
      const pathRuleBefore = JSON.stringify(JSON.parse(readFileSync(rules.filePath, 'utf8')).rules[0])
      rules.appendProjectToolRule({ cwd: '/proj', toolName: 'write', note: '第一次' })
      const mid = JSON.parse(readFileSync(rules.filePath, 'utf8')).rules
      assert.equal(mid.length, 2, '工具档没追加进去')
      rules.appendProjectToolRule({ cwd: '/proj', toolName: 'WRITE', note: '第二次' })
      rules.appendProjectToolRule({ cwd: '/proj/', toolName: ' write ', note: '第三次' })
      const after = JSON.parse(readFileSync(rules.filePath, 'utf8')).rules
      assert.equal(after.length, 2, '同 (cwd, 归一化键) 重复写入新增了条目（幂等被破）')
      assert.equal(after[1].note, '第三次', '重复写入应更新 note')
      assert.deepEqual(after[1].tools, ['main:write'])
      assert.equal(JSON.stringify(after[0]), pathRuleBefore, '既有路径档条目被改写了（必须只追加不覆盖）')
      // 不同工具 ⇒ 追加成新条目
      rules.appendProjectToolRule({ cwd: '/proj', toolName: 'bash' })
      assert.equal(JSON.parse(readFileSync(rules.filePath, 'utf8')).rules.length, 3)
      // 缺 cwd / 缺工具名 / 相对 cwd ⇒ 明确拒绝（不许写出无作用域的通配条目）
      assert.equal(rules.appendProjectToolRule({ cwd: '/proj' }).ok, false)
      assert.equal(rules.appendProjectToolRule({ toolName: 'write' }).ok, false)
      assert.equal(rules.appendProjectToolRule({ cwd: 'proj', toolName: 'write' }).ok, false)
      assert.equal(rules.appendProjectToolRule({ cwd: '/proj', toolName: 'other' }).ok, false)
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      rmSync(home, { recursive: true, force: true })
    }
  })
})

// ─────────────────────────────────────────────────────────────────
describe('v1.12.14 ⑤：源码级守卫（改回旧行为即转红）', () => {
  it('index.js：空声明分支按 scope 分流，落盘失败回退会话档并留痕', () => {
    const idx = src('index.js')
    assert.match(idx, /const persistToolRule = scope === 'project'/, '缺「按 scope 分流」判据')
    assert.match(idx, /hostApproval\.appendProjectToolRule\(\{/, '项目档那一支没有调用落盘工具档')
    assert.match(idx, /action: 'rule-tool-disk'/, '落盘工具档没有留痕')
    assert.match(idx, /action: 'rule-tool-disk-failed'/, '落盘失败没有回退留痕（用户会以为落盘了）')
    assert.match(idx, /action: 'rule-project-written'/, '显式点项目档没有如实留痕')
    // 越权降级那一支必须彻底消失（v1.12.14 有意放开）
    assert.doesNotMatch(idx, /action: 'rule-downgraded'/, '越权降级分支还在（守卫没真正放开）')
    // 只查**代码用法**（注释里会提到这段历史）
    assert.doesNotMatch(idx, /const sessionOnly =/, 'handler 里还在算 sessionOnly（读侧仍会抑制）')
    assert.doesNotMatch(idx, /sessionOnly\s*[:,]/, 'decide 调用点还在传 sessionOnly')
  })

  it('lib/host-approval.js：工具档走原子写、按 product 隔离、decide 里没有 sessionOnly 抑制', () => {
    const lib = src('lib/host-approval.js')
    assert.match(lib, /export const NATIVE_PRODUCT = 'main'/)
    assert.match(lib, /export function toolGrantKey\(product, toolName\)/)
    assert.match(lib, /export function compileRuleTools\(tools, ruleProduct\)/)
    assert.match(lib, /appendProjectToolRule\(rule\) \{/)
    assert.match(lib, /fs\.renameSync\(tmp, this\.#file\)/, '落盘工具档没走原子写（tmp + rename）')
    assert.match(lib, /scope: 'project-tool'/, 'decide 缺落盘工具档分支')
    assert.match(lib, /projectToolRulesCover\(cwd, toolName\)/, 'decide 没消费落盘工具档')
    assert.doesNotMatch(lib, /sessionOnly\s*=\s*false/, 'decide 签名里还有 sessionOnly 参数')
    assert.doesNotMatch(lib, /!sessionOnly/, '读侧 sessionOnly 抑制还在')
    // 门与档位的顺序哨兵：危险命令门在 index.js 更上面，lib 侧不重复实现
    assert.match(src('index.js'), /dangerousCommandMatch\(dangerCmd\.text\)/, '危险命令门不见了')
  })

  it('lib/client.js：项目档如实标「会落盘」，会话档如实标「不落盘」', () => {
    const cli = src('lib/client.js')
    assert.match(cli, /toolTierDisk: scope === "project"/, '宿主项目档没把「工具档会落盘」透给弹框')
    assert.doesNotMatch(cli, /toolTierDisk: false,/, '宿主通道仍硬编码 toolTierDisk:false（旧缺陷）')
    assert.match(cli, /落盘一条工具档/, '二级说明没说清「落盘一条工具档」')
    assert.match(cli, /照常落盘/, '越权 + 项目档的说明没说清「照常落盘」')
    assert.doesNotMatch(cli, /宿主通道的工具名档只有会话级/, '已失效的旧说法还在（面板会说谎）')
  })
})
