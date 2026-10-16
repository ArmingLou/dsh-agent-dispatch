/**
 * relay-allowlist —— preset 层的**正向工具白名单**（把继承面收窄到 allow 列表）。
 *
 * ## 用途
 *
 * 只给 `acp-relay` preset 用：ACP 中继子代理不干活（任务由远端产品会话执行），
 * 本地工具面应只剩 `product_submit`（+ 视策略决定的 `product_delegate`）。
 *
 * 光靠「preset 里不写工具行」收不干净：`working_directory` / `read_mcp_resource` /
 * cordis inspect 等**宿主面（global）工具**不在任何 preset 里，任何 preset 都收不掉
 * （证据见 `docs/agent-preset-migration.md` §1.4）。所以必须再挂本行做正向白名单。
 *
 * ## 为何必须在 preset 的 scoped ctx 下调用
 *
 * `tools.restrict()` 要求 scoped ctx：`scopeOf(this.ctx)` 取不到 scope 就直接抛
 * ——"a context-global restriction would mask every agent"
 * （宿主 `dsh-tools/lib/index.js:2972-2974`）。
 * preset 的行挂在 preset generation 的 scoped ctx 下
 * （`dsh-agent-preset-registry/lib/index.js:497-505`、`:219-236`；`Context.extend` 走
 * `Object.create`，`kScope` 沿原型链继承），且子 agent 的 scope 通过
 * `bindScopeParent(key, generation.key)` 挂在该 generation 之下（同文件 `:670`）。
 * ⇒ 挂在 preset 里的本行，能遮住该 preset 下所有 agent 继承到的 global 工具。
 *
 * 另：`restrict()` 只过滤 **inherited** 面（global 层 + 祖先层），**永不过滤 own 层**
 * （宿主 `dsh-tools/lib/index.js:3050-3055`）。因此**名单里每个名字都必须属于 inherited 面**，
 * 即已加载的 global/祖先层工具名——**不能**写「同 preset 兄弟行注册的工具」，也不能写当前
 * 未加载的插件工具名：未知名字会 **loud throw**
 * `tools.restrict() names unknown global tool "X"; known global tools: …`
 * （宿主 `dsh-tools/lib/index.js:2985`）⇒ 整个 preset 挂载失败。
 *
 * ⚠ 未实机确认项（见 `docs/agent-preset-migration.md` §4 第 2 条）：`product_submit` 是否真在
 * preset scope 的 `restrictableNames` 里，取决于 `product-subagents` 的 bundle 行是否注册在
 * **未 scope** 的 ctx 上。它若在某个 scope 下，`restrict()` 会因名字不在 inherited 面而抛错，
 * 导致 preset 挂载失败。首次实机挂载前请先确认这一点。
 *
 * @module lib/relay-allowlist
 */

/**
 * 插件名：与仓库既有插件风格一致（参照 `index.js:41` 的 `export const name`）。
 * 注意：preset 行实际按行的 `name:` 字段解析插件来源，本导出只用于诊断/展示。
 */
export const name = '@kiligzzz/dsh-agent-dispatch/relay-allowlist'

/** 依赖声明：只依赖 `tools` 服务（与 `index.js:50` 风格一致，只列真正用到的）。 */
export const inject = ['tools']

/**
 * 把当前 scope 的继承面收窄到 `config.allow`。
 *
 * **fail-closed**：`allow` 缺失/为空时 **loud throw**，而不是静默放行——本插件的唯一职责
 * 就是收窄，空名单静默 return 会留下"relay 仍持有全部 global 工具"的静默安全洞
 * （与宿主自己的 `tools.restrict({}) is a no-op: … almost always a materialized-empty-config bug`
 * 口径一致，宿主 `dsh-tools/lib/index.js:2977`）。
 * 本仓库既有的同类教训：白名单/fail-closed 判定绝不能把默认值设在放行侧。
 *
 * @param {object} ctx preset 的 scoped 上下文
 * @param {{ allow?: string[], deny?: string[] }} [config] 白名单（必填）/ 可选黑名单
 */
export function apply(ctx, config = {}) {
  const allow = Array.isArray(config.allow) ? config.allow : []
  const deny = Array.isArray(config.deny) ? config.deny : []
  if (allow.length === 0 && deny.length === 0) {
    throw new Error(
      '[relay-allowlist] 缺少 allow 名单：本插件只用于收窄工具面，空名单会让 relay 保留全部继承工具。'
      + '请在 preset 行 config 里显式给出 allow（例如 allow: [product_submit]）。',
    )
  }
  // 注：restrict() 返回它自己的 effect disposer（宿主 dsh-tools/lib/index.js:2986），
  // 因此这里把返回值直接交给 ctx.effect 作为清理函数——本仓库既有 ctx.effect 用法见
  // lib/client.js:5408 与 index.js:2526。
  ctx.effect(() => ctx.tools.restrict({ ...(allow.length ? { allow } : {}), ...(deny.length ? { deny } : {}) }), 'relay-allowlist')
}
