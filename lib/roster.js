/**
 * 实时花名册 prompt section 的渲染（纯函数，便于单测）。
 *
 * 为什么需要它：策略段（index.js 的 `dsh-agent-dispatch:policy`）是固定文案，而 Agent
 * 花名册随 agents.json 变化。历史上父级 prompt 里写死的角色枚举与注册表漂移——新增
 * final-reviewer 之后，父级仍按旧枚举路由，把「独立终审」派给了实现类角色。本模块让
 * 花名册从注册表**实时**渲染，从机制上消除这类漂移。
 *
 * 与 `agent_list` 的分工：本段是"出发前就能看到的地图"，agent_list 是"复核用的权威工具"。
 * 两者都从同一份注册表取值，因此不会互相矛盾。
 */

/** 触发词摘要的最大字符数，超出截断（避免单个 Agent 撑爆 prompt） */
const TRIGGER_MAX = 120

/** 渲染单个 Agent 为一行 */
function renderAgentRow(agent) {
  const raw = String(agent.triggers || '').replace(/\s+/g, ' ').trim()
  const trig = raw.length > TRIGGER_MAX ? `${raw.slice(0, TRIGGER_MAX)}…` : raw
  const route = (agent.routes || [])
    .map((r) => `${r.provider}${r.model ? `/${r.model}` : ''}${r.effort ? `@${r.effort}` : ''}`)
    .join(' → ')
  const reuse = agent.reusePolicy === 'fresh' ? 'fresh（每次新开）' : 'reuse（复用同角色）'
  const enabled = agent.enabled === false ? '｜**已禁用**' : ''
  return `- ${agent.id}（${agent.name}）｜${reuse}${enabled}｜触发词：${trig || '（未配置）'}${
    route ? `｜模型路由：${route}` : ''
  }`
}

/**
 * 渲染整段花名册。
 * @param {Array<object>} agents 注册表中的 Agent 数组（registry.list()）
 * @returns {string} prompt section 正文
 */
export function renderRoster(agents) {
  const list = Array.isArray(agents) ? agents : []
  const rows = list.filter((a) => a && a.enabled !== false).map(renderAgentRow)

  const head = [
    '当前注册的 Agent 花名册（**实时**渲染自 agents.json，是路由的唯一权威来源）：',
  ]
  if (rows.length === 0) {
    head.push('- （当前没有启用中的 Agent）')
  } else {
    head.push(...rows)
  }
  head.push(
    '路由方式：按上表触发词匹配；不确定时调 agent_list 复核。**上表未出现的角色不要凭记忆、也不要凭本 prompt 其它段落里的角色列举去推断**——那些文字不会随注册表更新。',
  )
  head.push(
    '硬性例外（覆盖触发词匹配）：独立审查 / 对抗性审查 / 交付终审 / 验收复核类任务，一律派给**只读且每次新开**的审核角色（如 final-reviewer），绝不让实现类角色自审自己的产出。',
  )
  return head.join('\n')
}
