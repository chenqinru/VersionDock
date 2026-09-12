/**
 * VersionDock Unified Layout Density & Floating Hover Design System.
 * Injected at webview root and controlled via [data-density="comfortable" | "compact"].
 */
export const GLOBAL_DENSITY_STYLES = `
/* ==========================================================================
   VersionDock Global Density & Floating Hover System
   ========================================================================== */

/* ── 1. 舒适模式（Comfortable Mode） ── */

/* 列表行项、树节点、提交项统一应用内缩与圆角高亮 */
[data-density="comfortable"] [data-speed-search-key],
[data-density="comfortable"] [data-commit-row],
[data-density="comfortable"] [data-list-row],
[data-density="comfortable"] .versiondock-file-row,
[data-density="comfortable"] .versiondock-tree-dir {
  margin-left: 6px !important;
  margin-right: 6px !important;
  border-radius: 5px !important;
  width: auto !important;
  box-sizing: border-box !important;
  transition: background 0.12s ease, color 0.12s ease !important;
}

/* 舒适模式下每条数据条目行保持内缩下分割线进行分割（左右各留出6px间距，不占满，与标题栏及悬浮行对齐） */
[data-density="comfortable"] [data-row-divider],
[data-density="comfortable"] .versiondock-card {
  position: relative !important;
  border-bottom: none !important;
  margin: 0 !important;
  border-radius: 0 !important;
  overflow: hidden !important;
  box-sizing: border-box !important;
}

[data-density="comfortable"] [data-row-divider]::after,
[data-density="comfortable"] .versiondock-card::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 0;
  height: 1px;
  background: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  opacity: 0.85;
  pointer-events: none;
  z-index: 2;
}

/* Git Log 绝对定位虚拟提交行：避开泳道，浮动高亮 */
[data-density="comfortable"] .versiondock-commit-row {
  left: 4px !important;
  right: 4px !important;
  border-radius: 5px !important;
  transition: background 0.12s ease, color 0.12s ease !important;
}

/* 侧边栏整体、吸顶顶栏、搜索框、折叠分组与列表项统一拦截（Sidebar & Inner Elements） */
[data-density="comfortable"] .versiondock-branch-sidebar {
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 8px !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
}

[data-density="comfortable"] .versiondock-sidebar-sticky-header {
  position: sticky !important;
  top: 0 !important;
  z-index: 10 !important;
  border-top-left-radius: 7px !important;
  border-top-right-radius: 7px !important;
  background: var(--vscode-sideBar-background) !important;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2)) !important;
}

[data-density="comfortable"] .versiondock-sidebar-search {
  height: auto !important;
  padding: 5px 6px 1px 6px !important;
  border-bottom: none !important;
  gap: 4px !important;
  display: flex !important;
  align-items: center !important;
}

[data-density="comfortable"] .versiondock-sidebar-search-input-wrap {
  border-radius: 6px !important;
  height: 26px !important;
  border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.25)) !important;
  background: var(--vscode-input-background) !important;
  box-sizing: border-box !important;
  padding-left: 7px !important;
}

[data-density="comfortable"] .versiondock-sidebar-collapse-btn {
  border-left: none !important;
  border-radius: 6px !important;
  height: 26px !important;
  width: 26px !important;
  padding: 0 !important;
  box-sizing: border-box !important;
  display: flex !important;
  align-items: center !important;
  justify-content: center !important;
}

[data-density="comfortable"] .versiondock-sidebar-collapse-btn:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)) !important;
}

[data-density="comfortable"] .versiondock-sidebar-repo-list {
  padding: 0 0 3px 0 !important;
  border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2)) !important;
}

[data-density="comfortable"] .versiondock-sidebar-section-header {
  margin: 3px 6px 1px 6px !important;
  border-radius: 4px !important;
  border-bottom: none !important;
  padding: 2px 8px !important;
  min-height: 23px !important;
  background: color-mix(in srgb, var(--vscode-foreground) 4%, transparent) !important;
  transition: background 0.12s ease !important;
  box-sizing: border-box !important;
}

[data-density="comfortable"] .versiondock-sidebar-section-header:hover {
  background: color-mix(in srgb, var(--vscode-foreground) 9%, transparent) !important;
}

[data-density="comfortable"] .versiondock-sidebar-row {
  margin: 1px 6px !important;
  border-radius: 4px !important;
  min-height: 22px !important;
  padding-top: 1px !important;
  padding-bottom: 1px !important;
  padding-left: 10px !important;
  padding-right: 6px !important;
  box-sizing: border-box !important;
  transition: background 0.12s ease, color 0.12s ease !important;
}

[data-density="comfortable"] .versiondock-sidebar-repo-row {
  min-height: 22px !important;
  margin: 1px 6px !important;
  border-radius: 4px !important;
  padding: 1px 6px !important;
}

/* 舒适模式下 HEAD 当前分支圆角药丸指示器（替代直角 borderLeft） */
[data-density="comfortable"] .versiondock-sidebar-row[data-is-head="true"] {
  border-left: none !important;
  position: relative !important;
}

[data-density="comfortable"] .versiondock-sidebar-row[data-is-head="true"]::before {
  content: '';
  position: absolute;
  left: 3px;
  top: 4px;
  bottom: 4px;
  width: 3px;
  border-radius: 2px;
  background: var(--vscode-textLink-foreground);
}

[data-density="comfortable"] .versiondock-head-badge {
  border-radius: 3px !important;
}

[data-density="comfortable"] .versiondock-card-header {
  border-radius: 5px !important;
  transition: background 0.12s ease !important;
}

[data-density="comfortable"] .versiondock-card-body {
  border-radius: 0 !important;
  border-top: none !important;
  position: relative !important;
}

[data-density="comfortable"] .versiondock-card-body::before {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  top: 0;
  height: 1px;
  background: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  opacity: 0.85;
  pointer-events: none;
  z-index: 2;
}

/* 通用：标题栏操作按钮悬浮显现 */
.versiondock-repo-header [data-action-btn],
.versiondock-group-divider [data-action-btn] {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
}
.versiondock-repo-header [data-action-btn] {
  max-height: 20px;
  box-sizing: border-box;
}
.versiondock-repo-header:hover [data-action-btn],
.versiondock-group-divider:hover [data-action-btn],
.versiondock-repo-header [data-action-btn][data-active="true"] {
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* 多仓库分组与标题栏（RepoHeader） */
[data-density="comfortable"] .versiondock-repo-group,
[data-density="comfortable"] .versiondock-repo-section {
  margin-top: 6px;
}
[data-density="comfortable"] .versiondock-repo-group[data-first="true"],
[data-density="comfortable"] .versiondock-repo-section[data-first="true"] {
  margin-top: 4px;
}

[data-density="comfortable"] .versiondock-repo-header {
  margin: 0 6px !important;
  border-radius: 6px !important;
  height: 28px !important;
  min-height: 28px !important;
  box-sizing: border-box !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  border: 1px solid color-mix(in srgb, var(--repo-color, #888) 38%, transparent) !important;
  background: color-mix(in srgb, var(--repo-color, #888) 12%, transparent);
  transition: background 0.12s ease, border-color 0.12s ease !important;
}
[data-density="comfortable"] .versiondock-repo-header:hover {
  background: color-mix(in srgb, var(--repo-color, #888) 20%, transparent);
  border-color: color-mix(in srgb, var(--repo-color, #888) 55%, transparent) !important;
}

/* VS Code 视图模式分区标题栏与 Changelist 视图模式分组标题栏（通用 Section Header 语义拦截） */
[data-density="comfortable"] [data-section-header] {
  margin: 4px 6px 2px 6px !important;
  border-radius: 6px !important;
  height: 28px !important;
  min-height: 28px !important;
  box-sizing: border-box !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  border: 1px solid color-mix(in srgb, var(--vscode-focusBorder, #007acc) 30%, transparent) !important;
  border-left: 3px solid var(--vscode-focusBorder, var(--vscode-button-background, #007acc)) !important;
  background: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.15)) 80%, transparent) !important;
  transition: background 0.12s ease, border-color 0.12s ease !important;
}
[data-density="comfortable"] [data-section-header]:hover {
  background: color-mix(in srgb, var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, 0.25)) 90%, transparent) !important;
}

/* 舒适模式下提交面板各滚动列表容器垂直呼吸空间 */
[data-density="comfortable"] .versiondock-commit-scroll-container {
  padding-top: 4px !important;
  padding-bottom: 6px !important;
  box-sizing: border-box !important;
}

/* 模块分割线与组底分割线：在舒适模式下展开且有数据时呈现与仓库标题栏等宽的清晰分割线 */
.versiondock-repo-bottom-divider,
.versiondock-group-divider {
  border: none !important;
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35))) !important;
  height: 0;
  line-height: 0;
  font-size: 0;
  box-sizing: border-box;
}

.versiondock-group-divider[data-hidden="true"],
.versiondock-repo-bottom-divider[data-hidden="true"],
.versiondock-group-divider[data-hidden-in-comfortable="true"],
.versiondock-repo-bottom-divider[data-hidden-in-comfortable="true"] {
  display: none !important;
}

[data-density="comfortable"] .versiondock-group-divider,
[data-density="comfortable"] .versiondock-repo-bottom-divider {
  margin: 6px 6px 0 6px !important;
  opacity: 0.85 !important;
}

/* 统一提交输入卡片与表单控件（UnifiedCommitForm & General Form Controls） */
[data-density="comfortable"] .versiondock-commit-form {
  border-radius: 8px !important;
  border: 1px solid var(--vscode-panel-border) !important;
}
[data-density="comfortable"] [data-form-input] {
  border-radius: 6px !important;
}
[data-density="comfortable"] [data-dropdown-btn] {
  border-radius: 6px !important;
}
[data-density="comfortable"] .versiondock-commit-form .gs-ai-marquee-track {
  rx: 5.5px !important;
  ry: 5.5px !important;
}

/* PushTab 容器与底栏 */
[data-density="comfortable"] .versiondock-push-root {
  gap: 6px !important;
}
[data-density="comfortable"] .versiondock-push-card {
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 8px !important;
}
[data-density="comfortable"] .versiondock-push-footer {
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 8px !important;
}

/* Git Log 框架与过滤器 */
[data-density="comfortable"] .versiondock-log-frame {
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 8px !important;
}
[data-density="comfortable"] .versiondock-filters-bar {
  padding: 6px 6px !important;
  border-bottom: none !important;
}
[data-density="comfortable"] .versiondock-filter-field,
[data-density="comfortable"] .versiondock-filter-history-chip,
[data-density="comfortable"] [data-filter-picker-btn] {
  border-radius: 6px !important;
  height: 26px !important;
  border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.25)) !important;
  transition: background 0.12s ease, border-color 0.12s ease !important;
}
[data-density="comfortable"] .versiondock-filters-bar [data-top-action-btn] {
  border-radius: 6px !important;
  height: 26px !important;
  width: 26px !important;
  border: 1px solid var(--vscode-input-border, rgba(128, 128, 128, 0.25)) !important;
  transition: background 0.12s ease, border-color 0.12s ease !important;
}
[data-density="comfortable"] .versiondock-filters-bar [data-top-action-btn]:hover {
  background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.15)) !important;
}
[data-density="comfortable"] .versiondock-filter-dropdown,
[data-density="comfortable"] .versiondock-filter-calendar-popover,
[data-density="comfortable"] .versiondock-filter-more-dropdown {
  border-radius: 6px !important;
  border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border, rgba(128, 128, 128, 0.35))) !important;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28) !important;
  overflow: hidden !important;
}
[data-density="comfortable"] [data-filter-dropdown-item],
[data-density="comfortable"] [data-more-menu-item] {
  border-radius: 4px !important;
  margin: 1px 4px !important;
  transition: background 0.12s ease, color 0.12s ease !important;
}
[data-density="comfortable"] .versiondock-compare-view {
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 8px !important;
}

/* 变更与提交详情面板通用拦截（CommitDetail & Change Detail Panels） */
[data-density="comfortable"] .versiondock-detail-toolbar {
  padding: 5px 10px 6px 10px !important;
  border-bottom: none !important;
  position: relative !important;
}

[data-density="comfortable"] .versiondock-detail-toolbar::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 0;
  height: 1px;
  background: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  opacity: 0.85;
  pointer-events: none;
  z-index: 2;
}

[data-density="comfortable"] .versiondock-detail-row {
  margin: 0 6px !important;
  border-radius: 5px !important;
  min-height: 22px !important;
  width: auto !important;
  box-sizing: border-box !important;
  transition: background 0.12s ease, color 0.12s ease !important;
}

[data-density="comfortable"] .versiondock-detail-splitter {
  height: 6px !important;
  background: transparent !important;
  background-image: none !important;
  position: relative !important;
}

[data-density="comfortable"] .versiondock-detail-splitter::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  height: 1px;
  background: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  opacity: 0.85;
  transition: background 0.15s ease, opacity 0.15s ease;
  pointer-events: none;
}

[data-density="comfortable"] .versiondock-detail-splitter:hover::after {
  background: var(--vscode-focusBorder, var(--vscode-textLink-foreground));
  opacity: 1;
}

[data-density="comfortable"] .versiondock-detail-info {
  padding: 10px 12px 14px 12px !important;
  gap: 6px !important;
}

[data-density="comfortable"] .versiondock-detail-repo-header {
  margin: 0 0 4px 0 !important;
  padding: 2px 0 !important;
  border-radius: 0 !important;
  min-height: auto !important;
  background: transparent !important;
  border: none !important;
  box-sizing: border-box !important;
}

[data-density="comfortable"] .versiondock-detail-message-card {
  margin-top: 0 !important;
  margin-bottom: 7px !important;
  padding: 10px 12px !important;
  border-radius: 8px !important;
  border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.25)) !important;
  box-sizing: border-box !important;
}

[data-density="comfortable"] .versiondock-detail-author-row {
  margin-top: 2px !important;
  margin-bottom: 7px !important;
  gap: 8px !important;
}

[data-density="comfortable"] .versiondock-detail-hash {
  border-radius: 4px !important;
  padding: 1px 5px !important;
}

[data-density="comfortable"] .versiondock-detail-ref-badge {
  height: 19px !important;
  line-height: 17px !important;
  border-radius: 4px !important;
  padding: 0 7px !important;
  font-size: 11px !important;
  box-sizing: border-box !important;
}

[data-density="comfortable"] .versiondock-detail-merge-group {
  border-top: none !important;
  position: relative !important;
  padding-top: 4px !important;
  margin-top: 2px !important;
}

[data-density="comfortable"] .versiondock-detail-merge-group::before {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  top: 0;
  height: 1px;
  background: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35)));
  opacity: 0.85;
  pointer-events: none;
}

/* ── 2. 紧凑模式（Compact Mode: VS Code 原生最高信息密度） ── */

[data-density="compact"] [data-row-divider]::after,
[data-density="compact"] .versiondock-card::after {
  display: none !important;
}

[data-density="compact"] [data-row-divider] {
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35))) !important;
  box-sizing: border-box !important;
}

[data-density="compact"] [data-speed-search-key],
[data-density="compact"] [data-commit-row],
[data-density="compact"] [data-list-row],
[data-density="compact"] .versiondock-file-row,
[data-density="compact"] .versiondock-tree-dir {
  margin-left: 0 !important;
  margin-right: 0 !important;
  border-radius: 0 !important;
}

[data-density="compact"] .versiondock-card {
  margin: 0 !important;
  border-radius: 0 !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
}

[data-density="compact"] .versiondock-card-header {
  border-radius: 0 !important;
}

[data-density="compact"] .versiondock-card-body {
  border-radius: 0 !important;
  border-top: 1px solid var(--vscode-panel-border) !important;
}

[data-density="compact"] .versiondock-card-body::before {
  display: none !important;
}

[data-density="compact"] .versiondock-repo-group,
[data-density="compact"] .versiondock-repo-section {
  margin-top: 0 !important;
}

[data-density="compact"] .versiondock-repo-header {
  margin: 0 !important;
  border-radius: 0 !important;
  height: 26px !important;
  min-height: 26px !important;
  box-sizing: border-box !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  border: none !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
  background: color-mix(in srgb, var(--repo-color, #888) 15%, transparent);
}
[data-density="compact"] .versiondock-repo-header:hover {
  background: color-mix(in srgb, var(--repo-color, #888) 22%, transparent);
}

[data-density="compact"] [data-section-header] {
  margin: 0 !important;
  border-radius: 0 !important;
  height: 26px !important;
  min-height: 26px !important;
  box-sizing: border-box !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  border: none !important;
  border-left: 3px solid var(--vscode-focusBorder, var(--vscode-button-background, #007acc)) !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
  background: var(--vscode-sideBarSectionHeader-background, rgba(128,128,128,0.08)) !important;
}

[data-density="compact"] .versiondock-commit-scroll-container {
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

[data-density="compact"] .versiondock-group-divider,
[data-density="compact"] .versiondock-repo-bottom-divider {
  border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, rgba(128, 128, 128, 0.35))) !important;
  margin: 0 !important;
  opacity: 1 !important;
}

[data-density="compact"] .versiondock-commit-form {
  border-radius: 0 !important;
  border: none !important;
  border-top: 1px solid var(--vscode-panel-border) !important;
}
[data-density="compact"] [data-form-input] {
  border-radius: 3px !important;
}
[data-density="compact"] [data-dropdown-btn] {
  border-radius: 4px !important;
}
[data-density="compact"] .versiondock-commit-form .gs-ai-marquee-track {
  rx: 2.5px !important;
  ry: 2.5px !important;
}

[data-density="compact"] .versiondock-push-root {
  gap: 0 !important;
}
[data-density="compact"] .versiondock-push-card {
  border: none !important;
  border-radius: 0 !important;
}
[data-density="compact"] .versiondock-push-footer {
  border-radius: 0 !important;
  border-left: none !important;
  border-right: none !important;
  border-bottom: none !important;
  border-top: 1px solid var(--vscode-panel-border) !important;
}

[data-density="compact"] .versiondock-log-frame {
  border: none !important;
  border-radius: 0 !important;
}

[data-density="compact"] .versiondock-branch-sidebar {
  border: none !important;
  border-right: 1px solid var(--vscode-panel-border) !important;
  border-radius: 0 !important;
  overflow-y: auto !important;
  overflow-x: hidden !important;
}

[data-density="compact"] .versiondock-sidebar-sticky-header {
  position: sticky !important;
  top: 0 !important;
  z-index: 10 !important;
  border-radius: 0 !important;
  border-bottom: none !important;
}

[data-density="compact"] .versiondock-sidebar-search {
  height: 35px !important;
  padding: 0 !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
  gap: 0 !important;
}

[data-density="compact"] .versiondock-sidebar-search-input-wrap {
  border-radius: 0 !important;
  height: 100% !important;
  border: none !important;
  padding-left: 8px !important;
}

[data-density="compact"] .versiondock-sidebar-collapse-btn {
  border-left: 1px solid var(--vscode-panel-border) !important;
  border-radius: 0 !important;
  height: 100% !important;
  width: auto !important;
  padding: 0 5px !important;
}

[data-density="compact"] .versiondock-sidebar-repo-list {
  padding: 3px 0 !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
}

[data-density="compact"] .versiondock-sidebar-section-header {
  margin: 0 !important;
  border-radius: 0 !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
  padding: 4px 8px !important;
  min-height: auto !important;
  background: var(--vscode-sideBarSectionHeader-background) !important;
}

[data-density="compact"] .versiondock-filters-bar {
  padding: 6px 10px !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
}

[data-density="compact"] .versiondock-compare-view {
  border: none !important;
  border-radius: 0 !important;
}

[data-density="compact"] [data-speed-search-key],
[data-density="compact"] [data-commit-row],
[data-density="compact"] [data-list-row],
[data-density="compact"] .versiondock-file-row,
[data-density="compact"] .versiondock-tree-dir {
  margin-left: 0 !important;
  margin-right: 0 !important;
  border-radius: 0 !important;
  width: 100% !important;
}

[data-density="compact"] .versiondock-commit-row {
  left: 0 !important;
  right: 0 !important;
  border-radius: 0 !important;
}

[data-density="compact"] .versiondock-sidebar-row {
  margin-left: 0 !important;
  margin-right: 0 !important;
  border-radius: 0 !important;
  min-height: 22px !important;
  padding-top: 2px !important;
  padding-bottom: 2px !important;
}

[data-density="compact"] .versiondock-sidebar-repo-row {
  min-height: 20px !important;
  margin: 0 !important;
  border-radius: 0 !important;
  padding: 2px 8px !important;
}

[data-density="compact"] .versiondock-sidebar-row[data-is-head="true"]::before {
  display: none !important;
}

/* 变更与提交详情面板通用拦截（紧凑模式还原） */
[data-density="compact"] .versiondock-detail-toolbar {
  padding: 3px 10px !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
}

[data-density="compact"] .versiondock-detail-toolbar::after {
  display: none !important;
}

[data-density="compact"] .versiondock-detail-row {
  margin-left: 0 !important;
  margin-right: 0 !important;
  border-radius: 0 !important;
  min-height: 22px !important;
  padding-top: 2px !important;
  padding-bottom: 2px !important;
  width: 100% !important;
}

[data-density="compact"] .versiondock-detail-splitter {
  height: 4px !important;
  background-image: linear-gradient(to bottom, transparent 1px, var(--vscode-panel-border) 1px, var(--vscode-panel-border) 2px, transparent 2px) !important;
}

[data-density="compact"] .versiondock-detail-splitter::after {
  display: none !important;
}

[data-density="compact"] .versiondock-detail-info {
  padding: 9px 12px 12px !important;
  gap: 4px !important;
}

[data-density="compact"] .versiondock-detail-repo-header {
  margin: 0 !important;
  padding: 0 !important;
  border-radius: 0 !important;
  min-height: auto !important;
  background: transparent !important;
  border: none !important;
}

[data-density="compact"] .versiondock-detail-message-card {
  margin-top: 2px !important;
  margin-bottom: 3px !important;
  padding: 10px 12px !important;
  border-radius: 4px !important;
  border: 1px solid var(--vscode-panel-border) !important;
}

[data-density="compact"] .versiondock-detail-author-row {
  margin-top: 3px !important;
  margin-bottom: 5px !important;
  gap: 6px !important;
}

[data-density="compact"] .versiondock-detail-hash {
  border-radius: 3px !important;
  padding: 1px 4px !important;
}

[data-density="compact"] .versiondock-detail-ref-badge {
  height: 16px !important;
  line-height: 16px !important;
  border-radius: 3px !important;
  padding: 0 6px !important;
  font-size: 10px !important;
}

[data-density="compact"] .versiondock-detail-merge-group {
  border-top: 1px solid var(--vscode-panel-border) !important;
  padding-top: 0 !important;
  margin-top: 0 !important;
}

[data-density="compact"] .versiondock-detail-merge-group::before {
  display: none !important;
}
`;
