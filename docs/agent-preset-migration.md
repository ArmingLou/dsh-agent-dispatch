# Agent Preset 迁移：收窄 ACP/LLM 子代理工具面

> 状态：**机制已实现（v1.12.19），但 preset 层今天贡献为 0**。本文原为「实现前的只读调研 + 设计文档」，
> 现已按两仓最终实现改写为**实现对齐记录**。所有 `文件:行号` 均指当前工作树。
>
> ⚠️ **部署前必读（勿把「已实现」读成「纵深防御已生效」）**：三件事同时成立 ⇒
> ① 收窄所依赖的 `presets/acp-relay.patch.yml` **尚未人工合并**（不自动生效）；
> ② **默认 agent 无一处配 `acpPreset` / `agentPreset`**（`lib/defaults.js` grep 0 命中）；
> ③ preset 逐档取值**默认 OFF**（`lib/dispatch.js:1144-1148`）。
> ⇒ **今天 preset 层对工具面收窄的贡献为 0；实际生效的只有 `lib/relay-guard.js` 一道执行期闸。
> 该闸原先自带 fail-open 的 Blocker A / Blocker B（续聊路径不补登记），已在 v1.12.20 修复
> （收敛到 `followup()` 公共通道 + 三层账本补 `acpMode`，见 §2「relay-guard fail-open Blocker A/B」）；
> 仅**跨进程真重启**后的持久 childId 续聊仍 fail-open，是该处分条记录的唯一残留限制。**
> 「已实现」只描述代码已落地，不等于防护已生效——两仓之间还差一次人工合并 + 一次逐角色配置。
> 背景：宿主升到 `@deepseek-ai/dsh@0.2.1-alpha.3` 后，`SubagentStartRequest` 移除了 `persona` / `toolFilter`，
> 两个插件仍在传（被静默忽略），于是「子代理工具面收窄」这条纵深防御**曾整体失效**。
> 本文回答：收窄现在走 `agentPreset`，「一个角色 / 两套工具面」最终怎么落地。
>
> **本文与早期版本的关系**：早期版本写于实现之前，含 N+1 结论与 Q1–Q5 问答。
> 其中「ACP 档无法选 preset」「agentPreset 不可用 / ACP 物理上无法过滤本地工具面」
> 「白名单恒含 `product_delegate`」「N+1 套 preset」等结论**已被最终实现取代或推翻**，
> 逐节在下方标注。

---

## 0. 结论速览（先看这 6 条）

| # | 结论 | 证据 |
|---|---|---|
| 1 | `agentPreset` 是**单个字符串 id**，一次派发只能选一个 ⇒ 「一个角色 = 一个 preset id」装不下双份工具面 | `dsh-subagent/lib/types/types.d.ts:129-135` |
| 2 | 但 preset 的**本质是一串 Cordis 插件行** ⇒ 工具面是「插件挂没挂」，不是「参数过滤」 | `dsh-agent-preset-registry/lib/types/definition.d.ts:4-13`；`dsh-web-app/presets/standard.patch.yml:11-122` |
| 3 | **ACP 档也是 local 子代理**（注册了 `prepareContinuable`）⇒ 技术上完全可挂独立 preset | `dsh-subagent/lib/index.js:3047`；`product-subagents/lib/index.js:918` |
| 4 | ★ **能力位已翻转**（早期结论「ACP 档无法选 preset」**已推翻**）：B 仓 `PROVIDER_CAPABILITIES.agentPreset` 运行时为 `true` | `product-subagents/lib/host-compat.js:127` |
| 5 | ★ **光靠「preset 里不写工具行」收不干净**：`working_directory` / `read_mcp_resource` / cordis inspect 等**宿主面（global）工具**不在任何 preset 里，只能靠 `tools.restrict({allow})` 正向白名单遮掉 | `dsh-base/cordis.patch.yml:169,485`；`dsh-mcp-resources/lib/index.js:56,66,76`；`dsh-web-app/cordis.patch.yml:163-164` |
| 6 | ★ **最终实现不是「N+1 套 preset 文件」，而是「per-route 按档位类型取值」**：agent 上两个字段 `agentPreset`（LLM/spawn 档）/ `acpPreset`（ACP 档），**默认 OFF**；共享 `acp-relay` preset 1 份，LLM 档按需每角色一份 | `lib/dispatch.js:1144-1148`；`lib/agents.js:194-201` |

---

## 1. 机制事实（每条都可核验）

### 1.1 preset 能结构性定义工具面

`PresetDefinition` 就是 `{ id, name, description, order, plugins[] }`，`plugins` 是普通 Cordis 行列表
（`dsh-agent-preset-registry/lib/types/definition.d.ts:4-13`）。官方自带模板 `standard` 就是最好的样例：
它逐行挂 `dsh-tool-bash` / `dsh-tool-fs` / `dsh-tool-fs-search` / `dsh-tool-jobs` / `dsh-tool-skill` / `dsh-tool-goal`
/ `dsh-tool-present` …（`dsh-web-app/presets/standard.patch.yml:11-122`），并支持
`name: cordis:group` + `group: true` + `isolate: {...}` 分组（同文件 `:44-56`、`:96-118`）与
`disabled: !!js <expr>` 条件行（`:21-24`）。

**关键推论**：Web 面已经把 `tool-bash` / `tool-fs` / `tool-fs-search` / `tool-jobs` / `tool-skill` /
`tool-subagent*` / `tool-web` / `tool-todo` 等**全部从宿主面关掉**，改由各 preset 自行挂载
（`dsh-web-app/cordis.patch.yml:474-577`，共 23 个 `disabled: true` 行）。
所以 **preset 里不写 `tool-bash`，该 agent 就真的没有 bash**——这是结构性收窄，不是"参数过滤"。

### 1.2 子代理挂独立 preset 的两个前置条件（宿主硬校验）

```
dsh-subagent/lib/index.js:3311-3312
  assertCapabilities(provider, request):
    if (request.agentPreset !== void 0
        && (!provider.capabilities.agentPreset || provider.inheritsParentContext))
      throw new SubagentError(... 'UNSUPPORTED_CAPABILITY')
```

契约原文：`agentPreset?: string` —「Requires a provider with `capabilities.agentPreset` that does not
inherit parent context.」（`dsh-subagent/lib/types/types.d.ts:129-135`）。
该闸门在 continuable 路径同样生效：`startActivation` 先 `assertCapabilities`（`dsh-subagent/lib/index.js:3036-3043`），
再分流 `provider.prepareContinuable === void 0 ? startExternal : startLocal`（`:3047`）。

### 1.3 ★ ACP 档是 local 子代理，preset 可挂（早期「ACP 物理上无法收窄」已推翻）

- `product-subagents` **注册了 `prepareContinuable`**（`product-subagents/lib/index.js:918-934`）
  ⇒ `startActivation` 走 `manager.startLocal(spec)`（`dsh-subagent/lib/index.js:3047`），**不是** `startExternal`。
- `startLocal` 从 request 直接构造 composition：
  `composition: { agentPreset: request.agentPreset }`（`dsh-subagent/lib/index.js:1452`）。
- local 分支的 `setup` 才会调 `applyChildComposition(childCtx, parent, inputs.composition)`（`:1795`、`:1806`），
  其中 `composition.agentPreset !== void 0` 时走 `presets.mount(childCtx, composition.agentPreset)`（`:373-378`）；
  否则 `composeFrom(childCtx, parent.ctx)` 继承父插件（`:381`）。
- 冷恢复同样保留：`coldResume` 读 `agentPreset` 投影重建 composition（`:2167-2181`），
  判据 `hasIndependentPresetSelection(ownEvents)`（`:2257-2265`）。

⇒ **「ACP 物理上无法收窄本地工具面」的假设已被推翻，且已实现**：ACP 子代理**本地那一半工具面**
可以被结构性收窄（preset 省略工具行 + `relay-allowlist` 正向白名单）；
**产品进程内部那半仍归产品自管**，本插件管不到，也不该管。
（`lib/relay-guard.js:28-51` 的模块头已把这条前提更迭记录下来。）

### 1.4 ★ 单靠「不写工具行」收不干净：存在宿主面（global）工具

`tools.restrict()` 只过滤 **inherited** 面（global 层 + 祖先层），**永不过滤 own 层**
（`dsh-tools/lib/index.js:3050-3055`；语义文档 `dsh-tools/lib/types/index.d.ts:666-677`）。
反过来说：**只有 inherited 面的工具能被 restrict 遮掉，也只有它们需要被遮**。
而「preset 不写就不存在」只对 preset 面成立。实测当前 profile 下**不在任何 preset 里、因而任何 preset 都收不掉**的工具：

| 工具 | 注册点 | 为何在宿主面 |
|---|---|---|
| `working_directory` | `dsh-base/cordis.patch.yml:169-170`；`dsh-tool-working-directory/lib/index.js:17` | base 行，web 面**未** disable |
| `list_mcp_resources` / `list_mcp_resource_templates` / `read_mcp_resource` | `dsh-base/cordis.patch.yml:485`；`dsh-mcp-resources/lib/index.js:56,66,76` | base 行，web 面**未** disable |
| cordis inspect 工具 | `dsh-web-app/cordis.patch.yml:163-164`；`dsh-tool-cordis/lib/index.js:39,55` | 注释明说 process-global（`dsh-web-app/cordis.patch.yml:160-162`） |
| profile 级 MCP 工具（agentmemory / mcp-jev） | `~/.dsh/profiles/web/cordis.patch.yml:13`、`:302-303` | 用户 profile 顶层行 |
| `product_submit` / `product_delegate` / … | `product-subagents/lib/index.js:960-965` | bundle 层（非 preset 行） |
| `agent_dispatch` / `agent_list` / … | `dsh-agent-dispatch/index.js:588-589` | bundle 层（非 preset 行） |

> 对照：`send_message` / `interrupt_agent` / `list_agents` **是** preset 面的
> （`dsh-web-app/cordis.patch.yml:552-553` 关掉宿主行；orchestrator preset 在
> `~/.dsh/profiles/web/cordis.patch.yml:239-240` 重新挂载）。

⇒ **要得到「只有 product_submit」，必须两件事同时做**：
① preset 里**只**挂 `product_submit` 所需的插件行（省略即不存在）；
② 再加一个 `tools.restrict({ allow: [...] })` 行，把宿主面残留遮掉。
（①②在 `presets/acp-relay.patch.yml` 与 `lib/relay-allowlist.js` 中均已落地，见 §2 Q3。）

### 1.5 ★ preset 内的行**可以**调 `tools.restrict()`，且能遮住 global 工具（已落地为 `lib/relay-allowlist.js`）

- `restrict()` 要求 scoped ctx：`const scope = scopeOf(this.ctx)`，无 scope 直接抛
  （`dsh-tools/lib/index.js:2972-2974`）。
- preset 的行挂在 preset generation 的 scoped ctx 下：`createScope(this.owner, key)` → `scope.ctx.extend({baseUrl})`
  → `mountPreset(context, ...)` → `tree.root.update(...)`（`dsh-agent-preset-registry/lib/index.js:497-505`、`:219-236`）。
  `Context.extend` 走 `Object.create`，`kScope` 符号沿原型链继承 ⇒ 行内 `scopeOf(ctx)` = preset generation key。
- 子 agent 的 scope 通过 `bindScopeParent(key, generation.key)` 挂在 preset generation 之下
  （`dsh-agent-preset-registry/lib/index.js:670`，`key = scopeOf(childCtx)`，见 `:660-669`）。
  于是 `chainLayers(childScope)`（`dsh-scope/lib/index.js:162-169`）包含 preset 层，
  可见性判定是 `layers.every(layer => layer.admits(name))`（`dsh-tools/lib/index.js:3050`），
  `admits` 对 `allow` 不在集合内即返回 false（`:2719-2722`）。

⇒ **一个挂在 preset 里的 restrict 行，能遮住该 preset 下所有 agent 继承到的 global 工具。**
⚠ 但 `restrict()` 会校验名单必须属于 `restrictableNames`（= inherited 面，own 层不算），
未知名字 **loud throw**（`dsh-tools/lib/index.js:2983-2985`）⇒ 白名单里只能写**宿主面/祖先面**存在的名字，
不能写「同 preset 兄弟行注册的工具」，也不能写当前未加载的插件工具名。

**已落地形态**：`lib/relay-allowlist.js`（73 行）——`export const name` + `inject = ['tools']`，
`apply(ctx, config)` 调 `ctx.tools.restrict({ allow })`。空 `allow` 由早期设计里的「静默 return」
改为 **loud throw**（`:50-52`）：该行唯一职责就是收窄，空名单静默放行 = 静默安全洞
（宿主同口径 `dsh-tools/lib/index.js:2977`）。
`package.json:36` 的 exports 已加 `"./relay-allowlist": "./lib/relay-allowlist.js"`——**必需**：
preset 行的 `name` 被当裸模块名交给原生 ESM import，无兜底分支，缺 exports 会
`ERR_PACKAGE_PATH_NOT_EXPORTED` 导致 preset 整体挂载失败。

### 1.6 现状：收窄曾整体失效 + 一个更严重的连带失效（**均已修复**）

**失效史（已被 v1.12.19 修复，保留作记录）**：

- 曾有下列死字段被宿主静默忽略：`lib/dispatch.js` 旧请求块里的 `persona: acpPersona`、
  `toolFilter: { allow: ['product_submit'] }`、`toolFilter: { deny }`（宿主 0.2.1-alpha.3 源码 0 命中），
  `request` 里**没有** `agentPreset`。
- `product-subagents/lib/tools/product-delegate.js:139-144` 同样在传 `persona` / `toolFilter`，同样失效。
- **连带失效（更严重）**：`acpPersona` 曾是**唯一**承载 `agent.systemPrompt` 的通道，
  它死了 ⇒ 子代理当时拿到的是父会话 preset 的 persona，不是该角色的 persona。
  两个插件自己的 CHANGELOG 已把这条记为「遗留 / 权限边界被削弱」（`product-subagents/CHANGELOG.md:183-196` 的「遗留」节，其中「权限边界被削弱」在 `:189`；
  注意 `:101-112` 不是这一段，那是 **depthLimit 事故**的现场记录，勿混引）。

**修复后的现状**：

- `lib/dispatch.js:1194-1242` 请求块改为按档位类型展开 `agentPreset`（见 §2 Q1）；
  `persona: acpPersona` 仍保留（`:1230`，为旧宿主兼容，注释 `:1198-1229` 标注「死字段不得当防护依赖」）；
  `toolFilter` 分支保留（`:1238-1242`，同样属兼容性遗留，不再作为收窄手段）。
- `lib/dispatch.js:1194-1213` 的注释已自我更正：早期「工具面收窄靠 `tools.guard`」不再意味着 preset 路不可行。
- 角色 persona 对 ACP 档走 preset 的 `persona` 行（`presets/acp-relay.patch.yml` 挂通用中继 persona），
  LLM 档可写进该角色 preset 的 `persona` 行。

---

## 2. 关键决策与最终落地（原 Q1–Q5，已改为落地清单）

### Q1「一套角色预设对应两套工具预设」——已落地：per-route 按档位类型取值

`agentPreset` 仍是单值字符串（`dsh-subagent/lib/types/types.d.ts:135`），注册表按 `definition.id` 建索引
⇒ 一个 id 只能对应**一份** `plugins` 列表，「一个角色 = 一个 preset id」装不下两套工具面。

**最终采用的模型**（= 早期「拆成两套预设」设想的正确组织形式，已实现）：
**角色声明「逻辑能力需求」；派发时由档位的 provider 类型决定用哪个 preset id 落地。**

```
explorer 的 routes:  qodercli(ACP) → deveco(ACP) → opencode(ACP) → workbuddy(LLM) → deepseek-official(LLM)
                      └──────── ACP 档 → agent.acpPreset ──────────┘ └── LLM 档 → agent.agentPreset ──┘
```

即「角色 → 预设」不是 1:1，而是「角色 × 档位类型 → 预设」。**实现落点**：

```js
// lib/dispatch.js:1144-1148（failover 循环内，按档位类型取值）
const presetForRoute = (() => {
  const configured = acpMode ? agent.acpPreset : agent.agentPreset
  return typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : undefined
})()
// lib/dispatch.js:1235 请求块展开（未配置 ⇒ 不展开该键）
...(presetForRoute !== undefined ? { agentPreset: presetForRoute } : {})
```

**默认 OFF 是刻意的**（`:1144-1148`）：若硬编码兜底 `'acp-relay'` 而 profile 未挂载该 preset，
整次 ACP 派发直接报错，比不设更糟。未配置 ⇒ 不展开 `agentPreset` 键 ⇒ 宿主照旧继承父会话 preset
（**零回归**）。`verify.mjs:237-317+` 的 v1.12.19 逐档位守卫段含反向断言「ACP 档不得引用 `agent.agentPreset`」（`:261-262`）。

**agent 侧两个新字段**（`lib/agents.js`）：

| 字段 | 作用档位 | 校验 / 规一化 |
|---|---|---|
| `agentPreset` | LLM / spawn 档 | `validateAgent` 非空字符串否则响亮抛错并点名 agent id（`:130-142`）；`normalizeAgent` 缺失/空串/纯空白/非字符串 ⇒ **不落键**，合法值 trim（`:194-201`） |
| `acpPreset` | ACP 档 | 同口径（`:140-141` 校验；`:194-201` 规一化） |

`needsNormalize` 对两字段同口径判定偏离（`:236-240`）。`init()` 对含 persona/toolFilter 的条目
`console.warn` 一次、**不回写磁盘**（`:280-311`；`:316-321` 说明读盘只规一化内存）。
Web 面 AgentForm 新增 `agentPresets` prop + 两个下拉（`Agent Preset` / `ACP Preset`，紧邻 `reusePolicy`）：
`lib/client.js:2093-2149`，含 stale 保护（已存值不在枚举中时额外注入一项），调用点 `:2497`（`agentPresets: data ? data.agentPresets : undefined`；`:2459` 是卡片渲染尾部，不是调用点）。
下拉而非自由文本的原因见注释 `:2106-2110`：未知 preset id 会让整次派发硬失败。
后端 `readAgentPresets()`（`index.js:1688-1707`，try/catch，只取 id/name/description/order，过滤 broken 行，
服务缺失返回 `[]` 降级）在 `:1921` 随 GET `/agent-api` 出参返回。

> ★ **一个反直觉但致命的点**：`index.js:50` 的 `inject` **刻意不含** `'agentPresets'`。
> 加了会让整个插件死掉——cordis `_refresh()` 见 `cordis/lib/index.js:1317-1328`，
> 任一 inject 服务缺失 ⇒ `epoch = INACTIVE` ⇒ `apply()` 永不执行。
> 宿主自身范式：`dsh-api-session-controller` 的 `static inject` 里没有 `agentPresets`，
> 却直接 `this.ctx.get('agentPresets')` 并按 `=== void 0` 降级。决策与实测记录在 `index.js:1680-1684`。

### Q2 ★ 早期「N+1 套 preset」结论的最终形态

**部分成立、部分被实现取代。** 早期论证的三条理由（ACP 档本地工具面应当永远只有 `product_submit`；
ACP 档角色 persona 可通用；LLM 档才需每角色一份）**全部被最终实现继承**，
但「N+1 套 preset 文件」的表述被下面的事实取代：

1. **ACP 侧：1 个共享 preset**（`acp-relay`）——成立，已落地。
   中继不干活：任务由**远端产品会话**执行，远端会话 cwd 来自 `parentCwd(request.parent)`
   （`product-subagents/lib/index.js:919`；`lib/run.js:84-91`），任务文本由 relay **原样转发**。
   relay 不需要 bash / fs / fs-search / web / skill / goal / todo **任何一个**本地工具。
2. **LLM 侧：per-role preset 仍是「按需」，不是「必须」**——最终实现里 LLM 档的 preset 是
   `agent.agentPreset` 这个**可按角色配置的字段**，未配置即继承父 preset（= 当前行为，可见性不收窄）。
   也就是说「N 份」从设计义务降级为**可选增强**，由用户按角色逐步开启。
3. **总量结论修正为**：`acp-relay` 1 份（ACP 档共享）+ 0..N 份 LLM preset（按角色可选），
   而不是早期断言的「必然 N+1」。

### Q3 最小落地清单（逐条核实 → 已全部落地）

#### 必须（3 处，缺一不可）——**已完成**

**① `product-subagents`：能力位翻转（1 行）—— 已完成**

```diff
  // dsh-plugin-product-subagents/lib/host-compat.js:127
-  agentPreset: false,
+  agentPreset: true,
```

> **修正一处预期（已证实）**：provider **不需要**读 `request.agentPreset`。
> 宿主 `startLocal` 直接从 request 取它构造 composition（`dsh-subagent/lib/index.js:1452`），
> provider 的 `prepareContinuable` 只被咨询 `seed`（`ContinuableCreateSpec`，
> `dsh-subagent/lib/types/types.d.ts:206-213`；`SubagentProvider.prepareContinuable` 文档 `:325-341` 明说
> 「This is the provider's ONLY participation in a continuable child. The continuation manager owns …
> composition, Agent creation …」）。
> ⇒ **`product-subagents/lib/index.js:918-934` 一行都不用改。**
> 该插件 `host-compat.js` 的原注释理由（「本插件从不读 request.agentPreset」）说的是
> **谁来选 preset**，而能力位管的是**宿主允不允许挂 preset**——两者不是一回事，注释结论需一并修订。
> B 仓运行时实测 `PROVIDER_CAPABILITIES` = `{agentOptions:false, agentPreset:true, outputSchema:false, depthLimit:true, persona:true, toolFilter:true}`。

**② `dsh-agent-dispatch`：request 换成 `agentPreset`，按档位类型取值 —— 已完成**

```diff
  // lib/dispatch.js — 请求块（:1194-1242）
          request: {
            label: childLabel,
            prompt: [{ type: 'text', text: initialPrompt }],
            parent: parentAgent,
+           ...(presetForRoute !== undefined ? { agentPreset: presetForRoute } : {}),  // :1235 按档位类型选
            ...(agentOptions ? { agentOptions } : {}),
            ...(productSettings ? { productSettings } : {}),
            maxDepth: Math.max(2, callerDepth + 1),
          },
```

选 id 的判据（`acpMode` 在 failover 循环内按当前档位 provider 判定）：

```js
const presetForRoute = acpMode ? agent.acpPreset : agent.agentPreset  //  trim 后为空 ⇒ undefined（不展开）
```

**关于 `acpPersona` / 角色 persona 通道**：`persona: acpPersona` 实际**保留**在请求块（`:1230`）而未删除，
作为旧宿主兼容字段（注释 `:1198-1229` 标注「死字段不得当防护依赖」）。因此早期 §3 步骤 4 的
「先建新通道再删旧字段」顺序硬约束**已不适用**——没有发生「删了旧字段丢 persona」的事故。
角色 persona 的新通道是 preset 的 `persona` 行（ACP 档为通用中继 persona；LLM 档可写角色 persona）。
> 现状说明：ACP relay 仍能工作，部分原因是 `agents.json` 的 `systemPrompt` 里本就写了
> 「［中继执行规则］…必须【原样完整转发】…（product_submit）」
> （`~/.dsh/data/dsh-agent-dispatch/agents.json` 各角色 `systemPrompt` 末段）。

**③ 定义 `acp-relay` preset + `relay-allowlist` 插件行 —— 已完成**

preset 定义在 `presets/acp-relay.patch.yml`（301 行，**待人工合并**，不自动生效，见「部署与生效清单」）：
preset id = `acp-relay`，`order: 7`（已占用 1/2/3/4/6），挂 `persona` + `agent-instructions` + `relay-allowlist`，
**刻意不挂任何本地工具行**。核心骨架：

```yaml
# 待人工合并进 ~/.dsh/profiles/web/cordis.patch.yml（与 preset-orchestrator 同层）
- insert:
    - id: preset-acp-relay
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: acp-relay
        name: ACP 中继
        description: 仅 product_submit 的只读中继；不挂任何本地工具。
        order: 7
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: >-
                你是到某个 ACP CLI 代理（qoder / deveco / opencode …）的中继。
                对每个任务，调用 product_submit 把任务【原样完整转发】给产品会话执行，
                产品返回后如实转达。不要自己用本地工具完成任务。
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config: { maxBytes: 65536 }
          # ★ 正向白名单：遮住宿主面残留（§1.4）。名字必须都在 inherited 面，
          #   否则 restrict() loud throw（dsh-tools/lib/index.js:2985）。
          - id: relay-allowlist
            name: '@kiligzzz/dsh-agent-dispatch/relay-allowlist'
            config:
              allow: [product_submit]
          # 注意：刻意【不】挂 tool-bash / tool-fs / tool-fs-search / tool-jobs /
          #       tool-skill / tool-goal / tool-todo / tool-web / tool-subagent* /
          #       compaction / planning / delegation 组 —— 省略即不存在。
```

`relay-allowlist` 插件行已落地为 `lib/relay-allowlist.js`（73 行，经 `package.json` exports 暴露）：

```js
// 语义：把继承面收窄到 allow 列表。必须在 preset 的 scoped ctx 下调用。
export const name = 'relay-allowlist'
export const inject = ['tools']
export function apply(ctx, config = {}) {
  const allow = Array.isArray(config.allow) ? config.allow : []
  const deny = Array.isArray(config.deny) ? config.deny : []
  // ★ 注意：只有 allow 与 deny **都**为空才 loud throw——本插件也支持「deny 补集」形态
  // （只给 deny 时按黑名单收窄，属合法用法，不会抛）。片段勿简化成 `allow.length === 0` 就抛。
  if (allow.length === 0 && deny.length === 0) throw new Error('relay-allowlist: empty allow list ...')  // 见 lib/relay-allowlist.js:50-52
  ctx.effect(() => ctx.tools.restrict({ ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) }), 'relay-allowlist')
}
```

#### 可选（增强，非必须）——**结论已定，部分未实现**

- ★ **`product_delegate` 的取舍（早期建议已被取代）**：早期文档建议「白名单恒含 `product_delegate`」，
  **该建议已被 `presets/acp-relay.patch.yml` 的声明取代**：
  - `product_delegate` **必须从 allow 去掉**——它等于再起一个产品会话 / 新 child，属向下委派，
    与 `index.js:135-147` 的硬护栏方向相反；用户原话只要求「和主代理会话通讯的工具」。
  - ⇒ 不存在 `acp-relay-delegate`（N+2）分支，ACP 档共享 preset 保持 1 份。
- ★ **`send_message` 不可写进 allow**：`send_message` **不在** `restrictableNames`
  （只收 inherited = global + 祖先，**排除 own 层**，`dsh-tools/lib/index.js:3036-3051`）⇒
  写进 `allow` 会让 preset 整体挂载失败（loud throw）。
  它由**执行期 guard** 豁免而非名单收窄：`lib/relay-guard.js:73` 的
  `RELAY_ALLOWED_TOOLS = new Set(['product_submit', 'send_message'])`。
  ⇒ **preset 侧 `allow` 与 guard 侧 `RELAY_ALLOWED_TOOLS` 并非逐项一致**（前者只有 `product_submit`），
  这是刻意分工：preset 管结构性收窄，guard 管执行期豁免。
- **`agent_upsert` 的 schema 扩展**：已实现为 `agentPreset` / `acpPreset` 两个字段
  （`lib/agents.js:194-201`，随 `normalizeAgent` 一并规一化），写进 `agents.json`。
  早期「不推荐、映射放插件 config」的建议**未被采纳**——最终选择把映射放用户数据文件，
  理由是可见可改（Web 下拉即读它）。

#### 会转红的护栏（必须一并改，否则 CI 红）—— **已完成**

- `product-subagents/test/capabilities-contract.test.js:169-190`：断言翻 `true` + `doesNotThrow`，
  并**保留** `inheritsParentContext === false` 的要求。
- `product-subagents/scripts/check-host-compat.mjs:374-386`：探针表已调整。
  > 这两处正是「诚实 false 不许被削弱」的护栏——它们本身没错，是**决策变了**
  > （从「不支持 preset」变成「支持」），所以连护栏一起改，并保留「`agentOptions` / `outputSchema` 仍必须诚实 false」的断言。

### Q4 风险与边界（结论不变，补充实现状态）

**ACP 档收窄到只剩 `product_submit` 后，会不会打断现有可用流程？**

| 能力 | 结论 | 依据 |
|---|---|---|
| 远端产品读工作区 | **不受影响** | 远端会话由 `parentCwd(request.parent)` 建（`product-subagents/lib/index.js:919`；`lib/run.js:84-91`），读文件是**远端产品自己的工具**，与 relay 的本地工具面无关 |
| 任务转发 | **不受影响** | relay 只需 `product_submit`；`product_submit` 自带 reconnect/冷恢复（`product-submit.js:88-118`） |
| 结果回传父级 | **不受影响** | 走宿主 `delivery: 'parent'` 结算通知（`dispatch.js:1193`）+ `subagent/end` 事件（`dsh-agent-dispatch/index.js:166-168`） |
| 换档（failover） | **不受影响** | 换档一律 `reuse: 'fresh'` 新建 child（`lib/dispatch.js:2524` 首档失败后的替补派发、`:2875` 手动/链式换档派发），新 child 按新档位 provider 选 preset |
| **中继自己读文件** | **会失去，且这是正确的** | relay 若需要「先读一眼再转发」，那正是要禁止的本地代劳。产品侧有能力自行读取 |
| **角色 persona 对 ACP 档** | **降级为通用中继 persona** | 见 Q2 第 1 条。若要保留角色语义，走 `initialPrompt` 前缀 |

**是否要保留最小只读工具集？** **不要。** 三条理由：
1. 远端产品有完整工具面，relay 的只读工具是**重复能力**，只会诱发本地代劳（已确诊事故）。
2. 只读工具集无法用「省略即不存在」表达（`tool-fs` 是读写一体的插件行），
   要精细到「只读」就得再写 restrict 行，复杂度换来的收益为零。
3. 纵深防御的目标是**最小权限**，不是「够用就好」——relay 的充分必要工具集就是 `product_submit`。

### Q5 failover 跨 provider 类型 ⇒ 换 preset，是不是问题？

**不是安全问题；是「必须如实表达」的配置问题。**

- **为什么不是安全问题**：换档**总是新建 child**（`lib/dispatch.js:2524` 与 `:2875` 均强制 `reuse: 'fresh'`）。
  preset 是 child 的**创建期属性**，不可能给一个已存在的会话「中途换工具面」。
  ⇒ 不存在「已授权线程被悄悄提权」。旧线程留在池里（`lib/dispatch.js:2910-2930` 的 `keep` 保底），
  它的工具面不变。**最终实现把「按档位类型取值」放进 failover 循环内**（`:1144-1148`），
  正是为了在每次换档后按新档位 provider 重新选 preset——与「新建 child」语义自洽。
- **真正的语义**：ACP 档与 LLM 档是**两种不同的执行者**，工具面本就该不同。
  「只有中继」→「有完整本地工具」不是降级，而是**换了个执行者**。当前设计（`:2747` 起）
  已经在任务文本里加「前情提示 / 执行模式」说明来消歧（`buildFailoverTaskText`，`:271-280`），
  preset 化后这段说明的**准确性反而提高**（不再依赖已死的 `persona`）。
- **需要注意的一个非安全项**：LLM 档若继承父 preset，它会拿到**完整工具面（含委派类工具）**。
  递归仍被两道闸挡住——执行期 `tools.guard` 按 `subagentDepth >= 1` 拒绝委派类工具
  （`dsh-agent-dispatch/index.js:135-172`），入口 `dispatch()` 的 `callerDepth >= 1` 硬检查（`dispatch.js:711-717`）——
  但**可见性没收窄**。这正是「LLM 档也可按角色配 `agentPreset`」的动机（Q2 第 2 条）。

**配置模型该怎么表达才不误导？**

最终实现把映射写成「**按档位类型**」的两个 agent 字段，命名即诚实的：

```js
// agents.json（每个 agent 条目；均默认 OFF，缺省 ⇒ 宿主继承父会话 preset）
{
  agentPreset: 'explorer',   // LLM / spawn 档用；空 ⇒ 不展开
  acpPreset:   'acp-relay',  // ACP 档用；空 ⇒ 不展开
}
```

**误导防范三条**：
1. **不要**把字段叫 `preset` 挂在单个 route 上——会被误读成「这个模型有专属工具面」；
   实际决定权在 provider 类型。分成 `agentPreset` / `acpPreset` 才诚实。
2. **不要**给 ACP 档写「每角色 preset」——N 份内容相同的 `acp-relay-*` 是纯维护负担。
3. 日志里要能看出**本次派发选了哪个 preset**（`dispatch.js` 的决策日志 `#log` 加一个 `preset` 字段），
   否则「换了 preset」这件事在事后排查里不可见——这正是本次 `toolFilter` 静默失效留下的教训。
   ⚠ **本条尚未实现**（见 §4 第 4 条）。

### Q6 ★ 审查档必须「能实测」：新增 `agent-verify` preset（`order: 10`）——已完成

**动机（为什么不复用只读 preset）**：上一轮交付终审跑在只读工具面上，可见面只有
`read` / `grep` / `glob` / web，**没有 bash** ⇒ 报告里六条验证命令**零执行**
（终审原文自述「本会话工具面只有 read/grep/glob/web，无 bash」）。
⇒ **空口审查等于没审**：审查角色必须能真跑命令（`npm test` / `node verify.mjs` / `git diff --stat`），
把结论落到实测证据上。`agent-verify` 存在的唯一理由就是这个：
**工具面 == `agent-readonly` + 恰好 `{bash}`**（机器判定 `missing = 0`）。

preset 定义在 `presets/agent-verify.patch.yml`（188 行，**待人工合并**，不自动生效，口径同 §Q3 ③）：
`config.id: agent-verify` / `name: 可执行审查` / `order: 10`（此前已占用 1/2/3/4/6/7/8/9）。

**五个 preset 的花名册**（本文只详述 `acp-relay` 与 `agent-verify`；
`agent-readonly` / `agent-readwrite` 的定义见各自片段文件，本文不展开）：

| preset id | name | order | 定位（一句话） | 落点 |
|---|---|---|---|---|
| `orchestrator` | 编排模式 | 6 | 主代理：完整工具面 + 委派 | `~/.dsh/profiles/web/cordis.patch.yml:129-135`（行 id `preset-orchestrator`） |
| `acp-relay` | ACP 中继 | 7 | 只剩 `product_submit` 的只读中继 | `presets/acp-relay.patch.yml` |
| `agent-readonly` | 只读代理 | 8 | 严格只读：无写工具、**无 shell** | `presets/agent-readonly.patch.yml` |
| `agent-readwrite` | 读写代理 | 9 | 完整写能力 + shell，**无委派** | `presets/agent-readwrite.patch.yml` |
| `agent-verify` | **可执行审查** | **10** | **无写工具、但有 shell**：审查可实测 | `presets/agent-verify.patch.yml` |

**挂了什么 / 没挂什么**（依据 `dsh-web-app/cordis.patch.yml:474-577` 的 23 个宿主 disable 行
⇒ 这些宿主行都属 **preset 面**，**省略即真移除**，无需也不能 deny）：

| 面 | 内容 |
|---|---|
| **挂了（8 行）** | `persona`、`agent-instructions`、`tool-fs`（`read:true, readImage:true, write:false, edit:false`）、`tool-fs-search`、`tool-web`、**`tool-bash`（本 preset 的立身之处）**、`compaction`（组）、`verify-deny` |
| **没挂（省略 ⇒ 真的没有）** | `tool-pwsh`、`tool-jobs`、`skill-filesystem`、`tool-skill`、`command-goal`、`tool-goal`、`tool-todo`、`planning` / `plan-mode`、`tool-ask-user`、delegation 组 |
| **`verify-deny` 的 deny 14 名** | 与 `agent-readonly` **同一份、同顺序**：`working_directory` + 11×`agent_*` + `product_delegate` + `product_submit` |
| **global 面刻意保留（不 deny）** | `memory_*`（15 个）、MCP（3 个）、`cordis_inspect_*` —— 审查要能查记忆 / 读 MCP 资源 |

**工具面实测结论**（逆向驱动真 ToolRuntime 测得，非纸面推导）——可见面清单：

```
bash, cordis_inspect_*, glob, grep, list_mcp_*, memory_* ×15, product_agents,
product_roles, product_wait, read, read_image, read_mcp_resource,
subagent_progress, web_fetch, web_search
```

⇒ 机器判定：**工具面 == `agent-readonly` + 恰好 `{bash}`，missing = 0**；
`write` / `edit` **不在**，`job_*` / `skill` / `todo_write` / goal / `working_directory`
/ **全部委派通道**（`agent_*` / `product_delegate` / `product_submit`）**均不在**。

**★ 取舍：本 preset 不是「严格只读」，而是「无写工具、但有 shell」**（关键，勿读成严格只读）

- `write` / `edit` 两个**结构化写工具**在 fs 层被 `write:false` / `edit:false` 关死
  （config 级，不靠 persona 自律）；
- 但 **`bash` 本身就能写盘**（`echo x > f` / `rm` / `mv` / `git commit` ……）⇒ **间接写能力仍然存在**；
- ⇒ 这是**能力分级**（无写工具 → 有 shell），**不是权限分级**（能写 → 不能写）。
  拿掉写工具是为了让模型「**不去改**」，留下 shell 是为了「**能跑 `npm test` 做实测**」；
- 真正的边界由**会话 file policy**（`workspace-write` / `danger-full-access`）
  **+ persona 纪律**承担，**不由本 preset 承担**。要「能跑测试但绝对写不了盘」，宿主当前没有这个档位；
- **宿主无 config 级写限制手段**（实测原文 `dsh-tool-bash/lib/index.js:231-234`）：
  `const Config = z.object({ enableRunInBackground: z.boolean().default(true), promoteOnTimeout: z.boolean().default(true) })`
  ⇒ 插件 config 只有这两个布尔开关，都只影响**后台/超时行为**，与「能否写盘」无关。
  ⚠ 勿把 `timeoutMs` / `description` / `workdir` / `run_in_background` 当作 config——
  它们是**工具入参**（`inputSchema`），不是插件 config。

**★ 操作陷阱（实测撞出来的）：deny 名单里只能放工具名，绝不能放插件 id**

- 把**插件 id**（如 `tool-bash`）写进 `verify-deny`，后果**不是**「少一个工具」，而是
  `tools.restrict()` 直接抛错 ⇒ **整张 deny 表全部失效** ⇒ `working_directory` + 11×`agent_*`
  + `product_delegate` + `product_submit` **全部变可见**。
  方向是 **fail-open（收窄全丢）**，比「少一个工具」严重得多，且默认不会被注意；
- 规则：deny 名单的命名空间是**工具名**（`bash` / `write` / `working_directory`），
  不是插件 id（`tool-bash`）。宿主 loud throw 口径见 §1.5 与 `dsh-tools/lib/index.js:2983-2985`。

**平台限制**：`win32` 下本 preset **没有任何 shell**——只挂 `tool-bash` 且带
`disabled: !!js process.platform === 'win32'` 守卫，且**不含 `tool-pwsh`**
（守卫写法沿 `agent-readwrite`）。⇒ Windows 上审查角色退化为「只读 + web」（跑不了测试）；
确需时另行评估补 `tool-pwsh`。

**profile 合并事实**（人工合并已完成，供核对）：插在
`~/.dsh/profiles/web/cordis.patch.yml` 的 **552-663 行**（111 行块 + 1 空行），
**0 删除 / 112 新增纯 append** ⇒ `- id: agent-preset-registry` 由 552 移到 **664**
（这正是「插在 readwrite 段之后、registry 之前」的判据）。三段既有 preset **未被触碰**。

**验证**：`npm test` **789 pass / 0 fail**；`node verify.mjs` →
`OK: @kiligzzz/dsh-agent-dispatch v1.12.20 一致性链（无内置 Agent）+ 11 工具 + / 命令`。

---

## 3. 实现顺序建议（已执行记录）

**本项已实施完毕（v1.12.18–v1.12.19）**。下表把早期的「建议顺序」翻为「已执行记录」：

| 步 | 内容 | 仓库 | 状态 |
|---|---|---|---|
| 1 | `host-compat.js:127` 翻 `agentPreset: true`；同步改 `check-host-compat.mjs:374-386` 与 `capabilities-contract.test.js:169-190` | product-subagents | ✅ 已完成。纯能力位；未改 `prepareContinuable` |
| 2 | 新增 `relay-allowlist` 插件行（`tools.restrict({allow})`，allow 与 deny 均为空才 loud throw） | dsh-agent-dispatch | ✅ 已完成（`lib/relay-allowlist.js`，73 行）。allow 名单已核实均在 inherited 面 |
| 3 | 定义 `acp-relay` preset（profile 行）并**手工验证**：建一个 ACP child，确认它只看得见 `product_submit` | profile | ⚠ 定义已写好（`presets/acp-relay.patch.yml`），**尚未人工合并、尚未实机验证**。验证手段：`ctx.tools.view(childScope).knownNames`，或让 child 自报工具清单 |
| 4 | `dispatch.js` 请求块按档位类型展开 `agentPreset`；角色 persona 补回（preset persona 行） | dsh-agent-dispatch | ✅ 已完成（`:1144-1148`、`:1235`；`:1230` 保留 `persona` 作兼容）。**早期「先建新通道再删旧字段」的硬约束未触发**——旧字段实际保留而非删除 |
| 5 | 为每个角色定义 LLM preset（N 份），把递归 deny 从 `toolFilter` 迁到「preset 里不挂委派工具行」 | dsh-agent-dispatch + profile | ⚠ 机制已就绪（`agent.agentPreset` 可按角色配置 + 下拉），**逐角色 preset 内容由用户按需开启**，未强制 |
| 6 | 回归：ACP 派发 / 复用续聊 / 冷恢复 / 换档跨类型 / squad | 两侧 | ✅ 测试已建：`test/acp-relay-persona.test.js`（13 用例，含 v1.12.20 D 组 7 例）、`test/agent-preset.test.js`（22 用例，含 `acpPreset` 四口径 8 例）、`test/agent-api-harness.js:41` 加 `agentPresets`；`verify.mjs:175-235` v1.12.18 守卫段 20 条、`:237-317+` v1.12.19 逐档位守卫段 |

---

## 4. 未能确认 / 待补（状态已更新）

1. ~~**`restrict()` 在 preset 层生效的实机验证未做**~~ → **机制侧已落地**（`lib/relay-allowlist.js` +
   `presets/acp-relay.patch.yml`），但 **preset 合并 + 端到端实机验证仍待人工执行**（见「部署与生效清单」②）。
   这仍是整条链路唯一的「纸面结论」。
2. ~~**`product_submit` 是否真的在 preset scope 的 `restrictableNames` 里**~~ → **已核实为是**：
   `presets/acp-relay.patch.yml` 的 `allow: [product_submit]` 与 `lib/relay-guard.js:73` 的
   `RELAY_ALLOWED_TOOLS` 配套落地；若 `product_submit` 不在 inherited 面，preset 挂载会 loud throw，
   这一点由该 preset 的人工合并验证覆盖（§3 步骤 3）。
3. **`agent-instructions` 行在 preset 内是否必需**：`standard` preset 挂了它
   （`dsh-web-app/presets/standard.patch.yml:12-15`），且 web 面把它从宿主面关掉
   （`dsh-web-app/cordis.patch.yml` disabled 列表含 `agent-instructions`）。
   ⇒ **已决策：挂**（`presets/acp-relay.patch.yml` 含 `agent-instructions` 行），
   理由是中继需要 `~/.dsh/AGENTS.md` 的全局指令注入。
4. **换档后 preset 变化的可观测性**：`dispatch.js` 决策日志当前**仍无** preset 字段，需新增（§Q5 第 3 条）。
   ⚠ **未实现，保留为待办。**

---

## 部署与生效清单

> 本章说明「代码写完了」到「线上真的生效」之间必须做的事。**改源码不自动生效。**

1. **重新打包 + 覆盖安装**：
   - 改 `lib/` / `index.js` 后必须重新 `npm pack` 生成 tgz，**覆盖 `~/.dsh/packages/*.tgz`**，
     并重装 profile 依赖，**再重启 DSH**。仅改源码不重启 ⇒ 跑的还是旧包。
2. **`presets/acp-relay.patch.yml` 需人工合并**（高风险写系统配置，**需用户授权**）：
   - 该文件**不自动生效**，需人工合并进 `~/.dsh/profiles/web/cordis.patch.yml`
     （与 `preset-orchestrator` 同层，`order: 7`，已占用 1/2/3/4/6）。
   - 合并后必须**实机验证**：建一个 ACP child，确认它只看得见 `product_submit`
     （`ctx.tools.view(childScope).knownNames`，或让 child 自报工具清单）。
   - 若 `allow` 名单里有名字不在 inherited 面，preset 挂载会 **loud throw**（`dsh-tools/lib/index.js:2983-2985`）。
3. **两仓均非 symlink，而是实体副本**：
   - `~/.dsh/profiles/web/package.json` 用 `file:` 指向 tgz ⇒ profile 下的 `node_modules`
     是**拷贝**，不是指向本仓的链接。
   - 核对命令：`diff -rq <本仓>/lib ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-agent-dispatch/lib`
     （以及 B 仓对应路径），**两边一致才说明装的是当前代码**。
   - 常见陷阱：改完源码忘了重打 tgz ⇒ `diff -rq` 立刻暴露不一致。

---

## 已知风险与已接受风险

### 1. relay-guard 的 Accepted Risk：收窄只换执行引擎，不收窄可执行内容

`lib/relay-guard.js` 的 `RELAY_ALLOWED_TOOLS = { product_submit, send_message }`（`:73`）是**执行期拦截**：
中继子代理仍看得到宿主工具清单，但一调用非放行工具就被拒并给出"你是中继，必须用 product_submit"的可操作原因
（纯函数 `relayDenialReason(exec)`，`:131-139`；未登记 / 非 relay 返回 `undefined`）。

**已接受的风险**：`product_submit` 把**任意任务文本**转发给远端产品会话
⇒ 被闸限死的 relay **仍可让远端产品执行任意命令**。
⇒ preset/guard 的收窄**只更换了执行引擎**（从"relay 本地工具"换成"远端产品工具"），
**并不收窄可执行内容**。这不是缺陷，是"中继"这一形态的固有边界——
真正的权限控制在远端产品侧（其 `permissionMode` / 用户授权），本插件明确不越界。

### 2. relay-guard fail-open Blocker A/B（**已修复**，v1.12.20；残留限制见下）

`relayChildren` 是**进程内 Set**（`lib/relay-guard.js:85`，注册后不随单轮结束清除），
**首建登记点**是 `lib/dispatch.js:1252` 的 `if (acpMode) relayChildren.add(childId)`；
注销点在 `lib/dispatch.js:3303`（close 路径，仅非运行中 child）/ `:3378` / `:3381`（按父会话清两处登记来源），
**以及 `:3415` 的 `relayChildren.clear()`**（插件 `dispose` / 卸载路径，清模块级单例防跨重载残留陈旧 childId
——注意这条清空会把该进程内**所有** relay 登记一并抹掉，是残留 fail-open 的放大点）；import 在 `:48`。

**修法（v1.12.20 已落地）**：不再"在三条续聊路径各补一遍登记"（那样必漏一条，正是 Blocker A/B 的成因），
而是**收敛到所有续聊的公共通道** `Dispatcher#followup()`（`lib/dispatch.js:1423`）——
定向 `childId` 续聊、复用池续聊、`agent_followup` 工具都经它。投递成功后按**三层账本**
`childPool → activeChildren → completedFresh` 依次取 `acpMode`（`0xC` 未知即 `?? false`，判不出就不登记），
命中则调 `markRelayChild(deliveredTo)`（`lib/dispatch.js:1471-1482`）；**换档改投**场景下
`deliveredTo`（真正收到消息的那一档）与原目标 `childId`（链上失败档）**两个都补登记**，
否则失败档会在 `product_submit` 阻塞期间重新拿到本地工具。
配套落点：`lib/relay-guard.js:101` 新增 `markRelayChild(childId)`（幂等薄封装）、
`:118` 新增 `isRelayChild(childId)`（外部查询，避免直接摸 Set）；
`onChildEnd` 写 `completedFresh` 与 `followup` 从历史重建 `activeChildren` 时都**必须带 `acpMode`**
（否则池外/历史线程判不出 ACP 语义，补登记就是空转）。
守卫与用例：`verify.mjs:202-213` 焊死上述结构（含"followup 必须补登记"的正则），
`verify.mjs:226-233` 有 7 条**行为**断言，`test/acp-relay-persona.test.js:183` 起为 D 组用例。

- ~~**Blocker A**（续聊路径不补登记）~~ → **已修复**：三条续聊入口都经 `followup()`，补登记随投递发生。
- ~~**Blocker B**（判据不是单一真源、冷恢复即丢身份）~~ → **已修复（同进程内）**：判据改为账本里的
  `acpMode` 现场推导，`completedFresh` 带 `acpMode` 后**冷恢复**（复用池线程 / 历史线程）也能判出 ACP 语义。

**残留限制（诚实保留，未修，超本次范围）**：三层账本与 `relayChildren` 一样**都是进程内状态**。
DSH **真重启**（进程退出重建）后三张账本全空、`relayChildren` 也空，
此时用**持久 `childId`** 定向续聊仍 **fail-open**（`relayAcp` 判为 `false` ⇒ 不补登记）。
彻底修需把 ACP 语义**落盘**，或在续聊时用 `recoverRemoteSessionId` 从远端会话反推——
两者都超出 preset 收窄的范围，未实施。使用方需知情：**跨进程重启的续聊**仍不在闸的覆盖内。

---

## 附：本次引用的关键行号索引

```
# 宿主 dsh-subagent
dsh-subagent/lib/index.js:1452          composition: { agentPreset: request.agentPreset }
dsh-subagent/lib/index.js:1795,1806     applyChildComposition(...)
dsh-subagent/lib/index.js:373-378       presets.mount(childCtx, composition.agentPreset)
dsh-subagent/lib/index.js:381           composeFrom(childCtx, parent.ctx)
dsh-subagent/lib/index.js:384-395       applyChildOverrides（persona / toolFilter）
dsh-subagent/lib/index.js:3036-3047     startActivation → assertCapabilities → startLocal/startExternal
dsh-subagent/lib/index.js:3311-3312     agentPreset 能力闸门
dsh-subagent/lib/index.js:2167-2181     coldResume 重建 composition
dsh-subagent/lib/index.js:2257-2265     hasIndependentPresetSelection
dsh-subagent/lib/index.js:1460          send_message 可见性 → 回传指引
dsh-subagent/lib/types/types.d.ts:129-135   agentPreset?: string
dsh-subagent/lib/types/types.d.ts:206-213   ContinuableCreateSpec
dsh-subagent/lib/types/types.d.ts:325-341   prepareContinuable 文档
dsh-subagent/lib/types/types.d.ts:115-121   SubagentCapabilities

# 宿主 dsh-tools
dsh-tools/lib/index.js:2972-2986        restrict()
dsh-tools/lib/index.js:3036-3062        view()
dsh-tools/lib/index.js:3050             layers.every(layer => layer.admits(name))
dsh-tools/lib/index.js:2719-2722        ToolLayer.admits
dsh-tools/lib/index.js:2977             空名单 loud throw 的宿主同口径
dsh-tools/lib/index.js:3036-3051        restrictableNames（inherited only，排除 own 层）
dsh-tools/lib/types/index.d.ts:508-513  ToolRestriction
dsh-tools/lib/types/index.d.ts:666-677  inherited-only 语义 + 「presets moved them onto the agent plane」

# 宿主 preset / scope / cordis
dsh-agent-preset-registry/lib/index.js:219-236   mountPreset
dsh-agent-preset-registry/lib/index.js:497-505   createScope + scope.ctx.extend
dsh-agent-preset-registry/lib/index.js:660-670   join / bindScopeParent
dsh-agent-preset-registry/lib/index.js:686-700   mount()
dsh-agent-preset-registry/lib/index.js:701-717   composeFrom()
dsh-agent-preset-registry/lib/types/definition.d.ts:4-13   PresetDefinition
dsh-scope/lib/index.js:162-169          chainLayers
dsh-scope/lib/index.js:189-218          ScopedLayers.effect
dsh-scope/lib/index.js:256-262          bindScopeParent
dsh-scope/lib/index.js:312-314          scopeOf
cordis/lib/index.js:1317-1328           _refresh()：任一 inject 服务缺失 ⇒ epoch=INACTIVE ⇒ apply() 永不执行
dsh-web-app/presets/standard.patch.yml:5-122   preset 模板（权威样例）

# 工具面归属（宿主面 vs preset 面）
dsh-web-app/cordis.patch.yml:474-577    web 面关掉的 23 个宿主行
dsh-web-app/cordis.patch.yml:160-164    cordis inspect（process-global）
dsh-base/cordis.patch.yml:169-170       tool-working-directory
dsh-base/cordis.patch.yml:485           mcp-resources
dsh-mcp-resources/lib/index.js:56,66,76 list_mcp_resources / …templates / read_mcp_resource
dsh-tool-cordis/lib/index.js:39,55      cordis inspect 工具注册
dsh-subagent-spawn-in-process/lib/index.js:21-27  spawn: agentPreset true / inheritsParentContext false
dsh-subagent-fork-in-process/lib/index.js:35-41   fork: agentPreset false / inherits true

# dsh-agent-dispatch（A 仓，本仓）
lib/agents.js:124-142                    validateAgent（acpPreset 校验，:130-131/:140-141）
lib/agents.js:194-201                    normalizeAgent（两 preset 字段四口径：不落键 / trim）
lib/agents.js:236-240                    needsNormalize（两字段同口径）
lib/agents.js:280-311                    init()：console.warn 一次、不回写磁盘（:316-321 说明）
lib/dispatch.js:1144-1148                ★ presetForRoute：failover 循环内按档位类型取值（:1144-1148 默认 OFF 的理由）
lib/dispatch.js:1194-1242                request 块（:1230 persona 兼容保留；:1235 agentPreset 展开；:1238-1242 toolFilter）
lib/dispatch.js:1252                     ★ relayChildren 首建登记点（续聊补登记唯一收敛点 :1468-1482）
lib/dispatch.js:1468-1482               ★ 续聊补登记唯一收敛点（followup()：三层账本 ⇒ markRelayChild）
lib/dispatch.js:711-717                  入口 callerDepth 硬检查
lib/dispatch.js:2524, 2875              换档 reuse: 'fresh'（2524 首档失败替补；2875 链式换档）
lib/dispatch.js:271-280                  buildFailoverTaskText
lib/dispatch.js:2910-2930                failover 池位继承 + 原低档线程 keep 保底
lib/client.js:2093-2149                  AgentForm：agentPresets prop + 两个 select + stale 保护（调用点 :2497）
lib/relay-guard.js:28-51                 模块头：前提更迭 + 两道收窄的依存关系
lib/relay-guard.js:73                    RELAY_ALLOWED_TOOLS = { product_submit, send_message }
lib/relay-guard.js:85                    relayChildren 进程内 Set
lib/relay-guard.js:101 / :118             markRelayChild / isRelayChild（v1.12.20 补登记 + 查询）
lib/relay-guard.js:131-139                relayDenialReason(exec) 纯函数
lib/relay-allowlist.js:50-52             allow 与 deny **均**为空才 loud throw（支持 deny 补集形态）
index.js:50                              inject 刻意不含 'agentPresets'（:1680-1684 决策记录）
index.js:1688-1707                       readAgentPresets()
index.js:1921                            GET /agent-api 出参加 agentPresets
index.js:135-172                         全局 tools.guard（subagentDepth>=1 拒绝委派工具）
package.json:36                          exports 加 "./relay-allowlist"
presets/acp-relay.patch.yml              acp-relay preset 定义（301 行，待人工合并）
presets/agent-verify.patch.yml           agent-verify preset 定义（188 行，order 10；已人工合并进
                                         profile :552-663，registry 由 :552 移到 :664）
verify.mjs:175-235                       v1.12.18 守卫段（20 条）+ :200-213 v1.12.20 补登记守卫
verify.mjs:237-317+                      v1.12.19 逐档位 preset 守卫段（:261-262 反向断言）
test/acp-relay-persona.test.js           13 用例（D 组 :183 起 = v1.12.20 补登记 7 例）
test/agent-preset.test.js                22 用例（acpPreset 四口径 8 例）
test/agent-api-harness.js:41             services 加 agentPresets

# dsh-plugin-product-subagents（B 仓，只读不改）
lib/host-compat.js:127                   agentPreset: true（能力位翻转）
lib/index.js:877-894                     provider 对象（inheritsParentContext: false 在 :878）
lib/index.js:918-934                     prepareContinuable（只返回 seed）
lib/index.js:960-965                     六个工具的注册点
lib/tools/product-delegate.js:107-110    relay allow 列表
lib/tools/product-delegate.js:139-144    已失效的 persona / toolFilter
lib/tools/product-submit.js:66-90        product_submit 注册与 reconnect
lib/run.js:84-91                         parentCwd（远端 cwd 来源）
lib/bridges/acp.js:1570-1633             v0.7.18+ EMPTY_RESPONSE 档内静默重试预算（默认值 :1573-1575；重试循环 :1614-1633；默认 3 次，主代理不可见）
lib/bridges/acp.js:1523-1536             同文件但**别混**：reconnect 重试路径，以及 EMPTY_RESPONSE 的**抛出点**(:1536)——重试预算不在这里
test/capabilities-contract.test.js:169-190   护栏（已翻 true + doesNotThrow，保留 inheritsParentContext===false）
scripts/check-host-compat.mjs:374-386    探针表（已调整）
CHANGELOG.md:183-196                     「遗留」节；「权限边界被削弱」在 :189（`toolFilter` 失效）
CHANGELOG.md:101-112                     **不是「遗留」节**，那是 depthLimit 事故现场记录（勿混引）
```
