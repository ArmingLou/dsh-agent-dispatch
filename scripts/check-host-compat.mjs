#!/usr/bin/env node
/**
 * 宿主契约检查：**装在这台机器上的** DSH 运行时还认不认本插件依赖的那些缝。
 *
 * `npm test`（= `node --test test/*.test.js`）按设计是 host-free（CI 上没有 dsh），
 * 用假宿主驱动 Dispatcher；于是"宿主把某个方法改名/删掉"这类换代，单测**永远发现不了**
 * ——只会表现为生产里静默失效或整条路由失败。本脚本是它的补集：
 * 对着真实 dsh 安装跑，宿主一换代就报红。
 *
 * v1.12.17 的由来：dsh 0.2.1-alpha.3 把
 *   `SubagentRuntime.startContinuable`   → `startActivation`（+ 新增必填 `delivery`）
 *   `SubagentRuntime.drainContinuableChildren` → `drainChildren`
 * 前者让 `agent_dispatch` 全路由失败，后者（有 `typeof === 'function'` 守卫）
 * 让驻留 Activation 静默永不回收。两条都逃过了当时的单测与 verify.mjs。
 *
 * 检查项：
 *   1. 能定位到 dsh 运行时并读出它的版本；
 *   2. 宿主自己的兼容谓词（dsh-app-boot → evaluatePluginCompatibility，就是当初把
 *      插件整包跳过(dsh 0.2.0-rc.1)的那个函数）接受本 package.json；不可用时仅告警；
 *   3. ctx.subagents 仍暴露本插件**实际用到**的方法名（从 lib/*.js + index.js
 *      的 `ctx.subagents.<m>(` 调用点抽取，避免清单手写漂移）；
 *   4. 这些方法的**参数个数**与调用形态一致（如 drainChildren(parent, childIds)
 *      必须是 2 参——改名不改参的假设一旦不成立，本次修复就会改成错的形状）；
 *   5. `SubagentActivationSpec` 的形状：`delivery` 存在且在 d.ts 里注明取值含义；
 *      新宿主下 `persona` / `toolFilter` 已从 `SubagentStartRequest` 移除（仅提示）；
 *   6. 插件源码真的接上了新名（startActivation + `delivery: 'parent'` + drainChildren
 *      软兼容链），且没有残留直连旧名——防止"护栏绿、插件退回旧名"。
 *
 * 用法：
 *   npm run check:host
 *   DSH_RUNTIME_ROOT=/path/to/node_modules/@deepseek-ai/dsh npm run check:host
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const results = []

const ok = (label, detail = '') => results.push({ pass: true, label, detail })
const bad = (label, detail = '') => results.push({ pass: false, label, detail })
const warn = (label, detail = '') => results.push({ warn: true, label, detail })

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

/** 从 `from` 向上找 name 匹配的包根。 */
function findPackageRoot(from, name) {
  let dir = from
  for (let i = 0; i < 8; i += 1) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        if (readJson(manifest).name === name) return dir
      } catch { /* 继续向上 */ }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** 定位已安装的 @deepseek-ai/dsh 包根。 */
function resolveRuntimeRoot() {
  const explicit = process.env.DSH_RUNTIME_ROOT
  if (explicit) {
    if (!existsSync(join(explicit, 'package.json'))) {
      throw new Error(`DSH_RUNTIME_ROOT=${explicit} 不像一个包目录`)
    }
    return realpathSync(explicit)
  }
  try {
    const which = process.platform === 'win32' ? 'where' : 'which'
    const bin = execFileSync(which, ['dsh'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0].trim()
    const found = findPackageRoot(dirname(realpathSync(bin)), '@deepseek-ai/dsh')
    if (found) return found
  } catch { /* 退回全局安装 */ }
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim()
    const candidate = join(globalRoot, '@deepseek-ai', 'dsh')
    if (existsSync(join(candidate, 'package.json'))) return realpathSync(candidate)
  } catch { /* 落到报错 */ }
  throw new Error('定位不到已安装的 @deepseek-ai/dsh 包；用 DSH_RUNTIME_ROOT 指向它的目录')
}

/** 插件真正调用的宿主方法名（从源码抽取，不手写清单——手写清单会漂移）。 */
function pluginUsedMethods() {
  const used = new Set()
  const files = ['index.js', ...readdirSync(join(root, 'lib')).filter((f) => f.endsWith('.js')).map((f) => join('lib', f))]
  for (const rel of files) {
    const src = readFileSync(join(root, rel), 'utf8')
    for (const m of src.matchAll(/(?:this\.)?ctx\.subagents\?*\.\s*([A-Za-z]+)\s*\(/g)) used.add(m[1])
  }
  return [...used].sort()
}

/** 读取 dsh-subagent 的 .d.ts 文本（用于形状断言；找不到就返回 null）。 */
function readTypes(runtimeRoot, ...segments) {
  const p = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'types', ...segments)
  return existsSync(p) ? readFileSync(p, 'utf8') : null
}

async function main() {
  const runtimeRoot = resolveRuntimeRoot()
  const runtimeVersion = readJson(join(runtimeRoot, 'package.json')).version
  ok('dsh runtime located', runtimeRoot)

  // ── 2. 宿主自己的兼容谓词 ──────────────────────────────────────────────────
  try {
    const appBoot = await import(pathToFileURL(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot', 'lib', 'index.js')).href)
    const manifest = readJson(join(root, 'package.json'))
    const issue = appBoot.evaluatePluginCompatibility?.(manifest, {}, runtimeVersion)
    if (issue === undefined) ok('宿主兼容谓词接受本 package.json')
    else if (issue.exempted) warn(`peer 范围在 dsh ${runtimeVersion} 上需要豁免`, JSON.stringify(issue.peers))
    else bad('宿主兼容谓词**拒绝**本 package.json', appBoot.pluginCompatibilityWarning?.(issue) ?? JSON.stringify(issue))
  } catch (error) {
    warn('读不到 dsh-app-boot，跳过兼容谓词检查（不影响其余断言）', String(error?.message ?? error))
  }

  // ── 3./4. ctx.subagents 公开面 ─────────────────────────────────────────────
  const subagent = await import(pathToFileURL(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-subagent', 'lib', 'index.js')).href)
  const runtime = subagent.SubagentRuntime ?? subagent.default
  const proto = runtime?.prototype
  if (!proto) throw new Error('dsh-subagent 未导出 SubagentRuntime（导出面又变了）')

  // 一代换名的成对方法：任一在即可，但**必须报出用的是哪一个**（免得静默回退）。
  const ALIASES = {
    startContinuable: 'startActivation',
    drainContinuableChildren: 'drainChildren',
  }
  const used = pluginUsedMethods()
  for (const method of used) {
    const alias = ALIASES[method] // 旧名 → 新名
    if (alias) {
      const hasNew = typeof proto[alias] === 'function'
      const hasOld = typeof proto[method] === 'function'
      if (hasNew) ok(`ctx.subagents.${alias}() present（插件按软兼容优先调它；旧名 ${method} ${hasOld ? '仍在' : '已删除'}）`)
      else if (hasOld) warn(`ctx.subagents.${alias}() missing，只有旧名 ${method}()（插件会回退到旧名）`)
      else bad(`ctx.subagents.${alias}() 与 ${method}() 都不存在（插件软兼容链两端全断）`)
      continue
    }
    if (typeof proto[method] === 'function') ok(`ctx.subagents.${method}() present`)
    else bad(`ctx.subagents.${method}() missing（插件在用，宿主已移除/改名）`)
  }

  // 参数个数：改名不改参的假设必须被验证；形状变了下面这条会红。
  const arity = (name, expected) => {
    const fn = proto[name]
    if (typeof fn !== 'function') return
    if (fn.length === expected) ok(`ctx.subagents.${name}.length === ${expected}（调用形态匹配）`)
    else bad(`ctx.subagents.${name}.length === ${fn.length}，期望 ${expected}（改名不改参的假设不成立，调用点要跟着改）`)
  }
  arity('startActivation', 1)
  arity('drainChildren', 2) // (parent, childIds)
  arity('sendMessage', 4) // (sender, targetId, content, options)

  // ── 5. SubagentActivationSpec / SubagentStartRequest 形状 ───────────────────
  const typesDts = readTypes(runtimeRoot, 'types.d.ts')
  if (typesDts === null) {
    warn('读不到 dsh-subagent/lib/types/types.d.ts，跳过 spec 形状断言')
  } else {
    const specBlock = /export interface SubagentActivationSpec \{([\s\S]*?)\n\}/.exec(typesDts)?.[1]
    if (!specBlock) {
      bad('d.ts 里已没有 SubagentActivationSpec 接口（宿主 spec 换代）')
    } else {
      if (/^\s*readonly delivery:/m.test(specBlock)) ok("SubagentActivationSpec 含必填字段 delivery（插件传 'parent'）")
      else bad("SubagentActivationSpec 的 delivery 字段消失了（插件传的 delivery: 'parent' 会失效）")
      if (/^\s*readonly request:/m.test(specBlock)) ok('SubagentActivationSpec 仍含 request 字段')
      else bad('SubagentActivationSpec 不再含 request 字段（插件构造的 spec 形状已过期）')
    }
    // 旧宿主把 persona/toolFilter 放在 start request 上；新宿主已移除——仅提示，不算失败。
    const startReq = /export interface SubagentStartRequest \{([\s\S]*?)\n\}/.exec(typesDts)?.[1]
    if (startReq) {
      const dropped = ['persona', 'toolFilter'].filter((k) => !new RegExp(`^\\s*readonly ${k}\\??:`, 'm').test(startReq))
      if (dropped.length > 0) {
        ok(`SubagentStartRequest 已移除 ${dropped.join('/')}（插件保留该字段但宿主静默忽略——替代方案见 docs/agent-preset-migration.md）`)
      } else {
        warn('SubagentStartRequest 仍保留 persona/toolFilter（宿主回退到旧形状？插件注释需要复核）')
      }
      if (/^\s*readonly agentPreset\??:/m.test(startReq)) ok('SubagentStartRequest 含 agentPreset（persona/toolFilter 的替代方案）')
      else warn('SubagentStartRequest 没有 agentPreset 字段')
    }
  }

  // ── 6. 插件侧接线（护栏绿但插件没改 = 假绿）────────────────────────────────
  const dispatchSrc = readFileSync(join(root, 'lib', 'dispatch.js'), 'utf8')
  const wiring = [
    ['startActivation 优先调用', 'this.ctx.subagents.startActivation?.bind(this.ctx.subagents)'],
    ['startContinuable 回退', 'this.ctx.subagents.startContinuable?.bind(this.ctx.subagents)'],
    ['两端全断时 loud throw', '宿主 subagents 服务未暴露 startActivation/startContinuable'],
    ["顶层 delivery: 'parent'", "delivery: 'parent'"],
    ['drainChildren 优先', 'this.ctx.subagents.drainChildren ?? this.ctx.subagents.drainContinuableChildren'],
    ['drain 保留 this 绑定', 'drain.call(this.ctx.subagents, parent, [childId])'],
  ]
  for (const [label, needle] of wiring) {
    if (dispatchSrc.includes(needle)) ok(`lib/dispatch.js 已接线：${label}`)
    else bad(`lib/dispatch.js 缺少接线：${label}`)
  }
  for (const stale of [
    "typeof this.ctx.subagents.drainContinuableChildren === 'function'",
    'await this.ctx.subagents.startContinuable({',
  ]) {
    if (dispatchSrc.includes(stale)) bad(`lib/dispatch.js 残留直连旧名（新宿主下静默失效）：${stale}`)
    else ok('lib/dispatch.js 没有残留直连旧名的调用')
  }

  // ── 汇总 ─────────────────────────────────────────────────────────────────
  const failures = results.filter((r) => r.pass === false)
  for (const r of results) {
    const mark = r.pass === false ? 'FAIL' : r.warn ? 'warn' : 'ok  '
    console.log(`${mark}  ${r.label}${r.detail ? `\n      ${r.detail}` : ''}`)
  }
  console.log(`\n${failures.length === 0 ? '宿主契约 OK' : `${failures.length} 条宿主契约失败`} on @deepseek-ai/dsh@${runtimeVersion}`)
  return failures.length === 0 ? 0 : 1
}

main()
  .then((code) => { process.exitCode = code })
  .catch((error) => {
    console.error(`check:host 跑不起来：${error && error.message ? error.message : error}`)
    if (process.env.DSH_CHECK_DEBUG) console.error(error)
    process.exitCode = 1
  })
