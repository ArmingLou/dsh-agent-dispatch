// v1.11.12：GUI 侧表单判定逻辑测试。
// lib/client.js 是浏览器 classic script（依赖 window/React），无法 import；
// 这里把【真正跑的】那几个纯判定函数从源码里抠出来、注入依赖后直接执行——
// 改坏源码会让取不到/闭合不匹配而报错，改坏判定则被真断言拦下。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

/** 取多行箭头函数/函数声明的完整源码（startMarker 起，到第一个 endMarker 止，含 endMarker） */
function grab(startMarker, endMarker = '\n      };') {
  const i = src.indexOf(startMarker)
  assert.ok(i >= 0, `client.js 中找不到 "${startMarker}"（函数被改名或删除？）`)
  const j = src.indexOf(endMarker, i)
  assert.ok(j > i, `"${startMarker}" 之后找不到闭合 "${endMarker}"`)
  return src.slice(i, j + endMarker.length)
}
/** 取单行定义 */
function grabLine(needle) {
  const line = src.split('\n').find((l) => l.trim().startsWith(needle))
  assert.ok(line, `client.js 中找不到单行定义 "${needle}"`)
  return line.trim()
}
const asExpr = (code) => code.replace(/^\s*(?:const|let)\s+\w+\s*=\s*/, '').replace(/;\s*$/, '')
const build = (code, deps) => new Function(...Object.keys(deps), 'return (' + asExpr(code) + ')')(...Object.values(deps))

const strListSrc = grabLine('const strList = (v) =>')
const msgSrc = grabLine('function msg(e)')

// ── M1：ACP 目录可信判定（决定 model 格是 select 还是可手输输入框）──
const makeTrusted = (catalog) => build(grab('const acpCatalogTrusted = (prov) => {'), {
  acpCatalog: catalog,
  strList: build(strListSrc, {}),
})

describe('ACP 目录可信判定（探测失败也要能手输 model）', () => {
  it('未探测 / 探测失败 / 空目录都算不可信 → 退化手输', () => {
    const f = makeTrusted({
      qoder: { models: [], efforts: [], error: 'probe timeout' },
      deveco: { models: [], efforts: [] },
      opencode: { models: ['zen'], efforts: ['low'] },
      badtype: { models: [42, '', null], efforts: [] },
    })
    assert.equal(f('ghost'), false, '目录里没有的 provider 应不可信')
    assert.equal(f('qoder'), false, '带 error 的空条目应不可信（终审 M1 场景）')
    assert.equal(f('deveco'), false, '无 error 但 models 为空也应不可信')
    assert.equal(f('badtype'), false, 'models 里全是非字符串也应不可信')
    assert.equal(f('opencode'), true, '有真实 models 才可信')
    assert.equal(f(''), false)
    assert.equal(f(undefined), false)
  })

  it('modelFallback：ACP 行按目录可信度逐行决定渲染形态', () => {
    const catalog = { qoder: { models: [], efforts: [], error: 'x' }, deveco: { models: ['GLM-5.1'], efforts: [] } }
    const f = build(grab('const modelFallback = (prov) => {'), {
      isAcpProvider: (p) => p === 'qoder' || p === 'deveco',
      acpCatalogTrusted: makeTrusted(catalog),
      llmProviders: ['deepseek-official'],
      // modelFallback 的实际依赖是 modelChoices（不含「默认」项——默认项由渲染处前置，见增量 3）
      modelChoices: (p) => (p === 'deepseek-official' ? ['deepseek-flash'] : ['default']),
    })
    assert.equal(f('qoder'), true, 'ACP 探测失败 → 手输（旧实现返回 false，用户没有填 model 的途径）')
    assert.equal(f('deveco'), false, 'ACP 目录可用 → 下拉')
    assert.equal(f('deepseek-official'), false)
    assert.equal(f(''), false, '未选 provider 且 LLM 有目录 → 下拉')
  })

  it('modelFallback：LLM 无目录 / 完全没有 provider 时仍手输', () => {
    const f = build(grab('const modelFallback = (prov) => {'), {
      isAcpProvider: () => false,
      acpCatalogTrusted: () => false,
      llmProviders: [],
      modelChoices: () => [],
    })
    assert.equal(f(''), true)
    assert.equal(f('some-llm'), true)
  })
})

// ── 需求①核心：存值不在候选里时注入，避免受控 select 显示空白 ──
describe('choicesWithStored：注入存值并保持可选中', () => {
  const f = build(grab('const choicesWithStored = (values, stored) => {'), {})
  it('存值不在表中 → 插到首位并标 stale', () => {
    const r = f(['deepseek-flash', 'deepseek-v4-pro'], 'deepseek-v4-flash')
    assert.equal(r.stale, true)
    assert.deepEqual(r.list, ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro'])
  })
  it('空目录 + 有存值（ACP 未探测）→ 仍有该候选，select 不会 selectedIndex=-1', () => {
    const r = f([], 'GLM-5.1')
    assert.deepEqual(r.list, ['GLM-5.1'])
    assert.equal(r.stale, true)
  })
  it('命中/无存值 → 原样不标 stale；不改动入参数组', () => {
    const input = ['a', 'b']
    assert.deepEqual(f(input, 'a'), { list: ['a', 'b'], stale: false })
    assert.deepEqual(f(input, ''), { list: ['a', 'b'], stale: false })
    assert.deepEqual(input, ['a', 'b'])
  })
})

// ── 需求⑥：路由摘要不得出现 "qoder/undefined" ──
describe('routeSummary：缺 model 显示「默认模型」，绝不拼 undefined', () => {
  const f = build(grab('function routeSummary(r) {', '\n    }'), {})
  it('各形态', () => {
    assert.equal(f({ provider: 'qoder' }), 'qoder（默认模型）')
    assert.equal(f({ provider: 'qoder', model: 'm1' }), 'qoder/m1')
    assert.equal(f({ provider: 'qoder', model: 'm1', effort: 'high' }), 'qoder/m1@high')
    assert.equal(f({ provider: 'qoder', effort: 'high' }), 'qoder（默认模型）@high')
    assert.equal(f({ model: 'm1' }), '?/m1')
    assert.equal(f({}), '')
    assert.equal(f(null), '')
  })
  it('任何输入都不含 undefined/null 字面量', () => {
    for (const r of [{ provider: 'p' }, { provider: 'p', model: '' }, { model: 'm' }, { provider: '', model: '', effort: '' }]) {
      assert.doesNotMatch(f(r), /undefined|null/)
    }
  })
})

// ── 增量1 + 增量3：显示名（name）与落盘值（value）分离 + 默认项语义 ──
// 说明：v1.11.12 的最终实现把「默认」项从候选函数里挪到了渲染处（routeRows 里恒前置一个
// value="" 的 option），所以这里既断言纯函数（候选 / 显示名 / 档位 / 归一化），也用源码级
// 守卫锁定"下拉首位恒为一个 value="" 的默认项、且排在候选之前"这一结构，避免只测函数而漏掉渲染。
describe('ACP 选项元数据：value 落盘 / name 显示 / 默认项语义', () => {
  const strList = build(strListSrc, {})
  const optList = build(grabLine('const optList = (v) =>'), {})
  const labelMap = build(grab('const labelMap = (opts) => {'), {})
  const optName = build(grabLine('const optName = (map, value) =>'), {})
  const optDesc = build(grabLine('const optDesc = (map, value) =>'), {})
  const isUnset = build(grab('const isUnset = (v) => {'), {})
  const realOnly = build(grabLine('const realOnly = (list) =>'), { isUnset })
  const pickStr = build(grabLine('const pickStr = (v) =>'), {})
  const fmtDefault = build(grab('const fmtDefault = (value, labels, who) => {'), { pickStr, optName })
  const choicesWithStored = build(grab('const choicesWithStored = (values, stored) => {'), {})

  const ACP = new Set(['deveco', 'qoder', 'opencode'])
  const isAcpProvider = (p) => ACP.has(p)
  const CATALOG = {
    deveco: {
      models: ['GLM-5.1', 'Doubao-1.5'],
      efforts: ['low', 'medium', 'high'],
      modelOptions: [
        { value: 'GLM-5.1', name: '智谱 GLM-5.1', description: '上下文 128k' },
        { value: 'Doubao-1.5' },
      ],
      effortOptions: [{ value: 'low', name: '低' }, { value: 'medium', name: '中' }, { value: 'high', name: '高' }],
      modelEfforts: { 'GLM-5.1': ['low', 'high'] },
      modelEffortOptions: { 'GLM-5.1': [{ value: 'low', name: '低（快）' }, { value: 'high', name: '高（准）' }] },
    },
    qoder: { models: [], efforts: [], error: 'probe timeout' },
    // opencode 真实自报里就有一个字面 "default" 档位（实测），必须与「默认」项同义处理
    opencode: {
      models: ['zen', 'default', ''],
      efforts: ['low', 'default'],
      modelOptions: [{ value: 'zen', name: 'Zen 显示名' }, { value: 'default', name: '字面 default' }],
      effortOptions: [{ value: 'low', name: 'Low' }, { value: 'default', name: 'Default' }],
      defaultModel: 'zen',
      defaultEffort: 'low',
    },
  }
  const acpEntry = build(grabLine('const acpEntry = (prov) =>'), { isAcpProvider, acpCatalog: CATALOG })
  const modelChoices = build(grab('const modelChoices = (prov) => {'), {
    acpEntry, strList, realOnly, modelOptions: { 'deepseek-official': ['deepseek-flash'] },
  })
  const modelLabelsFor = build(grab('const modelLabelsFor = (prov) => {'), { acpEntry, optList, labelMap })
  const modelTextFor = build(grab('const modelTextFor = (prov, mid) => {'), { modelLabelsFor, optName })
  const modelDefaultText = build(grab('const modelDefaultText = (prov) => {'), { acpEntry, fmtDefault, modelLabelsFor })
  const effortsFor = build(grab('const effortsFor = (prov, mid) => {'), {
    acpEntry, strList, optList, labelMap, realOnly, pickStr,
    effortCatalog: { 'deepseek-official': { 'deepseek-flash': { efforts: ['low', 'high'], defaultEffort: 'high' } } },
  })

  it('option 文本用 name、value 仍是落盘值；没上报 name 就显示 value', () => {
    assert.equal(modelTextFor('deveco', 'GLM-5.1'), '智谱 GLM-5.1')
    assert.equal(modelTextFor('deveco', 'Doubao-1.5'), 'Doubao-1.5')
    assert.deepEqual(modelChoices('deveco'), ['GLM-5.1', 'Doubao-1.5'], '候选值不得被显示名替换')
    assert.equal(optDesc(modelLabelsFor('deveco'), 'GLM-5.1'), '上下文 128k')
    assert.equal(optDesc(modelLabelsFor('deveco'), 'Doubao-1.5'), undefined)
  })

  it('「默认」文本：产品自报 defaultModel 就写出来（走 name 映射），否则说明由谁决定', () => {
    assert.equal(modelDefaultText('opencode'), '默认（Zen 显示名）')
    assert.equal(modelDefaultText('deveco'), '默认（由 ACP 决定）')
    assert.equal(modelDefaultText('qoder'), '默认（由 ACP 决定）', '探测失败的 provider 也要有可读的默认项')
  })

  it('增量3：缺失 / 空串 / 字面 default 一律视为「不指定」，并从候选清单里摘掉', () => {
    assert.equal(isUnset(undefined), true)
    assert.equal(isUnset(null), true)
    assert.equal(isUnset(''), true)
    assert.equal(isUnset('   '), true)
    assert.equal(isUnset('default'), true)
    assert.equal(isUnset('DEFAULT'), true, '大小写不敏感')
    assert.equal(isUnset('low'), false)
    assert.equal(isUnset(0), false, '非字符串且非 null/undefined 不算不指定')
    assert.deepEqual(modelChoices('opencode'), ['zen'], '字面 default 不得与「默认」项重复出现')
    assert.deepEqual(effortsFor('opencode', 'zen').list, ['low'], 'opencode 的字面 default 档位同义摘除')
    assert.equal(effortsFor('opencode', 'zen').defaultEffort, 'low')
  })

  it('既有值零改写：手工填的可疑值原样进候选、不判非法、不阻止保存', () => {
    assert.equal(modelTextFor('deveco', 'GLM-52'), 'GLM-52')
    const r = choicesWithStored(modelChoices('deveco'), 'GLM-52')
    assert.equal(r.stale, true)
    assert.deepEqual(r.list, ['GLM-52', 'GLM-5.1', 'Doubao-1.5'], '可疑值仍进候选，选中态不丢')
  })

  it('effort：模型级目录优先，回退 provider 级；标签同样 name/value 分离', () => {
    const byModel = effortsFor('deveco', 'GLM-5.1')
    assert.deepEqual(byModel.list, ['low', 'high'])
    assert.equal(optName(byModel.labels, 'low'), '低（快）', '模型级标签优先')
    const byProvider = effortsFor('deveco', 'Doubao-1.5')
    assert.deepEqual(byProvider.list, ['low', 'medium', 'high'])
    assert.equal(optName(byProvider.labels, 'medium'), '中', 'provider 级 effortOptions 兜底')
    const noModel = effortsFor('deveco', '')
    assert.deepEqual(noModel.list, ['low', 'medium', 'high'])
  })

  it('effort：LLM 行用适配器真实档位与默认档；探测失败的 ACP 行无档位候选（退化手输）', () => {
    const llm = effortsFor('deepseek-official', 'deepseek-flash')
    assert.deepEqual(llm.list, ['low', 'high'])
    assert.equal(llm.defaultEffort, 'high')
    assert.equal(llm.labels.size, 0)
    const dead = effortsFor('qoder', 'm')
    assert.deepEqual(dead.list, [], '探测失败的 ACP 行不给档位候选（渲染层转手输）')
    assert.equal(dead.labels.size, 0)
  })

  it('非 ACP 且无 LLM 目录 → 空候选（渲染层据此走手输）', () => {
    assert.deepEqual(modelChoices('unknown-llm'), [])
    assert.deepEqual(effortsFor('unknown-llm', 'm').list, [])
  })

  it('源码级守卫：model / effort 下拉首位恒为一个 value="" 的「默认」项，且排在候选之前', () => {
    const mDefault = src.indexOf('acpRow ? modelDefaultText(r.provider) : "model…"')
    const mMap = src.indexOf('modelChoicesOfRow.list.map((mid) => React.createElement("option"')
    assert.ok(mDefault > 0 && mMap > mDefault, 'model 的默认项必须渲染在候选之前')
    assert.match(src.slice(Math.max(0, mDefault - 80), mDefault), /value:\s*""/, 'model 默认项的 value 必须是空串（= 不指定）')

    const eDefault = src.indexOf('}, effortDefaultText(effort)),')
    const eMap = src.indexOf('effortChoices.list.map((lv) => React.createElement("option"')
    assert.ok(eDefault > 0 && eMap > eDefault, 'effort 的默认项必须渲染在候选之前')
    assert.match(src.slice(Math.max(0, eDefault - 80), eDefault), /value:\s*""/, 'effort 默认项的 value 必须是空串（= 不指定）')
  })
})

// ── M4：探测请求被拒时不得静默 ──
// ManageTab 的 probeModels（AgentForm 里同名函数是另一个：只转调 onProbeModels，故用注释定位）
const PROBE_MODELS_MARKER = 'const probeModels = () => {\n        // 探测请求未被人处理时'

describe('ManageTab probeModels：accepted:false 必须报错', () => {
  const wire = (apiPostImpl) => {
    const errs = [], refreshes = []
    const f = build(grab(PROBE_MODELS_MARKER), {
      apiPost: apiPostImpl,
      setErr: (m) => errs.push(m),
      msg: build(msgSrc, {}),
      scheduleProbeRefresh: () => refreshes.push(1),
    })
    return { run: () => f(), errs, refreshes }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('accepted:false → 写错误条且不安排刷新', async () => {
    const t = wire(async () => ({ ok: true, accepted: false, error: '探测请求发送失败: no listener' }))
    t.run()
    await flush()
    assert.deepEqual(t.errs, ['探测请求发送失败: no listener'])
    assert.equal(t.refreshes.length, 0, '未被接受却仍刷新的话，用户看到的是"什么都没变"')
  })

  it('accepted:false 且无 error 文案 → 给兜底提示', async () => {
    const t = wire(async () => ({ ok: true, accepted: false }))
    t.run()
    await flush()
    assert.equal(t.errs.length, 1)
    assert.match(t.errs[0], /未被接受/)
  })

  it('accepted:true → 安排延迟刷新且不报错', async () => {
    const t = wire(async () => ({ ok: true, accepted: true }))
    t.run()
    await flush()
    assert.deepEqual(t.errs, [])
    assert.equal(t.refreshes.length, 1)
  })

  it('网络/HTTP 错误 → 走 catch 报错，不刷新', async () => {
    const t = wire(async () => { throw new Error('502 Bad Gateway') })
    t.run()
    await flush()
    assert.deepEqual(t.errs, ['502 Bad Gateway'])
    assert.equal(t.refreshes.length, 0)
  })
})
