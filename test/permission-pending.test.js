// v1.11.14（A）：授权球"每请求一条"回归测试。
// 现场缺陷：同一子代理并发 2 条 ACP 权限授权时，编排层按 childId 单槽折叠，
// 用户点一次黄球只消掉一条，剩下那条从蓝球（宿主弹窗孪生）再次冒出来。
// 这里覆盖编排层（externalPending / entry.permissionPending）与 REST 序列化，
// 产品侧状态机见 dsh-plugin-product-subagents/test/permission-state.test.js，
// 前端孪生闸门见 test/acp-twin.test.js。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Dispatcher, serializePermissionPending } from '../lib/dispatch.js'

const registry = { get: (id) => ({ id, name: '资深开发（中坚）' }) }

function boot() {
  const injected = []
  const ctx = {
    subagents: { interrupt: () => {} },
    get: () => undefined,
    emit: () => {},
    on: () => () => {},
    // #notifyParent 走 sessions/agents，取不到时只落日志——测试里不关心注入文案
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    __injected: injected,
  }
  const d = new Dispatcher({ ctx, registry, dataDir: '/tmp/ad-perm-test', idleReleaseMs: 0 })
  return d
}

function activeEntry(childId) {
  return {
    childId,
    agentId: 'dev',
    parentSessionId: 'parent-1',
    session: { id: childId },
    startedAt: 1,
    taskLabel: '做点事',
  }
}

const pending = (childId, permId, description) => ({
  childId, permId, product: 'qoder', description, paths: [], at: Date.now(),
})

describe('A 编排层待授权表：每请求一条', () => {
  it('本插件派遣的子代理：并发 2 条 → 2 条挂起，决议一条不清空另一条', () => {
    const d = boot()
    const entry = activeEntry('child-A')
    d.activeChildren.set('child-A', entry)

    d.markPermissionPending(pending('child-A', 'tc-1#1', 'Allow reading files?'))
    d.markPermissionPending(pending('child-A', 'tc-2#2', 'Allow searching the web?'))
    assert.ok(Array.isArray(entry.permissionPending), '标记应为数组')
    assert.equal(entry.permissionPending.length, 2, '旧实现在这里只剩 1 条')
    assert.deepEqual(entry.permissionPending.map((r) => r.permId), ['tc-1#1', 'tc-2#2'])

    d.markPermissionResolved({ childId: 'child-A', permId: 'tc-1#1', outcome: 'allowed-once' })
    assert.equal(entry.permissionPending.length, 1)
    assert.deepEqual(entry.permissionPending.map((r) => r.permId), ['tc-2#2'], '被决议那条摘掉，另一条必须留下')

    d.markPermissionResolved({ childId: 'child-A', permId: 'tc-2#2', outcome: 'granted-session' })
    assert.equal(entry.permissionPending, null, '全部决议后才清标记')
  })

  it('外部子代理（product_delegate 等）：externalPending 同样逐条', () => {
    const d = boot()
    d.markPermissionPending(pending('ext-1', 'a#1', 'A'))
    d.markPermissionPending(pending('ext-1', 'b#2', 'B'))
    assert.equal(d.externalPending.get('ext-1').length, 2)

    d.markPermissionResolved({ childId: 'ext-1', permId: 'b#2', outcome: 'allowed-once' })
    assert.deepEqual(d.externalPending.get('ext-1').map((r) => r.permId), ['a#1'])

    d.markPermissionResolved({ childId: 'ext-1', permId: 'a#1', outcome: 'rejected' })
    assert.equal(d.externalPending.has('ext-1'), false, '清空后整个键删除')
  })

  it('不同 childId 互不干扰', () => {
    const d = boot()
    d.markPermissionPending(pending('child-A', 'x#1', 'A'))
    d.markPermissionPending(pending('child-B', 'x#1', 'B'))
    assert.equal(d.externalPending.get('child-A').length, 1)
    assert.equal(d.externalPending.get('child-B').length, 1)
    d.markPermissionResolved({ childId: 'child-A', permId: 'x#1' })
    assert.equal(d.externalPending.has('child-A'), false)
    assert.equal(d.externalPending.get('child-B').length, 1)
  })

  it('同 permId 重发（产品重试同一 toolCall）→ 就地更新不堆重复行', () => {
    const d = boot()
    const entry = activeEntry('child-A')
    d.activeChildren.set('child-A', entry)
    d.markPermissionPending(pending('child-A', 'tc#1', '旧描述'))
    d.markPermissionPending(pending('child-A', 'tc#1', '新描述'))
    assert.equal(entry.permissionPending.length, 1)
    assert.equal(entry.permissionPending[0].description, '新描述')
  })

  it('老 payload 无 permId → 合成键兜底，两条请求不塌成一条（不崩、不静默丢）', () => {
    const d = boot()
    const entry = activeEntry('child-A')
    d.activeChildren.set('child-A', entry)
    d.markPermissionPending({ childId: 'child-A', product: 'deveco', description: 'R1' })
    d.markPermissionPending({ childId: 'child-A', product: 'deveco', description: 'R2' })
    assert.equal(entry.permissionPending.length, 2)
    assert.ok(entry.permissionPending.every((r) => typeof r.permId === 'string' && r.permId), '必须补齐可用 id')
    // 老决议事件也不带 permId → FIFO 摘最早一条，与登记顺序天然对齐
    d.markPermissionResolved({ childId: 'child-A', outcome: 'allowed-once' })
    assert.deepEqual(entry.permissionPending.map((r) => r.description), ['R2'])
    d.markPermissionResolved({ childId: 'child-A', outcome: 'denied' })
    assert.equal(entry.permissionPending, null)
  })

  it('无 childId / 未知 childId 的脏事件不炸', () => {
    const d = boot()
    d.markPermissionPending(null)
    d.markPermissionPending({})
    d.markPermissionResolved({ childId: 'ghost', permId: 'nope' })
    assert.equal(d.externalPending.size, 0)
  })

  it('onChildEnd 整组清理（未终结请求不得残留授权球）', () => {
    const d = boot()
    d.markPermissionPending(pending('ext-9', 'p#1', 'A'))
    d.markPermissionPending(pending('ext-9', 'p#2', 'B'))
    d.onChildEnd('ext-9', 'completed', null)
    assert.equal(d.externalPending.has('ext-9'), false)
  })
})

describe('A /agent-api/active 的 permissionPending 序列化（新老客户端双写）', () => {
  it('数组 → permissionPending=最早未决那条（旧字段形态），permissionPendingList=全量', () => {
    const out = serializePermissionPending([
      { permId: 'a#1', product: 'qoder', description: 'R1', paths: ['/x'], at: 10 },
      { permId: 'b#2', product: 'qoder', description: 'R2', category: 'qoder:web_search', at: 20 },
    ])
    assert.equal(out.permissionPending.permId, 'a#1')
    assert.equal(out.permissionPending.description, 'R1')
    assert.equal(out.permissionPendingList.length, 2)
    assert.equal(out.permissionPendingList[1].category, 'qoder:web_search')
    assert.deepEqual(out.permissionPendingList[0].paths, ['/x'])
  })

  it('旧形态（单对象）/ null / 空数组都降级可用', () => {
    const legacy = serializePermissionPending({ product: 'deveco', description: 'R', at: 1 })
    assert.equal(legacy.permissionPending.description, 'R')
    assert.equal(legacy.permissionPending.permId, null)
    assert.equal(legacy.permissionPendingList.length, 1)
    assert.deepEqual(serializePermissionPending(null), { permissionPending: null, permissionPendingList: [] })
    assert.deepEqual(serializePermissionPending([]), { permissionPending: null, permissionPendingList: [] })
    assert.deepEqual(serializePermissionPending(undefined).permissionPendingList, [])
  })

  it('序列化结果可 JSON 化（Map/Set 不得漏进 REST 响应）', () => {
    const out = serializePermissionPending([{ permId: 'a#1', description: 'R', at: 1 }])
    assert.deepEqual(JSON.parse(JSON.stringify(out)).permissionPendingList[0].description, 'R')
  })
})
