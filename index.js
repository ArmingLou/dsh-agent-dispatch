// @kiligzzz/dsh-agent-dispatch — host half.
//
// 预置Agent agent + 自动路由 + 小队编排插件的宿主半。
//
// 职责：
//   - Agent 注册表（$DSH_HOME/data/dsh-agent-dispatch/agents.json，改完即生效）
//   - 八个模型工具：agent_dispatch / agent_followup / agent_list /
//     agent_squad / agent_squad_continue / agent_squad_upsert /
//     agent_import_skill / agent_upsert
//   - systemPrompt 路由表 section（引导主 agent 按任务领域自动委派）
//   - /agent-api REST 面（v1.0：主面板 + 总览页 + 悬浮球全数据通道）
//
// 委派走 ctx.subagents.startContinuable（宿主原生可续聊子代理），
// v1.5.0 起：同角色子代理复用池（sendMessage 续聊/冷恢复）+ 空闲回收
// （drainContinuableChildren 释放驻留），persona 注入Agent系统提示词，
// agentOptions 按Agent routes 做模型路由与失败互备。
// 零 @deepseek-ai/dsh-tools 依赖（规避官方双实例 bug #1697/#783），
// 工具注册用 ctx.tools.register 裸对象最小形状。
//
// 以 profile bundle 行挂载（cordis.patch.yml + dsh.bundle.patch）。
// 浏览器半（lib/client.js）注册主面板到宿主 conversation.view 槽，
// + 会话头部返回按钮 + / 触发器 Agent 候选菜单 + 悬浮活动球，
// 统统走同源 fetch 调 /agent-api/*。

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { AgentRegistry } from './lib/agents.js'
import { Dispatcher, FAILOVER_MODES, serializePermissionPending as permPending } from './lib/dispatch.js'
import { DEFAULT_SQUADS, renderInstruction, topoLayers } from './lib/squads.js'
import { SquadRegistry } from './lib/squad-registry.js'
import { listSkills, skillToAgent, defaultSkillsRoot } from './lib/skill-import.js'
import { readFabConfig, mergeFabConfig } from './lib/fab-config.js'
import { renderRoster } from './lib/roster.js'
import { HostApprovalRules, resolveApprovalContext, resolveRootSessionId, isDisallowedAutoGrant, isSandboxEscalation, isAcpTwinApproval, isDelegatedSession, validateDeclaredPaths, dangerousCommandMatch, boundDangerText, MAX_DANGER_TEXT_CHARS, COMMAND_TOO_LONG_RULE } from './lib/host-approval.js'
import { jsonSafe } from './lib/json-safe.js'

export const name = '@kiligzzz/dsh-agent-dispatch'

/**
 * v1.11.21：工具出参收口标记。`registerTool` 给每个经 jsonSafe 包装的工具定义打上
 * （不可枚举），`verify.mjs` 用同一个 Symbol 做**行为级**断言：注册进来的工具是不是
 * 全部过了收口——比"数源码里出现几次 registerTool"可靠（后者能被注释/换行绕过）。
 */
export const JSON_SAFE_MARK = Symbol.for('dsh-agent-dispatch/jsonSafe-tool')

export const inject = ['tools', 'subagents', 'systemPrompt', 'agents']

export function apply(ctx, config = {}) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dataDir = path.join(dshHome, 'data', 'dsh-agent-dispatch')

  // ── 注册表与派遣器 ──
  const registry = new AgentRegistry(dataDir)
  // v1.5.0：空闲回收时长——config.idleReleaseMs > 环境变量 DSH_AGENT_DISPATCH_IDLE_RELEASE_MS > 默认 10 分钟；
  // 0 关闭自动释放（子代理驻留到父会话结束）。
  const cfgIdle = Number(config.idleReleaseMs) > 0 ? Number(config.idleReleaseMs) : 0
  const envIdle = Number(process.env.DSH_AGENT_DISPATCH_IDLE_RELEASE_MS) > 0 ? Number(process.env.DSH_AGENT_DISPATCH_IDLE_RELEASE_MS) : 0
  const idleReleaseMs = cfgIdle || envIdle || undefined
  // v1.11.22：fallback 链语义配置（见 lib/dispatch.js 同名 JSDoc）
  //   failoverInTurn  默认 true  —— 失败档在自己回合内把链走完，主代理只看到一次最终结果；
  //                                 false 退回 v1.11.21 行为（结算通知先于换档，中间态信号会泄漏）。
  //   failoverWaitMs  默认 900000（15 分钟）——回合内等链走完的上限，超时按链走完仍失败处理。
  //   failoverGrades  code → failover|fatal|interrupted 的分级覆盖（与 product-subagents
  //                                 config.submitFailureGrades 同名同义）。
  const envFailoverInTurn = process.env.DSH_AGENT_DISPATCH_FAILOVER_IN_TURN
  const cfgFailoverInTurn = typeof config.failoverInTurn === 'boolean'
    ? config.failoverInTurn
    : envFailoverInTurn === '0' || envFailoverInTurn === 'false'
      ? false
      : envFailoverInTurn === '1' || envFailoverInTurn === 'true'
        ? true
        : undefined
  const cfgFailoverWaitMs = Number(config.failoverWaitMs) > 0 ? Number(config.failoverWaitMs) : 0
  // v1.11.24：换档交接模式（见 lib/dispatch.js 同名 JSDoc）
  //   failoverMode  auto | notify | notify-then-auto，默认 notify（纯手动）：
  //                   失败档把换档决定权交给主代理（agent_failover），替补档是主代理的
  //                   【直接子级】可双向对话；主代理不响应即失败，不自动换档。
  //                   auto = v1.11.23 行为（回合内自动孙代链）；notify-then-auto =
  //                   先等主代理，超时逐字退回 auto 链。
  //   notifyWaitMs  notify 模式下等主代理决定的上限，默认 90000。
  const envFailoverMode = process.env.DSH_AGENT_DISPATCH_FAILOVER_MODE
  const rawFailoverMode = typeof config.failoverMode === 'string' ? config.failoverMode : envFailoverMode
  const cfgFailoverMode = typeof rawFailoverMode === 'string' ? rawFailoverMode.trim().toLowerCase() : ''
  const cfgNotifyWaitMs = Number(config.notifyWaitMs) > 0 ? Number(config.notifyWaitMs) : 0
  const envNotifyWaitMs = Number(process.env.DSH_AGENT_DISPATCH_NOTIFY_WAIT_MS) > 0
    ? Number(process.env.DSH_AGENT_DISPATCH_NOTIFY_WAIT_MS)
    : 0
  // v1.11.12：注入 ACP provider 目录读取器（懒解引用：readProductCatalog 在本函数
  // 后段才声明，直接传会命中 TDZ）。仅用于派发日志的可疑 model/effort 预检。
  const dispatcher = new Dispatcher({
    ctx,
    registry,
    dataDir,
    productCatalog: () => readProductCatalog(),
    ...(idleReleaseMs ? { idleReleaseMs } : {}),
    ...(cfgFailoverInTurn !== undefined ? { failoverInTurn: cfgFailoverInTurn } : {}),
    ...(cfgFailoverWaitMs ? { failoverWaitMs: cfgFailoverWaitMs } : {}),
    ...(FAILOVER_MODES.has(cfgFailoverMode) ? { failoverMode: cfgFailoverMode } : {}),
    ...((cfgNotifyWaitMs || envNotifyWaitMs) ? { notifyWaitMs: cfgNotifyWaitMs || envNotifyWaitMs } : {}),
    ...(config.failoverGrades && typeof config.failoverGrades === 'object' ? { failoverGrades: config.failoverGrades } : {}),
  })

  // v1.10.0：主代理宿主审批分档规则引擎——「本会话总是允许」（内存，键=session）
  // 与「总是允许(项目)」（落盘共用 allowlist.json，键=cwd+路径，与 ACP 层双向复用）。
  // 供下方 'approval/request' prepend 监听自动放行 + REST 写规则端点使用。
  const hostApproval = new HostApprovalRules(dataDir)

  /**
   * v1.12.4：审批放行/授权清理的留痕——console 之外再写一行决策日志。
   *
   * 沿用 v1.11.23 的理由（那条理由在这里同样成立，不是不适用）：DSH 的 stdout 是
   * 终端 socket，console 只在终端闪一下，进程重启后不留痕迹。而「这次审批为什么被
   * 自动放行（命中哪一档、哪个键）」「我的会话授权为什么没了（清了哪个键）」正是
   * 事后排障要问的两件事——本轮的阻断与三个 Major 全都出在**键**上，只靠宿主
   * approval/asked+decided 审计看不出写读键是否一致。
   * 频次有界：一条 = 一次自动放行 / 一次真正清理到东西的 session dispose，
   * 与既有 dispatch/result 行同量级。kind 用 'host-approval'，历史页按
   * mergeDispatchHistory 的观测行规则剔除（同 'config'）。
   *
   * @param {string} message 面向人的中文说明
   * @param {object} row 机器可读字段（sid/root/scope/tool 等）
   */
  const logApproval = (message, row) => {
    console.log(`[dsh-agent-dispatch] ${message}`)
    try {
      dispatcher.logDiagnostic({ kind: 'host-approval', ok: true, message, ...row })
    } catch { /* 留痕失败不影响审批判定本身 */ }
  }

  // v1.4.1 执行级递归护栏（v1.5.0 重构）：宿主已删除 registerContinuableSetup，
  // 改为【全局 tools.guard】——按调用方 subagentDepth>=1 在【执行时】拒绝子代理调用
  // 任何"再起新代理 / 管理委派树"的工具。全局守卫天然覆盖所有插件层工具
  //（含未在本插件 deny 名单里的跨插件工具如 product_delegate）：
  //   - 主代理（depth 0）：放行；
  //   - 子代理（depth>=1）：委派工具执行期拒绝。
  // 豁免项：send_message（子代理→父级回传结果，替代旧 report；宿主服务强制相邻
  // 关系，子代理只能发给直接父级）、product_submit（ACP 中继转发任务）。
  // 与 dispatch() 入口 callerDepth 硬检查 + startContinuable toolFilter.deny 三保险。
  const noDelegateTools = new Set([
    'agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue',
    'agent_squad_upsert', 'agent_upsert', 'agent_import_skill', 'agent_close', 'agent_children',
    // v1.11.24：换档是【编排层】的职责——子代理不得自己给兄弟任务换档，
    // 更不得借换档绕过"不得再向下委派"的硬闸（主代理 depth 0 放行）。
    'agent_failover',
    'subagent', 'subagent_fork', 'subagent_progress', 'list_agents', 'interrupt_agent',
    'product_delegate', 'product_wait', 'product_roles', 'product_agents',
    'workflow', 'ralph', 'create_goal', 'get_goal', 'update_goal',
  ])
  try {
    ctx.tools.guard((exec) => {
      const depth = exec?.agent?.options?.subagentDepth ?? 0
      if (depth >= 1 && noDelegateTools.has(exec.name)) {
        return `[dsh-agent-dispatch] 子代理（深度 ${depth}）禁止再向下委派/另起代理：${exec.name} 已禁用，必须自己完成任务；超出能力时明确说明卡在哪，并向上（父级）汇报。`
      }
      return undefined
    })
  } catch (err) {
    // 个别环境无 tools.guard 等异常不阻断插件挂载（dispatch 入口硬检查兜底）
    console.error('[dsh-agent-dispatch] tools.guard 注册失败:', err.message)
  }

  // v0.7.1：订阅宿主 'subagent/end' 生命周期事件 → 子 agent 终结即移出活跃映射 + 补记真实结果。
  // 修复根因：此前 activeChildren 只增不减，活动面板永远"运行中"、FAB 完成检测永不触发。
  // 事件契约：info = { runId, provider, id: childId, stopReason?, lastAssistantMessage? }（dsh-subagent）
  let disposeEndListener = () => {}
  try {
    disposeEndListener = ctx.on('subagent/end', (info) => {
      // v0.9.36：事件带 lastAssistantMessage（子代理最后输出）→ 传给 onChildEnd 兑现 waitResult
      try { dispatcher.onChildEnd(info?.id, info?.stopReason ?? 'completed', info?.lastAssistantMessage ?? null) } catch (err) {
        console.error('[dsh-agent-dispatch] onChildEnd 失败:', err.message)
      }
    })
  } catch (err) {
    // 事件名不可用时降级：生命周期修复失效但不影响其余功能（startedAt 修正仍生效）
    console.error('[dsh-agent-dispatch] subagent/end 订阅失败:', err.message)
  }

  // v1.5.0：父会话结束 → 清理该会话的复用池条目（host 已递归回收其 lineage，
  // 这里只清插件侧状态，防内存驻留 + 防孤儿池条目被误复用）。
  // v1.10.0：同时清理该会话的宿主审批「本会话总是允许」内存规则。
  let disposeSessionListener = () => {}
  try {
    disposeSessionListener = ctx.on('session/disposed', (session) => {
      const sid = session?.id ?? (typeof session === 'string' ? session : null)
      if (sid) {
        dispatcher.purgeParent(sid)
        // v1.12.2：同时清理根会话 id 的工具名授权（子会话销毁时通过 registerSessionRoot 反查根 id）
        const purged = hostApproval.purgeSession(sid)
        // v1.12.4：清理结果落盘留痕——「授权为什么没了」必须能事后回溯。
        // 什么都没清到就不写行，避免日志被无意义的 dispose 淹没。
        if (purged.hadRules || purged.hadGrants || purged.childMappings > 0) {
          logApproval(
            `purgeSession(${purged.isRoot ? '根会话' : '子会话 root=' + purged.rootId} sid=${sid}): ` +
            `toolGrants=${purged.hadGrants} sessionRules=${purged.hadRules} childMappings=${purged.childMappings}`,
            {
              action: 'purge', sid, rootId: purged.rootId, isRoot: purged.isRoot,
              hadRules: purged.hadRules, hadGrants: purged.hadGrants,
              childMappings: purged.childMappings,
            },
          )
        }
      }
    })
  } catch (err) {
    console.error('[dsh-agent-dispatch] session/disposed 订阅失败:', err.message)
  }

  /**
   * v1.11.23：集成层降级/失败留痕——console.error 之外**再写一行决策日志**。
   *
   * 为什么必须落盘：DSH 的 stdout 是 VS Code 终端的 unix socket（不是文件），
   * console.error 只在终端闪一下，进程重启后不留任何痕迹。而这几条恰恰是最需要事后
   * 回溯的降级路径（事件总线订阅失败 → 自动换档整个失效；换档处理器登记失败 → 退回结算
   * 后换档的旧行为）。沿用 dispatcher 既有行格式（{ts, kind, ...}）追加到
   * dataDir/dispatches.jsonl，不新造格式，便于历史页/grep 统一处理。
   *
   * @param {string} text  面向人的中文说明（与原 console 文案一致）
   * @param {Error} err   原始错误
   * @param {string} component 机器可读的组件/阶段标识
   */
  const warn = (text, err, component) => {
    console.error(`[dsh-agent-dispatch] ${text}:`, err?.message ?? err)
    try {
      dispatcher.logDiagnostic({
        kind: 'plugin-warn',
        component,
        ok: false,
        message: `${text}: ${err?.message ?? String(err)}`,
      })
    } catch { /* 留痕失败不影响降级本身 */ }
  }

  // v1.7.1：订阅 product-subagents 的提交失败事件（跨插件事件总线）——relay child
  // 是 LLM agent，product_submit 工具报错后它会"转达错误"并以 completed 正常结束
  // 回合，宿主 'subagent/end' 的 stopReason 无法反映产品侧故障（空正文/超时/限流
  // 耗尽）。product-subagents 0.3.7 起在抛错处 emit 本事件，dispatcher 标记该
  // child 失败 → onChildEnd 按失败处理（健康冷却 + fallback 链自动换档）。
  let disposeSubmitFailedListener = () => {}
  try {
    disposeSubmitFailedListener = ctx.on('product-subagents/submit-failed', (info) => {
      try {
        dispatcher.markChildSubmitFailed(info ?? {})
      } catch (err) {
        warn('markChildSubmitFailed 失败', err, 'markChildSubmitFailed')
      }
      // v1.11.22：同步登记回合内换档处理器。载荷带 onFailover 时（product-subagents
      // ≥0.7.3）才登记——product_submit 会在本次工具调用里【阻塞】等本函数返回结果，
      // 于是失败档不会在链走完前结算，宿主那条结算通知也就不会提前落到主代理。
      // 旧版无此钩子 → 降级为仅 stopReason==='error' 的兜底换档（#retryOnChildFailure）。
      // v1.11.24：按 failoverMode 分流（三种模式一律派**同级**替补，差别只在谁来决定）：
      //   auto            → handleSubmitFailover：立即派同级替补，不等主代理；
      //   notify          → handleSubmitFailoverNotify：发唤醒信号等主代理，超时按失败收尾；
      //   notify-then-auto → 同上，超时后由本插件执行同一套流程自动派同级替补。
      // req.autoFallback 是 notify-then-auto 的超时兜底标记（由 product-submit 用
      // 【同一个】处理器再调一次触发，**不**二次 emit submit-failed —— 二次 emit 会因
      // 未知 code 的兜底分级是 failover 而重复登记 onFailover、再跑一条链）。
      const register = info && typeof info.onFailover === 'function' ? info.onFailover : null
      if (register) {
        try {
          register((req) => {
            if (req && req.autoFallback === true) return dispatcher.handleSubmitFailover(req)
            const mode = typeof info.failoverMode === 'string' ? info.failoverMode : dispatcher.failoverMode
            if (mode === 'auto') return dispatcher.handleSubmitFailover(req)
            return dispatcher.handleSubmitFailoverNotify(req)
          })
        } catch (err) {
          warn('回合内换档处理器登记失败', err, 'failover-handler-register')
        }
      }
    })
  } catch (err) {
    // 事件名不可用（旧版 product-subagents 无 0.3.7 发射点）→ 降级：
    // 自动换档退回仅 stopReason==='error' 触发（罕见），不阻塞其余功能
    warn('product-subagents/submit-failed 订阅失败（旧版 product-subagents?）', err, 'submit-failed-subscribe')
  }
  // v1.7.1：submit-ok 事件清除失败标记（relay child 同一回合内二次提交成功）
  let disposeSubmitOkListener = () => {}
  try {
    disposeSubmitOkListener = ctx.on('product-subagents/submit-ok', (info) => {
      try {
        dispatcher.markChildSubmitOk(info ?? {})
      } catch (err) {
        console.error('[dsh-agent-dispatch] markChildSubmitOk 失败:', err.message)
      }
    })
  } catch (err) {
    console.error('[dsh-agent-dispatch] product-subagents/submit-ok 订阅失败:', err.message)
  }

  // v1.8.0：ACP 权限审批挂起/决议事件 → 主窗口感知「待授权」
  // （审批弹窗按宿主 scope 落在子代理会话 UI，主窗口通过 FAB/面板徽标获知）
  let disposePermPendingListener = () => {}
  let disposePermResolvedListener = () => {}
  let disposeUnknownPermListener = () => {}
  try {
    disposePermPendingListener = ctx.on('product-subagents/permission-pending', (info) => {
      try { dispatcher.markPermissionPending(info ?? {}) } catch (err) {
        console.error('[dsh-agent-dispatch] markPermissionPending 失败:', err.message)
      }
    })
    disposePermResolvedListener = ctx.on('product-subagents/permission-resolved', (info) => {
      try { dispatcher.markPermissionResolved(info ?? {}) } catch (err) {
        console.error('[dsh-agent-dispatch] markPermissionResolved 失败:', err.message)
      }
    })
    // v1.11.1：ACP 未知会话权限异常（无 binding）→ 富日志 + 尽力归属父级可见提示
    disposeUnknownPermListener = ctx.on('product-subagents/permission-unknown-session', (info) => {
      try { dispatcher.markUnknownPermission(info ?? {}) } catch (err) {
        console.error('[dsh-agent-dispatch] markUnknownPermission 失败:', err.message)
      }
    })
  } catch (err) {
    console.error('[dsh-agent-dispatch] permission-pending/resolved/unknown-session 订阅失败（旧版 product-subagents?）:', err.message)
  }

  // v1.11.12：ACP 配置项被产品拒绝 → 落一行观测日志（requested vs effective）。
  // route 里写错的 model/effort 不会让回合失败（产品沿用自身默认），过去完全不可见；
  // product-subagents 0.6.x 起在拒绝处 emit 本事件，本插件只记账、不改档不重试。
  let disposeConfigErrorListener = () => {}
  try {
    disposeConfigErrorListener = ctx.on('product-subagents/config-option-error', (info) => {
      try { dispatcher.logConfigOptionError(info ?? {}) } catch (err) {
        console.error('[dsh-agent-dispatch] logConfigOptionError 失败:', err.message)
      }
    })
  } catch (err) {
    console.error('[dsh-agent-dispatch] product-subagents/config-option-error 订阅失败（旧版 product-subagents?）:', err.message)
  }

  // ── v1.10.0：主代理宿主审批自动放行（'approval/request' waterfall，插链头）──
  // 宿主 ApprovalService.request 对每次审批先落 approval/asked 审计，再
  // ctx.waterfall(scopeTarget(agent), 'approval/request', req, ()=>unavailable)
  // （dsh-user-approval/lib/index.js:131-192）。waterfall 按注册序串行，listener
  // 不调 next 直接 return 合法 outcome（'allowed-once'/'rejected'/...）即截断整条
  // 链——dsh-api-remotes 的客户端转发器（web 面板来源）在其后注册，被截断时
  // 客户端面板不再弹出。cordis ctx.on 第三参 options.prepend → hooks.unshift
  // （cordis/lib/index.js:336,371-384），本插件在 profile bundles 中晚于
  // dsh-base/dsh-web-app 加载，必须 prepend 才能先于 api-remotes 转发器。
  // dsh-scope 的 scopeTarget 过滤器对无 scope tag 的监听器全局放行
  // （dsh-scope/lib/index.js:327-337）→ 主会话与子代理会话的宿主审批都会到达。
  //   规则命中 → return 'allowed-once'（宿主仍逐条落 asked+decided 审计）；
  //   未命中 / 解析不出路径 / 内部异常 → next() 委托，宿主标准面板照常兜底。
  let disposeHostApprovalListener = () => {}
  try {
    disposeHostApprovalListener = ctx.on('approval/request', (req, next) => {
      let ctxInfo = null
      try {
        const session = req?.agent?.session
        const sessionId = session?.id
        if (!sessionId) return next()
        ctxInfo = resolveApprovalContext({ session, callId: req.callId, toolName: req.toolName, reason: req.reason })
        // 解析根会话 id：同一主代理会话内所有子代理共享工具名授权
        const rootSessionId = resolveRootSessionId(session, dispatcher, (sid) => hostApproval.sessionRootOf(sid))
        // 注册映射：purgeSession 时可从子会话 id 反查根 id 清除 #toolGrants
        // v1.12.4：只对**委派子会话**登记。fork 的 header 只有 parentSession（宿主
        // fork 不设 origin/delegationDepth），它自身就是根；若把 fork→源会话
        // 登记进 #sessionRoots，fork 派出的子代理会经链式上溯回到源会话——
        // 阻断 1 换个入口重新打开，且源会话 dispose 后再写下的键再无 purge 路径。
        if (isDelegatedSession(session)) hostApproval.registerSessionRoot(sessionId, rootSessionId)
        // 暂存上下文供 REST 端点查询/写规则（服务端重取路径，不信任客户端）
        if (req.callId && ctxInfo) {
          hostApproval.pushPendingContext(req.callId, { ...ctxInfo, sessionId, rootSessionId })
        }
        // 排除门按档位拆分（v1.12.5 用户裁定 + 二次裁定；v1.12.7 第三次裁定收窄）：
        //   ACP 孪生 → 本插件一档都不判，直接交回宿主与琥珀球（v1.11.4 语义完全不变）；
        //   沙箱越权 → v1.12.14 起**本插件对越权请求不再做任何「档位级排除」**（用户裁定：
        //     显式点项目档不降级 ⇒ 写侧照落盘、读侧照消费；v1.12.5 的「越权不得写项目白名单」
        //     与读侧 sessionOnly 双双下线，登记见 CHANGELOG）。危险命令门/超长门/无正文门
        //     仍在最前面，与档位无关。用户裁定：**工具档不受越权限制**——
        //     语义是同一工作区内该工具任意路径（含工作区外）直接放行；危险命令门、
        //     超长门、执行类无正文门在最前面，与档位无关，永远走交互。
        // 为什么改（用户本机实测）：几乎只有「沙箱越权」这一类请求会产生授权弹框
        // （子代理审批被宿主钉死、auto-review/hooks 未启用）。1.12.5/1.12.6 把越权请求
        // 从工具名档里逐请求排除 ⇒ 用户点过一次「本会话总是允许」写下的工具名授权
        // 永远读不到，工具名档在实战中形同失效。
        // 写入侧从来没被越权守卫关掉（pushPendingContext 在上面、排除门之前就已暂存上下文，
        // 客户端蓝球对 next() 委托的请求照样渲染按钮并 POST 规则；越权请求点「本会话允许」
        // 且路径清空时走的 addToolGrant 分支里没有任何 isSandboxEscalation 判据）
        // ⇒ 本次改动只动**读取侧**：让写进 #toolGrants 的那条授权真正被消费。
        // 1.12.x 的另一半回归（一刀切 return next() 让写在根会话键上的**路径**规则永远读不到）
        // 已在 v1.12.5 修掉，本次不动路径档语义。
        if (isAcpTwinApproval(ctxInfo.toolName, ctxInfo.reason)) return next()
        // v1.12.6 危险命令排除门（用户裁决）：`rm -rf` / `npm publish` / `pnpm publish` /
        // `yarn publish` / `git push` **在任何档位下都必须走交互授权**——工具名档、
        // 会话路径档、落盘项目档一律不判。等价写法（`sudo`/`bash -c`/`xargs`/`git -C`…）
        // 同属一类，判据在 lib/host-approval.js 的 DANGEROUS_COMMAND_RULES（覆盖边界与
        // 残留边界都写在它的注释里）。
        // 位置是刻意的：**早于下面所有档位判定**（工具名短路在第 400 行附近），
        // 把它挪到工具名短路之后，这些命令就会先被工具名档静默放行（有用例做顺序哨兵）。
        // **两个来源都要查**：① `commandText`（command/cmd/script 键）；② `argsText`
        // （args 里所有字符串值）——自定义执行工具 `{shell: 'rm -rf …'}` 的工具名与参数键
        // 都不在各自的名单里，只看 ① 是一次静默放行（终审阻断的最后一格）。
        // 名单与 product-subagents 的 lib/dangerous-commands.js 同源，单点常量在
        // lib/host-approval.js 的 DANGEROUS_COMMAND_RULES，改动需两边同步。
        // v1.12.6 第五轮（终审 Minor 2）：判据文本**有界截断**（MAX_DANGER_TEXT_CHARS=256KB）。
        // 这门是**线性于文本长度**的同步判定，跑在每次审批的热路径上；`argsText` 是 args 里
        // 所有字符串值的拼接（`write` 的 content / `edit` 的 new_string 动辄几 MB），
        // 终审实测 4MB ⇒ 889ms 阻塞宿主事件循环。截断只影响**判定用**的文本：
        // 下面「执行类解析不出命令文本 ⇒ 不自动放行」仍按**完整** ctxInfo.commandText 判。
        // 取舍（超长参数只检查前 256KB）写在 boundDangerText 的 JSDoc 与 CHANGELOG 里。
        // v1.12.6 第六轮（终审 Minor 3）两侧口径**分开**：`commandText` 是**真正的 shell
        // 正文**（command/cmd/commandLine/script 这五个键），超长不是常态 ⇒ **超限即保守
        // 转交互**（门名 `command-too-long`，与下面「命中危险命令」同一个方向：判不出不是
        // 放行）；`argsText` 里含 `write` 的正文、大正文是常态 ⇒ **保持截断不动**。
        const dangerCmd = boundDangerText(ctxInfo.commandText)
        const dangerArgs = boundDangerText(ctxInfo.argsText)
        if (dangerCmd.omitted > 0 || dangerArgs.omitted > 0) {
          logApproval(
            `宿主审批危险命令门：判据文本超长已截断（只检查前 ${MAX_DANGER_TEXT_CHARS} 字符）: ` +
            `tool=${ctxInfo.toolName ?? '?'} session=${sessionId} root=${rootSessionId} ` +
            `commandOmitted=${dangerCmd.omitted} argsOmitted=${dangerArgs.omitted}`,
            {
              action: 'danger-text-truncated', tool: ctxInfo.toolName ?? null,
              sessionId, rootSessionId, maxChars: MAX_DANGER_TEXT_CHARS,
              commandOmitted: dangerCmd.omitted, argsOmitted: dangerArgs.omitted,
            },
          )
        }
        // `commandText` 超限 ⇒ 后段根本没扫过，判不出**不等于**放行 ⇒ 与危险命令命中同路
        // （留痕带门名、暂存上下文带 dangerRule，客户端据此说明「每次都问、不可记忆」）。
        if (dangerCmd.omitted > 0) {
          const tooLong = {
            rule: COMMAND_TOO_LONG_RULE,
            segment: `commandText 超长（${ctxInfo.commandText.length} 字符 > ${MAX_DANGER_TEXT_CHARS}）`,
          }
          if (req.callId) {
            hostApproval.pushPendingContext(req.callId, { ...ctxInfo, sessionId, rootSessionId, dangerRule: tooLong.rule })
          }
          logApproval(
            `宿主审批不自动放行（${COMMAND_TOO_LONG_RULE}：执行类命令正文超过有界判定的上限）: ` +
            `tool=${ctxInfo.toolName ?? '?'} session=${sessionId} root=${rootSessionId} ` +
            `commandText=${ctxInfo.commandText.length} > ${MAX_DANGER_TEXT_CHARS}`,
            {
              action: 'danger-command-block', rule: tooLong.rule, tool: ctxInfo.toolName ?? null,
              sessionId, rootSessionId, segment: tooLong.segment,
            },
          )
          return next()
        }
        const danger = dangerousCommandMatch(dangerCmd.text) || dangerousCommandMatch(dangerArgs.text)
        if (danger) {
          // v1.12.6（终审 M3）让 UI 说得出「每次都会问、不可记忆」：写侧一字未动（用户点
          // 「总是允许」照样写规则），但读取侧这道门排在最前 ⇒ 这三条命令永远读不到刚写的
          // 规则。不在客户端标明就等于让用户以为已经授权、然后反复被问。
          // 暂存上下文在上面（门前）已写入——写侧依赖它，位置不能挪；这里按同一 callId
          // **覆盖**一份带门名的（peekPendingContext 读到的是这一份）。
          if (req.callId) {
            hostApproval.pushPendingContext(req.callId, { ...ctxInfo, sessionId, rootSessionId, dangerRule: danger.rule })
          }
          logApproval(
            `宿主审批不自动放行（危险命令排除门命中 ${danger.rule}）: ` +
            `tool=${ctxInfo.toolName ?? '?'} session=${sessionId} root=${rootSessionId} ` +
            `segment=${JSON.stringify(danger.segment)}`,
            {
              action: 'danger-command-block', rule: danger.rule, tool: ctxInfo.toolName ?? null,
              sessionId, rootSessionId, segment: danger.segment,
            },
          )
          return next()
        }
        // 保守策略（用户裁决）：执行类调用**命令文本解析不出来**时也不自动放行——
        // 解析不出就无法断言它不是 `rm -rf`，宁可交互。非执行类不受此条影响。
        if (ctxInfo.execLikely && !ctxInfo.commandText.trim()) {
          logApproval(
            `宿主审批不自动放行（执行类调用但命令文本解析不出）: ` +
            `tool=${ctxInfo.toolName ?? '?'} session=${sessionId} root=${rootSessionId} callFound=${ctxInfo.callFound}`,
            {
              action: 'no-command-text-block', tool: ctxInfo.toolName ?? null,
              sessionId, rootSessionId, callFound: ctxInfo.callFound,
            },
          )
          return next()
        }
        const disallowToolGrant = isDisallowedAutoGrant(ctxInfo.toolName, ctxInfo.reason)
        // v1.12.7（用户裁定：**工具档不受越权限制**，语义 `{cwd: 工作区, tools:['bash']}`）：
        // 上面那条判据已拆开——沙箱越权**不再**算「不得用工具档」，只剩 ACP 孪生一种来源，
        // 而孪生在更上面（本文件的 isAcpTwinApproval 早退门）就 return next() 了 ⇒ 这里恒 false。
        // 保留 `!disallowToolGrant` 是防御性冗余：早退门若被挪走，孪生至少不会吃到工具名档。
        // 越权请求因此照常消费工具名档：命中即放行，任意路径（含工作区外）。
        // 危险命令门/超长门/执行类无正文门都在**更上面**，与档位无关 ⇒ rm -rf、git push、
        // npm publish 即使工具档命中仍永远走交互（顺序哨兵：test/dangerous-command-gate.test.js
        // 与 verify.mjs 都按下面这行的**字面量**锚定位置，别改这行的形状）。
        // 优先短路：工具名授权（不依赖 paths，即使解析不出路径也能命中）
        if (!disallowToolGrant && ctxInfo.toolName && hostApproval.toolGrantCovers(rootSessionId, ctxInfo.toolName)) {
          logApproval(
            `宿主审批自动放行（本会话工具授权命中）: ` +
            `tool=${ctxInfo.toolName} scope=session-tool root=${rootSessionId} session=${sessionId}`,
            { action: 'auto-grant', scope: 'session-tool', tool: ctxInfo.toolName, rootSessionId, sessionId },
          )
          return Promise.resolve('allowed-once')
        }
        // 路径规则：解析不出路径的请求不参与路径规则匹配，直接放行到交互层
        if (ctxInfo.paths.length === 0) return next()
        // 两个开关**各管一档，判据同源但不再焊死**（v1.12.7 的关键解耦）：
        //   disallowToolGrant = isDisallowedAutoGrant（拆开后只剩 ACP 孪生 ⇒ 生产路径恒 false）
        //     ⇒ 关「工具名档」与「落盘工具档」；
        //   v1.12.14（用户裁定「显式点项目档不降级」的读侧对称）：`sessionOnly` 参数下线 ——
        //     落盘项目档（路径档与工具档）对沙箱越权请求**同样生效**。不加这条，
        //     用户在弹框里点的「总是允许(项目)」写到盘上却对制造它的那类请求（工作区外写入）
        //     永远不可见，重载宿主后照样弹，正是本次要修的缺口。
        //     硬底线不变：危险命令门/超长门/执行类无正文门都在**更上面**，与档位无关。
        const hit = hostApproval.decide({ sessionId, rootSessionId, cwd: ctxInfo.cwd, paths: ctxInfo.paths, toolName: ctxInfo.toolName, disallowToolGrant })
        if (hit.allowed) {
          // v1.12.4：这里的 scope 可能是 'session'（会话路径规则）、'project'（落盘路径规则）
          // 或 'project-tool'（v1.12.14 落盘工具档）——'session-tool' 档在更上面已短路，
          // 永远到不了这里。
          // 留痕**不带 paths 数组**（用户裁决：单行要精炼）：完整路径既撑爆日志又没有排查价值，
          // 要看具体是哪几个路径，按 sessionId + callId 回宿主会话记录查。
          logApproval(
            `宿主审批自动放行（${hit.scope === 'session' ? '本会话路径规则' : hit.scope === 'project-tool' ? '落盘工具档' : '项目规则'}命中）: ` +
            `tool=${ctxInfo.toolName ?? '?'} scope=${hit.scope} session=${sessionId} ` +
            `root=${rootSessionId} pathCount=${ctxInfo.paths.length}`,
            {
              action: 'auto-grant', scope: hit.scope, tool: ctxInfo.toolName ?? null,
              rootSessionId, sessionId, pathCount: ctxInfo.paths.length,
            },
          )
          return Promise.resolve('allowed-once')
        }
      } catch (err) {
        // 判定内部异常一律委托（fail-open 到交互层，宿主兜底 fail-closed）
        console.error('[dsh-agent-dispatch] 宿主审批规则判定异常（改为交互审批）:', err.message)
      }
      return next()
    }, { prepend: true })
  } catch (err) {
    console.error('[dsh-agent-dispatch] approval/request 订阅失败（宿主审批自动放行不可用）:', err.message)
  }
  const ready = registry.init().catch((error) => {
    console.error('[dsh-agent-dispatch] Agent 注册表初始化失败:', error)
    throw error
  })

  const squadRegistry = new SquadRegistry(dataDir)
  const squadsReady = squadRegistry.init().catch((error) => {
    console.error('[dsh-agent-dispatch] 小队注册表初始化失败:', error)
    throw error
  })
  const squadById = () => new Map(squadRegistry.list().map((s) => [s.id, s]))

  // ── 工具参数 schema（裸 JSON Schema，不经 schemastery/dsh-tools）──
  // v0.9.38：dispatch 返回值含 output（子代理结果文本）/ok——schema 必须同步声明，
  // 否则 additionalProperties:false 把未声明字段判非法（用户现场：agent_dispatch 报
  // 'value.output' is not a declared property）
  // v0.9.39：宿主 dsh-tools 校验不支持 type 数组（type:['string','null'] 直接拒——
  // JsonSchemaError: type must be a single type string）；可空字段用 oneOf 表达
  const OUTPUT_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
      agentId: { type: 'string' },
      agentName: { type: 'string' },
      childId: { type: 'string' },
      taskLabel: { type: 'string' },
      output: { oneOf: [{ type: 'string' }, { type: 'null' }] },
      ok: { type: 'boolean' },
    },
    required: ['agentId', 'agentName', 'childId', 'taskLabel'],
  }

  const toolDisposers = []

  // v1.11.21：工具出参统一过 jsonSafe。宿主对**每个**工具出参做无损 JSON 校验
  // （dsh-tools 的 createSuccessResult → snapshotJsonValue）：任何值为 undefined 的
  // 自有属性都会让整次调用失败（INVALID_TOOL_OUTPUT: value is not lossless JSON），
  // 而不是只丢那个字段。0.1.0-rc.6 与 0.2.0-rc.1 同样严格（不是升级回归），本插件
  // 过去只是恰好每个字段都填满了。收口一次，后续再加可选字段（output / warnings …）
  // 不会再把工具调用弄坏。语义详见 lib/json-safe.js。
  const registerTool = (def) => {
    const wrapped = {
      ...def,
      execute: async (args, exec) => jsonSafe(await def.execute(args, exec)),
    }
    // 收口标记（不可枚举，不会进宿主的定义快照/JSON）：供 verify.mjs 做**行为级**
    // 一致性链断言——"有没有工具绕过收口"，而不是靠源码字符串匹配（那种会被注释绕过）。
    Object.defineProperty(wrapped, JSON_SAFE_MARK, { value: true, enumerable: false })
    return ctx.tools.register(wrapped)
  }

  // agent_dispatch：把任务委派给Agent（建/复用可续聊子 agent）
  toolDisposers.push(registerTool({
    name: 'agent_dispatch',
    description:
      'Dispatch a task to a pre-configured agent agent (a continuable subagent with a fixed agent persona, its own context, and its own model route). Use this when the task falls in an agent\'s domain — requirement analysis, code review, production debugging, SQL analysis. Reuse is automatic and context-aware (v1.5.1): a task that continues the agent\'s previous work (continuation wording like 继续/追加/continue, or shared files/terms) is sent to the same subagent via send_message with full context; an independent new task spawns a fresh subagent. Dispatch returns immediately with a durable child id; the result arrives as a subagent notice when the agent finishes.',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'The agent to dispatch to. Get exact ids from agent_list.',
        },
        task: {
          type: 'string',
          description:
            'The complete, self-contained task for the agent. It does NOT see this conversation, so include all context it needs: file paths, code, logs, URLs, constraints.',
        },
        reuse: {
          type: 'string',
          enum: ['auto', 'reuse', 'fresh'],
          description:
            "Subagent reuse mode (v1.5.1). 'auto' (default): reuse the same-role idle subagent when this task continues the previous one (continuation wording or shared files/terms), spawn a new one for independent tasks. 'reuse': force reuse of the most recent same-role child — use when you know this continues the same thread even if the wording does not show it. 'fresh': force a brand-new child — use for a clearly independent new task. The agent's reusePolicy ('reuse'/'fresh') is the fallback for 'auto'. Ignored when childId is given.",
        },
        childId: {
          type: 'string',
          description:
            "Targeted continuation (v1.5.3): a durable subagent session id to continue explicitly — highest priority, overrides reuse. Use when the subagent to reuse is NOT the most recent one (a separated older thread). send_message continues it directly; cold resume is automatic, so it works whether the subagent's process/activation is live, idle, or already recycled (session-based continuity, not process-based). The subagent must be a direct child of this session (host enforces adjacency). Ids come from previous agent_dispatch results, agent_children, or the host list_agents tool. Fails loudly instead of silently falling back.",
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Kept for interface stability; dispatch is always async (startContinuable returns a durable child id immediately).',
        },
      },
      required: ['agentId', 'task'],
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text: `已委派 ${value.agentName}（${value.agentId}）· 子代理 ${value.childId}\n任务: ${value.taskLabel}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await ready
      const parent = exec.agent
      if (!parent) throw new Error('agent_dispatch 需要调用方 agent（exec.agent 为空）')
      return dispatcher.dispatch(parent, args.agentId, args.task, { reuse: args.reuse, childId: args.childId })
    },
  }))

  // agent_children：列出本会话的子代理线程（v1.5.3）——childId + 最近任务 + 状态，
  // 供主模型挑选"隔开的旧线程"做定向续聊（agent_dispatch(childId=...)）。
  toolDisposers.push(registerTool({
    name: 'agent_children',
    description:
      'List the subagent threads of the current session: each entry has childId (usable as agent_dispatch childId for targeted continuation), agentId, the recent task labels, and status (running = working now, idle = resident and free, ready = session persisted, cold-resume on reuse). Call this when you need to continue a specific older thread whose subagent is not the most recent one, or when you lost track of the child ids.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        agentId: {
          type: 'string',
          description: 'Optional filter: only show threads of this agent.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          children: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                childId: { type: 'string' },
                agentId: { type: 'string' },
                taskLabels: { type: 'array', items: { type: 'string' } },
                status: { type: 'string' },
              },
              required: ['childId', 'agentId', 'taskLabels', 'status'],
            },
          },
        },
        required: ['children'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.children.length
            ? value.children
                .map((c) => `  ${c.childId} · ${c.agentId} [${c.status}] · ${(c.taskLabels || []).join(' → ')}`)
                .join('\n')
            : '当前会话没有可续聊的子代理线程',
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await ready
      const parent = exec.agent
      if (!parent) throw new Error('agent_children 需要调用方 agent（exec.agent 为空）')
      return dispatcher.listChildren(parent, { agentId: args.agentId })
    },
  }))

  // agent_followup：对已存在的Agent追问（上下文延续）
  toolDisposers.push(registerTool({
    name: 'agent_followup',
    description:
      'Send a follow-up message to a live agent child subagent started earlier via agent_dispatch. The agent keeps its full conversation context, so state only what is new. Use this to ask the same agent another question or give it more information.',
    parameters: {
      type: 'object',
      properties: {
        childId: {
          type: 'string',
          description: 'The durable child id returned by agent_dispatch.',
        },
        message: {
          type: 'string',
          description: 'The follow-up message. The agent already knows its earlier task; state only what is new.',
        },
      },
      required: ['childId', 'message'],
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { childId: { type: 'string' } }, required: ['childId'] },
      render: (_args, value) => [{ type: 'text', text: `追问已送达 Agent 子代理 ${value.childId}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await ready
      const parent = exec.agent
      if (!parent) throw new Error('agent_followup 需要调用方 agent（exec.agent 为空）')
      return dispatcher.followup(parent, args.childId, args.message)
    },
  }))

  // agent_failover：把一个【正在等待换档决定】的失败档换到下一档（v1.11.24）
  //
  // 只接受 childId：原任务原文、agentId、失败档 provider、下一档 route、已试档列表、
  // 错误轨迹全部由编排层从 activeChildren / handoffs 自查。模型传不了也传不错——
  // 现有 agent_dispatch 没有 provider/model 参数，主代理根本无法表达"换到哪一档"。
  //
  // 一次调用完成三件事，**不需要**再单独调 interrupt_agent：
  //   1) 中止并释放旧档（宿主调度器即使 abort 也会等 in-flight 工具 settle，
  //      interrupt_agent 解不开被阻塞的 product_submit —— 真正的释放是插件显式兑现它）；
  //   2) 以【主代理为父】派一个同级（depth-1）替补档，可与它双向 send_message；
  //   3) 把旧档的等待放行，使旧档随后以 "was stopped before it finished." 结束。
  // 幂等：重复调用（含与超时自动路径撞车）返回同一 childId，绝不产生第二个替补。
  toolDisposers.push(registerTool({
    name: 'agent_failover',
    description:
      'Fail over one blocked subagent to the next model route in its agent\'s chain. Call this when a failover notice tells you a subagent\'s current route failed and a replacement is worthwhile — the replacement runs as YOUR direct child, so you can send_message it and interrupt_agent it like any other subagent. This call aborts and releases the failed child, dispatches the replacement, and unblocks the failed child so it stops; you do NOT need to call interrupt_agent yourself. Pass only childId — the task text, the agent, the failed route and the next route are all resolved by the orchestrator. Idempotent: calling it twice returns the same replacement child id.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        childId: {
          type: 'string',
          description:
            'The durable child id from the failover notice (the "🔁 换档待决" message). Only a subagent that is currently blocked waiting for a failover decision can be handed off.',
        },
      },
      required: ['childId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          childId: { type: 'string', description: 'The new replacement subagent id (a direct child of this session).' },
          agentId: { type: 'string' },
          fromProvider: { type: 'string' },
          toProvider: { type: 'string' },
          interrupted: { type: 'string' },
          failoverCount: { type: 'number' },
          trigger: { type: 'string' },
        },
        required: ['childId', 'agentId', 'fromProvider', 'toProvider', 'interrupted', 'failoverCount', 'trigger'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已换档：${value.fromProvider} 失败 → ${value.toProvider}（第 ${value.failoverCount} 次，来源 ${value.trigger}）。\n`
            + `替补子代理 ${value.childId}（Agent ${value.agentId}）已作为你的直接子级派出，可直接 send_message 与它对话。\n`
            + `旧档已中止并释放（${value.interrupted}），稍后会收到一条它被停止的通知。`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await ready
      const parent = exec.agent
      if (!parent) throw new Error('agent_failover 需要调用方 agent（exec.agent 为空）')
      return dispatcher.handoff(args.childId, { parentAgent: parent })
    },
  }))

  // agent_close：显式关闭子代理线程（v1.5.2）——确认某条线程不再继续时调用：
  // 立即停止复用（移除复用池条目）+ 释放驻留资源；ACP 后台进程由
  // product-subagents 的 idleTimeoutMs 定时器收尾（无需手动处理）。
  toolDisposers.push(registerTool({
    name: 'agent_close',
    description:
      'Close one or more subagent threads so they are never reused again and their resident resources are recycled promptly. Call this when you are sure a thread is done (work accepted, exploration concluded, feature verified) and no further follow-up will target it. Pass childId (a durable child id returned by agent_dispatch) to close one subagent, or agentId to close all idle subagents of that agent in this session. Running subagents are not interrupted — they lose reuse eligibility and are recycled when their current task settles. ACP-backed subagents (deveco etc.) keep their background process until the product-subagents idle timeout (idleTimeoutMs, default 10 min) recycles it; this call releases the in-process relay immediately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        childId: {
          type: 'string',
          description: 'The durable child id to close (must belong to this session, from the reuse pool or active children).',
        },
        agentId: {
          type: 'string',
          description: 'Close all idle subagents of this agent in the current session (pool entries). Mutually exclusive with childId.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          closed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                childId: { type: 'string' },
                agentId: { type: 'string' },
                closing: { type: 'string' },
              },
              required: ['childId', 'agentId', 'closing'],
            },
          },
        },
        required: ['closed'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `已关闭 ${value.closed.length} 个子代理线程：\n` +
            value.closed
              .map((c) => `  ${c.childId}（${c.agentId}）· ${c.closing === 'running' ? '任务运行中：停止复用，结束即回收' : '已释放驻留资源'}`)
              .join('\n'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await ready
      const parent = exec.agent
      if (!parent) throw new Error('agent_close 需要调用方 agent（exec.agent 为空）')
      return dispatcher.closeChild(parent, { childId: args.childId, agentId: args.agentId })
    },
  }))

  // agent_list：列出Agent目录（供主 agent 路由判断）
  toolDisposers.push(registerTool({
    name: 'agent_list',
    description:
      'List the configured agent agents with their ids, names, trigger domains, model routes, and reuse policy. Call this before agent_dispatch when unsure which agent fits, or when the user asks what agents exist.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                emoji: { type: 'string' },
                triggers: { type: 'string' },
                enabled: { type: 'boolean' },
                reusePolicy: { type: 'string' },
                routes: { type: 'array', items: { type: 'string' } },
              },
              required: ['id', 'name', 'emoji', 'triggers', 'enabled'],
            },
          },
        },
        required: ['agents'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.agents
            .map((e) => `${e.emoji ?? ''}${e.name}（${e.id}）· 适用: ${e.triggers}${e.enabled ? '' : ' · 已停用'}${e.reusePolicy === 'fresh' ? ' · 每次新开' : ' · 复用同角色'}${e.routes?.length ? ' · 模型: ' + e.routes.join(' → ') : ''}`)
            .join('\n'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute() {
      await ready
      return {
        agents: registry.list().map((e) => ({
          id: e.id,
          name: e.name,
          emoji: e.emoji,
          triggers: e.triggers,
          enabled: e.enabled !== false,
          reusePolicy: e.reusePolicy === 'fresh' ? 'fresh' : 'reuse',
          // v1.11.12：补 effort（旧实现压成 provider/model 丢了档位）；
          // model 为空（ACP 用产品默认模型）时不拼出 "provider/undefined"
          routes: (e.routes || []).map((r) => [r.provider, r.model].filter(Boolean).join('/') + (r.effort ? '@' + r.effort : '')),
        })),
      }
    },
  }))

  // ── v1.3.0：小队结果级停等（checkpoint）──
  // 中间态：agent_squad 首段执行到第一个 checkpoint 步就 return paused=true，
  // agent_squad_continue 凭 squadRunId 读回续跑。进程内内存态，重启失效
  // （断点恢复靠各 Agent 写 .kiligz-state.json 兜底，跨重启可续）。
  const squadSessions = new Map()

  // 共享执行核心：从 fromStepIdx 起按拓扑分层继续执行。每跑完一层，
  // 若该层存在 checkpoint=true 且成功完成的步骤 → 暂停返回 paused=true；
  // 否则进入下一层，直到全部跑完返回 paused=false。
  const runSquadSteps = async (parent, squad, goal, state, fromStepIdx) => {
    const layers = topoLayers(squad.steps)
    const results = []
    const stepResults = state.stepResults
    const squadRunId = state.squadRunId
    const stepStatus = state.stepStatus
    let paused = false
    let nextStepIdx = fromStepIdx

    for (const layer of layers) {
      // 分段续跑：本层全部步骤都已完成（< fromStepIdx）则跳过
      if (layer.every((idx) => idx < fromStepIdx)) continue
      for (const idx of layer) stepStatus[idx] = 'running'
      await Promise.all(
        layer.map(async (idx) => {
          const step = squad.steps[idx]
          const agent = registry.get(step.agentId)
          if (!agent || agent.enabled === false) {
            stepStatus[idx] = 'skipped'
            results.push({
              step: idx,
              phase: step.phase,
              agentId: step.agentId,
              agentName: agent?.name ?? step.agentId,
              childId: '',
              dependsOn: step.dependsOn ?? [],
              skipped: true,
            })
            return
          }
          const task = renderInstruction(step.instruction, goal, stepResults) +
            '\n\n【执行终点声明】本任务是 squad 编排中的一个执行步骤，你（Agent 子代理）在本轮内独立完成并输出结构化结论即可。严禁再调用 agent_dispatch / agent_squad / agent_followup 等任何委派或组队工具，严禁把本任务继续往下派发。直接完成本步任务并回报。'
          try {
            // waitResult=true——dispatch 等到本步子代理真正结束并取回结果文本，
            // stepResults 填真实结论（{prev:N} 用），依赖链是结果级串行
            // dedicatedChild=true——小队步骤强制新建专属子代理，不复用同Agent旧 child。
            const r = await dispatcher.dispatch(parent, step.agentId, task, { viaSquad: squad.id, squadRunId, stepIndex: idx, totalSteps: squad.steps.length, waitResult: true, dedicatedChild: true })
            stepStatus[idx] = 'done'
            const out = String(r.output || '').trim()
            stepResults[idx] = out
              ? `（步骤 ${idx + 1} 结论）\n${out}`
              : `（步骤 ${idx + 1} 完成，子代理无文本输出）`
            results.push({
              step: idx,
              phase: step.phase,
              agentId: step.agentId,
              agentName: r.agentName,
              childId: r.childId,
              dependsOn: step.dependsOn ?? [],
              skipped: false,
            })
          } catch (err) {
            // 单步失败不炸整个小队：标记跳过，依赖者收到无结果占位
            stepStatus[idx] = 'failed'
            stepResults[idx] = `（本步委派失败: ${err.message}）`
            results.push({
              step: idx,
              phase: step.phase,
              agentId: step.agentId,
              agentName: agent.name,
              childId: '',
              dependsOn: step.dependsOn ?? [],
              skipped: true,
            })
          }
        }),
      )
      nextStepIdx = Math.max(...layer) + 1
      // checkpoint 停等：本层有 checkpoint=true 且成功完成的步骤 → 停下等用户确认
      const hitCheckpoint = layer.some((idx) => squad.steps[idx].checkpoint === true && stepStatus[idx] === 'done')
      if (hitCheckpoint) { paused = true; break }
    }
    return { paused, squadRunId, results, stepResults, stepStatus, nextStepIdx }
  }

  // agent_squad：按预置小队模板把目标拆给多Agent（v0.3）
  toolDisposers.push(registerTool({
    name: 'agent_squad',
    description:
      'Dispatch one goal to a preset agent squad (a template of multiple agent dispatches with dependencies — e.g. dev-pipeline runs requirement analysis then code review; debug-squad fans out log tracing, SQL analysis, and code review in parallel). Each step dispatches to its agent as a continuable subagent; steps with dependencies wait for earlier steps to finish, and their results feed the dependents. A step marked checkpoint:true pauses execution after it completes, returning paused:true with a squadRunId — call agent_squad_continue with that id (optionally with a note of user feedback) to resume. Use for multi-angle or pipeline goals; prefer agent_dispatch for single-domain tasks.',
    parameters: {
      type: 'object',
      properties: {
        squad_id: {
          type: 'string',
          description: 'Squad template id. Built-ins: dev-pipeline (需求→审查串行), debug-squad (日志/数据/代码三路并行), review-squad (业务/数据双路审查); custom squads from the Settings page carry their own ids.',
        },
        goal: {
          type: 'string',
          description: 'The complete, self-contained goal. It is routed to every step template, so include all context the agents need.',
        },
      },
      required: ['squad_id', 'goal'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          squadId: { type: 'string' },
          squadName: { type: 'string' },
          squadRunId: { type: 'string' },
          paused: { type: 'boolean' },
          nextStepIdx: { type: 'number' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: { type: 'number' },
                phase: { type: 'string' },
                agentId: { type: 'string' },
                agentName: { type: 'string' },
                childId: { type: 'string' },
                dependsOn: { type: 'array', items: { type: 'number' } },
                skipped: { type: 'boolean' },
              },
              required: ['step', 'phase', 'agentId', 'agentName', 'childId', 'dependsOn', 'skipped'],
            },
          },
        },
        required: ['squadId', 'squadName', 'squadRunId', 'paused', 'nextStepIdx', 'steps'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `小队 ${value.squadName} ${value.paused ? '已暂停待确认' : '已执行完成'}（本段 ${value.steps.length} 步）：\n` +
            value.steps
              .map(
                (s) =>
                  `  ${s.skipped ? '⏭️' : '✅'} 步骤${s.step + 1} [${s.phase}] ${s.agentName}${s.childId ? ` · 子代理 ${s.childId}` : ' · 已停用跳过'}${s.dependsOn.length ? `（等步骤 ${s.dependsOn.map((d) => d + 1).join(',')}）` : ''}`,
              )
              .join('\n') +
            (value.paused
              ? `\n已到 checkpoint 停等点。用户确认后，调用 agent_squad_continue（squadRunId=${value.squadRunId}）继续。`
              : '\n各步结果将以子代理通知回到本会话。'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await Promise.all([ready, squadsReady])
      const parent = exec.agent
      if (!parent) throw new Error('agent_squad 需要调用方 agent（exec.agent 为空）')
      const squadId = args.squad_id
      const squad = squadId ? squadById().get(squadId) : undefined
      if (!squad) throw new Error(`小队不存在: ${JSON.stringify(args)}。可用: ${squadRegistry.list().map((s) => s.id).join(', ')}`)
      // 停用的小队拒绝执行
      if (squad.enabled === false) throw new Error(`小队「${squad.name}」已停用，可在 Agent 调度面板的小队页重新启用`)

      // 小队运行日志——拓扑快照（历史页执行流图数据源）
      const squadRunId = 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
      dispatcher.logSquadRun({
        kind: 'squad-run',
        phase: 'start',
        squadRunId,
        squadId: squad.id,
        squadName: squad.name,
        squadEmoji: squad.emoji ?? '',
        goal: String(args.goal ?? '').slice(0, 300),
        steps: squad.steps.map((st, i) => ({ idx: i, phase: st.phase || st.agentId, agentId: st.agentId, dependsOn: st.dependsOn ?? [] })),
        parentSessionId: parent?.session?.id ?? null,
      })
      const state = {
        squadRunId,
        stepResults: new Array(squad.steps.length).fill(null),
        stepStatus: new Array(squad.steps.length).fill('waiting'),
        nextStepIdx: 0,
      }
      const { paused, results, stepResults, stepStatus, nextStepIdx } = await runSquadSteps(parent, squad, args.goal, state, 0)
      results.sort((a, b) => a.step - b.step)
      dispatcher.logSquadRun({
        kind: 'squad-run',
        phase: 'end',
        squadRunId,
        squadId: squad.id,
        stepStatus,
        paused,
        ok: true,
        ended: true,
      })
      if (paused) {
        squadSessions.set(squadRunId, { squad, goal: args.goal, stepResults, stepStatus, nextStepIdx })
        return { squadId: squad.id, squadName: squad.name, squadRunId, paused: true, nextStepIdx, steps: results }
      }
      squadSessions.delete(squadRunId)
      return { squadId: squad.id, squadName: squad.name, squadRunId, paused: false, nextStepIdx, steps: results }
    },
  }))

  // agent_squad_continue：从 checkpoint 停等点续跑小队（v1.3.0）
  toolDisposers.push(registerTool({
    name: 'agent_squad_continue',
    description:
      'Resume a paused agent_squad run from its checkpoint. Required: the squadRunId returned by the previous agent_squad / agent_squad_continue call that reported paused:true. Optional note: user feedback on the just-completed stage, appended to the goal so every remaining step sees it. Runs until the next checkpoint step or until all steps complete; returns paused:true again (with the same squadRunId) if it hit another checkpoint, otherwise paused:false.',
    parameters: {
      type: 'object',
      properties: {
        squadRunId: {
          type: 'string',
          description: 'The squadRunId returned by the paused agent_squad / agent_squad_continue call.',
        },
        note: {
          type: 'string',
          description: 'Optional user feedback / correction on the previous stage, passed to all remaining steps.',
        },
      },
      required: ['squadRunId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          squadId: { type: 'string' },
          squadName: { type: 'string' },
          squadRunId: { type: 'string' },
          paused: { type: 'boolean' },
          nextStepIdx: { type: 'number' },
          steps: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                step: { type: 'number' },
                phase: { type: 'string' },
                agentId: { type: 'string' },
                agentName: { type: 'string' },
                childId: { type: 'string' },
                dependsOn: { type: 'array', items: { type: 'number' } },
                skipped: { type: 'boolean' },
              },
              required: ['step', 'phase', 'agentId', 'agentName', 'childId', 'dependsOn', 'skipped'],
            },
          },
        },
        required: ['squadId', 'squadName', 'squadRunId', 'paused', 'nextStepIdx', 'steps'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `小队 ${value.squadName} 续跑${value.paused ? '后再次暂停待确认' : '完成'}（本段 ${value.steps.length} 步）：\n` +
            value.steps
              .map(
                (s) =>
                  `  ${s.skipped ? '⏭️' : '✅'} 步骤${s.step + 1} [${s.phase}] ${s.agentName}${s.childId ? ` · 子代理 ${s.childId}` : ' · 已停用跳过'}${s.dependsOn.length ? `（等步骤 ${s.dependsOn.map((d) => d + 1).join(',')}）` : ''}`,
              )
              .join('\n') +
            (value.paused
              ? `\n又到 checkpoint 停等点。用户确认后继续调用 agent_squad_continue（squadRunId=${value.squadRunId}）。`
              : '\n小队全部步骤执行完成。'),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await Promise.all([ready, squadsReady])
      const parent = exec.agent
      if (!parent) throw new Error('agent_squad_continue 需要调用方 agent（exec.agent 为空）')
      const session = squadSessions.get(args.squadRunId)
      if (!session) throw new Error(`小队运行 ${args.squadRunId} 不存在或已结束（进程重启后中间态失效，可用 .kiligz-state.json 断点恢复重新走流程）`)
      const squad = session.squad
      // 用户反馈（note）拼进 goal，让所有后续步骤可见
      const goal = args.note
        ? `${session.goal}\n\n【用户对上一阶段反馈】\n${args.note}`
        : session.goal
      const state = {
        squadRunId: args.squadRunId,
        stepResults: session.stepResults,
        stepStatus: session.stepStatus || new Array(squad.steps.length).fill('waiting'),
        nextStepIdx: session.nextStepIdx,
      }
      const { paused, results, stepResults, stepStatus, nextStepIdx } = await runSquadSteps(parent, squad, goal, state, session.nextStepIdx)
      results.sort((a, b) => a.step - b.step)
      dispatcher.logSquadRun({
        kind: 'squad-run',
        phase: 'end',
        squadRunId: args.squadRunId,
        squadId: squad.id,
        stepStatus,
        paused,
        ok: true,
        ended: true,
      })
      if (paused) {
        squadSessions.set(args.squadRunId, { squad, goal, stepResults, stepStatus, nextStepIdx })
        return { squadId: squad.id, squadName: squad.name, squadRunId: args.squadRunId, paused: true, nextStepIdx, steps: results }
      }
      squadSessions.delete(args.squadRunId)
      return { squadId: squad.id, squadName: squad.name, squadRunId: args.squadRunId, paused: false, nextStepIdx, steps: results }
    },
  }))

  // agent_import_skill：把 ~/.dsh/skills 下的 skill 一键注册为Agent（v0.4）
  toolDisposers.push(registerTool({
    name: 'agent_import_skill',
    description:
      'Import a DSH skill (~/.dsh/skills/<name>/SKILL.md) as an agent agent: its body becomes the agent system prompt, its description becomes the trigger domain. Call with no skillDir to list importable skills first. Imported agents overwrite an existing agent with the same id.',
    parameters: {
      type: 'object',
      properties: {
        skillDir: {
          type: 'string',
          description: 'Skill directory name under ~/.dsh/skills (omit to list importable skills).',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string' },
          skills: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: { dir: { type: 'string' }, description: { type: 'string' } },
              required: ['dir', 'description'],
            },
          },
          agent: {
            type: 'object',
            additionalProperties: false,
            properties: { id: { type: 'string' }, name: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } } },
            required: ['id', 'name', 'warnings'],
          },
        },
        required: ['action'],
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            value.action === 'list'
              ? '可导入的 skills（用 skillDir 参数导入）：\n' +
                (value.skills || []).map((s) => `  ${s.dir} — ${s.description}`).join('\n')
              : `已导入 skill 为 Agent: ${value.agent.name}（${value.agent.id}）${value.agent.warnings.length ? '\n警告: ' + value.agent.warnings.join('; ') : ''}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ready
      const skillsRoot = defaultSkillsRoot()
      if (!args.skillDir) {
        return { action: 'list', skills: listSkills(skillsRoot).map((s) => ({ dir: s.name, description: s.description })) }
      }
      const { agent, warnings } = skillToAgent(skillsRoot, args.skillDir)
      await registry.upsert(agent, { isSubagentProvider: isSubagentProviderRoute })
      return { action: 'import', agent: { id: agent.id, name: agent.name, warnings } }
    },
  }))

  // agent_upsert：新增/更新单个 Agent（与 GUI 编辑保存同一条 registry.upsert 逻辑，立即生效免重启）。
  // v1.2.0：暴露给主 agent，改 Agent（含 systemPrompt）无需重启 Desktop、无需点 GUI。
  // v1.5.0：支持 reusePolicy（'reuse' 复用同角色子代理 / 'fresh' 每次新开）。
  toolDisposers.push(registerTool({
    name: 'agent_upsert',
    description:
      'Create or update a single agent agent in the dsh-agent-dispatch registry. This is the same write path as the GUI edit-and-save (registry.upsert: in-memory + atomic disk write), so changes take effect immediately without restarting DSH. Use this to fix or adjust an agent\'s persona/systemPrompt, triggers, name, model routes, or reuse policy. The agent keeps its position if it already exists, otherwise it is appended.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Agent id (kebab-case, lowercase letters/digits, hyphen-separated segments).' },
        name: { type: 'string', description: 'Display name (non-empty).' },
        systemPrompt: { type: 'string', description: 'The full agent persona / system prompt (non-empty).' },
        emoji: { type: 'string', description: 'Optional single emoji shown in lists.' },
        triggers: { type: 'string', description: 'Optional trigger-domain description used by agent_list routing.' },
        reusePolicy: {
          type: 'string',
          description: "Optional reuse policy: 'reuse' (default) keeps ONE continuable child per parent session for this agent and steers follow-up tasks to it via send_message — context carries over; 'fresh' spawns a new child for every dispatch — use for exploration-style roles whose tasks are independent (each exploration starts clean).",
        },
        routes: {
          type: 'array',
          description: 'Optional model routes; each item {provider, model?, effort?}. LLM providers (dsh-llm adapters) require a non-empty model; ACP/subagent providers (qoder, deveco, opencode, ...) may omit model or use "default" to mean "use the product\'s own default model".',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              // ACP 路由允许空串/缺省 = 用产品默认模型（校验见 lib/agents.js validateRoutes）
              model: { type: 'string' },
              effort: { type: 'string' },
            },
            required: ['provider'],
          },
        },
        enabled: { type: 'boolean', description: 'Optional enabled flag (default true).' },
      },
      required: ['id', 'name', 'systemPrompt'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          name: { type: 'string' },
        },
        required: ['ok', 'id', 'name'],
      },
      render: (_args, value) => [
        { type: 'text', text: `已保存 Agent: ${value.name}（${value.id}）` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await ready
      const agent = {
        id: args.id,
        name: args.name,
        systemPrompt: args.systemPrompt,
        emoji: args.emoji,
        triggers: args.triggers,
        reusePolicy: args.reusePolicy === 'fresh' ? 'fresh' : 'reuse',
        routes: args.routes || [],
        enabled: args.enabled !== false,
      }
      const normalized = await registry.upsert(agent, { isSubagentProvider: isSubagentProviderRoute })
      return { ok: true, id: normalized.id, name: normalized.name }
    },
  }))

  // agent_squad_upsert：新增/更新单个小队（与 GUI 小队编辑保存同一条 squadRegistry.upsert 逻辑，立即生效免重启）。
  // v1.3.0：暴露给主 agent 免重启改小队（含 checkpoint 字段）；GUI 表单同步加 checkpoint 开关后两条路径等价。
  toolDisposers.push(registerTool({
    name: 'agent_squad_upsert',
    description:
      'Create or update a single agent squad in the dsh-agent-dispatch squad registry. This is the same write path as the GUI squad edit-and-save (squadRegistry.upsert: in-memory + atomic disk write), so changes take effect immediately without restarting DSH. Use this to fix or adjust a squad\'s steps — including the checkpoint flag on each step (checkpoint:true = pause after that step completes, wait for user confirmation, resume via agent_squad_continue).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Squad id (kebab-case, lowercase letters/digits, hyphen-separated segments).' },
        name: { type: 'string', description: 'Display name (non-empty).' },
        description: { type: 'string', description: 'Optional one-line description.' },
        emoji: { type: 'string', description: 'Optional single emoji shown in lists.' },
        steps: {
          type: 'array',
          description: 'Squad steps. Each step: {agentId, phase, dependsOn:[stepIdx], instruction, checkpoint?}. checkpoint:true pauses after the step completes (agent_squad returns paused:true).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              agentId: { type: 'string' },
              phase: { type: 'string' },
              dependsOn: { type: 'array', items: { type: 'number' } },
              instruction: { type: 'string' },
              checkpoint: { type: 'boolean' },
            },
            required: ['agentId', 'phase', 'dependsOn', 'instruction'],
          },
        },
        enabled: { type: 'boolean', description: 'Optional enabled flag (default true).' },
      },
      required: ['id', 'name', 'steps'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          id: { type: 'string' },
          name: { type: 'string' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
        required: ['ok', 'id', 'name'],
      },
      render: (_args, value) => [
        { type: 'text', text: `已保存小队: ${value.name}（${value.id}，${value.steps?.length ?? 0} 步）` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      await squadsReady
      const squad = {
        id: args.id,
        name: args.name,
        description: args.description,
        emoji: args.emoji,
        steps: (args.steps || []).map((st) => ({
          agentId: st.agentId,
          phase: st.phase,
          dependsOn: [...(st.dependsOn || [])],
          instruction: st.instruction,
          checkpoint: st.checkpoint === true,
        })),
        enabled: args.enabled !== false,
      }
      const normalized = await squadRegistry.upsert(squad)
      return { ok: true, id: normalized.id, name: normalized.name, steps: normalized.steps }
    },
  }))

  // ── 路由表 prompt section ──
  // 固定策略文案；Agent实时目录靠 agent_list 工具获取（免重启：agents.json 改完下一轮即生效）。
  const disposeRoutesSection = ctx.systemPrompt.section({
    name: 'dsh-agent-dispatch:policy',
    order: 116.5,
    text: [
      'Agent 委派策略（dsh-agent-dispatch）：',
      '［适用范围］本策略仅对具备委派工具的编排层（主代理 / 父级）生效。若你作为子代理收到本段，请直接忽略其中的委派建议：必须由你自己独立完成被指派的任务，禁止再向下委派或另起任何子代理（含 agent_dispatch / agent_squad / subagent / subagent_fork / workflow / product_delegate 等）；超出能力时明确说明卡在哪、需要什么，并向上（父级）汇报，绝不自行委派或硬闯。',
      '1. 任务命中某 Agent 领域（需求分析/代码审查/线上排查/SQL 分析等）时，优先用 agent_dispatch 委派，而不是自己在主对话里做。**实时花名册见下面的 dsh-agent-dispatch:roster 段**（由 agents.json 渲染，是本 prompt 内唯一权威的角色清单）；不确定时再调 agent_list 复核。',
      '2. 委派任务必须是自包含的：Agent 看不到本会话，把所需上下文（路径/代码/日志/约束）全部写进 task。',
      '3. 对同一 Agent 的后续任务，agent_dispatch 会智能决定复用还是新开（v1.5.1）：新任务延续上一任务（含"继续/接着/追加/在此基础上"等续写词，或涉及相同文件/术语）→ 自动复用对应子代理（send_message 续聊，上下文延续）；独立新任务 → 自动新开子代理，避免旧上下文污染。你明确知道是续聊时可用 reuse:"reuse" 强制复用、是独立新任务时用 reuse:"fresh" 强制新开（默认 auto 智能判断）；**要复用的不是最近一个子代理而是隔开的旧线程时，先用 agent_children 查到该线程的 childId，再 agent_dispatch(childId=...) 定向续聊**（续聊按持久会话进行，子代理进程是否新启动无关；跨会话不可续，宿主强制相邻关系）。reusePolicy=fresh 的探索型 Agent 在 auto 下永远新开。复用池中的子代理空闲 10 分钟后自动回收驻留资源（持久会话保留，下次复用冷恢复，上下文不丢）。',
      '4. 简单问题（一句话能答、无需工具链）不必委派，直接回答——委派本身有开销。',
      '5. 不确定哪个 Agent 合适时先 agent_list。',
      '6. 多角度或流水线目标（既要分析又要审查、多路排查同一问题）用 agent_squad：dev-pipeline=需求→审查串行；debug-squad=日志/数据/代码三路并行；review-squad=业务/数据双路。单领域任务不要用组队。带 checkpoint 的小队（如 kiligz-workflow）会在 checkpoint 步骤后返回 paused:true，必须停下等用户确认，用户反馈经 agent_squad_continue（squadRunId + note）续跑，禁止未确认就自动续跑。停等时：①若阶段有产出文档（prd.md/飞书技术方案链接等），把完整路径/链接展示给用户；②若阶段有「待确认问题清单」，逐条列出请用户作答，用户回答前不得续跑。',
      '7. 复杂动态编排（组队模板不匹配、需要按中间结果决定下一步）时，用宿主 workflow 工具编排 agent_dispatch。',
      '8. 用户消息以「$<id> 」前缀开头时（如 "$sql-analyst 查下 orders 慢查询"），这是用户显式指定：把后续文本作为 task 直接 agent_dispatch 给该 id 的 Agent（组队 id 用 agent_squad），不要追问、不要改派。$ 前缀来自输入框 / 菜单选 Agent 的插入（或用户手打），是用户的明确意图。',
      '9. 修改 Agent（含 reusePolicy 复用策略）用 agent_upsert、修改小队（含各步骤 checkpoint 停等开关）用 agent_squad_upsert，均免重启立即生效。',
      '10. 某 Agent 的任务线程确认不再继续时（如探索结论已收、功能已验收、用户表示不用了），调用 agent_close（childId 或 agentId）关闭该线程：立即停止复用并释放驻留资源，避免资源挂账。ACP 子代理（deveco 等）的后台进程由 product-subagents 的空闲回收（idleTimeoutMs，默认 10 分钟）自动收尾，无需也不应手动杀进程。',
      '11. 收到「🔁 换档待决」通知时（某档失败、已换下一档更划算），调 agent_failover(childId=…)：它会终止并释放旧档、并派发下一档作为你的【直接子级】（可双向 send_message）。**不需要**另外调 interrupt_agent。是否换档由你决定；不调用则按配置超时处理（默认 90s 后自动换到下一档）。',
    ].join('\n'),
  })

  // ── 实时花名册 prompt section ──
  // policy 段是固定策略文案；本段从注册表**实时**渲染 Agent 目录，二者互补。
  // 历史事故驱动：父级 persona 里写死了四个角色枚举，registry 新增 final-reviewer 后
  // prompt 没跟着变，导致「独立终审」被派给实现类角色（senior-dev）自审。
  // 因此花名册必须由 agents.json 渲染，且每次 upsert/remove/setEnabled 后重建。
  // text 传**函数**而非字符串：宿主在每次 assemble 组装时求值
  // （dsh-system-prompt 的 assemble(): `text: typeof section.text === 'function' ? section.text(context) : section.text`），
  // 而 assemble 每个模型 step 都跑一次。因此**注册一次即可**：registry 一变，下一次组装自动反映。
  // 这样既不需要「dispose 同名 section 再重注册」（NamedEntries.insert 对同名会抛
  // `prompt section "…" is already registered`，依赖 dispose 同步生效是额外风险），
  // 也天然覆盖了异步的 registry.init()——渲染发生在组装时刻，必然晚于 init 完成，
  // 因此不需要 registry 变更回调，插件对写盘路径零改动。
  const disposeRosterSection = ctx.systemPrompt.section({
    name: 'dsh-agent-dispatch:roster',
    order: 116.6,
    text: () => renderRoster(registry.list()),
  })

  // ── /agent-api REST 面（v0.2 Settings UI 数据通道）──
  // 与 capability-manager 的 /capabilities-api 同模式：webServer 可能晚于本
  // 插件激活，延迟重试注册；webServer/httpServer 双键探测兼容。
  const send = (res, code, data) => {
    const body = JSON.stringify(data)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' })
    res.end(body)
  }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let buf = ''
      req.on('data', (c) => {
        buf += c
        if (buf.length > 2e6) {
          req.destroy()
          reject(new Error('请求体过大'))
        }
      })
      req.on('end', () => {
        try {
          resolve(buf ? JSON.parse(buf) : {})
        } catch {
          reject(new Error('请求体不是合法 JSON'))
        }
      })
      req.on('error', reject)
    })

  // 展示用路径缩写：绝对路径 HOME 前缀替换为 ~（通用插件不假设具体用户名）
  const tildify = (p) => (os.homedir() && p?.startsWith(os.homedir() + '/') ? '~' + p.slice(os.homedir().length) : p)

  // 模型下拉数据源（通用做法，不碰宿主内部包）：
  //   1) ctx.llm.listProviders() 枚举已注册 provider 路由
  //   2) ctx.llm.listModels(provider) 取 advisory 模型目录（内置表 + API 发现）
  //   3) settings 层补充：providers[name].models[] 显式配置（user 层）并入
  // llm 服务不可用（老宿主）时返回空对象，前端下拉退化为手动输入。
  const readModelOptions = async () => {
    const providers = {}
    try {
      const llm = ctx.get('llm')
      if (llm && typeof llm.listProviders === 'function') {
        const list = await llm.listProviders()
        for (const p of list) {
          if (!p || typeof p.id !== 'string') continue
          try {
            const models = await llm.listModels(p.id)
            providers[p.id] = (models || []).map((m) => m.id).filter(Boolean)
          } catch {
            providers[p.id] = [] // 单 provider 发现失败不拖垮整表
          }
        }
      }
    } catch { /* llm 服务缺失：返回已收集部分 */ }
    // settings user 层显式 models 合并（内置发现可能不含显式配置项）
    try {
      const settings = ctx.get('settings')
      const conf = settings?.get?.('llm-pi-ai')
      const prov = conf?.providers
      if (prov && typeof prov === 'object') {
        for (const [name, p] of Object.entries(prov)) {
          const ids = (Array.isArray(p?.models) ? p.models : [])
            .map((m) => (typeof m === 'string' ? m : m?.id))
            .filter(Boolean)
          if (ids.length) providers[name] = Array.from(new Set([...(providers[name] || []), ...ids]))
          else if (!(name in providers)) providers[name] = []
        }
      }
    } catch { /* ignore */ }
    return providers
  }

  // ── ACP（dsh-plugin-product-subagents）模型目录 ──
  // provider 级缓存文件由那个插件独占写入，本插件只读。任一环节缺失
  // （文件不存在 / JSON 损坏 / version 不认识 / 字段形状不符）都按"无 ACP 数据"降级，
  // 绝不让 /agent-api 报错——GUI 拿不到 ACP 目录时只是下拉退化为手输。
  const productCatalogPath = path.join(dshHome, 'data', 'dsh-plugin-product-subagents', 'provider-catalog.json')
  const PRODUCT_CATALOG_TTL_MS = 3000 // 同一 GET 反复命中时免重复 stat/read
  let productCatalogCache = { at: 0, mtimeMs: -1, size: -1, data: {} }
  const strArr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim() !== '') : [])
  /**
   * 选项元数据数组净化（v1.11.12 契约增量）：ACP 侧 model/effort 既有 value（要落盘的）
   * 又有 name（给人看的显示名）。只保留 value 非空字符串的项，name/description 缺失就不落键。
   */
  const optArr = (v) => {
    if (!Array.isArray(v)) return []
    const out = []
    const seen = new Set()
    for (const o of v) {
      if (!o || typeof o !== 'object') continue
      const value = typeof o.value === 'string' ? o.value.trim() : ''
      if (!value || seen.has(value)) continue
      seen.add(value)
      const item = { value }
      if (typeof o.name === 'string' && o.name.trim()) item.name = o.name.trim()
      if (typeof o.description === 'string' && o.description.trim()) item.description = o.description.trim()
      out.push(item)
    }
    return out
  }
  /** 值数组 = 纯 value 列表 ∪ 选项里的 value（保序去重）：只给 options 不给 values 时也能用 */
  const mergeValues = (values, opts) => {
    const out = values.slice()
    for (const o of opts) if (out.indexOf(o.value) < 0) out.push(o.value)
    return out
  }
  /** 读并净化 provider 级缓存：{ [provider]: {models, efforts, modelEfforts, modelOptions?, effortOptions?, modelEffortOptions?, defaultModel?, defaultEffort?, probedAt, error} } */
  const readProductCatalog = () => {
    const now = Date.now()
    if (now - productCatalogCache.at < PRODUCT_CATALOG_TTL_MS) return productCatalogCache.data
    let stat = null
    try {
      stat = fs.statSync(productCatalogPath)
    } catch {
      productCatalogCache = { at: now, mtimeMs: -1, size: -1, data: {} } // 文件不存在
      return productCatalogCache.data
    }
    if (stat.mtimeMs === productCatalogCache.mtimeMs && stat.size === productCatalogCache.size) {
      productCatalogCache = { ...productCatalogCache, at: now }
      return productCatalogCache.data
    }
    let data = {}
    try {
      const raw = JSON.parse(fs.readFileSync(productCatalogPath, 'utf8'))
      if (raw && typeof raw === 'object' && (raw.version === undefined || raw.version === 1) && raw.providers && typeof raw.providers === 'object') {
        for (const [name, entry] of Object.entries(raw.providers)) {
          if (!entry || typeof entry !== 'object') continue
          const modelOpts = optArr(entry.modelOptions)
          const effortOpts = optArr(entry.effortOptions)
          const models = mergeValues(strArr(entry.models), modelOpts)
          const efforts = mergeValues(strArr(entry.efforts), effortOpts)
          const modelEfforts = {}
          const modelEffortOptions = {}
          if (entry.modelEfforts && typeof entry.modelEfforts === 'object') {
            for (const [mid, list] of Object.entries(entry.modelEfforts)) {
              const ids = mergeValues(strArr(list), optArr(list)) // 兼容：该键的值数组里混对象形态时按选项净化
              if (ids.length) modelEfforts[mid] = ids
            }
          }
          if (entry.modelEffortOptions && typeof entry.modelEffortOptions === 'object') {
            for (const [mid, list] of Object.entries(entry.modelEffortOptions)) {
              const opts = optArr(list)
              if (!opts.length) continue
              modelEffortOptions[mid] = opts
              // 档位值同样并进来，避免 P 只给 options 时该模型没有可选档位
              const merged = mergeValues(modelEfforts[mid] || [], opts)
              modelEfforts[mid] = merged
            }
          }
          const item = { models, efforts }
          if (Object.keys(modelEfforts).length) item.modelEfforts = modelEfforts
          if (modelOpts.length) item.modelOptions = modelOpts
          if (effortOpts.length) item.effortOptions = effortOpts
          if (Object.keys(modelEffortOptions).length) item.modelEffortOptions = modelEffortOptions
          // v1.11.12 增量 3：产品自报的"当前默认值"（P 侧从会话 configOptions 的
          // currentValue 取），GUI 用它把「默认」项写成 默认（glm-5.1）而不是 默认（由 ACP 决定）。
          // 可选字段：缺失就不落键，老目录形状不变。
          const cleanDefault = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '')
          const defModel = cleanDefault(entry.defaultModel)
          const defEffort = cleanDefault(entry.defaultEffort)
          if (defModel) item.defaultModel = defModel
          if (defEffort) item.defaultEffort = defEffort
          if (typeof entry.probedAt === 'string') item.probedAt = entry.probedAt
          if (typeof entry.error === 'string' && entry.error.trim()) item.error = entry.error
          data[name] = item
        }
      }
    } catch {
      data = {} // 读/解析失败：无 ACP 数据
    }
    productCatalogCache = { at: now, mtimeMs: stat.mtimeMs, size: stat.size, data }
    return data
  }
  // 缓存失效：事件到达（缓存刚被那个插件重写）或显式探测请求后
  const invalidateProductCatalog = () => {
    productCatalogCache = { at: 0, mtimeMs: -1, size: -1, data: {} }
  }
  // product-subagents 写完缓存文件后的通知——只用来失效本插件的读缓存。
  // 订阅失败（旧版本无此事件）不影响功能：TTL 到期后自然读到新目录。
  let disposeCatalogListener = () => {}
  try {
    disposeCatalogListener = ctx.on('product-subagents/provider-catalog-updated', () => invalidateProductCatalog())
  } catch (err) {
    console.error('[dsh-agent-dispatch] provider-catalog-updated 订阅失败（旧版 product-subagents?）:', err.message)
  }

  /** 已注册的 subagent provider 名（宿主 ctx.subagents.list()）；老宿主无此方法时空数组 */
  const readSubagentProviders = () => {
    try {
      return strArr(ctx.subagents?.list?.())
    } catch {
      return []
    }
  }
  /** 路由是否走 ACP 中继（与 lib/dispatch.js 判定一致）——registry 校验用 */
  const isSubagentProviderRoute = (provider) => {
    if (typeof provider !== 'string' || provider.trim() === '') return false
    try {
      return !!ctx.subagents?.getProvider?.(provider)
    } catch {
      return false
    }
  }

  // LLM 侧真实推理档位：resolveModelInfo 会调适配器，逐个 provider×model 全量探
  // 有延迟风险，故做内存缓存 + 单次请求预算（条数上限 + 等待上限），
  // 超预算的模型本轮不下发档位 → GUI 该档退化为"不选 + 可手输"。
  const llmEffortCache = new Map() // `${provider}\u0000${model}` → { at, value|null }
  const LLM_EFFORT_TTL_MS = 300000
  const LLM_EFFORT_PROBE_BUDGET = 24
  const LLM_EFFORT_WAIT_MS = 1200
  const llmEffortInflight = new Set()
  const llmEffortKey = (p, m) => `${p}\u0000${m}`
  const probeLlmEfforts = (provider, model) => {
    const key = llmEffortKey(provider, model)
    const hit = llmEffortCache.get(key)
    if (hit && Date.now() - hit.at < LLM_EFFORT_TTL_MS) return Promise.resolve(hit.value)
    if (llmEffortInflight.has(key)) return Promise.resolve(null)
    llmEffortInflight.add(key)
    return (async () => {
      try {
        const llm = ctx.get('llm')
        if (!llm || typeof llm.resolveModelInfo !== 'function') return null
        const info = await llm.resolveModelInfo(provider, model)
        const ids = strArr((info?.reasoning?.efforts || []).map((e) => (typeof e === 'string' ? e : e?.id)))
        if (!ids.length) return null
        const def = info?.reasoning?.defaultEffort
        return { efforts: ids, ...(typeof def === 'string' && def ? { defaultEffort: def } : {}) }
      } catch {
        return null // 适配器不支持/抛错：该模型无档位可枚举
      }
    })()
      .then((value) => {
        llmEffortCache.set(key, { at: Date.now(), value })
        return value
      })
      .finally(() => llmEffortInflight.delete(key))
  }
  /** 按模型目录收集 LLM 档位：{ [provider]: { [model]: {efforts, defaultEffort?} } } */
  const readLlmEfforts = async (modelOptions) => {
    const out = {}
    const take = (provider, model, value) => {
      out[provider] = out[provider] || {}
      out[provider][model] = value
    }
    const pending = []
    for (const [provider, models] of Object.entries(modelOptions || {})) {
      for (const model of strArr(models)) {
        const hit = llmEffortCache.get(llmEffortKey(provider, model))
        if (hit && Date.now() - hit.at < LLM_EFFORT_TTL_MS) {
          if (hit.value) take(provider, model, hit.value)
          continue
        }
        if (pending.length < LLM_EFFORT_PROBE_BUDGET) pending.push(probeLlmEfforts(provider, model).then((v) => (v ? take(provider, model, v) : undefined)))
      }
    }
    if (pending.length) {
      // 超时只放弃"本轮等待"，探测本身继续跑完并落缓存，下次 GET 即命中
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => {
          const t = setTimeout(resolve, LLM_EFFORT_WAIT_MS)
          t.unref?.()
        }),
      ])
    }
    return out
  }

  const readDefaultModel = () => {
    try {
      const settings = ctx.get('settings')
      const d = settings?.get?.('agent-default-model') ?? settings?.get?.('default-model')
      // 只认 provider 与 model 都非空的对象：GUI 直接拼 provider/model，
      // 半截对象（settings 里 {} 或只配了一侧）会渲染成 "undefined / xxx"。
      if (
        d && typeof d === 'object' &&
        typeof d.provider === 'string' && d.provider.trim() !== '' &&
        typeof d.model === 'string' && d.model.trim() !== ''
      ) return d
    } catch { /* ignore */ }
    return null
  }

  const dispatchesPath = path.join(dataDir, 'dispatches.jsonl')
  // v0.7.1：日志上限 2000 行——超出即重写文件保留尾部（只保留最近的），防长期膨胀
  const LOG_MAX_LINES = 2000
  const readDispatches = (limit = 20) => {
    try {
      const text = fs.readFileSync(dispatchesPath, 'utf8').trim()
      if (!text) return []
      let lines = text.split('\n')
      if (lines.length > LOG_MAX_LINES) {
        try {
          fs.writeFileSync(dispatchesPath, lines.slice(-LOG_MAX_LINES).join('\n') + '\n', 'utf8')
        } catch { /* 重写失败不影响本次读取 */ }
        lines = lines.slice(-LOG_MAX_LINES)
      }
      const tail = lines.slice(-Math.max(1, Math.min(500, Number(limit) || 20)))
      return tail
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .reverse()
    } catch {
      return []
    }
  }

  /** 当前真正在跑的子 agent childId 集合（内存活跃映射，是"运行中"的唯一权威运行时来源）。 */
  const activeChildIds = () =>
    new Set([...dispatcher.activeChildren.values()].map((e) => e && e.childId).filter(Boolean))

  /**
   * v0.7.1：把 dispatch 行与 result 行按 childId 合并——派遣行只有"派遣成败"，
   * 真实执行结果（stopReason）在 subagent/end 时追加的 result 行里。
   * 合并后：历史页与成功率的 ok 字段反映真实结局。
   *
   * v0.8.1：孤儿收敛。result 行只由"当前进程"的 subagent/end 监听器追加，
   * 宿主重启、或 0.7.1 之前的遗留行（无 kind 字段）都会丢结局 → 孤儿。
   * 孤儿若仍以 `ended:undefined` 透出，历史页会永远显示"运行中"（假阳性）。
   * 因此"运行中"改以活体 activeChildren 为准：不在活跃映射的未终结行收敛为
   * `orphan:true`（状态未知），不再冒充运行中。
   */
  const mergeDispatchHistory = (rows, liveActiveChildIds) => {
    // 时间配对：rows 最新在前 → 倒序迭代即时间正序。
    // 每个 result 行绑定"同 childId 最近一条未匹配的派遣行"——
    // 续聊复用同 child 时，第 1 次派遣得第 1 次结局、第 2 次派遣得第 2 次结局，互不串。
    const active = liveActiveChildIds instanceof Set ? liveActiveChildIds : new Set()
    const merged = rows.slice()
    const pending = new Map() // childId → 最近未匹配的派遣行下标（按时间正序推进）
    for (let i = merged.length - 1; i >= 0; i--) {
      const r = merged[i]
      // v1.11.12：kind:'config' 是「配置项被产品拒绝」的观测行，不是一次委派——
      // 只留档供 grep/排障，不参与 result 配对，也不进历史页卡片。
      // v1.12.4：'host-approval'（审批放行/授权清理）与 'plugin-warn'（降级留痕）
      // 同属观测行——它们没有 childId，落到历史页会变成一排「状态未知」的假卡片。
      if (r.kind === 'config' || r.kind === 'host-approval' || r.kind === 'plugin-warn') { merged[i] = null; continue }
      if (r.kind === 'result') {
        if (r.childId && pending.has(r.childId)) {
          const j = pending.get(r.childId)
          pending.delete(r.childId)
          merged[j] = { ...merged[j], ok: r.ok, stopReason: r.stopReason, ended: true, parentSessionId: r.parentSessionId ?? merged[j].parentSessionId ?? null }
        }
        merged[i] = null // result 行本身不展示
      } else if (r.kind === 'squad-run') {
        // v0.9.17：小队运行日志行原样透传（前端按 squadRunId 聚合），不参与配对/孤儿收敛
      } else if (r.childId) {
        // kind:'dispatch' 与 0.7.1 之前无 kind 的遗留派遣行都参与配对
        pending.set(r.childId, i) // 后来的派遣行覆盖（时间更晚的才是当前未终结任务）
      }
    }
    // 孤儿收敛：未终结但 child 不在活体活跃映射 → 不是真在跑。
    for (let i = 0; i < merged.length; i++) {
      const row = merged[i]
      if (!row || row.ended || row.kind === 'squad-run') continue
      if (row.childId && active.has(row.childId)) continue // 真在跑，保持"运行中"
      // 派遣本身失败的行（ok:false，通常 childId 为 null）结局已知 → 直接终结，前端显示"失败"
      merged[i] = row.ok === false
        ? { ...row, ended: true }
        : { ...row, ended: true, orphan: true } // 其余：宿主重启/遗留行丢结局 → 状态未知
    }
    const squadMap = squadById() // v0.9.16：最近委派按小队维度聚合需要小队名
    return merged.filter(Boolean).map((row) => {
      // v0.9.15：头像/名称按 agentId 回填注册表实时值（与 Agent 调度页同源）——
      // 日志行里Agent改名/改 emoji 后，悬浮球「最近委派」与历史页不再显示旧名或丢 emoji 落首字
      const agent = registry.get(row.agentId)
      const next = agent
        ? { ...row, emoji: agent.emoji || row.emoji || '', agentName: agent.name || row.agentName }
        : row
      // v0.9.16：小队触发的行回填小队名（改名后同步，前端聚合卡展示用）
      if (next.viaSquad) {
        const sq = squadMap.get(next.viaSquad)
        next.squadName = sq?.name ?? next.viaSquad
        next.squadEmoji = sq?.emoji ?? ''
      }
      return next
    })
  }

  const restHandler = async (req, res) => {
    try {
      const pathname = decodeURIComponent((req.url || '/').split('?')[0])
      const query = new URL(req.url || '/', 'http://x').searchParams
      await Promise.all([ready, squadsReady])
      if (req.method === 'GET' && pathname === '/agent-api') {
        const models = await readModelOptions()
        return send(res, 200, {
          ok: true,
          dataDir: tildify(dataDir),
          agents: registry.list(),
          models,
          defaultModel: readDefaultModel(),
          // ACP 侧数据面（GUI 唯一来源，事件不会转发到 web）：
          // subagentProviders = 宿主已注册 subagent provider 名；
          // productModels = product-subagents 落盘的 provider 级模型/档位缓存（只读）。
          // 刻意不并入 models：混进去会让前端 onProviderChange 误判并清空 model。
          subagentProviders: readSubagentProviders(),
          productModels: readProductCatalog(),
          llmEfforts: await readLlmEfforts(models),
        })
      }
      if (req.method === 'GET' && pathname === '/agent-api/dispatches') {
        return send(res, 200, { ok: true, dispatches: mergeDispatchHistory(readDispatches(query.get('limit')), activeChildIds()) })
      }
      if (req.method === 'GET' && pathname === '/agent-api/squads') {
        return send(res, 200, { ok: true, squads: squadRegistry.list() })
      }
      // v1.6.0：悬浮球配置（隐藏状态/位置/显示模式/设置）——VS Code webview 重建换 origin，
      // iframe localStorage 分区丢失，配置改由宿主落盘 fab-config.json 恢复。
      // client 读时序：宿主值 > localStorage > 默认；无值返回 null（client 回退 localStorage）。
      if (req.method === 'GET' && pathname === '/agent-api/fab-config') {
        return send(res, 200, { ok: true, config: readFabConfig(dataDir) })
      }
      if (req.method === 'POST') {
        // v0.8.2：所有 POST 路由合并到同一块。此前这里有两个 if(POST) 块，
        // 第一块 default 分支 404 return 把第二块的 toggle/upsert/remove/import-skill 全吞了。
        const body = await readBody(req)
        let out
        switch (pathname) {
          case '/agent-api/squad/upsert':
            out = { squad: await squadRegistry.upsert(body.squad) }
            break
          case '/agent-api/squad/remove':
            out = { removed: await squadRegistry.remove(body.id) }
            break
          case '/agent-api/squad/toggle':
            out = { updated: await squadRegistry.setEnabled(body.id, body.enabled) }
            break
          case '/agent-api/upsert':
            await registry.upsert(body.agent, { isSubagentProvider: isSubagentProviderRoute })
            out = {}
            break
          // ACP 模型目录刷新：只发探测请求，绝不在本请求里等探测完成
          //（探测可能起子进程、冷启动数秒）。完成后那个插件重写缓存文件并发
          // provider-catalog-updated 事件，本插件失效内存缓存，GUI 再 GET 即拿到新目录。
          case '/agent-api/probe-product-models': {
            const provider = typeof body.provider === 'string' && body.provider.trim() ? body.provider.trim() : undefined
            invalidateProductCatalog()
            try {
              ctx.emit('product-subagents/probe-provider', { ...(provider ? { provider } : {}), reason: 'gui-agent-form' })
            } catch (err) {
              return send(res, 200, { ok: true, accepted: false, error: '探测请求发送失败: ' + (err?.message || String(err)) })
            }
            out = { accepted: true, ...(provider ? { provider } : {}) }
            break
          }
          case '/agent-api/remove':
            out = { removed: await registry.remove(body.id) }
            break
          case '/agent-api/toggle':
            out = { updated: await registry.setEnabled(body.id, body.enabled) }
            break
          case '/agent-api/import-skill': {
            const { agent, warnings } = skillToAgent(defaultSkillsRoot(), body.skillDir)
            await registry.upsert(agent, { isSubagentProvider: isSubagentProviderRoute })
            out = { agent: { id: agent.id, name: agent.name }, warnings }
            break
          }
          case '/agent-api/fab-config': {
            // v1.6.0：悬浮球配置字段级合并写入（visible/mode/pos/settings），原子落盘；
            // 校验失败 normalizeFabConfig 抛错 → 外层 catch 400 透传错误消息
            out = { config: mergeFabConfig(dataDir, body) }
            break
          }
          case '/agent-api/history/remove': {
            // v0.8.5：删除一条委派历史——按 dispatch 行的 ts 定位，
            // 同 childId 的 result 行一并删除（续聊复用 child 时只删最近未匹配的对应结局）
            // v0.9.30 修：JSONL 的 ts 是 ISO 字符串（new Date().toISOString()），
            // 旧逻辑 Number(body.ts) → NaN → 一律 400「缺少有效 ts」。兼容字符串与数字两种形态。
            const ts = body.ts
            const tsValid = typeof ts === 'string' ? ts.length > 0 : Number.isFinite(Number(ts))
            if (!tsValid) return send(res, 400, { ok: false, error: '缺少有效 ts' })
            const tsKey = String(ts) // 统一按字符串比对，数字形态的旧数据也能命中
            let lines = []
            try {
              const text = fs.readFileSync(dispatchesPath, 'utf8').trim()
              if (text) lines = text.split('\n')
            } catch (err) {
              return send(res, 500, { ok: false, error: '读取历史失败: ' + err.message })
            }
            const keep = []
            let removed = 0
            let targetChild = null
            let removedDispatch = false
            let awaitingResult = false
            for (const line of lines) {
              let row = null
              try { row = JSON.parse(line) } catch { keep.push(line); continue }
              if (!removedDispatch && row && String(row.ts) === tsKey && row.kind !== 'result') {
                removedDispatch = true
                removed += 1
                targetChild = row.childId ?? null
                awaitingResult = targetChild != null
                continue // 删除该 dispatch 行
              }
              // 紧随其后的同 childId result 行删（续聊复用 child 时只删本次结局，不误伤后续派遣）
              if (awaitingResult && row && row.kind === 'result' && row.childId === targetChild) {
                awaitingResult = false
                removed += 1
                continue
              }
              if (awaitingResult && row && row.kind === 'dispatch' && row.childId === targetChild) {
                awaitingResult = false // 遇下一个同 child 派遣：不再吞后续行
              }
              keep.push(line)
            }
            if (!removedDispatch) return send(res, 404, { ok: false, error: '未找到该历史记录' })
            try {
              fs.writeFileSync(dispatchesPath, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8')
            } catch (err) {
              return send(res, 500, { ok: false, error: '写入历史失败: ' + err.message })
            }
            out = { removed }
            break
          }
          case '/agent-api/history/remove-run': {
            // v0.9.17：删除整次小队运行——两条 squad-run 行 + 全部带该 squadRunId 的 dispatch 行 + 对应 result 行
            const id = body.squadRunId
            if (!id || typeof id !== 'string') return send(res, 400, { ok: false, error: '缺少 squadRunId' })
            let lines = []
            try {
              const text = fs.readFileSync(dispatchesPath, 'utf8').trim()
              if (text) lines = text.split('\n')
            } catch (err) {
              return send(res, 500, { ok: false, error: '读取历史失败: ' + err.message })
            }
            const childIds = new Set()
            for (const line of lines) {
              try {
                const row = JSON.parse(line)
                if (row.squadRunId === id && row.kind !== 'result' && row.childId) childIds.add(row.childId)
              } catch { /* 非 JSON 行不参与匹配 */ }
            }
            const keep = []
            let removed = 0
            for (const line of lines) {
              let row = null
              try { row = JSON.parse(line) } catch { keep.push(line); continue }
              const hit =
                row.squadRunId === id ||
                (row.kind === 'result' && row.childId && childIds.has(row.childId))
              if (hit) { removed += 1; continue }
              keep.push(line)
            }
            if (!removed) return send(res, 404, { ok: false, error: '未找到该运行记录' })
            try {
              fs.writeFileSync(dispatchesPath, keep.join('\n') + (keep.length ? '\n' : ''), 'utf8')
            } catch (err) {
              return send(res, 500, { ok: false, error: '写入历史失败: ' + err.message })
            }
            out = { removed }
            break
          }
          case '/agent-api/cancel': {
            // v0.7.1：中止运行中的子 agent（宿主 interrupt，user-authority）
            // v0.9.40：activeChildren 改 childId 主 key——优先按 body.childId 精确定位，
            // 兼容旧 client 传 agentId（走 byAgent 二级索引取该Agent最新活跃 child）
            const entry = body.childId
              ? dispatcher.activeChildren.get(body.childId)
              : dispatcher.activeChildren.get(dispatcher.byAgent.get(body.agentId))
            if (!entry || !entry.childId) return send(res, 404, { ok: false, error: '该 Agent 没有运行中的子代理' })
            if (typeof ctx.subagents.interrupt !== 'function') return send(res, 501, { ok: false, error: '宿主不支持 interrupt' })
            try {
              ctx.subagents.interrupt(entry.childId, { kind: 'user', parentSessionId: entry.parentSessionId })
              out = { cancelled: true }
            } catch (err) {
              return send(res, 409, { ok: false, error: err.message })
            }
            break
          }
          case '/agent-api/permission-decision': {
            // v1.9.0：授权球按钮决策 → 转发 product-subagents（双通道竞速）
            // body: { childId, permId?, answer: 'allow-once'|'allow-session'|'allow-always'|'deny', paths?: string[] }
            // v1.11.14(A)：permId 精确决议某一条；缺省（老 client）时由
            // product-subagents 按 FIFO 摘最早一条，不会丢请求。
            const answer = body && body.answer
            const target = body && body.childId
            if (!target || !['allow-once', 'allow-session', 'allow-always', 'deny'].includes(answer)) {
              return send(res, 400, { ok: false, error: 'permission-decision 需要 childId 与合法 answer' })
            }
            const permId = typeof body.permId === 'string' && body.permId.trim() ? body.permId.trim() : null
            // v1.12.6（U2 契约，与 product-subagents 0.7.9 对齐）：「可编辑路径」弹框
            // 确认后可以把**用户声明的目录**一起带过来。三态与宿主侧同口径：
            //   · 非数组（老 client / 没给）⇒ 完全不进载荷 ⇒ 产品侧沿用其自动分析；
            //   · 给了且非空 ⇒ 产品侧只写路径档；
            //   · 给了且为空数组 ⇒ 产品侧只写工具名档。
            // 本插件**不**在这里校验或改写：产品侧 planGrantWrites 是这条链的
            // 单一判定点（0.7.9 lib/permission-rules.js），两侧各判一次必然漂移。
            const pathsGiven = Array.isArray(body && body.paths)
            try {
              const payload = { childId: target, permId, answer }
              if (pathsGiven) payload.paths = body.paths
              ctx.emit('product-subagents/permission-decision', payload)
              out = { forwarded: true, answer, permId }
              if (pathsGiven) out.pathsCount = body.paths.length
            } catch (err) {
              return send(res, 409, { ok: false, error: err.message })
            }
            break
          }
          case '/agent-api/host-approval-rule': {
            // v1.10.0：宿主审批分档规则写入（服务端重取路径，不信任客户端）
            // v1.12.0：新增工具名级会话授权（scope=session 时按根会话+工具名授权，
            //   同一主会话内所有子代理共享，不再因路径不同重复弹窗）。
            // v1.12.5（二次裁定）：scope=project 且暂存上下文是**沙箱越权** ⇒ 不落盘，
            //   降级写会话路径规则，响应如实回 scope='session' + projectSuppressed。
            // v1.12.6 B1：上面那条的判据收窄回 isSandboxEscalation（1.12.5 误用了含
            //   ACP 孪生的 isDisallowedAutoGrant，把 ACP 孪生原有的项目档落盘一起吞了）。
            // v1.12.6 U2：新增可选 body.paths ——「可编辑路径」弹框里用户确认的目录声明。
            //   三态与 product-subagents 0.7.9 planGrantWrites 同口径（两侧必须对齐）：
            //     · 未给（非数组）⇒ 老客户端 ⇒ 完全沿用服务端自动分析，行为逐字不变；
            //     · 给了且校验后非空 ⇒ **只写路径档**（用户声明的已是目录，不补父目录，
            //       也不写工具名档）；
            //     · 给了且为空（[] 或全部被校验丢弃）⇒ **只写工具名档**，一条路径都不写。
            //   声明只在 callId 反查到审批上下文时才被接受，否则 400：拿不到 reason
            //   就判不出这条是不是越权，不能盲落盘（「不信任客户端」= 接受但必须校验 +
            //   必须挂在一次真实审批上，授权主体是用户本人）。
            // body: { scope: 'session'|'project', sessionId, callId?, cwd?, toolName?, paths? }
            const scope = body && body.scope
            const sid = body && body.sessionId
            if (!sid || !['session', 'project'].includes(scope)) {
              return send(res, 400, { ok: false, error: 'host-approval-rule 需要 scope(session|project) 与 sessionId' })
            }
            // 服务端重取路径：按 callId 反查会话记录
            let approvalCtx = null
            const callId = body && body.callId
            if (callId) {
              approvalCtx = hostApproval.popPendingContext(callId)
            }
            // 优先用暂存上下文（approval/request handler 已解析），否则用 body 中的 cwd
            // 注意：自动分析的路径只能来自 callId 反查——无 callId ⇒ approvalCtx 为 null
            // ⇒ 自动路径恒为 []。这一点决定了下面 scope==='session' 分支的真实语义。
            const autoPaths = approvalCtx?.paths ?? []
            const cwd = approvalCtx?.cwd ?? (body && body.cwd) ?? null
            // v1.12.3：服务端自行解析根会话 id，不轻信客户端传来的 sessionId
            // （无 callId 时客户端可能传子会话 id → 工具名授权写到子会话键 → 永不命中）
            let rootSessionId = approvalCtx?.rootSessionId ?? null
            if (!rootSessionId) {
              // 无暂存上下文 → 从 sessionId 解析。这里拿不到宿主 session 对象
              // （宿主不暴露会话查询），只能给一个 header 为空的壳子：
              // 解析结果要么是 sid 自身，要么是经 #sessionRoots 链上去的根 id
              // （该映射只在 approval/request 见到真实 header 时按委派判据登记）。
              const lookupSession = { id: sid, header: {} }
              rootSessionId = resolveRootSessionId(lookupSession, dispatcher, (s) => hostApproval.sessionRootOf(s))
            }
            const toolName = body?.toolName || approvalCtx?.toolName || null
            // v1.12.6 U2：客户端声明的目录（逐条服务端校验，非法丢弃；未给 = 自动分析）
            const declared = validateDeclaredPaths(body && body.paths)
            const useDeclared = declared.given
            // v1.12.6 第五轮（终审 M-B）：**给了路径但一条都不合法** ≠ **本来就空**。
            // 两者天然可分：真删空时 `dropped === []`（客户端 `collect()` 只收勾选行的非空行），
            // 而「全非法」必然带 dropped（至少一条 `非绝对路径`/`根目录`/空串…）。
            // 改前两者走同一条路 ⇒ 落到「路径声明为空 ⇒ 只写工具名档」⇒ **静默放大**：
            // 用户以为自己授权了 `./x.txt`，实际拿到的是**整个工具**（终审端点级原始输出：
            // `POST paths:['./x.txt']` → 200 + `toolGrant(read)` ⇒ 随后 read `/etc/passwd`
            // 直接 `allowed-once`）。放大方向是「少弹、且弹框里看不出来」，必须拒。
            // 这里**不写任何档**（会话档、落盘档、工具名档都不写）并回 400 说清原因。
            if (useDeclared && declared.declared.length === 0 && declared.dropped.length > 0) {
              logApproval(
                `宿主审批规则：路径声明全部非法 ⇒ 拒写任何规则（既不写路径档，也不退化成工具名档）: ` +
                `tool=${toolName ?? '未解析出'} session=${sid} requested=${declared.dropped.length} ` +
                `reasons=${JSON.stringify([...new Set(declared.dropped.map((d) => d.reason))])}`,
                {
                  action: 'rule-rejected-all-paths-dropped', tool: toolName ?? null,
                  sessionId: sid, droppedCount: declared.dropped.length,
                  reasons: [...new Set(declared.dropped.map((d) => d.reason))],
                },
              )
              return send(res, 400, {
                ok: false,
                error: 'paths 里没有一条可用的绝对路径（全部被校验丢弃）：本次不写任何规则'
                  + '——写成工具名档会把授权放大到整个工具，而用户以为只授权了那几条路径',
                dropped: declared.dropped,
              })
            }
            // v1.12.7 终审 M1（纵深防御；现网不可触发，因为客户端「仅本次放行」根本不发 POST）：
            // **`paths: null` 与「未给 paths 键」必须严格区分**。
            // 客户端「仅本次放行」的显式契约是 `{paths: null, mode:'once'}` ＝ 一条规则都不写；
            // 但 `validateDeclaredPaths` 的 `given = Array.isArray(raw)` 会把 `null` 归成
            // `given=false`，于是整条请求落进下面 `useDeclared=false` 的 legacy 分支
            // （**同时写工具名档与路径档**）——语义与「仅本次」正好相反：用户以为什么都没记住，
            // 实际拿到的是「该工具对任意路径免弹」。终审探针实测：
            // `POST {scope:'session',sessionId:'S2',callId:'n1',toolName:'read',paths:null}` ⇒
            // 200 `written:true, paths:['/etc/passwd'], toolName:'read'`，随后同工具任意路径被放行。
            // 判据用**键是否存在**（不是值的形态）：键在且值为 null ⇒ 不写任何档，如实回
            // `written:false`（同一响应包络，客户端 200 即视为成功、继续走「仅本次」）；
            // 键不存在 ⇒ 完全不走这里，legacy 行为逐字不变（老客户端兼容）。
            if (body && Object.prototype.hasOwnProperty.call(body, 'paths') && body.paths === null) {
              logApproval(
                `宿主审批规则：paths=null ⇒ 不写任何档（客户端「仅本次放行」的显式声明）: ` +
                `tool=${toolName ?? '未解析出'} scope=${scope} session=${sid} callId=${callId ?? '无'}`,
                {
                  action: 'rule-none-declared-null', scope, tool: toolName ?? null,
                  sessionId: sid, callId: callId ?? null,
                },
              )
              return send(res, 200, {
                ok: true,
                written: false,
                scope,
                paths: null,
                toolName,
                rootSessionId,
                reason: 'paths 显式声明为 null（＝仅本次放行）⇒ 路径档与工具名档一律未写',
              })
            }
            if (useDeclared && !approvalCtx) {
              return send(res, 400, {
                ok: false,
                error: '带 paths 声明的写入必须带能反查到审批上下文的 callId：'
                  + '没有上下文就判不出这条请求是不是沙箱越权，不能盲落盘',
              })
            }
            const paths = useDeclared ? declared.declared : autoPaths
            // 用户声明的是目录，不再 expandPathsWithParents（会把 /tmp/newproj 放大成 /tmp）
            const expand = !useDeclared
            // v1.12.5 二次裁定 + v1.12.6 B1 收窄：**只有沙箱越权**不得写落盘项目白名单。
            // 判据是 isSandboxEscalation(approvalCtx.reason) 单独一条，**不是**
            // isDisallowedAutoGrant（那是读取侧「工具名档不适用」的判据，含 ACP 孪生）。
            // 1.12.5 误用后者的后果：ACP 孪生点「总是允许(项目)」也被降级成会话档、
            // allowlist.json 根本不创建——ACP 的既有落盘行为被顺带改掉，而用户口径是
            // 「ACP 完全绕过、不要动它」，且 CHANGELOG 自述写的是「判为越权时不落盘」。
            // 这里没有「判不出是不是越权却照样落盘」的漏口：能走到落盘的两条路
            // （自动路径 / 用户声明）都要求 approvalCtx 存在，reason 就在里面。
            const sandboxEscalated = !!approvalCtx && isSandboxEscalation(approvalCtx.reason)
            // v1.12.3 根会话确认门（原样保留）：rootSessionId===sid 且无暂存上下文时，
            // 无法确认 sid 是不是真正的根 → 拒写工具名授权（防写到非根键永不命中）
            const isConfirmedRoot = rootSessionId !== sid || !!approvalCtx?.rootSessionId
            let writeResult
            let toolOnly = false
            // v1.12.14：工具档真的落盘了吗（决定响应回 scope='project' 还是如实降级回 'session'）
            let toolPersisted = false
            if (useDeclared && paths.length === 0) {
              // 弹框里**真删空**（`paths: []`，`dropped === []`）⇒ 「只要工具名」（用户明确定的
              // 语义）。v1.12.6 第五轮（终审 M-B）之后，**「给了但全非法」到不了这里** ——
              // 它在上面就 400 了；走到这里只可能是客户端如实报了空声明。
              // v1.12.7（用户裁定）：**沙箱越权请求也走这里，没有任何守卫挡它**——这是有意行为。
              // 越权请求在弹框里把目录全删空 ⇒ 写下的就是工具名档（会话级、内存、
              // purgeSession 清），读取侧现在会消费它：同一主会话内该工具任意路径
              // （含工作区外）直接放行；危险命令仍永远弹（门排在档位判定之前）。
              // 越权唯一被抑制的仍是**落盘项目档**（下面的 sandboxEscalated 分支）。
              //
              // v1.12.14（缺口修复）：客户端的二级选择把「要不要落盘」编码在 scope 上——
              //   ①「允许一次」⇒ 客户端根本不发 POST（`d.mode==='once'`，paths:null 那条）;
              //   ②「落盘工具放行任意路径」⇒ scope='project' + `paths: []` + toolName：
              //      **必须落盘**一条工具档（`{cwd, product:'main', paths:[], tools:['main:<工具>'],
              //      note}`，与 product-subagents 共用同一份 allowlist.json + 同一判定语义）；
              //   · scope='session'（「本会话总是允许该工具」的二级选择）⇒ 只写内存档，
              //     语义与本版之前逐字一致（不落盘）。
              // 改前两条都只写内存档 —— 现场证据（按 ts+action）：`2026-10-06T14:42:01.344Z
              // action=rule-tool-only scope=session tool=write dropped=0`，而共用
              // allowlist.json md5/mtime 一字未动 ⇒ 用户以为「落盘」了、重载宿主后照样弹。
              // 落盘失败（或取不到 cwd/toolName）时**回退内存档**并在响应里如实回
              // `toolPersisted:false` + 日志 `rule-tool-disk-failed`（不许静默降级）。
              const persistToolRule = scope === 'project'
              let persistedToolRule = null
              if (persistToolRule && toolName && cwd) {
                persistedToolRule = hostApproval.appendProjectToolRule({
                  cwd,
                  toolName,
                  note: '用户在授权界面选择「落盘工具放行任意路径」（该工具对本项目任意路径放行）',
                })
              }
              if (persistedToolRule && persistedToolRule.ok) {
                writeResult = persistedToolRule
                toolOnly = true
                toolPersisted = true
                logApproval(
                  `宿主审批规则：项目档 + 路径声明为空 ⇒ 落盘工具档: ` +
                  `tool=${toolName} key=${persistedToolRule.key} cwd=${persistedToolRule.cwd} ` +
                  `session=${sid} dropped=${declared.dropped.length}`,
                  {
                    action: 'rule-tool-disk', scope: 'project', tool: toolName, toolKey: persistedToolRule.key,
                    cwd: persistedToolRule.cwd, rootSessionId, sessionId: sid,
                    requested: (body && Array.isArray(body.paths) ? body.paths.length : 0), droppedCount: declared.dropped.length,
                  },
                )
              } else {
                if (persistToolRule) {
                  logApproval(
                    `宿主审批规则：落盘工具档失败 ⇒ 回退会话工具档（用户以为落盘了、实际只在本次会话生效，必须可见）: ` +
                    `tool=${toolName ?? '未解析出'} cwd=${cwd ?? '无'} session=${sid} reason=${persistedToolRule?.error ?? '缺少 cwd 或工具名'}`,
                    {
                      action: 'rule-tool-disk-failed', scope: 'session', tool: toolName ?? null,
                      cwd: cwd ?? null, rootSessionId, sessionId: sid,
                      error: persistedToolRule?.error ?? '缺少 cwd 或工具名',
                    },
                  )
                }
                if (toolName && isConfirmedRoot) writeResult = hostApproval.addToolGrant(rootSessionId, toolName)
                if (!writeResult) {
                  return send(res, 400, {
                    ok: false,
                    error: '路径已全部删空 ⇒ 本次只写工具名档，但工具名档写不出去'
                      + `（toolName=${toolName ?? '未解析出'}${isConfirmedRoot ? '' : '，且无法确认根会话 id'}`
                      + `${persistToolRule ? `；落盘工具档也失败：${persistedToolRule?.error ?? '缺少 cwd 或工具名'}` : ''}）`,
                  })
                }
                toolOnly = true
                logApproval(
                  `宿主审批规则：路径声明为空 ⇒ 只写工具名档: ` +
                  `tool=${toolName} scope=session root=${rootSessionId} session=${sid} dropped=${declared.dropped.length}`,
                  {
                    action: 'rule-tool-only', scope: 'session', tool: toolName, rootSessionId, sessionId: sid,
                    requested: (body && Array.isArray(body.paths) ? body.paths.length : 0), droppedCount: declared.dropped.length,
                  },
                )
              }
            } else if (scope === 'session') {
              if (useDeclared) {
                // 用户声明了目录 ⇒ 只写路径档（契约「paths 与 tools 互斥」）
                writeResult = hostApproval.addSessionRule(rootSessionId, paths, { expand: false })
              } else {
                // 工具名级授权：写入根会话 + 工具名（v1.12.3 根会话确认门见上）
                // v1.12.7（用户裁定）：**越权请求也走这一条**，与「删空路径」那条一样没有守卫
                // ——写入侧从来就不区分越权（唯一区分越权的是下面 sandboxEscalated 的落盘抑制）。
                // 读取侧现在消费它（scope='session-tool'），所以越权请求点一次「本会话总是允许」
                // 之后，同一主会话内该工具对任意路径直接放行。
                // v1.12.4：删掉 v1.12.3 那句「降级为路径级」的空 else-if 分支——它是死代码：
                // 走到这里必然无 callId ⇒ paths 为 [] ⇒ 下面的路径规则写入也不会执行，
                // 真实行为是「什么都不写，落到下面返回 400」。
                if (toolName && isConfirmedRoot) {
                  writeResult = hostApproval.addToolGrant(rootSessionId, toolName)
                }
                // 路径规则：有路径时仍写入路径规则（兼容旧按钮与路径级精细授权）
                // v1.12.1：路径规则也写入 rootSessionId 键（与 decide 读取一致）
                if (paths.length > 0) {
                  const pathResult = hostApproval.addSessionRule(rootSessionId, paths)
                  if (!toolName) writeResult = pathResult
                }
                if (!writeResult) {
                  return send(res, 400, {
                    ok: false,
                    error: '未写入任何规则：无法解析请求路径（需要 callId 且工具调用记录已落盘），'
                      + '且无法确认根会话 id（无 callId 时不写工具名授权，避免写到非根键永不命中）',
                  })
                }
              }
            } else {
              if (paths.length === 0) {
                return send(res, 400, { ok: false, error: '无法解析请求路径（可能无 callId 或工具调用记录未落盘）' })
              }
              // v1.12.14（用户裁定，有意放开 1.12.5/1.12.7 的守卫）：**用户在授权界面显式选择
              // 项目档**（蓝球「总是允许(项目)」）时不再按沙箱越权降级——勾了 ≥1 个绝对目录就
              // 照旧落盘路径档。放开条件**仅此一条**（用户点了项目档按钮），其余守卫全部保留：
              //   · 全非法/全丢弃声明仍 400 且什么档都不写（上面那道门）；
              //   · 「仅本次放行」仍绝不落盘（客户端不发 POST；`paths:null` 那条也仍 200 written:false）；
              //   · 危险命令门命中仍照旧弹窗，写侧不受影响（门在读取侧排在最前）；
              //   · 落盘失败仍 400（不改）；工具档写不出去时仍回退会话档并如实降级。
              // 改前的行为（现场证据）：越权 + 项目档 ⇒ `action=rule-downgraded` +
              // 「沙箱越权请求不得写项目白名单」⇒ 用户显式点了项目档却只拿到会话档。
              writeResult = hostApproval.appendProjectRule({ cwd, paths, expand, note: '用户在授权球点击总是允许(项目)' })
              if (sandboxEscalated) {
                logApproval(
                  `宿主审批规则：沙箱越权请求 + 用户显式选择项目档 ⇒ 不降级，照旧落盘（v1.12.14 用户裁定，有意放开该守卫）: ` +
                  `tool=${toolName ?? '?'} scope=project root=${rootSessionId} session=${sid} pathCount=${paths.length}`,
                  {
                    action: 'rule-project-written', scope: 'project', tool: toolName ?? null,
                    rootSessionId, sessionId: sid, pathCount: paths.length, escalation: true,
                  },
                )
              }
            }
            if (!writeResult.ok) {
              return send(res, 400, { ok: false, error: writeResult.error || '写入规则失败' })
            }
            // 实际生效档位（v1.12.14 订正）：
            //   · 越权 + 项目档**不再**降级——用户显式点了项目档 ⇒ 照落盘（上面那支）；
            //   · 「落盘工具放行任意路径」真的落了盘 ⇒ 如实回 scope='project' + toolPersisted；
            //   · 唯一如实降级的是「空路径 + 项目档但工具档没落成 ⇒ 只拿到会话工具档」。
            const downgraded = scope === 'project' && toolOnly && !toolPersisted
            out = {
              written: true,
              scope: downgraded ? 'session' : scope,
              paths, toolName, rootSessionId, count: writeResult.count,
              ...(toolOnly && scope === 'project' ? { toolOnly: true, toolPersisted } : {}),
              ...(toolPersisted ? { toolRule: { cwd: writeResult.cwd ?? cwd, key: writeResult.key ?? null } } : {}),
              ...(useDeclared ? { pathsSource: 'user', dropped: declared.dropped } : {}),
            }
            break
          }
          default:
            return send(res, 404, { ok: false, error: 'not found: ' + pathname })
        }
        return send(res, 200, Object.assign({ ok: true }, out))
      }
      if (req.method === 'GET' && pathname === '/agent-api/active') {
        // 活动面板数据源：内存活跃子代理映射 + 最近结果流（活动页单独消费）
        // v0.9.32：childId 归一化（防对象形态炸 sessions.open）+ 透出 viaSquad/squadRunId（运行中按小队聚合）
        // v0.9.40：activeChildren 改 childId 主 key（同Agent并发步骤并存，不再互相覆盖）
        const active = [...dispatcher.activeChildren.entries()].map(([childIdKey, entry]) => {
          const agentId = entry?.agentId
          const agent = registry.get(agentId)
          const rawChild = entry?.childId ?? childIdKey
          const viaSquad = entry?.viaSquad ?? null
          const squad = viaSquad ? squadById().get(viaSquad) : null // v0.9.32：运行中按小队聚合展示需要小队名
          return {
            agentId,
            agentName: agent?.name ?? agentId,
            emoji: agent?.emoji ?? '',
            childId: typeof rawChild === 'string' ? rawChild : (rawChild && typeof rawChild === 'object' ? (rawChild.id ?? rawChild.childId ?? rawChild.runId ?? null) : null),
            taskLabel: entry?.taskLabel ?? '',
            startedAt: entry?.startedAt ?? null,
            parentSessionId: entry?.parentSessionId ?? null,
            // v1.11.3：远程产品会话尾号（产品侧 submit/permission 事件回传）——多候选归属排查用
            remoteSessionTail: entry?.remoteSessionId ? String(entry.remoteSessionId).slice(-8) : null,
            viaSquad,
            squadName: squad?.name ?? (viaSquad || null),
            squadEmoji: squad?.emoji ?? '',
            squadRunId: entry?.squadRunId ?? null,
            // v1.8.0：ACP 权限审批挂起中（主窗口「⏳ 待授权」徽标数据源）
            // v1.11.14(A)：改为按请求逐条。permissionPending 保留"最早未决那条"
            // 的旧对象形态（老 client 只认这个字段，行为等同改前），
            // permissionPendingList 是新 client 用来一请求渲染一行的全量数组。
            // v1.12.7：第二个实参把 `~` 展开基准（os.homedir()）透给浏览器半——
            // 琥珀球（ACP 通道）的弹框只能从这条轮询通道拿到 home（产品侧不透传）。
            ...permPending(entry?.permissionPending, os.homedir()),
          }
        })
        // v1.9.3：非本插件派遣子代理（product_delegate 等宿主 product 子代理）的
        // ACP 权限挂起 → 授权球合成条目（agentId 用 product 命名空间，决策端点按
        // childId 转发无归属限制，四按钮直接可用；行点击跳转需其会话在宿主目录中）
        for (const [childIdKey, records] of dispatcher.externalPending.entries()) {
          const rows = Array.isArray(records) ? records : [records] // 兼容旧结构（单对象）
          if (rows.length === 0) continue
          const p = rows[0]
          const childId = (p && p.childId) || childIdKey
          if (!childId || !p) continue
          if (active.some((a) => a.childId === childId)) continue
          active.push({
            agentId: p.product ? `product:${p.product}` : 'product',
            agentName: p.product ? `${p.product} 子代理` : 'product 子代理',
            emoji: '',
            childId,
            remoteSessionTail: p.remoteSessionId ? String(p.remoteSessionId).slice(-8) : null,
            taskLabel: String(p.description || '请求权限').slice(0, 80),
            startedAt: p.at ?? null,
            parentSessionId: p.parentSessionId ?? null,
            viaSquad: null,
            squadName: null,
            squadEmoji: '',
            squadRunId: null,
            permissionPending: null,
            ...permPending(rows, os.homedir()),
          })
        }
        return send(res, 200, { ok: true, active, recent: mergeDispatchHistory(readDispatches(20), new Set(active.map((a) => a.childId).filter(Boolean))) })
      }
      if (req.method === 'GET' && pathname === '/agent-api/suggest') {
        // $ 触发菜单候选：Agent + Agent 组队，前缀/子串匹配
        const q = String(query.get('q') || '').trim().toLowerCase()
        const agents = registry.list().filter((e) => e.enabled !== false)
        const squads = squadRegistry.list()
        const triggersOf = (e) => String(e.triggers || '').split(/[;；,，]/).map((s) => s.trim()).filter(Boolean)
        const stepsText = (steps) => {
          const layers = topoLayers(steps)
          return layers.map((l) => l.map((i) => steps[i].phase || steps[i].agentId).join('｜')).join(' → ')
        }
        const match = (item, fields) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q))
        const agentHits = agents
          .filter((e) => match(e, [e.id, e.name, ...triggersOf(e)]))
          .map((e) => ({ kind: 'agent', id: e.id, name: e.name, emoji: e.emoji, desc: triggersOf(e).slice(0, 3).join(';'), model: (e.routes && e.routes[0] && e.routes[0].model) || '' }))
        const squadHits = squads
          .filter((s) => s.enabled !== false) // v0.8.2：停用小队的 $ 菜单不再出现
          .filter((s) => match(s, [s.id, s.name, ...s.steps.map((st) => st.agentId)]))
          .map((s) => ({ kind: 'squad', id: s.id, name: s.name, emoji: s.emoji, desc: stepsText(s.steps) }))
        res.end(JSON.stringify({ ok: true, agents: agentHits, squads: squadHits }))
        return
      }
      if (req.method === 'GET' && pathname === '/agent-api/overview') {
        // 总览页聚合：Agent/组队规模、成功率、活跃、最近 8 条
        const agents = registry.list()
        const squads = squadRegistry.list()
        const recent = mergeDispatchHistory(readDispatches(50), activeChildIds())
        // v0.9.40：childId 主 key（同Agent并发并存）
        const active = [...dispatcher.activeChildren.entries()].map(([childIdKey, entry]) => {
          const rawChild = entry?.childId ?? childIdKey
          return { agentId: entry?.agentId, childId: typeof rawChild === 'string' ? rawChild : (rawChild && typeof rawChild === 'object' ? (rawChild.id ?? rawChild.childId ?? rawChild.runId ?? null) : null) }
        })
        // 成功率只统计结局已知的行（孤儿结局丢失，派遣行的 ok 只代表派遣成败，不计入）
        const settled = recent.filter((d) => !d.orphan)
        const okCount = settled.filter((d) => d.ok).length
        const byAgent = {}
        for (const d of settled) {
          const key = d.agentId || 'unknown'
          byAgent[key] = byAgent[key] || { agentId: d.agentId, agentName: d.agentName, emoji: d.emoji, total: 0, ok: 0, fail: 0 }
          byAgent[key].total += 1
          if (d.ok) byAgent[key].ok += 1
          else byAgent[key].fail += 1
        }
        const stats = {
          agentTotal: agents.length,
          agentEnabled: agents.filter((e) => e.enabled !== false).length,
          squadTotal: squads.length,
          dispatchTotal: settled.length,
          okCount,
          failCount: settled.length - okCount,
          activeCount: active.length,
          byAgent: Object.values(byAgent).sort((a, b) => b.total - a.total),
          last24h: recent.filter((d) => Date.now() - new Date(d.ts).getTime() < 864e5).length,
        }
        res.end(JSON.stringify({ ok: true, stats, recent: recent.slice(0, 8) }))
        return
      }
      if (req.method === 'GET' && pathname === '/agent-api/skills') {
        return send(res, 200, { ok: true, skills: listSkills(defaultSkillsRoot()) })
      }
      // v1.10.0：宿主审批上下文查询（服务端重取路径，不信任客户端）
      // ?callId=xxx&sessionId=xxx → {toolName, paths, reason, cwd}
      if (req.method === 'GET' && pathname === '/agent-api/host-approval-context') {
        const callId = query.get('callId')
        const sid = query.get('sessionId')
        if (!callId && !sid) return send(res, 400, { ok: false, error: '需要 callId 或 sessionId' })
        // 优先从暂存取（approval/request handler 已解析）——GET 仅窥视不消费，
        // 让后续 POST host-approval-rule 仍能 pop 到同一上下文（v1.10.1 修复）
        let approvalCtx = callId ? hostApproval.peekPendingContext(callId) : null
        if (!approvalCtx) {
          approvalCtx = {
            toolName: null, paths: [], structuredPaths: [], inferredPaths: [],
            reason: null, cwd: null, callId: callId || null, callFound: false, rootSessionId: null,
            // v1.12.7：`~` 展开基准照常下发——没有暂存上下文时客户端仍可能拿到
            // `~/.ssh/id_rsa` 这类候选路径，缺了它整行会退回「不勾选 + 警示」。
            home: os.homedir(),
          }
        }
        return send(res, 200, { ok: true, ...approvalCtx })
      }
      send(res, 405, { ok: false, error: 'method not allowed' })
    } catch (e) {
      send(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
  }

  let restStopped = false
  const tryRegisterRest = () => {
    if (restStopped) return
    const ws = ctx.get('webServer') || ctx.get('httpServer')
    if (!ws || typeof ws.register !== 'function') return // 未就绪，等下一轮
    try {
      const routeDispose = ws.register({ kind: 'prefix', path: '/agent-api', handler: restHandler })
      restStopped = true
      clearInterval(restTimer)
      ctx.effect(() => () => {
        try {
          routeDispose()
        } catch {
          /* ignore */
        }
      })
    } catch {
      // 注册失败等下一轮
    }
  }
  const restTimer = setInterval(tryRegisterRest, 500)
  restTimer.unref?.()

  return () => {
    restStopped = true
    clearInterval(restTimer)
    for (const dispose of toolDisposers) dispose?.()
    disposeRoutesSection?.()
    disposeRosterSection?.()
    disposeEndListener?.()
    disposeSessionListener?.()
    disposeSubmitFailedListener?.()
    disposeSubmitOkListener?.()
    disposePermPendingListener?.()
    disposePermResolvedListener?.()
    disposeUnknownPermListener?.()
    disposeConfigErrorListener?.()
    disposeCatalogListener?.()
    disposeHostApprovalListener?.()
    // v1.5.0：清空复用池定时器（驻留子代理的回收由宿主在插件 scope teardown 统一处理）
    try { dispatcher.dispose() } catch { /* ignore */ }
  }
}
