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
for (const f of ['index.js', 'lib/client.js', 'lib/agents.js', 'lib/dispatch.js', 'lib/defaults.js', 'lib/squads.js', 'lib/squad-registry.js', 'lib/skill-import.js', 'README.md', 'CHANGELOG.md', 'LICENSE']) {
  if (!existsSync(path.join(root, f))) errors.push(`缺文件: ${f}`)
}

// 5. 冒烟：模块加载 + apply 桩测试（DSH_HOME 指到临时目录避免污染）
import { mkdtempSync, rmSync, readFileSync as rf } from 'node:fs'
import os from 'node:os'
const tmp = mkdtempSync(path.join(os.tmpdir(), 'dad-verify-'))
process.env.DSH_HOME = tmp
const mod = await import(path.join(root, 'index.js'))
if (mod.name !== PKG_NAME) errors.push(`模块导出 name 应为 ${PKG_NAME}，实际 ${mod.name}`)
if (!Array.isArray(mod.inject) || mod.inject.length === 0) errors.push('inject 数组缺失')
const tools = [], sections = [], commands = []
const ctx = {
  tools: { register: d => { tools.push(d.name); return () => {} } },
  systemPrompt: { section: s => { sections.push(s.name); return () => {} } },
  commands: { register: d => { commands.push(d.name); return () => {} } },
  subagents: {},
  get: () => undefined,
  on: () => () => {},
}
mod.apply(ctx)
await new Promise(r => setTimeout(r, 300))
for (const t of ['agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue', 'agent_import_skill', 'agent_upsert']) {
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
// v1.1.2：递归护栏——startContinuable 必须 deny 全部 5 个委派工具，物理阻断子代理再派下级
// v1.2.0：deny 清单追加 agent_upsert，防子代理通过新工具改注册表逃逸
if (!dispatchSrc.includes("toolFilter: { deny: ['agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue', 'agent_import_skill', 'agent_upsert'] }")) throw new Error('v1.3.0: startContinuable 必须 toolFilter.deny 全部 7 个委派工具（含 agent_squad_continue）')
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
console.log(`OK: ${PKG_NAME} v${pkg.version} 一致性链（无内置 Agent）+ ${tools.length} 工具 + /${commands.join('/')} 命令`)
