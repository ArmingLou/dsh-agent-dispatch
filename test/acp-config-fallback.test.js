/**
 * v1.11.12 回归测试：ACP 路由填了非法 model/effort 时的【降级不失败】与【可见性】。
 *
 * 契约（用户原话）：手工编辑 agents.json 后 provider 正确、model/effort 写错，
 * 实际调用 ACP 必须 fallback 到产品默认模型/档位，不影响正常使用。
 *
 * 覆盖：
 *   1. acpConfigNote 纯函数真值表（可疑值注记；信息不足时一律不判断）；
 *   2. 端到端派发：非法值只记注记、不阻断，成功行补 effort；
 *   3. 'default' / 空 effort 的"不指定"语义未回退；
 *   4. apply-child-settings 下发失败从"整轮 ok:false"降级为成功行的 configError；
 *   5. 回归：ACP 档创建期失败时，catch 里的 productSettings 曾因块级作用域
 *      抛 ReferenceError（把"换档重试"打成整轮异常）——现在必须正常换到下一档。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher, acpConfigNote, effectiveConfigValue } from '../lib/dispatch.js'

const AGENT_ID = 'senior-dev'
const ACP_PROVIDERS = new Set(['deveco', 'opencode'])

/** 一份"正常探测成功"的目录 + 一份"探测失败"的目录 */
const CATALOG = {
  deveco: {
    models: ['GLM-5.1', 'DeepSeek-V3'],
    efforts: ['low', 'medium', 'high'],
    modelEfforts: { 'GLM-5.1': ['low', 'high'] },
  },
  opencode: { models: [], efforts: [], error: 'probe failed' },
}

function makeHarness({ routes = [{ provider: 'deveco', model: 'GLM-5.1', effort: 'high' }], catalog = CATALOG, emitThrows = false, failOn = null } = {}) {
  const started = []
  const emitted = []
  const parentAgent = { session: { id: 'parent-1' }, options: { subagentDepth: 0 }, inject: () => {} }
  const ctx = {
    subagents: {
      getProvider: (name) => (ACP_PROVIDERS.has(name) ? { name } : undefined),
      startContinuable: async (spec) => {
        if (failOn && spec.provider === failOn) throw new Error(`${spec.provider} 起不来`)
        started.push(spec)
        return { childId: `child-${started.length}` }
      },
      sendMessage: async () => {},
      drainChildren: async () => {},
      interrupt: async () => {},
    },
    get: (name) => (name === 'agents' ? { get: (id) => (id === 'parent-1' ? parentAgent : undefined) } : undefined),
    emit: (event, payload) => {
      emitted.push({ event, payload })
      if (emitThrows) throw new Error('listener boom')
    },
  }
  const registry = {
    get: (id) => ({ id, name: '资深开发（中坚）', emoji: '🛠️', systemPrompt: '你是资深开发。', reusePolicy: 'reuse' }),
    resolveRoutes: () => routes.map((r) => ({ ...r })),
  }
  const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-acp-config-'))
  const dispatcher = new Dispatcher({
    ctx,
    registry,
    dataDir,
    idleReleaseMs: 0,
    ...(catalog === null ? {} : { productCatalog: () => catalog }),
  })
  const rows = () => {
    const file = join(dataDir, 'dispatches.jsonl')
    if (!existsSync(file)) return [] // 一次都没记过
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  }
  const logs = () => rows().filter((r) => r.kind === 'dispatch')
  return { dispatcher, started, emitted, logs, rows, parentAgent }
}

describe('acpConfigNote：目录预检真值表', () => {
  it('目录缺失 / 该 provider 无条目 / 入参不合法 → 不判断', () => {
    assert.equal(acpConfigNote({ provider: 'deveco', model: 'X' }, null), null)
    assert.equal(acpConfigNote({ provider: 'deveco', model: 'X' }, undefined), null)
    assert.equal(acpConfigNote({ provider: 'ghost', model: 'X' }, CATALOG), null)
    assert.equal(acpConfigNote(null, CATALOG), null)
    assert.equal(acpConfigNote({ provider: 'deveco', model: 'X' }, '坏目录'), null)
  })

  it('合法 model + effort → 无注记', () => {
    assert.equal(acpConfigNote({ provider: 'deveco', model: 'GLM-5.1', effort: 'high' }, CATALOG), null)
  })

  it('非法 model → 注记只含请求值与"可能不生效"语义，不含任务内容', () => {
    const note = acpConfigNote({ provider: 'deveco', model: 'GLM-52', effort: 'high' }, CATALOG)
    assert.match(note, /model=GLM-52/)
    assert.match(note, /不在 deveco 模型目录中/)
    assert.match(note, /可能回退默认模型/)
    assert.ok(!note.includes('GLM-5.1'), '不得把整张目录塞进日志')
  })

  it('非法 effort → 注记指向档位目录', () => {
    const note = acpConfigNote({ provider: 'deveco', model: 'GLM-5.1', effort: 'turbo' }, CATALOG)
    assert.match(note, /effort=turbo/)
    assert.match(note, /可能回退默认档位/)
    assert.ok(!note.includes('model='), 'model 合法时不应连带报 model')
  })

  it('model=default 与空 effort 属于「不指定」，永不判非法', () => {
    assert.equal(acpConfigNote({ provider: 'deveco', model: 'default', effort: '' }, CATALOG), null)
    assert.equal(acpConfigNote({ provider: 'deveco', model: '  default  ', effort: undefined }, CATALOG), null)
    // default 模型下 effort 走 provider 级档位表校验，而非 modelEfforts
    assert.equal(acpConfigNote({ provider: 'deveco', model: 'default', effort: 'medium' }, CATALOG), null)
    assert.match(acpConfigNote({ provider: 'deveco', model: 'default', effort: 'ultra' }, CATALOG), /effort=ultra/)
  })

  it('探测失败（列表为空）时不误报', () => {
    assert.equal(acpConfigNote({ provider: 'opencode', model: 'zen-main-free', effort: 'x' }, CATALOG), null)
  })

  it('modelEfforts 优先：provider 级有、但该模型没有的档位仍算可疑', () => {
    // medium 在 deveco 的 provider 级档位表里，但 GLM-5.1 只支持 low/high
    assert.match(acpConfigNote({ provider: 'deveco', model: 'GLM-5.1', effort: 'medium' }, CATALOG), /effort=medium/)
  })

  it('字段形状不符（非字符串项）不参与判断，也不抛', () => {
    const dirty = { deveco: { models: ['GLM-5.1', 42, null], efforts: undefined } }
    assert.equal(acpConfigNote({ provider: 'deveco', model: 'GLM-5.1', effort: 'high' }, dirty), null)
    assert.match(acpConfigNote({ provider: 'deveco', model: 'GLM-52', effort: 'high' }, dirty), /model=GLM-52/)
  })
})

describe('dispatch：非法 model/effort 只降级、不失败', () => {
  it('可疑值照常派发，成功行记 requested 值 + configNote + effort', async () => {
    const { dispatcher, started, logs, parentAgent } = makeHarness({
      routes: [{ provider: 'deveco', model: 'GLM-52', effort: 'turbo' }],
    })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '修复导航栏样式问题', { reuse: 'fresh' })

    assert.equal(res.ok, true)
    assert.equal(started.length, 1)
    assert.deepEqual(started[0].request.productSettings, { model: 'GLM-52', reasoningEffort: 'turbo' })
    const row = logs().find((r) => r.ok === true && r.childId)
    assert.equal(row.model, 'GLM-52', '日志记请求值')
    assert.equal(row.effort, 'turbo', '成功行补齐 effort 字段')
    assert.match(row.configNote, /model=GLM-52/)
    assert.match(row.configNote, /effort=turbo/)
    assert.equal(row.configError, undefined)
  })

  it('合法值不产生注记', async () => {
    const { dispatcher, logs, parentAgent } = makeHarness()
    await dispatcher.dispatch(parentAgent, AGENT_ID, '合法任务', { reuse: 'fresh' })
    const row = logs().find((r) => r.ok === true && r.childId)
    assert.equal(row.configNote, undefined)
    assert.equal(row.effort, 'high')
  })

  it("'default' 模型 + 空 effort：不下发 productSettings（用产品默认）", async () => {
    const { dispatcher, started, logs, parentAgent } = makeHarness({
      routes: [{ provider: 'deveco', model: 'default', effort: '' }],
    })
    await dispatcher.dispatch(parentAgent, AGENT_ID, '默认档任务', { reuse: 'fresh' })
    assert.equal(started[0].request.productSettings, undefined)
    assert.equal(started[0].request.agentOptions, undefined, 'ACP 档不得塞 LLM agentOptions')
    const row = logs().find((r) => r.ok === true && r.childId)
    assert.equal(row.model, null, "'default' 不落 model 值，日志为 null")
    assert.equal(row.effort, null)
    assert.equal(row.configNote, undefined)
  })

  it('设置下发抛错：任务仍成功，降级记在成功行的 configError（不再整轮 ok:false）', async () => {
    const { dispatcher, logs, emitted, parentAgent } = makeHarness({
      routes: [{ provider: 'deveco', model: 'GLM-5.1', effort: 'high' }],
      emitThrows: true,
    })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '下发失败任务', { reuse: 'fresh' })

    assert.equal(res.ok, true, '设置未送达不得让派发失败')
    assert.equal(emitted[0].event, 'product-subagents/apply-child-settings')
    assert.deepEqual(emitted[0].payload.settings, { model: 'GLM-5.1', reasoningEffort: 'high' })
    assert.ok(!logs().some((r) => r.ok === false), '不再有 apply-child-settings 的假失败行')
    const row = logs().find((r) => r.ok === true && r.childId)
    assert.match(row.configError, /apply-child-settings failed: listener boom/)
  })

  it('目录读取器抛错时静默跳过预检（可观测性不反噬派发）', async () => {
    const { dispatcher, started, logs, parentAgent } = makeHarness({
      routes: [{ provider: 'deveco', model: 'GLM-52', effort: 'turbo' }],
    })
    dispatcher.productCatalog = () => {
      throw new Error('stat 失败')
    }
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '目录抛错任务', { reuse: 'fresh' })
    assert.equal(res.ok, true)
    assert.equal(started.length, 1)
    assert.equal(logs().find((r) => r.ok === true && r.childId).configNote, undefined)
  })

  it('未注入目录（老调用方）：行为与注入空目录一致，不报错', async () => {
    const { dispatcher, started, logs, parentAgent } = makeHarness({ catalog: null })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '无目录任务', { reuse: 'fresh' })
    assert.equal(res.ok, true)
    assert.equal(started.length, 1)
    assert.equal(logs().find((r) => r.ok === true && r.childId).configNote, undefined)
  })

  it('回归：ACP 档创建期失败必须换到下一档（catch 里读 productSettings 曾抛 ReferenceError）', async () => {
    const { dispatcher, started, logs, parentAgent } = makeHarness({
      routes: [
        { provider: 'deveco', model: 'GLM-52', effort: 'turbo' },
        { provider: 'opencode', model: 'zen-main-free' },
      ],
      failOn: 'deveco',
    })
    const res = await dispatcher.dispatch(parentAgent, AGENT_ID, '换档回归任务', { reuse: 'fresh' })

    assert.equal(res.ok, true, '首档失败后必须换档成功，而不是整轮抛异常')
    assert.deepEqual(started.map((s) => s.provider), ['opencode'])
    const failed = logs().find((r) => r.ok === false)
    assert.equal(failed.provider, 'deveco')
    assert.equal(failed.error, 'deveco 起不来', '如实记录真实错误，而非作用域报错')
    assert.equal(failed.model, 'GLM-52')
    assert.equal(failed.effort, 'turbo')
    assert.match(failed.configNote, /model=GLM-52/, '失败档若同时是可疑值，日志要能看出关联')
  })
})

describe('effectiveConfigValue：从 configOptions 快照取产品实际生效值', () => {
  it('id 精确匹配优先（三种产品实测形态）', () => {
    const opencode = [
      { id: 'model', category: 'model', currentValue: 'zen-main' },
      { id: 'effort', category: 'thought_level', currentValue: 'low' },
    ]
    assert.equal(effectiveConfigValue(opencode, 'model'), 'zen-main')
    assert.equal(effectiveConfigValue(opencode, 'effort'), 'low')
    // qoder：effort 与 model 共享 category=model，只能靠 id 区分
    const qoder = [
      { id: 'model', category: 'model', currentValue: 'pro' },
      { id: 'reasoning_effort', category: 'model', currentValue: 'high' },
    ]
    assert.equal(effectiveConfigValue(qoder, 'model'), 'pro')
    assert.equal(effectiveConfigValue(qoder, 'effort'), 'high')
  })

  it('id 不命中时按 category 兜底，且不把对方的项当自己', () => {
    const anonymous = [
      { id: 'x1', category: 'model', currentValue: 'm-a' },
      { id: 'x2', category: 'thought_level', currentValue: 't-b' },
    ]
    assert.equal(effectiveConfigValue(anonymous, 'model'), 'm-a')
    assert.equal(effectiveConfigValue(anonymous, 'effort'), 't-b')
    // deveco 只有 model + mode：问 effort 拿不到就返回 null，绝不拿 mode 顶替
    const deveco = [{ id: 'model', category: 'model', currentValue: 'GLM-5.1' }]
    assert.equal(effectiveConfigValue(deveco, 'effort'), null)
    // 唯一的项是 effort 形态（category=model 但 id 属于 effort 名单）→ 不算 model 生效值
    assert.equal(effectiveConfigValue([{ id: 'reasoning_effort', category: 'model', currentValue: 'high' }], 'model'), null)
  })

  it('快照缺失 / 无 currentValue / 空白值 → null（不猜）', () => {
    assert.equal(effectiveConfigValue(null, 'model'), null)
    assert.equal(effectiveConfigValue('不是数组', 'model'), null)
    assert.equal(effectiveConfigValue([{ id: 'model' }], 'model'), null)
    assert.equal(effectiveConfigValue([{ id: 'model', currentValue: '   ' }], 'model'), null)
    assert.equal(effectiveConfigValue([{ id: 'model', currentValue: '  GLM-5.1 ' }], 'model'), 'GLM-5.1', '去空白')
  })
})

describe('logConfigOptionError：产品拒绝配置项时落一行观测日志', () => {
  it('写 kind:config 行，含 requested / effective / kind，且不落全量快照', async () => {
    const { dispatcher, rows, parentAgent } = makeHarness({ routes: [{ provider: 'deveco', model: 'GLM-52' }] })
    await dispatcher.dispatch(parentAgent, AGENT_ID, '降级观测任务', { reuse: 'fresh' })
    const childId = 'child-1'
    dispatcher.logConfigOptionError({
      childId,
      product: 'deveco',
      kind: 'model',
      requested: 'GLM-52',
      error: 'agent 未提供 model 配置项\n沿用 agent 自身配置',
      configOptions: [
        { id: 'model', category: 'model', currentValue: 'GLM-5.1', options: [{ value: 'GLM-5.1', name: '智谱' }] },
      ],
      at: Date.now(),
    })
    const row = rows().find((r) => r.kind === 'config')
    assert.equal(row.phase, 'option-error')
    assert.equal(row.childId, childId)
    assert.equal(row.agentId, AGENT_ID, '活跃 child 命中 → 回填 agentId')
    assert.equal(row.provider, 'deveco')
    assert.equal(row.configKind, 'model')
    assert.equal(row.requested, 'GLM-52', '只记请求值')
    assert.equal(row.effective, 'GLM-5.1', '产品实际沿用的值')
    assert.equal(row.unchanged, false)
    assert.equal(row.error, 'agent 未提供 model 配置项 沿用 agent 自身配置', '换行压平为一行')
    assert.equal('configOptions' in row, false, '不落全量快照（体积 + 可能夹带产品私有信息）')
    assert.equal('taskText' in row, false, '观测行不带任务内容')
    assert.equal(row.ok, true, 'config 行不是失败记录')
  })

  it('child 已结算（活跃表里没有）时仍记产品与请求值，agentId 留 null', () => {
    const { dispatcher, rows } = makeHarness()
    dispatcher.logConfigOptionError({ childId: 'gone', product: 'qoder', kind: 'effort', requested: 'ultra', error: '不支持', configOptions: [] })
    const row = rows().find((r) => r.kind === 'config')
    assert.equal(row.agentId, null)
    assert.equal(row.provider, 'qoder', '查不到 child 时退回事件里的 product')
    assert.equal(row.effective, null)
  })

  it('kind 不认识 / payload 为空 → 直接丢弃，不写行也不抛', () => {
    const { dispatcher, rows } = makeHarness()
    dispatcher.logConfigOptionError(null)
    dispatcher.logConfigOptionError({})
    dispatcher.logConfigOptionError({ kind: 'mode', requested: 'agent', configOptions: [] })
    assert.deepEqual(rows(), [])
  })

  it('同一 child 反复拒绝：每次都落一行（P 侧已按 kind:value 去重告警）', () => {
    const { dispatcher, rows } = makeHarness()
    const info = { childId: 'c', product: 'deveco', kind: 'model', requested: 'GLM-52', error: 'e', configOptions: [{ id: 'model', currentValue: 'GLM-5.1' }] }
    dispatcher.logConfigOptionError(info)
    dispatcher.logConfigOptionError(info)
    assert.equal(rows().filter((r) => r.kind === 'config').length, 2)
  })
})
