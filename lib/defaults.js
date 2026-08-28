/**
 * dsh-agent-dispatch —— Agent 默认定义
 *
 * 本文件不再预置任何内置 Agent。Agent 全部由用户自行创建：
 *   - 通过 Agent 调度面板「+ 新建 Agent」表单
 *   - 通过 agent_import_skill 工具从 ~/.dsh/skills/<name>/SKILL.md 导入
 *   - 直接编辑数据文件 $DSH_HOME/data/dsh-agent-dispatch/agents.json
 *
 * 每个 Agent 是一个可续聊的子 agent，创建时 systemPrompt 注入其系统提示词；
 * 主 agent 依据 triggers 描述做自动路由，把任务分派给匹配的 Agent。
 * routes 安装后由宿主配置填充（不在此写死 provider/model）。
 *
 * 纯 JavaScript ESM 模块，无外部依赖。
 */

export const DEFAULT_AGENTS = []

export const DEFAULT_CONFIG = {
  version: 1,
  defaultTrigger: 'smart',
}
