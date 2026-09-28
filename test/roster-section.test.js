/**
 * 实时花名册 section 的单测（lib/roster.js）。
 *
 * 目标是锁住「花名册由注册表渲染、且不泄露注册表里没有的角色」这一契约——
 * 历史事故正是父级凭写死的角色枚举路由，把独立终审派给了实现类角色。
 *
 * 注意：规则文案里**故意**提到 final-reviewer（作为硬性例外的举例），
 * 因此负向断言一律按「行」判定，而不是对全文做子串断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { renderRoster } from '../lib/roster.js'

const senior = {
  id: 'senior-dev',
  name: '资深开发（中坚）',
  triggers: '常规重构；中等复杂实现；故障排查',
  routes: [{ provider: 'qoder', effort: 'xhigh' }],
  reusePolicy: 'reuse',
  enabled: true,
}
const reviewer = {
  id: 'final-reviewer',
  name: '交付终审（只读）',
  triggers: '独立审查；对抗性审查；交付终审',
  routes: [{ provider: 'deepseek-official', model: 'deepseek-flash', effort: 'max' }],
  reusePolicy: 'fresh',
  enabled: true,
}

/** 花名册的条目行（以 "- " 开头的行） */
const rows = (text) => text.split('\n').filter((l) => l.startsWith('- '))
/** 某 id 是否作为条目行出现 */
const hasRow = (text, id) => rows(text).some((l) => l.startsWith(`- ${id}（`))

test('空注册表：给出占位行且不抛', () => {
  for (const input of [[], null, undefined]) {
    const text = renderRoster(input)
    assert.match(text, /当前没有启用中的 Agent/)
    assert.doesNotMatch(text, /undefined/)
  }
})

test('正常渲染：id/name/reuse/触发词/模型路由都在', () => {
  const text = renderRoster([senior, reviewer])
  assert.ok(hasRow(text, 'senior-dev'), '应出现 senior-dev 条目行')
  assert.match(text, /- senior-dev（资深开发（中坚））/)
  assert.match(text, /reuse（复用同角色）/)
  assert.match(text, /fresh（每次新开）/)
  assert.match(text, /触发词：常规重构；中等复杂实现；故障排查/)
  assert.match(text, /模型路由：qoder@xhigh/)
  assert.match(text, /模型路由：deepseek-official\/deepseek-flash@max/)
})

test('禁用的 Agent 不出现在花名册条目里', () => {
  const text = renderRoster([senior, { ...reviewer, enabled: false }])
  assert.ok(hasRow(text, 'senior-dev'))
  assert.ok(!hasRow(text, 'final-reviewer'), '禁用者不应有条目行')
  assert.match(renderRoster([{ ...senior, enabled: false }]), /当前没有启用中的 Agent/)
})

test('触发词超长截断，且对多字节安全', () => {
  const text = renderRoster([{ ...senior, triggers: '排查；'.repeat(80) }])
  const line = rows(text).find((l) => l.startsWith('- senior-dev'))
  const trig = line.split('触发词：')[1].split('｜')[0]
  assert.ok(trig.endsWith('…'), `触发词应被截断，实际结尾：${trig.slice(-8)}`)
  assert.ok(trig.length <= 121, `截断后不应超过 120 字符 + 省略号，实际 ${trig.length}`)
  assert.doesNotMatch(line, /\uFFFD/)
})

test('触发词/模型路由缺失时不崩、给出可读占位', () => {
  const text = renderRoster([{ id: 'x', name: 'X', triggers: '', routes: [], reusePolicy: 'reuse' }])
  assert.match(text, /触发词：（未配置）/)
  assert.ok(!rows(text)[0].includes('模型路由：'))
})

test('两条路由规则文案存在（防漂移的关键约束）', () => {
  const text = renderRoster([senior])
  assert.match(text, /未出现的角色不要凭记忆/)
  assert.match(text, /只读且每次新开/)
})

test('无内部缓存：同数组内容变化后重新渲染必须反映（text 传函数依赖这一点）', () => {
  const reg = [senior]
  const before = renderRoster(reg)
  assert.ok(!hasRow(before, 'final-reviewer'))
  reg.push(reviewer)
  const after = renderRoster(reg)
  assert.ok(hasRow(after, 'final-reviewer'), '重新渲染必须看到新增角色')
  assert.notEqual(before, after)
})

test('负向：注册表里没有的 id 不得作为条目行出现', () => {
  const text = renderRoster([senior])
  for (const ghost of ['final-reviewer', 'architect', 'explorer', 'simple-dev']) {
    assert.ok(!hasRow(text, ghost), `不应出现条目行 ${ghost}`)
  }
  // 反向对照：给了 reviewer 就必须出现
  assert.ok(hasRow(renderRoster([senior, reviewer]), 'final-reviewer'))
})
