import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentRegistry } from '../lib/agents.js'

/** 建一个临时注册表（DSH_HOME 不污染真实数据目录） */
async function freshRegistry() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dad-routes-'))
  const reg = new AgentRegistry(path.join(dir, 'data', 'dsh-agent-dispatch'))
  await reg.init()
  return { reg, dir }
}

const agent = (routes) => ({ id: 'a-one', name: 'A', systemPrompt: 'p', routes })
// 宿主语义：ACP provider = ctx.subagents.getProvider 命中
const acpOnly = (p) => (p === 'qoder' ? { id: p } : undefined)

describe('routes 校验：model 必填仅对 LLM 路由', () => {
  it('ACP 路由（谓词命中）允许 model 为空并可保存', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      const saved = await reg.upsert(agent([{ provider: 'qoder', model: '', effort: '' }]), { isSubagentProvider: acpOnly })
      assert.deepEqual(saved.routes, [{ provider: 'qoder' }]) // 空 model / 空 effort 不落键
      const onDisk = JSON.parse(readFileSync(path.join(dir, 'data', 'dsh-agent-dispatch', 'agents.json'), 'utf8'))
      assert.deepEqual(onDisk.agents[0].routes, [{ provider: 'qoder' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ACP 路由 model = "default"：与空串同义，归一化为不指定（不落键）', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      const saved = await reg.upsert(agent([{ provider: 'qoder', model: 'default' }]), { isSubagentProvider: acpOnly })
      assert.deepEqual(saved.routes, [{ provider: 'qoder' }], '增量3：库内统一以"不落键"表示不指定，"default" 只是等价输入')
      const onDisk = JSON.parse(readFileSync(path.join(dir, 'data', 'dsh-agent-dispatch', 'agents.json'), 'utf8'))
      assert.deepEqual(onDisk.agents[0].routes, [{ provider: 'qoder' }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('LLM 路由缺 model 仍报错（谓词不命中）', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      await assert.rejects(
        () => reg.upsert(agent([{ provider: 'deepseek-official', model: '' }]), { isSubagentProvider: acpOnly }),
        /缺少有效 model/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('不传谓词（老调用方/工具路径缺省）按 LLM 从严', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      await assert.rejects(() => reg.upsert(agent([{ provider: 'qoder' }])), /缺少有效 model/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('谓词抛错时降级为从严校验，且 provider 仍必须非空', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      const boom = () => { throw new Error('宿主不可用') }
      await assert.rejects(() => reg.upsert(agent([{ provider: 'qoder', model: '' }]), { isSubagentProvider: boom }), /缺少有效 model/)
      await assert.rejects(() => reg.upsert(agent([{ provider: '  ', model: 'x' }]), { isSubagentProvider: acpOnly }), /缺少非空 provider/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('effort 空串 = 不指定（GUI 未选时的提交形态），非字符串仍报错', async () => {
    const { reg, dir } = await freshRegistry()
    try {
      const saved = await reg.upsert(agent([{ provider: 'deepseek-official', model: 'deepseek-flash', effort: '' }]), { isSubagentProvider: acpOnly })
      assert.deepEqual(saved.routes, [{ provider: 'deepseek-official', model: 'deepseek-flash' }])
      await assert.rejects(
        () => reg.upsert(agent([{ provider: 'deepseek-official', model: 'm', effort: 5 }]), { isSubagentProvider: acpOnly }),
        /effort 必须是字符串/,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
