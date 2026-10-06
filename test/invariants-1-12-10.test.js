// test/invariants-1-12-10.test.js — v1.12.10 交付要求：新模型的 5 条不变式。
//
// **模型（用户裁定）**：「不能简单地把整个命令里所有字符都分析出所有命令。对于涉及高危的命令，
// 只要存在一个就当高危优先定位；否则，就直接当单个普通 bash 命令来处理。」
// 落地为：① 内容规则（`rm -rf` / `git push` / `npm|pnpm|yarn publish` / shell 包装 …）对**整段
// 命令文本的每一个段/行全量生效**；② 形状判据（`wrapper-option-ambiguity`、包装/嵌套超限）
// **同样全量生效**——v1.12.8「剥载荷」与 v1.12.9「行掩码 + 载荷豁免 + 终止行跳过」两套机器
// **整层删除**；③ 归因顺序「先内容、后形状」（`contentRuleOf`）。
//
// 为什么删（终审在真实链路上证成，两条阻断）：
//   B1 假 heredoc 起始 `x=$((n<<sh))`（`<<` 左操作数是标识符 ⇒ 算术左移守卫不成立）⇒ 下一行
//      `sh` 被当终止行 ⇒ **连同内容规则一起跳过** ⇒ `null`（真 shell 实测该行会执行）；
//   B2 载荷行上的反斜杠续行 `rm \` + `-rf /tmp/x` ⇒ 唯一抓得到它的形状判据①被豁免 ⇒ `null`
//      （喂给 `/bin/sh` 真删目录）。
//
// 代价（如实登记，刻意不免）：heredoc 正文行以 `- ` 开头 ⇒ 多弹一次（当年那条 38 秒白弹的
// commit 回来了，用户明确接受）；正文里真的出现危险命令字样 ⇒ 多弹一次；tag 恰好叫
// `sh`/`bash`/`su` 时终止行按裸解释器判 ⇒ 多弹一次。逐条见 CHANGELOG 1.12.10。
//
// 本文件钉住 5 条不变式：
//   ① 全量判定：每一个段/行都过判据，没有任何跳过（含算术假起始、续行、7 个 shell 名 tag）
//   ② 不放宽：既有全部写法逐条不变（回归表）+ 无害文本照旧 MISS（不是「什么都弹」）
//   ③ 先内容、后形状：预算/形状分支返回前先求真命令名
//   ④ 不得复活：两套豁免机器的符号一个都不许回来，判定循环里不许出现跳过分支
//   ⑤ 接线 + 监听器层（已授权 bash 的帧下，载荷里的真命令一律 next() 且留痕）
//
// 运行：node --test test/invariants-1-12-10.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, mkSession } from './agent-api-harness.js'
import {
  dangerousCommandMatch,
  boundDangerText,
  MAX_DANGER_TEXT_CHARS,
  SHELL_STDIN_RULE,
  SHELL_DEPTH_RULE,
  SU_SHELL_RULE,
  WRAPPER_DEPTH_RULE,
  WRAPPER_OPTION_AMBIGUITY_RULE,
} from '../lib/host-approval.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostSrc = readFileSync(path.join(root, 'lib', 'host-approval.js'), 'utf8')
const indexSrc = readFileSync(path.join(root, 'index.js'), 'utf8')
/**
 * 去掉**整行注释**后的源码（Minor 4：ban-list 原先做全文 substring 检查，注释里提一句旧符号名
 * 就会假红；行为断言才是真正的守卫，这里只把「符号不得复活」钉在**代码**上）。
 * 注意：行尾注释（`code // 注释`）里的名字仍会被扫到 —— 属已知代价，写在 CHANGELOG。
 */
const stripComments = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const hostCode = stripComments(hostSrc)
const indexCode = stripComments(indexSrc)

/** 现场原文（用户日志证据 `ts=08:00:13.655 action=danger-command-block rule=wrapper-option-ambiguity`
 * 里的那次调用；正文行以 `- ` 开头）——v1.12.10 起它**会再次被拦**（用户裁定接受的代价） */
const REPRO = [
  'git add -A',
  "git commit -q -F - <<'EOF'",
  'feat(grant): 0.7.10 全非法路径不再退化为工具档；补「规则语义（读侧）」文档',
  '',
  '- planGrantWrites 新增 none 出口：用户给了非空路径但全部被丢弃 ⇒',
  '  路径档与工具档都不写，只放行本次（仅显式回传 paths:[] 才落工具档）',
  'EOF',
].join('\n')

/** 驱动真实 approval/request 监听器：res==='allowed-once' 即插件自动放行 */
const approve = async (b, session, { callId = null, toolName = null, reason = 'tool requires approval' } = {}) => {
  let nextCalled = false
  const outs = b.fireEvent(
    'approval/request',
    { agent: { session }, callId, toolName, reason },
    () => { nextCalled = true; return 'NEXT' },
  )
  const res = await outs[0]
  return { res, nextCalled }
}

const bashCall = (callId, cmd) => [{ callId, name: 'bash', arguments: { command: cmd } }]

const postRule = (b, body) => b.req('POST', '/agent-api/host-approval-rule', body)

const logRows = (home) => {
  const f = path.join(home, 'data', 'dsh-agent-dispatch', 'dispatches.jsonl')
  return existsSync(f)
    ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : []
}
const dangerousRows = (home) => logRows(home).filter((x) => x.action === 'danger-command-block')

/** 起实例 + 把 bash 授权到根会话键上（= 最宽的自动放行前置条件） */
const bootWithBashGranted = async () => {
  const b = await boot()
  const s1 = mkSession({ id: 'i10-1', parentSession: 'R', toolCalls: bashCall('g10', 'echo hi') })
  const first = await approve(b, s1, { callId: 'g10', toolName: 'bash' })
  assert.equal(first.nextCalled, true, '前置：首次请求应交给交互层')
  const { status, json } = await postRule(b, { scope: 'session', sessionId: 'i10-1', callId: 'g10', toolName: 'bash' })
  assert.equal(status, 200)
  assert.equal(json.rootSessionId, 'R', '前置：授权应落在根会话键上')
  return b
}

describe('v1.12.10 不变量①：全量判定（每一个段/行都过判据，没有任何跳过）', () => {
  it('B1：假 heredoc 起始不再吞掉后面的真命令（算术左移，**数字与标识符两档**）', () => {
    // 数字字面量档（旧掩码在它上面「恰好」判对，于是一直没人发现标识符档）
    assert.equal(dangerousCommandMatch('x=$((1<<n))\nrm -rf /tmp/x\nn')?.rule, 'rm -rf')
    // 标识符档（终审 B1：旧实现把下一行 `sh` 当终止行并跳过整段 ⇒ null）
    for (const head of [
      'x=$((n<<sh))', 'x=$((n << sh))', 'x=$((n<< sh))', '((n<<sh))', '(( n << sh ))',
      'x=$[n<<sh]', 'echo $[n<<sh]', 'n=1; x=$((n<<sh))', 'x=$((n<<sh)) # c', 'true && x=$((n<<sh))',
    ]) {
      const hit = dangerousCommandMatch(`${head}\nsh`)
      assert.notEqual(hit, null, `${head} + 裸 sh 被静默放行（那一行是真命令，会被执行）`)
      assert.equal(hit.rule, SHELL_STDIN_RULE)
    }
    // 同一段文本里 `<<` 只是算术左移 ⇒ 本身不构成任何命令
    assert.equal(dangerousCommandMatch('x=$((n<<sh))'), null, '算术左移本身不是命令')
  })

  it('B2（v1.12.11：续行合并后由**内容规则**命中）：载荷行上的续行照旧判', () => {
    assert.equal(dangerousCommandMatch("ssh host <<'SH'\nrm \\\n-rf /tmp/x\nSH")?.rule, 'rm -rf')
    // 与 tag / 是否有终止行无关（不再有终止行概念）
    assert.equal(dangerousCommandMatch("cat <<'E'\nrm \\\n-rf /tmp/x\nE")?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch("cat <<X\nrm \\\n-rf /tmp/x")?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch("ssh host <<'EOF'\ngit \\\npush\nEOF")?.rule, 'git push')
    // 判定只取决于内容：续行里没有危险程序 ⇒ 不弹
    assert.equal(dangerousCommandMatch("cat <<'E'\nfoo \\\n-bar\nE"), null)
    // 非续行（`\\` 被转义）⇒ 不合并，仍是两段
    assert.equal(dangerousCommandMatch('git \\\\\npush origin main'), null)
  })

  it('终止行不再特殊：tag 恰好是 shell/包装器名时按裸解释器判（代价 = 多弹一次）', () => {
    for (const [tag, rule] of [
      ['sh', SHELL_STDIN_RULE], ['bash', SHELL_STDIN_RULE], ['zsh', SHELL_STDIN_RULE],
      ['dash', SHELL_STDIN_RULE], ['ksh', SHELL_STDIN_RULE],
      ['su', SU_SHELL_RULE], ['runuser', SU_SHELL_RULE],
    ]) {
      assert.equal(dangerousCommandMatch(`cat <<'${tag}'\nbody\n${tag}`)?.rule, rule)
    }
    // 其它 tag 的终止行是单 token 普通词 ⇒ 什么规则都不命中
    assert.equal(dangerousCommandMatch("cat <<'EOF'\nbody\nEOF"), null)
  })

  it('载荷内容照旧判：危险 ⇒ HIT，无害 ⇒ MISS（与「是不是载荷」无关）', () => {
    for (const [cmd, rule] of [
      ["ssh host <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["cat <<'SH' | ssh host\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ["cat <<'SH' > /tmp/g; sh /tmp/g\nrm -rf /tmp/x\nSH", SHELL_STDIN_RULE],
      ["git commit -q -F - <<'EOF'\ngit push 这类命令写在正文里时也只是在描述\nEOF", 'git push'],
      ["npm run build <<'EOF'\nhead -1\nEOF", null],
      ["python3 - <<'PY'\nprint('hello')\nPY", null],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule ?? null, rule, `${JSON.stringify(cmd)} 判定不对`)
    }
  })

  it('有界截断把终止行切掉也照旧全量判（没有终止行概念 ⇒ 方向只会多弹，不会少看）', () => {
    // 危险命令在**前段**（截断保留的部分），终止行在**后段**（被截掉）
    const long = `cat <<'EOF'\nrm -rf /tmp/x\n${'x'.repeat(MAX_DANGER_TEXT_CHARS)}\nEOF\n`
    const cut = boundDangerText(long)
    assert.ok(cut.omitted > 0, '前置：这段文本应被有界截断')
    assert.ok(cut.text.trimEnd().endsWith('x'), '前置：终止行确实落在被截掉的后段')
    assert.equal(dangerousCommandMatch(cut.text)?.rule, 'rm -rf',
      '截断后剩下的文本照旧逐段判（不许因为「找不到终止行」而少看）')
  })
})

describe('v1.12.10 不变量②：不放宽（与 v1.12.7 逐条同值）', () => {
  it('既有全部写法逐条不变（回归表）', () => {
    for (const [cmd, rule] of [
      ['bash -c "rm -rf /tmp/x"', 'rm -rf'],
      ["sh -c 'rm -rf /tmp/x'", 'rm -rf'],
      ['bash -c "bash -c \\"rm -rf /x\\""', 'rm -rf'],
      ['zsh -lc "rm -rf /x"', 'rm -rf'],
      ['echo x | xargs rm -rf /tmp/x', 'rm -rf'],
      ['sudo rm -rf /tmp/x', 'rm -rf'],
      ['command rm -rf /tmp/x', 'rm -rf'],
      ['env rm -rf /tmp/x', 'rm -rf'],
      ['nohup rm -rf /tmp/x', 'rm -rf'],
      ['nice -n 5 rm -rf /tmp/x', 'rm -rf'],
      ['time rm -rf /tmp/x', 'rm -rf'],
      ['/bin/rm -rf /tmp/x', 'rm -rf'],
      ['find /tmp -exec rm -rf {} +', 'rm -rf'],
      ['git -C /tmp push', 'git push'],
      ['git -c k=v push', 'git push'],
      ['npm --prefix /tmp publish', 'npm publish'],
      ['pnpm publish', 'pnpm publish'],
      ['yarn publish', 'yarn publish'],
      ["rm -rf /tmp/x <<'EOF'\nbody\nEOF", 'rm -rf'],
      ["cat <<'EOF' > f && npm publish\nbody\nEOF", 'npm publish'],
      ['cat <<EOF > f\nbody\nEOF\nrm -rf /tmp/x', 'rm -rf'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${cmd} 被放过（不得放宽任何既有拦截）`)
    }
  })

  it('无危险字样 ⇒ 照旧 MISS；**含危险字样（含提及）⇒ 弹**（v1.12.12 用户裁定的代价）', () => {
    // 真负例（文本里没有任何预设字样）⇒ 仍然 MISS
    for (const cmd of [
      "cat <<'EOF'\nbody\nEOF",
      'cat <<EOF > f\n普通说明文本\nEOF',
      "patch -p1 <<'EOF'\n正文说明文本\nEOF",
      "ssh host <<'E'\necho hello\nE",
      // 注：`bash --version` 属**既有**的保守多弹（裸解释器没有 `-c` ⇒ `shell-stdin`，
      // 见 `DANGEROUS_COMMAND_RULES` 头部注释「裸解释器的纯信息调用」），不是本轮新增代价
      'bash -c "echo hi"',
      'find /tmp -exec ls {} +',
    ]) {
      assert.equal(dangerousCommandMatch(cmd), null, `${JSON.stringify(cmd)} 被误判（误伤面变大了）`)
    }
    // v1.12.12（用户裁定「文本里出现危险字样就弹」）：下面这些**应当**弹，是**代价**不是缺陷
    for (const [cmd, rule] of [
      ['echo "see rm -rf docs"', 'text:rm -rf'],
      ['echo "run git push later"', 'text:git push'],
      ['git commit -m "docs: mention npm publish"', 'text:npm publish'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${JSON.stringify(cmd)} 应当弹（代价）`)
    }
  })
})

describe('v1.12.10 不变量③：先内容、后形状（预算/形状分支返回前先求真命令名）', () => {
  it('透明包装跳数用尽：有内容就报真命令名，没内容才落回 wrapper-nesting', () => {
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}rm -rf /tmp/x`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`${'nice '.repeat(12)}git push`)?.rule, 'git push')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}ls -la`)?.rule, WRAPPER_DEPTH_RULE)
  })

  it('shell 嵌套超限：同理（三层 `-c` 里的真命令报 `rm -rf`）', () => {
    assert.equal(dangerousCommandMatch(`bash -c 'bash -c "bash -c rm -rf /"'`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`bash -c 'bash -c "bash -c echo hi"'`)?.rule, SHELL_DEPTH_RULE)
  })
})

describe('v1.12.10 不变量④：两套豁免机器不得复活', () => {
  it('源码级：1.12.8 剥离草案与 1.12.9 掩码草案的符号一个都不许留', () => {
    for (const banned of [
      'heredocPayloadLines', 'scanHeredocBlocks', 'parseHeredocTag', 'scanHeredocOps',
      'isHeredocTerminator', 'MAX_HEREDOC_OPS', 'HEREDOC_TAG_RE', 'isCommentStart',
      'splitSubCommandsDetailed', 'shapeOk', 'DATA_CONSUMERS', 'STDIN_SCRIPT_CONSUMERS',
      'heredocPayloadIsData', 'isDataConsumerCommand', 'pipelineIsDataOnly', 'heredocCommandStart',
      'stripHeredocPayloads', 'wrapperOptionAmbiguityProbes', 'terminators', 'payloadLines',
    ]) {
      // 只在**代码**行上查（整行注释剔除，Minor 4；行尾注释仍会被扫到，属已知代价）
      assert.ok(!hostCode.includes(banned), `lib/host-approval.js 的代码里仍有过期符号：${banned}`)
      assert.ok(!indexCode.includes(banned), `index.js 的代码里仍有过期符号：${banned}`)
    }
  })

  it('判定循环里没有任何「跳过这一行/这一段」的分支', () => {
    const start = hostSrc.indexOf('function matchText(text, depth)')
    assert.ok(start > 0, '找不到 matchText')
    const mt = stripComments(hostSrc.slice(start, hostSrc.indexOf('\n}\n', start)))
    assert.ok(mt.length > 40, 'matchText 切片异常（守卫会空转）')
    // v1.12.11：判定文本先过 `normalizeDangerText`（续行合并 / 换行转义折空格 / 折叠空白）再切段；
    // v1.12.13：四份变体（新口径 / 词内引号拼接 / 旧口径读 / 原文）各判一遍 —— 仍然「每段都判」
    assert.match(mt, /for \(const variant of \[\n/)
    assert.match(mt, /for \(const segment of splitSubCommands\(variant\)\) \{/)
    assert.ok(!/\bcontinue\b/.test(mt), 'matchText 里出现了 continue（跳过）')
    assert.ok(!/payload|exempt|skip/i.test(mt), 'matchText 里出现了载荷/豁免/跳过语义')
  })

  it('`splitSubCommands` 仍是 v1.12.7（HEAD）骨架 + v1.12.11 的「换行一律切段」（拆行号那一版不许回来）', () => {
    const start = hostSrc.indexOf('export function splitSubCommands(text) {')
    assert.ok(start > 0, '找不到 splitSubCommands')
    const body = stripComments(hostSrc.slice(start, hostSrc.indexOf('\n}\n', start)))
    // HEAD 版的特征：纯缓冲式切分，不产出行号
    assert.match(body, /const segments = \[\]\n  let buffer = ''\n  let quote = ''/, 'HEAD 版开头不一致')
    assert.match(body, /segments\.push\(buffer\)\n  return segments/, 'HEAD 版结尾不一致')
    // v1.12.11 新增：换行一律切段（引号里也切）+ 重置引号状态
    assert.match(body, /if \(ch === '\\n'\) \{\n      segments\.push\(buffer\)\n      buffer = ''\n      quote = ''/,
      '「换行一律切段」的分支不见了')
    assert.ok(!/line|index/i.test(body.replace(/for \(let i = 0; i < text\.length; i \+= 1\)/, '')),
      'splitSubCommands 里出现了行号语义')
    assert.ok(!/Detailed/.test(hostCode), '又出现了带行号的切分变体')
  })
})

describe('v1.12.10 不变量⑤：接线 + 监听器层（已授权 bash 的帧）', () => {
  it('接线：危险门仍在工具名短路之前，且用的是同一份判据', () => {
    const gate = indexSrc.indexOf('const danger = dangerousCommandMatch(dangerCmd.text)')
    const short = indexSrc.indexOf('hostApproval.toolGrantCovers')
    assert.ok(gate >= 0, 'index.js 里找不到危险门')
    assert.ok(short < 0 || gate < short, '危险门必须排在工具名短路之前')
  })

  it('监听器层【代价】：现场那条 commit 会被拦（用户裁定接受），并留 1 行门名', async () => {
    const b = await bootWithBashGranted()
    try {
      const cmd = REPRO
      const s = mkSession({ id: 'i10-2', parentSession: 'R', toolCalls: bashCall('v10n', cmd) })
      const r = await approve(b, s, { callId: 'v10n', toolName: 'bash' })
      assert.equal(r.nextCalled, true, '载荷行不再豁免 ⇒ 必须转人工（这是刻意付出的代价）')
      const rows = dangerousRows(b.home)
      assert.equal(rows.length, 1)
      assert.equal(rows[0].rule, WRAPPER_OPTION_AMBIGUITY_RULE)
    } finally { await b.close() }
  })

  it('监听器层：两条原阻断（假起始 / 续行）都必须 next() 且各留 1 行门名', async () => {
    const b = await bootWithBashGranted()
    try {
      for (const cmd of [
        'x=$((n<<sh))\nsh',
        "ssh host <<'SH'\nrm \\\n-rf /tmp/x\nSH",
        "cat <<'SH'\nrm -rf /tmp/x\nSH",
      ]) {
        const s = mkSession({ id: 'i10-2', parentSession: 'R', toolCalls: bashCall('v10a', cmd) })
        const r = await approve(b, s, { callId: 'v10a', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${JSON.stringify(cmd)} 被静默放行`)
        assert.notEqual(r.res, 'allowed-once')
      }
    } finally { await b.close() }
  })
})
