// v1.11.14（B）：琥珀球（.ad-perm-fab）/ 蓝球（.ad-host-approval-fab）孪生去重的
// 提升闸门测试。lib/client.js 是浏览器 classic script（依赖 window/document），
// 无法 import——沿用 test/client-form-logic.test.js 的做法：把真正跑的那段源码
// 抠出来注入依赖后执行。改坏源码会因取不到/闭合不匹配而报错，改坏判定则被拦下。
//
// 现场缺陷：同一子代理并发 2 条授权时，用户点一次黄球只消掉一条，剩下那条
// 因为"琥珀消失即提升蓝球"没校验"是否已决议"而从蓝球再次冒出来。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

const START = 'const acpTwinHold = new Map()'
const END = 'acpTwinLastAmberKeys = amberKeys'
const CLOSE = '\n    }'

/** 把孪生状态段（含 nowMs / 闸门 / acpTwinSync）原样搬进可执行闭包 */
function compileTwinBlock(fakeDate) {
  const i = src.indexOf(START)
  assert.ok(i >= 0, `client.js 中找不到 "${START}"（孪生状态被改名或删除？）`)
  const j = src.indexOf(END, i)
  assert.ok(j > i, `"${START}" 之后找不到 "${END}"（同步逻辑被改写？）`)
  const k = src.indexOf(CLOSE, j)
  assert.ok(k > j, `"${END}" 之后找不到闭合 "${CLOSE.trim()}"`)
  const block = src.slice(i, k + CLOSE.length)
  // 同作用域追加导出：闸门要读的 let 状态没有别的注入办法
  const tail = [
    'return {',
    '  acpTwinSync, acpTwinPromote, acpTwinHolds, acpTwinDrop, acpTwinMarkDecided,',
    '  acpTwinHold, acpTwinDecided,',
    '  setBlueOps: (v) => { acpTwinBlueOps = v },',
    '  setLastAmber: (v) => { acpTwinLastAmberKeys = v },',
    '}',
  ].join('\n')
  return new Function('Date', `${block}\n${tail}`)(fakeDate)
}

function harness(initialNow = 1000) {
  const state = { now: initialNow }
  const fakeDate = { now: () => state.now }
  const mod = compileTwinBlock(fakeDate)
  const blue = { added: [], removed: [] }
  mod.setBlueOps({
    add: (held) => { if (held && held.item && !blue.added.includes(held.item)) blue.added.push(held.item) },
    remove: (token) => { blue.removed.push(token) },
  })
  return {
    mod,
    blue,
    advance: (ms) => { state.now += ms },
    setNow: (v) => { state.now = v },
  }
}

/** 一个蓝球孪生条目 + 其 held（字段须与 approval/request 注册处一致） */
function twin(mod, key, token, opts = {}) {
  const item = {
    toolName: 'product_submit',
    reason: '[ACP qoder] 请求权限：x',
    _settled: !!opts.settled,
    _twinKey: key,
    _twinToken: token,
  }
  const held = { item, visible: !!opts.visible, timer: null, token, createdAt: opts.createdAt ?? 1000 }
  mod.acpTwinHolds(key).add(held)
  return held
}

describe('B 蓝球孪生：同 childId 并发多条都要被跟踪', () => {
  it('hold 表按 childId 分组，2 条孪生各自成一条', () => {
    const { mod } = harness()
    twin(mod, 'child-A', 'child-A#1')
    twin(mod, 'child-A', 'child-A#2')
    assert.equal(mod.acpTwinHolds('child-A').size, 2, '旧实现只跟踪第 1 条，第 2 条被 has() 挡掉')
  })

  it('琥珀覆盖该 childId → 两条一起隐藏，且按 token 精确移除', () => {
    const { mod, blue } = harness()
    const h1 = twin(mod, 'child-A', 'child-A#1', { visible: true })
    const h2 = twin(mod, 'child-A', 'child-A#2', { visible: true })
    mod.acpTwinSync(new Set(['child-A']))
    assert.equal(h1.visible, false)
    assert.equal(h2.visible, false)
    assert.deepEqual(blue.removed, ['child-A#1', 'child-A#2'], '旧实现按 key 删除，会误删另一条')
  })
})

describe('B 提升闸门①：审批已决议不得再回到蓝球', () => {
  it('孪生条目已 _settled → 提升被拒并从挂起表摘除', () => {
    const { mod, blue } = harness()
    twin(mod, 'child-A', 'child-A#1', { settled: true })
    mod.setLastAmber(new Set(['child-A']))
    mod.acpTwinSync(new Set())
    assert.equal(blue.added.length, 0, '已决议的条目不得冒到蓝球')
    assert.equal(mod.acpTwinHold.has('child-A'), false, '应被显式摘除')
  })

  it('未决议 + 无代答记录 → 仍然提升（琥珀漏覆盖时不丢请求）', () => {
    const { mod, blue } = harness()
    const held = twin(mod, 'child-A', 'child-A#1')
    mod.setLastAmber(new Set(['child-A']))
    mod.acpTwinSync(new Set())
    assert.deepEqual(blue.added, [held.item])
    assert.equal(held.visible, true)
  })
})

describe('B 提升闸门②：琥珀球代答过就不再冒到蓝球', () => {
  it('用户点黄球 → 琥珀清空 → 该 childId 的旧孪生不得提升（现场缺陷回归）', () => {
    const { mod, blue } = harness(1000)
    twin(mod, 'child-A', 'child-A#1', { createdAt: 900 })
    mod.acpTwinSync(new Set(['child-A'])) // 琥珀覆盖中
    mod.acpTwinMarkDecided('child-A') // 用户点了黄球
    mod.setLastAmber(new Set(['child-A']))
    mod.acpTwinSync(new Set()) // 琥珀清空
    assert.equal(blue.added.length, 0, '被用户答过的那条绝不能从蓝球再冒出来')
    assert.equal(mod.acpTwinHold.has('child-A'), false)
  })

  it('两条并发只点掉一条：另一条留在琥珀时不提升，琥珀彻底清空才提升', () => {
    const { mod, blue, setNow } = harness(1000)
    const answered = twin(mod, 'child-A', 'child-A#1', { createdAt: 900 })
    const leftover = twin(mod, 'child-A', 'child-A#2', { createdAt: 950 })
    mod.acpTwinSync(new Set(['child-A']))
    setNow(2000)
    mod.acpTwinMarkDecided('child-A') // 用户点了其中一条
    // ① 琥珀仍有该 childId（另一条挂着）→ 都不提升
    mod.setLastAmber(new Set(['child-A']))
    mod.acpTwinSync(new Set(['child-A']))
    assert.deepEqual(blue.added, [])
    // ② 服务端把两条都摘了（正常路径）→ 两条都不该冒出来
    mod.setLastAmber(new Set(['child-A']))
    mod.acpTwinSync(new Set())
    assert.deepEqual(blue.added, [], '两条都早于那次代答 → 都不提升')
    assert.equal(mod.acpTwinHold.has('child-A'), false)
    void answered; void leftover
  })

  it('代答之后新到达的孪生仍要提升（不得被窗口期误杀）', () => {
    const { mod, blue } = harness(1000)
    mod.acpTwinMarkDecided('child-A') // 刚答过一条
    const fresh = twin(mod, 'child-A', 'child-A#9', { createdAt: 5000 }) // 新请求
    mod.setLastAmber(new Set(['child-A']))
    mod.acpTwinSync(new Set())
    assert.deepEqual(blue.added, [fresh.item], '晚于那次决策的请求必须可见')
  })

  it('代答记录超窗后失效（不永久抑制提升）', () => {
    const { mod, blue, advance } = harness(1000)
    const held = twin(mod, 'child-A', 'child-A#1', { createdAt: 900 })
    mod.acpTwinMarkDecided('child-A')
    advance(20001)
    mod.setLastAmber(new Set(['child-A']))
    mod.acpTwinSync(new Set())
    assert.deepEqual(blue.added, [held.item], '超过抑制窗口要恢复兜底提升')
    assert.equal(mod.acpTwinDecided.has('child-A'), false, '过期记录要清掉')
  })

  it('只影响该 childId，别的子代理照常提升', () => {
    const { mod, blue } = harness(1000)
    mod.acpTwinMarkDecided('child-A')
    const other = twin(mod, 'child-B', 'child-B#1', { createdAt: 900 })
    mod.setLastAmber(new Set(['child-B']))
    mod.acpTwinSync(new Set())
    assert.deepEqual(blue.added, [other.item])
  })
})

describe('B 摘除语义与脏输入', () => {
  it('drop 后 Set 空则删键，可见条目按 token 从蓝球移除', () => {
    const { mod, blue } = harness()
    const held = twin(mod, 'child-A', 'child-A#1', { visible: true })
    mod.acpTwinDrop('child-A', held)
    assert.equal(mod.acpTwinHold.has('child-A'), false)
    assert.deepEqual(blue.removed, ['child-A#1'])
    assert.equal(held.visible, false)
  })

  it('空快照 / 空 childId 不炸', () => {
    const { mod } = harness()
    assert.doesNotThrow(() => mod.acpTwinSync(new Set()))
    assert.doesNotThrow(() => mod.acpTwinMarkDecided(null))
    assert.equal(mod.acpTwinDecided.size, 0)
    assert.doesNotThrow(() => mod.acpTwinDrop('missing', { item: {}, visible: false, timer: null, token: 't' }))
  })
})

// ── A 黄球摊平：permRowsOf 是 client.js 里真正跑的那段，同样抠源码执行 ──
// v1.11.14(M3 计数)：它从黄球内部提到模块作用域（四处待授权显示位共用一个语义）
const ROWS_START = 'function permRowsOf(arr) {'
const ROWS_CLOSE = '\n    }'

function compilePermRows() {
  const i = src.indexOf(ROWS_START)
  assert.ok(i >= 0, `client.js 中找不到 "${ROWS_START}"（黄球摊平逻辑被改名或删除？）`)
  const j = src.indexOf(ROWS_CLOSE, i)
  assert.ok(j > i, 'permRowsOf 找不到闭合，函数体被改写')
  return new Function(`${src.slice(i, j + ROWS_CLOSE.length)}\nreturn permRowsOf`)()
}
const permRowsOf = compilePermRows()
const amberKeysOf = (rows) => new Set(rows.map((r) => String(r.childId || ''))) // 同 poll() 里的覆盖集算法

describe('A 黄球摊平：每请求一行', () => {
  it('同一 childId 的 permissionPendingList 有 2 条 → 黄球 2 行，各带自己的 permId', () => {
    const rows = permRowsOf([{
      childId: 'child-A',
      parentSessionId: 'parent-1',
      agentName: 'Qoder',
      permissionPending: { permId: 'child-A#1' },
      permissionPendingList: [
        { permId: 'child-A#1', description: '允许读取 config' },
        { permId: 'child-A#2', description: 'Allow searching the web?' },
      ],
    }])
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map((r) => r.permId), ['child-A#1', 'child-A#2'])
    assert.equal(rows[1].permissionPending.description, 'Allow searching the web?')
    assert.equal(rows[0].agentName, 'Qoder')
    assert.equal(rows[0].parentSessionId, 'parent-1')
  })

  it('老 payload（只有 permissionPending 单对象、无 permId）→ 恰好 1 行且不崩', () => {
    const rows = permRowsOf([{ childId: 'child-B', permissionPending: { description: '旧协议' } }])
    assert.equal(rows.length, 1)
    assert.equal(rows[0].permId, null, '老服务端不给 permId → 由服务端 FIFO 摘取')
    assert.equal(rows[0].permissionPending.description, '旧协议')
  })

  it('list 为空数组回落单对象；两者皆无 → 0 行；脏条目跳过', () => {
    assert.equal(permRowsOf([{ childId: 'c', permissionPendingList: [], permissionPending: { permId: 'c#1' } }]).length, 1)
    assert.equal(permRowsOf([{ childId: 'c' }]).length, 0)
    assert.equal(permRowsOf(null).length, 0)
    assert.equal(permRowsOf([null, { childId: 'c', permissionPendingList: [null, { permId: 'c#2' }] }]).length, 1)
  })
})

describe('A + B 串联：摊平结果驱动琥珀覆盖，决议一条不误提升另一条', () => {
  it('剩 1 条仍在摊平结果里 → 琥珀仍覆盖 → 蓝球不冒；全清后按代答窗口拦住', () => {
    const { mod, blue, setNow } = harness(1000)
    twin(mod, 'child-A', 'child-A#1', { createdAt: 900 })
    twin(mod, 'child-A', 'child-A#2', { createdAt: 910 })
    const snapshot = (permIds) => permIds.map((permId) => ({ childId: 'child-A', permissionPendingList: [{ permId }] }))
    mod.setLastAmber(amberKeysOf(snapshot(['child-A#1', 'child-A#2'])))
    mod.acpTwinSync(amberKeysOf(snapshot(['child-A#1', 'child-A#2'])))
    assert.deepEqual(blue.added, [])
    setNow(2000)
    mod.acpTwinMarkDecided('child-A') // 用户点了 #1
    // 快照只剩 #2 → childId 仍在覆盖集 → 一条都不提升（旧实现这里会把整槽当已解决）
    mod.setLastAmber(amberKeysOf(snapshot(['child-A#2'])))
    mod.acpTwinSync(amberKeysOf(snapshot(['child-A#2'])))
    assert.deepEqual(blue.added, [])
    // 服务端确认 #2 也结束 → 快照空 → 代答窗口拦住误提升
    mod.setLastAmber(amberKeysOf(snapshot(['child-A#2'])))
    mod.acpTwinSync(amberKeysOf(snapshot([])))
    assert.deepEqual(blue.added, [])
  })
})
