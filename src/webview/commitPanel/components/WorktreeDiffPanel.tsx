import React, { useMemo, useRef, useState } from 'react';
import type { FileStatus } from '../../shared/types';
import { FileIcon } from '../../shared/FileIcon';
import { Codicon } from '../../shared/Codicon';
import type { IconThemeData } from '../../../host/types/messages';
import type { WorktreeDiffState } from '../store/commitStore';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { t } from '../../shared/i18n';
import { readableAccentColor } from '../../shared/branchColors';
import { HighlightedText, SpeedSearchWidget, useSpeedSearch } from '../../shared/speedSearch';

interface Props {
  state: WorktreeDiffState;
  iconTheme?: IconThemeData | null;
  onClose: () => void;
  onSelectFile: (file: FileStatus) => void;
  onOpenFile: (file: FileStatus) => void;
}

interface TreeDir {
  kind: 'dir';
  name: string;
  path: string;
  fileCount: number;
  children: TreeNode[];
}

interface TreeFile {
  kind: 'file';
  name: string;
  file: FileStatus;
}

type TreeNode = TreeDir | TreeFile;

const SCROLLBAR_CSS = `
.versiondock-worktree-scroll::-webkit-scrollbar {
  width: 10px;
}
.versiondock-worktree-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.versiondock-worktree-scroll::-webkit-scrollbar-thumb {
  background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: content-box;
}
.versiondock-worktree-scroll::-webkit-scrollbar-thumb:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7));
  background-clip: content-box;
}
.versiondock-worktree-dir-row:hover,
.versiondock-worktree-file-row[data-selected="false"]:hover {
  background: var(--vscode-list-hoverBackground) !important;
}
`;

const STATUS_COLORS: Record<FileStatus['status'], string> = {
  modified: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
  added: 'var(--vscode-gitDecoration-addedResourceForeground)',
  deleted: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  renamed: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  copied: 'var(--vscode-gitDecoration-addedResourceForeground)',
  untracked: 'var(--vscode-gitDecoration-untrackedResourceForeground)',
  conflicted: 'var(--vscode-gitDecoration-conflictingResourceForeground)',
  submodule: 'var(--vscode-gitDecoration-submoduleResourceForeground)',
};

const STATUS_LETTERS: Record<FileStatus['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: 'U',
  conflicted: 'C',
  submodule: 'S',
};

const FILE_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'diff', label: t('Show Diff'), icon: 'diff' },
  { id: 'open', label: t('Open file'), icon: 'go-to-file' },
];

export function WorktreeDiffPanel({ state, iconTheme, onClose, onSelectFile, onOpenFile }: Props) {
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: FileStatus } | null>(null);
  const tree = useMemo(() => buildTree(state.files), [state.files]);

  const sidebarRef = useRef<HTMLDivElement | null>(null);
  const savedCollapsedBeforeSearchRef = useRef<Set<string> | null>(null);

  const speedSearch = useSpeedSearch<FileStatus>({
    items: state.files,
    getItemKey: f => f.path,
    getItemPath: f => f.path,
    getItemName: f => f.path.split('/').pop() ?? f.path,
    containerRef: sidebarRef,
    enabled: true,
    onActiveChange: (item) => {
      if (item) onSelectFile(item);
    },
    onExpandParents: (matchedItems) => {
      if (!savedCollapsedBeforeSearchRef.current) {
        savedCollapsedBeforeSearchRef.current = new Set(collapsed);
      }
      const nextCollapsed = new Set(collapsed);
      for (const f of matchedItems) {
        const parts = f.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          nextCollapsed.delete(parts.slice(0, i).join('/'));
        }
      }
      setCollapsed(nextCollapsed);
    },
    onRestoreCollapsed: () => {
      if (savedCollapsedBeforeSearchRef.current) {
        setCollapsed(savedCollapsedBeforeSearchRef.current);
        savedCollapsedBeforeSearchRef.current = null;
      }
    },
  });

  const toggleCollapsed = (key: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const expandAll = () => setCollapsed(new Set());
  const collapseAll = () => setCollapsed(new Set(collectDirKeys(tree)));

  return (
    <div style={styles.container}>
      <style>{SCROLLBAR_CSS}</style>
      <div style={styles.header}>
        <div style={styles.headerText}>
          <div style={styles.titleRow}>
            <span style={styles.repoDot(readableAccentColor(state.repoColor))} />
            <span style={styles.repoNameInline}>{state.repoName}</span>
            <span style={styles.title}>{t('{0} vs Working Tree', state.baseRef)}</span>
          </div>
          <div style={styles.subtitle}>{t('{0} compared with {1}', state.baseRef, state.currentRef)}</div>
        </div>
        <button data-action-btn="" style={styles.iconButton} onClick={onClose} title={t('Back to Changes')}>
          <Codicon name="arrow-left" />
        </button>
      </div>

      {state.error && <div style={styles.errorBar}>{state.error}</div>}

      <div style={styles.toolbar}>
        <span style={styles.count}>{state.files.length === 1 ? t('{0} file', state.files.length) : t('{0} files', state.files.length)}</span>
        <div style={{ flex: 1 }} />
        {viewMode === 'tree' && (
          <>
            <button data-action-btn="" style={styles.toolbarButton} onClick={expandAll} title={t('Expand all')}>
              <Codicon name="expand-all" />
            </button>
            <button data-action-btn="" style={styles.toolbarButton} onClick={collapseAll} title={t('Collapse all')}>
              <Codicon name="collapse-all" />
            </button>
          </>
        )}
        <button data-action-btn="" style={styles.toolbarButton} onClick={() => setViewMode('tree')} title={t('Tree view')}>
          <Codicon name="list-tree" />
        </button>
        <button data-action-btn="" style={styles.toolbarButton} onClick={() => setViewMode('flat')} title={t('Flat list')}>
          <Codicon name="list-flat" />
        </button>
      </div>

      <div style={styles.content}>
        <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {speedSearch.isOpen && <SpeedSearchWidget speedSearch={speedSearch} />}
          <div ref={sidebarRef} className="versiondock-worktree-scroll" style={styles.sidebar}>
            {contextMenu && (
              <ContextMenu
                x={contextMenu.x}
                y={contextMenu.y}
                items={FILE_CONTEXT_ITEMS}
                onClose={() => setContextMenu(null)}
                onSelect={(id) => {
                  if (id === 'diff') onSelectFile(contextMenu.file);
                  if (id === 'open') onOpenFile(contextMenu.file);
                }}
              />
            )}
            {state.loadingFiles ? (
              <div style={styles.empty}>{t('Loading...')}</div>
            ) : state.files.length === 0 ? (
              <div style={styles.empty}>{t('No file differences between {0} and the working tree', state.baseRef)}</div>
            ) : viewMode === 'tree' ? (
              tree.map(node => (
                <TreeNodeView
                  key={node.kind === 'dir' ? node.path : node.file.path}
                  node={node}
                  depth={0}
                  collapsed={collapsed}
                  iconTheme={iconTheme}
                  selectedPath={state.selectedFile?.path ?? null}
                  onToggle={toggleCollapsed}
                  onSelect={onSelectFile}
                  onContextMenu={(event, file) => {
                    setContextMenu({ x: event.clientX, y: event.clientY, file });
                  }}
                  speedSearchQuery={speedSearch.query}
                  activeSpeedSearchKey={speedSearch.activeKey}
                />
              ))
            ) : (
              state.files.map(file => (
                <FileRow
                  key={file.path}
                  file={file}
                  depth={0}
                  iconTheme={iconTheme}
                  selected={state.selectedFile?.path === file.path}
                  onSelect={onSelectFile}
                  onContextMenu={(event, targetFile) => {
                    setContextMenu({ x: event.clientX, y: event.clientY, file: targetFile });
                  }}
                  speedSearchQuery={speedSearch.query}
                  activeSpeedSearchKey={speedSearch.activeKey}
                />
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function TreeNodeView({
  node,
  depth,
  collapsed,
  iconTheme,
  selectedPath,
  onToggle,
  onSelect,
  onContextMenu,
  speedSearchQuery,
  activeSpeedSearchKey,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  iconTheme?: IconThemeData | null;
  selectedPath: string | null;
  onToggle: (key: string) => void;
  onSelect: (file: FileStatus) => void;
  onContextMenu: (event: React.MouseEvent, file: FileStatus) => void;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}) {
  if (node.kind === 'file') {
    return (
      <FileRow
        file={node.file}
        depth={depth}
        iconTheme={iconTheme}
        selected={selectedPath === node.file.path}
        onSelect={onSelect}
        onContextMenu={onContextMenu}
        speedSearchQuery={speedSearchQuery}
        activeSpeedSearchKey={activeSpeedSearchKey}
      />
    );
  }

  const isCollapsed = collapsed.has(node.path);
  return (
    <>
      <div className="versiondock-worktree-dir-row" style={{ ...styles.dirRow, paddingLeft: `${10 + depth * 18}px` }} onClick={() => onToggle(node.path)} title={node.path}>
        <Codicon name={isCollapsed ? 'chevron-right' : 'chevron-down'} style={styles.chevron} />
        <FileIcon name={node.name} isFolder isOpen={!isCollapsed} theme={iconTheme} size={16} />
        <span style={styles.dirName}>
          <HighlightedText text={node.name} query={speedSearchQuery} />
        </span>
        <span style={styles.fileCountBadge}>{node.fileCount}</span>
      </div>
      {!isCollapsed && node.children.map(child => (
        <TreeNodeView
          key={child.kind === 'dir' ? child.path : child.file.path}
          node={child}
          depth={depth + 1}
          collapsed={collapsed}
          iconTheme={iconTheme}
          selectedPath={selectedPath}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          speedSearchQuery={speedSearchQuery}
          activeSpeedSearchKey={activeSpeedSearchKey}
        />
      ))}
    </>
  );
}

function FileRow({
  file,
  depth,
  iconTheme,
  selected,
  onSelect,
  onContextMenu,
  speedSearchQuery,
  activeSpeedSearchKey,
}: {
  file: FileStatus;
  depth: number;
  iconTheme?: IconThemeData | null;
  selected: boolean;
  onSelect: (file: FileStatus) => void;
  onContextMenu: (event: React.MouseEvent, file: FileStatus) => void;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}) {
  const color = STATUS_COLORS[file.status] ?? 'var(--vscode-foreground)';
  const letter = STATUS_LETTERS[file.status] ?? 'M';
  const fileName = file.path.split('/').pop() ?? file.path;
  const dir = depth === 0 && file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '';
  const isSpeedSearchActive = activeSpeedSearchKey === file.path;

  return (
    <div
      className="versiondock-worktree-file-row"
      data-speed-search-key={file.path}
      data-selected={selected ? 'true' : 'false'}
      style={{ ...styles.fileRow(selected), paddingLeft: `${10 + depth * 18}px` }}
      onClick={() => onSelect(file)}
      onContextMenu={(event) => {
        event.preventDefault();
        onContextMenu(event, file);
      }}
      title={file.path}
    >
      <span style={styles.fileLeadingSpacer} />
      <FileIcon name={fileName} theme={iconTheme} size={16} />
      <span style={styles.fileName(color)}>
        <HighlightedText text={fileName} query={speedSearchQuery} isActive={isSpeedSearchActive} />
      </span>
      {dir && (
        <span style={styles.dirPath}>
          <HighlightedText text={dir} query={speedSearchQuery} />
        </span>
      )}
      <span style={styles.fileMeta}>
        {(file.added != null || file.removed != null) && (
          <span style={styles.lineStats}>
            {file.added != null && <span style={styles.added}>+{file.added}</span>}
            {file.removed != null && <span style={styles.removed}>-{file.removed}</span>}
          </span>
        )}
        <span style={styles.statusLetter(color)}>{letter}</span>
      </span>
    </div>
  );
}

function buildTree(files: FileStatus[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', fileCount: 0, children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index];
      const dirPath = parts.slice(0, index + 1).join('/');
      let child = node.children.find(item => item.kind === 'dir' && item.path === dirPath) as TreeDir | undefined;
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, fileCount: 0, children: [] };
        node.children.push(child);
      }
      child.fileCount += 1;
      node = child;
    }
    node.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  return collapseSingleChildDirs(sortTree(root.children));
}

function sortTree(nodes: TreeNode[]): TreeNode[] {
  return [...nodes]
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1;
      return left.name.localeCompare(right.name);
    })
    .map(node => node.kind === 'dir' ? { ...node, children: sortTree(node.children) } : node);
}

function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0];
      return {
        kind: 'dir' as const,
        name: `${node.name}/${only.name}`,
        path: only.path,
        fileCount: only.fileCount,
        children: only.children,
      };
    }
    return {
      ...node,
      children,
    };
  });
}

function collectDirKeys(nodes: TreeNode[]): string[] {
  const keys: string[] = [];
  for (const node of nodes) {
    if (node.kind !== 'dir') continue;
    keys.push(node.path, ...collectDirKeys(node.children));
  }
  return keys;
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100vh',
    background: 'var(--vscode-sideBar-background)',
    color: 'var(--vscode-foreground)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  headerText: {
    display: 'flex',
    flexDirection: 'column' as const,
    minWidth: 0,
    flex: 1,
  },
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minWidth: 0,
  } as React.CSSProperties,
  title: {
    fontSize: '13px',
    fontWeight: 600,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  },
  repoNameInline: {
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    fontSize: '10px',
    color: 'var(--vscode-sideBarSectionHeader-foreground)',
    flexShrink: 0,
  },
  subtitle: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  iconButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    background: 'transparent',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
  } as React.CSSProperties,
  errorBar: {
    padding: '6px 10px',
    fontSize: '12px',
    color: 'var(--vscode-errorForeground)',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: '34px',
    padding: '0 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  toolbarButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
    height: '24px',
    background: 'transparent',
    border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
  } as React.CSSProperties,
  repoDot: (color: string): React.CSSProperties => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  count: {
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
  },
  content: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  sidebar: {
    flex: 1,
    minHeight: 0,
    width: '100%',
    overflowX: 'hidden',
    overflowY: 'auto',
    scrollbarWidth: 'thin' as const,
    scrollbarColor: 'var(--vscode-scrollbarSlider-background) transparent',
    scrollbarGutter: 'stable',
  } as React.CSSProperties,
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '24px',
    textAlign: 'center' as const,
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '12px',
  },
  dirRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minHeight: '24px',
    cursor: 'pointer',
    userSelect: 'none' as const,
    minWidth: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  chevron: {
    fontSize: '12px',
    flexShrink: 0,
  },
  fileLeadingSpacer: {
    width: '12px',
    flexShrink: 0,
  } as React.CSSProperties,
  dirName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    flex: 1,
    minWidth: 0,
  },
  fileCountBadge: {
    marginLeft: '6px',
    padding: '0 7px',
    minWidth: '18px',
    height: '18px',
    borderRadius: '999px',
    fontSize: '10px',
    fontWeight: 600,
    lineHeight: '18px',
    textAlign: 'center' as const,
    color: 'var(--versiondock-badge-foreground)',
    background: 'var(--versiondock-badge-background)',
    flexShrink: 0,
  } as React.CSSProperties,
  fileRow: (selected: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minHeight: '24px',
    cursor: 'pointer',
    background: selected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
  }),
  fileName: (color: string): React.CSSProperties => ({
    color,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
    minWidth: 0,
    fontSize: '12px',
  }),
  dirPath: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    maxWidth: '100px',
    flexShrink: 0,
  },
  fileMeta: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '8px',
    marginLeft: 'auto',
    minWidth: '92px',
    flexShrink: 0,
  },
  lineStats: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '10px',
    flexShrink: 0,
  } as React.CSSProperties,
  added: {
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
  },
  removed: {
    color: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  },
  statusLetter: (color: string): React.CSSProperties => ({
    color,
    fontSize: '10px',
    fontWeight: 700,
    width: '12px',
    textAlign: 'center' as const,
    flexShrink: 0,
  }),
};
