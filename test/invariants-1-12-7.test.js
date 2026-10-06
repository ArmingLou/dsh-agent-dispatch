// test/invariants-1-12-7.test.js — v1.12.7 交付要求：7 条新不变式（用户第三次裁定）。
//
// 裁定原文（用户口径，不得自行更改）：
//   「工具名档不再被『沙箱越权』排除」——reason 以 `escalate sandbox to` 开头的请求，
//   若该根会话已有该工具名的工具档，则**直接自动放行**（allowed-once 短路），不再弹窗；
//   越权**仍然**不写「项目级落盘白名单」；危险命令门 / 超长兜底门 / 执行类无正文门
//   保持最前，永远 return next()；客户端文案必须与真实行为一致；
//   服务端在 approval context 里下发 home，客户端把 `~/...` 拼成绝对路径并恢复默认勾选，
//   拿不到 home 时保持现状（原样保留 + 不勾选 + 保留警示）。
//
// 本文件覆盖 ①–⑤（端点/监听器层）与 ⑥⑦ 的**纯函数层**；⑥⑦ 的**弹框层**
// （默认勾选 / 强制不勾选 + 警示）在 test/grant-dialog.test.js 的同名 describe 里
// （那边有完整的假 DOM 与弹框夹具，重复一套只会两边漂移）：
//   ① 越权 + 工具档命中 ⇒ 不弹、scope='session-tool'
//   ② 越权 + 工具档未命中 ⇒ 仍弹
//   ③ 危险命令 + 工具档命中 ⇒ 仍弹（门在最前，压过工具档）
//   ④ 危险命令的等价写法 / 超长兜底 / 执行类无正文 也在门前（③ 的补充）
//   ⑤ ACP 孪生 + 工具档命中 ⇒ 仍 next()（孪生退化为防御性冗余，语义不变）
//   ⑥ 越权授权仍不落项目档（projectSuppressed + 跨会话不生效）
//   ⑦ `~/xxx` 拼成 home 绝对路径；拿不到 home ⇒ 原样保留（弹框侧的不勾选见 grant-dialog）
//
// 运行：node --test test/invariants-1-12-7.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, mkSession } from './agent-api-harness.js'

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
const grantRows = (home, action) =>
  logRows(home).filter((r) => r.kind === 'host-approval' && (!action || r.action === action))
const allowlistFile = (home) => path.join(home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')
const bashCall = (callId, cmd, name = 'bash') => [{ callId, name, arguments: { command: cmd } }]

/** 把工具名档写到根会话键上——等价于用户在授权球点「本会话总是允许该工具」。 */
async function grantTool(b, session, { callId, toolName, rootId = 'R' }) {
  const first = await approve(b, session, { callId, toolName, reason: 'tool requires approval' })
  assert.equal(first.nextCalled, true, '前置：首次请求应交给交互层')
  const { status } = await postRule(b, { scope: 'session', sessionId: session.id, callId, toolName })
  assert.equal(status, 200)
  return rootId
}

// ════════════════════════════════════════════════════════════════════
describe('v1.12.7 不变量①：越权 + 工具档命中 ⇒ 不弹、scope=session-tool', () => {
  it('同一路径与**任意其它路径**都被工具档短路，留痕 scope=session-tool', async () => {
    const b = await boot()
    try {
      const s0 = mkSession({ id: 'child-0', parentSession: 'R', toolCalls: bashCall('g0', 'echo hi') })
      await grantTool(b, s0, { callId: 'g0', toolName: 'bash' })

      // 同一路径的越权
      const s1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('e1', 'cat /tmp/proj/a.txt') })
      const a = await approve(b, s1, { callId: 'e1', toolName: 'bash', reason: ESC })
      assert.equal(a.res, 'allowed-once', '越权没吃到工具名档（1.12.5/1.12.6 的实战失效复发）')
      assert.equal(a.nextCalled, false, '越权仍弹出交互层')
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'session-tool')

      // 工作区外的另一条路径：工具档的语义就是「该工具任意路径」
      const s2 = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('e2', 'cat /outside/ws/z.txt') })
      const c = await approve(b, s2, { callId: 'e2', toolName: 'bash', reason: ESC })
      assert.equal(c.res, 'allowed-once', '换路径就不放行 ⇒ 工具档的「任意路径（含工作区外）」语义缩水了')
      assert.equal(c.nextCalled, false)

      // 反向哨兵：这次改动**只**动读取侧，写入侧的留痕形态不变（仍是 auto-grant/session-tool）
      assert.equal(grantRows(b.home, 'auto-grant').every((r) => r.kind === 'host-approval'), true)
    } finally { await b.close() }
  })
})

describe('v1.12.7 不变量②：越权 + 工具档**未**命中 ⇒ 仍弹（不得放大成「越权一律放行」）', () => {
  it('根会话没有任何工具档时，越权照旧委托交互层', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('e1', 'cat /tmp/proj/a.txt') })
      const r = await approve(b, s, { callId: 'e1', toolName: 'bash', reason: ESC })
      assert.equal(r.nextCalled, true, '没有任何授权时越权被放行了（授权放大）')
      assert.notEqual(r.res, 'allowed-once')
      assert.equal(grantRows(b.home, 'auto-grant').length, 0, '空授权下不该有任何自动放行留痕')
    } finally { await b.close() }
  })

  it('工具档在**别的**根会话键上 ⇒ 对本根会话无效（越权也一视同仁）', async () => {
    const b = await boot()
    try {
      const other = mkSession({ id: 'child-o', parentSession: 'R2', toolCalls: bashCall('go', 'echo hi') })
      await grantTool(b, other, { callId: 'go', toolName: 'bash', rootId: 'R2' })
      const s = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('e1', 'cat /tmp/proj/a.txt') })
      const r = await approve(b, s, { callId: 'e1', toolName: 'bash', reason: ESC })
      assert.equal(r.nextCalled, true, 'R2 的工具档放行了 R1 的越权请求（跨根会话泄漏）')
      assert.notEqual(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('工具名不同 ⇒ 越权不吃别人的工具档', async () => {
    const b = await boot()
    try {
      const s0 = mkSession({ id: 'child-0', parentSession: 'R', toolCalls: bashCall('g0', 'echo hi') })
      await grantTool(b, s0, { callId: 'g0', toolName: 'bash' })
      const s = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: [{ callId: 'e1', name: 'write', arguments: { file_path: '/tmp/proj/a.txt' } }] })
      const r = await approve(b, s, { callId: 'e1', toolName: 'write', reason: ESC })
      assert.equal(r.nextCalled, true, 'write 的越权吃了 bash 的工具档（工具名未隔离）')
      assert.notEqual(r.res, 'allowed-once')
    } finally { await b.close() }
  })
})

describe('v1.12.7 不变量③：危险命令门 / 超长门 / 执行类无正文门仍压过工具档', () => {
  it('已授权 bash + rm -rf / git push / npm publish 的越权与非越权都一律 next()', async () => {
    const b = await boot()
    try {
      const s0 = mkSession({ id: 'child-0', parentSession: 'R', toolCalls: bashCall('g0', 'echo hi') })
      await grantTool(b, s0, { callId: 'g0', toolName: 'bash' })
      for (const reason of [ESC, 'tool requires approval']) {
        for (const cmd of ['rm -rf /tmp/x', 'git push origin main', 'npm publish', 'pnpm publish', 'yarn publish']) {
          const s = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('d1', cmd) })
          const r = await approve(b, s, { callId: 'd1', toolName: 'bash', reason })
          assert.equal(r.nextCalled, true, `${cmd}（reason=${reason === ESC ? '越权' : '非越权'}）被工具档静默放行了`)
          assert.notEqual(r.res, 'allowed-once', `${cmd} 返回了 allowed-once`)
        }
      }
      const blocked = grantRows(b.home, 'danger-command-block')
      assert.ok(blocked.length >= 5, `危险命令门的留痕条数不足：${blocked.length}`)
      assert.equal(grantRows(b.home, 'auto-grant').length, 0, '整轮里不该有任何自动放行')
    } finally { await b.close() }
  })

  it('执行类调用解析不出命令文本 ⇒ 保守转交互（压过工具档，越权也一样）', async () => {
    const b = await boot()
    try {
      const s0 = mkSession({ id: 'child-0', parentSession: 'R', toolCalls: bashCall('g0', 'echo hi') })
      await grantTool(b, s0, { callId: 'g0', toolName: 'bash' })
      // 声明 bash、参数体里没有命令文本 ⇒ commandText 为空 ⇒ 无正文门命中
      const noText = [{ callId: 'n1', name: 'bash', arguments: { cwd: '/tmp' } }]
      for (const reason of [ESC, 'tool requires approval']) {
        const s = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: noText })
        const r = await approve(b, s, { callId: 'n1', toolName: 'bash', reason })
        assert.equal(r.nextCalled, true, `执行类无正文（reason=${reason === ESC ? '越权' : '非越权'}）被放行了`)
        assert.notEqual(r.res, 'allowed-once')
      }
      assert.ok(grantRows(b.home, 'no-command-text-block').length >= 2, '保守门的留痕丢失')
    } finally { await b.close() }
  })

  it('门的位置（源码级顺序哨兵）：三门都在工具名短路之前', () => {
    const idx = readFileSync(path.join(root, 'index.js'), 'utf8')
    const shortAt = idx.indexOf('if (!disallowToolGrant && ctxInfo.toolName && hostApproval.toolGrantCovers(')
    assert.ok(shortAt > 0, '工具名短路调用点丢失')
    for (const [needle, why] of [
      ['const danger = dangerousCommandMatch(dangerCmd.text)', '危险命令门'],
      ['if (dangerCmd.omitted > 0) {', '超长兜底门'],
      ["action: 'no-command-text-block'", '执行类无正文门'],
    ]) {
      const at = idx.indexOf(needle)
      assert.ok(at > 0, `${why}的调用点丢失（${needle}）`)
      assert.ok(at < shortAt, `${why}排到了工具名短路之后——已授权工具名下会被静默放行`)
    }
    // 工具有授权才谈得上「压过工具档」；这条保证上面的用例真的在考门前置
    assert.ok(idx.includes('const disallowToolGrant = isDisallowedAutoGrant(ctxInfo.toolName, ctxInfo.reason)'))
  })
})

describe('v1.12.7 不变量④：ACP 孪生 + 工具档命中 ⇒ 仍 next()（完全绕过，语义不变）', () => {
  it('product_submit 已授权、reason 以 [ACP 开头 ⇒ 一档都不判', async () => {
    const b = await boot()
    try {
      const s0 = mkSession({
        id: 'child-0', parentSession: 'R',
        toolCalls: [{ callId: 'g0', name: 'product_submit', arguments: { task: 'x', file_path: '/tmp/proj/a.txt' } }],
      })
      await grantTool(b, s0, { callId: 'g0', toolName: 'product_submit' })

      const s = mkSession({
        id: 'child-1', parentSession: 'R',
        toolCalls: [{ callId: 'a1', name: 'product_submit', arguments: { task: 'x', file_path: '/tmp/proj/a.txt' } }],
      })
      const r = await approve(b, s, { callId: 'a1', toolName: 'product_submit', reason: '[ACP qoder] 请求权限：submit' })
      assert.equal(r.nextCalled, true, 'ACP 孪生被工具名档放行了（违反「完全绕过、不动它」）')
      assert.notEqual(r.res, 'allowed-once')
      assert.equal(grantRows(b.home, 'auto-grant').length, 0, '孪生不该有任何自动放行留痕')

      // 早退门的位置：必须排在 disallowToolGrant 计算**之前**（挪走即红）
      const idx = readFileSync(path.join(root, 'index.js'), 'utf8')
      const twinAt = idx.indexOf('if (isAcpTwinApproval(ctxInfo.toolName, ctxInfo.reason)) return next()')
      const disAt = idx.indexOf('const disallowToolGrant = isDisallowedAutoGrant')
      assert.ok(twinAt > 0 && disAt > twinAt, 'ACP 孪生早退门不再排在档位判据之前')
    } finally { await b.close() }
  })

  it('判据侧：isDisallowedAutoGrant 拆开后只剩孪生一种来源（越权为 false、孪生为 true）', async () => {
    const ha = await import('../lib/host-approval.js')
    assert.equal(ha.isDisallowedAutoGrant('bash', ESC), false, '越权又被算进「不得用工具名档」')
    assert.equal(ha.isDisallowedAutoGrant('product_submit', '[ACP qoder] 请求权限'), true, '孪生不再被排除')
    assert.equal(ha.isSandboxEscalation(ESC), true, '越权识别本身必须保留（它现在只管 sessionOnly）')
  })
})

describe('v1.12.7 不变量⑤：越权授权仍**不**落项目档（不落盘、跨会话不生效）', () => {
  it('越权 + scope=project + 声明目录 ⇒ projectSuppressed、allowlist 不创建、换会话仍要问', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', 'cat /tmp/dad-v7/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash', reason: ESC })
      const { status, json } = await postRule(b, {
        scope: 'project', sessionId: 'R', callId: 'c1', paths: ['/tmp/dad-v7/alpha'], cwd: '/tmp/dad-v7',
      })
      assert.equal(status, 200)
      assert.equal(json.scope, 'session', '越权的项目档没被降级成会话档')
      assert.equal(json.projectSuppressed, true, '越权必须如实回 projectSuppressed')
      assert.equal(json.pathsSource, 'user')
      assert.equal(existsSync(allowlistFile(b.home)), false, '越权把声明目录落盘了（跨会话静默提权）')

      // 换一个根会话、同 cwd、同目录 ⇒ 必须仍然弹（会话档不外溢；落盘白名单里也没有它）
      const other = mkSession({ id: 'R2', toolCalls: bashCall('c2', 'cat /tmp/dad-v7/alpha/b.txt') })
      const r2 = await approve(b, other, { callId: 'c2', toolName: 'bash', reason: ESC })
      assert.equal(r2.nextCalled, true, '越权的声明目录跨会话生效了（等同于落盘）')
      assert.notEqual(r2.res, 'allowed-once')

      // 非越权对照：同一份落盘白名单机制本身必须还是通的（否则上面那条是空转）
      const s3 = mkSession({ id: 'R3', toolCalls: bashCall('c3', 'cat /tmp/dad-v7/alpha/c.txt') })
      await approve(b, s3, { callId: 'c3', toolName: 'bash', reason: 'tool requires approval' })
      const w = await postRule(b, {
        scope: 'project', sessionId: 'R3', callId: 'c3', paths: ['/tmp/dad-v7/alpha'], cwd: '/tmp/dad-v7',
      })
      assert.equal(w.json.scope, 'project')
      assert.equal(existsSync(allowlistFile(b.home)), true, '非越权的项目档没落盘（对照失真）')
      const back = mkSession({ id: 'R4', toolCalls: bashCall('c4', 'cat /tmp/dad-v7/alpha/d.txt') })
      const hit = await approve(b, back, { callId: 'c4', toolName: 'bash', reason: 'tool requires approval' })
      assert.equal(hit.res, 'allowed-once', '落盘白名单对非越权请求没生效（跨会话复用断了）')
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'project')
    } finally { await b.close() }
  })

  it('越权 + 删空声明（只写工具名档）同样不落盘', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', 'cat /tmp/dad-v7b/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash', reason: ESC })
      const { status } = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'c1', toolName: 'bash', paths: [] })
      assert.equal(status, 200)
      assert.equal(existsSync(allowlistFile(b.home)), false, '删空声明（工具名档）不该产生任何落盘')
    } finally { await b.close() }
  })

  // 读取侧的 sessionOnly：**已落盘的**项目档不得替越权放行。
  // 这是本轮最容易被「顺手简化」掉的一格——`sessionOnly: disallowToolGrant` 那个焊点
  // 一旦留着（或 sessionOnly 被写成 false），判据拆开之后越权就会**连项目档一起放开**，
  // 等于把「某路径可提权到 danger-full-access」静默落盘长期留存（用户明确否决过）。
  it('越权请求**不得**被已落盘的项目档放行（sessionOnly 读取侧；非越权对照必须仍放行）', async () => {
    const b = await boot()
    try {
      // ① 先用**非越权**请求在同一 cwd 下落盘一条项目规则（把落盘链路本身走通）
      const n = mkSession({ id: 'N', toolCalls: bashCall('n1', 'cat /tmp/dad-v7c/alpha/a.txt') })
      await approve(b, n, { callId: 'n1', toolName: 'bash', reason: 'tool requires approval' })
      const w = await postRule(b, {
        scope: 'project', sessionId: 'N', callId: 'n1', paths: ['/tmp/dad-v7c/alpha'], cwd: '/tmp/dad-v7c',
      })
      assert.equal(w.status, 200)
      assert.equal(w.json.scope, 'project', '前置：非越权请求必须能落盘（否则本用例测不到项目档）')
      assert.equal(existsSync(allowlistFile(b.home)), true, '前置：allowlist.json 确实创建了')

      // ② 对照组：同一 cwd、被覆盖的路径、**非越权** reason ⇒ 项目档放行（跨会话复用仍通）
      const p = mkSession({ id: 'P', toolCalls: bashCall('p1', 'cat /tmp/dad-v7c/alpha/b.txt') })
      const ok = await approve(b, p, { callId: 'p1', toolName: 'bash', reason: 'tool requires approval' })
      assert.equal(ok.res, 'allowed-once', '非越权的项目档放行被一起关掉了（超出裁定范围）')
      assert.equal(ok.nextCalled, false)
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'project')

      // ③ 同一 setup，只把 reason 换成越权 ⇒ **必须仍然弹**（sessionOnly 读取侧；工具档此时未命中）
      const e = mkSession({ id: 'E', toolCalls: bashCall('e1', 'cat /tmp/dad-v7c/alpha/c.txt') })
      const esc = await approve(b, e, { callId: 'e1', toolName: 'bash', reason: ESC })
      assert.equal(esc.nextCalled, true,
        '越权吃了已落盘的项目档——授权放大到跨会话落盘（v1.12.5 二次裁定被推翻）')
      assert.notEqual(esc.res, 'allowed-once')

      // ④ 反向哨兵：同一条越权请求，只要工具档命中（同一主会话）就必须放行 ——
      //    证明 ③ 的 next() 来自 sessionOnly，而不是「越权一律不放行」。
      const s0 = mkSession({ id: 'child-0', parentSession: 'E', toolCalls: bashCall('g0', 'echo hi') })
      await grantTool(b, s0, { callId: 'g0', toolName: 'bash' })
      const e2 = mkSession({ id: 'child-1', parentSession: 'E', toolCalls: bashCall('e2', 'cat /tmp/dad-v7c/alpha/d.txt') })
      const viaTool = await approve(b, e2, { callId: 'e2', toolName: 'bash', reason: ESC })
      assert.equal(viaTool.res, 'allowed-once', '同一主会话的工具档没有优先于 sessionOnly（档位顺序反了）')
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'session-tool')
    } finally { await b.close() }
  })
})

// ════════════════════════════════════════════════════════════════════
// ⑥⑦ 的纯函数层：`~` 展开基准（弹框层在 test/grant-dialog.test.js）
// ════════════════════════════════════════════════════════════════════
//
// lib/client.js 是浏览器 classic script（依赖 window/document），无法 import。
// 这里沿用 grant-dialog.test.js 的抠源码做法，但只取 `~` 展开用得到的**纯函数**
// （resolveAgainstCwd / dirsOfPaths / absolutizeDirs）——它们不碰 DOM，
// 所以下面不注入假 document；openGrantDialog 的定义会被一起带进来但不执行。
const clientSrc = readFileSync(path.join(root, 'lib', 'client.js'), 'utf8')
function grabPureHelpers() {
  const HELP_START = 'function isEscalationReason(reason) {'
  const HELP_END = '\n    // 返回一跳'
  const iStart = clientSrc.indexOf(HELP_START)
  assert.ok(iStart >= 0, `client.js 找不到 "${HELP_START}"（共用件被改名或删除？）`)
  const iEnd = clientSrc.indexOf(HELP_END, iStart)
  assert.ok(iEnd > iStart, 'client.js 里找不到共用件结束锚点（结构变了请同步本用例）')
  const srcSlice = clientSrc.slice(iStart, iEnd)
  const factory = new Function('document', 'setTimeout',
    srcSlice + '\nreturn { resolveAgainstCwd, dirsOfPaths, absolutizeDirs };')
  return factory(undefined, () => 0)
}

describe('v1.12.7 不变量⑥：`~/xxx` 按服务端下发的 home 拼成绝对路径（恢复默认勾选）', () => {
  const mod = grabPureHelpers()

  it('resolveAgainstCwd：`~` 与 `~/…` 用 home 展开，与 cwd 无关', () => {
    assert.equal(mod.resolveAgainstCwd('~/.ssh/id_rsa', '/proj', '/home/dev'), '/home/dev/.ssh/id_rsa')
    assert.equal(mod.resolveAgainstCwd('~/x.txt', null, '/home/dev'), '/home/dev/x.txt', 'cwd 缺失也不影响 `~` 展开')
    assert.equal(mod.resolveAgainstCwd('~', '/proj', '/home/dev'), '/home/dev', '`~` 本身 = home')
    assert.equal(mod.resolveAgainstCwd('~/', '/proj', '/home/dev'), '/home/dev')
    assert.equal(mod.resolveAgainstCwd('~/a/../b', '/proj', '/home/dev'), '/home/dev/b', '仍走词法规范化')
  })

  it('`~user/…` 不展开（那是别人的 home，猜错方向是把授权挪到别的目录）', () => {
    assert.equal(mod.resolveAgainstCwd('~root/.ssh', '/proj', '/home/dev'), null)
    assert.equal(mod.resolveAgainstCwd('~root', '/proj', '/home/dev'), null)
  })

  it('dirsOfPaths：`~/.ssh/id_rsa` ⇒ home 下的目录（与 normalizeCandidate 同源口径）', () => {
    assert.deepEqual(mod.dirsOfPaths(['~/.ssh/id_rsa'], '/proj', '/home/dev'), ['/home/dev/.ssh'])
    assert.deepEqual(mod.dirsOfPaths(['~/.ssh'], '/proj', '/home/dev'), ['/home/dev/.ssh'],
      '`.ssh` 这类点开头目录不取父目录（不会放大到 home 本身）')
  })

  it('absolutizeDirs（ACP 通道）：目录形态原样展开，不套文件判据', () => {
    assert.deepEqual(mod.absolutizeDirs(['~/.config/app'], null, '/home/dev'), ['/home/dev/.config/app'])
  })

  it('home 不下发时 `~` 一律不猜（返回 null ⇒ 调用方原样保留）', () => {
    for (const home of [null, undefined, '', '   ', 'relative/home']) {
      assert.equal(mod.resolveAgainstCwd('~/.ssh/id_rsa', '/proj', home), null, `home=${JSON.stringify(home)} 时仍猜了`)
    }
  })
})

describe('v1.12.7 不变量⑦：拿不到 home ⇒ 原样保留 + 不勾选 + 保留警示', () => {
  const mod = grabPureHelpers()

  it('dirsOfPaths：拿不到 home 时 `~` 行原样保留（交给弹框走降级分支）', () => {
    assert.deepEqual(mod.dirsOfPaths(['~/.ssh/id_rsa'], '/proj', null), ['~/.ssh/id_rsa'],
      '拿不到 home 时 `~` 必须原样保留，绝不猜成 cwd 下的路径')
    assert.deepEqual(mod.dirsOfPaths(['~/.ssh/id_rsa'], '/proj', undefined), ['~/.ssh/id_rsa'])
  })

  it('相对路径的降级不受影响：cwd 缺失时 `./x.txt` 原样保留', () => {
    assert.deepEqual(mod.dirsOfPaths(['./x.txt'], null, '/home/dev'), ['./x.txt'])
  })

  it('（弹框层）不勾选 + 行下警示由 grant-dialog.test.js 的同名 describe 覆盖', () => {
    // 这里只做一次源码级接线断言：home 取不到时 openGrantDialog 必须收到 null/缺席，
    // 于是 unresolvedNote 走「本次没拿到服务端下发的 home，`~` 无法展开」那条。
    assert.match(clientSrc, /const homePath = typeof o\.home === "string" && o\.home\.trim\(\) \? o\.home\.trim\(\) : null;/,
      '弹框没从 opts 取 home（缺它 `~` 行只能原样 + 不勾选 + 警示）')
    assert.match(clientSrc, /本次没拿到服务端下发的 home/,
      '缺 home 时的降级原因必须如实写出来（旧文案「服务端也不展开」是假话）')
    assert.match(clientSrc, /const amberHome = typeof p\.home === "string" && p\.home\.trim\(\) \? p\.home\.trim\(\) : null;/,
      'ACP 通道没从行载荷取 home')
    const grantSrc = readFileSync(path.join(root, 'test', 'grant-dialog.test.js'), 'utf8')
    assert.ok(grantSrc.includes('ad-grant-rowwarn'),
      'grant-dialog.test.js 的弹框警示哨兵丢失（⑥⑦ 的弹框层覆盖被删）')
  })
})
