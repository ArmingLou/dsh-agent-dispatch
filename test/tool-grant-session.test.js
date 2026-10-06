// test/tool-grant-session.test.js — v1.12.1 工具名级会话授权回归测试
// 运行：node --test test/tool-grant-session.test.js
//
// 验收核心：同一根会话内，工具 bash 在路径 A 下授权后，路径 B 的同类请求
// 不再需要人工审批（返回 allowed-once）。沙箱越权与 ACP 孪生不得被工具名档直放。
// v1.12.5 档位拆分（用户裁定）：沙箱越权**只**不适用工具名档，会话路径档照旧判定；
// v1.12.5 二次裁定（用户）：越权**也不适用落盘项目档**——路径级记忆只到本会话为止，
// 换会话仍要问。ACP 孪生仍然完全绕过本插件判定。
// 根 id 解析在字段缺失/异常时 fallback 不抛错。
//
// 集成测试：从 index.js 源码提取真实 approval/request handler，
// 注入真实 HostApprovalRules + mock session/dispatcher，断言 handler 返回值。

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HostApprovalRules,
  isSandboxEscalation,
  isAcpTwinApproval,
  isDisallowedAutoGrant,
  isDelegatedSession,
  resolveRootSessionId,
  resolveApprovalContext,
  dangerousCommandMatch,
  // v1.12.6 第五轮（终审 Minor 2）：门判据文本的有界截断（handler 新增的闭包引用）
  boundDangerText,
  MAX_DANGER_TEXT_CHARS,
  // v1.12.6 第六轮（终审 Minor 3）：`commandText` 超限的门名（handler 新增的闭包引用）
  COMMAND_TOO_LONG_RULE,
} from '../lib/host-approval.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── 纯函数：沙箱越权判据 ──

describe('isSandboxEscalation', () => {
  it('匹配宿主 dsh-sandbox 的越权 reason 文案', () => {
    assert.equal(isSandboxEscalation('escalate sandbox to read-write: need to write config'), true)
    assert.equal(isSandboxEscalation('escalate sandbox to full: override restrictions'), true)
  })
  it('宽松匹配：大小写与多空格', () => {
    assert.equal(isSandboxEscalation('Escalate Sandbox To full: reason'), true)
    assert.equal(isSandboxEscalation('escalate  sandbox  to read-write: x'), true)
  })
  it('前导空白/换行/制表符也匹配（v1.12.1 收紧安全侧）', () => {
    assert.equal(isSandboxEscalation(' escalate sandbox to full: x'), true)
    assert.equal(isSandboxEscalation('\tescalate sandbox to read-write: x'), true)
    assert.equal(isSandboxEscalation('  escalate   sandbox   to full: x'), true)
  })
  it('非越权 reason 不误判', () => {
    assert.equal(isSandboxEscalation('tool requires approval'), false)
    assert.equal(isSandboxEscalation('[ACP qoder] 请求权限'), false)
    assert.equal(isSandboxEscalation(null), false)
    assert.equal(isSandboxEscalation(''), false)
  })
})

// ── 纯函数：ACP 孪生判据 ──

describe('isAcpTwinApproval', () => {
  it('匹配 ACP 孪生审批', () => {
    assert.equal(isAcpTwinApproval('product_submit', '[ACP qoder] 请求权限：x'), true)
  })
  it('非 ACP 孪生不误判', () => {
    assert.equal(isAcpTwinApproval('bash', '[ACP qoder] 请求权限'), false)
    assert.equal(isAcpTwinApproval('product_submit', 'other reason'), false)
    assert.equal(isAcpTwinApproval(null, '[ACP qoder] x'), false)
    assert.equal(isAcpTwinApproval('product_submit', null), false)
  })
})

// ── 纯函数：综合判据 isDisallowedAutoGrant ──

describe('isDisallowedAutoGrant', () => {
  // v1.12.7（用户裁定「工具档不受越权限制」）：这条判据被**拆开**——越权不再算
  // 「不得用工具名档」，只剩 ACP 孪生一种来源（孪生上面还有更早的 return next()
  // 早退门 ⇒ 生产路径上恒 false，留着是防御性冗余）。越权的唯一约束改为
  // decide 的 sessionOnly（不写落盘项目档）。
  it('沙箱越权 → **允许**直放（v1.12.7 拆开判据，工具档不再逐请求排除越权）', () => {
    assert.equal(isDisallowedAutoGrant('bash', 'escalate sandbox to read-write: need write'), false)
  })
  it('ACP 孪生 → 不允许直放', () => {
    assert.equal(isDisallowedAutoGrant('product_submit', '[ACP qoder] 请求权限'), true)
  })
  it('普通审批 → 允许直放', () => {
    assert.equal(isDisallowedAutoGrant('bash', 'tool requires approval'), false)
    assert.equal(isDisallowedAutoGrant('write', null), false)
  })
})

// ── 纯函数：根会话 id 解析 ──

describe('resolveRootSessionId', () => {
  it('主会话（无 parentSession）→ 返回自身 id', () => {
    const session = { id: 'root-1', header: {} }
    assert.equal(resolveRootSessionId(session), 'root-1')
  })
  it('子代理（有 parentSession）→ 返回直接父级 id', () => {
    const session = { id: 'child-1', header: { parentSession: 'root-1', origin: 'subagent' } }
    assert.equal(resolveRootSessionId(session), 'root-1')
  })
  it('header 缺失 → fallback 自身 id', () => {
    const session = { id: 'sess-1' }
    assert.equal(resolveRootSessionId(session), 'sess-1')
  })
  it('null session → 返回空串', () => {
    assert.equal(resolveRootSessionId(null), '')
  })
  it('循环 parentSession 防护', () => {
    const session = { id: 'sess-1', header: { parentSession: 'sess-1' } }
    assert.equal(resolveRootSessionId(session), 'sess-1')
  })
  it('dispatcher 映射回退（entry.childId 匹配 → entry.parentSessionId）', () => {
    const session = { id: 'child-1', header: {} }
    const dispatcher = {
      activeChildren: new Map([['child-1', { childId: 'child-1', parentSessionId: 'root-1' }]]),
    }
    assert.equal(resolveRootSessionId(session, dispatcher), 'root-1')
  })
  it('dispatcher 也无映射 → fallback 自身 id', () => {
    const session = { id: 'sess-1', header: {} }
    const dispatcher = { activeChildren: new Map() }
    assert.equal(resolveRootSessionId(session, dispatcher), 'sess-1')
  })
})

// ── HostApprovalRules：工具名级会话授权 ──

describe('HostApprovalRules tool grants', () => {
  it('追加与查询', () => {
    const rules = new HostApprovalRules()
    const r = rules.addToolGrant('root-1', 'bash')
    assert.equal(r.ok, true)
    assert.equal(r.count, 1)
    assert.deepEqual(rules.toolGrants('root-1'), ['bash'])
  })

  it('同一工具名幂等', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.addToolGrant('root-1', 'bash')
    assert.equal(rules.toolGrants('root-1').length, 1)
  })

  it('不同工具名追加', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.addToolGrant('root-1', 'write')
    assert.equal(rules.toolGrants('root-1').length, 2)
  })

  it('验收核心：同一根会话 bash 授权后，不同路径的 bash 也自动放行', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: ['/x/y'], toolName: 'bash' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session-tool')
  })

  it('工具名授权不依赖 paths 为空也能命中', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: [], toolName: 'bash' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session-tool')
  })

  it('未授权工具名 → 不放行', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: ['/tmp/x'], toolName: 'write' })
    assert.equal(d.allowed, false)
  })

  it('沙箱越权 → isDisallowedAutoGrant 返回 false（v1.12.7：越权照吃工具名档）', () => {
    assert.equal(isDisallowedAutoGrant('bash', 'escalate sandbox to read-write: need write'), false)
    // 判据仍必须能识别越权本身——它只是不再关工具档，改为管 decide 的 sessionOnly
    assert.equal(isSandboxEscalation('escalate sandbox to read-write: need write'), true)
  })

  it('同一根会话的兄弟子代理共享工具名授权', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    const d = rules.decide({ sessionId: 'child-B', rootSessionId: 'root-1', paths: ['/other/path'], toolName: 'bash' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session-tool')
  })

  it('purgeSession(rootSessionId) 清理工具名授权', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.purgeSession('root-1')
    const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: ['/a/b'], toolName: 'bash' })
    assert.equal(d.allowed, false)
  })

  it('purgeSession(子会话 id) 不清除根的工具名授权（只清自身键）', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.addSessionRule('root-1', ['/work/dir'])
    rules.registerSessionRoot('child-1', 'root-1')
    // 子会话销毁 → 根的工具名授权和路径规则必须保留
    rules.purgeSession('child-1')
    assert.equal(rules.toolGrantCovers('root-1', 'bash'), true)
    // addSessionRule 会补父目录 → ['/work/dir', '/work']
    assert.ok(rules.sessionRules('root-1').length >= 1)
  })

  it('purgeSession(子会话 id) 不影响兄弟子会话的授权命中', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.registerSessionRoot('child-1', 'root-1')
    rules.registerSessionRoot('child-2', 'root-1')
    rules.purgeSession('child-1')
    // C2 仍能命中根授权
    const d = rules.decide({ sessionId: 'child-2', rootSessionId: 'root-1', paths: [], toolName: 'bash' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session-tool')
  })

  it('purgeSession(子会话 id) 不影响其他根会话的工具名授权', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.addToolGrant('root-2', 'write')
    rules.registerSessionRoot('child-1', 'root-1')
    rules.registerSessionRoot('child-2', 'root-2')
    rules.purgeSession('child-1')
    assert.equal(rules.toolGrantCovers('root-1', 'bash'), true)
    assert.equal(rules.toolGrantCovers('root-2', 'write'), true)
  })

  it('purgeSession(根会话 id) 清理根的工具名授权 + 所有指向该根的子会话注册', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.registerSessionRoot('child-1', 'root-1')
    rules.registerSessionRoot('child-2', 'root-1')
    rules.purgeSession('root-1')
    assert.equal(rules.toolGrantCovers('root-1', 'bash'), false)
    assert.equal(rules.sessionRootOf('child-1'), null)
    assert.equal(rules.sessionRootOf('child-2'), null)
  })

  it('resolveRootSessionId 在异常输入下不抛错', () => {
    assert.doesNotThrow(() => resolveRootSessionId(null))
    assert.doesNotThrow(() => resolveRootSessionId({}))
    assert.doesNotThrow(() => resolveRootSessionId({ id: 'x' }))
    assert.doesNotThrow(() => resolveRootSessionId({ id: 'x', header: { parentSession: null } }))
  })

  // 授权只在「工具名精确相等」时成立。任何 trim() / 大小写归一 / 前缀匹配都会让用户从未
  // 点过名的工具蹭到授权（'bash ' 命中 'bash' → 静默放行），故近似名必须继续弹窗。
  it('工具名授权按精确相等匹配，近似名不串味且仍弹窗', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    assert.equal(rules.toolGrantCovers('root-1', 'bash'), true) // 锚点：精确名命中，判据没坏
    for (const near of ['bash2', 'BASh', 'Bash', 'bash ', ' bash', '', '  ']) {
      assert.equal(rules.toolGrantCovers('root-1', near), false, `近似名 ${JSON.stringify(near)} 不应命中 'bash' 授权`)
      const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: [], toolName: near })
      assert.equal(d.allowed, false, `近似名 ${JSON.stringify(near)} 仍应走人工审批`)
    }
  })
})

// ── v1.12.3：resolveRootSessionId 链式上溯（孙代理共享授权）──

describe('resolveRootSessionId 链式上溯', () => {
  it('孙代理 → 子代理 → 根：通过 header.parentSession 链式上溯', () => {
    // G 的 parent 是 C，C 的 parent 是 R
    // （宿主委派子会话必带 origin:'subagent'，见 dsh-subagent childSessionMeta）
    const grandchild = { id: 'grandchild-1', header: { parentSession: 'child-1', origin: 'subagent', delegationDepth: 2 } }
    // 无 sessionRootOf 时，只能上溯到 child-1（直接父级），因为无法查 C 的 parent
    // 但若有 sessionRootOf 提供 C→R 的映射，就能链式上溯到 R
    const sessionRootOf = (sid) => {
      if (sid === 'child-1') return 'root-1'
      return null
    }
    const result = resolveRootSessionId(grandchild, null, sessionRootOf)
    assert.equal(result, 'root-1')
  })

  it('无 sessionRootOf 时孙代理只上溯到直接父级', () => {
    const grandchild = { id: 'grandchild-1', header: { parentSession: 'child-1', origin: 'subagent', delegationDepth: 2 } }
    const result = resolveRootSessionId(grandchild, null, null)
    assert.equal(result, 'child-1')
  })

  it('三层 header.parentSession 链式上溯（无需 sessionRootOf）', () => {
    // 构造：G → C → R，C 的 header 也有 parentSession
    // 直接传 G 的 session，resolveRootSessionId 内部会构造虚拟 session 继续上溯
    // 但 C 的 parentSession 信息不在 G 的 session 里，需要 sessionRootOf
    // 真实场景：G.header.parentSession='C'，但无法自动获取 C 的 header → 需要 sessionRootOf
    // 验证：三层映射全部注册后能上溯到根
    const rules = new HostApprovalRules()
    rules.registerSessionRoot('child-1', 'root-1')
    rules.registerSessionRoot('grandchild-1', 'child-1')
    const grandchild = { id: 'grandchild-1', header: { parentSession: 'child-1', origin: 'subagent', delegationDepth: 2 } }
    const result = resolveRootSessionId(grandchild, null, (sid) => rules.sessionRootOf(sid))
    assert.equal(result, 'root-1')
  })

  it('循环保护：A→B→A 不死循环', () => {
    const rules = new HostApprovalRules()
    rules.registerSessionRoot('B', 'A')
    rules.registerSessionRoot('A', 'B')
    const session = { id: 'A', header: { parentSession: 'B', origin: 'subagent', delegationDepth: 1 } }
    const result = resolveRootSessionId(session, null, (sid) => rules.sessionRootOf(sid))
    // 应该停在某个 id 上，不抛错
    assert.ok(typeof result === 'string' && result.length > 0)
  })

  it('深度上限：超过 10 层不堆栈溢出', () => {
    const rules = new HostApprovalRules()
    let prev = 'root'
    for (let i = 1; i <= 15; i++) {
      const cur = `level-${i}`
      rules.registerSessionRoot(cur, prev)
      prev = cur
    }
    const session = { id: 'level-15', header: { parentSession: 'level-14', origin: 'subagent', delegationDepth: 15 } }
    assert.doesNotThrow(() => {
      const result = resolveRootSessionId(session, null, (sid) => rules.sessionRootOf(sid))
      assert.ok(typeof result === 'string')
    })
  })
})

describe('孙代理共享根会话工具名授权', () => {
  it('R 授权 bash → 孙代理 G 的请求也直接放行', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.registerSessionRoot('child-1', 'root-1')
    rules.registerSessionRoot('grandchild-1', 'child-1')
    const grandchild = { id: 'grandchild-1', header: { parentSession: 'child-1', origin: 'subagent', delegationDepth: 2 } }
    const rootId = resolveRootSessionId(grandchild, null, (sid) => rules.sessionRootOf(sid))
    assert.equal(rootId, 'root-1')
    const d = rules.decide({ sessionId: 'grandchild-1', rootSessionId: rootId, paths: [], toolName: 'bash' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session-tool')
  })

  it('无父级信息的子代理不会误放行（fallback 自身 id，不命中根授权）', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    // orphan session: 无 parentSession、无 sessionRootOf 映射
    const orphan = { id: 'orphan-1', header: {} }
    const rootId = resolveRootSessionId(orphan, null, null)
    assert.equal(rootId, 'orphan-1')
    const d = rules.decide({ sessionId: 'orphan-1', rootSessionId: rootId, paths: [], toolName: 'bash' })
    assert.equal(d.allowed, false)
  })
})

// ── v1.12.4 阻断修复：fork（分叉会话）是新的主会话，不得当作子会话上溯 ──
//
// 宿主字段口径（本机并存的两个宿主版本各自就地复核，字段有差异）：
//   - fork：**必带** parentSession + cwd；另带一个「血统标记」，但该标记随宿主版本变——
//     DSH 运行时安装树（<DSH>/node_modules/@deepseek-ai/）里是
//     @deepseek-ai/dsh-session@0.2.0-rc.2，其 SessionStore.fork() 落 `isSeeded: true`，且
//     `validateSessionHeader` **拒绝** `seedLength`（见到即抛
//     `session header has invalid field "seedLength"`）；@deepseek-ai/dsh-session@0.1.0-rc.6
//     只是 third/dsh-plugin-product-subagents/node_modules/ 里插件开发用的旧副本，它的
//     fork() 落 `seedLength`（该副本 lib/index.js:1849，:1121 承认它是合法头字段）。
//     **两版共同不变的只有一件事：不带 origin / delegationDepth**——判据读的就是这个
//     不变量，两个血统标记一个都不读。
//   - dsh-subagent childSessionMeta → 子代理子会话必带 origin:'subagent'
//     + delegationDepth>0（全仓唯一的写入方）。
// 所以「有 parentSession」并不等于「是本主代理会话委派出来的」，v1.12.3 之前
// 只看 parentSession 会把 fork 解析成它的源会话：fork 里点的授权写到源会话键、
// 源会话随后被静默放行，且源会话 dispose 后 fork 再写下的键没有任何 purge 路径。

describe('fork 会话不得上溯到源会话', () => {
  /**
   * fork 形态的 session：有 parentSession、无 origin / delegationDepth。
   * `marker` 只用于覆盖宿主各版本的血统字段差异，判据不读它。
   */
  const mkFork = (id, sourceId, marker = 'seedLength') => ({
    id,
    header: marker === 'none'
      ? { cwd: '/home/test', parentSession: sourceId }
      : { cwd: '/home/test', parentSession: sourceId, [marker]: marker === 'isSeeded' ? true : 12 },
  })
  /** 宿主委派子代理形态的 session */
  const mkChild = (id, parentId, depth = 1) => ({
    id,
    header: { cwd: '/home/test', parentSession: parentId, origin: 'subagent', delegationDepth: depth },
  })

  it('血统标记随宿主版本而变，判据一律不读：seedLength / isSeeded / 无标记 三种 fork 头同结论', () => {
    for (const marker of ['seedLength', 'isSeeded', 'none']) {
      const fork = mkFork('fork-1', 'R', marker)
      assert.equal(isDelegatedSession(fork), false, `${marker} 形态的 fork 被判成委派子会话`)
      assert.equal(resolveRootSessionId(fork, null, null), 'fork-1', `${marker} 形态的 fork 上溯到了源会话`)
    }
    // 反过来：委派形态即使不带 delegationDepth，origin 也必须让它上溯
    assert.equal(isDelegatedSession({ id: 'c', header: { parentSession: 'R', origin: 'subagent' } }), true)
  })

  it('isDelegatedSession：fork → false；子代理 → true；普通新会话 → false', () => {
    assert.equal(isDelegatedSession(mkFork('fork-1', 'R')), false)
    assert.equal(isDelegatedSession(mkChild('child-1', 'R')), true)
    assert.equal(isDelegatedSession({ id: 'plain-1', header: { cwd: '/x' } }), false)
    // 只带 delegationDepth（不带 origin）也算委派——两个字段任一成立即上溯，判据只收紧不多放宽
    assert.equal(isDelegatedSession({ id: 'd', header: { delegationDepth: 3 } }), true)
    assert.equal(isDelegatedSession(null), false)
    assert.equal(isDelegatedSession({ id: 'd' }), false)
  })

  it('resolveRootSessionId(fork) === fork.id（旧实现只看 parentSession 会返回源会话 R）', () => {
    const rules = new HostApprovalRules()
    assert.equal(
      resolveRootSessionId(mkFork('fork-1', 'R'), null, (sid) => rules.sessionRootOf(sid)),
      'fork-1',
    )
  })

  it('fork 的授权落在 fork 键上，源会话 R 的键保持为空（不落 R 键）', () => {
    const rules = new HostApprovalRules()
    const root = resolveRootSessionId(mkFork('fork-1', 'R'), null, (sid) => rules.sessionRootOf(sid))
    rules.addToolGrant(root, 'bash')
    assert.deepEqual(rules.toolGrants('fork-1'), ['bash'])
    assert.deepEqual(rules.toolGrants('R'), [])
  })

  it('R 不被 fork 的授权静默放行；fork 自己后续请求命中（同键）', () => {
    const rules = new HostApprovalRules()
    const forkRoot = resolveRootSessionId(mkFork('fork-1', 'R'), null, (sid) => rules.sessionRootOf(sid))
    rules.addToolGrant(forkRoot, 'bash')
    // 源会话 R 的请求（用户从未在 R 点过）——不得命中
    const dR = rules.decide({ sessionId: 'R', rootSessionId: 'R', paths: [], toolName: 'bash' })
    assert.equal(dR.allowed, false)
    // fork 自己的请求命中 fork 键
    const dF = rules.decide({ sessionId: 'fork-1', rootSessionId: forkRoot, paths: [], toolName: 'bash' })
    assert.equal(dF.allowed, true)
    assert.equal(dF.scope, 'session-tool')
  })

  it('fork dispose 清自身键；不牵连源会话键', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('fork-1', 'bash')
    rules.addToolGrant('R', 'write')
    const purged = rules.purgeSession('fork-1')
    assert.equal(purged.hadGrants, true)
    assert.equal(purged.isRoot, true) // fork 自身就是根（没有 fork→R 映射）
    assert.deepEqual(rules.toolGrants('fork-1'), [])
    assert.deepEqual(rules.toolGrants('R'), ['write']) // 源会话授权不受影响
  })

  it('源会话已 dispose 后，fork 再触发审批不留任何无清理路径的键（D7-D9 泄漏）', () => {
    const rules = new HostApprovalRules()
    // 复刻 index.js 的注册口径（判据 + 注册），验证「源会话先走、fork 后写」不产生孤儿键
    const link = (session) => {
      const root = resolveRootSessionId(session, null, (sid) => rules.sessionRootOf(sid))
      if (isDelegatedSession(session)) rules.registerSessionRoot(session.id, root)
      rules.addToolGrant(root, 'bash')
      return root
    }
    assert.equal(link({ id: 'R', header: { cwd: '/x' } }), 'R')
    rules.purgeSession('R') // 源会话 dispose
    assert.equal(link(mkFork('fork-1', 'R')), 'fork-1')
    // 旧实现下这里 grant 会挂到 'R' 上：R 已 dispose、再无任何 purge 路径 → 活到进程结束
    assert.deepEqual(rules.toolGrants('R'), [])
    assert.deepEqual(rules.toolGrants('fork-1'), ['bash'])
    assert.equal(rules.sessionRootOf('fork-1'), null) // 无 fork→R 映射，链上无孤儿边
    rules.purgeSession('fork-1') // fork 自己 dispose → 全部清干净
    assert.deepEqual(rules.toolGrants('fork-1'), [])
    assert.equal(rules.toolGrantCovers('R', 'bash'), false)
  })

  it('fork 派出的子代理以 fork 为根（不是源会话 R）', () => {
    const rules = new HostApprovalRules()
    const forkRoot = resolveRootSessionId(mkFork('fork-1', 'R'), null, (sid) => rules.sessionRootOf(sid))
    rules.registerSessionRoot('fc-1', forkRoot) // fork 的子代理，注册点按判据登记
    const childRoot = resolveRootSessionId(mkChild('fc-1', 'fork-1'), null, (sid) => rules.sessionRootOf(sid))
    assert.equal(childRoot, 'fork-1')
  })

  it('真子代理路径不回归：原生 spawn（origin=subagent）仍上溯到根', () => {
    const rules = new HostApprovalRules()
    rules.registerSessionRoot('child-1', 'R')
    assert.equal(resolveRootSessionId(mkChild('child-1', 'R'), null, (sid) => rules.sessionRootOf(sid)), 'R')
    // 孙代理链式上溯
    rules.registerSessionRoot('grand-1', 'child-1')
    assert.equal(resolveRootSessionId(mkChild('grand-1', 'child-1', 2), null, (sid) => rules.sessionRootOf(sid)), 'R')
  })
})

// ── 工具名授权与路径规则并存 ──

describe('HostApprovalRules tool grant + path rules coexist', () => {
  it('工具名授权优先短路（scope=session-tool），路径规则次之', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    const d = rules.decide({ sessionId: 'root-1', rootSessionId: 'root-1', paths: ['/uncovered/path'], toolName: 'bash' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session-tool')
  })

  it('无工具名授权时仍走路径规则（有断言）', () => {
    const rules = new HostApprovalRules()
    rules.addSessionRule('root-1', ['/a/b'])
    const d = rules.decide({ sessionId: 'root-1', rootSessionId: 'root-1', paths: ['/a/b/file.txt'], toolName: 'write' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session')
  })

  it('无工具名授权、路径规则也不覆盖 → 不放行', () => {
    const rules = new HostApprovalRules()
    rules.addSessionRule('root-1', ['/a/b'])
    const d = rules.decide({ sessionId: 'root-1', rootSessionId: 'root-1', paths: ['/x/y'], toolName: 'write' })
    assert.equal(d.allowed, false)
  })
})

// ── ACP 孪生不被工具名直放 ──

describe('ACP孪生不被工具名直放', () => {
  it('product_submit 即使 bash 已授权，ACP 孪生仍不得直放', () => {
    assert.equal(isDisallowedAutoGrant('product_submit', '[ACP qoder] 请求权限'), true)
  })
})

// ── v1.12.5：decide 的 disallowToolGrant / sessionOnly（越权只留会话路径档）──
// 排除门的档位限制最终落在 decide 的两个入参上：越权请求既拿不到
// scope='session-tool'，也拿不到 scope='project'（v1.12.5 二次裁定：落盘白名单
// 不得替越权放行，跨会话静默提权是用户明确否决的），只剩 scope='session'。

describe('decide disallowToolGrant（越权只跳工具名档，路径档照旧）', () => {
  const ESC_PATHS = ['/tmp/proj/a.txt']

  it('已授权工具名 + 路径不被覆盖 + disallowToolGrant=true → 不放行', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    const d = rules.decide({
      sessionId: 'child-1', rootSessionId: 'root-1', paths: ['/elsewhere/x.txt'], toolName: 'bash', disallowToolGrant: true,
    })
    assert.equal(d.allowed, false)
    assert.equal(d.scope, null)
  })

  it('路径被会话规则覆盖 + disallowToolGrant=true → allowed 且 scope=session（绝不是 session-tool）', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    rules.addSessionRule('root-1', ESC_PATHS)
    const d = rules.decide({
      sessionId: 'child-1', rootSessionId: 'root-1', paths: ESC_PATHS, toolName: 'bash', disallowToolGrant: true,
    })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session')
    assert.deepEqual(d.covered, ESC_PATHS)
  })

  it('缺省（非越权）→ 工具名档照旧短路，scope=session-tool', () => {
    const rules = new HostApprovalRules()
    rules.addToolGrant('root-1', 'bash')
    const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: ESC_PATHS, toolName: 'bash' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session-tool')
  })

  // v1.12.5 二次裁定改写了这条用例的**期望**：原用例（冻结版）断言
  // disallowToolGrant=true 时项目档照旧放行（scope='project'），把越权的"路径级记忆"
  // 一路开到落盘白名单。用户裁定越权只保留会话档 ⇒ 生产调用（index.js 的 approval/request
  // handler）现在总是 disallowToolGrant 与 sessionOnly 同真，项目档不再参与。
  // 这条用例因此降级为"两个开关彼此独立"的粒度守卫：只关工具名档时项目档仍在，
  // 关掉项目档（下一条用例）才是不放行——防止后来人把两个开关焊成一个、
  // 误伤非越权请求的项目白名单语义。
  it('两开关彼此独立：仅 disallowToolGrant=true（不带 sessionOnly）时项目档仍参与', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-esc-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home // 构造时读 DSH_HOME，必须先设再 new
    try {
      const rules = new HostApprovalRules()
      rules.appendProjectRule({ cwd: '/home/test', paths: ESC_PATHS })
      assert.deepEqual(rules.toolGrants('root-1'), [], '这条落盘规则不该带任何工具名授权')
      const d = rules.decide({
        sessionId: 'child-1', rootSessionId: 'root-1', cwd: '/home/test', paths: ESC_PATHS, toolName: 'bash', disallowToolGrant: true,
      })
      assert.equal(d.allowed, true)
      assert.equal(d.scope, 'project')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  // v1.12.5 二次裁定（用户）：越权的路径级记忆**只到本会话为止**。落盘项目档是给
  // 「这个工作目录里这些路径」的长期白名单，用它替越权放行等于把「某路径可以提权到
  // danger-full-access」静默留存到后续会话——明确否决。sessionOnly 因此必须在
  // disallowToolGrant 之外再关一档。
  // v1.12.14（用户裁定，放开 v1.12.5 的读侧守卫）：用户在授权界面显式点项目档时，
  // 写侧照落盘、读侧照消费 ⇒ decide 的 sessionOnly 参数随之下线。本用例保留同一个
  // 夹具、只把期望翻面：越权（reason 判据）**不再**影响落盘项目档；传旧的
  // sessionOnly:true 也不再有任何抑制效果（参数已删，多余键被解构忽略）。
  it('越权不再抑制落盘项目档（v1.12.14 读侧对称放开；旧 sessionOnly:true 已成无效键）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-esconly-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const rules = new HostApprovalRules()
      const wr = rules.appendProjectRule({ cwd: '/home/test', paths: ESC_PATHS })
      assert.equal(wr.ok, true, '项目规则本身要能落盘，否则这条用例是在测空集')
      // 前置确认：项目档确实覆盖这些路径（否则"放行"可能只是因为别的档命中）
      assert.equal(rules.projectRulesCover('/home/test', ESC_PATHS), true)
      assert.deepEqual(rules.sessionRules('root-1'), [], '会话档必须为空，命中与否只能由项目档解释')
      assert.deepEqual(rules.toolGrants('root-1'), [], '工具档必须为空，命中与否只能由项目档解释')
      const d = rules.decide({
        sessionId: 'child-1', rootSessionId: 'root-1', cwd: '/home/test', paths: ESC_PATHS,
        toolName: 'bash', disallowToolGrant: true, sessionOnly: true,
      })
      assert.equal(d.allowed, true, '落盘项目档没被消费（读侧 sessionOnly 若被加回来，这里转红）')
      assert.equal(d.scope, 'project')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it('落盘项目档对越权与非越权一视同仁（v1.12.14；旧 sessionOnly 键不再改变结果）', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-normalproj-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const rules = new HostApprovalRules()
      rules.appendProjectRule({ cwd: '/home/test', paths: ESC_PATHS })
      const d = rules.decide({
        sessionId: 'child-2', rootSessionId: 'root-2', cwd: '/home/test', paths: ESC_PATHS,
        toolName: 'write',
      })
      assert.equal(d.allowed, true, '非越权的项目档放行被关掉了（超出裁定范围）')
      assert.equal(d.scope, 'project')
      // 同一条规则、同一请求，只把旧的 sessionOnly/disallowToolGrant 组合加上 ⇒ 必须同样放行
      const esc = rules.decide({
        sessionId: 'child-2', rootSessionId: 'root-2', cwd: '/home/test', paths: ESC_PATHS,
        toolName: 'write', disallowToolGrant: true, sessionOnly: true,
      })
      assert.equal(esc.allowed, true, '落盘项目档仍被越权判据排除（v1.12.14 读侧放开没生效）')
      assert.equal(esc.scope, 'project')
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

})

// ── v1.12.1 修复：路径规则写入键与判定键一致性 ──

describe('HostApprovalRules 路径规则键一致性（v1.12.1 修复）', () => {
  it('子代理会话写入的路径规则，子代理自己再发同路径请求时命中（键=rootSessionId）', () => {
    const rules = new HostApprovalRules()
    rules.addSessionRule('root-1', ['/a/b'])
    const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: ['/a/b/file.txt'], toolName: 'write' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session')
  })

  it('旧数据（写在 sessionId 键下）仍可用（decide 兜底查 sessionId）', () => {
    const rules = new HostApprovalRules()
    rules.addSessionRule('child-1', ['/a/b'])
    const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: ['/a/b/file.txt'], toolName: 'write' })
    assert.equal(d.allowed, true)
    assert.equal(d.scope, 'session')
  })

  it('rootId 键优先于 sessionId 键', () => {
    const rules = new HostApprovalRules()
    rules.addSessionRule('root-1', ['/a'])
    rules.addSessionRule('child-1', ['/a/b'])
    const d = rules.decide({ sessionId: 'child-1', rootSessionId: 'root-1', paths: ['/x/y/file.txt'], toolName: 'write' })
    assert.equal(d.allowed, false)
  })
})

// ════════════════════════════════════════════════════════════════════════
// 集成级测试：真实 index.js approval/request handler
// ════════════════════════════════════════════════════════════════════════
//
// 从 index.js 源码用花括号计数法提取 approval/request handler 函数体，
// 注入真实 HostApprovalRules + mock session/dispatcher，驱动真实判定逻辑。
// 与模拟函数不同：本测试绑定的是 index.js 的源码文本——如果有人改了
// handler 的判定顺序但没更新测试，断言会转红。

describe('真实审批监听器集成判定（index.js 的 ctx.on("approval/request") handler）', () => {
  // ── 从 index.js 源码提取 handler 函数体 ──
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
  const marker = "ctx.on('approval/request'"
  const markerIdx = indexSrc.indexOf(marker)
  const arrowIdx = markerIdx >= 0 ? indexSrc.indexOf('=>', markerIdx) : -1
  const openBrace = arrowIdx >= 0 ? indexSrc.indexOf('{', arrowIdx) : -1
  // 花括号计数找匹配的 }
  let closeBrace = -1
  if (openBrace >= 0) {
    let depth = 0
    for (let i = openBrace; i < indexSrc.length; i++) {
      if (indexSrc[i] === '{') depth++
      else if (indexSrc[i] === '}') {
        depth--
        if (depth === 0) { closeBrace = i; break }
      }
    }
  }
  const tail = closeBrace >= 0 ? indexSrc.slice(closeBrace + 1, closeBrace + 40).replace(/\s+/g, ' ') : ''
  const extractionOk = markerIdx >= 0 && arrowIdx >= 0 && openBrace >= 0 && closeBrace >= 0 && tail.includes('prepend: true')
  const handlerBody = extractionOk ? indexSrc.slice(openBrace + 1, closeBrace) : ''

  it('handler 提取自检：index.js 源码结构必须可识别', () => {
    if (markerIdx < 0) throw new Error('无法在 index.js 中找到 approval/request 注册——源码可能已变更')
    if (arrowIdx < 0) throw new Error('approval/request handler 箭头函数语法不匹配')
    if (closeBrace < 0) throw new Error('无法找到 approval/request handler 闭合花括号')
    if (!tail.includes('prepend: true')) throw new Error(`handler 闭合后未找到 prepend: true，实际内容: ${tail}`)
    // 注入表与 handler 体的闭包引用必须对齐（漏项会被 try/catch 吞成 next()，静默假红/假绿）
    const drift = handlerNameDrift()
    assert.deepEqual(drift, [], `handler 体引用了未注入的名字（ReferenceError 会被吞成 next()）：${drift.join(', ')}`)
  })

  // handler 源码引用的闭包名（**必须与 handler 体逐一对齐**）：漏一个不会报错到
  // 显眼处，而是 ReferenceError 被 handler 自己的 try/catch 吞掉 → 退化成 next()，
  // 于是「本该放行」的用例集体转红、看起来像判定逻辑坏了。v1.12.6 的危险命令门
  // （dangerousCommandMatch）就踩过这个坑：注入表没跟上，①⑤⑧⑨⑫ 一起红。
  // 下面的 handlerNameDrift() 是硬守卫：handler 体新增闭包引用而注入表没跟上，直接报名字。
  const CLOSURE_NAMES = [
    'resolveApprovalContext', 'resolveRootSessionId', 'isDisallowedAutoGrant', 'isAcpTwinApproval',
    'isDelegatedSession', 'dangerousCommandMatch',
    // v1.12.6 第五轮（终审 Minor 2）：门判据文本的有界截断（`boundDangerText` 是被调用
    // 的闭包引用，`MAX_DANGER_TEXT_CHARS` 是它留在日志文案里的常量）。新增闭包引用就
    // **必须**在这里登记——下面的 handlerNameDrift() 是硬守卫，漏项会直接报出名字。
    'boundDangerText', 'MAX_DANGER_TEXT_CHARS',
    // v1.12.6 第六轮（终审 Minor 3）：`commandText` 超限即保守转交互 —— 门名是 handler 体
    // 引用的**常量**（不是被调用的函数，所以 handlerNameDrift() 抓不到它）。
    // 漏登记的后果同样是 ReferenceError 被 handler 的 try/catch 吞掉 ⇒ 退化成放行。
    'COMMAND_TOO_LONG_RULE',
    // v1.12.7（拆开判据 + 解耦 sessionOnly）：handler 体新增了 `isSandboxEscalation(...)`
    // 这**第二个**判据调用点（`const sessionOnly = isSandboxEscalation(ctxInfo.reason)`）。
    // 不登记就会被 try/catch 吞成 next()，于是「本该 allowed-once」的越权用例集体假红
    // —— 本轮实测正是这个症状（②⑧⑨⑫ 一起红，看着像判定逻辑坏了）。
    'isSandboxEscalation',
  ]

  /** 从 handler 体扒出「被当函数调用」的标识符，返回不在注入表里的那些 */
  function handlerNameDrift() {
    if (!extractionOk) return []
    const called = new Set(
      [...handlerBody.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]),
    )
    const known = new Set([...CLOSURE_NAMES, 'req', 'next', 'hostApproval', 'dispatcher', 'logApproval'])
    // 语法关键字（不是闭包引用）
    for (const skip of ['if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function', 'await']) known.add(skip)
    return [...called].filter((name) => !known.has(name))
  }

  function compileHandler(hostApproval, dispatcher) {
    if (!extractionOk) return null
    const fn = new Function(
      'req', 'next',
      ...CLOSURE_NAMES,
      'hostApproval', 'dispatcher', 'logApproval',
      handlerBody,
    )
    return (req, next) => fn(
      req, next,
      resolveApprovalContext, resolveRootSessionId, isDisallowedAutoGrant, isAcpTwinApproval, isDelegatedSession,
      dangerousCommandMatch,
      boundDangerText, MAX_DANGER_TEXT_CHARS,
      COMMAND_TOO_LONG_RULE,
      isSandboxEscalation,
      hostApproval, dispatcher, () => {},
    )
  }

  // ── 辅助：构造 mock session ─
  // 宿主口径：委派子会话必带 origin:'subagent' + delegationDepth>0
  //（dsh-subagent childSessionMeta），fork 只带 parentSession（见下方 fork 用例）。
  function mkSession(id, parentSession, toolCalls) {
    const events = []
    if (toolCalls) {
      for (const tc of toolCalls) {
        events.push({ type: 'tool/call', data: { callId: tc.callId, name: tc.name, arguments: tc.arguments } })
      }
    }
    return {
      id,
      seq: events.length,
      eventAt: (seq) => events[seq] ?? null,
      header: {
        cwd: '/home/test',
        ...(parentSession ? { parentSession, origin: 'subagent', delegationDepth: 1 } : {}),
      },
    }
  }

  // ── 辅助：调用 handler 并捕获结果 ──
  async function callHandler(handler, { session, callId, toolName, reason }) {
    let nextCalled = false
    const next = () => { nextCalled = true }
    const req = {
      agent: { session },
      callId: callId || null,
      toolName: toolName || null,
      reason: reason || null,
    }
    const result = await handler(req, next)
    return { result, nextCalled }
  }

  // ── 5 条必须覆盖的用例 ──

  it('① 顺序哨兵：已授权 bash + 零路径 → allowed-once，nextCalled=false', async () => {
    const hostApproval = new HostApprovalRules()
    hostApproval.addToolGrant('root-1', 'bash')
    // v1.12.6：必须带 tool/call 记录——危险命令门对「执行类调用但命令文本解析不出」
    // 一律不自动放行（保守策略）。没有记录时这条用例会先被那道门拦下，断言就不在
    // 「工具名短路是否生效」这一层上了。命令是普通命令，因此仍必须走工具名档。
    const session = mkSession('child-1', 'root-1', [{ callId: 'call-1', name: 'bash', arguments: { command: 'echo hi' } }])
    const dispatcher = { activeChildren: new Map() }
    const handler = compileHandler(hostApproval, dispatcher)

    const { result, nextCalled } = await callHandler(handler, {
      session, callId: 'call-1', toolName: 'bash', reason: null,
    })
    assert.equal(result, 'allowed-once')
    assert.equal(nextCalled, false)
  })

  it('② 已授权 bash + 越权 reason（路径可解析、未被路径规则覆盖）→ allowed-once（v1.12.7 工具档不再排除越权）', async () => {
    const hostApproval = new HostApprovalRules()
    hostApproval.addToolGrant('root-1', 'bash')
    // v1.12.5：带上真实 tool/call 记录。原用例的 session 没有 toolCalls ⇒
    // resolveApprovalContext 解析不出任何路径 ⇒ handler 在「paths 为空」那条就
    // return next()，根本没走到排除门，断言等于在测一条无关分支。补记录后
    // paths 非空、路径规则为空 —— v1.12.7 之前 next() 只能由「越权不吃工具名短路」
    // 解释；拆开判据之后越权照吃工具名档 ⇒ allowed-once（本用例随裁定反转）。
    const session = mkSession('child-1', 'root-1', [
      { callId: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'cat /tmp/proj/a.txt' }) },
    ])
    const dispatcher = { activeChildren: new Map() }
    const handler = compileHandler(hostApproval, dispatcher)

    const { result, nextCalled } = await callHandler(handler, {
      session, callId: 'call-1', toolName: 'bash',
      reason: 'escalate sandbox to danger-full-access: need unrestricted access',
    })
    assert.equal(result, 'allowed-once', 'v1.12.7：越权请求必须消费工具名档')
    assert.equal(nextCalled, false)
  })

  it('③ 已授权 product_submit + [ACP ...] reason → next()', async () => {
    const hostApproval = new HostApprovalRules()
    hostApproval.addToolGrant('root-1', 'product_submit')
    const session = mkSession('child-1', 'root-1')
    const dispatcher = { activeChildren: new Map() }
    const handler = compileHandler(hostApproval, dispatcher)

    const { result, nextCalled } = await callHandler(handler, {
      session, callId: 'call-2', toolName: 'product_submit',
      reason: '[ACP qoder] 请求权限：submit',
    })
    assert.equal(nextCalled, true)
    assert.notEqual(result, 'allowed-once')
  })

  it('④ 未授权工具 → next()', async () => {
    const hostApproval = new HostApprovalRules()
    hostApproval.addToolGrant('root-1', 'bash')
    const session = mkSession('child-1', 'root-1', [
      { callId: 'call-3', name: 'write', arguments: JSON.stringify({ file: '/tmp/x.txt' }) },
    ])
    const dispatcher = { activeChildren: new Map() }
    const handler = compileHandler(hostApproval, dispatcher)

    const { result, nextCalled } = await callHandler(handler, {
      session, callId: 'call-3', toolName: 'write', reason: 'tool requires approval',
    })
    assert.equal(nextCalled, true)
  })

  it('⑤ 子会话（header.parentSession=root）→ 命中根会话授权 → allowed-once', async () => {
    const hostApproval = new HostApprovalRules()
    hostApproval.addToolGrant('root-1', 'bash')
    // 同 ①：带一条普通命令的 tool/call 记录，避开危险命令门的保守策略
    const session = mkSession('child-1', 'root-1', [{ callId: 'call-5', name: 'bash', arguments: { command: 'echo hi' } }])
    const dispatcher = { activeChildren: new Map() }
    const handler = compileHandler(hostApproval, dispatcher)

    const { result, nextCalled } = await callHandler(handler, {
      session, callId: 'call-5', toolName: 'bash', reason: null,
    })
    assert.equal(result, 'allowed-once')
    assert.equal(nextCalled, false)
  })

  // ── v1.12.4 阻断：真实 handler 面对 fork 形态会话 ──

  it('⑥ fork 会话：真实 handler 不登记 fork→源 映射，暂存上下文根 id = fork 自身', async () => {
    const hostApproval = new HostApprovalRules()
    const dispatcher = { activeChildren: new Map() }
    const handler = compileHandler(hostApproval, dispatcher)
    // fork 形态：parentSession 指向源会话，但无 origin / delegationDepth
    const fork = {
      id: 'fork-1', seq: 1,
      eventAt: () => ({ type: 'tool/call', data: { callId: 'c-fork', name: 'write', arguments: JSON.stringify({ file_path: '/tmp/a.txt' }) } }),
      header: { cwd: '/home/test', parentSession: 'root-1', isSeeded: true }, // 新版宿主的 fork 头
    }
    await callHandler(handler, { session: fork, callId: 'c-fork', toolName: 'write', reason: '需要写权限' })
    // 注册点必须按同一判据把关：fork 不是委派子会话 → #sessionRoots 里不能有它
    assert.equal(hostApproval.sessionRootOf('fork-1'), null, 'fork→源会话 映射被登记了（阻断 1 复现）')
    // 端点写规则用的就是这个暂存 rootSessionId → 它必须是 fork 自身
    assert.equal(hostApproval.peekPendingContext('c-fork').rootSessionId, 'fork-1')
  })

  it('⑦ fork 已授权 bash → 源会话 root-1 的请求仍走人工审批（不静默放行）', async () => {
    const hostApproval = new HostApprovalRules()
    const dispatcher = { activeChildren: new Map() }
    const handler = compileHandler(hostApproval, dispatcher)
    const fork = { id: 'fork-1', seq: 0, eventAt: () => null, header: { cwd: '/home/test', parentSession: 'root-1', seedLength: 8 } }
    // 先让真实 handler 解析 fork 的根 → 按解析结果授权（等价于用户点了「本会话总是允许该工具」）
    const rootForFork = resolveRootSessionId(fork, dispatcher, (sid) => hostApproval.sessionRootOf(sid))
    assert.equal(rootForFork, 'fork-1')
    hostApproval.addToolGrant(rootForFork, 'bash')
    const { result, nextCalled } = await callHandler(handler, {
      session: mkSession('root-1', null), callId: null, toolName: 'bash', reason: null,
    })
    assert.equal(nextCalled, true, '源会话被 fork 的授权静默放行了')
    assert.notEqual(result, 'allowed-once')
  })

  // ── v1.12.5（用户裁定）：越权的排除门按档位拆分；v1.12.7 第三次裁定再收窄 ──
  // 1.12.x 把「沙箱越权」做成了无条件 return next()，读取侧连路径档一起废掉 ⇒
  // 用户在某个目录点过一次「总是允许」后，同一路径的越权仍然每次都弹。
  // v1.12.5 恢复路径档，但**同时把越权从工具名档里逐请求排除**——副作用是
  // 「点过一次本会话总是允许该工具」写下的工具名授权永远读不到，用户本机几乎只有
  // 越权这一类弹框 ⇒ 工具名档在实战中形同失效。
  // v1.12.7 裁定：越权**照吃工具名档**（同一主会话内该工具对任意路径放行，含工作区外），
  // 唯一保留的约束是「不写落盘项目档」。危险命令门排在最前，永远走交互。
  // 下面四条钉的是：①越权吃工具名短路、②路径规则对越权仍生效、③非越权零变化
  // （外加 ACP 孪生的早退门必须仍然先于所有档位、项目档对越权仍然抑制）。

  /** 越权请求的共用 fixture：真实 bash tool/call 记录 ⇒ 可解析出 /tmp/proj/a.txt */
  const mkEscalationSession = (id, parent, callId = 'c-esc') => mkSession(id, parent, [
    { callId, name: 'bash', arguments: JSON.stringify({ command: 'cat /tmp/proj/a.txt' }) },
  ])
  const ESC_REASON = 'escalate sandbox to read-write: need to write outside the sandbox'

  it('⑧ 越权 + 会话路径规则已覆盖该路径 → allowed-once（路径级记忆对越权仍然生效）', async () => {
    // v1.12.7 注意：本 fixture **没有**工具名授权（只有 addSessionRule），否则会先被
    // 工具名档短路，这条就测不到路径档了。路径档对越权生效是 v1.12.5 的裁定，本次不动。
    const hostApproval = new HostApprovalRules()
    hostApproval.addSessionRule('root-1', ['/tmp/proj/a.txt'])
    const handler = compileHandler(hostApproval, { activeChildren: new Map() })

    const { result, nextCalled } = await callHandler(handler, {
      session: mkEscalationSession('child-1', 'root-1'), callId: 'c-esc', toolName: 'bash', reason: ESC_REASON,
    })
    assert.equal(result, 'allowed-once', '同一路径的越权请求必须被路径级记忆放行（v1.11.24 等价）')
    assert.equal(nextCalled, false)
  })

  it('⑨ 差分对照（v1.12.7 反转）：同一 setup 下越权与非越权**都**吃工具名档，只有项目档/路径档才分档', async () => {
    // setup 完全相同，唯一变量是 reason —— v1.12.7 之后两者都命中工具名档（不变式①反转）；
    // 「越权与非越权分档」这件事改由 ⑫ 的落盘项目档（sessionOnly）与
    // dangerous-command-gate.test.js 的危险命令门来钉。
    const mk = () => {
      const hostApproval = new HostApprovalRules()
      hostApproval.addToolGrant('root-1', 'bash') // 工具名档命中；路径档没有任何规则
      return compileHandler(hostApproval, { activeChildren: new Map() })
    }
    const plain = await callHandler(mk(), {
      session: mkEscalationSession('child-1', 'root-1'), callId: 'c-esc', toolName: 'bash',
      reason: 'tool requires approval',
    })
    assert.equal(plain.result, 'allowed-once', '非越权请求的工具名短路被改动了（不变式③）')
    assert.equal(plain.nextCalled, false)

    const esc = await callHandler(mk(), {
      session: mkEscalationSession('child-1', 'root-1'), callId: 'c-esc', toolName: 'bash', reason: ESC_REASON,
    })
    assert.equal(esc.result, 'allowed-once', 'v1.12.7：越权必须照吃工具名短路（裁定「工具档不受越权限制」）')
    assert.equal(esc.nextCalled, false)
  })

  it('⑩ 越权 + 解析不出路径（无 tool/call 记录可反查）→ next()，与 v1.11.24 一致', async () => {
    const hostApproval = new HostApprovalRules()
    // 即使路径规则里写着 /tmp/proj，反查不到 tool/call 记录 ⇒ paths 恒空 ⇒
    // 路径档无从参与（allowlistDecision 对空 paths 一律不放行）。
    hostApproval.addSessionRule('root-1', ['/tmp/proj'])
    const handler = compileHandler(hostApproval, { activeChildren: new Map() })

    const { result, nextCalled } = await callHandler(handler, {
      session: mkSession('child-1', 'root-1'), callId: 'c-none', toolName: 'bash', reason: ESC_REASON,
    })
    assert.equal(nextCalled, true)
    assert.notEqual(result, 'allowed-once')
  })

  it('⑪ ACP 孪生仍完全绕过：路径规则覆盖它也不放行（早退门先于所有档位）', async () => {
    const hostApproval = new HostApprovalRules()
    hostApproval.addSessionRule('root-1', ['/tmp/proj/a.txt'])
    const handler = compileHandler(hostApproval, { activeChildren: new Map() })
    const session = mkSession('child-1', 'root-1', [
      { callId: 'c-acp', name: 'product_submit', arguments: JSON.stringify({ file_path: '/tmp/proj/a.txt' }) },
    ])

    const { result, nextCalled } = await callHandler(handler, {
      session, callId: 'c-acp', toolName: 'product_submit', reason: '[ACP qoder] 请求权限：submit',
    })
    assert.equal(nextCalled, true, 'ACP 孪生被路径规则放行了——早退门必须仍然先于所有档位')
    assert.notEqual(result, 'allowed-once')
  })

  // v1.12.5 二次裁定（用户）：越权**不得**走落盘项目档 —— 这是 v1.12.7 之后越权
  // **唯一**保留的档位约束（工具档与路径档都正常消费它）。这条只在 handler 层钉
  // （decide 层的 sessionOnly 用例已另立）：handler 才是生产唯一入口，它必须把
  // sessionOnly 真正带上；漏传时越权会被项目白名单静默放行。
  // v1.12.7 的解耦点：`sessionOnly: disallowToolGrant` 那个焊点必须拆开——判据拆开
  // 后 disallowToolGrant 恒 false，焊点若还在，越权就会连项目档一起放开（跨会话提权）。
  // v1.12.14（用户裁定）：v1.12.5 的「越权不得走落盘项目档」读侧守卫被放开——
  // 写侧既然按用户显式选择照落盘，读侧再抑制就等于「落盘了也读不到」。本用例保留
  // 同一个 handler 层夹具（生产唯一入口），把期望翻面：越权由落盘项目档放行，
  // 非越权对照照旧放行（证明项目档没被整个废掉）。
  it('⑫ 越权 + 只有落盘项目档覆盖该路径 → allowed-once（项目档对越权同样参与，v1.12.14）', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-12-'))
    const prev = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const mk = () => {
        const hostApproval = new HostApprovalRules()
        // 只落盘项目档：会话路径规则与工具名授权都为空，放行只可能来自项目档
        hostApproval.appendProjectRule({ cwd: '/home/test', paths: ['/tmp/proj/a.txt'] })
        assert.deepEqual(hostApproval.sessionRules('root-1'), [])
        assert.deepEqual(hostApproval.toolGrants('root-1'), [])
        return compileHandler(hostApproval, { activeChildren: new Map() })
      }
      const esc = await callHandler(mk(), {
        session: mkEscalationSession('child-1', 'root-1'), callId: 'c-esc', toolName: 'bash', reason: ESC_REASON,
      })
      assert.equal(esc.result, 'allowed-once', '越权没吃到落盘项目档（v1.12.14 读侧对称放开的靶子）')
      assert.equal(esc.nextCalled, false)

      // 差分对照：同一份落盘规则、同一 fixture，非越权请求同样必须放行
      const plain = await callHandler(mk(), {
        session: mkEscalationSession('child-1', 'root-1'), callId: 'c-esc', toolName: 'bash',
        reason: 'tool requires approval',
      })
      assert.equal(plain.result, 'allowed-once', '非越权的项目档放行被一起改掉了（超出裁定范围）')
      assert.equal(plain.nextCalled, false)
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

})
