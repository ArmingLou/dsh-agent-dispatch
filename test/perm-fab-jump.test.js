// v1.11.14(E)：黄球（.ad-perm-fab）点击跳转子代理会话的回归测试。
//
// 现场缺陷：点击黄球条目不再打开对应子代理对话页。根因不在本插件——dsh 0.1.7
// 起 sessions 服务不再负责导航（ISessions 注释："navigation belongs to view
// owners"），本插件依赖的 sessions.open / openSubagent / refreshSubagents 三个
// 方法在宿主包里已全部下线（全包 grep 零命中）→ openAgentSession 三条路都取不到
// 函数，必然返回 false。现行入口是 uiWorkspace.openSession(SessionTarget)。
//
// lib/client.js 是浏览器 classic script（依赖 window/document），无法 import——
// 沿用 test/client-form-logic.test.js 与 test/acp-twin.test.js 的做法：把真正跑的
// 那段源码抠出来、注入替身依赖后执行（编译对象是本仓库第一方源码，仅测试进程内）。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

/** 抠出从 startMarker 到首个 closeMarker 的原文（含闭合），改坏结构会直接断言失败 */
function sliceFn(startMarker, closeMarker) {
  const i = src.indexOf(startMarker)
  assert.ok(i >= 0, `client.js 中找不到 "${startMarker}"（该逻辑被改名或删除？）`)
  const j = src.indexOf(closeMarker, i)
  assert.ok(j > i, `"${startMarker}" 之后找不到闭合 "${closeMarker.trim()}"`)
  return src.slice(i, j + closeMarker.length)
}

/** 抠出一段无外部依赖的箭头函数并返回其值 */
function extractFn(startMarker, closeMarker, name) {
  return new Function(`${sliceFn(startMarker, closeMarker)}\nreturn ${name}`)()
}

const normalizeChildId = extractFn('const normalizeChildId = (id) => {', '\n        };', 'normalizeChildId')
const permRowsOf = extractFn('function permRowsOf(arr) {', '\n    }', 'permRowsOf')
// 生产版软取服务（属性 → ctx.get 双路），一并搬进测试执行，避免另写一份近似实现
const softService = extractFn('function softService(ctx, name) {', '\n    }', 'softService')

const OPEN_START = 'openAgentSession = (id, parentSessionId) => {'
const OPEN_CLOSE = '\n        };'
const OPEN_TAIL = 'return Promise.resolve(openViaSubagent()).then((ok) => ok || fallbackOpen())'

/**
 * 编译生产版 openAgentSession，注入宿主替身。
 * @param host {{uiWorkspace?: object, sessions?: object, ctx?: object}} 缺省表示该服务不存在
 * @returns {{open: (id: any, pid: any) => Promise<boolean>}}
 */
function compileOpenAgentSession(host = {}) {
  const raw = sliceFn(OPEN_START, OPEN_CLOSE)
  assert.ok(raw.includes(OPEN_TAIL), 'openAgentSession 尾部兜底逻辑被改写，测试边界失效')
  const factory = new Function(
    'ctx', 'sessions', 'normalizeChildId', 'captureCurrentSessionTitle', 'navPush', 'ensureChatView', 'softService',
    `var openAgentSession = null;\n${raw}\nreturn (id, pid) => openAgentSession(id, pid)`,
  )
  const ctx = host.ctx || {
    get: (name) => (name === 'uiWorkspace' ? (host.uiWorkspace ?? null) : (name === 'sessions' ? (host.sessions ?? null) : null)),
  }
  const open = factory(
    ctx,
    host.sessions ?? null,
    normalizeChildId,
    () => 'main-session',
    () => {},
    () => {},
    softService,
  )
  return { open }
}

/** 记录型 uiWorkspace.openSession；throwOn 用来模拟导航被宿主拒绝 */
function navStub(opts = {}) {
  const seen = []
  const svc = {
    openSession: (target) => {
      seen.push(target)
      if (typeof opts.throwOn === 'function' && opts.throwOn(target)) throw new Error('navigation refused')
    },
  }
  return { svc, seen }
}

describe('E 跳转主通道：uiWorkspace.openSession', () => {
  it('有父会话 → 用 {parentSessionId, childSessionId, mode:continuable} 地址打开子会话', async () => {
    const { svc, seen } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc })
    const ok = await open('child-A', 'parent-1')
    assert.equal(ok, true, '新通道必须报告成功（否则黄球只会提示而不跳转）')
    assert.deepEqual(seen, [{ parentSessionId: 'parent-1', childSessionId: 'child-A', mode: 'continuable' }])
  })

  it('宿主 catalog 已有该 child 的地址 → 优先用 catalog 地址（mode 由宿主定）', async () => {
    const { svc, seen } = navStub()
    const addr = { parentSessionId: 'parent-9', childSessionId: 'child-A', mode: 'one-shot' }
    const { open } = compileOpenAgentSession({ uiWorkspace: svc, sessions: { subagentAddress: () => addr } })
    assert.equal(await open('child-A', 'parent-1'), true)
    assert.deepEqual(seen, [addr], 'catalog 地址优先于自行组装（避免 mode 猜错）')
  })

  it('缺父会话（externalPending 合成条目）→ 退回裸 sessionId，不抛不崩', async () => {
    const { svc, seen } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc })
    assert.equal(await open('child-A', null), true)
    assert.deepEqual(seen, ['child-A'])
  })

  it('对象形态 childId（宿主 startContinuable 返回）→ 归一化后再跳', async () => {
    const { svc, seen } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc })
    assert.equal(await open({ childId: 'child-A' }, 'parent-1'), true)
    assert.equal(seen[0].childSessionId, 'child-A')
  })

  it('地址形态失败时回退裸 id 重试（catalog 未加载的窗口期不丢跳转）', async () => {
    const { svc, seen } = navStub({ throwOn: (t) => typeof t === 'object' })
    const { open } = compileOpenAgentSession({ uiWorkspace: svc })
    assert.equal(await open('child-A', 'parent-1'), true)
    assert.equal(seen.length, 2)
    assert.deepEqual(seen[1], 'child-A')
  })

  it('两条路都失败 → 返回 false（由黄球给出可见指引，不静默）', async () => {
    const { svc, seen } = navStub({ throwOn: () => true })
    const { open } = compileOpenAgentSession({ uiWorkspace: svc })
    assert.equal(await open('child-A', 'parent-1'), false)
    assert.equal(seen.length, 2, '应当真的尝试过两次')
  })

  it('无 childId → false 且不触碰导航（降级不崩）', async () => {
    const { svc, seen } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc })
    assert.equal(await open(null, 'parent-1'), false)
    assert.equal(seen.length, 0)
  })
})

describe('E 服务解析：uiWorkspace 故意不进 inject，两种取法都要容错', () => {
  it('ctx.get 因 fiber 时序返回 undefined，但 ctx.uiWorkspace 属性可用 → 仍能跳转', async () => {
    const { svc, seen } = navStub()
    const { open } = compileOpenAgentSession({ ctx: { uiWorkspace: svc, get: () => undefined } })
    assert.equal(await open('child-A', 'parent-1'), true)
    assert.equal(seen.length, 1)
  })

  it('属性读取抛 "without inject" 且 get 也拿不到 → 不崩，退回 sessions 旧通道', async () => {
    const seen = []
    const sessions = { openSubagent: (a) => seen.push(a), refreshSubagents: () => Promise.resolve() }
    const ctx = { get: () => null }
    Object.defineProperty(ctx, 'uiWorkspace', {
      get() { throw new Error('cannot get property "uiWorkspace" without inject') },
    })
    const { open } = compileOpenAgentSession({ ctx, sessions })
    assert.equal(await open('child-A', 'parent-1'), true, '属性抛错必须被吞掉并落到兜底通道')
    assert.deepEqual(seen, [{ parentSessionId: 'parent-1', childSessionId: 'child-A', mode: 'continuable' }])
  })
})

/** 宿主 mainView 引用计数替身（sessions.retainInfo(id).getSnapshot()） */
function retainStub(mainView, opts = {}) {
  return {
    retainInfo: () => ({
      getSnapshot: () => {
        if (opts.throwOnGet) throw new Error('snapshot unavailable')
        return { referenceCount: mainView, retainedBy: mainView > 0 ? { mainView } : {} }
      },
      subscribe: () => () => {},
    }),
  }
}

describe('m8 跳转结果三态：不因「没抛错」报乐观成功', () => {
  it('openSession 未抛错 + mainView 计数 >0 → true（已核实）', async () => {
    const { svc } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc, sessions: retainStub(1) })
    assert.equal(await open('child-A', 'parent-1'), true)
  })

  it('openSession 未抛错但 mainView 计数为 0 → 返回 \'unverified\'，黄球据此保留浮层', async () => {
    const { svc, seen } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc, sessions: retainStub(0) })
    assert.equal(await open('child-A', 'parent-1'), 'unverified')
    assert.equal(seen.length, 2, '未核实时应再试另一种地址形态')
  })

  it('老宿主没有 retainInfo → 无从核实，退回 true（不把能力缺失报成失败）', async () => {
    const { svc } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc, sessions: { subagentAddress: () => null } })
    assert.equal(await open('child-A', 'parent-1'), true)
  })

  it('retainInfo 取快照抛错 → 同样退回 true，不炸调用方', async () => {
    const { svc } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc, sessions: retainStub(0, { throwOnGet: true }) })
    assert.equal(await open('child-A', 'parent-1'), true)
  })

  it('新通道未核实 + 旧通道也不可用 → 仍是 \'unverified\'（不是 false）', async () => {
    const { svc } = navStub()
    const sessions = Object.assign(retainStub(0), { open: () => { throw new Error('gone in 0.1.7') } })
    const { open } = compileOpenAgentSession({ uiWorkspace: svc, sessions })
    assert.equal(await open('child-A', 'parent-1'), 'unverified')
  })

  it('从没成功调用过任何导航 API → false（与 unverified 可区分）', async () => {
    const { svc } = navStub({ throwOn: () => true })
    const { open } = compileOpenAgentSession({ uiWorkspace: svc, sessions: retainStub(0) })
    assert.equal(await open('child-A', 'parent-1'), false)
  })
})

describe('m6 softService：严格 ctx.get 抛错时仍走宽松路', () => {
  it('ctx.get(name) 抛 "without inject"、ctx.get(name,false) 可用 → 拿到服务', () => {
    const svc = { openSession: () => {} }
    const ctx = {
      get: (name, strict) => {
        if (strict === false) return name === 'uiWorkspace' ? svc : undefined
        throw new Error(`cannot get property "${name}" without inject`)
      },
    }
    Object.defineProperty(ctx, 'uiWorkspace', { get() { throw new Error('cannot get property "uiWorkspace" without inject') } })
    assert.equal(softService(ctx, 'uiWorkspace'), svc)
  })

  it('宽松路返回 undefined / 服务真不存在 → null，不抛', () => {
    assert.equal(softService({ get: () => undefined }, 'uiWorkspace'), null)
    assert.equal(softService({}, 'uiWorkspace'), null)
    assert.equal(softService(null, 'uiWorkspace'), null)
  })
})

describe('E 旧宿主兜底：sessions 导航方法仍在时不改行为', () => {  it('无 uiWorkspace + 有 openSubagent → 仍走 catalog 通道', async () => {
    const seen = []
    const sessions = {
      openSubagent: (addr) => seen.push(addr),
      refreshSubagents: () => Promise.resolve(),
    }
    const { open } = compileOpenAgentSession({ sessions })
    assert.equal(await open('child-A', 'parent-1'), true)
    assert.deepEqual(seen, [{ parentSessionId: 'parent-1', childSessionId: 'child-A', mode: 'continuable' }])
  })

  it('两个服务都没有 → false（不抛异常）', async () => {
    const { open } = compileOpenAgentSession({})
    assert.equal(await open('child-A', 'parent-1'), false)
  })
})

describe('E 黄球「每请求一行」→ 各行跳到自己的子会话', () => {
  const ACTIVE = [
    {
      childId: 'child-A',
      parentSessionId: 'parent-1',
      agentName: 'Qoder',
      permissionPendingList: [
        { permId: 'child-A#1', description: '允许读取 config' },
        { permId: 'child-A#2', description: 'Allow searching the web?' },
      ],
    },
    { childId: 'child-B', parentSessionId: 'parent-2', agentName: 'DevEco', permissionPending: { permId: 'child-B#1', description: '外部目录' } },
  ]

  it('3 行分别解析到自己的 childSessionId，不会错跳到主会话或别人的会话', async () => {
    const { svc, seen } = navStub()
    const { open } = compileOpenAgentSession({ uiWorkspace: svc })
    const rows = permRowsOf(ACTIVE)
    assert.equal(rows.length, 3)
    const okFlags = []
    for (const r of rows) okFlags.push(await open(r.childId, r.parentSessionId))
    assert.deepEqual(okFlags, [true, true, true])
    assert.deepEqual(seen, [
      { parentSessionId: 'parent-1', childSessionId: 'child-A', mode: 'continuable' },
      { parentSessionId: 'parent-1', childSessionId: 'child-A', mode: 'continuable' },
      { parentSessionId: 'parent-2', childSessionId: 'child-B', mode: 'continuable' },
    ])
    assert.equal(seen.every((t) => t.childSessionId !== 'parent-1' && t.childSessionId !== 'parent-2'), true, '绝不错跳到主会话')
  })
})

describe('E 点击接线（源码不变量）', () => {
  const from = src.indexOf('const renderPop = () => {')
  const to = src.indexOf('// 操作行：四个决策按钮')
  assert.ok(from > 0 && to > from, 'renderPop 边界被改写')
  const pop = src.slice(from, to)

  it('点击处理挂在整行 row 上（d3537d8 曾收窄到 info，点行内空白不再跳转）', () => {
    assert.match(pop, /row\.addEventListener\("click", openSelf\)/)
    assert.doesNotMatch(pop, /info\.addEventListener\("click"/)
  })

  it('只有核实过的成功才收起浮层；未核实/失败/缺标识都给可见文案', () => {
    // v1.11.14(m8)：旧接线是 `if (ok)`——openSession 只要没抛错就报成功并 hidePop，
    // 用户既看不到反馈也没法重试。现在只认 ok === true，其余分支留浮层 + 指引。
    assert.match(pop, /if \(ok === true\) \{ hidePop\(\); return; \}/)
    assert.doesNotMatch(pop, /if \(ok\) \{ hidePop\(\)/, '不得再因「没抛错」就收起浮层（乐观成功）')
    assert.equal((pop.match(/permTip\(/g) || []).length, 3, '缺 childId / 未跳转（含未核实） / 异常 三条路径都要有提示')
    assert.match(pop, /ok === "unverified"/, '"没抛错但未核实"要有区别于"跳不过去"的文案')
  })

  it('决策按钮不冒泡到行（点「允许一次」不该同时触发跳转）', () => {
    const btn = src.slice(src.indexOf('const mkBtn = (label, answer, cls, tip) => {'))
    assert.match(btn, /b\.addEventListener\("click", \(ev\) => \{[\s\S]{0,40}ev\.stopPropagation\(\);/)
  })
})
