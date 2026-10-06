// test/host-approval-endpoint.test.js — v1.12.4：POST /agent-api/host-approval-rule 端点级行为测试。
//
// 为什么必须有这份文件：v1.12.3 之前该端点只有 verify.mjs 的字符串存在性断言
// （index.js 里出现了 '/agent-api/host-approval-rule' 字样就算过）。终审做过 RED-D
// 实验——把写入键从 rootSessionId 改回 sid，仓库 356 用例全绿、verify.mjs 全绿，
// 也就是「写读键必须一致」这条硬不变量在仓库内没有守卫。这里的用例全部走真实
// route.handler + 真实 approval/request 监听器（假宿主 session），断言的是
// 「写下去的键能否被判定侧读到」，改回 sid 立刻转红。
//
// 运行：node --test test/host-approval-endpoint.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { boot, mkSession } from './agent-api-harness.js'

/** 驱动真实 approval/request 监听器：返回 {res, nextCalled}（res='allowed-once' 即自动放行） */
async function approve(b, session, { callId = null, toolName = null, reason = 'tool requires approval' } = {}) {
  let nextCalled = false
  const outs = b.fireEvent(
    'approval/request',
    { agent: { session }, callId, toolName, reason },
    () => { nextCalled = true; return 'NEXT' },
  )
  const res = await outs[0]
  return { res, nextCalled }
}

/** 写规则（服务端按 callId 重取路径，客户端传的 paths 一概不信） */
const postRule = (b, body) => b.req('POST', '/agent-api/host-approval-rule', body)

/** 决策日志（dispatches.jsonl）行 */
const logRows = (home) => {
  const f = path.join(home, 'data', 'dsh-agent-dispatch', 'dispatches.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

const writeCall = (callId, file) => [{ callId, name: 'write', arguments: { file_path: file } }]

/**
 * 执行类调用记录：**name 与 arguments 必须自洽**。
 * v1.12.6 危险命令门要求「执行类调用解析不出命令文本 ⇒ 不自动放行」，所以
 * 「授权 bash、却拿 write 的参数体当记录」这种拼接夹具会先被那道门拦下，
 * 断言就会在错误的层上转红（测的不再是工具名档）。这里给 bash 一条真实命令文本。
 */
const bashCall = (callId, command = 'echo hi') => [{ callId, name: 'bash', arguments: { command } }]

describe('POST /agent-api/host-approval-rule：写入键 = 判定键（有 callId）', () => {
  it('子会话 + callId → 写到根会话键，同根兄弟子会话随后命中（RED-D 守卫）', async () => {
    const b = await boot()
    try {
      const c1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      const before = await approve(b, c1, { callId: 'c1', toolName: 'write' })
      assert.equal(before.nextCalled, true, '首次请求应交给交互层')

      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'c1', toolName: 'write' })
      assert.equal(status, 200)
      assert.equal(json.written, true)
      assert.equal(json.rootSessionId, 'R', '服务端必须解析出根会话 id，而不是采信客户端的 child-1')

      // 同一根下的兄弟子会话，**路径在授权目录之外**（`/proj/**` 之外）：
      // 路径规则必不命中，放行只可能来自根键上的工具名授权——这条断言因此只依赖工具名档
      const c2 = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: writeCall('c2', '/elsewhere/b.txt') })
      const sib = await approve(b, c2, { callId: 'c2', toolName: 'write' })
      assert.equal(sib.res, 'allowed-once', '兄弟子会话没命中根键授权（写入键跑到了子会话上）')
      assert.equal(sib.nextCalled, false)

      // 发起授权的子会话自己也命中
      const again = await approve(b, c1, { callId: 'c1', toolName: 'write' })
      assert.equal(again.res, 'allowed-once')
    } finally { await b.close() }
  })

  // v1.12.4 终审补：上面那条**遮蔽**了路径档——addSessionRule 会把文件连带的直接父目录
  // 一起写入（lib/host-approval.js:455 expandPathsWithParents），所以兄弟路径
  // /proj/other/b.txt 本来就被路径规则覆盖；而 POST 又带着 toolName ⇒ 工具名短路先命中。
  // 结果：把 addSessionRule(rootSessionId,…) 改成 addSessionRule(sid,…) 时全仓 0 红。
  // 下面两条按通道拆开，各自只依赖一把键，谁写错键谁转红。
  it('路径档独立守卫：授权 read、用**未授权的 write** 命中路径规则（写读键一致）', async () => {
    const b = await boot()
    try {
      const c1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      await approve(b, c1, { callId: 'c1', toolName: 'read' })
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'c1', toolName: 'read' })
      assert.equal(status, 200)
      assert.equal(json.rootSessionId, 'R', '服务端必须解析出根会话 id，而不是采信客户端的 child-1')
      // 兄弟子会话：工具名 write **从未授权** ⇒ 工具名短路必不命中，
      // allowed-once 只能来自「路径规则写在根键上」这一条
      const c2 = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: writeCall('c2', '/proj/a.txt') })
      const sib = await approve(b, c2, { callId: 'c2', toolName: 'write' })
      assert.equal(sib.res, 'allowed-once', '路径规则没写在根键上（写入键=判定键 被破坏）')
      // 反向对照：路径不覆盖 + 工具名未授权 → 必须仍走人工审批
      // （证明上一条不是「写了条通配规则」造成的全局放行）
      const c3 = mkSession({ id: 'child-3', parentSession: 'R', toolCalls: writeCall('c3', '/elsewhere/z.txt') })
      const out = await approve(b, c3, { callId: 'c3', toolName: 'write' })
      assert.equal(out.res, 'NEXT', '未被覆盖的路径也必须不被放行')
      assert.equal(out.nextCalled, true)
    } finally { await b.close() }
  })

  it('工具名档独立守卫：路径不覆盖时，只可能由根键的工具名授权放行', async () => {
    const b = await boot()
    try {
      const c1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('c1') })
      await approve(b, c1, { callId: 'c1', toolName: 'bash' })
      const { json } = await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'c1', toolName: 'bash' })
      assert.equal(json.rootSessionId, 'R')
      const c2 = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('c2') })
      const sib = await approve(b, c2, { callId: 'c2', toolName: 'bash' })
      assert.equal(sib.res, 'allowed-once', '工具名授权没写在根键上（两把键互相遮蔽的反证）')
      // 对照：同一路径下换个未授权工具名 → 只能由路径档决定，路径不覆盖 ⇒ 必须弹窗
      const c3 = mkSession({ id: 'child-3', parentSession: 'R', toolCalls: writeCall('c3', '/elsewhere/x.txt') })
      const neg = await approve(b, c3, { callId: 'c3', toolName: 'other-tool' })
      assert.equal(neg.res, 'NEXT')
    } finally { await b.close() }
  })

  it('不变量：两把键各只对自己的通道负责（工具名授权与路径规则互不遮蔽）', async () => {
    const b = await boot()
    try {
      // 一次授权：根键 R 上同时写下 工具名 write + 路径 /proj/a.txt（含其父目录 /proj）
      const c1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      await approve(b, c1, { callId: 'c1', toolName: 'write' })
      const { json } = await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'c1', toolName: 'write' })
      assert.equal(json.rootSessionId, 'R')
      // ① 未授权工具名 + 被覆盖路径 → 只有路径档能解释这个放行
      const a = await approve(b, mkSession({ id: 's1', parentSession: 'R', toolCalls: writeCall('s1', '/proj/a.txt') }), { callId: 's1', toolName: 'never-granted' })
      assert.equal(a.res, 'allowed-once', '路径档未落在根键上')
      // ② 已授权工具名 + 未覆盖路径 → 只有工具名档能解释这个放行
      const c = await approve(b, mkSession({ id: 's2', parentSession: 'R', toolCalls: writeCall('s2', '/elsewhere/x.txt') }), { callId: 's2', toolName: 'write' })
      assert.equal(c.res, 'allowed-once', '工具名档未落在根键上')
      // ③ 两档都不满足 → 必须弹窗（证明①②不是通配放行）
      const n = await approve(b, mkSession({ id: 's3', parentSession: 'R', toolCalls: writeCall('s3', '/elsewhere/x.txt') }), { callId: 's3', toolName: 'never-granted' })
      assert.equal(n.res, 'NEXT', '两把键写错还能全局放行')
    } finally { await b.close() }
  })

  it('客户端故意传子会话 id 作 sessionId → 键仍取服务端解析的根', async () => {
    const b = await boot()
    try {
      const child = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('c1') })
      await approve(b, child, { callId: 'c1', toolName: 'bash' }) // 让注册点登记 child→R 并暂存上下文
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'c1', toolName: 'bash' })
      assert.equal(status, 200)
      assert.equal(json.rootSessionId, 'R')
      // 授权落在 R 键上 → R 自身的请求直接放行
      const root = mkSession({ id: 'R', toolCalls: bashCall('c9') })
      const r = await approve(b, root, { callId: 'c9', toolName: 'bash' })
      assert.equal(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('主会话自身 + callId → rootSessionId 就是它自己，写读一致', async () => {
    const b = await boot()
    try {
      const root = mkSession({ id: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      await approve(b, root, { callId: 'c1', toolName: 'write' })
      const { json } = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'write' })
      assert.equal(json.rootSessionId, 'R')
      const again = await approve(b, root, { callId: 'c1', toolName: 'write' })
      assert.equal(again.res, 'allowed-once')
    } finally { await b.close() }
  })
})

describe('POST /agent-api/host-approval-rule：无 callId 的真实语义是 400 且什么都不写', () => {
  it('无 callId + 有 toolName → 400，且随后同类请求仍需人工审批（未写入任何东西）', async () => {
    const b = await boot()
    try {
      const root = mkSession({ id: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      await approve(b, root, { callId: null, toolName: 'bash' })
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'R', toolName: 'bash' })
      assert.equal(status, 400, '无法确认根会话 id 时必须拒写，不能悄悄写到非根键')
      assert.equal(json.ok, false)
      assert.match(json.error, /未写入任何规则/)
      // 反证「降级为路径级」的说法：路径只能由 callId 反查，无 callId ⇒ paths 恒空
      // ⇒ 既没有工具名授权也没有路径规则落进去。
      const after = await approve(b, root, { callId: 'c1', toolName: 'bash' })
      assert.equal(after.nextCalled, true, '400 分支居然写进了规则（应为什么都不写）')
    } finally { await b.close() }
  })

  it('无任何映射的孤儿会话 + 无 callId → 400', async () => {
    const b = await boot()
    try {
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'orphan-1', toolName: 'bash' })
      assert.equal(status, 400)
      assert.match(json.error, /未写入任何规则/)
    } finally { await b.close() }
  })

  it('缺 scope / 缺 sessionId → 400', async () => {
    const b = await boot()
    try {
      assert.equal((await postRule(b, { sessionId: 'R' })).status, 400)
      assert.equal((await postRule(b, { scope: 'session' })).status, 400)
      assert.equal((await postRule(b, { scope: 'bogus', sessionId: 'R' })).status, 400)
    } finally { await b.close() }
  })

  it('project 档：无 callId（解析不出路径）→ 400；有 callId → 落盘并跨会话命中', async () => {
    const b = await boot()
    try {
      assert.equal((await postRule(b, { scope: 'project', sessionId: 'R', cwd: '/home/test' })).status, 400)

      const c1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      await approve(b, c1, { callId: 'c1', toolName: 'write' })
      const { status, json } = await postRule(b, { scope: 'project', sessionId: 'child-1', callId: 'c1', cwd: '/home/test' })
      assert.equal(status, 200)
      assert.equal(json.written, true)
      assert.equal(existsSync(path.join(b.home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')), true, '项目档必须落盘')
      // 另一个主会话（不同根、同 cwd）走项目规则命中
      const other = mkSession({ id: 'R2', toolCalls: writeCall('c2', '/proj/b.txt') })
      const hit = await approve(b, other, { callId: 'c2', toolName: 'write' })
      assert.equal(hit.res, 'allowed-once')
    } finally { await b.close() }
  })
})

describe('POST /agent-api/host-approval-rule：fork 会话是独立主会话（v1.12.4 阻断）', () => {
  it('fork + callId → 写到 fork 自己的键，源会话不被静默放行', async () => {
    const b = await boot()
    try {
      const fork = mkSession({ id: 'fork-1', parentSession: 'R', fork: true, toolCalls: writeCall('cf', '/proj/x.txt') })
      await approve(b, fork, { callId: 'cf', toolName: 'write' })
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'fork-1', callId: 'cf', toolName: 'write' })
      assert.equal(status, 200)
      assert.equal(json.rootSessionId, 'fork-1', 'fork 被解析成了源会话（旧实现只看 parentSession）')

      // 用户从未在源会话 R 点过任何东西 → R 的同类请求必须仍然弹窗
      const src = mkSession({ id: 'R', toolCalls: writeCall('cr', '/proj/y.txt') })
      const r = await approve(b, src, { callId: 'cr', toolName: 'write' })
      assert.equal(r.nextCalled, true, 'fork 里的授权写到了源会话键上 → R 被静默放行')
      assert.notEqual(r.res, 'allowed-once')

      // fork 自己后续命中
      const f2 = await approve(b, fork, { callId: 'cf', toolName: 'write' })
      assert.equal(f2.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('fork dispose 清掉自己的键；已 dispose 的 fork 不再留下无人清理的键', async () => {
    const b = await boot()
    try {
      const fork = mkSession({ id: 'fork-1', parentSession: 'R', fork: true, toolCalls: writeCall('cf', '/proj/x.txt') })
      await approve(b, fork, { callId: 'cf', toolName: 'write' })
      await postRule(b, { scope: 'session', sessionId: 'fork-1', callId: 'cf', toolName: 'write' })
      // 源会话先 dispose：不该带走 fork 的键，也不该有 fork→源 的边
      b.fireEvent('session/disposed', { id: 'R' })
      const still = await approve(b, fork, { callId: 'cf', toolName: 'write' })
      assert.equal(still.res, 'allowed-once', '源会话 dispose 不该清掉 fork 自己的授权')
      b.fireEvent('session/disposed', { id: 'fork-1' })
      const gone = await approve(b, fork, { callId: 'cf', toolName: 'write' })
      assert.equal(gone.nextCalled, true, 'fork dispose 后授权必须随之失效（不留无清理路径的键）')
    } finally { await b.close() }
  })

  it('fork 派出的子代理以 fork 为根，不链回源会话', async () => {
    const b = await boot()
    try {
      const fork = mkSession({ id: 'fork-1', parentSession: 'R', fork: true })
      await approve(b, fork, { callId: null, toolName: null }) // 让注册点见到 fork（不应登记 fork→R）
      const fc = mkSession({ id: 'fc-1', parentSession: 'fork-1', toolCalls: writeCall('cc', '/proj/x.txt') })
      await approve(b, fc, { callId: 'cc', toolName: 'write' })
      const { json } = await postRule(b, { scope: 'session', sessionId: 'fc-1', callId: 'cc', toolName: 'write' })
      assert.equal(json.rootSessionId, 'fork-1')
      const src = mkSession({ id: 'R', toolCalls: writeCall('cr', '/proj/y.txt') })
      const r = await approve(b, src, { callId: 'cr', toolName: 'write' })
      assert.equal(r.nextCalled, true, 'fork 的子代理授权链回了源会话')
    } finally { await b.close() }
  })
})

describe('沙箱越权：工具名档不适用、路径级记忆重新生效（v1.12.5 用户裁定）', () => {
  // 这里跑的是用户那一趟真实动作：蓝球弹出一条 bash 越权 → 点「本会话总是允许该工具」
  // → POST 的 scope==='session' 分支**同时**写下工具名授权与会话路径规则
  // （index.js 的 addToolGrant + addSessionRule）→ 后续请求重新判定。
  // 1.12.4 的一刀切让这套写入白做（读取侧根本不看越权请求），同一路径反复弹窗；
  // v1.12.5 恢复路径档，同时必须守住「工具名授权不得替越权放行」。
  const ESC = 'escalate sandbox to read-write: need to write outside the sandbox'
  const bashCall = (callId, file) => [{ callId, name: 'bash', arguments: { command: `cat ${file}` } }]

  it('点过一次后：同一路径的越权自动放行（留痕 scope=session）、新路径的越权仍弹窗、非越权照旧吃工具名档', async () => {
    const b = await boot()
    try {
      const s1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('ce1', '/tmp/proj/a.txt') })
      // ① 第一条越权：什么都没记过 → 交给交互层
      const first = await approve(b, s1, { callId: 'ce1', toolName: 'bash', reason: ESC })
      assert.equal(first.nextCalled, true, '首条越权请求应交给交互层')

      // 用户点「本会话总是允许该工具」：FAB 的 payload 带 toolName ⇒ 两档一起写
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'ce1', toolName: 'bash' })
      assert.equal(status, 200)
      assert.equal(json.rootSessionId, 'R')

      // ② 同一路径的越权 → 放行，且放行必须来自**路径档**
      const same = await approve(b, s1, { callId: 'ce1', toolName: 'bash', reason: ESC })
      assert.equal(same.res, 'allowed-once', '路径级记忆对越权没重新生效（仍是 1.12.4 的一刀切）')
      assert.equal(same.nextCalled, false)
      const escRow = logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'auto-grant').at(-1)
      assert.equal(escRow.scope, 'session', '越权的放行被工具名档解释了——用户裁定工具名档不适用于越权')

      // ③ 换一条没记过的路径的越权 → 仍然弹窗：根键上的 bash 工具名授权不得替它放行
      const s2 = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('ce2', '/tmp/elsewhere/x.txt') })
      const fresh = await approve(b, s2, { callId: 'ce2', toolName: 'bash', reason: ESC })
      assert.equal(fresh.nextCalled, true, '越权吃了根键上的工具名授权（新路径也放行了）')
      assert.notEqual(fresh.res, 'allowed-once')

      // ④ 同一份授权、同一条新路径，只把 reason 换回非越权 → 工具名档照旧放行
      const plain = await approve(b, s2, { callId: 'ce2', toolName: 'bash', reason: 'tool requires approval' })
      assert.equal(plain.res, 'allowed-once', '非越权请求的行为被这次改动带偏了')
      assert.equal(plain.nextCalled, false)
      const toolRow = logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'auto-grant').at(-1)
      assert.equal(toolRow.scope, 'session-tool', '非越权的放行应当来自工具名档（与 ② 形成对照）')
    } finally { await b.close() }
  })

  it('越权 + POST 不带 toolName：服务端从工具调用记录**补出**工具名（v1.12.6 m2 改名）', async () => {
    // 用例名旧版写着「缺工具名 ⇒ 服务端只写路径规则」——**与事实不符**：
    // index.js 的 `toolName = body?.toolName || approvalCtx?.toolName` 会按 callId
    // 从工具调用记录把工具名补出来，所以这一档实际写下的仍是「工具名 + 路径」两档。
    // 真正的「只写路径规则」需要服务端也补不出工具名，见下面那一条新用例。
    const b = await boot()
    try {
      const s1 = mkSession({ id: 'R', toolCalls: bashCall('ce1', '/tmp/proj/a.txt') })
      await approve(b, s1, { callId: 'ce1', toolName: 'bash', reason: ESC })
      // POST 不带 toolName —— 服务端仍会补
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'ce1' })
      assert.equal(status, 200)
      assert.equal(json.toolName, 'bash', 'm2：服务端从工具调用记录补出了工具名，响应必须如实回显')
      const again = await approve(b, s1, { callId: 'ce1', toolName: 'bash', reason: ESC })
      assert.equal(again.res, 'allowed-once', '只有路径规则时，越权也该被路径级记忆覆盖')
      // 补出的工具名授权**照样落库**：换一个完全不同目录的非越权 bash 由工具名档放行。
      // （这正是旧用例名会误导后人的地方——它以为这一档没写工具名。）
      const s3 = mkSession({ id: 'R', toolCalls: bashCall('ce3', '/tmp/elsewhere-y/z.txt') })
      const offDir = await approve(b, s3, { callId: 'ce3', toolName: 'bash', reason: 'tool requires approval' })
      assert.equal(offDir.res, 'allowed-once', '补出的工具名授权没生效（这一档其实两档都写）')
      const toolRow = logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'auto-grant').at(-1)
      assert.equal(toolRow.scope, 'session-tool')
      // 越权本身仍不吃工具名档（不变量①）
      const escOther = await approve(b, s3, { callId: 'ce3', toolName: 'bash', reason: ESC })
      assert.equal(escOther.nextCalled, true, '越权吃了补出来的工具名授权')

      // ACP 孪生走的是另一条早退门：**同一个根会话键**下路径规则明明覆盖得到它，
      // 它仍然必须弹窗——早退门排在所有档位之前（v1.11.4 语义完全不变）。
      // 刻意用同一个会话 id：换成别的键，这条断言就测不出「早退门被挪到路径档之后」。
      const acp = mkSession({
        id: 'R', toolCalls: [{ callId: 'ca', name: 'product_submit', arguments: { file_path: '/tmp/proj/a.txt' } }],
      })
      const twin = await approve(b, acp, { callId: 'ca', toolName: 'product_submit', reason: '[ACP qoder] 请求权限：submit' })
      assert.equal(twin.nextCalled, true, 'ACP 孪生的早退门不再先于路径档了')
      assert.notEqual(twin.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('服务端**补不出**工具名时才是「只写路径规则」那一档（v1.12.6 m2 新增覆盖）', async () => {
    // 上面那条证明了「POST 不带 toolName」并不等于「只写路径规则」。要真的落到
    // 那一档，必须工具调用记录本身没有可用的 name（resolveApprovalContext 的
    // rec.name 为空 → resolvedToolName 保持 null）⇒ 端点写不出工具名授权，
    // 只剩路径规则。这一档的行为必须单独钉住：它**不该**有任何工具名放行。
    const noNameCall = (callId, cmd) => [{ callId, name: '', arguments: { command: cmd } }]
    const b = await boot()
    try {
      const s1 = mkSession({ id: 'R', toolCalls: noNameCall('cn1', 'cat /tmp/dad-m2/alpha/a.txt') })
      await approve(b, s1, { callId: 'cn1', reason: ESC })
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'cn1' })
      assert.equal(status, 200)
      assert.equal(json.toolName, null, '前置条件：服务端确实补不出工具名（否则本用例在测上一档）')

      const again = await approve(b, s1, { callId: 'cn1', reason: ESC })
      assert.equal(again.res, 'allowed-once', '路径规则没生效')
      const row = logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'auto-grant').at(-1)
      assert.equal(row.scope, 'session', '命中档位必须是会话路径档')

      // 反证「顺带写出了工具名授权」：换一个**完全不同目录**、同样解析不出工具名的
      // **非越权**请求 ⇒ 两档都不该命中 ⇒ 必须仍然弹窗。
      const s2 = mkSession({ id: 'R', toolCalls: noNameCall('cn2', 'cat /tmp/dad-m2-beta/b.txt') })
      const other = await approve(b, s2, { callId: 'cn2', reason: 'tool requires approval' })
      assert.equal(other.nextCalled, true, '「只写路径规则」那一档实际写出了工具名授权')
      assert.notEqual(other.res, 'allowed-once')
    } finally { await b.close() }
  })
})

describe('沙箱越权不得写落盘项目白名单（v1.12.5 二次裁定：只允许会话档）', () => {
  // 用户口径：同一主代理会话内同一路径不再弹，但**新会话仍要问**——不允许把
  // 「某路径可以被提权到 danger-full-access」静默落盘长期留存。
  // 端点侧的落盘写入点只有一个（index.js 的 appendProjectRule），且它只能在
  // scope==='project' 分支到达；这里用真实临时 DSH_HOME（harness 已注入）断言
  // allowlist.json 的**存在性与字节内容**，不碰用户 ~/.dsh。
  const ESC = 'escalate sandbox to read-write: need to write outside the sandbox'
  const bashCall = (callId, file) => [{ callId, name: 'bash', arguments: { command: `cat ${file}` } }]
  const allowlist = (home) => path.join(home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')
  const allowlistSha = (home) => (existsSync(allowlist(home)) ? createHash('sha256').update(readFileSync(allowlist(home))).digest('hex') : '<absent>')
  const allowlistRules = (home) => (existsSync(allowlist(home)) ? JSON.parse(readFileSync(allowlist(home), 'utf8')).rules : [])

  it('越权点「总是允许(项目)」：不落盘、只写会话路径规则，同会话第二次不再弹、换会话仍弹', async () => {
    const b = await boot()
    try {
      const s1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('ce1', '/tmp/proj/a.txt') })
      assert.equal((await approve(b, s1, { callId: 'ce1', toolName: 'bash', reason: ESC })).nextCalled, true)

      const { status, json } = await postRule(b, { scope: 'project', sessionId: 'child-1', callId: 'ce1', toolName: 'bash' })
      assert.equal(status, 200, '越权的项目档 POST 不该被拒（用户点了就得有等效的会话内记忆）')
      // 落盘证据排在响应字段之前：放开落盘的变异要在「文件被创建了」这条上转红，
      // 而不是先在响应字段上转红（响应只是披露，文件才是事实）。
      assert.equal(existsSync(allowlist(b.home)), false, '越权的项目档 POST 仍然落盘了')
      assert.equal(allowlistSha(b.home), '<absent>')
      assert.deepEqual(allowlistRules(b.home), [])
      // 响应必须如实报生效档位，不能照着用户点的标签回 'project'
      assert.equal(json.scope, 'session', '响应谎报档位：写下去的其实是会话规则')
      assert.equal(json.projectSuppressed, true, '响应没披露项目档被抑制')

      // ② 会话内记忆生效：同一路径的越权第二次自动放行，且来自路径档
      const again = await approve(b, s1, { callId: 'ce1', toolName: 'bash', reason: ESC })
      assert.equal(again.res, 'allowed-once', '降级写入的会话规则没被判定侧读到（键不一致）')
      const row = logRows(b.home).filter((r) => r.kind === 'host-approval').at(-1)
      assert.equal(row.action, 'auto-grant')
      assert.equal(row.scope, 'session')

      // ③ 换会话（另一个根）同路径越权 → 仍要问：没有任何跨会话留存
      const s2 = mkSession({ id: 'child-9', parentSession: 'R2', toolCalls: bashCall('ce9', '/tmp/proj/a.txt') })
      const otherRoot = await approve(b, s2, { callId: 'ce9', toolName: 'bash', reason: ESC })
      assert.equal(otherRoot.nextCalled, true, '越权的项目档抑制不彻底：后续会话被静默放行了')
      assert.notEqual(otherRoot.res, 'allowed-once')

      // ④ 同一根下、路径之外的**非越权**请求也不能因此被放行：
      // scope==='project' 分支从来只写路径规则，越权降级后同样不该写出工具名授权
      const s3 = mkSession({ id: 'child-3', parentSession: 'R', toolCalls: bashCall('ce3', '/tmp/elsewhere/y.txt') })
      const off = await approve(b, s3, { callId: 'ce3', toolName: 'bash', reason: 'tool requires approval' })
      assert.equal(off.nextCalled, true, '项目档 POST 被降级时顺带写出了工具名授权')
    } finally { await b.close() }
  })

  it('已有项目白名单条目时，越权的项目档 POST 让落盘文件逐字节不变', async () => {
    const b = await boot()
    try {
      // 先用一条**非越权**请求正常落盘（这条同时也是回归守卫：正常路径仍能写文件）
      const w = mkSession({ id: 'R', toolCalls: writeCall('w1', '/tmp/proj/base.txt') })
      await approve(b, w, { callId: 'w1', toolName: 'write' })
      const okPost = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'w1', toolName: 'write' })
      assert.equal(okPost.status, 200)
      assert.equal(okPost.json.scope, 'project')
      assert.equal(existsSync(allowlist(b.home)), true, '非越权的项目档连文件都不建，回归守卫先失败')
      const before = allowlistRules(b.home).length
      const shaBefore = allowlistSha(b.home)

      // 再来一条越权，点同一个按钮 → 文件必须一个字节都不动
      const e = mkSession({ id: 'R', toolCalls: bashCall('ce1', '/tmp/proj/a.txt') })
      await approve(b, e, { callId: 'ce1', toolName: 'bash', reason: ESC })
      const escPost = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'ce1', toolName: 'bash' })
      // 事实优先：先断言文件一个字节没动，再断言响应的披露
      assert.equal(allowlistSha(b.home), shaBefore, '越权的项目档 POST 改动了落盘白名单内容')
      assert.equal(allowlistRules(b.home).length, before, '越权的项目档 POST 追加了条目')
      assert.equal(escPost.status, 200)
      assert.equal(escPost.json.scope, 'session')
    } finally { await b.close() }
  })

  it('非越权请求的落盘行为与 1.12.4 一致：项目档写文件、跨会话放行；同一条规则不替越权放行', async () => {
    const b = await boot()
    try {
      const s1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: writeCall('c1', '/tmp/proj/a.txt') })
      await approve(b, s1, { callId: 'c1', toolName: 'write' })
      const { status, json } = await postRule(b, { scope: 'project', sessionId: 'child-1', callId: 'c1', toolName: 'write' })
      assert.equal(status, 200)
      assert.equal(json.scope, 'project', '非越权的项目档 POST 被误抑制了（超出裁定范围）')
      assert.equal(json.projectSuppressed, undefined)
      const rules = allowlistRules(b.home)
      assert.equal(rules.length, 1)
      assert.equal(rules[0].cwd, '/home/test', '落盘条目的 cwd 不对，跨会话命中无从谈起')
      assert.ok(rules[0].paths.includes('/tmp/proj/a.txt'))

      // 跨会话：换一个根、同样 cwd、同一条路径，非越权请求必须由项目档放行
      const s2 = mkSession({ id: 'child-8', parentSession: 'R8', toolCalls: writeCall('c8', '/tmp/proj/a.txt') })
      const nextSession = await approve(b, s2, { callId: 'c8', toolName: 'write' })
      assert.equal(nextSession.res, 'allowed-once', '落盘项目档不再跨会话生效——正常路径的持久白名单被本轮改动废掉了')
      const projRow = logRows(b.home).filter((r) => r.action === 'auto-grant').at(-1)
      assert.equal(projRow.scope, 'project')

      // 同一条落盘规则对越权不算数（读取侧的 sessionOnly）
      const e = mkSession({ id: 'child-8', parentSession: 'R8', toolCalls: bashCall('ce8', '/tmp/proj/a.txt') })
      const esc = await approve(b, e, { callId: 'ce8', toolName: 'bash', reason: ESC })
      assert.equal(esc.nextCalled, true, '越权被跨会话的项目白名单放行了（读取侧没抑制）')
      assert.notEqual(esc.res, 'allowed-once')
    } finally { await b.close() }
  })
})

describe('B1（阻断项）：写侧落盘抑制只认沙箱越权，ACP 孪生恢复 1.12.4 的落盘行为', () => {
  // 1.12.5 把写侧判据写成了 isDisallowedAutoGrant（= 越权 **或** ACP 孪生），于是
  // ACP 孪生点「总是允许(项目)」也被降级成会话档、allowlist.json 根本不创建——
  // 用户口径只要求「越权」受限，ACP 是「完全绕过、不要动它」。
  // 本 describe 是这条写侧通道的**第一批**端点级覆盖（终审实测 1.12.5 写侧零测试覆盖）。
  const ESC = 'escalate sandbox to read-write: need to write outside the sandbox'
  const bashCall = (callId, file) => [{ callId, name: 'bash', arguments: { command: `cat ${file}` } }]
  const allowlist = (home) => path.join(home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')
  const allowlistRules = (home) => (existsSync(allowlist(home)) ? JSON.parse(readFileSync(allowlist(home), 'utf8')).rules : [])
  // grantedAt 是时间戳，比较 1.12.4 等价性时要摘掉；其余字段必须逐字相同
  const stripTime = (rules) => rules.map((r) => ({ cwd: r.cwd, paths: r.paths, note: r.note, product: r.product ?? null }))

  it('ACP 孪生 POST scope=project ⇒ allowlist.json 被创建，条目与非 ACP 请求逐字等价（1.12.4 行为）', async () => {
    // 对照组：同样一条路径，走**普通 write** 请求落盘
    const control = await boot()
    let acpRules = null
    try {
      const w = mkSession({ id: 'R', toolCalls: writeCall('w1', '/tmp/dad-b1/alpha/a.txt') })
      await approve(control, w, { callId: 'w1', toolName: 'write' })
      const cPost = await postRule(control, { scope: 'project', sessionId: 'R', callId: 'w1' })
      assert.equal(cPost.status, 200)
      assert.equal(cPost.json.scope, 'project')

      // 实验组：ACP 孪生（toolName=product_submit + reason 以 [ACP  开头）
      const b = await boot()
      try {
        const acp = mkSession({
          id: 'R',
          toolCalls: [{ callId: 'ca', name: 'product_submit', arguments: { file_path: '/tmp/dad-b1/alpha/a.txt' } }],
        })
        // 读取侧不变量②：孪生仍完全绕过（早退门排在所有档位之前）
        const first = await approve(b, acp, { callId: 'ca', toolName: 'product_submit', reason: '[ACP qoder] 请求权限：submit' })
        assert.equal(first.nextCalled, true, 'B1 修复把 ACP 孪生的读取侧早退门也动了')

        const { status, json } = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'ca' })
        assert.equal(status, 200, 'ACP 孪生的项目档 POST 仍被当成越权拒了/降级了')
        // 事实优先：先断文件，再断响应披露（文件才是事实，响应只是披露）
        assert.equal(existsSync(allowlist(b.home)), true, 'ACP 孪生点「总是允许(项目)」仍然不落盘（1.12.5 的 B1 缺陷）')
        assert.equal(json.scope, 'project', '响应谎报档位：把 ACP 的项目档也报成了 session')
        assert.equal(json.projectSuppressed, undefined, '响应仍给 ACP 孪生打了 projectSuppressed')
        assert.equal(
          (logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'rule-downgraded')).length,
          0,
          'ACP 孪生被降级并留下 rule-downgraded 留痕（同源 Minor：日志会在 ACP 场景打出「越权」字样）',
        )
        acpRules = stripTime(allowlistRules(b.home))
      } finally { await b.close() }
      const controlRules = stripTime(allowlistRules(control.home))
      assert.deepEqual(acpRules, controlRules, 'ACP 孪生的落盘条目与 1.12.4（非 ACP 请求）不等价')
      assert.equal(acpRules.length, 1)
      assert.ok(acpRules[0].paths.includes('/tmp/dad-b1/alpha/a.txt'))
      // 目录级粒度（M1）：文件条目连带其直接父目录
      assert.ok(acpRules[0].paths.includes('/tmp/dad-b1/alpha'), '落盘条目没补直接父目录（M1 目录级语义）')
    } finally { await control.close() }
  })

  it('沙箱越权 POST scope=project ⇒ 仍然不落盘，只写会话档 + 如实披露（B1 的另一半）', async () => {
    const b = await boot()
    try {
      const w = mkSession({ id: 'R', toolCalls: writeCall('w1', '/tmp/dad-b1/base.txt') })
      await approve(b, w, { callId: 'w1', toolName: 'write' })
      await postRule(b, { scope: 'project', sessionId: 'R', callId: 'w1' })
      const shaBefore = existsSync(allowlist(b.home)) ? createHash('sha256').update(readFileSync(allowlist(b.home))).digest('hex') : '<absent>'
      const bytesBefore = existsSync(allowlist(b.home)) ? readFileSync(allowlist(b.home)).length : -1

      const e = mkSession({ id: 'R', toolCalls: bashCall('ce1', '/tmp/dad-b1/alpha/a.txt') })
      await approve(b, e, { callId: 'ce1', toolName: 'bash', reason: ESC })
      const { status, json } = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'ce1' })
      assert.equal(status, 200)
      assert.equal(
        createHash('sha256').update(readFileSync(allowlist(b.home))).digest('hex'),
        shaBefore,
        'B1 修复把越权的落盘也放开了（判据收得太宽）',
      )
      assert.equal(readFileSync(allowlist(b.home)).length, bytesBefore, '落盘文件字节数变了')
      assert.equal(json.scope, 'session')
      assert.equal(json.projectSuppressed, true)

      const rows = logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'rule-downgraded')
      assert.equal(rows.length, 1, '越权降级没有留痕')
      // 同源 Minor：文案与判据一致——只有真越权才会打印「越权」
      assert.match(rows[0].message, /沙箱越权/, `降级日志文案没写明判据（实际: ${rows[0].message}）`)
      assert.match(rows[0].message, /isSandboxEscalation/, `降级日志没标判据（实际: ${rows[0].message}）`)

      // 会话档确实写到了：同路径的越权第二次不再弹（不变量①的后半）
      const again = await approve(b, e, { callId: 'ce1', toolName: 'bash', reason: ESC })
      assert.equal(again.res, 'allowed-once', '降级写入的会话规则没被判定侧读到')
    } finally { await b.close() }
  })
})

describe('M1：路径级记忆的粒度是**目录**（含直接父目录），不是单个文件', () => {
  // 用户明确定的统一模型：「把文件路径提取为上一级目录，指定路径往后的一切工具调用都放行」。
  // 机制：addSessionRule → expandPathsWithParents（lib/host-approval.js）补直接父目录，
  // pathAllowed 再按目录前缀匹配。终审实测过（/tmp/p7/alpha/a.txt 授权后 b.txt 直接放行），
  // 本 describe 把这条语义**钉死**，免得后来人当成漏口去"修"。
  const ESC = 'escalate sandbox to read-write: need to write outside the sandbox'
  const bashCall = (callId, file) => [{ callId, name: 'bash', arguments: { command: `cat ${file}` } }]

  it('点一次会话档后：同目录兄弟路径不再弹；换目录仍要问', async () => {
    const b = await boot()
    try {
      const s1 = mkSession({ id: 'R', toolCalls: bashCall('c1', '/tmp/dad-m1/alpha/a.txt') })
      assert.equal((await approve(b, s1, { callId: 'c1', toolName: 'bash', reason: ESC })).nextCalled, true)
      assert.equal((await postRule(b, { scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'bash' })).status, 200)

      // ① 同目录的**另一个文件**：越权 ⇒ 目录级记忆覆盖得到 ⇒ 不再弹
      const sib = mkSession({ id: 'R', toolCalls: bashCall('c2', '/tmp/dad-m1/alpha/b.txt') })
      const hit = await approve(b, sib, { callId: 'c2', toolName: 'bash', reason: ESC })
      assert.equal(hit.res, 'allowed-once', '目录级粒度被改成了文件级（M1 语义）')
      const hitRow = logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'auto-grant').at(-1)
      assert.equal(hitRow.scope, 'session', '兄弟路径的放行必须来自会话**路径**档，不是工具名档（不变量①）')

      // ② 子目录（目录前缀语义：/tmp/dad-m1/alpha 覆盖其下任意层级）
      const nested = mkSession({ id: 'R', toolCalls: bashCall('c3', '/tmp/dad-m1/alpha/deep/c.txt') })
      assert.equal((await approve(b, nested, { callId: 'c3', toolName: 'bash', reason: ESC })).res, 'allowed-once')

      // ③ **换目录**（兄弟目录）⇒ 仍要问：记忆不外溢到同级其他目录
      const sibDir = mkSession({ id: 'R', toolCalls: bashCall('c4', '/tmp/dad-m1/beta/x.txt') })
      const miss = await approve(b, sibDir, { callId: 'c4', toolName: 'bash', reason: ESC })
      assert.equal(miss.nextCalled, true, '目录级粒度外溢到了兄弟目录')
      assert.notEqual(miss.res, 'allowed-once')
    } finally { await b.close() }
  })
})

describe('U2（v1.12.6）：body.paths 三态——声明是用户意志，服务端只校验不改写', () => {
  // 契约（与 product-subagents 0.7.9 planGrantWrites 同口径，两侧必须对齐）：
  //   · 未给（非数组）⇒ 老客户端 ⇒ 完全沿用服务端自动分析，行为逐字不变（不变量⑦）；
  //   · 给了且校验后非空 ⇒ **只写路径档**，且用户声明的已是目录 ⇒ 不补父目录、不写工具名档；
  //   · 给了且为空（[] 或全部被校验丢弃）⇒ **只写工具名档**，一条路径都不写。
  // 「不信任客户端」在这一版的具体含义：接受声明，但① 逐条校验、② 必须挂在一次
  // 能反查到 reason 的真实审批上（否则判不出是不是越权，不能盲落盘）。
  const ESC = 'escalate sandbox to read-write: need to write outside the sandbox'
  const bashCall = (callId, file) => [{ callId, name: 'bash', arguments: { command: `cat ${file}` } }]
  const allowlist = (home) => path.join(home, 'data', 'dsh-plugin-product-subagents', 'allowlist.json')
  const grantRows = (home, action) =>
    logRows(home).filter((r) => r.kind === 'host-approval' && (!action || r.action === action))

  it('未给 paths ⇒ 走服务端自动分析：工具名档 + 路径档一起写（老客户端零漂移）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', '/tmp/dad-u2-legacy/alpha/a.txt') })
      assert.equal((await approve(b, s, { callId: 'c1', toolName: 'bash' })).nextCalled, true)
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'bash' })
      assert.equal(status, 200)
      assert.equal(json.pathsSource, undefined, '没声明 paths 时不得声称来源是 user')
      assert.deepEqual(json.paths, ['/tmp/dad-u2-legacy/alpha/a.txt'], '自动分析的路径必须原样回显')

      // 工具名档生效 ⇒ **换目录**也放行（对照下面 declared 那条：声明了目录就不该有这个待遇）
      const other = mkSession({ id: 'R', toolCalls: bashCall('c2', '/tmp/dad-u2-legacy/elsewhere/x.txt') })
      const hit = await approve(b, other, { callId: 'c2', toolName: 'bash' })
      assert.equal(hit.res, 'allowed-once')
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'session-tool')
    } finally { await b.close() }
  })

  it('声明非空 ⇒ 只写路径档：换目录仍要问（既不补父目录、也不写工具名档）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', '/tmp/dad-u2-dir/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash' })
      const { status, json } = await postRule(b, {
        scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'bash', paths: ['/tmp/dad-u2-dir/alpha'],
      })
      assert.equal(status, 200)
      assert.equal(json.pathsSource, 'user', '必须披露这条规则来自用户声明')
      assert.deepEqual(json.paths, ['/tmp/dad-u2-dir/alpha'])
      assert.deepEqual(json.dropped, [])

      // ① 声明目录之下（含兄弟文件、更深子目录）⇒ 目录级覆盖 ⇒ 放行，且来自路径档
      const sib = mkSession({ id: 'R', toolCalls: bashCall('c2', '/tmp/dad-u2-dir/alpha/b.txt') })
      assert.equal((await approve(b, sib, { callId: 'c2', toolName: 'bash' })).res, 'allowed-once')
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'session', '放行来自工具名档 ⇒ 声明档没被当作路径档')
      const deep = mkSession({ id: 'R', toolCalls: bashCall('c3', '/tmp/dad-u2-dir/alpha/deep/c.txt') })
      assert.equal((await approve(b, deep, { callId: 'c3', toolName: 'bash' })).res, 'allowed-once')

      // ② 兄弟目录 ⇒ 仍要问。这一条同时钉住两件事：
      //    没写工具名档（否则该工具任意路径都放行）、没补父目录（否则 /tmp/dad-u2-dir 被放大，
      //    1.12.5 现场就出过 /tmp/newproj ⇒ /tmp 的放大事故）
      const sibDir = mkSession({ id: 'R', toolCalls: bashCall('c4', '/tmp/dad-u2-dir/beta/x.txt') })
      const miss = await approve(b, sibDir, { callId: 'c4', toolName: 'bash' })
      assert.equal(miss.nextCalled, true, '用户声明的目录被服务端放大了（补了父目录或写了工具名档）')
      assert.notEqual(miss.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('声明为空数组 ⇒ 只写工具名档：一条路径都不落，同工具任意路径放行', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', '/tmp/dad-u2-empty/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash' })
      const { status, json } = await postRule(b, {
        scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'bash', paths: [],
      })
      assert.equal(status, 200)
      assert.deepEqual(json.paths, [], '空声明不得被回退成服务端自动分析的那几条路径')
      assert.equal(json.pathsSource, 'user')
      assert.equal(json.count, 1, '只写了工具名档（集合大小 1），路径规则应为 0 条')

      const far = mkSession({ id: 'R', toolCalls: bashCall('c2', '/tmp/dad-u2-empty/unrelated/x.txt') })
      assert.equal((await approve(b, far, { callId: 'c2', toolName: 'bash' })).res, 'allowed-once')
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'session-tool')
      // 转红实验②「paths 为空时照样写路径」的靶子：这里额外钉一次"路径档是空的"
      assert.equal(json.count, 1)
    } finally { await b.close() }
  })

  it('空声明 + scope=project ⇒ 不落盘，档位如实回 session 并披露 toolOnly', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', '/tmp/dad-u2-toolonly/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash' })
      const { status, json } = await postRule(b, {
        scope: 'project', sessionId: 'R', callId: 'c1', paths: [], cwd: '/tmp/dad-u2-toolonly',
      })
      assert.equal(status, 200)
      assert.equal(existsSync(allowlist(b.home)), false, '删空路径却落盘了项目白名单')
      assert.equal(json.scope, 'session', '项目档没落盘却回 scope=project')
      assert.equal(json.toolOnly, true)
      assert.equal(json.projectSuppressed, undefined, 'toolOnly 不是越权抑制，两个标记不能混用')
      assert.equal(grantRows(b.home, 'rule-tool-only').length, 1, '删空 ⇒ 只写工具名档要留痕')
    } finally { await b.close() }
  })

  it('非法声明逐条丢弃并披露；**有一条合法的照旧 200**（部分非法≠全非法）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', '/tmp/dad-u2-bad/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash' })
      const { status, json } = await postRule(b, {
        scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'bash',
        paths: ['relative/dir', 42, '', '   ', '/', '/tmp//dad-u2-bad/alpha/', 'a\nb', '/tmp/dad-u2-bad/alpha', '/tmp/dad\x00u2/x'],
      })
      assert.equal(status, 200)
      assert.deepEqual(json.paths, ['/tmp/dad-u2-bad/alpha'], '只保留合法绝对目录，且归一末尾斜杠')
      const reasons = json.dropped.map((d) => d.reason)
      assert.equal(json.dropped.length, 7, `非法条目应丢弃 7 条，实际 ${json.dropped.length}`)
      for (const want of ['非字符串', '空字符串', '含 NUL', '含换行', '非绝对路径', '根目录']) {
        assert.ok(reasons.includes(want), `丢弃原因里没有「${want}」：${reasons.join('/')}`)
      }
      // 末尾斜杠归一后与已保留的那条重复 ⇒ 去重而不是写两遍
      const hit = mkSession({ id: 'R', toolCalls: bashCall('c2', '/tmp/dad-u2-bad/alpha/deep/x.txt') })
      assert.equal((await approve(b, hit, { callId: 'c2', toolName: 'bash' })).res, 'allowed-once')
    } finally { await b.close() }
  })

  // ── v1.12.6 第五轮（终审 M-B）────────────────────────────────────────
  // 改前的现场（终审端点级原始输出）：`paths: ['./x.txt']` ⇒ 200 + 「路径声明为空 ⇒
  // 只写工具名档」⇒ `toolGrant(read)` ⇒ 随后对**完全另一个文件** `/etc/passwd` 的 read
  // 直接 `allowed-once`。用户以为只授权了 `./x.txt`，实际拿到的是**整个工具**。
  // 判据：**给了路径但一条都不合法**（dropped 非空）≠ **真删空**（`paths: []`，dropped 为空）。
  // 前者 400 且**什么档都不写**；后者保持「只写工具名档」的既有语义。
  it('M-B①：paths 全非法（非绝对路径/根目录）⇒ 400 且不写任何档，尤其是不得落工具名档', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: writeCall('m1', '/tmp/dad-mb/x.txt') })
      assert.equal((await approve(b, s, { callId: 'm1', toolName: 'read' })).nextCalled, true, '前置：首次请求应交给交互层')
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'm1', toolName: 'read', paths: ['./x.txt'] })
      assert.equal(status, 400, '全非法声明被接受 ⇒ 会静默退化成工具名档（M-B 的放大路径）')
      assert.match(json.error, /绝对路径/, '400 的文案要说清原因（可读）')
      assert.ok(Array.isArray(json.dropped) && json.dropped.length === 1 && json.dropped[0].reason === '非绝对路径',
        '400 必须带上逐条丢弃原因，用户才知道该改哪一条')
      // 会话档：**一条都没有**（工具名档、路径档都没有）
      const rows = grantRows(b.home)
      assert.equal(rows.filter((r) => r.action === 'auto-grant' || r.action === 'rule-tool-only').length, 0,
        '400 却写了规则（会话档/工具名档任一条）')
      assert.equal(rows.filter((r) => r.action === 'rule-rejected-all-paths-dropped').length, 1,
        '拒写要留痕（排障要能看出「声明被整体拒绝」而不是「用户没声明」）')
      // 端到端：**另一个文件**的 read 必须仍然弹窗（改前这里是 allowed-once = 放大到整个工具）
      const other = mkSession({ id: 'R', toolCalls: [{ callId: 'm2', name: 'read', arguments: { file_path: '/etc/passwd' } }] })
      const after = await approve(b, other, { callId: 'm2', toolName: 'read' })
      assert.equal(after.nextCalled, true, '全非法声明之后，read 被工具名档放行了 ⇒ 授权被放大到整个工具（M-B 复发）')
      assert.notEqual(after.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('M-B②：真删空（paths: []，dropped 为空）⇒ 仍只写工具名档（既有语义，必须保持）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: writeCall('m1', '/tmp/dad-mb2/a.txt') })
      await approve(b, s, { callId: 'm1', toolName: 'read' })
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'm1', toolName: 'read', paths: [] })
      assert.equal(status, 200, '真删空被 400 了 ⇒ 把「弹框删空 ⇒ 工具档」这条既有语义一起改掉了')
      assert.deepEqual(json.paths, [])
      assert.deepEqual(json.dropped, [], '真删空时 dropped 必须是空的（这正是与「全非法」可分的判据）')
      assert.equal(json.count, 1, '删空 ⇒ 只写工具名档（集合大小 1）')
      assert.equal(grantRows(b.home).filter((r) => r.action === 'rule-tool-only').length, 1)
      const far = mkSession({ id: 'R', toolCalls: [{ callId: 'm2', name: 'read', arguments: { file_path: '/anywhere/else.txt' } }] })
      assert.equal((await approve(b, far, { callId: 'm2', toolName: 'read' })).res, 'allowed-once')
    } finally { await b.close() }
  })

  it('M-B③：合法绝对路径照旧只写路径档（不得被 400 分支误伤）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: writeCall('m1', '/tmp/dad-mb3/alpha/a.txt') })
      await approve(b, s, { callId: 'm1', toolName: 'read' })
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'R', callId: 'm1', toolName: 'read', paths: ['/tmp/dad-mb3/alpha'] })
      assert.equal(status, 200)
      assert.deepEqual(json.paths, ['/tmp/dad-mb3/alpha'])
      assert.deepEqual(json.dropped, [])
      const sib = mkSession({ id: 'R', toolCalls: [{ callId: 'm2', name: 'read', arguments: { file_path: '/tmp/dad-mb3/alpha/b.txt' } }] })
      assert.equal((await approve(b, sib, { callId: 'm2', toolName: 'read' })).res, 'allowed-once')
      // 换目录仍要问（没写工具名档、没补父目录）
      const away = mkSession({ id: 'R', toolCalls: [{ callId: 'm3', name: 'read', arguments: { file_path: '/tmp/dad-mb3/beta/x.txt' } }] })
      const miss = await approve(b, away, { callId: 'm3', toolName: 'read' })
      assert.equal(miss.nextCalled, true, '合法声明被放大（补了父目录或写了工具名档）')
    } finally { await b.close() }
  })

  it('M-B④：混合声明（有合法也有非法）⇒ 200，只写合法那条（不因存在非法条目就整体拒）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: writeCall('m1', '/tmp/dad-mb4/alpha/a.txt') })
      await approve(b, s, { callId: 'm1', toolName: 'read' })
      const { status, json } = await postRule(b, {
        scope: 'session', sessionId: 'R', callId: 'm1', toolName: 'read',
        paths: ['./x.txt', '/tmp/dad-mb4/alpha'],
      })
      assert.equal(status, 200, '有合法条目时不得整体拒')
      assert.deepEqual(json.paths, ['/tmp/dad-mb4/alpha'])
      assert.equal(json.dropped.length, 1)
      assert.equal(json.dropped[0].reason, '非绝对路径')
    } finally { await b.close() }
  })

  it('带 paths 却反查不到审批上下文 ⇒ 400 且不落盘：判不出是不是越权就不能盲写', async () => {
    const b = await boot()
    try {
      const { status, json } = await postRule(b, {
        scope: 'project', sessionId: 'R', cwd: '/tmp/dad-u2-blind', paths: ['/tmp/dad-u2-blind'],
      })
      assert.equal(status, 400, '没有 approvalCtx 也照样接受了用户声明 ⇒ 任意目录可被写进落盘白名单')
      assert.match(json.error, /callId/)
      assert.equal(existsSync(allowlist(b.home)), false)

      // callId 有，但那一次审批没进过 approval/request（上下文未暂存）⇒ 同样拒
      const ghost = await postRule(b, { scope: 'project', sessionId: 'R', callId: 'ghost', paths: ['/tmp/dad-u2-blind'] })
      assert.equal(ghost.status, 400)
      assert.equal(existsSync(allowlist(b.home)), false)
    } finally { await b.close() }
  })

  it('越权 + 声明目录 + scope=project ⇒ 不落盘，降级写会话档并覆盖同目录兄弟', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', '/tmp/dad-u2-esc/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash', reason: ESC })
      const { status, json } = await postRule(b, {
        scope: 'project', sessionId: 'R', callId: 'c1', paths: ['/tmp/dad-u2-esc/alpha'], cwd: '/tmp/dad-u2-esc',
      })
      assert.equal(status, 200)
      assert.equal(existsSync(allowlist(b.home)), false, '越权的声明目录被落盘了（B1 收窄后又放宽）')
      assert.equal(json.scope, 'session')
      assert.equal(json.projectSuppressed, true)
      assert.equal(json.pathsSource, 'user')

      const sib = mkSession({ id: 'R', toolCalls: bashCall('c2', '/tmp/dad-u2-esc/alpha/b.txt') })
      const hit = await approve(b, sib, { callId: 'c2', toolName: 'bash', reason: ESC })
      assert.equal(hit.res, 'allowed-once', '声明的目录没覆盖到兄弟路径')
      assert.equal(grantRows(b.home, 'auto-grant').at(-1).scope, 'session')
    } finally { await b.close() }
  })

  it('越权 + 删空声明 ⇒ 只写工具名档，但读取侧仍不走那一档（不变量①）', async () => {
    const b = await boot()
    try {
      const s = mkSession({ id: 'R', toolCalls: bashCall('c1', '/tmp/dad-u2-esc2/alpha/a.txt') })
      await approve(b, s, { callId: 'c1', toolName: 'bash', reason: ESC })
      const { status } = await postRule(b, {
        scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'bash', paths: [],
      })
      assert.equal(status, 200, '越权请求删空后被拒（工具名档写不出去）')
      const again = mkSession({ id: 'R', toolCalls: bashCall('c2', '/tmp/dad-u2-esc2/alpha/a.txt') })
      const res = await approve(b, again, { callId: 'c2', toolName: 'bash', reason: ESC })
      assert.equal(res.nextCalled, true, '越权请求吃了工具名档短路 ⇒ 不变量①破了')
      assert.notEqual(res.res, 'allowed-once')
    } finally { await b.close() }
  })
})

describe('U2（v1.12.6）契约透传：/agent-api/permission-decision 的 paths 三态', () => {
  const decision = (b, body) => b.req('POST', '/agent-api/permission-decision', body)

  it('未给 paths ⇒ 转发的载荷里根本没有该键（产品侧走自己的自动分析）', async () => {
    const b = await boot()
    try {
      const { status } = await decision(b, { childId: 'child-1', permId: 'p1', answer: 'allow-session' })
      assert.equal(status, 200)
      const payload = b.emitted.filter((e) => e.name === 'product-subagents/permission-decision').at(-1).payload
      assert.equal('paths' in payload, false, '键存在但值为 undefined ⇒ 产品侧会把它当成"给了空数组"')
      assert.equal(payload.pathsCount, undefined)
    } finally { await b.close() }
  })

  it('给了非空 / 空数组 ⇒ 原样转发并回显 pathsCount（本插件不校验不改写）', async () => {
    const b = await boot()
    try {
      const withPaths = await decision(b, {
        childId: 'child-1', permId: 'p1', answer: 'allow-always', paths: ['/tmp/a', '/tmp/b'],
      })
      assert.equal(withPaths.status, 200)
      assert.equal(withPaths.json.pathsCount, 2)
      assert.deepEqual(b.emitted.filter((e) => e.name === 'product-subagents/permission-decision').at(-1).payload.paths, ['/tmp/a', '/tmp/b'])

      const empty = await decision(b, { childId: 'child-2', permId: 'p2', answer: 'allow-session', paths: [] })
      assert.equal(empty.json.pathsCount, 0, '空数组是"只要工具名"的显式声明，必须照发')
      const sent = b.emitted.filter((e) => e.name === 'product-subagents/permission-decision').at(-1).payload
      assert.deepEqual(sent.paths, [])
      assert.equal(sent.permId, 'p2')

      // 非法 answer 仍被拒（新增载荷不能绕过入参门）
      assert.equal((await decision(b, { childId: 'child-3', answer: 'allow-everything', paths: ['/'] })).status, 400)
    } finally { await b.close() }
  })

  it('事件总线故障 ⇒ 409，且不会因为 paths 把错误吞掉', async () => {
    const b = await boot()
    try {
      b.setEmitThrows(true)
      const { status, json } = await decision(b, { childId: 'child-1', answer: 'allow-session', paths: ['/tmp/a'] })
      assert.equal(status, 409)
      assert.match(json.error, /事件总线/)
    } finally { await b.close() }
  })
})

describe('审批留痕落盘（v1.12.4：console 之外进决策日志）', () => {
  it('自动放行写 kind:host-approval 观测行，且不进历史页', async () => {
    const b = await boot()
    try {
      const root = mkSession({ id: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      await approve(b, root, { callId: 'c1', toolName: 'write' })
      await postRule(b, { scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'write' })
      await approve(b, root, { callId: 'c1', toolName: 'write' })
      const rows = logRows(b.home).filter((r) => r.kind === 'host-approval')
      assert.ok(rows.length >= 1, '自动放行未留痕')
      assert.equal(rows.at(-1).action, 'auto-grant')
      assert.equal(rows.at(-1).scope, 'session-tool')
      assert.equal(rows.at(-1).rootSessionId, 'R')
      const { json } = await b.req('GET', '/agent-api/dispatches')
      assert.ok(!json.dispatches.some((r) => r.kind === 'host-approval'), '观测行不是一次委派，不该出现在历史页')
    } finally { await b.close() }
  })

  it('路径规则命中的留痕：scope=session，且**不写完整 paths 数组**（v1.12.4 用户裁决）', async () => {
    const b = await boot()
    try {
      const root = mkSession({ id: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      await approve(b, root, { callId: 'c1', toolName: 'write' })
      await postRule(b, { scope: 'session', sessionId: 'R', callId: 'c1', toolName: 'write' })
      // 换一个未授权的工具名 → 工具名短路不命中，落到「本会话路径规则」档
      const r = await approve(b, root, { callId: 'c1', toolName: 'other-tool' })
      assert.equal(r.res, 'allowed-once')
      const hit = logRows(b.home)
        .filter((x) => x.kind === 'host-approval' && x.action === 'auto-grant').at(-1)
      assert.ok(hit, '路径规则命中未留痕')
      assert.equal(hit.scope, 'session')
      assert.equal(hit.tool, 'other-tool')
      assert.equal(hit.rootSessionId, 'R')
      assert.equal(hit.sessionId, 'R')
      assert.equal(hit.pathCount, 1)
      assert.equal('paths' in hit, false, '留痕行不得带完整 paths 数组')
    } finally { await b.close() }
  })

  it('会话 dispose 清理到东西时留痕 purge 行（含 isRoot / childMappings）', async () => {
    const b = await boot()
    try {
      const child = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: writeCall('c1', '/proj/a.txt') })
      await approve(b, child, { callId: 'c1', toolName: 'write' })
      await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'c1', toolName: 'write' })
      b.fireEvent('session/disposed', { id: 'R' }) // 根会话 dispose：清工具名授权 + 子会话映射
      const purges = logRows(b.home).filter((r) => r.kind === 'host-approval' && r.action === 'purge')
      assert.equal(purges.length, 1, '根会话 dispose 应留且只留一条 purge 行')
      assert.equal(purges[0].isRoot, true)
      assert.equal(purges[0].hadGrants, true)
      assert.equal(purges[0].childMappings, 1)
    } finally { await b.close() }
  })
})
