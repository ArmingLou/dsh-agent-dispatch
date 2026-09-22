// test/session-source-v4.test.js — v1.11.13 宿主 session format v4：插件注入父会话的消息 source 必须是 producer-owned
// 运行：node --test test/session-source-v4.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../lib/dispatch.js'

// ── 故障背景（真实报错，非推测） ──
// DSH 0.1.7-alpha.1 起 session log 为 format v4。宿主
// @deepseek-ai/dsh-session-format-v3-to-v4 的 assertV4SourceRowAdmission 对
// `source.kind === 'plugin'`（V3 的插件包装形态）**硬拒**：
//     SessionFormatError: format v4 message requires a producer-owned source kind
// Agent.inject 的签名是同步 `inject(message: UserMessage): void`，当场不报错——
// 坏 source 要等下一轮把 inbox 消息 splice 进会话、逐行落盘校验时才炸，于是用户
// 看到的是「ACP 子代理请求授权之后，主代理继续聊天本轮必失败」：一条装饰性通知
// 打死了整轮。v4 给第三方生产者的标识是 `plugin:<包名>`，与 v3→v4 迁移改写
// `{kind:'plugin',plugin:'<包名>'}` 的结果逐字一致。

/** 宿主 v4 准入对 source.kind 的判定（同 assertV4SourceRowAdmission → source()）。 */
const hostV4AdmitsKind = (kind) => typeof kind === 'string' && kind.length > 0 && kind !== 'plugin'

function makeHarness({ parentPresent = true } = {}) {
  const injected = []
  const parentAgent = { session: { id: 'parent-1' }, inject: (message) => injected.push(message) }
  const ctx = {
    get: (name) => (name === 'agents'
      ? { get: (id) => (parentPresent && id === 'parent-1' ? parentAgent : undefined) }
      : undefined),
    emit: () => {},
  }
  const registry = { get: (id) => ({ id, name: '资深开发（中坚）' }) }
  const dispatcher = new Dispatcher({
    ctx,
    registry,
    dataDir: mkdtempSync(join(tmpdir(), 'dispatch-v4-source-')),
    idleReleaseMs: 0,
  })
  dispatcher.activeChildren.set('child-1', {
    childId: 'child-1',
    agentId: 'simple-dev',
    parentSessionId: 'parent-1',
    provider: 'qoder',
  })
  return { dispatcher, injected }
}

/** 走一遍「ACP 权限挂起 → 通知父会话」的公开入口（四个 #notifyParent 调用点里最常命中的一个）。 */
function pendingOnce(harness) {
  harness.dispatcher.markPermissionPending({
    childId: 'child-1',
    product: 'qoder',
    description: '读取 /tmp/x',
    at: Date.now(),
  })
}

describe('父会话注入消息的 source（format v4 准入）', () => {
  it('ACP 权限挂起通知：kind 是 producer-owned，不是 V3 的 plugin 包装', () => {
    const harness = makeHarness()
    pendingOnce(harness)
    assert.equal(harness.injected.length, 1, '应当向父会话注入一条提示')
    const message = harness.injected[0]
    assert.equal(message.role, 'user', '注入形态是 user 消息（仿 createUserMessage）')
    assert.ok(Array.isArray(message.content) && message.content[0]?.type === 'text', 'content 是 text 块')
    assert.equal(typeof message.id, 'string')
    assert.ok(message.source, 'v4 要求每条消息带 source')
    assert.ok(
      hostV4AdmitsKind(message.source.kind),
      `source.kind 必须是 producer-owned，实际 ${JSON.stringify(message.source)}`,
    )
    assert.equal(
      message.source.kind,
      'plugin:dsh-agent-dispatch',
      'v3→v4 迁移对旧 {kind:plugin,plugin:<包名>} 的改写结果就是 plugin:<包名>，这里必须逐字对齐',
    )
    assert.equal(
      Object.hasOwn(message.source, 'plugin'),
      false,
      'v4 已删除 plugin 字段：生产者身份由 kind 自己承载',
    )
  })

  it('宿主真实准入闸门接受该消息（能解析到 dsh 包时额外跑一遍）', async (t) => {
    let gate
    try {
      gate = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
    } catch {
      t.diagnostic('未安装 @deepseek-ai/dsh-session-format-v3-to-v4（插件仓库自身无 node_modules），跳过宿主闸门校验')
      return
    }
    const harness = makeHarness()
    pendingOnce(harness)
    // user/message 的 data 即消息本身；agent/inbox/spliced 走同一条 assertV4SourceRowAdmission。
    const row = { type: 'user/message', seq: 1, data: harness.injected[0] }
    assert.doesNotThrow(() => gate.assertV4RowAdmission(row, new Set()))
  })

  it('旧形态对照：kind:plugin + plugin 字段确实被宿主拒绝（证明测试真的在测这条规则）', async (t) => {
    let gate
    try {
      gate = await import('@deepseek-ai/dsh-session-format-v3-to-v4')
    } catch {
      t.diagnostic('未安装宿主包，跳过；hostV4AdmitsKind 已在本文件内固化了同一条规则')
      assert.equal(hostV4AdmitsKind('plugin'), false)
      return
    }
    const row = {
      type: 'user/message',
      seq: 1,
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'plugin', plugin: 'dsh-agent-dispatch' } },
    }
    assert.throws(() => gate.assertV4RowAdmission(row, new Set()), /producer-owned source kind/)
  })

  it('父会话不可达时静默返回：不抛错、不 inject', () => {
    const harness = makeHarness({ parentPresent: false })
    assert.doesNotThrow(() => pendingOnce(harness))
    assert.equal(harness.injected.length, 0)
  })

  it('回归护栏：源码里不得再出现 V3 的 kind:plugin 包装字面量', () => {
    const source = readFileSync(new URL('../lib/dispatch.js', import.meta.url), 'utf8')
    assert.equal(
      /source:\s*\{\s*kind:\s*['"]plugin['"]/.test(source),
      false,
      "v4 硬拒 source.kind === 'plugin'（format v4 message requires a producer-owned source kind）",
    )
  })
})
