// lib/json-safe.js — 宿主「工具出参必须无损 JSON」规则的统一收口器。
//
// 背景（跨版本同款严格，不是升级回归）：宿主在工具执行成功后对**返回值本体**做
// 一次无损快照校验（`dsh-tools` 的 `createSuccessResult` → `snapshotToolValue`
// → `@deepseek-ai/dsh-util-values` 的 `snapshotJsonValue`）。判定标准是「JSON 往返
// 后逐字节等价」——而 `JSON.stringify` 会**丢弃值为 `undefined` 的自有属性**，
// 于是只要出参里有一个可选字段为空，整次调用就失败（不是该字段缺失，是整次失败）：
//
//     tool "<name>" returned invalid output: value is not lossless JSON
//     （ToolOutputError / code INVALID_TOOL_OUTPUT）
//
// 实测 dsh 0.1.0-rc.6 与 0.2.0-rc.1 两版同样严格；本插件过去没被打中，只是因为
// 出参恰好都填满了。手写/迁移过的 agents.json、日后新增的可选字段（output、
// warnings…）都可能重新引爆。因此所有工具出参统一经 `jsonSafe` 收口。
//
// 语义（详见各函数 JSDoc）：
//   - 递归丢弃 `undefined` 的自有属性（对象）与 `undefined` 的数组项（转 `null`，
//     避免删项导致下标位移——下标是调用方的契约）；
//   - `function` / `symbol` 同样不可能无损往返，按不可序列化处理（对象里丢弃、
//     数组里转 `null`）；
//   - `Date` / `Buffer` 这类带 `toJSON()` 的值按 JSON 形态落值（**保内容**，不拍平）；
//     `Map` / `Set` / 类实例按不可无损丢弃；`bigint` 安全整数转 `number`；
//   - 顶层传 `undefined` 时原样返回 `undefined`（由调用方/宿主按既有语义处理，
//     本函数不替它编造值）。
//
// `isLosslessJson()` 是对宿主规则的**本地等价**判定（含值域与结构两道），供测试与
// 诊断使用；已用 15 例真值表与宿主真实 `snapshotJsonValue` 逐例对齐。
//
// @param {unknown} value
// @returns {unknown} 保证 `snapshotJsonValue(结果)` 不为 undefined 的值

/** 不可能无损 JSON 往返的原始类型（JSON 里没有对应形态）。 */
const isUnserializable = (v) => typeof v === 'function' || typeof v === 'symbol'

/** `jsonSafe` 的递归深度上限（防循环引用/自返 toJSON 爆栈；真实出参远低于此）。 */
export const JSON_SAFE_MAX_DEPTH = 64

/** 纯 JSON 容器：字面量对象（原型为 Object.prototype / null）或数组。 */
function isPlainContainer(v) {
  if (Array.isArray(v)) return true
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/**
 * 递归清洗为无损 JSON 安全的值。
 *
 * 除 `undefined` 外还处理三类"JSON 表达不出来"的值——它们的共同点是
 * `JSON.stringify` 会**静默改写**而不是报错，若不处理，宿主那边会判非无损
 * （实测宿主对 `Date` / `Map` / `Set` / `Buffer` 一律拒绝）：
 *   · 带 `toJSON()` 的对象（`Date` → ISO 字符串、`Buffer` → `{type,data}`）：
 *     按它的 JSON 形态落值，**保内容**而不是拍平成 `{}`；
 *   · 其它非字面量对象（`Map` / `Set` / 类实例）：JSON 只能得到 `{}`，按不可
 *     无损处理（对象里丢弃 / 数组里转 `null`）；
 *   · `bigint`：安全整数范围内转 `number`，超出则转十进制字符串（JSON 无 bigint）。
 *
 * @param {unknown} value
 * @returns {unknown}
 */
export function jsonSafe(value, depth = 0) {
  if (value === undefined) return undefined
  if (value === null) return null
  // 深度上限：本函数是"最后一道收口"，必须**总能返回**（宿主对抛错的工具另有兜底，
  // 但那是另一种失败形态）。循环引用（`a.self = a`）与自返 `toJSON(){return this}`
  // 都会让天真递归爆栈（RangeError）；超过上限按不可无损处理。
  if (depth > JSON_SAFE_MAX_DEPTH) return undefined
  const type = typeof value
  if (type === 'bigint') {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : value.toString()
  }
  if (type !== 'object') return isUnserializable(value) ? undefined : value
  if (Array.isArray(value)) {
    return value.map((item) => {
      const cleaned = jsonSafe(item, depth + 1)
      // 数组项里的 undefined 转 null：保住下标，也保住长度
      return cleaned === undefined ? null : cleaned
    })
  }
  if (!isPlainContainer(value)) {
    // 非字面量对象：能自报 JSON 形态的按形态落值，否则视为不可无损
    if (typeof value.toJSON === 'function') {
      try {
        return jsonSafe(value.toJSON(), depth + 1)
      } catch { return undefined }
    }
    return undefined
  }
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    const cleaned = jsonSafe(item, depth + 1)
    if (cleaned === undefined) continue // 关键一步：undefined 属性会被 JSON 丢弃，直接不落键
    out[key] = cleaned
  }
  return out
}

/**
 * 值是否**只由** JSON 能无损表达的东西构成（原始类型 + 字面量对象/数组）。
 * 单靠"往返后结构等值"不够：
 *   · `new Map([['a',1]])` 与 `{}` 往返后逐键比对是相等的（Map 没有自有可枚举键），
 *     会被误判为无损——实测宿主 `snapshotJsonValue` 对 `Map` / `Set` 一律判非法；
 *   · `-0` 与 `0` 在 `===` 下相等（须用 `Object.is`），`JSON.stringify(-0)` 得到 `'0'`；
 *   · symbol 键、非枚举自有属性、数组上的额外自有属性，都会在 JSON 往返中丢失，
 *     而 `Object.keys` 看不见它们——宿主一律判非法（实测）。
 * 因此这里逐项显式判定：值域 + 自有键的"可见性/可枚举性"完全干净。
 * @param {unknown} v
 * @returns {boolean}
 */
function isPlainJsonShape(v) {
  if (v === null) return true
  const type = typeof v
  if (type === 'number') return Number.isFinite(v) && !Object.is(v, -0) // NaN/Infinity/-0 都被宿主拒
  if (type === 'string' || type === 'boolean') return true
  if (type !== 'object') return false // undefined / function / symbol / bigint
  if (!isPlainContainer(v)) return false
  if (Object.getOwnPropertySymbols(v).length > 0) return false // symbol 键会在往返中丢失
  const ownNames = Object.getOwnPropertyNames(v)
  if (Array.isArray(v)) {
    // 数组的自有属性只允许「每个下标 + length」：额外自有属性会在往返中丢失，
    // 稀疏数组的"洞"会在往返中变成 null（`Object.hasOwn` 逐个确认下标真实存在）。
    if (ownNames.length !== v.length + 1) return false
    for (let i = 0; i < v.length; i += 1) if (!Object.hasOwn(v, i)) return false
    return v.every(isPlainJsonShape)
  }
  const keys = Object.keys(v)
  if (ownNames.length !== keys.length) return false // 非枚举自有属性会在往返中丢失
  return keys.every((k) => isPlainJsonShape(v[k]))
}

/**
 * 结构等值（含**值为 undefined 的自有属性**）：JSON 往返判定不能只看
 * `stringify` 再 `stringify` 是否相等——`{a:1,b:undefined}` 与 `{a:1}` 会双双
 * 序列化成 `{"a":1}`，看起来"相等"，而宿主正是拿**原始值**与往返结果做逐键比对，
 * 因此判定非法。这里显式递归比对自有键集合与元素，与该规则同构。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
function structurallyEqual(a, b) {
  // Object.is 而非 ===：`-0 === 0` 为真，但 JSON 往返会把 -0 写成 0，属非无损
  if (Object.is(a, b)) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null || typeof a !== 'object') return false
  const aIsArray = Array.isArray(a)
  if (aIsArray !== Array.isArray(b)) return false
  if (aIsArray) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i += 1) if (!structurallyEqual(a[i], b[i])) return false
    return true
  }
  const keysA = Object.keys(a)
  const keysB = Object.keys(b)
  if (keysA.length !== keysB.length) return false // 值为 undefined 的键会在往返中被丢弃 → 数量不等
  for (const key of keysA) {
    if (!Object.hasOwn(b, key)) return false
    if (!structurallyEqual(a[key], b[key])) return false
  }
  return true
}

/**
 * 单个出参值是否已满足宿主「无损 JSON」规则（测试与诊断用）。
 * 本地等价实现宿主 `snapshotJsonValue` 的判定：
 *   ① 值域必须是纯 JSON 形态（原始类型 + 字面量对象/数组）；
 *   ② 原始值与 JSON 往返结果**结构等值**（含自有键集合、数组长度与元素）。
 * 两条缺一不可：只有 ② 会漏判 `Map`/`Set`（往返后都是 `{}`，逐键比对相等）；
 * 只有 ① 会漏判"值为 `undefined` 的自有属性"（形态上仍是字面量对象）。
 * @param {unknown} value
 * @returns {boolean}
 */
export function isLosslessJson(value) {
  if (value === undefined) return false
  if (!isPlainJsonShape(value)) return false
  let round
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return false
    round = JSON.parse(text)
  } catch {
    return false
  }
  return structurallyEqual(value, round)
}
