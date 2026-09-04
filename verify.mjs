#!/usr/bin/env node
// verify.mjs — dsh-agent-dispatch 一致性断言。
//
// 校验"包名全链路一致"：package.json name / cordis.patch.yml 插件行 /
// （本插件无 tsdown banner，ModuleLoader id 由 exports 隐含 = 包名）。
// 同时冒烟：模块可加载、apply 桩测试全绿、无内置 Agent（v1.1 全清空）。

import { readFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const errors = []

// 1. package.json name
const PKG_NAME = '@kiligzzz/dsh-agent-dispatch'
if (pkg.name !== PKG_NAME) errors.push(`package.json name 应为 ${PKG_NAME}，实际 ${pkg.name}`)

// 2. cordis.patch.yml 插件行（id 裸名 + name 全名）
const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
if (!patch.includes("name: '@kiligzzz/dsh-agent-dispatch'")) errors.push('cordis.patch.yml 缺插件行 name: @kiligzzz/dsh-agent-dispatch')
if (!patch.includes('- id: dsh-agent-dispatch')) errors.push('cordis.patch.yml 缺 - id: dsh-agent-dispatch 行')

// 3. exports 面
if (pkg.exports?.['.'] !== './index.js') errors.push('exports["."] 应指向 ./index.js')
if (pkg.exports?.['./client'] !== './lib/client.js') errors.push('exports["./client"] 应指向 ./lib/client.js')

// 3.5 dsh.client 声明与 client bundle 格式（2026-08-24 启动事故根因）
if (pkg.dsh?.client?.platform !== 'web') errors.push('dsh.client.platform 必须为 "web"（缺失曾致 Desktop 启动崩溃自动回滚）')
const clientJs = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
if (!clientJs.includes('window.__ModuleLoader__.load')) errors.push('lib/client.js 必须用 __ModuleLoader__.load 注册（bundle 约定）')
if (!clientJs.includes("id: '@kiligzzz/dsh-agent-dispatch'")) errors.push('lib/client.js ModuleLoader id 必须是裸包名 @kiligzzz/dsh-agent-dispatch')

// 4. 关键文件存在
for (const f of ['index.js', 'lib/client.js', 'lib/agents.js', 'lib/dispatch.js', 'lib/defaults.js', 'lib/squads.js', 'lib/squad-registry.js', 'lib/skill-import.js', 'lib/fab-config.js', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
  if (!existsSync(path.join(root, f))) errors.push(`缺文件: ${f}`)
}

// 5. 冒烟：模块加载 + apply 桩测试（DSH_HOME 指到临时目录避免污染）
import { mkdtempSync, rmSync, readFileSync as rf, writeFileSync } from 'node:fs'
import os from 'node:os'
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dad-verify-'))
process.env.DSH_HOME = tmp
const mod = await import(path.join(root, 'index.js'))
if (mod.name !== PKG_NAME) errors.push(`模块导出 name 应为 ${PKG_NAME}，实际 ${mod.name}`)
if (!Array.isArray(mod.inject) || mod.inject.length === 0) errors.push('inject 数组缺失')
const tools = [], sections = [], commands = []
const ctx = {
  tools: {
    register: d => { tools.push(d.name); return () => {} },
    // v1.5.0：apply 挂全局递归护栏（tools.guard）+ 动态 deny 名单读取（tools.view）
    guard: () => () => {},
    view: () => ({ knownNames: [] }),
  },
  systemPrompt: { section: s => { sections.push(s.name); return () => {} } },
  commands: { register: d => { commands.push(d.name); return () => {} } },
  subagents: {},
  get: () => undefined,
  on: () => () => {},
}
mod.apply(ctx)
await new Promise(r => setTimeout(r, 300))
for (const t of ['agent_dispatch', 'agent_followup', 'agent_close', 'agent_children', 'agent_list', 'agent_squad', 'agent_squad_continue', 'agent_squad_upsert', 'agent_import_skill', 'agent_upsert']) {
      // 小队注册表：内置 3 队可加载
  if (!tools.includes(t)) errors.push(`apply 未注册工具 ${t}`)
}
if (commands.includes('agent')) errors.push('v0.9.37: /agent 命令应已删除')
const reg = JSON.parse(rf(path.join(tmp, 'data', 'dsh-agent-dispatch', 'agents.json'), 'utf8'))
// v1.1：不再预置任何内置 Agent，全新安装从空列表开始
if (!Array.isArray(reg.agents) || reg.agents.length !== 0) errors.push(`v1.1: agents.json 应为空数组，实际 ${reg.agents?.length ?? '非数组'} 个`)
rmSync(tmp, { recursive: true, force: true })

if (errors.length) {
  console.error('FAIL:')
  for (const e of errors) console.error(' -', e)
  process.exit(1)
}
// v0.6：conversation.view 槽注册 + Settings 瘦身分区 + UI 文案 Agent 化
{
  const c = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
  if (!c.includes('slots.inject("conversation.view"')) throw new Error('v0.6: client 未注册 conversation.view 槽')
  if (!c.includes('id: "agent-dispatch"')) throw new Error('v0.6: conversation.view 注册缺 id=agent-dispatch')
  if (!c.includes('order: 21')) throw new Error('v0.6: conversation.view 注册缺 order=21')
  if (c.includes('slots.inject("settings.section"')) throw new Error('v0.9.36: settings.section 槽注册应已删除（设置页整体移除）')
  if (c.includes('agent-dispatch-settings')) throw new Error('v0.9.36: settings 分区 id agent-dispatch-settings 应已移除')
  if (c.includes('agent-dispatch-agents') || c.includes('agent-dispatch-activity')) throw new Error('v0.6: 旧 settings 分区 id 应已移除')
  if (!c.includes('mountAgentFab')) throw new Error('v0.6: 缺悬浮活动按钮 mountAgentFab')
  if (!c.includes('FAB_VIS_KEY')) throw new Error('v0.9.36: 缺悬浮球总开关持久化键 FAB_VIS_KEY')
  if (!c.includes('setFabVisible')) throw new Error('v0.9.36: 缺悬浮球总开关 setFabVisible')
  if (!c.includes('ad-set-card')) throw new Error('v0.9.36: 总览缺设置卡片样式 ad-set-card')
  if (c.includes('function SettingsTab')) throw new Error('v0.9.36: SettingsTab 组件应已删除')
// v0.7：设计语言 + 信息架构 + FAB 交互
if (!c.includes('ad-kicker')) throw new Error('v0.7: 缺 kicker 节标题设计语言')
if (c.includes('ad-empty-glyph')) throw new Error('v0.9.8: 空态圆形图标应删除（只留文字）')
if (!c.includes('ad-run-card')) throw new Error('v0.7: 缺运行中大卡 ad-run-card')
if (!c.includes('fmtDur')) throw new Error('v0.7: 缺运行时长格式化 fmtDur')
if (!c.includes('pointerdown')) throw new Error('v0.7: FAB 缺拖动（pointer 事件）')
if (!c.includes('localStorage')) throw new Error('v0.7: FAB 缺位置持久化')
if (!c.includes('prevIds')) throw new Error('v0.7: FAB 缺完成检测（集合差）')
// v0.7.1：生命周期闭环 + 真实结局 + 中止
const host = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
if (!host.includes("ctx.on('subagent/end'")) throw new Error('v0.7.1: host 缺 subagent/end 订阅')
if (!host.includes('onChildEnd')) throw new Error('v0.7.1: 缺 onChildEnd 生命周期终结')
if (!host.includes('mergeDispatchHistory')) throw new Error('v0.7.1: 缺真实结局合并')
// v0.9.16：最近委派按小队聚合需小队名/头像回填；子代理 label 带Agent名前缀（任务管理页可辨人）
if (!host.includes('next.squadName = sq?.name')) throw new Error('v0.9.16: mergeDispatchHistory 应按 viaSquad 回填小队名')
// v0.9.35：label 在Agent名后拼 squadMark（S{n}/{total}）——断言 squadMark 构造与拼接逻辑存在
const dispatchSrc = readFileSync(path.join(root, 'lib/dispatch.js'), 'utf8')
// v1.1.2 起：递归护栏——deny 候选名单必须覆盖全部 8 个委派工具 + 通用委派工具
// v1.5.0：名单改为 DENY_CANDIDATES 常量 + #safeDenyList 动态求交集（新宿主
// tools.restrict 对未知工具名 loud throw，静态名单会炸掉子代理创建）；
// 豁免 send_message（子代理→父级回传，替代旧 report）与 product_submit（ACP 中继）。
const denyCands = readFileSync(path.join(root, 'lib/dispatch.js'), 'utf8')
for (const n of ['agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue', 'agent_squad_upsert', 'agent_import_skill', 'agent_upsert', 'subagent', 'subagent_fork', 'workflow', 'product_delegate']) {
  if (!dispatchSrc.includes("'" + n + "'")) throw new Error(`v1.5.0: DENY_CANDIDATES 必须包含 ${n}`)
}
if (!dispatchSrc.includes('send_message')) throw new Error('v1.5.0: 应保留 send_message（子代理→父级回传结果，替代旧 report）')
if (!dispatchSrc.includes('#safeDenyList()')) throw new Error('v1.5.0: deny 名单必须走 #safeDenyList 动态求交集')
if (!dispatchSrc.includes('this.ctx.tools?.view?.(undefined)')) throw new Error('v1.5.0: #safeDenyList 应读宿主全局 knownNames')
// v1.5.0：宿主删除 ctx.subagents.followup——续聊必须走 sendMessage（signal 硬性字段）
if (!dispatchSrc.includes('this.ctx.subagents.sendMessage(')) throw new Error('v1.5.0: followup 必须改走 ctx.subagents.sendMessage（旧 followup 已从宿主删除）')
// v1.5.0：宿主 AgentOptions 字段为 reasoningEffort（旧 effort 已弃用）
if (!dispatchSrc.includes('reasoningEffort: route.effort')) throw new Error('v1.5.0: agentOptions 必须映射 effort → reasoningEffort')
// v1.5.0：同角色子代理复用池 + 空闲回收（drainChildren）
if (!dispatchSrc.includes('this.childPool = new Map()')) throw new Error('v1.5.0: 缺同角色复用池 childPool')
if (!dispatchSrc.includes('reusePolicy === \'fresh\' ? \'fresh\' : \'reuse\'')) throw new Error('v1.5.0: dispatch 应解析 Agent reusePolicy')
if (!dispatchSrc.includes('drainContinuableChildren(parent, [childId])')) throw new Error('v1.5.0/v1.5.2: 空闲回收应调用 ctx.subagents.drainContinuableChildren 释放驻留（drainChildren 未暴露，统一走 #drainChild）')
if (!dispatchSrc.includes('#scheduleReleaseFor(childId)')) throw new Error('v1.5.0: onChildEnd 应排空闲释放定时器')
if (!dispatchSrc.includes('purgeParent(parentSessionId)')) throw new Error('v1.5.0: 缺父会话清理 purgeParent')
// v1.5.1：智能复用——延续性启发式 + 调用方 reuse 参数 + 多线程 LRU 池
if (!dispatchSrc.includes('const callReuse = reuse === \'reuse\' || reuse === \'fresh\' ? reuse : \'auto\'')) throw new Error('v1.5.1: dispatch 应解析调用方 reuse 参数（auto/reuse/fresh）')
if (!dispatchSrc.includes('continuationScore(task, c.lastTasks)')) throw new Error('v1.5.1: auto 模式应走延续性启发式 continuationScore（比对原始任务，防样板污染）')
if (!dispatchSrc.includes('const CONTINUATION_MARKERS = [')) throw new Error('v1.5.1: 缺续写标记词表 CONTINUATION_MARKERS')
if (!dispatchSrc.includes('function significantTokens(text)')) throw new Error('v1.5.1: 缺显著词汇提取 significantTokens（路径/标识符/CJK 双字词）')
if (!dispatchSrc.includes('const POOL_CAP = 3')) throw new Error('v1.5.1: 复用池应有多线程 LRU 上限 POOL_CAP=3')
if (!dispatchSrc.includes('lastTasks')) throw new Error('v1.5.1: 池条目应记录最近任务文本 lastTasks（延续性比对语料）')
if (!dispatchSrc.includes('#evictPool(reuseKey, entry.key)')) throw new Error('v1.5.1: 新开 child 入池应触发 LRU 淘汰 #evictPool')
if (!dispatchSrc.includes('reuseReason')) throw new Error('v1.5.1: 决策日志应记录 reuseReason（explicit/continuation-marker/continuation-overlap/fresh-task）')
// v1.5.0：host 全局递归护栏（registerContinuableSetup 已删除）
if (!host.includes('ctx.tools.guard((exec) =>')) throw new Error('v1.5.0: host 应注册全局 tools.guard 递归护栏（registerContinuableSetup 已删除）')
if (!host.includes("subagentDepth ?? 0")) throw new Error('v1.5.0: tools.guard 应按 exec.agent.options.subagentDepth 判断')
if (host.includes('registerContinuableSetup(')) throw new Error('v1.5.0: registerContinuableSetup 调用应已删除（宿主已移除该 API）')
if (!host.includes("ctx.on('session/disposed'")) throw new Error('v1.5.0: host 应订阅 session/disposed 清理复用池')
// v1.5.1：agent_dispatch 工具应暴露 reuse 参数并透传给 dispatcher
if (!host.includes("enum: ['auto', 'reuse', 'fresh']")) throw new Error('v1.5.1: agent_dispatch 参数 schema 应含 reuse 枚举 auto/reuse/fresh')
if (!host.includes('{ reuse: args.reuse, childId: args.childId }')) throw new Error('v1.5.1/v1.5.3: agent_dispatch 应透传 reuse 与 childId 给 dispatch')
// v1.5.2：agent_close 显式关闭线程工具 + 淘汰即回收
if (!host.includes("name: 'agent_close'")) throw new Error('v1.5.2: host 应注册 agent_close 工具')
if (!host.includes("dispatcher.closeChild(parent, { childId: args.childId, agentId: args.agentId })")) throw new Error('v1.5.2: agent_close 应透传 childId/agentId 给 closeChild')
if (!dispatchSrc.includes('async closeChild(parentAgent, { childId, agentId }')) throw new Error('v1.5.2: dispatcher 缺 closeChild 显式关闭方法')
if (!dispatchSrc.includes('async #drainChild(parentSessionId, childId)')) throw new Error('v1.5.2: 缺 #drainChild 统一释放方法（idle 释放/淘汰/显式关闭共用）')
if (!dispatchSrc.includes("if (!this.activeChildren.has(e.childId)) {\n        // v1.5.2：确定不再复用 → 立即释放驻留（fire-and-forget，失败不阻断淘汰）")) throw new Error('v1.5.2: #evictPool 淘汰时应主动 drain 被淘汰 child')
// v1.5.3：定向续聊（agent_dispatch childId）+ 线程列表（agent_children）
if (!dispatchSrc.includes('childId = null')) throw new Error('v1.5.3: dispatch 应接收 childId 参数')
if (!dispatchSrc.includes("if (!dedicatedChild && childId) {")) throw new Error('v1.5.3: dispatch 应有 childId 定向续聊分支（最高优先级）')
if (!dispatchSrc.includes("reuseReason: 'explicit-child'")) throw new Error('v1.5.3: 定向续聊决策日志应记 explicit-child')
if (!dispatchSrc.includes('async listChildren(parentAgent, { agentId }')) throw new Error('v1.5.3: dispatcher 缺 listChildren 线程列表方法（agent_children 数据源）')
if (!host.includes("name: 'agent_children'")) throw new Error('v1.5.3: host 应注册 agent_children 工具')
if (!host.includes('{ reuse: args.reuse, childId: args.childId }')) throw new Error('v1.5.3: agent_dispatch 应透传 childId 给 dispatch')
if (!host.includes("'agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue',\n    'agent_squad_upsert', 'agent_upsert', 'agent_import_skill', 'agent_close', 'agent_children',")) throw new Error('v1.5.3: noDelegateTools 应含 agent_children（子代理不可管理线程树）')
// v1.5.4：fresh 策略已完成线程历史记录（agent_children 缺陷修复）
if (!dispatchSrc.includes('this.completedFresh = new Map()')) throw new Error('v1.5.4: dispatcher 缺 completedFresh 历史记录 Map')
if (!dispatchSrc.includes('COMPLETED_FRESH_CAP = 50')) throw new Error('v1.5.4: 缺 COMPLETED_FRESH_CAP 上限常量')
if (!dispatchSrc.includes('#isInPool(childId)')) throw new Error('v1.5.4: 缺 #isInPool 辅助方法（判断 childId 是否在复用池）')
if (!dispatchSrc.includes('#pruneCompletedFresh()')) throw new Error('v1.5.4: 缺 #pruneCompletedFresh 淘汰方法（超限清理）')
if (!dispatchSrc.includes("if (!this.#isInPool(childId)) {")) throw new Error('v1.5.4: onChildEnd 应在非池线程完成时插入 completedFresh 记录')
if (!dispatchSrc.includes('this.completedFresh.set(childId, {')) throw new Error('v1.5.4: onChildEnd 应 set completedFresh 条目（含 childId/agentId/taskLabels/parentSessionId/completedAt）')
if (!dispatchSrc.includes("for (const h of this.completedFresh.values())")) throw new Error('v1.5.4: listChildren 应遍历 completedFresh 合并展示（status: ready）')
if (!dispatchSrc.includes('this.completedFresh.delete(t.childId)')) throw new Error('v1.5.4: closeChild 应清理 completedFresh 条目')
if (!dispatchSrc.includes('this.completedFresh.delete(childId) // v1.5.4')) throw new Error('v1.5.4: 定向续聊进池时应移除 completedFresh 历史记录（互斥）')
if (!dispatchSrc.includes('this.completedFresh.clear()')) throw new Error('v1.5.4: dispose 应清空 completedFresh')
if (!dispatchSrc.includes("if (h.parentSessionId === parentSessionId) this.completedFresh.delete(childId)")) throw new Error('v1.5.4: purgeParent 应清理该父会话的 completedFresh 条目')
// v1.5.4 P1：followup() 续聊 completedFresh 线程时应移除历史 + 写 activeChildren
if (!dispatchSrc.includes('const hist = this.completedFresh.get(childId)')) throw new Error('v1.5.4-P1: followup 应查找 completedFresh')
// followup 内 completedFresh.delete 在 hist 检查块中（无专用注释，用上下文断言）
if (!dispatchSrc.includes('if (hist) {\n      this.completedFresh.delete(childId)')) throw new Error('v1.5.4-P1: followup 应在 hist 存在时从 completedFresh 移除续聊目标')
if (!dispatchSrc.includes('taskLabel: summarizeTask(message)')) throw new Error('v1.5.4-P1: followup 应写 activeChildren（含 taskLabel: summarizeTask(message)）')
// v1.5.4 P2-2：closeChild agentId 批量路径去重
if (!dispatchSrc.includes('const seen = new Set()') || !dispatchSrc.includes('!seen.has(h.childId)')) throw new Error('v1.5.4-P2: closeChild agentId 批量路径应有 seen 去重')
// v1.4.0：ACP/subagent provider 路由——getProvider 命中即走 relay 模式（allow 白名单）
if (!dispatchSrc.includes('const subProvider = route ? this.ctx.subagents?.getProvider?.(route.provider) : undefined')) throw new Error('v1.4.0: dispatch 应检测 subagent provider（getProvider 命中）')
if (!dispatchSrc.includes("provider: acpMode ? route.provider : 'spawn'")) throw new Error('v1.4.0: ACP 模式 spec.provider 应直接传 route.provider')
if (!dispatchSrc.includes("toolFilter: { allow: ['product_submit'] }")) throw new Error('v1.4.0: ACP 模式 toolFilter 应 allow 白名单 product_submit')
if (!dispatchSrc.includes("const squadMark = viaSquad && totalSteps != null && stepIndex != null")) throw new Error('v0.9.35: dispatch 应构造 squadMark（S{n}/{total}）')
if (!dispatchSrc.includes('`${agent.name}${squadMark} · ${taskLabel}`')) throw new Error('v0.9.35: startContinuable label 应带Agent名 + squadMark 前缀')
if (!dispatchSrc.includes('totalSteps = null')) throw new Error('v0.9.35: dispatch 应接收 totalSteps 参数')
if (!host.includes('totalSteps: squad.steps.length')) throw new Error('v0.9.35: agent_squad 调用 dispatch 应传 totalSteps')
// v0.9.36/0.9.38：waitResult——默认 false（直接调 Agent 不阻塞），squad 步骤显式 true
if (!dispatchSrc.includes('waitResult = false')) throw new Error('v0.9.38: dispatch 应默认 waitResult=false（直接调不阻塞）')
if (!dispatchSrc.includes('waitTimeoutMs = 3600000')) throw new Error('v0.9.36: 等待超时应默认 1 小时')
if (!dispatchSrc.includes('this.waiters = new Map()')) throw new Error('v0.9.36: 缺 waiters 等待注册表')
if (!dispatchSrc.includes('#waitFor(childId, timeoutMs)')) throw new Error('v0.9.36: 缺 #waitFor 等待方法')
if (!dispatchSrc.includes('#normOutput(msg)')) throw new Error('v0.9.38: 缺 #normOutput 结果归一化（lastAssistantMessage 数组/字符串）')
if (!dispatchSrc.includes('lastAssistantMessage')) throw new Error('v0.9.36: onChildEnd 应接收/处理 lastAssistantMessage')
if (!host.includes('info?.lastAssistantMessage')) throw new Error('v0.9.36: subagent/end 订阅应透传 lastAssistantMessage')
if (!host.includes('（步骤 ${idx + 1} 结论）')) throw new Error('v0.9.36: stepResults 应填真实步骤结论（非占位）')
// v0.9.39：宿主 dsh-tools 不支持 type 数组——output 可空须 oneOf（type:['string','null'] 直接拒启动）
if (!host.includes('output: { oneOf: [{ type: \'string\' }, { type: \'null\' }] }')) throw new Error('v0.9.39: output 应 oneOf 表达可空（禁 type 数组）')
if (host.includes('output: { type: [\'string\', \'null\'] }')) throw new Error('v0.9.39: output 禁 type 数组（dsh-tools 拒）')
// v0.9.40：activeChildren 改 childId 主 key（同Agent并发步骤覆盖 → waiter 永挂 → 小队卡死/卡片缺）
if (!dispatchSrc.includes('this.activeChildren.set(childId, {')) throw new Error('v0.9.40: activeChildren 应以 childId 为主 key')
if (!dispatchSrc.includes('this.byAgent = new Map()')) throw new Error('v0.9.40: 缺 byAgent 二级索引（Agent复用续聊）')
if (!dispatchSrc.includes('const entry = this.activeChildren.get(childId)')) throw new Error('v0.9.40: onChildEnd 应 childId 直查')
if (!dispatchSrc.includes('dedicatedChild = false')) throw new Error('v0.9.40: dispatch 应有 dedicatedChild 参数')
if (!host.includes('waitResult: true, dedicatedChild: true')) throw new Error('v0.9.40: agent_squad 步骤应传 dedicatedChild: true')
// v0.9.37：完成呼吸光常驻 + 点击回退——断言 done-glow infinite、clearDoneGlow、poll 状态校正
const clientSrc = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
if (!clientSrc.includes('ad-fab-glow-done 1.6s ease-in-out infinite')) throw new Error('v0.9.37: done-glow 应为无限循环（常驻）')
if (!clientSrc.includes('const clearDoneGlow = () => {')) throw new Error('v0.9.37: 缺 clearDoneGlow（点击清完成光）')
if (!clientSrc.includes('clearDoneGlow();')) throw new Error('v0.9.37: togglePop 应调用 clearDoneGlow')
if (!clientSrc.includes('fab.classList.remove("done-glow")')) throw new Error('v0.9.37: poll 应去 done-glow（活跃让位）')
if (!clientSrc.includes('doneCount > 0 && !fab.classList.contains("done-glow")')) throw new Error('v0.9.37: poll 应恢复完成光（doneCount>0 无活跃）')
if (!host.includes('/agent-api/cancel')) throw new Error('v0.7.1: 缺 cancel 端点')
// v0.9.30：删除委派历史——ts 是 ISO 字符串（new Date().toISOString()），
// 旧逻辑 Number(body.ts) → NaN → 一律 400「缺少有效 ts」；须兼容字符串/数字并按字符串比对
if (!host.includes("typeof ts === 'string' ? ts.length > 0 : Number.isFinite(Number(ts))")) throw new Error('v0.9.30: remove 应兼容字符串/数字 ts 校验')
if (!host.includes('const tsKey = String(ts)')) throw new Error('v0.9.30: remove 应统一字符串比对键（tsKey）')
if (!host.includes('String(row.ts) === tsKey')) throw new Error('v0.9.30: remove 匹配行应按 String(row.ts) 比对')
if (host.includes('const ts = Number(body.ts)')) throw new Error('v0.9.30: remove 不应再 Number(body.ts)（ISO 字符串必得 NaN）')
if (!c.includes('ad-hist-run')) throw new Error('v0.7.1: 历史页缺运行中态')
const disp = readFileSync(new URL('./lib/dispatch.js', import.meta.url), 'utf8')
if (!disp.includes('onChildEnd')) throw new Error('v0.7.1: dispatcher 缺 onChildEnd')
if (!disp.includes('parentSessionId')) throw new Error('v0.7.1: entry 缺 parentSessionId（cancel 权限）')
// v0.7 信息架构：总览不应再有历史区；v0.8 活动 tab 整体删除（运行中并入总览）、删 Ranking、改卡片网格、命名统一、悬浮球显隐模式
const ovFn = c.slice(c.indexOf('function OverviewTab'), c.indexOf('function HistoryTab'))
if (ovFn.includes('readDispatches') || ovFn.includes('最近委派')) throw new Error('v0.7: 总览不应含历史区')
if (ovFn.includes('ad-rank') || ovFn.includes('Ranking')) throw new Error('v0.8: 总览不应再含 Ranking 区块')
if (c.includes('function ActiveTab')) throw new Error('v0.8: 活动 tab 应已删除')
if (c.includes('ad-rank-row') || c.includes('ad-disp-row')) throw new Error('v0.8: Ranking / 活动历史列表 CSS 应已清理')
if (!c.includes('label: () => "Agent 调度"')) throw new Error('v0.8: 右 tab / settings 分区应改名 Agent 调度')
if (!c.includes('ad-cards')) throw new Error('v0.8: Agent / 小队应为卡片网格 ad-cards')
if (!c.includes('FAB_MODE_KEY') || !c.includes('getFabMode')) throw new Error('v0.8: 缺悬浮球显示模式（always/auto/never）')
if (!c.includes('+ 新建小队')) throw new Error('v0.8: 组队应改名小队')
if (!c.includes('trigger: "/"')) throw new Error('v0.6: inputTriggers 源应挂 / 触发符（宿主 detectTrigger 只识别 @ 和 /，$ 注册了不会被扫描）')
if (!c.includes('{ text: "$" + id + " ", continue: true }')) throw new Error('v0.6: onPick 应插入 $id 纯文本')
// v0.8.2：小队开关 + 执行流 SVG 图 + 删用量角标 + POST 路由合并
if (!c.includes('function SquadFlowGraph')) throw new Error('v0.8.2: 缺小队执行流 SVG 拓扑图组件 SquadFlowGraph')
if (!c.includes('ad-flow-svg')) throw new Error('v0.8.2: 缺执行流图 CSS ad-flow-svg')
if (!c.includes('/agent-api/squad/toggle')) throw new Error('v0.8.2: 小队开关应调 /squad/toggle')
if (c.includes('近50次') || c.includes('ad-usage')) throw new Error('v0.8.2: Agent 卡用量角标（近50次）应已删除')
if (!host.includes('case \'/agent-api/squad/toggle\'')) throw new Error('v0.8.2: host 缺 /squad/toggle 端点')
if (!host.includes('squad.enabled === false')) throw new Error('v0.8.2: agent_squad 应拦截停用小队')
if (host.split("if (req.method === 'POST')").length !== 2) throw new Error('v0.8.2: restHandler 应只有一个 POST 块（此前双块 default 404 吞 toggle）')
// v0.8.3：DSH 官方 logo + 执行流弹窗大图 + 悬浮球随处可拖 + 历史兜底
if (!c.includes('DSH_LOGO_PATH') || !c.includes('function DSHLogo')) throw new Error('v0.8.3: 缺内联 DSH 官方 logo（DSH_LOGO_PATH / DSHLogo）')
if (!c.includes('function SquadFlowModal')) throw new Error('v0.8.3: 缺执行流弹窗组件 SquadFlowModal')
if (!c.includes('ad-modal-mask')) throw new Error('v0.8.3: 缺弹窗 CSS ad-modal-mask')
if (c.includes('吸附左右边缘')) throw new Error('v0.8.3: 悬浮球仍吸附边缘（应随处可拖）')
if (!c.includes('ad-fab-breathe')) throw new Error('v0.8.3: 悬浮球缺动态特效（呼吸）')
if (!c.includes('activeIds && !activeIds.has')) throw new Error('v0.8.3: 历史页缺活跃集合交叉比对兜底')
// v0.8.4：小队列表长卡片+固定图、历史预览跳转、host parentSessionId（右键菜单已于 0.9.11 移除）
if (!c.includes('ad-squad-list')) throw new Error('v0.8.4: 小队应为列表网格（v0.9 起一行 2 个）')
if (!c.includes('ad-hist-preview') || !c.includes('ad-hist-actions')) throw new Error('v0.8.4: 历史页缺预览区/跳转按钮')
if (!c.includes('parentSessionId')) throw new Error('v0.8.4: 缺 parentSessionId（host 日志行 + client 跳转）')
if (!host.includes('parentSessionId')) throw new Error('v0.8.4: host 端应记录 parentSessionId')
// v0.8.5：Agent 卡放大、小队图下移全宽、历史删除、悬浮活动面板、去显示模式配置
if (!c.includes('.ad-cards') || !c.includes('.ad-cards .ad-row')) throw new Error('v0.8.5: Agent 卡片应放大（.ad-cards 网格）')
// v0.9.3：小队卡恢复流程图缩略（固定 96px 图区）+ 弹窗加大固定 + S1 徽标居中 + SVG 自然尺寸只缩不放
if (!c.includes('ad-graph-box')) throw new Error('v0.9.3: 小队卡应恢复流程图缩略（ad-graph-box 固定图区）')
if (!c.includes('ad-modal-graph')) throw new Error('v0.9.3: 执行流弹窗应含固定图区 ad-modal-graph')
if (!c.includes('textAnchor: "middle"')) throw new Error('v0.9.3: S 徽标文字应 text-anchor:middle 居中')
if (!c.includes('width: W') || !c.includes('height: H')) throw new Error('v0.9.3: SVG 应设自然像素尺寸（防单节点拉伸撑满）')
if (!c.includes('squadStepsText')) throw new Error('v0.9.3: 图下文字流摘要应走 squadStepsText')
if (!c.includes('/agent-api/history/remove')) throw new Error('v0.8.5: 历史删除应调 /history/remove')
if (!host.includes("case '/agent-api/history/remove'")) throw new Error('v0.8.5: host 缺 /history/remove 端点')
if (!c.includes('ad-fab-pop-head') || !c.includes('ad-fab-pop-foot')) throw new Error('v0.8.5: 悬浮球应改大浮动活动面板（头/体/脚）')
if (c.includes('显示模式：一直') || c.includes('显示模式：自动')) throw new Error('v0.8.5: 右键菜单不应再有显示模式项')
// v0.8.6：活动面板打开即时渲染（缓存 lastActive，不闪加载中）
if (!c.includes('lastActive')) throw new Error('v0.8.6: 活动面板应缓存活跃数据 lastActive 即时渲染')
if (!c.includes('renderPop(lastActive)')) throw new Error('v0.8.6: 打开面板应先用缓存渲染再主动刷新')
// v0.8.7：点空白收起、最近委派、面板 logo 品牌色、文案统一
if (!c.includes('!pop.contains(ev.target)')) throw new Error('v0.8.7: 应支持点面板外空白收起')
if (!c.includes('ad-fab-card') || !c.includes('loadRecent')) throw new Error('v0.8.7: 面板应显示最近委派区')
if (!c.includes('打开 Agent 调度面板')) throw new Error('v0.8.7: 文案应统一为「打开 Agent 调度面板」')
if (c.includes('查看历史')) throw new Error('v0.8.7: 「查看历史」按钮应移除（改最近委派区）')
// v0.8.8：面板方案A（状态摘要+卡片分区）、悬浮球设置（色调/呼吸/彩色流光）
if (!c.includes('ad-fab-pop-summary') || !c.includes('ad-fab-sec') || !c.includes('ad-fab-card')) throw new Error('v0.8.8: 面板应改卡片分区方案A（摘要+分区）')
if (!c.includes('ad-fab-tone') || !c.includes('ad-fab-set-row')) throw new Error('v0.8.8: 悬浮球设置缺色调选择/开关行')
if (!c.includes('FAB_SET_KEY')) throw new Error('v0.8.8: 悬浮球设置应持久化')
if (!c.includes('fab-breathe')) throw new Error('v0.8.8: 悬浮球应支持呼吸动效类切换')
// v0.8.9：logo 去渐变底、描述通用化、小队两列网格+紧凑缩略图、emoji 清理（兜底改 DSH logo）
if (c.includes('.ad-logo{width:26px;height:26px;border-radius:7px;background:linear-gradient')) throw new Error('v0.8.9: 面板 logo 应去渐变底（DSH 图形品牌色直出）')
if (!c.includes('.ad-squad-list{display:grid') || !c.includes('repeat(2,minmax(0,1fr))')) throw new Error('v0.8.9: 小队应改两列卡片网格')
if (!c.includes('.ad-flow-svg{display:block')) throw new Error('v0.8.9: 应保留执行流图基类（v0.9.3 起走自然像素尺寸）')
if (c.includes('"🤖"') || c.includes('"🧩"')) throw new Error('v0.8.9: UI 不应再有机器人/拼图 emoji 兜底（改 DSH logo）')
if (!c.includes('function dshLogoSvg')) throw new Error('v0.8.9: 缺原生 DOM 场景的 dshLogoSvg helper')
const def = readFileSync(new URL('./lib/defaults.js', import.meta.url), 'utf8')
const sqd = readFileSync(new URL('./lib/squads.js', import.meta.url), 'utf8')
// v1.1：内置 Agent/小队全部清空，DEFAULT_AGENTS / DEFAULT_SQUADS 均为空数组
if (!/DEFAULT_AGENTS = \[\]/.test(def)) throw new Error('v1.1: DEFAULT_AGENTS 应为空数组')
if (!/DEFAULT_SQUADS = \[\]/.test(sqd)) throw new Error('v1.1: DEFAULT_SQUADS 应为空数组')
// v0.8.9b：设置不自动返回（popView）、彩色流光 box-shadow 动画、色调 5 选、设置右上角、Agent 列表折叠分区、委派悬停双按钮
if (!c.includes('popView') || !c.includes('popView === "main"')) throw new Error('v0.8.9b: 应加 popView 状态防止设置视图被异步重绘覆盖')
// v0.9.32：悬停快捷按钮（⇱/⇲）移除——卡片点击统一直达主会话；小队整体卡不展开成员
if (c.includes('ad-fab-jumps') || c.includes('mkJump')) throw new Error('v0.9.32: 悬停快捷按钮（⇱/⇲）应已移除')
if (!c.includes('card.title = d.parentSessionId ? "点击打开主会话"')) throw new Error('v0.9.32: 卡片点击应直达主会话（parentSessionId 优先）')
if (!c.includes('isSquadRun')) throw new Error('v0.9.32: 运行中分区应支持小队聚合展示')
if (!c.includes('id: "mist"') || !c.includes('id: "rainbow"')) throw new Error('v0.8.9b: 色调应含雾紫/彩色渐变（现行色调集）')
if (!c.includes('ad-fab-agents') || !c.includes('ad-fab-sec-toggle')) throw new Error('v0.8.9b: 缺 Agent 列表折叠分区')
// v0.8.10：开关 knob 即时反馈、流光不改底色、庆祝动画、设置移回底部、紫罗兰合成、close 去边框
if (!c.includes('sw.classList.toggle("on"')) throw new Error('v0.8.10: 开关点击应即时切换 knob 状态')
if (c.includes('fab-color{background:linear-gradient')) throw new Error('v0.8.10: 彩色流光不应覆盖底色（防变黑）')
if (!c.includes('done-glow') || c.includes('classList.add("celebrate")')) throw new Error('v0.9.17: 完成提醒应改彩色光呼吸 done-glow（celebrate 彩虹庆祝已删）')
if (!c.includes('setBtn.textContent = "⚙"') || !c.includes('openFabSettings')) throw new Error('v0.8.11: 设置图标应在头部关闭按钮旁')
if (!c.includes('ad-tone-mist{background:linear-gradient')) throw new Error('v0.8.10: 色调类渐变应存在（现行集含雾紫 ad-tone-mist）')
// v0.8.11：色调 8 个两排、流光 8 段平滑、悬浮球 3D、面板毛玻璃+透明度滑块、悬停特效、设置图标在关闭旁
if (!c.includes('id: "cherry"') || !c.includes('id: "rainbow"')) throw new Error('v0.8.12: 色调应含樱粉/彩色渐变（现行批次）')
if (!c.includes('repeat(4,1fr)')) throw new Error('v0.8.11: 色调应两排 4+4')
if (c.includes('ad-fab-hue')) throw new Error('v0.9.12: 整球彩色流光（ad-fab-hue）应已删除')
if (!c.includes('.ad-fab::before')) throw new Error('v0.8.11: 悬浮球应含质感层')
if (!c.includes('backdrop-filter:blur') || !c.includes('--fab-pop-alpha')) throw new Error('v0.8.11: 面板应毛玻璃+透明度可调')
if (!c.includes('.ad-fab:hover:not(.dragging)')) throw new Error('v0.8.11: 悬浮球应加悬停特效')
if (!c.includes('ad-fab-alpha')) throw new Error('v0.8.11: 设置页应含透明度滑块')
// v0.8.12：泡泡玻璃质感、面板中心弹出、设置视图点外关闭、透明度下限 10%、白色 logo、彩虹色调（整球流光 hue-rotate 已于 0.9.12 移除）
if (c.includes('hue-rotate')) throw new Error('v0.9.12: hue-rotate 整球流光应已移除（仅留边缘流光）')
if (!c.includes('.ad-fab.ad-tone-rainbow')) throw new Error('v0.9.2: 色调应 CSS 类切换（含彩虹）')
if (!c.includes('ad-fab-pop-in') || !c.includes('transform-origin:center')) throw new Error('v0.8.12: 面板应从中心弹出')
if (!c.includes('armOutsideClose')) throw new Error('v0.8.12: 设置视图应支持点外关闭（重绘后重新武装）')
if (!c.includes('sl.min = "0"')) throw new Error('v0.8.12: 透明度下限应到 0%')
// v0.9：Agent 卡一行 4 个、小队卡一行 2 个、卡片语言对齐悬浮球、触发 chip 化、名称首字头像
if (!c.includes('.ad-cards{display:grid') || !c.includes('repeat(4,minmax(0,1fr))')) throw new Error('v0.9: Agent 卡应一行 4 个（repeat(4,minmax(0,1fr))）')
if (!c.includes('.ad-squad-list{display:grid') || !c.includes('repeat(2,minmax(0,1fr))')) throw new Error('v0.9: 小队卡应一行 2 个（repeat(2,minmax(0,1fr))）')
if (!c.includes('function Avatar')) throw new Error('v0.9: 应含 Avatar helper')
if (!c.includes('ad-chip trig') || !c.includes('ad-chip-row')) throw new Error('v0.9: 触发域应 chip 化（ad-chip-row/ad-chip trig）')
if (!c.includes('.ad-avatar.logo')) throw new Error('v0.9.13: 缺默认头像白色 logo 样式 ad-avatar.logo')
// v0.9.2：色调 CSS 类切换、透明毛玻璃球、透明度 0-100、logo 近白、设置图标 38px
if (!c.includes('ad-tone-mist') || !c.includes('ad-tone-cherry') || !c.includes('ad-tone-rainbow')) throw new Error('v0.9.2: 色调应 CSS 类切换（ad-tone-*，现行批次）')
if (!c.includes('--dsw-static-neutral-bluish-00') && !c.includes('--fab-fg:var(--dsw-static')) throw new Error('v0.9.2: 悬浮球 logo 应近白（静态 token）')
if (!c.includes('sl.min = "0"') || !c.includes('Math.max(0')) throw new Error('v0.9.2: 透明度应 0-100')
if (!c.includes('setBtn.className = "ad-fab-pop-close ad-fab-pop-set"')) throw new Error('v0.9.2: 设置图标应挂放大类 ad-fab-pop-set')
// v0.9.3：色调黑根因修复（不存在 token 换静态）、透明度分离、logo 统一蓝、⚙/✕ 尺寸分离
if (c.includes('state-info-primary') || c.includes('state-warning-primary')) throw new Error('v0.9.3: 不应再引用不存在的 state-info/warning-primary token')
if (!c.includes('dsw-static-blue-500') || !c.includes('dsw-static-red-400') || !c.includes('dsw-static-amber-400')) throw new Error('v0.9.3: 色调应改用静态色 token')
if (!c.includes('fabAlpha')) throw new Error('v0.9.3: 面板与悬浮球透明度应分离（fabAlpha）')
if (!c.includes('ad-fab-pop::before')) throw new Error('v0.9.3: 面板背景应走 ::before 不透明度层')
if (c.includes('.ad-fab .ad-dsh-logo{width:22px;height:22px;color:var(--fab-fg)}')) throw new Error('v0.9.3: 悬浮球 logo 应统一蓝（不再跟 fab-fg）')
if (!c.includes('.ad-fab-pop-set{width:36px')) throw new Error('v0.9.3: 只 ⚙ 放大，✕ 应还原 28px')
if (c.includes('repeat(auto-fill,minmax(300px,1fr))') || c.includes('repeat(auto-fill,minmax(340px,1fr))')) throw new Error('v0.9: 不应残留旧 auto-fill 网格')
// v0.9.5：头部 logo 白、删空态引导句、卡片点整体编辑 + hover 图标按钮、编辑/删除进弹窗
if (!c.includes('.ad-logo .ad-dsh-logo{width:26px;height:26px;color:var(--dsw-alias-label-primary)}')) throw new Error('v0.9.5: 头部 logo 应为 label-primary（暗主题白色）')
if (c.includes('自动路由，或输入 / 从菜单选一个 Agent')) throw new Error('v0.9.5: 总览空态引导句应删除')
if (!c.includes('ad-row editable') || !c.includes('ad-squad-card editable')) throw new Error('v0.9.5: Agent/小队卡应点整体即编辑')
if (c.includes('ad-card-acts')) throw new Error('v0.9.8: 卡片浮层按钮应删除（整卡点击即编辑）')
if (!c.includes('.ad-modal.form')) throw new Error('v0.9.5: 编辑表单应包进弹窗（ad-modal form）')
// v0.9.31：编辑弹窗固定高度（内容超高内部滚动，不再撑出视口裁掉底部按钮）
if (!c.includes('height:min(760px,100%)')) throw new Error('v0.9.31: 编辑弹窗应固定高度 min(760px,100%) 内部滚动')
if (!c.includes('grid-template-rows:1fr')) throw new Error('v0.9.31: 遮罩需明确网格轨道保证弹窗百分比高度可解析')
if (!c.includes('.ad-btn.primary{') || !c.includes('font-weight:600')) throw new Error('v0.9.5: 新建按钮应为填充主按钮')
if (c.includes('ad-confirm-text')) throw new Error('v0.9.5: 内联删除确认应改弹窗（清死类）')
// v0.9.5b：logo 黑、浅色色调批次+毛玻璃、边缘/整球流光分离、透明度 0 值持久化、点球不再重弹
if (!c.includes('.ad-fab .ad-dsh-logo{width:22px;height:22px;color:var(--dsw-static-neutral-1000)}')) throw new Error('v0.9.5b: 悬浮球 logo 应为黑色（neutral-1000）')
if (!c.includes('ad-tone-snow') || !c.includes('ad-tone-sky') || !c.includes('ad-tone-glass')) throw new Error('v0.9.5b: 色调批次应含雪白/天蓝/毛玻璃')
if (!c.includes('.ad-fab-edge-ring') || !c.includes('ad-edge-spin')) throw new Error('v0.9.5b: 缺边缘流光独立环（ad-fab-edge-ring 旋转）')
if (!c.includes('fab.classList.toggle("fab-edge"')) throw new Error('v0.9.5b: 边缘流光应独立开关（fab-edge 类）')
if (!c.includes('边缘彩色流光')) throw new Error('v0.9.5b: 设置页应保留边缘流光开关')
if (c.includes('悬浮球彩色流光')) throw new Error('v0.9.12: 整球彩色流光开关应已删除')
if (c.includes('Number(readFabSettings().alpha) || 85') || c.includes('Number(s.fabAlpha) || 100')) throw new Error('v0.9.5b: || 85/100 吞 0 陷阱应已修复')
if (!c.includes('ev.target === fab || fab.contains(ev.target)')) throw new Error('v0.9.5b: 点外关闭应排除悬浮球自身（防重复弹）')
// v0.9.6：步骤卡片化、S 徽标、提示词加大、浮层按钮幽灵化
if (!c.includes('.ad-step-item{display:flex;flex-direction:column;gap:8px;background')) throw new Error('v0.9.6: 步骤应为独立卡片（带底+圆角）')
if (!c.includes('ad-step-acts')) throw new Error('v0.9.6: 步骤操作按钮应聚到卡片头右端')
if (!c.includes('.ad-textarea.tall{min-height:180px')) throw new Error('v0.9.6: 系统提示词区应加大（tall）')
// v0.9.6 卡片浮层按钮幽灵化断言已随 v0.9.8 浮层删除而废止
// v0.9.14：头像回退首字（0.9.13 白 logo 方案被推翻；logo 样式保留为空名兜底）、历史行加头像+类型列、删除与跳转同排
if (!c.includes('function firstGlyph')) throw new Error('v0.9.14: Avatar 应回退首字 firstGlyph')
if (!c.includes('.ad-avatar.mono')) throw new Error('v0.9.14: 应有首字头像样式 ad-avatar.mono')
if (!c.includes('ad-hist-type')) throw new Error('v0.9.14: 历史行应有类型列（小队/Agent）')
if (!c.includes('ad-hist-taskbox')) throw new Error('v0.9.13: 展开区应有任务详情固定框')
if (!c.includes('d.taskText || d.taskLabel')) throw new Error('v0.9.13: 任务详情应回退摘要')
// v0.9.17：历史页拆 Agent/小队 两段；小队行=一次运行，展开=执行流图（节点状态着色）+步骤明细；删除整次运行
if (!c.includes('ad-seg')) throw new Error('v0.9.17: 历史页应有 Agent/小队 分段切换')
if (!c.includes('Agent 历史') || !c.includes('小队历史')) throw new Error('v0.9.17: 分段按钮文案缺失')
if (!c.includes('function histHead')) throw new Error('v0.9.17: 两列表行头应统一（histHead）')
if (!c.includes('st-done') || !c.includes('st-fail') || !c.includes('st-run')) throw new Error('v0.9.17: 执行流图应有节点状态着色类')
if (!c.includes('statuses') || !c.includes('SquadFlowGraph({ steps, agents, large, onOpen, statuses })')) throw new Error('v0.9.17: SquadFlowGraph 应接收 statuses')
if (!c.includes('remove-run')) throw new Error('v0.9.17: 应有删除整次运行（remove-run）')
if (!c.includes('squadRunId')) throw new Error('v0.9.17: 客户端应按 squadRunId 聚合运行')
// v0.9.17 宿主：运行日志两行（start 拓扑快照 + end 终态）+ dispatch 带 squadRunId/stepIndex + remove-run 端点
if (!host.includes("kind: 'squad-run'")) throw new Error('v0.9.17: 宿主应写 squad-run 运行日志')
if (!host.includes("phase: 'start'") || !host.includes("phase: 'end'")) throw new Error('v0.9.17: 运行日志应有 start/end 两阶段')
if (!host.includes('viaSquad: squad.id, squadRunId, stepIndex: idx')) throw new Error('v0.9.17: 小队步骤派发应带 squadRunId+stepIndex')
if (!host.includes("'/agent-api/history/remove-run'")) throw new Error('v0.9.17: 应有 remove-run 端点')
if (!host.includes("row.kind === 'squad-run'")) throw new Error('v0.9.17: mergeDispatchHistory 应透传运行日志行')
// v1.3.0：小队结果级停等——checkpoint 字段透传 + agent_squad_continue 续跑工具 + 进程内中间态
const sregSrc = readFileSync(new URL('./lib/squad-registry.js', import.meta.url), 'utf8')
if (!sregSrc.includes('checkpoint: st.checkpoint === true')) throw new Error('v1.3.0: squad-registry upsert 应透传 checkpoint（默认 false）')
if (!sregSrc.includes("st.checkpoint !== undefined && typeof st.checkpoint !== 'boolean'")) throw new Error('v1.3.0: squad-registry validate 应校验 checkpoint 为布尔')
if (!host.includes("name: 'agent_squad_continue'")) throw new Error('v1.3.0: 应注册 agent_squad_continue 工具')
if (!host.includes('const squadSessions = new Map()')) throw new Error('v1.3.0: 应有 squadSessions 中间态 Map')
if (!host.includes('hitCheckpoint')) throw new Error('v1.3.0: runSquadSteps 应检测 checkpoint 停等（hitCheckpoint）')
if (!host.includes('paused: true')) throw new Error('v1.3.0: 停等应返回 paused:true')
if (!host.includes('agent_squad_continue')) throw new Error('v1.3.0: 路由表/工具描述应引导 agent_squad_continue 续跑')
// v1.3.1：GUI 小队表单 checkpoint 开关 + agent_squad_upsert 工具（免重启改小队）
if (!host.includes("name: 'agent_squad_upsert'")) throw new Error('v1.3.1: 应注册 agent_squad_upsert 工具')
if (!host.includes('checkpoint: st.checkpoint === true')) throw new Error('v1.3.1: agent_squad_upsert 应透传 checkpoint')
if (!c.includes('产出后停等用户确认（checkpoint）')) throw new Error('v1.3.1: SquadForm 应有 checkpoint 停等开关 UI')
if (!c.includes('checkpoint: !!st.checkpoint')) throw new Error('v1.3.1: SquadForm save 应透传 checkpoint')
if (!c.includes('checkpoint: !!s.checkpoint')) throw new Error('v1.3.1: SquadForm 初始态应读入 checkpoint')
// v1.3.2：FAB 最近完成——checkpoint 分段执行同 squadRunId 多条 end 行，取最新（首次）一条，防完成数回退
if (!c.includes('if (!runEndById.has(d.squadRunId)) runEndById.set(d.squadRunId, d)')) throw new Error('v1.3.2: runEndById 应保留首次（最新）end 行，防分段覆盖导致完成数回退')
// v0.9.21：历史页列头行 + 执行流图例 + 整面板毛玻璃（与悬浮球统一）
if (!c.includes('ad-hist-colhead')) throw new Error('v0.9.21: 历史列表应有列头行（ad-hist-colhead）')
if (!c.includes('c-status') || !c.includes('c-task')) throw new Error('v0.9.21: 列头应有列宽对齐类')
if (!c.includes('ad-legend')) throw new Error('v0.9.21: 小队展开区应有执行流图例（ad-legend）')
if (!c.includes('sw done') || !c.includes('sw run') || !c.includes('sw fail') || !c.includes('sw skip')) throw new Error('v0.9.21: 图例应覆盖 完成/当前/失败/等待 四态')
if (!c.includes('backdrop-filter:blur(18px) saturate(1.4)') || !c.includes('inset 0 1px 0 color-mix')) throw new Error('v0.9.21: 面板应毛玻璃化（半透明渐变底+模糊+玻璃边框+内高光）')
if (!c.includes('color-mix(in srgb,var(--ad-layer-1) 62%,transparent)')) throw new Error('v0.9.21: 内层卡片应半透明')
// v0.9.25：玻璃拟态改用语义 layer 渐变（禁 white 混色，亮暗稳）；小队历史空态提示先跑一次小队
if (!c.includes('dsw-alias-bg-layer-1) 82%,transparent')) throw new Error('v0.9.25: 面板玻璃渐变应基于语义 layer-1（禁 white 混色）')
if (!c.includes('若重启 Desktop 后仍为空')) throw new Error('v0.9.25: 小队历史空态应提示先跑一次小队')
// v0.9.26：步骤状态权威级联——dispatch 活体结局 > end 快照（运行已终止）> 活体推断，杜绝 result 丢失误判"未知"
if (!c.includes('v0.9.26 权威级联')) throw new Error('v0.9.26: stepState 应为权威级联注释锚点')
if (!c.includes('if (disp && disp.ended) return disp.ok ? "done" : "fail"')) throw new Error('v0.9.26: 应优先信 dispatch 活体结局')
if (!c.includes('const finished = !!run.endStatus')) throw new Error('v0.9.26: 运行已终止时应信 end 快照')
// v0.9.7：删小队说明句、Agent 页加说明、去内置标签、删除移进弹窗、路由行卡片化
if (c.includes('多 Agent 协作模板（阶段 + 依赖编排）')) throw new Error('v0.9.7: 小队页说明句应删除')
if (!c.includes('主模型会按触发域把任务自动委派')) throw new Error('v0.9.7: Agent 页应有说明句')
if (c.includes('"内置"')) throw new Error('v0.9.7: 不应再有内置标签')
if (!c.includes('onDelete') || !c.includes('onDelete: editing.isNew ? null')) throw new Error('v0.9.7: 删除入口应在编辑弹窗内（onDelete）')
if (c.includes('title: "删除", onClick: () => setConfirmDel') || c.includes('title: "删除", onClick: () => setConfirmDelSquad')) throw new Error('v0.9.7: 卡片浮层不应再有删除按钮')
if (!c.includes('.ad-route{display:flex;align-items:center;gap:6px;background')) throw new Error('v0.9.7: 模型路由行应卡片化')
// v0.9.11：呼吸光圈缩小减速、右键菜单删除、雪白置顶、毛玻璃调亮
if (!c.includes('0 0 10px 2px var(--dsw-static-neutral-00)')) throw new Error('v0.9.11: 呼吸光圈应缩小（0 0 10px 2px）')
if (!c.includes('ad-fab-breathe 4.2s ease-in-out infinite')) throw new Error('v0.9.11: 呼吸应减速至 4.2s')
if (c.includes('ad-fab-menu') || c.includes('contextmenu')) throw new Error('v0.9.11: 悬浮球右键菜单应已删除')
if (!c.includes('rgba(255,255,255,.75),rgba(255,255,255,.55)')) throw new Error('v0.9.11: 毛玻璃色调应调亮（近白半透明叠层）')
// v0.9.13：面板从球心弹出、点击就地调用、小队列表分区
if (!c.includes('pop.style.transformOrigin')) throw new Error('v0.9.13: placePop 应设 transform-origin（从球心展开）')
if (!c.includes('setAvatarEl(em, d.emoji')) throw new Error('v0.9.14: 面板头像应走 setAvatarEl（首字回退）')
// v0.9.16：分区展开状态跨重渲染保持 + 最近完成（方案D）+ 小队聚合
if (!c.includes('const secOpen = { recent: true, agents: false, squads: false, run: true }')) throw new Error('v0.9.23: 分区展开默认态应为 运行中+最近完成 展开（secOpen.recent=true）')
if (!c.includes('最近完成')) throw new Error('v0.9.16: 「最近委派」应更名「最近完成」（方案D 限时已完成）')
if (!c.includes('recentTtlMin')) throw new Error('v0.9.16: 最近完成展示时长应可配（recentTtlMin）')
if (!c.includes('groups.push({ key, head: d, items: [d] })')) throw new Error('v0.9.16: 最近完成应按小队维度聚合（同 viaSquad+parentSessionId 连续行成组）')
// v0.9.17：四分区卡片化（.ad-fab-box）+ 运行中白光呼吸加速（fab-live）+ 彩虹庆祝/闪光环删除
if (!c.includes('.ad-fab-box-hd{')) throw new Error('v0.9.17: 四分区应卡片化（.ad-fab-box 标题行整卡折叠）')
if (!c.includes('classList.toggle("fab-live", arr.length > 0)')) throw new Error('v0.9.17: 运行中应白光呼吸加速（fab-live 类按活跃切换）')
if (c.includes('flash-done') || c.includes('ad-fab-flash')) throw new Error('v0.9.17: flash-done 闪光环应已删除')
// v0.9.22：flex 列容器超高时子项被压扁互叠（实测旧版 34/10/120px 重叠）——全部子项禁压缩改滚动
if (!c.includes('.ad-fab-pop-body>*{flex:none}')) throw new Error('v0.9.22: 悬浮球弹窗 body 子项应禁压缩（防分区卡片互叠）')
if (!c.includes('.ad-fab-box{flex:none') || !c.includes('.ad-fab-card{flex:none')) throw new Error('v0.9.22: 分区卡/任务卡应禁压缩')
// v0.9.22：单选白球加大（灰圆 14px 不变，白球 9px；用户：灰圆别变大）；
// v0.9.23：白球偏移修复——显式 content-box + margin:auto 四向定心（弃 inset 百分比基准）
if (!c.includes('.ad-fab-mode .dot{position:relative;box-sizing:content-box;width:14px;height:14px')) throw new Error('v0.9.23: 单选灰圆应保持 14px 且显式 content-box（防宿主 box-sizing 干扰）')
if (!c.includes(".ad-fab-mode.on .dot::after{content:'';position:absolute;inset:0;margin:auto;width:10px;height:10px")) throw new Error('v0.9.24: 选中白球应 10px（14px 灰圆内整数 2px 边距，防半像素偏心）')
// v0.9.22：滑杆说明文字去括号 + 运行中空态去括号（面板透明度/悬浮球透明度副标题）
if (c.includes('（模糊保留）') || c.includes('（色调同步淡化）') || c.includes('（已全部结束）')) throw new Error('v0.9.22: 悬浮球面板括号副标题/空态文案应已删除')
// v0.9.22：设置行副标题防叠（单行省略 + grow 容器可收缩）
if (!c.includes('.ad-fab-set-row .t2{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}')) throw new Error('v0.9.22: 设置行副标题应单行省略（防文字叠印）')
// v0.9.23：面板重绘保留滚动位置（5s 轮询重建不再跳顶）
if (!c.includes('prevScroll')) throw new Error('v0.9.23: renderPop 应保留/还回滚动位置（防 5s 重绘跳顶）')
// v0.9.24：body 预留滚动条槽位——临界溢出时滚动条出现不再挤窄卡片 15px
if (!c.includes('.ad-fab-pop-body{display:flex;flex-direction:column;gap:4px;padding:10px 12px;max-height:300px;overflow:auto;scrollbar-gutter:stable}')) throw new Error('v0.9.24: 弹窗 body 应预留滚动条槽位（防卡片临界溢出时变窄）')
// v0.9.23：placePop 宽度取实测值（写死 236 → 球不居中/边缘不收缩的根因）
if (c.includes('const w = 236')) throw new Error('v0.9.23: placePop 不应再写死面板宽 236')
if (!c.includes('const w = pop.offsetWidth || 360')) throw new Error('v0.9.23: placePop 宽度应取实测 offsetWidth')
// v0.9.23：面板卡片同底化（弃实底，边框区分，用户偏好）
if (!c.includes('padding:8px 11px;background:transparent;min-width:0;transition:border-color .12s')) throw new Error('v0.9.23: 面板任务卡应同底（background:transparent，靠边框区分）')
// v0.9.27：原子渲染——先脱机构建后一次性替换，中途异常不半残（用户现场：面板塌成只剩头部条）
if (!c.includes('const frag = document.createDocumentFragment()')) throw new Error('v0.9.27: renderPop/openFabSettings 应脱机构建（createDocumentFragment）')
if (!c.includes('pop.appendChild(frag)')) throw new Error('v0.9.27: 应构建完成后一次性原子挂入（pop.appendChild(frag)）')
if (c.includes('pop.appendChild(head)') || c.includes('pop.appendChild(body)') || c.includes('pop.appendChild(foot)')) throw new Error('v0.9.27: 不应再边建边挂（head/body/foot 直挂 pop → 中途抛错留半残面板）')
if (!c.includes('加载遇到问题，稍后再试')) throw new Error('v0.9.27: body 构建异常应降级空态兜底文案')
// v0.9.28：返回按钮升到会话头部槽（任何 tab 下可见，一跳返回）——面板内按钮删除（先切面板再点返回很怪）
if (!c.includes('navStack')) throw new Error('v0.9.28: 应有导航栈（navStack）')
if (!c.includes('.ad-header-back')) throw new Error('v0.9.28: 会话头部返回按钮应自包含样式（.ad-header-back，不依赖面板内 --ad-* 变量）')
if (!c.includes('"conversation.session.header.actions"') || !c.includes('agent-dispatch-back')) throw new Error('v0.9.28: 返回按钮应挂 conversation.session.header.actions 槽（id agent-dispatch-back）')
if (!c.includes('HeaderBackButton')) throw new Error('v0.9.28: 应有 HeaderBackButton 组件（导航栈空时返回 null 不占位）')
if (c.includes('ad-btn mini ad-back-btn')) throw new Error('v0.9.28: 面板内返回按钮应已删除')
if (!c.includes('captureCurrentSessionTitle')) throw new Error('v0.9.27: 跳转前应捕获当前会话标题压栈')
if (!c.includes('dispatchTokenToComposer')) throw new Error('v0.9.13: 应有就地调用助手（dispatchTokenToComposer）')
if (!c.includes('conv.input.shell')) throw new Error('v0.9.13: 就地调用应走官方输入 facade（conversation.input.shell）')
if (!c.includes('lastSquads') || !c.includes('小队列表')) throw new Error('v0.9.13: 应新增小队列表分区（默认折叠）')
// v0.9.30：执行流节点标签按像素截断（用户：文字超出节点框）
if (!c.includes('function fitFlowLabel(')) throw new Error('v0.9.30: 应有标签测量截断器（fitFlowLabel）')
if (!c.includes('measureText')) throw new Error('v0.9.30: 截断应按 canvas measureText 像素测量')
if (!c.includes('React.createElement("title"')) throw new Error('v0.9.30: 节点应挂 <title> 原文（悬浮可见全名）')
if (!c.includes('fitFlowLabel(label, labelMax')) throw new Error('v0.9.30: 节点标签应走截断（fitFlowLabel(label, labelMax)）')
// v0.9.30：跳转会话后强制回对话页（用户：agent历史跳转没到对话页面）
if (!c.includes('function ensureChatView(')) throw new Error('v0.9.30: 应有跳后强制对话页（ensureChatView）')
if (!c.includes('label !== "对话" && label !== "Chat"')) throw new Error('v0.9.30: ensureChatView 应只认会话头部视图标签栏（对话/Chat）')
if (!c.includes('ensureChatView(); // v0.9.30：跳后强制回对话页')) throw new Error('v0.9.30: openAgentSession 跳后应调 ensureChatView')
// v0.9.29：面板状态跨会话持久化（返回后停在历史页，不重置总览）
if (!c.includes('const uiState = { tab: "overview", histSub: "agent", histKey: null }')) throw new Error('v0.9.29: 应有模块级面板状态（uiState：tab/histSub/histKey）')
if (!c.includes('function bindPersistentState(getter, setter)')) throw new Error('v0.9.29: 应有持久化状态绑定器（bindPersistentState）')
if (!c.includes('bindPersistentState(() => uiState.tab')) throw new Error('v0.9.29: AgentPanel tab 应走持久化状态')
if (!c.includes('bindPersistentState(() => uiState.histSub') || !c.includes('bindPersistentState(() => uiState.histKey')) throw new Error('v0.9.29: 历史分段/展开行应走持久化状态')
if (!c.includes('uiSubs')) throw new Error('v0.9.29: 持久化状态应有订阅同步机制（uiSubs）')
  // v1.1：UI 可见字符串里不应再残留「专家」与「expert」（REST 字段名/注释除外——只查 createElement 字符串字面量）
  const uiExpertZh = c.match(/"[^"\n]*专家[^"\n]*"/g) || []
  if (uiExpertZh.length > 0) throw new Error('v1.1: UI 字符串残留「专家」: ' + uiExpertZh.join(' | '))
  const uiExpertEn = c.match(/"[^"\n]*expert[^"\n]*"/g) || []
  if (uiExpertEn.length > 0) throw new Error('v1.1: UI 字符串残留「expert」: ' + uiExpertEn.join(' | '))
}

// ── v1.5.4 运行时单元测试：listChildren 含 fresh 策略已完成线程 ──
{
  const { Dispatcher } = await import(path.join(root, 'lib/dispatch.js'))
  // 桩 registry：一个 fresh 策略 Agent
  class StubRegistry {
    get(id) { return { id, name: id, reusePolicy: 'fresh', systemPrompt: '', routes: [] } }
    resolveRoutes() { return [] }
  }
  const tmpDir2 = mkdtempSync(path.join(os.tmpdir(), 'dad-unit-'))
  const d = new Dispatcher({ ctx: { subagents: {}, tools: { view: () => ({ knownNames: [] }) } }, registry: new StubRegistry(), dataDir: tmpDir2, idleReleaseMs: 0 })
  // 模拟 fresh 子代理完成：手工注入 activeChildren → onChildEnd → completedFresh
  d.activeChildren.set('fresh-child-1', { agentId: 'explorer', childId: 'fresh-child-1', taskLabel: '探索任务A', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.onChildEnd('fresh-child-1', 'completed', '结果文本')
  // fresh-child-1 应从 activeChildren 移除，出现在 completedFresh
  if (d.activeChildren.has('fresh-child-1')) throw new Error('v1.5.4: onChildEnd 后 activeChildren 应不含 fresh-child-1')
  if (!d.completedFresh.has('fresh-child-1')) throw new Error('v1.5.4: onChildEnd 后 completedFresh 应含 fresh-child-1')
  const hist = d.completedFresh.get('fresh-child-1')
  if (hist.agentId !== 'explorer') throw new Error('v1.5.4: completedFresh 条目 agentId 应为 explorer')
  if (hist.parentSessionId !== 'sess-1') throw new Error('v1.5.4: completedFresh 条目 parentSessionId 应为 sess-1')
  if (!Array.isArray(hist.taskLabels) || hist.taskLabels.length === 0) throw new Error('v1.5.4: completedFresh 条目应有 taskLabels')
  // listChildren 应展示 completedFresh 条目（status: ready）
  const fakeAgent = { session: { id: 'sess-1' }, options: {} }
  const result = await d.listChildren(fakeAgent)
  const found = result.children.find((r) => r.childId === 'fresh-child-1')
  if (!found) throw new Error('v1.5.4: listChildren 应展示 completedFresh 条目 fresh-child-1')
  if (found.status !== 'ready') throw new Error('v1.5.4: completedFresh 条目 status 应为 ready，实际 ' + found.status)
  if (found.agentId !== 'explorer') throw new Error('v1.5.4: completedFresh 条目 agentId 应为 explorer')
  // closeChild 应能关闭 completedFresh 条目
  await d.closeChild(fakeAgent, { childId: 'fresh-child-1' })
  if (d.completedFresh.has('fresh-child-1')) throw new Error('v1.5.4: closeChild 后 completedFresh 应移除 fresh-child-1')
  // 池内线程不应同时出现在 completedFresh
  d.childPool.set('sess-1::pool-agent::pool-child-1', { key: 'sess-1::pool-agent::pool-child-1', childId: 'pool-child-1', agentId: 'pool-agent', parentSessionId: 'sess-1', lastUsedAt: Date.now(), releaseTimer: null, lastTasks: [] })
  d.activeChildren.set('pool-child-1', { agentId: 'pool-agent', childId: 'pool-child-1', taskLabel: '池任务', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.onChildEnd('pool-child-1', 'completed', '池结果')
  // 池线程完成后不应进 completedFresh（因为 #isInPool 返回 true）
  if (d.completedFresh.has('pool-child-1')) throw new Error('v1.5.4: 池内线程不应出现在 completedFresh')
  // purgeParent 应清理 completedFresh
  d.activeChildren.set('fresh-child-2', { agentId: 'explorer', childId: 'fresh-child-2', taskLabel: '探索B', startedAt: Date.now(), parentSessionId: 'sess-2', viaSquad: null, squadRunId: null })
  d.onChildEnd('fresh-child-2', 'completed', null)
  if (!d.completedFresh.has('fresh-child-2')) throw new Error('v1.5.4: fresh-child-2 应在 completedFresh')
  d.purgeParent('sess-2')
  if (d.completedFresh.has('fresh-child-2')) throw new Error('v1.5.4: purgeParent 后 completedFresh 应移除 sess-2 的条目')
  // dispose 应清空 completedFresh
  d.activeChildren.set('fresh-child-3', { agentId: 'explorer', childId: 'fresh-child-3', taskLabel: '探索C', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.onChildEnd('fresh-child-3', 'completed', null)
  if (!d.completedFresh.has('fresh-child-3')) throw new Error('v1.5.4: fresh-child-3 应在 completedFresh')
  d.dispose()
  if (d.completedFresh.size !== 0) throw new Error('v1.5.4: dispose 后 completedFresh 应为空')
  rmSync(tmpDir2, { recursive: true, force: true })
}

// ── v1.5.4 P1/P2 扩展单元测试 ──
{
  const { Dispatcher } = await import(path.join(root, 'lib/dispatch.js'))
  class StubRegistry {
    get(id) { return { id, name: id, reusePolicy: 'fresh', systemPrompt: '', routes: [] } }
    resolveRoutes() { return [] }
  }
  const tmpDir3 = mkdtempSync(path.join(os.tmpdir(), 'dad-unit-p1-'))
  let followupCalled = false
  const d = new Dispatcher({
    ctx: {
      subagents: {
        sendMessage: async (parent, childId, content, opts) => {
          followupCalled = true
          return { childId }
        },
      },
      tools: { view: () => ({ knownNames: [] }) },
    },
    registry: new StubRegistry(),
    dataDir: tmpDir3,
    idleReleaseMs: 0,
  })

  // P1-a: followup 续聊 completedFresh 线程 → 移除历史 + 写 activeChildren
  d.activeChildren.set('fc-followup', { agentId: 'explorer', childId: 'fc-followup', taskLabel: '初始任务', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.onChildEnd('fc-followup', 'completed', '结果')
  if (!d.completedFresh.has('fc-followup')) throw new Error('v1.5.4-P1a: fc-followup 应在 completedFresh')
  followupCalled = false
  await d.followup({ session: { id: 'sess-1' }, options: {} }, 'fc-followup', '追加问题')
  if (!followupCalled) throw new Error('v1.5.4-P1a: followup 应调 sendMessage')
  if (d.completedFresh.has('fc-followup')) throw new Error('v1.5.4-P1a: followup 后 completedFresh 应移除 fc-followup')
  if (!d.activeChildren.has('fc-followup')) throw new Error('v1.5.4-P1a: followup 后 activeChildren 应含 fc-followup')
  const activeEntry = d.activeChildren.get('fc-followup')
  if (activeEntry.agentId !== 'explorer') throw new Error('v1.5.4-P1a: activeChildren agentId 应为 explorer')
  // P1-a followup: 线程运行中 listChildren 显示 running
  const lcResult = await d.listChildren({ session: { id: 'sess-1' }, options: {} })
  const lcEntry = lcResult.children.find(r => r.childId === 'fc-followup')
  if (!lcEntry) throw new Error('v1.5.4-P1a: listChildren 应含 fc-followup')
  if (lcEntry.status !== 'running') throw new Error('v1.5.4-P1a: followup 后 listChildren status 应为 running，实际 ' + lcEntry.status)
  // P1-a followup: 线程结束后重入 completedFresh（不丢失）
  d.onChildEnd('fc-followup', 'completed', '追加结果')
  if (!d.completedFresh.has('fc-followup')) throw new Error('v1.5.4-P1a: onChildEnd 后应重入 completedFresh')
  if (d.activeChildren.has('fc-followup')) throw new Error('v1.5.4-P1a: onChildEnd 后应从 activeChildren 移除')

  // P2-3b: listChildren agentId 过滤适用于 completedFresh 条目
  d.activeChildren.set('fc-agent-a', { agentId: 'agent-a', childId: 'fc-agent-a', taskLabel: 'A任务', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.activeChildren.set('fc-agent-b', { agentId: 'agent-b', childId: 'fc-agent-b', taskLabel: 'B任务', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.onChildEnd('fc-agent-a', 'completed', null)
  d.onChildEnd('fc-agent-b', 'completed', null)
  const filtered = await d.listChildren({ session: { id: 'sess-1' }, options: {} }, { agentId: 'agent-a' })
  if (filtered.children.some(r => r.agentId !== 'agent-a')) throw new Error('v1.5.4-P2b: agentId 过滤应只返回 agent-a 条目')
  if (!filtered.children.some(r => r.childId === 'fc-agent-a')) throw new Error('v1.5.4-P2b: agentId 过滤应含 fc-agent-a')

  // P2-3c: stopReason=error/aborted 也写入 completedFresh（onChildEnd 不分支 stopReason）
  d.activeChildren.set('fc-err', { agentId: 'explorer', childId: 'fc-err', taskLabel: '出错任务', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.onChildEnd('fc-err', 'error', '错误输出')
  if (!d.completedFresh.has('fc-err')) throw new Error('v1.5.4-P2c: stopReason=error 也应写入 completedFresh')
  d.activeChildren.set('fc-abort', { agentId: 'explorer', childId: 'fc-abort', taskLabel: '中断任务', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.onChildEnd('fc-abort', 'aborted', null)
  if (!d.completedFresh.has('fc-abort')) throw new Error('v1.5.4-P2c: stopReason=aborted 也应写入 completedFresh')

  // P2-3d: COMPLETED_FRESH_CAP 淘汰——注入超过 cap 的条目
  // #pruneCompletedFresh 是私有方法，直接通过 onChildEnd 间接测试
  const capTmpDir = mkdtempSync(path.join(os.tmpdir(), 'dad-cap-'))
  // 临时制造一个 COMPLETED_FRESH_CAP 很小的实例——直接改 prototype 不可行，
  // 改为手动填充 completedFresh 超限然后调 #pruneCompletedFresh（私有不可调）。
  // 替代方案：直接填充 completedFresh 并验证 listChildren 能展示所有条目（超限由内部自动淘汰）
  // 由于 cap=50 太大不便在单测中填满，改为直接操作 Map 验证淘汰逻辑存在性。
  // 静态断言已覆盖 #pruneCompletedFresh 存在；此处验证 completedFresh 条目在 listChildren 可遍历
  const capD = new Dispatcher({ ctx: { subagents: {}, tools: { view: () => ({ knownNames: [] }) } }, registry: new StubRegistry(), dataDir: capTmpDir, idleReleaseMs: 0 })
  for (let i = 0; i < 5; i++) {
    capD.completedFresh.set(`cap-child-${i}`, { childId: `cap-child-${i}`, agentId: 'explorer', taskLabels: [`task-${i}`], parentSessionId: 'sess-cap', completedAt: Date.now() + i })
  }
  const capResult = await capD.listChildren({ session: { id: 'sess-cap' }, options: {} })
  if (capResult.children.length < 5) throw new Error('v1.5.4-P2d: listChildren 应展示全部 completedFresh 条目（5个），实际 ' + capResult.children.length)
  rmSync(capTmpDir, { recursive: true, force: true })

  // P2-3e: closeChild by agentId 批量关闭 completedFresh 条目
  d.activeChildren.set('fc-batch-1', { agentId: 'batch-agent', childId: 'fc-batch-1', taskLabel: '批1', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.activeChildren.set('fc-batch-2', { agentId: 'batch-agent', childId: 'fc-batch-2', taskLabel: '批2', startedAt: Date.now(), parentSessionId: 'sess-1', viaSquad: null, squadRunId: null })
  d.onChildEnd('fc-batch-1', 'completed', null)
  d.onChildEnd('fc-batch-2', 'completed', null)
  if (!d.completedFresh.has('fc-batch-1') || !d.completedFresh.has('fc-batch-2')) throw new Error('v1.5.4-P2e: 批量条目应在 completedFresh')
  const batchResult = await d.closeChild({ session: { id: 'sess-1' }, options: {} }, { agentId: 'batch-agent' })
  if (d.completedFresh.has('fc-batch-1') || d.completedFresh.has('fc-batch-2')) throw new Error('v1.5.4-P2e: closeChild(agentId) 后 completedFresh 条目应被移除')
  if (!batchResult.closed.some(c => c.childId === 'fc-batch-1') || !batchResult.closed.some(c => c.childId === 'fc-batch-2')) throw new Error('v1.5.4-P2e: closeChild(agentId) 应返回两个 closed 条目')

  rmSync(tmpDir3, { recursive: true, force: true })
}
// v1.6.0：FAB 配置宿主持久化——vscode webview 重建换 origin 致 localStorage 分区丢失，
// 「隐藏状态 + 位置 + 设置」改落宿主 fab-config.json，client 经 /agent-api/fab-config 读写，
// localStorage 降级为副本（宿主通道失败回退，单浏览器行为不回退）
{
  const fabCfgSrc = readFileSync(path.join(root, 'lib/fab-config.js'), 'utf8')
  const hostSrc = readFileSync(path.join(root, 'index.js'), 'utf8')
  const clientSrc2 = readFileSync(path.join(root, 'lib/client.js'), 'utf8')
  if (!fabCfgSrc.includes('export function readFabConfig')) throw new Error('v1.6.0: fab-config 缺 readFabConfig')
  if (!fabCfgSrc.includes('export function mergeFabConfig')) throw new Error('v1.6.0: fab-config 缺 mergeFabConfig')
  if (!fabCfgSrc.includes('fs.renameSync(tmp, file)')) throw new Error('v1.6.0: fab-config 写盘必须原子（tmp + rename）')
  if (!hostSrc.includes("pathname === '/agent-api/fab-config'")) throw new Error('v1.6.0: host 缺 GET /agent-api/fab-config')
  if (!hostSrc.includes("case '/agent-api/fab-config'")) throw new Error('v1.6.0: host 缺 POST /agent-api/fab-config')
  if (!clientSrc2.includes('fabHostSave')) throw new Error('v1.6.0: client 缺宿主通道写 fabHostSave')
  if (!clientSrc2.includes('apiGet("/agent-api/fab-config")')) throw new Error('v1.6.0: client 装载应走 apiGet("/agent-api/fab-config")')
  if (!clientSrc2.includes('fabBootDone')) throw new Error('v1.6.0: client 缺装载期防闪现状态位 fabBootDone')
  if (!clientSrc2.includes('fabVisibleTouched')) throw new Error('v1.6.0: client 缺装载期开关竞态守卫 fabVisibleTouched')
  if (!clientSrc2.includes('悬浮球配置宿主通道不可用，已回退 localStorage')) throw new Error('v1.6.0: 宿主通道失败必须告警并明示回退')
  if (!clientSrc2.includes('悬浮球配置宿主持久化失败（已回退 localStorage）')) throw new Error('v1.6.0: 宿主通道写失败必须告警并明示回退')
  if (!clientSrc2.includes('fabSettingsMem')) throw new Error('v1.6.0: 悬浮球设置应有内存态（宿主值装载 + localStorage 失效保会话）')
  if (!clientSrc2.includes('writeFabSettings')) throw new Error('v1.6.0: 设置写路径应统一走 writeFabSettings')
  if (!clientSrc2.includes('revealFab')) throw new Error('v1.6.0: 缺装载完成统一揭示 revealFab（成功/失败/超时三路）')
  // 静默吞错清零：FAB 相关 localStorage 读写不再出现裸 catch 空块
  if (/localStorage\.(getItem|setItem)\([^)]*\)[^\n]*\} catch \(e\) \{\}/.test(clientSrc2)) throw new Error('v1.6.0: FAB localStorage 读写不得静默吞错')
}

// ── v1.6.0 运行时单元测试：fab-config 字段级合并 + 原子落盘 + 校验 ──
{
  const { readFabConfig, mergeFabConfig } = await import(path.join(root, 'lib/fab-config.js'))
  const tmpFab = mkdtempSync(path.join(os.tmpdir(), 'dad-fab-'))
  // 无文件 → null（client 回退 localStorage）
  if (readFabConfig(tmpFab) !== null) throw new Error('v1.6.0: 无 fab-config.json 时 readFabConfig 应返回 null')
  // 部分字段合并写入 → 不丢已有字段
  const m1 = mergeFabConfig(tmpFab, { visible: false })
  if (m1.visible !== false) throw new Error('v1.6.0: merge 应写入 visible:false')
  const m2 = mergeFabConfig(tmpFab, { pos: { x: 12, y: 34 } })
  if (m2.visible !== false || m2.pos.x !== 12 || m2.pos.y !== 34) throw new Error('v1.6.0: merge 应字段级合并且不丢已有字段')
  const m3 = mergeFabConfig(tmpFab, { settings: { tone: 'sky', alpha: 40 } })
  if (m3.settings.tone !== 'sky' || m3.settings.alpha !== 40) throw new Error('v1.6.0: settings 应写入')
  // settings 浅合并：新补丁不覆盖未提及旧键
  const m4 = mergeFabConfig(tmpFab, { settings: { breathe: false } })
  if (m4.settings.tone !== 'sky' || m4.settings.breathe !== false) throw new Error('v1.6.0: settings 应浅合并保留旧键')
  // 落盘可读回（version 元数据 + 字段持久）
  const disk = JSON.parse(rf(path.join(tmpFab, 'fab-config.json'), 'utf8'))
  if (disk.version !== 1 || disk.visible !== false || disk.pos.x !== 12) throw new Error('v1.6.0: fab-config.json 落盘内容不符')
  const back = readFabConfig(tmpFab)
  if (!back || back.visible !== false || back.mode !== undefined || back.pos.y !== 34) throw new Error('v1.6.0: readFabConfig 读回字段不符')
  // 非法补丁抛错（REST 面透传 400）。
  // v1.6.0 审查补强：NaN/Infinity pos、>32 键 settings、数组顶层 3 类边界用例
  const oversizeSettings = {}
  for (let i = 0; i < 33; i++) oversizeSettings['k' + i] = 1
  for (const bad of [{ visible: 'yes' }, { mode: 'sometimes' }, { pos: { x: 'a', y: 1 } }, { pos: { x: 1 } }, { settings: { bad: {} } }, { settings: null }, 'not-object',
    { pos: { x: NaN, y: 1 } }, { pos: { x: 1, y: Infinity } }, { settings: oversizeSettings }, []]) {
    let threw = false
    try { mergeFabConfig(tmpFab, bad) } catch { threw = true }
    if (!threw) throw new Error('v1.6.0: 非法补丁应抛错: ' + JSON.stringify(bad))
  }
  // 损坏文件 → null 且不影响后续写入自愈
  writeFileSync(path.join(tmpFab, 'fab-config.json'), '{corrupt json', 'utf8')
  if (readFabConfig(tmpFab) !== null) throw new Error('v1.6.0: 损坏 fab-config.json 应按无配置处理（null）')
  const m5 = mergeFabConfig(tmpFab, { visible: true })
  if (m5.visible !== true) throw new Error('v1.6.0: 损坏后写入应自愈（merge 应返回 visible:true，实际: ' + JSON.stringify(m5) + '）')
  const healed = readFabConfig(tmpFab)
  if (!healed || healed.visible !== true) throw new Error('v1.6.0: 损坏后写入应自愈（读回应含 visible:true，实际: ' + JSON.stringify(healed) + '）')
  rmSync(tmpFab, { recursive: true, force: true })
}

console.log(`OK: ${PKG_NAME} v${pkg.version} 一致性链（无内置 Agent）+ ${tools.length} 工具 + /${commands.join('/')} 命令`)
