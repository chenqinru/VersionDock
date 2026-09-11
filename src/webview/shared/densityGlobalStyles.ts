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
  transition: background 0.12s ease, color 0.12s ease !important;
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
