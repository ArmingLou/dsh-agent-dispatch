// dsh-agent-dispatch — 小队模板（v0.3）。
//
// 预置小队 = 专家编排配方：一条目标按模板拆成多个专家委派 + 汇总。
// 模板只描述结构（阶段、专家、依赖），执行靠两条路径：
//   A. 模型侧：prompt section 指引主 agent 用 workflow 工具编排
//      expert_dispatch（宿主原生 DAG 能力，适合复杂依赖）；
//   B. 工具侧：expert_squad 工具按模板展开为多个 expert_dispatch
//      （简单固定编排，无复杂依赖时最省事）。
//
// 模板结构（SquadTemplate）：
//   id/name/description（中文）、steps[]：
//   { expertId, phase, dependsOn: [stepIdx], instruction }
//   — dependsOn 空数组 = 首批并行；否则等前置 step 完成后执行
//   — instruction 是给该专家的任务模板，{input} 占位符替换用户目标，
//     {prev:N} 替换第 N 步结果摘要

/**
 * 内置小队模板。
 */
export const DEFAULT_SQUADS = [
  {
    id: 'dev-pipeline',
    name: '开发小队',
    emoji: '',
    description: '需求分析 → 代码审查 串行流水线：先提炼需求要点，再按要点做审查对照',
    steps: [
      {
        expertId: 'requirement-analyst',
        phase: '分析',
        dependsOn: [],
        instruction: '{input}',
      },
      {
        expertId: 'code-reviewer',
        phase: '审查',
        dependsOn: [0],
        instruction: '{input}\n\n【前置分析结论】\n{prev:0}\n\n请对照上述分析要点进行审查。',
      },
    ],
  },
  {
    id: 'debug-squad',
    name: '排查小队',
    emoji: '',
    description: '三路并行排查（日志/数据/代码），汇总定位根因',
    steps: [
      {
        expertId: 'log-tracer',
        phase: '日志',
        dependsOn: [],
        instruction: '{input}',
      },
      {
        expertId: 'sql-analyst',
        phase: '数据',
        dependsOn: [],
        instruction: '围绕以下问题做数据侧核查（表结构/数据状态/一致性）：\n{input}',
      },
      {
        expertId: 'code-reviewer',
        phase: '代码',
        dependsOn: [],
        instruction: '从代码实现角度审查以下问题可能涉及的逻辑缺陷：\n{input}',
      },
    ],
  },
  {
    id: 'review-squad',
    name: '多维审查小队',
    emoji: '',
    description: '代码审查员 + SQL 分析师双路并行，业务与数据两维对照',
    steps: [
      {
        expertId: 'code-reviewer',
        phase: '业务',
        dependsOn: [],
        instruction: '{input}',
      },
      {
        expertId: 'sql-analyst',
        phase: '数据',
        dependsOn: [],
        instruction: '从数据模型/SQL/数据一致性角度审查：\n{input}',
      },
    ],
  },
]

/**
 * 展开模板步骤的任务文本：替换 {input} 与 {prev:N} 占位符。
 *
 * @param {string} instruction 模板指令
 * @param {string} input       用户目标全文
 * @param {string[]} prevResults 各前置步骤的结果文本（按下标）
 * @returns {string}
 */
export function renderInstruction(instruction, input, prevResults = []) {
  return instruction
    .replaceAll('{input}', input)
    .replace(/\{prev:(\d+)\}/g, (_m, idx) => {
      const i = Number(idx)
      return prevResults[i] ?? '（该前置步骤无结果）'
    })
}

/**
 * 求解步骤执行顺序（拓扑分层；有环抛错）。
 *
 * @param {Array<{dependsOn: number[]}>} steps
 * @returns {number[][]} 分层下标数组，每层内并行
 */
export function topoLayers(steps) {
  const done = new Set()
  const layers = []
  while (done.size < steps.length) {
    const layer = []
    for (let i = 0; i < steps.length; i++) {
      if (done.has(i)) continue
      const deps = steps[i].dependsOn
      // 依赖必须是数组（字符串/数字等形状错误给出可定位的错误，而不是 TypeError）
      if (deps !== undefined && deps !== null && !Array.isArray(deps)) {
        throw new Error(`小队模板步骤 ${i + 1} 的 dependsOn 必须是数组（步骤下标）`)
      }
      const list = deps ?? []
      // 下标越界/负数/自指单独报错，不误报为环
      for (const d of list) {
        if (!Number.isInteger(d) || d < 0 || d >= steps.length) {
          throw new Error(`小队模板步骤 ${i + 1} 依赖了越界下标 ${JSON.stringify(d)}（有效范围 0..${steps.length - 1}）`)
        }
        if (d === i) {
          throw new Error(`小队模板步骤 ${i + 1} 依赖了自己`)
        }
      }
      if (list.every((d) => done.has(d))) layer.push(i)
    }
    if (layer.length === 0) throw new Error('小队模板存在依赖环（循环依赖无法分层）')
    for (const i of layer) done.add(i)
    layers.push(layer)
  }
  return layers
}
