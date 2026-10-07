// v1.11.14（A）：授权球"每请求一条"回归测试。
// 现场缺陷：同一子代理并发 2 条 ACP 权限授权时，编排层按 childId 单槽折叠，
// 用户点一次黄球只消掉一条，剩下那条从蓝球（宿主弹窗孪生）再次冒出来。
// 这里覆盖编排层（externalPending / entry.permissionPending）与 REST 序列化，
// 产品侧状态机见 dsh-plugin-product-subagents/test/permission-state.test.js，
// 前端孪生闸门见 test/acp-twin.test.js。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

  // v1.12.6（U1「面板说实话」/ U2 弹框预填）：真实记忆键与目录预填的数据源。
  // 前端过去只能拿 category（title 的 slug）硬凑「本会话将记住…」，那是假的。
  it('v1.12.6：透传 toolName / toolNameSource / suggestedDirs（缺省时为 null/null/[]）', () => {
    const out = serializePermissionPending([
      { permId: 'a#1', product: 'qoder', description: 'R1', toolName: 'Bash', toolNameSource: 'name/toolName', suggestedDirs: ['/tmp/p7/alpha', '/tmp/p7/alpha', '', 5, null], at: 1 },
      { permId: 'b#2', product: 'qoder', description: 'R2', category: 'qoder:web_search', at: 2 },
    ])
    assert.equal(out.permissionPending.toolName, 'Bash')
    assert.equal(out.permissionPending.toolNameSource, 'name/toolName')
    // suggestedDirs 只做防御性清洗（保序去重、丢非字符串与空串），不重新推导
    assert.deepEqual(out.permissionPending.suggestedDirs, ['/tmp/p7/alpha'])
    // 老 payload（没有这三个字段）必须降级可用，不能变成 undefined 漏进响应
    assert.equal(out.permissionPendingList[1].toolName, null)
    assert.equal(out.permissionPendingList[1].toolNameSource, null)
    assert.deepEqual(out.permissionPendingList[1].suggestedDirs, [])
  })

  it('v1.12.6：markPermissionPending 记账这三个字段，同 permId 重发时就地更新', () => {
    const d = boot()
    const entry = activeEntry('child-A')
    d.activeChildren.set('child-A', entry)
    d.markPermissionPending({
      childId: 'child-A', permId: 'tc#1', product: 'qoder', description: 'R',
      toolName: 'bash', toolNameSource: 'title(TOOL_NAME_SLUGS)', suggestedDirs: ['/tmp/x'],
    })
    assert.equal(entry.permissionPending[0].toolName, 'bash')
    assert.equal(entry.permissionPending[0].toolNameSource, 'title(TOOL_NAME_SLUGS)')
    assert.deepEqual(entry.permissionPending[0].suggestedDirs, ['/tmp/x'])
    // 外部子代理（无 activeChildren）同样记账
    d.markPermissionPending({ childId: 'ext-1', permId: 'e#1', product: 'qoder', description: 'E', toolName: 'edit', suggestedDirs: ['/tmp/y'] })
    assert.equal(d.externalPending.get('ext-1')[0].toolName, 'edit')
    assert.deepEqual(d.externalPending.get('ext-1')[0].suggestedDirs, ['/tmp/y'])
  })

  it('v1.12.6：脏 suggestedDirs 不炸（非数组/含对象都按空处理或逐项丢弃）', () => {
    const d = boot()
    const entry = activeEntry('child-B')
    d.activeChildren.set('child-B', entry)
    d.markPermissionPending({ childId: 'child-B', permId: 'p#1', description: 'R', suggestedDirs: 'not-an-array' })
    assert.deepEqual(entry.permissionPending[0].suggestedDirs, [])
    d.markPermissionPending({ childId: 'child-B', permId: 'p#2', description: 'R2', suggestedDirs: [{ p: 1 }, '/ok', '  '] })
    assert.deepEqual(entry.permissionPending[1].suggestedDirs, ['/ok'])
  })
})

// ── v1.12.7 裁定 B：product-subagents 0.7.10 的三键（grantTier / grantReason / grantDropped）
// 与 outcome `granted-once-fallback` 的兼容展示。跨仓只读核对结论：
//   · 对方 outcome 集合 = granted-session | granted-always | granted-once-fallback | allowed-once | rejected | error
//     ⇒ 本仓 ok 白名单早已含 `granted-once-fallback`（v1.9.0 起），不需要扩。
//   · 三键是**增量**的：老对端不带 ⇒ 行为必须逐字不变（兼容用例）。
//   · `grantTier:'none'` = 用户声明的路径一条都没通过校验 ⇒ 路径档与工具档**都不写**，
//     只放行本次。**必须让用户看到「没有记住」**，否则就是「点了允许却不知道为什么下次还问」。
describe('v1.12.7 裁定 B：grantTier/Reason/Dropped 的展示（含老对端兼容）', () => {
  function harness() {
    const injected = []
    const dir = mkdtempSync(join(tmpdir(), 'ad-perm-none-'))
    const parentAgent = { session: { id: 'parent-1' }, inject: (m) => injected.push(m) }
    const ctx = {
      subagents: { interrupt: () => {} },
      get: (name) => (name === 'agents' ? { get: (id) => (id === 'parent-1' ? parentAgent : undefined) } : undefined),
      emit: () => {},
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    }
    const d = new Dispatcher({ ctx, registry, dataDir: dir, idleReleaseMs: 0 })
    d.activeChildren.set('child-A', activeEntry('child-A'))
    d.markPermissionPending(pending('child-A', 'tc#1', 'Allow writing /etc/hosts?'))
    const text = () => (injected.map((m) => m.content.map((c) => c.text).join('')).join('\n'))
    const logRows = () => {
      const f = join(dir, 'dispatches.jsonl')
      if (!existsSync(f)) return []
      return readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    }
    return { d, injected, text, logRows }
  }
  const resolve = (h, extra) => h.d.markPermissionResolved({ childId: 'child-A', permId: 'tc#1', ...extra })

  it('grantTier:none ⇒ 面板明说「没有记住」+ 逐条 reason/value + 不得说成已进工具名档', () => {
    const h = harness()
    resolve(h, {
      outcome: 'granted-once-fallback',
      grantTier: 'none',
      grantReason: '用户声明的路径一条都没通过服务端校验 ⇒ 路径档与工具档一律未写（仅放行本次）',
      grantDropped: [{ reason: '非绝对路径', value: './a.txt' }, { reason: '访问被拒绝', value: '/etc/hosts' }],
    })
    const t = h.text()
    assert.match(t, /没有记住/, '必须让用户看到「没有记住」，否则「点了允许为什么还问」无解')
    assert.match(t, /用户声明的路径一条都没通过服务端校验/, '产品侧给的 grantReason 要如实转述')
    assert.match(t, /非绝对路径: \.\/a\.txt/, '逐条列出被丢弃的路径（含原因）')
    assert.match(t, /访问被拒绝: \/etc\/hosts/)
    assert.match(t, /没有\*\*进入工具名档/, '不得让用户以为已进入工具名档')
    assert.doesNotMatch(t, /已落盘项目白名单/, 'grantTier:none 时绝不能说已落盘（那是最典型的假话）')
    assert.match(t, /已放行本次（落盘失败未记忆）/, 'outcome granted-once-fallback 的既有 label 不变')
    // 留痕：这一行是「上次点了允许为什么还问」的唯一现场证据
    const rows = h.logRows().filter((r) => r.kind === 'perm-resolved')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].grantTier, 'none')
    assert.equal(rows[0].droppedCount, 2)
    assert.equal(rows[0].grantDropped.length, 2)
    assert.equal(rows[0].outcome, 'granted-once-fallback')
  })

  it('grantDropped 缺失/脏载荷 ⇒ 兜底文案可用，不炸（产品侧只给了 grantTier 也能说清）', () => {
    for (const dropped of [undefined, 'nope', [{}, { reason: 'x' }, null]]) {
      const h = harness()
      resolve(h, { outcome: 'allowed-once', grantTier: 'none', grantDropped: dropped })
      const t = h.text()
      assert.match(t, /没有记住/, `dropped=${JSON.stringify(dropped)}：仍必须说「没有记住」`)
      assert.match(t, /路径档与工具档一律未写/, '缺 grantReason 时用本仓兜底文案，不许空白')
    }
    // 极长列表只列前 8 条 + 总数（面板注入限 500 字，不能把注入挤爆）
    const h = harness()
    resolve(h, {
      outcome: 'granted-once-fallback', grantTier: 'none',
      grantDropped: Array.from({ length: 12 }, (_, i) => ({ reason: '非绝对路径', value: `./${i}.txt` })),
    })
    assert.match(h.text(), /…共 12 条/)
  })

  it('老对端（0.7.9 及以前不带三键）⇒ 行为逐字不变（兼容）', () => {
    for (const [outcome, label] of [
      ['granted-always', '已获批准（总是允许，已落盘项目白名单）'],
      ['granted-session', '已获批准（本会话总是允许）'],
      ['granted-once-fallback', '已放行本次（落盘失败未记忆）'],
      ['allowed-once', '已获批准'],
    ]) {
      const h = harness()
      resolve(h, { outcome })
      const t = h.text()
      assert.ok(t.includes(label), `老 payload（无 grantTier）必须保持既有 label：${outcome}`)
      assert.doesNotMatch(t, /没有记住/, '老 payload 没有 grantTier ⇒ 不得凭空说「没有记住」')
      assert.deepEqual(h.logRows().filter((r) => r.kind === 'perm-resolved'), [], '老 payload 不产生新的留痕行')
    }
  })

  it('超长 value/reason 必须截断（v1.12.7 终审 Minor 7）：条数有限但单条长度无上限 ⇒ 落盘行会膨胀', () => {
    const h = harness()
    const long = 'x'.repeat(5000)
    resolve(h, {
      outcome: 'granted-once-fallback', grantTier: 'none',
      grantReason: '声明的路径未通过校验',
      grantDropped: [{ reason: '非绝对路径', value: long }],
    })
    const rows = h.logRows().filter((r) => r.kind === 'perm-resolved')
    assert.equal(rows.length, 1)
    const v = rows[0].grantDropped[0].value
    assert.ok(v.length <= 121 + '…[截断]'.length, `单条 value 未截断：${v.length} 字符`)
    assert.match(v, /…\[截断\]$/, '截断必须可辨识（带标记，不是静默丢尾）')
    assert.equal(rows[0].droppedClipped, true, '截断事实要留痕（含上限值）')
    assert.equal(rows[0].droppedClipLimit, 120)
    // 面板文本同样受限（注入消息有 500 字上限，不能被一条 path 撑爆）
    assert.ok(h.text().includes('…[截断]'), '注入文本里的超长路径也应带截断标记')
    // grantReason 独立成例：它同样来自对端，也可能超长
    const h3 = harness()
    resolve(h3, { outcome: 'granted-once-fallback', grantTier: 'none', grantReason: 'r'.repeat(400) })
    const r3 = h3.logRows().filter((r) => r.kind === 'perm-resolved')[0]
    assert.ok(r3.grantReason.length <= 121 + '…[截断]'.length, `grantReason 未截断：${r3.grantReason.length} 字符`)
    assert.match(r3.grantReason, /…\[截断\]$/)
    // 短值不受影响（不引入无谓的标记）
    const h2 = harness()
    resolve(h2, { outcome: 'allowed-once', grantTier: 'none', grantDropped: [{ reason: '非绝对路径', value: './a.txt' }] })
    const r2 = h2.logRows().filter((r) => r.kind === 'perm-resolved')[0]
    assert.equal(r2.grantDropped[0].value, './a.txt')
    assert.equal('droppedClipped' in r2, false, '没截断时不得出现截断标记')
  })

  it('grantTier:none 只对「成功放行」的 outcome 生效（失败结局不得反过来说已放行）', () => {
    const h = harness()
    resolve(h, { outcome: 'rejected', grantTier: 'none', grantReason: 'x' })
    const t = h.text()
    assert.doesNotMatch(t, /没有记住/, '拒绝不是「放行了但没记住」——不能给用户这种错觉')
    assert.match(t, /已结束\(rejected\)/, '未知/失败结局照旧如实显示')
  })
})

// ── v1.12.15（用户裁定）：高危归因的透传半 ────────────────────────────────────
// 渲染半（只出「允许一次」「拒绝」两个按钮）见 test/danger-permission-dialog.test.js；
// 这里钉的是**数据链**：产品侧 0.7.16 在危险 ASK 的 pending 事件里带
// askReason/dangerRule/dangerSegment/dangerCommand/dangerCommandOmitted，
// A 侧 markPermissionPending 记账 → serializePermissionPending 输出 → 前端拿到。
// 两个方向都要钉：① 有归因时逐字透传（面板据此才写得出「高危操作权限申请」+ 命令正文）；
// ② 没有归因时归 null/0，前端才会按原普通卡渲染——**不得**凭空造出一个高危形态，
//    也不得反过来把高危询问降级成"可以记住"的普通询问。
describe('v1.12.15 高危归因透传：danger 询问带四件套，其余一律 null/0（判定零变更）', () => {
  const dangerPayload = (over = {}) => ({
    childId: 'ext-1', permId: 'tc-1#1', product: 'qoder', toolName: 'Bash',
    description: 'Allow bash?', paths: ['/tmp/a'],
    askReason: 'danger', dangerRule: 'rm -rf', dangerSegment: 'rm -rf /tmp/a',
    dangerCommand: 'cd /x && rm -rf /tmp/a', dangerCommandOmitted: 0, ...over,
  })

  it('危险 ASK：五个归因字段原样进 REST（前端只认这些才敢收成两个按钮）', () => {
    const out = serializePermissionPending([dangerPayload()], null)
    const r = out.permissionPending
    assert.equal(r.askReason, 'danger')
    assert.equal(r.dangerRule, 'rm -rf')
    assert.equal(r.dangerSegment, 'rm -rf /tmp/a')
    assert.equal(r.dangerCommand, 'cd /x && rm -rf /tmp/a')
    assert.equal(r.dangerCommandOmitted, 0)
    assert.equal(out.permissionPendingList[0].dangerRule, 'rm -rf', '列表半份也要有（新客户端读 List）')
  })

  it('逐字：连续空白、制表符、换行、首尾空格一律不得 trim/折叠（用户靠这些字符分辨是哪条命令）', () => {
    const raw = '  cd /tmp   &&\trm  -rf\t/tmp/a\n尾'
    const out = serializePermissionPending([dangerPayload({ dangerSegment: raw, dangerCommand: raw })], null)
    assert.equal(out.permissionPending.dangerSegment, raw, 'suggestedDirs 那种清洗范式（strList）绝不许用在归因上')
    assert.equal(out.permissionPending.dangerCommand, raw)
  })

  it('非危险询问 ⇒ askReason:null + 三个文本:null + 省略数:0（老 payload 没有这些字段同样降级可用）', () => {
    const out = serializePermissionPending([{ childId: 'ext-1', permId: 'p#1', product: 'qoder', description: 'Allow reading?' }], null)
    const r = out.permissionPending
    assert.equal(r.askReason, null)
    assert.deepEqual([r.dangerRule, r.dangerSegment, r.dangerCommand], [null, null, null])
    assert.equal(r.dangerCommandOmitted, 0)
    assert.deepEqual(JSON.parse(JSON.stringify(out)).permissionPending.askReason, null, 'null 而非 undefined：REST 响应不得出现字段缺失')
  })

  it('归因取值不可信时的收敛：askReason 只认 danger，非字符串/空串归 null，省略数非有限或负数归 0', () => {
    const out = serializePermissionPending([dangerPayload({
      askReason: 'sandbox-escalation', dangerRule: 123, dangerSegment: '', dangerCommand: { x: 1 }, dangerCommandOmitted: -5,
    })], null)
    assert.equal(out.permissionPending.askReason, null, '别的询问原因（如沙箱升级）不得冒用高危形态')
    assert.equal(out.permissionPending.dangerRule, null)
    assert.equal(out.permissionPending.dangerSegment, null)
    assert.equal(out.permissionPending.dangerCommand, null)
    assert.equal(out.permissionPending.dangerCommandOmitted, 0)
    const nan = serializePermissionPending([dangerPayload({ dangerCommandOmitted: '很多' })], null)
    assert.equal(nan.permissionPending.dangerCommandOmitted, 0, '省略数必须是数字，否则宁可不报也不能报个假的')
  })

  it('只有 dangerRule 没有 askReason（原生通道/老 B 载荷）⇒ 规则名照样透传，任一信号都够前端判高危', () => {
    const out = serializePermissionPending([dangerPayload({ askReason: undefined })], null)
    assert.equal(out.permissionPending.askReason, null)
    assert.equal(out.permissionPending.dangerRule, 'rm -rf')
  })

  it('命令正文不在这一层二次截断（产品侧已按上限截并报了省略数，这里再截就是丢尾）', () => {
    const long = 'rm -rf /tmp/a && ' + 'y'.repeat(20000)
    const out = serializePermissionPending([dangerPayload({ dangerCommand: long, dangerCommandOmitted: 1234 })], null)
    assert.equal(out.permissionPending.dangerCommand.length, long.length)
    assert.equal(out.permissionPending.dangerCommandOmitted, 1234, '上游报的省略数原样带上，前端据此如实说明"另有 N 个字符未展示"')
  })

  it('markPermissionPending 记账这四个字段，同 permId 重发（带归因）时就地更新不丢', () => {
    const d = boot()
    const entry = activeEntry('child-A')
    d.activeChildren.set('child-A', entry)
    d.markPermissionPending({ ...dangerPayload(), childId: 'child-A', permId: 'tc#1' })
    const rec = entry.permissionPending[0]
    assert.equal(rec.askReason, 'danger')
    assert.equal(rec.dangerSegment, 'rm -rf /tmp/a')
    d.markPermissionPending({ ...dangerPayload({ dangerSegment: 'rm -rf /tmp/b' }), childId: 'child-A', permId: 'tc#1' })
    assert.equal(entry.permissionPending.length, 1, '同 permId 不堆重复行')
    assert.equal(entry.permissionPending[0].dangerSegment, 'rm -rf /tmp/b', '重发以最新归因为准')
    const plain = boot()
    const pe = activeEntry('child-B')
    plain.activeChildren.set('child-B', pe)
    plain.markPermissionPending({ childId: 'child-B', permId: 'tc#9', product: 'qoder', description: 'R' })
    assert.equal(pe.permissionPending[0].askReason, null)
    assert.equal(pe.permissionPending[0].dangerRule, null)
    assert.equal(serializePermissionPending(pe.permissionPending, null).permissionPending.dangerCommandOmitted, 0)
  })
})
