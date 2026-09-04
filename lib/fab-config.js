// dsh-agent-dispatch — 悬浮球配置持久化（v1.6.0）。
//
// 悬浮球四项 UI 配置（visible 隐藏状态 / pos 位置 / mode 显示模式 / settings 光效设置）
// 原先只存 webview iframe 的 localStorage：VS Code 每次重建窗口/面板都换
// vscode-webview://<uuid> 顶层 origin，http-origin localStorage 被分区隔离整体丢失，
// 「隐藏状态 + 位置」随每次重开蒸发。本模块把配置落到宿主数据目录
// $DSH_HOME/data/dsh-agent-dispatch/fab-config.json，client 半经
// GET / POST /agent-api/fab-config 同源读写（字段级合并），localStorage 降级为
// 单浏览器场景的会话副本（宿主通道不可用时兜底）。
//
// 设计：
//   - 读写均为同步文件 IO：文件 <1KB，调用频度 = 悬浮球挂载 / 用户操作级，
//     Node 单线程内「读-改-写」天然串行，无需注册表那套异步写队列。
//   - 写入原子：同目录 .tmp + rename（与 agents.json / squads.json 同机制）。
//   - 校验从严、字段从宽：写入补丁类型不符即抛错（REST 面透传为 400）；
//     读取只透出已知且类型合法的字段，未知键忽略（version 等元数据不外泄）。
//   - settings 浅合并：补丁未提及的旧键保留（多端并发改不同设置项互不覆盖）。

import fs from 'node:fs'
import path from 'node:path'

const FAB_MODES = ['always', 'auto', 'never']
const SETTINGS_MAX_KEYS = 32

/**
 * 校验并归一化配置对象（写补丁与磁盘内容共用）：
 * 只认 visible / mode / pos / settings 四个字段，类型不符抛错（中文消息）。
 */
function normalizeFabConfig(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('fab-config 必须是对象')
  }
  const out = {}
  if (source.visible !== undefined) {
    if (typeof source.visible !== 'boolean') throw new Error('fab-config.visible 必须是布尔值')
    out.visible = source.visible
  }
  if (source.mode !== undefined) {
    if (!FAB_MODES.includes(source.mode)) throw new Error(`fab-config.mode 只能是 ${FAB_MODES.join(' / ')}`)
    out.mode = source.mode
  }
  if (source.pos !== undefined) {
    const p = source.pos
    if (!p || typeof p !== 'object' || Array.isArray(p) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error('fab-config.pos 必须是 { x, y } 有限数字对象')
    }
    out.pos = { x: p.x, y: p.y }
  }
  if (source.settings !== undefined) {
    const s = source.settings
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('fab-config.settings 必须是对象')
    const keys = Object.keys(s)
    if (keys.length > SETTINGS_MAX_KEYS) throw new Error(`fab-config.settings 键数超上限（${SETTINGS_MAX_KEYS}）`)
    for (const k of keys) {
      const t = typeof s[k]
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        throw new Error(`fab-config.settings.${k} 必须是 string/number/boolean`)
      }
    }
    out.settings = { ...s }
  }
  return out
}

/**
 * 读取悬浮球配置：无文件 / 损坏 / 无有效字段时返回 null（client 侧回退 localStorage）。
 * 只透出已知且类型合法的字段，防手改文件注入畸形数据进 client。
 */
export function readFabConfig(dataDir) {
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'fab-config.json'), 'utf8'))
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[dsh-agent-dispatch] fab-config.json 读取失败（按无配置处理，下次写入自愈）:', err.message)
    }
    return null
  }
  try {
    const out = normalizeFabConfig(raw)
    return Object.keys(out).length ? out : null
  } catch (err) {
    console.error('[dsh-agent-dispatch] fab-config.json 字段不合法（按无配置处理，下次写入自愈）:', err.message)
    return null
  }
}

/**
 * 字段级合并写入（原子落盘 fab-config.json），返回合并后的完整配置。
 * 补丁只更新给出的字段；settings 在旧值基础上浅合并。
 */
export function mergeFabConfig(dataDir, patch) {
  const normalized = normalizeFabConfig(patch)
  const prev = readFabConfig(dataDir) || {}
  const merged = { ...prev, ...normalized }
  if (normalized.settings) {
    merged.settings = { ...(prev.settings || {}), ...normalized.settings }
  }
  const file = path.join(dataDir, 'fab-config.json')
  const tmp = file + '.tmp'
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, ...merged }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return merged
}
