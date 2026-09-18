/**
 * v1.11.11 回归测试：定向续聊（childId）在【池外线程】上不再抛 TDZ
 *
 *   现场缺陷：`const reuseKey` 声明在 v1.5.0 复用段（函数体后部），而 v1.5.3 的
 *   定向续聊分支在【池外线程】路径（reuse:'fresh' 建的孩子 / 进程重启后池被清空 /
 *   被 LRU 淘汰 / completedFresh 历史线程）上用它拼池键，于是抛
 *     ReferenceError: Cannot access 'reuseKey' before initialization
 *   此时 sendMessage 其实已经投递成功，却被当成"续聊失败"上报 → 主代理改判
 *   "继续不了" 而新开子代理（用户观感：追加任务不再续聊、凭空多一个子代理，
 *   同一任务在两个线程里重复执行）。
 *
 *   本测试用最小假宿主（ctx.subagents）驱动真实 Dispatcher，不依赖任何产品可用性。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../lib/dispatch.js'

function makeHarness({ sendMessage } = {}) {
  const sent = []
  const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 } }
  const ctx = {
    subagents: {
      getProvider: () => undefined,
      startContinuable: async () => ({ childId: 'child-new' }),
      sendMessage: sendMessage ?? (async (sender, targetId, content) => {
        sent.push({ sender, targetId, content })
        return 'msg-1'
      }),
      drainChildren: async () => {},
      interrupt: () => {},
    },
    get: () => undefined,
    emit: () => {},
  }
  const registry = {
    get: (id) => ({ id, name: '资深开发（中坚）', reusePolicy: 'reuse' }),
    resolveRoutes: () => [],
  }
  const dispatcher = new Dispatcher({
    ctx,
    registry,
    dataDir: mkdtempSync(join(tmpdir(), 'dispatch-childid-test-')),
    idleReleaseMs: 0,
  })
  return { dispatcher, sent, parentAgent }
}

function seedPool(dispatcher, childId) {
  dispatcher.childPool.set(`parent-1::senior-dev::${childId}`, {
    key: `parent-1::senior-dev::${childId}`,
    childId,
    agentId: 'senior-dev',
    parentSessionId: 'parent-1',
    provider: null,
    acpMode: false,
    lastUsedAt: Date.now(),
    releaseTimer: null,
    lastTasks: ['上一个任务'],
    viaSquad: null,
    squadRunId: null,
    keep: false,
  })
}

describe('v1.11.11 定向续聊（childId）回归', () => {
  it('池外线程定向续聊应成功，并补记池条目（旧实现报 Cannot access \'reuseKey\'）', async () => {
    const { dispatcher, sent, parentAgent } = makeHarness()
    const r = await dispatcher.dispatch(parentAgent, 'senior-dev', '追加任务：继续上一个线程', {
      childId: 'external-child',
    })
    assert.equal(r.ok, true)
    assert.equal(r.childId, 'external-child', '应续聊到指定 child，而不是新开')
    assert.equal(sent.length, 1, 'sendMessage 应投递一次')
    assert.equal(sent[0].targetId, 'external-child')
    assert.ok(
      dispatcher.childPool.has('parent-1::senior-dev::external-child'),
      '池外线程续聊后应补记池条目，使后续 auto 复用也能命中',
    )
  })

  it('池内线程定向续聊仍正常（对照，不应重复建池条目）', async () => {
    const { dispatcher, sent, parentAgent } = makeHarness()
    seedPool(dispatcher, 'pooled-child')
    const r = await dispatcher.dispatch(parentAgent, 'senior-dev', '继续：同一线程第二步', {
      childId: 'pooled-child',
    })
    assert.equal(r.ok, true)
    assert.equal(r.childId, 'pooled-child')
    assert.equal(sent.length, 1)
    assert.equal(dispatcher.childPool.size, 1)
  })

  it('只有【投递失败】才算续聊失败（保留原报错引导）', async () => {
    const failing = async () => {
      throw new Error('UNAUTHORIZED: message delivery requires the exact live sender agent')
    }
    const { dispatcher, sent, parentAgent } = makeHarness({ sendMessage: failing })
    await assert.rejects(
      () => dispatcher.dispatch(parentAgent, 'senior-dev', '追加任务', { childId: 'other-child' }),
      /续聊指定子代理 other-child 失败：UNAUTHORIZED/,
    )
    assert.equal(sent.length, 0)
  })
})
