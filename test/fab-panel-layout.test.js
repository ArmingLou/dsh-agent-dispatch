// v1.11.15/1.11.16(UI)：授权浮球弹出面板的布局回归测试。
//
// 现场缺陷：浮球弹出的授权列表一旦内容较长，面板被撑到超出视口、又滚不到底部，
// 导致「允许一次 / 本会话总是允许 / 拒绝」等按钮落在屏幕外无法点击。
//
// 修复契约（本测试即这些不变量）：
//   ① 面板垂直居中 + 硬限高（max-height:min(70vh,640px,calc(100vh - 24px))），
//      本体 overflow:hidden，任何视口高度都不越出；
//   ② 内容区（.ad-perm-body / .ad-ha-body）flex:1 1 auto + min-height:0 +
//      overflow-y:auto —— 由它承担滚动，min-height:0 是 flex 子项能真正收缩的前提；
//   ③ 单条消息（.p-desc / .ha-reason / .ha-paths）各自限高 + 可滚动；
//   ④ 操作行（.ad-perm-actions / .ad-ha-actions）flex:0 0 auto + position:sticky
//      bottom:0，内容再长按钮也常驻可见；
//   ⑤ 面板加宽且窄屏不溢出；right 让位不遮住 44px 的浮球（否则关不掉）；
//   ⑥ DOM 结构：条目/空态必须挂进「内容区」；renderPop 清空的必须是内容区而不是
//      面板本体——清本体等于把内容区与 sticky 操作行一起抹掉（本条是结构不变量，
//      CSS 断言覆盖不到）。
//
// lib/client.js 是浏览器 classic script（依赖 window/document），无法 import——
// 沿用 test/perm-fab-jump.test.js 的做法，直接对源码做结构断言。
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const src = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

function extractClass(cls) {
  const re = new RegExp('\\.' + cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\{([^}]+)\\}')
  const m = src.match(re)
  assert.ok(m, `CSS class .${cls} not found in client.js`)
  return m[1]
}

describe('fab-panel-layout: max-height on both pop panels', () => {
  it('.ad-perm-pop has max-height', () => {
    const css = extractClass('ad-perm-pop')
    assert.match(css, /max-height:/, '.ad-perm-pop must have max-height')
    assert.match(css, /calc\(100vh\s*-\s*24px\)/, '.ad-perm-pop max-height must include calc(100vh - 24px) hard cap')
  })

  it('.ad-host-approval-pop has max-height', () => {
    const css = extractClass('ad-host-approval-pop')
    assert.match(css, /max-height:/, '.ad-host-approval-pop must have max-height')
    assert.match(css, /calc\(100vh\s*-\s*24px\)/, '.ad-host-approval-pop max-height must include calc(100vh - 24px) hard cap')
  })
})

describe('fab-panel-layout: scrollable message area with min-height:0', () => {
  it('.ad-perm-body has overflow-y:auto and min-height:0', () => {
    const css = extractClass('ad-perm-body')
    assert.match(css, /overflow-y:\s*auto/, '.ad-perm-body must have overflow-y:auto')
    assert.match(css, /min-height:\s*0/, '.ad-perm-body must have min-height:0')
    assert.match(css, /flex:\s*1\s+1\s+auto/, '.ad-perm-body must be the flex-growing area (flex:1 1 auto)')
    assert.match(css, /overscroll-behavior:\s*contain/, '.ad-perm-body must not chain scroll to the page')
  })

  it('.ad-ha-body has overflow-y:auto and min-height:0', () => {
    const css = extractClass('ad-ha-body')
    assert.match(css, /overflow-y:\s*auto/, '.ad-ha-body must have overflow-y:auto')
    assert.match(css, /min-height:\s*0/, '.ad-ha-body must have min-height:0')
    assert.match(css, /flex:\s*1\s+1\s+auto/, '.ad-ha-body must be the flex-growing area (flex:1 1 auto)')
    assert.match(css, /overscroll-behavior:\s*contain/, '.ad-ha-body must not chain scroll to the page')
  })
})

describe('fab-panel-layout: button area does not shrink', () => {
  it('.ad-perm-actions has flex-shrink:0 equivalent', () => {
    const css = extractClass('ad-perm-actions')
    assert.ok(
      /flex:\s*0\s+0\s+auto/.test(css) || /flex-shrink:\s*0/.test(css),
      '.ad-perm-actions must have flex:0 0 auto or flex-shrink:0'
    )
  })

  it('.ad-ha-actions has flex-shrink:0 equivalent', () => {
    const css = extractClass('ad-ha-actions')
    assert.ok(
      /flex:\s*0\s+0\s+auto/.test(css) || /flex-shrink:\s*0/.test(css),
      '.ad-ha-actions must have flex:0 0 auto or flex-shrink:0'
    )
  })

  it('action rows stick to the bottom of the scroll area (buttons always visible)', () => {
    for (const cls of ['ad-perm-actions', 'ad-ha-actions']) {
      const css = extractClass(cls)
      assert.match(css, /position:\s*sticky/, `.${cls} must use position:sticky`)
      assert.match(css, /bottom:\s*0/, `.${cls} must stick to bottom:0`)
    }
  })
})

describe('fab-panel-layout: width cap via max-width', () => {
  it('.ad-perm-pop has max-width', () => {
    const css = extractClass('ad-perm-pop')
    assert.match(css, /max-width:/, '.ad-perm-pop must have max-width')
    assert.match(css, /width:\s*min\(92vw,\s*520px\)/, '.ad-perm-pop must be widened to min(92vw,520px)')
    assert.match(css, /right:\s*84px/, '.ad-perm-pop must be offset left of the 44px fab (right:84px)')
  })

  it('.ad-host-approval-pop has max-width', () => {
    const css = extractClass('ad-host-approval-pop')
    assert.match(css, /max-width:/, '.ad-host-approval-pop must have max-width')
    assert.match(css, /width:\s*min\(92vw,\s*520px\)/, '.ad-host-approval-pop must be widened to min(92vw,520px)')
    assert.match(css, /right:\s*84px/, '.ad-host-approval-pop must be offset left of the 44px fab (right:84px)')
  })

  it('both fabs stay at right:22px so the panel never covers them', () => {
    assert.match(extractClass('ad-perm-fab'), /right:\s*22px/)
    assert.match(extractClass('ad-host-approval-fab'), /right:\s*22px/)
  })
})

describe('fab-panel-layout: per-item content limited height + scrollable', () => {
  it('.p-desc has max-height and overflow-y:auto', () => {
    const m = src.match(/\.ad-perm-item\s+\.p-desc\{([^}]+)\}/)
    assert.ok(m, '.ad-perm-item .p-desc CSS rule not found')
    assert.match(m[1], /max-height:/, '.p-desc must have max-height')
    assert.match(m[1], /overflow-y:\s*auto/, '.p-desc must have overflow-y:auto')
    assert.match(m[1], /overflow-wrap:\s*anywhere|word-break:\s*break-word/, '.p-desc must wrap long paths (no horizontal overflow)')
  })

  it('.ha-reason has max-height and overflow-y:auto', () => {
    const m = src.match(/\.ad-ha-item\s+\.ha-reason\{([^}]+)\}/)
    assert.ok(m, '.ad-ha-item .ha-reason CSS rule not found')
    assert.match(m[1], /max-height:/, '.ha-reason must have max-height')
    assert.match(m[1], /overflow-y:\s*auto/, '.ha-reason must have overflow-y:auto')
  })

  it('.ha-paths has max-height and overflow-y:auto', () => {
    const m = src.match(/\.ad-ha-item\s+\.ha-paths\{([^}]+)\}/)
    assert.ok(m, '.ad-ha-item .ha-paths CSS rule not found')
    assert.match(m[1], /max-height:/, '.ha-paths must have max-height')
    assert.match(m[1], /overflow-y:\s*auto/, '.ha-paths must have overflow-y:auto')
  })
})

describe('fab-panel-layout: vertical centering prevents viewport overflow', () => {
  it('.ad-perm-pop uses vertical centering', () => {
    const css = extractClass('ad-perm-pop')
    assert.match(css, /top:\s*50%/, '.ad-perm-pop must use top:50% for vertical centering')
    assert.match(css, /transform:\s*translateY\(-50%\)/, '.ad-perm-pop must use translateY(-50%) for vertical centering')
  })

  it('.ad-host-approval-pop uses vertical centering', () => {
    const css = extractClass('ad-host-approval-pop')
    assert.match(css, /top:\s*50%/, '.ad-host-approval-pop must use top:50% for vertical centering')
    assert.match(css, /transform:\s*translateY\(-50%\)/, '.ad-host-approval-pop must use translateY(-50%) for vertical centering')
  })
})

describe('fab-panel-layout: panels use flex column layout with overflow:hidden on pop', () => {
  it('.ad-perm-pop has flex-direction:column and overflow:hidden', () => {
    const css = extractClass('ad-perm-pop')
    assert.match(css, /flex-direction:\s*column/, '.ad-perm-pop must use flex-direction:column')
    assert.match(css, /overflow:\s*hidden/, '.ad-perm-pop must have overflow:hidden')
  })

  it('.ad-host-approval-pop has flex-direction:column and overflow:hidden', () => {
    const css = extractClass('ad-host-approval-pop')
    assert.match(css, /flex-direction:\s*column/, '.ad-host-approval-pop must use flex-direction:column')
    assert.match(css, /overflow:\s*hidden/, '.ad-host-approval-pop must have overflow:hidden')
  })

  it('.visible switches to display:flex (display:block would kill flex-direction)', () => {
    assert.match(extractClass('ad-perm-pop.visible'), /display:\s*flex/)
    assert.match(extractClass('ad-host-approval-pop.visible'), /display:\s*flex/)
  })
})

// ── DOM 结构不变量（CSS 断言覆盖不到，但改错就会把滚动布局整个拆掉）──
describe('fab-panel-layout: DOM structure (scroll container + content area)', () => {
  it('both panels create a popBody content area and mount it', () => {
    assert.equal((src.match(/pop\.appendChild\(popBody\)/g) || []).length, 2,
      'both fab panels must mount their popBody content area')
    assert.match(src, /popBody\.className\s*=\s*"ad-perm-body"/)
    assert.match(src, /popBody\.className\s*=\s*"ad-ha-body"/)
  })

  it('renderPop clears the content area, not the panel itself', () => {
    // 面板本体一旦被 textContent="" 清空，popBody 与 sticky 操作行就一起没了
    assert.equal((src.match(/popBody\.textContent\s*=\s*""/g) || []).length, 2,
      'both renderPop implementations must clear popBody')
  })

  it('rows and empty states go into the content area', () => {
    assert.equal((src.match(/popBody\.appendChild\(row\)/g) || []).length, 2,
      'both panels must append rows into popBody')
    assert.equal((src.match(/^\s*pop\.appendChild\(row\);/gm) || []).length, 0,
      'no row may be appended directly to the panel element')
    assert.equal((src.match(/popBody\.appendChild\(empty\)/g) || []).length, 2,
      'both empty states must go into popBody')
  })
})
