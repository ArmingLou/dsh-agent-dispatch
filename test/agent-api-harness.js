// test/agent-api-harness.js — 起一个插件实例并把 /agent-api 的 REST handler 钓出来。
// 从 v1.11.12 起 test/agent-api-catalog.test.js 内部自带的桩；v1.12.4 提到独立模块，
// 供 host-approval 端点用例复用（同一套假 ctx / 假 webServer，避免两份桩各自漂移）。
// 全部走桩（无真实 CLI、无网络）：临时 DSH_HOME + 假 webServer 捕获 route.handler。
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

let modPromise = null
const loadMod = () => (modPromise ||= import(path.join(root, 'index.js')))

/**
 * @param o.catalog 缓存文件内容（字符串=原样写，对象=JSON.stringify，null/undefined=不写）
 * @param o.llm ctx.get('llm') 桩；o.settings ctx.get('settings') 桩；o.subagents ctx.subagents 桩
 * @param o.emitThrows ctx.emit 抛错（模拟事件总线故障）
 */
export async function boot(o = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dad-api-'))
  if (o.catalog !== undefined && o.catalog !== null) {
    const file = path.join(home, o.catalogRel || path.join('data', 'dsh-plugin-product-subagents', 'provider-catalog.json'))
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
    /**
     * 触发宿主事件。除 payload 外可再传后续实参——
     * 'approval/request' 这类 waterfall 监听器的签名是 (req, next)。
     * @returns {Array} 各监听器的返回值（waterfall 监听器可能返回 Promise）
     */
    fireEvent: (name, ...args) => {
      const outs = []
      for (const fn of listeners.get(name) || []) outs.push(fn(...args))
      return outs
    },
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
export function call(handler, method, url, body) {
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

/**
 * 构造一个够用的假宿主 Session：header 决定会话形态（子代理 / fork / 普通会话），
 * toolCalls 提供 callId 反查用的 tool/call 事件（服务端据此解析路径，不信任客户端）。
 */
export function mkSession({ id, cwd = '/home/test', parentSession = null, fork = false, toolCalls = [] }) {
  const events = toolCalls.map((tc) => ({
    type: 'tool/call',
    data: { callId: tc.callId, name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments) },
  }))
  const header = { cwd }
  if (parentSession) {
    header.parentSession = parentSession
    // fork 形态 = 有 parentSession、**无** origin / delegationDepth。宿主还带一个血统
    // 标记，但它随宿主版本而变（DSH 运行时安装树是 dsh-session@0.2.0-rc.2，落 isSeeded；
    // 0.1.0-rc.6 只是 product-subagents/node_modules 里的插件开发副本，落 seedLength），
    // 判据从不读它，故 fixture 不带任何一个——只建模两版共同不变的骨架。
    if (!fork) { header.origin = 'subagent'; header.delegationDepth = 1 } // 委派子代理必带这两个字段
  }
  return { id, seq: events.length, eventAt: (seq) => events[seq] ?? null, header }
}
