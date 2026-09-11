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

/* 舒适模式清除行间硬贴边分割线（浮动行由底部仓库分割线收尾） */
[data-density="comfortable"] [data-row-divider] {
  border-bottom: none !important;
}

/* Git Log 绝对定位虚拟提交行：避开泳道，浮动高亮 */
[data-density="comfortable"] .versiondock-commit-row {
  left: 4px !important;
  right: 4px !important;
  border-radius: 5px !important;
  transition: background 0.12s ease, color 0.12s ease !important;
}

/* 侧边栏行项（分支树等） */
[data-density="comfortable"] .versiondock-sidebar-row {
  margin-left: 4px !important;
  margin-right: 4px !important;
  border-radius: 4px !important;
  transition: background 0.12s ease, color 0.12s ease !important;
}

/* 卡片容器（暂存项、搁置项、提交卡片等） */
[data-density="comfortable"] .versiondock-card {
  margin: 2px 6px !important;
  border-radius: 6px !important;
  overflow: hidden !important;
  border-bottom: none !important;
}

[data-density="comfortable"] .versiondock-card-header {
  border-radius: 6px !important;
  transition: background 0.12s ease !important;
}

[data-density="comfortable"] .versiondock-card-body {
  border-radius: 0 0 6px 6px !important;
}

/* 卡片内部元素占满卡片宽度，不再二次向内缩进，确保卡片整体外边距与仓库标题栏（margin: 0 6px）绝对对齐 */
[data-density="comfortable"] .versiondock-card [data-speed-search-key],
[data-density="comfortable"] .versiondock-card [data-commit-row],
[data-density="comfortable"] .versiondock-card [data-list-row],
[data-density="comfortable"] .versiondock-card .versiondock-file-row,
[data-density="comfortable"] .versiondock-card .versiondock-tree-dir {
  margin-left: 0 !important;
  margin-right: 0 !important;
  width: 100% !important;
  border-radius: 0 !important;
}

/* 通用：标题栏操作按钮悬浮显现 */
.versiondock-repo-header [data-action-btn],
.versiondock-group-divider [data-action-btn] {
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.12s ease;
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
  min-height: 27px;
  border: 1px solid color-mix(in srgb, var(--repo-color, #888) 38%, transparent) !important;
  background: color-mix(in srgb, var(--repo-color, #888) 12%, transparent);
  transition: background 0.12s ease, border-color 0.12s ease !important;
}
[data-density="comfortable"] .versiondock-repo-header:hover {
  background: color-mix(in srgb, var(--repo-color, #888) 20%, transparent);
  border-color: color-mix(in srgb, var(--repo-color, #888) 55%, transparent) !important;
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

/* 统一提交输入卡片（UnifiedCommitForm） */
[data-density="comfortable"] .versiondock-commit-form {
  border-radius: 8px !important;
  border: 1px solid var(--vscode-panel-border) !important;
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

/* Git Log 框架、侧边栏与过滤器 */
[data-density="comfortable"] .versiondock-log-frame {
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 8px !important;
}
[data-density="comfortable"] .versiondock-branch-sidebar {
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 8px !important;
}
[data-density="comfortable"] .versiondock-filters-bar {
  padding: 6px 8px !important;
  border-bottom: none !important;
}
[data-density="comfortable"] .versiondock-compare-view {
  border: 1px solid var(--vscode-panel-border) !important;
  border-radius: 8px !important;
}

/* 弱化或移除舒适模式下多余的直通硬分割线 */
[data-density="comfortable"] [data-row-divider] {
  border-bottom: none !important;
}

/* ── 2. 紧凑模式（Compact Mode: VS Code 原生最高信息密度） ── */

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
}

[data-density="compact"] .versiondock-repo-group,
[data-density="compact"] .versiondock-repo-section {
  margin-top: 0 !important;
}

[data-density="compact"] .versiondock-repo-header {
  margin: 0 !important;
  border-radius: 0 !important;
  min-height: 26px;
  border: none !important;
  border-bottom: 1px solid var(--vscode-panel-border) !important;
  background: color-mix(in srgb, var(--repo-color, #888) 15%, transparent);
}
[data-density="compact"] .versiondock-repo-header:hover {
  background: color-mix(in srgb, var(--repo-color, #888) 22%, transparent);
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
}
`;
