import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTaskForDedup, dedupKey } from '../lib/dispatch.js'

describe('normalizeTaskForDedup', () => {
  it('passes through plain text unchanged', () => {
    const task = '实现用户登录功能'
    assert.equal(normalizeTaskForDedup(task), task)
  })

  it('strips single 【前情提示】prefix block', () => {
    const raw = '【前情提示】此任务此前尝试由 deveco 执行，失败。请以全新会话执行。\n\n实现用户登录功能'
    assert.equal(normalizeTaskForDedup(raw), '实现用户登录功能')
  })

  it('strips 【全新会话执行指令】prefix block', () => {
    const raw = '【全新会话执行指令】请重新执行本任务。\n\n实现用户登录功能'
    assert.equal(normalizeTaskForDedup(raw), '实现用户登录功能')
  })

  it('strips multiple prefix blocks', () => {
    const raw = '【前情提示】deveco 失败。\n\n【全新会话执行指令】请重新执行。\n\n实现用户登录功能'
    assert.equal(normalizeTaskForDedup(raw), '实现用户登录功能')
  })

  it('handles prefix with no trailing blank line', () => {
    const raw = '【前情提示】deveco 失败。请以全新会话执行。\n实现用户登录功能'
    assert.equal(normalizeTaskForDedup(raw), '实现用户登录功能')
  })

  it('returns empty string for empty input', () => {
    assert.equal(normalizeTaskForDedup(''), '')
  })

  it('returns empty string for prefix-only input', () => {
    assert.equal(normalizeTaskForDedup('【前情提示】只有前缀'), '')
  })

  it('does not strip mid-text 【…】markers', () => {
    const task = '实现用户登录功能【注意】需要 OAuth'
    assert.equal(normalizeTaskForDedup(task), task)
  })

  it('handles task text from buildTaskText wrapper', () => {
    const original = '修复导航栏样式问题'
    const raw = '【前情提示】此任务此前尝试由 deveco（ACP 产品）执行，执行失败。请以全新会话执行本任务。\n\n【任务】\n' + original + '\n\n【输出要求】\n完成后输出结构化结论。'
    const norm = normalizeTaskForDedup(raw)
    assert.ok(norm.includes('修复导航栏样式问题'), `normalized should contain original task: ${norm}`)
    assert.ok(!norm.startsWith('【前情提示】'), `normalized should not start with prefix: ${norm}`)
  })
})

describe('dedupKey', () => {
  it('produces same key for original and prefixed task', () => {
    const agentId = 'explorer'
    const original = '实现用户登录功能'
    const prefixed = '【前情提示】deveco 失败。请以全新会话执行。\n\n实现用户登录功能'
    assert.equal(dedupKey(agentId, original), dedupKey(agentId, prefixed))
  })

  it('produces different keys for different tasks', () => {
    const agentId = 'explorer'
    assert.notEqual(dedupKey(agentId, '任务A'), dedupKey(agentId, '任务B'))
  })

  it('produces different keys for same task different agent', () => {
    assert.notEqual(dedupKey('agent-a', '任务'), dedupKey('agent-b', '任务'))
  })

  it('produces same key for triple-retry text', () => {
    const agentId = 'explorer'
    const original = '修复导航栏样式'
    const retry1 = '【前情提示】deveco 失败。请以全新会话执行。\n\n修复导航栏样式'
    const retry2 = '【前情提示】opencode 失败。请以全新会话执行。\n\n【全新会话执行指令】请重新执行。\n\n修复导航栏样式'
    assert.equal(dedupKey(agentId, original), dedupKey(agentId, retry1))
    assert.equal(dedupKey(agentId, original), dedupKey(agentId, retry2))
  })
})
