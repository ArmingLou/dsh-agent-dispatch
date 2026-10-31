// v1.12.22【H6】：宿主审批的「工作区默认档」——工作区内非高危请求不再弹窗。
//
// 现场（决定性反例）：一条命令的「请求实际触达目录」三条**全部**落在会话工作区
// （`<ws>`、`<ws>/test/…`、`<ws>/{`），按 DSH `workspace-write` 语义与本插件
// 在 product-subagents 侧已有的 workspace 规则都该直接放行，**但它弹了**。
//
// 取证：这类请求进的是本插件的 approval/request 监听器（`toolName` 是真实工具名
// `Bash`，不是 ACP 孪生的 `product_submit`），而 `HostApprovalRules.decide()`
// （lib/host-approval.js）只有四档：session-tool / project-tool / session / project，
// **没有 workspace 档**。于是"工作区内、非高危、无任何手工规则"的请求必然落到
// `next()`（交宿主面板）。
//
// 本文件钉死三件事：
//   W1 工作区内、非高危 ⇒ 自动放行（不发面板）；
//   W2 含工作区外路径 ⇒ 仍然交交互（不得因为"大部分在工作区"就放行）；
//   W3 高危（rm -rf / git push）⇒ 仍然交交互（危险门排在档位之前）；
//   W4 工作区内的**假路径**（`<ws>/{`、`<ws>/undefined`）不得单独把请求顶成弹窗；
//   W5 对照：ACP 孪生仍走早退门（本插件的档位一条都不判）。
import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { boot, mkSession } from './agent-api-harness.js'

// v1.12.23（Minor 1）：工作区不再硬编码 `/Users/arming/...` —— 换台机器/换 checkout
// 路径就该照跑。用 mkdtempSync 造一个**真实存在**的工作区根（`workspaceCovers` 的
// 判据是"路径子树"，不依赖文件是否在盘上；但根目录真实存在更贴近生产）。
const WS = mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-tier-'))
mkdirSync(path.join(WS, 'test'), { recursive: true })
writeFileSync(path.join(WS, 'package.json'), '{}\n')
writeFileSync(path.join(WS, 'x.txt'), 'x\n')
after(() => rmSync(WS, { recursive: true, force: true }))

/** 驱动真实 approval/request 监听器：res='allowed-once' 即本插件自动放行 */
async function approve(b, session, { callId = null, toolName = null, reason = 'tool requires approval' } = {}) {
  let nextCalled = false
  const outs = b.fireEvent('approval/request', { agent: { session }, callId, toolName, reason }, () => {
    nextCalled = true
    return 'NEXT'
  })
  const res = await outs[0]
  return { res, nextCalled }
}

/** 内层工具名 + 一段带路径的命令（宿主 approval 的真实形态） */
const bashCall = (callId, command) => [{ callId, name: 'Bash', arguments: { command } }]

describe('W1 工作区内、非高危 ⇒ 自动放行', () => {
  it('toolName=Bash + 路径全部落在 session cwd 子树 ⇒ allowed-once，不交交互', async () => {
    const b = await boot()
    try {
      const callId = 'w1'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `node --test ${path.join(WS, 'test', 'host-approval-endpoint.test.js')}`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, false, '工作区内的普通 Bash 请求仍被交给宿主面板（= 现场"每条命令都弹"）')
      assert.equal(r.res, 'allowed-once')
      const rows = b.emitted
      assert.ok(rows.length >= 0)
    } finally { await b.close() }
  })

  it('工作区根自身（无任何子路径）同样放行', async () => {
    const b = await boot()
    try {
      const callId = 'w2'
      const s = mkSession({ id: 'S1', cwd: WS, toolCalls: bashCall(callId, `ls ${WS}`) })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, false)
      assert.equal(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('W4 工作区内的假路径（`<ws>/{`）不得顶成弹窗', async () => {
    // 单条命令：多命令拼接会先被"形状闸门"拦下（见 W6），那是另一条判据，
    // 这条只验"假路径落在工作区内不算越界"。
    const b = await boot()
    try {
      const callId = 'w4'
      const s = mkSession({ id: 'S1', cwd: WS, toolCalls: bashCall(callId, `echo x > ${path.join(WS, '{')}`) })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, false, '落在工作区内的假路径仍然把请求顶成了弹窗')
      assert.equal(r.res, 'allowed-once')
    } finally { await b.close() }
  })
})

describe('W2/W3 边界：工作区外与高危仍然必须交互', () => {
  it('W2 任一路径在工作区外 ⇒ 交交互（不半覆盖放行）', async () => {
    const b = await boot()
    try {
      const callId = 'w5'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `cat ${path.join(WS, 'package.json')} /Users/arming/.ssh/id_rsa`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '含工作区外路径的请求被工作区档放行了')
      assert.notEqual(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('W3 工作区内 rm -rf ⇒ 仍交交互（危险门排在档位之前）', async () => {
    const b = await boot()
    try {
      const callId = 'w6'
      const s = mkSession({ id: 'S1', cwd: WS, toolCalls: bashCall(callId, `rm -rf ${path.join(WS, 'scratch')}`) })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '工作区内的 rm -rf 被自动放行了')
      const danger = b.emitted.filter((e) => e && e.name === 'approval/log')
      // 归因只作辅助（不同宿主版本日志事件名不同），主判据是 nextCalled
      assert.ok(Array.isArray(danger))
    } finally { await b.close() }
  })

  it('W3c 工作区内 sudo bash -c 包着 rm -rf ⇒ 仍交交互（包装 + shell 剥壳）', async () => {
    const b = await boot()
    try {
      const callId = 'w9'
      const s = mkSession({ id: 'S1', cwd: WS, toolCalls: bashCall(callId, `sudo bash -c 'rm -rf ${path.join(WS, 'scratch')}'`) })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, 'sudo bash -c 包着的 rm -rf 被放行了')
    } finally { await b.close() }
  })

  it('W3d 工作区内 npm publish ⇒ 仍交交互', async () => {
    const b = await boot()
    try {
      const callId = 'w10'
      const s = mkSession({ id: 'S1', cwd: WS, toolCalls: bashCall(callId, 'npm publish --access public') })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, 'npm publish 被放行了')
    } finally { await b.close() }
  })

  it('W6 多命令拼接（工作区内路径）⇒ fail-closed 交交互', async () => {
    const b = await boot()
    try {
      const callId = 'w11'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `cd ${WS} && node --test ${path.join(WS, 'test', 'host-approval-endpoint.test.js')}`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '`cd … && …` 拼接被工作区档放行了（形状闸门失效）')
    } finally { await b.close() }
  })

  it('W6b 命令替换 `$(…)` ⇒ fail-closed 交交互', async () => {
    const b = await boot()
    try {
      const callId = 'w12'
      const s = mkSession({ id: 'S1', cwd: WS, toolCalls: bashCall(callId, `echo $(cat ${path.join(WS, 'package.json')})`) })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '命令替换被工作区档放行了')
    } finally { await b.close() }
  })

  it('W6c 管道到解释器 `… | sh` ⇒ fail-closed 交交互', async () => {
    const b = await boot()
    try {
      const callId = 'w13'
      const s = mkSession({ id: 'S1', cwd: WS, toolCalls: bashCall(callId, `cat ${path.join(WS, 'deploy.sh')} | sh`) })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '管道到解释器被工作区档放行了')
    } finally { await b.close() }
  })

  it('W3b 工作区内 git push ⇒ 仍交交互', async () => {
    const b = await boot()
    try {
      const callId = 'w7'
      const s = mkSession({ id: 'S1', cwd: WS, toolCalls: bashCall(callId, 'git push origin main') })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '工作区内的 git push 被自动放行了')
    } finally { await b.close() }
  })
})

describe('W5 对照：ACP 孪生仍走早退门（本插件一档都不判）', () => {
  it('product_submit + `[ACP ` 前缀 ⇒ 仍然 next()（不被工作区档截胡）', async () => {
    const b = await boot()
    try {
      const callId = 'w8'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: [{ callId, name: 'product_submit', arguments: { task: '跑测试' } }],
      })
      const r = await approve(b, s, { callId, toolName: 'product_submit', reason: '[ACP qoder] 请求权限：执行命令' })
      assert.equal(r.nextCalled, true, '孪生早退门被工作区档破坏了（ACP 侧的判定不该被本插件截断）')
      assert.equal(r.res, 'NEXT')
    } finally { await b.close() }
  })
})

// ────────────────────────────────────────────────────────────────────────────
// v1.12.23【B3 阻塞修复】：`PATH_RE` 看不见的两类路径 —— 相对越界 / 变量展开
//
// 根因（终审已用真实链路复现）：`PATH_RE`（lib/host-approval.js:330）只匹配**绝对**
// 路径前缀，`workspaceCovers` 又只看已提取路径。于是
//   `cat <ws>/package.json ../../.ssh/id_rsa`
//   `cat <ws>/x.txt ${HOME}/.ssh/id_rsa`
// 的第二个操作数**从未进入 paths** ⇒ 路径集只剩工作区内那条 ⇒ covered ⇒ AUTO-ALLOW。
// 修法：在 `WORKSPACE_TIER_UNSAFE_RULES` 增加 `relative-traversal` / `variable-expansion`
// 两条形状闸门（与 command-substitution 同机制）：判不了就不猜，跳过工作区档转人工。
// ────────────────────────────────────────────────────────────────────────────
describe('W7 相对越界 / 变量展开 ⇒ 跳过工作区档（B3）', () => {
  it('W7a `cat <ws>/package.json ../../.ssh/id_rsa` ⇒ 仍交交互', async () => {
    const b = await boot()
    try {
      const callId = 'b3a'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `cat ${path.join(WS, 'package.json')} ../../.ssh/id_rsa`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '相对越界操作数被 `PATH_RE` 漏掉后仍被工作区档放行（B3 未修）')
      assert.notEqual(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('W7b `cat <ws>/x.txt ${HOME}/.ssh/id_rsa` ⇒ 仍交交互', async () => {
    const b = await boot()
    try {
      const callId = 'b3b'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `cat ${path.join(WS, 'x.txt')} ${'$'}{HOME}/.ssh/id_rsa`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '`$VAR` 展开的操作数被工作区档放行了（B3 未修）')
      assert.notEqual(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('W7c `<` 重定向到越界路径：`cat <ws>/x.txt<../../.ssh/id_rsa` ⇒ 仍交交互', async () => {
    const b = await boot()
    try {
      const callId = 'b3c'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `cat ${path.join(WS, 'x.txt')}<../../.ssh/id_rsa`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '`<` 重定向的越界操作数被工作区档放行了（前置字符类缺 <>）')
      assert.notEqual(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('W7d `>` 重定向到越界路径：`cat <ws>/x.txt>../../.ssh/id_rsa` ⇒ 仍交交互', async () => {
    const b = await boot()
    try {
      const callId = 'b3d'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `cat ${path.join(WS, 'x.txt')}>../../.ssh/id_rsa`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, true, '`>` 重定向的越界操作数被工作区档放行了（前置字符类缺 <>）')
      assert.notEqual(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('W7e 对照组：工作区内单路径仍 allowed-once（闸门不得误伤）', async () => {
    const b = await boot()
    try {
      const callId = 'b3e'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `cat ${path.join(WS, 'package.json')}`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, false, '工作区内的普通命令被新闸门误杀')
      assert.equal(r.res, 'allowed-once')
    } finally { await b.close() }
  })

  it('W7f 对照组：`ls -la <ws>/test` 仍 allowed-once', async () => {
    const b = await boot()
    try {
      const callId = 'b3f'
      const s = mkSession({
        id: 'S1',
        cwd: WS,
        toolCalls: bashCall(callId, `ls -la ${path.join(WS, 'test')}`),
      })
      const r = await approve(b, s, { callId, toolName: 'Bash' })
      assert.equal(r.nextCalled, false, '`ls -la <ws>/test` 被新闸门误杀')
      assert.equal(r.res, 'allowed-once')
    } finally { await b.close() }
  })
})
