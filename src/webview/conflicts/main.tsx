import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import { FileIcon } from '../shared/FileIcon';
import { t } from '../shared/i18n';
import { WebviewErrorBoundary } from '../shared/WebviewErrorBoundary';
import { scopedKey } from '../shared/scopedKey';
import { nativeCheckboxBorderStyle } from '../shared/nativeCheckboxStyle';
import type { ConflictsToHostMsg, ConflictListFile, HostToConflictsMsg, IconThemeData } from '../../host/types/messages';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

type TreeNode = TreeDir | TreeFile;
interface TreeDir { kind: 'dir'; name: string; path: string; children: TreeNode[]; count: number; isRepoRoot?: boolean; repoColor?: string }
interface TreeFile { kind: 'file'; file: ConflictListFile }

function fileKey(file: Pick<ConflictListFile, 'repoId' | 'path'>): string {
  return scopedKey(file.repoId, file.path);
}

const TREE_BASE_PAD = 6;
const TREE_LEVEL_PAD = 16;
const TREE_FILE_SPACER = 14;

const INTERACTION_STYLE = `
.versiondock-conflicts-dir-row:hover,
.versiondock-conflicts-file-row[data-selected="false"]:hover {
  background: var(--vscode-list-hoverBackground) !important;
}
`;

function buildTree(files: ConflictListFile[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [], count: 0 };
  for (const file of files) {
    // Encode the repository id before composing directory keys. Without this,
    // a nested repo root could collide with a parent repo directory path.
    const repoPath = `repo:${encodeURIComponent(file.repoId)}`;
    let repoNode = root.children.find((item): item is TreeDir => item.kind === 'dir' && item.path === repoPath);
    if (!repoNode) {
      repoNode = { kind: 'dir', name: file.repoName, path: repoPath, children: [], count: 0, isRepoRoot: true, repoColor: file.repoColor };
      root.children.push(repoNode);
    }

    const parts = file.path.split('/');
    let node = repoNode;
    node.count += 1;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      const dirPath = `${repoPath}/${parts.slice(0, i + 1).join('/')}`;
      let child = node.children.find((item): item is TreeDir => item.kind === 'dir' && item.path === dirPath);
      if (!child) {
        child = { kind: 'dir', name, path: dirPath, children: [], count: 0 };
        node.children.push(child);
      }
      child.count += 1;
      node = child;
    }
    node.children.push({ kind: 'file', file });
  }
  return collapseSingleChildDirs(sortNodes(root.children));
}

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === 'dir' ? -1 : 1;
    const leftName = left.kind === 'dir' ? left.name : left.file.path.split('/').pop() ?? left.file.path;
    const rightName = right.kind === 'dir' ? right.name : right.file.path.split('/').pop() ?? right.file.path;
    return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
  }).map(node => node.kind === 'dir' ? { ...node, children: sortNodes(node.children) } : node);
}

function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    const collapsedNode = { ...node, children };
    if (collapsedNode.isRepoRoot) return collapsedNode;
    if (children.length === 1 && children[0].kind === 'dir' && !children[0].isRepoRoot) {
      const only = children[0];
      return {
        ...only,
        name: `${node.name}/${only.name}`,
      };
    }
    return collapsedNode;
  });
}

function flattenTree(nodes: TreeNode[], collapsed: Record<string, boolean>): ConflictListFile[] {
  const result: ConflictListFile[] = [];
  for (const node of nodes) {
    if (node.kind === 'file') result.push(node.file);
    else if (!collapsed[node.path]) result.push(...flattenTree(node.children, collapsed));
  }
  return result;
}

function App() {
  const [files, setFiles] = useState<ConflictListFile[]>([]);
  const [isMerging, setIsMerging] = useState(false);
  const [operationLabel, setOperationLabel] = useState(t('Merge in progress'));
  const [loading, setLoading] = useState(true);
  const [groupByDir, setGroupByDir] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);
  const [iconTheme, setIconTheme] = useState<IconThemeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback((msg: ConflictsToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToConflictsMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      switch (msg.type) {
        case 'CONFLICTS_DATA':
          setFiles(msg.files);
          setIsMerging(msg.isMerging);
          setOperationLabel(msg.operationLabel);
          if (msg.iconTheme !== undefined) setIconTheme(msg.iconTheme ?? null);
          setLoading(false);
          break;
        case 'CONFLICTS_OP_RESULT':
          if (msg.ok) {
            setSelectedKeys([]);
            setError(null);
            send({ type: 'CONFLICTS_REQUEST_DATA' });
          } else {
            setError(msg.error ?? t('Operation failed'));
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    send({ type: 'CONFLICTS_REQUEST_DATA' });
    return () => window.removeEventListener('message', handler);
  }, [send]);

  const tree = useMemo(() => buildTree(files), [files]);
  const conflictRepoCount = useMemo(() => new Set(files.map(file => file.repoId)).size, [files]);
  const conflictRepoSummary = conflictRepoCount === 1
    ? t('{0} repository', conflictRepoCount)
    : t('{0} repositories', conflictRepoCount);
  const conflictCountSummary = conflictRepoCount > 0
    ? `${conflictRepoSummary} ${t('·')} ${t('{0} files are in conflict', files.length)}`
    : t('{0} files are in conflict', files.length);
  const visibleFiles = useMemo(() => {
    if (!groupByDir) {
      return [...files].sort((left, right) => {
        const leftName = left.path.split('/').pop() ?? left.path;
        const rightName = right.path.split('/').pop() ?? right.path;
        return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
      });
    }
    return flattenTree(tree, collapsed);
  }, [collapsed, files, groupByDir, tree]);

  const selectedKeySet = useMemo(() => new Set(selectedKeys), [selectedKeys]);
  const selectedFiles = useMemo(
    () => files.filter(file => selectedKeySet.has(fileKey(file))),
    [files, selectedKeySet],
  );
  const hasSelection = selectedFiles.length > 0;

  const selectFile = useCallback((file: ConflictListFile, event: React.MouseEvent) => {
    const key = fileKey(file);
    if (event.shiftKey && lastSelectedKey) {
      const start = visibleFiles.findIndex(item => fileKey(item) === lastSelectedKey);
      const end = visibleFiles.findIndex(item => fileKey(item) === key);
      if (start >= 0 && end >= 0) {
        const min = Math.min(start, end);
        const max = Math.max(start, end);
        setSelectedKeys(visibleFiles.slice(min, max + 1).map(fileKey));
      } else {
        setSelectedKeys([key]);
      }
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedKeys(prev => prev.includes(key) ? prev.filter(item => item !== key) : [...prev, key]);
    } else {
      setSelectedKeys([key]);
    }
    setLastSelectedKey(key);
  }, [lastSelectedKey, visibleFiles]);

  const openMergeEditor = useCallback((file: ConflictListFile) => {
    send({ type: 'CONFLICTS_OPEN_MERGE_EDITOR', repoId: file.repoId, filePath: file.path });
  }, [send]);

  const accept = useCallback((side: 'ours' | 'theirs') => {
    if (!hasSelection) return;
    const requestId = generateId();
    const payload = selectedFiles.map(file => ({ repoId: file.repoId, path: file.path }));
    send(side === 'ours'
      ? { type: 'CONFLICTS_ACCEPT_OURS', requestId, files: payload }
      : { type: 'CONFLICTS_ACCEPT_THEIRS', requestId, files: payload });
  }, [hasSelection, selectedFiles, send]);

  if (loading) {
    return <div style={styles.loading}>{t('Loading conflicts...')}</div>;
  }

  return (
    <div style={styles.app}>
      <style>{INTERACTION_STYLE}</style>
      <div style={styles.header}>
        <h2 style={styles.title}>{t('Conflicts')}</h2>
        <div style={styles.subtitle}>{isMerging ? operationLabel : t('No merge in progress')}</div>
        <div style={styles.count}>{conflictCountSummary}</div>
        <label style={styles.checkboxLabel}>
          <input type="checkbox" checked={groupByDir} onChange={event => setGroupByDir(event.currentTarget.checked)} style={nativeCheckboxBorderStyle()} />
          {t('Group by directory')}
        </label>
      </div>

      {error && <div style={styles.error}>{error}</div>}

      {files.length === 0 ? (
        <div style={styles.empty}>{t('All conflicts resolved')}</div>
      ) : (
        <div style={styles.body}>
          <div style={styles.table} onContextMenu={event => event.preventDefault()}>
            <div style={styles.tableHeader}>
              <span style={styles.nameHeader}>{t('Name')}</span>
              <span style={styles.statusHeader}>{t('Current')}</span>
              <span style={styles.statusHeader}>{t('Incoming')}</span>
            </div>
            <div style={styles.treeScroller}>
              {groupByDir
                ? tree.map(node => (
                    <TreeRow
                      key={node.kind === 'dir' ? node.path : fileKey(node.file)}
                      node={node}
                      depth={0}
                      collapsed={collapsed}
                      selectedKeys={selectedKeySet}
                      iconTheme={iconTheme}
                      onToggle={path => setCollapsed(prev => ({ ...prev, [path]: !prev[path] }))}
                      onSelect={selectFile}
                      onOpen={openMergeEditor}
                    />
                  ))
                : visibleFiles.map(file => (
                    <FileRow key={fileKey(file)} file={file} depth={0} selected={selectedKeySet.has(fileKey(file))} iconTheme={iconTheme} onSelect={selectFile} onOpen={openMergeEditor} />
                  ))}
            </div>
          </div>
          <div style={styles.actions}>
            <ActionButton disabled={!hasSelection} onClick={() => accept('ours')}>{t('Accept Current')}</ActionButton>
            <ActionButton disabled={!hasSelection} onClick={() => accept('theirs')}>{t('Accept Incoming')}</ActionButton>
            <ActionButton disabled={!hasSelection} primary onClick={() => selectedFiles[0] && openMergeEditor(selectedFiles[0])}>{t('Merge')}...</ActionButton>
          </div>
        </div>
      )}
    </div>
  );
}

function TreeRow({ node, depth, collapsed, selectedKeys, iconTheme, onToggle, onSelect, onOpen }: {
  node: TreeNode;
  depth: number;
  collapsed: Record<string, boolean>;
  selectedKeys: ReadonlySet<string>;
  iconTheme: IconThemeData | null;
  onToggle: (path: string) => void;
  onSelect: (file: ConflictListFile, event: React.MouseEvent) => void;
  onOpen: (file: ConflictListFile) => void;
}) {
  if (node.kind === 'file') {
    return <FileRow file={node.file} depth={depth} selected={selectedKeys.has(fileKey(node.file))} iconTheme={iconTheme} onSelect={onSelect} onOpen={onOpen} />;
  }
  const open = !collapsed[node.path];
  const rowStyle = node.isRepoRoot ? styles.repoRootRow : styles.dirRow;
  return (
    <div>
      <div className="versiondock-conflicts-dir-row" style={{ ...rowStyle, paddingLeft: TREE_BASE_PAD + depth * TREE_LEVEL_PAD }} onClick={() => onToggle(node.path)} title={node.name}>
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.chevron} />
        {node.isRepoRoot
          ? <span style={styles.repoRootDot(node.repoColor ?? 'var(--vscode-foreground)')} />
          : <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={16} />}
        <span style={node.isRepoRoot ? styles.repoRootName : styles.dirName}>{node.isRepoRoot ? node.name.toUpperCase() : node.name}</span>
        <span style={styles.dirCount}>{node.count}</span>
      </div>
      {open && node.children.map(child => (
        <TreeRow key={child.kind === 'dir' ? child.path : fileKey(child.file)} node={child} depth={depth + 1} collapsed={collapsed} selectedKeys={selectedKeys} iconTheme={iconTheme} onToggle={onToggle} onSelect={onSelect} onOpen={onOpen} />
      ))}
    </div>
  );
}

function FileRow({ file, depth, selected, iconTheme, onSelect, onOpen }: {
  file: ConflictListFile;
  depth: number;
  selected: boolean;
  iconTheme: IconThemeData | null;
  onSelect: (file: ConflictListFile, event: React.MouseEvent) => void;
  onOpen: (file: ConflictListFile) => void;
}) {
  const fileName = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
  const displayDir = dir ? `${file.repoName}/${dir}` : file.repoName;
  return (
    <div
      className="versiondock-conflicts-file-row"
      data-selected={selected ? 'true' : 'false'}
      style={{ ...styles.fileRow(selected), paddingLeft: TREE_BASE_PAD + depth * TREE_LEVEL_PAD }}
      onClick={event => onSelect(file, event)}
      onDoubleClick={() => onOpen(file)}
      title={`${file.repoName}/${file.path}`}
    >
      <span style={styles.fileSpacer} />
      <FileIcon name={fileName} theme={iconTheme} size={16} />
      <span style={styles.fileName}>{fileName}</span>
      {depth === 0 && <span style={styles.dirPath}>{displayDir}</span>}
      <StatusCell status={file.currentStatus} first />
      <StatusCell status={file.incomingStatus} />
    </div>
  );
}

function StatusCell({ status, first }: { status: ConflictListFile['currentStatus']; first?: boolean }) {
  const label = status === 'added' ? t('Added') : status === 'deleted' ? t('Deleted') : t('Modified');
  return <span style={styles.statusText(status, first)}>{label}</span>;
}

function ActionButton({ children, disabled, primary, onClick }: { children: React.ReactNode; disabled?: boolean; primary?: boolean; onClick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} style={styles.actionButton(primary, disabled)}>
      {children}
    </button>
  );
}

const styles = {
  app: { display: 'flex', flexDirection: 'column' as const, height: '100vh', background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)', fontFamily: 'var(--vscode-font-family)', overflow: 'hidden' },
  loading: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--vscode-editor-background)', color: 'var(--vscode-descriptionForeground)' },
  header: { padding: '14px 16px 10px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 },
  title: { margin: 0, fontSize: 18, lineHeight: '24px' },
  subtitle: { marginTop: 4, fontSize: 13, fontWeight: 600, color: 'var(--vscode-descriptionForeground)' },
  count: { marginTop: 4, fontSize: 12, color: 'var(--vscode-descriptionForeground)' },
  checkboxLabel: { display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: 12 },
  error: { padding: '6px 12px', color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)', borderBottom: '1px solid var(--vscode-inputValidation-errorBorder)', fontSize: 12 },
  empty: { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--vscode-descriptionForeground)' },
  body: { flex: 1, display: 'flex', minHeight: 0 },
  table: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' as const },
  tableHeader: { minHeight: 28, display: 'flex', alignItems: 'center', borderBottom: '1px solid var(--vscode-panel-border)', padding: '4px 10px 4px 12px', fontSize: 12, fontWeight: 600, color: 'var(--vscode-descriptionForeground)' },
  nameHeader: { flex: 1, minWidth: 0 },
  statusHeader: { width: 86, textAlign: 'center' as const, flexShrink: 0 },
  treeScroller: { flex: 1, overflow: 'auto', paddingTop: 2 },
  dirRow: { minHeight: 22, display: 'flex', alignItems: 'center', gap: 4, padding: '2px 10px 2px 0', cursor: 'pointer', userSelect: 'none' as const, fontSize: 13, color: 'var(--vscode-foreground)', minWidth: 0, overflow: 'hidden' } as React.CSSProperties,
  repoRootRow: { minHeight: 24, display: 'flex', alignItems: 'center', gap: 5, padding: '3px 10px 3px 0', cursor: 'pointer', userSelect: 'none' as const, color: 'var(--vscode-foreground)', minWidth: 0, overflow: 'hidden' } as React.CSSProperties,
  chevron: { width: 14, height: 14, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 },
  dirName: { flex: 1, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 },
  repoRootDot: (color: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  repoRootName: { flex: 1, fontSize: 11, lineHeight: '16px', fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.04em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 } as React.CSSProperties,
  dirCount: { marginLeft: 'auto', minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'var(--versiondock-badge-background)', color: 'var(--versiondock-badge-foreground)', fontSize: 10, fontWeight: 700, lineHeight: '18px', flexShrink: 0 } as React.CSSProperties,
  fileRow: (selected: boolean): React.CSSProperties => ({ minHeight: 22, display: 'flex', alignItems: 'center', gap: 4, padding: '2px 10px 2px 0', cursor: 'pointer', background: selected ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent', color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)', fontSize: 13, userSelect: 'none' }),
  fileSpacer: { width: TREE_FILE_SPACER, height: 14, flexShrink: 0 } as React.CSSProperties,
  fileName: { whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1 },
  dirPath: { marginLeft: 8, color: 'var(--vscode-descriptionForeground)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0, maxWidth: '45%' },
  statusText: (status: ConflictListFile['currentStatus'], first?: boolean): React.CSSProperties => ({ marginLeft: first ? 'auto' : 0, width: 86, textAlign: 'center' as const, color: status === 'deleted' ? 'var(--vscode-descriptionForeground)' : status === 'added' ? 'var(--vscode-gitDecoration-addedResourceForeground, #57a64a)' : 'var(--vscode-gitDecoration-conflictingResourceForeground, #ff7b72)', fontSize: 11, fontWeight: 600, padding: '0 4px', whiteSpace: 'nowrap' as const, flexShrink: 0 }),
  actions: { width: 132, flexShrink: 0, display: 'flex', flexDirection: 'column' as const, gap: 8, padding: 12, borderLeft: '1px solid var(--vscode-panel-border)' },
  actionButton: (primary?: boolean, disabled?: boolean): React.CSSProperties => ({ padding: '5px 10px', border: '1px solid var(--vscode-button-border, transparent)', borderRadius: 3, background: primary ? 'var(--vscode-button-background)' : 'var(--vscode-button-secondaryBackground)', color: primary ? 'var(--vscode-button-foreground)' : 'var(--vscode-button-secondaryForeground)', opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer', fontSize: 12 }),
};

createRoot(document.getElementById('root')!).render(
  <WebviewErrorBoundary
    title={t('Conflicts view render failed')}
    onError={(error, componentStack) => {
      getVsCodeApi().postMessage({
        type: 'CONFLICTS_WEBVIEW_ERROR',
        message: error.message,
        stack: error.stack,
        componentStack,
      } satisfies ConflictsToHostMsg);
    }}
  >
    <App />
  </WebviewErrorBoundary>,
);
