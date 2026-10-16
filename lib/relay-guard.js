/**
 * v1.12.18：ACP relay 子代理的**执行期工具闸**（ACP 工具收窄的**执行期**那一道；
 * 结构性那一道是 profile 级 `acp-relay` preset，二者**互补而非互斥**，见下方「机制结论」）。
 *
 * ## 为什么需要它
 *
 * 现场（已实测复现）：宿主 0.2.1-alpha.3 下派发 ACP 档（如 explorer 首档 qodercli），
 * 子代理成功返回，但解压其会话得到 `product_submit` 调用 **0 次**、手里 **64 个工具**
 * （与父会话相同，含 `write`/`edit`/`bash`）、实际驱动模型 `workbuddy/deepseek-v4.1-flash`
 * 直接调本地 `grep`/`read`/`bash` 把活干完。
 *
 * 根因：ACP 中继原本靠 `request.persona`（中继指示）+ `request.toolFilter`
 * （`{ allow: ['product_submit'] }`）双管齐下，而宿主 0.2.1-alpha.3 的
 * `SubagentStartRequest` **已移除这两个字段并静默忽略**：
 *   - 中继指示丢失 ⇒ 模型不知道要 `product_submit` 转发（已改走初始 prompt 注入修复）；
 *   - toolFilter 失效 ⇒ 工具面完全不受限（本模块负责补上）。
 *
 * ## 机制结论（为什么是 guard 而不是 restrict）
 *
 * 收窄"工具可见性"的正规入口是 `childCtx.tools.restrict(filter)`，但它在
 * `applyChildOverrides`（宿主 dsh-subagent/lib/index.js:384-396）里执行，读取的是
 * **`composition.persona` / `composition.toolFilter`**；而 `startLocal` 构造 composition 时
 * 只写 `{ agentPreset: request.agentPreset }`（同文件 :1452），**从不**写入这两个字段
 * ⇒ 从 request 传进去必然到不了那里。唯一会写入它们的入口是 resume 路径读历史
 * descriptor（:2177-2181），而 descriptor 由 `snapshotSubagentDescriptor` 生成、
 * 同样不含这两字段（:1404-1412）⇒ 新建 child 无法利用。
 *
 * ⚠⚠ **以下结论曾经成立、现已被推翻（历史记录，勿再据此判断 preset 路不可行）**：
 * 本模块初版写下的前提是「`request.agentPreset`（Agent Preset）也不可用」——ACP provider
 * 当时自声明 `capabilities.agentPreset = false`，宿主 `assertCapabilities` 会对任何带
 * `agentPreset` 的请求直接抛 `UNSUPPORTED_CAPABILITY`（宿主 :3311-3312）。
 *
 * **该前提已不成立**：`dsh-plugin-product-subagents` 已把该能力位由 `false` 翻为 **`true`**
 * （dsh-plugin-product-subagents/lib/host-compat.js:127；主代理实测
 * `PROVIDER_CAPABILITIES.agentPreset === true`，当前全位为
 * `{ agentOptions: false, agentPreset: true, outputSchema: false, depthLimit: true,
 *   persona: true, toolFilter: true }`）。**因此 Agent Preset 这条路对 ACP provider 现在是开放的。**
 *
 * ⇒ 可用的收窄点有**两个**，且**互补而非互斥**：
 *
 *   · **结构性收窄**（决定工具**可见性**）：`agentPreset` + `acp-relay` preset
 *     （`presets/acp-relay.patch.yml` + `lib/relay-allowlist.js`）。它才是让 relay 子代理
 *     **看不到** `write`/`edit`/`bash` 的正规手段，但需要人工把 profile 配置
 *     （`~/.dsh/profiles/web/cordis.patch.yml`）合并进去，且**尚未实机验证**；
 *   · **执行期拦截**（本模块）：全局 `ctx.tools.guard`（宿主 dsh-tools/lib/index.js:2998
 *     注册、:3318 `guardReason(exec)` 在每次工具执行前求值；`exec.agent` 即调用方 Agent）。
 *     **当前即刻生效、零配置、不依赖任何 profile 改动**——它是纵深防御的第二道，
 *     在 preset 尚未落地（或漏配、被 profile 覆盖）时兜住危害。
 *
 * 保留 guard 的取舍：preset 是目标形态（可见性收窄），但它需要人工配置且未验证；
 * 在它实机验证通过并被采纳之前，guard 是唯一**无需配置就生效**的那道。
 *
 * ## ⚠ 明确的局限（不得淡化）
 *
 * guard 是**执行期拦截**，挡不住"工具可见"：relay 子代理的系统提示词里依然列着
 * `write`/`edit`/`bash` 等 64 个工具，模型**看得见**它们，只是在调用时被拒。
 * 它能挡住的是本次事故的真实危害——"模型自作主张用本地工具把活干完"：调用会被拒
 * 并回一条明确的"你必须用 product_submit 转发"错误，模型据此转向正确路径。
 * 可见性收窄**不由本模块承担**：宿主已提供送达路径（`agentPreset`，见上方「已被推翻」
 * 一段），结构性收窄由 profile 级 `acp-relay` preset + `lib/relay-allowlist.js` 承担
 * （`presets/acp-relay.patch.yml`，需人工合并 `~/.dsh/profiles/web/cordis.patch.yml`
 * 且尚未实机验证）。本模块只负责"即使可见也调不动"这第二道。
 *
 * @module lib/relay-guard
 */

/**
 * ACP relay 子代理**唯一放行**的工具（其余一律执行期拒绝）。
 *   - `product_submit`：中继协议要求调用的转发工具，relay 的全部职责；
 *   - `send_message`：子代理→父级回传/续聊（宿主服务本身强制相邻关系，
 *     只能发给直接父级），与 index.js 既有递归护栏的豁免口径保持一致。
 */
export const RELAY_ALLOWED_TOOLS = new Set(['product_submit', 'send_message'])

/**
 * 已登记的 ACP relay child 集合（childId）。
 *
 * 由 Dispatcher 在 ACP 档 child 建立后**同步**登记，供 index.js 的全局 tools.guard
 * 判定"这次工具调用的调用方是不是 relay 子代理"。
 *
 * 生命周期：登记后**不随单轮结束清除**——child 会进复用池、被冷恢复续聊，
 * 恢复后仍必须是 relay 语义（否则第二次续聊就重新获得全部本地工具，等于没修）。
 * 仅在 `Dispatcher#purgeParent`（父会话清理）与 `closeChild` 时移除。
 */
export const relayChildren = new Set()

/**
 * v1.12.20：把 childId 补登记为 relay（幂等）。
 *
 * **为什么需要这个函数**：登记原来只有首建一条路径（dispatch.js 的
 * `if (acpMode) relayChildren.add(childId)`），而续聊/恢复有三条独立入口
 * （定向 childId、复用池、宿主冷恢复后的持久 childId），它们都不补登记 ⇒
 * 闸 fail-open：续聊后的 relay child 重新拿回全部本地工具。
 * 现在把「补登记」收敛到 Dispatcher#followup 这一个所有续聊的公共通道，
 * 由它按账本里的 ACP 语义调用本函数。语义与 `relayChildren.add` 等价，
 * 只是给了调用方一个显式名字（并让 verify.mjs 能断言"补登记入口存在"）。
 *
 * @param {string} childId
 * @returns {boolean} 本次是否发生了新登记（已登记过 → false）
 */
export function markRelayChild(childId) {
  if (typeof childId !== 'string' || childId === '') return false
  if (relayChildren.has(childId)) return false
  relayChildren.add(childId)
  return true
}

/**
 * v1.12.20：查询 childId 当前是否被 guard 认成 relay。
 *
 * 供测试与调用方在不 import 整个 dispatcher 账本的前提下核对闸的状态；
 * 与 `relayChildren.has` 等价，同样是对**当前进程内单例**的查询
 * （跨进程/重启的持久化见 relay-guard.js 模块头的「局限」段）。
 *
 * @param {string} childId
 * @returns {boolean}
 */
export function isRelayChild(childId) {
  if (typeof childId !== 'string' || childId === '') return false
  return relayChildren.has(childId)
}

/**
 * 判定一次工具调用是否应被 relay 闸拒绝。
 *
 * 纯函数、无副作用，便于单测直接驱动（不需要起 Dispatcher / 假宿主）。
 *
 * @param {object} exec 宿主工具执行上下文（`{ name, agent }`）
 * @returns {string|undefined} 拒绝原因（中文，面向模型）；放行时返回 undefined
 */
export function relayDenialReason(exec) {
  const agent = exec && exec.agent
  const childId = agent && agent.session ? agent.session.id : null
  if (!childId || !relayChildren.has(childId)) return undefined
  const toolName = exec && exec.name
  if (RELAY_ALLOWED_TOOLS.has(toolName)) return undefined
  return `[dsh-agent-dispatch] 你是 ACP 中继子代理：不得用本地工具（${toolName}）自己完成任务。`
    + '必须调用 product_submit 把任务原样转发给远端产品代理执行，再把它的回答如实转达给发起方。'
}
