/**
 * v1.11.21 宿主兼容回归：dsh 0.2.0-rc.1（接口换代）下的三处修复
 *
 * 一、`listChildren()` 条目在 0.2 上**没有 activity** 字段（带 activity 的是
 *     `SubagentCatalogRow`，只出现在 `listDescendants()` 的目录行上）。旧实现
 *     `en.activity === 'running' ? 'idle' : 'ready'` 因此恒判 `ready` —— 非运行中的
 *     线程被一律报成"驻留已释放/需冷恢复"，静默失真（不报错、不失败）。
 * 二、工具出参必须「无损 JSON」（`snapshotJsonValue`）：值为 undefined 的自有属性会
 *     让**整次调用**失败（INVALID_TOOL_OUTPUT），0.1.0-rc.6 与 0.2.0-rc.1 同样严格。
 *     手写/迁移过的 agents.json 缺 emoji/triggers 时，`agent_list` 就会中招。
 * 三、provider 出现在 ACP 产品目录、却未被宿主注册（product-subagents 未装/被
 *     dsh-app-boot 跳过）时，旧实现把它当 LLM 路由，一次派发白烧整条 fallback 链；
 *     现在**只做显式告警 + 决策日志留痕**，刻意不重排候选顺序（重排会破坏换档路径
 *     依赖的「首个候选 == routes[0]」不变式——见本文件 P3 的"顺序不变"护栏）。
 *
 * 全部用最小假宿主驱动真实 Dispatcher / AgentRegistry，不依赖任何产品可用性。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../lib/dispatch.js'
import { AgentRegistry, normalizeAgent, needsNormalize } from '../lib/agents.js'
import { jsonSafe, isLosslessJson } from '../lib/json-safe.js'

// ── 通用：种子池条目（非活跃 = 驻留空闲候选）──
function seedPool(dispatcher, childId, agentId = 'explorer') {
  dispatcher.childPool.set(`parent-1::${agentId}::${childId}`, {
    key: `parent-1::${agentId}::${childId}`,
    childId,
    agentId,
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

function makeChildHost({ listDescendants, listChildren, sessionsGet } = {}) {
  const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 }, inject: () => {} }
  const ctx = {
    subagents: {
      getProvider: () => undefined,
      startContinuable: async () => ({ childId: 'child-new' }),
      sendMessage: async () => 'msg-1',
      ...(listDescendants ? { listDescendants } : {}),
      ...(listChildren ? { listChildren } : {}),
    },
    get: (name) => {
      if (name === 'sessions') return sessionsGet ? { get: sessionsGet } : undefined
      if (name === 'agents') return { get: (id) => (id === 'parent-1' ? parentAgent : undefined) }
      return undefined
    },
    emit: () => {},
  }
  const registry = { get: (id) => ({ id, name: '代码探索专家', reusePolicy: 'fresh' }), resolveRoutes: () => [] }
  const dispatcher = new Dispatcher({
    ctx,
    registry,
    dataDir: mkdtempSync(join(tmpdir(), 'dispatch-host02-')),
    idleReleaseMs: 0,
  })
  return { dispatcher, parentAgent }
}

// ─────────────────────────────────────────────────────────────────────────────
describe('P1 子代理驻留性派生（0.2 的 listChildren 无 activity）', () => {
  it('0.2 形状：activity 只在 listDescendants 上，inactive→ready / running→idle', async () => {
    const { dispatcher, parentAgent } = makeChildHost({
      // 0.2：listChildren 只回 {id,createdAt,mode,label}，**没有 activity**
      listChildren: async () => [
        { id: 'c-idle', createdAt: 1, mode: 'continuable', label: 'x' },
        { id: 'c-ready', createdAt: 2, mode: 'continuable', label: 'y' },
      ],
      // 0.2：带 activity 的是 descendants 目录行
      listDescendants: async () => [
        { id: 'c-idle', kind: 'child', activity: 'running', mode: 'continuable', label: 'x', parentId: 'parent-1', depth: 1, hasChildren: false },
        { id: 'c-ready', kind: 'child', activity: 'inactive', mode: 'continuable', label: 'y', parentId: 'parent-1', depth: 1, hasChildren: false },
      ],
    })
    seedPool(dispatcher, 'c-idle')
    seedPool(dispatcher, 'c-ready')
    const out = await dispatcher.listChildren(parentAgent)
    const byId = new Map(out.children.map((r) => [r.childId, r.status]))
    assert.equal(byId.get('c-idle'), 'idle', '宿主报 running（驻留在册）→ idle（驻留空闲）')
    assert.equal(byId.get('c-ready'), 'ready', '宿主报 inactive（驻留已释放）→ ready（可冷恢复）')
  })

  it('回归护栏：只有 0.2 的 listChildren（无 activity）时，不得把 idle 误降级为 ready', async () => {
    const { dispatcher, parentAgent } = makeChildHost({
      listChildren: async () => [{ id: 'c-1', createdAt: 1, mode: 'continuable', label: 'x' }],
    })
    seedPool(dispatcher, 'c-1')
    const out = await dispatcher.listChildren(parentAgent)
    // 旧实现：en.activity === 'running' 恒 false → 'ready'（错）。修复后保留派生值 'idle'。
    assert.equal(out.children[0].status, 'idle')
    // 语义层护栏（不依赖实现形态）：给 c-1 一个真实驻留的宿主回执，两种写法都必须得到 idle
    const { dispatcher: d2, parentAgent: p2 } = makeChildHost({
      listDescendants: async () => [{ id: 'c-1', kind: 'child', activity: 'running', parentId: 'parent-1' }],
    })
    seedPool(d2, 'c-1')
    const out2 = await d2.listChildren(p2)
    assert.equal(out2.children[0].status, 'idle', '宿主明确报驻留时必须是 idle')
  })

  it('0.1.x 形状：listChildren 条目自带 activity，行为保持不变', async () => {
    const { dispatcher, parentAgent } = makeChildHost({
      listChildren: async () => [
        { id: 'c-idle', activity: 'running' },
        { id: 'c-ready', activity: 'inactive' },
      ],
    })
    seedPool(dispatcher, 'c-idle')
    seedPool(dispatcher, 'c-ready')
    const out = await dispatcher.listChildren(parentAgent)
    const byId = new Map(out.children.map((r) => [r.childId, r.status]))
    assert.equal(byId.get('c-idle'), 'idle')
    assert.equal(byId.get('c-ready'), 'ready')
  })

  it('两级目录面都不可用时，退回会话存储判定（与宿主 listDescendants 同规则）', async () => {
    const live = new Set(['parent-1', 'c-live'])
    const { dispatcher, parentAgent } = makeChildHost({ sessionsGet: (id) => (live.has(id) ? { id } : undefined) })
    seedPool(dispatcher, 'c-live')
    seedPool(dispatcher, 'c-gone')
    const out = await dispatcher.listChildren(parentAgent)
    const byId = new Map(out.children.map((r) => [r.childId, r.status]))
    assert.equal(byId.get('c-live'), 'idle', '会话在册 → 驻留')
    assert.equal(byId.get('c-gone'), 'ready', '会话已不在册 → 仅持久化')
  })

  it('宿主完全没有目录面/会话服务时，保留派生状态（绝不误判为 ready）', async () => {
    const { dispatcher, parentAgent } = makeChildHost({})
    seedPool(dispatcher, 'c-1')
    const out = await dispatcher.listChildren(parentAgent)
    assert.equal(out.children[0].status, 'idle')
  })

  it('正在执行的线程不被目录面覆盖（running 优先）', async () => {
    const { dispatcher, parentAgent } = makeChildHost({
      listDescendants: async () => [{ id: 'c-1', kind: 'child', activity: 'inactive', parentId: 'parent-1' }],
    })
    dispatcher.activeChildren.set('c-1', { childId: 'c-1', agentId: 'explorer', parentSessionId: 'parent-1', taskLabel: '跑着' })
    const out = await dispatcher.listChildren(parentAgent)
    assert.equal(out.children[0].status, 'running')
  })

  it('只认直接子级：后代（parentId ≠ 父会话）的 activity 不得覆盖本会话线程', async () => {
    const { dispatcher, parentAgent } = makeChildHost({
      // 同 id 的"孙子"报 inactive，直接子级回执缺项 → 必须保留派生状态（idle），不得被孙子拖成 ready
      listDescendants: async () => [{ id: 'c-1', kind: 'child', activity: 'inactive', parentId: 'other-session' }],
    })
    seedPool(dispatcher, 'c-1')
    const out = await dispatcher.listChildren(parentAgent)
    assert.equal(out.children[0].status, 'idle')
  })

  it('目录面抛错时降级到下一级，不让 agent_children 整体失败', async () => {
    const { dispatcher, parentAgent } = makeChildHost({
      listDescendants: async () => { throw new Error('UNAUTHORIZED') },
      sessionsGet: (id) => (id === 'c-1' ? { id } : undefined),
    })
    seedPool(dispatcher, 'c-1')
    const out = await dispatcher.listChildren(parentAgent)
    assert.equal(out.children[0].status, 'idle')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('P2 工具出参「无损 JSON」（宿主 snapshotJsonValue 规则）', () => {
  it('jsonSafe 丢弃 undefined 自有属性、保序保留其余', () => {
    const out = jsonSafe({ a: 1, b: undefined, c: 'x', d: null })
    assert.deepEqual(Object.keys(out), ['a', 'c', 'd'])
    assert.equal(isLosslessJson(out), true)
    assert.equal(isLosslessJson({ a: 1, b: undefined }), false, '对照组：含 undefined 的对象必须被判定非法')
  })

  it('数组项里的 undefined 转 null（保住下标与长度）', () => {
    const out = jsonSafe({ list: [1, undefined, 3] })
    assert.deepEqual(out.list, [1, null, 3])
    assert.equal(out.list.length, 3)
    assert.equal(isLosslessJson(out), true)
  })

  it('函数/symbol 不可能无损往返，按不可序列化处理', () => {
    const out = jsonSafe({ keep: 1, fn: () => {}, sym: Symbol('s'), arr: [() => {}] })
    assert.deepEqual(Object.keys(out), ['keep', 'arr'])
    assert.deepEqual(out.arr, [null])
  })

  it('带 toJSON 的对象按 JSON 形态落值（Date/Buffer 保内容，不拍平成 {}）', () => {
    const out = jsonSafe({ d: new Date(0), b: Buffer.from('hi') })
    assert.equal(out.d, '1970-01-01T00:00:00.000Z')
    assert.deepEqual(out.b, { type: 'Buffer', data: [104, 105] })
    assert.equal(isLosslessJson(out), true)
  })

  it('Map/Set/类实例：JSON 只能得到 {}，按不可无损丢弃（对象丢键、数组转 null）', () => {
    const out = jsonSafe({ m: new Map([['a', 1]]), s: new Set([1]), c: new (class { constructor() { this.x = 1 } })(), arr: [new Map()] })
    assert.deepEqual(out, { arr: [null] })
    assert.equal(isLosslessJson(out), true)
  })

  it('bigint：安全整数转 number，超出转十进制字符串（JSON 无 bigint）', () => {
    assert.equal(jsonSafe({ n: 5n }).n, 5)
    assert.equal(jsonSafe({ n: 123456789012345678901234567890n }).n, '123456789012345678901234567890')
    assert.equal(isLosslessJson(jsonSafe({ n: 5n })), true)
  })

  it('顶层 undefined 原样返回（不替调用方编造值）', () => {
    assert.equal(jsonSafe(undefined), undefined)
  })

  it('嵌套结构递归清洗', () => {
    const out = jsonSafe({ a: { b: undefined, c: [{ d: undefined, e: 1 }] } })
    assert.deepEqual(out, { a: { c: [{ e: 1 }] } })
    assert.equal(isLosslessJson(out), true)
  })

  it('jsonSafe 不原地修改入参', () => {
    const src = { a: 1, b: undefined, arr: [undefined] }
    jsonSafe(src)
    assert.equal('b' in src, true)
    assert.deepEqual(src.arr, [undefined])
  })

  it('jsonSafe 总能返回：循环引用与自返 toJSON 不爆栈（旧的 JSON.stringify 会抛）', () => {
    const a = {}
    a.self = a
    const cyc = jsonSafe({ a })
    assert.equal(isLosslessJson(cyc), true, '深度截断后仍是合法 JSON（不抛 RangeError）')
    const selfToJson = { toJSON() { return this } }
    assert.deepEqual(jsonSafe({ x: selfToJson }), { x: {} })
    // 正常深结构不受影响
    assert.deepEqual(jsonSafe({ a: { b: { c: [1, 2] } } }), { a: { b: { c: [1, 2] } } })
  })

  // 终审实测出的 4 类"往返后结构等值、但宿主判非法"的形态：判定必须与宿主一致
  it('isLosslessJson 不得漏判 -0 / symbol 键 / 非枚举自有属性 / 数组额外自有属性 / 稀疏数组', () => {
    const hidden = { a: 1 }
    Object.defineProperty(hidden, 'h', { value: 1, enumerable: false })
    assert.equal(isLosslessJson({ x: -0 }), false, '-0 往返成 0')
    assert.equal(isLosslessJson({ [Symbol('s')]: 1, a: 1 }), false, 'symbol 键会丢')
    assert.equal(isLosslessJson(hidden), false, '非枚举自有属性会丢')
    assert.equal(isLosslessJson(Object.assign([1, 2], { extra: 1 })), false, '数组额外自有属性会丢')
    assert.equal(isLosslessJson([1, , 3]), false, '稀疏数组的洞会变成 null')
    assert.equal(isLosslessJson({ x: NaN }), false)
    assert.equal(isLosslessJson({ x: Infinity }), false)
    // 对照组：干净形态必须判 true
    assert.equal(isLosslessJson({ a: [1, null, 'x', true] }), true)
    assert.equal(isLosslessJson([]), true)
    assert.equal(isLosslessJson({}), true)
  })

  it('jsonSafe 的保证边界：收口 undefined/非字面量对象，不保证 NaN/Infinity/-0/稀疏数组', () => {
    // 这四类宿主仍会拒（响亮失败，不静默改写）——写进契约，避免后来者误以为"过了 jsonSafe 就必然被接受"
    assert.equal(isLosslessJson(jsonSafe({ x: NaN })), false)
    assert.equal(isLosslessJson(jsonSafe({ x: -0 })), false)
    assert.equal(isLosslessJson(jsonSafe([1, , 3])), false)
  })

  it('读盘隔离：agents.json 缺 emoji/triggers 时注册表不再产出 undefined 字段', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-normalize-'))
    writeFileSync(join(dir, 'agents.json'), JSON.stringify({
      version: 1,
      config: {},
      agents: [{ id: 'probe', name: '探针', systemPrompt: 'x' }], // 手工编辑：缺 emoji/triggers/routes
    }))
    const reg = new AgentRegistry(dir)
    await reg.init()
    const a = reg.get('probe')
    assert.equal(a.emoji, '')
    assert.equal(a.triggers, '')
    assert.deepEqual(a.routes, [])
    assert.equal(a.reusePolicy, 'reuse')
    assert.equal(a.enabled, true)
    // 旧实现下 a.emoji / a.triggers === undefined，agent_list 出参即含 undefined → 整次调用失败
    assert.equal(Object.values(a).every((v) => v !== undefined), true)
    assert.equal(isLosslessJson(reg.list()), true)
  })

  it('读盘只归一化内存、不回写磁盘（不做启动期无声整文件重写）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-nowrite-'))
    const raw = JSON.stringify({
      version: 1,
      config: {},
      agents: [{ id: 'probe', name: '探针', systemPrompt: 'x', extraMeta: { keepme: true } }],
    })
    writeFileSync(join(dir, 'agents.json'), raw)
    const reg = new AgentRegistry(dir)
    await reg.init()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(readFileSync(join(dir, 'agents.json'), 'utf8'), raw, '磁盘必须逐字节不变（含未知键 extraMeta）')
    assert.equal(reg.get('probe').emoji, '', '内存里已归一化')
  })

  it('normalizeAgent 对非字符串 model/effort 按"未指定"处理，不编造 String(123)', () => {
    const a = normalizeAgent({ id: 'p', name: 'p', systemPrompt: 's', routes: [{ provider: 'x', model: 123, effort: true }] })
    assert.deepEqual(a.routes, [{ provider: 'x' }])
  })

  it('写路径门禁：非字符串 model 必须响亮拒绝（旧实现报的是 TypeError: trim is not a function）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reg-modeltype-'))
    const reg = new AgentRegistry(dir)
    await assert.rejects(
      () => reg.upsert({ id: 'p', name: 'p', systemPrompt: 's', routes: [{ provider: 'x', model: 123 }] }),
      /model 必须是字符串/,
    )
  })

  it('needsNormalize 逐字段判定：形状完好的条目不视为偏离', () => {
    const ok = { id: 'a', name: 'n', emoji: '', triggers: '', systemPrompt: 's', routes: [], reusePolicy: 'reuse', enabled: true }
    assert.equal(needsNormalize(ok), false)
    assert.equal(needsNormalize({ id: 'a', name: 'n', systemPrompt: 's', routes: [], reusePolicy: 'reuse', enabled: true }), true, '缺 emoji/triggers')
    assert.equal(needsNormalize({ ...ok, id: '' }), true, 'id 为空（归一化后 name 会变）')
    assert.equal(needsNormalize({ ...ok, routes: [{ model: 'x' }] }), true, '路由项缺 provider')
    assert.equal(needsNormalize({ ...ok, routes: [{ provider: 'p', model: 5 }] }), true, 'model 非字符串')
  })

  it('源码护栏：10 个工具全部经 registerTool 收口，不得再有裸 ctx.tools.register', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    assert.equal(src.includes('toolDisposers.push(ctx.tools.register({'), false, '裸注册会绕过 jsonSafe 收口')
    const wrapped = src.match(/toolDisposers\.push\(registerTool\(\{/g) ?? []
    assert.equal(wrapped.length, 10, '十个工具都必须经 registerTool 注册')
    assert.equal((src.match(/const registerTool = /g) ?? []).length, 1, 'registerTool 只应定义一次')
  })

  it('宿主真实校验器可用时：本地判定与宿主逐例一致，且 jsonSafe 输出一律被接受', async (t) => {
    let snapshotJsonValue
    try {
      const mod = await import('/Users/arming/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-util-values/lib/index.js')
      snapshotJsonValue = mod.snapshotJsonValue
    } catch {
      t.skip('本机无 dsh 宿主包可解析，跳过"与宿主同源"断言（本地等价判定已由前面用例覆盖）')
      return
    }
    const accept = (v) => {
      try { return snapshotJsonValue(v) !== undefined } catch { return false }
    }
    const hidden = { a: 1 }
    Object.defineProperty(hidden, 'h', { value: 1, enumerable: false })
    const table = [
      { a: 1 }, { a: 1, b: undefined }, [1, undefined, 3], [1, null, 3],
      { a: { b: undefined, c: 1 } }, { d: new Date(0) }, { b: Buffer.from('hi') },
      { m: new Map([['a', 1]]) }, { s: new Set([1]) }, { n: 5n },
      { n: 123456789012345678901234567890n }, { c: new (class { constructor() { this.x = 1 } })() },
      null, 'x', { f: () => {} },
      { x: -0 }, { x: NaN }, { x: Infinity }, { [Symbol('s')]: 1, a: 1 }, hidden,
      Object.assign([1, 2], { extra: 1 }), [1, , 3], [], {}, Object.assign(Object.create(null), { a: 1 }),
    ]
    for (const [i, v] of table.entries()) {
      assert.equal(isLosslessJson(v), accept(v), `第 ${i} 例：本地判定必须与宿主 snapshotJsonValue 一致`)
    }
    // jsonSafe 的收口范围：undefined 与非字面量对象必须被宿主接受
    for (const v of [{ a: 1, b: undefined }, { m: new Map() }, { d: new Date(0) }, { n: 5n }, { b: Buffer.from('x') }]) {
      assert.equal(accept(jsonSafe(v)), true, 'jsonSafe 输出必须被宿主接受')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
describe('P3 ACP provider 未注册：显式诊断，且**不重排候选顺序**', () => {
  function makeDispatchHost({ getProvider = () => undefined, startContinuable = null, productCatalog = () => ({ qoder: { models: ['qfmodel'] } }) } = {}) {
    const started = []
    const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 }, inject: () => {} }
    const ctx = {
      subagents: {
        getProvider,
        sendMessage: async () => 'msg-1',
        startContinuable: startContinuable
          ? async (spec) => { started.push(spec); return startContinuable(spec, started.length) }
          : async (spec) => { started.push(spec); return { childId: `child-${started.length}` } },
      },
      get: (name) => (name === 'agents' ? { get: (id) => (id === 'parent-1' ? parentAgent : undefined) } : undefined),
      emit: () => {},
    }
    const registry = {
      get: (id) => ({ id, name: '代码探索专家', emoji: '🔍', systemPrompt: '你是探索者。', reusePolicy: 'fresh' }),
      resolveRoutes: () => [{ provider: 'qoder', model: 'qfmodel' }, { provider: 'deepseek-official', model: 'deepseek-flash' }],
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-acpmiss-'))
    const dispatcher = new Dispatcher({ ctx, registry, dataDir, idleReleaseMs: 0, productCatalog })
    return { dispatcher, started, parentAgent, dataDir }
  }

  it('顺序不变（回归护栏）：即使首档是"目录里有、未注册"的 ACP 档，首个候选仍是 routes[0]', async () => {
    // 沉底方案会在这里返回 deepseek-official——那会破坏换档路径依赖的「首个候选 == routes[0]」不变式
    const { dispatcher, started, parentAgent } = makeDispatchHost()
    const res = await dispatcher.dispatch(parentAgent, 'explorer', '任务', { reuse: 'fresh' })
    assert.equal(res.ok, true)
    assert.equal(started.length, 1)
    assert.equal(started[0].request.agentOptions.provider, 'qoder', '必须仍按 routes[0] 尝试，不得重排')
  })

  it('决策日志留 acpProviderMissing 痕，并对该 provider 告警', async () => {
    const { dispatcher, parentAgent, dataDir } = makeDispatchHost()
    const warns = []
    const origError = console.error
    console.error = (...args) => { warns.push(args.join(' ')) }
    try {
      await dispatcher.dispatch(parentAgent, 'explorer', '任务', { reuse: 'fresh' })
    } finally {
      console.error = origError
    }
    const rows = readFileSync(join(dataDir, 'dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(rows.some((r) => r.acpProviderMissing === true), '决策日志必须留 acpProviderMissing 痕')
    assert.ok(warns.some((w) => w.includes('未注册它')), '必须有一条说明原因的告警')
    assert.equal(warns.filter((w) => w.includes('未注册它')).length, 1, '同一 provider 只告警一次')
  })

  it('普通 LLM provider（不在 ACP 目录里）不告警、不留痕', async () => {
    const started = []
    const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 }, inject: () => {} }
    const ctx = {
      subagents: {
        getProvider: () => undefined,
        startContinuable: async (spec) => { started.push(spec); return { childId: `child-${started.length}` } },
        sendMessage: async () => 'msg-1',
      },
      get: (name) => (name === 'agents' ? { get: (id) => (id === 'parent-1' ? parentAgent : undefined) } : undefined),
      emit: () => {},
    }
    const registry = {
      get: (id) => ({ id, name: '代码探索专家', emoji: '🔍', systemPrompt: '你是探索者。', reusePolicy: 'fresh' }),
      resolveRoutes: () => [{ provider: 'deepseek-official', model: 'deepseek-flash' }],
    }
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-llm-'))
    const dispatcher = new Dispatcher({ ctx, registry, dataDir, idleReleaseMs: 0, productCatalog: () => ({ qoder: { models: ['qfmodel'] } }) })
    const warns = []
    const origError = console.error
    console.error = (...args) => { warns.push(args.join(' ')) }
    try {
      await dispatcher.dispatch(parentAgent, 'explorer', '任务', { reuse: 'fresh' })
    } finally {
      console.error = origError
    }
    assert.equal(started[0].request.agentOptions.provider, 'deepseek-official')
    assert.equal(warns.filter((w) => w.includes('未注册它')).length, 0)
    const rows = readFileSync(join(dataDir, 'dispatches.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.ok(rows.every((r) => r.acpProviderMissing === undefined))
  })

  it('目录不可用/抛错时不误判（信息不足不做判断）', async () => {
    const { dispatcher, started, parentAgent } = makeDispatchHost({ productCatalog: () => { throw new Error('io') } })
    await dispatcher.dispatch(parentAgent, 'explorer', '任务', { reuse: 'fresh' })
    assert.equal(started[0].request.agentOptions.provider, 'qoder')
  })
})
