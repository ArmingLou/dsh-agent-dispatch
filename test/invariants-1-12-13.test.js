// test/invariants-1-12-13.test.js — v1.12.13（独立终审 3 阻断 / 3 主要 / 8 次要）的 8 条不变式。
//
// 本版只修缺陷、**不加功能**（判据方向不动：相对 1.12.11 仍然只做加法）：
//   ① **B1（阻断 · 变松）**：1.12.11 的「裸 CR 折空格」读法在 1.12.12 被丢掉 ⇒ CR 家族变 MISS。
//      修法：旧口径读（`literalEscapeAsSpace`）也把**裸 CR / CRLF** 折空格 = 与 1.12.11 逐字等价。
//      本文件用**生成式** CR 家族（672 条）对 1.12.11 冻结位图逐条核对 ⇒ relaxed 必须 0。
//   ② **B2（阻断 · 拖垮审批）**：配置路径是 FIFO / 指向 `/dev/zero` 的软链时 `readFileSync` 无限阻塞
//      （实测 ETIMEDOUT / exit 124，宿主事件循环同步卡死）⇒ 只读**普通文件** + `O_NONBLOCK` +
//      有界 `readSync`（≤1MiB），特殊文件一律 <50ms 回退内置。
//   ③ **B3（阻断 · 自我解除武装）**：≥32,768 字符的模式串让 `new RegExp` 抛 SyntaxError ⇒ 异常穿出
//      `matchText`，被 `index.js` 的 catch 吞成 `next()` ⇒ **一次抛出同时跳过所有守卫**。
//      修法：`try/catch`（失败缓存 null）+ 单串 ≤4096 字符 + 条数 ≤1024（与 B 仓统一）+ 外层兜底。
//   ④ **M3**：词内引号拼接（`r"m" -rf /tmp/x` 在 `/bin/sh` 里真执行 rm）三版全 MISS
//      ⇒ 新增「去词内引号」变体（贴着空白的引号原样保留）。
//   ⑤ **Minor 5**：全文层只扫变体① ⇒ 含字面转义的追加模式配了永不生效 ⇒ 改为扫全部变体。
//   ⑥ **Minor 7**：配置规模无上限（5,000 条 +99~137ms / 10,000 条 334ms）⇒ 条数与单串封顶。
//   ⑦ **Minor 4**：文件**缺失**静默（与 B 仓一致）；坏 JSON / 非普通文件 / 超限才告警一次。
//   ⑧ 源码级守卫：上述四处的接线/常量必须都在（删掉任一条都要转红）。
//
// 运行：node --test test/invariants-1-12-13.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  dangerousCommandMatch,
  dangerPatternsPath,
  normalizeDangerText,
  dangerTextPatterns,
  resetDangerPatternCache,
  DEFAULT_DANGER_PATTERNS,
} from '../lib/host-approval.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostSrc = fs.readFileSync(path.join(root, 'lib', 'host-approval.js'), 'utf8')

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-1-12-13-'))
const cfgFile = path.join(tmpHome, 'data', 'dsh-danger-patterns.json')
const origHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome // 隔离：判据只受本文件写入的配置影响

const rule = (text) => {
  const r = dangerousCommandMatch(text)
  return r ? r.rule : null
}
const writeCfg = (value) => {
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
  fs.writeFileSync(cfgFile, typeof value === 'string' ? value : JSON.stringify(value))
  resetDangerPatternCache()
}
const rmCfg = () => {
  try { fs.rmSync(cfgFile, { force: true, recursive: true }) } catch {}
  resetDangerPatternCache()
}
before(() => { rmCfg() })
after(() => {
  rmCfg()
  if (origHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = origHome
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

// ────────────────────────────────────────────────────────────────────
// ① B1：CR 家族（生成式 672 条 + 冻结位图）见 `test/no-relaxation-1-12-12.test.js` 的 G5 组；
//    这里只钉最小复现与混排形态（行为层），避免两处重复维护同一张位图。
describe('v1.12.13 不变量①（B1）：CR 家族的 1.12.11 读法不许丢', () => {
  it('终审 B1 的最小复现：`\\trm\\r-r\\r-f\\r/tmp/x`（字面 `\\t` + 裸 CR 分隔）', () => {
    // 注意：这里必须是**字面** `\t`（两个字符）—— 真实 TAB 形态走全文层也能命中，不能区分修复
    assert.equal(rule('\\trm\r-r\r-f\r/tmp/x'), 'rm -rf', '裸 CR 家族又漏了（旧口径读丢了）')
    assert.equal(rule('\\tgit\rpush\rorigin'), 'git push')
    assert.equal(rule('rm\r-rf\r/tmp/x'), 'rm -rf')
    assert.equal(rule('git\rpush origin main'), 'git push')
    assert.equal(rule('npm\rpublish'), 'npm publish')
    assert.equal(rule('x=\rrm\r-rf\r/tmp/x'), 'rm -rf')
    // 旧口径读（= 1.12.11 读法）的**直接**行为：去掉「裸 CR 折空格」这条分支就会红
    assert.equal(normalizeDangerText('a\rb', { literalEscapeAsSpace: true }), 'a b')
    assert.equal(normalizeDangerText('a\r\nb', { literalEscapeAsSpace: true }), 'a\nb')
    assert.equal(normalizeDangerText('a\rb'), 'a\nb', '新口径仍必须是段分隔符')
    // 真实 TAB 形态（走全文层）也不许漏
    assert.notEqual(rule('\trm\r-r\r-f\r/tmp/x'), null)
  })

  it('CRLF / 字面 `\\r` 两字符 / 裸 CR 混排同样不许漏', () => {
    for (const text of ['rm\r\n-rf\r\n/tmp/x', 'rm\\r-rf\\r/tmp/x', 'rm\r-rf\\r/tmp/x', 'sudo\rrm\r-rf\r/tmp/x']) {
      assert.notEqual(rule(text), null, `${JSON.stringify(text)} 变 MISS`)
    }
  })

  it('新口径（裸 CR 当段分隔符）不许被这次修复改掉：没有危险串的 CR 文本仍不弹', () => {
    assert.equal(rule('echo hi\rworld'), null)
    assert.equal(rule('ls\r-l'), null)
  })
})

// ────────────────────────────────────────────────────────────────────
// ② B2：配置路径是特殊文件时不许阻塞
describe('v1.12.13 不变量②（B2）：FIFO / 设备 / 目录 ⇒ 有界回退，绝不阻塞', () => {
  const timed = (fn) => {
    const t0 = process.hrtime.bigint()
    const value = fn()
    return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 }
  }

  it('FIFO（无写者）：不挂死、不抛、<50ms，且内置三串照常生效', () => {
    rmCfg()
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
    fs.rmSync(cfgFile, { force: true })
    execFileSync('mkfifo', [cfgFile]) // Node 没有 mkfifo API ⇒ 用系统命令（macOS / Linux 都有）
    resetDangerPatternCache()
    const first = timed(() => rule('echo hi'))
    const second = timed(() => rule('echo hi'))
    assert.equal(first.value, null, 'FIFO：普通文本不该命中')
    assert.ok(first.ms < 50, `FIFO：首次判定 ${first.ms.toFixed(1)}ms（≥50ms ⇒ 又阻塞了）`)
    assert.ok(second.ms < 50, `FIFO：第二次判定 ${second.ms.toFixed(1)}ms`)
    assert.deepEqual(dangerTextPatterns(), DEFAULT_DANGER_PATTERNS, 'FIFO：必须回退内置三串')
    assert.equal(rule('rm -rf /tmp/x'), 'rm -rf', 'FIFO：内置三串必须照常生效')
    rmCfg()
  })

  it('/dev/zero 软链、/dev/null 软链、目录 ⇒ 都 <50ms 回退（内置三串仍生效）', () => {
    const cases = [
      ['/dev/zero', () => fs.symlinkSync('/dev/zero', cfgFile)],
      ['/dev/null', () => fs.symlinkSync('/dev/null', cfgFile)],
      ['目录', () => fs.mkdirSync(cfgFile, { recursive: true })],
    ]
    for (const [name, mk] of cases) {
      rmCfg()
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
      mk()
      resetDangerPatternCache()
      const first = timed(() => rule('echo hi'))
      const second = timed(() => rule('echo hi'))
      assert.equal(first.value, null, `${name}：普通文本不该命中`)
      assert.ok(first.ms < 50, `${name}：首次判定 ${first.ms.toFixed(1)}ms（≥50ms ⇒ 又阻塞了）`)
      assert.ok(second.ms < 50, `${name}：第二次判定 ${second.ms.toFixed(1)}ms`)
      assert.deepEqual(dangerTextPatterns(), DEFAULT_DANGER_PATTERNS, `${name}：必须回退内置三串`)
      assert.equal(rule('rm -rf /tmp/x'), 'rm -rf', `${name}：内置三串必须照常生效`)
    }
    rmCfg()
  })
})

// ────────────────────────────────────────────────────────────────────
// ③ B3：超长模式串不许让判定抛异常（抛出去会连别的守卫一起跳过）
describe('v1.12.13 不变量③（B3）：超长模式串 ⇒ 忽略该条，不抛异常', () => {
  it('32,768 字符与 `"a b"×20000` 模式：无异常、内置三串照常命中', () => {
    for (const bad of ['x'.repeat(32768), 'a b'.repeat(20000)]) {
      writeCfg({ patterns: [bad] })
      assert.equal(rule('echo hi'), null, '普通文本不该命中')
      assert.equal(rule('rm -rf /tmp/x'), 'rm -rf', '内置三串必须照常命中（超限不等于关闭）')
      assert.equal(rule('git push origin main'), 'git push')
      assert.equal(rule('npm publish'), 'npm publish')
    }
    rmCfg()
  })

  it('4,096 字符以内仍然生效（上限不是「一律忽略」）', () => {
    writeCfg({ patterns: ['kubectl delete ns', 'z'.repeat(4000)] })
    assert.equal(rule('kubectl delete ns prod'), 'text:custom:kubectl delete ns')
    assert.equal(rule('z'.repeat(4000)), 'text:custom:' + 'z'.repeat(4000))
    rmCfg()
  })

  it('B3 威胁模型（V8 惰性编译）：构造不抛、首次 exec 抛「too large」；4096 上限把源钉在触发点之下', () => {
    // 终审 M-c 要求：把「构造 + 首次执行」都测出来再写。实测（Node v22.22.2）：
    //   · `new RegExp(源)` 对 32,768 字符模式串（源 32,803）**不抛** —— V8 正则编译是**惰性**的；
    //   · **首次 `exec()`** 才抛 `SyntaxError: Invalid regular expression …: Regular expression too large`；
    //   · 对照 32,700 字符（源 32,735）⇒ 构造与 exec 都 OK；跨度形态 `a b c …` 的最小抛错点
    //     = 11,345 字符（源 51,084）。
    // ⇒ 承重件是「**单串 4096 上限**（最坏源 20,507）+ `fullTextDangerMatch` 的**外层 try/catch
    //   覆盖 `re.exec()`**」；`dangerPatternRegExp` 里那个 try/catch 只挡构造失败。
    const build = (pattern) => {
      const parts = pattern.split(/\s+/).filter(Boolean).map((q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      return `(?<![A-Za-z0-9_-])${parts.join('[\\s"`\']+')}(?![A-Za-z0-9_-])`
    }
    const re = new RegExp(build('a'.repeat(32768)), 'i') // 构造：不抛
    assert.throws(() => re.exec('zzz'), /too large/, '32,768 字符模式串的首次 exec 必须抛（威胁模型确实可复现）')
    assert.equal(new RegExp(build('a'.repeat(32700)), 'i').exec('zzz'), null, '32,700 字符（源 32,735）应当照常可用')
    const worst = build(('* '.repeat(1400)).slice(0, 4096)) // 上限内的最坏形态（单字符 token + 转义）
    assert.ok(worst.length <= 20600, `4096 字符的最坏正则源 = ${worst.length}，必须留在触发点（源 32,803）之下`)
    assert.equal(new RegExp(worst, 'i').exec('zzz'), null, '上限内的最坏形态必须构造与 exec 都可用')
    assert.match(hostSrc, /const MAX_DANGER_PATTERN_CHARS = 4096\b/, '单串上限必须是 4096（放宽它就把源推向触发点）')
  })

  it('超限只告警一次，且不影响既有判定', () => {
    const warns = []
    const orig = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      writeCfg({ patterns: ['x'.repeat(9000)] })
      rule('echo hi'); rule('echo hi'); rule('echo hi')
    } finally { console.warn = orig }
    assert.equal(warns.length, 1, `超限告警应当只出现一次，实际 ${warns.length} 次`)
    assert.match(warns[0], /被忽略/)
    rmCfg()
  })
})

// ────────────────────────────────────────────────────────────────────
// ④ M3：词内引号拼接
describe('v1.12.13 不变量④（M3）：词内引号拼接（真会执行）不许漏', () => {
  it('`r"m" -rf /tmp/x` 等形态 ⇒ HIT（shell 里就是 rm -rf /tmp/x）', () => {
    assert.notEqual(rule('r"m" -rf /tmp/x'), null)
    assert.notEqual(rule("r'm' -rf /tmp/x"), null)
    assert.notEqual(rule('g"it" push origin main'), null)
    assert.notEqual(rule('n"pm" publish'), null)
    assert.notEqual(rule('p"npm" publish'), null)
    assert.notEqual(rule('sud"o" rm -rf /tmp/x'), null)
  })

  it('贴着空白的引号原样保留：既有文本的判定不变（提及仍按全文层归因）', () => {
    assert.equal(rule('echo "never run rm -rf /x by hand"'), 'text:rm -rf')
    assert.equal(rule("curl 'a=1&rm -rf'"), 'text:rm -rf')
    assert.equal(rule('echo "git push"'), 'text:git push')
    // 去词内引号**不会**凭空造出危险字样（`it's` → `its`、`df -h` 里没有危险串）
    assert.equal(rule("it's a normal message"), null)
    assert.equal(rule('echo "df -h"'), null)
    // Minor 3 的既有容差（`[\s"'\`]+` 也认引号）：`rm'-rf` 这种「词内引号」在 1.12.12 就已被全文层
    // 命中（误报方向、已登记）—— 本版**不扩大**也不缩小它
    assert.equal(rule('echo "rm\'-rf\'"'), 'text:rm -rf')
  })
})

// ────────────────────────────────────────────────────────────────────
// ⑤ Minor 5：全文层扫全部变体（含原文）
describe('v1.12.13 不变量⑤（Minor 5）：含字面转义的追加模式要生效', () => {
  it('模式 `foo\\nbar`（字面反斜杠）配上后必须命中原文形态', () => {
    writeCfg({ patterns: ['foo\\nbar'] })
    assert.equal(rule('foo\\nbar'), 'text:custom:foo\\nbar', '字面转义模式配了不生效（Minor 5 回归）')
    assert.equal(rule('echo hi'), null)
    rmCfg()
  })
})

// ────────────────────────────────────────────────────────────────────
// ⑥ Minor 7：规模上限
describe('v1.12.13 不变量⑥（Minor 7）：配置规模上限（条数 + 单串长度）', () => {
  it('1025 条追加 ⇒ 只生效前 1024 条（跨仓统一值）；被丢的条目不生效，内置三串恒在', () => {
    const warns = []
    const orig = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      writeCfg({ patterns: Array.from({ length: 1025 }, (_, i) => 'zzpat' + i) })
      const ps = dangerTextPatterns()
      assert.equal(ps.length, DEFAULT_DANGER_PATTERNS.length + 1024, `实际生效 ${ps.length} 条（应为 3 + 1024）`)
      assert.equal(ps.length, 1027)
      assert.equal(rule('zzpat1023'), 'text:custom:zzpat1023', '第 1024 条必须生效')
      assert.equal(rule('zzpat1024'), null, '第 1025 条（超限）不该生效')
      assert.equal(rule('rm -rf /tmp/x'), 'rm -rf', '超限不许把内置三串带没（绝不变成不判）')
    } finally { console.warn = orig }
    assert.equal(warns.length, 1, `超限只告警一次，实际 ${warns.length} 次`)
    assert.match(warns[0], /有 1 条追加模式被忽略/, '告警文本要说明忽略了几条')
    assert.match(warns[0], /追加条数 ≤1024/, '告警文本要写出统一后的上限（1024）')
    rmCfg()
  })

  it('上限值本身：源码里的条数上限必须是 1024（两仓统一；改回 256 就转红）', () => {
    // 注意（终审 Nit 6）：`MAX_DANGER_PATTERN_COUNT` **没有导出** ⇒ 这里只能做**源码正则断言**。
    // 它不是假绿：数值本身由**行为层**那条「1025 条追加 ⇒ 表长 1027（3 + 1024）」钉住 ——
    // 把常量改成别的数，那条行为用例先转红（`count-cap-256` 变异实测：2 条红）。
    assert.match(hostSrc, /const MAX_DANGER_PATTERN_COUNT = 1024/, '条数上限不是 1024（两仓口径又分裂了）')
    assert.ok(!/MAX_DANGER_PATTERN_COUNT = 256/.test(hostSrc), '上限还是旧的 256')
  })
})

// ────────────────────────────────────────────────────────────────────
// ⑦ Minor 4：告警口径
describe('v1.12.13 不变量⑦（Minor 4）：缺失文件静默；坏文件才告警一次', () => {
  it('文件缺失 ⇒ 不告警（正常状态），内置三串生效', () => {
    const warns = []
    const orig = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      rmCfg()
      rule('echo hi'); rule('echo hi')
    } finally { console.warn = orig }
    assert.equal(warns.length, 0, `缺失文件不该告警，实际 ${warns.length} 次：${warns[0] || ''}`)
    assert.equal(rule('rm -rf /tmp/x'), 'rm -rf')
  })

  it('空文件静默（= 没有追加项）', () => {
    const warns = []
    const orig = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      writeCfg('')
      rule('echo hi')
    } finally { console.warn = orig }
    assert.equal(warns.length, 0)
    rmCfg()
  })

  it('坏 JSON ⇒ 告警一次，且内置三串仍生效', () => {
    const warns = []
    const orig = console.warn
    console.warn = (...a) => warns.push(a.join(' '))
    try {
      writeCfg('{ not json')
      rule('echo hi'); rule('echo hi'); rule('echo hi')
    } finally { console.warn = orig }
    assert.equal(warns.length, 1, `坏 JSON 应当只告警一次，实际 ${warns.length} 次`)
    assert.equal(rule('rm -rf /tmp/x'), 'rm -rf')
    rmCfg()
  })
})

// ────────────────────────────────────────────────────────────────────
// ⑧ 源码级守卫
describe('v1.12.13 不变量⑧：源码级守卫（四处接线都在）', () => {
  it('B1：旧口径读把裸 CR 折空格（`pushSpace` 分支挂在 `literalEscapeAsSpace` 上）', () => {
    assert.match(hostSrc, /if \(literalEscapeAsSpace\) \{ \/\/ 旧口径（1\.12\.11 读法）：裸 CR \/ CRLF 折\*\*空格\*\*/)
    assert.match(hostSrc, /function pushSpace\(out\) \{/)
    // 新口径仍把裸 CR 当段分隔符（不许为了修 B1 把新口径也折成空格）
    assert.match(hostSrc, /新口径：CRLF \/ 裸 CR 都是行分隔（CRLF 只算一个分隔符）/)
  })

  it('B2：只读普通文件 + O_NONBLOCK + 有界 readSync（不得用 readFileSync 读配置）', () => {
    const start = hostSrc.indexOf('function readDangerConfigText(file) {')
    assert.ok(start > 0, 'readDangerConfigText 不见了')
    const body = hostSrc.slice(start, hostSrc.indexOf('\n}\n', start))
    assert.match(body, /fs\.openSync\(file, fs\.constants\.O_RDONLY \| fs\.constants\.O_NONBLOCK\)/, 'O_NONBLOCK 不见了（FIFO 会阻塞在 open）')
    assert.match(body, /if \(!st\.isFile\(\)\) return null/, 'isFile 检查不见了（FIFO/设备会被读）')
    assert.match(body, /readSync\(fd, buf, off, size - off, off\)/, '有界 readSync 不见了')
    assert.ok(!/readFileSync/.test(body), '配置读取里又出现了 readFileSync（B2 回归）')
    assert.match(hostSrc, /const MAX_DANGER_CONFIG_BYTES = 1 << 20/, '读取上限常量不见了')
    assert.ok(!/JSON\.parse\(fs\.readFileSync\(file, 'utf8'\)\)/.test(hostSrc), 'dangerTextPatterns 又直接用 readFileSync 了')
  })

  it('B3：`new RegExp` 有 try/catch（失败缓存 null）+ 单串长度上限 + 外层兜底', () => {
    assert.match(hostSrc, /const MAX_DANGER_PATTERN_CHARS = 4096/, '单串长度上限不见了')
    assert.match(hostSrc, /const MAX_DANGER_PATTERN_COUNT = 1024/, '条数上限不见了/不是 1024')
    const start = hostSrc.indexOf('function dangerPatternRegExp(pattern) {')
    const body = hostSrc.slice(start, hostSrc.indexOf('\n}\n', start))
    assert.match(body, /try \{\n        re = new RegExp\(/, 'new RegExp 没有包 try（B3 回归）')
    assert.match(body, /catch \{\n        re = null/, '构造失败没有落回 null')
    assert.match(body, /p\.length <= MAX_DANGER_PATTERN_CHARS/, '长度上限没有进 RegExp 之前')
    assert.match(hostSrc, /warnDangerConfigOnce\(`全文危险词扫描异常/, 'fullTextDangerMatch 的外层兜底不见了')
    assert.match(hostSrc, /p\.length > MAX_DANGER_PATTERN_CHARS \|\| appended >= MAX_DANGER_PATTERN_COUNT/, '超限条目没有在读取时被过滤')
  })

  it('Minor 5：全文层扫全部变体；Minor 4：缺失文件不告警', () => {
    assert.match(hostSrc, /for \(const variant of variants\) \{\n      const hit = fullTextDangerMatch\(variant\)/)
    assert.match(hostSrc, /\/\/ 文件\*\*缺失\*\*是正常状态（没配过）⇒ 静默回退，不告警/)
    assert.match(hostSrc, /key = `\$\{st\.mtimeMs\}:\$\{st\.size\}:\$\{st\.mode\}`/, '缓存键没有带上 mode（文件换成 FIFO 后不重判）')
  })

  it('M3：词内引号拼接变体在 matchText 的变体链里（且贴着空白的引号保留）', () => {
    assert.match(hostSrc, /stripWordInternalQuotes\(normalizeDangerText\(text\)\)/)
    assert.match(hostSrc, /function stripWordInternalQuotes\(text\) \{/)
    assert.match(hostSrc, /if \(prev && next && !\/\\s\/\.test\(prev\) && !\/\\s\/\.test\(next\)\) continue/)
  })
})

// ────────────────────────────────────────────────────────────────────
// ⑨（1.12.13 追加·跨仓纪律）：特殊文件八档 + fd 不泄漏 +「类型判定只靠 fd」
describe('v1.12.13 不变量⑨：特殊文件八档都要 ≤1s 回退，且危险门恒拦、fd 不泄漏', () => {
  const timed = (fn) => {
    const t0 = process.hrtime.bigint()
    const value = fn()
    return { value, ms: Number(process.hrtime.bigint() - t0) / 1e6 }
  }
  const openFds = () => {
    try { return fs.readdirSync('/dev/fd').length } catch { return -1 }
  }
  const fresh = () => {
    try { fs.rmSync(cfgFile, { force: true, recursive: true }) } catch {}
    fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
  }

  it('八档：FIFO / `/dev/zero` / `/dev/urandom` / 目录 / 悬空软链 / 自指软链 / 缺失 / 正常(自定义串生效)', () => {
    const cases = [
      ['FIFO', () => { fresh(); execFileSync('mkfifo', [cfgFile]) }, null],
      ['/dev/zero', () => { fresh(); fs.symlinkSync('/dev/zero', cfgFile) }, null],
      ['/dev/urandom', () => { fresh(); fs.symlinkSync('/dev/urandom', cfgFile) }, null],
      ['目录', () => { fresh(); fs.mkdirSync(cfgFile) }, null],
      ['悬空软链', () => { fresh(); fs.symlinkSync(path.join(tmpHome, 'not-there.json'), cfgFile) }, null],
      ['自指软链', () => { fresh(); fs.symlinkSync(cfgFile, cfgFile) }, null],
      ['缺失', () => { fresh() }, null],
      ['正常（含自定义串）', () => { fresh(); fs.writeFileSync(cfgFile, JSON.stringify({ patterns: ['kubectl delete ns'] })) }, 'text:custom:kubectl delete ns'],
    ]
    for (const [name, mk, customRule] of cases) {
      mk()
      resetDangerPatternCache()
      const probe = timed(() => rule('echo hi'))
      assert.ok(probe.ms < 1000, `${name}：普通文本判定 ${probe.ms.toFixed(1)}ms（≥1s ⇒ 又阻塞了）`)
      const danger = timed(() => rule('rm -rf /tmp/x'))
      assert.equal(danger.value, 'rm -rf', `${name}：危险门必须恒拦`)
      assert.ok(danger.ms < 1000, `${name}：危险判定 ${danger.ms.toFixed(1)}ms（≥1s ⇒ 又阻塞了）`)
      if (customRule === null) {
        assert.equal(rule('kubectl delete ns prod'), null, `${name}：不该用上追加项`)
      } else {
        assert.equal(rule('kubectl delete ns prod'), customRule, `${name}：追加项必须生效`)
      }
    }
    rmCfg()
  })

  it('fd 不泄漏：FIFO 配置下判 200 次，进程 fd 数不变', () => {
    fresh()
    execFileSync('mkfifo', [cfgFile])
    resetDangerPatternCache()
    for (let i = 0; i < 20; i += 1) { resetDangerPatternCache(); rule('echo hi') } // 预热
    const before = openFds()
    for (let i = 0; i < 200; i += 1) { resetDangerPatternCache(); rule('echo hi'); rule('rm -rf /tmp/x') }
    const after = openFds()
    assert.ok(before > 0 && after > 0, '拿不到 /dev/fd 计数（守卫会空转）')
    assert.ok(Math.abs(after - before) <= 2, `fd 数从 ${before} 变成 ${after}（疑似泄漏）`)
    rmCfg()
  })

  it('模拟 TOCTOU（stat 谎报「普通文件」、路径实为 FIFO）⇒ 子进程判定仍不阻塞（≤5s）', () => {
    // 终审（B 仓）证明过：把 `readFileSync` 用在 FIFO 上 ⇒ 谎报「普通文件 100B」的 FIFO 会被冻死
    // （timeout 6 ⇒ exit 124）。这里用**子进程 + 超时**复现该场景：
    //   · 当前实现（`open(O_NONBLOCK)` → `fstat(fd)` → `isFile` → **有界 `readSync`**）⇒ 子进程 5s 内正常退出；
    //   · 一旦有人退回 `readFileSync`（无 NONBLOCK / 无界读）⇒ 子进程被 SIGTERM 杀掉 ⇒ 转红。
    // **承重件写准（终审 M-b）**：真正救命的是「**NONBLOCK fd + 有界 `readSync`**」，
    // 不是「按 fd 判类型」本身 —— 只把 `fstatSync(fd)` 换成 `statSync(file)`（变异 `stat-typing`）
    // 时本用例**照样通过**（仍是 NONBLOCK fd + 有界读，谎报类型的 stat 不会阻塞）；
    // 「按路径 stat 判类型」这条路只由下面那条源码守卫 + 计数行为牙（`statSync` 次数必须是 1 不是 2）覆盖。
    // 用子进程的理由：同步阻塞的挂死没法用同进程定时器救，放在套件里会把整套测试挂住。
    fresh()
    execFileSync('mkfifo', [cfgFile])
    const libUrl = pathToFileURL(path.join(root, 'lib', 'host-approval.js')).href
    const probe = `
      import fs from 'node:fs'
      const real = fs.statSync
      fs.statSync = (p, ...r) => (String(p) === ${JSON.stringify(cfgFile)}
        ? { isFile: () => true, mtimeMs: 1, size: 100, mode: 33188 }
        : real(p, ...r))
      const ha = await import(${JSON.stringify(libUrl)})
      const t0 = Date.now()
      // **必须走只有全文层能判的形态**（echo 提及）：否则词法层先命中，
      // 根本不会去读配置文件 ⇒ 这条探针就测不到「配置读取会不会挂死」。
      const hit = ha.dangerousCommandMatch('echo "rm -rf /tmp/x"')
      console.log('PROBE-OK', hit && hit.rule, Date.now() - t0)
    `
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe],
      { timeout: 5000, encoding: 'utf8', env: { ...process.env, DSH_HOME: tmpHome } })
    assert.equal(r.status, 0, `子进程没有正常退出（status=${r.status}, signal=${r.signal}）—— 类型判定又按路径 stat 了`)
    assert.match(r.stdout || '', /PROBE-OK text:rm -rf/, `子进程输出不对：${JSON.stringify((r.stdout || '').slice(0, 200))}`)
    rmCfg()
  })

  it('「类型判定只靠 fd」源码守卫 + 承重件计数行为牙（M-b）：FIFO 档 readSync=0/statSync=1，正常档 readSync≥1', () => {
    const start = hostSrc.indexOf('function readDangerConfigText(file) {')
    assert.ok(start > 0)
    const body = hostSrc.slice(start, hostSrc.indexOf('\n}\n', start))
    // 注意：`fstatSync` 是**允许**的（而且正是要求）；这里禁的是 `fs.statSync`（按路径判类型 ⇒ TOCTOU）
    assert.ok(!/(?<!f)statSync\s*\(/.test(body), '读配置的函数里出现了 statSync（TOCTOU：谎报的 stat 会让我们去读 FIFO）')
    assert.ok(!/readFileSync/.test(body), '读配置的函数里出现了 readFileSync')
    assert.match(body, /fs\.openSync\(file, fs\.constants\.O_RDONLY \| fs\.constants\.O_NONBLOCK\)/)
    assert.match(body, /const st = fs\.fstatSync\(fd\)\n    if \(!st\.isFile\(\)\) return null/)
    // 顺序：open → fstat → isFile ⇒ 判类型**在读取之前**（`open` 用 O_NONBLOCK ⇒ 无写者 FIFO 立刻 ENXIO）
    const iOpen = body.indexOf('openSync(')
    const iFstat = body.indexOf('fstatSync(')
    const iRead = body.indexOf('readSync(')
    assert.ok(iOpen >= 0 && iFstat > iOpen && iRead > iFstat, 'open → fstat → read 的顺序被改了')
    assert.match(hostSrc, /if \(!st\.isFile\(\)\) \{\n      warnDangerConfigOnce|if \(!st\.isFile\(\)\) return null/)

    // ── 行为牙（终审 M-b）────────────────────────────────────────────
    // ①「非普通文件档：判类型在**读取之前**」⇒ openSync = 1、readSync = **0**；
    // ②「正常文件档必须走**有界 readSync**」⇒ readSync ≥ 1（退回 `readFileSync` ⇒ 计数为 0 ⇒ 转红，
    //    这正是唯一被实测冻死的变异体 `no-fd-type-check`）；
    // ③「按**路径** stat 判类型」（变异 `stat-typing`）⇒ 每次判定的 `statSync` 次数从 1 变 **2** ⇒ 转红。
    fresh()
    execFileSync('mkfifo', [cfgFile])
    const counts = { stat: 0, open: 0, read: 0 }
    const origStat = fs.statSync
    const origOpen = fs.openSync
    const origRead = fs.readSync
    fs.statSync = (...a) => { counts.stat += 1; return origStat(...a) }
    fs.openSync = (...a) => { counts.open += 1; return origOpen(...a) }
    fs.readSync = (...a) => { counts.read += 1; return origRead(...a) }
    try {
      resetDangerPatternCache()
      counts.stat = 0; counts.open = 0; counts.read = 0
      assert.equal(rule('echo hi'), null, 'FIFO 档 ⇒ 没有追加项（普通文本不命中）')
      assert.equal(counts.open, 1, `FIFO 档应当恰好 open 一次（实得 ${counts.open}）`)
      assert.equal(counts.read, 0, `非普通文件档必须在 read 之前返回（readSync 实得 ${counts.read}）`)
      assert.equal(counts.stat, 1, `按路径 stat 判类型会让 statSync 变 2 次（实得 ${counts.stat}）⇒ M-b 变异转红`)
      // 正常文件档
      fresh()
      fs.writeFileSync(cfgFile, JSON.stringify({ patterns: ['kubectl delete ns'] }))
      resetDangerPatternCache()
      counts.stat = 0; counts.open = 0; counts.read = 0
      assert.equal(rule('kubectl delete ns prod'), 'text:custom:kubectl delete ns', '正常档追加项必须生效')
      assert.ok(counts.read >= 1, `正常文件档必须走有界 readSync（实得 ${counts.read}）；退回 readFileSync ⇒ 0 ⇒ 转红`)
      assert.ok(counts.open >= 1, `正常文件档必须 open（实得 ${counts.open}）`)
    } finally {
      fs.statSync = origStat
      fs.openSync = origOpen
      fs.readSync = origRead
      rmCfg()
    }
  })
})
