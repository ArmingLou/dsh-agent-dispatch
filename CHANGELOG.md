## 1.12.7（2026-10-06）
**三条用户裁定叠加的一版：① 工具名档不再被「沙箱越权」逐请求排除（越权仍不写项目级落盘白名单）；② 弹框「空路径集」必须先二选一（仅本次放行 / 该工具对任意路径放行），不得再静默按工具名档提交；③ `~` 按服务端下发的 home 展开；并接住 product-subagents 0.7.10 的三个增量键（`grantTier` / `grantReason` / `grantDropped`）与 `granted-once-fallback`。**
**未部署、未 commit、未动 `~/.dsh`，也未修改另一个仓库 `dsh-plugin-product-subagents`。**
最终基线：`node --test test/*.test.js` → `# tests 593 / # pass 593 / # fail 0 / # skipped 0 / # cancelled 0 / # todo 0`，退出码 0；
`node verify.mjs` → `OK: @kiligzzz/dsh-agent-dispatch v1.12.7 一致性链（无内置 Agent）+ 11 工具 + / 命令`，退出码 0。
（本轮接手时的基线是 `# tests 554 / # pass 554`——前一线程只改完了产品代码，测试断言未同步；CI 的 `MIN_TESTS` 由 551 同步抬到 **578**，裁定 A/B 落地后 **590**，终审收口轮（M1 + Minor 1/5/7 三条新用例）后 **593**。）

### 裁定本体（用户口径，不得自行更改）

> 工具名档不再被「沙箱越权」排除：reason 以 `escalate sandbox to` 开头的请求，若该根会话已有该
> 工具名的工具档，则直接自动放行（`allowed-once` 短路），不再弹窗。`isDisallowedAutoGrant` 要拆开：
> 越权不再算「禁用工具档」，ACP 孪生仍然算。越权仍不写「项目级落盘白名单」。

- **语义**：越权 + 工具档命中 = `{cwd: 工作区, tools:['bash']}` ⇒ 同一主代理会话内该工具对
  **任意路径**（含工作区外）直接放行。唯一保留的越权约束是**不落盘项目档**（跨会话不生效）。
- **为什么改（用户本机实测）**：几乎只有「沙箱越权」这一类请求会产生授权弹框（子代理审批被宿主
  钉死、auto-review/hooks 未启用）。1.12.5/1.12.6 把越权从工具名档里逐请求排除 ⇒ 用户点过一次
  「本会话总是允许该工具」写下的授权**永远读不到**，工具名档在实战中形同失效。
- **写入侧从来没被越权守卫关掉**（`pushPendingContext` 在排除门之前就已暂存上下文；越权请求点
  「本会话允许」且路径清空时走的 `addToolGrant` 分支里没有任何 `isSandboxEscalation` 判据）
  ⇒ 本次只动**读取侧**，让写进 `#toolGrants` 的那条授权真正被消费。

### 改动点

| 文件:行 | 改动 |
| --- | --- |
| `lib/host-approval.js:411` | `isDisallowedAutoGrant` 拆开：改前 `return isSandboxEscalation(reason) \|\| isAcpTwinApproval(toolName, reason)` → 改后 `return isAcpTwinApproval(toolName, reason)`（越权不再算禁档，孪生仍算）。 |
| `index.js:501` | 焊点解耦：改前调用行传 `disallowToolGrant, sessionOnly: disallowToolGrant` → 改后 `const sessionOnly = isSandboxEscalation(ctxInfo.reason)` 单独一条，调用行改成 `disallowToolGrant, sessionOnly` 两个独立实参。**这是本次改动的安全关键点**：只拆判据不解耦，越权会连项目档一起放开（跨会话静默提权，用户明确否决过）。 |
| `index.js:2318,2345` | `/agent-api/active` 的两处 `permPending(...)` 都补传 `os.homedir()`；`/agent-api/host-approval-context` 的兜底上下文与 `resolveApprovalContext` 的返回值都新增 `home`。 |
| `lib/dispatch.js:455` | `serializePermissionPending(value, home = null)` 签名扩展，逐行透出 `home`（老客户端忽略未知字段）。ACP（琥珀）通道没有别的通道能拿到 home——产品侧 pending 事件不透传 cwd/home，浏览器半既不能 `require('os')` 也拿不到 `process.env.HOME`。 |
| `lib/client.js:800,853,875` | `resolveAgainstCwd(rel, cwd, home)` / `absolutizeDirs(paths, cwd, home)` / `dirsOfPaths(paths, cwd, home)` 三处加 `home`；只展开 `~` 与 `~/…`（`~user/…` 是别人的 home，不猜）；拿不到 home ⇒ 返回 null ⇒ 调用方原样保留 + 不默认勾选 + 就地警示。 |
| `lib/client.js:821-822` | **本轮补漏（前一线程半成品里的真实缺陷）**：`~` 展开被 `if (!base \|\| !relPath) return null;` 里的 `!base`（cwd 缺失）连带否掉。琥珀通道恰好是「有 home、没有 cwd」（产品侧不透传 cwd ⇒ `amberCwd` 恒 null）⇒ 那条通道的 `~/.ssh` 候选**永远拼不出来**，`serializePermissionPending` 多带的 home 白带（客户端自己的注释当时已把这条写成「也能展开」，属自述失真）。改后拆成 `if (!relPath) return null; if (!base && !tildeBase) return null;`——`~` 的基准是 home、与 cwd 无关；相对路径仍必须要求 cwd。 |

### 客户端文案（面板必须说实话）

- 越权 + **一行路径都不填**时的提示：改前「一条都没勾 ⇒ 只写工具名档；但沙箱越权不走工具名档
  （读取侧按请求逐条排除），这条请求下次仍会询问」→ 改后如实说明「本次只记住工具名（<key>）：
  **本会话内该工具对任意路径放行（含工作区外）**；危险命令（rm -rf / git push / npm publish）
  仍会每次询问；沙箱越权不写落盘白名单 ⇒ 换会话仍会询问」。解析不出工具名时另有分支（「什么都
  不会记住，等于仅放行一次」）。
- 蓝球「记住类」按钮：`toolTierApplies` 去掉 `&& !escalation`（改前在按钮上写「(路径)」、tooltip 里
  说「工具名档对本条不生效」＝面板说谎）；越权 tooltip 现在与普通请求同档，并额外点明「不写落盘白名单」。
- `unresolvedNote`：删掉「`~` 不展开」「服务端也不展开」这类已失效表述，改为「只展开 `~` 与 `~/…`
  （`~user/…` 不展开）」/「本次没拿到服务端下发的 home，`~` 无法展开」两种如实口径。

### 裁定 A（用户第四次裁定）：路径弹框「空路径集」必须先二选一

> 路径编辑的窗口，如果没有勾选任何路径 或者 删除了所有路径、或者所有路径都非法格式。点确认时，
> 需要弹出选择提示 是 本次允许 还是 该工具对任意路径都将放行。后者才是相当于进入 tools 字段，
> 进入 会话档或落盘档。前者只相当于允许一次。

- **改前为什么是缺陷**：三种「空」入口（一行都没勾 / 行被删光 / 留下的行全部非法）都让「确认」变成
  一次语义不明的提交，历史上它**等于按工具名档提交**——把授权从「这几个目录」静默放大成「该工具任意
  路径（含工作区外）」。用户点「确认」时的心智是「就这几个目录」，不是「整个工具」。
- **改后**：确认键一律先走 `openSecondLevel()`，二级层只有两条路：
  · 「仅本次放行」⇒ `{paths: null, mode:'once'}`：**一条规则都不写**（不写路径档、不写工具档、不落盘）；
  · 「该工具对任意路径都将放行」⇒ `{paths: [], mode:'tools'}`：进 `tools` 字段，并**明说**是会话档还是落盘档。
- **为什么「仅本次」回 `null` 而不是空数组**：空数组在服务端的语义恰好是「只写工具名档」（用户明确
  否掉的那一档）；而回传那批**非法**路径会落到产品侧 `planGrantWrites` 的 `mode:'none'` 拒写出口——
  那是防「误给非法路径」的 fail-closed 兜底，不该被当正常出口来依赖。
- **取消/关闭二级 ⇒ 什么都没决定**：不提交、不写规则、不默认任何一档（Esc 只关二级回一级，不关整个弹框）。
- **通道接线**：
  · 宿主（蓝球）通道「仅本次」⇒ **不发 POST**、`item.answer('allowed-once')`、条目收起、返回 `'allowed-once'`；
    「任意路径」⇒ POST `paths: []` + `toolName`（改前只在 `scope==='session'` 带 toolName ⇒ 工具名档缺 key 会 400）；
  · 琥珀（ACP）通道「仅本次」⇒ `sendDecision(a, 'allow-once', '仅本次放行')`（**不传第四参**）；
    「任意路径」⇒ `sendDecision(a, answer, label, [])`（产品侧据此进 `mode:'tools'`）。
- **视觉**：二级层复用既有 palette（主色 `#e8a33d`、白底、既有遮罩黑 `rgba(0,0,0,.35)`、既有 shadow token），
  **不新增任何色值**；`verify.mjs` 加了一条「二级 CSS 段里出现的色值必须在允许集内」的守卫。
- **解析不出工具名时**：「任意路径」按钮 `disabled = true`（工具名档没有可写的键），但**不藏起来**
  （藏起来用户会以为是自己点错了），并在说明里写清原因。

### 裁定 B（用户口径）：接住 product-subagents 0.7.10 的三个增量键
对方的改动（**只读核对，本仓未改对方仓库**）：`permission-resolved` 新增 `grantTier`（含新语义 `'none'`）、
`grantReason`、`grantDropped:[{reason,value}]`，并新增 outcome 取值 `granted-once-fallback`。

- **① 有没有穷举**：本仓 `lib/dispatch.js` 对 outcome 的处理是**白名单+兜底**，且白名单 v1.9.0 起就含
  `granted-once-fallback` ⇒ 不需要扩集合；未知 outcome 走 `已结束(<outcome>)`，不空白、不报错（已有用例覆盖）。
- **② `grantTier === 'none'` 的展示**：`grantTier:'none'` = 用户声明的路径一条都没通过校验 ⇒ 路径档与工具档
  **都不写**、只放行本次。改后面板/注入文本追加「**没有记住**：<grantReason>（<逐条 reason: value>）
  （下次同类请求仍会询问；本条**没有**进入工具名档）」，并写一行 `perm-resolved` 留痕
  （`grantTier:'none'` + `grantReason` + `grantDropped` 前 20 条 + `droppedCount`）——这一行是回答
  「上次点了允许为什么还问」的唯一现场证据。
- **③ 老对端兼容**：0.7.9 及以前不带这三个键 ⇒ `grantDropped` 退化成 `[]`、`noMemory` 恒空，
  label 与注入文本**逐字不变**，也不产生留痕行（有专门的兼容用例，四种 outcome 全覆盖）。
- **边界**：`grantTier:'none'` 只对「成功放行」的 outcome 生效（`ok` 白名单内的四种）；
  `rejected` 之类的失败结局不会被反过来说成「已放行但没记住」。

### 被改写 / 转红的既有断言（逐条：文件:行 + 改前 → 改后 + 理由）

| 文件:行（改后） | 改前原文 | 改后原文 | 理由 |
| --- | --- | --- | --- |
| `test/tool-grant-session.test.js:81` | `it('沙箱越权 → 不允许直放')` / `isDisallowedAutoGrant('bash', 'escalate sandbox to read-write: need write') === true` | `it('沙箱越权 → **允许**直放（v1.12.7 拆开判据…）')` / `=== false` | 判据本体反转。 |
| `test/tool-grant-session.test.js:177` | `it('沙箱越权 → isDisallowedAutoGrant 返回 true')` / `=== true` | `=== false` + 补断言 `isSandboxEscalation(...) === true` | 判据反转；同时钉住「越权识别本身还在」（它只剩 sessionOnly 用途）。 |
| `test/tool-grant-session.test.js:716-726` | `CLOSURE_NAMES` 无 `isSandboxEscalation` | 补登记 `isSandboxEscalation`（含 `:752` 注入表） | handler 体新增了第二个判据调用点；漏登记 ⇒ ReferenceError 被 handler 的 try/catch 吞成 `next()` ⇒ ②⑧⑨⑫ **一起假红**（本轮实测正是这个症状，看着像判定逻辑坏了）。 |
| `test/tool-grant-session.test.js:814` | `it('② 已授权 bash + 越权 reason（…）→ next()，不放行')` / `nextCalled === true` | `it('② … → allowed-once（v1.12.7 工具档不再排除越权）')` / `result === 'allowed-once'`、`nextCalled === false` | 语义反转。 |
| `test/tool-grant-session.test.js:940` | `it('⑨ 差分对照：…只有 reason 越权与否决定放行')` / `esc.nextCalled === true` | `it('⑨ 差分对照（v1.12.7 反转）：…**都**吃工具名档…')` / `esc.result === 'allowed-once'` | 差分维度从「reason 越权与否」搬到「项目档 sessionOnly / 危险命令门」。 |
| `test/host-approval-endpoint.test.js:276` | `describe('沙箱越权：工具名档不适用、路径级记忆重新生效（v1.12.5 用户裁定）')` | `describe('沙箱越权：工具名档**适用**、路径级记忆仍生效、落盘项目档仍不适用（v1.12.7 第三次裁定）')` | describe 名与语义一致。 |
| `test/host-approval-endpoint.test.js:303` | `assert.equal(escRow.scope, 'session', '越权的放行被工具名档解释了——用户裁定工具名档不适用于越权')` | `assert.equal(escRow.scope, 'session-tool', 'v1.12.7 用户裁定「工具档不受越权限制」…')` | 工具档排在路径档之前 ⇒ 留痕档位变了。 |
| `test/host-approval-endpoint.test.js:305-309` | `// ③ 换一条没记过的路径的越权 → 仍然弹窗…` / `fresh.nextCalled === true`、`fresh.res !== 'allowed-once'` | `fresh.res === 'allowed-once'`、`nextCalled === false`、留痕 `session-tool` | 语义本体：工具档 = 该工具**任意路径**（含工作区外）。 |
| `test/host-approval-endpoint.test.js:344` | `assert.equal(escOther.nextCalled, true, '越权吃了补出来的工具名授权')` | `assert.equal(escOther.res, 'allowed-once', 'v1.12.7：越权必须也吃补出来的工具名授权')` | 同上（补出的工具名同样算）。 |
| `test/host-approval-endpoint.test.js:591` | `// 点一次会话档后…`（POST 不带 paths ⇒ 同时写工具名档+路径档）→ `hitRow.scope === 'session'` | 改用**声明目录**形态（契约「paths 与 tools 互斥」⇒ 只写路径档），断言不变 | M1 的目录粒度必须继续测路径档；越权现在会先被工具档短路，不改夹具就测不到路径档。 |
| `test/host-approval-endpoint.test.js:857` | `it('越权 + 删空声明 ⇒ 只写工具名档，但读取侧仍不走那一档（不变量①）')` / `nextCalled === true` | `it('… 读取侧**现在会消费**它（v1.12.7 不变量①反转）')` / `allowed-once` + 新增「换任意路径也放行」与「未授权工具仍弹」两条断言 | 语义反转 + 防外溢。 |
| `test/grant-dialog.test.js:458-479` | 测试名「…（越权不落盘、不走工具名档）」/ 哨兵 `/不走工具名档/` | 测试名「…（越权不落盘、但**吃**工具名档）」/ 哨兵 `/本会话内该工具对任意路径放行（含工作区外）/` + `/危险命令…仍会每次询问/` + `/不写落盘白名单/` + 反向哨兵 `assert.doesNotMatch(/不走工具名档/)` | 文案哨兵随真实行为反转；旧说法不得回来。 |
| `test/grant-dialog.test.js:643` | `assert.match(warns[0].textContent, /不展开/, '`~` 的降级原因要写清')` | `/没拿到服务端下发的 home/` + `/`~` 无法展开/` + `assert.doesNotMatch(/服务端也不展开/)` | 「`~` 不展开」现在是假话；降级原因改成「拿不到 home」。 |
| `test/grant-dialog.test.js:1010` | `? absolutizeDirs(p.suggestedDirs, amberCwd)[\s\S]{0,80}: dirsOfPaths(p.paths, amberCwd)` | `…, amberCwd, amberHome)` + 新增两条接线断言（`amberHome` 取值、`home: amberHome` 传入弹框） | ACP 通道的 home 接线必须被钉住，否则整条链路静默失效。 |
| `test/invariants-1-12-6.test.js:6-9` | 头注释①「不吃工具名档、不吃落盘项目档」 | 「**吃**工具名档与落盘会话路径档、**不吃**落盘项目档」 | 汇总守卫的描述与语义一致。 |
| `test/invariants-1-12-6.test.js:130` | `it('判据侧：越权只关工具名档，且与 ACP 孪生同源不同档')` / `isDisallowedAutoGrant('bash', ESC) === true` | `it('判据侧（v1.12.7 拆开）：越权**不再**关工具名档…')` / `=== false` + `isDisallowedAutoGrant('product_submit', '[ACP qoder] x') === true` | 判据反转；孪生仍必须被排。 |
| `test/dangerous-command-gate.test.js:1320` | `it('越权（escalate sandbox）仍然只走会话路径档——普通命令照旧放行')` / `r.nextCalled === true` | `it('越权…的普通命令照旧被工具名档放行——危险命令门不碰它')` / `r.res === 'allowed-once'`（`danger-command-block` 计数为 0 的断言保留） | 已授权 bash 的越权**普通**命令现在放行；这道门只负责危险命令。 |
| `verify.mjs:851` | `if (!ha.isDisallowedAutoGrant('bash', 'escalate sandbox to read-write: x')) throw 'v1.12.1: isDisallowedAutoGrant 不拦截沙箱越权'` | `if (ha.isDisallowedAutoGrant('bash', 'escalate sandbox to read-write: x')) throw 'v1.12.7: …又把沙箱越权算成「不得用工具名档」…'` | 改成**反向断言**而非删除：判据改回去就是裁定的原样复发。 |

**第二轮（裁定 A/B 落地）新增的改写**——这一轮全部由「空路径集 ⇒ 先二选一」引起：

| 文件:行（改后） | 改前原文 | 改后原文 | 理由 |
| --- | --- | --- | --- |
| `test/grant-dialog.test.js:829` | `it('两组都清空 ⇒ 发出 paths: []（＝只要工具名档）')` / `assert.deepEqual(d, { paths: [] })` | `it('两组都清空 ⇒ 先弹二级选择；选「仅本次」⇒ paths:null/mode:once，选「任意路径」⇒ paths:[]/mode:tools')`，两种清空方式 × 两种二级选择四条断言 | 裁定 A 的语义本体：空集不再等于工具名档。 |
| `test/grant-dialog.test.js:778` | `不变量⑦` 尾部 `assert.deepEqual(await p, { paths: [] }, '没勾选的非绝对路径一条都不许发出去')` | 改为「确认先进二级」+ 选「仅本次」⇒ `{ paths: null, mode: 'once' }` | 同上；「不许发出去」的**意图**保留（`paths:null` 比空数组更彻底）。这条用例点确认后 Promise 永不决议 ⇒ 曾是**整文件连锁假红**的源头（node:test 在 pending promise 后放弃同文件后续用例，U3/U5 纯源码断言也一起变红）。 |
| `test/grant-dialog.test.js:1006` | `assert.match(body, /finish\(\{ paths: collect\(\) \}\)/)` | `assert.match(body, /const picked = collect\(\);[\s\S]{0,200}if \(picked\.length > 0\) \{ finish\(\{ paths: picked, mode: "paths" \}\); return; \}/)` + 新增 `/btnOk\.addEventListener\("click", \(ev\) => \{ ev\.stopPropagation\(\); openSecondLevel\(\); \}\)/` | 「确认载荷只来自勾选行」这条**源码级**哨兵必须跟上新形状；新增那条保证确认键不许绕过二级。 |
| `test/grant-dialog.test.js:1140` | `it('删空确认 ⇒ paths:[] 原样发出（契约：空数组＝只要工具名档）')` / `assert.deepEqual(r.posts[0].payload.paths, [])` | `it('二级选「仅本次放行」⇒ 零 POST、本次放行、条目收起（一条规则都不写）')` / `assert.deepEqual(r.posts, [])`、`assert.deepEqual(r.answers, ['allowed-once'])` | 宿主通道的旧契约（空数组=工具名档）被裁定 A 取代；「仅本次」在**这条通道上等于不发 POST**。 |
| `test/grant-dialog.test.js:1147` | 项目档用例的弹框桩返回 `{ paths: ['/tmp/proj'] }`（无 mode） | 返回 `{ paths: ['/tmp/proj'], mode: 'paths' }` + 新增 `toolTierDisk === false` 断言 | 契约多了 `mode` 键；顺带钉住「宿主通道没有落盘工具名档」这一事实。 |
| `test/grant-dialog.test.js:1220` | 琥珀源码接线正则 `\)\.then\(\(d\) => \{\s*if \(!d\) return;\s*sendDecision\(a, answer, label, d\.paths\);` | 放宽为 `[\s\S]{0,700}` 跨越新的 `mode==='once'` 分支，并新增两条断言（`if (d.mode === "once") { sendDecision(a, "allow-once", "仅本次放行"); return; }`、`toolTierDisk: grant.projectTier === true`） | 接线多了一个分支，旧正则会把正确实现判成失败；新断言把分支本体钉住。 |
| `test/grant-dialog.test.js:526,639,671,700,733,750,1159` | 六处 `deepEqual(await p, {paths: [...]})` / 桩返回 `{paths: [...]}` | 统一补 `mode: 'paths'` | 解析形状新增 `mode` 键（契约扩展，不是行为变化）。 |
| `verify.mjs:1187` | `const hintStart = clientV7.indexOf('hint.textContent = o.escalation')` + 900 字窗口内找 `任意路径放行（含工作区外）/危险命令/不写落盘白名单` | 锚点改为 `const toolTierLine = "「该工具对任意路径都将放行」= 只记住工具名"`（一级提示与二级选项共用这段说明） | 锚点随文案改写而失效 ⇒ verify 报「越权分支丢失」；改后任一处的后果说明说谎都会被抓住。 |

（第一轮表共 17 行、16 条既有用例断言 + 1 条测试夹具登记项；另有 1 条 `verify.mjs` 断言改写。基线里实际转红的
用例是 16 条，其中 4 条是夹具漏登记导致的**假红**，登记后自动转绿。第二轮表共 8 行，覆盖 1 条源码级哨兵、
3 条行为用例改写、6 处载荷形状补键（同一行）与 1 处 `verify.mjs` 锚点修正。）

### 新增不变式用例（每条都做过「改回旧行为 ⇒ 转红 ⇒ 逐字节恢复」实验）

- `test/invariants-1-12-7.test.js`（新增，**20 条**）：
  ① 越权 + 工具档命中 ⇒ 不弹、`scope='session-tool'`（含「换任意路径也放行」）；
  ② 越权 + 工具档未命中 ⇒ 仍弹（三条：无授权 / 别的根会话键 / 别的工具名——防授权放大与跨键泄漏）；
  ③ 危险命令 + 工具档命中 ⇒ 仍弹（5 条命令 × 越权/非越权两种 reason）+ 执行类无正文门 + 源码级三门顺序哨兵；
  ④ ACP 孪生 + 工具档命中 ⇒ 仍 `next()` + 早退门位置 + 判据侧纯函数；
  ⑤ 越权授权仍不落项目档（`projectSuppressed` + `allowlist.json` 不创建 + **换会话仍要问** + **读取侧：已落盘的项目档不得替越权放行** + 非越权对照仍能落盘复用 + 工具档优先于项目档的反向哨兵）；
  ⑥⑦ 的纯函数层（`~`/`~/…` 展开、`~user/…` 不展开、拿不到 home 返回 null）。
- `test/grant-dialog.test.js` 新增 `v1.12.7 不变量⑥⑦` 四条（弹框层）：`~` 展开后**恢复默认勾选**、
  提示消失、并随确认发出；cwd 缺失也展开（对照：相对路径仍降级）；拿不到 home 原样 + 不勾选 + 警示 + 不发出；
  `~user/…` 走同一条降级。
- `verify.mjs` 新增 `v1.12.7` 断言块（不占用例条数）：判据拆开、两档解耦（含源码级焊点反向断言 + `decide` 三档真值）、
  三门位置、`home` 全链路（`resolveApprovalContext` → 两处 `permPending` 调用点 → `serializePermissionPending` → 客户端三处）、
  以及「旧假话不得回来」的可执行源码（去注释）反向断言。

**第二轮（裁定 A/B）新增用例：**

- `test/grant-dialog.test.js` 二级选择 5 条（新增）：空集两条路（×两种清空方式）的载荷形状；取消 / Esc / 点二级遮罩
  ⇒ 二级关、**一级还在**、Promise 未决议（且随后改勾一行仍能正常走完）；后果文案哨兵（任意路径/含工作区外/
  危险命令仍每次询问/落盘与否，含「落盘档」与「宿主项目档提示填目录」两个变体）；解析不出工具名 ⇒
  「任意路径」`disabled===true` 且给出原因；全非法行 ⇒ 走同一条路且「仅本次」不回传那批非法路径。
- `test/grant-dialog.test.js` 通道接线 6 条（新增/改写）：宿主「仅本次」零 POST；宿主「任意路径」会话档
  `paths:[]+toolName`；宿主「任意路径」项目档也带 `toolName`；**全链路**（真弹框驱动真 handler）两条路
  各发什么；琥珀接线**行为**测试（从真源码抠出 `.then((d) => {…})` 回调、注入桩 `sendDecision`，
  断言实参**个数**——`allow-once` 必须只有三个实参 ⇒ 产品侧不写档）。
- `test/permission-pending.test.js` 裁定 B 5 条（新增）：`grantTier:'none'` 的「没有记住」展示 + 逐条
  reason/value + 不得说成已进工具名档 + 留痕行（`grantTier/grantReason/grantDropped/droppedCount`）；
  `grantDropped` 缺失/脏载荷兜底；>8 条只列前 8 条 + `…共 N 条`；老对端（无三键）四种 outcome 逐字兼容；
  非成功结局不得反过来说「已放行但没记住」。
- `verify.mjs` 新增 v1.12.7-6/-7 断言块（不占用例条数）：二级选择存在性与三值载荷、`paths:null` 反向断言
  （不得写成空数组）、Esc 先判二级、「任意路径」禁用、**二级 CSS 不得引入新色值**（允许集守卫）、
  两条通道的「仅本次/任意路径」接线与 `toolTierDisk` 透传、以及 `grantTier:'none'` 展示与留痕的源码级守卫。

### 终审收口轮（1 Major + 4 Minor；改动面按终审裁定收窄）

**Major M1（纵深防御；现网不可触发）——端点上 `paths:null` 与「未给 paths 键」被混同。**
终审真实端点探针：
`POST /agent-api/host-approval-rule {scope:'session',sessionId:'S2',callId:'n1',toolName:'read',paths:null}`
⇒ `200 {"ok":true,"written":true,"scope":"session","paths":["/etc/passwd"],"toolName":"read","count":1}`，
随后同工具任意路径请求被 `allowed-once` 放行。根因：`validateDeclaredPaths` 的
`const given = Array.isArray(raw)`（`lib/host-approval.js:127`）把 `null` 判成 `given=false`
⇒ 落进 `useDeclared=false` 的 legacy 分支，**同时写工具名档与路径档**——语义与客户端
「仅本次放行」的 `{paths:null,mode:'once'}` 正好相反。
修法（[index.js:2136-2168](index.js)）：按**键是否存在**判（`Object.prototype.hasOwnProperty.call(body,'paths')`），
键在且值为 `null` ⇒ **不写任何档**，回 `200 {ok:true,written:false,scope,paths:null,toolName,rootSessionId,reason}`，
并留痕 `action:'rule-none-declared-null'`；**键不存在时行为逐字不变**（legacy 兼容）。
为什么选 200+`written:false` 而不是 400：「不写任何规则」是一个合法且明确的用户意图，
同一响应包络里把 `written` 如实置 false 最贴近既有契约（客户端拿到 200 即继续走「仅本次」，
不会多打一条「写规则失败」的告警）。
诚实边界：**现网不可能触发**——v1.12.7 的客户端「仅本次放行」根本不发 POST
（宿主通道零 POST、琥珀通道 `sendDecision(allow-once)` 不带 paths）；这条纯属纵深防御，
防的是「未来某个客户端/脚本真按 `mode:'once'` 发一次 POST」。

**Minor 1（终审变异 X2 暴露的守卫缺口）**：`verify.mjs:1166` 的 needle 只钉了
`if (!h || !ABS_PATH_RE.test(h) || ROOT_LIKE_RE.test(h)) return null;` 的**字面存在**，
没钉 `h` 的**来源唯一性** ⇒ 把来源行改成 `String(home || "").trim() || String(cwd || "").trim()`
（拿不到 home 就用 cwd 猜）时，`test/grant-dialog.test.js` 3 条转红、`node verify.mjs` 仍 exit 0。
已在 `verify.mjs` 补**反向断言**：`^\s*const h = String\(home…` 那一行不得出现 `cwd`，
且必须仍是 `String(home || "")`（只认服务端下发的 home）。复跑 X2 后 verify 也转红。

**Minor 5**：`lib/client.js` 的 Esc 注释描述了一个**不存在**的监听器（说「二级自己 register 在
document 上的监听排在后面」），而 `openSecondLevel()` 里没有任何 `document.addEventListener('keydown',…)`。
行为是对的（Esc 只关二级），只是注释误导 ⇒ 改成与实现一致：「二级层没有自己的 keydown 监听，
全框只有这一个 document 级监听 ⇒ 必须在它里面先分流」。

**Minor 7**：`grantDropped` 的 `value` 是**用户输入原文**（`lib/host-approval.js:132` 对字符串条目
保留原文作 label），条数已限（8/20）但单条长度无上限 ⇒ 粘贴超长串会让 `dispatches.jsonl` 单行膨胀。
已在 `lib/dispatch.js` 对 `value`/`reason` 各截 **120** 字符 + 可辨识标记 `…[截断]`，
并在截断时给留痕行加 `droppedClipped:true` / `droppedClipLimit:120`（面板文本与落盘行两处都截）。

**本轮被改写的既有断言（`verify.mjs` 两条，随代码同步）**：

| 文件:行 | 改前原文 | 改后原文 | 理由 |
| --- | --- | --- | --- |
| `verify.mjs:1287` | `/grantTier: 'none', grantReason: String\(\(info && info\.grantReason\) \|\| ''\)/` | `/grantTier: 'none', grantReason: clipDrop\(\(info && info\.grantReason\) \|\| ''\)/` | Minor 7 把 grantReason 也纳入截断 ⇒ 旧 needle 匹配不到（verify 先转红，等于自证它确实钉着这一行）；同时新增 `DROP_CLIP`/`…[截断]`/`droppedClipped` 三条守卫。 |
| `verify.mjs:1166` | 只断言 `if (!h \|\| !ABS_PATH_RE.test(h) \|\| ROOT_LIKE_RE.test(h)) return null;` 字面存在 | 追加**来源行反向断言**：`const h = String(home…` 不得出现 `cwd`、必须仍是 `String(home \|\| "")` | Minor 1：X2 变异证明「只钉存在」不够。 |

**新增用例（终审收口轮）**：
- `test/host-approval-endpoint.test.js` 新增 describe `v1.12.7 终审 M1：paths:null ⇒ 不写任何档`
  两条：① `paths:null` ⇒ `written:false`、`allowlist.json` 不被创建（project 档同形）、留痕一行、
  **后续同工具任意路径仍 `next()`**（＝没有工具名档被写下）；② **无 `paths` 键** ⇒ legacy 逐字不变
  （仍写工具档，兄弟子会话路径外请求被 `allowed-once` 放行）。
- `test/permission-pending.test.js` 新增一条：超长 `value`/`grantReason` 必须截断 + 带标记 + 留痕
  `droppedClipped`，且短值不受影响（不出现无谓标记）。

**登记为「已知设计」，不改代码（终审判定，防止后来人当漏口去修）**：
- `~` 展开后的两类**词法放大**：`~/../../etc` ⇒ `/etc`（`..` 可以逃出 home）、`~/id_rsa` ⇒ `/Users/me`
  （文件形态取父目录，与绝对路径 `/Users/me/id_rsa` ⇒ `/Users/me` 同构）。二者与绝对路径
  `/etc/passwd`、`/Users/me/id_rsa` 的历史行为**同构**；且行文本对用户**可见可编辑**、
  推测档默认**不勾选** ⇒ 属展示层事实，不是静默放大。**不要**为它加「禁止 `..`」之类的特判。

**已知遗留（本轮明确不动，下一版再说）**：
- `lib/client.js` 在 `escalation && !callId` 时 tooltip 与按钮标签不一致
  （v1.12.6 同形、本次未改动的那条分支）——只登记，不改代码。

### 变异转红实验（逐条读数 + 两条教训）

**方法**：每个实验先把旧行为**真的放回源码**，跑指定用例文件（必要时连 `node verify.mjs` 一起），
再看退出码与红名单，最后**逐字节恢复**并核对 md5 == 基线 + 无 `MUT-` 标记残留。
脚本：`/tmp/v1127-mutate.mjs`（第一轮 M1–M7）、`/tmp/v1127-mutate2.mjs`（第二轮 M8–M12）。

| # | 靶子（不变式 / 裁定） | 放回的旧行为 | 用例读数 | `verify.mjs` | 恢复 |
| --- | --- | --- | --- | --- | --- |
| M1 | ① 越权 + 工具档命中 ⇒ 不弹、`session-tool` | `isDisallowedAutoGrant` 把越权也算禁档 | `invariants-1-12-7` 转红（exit 1） | 红 | md5 一致 ✓ |
| M2 | ② 越权 + 工具档未命中 ⇒ 仍弹 | 工具名短路不看 `toolGrantCovers` | 同上转红 | 红 | ✓ |
| M3 | ③ 危险命令 + 工具档命中 ⇒ 仍弹 | 危险命令门不拦 | `invariants-1-12-7` + `dangerous-command-gate` 转红 | 红 | ✓ |
| M4 | ④ ACP 孪生 + 工具档命中 ⇒ 仍 `next()` | 拆掉孪生早退门 | `invariants-1-12-7` 转红 | 红 | ✓ |
| M5 | ⑤ 越权授权仍不落项目档 | `sessionOnly = false` | **初版用例未转红**（见教训 1）⇒ 补「读取侧：已落盘项目档不得替越权放行」后转红 | 红 | ✓ |
| M6 | ⑥ `~/xxx` 按 home 展开 | `~` 一律不展开 | `invariants-1-12-7` + `grant-dialog` 转红 | 红 | ✓ |
| M7 | ⑦ 拿不到 home ⇒ 原样 + 不勾选 | 拿不到 home 时猜一个基准 | 同上转红 | 红 | ✓ |
| M8 | 裁定 A：「仅本次放行」= `paths:null` | 回传空数组（⇒ 服务端只写工具名档） | `grant-dialog`：74 用例中 5 红 | 红 | ✓ |
| M9 | 裁定 A：确认键必须先走二级 | 确认键绕过二级、空集直接提交成工具名档 | `grant-dialog`：8 红（整文件连锁） | **首轮未拦住**（见教训 2）⇒ 补守卫后红 | ✓ |
| M10 | 裁定 A：宿主通道「仅本次」= 零 POST | 落进 POST 分支 | `grant-dialog`：2 红 | 红 | ✓ |
| M11 | 裁定 A：琥珀通道「仅本次」不带 paths | 带上空数组（产品侧按 `mode:tools`） | `grant-dialog`：2 红 | 红 | ✓ |
| M12 | 裁定 B：`grantTier:'none'` ⇒ 说「没有记住」+ 留痕 | 静默（不追加说明） | `permission-pending`：17 用例中 2 红 | 红 | ✓ |
| X2（终审原样变异） | ⑥ `~` 的展开基准只能是 home | 基准行追加 `\|\| String(cwd \|\| "")`（拿不到 home 用 cwd 猜） | `grant-dialog`：74 用例中 3 红 | **终审当时 exit 0**（缺口）⇒ 本轮补反向断言后**红** | ✓ |
| M13 | 终审 M1：端点 `paths:null` ⇒ 不写任何档 | 拆掉 `hasOwnProperty(body,'paths') && body.paths === null` 门 | `host-approval-endpoint`：42 用例中 1 红（新用例） | 红 | ✓ |
| M14 | 终审 Minor 7：`grantDropped` 必须截断 | 去掉 `slice(0, 120)`（原文落盘） | `permission-pending`：18 用例中 1 红（新用例） | 红 | ✓ |

**教训 1（M5 初版未转红）**：写侧「越权不落项目档」其实由 `sandboxEscalated` 另一条判据保护，
与 `sessionOnly` 无关 ⇒ 只测写侧的用例**没有牙**。补上**读取侧**（已落盘的旧项目档不得替越权放行）
之后 M5 才转红——这正是「转红实验本身也要被检验」的意义。

**教训 3（X2：终审发现同一类缺口）**：和教训 2 同型——`verify.mjs` 钉了「守卫行长什么样」，却没钉「基准值只能来自哪里」。
这类缺口（**来源唯一性**）只能靠变异发现：本轮两个守卫缺口（M9 确认键入口、X2 的 home 来源）都是「用例红了而 verify 全绿」。
通用做法：凡「某个值必须来自唯一可信来源」（home、根会话 id、审批上下文）的判据，verify 里都要加一条**来源行反向断言**，
而不只是断言那行存在。

**教训 2（M9 用例红了、verify 没拦住）**：`verify.mjs` 当时只钉了二级层的存在与载荷，没钉
「确认键**唯一**地走 `openSecondLevel()`」⇒ 把确认键改回绕过二级时 8 条用例红、verify 仍全绿。
已在 `verify.mjs` 补上该守卫（并加「`paths: []` 只允许出现在 `mode:"tools"` 那一档」），重跑 M9 后
verify 也转红。这条缺口是**实验**发现的，不是读代码发现的。

### `~` 展开（用户裁定第 5 条）

- 服务端在 approval context / `/agent-api/active` 下发 `home`（`os.homedir()`）；客户端用它把 `~/...`
  拼成绝对路径并**恢复默认勾选**（展开不出来才强制关闭 + 就地警示）。
- 与 `normalizeCandidate` / `validateDeclaredPaths` 用的是**同一个** `os.homedir()` ⇒ 客户端预填与
  服务端落盘口径同源。
- `home` 只作预填基准，**不参与任何自动判定**；拿不到时客户端保持旧行为（原样保留 + 不勾选 + 保留警示）。

### 未做 / 未验证（诚实声明）

- **未部署**：没有安装到 `~/.dsh`、没有重启宿主、没有真机点过一次「本会话允许」验证弹框不再出现；
  所有读数都来自桩宿主（`test/agent-api-harness.js` 的假 ctx/webServer/session），没有真实浏览器交互
  （弹框层的断言靠假 DOM 执行真源码，不是真浏览器）。
- **未 commit**、未打 tag、未改 `README*`、未改另一个仓库 `dsh-plugin-product-subagents`。
- **`~` 展开未在真实琥珀通道端到端验证**：ACP 通道的 `cwd` 恒为 null 这一点是从本仓库注释与
  `markPermissionPending` 的记账形态推断的（产品侧不透传 cwd/home），未实机抓一次产品侧 pending 事件核对。
- **`~` 展开的边界保持收窄**：只展开 `~` 与 `~/…`；`~user/…`、`~` 后跟非分隔符的写法一律不展开
  （宁可交给用户手改，也不把授权挪到别的目录）。
- **越权「任意路径」的实际威力未做端到端验证**：用例覆盖到「工具档命中即 `allowed-once`」这一层，
  没有真机跑一次工作区外写入。
- **裁定 A 未在真浏览器里点过**：二级层的行为断言是把 `lib/client.js` 的真源码抠出来在假 DOM 上跑
  （`.ad-grant-2nd` 的渲染/点击/禁用/Esc 都是真的执行路径），但**没有真浏览器交互**，也没有截图核对
  二级层在窄屏下的换行与层级（`z-index:10001` 只做了「大于一级遮罩」的静态判断）。
- **裁定 A 的「仅本次放行」未做真机端到端**：宿主通道断言到「不发 POST + `answer('allowed-once')`」这一层；
  琥珀通道只断言到「`sendDecision` 只收到三个实参」。**没有真机点一次**核对产品侧对 `allow-once` 的
  处理（结论来自对 0.7.10 源码的只读核对：写入逻辑只在 `allow-session`/`allow-always` 分支里）。
- **裁定 B 的 `grantTier:'none'` 没有做成授权球上的「已决议」状态**：授权球上的那一行在
  `permission-resolved` 之后即被摘除（客户端只有「已决策 ✓」然后下一轮轮询消失）。要显示「没记住」
  需要新建「已决议快照」通道（dispatcher 侧 TTL 缓存 + `/agent-api/active` 下发 + 客户端保留行），
  本轮**未做**，等父级裁定是否要；当前展示位是**父会话注入文本 + `perm-resolved` 留痕**。
- **裁定 B 的跨仓端到端未跑**：三键与 `granted-once-fallback` 的形态来自对
  `dsh-plugin-product-subagents` 0.7.10 的只读核对（`lib/permission-rules.js:365 planGrantWrites`、
  `lib/index.js:245 emitResolved`、`lib/index.js:496-497` 两个 tier 开关），**未**真机触发一次
  「声明路径全非法」的产品侧流程来抓真实的 `permission-resolved` 载荷。
- `tar` 冻结包的 md5 只作存档指纹；等值判据以逐文件 md5 + 解包 `diff -r` 零差异为准（见下节「冻结记录」）。

### 冻结记录（自指说明：本文件 `CHANGELOG.md` 不在下表里——写入下表会改变它自己）

- **冻结命令**：`tar -czf /tmp/dsh-agent-dispatch-1.12.7-freeze.tar.gz --exclude=node_modules --exclude=.git -C /Volumes/ssd/Documents/develop/third dsh-agent-dispatch`
- **成员数**：tar 条目 **72**（含目录条目），普通文件 **63**；解包后文件数 **63**（与工作区一致）。
- **字节数**：下表 **62 个受控文件合计 2,811,605 字节**（不含 `CHANGELOG.md` 自身——它大小随时可变，单独列：413,041 字节，
  自指说明见上）；记录写入前那一包的 `tar.gz` 包体 **1,615,461** 字节（最终包体见交付报告）。
- **等值判据（权威）**：逐文件 md5 全表（下表，**62 项** ＝ 全部 63 个文件 − `CHANGELOG.md` 自身）
  + 解包 `diff -r -x node_modules -x .git` **零差异**（`diff` 退出码 0）。
- **tar 包 md5**（**只作存档指纹，不作等值判据**）：记录写入前打的那一包 = `2996e15a1301fbcdba05b820d811a6ea`；
  写入本记录后重打的最终包 md5 见交付报告（重打必然改变 tar 的 md5，因为包里含 `CHANGELOG.md`，
  它的内容刚被这段记录改过）。等值一律以上面两条为准。
- **本次改动涉及文件的 md5**（与冻结时点一致）：

- `.github/workflows/ci.yml`  `13d6209ff78071731945d53725d23500`
- `.gitignore`  `fc9d54f7afb97c0d762a0dc93ec64ff8`
- `.qoder/settings.local.json`  `b0b9282667dcaade2d18528a237cd76d`
- `LICENSE`  `6cc0f1157ee6fec2c6fc4f612fa0bce0`
- `README.en.md`  `aa34e20873f8a77c9beb6e1c01a9577c`
- `README.md`  `ed9bf09567fb14fc0882a116ba1d62aa`
- `cordis.patch.yml`  `6344d499f05d66b13910d41f3310bb09`
- `docs/screenshots/agents.png`  `6a30c4c3fea4b4599c6fc22856f02353`
- `docs/screenshots/fab-done.png`  `f3c73094c4ea09c96884991b5ae0248b`
- `docs/screenshots/fab-idle-1.png`  `28043676b9a6086d267648c75dc9ee33`
- `docs/screenshots/fab-idle-2.png`  `48ab4b13a0dbd5061ebb1238422c7444`
- `docs/screenshots/fab-running.png`  `17efd4ab12a948d6ff0492d525e99c6b`
- `docs/screenshots/history.png`  `d89bfde07f90548ad00a49dbe920181a`
- `docs/screenshots/overview.png`  `6ba0684ec70bfabf3af13440e59be7a5`
- `docs/screenshots/popup-agents-squads.png`  `43994906eb5bc31018eff73ff5226812`
- `docs/screenshots/popup-running.png`  `5435027f217509c88f9efd843a54682c`
- `docs/screenshots/popup-settings.png`  `10697535447b3d3a5a27ac5bda5a385b`
- `docs/screenshots/squads.png`  `acb125e19badaa3d37ef97c5eeac36e4`
- `index.js`  `e469e5e249ae0bb56058b457154bb178`
- `lib/agents.js`  `cc09bf96e6ad363e18b3ee85e10dd509`
- `lib/client.js`  `68d300f461b24f570a6c1cc01a9b662a`
- `lib/defaults.js`  `f29387cda5012a199e9678e17390d81a`
- `lib/dispatch.js`  `6815e7672a1665e8eff4b44babdcfd50`
- `lib/fab-config.js`  `e68aaf76cf31904164b3e7ee97ef842b`
- `lib/health.js`  `7a2d06235e40a61facf742ff8dd8e82a`
- `lib/host-approval.js`  `1837f4120c5ef7a5642721f295e3933d`
- `lib/json-safe.js`  `cb39c2aeb84952a416aa8ae02c9cd43b`
- `lib/roster.js`  `d9ee0131ac9ad2be8ef3e1c4485ca771`
- `lib/skill-import.js`  `05fbcecfdcd795d5f0921de159f6e345`
- `lib/squad-registry.js`  `16efbdc7adbbc655a80aa40766b6d4d4`
- `lib/squads.js`  `03cd42b9a961d4b17e5cd40601756ffb`
- `package.json`  `3f1675823b277230e7a2293503623fc9`
- `test-p1p2-smoke.mjs`  `bb9b72c42f1509e63186153f199a6f31`
- `test/acp-config-fallback.test.js`  `3961d7af0d3e310db4740a0f9c037c48`
- `test/acp-twin.test.js`  `e7bc1a55cb9331e668963525faf4a55e`
- `test/agent-api-catalog.test.js`  `4e8d5c3f8c62e91a6e40f6a9ec93117f`
- `test/agent-api-harness.js`  `7b48c19983cc6244cd44bfd8e448a178`
- `test/childid-continuation.test.js`  `b1ec780a6529fd841dfd27154ecf0916`
- `test/client-form-logic.test.js`  `109e524ef93378bbf0c9b791b963ddc5`
- `test/dangerous-command-gate.test.js`  `20b8b90e0dd1a27945cf3f3676fe61ed`
- `test/dedup.test.js`  `e93881ba9677de3351c54a29a9ebc243`
- `test/fab-panel-layout.test.js`  `378f9de86246e67bf01fa02fb3034882`
- `test/failover-claim-race.test.js`  `735e23e878a2f1e191a766a3aea2570f`
- `test/failover-notify.test.js`  `542597bd87c1cedde09bbe7a3d8fb2f0`
- `test/failover-settlement.test.js`  `c23fe799487e6bde3d198c04a40ca047`
- `test/failover.test.js`  `07030770e5af9067f538a0c4ab99feff`
- `test/grant-dialog.test.js`  `4ff04b5c09ebe24995cc9db0aa7d3d83`
- `test/helpers/failover-host.js`  `f725f9052a4b54cd66c171d6338048c0`
- `test/host-0.2-compat.test.js`  `e2d46d0cebf92864d746434997a9be04`
- `test/host-approval-endpoint.test.js`  `ccd348dc1ad716f2790f94ec6577c1af`
- `test/host-approval.test.js`  `72779f38918a1e163406884105d334c9`
- `test/interrupt-no-failover.test.js`  `bef2189f6bcd2a817f05b7556b744fec`
- `test/invariants-1-12-6.test.js`  `5db7dc9e9fd907e0f893f6a02e1e3bda`
- `test/invariants-1-12-7.test.js`  `2722578e36096fca36aa9e1afdd33983`
- `test/perm-fab-jump.test.js`  `ceb1e12feae9a0b23efecbbc17f0c412`
- `test/permission-pending.test.js`  `12bac0971db92d15a264f427a7ee9843`
- `test/plugin-diagnostic-log.test.js`  `cda1a98981d674b32111ca808765a77b`
- `test/roster-section.test.js`  `1553c426468cd1b82ad425a6f7a542f0`
- `test/route-validation.test.js`  `5d0497e815613ced7611d9db07911687`
- `test/session-source-v4.test.js`  `87156b4abd7dbe3f9f336da6b288daea`
- `test/tool-grant-session.test.js`  `81024476f5a3e6f0f7721586970f989b`
- `verify.mjs`  `f7c20bd8d6fb8ec6c3a345d0341d211e`

## 1.12.6（2026-10-06）
**两件事一起交付：① 修终审阻断项 B1（写侧落盘判据被写宽，误吞 ACP 孪生的项目档落盘）+ M1/m1/m2；② 新的「可编辑路径」授权弹框（U2）、面板「说实话」（U1）、弹框可滚动（U3）。**
1.12.5 从未发布，本轮连同它一起作为 1.12.6 交付；**部署态仍是 1.12.4**，本轮未部署、未重启宿主、未动 `~/.dsh`。
最终基线：`node --test test/*.test.js` → `# tests 551 / # pass 551 / # fail 0 / # skipped 0`，退出码 0；`node verify.mjs` 退出码 0。
（本节主体交付时的基线是 497；定稿轮按独立终审二审意见收口后增至 509；**第四轮**再收口终审三审的
1 阻断 + 2 Major + 6 Minor 后增至 518；**第五轮**收口终审四审的 3 Major + 3 Minor 并并入一条
用户新裁定（相对路径按工作区目录补齐）后增至 531；**第六轮**（收尾）再收口终审五审的 1 Major
（9 个同族包装器）+ 4 Minor 后增至 538；**第七轮**（收尾）再收口终审六审的 1 阻断
（短选项大小写折叠 ⇒ 同形开关吃掉真程序名）+ 结构性兜底 + 2 Minor + 设计裁定第 10 条后增至 **546**，
见文末「第七轮」；**第八轮**再收口独立终审七审的 2 阻断（**欠吃**方向：已登记包装器漏登记真实
取值选项 + macOS 同族包装器整类漏登记）+ 1 测试盲区（M2）后增至 **551**，见文末「第八轮」。）

### 与 dsh-plugin-product-subagents 0.7.9 的契约（两侧必须同口径）
- `product-subagents/permission-pending` 事件载荷新增 `suggestedDirs: string[]`——产品侧
  `suggestedDirs()` 算出的**目录**候选，是「可编辑路径」弹框的预填值。
- `product-subagents/permission-decision` 接受可选 `paths: string[]`，三态：
  **未给**（非数组）⇒ 产品侧沿用其自动分析；**给了且非空** ⇒ 只写路径档；
  **给了且空数组** ⇒ 只写工具名档。`paths` 与工具名档**互斥**（非空声明就不再写工具名档）。
- 本插件在琥珀通道**只透传、不校验、不改写**（`index.js:1928-1941`）：这条链的单一判定点是
  产品侧 `planGrantWrites`（0.7.9 `lib/permission-rules.js`），两侧各判一次必然漂移。
  宿主通道（蓝球）反过来**必须**服务端校验，因为那是本插件自己写的规则文件（见 U2）。
- 载荷最小化：`toolName` / `toolNameSource` / `suggestedDirs` 由
  `serializePermissionPending`（`lib/dispatch.js:446-457`）与 `markPermissionPending`
  （`:1525-1537`）记账透传；面板**不回显完整 paths 原文**（路径属敏感信息，U1 用例钉住）。

### 阻断项 B1（终审）：写侧落盘抑制的判据收窄回「只认沙箱越权」
- **根因**：1.12.5 把写入侧的抑制判据写成了 `isDisallowedAutoGrant`（= 沙箱越权 **或** ACP 孪生）。
  那条判据是**读取侧**「不得吃工具名档」用的；拿它管落盘，ACP 孪生点「总是允许(项目)」也被
  降级成会话档，`allowlist.json` 根本不创建——**与 1.12.5 自己写的「ACP 孪生一字未动」矛盾**，
  也超出用户口径（只要求越权受限，ACP 是「完全绕过、不要动它」）。终审实测：写侧通道零测试覆盖。
- **修法（方案 a：判据分档，读取侧一字未动）**：`index.js:2014`
  改前 `const pendingExcluded = !!approvalCtx && isDisallowedAutoGrant(approvalCtx.toolName, approvalCtx.reason)`
  改后 `const sandboxEscalated = !!approvalCtx && isSandboxEscalation(approvalCtx.reason)`；
  读取侧 `index.js:373` 的孪生早退门与 `:375` 的 `disallowToolGrant` 保持原样 ⇒
  孪生的项目档落盘恢复 1.12.4 行为，越权的抑制照旧。
  标识符改名（`pendingExcluded` → `sandboxEscalated`）是让**变量名参与文档**：
  写侧判据从此只能读作「是不是越权」。`verify.mjs:1028` 加了「源码里不得再出现
  `pendingExcluded`」的反向断言。
- **同源的 Minor**：降级留痕的文案此前在 ACP 场景也会打出「越权」字样（误导排障）。
  `index.js:2069-2079` 现在只在真越权时打印，并把判据写进日志
  （`沙箱越权请求不得写项目白名单，判据 isSandboxEscalation`）。
- `lib/host-approval.js:326-342` 的 `isDisallowedAutoGrant` JSDoc 改为**明写它只管读取侧**，
  并记下这次误用的后果，防止后来人再拿它管落盘。
- **CHANGELOG 自述更正**：1.12.5 那节的三处失真已就地订正（`:18-29` 的落盘判据、
  `:58-64` 的「写入侧同理用同一份判据」、`:132-137` 的 `isDisallowedAutoGrant` 语义），
  并把「客户端文案对越权不精确」那条已知局限标为「1.12.6 已处理」；
  另补回 1.12.4 那节丢掉的分节标题。

### Major M1：路径级记忆的粒度是**目录**，接受并写清（不是漏口）
- 用户定的统一模型：「把文件路径提取为上一级目录，指定路径往后的一切工具调用都放行」。
  机制是 `expandPathsWithParents`（`lib/host-approval.js:91`）补**直接父目录** +
  `pathAllowed` 按目录前缀匹配（`:164`）。1.12.5 的实现注释没讲清，容易被后来人当漏口"修掉"。
- 本轮把语义写进三处文档（`lib/host-approval.js:44-58` 头注释、`:106-120` 函数注释、
  `index.js:2004` 与 `:2041-2042` 的「用户声明不补父目录」注释），并用
  `test/host-approval-endpoint.test.js` 的 M1 describe 钉死：
  同目录兄弟文件不弹、子目录不弹、**换目录仍弹**（不外溢到兄弟目录）。
- 与之相对：用户在「可编辑路径」弹框里**自己声明**的目录已经是目录，
  再以 `expand:false` 写规则（`lib/host-approval.js:537`、`:676`）——
  对目录再取父目录会把「放行 `/tmp/newproj`」放大成「放行 `/tmp`」。

### Major G1：宿主侧「危险命令」排除门（用户裁决：这三条在任何档位下都必须问）
- **缺口**：产品侧 `dsh-plugin-product-subagents` 有这道门（`lib/dangerous-commands.js:79-83`
  + `lib/index.js:219-223`，0.7.9 起），**本仓库一条都没有**——全仓 grep
  `rm -rf` / `npm publish` / `git push` 零命中。用户口径是「这三条在任何档位下都必须走
  交互授权」，把「本会话授权过一次 Bash」当成此后所有 bash 请求免弹，等于让
  `rm -rf`、`npm publish`、`git push` 一起被静默放行。
- **实现**：名单是**单点常量** `DANGEROUS_COMMAND_RULES`（`lib/host-approval.js:432-519`），
  **与 product-subagents 侧同一名单、需人工保持同步**（文件头注释里写明来源与同步要求；
  两侧通道不同——那边是 ACP `toolCall.kind`，这边是宿主 `tool/call` 的 `name`+`arguments`——
  故判据实现各留一份、口径逐条对齐）。命令文本取自 `resolveApprovalContext`
  的同一条反查链路（`resolveApprovalContext → findToolCallRecord → commandTextOf`，
  `lib/host-approval.js:296`、`:389`、`:522`），与路径提取**同源**，不另造第二份解析。
- **位置**：`index.js:375-403`，**早于工具名短路与**所有路径/项目档判定。
  把它挪到工具名短路之后，这三条会先被工具名档放行（有用例做顺序哨兵）。
- **覆盖边界（诚实声明，与产品侧逐条对齐）**：
  - 覆盖 `rm -rf` / `rm -fr` / `rm -r -f` / `rm -f -R` / `rm --recursive --force`
    （必须**同时**具备递归与强制；`rm -r`、`rm -f` 单旗帜不触发）、`npm publish`、`git push`
    （含前置全局选项：`npm --silent publish`、`git --no-pager push`）；
  - 按 `;` `|` `||` `&` `&&` 与换行**分段**，只判每段**开头**那条命令，引号内不切分 ⇒
    `echo "git push"`、`grep "git push" f`、`# rm -rf` 都不算危险；
  - 命令名与子命令动词按小写比对（`RM -RF x` 照样命中）；前导环境变量赋值会被跳过；
  - ~~**不覆盖**：`sudo rm -rf` / `command rm -rf` / `env rm -rf` 等包装、
    `bash -c 'rm -rf …'` / `xargs rm` 等间接调用、`git -C <dir> push` 这类
    「全局选项带值」把动词挤到第三个 token 之后的写法、`pnpm publish`/`yarn publish`。~~
    ⚠️ **这一条已作废**：它是 1.12.6 中间轮（同一轮 Major G1）的记录，上面这几条
    已在随后「定稿轮 → 🔴 阻断：危险命令门被等价写法绕过」全部收口，
    第四轮又把同族残留（取值选项大小写、`-exec`、`busybox`、裸解释器读 stdin 等）一并收口。
    保留原文仅供对照，**不要**当现行覆盖边界读——现行边界见文件头注释
    （`lib/host-approval.js` 的 `DANGEROUS_COMMAND_RULES` 上方）与「第四轮」一节。
- **保守策略**：执行类调用（工具名属执行类 slug，或参数里带 shell 正文）但**命令文本
  解析不出来**时也不自动放行（`index.js:395-403`），日志 `action: 'no-command-text-block'`
  注明原因；非执行类工具不受影响。命中门留痕 `action: 'danger-command-block'` + `rule` + `segment`。
- **既有两道门一字未动**：越权（`isSandboxEscalation`）与 ACP 孪生（`isAcpTwinApproval`）
  的判据、顺序、档位拆分保持现状（新门排在孪生早退门之后、工具名短路之前）。

### Minor m1：CI 从不跑测试，且用例可以静默消失
- 改前 `.github/workflows/ci.yml` 只有一步 `node verify.mjs`，而 `verify.mjs` 全是
  字符串/纯函数断言——**一个用例都不执行**。终审 FG3 实测：把某个用例包成
  `if (false) it(...)`，`node --test` 仍报 `# tests 399 / # pass 399 / # fail 0` 退出码 0。
- 改后（`ci.yml:19-46`）：先跑 `node --test --test-reporter=tap test/*.test.js` 并传播退出码，
  再从 TAP 汇总里取 `# tests` 条数与 `MIN_TESTS`（**497**，v1.12.6 收尾时随新增用例上抬：
  471 → 483 → 497）比对，少一条就红——
  删用例、包 `if(false)`、加 `.skip` 三条路都过不了 CI。取不到计数也红（reporter 变了 ⇒ 守卫失效要显式处理）。

### Minor m2：一条用例的名字与事实相反
- 旧名「越权 + **只写路径规则**（POST 不带 toolName）」，但它断言的真实行为是
  **工具名档照写**——`index.js:1992` 的 `toolName = body?.toolName || approvalCtx?.toolName`
  会按 `callId` 从工具调用记录把工具名补出来。名字与注释都在教人错误的模型。
- 改名 `越权 + POST 不带 toolName：服务端从工具调用记录**补出**工具名（v1.12.6 m2 改名）`
  并加断言 `json.toolName === 'bash'`（响应必须如实回显）；
  另新增一条真正「补不出工具名」的覆盖（工具调用记录 `name: ''`）
  `服务端**补不出**工具名时才是「只写路径规则」那一档`，钉住那一档只有路径规则、没有工具名放行。

### U1：授权卡「说实话」——不再拿 `category` 当记忆键
- 旧文案 `（本会话将记住：<permissionPending.category>）`，而 `category` 只是 title 的 slug
  （qoder 场景下是一长串命令文本），**不是记忆键**——这句话是在骗用户。
- 改后三态如实（`lib/client.js:694-702` `permGrantTip`，接线在 `:3686`）：
  解析得出工具名 ⇒ 真实键 `product:tool`（`toolGrantKeyOf` `:643`，小写归一，
  与产品侧 0.7.9 `toolGrantKey` 同构，跨产品不串号）；只有路径/建议目录 ⇒
  「本会话将按路径记住（目录级）」；两者皆无 ⇒ 「本次仅放行一次，不会记住：下次仍会询问」。
- 数据源补齐：`lib/dispatch.js:446-457` / `:1525-1537` 透出
  `toolName` / `toolNameSource` / `suggestedDirs`（缺省 `null` / `null` / `[]`）。

### U2：「可编辑路径」授权弹框——**点确认才生效**
- 本会话允许 / 当前项目允许两类按钮不再即时生效：先弹可编辑目录框
  （`lib/client.js:719` `openGrantDialog`），预填 `suggestedDirs`（无则从 `paths` 词法取父目录，
  `dirsOfPaths` `:664`），一行一个目录；用户可增删改，**删空即「只要工具名档」**——
  提示语实时写明（含真实记忆键），只读末行显示当前工具名（守卫用例 `test/grant-dialog.test.js:249`：解析不出就如实说解析不出）。
  取消 / Esc / 点遮罩 ⇒ `resolve(null)` ⇒ **零 POST、不放行、不移除条目**。
- 琥珀通道：`sendDecision(a, answer, label, paths)`（`:3627`，`if (Array.isArray(paths)) payload.paths = paths`）
  → `POST /agent-api/permission-decision`（`index.js:1928-1941`，按三态透传，回显 `pathsCount`）。
- 宿主通道：`grantViaDialog(scope)`（`:4035-4059`）→ `POST /agent-api/host-approval-rule`
  带 `paths` 声明。服务端**只校验不改写**（`lib/host-approval.js:124` `validateDeclaredPaths`）：
  逐条丢非字符串 / 空串 / 含 NUL / 含换行 / 非绝对路径 / 根目录（`/` 进授权集＝任意路径免弹），
  词法归一 + 保序去重，响应披露 `pathsSource:'user'` 与被丢条目及原因（`index.js:2097`）。
  三态落地：非空 ⇒ `addSessionRule(..., {expand:false})` 只写路径档（`index.js:2040-2044`）；
  空（或被丢光）⇒ 只写工具名档并留痕 `action:'rule-tool-only'`（`:2020-2038`）；
  带声明却反查不到 `callId` 上下文 ⇒ **400 且不落盘**——拿不到 reason 就判不出是不是越权
  （`:1996-1999`）。项目档 + 空声明 ⇒ `scope:'session'` + `toolOnly:true`，不落盘。
- 顺带修掉越权按钮的谎话（1.12.5 记录的「已知局限」）：`:4025-4030` 起，
  越权请求不再渲染「总是允许该工具」，标签改成「本会话总是允许(路径)」，
  tooltip 不再出现「同类工具所有路径均放行」，项目档 tooltip 明说「只降级写本会话路径规则，不落盘」；
  弹框顶部再补一句档位说明（越权 ⇒ 只到本会话、换会话仍会问）。
  无 `callId` 的条目仍走 `legacySessionPost` / `legacyProjectPost`（`:4063` / `:4077`，
  载荷与 1.12.5 **逐字一致**，不变量⑦）。
- 弹框挂在 `document.body` 而不是面板内容区：面板每 3s 轮询重建 `popBody`，
  挂在里面会被吞掉；`grantDialogOpen` 闩（`:704`）保证同一时刻只有一个，
  第二个直接 `resolve(null)`，不给上一个留下无人管的遮罩。

### U3：弹框必须能滚，不许撑破视口
- `lib/client.js:288-298`：遮罩 `position:fixed;inset:0;overflow:auto;overscroll-behavior:contain`；
  面板 `max-height:min(80vh,calc(100vh - 24px))` + `max-width:calc(100vw - 24px)` + `overflow:hidden`；
  内容区 `flex:1 1 auto;min-height:0;overflow-y:auto`（由它承担滚动）；
  目录列表自身 `max-height:min(38vh,260px);overflow-y:auto`（几十条目录时独立滚动）；
  按钮行 `flex:0 0 auto;position:sticky;bottom:0`（内容再长也常驻可见）。
- `test/grant-dialog.test.js` 的 U3 describe 逐条断言这些契约，并断言 DOM 结构
  （遮罩→面板→标题/说明/内容区/操作行）与滚轮不链到页面；
  `test/fab-panel-layout.test.js` 的既有布局守卫（`pop.appendChild(frag)` 原子渲染等）一并跑通——
  弹框里的局部变量因此命名成 `dlg` 而不是 `pop`，避免撞那条「不许边建边挂」的反向断言。

### 不变量（不得回归，逐条命名自测）
`test/invariants-1-12-6.test.js`（16 例）+ `test/grant-dialog.test.js`「不变量⑤」（4 例）：
① 越权读取侧：`decide` 两开关的组合真值表（`disallowToolGrant` 只关工具名档、
   `sessionOnly` 只关落盘项目档、会话路径档照旧、都不覆盖时必不放行）；
② ACP 孪生：即使会话路径规则**覆盖得到**仍 `next()`，且早退门源码位置排在档位判据之前；
   写侧判据单条 `isSandboxEscalation`（B1 复发即红）；
③ auto-review / hook「ask」**有意不排除**（用户裁定，不许顺手收紧）：这类 reason 判据为 false、
   照常吃工具名档、照样落盘；读取侧 `return next()` 的早退门**恰好三道**（`!sessionId` /
   `isAcpTwinApproval` / `paths.length === 0`），多出第四道即红；
④ fork 判据真值表 + 端点侧 `rootSessionId`（fork ⇒ 自身、委派子会话 ⇒ 上溯到根）；
⑤ 工具名档跨产品隔离：`qoder:bash` ≠ `deveco:bash`、大小写/空白归一、缺 product 退化成裸工具名、
   键构造在源码里只有一份实现且不含 `category`/`paths`；
⑥ `decide` / `appendProjectRule` 单一调用点（`index.js` 各 1 处、`addToolGrant` 恰 2 处、
   浏览器半 0 处、其余模块 0 个第二写者）；
⑦ 非越权落盘逐字不变：信封 `{version:1,rules}`、两空格缩进、条目键序
   `cwd→paths→grantedAt→note`、主代理条目不带 `product`、同 `(cwd,paths)` 幂等合并、
   落盘后**新会话**同路径仍命中且留痕 `scope=project`。

### 测试
- 新增 `test/grant-dialog.test.js`（49 例）：从 `lib/client.js` 里**抽出真代码执行**
  （`new Function` + 手搓 FakeEl DOM），覆盖 U1 三态、目录预填互转、弹框确认/取消/Esc/遮罩/闩、
  蓝球 `grantViaDialog` 载荷（取消 ⇒ 零 POST）、琥珀 `sendDecision` 三态、U3 布局契约。
- 新增 `test/dangerous-command-gate.test.js`（14 例）：G1 危险命令门两层断言——
  判据层（名单与产品侧逐字对齐、`rm -rf` 等价写法、单旗帜不触发、分段只判段首、
  三条误伤守卫、前导环境变量、命令文本取值、执行类判据）+
  监听器层（真跑 `index.js` 的 approval/request handler：已授权 bash 下三条命令一律 `next()`、
  普通命令与 heredoc 照旧放行、保守策略「执行类解析不出命令文本也不放行」、
  **门的顺序哨兵**「必须早于工具名短路与路径/项目档判定」、既有两道门不受影响）。
- 新增 `test/invariants-1-12-6.test.js`（16 例，见上）。
- `test/host-approval-endpoint.test.js` 新增 15 例 + 改名 1 例：B1 两条（孪生落盘与 1.12.4
  逐字等价 / 越权仍不落盘且 sha256 不变）、M1 一条、U2 `body.paths` 三态 8 条、
  U2 契约透传 3 条、m2 新增 1 条。**落盘断言全部走 `boot()` 注入的临时 `DSH_HOME`**，不碰 `~/.dsh`。
- `test/permission-pending.test.js` 新增 3 例：三字段透传（缺省 `null/null/[]`）、
  `markPermissionPending` 记账与同 permId 重发就地更新、脏 `suggestedDirs` 不炸。
- 修改的既有用例（**没有放宽任何断言**）：
  - `test/perm-fab-jump.test.js:298`「决策按钮不冒泡到行」——锚点从
    `indexOf('const mkBtn = (label, answer, cls, tip) => {')` 换成
    `search(/const mkBtn = \(label, answer, cls, tip(?:, grant)?\) => \{/)` 并加「锚点丢失即红」的显式失败。
    原因：U2 给琥珀 `mkBtn` 加了第 5 个参数 `grant`，旧锚点 `indexOf` 返回 -1 ⇒ 切片为空 ⇒ 假过。
    本条钉的是按钮的 `stopPropagation`，不是它的参数表。
  - `test/host-approval-endpoint.test.js:312` 改名（见 m2），断言由「只写路径规则」改为
    「补出工具名 ⇒ 响应如实回显 `json.toolName === 'bash'`」。
  - `test/fab-panel-layout.test.js` 头部注释同步按钮新文案；所有 DOM 计数守卫未动、仍绿。
- `verify.mjs:950-1030` 新增 v1.12.6 块：判据可区分性、`validateDeclaredPaths` 三态与
  丢弃口径（混合输入应丢 5 条）、`expand:false` 不补父目录且不外溢到兄弟目录、
  序列化透传与缺省、13 条前端/宿主接线字符串断言，外加两条反向断言
  （假「将记住 category」文案不得存在；`pendingExcluded` 不得再出现）。
  另补一条「`if (key) return "（本会话将记住：" + key + "）"` 必须逐字存在」——
  转红实验③ 一开始只让用例红、verify 全绿，这条把语义补进了字符串层。

### 变异转红（逐字节恢复自证）
基线 497 例全绿 / `verify.mjs` 退出码 0。变异前把原文件复制到仓外留副本并记录 md5，
恢复后 `cmp` + md5 + sha256 三证逐字节一致（下表 ①②③④ 的读数写在 **471 基线时点**，
语义与替换关系不变、`fail` 是叶子用例数而非套件数；⑤⑥⑦ 是本轮收尾新做的）：

| 变异 | 转红的具名用例 | `node --test` | `node verify.mjs` |
|---|---|---|---|
| ⑤ **危险命令门挪到工具名短路之后**（G1 顺序哨兵） | G1「门的顺序：必须在工具名短路与所有路径/项目档判定**之前**」+「已授权 bash ⇒ 三条命令仍一律 next()」+「保守策略…」 | `# tests 14 / # pass 11 / # fail 3`，退出码 **1** | 退出码 **1**（`v1.12.6 G1: 危险命令门排在工具名短路之后`） |
| ⑥ **确认按钮不再发勾选结果**（`paths: d.paths` → 预填数组，等价于「空 paths ⇒ 工具名档」那条契约被绕过） | 「删空确认 ⇒ paths:[] 原样发出（契约：空数组＝只要工具名档）」「U4 全链路：在弹框里勾上推测项，它才作为 paths 元素发出」 | `# tests 49 / # pass 47 / # fail 2`（`grant-dialog`），退出码 **1** | 退出码 **0**（靠用例，字符串层看不出） |
| ⑦ **面板回到假承诺**（`permGrantTip` 兜底成 `"（本会话将记住：" + (p.category \|\| "同类工具") + "）"`） | 「工具名与路径都没有 ⇒ 直说只放行一次、什么都不记」「旧文案（拿 category 当记忆键）已从源码消失」「不变量⑤ / 缺 product ⇒ 退化为裸工具名」 | `# tests 49 / # pass 46 / # fail 3`（`grant-dialog`），退出码 **1** | 退出码 **0**（该变异不落在 verify 的字符串锚点上，由用例兜住） |
| ⑧ 写侧判据改回含孪生的 `isDisallowedAutoGrant`（B1 回归） | 「B1 / ACP 孪生 POST scope=project ⇒ allowlist.json 被创建…」「不变量② / 写入侧：落盘抑制的判据是 isSandboxEscalation 单独一条」 | `# tests 52 / # pass 50 / # fail 2`，退出码 **1** | 退出码 **1**（`B1 写侧判据收窄` 字符串守卫） |
| ⑨ **保守策略关掉**（`if (ctxInfo.execLikely && !ctxInfo.commandText.trim())` → `if (false)`） | G1「保守策略：执行类调用解析不出命令文本 ⇒ 也不自动放行（非执行类不受影响）」 | `# tests 14 / # pass 13 / # fail 1`，退出码 **1** | 退出码 **0**（`action: 'no-command-text-block'` 字符串仍在 ⇒ 靠用例） |
| 恢复后 | — | `# tests 497 / # pass 497 / # fail 0`，退出码 **0** | 退出码 **0** |

恢复自证：`index.js` md5 `825a71ee049bcbc6987afad9a965ca18`
（sha256 `7fa7577bb8d8a98bce7b71978cebfcdc4e3bd1499826ba871c6d1cca159768aa`）、
`lib/client.js` md5 `4bd36aecddc97031a0ea9fe6b3f74f26`；五处破坏-恢复后都与破坏前副本 `cmp` 一致。

**同一基线时点（471）的既有四条变异读数**（替换语义与 `fail` 口径不变，原表保留以防失忆——
它们当时红在 469/467 上，恢复后同为 471 全绿）：

| 变异 | 转红的具名用例 | `node --test` | `node verify.mjs` |
|---|---|---|---|
| ①' 写侧判据改回含孪生的 `isDisallowedAutoGrant` | 「B1 / ACP 孪生 POST scope=project ⇒ allowlist.json 被创建…」；「不变量② / 写入侧：落盘抑制的判据是 isSandboxEscalation 单独一条」 | `# pass 469 / # fail 2`，退出码 **1** | 退出码 **1**（`B1 写侧判据收窄` 字符串守卫） |
| ②' 用户删空仍写路径（`index.js` 退回 `autoPaths`） | U2 三态 4 条：「声明为空数组 ⇒ 只写工具名档」「空声明 + scope=project」「非法声明逐条丢弃…全非法」「越权 + 删空声明…（不变量①）」 | `# pass 467 / # fail 4`，退出码 **1** | 退出码 **0**（端点分支不在 verify 覆盖内 ⇒ 靠 m1 的 CI 用例守卫） |
| ③' 解析不出工具名仍说「将记住」 | 「只有路径 / 只有建议目录 ⇒ 明说按路径记住」「工具名与路径都没有 ⇒ 直说只放行一次」「旧文案已从源码消失」「不变量⑤ / 缺 product ⇒ 退化为裸工具名」 | `# pass 467 / # fail 4`，退出码 **1** | 退出码 **1**（新增的那条逐字断言） |
| ④' 弹框绕过确认直接生效（`grantViaDialog` 不弹框、用预填直接 POST） | 「U2 宿主通道 / 取消弹框 ⇒ 不 POST、不放行、不移除条目（转红实验④的靶子）」「删空确认 ⇒ paths:[] 原样发出」 | `# pass 469 / # fail 2`，退出码 **1** | 退出码 **0**（字符串守卫全在 ⇒ 靠用例） |

上表 ①②③④ 的 `index.js` md5 是 `3f87df688dee3e133973e02b7ae8ccf1`、`lib/client.js` 是
`ae326a47035b94761dc86da5804478b1`（**471 基线时点**，本轮 G1 改动前）；本轮 ⑤⑥⑦ 的
md5 见上（**497 基线时点**，即最终冻结版本）。

### 未做 / 边界（如实披露）
- 未部署、未重启宿主、未动 `~/.dsh`、未 `npm pack`、未 `git add`/`commit`。
- 契约另一侧（product-subagents 0.7.9）不在本仓，本轮只保证**本插件**按口径收发；
  产品侧的 `planGrantWrites` 判定以其自己的冻结为准。
- `#pendingContexts` 单调增长的既有设计债（1.12.4 已披露）仍未碰。
- 越权请求**可以**被写下工具名授权（无 `callId` 的老载荷、以及显式删空声明都会写），
  但读取侧那一档对越权永远不生效（不变量①）——这是档位模型的选择，不是漏口。
- auto-review / hook「ask」继续共享工具名档（③，用户裁定保持现状）。
- **G1 危险命令门的覆盖边界**（定稿轮已大幅收口，见下方「定稿轮」小节）：包装/等价写法
  （`sudo`/`command`/`env`/`nohup`/`nice`/`time`/`timeout`/`stdbuf`/`xargs`、basename、
  `bash -c '<body>'` 解 2 层、`git -C/-c`、`npm --prefix`、`pnpm`/`yarn publish`、自定义
  执行工具的 `{shell:…}`）**现已全部命中**；仍不覆盖的只剩静态不可判定的形态
  （`python -c 'os.system(…)'`、脚本/构建目标、`$( … )` 命令替换、变量间接、argv 拆词数组）。
- **G1 门的名单需人工与 product-subagents 同步**：两侧通道不同（ACP `toolCall.kind` vs
  宿主 `tool/call` 的 `name`+`arguments`），无法共用一份代码，只能共用同一份**口径**；
  任何一侧改名单都要同时改另一侧（`lib/host-approval.js` 文件头已写明）。

### 收尾（上一个实现者被打断，磁盘上留了半成品；本轮补齐并冻结）
- `test/grant-dialog.test.js` 有一处**语法错误**（`it(` 块里 `const r = build({` 被截断，
  `const seen = {}` 直接跟着 `escalation: false,`）⇒ 整个文件 `node --check` 失败、
  49 条用例**一条都没跑**，而 `node --test` 只报顶层 `not ok`。
  已补回 `const r = build({`。教训：语法错误让「新增测试」看起来存在、实际零覆盖。
- `lib/client.js` 的 `openGrantDialog` 把 `hint`（实时提示）与 `toolLine`（只读工具名行）
  **造出来却没挂进 DOM** ⇒ U2/U4 一大片用例红在「弹框内 .ad-grant-hint 应恰好 1 个，实际 0」。
  已 `body.appendChild(hint)`（在「+ 添加目录」之后）与 `body.appendChild(toolLine)`（在其后），
  与用例断言的「两组 + 添加按钮 + 提示 + 只读工具行」结构一致。
- `dirsOfPaths` 曾增补无扩展名**文件**判据（`FILE_NO_EXT_RE`）：`/home/dev/.ssh/id_ed25519`
  这类没有 `.ext` 的名字按文件取父目录。**该判据已在定稿轮被替换**（见「定稿轮 · Major 2」）：
  它按「名字里带 `-`/`_`/数字」猜文件，把 `.ssh`、`my-project`、`notes_2024` 这些**目录**也
  判成文件、取到父目录；且旧注释「原样落盘等于放过整个 `~/.ssh`」与服务端 `pathAllowed`
  的真实语义相反。现在只认「带扩展名（首字符不能是点）」+ 显式文件白名单 `FILE_FORM_RE`。
- `.ad-grant-input` 类名与 CSS 对齐（路径输入区/目录列表的自重限高可滚契约，`verify.mjs` 有逐字断言）。
- `test/grant-dialog.test.js` 两处**用例自身的**过期期望已改准：`/etc/passwd` 在纯词法口径下
  是目录（取不到「它是文件」的证据），期望值从 `/etc` 改为 `/etc/passwd`——用例不该断言
  实现不可能知道的事。
- `test/host-approval-endpoint.test.js` 新增 `bashCall` 夹具并修两处「声明 bash、却给 write
  参数体」的拼接夹具（`irreducible`：G1 的保守策略会先拦下它们，断言就跑到错误的层上去了）；
  `test/invariants-1-12-6.test.js` 同样加 `bashCall`。
- `test/tool-grant-session.test.js`：handler 注入表补 `dangerousCommandMatch`（漏项会被
  handler 自己的 try/catch 吞成 `next()`，表现为「①⑤⑧⑨⑫ 一起红」），并**新增
  `handlerNameDrift()` 硬守卫**——handler 体出现未注入的闭包名就直接报名字，
  这类静默假红不再靠人肉对齐；①⑤ 两条用例补上真实的 `tool/call` 记录。
- `verify.mjs` 新增 G1 块（门的位置/顺序、保守策略留痕、名单单点常量与同步声明）。
- **冻结包重打**（上一版 `/tmp/dsh-agent-dispatch-1.12.6-freeze.tar.gz` 打于 10:20，
  早于 `dispatch.js`/`client.js` 的后续改动 ⇒ 已过期）。
- **冻结凭据**（最终）：`tar -czf /tmp/dsh-agent-dispatch-1.12.6-freeze.tar.gz
  --exclude=node_modules --exclude=.git .` → 75 个成员 /
  md5 `cd33f1acda8681e5bab89badba0813d7`
  （sha256 `f758586c7d8df29bddcad96a8c7244fba817aa6b18da80951dcd17ba8ad75a7d`）/
  2 604 369 字节；解包后 `diff -r -x node_modules -x .git` 与仓库**零差异**
  （`DIFF_EXIT=0`、0 行输出）。
  关键文件 md5：`index.js` `825a71ee049bcbc6987afad9a965ca18`、
  `lib/host-approval.js` `889f3ffcd712f88a96ce254d0ab0992d`、
  `lib/client.js` `4bd36aecddc97031a0ea9fe6b3f74f26`、
  `lib/dispatch.js` `c415c59b661e437a666a1606dd23a7db`、
  `package.json` `e1bd0bb661aa5ad0c1a84a978234bb36`、
  `verify.mjs` `3f768b55932c7da38971fda0c7919194`、
  `.github/workflows/ci.yml` `48d246be82bfc326c309dc0a0945cade`、
  `test/dangerous-command-gate.test.js` `73552e5eb14aec2da8b6d79feca3deb6`、
  `test/grant-dialog.test.js` `ff8f279d01bf334b516062a526f6ee91`。
  **自指说明**：`CHANGELOG.md` 自身的 md5 无法写进它自己（写进去就变了），
  所以本文件不在上表里；以冻结包的 md5 为准（CI 由 `git status` 与冻结协议核对）。
  冻结时刻 `2026-10-06 10:57 CST`，此后不再触碰。

### 定稿轮（独立终审二审：1 阻断 + 3 Major + 若干 Minor 的收口）
**上面那包已作废**：独立只读终审判定「修复后交付」，同时抓到 1 个阻断 + 3 个 Major + 若干
Minor，本轮逐条收口后**重打冻结包**（凭据见本节末）。版本仍是 **1.12.6**（从未发布，不跳号）。

#### 🔴 阻断：危险命令门被「等价写法 / 包装写法」绕过（已收口）
- **缺口（终审探针实测）**：已授权 `bash` 时下列写法仍被静默放行（`res==='allowed-once'`）：
  `sudo rm -rf /tmp/x`、`command rm -rf`、`env rm -rf`、`nohup`/`nice`/`time rm -rf`、
  `/bin/rm -rf`、`bash -c "rm -rf …"`、`sh -c '…'`、`echo x | xargs rm -rf`、
  `git -C /tmp push`、`git -c k=v push`、`npm --prefix /tmp publish`、`pnpm publish`、
  `yarn publish`，以及**自定义执行工具**（工具名非执行类 slug + `{shell:'rm -rf …'}`）。
  根因：`isRecursiveForceRemove` 要求 `tokens[0]` 字面等于 `rm`、`subCommandVerb` 要求动词是
  **第一个**非选项 token、`execLikely` 只认 `EXECUTE_TOOL_SLUGS` 与 5 个参数键。
- **修法（`lib/host-approval.js:386-720` 区段整体收口；用户裁定：等价写法同属一类）**：
  ① **透明包装**：`sudo`/`command`/`env`/`nohup`/`nice`/`time`/`timeout`/`stdbuf`/`xargs`
  逐层剥掉，连同各自的**取值选项**与 `timeout` 的数值时长（`sudo -u root rm …`、
  `nice -n 10 rm …`、`timeout 5 rm …`），可叠加；前导赋值 `FOO=1 cmd` 一并跳过。
  ② **程序名按 basename 比对**（`/bin/rm`、`./rm`、`/usr/bin/env`）。
  ③ **解一层 shell 包装**：`sh|bash|zsh|dash|ksh -c '<body>'`（单/双引号、`-lc` 组合短选项）
  把 body 再喂给同一份规则；**递归上限 2 层**（`MAX_SHELL_UNWRAP_DEPTH`），第 3 层起按
  `SHELL_DEPTH_RULE='shell-nesting'`（**可疑**）保守转交互 —— 不做无限展开、不做完整 shell 解析器。
  ④ **动词判定跳过该命令自己的取值选项**：`git -C <dir> push`、`git -c k=v push`、
  `npm --prefix <p> publish`（`--opt=value` 单 token 不吃下一个）。
  ⑤ **`pnpm publish` / `yarn publish` 与 npm 同语义，纳入名单**（用户裁定；名单从 3 条变 5 条，
  仍是单点常量 `DANGEROUS_COMMAND_RULES`，需与 product-subagents 人工同步）。
  ⑥ **自定义执行工具**：`resolveApprovalContext` 新增 `argsText`（`argsTextOf` = args 里**所有
  字符串值**换行拼起来），门判据变成
  `dangerousCommandMatch(ctxInfo.commandText) || dangerousCommandMatch(ctxInfo.argsText)`
  —— 只看前者时 `{shell: 'rm -rf …'}` 是静默放行。
- **残留边界（刻意的，静态不可判定；已写进源码注释与验收用例）**：
  `python -c 'os.system("rm -rf")'`、把命令写进脚本/构建目标再执行（`make deploy`；
  注意 `bash deploy.sh` **已在第四轮按 `SHELL_STDIN_RULE` 保守转交互**——那是「判不出它要执行
  什么」而不是放行）、`sh -c "$(curl …)"`、变量间接（`S=rm; $S -rf x`）、`eval`、
  **argv 拆词形态**（`{argv:['rm','-rf','/']}`：按值分别判、不拼回一条命令）、
  **`argsTextOf` 的 4 层递归上限**（`depth > 4` 即不再下探：嵌套 5 层以上的自定义工具参数里的
  字符串整体不可见——第四轮按终审 Minor 就地登记，此前只写在函数注释里、未进本节）。
  这些要么需要真正的 shell 解析器 + 变量求值 + 读脚本文件，要么超出用户名单范围；
  判不出的方向不在这里兜底，而是由既有的保守策略（执行类解析不出正文 ⇒ 不自动放行）接手。
- **已知多弹一次（安全方向，用户裁定不修，只登记）**：heredoc 正文里出现 `rm -rf`
  （`cat <<'EOF' … rm -rf /tmp/x … EOF`）会被判危险；`write`/`edit` 的正文参数里出现这三条
  命令同理（`argsTextOf` 扫所有字符串值）。
  **触发条件第四轮按实测口径写精确**（登记成立、行为不变）：`argsTextOf` 把「每条字符串值」
  用换行拼接，判定只看**每段/每行的开头** ⇒ 只有危险命令位于行首/段首才会多弹一次：
  `content='rm -rf /tmp/x'` 或带换行前缀（`…\nrm -rf /tmp/x`）会 `next()`，
  而 `content='see git push docs'` 照旧放行。补了一条**说明性用例**钉住现状，不为它改判定。
- **误伤守卫（全部保持不命中）**：`echo "git push"`、`grep "git push" f`、`# rm -rf`、
  `git commit -m "git push"`、`git log --grep push`、`npm run publish`、`pnpm run publish`、
  `rm -r`、`rm -f`、`rm /tmp/x`、`ls -la`、`echo hi`、`sudo ls -la`、`xargs echo hi`、
  `bash -c "echo hi"`、`timeout 5 npm run build`、`env grep "git push" f`、`command -v rm`、
  `nice -n 10 ls`、`echorm -rf`、`rmdir -rf /tmp/x`。
- `test/tool-grant-session.test.js` 的 handler 注入表**无需改动**：新判据全部落在
  `resolveApprovalContext` 返回的 `ctxInfo.argsText` 上，handler 体的闭包引用没有新增
  （`handlerNameDrift()` 硬守卫仍绿）。

#### 🟠 Major 1：CI 用例守卫对 `.skip` 盲（已收口）
- 终审实测：`it.skip(...)` 之后 `# tests 497 / # skipped 1`，只比 `# tests` 的守卫**照样绿**
  —— pass 悄悄少一条，没有任何信号。
  （第四轮按实测口径补正：`t.skip()` / `it.skip()` **会**进 `# tests`、**不进** `# pass`，
  `# skipped` 单独计数；真正拦住第二个 skip 的是下面的 `# pass` 下限。ci.yml 里原先那句
  「skipped 不进 tests 计数」写反了，第四轮已改准。）
- 修法（`.github/workflows/ci.yml:19-73`）：守卫改为三件事一起断言
  ① `# pass >= MIN_TESTS - SKIPPED_ALLOWED`（下限 `floor`）；
  ② `# cancelled == 0`；③ `# todo == 0`。`# tests` 下限保留为第二道（总数被削减也红）。
- **K（`SKIPPED_ALLOWED`）的来源就地登记在 ci.yml 注释里，当前 1，只有一条准跳**：
  `test/host-0.2-compat.test.js:334-340`（用例起于 334，`t.skip` 在 340）——它硬编码
  `/Users/arming/.nvm/.../dsh-util-values/lib/index.js`，macOS 开发机可解析、ubuntu-latest
  必然解析不到 ⇒ CI 上固定少 1 条 pass。除它之外新增任何 skip 都会让 CI 红。
- 守卫逻辑本身用四组 TAP 夹具离线验过：CI 常态（pass 508/skipped 1）**绿**；
  多加一个 skip（pass 507/skipped 2）**红**；`cancelled 1` **红**；`todo 1` **红**；
  删掉一个用例（`# tests 508`）**红**。另有源码级用例
  （`test/invariants-1-12-6.test.js` 的「CI 用例守卫」describe）钉住这几行，把它改回
  「只比 `# tests`」会先红。

#### 🟠 Major 2：弹框目录预填把「像文件的目录名」放大到父目录（已收口）
- 终审逐字复算：`FILE_NO_EXT_RE` 的 `[-_]`/`\d` 分支 + `hasExt` 把 `.ssh` 当扩展名
  ⇒ `/home/dev/.ssh → /home/dev`、`/tmp/notes_2024 → /tmp`、`/home/dev/my-project → /home/dev`。
  这些预填**默认勾选**，而服务端 `validateDeclaredPaths` 只做词法校验（不 stat）、
  声明非空即 `expand:false` 原样落盘 ⇒ 手快确认一次可把整份家目录/上级目录写进会话授权。
- 修法（`lib/client.js:679-722`）：**只有明确是「文件形态」时才取父目录** ——
  末段带扩展名（`EXT_NAME_RE`，**首字符不能是 `.`**，故 `.ssh` 不再被当扩展名），
  或命中显式文件白名单 `FILE_FORM_RE`（`id_*` 私钥/公钥、`known_hosts`、`authorized_keys`、
  `Makefile`/`Dockerfile`、`.gitconfig`/`.gitignore`/`.gitattributes`/`.gitmodules`
  （**裸 `.git` 已从名单剔除**，见「第四轮 · M2」）、
  `.npmrc`/`.nvmrc`/`.env`/`.bashrc`/`.bash_profile`/`.zshrc`/`.profile`/`.editorconfig`/
  `.dockerignore`）；**其余一律原样当目录**（`.github` 刻意不在名单里：它是目录）。
- **错误注释一并订正**（`lib/client.js:679-698`）：旧注释说「`/home/dev/.ssh/id_ed25519`
  原样落盘等于放过整个 `~/.ssh`」——不成立。`pathAllowed`（`lib/host-approval.js:180`）只对
  **无扩展名尾巴**的规则做目录前缀匹配；那条规则匹配的是它自己（及其下），**不会**放开
  `~/.ssh` 里的别的文件。注释改成按服务端语义写。反向提醒也写进去了：`.ssh` 这种点开头的
  **目录名**会被 `pathAllowed` 当扩展名尾巴（`.ssh` 命中 `/\.[A-Za-z0-9]{1,8}$/`）⇒ 该规则
  只精确匹配它自己——这是既有命中语义（本次不动），但预填**绝不能**因此把它放大成父目录。
- 验收：`['/a/b/my-project']`、`['/home/dev/.ssh']`、`['/tmp/notes_2024']`、`['/a/b/.github']`
  全部原样；`['/a/b/x.txt'] → ['/a/b']`、`['/home/dev/.ssh/id_ed25519'] → ['/home/dev/.ssh']`、
  `['/home/dev/.gitconfig'] → ['/home/dev']`、`['/a/b/Makefile'] → ['/a/b']` 照旧取父目录。

#### 🟠 Major 3：门命中后 UI 无任何提示 = 静默陷阱（已收口）
- 现场：用户在这三条命令上点「总是允许(会话/项目)」照样写规则（写侧一字未动），但读取侧
  那道门排在最前（`index.js` 的 `if (danger) return next()` 早于所有档位判定）⇒ 规则**永不生效**，
  用户却以为已授权、反复被问。
- 修法：门命中时把门名补进暂存上下文（`index.js:374-393`，同一 `callId` **覆盖**一份
  `{...ctxInfo, sessionId, rootSessionId, dangerRule}`；首次 `pushPendingContext` 的位置不动，
  因为写侧依赖它在门前落好），经 `GET /agent-api/host-approval-context` 原样回传，
  客户端落到条目上（`lib/client.js` 的 `item.dangerRule = d.dangerRule`）并**两处写明**
  文案「该命令每次都会询问，不可记忆（命中危险命令门：<rule>）」：
  蓝球条目 `.ha-danger`（`lib/client.js:4090-4100` 附近）与授权弹框 `.ad-grant-danger`
  （`openGrantDialog`，含 `grantViaDialog` 把 `item.dangerRule` 透传给弹框）。
  没命中门的请求**不带**这个标记（否则是谎报「每次都问」）。
- 验收：新增用例钉住「门命中 ⇒ GET context 带 `dangerRule: 'rm -rf'`、普通命令不带」，
  以及「弹框有 `.ad-grant-danger` 文案、无 dangerRule 时不出现、蓝球那一行同款文案」。

#### 🟡 Minor（本轮一并处理）
- **保守策略补一类**：工具名不在 `EXECUTE_TOOL_SLUGS`、参数键也不在 `COMMAND_ARG_KEYS`
  （如 `{shell:…}`）时，过去既不判危险也不保守拦截 ⇒ 工具名档直放。按阻断项 ⑥ 收口
  （对 args 所有字符串值跑一次匹配），并补了监听器层用例：先把 `custom_shell` 授权到根会话键，
  普通正文 `{shell:'echo hi'}` 仍走工具名档放行，`{shell:'rm -rf /tmp/x'}` 必须 `next()`。
- **heredoc 正文误报**：如实登记（见上），补一条**说明性用例**，判定不改。
- **`门序` 哨兵**：源码字符串断言（`index.js` 的调用点 + `verify.mjs` 的位置比较）**保留**，
  但**行为哨兵为主** —— 监听器层用例（已授权 bash ⇒ 15 条等价写法全部 `next()`、零 `auto-grant`）
  才是真防线；源码哨兵只是补充，不再当唯一防线。

#### 测试与转红（定稿轮）
- 用例数 497 → **509**（新增 12 条：判据层 5 + 监听器层 3 + 弹框/预填 3 + CI 守卫 2 …按文件分布见下）。
- `node --test test/*.test.js` → `# tests 509 / # pass 509 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`，退出码 0。
- `node verify.mjs` → 退出码 0（v1.12.6 一致性链 + 11 工具）。
- **转红①**：把包装/等价写法收口改回原样（`matchSegment` 不再剥包装 + shell 解包装短路）
  ⇒ `test/dangerous-command-gate.test.js` 新增用例成片转红（`sudo rm -rf …`、`bash -c …`、
  `xargs rm -rf`、`git -C … push`、`pnpm publish` 等），逐字节恢复后 `cmp` 全等 + 变异标记 grep 归零。
- **转红②**：把预填判据改回「像文件就算文件」（`/\.[A-Za-z0-9]{1,8}$/ || /[-_]|\d/`）
  ⇒ `dirsOfPaths(['/home/dev/.ssh'])`、`['/a/b/my-project']`、`['/tmp/notes_2024']` 三条转红，
  恢复后同上自证。

#### 定稿轮冻结凭据（自指说明同上一节）
- 协议：`tar -czf /tmp/dsh-agent-dispatch-1.12.6-freeze.tar.gz --exclude=node_modules --exclude=.git .`
  —— 在**本节写入之后**执行，故包内 `CHANGELOG.md` 与本文件逐字节一致。
- 包自身的**成员数 / 字节数 / md5 / sha256**，以及解包后
  `diff -r -x node_modules -x .git` 的结果，由交付报告给出（把包自己的 md5 写进包内会改变它
  自己，构造上不可能自含）。
- 冻结时刻 `2026-10-06 11:15 CST`，此后不再触碰本工作区。
- **逐文件 md5（冻结时点）**：`index.js` `abb8decddc6276b1b690e6b096e5670e`、
  `lib/host-approval.js` `9a1f0fd31fcbb907ea43d2211be34997`、
  `lib/client.js` `995f601c21d702ca314ff94ba504f1bb`、
  `lib/dispatch.js` `c415c59b661e437a666a1606dd23a7db`、
  `package.json` `e1bd0bb661aa5ad0c1a84a978234bb36`、
  `verify.mjs` `3f768b55932c7da38971fda0c7919194`、
  `.github/workflows/ci.yml` `941364297fc75664248187be2f9c4809`、
  `test/dangerous-command-gate.test.js` `888e8e000047d884ac8c03aed17cd149`、
  `test/grant-dialog.test.js` `4e8848d5ca680ddfe4c13c653529fc27`、
  `test/invariants-1-12-6.test.js` `cf884056eef37bba1f14098a1a96dbff`。
  `CHANGELOG.md` 自身的 md5 不在表里（自指），以交付报告为准。
- 仍然：未部署、未重启宿主、未动 `~/.dsh`、未 `git add`/`commit`、未切 ref。

### 第四轮（独立终审三审：1 阻断 + 2 Major + 6 Minor 的收口）
**上面两包（10:57 与 11:15）都已作废**：终审把上一轮的探针**逐字节原样复跑**，确认 17 条原漏口
全部转交互、12 条 `auto-grant` 无一来自危险命令、16 条误伤守卫全绿；但同一族里又抓到
1 个阻断 + 2 个 Major + 6 个 Minor。本轮逐条收口后**再次重打冻结包**（凭据见本节末）。
版本仍是 **1.12.6**（从未发布，不跳号）。

#### 🔴 阻断 B1：取值选项表里的大写条目永远匹配不上 ⇒ 三条等价写法仍静默放行（已收口）
- **现象（终审真跑真实 handler，前置＝把 `bash` 授权到根会话键 `R`）**：
  `pnpm -C /tmp publish`、`npm -C /tmp publish`、`sudo -C 3 rm -rf /tmp/x` 全部
  `next=false res=allowed-once gateRule=null`（被静默放行）。对照：`pnpm --dir /tmp publish`、
  `sudo -u root rm -rf …`、连写形态 `sudo -C3 …` / `pnpm -C/tmp …` 都拦得住。
- **根因**：两张取值选项表（`WRAPPER_VALUE_OPTIONS` / `PROGRAM_VALUE_OPTIONS`）存的是**大小写
  原样**的值，查表前却把 token `toLowerCase()`（`valueOpts.has(t.toLowerCase())` 与
  `subCommandVerb` 里的同一处）⇒ `'-C' !== '-c'`、`'-S' !== '-s'` ⇒ 该选项**吃掉的那个取值**
  （`/tmp`、`3`）被当成程序名 ⇒ `basenameOf(tokens[0])` 不再是 `rm`/`pnpm` ⇒ 整段不命中。
  **旁证**：`git` 那张表同时写了 `'-c'` 与 `'-C'` 两个拼写，所以 `git -C /tmp push` 恰好幸存
  —— 这个坑被局部绕开过，却从未被修掉。
- **修法**：新增 `const lowerSet = (arr) => new Set(arr.map((s) => s.toLowerCase()))`；
  `WRAPPER_VALUE_OPTIONS`（`sudo` 的 `-C`、`env` 的 `-C`/`-S` …）与 `PROGRAM_VALUE_OPTIONS`
  （`git`/`npm`/`pnpm`/`yarn`）**全部**用它包住；删掉 `git` 表里冗余的 `-C` 拼写；
  表头注释写明「**表内一律小写**，新增拼写必须写小写」。
- **验收**（四条同时进判据层 `probes` 表与监听器层探针表）：
  `pnpm -C /tmp publish → 'pnpm publish'`、`npm -C /tmp publish → 'npm publish'`、
  `sudo -C 3 rm -rf /tmp/x → 'rm -rf'`、`env -S 'ls; rm -rf /x' → 'rm -rf'`。
- **转红①**：把 `lowerSet` 改回 `new Set(arr)` ⇒ 四条全部转红（判据层 + 监听器层）。

#### 🟠 Major M1：7 种**未声明**的等价写法仍静默放行（已收口）
- **现象（监听器层原始输出）**：`busybox rm -rf /tmp/x`、`printf 'rm -rf /x' | bash`、
  `bash <<< 'rm -rf /x'`、`yarn npm publish`、`find /tmp -exec rm -rf {} +`、
  `bash -c'rm -rf /x'`、`sh -c"rm -rf /x"` 全部 `next=false res=allowed-once`；
  纯函数层另见 `toybox`/`coreutils rm -rf`、`/bin/bash <<< …`、
  `bash -c "bash -c \"rm -rf /x\""`。**声明比对**：本节上方「残留边界」与源码注释里那几条
  （`python -c`、脚本/`make`、`$(curl)`、变量间接、`eval`、argv 数组）**一条都盖不住它们**。
- 逐条修法（`lib/host-approval.js`）：
  1. **多调用二进制**：`TRANSPARENT_WRAPPERS` 增补 `busybox` / `toybox` / `coreutils`
     （`busybox rm -rf x` 里程序名在**后一个** token 上，`basenameOf` 那类推法救不了）；
  2. **裸解释器读 stdin**：段首是 `sh|bash|zsh|dash|ksh` 却**没有 `-c`** ⇒ 新增门名
     `SHELL_STDIN_RULE = 'shell-stdin'`（**可疑**，保守转交互）。裸解释器读 stdin
     （`printf '…' | bash`、`bash <<< '…'`）或执行脚本文件（`bash deploy.sh`），
     正文静态不可判定——与 shell 深度上限同一原则：判不出不是放行；
  3. **`-c` 与正文粘连**：`shellBodyIndex` 改为返回 `{at, inline}`，把标志 token 里
     紧跟在 `c` 之后的残段（`-c'rm` → `'rm`）拼回正文再判（改前正文首词被吞 ⇒ MISS）；
  4. **反斜杠转义引号**：新增 `unescapeQuoted`（只解 `\"` / `\'`），`basenameOf` 与
     `stripOuterQuotes` 都先解转义再剥引号（改前 `\"rm` 被切成 `"rm` ≠ `rm`、外层引号也剥不掉
     ⇒ 两层嵌套整段漏判，**不是**深度上限问题）；
  5. **`yarn npm publish`**：`subCommandVerb` 里 yarn 的 `npm` 子命令再看下一个非选项 token
     （`yarn npm run publish` 仍不命中——那里动词是 `run`）；
  6. **`find … -exec <危险程序>`**：新增 `execSubcommandIndex`（认 `-exec`/`-execdir`/`-ok`/
     `-okdir`），把其后的子命令再喂给同一份规则。**不新增名单条目**——危险**命令**名单仍是
     单点常量 `DANGEROUS_COMMAND_RULES`（5 条），`-exec` 只是同一命令的另一条调用路径，
     命中仍报原规则名（`rm -rf`），所以「与 product-subagents 同一份名单」的不变式不被破坏。
- **验收**：上表 7 条 + 深度 3 的嵌套（转义写法同样按 `shell-nesting`）全部进判据层与监听器层；
  16 条误伤守卫（`echo "git push"`、`git commit -m "git push"`、`git log --grep push`、
  `npm/pnpm run publish`、`rm -r`、`rm -f`、`ls -la`、`echo hi`、`sudo ls -la`、`xargs echo hi`、
  `bash -c "echo hi"`、`timeout 5 npm run build`、`command -v rm` …）保持全绿，
  另补 `find -exec ls`、`find -exec echo rm -rf`、`yarn npm install`、`yarn npm run publish`。
- **转红②**：把 `-c` 粘连的 `inline` 收口改回去 ⇒ `bash -c'rm -rf /x'` 用例转红
  （判据层 + 监听器层）。

#### 🟠 Major M2：弹框预填把**必然是目录**的 `.git` 当文件，放大到父目录（已收口）
- **现象**：`FILE_FORM_RE` 里写的是 `\.git(?:config|ignore|attributes|modules|keep)?` ——
  **可选组**让裸 `.git` 也进白名单 ⇒ `dirsOfPaths(['/repo/.git']) === ['/repo']`（期望原样）、
  `['/repo/.git/'] === ['/repo']`。这些预填**默认勾选**，用户点一次确认就把整个项目根写进会话授权
  —— 正是上一轮 M2 要防的方向。同一段注释还刚好以「`.github` 刻意不在名单里：它是目录」为由排除
  `.github`，`.git` 与它同属目录却处理相反。
- **修法**：① 该组改成**必选** `\.git(?:config|ignore|attributes|modules|keep)`（裸 `.git` 立即
  回到「原样当目录」）；② **不再**往白名单加「可能是目录」的名字；③ 注释里写明白名单取舍原则：
  **只收录「作为名字时必然是文件」的形态，凡是可能同时是目录名的一律原样**。
  更彻底的「服务端 `statSync` 回 `isDir`、白名单只做无 stat 时的兜底」本轮**不做**，
  登记为后续项（写在 `lib/client.js` 的 `dirsOfPaths` 注释里）。
- **验收**：`dirsOfPaths(['/repo/.git']) === ['/repo/.git']`、`['/repo/.git/'] === ['/repo/.git']`；
  `['/repo/.gitignore'] → ['/repo']`、`['/repo/.gitattributes'] → ['/repo']` 照旧；
  `['/repo/.git/config']` 原样（白名单按**末段**比对，`config` 可能是目录名 ⇒ 方向只会更窄）。
- **转红③**：把可选组加回去 ⇒ 用例转红。

#### 🟡 Minor（本轮一并处理，逐条）
1. **透明包装 8 跳用尽后是静默放行**（旧 `unwrapTransparentWrappers` 到顶就 `break` 返回残余
   token，规则表只认段首程序名 ⇒ `sudo`×9 + `rm -rf` 全部 MISS）。改为
   `{tokens, exhausted}` 返回结构 + `MAX_WRAPPER_UNWRAP_HOPS = 8` + 新门名
   `WRAPPER_DEPTH_RULE = 'wrapper-nesting'`：**跳数用尽且段首仍是包装器（后面还有东西）**
   ⇒ **可疑**转交互，与 shell 深度上限原则对齐；只剩包装器自己（`sudo`×9 后面什么都没有）
   仍不命中（没有可执行的命令，不发假警报）。
2. **`argsTextOf` 的 4 层递归上限**（`depth > 4`）此前只写在函数注释里 ⇒ 已登记进本节
   （「残留边界」清单）与 CHANGELOG 的总体边界。
3. **`ci.yml` 的机制描述与实测不符**：旧注释写「skipped 不进 tests 计数」——实测
   `t.skip()`/`it.skip()` **会**进 `# tests`、**不进** `# pass`（`# tests 4 / # pass 2 / # skipped 2`）。
   守卫本身正确（真正拦住第二个 skip 的是 `# pass` 下限），但错注释会误导后人 ⇒ 已改成正确表述。
4. **`lib/host-approval.js` 注释举例错误**：把 `{argv:['rm','-rf','/']}` 说成 `argsTextOf` 要救的
   那一格，而该形态实测判不出来（登记为残留是对的，注释动机自相矛盾）⇒ 例子换成
   `{shell: 'rm -rf /tmp/x'}`，并把 argv 形态显式写成「**不在**这一格能救的范围」。
5. **CHANGELOG 里已被推翻的「不覆盖」清单**（`sudo rm -rf`/`command rm -rf`/`bash -c`/`xargs rm`/
   `git -C push`/`pnpm publish`/`yarn publish`）与定稿轮矛盾 ⇒ 已在原地标注 **已作废**（保留原文对照）。
6. **尾斜杠被先剥掉再套文件判据** ⇒ `/a/b/foo.d/` 被放大到 `/a/b`。改为「原始串以分隔符结尾
   ⇒ 直接当目录原样保留」（`/a/b/foo.d/ → ['/a/b/foo.d']`；`/a/b/foo.d → ['/a/b']` 照旧）。
7. **`write`/`edit` 的「多弹一次」触发条件比文档更窄**（实测只有危险命令位于**行/段首**才触发：
   `content='see git push docs'` 照旧放行，`content='rm -rf /tmp/x'` 或含换行前缀才 `next()`）
   ⇒ 注释与 CHANGELOG 都按实测口径写精确，**不改行为**。
8. **`~` 未展开的路径原样进预填**（`~/.ssh/id_rsa → ~/.ssh`，落成一条可能永不命中的**目录前缀**
   规则）⇒ 预填阶段对**非绝对路径**（`~…`、`./…`、相对路径）一律原样保留、不推父目录
   （`~/.ssh/id_rsa → ['~/.ssh/id_rsa']`：只精确匹配它自己那一条，严格更窄）。

#### 测试与转红（第四轮）
- 用例数 509 → **518**（+9：判据层 6 条 —— `shell-stdin`、`-c` 粘连、转义引号、`-exec`、
  `yarn npm`、`wrapper-nesting`；弹框预填 3 条 —— 裸 `.git`、尾斜杠、非绝对路径）。
  `.github/workflows/ci.yml` 的 `MIN_TESTS` 同步 509 → **518**（并注明第四轮的来源）。
- `node --test test/*.test.js` → `# tests 518 / # pass 518 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`，退出码 0。
- `node verify.mjs` → 退出码 0（v1.12.6 一致性链 + 11 工具）。
- **转红①（B1）**：`lowerSet` 改回 `new Set(arr)` ⇒ 四条取值选项用例全红
  （`pnpm -C /tmp publish → null`、`npm -C /tmp publish → null`、`sudo -C 3 rm -rf /tmp/x → null`、
  `env -S 'ls; rm -rf /x' → null`），**恢复后 `cmp` 逐字节全等 + md5 回到变异前记录的基线 + 变异标记 grep 计数 0**。
- **转红②（M1-③）**：`inline` 收口改回 `''` ⇒ `bash -c'rm -rf /x'` 判据层与监听器层一起红；恢复自证同上。
- **转红③（M2）**：`FILE_FORM_RE` 的 `.git` 可选组加回去 ⇒ `dirsOfPaths(['/repo/.git'])`
  实测 `['/repo'] ≠ ['/repo/.git']` 红；恢复自证同上。
  三次变异都遵守「先记录基线 md5 + 先复制 pristine 副本，再动原文件」，避免恢复动作本身把
  破坏写回交付状态（假绿）。

#### 第四轮冻结凭据（自指说明同前）
- 协议：`tar -czf /tmp/dsh-agent-dispatch-1.12.6-freeze.tar.gz --exclude=node_modules --exclude=.git .`
  —— 在**本节写入之后**执行，故包内 `CHANGELOG.md` 与本文件逐字节一致。
- 包自身的**成员数 / 字节数 / md5 / sha256**，以及解包后
  `diff -r -x node_modules -x .git` 的结果，由交付报告给出（把包自己的 md5 写进包内会改变它
  自己，构造上不可能自含）。
- **逐文件 md5（第四轮冻结时点）**：`index.js` `abb8decddc6276b1b690e6b096e5670e`（本轮未动）、
  `lib/host-approval.js` `73bdbf0720664b629a12d2cc566f4664`、
  `lib/client.js` `2950680af8a5b4ace70573f173c9d3db`、
  `lib/dispatch.js` `c415c59b661e437a666a1606dd23a7db`（未动）、
  `package.json` `e1bd0bb661aa5ad0c1a84a978234bb36`（未动，版本仍是 1.12.6）、
  `verify.mjs` `3f768b55932c7da38971fda0c7919194`（未动）、
  `.github/workflows/ci.yml` `b1e13a422d6116e4bfc2136ebeea0fe7`、
  `test/dangerous-command-gate.test.js` `197e0a693204b0e6e8da1a5a830e56cb`、
  `test/grant-dialog.test.js` `4e5de48700109273f24ae6e0ac7151a5`、
  `test/invariants-1-12-6.test.js` `cf884056eef37bba1f14098a1a96dbff`（未动）。
  `CHANGELOG.md` 自身的 md5 不在表里（自指），以交付报告为准。
- 冻结时刻见交付报告；此后不再触碰本工作区。
- 仍然：未部署、未重启宿主、未动 `~/.dsh`、未 `git add`/`commit`、未切 ref、版本保持 1.12.6。

### 第五轮（独立终审四审：3 Major + 3 Minor 的收口 + 一条用户新裁定）
**上面三包（10:57 / 11:15 / 11:40）都已作废**：终审确认上一轮修的 B1/M1/M2 与 6 个 Minor
全部真修好、既有断言未被放松（删除的 `assert`/`it` 行均为 0）、3 项变异转红与自报逐字一致；
但同一族里又抓到 3 个 Major（M-A/M-B 必修，M-C 半修半登记）+ 3 个 Minor。
本轮逐条收口后**再次重打冻结包**（凭据见本节末）。版本仍是 **1.12.6**（从未发布，不跳号）。

#### 🟠 M-A（必修）：`execSubcommandIndex` 的下标 0 盲区 ⇒ multi-exec 静默放行（已收口）
- **现象（终审实测）**：`find /tmp -exec echo {} \; -exec rm -rf {} +` ⇒ 判据层 **MISS**、
  监听器层 `res="allowed-once" nextCalled=false`（**静默放行**）；单独的 `-exec rm -rf {} +`
  （段首就是 `-exec`）同样 MISS；而只有一个 `-exec` 且不在段首的 `find … -exec rm -rf {} +` 命中。
- **根因**：`execSubcommandIndex` 写的是 `for (let i = 1; …)`。`splitSubCommands` 会把 `;` 切成
  子段，而 `;` 正是 `-exec … {} \;` 的终止符 ⇒ 第二段是 `" -exec rm -rf {} +"`（**段首就是
  `-exec`**），下标 0 永不参与识别。
- **修法**：`lib/host-approval.js:672` 起始下标 `1` → **`0`**（并把「为什么必须是 0」写进 JSDoc）。
  从 0 起扫只会**多**识别「段首就是 `-exec`」的写法，不会让任何原本命中的写法失效。
- **验收**：判据层与监听器层各补一条 multi-exec 用例（覆盖 `find /tmp -exec echo {} \; -exec rm -rf {} +`
  与段首 `-exec rm -rf {} +`，另配 `-exec ls {} +` / `find . -exec grep -l foo {} +` 守卫）。
- **转红①**：把 `i` 改回 `1` ⇒ 两条 `-exec` 用例与监听器层探针一起转红（见本节末）。

#### 🟠 M-B（必修）：非绝对路径被丢弃后**静默退化成工具名档** ⇒ 授权放大到整个工具（已收口）
- **现象（终审端点级原始输出）**：`POST paths:['./x.txt']` → `HTTP 200
  {"paths":[],"toolName":"read","pathsSource":"user","dropped":[{"reason":"非绝对路径"}]}`
  \+ 日志「路径声明为空 ⇒ 只写工具名档」⇒ 随后对**完全另一个文件** `/etc/passwd` 的 read
  变成 `allowed-once`（**放大到整个工具**）。绝对路径对照不放大。
- **5 跳证据链**：`extractToolPathGroups({file_path:'src/index.ts'})` 原样留相对路径
  （`lib/host-approval.js:252-253`）→ 客户端 `dirsOfPaths` 非绝对原样（`lib/client.js:734-737`）
  → 该组**默认勾选**（`lib/client.js:929-934`）→ 服务端丢弃（`lib/host-approval.js:144-148`）
  → `index.js:2066-2076` 落 `addToolGrant`。
- **服务端修法（第二道防线）**：`index.js:2059-2108` 区分「**给了路径但一条都不合法**」与
  「**本来就空**」——两者天然可分（真删空时 `dropped === []`，全非法必然带 `dropped`）：
  前者 **不写任何档（会话档 / 落盘档 / 工具名档都不写）并回 400** + 逐条 `dropped` 原因；
  后者保持「只写工具名档」的既有语义（**弹框删空 ⇒ 工具档**这条不变式未被触碰）。
  新增日志动作 `rule-rejected-all-paths-dropped`（排障要能区分「声明被整体拒绝」与「用户没声明」）。
- **客户端修法（上游正解，用户裁定，见下一节）**：预填阶段就把**相对路径按工作区目录
  `cwd` 拼成绝对路径**再进编辑框；拼不出来的（`~` 未展开 / 没拿到 cwd）**原样显示但强制
  不勾选**，并在该行下给一条可读提示（`⚠ 非绝对路径：…服务端只认绝对路径，会把它丢弃 ⇒
  这条不会写入规则`），用户改成绝对路径后提示自动收起。**默认勾选一条注定被服务端丢弃的
  路径**这条链路（M-B 的入口）从此不存在。
- **验收**：端点层 4 条 —— ① `paths:['./x.txt']` ⇒ 400 且**没有任何规则被写入**（会话档与
  落盘档都不得出现，尤其不得 `toolGrant`），且随后对 `/etc/passwd` 的 read **仍然弹窗**；
  ② `paths:[]`（真删空，`dropped:[]`）⇒ 仍只写工具名档（既有行为，必须保持）；
  ③ `paths:['/abs/a.txt']` ⇒ 正常只写路径档（换目录仍弹）；④ 混合声明 ⇒ 200 且只写合法那条。
  弹框层 3 条 —— 非绝对路径强制不勾选 + 行下提示 + 不随确认发出；`cwd` 缺失时文案说清是缺 cwd；
  改成绝对路径后提示收起且可勾选。

#### 🟠 M-B 附：用户新裁定 —— 相对路径先用工作区目录拼成绝对路径（本轮并入）
- 用户原话（paraphrase）：「相对路径，自动用工作区目录拼写完整再放入编辑区吧。」
- 实现：`lib/client.js` 新增 `resolveAgainstCwd(rel, cwd)`（纯词法：拼 cwd + 相对段、丢 `.` 段、
  消 `..` 段、折叠重复分隔符）与 `dirsOfPaths(paths, cwd)` 的第二参数；`cwd` 来源是
  `GET /agent-api/host-approval-context` 已回传的 `resolveApprovalContext().cwd`，宿主通道
  （蓝球）已接线（`item.cwd`）；琥珀通道透传 `p.cwd`（产品侧当前不透传该字段 ⇒ 等价于原样，
  走降级分支），且用新增的 `absolutizeDirs`（**只补绝对化、不套文件形态**）避免把产品侧
  已经目录化的「名字像文件的目录」再取一次父目录。
- **两条不猜（返回 null ⇒ 降级）**：`~` 开头（宿主与服务端都不展开它，猜错方向是把授权挪到
  **别的**目录）、`cwd` 缺失或自身不是绝对路径。
- **既有断言改动（逐条，理由=本裁定推翻了第四轮的做法）**：
  `test/grant-dialog.test.js` 的用例 `Minor（第四轮终审）：非绝对路径…原样保留，不推父目录`
  已**重写**为 `第五轮（用户裁定）：非绝对路径**按 cwd 拼成绝对路径**再进编辑框`，其中
  4 条断言逐条换向：`dirsOfPaths(['./x.txt']) === ['./x.txt']` → `dirsOfPaths(['./x.txt'], '/proj') === ['/proj']`；
  `['sub/dir/a.txt'] === ['sub/dir/a.txt']` → `['sub/dir/a.txt'], '/proj') === ['/proj/sub/dir']`；
  `['~/.ssh/id_rsa'] === ['~/.ssh/id_rsa']`（无 cwd）→ 保留但**加 cwd 仍原样**（`~` 降级，两条都断）；
  `['~/.ssh/id_rsa.pub']` 同上。**绝对路径那 3 条（`/a/b/x.txt`、`C:\a\b\x.txt`、`/repo/.git`）一字未动**，
  并新增 `cwd` 缺失 / `cwd` 非绝对 / 盘符路径不套 cwd 的对照。
  另：`test/grant-dialog.test.js` 的源码接线断言 `…dirsOfPaths(p.paths)` 锚点随调用点更新为
  `…? absolutizeDirs(p.suggestedDirs, amberCwd) : dirsOfPaths(p.paths, amberCwd)`（语义未放宽）。
  删除的 `assert` / `it` 行数为 **0**（只换向、只追加）。

#### 🟠 M-C（半修半登记）：残留清单未声明完整 + 口径冲突
- **现象（监听器层静默放行）**：`source script.sh`、`. script.sh`、`doas rm -rf /tmp/x`、
  `setsid rm -rf /tmp/x`、`./deploy.sh`；判据层另有 `chroot`/`ionice`/`taskset`/`watch`/`parallel`/
  `npx`/`yarn dlx`/`docker run … rm -rf` MISS。
- **① 同族包装器补齐**（`lib/host-approval.js:512-521`）：`TRANSPARENT_WRAPPERS` 追加
  `doas` / `setsid` / `chroot` / `ionice` / `taskset`；配套补 3 张表 ——
  `WRAPPER_VALUE_OPTIONS` 增 `doas`/`ionice`/`taskset` 的**取值选项**（`-u root`、`-c 3`、
  `-c 0-3`…），并新增 `WRAPPER_POSITIONAL_ARGS = { chroot: 1 }`：`chroot NEWROOT COMMAND…`
  的第一个**位置参数是新根**，不跳过它真程序名就变成 `/mnt` ⇒ 仍然静默放行。
  加进这张表只会**多**弹（同一份规则判被包装的命令），不会少弹。
- **② `source` / `.` 与 `shell-stdin` 同原则**：新增门名 `SHELL_SOURCE_RULE = 'shell-source'`
  （**可疑**档，保守转交互）。`source deploy.sh` / `. deploy.sh` 与 `bash deploy.sh` **同义**
  （在当前 shell 里读脚本文件执行，正文静态不可判定），改前后者已转交互、前者却放行 ——
  **口径冲突**就此消除。守卫：**不带参数**的 `source` / `.`（什么都不执行）、
  `command -v source`（`-v` 是查询开关，剥掉 `command` 后只剩 `['source']`）、
  文本里"提到"（`echo source x.sh`）一律不命中。
- **③ 已知不覆盖（本轮声明，逐条对应实测）**：下列写法**判据层与监听器层都不命中**
  （判不出来 ≠ 放行，读取侧的保守策略与工具名档照旧各自生效）：
  | 写法 | 为什么不做静态判定 |
  |---|---|
  | `npx rm -rf /tmp/x` | `npx` 先解析包名再执行，命令正文不在命令行里 |
  | `yarn dlx rm -rf /tmp/x` | 同上（dlx 会联网取包） |
  | `docker run -v /:/h ubuntu rm -rf /tmp/x` | 真命令在**容器镜像内**，宿主侧静态不可见 |
  | `parallel rm -rf /tmp/x` | 参数按块展开后再执行，需要理解 GNU parallel 的模板语法 |
  | `watch rm -rf /tmp/x` | 周期性执行，语义由 watch 自己重建命令 |
  | `./deploy.sh`（脚本文件直执行） | 与 `make deploy` 同类：要读文件才知道正文（`bash deploy.sh` 已按 shell-stdin 转交互，因为解释器在段首） |
  | 危险命令出现在第 **256KB 附近及之后** | 判据文本有界截断的取舍：切点是**字符下标上的硬切**（起点落在 262136 仍命中、262141/262143 被切残 ⇒ MISS），见 Minor 2；`commandText` 一侧自第六轮起超限即保守转交互 |
  | `su --version` / 裸 `su`（无 `-c`） | 第六轮新登记：交互登录 shell ⇒ 按 `su-shell` 保守转交互（**多弹一次**，与 `bash --version` 同族，不加豁免） |
- **验收**：判据层 + 监听器层各一条用例覆盖 `source`/`.`/`doas`/`setsid`/`chroot`/`ionice`/`taskset`
  （含取值/位置参数与误伤守卫）；CHANGELOG 清单与上表逐条对应。

#### 🟡 Minor（本轮一并处理，逐条）
1. **`dirsOfPaths(['C:\\'])` → `['C:']`**：尾分隔符分支原先只挡字面 `/`，绕过了 `parentDirOf`
   的盘根守卫。新增 `ROOT_LIKE_RE = /^(?:[a-zA-Z]:)?[/\\]*$/`，在 `dirsOfPaths` / `absolutizeDirs`
   / `resolveAgainstCwd` 三处统一「盘根不参与」（`C:\`、`C:`、`//` 一律丢）。服务端本来也会按
   「根目录」丢弃它，但空预填 + 用户点确认拿 400 正是 M-B 的触发路径之一，预填阶段就不该出现。
2. **热路径性能**：`dangerousCommandMatch(argsText)` 实测 0.1MB=25ms / 1MB=268ms / **4MB=889ms**
   （同步阻塞宿主事件循环）。新增 `MAX_DANGER_TEXT_CHARS = 256 * 1024` 与 `boundDangerText()`，
   `index.js:386-401` 在**判定前**截断（`commandText` 与 `argsText` 各一次），超限时落一条
   `danger-text-truncated` 留痕（含截掉的字符数）；`resolveApprovalContext` 返回的原文**不动**
   （下面的「执行类解析不出命令文本 ⇒ 不自动放行」仍按**完整** `commandText` 判）。
   **取舍（明写）**：超长参数只检查前 256KB ⇒ 第 256KB 之后才首次出现的危险命令不再自动转交互。
   另一条路（超限即保守转交互）被否掉：argsText 含 `write` 的正文，大正文是**常态**，
   那条路会让每次大写入都强制弹框。真正的解法是「按段有界扫描/流式词法扫描」，本轮不做。
3. **`shell-stdin` 的代价**：`bash deploy.sh` / `bash --version` / `bash --help` / `sh ./install.sh` /
   `sh -n script.sh` / `zsh -l` 会**多弹一次**（安全方向）。**本轮不加豁免**；终审建议的
   「只给纯 `--version` / `-V` / `--help` 开一个窄口子」登记为**后续可选优化**，
   要做必须单独一轮 + 转红实验（放行面只对「解释器 + 单个纯信息开关」）。
4. **`test/tool-grant-session.test.js` 的注入表**：handler 体新增闭包引用
   （`boundDangerText` / `MAX_DANGER_TEXT_CHARS`）⇒ `CLOSURE_NAMES` 与 `compileHandler` 的
   注入实参同步登记。`handlerNameDrift()` 硬守卫**未被放宽**（它当场报出了这次漏登记，
   顺带发现「注释里写 `O(...)` 会被它当成函数调用」这个假阳性来源，已改成中文表述）。
5. **`verify.mjs` 的顺序哨兵**随调用点更新（`dangerousCommandMatch(ctxInfo.commandText)` →
   `dangerousCommandMatch(dangerCmd.text)`），并**新增**一条「截断必须早于判定」的字符串断言。

#### 测试与转红（第五轮）
- 用例数 518 → **531**（+13：判据层/监听器层 +5、端点层 +4、弹框预填 +4）。
  `.github/workflows/ci.yml` 的 `MIN_TESTS` 同步 518 → **531**（来源已写进注释）。
- `node --test test/*.test.js` → `# tests 531 / # pass 531 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`，退出码 0。
- `node verify.mjs` → 退出码 0（v1.12.6 一致性链 + 11 工具）。
- `node --check`：`index.js` / `lib/host-approval.js` / `lib/client.js` / 三个测试文件全过。
- **转红①（M-A）**：`execSubcommandIndex` 起始下标改回 `1` ⇒ `find … \; -exec rm -rf {} +` 与
  段首 `-exec rm -rf {} +` 两条用例转红（判据层实际返回 `null`）。
- **转红②（M-B）**：去掉 400 分支 ⇒ 端点用例 M-B① 转红（`200 ≠ 400`，且 `read /etc/passwd`
  随后 `allowed-once` = 放大复现）。
- **转红③（M-C②）**：去掉 `source`/`.` 的保守判定 ⇒ `source script.sh` / `. script.sh` 两条
  用例转红（判据层 `null`、监听器层 `allowed-once`）。
- **转红④（用户裁定）**：把「按 cwd 解析」改回「原样保留」⇒ `dirsOfPaths(['./x.txt'], '/proj')`
  实测 `['./x.txt'] ≠ ['/proj']` 转红。
  四次变异都遵守「**先记录基线 md5 → 先复制 pristine 副本 → 再动原文件**」，避免恢复动作本身
  把破坏写回交付状态（假绿）；恢复自证 = `cmp` 逐字节 + md5 回基线 + `MUT-` 标记 grep 计数 0 + 复跑全绿。
  （第七轮 m4 口径勘误：这里的「grep 计数 0」应读作「**源码文件**里计数 0」——
  `lib/`、`test/`、`index.js`、`verify.mjs` 一律为 0；**全仓**有 6 处命中，全部在
  `CHANGELOG.md` 自身（历轮把变异标记 `MUT-R6-1` / `MUT-M4R` 之类写进文档）。）

#### 第五轮冻结凭据（自指说明同前）
- 协议：`tar -czf /tmp/dsh-agent-dispatch-1.12.6-freeze.tar.gz --exclude=node_modules --exclude=.git .`
  —— 在**本节写入之后**执行，故包内 `CHANGELOG.md` 与本文件逐字节一致。
- 包自身的**成员数 / 字节数 / md5 / sha256**、解包后 `diff -r -x node_modules -x .git` 的结果
  由交付报告给出（把包自己的 md5 写进包内会改变它自己，构造上不可能自含）。
- **逐文件 md5 全表（第五轮冻结时点，65 个文件；不含 `CHANGELOG.md` 自身）**：

```text
  `.github/workflows/ci.yml` `7140db8c46c0dd7044c8a599f8131e8c`
  `.gitignore` `fc9d54f7afb97c0d762a0dc93ec64ff8`
  `.qoder/settings.local.json` `b0b9282667dcaade2d18528a237cd76d`
  `LICENSE` `6cc0f1157ee6fec2c6fc4f612fa0bce0`
  `README.en.md` `aa34e20873f8a77c9beb6e1c01a9577c`
  `README.md` `ed9bf09567fb14fc0882a116ba1d62aa`
  `cordis.patch.yml` `6344d499f05d66b13910d41f3310bb09`
  `docs/screenshots/agents.png` `6a30c4c3fea4b4599c6fc22856f02353`
  `docs/screenshots/fab-done.png` `f3c73094c4ea09c96884991b5ae0248b`
  `docs/screenshots/fab-idle-1.png` `28043676b9a6086d267648c75dc9ee33`
  `docs/screenshots/fab-idle-2.png` `48ab4b13a0dbd5061ebb1238422c7444`
  `docs/screenshots/fab-running.png` `17efd4ab12a948d6ff0492d525e99c6b`
  `docs/screenshots/history.png` `d89bfde07f90548ad00a49dbe920181a`
  `docs/screenshots/overview.png` `6ba0684ec70bfabf3af13440e59be7a5`
  `docs/screenshots/popup-agents-squads.png` `43994906eb5bc31018eff73ff5226812`
  `docs/screenshots/popup-running.png` `5435027f217509c88f9efd843a54682c`
  `docs/screenshots/popup-settings.png` `10697535447b3d3a5a27ac5bda5a385b`
  `docs/screenshots/squads.png` `acb125e19badaa3d37ef97c5eeac36e4`
  `index.js` `700dfc8f9bcce5da78f5f4e06da66aad`
  `kiligzzz-dsh-agent-dispatch-1.11.21.tgz` `abee2cabce1248a9f857c7ed19852296`
  `kiligzzz-dsh-agent-dispatch-1.11.22.tgz` `962754751a70c7c375cce68265488a37`
  `kiligzzz-dsh-agent-dispatch-1.11.23.tgz` `609fb395e941ff25e317ce89c1d30d5d`
  `kiligzzz-dsh-agent-dispatch-1.11.24.tgz` `22e7e7fadfe7fc383b06ac92e9b40d7b`
  `lib/agents.js` `cc09bf96e6ad363e18b3ee85e10dd509`
  `lib/client.js` `f23b9de5254ad9b4834e701ba074471f`
  `lib/defaults.js` `f29387cda5012a199e9678e17390d81a`
  `lib/dispatch.js` `c415c59b661e437a666a1606dd23a7db`
  `lib/fab-config.js` `e68aaf76cf31904164b3e7ee97ef842b`
  `lib/health.js` `7a2d06235e40a61facf742ff8dd8e82a`
  `lib/host-approval.js` `26d629ce030892a5c9d029c555260bf5`
  `lib/json-safe.js` `cb39c2aeb84952a416aa8ae02c9cd43b`
  `lib/roster.js` `d9ee0131ac9ad2be8ef3e1c4485ca771`
  `lib/skill-import.js` `05fbcecfdcd795d5f0921de159f6e345`
  `lib/squad-registry.js` `16efbdc7adbbc655a80aa40766b6d4d4`
  `lib/squads.js` `03cd42b9a961d4b17e5cd40601756ffb`
  `package.json` `e1bd0bb661aa5ad0c1a84a978234bb36`
  `test-p1p2-smoke.mjs` `bb9b72c42f1509e63186153f199a6f31`
  `test/acp-config-fallback.test.js` `3961d7af0d3e310db4740a0f9c037c48`
  `test/acp-twin.test.js` `e7bc1a55cb9331e668963525faf4a55e`
  `test/agent-api-catalog.test.js` `4e8d5c3f8c62e91a6e40f6a9ec93117f`
  `test/agent-api-harness.js` `7b48c19983cc6244cd44bfd8e448a178`
  `test/childid-continuation.test.js` `b1ec780a6529fd841dfd27154ecf0916`
  `test/client-form-logic.test.js` `109e524ef93378bbf0c9b791b963ddc5`
  `test/dangerous-command-gate.test.js` `8a3e716041248cb619051d5ae34d98fa`
  `test/dedup.test.js` `e93881ba9677de3351c54a29a9ebc243`
  `test/fab-panel-layout.test.js` `378f9de86246e67bf01fa02fb3034882`
  `test/failover-claim-race.test.js` `735e23e878a2f1e191a766a3aea2570f`
  `test/failover-notify.test.js` `542597bd87c1cedde09bbe7a3d8fb2f0`
  `test/failover-settlement.test.js` `c23fe799487e6bde3d198c04a40ca047`
  `test/failover.test.js` `07030770e5af9067f538a0c4ab99feff`
  `test/grant-dialog.test.js` `24d56e81abcc0037847fb13647737c5a`
  `test/helpers/failover-host.js` `f725f9052a4b54cd66c171d6338048c0`
  `test/host-0.2-compat.test.js` `e2d46d0cebf92864d746434997a9be04`
  `test/host-approval-endpoint.test.js` `013bddf8f80f5bb0d9e91ad50d5838e9`
  `test/host-approval.test.js` `72779f38918a1e163406884105d334c9`
  `test/interrupt-no-failover.test.js` `bef2189f6bcd2a817f05b7556b744fec`
  `test/invariants-1-12-6.test.js` `cf884056eef37bba1f14098a1a96dbff`
  `test/perm-fab-jump.test.js` `ceb1e12feae9a0b23efecbbc17f0c412`
  `test/permission-pending.test.js` `83dc18eb17551f07b1dcaf47c04e3039`
  `test/plugin-diagnostic-log.test.js` `cda1a98981d674b32111ca808765a77b`
  `test/roster-section.test.js` `1553c426468cd1b82ad425a6f7a542f0`
  `test/route-validation.test.js` `5d0497e815613ced7611d9db07911687`
  `test/session-source-v4.test.js` `87156b4abd7dbe3f9f336da6b288daea`
  `test/tool-grant-session.test.js` `6ee4f33f2d3ad193e2cc55b23d06578f`
  `verify.mjs` `345e3e8fb876f443f9c9c5ddc060ac49`
  ```
- `CHANGELOG.md` 自身的 md5 不在表里（自指）：表列的是**写入本节之前**其余 65 个文件的状态，
  本节写入后立刻执行上面的打包协议，故包内这些文件与本表逐字节对应，以交付报告给出的
  包 md5 为最终凭据。
- 冻结时刻见交付报告；此后不再触碰本工作区。
- 仍然：未部署、未重启宿主、未动 `~/.dsh`、未 `git add`/`commit`、未切 ref、版本保持 1.12.6。

### 第六轮（收尾轮：1 Major「9 个同族包装器」+ 4 Minor 的收口）
**先查现场再动手**：本轮开工前逐文件比对「工作区 vs 第五轮冻结包解包副本」——
`diff -r -x node_modules -x .git` 输出 0 行、逐文件 md5 清单 66 个文件全等，
即上一个执行者**没有**留下半成品（现场 = 冻结包原样），本轮在此基础上继续。
版本仍 **1.12.6**（从未发布，不跳号）；未部署、未重启宿主、未动 `~/.dsh`。

#### 🟠 M-D（必修）：9 个同族包装器仍静默放行，且「已知不覆盖」清单未登记
- **现象（判据层 + 监听器层，逐条实测）**：`unshare -m rm -rf /x`、`nsenter -t 1 -m rm -rf /x`、
  `strace -f rm -rf /x`、`firejail rm -rf /x`、`systemd-run --user rm -rf /x`、
  `su root -c "rm -rf /x"`、`runuser -u root -- rm -rf /x`、`setarch x86_64 rm -rf /x`、
  `prlimit rm -rf /x` 改前**全部 MISS** ⇒ 监听器层在「已授权 bash」下全部 `allowed-once`。
- **根因**：`TRANSPARENT_WRAPPERS` 只补过 `doas`/`setsid`/`chroot`/`ionice`/`taskset`；
  这 9 个既不在该表、也不在 `DANGEROUS_COMMAND_RULES`。它们与 `setsid` 同族
  （换身份/环境/跟踪器跑**同一条**命令），**词法可判定**。
- **修法**（`lib/host-approval.js`）：
  · `TRANSPARENT_WRAPPERS` 追加这 9 个；`SU_WRAPPERS` 单列 `su`/`runuser`（见下）。
  · `WRAPPER_VALUE_OPTIONS` 按**各自真实 CLI 语义**（man 页）补取值选项，**只列「吃掉下一个
    token」的**：nsenter `-t/--target -N/--net-socket -G/--setgid -S/--setuid`
    （`-m/-u/-i/-n/-p/-U/-C/-T/-r/-w/-W` 是 `[=file]` 可选附着形态，不列）、
    unshare `-R/--root -w/--wd -S/--setuid -G/--setgid --map-user/--map-users/--map-group/
    --map-groups --owner --propagation --setgroups -l/--load-interp --monotonic --boottime
    --whitelist-env`（`-r` 是 `--map-root-user` **开关**、`-R` 才取值）、
    strace `-e -E -p -u -b -I -P -a -o -s` + 长选项（`-f/-F/-D/-c/-C/-k/-n/-N/-q/-t/-T/-v/-x/-y`
    全是开关）、firejail **一个都不列**（它的取值选项全是 `--opt=value` 形态，不吃下一个 token）、
    systemd-run `-u/--unit -p/--property -E/--setenv -H/--host -M/--machine --description --slice
    --service-type --uid --gid --nice --working-directory --on-* --path-property --socket-property
    --timer-property`（`--user` 是**开关**，正是验收用例里那条）、
    su/runuser `-c/--command -g/--group -G/--supp-group -s/--shell -w/--whitelist-environment
    --session-command`（runuser 另有 `-u/--user`）、setarch `-p/--pid`、prlimit `-o/--output -p/--pid`
    —— 用户清单里的 `prlimit --pid/-n` 按 man 页真实语义修正为 **`--pid/-o`**：`-n` 是
    `--nofile[=limits]` 的**可选附着**形态，`-n 1024` 那个 `1024` 是位置参数、不会被 `-n` 吃掉
    （列成取值选项反而会把真程序名吃掉 ⇒ 漏判）。
  · `WRAPPER_POSITIONAL_ARGS` 的值改成**候选数组**：`{ chroot: [1], setarch: [1, 0] }` ——
    `setarch [arch] [options] [program …]` 的 `arch` 自 util-linux 2.33 起**可选**
    （man 页例子 `setarch --addr-no-randomize mytestprog` 的第一个位置参数就是程序名，
    而 `setarch ppc32 rpmbuild …` 里是 arch），词法上分不出是哪种 ⇒ 两个候选**都判一遍**
    （**并集**，只多弹不少弹：`setarch x86_64 rm -rf /x` 与 `setarch -R rm -rf /x` 都命中）。
  · **`su` / `runuser` 单列**（`SU_WRAPPERS`）：`-c '<正文>'` 的正文经空白切分只剩半个词
    （`su root -c "rm -rf /x"` → `-c`、`"rm`、`-rf`、`/x"`），通用剥壳无论把 `-c` 当开关还是当
    取值选项都会把正文拼坏 ⇒ 剥壳循环**一见它们就原样交回**，由新的 `matchSuShell` 判：
    有 `-c`/`--command`/`--session-command` ⇒ **按 `shell -c` 同原则**解析正文再喂给**同一份规则**
    （递归深度同一把尺子，用尽按 `SHELL_DEPTH_RULE`）；没有 `-c` ⇒ 剥掉自身选项与可选用户名
    （`runuser` 的 `-u` 与位置参数用户名**互斥**）后继续判，**什么都不剩**（`su`、`su - root`、
    `su --version`）＝ 交互登录 shell ⇒ 新门名 `SU_SHELL_RULE = 'su-shell'`（**可疑**档，
    保守转交互），与 `shell-stdin` / `shell-source` 同一原则。
  · **附带修一处误伤**：`command -v su` / `command -V su` / `command -p -v su` 是 `command`
    内建的**查询**开关（打印路径，**不执行**）。改前靠 `source` 分支 `tokens.length > 1` 的
    副作用侥幸挡住，而 `su` 的「只剩它自己 ⇒ 可疑」必须在同形下成立，两者剥壳后
    **长得一模一样** ⇒ 新增 `isCommandQuery()` 在**原文层**把查询形态认出来（只豁免这两个开关）。
    ⚠️ **第七轮 m2 文档精度（把边界写准，免得被当少弹重开）**：这是**整段豁免** ——
    一旦段首是 `command` 且紧跟（可隔一个 `-p`）`-v`/`-V`，**整段**都不判，不只豁免
    `su`/`source` 那两条。**连带被放过的形态**（实测全部 MISS）：
    `command -v rm -rf /x`、`command -v env rm -rf /x`、`command -v busybox rm -rf /x`、
    `command -v sudo rm -rf /x`、`command -v su rm -rf /x`、`command -V busybox rm -rf /x`、
    `command -p -v env rm -rf /x`。语义上这是**正确**的（POSIX：`command -v` 只打印路径、
    **从不执行**它的操作数），属刻意边界而不是漏判。**跨段不受影响**：
    `command -v su; rm -rf /x` 仍命中 `rm -rf`、`command -v rm; git push` 仍命中 `git push`
    （`splitSubCommands` 先按 `;`/`|`/换行分段，再逐段判）。
- **验收**：判据层 + 监听器层各覆盖 9 条验收命令 + 各自的取值/位置参数变体 + 叠加与嵌套
  （`sudo su root -c …`、`bash -c "su … -c …"`、`find /tmp -exec su root -c … +`、
  `unshare -m npm publish`、`strace -f git push`）；误伤守卫判据层 24 条 / 监听器层 22 条
  全 MISS / 全 `allowed-once`。

#### 🟡 Minor（本轮一并处理，逐条）
1. **B1 反向断言空转（终审已独立证实）**：`test/invariants-1-12-6.test.js` 的
   `/scope === 'project'[\s\S]{0,1200}isDisallowedAutoGrant/` 窗口从
   `case '/agent-api/host-approval-rule'` 起算只有 1200 字符，而 `scope === 'project'` 的三处
   出现点在 **+9413 / +9679 / +9766**，`isDisallowedAutoGrant` 只在 +426 / +4860 ⇒ **正则永不匹配**、
   `=== false` 恒真（守卫名不副实）。**二选一里选「锚定到项目档分支整体」**（不删，因为这条
   性质仍值得守、`test/host-approval-endpoint.test.js` 只守行为层）：切出**整个端点体**
   （`case '/agent-api/host-approval-rule'` → `'/agent-api/active'`，实测 10178 字符）、
   **去掉注释**（窗口里那 2 次提及**都在注释里**，不去注释照样恒真）、再查标识符；并加两条
   **正向锚**（写侧判据那一行 + `appendProjectRule(`）证明窗口没跑空 —— 否则锚点一改名，
   这条又会退化成空转断言。
2. **截断边界描述不精确**：`boundDangerText` 是**字符下标上的硬切**，不是「切在命令边界上」
   ⇒ 危险命令**起点**在 262136（上限 - 8）时仍完整命中，在 262141 / 262143 会被切残
   （`rm -rf` 只剩 `r`）⇒ MISS。声明从「第 256KB 之后不判」改成「**第 256KB 附近及之后**不判」，
   `boundDangerText` 的 JSDoc 与 `DANGEROUS_COMMAND_RULES` 的覆盖边界注释都写明取舍；
   新增一条用例把边界钉死（上限 - 8 命中 / 上限 - 3 MISS / 不超限不截）。
3. **`commandText` 超限改为保守转交互**：`commandText` 是**真正的 shell 正文**
   （`command`/`cmd`/`commandLine`/`commandline`/`script` 五个键），超长不是常态 ⇒ 超限即按新门名
   `COMMAND_TOO_LONG_RULE = 'command-too-long'` 保守转交互（**同一位置**：危险门内、早于工具名
   短路与一切档位；留痕 `action: 'danger-command-block'` + 暂存上下文带 `dangerRule`，
   UI 因此说得出「每次都问、不可记忆」）。**`argsText` 保持截断不动**（含 `write` 的正文，
   大正文是常态），并有对照用例钉住这条口径差。handler 体新增闭包引用
   `COMMAND_TOO_LONG_RULE` ⇒ 按既有硬规矩在 `test/tool-grant-session.test.js` 的
   `CLOSURE_NAMES` / `compileHandler` 注入表登记（漏登记 = ReferenceError 被 handler 的
   try/catch 吞掉 ⇒ 退化成放行）。
4. **`resolveAgainstCwd` 加绝对路径前置**（`lib/client.js`）：`rel` 本身已是绝对路径（含盘符形态）
   ⇒ 直接返回（盘根仍按 `ROOT_LIKE_RE` 丢弃），**不再拼 cwd**。两个调用点都有 `ABS_PATH_RE`
   前置 ⇒ 这条路径**当前不可达**，属潜在 wart（会拼出 `"C:/base/C:/win/x.txt"`）；
   harness（`buildGrantModule`）把 `resolveAgainstCwd` 一并导出后直接断言，含「相对路径行为
   一字未动」的对照。

#### 只登记、不改（本轮口径）
- `bash deploy.sh` / `bash --version` / `source ~/.zshrc` / `source --version` 多弹一次是**刻意保守
  设计**，**不加豁免**；同理第六轮新登记的 `su --version` / 裸 `su`（无 `-c`）按 `su-shell` 多弹一次、
  `su root -c "bash --version"` 继承内层 `shell-stdin` 的保守误报 —— 同一个家族、同一把尺子。
- `npx` / `yarn dlx` / `docker run` / `parallel` / `watch` / `./deploy.sh` / 超 256KB 之后的
  `argsText` 仍是明确不判定的边界，保持现状（清单见第五轮 M-C③）。

#### 测试与转红（第六轮）
- 用例数 531 → **538**（+7：判据层 3、监听器层 3、弹框 1）。`.github/workflows/ci.yml` 的
  `MIN_TESTS` 同步 531 → **538**（来源已写进注释）；`SKIPPED_ALLOWED` 不变（1）。
- `node --test test/*.test.js` → `# tests 538 / # pass 538 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`，退出码 0。
- `node verify.mjs` → 退出码 0（v1.12.6 一致性链 + 11 工具）；`node --check` 覆盖
  `index.js` / `lib/host-approval.js` / `lib/client.js` / 三个改过的测试文件，全过。
- **转红①（M-D）**：把 9 个包装器从 `TRANSPARENT_WRAPPERS` 去掉（标记 `MUT-R6-1`）⇒
  `test/dangerous-command-gate.test.js` 实测 `# pass 37 / # fail 2`、EXIT=1，红点原文：
  「unshare -m rm -rf /tmp/x 判定不对」「unshare -m rm -rf /x 被静默放行了（用户裁决：必须走交互授权）」。
- **转红②（Minor 3）**：去掉 `commandText` 超限分支（标记 `MUT-R6-2`）⇒ 同文件实测
  `# pass 37 / # fail 2`、EXIT=1，红点原文：「超长 commandText 必须交回交互层（不是自动放行）」
  （日志实测走了「宿主审批自动放行（本会话工具授权命中）」）+ 顺序哨兵「commandText 超长的保守门调用点丢失」。
- 两次变异都遵守「**先记基线 md5 → 先复制 pristine 副本 → 再动原文件**」（避免恢复动作把破坏写回
  交付状态）；恢复自证 = `cmp` 逐字节 + md5 回基线（`lib/host-approval.js` `a290b9f21b9cba4b1e2200b0c72e4472`、
  `index.js` `32dac461bbedf1784b4047629d0b3c41`）+ `MUT-` 标记 grep 计数 0 + 复跑全绿（538/538/0）。
- **被改动的既有断言（逐条，理由）**：
  · `test/invariants-1-12-6.test.js` 的写入侧反向断言 —— **改法本身是本轮 Minor 1 的交付内容**
    （旧写法恒真），不是"顺手放松"：新写法比旧写法**更严**（去注释后查标识符 + 两条正向锚）。
  · `test/tool-grant-session.test.js` 的 `CLOSURE_NAMES` / `compileHandler` 注入表 —— 纯**追加**
    一个闭包引用 `COMMAND_TOO_LONG_RULE`（handler 体新增引用必须登记，硬守卫 `handlerNameDrift()`
    只抓"被调用"的标识符，常量得手工登记）。
  · `test/grant-dialog.test.js` 的 `buildGrantModule` 返回值 —— 纯**追加** `resolveAgainstCwd`
    （为了能直接断言这个原本不可达的路径），不涉及既有断言。
  · 其余既有用例**一行未动**：`test/dangerous-command-gate.test.js` 的「门的顺序」哨兵只**追加**
    三条关于新门位置的断言；旧锚点（`const danger = dangerousCommandMatch(dangerCmd.text)`）
    刻意保留原样（新门写成**独立早退分支**，不并进 `danger` 计算）。
  · **删除的 `assert` / `it` 行数为 0**，无 `skip` / `only`，没有放宽任何判据。

#### 第六轮冻结凭据（自指说明同前）
- 协议：`tar -czf /tmp/dsh-agent-dispatch-1.12.6-freeze.tar.gz --exclude=node_modules --exclude=.git .`
  —— 在**本节写入之后**执行，故包内 `CHANGELOG.md` 与本文件逐字节一致。
- 包自身的**成员数 / 字节数 / md5** 与解包后 `diff -r -x node_modules -x .git` 的结果
  由交付报告给出（把包自己的 md5 写进包内会改变它自己，构造上不可能自含）。
- **逐文件 md5 全表（第六轮冻结时点，65 个文件；不含 `CHANGELOG.md` 自身）**：

```text
  `.github/workflows/ci.yml` `975e35ff299ac9e1e0e236ff27fd3f77`
  `.gitignore` `fc9d54f7afb97c0d762a0dc93ec64ff8`
  `.qoder/settings.local.json` `b0b9282667dcaade2d18528a237cd76d`
  `LICENSE` `6cc0f1157ee6fec2c6fc4f612fa0bce0`
  `README.en.md` `aa34e20873f8a77c9beb6e1c01a9577c`
  `README.md` `ed9bf09567fb14fc0882a116ba1d62aa`
  `cordis.patch.yml` `6344d499f05d66b13910d41f3310bb09`
  `docs/screenshots/agents.png` `6a30c4c3fea4b4599c6fc22856f02353`
  `docs/screenshots/fab-done.png` `f3c73094c4ea09c96884991b5ae0248b`
  `docs/screenshots/fab-idle-1.png` `28043676b9a6086d267648c75dc9ee33`
  `docs/screenshots/fab-idle-2.png` `48ab4b13a0dbd5061ebb1238422c7444`
  `docs/screenshots/fab-running.png` `17efd4ab12a948d6ff0492d525e99c6b`
  `docs/screenshots/history.png` `d89bfde07f90548ad00a49dbe920181a`
  `docs/screenshots/overview.png` `6ba0684ec70bfabf3af13440e59be7a5`
  `docs/screenshots/popup-agents-squads.png` `43994906eb5bc31018eff73ff5226812`
  `docs/screenshots/popup-running.png` `5435027f217509c88f9efd843a54682c`
  `docs/screenshots/popup-settings.png` `10697535447b3d3a5a27ac5bda5a385b`
  `docs/screenshots/squads.png` `acb125e19badaa3d37ef97c5eeac36e4`
  `index.js` `32dac461bbedf1784b4047629d0b3c41`
  `kiligzzz-dsh-agent-dispatch-1.11.21.tgz` `abee2cabce1248a9f857c7ed19852296`
  `kiligzzz-dsh-agent-dispatch-1.11.22.tgz` `962754751a70c7c375cce68265488a37`
  `kiligzzz-dsh-agent-dispatch-1.11.23.tgz` `609fb395e941ff25e317ce89c1d30d5d`
  `kiligzzz-dsh-agent-dispatch-1.11.24.tgz` `22e7e7fadfe7fc383b06ac92e9b40d7b`
  `lib/agents.js` `cc09bf96e6ad363e18b3ee85e10dd509`
  `lib/client.js` `6078d0815f36cd495bf2804fbb04417e`
  `lib/defaults.js` `f29387cda5012a199e9678e17390d81a`
  `lib/dispatch.js` `c415c59b661e437a666a1606dd23a7db`
  `lib/fab-config.js` `e68aaf76cf31904164b3e7ee97ef842b`
  `lib/health.js` `7a2d06235e40a61facf742ff8dd8e82a`
  `lib/host-approval.js` `a290b9f21b9cba4b1e2200b0c72e4472`
  `lib/json-safe.js` `cb39c2aeb84952a416aa8ae02c9cd43b`
  `lib/roster.js` `d9ee0131ac9ad2be8ef3e1c4485ca771`
  `lib/skill-import.js` `05fbcecfdcd795d5f0921de159f6e345`
  `lib/squad-registry.js` `16efbdc7adbbc655a80aa40766b6d4d4`
  `lib/squads.js` `03cd42b9a961d4b17e5cd40601756ffb`
  `package.json` `e1bd0bb661aa5ad0c1a84a978234bb36`
  `test-p1p2-smoke.mjs` `bb9b72c42f1509e63186153f199a6f31`
  `test/acp-config-fallback.test.js` `3961d7af0d3e310db4740a0f9c037c48`
  `test/acp-twin.test.js` `e7bc1a55cb9331e668963525faf4a55e`
  `test/agent-api-catalog.test.js` `4e8d5c3f8c62e91a6e40f6a9ec93117f`
  `test/agent-api-harness.js` `7b48c19983cc6244cd44bfd8e448a178`
  `test/childid-continuation.test.js` `b1ec780a6529fd841dfd27154ecf0916`
  `test/client-form-logic.test.js` `109e524ef93378bbf0c9b791b963ddc5`
  `test/dangerous-command-gate.test.js` `bb3b9209a14ce74d223d1be13c8a8e20`
  `test/dedup.test.js` `e93881ba9677de3351c54a29a9ebc243`
  `test/fab-panel-layout.test.js` `378f9de86246e67bf01fa02fb3034882`
  `test/failover-claim-race.test.js` `735e23e878a2f1e191a766a3aea2570f`
  `test/failover-notify.test.js` `542597bd87c1cedde09bbe7a3d8fb2f0`
  `test/failover-settlement.test.js` `c23fe799487e6bde3d198c04a40ca047`
  `test/failover.test.js` `07030770e5af9067f538a0c4ab99feff`
  `test/grant-dialog.test.js` `9c602287549e6042fa52c11a10d1184e`
  `test/helpers/failover-host.js` `f725f9052a4b54cd66c171d6338048c0`
  `test/host-0.2-compat.test.js` `e2d46d0cebf92864d746434997a9be04`
  `test/host-approval-endpoint.test.js` `013bddf8f80f5bb0d9e91ad50d5838e9`
  `test/host-approval.test.js` `72779f38918a1e163406884105d334c9`
  `test/interrupt-no-failover.test.js` `bef2189f6bcd2a817f05b7556b744fec`
  `test/invariants-1-12-6.test.js` `4c30eab81d893985e1f1dc1bc829a734`
  `test/perm-fab-jump.test.js` `ceb1e12feae9a0b23efecbbc17f0c412`
  `test/permission-pending.test.js` `83dc18eb17551f07b1dcaf47c04e3039`
  `test/plugin-diagnostic-log.test.js` `cda1a98981d674b32111ca808765a77b`
  `test/roster-section.test.js` `1553c426468cd1b82ad425a6f7a542f0`
  `test/route-validation.test.js` `5d0497e815613ced7611d9db07911687`
  `test/session-source-v4.test.js` `87156b4abd7dbe3f9f336da6b288daea`
  `test/tool-grant-session.test.js` `a841561b509b16fde275beeef328ed55`
  `verify.mjs` `345e3e8fb876f443f9c9c5ddc060ac49`
```
- `CHANGELOG.md` 自身的 md5 不在表里（自指）：表列的是**写入本节之前**其余 65 个文件的状态，
  本节写入后立刻执行上面的打包协议，故包内这些文件与本表逐字节对应。
- 冻结时刻见交付报告；此后不再触碰本工作区。
- 仍然：未部署、未重启宿主、未动 `~/.dsh`、未 `git add`/`commit`、未切 ref、版本保持 1.12.6。

### 第七轮（收尾轮：1 阻断「短选项大小写折叠 ⇒ 同形开关吃掉真程序名」+ 结构性兜底 + 2 Minor + 设计裁定第 10 条）

#### 🔴 阻断 A：大小写折叠 ⇒ 4 组「开关 + 程序名」形态被静默放行
- **现象（终审判据层 + 监听器层双证，全部是**会真正执行 `rm -rf /x`** 的合法 CLI）**：
  `unshare -r rm -rf /x`、`unshare -m -r rm -rf /x`、`nsenter -n rm -rf /x`、
  `nsenter -t 1 -n rm -rf /x`、`strace -A rm -rf /x`、`systemd-run -P rm -rf /x`、
  `systemd-run --user -P rm -rf /x` ⇒ 判据层 `null`、监听器层 `allowed-once`（**静默放行**）。
- **根因**：取值选项表**造表与查表都做了小写归一**（原 `lowerSet` + 三处 `toLowerCase()`），
  把按**真实大小写**登记的大写短选项与它的**小写同形开关**混成同一个键：
  | 表内登记（真实大小写） | 被误命中的小写同形 | 小写那条的真实语义 |
  |---|---|---|
  | `unshare -R dir`（`--root`，取值） | `-r` | `--map-root-user`，**开关** |
  | `nsenter -N fd`（`--net-socket`，取值） | `-n` | `--net`，**开关** |
  | `strace -a column`（`--columns`，取值） | `-A` | `--output-append-mode`，**开关** |
  | `systemd-run -p prop`（`--property`，取值） | `-P` | `--pipe`，**开关** |
  | `xargs -L n`（`--max-lines`，取值） | `-l` | `-l[max-lines]`，**可选附着**（不吃下一个 token） |
  | `xargs -P n`（`--max-procs`，取值） | `-p` | `--interactive`，**开关** |
  那个开关于是被当成「取值选项」⇒ **紧跟其后的真程序名被吃掉** ⇒ 整段判不出来。
- **鉴别证据**：碰撞开关后面若还有别的选项 ⇒ 吃到的是选项 ⇒ 仍命中
  （`unshare -r -m rm -rf /x`、`strace -A -f rm -rf /x` 改前就命中）—— 正是「吃错了 token」的指纹。
- **修法①（查表侧：短选项大小写精确）**：新增 `optionKey` / `optionSet` ——
  **短选项原样比对**（表内拼写 = 该选项的真实大小写）、**长选项仍小写归一**
  （`--Chdir` 这类历史拼写不受影响）。三处查表点（`unwrapTransparentWrappers`、
  `suCommandTokens`、`subCommandVerb`）统一走它。
- **修法②（同一次修法带出的表内校正，逐条 man 核对）**：短选项按真实大小写比对之后，
  表里就必须写真大小写 —— 否则**反向丢命中**：
  · `sudo` 补 `-R dir`(=`--chroot`)、`-T timeout`(=`--command-timeout`)、`-U user`(=`--other-user`)、
    `-D dir`(=`--chdir`)（前三条改前正是撞上小写的 `-r`/`-t`/`-u` 才侥幸命中）；
  · `strace` 补 `-U columns`(=`--summary-columns`)、`-O overhead`(=`--summary-syscall-overhead`)、
    `-S sortby`(=`--summary-sort-by`)、`-X format`(=`--const-print-style`)（前三条同因，`-X` 本来就漏）；
  · `git` 把 `-C path` 写回来（第四轮因「`-c`/`-C` 归一成同一个键」删掉了它；归一取消后不写回，
    `git -C /tmp push` 就丢命中）；
  · `xargs` **删掉 `-i`**（不是漏登记，是第四轮归错类别）：GNU man 原文是 `-i[replace-str]`
    —— 方括号 = 可选参数、只能附着写 ⇒ **不吃下一个 token**，列进来等于把
    `xargs -i rm -rf /x` 的 `rm` 当取值吃掉（方向与「只列吃掉下一个 token 的」那条取舍相反）。
  依据：本机 `man sudo`（1.9.x）与 man7.org 的 `xargs(1)`/`strace(1)`/`unshare(1)`/`nsenter(1)`/
  `ionice(1)`/`taskset(1)`/`su(1)`/`runuser(1)`/`systemd-run(1)` 取值选项表逐条核对；
  测试里以 `DUAL_VALUE_PAIRS` **显式列出**唯一允许存在的「两条拼写都真吃取值」同形对
  （`sudo -r/-R`、`-t/-T`、`-u/-U`；`ionice -p/-P`；`strace -e/-E`、`-p/-P`、`-u/-U`、`-o/-O`、`-s/-S`；
  `su`/`runuser` 的 `-g/-G`；`git -c/-C`），清单陈旧或漏列都会让用例红。
- **回归（既有命中一条不丢）**：`pnpm -C /tmp publish`、`git -C /tmp push`、`npm -C /tmp publish`、
  `npm --prefix /tmp publish`、`sudo -u root rm -rf /x`、`ionice -c2 rm -rf /x`、`taskset -c 0 rm -rf /x`、
  `sudo -C 3 rm -rf /x`、`env -S 'ls; rm -rf /x'` …… 逐条进「既有命中一条都不许丢」用例。

#### 🔴 阻断 B（同根，一并修）：`xargs -l` / `xargs -p`
- `xargs -l rm -rf /x`、`xargs -p rm -rf /x` 与阻断 A 同一根因（`-L`→`-l`、`-P`→`-p` 折叠）。
  两轮结果一致 ⇒ **非本轮引入**，但同一次修法一起解决（`-l`/`-p` 不再命中表里的 `-L`/`-P`，
  按真实语义它们分别是可选附着参数与开关）。

#### 🟢 结构性兜底：新门名 `WRAPPER_OPTION_AMBIGUITY_RULE = 'wrapper-option-ambiguity'`（**可疑**档）
- **目的**：同族再出现「把开关登记成取值选项」时，**不依赖任何工具的 man 语义**也能兜住 ——
  判据只看**谁站在程序名的位置上**，不看某个开关吃不吃值。
- **两个判据**（都只在主路径**一个字都没命中**时生效 ⇒ 只会把静默放行改成保守转交互，
  **永远不会改掉既有命中的规则名**）：
  ① 剥壳后交给规则的**头 token 以 `-` 开头**（且段内没有 `-exec` 系标记）⇒ 我们把某个**选项**
     当成了程序名，真程序名必然在别处被吃掉过；
  ② 跳词时被当成「取值 / 位置参数」跳过的某个 token **自己能起一条危险命令** ⇒ 那个「取值」
     其实就是程序名。真实一例：`env -S 'rm -rf /x'`（`-S` 的取值就是整条命令，改前**静默放行**）、
     `su -G grp rm -rf /x`（真程序名被当成位置参数用户名吃掉）。
- **与任务原文的差异（如实登记，请按这条口径复核）**：任务第二条写的是「解包后**什么都不剩**
  但原段首是已知包装器 ⇒ 可疑」。这条**与本项目既有的误伤守卫直接冲突** ——
  `prlimit --pid 1`、`prlimit -o /tmp/o`、`setarch --show --pid 9284`、`strace --version`、
  `unshare --help`、`setarch --list` 都是「取值吃掉后什么都不剩」，而它们**必须保持 MISS**
  （第六轮 24 条守卫的一部分，本轮验收也点名要全 MISS）。故采纳的是**同一原则的可达形态**：
  判据①（程序名位置站着选项）+ 判据②（被吃掉的"取值"能起一条命令），
  把「光用完选项、什么都没剩」排除在可疑之外（否则每一次正常用完选项都会弹）。
  判据①另要求段内**至少两个 token**：`{argv: ['rm','-rf','/']}` 这类 argv 拆词形态经
  `argsTextOf` 拆出的光秃秃 `-rf` 段仍是**登记在案的残留边界**（既有用例钉着 `=== null`），
  不许被兜底翻成命中（否则 `{argv: ['ls','-la']}` 也会弹一次）。
- **探针条数封顶** `MAX_OPTION_PROBES = 8`：兜底只在 MISS 后跑、单段探针条数有上限 ⇒
  热路径仍是 O(段长) 量级（危险门跑在每次审批上，`boundDangerText` 的 256KB 口径不变）。
  该上限是**每段共享的预算**（`{ probes: MAX_OPTION_PROBES }` 在段入口创建、一路传给嵌套
  剥壳与探针自己的判定）：否则 `runuser -u x ` ×N 这类**嵌套剥壳链**会在每一层 MISS 后各
  重判一次后缀 ⇒ 段内二次方（实测 n=1000 时探针把既有 O(n²) 的常数抬高约 1.6×）。共享后
  **单段兜底重判硬封顶 8 次**、实测耗时与轮前持平（n=250/500/1000 分别 77/257/1094ms vs
  轮前 75/262/962ms），代价只是超长病态链的深层探针可能不跑（方向仍是「少弹」，
  且只影响兜底这一层）。同一条链上**栈溢出阈值与轮前一致**（约 2019 层 / 26KB `runuser -u x`，
  两个版本同点抛 `RangeError`）——该上限是轮前的递归形状决定的，本轮未触及。

#### 🟡 Minor（本轮一并处理，逐条）
1. **m3 留痕丢外层段**：`matchSuShell` 的 no-`-c` 分支原先 `return matchSegment(rest.join(' '), depth)`，
   内层 `trace()` 重算 ⇒ `runuser -u root -- rm -rf /x` 的日志只有 `segment="rm -rf /x"`，
   而同族（`-c` 正文、shell `-c`、`-exec`、透明包装）都留**外层**段 ——
   排障时看不到「这条是被 runuser 包着跑的」。现在**规则名仍用内层命中的那条**，留痕统一用外层 `trace()`。
2. **m4 文档精度**：第四/五/六轮写的「`MUT-` 标记 grep 计数 0」，**全仓**其实有 6 处命中 ——
   全部在 `CHANGELOG.md` 自身（历轮把变异标记 `MUT-R6-1` / `MUT-M4R` 之类写进文档）。
   准确口径已就地勘误为「**源码文件**里 `MUT-` 计数 0」（`lib/`、`test/`、`index.js`、`verify.mjs`）。
3. **m2 文档精度（`command -v` 是整段豁免）**：`isCommandQuery` 一旦认出 `command [-p] -v/-V`，
   **整段**都不判（不只豁免 `su`/`source` 那两条）⇒ 连带被放过的形态（实测全 MISS）：
   `command -v rm -rf /x`、`command -v env rm -rf /x`、`command -v busybox rm -rf /x`、
   `command -v sudo rm -rf /x`、`command -v su rm -rf /x`、`command -V busybox rm -rf /x`、
   `command -p -v env rm -rf /x`。语义本身**正确**（POSIX：`command -v` 只打印路径、**从不执行**），
   是刻意边界而不是少弹；**跨段不受影响** —— `command -v su; rm -rf /x` 仍命中 `rm -rf`、
   `command -v rm; git push` 仍命中 `git push`（分段后逐段判）。就地写进第六轮那一条（见上）。

#### 设计裁定第 10 条：`su` / `runuser` 移出 `TRANSPARENT_WRAPPERS`
- **选 (a)**：把 `su`/`runuser` 从透明包装表移出，**并删掉随之变死的那条早返回**
  （`unwrapTransparentWrappers` 里 `if (SU_WRAPPERS.has(head)) return { tokens: out, ... }`）。
  **⚠️ 顺序要求**：两件事必须**一起**做 —— 只删早返回而保留表成员，`su` 会落入通用剥壳、
  `-c` 正文被空白切碎 ⇒ **真的漏判**。
- **行为对照证据（移出 + 删早返回前后）**：终审已实测「全量 538/538 全绿 + 156 条判据层探针逐行相同」；
  本轮又补了两条哨兵：**源码级**（表里不得再有 `'su'`/`'runuser'`、
  `unwrapTransparentWrappers` 体内不得再出现 `SU_WRAPPERS`）+ **行为级**
  （`su root -c "rm -rf /x"` → `rm -rf`、`runuser -u root -- rm -rf /x` → `rm -rf`（留痕外层）、
  `su - root` → `su-shell`、`sudo su -` → `su-shell`、`command -v su` → MISS，五条读数一字不变）。
- **单一事实来源**：跳词表（`WRAPPER_VALUE_OPTIONS.su`/`.runuser`）与 `SU_WRAPPERS` 仍在，
  只是不再有「登记在表里却不剥」这第二处事实来源。

#### 测试与转红（第七轮）
- 用例数 538 → **546**（+8：判据层 6 条、监听器层 2 条）；`.github/workflows/ci.yml` 的
  `MIN_TESTS` 同步 538 → **546**（来源已写进注释）；`SKIPPED_ALLOWED` 不变（1）。
- **被改动的既有断言：0 条**（无放宽、无删除、无 `skip`/`only`）。为让既有断言继续成立，
  代码侧做了两处**收窄**（方向都是"不误伤"）：兜底判据①要求 `tokens.length > 1`（保住
  argv 拆词守卫）；兜底整体只在**主路径 MISS** 后生效（保住所有既有命中的规则名）。
- **转红①（大小写精确）**：把 `optionKey` 改回大小写折叠（标记 `MUT-R7-1`）⇒
  `test/dangerous-command-gate.test.js` 的阻断用例与表驱动用例转红（读数见交付报告）。
- **转红②（结构性兜底）**：去掉判据①（标记 `MUT-R7-2`）⇒「结构性可疑门」用例转红（读数见交付报告）。
- 两次变异都遵守「**先记基线 md5 → 先复制 pristine 副本 → 再动原文件**」；恢复自证 =
  `cmp` 逐字节 + md5 回基线 + **源码文件**里 `MUT-` 标记 grep 计数 0 + 复跑全绿（546/546/0）。

#### 第七轮冻结凭据（自指说明同前）
- 协议：`tar -czf /tmp/dsh-agent-dispatch-1.12.6-freeze.tar.gz --exclude=node_modules --exclude=.git .`
  —— 在**本节写入之后**执行，故包内 `CHANGELOG.md` 与本文件逐字节一致。
- 包自身的**成员数 / 字节数 / md5** 与解包后 `diff -r -x node_modules -x .git` 的结果、
  `git status --porcelain`、冻结时刻由交付报告给出（把包自己的 md5 写进包内会改变它自己，构造上不可能自含）。
- **逐文件 md5 全表（第七轮冻结时点，65 个文件；不含 `CHANGELOG.md` 自身）**：

```text
  `.github/workflows/ci.yml` `e52c63d1952cb20234c60f9e80146f49`
  `.gitignore` `fc9d54f7afb97c0d762a0dc93ec64ff8`
  `.qoder/settings.local.json` `b0b9282667dcaade2d18528a237cd76d`
  `LICENSE` `6cc0f1157ee6fec2c6fc4f612fa0bce0`
  `README.en.md` `aa34e20873f8a77c9beb6e1c01a9577c`
  `README.md` `ed9bf09567fb14fc0882a116ba1d62aa`
  `cordis.patch.yml` `6344d499f05d66b13910d41f3310bb09`
  `docs/screenshots/agents.png` `6a30c4c3fea4b4599c6fc22856f02353`
  `docs/screenshots/fab-done.png` `f3c73094c4ea09c96884991b5ae0248b`
  `docs/screenshots/fab-idle-1.png` `28043676b9a6086d267648c75dc9ee33`
  `docs/screenshots/fab-idle-2.png` `48ab4b13a0dbd5061ebb1238422c7444`
  `docs/screenshots/fab-running.png` `17efd4ab12a948d6ff0492d525e99c6b`
  `docs/screenshots/history.png` `d89bfde07f90548ad00a49dbe920181a`
  `docs/screenshots/overview.png` `6ba0684ec70bfabf3af13440e59be7a5`
  `docs/screenshots/popup-agents-squads.png` `43994906eb5bc31018eff73ff5226812`
  `docs/screenshots/popup-running.png` `5435027f217509c88f9efd843a54682c`
  `docs/screenshots/popup-settings.png` `10697535447b3d3a5a27ac5bda5a385b`
  `docs/screenshots/squads.png` `acb125e19badaa3d37ef97c5eeac36e4`
  `index.js` `32dac461bbedf1784b4047629d0b3c41`
  `kiligzzz-dsh-agent-dispatch-1.11.21.tgz` `abee2cabce1248a9f857c7ed19852296`
  `kiligzzz-dsh-agent-dispatch-1.11.22.tgz` `962754751a70c7c375cce68265488a37`
  `kiligzzz-dsh-agent-dispatch-1.11.23.tgz` `609fb395e941ff25e317ce89c1d30d5d`
  `kiligzzz-dsh-agent-dispatch-1.11.24.tgz` `22e7e7fadfe7fc383b06ac92e9b40d7b`
  `lib/agents.js` `cc09bf96e6ad363e18b3ee85e10dd509`
  `lib/client.js` `6078d0815f36cd495bf2804fbb04417e`
  `lib/defaults.js` `f29387cda5012a199e9678e17390d81a`
  `lib/dispatch.js` `c415c59b661e437a666a1606dd23a7db`
  `lib/fab-config.js` `e68aaf76cf31904164b3e7ee97ef842b`
  `lib/health.js` `7a2d06235e40a61facf742ff8dd8e82a`
  `lib/host-approval.js` `a9f2da27d4b9802b399e7e8581227fb4`
  `lib/json-safe.js` `cb39c2aeb84952a416aa8ae02c9cd43b`
  `lib/roster.js` `d9ee0131ac9ad2be8ef3e1c4485ca771`
  `lib/skill-import.js` `05fbcecfdcd795d5f0921de159f6e345`
  `lib/squad-registry.js` `16efbdc7adbbc655a80aa40766b6d4d4`
  `lib/squads.js` `03cd42b9a961d4b17e5cd40601756ffb`
  `package.json` `e1bd0bb661aa5ad0c1a84a978234bb36`
  `test-p1p2-smoke.mjs` `bb9b72c42f1509e63186153f199a6f31`
  `test/acp-config-fallback.test.js` `3961d7af0d3e310db4740a0f9c037c48`
  `test/acp-twin.test.js` `e7bc1a55cb9331e668963525faf4a55e`
  `test/agent-api-catalog.test.js` `4e8d5c3f8c62e91a6e40f6a9ec93117f`
  `test/agent-api-harness.js` `7b48c19983cc6244cd44bfd8e448a178`
  `test/childid-continuation.test.js` `b1ec780a6529fd841dfd27154ecf0916`
  `test/client-form-logic.test.js` `109e524ef93378bbf0c9b791b963ddc5`
  `test/dangerous-command-gate.test.js` `a8f0b0b4cf0c674ddde0a8472c892fad`
  `test/dedup.test.js` `e93881ba9677de3351c54a29a9ebc243`
  `test/fab-panel-layout.test.js` `378f9de86246e67bf01fa02fb3034882`
  `test/failover-claim-race.test.js` `735e23e878a2f1e191a766a3aea2570f`
  `test/failover-notify.test.js` `542597bd87c1cedde09bbe7a3d8fb2f0`
  `test/failover-settlement.test.js` `c23fe799487e6bde3d198c04a40ca047`
  `test/failover.test.js` `07030770e5af9067f538a0c4ab99feff`
  `test/grant-dialog.test.js` `9c602287549e6042fa52c11a10d1184e`
  `test/helpers/failover-host.js` `f725f9052a4b54cd66c171d6338048c0`
  `test/host-0.2-compat.test.js` `e2d46d0cebf92864d746434997a9be04`
  `test/host-approval-endpoint.test.js` `013bddf8f80f5bb0d9e91ad50d5838e9`
  `test/host-approval.test.js` `72779f38918a1e163406884105d334c9`
  `test/interrupt-no-failover.test.js` `bef2189f6bcd2a817f05b7556b744fec`
  `test/invariants-1-12-6.test.js` `4c30eab81d893985e1f1dc1bc829a734`
  `test/perm-fab-jump.test.js` `ceb1e12feae9a0b23efecbbc17f0c412`
  `test/permission-pending.test.js` `83dc18eb17551f07b1dcaf47c04e3039`
  `test/plugin-diagnostic-log.test.js` `cda1a98981d674b32111ca808765a77b`
  `test/roster-section.test.js` `1553c426468cd1b82ad425a6f7a542f0`
  `test/route-validation.test.js` `5d0497e815613ced7611d9db07911687`
  `test/session-source-v4.test.js` `87156b4abd7dbe3f9f336da6b288daea`
  `test/tool-grant-session.test.js` `a841561b509b16fde275beeef328ed55`
  `verify.mjs` `345e3e8fb876f443f9c9c5ddc060ac49`
```

## 1.12.5（2026-10-05）
**经用户裁定的行为变更：沙箱越权重新享有「路径级记忆」，但只到本会话为止（会话路径档）。工具名级授权与落盘项目级白名单都不适用于越权；ACP 孪生仍然完全绕过。**

### 变更（用户裁定，不是缺陷修复，也不是自动收紧）
1.12.x 把排除门做成了**一刀切**：`approval/request` 的 `reason` 匹配
`/^\s*escalate\s+sandbox\s+to/i` 就直接 `return next()`，读取侧连**路径档一起废掉**。
副作用是 **1.12.x 曾导致同一路径的越权也反复弹窗**——用户在某个目录点过一次
「本会话总是允许」后，规则其实**照常写进了根会话键**（写入侧从没被关掉），
但越权请求永远读不到它。本轮裁定：

- **工具名级授权不适用于越权（口径不变）**：越权请求既不走 `index.js:376` 的
  `toolGrantCovers` 预短路，也不走 `decide()` 内部的 `session-tool` 档
  （`lib/host-approval.js:667` 新增入参 `disallowToolGrant`，`:670` 用它跳过那一档）。
  所以「授权过一次 bash，所有新目录的越权都静默放行」仍然是**做不到**的。
- **路径级记忆重新生效，但只有会话档**：越权请求走会话路径规则（`scope='session'`），
  命中即 `allowed-once`；未命中则与 v1.11.24 完全一致地 `next()` 委托给交互层。
  **同一目录本次会话不再弹、新目录仍弹、换会话仍弹。**
- **落盘项目档对越权不适用（二次裁定，读写两侧都关）**：读取侧 `decide()` 新增
  `sessionOnly` 入参（`lib/host-approval.js:667` 签名、`:689` 跳过那一档），越权请求即使落盘白名单
  完全覆盖这条路径也**不放行**；写入侧 `/agent-api/host-approval-rule` 的
  `scope==='project'` 分支在暂存上下文**判为沙箱越权**时不落盘，降级写会话路径规则，
  响应如实回 `scope:'session'` + `projectSuppressed:true`，并留痕
  `action:'rule-downgraded'`（`index.js` 的 `sandboxEscalated` 分支）。
  **判据自述更正（1.12.6 终审 B1）**：这条在 1.12.5 的实现里误用了读取侧的合成判据
  `isDisallowedAutoGrant`（= 越权 **或** ACP 孪生），于是孪生点「总是允许(项目)」也被
  降级成会话档、`allowlist.json` 根本不创建——与本节最后一条「ACP 孪生一字未动」**自相矛盾**。
  1.12.6 已把写侧判据收窄回 `isSandboxEscalation(approvalCtx.reason)` 单独一条，
  孪生的落盘行为恢复 1.12.4；1.12.5 从未发布，故按缺陷记录、不称「回归」。
  裁定依据：不允许把「某个路径可以被提权到 danger-full-access」静默落盘长期留存，
  后续会话必须重新问。
  非越权请求的落盘行为与 1.12.4 **逐字一致**（有回归守卫用例）。
  本插件的落盘写入点只有一处（`index.js` 的 `appendProjectRule`），且它只能在
  `scope==='project'` 分支到达；该分支的 `paths` 只能来自 `popPendingContext`
  （`index.js:1957`），拿不到上下文就直接 400 ⇒ **不存在「判不出是不是越权却照样落盘」的漏口**。
- **ACP 孪生仍完全绕过（一字未动）**：`toolName==='product_submit' && reason.startsWith('[ACP ')`
  依旧排在**所有档位之前** `return next()`（`index.js:373`），本插件一档都不判——
  即使会话路径规则明明覆盖得到它也不放行（新增用例 ⑪ 与端点用例专门钉这一条，
  防止后来人把早退门挪到路径档之后）。

### 动手前的调查结论（本轮改法的前提，附依据）
- **谁渲染按钮、谁写下规则**：宿主审批走 waterfall，本插件的监听器 `prepend` 在链头，
  排在 `dsh-api-remotes` 的客户端转发器**之前**。
  - 本插件**返回 outcome**（截断链）⇒ 客户端收不到 ⇒ 宿主面板与插件蓝球都不弹；
  - 本插件**返回 `next()`** ⇒ 链继续 ⇒ 请求转发到客户端 ⇒ 宿主标准面板**和**插件自己的
    蓝球面板同时渲染（`lib/client.js:3875` `remote.$on("approval/request")`，
    `:3783`/`:3805` 两组按钮）。
  所以「插件对某请求 `next()`」**不等于**插件观察不到用户点击——插件根本不需要去
  hook 宿主面板：它自带一条并行的客户端面板，按钮点击 POST
  `/agent-api/host-approval-rule`，服务端按 `callId` 重取路径后写规则
  （`index.js:1989` 工具名档 + `:1994` 路径档）。
- **越权请求的上下文从来没丢**：`pushPendingContext`（`index.js:363`）排在排除门
  （`:372`）**之前**，越权请求的解析结果照样进了 `#pendingContexts`，
  端点 `popPendingContext` 取得到 ⇒ **路径规则一直就可能从越权请求写入**，
  1.12.x 只是把读取侧关了。结论：**不存在「永远不命中的死分支」**，本轮改动有效。
- **越权请求的 `paths` 可得性**（宿主侧就地核证，只读不改）：
  `escalate sandbox to ${mode}: ${justification}` 的审批请求带 `callId` 与 `toolName`
  （`dsh-sandbox/lib/index.js:105-109`，bash 侧 `dsh-tool-bash/lib/index.js:361-375`
  传 `callId: exec.callId, toolName: 'bash'`；同类还有 `dsh-tool-fs`、`dsh-tool-pwsh`、
  `dsh-tools` 的 run_code、`dsh-plugin-manager`），而 `exec.callId` 就是
  `appendToolCall` 落盘用的 `block.id`（`dsh-agent-loop/lib/index.js:580` 起手、`:681` 落盘，
  **落盘先于执行先于审批**）⇒ `resolveApprovalContext → findToolCallRecord → extractToolPaths`
  这条反查链对越权同样成立。
- **`decide()` 里没有第二套独立越权判据**：判据只有一份
  （`isSandboxEscalation` `lib/host-approval.js:244` / `isAcpTwinApproval` `:256` /
  合成 `isDisallowedAutoGrant` `:273`），全部由调用方读；`decide()` 原先只被
  「调用方先判、命中就不进来」这条约定保护。本轮把约定落成入参（`disallowToolGrant`，
  二次裁定再加 `sessionOnly`），因为越权现在**要**进 `decide()`，工具名档与落盘项目档
  必须在里面被跳过。写入侧**不**共用这份合成判据（1.12.6 B1 收窄后）：端点只用
  `isSandboxEscalation(reason)` 决定能不能落盘，ACP 孪生的项目档因此照旧落盘。

### 已知局限（v1.11.24 同款口径，不是本轮引入的回归）
- 越权请求反查不出路径时仍然**每次都弹**（`index.js:385`：`paths.length === 0 → next()`）。
  两种成因：请求不带 `callId`；或工具调用参数里解析不出路径——bash 的命令文本要命中
  `PATH_RE`（`lib/host-approval.js:144`，只认绝对路径/`~` 家目录那批前缀），
  相对路径的越权命令（`cat a.txt`）拿不到路径，也就无从记忆。
- `lib/client.js` 蓝球按钮文案对越权请求不精确（本节写作时**零改动**，已排进 1.12.6
  「面板说实话」，**1.12.6 已处理**：越权请求不再渲染工具名档按钮、改走「可编辑路径」
  弹框并在弹框里明说只到本会话；下面三条保留为当时的现状记录）：
  - 越权请求带 `toolName` 时渲染的是「本会话总是允许该工具」，点击会同时写下工具名档
    与路径档，但**只有路径档对越权有效**；
  - 越权请求点「总是允许(项目)」时，服务端**不落盘**，实际只写本会话路径规则
    （响应回 `scope:'session'`）。
  ⇒ **越权下点「本会话总是允许(路径)」= 只记本会话，不会落盘、不会跨会话生效。**
  该按钮的 tooltip 现在写着「落盘到共用白名单，同工作目录跨会话生效」（`lib/client.js:3817`），
  对越权请求是**不实的**；服务端已在响应里如实回 `scope:'session'` + `projectSuppressed:true`
  并留下 `action:'rule-downgraded'` 留痕，但**客户端不看响应体**——`apiPost` 之后直接
  `item.answer("allowed-once")`（`lib/client.js:3805-3815`），所以本轮的抑制对用户
  在界面上不可见，只有日志看得见。这一条与上面的文案问题是同一件事，一并留待 1.12.6。
  客户端整个面板没有任何「越权」概念（`lib/client.js` 里 grep `escalate`/`越权` 零命中），
  要改就得给蓝球新增判据与文案分支——超出本轮裁定范围，留待单独裁决。
- **越权点「本会话总是允许该工具」仍会写下工具名授权（1.12.4 既有行为，本轮未碰）**：
  蓝球的这个按钮 POST 带 `toolName`（`lib/client.js:3785`），端点的 `scope==='session'`
  分支照旧 `addToolGrant`（`index.js:1989`）。该授权**不会**替越权放行（读取侧已锁），
  但它会让同一根会话后续的**非越权**同类请求不再弹窗。裁定原文只覆盖「落盘/项目级」，
  工具名档的写入侧未在本次裁定范围内，因此**保持原样并在此如实披露**，等下一步裁定。
  对照：「总是允许(项目)」按钮的 POST 不带 `toolName`（`lib/client.js:3805-3810`），
  所以越权走降级路径时只写路径规则，不会顺带写出工具名授权（端点用例的第 ④ 段钉住）。

### 测试
- **加强一处既有断言（未放宽任何断言）**：`test/tool-grant-session.test.js` 的
  「② 已授权 bash + 越权 reason → next()，不放行」原 `mkSession('child-1','root-1')`
  不带 `toolCalls` ⇒ 路径恒空 ⇒ handler 在「paths 为空」那条就 `next()`，
  排除门根本没被走到。补上真实 bash 记录后，`next()` 只能由
  「越权不吃工具名短路」解释（变异 M2 下它转红，原写法不会）。
- **机械同步**：`compileHandler()` 的闭包注入表增加 `isAcpTwinApproval`
  （handler 体新引用了这个名字；漏注入会退化成 `next()`，由「① 顺序哨兵」用例兜住）。
- **二次裁定改写了 1 条既有断言的期望**（不是放宽，是**收紧**）：
  `test/tool-grant-session.test.js` 的
  `disallowToolGrant=true 时项目档照旧参与（v1.11.24 的路径级记忆等价，含落盘那一档）`
  原来断言 `allowed=true / scope='project'`——它把越权的记忆范围一路开到落盘白名单，
  正是用户这轮否决的口径。现改写为
  `两开关彼此独立：仅 disallowToolGrant=true（不带 sessionOnly）时项目档仍参与`，
  期望值不变但**语义降级为"两个开关没被焊死"的粒度守卫**（生产调用总是两个同真）；
  紧随其后新增 `sessionOnly=true（越权二次裁定）→ 落盘项目档即使覆盖该路径也不放行`
  与 `sessionOnly 只影响越权：非越权请求的落盘项目档放行照旧（回归守卫）`。
  这条用例的期望被 M4 变异直接证伪（放开落盘即转红）。
- **新增 10 条**：`test/tool-grant-session.test.js` 越权档位四条（⑧ 路径覆盖→放行、
  ⑨ 差分对照只 reason 变、⑩ 解析不出路径→仍弹、⑪ ACP 孪生即使路径覆盖也仍弹）+
  `decide disallowToolGrant` 单元四条（含项目档那条）；
  `test/host-approval-endpoint.test.js` 端点级两条（真实 POST 写规则后重放的完整用户旅程、
  只写路径规则的形态 + ACP 孪生对照）。
- **二次裁定新增 6 条**（394 → 400 例）：
  - `test/host-approval-endpoint.test.js` 新 describe
    「沙箱越权不得写落盘项目白名单（v1.12.5 二次裁定：只允许会话档）」三条：
    1. 越权点「总是允许(项目)」→ 200 且 `json.scope==='session'` + `projectSuppressed===true`；
       `allowlist.json` **不存在**；同会话第二次 `allowed-once` 且留痕 `scope='session'`；
       换根（新会话）同路径越权仍 `next()`；同根其它路径的非越权请求也不被顺带放行
       （证明降级没写出工具名授权）；
    2. **先由非越权正常落盘**一条规则，记下文件 sha256，再对越权点同一个按钮 →
       文件 sha256 与条目数**逐字节不变**；
    3. 非越权的项目档 POST → `scope==='project'`、文件写入（cwd + paths 断言）、
       **换会话同路径非越权 `allowed-once` 且留痕 `scope='project'`**（回归守卫：
       正常路径的跨会话持久白名单没被一起关掉），而同一条规则对越权不算数。
     临时目录由 harness 注入（`test/agent-api-harness.js` 的 `boot()` 把 `DSH_HOME`
     指到 `mkdtemp`），全程**不落用户 `~/.dsh`**，断言读的是临时目录里的文件本身。
  - `test/tool-grant-session.test.js` handler 级 ⑫「越权 + 只有落盘项目档覆盖该路径 →
    `next()`」带差分对照（同规则、同 fixture、非越权必须 `allowed-once`），
    以及上面提到的 decide 单元两条。
- **`verify.mjs`**：`:875-883` 新增 `decide(disallowToolGrant)` 的两条纯函数断言
  （不放行 + 必须 `scope='session'`）；二次裁定再加两条（`:885-897`）：
  `sessionOnly=true` 的越权**不得**被落盘项目档放行，同一份落盘规则对非越权
  仍须 `allowed && scope='project'`。落盘写在 verify 自己的临时 `DSH_HOME`
  （`verify.mjs:45`），不碰用户 `~/.dsh`。843-854 的三判据断言一字未动，仍然成立
  （`isDisallowedAutoGrant` 的语义读作「不得被工具名档直放」——它**只管读取侧**，
  落盘抑制另有判据 `isSandboxEscalation`，见 1.12.6 B1）。
- **变异转红（逐字节恢复自证）**：基线 384 ⇒ 改后 394 例全绿。

  | 变异 | 转红叶子用例 | `node --test` | `node verify.mjs` |
  |---|---|---|---|
  | M1 退回 1.12.4 一刀切（`index.js:373` 的条件改回 `isDisallowedAutoGrant`） | ⑧、端点「点过一次后…」、端点「越权 + 只写路径规则…」 | `# pass 391 / # fail 3`，退出码 **1** | 退出码 **0** |
  | M2 让越权吃工具名预短路（`index.js:376` 去掉 `!disallowToolGrant &&`） | ②、⑨、端点「点过一次后…」 | `# pass 391 / # fail 3`，退出码 **1** | 退出码 **0** |
  | M3 `decide()` 忽略入参（`lib/host-approval.js:670` 去掉 `!disallowToolGrant &&`） | ②、⑨、端点「点过一次后…」、`decide disallowToolGrant` 单元 2 条 | `# pass 389 / # fail 5`，退出码 **1** | 退出码 **1**（命中新加的 v1.12.5 断言） |
  | **M4（二次裁定）放开落盘**：端点 `pendingExcluded` 写死 `false`（`index.js:1978`），越权的项目档 POST 重新走 `appendProjectRule`（= 退回本轮改动前） | 端点用例 1「越权点『总是允许(项目)』…」红在 **`越权的项目档 POST 仍然落盘了`（`true !== false`，allowlist.json 被创建）**；端点用例 2「已有项目白名单条目时…」红在 **`越权的项目档 POST 改动了落盘白名单内容`（sha256 变化）** | `# pass 398 / # fail 2`，退出码 **1** | 退出码 **0**（端点分支不在 verify 的覆盖范围内） |
  | M5 `decide()` 忽略 `sessionOnly`（`lib/host-approval.js:689` 去掉 `!sessionOnly &&`） | ⑫、`sessionOnly=true（越权二次裁定）…` 单元、`sessionOnly 只影响越权…` 回归守卫单元、端点「非越权请求的落盘行为与 1.12.4 一致…」（同一条规则替越权放行） | `# pass 396 / # fail 4`，退出码 **1** | 退出码 **1**（`v1.12.5: 越权被落盘项目档放行…scope=project`） |

  基线 400 例全绿（`# tests 400 / # pass 400 / # fail 0`，退出码 0），`verify.mjs` 退出码 0。
  变异前留副本，验证后用 `cp -p` 恢复并 `cmp` 确认**逐字节一致**。
- **恢复自证的一次返工（如实记录）**：M4/M5 那轮变异把「变异前副本」的 `cp -p` 顺序做反了——
  破坏行被写进了副本，于是"恢复"实际是把破坏写回工作树，`index.js:1978` 与
  `lib/host-approval.js:689` 一度带着 `// MUT-M4R` / `// MUT-M5R` 留在最终态里
  （即「放开落盘」的破坏状态被当成了交付状态）。本轮开局全仓 grep `MUT-` 命中这两处，
  已按语义改回原样，并**用最终字节重跑了 M4/M5**：
  M4 端点套件 `# pass 19 / # fail 2`（全量 `398/2`，转红理由与表格一致：先红在落盘事实而非响应字段）；
  M5 全量 `# pass 396 / # fail 4` 且 `verify.mjs` 退出码 1（`v1.12.5: 越权被落盘项目档放行…scope=project`）；
  两次恢复后均 `cmp` 逐字节一致，最终全绿 400/400、`verify.mjs` 退出码 0。
  最终基线 md5：`index.js 846b96759446add52e418a83b5fff190`
  （与先前记录的 `59cceaad…` 不同，差异只有两处注释文本：`:1976` 那行的 `:1951`→`:1957` 引用订正、
  `:386` 的引号归一为「」，均无行为改动）、
  `lib/host-approval.js 9625e2838e85b934e2cf3f55d951cdca`（与先前记录相同）。
- **`verify.mjs` 的覆盖口径沿用 1.12.4**：它只做纯函数/字符串形状断言，
  `index.js` 里排除门的**顺序**变异（M1/M2）它看不见（`VERIFY_EXIT=0`），
  这条不变量的守卫靠 `node --test` 的用例与退出码。

### 未做
- 未部署、未重启宿主、未动 `~/.dsh`、未 `npm pack`、未 `git add`/`commit`；
  `createPendingRegistry`/permId FIFO、`#pendingContexts` 的既有设计债、
  以及 auto-review / hook 那两类 `ask` 的排除门语义一律没碰。


## 1.12.4（2026-10-05）
**1.12.3 的终审收尾：fork 会话误判修复（行为收紧）+「降级为路径级」文档更正 + 端点级回归守卫 + 排除门覆盖范围的如实披露。**

### 阻断修复
- **fork（分叉会话）被当作子会话上溯 → 跨会话静默放行 + 授权寿命越界**。
  `resolveRootSessionId` 原先只看 `header.parentSession` 就向上走一跳。但宿主的两类
  会话带 `parentSession` 的语义完全不同：
  - 委派子代理**必带** `origin:'subagent'` + `delegationDepth>0`
    （`dsh-subagent/lib/index.js` 的 `childSessionMeta`）；
  - fork 带 `parentSession`（`cwd` 可选）和一个**随宿主版本而变**的血统标记，**两版都落**
    `parentSession`。本机两个宿主版本都在，已就地复核：DSH 运行时安装树
    （`<DSH>/node_modules/@deepseek-ai/`，`<DSH>` = `~/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh`）
    里是 **`dsh-session@0.2.0-rc.2`**，其 `SessionStore.fork()` 落
    `meta:{ cwd?, parentSession, isSeeded: true }`，且 `validateSessionHeader` **拒绝**
    `seedLength`（见到即抛 `session header has invalid field "seedLength"`）；另一份
    **`0.1.0-rc.6`** 在 `third/dsh-plugin-product-subagents/node_modules/`（插件开发用的旧副本），
    它的 `fork()` 落 `seedLength`、`validateSessionHeader` 承认该字段。
    它是用户在 GUI（`dsh-client-ui-workspace` 的 menu.fork / 快捷键 F）里另开的
    一个**新会话**。判据不读那个标记，只读**两版共同的不变量**——fork 头**不带
    `origin`、不带 `delegationDepth`**（`dsh-subagent` 的 `childSessionMeta` 两版都写这两个字段，
    只有真子代理才有）。这正是判据跨宿主版本稳健的依据：标记名换了也不影响结论。
  于是 fork 被解析成它的源会话 R：用户在 fork 里点的授权写进 **R 的键**，
  R 后续同类请求被静默放行（用户从未在 R 点过）；更糟的是 R 一旦 dispose，
  fork 再写下的键**没有任何 purge 路径**（`purgeSession(R)` 已跑过、fork 的键又不存在），
  直接活到进程结束。
  修复：新增 `isDelegatedSession(session)`（`origin==='subagent' || delegationDepth>0`），
  `resolveRootSessionId` 的 `parentSession` 跳与 `index.js` 的 `registerSessionRoot`
  注册点**用同一判据**——注册点不同改的话，fork 派出的子代理仍会经 `#sessionRoots`
  链回源会话，泄漏更深。链式上溯的每一跳都满足该判据：`#sessionRoots` 只可能由
  注册点写入，而注册点已按判据把关，映射里不会出现 fork→源 这类边；
  dispatcher 回退跳的 `entry.childId` 只可能是本插件派出的子会话 id，不可能是 fork id。
  **行为收紧**：fork 不再继承源会话授权，fork 自身就是根，授权寿命 = fork 会话存续期间。
  **判据口径（用户裁决）**：`origin === 'subagent'` 是**主判据**（宿主 `dsh-subagent` 的
  子会话必带该字段），`delegationDepth > 0` 是**兜底判据**，两者都保留、不要删：生产数据里
  真子代理恒带 `origin='subagent'`，兜底只为覆盖宿主版本差异/旧会话记录只落深度字段的情形
  （删掉它会把真子代理误判成「自身即根」→ 同一根会话反复弹窗，是可用性退化，不会造成跨会话
  放行）。兜底只放宽「继续上溯」方向——fork 两个字段都不带，不可能被它拉进链里。
  不向宿主侧索要 fork 标记（宿主不可改），判据就按上述双条件长期保持。

### 已披露的行为：工具名授权会一并放行 auto-review / 用户 hook 的逐次确认（按用户裁决保持现状，本轮不改代码）
- 排除门 `lib/host-approval.js:265` 只有两类：
  `isDisallowedAutoGrant(toolName, reason) === isSandboxEscalation(reason) || isAcpTwinApproval(toolName, reason)`
  —— 沙箱越权（`reason` 匹配 `/^\s*escalate\s+sandbox\s+to/i`，判据在 `:242`）
  与 ACP 孪生（`toolName==='product_submit' && reason.startsWith('[ACP ')`，判据在 `:254`）。
- 判定顺序（`index.js:366-368`）：先过排除门；**没被排除**的请求接着按工具名短路
  `hostApproval.toolGrantCovers(rootSessionId, ctxInfo.toolName)` → 直接 `allowed-once`。
  该短路不检查 `paths`，也不检查这条审批是谁发起的。
- 因此下面两类 `ask` 会被**会话内工具名授权直接放行、不再弹窗**：
  1. 宿主 auto-review 就某一次具体调用弹出的确认（`dsh-experimental-auto-review`，
     `reason` 形如 `Auto review denied tool "bash": …`）；
  2. 用户 hook 判出的 `ask`（`dsh-hooks-claude-code`）。
  只要它们的 `toolName` 正是用户在本会话点过「总是允许该工具」的那个工具，就命中短路。
  路径档同理：这类请求通常带可反查的 `callId` ⇒ 能解析出路径 ⇒ 会话路径规则也可能命中。
- **这是用户明确选择的行为，不是已知漏洞**：用户要的语义是「本会话里点过一次这个工具，
  就不要再为它弹任何窗」，其中**包含**这类针对具体调用的二次确认。终审实测到上述两类
  被 in-session `bash` 授权直放并就此请示后，用户的裁决是「不排除，一律放行」。
- **给后来人的提醒**：不要「顺手补强」——把 `Auto review` / hook 文案加进排除门等于把
  用户刚关掉的弹窗重新打开；真要改必须先取得用户同意。另外，这两类 `ask` 与普通工具审批
  在 `toolName` 维度上不可区分，任何排除判据都只能去匹配 `reason` 文案；沙箱那条之所以稳，
  是因为 `escalate sandbox to` 前缀属于宿主审批协议的一部分（`lib/host-approval.js:237` 原话：
  「宿主文案可能变化，但「escalate sandbox to」前缀是宿主审批协议的一部分，短期内不会变」），
  而 auto-review / hook 的文案不属于协议，靠它做安全判据本身就脆弱。
- **本节这两个披露项本轮零代码改动**（限定于这两项；v1.12.4 整体并非零代码改动，见上面
  「阻断修复」节），也未为它们新增或放宽任何测试断言：`test/tool-grant-session.test.js`
  里「排除门先于工具名短路」那条硬不变量用例，覆盖范围仍然是上面这两类，保持原样。
- **证据口径与复现范围（如实声明；本条取代此前一版里的三处不实陈述）**：上面两类 `ask`
  的 `reason` 形态**已在本机宿主安装包源码级核证**，两处位置：
  - `dsh-experimental-auto-review/lib/index.js:433-437` 的 `askUser()` 组装
    `const denial = 'Auto review denied tool "<name>"'`，`reason` 为 `denial`；带 reviewer 理由时
    追加 `: <reason>` —— 即披露里那个 `Auto review denied tool "bash": …` 形态；
  - `dsh-hooks-claude-code/lib/index.js:259-262` 的 hook `ask` 分支**只透传 hook 自带的
    `merged.reason`**，本包不给 `ask` 设缺省 reason（带的是用户 hook 脚本写的任意文案，或干脆不带）；
    同文件 `:257` 的 `blocked by PreToolUse hook` 是 **`deny` 分支的缺省 reason**，不是 `ask` 的
    ——所以 hook 的 `ask` 在 `reason` 维度上**没有可用于识别的稳定特征**。
  本机两个包都在，且就是较新的宿主版本：
  ```
  $ grep -m1 '"version"' <DSH>/node_modules/@deepseek-ai/dsh-experimental-auto-review/package.json
    "version": "0.2.0-rc.2",
  $ grep -m1 '"version"' <DSH>/node_modules/@deepseek-ai/dsh-hooks-claude-code/package.json
    "version": "0.2.0-rc.2",
  $ grep -rn "Auto review denied" <DSH>/node_modules/@deepseek-ai --include=*.js | wc -l
  3
  ```
  （`<DSH>` = `~/.nvm/versions/node/v22.22.2/lib/node_modules/@deepseek-ai/dsh`；三条命中分别是
  `dsh-experimental-auto-review/lib/index.js:434`、`:439`、`:442`。）
  **更正**：本节此前写作「本机宿主安装包未安装这两个包、全包 grep `Auto review denied` 零命中」
  ——不成立，那是把 grep 范围误写成 `<DSH>/lib`（DSH 顶层 runner 本身不含任何插件包，
  所以确实是 0 命中）造成的。上面「三处不实陈述」里的**第三处**点名：旧 JSDoc 关于
  `@deepseek-ai/dsh-session` 的「本机无该包、无法本地复核」——同样不成立，本机并存在 DSH
  运行时安装树里的 `0.2.0-rc.2` 与 `third/dsh-plugin-product-subagents/node_modules/` 里的
  插件开发副本 `0.1.0-rc.6`，两版 `fork()` 的头字段都已就地复核（见本条目开头 fork 段）。
  **仍然未复现的部分**：没有在真实会话里端到端触发这两类 `ask`
  ——那需要活链路 + 重启宿主加载实验包，而本轮禁止部署（不 `npm pack`、不改 `~/.dsh`、不重启宿主）。
  所以「这两类 `ask` 会被 in-session 工具名授权直放」是**由我们这侧的代码路径推出的结论**
  （排除门只覆盖两类 `lib/host-approval.js:265`；工具名短路既不检查 `paths` 也不检查请求来源
  `index.js:366-368`，可逐行复核），**机制侧确定、观测侧待实测**，请以宿主侧实测为准。
- **关于宿主行号**：本条目原则上**不写宿主行号**——行号随宿主版本漂移，写死只会误导后来人。
  上面 `:433-437` / `:259-262` 两处例外，请读作「**在 `0.2.0-rc.2` 上核到的位置**」这一
  版本快照证据，不是协议承诺；跨版本时请按符号名（`askUser`、`decision === "ask"`）重新定位。

### 文档更正（与真实语义对齐）
- 「无 `callId` → 降级为路径级」的说法三处更正为 **400 且什么都不写**：
  1.12.3 CHANGELOG（Major 1 条 + 已知局限，v1.12.3 未发包，就地更正并注明）；
  `index.js` 端点注释；`lib/client.js` 蓝球按钮 tooltip。
  根因：`paths = approvalCtx?.paths ?? []`，而路径只能由 `callId` 反查会话记录得到
  ⇒ 无 callId ⇒ paths 恒空 ⇒ 「降级写路径规则」永不执行。
- **删除死分支**：`index.js` scope==='session' 里 `else if (toolName && !isConfirmedRoot) {}`
  的空分支（v1.12.3 声称的降级双保险，实际什么都不做）连同误导性注释一并移除，
  400 文案改为「未写入任何规则」并说明两个原因。
- `lib/client.js` 按钮可用性判据按真实依赖重写：`canGrant = callId && 会话 id`，
  `canToolGrant = canGrant && toolName`。无 callId 时按钮文案为「仅放行本次」，
  项目档 tooltip 同步说明会返回 400——不再承诺「路径级降级」这种写不进去的东西。
- `lib/client.js` 无 callId 的 `console.warn`：文案改为真实语义，并加 `!isAcpTwin` 条件
  ——ACP 孪生不该为它根本不渲染的按钮刷警告；上下文获取失败的 warn 同步去掉
  「按路径级授权降级」措辞。
- 琥珀（ACP）面板「总是允许(项目)」tooltip：去掉「按工具名+路径落盘」的承诺
  ——落盘条目实测只有 `{cwd, paths, grantedAt, note}`，**不含 toolName**；
  「同时写入本会话工具名放行」保留（该面板走 product-subagents 后端，属实）。
- `lib/host-approval.js` 里 `isDelegatedSession` 的 JSDoc：fork 血统标记的**宿主版本归属**
  按本机实测更正——DSH 运行时安装树是 `dsh-session@0.2.0-rc.2`（`fork()` 落 `isSeeded: true`，
  `validateSessionHeader` 拒绝 `seedLength`），`0.1.0-rc.6`（`fork()` 落 `seedLength`）只是
  `third/dsh-plugin-product-subagents/node_modules/` 里的插件开发副本；此前注释写成
  「本机安装的 0.1.0-rc.6」不准确。已同步为与本条目开头 fork 段一致的口径。
  **纯注释改动**：判据、常量、返回值、日志文案一字未动（与上一份冻结 diff 只落在 JSDoc 行）。
- 同一口径推广到另外三处仍把「插件开发副本」写成「本机安装」的说明文字：`test/agent-api-harness.js`
  的 `mkSession` 注释、`test/tool-grant-session.test.js` 的 fork 段注释、`verify.mjs` 的 fork 断言注释
  （与上面已更正的 JSDoc 自相矛盾，同一事实两处口径打架比单独写错更糟）。**同为纯注释改动**：
  fixture 的字段与取值、断言的条件与被匹配字符串、`resolveRootSessionId` 与 `isDelegatedSession`
  判据一字未动，`seedLength` / `isSeeded` / 无标记三种 fork 头的断言用例保持原样。

### 测试守卫（本轮新增）
- **端点级用例** `test/host-approval-endpoint.test.js`（16 条）：真实 `route.handler` +
  真实 `approval/request` 监听器，覆盖 有 callId / 无 callId / 客户端故意传子会话 id /
  无映射孤儿会话 / project 档落盘与跨会话命中 / fork 三例 / 审批留痕三例 /
  **写入键按通道拆开的三条守卫**（见下）。
- **撤回一条此前写下的、复现不出的断言（已作废，勿再引用）**：本节早先的版本**错误地**声称
  「把写入键从 `rootSessionId` 改回 `sid`，本文件 3 条转红」。终审按原样复跑发现**该说法与实际不符**：
  只把路径规则的写入键改回 `sid`（`addSessionRule(rootSessionId, paths)` →
  `addSessionRule(sid, paths)`，全仓唯一命中）时，仓库 379 例与 `verify.mjs` **全绿**
  （**379 例＝三条通道守卫补入前的套件规模，该读数属那个时点、非今天的 384 基线**；
  `TEST_EXIT=0` / `VERIFY_EXIT=0`，本仓库复跑一致）。根因是**两条通道互相遮蔽**：
  所有 POST 都带 `toolName` ⇒ `index.js:368` 的工具名短路先命中，路径档的键根本没被走到；
  而 `addSessionRule` 会把文件**连带的直接父目录**一起写入
  （`lib/host-approval.js:459` `expandPathsWithParents`），于是「兄弟子会话换一条同目录
  路径」那条断言其实是被**路径规则**满足的，也不依赖工具名键。
  换言之：先前那 3 条红的来源是 `addToolGrant` 那一侧 + 留痕断言，路径档的写读键一致
  在仓库内**一直没有守卫**。**下方表格是补守卫后的当前实测口径，取代上面这句作废断言。**
- **补的三条按通道拆开的守卫**（每条断言只依赖一把键，谁写错谁转红）：
  ① 「路径档独立守卫」——授权 `read`、随后用**从未授权的** `write` 命中路径规则，
     放行只可能来自「路径规则写在根键上」；并带反向对照（路径不覆盖 + 工具名未授权 ⇒ `NEXT`），
     证明它不是通配放行。
  ② 「工具名档独立守卫」——路径在授权目录之外，放行只可能来自根键上的工具名授权。
  ③ 「不变量：两把键各只对自己的通道负责（互不遮蔽）」——同一次授权后，
     未授权工具名+被覆盖路径、已授权工具名+未覆盖路径 两条各自独立放行，
     两者都不满足时必须弹窗。
- **补守卫后的实测敏感度**（**下表数字属 383 基线时点**，即 M1 守卫「工具名授权按精确相等匹配，
  近似名不串味且仍弹窗」加入**之前**：基线 `node --test test/*.test.js` = `# tests 383 / # pass 383 /
  # fail 0`，退出码 0。M1 守卫加入后基线为 **384**，同一变异的**通过数各 +1**（`381→382`、`379→380`、
  `377→378`），**失败条数与转红用例名不变**——这不是算术推断，已在 384 基线上逐条复测，复测读数见下表下方）：
  下表每行是**改一处写入键**后的读数，转红用例名逐字取自测试文件。

  | 变异（改哪一行） | 转红条数与用例 | `node --test` | `node verify.mjs` |
  |---|---|---|---|
  | 路径规则写入键退回 `sid`（`index.js:1972` `addSessionRule(rootSessionId, paths)` → `(sid, paths)`） | **2 条子用例**转红（连同其所属 suite 一起计失败）：「路径档独立守卫：授权 read、用**未授权的 write** 命中路径规则（写读键一致）」、「不变量：两把键各只对自己的通道负责（工具名授权与路径规则互不遮蔽）」 | `# pass 381 / # fail 2`，退出码 **1** | 退出码 **0** |
  | 工具名授权写入键退回 `sid`（`index.js:1967` `addToolGrant(rootSessionId, toolName)` → `(sid, …)`） | **4 条**：「子会话 + callId → 写到根会话键，同根兄弟子会话随后命中（RED-D 守卫）」、「工具名档独立守卫：路径不覆盖时，只可能由根键的工具名授权放行」、「不变量：两把键各只对自己的通道负责（工具名授权与路径规则互不遮蔽）」、「会话 dispose 清理到东西时留痕 purge 行（含 isRoot / childMappings）」 | `# pass 379 / # fail 4`，退出码 **1** | 退出码 **0** |
  | 两把键都退回 `sid`（RED-D 原样） | **6 条**：上面两组并集的 5 条，**再加**「客户端故意传子会话 id 作 sessionId → 键仍取服务端解析的根」——该用例两条通道都断言，只有两把键同时写错才转红 | `# pass 377 / # fail 6`，退出码 **1** | 退出码 **0** |

  **384 基线上的逐条复测（M1 守卫加入后实测，非算术推断）**：同一三处键变异分别读得
  `# pass 382 / # fail 2`、`# pass 380 / # fail 4`、`# pass 378 / # fail 6`，`TEST_EXIT` 三次均为 **1**，
  转红叶子用例与上面三行**逐名一致**；`node verify.mjs` 三次仍 `VERIFY_EXIT=0`。
  M1 那条新守卫在这三处变异下**不转红**（它钉的是 `toolGrantCovers` 读取侧的精确匹配，不碰写入键），
  所以「通过数各 +1、失败数与用例名不变」干净成立。

  **验收口径（终审确认）**：这条不变量的守卫来自 `node --test` 的用例与退出码；`verify.mjs`
  单独跑只做纯函数/字符串形状断言，在上述三种键变异下**仍全绿**（`VERIFY_EXIT=0`），
  这是它的能力边界、不是漏检，本轮**不为此改 `verify.mjs`**。
  两条通道各自有**鉴权类**（非留痕类）独立用例，敏感度不只来自日志断言。
- **fork 回归用例** `test/tool-grant-session.test.js` 新增 **11 条（9 条单元 + 2 条走真实
  handler 的集成）**：单元 9 条覆盖 `resolveRootSessionId(fork)===fork.id`、不落 R 键、R 不被静默放行、
  fork dispose 清自身键、R 已 dispose 后 fork 不留无清理路径的键（D7-D9）、
  fork 的子代理以 fork 为根、真子代理/孙代理上溯不回归，以及**血统标记三种形态
  （`seedLength` / `isSeeded` / 不带标记）同结论**那条；集成 2 条为「⑥ fork 会话：真实 handler
  不登记 fork→源 映射」「⑦ fork 已授权 bash → 源会话的请求仍需人工审批」；另有端点级 fork 3 条。
  转红实验：把 `resolveRootSessionId` 的上溯跳**与** `index.js` 的注册点同时还原成
  1.12.3 形态（只看 `parentSession` / 无条件 `registerSessionRoot`）→ **10 条转红、
  `TEST_EXIT=1`**，且 `node verify.mjs` 同步 `VERIFY_EXIT=1`；恢复实现后 383/383 全绿、
  `VERIFY_EXIT=0`。**这两组读数（10 条转红、恢复后 383/383）同属 383 基线时点，即 M1 守卫加入前**；
  恢复态在今天的 384 基线下实测为 `# pass 384 / # fail 0`、`TEST_EXIT=0`、`VERIFY_EXIT=0`，
  而那条「同时还原上溯跳与注册点」的 1.12.3 变异本轮**未回头重跑**，故其 10 条不保证仍是 10 条。
  只回退上溯跳而保留注册点判据时，「fork 派出的子代理以 fork 为根」
  仍绿——那条场景由注册点独立覆盖，属**双守卫冗余**，不是漏洞。
- `test/agent-api-catalog.test.js` 的假 ctx / 假 webServer harness 提到
  `test/agent-api-harness.js` 复用（原文件自带，两份桩会各自漂移）；
  `fireEvent` 改为收集并返回监听器返回值、支持后续实参（waterfall 的 `next`）。
- `verify.mjs`：`resolveRootSessionId` 断言的 fixture 补上宿主真实字段
  （`origin:'subagent'` + `delegationDepth`）；fork 断言改成**三种血统标记循环**
  （`seedLength` / `isSeeded` / 无标记）+ `isDelegatedSession` 双向断言。
- **审批留痕字段口径的用例**：路径规则命中档断言行里有 `scope:'session'` / `tool` /
  `sessionId` / `rootSessionId` / `pathCount`，并断言 **`'paths' in row === false`**——
  把「留痕不带完整路径数组」这条口径钉成可回归的约束，而不是只写在注释里。
- **工具名精确匹配守卫**（终审 M1）：`test/tool-grant-session.test.js` 的 `HostApprovalRules
  tool grants` 组新增 1 条「工具名授权按精确相等匹配，近似名不串味且仍弹窗」。守的不变量是
  **授权只在工具名精确相等时成立**——一个锚点断言（`bash` 必须命中，证明判据本身没坏）+
  逐一断言 `bash2` / `BASh` / `Bash` / `'bash '` / `' bash'` / `''` / `'  '` **全不命中且仍弹窗**。
  为什么补：补之前它只靠实现巧合成立（既有断言只有 `bash` ↔ `write` 两把具名工具），
  **没有任何用例拦得住「顺手加 `trim()` / 大小写归一 / 前缀匹配」**，而那会让人蹭到用户
  从未点过名的工具的授权。转红口径（实测）：把 `lib/host-approval.js:561` 的
  `set.has(toolName)` 改成 `set.has(toolName.trim().toLowerCase())` → **仅该用例转红 1 条、
  `TEST_EXIT=1`**，383 条既有用例仍全绿；恢复后全绿。`verify.mjs` **不覆盖**此不变量（它只做
  纯函数级断言），同样**只由 `node --test` 的用例与退出码承担**，与上面「验收口径」一致。
  ⚠️ **计数**：本条加入后本版用例总数 **384（原 383）**。本小节**上面**那几处 383 基线时点的读数
  （敏感度表的 `# pass 381 / 379 / 377`、fork 变异实验的「恢复实现后 383/383」、撤回段的「379 例」）
  现已在原地标注时点；键变异另附 **384 基线上的实测复测**（`pass` 各 +1、`fail` 数与转红用例名不变）。
  本小节不留「孤立看像当前值、实则读自旧基线」的第三种状态。

### 其他（Minor）
- `index.js` 审批自动放行日志的 `session-tool` 档文案删除：判定侧在上面已按同一判据
  短路，`decide()` 的 `session-tool` 分支不可能走到这里（v1.12.2 m2 加的是死文案）。
- `lib/host-approval.js` 文件头注释：「总是允许(项目)」这条列表项被后面
  「工具名授权双通道边界」段落切断（格式破坏），已归位；补 fork 口径说明。
- `resolveRootSessionId` JSDoc：删除「只能取直接父级」的旧措辞（与链式上溯段并存矛盾），
  统一为「委派子会话才上溯 + `#sessionRoots` 链式补齐」；`purgeSession` /
  `registerSessionRoot` 注释补 fork 与注册点判据的分工。
- **审批留痕改为进插件既有落盘通道**（回应「purge/命中日志只到 console」）：
  `index.js` 新增 `logApproval()`，与 v1.11.23 的 `warn()` 同一条通道
  （`dispatcher.logDiagnostic` → `dataDir/dispatches.jsonl`，`kind:'host-approval'`），
  自动放行与真正清到东西的 dispose 各留一行；`HostApprovalRules.purgeSession` 不再自己
  `console.log`，改为返回清理摘要由调用方留痕。理由：v1.11.23 的论证（stdout 是终端
  socket、进程重启不留痕迹，而事后最需要回溯的恰是这些旁路判定）在这里同样成立——
  本轮的阻断与三个 Major 全出在「键」上，宿主的 `approval/asked+decided` 审计看不出
  写读键是否一致。频次有界（一条 = 一次自动放行 / 一次有实际清理的 dispose），
  且 `mergeDispatchHistory` 已把 `host-approval`/`plugin-warn` 与 `config` 一样按观测行
  剔除，不会在历史页长出「状态未知」的假卡片。
  **留痕口径（用户裁决后定稿）**：保留「每次自动放行写一行」，不降为只记 purge——这行是
  用户排查「点了本会话总是允许为什么没生效」的唯一线索（键落错会话、被判据拒绝都是静默失效）。
  作为交换，单行只带关键字段：`tool` / `scope`（`session-tool` | `session` | `project`）/
  `sessionId`（请求方）/ `rootSessionId`（解析出的根）/ `pathCount`，**不写完整 `paths` 数组**
  （`index.js:384-392`；要看具体路径按 sessionId+callId 回宿主会话记录查）。
  **注**：`~/.dsh/logs` 只有宿主 startup 日志，本插件从未往里写过（v1.11.23 也没有）；
  插件的落盘通道一直是 `~/.dsh/data/dsh-agent-dispatch/dispatches.jsonl`。

### 已知限制（本版未处理 · 预存在设计债）
- **`#pendingContexts` 单调增长**：`index.js:363` 对每个带 `callId` 的审批请求都
  `pushPendingContext(callId, ctx)`，而只有该 `callId` 被 POST 真正消费时才 `popPendingContext`
  删除（`lib/host-approval.js:437-441`）；用户没有点授权的 pending 上下文会一直留着，
  会话 `dispose` 也不清它（`purgeSession` 不触碰这个 Map），于是条目随审批次数线性累积到
  进程结束。**非本轮引入**：HEAD 版同一位置、同一形态（`git show HEAD:index.js` /
  `HEAD:lib/host-approval.js` 可核），终审亦确认为既有设计债、不属本轮范围，本轮按指示
  **不改代码**，仅如实记录。真要收敛需要容量上限 + 随 `session/disposed` 反向清理，属独立变更。

## 1.12.3（2026-10-05）
**v1.12.2 修正式发布：子会话 dispose 反向回归修复 + 孙代理链式上溯 + 无 callId 降级。**

### 修复
- **阻断 1（反向回归）**：子会话 dispose 误清主会话根的工具名授权 + 会话级路径规则。
  v1.12.2 的 `purgeSession` 在子会话销毁时通过 `registerSessionRoot` 反查根 id 并删除
  `#toolGrants[rootId]` 与 `#sessionRules[rootId]`，恰好制造了本需求要消灭的现象——
  **每个子代理跑完就丢授权，用户被迫重复点**。修复：`purgeSession` 只清「属于该会话
  自身的键」，子会话 dispose 不删根授权；根会话 dispose 才清根授权及所有指向该根
  的子会话映射。参考 product-subagents `dispose()` 只匹配 `key===sid`。
  **行为放宽点**：授权寿命从「子会话结束即失效」恢复为「主会话存续期间有效」。
- **Major 1**：无 `callId` 时 REST 端点把工具名授权写到子会话键 → 永不命中。
  v1.12.2 的 `rootSessionId = approvalCtx?.rootSessionId ?? sid` 在无 callId 时
  回落到客户端传的 `sid`（可能是子会话 id），而判定侧查的是真正的根 id。
  修复：服务端在写工具名授权前自行调用 `resolveRootSessionId` 解析根 id；
  若解析结果等于原始 `sid`（无父级信息，无法确认是否为真正的根）→ 拒写工具名授权；
  客户端文案同步修正。
  **更正（v1.12.4）**：本条原写「拒写工具名授权，降级为路径级」不准确——真实行为是
  **400 且什么都不写**。`paths` 只能由 `callId` 反查会话记录得到，无 callId ⇒ paths 恒空
  ⇒ 路径规则写入分支也没有内容可写（v1.12.3 里那句「降级为路径级」的 `else if` 是死代码，
  v1.12.4 已删除）。
- **Major 2**：嵌套子代理（孙）不共享授权。v1.12.2 的 `resolveRootSessionId`
  只取 `header.parentSession`（直接父级），孙代理的上溯停在子代理而非根。
  修复：`resolveRootSessionId` 新增 `sessionRootOf` 参数，利用 `#sessionRoots`
  映射链式上溯到真正的根（孙→子→根），含循环保护与深度上限（MAX_DEPTH=10）。
  无 `sessionRootOf` 时退化为只取直接父级。

### 连带同步
- 测试用例重写：`purgeSession(子会话)` 断言改为「不清根授权 + 兄弟子会话仍命中」；
  新增 `resolveRootSessionId` 链式上溯用例（孙→根、循环保护、深度上限）；
  新增「孙代理共享根会话工具名授权」用例；新增「无父级信息不误放行」反证用例。
- `verify.mjs` 断言同步更新：子会话 purge 不清根授权、根 purge 才清、
  孙代理链式上溯到根并命中授权。
- 文件头注释、JSDoc 更新：`purgeSession` 语义从「反查清理根授权」改为「只清自身键」；
  `registerSessionRoot` JSDoc 说明链式上溯与 purge 的分工。

### 已知局限
- `resolveRootSessionId` 链式上溯依赖 `#sessionRoots` 映射——已注册的会话才能上溯。
  宿主原生 spawn 子代理若从未触发过 `approval/request`（未注册映射），则孙代理无法
  越过未注册的中间层上溯到根。此为信息不足的保守策略，不误放行。
- 无 `callId` 时无法反查工具调用记录：既解析不出路径、也确认不了根会话 id，
  端点返回 400 且**什么都不写**（安全侧：宁可不写，也不写到非根键造成永不命中/跨会话放行）。
  原措辞「降级为路径级」有误，v1.12.4 已更正并在代码里删除对应的死分支。

## 1.12.2（2026-10-05）
**v1.12.1 的修正式发布：session/disposed 清理键修复 + 集成用例自检加固 + 文案/注释/日志对齐。**

### 修复
- **M1（核实后不改）**：ACP 琥珀面板 `allow-always` tooltip「同时写入本会话工具名放行」
  属实——后端为 product-subagents（0.7.6 在 allow-always 时写会话级工具名授权），
  非本插件 `host-approval-rule` 端点。终审将两个面板搞混。
- **M2**：`session/disposed` 清理键与写入键不一致 → 子会话 dispose 不应影响根会话授权。
  写侧用 `rootSessionId`，清侧只取 `session.id` → v1.12.2 修复时走向了另一个极端：
  子会话销毁时反查根 id 并清除 `#toolGrants[rootId]`，反而制造了反向回归
  （v1.12.3 阻断 1 已修）。本次新增 `registerSessionRoot(sessionId, rootSessionId)` 映射，
  为后续链式上溯与清理提供基础。`index.js:321` approval/request handler 中调用 `registerSessionRoot`。
- **M3**：集成用例花括号计数提取失败时 `throw` 在 `describe` 顶层 → `node:test`
  不计入 `# fail`、退出码 0（CI 假绿）。修复：将提取逻辑改为非抛错判定，
  新增 `it('handler 提取自检')` 用例断言提取成功，失败时 `# fail ≥ 1` 且退出码 ≠ 0。

### 文案/注释/日志对齐
- **m1**：`resolveRootSessionId` JSDoc 标注 dispatcher 回退「当前宿主版本下不可达，仅作防御」
  （宿主恒会设置 `header.parentSession`，见 dsh-subagent/lib/index.js:476；
  但若宿主行为变更或存在边界情况，此回退仍作为安全网保留）。
- **m2**：`index.js:341` 日志三元补 `session-tool` 档 → 「本会话工具授权」。
- **m3**：CHANGELOG 补记 REST 响应语义变化（scope=session + toolName + 零 paths：400→200）。
- **m4**：CHANGELOG `sessionId 已改为 rootSessionId` 措辞修正为 `rootSessionId || sessionId`（有回落）。
- **m5**：`lib/host-approval.js` 文件头注释更新：键从「发起请求的 session id」改为「主会话根 id」，
  值从「路径规则集合」改为「路径规则集合 + 工具名授权集合」。
- **m6**：`lib/client.js` 无 callId 时加 `console.warn`（说明缺少 callId/上下文，按路径级授权降级）；
  取上下文失败时 `.catch(() => {})` → `.catch(e => console.warn(...))`。
- **m7**：`decide` 工具名短路返回 `covered: []`（空数组）而非 `[...(paths||[])]`——
  工具名授权不感知具体路径，不应把未校验的 paths 全标覆盖。

## 1.12.1（2026-10-05）
**v1.12.0 的修正式发布：键一致性修复 + 越权判据收紧 + 根 id 解析的真实行为说明。**

### 修复
- **路径规则键一致性**：v1.12.0 前端 POST `host-approval-rule` 时 `sessionId` 已改为 `rootSessionId || sessionId`（有回落），
  但 `decide()` 查路径规则时仍用 `sessionId`（请求方 id），导致子代理写入的路径规则在子代理
  自己再发同路径请求时不命中。修复：`decide()` 查路径规则时先查 `rootId` 键再兜底查 `sessionId` 键；
  REST 端点写入路径规则也统一用 `rootSessionId` 键。旧数据（写在 sessionId 键下）仍可命中。
- **越权判据收紧**：`isSandboxEscalation` 正则改为 `/^\s*escalate\s+sandbox\s+to/i`，
  匹配前导空白/换行/制表符（只收紧方向，属安全侧）。
- **根 id 解析真实行为**：`resolveRootSessionId` 移除死参数 `maxDepth`（while 循环从未递增 depth），
  改为只取直接父级 id。宿主不暴露 session 查询接口，无法逐层回溯；`header.parentSession`
  指向直接父级而非根 id。JSDoc 已与实现一致。dispatcher 回退改用 `entry.parentSessionId`
  （而非不存在的 `entry.session.id`）。
- **前端按钮降级**：无 `toolName` 或无 `rootSessionId` 时，按钮文案从「本会话总是允许该工具」
  降级为「本会话总是允许(路径)」，tooltip 说明仅路径级生效，不谎称工具级放行。
- **测试补充**：零断言用例补上 assert；新增路径规则键一致性用例（子代理写入→子代理命中）；
  新增集成级审批监听器模拟用例（越权不放行、零路径工具名放行、顺序哨兵）；
  verify.mjs 新增本特性纯函数 + decide + toolGrantCovers + resolveRootSessionId 断言。

### v1.12.1 补丁
- **真实监听器集成用例**：将模拟函数 `simulateApprovalDecision` 替换为从 index.js 源码
  花括号计数法提取的真实 handler 函数体，注入真实依赖后驱动判定。包含 5 条集成断言
  （顺序哨兵、越权不放行、ACP 孪生不放行、未授权走 next、子会话命中根授权）。
  顺序哨兵用例在「工具名授权挪到 paths.length===0 判据之后」时转红，已实验验证。
- **ACP 面板文案对齐**：琥珀球 `allow-session` 按钮文案从「本会话总是允许」改为
  「本会话总是允许该工具」，tooltip 说明工具名级放行语义（对齐 product-subagents
  0.7.5 新增的服务端工具名授权）；`allow-always` tooltip 补充说明同时写入本会话
  工具名放行。宿主审批面板文案已在 v1.12.0 更新，本次不动。
- **REST 响应语义变化**：`POST /agent-api/host-approval-rule` 在 `scope=session` +
  有 `toolName` + 零 `paths` 时，由 v1.12.0 的 **400**（无法解析路径）变为
  v1.12.1 的 **200**（工具名级授权不依赖路径）。

### 已知局限（v1.12.3 已修复）
- ~~`resolveRootSessionId` 只取直接父级 id，嵌套子代理（子→孙）不与顶层子代理共享授权。~~
  v1.12.3 已实现链式上溯（通过 `#sessionRoots` 映射），孙代理可共享根授权。
- 宿主原生 spawn 子代理的 `header.parentSession` 缺失时，fallback 为自身 id，不同子代理
  的授权无法共享。

## 1.12.0（2026-10-05）
**行为变更（破坏性）：会话内授权粒度从「路径」放宽到「工具名」，作用域从「自己的会话」变为「主会话根」。**

### 背景：为什么改变授权粒度
旧实现的「本会话总是允许」按钮按路径授权：bash 在路径 A 下被授权后，路径 B 的同类请求仍弹窗。
对于 bash 等频繁触达不同路径的工具，用户需要反复点同一按钮。同一主代理会话内的所有子代理
（含宿主原生 spawn 的）也不共享授权——子代理 C 的 bash 授权对子代理 D 无效。

### 变更
- **工具名级会话授权**：新增 `#toolGrants: Map<rootSessionId, Set<toolName>>`，同一主会话根
  下所有子代理共享工具名授权。bash 授权一次后，同一根会话内所有 bash 调用（不同路径、
  不同子代理）自动放行。
- **根会话 id 解析**：`resolveRootSessionId(session, dispatcher)` 从 `session.header.parentSession`
  （dsh-session 类型定义 `types.d.ts:71`）向上回溯；宿主字段缺失时回退到 dispatcher 的
  `entry.parentSessionId`；都取不到则 fallback 自身 sessionId。
- **安全硬约束**：沙箱越权（reason 匹配 `/^escalate\s+sandbox\s+to/i`）与 ACP 孪生审批
  （`toolName === 'product_submit' && reason.startsWith('[ACP ')`）即使工具名已授权也
  不得直放——由 `isDisallowedAutoGrant()` 集中判据，仍走人工审批。
- **按钮文案更新**：「本会话总是允许」→「本会话总是允许该工具」，如实反映新语义。
- **`decide()` 新增 `scope: 'session-tool'`**：工具名授权命中时返回此 scope，与旧的
  `'session'`（路径规则）区分。
- **REST 端点扩展**：`POST /agent-api/host-approval-rule` 接受 `toolName` 字段，
  `scope === 'session'` 时写入根会话 + 工具名授权。
- **GET 上下文端点扩展**：`/agent-api/host-approval-context` 响应新增 `rootSessionId` 字段。

### 破坏性说明
- 授权粒度从路径放宽到工具名：之前「本会话总是允许」只放行特定路径，现在放行同一工具
  的所有路径请求。已有用户习惯如果依赖路径级精细控制，需使用项目规则代替。
- 作用域从「自己的会话」变为「主会话根」：子代理的授权现在对兄弟子代理和主会话同样生效，
  不再隔离。

## 1.11.24（2026-10-03）
**行为变更（用户可见，不是内部重构）：fallback 换档从「自动孙代」改为「主代理显式换档（同级子代理）」。**

### 背景：为什么换掉孙代
v1.11.22 引入孙代（`nestedFailover: true`，替补挂在失败档之下）只有一个目的——让失败档
「始终有活着的子代理」，从而被宿主的 `settlementState()` 判成 `wait` 而不结算，主代理就不会
先读到「已结束」再看到后台新起一个 child。这个目的**现在已不需要**：失败档阻塞在被阻塞的
`product_submit` 上，而宿主 `watchSettlement` 在算 `settlementState()` 之前先
`await whenIdle()`（`dsh-subagent/lib/types/continuation-activation.js:541`），工具调度器
即使 abort 也会等 in-flight 工具 settle（`dsh-agent-loop/lib/index.js:631-641`）⇒ 它根本不会结算。
代价是主代理对替补**完全不可及**：孙代不是它的直接子级，`send_message` 走不到（宿主强制相邻
关系）、`agent_children` 看不见、`interrupt_agent` 无效。

### Added
- **新工具 `agent_failover({ childId })`（第 11 个工具）**：主代理对某个**正在等待换档决定**的
  失败档显式换档。**只接受 childId**——原任务原文、agentId、失败档 provider、下一档 route、
  已试档列表、错误轨迹全部由编排层从 `activeChildren` / `handoffs` 自查，主代理传不进来，
  也就传不错（现有 `agent_dispatch` 没有 provider/model 参数，根本无法表达「换到哪一档」）。
  一次调用完成三件事，**不需要**再单独调 `interrupt_agent`：
  1. **中断并释放旧档**——宿主调度器等 in-flight 工具，`interrupt_agent` **解不开**被阻塞的
     `product_submit`；真正的释放是本插件显式兑现那条 rendezvous promise；
  2. **派发下一档同级子代理**（`nestedFailover: false` + `reuse: 'fresh'`），主代理可与它双向
     `send_message`；
  3. 旧档随后以 `Background subagent <id> was stopped before it finished.` 结束（真实且预期内）。
  **幂等**：重复调用（含与超时自动路径在窗口边缘撞车）返回同一 `childId`，绝不产生第二个替补。
  已完成的换档按 `handoffsDone` 备忘返回同一结果，避免模型自愈重试把「已成功」报成失败。
- **配置 `failoverMode`（默认 `notify-then-auto`）与 `notifyWaitMs`（默认 `90000`）**，
  另有 `DSH_AGENT_DISPATCH_FAILOVER_MODE` / `DSH_AGENT_DISPATCH_NOTIFY_WAIT_MS` 环境变量。
  三种模式**一律使用同级替补**，差别只在「谁来决定、何时决定」：

  | `failoverMode` | 行为 | 取舍 |
  |---|---|---|
  | `notify-then-auto`（**默认**） | 发**唤醒型**信号 + 暴露 `agent_failover`，等 `notifyWaitMs`：主代理响应则由主代理显式换档；**超时未响应 → 由插件自动派同级替补** | 先给主代理决定的机会，超时自动兜底；主代理不响应也不会把任务卡死 |
  | `notify` | 只发信号等主代理；**超时 → 按失败收尾**，绝不自动换档 | 纯手动：换档必须有人显式决定；主代理不响应即失败 |
  | `auto` | **不等待、不发信号**，立即由插件派同级替补 | 保持 v1.11.23 的「全自动」手感，但替补改为同级、结果直接回主代理 |

- **唤醒型投递**（`#notifyParent(…, { delivery: 'wake' })`）：idle → `parent.followup(msg)`，
  running → `parent.steer(msg)`，规则照抄宿主 `sendWaking`
  （`continuation-activation.js:681` + `:199-203`）。原先的 `parent.inject()` 是 **non-waking**
  （`dsh-agent/lib/types/runtime-types.d.ts:204-209`：只入队、不唤醒驱动），主代理空闲时根本
  读不到换档请求——「主代理显式换档」在主代理空闲时会是死路。
- **`handoffs` 唯一 claim 点（`#claimHandoff`）**：手动工具、`notify-then-auto` 超时自动、
  `auto` 立即三条路径全部经过同一个 `has → set → run` **同步原子块**（块内无 `await`）。

### Changed
- **【最高优先不变量】同一任务在任何时刻至多只有一个替补子代理。** 手动换档与自动换档共用
  同一个原子 claim，**未抢到者幂等返回同一 `newChildId`，不会产生第二个替补**。
  覆盖的竞态窗口与对应测试：`test/failover-claim-race.test.js` 的 W1（超时前手动调用）、
  W2（超时临界点撞车，× 60 轮，两个方向都被覆盖）、W3（超时先到后到者 no-op，× 20 轮）、
  W4（连续多次重复调用，× 30 轮）、W5（`onChildEnd` 在交接进行中到达）、
  W6（并发重复失败 + 混合调用，× 30 轮）、W7/W7b（两个「首次 claim」并发抵达，× 30 轮）。
  旧档结束时的 `#retryOnChildFailure` 兜底路径也被拦：闸门是 `entry.inTurnChain`（持久，
  在**发信号之前**置位）+ 未决 rendezvous（瞬时）+ `activeTasks` 活跃兄弟闸，共三道。
- **通知语义变更（旧 → 新）**：旧的「主代理恰好收到 1 条终局通知」不再成立。新语义下主代理按序读到：
  ①（`notify` / `notify-then-auto`）唤醒型换档信号 → ② 失败档的
  `was stopped before it finished.` → ③ 替补档的结算通知（带替补的答案）。
  ② 是真实的、无法从插件侧抑制（宿主 `notifySettlement` 无条件发出），但它**晚于**显式信号且语义真实。
  释放顺序写死为：**interrupt 旧档 → 迁移 waiter → 派同级替补 → 兑现 rendezvous**，
  保证「旧档释放」永远晚于「替补存在」。

### Removed（孙代路径彻底移除）
- `handleSubmitFailover` 的 `nestedFailover: true`（原 `:2023`）——改为与 `#runHandoff` 合流，
  换档派发只有一处实现（`#runHandoff`）。
- `#retryOnChildFailure` 的 `nestedFailover: !!entry.nested`（原 `:2172`）→ 常量 `false`。
- `inTurnHandled = !!entry.inTurnChain && !entry.nested`（原 `:1815`）→ `= !!entry.inTurnChain`
  （孙代形态不存在了，那个例外分支永不再触发）。
- `#canFailover` 的孙代去重豁免 `if (others.length > 0 && !entry.nested)` → 去掉豁免，
  替补正常参与同任务去重（它是主代理的直接子级，与普通 child 无异）。
- `dispatch()` 的 `nestedFailover` 入参与 `entry.nested` 字段**保留**（恒 false），
  仅供既有 entry 读取点（`#canFailover` / `#failoverBlockReason` / `completedFresh`）不再失效；
  **生产代码路径不再有任何一处传 `true`**（有专门的源码护栏断言）。

### Fixed
- **链拓扑过早退役**：同级模型下「根档被中止先于替补结算」是常态，而 `#settleChain` 原本无条件
  `chainLiveChild.delete(rootId)`、`onChildEnd` 原本无条件 `chainRootOf.delete(childId)`，
  于是替补刚就位、改投索引就被抹掉，换档期间落向失败档的追加消息会**投回已挂掉的旧线程**
  （绕回坏产品再触发一轮换档）。改为 `#dropChainTopology`：**只有链上当前活跃档自己结算时**
  才退役拓扑，并顺带清扫指向该链的失效改投入口。
- **交接路径不得二次 emit `submit-failed`**：`FAILOVER_HANDED_OFF`（product-subagents v0.7.4
  新增）已归入 `interrupted` 级，且 `product-submit` 在交接分支直接抛出、不再 emit；
  否则未知码的兜底分级是 `failover`，会重复登记 `onFailover` 并再跑一条链 → 同一任务两个替补。
- **`handoff()` 对已结算/不存在的 childId 抛自解释错误**（含当前 `failoverMode`、
  「之后的档位是否全部冷却/已试过/已到末档」），主代理据此决定下一步，而不是含糊的失败。

### Tests
- `test/failover-claim-race.test.js`（新，11 个用例 / 6 个 describe）：W1–W7 + W7b 竞态窗口
  （W2/W3/W4/W6/W7/W7b 分别循环 60/20/30/30/30/30 轮），以及两条源码护栏
  （`#claimHandoff` 块内不得出现 `await`/`setTimeout`；代码里不得再出现 `nestedFailover: true`）。
- `test/failover-notify.test.js`（新，12 个用例）：唤醒投递（idle→followup / running→steer）、
  `agent_failover` 三件事一次做完、幂等、二次 emit 护栏、手动 vs 超时自动的**通知序列等价**、
  `notify` 超时按失败收尾且旧档在 `notifyWaitMs` 量级内结束（不是 15 分钟）。
- `test/failover-settlement.test.js`（重写）：断言从「恰好 1 条通知」改为新语义下的确定顺序
  与拓扑（`nested===0`、`parentSessionId === 主代理会话`、逐档自解释终局文本）。
- `test/helpers/failover-host.js`（新）：按宿主真实语义建模的共享假宿主
  （结算文案/顺序、唤醒规则、`whenIdle` 不结算、`interrupt` 解不开工具、`request.parent` 语义）。
- **变异验证（4 项，全部贴过原始输出）**：
  1. 去掉 `entry.inTurnChain = true` → `notify` 超时用例报 `notify 超时绝不自动换档，实际派了 ["child-1","child-2"]`；
  2. 在 claim 的 `has` 与 `set` 之间插入 `await` → W7b 报
     `同一任务至多一个替补，实际派了 2 个：[{child-1},{child-2},{child-3}]`（且旧档被 interrupt 两次）；
  3. 删掉「已存在」判断 → W1–W6 全部变红（同样出现两条 dispatch）；
  4. 复活 `nestedFailover: true` → 源码护栏报
     `孙代路径已彻底移除：代码里不得再出现 nestedFailover: true`，行为用例报
     `孙代形态已彻底移除：任何 entry 都不许有 nested=true`。

### Compatibility
- 需要 product-subagents ≥ 0.7.4（提供 `failoverMode` / `notifyWaitMs` 载荷与
  `FAILOVER_HANDED_OFF` 收尾语义）。对接 0.7.3 时行为退化但**安全**：旧 PSUB 不知
  `handedOff`，会把交接后的裁决当作「没结果」而照原样抛错——旧档已被 interrupt、rendezvous
  已清理，根档回合照常结束，`inTurnChain` 拦住二次换档。
- 对接更旧的 product-subagents（无 `onFailover` 握手）或 `failoverInTurn: false` 时，
  退回结算后兜底换档（`#retryOnChildFailure`），它**同样派同级替补**。

## 1.11.23（2026-10-03）
三项小修，其中第 ① 项是上一轮审核的**静态推断经实测确证为真**的缺陷。

### Fixed
- **回合内链接管过的换档，回合外不得再起第二条重试链**（上一轮推断，本次实测确证可达并修复）。
  根因是四处叠加：`willFailover`（`lib/dispatch.js:1804`）不检查「本链是否已在回合内处理过」；
  根档 `failoverTried` 恒为 `[]`（`triedProviders` 只在 `failoverCount>0` 时记账，见 `dispatch():625`），
  于是 `#nextRoute` 仍指向链内刚用过的档位；孙代 `nestedFailover` 不登记 `activeTasks`（`:1062`），
  `#canFailover`（`:2054`）的同任务去重又排除自身，挡不住；且回合内链成功时 `submit-ok` 已清掉
  `_submitFailed`，此后 relay 回合若以 `stopReason='error'` 收场，`productFailed` 为假 → `grade` 取
  `null` → `fatal` 为假，四道闸门同时失效。
  实测（`test/failover-settlement.test.js` ⑪）在修复前派出了 `child-1`(deveco, 顶层) /
  `child-2`(opencode, 链内孙代) / `child-3`(opencode, **顶层兄弟**)，三个 child 携带**同一份任务文本**，
  即 1.11.22 事故的同形复发。修复：`handleSubmitFailover` 接管时给 entry 打 `inTurnChain` 标记，
  `willFailover` 对「非孙代且已被回合内链接管」的 entry 一律不再换档，终止原因自解释为
  `；自动换档已停止: 本回合内已由 fallback 链处理过，不重复重试`。链内孙代之间的接力不受影响。
- **超时兜底路径同时清理 `chainLiveChild`**：`handleSubmitFailover` 的 guard 原先只删
  `chainOutcomes`，与 `#settleChain`（`:1901`）不同规格，导致链超时终结后的短窗口内
  `#liveHopFor` 仍会把追加消息改投给这条已终结的链上档位。现两处同规格清理。
- **插件集成层的降级失败可回溯**：DSH 的 stdout 是 VS Code 终端的 unix socket（不是文件），
  `index.js` 里 `console.error('…submit-failed 订阅失败…')` 此前只在终端闪一下、进程重启后
  零痕迹——而这恰恰是最需要事后排查的降级路径（订阅失败 = 自动换档整个静默失效）。
  新增 `dispatcher.logDiagnostic(row)`（行格式与既有 `#log` 完全一致，未新造格式），
  `index.js` 的 `warn()` 辅助把 `submit-failed` 订阅失败、换档处理器登记失败、
  `markChildSubmitFailed` 失败三处一并落盘，`kind:'plugin-warn'` 可直接 grep。

### Tests
- `test/failover-settlement.test.js` ⑪⑫⑬：分别钉死「链内已换档成功 + relay 回合 error ⇒ 无顶层
  兄弟 child」「链走完仍失败 ⇒ 停止原因自解释且无回合外兄弟」「超时兜底 ⇒ `chainLiveChild`
  与 `chainOutcomes` 一并摘除、后续追加消息回原路径」。三项均做过变异验证（改坏实现 → 对应用例变红）。
- `test/plugin-diagnostic-log.test.js`：`logDiagnostic` 的落盘格式、追加语义、写盘失败不抛，
  以及 `index.js` 接线护栏（订阅失败分支必须落盘，不得退回纯 `console.error`）。

## 1.11.22（2026-10-03）
- **【用户现场事故 ×2】fallback 链未走完就把「失败」信号释放给主代理 → 主代理误判并手工重派，两个同角色子代理并发覆盖同一批文件**。
  根因不在本插件的 waiter 迁移（那条链早就写好了），而在**信号释放的时机与归属**：
  ① **谁发的**：宿主 `@deepseek-ai/dsh-subagent` 的 `SubagentContinuationManager.notifySettlement()`
  （`lib/types/continuation.js:1452`），对每个拿到过 id 的 child **无条件**发结算通知；
  ② **什么时候发**：失败档的 Activation 结算时，即 relay child 回合结束的**瞬间**，
  由 `watchSettlement` 观察到 `stateOf() === 'settled'` 触发——**早于** `subagent/end`
  （编排层据此判失败换档）。所以主代理读到的顺序是「已结束」→（后台新起 child 干同一件事）；
  ③ **新 child 是否对父代理可见**：换档 child 原先建在**主代理**之下（`#retryOnChildFailure`
  取 `agents.get(entry.parentSessionId)`），它的存在与结算都直接回主代理。
  旧实现把「只有 ACP relay 模式能换档」去掉是对的（v1.11.10），但没处理通知时机，
  于是「不换档就不会误判」的承诺只在 waiter 一侧成立，父代理那一侧一直漏。

### Fixed
- **失败档在自己的回合内把 fallback 链走完，链走完之前不向主代理释放任何失败/完成信号**。
  `handleSubmitFailover()` 由 `index.js` 在 `product-subagents/submit-failed` 事件里通过载荷
  的 `onFailover` 登记，`product-submit.js`（product-subagents ≥0.7.3）在同一次工具调用里
  **阻塞**等待它。两条配套改动缺一不可：
  - **换档 child 挂成【失败档的孙代】**（`parent = 失败档 Agent`，`nestedFailover: true`）。
    孙代的结算通知只回到失败档，主代理看不见它的存在；失败档因「自己还有活着的子代理」
    停在宿主的 `waiting` 态，宿主便**不会**对它发那条 `finished and will do no further work`。
    链走完后失败档才结算，主代理于是**只收到一次**结果——成功，或「全部 route 都已失败」。
  - **链终局只兑现一次**（`#settleChain` + `chainOutcomes`）：链上任何**中途**档位都不兑现，
    只有不换档的那一档（链真正走完）兑现 `{ok, text, …}`。多跳递归时每一跳的处理器
  **复用同一条裁决通道**（按 `chainRootId` 建一次）——否则内层跳会覆盖外层跳的 resolver，
    首档回合永久挂死（这是实现过程中真实踩到并由测试逼出来的 bug）。
- **最终失败报告自解释**：`（步骤失败: …）` 现在追加 `；已尝试 N 档: deveco → EMPTY_RESPONSE …；
  opencode → RATE_LIMITED …；deepseek-official → …`，逐档带各自最后错误（`#chainFailureSummary`，
  轨迹经 `failoverErrors` 沿链累积）。全部 route 失败时回给父代理的**唯一那条**通知里
  就有完整清单，不再是一句无从判断的「步骤失败: completed」。
- **失败分级闸门**：`gradeSubmitFailure()` 把失败划成 `failover`（限额/限流/空正文/超时/
  传输中断/5xx）/ `fatal`（认证/参数/语法/模型不存在/人为拒绝/链已耗尽）/ `interrupted`。
  `fatal` **不再进入换档链**——旧实现把任何产品故障都换档重跑一遍，认证失败这类
  「重试也不会有改善」的错误因此白烧请求，还把原因掩盖成「自动换档已停止」。
  权威来源是 product-subagents 下发的 `info.grade`；本地实现只是对接旧版时的兜底，
  两仓逐条同构（判定顺序：覆盖 → 精确码 → 文本正则 → 兜底 failover）。
- **`submit-failed` 早到不再被丢弃**：`markChildSubmitFailed` 在条目尚未登记时改为**缓冲**，
  `dispatch()` 登记条目后立刻回放。宿主 `startContinuable` 在「收件箱受理」即 resolve，
  若某宿主版本同步起跑回合，失败标记会先于条目落地而被静默丢掉（换档链永不触发）。

### Added
- 配置项（`config` / 环境变量，均为**新增**，缺省即新行为）：
  - `failoverInTurn`（bool，默认 `true`；env `DSH_AGENT_DISPATCH_FAILOVER_IN_TURN=0` 关）
    ——置 `false` 退回 v1.11.21 行为（失败档先结算再换档，中间态通知会泄漏），仅供排障对照。
  - `failoverWaitMs`（number，默认 `900000`＝15 分钟）——回合内等链走完的硬上限，
    超时按「链走完仍失败」处理，绝不无限挂起。
  - `failoverGrades`（`{ "<错误码>": "failover"|"fatal"|"interrupted" }`）——分级覆盖，
    与 product-subagents `config.submitFailureGrades` 同名同义。
- `gradeSubmitFailure()`（导出，纯函数）：与 product-subagents `lib/submit-failure.js` 同构的兜底分级。
- `test/failover-settlement.test.js`（8 例）：用**按宿主真实结算语义建模**的假宿主
  （子代理有活着的子代理时处于 waiting → 宿主不发结算通知；先发结算通知、再发
  `subagent/end`——顺序与 `finishDisposal` 一致）驱动真实 `Dispatcher`，
  断言的是**通知条数与通知文本**：① 空正文→第二档成功→恰好 1 条成功通知；
  ② 429→第二档成功→同样 1 条；③ 三档全失败→恰好 1 条且含 3 档各自错误；
  ④ 认证失败（fatal）→不换档、只 1 条；⑤ 换档 child 的父子关系与 `byAgent` 不被挤掉；
  ⑥ 同回合重复失败只起一条链；⑦ `failoverInTurn=false` 的对照用例。

### Compatibility
- 向后兼容：对接**旧版** product-subagents（无 `onFailover` 字段）时自动退回 v1.11.21 语义，
  `dispatch()` / `onChildEnd` 的对外签名与返回结构未变；孙代 child 不进 `byAgent`、
  不进 `completedFresh`、不进同任务去重表，故 `agent_children` / `send_message` /
  `/agent-api/*` 等既有消费者看到的线程列表与之前一致。
- **父代理等待时间变长**：失败档的回合现在会阻塞到 fallback 链走完（原先失败即结算）。
  上限由 `failoverWaitMs`（默认 15 分钟）兜底；正常情况下只增加「失败档之后的链耗时」，
  且这段等待**不消耗**主代理的回合（主代理此时无事可做，宿主也不唤醒它）。
- 深度硬闸（`callerDepth >= 1` 禁止再向下委派）与全局 `tools.guard` 对**孙代**换档**不生效**
  （内部调用，不经工具层）：换档是编排层对同一份任务的确定性重投，不接受模型自行发起，
  故不构成递归委派。

### Fixed
- **换档期间到达的追加消息改投到链上【当前活跃的那一档】**。方案 A 让失败档的 relay child
  在 `product_submit` 内阻塞等整条链，期间该 child 收不到新 `send_message`。**这不等于丢消息**：
  宿主把消息排进该 child 的 Inbox（`sendMessage` → `deliverToChild` → `deliverFollowup` →
  `submitAdmitted`），而 `settlementState()` 的 `inbox.hasPending` 分支使宿主对它返回 `wait`
  而不结算，消息因此不会被 dispose 时 `keepInbox:false` 的 cancel 清掉。
  **真正的问题是投错档**：那条档绑的是已经失败的产品，消息会绕回去再触发一轮换档。
  修法：`chainRootOf` / `chainLiveChild` 两张索引记录「child 属于哪条链」与「链上当前最深、
  仍活跃的那一档」，`followup()` 据此把追加消息改投到当前档（sender 用该档的直接父级 Agent，
  满足宿主的相邻校验）。**改投失败回落到原目标，两条路径都失败才上抛——任何情况下不静默丢弃。**
  链终结（`#settleChain`）即注销 `chainLiveChild`，此后的追加消息回到原路径（宿主冷恢复）。

### Known boundaries（已在 README「已知边界」小节记录）
- 宿主的 per-child 结算通知**无法从插件侧抑制**：`notifySettlement` 首行
  `if (!activation.announced) return`，而 `announced` 在 admit 时无条件置真
  （`@deepseek-ai/dsh-subagent` `lib/index.js:1255` / `:1837` / `:1957`）。本插件靠
  「失败档始终有活着的子代理 → 宿主 `settlementState()` 返回 `wait`」间接避免中间档通知。
  README 里另附一段**给上游修 bug 的参考方案（未实施、未生成补丁文件）**。
- 换档重投**从头重跑、无幂等保护**（`#retryOnChildFailure`）；`activeTasks` 去重只防
  「已有活跃兄弟」，不防副作用重复，也不拦人工重投（`dispatch()` 无同任务 early-return）。

### Verification
- `node --test test/*.test.js` **278/278 通过**（原 266 + 新 8）；`node verify.mjs` 绿灯。
- **变异验证（测试都咬得住）**：M2 `handleSubmitFailover` 直接 `return null`（= 修复前行为：
  失败档先结算、换档在其后）→ **5 例转红**（① ② ③ ④ ⑤ ⑥），① 报「主代理必须只收到一条
  通知，实际收到 2 条」；M3 换档 child 不再孙代化（挂回主代理之下）→ **5 例转红**；
  M4 去掉 `fatal` 闸门 → **2 例转红**（③ ④）；M1 把「只在链走完后释放」改成「每次尝试都释放」
  → 0 例转红（**如实记录**：ACP 档失败时回合仍阻塞在 `product_submit` 里，中途档根本走不到
  `onChildEnd`，该变异点不可达——真正承重的变异是 M2/M3）；
  M5（product-subagents 侧）`product_submit` 不阻塞等待换档结果 → **3 例转红**。

## 1.11.21（2026-09-29）
- **适配 dsh 0.2.0-rc.1（宿主接口换代）**。升级后逐项核对了本插件对宿主的全部调用面（`ctx.subagents.*` / `Session` / `ctx.tools.*` / `systemPrompt` / `agents` / `approval/request` / `webServer` / 客户端半边），**三处需要处理**；本版修完，1.11.20 及更早版本在 0.2 上有静默失真与未爆的雷。宿主包无破坏性依赖声明（peerDeps 只有 `@deepseek-ai/cordis`），因此**没有**像 `dsh-plugin-product-subagents` 那样被 `dsh-app-boot` 在加载期整包跳过——`evaluatePluginCompatibility` 只校验 `@deepseek-ai/dsh*` 前缀的 peerDependencies。

### Fixed
- **【必修】`agent_children` 在 0.2 上恒把非运行中线程报成 `ready`（驻留性判定失真）**：0.2 把「带 activity 的目录行」与「`listChildren()` 返回的条目」拆成了两个类型——`listChildren()` → `SubagentCatalogEntry = { id, createdAt } & { mode, label? }`，**没有 `activity`**；带 `activity: 'running' | 'inactive'` 的是 `SubagentCatalogRow`，只出现在 `listDescendants()` 的 `SubagentListEntry` / `SubagentDescendantListEntry`（`kind === 'child'`）上。旧实现 `r.status = en.activity === 'running' ? 'idle' : 'ready'` 因此恒判 `ready`：**`idle`（驻留且空闲）在 0.2 上不可达**，主代理据此误判"复用要冷恢复"。不报错、不失败，纯静默失真（与 product-subagents 在 0.7.0 踩到的 `listChildren` 字段裁撤同源）。
  **修法**：新增 `Dispatcher#residentActivity(parentSessionId, childIds)` 三级取数——① `listDescendants()`（0.2 正解，条目自带 `activity`，只认直接子级）；② `listChildren()` 条目上的 `activity`（0.1.x 旧形态，向后兼容）；③ `ctx.sessions.get(childId)` 在册与否（与宿主 `listDescendants` 自身推导 activity 的规则同构）。宿主**没报某一条时保留派生状态、不误降级**；正在执行的线程不被覆盖。`listChildren()` 的对外契约（`running` / `idle` / `ready`）与工具描述均未变。
- **【潜在雷】工具出参含 `undefined` 属性 → 整次调用失败（旧缺陷，读盘路径暴露）**：宿主对工具出参做无损 JSON 校验（`dsh-tools` 的 `createSuccessResult` → `snapshotToolValue` → `snapshotJsonValue`），值为 `undefined` 的**自有属性**会在 JSON 往返中被丢弃，于是判非法并让**整次调用**失败：`tool "<name>" returned invalid output: value is not lossless JSON`（`ToolOutputError` / `INVALID_TOOL_OUTPUT`）。实测 **0.1.0-rc.6 与 0.2.0-rc.1 同样严格**（不是升级回归），本插件过去没被打中只是因为出参恰好都填满了。
  **实证**：`lib/agents.js` 的 `init()` 读盘只校验 `id` 就采用磁盘对象，而 `upsert` 才归一化 `emoji` / `triggers`——写路径安全、**读路径暴露**。用探针复现：agents.json 里某条 agent 缺 `emoji`/`triggers` 时，`agent_list` 出参含两个 `undefined` 自有属性，宿主 `snapshotJsonValue` 判非法（对照：经 `upsert` 归一化后通过）。
  **修法**：① 抽出模块级 `normalizeAgent()`，**写盘与读盘共用同一口径**（`init()` 逐条规整；缺失的 `emoji`/`triggers`/`routes` 落成 `''`/`[]`，`name` 缺失退回 `id`）；② 新增 `needsNormalize()` 逐字段判定（作为「什么算偏离」的可测契约）；③ 新增 `lib/json-safe.js` 的 `jsonSafe()`，`index.js` 新增 `registerTool()` 包装，**10 个工具的出参全部经它收口**——后续再加可选字段（`output` / `warnings` …）不会再把工具调用弄坏。
  **终审意见后的一处收紧（读盘不回写）**：曾让 `init()` 在发现形状偏离时异步回写一次磁盘，但回写是**整文件**重写——只要有一条偏离，全部条目都会按 `normalizeAgent` 口径落盘（未知键被清除、无效路由项被丢弃），属启动期无声数据变更；且 `id:''` 这类条目会让偏离判定恒真、每次启动白写一次盘。现改为**读盘只归一化内存、不据此回写**（工具出参的 `undefined` 问题在内存里就已解决；下一次正常写盘（upsert/setEnabled）自然带上规整形状）。同时把非字符串 `model`/`effort` 的处理分成两侧：**写路径由 `validateRoutes` 门禁响亮拒绝**（此前是以 `TypeError: r.model.trim is not a function` 这种看不出所以然的形态炸在写盘路径上），**读路径按「未指定」处理**（不再替手写文件编造 `String(123)`='123' 这种用户从未配过的值）。
  `jsonSafe()` 不只处理 `undefined`：`JSON.stringify` 对一批值会**静默改写**而不是报错，实测宿主对 `Date` / `Map` / `Set` / `Buffer` / `bigint` 一律判非法（**原始实现会把它们拍平成 `{}`，即"调用不失败但内容丢了"**）。现在：带 `toJSON()` 的按 JSON 形态落值（`Date` → ISO 字符串、`Buffer` → `{type,data}`，**保内容**）、`Map`/`Set`/类实例按不可无损丢弃（对象丢键、数组转 `null`）、`bigint` 安全整数转 `number` 否则转十进制字符串。`isLosslessJson()` 同步补上"值域必须是纯 JSON 形态"这一道（只做 JSON 往返结构比对会**漏判** `Map`/`Set`：两者往返后都是 `{}`，逐键比对相等）。
- **【健壮性】ACP provider 未注册时静默降级成"LLM 路由"，一次派发白烧整条 fallback 链**：product-subagents 未安装 / 被 `dsh-app-boot` 跳过（peerDependencies 不适配当前 dsh）/ 已卸载时，`ctx.subagents.getProvider(provider)` 返回 `undefined` → 本插件把该 provider 当模型路由塞进 `agentOptions` → 宿主没有这个 LLM 适配器 → 该档**立即**失败。
  **实证**（本地 09:54，DSH 09:26 升级后、product-subagents 回归 profile bundles 之前；`package.json.bak-0.7.0` 显示当时的 bundles 里确实没有它）：一次 explorer 派发在 0.3s/档 的节奏下连烧 `qoder` → `deveco` → `opencode` 三档，才落到 `deepseek-official`，决策日志把 `qoder` 记作"（模型路由）"；装上 0.7.x 后同一路由立即恢复（同日 02:08 / 02:15 两次 ACP `qoder` 派发 `completed`）。用户可见症状只是"换了几个 provider"，原因完全不可见。
  **修法**：新增 `#acpProviderMissing(route)`（判据刻意保守：**同时**满足「`getProvider` 未命中」与「该 provider 出现在 product-subagents 落盘的 `provider-catalog.json` 里」才算，普通 LLM provider 不被误判）+ 按 provider 去重的显式告警（一次进程生命周期只吼一次）+ 决策日志补 `acpProviderMissing: true` 留痕。这一档从「完全不可见」变成「原因写在脸上」。
  **刻意不改的部分（含一次被终审否决的方案）**：本版**不改变尝试顺序、不 fail-fast 跳过该档**。初版曾把这类档位「稳定沉到候选表末尾」以减少白烧，但**独立终审在真实代码路径上复现了阻断缺陷**：换档路径依赖不变式「首个候选 == `routes[0]`」——`lib/dispatch.js` 的换档文案 `targetAcp`（决定子代理收到的是 ACP 中继指令，还是「你是普通子代理，不要调用 product_submit」）、`#retryOnChildFailure` 的日志 note 与池条目 `provider`/`acpMode` 都按原始顺序取「第一个目标档」。沉底后这三处会与实际创建的 provider 不一致（复现产物：实际建的是 `qoder` ACP relay child，任务文本却写着「不要调用 product_submit」、日志写 `→ opencode`（该档从未被尝试）、池条目记 `provider=opencode/acp=false`）。省下的一秒不值得动这条链，故**撤掉重排、只保留诊断**，并把「顺序不变」固化成回归用例（把重排加回去 → 2 例立刻转红）。

### Added
- `lib/json-safe.js`：`jsonSafe()`（工具出参收口；总能返回——深度上限兜住循环引用/自返 `toJSON`）+ `isLosslessJson()`（宿主规则**本地等价**判定，25 例真值表逐例对齐；含"值为 `undefined` 的自有属性"这种不能只靠 `stringify` 再 `stringify` 比对的形态，以及 `-0`/symbol 键/非枚举自有属性/数组额外自有属性/稀疏数组这五类"往返后看着相等、宿主判非法"的形态）。
- `test/host-0.2-compat.test.js`（31 例，含"只认直接子级""目录面抛错降级""读盘不回写磁盘""顺序不变"四类由终审意见新增的用例；"与宿主同源"的真值表从 15 例扩到 25 例，找不到宿主包时显式 `t.skip` 报告而不是静默 `return`）：P1 的 0.2/0.1.x/会话存储/无目录面/运行中优先五条取数路径 + 源码护栏；P2 的 `jsonSafe` 真值表（含数组 `undefined` → `null` 保下标、函数/`symbol`、嵌套、顶层 `undefined`、`Date`/`Buffer` 保内容、`Map`/`Set`/类实例丢弃、`bigint` 两态）、`isLosslessJson` 不得漏判 `Map`/`Set`/`-0`/`symbol` 键/非枚举自有属性/数组额外自有属性/稀疏数组、`jsonSafe` 的**保证边界**（不覆盖 `NaN`/`Infinity`/`-0`/稀疏数组，仍由宿主响亮拒绝）、循环引用与自返 `toJSON(){return this}` 不爆栈（深度上限，旧路径下 `JSON.stringify` 会抛）、`agents.json` 缺字段的读盘隔离、**读盘不回写磁盘（逐字节不变）**、非字符串 model/effort 的读写两侧行为、`needsNormalize` 逐字段判定、"10 个工具全经 `registerTool`"的源码护栏、**宿主真实校验器 25 例对照**；P3 的**"顺序不变"回归护栏**、告警与日志留痕、"普通 LLM provider 不被误判"、目录抛错不误判。
- `verify.mjs` 增补一致性链断言，并按终审意见从「源码字符串匹配」改成**行为级**：不得再出现 `.status = en.activity` 形态的调用点（护栏按**赋值形态**匹配，避免把解释缺陷的注释误判）；并用假宿主实跑 `listChildren` 断言 `idle`/`ready` 的真实取值（终审实测：把 `#residentActivity` 改成 `return new Map()` 只留注释，能骗过旧护栏——现已咬住）；工具出参收口改按 `JSON_SAFE_MARK` 行为标记判定：注册进来的工具必须**全部**带标记、数量从实际注册结果数出（终审实测：多行写法的裸注册、把 `registerTool` 改成直通，旧护栏都放过——现分别被「1 个工具绕过」与「10 个工具绕过」捕获）；`lib/json-safe.js` 纳入关键文件清单。

### Verification
- `node --test test/*.test.js` **266/266 通过**（原 235 + 新 31）；`node verify.mjs` 绿灯；`node test-p1p2-smoke.mjs` PASS（9 children，含 6a/7b/7c 三条既有换档保护）。
- **本地判定与宿主规则对齐**（不是自说自话）：把 `isLosslessJson` 与宿主真实 `snapshotJsonValue` 跑同一张真值表，**25 例全部一致**——字面量对象 / 值为 `undefined` 的属性 / 数组 `undefined` / 数组 `null` / 嵌套 `undefined` / `Date` / `Buffer` / `Map` / `Set` / `bigint`（小与大）/ 类实例 / `null` / 字符串 / 函数 / `-0`（裸与嵌对象）/ `NaN` / `Infinity` / symbol 键 / 非枚举自有属性 / 数组额外自有属性 / 稀疏数组 / 空对象 / 空数组 / null 原型对象 / 深层混合。对齐过程中发现并修掉了 `jsonSafe`/`isLosslessJson` 自身的**三类**缺陷：`Date`/`Buffer` 被拍平成 `{}`（内容丢失）、`Map`/`Set` 被**漏判为合法**、`-0`/symbol 键/非枚举自有属性/数组额外自有属性/稀疏数组**漏判为合法**（后四类由终审实测指出，用例已全部固化）。
- **变异验证（修复的测试都咬得住，非空转；终审独立复跑一致）**：① P1 回退成读 `en.activity` → `test/host-0.2-compat.test.js` **3 例转红**（含「只有 0.2 的 listChildren 时不得把 idle 误降级为 ready」这条回归护栏）；② P2 读盘不做归一化 → **2 例转红**；③ **把 P3 的「沉底」重排加回去 → 2 例转红**（含「首个候选仍是 `routes[0]`」这条终审提出的不变式护栏）。
- **`verify.mjs` 行为级护栏也做了变异验证**（终审实测旧版三条字符串护栏都能被绕过，现全部咬住）：① 把 `#residentActivity` 改成 `return new Map()`、只留 JSDoc 注释 → 现在 **exit 1**；② 用多行写法新增第 11 个未收口的工具 → **exit 1**（「1 个工具绕过收口」+「工具数应为 10，实际 11」）；③ 把 `registerTool` 改成不打标记的直通 → **exit 1**（「10 个工具绕过收口」，逐个点名）。

### 未改动 / 已知边界
- 派发、换档、复用、健康计数、授权浮球、宿主审批自动放行、小队、prompt section 的既有语义**一律未动**（本版只改了驻留性取数、出参收口、读盘归一化与诊断留痕；候选顺序**保持原样**）。
- 终审登记的、**故意保留**的行为变化（都不影响正确性，列出来免得日后被当回归）：① `completedFresh` 里的历史线程现在也会被驻留性取数改写状态（`ready`→`idle`）——与 0.1.x 旧口径一致且更准确；② `agent_children` 每次会多 1–2 次宿主目录查询（`listDescendants` 会遍历子树；本插件实际树深 1，成本可接受）；③ 会话存储 `sessions.get()` 抛错时按"不驻留"记为 `ready`（与"不误降级"的表述略有出入，属信息不足时的保守取值）。
- 宿主已把**同步会话事件读取**（`session.eventAt` / `seq` / `snapshotEvents` / `ownEvents`）整体标注 `@deprecated`（Agent Note 2026-09-09）。`lib/host-approval.js` 的 `findToolCallRecord` 依赖 `eventAt` + `seq`，0.2 仍可用，但下一个升级周期若移除，宿主审批自动放行会**静默失效**（该函数首行即 `typeof` 检查后 `return null`）——留待届时处理。
- 客户端半边（`lib/client.js`）在 0.2 上逐项核对通过：`__ModuleLoader__` / `dsh.client` 契约、`slots.register|inject`、`locale` / `sessions.list.getSnapshot` / `sessions.scopeOf` / `remote` / `inputTriggers.registerSource` / `uiWorkspace.openSession` / `subagentAddress` / `react` 均在；`dsh.client.inject` 里的 `@deepseek-ai/dsh-client-store` 在 0.2 已无 `dsh.client` 声明，属**无害的空操作**（宿主对无对应行的 inject 项静默跳过），保留以兼容旧宿主。

## 1.11.20（2026-09-28）
- **清理 1.11.19 遗留的一处死代码**：`lib/roster.js` 的 `renderAgentRow` 保留了 `｜**已禁用**` 标记分支，但 `renderRoster` 在调用它之前已经 `filter((a) => a && a.enabled !== false)` 把禁用者滤掉，该分支**永远不可达**——即"花名册要不要展示禁用角色"这件事，代码里存在两种互相矛盾的意图（filter 说不展示，标记分支说展示）。
- **决策与修法（选定"不展示"）**：① 删除该标记分支；② 在花名册的路由规则里明确写出"本表只列**启用中**的角色：被禁用的角色既不在此列，也不应被委派（需要时应先由用户启用）"。选"不展示"而非"展示+标记"的理由：花名册是父级的**路由依据**，而它的用法是"按上表触发词匹配"——把不可委派的角色列进这张表，只会诱导父级委派到一个不可用的目标；"该 id 存在但已禁用"属于运维态信息，由 GUI / `agent_list` 承担更合适。
- **测试**：`test/roster-section.test.js` 的禁用用例新增 `assert.doesNotMatch(text, /已禁用/)`，把"整行不出现，而非出现但带标记"这一契约钉死，防止日后有人去掉 filter 却留下标记分支、回到同一处歧义。
- **行为影响**：条目行渲染与 1.11.19 **逐字节等价**（删的是不可达分支）；变化只有规则行新增的一句说明。`npm test` 仍 8 例全过。

## 1.11.19（2026-09-28）
- **修「父级 prompt 里的角色枚举与 agents.json 漂移」**：策略段（`dsh-agent-dispatch:policy`）是固定文案，只说了「以 agent_list 返回的 triggers 为准」，但**没有任何一段列出当前实际注册了哪些 Agent**。于是路由所需的角色清单只能来自父级自己的 persona——而 persona 是手写文本，registry 却是随时可增改的（GUI / `agent_upsert` / 手工编辑 agents.json）。真实事故：persona 里写死「explorer/simple-dev/senior-dev/architect」四个角色并把「代码审查」划给 senior-dev；此后 registry 新增 `final-reviewer`（只读、每次新开），persona 没跟着变，父级按旧枚举把**独立终审派给了实现类角色**（senior-dev 自己的 systemPrompt 本就写着「审查类任务应转派 final-reviewer，不要接单」，但父级显式下指令时它仍会接）。
- **修复（新增实时花名册 prompt section）**：① 新增 `lib/roster.js`——纯函数 `renderRoster(agents)`，把注册表渲染成「id｜name｜reusePolicy｜触发词摘要（>120 字符截断）｜模型路由链」的清单，并附两条路由规则（未出现的角色不得凭记忆推断；独立审查/对抗性审查/交付终审一律派给只读且每次新开的审核角色）；② `index.js` 注册 `dsh-agent-dispatch:roster`（order 116.6，紧随 policy 段之后），并在插件 dispose 时释放；③ `text` 传**函数**而非字符串——宿主在每次 `assemble()` 组装时求值（`dsh-system-prompt` 的 `assemble(): text: typeof section.text === 'function' ? section.text(context) : section.text`），而 `assemble()` 每个模型 step 都跑一次，且每次都从 live 的 `NamedEntries` 取对象引用。因此**注册一次即可**：registry 一变，下一次组装自动反映。这一选择同时消掉两个坑：其一，不必「dispose 同名 section 再重注册」——`NamedEntries.insert` 对同名会抛 `prompt section "…" is already registered`，而 dispose 是否同步生效需要额外依赖宿主时序；其二，不必等待异步的 `registry.init()`——渲染发生在组装时刻，必然晚于 init 完成；④ 由于不需要注册表变更回调，**`lib/agents.js` 零改动**（写盘路径、失败语义、`onChange` 一律不引入），插件的改动面收敛为「新增一个只读 prompt section」。
- **策略段措辞同步**：第 1 条由「以 agent_list 返回的 triggers 为准」改为「实时花名册见 `dsh-agent-dispatch:roster` 段（由 agents.json 渲染，是本 prompt 内唯一权威的角色清单）；不确定时再调 agent_list 复核」——把「本 prompt 内没有权威清单」这个缺口补上。
- **新增测试**：`test/roster-section.test.js`——空注册表/全禁用/部分禁用、触发词超长截断（含多字节）、`fresh` 与 `reuse` 措辞、模型路由链拼接（provider/model/effort 三形态）、两条规则文案存在性、「注册表里没有的角色不得作为条目行出现」的负向断言（按行判定：规则文案本身会举例 `final-reviewer`），以及**无内部缓存**的断言——同一数组内容变化后重新渲染必须反映变化（`text` 传函数正是依赖这一点，若日后有人在 `renderRoster` 里加 memo 化，这条会红）。
- **行为边界**：不变更任何路由/派发/换档/健康计数的既有逻辑；本段只增加 prompt 内容。花名册随 agents.json 变化**免重启**生效（与 `agent_upsert` 的「改完下一轮即生效」一致）。

## 1.11.18（2026-09-28）
- **封死 1.11.17 留下的两处残留：用户取消既不触发换档、也不计入 provider 失败**：1.11.17 只把中断从 `productFailed` 那一支摘出来，漏了两处。① `willFailover` 硬闸里 `(reason === 'error' || productFailed)` 的 **`reason === 'error'` 与 `productFailed` 同构**——宿主哪天把 abort 报成 `stopReason='error'`（而不是 `aborted`），换档就从这一支重新漏出来，复活被取消的任务；② `onChildEnd` 的健康记录仍是 `if (ok) recordSuccess else recordFailure`——被取消的 child `ok` 为 false，**必然**落到 `recordFailure`，而 ACP relay 档传 `{ hard: true }`（`threshold = 1`），于是用户在面板点一次「停止」就给该 provider 开 `60s + resumeHold 30s` 冷却，下一轮被迫从第二档起跑，且这次冷却在界面上没有任何"为什么"。
- **修复（`lib/dispatch.js` `onChildEnd`，两处各一行）**：① `willFailover` 显式加 `&& !interrupted`（`interrupted = !!entry._submitInterrupted`）；同一表达式被复制去拼诊断语的 `blockHint` 判定也同步加 `&& !interrupted`——否则被取消的一轮会给上层回传一句假的「自动换档已停止: 同任务已有活跃兄弟线程（去重跳过）」（它本就不具备换档资格）；② 健康记录改为 `if (ok) recordSuccess; else if (!interrupted) recordFailure(...)`——中断是第三种终态，**两个计数都不参与**：既不记假失败（不进冷却），也不得"顺手"记成功（那会 `recordSuccess` 洗掉该档真实的既有故障计数）。
- **为什么不会误伤真失败**：`interrupted` 仅在 `entry._submitInterrupted` 非空时为真，而该字段只由 `markChildSubmitFailed` 在 `info.interrupted === true || code ∈ INTERRUPT_CODES{SUBMIT_ABORTED, WATCHDOG_CLOSED}` 时写入。`EMPTY_RESPONSE` / `SUBMIT_TIMEOUT` / 限流耗尽（`RATE_LIMITED`）都不在其中 → `interrupted === false` → `!interrupted` 恒真，`else if` 与改动前的 `else` **逐字等价**，换档与计次语义、传参（含 `{ hard: !!entry.acpMode }`）一字未动。创建期失败的 `recordFailure(agentId, route.provider, { hard: true })`（`startContinuable` reject）另属一路，未涉及中断，保持原样。**`lib/health.js` 零改动**：`failThreshold=2` / `cooldownMs=60000` / `cooldownBackoff=3` / `maxCooldownMs=600000` / `resumeHoldMs=30000` 与冷却公式全部保持。
- **测试**：`test/interrupt-no-failover.test.js` 由 7 例扩到 **19 例**（新增 12 例）。新增的观测面是包在 `dispatcher.health.recordFailure / recordSuccess` 上的**透传 spy**（记录调用后仍走真实现），因此"根本没调"与"调了但计数没推进"两类故障都能分辨。新用例覆盖：中断 → `recordFailure` 零调用且该档无健康记录／`WATCHDOG_CLOSED` + completed 同形／该档已有故障计数时被取消 → `failCount` 与 `cooldownUntil` 一字不动／中断 → `recordSuccess` 也不被误调／真 completed 仍照常 `recordSuccess`（防豁免扩大到正常路径）／`error` + `SUBMIT_ABORTED` → 不换档、不计次、且不出现假的「自动换档已停止」／`error` + `WATCHDOG_CLOSED`（只带 code 的兼容形态）同／`error` 且**无**中断标记 → 仍换档、仍记一次 `hard:true`；对照组 `EMPTY_RESPONSE`+completed、`SUBMIT_TIMEOUT`+aborted、限流耗尽 `RATE_LIMITED`+error 三形态均**仍换档 + 仍计次 + 真的开冷却**；再加一条「真失败后紧接人为取消 → 取消赢」。`npm test` **227/227 通过**（原 215 + 新 12），`node verify.mjs` 绿灯，`node test-p1p2-smoke.mjs` PASS（其 6a「aborted 不自动换档」、7b/7c「completed + 失败标记仍换档且记失败冷却」两条既有保护同时成立，说明本次改动没把两端拉偏）。
- **对照验证（新用例咬得住这两处残留，非空转）**：同一份测试文件分别指向 **1.11.17 安装副本** 与 **1.11.16 原始备份** 运行——1.11.17 下 **7 例转红**（4 例属 1b 计次豁免、2 例属 1a 的 `error` 支、1 例属「真失败被取消覆盖」），1.11.16 下 **11 例转红**（上述 7 例 + 1.11.17 已修的那 4 例），两次 `node --test` 退出码均为 **1**；`recordFailure` 豁免类用例的首条断言为 `+ actual [{ agentId: 'senior-dev', opts: { hard: true }, provider: 'deveco' }]` / `- expected []`，即旧版确实给被取消的档记了一笔 hard 失败。

## 1.11.17（2026-09-28）
- **修「取消/interrupt 一个子代理后，同一任务约 8 秒在下一档 provider 上复活」**：`interrupt_agent` 与面板「取消」都只调 `ctx.subagents.interrupt`，没有"标记为已取消"的伴随动作；ACP bridge 把 abort 转成 `SUBMIT_ABORTED`（`agent_close` 转成 `WATCHDOG_CLOSED`），并在 `product-subagents/submit-failed` 事件上带 `interrupted: true`（`dsh-plugin-product-subagents/lib/tools/product-submit.js:99`）。但本插件的 `markChildSubmitFailed` **从不读这个字段**，一律写成 `entry._submitFailed` → `onChildEnd` 的 `willFailover` 里 `productFailed` 成立，**旁路掉了同处注释明文承诺的「aborted 是用户/主代理主动取消，尊重意图不重跑」** → `#retryOnChildFailure` 用原始任务文本 + `reuse:'fresh'` 换到下一档重跑。
- **修复（中断与产品故障分流，`lib/dispatch.js`）**：① 新增模块级 `INTERRUPT_CODES = {SUBMIT_ABORTED, WATCHDOG_CLOSED}`，与上游 `interrupted` 的判定**严格同构**；② `markChildSubmitFailed` 先判 `info.interrupted === true || INTERRUPT_CODES.has(info.code)`（两个信号都认，兼容只带 code 的上游版本），命中时写 `entry._submitInterrupted` 并**直接返回、不写 `_submitFailed`**，同时清掉此前的 `_submitFailed`——后到的人为中断覆盖先前产品故障，取消不得被换档绕过；③ `onChildEnd` 的 `productFailed` 因此天然不含中断，`willFailover` 条件 `(reason === 'error' || productFailed)` **一字未改**即恢复原语义；④ 中断是第三种终态：`ok` 加 `&& !interrupted`，使「completed + 中断」（实测 `WATCHDOG_CLOSED` 就是这一形态）不被误记为执行成功（否则会 `recordSuccess` 洗掉该档故障计数）；⑤ 留痕：`kind:'result'` 日志行新增 `interrupted` 字段（与既有 `productFailed` 同形态，仅标量、不改任何分支），失败占位文本改由 `failNote` 统一拼装，中断给出「已被取消/中断: <code>」而非一句无解释的 `步骤失败: completed`。
- **未动的既有保护**：`_userRejectedAt`（权限拒绝不换档）、`#canFailover` 的 `routes.length < 2` 硬档闸、`health.js` 冷却参数与 `recordFailure({hard})` 判定、`#retryOnChildFailure` 的换档实现——全部原样。**真失败的换档照旧保留**：`EMPTY_RESPONSE`（历史 17 例）/`SUBMIT_TIMEOUT`（3 例）都不在 `INTERRUPT_CODES` 内，仍写 `_submitFailed` 并沿 fallback 链推进到下一档。
- **数据面依据**（`~/.dsh/data/dsh-agent-dispatch/dispatches.jsonl` 中 `kind:'result'` 行的 `productFailed` × `stopReason` 交叉统计）：`SUBMIT_ABORTED` 17 例全部配 `stopReason=aborted`、`WATCHDOG_CLOSED` 1 例配 `completed`、`EMPTY_RESPONSE` 17 例与 `SUBMIT_TIMEOUT` 3 例全部配 `completed`——即"中断"与"真失败"在 stopReason 上本就同形（都可能 completed），只能靠事件里的 `interrupted` 字段区分，这正是旧实现丢掉的信号。
- **测试**：新增 `test/interrupt-no-failover.test.js`（7 例，走**真实事件入口** `markChildSubmitFailed` 而非直接塞 `_submitFailed`：abort+aborted 形态不换档且占位文本如实说明是中断／只带 code 不带布尔的兼容形态／`WATCHDOG_CLOSED`+completed 不换档且 `ok:false`／先前产品故障被后到取消覆盖／中断后 `submit-ok` 清标记不误伤成功／对照 `EMPTY_RESPONSE` 与 `SUBMIT_TIMEOUT` 仍真实换到 `opencode`）。`node --test test/*.test.js` **215/215 通过**。已做**变异验证**：把这 7 例指向 1.11.16 的 `lib/dispatch.js` 后**恰好 4 例转红**（首条断言为 `中断后不得复活同一任务：2 !== 1`，即中断确实多派了一个 child），其余 3 例（含两个真失败对照）保持绿色——说明用例既咬得住本次缺陷，又没有顺手把换档语义测成空转。

## 1.11.16（2026-09-23）
- **面板限高再加一道 `calc(100vh - 24px)` 硬上限**：1.11.15 的 `max-height:min(70vh,640px)` 在**极矮视口**（如 600px 高的窗口，70vh=420px 尚可；更极端如 400px）或浏览器缩放下仍可能超过可视高度。两个面板（`.ad-perm-pop` / `.ad-host-approval-pop`）改为 `max-height:min(70vh,640px,calc(100vh - 24px))`——`calc(100vh - 24px)` 是绝对上限，任何视口高度下面板（含 sticky 操作行）都留在视口内。
- **测试补齐为并集**：`test/fab-panel-layout.test.js` 合并两套断言——CSS 侧（限高含 `calc(100vh - 24px)`、内容区 `flex:1 1 auto` + `min-height:0` + `overflow-y:auto` + `overscroll-behavior:contain`、操作行 `flex:0 0 auto` + `sticky bottom:0`、单条消息限高与断行、面板 `min(92vw,520px)` + `right:84px` 让位不遮浮球、`.visible` 必须是 `display:flex`）+ **DOM 结构不变量**（两个面板各挂一次 `popBody`、两个 `renderPop` 清空的是内容区而非面板本体、条目与空态都进内容区、不得再有直接挂到面板本体的条目）。共 21 例。**为什么必须留 DOM 那组**：把 `popBody.textContent=""` 误写成 `pop.textContent=""` 时，CSS 断言全绿，但内容区与 sticky 按钮栏会被整体抹掉——这正是本次修复最容易被后续改动破坏的一处。
- **`node --test test/*.test.js` 208/208 通过**，`node --check lib/client.js` 通过。

## 1.11.15（2026-09-23）
- **修「授权浮球面板内容一长就超出视口：按钮被顶到屏幕外、又滚不到，点不了」**：旧布局里 `.ad-perm-pop` 是 `top:calc(50% + 30px)` + `max-height:60vh`、`.ad-host-approval-pop` 是 `top:calc(50% + 110px)` + `max-height:70vh`，两者都靠**面板本体** `overflow:auto` 滚动。面板从屏幕中线往**下**堆，遇到长内容（宿主审批的 `reason`、长命令、长路径列表）时面板下沿被推出视口，而操作按钮在行内又排在内容之后 → 按钮落在可视区之外且难以滚到。
- **修复（两个面板同套约束）**：① 面板改 `top:50%` + `transform:translateY(-50%)` **垂直居中**、`max-height:min(70vh,640px)` **硬限高**、本体 `overflow:hidden`，任何视口高度都不越界；② 新增内容区 `.ad-perm-body` / `.ad-ha-body`（`flex:1 1 auto; min-height:0; overflow-y:auto; overscroll-behavior:contain`）**由内容区承担滚动**——`min-height:0` 是 flex 子项能真正收缩的必要条件，缺了它面板还是会被撑高；③ 单条消息 `.ad-perm-item .p-desc` / `.ad-ha-item .ha-reason` 限高 `180px` 且可滚动，长路径 `overflow-wrap:anywhere` 断行，不再撑高整条（`.ha-paths` 限高由 60px 放宽到 120px 并补 `overscroll-behavior`）；④ 操作行 `.ad-perm-actions` / `.ad-ha-actions` 改 `flex:0 0 auto` + `position:sticky; bottom:0`（带底色与分隔线），**内容再长按钮也常驻可见可点**；⑤ 面板加宽到 `width:min(92vw,520px)`、`max-width:calc(100vw - 100px)`，`right` 由 `22px` 让到 `84px`，避免面板盖住宽 44px 的浮球（否则面板打开后关不掉）。
- **测试**：新增 `test/fab-panel-layout.test.js`（16 例：两个面板的垂直居中/硬限高/`overflow:hidden`/`display:flex`、内容区 `flex:1 1 auto` + `min-height:0` + `overflow-y:auto`、操作行 `flex:0 0 auto` + `sticky bottom:0`、单条消息限高与断行、宽度上限与"不遮浮球"的 right 让位；以及 DOM 结构不变量——两个面板各挂一次 `popBody`、两个 `renderPop` 清空的是**内容区**而不是面板本体（清面板会把内容区与 sticky 操作行一起抹掉）、条目与空态都进内容区、不得再有直接挂到面板本体的条目）。`node --test test/*.test.js` 203/203 通过、`node --check lib/client.js` 通过。

## 1.11.13（2026-09-22）
- **修「调用子代理后，主代理继续聊天本轮必失败：`format v4 message requires a producer-owned source kind`」**：根因在 `lib/dispatch.js` 的 `#notifyParent`——往父会话注入提示时用的是 V3 的插件包装 source `{ kind: 'plugin', plugin: 'dsh-agent-dispatch' }`。宿主 DSH 0.1.7-alpha.1 起 session log 为 **format v4**，`@deepseek-ai/dsh-session-format-v3-to-v4` 的 `assertV4SourceRowAdmission` 对 `source.kind === 'plugin'` **硬拒**（就是这条报错原文）。触发时机极易被误判成"派遣子代理本身失败"：宿主 `Agent.inject(message: UserMessage): void` 是**同步 void、当场不报错**，坏 source 要等到下一轮把 inbox 里的消息 splice 进会话（`agent/inbox/spliced`）、逐行落盘校验时才抛——所以现象是「ACP 子代理请求授权**之后**，主代理下一次发言本轮失败」，而 `#notifyParent` 的四个调用点（权限挂起 / deny 风暴 / 自动关闭失配提示）共用这一处注入，任一命中都会打死整轮。
- **修复**：改为 v4 的第三方生产者标识 `source: { kind: 'plugin:dsh-agent-dispatch' }`——与 v3→v4 迁移改写旧形态的结果**逐字一致**（`producerKind()` 对未登记插件返回 `plugin:<包名>`；宿主同形态先例见 `dsh-subagent` 的 `createSettlementMessage`，`kind: 'subagent-settled'`），并删掉 v4 已废弃的 `plugin` 字段（生产者身份由 `kind` 自己承载）。
- **测试**：新增 `test/session-source-v4.test.js`（5 例：注入消息的 source 必须是 producer-owned 且逐字等于 `plugin:dsh-agent-dispatch`、不得再带 `plugin` 字段；能解析到宿主包时用**真实的** `assertV4RowAdmission` 跑一遍，并用旧形态做对照断言确实抛 `producer-owned source kind`；父会话不可达时静默返回不 inject；源码级护栏禁止 `source: { kind: 'plugin' }` 字面量复活）。已做**变异验证**：把该行回退成故障形态后本文件 2 例转红，说明护栏真的在测这条规则，而非空转。`node --test test/*.test.js` 139/139 通过，`node verify.mjs` 绿灯。
- **宿主兼容**：本修复面向 session format v4 的宿主（DSH ≥ 0.1.7-alpha.1）。仍为 v3 会话格式的更旧宿主请继续使用 1.11.12。

## 1.11.12（2026-09-18）
- **修「编辑 Agent」表单路由行显示空白（通用缺陷，非 ACP 专属）**：路由行是受控 `<select>`，`value` 绑磁盘原值、`<option>` 只由目录生成——存值不在目录里时浏览器 `selectedIndex=-1`，下拉就显示空白。现在**存值不在候选里就把存值注入为一个额外选项**（标注「不在模型表中」/「不在档位表」）并保证选中。一处同时治好 ACP 行（provider 目录缺失）与 `deepseek-v4-flash` 这类已过时的 LLM 行。effort 退化为手输时，datalist 候选也包含这个注入的存值。
- **降级判定由全局改逐行**（旧 `fallbackToInputs = providerNames.length === 0` 是全局开关，ACP 行连手输兜底都走不到）：未知 provider / 目录不可用的 ACP provider / 无目录的 LLM provider，各自退化为「手输 + datalist 候选」，其余行仍是下拉。ACP 侧「目录可用」的判据是**条目存在且无 `error` 且 `models` 非空**（`acpCatalogTrusted`）——服务端会保留探测失败的空条目（`{models:[],efforts:[],error}`），只判「条目存在」会把探测超时/CLI 冷启动失败误判成"目录已知但没有模型"，于是渲染出一个只有空占位的 `<select>`，用户**没有任何途径**填 model。
- **provider 下拉并入 ACP provider**：`models` 的 key（LLM）+ `subagentProviders`（宿主 `ctx.subagents.list()`），去重且**撞名以 LLM 优先**；标签按来源区分——出现在 ACP 模型目录里的标「（ACP 产品代理）」，仅由宿主 `subagents.list()` 报出的（含内置 `claude-code` / `codex` / `acp` 等）标「（subagent 代理，非模型 provider）」，LLM 侧撞名标「宿主同名 ACP 已按 LLM 处理」。路由语义不变（`dispatch.js` 只看 `getProvider`）。
- **model 下拉按路由类型取数**：LLM 行取宿主目录；ACP 行取 `productModels[provider].models` 并附 `default`（产品默认模型，`lib/dispatch.js` 已把 `default` 视作不指定）。
- **effort 下拉改按 provider/model 动态取**：LLM 行用 `ctx.llm.resolveModelInfo(p,m).reasoning.{efforts,defaultEffort}`（新增 `llmEfforts` 字段，带 5 分钟内存缓存 + 单请求探测预算 24 条 / 等待上限 1.2s，超预算本轮不下发）；ACP 行取 `modelEfforts[model] ?? efforts`；**两边都拿不到时降级为「不选 + 手输」，删除了原先硬编码的 7 档**（ACP 取值域由产品定义，硬搬会静默失败）。
- **消灭 `qoder/undefined`**：卡片路由摘要改 `[provider, model].filter(Boolean).join('/')`（新增 `routeSummary`，model 为空显示「（默认模型）」并顺带补 `@effort`），显示处与 `title` 同源；`lib/dispatch.js` 全档失败的 `已尝试:` 列表同样修复。
- **放宽 model 必填（仅 ACP 路由）**：三处同步——客户端 `AgentForm.save`、服务端 `lib/agents.js validateRoutes`（新增 `isSubagentProvider` 谓词，由 `index.js` 以 `ctx.subagents.getProvider` 注入，`registry.upsert` 四个调用点全部传参）、`agent_upsert` 工具 schema（`routes.items.required` 由 `['provider','model']` 改 `['provider']`）。语义：LLM 路由仍必须 model 非空；ACP 路由允许空/`default`。附带修复：`effort` 传空串（GUI 未选时的提交形态）此前会被服务端判「effort 必须是非空字符串」而保存失败，现按「不指定」处理并在 upsert 归一化时不落空键。
- **REST 数据面**：`GET /agent-api` 新增 `subagentProviders: string[]`、`productModels`（读 `~/.dsh/data/dsh-plugin-product-subagents/provider-catalog.json`，**只读**，按 mtime+size 缓存 3s，并订阅 `product-subagents/provider-catalog-updated` 失效）、`llmEfforts`；新增 `POST /agent-api/probe-product-models`（body `{provider?}` → `ctx.emit('product-subagents/probe-provider', {...})` → 立即返回 `{accepted:true}`，不在请求里等探测）。**刻意不并入 `models`**：混进去会让 `onProviderChange` 误判并在切 provider 时清空 model（切 provider 现在的规则是：新 provider 目录可信且不含当前 model 才清空，目录未知则保留用户数据）。GUI 侧加「刷新 ACP 模型目录」按钮，探测后 1.5s/5s 自动重取。
- **探测请求失败不再全链路静默**：`emit` 抛错时服务端返回 200 `{ok:true, accepted:false, error}`，而旧客户端只 `.catch()` 网络错误、**从不看 `accepted`**，还无条件安排刷新——按钮闪一下"探测中…"，什么都不变、什么都不说。现在 `accepted === false` 直接写错误条（`d.error` 或「ACP 模型目录探测请求未被接受」）并跳过刷新；连点时旧定时器先 clear 再排（此前直接覆盖数组会漏 clear）。注意：`accepted:true` 只代表"事件已发出"——cordis 的 `emit` 在无监听者时是静默 no-op，`product-subagents` 未加载时同样不会有任何目录出现。
- **`defaultModel` 只在 provider 与 model 都非空时下发**（此前直接把 settings 原对象透传）：半截配置（`{}` 或只有一侧）会让总览页/表单标签渲染成「undefined / undefined（Agent 未配置路由时使用）」。
- **兼容与降级**：缓存文件不存在 / JSON 损坏 / `version` 不认识 / 字段形状不符、`ctx.subagents.list` 缺失（旧宿主）、`resolveModelInfo` 抛错（无该档适配器）——全部按「无该侧数据」降级，不让 `/agent-api` 报错、不炸表单。
- **输出格式变更（需求外，显式声明）**：`agent_list` 工具的路由摘要字符串由 `provider/model` 变为 `provider/model[@effort]`（model 为空时是 `provider`——ACP 默认模型档）。该字符串会进主代理可见的工具结果，下游若按旧格式解析需同步。
- **ACP 选项「显示名 / 落盘值」分离**：产品目录新增可选的 `modelOptions` / `effortOptions` / `modelEffortOptions`（`[{value, name?, description?}]`，原纯 value 数组保留），表单 `<option value>` **恒等于要写进 agents.json 的 value**，文本用 `name ?? value`，`description` 只作 `title` 提示；产品没上报 name 就显示 value（绝不拿显示名当值落盘）。读取侧三级回退：`options` → 纯 `values` → 存值 + 手输，且 `models`/`efforts`/`modelEfforts` 会与实际存在的 options 取**保序并集**——P 侧只写 options 时也不会出现"有目录却没候选"。可疑值**零改写**：即使 `deveco/GLM-52` 这种不在目录里的组合也照常保存，只标注「不在模型表中，可能不生效」/「不在档位表中，可能不生效」（旧文案只说"不在表中"，用户不知道后果）。LLM 行不受影响，档位继续用宿主上报的真档位（含 `defaultEffort` 标「（默认）」）。
- **派发期非法 model/effort 只降级、不失败（并让"填了没生效"可见）**：手工编辑 `agents.json` 写错 model/effort 时，`lib/dispatch.js` 此前既不会拦也不会说——设置照样下发，产品侧静默回退自己的默认档，用户只看到"配了没用"。现在：① 显式核对并加固了降级路径，ACP 的 model/effort 是不透明字符串，非法值不会让 `startContinuable` 或回合失败（`lib/health.js` 也不看这两个字段，不会因非法值丢档）；② 新增导出纯函数 `acpConfigNote(route, catalog)` 做**派发前目录预检**，可疑值在成功行上记 `configNote`（**只记请求值与"是否在目录中"，不含任务内容**），同时日志行补 `effort` 字段（此前只有 `model`）；③ `apply-child-settings` 下发抛错不再记 `ok:false`（那会让一次设置降级看起来像整轮失败、并误导自动换档判断），改记成功行的 `configError`；④ **订阅** product-subagents 0.6.x 的 `product-subagents/config-option-error` 事件（payload `{childId, product, kind, requested, error, configOptions}`），新增 `Dispatcher.logConfigOptionError` + 导出纯函数 `effectiveConfigValue(configOptions, kind)`，把「请求值 → 产品实际生效值」落成 `kind:'config'` 观测行（`configKind`/`requested`/`effective`/`unchanged`）；只记标量并截断，不落 `configOptions` 全量快照，也不碰任务正文；该 kind 在 `mergeDispatchHistory` 里被过滤（它不是一次委派，不该出现在历史页卡片里），仅供 grep 排障。定位生效值与 P 同构：**id 精确匹配优先 → category 兜底 → 排除已被对方认领的 id**（qoder 的 `reasoning_effort` 与 `model` 共享 `category=model`，只按 category 找会把 effort 当成模型）。`model:'default'` 与空 `effort` 的「不指定」语义保持不变，既不参与合法性判断也不下发。
- **修 ACP 档创建期失败的 `ReferenceError`（自 v1.6.2 潜伏）**：`const productSettings` 声明在 `try` 块内，而下方 `catch` 的日志行要读它 → `ReferenceError: productSettings is not defined`。命中条件为「`getProvider` 命中的 ACP 档在 `startContinuable` 阶段抛错」（例如 ACP CLI 冷启动失败）——此时**自动换档不会发生**，整个 `agent_dispatch` 以作用域报错收场，真实故障原因（`deveco 起不来`）被吞掉。非 ACP 档因 `acpMode ? … : …` 短路不求值 `productSettings` 而侥幸不命中，故既有换档用例（全走 spawn 档）一直没抓到。修复：`productSettings` / `configNote` / `configError` 上提到 `try` 之前，新增 `test/acp-config-fallback.test.js` 端到端回归（含"首档失败必须换到下一档且错误如实记录"）。
- **测试**：新增 `test/agent-api-catalog.test.js`（24 例：provider 目录缺失/损坏/版本不认识/形状不符的降级、字段净化与 `error` 空条目保留、**options 净化与值并集（含"只给 options 不给 values"与 `modelEffortOptions` 并入 `modelEfforts`）、老目录无 options 时形状不变**、事件与探测请求触发缓存失效、`subagentProviders` 旧宿主兜底、`probe-product-models` 的 emit payload 形状与 `accepted` 语义（含 emit 抛错）、`config-option-error` 订阅落地（含"历史页不展示 config 行"与"kind 不认识时静默丢弃"）、`llmEfforts` 的抛错/上报/24 条预算/1.2s 挂死上限、REST upsert 与 ACP 必填放宽的一致性）与 `test/client-form-logic.test.js`（18 例：把 client.js 里真正跑的 `acpCatalogTrusted` / `modelFallback` / `choicesWithStored` / `routeSummary` / ManageTab `probeModels`，以及 `optList` / `labelMap` / `optName` / `optDesc` / `modelChoices` / `modelOptionsFor` / `modelTextFor` / `effortsFor` 抽源码注入依赖后执行——含「文本用 name、value 仍是落盘值」「可疑值零改写仍选中」「ACP 档位模型级优先、provider 级兜底」）与 `test/acp-config-fallback.test.js`（22 例：`acpConfigNote` / `effectiveConfigValue` 真值表 + 端到端降级不失败、日志字段、`logConfigOptionError` 记账、换档 ReferenceError 回归）。`node --test test/*.test.js` 132/132 通过。`package.json` 补 `npm test`（`node --test test/*.test.js`，`node --test test/` 在 Node 22 下会把目录当模块解析而失败）。
- **修 CI 断言（`verify.mjs`，非用户可见）**：v1.10.0 的「会话规则写入失败」断言按 `length === 1` 判定，而 v1.10.2 起 `addSessionRule` 会补直接父目录（`['/tmp/**','/tmp']`）→ 该断言自 v1.10.2 起恒失败，**其后所有断言长期根本不执行**（`node verify.mjs` 红灯）。改为按内容断言，CI 恢复绿灯。

## 1.11.11（2026-09-18）
- **修复「追加任务不再续聊、凭空多出一个子代理」（定向续聊 TDZ 回归）**：`const reuseKey` 原本声明在 v1.5.0 复用段（函数体后部），而 v1.5.3 的**定向续聊（childId）**分支在【池外线程】路径（`reuse:'fresh'` 建的孩子／进程重启后插件内存复用池被清空／被 LRU 淘汰／completedFresh 历史线程）上用它拼池键，于是抛 `ReferenceError: Cannot access 'reuseKey' before initialization`。此时 `sendMessage` 其实**已经投递成功**，却被当成"续聊失败"上报，主代理据此改判"续聊不可用"→ 新开子代理，同一任务在两个线程里重复执行。修复：① `reuseKey` 上移到两个分支之前声明；② 定向续聊的 try/catch 只包【投递】——投递成功后的池记账即使出错也按成功处理（`delivered` 标记 + 降级返回），不再把成功报成失败。新增 `test/childid-continuation.test.js`（3 例：池外线程续聊成功并补记池条目／池内线程对照／只有投递失败才算失败），`node --test test/*.test.js` 62/62 通过。
- 说明：该缺陷自 v1.5.3 起潜伏，**只在"池外线程定向续聊"时命中**——DSH 升级/重启会清空插件内存复用池，使绝大多数"追加任务"落到该路径，因而表现为"升级后就不再续聊了"；并非宿主接口变更。

## 1.11.10（2026-09-14）
- **换档文案按目标档形态生成（修复末档 spawn child 误调 product_submit）**：旧实现把换档前缀硬编码为「${failoverFrom}（ACP 产品）」，当 fallback 链走到末档——末档通常是宿主侧 spawn 路由（deepseek-official 等 LLM 路由，**没有** ACP 产品会话）——spawn child 读到"ACP 产品"语境后仍去调用 product_submit，必然报 `no remote product session is bound to this agent (recovery failed)`，白烧一轮。现改为：来源档按实际形态称「（ACP 产品）/（模型路由）」，目标档非 ACP 时追加「【执行模式】你是宿主侧普通子代理…不要调用 product_submit 或任何产品中继工具」；前缀在 routes 解析之后拼装（新增导出 `buildFailoverTaskText` 纯函数，便于单测）。去重键基于 `entry.task`（原始任务），不受影响。
- **非 ACP 档失败也参与自动换档**：`#canFailover` / `onChildEnd` 去掉 `entry.acpMode` 前置条件（改为要求 `entry.provider`）——routes 首档是模型路由的 Agent 此前完全拿不到 fallback；末档与换档次数上限由既有档位判定兜底，不会原地自旋。
- **换档停止不再静默**：失败占位文本新增停止原因（新增私有 `#failoverBlockReason`，仅用于回传诊断、不参与换档决策）——「后续档位全部处于冷却中（60s×3ⁿ，上限 600s）」「已是最末档，无后续路由」「换档次数已达上限」「同任务已有活跃兄弟线程（去重跳过）」，上层不再需要猜测"链走完了"是产品故障还是调度主动停止。

## 1.11.9（2026-09-07）
- 拒绝引导改为强指令：下一条 product_submit 的 task 只允许是纯指引原文本身，禁止附加任何标题/解释/重述/格式包装（产品会话保留完整上下文，续聊只需增量）——消除 relay 的过度包装与重述。

## 1.11.8（2026-09-07）
- 拒绝引导修订：① 要求 relay 将指引【原样并入】发给产品会话的后续任务文本（减少自由改写导致的冗长/失真）；② 显式声明拒绝仅【本次任务轮】有效，新一轮/重新派发后可重新请求（防永久拒绝式过度外推）。

## 1.11.7（2026-09-07）
- 拒绝引导文案修订：优先尊重任务内已定义的替代/降级方案（如改用其他已授权路径、跳过该项、按任务规则输出占位结果），否则可自行调整方案；仅当确无任何替代方案时才结束并如实上报——避免引导误伤任务显式指定的回退行为。

## 1.11.6（2026-09-07）
- 拒绝后自动引导续聊：permission 决议为 rejected/deny 时，除标记 _userRejectedAt（不自动换档）外，向该子代理自动续聊一条引导消息——告知该权限被拒、勿重试该路径（会被拦截）、请按其他方式继续推进任务，确无替代则如实上报终止。配合 product-subagents 0.5.5 回合级静默拦截，杜绝 relay 盲目自愈重试同一被拒路径。

## 1.11.5（2026-09-07）
- 人为拒绝不自动换档：permission 决议为 rejected/deny 时标记 entry._userRejectedAt，本轮任务后续即使以产品故障（如空正文）结束也跳过自动换档重试（拒绝是人的决定，不应被 failover 绕过）；拒绝通知文案改为「本轮不会自动换档重试；如需重试请重新派发」。

## 1.11.4（2026-09-07）
- 授权双球去重（琥珀优先）：ACP 子代理权限请求的蓝球孪生条目（toolName=product_submit 且 reason 以 [ACP 开头）在琥珀球已覆盖时隐藏（仍持有 answerPromise/abort，点琥珀即生效）；琥珀 6s 未覆盖或消失时恢复蓝球兜底显示；非 ACP 审批（主代理提权等）不受影响。

## 1.11.3（2026-09-07）
- /agent-api/active 每条透出 remoteSessionTail（产品侧 submit/permission 事件回传的远程会话尾号）；markUnknownPermission 多候选提示列出候选（childId+远程尾号），便于人工对照关闭失配者。

## 1.11.2（2026-09-07）
- markUnknownPermission 自动关闭升级：deny 风暴（escalated）且该 product 活跃候选唯一时，自动关闭失配子代理（child-closed → 远程立即 dispose、删 binding、不复活），先通知父级「已自动关闭」；首次/偶发与多候选无法判定归属时仅提示（60s 去重），不自动关闭。

## 1.11.1（2026-09-07）
- 订阅 product-subagents 的 permission-unknown-session 事件（P1 宿主侧挂钩）：Dispatcher.markUnknownPermission——富日志（含 deny 风暴 escalated 标记）+ 按 provider 尽力归属活跃子代理的父级会话注入可见提示（60s 去重）；未知会话无 childId 可路由 UI，匹配不到仅落日志。

## 1.11.0（2026-09-07）

**relay 子代理生命周期与远程产品会话一致性治理**

### 新增
- **关闭即终止**（A）：agent_close 清理后 emit `product-subagents/child-closed` 事件（payload `{ childId, immediate: true }`），product-subagents 订阅后取消空闲定时器 + 立即 dispose 远程会话（closeSession + 进程终止）。
- **中断语义**（B）：ACP bridge submit 监听 exec.signal abort → closeSession + SIGKILL 终止 in-flight prompt；保留 binding 允许后续 reconnect 冷恢复。抛出 `SUBMIT_ABORTED` 错误。
- **reconnect 守卫**（C）：product-submit 恢复路径检查 `closedChildren` 集合——已被 child-closed 标记的 childId 抛出 `RECONNECT_BLOCKED` 错误，不再拉起进程。
- **自动重试同任务去重**（D）：
  - 新增 `normalizeTaskForDedup(task)` 纯函数：剥离「【前情提示】…」「【全新会话执行指令】…」等重试前缀块，确保原文与重试文本 hash 一致。
  - 新增 `activeTasks = Map<dedupKey, Set<childId>>`：dispatch 成功时注册，onChildEnd/closeChild 注销。
  - `#canFailover` 增加同任务活跃兄弟检查——有活跃（running/未结束）兄弟时跳过自动重试，防止三连重复。
  - 去重键 = `agentId + sha256(normalizeTaskForDedup(task))`。
- **单测**：`test/dedup.test.js` 覆盖 normalizeTaskForDedup 与 dedupKey（原文、带前情提示、带全新会话指令、多前缀、空文本等场景）。

### 变更
- `purgeParent` / `dispose` 清理 activeTasks 去重表。
- closeChild 对运行中 child 也发 child-closed 事件。

## 1.10.2（2026-09-06）
- 规则粒度对齐：主代理「本会话总是允许/总是允许(项目)」写规则时为每个路径补直接父目录（expandPathsWithParents），对齐 ACP 子代理权限请求 [文件,父目录] 形态——否则子代理无法复用主代理落盘规则（父目录未被覆盖 → 弹窗）。已存在目录不向上补。

## 1.10.1（2026-09-06）
- 修复：GET /agent-api/host-approval-context 误用 popPendingContext（破坏性弹出），导致客户端先 GET 展示路径后 POST 写规则时上下文已空、规则写入 400 静默失败（点「本会话总是允许/总是允许(项目)」只放行本次、不记忆）。GET 改为 peekPendingContext 非破坏窥视；POST 保持单次 pop。

# Changelog

## 1.10.0 (2026-09-06)

**主代理宿主审批分档自动放行 + 浮球四按钮**

主代理（宿主 ApprovalService 层）的审批请求，除现有「允许一次/拒绝」外新增两个作用域档，按路径规则自动放行：

### 新增
- **会话级自动放行**：「本会话总是允许」内存规则，键=session id，值=路径规则集合；会话 dispose 时自动清理。命中 → 自动答 `allowed-once`（宿主仍逐条落 approval/asked+decided 审计）。
- **项目级自动放行**：「总是允许(项目)」落盘共用文件 `$DSH_HOME/data/dsh-plugin-product-subagents/allowlist.json`，键=cwd+路径；与 ACP 层（product-subagents）双向复用——主代理落盘的条目 ACP 层可命中，反之亦然。覆盖判定忽略 product 字段。
- **浮球四按钮面板**：`lib/client.js` 新增 `mountHostApprovalFab`，通过 `ctx.remote.$on("approval/request")` 接收审批请求，呈现四按钮：允许一次 / 本会话总是允许 / 总是允许(项目) / 拒绝。点击作用域按钮 = 先写规则再放行本次。
- **REST 端点**：
  - `GET /agent-api/host-approval-context?callId=&sessionId=` → 审批上下文（toolName, paths[], reason, cwd）
  - `POST /agent-api/host-approval-rule {scope:'session'|'project', sessionId, callId, cwd}` → 写规则（服务端重取路径，不信任客户端）
- **规则引擎**：`lib/host-approval.js` 纯函数引擎（normalizeCandidate/pathAllowed/allowlistDecision/extractToolPaths/findToolCallRecord/resolveApprovalContext），语义对齐 product-subagents lib/allowlist.js + lib/user-allowlist.js。

### 变更
- `index.js`：approval/request prepend 监听暂存解析结果，REST 端点消费；版本升至 1.10.0。
- `lib/host-approval.js`：重构为共用 allowlist.json（移除独立文件落盘）；HostApprovalRules 类会话规则内存 + 项目规则共用落盘。

## 1.9.3 (2026-09-06)

**修复：授权球不显示 product_delegate（宿主 product 子代理）的 ACP 权限请求**

真实链路（v16/v17 验证）暴露：`product_delegate` 创建的 deveco/ACP product 子代理读白名单外路径时，子代理侧「申请授权中」、宿主审批弹窗落在其会话界面，但主窗口独立「待授权」悬浮球（授权球）不出现、计数为 0——审批请求"只有入口没有出口"，用户在主窗口无从点选授权球四按钮。

根因：product-subagents 对所有 ACP 子代理统一发 `permission-pending` 事件，但 dsh-agent-dispatch 的 `markPermissionPending` 只查 `activeChildren`（仅覆盖本插件派遣的 agent 子代理），非本插件派遣子代理（product_delegate 等）的挂起被静默丢弃；`/agent-api/active` 因而无其条目，授权球 3s 轮询永远看不到。

### 变更
- `dispatch.js`：新增 `externalPending` 表（childId → { product, description, paths, cwd, parentSessionId, at }）。`markPermissionPending` 对不在 `activeChildren` 的子代理改为登记 `externalPending`（不再丢弃）；`markPermissionResolved` 决议后清除；`onChildEnd` 子代理终结时同步清理（未决议即结束不残留授权球）。
- `index.js` `/agent-api/active`：并入 externalPending 合成条目（agentName=`{product} 子代理`、含 `permissionPending`/`parentSessionId`）→ 授权球显示计数、描述与四按钮（允许一次/本会话总是允许/总是允许(项目)/拒绝）；决策端点 `/agent-api/permission-decision` 本就按 childId 转发、无归属检查，按钮对 product 子代理直接生效（双通道竞速照常）。

## 1.8.0 (2026-09-06)

**主窗口感知「子代理待授权」**——ACP 交互授权（product-subagents 0.4.0/0.4.1）的 UX 闭环：审批弹窗按宿主 scope 设计落在子代理会话界面，主窗口此前无从知晓。本版让主代理环境即时感知有子代理在等权限授权。

### 新增
- **跨插件事件订阅**：监听 product-subagents 的 `permission-pending` / `permission-resolved`，在 activeChildren entry 上标记/清除 `permissionPending`（REST `/agent-api/active` 透出）。
- **主代理对话内提示**：pending 时向父级主代理会话 inject 一条不唤醒的用户消息（⏳ 谁在请求什么权限、请提醒用户前往授权）；resolved 后再 inject 结果（✅ 已批准 / ⛔ 已拒绝）。仿宿主 user-approval 的 `agent.inject(createUserMessage)` 同款机制——只入会话不触发回合，主代理空闲时不被烧模型。
- **独立「待授权」悬浮球**（`mountPermFab`）：有 pending 时屏幕右中位置自动出现琥珀 ⏳ 球 + 红色计数（3s 轮询），点击展开待授权列表（子代理名/权限描述/前往授权 → 点击跳转该子代理会话）；无 pending 自动消失。与主 FAB 完全独立（主 FAB 可隐藏/never 不影响授权球出现）。
- **FAB/面板增强**：主 FAB 有 pending 时琥珀脉冲光效（fab-pending，优先级高于运行/完成光效，结束后按设置恢复呼吸）；AgentPanel 头部显示「⏳ N 待授权」胶囊；运行中卡片 pending 时徽标变「⏳ 待授权」（点击卡片仍跳转子代理会话）。

### 变更
- verify.mjs：fab-live 断言随 pending 让位逻辑更新，新增 fab-pending 断言。

## 1.7.1 (2026-09-06)

**真实链路验证修复：自动换档触发信号改为结构性事件（跨插件）**

1.7.0 的真实验证暴露缺陷：ACP relay child 是 LLM agent——product_submit 工具报错（空正文/超时/限流耗尽）后，它会把错误"转达"并以 `completed` **正常结束回合**，宿主 `subagent/end` 的 stopReason 恒为 completed，`onChildEnd` 的 `stopReason==='error'` 换档条件在真实链路上几乎永不触发；且失败的 deveco 还会被 `recordSuccess` 记成成功。

修复：product-subagents 0.3.7 在 `product_submit` 抛错/成功处向事件总线 emit `product-subagents/submit-failed` / `submit-ok`；dsh-agent-dispatch 1.7.1 订阅事件，`markChildSubmitFailed` 在 activeChildren entry 上打结构性失败标记，`onChildEnd` 时**失败标记优先于回合 stopReason**——completed+失败标记按失败处理（记健康冷却 + 自动换档），`submit-ok` 清除标记防同一回合二次提交成功被误判。

### 变更
- product-subagents 0.3.7：`lib/tools/product-submit.js` 抛错处 emit `submit-failed`（childId/product/code/message）；成功处 emit `submit-ok`。
- dsh-agent-dispatch 1.7.1：`index.js` 订阅两事件（带降级：旧版 product-subagents 无发射点时自动换档退回 stopReason==='error'）；`dispatch.js` 新增 `markChildSubmitFailed` / `markChildSubmitOk`；`onChildEnd` 以 `entry._submitFailed` 优先判定成败（日志 result 行带 `productFailed` 字段），换档失败详情用结构化 code/message。
- 集成冒烟新增真实链路场景：submit-failed 事件 + completed 回合 → 自动换档（7b）；submit-ok 清除 → 不误判（8b/8c）。

## 1.7.0 (2026-09-06)

**运行期路由健康与自动换档（P1/P2）**——routes fallback 从「只在创建期互备」升级为「运行期失败可感知、可冷却、可回归」的档位系统。配合 dsh-plugin-product-subagents 0.3.6（ACP 桥超时/空正文检测/429 熔断）闭环：deveco 等产品运行期故障（429 熔断耗尽/超时/空正文 → 子代理 error 结算）不再需要主代理手动换人，链内自动消化。

### 新增

- **`lib/health.js`（新）Provider 健康状态机**：per (agent, provider) 记录失败计数与冷却（基准 60s、指数退避 ×3、上限 10min、resumeHold 防 flap）；ACP relay 子代理 error 视为 hard failure 立即冷却（relay 无任务逻辑错误，error 只可能来自产品侧）；成功清零。配置经 agent.routing.quality 透传（agents.json 可编辑，agent_upsert 保留）。
- **P1 新建跳过冷却档**：`health.availableRoutes` 过滤冷却中的 provider 后再建 child——deveco 刚失败时新任务自动落 opencode/deepseek，不再撞同一堵墙；全部冷却时保留原序硬试（宁试不空等，冷却加深自然保护后续轮次）。
- **P2 同任务自动换档（`onChildEnd` + `#retryOnChildFailure`）**：ACP relay child 以 error 结算时，沿 routes 取失败档之后第一个未冷却的 provider，用同一任务文本自动重新派发（fire-and-forget，带【前情提示】说明前档失败原因）；**fallback 链走完前主代理/squad 收不到失败**——waitResult 场景的 waiter 迁移到换档后的新 child，链内 error 不兑现、最终成功/整链失败才结账；aborted（用户主动取消）不触发换档；换档次数上限 = 档位数-1 防死循环。
- **P2 轮间向上回归（upgrade 决策）**：续聊命中的 child 档位低于当前最高可用档时，优先改道续聊高档 ready child（零成本、历史完整），无现成 child 则放弃续聊 fall-through 新建高档 + 注入【前情摘要】（低档 child 留池打 keep 保底，LRU 淘汰豁免）。
- **ACP relay persona 失败语义提示**：product_submit 报错时 relay child 会说明「将自动换档重试，无需重新派发」——避免主代理收到中间失败 notice 后误判停掉子代理。
- **failover 新 child 继承池位**：换档成功线程入复用池（原线程留池保底），延续任务可续聊成功线程。
- **创建期失败也记健康**：startContinuable reject（CLI 起不来/握手失败）立即冷却该 provider。
- 决策日志：`kind:'result'` 行带 provider；换档/回归/冷却跳过各记一行 `note`，全链路可回溯。

### 验证

- `verify.mjs` 一致性链通过；新增 `test-p1p2-smoke.mjs` 集成冒烟（桩化宿主 subagents 全链路驱动：首派成功/error 换档/二次换档/链尾成功/冷却过滤/aborted 不换档/waiter 迁移/升级回归/keep 保底），全部通过。

## 1.6.0 (2026-09-04)

**悬浮球配置落盘改造**——FAB 的「隐藏状态 + 位置 + 光效设置」原先只写 webview iframe 的 `localStorage`；插件运行在 VS Code webview（`fengze233.dsh-vscode-panel`）中，每次重建窗口/面板都换 `vscode-webview://<uuid>` 顶层 origin，http-origin localStorage 被分区隔离整体丢失，配置随每次重开蒸发。现在配置经宿主半落盘 `$DSH_HOME/data/dsh-agent-dispatch/fab-config.json`，跨 VS Code 重启 / webview 重建 / 端口回退可恢复。

### 新增

- **宿主落盘模块 `lib/fab-config.js`**：`readFabConfig` / `mergeFabConfig`（字段级合并：`visible` / `mode` / `pos` / `settings`，settings 浅合并保留未提及旧键），同步原子写（同目录 `.tmp` + rename，与 agents.json 同机制），校验从严（类型不符抛错 → REST 400 透传），读取只透出已知且类型合法字段，损坏文件 loudly 告警并按无配置处理（下次写入自愈）。
- **REST 路由**：`GET /agent-api/fab-config`（返回 `{ ok, config }`，无值 `config:null`）+ `POST /agent-api/fab-config`（字段级合并写入），复用既有 `/agent-api` prefix 注册，client 经同源 `apiGet`/`apiPost` 调用，无新增依赖与 inject。

### 修复

- **client 读时序**：宿主值 > `localStorage` > 默认。`mountAgentFab` 增加 boot 装载流程：先按 `localStorage` 同步就位（单浏览器行为不回退），异步拉宿主配置逐字段回放（visible / mode / pos / settings），宿主值镜像回 `localStorage` 保持运行时一致。
- **防闪现**：装载完成前 FAB 保持 `display:none`，由 boot 统一揭示——否则 VS Code 重开后「已隐藏」的球会先闪现在默认位置再消失。三路保证揭示：宿主响应（含 null）/ 请求失败回退 / 1.5s 超时兜底，宿主卡死也不会丢球；装载期 `poll` / `setFabVisible` 不抢 display。超时后迟到的宿主值仍回放（宿主是权威持久源）。
- **存量迁移**：宿主无值而 `localStorage` 有的字段，装载后一次性上载（仅一次，防重复写）；升级前的老配置不丢。
- **竞态守卫**：装载期间用户在面板切换过总开关（`fabVisibleTouched`）则跳过该字段回放与上载——宿主响应已过期，本地值更新且已双写。
- **消除静默吞错**：FAB 全部 `localStorage` 读写走 `lsGetFab`/`lsSetFab`（失败 `console.warn`）；宿主通道失败区分两类告警——「宿主通道不可用，已回退 localStorage」（读/装载失败）与「宿主持久化失败（已回退 localStorage）」（写失败）；损坏的 `ad-fab-pos`/`ad-fab-settings` JSON 解析失败也告警。
- **设置写路径统一** `writeFabSettings`：内存态 + `localStorage` 副本 + 宿主通道三写；滑杆连续 input 高频触发时宿主通道 300ms 防抖合并（localStorage 仍逐次落），悬浮球卸载时冲刷防抖残留防丢最后一次改动。

### 验证

- `verify.mjs`：新增 v1.6.0 静态断言（fab-config 原子写、GET/POST 路由、`fabHostSave`/`fabBootDone`/`fabVisibleTouched`/`writeFabSettings`/`revealFab`、两类回退告警文案、FAB localStorage 无裸 catch 空块）+ 运行时单测（无文件 null → 部分合并不丢字段 → settings 浅合并 → 落盘读回 → 7 类非法补丁抛错 → 损坏文件 null + 写入自愈）。

## 1.5.4 (2026-09-02)

**修复 agent_children 不展示 fresh 策略已完成子代理线程**——fresh/reusePolicy:fresh 或小队专属子代理完成后从 `activeChildren` 移除且从未进入 `childPool`，`agent_children` 无法看到它们，导致不可通过 `agent_dispatch(childId=...)` 定向续聊。

### 修复

- **`completedFresh` 历史记录**（`Dispatcher` 新增 `Map<childId, entry>`）：`onChildEnd` 检测到完成的 child 不在复用池时，插入轻量历史条目（`childId`/`agentId`/`taskLabels`/`parentSessionId`/`completedAt`），与 `childPool` 互斥——同一 `childId` 不同时出现在两处。全局上限 `COMPLETED_FRESH_CAP=50`，超限按 `completedAt` 淘汰最旧。
- **`listChildren` 合并展示**：池条目与活跃条目之后遍历 `completedFresh`，未出现在池/活跃中的历史线程以 `status: 'ready'`（仅持久会话，可冷恢复续聊）展示。现有宿主 `listChildren` 状态细化逻辑（idle/ready override）和 `agentId` 过滤 + 排序不变。
- **`closeChild` 识别历史记录**：`childId` 查找和 `agentId` 批量关闭均覆盖 `completedFresh` 条目；关闭 = 移除历史记录 + `drainChild`。不再报"不在复用池/活跃映射中"。`agentId` 批量路径增加 `seen` 去重（同一 childId 不重复关闭）。
- **`followup()` 续聊状态同步**（P1 修复）：`agent_followup` 对 `completedFresh` 中的线程续聊时，移除历史条目（互斥）+ 写 `activeChildren`（使 `listChildren` 展示 `running` 而非 `ready`）+ 取消池条目释放定时器；续聊失败不修改状态。修复后：续聊运行中可见为 `running`，结束后正确重入 `completedFresh`（不丢失也不重复）。
- **定向续聊进池时移除历史**：`agent_dispatch(childId=...)` 续聊池外线程时，该线程补记进 `childPool` 后同步从 `completedFresh` 删除（互斥保证）。
- **清理路径**：`purgeParent` 清理该父会话全部 `completedFresh` 条目；`dispose` 清空 `completedFresh`。

### 验证

- `verify.mjs`：新增 v1.5.4 静态断言（`completedFresh` Map、`COMPLETED_FRESH_CAP`、`#isInPool`、`#pruneCompletedFresh`、`onChildEnd` 插入、`listChildren` 遍历、`closeChild` 清理、续聊互斥、`dispose`/`purgeParent` 清理）+ 运行时单元测试（fresh 子代理完成 → `completedFresh` 可见 → `listChildren` 返回 ready → `closeChild` 关闭 → 池线程不重复记录 → `purgeParent`/`dispose` 清理）。

## 1.5.3 (2026-09-02)

**按 session id 定向续聊 + 线程列表**——续聊只认 session id，进程/驻留是否新启动无关（冷恢复自动），支持续聊"隔开的"旧线程（不是最近一个）。

### 新增

- **`agent_dispatch` 新增 `childId` 参数**（最高优先级，覆盖 `reuse`）：显式指定子代理 session id 定向续聊——`sendMessage` 直投该 session（宿主校验本会话相邻关系），驻留/ready/进程已回收都能续（按持久会话冷恢复）。典型场景：要复用的不是最近一个子代理，而是隔开的旧线程（A → B → 续 A）。失败**抛错不静默降级**（跨会话不可续会明确报错，提示用 `agent_children` 查线程或去掉 childId 走 auto）。续聊后自动补记/更新复用池条目，后续 auto 也能命中。
- **`agent_children` 工具**：列出当前会话的子代理线程——`childId`（可作 `agent_dispatch` 的 childId）、`agentId`、最近任务标签（线程识别用）、状态（`running` 执行中 / `idle` 驻留空闲 / `ready` 仅持久会话可冷恢复）。可选 `agentId` 过滤；状态经宿主 `listChildren` 细化，不可用时按活跃映射派生。
- 决策日志：定向续聊记 `reuseReason: 'explicit-child'`。
- 递归护栏：`agent_children` 纳入 DENY_CANDIDATES / OWN_TOOL_NAMES / noDelegateTools（子代理不可管理线程树）。

### 验证（端到端，临时 DSH_HOME + mock LLM）

- 场景：orders 线程 A → 部署文档线程 B（B 成为最近）→ `agent_dispatch(childId=A, "再查支付状态")` → **命中 A（explicit-child）而非最近线程 B**，A 答复"第 2 轮"（上下文延续）→ `agent_children` 正常 → 小队专属 child 全链路通过。

## 1.5.2 (2026-09-02)

**不复用子代理的回收机制补强**：智能复用决策判"新开"之后，旧子代理的回收路径显式化 + 提供显式关闭工具。

### 回收机制（回答"不再复用的子代理如何回收"）

- **进程内 spawn 子代理**（默认 provider，绝大多数委派）：无 OS 进程。宿主在每轮 settled 后自动释放驻留 Activation（子代理降为 `ready`，内存/注册表槽位自动回收）；插件另有 `idleReleaseMs`（默认 10 分钟）定时 `drainContinuableChildren` 安全网。仅持久会话 JSONL 留在磁盘（宿主无删除 API）。
- **ACP 子代理**（deveco 等，经 product-subagents）：后台进程归 `dsh-plugin-product-subagents` 管理——**每轮 `subagent/end` 即启动 `idleTimeoutMs`（profile 配置 600000ms=10 分钟）倒计时** → `bridge.dispose` 对 ACP 进程 SIGTERM + 删绑定；复用（续聊→`product_submit`）`cancelDispose` 取消定时器；进程死后远端会话 id 由 `~/.dsh/product-subagents-registry.json` + 会话日志 `PRODUCT_SESSION:` marker 双保险保留，后续续聊新起进程 + `session/load` 重连原远端会话，连续性不丢。
- **智能决策与回收的关系**：`auto` 判"独立新任务"新开子代理时，旧线程仍留在复用池（LRU≤3）供其自身续聊——若一直不复用，其驻留/进程照常按上述机制回收；池超限淘汰 = 确定不再复用。

### 新增

- **`agent_close` 工具**（v1.5.2）：主模型确认某条线程"不再继续"时显式关闭——`childId` 关指定子代理 / `agentId` 关该 Agent 当前会话全部闲置子代理。关闭 = 立即移除复用资格（池条目 + 释放定时器）+ 非运行中立即 `drainContinuableChildren` 释放驻留；运行中的不打断任务（结束即自然回收）。ACP 后台进程仍由 product-subagents `idleTimeoutMs` 收尾（关闭时其最后一轮已启动倒计时）。
- **淘汰即回收**：`#evictPool` 淘汰 LRU 超限 child 时（确定不再复用）立即 fire-and-forget drain 驻留（原仅清定时器）。
- 统一释放路径 `#drainChild(parentSessionId, childId)`（idle 释放 / 淘汰 / 显式关闭三处共用，幂等）。
- 决策日志新增 `kind:'close'` 行（childId/agentId/closing=drained|running）。
- `agent_close` 纳入递归护栏（子代理不可用）与 DENY_CANDIDATES；路由策略 prompt 新增第 10 条指导。

### 其他

- `verify.mjs`：工具数 8→9；新增 v1.5.2 断言（agent_close 注册/透传、closeChild、#drainChild、淘汰 drain）。
- 端到端验证（临时 DSH_HOME + mock LLM）：orders 线程复用 → 部署文档线程新开 → 继续命中部署线程 → `agent_close(agentId)` 双线程关闭（idle 的 drained、运行中的 running 不打断）→ 关闭后再"继续部署文档"**新开不再复用** → 小队专属 child，全链路通过；释放日志 2 次。

## 1.5.1 (2026-09-02)

**同角色子代理复用升级为智能决策**：不再无差别复用——按"新任务 vs 上一任务的渐进延续"决定复用对应旧子代理还是新开。

### 智能复用（v1.5.1 核心）

- **`agent_dispatch` 新增 `reuse` 参数**（`'auto'` 默认 / `'reuse'` / `'fresh'`）：
  - `auto`（默认）：延续性启发式决策——新任务含续写标记词（继续/接着/追加/补充/在此基础上/接下来/再/continue/follow-up/as before…）或与某子代理的最近任务共享显著词汇（文件路径/文件名、ASCII 标识符、CJK 双字词）→ 复用匹配度最高的该子代理（`send_message` 续聊，上下文延续）；否则视为**独立新任务 → 新开子代理**（避免旧上下文污染与 token 膨胀）。
  - `reuse`：强制复用最近同角色 child（模型明确知道是同一线程续聊时用）。
  - `fresh`：强制新开（模型明确知道是独立新任务时用）。
  - Agent 级 `reusePolicy` 是 auto 的兜底：`fresh` 策略（探索型）在 auto 下永远新开。
- **复用池升级为多线程 LRU**：`(父会话, Agent)` 下保留最近 `POOL_CAP=3` 个 child（各带最近 2 条原始任务文本作比对语料）——不同任务线程的续聊各自命中正确的子代理，不互串；超上限按最近使用淘汰。
- **决策日志新增 `reuseReason`**：`explicit`（调用方强制）/ `continuation`（标记词+重叠）/ `continuation-marker`（仅标记词，按最近使用兜底）/ `continuation-overlap`（仅重叠）/ `fresh-task`（auto 判定独立新任务）/ `policy-fresh`（探索型策略）/ `dedicated`（小队专属）。
- 启发式细节：比对用**原始任务**而非包装文本（任务/输出要求样板会污染词法判定，首版即踩坑）；续写标记词对单字词（再/然后/还有）与"继续+无具体指向"做了阈值与最近使用兜底，避免误判。

### 其他

- `verify.mjs`：新增 v1.5.1 断言（reuse 参数 schema、continuationScore、CONTINUATION_MARKERS、significantTokens、POOL_CAP、lastTasks、#evictPool、reuseReason）。
- 端到端验证（临时 DSH_HOME + mock LLM）：orders 线程两次委派复用同一 child（答复2 上下文延续）→ 探索型 fresh 新开 → **独立新任务（部署文档）自动新开** → "继续完善部署文档"**命中部署线程而非 orders 线程** → 小队专属 child 全链路通过；空闲释放日志 2 次。

## 1.5.0 (2026-09-02)

**DSH 0.1.2-alpha.4（最新版）兼容性修复 + 同角色子代理复用 + 空闲回收。**

升级后插件无法挂载（`registerContinuableSetup` 已从宿主删除），本次同时解决三个问题：
① 新宿主 API 兼容；② 同角色子代理优先复用（`send_message` 续聊，探索型角色除外）；
③ 子代理长时间不回收（完成一轮后空闲自动释放驻留资源，持久会话保留可冷恢复）。

### 兼容性修复（新宿主 API 迁移）

- **`index.js`**：删除 `ctx.subagents.registerContinuableSetup`（宿主已移除该 API，挂载即抛错）——
  递归护栏改为**全局 `tools.guard`**：按调用方 `exec.agent.options.subagentDepth >= 1` 在【执行时】拒绝子代理调用任何"再起新代理 / 管理委派树"的工具。
  覆盖所有插件层工具（含未在 deny 名单的跨插件工具如 `product_delegate`）；豁免 `send_message`
  （子代理→父级回传结果，替代已删除的 `report` 工具）与 `product_submit`（ACP 中继）。
  与 `dispatch()` 入口 `callerDepth >= 1` 硬检查 + `startContinuable` 的 `toolFilter.deny` 三保险。
- **`lib/dispatch.js`**：
  - `followup()` 改走 **`ctx.subagents.sendMessage(sender, targetId, content, { signal })`**
    （旧 `ctx.subagents.followup` 已删除；`signal` 为硬性字段）。驻留子代理 steer、已释放子代理自动冷恢复。
  - `agentOptions.effort` → **`reasoningEffort`**（新宿主 AgentOptions 字段）。
  - `toolFilter.deny` 名单改为 **`DENY_CANDIDATES` + `#safeDenyList()` 动态求交集**
    （与 `ctx.tools.view(undefined).knownNames` ∪ 本插件自有工具名求交）——新宿主
    `tools.restrict()` 对未知工具名 loud throw，旧静态名单会把未加载插件的工具名
    （如 `product_delegate`）塞进 restrict 导致子代理创建失败。
  - `interrupt` / `getProvider` / `subagent/end`（`{runId, provider, id, stopReason, lastAssistantMessage}`）契约不变。
- **`lib/client.js`**：Agent 编辑表单新增「子代理复用策略」下拉（reuse/fresh）+ 卡片 fresh 角标。
- **`lib/agents.js`**：注册表新增 `reusePolicy` 字段（`reuse`/`fresh`，默认 `reuse`），校验 + 规整 + 持久化。
- **`agent_upsert` / `agent_list`**：支持/展示 `reusePolicy`。

### 同角色子代理复用（v1.5.0 核心）

- 复用池：`(父会话 id, agentId) → childId`。`reusePolicy='reuse'`（默认）时，同一父会话内同 Agent
  的后续委派直接 `send_message` 复用同一子代理（上下文延续，不再重复新建冷启动）；
  `reusePolicy='fresh'`（探索型角色）每次独立新开。小队步骤 `dedicatedChild=true` 保持专属子代理（并发安全）。
- 决策日志新增 `reused: true/false` 字段，历史页可区分"复用续聊"与"新建"。

### 子代理空闲回收（v1.5.0 核心）

- 子代理完成一轮（`subagent/end`）后进入空闲状态：`idleReleaseMs`（默认 10 分钟；配置 `idleReleaseMs`
  或环境变量 `DSH_AGENT_DISPATCH_IDLE_RELEASE_MS`，0 关闭）内未被复用 → 调用宿主
  **`drainContinuableChildren(parent, [childId])`** 释放驻留 Activation（内存/注册表槽位回收）。
  持久会话保留，下次复用自动冷恢复，上下文不丢——"复用 + 回收"共存。
- 复用（send_message 成功）取消释放定时器；父会话 `session/disposed` / 插件卸载时清理池状态。
- ACP 子代理（deveco 等）的进程回收仍由 `dsh-plugin-product-subagents` 的 `idleTimeoutMs` 负责，本插件不重复处理。

### 其他

- `verify.mjs`：apply 桩补 `tools.guard/view`；断言更新为新 API（sendMessage / reasoningEffort /
  drainContinuableChildren / reusePolicy / 动态 deny / 全局 guard）。
- 已用临时 DSH_HOME + mock LLM 端到端验证：挂载 → 委派 → 同角色复用（同一 childId、上下文延续）
  → fresh 新开 → 子代理再委派被护栏拒绝 → 空闲释放 → 冷恢复复用 → 小队 waitResult 全链路通过。

## 1.4.2 (2026-08-31)

加固：堵住"子代理自身 scope 工具绕过 toolFilter"的漏洞——harness 把 `report`/`subagent` 等工具注册进子代理 own-layer，`tools.restrict` 的 allow/deny 只过滤"继承面"、刻意豁免 own-layer 工具，故仅靠 deny 名单去不掉 `subagent`/`subagent_fork`。

- 修改（`index.js`）：`ctx.subagents.registerContinuableSetup` 里注册 `childCtx.tools.guard`，在【执行时】拒绝子代理调用任何"再起新代理 / 管理委派树"的工具：`agent_dispatch`/`agent_squad`/`agent_upsert`/`agent_import_skill` 系 + `subagent`/`subagent_fork`/`subagent_progress`/`list_agents`/`interrupt_agent`/`send_message`/`product_delegate`/`product_wait`/`product_roles`/`workflow`/`ralph`/`create_goal`/`get_goal`/`update_goal`。
- 保留 `product_submit`（ACP 中继转发任务）与 `report`（子代理回传结果）不被误伤。
- 影响：对宿主所有可续聊子代理生效（"子代理一律不得再委派"）；需重启 DSH 生效。

## 1.4.1 (2026-08-31)

加固：低成本子代理禁止再向下委派，必须自己完成被指派的任务（防止把任务再派回付费模型，如 architect / deepseek-official）。

- 背景：此前仅对子代理 deny 本插件的委派工具（`agent_dispatch` / `agent_squad` 等），子代理仍可用宿主通用工具（`subagent` / `subagent_fork` / `workflow` / `product_delegate` 等）另起第三层代理，可能被再次路由到付费模型，造成成本泄漏；且全局注入的「Agent 委派策略」路由段也会诱导子代理去委派。
- 修改一（`lib/dispatch.js` 创建子代理的 `toolFilter.deny`）：把通用子代理工具一并纳入 deny——`subagent` / `subagent_fork` / `subagent_progress` / `list_agents` / `interrupt_agent` / `send_message` / `product_delegate` / `product_submit` / `product_wait` / `product_roles` / `workflow` / `ralph` / `create_goal` / `get_goal` / `update_goal`。
- 修改二（`lib/dispatch.js` `dispatch()` 入口）：新增硬护栏——当调用方本身是子代理（`parentAgent.options.subagentDepth >= 1`）时直接抛错拒绝委派，与 deny 名单构成双保险，即使 deny 被绕过也物理阻断第三层及更深层委派。
- 修改三（`index.js` 「Agent 委派策略」路由段）：追加「适用范围」说明——该策略仅对具备委派工具的编排层生效；若子代理收到本段，须忽略委派建议、自完成任务、禁止再起新代理。
- 影响：需重启 DSH 生效。

## 1.4.0 (2026-08-31)

新增：ACP / subagent provider 路由支持——Agent 的 `routes` 现在可以直接指向宿主已注册的 subagent provider（如 product-subagents 插件注册的 deveco ACP 服务、claude-code / codex 桥），任务经 ACP relay 模式执行，不再要求 routes 必须是 LLM 模型路由。

- 背景：此前 `routes[].provider` 一律塞进 `agentOptions`（LLM 模型路由）。当 provider 是 ACP 服务（如 `deveco`）时，LLM 路由表里不存在该 provider，子代理激活报 `NO_ADAPTER: no adapter registered for provider "deveco"`，Agent 完全不可用。
- 修复：`lib/dispatch.js` 路由解析时先查 `ctx.subagents.getProvider(route.provider)`——命中即 subagent provider，走 ACP relay 模式：
  - `spec.provider` 直接传 `route.provider`（由 product-subagents 等插件建立 ACP 桥接与绑定）；
  - persona 拼接 `agent.systemPrompt` + 「ACP 执行模式」转发指示（任务经 `product_submit` 原样转发给 ACP 代理，结果如实转达）；
  - `toolFilter` 改为 `{ allow: ['product_submit'] }` 白名单（与 product-subagents 的 relay 管道一致），物理阻断 ACP 模式下使用其他工具；
  - 不传 `agentOptions`（ACP 服务自带模型配置）。
  - 未命中（普通 LLM provider，如 deepseek-official）时行为与 1.3.4 完全一致（spawn + agentOptions + deny 护栏）。
- 决策日志：ACP 模式 `provider` 记录 `route.provider`、`model` 记 null，便于区分执行通道。
- 用法：`"routes": [{ "provider": "deveco", "model": "default" }]`（model 字段保留仅作兼容，ACP 模式忽略）。
- 影响：需重启 DSH 生效；验证脚本 `verify.mjs` 同步更新。

## 1.3.4 (2026-08-31)

修复：DSH 0.1.2 客户端硬依赖声明缺失——web boot `Failed to load plugins`，桌面壳只剩恢复按钮。

- 根因：0.1.2 起客户端服务必须在 bundle 内声明 inject（`exports.inject`，服务名列表），package.json 的 `dsh.client.inject`（模块依赖）不能替代。dispatch 的 `lib/client.js` 用 `ctx.slots`（hardDependency）却从未声明 `exports.inject`，loader 抛 `cannot get property "slots" without inject`。
- 修复：`lib/client.js` 的 `module.exports` 加 `inject: ["slots", "locale"]`；`package.json` 的 `dsh.client.inject` 补 `@deepseek-ai/dsh-client-store` + `@deepseek-ai/dsh-client-locale`。
- 影响：仅 client 半（浏览器 UI）；升级 dsh 0.1.2+ 后必须用本版本，需重启 Desktop 生效。

## 1.3.3 (2026-08-30)

修复：DSH 0.1.2 兼容——client 半挂载失败（面板/返回按钮/悬浮球/Agent 菜单全消失，host 半工具正常）。

- 根因：0.1.2 将 `slots` 服务改为 hardDependency 形态后，`ctx.get("slots")` 在插件 fiber 的加载时序下返回 `undefined`，`apply()` 开头 `if (!slots) return` 静默退出整个 client 半。
- 修复：`lib/client.js` 改用官方标准访问 `ctx.slots`（与官方插件一致），其余 `ctx.get("sessions")`/`ctx.get("inputTriggers")` 为可选服务访问，契约兼容，保持不动。
- 影响：仅 client 半（浏览器 UI），host 半无改动；升级 dsh 0.1.2+ 后需重启 Desktop 生效。

## 1.3.2 (2026-08-29)

修复：FAB「最近完成」小队卡完成数回退——checkpoint 分段执行下同 squadRunId 产生多条 end 行，旧逻辑后到的（更旧段）覆盖最新段，导致 design 完成后仍显示 1/5。

- 根因：`agent_squad_continue` 每次续跑都写一条 `phase:'end'` 的 squad-run 行（stepStatus 是累计快照），FAB 聚合时 `runEndById.set` 无脑覆盖，最新在前遍历时先 set 最新、后被更旧段覆盖。
- 修复：`runEndById` 首次 set 才保留（`if (!has) set`），`lastRecent` 最新在前 → 首次即最新最全的 stepStatus。历史页不受影响（其完成数走 dispatch 活体结局，不依赖 end 快照）。
- 路由表第 6 条补停等动作：产出文档展示完整路径/链接、有待确认问题逐条列出请用户作答，回答前不得续跑。

## 1.3.1 (2026-08-29)

新增：小队 checkpoint 停等的免重启配置能力（GUI 开关 + 工具）。

- `lib/client.js`：小队编辑表单（SquadForm）每步新增「产出后停等用户确认（checkpoint）」勾选开关，初始态读入、save 透传 `checkpoint` 字段。
- `index.js`：新增 `agent_squad_upsert` 工具——主 agent 免重启改小队（含各步骤 checkpoint），与 GUI 小队编辑保存同一条 `squadRegistry.upsert` 路径（内存 + 原子写盘立即生效）。
- `lib/dispatch.js`：递归护栏 `toolFilter.deny` 追加 `agent_squad_upsert`（共 8 个委派工具），阻断子代理改小队注册表逃逸。
- systemPrompt 路由表新增第 9 条：改 Agent 用 `agent_upsert`、改小队用 `agent_squad_upsert`，均免重启。
- `verify.mjs`：工具白名单、deny 清单、GUI 开关与工具断言同步更新（8 工具）。

## 1.3.0 (2026-08-29)

新增：小队结果级停等（checkpoint）——agent_squad 支持在指定步骤产出后暂停，等用户确认再续跑。

- 背景：kiligz-workflow 这类开发流程要求「每阶段产出后停等用户确认」，而旧 agent_squad 是单次工具调用内跑完全部步骤，无法中途停下问用户。
- `lib/squad-registry.js`：squad 步骤新增 `checkpoint` 布尔字段（默认 false），validate/upsert/list 透传并校验。
- `index.js`：
  - 抽 `runSquadSteps` 共享执行核心，按拓扑分层执行；每层跑完若含 `checkpoint:true` 且成功完成的步骤 → 停下返回 `paused:true`，否则继续下一层。
  - `agent_squad` 输出增加 `squadRunId` / `paused` / `nextStepIdx`；停等时把中间态存入进程内 `squadSessions`。
  - 新增 `agent_squad_continue` 工具：凭 `squadRunId` 续跑，可选 `note`（用户对上一阶段的反馈，拼入 goal 供后续步骤可见）。
  - systemPrompt 路由表第 6 条补 checkpoint 停等引导：带 checkpoint 的小队必须停下等用户确认，禁止未确认自动续跑。
- `lib/dispatch.js`：递归护栏 `toolFilter.deny` 追加 `agent_squad_continue`（共 7 个委派工具），阻断子代理续跑小队递归。
- `verify.mjs`：工具白名单、deny 清单、checkpoint 透传与续跑断言同步更新。
- 中间态为进程内内存，Desktop 重启失效；跨重启断点恢复靠各阶段 Agent 写 `.kiligz-state.json` 兜底。

## 1.2.0 (2026-08-29)

新增：`agent_upsert` 工具——主 agent 可直接新增/更新单个 Agent，免重启生效。

- 根因：此前改 Agent（含 systemPrompt）只有两条路——GUI 编辑保存（浏览器同源 REST）或手改 `agents.json` 文件（需重启才读盘）。命令行直连 `/agent-api/upsert` 被宿主 webserver 403 拦截，主 agent 无法走 GUI 同款逻辑。
- 修复：把 GUI 编辑保存同款的 `registry.upsert()`（内存 + 原子写盘，立即生效）暴露成 `agent_upsert` 工具，主 agent 直接调用即可改 Agent 注册表，无需重启、无需点 GUI、无需绕 skill 导入。
- 递归护栏同步：`startContinuable` 的 `toolFilter.deny` 清单追加 `agent_upsert`，阻断子代理用该工具自我改 persona 逃逸（子代理看不到改注册表能力）。
- 版本断言：`verify.mjs` 工具白名单与 deny 清单断言同步更新。

## 1.1.2 (2026-08-29)

修复：递归护栏——dispatch 的 `startContinuable` 加 `toolFilter.deny` 物理阻断子代理再委派。

- 根因：`maxDepth` 只是委派深度记账，不是"禁止派下级"；子代理继承主会话工具面（含 `agent_dispatch`/`agent_squad`），遇到未闭环状态会自行续派新子代理，造成"关了又开、递归开子代理"。
- 修复：每个被派出的 agent 子代理 `toolFilter.deny` 全部 5 个委派工具（`agent_dispatch`/`agent_followup`/`agent_list`/`agent_squad`/`agent_import_skill`），从工具注册表层物理斩断递归，非 prompt 软约束。
- 小队不受影响：squad 由主 agent 调 `agent_squad` → host 解析模板逐 step dispatch，step agent 只需业务工具。

## 1.1.1 (2026-08-28)

工程维护（无功能变更）：

- 新增 `.gitignore`（node_modules、日志、OS 文件、本地数据目录）。
- 新增 GitHub Actions CI：`node verify.mjs` 一致性断言 + 冒烟，push 与 PR 触发。
- 修复 `verify.mjs` 冒烟桩缺 `ctx.on`，消除 `subagent/end 订阅失败` 误报。
- `package.json` 补 `author` / `repository` / `homepage` / `bugs` 元数据。

## 1.1.0 (2026-08-28)

破坏性重构：`expert` 全面改名 `agent`，删除全部内置 Agent 与小队。

**核心变更**
- 工具改名：`expert_dispatch` / `expert_followup` / `expert_list` /
  `expert_squad` / `expert_import_skill` → `agent_dispatch` / `agent_followup` /
  `agent_list` / `agent_squad` / `agent_import_skill`。
- 数据文件与字段：`experts.json` → `agents.json`；`expertId` / `expertName` /
  `expert` / `experts` → `agentId` / `agentName` / `agent` / `agents`。
- 类名：`ExpertRegistry` → `AgentRegistry`、`skillToExpert` → `skillToAgent`、
  `ExpertForm` → `AgentForm`；文件 `lib/experts.js` → `lib/agents.js`。
- REST 面：`/expert-api/*` → `/agent-api/*`。
- **删除 4 个内置 Agent**（requirement-analyst / code-reviewer / log-tracer / sql-analyst）
  与 **3 个内置小队**（dev-pipeline / debug-squad / review-squad）；`DEFAULT_AGENTS`、
  `DEFAULT_SQUADS` 置空数组，全新安装从空列表开始。
- 删除 `deletedIds` 防复活机制（无内置可删，不再需要）。
- README 双语重写：悬浮球截图上移、换用户提供的 7 张真实 UI 图、扩充用法章节。

**破坏性**
- `expert_*` 工具名失效：既有会话/脚本里写 `expert_dispatch` 的需改为 `agent_dispatch`。
- 已落盘的 `experts.json` 不再读取（改名 `agents.json`），历史委派记录清空重来。

## 1.0.0 (2026-08-28)

首个对外正式版。经历 40 个内部迭代后定型：双面插件（host + browser），
5 个模型工具（expert_dispatch / expert_followup / expert_list /
expert_squad / expert_import_skill），主面板 4 个子 tab（总览/Agent/
小队/历史），会话头部返回按钮，悬浮活动球（含 8 种色调/8 段边缘流光/
透明度/总开关），`/` 触发器 Agent + 小队候选菜单。

**核心能力**
- 4 个内置专家：requirement-analyst（需求分析师）/ code-reviewer（代码审查员）/
  log-tracer（线上排查员）/ sql-analyst（SQL 分析师）；用户可自定义/启用/禁用。
- 3 个内置小队模板：dev-pipeline（需求→审查串行）/ debug-squad（日志+数据+代码三路并行）/
  review-squad（业务+数据双路并行）；用户可扩展。
- 模型路由互备：每个专家的 routes 列表按优先级试 provider/model，首选失败自动换下。
- 完整生命周期：subagent/end 事件订阅 → 真实结局 → dispatches.jsonl 审计日志
  → 历史页四态展示（运行中/完成/失败/孤儿）。
- 就地调用：点 Agent/小队卡片走 `conversation.input.shell.setDraft("$id ")`，
  一键填入输入框；老宿主 DOM 兜底。
- skill 一键导入：`~/.dsh/skills/<name>/SKILL.md` → 专家 systemPrompt。

**清理（v0.9.40 → v1.0.0）**
- 删 `lib/client.js.bak-20260827-190331`（开发残留备份，200KB）
- 删 `docs/PLAN.md`（已过期的开发计划，非用户文档）
- 删 `index.js` 内重复的 `topoLayersOf`（与 `lib/squads.js` 的 `topoLayers` 同源）
- 删 `expert_squad` 工具参数的 `args.squadId ?? args.id` 死 alias
  （schema 只声明 `squad_id`）
- 更正 `index.js` / `cordis.patch.yml` / `lib/client.js` 顶部注释（v0.2 Settings
  UI 描述、/expert slash 命令等已过时的内容）
- 重写 README.md（中文优先 + Mermaid 状态图 + 真实 UI 截图）
- 同步更新 README.en.md 英文版

**发布渠道**：GitHub + 1024Store + dshmarket + awesome-DSH-plugin +
dsh-plugin-store + dsh.deepseek404.com（npm 不发）。

## 0.9.40 (2026-08-27)

修两件：小队并发卡死 + 任务卡片计数缺。

- **根因（同一处）**：`activeChildren` 用 **expertId 做 Map key**。dev-pipeline 的 S2/S6 同为 code-reviewer 并发派发 → 后者覆盖前者的 entry → 前者子代理结束时 `onChildEnd` 找不到匹配 → `waiter` 永不兑现 → `expert_squad` 的 `Promise.all` 永挂（主代理卡死、后续层不派发、面板只出部分卡）。
- **改法**：`activeChildren` 改 **childId 主 key**（entry 带 expertId），多子代理并存；新增 `byExpert` 二级索引（expertId → childId）供直接委派复用续聊；`onChildEnd` childId 直查；`/expert-api/active`、`/cancel`、总览端点同步适配；客户端中止按钮改按 childId 精确取消（同专家多卡并发）。
- **`dedicatedChild` 参数**：小队步骤显式传 `dedicatedChild: true`，跳过同专家复用续聊，强制新建专属子代理——否则续聊会把第二层任务强塞给正在跑第一层的 child，且并发等待器互相踩。
- host+client 改动：host 需重启 Desktop；client 刷新生效。

## 0.9.39 (2026-08-27)

修：0.9.38 启动崩——`unsupported JSON schema: schema.properties.output.type must be a single type string (type arrays are not supported)`。

- **根因**：宿主 `dsh-tools` 的 `assertSupportedJsonSchema` **不支持 type 数组**（`type:['string','null']` 直接抛 `JsonSchemaError`），0.9.38 给 OUTPUT_SCHEMA 加 `output` 可空字段用了 type 数组 → 插件加载即崩。
- **修**：可空字段改 `oneOf` 表达——`output: { oneOf: [{type:'string'}, {type:'null'}] }`。宿主校验 `oneOf` 分支各自单类型合法（`null` 是合法单类型）。
- 教训：DSH 工具 schema **禁 type 数组**，可空一律 `oneOf`。
- host 端改动，需重启 Desktop 生效（用户决定）。

## 0.9.38 (2026-08-27)

修两件（用户：①直接调 Agent 报 'value.output' is not a declared property ②小队卡死）。

- **OUTPUT_SCHEMA 补 `output`/`ok` 字段**：v0.9.36 dispatch 返回值新增 output/ok，但 schema 未同步声明，`additionalProperties:false` 把未声明字段判非法 → `expert_dispatch` 工具调用报错。已声明 `output: {type:['string','null']}`、`ok: {type:'boolean'}`。
- **`lastAssistantMessage` 归一化（`#normOutput`）**：宿主该字段形态不稳定（字符串 / 消息块数组 `[{type:'text',text:'..'}]` / null）。数组原样透传 → `expert_squad.execute` 里 `.trim()` 抛 TypeError → 步骤卡死。新增 `#normOutput` 提取文本；execute 侧 `String()` 兜底。
- **`waitResult` 默认改 `false`**：直接调 Agent（`expert_dispatch`）立即返回、主代理不阻塞；仅 `expert_squad` 小队步骤显式传 `waitResult:true` 等结果（结果级串行）。用户：「直接调 Agent 不要有这个校验，小队自动调用的才要有」。
- host 端改动，需重启 Desktop 生效（用户决定）。

## 0.9.37 (2026-08-27)

改：悬浮球完成彩色呼吸光常驻 + 点击回退（用户：完成光效太短；点击后按活跃状态回退）。

- **`done-glow` CSS 改无限循环**（`ad-fab-glow-done 1.6s ease-in-out infinite`）——完成光不再 3 周期/5s 消散，常驻呼吸。
- **新增 `clearDoneGlow()`**：点击悬浮球（`togglePop` 入口）清 `done-glow` + `doneCount`。有活跃任务时 `fab-live` 白光呼吸保持（poll 已挂），无活跃任务回初始态（无动画）。
- **poll 状态校正**：每 5s 按活跃状态维护光效——`arr.length>0` 去 `done-glow`（彩色让位白光）；`doneCount>0` 且无活跃时补回 `done-glow`（新完成重新亮起）。
- 纯 client 改动，刷新生效。

## 0.9.36 (2026-08-27)

改：小队步骤依赖从「派发级」升级为「结果级」串行（用户：小队依赖没生效，6 步 64ms 内全派出）。

- **根因**：`expert_squad` 层间 `await` 只等 `dispatch` 调用返回（`startContinuable` 立即返回 childId），不等子代理跑完；`stepResults` 填「已委派」占位 → `{prev:N}` 拿不到前置真实结论，且任务管理面板瞬间全出 6 卡。
- **`dispatch()` 新增 `waitResult`（默认 `true`）+ `waitTimeoutMs`（默认 1 小时）**：dispatch 后挂起 Promise，由 `subagent/end` 事件（`lastAssistantMessage`）兑现；返回 `{ ..., output, ok }`。置 `false` 恢复旧行为（立即返回）。
- **`onChildEnd` 兑现等待者**：completed → resolve 结果文本；非 completed → resolve 失败占位。`result` 日志行顺带记 `output`（截断 4000）。
- **`expert_squad.execute`**：`stepResults[idx]` 填真实步骤结论（`（步骤 N 结论）\n{output}`），`{prev:N}` 替换真实前置输出；依赖链真正串行，同层并行保持。
- **注意**：`expert_dispatch` 单 agent 委派同样默认等结果（调用方工具调用会阻塞至子代理结束）。
- host 端改动，需重启 Desktop 生效（用户决定）。

改（UI，纯客户端刷新生效）：设置页整体删除，信息迁入总览 + 悬浮球总开关（用户：设置里红框说明不要，其余内容移到 Agent 调度总览，加一个是否展示悬浮球开关）。

- **设置页删除**：`settings.section` 槽注册 + `SettingsTab` 组件移除——设置侧边栏不再出现「Agent 调度」入口（红框说明文字一并删除）。
- **信息迁入总览**：默认跟随模型 / 数据目录 / 触发方式三行迁入主面板「总览」子页顶部设置卡片（`ad-set-card`），复用统计卡视觉语言。
- **「显示悬浮球」总开关**：总览页设置卡片首行；关=悬浮球强制隐藏（含运行/完成提醒，优先级高于 always/auto/never 显示模式），开=恢复显示模式逻辑；`localStorage`（`ad-fab-visible`）持久化，切 tab 保持。
- 悬浮球设置浮层（色调/呼吸/透明度/最近完成时长）保留，仍由悬浮球弹窗 ⚙ 打开。

改（v0.9.37）：`/expert` slash 命令删除 + 触发方式文案更新（用户：/expert 不好用，删了）。

- **删除 `/expert` 命令**：`ctx.commands.register({ name: 'expert' })` 整块移除，`inject` 去掉 `'commands'`，cleanup 去掉 `disposeCommand?.()`。触发方式只剩：对话自动路由 / 输入 `/` 菜单选 Agent（插入 `$id`）/ 悬浮球选定 Agent 自动插入当前会话（`dispatchTokenToComposer` 既有实现）。
- **触发方式文案**更新：总览页「触发方式」改为「对话自动路由；输入 / 唤起菜单选 Agent（插入 $id）或手打 $Agent名 直接指定；悬浮球选定 Agent 自动插入当前会话」。
- host 端改动（删命令），需重启 Desktop 生效（用户决定）。

## 0.9.35 (2026-08-27)

改：小队步骤子代理的会话标题（label）加步骤位标（用户：「任务管理面板能不能把步骤数也加上」——截图里 6 张「需求分析师/代码审查员 · 链路测试任务」卡分不清第几步）。

- `dispatch()` 新增 `totalSteps` 参数；小队（viaSquad）发起且 stepIndex+totalSteps 齐备时，`childLabel` 拼 `[S{n}/{total}]`：`需求分析师 [S1/6] · 任务摘要`。
- `expert_squad` 调用 dispatch 时传 `totalSteps: squad.steps.length`。
- 普通单 agent 委派（非小队）label 不变。
- host 端改动（label 在 startContinuable 时生成），需重启 Desktop 生效（用户决定）。

## 0.9.34 (2026-08-27)

修两件 + 递归护栏（用户：①测试 dev-pipeline 出现递归爆炸 ②「最近完成」计数不对，小队维度应为 1 ③小队 6 步只显示 2 步完成）。

- **递归护栏（host）**：`expert_squad` 每个 step 委派的任务文本追加【执行终点声明】——明确专家子代理为本轮执行终点，严禁再调用 `expert_dispatch / expert_squad / expert_followup` 继续派发。根因：测试 goal 被 step 子代理当成真实任务又组新小队，6→36→…指数递归（实测树深 4-5、残留 120+ 子代理）。host 端改动需重启 Desktop 生效（用户决定）。
- **「最近完成」计数 = 任务单位**：此前按 dispatch 行数计（一个小队 6 步算 6 条），现按聚合组数计（一次小队运行 = 1 个单位，普通 agent 委派各算 1）。`squad-run(end)` 行已计入 TTL 过滤（此前漏掉 → 整次运行完成也只在有 dispatch 行时才出现）。
- **小队卡步数 = run 全量**：步骤数/完成数改取 `squad-run(end)` 的 `stepStatus` 长度与 done/skipped 计数（此前只数 dispatch 行，等待/未回报的步骤不计 → 6 步显 2）。无 run 终态的旧记录退化为 dispatch 行数。纯客户端改动，刷新生效。

## 0.9.33 (2026-08-27)

删：悬浮球绿点角标（用户：「悬浮球的活动中和执行完成的绿点都删了吧，现在有光效提醒」）。

- **活跃绿点**（`.ad-fab-dot` / `liveDot`，右上角 11px 圆点）删除——运行中状态已由 `fab-live` 白光呼吸（2.6s 加速）指示。
- **完成 ✓N 角标**（`.ad-fab-done` / `doneBadge`）删除——完成提醒保留 `done-glow` 彩色光呼吸（绿→蓝→琥珀 3 周期≈4.8s），5s 后消散。
- 显隐逻辑不变：`doneCount` 仍驱动 auto 模式下完成后 5s 内保持显示。纯客户端改动，刷新即生效。

## 0.9.32 (2026-08-27)

修 + 改三件（用户：①悬浮球面板报「加载遇到问题」②活动中/最近委派去掉卡片按钮，点击直达主会话 ③直接调用的小队整体展示，不展开成员）。

- **① 悬浮球面板「加载遇到问题」**：面板 body 构建段 try/catch 降级文案。根因是 `openAgentSession` 收到**对象形态 childId**（宿主 `startContinuable` 返回形态因版本而异）时 `sessions.open` 抛类型错误，renderPop 构建循环整段被 catch 兜住降级。修：新增 `normalizeChildId`（字符串原样 / 对象取 `.id ?? .childId ?? .runId` / null），`openAgentSession` 入口统一归一化，跳转失败仍静默不压栈；host `/expert-api/active`、`/overview` 出口同步归一。host 端改动需重启 Desktop 生效。
- **② 卡片去按钮，点击直达主会话**：最近完成/运行中卡片悬停的 ⇱/⇲ 快捷按钮删除（含样式 `.ad-fab-jumps`/`.ad-fab-jump`/`.ad-fab-card-sub`）；单 agent 卡点击 = 跳主会话（`parentSessionId` 优先，无则子会话）。底部「打开 Agent 调度面板」按钮保留。
- **③ 小队整体展示**：最近完成分区的 `viaSquad` 行聚合成一张小队卡（小队头像 + 名称 · 小队 + N 步完成），不再展开成员子卡；运行中分区新增小队聚合——小队发起的活跃行显示小队卡（host 侧 `activeChildren` 补存 `viaSquad/squadRunId`，`/expert-api/active` 回填 `squadName/squadEmoji`），点击直达主会话。纯客户端 ②③ 刷新生效；①和运行中聚合是 host 端改动，需重启 Desktop 生效（用户决定）。

## 0.9.31 (2026-08-27)

改：编辑/新建小队弹窗固定大小，内容超高在弹窗内滚动（用户：「这个编辑小队弹窗固定大小，往下滑动吧」——弹窗被 6+ 步骤卡撑出视口、底部保存/取消按钮被裁）。

- **根因**：v0.9.25 毛玻璃给 `.ad-panel` 加 `backdrop-filter`，使内部 `position:fixed` 遮罩退化为相对面板定位；弹窗原 `max-height:88vh` 一旦高于面板区就溢出窗口底边，内容把底部按钮顶出可视区。
- **修法**：`.ad-modal.form` 从 `max-height` 改固定 `height:min(760px,100%)`——弹窗不再被内容撑大，超长内容在 `ad-modal-body` 内滚动；遮罩补 `grid-template-rows:1fr` 明确网格轨道，保证弹窗百分比高度可解析。
- **验证**：无头实测三方案对比——`100%` 网格区版本严丝合缝（溢出 -23px）且内部可滚；`86vh` 版本溢出 8px；旧 `88vh` 按面板顶齐（面板矮窗口时正常，面板高时溢出）。
- **波及**：`.ad-modal.form` 同时覆盖「编辑 Agent」弹窗（同结构同受益）。刷新生效。

## 0.9.30 (2026-08-27)

修三项（用户：①执行流节点文字超出框 ②agent历史跳转没到对话页面 ③删除委派历史报「缺少有效 ts」）。

- **① 节点标签截断**：SVG `<text>` 不会自动截断，节点可用宽仅 ~60px（108×0.9 − 序号区 30 − 留白 8），长阶段名必溢出。新增 `fitFlowLabel`：canvas `measureText` 按实际字号（小图 10.5px / 大图 12px，与 CSS 一致）像素测量，超宽逐字截断加「…」；原文挂 SVG `<title>`，鼠标悬浮可见全名。卡片小图/历史预览/弹窗大图三处共用 `SquadFlowGraph`，一并生效。
- **② 跳转后强制回对话页**：两处历史跳转调的本来就是同一个 `openAgentSession`，行为差异来自**目标会话持久化的视图**（`localStorage dsh.conversation.chat.<sessionId>`）——上次停在「Agent 调度」页的会话跳过去就停在那里。新增 `ensureChatView`：`sessions.open` 后短轮询（≤0.6s）会话头部视图标签栏，首标签「对话/Chat」（chat 视图 order:0 恒第一）未选中则点击（走官方 `setView`，内存+持久化同更新）；只有一个视图（必为对话页）则无操作。统一作用于所有跳转入口，语义一致：跳到会话看对话。
- **③ 删除报「缺少有效 ts」**：JSONL 写入用 `new Date().toISOString()`（ISO 字符串），删除端却 `Number(body.ts)` → NaN → 一律 400。修：校验兼容字符串/数字，匹配统一 `String(row.ts) === tsKey` 字符串比对。
- 纯客户端①②刷新生效；③是 host 端改动，**需重启 Desktop 生效**（用户决定）。悬浮球代码零改动。

## 0.9.29 (2026-08-27)

修：从历史页点跳转再返回，面板回到「总览」而不是停在历史页（用户反馈）。

- **根因**：`conversation.view` 槽位组件按会话挂载——切到跳转会话时旧会话的面板被卸载，切回时重新挂载，`React.useState` 初始值把 `tab` 重置回默认的「总览」。
- **修法（面板状态跨会话持久化）**：`tab`（总览/Agent/小队/历史）、历史分段（agent 历史/小队历史）、展开行键三项提升到模块级 `uiState`，组件重挂载时惰性读取最新值立即恢复；配 `uiSubs` 订阅 + `uiNotify` 广播，双实例并存时同步。纯客户端改动，刷新即生效；悬浮球代码零改动。

## 0.9.28 (2026-08-27)

改：「← 返回」按钮从 Agent 调度面板内挪到会话头部槽（用户：「需要点到 Agent 调度页再点返回很怪」）。

- **新位置**：挂 `conversation.session.header.actions` 官方槽——会话标题旁的操作行，**任何 tab 视图（对话/轨迹/Agent 调度）下都可见**，跳转后一跳即回，不必先切面板。
- **实现**：`HeaderBackButton` 组件订阅导航栈变化，栈空时返回 null 不占位；样式 `.ad-header-back` 自包含（渲染在 `.ad-panel` 之外，用语义化 token，不引用面板内 `--ad-*` 变量）。
- **删除**：面板标题行内的返回按钮（`ad-btn mini ad-back-btn`）——避免重复，面板头回归干净。
- 导航栈逻辑不变（跳转前抓 `aria-selected` 侧边栏标题压栈，返回按标题直点，点不到 `sessions.search` 兜底，上限 20 层）。刷新生效。

## 0.9.27 (2026-08-27)

修：悬浮球面板展开后塌成只剩头部一条（用户：「面板展开后成这样了」）+ 新增返回按钮。

- **塌缩根因（结构性）**：`renderPop`/`openFabSettings` 先 `pop.textContent=""` 清空，再逐段构建 head/body/foot 边建边挂——中途任何异常（数据字段类型异常等真机时序问题）都留下「只有头部」的半残面板，且 5s 轮询每次重试都重新清空重新炸 → 永久损坏。现场几何证据：面板顶在原位、玻璃层只剩头高（~62px）、悬浮球孤悬在面板下方远处。
- **修法（原子渲染）**：head/body/foot 全部先建进 `DocumentFragment`（脱机，抛错不伤现有内容）；body 构建段包 try，异常降级空态文案；构建全部完成后才清空旧内容一次性挂入——面板任何时刻都不半残。主视图与设置视图同款加固。无头回归：展开/分区切换/运行→完成过渡/设置视图/返回主视图全链路零错误。
- **返回按钮（方案A，本系列早前待办一并发布）**：主面板标题行在导航栈非空时出现「← 返回」——跳转会话前压栈当前会话标题（侧边栏 `role=treeitem` 抓标题），点返回按标题直点侧边栏行，点不到走 `sessions.search` 兜底。栈上限 20 层。

## 0.9.26 (2026-08-26)

修：小队历史步骤大量「未知」误判（用户：「怎么还这么多未知状态的」）。

- **根因**：步骤状态旧逻辑只认 dispatch 行的活体结局（result 配对）；result 配对丢失（重启 Desktop 等）即判「未知」，而 end 行明明记录了全部步骤 done 也不采信。
- **修法（权威级联）**：① dispatch 行有活体结局（ended）→ 直接信；② 运行已终止（end 行到）→ 信 end 快照（done/failed/skipped）；③ 运行未终止 → 活体推断（运行中/孤儿→未知）。纯客户端，刷新生效。

## 0.9.25 (2026-08-26)

修：面板毛玻璃「没生效」（用户：「2和3都没生效，不要改动悬浮球相关的代码哈」）：

- **③ 毛玻璃真根因**：面板挂在右侧 tab 页，背后是宿主**实色面板壁**——纯 `backdrop-filter` 在实色上模糊不出任何质感。0.9.21 的「半透明底+blur」在悬浮球（floating 于内容之上）有效，在右侧 tab 页结构性失效。改「玻璃拟态」：语义 layer 渐变底（layer-1 82%→base 92%，禁 white 混色保证亮暗稳）+ 保留模糊 + 1px 玻璃边框（border-l2 65%）+ 顶部内高光（inset layer-2）+ lv3 软阴影 + 14px 圆角。悬浮球相关代码零改动。
- **② 小队执行流「没生效」**：非代码问题——日志里 0 条 `squad-run` 快照行（0.9.18 宿主记录功能需重启后生效，重启后尚未跑过新小队）。补小队历史空态说明：「若重启 Desktop 后仍为空，请先跑一次小队」。
- 纯客户端改动，刷新生效。

## 0.9.24 (2026-08-26)

- **修：单选白球偏心（真根因）**——不是 CSS 写法问题：9px 白球在 14px 灰圆里需要 2.5px 边距，**半像素无法对称**，浏览器取整后左/上 3px、右/下 2px（sharp 像素级实测：白球 bbox 宽 9 高 9、灰圆宽 14 高 14，白球左上多 1px）。改白球 **10px** → 边距恰好整数 2px 四向严格对称；灰圆 14px 不变，`margin:auto` 定心保留。
- **修：滚动条出现瞬间卡片变窄**——内容高度临界溢出时滚动条一出现，卡片内容区被经典滚动条挤掉约 15px。给 `.ad-fab-pop-body` 加 `scrollbar-gutter:stable` 恒留槽位，卡片宽度不再随滚动条出现/消失跳变。

## 0.9.23 (2026-08-26)

五连修（用户反馈截图驱动）：

- **修：面板莫名跳回顶部**——`renderPop` 每次 5s 轮询/异步回调都整体重建面板，新建的 `.ad-fab-pop-body` scrollTop 归零。重绘前抓旧滚动位置、渲染后还回（内容变短时浏览器自动钳制）。
- **面板卡片同底化**——`.ad-fab-card` 弃实底（`bg-layer-1`），与面板同底只靠边框区分（符合既定偏好「同底靠边框，禁 hover 变色」）；显式 `box-sizing:border-box` 防宿主全局 box-sizing 差异造成 1px 错位。
- **修：悬浮球不在面板横向正中**——`placePop` 宽度写死 236px（历史面板宽），现面板 360px → 居中与边缘钳制全错位。改取实测 `pop.offsetWidth`，并让下方弹出也防出 app 边界（`innerHeight - h - 8` 钳制），贴边自适应。
- **最近完成默认展开**——打开面板时与「运行中」一致展开（`secOpen.recent` 默认 true，含 `closePop` 归位处）；Agent/小队列表保持折叠（注册表性质，量大）。
- **修：单选白球偏离中心**——`::after` 弃 `inset:2.5px`（宿主全局 `box-sizing` 干扰下基准不稳），改显式 `box-sizing:content-box` + `inset:0;margin:auto;width:9px;height:9px` 四向定心；灰圆 14px、白球 9px 尺寸均不变。

## 0.9.22 (2026-08-26)

- **修：悬浮球面板展开重叠**——根因是 `.ad-fab-pop-body`（flex 列 + `max-height:300px`）的子项默认 `flex-shrink:1`，内容超高时子项先被压扁再溢出，卡片互相叠压。给 body 直接子项加兜底 `.ad-fab-pop-body>*{flex:none}`，并对 `.ad-fab-box` / `.ad-fab-card` / `.ad-fab-agents` / `.ad-fab-sec` / `.ad-fab-set-row` / `.ad-fab-modes` / `.ad-fab-mode` / `.ad-fab-tone-row` 逐一禁压缩，超高改走 body 滚动。
  - 验证：无头 Chrome 确定性测量新旧两版——旧版实测卡片重叠 34px/10px/120px（`bodyH=320 scrollH=320`，内容被压扁）；新版 `scrollH=624` 零重叠，内容滚动。
- **单选白球再加大**：灰圆保持 14px 不变（用户：「灰圆别变大」），白球 `::after` inset 4px→2.5px（6px→9px）。
- **去括号副标题**：设置页「面板透明度」「悬浮球透明度」副标题删除（模糊保留）（色调同步淡化）；运行中空态「（已全部结束）」改为「已全部结束」。
- 设置行副标题（`.ad-fab-set-row .t2`）补单行省略号，防说明文字与右侧数值叠印。

## 0.9.21 (2026-08-26)

历史页重设计 + 整面板毛玻璃化（用户：「历史页面重新设计一下，列表连个标题行都没有」「小队历史直接把小队页面的执行流拿过来用……只读，增加一个执行状态」「整体Agent调度页能不能像悬浮球活动面板那样，都做成毛玻璃样子」）：

- **历史列表标题行**：Agent / 小队 两列表分段下方各加一行灰字列头（时间｜头像｜名称｜消息｜状态｜操作，`ad-hist-colhead`，与行内列宽对齐）。
- **执行流图例**：小队历史展开区顶部加状态图例（完成/当前执行/失败/等待·跳过 四色样本，`ad-legend`）——执行流图本身 0.9.18 已复用小队页组件（只读+节点状态着色），本轮补图例说明。
- **整面板毛玻璃化**：面板根背景改半透明（bg-base 78%）+ blur(18px) saturate(1.4)，与悬浮球面板同配方；内层卡片/展开区/任务框改半透明叠层（layer-1 62%），亮暗主题自适应（全部 color-mix 语义 token，无写死色值）。
- 纯客户端改动，刷新页面生效。

## 0.9.20.1 (2026-08-26)

- **修：点选跳回顶部**——展示时长/色调单选点击后不再 `openFabSettings()` 整体重绘（重绘重建滚动容器，滚动位置归零）；改就地翻转 `.on` 类（`dataset` 标记当前项），滚动位置保持。
- ~~单选白球加大~~（尝试后用户否决：灰圆别变大、白球维持原样 14px 灰圆 + inset 4px，已还原）。

## 0.9.20 (2026-08-26)

面板去蓝 + 单选框 = 开关视觉（用户截图反馈：「按钮颜色同底边缘区分」「单选框灰底白球」「悬浮变蓝也不要」）：

- **底部栏同底化**：`.ad-fab-pop-foot` 背景 `--dsw-alias-bg-layer-1` → transparent（与面板同底）；主按钮弃 `--dsw-alias-state-business-primary` 蓝填充 → 透明底 + 边框 + 主文字色，hover 只加浅底与边框加深（活动页/设置页同款）。
- **悬浮不再变蓝**：⚙/✕ 头部按钮与 `.ad-fab-jump` 跳转小按钮的 hover 由蓝色文字 → `--dsw-alias-label-primary`；色调选中态蓝边 → `--dsw-alias-border-l3` 加深边。
- **单选框 = 开关视觉（用户定稿）**：未选=纯灰圆（`--dsw-static-neutral-bluish-600`），选中=灰圆中心白球（`::after` 13px 白点），全程无蓝色；行选中仅边框加深。与开关/滑杆同一视觉族，亮暗主题通用。
- **需刷新页面生效**（纯 client 改动）。

## 0.9.19 (2026-08-26)

面板细节三连（用户：「运行中的空白面板再大一些」「设置页卡片跟面板同底色」「滑动百分比球做成 switch 一样白球灰底」）：

- **空态占位加高**：`.ad-fab-empty` padding 10px→22px（运行中「（已全部结束）」等空态不再贴成一行）。
- **设置页卡片与面板同底**：`.ad-fab-set-row` 背景 `--dsw-alias-bg-layer-1` → transparent，只留边框区分层次（与 0.9.17.1 分区卡 `.ad-fab-box` 对齐）。
- **滑杆球 = 开关视觉**：透明度滑杆弃 `accent-color` 原生外观，自定义 `-webkit-slider-*`/`-moz-range-*` 双伪元素——4px 灰轨（`--dsw-static-neutral-bluish-600`）+ 13px 白球（`--dsw-static-neutral-bluish-00`）+ 1px 边框，与 `.ad-switch` 同色系，亮暗主题通用。开关/滑杆统一规范已记入记忆（用户定稿「以后 UI 开关和滑动球都按这个来」）。
- **需刷新页面生效**（纯 client 改动）。

## 0.9.18 (2026-08-26)

历史页拆分：Agent 历史 / 小队历史，小队运行带执行流进度图（用户：「历史tab页把Agent和小队分开……小队列表要多一层级……能标识小队的执行进度，到哪个agent了」+「看是这样的进度还是直接一个执行流程图，到哪个节点一清二楚」「agent历史、小队历史ui还是尽量一致吧」）：

- **分段切换**：历史页顶部 `Agent 历史 / 小队历史` 分段（`.ad-seg`）。
- **两列表行头结构统一**：时间｜头像｜名称｜摘要｜状态｜操作，同走 `histHead`。
- **小队历史两层级**：一行 = 一次小队运行（步骤进度徽标 done/total + 整体状态）；点开 = **执行流程图**（复用 `SquadFlowGraph`，新增 `statuses` prop，节点按状态着色：完成绿/当前亮/失败红/跳过虚线降透明）+ 步骤明细行（状态词 + 跳转子 Agent）+ 目标详情框；点节点亦可跳该步会话。
- **数据侧（宿主，需重启生效）**：每次小队执行写两行 `squad-run` 日志——`start`（拓扑快照：步骤+依赖+名称+目标）与 `end`（各步状态数组）；步骤派发带 `squadRunId`+`stepIndex`；`mergeDispatchHistory` 透传运行日志行；新增 `/expert-api/history/remove-run` 整次运行删除端点。旧记录无拓扑快照 → 按小队+10 分钟时间窗兜底分组，仅列步骤明细（无图）。
- **删除语义**：小队历史行删除 = 整次运行（两行运行日志 + 全部步骤派发 + 对应结局），带二次确认。

## 0.9.17 (2026-08-26)

悬浮球活动面板卡片化 + 球态效重做（用户：「面板ui再优化一下，改成卡片折叠」「运行中白光呼吸，完成彩色光呼吸，几秒后消失」）：

- **四分区卡片化**：运行中 / 最近完成 / Agent 列表 / 小队列表 各成独立圆角卡片（`.ad-fab-box`：边框+圆角+浅底），标题行 = 名称 + 计数 + 右对齐箭头，点标题行整卡折叠；展开状态仍走面板级 `secOpen`（新增 `run`，关面板归位，重绘不回弹）。
- **运行中空闲不占空白**：活跃为 0 时「运行中」卡整体不渲染（头部 chip 已显示「空闲」），不再有截图反馈的大片空区块；加载中态保留。
- **完成提醒重做**：删 0.8.10 彩虹庆祝 `celebrate`（放大上跳+橙蓝多色）与 `flash-done` 扩散环；改 `done-glow` 彩色光呼吸（绿→蓝→琥珀柔光循环 1.6s×3 ≈ 4.8s，无放大无跳动），✓N 角标 5s 后随光晕消散。
- **运行中白光呼吸**：有活跃任务时球体 `fab-live`（白光呼吸 2.6s 加速），结束后回落常态节奏；不受「呼吸光晕」常态开关约束。
- **需刷新页面生效**（纯 client 改动）。

## 0.9.17.1 (2026-08-26)

- **修：面板中「运行中」卡片消失**——空闲时整卡不渲染改为始终渲染（空闲显示「（已全部结束）」空态占位，卡片与标题行常驻）。
- **运行中默认展开**（`secOpen.run = true`，关面板归位时保持展开）。
- **分区卡片与面板同底色**：`.ad-fab-box` 背景改 transparent（不再叠浅底），只靠边框区分层次（用户反馈卡片底色与面板不协调）。

## 0.9.16 (2026-08-26)

悬浮球活动面板五连改（用户截图反馈，载体=自研悬浮球面板，非 better-sidebar 任务管理）：

- **「最近委派」→「最近完成」（方案D）**：只展示限时内已完成任务——`loadRecent` 按设置项 `recentTtlMin`（默认 30 分钟，设置面板可选 10/30/60）+ `ok && ended && !orphan` 过滤；过期自动消失，不再常驻占地。分区**默认折叠**成一行计数，点击标题展开。
- **最近完成按小队维度聚合**：连续同 `viaSquad`+`parentSessionId` 的行聚成一张小队卡（小队名 + N 步完成 + 状态），点开才列成员子行（缩进+指引线，保留跳子会话/主会话按钮）；非小队委派保持单行。host `mergeDispatchHistory` 出口同步回填 `squadName`/`squadEmoji`（注册表改名同步）。
- **修：Agent 列表/小队列表展开后自动收起**：`agOpen`/`sqOpen` 原是 `renderPop` 局部变量，5s 轮询/异步回调触发整面板重建即被重置。展开状态提升为面板级闭包变量 `secOpen`（recent/agents/squads），点击写回后整体重绘；`closePop` 归位（下次打开全折叠）。
- **子代理会话标题带专家名前缀（问题5）**：`startContinuable` 的 label 与 `request.label` 改为 `「专家名 · 任务摘要」`——better-sidebar「任务管理」/ 会话列表只能看宿主 label，此前完全看不出哪个 agent 在执行。日志 `taskLabel` 保持纯任务摘要不变（FAB 面板另有名称列）。
- **问题1（头像不显示配置的）零代码**：v0.9.15 的 `mergeDispatchHistory` 回填已在代码里，但当前进程启动早于该版本更新，重启 Desktop 即生效；`code-reviewer`/`log-tracer` 注册表 emoji 为空，按既有规则落首字方块。
- **需重启 Desktop 生效**（host + client 均有改动）。

## 0.9.15 (2026-08-26)

悬浮球活动面板头像与「Agent 调度」页完全对齐（用户：「默认头像也用和 agent 调度里的名称首字作为头像，有表情优先表情头像」）：

- **客户端无代码改动**：悬浮球四处头像（运行中/最近委派/Agent 列表/小队列表）早已走 `setAvatarEl`——emoji 优先、无则名称首字 monogram、空名才落白 logo 兜底，规则本就一致。
- **根因在 host 数据**：「最近委派」/总览/历史数据来自 `dispatches.jsonl`，dispatch 行不写 `emoji`、`expertName` 是委派时快照——设了表情或改过名的 Agent 在面板里丢 emoji 落旧名首字。
- **修复**：`mergeDispatchHistory` 出口按 `expertId` 回填注册表实时的 `emoji`/`expertName`（与 Agent 调度页同源），注册表查不到才回退行内字段。`/dispatches`、`/active`(recent)、`/overview` 三个消费端点全部受益。
- **需重启 Desktop 生效**（host 侧改动）。

## 0.9.14 (2026-08-26)

历史列表列化与头像回退首字：

- **头像改回首字**：用户推翻 0.9.13 白 logo 方案，默认头像恢复名称首字 monogram（emoji 仍优先；空名才落白 logo 兜底）。DOM 侧（悬浮球弹层 4 处）统一走新增 `setAvatarEl`，规则与 React 侧一致。
- **历史顶部标识删除**：`History · 最近 50 条委派` + 成败统计行整行删掉（tab 名已是「历史」，冗余）；`okN`/`unknownN` 死变量清。
- **删除与跳转放一块**：行头按钮组改为「主会话 / 子 Agent / 删除」同排；展开区只留详情（任务详情框保留）。
- **历史行加头像 + 列化**：时间｜头像｜名称｜消息摘要｜类型｜状态｜操作，列列分清。
- **新增类型列**：「小队」/「Agent」徽标（小队=accent 淡底）；数据源=宿主日志新字段 `viaSquad`（小队执行时传入，**需重启 Desktop 生效**，旧记录一律显示 Agent）。

## 0.9.13 (2026-08-26)

默认头像 + 历史页重排与详情框 + 悬浮球四项（面板弹出/就地调用/小队列表）：

- **默认头像统一白色 DSH logo**：未设 emoji 的 Agent/小队不再用名称首字（monogram），统一白色 DSH logo；logo 外套深色底（`--dsw-static-neutral-1000` 80%）保证亮/暗主题白 logo 均可见。`firstGlyph`/`ad-avatar.mono` 死代码与死 CSS 已清。悬浮球面板三处原生头像（运行中/最近委派/Agent 列表）与主面板运行中大卡（`ad-run-emoji.logo`）同步切白。
- **悬浮球面板从球心弹出**：`placePop` 按球心计算 `transform-origin`（面板在球上方=原点底部、下方=原点顶部），弹出动画视觉上面板从球里展开，不再从面板中心凭空放大。
- **Agent/小队卡片点击就地调用**：不再跳转调度页——走官方输入 facade（`conversation.input.shell(当前会话).setDraft`，单一写入路径）把 `$id ` 填进当前会话输入框，用户补任务发送即委派；老宿主取不到 facade 时回退打开调度面板。
- **新增「小队列表」分区**：悬浮球面板默认折叠（与 Agent 列表同构），数据同 `/expert-api/suggest` 端点顺带返回；点击卡片同就地调用（`$squad-id `）。
- **历史 tab 挪到最后**：tab 顺序改 总览 / Agent / 小队 / 历史。
- **删除按钮移进展开区**：行头只保留「主会话/子 Agent」跳转按钮；删除（红色、带二次确认）收进展开区末行，行面更干净。
- **展开区新增任务详情框**：固定尺寸滚动框（`.ad-hist-taskbox`，110px 高、底+边、可换行滚动）。数据源 = 宿主侧新写入的任务全文字段 `taskText`（截断 4000 防膨胀）；旧记录无该字段时回退显示 `taskLabel` 摘要。
- **宿主侧**：`lib/dispatch.js` 两处决策日志行新增 `taskText` 字段（**此改动需重启 Desktop 生效**，客户端部分刷新即可）。

## 0.9.12 (2026-08-26)

删整球彩色流光（用户：「悬浮球彩色流光这一项删了吧，不要球的彩色流光了」）：

- **「悬浮球彩色流光」开关移除**：整球 hue 循环（`ad-fab-hue` keyframes + `.fab-color` 类）整体删除——CSS、`applyFabSettings` 类切换、默认设置 `color` 字段、设置页开关行全部清；存量 `color` 配置被 `Object.assign` 合并后无消费方，无害忽略。
- **边缘流光保留**：「边缘彩色流光」（`fab-edge` + `.ad-fab-edge-ring` conic 环）不动。
- 呼吸/无动效类选择器去掉 `:not(.fab-color)` 限定（该类已不存在）。
- verify：旧断言反转为负断言（`ad-fab-hue`/`hue-rotate`/整球流光开关不应存在），边缘流光开关保留断言。

## 0.9.11 (2026-08-26)

悬浮球微调四项（用户截图反馈）：

- **呼吸光圈缩小 + 减速**：外围光晕 `0 0 18px 5px` → `0 0 10px 2px`（更小更贴球）；呼吸周期 3.2s → 4.2s（更慢）。
- **右键菜单删除**：悬浮球右键的「打开 Agent 调度面板 / 隐藏悬浮球」菜单整体移除（JS + CSS + teardown），面板头部已有相同入口。
- **色调：雪白置顶**：设置页色调顺序调整为雪白第一。
- **毛玻璃调亮**：透明底在暗色页面显黑 → 改近白半透明叠层 `linear-gradient(rgba(255,255,255,.75),rgba(255,255,255,.55))`，保留磨砂模糊与玻璃感。

## 0.9.10 (2026-08-26)

入口收拢 + 表单按钮排序 + 空态/统计数字清理（面板）：

- **卡片悬浮 ✎ 编辑按钮删除**：整卡点击即编辑，入口唯一；`ad-card-acts` 浮层 JSX 与死 CSS 一并清。
- **模型路由行按钮排序**：↑↓ 从输入框前挪到行尾、✕ 殿后（provider/model/effort 在前），不再挤在左侧。
- **空态圆形 ◍ 图标删除**：总览/Agent/历史/小队四处空态只留文字提示，`.ad-empty-glyph` 死 CSS 已清。
- **统计数字改白色**：概览四个统计数字（含高亮项）颜色改 `--dsw-static-neutral-bluish-00` 静态近白。

## 0.9.9 (2026-08-26)

呼吸周边光形态修正（0.9.8 理解反了，用户澄清：要带模糊的白色光，不是硬边环）：

- **硬边白环 → 白色模糊光晕**：`ad-fab-breathe` 50% 帧外围光由 `0 0 0 7px` 硬边环改为 `0 0 18px 5px var(--dsw-static-neutral-00)`——带模糊的白色周边光晕，随呼吸收放，无硬边。

## 0.9.8 (2026-08-26)

悬浮球呼吸光微调（单点改动）：

- **呼吸外围光环改纯白硬边**：`ad-fab-breathe` keyframes 的外围环由蓝色系 `color-mix` 10% 半透明 → `--dsw-static-neutral-00` 纯白；环本身无模糊（`0 0 0 7px` 硬边，原本即无 blur）。
- **去呼吸帧残留模糊彩色光**：50% 帧的 `0 4px 24px` 蓝色 50% 模糊光晕（视觉上=带模糊的彩色周边光）移除，峰值帧投影改回静态同款 `0 4px 18px`，周边光只剩白色硬边环。球底投影与其余动效不动。

## 0.9.7 (2026-08-26)

内置清理 + 删除入口收拢 + 文案与卡片化：

- **去「内置」标签**：Agent/小队卡片不再显示内置徽标（`builtin` 数据字段保留不动，仅 UI 摘除；宿主无预置逻辑，存量留作用户测试）。删除确认弹窗的「内置小队删除后不会自动恢复」提示一并去掉。
- **删除入口收拢进编辑弹窗**：卡片悬浮只剩 ✎ 编辑，🗑 删除移除；编辑弹窗尾部按钮行左侧新增「删除」（红色，新建态不显示）→ 关表单 → 弹删除确认窗。Agent/小队两条线同改。
- **小队页说明句删除**：「小队 = 多 Agent 协作模板…」一句移除（用户不要）。
- **Agent 页加说明句**：「配置专属 Agent（人设 + 触发域 + 模型路由）。主模型会按触发域把任务自动委派给合适的 Agent，也可直接说『让 XX 处理』。」（先核了宿主无 @ 触发符，文案按真实机制写）。
- **模型路由行卡片化**：`.ad-route` 加底/边/圆角，与步骤卡片语言对齐。

## 0.9.6 (2026-08-26)

小队步骤卡片化 + 表单细节 + 浮层按钮幽灵化：

- **步骤编排卡片化**：每步骤从"虚线分隔的一行挤满输入框"改独立卡片（`ad-step-item` 带底/边/圆角）。头行 = S 徽标 + 阶段名 + Agent 下拉 + 右端 ↑↓✕ 图标组；instruction 独立成 2 行 textarea；依赖勾选行保留（标签改 `S1` 前缀）。
- **步骤徽标美化**：`S1/S2` 从灰色圆形数字改 accent 填充标签（白字，对齐流程图节点编号语言）。
- **系统提示词区加大**：`rows:8→14` + `min-height:180px`（`.ad-textarea.tall`），可拉伸。MD 渲染不做——提示词是给模型的原文，渲染反而误导。
- **卡片浮层按钮幽灵化**：`ad-card-acts` 内 ✎/🗑 去底去框（透明无边），悬停才显色（编辑蓝/删除红+红晕底），与开关不再视觉打架。

## 0.9.5 (2026-08-26)

按钮/编辑体系重设计（原型 A 案，用户确认）+ 头部细节 + 悬浮球反馈五连修：

- **卡片点整体即编辑**：Agent/小队卡整卡可点（`editable` 类 + pointer），配置入口变直觉动作；内层开关/流程图点击阻止冒防误触。
- **编辑/删除改 hover 浮层图标按钮**：卡片右上区浮出 ✎/🗑（`ad-card-acts`，`right:48px` 浮在开关左侧，开关常显可用不遮挡）；删除卡片常驻的"编辑/删除"文字按钮，视觉噪音减半。
- **编辑表单进弹窗**：复用 `ad-modal` 体系——Agent 表单 600px（`ad-modal form`），小队表单 660px（`form wide`，装步骤编排）；表单嵌弹窗时压平卡片底（无盒中盒）；遮罩点击/✕ 均可关闭。
- **删除二次确认改弹窗**：原卡片内联确认条改居中弹窗（380px，取消/删除）。
- **新建按钮升主按钮**：`＋ 新建 Agent`/`＋ 新建小队` 改填充主色按钮（`ad-btn.primary`），一眼可见。
- **头部 logo 白色**：`.ad-logo .ad-dsh-logo` 颜色改 `label-primary`（暗主题=白，亮主题=深色可见）。
- **删总览空态引导句**：「在对话里说…自动路由…」移除。
- **悬浮球 logo 黑色**：`.ad-fab .ad-dsh-logo` 改 `--dsw-static-neutral-1000`（纯黑）；面板标题 logo 用 `label-primary` 保跨主题可见。
- **色调换浅色批次 + 毛玻璃**：紫罗兰/夜幕/玫瑰/琥珀/青色/晚霞 → 雪白、天蓝、雾紫、樱粉、杏橙（浅→深同族渐变），保留品牌蓝与彩色渐变；新增「毛玻璃」无色透明色调（透明底 + `backdrop-filter:blur(10px) saturate(1.3)` + 白描边，球体即磨砂玻璃）。
- **流光拆两个独立开关**：「悬浮球彩色流光」（整球 `hue-rotate` 6s）与「边缘彩色流光」（新增 `.ad-fab-edge-ring`：conic 四色渐变环旋转 4s，`mask` 掏空中心只露 3px 边缘），可分别开关、可叠加。
- **面板透明度不生效修复**：根因=`Number(alpha) || 85` 把 0 吞成 85——拖到 0% 保存后重开被弹回。改 `Number.isFinite` 判定；`fabAlpha` 同款（`|| 100`）。
- **点球重复弹修复**：点外关闭监听的 `ev.target` 未排除悬浮球自身（球带 `setPointerCapture`，pointerdown 先关面板、同一点击的 pointerup 再 `togglePop`→重播弹出动画）。改为点球即重新武装监听、不关闭。
- 滑块标题修复：面板/球两个滑块 l1 均写死「毛玻璃透明度」，改为传入 `title`。
- 清理死类：`.ad-confirm`/`.ad-confirm-text`/`.ad-card-actions` CSS 删除。
- verify：新增 v0.9.5/v0.9.5b 断言共 14 条；修复 4 条过期色调断言（色调集已迭代：violet/amber/cyan→mist/cherry/rainbow）。

## 0.9.4 (2026-08-26)

色调黑屏根因修复 + 透明度分离 + 图标尺寸精调：

- **色调黑屏根因修复**：旧色调渐变引用了**不存在的** `--dsw-alias-state-info-primary` / `--dsw-alias-state-warning-primary`（实际 alias 只有 business/error/success/warn——没有 info/warning）——整条 `linear-gradient` 含未定义变量解析失败→背景透明→透出深色页面呈黑色。品牌蓝/彩色渐变能显示，是因为它们用的 token 恰好都存在。全部色调改为**确实存在的静态色 token**（`--dsw-static-blue/red/amber/green-*`），并修复庆祝动画里残留的 `warning-primary`。
- **面板/悬浮球透明度分离**：设置页拆成两个独立滑块——「面板透明度」（面板 `::before` 不透明度层，`--fab-pop-alpha` 0-1）和「悬浮球透明度」（球体 `--fab-opacity`，色调同步淡化）。面板背景同时从 `color-mix` 改 `::before` 层承载，规避 color-mix 在此环境的解析问题。
- **⚙/✕ 尺寸分离**：只放大 ⚙（36px/19px 字），✕ 还原原尺寸 28px/14px 字。
- **logo 统一蓝**：悬浮球与面板头部 logo 都用 `--dsw-alias-state-business-primary`。

## 0.9.3 (2026-08-26)

执行流图修复三问题（卡片图回归 / 弹窗加大固定 / S1 徽标出框）：

- **小队卡恢复流程图缩略**：v0.9 的文字流方案回退——卡片内重新展示拓扑图，固定 96px 高图区（`ad-graph-box`），SVG 自然尺寸居中，点击整体放大弹窗；图下保留文字流摘要（`squadStepsText`）。
- **弹窗加大且固定**：`ad-modal` 从 680px 自适应改 **780px 固定**（窄屏降级），新增固定 300px 图区（`ad-modal-graph`），节点再多也撑不满、超宽横向滚动。
- **单节点不再撑满**：根因是 SVG 只写 `width:100%` 被容器拉伸。改为给 `<svg>` 设自然像素尺寸（`width/height` 属性 = viewBox），容器 `margin:auto` 居中，**只缩不放**。表单预览容器保留等比缩放。
- **S1 徽标居中修复**：根因是徽标 `text` 默认 `text-anchor:start` 从徽标中心向右起笔溢出。加 `textAnchor:"middle"`。
- **顺带修**：⚙ 设置按钮挂上放大类 `ad-fab-pop-set`（v0.9.2 CSS 写了但 JSX 没挂）；清理死类 `.ad-flowline`；verify 过期断言同步更新。

## 0.9.2 (2026-08-26)

色调生效修复 + 毛玻璃/图标/logo 细节：

- **色调改 CSS 类切换（修复"色调没生效"）**：`applyFabSettings` 从 setProperty 注入 `--fab-c1/c2` 改 `.ad-tone-*` 类切换。根因：color-mix 字符串经 setProperty 注入到 CSS 变量时部分浏览器解析失效；CSS 规则内直接写 color-mix 嵌套 var 则正常。8 色调类：brand/violet/night/rose/amber/cyan/sunset/rainbow（rainbow 四色虹彩渐变）。
- **透明毛玻璃球（去高光）**：悬浮球 `::before` 去掉月牙高光/玻璃边框，改半透明白渐变（135deg 白 .16→.04）+ 微弱内阴影，球体轮廓靠玻璃质感呈现。
- **悬浮球 logo 近白修复**：`--fab-fg` 从 `label-primary-inverted`（暗色主题下解析为深色）改 `--dsw-static-neutral-bluish-00`（静态近白，不随主题翻转），暗色主题下 logo 也是白色。
- **毛玻璃透明度 0-100**：滑块范围 10-100 改 **0-100**（0=全透明只剩模糊）。
- **设置图标放大到 38px**：右上角 ⚙/✕ 38px、字号 19px。

## 0.9.1 (2026-08-26)

悬浮球动效与质感升级：

- **流光改 hue-rotate 色相旋转**：对当前色调渐变整体旋转色相（0→360° 6s），**天然基于色调、连续平滑无突变**（替代 box-shadow 色环硬切）。
- **泡泡玻璃质感**：顶部月牙高光 + 内部双层透光渐变 + 玻璃边框 + 底部反射投影，球体呈透明泡泡感（替代原径向高光）。
- **logo 统一白色**：悬浮球内 logo 白色（泡泡上对比清晰）；面板头部 logo 改 `label-primary`（亮/暗主题自适应）。
- **色调换新批次（8 个）**：品牌蓝/紫罗兰/夜幕/玫瑰/**琥珀/青色/晚霞/彩色渐变**（rainbow 四色虹彩渐变，配流光时整球色相旋转）。
- **面板从中心弹出**：`ad-fab-pop-in`（scale 0.8→1 弹性，transform-origin 中心）替代原从上滑入。
- **设置视图点外关闭修复**：`armOutsideClose()` 每次视图重绘/设置后重新挂载点外关闭监听（原 once 监听被面板内点击消费后失效）。
- **透明度下限降到 10%**：毛玻璃可调范围 10-100%。
- **设置图标放大到 32px**（右上角 ⚙/✕ 去边框）。

## 0.9.0 (2026-08-26)

面板卡片重排 + 卡片语言对齐悬浮球：

- **Agent 卡一行 4 个**：网格改 `repeat(4,minmax(0,1fr))`，窄面板自动降 2 列/单列；卡片内容压缩为「头像+名称/ID+开关 → 触发 chips（前 3 个，完整列表见 hover）→ 路由一行 mono 截断 → 编辑/删除」。
- **小队卡一行 2 个**：`repeat(2,minmax(0,1fr))`，窄面板降单列。
- **执行流瘦身**：小队卡内 SVG 缩略图改为单行文字流（`squadStepsText`，例「日志｜数据 → 代码」）+「查看」按钮弹窗看大图——更省空间、更易读。
- **触发域 chip 化**：原「触发/路由」文本标签行改为胶囊 chip（与悬浮球 `ad-fab-chip` 同款语言），一眼可辨。
- **名称首字头像**：无自设 emoji 时显示名称首字（monogram，accent 色 10% 底），不再全员 DSH logo；emoji 字段保留为可选自定义。
- 卡片节奏对齐悬浮球卡片：`radius 12px`、`border-l1`、行距收紧、名称/ID 纵排为中部伸缩区。

## 0.8.11 (2026-08-26)

悬浮球 3D 化 + 面板毛玻璃 + 动效细节打磨：

- **色调扩到 8 个**（两排 4+4）：品牌蓝/暖橙/青蓝/紫罗兰/薄荷 + **玫瑰/苔藓/夜幕**（color-mix 合成，无硬编码色值）；色调标签改 `label-primary`（深色主题不再发黑）。
- **流光平滑过渡**：色环从 4 段改 **8 段关键帧**（色调→绿→黄→蓝→紫→回色调，每段间加混合过渡色），周期 5s→8s，开头不再生硬突变。
- **悬浮球 3D 效果**：径向高光（左上光源）+ 内阴影 + 底部椭圆投影（`::before`/`::after`），球体有立体感。
- **鼠标悬停特效**：hover 轻微放大（scale 1.1）+ 高光增强 + 光晕增强（拖拽时暂停）。
- **面板毛玻璃**：`backdrop-filter: blur(18px) saturate(1.4)`，背景半透明（默认 85%）。
- **透明度滑块**：设置页新增「面板透明度」滑块（20-100%），实时生效、localStorage 持久化；数值越低越通透（模糊保留）。
- **设置图标移回头部**：⚙ 放在关闭 ✕ 旁（右上角），底部恢复只有主按钮。

## 0.8.10 (2026-08-26)

悬浮球设置与动效体系修整：

- **开关点击无反馈修复**：呼吸/流光开关点击后 knob 即时切换（on/off 类更新），不再"像没反应"。
- **彩色流光变黑修复**：流光不再覆盖球底色（原四色渐变 background 在深色主题失效发黑），只做 box-shadow 色环旋转光晕，底色保持当前色调渐变。
- **呼吸 vs 流光区分**：呼吸=单色光晕脉动+轻微缩放；流光=四色 box-shadow 旋转（绿→黄→蓝→紫）。差异明显。
- **色调图标可见性**：色点加边框（深色主题下可见）；**紫罗兰改纯紫**（color-mix 合成，不引入硬编码色值）。
- **图标统一色**：⚙/✕/⇱⇲/箭头统一灰色（`--dsw-alias-label-secondary`），hover 变品牌蓝。
- **设置按钮移回底部**：头部只留 ✕（去边框、放大 28px），底部主按钮旁恢复「⚙ 悬浮球设置」ghost 按钮。
- **任务成功一次性庆祝动画**：平时无动效；任务完成瞬间悬浮球爆发彩色光晕+上跳（`ad-fab-celebrate` 1.3s），看一眼恢复平静；再次成功再次触发（强制重排支持连续触发）。与常态动效开关独立。

## 0.8.9 (2026-08-26)

UI 细节打磨（client 刷新即生效；存量数据迁移需重启 Desktop）：

- **logo 换 DSH 官方图形**：面板头部去掉蓝紫渐变方块底，DSH logo path 以品牌色直出（亮/暗主题均可辨）；小队卡/弹窗同步。
- **描述文案通用化**：设置页副标题改「把任务委派给专职 Agent：自动路由、小队协作、全程可追踪」。
- **小队卡瘦身**：长列表改两列卡片网格（`minmax(340px,1fr)`，窄面板自动降单列）；执行流图从全宽 280px 限高改为紧凑缩略（限高 120、居中），点击仍弹窗放大。
- **emoji 清理**：内置 Agent/小队不再预置 emoji（`📋🔍🛠️🗄️🏗️` 全清空）；所有 🤖/🧩 兜底头像改 DSH logo（新增原生 DOM 版 `dshLogoSvg` helper）；流程节点与弹窗步骤名去 Agent emoji；emoji 字段保留，用户自设的照常显示。
- **存量迁移**：内置项且仍是历史预置 emoji → 启动加载时一次性清空写盘（`experts.js` / `squad-registry.js` 的 `LEGACY_EMOJI` 集合），用户自设不动。
- **步骤编排拖动配置**：评估后维持现有表单式（飞书式画布拖拽成本高，当前勾选依赖+实时预览图已覆盖）。
- **悬浮球面板交互修复与增强**：
  - 修复**设置自动返回**：新增 `popView`（main/settings）状态，异步轮询/拉取回调只在主视图时重绘，设置视图不再被覆盖回主视图。
  - 修复**彩色流光不生效**：`linear-gradient` 的 `background-position` 动画无效，改 `box-shadow` 色环动画（`ad-fab-glow` 5s 循环，四色光晕旋转，视觉明显）。
  - **色调扩到 5 个**：品牌蓝 / 暖橙 / 青蓝 / 紫罗兰 / 薄荷。
  - **设置按钮移头部右上角**（⚙ 在 ✕ 旁），底部只剩主按钮「打开 Agent 调度面板」。
  - **新增 Agent 列表分区**（迷你调度台）：面板内第 3 区「Agent 列表」（数量+箭头），默认折叠、点击展开，点卡片打开调度面板。
  - **最近委派悬停双按钮**：行悬停显示「⇱ 子会话 / ⇲ 主会话」快捷跳转（低风险不二次确认；主会话按钮仅在有 parentSessionId 时显示）；卡片点击默认跳子会话。

## 0.8.8 (2026-08-25)

活动面板重设计（方案A 卡片分区）+ 悬浮球设置：

- **面板重设计**：头部改状态摘要（品牌渐变底 + 「● N 运行中 / 空闲」徽标）+ 主体分「运行中」「最近委派」两区，每项卡片化（avatar + 名称 + 任务摘要 + 状态/时长 chip），底部操作行（主按钮「打开 Agent 调度面板」+ 「⚙ 设置」）。
- **悬浮球设置浮层**：面板内「⚙ 设置」进入——**色调三选**（品牌蓝/暖橙/青蓝，CSS 变量注入 `--fab-c1/--fab-c2`）、**呼吸光晕**开关（默认开）、**彩色流光**开关（默认关，渐变流动动画）。全部 localStorage 持久化，实时生效；开关控件灰底白球两态一致。
- **悬浮球动效类体系**：`fab-breathe`（呼吸）、`fab-color`（彩色流光）、拖拽时动画暂停；设置挂载时自动应用。

## 0.8.7 (2026-08-25)

悬浮球活动面板交互完善：

- **点空白处收起面板**：打开后点击面板外任意位置自动关闭（原只能点 ✕ 或再点悬浮球）。
- **「查看历史」改最近 3 条**：面板底部按钮去掉「查看历史」，改为面板内新增「最近委派」区——展示最近 3 条委派（Agent + 任务摘要 + 完成/失败/运行中/未知状态徽标），异步拉取。
- **文案统一**：「打开 Agent 调度」→「打开 Agent 调度面板」（面板底部 + 右键菜单）。
- **面板 logo 可见性**：面板头部 DSH logo 固定品牌色（深色主题下原 currentColor 继承深色文字导致 logo 发黑看不清）。

## 0.8.6 (2026-08-25)

悬浮球活动面板打开体验修复：

- **去掉打开时的"加载中…"闪屏**：点击悬浮球先闪「运行中（…）」再出完整面板——根因是打开时 renderPop() 无数据先渲染加载态，等 5s 轮询填充。改为：poll 缓存最近活跃数据（`lastActive`），打开面板**立即用缓存渲染**，并同时主动 fetch 刷新一次，无感知更新。

## 0.8.5 (2026-08-25)

UI 精细化 + 历史删除 + 悬浮活动面板：

- **Agent 卡片放大**：网格列宽 230→300px，卡片内边距/头像（30→40px）/名称字号同步加大。
- **小队执行流图改版**：图从右侧移到**信息下方、宽度撑满**（`.ad-squad-flow` width:100%，容器上下固定、高度自适应内容），不再是侧边固定 320px。
- **历史支持删除**：host 新增 `POST /expert-api/history/remove`（按 dispatch 行 ts 定位删除，同 childId 的对应 result 行一并删，续聊不误伤后续派遣）；历史每行加「删除」按钮（confirm 二次确认）。⚠️ host 改动需重启 Desktop 生效。
- **悬浮球 → 大浮动活动面板**：点击弹出 340px 宽面板——头部（DSH logo + 「Agent 活动 · 运行中」+ 关闭）、运行中列表、底部快捷入口（打开 Agent 调度 / 查看历史）。
- **移除显示模式配置**：右键菜单去掉「显示模式：一直/自动」项（保留打开调度 + 隐藏悬浮球），设置页悬浮球显示模式区块删除。

## 0.8.4 (2026-08-25)

小队列表改版 + 历史页会话跳转 + 悬浮球右键菜单：

- **小队改列表长卡片**：从自适应网格改为纵向长卡片列表（`.ad-squad-list`），左信息区（DSH logo 图标 + 名称 + 开关 + 说明 + 编辑/删除）+ 右侧**固定尺寸执行流图**（宽 320px，窄屏自动折行）；新建小队表单的预览图同样固定尺寸（`.ad-flow-preview-fixed` 340px）。
- **小队图标换 DSH logo**：卡片头像从 emoji（🧩）改为内联 DSH 官方 logo。
- **历史页优化**：行改卡片式（`.ad-hist-head` 点击区），点击行**展开预览**（`.ad-hist-preview`）：Agent 路由、主会话 id、子 Agent id、错误信息，各带「跳转」按钮；行尾常驻「主会话」「子 Agent」快捷跳转按钮。
- **host 记录 parentSessionId**：dispatch 日志行与 result 行新增 `parentSessionId`（发起会话 id），合并时透传——历史页由此可**跳转主会话**。⚠️ 此改动需重启 Desktop 生效；旧行无该字段则不显示主会话按钮（子 Agent 跳转已可用，纯 client）。
- **悬浮球右键菜单**（`.ad-fab-menu`）：打开 Agent 调度（DOM 兜底点宿主 view tab）、显示模式（一直/自动/隐藏）、隐藏悬浮球；左键点击仍为运行中弹窗。

## 0.8.3 (2026-08-25)

执行流可视化升级 + DSH 品牌 + 悬浮球重写（纯 client，刷新页面即生效，无需重启）：

- **DSH 官方 logo**：内联官方 `tray-icon.svg`（色值改 currentColor 跟随主题），替换 Agent 调度面板头部与悬浮球的 🤖。
- **执行流图精致化**：渐变节点（linearGradient + 语义化 token）、圆角徽标、依赖标注（"依赖 S1,S2"）、hover 高亮发光；大图模式（弹窗）顶部加层标注（L1 · 并行 / L2 · 串行）。
- **执行流弹窗大图**：点击卡片内执行流图 → modal 弹窗（`SquadFlowModal`）：放大拓扑图 + 步骤说明列表（步骤号 / 阶段+Agent / 依赖 / instruction 全文），mask 点击关闭，动画入场。
- **历史页"假运行中"兜底**（纯 client，不等宿主重启）：历史 tab 并拉 `/expert-api/active` 活跃集合，未终结 + 有 childId + 不在活跃集合 → 直接显「状态未知」；宿主升级后由 orphan 收敛接管，双保险。
- **悬浮球随处可拖**：去掉边缘吸附，松手即存位置（仍钳视口内）；持久化 localStorage。
- **悬浮球动态特效**：常态呼吸光晕（`ad-fab-breathe` 3.2s 循环）、拖拽时放大 1.14x + 阴影加深、完成时绿色闪光扩散（`ad-fab-flash`）。

## 0.8.2 (2026-08-25)

Agent/小队管理与执行流可视化（host + client；host 改动需重启 Desktop 生效，client 刷新即生效）：

- **修复：Agent 配置开关点击报错**。根因：`restHandler` 里有两个 `if(POST)` 块，第一块（小队路径）的 `default` 分支 404 return，把第二块的 `toggle/upsert/remove/import-skill` 全吞了。修复：合并为单一 POST 块（同时补 `POST /squad/toggle`）。
- **小队开关**：小队卡新增灰底白球开关（两态外观一致，仅球位区分，与 Agent 一致）；`squad-registry` 支持 `enabled`（默认 true）+ `setEnabled`；停用小队 `expert_squad` 拒绝执行、`$` 菜单不再出现。
- **删 Agent 用量角标**：Agent 卡"近50次：N·✓M"移除（含 `ad-usage` CSS 与 overview 用量数据源清理）。
- **小队执行流图形化**：卡片与编辑表单内嵌 SVG 拓扑图 `SquadFlowGraph`——按依赖拓扑分层（层内并行、层间串行），每步显示 序号+阶段名+Agent emoji，依赖箭头贝塞尔曲线连接；表单内实时预览（改步骤/依赖即重绘）；配色全走语义化 token 适配亮/暗主题。
- **卡片排版优化**：Agent/小队卡描述区标签化——「触发/路由/说明/执行流」小字徽标 + 内容同行，不再挤成一行。

## 0.8.1 (2026-08-25)

历史页"假运行中"修复（host + client 改动；host 半需重启 Desktop 生效，client 半刷新即生效）：

- **修复：历史记录永远显示"运行中"**。根因：`result` 行只由当前进程的 `subagent/end` 监听器追加——宿主重启丢监听器、0.7.1 之前的遗留行没有 `kind` 字段，两类孤儿都配对不上结局，历史页据此误显示"运行中"。
- **孤儿收敛**："运行中"改以活体 `activeChildren` 为唯一权威来源；未终结但 child 不在活跃映射的行收敛为 `orphan`（前端显示「状态未知」）。派遣本身失败的行（`ok:false`）直接落「失败」。旧日志无需迁移。
- **兼容旧日志**：合并配对不再要求 `kind === 'dispatch'`，无 `kind` 字段的遗留派遣行同样参与配对与收敛。
- **总览成功率修正**：成功率与 byExpert 只统计结局已知的行，孤儿不再被误算为成功。
- **历史页四态**：运行中 / 完成 / 已中止·失败 / 状态未知（弱化灰），计数栏追加 `?n` 未知条数。

## 0.8.0 (2026-08-25)

UI 改版（纯 client 改动，刷新页面即生效，无需重启）：

- **命名统一**：右 tab、设置分区、面板标题统一为「Agent 调度」。
- **删「活动」tab**：运行中卡片并入总览（原两处重复），子 tab 由 5 个减为 4 个：总览 / 历史 / Agent / 小队。
- **删 Ranking 区块**：总览只留统计卡 + 运行中；使用量以「近50次：N · ✓M」角标并入 Agent 卡片。
- **改名**：「管理」→「Agent」、「组队」→「小队」，按钮与说明文案同步（+ 新建小队）。
- **卡片化**：Agent 与小队列表改为卡片网格（`ad-cards`，auto-fill 窄面板自动降单列）。
- **悬浮球进设置**：新增显示模式三选一（一直显示 / 自动 / 隐藏），默认一直显示；选择存 `localStorage`（`ad-fab-mode`），切换即时生效。
- 清理活动页死代码与对应 CSS（`ad-active-*` / `ad-disp-*` / `ad-rank-*`）。

## 0.7.1 (2026-08-24)

生命周期闭环修复（host 改动，需重启）：

- **修复：子 agent 完成后"运行中"永不消失**。根因：`activeChildren` 只增不减（唯一 delete 在续聊失败分支）。修复：订阅宿主 `subagent/end` 生命周期事件（payload 带 `stopReason`），终结即移出映射。此前 FAB 完成检测（集合差）永远不触发、活动页永远显示运行中。
- **真实结局记录**：`subagent/end` 时向 `dispatches.jsonl` 追加 `kind:'result'` 行；`/expert-api` 各端点经 `mergeDispatchHistory` 时间配对合并——续聊复用同 child 时，第 1 次派遣得第 1 次结局、第 2 次得第 2 次，互不串。历史页成功率从此反映真实执行结果。
- **续聊时长语义修正**：续聊重置 `startedAt` 为本次续聊时间（原逻辑沿用首次派遣时间，休息 2 小时后追问会显示"运行中 2h"）。
- **中止能力**：新增 `/expert-api/cancel` 端点（宿主 `interrupt`，user-authority），entry 记录 `parentSessionId` 作权限凭证；总览/活动页运行中卡新增"中止"按钮（共享 `RunCard` 组件）。
- **历史页三态**：运行中（未终结）/ 完成 / 已中止·失败，真实结局来自事件合并。
- **跳转子 agent 会话**：运行中卡、悬浮球列表行、历史行均可点击跳转子 agent 会话（宿主 `sessions.open`，支持 catalog 内子会话；中止按钮阻止冒泡）。
- **日志轮转**：`dispatches.jsonl` 上限 2000 行，超出自动重写保留尾部，防长期膨胀。
- （澄清）`/` 直选菜单本就含组队（源循环 `/suggest` 的 squads，onPick 插 `$id`，规则 8 已覆盖组队→`expert_squad`），无需新增。
- 修复（同轮发现）：`expert_list` 参数补 `required: []`（裸注册透传坑变体）。

## 0.7.0 (2026-08-24)

UI 全面重构，设计语言学记忆系统（dsh-mnemon MnemonView）：

- **信息架构瘦身**：总览删「最近委派」历史区（只留统计卡+运行中+排行）；活动删「最近委派」列表（只留运行中大卡）；历史为唯一看历史的地方。
- **视觉升级**：`--ad-*` shell 变量映射层（全映射 `--dsw-alias-*` token，亮/暗主题自动跟随）；节标题改等宽大写 kicker（cardKicker 风格）；空态改虚线框+发光圆形 glyph「◍」+引导文案（emptyState 同款）；运行中指示改状态点光晕呼吸（liveDot 同款）；运行中卡片左绿边+任务摘要+运行时长徽标（10s 走字）。
- **悬浮球**：可拖动（pointer 事件+移动>4px 判拖拽），松手吸附左右边缘，位置存 localStorage；子 agent 完成检测（活跃集合差）→ 球闪绿光 3s+「✓n」徽标；弹窗跟随球位置（上方优先、不越界）；活跃时显示绿点。
- **host**：activeChildren 值升级为 `{childId, taskLabel, startedAt}`，/expert-api/active 与 /overview 端点透出任务摘要与启动时间。
- **管理/组队视觉统一**（同日追加）：两页卡片套上 `--ad-*` 变量层（圆角 11 + hover 边框过渡 + 头像框）；节标题统一 kicker；空态统一发光圆形 ◍；「启用」文字按钮换成真开关——灰底白球、仅球位区分（左=停用右=启用），两态外观完全一致（用户铁偏好）；表单圆角与变量层同步。
- **host 补丁**（同日追加，重启前 review 抓到）：`expert_list` 参数补 `required: []`，防严格网关拒收（裸注册透传坑的变体）。

## 0.6.0 (2026-08-24)

## 0.6.0 (2026-08-24)

- **主面板迁移**：从设置弹窗迁到宿主原生右 tab「Agent」（conversation.view 槽，order=21，与 对话/轨迹/记忆系统 同级）。
- **五个子 tab**：总览（统计卡+活跃+使用排行+最近委派，30s 刷新）/ 活动（活跃 Agent+最近委派，10s 刷新）/ 历史（近 50 条全量）/ 管理（Agent CRUD）/ 组队（Agent 组队 CRUD）。
- **Agent 直选菜单**：输入 / 唤起候选菜单（命令组后多一个 Agent 组：Agent + Agent 组队），选中插入 `$id ` 继续编辑；prompt 策略新增第 8 条（$ 前缀=用户显式指定 Agent 委派）。初版按 $ 触发符注册，实测宿主 detectTrigger 硬编码只扫描 '@' 与 '/'（任意字符注册源后无入口扫描），改挂 '/' 组实现。
- **悬浮活动按钮**：右下角常驻（活跃 Agent>0 时出现），点击展开运行中列表（原生 DOM，不依赖槽位）。
- **设置弹窗瘦身**：只留「Agent」说明分区（面板位置说明+默认模型+数据目录+触发方式说明）。
- **全面 Agent 化文案**：「专家/小队」从所有 UI 文案退役（工具名 expert_* 与 REST 契约不变，模型侧零迁移）。
- REST 新增：/expert-api/suggest（$ 候选）、/expert-api/overview（总览聚合）。
- 修复（0.5 期间发现）：expert_squad 参数 squad_id snake_case+required 恢复（吞参事故根因）；maxDepth 动态计算（孙代链 SubagentDepthError）；topoLayers 依赖越界/自指/非数组独立报错（原误报为环）。

## 0.3.0 (2026-08-24)

- Settings 拆两分区：「Agent 调度」（专家+小队管理）与「Agent 活动」（活跃子代理+最近委派，10s 自动刷新）。
- 小队注册表化：squads.json 可编辑（内置 3 队+自定义队 CRUD），expert_squad 动态读注册表，删内置队有防复活标记。
- 小队可视化编辑：步骤流拓扑预览（层内｜层间→）、expertId 下拉、依赖勾选+下标重映射、客户端预校验与服务端同规则。
- 模型路由改下拉（ctx.llm listProviders/listModels + settings 显式配置合并去重），不选=跟随默认模型（标题动态展示默认）。
- effort 透传进 agentOptions（minimal/low/medium/high/xhigh/max，UI 下拉化）。
- 数据目录展示 tildify 为 ~/.dsh/...（通用插件不暴露真实 HOME）。
- REST 新增：/expert-api/squads、/squad/upsert、/squad/remove、/active、/skills、/import-skill。

## 0.2.0 (2026-08-24)

- 小队模式（expert_squad）：dev-pipeline / debug-squad / review-squad 三个预置模板，拓扑分层执行（依赖前置结果自动代入 {prev:N}），停用专家跳过、单步失败不炸全队。
- skill 导入（expert_import_skill）：~/.dsh/skills 的 SKILL.md 一键注册为专家（软链目录跟随识别）。
- Settings 页"专家"管理面板：增删改/路由表可视化编辑/启停/删除二次确认/最近委派记录（REST /expert-api）。
- 修复 v0.1.0 启动崩溃：dsh.client 缺 platform:"web" 致 client-modules 整树 compose 失败、Desktop 自动回滚（见 verify.mjs 防回归断言）。

## 0.1.0 (2026-08-24)

首发。

- 专家注册表 `$DSH_HOME/data/dsh-agent-dispatch/experts.json`：直接编辑保存即生效（免重启），删除内置专家不复活（deletedIds 持久标记）。
- 内置 4 专家：requirement-analyst（需求分析师）/ code-reviewer（代码审查员）/ log-tracer（线上排查员）/ sql-analyst（SQL 分析师）。
- 模型工具三件套：`expert_dispatch`（建/复用可续聊专家子代理，routes 失败互备）、`expert_followup`（同专家追问，上下文延续）、`expert_list`（专家目录）。
- 专家委派策略 prompt section：命中专家领域自动委派，简单问题不杀鸡用牛刀。
- `/expert` slash 命令：列专家 / 直接委派。
- 委派决策落盘 `dispatches.jsonl` 可审计。
- 零 `@deepseek-ai/dsh-tools` 依赖（规避官方双实例 bug #1697/#783）。
### 第八轮（收尾轮：2 阻断「**欠吃**」方向 + 1 测试盲区 M2）

**背景**：独立只读终审（会话 `af118eb7`）在第七轮收尾版上，用**本机（macOS，即部署平台）真二进制**
复现了 12 条静默放行（判据层 `null` / 监听器层 `allowed-once`）。方向与第七轮**相反**：
第七轮修的是「**多吃**」（把开关当取值选项 ⇒ 吃掉真程序名），本轮修的是「**欠吃**」
（该吃的取值没吃 ⇒ 紧跟的真程序名被当成取值/普通参数跳过 ⇒ 整段判不出）。
第七轮那条结构性兜底对「欠吃」**零覆盖**（终审分析，本轮复核确认）：判据①只在「剥壳结果的头
token 以 `-` 开头」时触发，而漏登记时头 token 是**取值本身**（`/bin`、`%`、`root`、`2`）；
判据②的探针只在**被表吃掉**时才生成 ⇒ 漏登记时探针集合为空。

#### 🔴 B1（阻断）已登记包装器**漏登记真实取值选项**（每条都做了本机真二进制双向核对）

| 形态 | 本机核对命令与读数 | 缺口 |
|---|---|---|
| `env -P /bin rm -rf /x` | `env -P` → `option requires an argument -- P`；`env -P /bin /bin/echo HI` → `HI`；附着形态 `env -P/bin /bin/echo HI` → `HI`；usage 里有 `[-P utilpath]` | `env` 表缺 BSD `-P utilpath` |
| `xargs -J % rm -rf /x` | `xargs -J` → `option requires an argument -- J`；`printf 'a\n' \| xargs -J % /bin/echo HI` → `HI a`；反向核对 `xargs -J /bin/echo HI` → `xargs: HI: No such file or directory`（**恰好吃掉一个 token**，把真程序名当取值） | `xargs` 表缺 BSD `-J replstr` |
| `xargs -I {} -R 2 rm -rf /x` | `xargs -R` → `option requires an argument -- R`；`printf 'a\nb\n' \| xargs -I {} -R 2 /bin/echo HI` → `HI`×2 | 缺 `-R replacements` |
| `xargs -I {} -S 100 rm -rf /x` | `xargs -S` → `option requires an argument -- S`；`printf 'a\n' \| xargs -I {} -S 100 /bin/echo HI` → `HI` | 缺 `-S replsize` |
| `chroot -u root /mnt rm -rf /x`、`chroot -G staff /mnt rm -rf /x` | 本机 usage：`chroot [-g group] [-G group,group,...] [-u user] newroot [command]`；`-u`/`-g`/`-G` 各自 `option requires an argument`；`chroot -u root /nonexistent-xyz /bin/echo HI` → 报的是 **NEWROOT** 不存在（⇒ `-u` 吃的是 `root`、下一 token 才是新根） | `chroot` **整条没有取值表条目**（第六轮只登记了位置参数 `newroot`） |

落点（`lib/host-approval.js`）：`WRAPPER_VALUE_OPTIONS` 的 `env` 补 `-P`、`xargs` 补 `-J/-R/-S`、
新增 `chroot: optionSet(['-u','-g','-G'])`。
**`xargs -i` 仍不得加回**（第七轮已删）：本机 `xargs -i` → `xargs: invalid option -- i`（BSD 无此选项），
GNU man 写的是 `-i[replace-str]`（方括号 = 可选附着、**不吃**下一个 token）。

#### 🔴 B2（阻断）`TRANSPARENT_WRAPPERS` 漏了整类「执行下一条命令」的 macOS 包装器

| 形态 | 本机核对（无害的 `/bin/echo HI`） | 登记结论 |
|---|---|---|
| `arch -x86_64 rm -rf /x`、`arch -arm64 git push` | `arch -x86_64 /bin/echo HI` → `HI`；`arch -x86_64` 单独写 → `arch: No command to execute`；`arch --help` → `arch: Unknown architecture: help` | 进名单；取值选项 = **空集**（`-x86_64`/`-arm64` 只是架构选择器，**不吃**下一个 token —— 登记它会把真程序名 `rm` 当取值吃掉 ⇒ 反而漏） |
| `caffeinate -d rm -rf /x` | `caffeinate -t` → `option requires an argument -- t`；`-w` 同理；`-t 1 /bin/echo HI` → `HI`；`-disu /bin/echo HI` → `HI` | 进名单；取值选项 `-t`/`-w`（`-d/-i/-s/-u` 是开关） |
| `script -q /dev/null rm -rf /x` | `script -q /dev/null /bin/echo HI` → `HI`；`script -t`/`-T` 各自 `option requires an argument`；本机 man SYNOPSIS：`script [-aeFkqr] [-t time] [file [command ...]]` | 进名单；取值选项 `-t`/`-T`；**位置参数 `[1]` = 记录文件**（漏掉它 ⇒ 头 token 变成 `/dev/null` ⇒ 静默放行）。注意 `-F` 在本机是**开关**（"Immediately flush output"，`script -F /dev/null /bin/echo HI` 把 `/dev/null` 当记录文件）⇒ **不列** |
| `xcrun rm -rf /x` | `xcrun /bin/echo HI` → `HI`；`xcrun -sdk /bin/echo HI` → 去开 `/bin/echo/SDKSettings.plist`（⇒ `-sdk` 吃掉 `/bin/echo`）；`-sdk`/`--sdk`/`--toolchain` 单独写都报 argument missing | 进名单；取值选项 `-sdk`/`--sdk`/`--toolchain`；其余（`-v/-l/-f/-r/-n/-k/--run/--find/--show-sdk-*`）是开关 |

口径旁证：Linux 的孪生 `setarch` 早在第六轮名单里（`:574-581` + 位置参数 `:750`），macOS 的 `arch` 漏了。
`WRAPPER_POSITIONAL_ARGS` 因此从 `{ chroot: [1], setarch: [1,0] }` 变成再加一条 `script: [1]`。

#### 🟠 M2（测试盲区）已修：表驱动用例从「读源码」改为「**字面量期望清单**双向对拍」

终审变异实测：把 `env` 的 `-C` 从源码表里删掉后，旧用例仍 **47/47 全绿**（变异存活）——
因为旧用例**从源码读表**，删条目 = 同时删掉断言。
新用例 `第八轮 M2：取值选项表与**字面量期望清单**双向对拍（删条目 / 加条目都必须红）`：
- 期望集合写成**字面量**（两张表全部条目，逐条注明来源）；
- 期望有、源码没有 ⇒ **红**（欠吃方向）；源码有、期望没有 ⇒ **红**（多吃方向）；
  确属有意为之的必须写进 `EXTRA_SOURCE_ENTRIES` + 理由（当前为空 = 一条都不许多）；
- 另钉：4 个 macOS 同族名字在 `TRANSPARENT_WRAPPERS` 里、`script`/`chroot` 的位置参数形状。

#### 口径变化如实补记：第七轮把一批「第六轮命中」收窄成了 MISS（**不是回归**）

第七轮把短选项查表从「大小写折叠」改成「**原样精确**」后，一批第六轮会命中的形态（终审统计
**298 条**）变成 MISS。终审已逐条核查并确认：**这些选项拼写在真机上并不存在**（命令本身会报
`invalid option` 之类错误、根本不会执行），因此收窄方向与真相同向、不是少弹。
本轮的表差分复核（第六轮源码 `a290b9f2…` vs 本轮）：
- 表**内容**上第六轮→本轮只少了一条：`xargs -i`（第七轮删，理由见上；本机 BSD 无 `-i`、GNU man 是可选附着）；
- 表**新增** 27 条：`sudo -R/-T/-U/-D`+4 长选项、`strace -U/-O/-S/-X`、`git -C`（第七轮），
  `env -P`、`xargs -J/-R/-S`、`chroot -u/-g/-G`、`caffeinate -t/-w`、`script -t/-T`、`xcrun -sdk/--sdk/--toolchain`（本轮）；
- 其中在本机**有二进制可核**的都已逐条核过（见上表与第七轮节）；`strace`/`sudo` 的拼写来源是
  man 页（本机无这些 Linux 工具）。

#### 未在本机核对（待 Linux 侧验证，**故意不写进表**，也不删既有条目）

| 条目 | 为什么没写进表 / 待办 |
|---|---|
| GNU chroot `--userspec` / `--groups` 的**空格形态** | 本机 macOS chroot 对 `--…` 一律 `illegal option -- -`（无长选项），核不到；GNU coreutils 的 `--userspec=USER:GROUP` 是**必需参数**长选项，空格形态在 Linux 上大概率也吃取值 —— 但按纪律「拿不准宁可列清单、不写进表」，待 Linux 侧用真二进制核过再补 |
| `nsenter -w` / `-W`（工作目录 / ？） | 本机无 `nsenter`、无 man 页（macOS 无该工具）；现有 `-t/-N/-G/-S` 来自 Linux man（第五/六轮） |
| `doas -a` 等 | 本机无 `doas`；现有 `-u/-C` 来自 OpenBSD man（第五轮） |
| `strace` 全表的**真机**复核 | 本机无 `strace`；表来源是 man7 `strace(1)`（第六/七轮逐字核对） |
| `unshare` / `systemd-run` / `setarch` / `prlimit` / `firejail` / `ionice` / `taskset` / `busybox` / `toybox` / `coreutils` | 同上：本机无这些 Linux 工具，现有条目来自各自 man 页（第五/六轮） |
| GNU-only `xargs -d` / `-a` | 本机 BSD xargs 报 `invalid option`（GNU 才有 `-d delim` / `-a file`，两者都吃取值）⇒ 表里保留是**跨平台**口径，本机核不到 |

#### 残余风险（本轮新登记）

1. **`script [file]` 不带命令时会起一个交互 shell**（本机实测；`script -q /dev/null` 会跑用户 shell），
   当前判据层返回 `null`（放行）。未按 `SHELL_STDIN_RULE` 处理，依据是本机实测
   `printf 'echo X\n' | script -q /dev/null` **只回显、未执行**（非 tty 下 shell 立刻退出）⇒
   不是「危险命令正文被藏起来」的那类；如实登记为边界，若 Linux 侧行为不同需重新评估。
2. **`caffeinate` 不带命令**只是持有断电断言（不执行命令）⇒ 与 `env` 不带命令同类，保持放行。
3. 兜底与表单向性：本轮全部修法是**加条目 + 加名单**（只多弹不少弹）；误伤面用 19 条守卫钉住。

#### 转红（三项，每项都先记基线 md5 + 存 pristine 副本，再动原文件）

| 变异 | 做法 | 读数 | 红点 |
|---|---|---|---|
| `MUT-R8-1` | 删掉源码表 `env` 的 `-P` | `# tests 52 / # pass 49 / # fail 3`，退出码 1 | 判据层 31（B1 行为）、**34（M2：`WRAPPER_VALUE_OPTIONS.env 丢了取值选项 -P`）**、监听器层 3 |
| `MUT-R8-2` | 把 `arch` 移出 `TRANSPARENT_WRAPPERS` | `52 / 49 / 3`，退出码 1 | 判据层 32（B2：`arch -x86_64 rm -rf /x 静默放行`）、**34（M2：`TRANSPARENT_WRAPPERS 里没有 arch`）**、监听器层 3 |
| `MUT-R8-3` | `optionKey` 改回 `toLowerCase()`（复用第七轮那条） | `52 / 50 / 2`，退出码 1 | 判据层 23（大小写碰撞）、24（表驱动） |

恢复自证（三项同法）：`cmp` 逐字节 + md5 回基线（`lib/host-approval.js`
`7026ed8c0c629d52152894cd5e7f9079`、`test/dangerous-command-gate.test.js`
`276e4e9f2a17371c7c5fea7e43c5c2a0`）+ **源码文件**里 `MUT-` grep 计数 0 + 复跑全量 551/551/0。

#### 验收（判据层 + 监听器层双证）

- **必须命中/`next()`（12 条）**：`env -P /bin rm -rf /x`、`env -P /bin npm publish`、
  `xargs -J % rm -rf /x`、`xargs -I {} -R 2 rm -rf /x`、`xargs -I {} -S 100 rm -rf /x`、
  `chroot -u root /mnt rm -rf /x`、`chroot -G staff /mnt rm -rf /x`、`arch -x86_64 rm -rf /x`、
  `arch -arm64 git push`、`caffeinate -d rm -rf /x`、`script -q /dev/null rm -rf /x`、`xcrun rm -rf /x`
  —— 判据层 12/12 命中（`rm -rf` / `npm publish` / `git push`），监听器层 12/12 `next()`、零 auto-grant。
- **必须仍无害放行（`allowed-once`）**：`env -P /bin ls`、`env -i ls`、`xargs -J % ls`、
  `xargs -I {} -R 2 ls`、`chroot -u root /mnt ls`、`arch -x86_64 ls`、`caffeinate -d ls`、
  `script -q /dev/null ls`、`xcrun ls` + 第七轮全部守卫形态 —— 判据层全 `null`，监听器层走工具名档。
- 复跑第七轮那份 110 条判据层探针：`不符预期 0 条`。

#### 第八轮冻结凭据（自指说明同前）
- 协议：`tar -czf /tmp/dsh-agent-dispatch-1.12.6-freeze.tar.gz --exclude=node_modules --exclude=.git .`
  —— 在**本节写入之后**执行，故包内 `CHANGELOG.md` 与本文件逐字节一致。
- 包自身的**成员数 / 字节数 / md5 / sha256**、解包后 `diff -r -x node_modules -x .git` 的结果、
  `git status --porcelain`、冻结时刻由交付报告给出（把包自己的 md5 写进包内会改变它自己，
  构造上不可能自含）。
- **逐文件 md5 全表（第八轮冻结时点，65 个文件；不含 `CHANGELOG.md` 自身）**：

```text
  `.github/workflows/ci.yml` `4c3b180cfe820bf80c91a5b7050d783c`
  `.gitignore` `fc9d54f7afb97c0d762a0dc93ec64ff8`
  `.qoder/settings.local.json` `b0b9282667dcaade2d18528a237cd76d`
  `LICENSE` `6cc0f1157ee6fec2c6fc4f612fa0bce0`
  `README.en.md` `aa34e20873f8a77c9beb6e1c01a9577c`
  `README.md` `ed9bf09567fb14fc0882a116ba1d62aa`
  `cordis.patch.yml` `6344d499f05d66b13910d41f3310bb09`
  `docs/screenshots/agents.png` `6a30c4c3fea4b4599c6fc22856f02353`
  `docs/screenshots/fab-done.png` `f3c73094c4ea09c96884991b5ae0248b`
  `docs/screenshots/fab-idle-1.png` `28043676b9a6086d267648c75dc9ee33`
  `docs/screenshots/fab-idle-2.png` `48ab4b13a0dbd5061ebb1238422c7444`
  `docs/screenshots/fab-running.png` `17efd4ab12a948d6ff0492d525e99c6b`
  `docs/screenshots/history.png` `d89bfde07f90548ad00a49dbe920181a`
  `docs/screenshots/overview.png` `6ba0684ec70bfabf3af13440e59be7a5`
  `docs/screenshots/popup-agents-squads.png` `43994906eb5bc31018eff73ff5226812`
  `docs/screenshots/popup-running.png` `5435027f217509c88f9efd843a54682c`
  `docs/screenshots/popup-settings.png` `10697535447b3d3a5a27ac5bda5a385b`
  `docs/screenshots/squads.png` `acb125e19badaa3d37ef97c5eeac36e4`
  `index.js` `32dac461bbedf1784b4047629d0b3c41`
  `kiligzzz-dsh-agent-dispatch-1.11.21.tgz` `abee2cabce1248a9f857c7ed19852296`
  `kiligzzz-dsh-agent-dispatch-1.11.22.tgz` `962754751a70c7c375cce68265488a37`
  `kiligzzz-dsh-agent-dispatch-1.11.23.tgz` `609fb395e941ff25e317ce89c1d30d5d`
  `kiligzzz-dsh-agent-dispatch-1.11.24.tgz` `22e7e7fadfe7fc383b06ac92e9b40d7b`
  `lib/agents.js` `cc09bf96e6ad363e18b3ee85e10dd509`
  `lib/client.js` `6078d0815f36cd495bf2804fbb04417e`
  `lib/defaults.js` `f29387cda5012a199e9678e17390d81a`
  `lib/dispatch.js` `c415c59b661e437a666a1606dd23a7db`
  `lib/fab-config.js` `e68aaf76cf31904164b3e7ee97ef842b`
  `lib/health.js` `7a2d06235e40a61facf742ff8dd8e82a`
  `lib/host-approval.js` `7026ed8c0c629d52152894cd5e7f9079`
  `lib/json-safe.js` `cb39c2aeb84952a416aa8ae02c9cd43b`
  `lib/roster.js` `d9ee0131ac9ad2be8ef3e1c4485ca771`
  `lib/skill-import.js` `05fbcecfdcd795d5f0921de159f6e345`
  `lib/squad-registry.js` `16efbdc7adbbc655a80aa40766b6d4d4`
  `lib/squads.js` `03cd42b9a961d4b17e5cd40601756ffb`
  `package.json` `e1bd0bb661aa5ad0c1a84a978234bb36`
  `test-p1p2-smoke.mjs` `bb9b72c42f1509e63186153f199a6f31`
  `test/acp-config-fallback.test.js` `3961d7af0d3e310db4740a0f9c037c48`
  `test/acp-twin.test.js` `e7bc1a55cb9331e668963525faf4a55e`
  `test/agent-api-catalog.test.js` `4e8d5c3f8c62e91a6e40f6a9ec93117f`
  `test/agent-api-harness.js` `7b48c19983cc6244cd44bfd8e448a178`
  `test/childid-continuation.test.js` `b1ec780a6529fd841dfd27154ecf0916`
  `test/client-form-logic.test.js` `109e524ef93378bbf0c9b791b963ddc5`
  `test/dangerous-command-gate.test.js` `276e4e9f2a17371c7c5fea7e43c5c2a0`
  `test/dedup.test.js` `e93881ba9677de3351c54a29a9ebc243`
  `test/fab-panel-layout.test.js` `378f9de86246e67bf01fa02fb3034882`
  `test/failover-claim-race.test.js` `735e23e878a2f1e191a766a3aea2570f`
  `test/failover-notify.test.js` `542597bd87c1cedde09bbe7a3d8fb2f0`
  `test/failover-settlement.test.js` `c23fe799487e6bde3d198c04a40ca047`
  `test/failover.test.js` `07030770e5af9067f538a0c4ab99feff`
  `test/grant-dialog.test.js` `9c602287549e6042fa52c11a10d1184e`
  `test/helpers/failover-host.js` `f725f9052a4b54cd66c171d6338048c0`
  `test/host-0.2-compat.test.js` `e2d46d0cebf92864d746434997a9be04`
  `test/host-approval-endpoint.test.js` `013bddf8f80f5bb0d9e91ad50d5838e9`
  `test/host-approval.test.js` `72779f38918a1e163406884105d334c9`
  `test/interrupt-no-failover.test.js` `bef2189f6bcd2a817f05b7556b744fec`
  `test/invariants-1-12-6.test.js` `4c30eab81d893985e1f1dc1bc829a734`
  `test/perm-fab-jump.test.js` `ceb1e12feae9a0b23efecbbc17f0c412`
  `test/permission-pending.test.js` `83dc18eb17551f07b1dcaf47c04e3039`
  `test/plugin-diagnostic-log.test.js` `cda1a98981d674b32111ca808765a77b`
  `test/roster-section.test.js` `1553c426468cd1b82ad425a6f7a542f0`
  `test/route-validation.test.js` `5d0497e815613ced7611d9db07911687`
  `test/session-source-v4.test.js` `87156b4abd7dbe3f9f336da6b288daea`
  `test/tool-grant-session.test.js` `a841561b509b16fde275beeef328ed55`
  `verify.mjs` `345e3e8fb876f443f9c9c5ddc060ac49`
```
