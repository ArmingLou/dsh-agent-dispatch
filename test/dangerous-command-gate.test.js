// test/dangerous-command-gate.test.js — v1.12.6：宿主侧「危险命令」排除门。
//
// 用户裁决：`rm -rf` / `npm publish` / `git push` 这三条**在任何档位下都必须走交互
// 授权**——工具名档、会话路径档、落盘项目档，一档都不许静默放行。产品侧
// （dsh-plugin-product-subagents 的 lib/dangerous-commands.js:79-83 + lib/index.js:219-223）
// 已有这道门；本仓库此前**一条都没有**（全仓 grep `rm -rf`/`npm publish`/`git push`
// 零命中——这正是本文件要钉住的缺口）。
//
// 两层断言：
//   · 判据层：lib/host-approval.js 的纯函数（覆盖边界、误伤守卫、脏输入）；
//   · 监听器层：真跑 index.js 的 approval/request handler（假宿主 session），
//     断言「已授权 bash」状态下这三条命令仍然 next()，且日志里留了门名。
//
// 运行：node --test test/dangerous-command-gate.test.js

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot, mkSession } from './agent-api-harness.js'
import {
  DANGEROUS_COMMAND_RULES,
  MAX_SHELL_UNWRAP_DEPTH,
  MAX_WRAPPER_UNWRAP_HOPS,
  SHELL_DEPTH_RULE,
  SHELL_STDIN_RULE,
  // v1.12.6 第五轮（终审 M-C②）：`source` / `.` 保守转交互的门名
  SHELL_SOURCE_RULE,
  WRAPPER_DEPTH_RULE,
  // v1.12.6 第六轮（终审 M-D / Minor 2 / Minor 3）：`su`/`runuser` 没有 `-c` 的门名、
  // `commandText` 超限的门名、有界截断的上限与截断函数
  SU_SHELL_RULE,
  COMMAND_TOO_LONG_RULE,
  // v1.12.6 第七轮（终审阻断 A/B）：剥壳后结构性可疑（把选项当程序名 / 命令被当成取值吃掉）的门名
  WRAPPER_OPTION_AMBIGUITY_RULE,
  MAX_DANGER_TEXT_CHARS,
  MAX_ATTRIBUTION_TOKENS,
  boundDangerText,
  normalizeDangerText,
  splitSubCommands,
  commandTextOf,
  argsTextOf,
  isExecuteTool,
  dangerousCommandMatch,
} from '../lib/host-approval.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const indexSrc = readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8')
const hostSrc = readFileSync(path.join(__dirname, '..', 'lib', 'host-approval.js'), 'utf8')

/** 驱动真实 approval/request 监听器：res==='allowed-once' 即插件自动放行 */
async function approve(b, session, { callId = null, toolName = null, reason = 'tool requires approval' } = {}) {
  let nextCalled = false
  const outs = b.fireEvent(
    'approval/request',
    { agent: { session }, callId, toolName, reason },
    () => { nextCalled = true; return 'NEXT' },
  )
  const res = await outs[0]
  return { res, nextCalled }
}

const postRule = (b, body) => b.req('POST', '/agent-api/host-approval-rule', body)

/** 决策日志（dispatches.jsonl）行 */
const logRows = (home) => {
  const f = path.join(home, 'data', 'dsh-agent-dispatch', 'dispatches.jsonl')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}

/** 执行类工具调用记录（name 与 arguments 自洽：bash 就带 command 正文） */
const bashCall = (callId, command) => [{ callId, name: 'bash', arguments: { command } }]

/** 起一个实例、把 bash 授权到根会话键上（= 最宽的自动放行前置条件），再交还句柄 */
async function bootWithBashGranted() {
  const b = await boot()
  const s1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: bashCall('g1', 'echo hi') })
  const first = await approve(b, s1, { callId: 'g1', toolName: 'bash' })
  assert.equal(first.nextCalled, true, '前置：首次请求应交给交互层')
  const { status, json } = await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'g1', toolName: 'bash' })
  assert.equal(status, 200)
  assert.equal(json.rootSessionId, 'R', '前置：授权应落在根会话键上')
  return b
}

// ════════════════════════════════════════════════════════════════════
describe('判据层：DANGEROUS_COMMAND_RULES 与产品侧同一份名单', () => {
  it('名单是单点常量，id 与产品侧逐字对齐（pnpm/yarn publish 是本轮按用户裁定新纳入）', () => {
    assert.deepEqual(DANGEROUS_COMMAND_RULES.map((r) => r.id),
      ['rm -rf', 'npm publish', 'pnpm publish', 'yarn publish', 'git push'],
      'pnpm/yarn 的 publish 与 npm 同语义（用户裁定纳入），改动需同步 CHANGELOG 与产品侧')
    // 与 product-subagents 的 lib/dangerous-commands.js 同源，注释里必须写明要人工同步
    assert.match(hostSrc, /与 product-subagents[^\n]*同一份/, 'host-approval.js 未声明名单来源与同步要求')
    assert.match(hostSrc, /dangerous-commands\.js/, '未注出产品侧文件路径，后人无从同步')
  })

  it('命中：rm -rf 及其常见等价写法（必须同时具备递归与强制）', () => {
    for (const cmd of [
      'rm -rf /tmp/x', 'rm -fr /tmp/x', 'rm -r -f /tmp/x', 'rm -f -R /tmp/x',
      'rm --recursive --force /tmp/x', 'rm /tmp/x -rf', 'RM -RF /tmp/x',
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, 'rm -rf', `${cmd} 未命中`)
    }
    // 单旗帜不触发（与产品侧口径一致）
    for (const cmd of ['rm -r /tmp/x', 'rm -f /tmp/x', 'rm /tmp/x']) {
      assert.equal(dangerousCommandMatch(cmd), null, `${cmd} 不该命中`)
    }
  })

  it('命中：npm publish / git push（含前置全局选项）', () => {
    assert.equal(dangerousCommandMatch('npm publish')?.rule, 'npm publish')
    assert.equal(dangerousCommandMatch('npm --silent publish')?.rule, 'npm publish')
    assert.equal(dangerousCommandMatch('git push origin main')?.rule, 'git push')
    assert.equal(dangerousCommandMatch('git --no-pager push')?.rule, 'git push')
    // 不误伤：动词不在第一个非选项 token 上
    assert.equal(dangerousCommandMatch('git log --grep push'), null)
    assert.equal(dangerousCommandMatch('npm run publish'), null)
    // v1.12.6（终审阻断修复）：pnpm/yarn 的 publish 与 npm 同语义，纳入（用户裁定）
    assert.equal(dangerousCommandMatch('pnpm publish')?.rule, 'pnpm publish')
    assert.equal(dangerousCommandMatch('yarn publish')?.rule, 'yarn publish')
    assert.equal(dangerousCommandMatch('pnpm run publish'), null)
    assert.equal(dangerousCommandMatch('yarn run publish'), null)
  })

  it('终审阻断：包装写法 / 等价写法全部命中（用户裁定：等价写法同属一类）', () => {
    const probes = [
      ['sudo rm -rf /tmp/x', 'rm -rf'],
      ['sudo -u root /bin/rm -rf /tmp/x', 'rm -rf'],
      ['command rm -rf /tmp/x', 'rm -rf'],
      ['env rm -rf /tmp/x', 'rm -rf'],
      ['env -i FOO=1 rm -rf /tmp/x', 'rm -rf'],
      ['nohup rm -rf /tmp/x', 'rm -rf'],
      ['nice rm -rf /tmp/x', 'rm -rf'],
      ['nice -n 10 rm -rf /tmp/x', 'rm -rf'],
      ['time rm -rf /tmp/x', 'rm -rf'],
      ['timeout 5 rm -rf /tmp/x', 'rm -rf'],
      ['timeout -k 5 10 rm -rf /tmp/x', 'rm -rf'],
      ['stdbuf -o0 rm -rf /tmp/x', 'rm -rf'],
      ['/bin/rm -rf /tmp/x', 'rm -rf'],
      ['./rm -rf /tmp/x', 'rm -rf'],
      ['bash -c "rm -rf /tmp/x"', 'rm -rf'],
      ["sh -c 'rm -rf /tmp/x'", 'rm -rf'],
      ['zsh -lc "rm -fr /tmp/x"', 'rm -rf'],
      ['dash -c "rm --recursive --force /tmp/x"', 'rm -rf'],
      ['echo x | xargs rm -rf', 'rm -rf'],
      ['git -C /tmp push', 'git push'],
      ['git -c k=v push', 'git push'],
      ['git --git-dir=/tmp/g push', 'git push'],
      ['npm --prefix /tmp publish', 'npm publish'],
      ['npm --prefix=/tmp publish', 'npm publish'],
      ['FOO=1 nohup nice -n 10 timeout 5 stdbuf -o0 rm -rf /tmp/x', 'rm -rf'],
      ['xargs -I{} sh -c "rm -rf {}"', 'rm -rf'],
      ['bash -lc "npm --prefix /tmp publish"', 'npm publish'],
      ['sudo bash -c "git push"', 'git push'],
    ]
    // v1.12.6 第四轮（终审 B1）：取值选项表**大小写归一**。
    // 改前表里写的是大小写原样的 '-C' / '-S'，查表却用 toLowerCase() ⇒ 该选项的
    // **取值**（/tmp、3）被当成程序名 ⇒ 下面四条整段漏判、静默放行。
    probes.push(
      ['pnpm -C /tmp publish', 'pnpm publish'],
      ['npm -C /tmp publish', 'npm publish'],
      ['sudo -C 3 rm -rf /tmp/x', 'rm -rf'],
      ["env -S 'ls; rm -rf /x'", 'rm -rf'],
      // 对照（B1 之前就已收口，不靠选项表）：粘连形态
      ['pnpm -C/tmp publish', 'pnpm publish'],
      ['sudo -C3 rm -rf /tmp/x', 'rm -rf'],
      ['pnpm --dir /tmp publish', 'pnpm publish'],
    )
    // v1.12.6 第四轮（终审 M1）：7 种**未声明**的等价写法
    probes.push(
      ['busybox rm -rf /tmp/x', 'rm -rf'],
      ['toybox rm -rf /tmp/x', 'rm -rf'],
      ['coreutils rm -rf /tmp/x', 'rm -rf'],
      ["printf 'rm -rf /x' | bash", SHELL_STDIN_RULE],
      ["bash <<< 'rm -rf /x'", SHELL_STDIN_RULE],
      ['/bin/bash <<< "rm -rf /x"', SHELL_STDIN_RULE],
      ['yarn npm publish', 'yarn publish'],
      ['find /tmp -exec rm -rf {} +', 'rm -rf'],
      ["bash -c'rm -rf /x'", 'rm -rf'],
      ['sh -c"rm -rf /x"', 'rm -rf'],
      ['bash -c "bash -c \\"rm -rf /x\\""', 'rm -rf'],
    )
    for (const [cmd, rule] of probes) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${cmd} 未命中（等价写法被静默放行）`)
    }
  })

  it('终审 M1-②：段首是 shell 解释器却没有 -c ⇒ 按 shell-stdin 保守转交互（不是放行）', () => {
    // 裸解释器读 stdin（管道 / here-string）或执行脚本文件：正文静态不可判定。
    // 判据与 shell 深度上限同一原则——到顶/判不出的方向一律**可疑**转交互。
    for (const cmd of [
      "printf 'rm -rf /x' | bash",
      "cat x | sh",
      "bash <<< 'rm -rf /x'",
      '/bin/bash <<< "rm -rf /x"',
      'bash deploy.sh',
      'sh ./install.sh',
      'bash',
    ]) {
      const hit = dangerousCommandMatch(cmd)
      assert.equal(hit?.rule, SHELL_STDIN_RULE, `${cmd} 应判「可疑」转交互，而不是放行`)
      assert.ok(hit.segment, '留痕必须带那段命令')
    }
    // 有 -c 的照旧只判正文（不算 naked shell）
    assert.equal(dangerousCommandMatch('bash -c "echo hi"'), null)
    assert.equal(dangerousCommandMatch('bash -c "rm -rf /x"')?.rule, 'rm -rf')
  })

  it('终审 M1-③：`-c` 与正文**粘连**（`-c\'rm …\'`）要把首词拼回正文', () => {
    for (const [cmd, rule] of [
      ["bash -c'rm -rf /x'", 'rm -rf'],
      ['sh -c"rm -rf /x"', 'rm -rf'],
      ["zsh -lc'rm -rf /x'", 'rm -rf'],
      ["bash -c'echo hi'", null],
      ["sh -c'ls -la'", null],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule ?? null, rule, `${cmd} 判定不对`)
    }
  })

  it('终审 M1-④：反斜杠转义引号（`\\"rm`）先解转义再剥引号，两层嵌套不再漏', () => {
    // 改前：`\"bash` 首字符是 `\` ⇒ basenameOf 切出 `"bash` ≠ bash、stripOuterQuotes
    // 也剥不掉 ⇒ 第二层不再当 shell 包装 ⇒ 整段静默放行（不是深度上限问题）。
    assert.equal(dangerousCommandMatch('bash -c "bash -c \\"rm -rf /x\\""')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch("bash -c 'bash -c \\'rm -rf /x\\''")?.rule, 'rm -rf')
    // 深度仍由层数决定；但 v1.12.10 起「先内容、后形状」⇒ 第 3 层的归因是真命令名 `rm -rf`
    assert.equal(dangerousCommandMatch('bash -c "bash -c \\"bash -c rm -rf /\\""')?.rule, 'rm -rf')
    // 第 3 层里没有内容可归因时，才落回「嵌套太深」（形状规则）保守转交互
    assert.equal(dangerousCommandMatch('bash -c "bash -c \\"bash -c echo hi\\""')?.rule, SHELL_DEPTH_RULE)
  })

  it('终审 M1-⑥：`find … -exec <危险程序>` 走同一份规则（不新增名单条目）', () => {
    assert.equal(DANGEROUS_COMMAND_RULES.map((r) => r.id).length, 5,
      '名单仍是 5 条单点常量：-exec 只是**另一条调用路径**，命中报原规则名')
    assert.equal(dangerousCommandMatch('find /tmp -exec rm -rf {} +')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('find /tmp -execdir rm -rf {} +')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('find /tmp -ok rm -rf {} ;')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('find /tmp -exec git push {} +')?.rule, 'git push')
    // 误伤守卫：-exec 后面不是危险命令
    assert.equal(dangerousCommandMatch('find /tmp -exec ls {} +'), null)
    // v1.12.12：`echo rm -rf` 里的字样由全文子串层兜住 ⇒ 弹（代价，见「模式变更与代价」）
    assert.equal(dangerousCommandMatch('find /tmp -exec echo rm -rf')?.rule, 'text:rm -rf')
    assert.equal(dangerousCommandMatch('find /tmp -name x'), null)
  })

  // ── v1.12.6 第五轮（终审 M-A / M-C）────────────────────────────────

  it('第五轮 M-A：`-exec` 位于**段首**（splitSubCommands 切出的第二段）时同样命中', () => {
    // 改前 `execSubcommandIndex` 从下标 1 起扫 ⇒ 段首那个 `-exec` 永不参与识别。
    // `find … -exec echo {} \; -exec rm -rf {} +` 会被 `;` 切成两段，第二段
    // `" -exec rm -rf {} +"` 的**段首就是 `-exec`** ⇒ 判据层 MISS、监听器层静默放行。
    for (const [cmd, rule] of [
      ['find /tmp -exec echo {} \\; -exec rm -rf {} +', 'rm -rf'],
      ['-exec rm -rf {} +', 'rm -rf'],
      ['-execdir rm -rf {} +', 'rm -rf'],
      ['-ok rm -rf /tmp/x ;', 'rm -rf'],
      // 对照组：不靠下标 0 的那两条（改下标不该把它们弄坏）
      ['find /tmp -exec rm -rf {} +', 'rm -rf'],
      ['find /tmp -exec echo {} \\;', null],
      ['-exec ls {} +', null],
      ['find . -exec grep -l foo {} +', null],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule ?? null, rule, `${cmd} 判定不对`)
    }
  })

  it('第五轮 M-C①：`doas`/`setsid`/`chroot`/`ionice`/`taskset` 与 `sudo` 同类（含各自的取值/位置参数）', () => {
    for (const [cmd, rule] of [
      ['doas rm -rf /tmp/x', 'rm -rf'],
      ['doas -u root rm -rf /tmp/x', 'rm -rf'],
      ['setsid rm -rf /tmp/x', 'rm -rf'],
      ['setsid -f rm -rf /tmp/x', 'rm -rf'],
      // `chroot NEWROOT COMMAND…`：第一个**位置参数**是新根，跳过它才是真程序名
      ['chroot /mnt rm -rf /tmp/x', 'rm -rf'],
      ['chroot --userspec=u:g /mnt rm -rf /tmp/x', 'rm -rf'],
      ['chroot /mnt busybox rm -rf /tmp/x', 'rm -rf'],
      ['sudo chroot /mnt rm -rf /tmp/x', 'rm -rf'],
      // `ionice -c <class>` / `taskset -c <cpus>`：`-c` 会吃掉下一个 token
      ['ionice rm -rf /tmp/x', 'rm -rf'],
      ['ionice -c 3 rm -rf /tmp/x', 'rm -rf'],
      ['ionice -c3 rm -rf /tmp/x', 'rm -rf'],
      ['taskset -c 0 rm -rf /tmp/x', 'rm -rf'],
      ['taskset -c 0-3 rm -rf /tmp/x', 'rm -rf'],
      ['chroot /mnt ionice -c 3 rm -rf /tmp/x', 'rm -rf'],
      // 误伤守卫：这些包装器后面不是危险命令 ⇒ 一律不命中
      ['chroot /mnt ls', null], ['taskset -c 0 ls', null], ['ionice ls', null],
      ['setsid ls', null], ['doas ls', null], ['ionice -c 3 ls -la', null],
      ['taskset -c 0 grep x f', null], ['chroot /mnt /bin/echo hi', null],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule ?? null, rule, `${cmd} 判定不对`)
    }
  })

  it('第五轮 M-C②：`source` / `.` 与 `bash deploy.sh` 同原则（shell-source 保守转交互）', () => {
    // `source deploy.sh` / `. deploy.sh` 与 `bash deploy.sh` 同义（在当前 shell 里读脚本
    // 文件执行），正文静态不可判定 ⇒ 与 SHELL_STDIN_RULE 同一原则：判不出不是放行。
    for (const cmd of [
      'source script.sh', 'source deploy.sh', '. script.sh', '. deploy.sh',
      '. ./install.sh', "bash -c 'source x.sh'", 'sh -c ". x.sh"', 'command source deploy.sh',
    ]) {
      const hit = dangerousCommandMatch(cmd)
      assert.equal(hit?.rule, SHELL_SOURCE_RULE, `${cmd} 应按「可疑」保守转交互，而不是放行`)
      assert.ok(hit.segment, '留痕必须带那段命令')
    }
    // 误伤守卫：**不带参数**的 `source` / `.`（什么都不执行）、文本里"提到"、
    // 以及 `command -v source`（`-v` 是查询开关，剥掉 `command` 后只剩 `['source']`）
    for (const cmd of ['source', '.', 'command -v source', 'command -V source',
      'echo source x.sh', "grep '. script.sh' f", 'cat source.sh']) {
      assert.equal(dangerousCommandMatch(cmd), null, `${cmd} 被误判成 shell-source`)
    }
    // 对照（第四轮既有口径，不在本轮改动范围）：段首是**解释器**却无 `-c` 时走 shell-stdin
    assert.equal(dangerousCommandMatch('bash source.sh')?.rule, SHELL_STDIN_RULE)
  })

  it('第六轮 M-D：同族另外 9 个包装器（unshare/nsenter/strace/firejail/systemd-run/su/runuser/setarch/prlimit）', () => {
    // 现象（终审判据层）：这 9 条改前全部 MISS —— 既不在 TRANSPARENT_WRAPPERS，
    // 也不在 DANGEROUS_COMMAND_RULES。它们与 `setsid` 同类（换身份/环境/跟踪器跑
    // **同一条**命令），词法可判定 ⇒ 与 `doas`/`setsid`/`chroot` 同族补齐。
    for (const [cmd, rule] of [
      // 验收 9 条（逐字对应用户给的清单）
      ['unshare -m rm -rf /tmp/x', 'rm -rf'],
      ['nsenter -t 1 -m rm -rf /tmp/x', 'rm -rf'],
      ['strace -f rm -rf /tmp/x', 'rm -rf'],
      ['firejail rm -rf /tmp/x', 'rm -rf'],
      ['systemd-run --user rm -rf /tmp/x', 'rm -rf'],
      ['su root -c "rm -rf /tmp/x"', 'rm -rf'],
      ['runuser -u root -- rm -rf /tmp/x', 'rm -rf'],
      ['setarch x86_64 rm -rf /tmp/x', 'rm -rf'],
      ['prlimit rm -rf /tmp/x', 'rm -rf'],
      // 各自的取值/位置参数（真实 CLI 语义）：只列「吃掉下一个 token」的那些
      ['nsenter -t 1 -m -u -i -n -p rm -rf /tmp/x', 'rm -rf'],
      ['nsenter --target 1 --mount rm -rf /tmp/x', 'rm -rf'],
      ['nsenter -S 0 -G 0 rm -rf /tmp/x', 'rm -rf'],
      ['unshare -m -p -n -f rm -rf /tmp/x', 'rm -rf'],
      ['unshare -R /newroot rm -rf /tmp/x', 'rm -rf'],
      ['unshare --map-user 1000 --mount rm -rf /tmp/x', 'rm -rf'],
      ['strace -o /tmp/log -f rm -rf /tmp/x', 'rm -rf'],
      ['strace -e trace=open,close rm -rf /tmp/x', 'rm -rf'],
      ['strace --output /tmp/log -f rm -rf /tmp/x', 'rm -rf'],
      // firejail 的取值选项全是 `--opt=value` 形态（不吃下一个 token）
      ['firejail --profile=/x.profile --net=none rm -rf /tmp/x', 'rm -rf'],
      ['firejail --quiet --private rm -rf /tmp/x', 'rm -rf'],
      // systemd-run：`--user` 是开关；`-p/-E/-u/--setenv…` 吃掉取值
      ['systemd-run --user --wait -p MemoryMax=1G rm -rf /tmp/x', 'rm -rf'],
      ['systemd-run -u myunit --unit=u2 rm -rf /tmp/x', 'rm -rf'],
      ['systemd-run -E FOO=1 --setenv=BAR=2 rm -rf /tmp/x', 'rm -rf'],
      // su / runuser：`-c` 正文按 shell -c 同原则解析；没有 `-c` 时剥掉自身选项再判
      ['su -c "rm -rf /tmp/x"', 'rm -rf'],
      ["su - root -c 'rm -rf /tmp/x'", 'rm -rf'],
      ["su -c'rm -rf /tmp/x'", 'rm -rf'],
      ['su -s /bin/zsh root --command "rm -rf /tmp/x"', 'rm -rf'],
      ['su root rm -rf /tmp/x', 'rm -rf'],
      ['runuser -u root -c "rm -rf /tmp/x"', 'rm -rf'],
      ['runuser root -- rm -rf /tmp/x', 'rm -rf'],
      ['runuser -g staff --session-command="rm -rf /tmp/x"', 'rm -rf'],
      // setarch：`arch` 自 util-linux 2.33 起可选 ⇒ 两种解读都判（并集）
      ['setarch -R rm -rf /tmp/x', 'rm -rf'],
      ['setarch --addr-no-randomize rm -rf /tmp/x', 'rm -rf'],
      ['setarch x86_64 --32bit rm -rf /tmp/x', 'rm -rf'],
      // prlimit：`-p/--pid`、`-o/--output` 吃取值；资源选项是 `[=limits]` 可选附着
      ['prlimit --pid 1 rm -rf /tmp/x', 'rm -rf'],
      ['prlimit -o /tmp/o rm -rf /tmp/x', 'rm -rf'],
      ['prlimit --nofile=1024 -n2048 rm -rf /tmp/x', 'rm -rf'],
      // 叠加 / 嵌套：仍走同一份规则、报内层的规则名
      ['sudo su root -c "rm -rf /tmp/x"', 'rm -rf'],
      ["bash -c \"su root -c 'rm -rf /tmp/x'\"", 'rm -rf'],
      ['sudo unshare -m rm -rf /tmp/x', 'rm -rf'],
      ['env FOO=1 systemd-run --user rm -rf /tmp/x', 'rm -rf'],
      ['setsid strace -f rm -rf /tmp/x', 'rm -rf'],
      ['find /tmp -exec su root -c "rm -rf {}" +', 'rm -rf'],
      // 与另外两条规则同门：包装器不是只管 rm -rf
      ['unshare -m npm publish', 'npm publish'],
      ['strace -f git push', 'git push'],
      ['prlimit --pid 1 npm publish', 'npm publish'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule ?? null, rule, `${cmd} 判定不对`)
    }
    // 误伤守卫：这些包装器后面不是危险命令 ⇒ 一律不命中
    for (const cmd of [
      'unshare -m ls -la', 'unshare --help', 'nsenter -t 1 -m ls', 'strace -f ls',
      'strace -o /tmp/o ls', 'strace --version', 'firejail ls', 'firejail --net=none ls',
      'systemd-run --user ls', 'systemd-run --user npm run build',
      'setarch x86_64 ls', 'setarch --list', 'setarch --show --pid 9284',
      'prlimit ls', 'prlimit --pid 1', 'prlimit -o /tmp/o',
      'su root -c "ls"', 'runuser -u root -- ls', 'runuser -u root -c "ls"',
      'su -s /bin/zsh root -c "ls"',
      // `command -v/-V` 是**查询**开关（打印路径，不执行）⇒ 不能把 `command -v su` 误伤成
      // 「启动交互登录 shell」（su/runuser 的『只剩它自己』判定与剥壳后的 `['su']` 同形）
      'command -v su', 'command -V su', 'command -p -v su', 'command -v source',
      // 文本里"提到"、文件名相像
      'echo su root', 'cat su.sh', 'grep setarch f',
    ]) {
      assert.equal(dangerousCommandMatch(cmd), null, `${cmd} 被新包装器判据误伤`)
    }
  })

  it('第六轮 M-D：`su` / `runuser` 没有 `-c` ⇒ 按 su-shell 保守转交互（不是放行）', () => {
    // `su - root` / `su root` 启动的是**交互登录 shell**，`-c` 解不出正文 ⇒
    // 与 `bash deploy.sh`（shell-stdin）、`source deploy.sh`（shell-source）同一原则：
    // 判不出不是放行，只到「可疑」这一档。
    for (const cmd of ['su', 'su - root', 'su root', 'runuser -l root', 'su --version', 'sudo su -']) {
      const hit = dangerousCommandMatch(cmd)
      assert.equal(hit?.rule, SU_SHELL_RULE, `${cmd} 应按「可疑」保守转交互，而不是放行`)
      assert.ok(hit.segment, '留痕必须带那段命令')
    }
    assert.equal(SU_SHELL_RULE, 'su-shell', '门名是 UI 文案的一部分（不可随意改）')
  })

  it('第六轮 Minor 2：截断边界是**字符下标上的硬切**（上限-8 仍命中 / 上限-3 被切残 ⇒ MISS）', () => {
    // 声明从「第 256KB 之后不判」改成「第 256KB **附近及之后**」的依据就是这条用例：
    // 切点落在字符下标上，被切残的尾部不参与判定 ⇒ 危险命令**起点**距上限 8 个字符
    // 时仍完整命中，距上限 3 个字符时 `rm -rf` 被切残 ⇒ MISS（不是「干净地按命令边界切」）。
    const textAt = (start) => `${'a'.repeat(start - 2)}; rm -rf /x`
    const near = textAt(MAX_DANGER_TEXT_CHARS - 8)
    const cut = textAt(MAX_DANGER_TEXT_CHARS - 3)
    assert.equal(boundDangerText(near).omitted > 0, true, '前提：这段文本必须真的超出上限')
    assert.equal(boundDangerText(near).text.length, MAX_DANGER_TEXT_CHARS)
    assert.equal(dangerousCommandMatch(boundDangerText(near).text)?.rule, 'rm -rf',
      '起点在「上限 - 8」的危险命令必须仍命中（声明里不许说成「256KB 之后一律不判」）')
    assert.equal(dangerousCommandMatch(boundDangerText(cut).text), null,
      '起点在「上限 - 3」的会被切残 ⇒ MISS（这正是「附近及之后」要表达的东西）')
    // 不超限时一个字都不截
    const short = textAt(64)
    assert.deepEqual(boundDangerText(short), { text: short, omitted: 0 })
    assert.equal(MAX_DANGER_TEXT_CHARS, 256 * 1024)
  })

  it('终审 M1-⑤：`yarn npm publish` 与 `yarn publish` 同语义；run 形态仍不误伤', () => {
    assert.equal(dangerousCommandMatch('yarn npm publish')?.rule, 'yarn publish')
    assert.equal(dangerousCommandMatch('yarn npm --cwd /tmp publish')?.rule, 'yarn publish')
    assert.equal(dangerousCommandMatch('yarn npm run publish'), null)
    assert.equal(dangerousCommandMatch('yarn npm install'), null)
    // v1.12.12：`npm publish` 字样由全文子串层兜住 ⇒ 弹（代价）；词法层仍只认第一个非选项 token
    assert.equal(dangerousCommandMatch('yarn info npm publish')?.rule, 'text:npm publish')
  })

  it('Minor：透明包装**跳数用尽**且段首仍是包装器 ⇒ 按 wrapper-nesting 保守转交互', () => {
    assert.equal(MAX_WRAPPER_UNWRAP_HOPS, 8)
    // 8 跳内照旧剥到真命令
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(8)}rm -rf /tmp/x`)?.rule, 'rm -rf')
    // 9 跳起：剥不动 ⇒ **可疑**转交互（改前是静默放行）。
    // v1.12.10：返回形状规则**之前先求值内容规则** ⇒ 归因是真命令名（`rm -rf`），
    // 而不是「包装太深」。形状门名只在**没有内容可归因**时出现（见下一条）。
    for (const cmd of [
      `${'sudo '.repeat(9)}rm -rf /tmp/x`,
      `${'env '.repeat(9)}rm -rf /tmp/x`,
      `${'nice '.repeat(12)}rm -rf /tmp/x`,
    ]) {
      const hit = dangerousCommandMatch(cmd)
      assert.equal(hit?.rule, 'rm -rf', `${cmd} 的归因应是真命令名（先内容、后形状）`)
      assert.ok(hit.segment, '留痕必须带那段命令')
    }
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}ls -la`)?.rule, WRAPPER_DEPTH_RULE,
      '没有内容可归因时才落回 wrapper-nesting（可疑，仍保守转交互）')
    // 纯包装、后面什么都没有：没有可执行的命令 ⇒ 不命中（不发假警报）
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}`), null)
  })

  it('shell 包装递归上限 2 层：第 3 层按「可疑」保守转交互（不做无限展开）', () => {
    assert.equal(MAX_SHELL_UNWRAP_DEPTH, 2)
    // 2 层包装仍逐层解开、按内层规则命名
    assert.equal(dangerousCommandMatch(`bash -c 'bash -c "rm -rf /"'`)?.rule, 'rm -rf')
    // 第 3 层不再展开：可疑 ⇒ 保守转交互；v1.12.10 起同样**先求值内容规则**再归因
    const deep = dangerousCommandMatch(`bash -c 'bash -c "bash -c rm -rf /"'`)
    assert.equal(deep?.rule, 'rm -rf', '超过展开深度时归因应是真命令名（先内容、后形状）')
    assert.equal(dangerousCommandMatch(`bash -c 'bash -c "bash -c echo hi"'`)?.rule, SHELL_DEPTH_RULE,
      '没有内容可归因时才落回 shell-nesting')
    assert.ok(deep.segment.includes('bash -c'), '留痕要带外层那段命令（排障要看得到包装）')
    // 深度只由嵌套层数决定：不嵌套的 `bash -c` 不受影响
    assert.equal(dangerousCommandMatch('bash -c "echo hi"'), null)
  })

  it('词法误伤守卫：**碰巧像/组成不同**危险命令的写法仍然 MISS（v1.12.12 起「提及」另算，见下条）', () => {
    for (const cmd of [
      'git log --grep push', 'npm run publish', 'pnpm run publish',
      'rm -r /tmp/x', 'rm -f /tmp/x', 'rm /tmp/x', 'ls -la', 'echo hi',
      'sudo ls -la', 'xargs echo hi', 'bash -c "echo hi"', 'timeout 5 npm run build',
      'command -v rm', 'nice -n 10 ls', 'echorm -rf', 'rmdir -rf /tmp/x',
    ]) {
      assert.equal(dangerousCommandMatch(cmd), null, `${cmd} 被误判成危险命令`)
    }
  })

  it('v1.12.12 代价（用户裁定）：文本里**提到**预设危险字样 ⇒ 也弹（不是缺陷，是有意取舍）', () => {
    // 用户原话：「改成全文子串判定：文本里出现危险字样就弹」，并接受代价。
    // 预设三个字符串：`rm -rf` / `git push` / `npm publish`（可用
    // `$DSH_HOME/data/dsh-danger-patterns.json` 增删，见 test/invariants-1-12-12.test.js）。
    for (const [cmd, rule] of [
      ['echo "git push"', 'text:git push'],
      ['grep "git push" f', 'text:git push'],
      ['# rm -rf /tmp', 'text:rm -rf'],
      ["curl 'a=1&rm -rf'", 'text:rm -rf'],
      ['git commit -m "git push"', 'text:git push'],
      ['env grep "git push" f', 'text:git push'],
      ['echo "see rm -rf docs"', 'text:rm -rf'],
      ['git commit -m "docs: mention npm publish"', 'text:npm publish'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule,
        `${cmd}：按 1.12.12 裁定这里**应当**弹（代价），若变 MISS 说明全文层丢了`)
    }
  })

  it('v1.12.10：heredoc 正文与终止行都是**普通文本行**，一律判定（无载荷概念）', () => {
    // 用户裁定：「载荷豁免 尽量保守，避免可能错过的高危命令，宁愿多弹窗一次高危的处理」
    // ⇒ v1.12.8「剥载荷」与 v1.12.9「行掩码 + 载荷豁免 + 终止行跳过」两套机器**整层删除**。
    assert.equal(dangerousCommandMatch("cat <<'EOF'\nrm -rf /tmp/x\nEOF")?.rule, 'rm -rf',
      '载荷里的真命令必须命中（否则就是静默放行）')
    // tag 恰好是 shell 名时，终止行也照普通行判（v1.12.9 的终止行跳过已删）
    assert.equal(dangerousCommandMatch("cat <<'sh'\nbody\nsh")?.rule, SHELL_STDIN_RULE)
    // 对照：正文既不以 `-` 开头、也不含危险命令 ⇒ 照旧不命中
    assert.equal(dangerousCommandMatch("python3 - <<'PY'\nprint('hello')\nPY"), null)
  })

  it('v1.12.10 代价（用户裁定）：正文里出现危险命令、或正文行以 `- ` 开头 ⇒ 多弹一次', () => {
    const hit = dangerousCommandMatch("cat <<'EOF'\nrm -rf /tmp/x\nEOF")
    assert.equal(hit?.rule, 'rm -rf', '正文里的 rm -rf 必须命中（刻意的代价，不是漏修）')
    // 「正文行以 `- ` 开头」= 当年那条卡 38 秒的误报：**用户明确接受它回来** —— 任何载荷豁免
    // 都在 v1.12.8/v1.12.9 两轮里变成了静默放行的口子（见 CHANGELOG 1.12.10）。
    assert.equal(dangerousCommandMatch("git commit -q -F - <<'EOF'\n- planGrantWrites 新增 none 出口 ⇒\nEOF")?.rule,
      WRAPPER_OPTION_AMBIGUITY_RULE, '代价口径被偷偷放宽了')
    assert.equal(dangerousCommandMatch("python3 - <<'PY'\nprint('hello')\nPY"), null)
  })

  it('自定义执行工具：args 里所有字符串值都要判（{shell: …} 这类非 command 形状）', () => {
    // 一律**按值分别判**（换行分隔 ⇒ 每个值自己是一段），不对参数键做任何猜测：
    // 猜错的方向是放行，属安全侧。残留边界：把命令拆成多个词的 argv 数组
    // （`{argv: ['rm','-rf','/']}`）不会被拼回一条命令 —— 静态不可判定，登记在 CHANGELOG。
    assert.equal(argsTextOf({ shell: 'rm -rf /tmp/x' }), 'rm -rf /tmp/x')
    assert.equal(argsTextOf(JSON.stringify({ shell: 'git push' })), 'git push')
    assert.equal(argsTextOf({ argv: ['rm -rf /'] }), 'rm -rf /')
    assert.equal(argsTextOf({ shell: 'ls -la' }), 'ls -la')
    assert.equal(argsTextOf(null), '')
    assert.equal(argsTextOf({ n: 1, b: true }), '', '非字符串值不进文本')
    assert.equal(dangerousCommandMatch(argsTextOf({ shell: 'rm -rf /tmp/x' }))?.rule, 'rm -rf')
    // v1.12.12：argv 拆词文本（`rm\n-rf\n/`）被全文子串层（容忍空白）覆盖 ⇒ 现在会弹
    assert.equal(dangerousCommandMatch(argsTextOf({ argv: ['rm', '-rf', '/'] }))?.rule, 'text:rm -rf')
  })

  it('分段：切分规则不变（v1.12.12 起另有一层全文子串兜底，故「引号内」也会弹）', () => {
    assert.equal(splitSubCommands('a;b&&c||d|e&f\ng').filter((s) => s !== '').length, 7)
    // 命中「第二段」也必须拦（`cd /tmp && rm -rf x`）
    assert.equal(dangerousCommandMatch('cd /tmp && rm -rf x')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('true;git push')?.rule, 'git push')
    // v1.12.12（用户裁定）：这几条现在由**全文子串层**兜住 ⇒ 弹（代价）
    assert.equal(dangerousCommandMatch('echo "git push"')?.rule, 'text:git push')
    assert.equal(dangerousCommandMatch('grep "git push" f')?.rule, 'text:git push')
    assert.equal(dangerousCommandMatch('# rm -rf /tmp')?.rule, 'text:rm -rf')
    assert.equal(dangerousCommandMatch("curl 'a=1&rm -rf'")?.rule, 'text:rm -rf')
    // 分段语义本身没变：`;` 切出的第二段照旧按段首判
    assert.deepEqual(splitSubCommands('true;git push'), ['true', 'git push'])
  })

  it('前导环境变量赋值被跳过；大小写按小写比对', () => {
    assert.equal(dangerousCommandMatch('FOO=1 rm -rf x')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('rm -RF x')?.rule, 'rm -rf')
  })

  // ── v1.12.6 第七轮（终审阻断 A/B + Minor m3 + 设计裁定第 10 条）──────────────

  it('第七轮阻断 A：小写同形**开关**不得再被当成取值选项（吃掉真程序名 ⇒ 静默放行）', () => {
    // 现象（改前，判据层 + 监听器层双证）：`unshare -r rm -rf /x` 里 `-r`（`--map-root-user`，
    // **开关**）被 `toLowerCase()` 折叠成表里的 `-R`（`--root`，取值）⇒ `rm` 被当成它的取值
    // 吃掉 ⇒ 整段 MISS、监听器层 `allowed-once`。四组碰撞：`-R`↔`-r`、`-N`↔`-n`、
    // `-a`↔`-A`、`-p`↔`-P`，外加 `xargs` 的 `-L`↔`-l`、`-P`↔`-p`。
    for (const [cmd, why] of [
      ['unshare -r rm -rf /x', '`-r`=--map-root-user 是开关，`-R`=--root 才是取值'],
      ['unshare -m -r rm -rf /x', '同上（前面还叠了一个开关）'],
      ['nsenter -n rm -rf /x', '`-n`=--net 是开关，`-N`=--net-socket 才是取值'],
      ['nsenter -t 1 -n rm -rf /x', '同上（`-t 1` 先吃掉自己的取值）'],
      ['strace -A rm -rf /x', '`-A`=--output-append-mode 是开关，`-a`=--columns 才是取值'],
      ['systemd-run -P rm -rf /x', '`-P`=--pipe 是开关，`-p`=--property 才是取值'],
      ['systemd-run --user -P rm -rf /x', '同上（`--user` 也是开关）'],
      ['xargs -l rm -rf /x', '`-l[max-lines]` 是**可选附着**参数（不吃下一个 token），`-L` 才是取值'],
      ['xargs -p rm -rf /x', '`-p`=--interactive 是开关，`-P`=--max-procs 才是取值'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, 'rm -rf', `${why}：${cmd} 仍未命中（静默放行）`)
    }
    // 对照（改前就命中，改后不许丢）：碰撞开关**后面还有别的选项** ⇒ 吃到的是选项 ⇒ 仍命中
    for (const cmd of ['unshare -r -m rm -rf /x', 'strace -A -f rm -rf /x', 'nsenter -n -m rm -rf /x']) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, 'rm -rf', `${cmd} 这条对照命中被弄丢了`)
    }
  })

  it('第七轮：取值选项表**短选项大小写精确**（表驱动：每个含大写字母的短选项两向都要成立）', () => {
    // 这张表是唯一事实来源 ⇒ 直接从源码读出来（读到空表就报错，不许静默空转）。
    const readTable = (constName) => {
      const block = hostSrc.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\n\\}`))
      assert.ok(block, `源码里找不到 ${constName}（改名/改形状 ⇒ 这条守卫要跟着更新，别静默空转）`)
      const out = new Map()
      const entryRe = /(?:'([^']+)'|([A-Za-z][\w-]*))\s*:\s*optionSet\(\[([\s\S]*?)\]\)/g
      let m
      while ((m = entryRe.exec(block[1]))) {
        out.set(m[1] || m[2], (m[3].match(/'[^']*'/g) || []).map((s) => s.slice(1, -1)))
      }
      return out
    }
    const wrapperTable = readTable('WRAPPER_VALUE_OPTIONS')
    const programTable = readTable('PROGRAM_VALUE_OPTIONS')
    assert.ok(wrapperTable.size >= 15, `WRAPPER_VALUE_OPTIONS 只解析出 ${wrapperTable.size} 条 —— 解析器失效了？`)
    assert.ok(programTable.size >= 3, `PROGRAM_VALUE_OPTIONS 只解析出 ${programTable.size} 条 —— 解析器失效了？`)

    // 唯一豁免：**两条拼写都真吃取值**的同形对（逐条在 man 页上核对过）。豁免是**显式清单 + 理由**，
    // 不是"跳过断言"：清单里多出/少掉任何一条都会让用例红（下面两个方向都断言）。
    const DUAL_VALUE_PAIRS = new Map([
      ['sudo:-r', '`-r role`=--role 与 `-R dir`=--chroot 都吃取值（man sudo）'],
      ['sudo:-t', '`-t type`=--type 与 `-T timeout`=--command-timeout 都吃取值（man sudo）'],
      ['sudo:-u', '`-u user`=--user 与 `-U user`=--other-user 都吃取值（man sudo）'],
      ['ionice:-p', '`-p PID`=--pid 与 `-P PGID`=--pgid 都吃取值（man ionice）'],
      ['strace:-e', '`-e expr`=--trace 与 `-E var[=val]`=--env 都吃取值（man strace）'],
      ['strace:-p', '`-p pid`=--attach 与 `-P path`=--trace-path 都吃取值（man strace）'],
      ['strace:-u', '`-u user`=--user 与 `-U columns`=--summary-columns 都吃取值（man strace）'],
      ['strace:-o', '`-o file`=--output 与 `-O overhead`=--summary-syscall-overhead 都吃取值（man strace）'],
      ['strace:-s', '`-s strsize`=--string-limit 与 `-S sortby`=--summary-sort-by 都吃取值（man strace）'],
      ['su:-g', '`-g group`=--group 与 `-G group`=--supp-group 都吃取值（man su）'],
      ['runuser:-g', '同 su（runuser 的取值表 = su + `-u user`）'],
      ['git:-c', 'PROGRAM_VALUE_OPTIONS：`-c k=v` 与 `-C <path>` 都吃取值（man git）'],
      // v1.12.6 第八轮：新增/触及的三对「两条都真吃取值」的同形对（都在本机真二进制上核过）
      ['xargs:-s', 'BSD/macOS：`-s size`(=`--max-chars`) 与 `-S replsize`(=`-I` 的替换缓冲) 都吃取值 —— '
        + 'man 有 `-s size`/`-S replsize` 两节，本机 `xargs -s`/`-S` 各自报 option requires an argument'],
      ['chroot:-g', 'macOS chroot：`-g group` 与 `-G group,group,…` 都吃取值 —— '
        + '本机 usage `chroot [-g group] [-G group,group,...] [-u user] newroot [command]`，两条各自报 option requires an argument'],
      ['script:-t', 'macOS script：`-t time`（非播放模式）与 `-T fmt`（`-p` 播放模式）都吃取值 —— '
        + '本机 man SYNOPSIS 两行各有一个，两条各自报 option requires an argument'],
    ])
    const VERB_OF = { git: 'push', npm: 'publish', pnpm: 'publish', yarn: 'publish' }
    const tables = [
      {
        name: 'WRAPPER_VALUE_OPTIONS',
        table: wrapperTable,
        withValue: (key, opt) => `${key} ${opt} xv rm -rf /x`,
        bare: (key, opt) => `${key} ${opt} rm -rf /x`,
        want: () => 'rm -rf',
      },
      {
        name: 'PROGRAM_VALUE_OPTIONS',
        table: programTable,
        withValue: (key, opt) => `${key} ${opt} xv ${VERB_OF[key]}`,
        bare: (key, opt) => `${key} ${opt} ${VERB_OF[key]}`,
        want: (key) => `${key} ${VERB_OF[key]}`,
      },
    ]

    const seen = new Set()
    let checked = 0
    for (const { name, table, withValue, bare, want } of tables) {
      for (const [key, options] of table) {
        for (const opt of options) {
          // 只看**短选项**（单个 `-`）且含大写字母的拼写：长选项仍小写归一，不在本用例的射程里
          if (opt.startsWith('--') || !opt.startsWith('-') || !/[A-Z]/.test(opt)) continue
          checked += 1
          const lower = opt.toLowerCase()
          // ① 该**大写形态必须吃掉取值**（否则取值被当成程序名/动词 ⇒ 整段漏判）。
          //    接受两种"取值确实被吃掉"的读数：命中规则本身，或落到结构性可疑门
          //    （`su -G xv rm -rf /x`：后面的 `rm` 被当成 su 的**位置参数用户名**吃掉 ⇒
          //     兜底按 wrapper-option-ambiguity 保守转交互；两者都证明命令被判到了）。
          const up = dangerousCommandMatch(withValue(key, opt))?.rule ?? null
          assert.ok(up === want(key) || up === WRAPPER_OPTION_AMBIGUITY_RULE,
            `${name}：${key} ${opt} 没吃掉取值（取值被当成了程序名 ⇒ 漏判；实测 ${up}）`)
          if (options.includes(lower)) {
            // 表里同时有大小写两条 ⇒ 只允许「两条都真吃取值」的同形对，且必须有理由
            assert.ok(DUAL_VALUE_PAIRS.has(`${key}:${lower}`),
              `${name}：${key} 同时登记了 ${opt} 与 ${lower} —— 若确认两条都真吃取值请加进 DUAL_VALUE_PAIRS 并写明理由，`
              + '否则说明小写同形（开关）又被大小写折叠放进来了')
            seen.add(`${key}:${lower}`)
            continue
          }
          // ② 其**小写同形（开关）**后紧跟程序名/动词时必须命中（本轮阻断的复发哨兵）
          assert.equal(dangerousCommandMatch(bare(key, lower))?.rule, want(key),
            `${name}：${key} ${lower} 是小写同形（开关），却仍吃掉了后面的程序名（静默放行）`)
        }
      }
    }
    assert.ok(checked >= 15, `含大写字母的短选项只检查了 ${checked} 条 —— 表被清空/解析失效？`)
    for (const id of DUAL_VALUE_PAIRS.keys()) {
      assert.ok(seen.has(id),
        `DUAL_VALUE_PAIRS 里的 ${id} 已经不在表里（陈旧豁免 ⇒ 删掉它，别让豁免面悄悄变大）`)
    }
  })

  it('第七轮：既有命中一条都不许丢（改前靠小写折叠侥幸命中的，改后必须仍然命中）', () => {
    const probes = [
      ['pnpm -C /tmp publish', 'pnpm publish'],
      ['npm -C /tmp publish', 'npm publish'],
      ['npm --prefix /tmp publish', 'npm publish'],
      ['git -C /tmp push', 'git push'],
      ['sudo -u root rm -rf /x', 'rm -rf'],
      ['ionice -c2 rm -rf /x', 'rm -rf'],
      ['taskset -c 0 rm -rf /x', 'rm -rf'],
      ['sudo -C 3 rm -rf /x', 'rm -rf'],
      ["env -S 'ls; rm -rf /x'", 'rm -rf'],
      // 短选项改大小写精确后**补回**的 sudo 真实大小写取值选项（man sudo 逐条核对）：
      // `-R`/`-T`/`-U` 改前靠撞 `-r`/`-t`/`-u` 侥幸命中，不补回来就会**反向丢命中**
      ['sudo -R /mnt rm -rf /x', 'rm -rf'],
      ['sudo -T 5 rm -rf /x', 'rm -rf'],
      ['sudo -U root rm -rf /x', 'rm -rf'],
      ['sudo -D /tmp rm -rf /x', 'rm -rf'],
      // 同理补回 strace 的 `-U`/`-O`/`-S`（`-X` 本来就漏，一并补齐）
      ['strace -U columns rm -rf /x', 'rm -rf'],
      ['strace -O 5 rm -rf /x', 'rm -rf'],
      ['strace -S time rm -rf /x', 'rm -rf'],
      ['strace -X raw rm -rf /x', 'rm -rf'],
      // 第六轮的验收面（回归对照，改查表侧不许把它们弄坏）
      ['unshare -R /newroot rm -rf /x', 'rm -rf'],
      ['nsenter -t 1 -m -u -i -n -p rm -rf /x', 'rm -rf'],
      ['strace -o /tmp/log -f rm -rf /x', 'rm -rf'],
      ['systemd-run -E FOO=1 --setenv=BAR=2 rm -rf /x', 'rm -rf'],
      ['runuser -g staff --session-command="rm -rf /x"', 'rm -rf'],
      ['setarch -R rm -rf /x', 'rm -rf'],
      ['prlimit --nofile=1024 -n2048 rm -rf /x', 'rm -rf'],
      ['find /tmp -exec su root -c "rm -rf {}" +', 'rm -rf'],
      ['unshare -m npm publish', 'npm publish'],
      ['strace -f git push', 'git push'],
    ]
    for (const [cmd, rule] of probes) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${cmd} 的命中丢了（回归）`)
    }
  })

  it('第七轮兜底：结构性可疑门 wrapper-option-ambiguity（不吃任何 man 语义的第二道防线）', () => {
    assert.equal(WRAPPER_OPTION_AMBIGUITY_RULE, 'wrapper-option-ambiguity',
      '门名是 UI 文案的一部分（不可随意改）')
    // ① **程序名的位置站着一个选项**（段首是 `-…` 且后面还有东西）⇒ 真程序名必然被吃掉过
    assert.equal(dangerousCommandMatch('-rf /x')?.rule, WRAPPER_OPTION_AMBIGUITY_RULE)
    assert.equal(dangerousCommandMatch('runuser -u rm -rf /x')?.rule, WRAPPER_OPTION_AMBIGUITY_RULE,
      '`-u` 的取值位置站着的其实是程序名（同族形态，兜底应转交互）')
    // ② **被当成「取值」跳过的 token 自己能起一条危险命令** ⇒ 那个「取值」就是程序名。
    //    `env -S '<正文>'` 是真实一例：`-S` 的取值就是整条要被拆词执行的命令（改前 MISS）。
    assert.equal(dangerousCommandMatch("env -S 'rm -rf /x'")?.rule, WRAPPER_OPTION_AMBIGUITY_RULE,
      '`env -S` 的取值就是命令正文，被当取值吃掉 ⇒ 改前静默放行')
    assert.equal(dangerousCommandMatch('su -G grp rm -rf /x')?.rule, WRAPPER_OPTION_AMBIGUITY_RULE,
      '真程序名被当成 su 的（位置参数）用户名吃掉')
    // 守卫 ①：`-exec` 系段由 exec 通道负责（它的"真程序名"在上一段）⇒ 既不翻红也不翻黑
    for (const cmd of ['-exec ls {} +', 'find /tmp -exec echo {} \\;', 'find . -exec grep -l foo {} +',
      'find /tmp -exec ls {} +']) {
      assert.equal(dangerousCommandMatch(cmd), null, `${cmd} 被结构性兜底误伤`)
    }
    // 守卫 ②：光秃秃一个选项 token（`argsText` 把 argv 拆词后的 `-rf`）仍是**登记在案的残留边界**
    // v1.12.12：argv 文本按换行分隔（`rm\n-rf\n/`），全文子串层容忍空白 ⇒ 现在**会弹**
    // （预设 `rm -rf` 命中）；这是**收紧**（原先登记的残留边界被这层覆盖）
    assert.equal(dangerousCommandMatch(argsTextOf({ argv: ['rm', '-rf', '/'] }))?.rule, 'text:rm -rf')
    assert.equal(dangerousCommandMatch('-rf'), null, '单个选项 token 不该判可疑')
    // 守卫 ③：既有误伤守卫里「选项取值吃掉后什么都不剩」的形态不许被翻成命中
    for (const cmd of [
      'prlimit --pid 1', 'prlimit -o /tmp/o', 'setarch --show --pid 9284',
      'strace --version', 'unshare --help', 'setarch --list', 'systemd-run --user ls',
      'nsenter -t 1 -m ls', 'strace -o /tmp/o ls', 'unshare -m ls -la', 'su root -c "ls"',
      'runuser -u root -- ls',
    ]) {
      assert.equal(dangerousCommandMatch(cmd), null, `${cmd} 被结构性兜底误伤`)
    }
  })

  it('第七轮 Minor m3：`su`/`runuser` 的 no-`-c` 分支留痕用**外层**段（与同族一致）', () => {
    // 改前这条分支 `return matchSegment(rest.join(' '), depth)`，内层自己 `trace()` 重算 ⇒
    // `runuser -u root -- rm -rf /x` 的日志只留 `rm -rf /x`，排障时看不到「被 runuser 包着跑」。
    const hit = dangerousCommandMatch('runuser -u root -- rm -rf /x')
    assert.equal(hit?.rule, 'rm -rf', '规则名仍用内层命中的那条')
    assert.match(hit.segment, /^runuser -u root -- rm -rf \/x/,
      '留痕丢了外层包装（应与 `-c` 分支 / shell `-c` / `-exec` / 透明包装一样留外层段）')
    // 对照：同族本来就留外层
    assert.match(dangerousCommandMatch('su root -c "rm -rf /x"').segment, /^su root -c/)
    assert.match(dangerousCommandMatch('bash -c "rm -rf /x"').segment, /^bash -c/)
    assert.match(dangerousCommandMatch('sudo rm -rf /x').segment, /^sudo rm -rf/)
    assert.match(dangerousCommandMatch('find /tmp -exec rm -rf {} +').segment, /^find \/tmp -exec/)
  })

  it('设计裁定第 10 条：`su`/`runuser` 已移出 TRANSPARENT_WRAPPERS，随之变死的早返回已删', () => {
    // 两件事必须**一起**做：只删早返回而保留表成员 ⇒ `su` 会落入通用剥壳、`-c` 正文被切碎 ⇒ 真漏判。
    const table = hostSrc.match(/const TRANSPARENT_WRAPPERS = new Set\(\[([\s\S]*?)\]\)/)
    assert.ok(table, '源码里找不到 TRANSPARENT_WRAPPERS')
    assert.ok(!/'su'|'runuser'/.test(table[1]),
      '`su`/`runuser` 又回到了透明包装表（两处事实来源；它们应由 SU_WRAPPERS 单点回答）')
    assert.ok(/const SU_WRAPPERS = new Set\(\['su', 'runuser'\]\)/.test(hostSrc), 'SU_WRAPPERS 定义被改动')
    const unwrapBody = hostSrc.match(/function unwrapTransparentWrappers[\s\S]*?\n\}\n/)
    assert.ok(unwrapBody, '源码里找不到 unwrapTransparentWrappers')
    assert.ok(!/SU_WRAPPERS/.test(unwrapBody[0]),
      'unwrapTransparentWrappers 里又出现了 SU_WRAPPERS 早返回（表成员已移出 ⇒ 那是死代码/双事实来源）')
    // 行为对照：两条路径都还在（移出前后逐字段相同）
    assert.equal(dangerousCommandMatch('su root -c "rm -rf /x"')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('runuser -u root -- rm -rf /x')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('su - root')?.rule, SU_SHELL_RULE)
    assert.equal(dangerousCommandMatch('sudo su -')?.rule, SU_SHELL_RULE)
    assert.equal(dangerousCommandMatch('command -v su'), null)
  })

  it('命令文本取值：command/cmd/script 与数组形态；取不到返回空串', () => {
    assert.equal(commandTextOf({ command: 'ls' }), 'ls')
    assert.equal(commandTextOf(JSON.stringify({ command: 'ls -la' })), 'ls -la')
    assert.equal(commandTextOf({ cmd: 'pwd' }), 'pwd')
    assert.equal(commandTextOf({ script: 'echo a' }), 'echo a')
    assert.equal(commandTextOf({ command: [{ command: 'ls' }] }), 'ls')
    assert.equal(commandTextOf({ file_path: '/x' }), '')
    assert.equal(commandTextOf('{坏 JSON'), '')
    assert.equal(commandTextOf(null), '')
  })

  it('执行类判据：执行类工具名或带 shell 正文；写类工具不受影响', () => {
    assert.equal(isExecuteTool('bash', null), true)
    assert.equal(isExecuteTool('Bash', null), true)
    assert.equal(isExecuteTool('unknown-tool', { command: 'ls' }), true)
    assert.equal(isExecuteTool('write', { file_path: '/x' }), false)
    assert.equal(isExecuteTool('edit', null), false)
  })

  // ── v1.12.6 第八轮（终审 B1「欠吃」+ B2「macOS 包装器整类漏登记」+ M2 测试盲区）──

  it('第八轮阻断 B1：已登记包装器**漏登记的真实取值选项**（欠吃方向 ⇒ 取值被当程序名）', () => {
    // 终审在部署平台（本机 macOS）用真二进制双向核过：这些选项确实吃取值，吃饱后真程序名
    // 才在命令位置。改前判据层 null、监听器层 allowed-once（**静默放行**）。
    const probes = [
      ['env -P /bin rm -rf /x', 'rm -rf'],
      ['env -P /bin npm publish', 'npm publish'],
      ['xargs -J % rm -rf /x', 'rm -rf'],
      ['xargs -I {} -R 2 rm -rf /x', 'rm -rf'],
      ['xargs -I {} -S 100 rm -rf /x', 'rm -rf'],
      ['chroot -u root /mnt rm -rf /x', 'rm -rf'],
      ['chroot -g staff /mnt rm -rf /x', 'rm -rf'],
      ['chroot -G staff /mnt rm -rf /x', 'rm -rf'],
      // 附着形态（取值与选项粘连、不占下一个 token；本机核过这些写法确实被接受）
      ['env -P/bin rm -rf /x', 'rm -rf'],
      ['caffeinate -t1 rm -rf /x', 'rm -rf'],
      ['xargs -J% rm -rf /x', 'rm -rf'],
      ['chroot -uroot /mnt rm -rf /x', 'rm -rf'],
    ]
    for (const [cmd, want] of probes) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, want, `${cmd} 静默放行（欠吃方向：取值被当成程序名吃掉了）`)
    }
  })

  it('第八轮阻断 B2：macOS「跑下一条命令」的整类包装器（`arch`/`caffeinate`/`script`/`xcrun`）', () => {
    const probes = [
      ['arch -x86_64 rm -rf /x', 'rm -rf'],
      ['arch -arm64 git push', 'git push'],
      ['arch rm -rf /x', 'rm -rf'],
      ['caffeinate -d rm -rf /x', 'rm -rf'],
      ['caffeinate -disu git push', 'git push'],
      ['caffeinate -t 1 rm -rf /x', 'rm -rf'],
      ['caffeinate -w 1 git push', 'git push'],
      ['script -q /dev/null rm -rf /x', 'rm -rf'],
      ['script -t 2 /dev/null rm -rf /x', 'rm -rf'],
      ['script /dev/null npm publish', 'npm publish'],
      ['xcrun rm -rf /x', 'rm -rf'],
      ['xcrun -sdk macosx rm -rf /x', 'rm -rf'],
      ['xcrun --sdk macosx rm -rf /x', 'rm -rf'],
      ['xcrun --toolchain default rm -rf /x', 'rm -rf'],
    ]
    for (const [cmd, want] of probes) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, want, `${cmd} 静默放行（同族包装器没剥壳）`)
    }
  })

  it('第八轮：欠吃方向的**误伤守卫**（无害形态一条都不许弹）', () => {
    const guards = [
      // 验收硬条件里的 9 条（必须仍 allowed-once，不得变成永远弹窗）
      'env -P /bin ls', 'env -i ls', 'xargs -J % ls', 'xargs -I {} -R 2 ls', 'chroot -u root /mnt ls',
      'arch -x86_64 ls', 'caffeinate -d ls', 'script -q /dev/null ls', 'xcrun ls',
      // 同族的其它无害形态
      'env -P/bin ls', 'env -P /bin echo HI', 'caffeinate -t 1 ls', 'caffeinate -disu ls',
      'script -q /dev/null ls /tmp', 'script -t 2 /dev/null ls', 'xcrun -sdk macosx ls',
      'xcrun --toolchain default ls', 'chroot -g staff /mnt ls', 'arch -x86_64 /bin/echo HI',
    ]
    for (const cmd of guards) {
      assert.equal(dangerousCommandMatch(cmd), null, `${cmd} 被误伤（无害形态不该转交互）`)
    }
  })

  it('第八轮 M2：取值选项表与**字面量期望清单**双向对拍（删条目 / 加条目都必须红）', () => {
    // 终审变异实测：把 env 的 `-C` 从源码表里删掉后，旧用例仍 47/47 全绿（旧用例**从源码读表**
    // ⇒ 删条目 = 同时删掉断言）。这条用例把期望集合写成**字面量**，与源码表对拍：
    //   · 期望里有、源码里没有 ⇒ 红（漏登记 = 欠吃方向，正是本轮阻断的形态）；
    //   · 源码里有、期望里没有 ⇒ 红（多登记 = 把真程序名当取值吃掉 ⇒ 漏判），
    //     确属有意为之的写进 EXTRA_SOURCE_ENTRIES 并写明理由（本清单当前为空）。
    // 每条来源：第八轮在本机（macOS）真二进制逐条双向核对，或前几轮 man 页核对；
    // 证据见 lib/host-approval.js 表内注释。
    const EXPECTED_WRAPPER_VALUE_OPTIONS = {
      sudo: ['-u', '-g', '-p', '-C', '-h', '-r', '-t', '-R', '-T', '-U', '-D', '--user', '--group', '--prompt', '--close-from', '--host', '--role', '--type', '--chroot', '--command-timeout', '--other-user', '--chdir'],
      env: ['-u', '-C', '-S', '-P', '--unset', '--chdir', '--split-string'],
      nice: ['-n', '--adjustment'],
      time: ['-o', '-f', '--output', '--format'],
      timeout: ['-k', '-s', '--kill-after', '--signal'],
      stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
      xargs: ['-I', '-n', '-L', '-s', '-P', '-E', '-d', '-a', '-J', '-R', '-S', '--replace', '--max-lines', '--max-args', '--max-chars', '--max-procs', '--eof', '--delimiter', '--arg-file', '--process-slot-var'],
      doas: ['-u', '-C', '--user', '--config'],
      ionice: ['-c', '-n', '-p', '-P', '--class', '--classdata', '--pid', '--pgid'],
      taskset: ['-c', '-p', '--cpu-list', '--pid'],
      nsenter: ['-t', '--target', '-N', '--net-socket', '-G', '--setgid', '-S', '--setuid'],
      unshare: ['--map-user', '--map-users', '--map-group', '--map-groups', '--owner', '--propagation', '--setgroups', '-R', '--root', '-w', '--wd', '-S', '--setuid', '-G', '--setgid', '-l', '--load-interp', '--monotonic', '--boottime', '--whitelist-env'],
      strace: ['-e', '-E', '-p', '-u', '-b', '-I', '-P', '-a', '-o', '-s', '-U', '-O', '-S', '-X', '--trace', '--env', '--attach', '--user', '--detach-on', '--interruptible', '--trace-path', '--columns', '--output', '--string-limit', '--syscall-limit', '--stack-trace-frame-limit', '--argv0', '--namespace'],
      firejail: [],
      'systemd-run': ['-u', '--unit', '-p', '--property', '-E', '--setenv', '-H', '--host', '-M', '--machine', '--description', '--slice', '--service-type', '--uid', '--gid', '--nice', '--working-directory', '--on-active', '--on-boot', '--on-startup', '--on-unit-active', '--on-unit-inactive', '--on-calendar', '--path-property', '--socket-property', '--timer-property'],
      su: ['-c', '--command', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment', '--session-command'],
      runuser: ['-c', '--command', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment', '--session-command', '-u', '--user'],
      setarch: ['-p', '--pid'],
      prlimit: ['-o', '--output', '-p', '--pid'],
      // 第八轮新增（本机真二进制核对，见 CHANGELOG 第八轮节）
      chroot: ['-u', '-g', '-G'],
      caffeinate: ['-t', '-w'],
      script: ['-t', '-T'],
      xcrun: ['-sdk', '--sdk', '--toolchain'],
      // **空集是判定结果、不是漏登记**：`arch -x86_64` 只是架构选择器（`arch -x86_64` 单独写报
      // `arch: No command to execute`，若是取值选项会报 option requires an argument）⇒ 登记它会把
      // 真程序名（`rm`）当取值吃掉 ⇒ 反而漏判。行为哨兵见上面 B2 用例的两条 `arch` 断言。
      arch: [],
    }
    const EXPECTED_PROGRAM_VALUE_OPTIONS = {
      git: ['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix'],
      npm: ['--prefix', '-C', '--registry', '--userconfig', '--cache', '--loglevel', '--tag', '--workspace', '-w', '--otp', '--omit', '--include', '--before'],
      pnpm: ['--prefix', '--dir', '-C', '--registry', '--filter', '-F', '--config-dir', '--store-dir', '--workspace-root'],
      yarn: ['--cwd', '--registry', '--cache-folder', '--modules-folder', '--network-timeout', '--mutex'],
    }
    // 源码表里**多出来**的条目：确属有意为之才写进来（写明理由）。当前为空 = 一条都不许多。
    const EXTRA_SOURCE_ENTRIES = new Map([])

    const readTable = (constName) => {
      const block = hostSrc.match(new RegExp(`const ${constName} = \\{([\\s\\S]*?)\\n\\}`))
      assert.ok(block, `源码里找不到 ${constName}（改名/改形状 ⇒ 这条守卫要跟着更新，别静默空转）`)
      const out = new Map()
      const entryRe = /(?:'([^']+)'|([A-Za-z][\w-]*))\s*:\s*(?:optionSet\(\[([\s\S]*?)\]\)|new Set\(\))/g
      let m
      while ((m = entryRe.exec(block[1]))) {
        out.set(m[1] || m[2], m[3] === undefined ? [] : (m[3].match(/'[^']*'/g) || []).map((s) => s.slice(1, -1)))
      }
      return out
    }
    const compare = (name, expected, actual) => {
      const keys = new Set([...Object.keys(expected), ...actual.keys()])
      let checked = 0
      for (const key of keys) {
        const want = new Set(expected[key] ?? [])
        const got = new Set(actual.get(key) ?? [])
        for (const opt of want) {
          checked += 1
          assert.ok(got.has(opt), `${name}.${key} 丢了取值选项 ${opt}（欠吃方向：取值会被当成程序名 ⇒ 静默放行）`)
        }
        for (const opt of got) {
          if (EXTRA_SOURCE_ENTRIES.has(`${name}.${key}:${opt}`)) continue
          assert.ok(want.has(opt),
            `${name}.${key} 多登记了 ${opt} —— 多登记会把真程序名当取值吃掉 ⇒ 漏判；`
            + '确属有意为之请加进 EXTRA_SOURCE_ENTRIES 并写明理由')
        }
        if (want.size === 0 && expected[key] === undefined) continue
      }
      return checked
    }
    const wrapperActual = readTable('WRAPPER_VALUE_OPTIONS')
    const programActual = readTable('PROGRAM_VALUE_OPTIONS')
    assert.ok(wrapperActual.size >= 20, `WRAPPER_VALUE_OPTIONS 只解析出 ${wrapperActual.size} 条 —— 解析器失效了？`)
    assert.ok(programActual.size >= 3, `PROGRAM_VALUE_OPTIONS 只解析出 ${programActual.size} 条 —— 解析器失效了？`)
    const checked = compare('WRAPPER_VALUE_OPTIONS', EXPECTED_WRAPPER_VALUE_OPTIONS, wrapperActual)
      + compare('PROGRAM_VALUE_OPTIONS', EXPECTED_PROGRAM_VALUE_OPTIONS, programActual)
    assert.ok(checked >= 150, `只对拍了 ${checked} 条取值选项 —— 期望清单被清空/解析失效？`)
    for (const id of EXTRA_SOURCE_ENTRIES.keys()) {
      const [table, key, opt] = id.split(/[.:]/)
      assert.ok((table === 'WRAPPER_VALUE_OPTIONS' ? wrapperActual : programActual).get(key)?.includes(opt),
        `EXTRA_SOURCE_ENTRIES 里的 ${id} 已不在源码表里（陈旧豁免 ⇒ 删掉它，别让豁免面悄悄变大）`)
    }
    // 包装器**名单**（B2 的整类漏登记）：这 4 个 macOS 同族必须在剥壳名单里；
    // 名单被删 ⇒ 上面的 B2 行为用例也会红，这里再钉一次「名字还在」。
    const wrapperNames = hostSrc.match(/const TRANSPARENT_WRAPPERS = new Set\(\[([\s\S]*?)\]\)/)
    assert.ok(wrapperNames, '源码里找不到 TRANSPARENT_WRAPPERS')
    for (const name of ['arch', 'caffeinate', 'script', 'xcrun']) {
      assert.ok(new RegExp(`'${name}'`).test(wrapperNames[1]), `TRANSPARENT_WRAPPERS 里没有 ${name}`)
    }
    // 位置参数（`script` 的第一个位置参数是记录文件、`chroot` 的第一个是新根）：
    // 这两条漏掉 ⇒ 头 token 变成记录文件/新根 ⇒ 静默放行（行为面已有用例，这里钉住形状）
    const positional = hostSrc.match(/const WRAPPER_POSITIONAL_ARGS = \{([\s\S]*?)\n\}/)
    assert.ok(positional, '源码里找不到 WRAPPER_POSITIONAL_ARGS')
    assert.match(positional[1], /script:\s*\[1\]/, 'script 的第一个位置参数（记录文件）没登记')
    assert.match(positional[1], /chroot:\s*\[1\]/, 'chroot 的第一个位置参数（新根）没登记')
  })
})

// ════════════════════════════════════════════════════════════════════
// v1.12.10：**没有任何载荷豁免**（用户裁定：「载荷豁免 尽量保守，避免可能错过的高危命令，
// 宁愿多弹窗一次高危的处理」）。内容规则与形状判据对整段命令文本的**每一个段/行**全量生效。
//
// 为什么把前两版的豁免整层删掉（终审在真实链路上证成）：
//   · v1.12.8「剥载荷」：载荷里的真命令被藏 ⇒ `allowed-once` + 零留痕（静默放行）；
//   · v1.12.9「行掩码 + 载荷豁免 + 终止行跳过」：两条阻断 ——
//     B1 **假 heredoc 起始**：`x=$((n<<sh))` 的 `<<` 左操作数是标识符（不是数字），算术左移守卫
//        不成立 ⇒ 登记成 heredoc 起始 ⇒ 下一行 `sh` 命中终止行 ⇒ **连同内容规则一起被跳过**
//        ⇒ `null`（真 shell 实测那一行会被执行）；
//     B2 **载荷行上的反斜杠续行**：`rm \` 换行 `-rf /tmp/x` 被换行切成两段，内容规则看不到
//        `rm -rf`，唯一抓得到它的形状判据①又因载荷豁免而不生效 ⇒ `null`（喂给 `/bin/sh` 真删目录）。
//   两处现在都一律判定；新增的**代价**：正文行以 `- ` 开头、正文里真的出现危险命令、tag 恰好叫
//   `sh`/`bash`/`su` 时终止行按裸解释器判 —— 都会多弹一次，已如实登记进 CHANGELOG。
describe('v1.12.10 判据层：无载荷豁免（全量判定）+ 先内容后形状归因', () => {
  it('验收组 A：载荷里的真命令必须命中（第三轮终审证成的三族 + 兄弟仓那几族）', () => {
    for (const [why, cmd, rule] of [
      ['ssh host 载荷执行', "ssh host <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['载荷里带算术左移的对抗配方', "ssh host <<'SH'\nx=$((size << shift))\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['写脚本再执行（A 形态）', "cat > /tmp/g <<'SH'\nrm -rf /tmp/x\nSH\nsh /tmp/g", 'rm -rf'],
      ['重定向 + 分号执行（B 形态）', "cat <<'SH' > /tmp/g; sh /tmp/g\nrm -rf /tmp/x\nSH", SHELL_STDIN_RULE],
      ['重定向在前 + 分号执行（C 形态）', "cat > /tmp/g <<'SH'; sh /tmp/g\nrm -rf /tmp/x\nSH", SHELL_STDIN_RULE],
      ['重定向 + && 执行（D 形态）', "cat <<'SH' > /tmp/g && sh /tmp/g\nrm -rf /tmp/x\nSH", SHELL_STDIN_RULE],
      ['进程替换 `> >(ssh host)`', "cat <<'SH' > >(ssh host)\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['反斜杠奇偶 `tee /dev/null <<SH | sh`', "tee /dev/null <<'SH' | sh\nrm -rf /tmp/x\nSH", SHELL_STDIN_RULE],
      ['`\\` 续行把管道藏到下一行', "cat <<'SH' \\\n| ssh host\nsh -c 'rm -rf /tmp/zz'\nSH", 'rm -rf'],
      ['同名函数遮蔽 cat', 'cat() { ssh "$1"; }; cat <<\'SH\'\nrm -rf /tmp/x\nSH', 'rm -rf'],
      ['别名遮蔽 cat', "alias cat=ssh; cat <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['假 cat（`/tmp/plant/cat`）', "/tmp/plant/cat <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['`tar --use-compress-program=sh`', "tar --use-compress-program=sh -xf - <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['`git -c alias.s=!sh`', "git -c alias.s='!sh' s <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['管道下游 ssh', "cat <<'SH' | ssh host\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['`pwsh -Command -`', "pwsh -Command - <<'P'\ngit push\nP", 'git push'],
      ['docker exec -i', "docker exec -i c sh <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
      ['kubectl exec -i', "kubectl exec -i pod -- sh <<'SH'\nrm -rf /tmp/x\nSH", 'rm -rf'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${why}：载荷里的真命令被放过（静默放行）`)
    }
  })

  it('验收组 B1（原阻断）：假 heredoc 起始不再吞掉后面的真命令（11 条算术形态）', () => {
    // `<<` 前是**标识符**时算术左移守卫不成立 ⇒ v1.12.9 会把它当 heredoc 起始、把下一行 `sh`
    // 当终止行并跳过 ⇒ `null`。真 shell 实测（`/bin/sh` 与 bash 都打印第二行）该行**会执行**。
    for (const cmd of [
      'x=$((n<<sh))\nsh',
      'x=$((n << sh))\nsh',
      'x=$((n<< sh))\nsh',
      '((n<<sh))\nsh',
      '(( n << sh ))\nsh',
      'x=$[n<<sh]\nsh',
      'echo $[n<<sh]\nsh',
      'n=1; x=$((n<<sh))\nsh',
      'x=$((n<<sh)) # c\nsh',
      'true && x=$((n<<sh))\nsh',
      'x=$((n<<sh))\nsh -c "rm -rf /tmp/x"',
    ]) {
      const hit = dangerousCommandMatch(cmd)
      assert.notEqual(hit, null, `${JSON.stringify(cmd)} 被静默放行（假 heredoc 起始吞掉了下一行）`)
      // 前 10 条的第二行是**裸解释器** ⇒ 形状/内容规则按 `shell-stdin` 拦；
      // 第 11 条的第二行是 `sh -c "rm -rf …"` ⇒ 展开后归因是真命令名
      assert.equal(hit.rule, cmd.includes('rm -rf') ? 'rm -rf' : SHELL_STDIN_RULE,
        `${JSON.stringify(cmd)} 的归因不对`)
    }
    // 数字字面量那一档（原本就只有它被测到）照旧要命中
    assert.equal(dangerousCommandMatch('x=$((1<<n))\nrm -rf /tmp/x\nn')?.rule, 'rm -rf')
  })

  it('验收组 B2（v1.12.11 起：续行合并 ⇒ **内容规则**直接命中，比形状判据更准）', () => {
    // v1.12.10 那种「命令被换行劈成两半」的写法只有形状判据①抓得到；v1.12.11 的
    // `normalizeDangerText` 把**行尾未转义的 `\`** 与换行一起删掉、与下一行直接拼接
    // ⇒ 内容规则看得见真命令 ⇒ 归因是真命令名，而且 `git \`+`push` 这种「第二行不是选项」
    // 的写法也不再漏（v1.12.10 里它只在 tag 恰好是 shell 名时才被顺带拦下）。
    for (const [cmd, rule] of [
      ["ssh host <<'SH'\nrm \\\n-rf /tmp/x\nSH", 'rm -rf'],
      ["ssh host <<'EOF'\nrm \\\n-rf /tmp/x\nEOF", 'rm -rf'],
      ["ssh host <<'SH'\ngit \\\npush\nSH", 'git push'],
      ["ssh host <<'SH'\nnpm \\\npublish\nSH", 'npm publish'],
      ["ssh host <<'EOF'\ngit \\\npush origin main\nEOF", 'git push'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${JSON.stringify(cmd)} 判定不对`)
    }
  })

  it('验收组 B3：tag 恰好是 shell / 包装器名 ⇒ 终止行按普通行判（必须命中 = 代价多弹一次）', () => {
    for (const [tag, rule] of [
      ['sh', SHELL_STDIN_RULE], ['bash', SHELL_STDIN_RULE], ['zsh', SHELL_STDIN_RULE],
      ['dash', SHELL_STDIN_RULE], ['ksh', SHELL_STDIN_RULE],
      ['su', SU_SHELL_RULE], ['runuser', SU_SHELL_RULE],
    ]) {
      const cmd = `cat <<'${tag}'\nbody\n${tag}`
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule,
        `tag=${tag} 的终止行被跳过（v1.12.9 的终止行豁免已删）`)
    }
  })

  it('代价（用户裁定，刻意不再免掉）：正文行以 `- ` 开头 / 正文里出现危险命令 ⇒ 照旧多弹一次', () => {
    // 现场那条 38 秒白弹的 commit —— **用户明确接受它回来**：宁可多弹，也不冒漏掉载荷里真命令的险。
    const REPRO = [
      'git add -A',
      "git commit -q -F - <<'EOF'",
      'feat(grant): 0.7.10 全非法路径不再退化为工具档；补「规则语义（读侧）」文档',
      '',
      '- planGrantWrites 新增 none 出口：用户给了非空路径但全部被丢弃 ⇒',
      '  路径档与工具档都不写，只放行本次（仅显式回传 paths:[] 才落工具档）',
      'EOF',
    ].join('\n')
    for (const [why, cmd, rule] of [
      ['现场：正文行以 `- ` 开头', REPRO, WRAPPER_OPTION_AMBIGUITY_RULE],
      ['正文 `- 修复 xxx ####`', "git commit -q -F - <<EOF\n- 修复 xxx ####\nEOF", WRAPPER_OPTION_AMBIGUITY_RULE],
      ['`cat <<EOF > f` 正文以 `- ` 开头', 'cat <<EOF > f\n- planGrantWrites 新增 none 出口 ⇒\nEOF',
        WRAPPER_OPTION_AMBIGUITY_RULE],
      ['正文行以 `rm -rf` 开头', 'cat <<EOF > f\nrm -rf /tmp/x is documented here\nEOF', 'rm -rf'],
      ['正文行以 `git push` 开头', "git commit -q -F - <<'EOF'\ngit push 这类命令写在正文里时也只是在描述\nEOF", 'git push'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${why}：代价被偷偷免掉了`)
    }
    // 对照（不是「什么都弹」）：正文不含 `- ` 行、也不含危险命令字样 ⇒ 照旧 MISS
    for (const cmd of [
      'cat <<EOF > f\n普通说明文本\nEOF',
      "patch -p1 <<'EOF'\n正文说明文本\nEOF",
      "python3 - <<'PY'\nprint('hello')\nPY",
      "ssh host <<'E'\necho hello\nE",
    ]) {
      assert.equal(dangerousCommandMatch(cmd), null, `${JSON.stringify(cmd)} 被误判`)
    }
  })

  it('先内容、后形状：预算/形状分支返回前先求真命令名（终审指令 2/8）', () => {
    // 透明包装跳数用尽：归因必须是真命令名（改前一律 `wrapper-nesting`）
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}rm -rf /tmp/x`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`${'env '.repeat(9)}rm -rf /tmp/x`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}git push`)?.rule, 'git push')
    // 没有内容可归因时，仍按形状规则（可疑）保守转交互
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}ls -la`)?.rule, WRAPPER_DEPTH_RULE)
    // shell 嵌套超限：同理先求内容
    assert.equal(dangerousCommandMatch(`bash -c 'bash -c "bash -c rm -rf /"'`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`bash -c 'bash -c "bash -c echo hi"'`)?.rule, SHELL_DEPTH_RULE)
  })

  it('不放宽①：`<<` **之前**那条命令本身照旧判（`rm -rf x <<\'EOF\'`）', () => {
    assert.equal(dangerousCommandMatch("rm -rf /tmp/x <<'EOF'\nbody\nEOF")?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch("git push <<'EOF'\nbody\nEOF")?.rule, 'git push')
    assert.equal(dangerousCommandMatch("cat <<'EOF' > f && npm publish\nbody\nEOF")?.rule, 'npm publish',
      '同一行里 `<<` 之后的命令也必须照旧判')
  })

  it('不放宽②：终止行**之后**的命令照旧判（`EOF` 换行后的 `rm -rf /tmp/x`）', () => {
    assert.equal(dangerousCommandMatch('cat <<EOF > f\nbody\nEOF\nrm -rf /tmp/x')?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch("cat <<'EOF'\nbody\nEOF\ngit push")?.rule, 'git push')
    assert.equal(dangerousCommandMatch("cat <<'EOF'\nEOF\nrm -rf /tmp/x")?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch('cat <<-EOF\n\tbody\n\tEOF\nrm -rf /tmp/x')?.rule, 'rm -rf')
  })

  it('不放宽③：v1.12.8/v1.12.9 那两套豁免机器一个符号都不许复活', () => {
    for (const banned of [
      'heredocPayloadLines', 'scanHeredocBlocks', 'parseHeredocTag', 'scanHeredocOps',
      'isHeredocTerminator', 'MAX_HEREDOC_OPS', 'HEREDOC_TAG_RE', 'isCommentStart',
      'splitSubCommandsDetailed', 'shapeOk', 'terminators',
    ]) {
      assert.ok(!hostSrc.includes(banned), `lib/host-approval.js 里仍有过期符号：${banned}`)
    }
    // 判定必须仍然逐段走**同一个** matchSegment（没有任何「跳过」的分支）。
    // v1.12.11：判定文本先过 `normalizeDangerText`（续行合并 / 换行转义折空格 / 折叠空白），
    // 再交给 `splitSubCommands` 切段 —— 仍然是「每段都判、没有跳过」。
    assert.match(hostSrc, /for \(const variant of \[\n/, 'matchText 没有多读（口径链断了）')
    // v1.12.13：② 词内引号拼接（M3）与 ③ 旧口径读（B1：字面转义 + **裸 CR** 都折空格 = 1.12.11 读法）
    assert.match(hostSrc, /stripWordInternalQuotes\(normalizeDangerText\(text\)\)/, '词内引号拼接那一遍不见了（M3 会变松）')
    assert.match(hostSrc, /normalizeDangerText\(text, \{ literalEscapeAsSpace: true \}\)/, '旧口径读（literalEscapeAsSpace）不见了 —— 会变松')
    assert.match(hostSrc, /for \(const segment of splitSubCommands\(variant\)\) \{/, 'matchText 的逐段循环变了')
    assert.ok(!/continue\s*\/\*.*(skip|豁免)/.test(hostSrc), '出现可疑的跳过分支')
  })

  it('不放宽④：既有全部等价写法逐条不变（回归表）', () => {
    for (const [cmd, rule] of [
      ['bash -c "rm -rf /tmp/x"', 'rm -rf'],
      ["sh -c 'rm -rf /tmp/x'", 'rm -rf'],
      ['bash -c "bash -c \\"rm -rf /x\\""', 'rm -rf'],
      ['echo x | xargs rm -rf /tmp/x', 'rm -rf'],
      ['sudo rm -rf /tmp/x', 'rm -rf'],
      ['command rm -rf /tmp/x', 'rm -rf'],
      ['env rm -rf /tmp/x', 'rm -rf'],
      ['nohup rm -rf /tmp/x', 'rm -rf'],
      ['nice rm -rf /tmp/x', 'rm -rf'],
      ['time rm -rf /tmp/x', 'rm -rf'],
      ['/bin/rm -rf /tmp/x', 'rm -rf'],
      ['find /tmp -exec rm -rf {} +', 'rm -rf'],
      ['git -C /tmp push', 'git push'],
      ['git -c k=v push', 'git push'],
      ['npm --prefix /tmp publish', 'npm publish'],
      ['pnpm publish', 'pnpm publish'],
      ['yarn publish', 'yarn publish'],
      ['cat <<EOF > f && rm -rf /tmp/x\nbody\nEOF', 'rm -rf'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${cmd} 被放过（不得放宽任何既有拦截）`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════
// v1.12.11（用户裁定）：判定前的**文本规范化** + `contentRuleOf` 的**归因窗口**。
//
//   · Major 1：行尾**未转义的** `\`（可带行尾空白/CR）= 续行 ⇒ 删掉 `\` 与换行、直接拼接
//     ⇒ `git \`⏎`push origin main` 由**内容规则**命中（v1.12.10 是 MISS + 0 行留痕）；
//   · Major 2：**换行一律当段分隔符**（引号里也切）⇒ `bash -c "true`⏎`rm -rf /tmp/x"` 的第二行
//     独立判定 ⇒ 命中，**不需要**按 `-c` / `-Command` 做任何 flag 专门解析（用户明确不要）；
//   · 细则⑤：**连续空白折叠成一个空格** ⇒ `rm  -rf` / `git\tpush` / `rm \t -rf` 这类靠空白
//     规避的写法失效；真实换行**保留**为段分隔符（否则会抹平行首语义、把 1.12.10 已拦的一批
//     形态变成 MISS —— 见 CHANGELOG「归一化口径」）；
//   · Blocker：`MAX_ATTRIBUTION_TOKENS = 256` 窗口 —— 只让归因变粗，**绝不放行**。
describe('v1.12.11 判据层：续行合并 / 多行切段 / 空白折叠 / 归因窗口', () => {
  it('Major 1：行尾未转义的 `\` = 续行 ⇒ 合并后由内容规则命中', () => {
    for (const [cmd, rule] of [
      ['git \\\npush origin main', 'git push'],
      ['npm \\\npublish', 'npm publish'],
      ['rm \\\n-rf /tmp/x', 'rm -rf'],
      ['sudo \\\nrm -rf /tmp/x', 'rm -rf'],
      ['git \\\r\npush origin main', 'git push'], // CRLF
      ['git \\   \npush origin main', 'git push'], // 行尾 `\` 后带空格
      ['git \\\npush', 'git push'], // 只有两行
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${JSON.stringify(cmd)} 判定不对`)
    }
    // 非续行的边缘形态：`\` 被转义（`\\`）、行尾孤立 `\`、单引号里的 `\`
    assert.equal(dangerousCommandMatch('git \\\\\npush origin main'), null, '`\\` 是转义反斜杠，不是续行')
    assert.equal(dangerousCommandMatch('echo hi\\'), null, '行尾孤立反斜杠不该发假警报')
    assert.equal(dangerousCommandMatch("echo 'a\\\nb'"), null, '单引号里的形状不是命令')
    // 段切分直接可断言
    assert.deepEqual(splitSubCommands(normalizeDangerText('git \\\npush origin main')), ['git push origin main'])
  })

  it('Major 2：换行一律切段（含引号内）⇒ 多行 `-c` / `-Command` 正文逐行判定', () => {
    for (const [cmd, rule] of [
      ['bash -c "true\nrm -rf /tmp/x"', 'rm -rf'],
      ["sh -c 'true\nnpm publish'", 'npm publish'],
      ['zsh -c "echo hi\ngit push"', 'git push'],
      ['pwsh -Command "x\nnpm publish"', 'npm publish'],
      ['su root -c "true\ngit push"', 'git push'],
      ['bash -c "true\n- rm -rf /tmp/x"', 'wrapper-option-ambiguity'],
      // 裁定 2（v1.12.11 二次走查）：**字面** `\n`（两字符）也是这些消费者眼里的真换行 ⇒ 行分隔
      ['pwsh -Command "x\\nnpm publish"', 'npm publish'],
      ['python3 -c "import os\\nos.system(\'rm -rf /tmp/x\')"', 'rm -rf'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${JSON.stringify(cmd)} 判定不对`)
    }
    // 误伤守卫：多行正文里没有危险内容 ⇒ 照旧 MISS
    assert.equal(dangerousCommandMatch('bash -c "echo hi\nls -la"'), null)
    assert.equal(dangerousCommandMatch('bash -c "echo hi"'), null)
  })

  it('代码边界内容规则：危险命令紧跟**代码标点**（Python/Node/JSON 片段）⇒ HIT', () => {
    for (const [cmd, rule] of [
      ["os.system('rm -rf /tmp/x')", 'rm -rf'],
      ["{shell:'rm -rf /tmp/x'}", 'rm -rf'],
      ["subprocess.run(['rm', '-rf', '/tmp/x'])", null],
      ['$(git push origin main)', 'git push'],
      ['x="npm publish"', 'npm publish'],
    ]) {
      if (rule === null) { assert.equal(dangerousCommandMatch(cmd), null, `${cmd} 不该弹`); continue }
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${cmd} 应命中（代码片段）`)
    }
    // v1.12.12（用户裁定）：这些「标点左贴空白」的形态（数据参数 / 句中提及）现在由
    // **全文子串层**兜住 ⇒ 会弹（代价）。与「左贴代码」是两条通道，规则名可能是任一条。
    for (const cmd of ['echo "git push"', "echo 'rm -rf /tmp/x'", "curl 'a=1&rm -rf'",
      'echo "npm publish"', 'git commit -m "fix: never git push --force"']) {
      assert.notEqual(dangerousCommandMatch(cmd), null, `${cmd}：按 1.12.12 裁定应当弹（代价）`)
    }
  })

  it('细则⑤：连续空白折叠成单个空格（多余的空白不再是规避手段）', () => {
    for (const cmd of ['rm  -rf /tmp/x', 'rm    -rf /tmp/x', 'rm\t-rf /tmp/x', 'rm \t -rf /tmp/x',
      'git\t\tpush origin main', 'npm   publish']) {
      assert.notEqual(dangerousCommandMatch(cmd), null, `${JSON.stringify(cmd)} 应命中`)
    }
    // 折叠只作用在判定文本上：普通文本照旧 MISS
    assert.equal(dangerousCommandMatch('echo  hi   there'), null)
  })

  it('折叠/换行处理**不许**抹平行首语义（用户点名的三条 + 现场代价用例）', () => {
    assert.equal(dangerousCommandMatch('echo hi\n- rm -rf /tmp/x')?.rule, WRAPPER_OPTION_AMBIGUITY_RULE)
    assert.equal(dangerousCommandMatch('true\n- rf /tmp/x')?.rule, WRAPPER_OPTION_AMBIGUITY_RULE)
    assert.equal(dangerousCommandMatch('echo x\nsudo rm -rf /tmp/y')?.rule, 'rm -rf')
    // 现场那条 commit 的**代价**命中（1.12.10 起就是代价，本轮不许因为归一化丢掉）
    const REPRO = [
      'git add -A',
      "git commit -q -F - <<'EOF'",
      'feat: x',
      '',
      '- planGrantWrites 新增 none 出口：用户给了非空路径但全部被丢弃 ⇒',
      'EOF',
    ].join('\n')
    assert.equal(dangerousCommandMatch(REPRO)?.rule, WRAPPER_OPTION_AMBIGUITY_RULE)
    // 句中只是提到危险命令 ⇒ v1.12.12 起按用户裁定**弹**（代价；见 CHANGELOG「模式变更与代价」）
    assert.equal(dangerousCommandMatch('echo "note: never run rm -rf /tmp/x by hand"')?.rule, 'text:rm -rf')
    assert.equal(dangerousCommandMatch('git commit -m "fix: never git push --force"')?.rule, 'text:git push')
  })

  it('不许变松（**双读**）：规范化只能更容易命中，1.12.10 会命中的形态一条都不许变 MISS', () => {
    // `test \` ⏎ `-f x`：合并成 `test -f x` 后段首不再是选项（形状判据①不再命中），
    // 但原文第二行 `-f x` 在 1.12.10 里是命中的 ⇒ 「双读」把原文那一遍保留下来（多弹一次）。
    // 差分实测（24,755 条语料）：relaxed 必须为 0，这条就是其中一类的代表。
    for (const cmd of ['test \\\n-f x', 'test \\\r\n-f x', 'test \\   \n-f x']) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, WRAPPER_OPTION_AMBIGUITY_RULE,
        `${JSON.stringify(cmd)} 从「命中」变成了 MISS（= 变松）`)
    }
    // 对照组：原文本来就不命中的续行（无害）⇒ 仍然 MISS
    assert.equal(dangerousCommandMatch('echo \\\nhi'), null)
    // 「旧口径读」也必须保留（多读的第二遍：字面转义折空格）：`rm\n-rf\n/tmp/x`（**字面** \n）
    // 在新口径下拆成三段都不命中，但旧口径拼成 `rm -rf /tmp/x` 是命中的 ⇒ 保留（relaxed = 0 的一类）
    for (const [cmd, rule] of [
      ['rm\\n-rf\\n/tmp/x', 'rm -rf'],
      ['rm\\r-rf\\r/tmp/x', 'rm -rf'],
      ['git\\npush origin main', 'git push'],
      ['npm\\npublish', 'npm publish'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule,
        `${cmd} 旧口径会命中、新口径拆散了 ⇒ 多读必须把它留下来（否则就是变松）`)
    }
  })

  it('Blocker：`MAX_ATTRIBUTION_TOKENS` 窗口 —— 归因变粗但**绝不放行**', () => {
    assert.equal(MAX_ATTRIBUTION_TOKENS, 256)
    // 归因精度：9 个包装词（落不进窗口裁剪区）照旧精确
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}rm -rf /tmp/x`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(9)}ls -la`)?.rule, WRAPPER_DEPTH_RULE)
    // 超长包装前缀：**仍然拦**（不是 null），真命令在尾部照旧能归因
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(32768)}rm -rf /tmp/x`)?.rule, 'rm -rf')
    assert.equal(dangerousCommandMatch(`${'sudo '.repeat(32768)}ls`)?.rule, WRAPPER_DEPTH_RULE,
      '窗口裁掉后只剩「包装太深」的可疑归因 —— 但绝不是放行')
    assert.notEqual(dangerousCommandMatch(`${'sudo '.repeat(100000)}ls`), null)
  })

  it('Blocker：二次路径的性能回归被封顶（32768 个包装词 < 500ms；1.12.10 实测 ≈2.9s）', () => {
    const big = 'sudo '.repeat(32768) + 'ls'
    dangerousCommandMatch(big.slice(0, 400)) // 预热
    const t0 = performance.now()
    dangerousCommandMatch(big)
    const ms = performance.now() - t0
    assert.ok(ms < 500, `32768 个包装词耗时 ${ms.toFixed(1)}ms（>500ms ⇒ 归因窗口被破坏）`)
  })

  it('Minor 1：大写 tag 与 runuser 的终止行代价逐条钉住', () => {
    for (const [tag, rule] of [
      ['sh', SHELL_STDIN_RULE], ['SH', SHELL_STDIN_RULE], ['Sh', SHELL_STDIN_RULE],
      ['bash', SHELL_STDIN_RULE], ['BASH', SHELL_STDIN_RULE],
      ['zsh', SHELL_STDIN_RULE], ['dash', SHELL_STDIN_RULE], ['ksh', SHELL_STDIN_RULE],
      ['su', SU_SHELL_RULE], ['SU', SU_SHELL_RULE], ['Su', SU_SHELL_RULE],
      ['runuser', SU_SHELL_RULE], ['RUNUSER', SU_SHELL_RULE],
    ]) {
      assert.equal(dangerousCommandMatch(`cat <<'${tag}'\nbody\n${tag}`)?.rule, rule,
        `tag=${tag} 的终止行应当命中（basenameOf 会小写化）`)
    }
    for (const tag of ['EOF', 'Eof', 'eof', 'JSON', 'Json', 'PY', 'END', 'YAML', 'TXT']) {
      assert.equal(dangerousCommandMatch(`cat <<'${tag}'\nbody\n${tag}`), null, `tag=${tag} 不该弹`)
    }
  })
})

// ════════════════════════════════════════════════════════════════════
describe('监听器层：危险命令在任何档位下都不自动放行', () => {
  it('已授权 bash ⇒ 三条命令仍一律 next()，且都不吃路径/项目档', async () => {
    const b = await bootWithBashGranted()
    try {
      for (const cmd of ['git push origin main', 'npm publish', 'rm -rf /tmp/x']) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('d1', cmd) })
        const r = await approve(b, s, { callId: 'd1', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${cmd} 被静默放行了（用户裁决：必须走交互授权）`)
        assert.notEqual(r.res, 'allowed-once', `${cmd} 返回了 allowed-once`)
      }
      // 留痕：门名必须出现在日志里（排查时能区分「门拦的」与「本来就判不出来」）
      const blocked = logRows(b.home).filter((r) => r.action === 'danger-command-block')
      assert.deepEqual(blocked.map((r) => r.rule), ['git push', 'npm publish', 'rm -rf'])
      for (const row of blocked) {
        assert.equal(row.kind, 'host-approval')
        assert.equal(row.tool, 'bash')
        assert.ok(row.segment, '日志要带命中的那段命令（截断后的）')
      }
      assert.equal(logRows(b.home).filter((r) => r.action === 'auto-grant').length, 0, '整轮里不该有任何自动放行')
    } finally { await b.close() }
  })

  it('对照：普通命令照旧命中工具名档直接放行（门不能把正常路径一起关掉）', async () => {
    const b = await bootWithBashGranted()
    try {
      const cases = [
        ['ls -la /tmp/x', '普通列目录'],
        ['echo hi', '无路径命令'],
      ]
      for (const [cmd, why] of cases) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('c1', cmd) })
        const r = await approve(b, s, { callId: 'c1', toolName: 'bash' })
        assert.equal(r.res, 'allowed-once', `${why}（${cmd}）被这道门误伤`)
        assert.equal(r.nextCalled, false)
      }
      // heredoc 形态（python3 - <<'PY'）也是普通命令：正文里没有危险子命令
      const s2 = mkSession({
        id: 'child-3', parentSession: 'R',
        toolCalls: bashCall('c2', "python3 - <<'PY'\nprint('hello')\nPY"),
      })
      const r2 = await approve(b, s2, { callId: 'c2', toolName: 'bash' })
      assert.equal(r2.res, 'allowed-once', 'heredoc 形式被误伤')
    } finally { await b.close() }
  })

  it('v1.12.12 代价（监听器层）：文本里提到预设字样 ⇒ next() + 留 1 行门名', async () => {
    // 用户裁定「文本里出现危险字样就弹」⇒ 监听器层同样不再自动放行（代价，不是缺陷）
    const b = await bootWithBashGranted()
    try {
      for (const [cmd, rule] of [['echo "git push"', 'text:git push'],
        ['grep "git push" f', 'text:git push'], ['# rm -rf /tmp', 'text:rm -rf']]) {
        const before = logRows(b.home).filter((r) => r.action === 'danger-command-block').length
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('f1', cmd) })
        const r = await approve(b, s, { callId: 'f1', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${cmd} 应当交给交互层（代价）`)
        assert.notEqual(r.res, 'allowed-once')
        const rows = logRows(b.home).filter((r) => r.action === 'danger-command-block')
        assert.equal(rows.length - before, 1, `${cmd} 必须留 1 行门名`)
        assert.equal(rows[rows.length - 1].rule, rule)
      }
    } finally { await b.close() }
  })

  it('监听器层：等价/包装写法在「已授权 bash」下同样一律 next()', async () => {
    const b = await bootWithBashGranted()
    try {
      const probes = [
        'sudo rm -rf /tmp/x', 'command rm -rf /tmp/x', 'env rm -rf /tmp/x',
        'nohup rm -rf /tmp/x', 'nice rm -rf /tmp/x', 'time rm -rf /tmp/x',
        '/bin/rm -rf /tmp/x', 'bash -c "rm -rf /tmp/x"', "sh -c 'rm -rf /tmp/x'",
        'echo x | xargs rm -rf', 'git -C /tmp push', 'git -c k=v push',
        'npm --prefix /tmp publish', 'pnpm publish', 'yarn publish',
        // v1.12.6 第四轮（终审 B1）：取值选项大小写归一之前，这四条是静默放行
        'pnpm -C /tmp publish', 'npm -C /tmp publish',
        'sudo -C 3 rm -rf /tmp/x', "env -S 'ls; rm -rf /x'",
        // v1.12.6 第四轮（终审 M1）：7 种未声明的等价写法
        'busybox rm -rf /tmp/x', "printf 'rm -rf /x' | bash", "bash <<< 'rm -rf /x'",
        'yarn npm publish', 'find /tmp -exec rm -rf {} +',
        "bash -c'rm -rf /x'", 'sh -c"rm -rf /x"',
        // 深度 3 的嵌套（转义写法）：按 shell-nesting 保守转交互
        'bash -c "bash -c \\"bash -c rm -rf /\\""',
        // 透明包装跳数用尽：按 wrapper-nesting 保守转交互
        'sudo sudo sudo sudo sudo sudo sudo sudo sudo rm -rf /tmp/x',
      ]
      for (const cmd of probes) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('d1', cmd) })
        const r = await approve(b, s, { callId: 'd1', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${cmd} 被静默放行了（用户裁决：必须走交互授权）`)
        assert.notEqual(r.res, 'allowed-once', `${cmd} 返回了 allowed-once`)
      }
      const rows = logRows(b.home)
      assert.equal(rows.filter((r) => r.action === 'danger-command-block').length, probes.length,
        '每条等价写法都要留痕（门名 + 那段命令）')
      assert.equal(rows.filter((r) => r.action === 'auto-grant').length, 0, '整轮里不该有任何自动放行')
    } finally { await b.close() }
  })

  it('第五轮 M-A / M-C 监听器层：multi-exec 段首 `-exec`、`source`/`.`、新包装器在「已授权 bash」下也一律 next()', async () => {
    const b = await bootWithBashGranted()
    try {
      const probes = [
        // M-A：multi-exec 与「段首就是 -exec」（splitSubCommands 的第二段）
        'find /tmp -exec echo {} \\; -exec rm -rf {} +',
        '-exec rm -rf {} +',
        // M-C①：同族包装器（含各自的取值/位置参数）
        'doas rm -rf /tmp/x', 'doas -u root rm -rf /tmp/x',
        'setsid rm -rf /tmp/x', 'setsid -f rm -rf /tmp/x',
        'chroot /mnt rm -rf /tmp/x', 'chroot --userspec=u:g /mnt rm -rf /tmp/x',
        'ionice -c 3 rm -rf /tmp/x', 'taskset -c 0 rm -rf /tmp/x',
        // M-C②：`source` / `.` 与 `bash deploy.sh` 同原则
        'source script.sh', '. script.sh', '. ./install.sh',
      ]
      for (const cmd of probes) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('d1', cmd) })
        const r = await approve(b, s, { callId: 'd1', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${cmd} 被静默放行了（用户裁决：必须走交互授权）`)
        assert.notEqual(r.res, 'allowed-once', `${cmd} 返回了 allowed-once`)
      }
      const rows = logRows(b.home)
      assert.equal(rows.filter((r) => r.action === 'danger-command-block').length, probes.length,
        '每条都要留痕（门名 + 那段命令）')
      const rules = new Set(rows.filter((r) => r.action === 'danger-command-block').map((r) => r.rule))
      for (const want of ['rm -rf', SHELL_SOURCE_RULE]) {
        assert.ok(rules.has(want), `留痕里没有门名 ${want}：${[...rules].join('/')}`)
      }
      assert.equal(rows.filter((r) => r.action === 'auto-grant').length, 0, '整轮里不该有任何自动放行')
    } finally { await b.close() }
  })

  it('第六轮 M-D 监听器层：9 个同族包装器在「已授权 bash」下也一律 next()（含 su/runuser 的 -c 正文）', async () => {
    const b = await bootWithBashGranted()
    try {
      const probes = [
        // 验收 9 条（逐字对应用户清单）
        'unshare -m rm -rf /x', 'nsenter -t 1 -m rm -rf /x', 'strace -f rm -rf /x',
        'firejail rm -rf /x', 'systemd-run --user rm -rf /x',
        'su root -c "rm -rf /x"', 'runuser -u root -- rm -rf /x',
        'setarch x86_64 rm -rf /x', 'prlimit rm -rf /x',
        // 取值/位置参数与叠加（判据层同族的另一半）
        'nsenter -t 1 -m -u -i -n -p rm -rf /x', 'unshare -R /newroot rm -rf /x',
        'strace -o /tmp/log -f rm -rf /x', 'firejail --profile=/x.profile rm -rf /x',
        'systemd-run -p MemoryMax=1G --user rm -rf /x', "su -c'rm -rf /x'",
        'su - root -c \'rm -rf /x\'', 'runuser -u root -c "rm -rf /x"',
        'setarch -R rm -rf /x', 'prlimit --pid 1 rm -rf /x',
        'sudo su root -c "rm -rf /x"', "bash -c \"su root -c 'rm -rf /x'\"",
        'setsid strace -f rm -rf /x',
        // 没有 `-c` 的 su/runuser：交互登录 shell ⇒ 可疑（不是放行）
        'su - root', 'runuser -l root',
      ]
      for (const cmd of probes) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('d1', cmd) })
        const r = await approve(b, s, { callId: 'd1', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${cmd} 被静默放行了（用户裁决：必须走交互授权）`)
        assert.notEqual(r.res, 'allowed-once', `${cmd} 返回了 allowed-once`)
      }
      const rows = logRows(b.home)
      assert.equal(rows.filter((r) => r.action === 'danger-command-block').length, probes.length,
        '每条都要留痕（门名 + 那段命令）')
      const rules = new Set(rows.filter((r) => r.action === 'danger-command-block').map((r) => r.rule))
      for (const want of ['rm -rf', SU_SHELL_RULE]) {
        assert.ok(rules.has(want), `留痕里没有门名 ${want}：${[...rules].join('/')}`)
      }
      assert.equal(rows.filter((r) => r.action === 'auto-grant').length, 0, '整轮里不该有任何自动放行')
    } finally { await b.close() }
  })

  it('第六轮 M-D 监听器层误伤守卫：这 9 个包装器后面的普通命令照旧吃工具名档', async () => {
    const b = await bootWithBashGranted()
    try {
      for (const cmd of [
        'unshare -m ls -la', 'nsenter -t 1 -m ls', 'strace -f ls', 'strace -o /tmp/o ls',
        'firejail ls', 'firejail --net=none ls', 'systemd-run --user ls',
        'systemd-run --user npm run build', 'setarch x86_64 ls', 'setarch --list',
        'setarch --show --pid 9284', 'prlimit ls', 'prlimit --pid 1', 'prlimit -o /tmp/o',
        'su root -c "ls"', 'runuser -u root -- ls', 'su -s /bin/zsh root -c "ls"',
        'command -v su', 'command -V su', 'command -v source', 'echo su root', 'cat su.sh',
      ]) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('f1', cmd) })
        const r = await approve(b, s, { callId: 'f1', toolName: 'bash' })
        assert.equal(r.res, 'allowed-once', `${cmd} 被新包装器判据误伤（该走工具名档却弹了）`)
      }
      assert.equal(logRows(b.home).filter((r) => r.action === 'danger-command-block').length, 0,
        '误伤守卫不该留 danger-command-block 痕')
    } finally { await b.close() }
  })

  it('第六轮 Minor 3：`commandText` 超过 256KB ⇒ 按 command-too-long 保守转交互（argsText 只截断）', async () => {
    const b = await bootWithBashGranted()
    try {
      // ① 执行类 + 超长 shell 正文：**后段根本没扫过** ⇒ 判不出不等于放行
      const longCmd = `echo hi; ${'a'.repeat(MAX_DANGER_TEXT_CHARS + 100)}`
      const s1 = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('L1', longCmd) })
      const r1 = await approve(b, s1, { callId: 'L1', toolName: 'bash' })
      assert.equal(r1.nextCalled, true, '超长 commandText 必须交回交互层（不是自动放行）')
      assert.notEqual(r1.res, 'allowed-once')
      const rows = logRows(b.home)
      const blocked = rows.filter((r) => r.action === 'danger-command-block')
      assert.equal(blocked.length, 1, '超长 commandText 必须留 danger-command-block 痕')
      assert.equal(blocked[0].rule, COMMAND_TOO_LONG_RULE)
      assert.equal(COMMAND_TOO_LONG_RULE, 'command-too-long')
      // 截断与门名都要能在上下文里查到（UI 才说得出「每次都会问、不可记忆」）
      const pend = await b.req('GET', '/agent-api/host-approval-context?callId=L1&sessionId=child-2')
      assert.equal(pend.status, 200)
      assert.equal(pend.json.dangerRule, COMMAND_TOO_LONG_RULE)
      assert.equal(rows.filter((r) => r.action === 'danger-text-truncated').length, 1,
        '截断本身仍要留痕（含截掉多少字符）')

      // ② 对照：**argsText** 超长（write 的大正文）不转交互 —— 大正文是常态，
      //    这条口径是刻意的（第五轮 Minor 2 的取舍），工具名档照旧生效。
      const big = 'x'.repeat(MAX_DANGER_TEXT_CHARS + 100)
      const s2 = mkSession({ id: 'child-9', parentSession: 'R9', toolCalls: [{ callId: 'g1', name: 'write', arguments: { file_path: '/tmp/big.txt', content: big } }] })
      assert.equal((await approve(b, s2, { callId: 'g1', toolName: 'write' })).nextCalled, true, '前置：首次请求交给交互层')
      const w = await b.req('POST', '/agent-api/host-approval-rule', { scope: 'session', sessionId: 'child-9', callId: 'g1', toolName: 'write' })
      assert.equal(w.status, 200)
      const s3 = mkSession({ id: 'child-9', parentSession: 'R9', toolCalls: [{ callId: 'g2', name: 'write', arguments: { file_path: '/tmp/big2.txt', content: big } }] })
      const r3 = await approve(b, s3, { callId: 'g2', toolName: 'write' })
      assert.equal(r3.res, 'allowed-once', 'argsText 超长不得转成交互（write 的大正文是常态）')
      assert.equal(logRows(b.home).filter((r) => r.action === 'danger-command-block').length, 1,
        '② 不该新增 danger-command-block（argsText 这条只截断 + 留痕）')
    } finally { await b.close() }
  })

  it('第五轮 M-B 无关但同族：非绝对路径等新判据不得误伤普通命令（监听器层误伤守卫）', async () => {
    const b = await bootWithBashGranted()
    try {
      for (const cmd of [
        'echo hi', 'ls -la', 'command -v rm', 'command -v source', 'grep x f',
        "find /tmp -exec ls {} \\;", 'find . -exec grep -l foo {} +',
        'yarn npm install', 'chroot /mnt ls', 'ionice -c 3 ls -la', 'taskset -c 0 ls',
      ]) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('f1', cmd) })
        const r = await approve(b, s, { callId: 'f1', toolName: 'bash' })
        assert.equal(r.res, 'allowed-once', `${cmd} 被新判据误伤（该走工具名档却弹了）`)
      }
      assert.equal(logRows(b.home).filter((r) => r.action === 'danger-command-block').length, 0,
        '误伤守卫不该留 danger-command-block 痕')
    } finally { await b.close() }
  })

  it('自定义执行工具：工具名不在执行类 slug、参数键也不是 command ⇒ 仍要判危险', async () => {
    const b = await boot()
    try {
      // 先把这条自定义工具授权到根会话键（= 工具名档最宽的前置条件）
      const s1 = mkSession({ id: 'child-1', parentSession: 'R', toolCalls: [{ callId: 'g1', name: 'custom_shell', arguments: { shell: 'echo hi' } }] })
      const first = await approve(b, s1, { callId: 'g1', toolName: 'custom_shell' })
      assert.equal(first.nextCalled, true, '前置：首次请求应交给交互层')
      const { status, json } = await postRule(b, { scope: 'session', sessionId: 'child-1', callId: 'g1', toolName: 'custom_shell' })
      assert.equal(status, 200)
      assert.equal(json.rootSessionId, 'R')
      // 对照：普通正文照旧走工具名档直接放行（门不能把这条工具整个关掉）
      const s2 = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: [{ callId: 'c1', name: 'custom_shell', arguments: { shell: 'echo hi' } }] })
      const ok = await approve(b, s2, { callId: 'c1', toolName: 'custom_shell' })
      assert.equal(ok.res, 'allowed-once', '自定义工具的普通调用被这道门误伤')
      // 危险命令藏在非 command 键里 ⇒ 必须 next()（工具名与参数键都在各自名单之外）
      const s3 = mkSession({ id: 'child-3', parentSession: 'R', toolCalls: [{ callId: 'd1', name: 'custom_shell', arguments: { shell: 'rm -rf /tmp/x' } }] })
      const d = await approve(b, s3, { callId: 'd1', toolName: 'custom_shell' })
      assert.equal(d.nextCalled, true, '自定义执行工具里的 rm -rf 被静默放行了')
      assert.notEqual(d.res, 'allowed-once')
      assert.ok(logRows(b.home).some((r) => r.action === 'danger-command-block' && r.rule === 'rm -rf' && r.tool === 'custom_shell'),
        '门命中要留痕（含工具名）')
    } finally { await b.close() }
  })

  it('终审 M3：门命中时暂存上下文带 dangerRule（UI 才说得出「每次都会问、不可记忆」）', async () => {
    const b = await bootWithBashGranted()
    try {
      const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('d9', 'sudo rm -rf /tmp/x') })
      const r = await approve(b, s, { callId: 'd9', toolName: 'bash' })
      assert.equal(r.nextCalled, true)
      const { status, json } = await b.req('GET', '/agent-api/host-approval-context?callId=d9&sessionId=child-2')
      assert.equal(status, 200)
      assert.equal(json.dangerRule, 'rm -rf', '门命中时上下文必须带门名（否则客户端无从提示）')
      // 对照：普通命令不带标记（否则「每次都会问」会挂在所有请求上，等于谎报）
      const s2 = mkSession({ id: 'child-3', parentSession: 'R', toolCalls: bashCall('c9', 'ls -la /tmp/x') })
      await approve(b, s2, { callId: 'c9', toolName: 'bash' })
      const g = await b.req('GET', '/agent-api/host-approval-context?callId=c9&sessionId=child-3')
      assert.equal(g.status, 200)
      assert.equal(g.json.dangerRule ?? null, null, '没命中门的请求不得带这个标记')
    } finally { await b.close() }
  })

  it('保守策略：执行类调用解析不出命令文本 ⇒ 也不自动放行（非执行类不受影响）', async () => {
    const b = await bootWithBashGranted()
    try {
      // ① 有 bash 记录、但 arguments 是坏 JSON ⇒ 取不到命令文本
      const s1 = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: [{ callId: 'x1', name: 'bash', arguments: '{不是 JSON' }] })
      const r1 = await approve(b, s1, { callId: 'x1', toolName: 'bash' })
      assert.equal(r1.nextCalled, true, '执行类取不到命令文本时必须交回交互层')
      // ② 完全没有 tool/call 记录（缺记录 fixture）
      const s2 = mkSession({ id: 'child-3', parentSession: 'R' })
      const r2 = await approve(b, s2, { callId: 'x2', toolName: 'bash' })
      assert.equal(r2.nextCalled, true, '无记录的执行类同样不得放行')
      const rows = logRows(b.home).filter((r) => r.action === 'no-command-text-block')
      assert.equal(rows.length, 2, '两次保守拦截都要留痕（日志里注明原因）')
      // ③ 非执行类工具（write + 文件路径）不受这条保守策略影响：工具名档照旧生效
      const s3 = mkSession({ id: 'child-4', parentSession: 'R', toolCalls: [{ callId: 'w1', name: 'write', arguments: { file_path: '/tmp/x' } }] })
      const wFirst = await approve(b, s3, { callId: 'w1', toolName: 'write' })
      assert.equal(wFirst.nextCalled, true, 'write 的首次请求本来就要交互（无授权、无路径规则）')
      const grant = await postRule(b, { scope: 'session', sessionId: 'child-4', callId: 'w1', toolName: 'write' })
      assert.equal(grant.status, 200)
      const r3 = await approve(b, s3, { callId: 'w1', toolName: 'write' })
      assert.equal(r3.res, 'allowed-once', '非执行类被保守策略误伤')
    } finally { await b.close() }
  })

  // ── v1.12.6 第七轮（终审阻断 A/B + Minor m3）监听器层 ─────────────────────

  it('第七轮监听器层：大小写碰撞（同形开关吃掉真程序名）的 9 条在「已授权 bash」下也一律 next()', async () => {
    const b = await bootWithBashGranted()
    try {
      const probes = [
        // 4 组碰撞：`-R`↔`-r`、`-N`↔`-n`、`-a`↔`-A`、`-p`↔`-P`；外加 xargs 的 `-L`↔`-l`、`-P`↔`-p`
        'unshare -r rm -rf /x', 'unshare -m -r rm -rf /x',
        'nsenter -n rm -rf /x', 'nsenter -t 1 -n rm -rf /x',
        'strace -A rm -rf /x',
        'systemd-run -P rm -rf /x', 'systemd-run --user -P rm -rf /x',
        'xargs -l rm -rf /x', 'xargs -p rm -rf /x',
        // 同族的既有命中（回归对照）与第七轮新补的真实大小写取值选项
        'git -C /tmp push', 'sudo -R /mnt rm -rf /x', 'strace -U columns rm -rf /x',
        // 结构性兜底（判据层同族的另一半）
        "env -S 'rm -rf /x'", 'su -G grp rm -rf /x',
        // Minor m3：no-`-c` 分支的留痕必须看得到外层包装
        'runuser -u root -- rm -rf /x',
      ]
      for (const cmd of probes) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('d1', cmd) })
        const r = await approve(b, s, { callId: 'd1', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${cmd} 被静默放行了（用户裁决：必须走交互授权）`)
        assert.notEqual(r.res, 'allowed-once', `${cmd} 返回了 allowed-once`)
      }
      const rows = logRows(b.home).filter((r) => r.action === 'danger-command-block')
      assert.equal(rows.length, probes.length, '每条都要留痕（门名 + 那段命令）')
      const rules = new Set(rows.map((r) => r.rule))
      for (const want of ['rm -rf', 'git push', WRAPPER_OPTION_AMBIGUITY_RULE]) {
        assert.ok(rules.has(want), `留痕里没有门名 ${want}：${[...rules].join('/')}`)
      }
      const m3 = rows.find((r) => typeof r.segment === 'string' && r.segment.startsWith('runuser -u root -- rm -rf'))
      assert.ok(m3, `Minor m3：留痕丢了外层段（实测 ${JSON.stringify(rows.map((r) => r.segment))}）`)
      assert.equal(rows.filter((r) => r.action === 'auto-grant').length, 0, '整轮里不该有任何自动放行')
    } finally { await b.close() }
  })

  it('第七轮监听器层误伤守卫：碰撞附近与「取值吃掉后什么都不剩」的写法照旧吃工具名档', async () => {
    const b = await bootWithBashGranted()
    try {
      for (const cmd of [
        // 空参数 / 纯信息开关：`unshare --help`、`strace ls`、`systemd-run --version`、
        // `setarch --list`、裸 `prlimit`（任务验收里点名的 5 条）
        'unshare --help', 'strace ls', 'systemd-run --version', 'setarch --list', 'prlimit',
        // 同族的既有守卫（第六轮 22 条里的代表）
        'unshare -m ls -la', 'nsenter -t 1 -m ls', 'strace -o /tmp/o ls', 'prlimit --pid 1',
        'prlimit -o /tmp/o', 'setarch --show --pid 9284', 'systemd-run --user ls', 'xargs ls',
        'su root -c "ls"', 'runuser -u root -- ls', 'command -v su',
        // `xargs -i`（可选附着参数，本轮从取值表里删掉）与 `-exec` 系段
        'xargs -i ls', 'find /tmp -exec ls {} +',
      ]) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('f1', cmd) })
        const r = await approve(b, s, { callId: 'f1', toolName: 'bash' })
        assert.equal(r.res, 'allowed-once', `${cmd} 被第七轮的改动误伤（该走工具名档却弹了）`)
      }
      assert.equal(logRows(b.home).filter((r) => r.action === 'danger-command-block').length, 0,
        '误伤守卫不该留 danger-command-block 痕')
    } finally { await b.close() }
  })

  it('门的顺序：必须在工具名短路与所有路径/项目档判定**之前**', () => {
    // v1.12.6 第五轮（终审 Minor 2）：调用点改成先做**有界截断**再判（`dangerCmd`/`dangerArgs`），
    // 锚点因此从 `dangerousCommandMatch(ctxInfo.commandText)` 换成下面这行。断言的**语义一字未变**
    // ——仍然是「这个调用点必须排在工具名短路与 decide 之前」。
    const gate = indexSrc.indexOf('const danger = dangerousCommandMatch(dangerCmd.text)')
    assert.ok(gate > 0, '危险命令门调用点丢失')
    const bound = indexSrc.indexOf('const dangerCmd = boundDangerText(ctxInfo.commandText)')
    assert.ok(bound > 0 && bound < gate,
      '有界截断必须发生在判定之前（否则超长文本仍然全量进判定：4MB ⇒ ~0.9s 阻塞）')
    const toolShort = indexSrc.indexOf("if (!disallowToolGrant && ctxInfo.toolName && hostApproval.toolGrantCovers(")
    assert.ok(toolShort > 0, '工具名短路调用点丢失')
    assert.ok(gate < toolShort, '危险命令门必须在工具名短路之前（否则这三条会先被工具名档放行）')
    const decide = indexSrc.indexOf('const hit = hostApproval.decide(')
    assert.ok(decide > 0)
    assert.ok(gate < decide, '危险命令门必须在路径/项目档判定之前')
    // v1.12.6 第六轮（终审 Minor 3）：`commandText` 超限的保守门**也在同一位置**（门前置）。
    // 它是独立的一条早退分支（不并进 `danger` 计算，好让上面的锚点与第五轮的顺序哨兵一字不动），
    // 所以这里单独钉一次位置：早于工具名短路、也早于路径/项目档判定。
    const tooLong = indexSrc.indexOf('if (dangerCmd.omitted > 0) {')
    assert.ok(tooLong > 0, 'commandText 超长的保守门调用点丢失')
    assert.ok(tooLong > bound, '超长判定必须发生在有界截断之后（要先知道截了多少）')
    assert.ok(tooLong < toolShort, 'commandText 超长的保守门必须在工具名短路之前（否则会被静默放行）')
    assert.ok(tooLong < decide, 'commandText 超长的保守门必须在路径/项目档判定之前')
    // ACP 孪生早退仍在门前（既有两道门行为不变）
    assert.ok(indexSrc.indexOf('if (isAcpTwinApproval(ctxInfo.toolName, ctxInfo.reason)) return next()') < gate,
      'ACP 孪生应当仍是更早的那道早退门')
  })

  // ── v1.12.10：**没有任何载荷豁免**（监听器层）────────────────────────────
  it('监听器层【代价，用户裁定】：现场那条 commit 又会弹一次授权框（正文行以 `- ` 开头）', async () => {
    // 这是用户明确接受的取舍：宁可多弹一次，也不冒「载荷豁免漏掉真命令」的险。
    // v1.12.8（剥载荷）/v1.12.9（掩码豁免）都试图免掉它，结果各留一个静默放行的口子。
    const b = await bootWithBashGranted()
    try {
      const cmd = [
        'git add -A',
        "git commit -q -F - <<'EOF'",
        'feat(grant): 0.7.10 全非法路径不再退化为工具档；补「规则语义（读侧）」文档',
        '',
        '- planGrantWrites 新增 none 出口：用户给了非空路径但全部被丢弃 ⇒',
        '  路径档与工具档都不写，只放行本次（仅显式回传 paths:[] 才落工具档）',
        'EOF',
      ].join('\n')
      const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('v9n', cmd) })
      const r = await approve(b, s, { callId: 'v9n', toolName: 'bash' })
      assert.equal(r.nextCalled, true, '载荷行不再豁免 ⇒ 必须转人工（代价）')
      assert.notEqual(r.res, 'allowed-once', '代价：这条 commit 不再自动放行')
      assert.equal(logRows(b.home).filter((x) => x.action === 'danger-command-block').length, 1,
        '必须留 1 行 danger-command-block（排障要能看到是形状判据拦的）')
    } finally { await b.close() }
  })

  it('监听器层：载荷**之外**的命令照旧一律 next()（EOF 之后 / 同一行的后续命令 / `<<` 之前）', async () => {
    const b = await bootWithBashGranted()
    try {
      for (const cmd of [
        'cat <<EOF > f\nbody\nEOF\nrm -rf /tmp/x',
        "cat <<'EOF' > f && npm publish\nbody\nEOF",
        "rm -rf /tmp/x <<'EOF'\nbody\nEOF",
        'cat <<EOF\nrm -rf /tmp/x',
      ]) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('v9o', cmd) })
        const r = await approve(b, s, { callId: 'v9o', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${JSON.stringify(cmd)} 被静默放行（载荷之外的命令没被扫）`)
        assert.notEqual(r.res, 'allowed-once')
      }
      assert.equal(logRows(b.home).filter((x) => x.action === 'danger-command-block').length, 4,
        '四条都要留痕')
    } finally { await b.close() }
  })

  it('v1.12.10 监听器层：载荷里含真命令的形态 + 两条原阻断都必须 next() 且各留 1 行门名', async () => {
    // 「会话级工具名授权 + 载荷危险命令」这个帧上，任何一条静默放行都是阻断级缺陷。
    const b = await bootWithBashGranted()
    try {
      const cases = [
        "ssh host <<'SH'\nrm -rf /tmp/x\nSH",
        "cat > /tmp/g <<'SH'\nrm -rf /tmp/x\nSH\nsh /tmp/g",
        "cat <<'SH' > /tmp/g; sh /tmp/g\nrm -rf /tmp/x\nSH",
        "cat <<'SH' > >(ssh host)\nrm -rf /tmp/x\nSH",
        'cat() { ssh "$1"; }; cat <<\'SH\'\nrm -rf /tmp/x\nSH',
        "tar --use-compress-program=sh -xf - <<'SH'\nrm -rf /tmp/x\nSH",
        "pwsh -Command - <<'P'\ngit push\nP",
        // 终审 B1：假 heredoc 起始 ⇒ 下一行 `sh` 是真命令，必须拦
        'x=$((n<<sh))\nsh',
        // 终审 B2：载荷行上的反斜杠续行 ⇒ `rm \` + `-rf /tmp/x`，必须拦
        "ssh host <<'SH'\nrm \\\n-rf /tmp/x\nSH",
        // 代价：tag 恰好是 shell 名 ⇒ 终止行按裸解释器判
        "cat <<'bash'\nbody\nbash",
      ]
      for (const cmd of cases) {
        const before = logRows(b.home).filter((x) => x.action === 'danger-command-block').length
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('v9a', cmd) })
        const r = await approve(b, s, { callId: 'v9a', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${JSON.stringify(cmd)} 被静默放行（载荷里的真命令没被扫）`)
        assert.notEqual(r.res, 'allowed-once', `${JSON.stringify(cmd)} 不该走工具名档自动放行`)
        const after = logRows(b.home).filter((x) => x.action === 'danger-command-block').length
        assert.equal(after - before, 1, `${JSON.stringify(cmd)} 必须留 1 行 danger-command-block`)
      }
    } finally { await b.close() }
  })
})

// ════════════════════════════════════════════════════════════════════
describe('既有两道门的行为不被这道门改动', () => {
  it('越权（escalate sandbox）的普通命令照旧被工具名档放行——危险命令门不碰它', async () => {
    const b = await bootWithBashGranted()
    try {
      const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('e1', 'ls /tmp/x') })
      const r = await approve(b, s, { callId: 'e1', toolName: 'bash', reason: 'escalate sandbox to read-write: need write' })
      // 这里只断言**没被新门拦**：越权的普通命令不是危险命令门的职责。
      // v1.12.7 之前这条断言的是 nextCalled===true（那时越权被排除出工具名档）；
      // 用户第三次裁定「工具档不受越权限制」之后，已授权 bash 的越权普通命令必须放行，
      // 而危险命令门在任何档位下都不得把「普通命令」判成命中（下面那条第八轮用例
      // 覆盖反向：危险命令即使在已授权 bash 下一律 next()）。
      assert.equal(logRows(b.home).filter((r2) => r2.action === 'danger-command-block').length, 0,
        '越权的普通命令被危险命令门拦了——那是另一道门的职责')
      assert.equal(r.res, 'allowed-once', 'v1.12.7：越权的普通命令照旧吃工具名档')
      assert.equal(r.nextCalled, false)
    } finally { await b.close() }
  })

  it('ACP 孪生（product_submit + [ACP reason）仍然一档都不判，直接 next()', async () => {
    const b = await bootWithBashGranted()
    try {
      const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: [{ callId: 'a1', name: 'product_submit', arguments: { task: 'x' } }] })
      const r = await approve(b, s, { callId: 'a1', toolName: 'product_submit', reason: '[ACP qoder] permission request' })
      assert.equal(r.nextCalled, true)
      assert.equal(logRows(b.home).filter((r2) => r2.action === 'danger-command-block' || r2.action === 'no-command-text-block').length, 0,
        'ACP 孪生不该被危险命令门碰到（它更早就 return next() 了）')
    } finally { await b.close() }
  })

  // ── v1.12.6 第八轮（终审 B1 欠吃 + B2 名单漏）监听器层 ─────────────────────

  it('第八轮监听器层：欠吃方向 12 条在「已授权 bash」下也一律 next()（不得 allowed-once）', async () => {
    const b = await bootWithBashGranted()
    try {
      const probes = [
        // B1：已登记包装器漏登记真实取值选项
        ['env -P /bin rm -rf /x', 'rm -rf'],
        ['env -P /bin npm publish', 'npm publish'],
        ['xargs -J % rm -rf /x', 'rm -rf'],
        ['xargs -I {} -R 2 rm -rf /x', 'rm -rf'],
        ['xargs -I {} -S 100 rm -rf /x', 'rm -rf'],
        ['chroot -u root /mnt rm -rf /x', 'rm -rf'],
        ['chroot -G staff /mnt rm -rf /x', 'rm -rf'],
        // B2：macOS 同类包装器整类漏登记
        ['arch -x86_64 rm -rf /x', 'rm -rf'],
        ['arch -arm64 git push', 'git push'],
        ['caffeinate -d rm -rf /x', 'rm -rf'],
        ['script -q /dev/null rm -rf /x', 'rm -rf'],
        ['xcrun rm -rf /x', 'rm -rf'],
      ]
      for (const [cmd] of probes) {
        const s = mkSession({ id: 'child-2', parentSession: 'R', toolCalls: bashCall('d1', cmd) })
        const r = await approve(b, s, { callId: 'd1', toolName: 'bash' })
        assert.equal(r.nextCalled, true, `${cmd} 被静默放行了（用户裁决：必须走交互授权）`)
        assert.notEqual(r.res, 'allowed-once', `${cmd} 返回了 allowed-once`)
      }
      const rows = logRows(b.home).filter((r) => r.action === 'danger-command-block')
      assert.equal(rows.length, probes.length, '每条都要留痕（门名 + 那段命令）')
      const pairs = new Set(rows.map((r) => `${r.rule}|${r.segment}`))
      for (const [cmd, want] of probes) {
        assert.ok([...pairs].some((p) => p.startsWith(`${want}|`) && p.includes(cmd.split(' ').slice(-2).join(' '))),
          `${cmd} 的留痕门名/段不对（want ${want}，实测 ${[...pairs].join(' / ')}）`)
      }
      assert.equal(rows.filter((r) => r.action === 'auto-grant').length, 0, '整轮里不该有任何自动放行')
      // 判据层同族但**无害**的形态：这些必须仍然自动放行（不得变成永远弹窗）
      for (const cmd of ['env -P /bin ls', 'xargs -J % ls', 'chroot -u root /mnt ls', 'arch -x86_64 ls', 'caffeinate -d ls', 'script -q /dev/null ls', 'xcrun ls']) {
        const s = mkSession({ id: 'child-3', parentSession: 'R', toolCalls: bashCall('e1', cmd) })
        const r = await approve(b, s, { callId: 'e1', toolName: 'bash' })
        assert.equal(r.nextCalled, false, `${cmd} 是无害形态，不该转交互（假警报）`)
        assert.equal(r.res, 'allowed-once', `${cmd} 应当仍走工具名档自动放行`)
      }
    } finally { await b.close() }
  })
})

// ════════════════════════════════════════════════════════════════════
// v1.12.13（独立终审 3 阻断 / 3 主要 / 8 次要）：行为层三条。
//   ① B1：1.12.11 的「裸 CR 折空格」读法必须保留（`rm␍-rf␍/tmp/x` 真的会执行 rm）；
//   ② M3：**词内引号拼接**（`r"m" -rf /tmp/x`）在 `/bin/sh` 里就是 `rm -rf /tmp/x`（实测
//      `RM_INVOKED argv=[-rf /tmp/x]`），1.12.7/1.12.11/1.12.12 三版全 MISS ⇒ 本版补上；
//   ③ 反过来：去词内引号**不许**凭空造出危险字样（`it's`、`df -h`、`ls -l` 之类仍 MISS）。
describe('v1.12.13 判据层：CR 家族（B1）与词内引号拼接（M3）', () => {
  it('B1：裸 CR / CRLF / 字面 `\\r` 作词间分隔 ⇒ 仍由内容规则命中', () => {
    for (const [cmd, rule] of [
      ['\\trm\r-r\r-f\r/tmp/x', 'rm -rf'], // 字面 `\t` 两字符 + 裸 CR（终审 B1 的最小复现）
      ['\trm\r-r\r-f\r/tmp/x', 'rm -rf'], // 真实 TAB + 裸 CR（走全文层）
      ['rm\r-rf\r/tmp/x', 'rm -rf'],
      ['rm\r\n-rf\r\n/tmp/x', 'text:rm -rf'], // CRLF：CR 折空格、LF 仍是段分隔符（1.12.11 同口径）⇒ 由全文层兜住
      ['rm\\r-rf\\r/tmp/x', 'rm -rf'],
      ['git\rpush origin main', 'git push'],
      ['npm\rpublish', 'npm publish'],
    ]) {
      assert.equal(dangerousCommandMatch(cmd)?.rule, rule, `${JSON.stringify(cmd)} 判定不对（B1 回归）`)
    }
    // 反向：CR 文本里没有危险串就不该弹（新口径的段分隔语义没被改掉）
    for (const cmd of ['echo hi\rworld', 'ls\r-l', 'printf "a\rb"']) {
      assert.equal(dangerousCommandMatch(cmd), null, `${JSON.stringify(cmd)} 误报`)
    }
  })

  it('M3：词内引号拼接的形态 ⇒ HIT（真会执行）', () => {
    for (const cmd of ['r"m" -rf /tmp/x', "r'm' -rf /tmp/x", 'g"it" push origin main',
      'n"pm" publish', 'p"npm" publish', 'sud"o" rm -rf /tmp/x']) {
      assert.notEqual(dangerousCommandMatch(cmd), null, `${JSON.stringify(cmd)} 变 MISS（M3 回归）`)
    }
    // 反向：贴空白的引号原样保留 ⇒ 没有危险串的引号文本仍不弹
    for (const cmd of ["it's a normal message", 'echo "df -h"', "echo 'ls -l'", 'echo "git status"']) {
      assert.equal(dangerousCommandMatch(cmd), null, `${JSON.stringify(cmd)} 误报（M3 扩大了误伤面）`)
    }
  })

  it('v1.12.13 追加·边界：`MAX_DANGER_TEXT_CHARS` 的「恰好等值」—— 262144 走正常扫描，262145 才 command-too-long', async () => {
    // 动机（跨仓纪律）：B 仓同款边界被变异 `>` → `>=` 后 92/92 全绿（边界语义没人看着）。
    // 判据层：截断是 `<=`（恰好等于上限 ⇒ 一个字都不截）；监听器层：只有 `omitted > 0` 才落
    // `command-too-long`。两侧都要有**恰好等值**的用例，否则边界语义可以被人悄悄改掉。
    const tail = '; rm -rf /tmp/x'
    const atLimit = 'a'.repeat(MAX_DANGER_TEXT_CHARS - tail.length) + tail
    const overLimit = 'a'.repeat(MAX_DANGER_TEXT_CHARS + 1 - tail.length) + tail
    assert.equal(atLimit.length, MAX_DANGER_TEXT_CHARS, '前置：恰好等值')
    assert.equal(overLimit.length, MAX_DANGER_TEXT_CHARS + 1, '前置：超一个字')
    assert.deepEqual(boundDangerText(atLimit), { text: atLimit, omitted: 0 }, '恰好等于上限不许截断')
    assert.equal(boundDangerText(overLimit).omitted, 1)
    assert.equal(dangerousCommandMatch(atLimit)?.rule, 'rm -rf', '恰好等值 ⇒ 正常扫描（不是 command-too-long）')

    const b = await bootWithBashGranted()
    try {
      const s1 = mkSession({ id: 'cap-1', parentSession: 'CR', toolCalls: bashCall('CAP1', atLimit) })
      const r1 = await approve(b, s1, { callId: 'CAP1', toolName: 'bash' })
      assert.equal(r1.nextCalled, true, '恰好等值的危险命令必须转交互')
      let blocked = logRows(b.home).filter((r) => r.action === 'danger-command-block')
      assert.equal(blocked.length, 1)
      assert.equal(blocked[0].rule, 'rm -rf', `恰好等值必须走正常扫描，实得 ${blocked[0].rule}`)
      assert.equal(logRows(b.home).filter((r) => r.action === 'danger-text-truncated').length, 0,
        '恰好等值不许留「截断」痕（那就是把边界改成了 >）')

      const s2 = mkSession({ id: 'cap-2', parentSession: 'CR', toolCalls: bashCall('CAP2', overLimit) })
      const r2 = await approve(b, s2, { callId: 'CAP2', toolName: 'bash' })
      assert.equal(r2.nextCalled, true, '超一个字同样必须转交互')
      blocked = logRows(b.home).filter((r) => r.action === 'danger-command-block')
      assert.equal(blocked.length, 2)
      assert.equal(blocked[1].rule, COMMAND_TOO_LONG_RULE, '超一个字才落 command-too-long')
      assert.equal(logRows(b.home).filter((r) => r.action === 'danger-text-truncated').length, 1)
    } finally { await b.close() }
  })

  it('v1.12.13 追加·大小写折叠口径：折叠只用于**程序名比较**，绝不用来切 segment', () => {
    // 跨仓对齐（B 仓被证伪的那条「ẞ 折叠后不折成 ß ⇒ 二者永不互命」）：A 仓**没有**这种断言。
    // 这里按实测把事实钉住，避免以后有人照抄那句错话：
    assert.equal('\u1E9E'.toLowerCase(), '\u00DF', 'ẞ(U+1E9E) 折叠**就是** ß(U+00DF) ⇒ 二者互命')
    assert.equal('\u0130'.toLowerCase().length, 2, 'İ(U+0130) 折叠**会变长**（i + U+0307）⇒ 不能假设长度不变')
    for (const s of ['İ'.repeat(5), 'aİb', 'ß', 'ẞ', 'e\u0301', 'ﬁ', 'ǅ']) {
      assert.equal(typeof s.toLowerCase(), 'string', `${s} 折叠必须有结果`)
    }
    // 折叠不参与切分：命中后回报的 `segment` 必须是**原文**的子串（逐字切出）
    for (const [cmd, rule] of [['RM -RF /tmp/x', 'rm -rf'], ['Sudo RM -rf /tmp/x', 'rm -rf'],
      ['ẞ -rf /tmp/x', null], ['İ -rf /tmp/x', null], ['ß -rf /tmp/x', null], ['ﬁ -rf /tmp/x', null]]) {
      const hit = dangerousCommandMatch(cmd)
      assert.equal(hit?.rule ?? null, rule, `${JSON.stringify(cmd)} 判定不对`)
      if (hit) assert.ok(cmd.includes(hit.segment), `segment 必须从原文切出（${JSON.stringify(hit.segment)}）`)
    }
  })

  it('M3 的边界：只去「两侧都紧邻非空白」的引号（`curl \'a=1&rm -rf\'` 文本不变）', () => {
    // `a=1&rm -rf` 这一段里引号贴空格 ⇒ 不去；判定仍与 1.12.12 一致（全文层兜住）
    assert.equal(dangerousCommandMatch("curl 'a=1&rm -rf'")?.rule, 'text:rm -rf')
    assert.equal(dangerousCommandMatch('echo "never run rm -rf /x by hand"')?.rule, 'text:rm -rf')
  })
})
