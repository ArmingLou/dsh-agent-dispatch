// test/invariants-1-12-12.test.js — v1.12.12「全文危险词扫描（可配置）」的 7 条不变式。
//
// 用户裁定（原话）：「**改成全文子串判定：文本里出现危险字样就弹**」+（补充）「做成一个配置项，
// 以后可以动态增加高危判断的字符串。目前预设 `rm -rf`、`git push`、`npm publish` 三个先」。
//
// 设计约束（来自 B 仓终审对朴素 `includes()` 的实测预判）：
//   · 结构型判据（`shell-nesting` / `wrapper-nesting` / `shell-stdin` / `su-shell` / 选项位置）
//     **一律不许**改成全文匹配 —— 它们是计数/位置判据，全文子串表达不了「嵌套了几层」；
//   · 本轮**只做加法**：既有按段/命令头 + 形状 + 多读全部保留 ⇒ 相对上一版 `relaxed` 必须 0；
//   · 必须**加词边界**，否则会拦下正常英文单词（`perform -rf x` / `legit push` / `npm publisher`）。
//
// 本文件钉住：
//   ① 三个预设串 × 三种位置（命令头 / 段中 / 引号内）⇒ 全 HIT（含归因名 `text:<模式>`）；
//   ② 配置项：缺失 / 坏 JSON / `patterns` 非数组 / `[]` ⇒ 一律等价于「没有追加项」
//      （**内置三串恒生效、不可通过配置关闭** —— 配置文件可写，否则等于留了自我解除武装的口子）；
//      自定义串 ⇒ **改文件后下一次判定立刻生效**（不重装 / 不重启）；trim / 丢空 / 去重；
//   ③ 匹配语义：容忍空白与引号、**按字面**（不是正则 ⇒ 无注入面）、词边界（反例逐条 MISS）；
//   ④ 结构判据不动：计数判据仍按层数/跳数报（`sh -c` ×3、`sudo` ×9）；
//   ⑤ 只做加法：既有内容规则的等价写法（`rm -r -f`、`/bin/rm -rf`、`git -C /tmp push` …）一条不丢；
//   ⑥ 代价（用户裁定）：提及 ⇒ 弹（本文件只钉行为，不写豁免）；
//   ⑦ 性能：500KB 对抗输入仍在既有 G3 线（<100ms）量级内。
//
// 运行：node --test test/invariants-1-12-12.test.js

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  dangerousCommandMatch,
  dangerPatternsPath,
  dangerTextPatterns,
  fullTextDangerMatch,
  resetDangerPatternCache,
  DEFAULT_DANGER_PATTERNS,
  SHELL_DEPTH_RULE,
  WRAPPER_DEPTH_RULE,
  WRAPPER_OPTION_AMBIGUITY_RULE,
} from '../lib/host-approval.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const hostSrc = readFileSync(path.join(root, 'lib', 'host-approval.js'), 'utf8')
const stripComments = (text) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const hostCode = stripComments(hostSrc)

const NL = '\n'
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-danger-patterns-'))
const cfgFile = path.join(tmpHome, 'data', 'dsh-danger-patterns.json')
const origHome = process.env.DSH_HOME
const writeCfg = (value) => {
  fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
  fs.writeFileSync(cfgFile, typeof value === 'string' ? value : JSON.stringify(value))
  resetDangerPatternCache()
}
const rmCfg = () => {
  try { fs.unlinkSync(cfgFile) } catch {}
  resetDangerPatternCache()
}
const rule = (cmd) => dangerousCommandMatch(cmd)?.rule ?? null

before(() => {
  process.env.DSH_HOME = tmpHome
  rmCfg()
})
after(() => {
  if (origHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = origHome
  resetDangerPatternCache()
  fs.rmSync(tmpHome, { recursive: true, force: true })
})

describe('v1.12.12 不变量①：三个预设串 × 三种位置 ⇒ 全 HIT', () => {
  it('命令头 / 段中 / 引号内都命中，且归因是 `text:<模式>` 或既有内容规则名', () => {
    rmCfg()
    const rows = [
      // rm -rf
      ['rm -rf /tmp/x', 'rm -rf'],                                   // 命令头（既有规则）
      ['true && cd /tmp && rm -rf /tmp/x', 'rm -rf'],                // 段中
      ['echo hi' + NL + '- rm -rf /tmp/x', WRAPPER_OPTION_AMBIGUITY_RULE], // 段中（形状判据先报）
      ['echo "note: rm -rf /tmp/x"', 'text:rm -rf'],                 // 引号内（全文层）
      // git push
      ['git push origin main', 'git push'],
      ['cd /tmp && git push origin main', 'git push'],
      ['git log --grep "git push"', 'text:git push'],
      // npm publish
      ['npm publish', 'npm publish'],
      ['cd /tmp && npm publish', 'npm publish'],
      ['echo "npm publish"', 'text:npm publish'],
    ]
    for (const [cmd, want] of rows) {
      assert.equal(rule(cmd), want, `${JSON.stringify(cmd)} 判定不对`)
    }
  })

  it('非预设的内容规则**不**走全文层（pnpm/yarn publish 仍由既有词法规则命中）', () => {
    rmCfg()
    assert.equal(rule('pnpm publish'), 'pnpm publish')
    assert.equal(rule('yarn publish'), 'yarn publish')
    // 段中/引号内的 pnpm publish 不在预设三串里 ⇒ 全文层不管（这是配置的边界，如实钉住）
    assert.equal(rule('echo "pnpm publish"'), null)
    assert.equal(rule('echo "yarn publish"'), null)
  })
})

describe('v1.12.12 不变量②：配置项（路径 / 回退 / 关闭 / 动态生效）', () => {
  it('路径与预设值符合规格（`$DSH_HOME/data/dsh-danger-patterns.json`）', () => {
    assert.equal(path.basename(dangerPatternsPath()), 'dsh-danger-patterns.json')
    assert.ok(dangerPatternsPath().endsWith(path.join('data', 'dsh-danger-patterns.json')))
    assert.deepEqual(DEFAULT_DANGER_PATTERNS, ['rm -rf', 'git push', 'npm publish'])
    rmCfg()
    assert.deepEqual(dangerTextPatterns(), ['rm -rf', 'git push', 'npm publish'])
  })

  it('缺失 / 坏 JSON / `patterns` 非数组 / `[]` ⇒ 只增不减（内置三串一律照常生效）', () => {
    // **配置只增不减**：配置文件在 $DSH_HOME/data/ 下、任何能写它的命令都能改它 ⇒
    // 若允许「关闭」，等于给危险命令留一条「先把自己的门关掉」的自解除武装路径。
    const builtin = [[ 'echo "rm -rf /x"', 'text:rm -rf'], ['echo "git push"', 'text:git push'],
      ['echo "npm publish"', 'text:npm publish']]
    rmCfg()
    for (const [cmd, want] of builtin) assert.equal(rule(cmd), want, '文件缺失时内置串必须照常生效')
    writeCfg('{ 这不是 JSON')
    assert.deepEqual(dangerTextPatterns(), DEFAULT_DANGER_PATTERNS, '坏 JSON ⇒ 没有追加项（内置三串仍在）')
    for (const [cmd, want] of builtin) assert.equal(rule(cmd), want, '坏 JSON 时内置串必须照常生效')
    writeCfg({ patterns: 'rm -rf' })
    assert.deepEqual(dangerTextPatterns(), DEFAULT_DANGER_PATTERNS, 'patterns 非数组 ⇒ 没有追加项')
    for (const [cmd, want] of builtin) assert.equal(rule(cmd), want, 'patterns 非数组时内置串必须照常生效')
    writeCfg({ _readme: '允许带注释字段', patterns: [] })
    assert.deepEqual(dangerTextPatterns(), DEFAULT_DANGER_PATTERNS, '[] ⇒ 没有追加项（**不可关闭**）')
    for (const [cmd, want] of builtin) assert.equal(rule(cmd), want, '[] 时内置串必须照常生效')
    assert.equal(fullTextDangerMatch('echo "rm -rf /x"')?.rule, 'text:rm -rf')
    // 既有按段/命令头判定当然也照旧
    assert.equal(rule('rm -rf /tmp/x'), 'rm -rf')
    assert.equal(rule('echo hi' + NL + '- rm -rf /tmp/x'), WRAPPER_OPTION_AMBIGUITY_RULE)
  })

  it('自定义串 + trim/丢空/去重 + **改文件后下一次判定立刻生效**（不重启）', () => {
    writeCfg({ patterns: ['  kubectl   delete ns ', '', 'kubectl delete ns', 'rm -rf'] })
    // 只增不减：内置三串在前，追加项顺序在后（`rm -rf` 与内置重复 ⇒ 去重）
    assert.deepEqual(dangerTextPatterns(),
      ['rm -rf', 'git push', 'npm publish', 'kubectl delete ns'], 'trim / 折叠空白 / 丢空 / 去重')
    assert.equal(rule('echo "kubectl delete ns prod"'), 'text:custom:kubectl delete ns')
    assert.equal(rule('echo "rm -rf /x"'), 'text:rm -rf')
    // 不调用任何 reset：直接改文件 ⇒ 下一次判定就用新串（mtime+size 变化重读）
    writeCfg({ patterns: ['helm uninstall prod'] })
    assert.equal(rule('echo "helm uninstall prod"'), 'text:custom:helm uninstall prod')
    assert.equal(rule('echo "kubectl delete ns prod"'), null, '删掉的串必须立刻失效')
    // 追加项清空 ⇒ 追加串立刻失效，但**内置三串仍在**（只增不减）
    writeCfg({ patterns: [] })
    assert.equal(rule('echo "helm uninstall prod"'), null)
    assert.equal(rule('echo "rm -rf /x"'), 'text:rm -rf')
    rmCfg()
    assert.deepEqual(dangerTextPatterns(), DEFAULT_DANGER_PATTERNS)
  })

  it('归因名：内置 `text:<模式>`、自定义 `text:custom:<原串>`', () => {
    rmCfg()
    assert.equal(rule('echo "git push"'), 'text:git push')
    writeCfg({ patterns: ['docker system prune -af'] })
    assert.equal(rule('echo "docker system prune -af"'), 'text:custom:docker system prune -af')
    rmCfg()
  })
})

describe('v1.12.12 不变量③：匹配语义（空白/引号容差、字面、词边界）', () => {
  it('容差：任意空白（归一化后折叠）、TAB、续行拼接、引号包裹 ⇒ 都命中', () => {
    rmCfg()
    for (const cmd of ['rm  -rf /tmp/x', 'rm    -rf /tmp/x', 'rm\t-rf /tmp/x', 'rm \\t -rf /tmp/x',
      'git   push origin main', 'npm  publish', 'rm "-rf" /tmp/x', "rm '-rf' /tmp/x",
      'rm \\' + NL + '-rf /tmp/x', 'git \\' + NL + 'push origin main']) {
      assert.notEqual(rule(cmd), null, `${JSON.stringify(cmd)} 应命中（容差）`)
    }
    // 既有词法规则的等价写法（不在全文层，但**必须**继续命中）
    for (const [cmd, want] of [['rm -r -f /tmp/x', 'rm -rf'], ['rm -fr /tmp/x', 'rm -rf'],
      ['rm --recursive --force /tmp/x', 'rm -rf'], ['/bin/rm -rf /tmp/x', 'rm -rf'],
      ['sudo rm -rf /tmp/x', 'rm -rf'], ['git -C /tmp push', 'git push'],
      ['npm --prefix /tmp publish', 'npm publish']]) {
      assert.equal(rule(cmd), want, `${cmd} 的既有覆盖丢了（那就是变松）`)
    }
  })

  it('词边界：正常英文单词/更长程序名里的「字样」不算（逐条反例）', () => {
    rmCfg()
    for (const cmd of ['perform -rf x', 'legit push origin main', 'digit push', 'npm publisher',
      'git pushd', 'git pushpin', 'rmdir -rf', 'format -rf', 'echorm -rf', 'xrm -rf /tmp/x',
      'git log --grep push', 'npm run publish', 'pnpm run publish', 'rm -r /tmp/x', 'rm -f /tmp/x']) {
      assert.equal(rule(cmd), null, `${JSON.stringify(cmd)} 不该命中（词边界/语义反例）`)
    }
    // `rm -rfx`：命中（**既有** `rm` 规则按选项字符扫，`-rfx` 含 r+f ⇒ `rm -rf`），与全文层无关
    assert.equal(rule('rm -rfx /tmp/x'), 'rm -rf')
  })

  it('**按字面**匹配，不是正则（防注入）', () => {
    writeCfg({ patterns: ['a.*b', '(rm|git)'] })
    assert.equal(rule('echo axxb'), null, '模式里的 `.`/`*` 不能当正则通配')
    assert.equal(rule('echo "a.*b"'), 'text:custom:a.*b', '字面出现才算')
    assert.equal(rule('echo "rm"'), null, '模式 `(rm|git)` 不应被当成分组/选一执行')
    assert.equal(rule('echo "(rm|git)"'), 'text:custom:(rm|git)')
    rmCfg()
  })
})

describe('v1.12.12 不变量④：结构判据一律没改成全文匹配', () => {
  it('计数判据仍按层数/跳数报（全文层表达不了「嵌套了几层」）', () => {
    rmCfg()
    assert.equal(rule('sh -c \'sh -c "sh -c ls"\''), SHELL_DEPTH_RULE)
    assert.equal(rule(`${'sudo '.repeat(9)}ls`), WRAPPER_DEPTH_RULE)
    assert.equal(rule(`${'sudo '.repeat(8)}rm -rf /tmp/x`), 'rm -rf')
    // 全文层的模式清单里不允许出现结构型门名/包装器名
    for (const banned of ['shell-nesting', 'wrapper-nesting', 'shell-stdin', 'su-shell', 'sudo']) {
      assert.ok(!DEFAULT_DANGER_PATTERNS.includes(banned), `预设串里混进了结构型词：${banned}`)
    }
    // 源码级：结构判据常量仍在、没有被改成「模式」驱动的分支
    for (const need of ['SHELL_DEPTH_RULE', 'WRAPPER_DEPTH_RULE', 'SHELL_STDIN_RULE', 'SU_SHELL_RULE']) {
      assert.ok(hostCode.includes(need), `结构判据常量不见了：${need}`)
    }
  })

  it('只做加法：既有全部等价写法与形状门一条不破（回归表）', () => {
    rmCfg()
    for (const [cmd, want] of [
      ['bash -c "rm -rf /tmp/x"', 'rm -rf'], ["sh -c 'rm -rf /tmp/x'", 'rm -rf'],
      ['echo x | xargs rm -rf /tmp/x', 'rm -rf'], ['find /tmp -exec rm -rf {} +', 'rm -rf'],
      ['git -c k=v push', 'git push'], ['pnpm publish', 'pnpm publish'], ['yarn publish', 'yarn publish'],
      ['cat <<EOF > f' + NL + 'body' + NL + 'EOF' + NL + 'rm -rf /tmp/x', 'rm -rf'],
      ['rm -rf /tmp/x <<\'EOF\'' + NL + 'body' + NL + 'EOF', 'rm -rf'],
      ['-rf /x', WRAPPER_OPTION_AMBIGUITY_RULE],
      ["env -S 'rm -rf /x'", WRAPPER_OPTION_AMBIGUITY_RULE],
      ['' + 'echo hi', null], ['bash -c "echo hi"', null],
    ]) {
      assert.equal(rule(cmd), want, `${cmd} 的判定变了（只做加法）`)
    }
  })
})

describe('v1.12.12 不变量⑤：代价（用户裁定）—— 提及也弹', () => {
  it('提交信息 / 注释 / 文档 / grep 参数里的字样 ⇒ 弹（有意取舍，不是缺陷）', () => {
    rmCfg()
    for (const [cmd, want] of [
      ['git commit -m "fix: avoid rm -rf"', 'text:rm -rf'],          // 提交正文
      ['# 注释：不要用 rm -rf', 'text:rm -rf'],                        // 注释
      ['cat <<EOF > notes' + NL + '正文提到 npm publish' + NL + 'EOF', 'text:npm publish'], // 文档写入
      ['git log --grep "git push"', 'text:git push'],                // grep 模式
      ['echo "use sudo to install"', null],                          // sudo 是**包装器（结构型）**，不在预设里
    ]) {
      assert.equal(rule(cmd), want, `${JSON.stringify(cmd)} 判定不对（代价口径）`)
    }
  })
})

describe('v1.12.12 不变量⑥：性能（既有 G3 线）', () => {
  it('500KB 对抗输入仍在 <100ms 量级；普通输入零退化', () => {
    rmCfg()
    const big = 'sudo '.repeat(100000) + 'ls'
    dangerousCommandMatch(big.slice(0, 400))
    let t0 = performance.now()
    dangerousCommandMatch(big)
    const padMs = performance.now() - t0
    assert.ok(padMs < 500, `500KB 包装词填充耗时 ${padMs.toFixed(1)}ms（应仍在 G3 线量级）`)
    // 模式命中在尾部（全文层要扫到尾部）。注意**优先级**：`rm -rf /x` 自己是一段、段首就是
    // `rm` ⇒ 既有按段规则先报（`rm -rf`）；全文层只在前面都没命中时才兜底（引号内那类）。
    const tail = 'echo hi' + NL + 'rm -rf /x'
    assert.equal(rule(tail), 'rm -rf')
    assert.equal(rule('echo hi' + NL + 'echo "rm -rf /x"'), 'text:rm -rf')
    const ordinary = "git add -A\ngit commit -q -F - <<'EOF'\nfix: x\nEOF"
    dangerousCommandMatch(ordinary)
    t0 = performance.now()
    for (let i = 0; i < 200; i += 1) dangerousCommandMatch(ordinary)
    const per = (performance.now() - t0) / 200
    assert.ok(per < 5, `典型调用每次 ${per.toFixed(3)}ms（不该被全文层拖慢）`)
  })
})

describe('v1.12.12 不变量⑦：源码级守卫', () => {
  it('接线 / 常量 / 配置读取都在，且只在最外层跑一次', () => {
    assert.match(hostCode, /export function fullTextDangerMatch\(text\) \{/)
    assert.match(hostCode, /export function dangerTextPatterns\(\) \{/)
    assert.match(hostCode, /export function resetDangerPatternCache\(\) \{/)
    assert.match(hostCode, /export const DEFAULT_DANGER_PATTERNS = \['rm -rf', 'git push', 'npm publish'\]/)
    assert.match(hostCode, /path\.join\(home, 'data', 'dsh-danger-patterns\.json'\)/, '配置文件路径变了')
    assert.match(hostCode, /process\.env\.DSH_HOME \|\| path\.join\(os\.homedir\(\), '\.dsh'\)/, 'DSH_HOME 口径变了')
    assert.match(hostCode, /statSync\(file\)/, '没有按 mtime+size 判断变更（动态生效会失效）')
    assert.match(hostCode, /if \(depth === 0\) \{/, '全文层应当只在最外层跑一次')
    // v1.12.13（终审 Minor 5）：全文层要扫**全部**变体（含原文），否则含字面转义的追加模式配了不生效
    assert.match(hostCode, /for \(const variant of variants\) \{\n      const hit = fullTextDangerMatch\(variant\)/,
      '全文层没有扫全部变体（Minor 5：字面转义的追加模式会永不生效）')
    // 字面转义：模式必须被 escape 后才进 RegExp（不是把用户串当正则）——
    // 行为证据见上一条「按字面匹配」；这里只钉源码里存在转义替换串 `\\$&` 与 `new RegExp(`
    assert.ok(hostCode.includes('\\\\$&'), '模式没有做正则转义（会被当正则执行 ⇒ 注入面）')
    assert.ok(hostCode.includes('new RegExp('), '模式没有编译成正则（容差/词边界会丢）')
  })
})
