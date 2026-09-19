// v1.11.12：/agent-api 的 ACP 数据面测试。
// 全部走桩 ctx（无真实 CLI、无网络）：临时 DSH_HOME + 手写 provider-catalog.json +
// 假 webServer 捕获 REST handler，直接调用它断言响应。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const CATALOG_REL = path.join('data', 'dsh-plugin-product-subagents', 'provider-catalog.json')

let modPromise = null
const loadMod = () => (modPromise ||= import(path.join(root, 'index.js')))

/**
 * 起一个插件实例并把 REST handler 钓出来。
 * @param o.catalog 缓存文件内容（字符串=原样写，对象=JSON.stringify，null/undefined=不写）
 * @param o.llm ctx.get('llm') 桩；o.settings ctx.get('settings') 桩；o.subagents ctx.subagents 桩
 * @param o.emitThrows ctx.emit 抛错（模拟事件总线故障）
 */
async function boot(o = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dad-api-'))
  if (o.catalog !== undefined && o.catalog !== null) {
    const file = path.join(home, CATALOG_REL)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, typeof o.catalog === 'string' ? o.catalog : JSON.stringify(o.catalog), 'utf8')
  }
  const prevHome = process.env.DSH_HOME
  process.env.DSH_HOME = home

  const emitted = []
  const listeners = new Map()
  let emitThrows = o.emitThrows
  let handler = null
  const ws = {
    register: (route) => {
      handler = route.handler
      return () => {}
    },
  }
  const services = { webServer: ws, llm: o.llm, settings: o.settings }
  const ctx = {
    tools: { register: () => () => {}, guard: () => () => {}, view: () => ({ knownNames: [] }) },
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    subagents: 'subagents' in o ? o.subagents : { list: () => ['qoder'], getProvider: (p) => (p === 'qoder' ? { id: p } : undefined) },
    get: (k) => services[k],
    on: (name, fn) => {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name)?.delete(fn)
    },
    emit: (name, payload) => {
      if (emitThrows) throw new Error('事件总线故障')
      emitted.push({ name, payload })
    },
    effect: () => {},
    waterfall: (_t, _e, value) => value,
  }

  const mod = await loadMod()
  const dispose = mod.apply(ctx)
  // REST 注册走 500ms 轮询（webServer 可能晚于本插件激活），等到钓到为止
  for (let i = 0; i < 200 && !handler; i++) await new Promise((r) => setTimeout(r, 10))
  if (!handler) {
    try { dispose?.() } catch { /* ignore */ }
    process.env.DSH_HOME = prevHome
    throw new Error('REST handler 未注册')
  }

  return {
    home,
    emitted,
    /** 触发宿主事件（模拟 product-subagents 发 provider-catalog-updated） */
    fireEvent: (name, payload) => (listeners.get(name) || new Set()).forEach((fn) => fn(payload)),
    setEmitThrows: (v) => { emitThrows = v },
    req: (method, url, body) => call(handler, method, url, body),
    async close() {
      try { dispose?.() } catch { /* ignore */ }
      process.env.DSH_HOME = prevHome
      rmSync(home, { recursive: true, force: true })
    },
  }
}

/** 假 req/res：只实现 restHandler 用到的那部分 */
function call(handler, method, url, body) {
  return new Promise((resolve, reject) => {
    // 保活：readLlmEfforts 的等待上限用的是 unref 定时器。若事件循环只剩它，
    // Node 会直接排空 → node:test 报 "event loop has already resolved" 并取消后续用例。
    const alive = setInterval(() => {}, 25)
    const fail = setTimeout(() => { clearInterval(alive); reject(new Error('请求超时（15s 未响应）')) }, 15000)
    const settle = (fn, arg) => { clearInterval(alive); clearTimeout(fail); fn(arg) }
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = {
      method,
      url,
      on(ev, cb) {
        if (ev === 'data' && payload !== null) setTimeout(() => cb(payload), 0)
        else if (ev === 'end') setTimeout(() => cb(), 0)
        return this
      },
      destroy() {},
    }
    let status = 0
    const res = {
      writeHead(code) { status = code },
      end(text) {
        try {
          settle(resolve, { status, json: JSON.parse(String(text)) })
        } catch (e) {
          settle(reject, new Error('响应不是 JSON: ' + String(text).slice(0, 200) + ' / ' + e.message))
        }
      },
    }
    Promise.resolve(handler(req, res)).catch((e) => settle(reject, e))
  })
}

describe('GET /agent-api：ACP provider 目录的缺失与损坏降级', () => {
  it('缓存文件不存在 → productModels 为 {} 且接口正常返回', async () => {
    const b = await boot()
    try {
      const { status, json } = await b.req('GET', '/agent-api')
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      assert.deepEqual(json.productModels, {})
      assert.deepEqual(json.subagentProviders, ['qoder'])
      assert.equal(json.models.qoder, undefined) // ACP 绝不并入 models
    } finally {
      await b.close()
    }
  })

  it('JSON 损坏 → productModels 为 {} 且不抛', async () => {
    const b = await boot({ catalog: '{ not json' })
    try {
      const { status, json } = await b.req('GET', '/agent-api')
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      assert.deepEqual(json.productModels, {})
    } finally {
      await b.close()
    }
  })

  it('version 不认识 → productModels 为 {}（宁可不给数据，不喂错数据）', async () => {
    const b = await boot({ catalog: { version: 2, providers: { qoder: { models: ['m1'] } } } })
    try {
      const { json } = await b.req('GET', '/agent-api')
      assert.deepEqual(json.productModels, {})
    } finally {
      await b.close()
    }
  })

  it('providers 形状不符 / 条目非对象 → 丢弃但不抛', async () => {
    const b = await boot({ catalog: { version: 1, providers: { qoder: 'nope', deveco: null, opencode: { models: ['zen'] } } } })
    try {
      const { json } = await b.req('GET', '/agent-api')
      assert.deepEqual(json.productModels, { opencode: { models: ['zen'], efforts: [] } })
    } finally {
      await b.close()
    }
  })

  it('净化字段：丢 source、剔非字符串项、保留 error 空条目（GUI 据此手输 model）', async () => {
    const b = await boot({
      catalog: {
        version: 1,
        updatedAt: 'x',
        providers: {
          qoder: { models: [], efforts: [], source: 'acp', probedAt: '2026-09-18T00:00:00.000Z', error: 'probe timeout' },
          deveco: {
            models: ['GLM-5.1', 42, '', { id: 'x' }],
            efforts: ['low', 'high'],
            modelEfforts: { 'GLM-5.1': ['low', 7, null], bad: [] },
          },
        },
      },
    })
    try {
      const { json } = await b.req('GET', '/agent-api')
      assert.deepEqual(json.productModels, {
        qoder: { models: [], efforts: [], probedAt: '2026-09-18T00:00:00.000Z', error: 'probe timeout' },
        deveco: { models: ['GLM-5.1'], efforts: ['low', 'high'], modelEfforts: { 'GLM-5.1': ['low'] } },
      })
      assert.equal('source' in json.productModels.qoder, false)
    } finally {
      await b.close()
    }
  })

  it('宿主无 ctx.subagents.list（旧宿主）/ list 抛错 → subagentProviders 为 []', async () => {
    const noList = await boot({ subagents: {} })
    try {
      const { json } = await noList.req('GET', '/agent-api')
      assert.deepEqual(json.subagentProviders, [])
    } finally {
      await noList.close()
    }
    const boom = await boot({ subagents: { list: () => { throw new Error('宿主未就绪') } } })
    try {
      const { json } = await boom.req('GET', '/agent-api')
      assert.deepEqual(json.subagentProviders, [])
    } finally {
      await boom.close()
    }
  })

  it('provider-catalog-updated 事件立即失效读缓存（不必等 TTL）', async () => {
    const b = await boot()
    try {
      assert.deepEqual((await b.req('GET', '/agent-api')).json.productModels, {})
      const file = path.join(b.home, CATALOG_REL)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, providers: { qoder: { models: ['m-new'], efforts: ['low'] } } }), 'utf8')
      // 3s TTL 内：没有事件时应仍读到旧的 {}（证明缓存生效）
      assert.deepEqual((await b.req('GET', '/agent-api')).json.productModels, {})
      b.fireEvent('product-subagents/provider-catalog-updated', { provider: 'qoder' })
      assert.deepEqual((await b.req('GET', '/agent-api')).json.productModels, { qoder: { models: ['m-new'], efforts: ['low'] } })
    } finally {
      await b.close()
    }
  })

  it('defaultModel 只认 provider+model 都非空（否则 GUI 渲染 undefined/undefined）', async () => {
    const half = await boot({ settings: { get: (k) => (k === 'agent-default-model' ? {} : undefined) } })
    try {
      assert.equal((await half.req('GET', '/agent-api')).json.defaultModel, null)
    } finally {
      await half.close()
    }
    const full = await boot({ settings: { get: (k) => (k === 'agent-default-model' ? { provider: 'deepseek-official', model: 'deepseek-flash' } : undefined) } })
    try {
      assert.deepEqual((await full.req('GET', '/agent-api')).json.defaultModel, { provider: 'deepseek-official', model: 'deepseek-flash' })
    } finally {
      await full.close()
    }
  })
})

describe('POST /agent-api/probe-product-models：payload 契约与 accepted 语义', () => {
  it('省略 provider → emit {reason} 且不带 provider 键；响应 accepted:true', async () => {
    const b = await boot()
    try {
      const { status, json } = await b.req('POST', '/agent-api/probe-product-models', {})
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      assert.equal(json.accepted, true)
      assert.equal('provider' in json, false)
      assert.equal(b.emitted.length, 1)
      assert.equal(b.emitted[0].name, 'product-subagents/probe-provider')
      assert.deepEqual(b.emitted[0].payload, { reason: 'gui-agent-form' })
    } finally {
      await b.close()
    }
  })

  it('指定 provider → 去空白后透传给 payload 与响应', async () => {
    const b = await boot()
    try {
      const { json } = await b.req('POST', '/agent-api/probe-product-models', { provider: '  qoder  ' })
      assert.equal(json.accepted, true)
      assert.equal(json.provider, 'qoder')
      assert.deepEqual(b.emitted[0].payload, { provider: 'qoder', reason: 'gui-agent-form' })
    } finally {
      await b.close()
    }
  })

  it('emit 抛错 → 仍 HTTP 200 但 accepted:false + error（客户端据此报错）', async () => {
    const b = await boot({ emitThrows: true })
    try {
      const { status, json } = await b.req('POST', '/agent-api/probe-product-models', {})
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      assert.equal(json.accepted, false)
      assert.match(json.error, /探测请求发送失败/)
      assert.match(json.error, /事件总线故障/)
    } finally {
      await b.close()
    }
  })

  it('探测请求会失效本插件的目录读缓存（写完新目录立刻可见）', async () => {
    const b = await boot()
    try {
      assert.deepEqual((await b.req('GET', '/agent-api')).json.productModels, {})
      const file = path.join(b.home, CATALOG_REL)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ version: 1, providers: { qoder: { models: ['m-after-probe'] } } }), 'utf8')
      await b.req('POST', '/agent-api/probe-product-models', {})
      assert.deepEqual((await b.req('GET', '/agent-api')).json.productModels, { qoder: { models: ['m-after-probe'], efforts: [] } })
    } finally {
      await b.close()
    }
  })
})

describe('provider 目录的显示名契约（v1.11.12 增量：value 落盘 / name 显示）', () => {
  const bootCatalog = async (providers) => {
    const b = await boot({ catalog: { version: 1, providers } })
    try {
      return (await b.req('GET', '/agent-api')).json.productModels
    } finally {
      await b.close()
    }
  }

  it('options 净化：value 非法项丢弃、按 value 去重、name/description 空白不落键', async () => {
    const pm = await bootCatalog({
      deveco: {
        models: ['GLM-5.1'],
        efforts: [],
        modelOptions: [
          { value: 'GLM-5.1', name: '智谱 GLM-5.1' },
          { value: 'Doubao-1.5', name: '豆包 1.5', description: '  上下文 <32k  ' },
          { value: '   ', name: '空 value 丢弃' },
          { name: '缺 value 丢弃' },
          { value: 42 },
          '字符串项丢弃',
          null,
          { value: 'GLM-5.1', name: '重复项丢弃' },
        ],
        effortOptions: [{ value: 'low', name: '低' }, { value: '' }],
      },
    })
    assert.deepEqual(pm, {
      deveco: {
        models: ['GLM-5.1', 'Doubao-1.5'], // values ∪ options（保序去重）
        efforts: ['low'],
        modelOptions: [
          { value: 'GLM-5.1', name: '智谱 GLM-5.1' },
          { value: 'Doubao-1.5', name: '豆包 1.5', description: '上下文 <32k' },
        ],
        effortOptions: [{ value: 'low', name: '低' }],
      },
    })
  })

  it('P 只给 options 不给 values 时，值列表照样能用（不至于退化成纯手输）', async () => {
    const pm = await bootCatalog({
      qoder: { modelOptions: [{ value: 'lite', name: 'Lite' }, { value: 'pro', name: 'Pro' }] },
    })
    assert.deepEqual(pm, {
      qoder: { models: ['lite', 'pro'], efforts: [], modelOptions: [{ value: 'lite', name: 'Lite' }, { value: 'pro', name: 'Pro' }] },
    })
  })

  it('modelEffortOptions 的值并入 modelEfforts；modelEfforts 值数组混对象也按选项净化', async () => {
    const pm = await bootCatalog({
      deveco: {
        models: ['GLM-5.1'],
        efforts: ['low', 'high'],
        modelEfforts: { 'GLM-5.1': ['low', { value: 'medium', name: '中' }, 7] },
        modelEffortOptions: { 'GLM-5.1': [{ value: 'high', name: '高' }], 'Doubao-1.5': [{ value: 'x' }] },
      },
    })
    assert.deepEqual(pm.deveco.modelEfforts, {
      'GLM-5.1': ['low', 'medium', 'high'],
      'Doubao-1.5': ['x'],
    })
    assert.deepEqual(pm.deveco.modelEffortOptions, {
      'GLM-5.1': [{ value: 'high', name: '高' }],
      'Doubao-1.5': [{ value: 'x' }],
    })
  })

  it('无 options 字段时响应形状不变（老 P 版本零回归，不塞空键）', async () => {
    const pm = await bootCatalog({ opencode: { models: ['zen-main-free'], efforts: ['low'] } })
    assert.deepEqual(pm, { opencode: { models: ['zen-main-free'], efforts: ['low'] } })
    assert.equal('modelOptions' in pm.opencode, false)
    assert.equal('effortOptions' in pm.opencode, false)
  })
})

describe('订阅 product-subagents/config-option-error（v1.11.12 增量：降级可见性接线）', () => {
  const logPath = (home) => path.join(home, 'data', 'dsh-agent-dispatch', 'dispatches.jsonl')
  const readRows = (home) =>
    existsSync(logPath(home))
      ? readFileSync(logPath(home), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : []

  it('事件 → 记 kind:config 观测行（requested/effective），且不进历史页', async () => {
    const b = await boot()
    try {
      b.fireEvent('product-subagents/config-option-error', {
        childId: null,
        product: 'deveco',
        kind: 'model',
        requested: 'GLM-52',
        error: 'agent 未提供 model 配置项',
        configOptions: [{ id: 'model', category: 'model', currentValue: 'GLM-5.1' }],
        at: Date.now(),
      })
      const row = readRows(b.home).find((r) => r.kind === 'config')
      assert.ok(row, '订阅未接上')
      assert.equal(row.requested, 'GLM-52')
      assert.equal(row.effective, 'GLM-5.1')
      assert.equal(row.provider, 'deveco')
      const { status, json } = await b.req('GET', '/agent-api/dispatches')
      assert.equal(status, 200)
      assert.ok(!json.dispatches.some((r) => r.kind === 'config'), '观测行不是一次委派，不该出现在历史页')
    } finally {
      await b.close()
    }
  })

  it('kind 不认识（旧版 P 改名）→ 不写行、不抛', async () => {
    const b = await boot()
    try {
      b.fireEvent('product-subagents/config-option-error', { kind: 'mode', requested: 'agent', configOptions: [] })
      b.fireEvent('product-subagents/config-option-error', null)
      assert.deepEqual(readRows(b.home), [])
    } finally {
      await b.close()
    }
  })
})

describe('llmEfforts：适配器档位收集的可控性', () => {
  const llmWith = (modelCount, resolveModelInfo) => ({
    llm: {
      listProviders: async () => [{ id: 'deepseek-official' }],
      listModels: async () => Array.from({ length: modelCount }, (_, i) => ({ id: 'm' + i })),
      resolveModelInfo,
    },
  })

  it('resolveModelInfo 抛错（无该档适配器）→ 该 provider 无档位键，接口不报错', async () => {
    const b = await boot(llmWith(2, () => { throw new Error('unsupported') }))
    try {
      const { json } = await b.req('GET', '/agent-api')
      assert.equal(json.ok, true)
      assert.deepEqual(json.llmEfforts, {})
    } finally {
      await b.close()
    }
  })

  it('正常档位上报 → efforts + defaultEffort，非字符串项被净化', async () => {
    const b = await boot(llmWith(1, async () => ({ reasoning: { efforts: [{ id: 'low' }, 'high', 9], defaultEffort: 'low' } })))
    try {
      const { json } = await b.req('GET', '/agent-api')
      assert.deepEqual(json.llmEfforts, { 'deepseek-official': { m0: { efforts: ['low', 'high'], defaultEffort: 'low' } } })
    } finally {
      await b.close()
    }
  })

  it('单请求探测预算上限 24：超出的模型本轮不下发档位', async () => {
    let calls = 0
    const b = await boot(llmWith(30, async () => { calls++; return { reasoning: { efforts: ['low'] } } }))
    try {
      const { json } = await b.req('GET', '/agent-api')
      assert.equal(calls, 24)
      assert.equal(Object.keys(json.llmEfforts['deepseek-official']).length, 24)
    } finally {
      await b.close()
    }
  })

  it('resolveModelInfo 挂死 → 1.2s 等待上限内返回（不拖死 /agent-api）', async () => {
    const b = await boot(llmWith(2, () => new Promise(() => {})))
    try {
      const t0 = Date.now()
      const { json } = await b.req('GET', '/agent-api')
      assert.ok(Date.now() - t0 < 3000, 'GET 被挂死的探测拖长了')
      assert.equal(json.ok, true)
      assert.deepEqual(json.llmEfforts, {})
    } finally {
      await b.close()
    }
  })
})

describe('REST upsert 与 ACP model 必填放宽一致（数据面闭环）', () => {
  const agent = (routes) => ({ agent: { id: 'a1', name: 'A', systemPrompt: 'p', routes } })

  it('ACP 路由 model 留空 → 200 接受', async () => {
    const b = await boot()
    try {
      const { status, json } = await b.req('POST', '/agent-api/upsert', agent([{ provider: 'qoder' }]))
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      const list = (await b.req('GET', '/agent-api')).json.agents
      assert.deepEqual(list[0].routes, [{ provider: 'qoder' }])
    } finally {
      await b.close()
    }
  })

  it('LLM 路由 model 留空 → 400 拒绝（放宽不影响 LLM）', async () => {
    const b = await boot()
    try {
      const { status, json } = await b.req('POST', '/agent-api/upsert', agent([{ provider: 'deepseek-official' }]))
      assert.equal(status, 400)
      assert.equal(json.ok, false)
      assert.match(json.error, /缺少有效 model/)
    } finally {
      await b.close()
    }
  })
})
