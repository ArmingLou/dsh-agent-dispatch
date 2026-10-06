// test/invariants-1-12-11.test.js — v1.12.11 交付要求：归一化层 + 归因窗口的 6 条不变式。
//
// 用户裁定（原话）：「以保守的策略，遇到 尾未 \ ，就一概 前置处理，去掉行末 \ 再拼接下一行；
// 凡是换行转义的形状，比如 \n \r 等，都直接换成空格处理。最后再对 处理后的 内容，进行
// 高危形状判断。这样就是简单的，保守方法，不需要对 -c 等做复杂判断」+「归一化内容处理，
// 需要将连续的空格，转换成单个空格吧？」
//
// 落地（顺序固定，见 `normalizeDangerText`）：
//   ① 行尾**未转义的** `\`（可带行尾空白/CR）= 续行 ⇒ 删掉 `\` 与行尾空白/CR/换行，**直接拼接**；
//   ② 其它换行转义形态（字面 `\n`/`\r`/`\t` 两字符序列、裸 CR）⇒ 一个空格；
//   ③ 连续空白折叠成单个空格（`rm  -rf` / `git\tpush` / `rm \t -rf` 失效）；
//   ④ **真实换行保留为段分隔符**（刻意偏离「折成空格」的字面口径：折成空格会抹平行首语义，
//      把 1.12.10 已拦的一批形态变成 MISS ⇒ 差分 relaxed 远大于 0，与硬约束冲突；见 CHANGELOG）；
//   ⑤ 判定全部在归一化后的文本上做（`matchText` 里 `splitSubCommands(normalizeDangerText(text))`）。
//
// 归因窗口（终审 Blocker）：`MAX_ATTRIBUTION_TOKENS = 256`，只让归因变粗、**绝不放行**。
//
// 本文件钉住：
//   ① 归一化函数本身的形状（顺序、快路径、幂等性）；
//   ② 判定发生在归一化之后（七条验收 + 空白折叠 + 行首语义不许被抹平）；
//   ③ 归因窗口只粗不放（含性能封顶）；
//   ④ 代价面（大写 tag）与「句中提及不翻面」；
//   ⑤ 源码级：接线顺序、「换行一律切段」、不做按 flag 的专门解析、两套旧豁免机器不得复活；
//   ⑥ 监听器层（已授权 bash 的帧）：续行 / 多行 `-c` 必须 next() 且各留 1 行门名。
//
// 运行：node --test test/invariants-1-12-11.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, mkSession } from './agent-api-harness.js'
import {
  dangerousCommandMatch,
  normalizeDangerText,
  splitSubCommands,
  MAX_ATTRIBUTION_TOKENS,
  SHELL_STDIN_RULE,
  SU_SHELL_RULE,
  WRAPPER_DEPTH_RULE,
  WRAPPER_OPTION_AMBIGUITY_RULE,
} from '../lib/host-approval.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostSrc = readFileSync(path.join(root, 'lib', 'host-approval.js'), 'utf8')
/** 去掉**整行注释**后的源码（Minor 4：ban-list 只该盯代码；行尾注释仍会被扫到 = 已知代价） */
const stripComments = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const hostCode = stripComments(hostSrc)

const bashCall = (callId, cmd) => [{ callId, name: 'bash', arguments: { command: cmd } }]
const postRule = (b, body) => b.req('POST', '/agent-api/host-approval-rule', body)
const logRows = (home) => {
  const f = path.join(home, 'data', 'dsh-agent-dispatch', 'dispatches.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
const approve = async (b, session, o = {}) => {
  let nextCalled = false
  const outs = b.fireEvent('approval/request',
    { agent: { session }, callId: o.callId ?? null, toolName: o.toolName ?? null, reason: 'tool requires approval' },
    () => { nextCalled = true; return 'NEXT' })
  const res = await outs[0]
  return { res, nextCalled }
}
const bootWithBashGranted = async () => {
  const b = await boot()
  const s1 = mkSession({ id: 'i11-1', parentSession: 'R', toolCalls: bashCall('g11', 'echo hi') })
  const first = await approve(b, s1, { callId: 'g11', toolName: 'bash' })
  assert.equal(first.nextCalled, true, '前置：首次请求应交给交互层')
  const { status, json } = await postRule(b, { scope: 'session', sessionId: 'i11-1', callId: 'g11', toolName: 'bash' })
  assert.equal(status, 200)
  assert.equal(json.rootSessionId, 'R', '前置：授权应落在根会话键上')
  return b
}

describe('v1.12.11 不变量①：归一化函数本身（顺序固定、幂等）', () => {
  it('①续行：删掉行尾未转义的 `\\` 与行尾空白/CR/换行，**直接拼接**', () => {
    assert.equal(normalizeDangerText('git \\\npush origin main'), 'git push origin main')
    assert.equal(normalizeDangerText('rm \\\n-rf /tmp/x'), 'rm -rf /tmp/x')
    assert.equal(normalizeDangerText('git \\\r\npush'), 'git push') // CRLF
    assert.equal(normalizeDangerText('git \\   \npush'), 'git push') // 行尾 `\` 后带空格
    // `\\` 是**转义的反斜杠**，不是续行；行尾孤立 `\` 丢掉（保守）
    assert.equal(normalizeDangerText('git \\\\\npush'), 'git \\\\\npush') // 两个反斜杠原样保留
    assert.equal(normalizeDangerText('echo hi\\'), 'echo hi')
  })

  it('②字面 `\\n`/`\\r` 与裸 CR ⇒ **行分隔**；字面 `\\t` ⇒ 空格；③连续空白折叠', () => {
    // 裁定 2（v1.12.11 二次走查）：字面 `\n`/`\r` 是 Python/Node/PowerShell 眼里的**真换行**
    // ⇒ 按行分隔处理（折成空格会把换行藏进同一段 = 漏判方向）
    assert.equal(normalizeDangerText('a\\nb'), 'a\nb')
    assert.equal(normalizeDangerText('a\\rb'), 'a\nb')
    assert.equal(normalizeDangerText('a\rb'), 'a\nb')       // 裸 CR = 行分隔
    assert.equal(normalizeDangerText('a\r\nb'), 'a\nb')     // CRLF 只算一个分隔符
    assert.equal(normalizeDangerText('a\\tb'), 'a b')       // 字面 \t：只是空白
    assert.equal(normalizeDangerText('rm  -rf /tmp/x'), 'rm -rf /tmp/x')
    assert.equal(normalizeDangerText('rm \t -rf'), 'rm -rf')
    assert.equal(normalizeDangerText('git\t\tpush'), 'git push')
  })

  it('④真实换行**保留**（段分隔符）；归一化幂等', () => {
    assert.equal(normalizeDangerText('echo hi\n- rm -rf /tmp/x'), 'echo hi\n- rm -rf /tmp/x')
    assert.equal(normalizeDangerText('a  \n\n  b'), 'a\n\nb')
    for (const t of ['git \\\npush', 'rm  -rf', 'a\\nb', 'echo hi\nx', 'plain']) {
      const once = normalizeDangerText(t)
      assert.equal(normalizeDangerText(once), once, `不幂等：${JSON.stringify(t)}`)
    }
  })
})

describe('v1.12.11 不变量②：判定发生在归一化**之后**', () => {
  it('七条验收（用户点名）逐条命中，且归因是真命令名', () => {
    for (const [cmd, rule] of [
      ['git \\\npush origin main', 'git push'],
      ['npm \\\npublish', 'npm publish'],
      ['rm \\\n-rf /tmp/x', 'rm -rf'],
      ['sudo \\\nrm -rf /tmp/x', 'rm -rf'],
      ['bash -c "true\nrm -rf /tmp/x"', 'rm -rf'],
      ['sh -c "true\nrm -rf /tmp/x"', 'rm -rf'],
      ['pwsh -Command "x\nnpm publish"', 'npm publish'],
      // 裁定 2：**字面** `\n`（两字符）也当行分隔 ⇒ 这两条必须 HIT
      ['pwsh -Command "x\\nnpm publish"', 'npm publish'],
      ['python3 -c "import os\\nos.system(\'rm -rf /tmp/x\')"', 'rm -rf'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${JSON.stringify(cmd)} 判定不对`)
    }
  })

  it('代码边界内容规则：危险命令**紧跟代码标点**出现 ⇒ HIT（Python/Node/JSON 参数形态）', () => {
    for (const [cmd, rule] of [
      ["os.system('rm -rf /tmp/x')", 'rm -rf'],
      ["{shell:'rm -rf /tmp/x'}", 'rm -rf'],
      ['$(git push origin main)', 'git push'],
      ['x="npm publish"', 'npm publish'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${cmd} 应命中（代码片段）`)
    }
    // v1.12.12（用户裁定：文本里出现预设字样就弹）⇒ 下面这些现在**都会弹**（代价）；
    // 「代码边界规则」与「全文子串层」是两条独立通道，这里都命中，规则名可能是任一条
    for (const cmd of ['echo "git push"', "echo 'rm -rf /tmp/x'", "curl 'a=1&rm -rf'",
      'echo "npm publish"', 'printf "%s" "rm -rf /tmp/x"']) {
      assert.notEqual(dangerousCommandMatch(cmd), null, `${cmd}：按 1.12.12 裁定应当弹（代价）`)
    }
  })

  it('空白折叠让「靠多余空白规避」失效（全部 HIT）', () => {
    for (const cmd of ['rm  -rf /tmp/x', 'rm    -rf /tmp/x', 'rm\t-rf /tmp/x', 'rm \t -rf /tmp/x',
      'git\t\tpush origin main', 'npm   publish', 'sudo   rm   -rf   /tmp/x']) {
      assert.notEqual(dangerousCommandMatch(cmd), null, `${JSON.stringify(cmd)} 应命中`)
    }
  })

  it('**不许**抹平行首语义（用户点名的三条 + 现场代价用例）', () => {
    assert.equal(dangerousCommandMatch('echo hi\n- rm -rf /tmp/x')?.rule, WRAPPER_OPTION_AMBIGUITY_RULE)
    assert.equal(dangerousCommandMatch('true\n- rf /tmp/x')?.rule, WRAPPER_OPTION_AMBIGUITY_RULE)
    assert.equal(dangerousCommandMatch('echo x\nsudo rm -rf /tmp/y')?.rule, 'rm -rf')
    const REPRO = ['git add -A', "git commit -q -F - <<'EOF'", 'feat: x', '',
      '- planGrantWrites 新增 none 出口：…', 'EOF'].join('\n')
    assert.equal(dangerousCommandMatch(REPRO)?.rule, WRAPPER_OPTION_AMBIGUITY_RULE,
      '现场那条 commit 的**代价**命中不许因为归一化丢掉（否则就是放松）')
  })

  it('回归表：既有全部等价写法一条不松', () => {
    for (const [cmd, rule] of [
      ['bash -c "rm -rf /tmp/x"', 'rm -rf'],
      ["sh -c 'rm -rf /tmp/x'", 'rm -rf'],
      ['echo x | xargs rm -rf /tmp/x', 'rm -rf'],
      ['sudo rm -rf /tmp/x', 'rm -rf'],
      ['/bin/rm -rf /tmp/x', 'rm -rf'],
      ['find /tmp -exec rm -rf {} +', 'rm -rf'],
      ['git -C /tmp push', 'git push'],
      ['git -c k=v push', 'git push'],
      ['npm --prefix /tmp publish', 'npm publish'],
      ['pnpm publish', 'pnpm publish'],
      ['yarn publish', 'yarn publish'],
      ['cat <<EOF > f\nbody\nEOF\nrm -rf /tmp/x', 'rm -rf'],
      ["rm -rf /tmp/x <<'EOF'\nbody\nEOF", 'rm -rf'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${cmd} 被放过`)
    }
    // `{shell:'rm -rf /x'}` 属**代码片段**（标点左贴 `:`）⇒ v1.12.11 二次走查后按 `rm -rf` 命中
    // （与 1.12.10 任务 D 的「反放宽总表」把 `{shell:'rm -rf'}` 列为必须拦一致）
    assert.equal(dangerousCommandMatch("{shell:'rm -rf /tmp/x'}")?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('echo hi'), null)
  })

  it('「句中只是提到危险命令」：v1.12.12 起**按用户裁定弹**（代价）；无字样文本仍 MISS', () => {
    // 用户裁定原话：「改成全文子串判定：文本里出现危险字样就弹」+ 明确接受代价。
    for (const [cmd, rule] of [
      ['echo "note: never run rm -rf /tmp/x by hand"', 'text:rm -rf'],
      ['git commit -m "fix: never git push --force"', 'text:git push'],
      ['git commit -m "docs: mention npm publish"', 'text:npm publish'],
      ["curl 'a=1&rm -rf'", 'text:rm -rf'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule,
        `${JSON.stringify(cmd)}：这是**有意取舍**，变 MISS 才是缺陷`)
    }
    // 文本里没有预设字样 ⇒ 照旧 MISS
    for (const cmd of ["cat <<'EOF'\nbody\nEOF", 'cat <<EOF > f\n普通说明文本\nEOF']) {
      assert.equal(dangerousCommandMatch(cmd), null, `${JSON.stringify(cmd)} 不含危险字样，不该弹`)
    }
  })
})

describe('v1.12.11 不变量③：归因窗口只粗不放（终审 Blocker）', () => {
  it('窗口常量与语义：超限裁到尾部 256 个 token，仍**必须拦**', () => {
    assert.equal(MAX_ATTRIBUTION_TOKENS, 256)
    // 精度区（9 个包装词）：照旧精确归因
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}rm -rf /tmp/x`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}git push`)?.rule, 'git push')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}ls -la`)?.rule, WRAPPER_DEPTH_RULE)
    // 超长包装前缀：真命令在尾部 ⇒ 仍精确；没有真命令 ⇒ 落「包装太深」而**不是 null**
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(32768)}rm -rf /tmp/x`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(32768)}ls`)?.rule, WRAPPER_DEPTH_RULE)
    assert.notEqual(dangerousCommandMatch(`${'sudo '.repeat(100000)}ls`), null)
    // 超限前后：判定结果（命中与否）一致，只有归因可能变粗
    for (const tail of ['rm -rf /tmp/x', 'git push', 'ls -la']) {
      const small = dangerousCommandMatch(`sudo sudo sudo sudo sudo sudo sudo sudo sudo ${tail}`)
      const big = dangerousCommandMatch(`${'sudo '.repeat(30000)}${tail}`)
      assert.equal(Boolean(small), Boolean(big), `${tail}: 超限后判定方向变了`)
    }
  })

  it('二次路径封顶：32768 个包装词 < 500ms（1.12.10 实测 ≈2.9s）', () => {
    const big = 'sudo '.repeat(32768) + 'ls'
    dangerousCommandMatch(big.slice(0, 400))
    const t0 = performance.now()
    dangerousCommandMatch(big)
    const ms = performance.now() - t0
    assert.ok(ms < 500, `32768 个包装词耗时 ${ms.toFixed(1)}ms（>500ms ⇒ 归因窗口被破坏）`)
  })
})

describe('v1.12.11 不变量④：代价面与大小写（Minor 1）', () => {
  it('大写 tag 同样命中（`basenameOf` 小写化）', () => {
    for (const [tag, rule] of [
      ['sh', SHELL_STDIN_RULE], ['SH', SHELL_STDIN_RULE], ['Sh', SHELL_STDIN_RULE],
      ['bash', SHELL_STDIN_RULE], ['BASH', SHELL_STDIN_RULE],
      ['su', SU_SHELL_RULE], ['SU', SU_SHELL_RULE], ['Su', SU_SHELL_RULE],
      ['runuser', SU_SHELL_RULE], ['RUNUSER', SU_SHELL_RULE],
    ]) {
      assert.equal(dangerousCommandMatch(`cat <<'${tag}'\nbody\n${tag}`)?.rule, rule, `tag=${tag}`)
    }
    for (const tag of ['EOF', 'Eof', 'eof', 'JSON', 'PY', 'END', 'YAML', 'TXT']) {
      assert.equal(dangerousCommandMatch(`cat <<'${tag}'\nbody\n${tag}`), null, `tag=${tag} 不该弹`)
    }
  })
})

describe('v1.12.11 不变量⑤：源码级守卫', () => {
  it('接线：`matchText` 在切段前做规范化（切段与判定用同一份文本）', () => {
    assert.match(hostCode, /for \(const variant of \[\n/, 'matchText 没有多读（口径链断了）')
    // v1.12.13：② 词内引号拼接（M3）；③ 旧口径读 = 1.12.11 读法（**裸 CR 也折空格**，终审 B1）
    assert.match(hostCode, /stripWordInternalQuotes\(normalizeDangerText\(text\)\)/, '词内引号拼接那一遍不见了（M3）')
    assert.match(hostCode, /if \(literalEscapeAsSpace\) \{\n        pushSpace\(out\)/, '旧口径读的裸 CR 折空格不见了（B1 会变松）')
    assert.match(hostCode, /for \(const segment of splitSubCommands\(variant\)\) \{/, 'matchText 没有对规范化文本切段')
    assert.match(hostCode, /export function normalizeDangerText\(text, opts\) \{/, 'normalizeDangerText 不见了')
    // 旧口径读（字面转义折空格）是多读的第二遍，load-bearing：去掉它 relaxed 会 > 0
    assert.match(hostCode, /literalEscapeAsSpace/, '旧口径读（literalEscapeAsSpace）不见了 —— 会变松')
    assert.match(hostCode, /export const MAX_ATTRIBUTION_TOKENS = 256/, '归因窗口常量不见了')
  })

  it('「换行一律切段」的分支在切分函数里；且**没有**按 flag 的专门解析', () => {
    const start = hostCode.indexOf('export function splitSubCommands(text) {')
    const body = hostCode.slice(start, hostCode.indexOf('\n}\n', start))
    assert.match(body, /if \(ch === '\\n'\) \{/, '换行没有一律切段')
    for (const banned of ['rawBodyText', 'shellBodyText', 'bodyTextFrom', 'perFlag', 'flagBody']) {
      assert.ok(!hostCode.includes(banned), `出现了按 flag 的专门解析：${banned}`)
    }
  })

  it('两套旧豁免机器与「跳过」语义不得复活（代码行上查，注释不算）', () => {
    for (const banned of [
      'heredocPayloadLines', 'scanHeredocBlocks', 'shapeOk', 'splitSubCommandsDetailed',
      'stripHeredocPayloads', 'DATA_CONSUMERS', 'STDIN_SCRIPT_CONSUMERS', 'terminators', 'payloadLines',
    ]) {
      assert.ok(!hostCode.includes(banned), `代码里仍有过期符号：${banned}`)
    }
  })
})

describe('v1.12.11 不变量⑥：接线 + 监听器层（已授权 bash 的帧）', () => {
  it('监听器层：续行 / 多行 `-c` 必须 next() 且各留 1 行门名；无害多行照旧自动放行', async () => {
    const b = await bootWithBashGranted()
    try {
      for (const [cmd, rule] of [
        ['git \\\npush origin main', 'git push'],
        ['rm \\\n-rf /tmp/x', 'rm -rf'],
        ['bash -c "true\nrm -rf /tmp/x"', 'rm -rf'],
        ['pwsh -Command "x\nnpm publish"', 'npm publish'],
      ]) {
        const before = logRows(b.home).filter((x) => x.action === 'danger-command-block').length
        const s = mkSession({ id: 'i11-2', parentSession: 'R', toolCalls: bashCall('i11a', cmd) })
        const r = await approve(b, s, { callId: 'i11a', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${JSON.stringify(cmd)} 被静默放行`)
        assert.notEqual(r.res, 'allowed-once')
        const rows = logRows(b.home).filter((x) => x.action === 'danger-command-block')
        assert.equal(rows.length - before, 1, `${JSON.stringify(cmd)} 必须留 1 行门名`)
        assert.equal(rows[rows.length - 1].rule, rule, `${JSON.stringify(cmd)} 的门名不对`)
      }
      // 无害多行正文（`bash -c "echo hi⏎ls -la"`）⇒ 既不该拦，也不该留痕
      const before = logRows(b.home).filter((x) => x.action === 'danger-command-block').length
      const s = mkSession({ id: 'i11-2', parentSession: 'R', toolCalls: bashCall('i11b', 'bash -c "echo hi\nls -la"') })
      const r = await approve(b, s, { callId: 'i11b', toolName: 'bash' })
      assert.equal(r.nextCalled, false, '无害多行正文被误伤')
      assert.equal(r.res, 'allowed-once')
      assert.equal(logRows(b.home).filter((x) => x.action === 'danger-command-block').length, before)
    } finally { await b.close() }
  })
})
