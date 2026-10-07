// @kiligzzz/dsh-agent-dispatch — client half。
//
// 浏览器半（classic script：__ModuleLoader__.load 注册 factory）。
//
// 架构：
//   ① 主面板挂宿主 conversation.view 槽（原生右 tab「Agent 调度」，
//     order=21，与 对话/轨迹/记忆系统 同级），4 个子 tab：
//     总览 / Agent / 小队 / 历史；
//   ② 会话头部「← 返回」按钮（conversation.session.header.actions 槽），
//     任何 tab 下可见，导航栈空时自动隐藏；
//   ③ 悬浮活动球（原生 DOM，document.body 挂载，可拖动 + 弹窗 + 光效）；
//   ④ / 触发器 Agent 候选菜单（inputTriggers 源）——选中插入 "$id "。
//
// 文案统一：面板与设置入口统称「Agent 调度」（工具名 agent_*
// 保持不变，那是 REST 契约）。与宿主半通过同源 REST（/agent-api*）
// 通信，保存即生效免重启。
//
// 硬约束备忘：
//   - 颜色一律用 DSH 语义化 token（--dsw-alias-* / --dsw-static-*），
//     适配亮/暗双主题，禁写死 #RRGGBB / rgb() 等绝对色值。
//   - 开关/单选/滑杆统一两态外观（灰底白球，位置区分），禁彩色/亮暗
//     反转区分状态（用户铁偏好，所有插件通用）。
//   - 无外部依赖；React 从 require("react") 获取，纯 createElement，
//     不用 JSX。

window.__ModuleLoader__.load({
  id: '@kiligzzz/dsh-agent-dispatch',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");

    // ── 样式（全部 DSH 语义化 token，无任何写死色值）──
    const CSS =
      ".ad-page{display:flex;flex-direction:column;gap:10px;height:100%;overflow:auto;padding:4px 2px 24px;font-size:13px;color:var(--dsw-alias-label-primary)}" +
      ".ad-head{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}" +
      ".ad-title{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".ad-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px;line-height:1.5;word-break:break-all}" +
      ".ad-btn{background:transparent;border:1px solid var(--ad-line-strong);color:var(--ad-muted);border-radius:7px;padding:4px 10px;font-size:12px;cursor:pointer;flex:none;transition:border-color .15s,color .15s,background-color .15s}" +
      ".ad-btn:hover{border-color:var(--ad-accent);color:var(--ad-text);background:var(--ad-hover)}" +
      ".ad-btn:disabled{opacity:.4;cursor:default}" +
      ".ad-btn:disabled:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}" +
      ".ad-btn.primary{border-color:var(--ad-accent);background:var(--ad-accent);color:var(--dsw-alias-label-primary-inverted);font-weight:600}" +
      ".ad-btn.primary:hover{opacity:.9;background:var(--ad-accent);color:var(--dsw-alias-label-primary-inverted)}" +
      ".ad-btn.danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
      ".ad-btn.mini{padding:2px 7px;font-size:11.5px}" +
      // v0.9.5：图标按钮（弹窗 ✕ 复用；卡片浮层已删）
      ".ad-btn.icon{width:26px;height:26px;padding:0;display:grid;place-items:center;border-radius:8px;font-size:12px;line-height:1;background:var(--ad-layer-2)}" +
      ".ad-btn.icon.danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}" +
      // v0.9.5：卡片点整体即编辑（无浮层按钮，开关常显可用）
      ".ad-row.editable{cursor:pointer}" +
      ".ad-row{position:relative}" +
      ".ad-squad-card{position:relative}" +
      ".ad-squad-card.editable{cursor:pointer}" +
      // v0.9.5：编辑弹窗（表单专用宽度，复用 ad-modal 体系）
      // v0.9.31：固定高度（用户：弹窗被内容撑出视口、底部按钮被裁）——
      // 根因：v0.9.25 毛玻璃给 .ad-panel 加 backdrop-filter，fixed 遮罩退化为相对面板定位，
      // max-height:88vh 一旦高于面板就溢出窗口底边。改 100% 网格区高度（上限 760）后弹窗不再长大，
      // 内容在 ad-modal-body 内滚（无头实测：100% 严丝合缝 overflowBottom=-23，vh 版本溢出 8px）。
      ".ad-modal.form{width:600px;height:min(760px,100%)}" +
      ".ad-modal.form.wide{width:660px}" +
      ".ad-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--dsw-alias-border-l1)}" +
      ".ad-list{display:flex;flex-direction:column;gap:8px}" +
      ".ad-row{display:flex;flex-direction:column;gap:5px;background:var(--ad-layer-1);border:1px solid var(--ad-line);border-radius:11px;padding:10px 12px;transition:border-color .15s,transform .15s}" +
      ".ad-row:hover{border-color:var(--ad-line-strong)}" +
      ".ad-row-main{display:flex;align-items:center;gap:8px;min-width:0}" +
      ".ad-emoji{flex:none;font-size:15px;line-height:1}" +
      ".ad-avatar{width:30px;height:30px;border-radius:9px;background:var(--ad-layer-2);border:1px solid var(--ad-line-strong);display:grid;place-items:center;font-size:15px;flex:none}" +
      // v0.8.9：无自设 emoji 时头像显示 DSH logo（品牌色，两主题可辨）
      ".ad-avatar .ad-dsh-logo,.ad-run-emoji .ad-dsh-logo{width:17px;height:17px;color:var(--dsw-alias-state-business-primary)}" +
      ".ad-name{flex:none;font-weight:500;color:var(--ad-text);font-size:13px}" +
      ".ad-id{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ad-faint);font-size:10px;font-family:var(--ad-mono)}" +
      ".ad-badge{flex:none;background:var(--ad-layer-2);border:1px solid var(--ad-line);color:var(--ad-muted);font-size:9px;letter-spacing:.08em;border-radius:999px;padding:1px 7px;text-transform:uppercase;font-family:var(--ad-mono)}" +
      ".ad-meta{color:var(--ad-faint);font-size:11px;line-height:1.5;word-break:break-all}" +
      // v0.8.2：卡片描述区标签化排版（标签小字徽标 + 内容同行，不挤成一行）
      ".ad-meta-label{flex:none;display:inline-block;background:var(--ad-layer-2);border:1px solid var(--ad-line);color:var(--ad-muted);font-size:9px;letter-spacing:.08em;border-radius:5px;padding:0 5px;margin-right:6px;font-family:var(--ad-mono);vertical-align:1px}" +
      // v0.8.2：小队执行流 SVG 拓扑图（全部走语义化 token，适配亮/暗主题）
      ".ad-flow-wrap{display:flex;flex-direction:column;gap:4px;min-width:0}" +
      ".ad-flow-preview{border:1px dashed var(--ad-line-strong);border-radius:10px;padding:8px 10px;margin-top:6px;display:flex;flex-direction:column;gap:4px}" +
      ".ad-flow-preview-fixed{width:340px;max-width:100%;overflow:hidden}" +
      ".ad-flow-svg{display:block;overflow:visible}" +
      // v0.9.3：SVG 走自然像素尺寸（width/height 属性=节点实际大小），容器只缩不放——单节点不再被拉伸撑满；表单预览容器保留等比缩放
      ".ad-flow-preview-fixed .ad-flow-svg{width:100%;height:auto}" +
      ".ad-flow-svg.clickable{cursor:pointer}" +
      ".ad-flow-svg .flow-rect{stroke:var(--ad-line-strong);stroke-width:1;transition:stroke .15s,filter .15s}" +
      ".ad-flow-svg .flow-rect-badge{fill:var(--ad-layer-2);stroke:var(--ad-line-strong);stroke-width:.8}" +
      ".ad-flow-svg .flow-grad-a{stop-color:var(--ad-layer-2)}" +
      ".ad-flow-svg .flow-grad-b{stop-color:var(--ad-layer-1)}" +
      ".ad-flow-svg .flow-arrow{fill:none;stroke:var(--ad-line-strong);stroke-width:1.5}" +
      ".ad-flow-svg .flow-marker{fill:var(--ad-line-strong)}" +
      ".ad-flow-svg .flow-step{font-size:8.5px;fill:var(--ad-faint);font-family:var(--ad-mono)}" +
      ".ad-flow-svg .flow-label{font-size:10.5px;font-weight:600;fill:var(--ad-text)}" +
      ".ad-flow-svg .flow-dep{font-size:7.5px;fill:var(--ad-faint);font-family:var(--ad-mono);text-anchor:end}" +
      ".ad-flow-svg .flow-layer{font-size:9px;fill:var(--ad-faint);font-family:var(--ad-mono);text-anchor:middle;letter-spacing:.08em}" +
      ".ad-flow-svg .flow-node:hover .flow-rect{stroke:var(--ad-accent);filter:drop-shadow(0 0 4px color-mix(in srgb,var(--ad-accent) 40%,transparent))}" +
      ".ad-flow-svg.large .flow-label{font-size:12px}" +
      ".ad-flow-svg.large .flow-step{font-size:9.5px}" +
      ".ad-flow-svg.large .flow-dep{font-size:8.5px}" +
      // v0.8.3：执行流弹窗（modal 大图 + 步骤说明）
      // v0.9.31：补明确 1fr 轨道——网格区高度确定，弹窗 height:min(720px,100%) 的百分比才能解析
      ".ad-modal-mask{position:fixed;inset:0;background:color-mix(in srgb,var(--dsw-alias-bg-base) 55%,transparent);backdrop-filter:blur(3px);z-index:99999;display:grid;grid-template-rows:1fr;grid-template-columns:1fr;place-items:center;padding:24px}" +
      // v0.9.3：执行流弹窗加大并固定（780×图区 300，超宽横向滚动，单节点居中不撑满）
      ".ad-modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:var(--dsw-shadow-lv3);width:780px;max-width:calc(100vw - 48px);max-height:88vh;display:flex;flex-direction:column;overflow:hidden;animation:ad-modal-in .18s ease}" +
      "@keyframes ad-modal-in{from{opacity:0;transform:scale(.96) translateY(6px)}to{opacity:1;transform:none}}" +
      ".ad-modal-graph{flex:none;height:300px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);display:flex;overflow-x:auto;overflow-y:hidden;padding:8px}" +
      ".ad-modal-graph .ad-flow-svg{margin:auto;flex:none;max-height:100%}" +
      ".ad-modal-head{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}" +
      ".ad-modal-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".ad-modal-body{flex:1;min-height:0;overflow:auto;padding:14px 16px;display:flex;flex-direction:column;gap:12px}" +
      ".ad-modal-desc{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.5}" +
      ".ad-modal-steps{display:flex;flex-direction:column;gap:6px}" +
      ".ad-modal-step{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}" +
      ".ad-modal-step-h{display:flex;align-items:center;gap:8px;flex-wrap:wrap}" +
      ".ad-modal-step-no{flex:none;font:700 10px/1 var(--ds-font-family-code,ui-monospace,monospace);color:var(--dsw-alias-label-primary-inverted);background:var(--dsw-alias-brand-primary);border-radius:5px;padding:3px 6px}" +
      ".ad-modal-step-name{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".ad-modal-step-dep{font-size:9.5px;color:var(--dsw-alias-label-tertiary);font-family:var(--ds-font-family-code,ui-monospace,monospace)}" +
      ".ad-modal-step-inst{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:1.55;margin-top:5px;white-space:pre-wrap;word-break:break-all}" +
      ".ad-graph-empty{color:var(--ad-faint);font-size:10.5px;padding:6px 2px}" +
      ".ad-switch{position:relative;width:30px;height:17px;border-radius:999px;background:var(--dsw-static-neutral-bluish-600);border:none;padding:0;cursor:pointer;flex:none;transition:opacity .15s}" +
      ".ad-switch:hover{opacity:.85}" +
      ".ad-switch .knob{position:absolute;top:2px;left:2px;width:13px;height:13px;border-radius:50%;background:var(--dsw-static-neutral-bluish-00);transition:left .15s}" +
      ".ad-switch.on .knob{left:15px}" +
      ".ad-form{display:flex;flex-direction:column;gap:10px;background:var(--ad-layer-2);border:1px solid var(--ad-line);border-radius:11px;padding:14px}" +
      // v0.9.5：表单嵌进编辑弹窗时压平（去掉盒中盒卡片底）
      ".ad-modal.form .ad-form{background:transparent;border:none;padding:0}" +
      ".ad-field{display:flex;flex-direction:column;gap:4px}" +
      ".ad-label{font-size:11.5px;color:var(--dsw-alias-label-secondary)}" +
      ".ad-input{width:100%;box-sizing:border-box;background:var(--ad-bg);border:1px solid var(--ad-line-strong);border-radius:8px;color:var(--ad-text);font-size:12.5px;padding:6px 9px;outline:none;transition:border-color .15s}" +
      ".ad-input:focus{border-color:var(--ad-accent)}" +
      ".ad-input:disabled{color:var(--dsw-alias-label-secondary);cursor:not-allowed}" +
      ".ad-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;padding:6px 8px;outline:none;font-family:ui-monospace,Menlo,monospace;resize:vertical}" +
      ".ad-textarea.tall{min-height:180px;line-height:1.6}" +
      ".ad-textarea:focus{border-color:var(--dsw-alias-brand-primary)}" +
      ".ad-routes{display:flex;flex-direction:column;gap:6px}" +
      // v0.9.7：模型路由行卡片化（对齐步骤卡片语言）
      ".ad-route{display:flex;align-items:center;gap:6px;background:var(--ad-layer-2);border:1px solid var(--ad-line);border-radius:9px;padding:8px 10px}" +
      ".ad-route:hover{border-color:var(--ad-line-strong)}" +
      ".ad-route .ad-input{flex:1;min-width:0}" +
      ".ad-route .ad-input.effort{flex:none;width:86px}" +
      ".ad-select{appearance:auto;cursor:pointer}" +
      ".ad-actions{display:flex;gap:6px;justify-content:flex-end}" +
      ".ad-err{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-error-primary);border-radius:6px;padding:6px 8px;font-size:12px;white-space:pre-wrap;word-break:break-all}" +
      ".ad-empty{color:var(--dsw-alias-label-secondary);font-size:12.5px;padding:14px 4px;text-align:center}" +
      ".ad-sec-title{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".ad-sec-head{display:flex;align-items:center;justify-content:space-between;gap:8px}" +
      // 组队管理（独立子 tab）
      ".ad-squad{display:flex;flex-direction:column;gap:6px;margin-top:8px}" +
      ".ad-squad-card{display:flex;flex-direction:column;gap:5px;background:var(--ad-layer-1);border:1px solid var(--ad-line);border-radius:11px;padding:10px 12px;transition:border-color .15s,transform .15s}" +
      ".ad-squad-card:hover{border-color:var(--ad-line-strong)}" +
      // v0.9：小队卡一行 2 个（窄面板降单列）；v0.9.3：卡片恢复流程图缩略（固定 96px 高，只缩不放）
      ".ad-squad-list{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}" +
      "@media (max-width:900px){.ad-squad-list{grid-template-columns:1fr}}" +
      ".ad-squad-card-main{display:flex;flex-direction:column;gap:8px;min-width:0}" +
      ".ad-squad-info{min-width:0;display:flex;flex-direction:column;gap:7px}" +
      // v0.9.3：卡片流程图固定高度区——SVG 自然尺寸居中（margin:auto，防超宽内容滚动截断）；点击整体放大弹窗
      ".ad-graph-box{height:96px;border:1px solid var(--ad-line);border-radius:9px;background:var(--ad-layer-2);display:flex;overflow-x:auto;overflow-y:hidden;cursor:zoom-in;padding:6px 8px}" +
      ".ad-graph-box:hover{border-color:var(--ad-line-strong)}" +
      ".ad-graph-box .ad-flow-svg{margin:auto;flex:none;max-height:100%}" +
      ".ad-graph-hint{display:flex;align-items:center;justify-content:space-between;font-size:9.5px;color:var(--ad-faint)}" +
      ".ad-squad-steps{font-size:11.5px;color:var(--ad-text);background:var(--ad-layer-2);border:1px solid var(--ad-line);border-radius:7px;padding:4px 9px;word-break:break-all}" +
      // 组队表单的步骤编辑器（v0.9.6：每步骤独立卡片，头行=序号+阶段+Agent+操作，任务模板独立行）
      ".ad-step-list{display:flex;flex-direction:column;gap:8px}" +
      ".ad-step-item{display:flex;flex-direction:column;gap:8px;background:var(--ad-layer-2);border:1px solid var(--ad-line);border-radius:10px;padding:10px 12px}" +
      ".ad-step-item:hover{border-color:var(--ad-line-strong)}" +
      ".ad-step-row{display:flex;flex-wrap:wrap;align-items:center;gap:6px}" +
      ".ad-step-no{flex:none;min-width:28px;text-align:center;font-size:10.5px;font-weight:600;font-family:var(--ad-mono);letter-spacing:.04em;color:var(--dsw-static-neutral-bluish-00);background:var(--ad-accent);border-radius:6px;padding:3px 6px}" +
      ".ad-step-row .ad-input.phase{flex:1;min-width:120px}" +
      ".ad-step-row .ad-input.agent{flex:none;width:190px}" +
      ".ad-step-item .ad-textarea{font-size:12px}" +
      ".ad-step-item .ad-step-acts{display:flex;gap:4px;margin-left:auto}" +
      ".ad-step-deps{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;width:100%;font-size:11.5px;color:var(--dsw-alias-label-secondary);padding-left:2px}" +
      ".ad-dep-check{display:inline-flex;align-items:center;gap:4px;cursor:pointer;user-select:none}" +
      // ── v0.7 设计语言（学记忆系统 MnemonView：shell 变量映射 + kicker + liveDot + 空态）──
      // 面板根上定义 --ad-* 变量层，映射到 dsw-alias token，亮/暗主题自动跟随
      ".ad-panel{--ad-bg:var(--dsw-alias-bg-base);--ad-layer-1:var(--dsw-alias-bg-layer-1);--ad-layer-2:var(--dsw-alias-bg-layer-2);--ad-text:var(--dsw-alias-label-primary);--ad-muted:var(--dsw-alias-label-secondary);--ad-faint:var(--dsw-alias-label-tertiary);--ad-line:var(--dsw-alias-border-l1);--ad-line-strong:var(--dsw-alias-border-l2);--ad-accent:var(--dsw-alias-state-business-primary);--ad-green:var(--dsw-alias-state-success-primary);--ad-red:var(--dsw-alias-state-error-primary);--ad-hover:var(--dsw-alias-interactive-bg-hover);--ad-mono:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);display:flex;flex-direction:column;height:100%;min-height:0;font-size:13px;color:var(--ad-text);box-sizing:border-box}" +
      // v0.9.21：整面板毛玻璃化。v0.9.25 修正：右侧 tab 页背后是宿主实色壁，纯 backdrop-filter 看不出；
      // 改「玻璃拟态」=半透明提亮渐变 + 1px 玻璃边框 + 顶部内高光 + 软阴影（语义 token，亮暗自适应；悬浮球代码不动）
      ".ad-panel{background:linear-gradient(160deg,color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent),color-mix(in srgb,var(--dsw-alias-bg-base) 92%,transparent));backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 65%,transparent);border-radius:14px;box-shadow:inset 0 1px 0 color-mix(in srgb,var(--dsw-alias-bg-layer-2) 60%,transparent),var(--dsw-shadow-lv3)}" +
      ".ad-panel .ad-row,.ad-panel .ad-route{background:color-mix(in srgb,var(--ad-layer-1) 62%,transparent)}" +
      ".ad-panel .ad-hist-preview,.ad-panel .ad-hist-taskbox{background:color-mix(in srgb,var(--ad-layer-1) 62%,transparent)}" +
      ".ad-panel *,.ad-panel :before,.ad-panel :after{box-sizing:border-box}" +
      ".ad-panel-head{display:flex;align-items:center;gap:10px;padding:12px 16px 10px;flex:none}" +
      // v0.9.28：返回按钮升到会话头部槽 conversation.session.header.actions（任何 tab 下可见，一跳返回）；
      // 渲染在 .ad-panel 之外，样式必须自包含（语义化 token，不引用面板内 --ad-* 变量）
      ".ad-header-back{display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);border-radius:7px;padding:3px 10px;font-size:12px;font-weight:600;cursor:pointer;transition:border-color .15s,color .15s}" +
      ".ad-header-back:hover{border-color:var(--dsw-alias-label-tertiary);color:var(--dsw-alias-label-primary)}" +
      // v0.8.9：logo 去渐变底——DSH 官方图形品牌色直出，亮/暗主题均可辨
      ".ad-logo{width:26px;height:26px;display:grid;place-items:center;flex:none}" +
      // v0.9.5：头部 logo 白色（label-primary：暗主题下即白色，亮主题保持可见）
      ".ad-logo .ad-dsh-logo{width:26px;height:26px;color:var(--dsw-alias-label-primary)}" +
      ".ad-dsh-logo{width:18px;height:18px;display:block;color:var(--dsw-alias-state-business-primary)}" +
      ".ad-fab .ad-dsh-logo{width:22px;height:22px;color:var(--dsw-static-neutral-1000)}" +
      ".ad-fab-pop-title .ad-dsh-logo{width:16px;height:16px;color:var(--dsw-alias-label-primary)}" +
      ".ad-panel-title{font-size:16px;font-weight:600;letter-spacing:-.01em}" +
      ".ad-live-pill{margin-left:auto;display:flex;align-items:center;gap:6px;font-size:11px;color:var(--ad-muted);border:1px solid var(--ad-line-strong);border-radius:999px;padding:4px 11px;background:var(--ad-layer-1);flex:none}" +
      ".ad-live-pill .ad-dot{width:6px;height:6px}" +
      ".ad-dot{border-radius:50%;width:6px;height:6px;flex:none;display:inline-block}" +
      ".ad-dot.on{background:var(--ad-green);box-shadow:0 0 0 3px color-mix(in srgb,var(--ad-green) 15%,transparent);animation:ad-pulse 1.8s ease-in-out infinite}" +
      ".ad-dot.off{background:var(--ad-faint)}" +
      "@keyframes ad-pulse{0%,100%{opacity:1}50%{opacity:.45}}" +
      ".ad-subtabs{display:flex;gap:2px;padding:0 12px;border-bottom:1px solid var(--ad-line);flex:none;overflow-x:auto}" +
      ".ad-subtab{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--ad-faint);font-size:12.5px;padding:8px 14px;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:5px}" +
      ".ad-subtab:hover{color:var(--ad-muted)}" +
      ".ad-subtab.on{color:var(--ad-text);border-bottom-color:var(--ad-accent)}" +
      ".ad-subtab .n{background:var(--ad-layer-2);color:var(--ad-muted);font-size:10px;border-radius:8px;padding:0 6px}" +
      ".ad-subtab.on .n{background:color-mix(in srgb,var(--ad-accent) 16%,transparent);color:var(--ad-accent)}" +
      ".ad-panel-body{flex:1;min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:14px}" +
      ".ad-kicker{color:var(--ad-faint);font:650 9px/1.2 var(--ad-mono);letter-spacing:.12em;text-transform:uppercase}" +
      ".ad-kicker-row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex:none}" +
      ".ad-kicker-row .meta{font-size:10px;color:var(--ad-faint);white-space:nowrap}" +
      // v0.9.36：总览页顶部设置卡片（原设置页信息迁入）——边框卡片，与 ad-stat 语言一致，悬浮球开关复用 ad-switch
      ".ad-set-card{border:1px solid var(--ad-line);background:var(--ad-layer-1);border-radius:11px;padding:4px 12px;display:flex;flex-direction:column;gap:0;flex:none}" +
      ".ad-set-card .ad-set-row{display:flex;align-items:center;gap:10px;padding:9px 0;border-bottom:1px solid var(--ad-line);min-width:0}" +
      ".ad-set-card .ad-set-row:last-child{border-bottom:none}" +
      ".ad-set-card .grow{flex:1;min-width:0}" +
      ".ad-set-card .t1{font-size:12.5px;font-weight:600;color:var(--ad-text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-set-card .t2{font-size:11px;color:var(--ad-faint);margin-top:2px;line-height:1.5;overflow-wrap:break-word}" +
      ".ad-stats{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;flex:none}" +
      ".ad-stat{border:1px solid var(--ad-line);background:var(--ad-layer-1);border-radius:11px;padding:10px 11px;display:flex;flex-direction:column;gap:3px;min-width:0;transition:border-color .15s}" +
      ".ad-stat:hover{border-color:var(--ad-line-strong)}" +
      ".ad-stat .v{font-size:19px;font-weight:600;line-height:1.1;font-family:var(--ad-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      // v0.9.8：统计数字全部改静态近白（含高亮数字，两主题可见）
      ".ad-stat .v{color:var(--dsw-static-neutral-bluish-00)}" +
      ".ad-stat.hl .v{color:var(--dsw-static-neutral-bluish-00)}" +
      ".ad-stat .k{font-size:10px;color:var(--ad-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-run-card{border:1px solid var(--ad-line-strong);border-left:3px solid var(--ad-green);background:var(--ad-layer-1);border-radius:11px;padding:11px 13px;display:flex;align-items:center;gap:11px;transition:transform .15s,background-color .15s,border-color .15s}" +
      ".ad-run-card:hover{transform:translateY(-1px);background:var(--ad-layer-2)}" +
      ".ad-run-card.clickable{cursor:pointer}" +
      ".ad-run-emoji{width:34px;height:34px;border-radius:9px;background:var(--ad-layer-2);border:1px solid var(--ad-line-strong);display:grid;place-items:center;font-size:17px;flex:none}" +
      ".ad-run-mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}" +
      ".ad-run-name{font-size:13px;font-weight:500;display:flex;align-items:center;gap:7px;min-width:0}" +
      ".ad-run-name .cid{font:10px var(--ad-mono);color:var(--ad-faint);flex:none}" +
      ".ad-run-task{font-size:11px;color:var(--ad-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-run-badge{display:flex;align-items:center;gap:5px;font-size:10px;color:var(--ad-green);border:1px solid color-mix(in srgb,var(--ad-green) 22%,transparent);background:color-mix(in srgb,var(--ad-green) 9%,transparent);border-radius:999px;padding:2px 8px;flex:none;white-space:nowrap}" +
      // v1.8.0：待授权胶囊（ACP 权限审批挂起，弹窗在该子代理会话界面）
      ".ad-pending-badge{display:flex;align-items:center;gap:5px;font-size:10px;color:#e8a33d;border:1px solid color-mix(in srgb,#e8a33d 40%,transparent);background:color-mix(in srgb,#e8a33d 12%,transparent);border-radius:999px;padding:2px 8px;flex:none;white-space:nowrap;cursor:help;animation:ad-pending-pulse 1.6s ease-in-out infinite}" +
      "@keyframes ad-pending-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,#e8a33d 30%,transparent)}50%{box-shadow:0 0 0 4px color-mix(in srgb,#e8a33d 0%,transparent)}}" +
      // v1.8.0：独立「待授权」悬浮球（有 ACP 权限请求待批时出现，处理完自动消失）
      ".ad-perm-fab{position:fixed;right:22px;top:calc(50% - 22px);width:44px;height:44px;border-radius:50%;display:none;place-items:center;background:linear-gradient(135deg,#f0b34d,#e8932a);color:#fff;font-size:19px;cursor:pointer;user-select:none;z-index:9998;box-shadow:0 4px 16px color-mix(in srgb,#e8932a 45%,transparent);animation:ad-perm-pulse 1.2s ease-in-out infinite;font-family:var(--ad-mono,monospace)}" +
      ".ad-perm-fab.visible{display:grid}" +
      ".ad-perm-fab .perm-count{position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;border-radius:9px;background:#c62828;color:#fff;font-size:10px;line-height:17px;text-align:center;padding:0 4px;font-weight:700}" +
      "@keyframes ad-perm-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,#e8932a 55%,transparent),0 4px 16px color-mix(in srgb,#e8932a 40%,transparent)}50%{box-shadow:0 0 0 8px color-mix(in srgb,#e8932a 12%,transparent),0 4px 16px color-mix(in srgb,#e8932a 40%,transparent)}}" +
      // v1.11.15(UI)：限高 + 内部滚动 + 加宽 + 不遮挡浮球。旧实现 top:calc(50% + 30px)
      // + max-height:60vh 会让面板下沿越出视口：内容一长，授权按钮被顶到屏幕外、又
      // 滚不到 → 点不了。改为垂直居中、硬限高、内容区独立滚动、操作行 sticky 常驻。
      // right 从 22px 让到 84px，避免面板盖住 44px 的浮球（否则关不掉）。
      ".ad-perm-pop{position:fixed;right:84px;top:50%;transform:translateY(-50%);width:min(92vw,520px);max-width:calc(100vw - 100px);max-height:min(70vh,640px,calc(100vh - 24px));overflow:hidden;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid color-mix(in srgb,#e8a33d 45%,transparent);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 8px 30px rgba(0,0,0,.25));z-index:9998;display:none;flex-direction:column;padding:0;font-size:12px;line-height:1.45;backdrop-filter:blur(10px)}" +
      ".ad-perm-pop.visible{display:flex}" +
      ".ad-perm-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px}" +
      ".ad-perm-item{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}" +
      ".ad-perm-item:hover{background:color-mix(in srgb,#e8a33d 10%,transparent);border-color:color-mix(in srgb,#e8a33d 25%,transparent)}" +
      ".ad-perm-item .p-name{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}" +
      // v1.11.15(UI)：单条消息限高 + 可滚动（长 reason/长路径不再把整条撑高）
      ".ad-perm-item .p-desc{color:#8a6a2e;overflow-wrap:anywhere;word-break:break-word;max-height:180px;overflow-y:auto;overscroll-behavior:contain}" +
      ".ad-perm-item .p-go{color:#b3741c;font-weight:600}" +
      // v1.12.15：高危专用行（两条通道共用）。命令内容 pre-wrap + 独立滚动区——
      // 用户必须能看到命中片段在**命令尾部**的那一种，空白不折叠、不二次加工。
      ".ad-perm-item.ad-danger-item{cursor:default;background:color-mix(in srgb,#d33 6%,transparent);border:1px solid color-mix(in srgb,#d33 28%,transparent)}" +
      ".ad-perm-item.ad-danger-item:hover{background:color-mix(in srgb,#d33 9%,transparent);border-color:color-mix(in srgb,#d33 38%,transparent)}" +
      ".ad-danger-item .ad-danger-title{font-weight:700;color:#a31515;font-size:13px}" +
      ".ad-danger-item .ad-danger-meta{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}" +
      ".ad-danger-item .ad-danger-rule{color:#a33;font-weight:600;overflow-wrap:anywhere;word-break:break-word}" +
      ".ad-danger-item .ad-danger-seg{color:#a31515;font-weight:600;font-family:var(--ad-mono,monospace);overflow-wrap:anywhere;word-break:break-word}" +
      ".ad-danger-item .ad-danger-cmdlabel,.ad-danger-item .ad-danger-cmdcut{color:var(--dsw-alias-label-tertiary,inherit);font-size:10.5px}" +
      ".ad-danger-item .ad-danger-cmd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;font-family:var(--ad-mono,monospace);font-size:11px;color:var(--dsw-alias-label-primary,inherit);background:color-mix(in srgb,#d33 8%,transparent);border:1px solid color-mix(in srgb,#d33 20%,transparent);border-radius:6px;padding:4px 6px;max-height:180px;overflow-y:auto;overscroll-behavior:contain}" +
      ".ad-danger-item .ad-danger-note{color:#a33;font-size:11px;font-weight:600}" +
      ".ad-danger-item .ad-danger-actions{display:flex;gap:6px;flex-wrap:wrap;position:sticky;bottom:0}" +
      ".ad-perm-empty{padding:10px;color:var(--dsw-alias-label-tertiary,inherit);text-align:center}" +
      // v1.9.0：授权项信息行 + 操作行（决策按钮）
      ".ad-perm-info{display:flex;flex-direction:column;gap:3px}" +
      // v1.11.15(UI)：操作行常驻可见——sticky 贴住滚动区底部，内容再长按钮也不会被顶出视口
      ".ad-perm-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:7px;flex:0 0 auto;position:sticky;bottom:0;background:var(--dsw-alias-bg-layer-2,#fff);padding:6px 2px 2px;border-top:1px solid color-mix(in srgb,#e8a33d 22%,transparent)}" +
      ".ad-perm-actions .ad-btn{font-size:10px;padding:3px 8px}" +
      // v1.10.0：宿主审批浮球（主代理审批请求——4 按钮面板）
      ".ad-host-approval-fab{position:fixed;right:22px;top:calc(50% + 80px);width:44px;height:44px;border-radius:50%;display:none;place-items:center;background:linear-gradient(135deg,#4a90d9,#357abd);color:#fff;font-size:18px;cursor:pointer;user-select:none;z-index:9998;box-shadow:0 4px 16px color-mix(in srgb,#357abd 45%,transparent);animation:ad-host-approval-pulse 1.6s ease-in-out infinite;font-family:var(--ad-mono,monospace)}" +
      ".ad-host-approval-fab.visible{display:grid}" +
      ".ad-host-approval-fab .ha-count{position:absolute;top:-4px;right:-4px;min-width:17px;height:17px;border-radius:9px;background:#c62828;color:#fff;font-size:10px;line-height:17px;text-align:center;padding:0 4px;font-weight:700}" +
      "@keyframes ad-host-approval-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,#357abd 40%,transparent),0 4px 16px color-mix(in srgb,#357abd 45%,transparent)}50%{box-shadow:0 0 0 6px color-mix(in srgb,#357abd 10%,transparent),0 4px 16px color-mix(in srgb,#357abd 45%,transparent)}}" +
      // v1.11.15(UI)：与黄球面板同一套约束——垂直居中、硬限高、内容区独立滚动、
      // 操作行 sticky 常驻；right 让到 84px 不遮挡浮球；面板加宽到 min(92vw,520px)。
      ".ad-host-approval-pop{position:fixed;right:84px;top:50%;transform:translateY(-50%);width:min(92vw,520px);max-width:calc(100vw - 100px);max-height:min(70vh,640px,calc(100vh - 24px));overflow:hidden;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid color-mix(in srgb,#357abd 45%,transparent);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 8px 30px rgba(0,0,0,.25));z-index:9998;display:none;flex-direction:column;padding:0;font-size:12px;line-height:1.45;backdrop-filter:blur(10px)}" +
      ".ad-host-approval-pop.visible{display:flex}" +
      ".ad-ha-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:6px}" +
      ".ad-ha-item{display:flex;flex-direction:column;gap:3px;padding:8px 10px;border-radius:8px;border:1px solid transparent}" +
      ".ad-ha-item .ha-tool{font-weight:600;color:var(--dsw-alias-label-primary,inherit)}" +
      // v1.11.15(UI)：单条消息限高 + 滚动，路径列表同样限高（原来只限高 60px 但无 overscroll 约束）
      ".ad-ha-item .ha-reason{color:var(--dsw-alias-label-secondary,inherit);font-size:11px;overflow-wrap:anywhere;word-break:break-word;max-height:180px;overflow-y:auto;overscroll-behavior:contain}" +
      // v1.12.6（终审 M3）：危险命令门命中的条目——「每次都问、不可记忆」必须显眼
      ".ad-ha-item .ha-danger{color:#a33;font-size:11px;font-weight:600;overflow-wrap:anywhere;word-break:break-word;background:color-mix(in srgb,#d33 10%,transparent);border:1px solid color-mix(in srgb,#d33 30%,transparent);border-radius:6px;padding:4px 6px}" +
      ".ad-ha-item .ha-paths{color:var(--dsw-alias-label-tertiary,inherit);font-size:10px;font-family:var(--ad-mono,monospace);overflow-wrap:anywhere;word-break:break-word;max-height:120px;overflow-y:auto;overscroll-behavior:contain}" +
      ".ad-ha-item .ha-cwd{color:var(--dsw-alias-label-tertiary,inherit);font-size:9.5px;font-family:var(--ad-mono,monospace)}" +
      // v1.11.15(UI)：操作行常驻可见（同黄球面板）
      ".ad-ha-actions{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px;flex:0 0 auto;position:sticky;bottom:0;background:var(--dsw-alias-bg-layer-2,#fff);padding:6px 2px 2px;border-top:1px solid color-mix(in srgb,#357abd 22%,transparent)}" +
      ".ad-ha-actions .ad-btn{font-size:10px;padding:3px 8px}" +
      ".ad-ha-empty{padding:10px;color:var(--dsw-alias-label-tertiary,inherit);text-align:center;font-size:11px}" +
      // v1.12.6 U2/U3：「可编辑路径」授权弹框。布局硬要求同 1.11.15 的面板契约：
      // 遮罩自身可滚动（视口很矮时整框可移入视野）、框体硬限高 + overflow:hidden、
      // 内容区 flex:1 1 auto + min-height:0 + overflow-y:auto 承担滚动、
      // 目录列表（每组一个 .ad-grant-rows）再独立限高可滚动、
      // 操作行 flex:0 0 auto + sticky bottom 常驻可见。
      // 少任何一环，长目录列表就会把「确认」按钮顶出屏幕（1.11.15 的现场缺陷形态）。
      // v1.12.6 U4：textarea 换成「复选 + 单行输入」的目录行，且分两组渲染，
      // 所以滚动位从「一个输入区」变成「每组各自的列表」。
      ".ad-grant-mask{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:12px;overflow:auto;overscroll-behavior:contain;background:rgba(0,0,0,.35)}" +
      ".ad-grant-pop{flex:0 0 auto;width:min(92vw,560px);max-width:calc(100vw - 24px);max-height:min(80vh,calc(100vh - 24px));display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid color-mix(in srgb,#e8a33d 45%,transparent);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 8px 30px rgba(0,0,0,.25));font-size:12px;line-height:1.45}" +
      ".ad-grant-head{flex:0 0 auto;padding:10px 12px 4px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}" +
      ".ad-grant-note{flex:0 0 auto;padding:0 12px 6px;color:var(--ad-muted);font-size:11px;overflow-wrap:anywhere;word-break:break-word}" +
      ".ad-grant-body{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;padding:0 12px;display:flex;flex-direction:column;gap:6px}" +
      ".ad-grant-group{flex:0 0 auto;display:flex;flex-direction:column;gap:3px;padding:2px 0;border-top:1px dashed var(--ad-line)}" +
      ".ad-grant-gtitle{flex:0 0 auto;font-size:11px;font-weight:600;color:var(--ad-text);overflow-wrap:anywhere;word-break:break-word}" +
      ".ad-grant-gsub{flex:0 0 auto;font-size:11px;color:var(--ad-muted);overflow-wrap:anywhere;word-break:break-word}" +
      ".ad-grant-gempty{flex:0 0 auto;font-size:11px;color:var(--ad-muted);font-style:italic;padding:2px 0}" +
      ".ad-grant-rows{flex:0 0 auto;display:flex;flex-direction:column;gap:4px;max-height:min(30vh,220px);overflow-y:auto;overscroll-behavior:contain}" +
      ".ad-grant-row{flex:0 0 auto;display:flex;align-items:center;gap:6px;min-width:0}" +
      ".ad-grant-chk{flex:0 0 auto;width:14px;height:14px;margin:0;cursor:pointer}" +
      ".ad-grant-dir{flex:1 1 auto;min-width:0;box-sizing:border-box;font-family:var(--ad-mono,monospace);font-size:11.5px;line-height:1.5;padding:5px 8px;border-radius:8px;border:1px solid var(--ad-line-strong);background:var(--ad-layer-2);color:var(--ad-text)}" +
      // v1.12.6 U3：路径输入区的「自重限高可滚」契约（目录几十条时不撑爆面板）。
      // 结构从 1.11.15 的单框 textarea 换成「一行一个 input」，但滚动契约不变：
      // 单个输入区自身限高 + 可滚 + 盒模型不外溢（.ad-grant-rows 另有一道同款限高）。
      ".ad-grant-input{flex:0 0 auto;width:100%;box-sizing:border-box;min-height:96px;max-height:min(38vh,260px);overflow-y:auto;overscroll-behavior:contain}" +
      ".ad-grant-del{flex:0 0 auto;width:22px;height:22px;line-height:1;padding:0;border-radius:6px;cursor:pointer}" +
      ".ad-grant-add{flex:0 0 auto;align-self:flex-start;font-size:11px;padding:3px 8px;border-radius:6px;cursor:pointer}" +
      ".ad-grant-hint{flex:0 0 auto;font-size:11px;color:#8a6a2e;overflow-wrap:anywhere;word-break:break-word}" +
      // v1.12.6（终审 M3）：门命中的提示条——危险命令永远不可记忆，必须显眼
      ".ad-grant-danger{flex:0 0 auto;font-size:11px;line-height:1.5;color:#a33;background:color-mix(in srgb,#d33 10%,transparent);border:1px solid color-mix(in srgb,#d33 30%,transparent);border-radius:8px;padding:6px 8px;overflow-wrap:anywhere;word-break:break-word}" +
      ".ad-grant-hint.warn{color:#c62828;font-weight:600}" +
      // v1.12.6 第五轮（终审 M-B）：非绝对路径行下的提示（默认不勾选的原因）。
      // 用户把该行改成绝对路径后整类换成 `-ok`（该 class 单独 display:none）⇒ 提示收起；
      // 再改回相对路径时 syncHint 会把基类加回来。
      ".ad-grant-rowwarn{flex:0 0 auto;font-size:10.5px;line-height:1.45;color:#a33;padding:0 0 0 20px;overflow-wrap:anywhere;word-break:break-word}" +
      ".ad-grant-rowwarn-ok{display:none}" +
      // 弹框最后一行：当前工具名**只读**（删空后规则会退化成这个工具名，用户必须看得见它）
      ".ad-grant-tool{flex:0 0 auto;font-size:11px;font-family:var(--ad-mono,monospace);color:var(--ad-muted);border-top:1px dashed var(--ad-line);padding:5px 0 2px;overflow-wrap:anywhere;word-break:break-word;user-select:text}" +
      ".ad-grant-actions{flex:0 0 auto;position:sticky;bottom:0;display:flex;flex-wrap:wrap;gap:6px;justify-content:flex-end;padding:8px 12px;background:var(--dsw-alias-bg-layer-2,#fff);border-top:1px solid color-mix(in srgb,#e8a33d 25%,transparent)}" +
      // v1.12.6(UI 修复)：弹框挂在 document.body 上，**不在 .ad-panel 作用域内**，而 --ad-accent
      // 只在 `.ad-panel{…}` 里定义 ⇒ 弹框内 `.ad-btn.primary` 的 `background:var(--ad-accent)` 属于
      // 「计算值阶段无效」（IACVT）：背景回退成 transparent、border-color 回退成 currentColor
      // （＝该按钮的文字色 label-primary-inverted＝白）⇒ 浅色背景下「确认」就是白底白字，
      // 用户看到的就是「灰色、看不清」。修法：只给本弹框的确认按钮新增 .ad-grant-ok 一个类，
      // 显式用插件既有主色 token 落地（不新增任何色值，也不改 .ad-btn.primary 本体与其消费者）。
      // 用 var(--ad-accent, …) 兜底：将来该弹框若被放进 .ad-panel 作用域，直接沿用同款 accent。
      ".ad-grant-actions .ad-btn.ad-grant-ok{background:var(--ad-accent,var(--dsw-alias-state-business-primary));border-color:var(--ad-accent,var(--dsw-alias-state-business-primary));color:var(--dsw-alias-label-primary-inverted)}" +
      // 焦点：键盘 Tab 走到时给蓝色描边环（鼠标点击不触发 :focus-visible，保持原观感）。
      // 悬停沿用全局 `.ad-btn.primary:hover{opacity:.9}`——底色仍是主色，与面板主按钮同一套反馈。
      ".ad-grant-actions .ad-btn.ad-grant-ok:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent);outline-offset:2px}" +
      // 禁用：明显降权（主色 26% 浅底 + 42% 描边）但文字换成高对比的 label-primary ⇒ 一眼可辨、不糊。
      // 选择器比 `.ad-btn:disabled`（opacity:.4）与 `.ad-btn:disabled:hover` 更具体，禁用态悬停不会退化。
      ".ad-grant-actions .ad-btn.ad-grant-ok:disabled{opacity:1;cursor:default;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent);color:var(--dsw-alias-label-primary,inherit)}" +
      // v1.12.7（用户裁定）：路径列表为空时的**二级选择**浮层。位置用 fixed 覆盖整个视口
      // （不依赖 .ad-grant-pop 是否定位），卡片沿用弹框自身那套 token 与色值——
      // 遮罩色 `rgba(0,0,0,.35)` 与卡片阴影 `var(--dsw-shadow-lv3,…)` 都直接复用上面
      // .ad-grant-mask / .ad-grant-pop 的既有写法，**不新增任何色值**（用户硬要求）。
      ".ad-grant-2nd{position:fixed;inset:0;z-index:10001;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.35)}" +
      ".ad-grant-2nd-card{width:min(92vw,520px);max-width:calc(100vw - 24px);box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-2,#fff);border:1px solid color-mix(in srgb,#e8a33d 45%,transparent);border-radius:12px;box-shadow:var(--dsw-shadow-lv3,0 8px 30px rgba(0,0,0,.25));font-size:12px;line-height:1.45;color:var(--dsw-alias-label-primary,inherit)}" +
      ".ad-grant-2nd-title{font-size:12.5px;font-weight:600}" +
      ".ad-grant-2nd-note{color:var(--dsw-alias-label-secondary,inherit)}" +
      // 选项按钮：整行可点、文案换行（后果说明必须读得全，不能截断成 tooltip）
      ".ad-grant-2nd-opt{display:block;width:100%;box-sizing:border-box;text-align:left;white-space:normal;padding:8px 10px;border:1px solid color-mix(in srgb,#e8a33d 30%,transparent);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.5;cursor:pointer}" +
      ".ad-grant-2nd-opt:focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,transparent);outline-offset:2px}" +
      ".ad-grant-2nd-opt:disabled{opacity:1;cursor:default;color:var(--dsw-alias-label-secondary,inherit);border-color:color-mix(in srgb,#e8a33d 18%,transparent)}" +
      // 主选项（＝进入 tools 字段那一档）沿用 .ad-grant-ok 的落色方式，避免 IACVT
      ".ad-grant-2nd-opt.ad-grant-ok{background:var(--ad-accent,var(--dsw-alias-state-business-primary));border-color:var(--ad-accent,var(--dsw-alias-state-business-primary));color:var(--dsw-alias-label-primary-inverted)}" +
      ".ad-grant-2nd-opt.ad-grant-ok:disabled{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 26%,transparent);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 42%,transparent);color:var(--dsw-alias-label-primary,inherit)}" +
      ".ad-grant-2nd-actions{display:flex;justify-content:flex-end;gap:6px}" +
      // v0.9：Agent 卡一行 4 个（窄面板降 2/1 列），紧凑卡片向悬浮球卡片语言看齐
      ".ad-cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}" +
      "@media (max-width:1280px){.ad-cards{grid-template-columns:repeat(2,minmax(0,1fr))}}" +
      "@media (max-width:760px){.ad-cards{grid-template-columns:1fr}}" +
      ".ad-cards .ad-row{padding:11px 12px;gap:7px;border-radius:12px;display:flex;flex-direction:column;height:100%}" +
      ".ad-cards .ad-row .ad-name{font-size:12.5px}" +
      ".ad-cards .ad-row .ad-id{font-size:10px}" +
      // v0.9：状态/类型胶囊（与悬浮球 ad-fab-chip 同款语言，替代原「触发/路由」文本标签）
      ".ad-chip{flex:none;font-size:10px;font-weight:600;padding:2px 8px;border-radius:99px;white-space:nowrap;line-height:1.5}" +
      ".ad-chip.dim{color:var(--ad-faint);background:var(--ad-layer-2);border:1px solid var(--ad-line)}" +
      ".ad-chip.accent{color:var(--ad-accent);background:color-mix(in srgb,var(--ad-accent) 12%,transparent)}" +
      ".ad-chip.ok{color:var(--ad-green);background:color-mix(in srgb,var(--ad-green) 10%,transparent)}" +
      ".ad-chip-row{display:flex;flex-wrap:wrap;gap:4px;min-width:0}" +
      ".ad-chip.trig{color:var(--ad-muted);background:var(--ad-layer-2);border:1px solid var(--ad-line);font-weight:500;font-size:10px;padding:1.5px 7px;max-width:100%;overflow:hidden;text-overflow:ellipsis}" +
      // v0.9：描述两行截断（小队/Agent 卡通用）
      ".ad-desc{color:var(--ad-faint);font-size:11px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;word-break:break-all}" +
      // v0.9.14：头像回退首字 monogram（0.9.13 白 logo 方案被推翻；白 logo 样式保留做空名兜底）
      ".ad-avatar.mono{font-size:15px;font-weight:700;color:var(--ad-accent);background:color-mix(in srgb,var(--ad-accent) 10%,var(--ad-layer-2));display:grid;place-items:center;font-family:var(--ad-mono)}" +
      ".ad-avatar.logo{background:color-mix(in srgb,var(--dsw-static-neutral-1000) 80%,transparent);border-color:transparent}" +
      ".ad-avatar.logo .ad-dsh-logo{width:18px;height:18px;color:var(--dsw-static-neutral-bluish-00)}" +
      ".ad-run-emoji.logo{background:color-mix(in srgb,var(--dsw-static-neutral-1000) 80%,transparent);border-color:transparent}" +
      ".ad-run-emoji.logo .ad-dsh-logo{width:20px;height:20px;color:var(--dsw-static-neutral-bluish-00)}" +
      // v0.9：卡片中部名称/ID 纵排 + 名称截断（头像与开关之间的伸缩区）
      ".ad-mid{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}" +
      ".ad-cards .ad-row .ad-name,.ad-squad-card .ad-name{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      // v0.9：Agent 卡路由一行（mono 小字，超出截断；与表单 .ad-route 区分，用 .ad-cards 作用域）
      ".ad-cards .ad-route{display:block;font-size:10.5px;color:var(--ad-faint);font-family:var(--ad-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-empty{border:1px dashed var(--ad-line-strong);border-radius:13px;min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:color-mix(in srgb,var(--ad-layer-1) 50%,transparent);padding:24px;text-align:center}" +
      // v0.9.8：空态圆形图标删除（只留文字）
      ".ad-empty-text{font-size:12px;color:var(--ad-muted)}" +
      ".ad-empty-sub{font-size:10px;color:var(--ad-faint);max-width:300px;line-height:1.6}" +
      ".ad-hist-line{display:flex;flex-direction:column;border:1px solid var(--ad-line);border-radius:9px;overflow:hidden;transition:border-color .15s}" +
      ".ad-hist-line:hover{border-color:var(--ad-line-strong)}" +
      ".ad-hist-line.open{border-color:var(--ad-accent)}" +
      // v0.9.21：历史列表标题行（列头）——与行头同宽对齐：时间｜头像｜名称｜消息｜状态｜操作
      ".ad-hist-colhead{display:flex;align-items:center;gap:8px;padding:4px 10px;font-size:10px;letter-spacing:.06em;color:var(--ad-faint);font-family:var(--ad-mono)}" +
      ".ad-hist-colhead .c-time{width:44px;flex:none}" +
      ".ad-hist-colhead .c-avatar{width:30px;flex:none}" +
      ".ad-hist-colhead .c-name{width:100px;flex:none}" +
      ".ad-hist-colhead .c-task{flex:1;min-width:0}" +
      ".ad-hist-colhead .c-status{flex:none;width:52px;text-align:center}" +
      ".ad-hist-colhead .c-actions{flex:none;width:130px;text-align:right}" +
      // v0.9.21：执行流图例（只读小队历史展开区顶部）
      ".ad-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:10px;color:var(--ad-faint);padding:2px 0}" +
      ".ad-legend .lg{display:inline-flex;align-items:center;gap:4px}" +
      ".ad-legend .sw{width:10px;height:10px;border-radius:3px;border:1px solid var(--ad-line-strong);background:var(--ad-layer-2)}" +
      ".ad-legend .sw.done{background:color-mix(in srgb,var(--ad-green) 25%,var(--ad-layer-2));border-color:var(--ad-green)}" +
      ".ad-legend .sw.run{background:color-mix(in srgb,var(--ad-accent) 22%,var(--ad-layer-2));border-color:var(--ad-accent)}" +
      ".ad-legend .sw.fail{background:color-mix(in srgb,var(--ad-red) 22%,var(--ad-layer-2));border-color:var(--ad-red)}" +
      ".ad-legend .sw.skip{border-style:dashed;opacity:.6}" +
      ".ad-hist-head{display:flex;align-items:center;gap:8px;padding:7px 10px;font-size:12px;min-width:0;cursor:pointer}" +
      ".ad-hist-head:hover{background:var(--ad-hover)}" +
      ".ad-hist-actions{flex:none;display:inline-flex;gap:4px;margin-left:auto}" +
      ".ad-hist-preview{border-top:1px dashed var(--ad-line);padding:9px 12px;display:flex;flex-direction:column;gap:7px;background:var(--ad-layer-2);font-size:11.5px}" +
      ".ad-hist-preview-row{display:flex;align-items:center;gap:8px;min-width:0;color:var(--ad-text)}" +
      ".ad-hist-id{font:10px var(--ad-mono);color:var(--ad-faint);word-break:break-all;flex:1;min-width:0}" +
      ".ad-hist-err{color:var(--ad-red);font-size:11px;word-break:break-all}" +
      // v0.9.14：类型列徽标（小队=accent 淡底，Agent=中性）
      ".ad-hist-type{flex:none;font-size:10px;font-weight:600;border-radius:99px;padding:1.5px 8px;color:var(--ad-muted);background:var(--ad-layer-2);border:1px solid var(--ad-line)}" +
      ".ad-hist-type.squad{color:var(--ad-accent);background:color-mix(in srgb,var(--ad-accent) 10%,transparent);border-color:color-mix(in srgb,var(--ad-accent) 30%,transparent)}" +
      // v0.9.13：任务详情固定尺寸滚动框（展开区内）
      ".ad-hist-taskbox{width:100%;height:110px;overflow:auto;background:var(--ad-layer-1);border:1px solid var(--ad-line);border-radius:8px;padding:8px 10px;font-size:11.5px;line-height:1.6;white-space:pre-wrap;word-break:break-word;color:var(--ad-text)}" +
      // v0.9.17：历史页分段切换（Agent 历史 / 小队历史），行结构两列表一致
      ".ad-seg{display:inline-flex;align-self:flex-start;background:var(--ad-layer-2);border:1px solid var(--ad-line);border-radius:9px;padding:2px;gap:2px}" +
      ".ad-seg button{border:1px solid transparent;background:transparent;color:var(--ad-muted);font-size:12px;padding:4px 12px;border-radius:7px;cursor:pointer;transition:color .15s,background-color .15s}" +
      ".ad-seg button:hover{color:var(--ad-text)}" +
      ".ad-seg button.on{background:var(--ad-layer-1);border-color:var(--ad-line-strong);color:var(--ad-text);font-weight:600}" +
      // v0.9.17：执行流图节点按步骤状态着色（CSS 覆盖 presentation 属性 fill）
      ".ad-flow-svg .flow-node.st-done .flow-rect{fill:color-mix(in srgb,var(--ad-green) 18%,var(--ad-layer-1));stroke:var(--ad-green)}" +
      ".ad-flow-svg .flow-node.st-run .flow-rect{fill:color-mix(in srgb,var(--ad-accent) 15%,var(--ad-layer-1));stroke:var(--ad-accent)}" +
      ".ad-flow-svg .flow-node.st-fail .flow-rect{fill:color-mix(in srgb,var(--ad-red) 16%,var(--ad-layer-1));stroke:var(--ad-red)}" +
      ".ad-flow-svg .flow-node.st-skip{opacity:.55}" +
      ".ad-flow-svg .flow-node.st-skip .flow-rect{stroke-dasharray:4 3}" +
      ".ad-flow-svg .flow-node.st-unknown .flow-rect{stroke-dasharray:2 3}" +
      // v0.9.17：展开区步骤明细行（状态词 + 跳转）
      ".ad-step-row{display:flex;align-items:center;gap:8px;font-size:11.5px;padding:3px 0;min-width:0}" +
      ".ad-step-row .no{flex:none;font-family:var(--ad-mono);font-size:10px;color:var(--ad-faint);width:22px}" +
      ".ad-step-row .nm{color:var(--ad-text);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".ad-step-row .st{flex:none;font-size:10px}" +
      ".ad-step-row .st.done{color:var(--ad-green)}" +
      ".ad-step-row .st.run{color:var(--ad-accent)}" +
      ".ad-step-row .st.fail{color:var(--ad-red)}" +
      ".ad-step-row .st.skip,.ad-step-row .st.wait,.ad-step-row .st.unk{color:var(--ad-faint)}" +
      ".ad-hist-time{flex:none;color:var(--ad-faint);font:11px var(--ad-mono)}" +
      ".ad-hist-name{flex:none;max-width:100px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-hist-task{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ad-muted);font-size:11.5px}" +
      ".ad-hist-ok,.ad-hist-done{flex:none;color:var(--ad-green);font-size:10.5px}" +
      ".ad-hist-ng,.ad-hist-fail{flex:none;color:var(--ad-red);font-size:10.5px}" +
      ".ad-hist-run{flex:none;color:var(--ad-accent);font-size:10.5px}" +
      ".ad-hist-unknown,.ad-hist-unk{flex:none;color:var(--ad-faint);font-size:10.5px}" +
      ".ad-sec-title{font-size:11.5px;color:var(--ad-muted);margin-top:2px;flex:none}" +
      ".ad-err{color:var(--ad-red);font-size:12px;flex:none}" +
      // ── FAB v0.7：可拖动 + 完成徽标 + 弹窗跟随（样式挂 body 层，不能依赖 .ad-panel 变量）──
      ".ad-fab{--fab-bg:var(--dsw-alias-brand-primary);--fab-fg:var(--dsw-static-neutral-bluish-00);--fab-green:var(--dsw-alias-state-success-primary);--fab-line:var(--dsw-alias-border-l2);--fab-layer2:var(--dsw-alias-bg-layer-2);position:fixed;width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,var(--dsw-alias-state-business-primary),var(--dsw-alias-brand-primary));color:var(--fab-fg);display:grid;place-items:center;font-size:20px;cursor:grab;user-select:none;touch-action:none;z-index:9999;box-shadow:0 4px 18px color-mix(in srgb,var(--dsw-alias-state-business-primary) 35%,transparent);transition:box-shadow .3s,transform .18s ease;animation:ad-fab-breathe 4.2s ease-in-out infinite;overflow:visible;opacity:var(--fab-opacity,1)}" +
      // v0.9.2：透明毛玻璃球——无高光，半透明白渐变 + 微弱内阴影（轮廓靠玻璃质感）
      ".ad-fab::before{content:'';position:absolute;inset:0;border-radius:50%;pointer-events:none;background:linear-gradient(135deg,rgba(255,255,255,.16),rgba(255,255,255,.04));box-shadow:inset 0 0 14px rgba(255,255,255,.18),inset -3px -4px 8px rgba(0,0,0,.12)}" +
      ".ad-fab::after{content:'';position:absolute;left:16%;right:16%;bottom:-5px;height:6px;border-radius:50%;background:radial-gradient(ellipse at center,rgba(0,0,0,.25),transparent 70%);pointer-events:none;filter:blur(2px)}" +
      // v0.8.11：鼠标悬停特效——轻微放大 + 光晕增强（无高光，只增强光晕）
      ".ad-fab:hover:not(.dragging){transform:scale(1.1);box-shadow:0 6px 24px color-mix(in srgb,var(--fab-c1,var(--dsw-alias-state-business-primary)) 55%,transparent)}" +
      // v0.8.3：悬浮球动态特效——呼吸光晕（常态）、拖拽放大+阴影（拖动）、完成闪光（扩散光环）
      "@keyframes ad-fab-breathe{0%,100%{box-shadow:0 4px 18px color-mix(in srgb,var(--fab-c1,var(--dsw-alias-state-business-primary)) 35%,transparent),0 0 0 0 transparent;transform:scale(1)}50%{box-shadow:0 4px 18px color-mix(in srgb,var(--fab-c1,var(--dsw-alias-state-business-primary)) 35%,transparent),0 0 10px 2px var(--dsw-static-neutral-00);transform:scale(1.06)}}" +
      ".ad-fab.dragging{cursor:grabbing;transform:scale(1.14);box-shadow:0 10px 30px color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent);animation:none}" +
      // v0.9.33：活跃绿点（.ad-fab-dot）与完成 ✓N 角标（.ad-fab-done）已删——用户：光效提醒已足够，绿点冗余
      // v0.9.3：面板背景改 ::before 不透明度层（弃 color-mix，此环境解析失败），透明度变量 --fab-pop-alpha（0-1）
      ".ad-fab-pop{position:fixed;width:360px;max-width:calc(100vw - 24px);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:16px;padding:0;box-shadow:var(--dsw-shadow-lv3);display:flex;flex-direction:column;z-index:9999;overflow:hidden;animation:ad-fab-pop-in .18s cubic-bezier(.2,.9,.3,1.15);backdrop-filter:blur(18px) saturate(1.4);-webkit-backdrop-filter:blur(18px) saturate(1.4);transform-origin:center}" +
      ".ad-fab-pop::before{content:'';position:absolute;inset:0;background:var(--dsw-alias-bg-layer-2);opacity:var(--fab-pop-alpha,.85);pointer-events:none}" +
      ".ad-fab-pop>*{position:relative;z-index:1}" +
      // v0.8.12：面板从中心弹出（scale 0.8→1，弹性收尾）
      "@keyframes ad-fab-pop-in{0%{opacity:0;transform:scale(.8)}100%{opacity:1;transform:scale(1)}}" +
      // v0.8.8：活动面板方案A——头部状态摘要 + 卡片分区
      ".ad-fab-pop-head{display:flex;align-items:center;gap:9px;padding:13px 16px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);background:linear-gradient(135deg,color-mix(in srgb,var(--dsw-alias-state-business-primary) 7%,transparent),transparent 60%)}" +
      ".ad-fab-pop-title{flex:1;min-width:0;display:flex;align-items:center;gap:8px;font-size:13.5px;font-weight:650;color:var(--dsw-alias-label-primary)}" +
      ".ad-fab-pop-summary{flex:none;display:inline-flex;align-items:center;gap:5px;font-size:10.5px;font-weight:600;color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);border-radius:99px;padding:3px 9px}" +
      ".ad-fab-pop-summary.zero{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-1)}" +
      // v0.9.24：scrollbar-gutter:stable——内容临界溢出时滚动条一出现卡片就被挤窄 15px，
      // 预留滚动条槽位让宽度恒定（Electron 经典滚动条为占位式）
      ".ad-fab-pop-body{display:flex;flex-direction:column;gap:4px;padding:10px 12px;max-height:300px;overflow:auto;scrollbar-gutter:stable}" +
      // v0.9.22：兜底——body 的所有直接子项禁止参与压缩（超高时滚动而不是压扁叠卡）
      ".ad-fab-pop-body>*{flex:none}" +
      ".ad-fab-sec{flex:none;display:flex;align-items:center;gap:7px;padding:8px 3px 5px;font:650 10px/1 var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.1em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}" +
      ".ad-fab-sec:first-child{padding-top:2px}" +
      ".ad-fab-sec .cnt{color:var(--dsw-alias-label-secondary);font-weight:600}" +
      // v0.9.23：面板卡片同底化——卡片弃实底（layer-1），与面板同底只靠边框区分（用户偏好）；
      // 且必须 border-box：否则宿主全局 *{box-sizing} 不一致时 1px 边框挤占内容造成错位
      ".ad-fab-card{flex:none;display:flex;align-items:center;gap:9px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:11px;padding:8px 11px;background:transparent;min-width:0;transition:border-color .12s}" +
      ".ad-fab-card:hover{border-color:var(--dsw-alias-border-l2)}" +
      ".ad-fab-card.clickable{cursor:pointer}" +
      ".ad-fab-card .ad-avatar{width:26px;height:26px;font-size:13px;border-radius:8px}" +
      ".ad-fab-card .grow{flex:1;min-width:0}" +
      ".ad-fab-card .grow .t1{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-fab-card .grow .t2{font-size:10.5px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px}" +
      ".ad-fab-chip{flex:none;font-size:10px;font-weight:600;padding:2.5px 8px;border-radius:99px}" +
      ".ad-fab-chip.run{color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}" +
      ".ad-fab-chip.ok{color:var(--dsw-alias-state-success-primary);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent)}" +
      ".ad-fab-chip.ng{color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent)}" +
      ".ad-fab-chip.un{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}" +
      ".ad-fab-empty{font-size:11.5px;color:var(--dsw-alias-label-tertiary);padding:22px 4px;text-align:center}" +
      ".ad-fab-pop-foot{display:flex;gap:8px;padding:11px 14px;border-top:1px solid var(--dsw-alias-border-l1);background:transparent}" +
      // v0.9.20：面板按钮同底化——主按钮弃蓝填充，透明底+边框区分（与卡片/面板同底原则一致）
      ".ad-fab-pop-foot .primary{flex:1;background:transparent;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:8px 12px;font-size:12.5px;font-weight:600;cursor:pointer;transition:background .12s,border-color .12s}" +
      ".ad-fab-pop-foot .primary:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-border-l3)}" +
      ".ad-fab-pop-foot .ghost{flex:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:9px;padding:8px 12px;font-size:12px;cursor:pointer;display:flex;align-items:center;gap:5px;transition:background .12s}" +
      ".ad-fab-pop-foot .ghost:hover{background:var(--dsw-alias-interactive-bg-hover)}" +
      // v0.8.8：悬浮球设置浮层
      ".ad-fab-tone-row{flex:none;display:grid;grid-template-columns:repeat(4,1fr);gap:6px}" +
      ".ad-fab-tone{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:6px 8px;font-size:11.5px;color:var(--dsw-alias-label-primary);cursor:pointer;transition:border-color .12s,color .12s;white-space:nowrap}" +
      ".ad-fab-tone:hover{border-color:var(--dsw-alias-border-l3)}" +
      ".ad-fab-tone.on{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}" +
      ".ad-fab-tone .dot{width:15px;height:15px;border-radius:50%;flex:none;border:1px solid var(--dsw-alias-border-l3);box-sizing:border-box}" +
      ".ad-fab-set-row{flex:none;display:flex;align-items:center;gap:10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:9px 12px;background:transparent}" +
      ".ad-fab-set-row .grow{flex:1;min-width:0}" +
      ".ad-fab-set-row .t1{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-fab-set-row .t2{font-size:10.5px;color:var(--dsw-alias-label-tertiary);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-fab-set-row .grow{min-width:0}" +
      // v0.8.11：透明度滑块
      ".ad-fab-alpha-val{flex:none;font-size:11px;font-weight:600;color:var(--dsw-alias-label-secondary);min-width:34px;text-align:right}" +
      // v0.9.19：滑杆球与开关同视觉（灰轨白球，两主题通用）——弃 accent-color 原生外观，自定义轨道+拇指
      ".ad-fab-alpha{flex:none;width:84px;height:17px;cursor:pointer;-webkit-appearance:none;appearance:none;background:transparent}" +
      ".ad-fab-alpha::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:var(--dsw-static-neutral-bluish-600)}" +
      ".ad-fab-alpha::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:13px;height:13px;border-radius:50%;background:var(--dsw-static-neutral-bluish-00);border:1px solid var(--dsw-alias-border-l2);margin-top:-4.5px}" +
      ".ad-fab-alpha::-moz-range-track{height:4px;border-radius:999px;background:var(--dsw-static-neutral-bluish-600)}" +
      ".ad-fab-alpha::-moz-range-thumb{width:13px;height:13px;border-radius:50%;background:var(--dsw-static-neutral-bluish-00);border:1px solid var(--dsw-alias-border-l2)}" +
      // v0.8.8：悬浮球色调/动效（CSS 变量注入，动效类切换）
      // v0.9.3：色调全部用确实存在的静态 token（根因：旧代码引用不存在的 --dsw-alias-state-info/warning-primary→渐变失效→透明黑）
      // v0.9.5：浅色批次（雪白/天蓝/雾紫/樱粉/杏橙）+ 彩虹 + 毛玻璃无色透明
      ".ad-fab{background:linear-gradient(135deg,var(--dsw-static-blue-500),var(--dsw-static-blue-800)) !important}" +
      ".ad-fab.ad-tone-snow{background:linear-gradient(135deg,var(--dsw-static-neutral-00),var(--dsw-static-neutral-bluish-100)) !important}" +
      ".ad-fab.ad-tone-sky{background:linear-gradient(135deg,var(--dsw-static-blue-100),var(--dsw-static-blue-400)) !important}" +
      ".ad-fab.ad-tone-mist{background:linear-gradient(135deg,var(--dsw-static-deepseek-100),var(--dsw-static-deepseek-450)) !important}" +
      ".ad-fab.ad-tone-cherry{background:linear-gradient(135deg,var(--dsw-static-red-100),var(--dsw-static-red-400)) !important}" +
      ".ad-fab.ad-tone-apricot{background:linear-gradient(135deg,var(--dsw-static-amber-100),var(--dsw-static-amber-400)) !important}" +
      ".ad-fab.ad-tone-rainbow{background:linear-gradient(120deg,var(--dsw-static-red-500),var(--dsw-static-amber-500),var(--dsw-static-green-500),var(--dsw-static-blue-500)) !important}" +
      // v0.9.11：毛玻璃调亮——纯透明底在暗色页面显黑（用户：太黑了白一点）；改近白半透明叠层+保留磨砂模糊（实底会挡住 backdrop-filter）
      ".ad-fab.ad-tone-glass{background:linear-gradient(135deg,rgba(255,255,255,.75),rgba(255,255,255,.55)) !important;backdrop-filter:blur(10px) saturate(1.3);-webkit-backdrop-filter:blur(10px) saturate(1.3);border:1px solid rgba(255,255,255,.6)}" +
      // v0.8.10：呼吸=单色光晕脉动+轻微缩放；v0.9.12：整球彩色流光已删，只留边缘流光
      ".ad-fab.fab-breathe{animation:ad-fab-breathe 4.2s ease-in-out infinite}" +
      ".ad-fab:not(.fab-breathe){animation:none}" +
      // v0.9.17：运行中=白光呼吸加速（2.6s，状态指示不受常态呼吸开关约束）；完成=彩色光呼吸
      ".ad-fab.fab-live{animation:ad-fab-breathe 2.6s ease-in-out infinite}" +
      // v1.8.0：待授权光效（琥珀脉冲，优先级高于运行/完成光效——有子代理在等权限）
      ".ad-fab.fab-pending{animation:ad-fab-glow-pending 1.2s ease-in-out infinite;box-shadow:0 0 0 3px color-mix(in srgb,#e8a33d 55%,transparent)}" +
      "@keyframes ad-fab-glow-pending{0%,100%{box-shadow:0 0 0 3px color-mix(in srgb,#e8a33d 55%,transparent)}50%{box-shadow:0 0 0 7px color-mix(in srgb,#e8a33d 18%,transparent)}}" +
      // v0.9.5：边缘流光=独立旋转 conic 渐变环（遮罩掏空中心只露 3px 边缘）
      ".ad-fab-edge-ring{position:absolute;inset:-3px;border-radius:50%;pointer-events:none;background:conic-gradient(from 0deg,var(--dsw-static-red-500),var(--dsw-static-amber-500),var(--dsw-static-green-500),var(--dsw-static-blue-500),var(--dsw-static-red-500));-webkit-mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));mask:radial-gradient(farthest-side,transparent calc(100% - 3px),#000 calc(100% - 2.5px));animation:ad-edge-spin 4s linear infinite}" +
      "@keyframes ad-edge-spin{to{transform:rotate(360deg)}}" +
      ".ad-fab:not(.fab-edge) .ad-fab-edge-ring{display:none}" +
      // v0.9.17：完成提醒=彩色光呼吸（绿→蓝→琥珀柔光循环，无放大无跳动）
      // v0.9.37：改无限循环常驻（用户：完成光效太短；点击悬浮球后消失，有活跃任务回退白光呼吸）
      "@keyframes ad-fab-glow-done{0%,100%{box-shadow:0 4px 18px color-mix(in srgb,var(--fab-c1,var(--dsw-alias-state-business-primary)) 35%,transparent),0 0 10px 2px color-mix(in srgb,var(--dsw-alias-state-success-primary) 55%,transparent)}33%{box-shadow:0 4px 18px color-mix(in srgb,var(--fab-c1,var(--dsw-alias-state-business-primary)) 35%,transparent),0 0 14px 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent)}66%{box-shadow:0 4px 18px color-mix(in srgb,var(--fab-c1,var(--dsw-alias-state-business-primary)) 35%,transparent),0 0 14px 4px color-mix(in srgb,var(--dsw-alias-state-warn-primary) 50%,transparent)}}" +
      ".ad-fab.done-glow{animation:ad-fab-glow-done 1.6s ease-in-out infinite}" +
      ".ad-fab.dragging.fab-breathe,.ad-fab.dragging.fab-live,.ad-fab.dragging.done-glow{animation:none}" +
      // v0.8.7：面板内最近委派区
      ".ad-fab-pop-foot{display:flex;gap:6px;padding:9px 12px;border-top:1px solid var(--dsw-alias-border-l1)}" +
      // v0.9.3：✕ 还原原尺寸（28px），只把 ⚙ 放大（.ad-fab-pop-set）
      ".ad-fab-pop-close{flex:none;width:28px;height:28px;border-radius:8px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);font-size:14px;line-height:1;cursor:pointer;display:grid;place-items:center;transition:background .12s,color .12s}" +
      ".ad-fab-pop-set{width:36px;height:36px;font-size:19px;border-radius:10px}" +
      ".ad-fab-pop-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
      // v0.9.32：悬停快捷按钮（⇱/⇲）已移除——卡片点击统一直达主会话，样式一并清理
      ".ad-fab-sec-toggle{cursor:pointer;user-select:none}" +
      ".ad-fab-sec-toggle:hover{color:var(--dsw-alias-label-primary)}" +
      ".ad-fab-sec-toggle .arrow{font-size:9px;color:var(--dsw-alias-label-tertiary)}" +
      ".ad-fab-agents{flex:none;display:flex;flex-direction:column;gap:4px;margin-bottom:2px}" +
      // v0.9.17：四分区卡片化——每分区独立圆角卡片（边框+圆角+浅底），标题行（名称+计数+右箭头）整行点击折叠
      // v0.9.22：body 是 flex 列 + max-height，子项默认 flex-shrink:1 会在内容超高时被压扁
      // → 卡片互相叠压（用户：展开都重叠了）。全部 flex:none 禁止压缩，交给 body 滚动
      ".ad-fab-box{flex:none;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:transparent;overflow:hidden}" +
      ".ad-fab-box-hd{display:flex;align-items:center;gap:7px;padding:7px 10px;cursor:pointer;user-select:none;font-size:11px;font-weight:650;color:var(--dsw-alias-label-secondary);transition:background .12s,color .12s}" +
      ".ad-fab-box-hd:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}" +
      ".ad-fab-box-hd .cnt{color:var(--dsw-alias-label-tertiary);font-weight:600;font-size:10px}" +
      ".ad-fab-box-hd .grow{flex:1}" +
      ".ad-fab-box-hd .arrow{font-size:9px;color:var(--dsw-alias-label-tertiary)}" +
      ".ad-fab-box-bd{display:flex;flex-direction:column;gap:4px;padding:4px 6px 6px}" +
      ".ad-fab-pop-t{font:650 9px/1.2 var(--ds-font-family-code,ui-monospace,monospace);letter-spacing:.12em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}" +
      ".ad-fab-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-primary)}" +
      ".ad-fab-row .grow{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
      ".ad-set-note{background:var(--dsw-alias-bg-layer-2);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:0 6px 6px 0;padding:8px 12px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}" +
            // v0.8：设置页悬浮球显示模式单选组；v0.9.20：单选 = 开关视觉（灰底+白球，亮暗通用）——
      // 未选=纯灰圆，选中=灰圆中心白球（::after），全程无蓝色；行选中仅边框加深
      ".ad-fab-modes{flex:none;display:flex;flex-direction:column;gap:6px;margin-top:6px}" +
      ".ad-fab-mode{flex:none;display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:7px 10px;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary);transition:border-color .15s}" +
      ".ad-fab-mode:hover{border-color:var(--dsw-alias-border-l3)}" +
      ".ad-fab-mode.on{border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}" +
      // v0.9.24：白球 9px 在 14px 灰圆内需 2.5px 偏移，半像素取整不对称（实测左3右2）→ 看着偏心。
      // 改 10px 白球 → 边距恰好整数 2px 四向对称；灰圆 14px 不变
      ".ad-fab-mode .dot{position:relative;box-sizing:content-box;width:14px;height:14px;border-radius:50%;background:var(--dsw-static-neutral-bluish-600);flex:none}" +
      ".ad-fab-mode.on .dot::after{content:'';position:absolute;inset:0;margin:auto;width:10px;height:10px;border-radius:50%;background:var(--dsw-static-neutral-bluish-00)}";

    // 幂等注入一次（与 dsh-capability-manager 相同的 data-plugin-css 模式）
    const cssTagId = "@kiligzzz/dsh-agent-dispatch/styles";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(cssTagId) + "]") === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = "@kiligzzz/dsh-agent-dispatch";
      tag.dataset.pluginCss = cssTagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── REST API（宿主半提供，同源 fetch；失败统一 { ok:false, error }）──
    async function apiGet(path) {
      const r = await fetch(path);
      const d = await r.json();
      if (!d || d.ok !== true) throw new Error((d && d.error) || "请求失败");
      return d;
    }
    async function apiPost(path, body) {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {}),
      });
      const d = await r.json();
      if (!d || d.ok !== true) throw new Error((d && d.error) || "请求失败");
      return d;
    }
    function msg(e) { return String((e && e.message) || e); }

    // v0.7.1：跳转子 agent 会话桥（apply 时绑定宿主 client sessions.open；未绑定时为 null）
    let openAgentSession = null;

    // ── v0.9.27：导航栈（方案 A：面板头「← 返回」按钮）──
    // 槽位占位组件不携带 sessionId、sessions 服务也无 getCurrent——
    // 跳转瞬间从侧边栏抓当前会话行（role=treeitem + aria-selected=true）的标题文本压栈；
    // 返回时按标题点回对应行（DOM 直点，失败再 sessions.search 兜底）。
    const navStack = [];           // 标题栈（最新在尾），上限 20
    const navSubs = new Set();     // 面板重渲染订阅
    function navNotify() { for (const f of navSubs) { try { f(); } catch (e) {} } }
    function navPush(title) {
      if (!title) return;
      navStack.push(title);
      if (navStack.length > 20) navStack.shift();
      navNotify();
    }
    function navPopTitle() { const t = navStack.pop(); navNotify(); return t; }
    function captureCurrentSessionTitle() {
      try {
        const row = document.querySelector('div[role="treeitem"][aria-selected="true"]');
        if (!row) return null;
        const titleEl = row.querySelector('[class*="title"]');
        const t = ((titleEl && titleEl.textContent) || row.textContent || "").trim();
        return t || null;
      } catch (e) { return null; }
    }
    /**
     * v1.11.14(E)：软取宿主服务（拿不到就返回 null，绝不抛）。
     * 用于 uiWorkspace 这类**故意不写进 inject** 的服务：老宿主没有该服务，
     * 声明成 hardDependency 会让整个 client 半挂载失败（同 0.1.2 slots 事故）。
     * cordis 下 ctx.<name> 未 inject 时可能抛 "without inject"，ctx.get 又可能因
     * fiber 时序返回 undefined，故两路都试。
     */
    function softService(ctx, name) {
      try { const v = ctx && ctx[name]; if (v) return v; } catch (e) { /* 未声明依赖：忽略 */ }
      // v1.11.14(m6)：ctx.get(name) 默认 strict=true，缺依赖会抛；宿主 dsh 0.1.7
      // 起 ReflectService.get 的第二参 strict=false 才是"拿不到就 undefined"。
      // 三条路各走一次（分开 try：严格路抛错不得挡住后面的路）。
      try { const v = ctx && ctx.get && ctx.get(name, false); if (v) return v; } catch (e) { /* 老宿主无 strict 参数：忽略 */ }
      try { return (ctx && ctx.get && ctx.get(name)) || null; } catch (e) { return null; }
    }
    /**
     * v1.11.14(A)：把 /agent-api/active 的活跃条目摊平成"每权限请求一行"。
     * 兼容三态：新契约（permissionPendingList 数组）／老契约（permissionPending
     * 单对象）／两者皆无（无挂起）。老服务端不返 permId → 行仍可用，
     * 决策按 childId 转发、由服务端 FIFO 摘取。
     * v1.11.14(M3 收尾)：提到模块作用域——待授权数有 4 个显示位（运行中卡片、
     * 面板头部 pill、主 FAB 光效、琥珀球列表），原先 3 处各自
     * `filter(a => a.permissionPending)` 数的是**条目数**：同一子代理并发 2 条
     * 授权时只显示"1 待授权"，与琥珀球行数、与服务端真实请求数都不一致。
     */
    function permRowsOf(arr) {
      const rows = [];
      for (const a of arr || []) {
        if (!a) continue;
        const items = Array.isArray(a.permissionPendingList) && a.permissionPendingList.length > 0
          ? a.permissionPendingList
          : (a.permissionPending ? [a.permissionPending] : []);
        for (const it of items) {
          if (!it) continue;
          rows.push({
            childId: a.childId,
            parentSessionId: a.parentSessionId,
            agentId: a.agentId,
            agentName: a.agentName,
            emoji: a.emoji,
            startedAt: a.startedAt,
            permId: it.permId ?? null,
            permissionPending: it,
          });
        }
      }
      return rows;
    }
    /** 单条活跃条目的待授权请求数（摊平后行数，0 = 无挂起） */
    function permCountOf(entry) {
      return entry ? permRowsOf([entry]).length : 0;
    }

    // ── v1.12.6 U1/U2：授权面板「说实话」+「可编辑路径」弹框的共用件 ──
    // 琥珀球（ACP 通道）与蓝球（宿主审批通道）两条面板都要用，放模块作用域
    // （permRowsOf 的同款先例）：判据各写一遍必然漂移。

    /** 沙箱越权判据——与 lib/host-approval.js 的 isSandboxEscalation 同一正则 */
    function isEscalationReason(reason) {
      return /^\s*escalate\s+sandbox\s+to/i.test(String(reason || ""));
    }
    /** 非空数组判据（undefined/null/非数组/空数组一律 false） */
    function nonEmptyArray(v) {
      return Array.isArray(v) && v.length > 0;
    }
    /** 工具名档的真实记忆键（与产品侧 0.7.9 toolGrantKey 同构：product:tool 小写归一） */
    function toolGrantKeyOf(product, toolName) {
      const p = String(product || "").trim().toLowerCase();
      const t = String(toolName || "").trim().toLowerCase();
      if (p && t) return p + ":" + t;
      return t || null;
    }
    /** 直接父目录（纯词法）。父级是文件系统根时返回 null——根一旦进授权集=任意路径免弹 */
    function parentDirOf(p) {
      const s = String(p || "").trim().replace(/^["']|["']$/g, "").replace(/[/\\]+$/, "");
      if (!s) return null;
      const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
      if (i <= 0) return null;
      const dir = s.slice(0, i);
      if (!dir || dir === "/" || /^[a-zA-Z]:[\/\\]?$/.test(dir)) return null;
      return dir;
    }
    /**
     * 「明确是文件形态」的两条判据（纯词法）——**只有明确是文件时才取父目录**：
     *   ① 末段带扩展名（`x.txt`、`a.tar.gz`）；**点开头的名字不算**（`.ssh`、`.gitignore`
     *      里那个点是名字本身，不是扩展名——终审 M2 实测的问题正出在这里）；
     *   ② 或命中下一条的显式白名单（常见**无扩展名的文件**名：ssh 私钥 `id_*`、
     *      `.git*` 配置文件、Makefile/Dockerfile 之类）。
     * 名单外一律**保持原样当目录**：`my-project`、`notes_2024`、`.ssh`、`.github`、`.git`
     * 都是目录名——「名字里带 -/_ 或数字」「点开头」都不是文件判据。
     * **白名单取舍原则（v1.12.6 第四轮终审 M2 补写）**：只收录「作为名字时**必然是文件**」
     * 的形态；凡是**可能同时是目录名**的一律原样。所以：
     *   · `.gitignore`/`.gitconfig` 之类收录（同名目录实际不存在）；
     *   · 裸 `.git` **不收录**——它是目录（与 `.github` 同类；改前 `\.git(?:…)?` 的可选组
     *     把裸 `.git` 也吃进来了，于是 `/repo/.git` 被取父目录放大成 `/repo`）。
     * 为什么必须这么保守（终审 M2）：这些预填**默认勾选**，而服务端
     * validateDeclaredPaths（lib/host-approval.js:124-157）只做词法校验、不 stat，
     * 声明非空即 `expand:false` 原样落盘 ⇒ 把 `/home/dev/.ssh` 当文件取父目录，
     * 用户手快确认一次就把整份 `/home/dev` 写进会话授权。
     * 后续项（本轮不做，登记在 CHANGELOG）：更彻底的做法是服务端 `statSync` 回 `isDir`，
     * 白名单只做「无 stat 时」的兜底；那要动 host-approval-context 的出参与调用链。
     */
    const EXT_NAME_RE = /^[^./\\][^/\\]*\.[A-Za-z0-9]{1,8}$/;
    const FILE_FORM_RE = /^(?:id_[a-z0-9]+(?:\.pub)?|known_hosts|authorized_keys|Makefile|Dockerfile|\.git(?:config|ignore|attributes|modules|keep)|\.npmrc|\.nvmrc|\.env|\.bashrc|\.bash_profile|\.zshrc|\.profile|\.editorconfig|\.dockerignore)$/i;
    /** 绝对路径判据（`/a/b`、`C:\a`、`\\host\share`）；相对/`~` 开头一律不算 */
    const ABS_PATH_RE = /^(?:[/\\]|[a-zA-Z]:[/\\])/;
    /**
     * 盘根 / 文件系统根（`/`、`C:`、`C:\`、`//`）。v1.12.6 第五轮（终审 Minor 1）：
     * 尾分隔符分支（下面 `dirsOfPaths` 的第一条 `if`）原先只挡了字面 `/`，于是
     * `dirsOfPaths(['C:\\'])` 会走「原串以分隔符结尾 ⇒ 原样保留」那条路，返回 **`['C:']`**
     * —— 绕过了 `parentDirOf` 里的盘根守卫。服务端 `validateDeclaredPaths` 会把它按
     * 「根目录」丢弃，所以它落不成一条真规则；但它会**空预填**，让用户点确认后拿到 400
     * （终审 M-B 的触发路径之一），所以预填阶段就不该出现。根路径在任何分支都不参与。
     */
    const ROOT_LIKE_RE = /^(?:[a-zA-Z]:)?[/\\]*$/;
    /**
     * 蓝球条目的目录预填：服务端 host-approval-context 给的是**工具调用里解析出的路径**
     * （常是文件级），客户端只补一次词法推导：**明确是文件形态**（EXT_NAME_RE 或
     * FILE_FORM_RE）⇒ 取其父目录；**其余一律原样**当目录，不再拿「像文件」当判据。
     * 磁盘真相仍以服务端 statSync 为准（expandPathsWithParents），这里只为让弹框预填可读。
     * 猜不出的形态（`/etc/passwd`、`/proc/cpuinfo` 这类无扩展名的普通文件）会原样当目录——
     * 服务端 pathAllowed（lib/host-approval.js:180）对「无扩展名尾巴」的规则按目录前缀匹配，
     * 也就是那条规则覆盖它自己与其下的路径；把 `/home/dev/.ssh/id_ed25519` 原样落盘
     * **不会**放过整个 `~/.ssh`（它只匹配它自己那一条路径），所以「不取父目录」不会
     * 放大授权，只会更窄。
     * 反向提醒：`.ssh` 这种「点开头」的目录名会被 pathAllowed 当成**扩展名**尾巴
     * （`.ssh` 命中 `/\.[A-Za-z0-9]{1,8}$/`）⇒ 该规则只精确匹配它自己。这是服务端既有
     * 命中语义，本次不动（动它会改自动判定行为），但预填**绝不能**因此把它放大成父目录。
     * 两条「原样」的特例（v1.12.6 第四轮终审 Minor，方向都只会更窄）：
     *   · **原始串以分隔符结尾**（`/repo/.git/`、`/a/b/foo.d/`）⇒ 用户已经明说是目录，
     *     直接原样保留，**不再套文件判据**（改前先 `replace(/[/\\]+$/,'')` 丢尾斜杠 ⇒
     *     `foo.d` 被当成带扩展名的文件、放大到 `/a/b`）；
     *   · **非绝对路径**（`~/.ssh/id_rsa`、`./x.txt`）⇒ v1.12.6 第五轮按**用户裁定**改了：
     *     传了 `cwd` 就先把相对路径拼成绝对路径再走上面的判据（`./x.txt` + `/proj`
     *     ⇒ `/proj/x.txt` ⇒ 取父目录 `/proj`）；拼不出来（无 cwd）才原样保留。
     *     v1.12.7 起 `~` 也能拼——基准是**服务端下发的 home**（见 resolveAgainstCwd）。
     *     仍然拼不出来的候选原样保留：它只精确匹配它自己那一条，严格更窄；而且弹框会
     *     **强制不勾选**并就地提示（第五轮 · 终审 M-B）——服务端只认绝对路径，写不进去。
     */
    /**
     * 相对路径 / `~` → 绝对路径：按**请求的工作区目录 cwd**（或 `~` 的基准 home）拼写
     * 并做纯词法规范化（丢 `.` 段、消 `..` 段、折叠重复分隔符、去尾分隔符）。
     *
     * v1.12.6 第五轮（用户裁定：「相对路径，自动用工作区目录拼写完整再放入编辑区吧。」）：
     * 弹框预填是**待写规则**的草稿，里面出现 `./x.txt` 这种相对路径时，服务端
     * `validateDeclaredPaths` 只认绝对路径 ⇒ 一条都留不下 ⇒ 用户点确认拿 400
     * （改前更糟：静默退化成工具名档，授权放大到整个工具）。所以在预填阶段就补齐。
     *
     * v1.12.7 `~` 展开：基准是**服务端下发的 home**（`/agent-api/host-approval-context`
     * 的 `home`，来自 resolveApprovalContext），前端不能 `require('os')`、也拿不到
     * `process.env.HOME`。服务端 `normalizeCandidate`（lib/host-approval.js:66-73）与
     * `validateDeclaredPaths`（:124-157）本来就用这个值展开 `~`，所以这里拼出来的绝对路径
     * 与服务端口径**同源**。只展开 `~` 与 `~/…`：`~user/…` 是别的用户的 home，不猜。
     *
     * **降级不猜的两条（返回 null ⇒ 调用方走降级：原样保留 + 不默认勾选 + 就地警示）**：
     *   · `~` 开头但**拿不到 home**（老宿主/异常通道），或 `~user/…` 形态；
     *   · `cwd` 缺失或不是绝对路径（相对路径没有可信的基准目录，不做「以相对路径当目录」的猜测）。
     * **`rel` 已是绝对路径**（v1.12.6 第六轮 · 终审 Minor 4）：直接返回它自己（盘根按
     * `ROOT_LIKE_RE` 仍返回 null），**不再拼 cwd** —— 否则会拼出 `"C:/base/C:/win/x.txt"`。
     * @param {string} rel 相对路径或 `~` 形态路径（已去尾分隔符）
     * @param {string|null|undefined} cwd 请求的工作区目录（必须是绝对路径）
     * @param {string|null|undefined} [home] `~` 展开基准（服务端下发的 os.homedir()）
     * @returns {string|null} 规范化后的绝对路径；判不出时 null
     */
    function resolveAgainstCwd(rel, cwd, home) {
      const base = String(cwd || "").trim().replace(/^["']|["']$/g, "");
      let relPath = String(rel || "").trim();
      if (!relPath) return null;
      // v1.12.7：`~` / `~/…` 用服务端下发的 home 展开（展开后仍需是绝对路径才算数）。
      // `~user/…` 不展开（那是别人的 home，猜错方向是把授权挪到别的目录）。
      let tildeBase = null;
      if (/^~/.test(relPath)) {
        if (relPath !== "~" && !/^~[/\\]/.test(relPath)) return null; // `~user/…`：不猜
        const h = String(home || "").trim().replace(/^["']|["']$/g, "").replace(/[/\\]+$/, "");
        if (!h || !ABS_PATH_RE.test(h) || ROOT_LIKE_RE.test(h)) return null; // 拿不到 home ⇒ 降级
        tildeBase = h;
        if (relPath === "~") relPath = "";
        else relPath = relPath.slice(2);
        if (!relPath || ROOT_LIKE_RE.test(relPath)) return tildeBase; // `~` 本身、`~/` 之类
      }
      // v1.12.7：`~` 形态的基准是服务端下发的 home，**与 cwd 无关** —— 这里不能用
      // 「cwd 缺失」否掉它。琥珀（ACP）通道恰好就是「有 home、没有 cwd」：产品侧
      // 不透传 cwd（amberCwd 恒 null），若在这一行被 `!base` 拦下，那条通道的
      // `~/.ssh` 候选永远拼不出来 ⇒ serializePermissionPending 多带的 home 白带。
      // 相对路径（`./x.txt`）仍必须要求 cwd：没有可信基准目录就不猜（原样保留 + 警示）。
      if (!relPath) return null;
      if (!base && !tildeBase) return null;
      // v1.12.6 第六轮（终审 Minor 4）：`rel` **本身已是绝对路径**（含盘符形态）⇒ 直接返回，
      // 不拼 cwd。两个调用点都有 `ABS_PATH_RE` 前置判断，所以这里**当前不可达**；但少了这条
      // 前置，一旦有第三个调用点（或前置被改宽）就会拼出 `"C:/base/C:/win/x.txt"` 这种怪东西
      // 再走一遍规范化 —— 属潜在地雷，顺手堵上（盘根仍按 ROOT_LIKE_RE 丢弃）。
      if (ABS_PATH_RE.test(relPath)) return ROOT_LIKE_RE.test(relPath) ? null : relPath;
      // `~` 形态：基准换成 home（与 cwd 无关），cwd 缺失也不影响展开结果
      const useBase = tildeBase || base;
      if (!ABS_PATH_RE.test(useBase)) return null; // 基准本身不是绝对路径 ⇒ 没得拼
      const drive = /^[a-zA-Z]:/.test(useBase) ? useBase.slice(0, 2) : "";
      const joined = useBase + "/" + relPath;
      const parts = [];
      for (const seg of joined.slice(drive.length).split(/[/\\]+/)) {
        if (!seg || seg === ".") continue;
        if (seg === "..") { if (parts.length > 0) parts.pop(); continue; }
        parts.push(seg);
      }
      if (parts.length === 0) return null; // 规范化后落回根（`cwd=/` + `..`）⇒ 不参与
      const out = (drive ? drive + "/" : "/") + parts.join("/");
      return ROOT_LIKE_RE.test(out) ? null : out;
    }
    /**
     * 只做「相对 → 绝对」的补齐（**不套**文件形态判据、不推父目录）。
     * 用于产品侧（琥珀通道）给的 `suggestedDirs` / `inferredDirs`：那些**已经是目录**，
     * 再走一遍 `dirsOfPaths` 会把「名字像文件」的目录（`/proj/build.d`）再取一次父目录
     * = 预填被无端放宽。拼不出绝对路径时原样保留（弹框负责不默认勾选 + 提示）。
     * v1.12.7：`home` 一并透下去，`~` 开头的那几条同样按服务端下发的 home 展开。
     * @param {string[]} paths
     * @param {string|null} [cwd]
     * @param {string|null} [home] `~` 展开基准（服务端下发）
     */
    function absolutizeDirs(paths, cwd, home) {
      const out = [];
      for (const raw of paths || []) {
        if (typeof raw !== "string" || !raw.trim()) continue;
        const trimmed = raw.trim();
        const s = trimmed.replace(/[/\\]+$/, "");
        // 根路径照旧原样透传（产品侧理论上不会给；给了也不在这里放大或吞掉）
        if (!s || ROOT_LIKE_RE.test(s)) {
          if (!out.includes(trimmed)) out.push(trimmed);
          continue;
        }
        const cand = ABS_PATH_RE.test(s) ? s : (resolveAgainstCwd(s, cwd, home) || s);
        if (!out.includes(cand)) out.push(cand);
      }
      return out;
    }
    /**
     * @param {string[]} paths
     * @param {string|null} [cwd] 请求的工作区目录：**非绝对路径按它解析成绝对路径**
     *   （v1.12.6 第五轮用户裁定）；判不出时原样保留，由弹框负责「不默认勾选 + 提示」。
     * @param {string|null} [home] v1.12.7：`~` 形态的展开基准（服务端下发的 os.homedir()）
     */
    function dirsOfPaths(paths, cwd, home) {
      const out = [];
      for (const raw of paths || []) {
        const trimmed = String(raw || "").trim();
        let s = trimmed.replace(/[/\\]+$/, "");
        // 根路径（`/`、`C:`、`C:\`）在任何分支都不参与：写进授权集 = 任意路径免弹
        if (!s || ROOT_LIKE_RE.test(s)) continue;
        // 原始串以分隔符结尾 ⇒ 用户已经明说是目录（解析成绝对路径后仍按目录原样保留）
        const dirByTrailing = /[/\\]$/.test(trimmed);
        if (!ABS_PATH_RE.test(s)) {
          const abs = resolveAgainstCwd(s, cwd, home);
          // 降级（fail-safe）：拼不出来就原样保留（弹框会强制不勾选并提示），
          // **绝不**把非绝对路径当成一条可写规则交给服务端去丢
          if (!abs) {
            if (!out.includes(s)) out.push(s);
            continue;
          }
          s = abs;
        }
        if (dirByTrailing) {
          if (!out.includes(s)) out.push(s);
          continue;
        }
        const base = s.split(/[/\\]/).pop() || "";
        const looksFile = EXT_NAME_RE.test(base) || FILE_FORM_RE.test(base);
        const cand = looksFile ? parentDirOf(s) : s;
        if (cand && !out.includes(cand)) out.push(cand);
      }
      return out;
    }
    /** 弹框文本 → 提交的目录数组（按行拆分、去空、保序去重） */
    function linesToPaths(text) {
      const out = [];
      for (const line of String(text || "").split(/\r?\n/)) {
        const s = line.trim();
        if (s && !out.includes(s)) out.push(s);
      }
      return out;
    }
    /**
     * v1.12.6 U1：授权卡「本会话将记住」的真实文案（取代 1.11.14(D) 的假 category）。
     * 旧实现显示 `permissionPending.category`——那只是 title 的 slug，**不是记忆键**
     * （qoder 场景下它是一长串命令），拿它当「将被记住的东西」是在骗用户。
     * 三态如实说（与产品侧 L1/L2/L3、本插件端点档位一致）：
     *   · 解析得出工具名 ⇒ 真实键 product:tool（该主会话内该工具全路径放行）
     *   · 只有路径     ⇒ 按路径记住，粒度是**目录**（含父目录，见 M1 裁定）
     *   · 两者皆无     ⇒ 明说只放行一次、什么都不记
     */
    function permGrantTip(p) {
      if (!p) return "";
      const key = toolGrantKeyOf(p.product, p.toolName);
      if (key) return "（本会话将记住：" + key + "）";
      const dirs = Array.isArray(p.suggestedDirs) ? p.suggestedDirs.filter(Boolean) : [];
      const paths = Array.isArray(p.paths) ? p.paths.filter(Boolean) : [];
      if (dirs.length > 0 || paths.length > 0) return "（本会话将按路径记住（目录级））";
      return "（本次仅放行一次，不会记住：下次仍会询问）";
    }

    // ── v1.12.15（用户裁定）：高危操作授权的专用弹框 ──────────────────────────────
    // 用户原话：「碰到是高危情况下 的悬浮球弹出，只需要提示 **高危操作权限申请**，
    // 这种情况下，按钮操作 只需要提供 **允许一次** 和 **拒绝**。」追加硬要求：
    // 「需要保留**相关命令的操作内容**」。
    //
    // 为什么必须专用：危险命令门与授权档位**无关**（`rm -rf` / `git push` /
    // `npm publish` 每次都问，这是用户早先亲自定的契约，本轮不动）。而普通卡照常给出
    // 「本会话总是允许该工具 / 总是允许(项目)」，还写着「（本会话将记住：qoder:bash）」
    // ——那是一条**错误承诺**：用户点了下次照样弹，可规则已经真写出去了
    //（现场 dispatches.jsonl：15:30:46 danger-command-block 之后 15:31:31 rule-tool-disk
    // 落了一条 main:bash 工具档，那条规则永远读不到）。
    //
    // 为什么必须显示命令内容：旧渲染只给 description 的前 160 字符，命中片段落在命令
    // 尾部时用户根本看不见 `rm -rf`，于是把高危请求当成普通请求点了允许。
    //
    // 归因信号**两个都认**（`askReason==='danger'` 或 `dangerRule` 非空）：
    //   · ACP 通道（琥珀球）：产品侧 0.7.16 只在危险门命中的 ASK 上随 pending 带
    //     askReason / dangerRule / dangerSegment / dangerCommand；
    //   · 原生通道（蓝球）：本插件服务端在暂存上下文里带 dangerRule / dangerSegment，
    //     命令正文取同一份上下文里的 commandText / argsText（本就在里面，不复制）。
    // **降级契约**（test/danger-permission-dialog.test.js 钉住）：两个信号都没有 ⇒
    // 判不出原因 ⇒ 渲染原有普通卡（老产品侧没这组字段时的既有行为，一字不变）；
    // 只要还剩任一信号，就绝不允许回退成「普通询问 + 承诺可记忆」。
    const DANGER_ASK_TITLE = "高危操作权限申请";
    /** 展示上限：与产品侧 0.7.16 的 MAX_DANGER_COMMAND_CHARS 跨仓同值；超限**如实报数**，不静默截断 */
    const MAX_DANGER_COMMAND_CHARS = 20000;
    /** 归因文本的形态检查：**逐字**返回（连续空白与大小写都是用户判断的依据） */
    function dangerRawText(v) { return typeof v === "string" ? v : ""; }
    /**
     * 取"命令内容"那一块：候选按可信度排序，并优先给出**真的包含命中片段**的那一份。
     * 门判的可能是 `argsText`（自定义执行工具 `{shell:'rm -rf …'}` 既不在命令键名单
     * 也不在工具名名单），这时 `commandText` 是另一段文字——拿它当"命令内容"是误导。
     */
    function dangerAskCommandOf(p, segment) {
      const rawCommand = dangerRawText(p.dangerCommand);
      const cands = [rawCommand, dangerRawText(p.commandText), dangerRawText(p.argsText)].filter((s) => s.length > 0);
      if (cands.length === 0) return { command: "", omitted: 0 };
      const chosen = (segment ? cands.find((s) => s.includes(segment)) : null) || cands[0];
      const shown = chosen.slice(0, MAX_DANGER_COMMAND_CHARS);
      const selfOmitted = chosen.length - shown.length;
      // 产品侧已经截过一遍时（dangerCommand 带上来的省略数），把两段合并报给用户；
      // 只在展示的确实是 dangerCommand 那一份时才叠加，否则会把别的正文的省略数算进来。
      const upstream = chosen === rawCommand && Number.isFinite(p.dangerCommandOmitted) && p.dangerCommandOmitted > 0
        ? p.dangerCommandOmitted : 0;
      return { command: shown, omitted: selfOmitted + upstream };
    }
    /**
     * 高危归因归一化（两条通道同一个入口——判据各写一遍必然漂移）。
     * @returns {{rule: string, segment: string, command: string, commandOmitted: number}|null}
     *   null = 没有任何归因信号（按普通询问渲染）
     */
    function dangerAskOf(p) {
      if (!p || typeof p !== "object") return null;
      const rule = dangerRawText(p.dangerRule).trim();
      if (p.askReason !== "danger" && rule.length === 0) return null;
      const segment = dangerRawText(p.dangerSegment);
      const cmd = dangerAskCommandOf(p, segment);
      return { rule: rule.length > 0 ? rule : "未标注规则名", segment, command: cmd.command, commandOmitted: cmd.omitted };
    }
    /**
     * 高危专用行：标题 + 命中规则 + **触发片段原文** + 命令内容（可滚动、pre-wrap 不折叠
     * 空白）+ **恰好两个按钮**。「记住类」入口（目录编辑弹框、会话档、项目档、落盘）
     * 一个都不渲染——点了也不该写规则，因为写了这条命令下次照样问。
     * @param {{className?: string, meta?: string, danger: object, decided?: boolean,
     *          onAllowOnce: (btn) => any, onDeny: (btn) => any}} o
     */
    function buildDangerAskRow(o) {
      const d = o.danger;
      const row = document.createElement("div");
      row.className = (o.className || "ad-perm-item") + " ad-danger-item";
      const line = (cls, text) => {
        const el = document.createElement("div");
        el.className = cls;
        el.textContent = text;
        row.appendChild(el);
        return el;
      };
      if (o.meta) line("ad-danger-meta", o.meta);
      line("ad-danger-title", DANGER_ASK_TITLE);
      line("ad-danger-rule", "命中危险命令门：" + d.rule);
      if (d.segment) line("ad-danger-seg", "触发片段：" + d.segment);
      if (d.command) {
        line("ad-danger-cmdlabel", "命令内容（原样，未改写）：");
        const pre = document.createElement("pre");
        pre.className = "ad-danger-cmd";
        pre.textContent = d.command;
        row.appendChild(pre);
        if (d.commandOmitted > 0) {
          line("ad-danger-cmdcut", "…另有 " + d.commandOmitted + " 个字符未展示（命中片段已在上方原样给出）");
        }
      } else {
        line("ad-danger-cmdcut", "本次请求没有随归因下发命令正文，请以上方触发片段为准。");
      }
      // 说清"不会被保留"而不是「不可记忆」：后者是术语，前者是用户能验证的事实。
      line("ad-danger-note", "⚠ 危险命令每次都询问，本次选择不会被保留");
      const actions = document.createElement("div");
      actions.className = "ad-danger-actions";
      row.appendChild(actions);
      const mkBtn = (label, cls, tip, hook) => {
        const b = document.createElement("button");
        b.className = "ad-btn mini " + (cls || "");
        b.textContent = label;
        b.title = tip;
        if (o.decided) { b.disabled = true; b.textContent = "已决策"; b.title = "决策已投递，等待产品侧落定"; }
        b.addEventListener("click", (ev) => {
          ev.stopPropagation();
          if (b.disabled) return;
          b.disabled = true;
          b.textContent = "处理中…";
          const r = hook(b);
          // 同步钩子（琥珀球 sendDecision 自己管按钮文案与重投保护）直接交还控制权；
          // 异步钩子按蓝球既有语义处理："cancelled" 把按钮原样还回去，成功打勾。
          if (!r || typeof r.then !== "function") return;
          r.then((res) => {
            if (res === "cancelled") { b.disabled = false; b.textContent = label; return; }
            b.textContent = label + " ✓";
          }).catch((e) => {
            console.warn("[agent-dispatch] 高危授权按钮操作失败:", (e && e.message) || e);
            b.disabled = false;
            b.textContent = label;
          });
        });
        actions.appendChild(b);
        return b;
      };
      mkBtn("允许一次", "", "仅放行本次请求；危险命令不会被保留，下次仍会询问", o.onAllowOnce);
      mkBtn("拒绝", "danger", "拒绝本次请求", o.onDeny);
      return row;
    }

    let grantDialogOpen = false; // 同一时刻只开一个：遮罩在轮询重建的面板之外，重复开会让上一个失去句柄
    /**
     * v1.12.6 U2/U4：「可编辑路径」授权弹框——**点确认才生效**（这是它存在的唯一理由），
     * 且预填**分两组、来源各自标注**（U4 加的那一半）。
     *
     * 为什么必须存在：面板过去按服务端自动分析的结果直接落规则，用户看不到
     * 「要记住的到底是哪几个目录」，而粒度是目录级（M1）；1.12.5 的越权抑制
     * 更是完全不可见（客户端不看响应体）。这里把预填目录摊开给用户改。
     *
     * 为什么必须分两组（U4）：预填值里有**不可信来源**。第一组是请求**实际触达**的
     * 路径（结构化字段：被编辑的文件、命令的目标）；第二组是从**正文/命令文本**里
     * 扫出来的字符串——正文是被编辑的**内容**，文件里谁都可以写一行
     * `/etc/passwd`、`~/.ssh`、`~/.qoder/settings.json`。把它们和实际触达项混成
     * 一档、默认全勾，等于让用户点一次「确认」就把这些敏感目录授权出去。
     * 所以：第二组**默认不勾选**，且**只有勾选的条目**才会作为 paths 发出去。
     *
     * 调用方可选 `toolTierDisk`（v1.12.7）：本通道的「工具名档」是否落盘。
     * 琥珀（ACP）通道 `allow-always` 时产品侧会把 `tools` 写进共用白名单 ⇒ true；
     * 宿主通道**没有**落盘工具名档（服务端只按 rootSessionId 记内存）⇒ 恒 false。
     * 二级选择里那句「落盘档 / 本会话档」由本弹框按它组装——调用方各写一遍必然漂移。
     * 缺省 false（说不清就绝不声称落盘）。
     *
     * · opts.suggestedDirs = 第一组（默认勾选）；opts.inferredDirs = 第二组（默认不勾）
     * · opts.cwd = 本请求的工作区目录（服务端 `host-approval-context` 回传）。
     *   非绝对路径的候选**在这里不解析**（解析发生在调用方的 `dirsOfPaths(paths, cwd)`），
     *   它只决定提示文案；且任何**非绝对路径**的候选一律**强制不勾选** + 行下给提示
     *   （v1.12.6 第五轮 · 终审 M-B：服务端只认绝对路径，默认勾选它等于骗用户，
     *   历史后果是静默退化成工具名档 = 授权放大到整个工具）
     * · 两档目录级去重在本弹框里做一次（产品侧已排除过，宿主通道的目录化发生在
     *   客户端、排除必须跟着发生在目录化之后，否则同一目录两组各一条、勾选自相矛盾）
     * · 每行：复选框 + 可编辑文本 + 删除；可「+ 添加目录」补一行（补的默认勾选）
     * · **全不勾/删空/留下的全非法 ⇒ 点「确认」先弹二级选择**（v1.12.7 用户裁定）：
     *   ①「仅本次放行」= `{paths:null, mode:'once'}`，一条规则都不写；
     *   ②「该工具对任意路径都将放行」= `{paths:[], mode:'tools'}`，显式空数组 ⇒ 进 `tools` 字段。
     *   理由：改前这条等于**默认**「按工具名记住」，把「这几个目录」静默放大成
     *   「该工具任意路径」，用户从没被问过。二级取消/Esc ⇒ 回一级，什么都没决定。
     *   两级都不选也**绝不**默认成任何一档。
     * · 勾选非空 ⇒ `{paths:[…], mode:'paths'}`（与改前逐字一致）
     * · 取消 / Esc / 点遮罩 ⇒ resolve(null)：**不发决策、不写任何规则**
     * · 最后一行只读显示当前工具名（行输入框里放不进只读行，故放在紧贴其下的只读区）
     * · 取消 / Esc / 点遮罩 ⇒ resolve(null)：**不发决策、不写任何规则**
     *   （转红实验④「弹框绕过确认直接生效」就是钉这一条）
     * @returns {Promise<{paths: string[]|null, mode: 'paths'|'once'|'tools'}|null>}
     */
    function openGrantDialog(opts) {
      const o = opts || {};
      if (typeof document === "undefined" || grantDialogOpen) return Promise.resolve(null);
      const toolText = o.toolName ? String(o.toolName) : null;
      const key = toolGrantKeyOf(o.product, o.toolName);
      // 词法目录：只认字符串（脏载荷里的数字/对象滤掉，不 String() 成 "/…/42" 这种假目录）
      const dirs = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()) : []);
      const suggested = dirs(o.suggestedDirs);
      const inferred = dirs(o.inferredDirs).filter((d) => !suggested.includes(d));
      // 请求的工作区目录（服务端 host-approval-context 回传的 cwd）：非绝对路径的解析基准。
      // 取不到 ⇒ 该行降级为「原样显示 + 强制不勾选 + 就地提示」，绝不默认勾选。
      const cwd = typeof o.cwd === "string" && o.cwd.trim() ? o.cwd.trim() : null;
      // v1.12.7：`~` 展开基准（服务端 host-approval-context / /agent-api/active 回传的 home）。
      // 浏览器半不能 require('os')、也拿不到 process.env.HOME，只能靠服务端下发。
      // 取不到 ⇒ `~` 行保持旧行为（原样 + 不勾选 + 警示），绝不猜。
      const homePath = typeof o.home === "string" && o.home.trim() ? o.home.trim() : null;
      /**
       * v1.12.6 第五轮（终审 M-B + 用户裁定）：**非绝对路径一律不默认勾选，并就地说明原因**。
       * 上游（`dirsOfPaths` / `absolutizeDirs`）已尽量把相对路径按 `cwd`、把 `~` 按服务端下发的
       * `home` 拼成绝对路径；到这里还不是绝对路径的，只有三种情况：`~` 行没拿到 home
       * （或 `~user/…` 这种不展开的形态）、本次请求没拿到工作区目录、或填了别的东西。
       * 服务端 `validateDeclaredPaths` 只认绝对路径（`非绝对路径` 逐条丢弃），所以这样的候选
       * **永远写不进规则**：默认勾选它就等于让用户以为授权了 `./x.txt`，实际服务端把 `paths` 丢空 ——
       * 改前更会静默退化成**工具名档**（授权放大到整个工具）。
       * 现在的处置：照旧渲染成可编辑行（用户能直接改成绝对路径），但复选框**强制关闭**，
       * 行下给一条可读提示；改回绝对路径后提示消失、复选框可勾。
       * v1.12.7：提示文案必须**如实**——`~` 现在是会展开的（只要服务端给了 home），
       * 不能再写「`~` 不展开、服务端只认绝对路径所以丢弃」这种已经变成假话的解释。
       */
      const unresolvedNote = (d) => {
        const s = String(d || "").trim();
        if (ABS_PATH_RE.test(s)) return "";
        if (/^~/.test(s)) {
          return "⚠ 非绝对路径："
            + (homePath
              ? "只展开 `~` 与 `~/…`（`~user/…` 不展开，手写的这行也不会被改写）"
              : "本次没拿到服务端下发的 home，`~` 无法展开")
            + "；服务端只认绝对路径，会把它丢弃 ⇒ 这条**不会写入规则**。请改成绝对路径后再勾选。";
        }
        return "⚠ 非绝对路径："
          + (cwd ? "没按工作区目录解析成绝对路径" : "本次没拿到工作区目录（cwd），无法解析成绝对路径")
          + "；服务端只认绝对路径，会把它丢弃 ⇒ 这条**不会写入规则**。请改成绝对路径后再勾选。";
      };
      return new Promise((resolve) => {
        grantDialogOpen = true;
        const mask = document.createElement("div");
        mask.className = "ad-grant-mask";
        const dlg = document.createElement("div");
        dlg.className = "ad-grant-pop";
        dlg.setAttribute("role", "dialog");
        dlg.setAttribute("aria-modal", "true");
        const head = document.createElement("div");
        head.className = "ad-grant-head";
        head.textContent = o.title || "确认要记住的路径";
        const note = document.createElement("div");
        note.className = "ad-grant-note";
        // 档位说明由弹框自己按 escalation/projectTier 组装：调用方各写一遍，
        // 越权场景下就会写出「会落盘」这种和下面红字互相打脸的话。
        // v1.12.7：越权那句不能只说「目录只到本会话」；而「目录全删空」现在**不是**
        // 直接按工具名记住——点确认会先进二级选择（用户裁定）。两件事都要说清，
        // 否则又是一次「面板说谎」。
        note.textContent = o.escalation
          ? "沙箱越权（escalate sandbox）：把目录全删空（或一条都不勾）则在点「确认」时让你二选一："
            + "「仅本次放行」什么都不写，「该工具对任意路径都将放行」＝"
            + (o.toolTierDisk
              ? "落盘一条工具档（本项目内该工具对任意路径放行，含工作区外，重载宿主后仍生效）"
              : "本会话内该工具对任意路径放行（含工作区外），不落盘")
            + "；危险命令仍会每次询问。"
            + (o.projectTier
              ? "勾了目录再点本项目档 ⇒ **照常落盘**到项目白名单（v1.12.14：用户显式点项目档不再因越权降级），同工作目录跨会话生效。"
              : "确认后的目录只到本会话，不落盘，换会话仍会询问。")
          : (o.projectTier
            ? "项目档：确认后的目录会落盘到共用白名单，同工作目录跨会话生效；一条都不勾时点「确认」会让你二选一（仅本次放行 / 该工具对任意路径放行）。"
            : "会话档：确认后的目录只在当前主会话内生效，不落盘；一条都不勾时点「确认」会让你二选一（仅本次放行 / 该工具对任意路径放行）。");
        const body = document.createElement("div");
        body.className = "ad-grant-body";
        const rows = []; // {row, chk, input, del}——勾选与文本都以 DOM 实时状态为准
        const checkedRows = () => rows.filter((r) => r.chk.checked);
        // 一行可容纳多个目录（用户粘贴换行）：沿用 linesToPaths 的按行拆分+去重
        const collect = () => {
          const out = [];
          for (const r of checkedRows()) {
            for (const p of linesToPaths(r.input.value)) if (!out.includes(p)) out.push(p);
          }
          return out;
        };
        const hint = document.createElement("div");
        hint.className = "ad-grant-hint";
        // v1.12.6（终审 M3）：门命中（dangerRule）时必须在**弹框里**也说清「每次都问、
        // 不可记忆」——写侧一字未动（确认照样写规则），但读取侧那道门排在最前，
        // 这三条命令永远读不到刚写的规则。不说 = 让用户以为已经授权、然后反复被问。
        if (o.dangerRule) {
          const dangerNote = document.createElement("div");
          dangerNote.className = "ad-grant-danger";
          dangerNote.textContent = "⚠ 该命令每次都会询问，不可记忆（命中危险命令门：" + String(o.dangerRule)
            + "）：确认后规则照写，但这类命令在读取侧被门永远排在规则之前，下次仍然询问。";
          body.appendChild(dangerNote);
        }
        const syncHint = () => {
          // v1.12.6 第五轮（终审 M-B）：非绝对路径的提示随文本实时重算——
          // 用户把它改成绝对路径后提示自动消失（此时那一行才可以勾选）。
          for (const r of rows) {
            if (!r.warn) continue;
            const n = unresolvedNote(r.input.value);
            r.warn.textContent = n;
            r.warn.className = n ? "ad-grant-rowwarn" : "ad-grant-rowwarn-ok";
          }
          const list2 = collect();
          const unchecked = rows.filter((r) => !r.chk.checked).length;
          if (list2.length === 0) {
            hint.className = "ad-grant-hint warn";
            // v1.12.7：勾选为空**不再**等于「确认后直接按工具名档提交」——确认会先弹二级选择
            // （「仅本次放行」/「该工具对任意路径都将放行」）。所以这里的口径必须改成
            // 「等一下会让你选」，同时把两条路的后果都先说清（危险命令每次都问、落盘与否）。
            // 改前那句「一条都没勾 ⇒ 本次只记住工具名」在点确认那一刻已经不再成立，
            // 留着就是面板说谎（用户专门抓到过的问题）。
            const toolTierLine = "「该工具对任意路径都将放行」= 只记住工具名"
              + (key ? "（" + key + "）" : "（" + toolText + "）")
              + "：" + (o.toolTierDisk
                ? "**落盘一条工具档**到项目白名单：同工作目录**跨会话**生效，该工具对**任意路径**放行（含工作区外）"
                : "**本会话内该工具对任意路径放行（含工作区外）**，不落盘")
              + "；危险命令（rm -rf / git push / npm publish）仍会每次询问"
              + (o.escalation && !o.toolTierDisk ? "；沙箱越权不写落盘白名单 ⇒ 换会话仍会询问" : "") + "。";
            hint.textContent = toolText
              ? "一条都没勾 ⇒ 点「确认」时会让你再选一次："
                + "「仅本次放行」（什么都不写、只放行这一次）还是"
                + toolTierLine
              : "一条都没勾且本条解析不出工具名 ⇒ 只有「仅本次放行」可选（工具名档没有可写的键）："
                + "等于什么都不记住，只放行这一次"
                + (o.projectTier
                  ? "（不过你若返回上一层勾了目录再点本项目档，仍会落盘到项目白名单）。"
                  : o.escalation ? "（沙箱越权不写落盘白名单，换会话仍会询问）。" : "。");
            return;
          }
          hint.className = "ad-grant-hint";
          hint.textContent = "将记住 " + list2.length + " 个目录（目录级：这些目录及其下的路径都不再弹）"
            + (o.projectTier
              ? "；项目档会落盘到共用白名单（同工作目录跨会话生效）。"
              : "；只到本会话，不落盘。")
            + (unchecked > 0 ? "（另有 " + unchecked + " 行未勾选，不会写入规则）" : "");
        };
        const mkRow = (value, checked, warnEl) => {
          const row = document.createElement("div");
          row.className = "ad-grant-row";
          const chk = document.createElement("input");
          chk.type = "checkbox";
          chk.className = "ad-grant-chk";
          chk.checked = !!checked;
          chk.title = checked ? "已勾选：这条目录会写进规则" : "未勾选：这条目录不会写进规则";
          const input = document.createElement("input");
          input.type = "text";
          input.className = "ad-grant-dir";
          input.spellcheck = false;
          input.placeholder = "/绝对/路径/目录";
          input.value = String(value || "");
          input.addEventListener("input", syncHint);
          input.addEventListener("change", syncHint);
          const del = document.createElement("button");
          del.className = "ad-grant-del";
          del.textContent = "×";
          del.title = "删掉这一条（不想记住它就删掉，不用先取消勾选）";
          // v1.12.6 第五轮（终审 M-B）：非绝对路径的行**强制不勾选**，行下挂一条提示。
          // 用户把文本改成绝对路径后，提示自动消失（syncHint 里按当前文本重算）。
          const rec = { row, chk, input, del, warn: warnEl || null };
          chk.addEventListener("change", syncHint);
          del.addEventListener("click", (ev) => {
            ev.stopPropagation();
            const i = rows.indexOf(rec);
            if (i >= 0) rows.splice(i, 1);
            if (rec.warn) rec.warn.remove();
            row.remove();
            syncHint();
          });
          rows.push(rec);
          row.appendChild(chk);
          row.appendChild(input);
          row.appendChild(del);
          return rec;
        };
        const mkGroup = (title, sub, items, checked) => {
          const g = document.createElement("div");
          g.className = "ad-grant-group";
          const t = document.createElement("div");
          t.className = "ad-grant-gtitle";
          t.textContent = title;
          g.appendChild(t);
          const s = document.createElement("div");
          s.className = "ad-grant-gsub";
          s.textContent = sub;
          g.appendChild(s);
          const box = document.createElement("div");
          box.className = "ad-grant-rows ad-grant-input";
          if (items.length === 0) {
            const e = document.createElement("div");
            e.className = "ad-grant-gempty";
            e.textContent = "（本条没有可预填的目录）";
            box.appendChild(e);
          }
          for (const d of items) {
            // 非绝对路径 ⇒ 提示行 + 强制不勾选（默认勾选一条注定被服务端丢弃的路径，
            // 正是终审 M-B 那条「静默退化成工具名档」的入口）
            const note = unresolvedNote(d);
            let warnEl = null;
            if (note) {
              warnEl = document.createElement("div");
              warnEl.className = "ad-grant-rowwarn";
              warnEl.textContent = note;
            }
            const rec = mkRow(d, checked && !note, warnEl);
            box.appendChild(rec.row);
            if (warnEl) box.appendChild(warnEl);
          }
          g.appendChild(box);
          body.appendChild(g);
          return box;
        };
        const sugBox = mkGroup(
          "请求实际触达的目录（建议）",
          "来源：工具调用里真实的路径字段（被编辑的文件、命令的目标路径）。",
          suggested,
          true,
        );
        mkGroup(
          "从正文/命令文本推测的目录（默认不选）",
          "这些路径只是文本里出现的字符串，可能来自被编辑的文件内容，不是本次请求真正操作的对象。要记住才勾选。",
          inferred,
          false,
        );
        const add = document.createElement("button");
        add.className = "ad-grant-add";
        add.textContent = "+ 添加目录";
        add.title = "自己补一行要记住的目录（补出来的默认勾选）";
        add.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const rec = mkRow("", true);
          sugBox.appendChild(rec.row);
          syncHint();
          try { rec.input.focus(); } catch (e) {}
        });
        body.appendChild(add);
        body.appendChild(hint);
        const toolLine = document.createElement("div");
        toolLine.className = "ad-grant-tool";
        toolLine.textContent = toolText
          ? "工具：" + toolText + "（只读，不可编辑；一条都不勾时规则就退化成它）"
          : "工具：（本条解析不出工具名）";
        toolLine.title = "只读：这条规则退化工具名档时用的就是它";
        body.appendChild(toolLine);
        const actions = document.createElement("div");
        actions.className = "ad-grant-actions";
        const btnCancel = document.createElement("button");
        btnCancel.className = "ad-btn";
        btnCancel.textContent = "取消";
        const btnOk = document.createElement("button");
        // v1.12.6(UI)：额外挂 .ad-grant-ok —— 弹框在 body 上，拿不到 .ad-panel 作用域里的
        // --ad-accent，主按钮会退化成透明底 + 白字（见 CSS 里 .ad-grant-ok 的说明）。
        // 只新增类、不动既有 `ad-btn primary` 两个类（消费这两个类的面板/浮球与测试断言都不受影响）。
        btnOk.className = "ad-btn primary ad-grant-ok";
        btnOk.textContent = "确认";
        const finish = (value) => {
          document.removeEventListener("keydown", onKey, true);
          mask.remove();
          grantDialogOpen = false;
          resolve(value);
        };
        const onKey = (ev) => {
          if (ev.key !== "Escape") return;
          ev.preventDefault(); ev.stopPropagation();
          // v1.12.7：二级选择开着时 Esc 只关二级（回到一级继续编辑），**不是**关整个弹框。
          // 实现上二级层**没有**自己的 keydown 监听（它只是 mask 里的一个子节点），
          // 全框只有这一个 document 级监听 ⇒ 必须在它里面先分流，否则 Esc 会直接
          // finish(null) 把一级连同二级一起关掉（用户就没法回去改选了）。
          if (secondLevel) { closeSecondLevel(); return; }
          finish(null);
        };
        document.addEventListener("keydown", onKey, true);
        mask.addEventListener("click", (ev) => { if (ev.target === mask) finish(null); });
        btnCancel.addEventListener("click", (ev) => { ev.stopPropagation(); finish(null); });
        // 只发勾选过的行；未勾选的一律不进规则（U4 的核心那条）。
        // v1.12.7（用户裁定）：勾选后**为空**（一行都没勾 / 全删光 / 留下的全非法）时
        // 不再直接提交成「工具名档」，先弹二级选择让用户明确说清要哪一种。
        btnOk.addEventListener("click", (ev) => { ev.stopPropagation(); openSecondLevel(); });
        const mk = (el, label, tip) => { el.textContent = label; el.title = tip; return el; };

        // ── v1.12.7 二级选择（用户裁定：「空路径集」不得直接提交成工具档）──
        //
        // 「空」的三种入口都落到这里：① 一行都没勾选；② 用户把所有行都删光；
        // ③ 留下的行**全部**是非法格式（非绝对路径 / 拼不出绝对目录 ⇒ 服务端必丢）。
        // 三种都会让「确认」变成一次语义不明的提交：历史上它等于「只按工具名记住」＝
        // 把授权从「这几个目录」放大成「该工具任意路径」。用户裁定必须显式二选一：
        //   · 「仅本次放行」⇒ 只放行这一次，**一条规则都不写**（不写路径档、不写工具档、不落盘）；
        //   · 「该工具对任意路径都将放行」⇒ 进入 `tools` 字段，并**明说**是会话档还是落盘档。
        // 取消 / Esc / 点遮罩 ⇒ 关掉二级、回到一级：**什么都没决定**，不提交、不写规则。
        //
        // 与服务端契约的对齐（这是本段最容易出错的点）：
        //   · 「仅本次放行」**不把那批非法路径回传**。回传「非空但全非法」会命中服务端/产品侧
        //     的 `mode:'none'` 拒写出口——那是防「误给非法路径」的 fail-closed 兜底，
        //     不该被当成一个正常出口来依赖（将来校验一旦放宽，用户没要过的规则就会被静默写下）。
        //     ACP 通道走 `answer:'allow-once'`（产品侧对 allow-once 不写任何档）；
        //     宿主通道干脆不 POST。
        //   · 「该工具对任意路径」**显式回传 `paths: []`**（空集＝用户明确意图），
        //     服务端/产品侧据此进入工具档，与「给了但被丢弃」严格区分开。
        const toolTierDisk = o.toolTierDisk === true; // 该通道的工具档是否落盘（调用方按通道给）
        function closeSecondLevel() {
          if (!secondLevel) return;
          try { secondLevel.remove(); } catch (e) {}
          secondLevel = null;
        }
        function openSecondLevel() {
          const picked = collect();
          // 非空 ⇒ 与改前逐字一致：直接按勾选结果提交（路径档）
          if (picked.length > 0) { finish({ paths: picked, mode: "paths" }); return; }
          if (secondLevel) return;
          const layer = document.createElement("div");
          layer.className = "ad-grant-2nd";
          const card = document.createElement("div");
          card.className = "ad-grant-2nd-card";
          card.setAttribute("role", "dialog");
          card.setAttribute("aria-modal", "true");
          const title = document.createElement("div");
          title.className = "ad-grant-2nd-title";
          title.textContent = "没有勾选任何目录——这次要怎么放行？";
          const noteEl = document.createElement("div");
          noteEl.className = "ad-grant-2nd-note";
          noteEl.textContent = "目录一条都没勾（或全被删光、或留下的都不是绝对路径）⇒ 落不了路径档。"
            + "请明确选一种；两条都不选就什么都不写、什么都不决定。";
          const onceBtn = document.createElement("button");
          onceBtn.className = "ad-grant-2nd-opt";
          onceBtn.textContent = "仅本次放行 —— 只放行这一次，一条规则都不写";
          onceBtn.title = "不写路径档、不写工具名档、不落盘：下次同类请求仍会询问";
          const allBtn = document.createElement("button");
          allBtn.className = "ad-grant-2nd-opt ad-grant-ok";
          allBtn.textContent = "该工具对任意路径都将放行 —— 进入工具名档（"
            + (toolTierDisk ? (o.projectTier ? "落盘档，同工作目录跨会话生效" : "本会话档") : "本会话档")
            + "）";
          allBtn.title = "进入 steps=tools 那一档：该工具不再按目录判定";
          const allNote = document.createElement("div");
          allNote.className = "ad-grant-2nd-note";
          if (!toolText) {
            // 解析不出工具名 ⇒ 工具档没有键可写。给一个**明确不可点**的选项 + 原因，
            // 而不是把它藏起来（藏起来用户会以为是自己点错了）。
            allBtn.disabled = true;
            allNote.textContent = "⚠ 本条解析不出工具名 ⇒ 工具名档无从谈起（没有可写的键）。"
              + "请返回上一层，改成勾选/填写具体目录。";
          } else {
            allNote.textContent = "⚠ 选这一条后："
              + (toolTierDisk
                ? (o.projectTier
                  ? "同工作目录**跨会话**生效（落盘到共用白名单），该工具对**任意路径**放行（含工作区外）；"
                  : "该工具在本会话内对**任意路径**放行（含工作区外），不落盘；")
                // v1.12.14：删掉了旧提示「本通道的工具名档只有会话级——要落盘请勾目录」：
                // 项目档这一支现在真的落盘工具档（toolTierDisk=true），那句话已成假话。
                : "该工具在**本会话内**对**任意路径**放行（含工作区外），**不落盘**（换会话仍会询问）；")
              + "危险命令（rm -rf / git push / npm publish）仍会每次询问"
              + (o.escalation
                // v1.12.14：越权抑制的是**路径档**；用户明确点选的工具档照落（否则二级选择
                // ② 在工作区外场景下等于空转——用户报的就是这个场景）。
                ? (toolTierDisk
                  ? "；沙箱越权不再抑制任何档（v1.12.14 用户裁定），这一条仍会落盘"
                  : "；这一档本来就不落盘（换会话仍会询问）")
                : "") + "。";
          }
          const acts = document.createElement("div");
          acts.className = "ad-grant-2nd-actions";
          const back = document.createElement("button");
          back.className = "ad-btn";
          back.textContent = "返回上一层";
          back.title = "什么都没决定：不提交、不写规则（也可以直接按 Esc）";
          back.addEventListener("click", (ev) => { ev.stopPropagation(); closeSecondLevel(); });
          onceBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            // 明确「本次允许」：paths 置 null（**不回传**那批非法路径），mode='once'
            finish({ paths: null, mode: "once" });
          });
          allBtn.addEventListener("click", (ev) => {
            ev.stopPropagation();
            // 明确「工具全放行」：显式空数组 = 用户意图，服务端/产品侧据此进工具档
            finish({ paths: [], mode: "tools" });
          });
          acts.appendChild(back);
          card.appendChild(title);
          card.appendChild(noteEl);
          card.appendChild(onceBtn);
          card.appendChild(allBtn);
          card.appendChild(allNote);
          card.appendChild(acts);
          layer.appendChild(card);
          // 点二级遮罩 = 关二级（回到一级），不是关整个弹框
          layer.addEventListener("click", (ev) => {
            ev.stopPropagation();
            if (ev.target === layer) closeSecondLevel();
          });
          mask.appendChild(layer);
          secondLevel = layer;
          setTimeout(() => { try { onceBtn.focus(); } catch (e) {} }, 0);
        }
        let secondLevel = null;
        mk(btnCancel, "取消", "不发决策、不写任何规则（本次请求继续等待）");
        mk(btnOk, "确认", "按上面**勾选后**的结果落规则并放行本次；一条都没勾时会再问一次「本次允许」还是「该工具对任意路径放行」");
        actions.appendChild(btnCancel);
        actions.appendChild(btnOk);
        syncHint();
        dlg.appendChild(head);
        dlg.appendChild(note);
        dlg.appendChild(body);
        dlg.appendChild(actions);
        mask.appendChild(dlg);
        document.body.appendChild(mask);
        setTimeout(() => {
          const first = rows.length > 0 ? rows[0].input : null;
          if (!first) return;
          try { first.focus(); first.setSelectionRange(first.value.length, first.value.length); } catch (e) {}
        }, 0);
      });
    }
    // 返回一跳：标题 → 侧边栏直点；点不到（未渲染/折叠）→ sessions.search 找 id 再 open
    let goBackHandler = null; // apply 时绑定（闭包持有 sessions 服务）
    // v0.9.28：会话头部返回按钮——挂 conversation.session.header.actions 槽，
    // 任何 tab 视图（对话/轨迹/Agent 调度）下都可见，一跳返回，不用先切面板再点返回。
    // 导航栈空时返回 null（不占位）。
    function HeaderBackButton() {
      const [, setTick] = React.useState(0);
      React.useEffect(() => {
        const fn = () => setTick((n) => n + 1);
        navSubs.add(fn);
        return () => navSubs.delete(fn);
      }, []);
      if (navStack.length === 0) return null;
      return React.createElement("button", {
        className: "ad-header-back",
        title: "返回跳转前的会话（共 " + navStack.length + " 层）",
        onClick: () => { if (goBackHandler) goBackHandler(); },
      }, "← 返回");
    }

    // ── v0.8.3：DSH 官方 logo（提取自 DSH Desktop build/tray-icon.svg，
    // 色值改 currentColor 跟随主题，非写死 #4D6BFE）──
    const DSH_LOGO_PATH =
      "M48.8354 10.0479C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076C46.7793 11.624 45.9048 12.1597 44.7622 12.0957C43.0923 12 41.666 12.5356 40.4058 13.8398C40.1377 12.2319 39.2476 11.272 37.8926 10.6558C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982C35.6235 8.82373 35.5293 8.27197 35.356 7.72754C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568C33.418 8.75195 33.1733 10.0479 33.1973 11.3599C33.2524 14.312 34.4736 16.6641 36.8999 18.3359C37.1758 18.5278 37.2466 18.7197 37.1597 19C36.9946 19.5757 36.7974 20.1357 36.624 20.7119C36.5137 21.0801 36.3486 21.1597 35.9624 21C34.6309 20.4321 33.481 19.5918 32.4644 18.5757C30.7393 16.8721 29.1792 14.9917 27.2334 13.52C26.7764 13.1758 26.3193 12.856 25.8467 12.5518C23.8618 10.584 26.1069 8.96777 26.627 8.77588C27.1704 8.57568 26.8159 7.8877 25.0591 7.896C23.3022 7.90381 21.6953 8.50391 19.647 9.30371C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799C11.8159 42.0322 16.1255 43.5762 21.041 43.2803C24.0269 43.104 27.3516 42.6963 31.1016 39.4561C32.0469 39.936 33.0396 40.1279 34.686 40.272C35.9546 40.3921 37.1758 40.208 38.1211 40.0078C39.6021 39.688 39.4995 38.2881 38.9639 38.0322C34.623 35.9678 35.5762 36.8081 34.71 36.1279C36.9155 33.4639 40.2402 30.6958 41.54 21.728C41.6426 21.0161 41.5557 20.5679 41.54 19.9917C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878C47.9292 16.9199 49.064 14.3438 49.3315 11.2559C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479ZM24.3262 37.8398C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878C17.7402 36.832 17.8979 37.3442 17.2832 37.728C15.9282 38.584 13.5728 37.4399 13.4624 37.3838C10.7207 35.7358 8.42822 33.5601 6.81348 30.584C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519C6.17529 19.96 7.22314 19.9199 8.23926 20.0718C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759C21.002 27.5439 22.3252 29.6558 23.6885 31.7202C25.1377 33.9121 26.6978 36 28.6831 37.7119C29.3843 38.312 29.9434 38.7681 30.479 39.104C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398ZM26.3433 24.6001C26.3433 24.248 26.6191 23.9678 26.9658 23.9678C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078C27.2651 24.04 27.3438 24.0879 27.4067 24.1602C27.5171 24.272 27.5801 24.4321 27.5801 24.6001C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001ZM32.6064 27.8799C32.2046 28.0479 31.8027 28.1919 31.4165 28.208C30.8179 28.2397 30.1641 27.9922 29.8096 27.688C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199C28.8721 24.248 28.7144 23.8159 28.2495 23.4238C27.8716 23.104 27.3911 23.0161 26.8633 23.0161C26.666 23.0161 26.4849 22.9277 26.3511 22.856C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201C26.1777 22.0078 26.4458 21.7358 26.5088 21.688C27.2256 21.272 28.0527 21.4077 28.8169 21.7197C29.5259 22.0161 30.0615 22.5601 30.834 23.3281C31.6216 24.2559 31.7632 24.5117 32.2124 25.208C32.5669 25.752 32.8901 26.312 33.1104 26.9521C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799Z";
    function DSHLogo(props) {
      return React.createElement("svg", Object.assign({
        viewBox: "0 0 50 50",
        className: "ad-dsh-logo",
        "aria-hidden": true,
      }, props || {}), React.createElement("path", { d: DSH_LOGO_PATH, fill: "currentColor" }));
    }
    // v0.8.9：原生 DOM 场景（悬浮球弹窗等）用的 SVG 字符串版本
    function dshLogoSvg(sizePx) {
      return '<svg viewBox="0 0 50 50" class="ad-dsh-logo" style="width:' + sizePx + 'px;height:' + sizePx + 'px" aria-hidden="true"><path d="' + DSH_LOGO_PATH + '" fill="currentColor"/></svg>';
    }
    // v0.9.14：DOM 侧头像统一首字回退（与 React 侧 firstGlyph 同规则）
    function firstGlyphDom(name) {
      const s = String(name || "").trim();
      if (!s) return "";
      const ch = Array.from(s)[0];
      return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
    }
    function setAvatarEl(em, emoji, name) {
      if (emoji) { em.className = "ad-avatar"; em.textContent = emoji; return; }
      const g = firstGlyphDom(name);
      if (g) { em.className = "ad-avatar mono"; em.textContent = g; return; }
      em.className = "ad-avatar logo"; em.innerHTML = dshLogoSvg(17);
    }

    // triggers 兼容：注册表存字符串（分号/顿号分隔），表单内用数组；两种输入都归一
    function triggersToList(t) {
      if (Array.isArray(t)) return t.filter(Boolean);
      if (typeof t === "string") return t.split(/[;；、,，]/).map((s) => s.trim()).filter(Boolean);
      return [];
    }
    function triggersToText(t) { return triggersToList(t).join("；"); }

    // v0.9.14：头像回退首字 monogram（用户推翻 0.9.13 白 logo 方案）
    function firstGlyph(name) {
      const s = String(name || "").trim();
      if (!s) return "";
      const ch = Array.from(s)[0];
      return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
    }
    function Avatar({ name, emoji, title }) {
      if (emoji) return React.createElement("span", { className: "ad-avatar", title: title }, emoji);
      const g = firstGlyph(name);
      if (g) return React.createElement("span", { className: "ad-avatar mono", title: title }, g);
      return React.createElement("span", { className: "ad-avatar", title: title }, React.createElement(DSHLogo));
    }

    // 时间戳 → "MM-DD HH:mm:ss"（秒级时间戳自动补 *1000 防御）
    function fmtTime(ts) {
      let t = Number(ts);
      if (!isFinite(t) || t <= 0) return "--:--";
      if (t < 1e12) t = t * 1000;
      const d = new Date(t);
      const p = (n) => (n < 10 ? "0" + n : "" + n);
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    // ISO 时间字符串 → "MM-DD HH:mm:ss"（无效返回 "--:--"）。
    // 注意：/agent-api/active 与 dispatches 的 ts 均为 ISO 字符串，
    // fmtTime(Number(iso)) 会得 NaN，必须走 Date 解析。
    function fmtTs(ts) {
      if (typeof ts !== "string" && typeof ts !== "number") return "--:--";
      const d = new Date(ts);
      if (isNaN(d.getTime())) return "--:--";
      const p = (n) => (n < 10 ? "0" + n : "" + n);
      return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
    }

    // 步骤拓扑分层（与宿主半 lib/squads.js topoLayers 同算法）：
    // 返回分层下标数组，每层内并行；有环抛错（表单保存前做环检测）。
    function topoLayers(steps) {
      const list = Array.isArray(steps) ? steps : [];
      const done = new Set();
      const layers = [];
      let guard = 0;
      while (done.size < list.length) {
        if (++guard > list.length + 1) throw new Error("小队模板存在依赖环");
        const layer = [];
        for (let i = 0; i < list.length; i++) {
          if (done.has(i)) continue;
          const deps = list[i].dependsOn || [];
          if (deps.every((d) => done.has(d))) layer.push(i);
        }
        if (layer.length === 0) throw new Error("小队模板存在依赖环");
        for (const i of layer) done.add(i);
        layers.push(layer);
      }
      return layers;
    }

    // 组队步骤流文本：按依赖拓扑分层，层内并行用「｜」连接，层间串行用「→」。
    // 例：三步全无依赖 → "日志｜数据｜代码"；第三步依赖前两步 → "日志｜数据 → 代码"。
    function squadStepsText(steps) {
      const list = Array.isArray(steps) ? steps : [];
      if (!list.length) return "—";
      let layers;
      try { layers = topoLayers(list); } catch { return "（依赖关系存在环，无法排序）"; }
      return layers
        .map((layer) => layer.map((i) => (list[i] && (list[i].phase || list[i].agentId)) || "步骤" + (i + 1)).join("｜"))
        .join(" → ");
    }

    // v1.11.12：路由摘要——model 为空（ACP 用产品默认）时不再拼出 "qoder/undefined"
    function routeSummary(r) {
      if (!r || (!r.provider && !r.model)) return "";
      const prov = r.provider || "?";
      const mid = typeof r.model === "string" && r.model.trim().toLowerCase() !== "default" ? r.model.trim() : "";
      return prov + (mid ? "/" + mid : "（默认模型）") + (r.effort ? "@" + r.effort : "");
    }

    // ── Agent编辑表单（新建 / 编辑共用；initial 为 null 表示新建；onDelete 非空时表单尾显示删除按钮）──
    // v1.11.12 表单数据契约（GET /agent-api）：
    //   models: { llmProvider: [modelId...] }  —— 宿主 LLM 目录
    //   subagentProviders: [providerName...]   —— 宿主已注册 subagent provider（ACP）
    //   productModels: { provider: {models, efforts, modelEfforts?, probedAt?, error?} }
    //                                       —— product-subagents 落盘的 provider 级缓存
    //   llmEfforts: { provider: { model: {efforts, defaultEffort?} } } —— LLM 真实推理档位
    // 任一字段缺失（旧宿主/旧插件/缓存未生成）都必须优雅降级，不许炸表单。
    function AgentForm({ initial, isNew, onSave, onCancel, onDelete, models, subagentProviders, productModels, llmEfforts, defaultModel, onProbeModels }) {
      const [f, setF] = React.useState(() => {
        if (initial) {
          const routes = Array.isArray(initial.routes) && initial.routes.length
            ? initial.routes.map((r) => ({ provider: r.provider || "", model: r.model || "", effort: r.effort || "" }))
            : [{ provider: "", model: "", effort: "" }];
          return {
            id: initial.id || "",
            name: initial.name || "",
            emoji: initial.emoji || "",
            triggers: triggersToText(initial.triggers),
            systemPrompt: initial.systemPrompt || "",
            routes,
            reusePolicy: initial.reusePolicy === "fresh" ? "fresh" : "reuse", // v1.5.0
            enabled: initial.enabled !== false,
          };
        }
        return { id: "", name: "", emoji: "", triggers: "", systemPrompt: "", routes: [{ provider: "", model: "", effort: "" }], reusePolicy: "reuse", enabled: true };
      });
      const [err, setErr] = React.useState("");
      const [probing, setProbing] = React.useState(false); // v1.11.12：ACP 模型目录探测中

      const set = (k, v) => setF(Object.assign({}, f, { [k]: v }));
      const setRoute = (i, k, v) => setF(Object.assign({}, f, { routes: f.routes.map((r, j) => (j === i ? Object.assign({}, r, { [k]: v }) : r)) }));
      const addRoute = () => setF(Object.assign({}, f, { routes: f.routes.concat([{ provider: "", model: "", effort: "" }]) }));
      const delRoute = (i) => setF(Object.assign({}, f, { routes: f.routes.filter((_, j) => j !== i) }));
      const moveRoute = (i, d) => {
        const j = i + d;
        if (j < 0 || j >= f.routes.length) return;
        const rs = f.routes.slice();
        const t = rs[i]; rs[i] = rs[j]; rs[j] = t;
        setF(Object.assign({}, f, { routes: rs }));
      };

      const strList = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : []);
      const modelOptions = models && typeof models === "object" ? models : {};
      const acpCatalog = productModels && typeof productModels === "object" ? productModels : {};
      const effortCatalog = llmEfforts && typeof llmEfforts === "object" ? llmEfforts : {};
      const llmProviders = Object.keys(modelOptions);
      const llmProviderSet = new Set(llmProviders);
      // ACP provider 全集：宿主 subagents.list() ∪ 缓存目录里出现过的（后者兜底旧宿主无 list）
      const acpProviders = Array.from(new Set([...strList(subagentProviders), ...Object.keys(acpCatalog)]));
      // 撞名以 LLM 优先（有真实模型目录的一侧胜出），下拉里据此区分标注
      const acpOnly = acpProviders.filter((p) => !llmProviderSet.has(p));
      const isAcpProvider = (prov) => !!prov && !llmProviderSet.has(prov) && acpProviders.indexOf(prov) >= 0;
      const acpSet = new Set(acpProviders);
      // 标签区分：只有出现在 product-subagents 目录里的才是"ACP 产品代理"；仅由宿主
      // subagents.list() 报出的还包含内置 claude-code / codex / acp（及启用时的 spawn / fork）。
      // 路由语义一致（dispatch 只看 getProvider），但标签不能一律说成"产品代理"。
      const acpProductSet = new Set(Object.keys(acpCatalog));
      const acpLabel = (p) => (acpProductSet.has(p) ? "（ACP 产品代理）" : "（subagent 代理，非模型 provider）");
      const providerChoices = llmProviders
        .map((p) => ({ value: p, label: acpSet.has(p) ? p + "（LLM；宿主同名 ACP 已按 LLM 处理）" : p }))
        .concat(acpOnly.map((p) => ({ value: p, label: p + acpLabel(p) })));
      // 该 provider 的模型候选（**不含**「默认」项——默认项由渲染处统一前置，见 fmtDefault）
      const optList = (v) => (Array.isArray(v) ? v.filter((o) => o && typeof o === "object" && typeof o.value === "string" && o.value !== "") : []);
      const labelMap = (opts) => {
        const m = new Map();
        for (const o of opts) if (!m.has(o.value)) m.set(o.value, o);
        return m;
      };
      // 显示名与落盘值分离：`<option value>` 恒为 ACP/适配器上报的 value（进 agents.json 的就是它），
      // 文本用 name ?? value，description 只作 title 提示。产品没上报 name 时显示 value，绝不拿显示名当值。
      const optName = (map, value) => { const o = map.get(value); return (o && o.name) || value };
      const optDesc = (map, value) => { const o = map.get(value); return o && o.description ? o.description : undefined };
      const acpEntry = (prov) => (prov && isAcpProvider(prov) ? acpCatalog[prov] || null : null);
      // v1.11.12 增量 3：「不指定」的三种形态（缺失 / 空串 / 'default'，大小写不敏感）。
      // 判据必须与 host 半 lib/agents.js 的 isUnspecifiedSetting 完全一致——browser 半是
      // classic script，没法 import 共享，所以这里留一份实现，**改一处必须同步改两处**。
      const isUnset = (v) => {
        if (typeof v !== "string") return v === undefined || v === null;
        const s = v.trim().toLowerCase();
        return s === "" || s === "default";
      };
      // 目录里出现字面 default（opencode 的 efforts 就有）时从清单摘掉：它与「默认」项同义，
      // 留着就违反"下拉里有且仅有一个默认项"。
      const realOnly = (list) => list.filter((v) => !isUnset(v));
      const pickStr = (v) => (typeof v === "string" && v.trim() ? v.trim() : "");
      // 「默认」项文本：产品/适配器自报了当前值就直接写出来（走 name 映射），否则说明由谁决定
      const fmtDefault = (value, labels, who) => {
        const v = pickStr(value);
        return "默认（" + (v ? optName(labels, v) : who) + "）";
      };
      const modelChoices = (prov) => {
        const entry = acpEntry(prov);
        return realOnly(entry ? strList(entry.models) : strList(modelOptions[prov]));
      };
      const modelLabelsFor = (prov) => {
        const entry = acpEntry(prov);
        return entry ? labelMap(optList(entry.modelOptions)) : new Map();
      };
      const modelDefaultText = (prov) => {
        const entry = acpEntry(prov);
        return fmtDefault(entry && entry.defaultModel, modelLabelsFor(prov), "由 ACP 决定");
      };
      const modelTextFor = (prov, mid) => {
        const map = modelLabelsFor(prov);
        const named = optName(map, mid);
        return named !== mid ? named : mid;
      };
      // 该行 model/effort 的"有效值"（决定下拉选中哪一项）：ACP 行的 'default' 与空串同义，
      // 一律映射成 ""（= 选中首位「默认」项，落盘也是空串 → 服务端不落键）。
      // LLM 行 model 必填，不做这层归一，免得把用户真填的值吞掉。
      const modelValueOf = (r) => {
        const m = pickStr(r.model);
        return isAcpProvider(r.provider) && isUnset(m) ? "" : m;
      };
      const effortValueOf = (r) => (isUnset(r.effort) ? "" : pickStr(r.effort));
      // 该行可选推理档位：ACP 取产品目录（模型级优先），LLM 取适配器真实档位；两边都没有 → 手输
      const effortsFor = (prov, mid) => {
        const entry = acpEntry(prov);
        if (entry) {
          const byModel = mid ? strList(entry.modelEfforts && entry.modelEfforts[mid]) : [];
          const byModelOpts = mid ? optList(entry.modelEffortOptions && entry.modelEffortOptions[mid]) : [];
          return {
            list: realOnly(byModel.length ? byModel : strList(entry.efforts)),
            labels: labelMap(byModelOpts.length ? byModelOpts : optList(entry.effortOptions)),
            defaultEffort: pickStr(entry.defaultEffort),
            acp: true,
          };
        }
        const info = effortCatalog[prov] && mid ? effortCatalog[prov][mid] : null;
        return {
          list: realOnly(info ? strList(info.efforts) : []),
          labels: new Map(),
          defaultEffort: info ? pickStr(info.defaultEffort) : "",
          acp: false,
        };
      };
      const effortDefaultText = (effort) =>
        fmtDefault(effort.defaultEffort, effort.labels, effort.acp ? "由 ACP 决定" : "由模型决定");
      // v1.11.12 核心修复：受控 select 的存值若不在候选里，浏览器 selectedIndex=-1 → 显示空白。
      // 把存值作为额外一项注入并保证选中，标签注明"不在表中"——
      // 一处同时治好 ACP 行（目录缺失）与 deepseek-v4-flash 这类已过时的 LLM 行。
      const choicesWithStored = (values, stored) => {
        const list = values.slice();
        const stale = !!stored && list.indexOf(stored) < 0;
        if (stale) list.unshift(stored);
        return { list, stale };
      };
      // 逐行降级判定（旧实现是全局一个开关，ACP 行连手输兜底都走不到）
      // ACP 目录"可信"= 条目存在、无 error、且 models 非空。服务端会保留探测失败的空条目
      // （{models:[],efforts:[],error}），只看条目存在会把「探测失败」误判成「目录已知但没模型」，
      // 于是渲染出一个只有空占位的 select —— 用户再也没有填 model 的途径。
      const acpCatalogTrusted = (prov) => {
        const entry = prov ? acpCatalog[prov] : null;
        return !!entry && !entry.error && strList(entry.models).length > 0;
      };
      const providerFallback = (prov) => providerChoices.length === 0 || (!!prov && providerChoices.every((o) => o.value !== prov));
      const modelFallback = (prov) => {
        if (isAcpProvider(prov)) return !acpCatalogTrusted(prov); // ACP 未探测/探测失败/目录为空 → 手输
        if (!prov) return llmProviders.length === 0;              // 未选 provider：整体无目录才手输
        return modelChoices(prov).length === 0;                 // LLM 该 provider 无目录 → 手输
      };
      // 切 provider 时只在"新 provider 有可信目录且不含当前 model"时清空；目录未知则保留，别丢用户数据
      const onProviderChange = (i, prov) => {
        setF(Object.assign({}, f, {
          routes: f.routes.map((r, j) => {
            if (j !== i) return r;
            const cur = isAcpProvider(prov) && isUnset(r.model) ? "" : pickStr(r.model);
            const choices = modelChoices(prov);
            // ACP 行目录不可信时不清（拿不到完整清单就别删用户填的值）；LLM 行按原规则
            const trustworthy = isAcpProvider(prov) ? acpCatalogTrusted(prov) : true;
            const keep = !cur || choices.length === 0 || !trustworthy || choices.indexOf(cur) >= 0;
            return Object.assign({}, r, { provider: prov, model: keep ? cur : "" });
          }),
        }));
      };
      // 请求 product-subagents 探测 ACP 模型目录（发完即返回，探测在对方插件里异步跑）
      const probeModels = () => {
        if (!onProbeModels || probing) return;
        setProbing(true);
        Promise.resolve()
          .then(() => onProbeModels())
          .catch(() => {})
          .then(() => setProbing(false));
      };
      // 表单里出现、但 ACP 目录不可信（未探测 / 探测失败 / 探到空目录）的 provider
      const unprobed = Array.from(new Set(f.routes.map((r) => r.provider).filter((p) => isAcpProvider(p) && !acpCatalogTrusted(p))));

      // 校验并组装 agent 对象，交给上层保存（失败保留表单）
      const save = () => {
        const id = f.id.trim();
        const name = f.name.trim();
        if (!id) { setErr("id 不能为空"); return; }
        if (!name) { setErr("名称不能为空"); return; }
        // 提交前统一「不指定」形态：ACP 行 model 的 'default'/空串 → ""；两边 effort 同理。
        // 服务端 lib/agents.js 的归一化是第二道，这里先收敛是为了校验判的是同一个值。
        const routes = f.routes
          .map((r) => ({ provider: (r.provider || "").trim(), model: modelValueOf(r), effort: effortValueOf(r) }))
          .filter((r) => r.provider || r.model || r.effort);
        if (!routes.length) { /* 无路由 = 跟随默认模型，合法 */ }
        for (const r of routes) {
          if (!r.provider) { setErr("路由缺少 provider"); return; }
          // v1.11.12：model 只对 LLM 路由强制；ACP 路由留空 = 用产品默认模型（与服务端 lib/agents.js 同规则）
          if (!r.model && !isAcpProvider(r.provider)) { setErr("模型路由「" + r.provider + "」必须选择 model（ACP 产品路由可选「默认」项用产品自己的模型）"); return; }
        }
        const triggers = triggersToText(f.triggers); // 注册表统一存分号分隔字符串（与 host 半 defaults 一致）
        onSave({
          id,
          name,
          emoji: f.emoji.trim(),
          triggers,
          systemPrompt: f.systemPrompt,
          routes,
          reusePolicy: f.reusePolicy, // v1.5.0
          enabled: f.enabled,
        });
      };

      const routeRows = f.routes.map((r, i) => {
        const provFb = providerFallback(r.provider);
        const acpRow = isAcpProvider(r.provider);
        const modelHand = modelFallback(r.provider);            // 目录不可信/无目录 → 额外给手输口
        const mv = modelValueOf(r);
        const ev = effortValueOf(r);
        const modelChoicesOfRow = choicesWithStored(modelChoices(r.provider), mv);
        const modelLabels = modelLabelsFor(r.provider);
        const effort = effortsFor(r.provider, mv);
        const effortHand = effort.list.length === 0;            // 该产品/模型无档位目录 → 额外给手输口
        const effortChoices = choicesWithStored(effort.list, ev);
        return React.createElement("div", { key: i, className: "ad-route" },
          // provider：LLM ∪ ACP 全集下拉；未知 provider（如已注销的产品代理）退化为手输 + datalist
          provFb
            ? React.createElement("input", {
                className: "ad-input", list: "ad-provider-list", placeholder: "provider",
                title: r.provider ? "未知 provider（不在任何目录中），可手输" : "provider",
                value: r.provider, onChange: (e) => setRoute(i, "provider", e.target.value),
              })
            : React.createElement("select", { className: "ad-input ad-select", value: r.provider, onChange: (e) => onProviderChange(i, e.target.value) },
                React.createElement("option", { value: "" }, "provider…"),
                providerChoices.map((o) => React.createElement("option", { key: o.value, value: o.value }, o.label)),
              ),
          // model：下拉**首位恒为一个「默认」项**（ACP 行；LLM 行 model 必填，首位仍是占位提示）。
          // 「默认」项的 value = 空串 = 落盘不指定 = ACP 用自身默认值；存值 'default'/空/缺失都回显成它。
          // 目录不可信时在其后再挂一个手输框，两者绑同一个值——手输的值会以"不在表中"那一项
          // 出现在下拉里，所以任何状态都不会出现空白 select（终审 M1 + 增量 3 A.1）。
          React.createElement("select", {
            className: "ad-input ad-select", value: mv,
            title: modelChoicesOfRow.stale ? "已存的 model 不在当前目录中：仍按此值落盘，但产品/适配器侧可能不生效" : undefined,
            onChange: (e) => setRoute(i, "model", e.target.value),
          },
            React.createElement("option", { value: "" }, acpRow ? modelDefaultText(r.provider) : "model…"),
            // value = 落盘值（ACP 的 value），文本 = 显示名（name ?? value）
            modelChoicesOfRow.list.map((mid) => React.createElement("option", {
              key: mid, value: mid, title: optDesc(modelLabels, mid),
            }, modelTextFor(r.provider, mid) + (modelChoicesOfRow.stale && mid === mv ? "（不在模型表中，可能不生效）" : ""))),
          ),
          modelHand && React.createElement("input", {
            className: "ad-input", list: "ad-model-list-" + i,
            placeholder: acpRow ? "手输 model（留空=默认）" : "model",
            title: acpRow ? "该产品模型目录尚未探测（或探测失败）：上方选「默认」即由产品决定，也可手输模型 id 或点「刷新 ACP 模型目录」" : "该 provider 无模型目录，可手输",
            value: mv, onChange: (e) => setRoute(i, "model", e.target.value),
          }),
          // effort：同 model，首位恒为「默认」项；ACP 取产品目录档位（模型级优先），LLM 取适配器真实档位
          React.createElement("select", {
            className: "ad-input effort ad-select", value: ev,
            title: "推理力度：选「默认」= 不指定，由" + (effort.acp ? "产品" : "模型") + "自己决定",
            onChange: (e) => setRoute(i, "effort", e.target.value),
          },
            React.createElement("option", { value: "" }, effortDefaultText(effort)),
            effortChoices.list.map((lv) => React.createElement("option", {
              key: lv, value: lv, title: optDesc(effort.labels, lv),
            }, optName(effort.labels, lv) + (effortChoices.stale && lv === ev ? "（不在档位表中，可能不生效）" : ""))),
          ),
          effortHand && React.createElement("input", {
            className: "ad-input effort", list: "ad-effort-list-" + i, placeholder: "手输 effort（留空=默认）",
            title: "该" + (acpRow ? "产品" : "模型") + "未上报可选档位，可手输；留空 = 用默认档位",
            value: ev, onChange: (e) => setRoute(i, "effort", e.target.value),
          }),
          // datalist 只服务手输框（下拉不需要）——候选文本给显示名，插入的仍是 value
          modelHand && React.createElement("datalist", { id: "ad-model-list-" + i }, modelChoicesOfRow.list.map((mid) => {
            const text = modelTextFor(r.provider, mid);
            return React.createElement("option", { key: mid, value: mid, title: optDesc(modelLabels, mid) }, text === mid ? undefined : text);
          })),
          effortHand && React.createElement("datalist", { id: "ad-effort-list-" + i }, effortChoices.list.map((lv) => {
            const text = optName(effort.labels, lv);
            return React.createElement("option", { key: lv, value: lv, title: optDesc(effort.labels, lv) }, text === lv ? undefined : text);
          })),
          // v0.9.8：↑↓ 挪到行尾、✕ 殿后（不再挤在输入框前）
          React.createElement("button", { className: "ad-btn mini", title: "上移", disabled: i === 0, onClick: () => moveRoute(i, -1) }, "↑"),
          React.createElement("button", { className: "ad-btn mini", title: "下移", disabled: i === f.routes.length - 1, onClick: () => moveRoute(i, 1) }, "↓"),
          React.createElement("button", { className: "ad-btn mini danger", title: "删除该路由", onClick: () => delRoute(i) }, "✕"),
        );
      });

      return React.createElement("div", { className: "ad-form" },
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "ID（唯一标识，建议 kebab-case，创建后不可修改）"),
          React.createElement("input", { className: "ad-input", value: f.id, disabled: !isNew, placeholder: "例如 sql-analyst", onChange: (e) => set("id", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "名称"),
          React.createElement("input", { className: "ad-input", value: f.name, placeholder: "例如 SQL 分析 Agent", onChange: (e) => set("name", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "Emoji 图标（可选）"),
          React.createElement("input", { className: "ad-input", value: f.emoji, placeholder: "例如 🗄️", onChange: (e) => set("emoji", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "触发域（逗号/顿号分隔，命中任务描述时自动委派）"),
          React.createElement("input", { className: "ad-input", value: f.triggers, placeholder: "例如 SQL, 数据库, 慢查询", onChange: (e) => set("triggers", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "系统提示词（persona，描述 Agent 职责与方法）"),
          // v0.9.6：提示词区加大（14 行 + 最小高度，可拉伸）
          React.createElement("textarea", { className: "ad-textarea tall", rows: 14, value: f.systemPrompt, placeholder: "你是……", onChange: (e) => set("systemPrompt", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" },
            "模型路由（按顺序尝试，失败互备）",
            defaultModel && defaultModel.model
              ? "　·　不选 = 跟随默认（" + defaultModel.provider + "/" + defaultModel.model + "）"
              : "　·　不选 = 跟随默认模型",
          ),
          React.createElement("div", { className: "ad-routes" }, routeRows),
          // 手输 provider 时的候选提示（不限制取值）
          React.createElement("datalist", { id: "ad-provider-list" }, providerChoices.map((o) => React.createElement("option", { key: o.value, value: o.value }))),
          React.createElement("div", { className: "ad-actions", style: { justifyContent: "flex-start" } },
            React.createElement("button", { className: "ad-btn mini", onClick: addRoute }, "+ 添加路由"),
            onProbeModels
              ? React.createElement("button", {
                  className: "ad-btn mini", onClick: probeModels, disabled: probing,
                  title: "请求 product-subagents 重新探测 ACP 产品的模型/档位目录（后台执行，数秒后自动刷新）",
                }, probing ? "探测中…" : "刷新 ACP 模型目录")
              : null,
          ),
          // ACP 行目录不可用时给出可操作的提示（否则用户只看到一个空下拉）
          unprobed.length
            ? React.createElement("div", { className: "ad-sub" }, "「" + unprobed.join("、") + "」的模型目录不可用（尚未探测或探测失败）：" + (onProbeModels ? "点「刷新 ACP 模型目录」，或直接手输模型 id。" : "可直接手输模型 id。"))
            : null,
        ),
        // v1.5.0：同角色子代理复用策略；v1.5.1：reuse = 智能复用（延续任务复用、独立任务新开）
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "子代理复用策略"),
          React.createElement("select", {
            className: "ad-input ad-select",
            value: f.reusePolicy || "reuse",
            onChange: (e) => set("reusePolicy", e.target.value),
          },
            React.createElement("option", { value: "reuse" }, "复用同角色（智能：延续上一任务时复用同一子代理，独立新任务自动新开；空闲 10 分钟自动回收驻留，下次冷恢复续聊）"),
            React.createElement("option", { value: "fresh" }, "每次新开（适合探索型：每次任务独立子代理，不继承旧上下文）"),
          ),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "启用状态"),
          React.createElement("div", null,
            React.createElement("button", {
              className: "ad-switch" + (f.enabled ? " on" : ""),
              role: "switch",
              "aria-checked": f.enabled,
              onClick: () => set("enabled", !f.enabled),
            }, React.createElement("span", { className: "knob" })),
          ),
        ),
        err ? React.createElement("div", { className: "ad-err" }, err) : null,
        React.createElement("div", { className: "ad-actions" },
          // v0.9.7：删除入口移进编辑弹窗（新建态不显示）
          onDelete && !isNew ? React.createElement("button", { className: "ad-btn danger", onClick: onDelete }, "删除") : null,
          React.createElement("button", { className: "ad-btn", onClick: onCancel }, "取消"),
          React.createElement("button", { className: "ad-btn primary", onClick: save }, "保存"),
        ),
      );
    }

    // ── 组队编辑表单（新建 / 编辑共用；initial 为 null 表示新建；onDelete 非空时表单尾显示删除按钮）──
    // agents: [{ id, name }]（调度页 data.agents 提供；空数组时 agentId 退化为手动输入）
    // onSave 约定返回 Promise：服务端校验失败时在表单内显示错误条（失败保留表单）。
    function SquadForm({ initial, isNew, agents, onSave, onCancel, onDelete }) {
      const agentList = Array.isArray(agents) ? agents.filter((e) => e && e.id) : [];

      const [f, setF] = React.useState(() => {
        const blankStep = { agentId: "", phase: "", dependsOn: [], instruction: "", checkpoint: false };
        if (initial) {
          const steps = Array.isArray(initial.steps) && initial.steps.length
            ? initial.steps.map((s) => ({
                agentId: s.agentId || "",
                phase: s.phase || "",
                dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn.filter((d) => typeof d === "number") : [],
                instruction: s.instruction || "",
                checkpoint: !!s.checkpoint, // v1.3.0：结果级停等开关
              }))
            : [Object.assign({}, blankStep)];
          return {
            id: initial.id || "",
            name: initial.name || "",
            emoji: initial.emoji || "",
            description: initial.description || "",
            steps,
          };
        }
        return { id: "", name: "", emoji: "", description: "", steps: [Object.assign({}, blankStep)] };
      });
      const [err, setErr] = React.useState("");

      const set = (k, v) => setF(Object.assign({}, f, { [k]: v }));
      const setStep = (i, k, v) => setF(Object.assign({}, f, { steps: f.steps.map((s, j) => (j === i ? Object.assign({}, s, { [k]: v }) : s)) }));
      const addStep = () => setF(Object.assign({}, f, { steps: f.steps.concat([{ agentId: "", phase: "", dependsOn: [], instruction: "", checkpoint: false }]) }));

      // 删除步骤后同步重映射依赖下标：引用被删步骤（==i）的依赖剔除，>i 的下标减一
      const delStep = (i) => {
        const steps = f.steps
          .filter((_, j) => j !== i)
          .map((s) => Object.assign({}, s, {
            dependsOn: (s.dependsOn || []).filter((d) => d !== i).map((d) => (d > i ? d - 1 : d)),
          }));
        setF(Object.assign({}, f, { steps }));
      };

      // 上下移动：交换两个步骤并同步重映射全部依赖下标（i↔j 互换，依赖关系保持不变）
      const moveStep = (i, d) => {
        const j = i + d;
        if (j < 0 || j >= f.steps.length) return;
        const steps = f.steps.slice();
        const t = steps[i]; steps[i] = steps[j]; steps[j] = t;
        const remap = (x) => (x === i ? j : x === j ? i : x);
        setF(Object.assign({}, f, {
          steps: steps.map((s) => Object.assign({}, s, { dependsOn: (s.dependsOn || []).map(remap) })),
        }));
      };

      // 勾选/取消步骤 i 对步骤 d 的依赖（不允许依赖自身，checkbox 列表已排除自身）
      const toggleDep = (i, d) => {
        const deps = f.steps[i].dependsOn || [];
        setStep(i, "dependsOn", deps.includes(d) ? deps.filter((x) => x !== d) : deps.concat([d]));
      };

      // agentId 下拉选项：Agent 列表 name（id）；当前值不在列表（Agent 已删/内置组队引用未注册 Agent）时追加提示项防 select 空白
      const agentOptions = (cur) => {
        const opts = [React.createElement("option", { key: "__empty__", value: "" }, "选择 Agent…")];
        for (const ex of agentList) {
          opts.push(React.createElement("option", { key: ex.id, value: ex.id }, (ex.name || ex.id) + "（" + ex.id + "）"));
        }
        if (cur && !agentList.some((ex) => ex.id === cur)) {
          opts.push(React.createElement("option", { key: "__missing__", value: cur }, cur + "（未注册）"));
        }
        return opts;
      };

      // 客户端先做一层与服务端同规则的校验，再交给上层保存（服务端校验失败的错误也回显在表单内）
      const save = () => {
        const id = f.id.trim();
        const name = f.name.trim();
        if (!id) { setErr("id 不能为空"); return; }
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) { setErr("id 必须为 kebab-case（小写字母/数字/连字符，如 debug-squad）"); return; }
        if (!name) { setErr("名称不能为空"); return; }
        if (!f.steps.length) { setErr("至少需要一个步骤（点「+ 添加步骤」）"); return; }
        for (let i = 0; i < f.steps.length; i++) {
          const st = f.steps[i];
          if (!st.agentId.trim()) { setErr("步骤 " + (i + 1) + " 缺 agentId"); return; }
          if (!st.phase.trim()) { setErr("步骤 " + (i + 1) + " 缺阶段名（phase）"); return; }
          if (!st.instruction.trim()) { setErr("步骤 " + (i + 1) + " 缺 instruction 任务模板"); return; }
          for (const d of st.dependsOn || []) {
            if (d < 0 || d >= f.steps.length) { setErr("步骤 " + (i + 1) + " 的依赖下标越界"); return; }
            if (d === i) { setErr("步骤 " + (i + 1) + " 不能依赖自身"); return; }
          }
        }
        const steps = f.steps.map((st) => ({
          agentId: st.agentId.trim(),
          phase: st.phase.trim(),
          dependsOn: (st.dependsOn || []).slice(),
          instruction: st.instruction, // 任务模板保留原文（含换行），仅非空校验用 trim
          checkpoint: !!st.checkpoint, // v1.3.0：结果级停等开关
        }));
        try { topoLayers(steps); } catch (e) { setErr(msg(e)); return; } // 环检测
        const res = onSave({ id, name, emoji: f.emoji.trim(), description: f.description, steps });
        if (res && typeof res.catch === "function") res.catch((e) => setErr(msg(e)));
      };

      // v0.9.6：每步骤一张卡片——头行（徽标+阶段+Agent+↑↓✕）、任务模板独立 textarea、依赖勾选行
      const stepItems = f.steps.map((st, i) =>
        React.createElement("div", { key: i, className: "ad-step-item" },
          React.createElement("div", { className: "ad-step-row" },
            React.createElement("span", { className: "ad-step-no", title: "步骤序号" }, "S" + (i + 1)),
            React.createElement("input", { className: "ad-input phase", placeholder: "阶段名（如 日志）", value: st.phase, onChange: (e) => setStep(i, "phase", e.target.value) }),
            agentList.length
              ? React.createElement("select", { className: "ad-input ad-select agent", title: "该步骤委派给哪个 Agent", value: st.agentId, onChange: (e) => setStep(i, "agentId", e.target.value) },
                  agentOptions(st.agentId),
                )
              : React.createElement("input", { className: "ad-input agent", placeholder: "agentId（如 log-tracer）", value: st.agentId, onChange: (e) => setStep(i, "agentId", e.target.value) }),
            React.createElement("span", { className: "ad-step-acts" },
              React.createElement("button", { className: "ad-btn icon", title: "上移", disabled: i === 0, onClick: () => moveStep(i, -1) }, "↑"),
              React.createElement("button", { className: "ad-btn icon", title: "下移", disabled: i === f.steps.length - 1, onClick: () => moveStep(i, 1) }, "↓"),
              React.createElement("button", { className: "ad-btn icon danger", title: "删除该步骤", onClick: () => delStep(i) }, "✕"),
            ),
          ),
          React.createElement("textarea", {
            className: "ad-textarea",
            rows: 2,
            value: st.instruction,
            placeholder: "instruction 任务模板（{input}=用户目标，{prev:N}=第 N 步结果）",
            onChange: (e) => setStep(i, "instruction", e.target.value),
          }),
          React.createElement("div", { className: "ad-step-deps" },
            React.createElement("span", { className: "ad-label" }, "依赖："),
            f.steps.length > 1
              ? f.steps.map((other, j) =>
                  j === i ? null : React.createElement("label", { key: j, className: "ad-dep-check", title: "勾选后该步骤等待步骤 " + (j + 1) + " 完成" },
                    React.createElement("input", {
                      type: "checkbox",
                      checked: (st.dependsOn || []).includes(j),
                      onChange: () => toggleDep(i, j),
                    }),
                    React.createElement("span", null, "S" + (j + 1) + " " + (other.phase || other.agentId || "?")),
                  ),
                )
              : React.createElement("span", { className: "ad-label" }, "（只有一步，无需依赖）"),
          ),
          // v1.3.0：checkpoint 停等开关——该步产出后暂停等用户确认，不自动进下一步
          React.createElement("label", { className: "ad-dep-check ad-checkpoint", title: "勾选后该步骤执行完暂停，等用户确认再续跑（agent_squad 返回 paused:true）" },
            React.createElement("input", {
              type: "checkbox",
              checked: !!st.checkpoint,
              onChange: (e) => setStep(i, "checkpoint", e.target.checked),
            }),
            React.createElement("span", null, "产出后停等用户确认（checkpoint）"),
          ),
        )
      );

      return React.createElement("div", { className: "ad-form" },
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "ID（唯一标识，kebab-case，创建后不可修改）"),
          React.createElement("input", { className: "ad-input", value: f.id, disabled: !isNew, placeholder: "例如 debug-squad", onChange: (e) => set("id", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "名称"),
          React.createElement("input", { className: "ad-input", value: f.name, placeholder: "例如 排查小队", onChange: (e) => set("name", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "Emoji 图标（可选）"),
          React.createElement("input", { className: "ad-input", value: f.emoji, placeholder: "例如 🛠️", onChange: (e) => set("emoji", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "描述（一句话说明小队用途）"),
          React.createElement("input", { className: "ad-input", value: f.description, placeholder: "例如 三路并行排查（日志/数据/代码），汇总定位根因", onChange: (e) => set("description", e.target.value) }),
        ),
        React.createElement("div", { className: "ad-field" },
          React.createElement("span", { className: "ad-label" }, "步骤编排（层内并行、层间串行；instruction 支持 {input} 与 {prev:N} 占位符）"),
          React.createElement("div", { className: "ad-step-list" }, stepItems),
          React.createElement("div", { className: "ad-actions", style: { justifyContent: "flex-start" } },
            React.createElement("button", { className: "ad-btn mini", onClick: addStep }, "+ 添加步骤"),
          ),
          // v0.8.2：实时执行流拓扑图预览（改步骤/依赖即重绘）；v0.8.4：固定尺寸
          React.createElement("div", { className: "ad-flow-preview" },
            React.createElement("span", { className: "ad-label" }, "执行流预览"),
            React.createElement("div", { className: "ad-flow-preview-fixed" },
              React.createElement(SquadFlowGraph, { steps: f.steps || [], agents: agents }),
            ),
          ),
        ),
        err ? React.createElement("div", { className: "ad-err" }, err) : null,
        React.createElement("div", { className: "ad-actions" },
          // v0.9.7：删除入口移进编辑弹窗（新建态不显示）
          onDelete && !isNew ? React.createElement("button", { className: "ad-btn danger", onClick: onDelete }, "删除") : null,
          React.createElement("button", { className: "ad-btn", onClick: onCancel }, "取消"),
          React.createElement("button", { className: "ad-btn primary", onClick: save }, "保存"),
        ),
      );
    }

    // ── Agent 子 tab：Agent CRUD（persona / 触发域 / 模型路由 / effort），v0.8 卡片网格 ──
    function ManageTab() {
      const [data, setData] = React.useState(null);                  // GET /agent-api 结果
      const [editing, setEditing] = React.useState(null);            // null | { isNew: bool, agent: object|null }
      const [confirmDel, setConfirmDel] = React.useState(null);      // 待二次确认删除的 Agent
      const [err, setErr] = React.useState("");

      const refresh = () => {
        apiGet("/agent-api")
          .then(setData)
          .catch((e) => setErr(msg(e)));
      };
      React.useEffect(() => { refresh(); }, []);

      // v1.11.12：ACP 模型目录探测——请求立即返回（探测可能起子进程、冷启动数秒），
      // 对方插件写完后本插件缓存失效，故延迟重取 /agent-api 拿新目录。
      const probeTimers = React.useRef([]);
      const clearProbeTimers = () => {
        probeTimers.current.forEach((t) => clearTimeout(t));
        probeTimers.current = [];
      };
      React.useEffect(() => clearProbeTimers, []);
      const scheduleProbeRefresh = () => {
        clearProbeTimers(); // 连点时旧定时器不能被覆盖，否则漏 clear（多跑无谓 refresh）
        [1500, 5000].forEach((ms) => probeTimers.current.push(setTimeout(refresh, ms)));
      };
      const probeModels = () => {
        // 探测请求未被人处理时，服务端仍返回 HTTP 200（ok:true + accepted:false + error），
        // 只 catch 网络错误等于全链路静默：按钮闪一下"探测中…"，什么都不变。
        // 返回 promise，表单里的"探测中…"状态才真的覆盖这次请求（而非同步返回即熄灭）。
        return apiPost("/agent-api/probe-product-models", {})
          .then((d) => {
            if (d && d.accepted === false) {
              setErr(d.error || "ACP 模型目录探测请求未被接受（product-subagents 插件可能未加载）");
              return;
            }
            scheduleProbeRefresh();
          })
          .catch((e) => setErr(msg(e)));
      };

      const toggle = (ex) =>
        apiPost("/agent-api/toggle", { id: ex.id, enabled: !ex.enabled }).then(refresh).catch((e) => setErr(msg(e)));
      const upsert = (agent) =>
        apiPost("/agent-api/upsert", { agent })
          .then(() => { setEditing(null); refresh(); })
          .catch((e) => setErr(msg(e))); // 失败保留表单，仅显示全局错误条
      const doRemove = () => {
        const ex = confirmDel;
        setConfirmDel(null);
        apiPost("/agent-api/remove", { id: ex.id }).then(refresh).catch((e) => setErr(msg(e)));
      };

      const agents = data ? (data.agents || []) : [];
      // v0.9.5：卡片点整体即编辑；编辑/删除移到 hover 浮层图标按钮（视觉降噪）
      const cards = agents.map((ex) => {
        const routesText = (ex.routes || []).map(routeSummary).filter(Boolean).join(", ");
        const trigChips = triggersToList(ex.triggers).slice(0, 3).map((t, i) =>
          React.createElement("span", { key: i, className: "ad-chip trig", title: t }, t));
        return React.createElement("div", {
          key: ex.id,
          className: "ad-row editable",
          title: "点击编辑「" + (ex.name || ex.id) + "」",
          onClick: () => setEditing({ isNew: false, agent: ex }),
        },
          // v0.9.8：浮层编辑按钮删除（整卡点击即编辑，入口唯一），去内置标签
          React.createElement("div", { className: "ad-row-main" },
            React.createElement(Avatar, { name: ex.name || ex.id, emoji: ex.emoji }),
            React.createElement("span", { className: "ad-mid" },
              React.createElement("span", { className: "ad-name", title: ex.name || ex.id },
                ex.name || ex.id,
              ),
              React.createElement("span", { className: "ad-id", title: ex.id }, ex.id),
            ),
            // 开关：灰底白球，仅球位区分（左=停用，右=启用），两态外观一致
            React.createElement("button", {
              className: "ad-switch" + (ex.enabled ? " on" : ""),
              role: "switch",
              "aria-checked": ex.enabled,
              title: ex.enabled ? "点击停用" : "点击启用",
              onClick: (e) => { e.stopPropagation(); toggle(ex); },
            }, React.createElement("span", { className: "knob" })),
          ),
          React.createElement("div", { className: "ad-chip-row", title: triggersToText(ex.triggers) || "未设触发域" },
            trigChips.length ? trigChips : React.createElement("span", { className: "ad-chip dim" }, "未设触发"),
          ),
          React.createElement("div", { className: "ad-route", title: routesText || "跟随默认模型" },
            routesText || "跟随默认模型"),
          // v1.5.0：复用策略角标——fresh=每次新开（探索型），默认 reuse 不显示
          ex.reusePolicy === "fresh"
            ? React.createElement("span", { className: "ad-chip fresh", title: "每次委派独立新开子代理（探索型）" }, "每次新开")
            : null,
        );
      });

      // v0.9.5：删除二次确认弹窗
      const delAgent = confirmDel;

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
        React.createElement("div", { className: "ad-kicker-row" },
          React.createElement("span", { className: "ad-kicker" }, "Agents · " + (agents.length || "…")),
          React.createElement("button", { className: "ad-btn mini primary", onClick: () => setEditing({ isNew: true, agent: null }) }, "+ 新建 Agent"),
        ),
        err ? React.createElement("div", { className: "ad-err" }, err) : null,
        // v0.9.7：Agent 页说明句（机制=主模型按路由表自主委派，无输入触发符）
        React.createElement("div", { className: "ad-sub" },
          "配置专属 Agent（人设 + 触发域 + 模型路由）。主模型会按触发域把任务自动委派给合适的 Agent，也可直接说「让 XX 处理」。"),
        // v0.9.5：编辑表单包进弹窗（复用 ad-modal 体系）
        editing
          ? React.createElement("div", { className: "ad-modal-mask", onClick: () => setEditing(null) },
              React.createElement("div", { className: "ad-modal form", onClick: (e) => e.stopPropagation() },
                React.createElement("div", { className: "ad-modal-head" },
                  React.createElement("span", { className: "ad-modal-title" }, (editing.isNew ? "新建" : "编辑") + " Agent"),
                  React.createElement("button", { className: "ad-btn icon", onClick: () => setEditing(null) }, "✕"),
                ),
                React.createElement("div", { className: "ad-modal-body" },
                  React.createElement(AgentForm, {
                    key: editing.isNew ? "__new__" : (editing.agent && editing.agent.id) || "__edit__",
                    initial: editing.agent,
                    isNew: editing.isNew,
                    onSave: upsert,
                    onCancel: () => setEditing(null),
                    // v0.9.7：弹窗内删除 → 关表单 → 弹删除确认
                    onDelete: editing.isNew ? null : () => { const ex = editing.agent; setEditing(null); setConfirmDel(ex); },
                    models: data ? data.models : undefined,
                    // v1.11.12：ACP/provider 档位数据（缺失时表单自行降级为手输）
                    subagentProviders: data ? data.subagentProviders : undefined,
                    productModels: data ? data.productModels : undefined,
                    llmEfforts: data ? data.llmEfforts : undefined,
                    onProbeModels: probeModels,
                    defaultModel: data ? data.defaultModel : undefined,
                  }),
                ),
              ),
            )
          : null,
        // v0.9.5：删除确认弹窗
        delAgent
          ? React.createElement("div", { className: "ad-modal-mask", onClick: () => setConfirmDel(null) },
              React.createElement("div", { className: "ad-modal", style: { width: "380px" }, onClick: (e) => e.stopPropagation() },
                React.createElement("div", { className: "ad-modal-head" },
                  React.createElement("span", { className: "ad-modal-title" }, "删除 Agent"),
                ),
                React.createElement("div", { className: "ad-modal-body" },
                  React.createElement("div", { className: "ad-modal-desc" }, "确定删除「" + (delAgent.name || delAgent.id) + "」？"),
                ),
                React.createElement("div", { className: "ad-modal-foot" },
                  React.createElement("button", { className: "ad-btn", onClick: () => setConfirmDel(null) }, "取消"),
                  React.createElement("button", { className: "ad-btn danger", onClick: doRemove }, "删除"),
                ),
              ),
            )
          : null,
        cards.length
          ? React.createElement("div", { className: "ad-cards" }, cards)
          : React.createElement("div", { className: "ad-empty", style: { minHeight: "180px" } },
              React.createElement("span", { className: "ad-empty-text" }, data ? "暂无 Agent" : "加载中…"),
              data ? React.createElement("span", { className: "ad-empty-sub" }, "点击「+ 新建 Agent」创建一个可委派的 Agent") : null,
            ),
      );
    }

    // ── v0.7 帮助：运行时长文案（秒→可读）──
    function fmtDur(startedAt, now) {
      if (!startedAt) return "";
      const sec = Math.max(0, Math.floor(((now || Date.now()) - startedAt) / 1000));
      if (sec < 60) return sec + "s";
      if (sec < 3600) return Math.floor(sec / 60) + "m" + (sec % 60 ? (sec % 60) + "s" : "");
      return Math.floor(sec / 3600) + "h" + Math.floor((sec % 3600) / 60) + "m";
    }

    // ── v0.7.1 共享：运行中大卡（左绿边 + 头像 + 名称/childId + 任务 + 时长 + 可选中止按钮）──
    function RunCard({ a, now, onCancel, cancelling }) {
      // v0.7.1：点击卡片主体跳转子 agent 会话（宿主 sessions.open 支持 catalog 内子会话）
      const canOpen = openAgentSession && a.childId;
      // v1.11.14(M3 计数)：待授权数按**摊平后的请求数**算，与琥珀球行数一致
      //（旧实现只看 entry.permissionPending 这个"最早未决那条"，并发 2 条显示 1）
      const pendingN = permCountOf(a);
      return React.createElement("div", {
        className: "ad-run-card" + (canOpen ? " clickable" : ""),
        title: canOpen ? "点击打开该子 agent 会话" : undefined,
        onClick: canOpen ? () => openAgentSession(a.childId, a.parentSessionId) : undefined,
      },
        React.createElement("span", { className: a.emoji ? "ad-run-emoji" : "ad-run-emoji logo" }, a.emoji || React.createElement(DSHLogo)),
        React.createElement("span", { className: "ad-run-mid" },
          React.createElement("span", { className: "ad-run-name" },
            a.agentName || a.agentId || "?",
            React.createElement("span", { className: "cid", title: "childId: " + (a.childId || "") }, (a.childId || "").slice(0, 8)),
          ),
          React.createElement("span", { className: "ad-run-task", title: a.taskLabel || "" },
            a.taskLabel ? "任务：" + a.taskLabel : "（无任务摘要）"),
        ),
        pendingN > 0
          ? React.createElement("span", {
              className: "ad-pending-badge",
              title: "ACP 权限待授权（" + pendingN + " 条）：" + ((a.permissionPending && a.permissionPending.description) || "") + "\n请点击卡片打开该子代理会话界面，在弹窗中点击允许/拒绝",
            },
            "⏳ 待授权" + (pendingN > 1 ? " ×" + pendingN : "") + (a.startedAt ? " " + fmtDur(a.startedAt, now) : ""))
          : React.createElement("span", { className: "ad-run-badge" },
            React.createElement("span", { className: "ad-dot on" }),
            "运行中" + (a.startedAt ? " " + fmtDur(a.startedAt, now) : "")),
        onCancel
          ? React.createElement("button", {
              className: "ad-btn mini danger",
              disabled: cancelling === a.childId, // v0.9.40：按 childId 精确取消（同Agent多卡并发）
              title: "中止该子 agent（不删除，可继续追问）",
              onClick: (ev) => { ev.stopPropagation(); onCancel(a); },
            }, cancelling === a.childId ? "中止中…" : "中止")
          : null,
      );
    }

    // ── 总览子 tab（v0.8：删 Ranking 区块；运行中并入此处，原「活动」tab 取消）──
    // v0.9.36：设置页（SettingsTab）删除，其信息（默认模型/数据目录/触发方式）与
    // 悬浮球总开关一并迁入总览页顶部——「悬浮球设置」浮层（色调/呼吸/透明度/时长）仍由悬浮球 ⚙ 打开。
    function OverviewTab() {
      const [ov, setOv] = React.useState(null); // GET /agent-api/overview 结果
      const [act, setAct] = React.useState(null); // GET /agent-api/active 结果
      const [meta, setMeta] = React.useState(null); // v0.9.36：GET /agent-api（默认模型/数据目录）结果
      const [err, setErr] = React.useState("");
      const [now, setNow] = React.useState(Date.now()); // 运行时长每 10s 走字
      const [cancelling, setCancelling] = React.useState(null); // 正在中止的 agentId
      const [fabOn, setFabOn] = React.useState(isFabVisible()); // v0.9.36：悬浮球总开关

      const cancel = (a) => {
        // v0.9.40：按 childId 精确取消（同Agent多卡并发时，agentId 兜底会误伤）
        setCancelling(a.childId);
        apiPost("/agent-api/cancel", { childId: a.childId, agentId: a.agentId })
          .catch((e) => setErr(msg(e)))
          .finally(() => { setCancelling(null); apiGet("/agent-api/active").then(setAct).catch(() => {}); });
      };

      const refreshOv = () => apiGet("/agent-api/overview").then(setOv).catch((e) => setErr(msg(e)));
      const refreshAct = () => apiGet("/agent-api/active").then(setAct).catch(() => {});
      const refreshMeta = () => apiGet("/agent-api").then(setMeta).catch(() => {});
      React.useEffect(() => {
        refreshOv(); refreshAct(); refreshMeta();
        const ovTimer = setInterval(refreshOv, 30000); // 统计卡 30s
        const actTimer = setInterval(refreshAct, 10000); // 运行中 10s（承接原活动页刷新频率）
        const tick = setInterval(() => setNow(Date.now()), 10000);
        return () => { clearInterval(ovTimer); clearInterval(actTimer); clearInterval(tick); };
      }, []);

      const s = ov ? ov.stats : null;
      const active = act ? (act.active || []) : [];
      const rate = s && s.dispatchTotal > 0 ? Math.round((s.okCount / s.dispatchTotal) * 100) + "%" : "—";

      const runCards = active.map((a, i) =>
        React.createElement(RunCard, { key: a.childId || i, a: a, now: now, onCancel: cancel, cancelling: cancelling }),
      );

      // v0.9.36：悬浮球总开关切换——off 强制隐藏；on 恢复显示模式逻辑
      const toggleFab = () => {
        const v = !fabOn;
        setFabOn(v);
        setFabVisible(v);
      };

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
        err ? React.createElement("div", { className: "ad-err" }, err) : null,
        // v0.9.36：顶部设置区（原设置页内容迁入）——显示悬浮球总开关 + 默认模型 / 数据目录 / 触发方式
        React.createElement("div", { className: "ad-set-card" },
          React.createElement("div", { className: "ad-set-row" },
            React.createElement("span", { className: "grow" },
              React.createElement("div", { className: "t1" }, "显示悬浮球"),
              React.createElement("div", { className: "t2" }, "关闭后悬浮球隐藏，运行/完成提醒不再弹出")),
            React.createElement("button", {
              className: "ad-switch" + (fabOn ? " on" : ""),
              role: "switch",
              "aria-checked": String(fabOn),
              onClick: toggleFab,
            }, React.createElement("span", { className: "knob" })),
          ),
          meta && meta.defaultModel
            ? React.createElement("div", { className: "ad-set-row" },
                React.createElement("span", { className: "grow" },
                  React.createElement("div", { className: "t1" }, "默认跟随模型"),
                  React.createElement("div", { className: "t2" },
                    meta.defaultModel.provider + " / " + meta.defaultModel.model + "（Agent 未配置路由时使用）")))
            : null,
          meta && meta.dataDir
            ? React.createElement("div", { className: "ad-set-row" },
                React.createElement("span", { className: "grow" },
                  React.createElement("div", { className: "t1" }, "数据目录"),
                  React.createElement("div", { className: "t2" }, meta.dataDir)))
            : null,
          React.createElement("div", { className: "ad-set-row" },
            React.createElement("span", { className: "grow" },
              React.createElement("div", { className: "t1" }, "触发方式"),
              React.createElement("div", { className: "t2" },
                "对话自动路由；输入 / 唤起菜单选 Agent（插入 $id）或手打 $Agent名 直接指定；悬浮球选定 Agent 自动插入当前会话。"))),
        ),
        React.createElement("div", { className: "ad-kicker-row" },
          React.createElement("span", { className: "ad-kicker" }, "Overview · 调度概览"),
          React.createElement("span", { className: "meta" }, "统计 30s · 运行中 10s 刷新"),
        ),
        React.createElement("div", { className: "ad-stats" },
          React.createElement("div", { className: "ad-stat" },
            React.createElement("span", { className: "v" }, s ? String(s.agentTotal) : "…"),
            React.createElement("span", { className: "k" }, s ? "Agents · 启用 " + s.agentEnabled : "Agents")),
          React.createElement("div", { className: "ad-stat" },
            React.createElement("span", { className: "v" }, s ? String(s.squadTotal) : "…"),
            React.createElement("span", { className: "k" }, "小队")),
          React.createElement("div", { className: "ad-stat hl" },
            React.createElement("span", { className: "v" }, s ? String(s.last24h) : "…"),
            React.createElement("span", { className: "k" }, "近 24h 委派")),
          React.createElement("div", { className: "ad-stat" },
            React.createElement("span", { className: "v" }, rate),
            React.createElement("span", { className: "k" }, s ? "成功率 " + s.okCount + "/" + s.dispatchTotal : "成功率")),
        ),
        React.createElement("div", { className: "ad-kicker-row" },
          React.createElement("span", { className: "ad-kicker" }, "Running · 运行中（" + active.length + "）")),
        active.length
          ? runCards
          : React.createElement("div", { className: "ad-empty", style: { minHeight: "110px" } },
              React.createElement("span", { className: "ad-empty-text" }, act ? "当前没有运行中的 Agent" : "加载中…")),
      );
    }

    // ── 历史子 tab：Agent 历史 / 小队历史 分段列表（v0.9.17）──
    // 小队历史两层：行=一次运行（含执行进度状态），展开=执行流程图（节点状态着色）+ 步骤明细
    function HistoryTab() {
      const [list, setList] = React.useState(null); // GET /agent-api/dispatches 结果
      const [activeIds, setActiveIds] = React.useState(null); // 活跃 childId 集合（兜底判"假运行中"）
      const [sub, setSub] = bindPersistentState(() => uiState.histSub, (v) => { uiState.histSub = v; }); // v0.9.17：agent / squad；v0.9.29 持久化
      const [previewKey, setPreviewKey] = bindPersistentState(() => uiState.histKey, (v) => { uiState.histKey = v; }); // v0.9.17：展开键（"a:idx" / "r:runId"）；v0.9.29 持久化
      const [err, setErr] = React.useState("");

      const refresh = () => {
        apiGet("/agent-api/dispatches?limit=200")
          .then((d) => setList(d.dispatches || []))
          .catch((e) => setErr(msg(e)));
        apiGet("/agent-api/active")
          .then((d) => setActiveIds(new Set((d.active || []).map((a) => a.childId).filter(Boolean))))
          .catch(() => {});
      };
      React.useEffect(() => { refresh(); }, []);

      // 单行状态：与 v0.8.1 四态一致，输出 { cls, text }
      function rowState(d) {
        const stale = !d.ended && d.childId && activeIds && !activeIds.has(d.childId);
        if (d.orphan || stale) return { cls: "unk", text: "状态未知" };
        if (!d.ended) return { cls: "run", text: "运行中" };
        if (d.ok) return { cls: "done", text: "完成" };
        return { cls: "fail", text: d.stopReason === "aborted" ? "已中止" : "失败" };
      }
      const STATE_TEXT = { done: "完成", run: "运行中", fail: "失败", skip: "已跳过", wait: "等待中", unk: "未知" };

      // 统一行头：时间｜头像｜名称｜摘要｜状态｜操作（Agent 与小队两列表结构一致）
      function histHead(o) {
        return React.createElement("div", { className: "ad-hist-head", onClick: o.onClick, title: o.title || "点击展开查看详情" },
          React.createElement("span", { className: "ad-hist-time" }, o.time),
          o.avatar,
          React.createElement("span", { className: "ad-hist-name", title: o.nameTitle || "" }, o.name),
          React.createElement("span", { className: "ad-hist-task", title: o.summary || "" }, o.summary || "（无任务摘要）"),
          React.createElement("span", { className: "ad-hist-" + o.state.cls, title: o.state.title || "" }, o.state.text),
          o.actions,
        );
      }

      const rows = list || [];
      const dispRows = rows.filter((r) => r.kind !== "squad-run"); // result 行宿主已滤掉
      const agentRows = dispRows.filter((d) => !d.viaSquad);
      const squadDisps = dispRows.filter((d) => d.viaSquad);

      // ── Agent 历史行（与之前一致：行头 + 展开详情）──
      const agentLines = agentRows.map((d, i) => {
        const st = rowState(d);
        const delBtn = React.createElement("button", {
          className: "ad-btn mini danger",
          title: "删除这条委派记录（不可恢复）",
          onClick: () => {
            if (!window.confirm("删除这条委派记录？不可恢复。")) return;
            apiPost("/agent-api/history/remove", { ts: d.ts }).then(refresh).catch((e) => setErr(msg(e)));
          },
        }, "删除");
        const actions = React.createElement("span", { className: "ad-hist-actions", onClick: (e) => e.stopPropagation() },
          d.parentSessionId && openAgentSession
            ? React.createElement("button", { className: "ad-btn mini", title: "打开发起本次委派的主会话", onClick: () => openAgentSession(d.parentSessionId) }, "主会话")
            : null,
          d.childId && openAgentSession
            ? React.createElement("button", { className: "ad-btn mini", title: "打开该子 Agent 会话（若仍在目录内）", onClick: () => openAgentSession(d.childId) }, "子 Agent")
            : null,
          delBtn,
        );
        const key = "a:" + i;
        const preview = previewKey === key
          ? React.createElement("div", { className: "ad-hist-preview" },
              React.createElement("div", { className: "ad-hist-preview-row" },
                React.createElement("span", { className: "ad-meta-label" }, "Agent"),
                (d.emoji || "") + (d.agentName || d.agentId || "?") + " · " + (d.provider || "?") + "/" + (d.model || "?")),
              React.createElement("div", { className: "ad-hist-preview-row", style: { alignItems: "flex-start" } },
                React.createElement("span", { className: "ad-meta-label" }, "任务详情"),
                React.createElement("div", { className: "ad-hist-taskbox" }, d.taskText || d.taskLabel || "（无任务内容）")),
              d.error
                ? React.createElement("div", { className: "ad-hist-preview-row" },
                    React.createElement("span", { className: "ad-meta-label" }, "错误"),
                    React.createElement("span", { className: "ad-hist-err" }, d.error))
                : null,
            )
          : null;
        return React.createElement("div", { key, className: "ad-hist-line" + (previewKey === key ? " open" : "") },
          histHead({
            time: fmtTs(d.ts),
            avatar: React.createElement(Avatar, { name: d.agentName || d.agentId, emoji: d.emoji }),
            name: d.agentName || d.agentId || "?",
            nameTitle: (d.agentId || "") + " · " + (d.provider || "?") + "/" + (d.model || "?"),
            summary: d.taskLabel,
            state: { cls: st.cls, text: st.text },
            actions,
            onClick: () => setPreviewKey(previewKey === key ? null : key),
          }),
          preview,
        );
      });

      // ── 小队历史：按运行聚合 ──
      // 新记录：squad-run(start) 拓扑快照 + dispatch(squadRunId) 各步 + squad-run(end) 状态
      // 旧记录（无 runId）：按小队 + 10 分钟时间窗兜底分组，无拓扑图，只列步骤
      const runs = [];
      const byId = new Map();
      for (const r of rows) {
        if (r.kind !== "squad-run") continue;
        if (r.phase === "start") {
          const run = {
            id: r.squadRunId, ts: r.ts, squadId: r.squadId,
            name: r.squadName || r.squadId, emoji: r.squadEmoji || "",
            goal: r.goal || "", steps: r.steps || [], parentSessionId: r.parentSessionId || null,
            endStatus: null, disps: [], noTopo: false,
          };
          byId.set(run.id, run); runs.push(run);
        } else if (r.phase === "end" && byId.has(r.squadRunId)) {
          byId.get(r.squadRunId).endStatus = r.stepStatus || null;
        }
      }
      const orphanDisps = [];
      for (const d of squadDisps) {
        if (d.squadRunId && byId.has(d.squadRunId)) byId.get(d.squadRunId).disps.push(d);
        else orphanDisps.push(d);
      }
      // 旧记录兜底分组：同小队按时间升序，间隔 > 10 分钟切新组
      orphanDisps.sort((a, b) => new Date(a.ts) - new Date(b.ts));
      const buckets = new Map(); // squadId → runs[]
      for (const d of orphanDisps) {
        const arr = buckets.get(d.viaSquad) || [];
        const last = arr[arr.length - 1];
        if (!last || new Date(d.ts) - new Date(last.ts) > 10 * 60 * 1000) {
          arr.push({ id: "old-" + d.viaSquad + "-" + d.ts, ts: d.ts, squadId: d.viaSquad, name: d.squadName || d.viaSquad, emoji: "", goal: "", steps: [], parentSessionId: d.parentSessionId || null, endStatus: null, disps: [], noTopo: true });
        }
        arr[arr.length - 1].disps.push(d);
        buckets.set(d.viaSquad, arr);
      }
      for (const arr of buckets.values()) runs.push(...arr);
      runs.sort((a, b) => new Date(b.ts) - new Date(a.ts)); // 最新在前

      // 单步状态（v0.9.26 权威级联）：① dispatch 活体结局（最权威）→ ② 运行已结束时信 end 快照 → ③ 运行未结束的活体推断
      // 修复：旧逻辑只看 dispatch 行，result 配对丢失（重启等）即误判"未知"，end 行明明记了全部 done 也不认账
      function stepState(run, i) {
        const disp = run.disps.find((d) => d.stepIndex === i) || (run.noTopo ? run.disps[i] : null);
        const finished = !!run.endStatus; // end 行已到 = 整次运行已终止
        if (disp && disp.ended) return disp.ok ? "done" : "fail"; // ①
        if (finished) {                                            // ②
          const es = run.endStatus[i];
          if (es === "done") return "done";
          if (es === "failed") return "fail";
          if (es === "skipped") return "skip";
          return "unk"; // waiting/running = 被中断，真盲区
        }
        if (disp) {                                                // ③
          const stale = disp.childId && activeIds && !activeIds.has(disp.childId);
          if (disp.orphan || stale) return "unk";
          return "run";
        }
        return "wait";
      }
      function runState(run) {
        const n = run.noTopo ? run.disps.length : run.steps.length;
        let anyRun = false, anyFail = false, allSkipDone = n > 0;
        for (let i = 0; i < n; i++) {
          const s = stepState(run, i);
          if (s === "run") anyRun = true;
          if (s === "fail") anyFail = true;
          if (s === "wait" || s === "unk") allSkipDone = false;
        }
        if (anyRun) return { cls: "run", text: "运行中" };
        if (anyFail) return { cls: "fail", text: "有失败" };
        if (allSkipDone) return { cls: "done", text: "完成" };
        return { cls: "unk", text: "状态未知" };
      }

      const runLines = runs.map((run) => {
        const st = runState(run);
        const key = "r:" + run.id;
        const open = previewKey === key;
        const delRunBtn = React.createElement("button", {
          className: "ad-btn mini danger",
          title: "删除整次运行记录（含全部步骤，不可恢复）",
          onClick: () => {
            if (!window.confirm("删除整次小队运行记录？包含全部步骤，不可恢复。")) return;
            if (run.noTopo) {
              Promise.all(run.disps.map((d) => apiPost("/agent-api/history/remove", { ts: d.ts }).catch(() => null))).then(refresh);
            } else {
              apiPost("/agent-api/history/remove-run", { squadRunId: run.id }).then(refresh).catch((e) => setErr(msg(e)));
            }
          },
        }, "删除");
        const totalN = run.noTopo ? run.disps.length : run.steps.length;
        const doneN = (() => {
          let c = 0;
          for (let i = 0; i < totalN; i++) { const s = stepState(run, i); if (s === "done" || s === "skip") c++; }
          return c;
        })();
        const actions = React.createElement("span", { className: "ad-hist-actions", onClick: (e) => e.stopPropagation() },
          React.createElement("span", { className: "ad-hist-type squad", title: "步骤完成数 / 总数" }, doneN + "/" + totalN),
          run.parentSessionId && openAgentSession
            ? React.createElement("button", { className: "ad-btn mini", title: "打开发起本次运行的主会话", onClick: () => openAgentSession(run.parentSessionId) }, "主会话")
            : null,
          delRunBtn,
        );
        // 展开区：执行流程图（节点状态着色）+ 步骤明细
        const topoSteps = (run.steps || []).map((s) => ({ phase: s.phase, agentId: s.agentId, dependsOn: s.dependsOn || [] }));
        const statuses = (() => {
          const arr = [];
          for (let i = 0; i < (run.noTopo ? 0 : run.steps.length); i++) arr.push(stepState(run, i));
          return arr;
        })();
        const stepRows = (() => {
          const out = [];
          for (let i = 0; i < totalN; i++) {
            const s = stepState(run, i);
            const disp = run.noTopo ? run.disps[i] : run.disps.find((d) => d.stepIndex === i);
            const meta = run.noTopo ? {} : (run.steps[i] || {});
            const nm = (meta.phase || "") + (meta.agentId && meta.phase !== meta.agentId ? " · " + (disp && disp.agentName ? disp.agentName : meta.agentId) : "");
            out.push(React.createElement("div", { key: i, className: "ad-step-row" },
              React.createElement("span", { className: "no" }, "S" + (i + 1)),
              React.createElement("span", { className: "nm", title: nm }, nm || "？"),
              React.createElement("span", { className: "st " + s }, STATE_TEXT[s]),
              disp && disp.childId && openAgentSession
                ? React.createElement("button", { className: "ad-btn mini", title: "打开该步子 Agent 会话", onClick: (e) => { e.stopPropagation(); openAgentSession(disp.childId); } }, "子 Agent")
                : null,
            ));
          }
          return out;
        })();
        // v0.9.21：图例（执行流状态色说明）
        const legend = React.createElement("div", { className: "ad-legend" },
          React.createElement("span", { className: "lg" }, React.createElement("span", { className: "sw done" }), "完成"),
          React.createElement("span", { className: "lg" }, React.createElement("span", { className: "sw run" }), "当前执行"),
          React.createElement("span", { className: "lg" }, React.createElement("span", { className: "sw fail" }), "失败"),
          React.createElement("span", { className: "lg" }, React.createElement("span", { className: "sw skip" }), "等待 / 跳过"),
        );
        const preview = open
          ? React.createElement("div", { className: "ad-hist-preview" },
              run.noTopo
                ? React.createElement("div", { className: "ad-hist-preview-row" },
                    React.createElement("span", { className: "ad-meta-label" }, "说明"),
                    "旧记录无拓扑快照，仅列步骤明细")
                : React.createElement(React.Fragment, null,
                    legend,
                    React.createElement("div", { className: "ad-hist-preview-row", style: { alignItems: "flex-start" } },
                      React.createElement("span", { className: "ad-meta-label" }, "执行流"),
                      React.createElement("div", { style: { minWidth: 0, overflow: "auto" } },
                        React.createElement(SquadFlowGraph, { steps: topoSteps, statuses, onOpen: (i) => {
                          const disp = run.disps.find((d) => d.stepIndex === i);
                          if (disp && disp.childId && openAgentSession) openAgentSession(disp.childId);
                        } })))),
              run.goal
                ? React.createElement("div", { className: "ad-hist-preview-row", style: { alignItems: "flex-start" } },
                    React.createElement("span", { className: "ad-meta-label" }, "目标"),
                    React.createElement("div", { className: "ad-hist-taskbox", style: { height: "auto", maxHeight: "110px" } }, run.goal))
                : null,
              React.createElement("div", { className: "ad-hist-preview-row", style: { alignItems: "flex-start" } },
                React.createElement("span", { className: "ad-meta-label" }, "步骤"),
                React.createElement("div", { style: { minWidth: 0, flex: 1 } }, stepRows.length ? stepRows : "（无步骤）")),
            )
          : null;
        return React.createElement("div", { key, className: "ad-hist-line" + (open ? " open" : "") },
          histHead({
            time: fmtTs(run.ts),
            avatar: React.createElement(Avatar, { name: run.name, emoji: run.emoji }),
            name: run.name || "?",
            nameTitle: run.squadId || "",
            summary: run.goal || (run.disps[0] && run.disps[0].taskLabel) || "（无目标摘要）",
            state: st,
            actions,
            onClick: () => setPreviewKey(open ? null : key),
          }),
          preview,
        );
      });

      const seg = React.createElement("div", { className: "ad-seg" },
        React.createElement("button", { className: sub === "agent" ? "on" : "", onClick: () => { setSub("agent"); setPreviewKey(null); } }, "Agent 历史"),
        React.createElement("button", { className: sub === "squad" ? "on" : "", onClick: () => { setSub("squad"); setPreviewKey(null); } }, "小队历史"),
      );
      // v0.9.21：列头行（时间｜头像｜名称｜消息｜状态｜操作）——两列表同构
      const colhead = React.createElement("div", { className: "ad-hist-colhead" },
        React.createElement("span", { className: "c-time" }, "时间"),
        React.createElement("span", { className: "c-avatar" }, ""),
        React.createElement("span", { className: "c-name" }, sub === "agent" ? "Agent" : "小队"),
        React.createElement("span", { className: "c-task" }, "消息"),
        React.createElement("span", { className: "c-status" }, "状态"),
        React.createElement("span", { className: "c-actions" }, "操作"),
      );
      const lines = sub === "agent" ? agentLines : runLines;

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "12px" } },
        err ? React.createElement("div", { className: "ad-err" }, err) : null,
        seg,
        lines.length ? React.createElement(React.Fragment, null,
          colhead,
          React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } }, lines),
        ) : null,
        !lines.length ? React.createElement("div", { className: "ad-empty", style: { minHeight: "180px" } },
          React.createElement("span", { className: "ad-empty-text" }, list ? (sub === "agent" ? "暂无 Agent 委派记录" : "暂无小队运行记录") : "加载中…"),
          React.createElement("span", { className: "ad-empty-sub" }, sub === "agent"
            ? "这里记录每次单个 Agent 的委派：任务、模型路由与成败"
            : "每次执行小队后这里会出现一条运行记录，点开可看执行流图（节点状态着色）与各步骤进度。若重启 Desktop 后仍为空，请先跑一次小队"),
        ) : null,
      );
    }

    // ── v0.8.2/0.8.3：小队执行流 SVG 拓扑图（按依赖分层：层内并行、层间串行，箭头=依赖）──
    // 纯 React 元素组装，无外部依赖；配色全部走语义化 token（--ad-* 映射 dsw alias），适配亮/暗主题。
    // v0.8.3：精致化——渐变节点、层标注（并行/串行）、hover 高亮、large 大图模式、onOpen 点击回调。
    let adFlowMarkerSeq = 0;
    // v0.9.30：执行流节点标签按像素测量截断（canvas measureText，不渲染 DOM）——
    // 超宽逐字截断加「…」，原文挂 <title> 悬浮可见。SVG <text> 不会自动截断/换行，
    // 长阶段名（节点可用宽仅 ~60px）必然溢出，这是用户报的「文字超出节点框」。
    let flowMeasureCtx = null;
    function fitFlowLabel(text, maxWidthPx, font) {
      const s = String(text || "");
      if (!s) return "";
      try {
        if (!flowMeasureCtx) flowMeasureCtx = document.createElement("canvas").getContext("2d");
        flowMeasureCtx.font = font;
        if (flowMeasureCtx.measureText(s).width <= maxWidthPx) return s;
        let out = s;
        while (out.length > 1 && flowMeasureCtx.measureText(out + "…").width > maxWidthPx) out = out.slice(0, -1);
        return out + "…";
      } catch (e) { return s.length > 8 ? s.slice(0, 8) + "…" : s; }
    }
    // v0.9.30：跳转会话后强制切回对话页——
    // conversation.view 选中页按会话持久化（localStorage dsh.conversation.chat.<id>），
    // 跳到上次停在「Agent 调度」页的会话会停在那里而非对话页。
    // 宿主无 setView 服务 → 轮询会话头部 tablist，找首标签「对话/Chat」（chat 视图 order:0 恒第一），未选中则点击（走官方 setView）。
    function ensureChatView() {
      let tries = 0;
      const poll = () => {
        try {
          const lists = document.querySelectorAll('[role="tablist"]');
          for (const list of lists) {
            const first = list.querySelector('[role="tab"]');
            if (!first) continue;
            const label = (first.textContent || "").trim();
            if (label !== "对话" && label !== "Chat") continue; // 只认会话头部视图标签栏
            if (first.getAttribute("aria-selected") !== "true") first.click();
            return;
          }
        } catch (e) {}
        if (++tries < 10) setTimeout(poll, 60); // 最多 ~0.6s
      };
      setTimeout(poll, 60);
    }
    function SquadFlowGraph({ steps, agents, large, onOpen, statuses }) {
      let layers = [];
      try { layers = topoLayers(steps); } catch (e) { return React.createElement("div", { className: "ad-graph-empty" }, "执行流存在依赖环，无法绘制"); }
      if (!Array.isArray(steps) || !steps.length) return React.createElement("div", { className: "ad-graph-empty" }, "（暂无步骤）");
      // 大图模式尺寸放大（卡片小图 0.9x，弹窗大图 1.25x）
      const S = large ? 1.25 : 0.9;
      const BW = Math.round(108 * S), BH = Math.round(32 * S), GX = Math.round(128 * S), GY = Math.round(44 * S);
      const topPad = large ? 40 : 22; // 大图顶部留层标注区
      const pos = {};
      layers.forEach((col, li) => col.forEach((si, ri) => { pos[si] = { x: 12 + li * GX, y: topPad + ri * GY }; }));
      const W = 24 + layers.length * GX;
      const H = topPad + 12 + Math.max(...layers.map((c) => c.length)) * GY;
      const markerId = "ad-flow-arrow-" + (++adFlowMarkerSeq);
      const gradId = "ad-flow-grad-" + adFlowMarkerSeq;
      const agentOf = (id) => (Array.isArray(agents) ? agents.find((e) => e.id === id) : undefined);
      const els = [];
      // 层标注：同层=并行（｜），跨层=串行（→）
      if (large) {
        layers.forEach((col, li) => {
          const xs = Math.min(...col.map((si) => pos[si].x));
          const xe = Math.max(...col.map((si) => pos[si].x + BW));
          els.push(React.createElement("text", { key: "layer" + li, className: "flow-layer", x: (xs + xe) / 2, y: 20 },
            "L" + (li + 1) + " · " + (col.length > 1 ? "并行" : "串行")));
        });
      }
      // 箭头（先画，垫在节点下层；C 曲线避免交叉线遮挡节点）
      steps.forEach((st, i) => {
        (st.dependsOn || []).forEach((d) => {
          const a = pos[d], b = pos[i];
          if (!a || !b) return;
          els.push(React.createElement("path", {
            key: "a" + d + "-" + i,
            className: "flow-arrow",
            d: `M ${a.x + BW} ${a.y + BH / 2} C ${a.x + BW + 28 * S} ${a.y + BH / 2}, ${b.x - 28 * S} ${b.y + BH / 2}, ${b.x} ${b.y + BH / 2}`,
            markerEnd: "url(#" + markerId + ")",
          }));
        });
      });
      // 节点：序号 + 阶段名（v0.8.9：去掉 Agent emoji，节点更干净）
      // v0.9.17：statuses[i] 存在时节点按状态着色（st-done/run/fail/skip/unknown）
      steps.forEach((st, i) => {
        const p = pos[i] || { x: 12, y: topPad };
        const label = st.phase || st.agentId;
        const stepNum = "S" + (i + 1);
        const stCls = statuses && statuses[i] ? " st-" + statuses[i] : "";
        // v0.9.30：标签按像素测量截断——可用宽 = 节点宽 − 左起 30px（序号区）− 右留白 8px；
        // 字号随模式（小图 10.5px / 大图 12px，与 CSS 一致）。原文挂 <title>（SVG 原生悬浮提示）。
        const depTxt = (st.dependsOn && st.dependsOn.length)
          ? "依赖 " + st.dependsOn.map((d) => "S" + (d + 1)).join(",")
          : "";
        const labelMax = BW - 30 - 8;
        const fitLabel = fitFlowLabel(label, labelMax, (large ? "600 " + Math.round(12 * 10) / 10 : "600 10.5") + "px -apple-system, sans-serif");
        els.push(React.createElement("g", {
          key: "n" + i,
          className: "flow-node" + stCls + (onOpen ? " clickable" : ""),
          onClick: onOpen ? () => onOpen(i) : undefined,
        },
          React.createElement("rect", {
            className: "flow-rect",
            x: p.x, y: p.y, width: BW, height: BH, rx: 8,
            fill: "url(#" + gradId + ")",
          }),
          React.createElement("title", null, String(label)),
          React.createElement("rect", { className: "flow-rect-badge", x: p.x + 6, y: p.y + 6, width: 18, height: 18, rx: 5 }),
          React.createElement("text", { className: "flow-step", x: p.x + 15, y: p.y + 19, textAnchor: "middle" }, stepNum),
          React.createElement("text", { className: "flow-label", x: p.x + 30, y: p.y + 19 }, fitLabel),
          // 依赖徽标：等待的步骤下标
          depTxt
            ? React.createElement("text", { className: "flow-dep", x: p.x + BW - 6, y: p.y + BH - 5 }, depTxt)
            : null,
        ));
      });
      return React.createElement("svg", {
        className: "ad-flow-svg" + (large ? " large" : "") + (onOpen ? " clickable" : ""),
        viewBox: "0 0 " + W + " " + H,
        width: W, // v0.9.3：自然像素尺寸（容器内只缩不放，避免单节点被拉伸撑满）
        height: H,
        preserveAspectRatio: "xMidYMid meet",
      },
        React.createElement("defs", null,
          React.createElement("marker", { id: markerId, markerWidth: 9, markerHeight: 9, refX: 8, refY: 4.5, orient: "auto" },
            React.createElement("path", { className: "flow-marker", d: "M0,0 L9,4.5 L0,9 Z" })),
          React.createElement("linearGradient", { id: gradId, x1: "0", y1: "0", x2: "1", y2: "1" },
            React.createElement("stop", { offset: "0%", className: "flow-grad-a" }),
            React.createElement("stop", { offset: "100%", className: "flow-grad-b" })),
        ),
        ...els,
      );
    }

    // ── v0.8.3：小队执行流弹窗大图（modal：放大拓扑图 + 步骤说明列表）──
    function SquadFlowModal({ squad, agents, onClose }) {
      const steps = (squad && squad.steps) || [];
      const agentOf = (id) => (Array.isArray(agents) ? agents.find((e) => e.id === id) : undefined);
      const stepRows = steps.map((st, i) => {
        return React.createElement("div", { key: i, className: "ad-modal-step" },
          React.createElement("div", { className: "ad-modal-step-h" },
            React.createElement("span", { className: "ad-modal-step-no" }, "S" + (i + 1)),
            React.createElement("span", { className: "ad-modal-step-name" }, st.phase || st.agentId),
            (st.dependsOn && st.dependsOn.length)
              ? React.createElement("span", { className: "ad-modal-step-dep" }, "等 " + st.dependsOn.map((d) => "S" + (d + 1)).join("、"))
              : null,
          ),
          st.instruction
            ? React.createElement("div", { className: "ad-modal-step-inst" }, st.instruction)
            : null,
        );
      });
      return React.createElement("div", { className: "ad-modal-mask", onClick: onClose },
        React.createElement("div", { className: "ad-modal", onClick: (e) => e.stopPropagation() },
          React.createElement("div", { className: "ad-modal-head" },
            React.createElement("span", { className: "ad-modal-title" }, (squad.name || squad.id) + " · 执行流"),
            React.createElement("button", { className: "ad-btn mini", onClick: onClose }, "✕ 关闭"),
          ),
          React.createElement("div", { className: "ad-modal-body" },
            squad.description ? React.createElement("div", { className: "ad-modal-desc" }, squad.description) : null,
            // v0.9.3：固定 300px 图区，SVG 自然尺寸居中，超宽横向滚动
            React.createElement("div", { className: "ad-modal-graph" },
              React.createElement(SquadFlowGraph, { steps: steps, agents: agents, large: true }),
            ),
            React.createElement("div", { className: "ad-modal-steps" }, stepRows),
          ),
        ),
      );
    }

    // ── 小队子 tab：Agent 小队（协作模板）CRUD（阶段 + 依赖编排），v0.8 卡片网格 ──
    function SquadTab() {
      const [data, setData] = React.useState(null);                  // GET /agent-api（拿 agents 供下拉）
      const [squads, setSquads] = React.useState(null);              // GET /agent-api/squads 结果
      const [editingSquad, setEditingSquad] = React.useState(null);  // null | { isNew: bool, squad: object|null }
      const [confirmDelSquad, setConfirmDelSquad] = React.useState(null); // 待二次确认删除的小队
      const [viewSquad, setViewSquad] = React.useState(null);        // v0.8.3：点击执行流图弹窗查看的小队
      const [err, setErr] = React.useState("");

      const refresh = () => {
        apiGet("/agent-api")
          .then(setData)
          .catch((e) => setErr(msg(e)));
        apiGet("/agent-api/squads")
          .then((d) => setSquads(d.squads || []))
          .catch((e) => setErr(msg(e)));
      };
      React.useEffect(() => { refresh(); }, []);

      const upsertSquad = (squad) =>
        apiPost("/agent-api/squad/upsert", { squad })
          .then(() => { setEditingSquad(null); refresh(); });
      const doRemoveSquad = () => {
        const sq = confirmDelSquad;
        setConfirmDelSquad(null);
        apiPost("/agent-api/squad/remove", { id: sq.id }).then(refresh).catch((e) => setErr(msg(e)));
      };

      const agents = data ? (data.agents || []) : [];
      const toggleSquad = (sq) =>
        apiPost("/agent-api/squad/toggle", { id: sq.id, enabled: !sq.enabled }).then(refresh).catch((e) => setErr(msg(e)));
      // v0.9.5：卡片点整体即编辑；编辑/删除移到 hover 浮层图标按钮；流程图点击仍放大（阻止冒泡）
      const squadCards = (squads || []).map((sq) =>
        React.createElement("div", {
          key: sq.id,
          className: "ad-squad-card editable",
          title: "点击编辑「" + (sq.name || sq.id) + "」",
          onClick: () => setEditingSquad({ isNew: false, squad: sq }),
        },
          // v0.9.8：浮层编辑按钮删除（整卡点击即编辑，入口唯一），去内置标签
          React.createElement("div", { className: "ad-squad-card-main" },
            React.createElement("div", { className: "ad-row-main" },
              React.createElement(Avatar, { name: sq.name || sq.id, emoji: sq.emoji }),
              React.createElement("span", { className: "ad-mid" },
                React.createElement("span", { className: "ad-name", title: sq.name || sq.id },
                  sq.name || sq.id,
                ),
                React.createElement("span", { className: "ad-id", title: sq.id }, sq.id),
              ),
              // v0.8.2：小队开关（灰底白球，仅球位区分，两态一致）
              React.createElement("button", {
                className: "ad-switch" + (sq.enabled ? " on" : ""),
                role: "switch",
                "aria-checked": sq.enabled,
                title: sq.enabled ? "点击停用" : "点击启用",
                onClick: (e) => { e.stopPropagation(); toggleSquad(sq); },
              }, React.createElement("span", { className: "knob" })),
            ),
            sq.description
              ? React.createElement("div", { className: "ad-desc", title: sq.description }, sq.description)
              : null,
            // v0.9.3：卡片流程图缩略（固定 96px 高；点击放大弹窗，阻止冒泡避免误触编辑）
            React.createElement("div", { className: "ad-graph-box", title: "点击放大查看执行流", onClick: (e) => { e.stopPropagation(); setViewSquad(sq); } },
              React.createElement(SquadFlowGraph, { steps: sq.steps || [], agents: agents }),
            ),
            React.createElement("div", { className: "ad-graph-hint" },
              React.createElement("span", null, squadStepsText(sq.steps)),
              React.createElement("span", null, "点击图放大")),
          ),
        )
      );

      const delSquad = confirmDelSquad;

      return React.createElement("div", { style: { display: "flex", flexDirection: "column", gap: "14px" } },
        React.createElement("div", { className: "ad-kicker-row" },
          React.createElement("span", { className: "ad-kicker" }, "Squads · 小队（" + ((squads && squads.length) || "…") + "）"),
          React.createElement("button", { className: "ad-btn mini primary", onClick: () => setEditingSquad({ isNew: true, squad: null }) }, "+ 新建小队"),
        ),
        err ? React.createElement("div", { className: "ad-err" }, err) : null,
        // v0.9.7：删「小队 = …」说明句（用户不要）
        // v0.9.5：小队编辑弹窗（宽形，装步骤编排）
        editingSquad
          ? React.createElement("div", { className: "ad-modal-mask", onClick: () => setEditingSquad(null) },
              React.createElement("div", { className: "ad-modal form wide", onClick: (e) => e.stopPropagation() },
                React.createElement("div", { className: "ad-modal-head" },
                  React.createElement("span", { className: "ad-modal-title" }, (editingSquad.isNew ? "新建" : "编辑") + "小队"),
                  React.createElement("button", { className: "ad-btn icon", onClick: () => setEditingSquad(null) }, "✕"),
                ),
                React.createElement("div", { className: "ad-modal-body" },
                  React.createElement(SquadForm, {
                    key: editingSquad.isNew ? "__new__" : (editingSquad.squad && editingSquad.squad.id) || "__edit__",
                    initial: editingSquad.squad,
                    isNew: editingSquad.isNew,
                    agents: agents, // v0.8.2：完整列表（含 emoji），供执行流预览图使用
                    onSave: upsertSquad,
                    onCancel: () => setEditingSquad(null),
                    // v0.9.7：弹窗内删除 → 关表单 → 弹删除确认
                    onDelete: editingSquad.isNew ? null : () => { const sq = editingSquad.squad; setEditingSquad(null); setConfirmDelSquad(sq); },
                  }),
                ),
              ),
            )
          : null,
        // v0.9.5：小队删除确认弹窗
        delSquad
          ? React.createElement("div", { className: "ad-modal-mask", onClick: () => setConfirmDelSquad(null) },
              React.createElement("div", { className: "ad-modal", style: { width: "380px" }, onClick: (e) => e.stopPropagation() },
                React.createElement("div", { className: "ad-modal-head" },
                  React.createElement("span", { className: "ad-modal-title" }, "删除小队"),
                ),
                React.createElement("div", { className: "ad-modal-body" },
                  React.createElement("div", { className: "ad-modal-desc" },
                    "确定删除「" + (delSquad.name || delSquad.id) + "」？"),
                ),
                React.createElement("div", { className: "ad-modal-foot" },
                  React.createElement("button", { className: "ad-btn", onClick: () => setConfirmDelSquad(null) }, "取消"),
                  React.createElement("button", { className: "ad-btn danger", onClick: doRemoveSquad }, "删除"),
                ),
              ),
            )
          : null,
        squadCards.length
          ? React.createElement("div", { className: "ad-squad-list" }, squadCards)
          : React.createElement("div", { className: "ad-empty", style: { minHeight: "180px" } },
              React.createElement("span", { className: "ad-empty-text" }, squads ? "暂无小队" : "加载中…"),
              squads ? React.createElement("span", { className: "ad-empty-sub" }, "点击「+ 新建小队」创建一个多 Agent 协作模板") : null,
            ),
        viewSquad
          ? React.createElement(SquadFlowModal, { squad: viewSquad, agents: agents, onClose: () => setViewSquad(null) })
          : null,
      );
    }

    // ── AgentPanel：conversation.view 主面板（v0.8：总览/历史/Agent/小队 四子 tab）──
    // ── v0.9.29：面板状态跨会话持久化（返回后不重置）──
    // conversation.view 槽位组件按会话挂载：切走=卸载、切回=重挂载，
    // React useState 初始值重置 → 用户从历史页点返回发现停在总览。
    // 修法：tab/历史分段/展开行提升到模块级，重挂载立即恢复。
    const uiState = { tab: "overview", histSub: "agent", histKey: null };
    const uiSubs = new Set();
    function uiNotify() { for (const f of uiSubs) { try { f(); } catch (e) {} } }
    function bindPersistentState(getter, setter) {
      // useState(() => getter()) 惰性初始读取（重挂载时取模块级最新值）
      const [v, setV] = React.useState(() => getter());
      const set = React.useCallback((next) => { const nv = typeof next === "function" ? next(getter()) : next; setter(nv); setV(nv); uiNotify(); }, []);
      React.useEffect(() => { const fn = () => setV(getter()); uiSubs.add(fn); return () => uiSubs.delete(fn); }, []);
      return [v, set];
    }

    function AgentPanel() {
      const [tab, setTab] = bindPersistentState(() => uiState.tab, (v) => { uiState.tab = v; });
      const [act, setAct] = React.useState({ active: [] }); // 头部运行中计数（10 秒刷新）
      const tabs = [
        { id: "overview", label: "总览" },
        { id: "manage", label: "Agent" },
        { id: "squad", label: "小队" },
        { id: "history", label: "历史" },
      ];
      React.useEffect(() => {
        const refresh = () => apiGet("/agent-api/active").then((d) => setAct({ active: d.active || [] })).catch(() => {});
        refresh();
        const timer = setInterval(refresh, 10000);
        return () => clearInterval(timer);
      }, []);
      const running = act.active.length;
      // v1.11.14(M3 计数)：待授权按请求数计（同一子代理并发 2 条 = 2）
      const pendingN = act.active.reduce((n, a) => n + permCountOf(a), 0);
      return React.createElement("div", { className: "ad-panel" },
        React.createElement("div", { className: "ad-panel-head" },
          React.createElement("span", { className: "ad-logo" }, DSHLogo()),
          React.createElement("span", { className: "ad-panel-title" }, "Agent 调度"),
          React.createElement("span", { className: "ad-live-pill" },
            React.createElement("span", { className: "ad-dot " + (running > 0 ? "on" : "off") }),
            running > 0 ? running + " 运行中" : "空闲",
          ),
          // v1.8.0：待授权计数（ACP 权限审批挂起——弹窗在该子代理会话界面，点击运行卡跳转）
          pendingN > 0
            ? React.createElement("span", {
                className: "ad-live-pill pending",
                title: "有子代理正在等待 ACP 权限授权——请打开对应子代理会话点击允许/拒绝",
                style: { color: "#e8a33d", borderColor: "color-mix(in srgb,#e8a33d 40%,transparent)" },
              },
              "⏳ " + pendingN + " 待授权")
            : null,
        ),
        React.createElement("div", { className: "ad-subtabs" },
          tabs.map((t) =>
            React.createElement("button", {
              key: t.id,
              className: "ad-subtab" + (tab === t.id ? " on" : ""),
              onClick: () => setTab(t.id),
            }, t.label, t.id === "overview" && running > 0 ? React.createElement("span", { className: "n" }, String(running)) : null),
          ),
        ),
        React.createElement("div", { className: "ad-panel-body" },
          tab === "overview" ? React.createElement(OverviewTab, { key: "ov" }) : null,
          tab === "history" ? React.createElement(HistoryTab, { key: "hist" }) : null,
          tab === "manage" ? React.createElement(ManageTab, { key: "mg" }) : null,
          tab === "squad" ? React.createElement(SquadTab, { key: "sq" }) : null,
        ),
      );
    }

    // ── 悬浮活动按钮 v0.8.3（原生 DOM：随处可拖+动态特效+完成状态同步+弹窗跟随+显隐模式）──
    const FAB_POS_KEY = "ad-fab-pos";
    const FAB_MODE_KEY = "ad-fab-mode";
    // v0.9.36：悬浮球总开关（总览页开关控制；off 时强制隐藏，优先级高于显示模式）
    const FAB_VIS_KEY = "ad-fab-visible";
    // v0.8.8：色调/透明度/展示时长等设置（原 mountAgentFab 内声明，v1.6.0 上移与同组键集中）
    const FAB_SET_KEY = "ad-fab-settings";
    // ── v1.6.0：FAB 配置持久化——宿主 REST 通道（/agent-api/fab-config）为主，localStorage 为降级副本 ──
    // 根因：插件运行在 VS Code webview（fengze233.dsh-vscode-panel）的 iframe 里，每次重建窗口/面板
    // 都换 vscode-webview://<uuid> 顶层 origin，http-origin localStorage 被分区隔离整体丢失，
    // 「隐藏状态 + 位置 + 设置」随每次重开蒸发。宿主半把配置原子落盘到
    // $DSH_HOME/data/dsh-agent-dispatch/fab-config.json，client 经同源 REST 读写（与面板其他数据同通道）。
    // 读时序：宿主值 > localStorage > 默认；写时序：localStorage（降级副本）先落 + 宿主异步镜像。
    // 存量迁移：宿主无值而 localStorage 有的字段，装载后一次性上载宿主。
    // 降级：直连浏览器 / 宿主半旧版 / REST 失败 → console.warn 明示「已回退 localStorage」，
    // 单浏览器场景（origin 稳定）行为不回退。
    function lsGetFab(key) {
      try { return localStorage.getItem(key); } catch (e) {
        console.warn("[agent-dispatch] localStorage 读取失败（key=" + key + "）:", (e && e.message) || e);
        return null;
      }
    }
    function lsSetFab(key, val) {
      try { localStorage.setItem(key, val); } catch (e) {
        console.warn("[agent-dispatch] localStorage 写入失败（key=" + key + "，本次会话退化为内存态）:", (e && e.message) || e);
      }
    }
    // 宿主通道写入：fire-and-forget，失败只告警不抛（localStorage 副本已先行落好，单浏览器不回退）
    function fabHostSave(patch) {
      apiPost("/agent-api/fab-config", patch).catch((e) => {
        console.warn("[agent-dispatch] 悬浮球配置宿主持久化失败（已回退 localStorage）:", (e && e.message) || e);
      });
    }
    // v1.6.0：宿主配置首轮装载是否完成——装载期（mountAgentFab 内置 false）由 boot 流程独占
    // display，防隐藏态在宿主值恢复前闪现；setFabVisible / poll 在装载期不抢 display。
    let fabBootDone = true;
    // v1.6.0：装载期间用户已本地写入过的字段 → 宿主响应已过期，跳过该字段回放与上载。
    // 审查补强：pos / settings 与 visible 同语义守卫——超时揭示后迟到的宿主响应不覆盖窗口内的本地修改。
    let fabVisibleTouched = false;
    let fabPosTouched = false;
    let fabSettingsTouched = false;
    const fabUi = { visible: true };
    fabUi.visible = lsGetFab(FAB_VIS_KEY) !== "0";
    function isFabVisible() { return fabUi.visible; }
    function setFabVisible(v) {
      fabUi.visible = !!v;
      fabVisibleTouched = true;
      lsSetFab(FAB_VIS_KEY, v ? "1" : "0");
      fabHostSave({ visible: !!v });
      const fab = document.getElementById("ad-agent-fab");
      if (fab) {
        // v1.6.0：宿主配置装载完成前不抢 display（防隐藏态闪现），由 boot 流程统一揭示
        if (fabBootDone) {
          // v0.9.36：off 强制隐藏；on 恢复显示模式逻辑（当前默认 always=常驻）
          fab.style.display = (!v || getFabMode() === "never") ? "none" : "grid";
        }
      }
    }
    // v0.8.4：打开 Agent 调度面板的 DOM 兜底（apply 时赋值；未赋值时菜单项置灰）
    let openAgentPanel = null;
    // v0.8：悬浮球显示模式，默认 "always"（一直显示）。可选 always / auto / never。
    function getFabMode() {
      const m = lsGetFab(FAB_MODE_KEY);
      if (m === "always" || m === "auto" || m === "never") return m;
      return "always";
    }
    function mountAgentFab(fabCtx) {
      if (typeof document === "undefined") return () => {};
      if (document.getElementById("ad-agent-fab")) return () => {};

      const fab = document.createElement("div");
      fab.id = "ad-agent-fab";
      fab.className = "ad-fab";
      // v1.6.0：宿主配置装载完成前保持 display:none（防 vscode 重建后隐藏态/位置先闪现再消失），
      // 由下方 boot 流程统一揭示（成功/失败/超时三路都保证揭示）；直连浏览器下 fetch 极快，无感知延迟
      fab.style.display = "none";
      fab.title = "Agent 调度 · 悬浮球（可拖动）";
      // v0.8.3：官方 DSH logo 内联 SVG（不再用 🤖）
      const fabLogo = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      fabLogo.setAttribute("viewBox", "0 0 50 50");
      fabLogo.setAttribute("class", "ad-dsh-logo");
      fabLogo.setAttribute("aria-hidden", "true");
      const fabPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
      fabPath.setAttribute("d", DSH_LOGO_PATH);
      fabPath.setAttribute("fill", "currentColor");
      fabLogo.appendChild(fabPath);
      fab.appendChild(fabLogo);
      // v0.9.5：边缘流光独立环（conic 渐变旋转 + 遮罩掏空，只露边缘）
      const edgeRing = document.createElement("span");
      edgeRing.className = "ad-fab-edge-ring";
      edgeRing.setAttribute("aria-hidden", "true");
      fab.appendChild(edgeRing);
      document.body.appendChild(fab);
      // v0.8.8：挂载后应用悬浮球设置（色调/呼吸/彩色流光）
      setTimeout(() => {
        try { applyFabSettings(readFabSettings()); } catch (e) {
          console.warn("[agent-dispatch] 悬浮球设置初始应用失败:", (e && e.message) || e);
        }
      }, 0);

      // ── 位置：localStorage 恢复，钳在视口内（v0.8.3 不吸附，随处停）──
      const applyPos = (x, y) => {
        const r = 46; // 球直径
        x = Math.max(6, Math.min(x, window.innerWidth - r - 6));
        y = Math.max(6, Math.min(y, window.innerHeight - r - 6));
        fab.style.left = x + "px";
        fab.style.top = y + "px";
      };
      let pos = { x: window.innerWidth - 66, y: window.innerHeight - 66 }; // 默认右下
      try {
        const saved = JSON.parse(lsGetFab(FAB_POS_KEY) || "null");
        if (saved && typeof saved.x === "number" && typeof saved.y === "number") pos = saved;
      } catch (e) {
        // v1.6.0：损坏数据不再静默——告警后用默认位置
        console.warn("[agent-dispatch] 悬浮球位置 localStorage 解析失败，使用默认位置:", (e && e.message) || e);
      }
      applyPos(pos.x, pos.y);
      // v1.6.0：位置持久化双写——localStorage 降级副本 + 宿主通道（跨 webview 重建恢复）
      const savePos = () => {
        fabPosTouched = true; // 本地已写：迟到的宿主 pos 响应不再回放（以本地为准，且已双写宿主）
        lsSetFab(FAB_POS_KEY, JSON.stringify(pos));
        fabHostSave({ pos: { x: pos.x, y: pos.y } });
      };
      // 窗口缩放后保持球在视口内
      const onResize = () => { applyPos(pos.x, pos.y); if (popOpen) placePop(); };
      window.addEventListener("resize", onResize);

      // ── v1.6.0：宿主配置装载（读时序：宿主值 > localStorage > 默认；宿主缺失的字段从 localStorage 一次性上载）──
      // 三路保证揭示：宿主响应（含 null）/ 请求失败回退 / 1.5s 超时兜底，悬浮球绝不因宿主卡死而消失。
      let fabBootDisposed = false;
      fabBootDone = false;
      // 每轮装载重置：只衡量「本轮装载期」用户是否有本地写入（超时揭示后的迟到响应不覆盖窗口内修改）
      fabVisibleTouched = false;
      fabPosTouched = false;
      fabSettingsTouched = false;
      const revealFab = () => {
        if (fabBootDisposed || fabBootDone) return;
        fabBootDone = true;
        // v0.9.36 语义：总开关 off 或模式 never 强制隐藏；其余按模式（当前默认 always=常驻）
        fab.style.display = (!isFabVisible() || getFabMode() === "never") ? "none" : "grid";
      };
      const bootTimer = setTimeout(() => {
        if (!fabBootDone) {
          console.warn("[agent-dispatch] 悬浮球配置宿主通道响应超时，按 localStorage 状态先行显示");
          revealFab();
        }
      }, 1500);
      apiGet("/agent-api/fab-config")
        .then((d) => (d && d.config) || null)
        .then((cfg) => {
          clearTimeout(bootTimer);
          if (fabBootDisposed) return; // 悬浮球已卸载：不再回放（防触碰已移除的 DOM）
          // 超时后迟到宿主值仍回放：宿主是权威持久源，晚到修正（位置/隐藏态）好过整个会话丢失
          const upload = {}; // 宿主缺失而 localStorage 存在的字段 → 存量一次性上载
          // visible：宿主值优先；装载期间面板开关已被用户切换则以本地为准（宿主响应已过期）
          if (cfg && typeof cfg.visible === "boolean") {
            if (!fabVisibleTouched) {
              fabUi.visible = cfg.visible;
              lsSetFab(FAB_VIS_KEY, cfg.visible ? "1" : "0");
            }
          } else if (!fabVisibleTouched && lsGetFab(FAB_VIS_KEY) != null) {
            upload.visible = fabUi.visible;
          }
          // mode：宿主值镜像回 localStorage（getFabMode 运行时读 ls）
          if (cfg && (cfg.mode === "always" || cfg.mode === "auto" || cfg.mode === "never")) {
            lsSetFab(FAB_MODE_KEY, cfg.mode);
          } else if (lsGetFab(FAB_MODE_KEY)) {
            upload.mode = getFabMode();
          }
          // pos：宿主值应用 + 镜像；超时揭示后用户已拖动（fabPosTouched）则跳过——本地值已双写宿主，宿主响应已过期。
          // 宿主无值而 ls 有 → 上载（未拖动时球按 ls 态就位，pos 必然是 ls 态；已拖动则 savePos 已双写，无需上载）
          if (cfg && cfg.pos && typeof cfg.pos.x === "number" && typeof cfg.pos.y === "number") {
            if (!fabPosTouched) {
              pos = { x: cfg.pos.x, y: cfg.pos.y };
              applyPos(pos.x, pos.y);
              lsSetFab(FAB_POS_KEY, JSON.stringify(pos));
              // 迟到回放时弹窗可能已打开（超时揭示后用户点了球）——补跟随，防弹窗悬在旧球位
              if (popOpen) placePop();
            }
          } else if (!fabPosTouched && lsGetFab(FAB_POS_KEY)) {
            upload.pos = { x: pos.x, y: pos.y };
          }
          // settings：宿主值应用（DOM 光效 + 内存态 + ls 镜像）；超时揭示后用户已改设置（fabSettingsTouched）
          // 则跳过——本地值已排程双写宿主，宿主响应已过期。宿主无值而 ls 有 → 上载（已改则同样无需上载）
          if (cfg && cfg.settings && typeof cfg.settings === "object") {
            if (!fabSettingsTouched) {
              const merged = Object.assign(defaultFabSettings(), cfg.settings);
              fabSettingsMem = merged;
              lsSetFab(FAB_SET_KEY, JSON.stringify(merged));
              applyFabSettings(merged);
            }
          } else if (!fabSettingsTouched && lsGetFab(FAB_SET_KEY)) {
            upload.settings = readFabSettings();
          }
          if (Object.keys(upload).length) fabHostSave(upload); // 存量迁移：一次性上载宿主缺失字段
          revealFab();
        })
        .catch((e) => {
          clearTimeout(bootTimer);
          if (fabBootDisposed) return;
          // 宿主通道不可用（直连浏览器宿主半旧版/断连）：明示回退，行为与旧版一致
          console.warn("[agent-dispatch] 悬浮球配置宿主通道不可用，已回退 localStorage:", (e && e.message) || e);
          revealFab();
        });

      // ── 拖动：pointer 事件，移动>4px 视为拖拽（否则是点击）──
      let drag = null;
      fab.addEventListener("pointerdown", (ev) => {
        drag = { startX: ev.clientX, startY: ev.clientY, moved: false, pid: ev.pointerId };
        try { fab.setPointerCapture(ev.pointerId); } catch (e) {}
      });
      fab.addEventListener("pointermove", (ev) => {
        if (!drag) return;
        const dx = ev.clientX - drag.startX, dy = ev.clientY - drag.startY;
        if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; fab.classList.add("dragging"); }
        if (drag.moved) {
          pos = { x: pos.x + dx, y: pos.y + dy };
          drag.startX = ev.clientX; drag.startY = ev.clientY;
          applyPos(pos.x, pos.y);
          if (popOpen) placePop();
        }
      });
      const endDrag = (ev) => {
        if (!drag) return;
        const wasMoved = drag.moved;
        drag = null;
        fab.classList.remove("dragging");
        if (wasMoved) {
          // v0.8.3：随处可拖不吸附，直接保存松手位置（已由 applyPos 钳在视口内）
          savePos();
        } else {
          togglePop();
        }
      };
      fab.addEventListener("pointerup", endDrag);
      fab.addEventListener("pointercancel", () => { drag = null; fab.classList.remove("dragging"); });

      // ── 弹窗：跟随球位置（上方或下方，左右不越界）──
      let pop = null, popOpen = false;
      // v0.8.9：popView 区分主视图/设置视图，异步回调只在主视图时重绘（否则设置被覆盖回主视图）
      let popView = "main";
      const placePop = () => {
        if (!pop) return;
        // v0.9.23：宽度取实测值（旧版写死 236 是历史面板宽，现面板 360px →
        // 居中/边缘钳制全错位：球不在面板横向正中、贴边时不收缩）。
        const w = pop.offsetWidth || 360;
        const h = pop.offsetHeight || 120;
        let px = pos.x + 23 - w / 2; // 球中心对齐弹窗中心
        px = Math.max(8, Math.min(px, window.innerWidth - w - 8)); // 贴 app 边缘自适应收缩
        let py = pos.y - h - 12;    // 优先在球上方
        const below = py < 8;
        if (below) py = Math.min(pos.y + 54, window.innerHeight - h - 8); // 下方也防出界
        // v0.9.13：弹出原点锚在球心——transform-origin 指向球中心，视觉上面板从球里展开
        const ox = Math.max(12, Math.min(pos.x + 23 - px, w - 12));
        pop.style.transformOrigin = ox + "px " + (below ? "0px" : "100%");
        pop.style.left = px + "px";
        pop.style.top = py + "px";
      };
      const closePop = () => {
        if (pop) { pop.remove(); pop = null; }
        popOpen = false; popView = "main";
        // v0.9.23：默认展开态 = 运行中 + 最近完成（用户：打开面板最近完成也展开）；
        // Agent/小队列表保持折叠（注册表性质，量大）
        secOpen.recent = true; secOpen.agents = false; secOpen.squads = false; secOpen.run = true;
      };
      // v0.8.5.1：缓存最近一次活跃数据——打开面板先渲染缓存（不闪"加载中…"），再主动刷新
      let lastActive = null; // null=尚未 poll 过
      // v0.9.16：「最近委派」改名「最近完成」——只展示限时已完成任务（方案D），数据在 loadRecent 内过滤
      let lastRecent = null; // null=尚未拉取
      // v0.8.9：缓存 Agent 列表（面板"Agent 列表"分区，迷你调度台）
      let lastAgents = null; // null=尚未拉取
      // v0.9.13：缓存小队列表（面板"小队列表"分区，默认折叠）
      let lastSquads = null; // null=尚未拉取
      // v0.9.16：分区展开状态提升到面板级闭包——此前 agOpen/sqOpen 是 renderPop 局部变量，
      // 5s 轮询或 loadRecent/loadAgents 回调触发整面板重建后被重置，"展开了又自动收起"根因。
      // 重渲染时读取恢复；closePop 归位（下次打开全折叠）。
      // v0.9.23：最近完成默认展开（用户要求），与运行中一致
      const secOpen = { recent: true, agents: false, squads: false, run: true };
      const loadRecent = () => {
        fetch("/agent-api/dispatches")
          .then((r) => r.json())
          .then((d) => {
            if (!d || !Array.isArray(d.dispatches)) return;
            // v0.9.16：方案D 前端过滤——只留 TTL 内的已完成条目（TTL 在悬浮球设置里调，默认 30 分钟）
            // v0.9.34：小队 run 也计入「最近完成」——squad-run(end) 行是整次运行终态，
            // 此前只滤 dispatch 行 → 小队完成只显示已回报的步骤数（如 6 步只显示 2），
            // 且「最近完成」计数按 dispatch 行数而非任务数。现在 squad-run(end) 行按 1 个单位计入。
            const ttlMs = Math.max(1, Number(readFabSettings().recentTtlMin) || 30) * 60000;
            const cutoff = Date.now() - ttlMs;
            lastRecent = d.dispatches
              // v0.9.34：squad-run(end) 标记 ok=true 让「已完成」过滤通过——
              // host logSquadRun({phase:'end',stepStatus}) 不带 ok/ended 字段，需前端补
              .map((x) => x && x.kind === "squad-run" && x.phase === "end" ? { ...x, ok: true, ended: true } : x)
              .filter((x) => x && x.ok && x.ended && !x.orphan && new Date(x.ts).getTime() >= cutoff)
              .filter((x) => x.kind !== "squad-run" || x.phase === "end")
              .slice(0, 8);
            if (popOpen && popView === "main") renderPop(lastActive);
          })
          .catch(() => {});
      };
      const loadAgents = () => {
        fetch("/agent-api/suggest?q=")
          .then((r) => r.json())
          .then((d) => {
            if (!d || !d.ok || !Array.isArray(d.agents)) return;
            lastAgents = d.agents;
            lastSquads = Array.isArray(d.squads) ? d.squads : null; // v0.9.13：同端点顺带取小队
            if (popOpen && popView === "main") renderPop(lastActive);
          })
          .catch(() => {});
      };
      // v0.9.13：点击 Agent/小队卡片 → 当前会话输入框就地填 "$id "（用户补任务发送即委派）。
      // 走官方输入 facade：conversation.input.shell(当前会话).setDraft（单一写入路径，React 受控状态同步）。
      // 老宿主无该服务/取不到当前会话时回退打开调度面板，功能不丢。
      const dispatchTokenToComposer = (id) => {
        try {
          const sessions = fabCtx && fabCtx.get ? fabCtx.get("sessions") : null;
          const conv = fabCtx && fabCtx.get ? fabCtx.get("conversation") : null;
          const current = sessions && sessions.list && typeof sessions.list.getSnapshot === "function"
            ? sessions.list.getSnapshot().current : null;
          const shell = current && conv && conv.input && typeof conv.input.shell === "function"
            ? conv.input.shell(current) : null;
          if (shell && typeof shell.setDraft === "function") {
            shell.setDraft("$" + id + " ");
            return true;
          }
        } catch (e) { /* facade 不可用 → 回退 */ }
        if (openAgentPanel) openAgentPanel();
        return false;
      };
      const togglePop = () => {
        // v0.9.37：点悬浮球清完成光效——有活跃任务时 poll 保持 fab-live（白光呼吸），无活跃回初始态
        clearDoneGlow();
        if (popOpen) { closePop(); return; }
        pop = document.createElement("div");
        pop.className = "ad-fab-pop";
        document.body.appendChild(pop);
        popOpen = true;
        // v0.9.5：修 || 85 吞 0——拖到 0% 保存后重开被弹回 85（"调完收起再打开又变回原来"根因）
        const rawA = Number(readFabSettings().alpha);
        const a = Number.isFinite(rawA) ? Math.max(0, Math.min(100, rawA)) : 85;
        pop.style.setProperty("--fab-pop-alpha", String(a / 100));
        placePop();
        // 有缓存立即渲染，无缓存显示加载态
        popView = "main";
        renderPop(lastActive);
        // 打开时立即主动刷新一次（不等 5s 轮询）+ 拉最近委派 + 拉 Agent 列表
        poll();
        loadRecent();
        loadAgents();
        // v0.8.12：点面板外空白收起（重绘/设置后重新武装）
        armOutsideClose();
      };
      // v0.8.12：点面板外空白收起——每次视图重绘后都要重新挂（once 监听会被面板内点击消费掉）
      // v0.9.5：点球本身不算"点外"——否则 pointerdown 先关掉面板、同一次点击的 pointerup 又 togglePop 重开→"展开了还重新弹"
      const armOutsideClose = () => {
        setTimeout(() => {
          document.addEventListener("pointerdown", (ev) => {
            if (ev.target === fab || fab.contains(ev.target)) { armOutsideClose(); return; }
            if (popOpen && pop && !pop.contains(ev.target)) closePop();
          }, { once: true });
        }, 0);
      };
      const renderPop = (items) => {
        if (!pop) return;
        // v0.9.23：重绘保留滚动位置——5s 轮询/异步回调整体重建面板，
        // 新 body 的 scrollTop 归零 → 「不知道怎么突然回到顶部」。重绘前抓旧值、渲染后还回
        const prevBody = pop.querySelector(".ad-fab-pop-body");
        const prevScroll = prevBody ? prevBody.scrollTop : 0;
        // v0.9.27：原子渲染——旧版先 pop.textContent="" 清空，再逐段构建 head/body/foot 边建边挂；
        // 中途任何抛错（如数据字段类型异常）都留下「只有头部」的半残面板（用户现场：面板顶在原位、
        // 玻璃层只剩头高、悬浮球孤悬在下方远处），且 5s 轮询每次重试都先清空再炸 → 永久损坏。
        // 修法：head/body/foot 全部先建进 fragment（脱机，抛错不伤现有内容）；body 构建段包 try，
        // 异常降级空态；构建全部完成后才清空旧内容一次性挂入——面板任何时刻都不半残。
        const frag = document.createDocumentFragment();
        const runCount = items ? items.length : -1;
        // 头部：logo + 标题 + 状态摘要 + 关闭
        const head = document.createElement("div");
        head.className = "ad-fab-pop-head";
        const title = document.createElement("div");
        title.className = "ad-fab-pop-title";
        const logoMini = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        logoMini.setAttribute("viewBox", "0 0 50 50");
        logoMini.setAttribute("class", "ad-dsh-logo");
        logoMini.setAttribute("aria-hidden", "true");
        const logoMiniPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
        logoMiniPath.setAttribute("d", DSH_LOGO_PATH);
        logoMiniPath.setAttribute("fill", "currentColor");
        logoMini.appendChild(logoMiniPath);
        title.appendChild(logoMini);
        title.appendChild(document.createTextNode("Agent 活动"));
        head.appendChild(title);
        if (runCount >= 0) {
          const sum = document.createElement("span");
          sum.className = "ad-fab-pop-summary" + (runCount === 0 ? " zero" : "");
          sum.textContent = runCount > 0 ? "● " + runCount + " 运行中" : "空闲";
          head.appendChild(sum);
        }
        // v0.8.11：设置图标放关闭图标旁（头部右上角）
        const setBtn = document.createElement("button");
        setBtn.className = "ad-fab-pop-close ad-fab-pop-set";
        setBtn.textContent = "⚙";
        setBtn.title = "悬浮球设置";
        setBtn.addEventListener("click", openFabSettings);
        head.appendChild(setBtn);
        const closeBtn = document.createElement("button");
        closeBtn.className = "ad-fab-pop-close";
        closeBtn.textContent = "✕";
        closeBtn.title = "收起面板";
        closeBtn.addEventListener("click", closePop);
        head.appendChild(closeBtn);
        frag.appendChild(head);
        // 主体：v0.9.17 卡片化——运行中/最近完成/Agent 列表/小队列表 四分区各成独立圆角卡片，
        // 点标题行整卡折叠（展开状态走面板级 secOpen，跨 5s 重绘保持，关面板归位）
        const body = document.createElement("div");
        body.className = "ad-fab-pop-body";
        // v0.9.27：body 构建段包 try——任何数据异常降级空态，绝不让面板半残
        try {
        // 分区卡片工厂：标题行（名称 + 计数 + 右对齐箭头）+ 内容区；无 onToggle 时不可折叠（加载中态）
        const mkBox = (label, countText, open, onToggle) => {
          const box = document.createElement("div");
          box.className = "ad-fab-box";
          const hd = document.createElement("div");
          hd.className = "ad-fab-box-hd";
          hd.appendChild(document.createTextNode(label));
          const cnt = document.createElement("span");
          cnt.className = "cnt";
          cnt.textContent = countText;
          hd.appendChild(cnt);
          const spacer = document.createElement("span");
          spacer.className = "grow";
          hd.appendChild(spacer);
          const arrow = document.createElement("span");
          arrow.className = "arrow";
          arrow.textContent = open ? "▴" : "▾";
          hd.appendChild(arrow);
          if (onToggle) {
            hd.addEventListener("click", () => {
              onToggle();
              if (popOpen && popView === "main") renderPop(lastActive);
            });
          } else {
            hd.style.cursor = "default";
          }
          box.appendChild(hd);
          const bd = document.createElement("div");
          bd.className = "ad-fab-box-bd";
          bd.style.display = open ? "" : "none";
          box.appendChild(bd);
          body.appendChild(box);
          return bd;
        };
        // 运行中卡片：始终渲染（标题行带计数是面板状态骨架）；空闲时卡内显示空态文案
        if (!items) {
          const bd = mkBox("运行中", "…", true, null);
          const e = document.createElement("div");
          e.className = "ad-fab-empty";
          e.textContent = "加载中…";
          bd.appendChild(e);
        } else {
          const bd = mkBox("运行中", String(items.length), secOpen.run, () => { secOpen.run = !secOpen.run; });
          if (!items.length) {
            const e = document.createElement("div");
            e.className = "ad-fab-empty";
            e.textContent = "已全部结束";
            bd.appendChild(e);
          }
          for (const a of items) {
            const card = document.createElement("div");
            // v0.9.32：运行中按小队聚合展示——小队发起的行显示小队卡（头像+名称+步数），不显示成员；
            // 普通 agent 行保持原样。点击统一直达主会话（parentSessionId 优先，无则子会话）
            const squadName = a.squadName || (a.viaSquad || "");
            const isSquadRun = !!(a.viaSquad && squadName);
            card.className = "ad-fab-card" + ((a.childId || a.parentSessionId) && openAgentSession ? " clickable" : "");
            const target = a.parentSessionId || a.childId;
            if (target && openAgentSession) {
              card.title = a.parentSessionId ? "点击打开主会话" : "点击打开该子 agent 会话";
              card.addEventListener("click", () => { openAgentSession(target); closePop(); });
            }
            const em = document.createElement("span");
            if (isSquadRun) setAvatarEl(em, a.squadEmoji || "", squadName);
            else setAvatarEl(em, a.emoji, a.agentName || a.agentId); // v0.9.14：首字头像
            const g = document.createElement("span");
            g.className = "grow";
            const t1 = document.createElement("div");
            t1.className = "t1";
            t1.textContent = isSquadRun ? squadName + " · 小队" : (a.agentName || a.agentId || "?");
            const t2 = document.createElement("div");
            t2.className = "t2";
            t2.textContent = isSquadRun ? (a.taskLabel || "") : (a.taskLabel || "");
            g.appendChild(t1); g.appendChild(t2);
            const chip = document.createElement("span");
            chip.className = "ad-fab-chip run";
            chip.textContent = isSquadRun ? "运行中" : (a.startedAt ? fmtDur(a.startedAt) : "运行中");
            card.appendChild(em); card.appendChild(g); card.appendChild(chip);
            bd.appendChild(card);
          }
        }
        // 最近完成分区（原「最近委派」）——方案D：只展示限时已完成任务
        //（loadRecent 已按 TTL+ok+ended 过滤）；默认折叠成一行计数（用户要求），
        // 点击标题展开；连续同小队（viaSquad）+同主会话的行聚合成一张小队卡，点开看成员。
        // v0.9.34：聚合同时吸收 squad-run(end) 行——整次运行=1 个单位计数，
        // 步骤数/完成数取自 run 的 stepStatus 全量（此前只数 dispatch 行 → 6 步只显 2）。
        // 聚合键：squad-run 行用 squadRunId，dispatch 行用 viaSquad+parentSessionId，保证二者归一。
        const mkRecentCard = (d) => {
          const card = document.createElement("div");
          card.className = "ad-fab-card clickable";
          const em = document.createElement("span");
          setAvatarEl(em, d.emoji, d.agentName || d.agentId);
          const g = document.createElement("span");
          g.className = "grow";
          const t1 = document.createElement("div");
          t1.className = "t1";
          t1.textContent = d.agentName || d.agentId || "?";
          const t2 = document.createElement("div");
          t2.className = "t2";
          t2.textContent = d.taskLabel || "";
          g.appendChild(t1); g.appendChild(t2);
          // v0.9.32：去掉悬停快捷按钮（⇱/⇲）——卡片点击统一直达主会话
          const chip = document.createElement("span");
          chip.className = "ad-fab-chip ok";
          chip.textContent = "完成";
          card.appendChild(em); card.appendChild(g); card.appendChild(chip);
          const target = d.parentSessionId || d.childId;
          if (target) {
            card.title = d.parentSessionId ? "点击打开主会话" : "点击打开子 agent 会话";
            card.addEventListener("click", () => { openAgentSession(target); closePop(); });
          }
          return card;
        };
        // v0.9.34：最近完成聚合——同一次小队运行归为 1 个单位（run 计数）。
        // 数据形状：squad-run(end) 行（带 squadRunId+stepStatus）+ 该 run 的各 dispatch 行。
        // 聚合键统一用 squadRunId（dispatch 行也有 squadRunId）；无 runId 的旧 dispatch 行
        // 退化为按 viaSquad+parentSessionId 分组（保持旧行为）。计数逻辑：
        //   - 无 squadRunId 的组：按 dispatch 行数计（旧行为）
        //   - 有 squadRunId 的组：按 run 数计（1 个小队=1 个单位），步骤数取 run 的 stepStatus 长度
        const groups = [];
        const runEndById = new Map();
        if (lastRecent) {
          for (const d of lastRecent) {
            if (d.kind === "squad-run" && d.phase === "end" && d.squadRunId) {
              // v1.3.2：checkpoint 分段执行每次续跑都写一条 end 行，同一 squadRunId 有多条。
              // lastRecent 最新在前，首次遇到的是最新（stepStatus 最全）的一条；
              // 旧逻辑后到的（更旧的段）覆盖 → 完成数只显示最新段的步数（如 design 完成后仍 1/5）。
              if (!runEndById.has(d.squadRunId)) runEndById.set(d.squadRunId, d);
              continue;
            }
            const key = d.squadRunId || (d.viaSquad ? d.viaSquad + "|" + (d.parentSessionId || "") : null);
            const tail = groups[groups.length - 1];
            if (key && tail && tail.key === key) tail.items.push(d);
            else groups.push({ key, head: d, items: [d] });
          }
          // 把 squad-run(end) 行并入对应组（保证计数=run 数）
          for (const run of runEndById.values()) {
            const grp = groups.find((g) => g.key && g.key === run.squadRunId);
            if (grp) {
              grp.runEnd = run;
              // head 优先用 dispatch 行（带 squadName/taskLabel/parentSessionId 等展示字段），
              // 仅当该 run 完全没有 items（squad-run 在 TTL 内、其 dispatch 行都过期）时退回 run 行
              if (grp.items.length === 0) grp.head = run;
            } else {
              groups.push({ key: run.squadRunId, head: run, items: [], runEnd: run });
            }
          }
        }
        // v0.9.34：最近完成计数 = 任务单位数（组数），不再是 dispatch 行数——
        // 一个小队整次运行（含 6 步）只算 1 个「最近完成」，普通 agent 委派各算 1
        const recentCount = groups.length;
        const recBd = mkBox("最近完成", lastRecent ? String(recentCount) : "…", secOpen.recent, () => { secOpen.recent = !secOpen.recent; });
        if (secOpen.recent) {
          if (lastRecent && !lastRecent.length) {
            const e = document.createElement("div");
            e.className = "ad-fab-empty";
            e.textContent = "限时内无已完成任务";
            recBd.appendChild(e);
          }
          for (const grp of groups) {
            if (!grp.key) {
              recBd.appendChild(mkRecentCard(grp.head));
              continue;
            }
            // v0.9.32：小队整体卡——直接调用的小队不再展开成员子卡，
            // 整卡显示小队头像+名称+步数状态，点击直达主会话
            const sqCard = document.createElement("div");
            sqCard.className = "ad-fab-card clickable";
            // v0.9.34：head 可能是 squad-run 行（无 squadName/emoji/taskLabel）——兜底取组内任一 dispatch 行字段
            const headD = grp.head.kind === "squad-run" && grp.items.length ? grp.items[0] : grp.head;
            const em = document.createElement("span");
            setAvatarEl(em, headD.squadEmoji || "", headD.squadName || headD.viaSquad);
            const g = document.createElement("span");
            g.className = "grow";
            const t1 = document.createElement("div");
            t1.className = "t1";
            t1.textContent = (headD.squadName || headD.viaSquad) + " · 小队";
            // v0.9.34：小队卡步骤数取 run 终态全量——stepStatus 长度=总步数，done/skipped=完成数；
            // 无 run 终态（旧记录）退化为 dispatch 行数
            let totalN, doneN;
            if (grp.runEnd && Array.isArray(grp.runEnd.stepStatus)) {
              totalN = grp.runEnd.stepStatus.length;
              doneN = grp.runEnd.stepStatus.filter((s) => s === "done" || s === "skipped").length;
            } else {
              totalN = grp.items.length;
              doneN = grp.items.filter((d) => d.ok).length;
            }
            const t2 = document.createElement("div");
            t2.className = "t2";
            t2.textContent = doneN + "/" + totalN + " 步完成 · " + (headD.taskLabel || "");
            g.appendChild(t1); g.appendChild(t2);
            const chip = document.createElement("span");
            chip.className = "ad-fab-chip ok";
            chip.textContent = doneN + "/" + totalN + " 完成";
            sqCard.appendChild(em); sqCard.appendChild(g); sqCard.appendChild(chip);
            const target = headD.parentSessionId || headD.childId;
            if (target) {
              sqCard.title = "点击打开主会话";
              sqCard.addEventListener("click", () => { openAgentSession(target); closePop(); });
            }
            recBd.appendChild(sqCard);
          }
        }
        // v0.8.9：Agent 列表卡片（迷你调度台，默认折叠，点标题展开）
        if (lastAgents && lastAgents.length) {
          const agBd = mkBox("Agent 列表", String(lastAgents.length), secOpen.agents, () => { secOpen.agents = !secOpen.agents; });
          if (secOpen.agents) {
            const agList = document.createElement("div");
            agList.className = "ad-fab-agents";
            for (const a of lastAgents) {
              const card = document.createElement("div");
              card.className = "ad-fab-card clickable";
              card.title = "点击填入 $" + a.id + " 到当前会话输入框（补任务即委派）";
              // v0.9.13：就地调用——填 "$id " 到当前会话输入框；老宿主回退打开调度面板
              card.addEventListener("click", () => {
                dispatchTokenToComposer(a.id);
                closePop();
              });
              const em = document.createElement("span");
              setAvatarEl(em, a.emoji, a.name || a.id); // v0.9.14：首字头像
              const g = document.createElement("span");
              g.className = "grow";
              const t1 = document.createElement("div");
              t1.className = "t1";
              t1.textContent = a.name || a.id;
              const t2 = document.createElement("div");
              t2.className = "t2";
              t2.textContent = (a.desc || "").slice(0, 40);
              g.appendChild(t1); g.appendChild(t2);
              card.appendChild(em); card.appendChild(g);
              agList.appendChild(card);
            }
            agBd.appendChild(agList);
          }
        }
        // v0.9.13：小队列表卡片（默认折叠，点卡片就地调用 $squad-id）
        if (lastSquads && lastSquads.length) {
          const sqBd = mkBox("小队列表", String(lastSquads.length), secOpen.squads, () => { secOpen.squads = !secOpen.squads; });
          if (secOpen.squads) {
            const sqList = document.createElement("div");
            sqList.className = "ad-fab-agents";
            for (const q of lastSquads) {
              const card = document.createElement("div");
              card.className = "ad-fab-card clickable";
              card.title = "点击填入 $" + q.id + " 到当前会话输入框（补任务即委派小队）";
              card.addEventListener("click", () => {
                dispatchTokenToComposer(q.id);
                closePop();
              });
              const em = document.createElement("span");
              setAvatarEl(em, q.emoji, q.name || q.id); // v0.9.14：首字头像
              const g = document.createElement("span");
              g.className = "grow";
              const t1 = document.createElement("div");
              t1.className = "t1";
              t1.textContent = q.name || q.id;
              const t2 = document.createElement("div");
              t2.className = "t2";
              t2.textContent = (q.desc || "").slice(0, 40);
              g.appendChild(t1); g.appendChild(t2);
              card.appendChild(em); card.appendChild(g);
              sqList.appendChild(card);
            }
            sqBd.appendChild(sqList);
          }
        }
        } catch (e) {
          // v0.9.27：数据异常降级空态——面板结构完整可用，只是没内容；
          // 异常对象留在控制台（window.onerror 可观测），不打断渲染
          const errBox = document.createElement("div");
          errBox.className = "ad-fab-empty";
          errBox.textContent = "加载遇到问题，稍后再试";
          body.textContent = "";
          body.appendChild(errBox);
          try { console.warn("[agent-dispatch] renderPop body failed:", e); } catch (e2) {}
        }
        frag.appendChild(body);
        // 底部操作行：主按钮（设置已在头部右上角）
        const foot = document.createElement("div");
        foot.className = "ad-fab-pop-foot";
        const primary = document.createElement("button");
        primary.className = "primary";
        primary.textContent = "打开 Agent 调度面板";
        primary.addEventListener("click", () => {
          if (openAgentPanel) openAgentPanel();
          closePop();
        });
        foot.appendChild(primary);
        frag.appendChild(foot);
        // v0.9.27：原子替换——整段构建成功后才清空旧内容一次性挂入；
        // 中途抛错（head 段以外）已被 try 兜住降级，这里不会执行到半残态
        pop.textContent = "";
        pop.appendChild(frag);
        // v0.9.23：还回滚动位置（重绘前的旧 body 位置）；内容变短时浏览器自动钳制
        if (prevScroll > 0) {
          const nb = pop.querySelector(".ad-fab-pop-body");
          if (nb) nb.scrollTop = prevScroll;
        }
        placePop();
        armOutsideClose(); // v0.8.12：重绘后重新武装点外关闭
      };
      // v0.8.8：悬浮球设置浮层（色调/呼吸/彩色流光三开关；v1.6.0 起宿主通道持久化 + localStorage 降级副本）
      // v0.9.3：面板透明度 alpha 与悬浮球透明度 fabAlpha 分离
      // v0.9.3：面板/球透明度分离（面板走 ::before 层 --fab-pop-alpha，球走 --fab-opacity）
      // v0.9.16：recentTtlMin=「最近完成」分区展示时长（分钟），过期条目不再显示（方案D）
      // v1.6.0：设置内存态——宿主值装载后覆盖；写路径同步更新（localStorage 不可用时保会话内一致）
      let fabSettingsMem = null;
      const defaultFabSettings = () => ({ tone: "brand", breathe: true, edge: false, alpha: 85, fabAlpha: 100, recentTtlMin: 30 });
      const readFabSettings = () => {
        if (!fabSettingsMem) {
          try {
            const s = JSON.parse(lsGetFab(FAB_SET_KEY) || "null");
            if (s && typeof s === "object") fabSettingsMem = Object.assign(defaultFabSettings(), s);
          } catch (e) {
            console.warn("[agent-dispatch] 悬浮球设置 localStorage 解析失败，使用默认值:", (e && e.message) || e);
          }
          if (!fabSettingsMem) fabSettingsMem = defaultFabSettings();
        }
        // 返回副本：调用方就地改后交 writeFabSettings 落盘，不污染内存态
        return Object.assign(defaultFabSettings(), fabSettingsMem);
      };
      // v1.6.0：设置写路径统一——内存态 + localStorage 副本 + 宿主通道三写。
      // 滑杆连续 input 高频触发：localStorage 逐次落（保单浏览器会话），宿主通道 300ms 防抖合并。
      let fabSettingsHostTimer = null;
      const writeFabSettings = (s) => {
        fabSettingsTouched = true; // 本地已写：迟到的宿主 settings 响应不再回放（以本地为准，且已排程双写宿主）
        fabSettingsMem = s;
        lsSetFab(FAB_SET_KEY, JSON.stringify(s));
        if (fabSettingsHostTimer) clearTimeout(fabSettingsHostTimer);
        fabSettingsHostTimer = setTimeout(() => {
          fabSettingsHostTimer = null;
          fabHostSave({ settings: s });
        }, 300);
      };
      const applyFabSettings = (s) => {
        // v0.9.5：色调批次换浅色+玻璃；v0.9.12：整球彩色流光已删，只留边缘流光（edge）
        const toneIds = ["brand", "snow", "sky", "mist", "cherry", "apricot", "rainbow", "glass"];
        fab.classList.remove(...toneIds.map((id) => "ad-tone-" + id));
        const tid = toneIds.includes(s.tone) ? s.tone : "brand";
        if (tid !== "brand") fab.classList.add("ad-tone-" + tid);
        fab.classList.toggle("fab-breathe", !!s.breathe);
        fab.classList.toggle("fab-edge", !!s.edge);
        // v0.9.5：同款 || 100 吞 0 修复
        const rawFa = Number(s.fabAlpha);
        const fa = Number.isFinite(rawFa) ? Math.max(0, Math.min(100, rawFa)) : 100;
        fab.style.setProperty("--fab-opacity", String(fa / 100));
      };
      const openFabSettings = () => {
        if (!pop) return;
        popView = "settings"; // v0.8.9：防止异步回调把设置视图覆盖回主视图
        // v0.9.27：同 renderPop 原子化——先构建后替换，中途异常不半残
        const frag = document.createDocumentFragment();
        const cur = readFabSettings();
        // 头部
        const head = document.createElement("div");
        head.className = "ad-fab-pop-head";
        const title = document.createElement("div");
        title.className = "ad-fab-pop-title";
        title.appendChild(document.createTextNode("悬浮球设置"));
        head.appendChild(title);
        const closeBtn = document.createElement("button");
        closeBtn.className = "ad-fab-pop-close";
        closeBtn.textContent = "✕";
        closeBtn.addEventListener("click", closePop);
        head.appendChild(closeBtn);
        frag.appendChild(head);
        const body = document.createElement("div");
        body.className = "ad-fab-pop-body";
        // v0.9.27：设置项构建段包 try——异常降级空态，面板不半残
        try {
        // 色调三选
        const secTone = document.createElement("div");
        secTone.className = "ad-fab-sec";
        secTone.textContent = "色调";
        body.appendChild(secTone);
        const tones = [
          // v0.9.5：浅色批次 + 彩虹 + 毛玻璃无色透明（静态 token，此环境无 color-mix）
          // v0.9.11：雪白置顶
          { id: "snow", label: "雪白", css: ["var(--dsw-static-neutral-00)", "var(--dsw-static-neutral-bluish-100)"] },
          { id: "brand", label: "品牌蓝", css: ["var(--dsw-static-blue-500)", "var(--dsw-static-blue-800)"] },
          { id: "sky", label: "天蓝", css: ["var(--dsw-static-blue-100)", "var(--dsw-static-blue-400)"] },
          { id: "mist", label: "雾紫", css: ["var(--dsw-static-deepseek-100)", "var(--dsw-static-deepseek-450)"] },
          { id: "cherry", label: "樱粉", css: ["var(--dsw-static-red-100)", "var(--dsw-static-red-400)"] },
          { id: "apricot", label: "杏橙", css: ["var(--dsw-static-amber-100)", "var(--dsw-static-amber-400)"] },
          { id: "rainbow", label: "彩色渐变", css: ["var(--dsw-static-red-500)", "var(--dsw-static-blue-500)"] },
          { id: "glass", label: "毛玻璃", css: ["var(--dsw-static-neutral-00)", "var(--dsw-static-neutral-bluish-200)"] },
        ];
        const toneRow = document.createElement("div");
        toneRow.className = "ad-fab-tone-row";
        // v0.9.21：点选只就地翻转 .on 类，不再整体重绘（重绘会丢滚动位置跳回顶部）
        const toneEls = [];
        for (const tn of tones) {
          const t = document.createElement("div");
          t.className = "ad-fab-tone" + (cur.tone === tn.id ? " on" : "");
          t.title = tn.label;
          const dot = document.createElement("span");
          dot.className = "dot";
          dot.style.background = "linear-gradient(135deg," + tn.css[0] + "," + tn.css[1] + ")";
          const lb = document.createElement("span");
          lb.textContent = tn.label;
          t.appendChild(dot); t.appendChild(lb);
          t.addEventListener("click", () => {
            const s = readFabSettings(); s.tone = tn.id;
            writeFabSettings(s);
            applyFabSettings(s);
            for (const x of toneEls) x.classList.toggle("on", x.dataset.tone === tn.id);
          });
          t.dataset.tone = tn.id;
          toneEls.push(t);
          toneRow.appendChild(t);
        }
        body.appendChild(toneRow);
        // 动效开关：呼吸 / 彩色流光（灰底白球两态一致）
        const mkSwitch = (label, desc, key) => {
          const row = document.createElement("div");
          row.className = "ad-fab-set-row";
          const g = document.createElement("span");
          g.className = "grow";
          const l1 = document.createElement("div");
          l1.className = "t1";
          l1.textContent = label;
          const l2 = document.createElement("div");
          l2.className = "t2";
          l2.textContent = desc;
          g.appendChild(l1); g.appendChild(l2);
          const sw = document.createElement("button");
          sw.className = "ad-switch" + (cur[key] ? " on" : "");
          sw.setAttribute("role", "switch");
          sw.setAttribute("aria-checked", String(!!cur[key]));
          sw.appendChild(document.createElement("span"));
          sw.lastChild.className = "knob";
          sw.addEventListener("click", () => {
            const s = readFabSettings(); s[key] = !s[key];
            writeFabSettings(s);
            applyFabSettings(s);
            // v0.8.10：knob 即时反馈（on/off 类切换），否则点击后 UI 无变化像没反应
            sw.classList.toggle("on", !!s[key]);
            sw.setAttribute("aria-checked", String(!!s[key]));
          });
          row.appendChild(g); row.appendChild(sw);
          return row;
        };
        body.appendChild(mkSwitch("呼吸光晕", "悬浮球常态呼吸动效", "breathe"));
        // v0.9.12：整球彩色流光已删，只留边缘流光
        body.appendChild(mkSwitch("边缘彩色流光", "仅球边缘彩虹光环流转", "edge"));
        // v0.9.3：面板/悬浮球透明度分离——两个独立滑块
        const mkSlider = (title, sub, key, apply) => {
          const sec = document.createElement("div");
          sec.className = "ad-fab-sec";
          sec.textContent = title;
          body.appendChild(sec);
          const row = document.createElement("div");
          row.className = "ad-fab-set-row";
          const g = document.createElement("span");
          g.className = "grow";
          const l1 = document.createElement("div");
          l1.className = "t1";
          l1.textContent = title;
          const l2 = document.createElement("div");
          l2.className = "t2";
          l2.textContent = sub;
          g.appendChild(l1); g.appendChild(l2);
          const val = document.createElement("span");
          val.className = "ad-fab-alpha-val";
          val.textContent = cur[key] + "%";
          const sl = document.createElement("input");
          sl.type = "range";
          sl.min = "0"; sl.max = "100"; sl.step = "5";
          sl.value = String(cur[key]);
          sl.className = "ad-fab-alpha";
          sl.addEventListener("input", () => {
            const v = Number(sl.value);
            val.textContent = v + "%";
            const s = readFabSettings(); s[key] = v;
            writeFabSettings(s);
            apply(v);
          });
          row.appendChild(g); row.appendChild(val); row.appendChild(sl);
          body.appendChild(row);
        };
        mkSlider("面板透明度", "0-100，越低越通透", "alpha", (v) => {
          if (pop) pop.style.setProperty("--fab-pop-alpha", String(v / 100));
        });
        mkSlider("悬浮球透明度", "0-100，越低越通透", "fabAlpha", (v) => {
          fab.style.setProperty("--fab-opacity", String(v / 100));
        });
        // v0.9.16：「最近完成」展示时长（方案D）——只展示该时长内的已完成任务，过期自动消失
        const secTtl = document.createElement("div");
        secTtl.className = "ad-fab-sec";
        secTtl.textContent = "最近完成 · 展示时长";
        body.appendChild(secTtl);
        const ttlRow = document.createElement("div");
        ttlRow.className = "ad-fab-modes";
        // v0.9.21：点选只就地翻转 .on 类，不再整体重绘（重绘会丢滚动位置跳回顶部）
        const ttlOpts = [];
        for (const opt of [10, 30, 60]) {
          const o = document.createElement("div");
          o.className = "ad-fab-mode" + ((cur.recentTtlMin || 30) === opt ? " on" : "");
          const dot = document.createElement("span");
          dot.className = "dot";
          const lb = document.createElement("span");
          lb.textContent = opt + " 分钟";
          o.appendChild(dot); o.appendChild(lb);
          o.addEventListener("click", () => {
            const s = readFabSettings(); s.recentTtlMin = opt;
            writeFabSettings(s);
            for (const t of ttlOpts) t.classList.toggle("on", Number(t.dataset.ttl) === opt);
            loadRecent(); // 立即按新时长重算
          });
          o.dataset.ttl = String(opt);
          ttlOpts.push(o);
          ttlRow.appendChild(o);
        }
        body.appendChild(ttlRow);
        } catch (e) {
          // v0.9.27：设置项异常降级空态，面板结构完整
          const errBox = document.createElement("div");
          errBox.className = "ad-fab-empty";
          errBox.textContent = "设置加载遇到问题，请稍后再试";
          body.textContent = "";
          body.appendChild(errBox);
          try { console.warn("[agent-dispatch] openFabSettings body failed:", e); } catch (e2) {}
        }
        frag.appendChild(body);
        const foot = document.createElement("div");
        foot.className = "ad-fab-pop-foot";
        const back = document.createElement("button");
        back.className = "ghost";
        back.textContent = "← 返回";
        back.addEventListener("click", () => { popView = "main"; renderPop(lastActive); });
        const done = document.createElement("button");
        done.className = "primary";
        done.textContent = "完成";
        done.addEventListener("click", closePop);
        foot.appendChild(back); foot.appendChild(done);
        frag.appendChild(foot);
        // v0.9.27：原子替换——整段构建成功后才清空旧内容一次性挂入
        pop.textContent = "";
        pop.appendChild(frag);
        placePop();
        armOutsideClose(); // v0.8.12：设置视图也支持点外关闭
      };

      // ── 轮询同步：显隐 + 完成检测（集合差：消失的 childId = 刚完成）──
      let prevIds = null;    // 上一轮的活跃 childId 集合（null=尚未初始化，首轮不报完成）
      let doneCount = 0;     // 待展示的完成数
      // v0.9.37：完成光效常驻——不再 5s 自动消散；点击悬浮球后按活跃状态回退
      // v0.9.33：活跃绿点（liveDot/.ad-fab-dot）与完成 ✓N 角标（doneBadge/.ad-fab-done）已删——光效提醒（fab-live 白光呼吸 + done-glow 彩色光呼吸）已足够
      // v0.9.37：状态机——完成=彩色呼吸光常驻；点击后清光：有活跃→fab-live 白光呼吸，无活跃→无动画（初始态）
      // 说明：poll 每 5s 按活跃状态校正（arr.length>0 → 去 done-glow；doneCount>0 且无活跃 → 补 done-glow），
      // 因此 showDoneBadge 只负责挂类，无需自行裁决优先级。
      const showDoneBadge = () => {
        fab.classList.remove("done-glow");
        void fab.offsetWidth; // 强制重排，允许连续完成时重新触发
        fab.classList.add("done-glow");
      };
      // v0.9.37：点击悬浮球（开/关面板）后清完成光效——
      // 有活跃任务时 poll 已挂 fab-live（白光呼吸），无活跃则回到初始态（无动画）
      const clearDoneGlow = () => {
        fab.classList.remove("done-glow");
        doneCount = 0;
      };
      const poll = () => {
        fetch("/agent-api/active")
          .then((r) => r.json())
          .then((d) => {
            if (!d.ok) return;
            const arr = d.active || [];
            lastActive = arr; // v0.8.5.1：缓存供面板打开即时渲染
            const ids = new Set(arr.map((a) => a.childId).filter(Boolean));
            // 完成检测：上轮活跃、本轮消失
            if (prevIds !== null) {
              let finished = 0;
              for (const id of prevIds) if (!ids.has(id)) finished += 1;
              if (finished > 0) { doneCount += finished; showDoneBadge(); }
            }
            prevIds = ids;
            // v1.8.0：待授权（ACP 权限审批挂起）——琥珀脉冲光效，优先级最高
            // v1.11.14(M3 计数)：脉冲光效按**请求数**判定（与琥珀球行数一致）
            const pendingCount = arr.reduce((n, a) => n + permCountOf(a), 0);
            fab.classList.toggle("fab-pending", pendingCount > 0);
            // v0.9.33：活跃绿点已删（光效 fab-live 白光呼吸已是状态指示）
            fab.classList.toggle("fab-live", arr.length > 0 && pendingCount === 0);
            // v0.9.37：活跃状态变化后同步光效——完成光让位给白光/恢复（doneCount>0 且无活跃时保持彩色）
            if (arr.length > 0 || pendingCount > 0) fab.classList.remove("done-glow");
            else if (doneCount > 0 && !fab.classList.contains("done-glow")) {
              fab.classList.add("done-glow");
            }
            // 光效互斥：pending 时去掉其他动画类（呼吸/完成），琥珀脉冲独显；
            // pending 结束后按用户设置恢复常驻呼吸
            if (pendingCount > 0) {
              fab.classList.remove("fab-breathe");
            } else {
              try {
                const s = JSON.parse(lsGetFab(FAB_SET_KEY) || "null");
                if (s && s.breathe) fab.classList.add("fab-breathe");
              } catch { /* 设置损坏时忽略 */ }
            }
            // v1.6.0：宿主配置首轮装载未完成前不抢显示（防隐藏态在宿主值恢复前闪现），由 boot 流程统一揭示
            if (!fabBootDone) return;
            // v0.8 显隐模式：never=永不显示；always=常驻；auto=活跃>0 或有未消散完成徽标时显示（旧行为）
            // v0.9.36：总开关 off 时优先强制隐藏
            const mode = getFabMode();
            if (!isFabVisible() || mode === "never") {
              fab.style.display = "none";
              closePop();
              return;
            }
            const shouldShow = mode === "always" || arr.length > 0 || doneCount > 0;
            fab.style.display = shouldShow ? "grid" : "none";
            if (!shouldShow) closePop();
            else if (popOpen && popView === "main") renderPop(arr);
          })
          .catch(() => {});
      };
      poll();
      const timer = setInterval(poll, 5000);

      return () => {
        // v1.6.0：装载期收尾——停超时兜底、标记卸载（迟到的宿主响应不再回放）、放行 display 状态位
        fabBootDisposed = true;
        clearTimeout(bootTimer);
        fabBootDone = true;
        // v1.6.0：冲刷设置防抖残留——卸载前最后一次设置变更立即上载宿主，防 300ms 窗口内丢改
        if (fabSettingsHostTimer) {
          clearTimeout(fabSettingsHostTimer);
          fabSettingsHostTimer = null;
          if (fabSettingsMem) fabHostSave({ settings: fabSettingsMem });
        }
        clearInterval(timer);
        window.removeEventListener("resize", onResize);
        closePop();
        fab.remove();
      };
    }

    // ── v1.8.0：独立「待授权」悬浮球 ──
    // 有子代理在等 ACP 权限授权时出现（琥珀 ⏳ 球 + 计数），点击展开待授权列表，
    // 点条目跳转该子代理会话（审批弹窗在该会话界面）。与主 FAB 完全独立：主 FAB
    // 可隐藏/never，授权球仍按需出现；无 pending 时自动消失。
    function mountPermFab() {
      if (typeof document === "undefined") return () => {};
      if (document.getElementById("ad-perm-fab")) return () => {};
      const ball = document.createElement("div");
      ball.id = "ad-perm-fab";
      ball.className = "ad-perm-fab";
      ball.title = "有子代理正在等待 ACP 权限授权——点击查看并前往处理";
      ball.textContent = "⏳";
      const count = document.createElement("span");
      count.className = "perm-count";
      ball.appendChild(count);
      document.body.appendChild(ball);
      const pop = document.createElement("div");
      pop.className = "ad-perm-pop";
      document.body.appendChild(pop);
      // v1.11.15(UI)：内容区独立滚动（面板本体 overflow:hidden），配合 CSS 的
      // max-height + sticky 操作行，保证授权按钮永远落在视口内可点。
      const popBody = document.createElement("div");
      popBody.className = "ad-perm-body";
      pop.appendChild(popBody);

      const hidePop = () => pop.classList.remove("visible");
      let lastPending = []; // 最近一次 poll 的 pending 列表（ball click 时渲染用）
      ball.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pop.classList.toggle("visible");
        renderPop();
      });
      document.addEventListener("click", (e) => {
        if (!pop.contains(e.target) && e.target !== ball) hidePop();
      });

      // 渲染列表：v1.11.14(A)——**一个权限请求一行**。旧实现按 childId 折叠，
      // 同一子代理并发 2 条授权时只渲染 1 行，点掉一条后另一条从蓝球冒出来。
      // 信息行点击跳转其会话，操作行提供授权决策按钮（v1.9.0）
      /**
       * v1.11.14(M3)：已投递决策的 permId 记账，活过每一次轮询重建。
       * 按钮的 disabled 是 DOM 态：poll 每 3s 拿快照重建列表，用户"再点一次球"
       * 就会让**同一条请求**带着可用按钮回来，再投一次决策。服务端现已忽略未命中
       * 的 permId，但老插件仍会 FIFO 顶替别的请求——客户端先把重复投递堵死。
       * 无 permId 的行（老服务端）不记账：那条路径下服务端只看 childId，且一次
       * 只显示一条，不存在顶替风险。
       */
      const decidedPermIds = new Set();
      const decidedKey = (row) => (row && row.permId ? `${row.childId}::${row.permId}` : null);
      const isDecided = (row) => {
        const k = decidedKey(row);
        return !!k && decidedPermIds.has(k);
      };
      /**
       * v1.12.6 U2：`paths` 是「可编辑路径」弹框确认后的**用户声明**，随决策透传给
       * 产品侧（契约：非空 ⇒ 只写路径档；空数组 ⇒ 只写工具名档；不传 ⇒ 产品侧自动分析）。
       * 本插件不在此校验——落盘判据在产品侧 planGrantWrites 单点决定，两边各校验一遍
       * 必然出现"一边认一边不认"的分叉。
       */
      const sendDecision = (a, answer, label, paths) => {
        const btn = (a._btn) || null;
        if (isDecided(a)) {
          // 已投过 → 只锁按钮，绝不重复 POST
          if (btn) { btn.disabled = true; btn.textContent = "已决策 ✓"; }
          return;
        }
        const key = decidedKey(a);
        if (key) decidedPermIds.add(key);
        if (btn) { btn.disabled = true; btn.textContent = "处理中…"; }
        // v1.11.14(B)：本地记账——该 childId 已由用户经琥珀球代答，琥珀随后
        // 消失属于"已决议"，不得再把它的蓝球孪生提升回来（孪生提升闸门②）
        acpTwinMarkDecided(a.childId);
        const payload = { childId: a.childId, permId: a.permId || null, answer };
        if (Array.isArray(paths)) payload.paths = paths;
        apiPost("/agent-api/permission-decision", payload)
          .then(() => {
            // 决策已转发：pending 项将由 permission-resolved 事件清除（下次 poll）
            if (btn) btn.textContent = label + " ✓";
          })
          .catch((e) => {
            console.warn("[agent-dispatch] permission-decision 失败:", (e && e.message) || e);
            if (key) decidedPermIds.delete(key); // 投递失败 → 允许重试
            if (btn) { btn.disabled = false; btn.textContent = label; }
          });
      };
      /**
       * 摊平逻辑在模块作用域的 permRowsOf（v1.11.14(A)）——四处显示位共用一个语义。
       */
      const permTip = (text) => {
        const tip = document.createElement("div");
        tip.className = "ad-perm-empty";
        tip.style.color = "#c62828";
        tip.textContent = text;
        popBody.appendChild(tip);
      };
      const renderPop = () => {
        popBody.textContent = "";
        if (lastPending.length === 0) {
          const empty = document.createElement("div");
          empty.className = "ad-perm-empty";
          empty.textContent = "没有待授权的请求";
          popBody.appendChild(empty);
          return;
        }
        for (const a of lastPending) {
          // v1.12.15（用户裁定）：高危 ⇒ **专用形态**，整行短路。下面普通行的四按钮、
          // 「本会话将记住」文案、目录编辑弹框一条都不许出现——归因是产品侧 0.7.16
          // 随 permission-pending 透出的（askReason/dangerRule/dangerSegment/dangerCommand），
          // 序列化为 null 时 dangerAskOf 判不出原因，照旧走下面的普通行（降级契约）。
          const danger = dangerAskOf(a.permissionPending);
          if (danger) {
            popBody.appendChild(buildDangerAskRow({
              meta: (a.agentName || a.agentId || "子代理") + " · " + String(a.childId || "").slice(0, 8)
                + (a.permId ? " · " + String(a.permId).slice(-6) : ""),
              danger,
              decided: isDecided(a),
              // 只投 allow-once / deny：产品侧对 allow-once **一条规则都不写**（0.7.16
              // 的判定零变更用例钉着这条），所以这里连 paths 都不带。
              onAllowOnce: (btn) => { a._btn = btn; return sendDecision(a, "allow-once", "允许一次"); },
              onDeny: (btn) => { a._btn = btn; return sendDecision(a, "deny", "拒绝"); },
            }));
            continue;
          }
          const row = document.createElement("div");
          row.className = "ad-perm-item";
          // 信息行：点按跳转子代理会话（审批弹窗在那里也可操作）
          const info = document.createElement("div");
          info.className = "ad-perm-info";
          const name = document.createElement("span");
          name.className = "p-name";
          name.textContent = (a.agentName || a.agentId || "子代理") + " · " + String(a.childId || "").slice(0, 8)
            + (a.permId ? " · " + String(a.permId).slice(-6) : "");
          const desc = document.createElement("span");
          desc.className = "p-desc";
          // v1.12.6 U1：这里过去显示 permissionPending.category——那只是 title 的
          // slug，**不是记忆键**（qoder 下它是一长串命令），等于在骗用户"将被记住什么"。
          const catTip = permGrantTip(a.permissionPending);
          desc.textContent = ((a.permissionPending.description || "请求权限").slice(0, 160)) + catTip;
          info.appendChild(name); info.appendChild(desc);
          // v1.11.14(E)：整行可点（黄球初版 067aeeb 点击目标就是整行，d3537d8 加
          // 四按钮时收窄到 info → 点行内空白不再跳转）。四个决策按钮各自
          // stopPropagation，不会误触。
          row.title = "打开该子代理会话界面（审批弹窗在那里也可操作）";
          const openSelf = () => {
            if (!a.childId) {
              permTip("该行缺少子代理标识，无法跳转。请从左侧会话树或 Agent 面板「运行中」打开。");
              return;
            }
            const r = openAgentSession ? openAgentSession(a.childId, a.parentSessionId) : Promise.resolve(false);
            Promise.resolve(r).then((ok) => {
              // v1.11.14(m8)：只有**核实过**的成功才收起列表。'unverified'（宿主没
              // 抛错但主视图没持有该会话）与 false 都保留浮层——用户还能立刻重试，
              // 不会因为"乐观成功"看着列表消失、球还在亮。
              if (ok === true) { hidePop(); return; }
              permTip(ok === "unverified"
                ? "已请求打开该子代理会话，但未确认页面已切换。若界面没有变化，请从左侧会话树或 Agent 面板「运行中」打开。"
                : "无法自动跳转（子代理会话未就绪）。请从左侧会话树或 Agent 面板「运行中」打开该子代理会话。");
            }, (e) => {
              console.warn("[agent-dispatch] 授权球跳转异常:", (e && e.message) || e);
              permTip("跳转失败。请从左侧会话树或 Agent 面板「运行中」打开该子代理会话。");
            });
          };
          row.addEventListener("click", openSelf);
          row.setAttribute("role", "button");
          row.tabIndex = 0;
          row.addEventListener("keydown", (ev) => {
            if (ev.target !== row) return; // 行内按钮的键盘激活归按钮自己
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); openSelf(); }
          });
          row.appendChild(info);
          // 操作行：四个决策按钮（v1.9.2）
          const actions = document.createElement("div");
          actions.className = "ad-perm-actions";
          const mkBtn = (label, answer, cls, tip, grant) => {
            const b = document.createElement("button");
            b.className = "ad-btn mini " + (cls || "");
            b.textContent = label;
            b.title = tip || "";
            // v1.11.14(M3)：这一行的决策已投递 → 重建出来也是不可点的（旧实现
            // 每次 poll 重建 DOM，等于把上一轮的按钮重新武装）
            if (isDecided(a)) { b.disabled = true; b.textContent = "已决策"; b.title = "决策已投递，等待产品侧落定"; }
            b.addEventListener("click", (ev) => {
              ev.stopPropagation();
              if (!grant) {
                a._btn = b;
                sendDecision(a, answer, label);
                return;
              }
              // v1.12.6 U2/U4：「记住类」按钮不再点了就生效——先把要记住的目录摊开
              // 让用户改，确认后才把**勾选后的**目录随决策发出。
              // 取消 / Esc / 点遮罩 ⇒ resolve(null)：不发决策、不写规则、请求继续挂着。
              // U4：产品侧 0.7.9 把目录分成两档给出（suggestedDirs 实际触达 /
              // inferredDirs 正文推测），两档各进各的组，不合并、不互相顶替。
              a._btn = b;
              const p = a.permissionPending || {};
              // v1.12.6 第五轮（用户裁定）：相对路径按工作区目录补齐后再进编辑框。
              // 本通道的 cwd 来自产品侧 pending 事件（`markPermissionPending` 已记账；
              // **产品侧当前不透传它** ⇒ amberCwd 通常是 null ⇒ 这里等价于原样透传，
              // 相对路径由弹框走「不默认勾选 + 就地提示」的降级分支）。
              // 注意用 absolutizeDirs 而不是 dirsOfPaths：产品侧给的**已经是目录**，
              // dirsOfPaths 会把「名字像文件」的目录再取一次父目录 = 预填变宽。
              // v1.12.7：`~` 展开基准 `p.home` 由本插件自己的 /agent-api/active 轮询下发
              // （产品侧不透传 cwd/home，而前端拿不到 os.HOME）⇒ 这条通道的 `~/.ssh` 之类
              // 候选也能展开成绝对路径并恢复默认勾选；拿不到 home 时保持旧行为。
              const amberCwd = typeof p.cwd === "string" && p.cwd.trim() ? p.cwd.trim() : null;
              const amberHome = typeof p.home === "string" && p.home.trim() ? p.home.trim() : null;
              const sug = Array.isArray(p.suggestedDirs) && p.suggestedDirs.length > 0
                ? absolutizeDirs(p.suggestedDirs, amberCwd, amberHome)
                : dirsOfPaths(p.paths, amberCwd, amberHome);
              openGrantDialog({
                title: "确认要记住的目录", product: p.product, toolName: p.toolName,
                suggestedDirs: sug,
                inferredDirs: nonEmptyArray(p.inferredDirs) ? absolutizeDirs(p.inferredDirs, amberCwd, amberHome) : [],
                cwd: amberCwd,
                home: amberHome,
                projectTier: grant.projectTier === true,
                // v1.12.7：本通道 allow-always ⇒ 产品侧把 `tools` 写进共用白名单（落盘档）；
                // allow-session ⇒ 只写内存。二级选择靠它说清「落盘档 / 本会话档」。
                toolTierDisk: grant.projectTier === true,
              }).then((d) => {
                if (!d) return;
                // v1.12.7（用户裁定）：二级选择「仅本次放行」⇒ 回 `allow-once` 且**不带 paths**。
                // 产品侧对 allow-once 不写任何档（路径档与工具档都不写），正好是用户要的
                // 「只放行这一次」；**不能**回传那批非法路径——那会落到产品侧
                // `planGrantWrites` 的 `mode:'none'` 拒写出口，而那是防「误给非法路径」的
                // fail-closed 兜底，不该被当成正常出口来依赖。
                if (d.mode === "once") { sendDecision(a, "allow-once", "仅本次放行"); return; }
                // 「该工具对任意路径都将放行」⇒ 显式空数组（用户明确意图）⇒ 产品侧 mode:'tools'
                sendDecision(a, answer, label, d.paths);
              });
            });
            actions.appendChild(b);
            return b;
          };
          mkBtn("允许一次", "allow-once", "", "仅放行本次请求，后续同类请求仍会询问");
          mkBtn("本会话总是允许该工具", "allow-session", "",
            "先确认要记住的目录（目录级，不落盘）；一条都不勾（或留下的都不是绝对路径）⇒ 点「确认」会再让你选「仅本次放行」还是「该工具对任意路径都将放行」（后者落盘到共用白名单）。点「取消」什么都不写",
            { projectTier: false });
          mkBtn("总是允许(项目)", "allow-always", "",
            "先确认要记住的目录（目录级，落盘到共用白名单，同工作目录跨会话生效）；一条都不勾（或留下的都不是绝对路径）⇒ 点「确认」会再让你选「仅本次放行」还是「该工具对任意路径都将放行」（后者落盘到共用白名单，同工作目录跨会话生效）。点「取消」什么都不写",
            { projectTier: true });
          mkBtn("拒绝", "deny", "danger", "拒绝本次请求");
          row.appendChild(actions);
          popBody.appendChild(row);
        }
      };

      const poll = () => {
        apiGet("/agent-api/active")
          .then((d) => {
            const arr = (d && d.active) || [];
            const rows = permRowsOf(arr); // v1.11.14(A)：每请求一行
            lastPending = rows; // 供 renderPop 取最新（ball click 时渲染）
            // v1.11.14(M3)：已不在 pending 快照里的 permId 从"已决策"记账中摘除
            // （决议已落定、行已消失 → 记账失去对象，留着只会无界增长）
            if (decidedPermIds.size > 0) {
              const live = new Set(rows.map(decidedKey).filter(Boolean));
              for (const k of [...decidedPermIds]) if (!live.has(k)) decidedPermIds.delete(k);
            }
            // v1.11.4：琥珀覆盖集合同步给蓝球孪生去重（琥珀优先）
            try { acpTwinSync(new Set(rows.map((r) => String(r.childId || "")))) } catch { /* 不影响轮询 */ }
            if (rows.length > 0) {
              ball.classList.add("visible");
              count.textContent = rows.length > 99 ? "99+" : String(rows.length);
              if (pop.classList.contains("visible")) renderPop();
            } else {
              ball.classList.remove("visible");
              hidePop();
            }
          })
          .catch(() => {});
      };
      poll();
      const timer = setInterval(poll, 3000);
      return () => {
        clearInterval(timer);
        ball.remove();
        pop.remove();
      };
    }

    // ── v1.11.4：授权双球去重共享状态（琥珀 ACP 优先）──
    // ACP 子代理权限请求在 product-subagents 里走双通道（permissionPending→琥珀球、
    // approval/request→蓝球），同一请求会先后出现在两个授权球上。规则：琥珀球优先——
    // 蓝球上的「ACP 孪生」条目（toolName=product_submit 且 reason 以 [ACP 开头）在琥珀已
    // 覆盖时隐藏（条目仍持有 answerPromise 与 abort 语义，用户点琥珀即生效）；
    // 琥珀消失（未决议）时恢复蓝球兜底显示；非 ACP 审批（如主代理自身提权）不受影响。
    //
    // v1.11.14(B) 两处收紧：
    //   ① hold 表由「每 childId 一条」改为「每 childId 一组」——并发 2 条授权时
    //      第 2 条过去被 `has(twinKey)` 直接挡掉、完全不被跟踪，琥珀一消失它无处可去；
    //   ② 提升前加两道闸（治"点一次黄球、剩下那条从蓝球冒出来"）：
    //      闸①该审批确实未决议；闸②用户没有经琥珀球代答过该 childId（本地记账，
    //      不依赖 abort 帧竞态，即使 A 在服务端有遗漏也不会误提升）。
    const acpTwinHold = new Map()    // sessionKey -> Set<held>
    const acpTwinDecided = new Map() // sessionKey -> 最近一次琥珀球代答时间戳
    let acpTwinLastAmberKeys = new Set()
    let acpTwinBlueOps = null // mountHostApprovalFab 注入 { add, remove }
    const ACP_TWIN_DECIDE_WINDOW_MS = 20000 // 2 个轮询周期 + 决议回传余量
    let acpTwinSeq = 0 // 孪生条目序号（token 用，区分同 childId 的并发请求）
    const nowMs = () => Date.now()

    const acpTwinHolds = (key) => {
      let set = acpTwinHold.get(key)
      if (!set) { set = new Set(); acpTwinHold.set(key, set) }
      return set
    }
    /** 显式摘除一条孪生挂起（不依赖 abort 帧；条目本体由宿主通道自行收尾） */
    const acpTwinDrop = (key, held) => {
      clearTimeout(held.timer)
      if (held.visible && acpTwinBlueOps) acpTwinBlueOps.remove(held.token)
      held.visible = false
      const set = acpTwinHold.get(key)
      if (set) {
        set.delete(held)
        if (set.size === 0) acpTwinHold.delete(key)
      }
    }
    /** 琥珀球代答记账：供提升闸门②判定"这条其实已经被人点过了" */
    const acpTwinMarkDecided = (childId) => {
      const key = String(childId || "")
      if (!key) return
      acpTwinDecided.set(key, nowMs())
    }
    const acpTwinDecidedAt = (key) => {
      const at = acpTwinDecided.get(key)
      if (!at) return 0
      if (nowMs() - at > ACP_TWIN_DECIDE_WINDOW_MS) {
        acpTwinDecided.delete(key)
        return 0
      }
      return at
    }
    const acpTwinPromote = (key, held) => {
      if (!held || held.visible || !acpTwinBlueOps) return
      // 闸①：审批已决议（弹窗/琥珀/abort 任一通道答过）→ 不再回到蓝球
      if (held.item && held.item._settled) { acpTwinDrop(key, held); return }
      // 闸②：琥珀刚替用户答过该 childId，且这条孪生早于那次决策 → 它就是被答过的那条
      const decidedAt = acpTwinDecidedAt(key)
      if (decidedAt && held.createdAt <= decidedAt) { acpTwinDrop(key, held); return }
      held.visible = true
      clearTimeout(held.timer)
      acpTwinBlueOps.add(held)
    }
    const acpTwinSync = (amberKeys) => {
      // 琥珀出现 → 隐藏蓝球上已显示的孪生条目
      for (const [key, set] of acpTwinHold.entries()) {
        if (!amberKeys.has(key)) continue
        for (const held of [...set]) {
          if (held.visible && acpTwinBlueOps) {
            held.visible = false
            acpTwinBlueOps.remove(held.token)
          }
        }
      }
      // 琥珀消失 → 逐条判定：真未决才提升，已决议/已代答的直接摘除
      for (const key of acpTwinLastAmberKeys) {
        if (amberKeys.has(key)) continue
        const set = acpTwinHold.get(key)
        if (!set || set.size === 0) continue
        for (const held of [...set]) acpTwinPromote(key, held)
      }
      acpTwinLastAmberKeys = amberKeys
    }

    // ── v1.10.0：宿主审批浮球（主代理审批请求 4 按钮面板）──
    // 主代理（宿主 ApprovalService）的审批请求，除宿主标准面板「允许一次/拒绝」外，
    // 提供四个按钮：允许一次 / 本会话总是允许该工具 / 总是允许(项目) / 拒绝。
    // 通过 ctx.remote.$on("approval/request") 接收审批请求并呈现。
    function mountHostApprovalFab(clientCtx) {
      if (typeof document === "undefined") return () => {};
      if (document.getElementById("ad-host-approval-fab")) return () => {};

      const remote = (clientCtx && typeof clientCtx.remote !== "undefined") ? clientCtx.remote : null;
      if (!remote || typeof remote.$on !== "function") {
        console.warn("[agent-dispatch] ctx.remote 不可用，宿主审批浮球不挂载");
        return () => {};
      }

      const ball = document.createElement("div");
      ball.id = "ad-host-approval-fab";
      ball.className = "ad-host-approval-fab";
      ball.title = "主代理审批请求——点击查看并处理";
      ball.textContent = "🔐";
      const countEl = document.createElement("span");
      countEl.className = "ha-count";
      ball.appendChild(countEl);
      document.body.appendChild(ball);

      const pop = document.createElement("div");
      pop.className = "ad-host-approval-pop";
      document.body.appendChild(pop);
      // v1.11.15(UI)：内容区独立滚动（同黄球面板），保证长审批内容不把按钮顶出视口
      const popBody = document.createElement("div");
      popBody.className = "ad-ha-body";
      pop.appendChild(popBody);

      // 待处理的审批请求队列（PendingApproval 对象列表）
      const pendingApprovals = [];

      const hidePop = () => pop.classList.remove("visible");
      ball.addEventListener("click", (ev) => {
        ev.stopPropagation();
        pop.classList.toggle("visible");
        renderPop();
      });
      document.addEventListener("click", (e) => {
        if (!pop.contains(e.target) && e.target !== ball) hidePop();
      });

      const renderPop = () => {
        popBody.textContent = "";
        if (pendingApprovals.length === 0) {
          const empty = document.createElement("div");
          empty.className = "ad-ha-empty";
          empty.textContent = "没有待审批的请求";
          popBody.appendChild(empty);
          return;
        }
        for (const item of pendingApprovals) {
          // v1.12.15（用户裁定）：原生通道的高危请求同样是专用形态——这道门命中时服务端
          // 就知道原因（index.js 的危险门把 askReason/dangerRule/dangerSegment 写进暂存
          // 上下文，随 /agent-api/host-approval-context 回传），所以下面四个「记住类」按钮
          // 一个都不该出现：读了档位也读不到这条命令，写了只是留一条永远用不上的规则。
          const danger = dangerAskOf(item);
          if (danger) {
            popBody.appendChild(buildDangerAskRow({
              className: "ad-ha-item",
              meta: item.toolName || "未知工具",
              danger,
              onAllowOnce: async () => { await item.answer("allowed-once"); removeItem(item); },
              onDeny: async () => { await item.answer("rejected"); removeItem(item); },
            }));
            continue;
          }
          const row = document.createElement("div");
          row.className = "ad-ha-item";

          // 工具名
          const tool = document.createElement("div");
          tool.className = "ha-tool";
          tool.textContent = item.toolName || "未知工具";
          row.appendChild(tool);

          // 原因
          if (item.reason) {
            const reason = document.createElement("div");
            reason.className = "ha-reason";
            reason.textContent = item.reason.slice(0, 200);
            row.appendChild(reason);
          }

          // v1.12.6（终审 M3）：门命中 ⇒ 球上就要写明「每次都问、不可记忆」。
          // 用户点「总是允许(会话/项目)」照样写规则，但读取侧那道门排在最前，
          // 这三条命令永远读不到 ⇒ 不写明就是让用户以为已授权、然后反复被问。
          if (item.dangerRule) {
            const danger = document.createElement("div");
            danger.className = "ha-danger";
            danger.textContent = "⚠ 该命令每次都会询问，不可记忆（命中危险命令门：" + item.dangerRule + "）";
            row.appendChild(danger);
          }

          // 路径列表
          if (item.paths && item.paths.length > 0) {
            const paths = document.createElement("div");
            paths.className = "ha-paths";
            paths.textContent = item.paths.join("\n");
            row.appendChild(paths);
          }

          // cwd
          if (item.cwd) {
            const cwd = document.createElement("div");
            cwd.className = "ha-cwd";
            cwd.textContent = "📁 " + item.cwd;
            row.appendChild(cwd);
          }

          // 四按钮
          const actions = document.createElement("div");
          actions.className = "ad-ha-actions";

          const mkBtn = (label, handler, cls, tip) => {
            const b = document.createElement("button");
            b.className = "ad-btn mini " + (cls || "");
            b.textContent = label;
            b.title = tip || "";
            b.addEventListener("click", (ev) => {
              ev.stopPropagation();
              b.disabled = true;
              b.textContent = "处理中…";
              handler().then((r) => {
                // v1.12.6 U2：handler 可以「什么也没做」地结束（弹框被取消）——
                // 这时必须把按钮原样还回去，不能打勾。打勾＝声称已处理，
                // 而转红实验④钉的就是"取消不生效"。
                if (r === "cancelled") { b.disabled = false; b.textContent = label; return; }
                b.textContent = label + " ✓";
              }).catch((e) => {
                console.warn("[agent-dispatch] 审批按钮操作失败:", (e && e.message) || e);
                b.disabled = false;
                b.textContent = label;
              });
            });
            actions.appendChild(b);
            return b;
          };

          // 允许一次
          mkBtn("允许一次", async () => {
            await item.answer("allowed-once");
            removeItem(item);
          }, "", "仅放行本次请求");

          // 本会话总是允许：能不能写、写成哪一档，取决于服务端拿得到什么——
          //   有 callId ⇒ 能反查工具调用记录（路径 + 暂存的根会话 id）；
          //   有 callId 且有 toolName ⇒ 工具名级（该根会话内该工具全路径放行）；
          //   有 callId 无 toolName ⇒ 只能路径级；
          //   无 callId ⇒ 路径解析不出、根会话 id 也确认不了，POST 一律 400、什么都不写
          //（v1.12.1 注释里写的「降级为路径级」并不成立：路径级同样依赖 callId）。
          const canGrant = !!item.callId && !!(item.rootSessionId || item.sessionId);
          const canToolGrant = canGrant && !!item.toolName;
          // v1.12.7（用户裁定「工具档不受越权限制」）：沙箱越权在读取侧**照常消费工具名档**
          // （index.js 的 isDisallowedAutoGrant 已拆开，越权不再算「不得用工具档」）。
          // 所以越权那条按钮与普通请求同档：有工具名就叫「总是允许该工具」，tooltip 也写
          // 「该工具所有路径放行」。
          // v1.12.14：**会话档**按钮仍然只到本会话、不落盘；而**项目档**按钮不再受越权抑制
          // （用户显式点项目档 ⇒ 照落盘：勾了目录写路径档，空声明写工具档）——两条的
          // tooltip 与二级弹框红字分别如实说明，别再写成同一句。
          // 改前（v1.12.6）这里写的是 `&& !escalation`——那是按已失效的语义下的判断，
          // 留着就会在按钮上写「(路径)」、在 tooltip 里说「工具名档对本条不生效」＝面板说谎。
          const escalation = isEscalationReason(item.reason);
          const toolTierApplies = canToolGrant;
          const sessionLabel = canToolGrant ? "本会话总是允许该工具"
            : canGrant ? "本会话总是允许(路径)" : "仅放行本次";
          /**
           * v1.12.6 U2/U4：宿主审批通道的「记住类」按钮——先弹可编辑目录，
           * 确认后才 POST（带上用户**勾选后**的 paths），取消 ⇒ 不发请求、不放行。
           * U4 分组来源：服务端把路径拆成两档给（`structuredPaths`=路径类字段的值，
           * 也就是这次真正要操作的对象；`inferredPaths`=`PATH_RE` 从参数里**所有字符串**
           * 扫出来的路径，含 `content`/`new_string` 这类**正文**）。正文里可以随便写
           * `/etc/passwd`、`~/.ssh`，所以第二档默认不勾选。
           * `structuredPaths` 缺席（老载荷/异常载荷）时整份 `paths` 进第一组：没有来源
           * 信息就没法断言哪条是"文本推测"，猜错的方向必须是"照常预填"，不能猜成不选。
           * @param {'session'|'project'} scope
           */
          const grantViaDialog = (scope) => async () => {
            // v1.12.6 第五轮（用户裁定）：非绝对路径先按本请求的工作区目录 `item.cwd`
            // 拼成绝对路径再进编辑框（`./x.txt` + cwd=/proj ⇒ /proj/x.txt ⇒ 再按既有
            // 文件形态规则取父目录 /proj）。拼不出来（无 cwd）⇒ 原样进框，但弹框会
            // **强制不勾选**并就地提示——那条链路（默认勾选 + 服务端丢弃 ⇒ 静默变工具档）
            // 就是终审 M-B，已在服务端另加 400 兜底。
            // v1.12.7：`~/.ssh/id_rsa` 这类候选按服务端下发的 `item.home` 展开成绝对路径
            // （前端拿不到 os/process.env），展开成功后该行**恢复默认勾选**（note 为空 ⇒
            // mkRow 的 `checked && !note` 不再强制关掉）；拿不到 home 时保持旧行为。
            const d = await openGrantDialog({
              title: "确认要记住的目录",
              toolName: item.toolName,
              suggestedDirs: dirsOfPaths(Array.isArray(item.structuredPaths) ? item.structuredPaths : item.paths, item.cwd, item.home),
              inferredDirs: dirsOfPaths(item.inferredPaths, item.cwd, item.home),
              cwd: item.cwd || null,
              home: item.home || null,
              projectTier: scope === "project",
              escalation,
              // v1.12.6（终审 M3）：门命中的命令不可记忆，弹框里也要说清
              dangerRule: item.dangerRule || null,
              // v1.12.7：宿主通道的服务端原本只按 rootSessionId 记内存工具档 ⇒ 二级选择的
              // 「任意路径」那一档永远是会话级。
              // v1.12.14（缺口修复）：**项目档**这一支现在真的落盘工具档（服务端
              // appendProjectToolRule 写共用 allowlist.json：{cwd, product, paths:[],
              // tools:['main:<工具>']}）⇒ 同工作目录跨会话/重载宿主后仍免弹。
              // 「本会话总是允许该工具」那一支保持会话级（不落盘），文案随之分流。
              toolTierDisk: scope === "project",
            });
            if (!d) return "cancelled";
            // v1.12.7（用户裁定）：二级选择里的「仅本次放行」⇒ **一条规则都不写**。
            // 这里是「不发 POST」而不是「POST 一个空声明」——空声明（paths: []）在服务端
            // 的语义恰好是「只写工具名档」，正是用户明确否掉的那一档。
            if (d.mode === "once") {
              await item.answer("allowed-once");
              removeItem(item);
              return "allowed-once";
            }
            // 「该工具对任意路径都将放行」⇒ 显式空数组 + 工具名 ⇒ 服务端进工具档。
            // 注意 toolName 这时**也必须**带上（改前只在 scope==='session' 时带）：
            // 服务端的工具档写入以 toolName 为唯一键，缺了它只会 400 什么都不写。
            const toolTier = d.mode === "tools";
            const payload = {
              scope,
              sessionId: scope === "session" ? (item.rootSessionId || item.sessionId) : item.sessionId,
              callId: item.callId,
              paths: d.paths,
            };
            if (item.toolName && (scope === "session" || toolTier)) payload.toolName = item.toolName;
            if (scope === "project") payload.cwd = item.cwd;
            try {
              await apiPost("/agent-api/host-approval-rule", payload);
            } catch (e) {
              console.warn("[agent-dispatch] 写授权规则失败（仍放行本次）:", (e && e.message) || e);
            }
            await item.answer("allowed-once");
            removeItem(item);
          };
          // 无 callId 时**不弹框**（服务端反查不到审批上下文 ⇒ 带 paths 的声明一律 400，
          // 见 index.js 的 useDeclared && !approvalCtx 门）。这一条沿用 1.12.5 的 POST
          // 原样：不弹框、不改载荷，行为逐字不变（不变量⑦要求非越权路径零漂移）。
          const legacySessionPost = async () => {
            try {
              await apiPost("/agent-api/host-approval-rule", {
                scope: "session",
                sessionId: item.rootSessionId || item.sessionId,
                callId: item.callId,
                toolName: item.toolName || undefined,
              });
            } catch (e) {
              console.warn("[agent-dispatch] 写会话授权失败（仍放行本次）:", (e && e.message) || e);
            }
            await item.answer("allowed-once");
            removeItem(item);
          };
          const legacyProjectPost = async () => {
            try {
              await apiPost("/agent-api/host-approval-rule", {
                scope: "project",
                sessionId: item.sessionId,
                callId: item.callId,
                cwd: item.cwd,
              });
            } catch (e) {
              console.warn("[agent-dispatch] 写项目规则失败（仍放行本次）:", (e && e.message) || e);
            }
            await item.answer("allowed-once");
            removeItem(item);
          };
          mkBtn(sessionLabel, canGrant ? grantViaDialog("session") : legacySessionPost, "", toolTierApplies
            ? "先确认要记住的目录（目录级，只到本会话，不落盘）；一条都不勾（或全删空、留下的都不是绝对路径）⇒ 点「确认」会再让你选一次：「仅本次放行」（什么都不写）还是「该工具对任意路径都将放行」。后者："
              + "本次会话内该工具的所有路径请求自动放行（含工作区外），**不落盘**（换会话仍会询问）；"
              + "危险命令（rm -rf / git push / npm publish）仍会每次询问"
              + (escalation ? "。沙箱越权不写落盘白名单（换会话仍会询问）" : "")
            : escalation
              // v1.12.7：这里只剩「越权 + 解析不出工具名」——工具名档对它无从谈起
              // （不是「不生效」，是压根没有键可记）。tooltip 必须照这个说。
              ? "沙箱越权：本条解析不出工具名 ⇒ 只把你在弹框里确认的目录写入本会话路径规则（目录级，不落盘，换会话仍会询问）"
              : canGrant
                ? "缺少工具名：只把你在弹框里确认的目录写入本会话路径规则（目录级，不落盘）"
                : "缺少 callId：不弹目录确认框，沿用服务端自动分析——通常解析不出路径 ⇒ POST 返回 400、不写规则（仅本次放行）");

          // 总是允许(项目)
          mkBtn("总是允许(项目)", canGrant ? grantViaDialog("project") : legacyProjectPost, "", canGrant
            ? (escalation
              ? "沙箱越权 + 本项目档：确认后的目录**照常落盘**到共用白名单（v1.12.14：用户显式点项目档不再因越权降级），同工作目录跨会话生效；"
                + "一条都不勾（或全删空、留下的都不是绝对路径）⇒ 点「确认」会再让你选「仅本次放行」还是「落盘工具放行任意路径」"
                + "（后者落盘一条工具档：本项目内该工具任意路径放行，含工作区外，重载宿主后仍生效；危险命令仍每次询问）"
              : "先确认要记住的目录，落盘到共用白名单，同工作目录跨会话生效（条目 = 工作目录 + 目录）；"
                + "一条都不勾（或全删空、留下的都不是绝对路径）⇒ 点「确认」会再让你选「仅本次放行」还是「落盘工具放行任意路径」"
                + "（后者落盘一条工具档：本项目内该工具任意路径放行，含工作区外，重载宿主后仍生效；危险命令仍每次询问）")
            : "缺少 callId：服务端解析不出路径，点击后返回 400 且不写入任何规则（仅本次放行）");

          // 拒绝
          mkBtn("拒绝", async () => {
            await item.answer("rejected");
            removeItem(item);
          }, "danger", "拒绝本次请求");

          row.appendChild(actions);
          popBody.appendChild(row);
        }
      };

      const removeItem = (item) => {
        const idx = pendingApprovals.indexOf(item);
        if (idx >= 0) pendingApprovals.splice(idx, 1);
        updateBall();
        if (pop.classList.contains("visible")) renderPop();
      };

      const updateBall = () => {
        if (pendingApprovals.length > 0) {
          ball.classList.add("visible");
          countEl.textContent = pendingApprovals.length > 99 ? "99+" : String(pendingApprovals.length);
        } else {
          ball.classList.remove("visible");
          hidePop();
        }
      };

      // v1.11.4：琥珀球经 acpTwinSync 调用的蓝球条目操作（隐藏/恢复）
      // v1.11.14(B)：改为按 held/token 定位——同一 childId 可以有多条并发孪生，
      // 用 key 做删除会把不属于本次操作的那条误删。
      acpTwinBlueOps = {
        add(held) {
          const item = held && held.item
          if (!item || pendingApprovals.includes(item)) return;
          pendingApprovals.push(item);
          updateBall();
          if (pop.classList.contains("visible")) renderPop();
        },
        remove(token) {
          const idx = pendingApprovals.findIndex((i) => i._twinToken === token);
          if (idx >= 0) pendingApprovals.splice(idx, 1);
          updateBall();
          if (pop.classList.contains("visible")) renderPop();
        },
      };

      // 注册 ctx.remote.$on("approval/request") 监听器
      // 宿主审批请求通过 api-remotes 转发到客户端，与 dsh-client-ui-approval 同源。
      // 客户端多监听器串行链——先答者胜，未答方收 cancel。
      // 本监听器收到请求后暂不 answer（委托给宿主标准面板兜底），
      // 而是展示在浮球供用户点选；用户点按钮后才 answer。
      // 若用户不点，宿主标准 ApprovalPanel 仍会显示并兜底。
      let disposeRemote = () => {};
      try {
        disposeRemote = remote.$on("approval/request", function(request, next) {
          // request: { toolName, callId?, reason?, signal? }
          // this = agent scope owner（用于 answerApproval 的 scopeOf）
          const sessionId = (clientCtx && clientCtx.sessions && typeof clientCtx.sessions.scopeOf === "function")
            ? clientCtx.sessions.scopeOf(this) : null;

          // 获取审批上下文（路径等）——从服务端 REST 获取
          const callId = request.callId;
          let item = {
            toolName: request.toolName || null,
            callId: callId || null,
            reason: request.reason || null,
            sessionId: sessionId || null,
            rootSessionId: null,
            paths: [],
            cwd: null,
            // v1.12.7：`~` 展开基准，由 /agent-api/host-approval-context 下发
            // （前端不能 require('os')、也拿不到 process.env.HOME）；拿不到 ⇒ null
            home: null,
            answer: null,
          };

          // 构建 answer 方法——PendingApproval 风格
          // 但我们不走 PendingApproval 类（那是 ui-approval 内部的），
          // 而是直接通过 remote event 的 result 机制返回。
          // remote.$on 的 callback 返回值即 waterfall result。
          // 但我们不想立即返回——要等用户点击。
          // 方案：不返回值（返回 undefined），这样 waterfall 会等待——
          // 不对，waterfall 不等待 undefined，它会继续 next()。
          // 正确做法：返回一个 Promise，等用户点击后 resolve。
          let resolveAnswer;
          const answerPromise = new Promise((resolve) => { resolveAnswer = resolve; });
          item.answer = (outcome) => {
            item._settled = true; // v1.11.14(B)：闸门①依据——已决议的孪生不得再回到蓝球
            resolveAnswer(outcome);
            return Promise.resolve();
          };
          item._settled = false;

          // v1.11.4：ACP 孪生（子代理权限请求的宿主审批通道）→ 琥珀优先：登记隐藏挂起，
          // 不渲染蓝球条目（仍返回 answerPromise 持有 waterfall；abort 时清理）。
          // v1.11.14(B)：同 childId 的并发孪生各自成一条 held（旧实现用
          // `if (!acpTwinHold.has(twinKey))` 把第 2 条挡在跟踪之外，那条请求
          // 从此既不在琥珀也不在蓝球的托管里）。
          const isAcpTwin = request.toolName === "product_submit" &&
            typeof request.reason === "string" && request.reason.startsWith("[ACP ");
          if (isAcpTwin && sessionId) {
            const twinKey = String(sessionId);
            const token = twinKey + "#" + (++acpTwinSeq);
            const set = acpTwinHolds(twinKey);
            const held = {
              item, visible: false, timer: null, token,
              createdAt: Date.now(),
            };
            item._twinKey = twinKey;
            item._twinToken = token;
            held.timer = setTimeout(() => {
              // 琥珀 6s（2 个轮询周期）内未覆盖 → 蓝球兜底显示，避免请求丢失
              if (!acpTwinLastAmberKeys.has(twinKey)) acpTwinPromote(twinKey, held);
            }, 6000);
            set.add(held); // 先入表再挂 abort：否则"到达即已 abort"分支会摘一个不在表里的 held
            const detach = () => { clearTimeout(held.timer); acpTwinDrop(twinKey, held); };
            if (request.signal) {
              const onAbort = () => {
                detach();
                item._settled = true;
                resolveAnswer("cancelled");
              };
              request.signal.addEventListener("abort", onAbort, { once: true });
              if (request.signal.aborted) onAbort();
            }
            return answerPromise;
          }
          item._twinKey = null;
          pendingApprovals.push(item);
          updateBall();
          if (pop.classList.contains("visible")) renderPop();

          // 异步获取路径上下文
          if (callId) {
            apiGet("/agent-api/host-approval-context?callId=" + encodeURIComponent(callId) + "&sessionId=" + encodeURIComponent(sessionId || ""))
              .then((d) => {
                if (d && d.ok) {
                  item.paths = d.paths || [];
                  // v1.12.6 U4：服务端已把路径按来源分两档给（结构化 / 文本推测）。
                  // 这两个字段只影响**预填与默认勾选状态**，不参与任何自动判定。
                  item.structuredPaths = Array.isArray(d.structuredPaths) ? d.structuredPaths : null;
                  item.inferredPaths = Array.isArray(d.inferredPaths) ? d.inferredPaths : null;
                  item.cwd = d.cwd || null;
                  // v1.12.7：`~` 展开基准（服务端 os.homedir()）——缺了它，预填里
                  // `~/.ssh/id_rsa` 这类候选只能原样保留 + 强制不勾选（旧行为）。
                  item.home = typeof d.home === "string" && d.home.trim() ? d.home.trim() : null;
                  item.toolName = item.toolName || d.toolName || null;
                  item.reason = item.reason || d.reason || null;
                  item.rootSessionId = d.rootSessionId || null;
                  // v1.12.6（终审 M3）：危险命令门命中的请求由服务端带上门名 ⇒
                  // 球上/弹框里必须照实说「每次都会询问，不可记忆」。
                  item.dangerRule = d.dangerRule || null;
                  // v1.12.15（用户裁定）：归因 + **命中片段** + 命令正文（本就在上下文里）。
                  // 这三个字段只喂高危专用弹框的渲染，不参与任何档位判定。
                  item.askReason = d.askReason || null;
                  item.dangerSegment = d.dangerSegment || null;
                  item.commandText = typeof d.commandText === "string" ? d.commandText : "";
                  item.argsText = typeof d.argsText === "string" ? d.argsText : "";
                  if (pop.classList.contains("visible")) renderPop();
                }
              })
              .catch((e) => {
                console.warn("[agent-dispatch] 获取审批上下文失败（拿不到路径与根会话 id，授权按钮点击后服务端返回 400）:", (e && e.message) || e);
              });
          } else if (!isAcpTwin) {
            // v1.12.4：文案按服务端真实语义改写——无 callId ⇒ 反查不到工具调用记录
            // ⇒ 既解析不出路径也确认不了根会话 id ⇒ POST 返回 400、什么都不写
            // （不是「降级为路径级」：路径级同样依赖 callId）。
            // 且只对**渲染了按钮的条目**提示：ACP 孪生走上面的提前 return，
            // 本来就不渲染本插件的按钮，不该为它刷一条降级警告。
            console.warn("[agent-dispatch] 审批请求缺少 callId：无法反查工具调用记录，「本会话总是允许」与「总是允许(项目)」点击后返回 400 且不写入任何规则（仅本次放行）");
          }

          // 返回 answerPromise——waterfall 等待用户决策
          // 如果 signal 被 abort（审批取消），reject 该 promise
          if (request.signal) {
            const onAbort = () => {
              removeItem(item);
              resolveAnswer("cancelled");
            };
            request.signal.addEventListener("abort", onAbort, { once: true });
            if (request.signal.aborted) onAbort();
          }
          return answerPromise;
        });
      } catch (e) {
        console.warn("[agent-dispatch] ctx.remote.$on('approval/request') 注册失败:", (e && e.message) || e);
      }

      return () => {
        disposeRemote();
        acpTwinBlueOps = null;
        for (const set of acpTwinHold.values()) for (const held of set) clearTimeout(held.timer);
        acpTwinHold.clear();
        acpTwinDecided.clear();
        ball.remove();
        pop.remove();
      };
    }

    module.exports = {
      name: "@kiligzzz/dsh-agent-dispatch",
      // 0.1.2+ 兼容：客户端服务需在 bundle 内声明 inject（exports.inject，服务名列表）。
      // slots 为 hardDependency，缺失时 loader 抛 "cannot get property slots without inject"。
      // v1.8.4：+sessions——会话跳转（openSubagent/open）依赖 ctx.get("sessions")，
      // 未 inject 时 get 返回 undefined → 跳转静默失效（"前往授权"无反应根因）。
      inject: ["slots", "locale", "sessions", "remote"],
      apply(ctx) {
        // 0.1.2+ 兼容：官方 slots 服务改为 hardDependency 形态（ctx.slots + inject 声明）。
        // ctx.get("slots") 在 0.1.2 的 fiber 时序下返回 undefined → 整个 client 半静默退出
        // （面板/返回按钮/悬浮球/Agent 菜单全挂，host 半不受影响）。
        const slots = ctx.slots;
        if (!slots) return;
        // 会话跳转：宿主 0.1.7 起导航在 uiWorkspace、sessions 只管 catalog/引用计数
        // （旧路径 sessions.open/openSubagent 已下线）；sessions 仍用于 subagentAddress。
        const sessions = ctx.get("sessions");
        // v0.9.32：childId 归一化——历史/续聊存字符串，运行中条目可能携带对象
        // （startContinuable 返回形态因宿主版本而异：{childId,messageId} 或 {runId,provider,id}）；
        // 统一取字符串 id 再交给 sessions.open，避免类型错误炸掉整个面板。
        const normalizeChildId = (id) => {
          if (id == null) return null;
          if (typeof id === "string") return id;
          if (typeof id === "object") {
            const s = id.id || id.childId || id.runId;
            if (typeof s === "string") return s;
          }
          return null;
        };
        openAgentSession = (id, parentSessionId) => {
          const target = normalizeChildId(id);
          if (!target) { console.warn("[agent-dispatch] openAgentSession: 无法归一化 childId:", id); return Promise.resolve(false); }
          const pid = normalizeChildId(parentSessionId);
          const from = captureCurrentSessionTitle();
          const afterOpen = () => { if (from) navPush(from); ensureChatView(); };
          // v1.11.14(m8)：该会话是否已被主视图持有。宿主 uiWorkspace.openSession →
          // replaceMain → sessions.retain(target,{source:"mainView"}) 是**同步**的
          // （dsh-client-ui-workspace/lib/client.js:1019），真打开了就能在
          // retainInfo 快照里看到 mainView>0。true=已核实 / false=没打开 /
          // null=无从判断（老宿主没有 retainInfo，退回"当作成功"）。
          const mainViewRetained = (sid) => {
            if (!sessions || typeof sessions.retainInfo !== "function") return null;
            try {
              const snap = sessions.retainInfo(sid);
              const info = snap && typeof snap.getSnapshot === "function" ? snap.getSnapshot() : null;
              const n = (info && info.retainedBy && info.retainedBy.mainView) || 0;
              return n > 0;
            } catch (e) { return null; }
          };
          // v1.11.14(E)：主通道改用宿主现行导航 API。dsh 0.1.7 起 sessions 明确
          // 不再负责导航（dsh-api-session-controller ISessions 对 list 的注释原文
          // "Host catalog and local reference-source counts; navigation belongs to
          // view owners."），下列三个方法在宿主包里已**全部消失**（全包 grep 零
          // 命中）：sessions.open / sessions.openSubagent / sessions.refreshSubagents
          // → 旧实现三条路都取不到函数，黄球/主 FAB 的点击跳转必然失败。
          // 现行入口是 uiWorkspace.openSession(SessionTarget)，
          //   SessionTarget = sessionId | {parentSessionId, childSessionId, mode}
          // （宿主 dsh-client-ui-subagent / agent-team 打开子代理会话正是该地址形态，
          //  mode 取 'continuable'——本插件子代理均为 continuable）。
          // uiWorkspace 不进 inject：用 softService 双路软取，老宿主拿不到就退回旧通道。
          const uiWorkspace = softService(ctx, "uiWorkspace");
          // v1.11.14(m8)：新通道是否真的调用成功过（没抛错）。旧宿主兜底也失败时，
          // 用它把结果分成 true / 'unverified' / false 三态。
          let attempted = false;
          if (uiWorkspace && typeof uiWorkspace.openSession === "function") {
            let addr = null;
            try {
              addr = sessions && typeof sessions.subagentAddress === "function" ? (sessions.subagentAddress(target) || null) : null;
            } catch (e) { addr = null; }
            const nav = addr || (pid ? { parentSessionId: pid, childSessionId: target, mode: "continuable" } : target);
            for (const t of (nav === target ? [target] : [nav, target])) {
              try {
                uiWorkspace.openSession(t);
                attempted = true; // 导航已发生：afterOpen 出错也不得把这行判成"没试过"
                afterOpen();
                // v1.11.14(m8)："没抛错"不等于打开了。核实到 mainView 持有才算成功；
                // 核实不到就先试下一种地址形态，都不成立再走旧宿主兜底。
                // 老宿主没有 retainInfo（无从判断，返回 null）→ 退回 true。
                if (mainViewRetained(target) !== false) return true;
              } catch (e) {
                console.warn(`[agent-dispatch] openAgentSession: uiWorkspace.openSession(${typeof t === "string" ? "id" : "address"}) 失败`, (e && e.message) || e);
              }
            }
            // 新通道失败不静默：继续往下走旧宿主兜底
          }
          if (!sessions) {
            console.warn("[agent-dispatch] openAgentSession: uiWorkspace 与 sessions 服务均不可用")
            return Promise.resolve(attempted ? "unverified" : false)
          }
          // v1.8.3（旧宿主兜底）：子代理会话打开须满足宿主 catalog 前置——
          //   1) sessions.open 只对普通会话有效（子代理抛 unknown session）；
          //   2) sessions.openSubagent 要求 child 已是 catalog 中 healthy child：
          //      catalog 须先经 refreshSubagents(parentSessionId) 加载，且 address 需带
          //      mode:'continuable'。
          // 故：refresh（await）→ openSubagent(mode:'continuable') → 失败才回退 open。
          const openViaSubagent = async () => {
            if (typeof sessions.openSubagent !== "function") return false;
            if (!pid) return false; // 无父级地址无法走 catalog（此时子代理会话应不可达）
            if (typeof sessions.refreshSubagents === "function") {
              try {
                const p = sessions.refreshSubagents(pid);
                if (p && typeof p.then === "function") await p;
              } catch (e) {
                console.warn("[agent-dispatch] openAgentSession: refreshSubagents 失败", (e && e.message) || e);
              }
            }
            try {
              sessions.openSubagent({ parentSessionId: pid, childSessionId: target, mode: "continuable" });
              return true;
            } catch (e) {
              console.warn("[agent-dispatch] openAgentSession: openSubagent 失败，回退 sessions.open", (e && e.message) || e);
              return false;
            }
          };
          const fallbackOpen = () => {
            if (typeof sessions.open !== "function") { console.warn("[agent-dispatch] openAgentSession: sessions.open 不可用"); return false; }
            try { sessions.open(target); } catch (e) {
              console.warn("[agent-dispatch] openAgentSession: sessions.open 失败", target, (e && e.message) || e);
              return false;
            }
            afterOpen();
            return true;
          };
          // v1.11.14(m8)：新通道调用过、旧通道也救不回来 → 'unverified'（区别于
          // "从没成功调用过任何导航 API"的 false），黄球保留浮层并给"未确认"文案
          return Promise.resolve(openViaSubagent()).then((ok) => ok || fallbackOpen())
            .then((ok) => (ok === true ? true : attempted ? "unverified" : false));
        };
        // v0.9.27：返回——弹栈顶标题 → 侧边栏直点；点不到走 sessions.search 兜底
        goBackHandler = () => {
          const title = navPopTitle();
          if (!title) return;
          const clickByTitle = (t) => {
            try {
              const rows = document.querySelectorAll('div[role="treeitem"]');
              for (const r of rows) {
                const te = r.querySelector('[class*="title"]');
                const txt = ((te && te.textContent) || r.textContent || "").trim();
                if (txt === t && r.offsetParent !== null) { r.click(); return true; }
              }
            } catch (e) {}
            return false;
          };
          if (clickByTitle(title)) return;
          // 兜底：目标行未渲染（折叠/未展开分组）→ 搜索拿 id 再 open（search 返回已解包 {items,hasMore} 或错误对象）
          if (sessions && typeof sessions.search === "function") {
            const ac = new AbortController();
            Promise.resolve(sessions.search(title, ac.signal)).then((res) => {
              const items = (res && res.items) || [];
              const hit = items.find((it) => (it.title || "") === title) || items[0];
              if (hit && hit.id) {
                // v1.11.14(E)：sessions.open 在新宿主（0.1.7+）已随导航职责一并下线，
                // 优先用现行 uiWorkspace.openSession；两者都没有才静默放弃。
                try {
                  const ws = softService(ctx, "uiWorkspace");
                  if (ws && typeof ws.openSession === "function") ws.openSession(hit.id);
                  else if (sessions && typeof sessions.open === "function") sessions.open(hit.id);
                } catch (e) {}
              }
            }).catch(() => {});
            setTimeout(() => { try { ac.abort(); } catch (e) {} }, 4000);
          }
        };
        // v0.8.4：打开「Agent 调度」面板——宿主 view ring 用 only:<active id> 渲染，
        // 无公开切换 API，用 DOM 兜底：找会话头部文本为「Agent 调度」的 tab 按钮点击。
        {
          const tryClick = () => {
            try {
              const btns = document.querySelectorAll("button, [role=tab]");
              for (const b of btns) {
                const t = (b.textContent || "").replace(/\s+/g, " ").trim();
                if (t === "Agent 调度" && b.offsetParent !== null) { b.click(); return true; }
              }
            } catch (e) {}
            return false;
          };
          // 面板 tab 可能尚未渲染（无会话打开时不存在）→ 尝试 + 延迟重试
          openAgentPanel = () => {
            if (tryClick()) return;
            setTimeout(tryClick, 300);
            setTimeout(tryClick, 900);
          };
        }
        // ① 主面板：宿主原生右 tab（conversation.view 槽，与 对话/轨迹/记忆系统 同级）
        slots.inject("conversation.view", () => {
          slots.register({
            name: "conversation.view",
            id: "agent-dispatch",
            order: 21,
            label: () => "Agent 调度",
            inject: () => ({}),
          }, AgentPanel);
        });
        // v0.9.36：Settings 分区（settings.section 槽）已删除——设置页整体移除，
        // 默认模型/数据目录/触发方式 + 悬浮球总开关已迁入主面板「总览」子页顶部
        // ②b v0.9.28：会话头部「← 返回」——挂 conversation.session.header.actions（任何 tab 下可见，
        // 一跳返回跳转前的会话，不必先切到 Agent 调度页再点返回；导航栈空时不渲染）
        slots.inject("conversation.session.header.actions", () => {
          slots.register(
            { name: "conversation.session.header.actions", id: "agent-dispatch-back", order: 10, label: () => "返回" },
            () => React.createElement(HeaderBackButton),
          );
        });
        // ③ 悬浮活动按钮（原生 DOM，不依赖任何槽）
        if (typeof ctx.effect === "function") {
          ctx.effect(() => mountAgentFab(ctx), "agent-dispatch: activity fab");
        } else {
          mountAgentFab(ctx);
        }
        // ③.1 v1.8.0：独立「待授权」悬浮球（有 ACP 权限请求待批时按需出现）
        if (typeof ctx.effect === "function") {
          ctx.effect(() => mountPermFab(), "agent-dispatch: permission fab");
        } else {
          mountPermFab();
        }
        // ③.2 v1.10.0：宿主审批浮球（主代理审批请求 4 按钮）
        if (typeof ctx.effect === "function") {
          ctx.effect(() => mountHostApprovalFab(ctx), "agent-dispatch: host approval fab");
        } else {
          mountHostApprovalFab(ctx);
        }
        // ④ Agent 直选菜单：宿主 inputTriggers 服务（与斜杠命令同源的官方输入触发机制）。
        //    宿主 detectTrigger 只识别 '@' 与 '/' 两种触发符（'$' 等任意字符注册了也不会被扫描），
        //    因此挂 '/' 组：输入 / 弹候选菜单（命令组之后多一个 "Agent" 组），
        //    选中后把 "$id " 以纯文本插回输入框，用户补任务描述直接发送——
        //    模型按调度策略第 8 条把 $id 识别为指定 Agent 委派。
        //    可选服务：宿主未启用（老版本）时静默跳过，不影响其他功能。
        const inputTriggers = ctx.get("inputTriggers");
        if (inputTriggers && typeof inputTriggers.registerSource === "function") {
          if (typeof ctx.effect === "function") {
            ctx.effect(() => inputTriggers.registerSource({
              trigger: "/",
              order: 10,
              name: "agent",
              candidates: async (session, req) => {
                const q = String((req && req.query) || "").toLowerCase();
                try {
                  const d = await apiGet("/agent-api/suggest?q=" + encodeURIComponent(q));
                  if (!d.ok) return [];
                  const rows = [];
                  for (const a of d.agents || []) {
                    rows.push({ name: a.id, description: (a.emoji ? a.emoji + " " : "") + (a.name || a.id) + (a.desc ? " · " + a.desc : "") });
                  }
                  for (const s of d.squads || []) {
                    rows.push({ name: s.id, description: (s.emoji ? s.emoji + " " : "") + (s.name || s.id) + " · 小队: " + (s.desc || "") });
                  }
                  return rows;
                } catch (e) {
                  return [];
                }
              },
              onPick: (pick) => {
                // 纯文本插入 "$id " 并继续编辑（outcome {text, continue:true} 是宿主支持的形态）
                const id = pick && pick.candidate && pick.candidate.name;
                if (!id) return void 0;
                return { text: "$" + id + " ", continue: true };
              },
            }), "agent-dispatch: $ trigger source");
          }
        }
      },
    };
    return module.exports;
  },
});
