// @kiligzzz/dsh-agent-dispatch — host half.
//
// 预置Agent agent + 自动路由 + 小队编排插件的宿主半。
//
// 职责：
//   - Agent 注册表（$DSH_HOME/data/dsh-agent-dispatch/agents.json，改完即生效）
//   - 五个模型工具：agent_dispatch / agent_followup / agent_list /
//     agent_squad / agent_import_skill
//   - systemPrompt 路由表 section（引导主 agent 按任务领域自动委派）
//   - /agent-api REST 面（v1.0：主面板 + 总览页 + 悬浮球全数据通道）
//
// 委派走 ctx.subagents.startContinuable（宿主原生可续聊子代理），
// persona 注入Agent系统提示词，agentOptions 按Agent routes 做模型路由
// 与失败互备。零 @deepseek-ai/dsh-tools 依赖（规避官方双实例 bug
// #1697/#783），工具注册用 ctx.tools.register 裸对象最小形状。
//
// 以 profile bundle 行挂载（cordis.patch.yml + dsh.bundle.patch）。
// 浏览器半（lib/client.js）注册主面板到宿主 conversation.view 槽，
// + 会话头部返回按钮 + / 触发器 Agent 候选菜单 + 悬浮活动球，
// 统统走同源 fetch 调 /agent-api/*。

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { AgentRegistry } from './lib/agents.js'
import { Dispatcher } from './lib/dispatch.js'
import { DEFAULT_SQUADS, renderInstruction, topoLayers } from './lib/squads.js'
import { SquadRegistry } from './lib/squad-registry.js'
import { listSkills, skillToAgent, defaultSkillsRoot } from './lib/skill-import.js'

export const name = '@kiligzzz/dsh-agent-dispatch'

export const inject = ['tools', 'subagents', 'systemPrompt']

export function apply(ctx) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dataDir = path.join(dshHome, 'data', 'dsh-agent-dispatch')

  // ── 注册表与派遣器 ──
  const registry = new AgentRegistry(dataDir)
  const dispatcher = new Dispatcher({ ctx, registry, dataDir })

  // v1.4.1 执行级递归护栏：harness 把 report/subagent 等工具注册进【子代理自身 scope】，
  // 而 toolFilter 的 allow/deny 只过滤"继承面"，刻意豁免子代理 own-layer 的工具
  // （view() 里 "must not strip the machinery it answers through"）。因此仅靠 deny 名单
  // 去不掉 subagent/subagent_fork/report。这里用 tools.guard 在【执行时】拒绝子代理调用任何
  // "再起新代理 / 管理委派树"的工具；保留 product_submit（ACP 中继转发任务）与 report（子代理回传结果）。
  // 注：registerContinuableSetup 对宿主所有可续聊子代理生效，实现"子代理一律不得再委派"。
  const noDelegateTools = new Set([
    'agent_dispatch', 'agent_followup', 'agent_list', 'agent_squad', 'agent_squad_continue',
    'agent_squad_upsert', 'agent_upsert', 'agent_import_skill',
    'subagent', 'subagent_fork', 'subagent_progress', 'list_agents', 'interrupt_agent', 'send_message',
    'product_delegate', 'product_wait', 'product_roles',
    'workflow', 'ralph', 'create_goal', 'get_goal', 'update_goal',
  ])
  ctx.subagents.registerContinuableSetup((childCtx) => {
    try {
      return childCtx.tools.guard((exec) => {
        if (noDelegateTools.has(exec.name)) {
          return `[dsh-agent-dispatch] 子代理禁止再向下委派/另起代理：${exec.name} 已禁用，必须自己完成任务；超出能力时明确说明卡在哪，并向上（父级）汇报。`
        }
        return undefined
      })
    } catch (err) {
      // 个别 scope 无 tools 服务等异常不阻断子代理启动
      return undefined
    }
  })

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

  // agent_dispatch：把任务委派给Agent（建/复用可续聊子 agent）
  toolDisposers.push(ctx.tools.register({
    name: 'agent_dispatch',
    description:
      'Dispatch a task to a pre-configured agent agent (a continuable subagent with a fixed agent persona, its own context, and its own model route). Use this when the task falls in an agent\'s domain — requirement analysis, code review, production debugging, SQL analysis. The agent conversation persists, so a later agent_followup on the same agent continues with full context. Dispatch returns immediately with a durable child id; the result arrives as a subagent notice when the agent finishes.',
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
      return dispatcher.dispatch(parent, args.agentId, args.task)
    },
  }))

  // agent_followup：对已存在的Agent追问（上下文延续）
  toolDisposers.push(ctx.tools.register({
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

  // agent_list：列出Agent目录（供主 agent 路由判断）
  toolDisposers.push(ctx.tools.register({
    name: 'agent_list',
    description:
      'List the configured agent agents with their ids, names, trigger domains, and model routes. Call this before agent_dispatch when unsure which agent fits, or when the user asks what agents exist.',
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
            .map((e) => `${e.emoji ?? ''}${e.name}（${e.id}）· 适用: ${e.triggers}${e.enabled ? '' : ' · 已停用'}${e.routes?.length ? ' · 模型: ' + e.routes.join(' → ') : ''}`)
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
          routes: (e.routes || []).map((r) => `${r.provider}/${r.model}`),
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
  toolDisposers.push(ctx.tools.register({
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
  toolDisposers.push(ctx.tools.register({
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
  toolDisposers.push(ctx.tools.register({
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
      await registry.upsert(agent)
      return { action: 'import', agent: { id: agent.id, name: agent.name, warnings } }
    },
  }))

  // agent_upsert：新增/更新单个 Agent（与 GUI 编辑保存同一条 registry.upsert 逻辑，立即生效免重启）。
  // v1.2.0：暴露给主 agent，改 Agent（含 systemPrompt）无需重启 Desktop、无需点 GUI。
  toolDisposers.push(ctx.tools.register({
    name: 'agent_upsert',
    description:
      'Create or update a single agent agent in the dsh-agent-dispatch registry. This is the same write path as the GUI edit-and-save (registry.upsert: in-memory + atomic disk write), so changes take effect immediately without restarting DSH. Use this to fix or adjust an agent\'s persona/systemPrompt, triggers, name, or model routes. The agent keeps its position if it already exists, otherwise it is appended.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Agent id (kebab-case, lowercase letters/digits, hyphen-separated segments).' },
        name: { type: 'string', description: 'Display name (non-empty).' },
        systemPrompt: { type: 'string', description: 'The full agent persona / system prompt (non-empty).' },
        emoji: { type: 'string', description: 'Optional single emoji shown in lists.' },
        triggers: { type: 'string', description: 'Optional trigger-domain description used by agent_list routing.' },
        routes: {
          type: 'array',
          description: 'Optional model routes; each item {provider, model, effort?}.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
              effort: { type: 'string' },
            },
            required: ['provider', 'model'],
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
        routes: args.routes || [],
        enabled: args.enabled !== false,
      }
      const normalized = await registry.upsert(agent)
      return { ok: true, id: normalized.id, name: normalized.name }
    },
  }))

  // agent_squad_upsert：新增/更新单个小队（与 GUI 小队编辑保存同一条 squadRegistry.upsert 逻辑，立即生效免重启）。
  // v1.3.0：暴露给主 agent 免重启改小队（含 checkpoint 字段）；GUI 表单同步加 checkpoint 开关后两条路径等价。
  toolDisposers.push(ctx.tools.register({
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
      '1. 任务命中某 Agent 领域（需求分析/代码审查/线上排查/SQL 分析等，以 agent_list 返回的 triggers 为准）时，优先用 agent_dispatch 委派，而不是自己在主对话里做。',
      '2. 委派任务必须是自包含的：Agent 看不到本会话，把所需上下文（路径/代码/日志/约束）全部写进 task。',
      '3. 对同一 Agent 的后续追问用 agent_followup（带 childId），上下文延续。',
      '4. 简单问题（一句话能答、无需工具链）不必委派，直接回答——委派本身有开销。',
      '5. 不确定哪个 Agent 合适时先 agent_list。',
      '6. 多角度或流水线目标（既要分析又要审查、多路排查同一问题）用 agent_squad：dev-pipeline=需求→审查串行；debug-squad=日志/数据/代码三路并行；review-squad=业务/数据双路。单领域任务不要用组队。带 checkpoint 的小队（如 kiligz-workflow）会在 checkpoint 步骤后返回 paused:true，必须停下等用户确认，用户反馈经 agent_squad_continue（squadRunId + note）续跑，禁止未确认就自动续跑。停等时：①若阶段有产出文档（prd.md/飞书技术方案链接等），把完整路径/链接展示给用户；②若阶段有「待确认问题清单」，逐条列出请用户作答，用户回答前不得续跑。',
      '7. 复杂动态编排（组队模板不匹配、需要按中间结果决定下一步）时，用宿主 workflow 工具编排 agent_dispatch。',
      '8. 用户消息以「$<id> 」前缀开头时（如 "$sql-analyst 查下 orders 慢查询"），这是用户显式指定：把后续文本作为 task 直接 agent_dispatch 给该 id 的 Agent（组队 id 用 agent_squad），不要追问、不要改派。$ 前缀来自输入框 / 菜单选 Agent 的插入（或用户手打），是用户的明确意图。',
      '9. 修改 Agent 用 agent_upsert、修改小队（含各步骤 checkpoint 停等开关）用 agent_squad_upsert，均免重启立即生效。',
    ].join('\n'),
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
  const readDefaultModel = () => {
    try {
      const settings = ctx.get('settings')
      const d = settings?.get?.('agent-default-model') ?? settings?.get?.('default-model')
      if (d && typeof d === 'object') return d
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
        return send(res, 200, {
          ok: true,
          dataDir: tildify(dataDir),
          agents: registry.list(),
          models: await readModelOptions(),
          defaultModel: readDefaultModel(),
        })
      }
      if (req.method === 'GET' && pathname === '/agent-api/dispatches') {
        return send(res, 200, { ok: true, dispatches: mergeDispatchHistory(readDispatches(query.get('limit')), activeChildIds()) })
      }
      if (req.method === 'GET' && pathname === '/agent-api/squads') {
        return send(res, 200, { ok: true, squads: squadRegistry.list() })
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
            await registry.upsert(body.agent)
            out = {}
            break
          case '/agent-api/remove':
            out = { removed: await registry.remove(body.id) }
            break
          case '/agent-api/toggle':
            out = { updated: await registry.setEnabled(body.id, body.enabled) }
            break
          case '/agent-api/import-skill': {
            const { agent, warnings } = skillToAgent(defaultSkillsRoot(), body.skillDir)
            await registry.upsert(agent)
            out = { agent: { id: agent.id, name: agent.name }, warnings }
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
            viaSquad,
            squadName: squad?.name ?? (viaSquad || null),
            squadEmoji: squad?.emoji ?? '',
            squadRunId: entry?.squadRunId ?? null,
          }
        })
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
  }
}
