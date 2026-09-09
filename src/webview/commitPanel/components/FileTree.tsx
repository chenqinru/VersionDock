import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { FileStatus, GitFileStatus } from '../../shared/types';
import { useCommitStore, type ViewMode } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { t } from '../../shared/i18n';
import { scopedKey } from '../../shared/scopedKey';
import { nativeCheckboxBorderStyle } from '../../shared/nativeCheckboxStyle';
import { HighlightedText } from '../../shared/speedSearch';

interface Props {
  repoId: string;
  repoName: string;
  repoRootPath?: string;
  files: FileStatus[];
  iconTheme?: IconThemeData | null;
  selectedFile: { repoId: string; path: string } | null;
  onSelect: (file: FileStatus) => void;
  onToggleFile: (repoId: string, path: string) => void;
  onSetFiles: (repoId: string, paths: string[], selected: boolean) => void;
  isFileSelected: (repoId: string, path: string) => boolean;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  collapsedKeys?: Set<string>;
  onContextMenu: (e: React.MouseEvent, file: FileStatus) => void;
  onFolderContextMenu: (e: React.MouseEvent, repoId: string, folderPath: string, files: FileStatus[]) => void;
  onOpenFile: (file: FileStatus) => void;
  onRollback: (files: FileStatus[]) => void;
  onResolveMerge: (file: FileStatus) => void;
  viewMode: ViewMode;
  basePad?: number;
  activeFolderPath?: string | null;
  ctxFile?: { repoId: string; path: string } | null;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}

const STATUS_COLORS: Record<GitFileStatus, string> = {
  modified:   'var(--vscode-gitDecoration-modifiedResourceForeground)',
  added:      'var(--vscode-gitDecoration-addedResourceForeground)',
  deleted:    'var(--vscode-gitDecoration-deletedResourceForeground)',
  renamed:    'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  copied:     'var(--vscode-gitDecoration-addedResourceForeground)',
  untracked:  'var(--vscode-gitDecoration-untrackedResourceForeground)',
  conflicted: 'var(--vscode-gitDecoration-conflictingResourceForeground)',
  submodule:  'var(--vscode-gitDecoration-submoduleResourceForeground)',
};

const STATUS_LETTERS: Record<GitFileStatus, string> = {
  modified: 'M', added: 'A', deleted: 'D',
  renamed: 'R', copied: 'C', untracked: 'U', conflicted: 'C', submodule: 'S',
};

const ICON_SIZE = 16;
const ROW_HEIGHT = 22;
const VIRTUALIZE_THRESHOLD = 40;

// ── Tree data structure ────────────────────────────────────────────────────

interface TreeDir { kind: 'dir'; name: string; path: string; children: TreeNode[]; files: FileStatus[] }
interface TreeFile { kind: 'file'; name: string; file: FileStatus }
type TreeNode = TreeDir | TreeFile;

function buildTree(files: FileStatus[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [], files: [] };
  for (const file of files) {
    root.files.push(file);
    if (file.path === '.') {
      root.children.push({ kind: 'file', name: '.', file });
      continue;
    }
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c): c is TreeDir => c.kind === 'dir' && c.name === part);
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, children: [], files: [] };
        node.children.push(child);
      }
      child.files.push(file);
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

// Collapse chains of dirs that contain only one child dir (IntelliJ-style path compacting).
// e.g. app/ → Models/ → Migrations/ becomes "app/Models/Migrations".
function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0] as TreeDir;
      return {
        kind: 'dir' as const,
        name: `${node.name}/${only.name}`,
        path: only.path,
        children: only.children,
        files: node.files,
      };
    }
    return { ...node, children };
  });
}

type FlatTreeItem =
  | { kind: 'dir'; node: TreeDir; depth: number; path: string; key: string }
  | { kind: 'file'; file: FileStatus; depth: number; key: string };

function flattenVisibleTree(
  nodes: TreeNode[],
  repoId: string,
  isCollapsed: (key: string) => boolean,
  collapsedKeys?: Set<string>,
  depth = 0,
): FlatTreeItem[] {
  const result: FlatTreeItem[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') {
      result.push({ kind: 'file', file: node.file, depth, key: `${node.file.repoId}-${node.file.path}` });
    } else {
      const collapseKey = scopedKey('tree-dir', repoId, node.path);
      result.push({ kind: 'dir', node, depth, path: node.path, key: collapseKey });
      const collapsed = collapsedKeys ? collapsedKeys.has(collapseKey) : isCollapsed(collapseKey);
      if (!collapsed) {
        result.push(...flattenVisibleTree(node.children, repoId, isCollapsed, collapsedKeys, depth + 1));
      }
    }
  }
  return result;
}

// ── Checkbox ───────────────────────────────────────────────────────────────

function Checkbox({ checked, indeterminate, onChange, onClick }: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  onClick?: (e: React.MouseEvent) => void;
}) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate ?? false;
  }, [indeterminate]);
  return (
    <input ref={ref} type="checkbox" checked={checked}
      onChange={onChange} onClick={onClick}
      style={{ ...styles.checkbox, ...nativeCheckboxBorderStyle() }} />
  );
}

// ── Layout constants ───────────────────────────────────────────────────────

const DEFAULT_BASE_PAD = 20;  // left padding at depth-0
const LEVEL_PAD = 20;  // indent per depth level

// ── Shared sub-props type ──────────────────────────────────────────────────

type SharedProps = Pick<Props,
  'repoId' | 'repoName' | 'repoRootPath' | 'selectedFile' | 'ctxFile' | 'onSelect' | 'onToggleFile' | 'onSetFiles' |
  'isFileSelected' | 'isCollapsed' | 'toggleCollapsed' | 'onContextMenu' |
  'onFolderContextMenu' | 'onOpenFile' | 'onRollback' | 'onResolveMerge' | 'iconTheme' |
  'activeFolderPath' | 'speedSearchQuery' | 'activeSpeedSearchKey'
> & { basePad: number };

// ── Directory row (single row, no recursion) ───────────────────────────────

function TreeDirRow({ node, depth, ...shared }: { node: TreeDir; depth: number } & SharedProps) {
  const { repoId, isCollapsed, toggleCollapsed, isFileSelected, onSetFiles, onRollback, onFolderContextMenu, iconTheme, basePad, activeFolderPath, speedSearchQuery } = shared;
  const collapseKey = scopedKey('tree-dir', repoId, node.path);
  const open = !isCollapsed(collapseKey);
  const allFiles = node.files;
  const selectedCount = allFiles.filter(f => isFileSelected(repoId, f.path)).length;
  const allSelected = selectedCount === allFiles.length;
  const someSelected = selectedCount > 0 && !allSelected;
  const [hovered, setHovered] = useState(false);
  const ctxActive = activeFolderPath === node.path;

  return (
    <div
      style={{ ...styles.treeDir, paddingLeft: `${basePad + depth * LEVEL_PAD}px`, background: ctxActive ? 'var(--vscode-list-inactiveSelectionBackground)' : hovered ? 'var(--vscode-list-hoverBackground)' : undefined, borderRadius: '2px' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={(e) => { e.preventDefault(); onFolderContextMenu(e, repoId, node.path, allFiles); }}
      onClick={() => toggleCollapsed(collapseKey)}
    >
      <Checkbox
        checked={allSelected}
        indeterminate={someSelected}
        onChange={() => onSetFiles(repoId, allFiles.map(f => f.path), !allSelected)}
        onClick={(e) => e.stopPropagation()}
      />
      <div style={styles.treeDirInner} title={node.path}>
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.folderChevron} />
        <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={ICON_SIZE} />
        <span style={styles.folderName}>
          <HighlightedText text={node.name} query={speedSearchQuery} />
        </span>
      </div>
      <div style={styles.rowActions}>
        {hovered && (
          <button
            data-action-btn=""
            style={styles.actionBtn}
            title={t('Rollback all files in folder')}
            onClick={(e) => { e.stopPropagation(); onRollback(allFiles); }}
          >
            <Codicon name="discard" />
          </button>
        )}
        <span style={styles.dirCount}>{allFiles.length}</span>
      </div>
    </div>
  );
}

// ── Single file row ────────────────────────────────────────────────────────

function FileRow({ file, depth = 0, ...shared }: { file: FileStatus; depth?: number } & SharedProps) {
  const { repoId, repoName, repoRootPath, selectedFile, ctxFile, onSelect, onToggleFile, isFileSelected, onContextMenu, onOpenFile, onRollback, onResolveMerge, iconTheme, basePad, speedSearchQuery, activeSpeedSearchKey } = shared;
  const itemKey = scopedKey(repoId, file.path);
  const isSelected = selectedFile?.repoId === file.repoId && selectedFile.path === file.path;
  const isCtxActive = !isSelected && ctxFile?.repoId === file.repoId && ctxFile.path === file.path;
  const isSpeedSearchActive = activeSpeedSearchKey === itemKey;
  const checked = isFileSelected(repoId, file.path);
  const color = STATUS_COLORS[file.status] ?? 'var(--vscode-foreground)';
  const letter = STATUS_LETTERS[file.status] ?? 'M';
  const isRepoRootChange = file.path === '.';
  const fileName = isRepoRootChange ? repoName : (file.path.split('/').pop() ?? file.path);
  const dir = isRepoRootChange
    ? repoRootPath ?? repoName
    : (() => { const p = file.path.split('/'); return p.length > 1 ? p.slice(0, -1).join('/') : ''; })();
  const [hovered, setHovered] = useState(false);

  const isSubmodule = file.status === 'submodule';
  const canOpenFile = !isSubmodule && !isRepoRootChange;

  return (
    <div
      data-speed-search-key={itemKey}
      style={{ ...styles.row(isSelected, isCtxActive, hovered), paddingLeft: `${basePad + depth * LEVEL_PAD}px` }}
      onClick={isSubmodule || isRepoRootChange ? undefined : () => onSelect(file)}
      onContextMenu={(e) => { e.preventDefault(); onContextMenu(e, file); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={isRepoRootChange ? `${fileName}\n${dir}` : file.path}
    >
      <Checkbox
        checked={checked}
        onChange={() => onToggleFile(repoId, file.path)}
        onClick={(e) => e.stopPropagation()}
      />
      {isRepoRootChange ? (
        <Codicon name="repo" style={{ fontSize: `${ICON_SIZE}px`, flexShrink: 0 }} />
      ) : (
        <FileIcon name={fileName} theme={iconTheme} size={ICON_SIZE} />
      )}
      <div style={styles.fileNameGroup}>
        <span style={styles.fileName(color)}>
          <HighlightedText text={fileName} query={speedSearchQuery} isActive={isSpeedSearchActive} />
        </span>
        {depth === 0 && dir && (
          <span style={styles.dirPath} title={dir}>
            <HighlightedText text={dir} query={speedSearchQuery} />
          </span>
        )}
      </div>
      <div style={styles.rowActions}>
        {hovered && !isSubmodule && <>
          {file.status === 'conflicted' && (
            <button
              data-action-btn=""
              style={{ ...styles.actionBtn, color: 'var(--vscode-gitDecoration-conflictingResourceForeground)' }}
              title={t('Resolve Conflicts')}
              onClick={(e) => { e.stopPropagation(); onResolveMerge(file); }}
            >
              <Codicon name="git-merge" />
            </button>
          )}
          {canOpenFile && (
            <button
              data-action-btn=""
              style={styles.actionBtn}
              title={t('Open file')}
              onClick={(e) => { e.stopPropagation(); onOpenFile(file); }}
            >
              <Codicon name="go-to-file" />
            </button>
          )}
          <button
            data-action-btn=""
            style={styles.actionBtn}
            title={t('Rollback')}
            onClick={(e) => { e.stopPropagation(); onRollback([file]); }}
          >
              <Codicon name="discard" />
            </button>
        </>}
        <span style={styles.statusLetter(color)}>{letter}</span>
        {file.staged && <span style={styles.stagedDot} title={t('Already staged')} />}
      </div>
    </div>
  );
}

// ── Public component ───────────────────────────────────────────────────────

export function FileTree({ repoId, repoName, repoRootPath, files, iconTheme, selectedFile, ctxFile, onSelect, onToggleFile, onSetFiles, isFileSelected, isCollapsed, toggleCollapsed, collapsedKeys: propCollapsedKeys, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge, viewMode, basePad = DEFAULT_BASE_PAD, activeFolderPath, speedSearchQuery, activeSpeedSearchKey }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const storeCollapsedKeys = useCommitStore(s => s.collapsedKeys);
  const activeCollapsedKeys = propCollapsedKeys ?? storeCollapsedKeys;

  const nodes = useMemo(() => viewMode === 'tree' ? buildTree(files) : [], [files, viewMode]);

  const flatItems: FlatTreeItem[] = useMemo(() => {
    if (viewMode === 'flat') {
      return files.map(file => ({
        kind: 'file' as const,
        file,
        depth: 0,
        key: `${file.repoId}-${file.path}`,
      }));
    }
    return flattenVisibleTree(nodes, repoId, isCollapsed, activeCollapsedKeys, 0);
  }, [files, isCollapsed, nodes, repoId, viewMode, activeCollapsedKeys]);

  useEffect(() => {
    if (containerRef.current) {
      const parent = containerRef.current.closest<HTMLElement>('.versiondock-commit-scroll-container')
        ?? containerRef.current.parentElement;
      setScrollEl(parent);
    }
  }, []);

  const shouldVirtualize = flatItems.length > VIRTUALIZE_THRESHOLD && Boolean(scrollEl);

  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? flatItems.length : 0,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_HEIGHT,
    scrollMargin: containerRef.current?.offsetTop ?? 0,
    overscan: 10,
    enabled: shouldVirtualize,
  });

  if (files.length === 0) return null;

  const shared: SharedProps = { repoId, repoName, repoRootPath, iconTheme, selectedFile, ctxFile, onSelect, onToggleFile, onSetFiles, isFileSelected, isCollapsed, toggleCollapsed, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge, basePad, activeFolderPath, speedSearchQuery, activeSpeedSearchKey };

  if (shouldVirtualize) {
    const virtualItems = virtualizer.getVirtualItems();
    return (
      <div ref={containerRef} style={{ ...styles.container, height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualItems.map((virtualRow) => {
          const item = flatItems[virtualRow.index];
          if (!item) return null;
          return (
            <div
              key={item.key}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                height: `${ROW_HEIGHT}px`,
                transform: `translateY(${virtualRow.start - virtualizer.options.scrollMargin}px)`,
              }}
            >
              {item.kind === 'dir' ? (
                <TreeDirRow node={item.node} depth={item.depth} {...shared} />
              ) : (
                <FileRow file={item.file} depth={item.depth} {...shared} />
              )}
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={containerRef} style={styles.container}>
      {flatItems.map((item) =>
        item.kind === 'dir' ? (
          <TreeDirRow key={item.key} node={item.node} depth={item.depth} {...shared} />
        ) : (
          <FileRow key={item.key} file={item.file} depth={item.depth} {...shared} />
        )
      )}
    </div>
  );
}

// ── Styles ─────────────────────────────────────────────────────────────────

const styles = {
  container: { display: 'flex', flexDirection: 'column' as const },
  checkbox: { flexShrink: 0, margin: '0 3px 0 0', accentColor: 'var(--vscode-button-background)' } as React.CSSProperties,
  row: (selected: boolean, ctxActive = false, hovered = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    paddingRight: '8px',
    cursor: 'pointer',
    background: selected
      ? 'var(--vscode-list-activeSelectionBackground)'
      : ctxActive
        ? 'var(--vscode-list-inactiveSelectionBackground)'
        : hovered
          ? 'var(--vscode-list-hoverBackground)'
          : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    borderRadius: '2px',
    minHeight: '22px',
    fontSize: '12px',
    gap: '3px',
  }),
  fileNameGroup: {
    display: 'flex',
    alignItems: 'baseline',
    gap: '4px',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  fileName: (color: string): React.CSSProperties => ({
    color,
    flexShrink: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    maxWidth: '100%',
  }),
  dirPath: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 1,
    minWidth: 0,
  },
  statusLetter: (color: string): React.CSSProperties => ({
    fontSize: '11px',
    fontWeight: 'bold',
    color,
    flexShrink: 0,
    width: '14px',
    textAlign: 'center',
    marginLeft: '6px',
  }),
  stagedDot: {
    width: '5px',
    height: '5px',
    borderRadius: '50%',
    background: 'var(--vscode-gitDecoration-addedResourceForeground)',
    flexShrink: 0,
    marginLeft: '1px',
  } as React.CSSProperties,
  treeDir: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    overflow: 'hidden',
    minHeight: '22px',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    paddingRight: '8px',
    gap: '0',
    cursor: 'pointer',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  treeDirInner: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    cursor: 'pointer',
    userSelect: 'none' as const,
    paddingLeft: '2px',
  },
  folderChevron: { fontSize: '12px', width: '12px', flexShrink: 0 },
  folderName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  dirCount: { fontSize: '11px', color: 'var(--vscode-descriptionForeground)', flexShrink: 0, minWidth: '14px', textAlign: 'center' as const, marginLeft: '6px' },
  rowActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '0',
    marginLeft: 'auto',
    marginRight: '0',
    flexShrink: 0,
  } as React.CSSProperties,
  actionBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    padding: '2px 2px',
    borderRadius: '3px',
    fontSize: '12px',
    display: 'flex',
    alignItems: 'center',
  } as React.CSSProperties,
};
