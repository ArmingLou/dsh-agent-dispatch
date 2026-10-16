/**
 * v1.12.18：Agent Preset 字段（注册表侧）回归。
 *
 * 背景：宿主 0.2.1-alpha.3 移除了 SubagentStartRequest 的 persona / toolFilter，
 * 工具面收窄只能走 agentPreset（单个字符串 id）。本文件只测**注册表字段行为**：
 *   - normalizeAgent：缺失 / 空串 / 非字符串都不落键（与 routes 的「不指定」同口径）；
 *   - validateAgent：非字符串 / 空串响亮拒绝（写路径门禁）；
 *   - needsNormalize：能识别 agentPreset 的偏离；
 *   - init()：含已失效字段（persona / toolFilter）时只告警、**不回写磁盘**。
 *
 * 刻意不测 preset 白名单校验——那需要宿主 agentPresets 服务，注册表不该依赖宿主服务；
 * 合法 id 由 GUI 只从枚举里选来保证，未知 id 由宿主派发期自己 loud throw
 *（dsh-agent-preset-registry/lib/index.js:636 `Unknown agent preset: X`）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentRegistry, normalizeAgent, needsNormalize } from '../lib/agents.js'
import { boot } from './agent-api-harness.js'

/** 建一个临时注册表（不污染真实数据目录） */
async function freshRegistry(seedAgents) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dad-preset-'))
  const dataDir = path.join(dir, 'data', 'dsh-agent-dispatch')
  if (seedAgents) {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(path.join(dataDir, 'agents.json'), JSON.stringify({ version: 1, config: {}, agents: seedAgents }, null, 2), 'utf8')
  }
  const reg = new AgentRegistry(dataDir)
  await reg.init()
  return { reg, dir, dataDir }
}

const base = { id: 'a-one', name: 'A', systemPrompt: 'p', routes: [] }

describe('normalizeAgent：agentPreset 的「不指定」不落键', () => {
  it('缺失 / 空串 / 纯空白 / 非字符串 ⇒ 都不落键', () => {
    assert.equal('agentPreset' in normalizeAgent(base), false, '缺失不落键')
    assert.equal('agentPreset' in normalizeAgent({ ...base, agentPreset: '' }), false, '空串不落键')
    assert.equal('agentPreset' in normalizeAgent({ ...base, agentPreset: '   ' }), false, '纯空白不落键')
    assert.equal('agentPreset' in normalizeAgent({ ...base, agentPreset: 123 }), false, '数字不落键（读盘不抛错）')
    assert.equal('agentPreset' in normalizeAgent({ ...base, agentPreset: null }), false, 'null 不落键')
    assert.equal('agentPreset' in normalizeAgent({ ...base, agentPreset: {} }), false, '对象不落键')
    assert.equal('agentPreset' in normalizeAgent({ ...base, agentPreset: ['x'] }), false, '数组不落键')
  })

  it('正常字符串被 trim 后保留', () => {
    assert.equal(normalizeAgent({ ...base, agentPreset: 'explorer' }).agentPreset, 'explorer')
    assert.equal(normalizeAgent({ ...base, agentPreset: '  explorer  ' }).agentPreset, 'explorer', '两侧空白被 trim')
  })

  it('「不指定」的存储对象与省略该字段完全一致（手写文件 == GUI 空选项）', () => {
    assert.deepEqual(normalizeAgent({ ...base, agentPreset: '' }), normalizeAgent(base))
  })
})

describe('validateAgent：agentPreset 的写路径门禁', () => {
  it('非字符串 / 空串 / 纯空白 / null 都抛错', async () => {
    const cases = [123, true, {}, [], '', '   ', null]
    for (const bad of cases) {
      const { reg, dir } = await freshRegistry()
      try {
        await assert.rejects(
          () => reg.upsert({ ...base, agentPreset: bad }),
          /agentPreset 必须为非空字符串/,
          `agentPreset=${JSON.stringify(bad)} 应被拒绝`,
        )
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('省略该字段合法（不指定），正常字符串合法并落盘', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      const a = await reg.upsert({ ...base, id: 'no-preset' })
      assert.equal('agentPreset' in a, false, '省略 ⇒ 不落键')

      const b = await reg.upsert({ ...base, id: 'with-preset', agentPreset: ' explorer ' })
      assert.equal(b.agentPreset, 'explorer')

      const onDisk = JSON.parse(readFileSync(path.join(dir, 'data', 'dsh-agent-dispatch', 'agents.json'), 'utf8'))
      const byId = new Map(onDisk.agents.map((x) => [x.id, x]))
      assert.equal('agentPreset' in byId.get('no-preset'), false)
      assert.equal(byId.get('with-preset').agentPreset, 'explorer')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('校验失败不落盘（原有 agents.json 不被改动）', async () => {
    const { reg, dir, dataDir } = await freshRegistry([{ ...base, id: 'keep' }])
    try {
      const before = readFileSync(path.join(dataDir, 'agents.json'), 'utf8')
      await assert.rejects(() => reg.upsert({ ...base, id: 'bad', agentPreset: '' }), /agentPreset/)
      assert.equal(readFileSync(path.join(dataDir, 'agents.json'), 'utf8'), before, '门禁失败不得写盘')
      assert.equal(reg.get('bad'), undefined, '内存也不得写入')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('needsNormalize：识别 agentPreset 的偏离', () => {
  const ok = { id: 'a', name: 'n', emoji: '', triggers: '', systemPrompt: 's', routes: [], reusePolicy: 'reuse', enabled: true }

  it('形状完好的条目（含/不含 agentPreset）都不视为偏离', () => {
    assert.equal(needsNormalize(ok), false, '完全省略 agentPreset')
    assert.equal(needsNormalize({ ...ok, agentPreset: 'explorer' }), false, '正常字符串')
  })

  it('空串 / 纯空白 / 非字符串 / 未 trim 都视为偏离', () => {
    assert.equal(needsNormalize({ ...ok, agentPreset: '' }), true, '空串会被归一化抹掉')
    assert.equal(needsNormalize({ ...ok, agentPreset: '  ' }), true, '纯空白会被抹掉')
    assert.equal(needsNormalize({ ...ok, agentPreset: 123 }), true, '非字符串会被抹掉')
    assert.equal(needsNormalize({ ...ok, agentPreset: null }), true, 'null 会被抹掉')
    assert.equal(needsNormalize({ ...ok, agentPreset: ' explorer ' }), true, '未 trim 会被改写')
  })
})

/**
 * v1.12.19：acpPreset（ACP 档 preset）注册表层回归。
 *
 * 与 agentPreset 的关系：两者**同口径**（validate 放行/拒绝、normalize 落键与否、
 * needsNormalize 偏离判定完全一致），但**语义不同**——acpPreset 只在该 Agent 走
 * ACP 档（中继）时生效，LLM/spawn 档仍用 agentPreset。逐档取值由派发期完成
 * （见 test/acp-preset-per-route.test.js）；本组只锁注册表层这四道口径，
 * 确保「配置了 acpPreset 却因注册表丢字段而不生效」这类问题有直连单测兜底。
 */
describe('acpPreset（v1.12.19）：注册表层四口径', () => {
  it('① validateAgent：合法非空串 / 省略该字段 ⇒ 不抛', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      const a = await reg.upsert({ ...base, id: 'acp-ok', acpPreset: 'acp-relay' })
      assert.equal(a.acpPreset, 'acp-relay', '合法非空字符串被接受')

      const b = await reg.upsert({ ...base, id: 'acp-absent' })
      assert.equal('acpPreset' in b, false, '未提供该字段 ⇒ 不抛且不落键（缺省不设的正常形态）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('① validateAgent：空串 / 纯空白 / 非字符串 ⇒ 响亮抛错且点名 agent id 与字段', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      for (const bad of ['', '   ', null, 123, {}]) {
        const err = await reg.upsert({ ...base, id: 'acp-bad', acpPreset: bad }).then(
          () => null,
          (e) => e,
        )
        assert.ok(err instanceof Error, `acpPreset=${JSON.stringify(bad)} 应被响亮拒绝`)
        assert.match(err.message, /acp-bad/, '错误信息点名该 agent id')
        assert.match(err.message, /acpPreset 必须为非空字符串/, '错误信息点名 acpPreset 字段')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('① validateAgent：校验失败不落盘（内存与磁盘都不写入）', async () => {
    const { reg, dir, dataDir } = await freshRegistry([{ ...base, id: 'keep' }])
    try {
      const before = readFileSync(path.join(dataDir, 'agents.json'), 'utf8')
      await assert.rejects(() => reg.upsert({ ...base, id: 'bad', acpPreset: '' }), /acpPreset/)
      assert.equal(readFileSync(path.join(dataDir, 'agents.json'), 'utf8'), before, '门禁失败不得写盘')
      assert.equal(reg.get('bad'), undefined, '内存也不得写入')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('② normalizeAgent：只配 acpPreset ⇒ 落键且 agentPreset 不落键；两档互不串键', () => {
    const onlyAcp = normalizeAgent({ ...base, acpPreset: 'acp-relay' })
    assert.equal(onlyAcp.acpPreset, 'acp-relay', 'acpPreset 归一化后落键')
    assert.equal('agentPreset' in onlyAcp, false, '只配 acpPreset 不得顺带落 agentPreset 键')

    const both = normalizeAgent({ ...base, agentPreset: 'explorer', acpPreset: 'acp-relay' })
    assert.equal(both.agentPreset, 'explorer', '两个都配 ⇒ agentPreset 为原值')
    assert.equal(both.acpPreset, 'acp-relay', '两个都配 ⇒ acpPreset 为原值')

    const neither = normalizeAgent(base)
    assert.equal('acpPreset' in neither, false, '两个都未配 ⇒ acpPreset 不出现')
    assert.equal('agentPreset' in neither, false, '两个都未配 ⇒ agentPreset 不出现')
  })

  it('② normalizeAgent：空串 / 纯空白 / 非字符串 ⇒ 不落键（读盘不抛错，与 validate 是不同层级）', () => {
    for (const bad of ['', '   ', 123, null, {}, ['x']]) {
      assert.equal('acpPreset' in normalizeAgent({ ...base, acpPreset: bad }), false, `acpPreset=${JSON.stringify(bad)} 不落键`)
    }
    // 「不指定」的存储对象与省略该字段完全一致（手写文件 == GUI 空选项）
    assert.deepEqual(normalizeAgent({ ...base, acpPreset: '' }), normalizeAgent(base))
    assert.equal(normalizeAgent({ ...base, acpPreset: '  acp-relay  ' }).acpPreset, 'acp-relay', '两侧空白被 trim')
  })

  it('③ 持久化往返：upsert ⇒ 落盘 JSON 含 acpPreset（已 trim）⇒ 重读后值仍在', async () => {
    const { reg, dir, dataDir } = await freshRegistry()
    try {
      await reg.upsert({ ...base, id: 'acp-round', acpPreset: ' acp-relay ' })

      const onDisk = JSON.parse(readFileSync(path.join(dataDir, 'agents.json'), 'utf8'))
      const byId = new Map(onDisk.agents.map((x) => [x.id, x]))
      assert.equal('acpPreset' in byId.get('acp-round'), true, '落盘 JSON 含 acpPreset 字段')
      assert.equal(byId.get('acp-round').acpPreset, 'acp-relay', '落盘即已 trim')

      const reg2 = new AgentRegistry(dataDir)
      await reg2.init()
      assert.equal(reg2.get('acp-round').acpPreset, 'acp-relay', '重读后值仍在（trim 后）')
      assert.equal('agentPreset' in reg2.get('acp-round'), false, '重读不凭空补出 agentPreset 键')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('④ needsNormalize：形状完好的条目（省略 / 单配 / 两档都配）都不视为偏离', () => {
    const ok = { id: 'a', name: 'n', emoji: '', triggers: '', systemPrompt: 's', routes: [], reusePolicy: 'reuse', enabled: true }
    assert.equal(needsNormalize(ok), false, '完全省略 acpPreset')
    assert.equal(needsNormalize({ ...ok, acpPreset: 'acp-relay' }), false, '合法非空字符串且无首尾空白')
    assert.equal(needsNormalize({ ...ok, agentPreset: 'explorer', acpPreset: 'acp-relay' }), false, '两档各自合法 ⇒ 仍不算偏离')
  })

  it('④ needsNormalize：null / 空串 / 纯空白 / 非字符串 / 未 trim ⇒ 判为需规整', () => {
    const ok = { id: 'a', name: 'n', emoji: '', triggers: '', systemPrompt: 's', routes: [], reusePolicy: 'reuse', enabled: true }
    assert.equal(needsNormalize({ ...ok, acpPreset: null }), true, 'null 会被归一化抹掉')
    assert.equal(needsNormalize({ ...ok, acpPreset: '' }), true, '空串会被抹掉')
    assert.equal(needsNormalize({ ...ok, acpPreset: '   ' }), true, '纯空白会被抹掉')
    assert.equal(needsNormalize({ ...ok, acpPreset: 123 }), true, '非字符串会被抹掉')
    assert.equal(needsNormalize({ ...ok, acpPreset: {} }), true, '对象会被抹掉')
    assert.equal(needsNormalize({ ...ok, acpPreset: ' acp-relay ' }), true, '未 trim 会被改写（与 agentPreset 同口径）')
  })
})

describe('init()：静默失效字段只告警、绝不回写磁盘', () => {
  it('含 persona / toolFilter 的条目触发一次 console.warn，且文件字节不变', async () => {
    const seed = [
      { ...base, id: 'legacy', persona: '你是探索者', toolFilter: { allow: ['read'] } },
      { ...base, id: 'clean' },
    ]
    const { dir, dataDir } = await freshRegistry(seed)
    const file = path.join(dataDir, 'agents.json')
    try {
      const before = readFileSync(file, 'utf8')

      const warns = []
      const orig = console.warn
      console.warn = (...args) => warns.push(args.join(' '))
      const reg = new AgentRegistry(dataDir)
      try {
        await reg.init()
      } finally {
        console.warn = orig
      }

      assert.equal(warns.length, 1, '只告警一次（不刷屏）')
      assert.match(warns[0], /legacy/, '点名具体 Agent')
      assert.match(warns[0], /persona/, '点名 persona')
      assert.match(warns[0], /toolFilter/, '点名 toolFilter')
      assert.match(warns[0], /Agent Preset/, '给出可操作替代')
      assert.equal(readFileSync(file, 'utf8'), before, 'v1.11.21 决定：读盘绝不回写磁盘')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('无失效字段时不告警', async () => {
    const { dir, dataDir } = await freshRegistry([{ ...base, id: 'clean' }])
    try {
      const warns = []
      const orig = console.warn
      console.warn = (...args) => warns.push(args.join(' '))
      const reg = new AgentRegistry(dataDir)
      try {
        await reg.init()
      } finally {
        console.warn = orig
      }
      assert.equal(warns.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('读盘保留 agentPreset（归一化后进内存）', async () => {
    const { dir, dataDir } = await freshRegistry([{ ...base, id: 'x', agentPreset: ' explorer ' }])
    try {
      const reg = new AgentRegistry(dataDir)
      await reg.init()
      assert.equal(reg.get('x').agentPreset, 'explorer', '读盘也过 normalizeAgent（trim）')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('GET /agent-api：agentPresets 出参（GUI 下拉的唯一来源）', () => {
  it('宿主无 agentPresets 服务 ⇒ []，且接口仍 200（不因缺服务挂掉）', async () => {
    const b = await boot()
    try {
      const { status, json } = await b.req('GET', '/agent-api')
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      assert.deepEqual(json.agentPresets, [], '缺服务降级为空数组')
    } finally {
      await b.close()
    }
  })

  it('有服务 ⇒ 只下发 id/name/description/order，且过滤 broken 与畸形行', async () => {
    const b = await boot({
      agentPresets: {
        list: async () => [
          { id: 'orchestrator', name: '编排模式', description: '只做编排', order: 6 },
          { id: 'standard', name: '标准' },
          { id: 'broken-one', name: '坏掉', broken: 'activation failed' },
          { id: '', name: '空 id' },
          null,
          { name: '无 id' },
        ],
      },
    })
    try {
      const { status, json } = await b.req('GET', '/agent-api')
      assert.equal(status, 200)
      assert.deepEqual(json.agentPresets, [
        { id: 'orchestrator', name: '编排模式', description: '只做编排', order: 6 },
        { id: 'standard', name: '标准' },
      ], 'broken 的 preset 不能进下拉——选它必然派发失败；畸形行丢弃')
      // 每个条目都必须是「无损 JSON」（宿主对工具/出参做 snapshotJsonValue 校验的同族要求）
      for (const p of json.agentPresets) {
        for (const [k, v] of Object.entries(p)) assert.notEqual(v, undefined, `${k} 不得为 undefined`)
      }
    } finally {
      await b.close()
    }
  })

  it('list() 抛错 ⇒ []，且接口仍 200（降级不外溢）', async () => {
    const b = await boot({ agentPresets: { list: async () => { throw new Error('preset 定义加载失败') } } })
    try {
      const { status, json } = await b.req('GET', '/agent-api')
      assert.equal(status, 200)
      assert.deepEqual(json.agentPresets, [])
    } finally {
      await b.close()
    }
  })
})
