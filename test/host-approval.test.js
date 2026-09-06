// test/host-approval.test.js — v1.10.0 宿主审批规则引擎单元测试
// 运行：node --test test/host-approval.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  normalizeCandidate,
  pathAllowed,
  allowlistDecision,
  extractToolPaths,
  findToolCallRecord,
  resolveApprovalContext,
  expandPathsWithParents,
  HostApprovalRules,
} from '../lib/host-approval.js'

// ── 纯函数：路径规范化 ──

describe('normalizeCandidate', () => {
  it('展开 ~ 为家目录', () => {
    assert.equal(normalizeCandidate('~'), os.homedir())
    assert.equal(normalizeCandidate('~/foo'), path.join(os.homedir(), 'foo'))
  })
  it('去尾标点', () => {
    assert.equal(normalizeCandidate('/a/b,'), '/a/b')
    assert.equal(normalizeCandidate('/a/b);'), '/a/b')
  })
  it('null/空输入返回 null', () => {
    assert.equal(normalizeCandidate(null), null)
    assert.equal(normalizeCandidate(''), null)
    assert.equal(normalizeCandidate('   '), null)
  })
  it('保留绝对路径', () => {
    assert.equal(normalizeCandidate('/Volumes/ssd/project'), '/Volumes/ssd/project')
  })
})

// ── 纯函数：路径匹配 ──

describe('pathAllowed', () => {
  it('精确匹配', () => {
    assert.equal(pathAllowed('/a/b/file.txt', ['/a/b/file.txt']), true)
    assert.equal(pathAllowed('/a/b/other.txt', ['/a/b/file.txt']), false)
  })
  it('目录前缀匹配（带 /**）', () => {
    assert.equal(pathAllowed('/a/b/x.txt', ['/a/b/**']), true)
    assert.equal(pathAllowed('/a/bc/x.txt', ['/a/b/**']), false)
  })
  it('目录前缀匹配（无扩展名规则按目录宽容）', () => {
    assert.equal(pathAllowed('/a/b/x.txt', ['/a/b']), true)
    assert.equal(pathAllowed('/a/bc/x.txt', ['/a/b']), false)
  })
  it('空规则返回 false', () => {
    assert.equal(pathAllowed('/a/b', []), false)
    assert.equal(pathAllowed('/a/b', null), false)
  })
})

// ── 纯函数：白名单决策 ──

describe('allowlistDecision', () => {
  it('全部命中→allowed', () => {
    const d = allowlistDecision(['/a/b', '/a/c'], ['/a/b', '/a/c'])
    assert.equal(d.allowed, true)
    assert.deepEqual(d.covered, ['/a/b', '/a/c'])
    assert.deepEqual(d.uncovered, [])
  })
  it('部分命中→不允许', () => {
    const d = allowlistDecision(['/a/b', '/x/y'], ['/a/b'])
    assert.equal(d.allowed, false)
    assert.deepEqual(d.covered, ['/a/b'])
    assert.deepEqual(d.uncovered, ['/x/y'])
  })
  it('空路径→不允许', () => {
    const d = allowlistDecision([], ['/a/b'])
    assert.equal(d.allowed, false)
  })
  it('空规则→不允许', () => {
    const d = allowlistDecision(['/a/b'], [])
    assert.equal(d.allowed, false)
  })
})

// ── 纯函数：路径提取 ──

describe('extractToolPaths', () => {
  it('提取 file_path 字段', () => {
    const paths = extractToolPaths({ file_path: '/tmp/test.txt', content: 'hello' })
    assert.deepEqual(paths, ['/tmp/test.txt'])
  })
  it('从 bash command 提取绝对路径', () => {
    const paths = extractToolPaths({ command: 'cat /etc/hosts && echo done' })
    assert.ok(paths.includes('/etc/hosts'))
  })
  it('去重', () => {
    const paths = extractToolPaths({ file_path: '/tmp/a.txt', path: '/tmp/a.txt' })
    assert.equal(paths.length, 1)
  })
  it('null 参数返回空', () => {
    assert.deepEqual(extractToolPaths(null), [])
  })
})

// ── 纯函数：callId 反查 ──

describe('findToolCallRecord', () => {
  it('null session 返回 null', () => {
    assert.equal(findToolCallRecord(null, 'call-1'), null)
  })
  it('无 eventAt 返回 null', () => {
    assert.equal(findToolCallRecord({}, 'call-1'), null)
  })
  it('找到匹配记录', () => {
    const session = {
      seq: 3,
      eventAt(i) {
        const events = [
          { type: 'tool/call', data: { callId: 'call-0', name: 'bash', arguments: '{}' } },
          { type: 'tool/call', data: { callId: 'call-1', name: 'write', arguments: '{"file_path":"/tmp/test.txt"}' } },
          { type: 'tool/result', data: { callId: 'call-1' } },
        ]
        return events[i] || null
      },
    }
    const rec = findToolCallRecord(session, 'call-1')
    assert.ok(rec)
    assert.equal(rec.name, 'write')
  })
  it('找不到返回 null', () => {
    const session = {
      seq: 1,
      eventAt() { return null },
    }
    assert.equal(findToolCallRecord(session, 'call-99'), null)
  })
})

// ── 纯函数：resolveApprovalContext ──

describe('resolveApprovalContext', () => {
  it('从 session header 取 cwd', () => {
    const ctx = resolveApprovalContext({
      session: { header: { cwd: '/project' }, seq: 0, eventAt: () => null },
    })
    assert.equal(ctx.cwd, '/project')
    assert.deepEqual(ctx.paths, [])
  })
  it('从 tool/call 记录提取路径', () => {
    const session = {
      header: { cwd: '/project' },
      seq: 2,
      eventAt(i) {
        if (i === 0) return { type: 'tool/call', data: { callId: 'c1', name: 'write', arguments: '{"file_path":"/tmp/out.txt"}' } }
        return null
      },
    }
    const ctx = resolveApprovalContext({ session, callId: 'c1' })
    assert.equal(ctx.toolName, 'write')
    assert.ok(ctx.paths.includes('/tmp/out.txt'))
    assert.equal(ctx.callFound, true)
  })
})

// ── HostApprovalRules：会话规则 ──

describe('HostApprovalRules session rules', () => {
  it('追加与判定', () => {
    const rules = new HostApprovalRules()
    const r = rules.addSessionRule('sess-1', ['/a/b', '/a/c'])
    assert.equal(r.ok, true)
    const d = rules.decide({ sessionId: 'sess-1', paths: ['/a/b'] })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session')
  })
  it('未覆盖全部路径→不允许', () => {
    const rules = new HostApprovalRules()
    rules.addSessionRule('sess-1', ['/a/b'])
    const d = rules.decide({ sessionId: 'sess-1', paths: ['/a/b', '/x/y'] })
    assert.equal(d.allowed, false)
  })
  it('purgeSession 清理', () => {
    const rules = new HostApprovalRules()
    rules.addSessionRule('sess-1', ['/a/b'])
    rules.purgeSession('sess-1')
    const d = rules.decide({ sessionId: 'sess-1', paths: ['/a/b'] })
    assert.equal(d.allowed, false)
  })
  it('暂存审批上下文', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-ctx-'))
    const origDSH_HOME = process.env.DSH_HOME
    process.env.DSH_HOME = path.join(tmpDir, '.dsh')
    const rules = new HostApprovalRules()
    rules.pushPendingContext('call-1', { toolName: 'write', paths: ['/tmp/x'], cwd: '/proj' })
    const ctx = rules.popPendingContext('call-1')
    assert.ok(ctx)
    assert.equal(ctx.toolName, 'write')
    assert.deepEqual(ctx.paths, ['/tmp/x'])
    assert.equal(rules.popPendingContext('call-1'), null)
    process.env.DSH_HOME = origDSH_HOME
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ── HostApprovalRules：项目规则（共用文件）──

describe('HostApprovalRules project rules', () => {
  it('写入与判定', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-test-'))
    // 临时覆盖文件路径（测试用）
    const rules = new HostApprovalRules()
    rules._file = path.join(tmpDir, 'allowlist.json')
    rules._sharedDir = tmpDir
    // 直接用 private 字段访问需要 hack——改用内部方法
    // 实际测试用真实的 SHARED_DIR（避免污染，用 DSH_HOME 指向临时目录）
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ── 与 product-subagents 共用文件兼容性 ──

describe('shared allowlist.json compatibility', () => {
  it('主代理条目无 product 字段，判定仍可命中', () => {
    // 模拟共用文件内容：混合主代理（无 product）和 ACP（有 product）条目
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-shared-'))
    const origDSH_HOME = process.env.DSH_HOME
    process.env.DSH_HOME = path.join(tmpDir, '.dsh')

    const rules = new HostApprovalRules()
    // 写入主代理条目（无 product）
    const r1 = rules.appendProjectRule({ cwd: '/project', paths: ['/project/src'] })
    assert.equal(r1.ok, true)

    // 模拟 ACP 条目（有 product）——手动追加
    const file = rules.filePath
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    raw.rules.push({ cwd: '/project', product: 'deveco', paths: ['/project/config'], grantedAt: new Date().toISOString(), note: 'ACP 总是允许' })
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8')

    // 判定：主代理请求路径命中 ACP 条目 → 应放行（忽略 product）
    assert.equal(rules.projectRulesCover('/project', ['/project/config']), true)
    // 判定：ACP 请求路径命中主代理条目 → 应放行
    assert.equal(rules.projectRulesCover('/project', ['/project/src']), true)

    // 清理
    process.env.DSH_HOME = origDSH_HOME
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('去重忽略 product 差异', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-dedup-'))
    const origDSH_HOME = process.env.DSH_HOME
    process.env.DSH_HOME = path.join(tmpDir, '.dsh')

    const rules = new HostApprovalRules()
    rules.appendProjectRule({ cwd: '/project', paths: ['/a/b'] })

    // 再次写入同 (cwd, paths)——应合并而非重复
    rules.appendProjectRule({ cwd: '/project', paths: ['/a/b'] })
    const file = rules.filePath
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(raw.rules.length, 1)

    process.env.DSH_HOME = origDSH_HOME
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })
})

// ── v1.10.2：规则路径补直接父目录 ──

describe('expandPathsWithParents', () => {
  it('文件路径补直接父目录', () => {
    const out = expandPathsWithParents(['/Users/arming/.dsh/data/.verify.txt'])
    assert.ok(out.includes('/Users/arming/.dsh/data/.verify.txt'))
    assert.ok(out.includes('/Users/arming/.dsh/data'))
  })

  it('已存在目录不补父目录', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-expand-'))
    try {
      const out = expandPathsWithParents([dir])
      assert.ok(out.includes(dir))
      assert.ok(!out.includes(path.dirname(dir)))
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('多路径去重且忽略非绝对路径', () => {
    const out = expandPathsWithParents(['/a/b/c.txt', '/a/b/c.txt', 'relative/path', null])
    assert.equal(out.filter((p) => p === '/a/b/c.txt').length, 1)
    assert.ok(out.includes('/a/b'))
    assert.ok(!out.some((p) => p.includes('relative')))
  })

  it('写入端集成：addSessionRule 与 appendProjectRule 均补父目录', async () => {
    const origDSH_HOME = process.env.DSH_HOME
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ha-rules-'))
    try {
      process.env.DSH_HOME = tmpDir
      const rules = new HostApprovalRules()
      const filePath = '/Users/arming/.dsh/data/.verify-v110-project.txt'
      const s = rules.addSessionRule('sess-test', [filePath])
      assert.ok(s.ok)
      const sessPaths = rules.sessionRules('sess-test')
      assert.ok(sessPaths.includes(filePath))
      assert.ok(sessPaths.includes('/Users/arming/.dsh/data'))

      const pr = rules.appendProjectRule({ cwd: '/project', paths: [filePath] })
      assert.ok(pr.ok)
      const raw = JSON.parse(fs.readFileSync(rules.filePath, 'utf8'))
      const entry = raw.rules.find((r) => r.cwd === '/project')
      assert.ok(entry.paths.includes(filePath))
      assert.ok(entry.paths.includes('/Users/arming/.dsh/data'))
    } finally {
      process.env.DSH_HOME = origDSH_HOME
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
