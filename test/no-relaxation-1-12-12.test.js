// test/no-relaxation-1-12-12.test.js — v1.12.12「只加不减」的**常驻反退化回归表**。
//
// 用户原话：「归一化内容后，按原有的结构化判断的基础，再补充用子串匹配的判断，
// 只会更保守严格，而不应该退化。」
//
// ⇒ 这组用例把「只加不减」钉死在仓库里（不是一次性脚本），四组各自独立成 `it()`，
//    便于变异实验分别计数：
//      G1 结构判据不许丢（计数/位置型：shell-nesting / wrapper-nesting / shell-stdin / su-shell /
//         wrapper-option-ambiguity）—— **归因可以不变，但绝不允许变成 null**；
//      G2 词法等价写法不许丢（终审点名的「若被字面 `rm -rf` 替换就会漏」的族）；
//      G3 既有位置敏感命中不许丢（38 条代表输入，从 1.12.11 冻结树逐条核对：`之前规则名 →
//         现在规则名` **必须完全一致**）；
//      G4 新增面必须 HIT（三个预设串在段中 / 引号内 / 归一化拼接后 / 提及 / 自定义配置串五个位置；
//         这几条**只有**全文层能命中 ⇒ 删掉全文层时本组转红）。
//
// 运行：node --test test/no-relaxation-1-12-12.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  dangerousCommandMatch,
  normalizeDangerText,
  resetDangerPatternCache,
  SHELL_DEPTH_RULE,
  SHELL_STDIN_RULE,
  SU_SHELL_RULE,
  WRAPPER_DEPTH_RULE,
  WRAPPER_OPTION_AMBIGUITY_RULE,
} from '../lib/host-approval.js'

const NL = '\n'
const rule = (cmd) => dangerousCommandMatch(cmd)?.rule ?? null
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-no-regress-'))
const cfgFile = path.join(tmpHome, 'data', 'dsh-danger-patterns.json')
const origHome = process.env.DSH_HOME
const writeCfg = (value) => {
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
  fs.writeFileSync(cfgFile, JSON.stringify(value))
  resetDangerPatternCache()
}
const useDefaults = () => {
  try { fs.unlinkSync(cfgFile) } catch {}
  resetDangerPatternCache()
}

before(() => {
  process.env.DSH_HOME = tmpHome
  useDefaults()
})
after(() => {
  if (origHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = origHome
  resetDangerPatternCache()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('G1 结构判据不许丢（计数/位置型；归因必须不变，绝不允许 null）', () => {
  it('G1：shell-nesting / wrapper-nesting / shell-stdin / su-shell / 选项位置 逐条仍 HIT', () => {
    useDefaults()
    for (const [why, cmd, want] of [
      ['shell 嵌套用尽（第 3 层）', 'sh -c \'sh -c "sh -c ls"\'', SHELL_DEPTH_RULE],
      ['透明包装跳数用尽（第 9 跳）', `${'sudo '.repeat(9)}ls`, WRAPPER_DEPTH_RULE],
      ['裸解释器 stdin', "bash <<< 'rm -rf /x'", SHELL_STDIN_RULE],
      ['su 没有 -c', 'su root', SU_SHELL_RULE],
      ['段首站着一个选项', '-rf /x', WRAPPER_OPTION_AMBIGUITY_RULE],
      ['env -S 的取值就是命令', "env -S 'rm -rf /x'", WRAPPER_OPTION_AMBIGUITY_RULE],
    ]) {
      assert.equal(rule(cmd), want, `${why} 的判定/归因变了（结构判据不许丢）`)
      assert.notEqual(rule(cmd), null, `${why} 变成了放行`)
    }
  })
})

describe('G2 词法等价写法不许丢（终审点名的族）', () => {
  it('G2：rm 的六种等价写法逐条仍 HIT', () => {
    useDefaults()
    for (const [why, cmd] of [
      ['rm -r -f', 'rm -r -f /tmp/x'],
      ['rm -f -R', 'rm -f -R /tmp/x'],
      ['rm --recursive --force', 'rm --recursive --force /tmp/x'],
      ['rm /x -rf（选项在后）', 'rm /x -rf'],
      ['/bin/rm -rf', '/bin/rm -rf /tmp/x'],
      ['sudo rm -rf', 'sudo rm -rf /tmp/x'],
    ]) {
      assert.equal(rule(cmd), 'rm -rf', `${why} 丢了（相当于把 rm 规则替换成字面 rm -rf）`)
    }
  })
})

describe('G3 既有位置敏感命中不许丢（38 条代表输入，逐条与 1.12.11 冻结树比对）', () => {
  it('G3：之前规则名 === 现在规则名（一条都不许变 null / 不许换归因）', () => {
    useDefaults()
    const table = [
      // [为什么, 输入, 1.12.11 冻结树里的规则名]
      ['命令头 rm -rf', 'rm -rf /tmp/x', 'rm -rf'],
      ['命令头 git push', 'git push origin main', 'git push'],
      ['命令头 npm publish', 'npm publish', 'npm publish'],
      ['段中 &&', 'cd /tmp && rm -rf /tmp/x', 'rm -rf'],
      ['段中 ;', 'true;git push', 'git push'],
      ['段中 | + xargs', 'echo x | xargs rm -rf /tmp/x', 'rm -rf'],
      ['剥壳 command', 'command rm -rf /tmp/x', 'rm -rf'],
      ['剥壳 env', 'env rm -rf /tmp/x', 'rm -rf'],
      ['剥壳 nohup', 'nohup rm -rf /tmp/x', 'rm -rf'],
      ['剥壳 nice', 'nice rm -rf /tmp/x', 'rm -rf'],
      ['剥壳 time', 'time rm -rf /tmp/x', 'rm -rf'],
      ['剥壳 bash -c', 'bash -c "rm -rf /tmp/x"', 'rm -rf'],
      ['剥壳 sh -c', "sh -c 'npm publish'", 'npm publish'],
      ['剥壳 su -c', 'su root -c "git push"', 'git push'],
      ['剥壳 sudo+env 链', 'sudo env rm -rf /tmp/x', 'rm -rf'],
      ['选项 git -C', 'git -C /tmp push', 'git push'],
      ['选项 git -c k=v', 'git -c k=v push', 'git push'],
      ['选项 npm --prefix', 'npm --prefix /tmp publish', 'npm publish'],
      ['词法 pnpm', 'pnpm publish', 'pnpm publish'],
      ['词法 yarn', 'yarn publish', 'yarn publish'],
      ['find -exec', 'find /tmp -exec rm -rf {} +', 'rm -rf'],
      ['heredoc 之后的命令', "cat <<'EOF' > f" + NL + 'body' + NL + 'EOF' + NL + 'rm -rf /tmp/x', 'rm -rf'],
      ['heredoc 之前的命令', "rm -rf /tmp/x <<'EOF'" + NL + 'body' + NL + 'EOF', 'rm -rf'],
      ['argsText 通道（{shell:…}）', 'rm -rf /', 'rm -rf'],
      ['大写同形', 'RM -RF /tmp/x', 'rm -rf'],
      ['段首 -exec 的第二段', 'find . -exec ls {} \\; -exec rm -rf {} +', 'rm -rf'],
      ['续行拼接', 'git \\' + NL + 'push origin main', 'git push'],
      ['多行 -c 正文', 'bash -c "true' + NL + 'rm -rf /tmp/x"', 'rm -rf'],
      ['段中引号外 git push', 'true && git push origin main', 'git push'],
      ['包装 + 段中', 'sudo nice -n 5 rm -rf /tmp/x', 'rm -rf'],
      ['透明包装 8 跳（未用尽）', `${'sudo '.repeat(8)}rm -rf /tmp/x`, 'rm -rf'],
      ['空白规避', 'rm  -rf /tmp/x', 'rm -rf'],
      ['TAB 规避', 'rm\t-rf /tmp/x', 'rm -rf'],
      ['字面 \\t 转义', 'rm \\t -rf /tmp/x', 'rm -rf'],
      ['引号包裹选项', 'rm "-rf" /tmp/x', 'rm -rf'],
      ['分号后 git push', 'cd /tmp;git push', 'git push'],
      ['find -execdir', 'find /tmp -execdir rm -rf {} +', 'rm -rf'],
      ['npm --prefix=… 单 token', 'npm --prefix=/tmp publish', 'npm publish'],
    ]
    for (const [why, cmd, prev] of table) {
      const now = rule(cmd)
      assert.equal(now, prev, `${why}：1.12.11 是 ${prev}，现在 ${now}（只加不减被破坏了）`)
      assert.notEqual(now, null, `${why} 变成了放行`)
    }
    assert.ok(table.length >= 20, '这张表至少要 20 条代表输入')
  })
})

describe('G4 新增面必须 HIT（全文层独有；删掉全文层时本组应转红）', () => {
  it('G4a 三个预设串 × 段中 / 引号内 / 归一化拼接后 / 提及 四种位置', () => {
    useDefaults()
    for (const [why, cmd, want] of [
      ['段中（引号内提及）rm -rf', 'cd /tmp && echo "rm -rf /x"', 'text:rm -rf'],
      ['段中 git push', 'echo x && echo "git push"', 'text:git push'],
      ['段中 npm publish', 'cd /tmp && echo "npm publish"', 'text:npm publish'],
      ['引号内 rm -rf', 'echo "note: rm -rf /tmp/x"', 'text:rm -rf'],
      ['引号内 git push', 'git log --grep "git push"', 'text:git push'],
      ['引号内 npm publish', 'echo "npm publish"', 'text:npm publish'],
      // 归一化（续行拼接 / 字面转义作行分隔 / 空白折叠）之后才能看见的形态：只有全文层能命中
      // （注意：**选项开头**的段会被形状判据 `wrapper-option-ambiguity` 先接走，那类不属本组）
      ['续行拼接后 git push', 'echo "git \\' + NL + 'push"', 'text:git push'],
      ['字面 \\n 作行分隔后 npm publish', 'echo "npm\\npublish"', 'text:npm publish'],
      ['TAB/双空格折叠后 rm -rf', 'echo "rm \\t -rf /x"', 'text:rm -rf'],
      ['双空格折叠后 rm -rf', 'echo "rm  -rf /x"', 'text:rm -rf'],
      // 提及（用户裁定的代价）
      ['提交信息里提及 rm -rf', 'git commit -m "fix: avoid rm -rf"', 'text:rm -rf'],
      ['注释里提及 git push', '# 注释：别用 git push --force', 'text:git push'],
      ['文档写入里提及 npm publish', 'cat <<EOF > notes' + NL + '正文提到 npm publish' + NL + 'EOF', 'text:npm publish'],
    ]) {
      assert.equal(rule(cmd), want, `${why} 没命中（全文层丢了或词边界过严）`)
    }
  })

  it('G4b 配置自定义串（追加项；含「改文件后立刻生效」与「内置三串恒在」）', () => {
    useDefaults()
    // 内置三串之外的串：只有配置文件能**追加**进来（配置只增不减，不能关掉内置串）
    writeCfg({ patterns: ['kubectl delete ns', 'helm uninstall'] })
    assert.equal(rule('echo "kubectl delete ns prod"'), 'text:custom:kubectl delete ns')
    assert.equal(rule('true && echo "helm uninstall prod"'), 'text:custom:helm uninstall')
    for (const [cmd, want] of [['echo "rm -rf /x"', 'text:rm -rf'], ['echo "git push"', 'text:git push'],
      ['echo "npm publish"', 'text:npm publish']]) {
      assert.equal(rule(cmd), want, '追加项生效时内置三串必须仍在')
    }
    // 不 reset、直接改文件 ⇒ 下一次判定立刻用新追加项（不重装 / 不重启）
    writeCfg({ patterns: ['docker system prune -af'] })
    assert.equal(rule('echo "docker system prune -af"'), 'text:custom:docker system prune -af')
    assert.equal(rule('echo "kubectl delete ns prod"'), null)
    // `[]` 也不能关闭内置三串
    writeCfg({ patterns: [] })
    assert.equal(rule('echo "rm -rf /x"'), 'text:rm -rf')
    assert.equal(rule('echo "docker system prune -af"'), null)
    useDefaults()
    assert.equal(rule('echo "kubectl delete ns prod"'), null)
  })
})

describe('G5（v1.12.13 · 终审 B1）CR 家族生成式不许丢：对 1.12.11 冻结期望位图逐条比对', () => {
  // **位图来源（终审 Nit 7）**：`CR_FROZEN_BITS` 由 **1.12.11 冻结树**（`/tmp/hd-repro/inc12/old11/lib/host-approval.js`）
  // 对同一套生成维度（前 8 前缀 × 4 组词 × 7 种分隔 × 3 后缀；后两组前缀是 CR 专项）逐条实跑生成，
  // 复核方已用该冻结树重算 ⇒ **0/840 不一致、loses = 0**。它是**期望值**，不是「当前实现的快照」：
  // 改小 `assert.equal(frozen, 540)`、或按当前实现重算位图，都等于把洞固化成绿灯（禁止）。
  // 1.12.11 的读法：**裸 CR / CRLF / 字面 `\r`** 都折**空格** ⇒ `rm␍-rf␍/tmp/x` 被拼成 `rm -rf /tmp/x`。
  // 1.12.12 把裸 CR 改判成「段分隔符」，却**没有保留旧口径读** ⇒ 这一族整批变 MISS
  // （终审 B1：CR 专项语料 relaxed = 40；危险命令 × CR 7,488 条 relaxed = 640）。
  // 下面 840 条按同一套维度生成（前 8 个前缀 × 4 组词 × 7 种分隔 × 3 后缀；后两组前缀是
  // **字面 `\t`** —— 1.12.11 的读法里它折空格、裸 CR 也折空格 ⇒ `\trm␍-r␍-f␍/tmp/x` 会被拼成
  // ` rm -r -f /tmp/x` 而命中；这三组词只有**旧口径读**能判出来，用 `no-cr-legacy` 变异实测
  // **24 条会变 MISS** ⇒ 本组对这次修复是 load-bearing 的）。
  // 位图取自**冻结的 1.12.11 树**（生成脚本 /tmp/hd-repro/inc13/gen-bits2.mjs）；`1` = 1.12.11 会命中
  // ⇒ 本版也必须命中（relaxed 必须 0）。位图里 `1` 的个数（540）在断言里钉死，防止有人把位图改小来「修绿」。
  const CR_PREFIXES = ['', 'x=', 'echo ', 'sudo ', 'sh -c "', 'git commit -m "', '# c\n', 'true && ', '\\t', '\\t\\t']
  const CR_WORDS = [['rm', '-rf', '/tmp/x'], ['git', 'push', 'origin'], ['npm', 'publish'], ['rm', '-r', '-f', '/tmp/x']]
  const CR_SEPS = ['\r', '\r\n', '\\r', '\\n', '\r\r', ' \r ', '\t\r']
  const CR_SUFFIXES = ['', '\n', ' 2>&1']
  const CR_FROZEN_BITS =
    '111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111000000000000000000000000000000000000000000111000111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111000000000000000000000000000000000000000000000000000000000000000000000000000000000000111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111111000111111111111111'

  it('生成式 CR 家族（840 条）：1.12.11 会命中的每一条都仍命中', () => {
    const family = []
    for (const p of CR_PREFIXES) {
      for (const w of CR_WORDS) {
        for (const s of CR_SEPS) {
          for (const f of CR_SUFFIXES) family.push(p + w.join(s) + f)
        }
      }
    }
    assert.equal(family.length, CR_FROZEN_BITS.length, '生成维度与冻结位图不一致（守卫会空转）')
    let frozen = 0
    const lost = []
    for (let i = 0; i < family.length; i += 1) {
      if (CR_FROZEN_BITS[i] !== '1') continue
      frozen += 1
      if (rule(family[i]) === null) lost.push(JSON.stringify(family[i]))
    }
    assert.equal(frozen, 540, '冻结位图里的命中数被改了（不许靠改位图修绿）')
    assert.deepEqual(lost.slice(0, 8), [], `${lost.length} 条 1.12.11 会命中、本版变 MISS（relaxed > 0）`)
  })

  it('终审 B1 最小复现（字面 `\\t` + 裸 CR 分隔）逐条精确归因', () => {
    assert.equal(rule('\\trm\r-r\r-f\r/tmp/x'), 'rm -rf', 'B1 最小复现又 MISS 了')
    assert.equal(rule('\\tgit\rpush\rorigin'), 'git push')
    assert.equal(rule('rm\r-rf\r/tmp/x'), 'rm -rf')
    assert.equal(rule('git\rpush origin main'), 'git push')
    assert.equal(rule('npm\rpublish'), 'npm publish')
    // 旧口径读的**直接**行为（去掉裸 CR 折空格这条分支就会红）
    assert.equal(normalizeDangerText('a\rb', { literalEscapeAsSpace: true }), 'a b')
    assert.notEqual(rule('\trm\r-r\r-f\r/tmp/x'), null, 'TAB 形态也不许漏')
  })
})
