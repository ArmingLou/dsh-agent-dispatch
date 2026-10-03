/**
 * v1.11.23：集成层降级留痕（logDiagnostic）回归测试。
 *
 * 被测的真实缺陷：DSH 的 stdout 是 VS Code 终端的 unix socket（不是文件），
 * `index.js` 里 `console.error('[dsh-agent-dispatch] …订阅失败…')` 只在终端闪一下，
 * 进程重启后不留任何痕迹。而这几条降级路径恰恰最需要事后回溯：
 *   - `product-subagents/submit-failed` 订阅失败 → 整个自动换档静默失效；
 *   - 回合内换档处理器登记失败 → 退回 v1.11.21 的"结算后换档"，通知时机变了。
 *
 * 断言两件事：
 *   1) 【行为】logDiagnostic 真的按 #log 的既有行格式（{ts, kind, ...}）追加落盘；
 *   2) 【接线】index.js 的订阅失败分支确实走 warn → dispatcher.logDiagnostic，
 *      而不是又一个纯 console.error（沿用本仓对 index.js 用源码护栏的既有做法，
 *      见 host-0.2-compat.test.js:327）。
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Dispatcher } from '../lib/dispatch.js'

function readRows(dataDir) {
  return readFileSync(join(dataDir, 'dispatches.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

describe('v1.11.23：集成层降级留痕', () => {
  it('logDiagnostic 按既有行格式追加落盘（与 #log 同规格）', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-diag-'))
    const dispatcher = new Dispatcher({ ctx: {}, registry: { get: () => null }, dataDir })

    dispatcher.logDiagnostic({
      kind: 'plugin-warn',
      component: 'submit-failed-subscribe',
      ok: false,
      message: 'product-subagents/submit-failed 订阅失败（旧版 product-subagents?）: boom',
    })

    const rows = readRows(dataDir)
    assert.equal(rows.length, 1, '必须落一行')
    const [row] = rows
    assert.equal(row.kind, 'plugin-warn', 'kind 必须可 grep')
    assert.equal(row.component, 'submit-failed-subscribe')
    assert.equal(row.ok, false)
    assert.match(row.message, /订阅失败/, '保留人类可读原因')
    assert.ok(!Number.isNaN(Date.parse(row.ts)), `ts 必须是 ISO 时间戳（与 #log 同规格）：${row.ts}`)
    assert.ok(typeof row.ts === 'string' && row.ts.endsWith('Z'), `ts 应为 ISO 结尾 Z：${row.ts}`)
  })

  it('多次调用按行追加，不覆盖既有内容', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'dispatch-diag-append-'))
    const dispatcher = new Dispatcher({ ctx: {}, registry: { get: () => null }, dataDir })

    dispatcher.logDiagnostic({ kind: 'plugin-warn', component: 'a', ok: false, message: '第一条' })
    dispatcher.logDiagnostic({ kind: 'plugin-warn', component: 'b', ok: false, message: '第二条' })

    const rows = readRows(dataDir)
    assert.equal(rows.length, 2, '两次调用 = 两行（append，不得覆盖）')
    assert.deepEqual(rows.map((r) => r.component), ['a', 'b'])
  })

  it('写盘失败不抛（留痕不得影响降级本身）', () => {
    // 造一个 mkdir 必失败的路径：把 dataDir 的父级占成一个普通文件
    const base = mkdtempSync(join(tmpdir(), 'dispatch-diag-block-'))
    const blocker = join(base, 'blocker')
    writeFileSync(blocker, 'x')
    const dispatcher = new Dispatcher({
      ctx: {},
      registry: { get: () => null },
      dataDir: join(blocker, 'sub'),
    })

    assert.doesNotThrow(() => {
      dispatcher.logDiagnostic({ kind: 'plugin-warn', component: 'x', ok: false, message: '写不进去也必须不抛' })
    }, '#log 写盘失败只 console.error，不得把异常抛回降级路径')
  })

  it('接线护栏：index.js 的 submit-failed 订阅失败分支必须落盘，不得只是 console.error', () => {
    const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8')

    // 1) 订阅失败分支走 warn（而不是又一个纯 console.error）
    assert.match(
      src,
      /warn\('product-subagents\/submit-failed 订阅失败（旧版 product-subagents\?）',\s*err,\s*'submit-failed-subscribe'\)/,
      'submit-failed 订阅失败必须走 warn（console.error + 落盘），否则 DSH 的 unix socket stdout 让它不可回溯',
    )
    // 2) 换档处理器登记失败同样落盘（这是"通知时机变了"的那条降级，最难事后发现）
    assert.match(
      src,
      /warn\('回合内换档处理器登记失败',\s*err,\s*'failover-handler-register'\)/,
      '换档处理器登记失败必须落盘',
    )
    // 3) warn 本体确实调了 dispatcher.logDiagnostic
    const warnBody = src.match(/const warn = \(text, err, component\) => \{[\s\S]*?\n  \}/)
    assert.ok(warnBody, '必须定义 warn 辅助函数')
    assert.match(warnBody[0], /dispatcher\.logDiagnostic\(\{/, 'warn 必须调 dispatcher.logDiagnostic')
    assert.match(warnBody[0], /kind: 'plugin-warn'/, '落盘行必须带可 grep 的 kind')
    // 4) 旧的纯 console.error 文案不得再残留（否则等于没改）
    assert.equal(
      src.includes("console.error('[dsh-agent-dispatch] product-subagents/submit-failed 订阅失败"),
      false,
      '旧的纯 console.error 订阅失败文案必须已被 warn 取代',
    )
  })
})
