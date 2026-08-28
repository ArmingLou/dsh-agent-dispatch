// dsh-agent-dispatch — skill 导入工具（v0.4）。
//
// 把 ~/.dsh/skills/<name>/SKILL.md 一键注册为专家：
//   - frontmatter 的 name/description 进专家 id/name/triggers
//   - 正文（去掉 frontmatter）作为专家 systemPrompt
//   - routes 留空（继承父会话模型），用户可在 Settings 页或
//     experts.json 里补
//
// 只做提示词搬运，不搬 skill 的工具依赖：专家子代理全量继承主会话
// 工具（v0.1 已知限制），skill 若依赖专属 MCP，导入后依赖仍在主
// 会话工具面内即可用。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 解析 SKILL.md 的 frontmatter 与正文。 */
export function parseSkillFile(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return { frontmatter: {}, body: text.trim() }
  const fmText = m[1]
  const body = text.slice(m[0].length).trim()
  const frontmatter = {}
  for (const line of fmText.split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (kv) frontmatter[kv[1]] = kv[2].trim()
  }
  return { frontmatter, body }
}

/** 列出 skills 目录下可导入的 skill（存在 SKILL.md 的目录；软链跟随）。 */
export function listSkills(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return []
  const out = []
  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue
    // skills 目录大量为软链（my-team-skill 等同步机制），跟随判定：
    // 目录或指向目录的软链都算；stats 用 statSync（跟随软链）。
    const abs = path.join(skillsRoot, entry.name)
    let isDir = false
    try {
      isDir = fs.statSync(abs).isDirectory()
    } catch {
      continue
    }
    if (!isDir) continue
    const skillPath = path.join(abs, 'SKILL.md')
    if (!fs.existsSync(skillPath)) continue
    try {
      const { frontmatter } = parseSkillFile(fs.readFileSync(skillPath, 'utf8'))
      out.push({
        name: frontmatter.name || entry.name,
        dir: entry.name,
        description: (frontmatter.description || '').slice(0, 160),
        disabled: frontmatter['disable-model-invocation'] === 'true',
      })
    } catch {
      // 单个坏文件跳过
    }
  }
  return out
}

/**
 * 把一个 skill 转成专家定义（不落盘；由 registry.upsert 持久化）。
 *
 * @param {string} skillsRoot skills 根目录
 * @param {string} skillDir   skill 目录名
 * @returns {{expert: object, warnings: string[]}}
 */
export function skillToExpert(skillsRoot, skillDir) {
  const skillPath = path.join(skillsRoot, skillDir, 'SKILL.md')
  if (!fs.existsSync(skillPath)) throw new Error(`skill 不存在: ${skillPath}`)
  const { frontmatter, body } = parseSkillFile(fs.readFileSync(skillPath, 'utf8'))
  if (!body.trim()) throw new Error(`skill ${skillDir} 正文为空，不适合作为专家提示词`)
  const id = skillDir.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error(`skill ${skillDir} 转换后 id 不合法: ${id}`)
  const warnings = []
  const name = frontmatter.name || skillDir
  const triggers = (frontmatter.description || frontmatter.whenToUse || `由 skill ${skillDir} 导入`).slice(0, 200)
  if (!frontmatter.description) warnings.push('skill 缺 description，triggers 用了 fallback 文案')
  const systemPrompt = [
    '你是一位被委派的专家子代理，收到的是完整独立任务描述。',
    '',
    body,
  ].join('\n')
  return {
    expert: { id, name, emoji: '📥', triggers, systemPrompt, routes: [], enabled: true },
    warnings,
  }
}

/** skills 根目录：优先 $DSH_HOME/skills，回退真实用户 ~/.dsh/skills（skill 与注册表数据目录解耦）。 */
export function defaultSkillsRoot() {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const primary = path.join(dshHome, 'skills')
  if (fs.existsSync(primary)) return primary
  return path.join(os.homedir(), '.dsh', 'skills')
}
