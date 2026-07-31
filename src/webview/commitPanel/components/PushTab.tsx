import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { PushCommitFile, UnpushedCommit } from '../../shared/msgTypes';
import type { RepoStatus, RepoMeta } from '../../shared/types';
import type { IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { branchInfoColor } from '../../shared/branchColors';
import { t } from '../../shared/i18n';
import { baseNameFromPath } from '../../shared/pathUtils';
import { nativeCheckboxBorderStyle } from '../../shared/nativeCheckboxStyle';

interface Props {
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
  iconTheme?: IconThemeData | null;
  unpushedMap: Record<string, { loading: boolean; commits: UnpushedCommit[]; error?: string }>;
  onPush: (repoId: string) => void;
  onPushAll: () => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  onRequestCommitFiles: (repoId: string, hash: string) => Promise<PushCommitFile[]>;
  onOpenCommitFile: (repoId: string, hash: string, file: PushCommitFile) => void;
  onSquash: (repoId: string, hashes: string[], oldestHash: string, combinedMessage: string, commits: { hash: string; shortHash: string; message: string }[]) => void;
  onDropCommits: (repoId: string, hashes: string[], oldestHash: string) => void;
  onRevertCommits: (repoId: string, hashes: string[]) => void;
  onEditCommitMsg: (repoId: string, hash: string, currentMessage: string) => void;
}

type PushViewMode = 'commits' | 'changes';
type PushFileViewMode = 'tree' | 'flat';

interface FileTreeDir {
  kind: 'dir';
  name: string;
  path: string;
  children: FileTreeNode[];
  fileCount: number;
}

interface FileTreeLeaf {
  kind: 'file';
  name: string;
  file: PushCommitFile;
}

type FileTreeNode = FileTreeDir | FileTreeLeaf;

interface CommitCtxMenuState {
  x: number;
  y: number;
  repoId: string;
  selectedHashes: string[];
  commits: UnpushedCommit[];
  isHead: boolean;
  singleHash: string | null;
}

const TREE_BASE_PAD = 16;
const TREE_LEVEL_PAD = 18;
const ICON_SIZE = 16;

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return t('just now');
    if (diffMin < 60) return t('{0}m ago', diffMin);
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return t('{0}h ago', diffH);
    const diffD = Math.floor(diffH / 24);
    if (diffD < 7) return t('{0}d ago', diffD);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: diffD > 365 ? 'numeric' : undefined });
  } catch { return iso; }
}

function formatFileCount(count: number): string {
  return count === 1 ? t('{0} file', count) : t('{0} files', count);
}

function splitCommitBody(body?: string): { bodyText: string; footerText: string } {
  const text = body?.trim() ?? '';
  if (!text) return { bodyText: '', footerText: '' };

  const lines = text.split(/\r?\n/);
  let splitIndex = lines.length;
  const footerPattern = /^(?:[A-Za-z][A-Za-z0-9-]*(?:-[A-Za-z0-9]+)*|BREAKING CHANGE):\s.+$/;

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) {
      if (splitIndex < lines.length) break;
      continue;
    }
    if (footerPattern.test(line)) {
      splitIndex = i;
      continue;
    }
    break;
  }

  if (splitIndex === lines.length) return { bodyText: text, footerText: '' };
  return {
    bodyText: lines.slice(0, splitIndex).join('\n').trim(),
    footerText: lines.slice(splitIndex).join('\n').trim(),
  };
}

function normalizeStatus(status: string): string {
  const code = status.charAt(0).toUpperCase();
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'C') return 'copied';
  return 'modified';
}

function statusLetter(status: string): string {
  const code = status.charAt(0).toUpperCase();
  if (code === 'A' || code === 'D' || code === 'R' || code === 'C') return code;
  return 'M';
}

function statusColor(status: string): string {
  switch (normalizeStatus(status)) {
    case 'added':
    case 'copied':
      return 'var(--vscode-gitDecoration-addedResourceForeground)';
    case 'deleted':
      return 'var(--vscode-gitDecoration-deletedResourceForeground)';
    case 'renamed':
      return 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)';
    default:
      return 'var(--vscode-gitDecoration-modifiedResourceForeground)';
  }
}

function fileNameOf(path: string): string {
  return path.split('/').pop() ?? path;
}

function directoryOf(path: string): string {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
}

function sortNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const node of nodes) {
    if (node.kind === 'dir') sortNodes(node.children);
  }
}

function computeFileCount(node: FileTreeDir): number {
  let count = 0;
  for (const child of node.children) {
    count += child.kind === 'file' ? 1 : computeFileCount(child);
  }
  node.fileCount = count;
  return count;
}

function collapseSingleChildDirs(nodes: FileTreeNode[]): FileTreeNode[] {
  return nodes.map(node => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0];
      return {
        kind: 'dir',
        name: `${node.name}/${only.name}`,
        path: only.path,
        children: only.children,
        fileCount: only.fileCount,
      };
    }
    return { ...node, children };
  });
}

function buildFileTree(files: PushCommitFile[]): FileTreeNode[] {
  const root: FileTreeDir = { kind: 'dir', name: '', path: '', children: [], fileCount: 0 };
  for (const file of files) {
    const parts = file.path.split('/').filter(Boolean);
    if (parts.length === 0) continue;
    let current = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = current.children.find((node): node is FileTreeDir => node.kind === 'dir' && node.name === part);
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, children: [], fileCount: 0 };
        current.children.push(child);
      }
      current = child;
    }
    current.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  sortNodes(root.children);
  computeFileCount(root);
  return collapseSingleChildDirs(root.children);
}

function collectDirectoryKeys(files: PushCommitFile[]): string[] {
  const keys: string[] = [];
  const walk = (nodes: FileTreeNode[]) => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue;
      keys.push(node.path);
      walk(node.children);
    }
  };
  walk(buildFileTree(files));
  return keys;
}

function mergeUniqueFiles(fileGroups: PushCommitFile[][]): PushCommitFile[] {
  const merged = new Map<string, PushCommitFile>();
  for (const files of fileGroups) {
    for (const file of files) {
      if (!merged.has(file.path)) merged.set(file.path, file);
    }
  }
  return [...merged.values()];
}

function findSourceCommitHash(commits: UnpushedCommit[], filesByHash: Record<string, PushCommitFile[]>, file: PushCommitFile): string | null {
  for (const commit of commits) {
    if ((filesByHash[commit.hash] ?? []).some(item => item.path === file.path)) return commit.hash;
  }
  return null;
}

function MenuItem({ icon, label, danger, onClick }: { icon: string; label: string; danger?: boolean; onClick: () => void }) {
  return (
    <div
      style={{ ...ctxStyles.item, ...(danger ? { color: 'var(--vscode-errorForeground)' } : {}) }}
      onMouseEnter={event => (event.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
      onMouseLeave={event => (event.currentTarget.style.background = 'transparent')}
      onClick={onClick}
    >
      <Codicon name={icon} style={{ fontSize: '13px', opacity: 0.8 }} />
      {label}
    </div>
  );
}

function CommitContextMenu({ state, onSquash, onDropCommits, onRevertCommits, onEditMsg, onUndo, onRevertSingle, onDropSingle, onViewInLog, onClose }: {
  state: CommitCtxMenuState;
  onSquash: () => void;
  onDropCommits: () => void;
  onRevertCommits: () => void;
  onEditMsg: () => void;
  onUndo: () => void;
  onRevertSingle: () => void;
  onDropSingle: () => void;
  onViewInLog: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const n = state.selectedHashes.length;

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const [pos, setPos] = useState({ x: state.x, y: state.y });

  useEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos({
      x: state.x + rect.width > vw ? Math.max(0, vw - rect.width - 4) : state.x,
      y: state.y + rect.height > vh ? Math.max(0, vh - rect.height - 4) : state.y,
    });
  }, [state.x, state.y]);

  const wrap = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div ref={ref} style={{ ...ctxStyles.menu, left: pos.x, top: pos.y }} onContextMenu={event => event.preventDefault()}>
      {n === 1 && (
        <>
          <MenuItem icon="go-to-file" label={t('View in Git Log')} onClick={wrap(onViewInLog)} />
          {state.isHead && <MenuItem icon="edit" label={t('Edit Commit Message…')} onClick={wrap(onEditMsg)} />}
          <MenuItem icon="discard" label={t('Revert Commit')} onClick={wrap(onRevertSingle)} />
          {state.isHead && (
            <>
              <div style={ctxStyles.separator} />
              <MenuItem icon="arrow-left" label={t('Undo Commit')} onClick={wrap(onUndo)} />
              <MenuItem icon="trash" label={t('Drop Commit')} danger onClick={wrap(onDropSingle)} />
            </>
          )}
        </>
      )}
      {n >= 2 && (
        <>
          <MenuItem icon="discard" label={t('Revert {0} commits', n)} onClick={wrap(onRevertCommits)} />
          <div style={ctxStyles.separator} />
          <MenuItem icon="trash" label={t('Drop {0} commits', n)} danger onClick={wrap(onDropCommits)} />
          <MenuItem icon="fold" label={t('Squash {0} commits…', n)} onClick={wrap(onSquash)} />
        </>
      )}
    </div>
  );
}

function CommitRow({ commit, repoId, isHead, expanded, selected, files, loadingFiles, fileViewMode, iconTheme, onToggle, onSelect, onContextMenu, onFileViewModeChange, onOpenFile, onOpenInLog, onUndoCommit }: {
  commit: UnpushedCommit;
  repoId: string;
  isHead: boolean;
  expanded: boolean;
  selected: boolean;
  files: PushCommitFile[];
  loadingFiles: boolean;
  fileViewMode: PushFileViewMode;
  iconTheme?: IconThemeData | null;
  onToggle: () => void;
  onSelect: (event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent) => void;
  onFileViewModeChange: (mode: PushFileViewMode) => void;
  onOpenFile: (file: PushCommitFile) => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const { bodyText, footerText } = splitCommitBody(commit.body);
  const hasBody = bodyText.length > 0 || footerText.length > 0;
  let background = 'transparent';
  if (selected) background = 'var(--vscode-list-inactiveSelectionBackground)';
  else if (hovered) background = 'var(--vscode-list-hoverBackground)';

  const handleRowClick = (event: React.MouseEvent) => {
    if (event.ctrlKey || event.metaKey) {
      onSelect(event);
      return;
    }
    onToggle();
  };

  return (
    <div style={styles.commitCard(expanded, selected)}>
      <div
        data-commit-row="true"
        role="button"
        tabIndex={0}
        style={{ ...styles.commitRow, background }}
        onClick={handleRowClick}
        onContextMenu={onContextMenu}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggle();
          }
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <span style={styles.commitHash}>{commit.shortHash}</span>
        <span style={styles.commitMessage} title={hasBody ? `${commit.message}\n\n${commit.body}` : commit.message}>{commit.message}</span>
        <span style={styles.commitMeta}>
          {commit.author} · {formatDate(commit.date)}
          {commit.filesChanged != null && (
            <span style={styles.commitStats}>
              &nbsp;·&nbsp;{formatFileCount(commit.filesChanged)}
              {commit.additions != null && commit.additions > 0 && <span style={styles.statAdd}>&nbsp;+{commit.additions}</span>}
              {commit.deletions != null && commit.deletions > 0 && <span style={styles.statDel}>&nbsp;-{commit.deletions}</span>}
            </span>
          )}
        </span>
        <div style={styles.commitActions(hovered || expanded || selected)}>
          {isHead && (
            <button
              data-action-btn=""
              style={styles.actionBtn}
              title={t('Undo this commit (keeps changes as unstaged)')}
              onClick={event => { event.stopPropagation(); onUndoCommit(repoId); }}
            >
              <Codicon name="arrow-left" style={{ fontSize: '16px' }} />
            </button>
          )}
          <button
            data-action-btn=""
            style={styles.actionBtn}
            title={t('Open in Log')}
            onClick={event => { event.stopPropagation(); onOpenInLog(commit.hash, repoId); }}
          >
            <Codicon name="go-to-file" style={{ fontSize: '16px' }} />
          </button>
        </div>
      </div>

      {expanded && (
        <div style={styles.commitDetails}>
          {hasBody && (
            <div style={styles.messagePanel}>
              <div style={styles.bodyBlock}>
                {bodyText && <div style={styles.bodyText}>{bodyText}</div>}
                {footerText && <pre style={styles.footerText(bodyText.length > 0)}>{footerText}</pre>}
              </div>
            </div>
          )}
          <PushFileList
            files={files}
            loading={loadingFiles}
            viewMode={fileViewMode}
            iconTheme={iconTheme}
            onViewModeChange={onFileViewModeChange}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </div>
  );
}

function PushFileList({ files, loading, viewMode, iconTheme, onViewModeChange, onOpenFile, description }: {
  files: PushCommitFile[];
  loading: boolean;
  viewMode: PushFileViewMode;
  iconTheme?: IconThemeData | null;
  onViewModeChange: (mode: PushFileViewMode) => void;
  onOpenFile: (file: PushCommitFile) => void;
  description?: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const directoryKeys = useMemo(() => collectDirectoryKeys(files), [files]);
  const canToggleFolders = viewMode === 'tree' && directoryKeys.length > 0;

  useEffect(() => {
    setCollapsed({});
  }, [files]);

  const collapseAllFolders = () => {
    if (!canToggleFolders) return;
    setCollapsed(Object.fromEntries(directoryKeys.map(key => [key, true])));
  };

  return (
    <div style={styles.fileListRoot}>
      {description && <div style={styles.fileListDescription}>{description}</div>}
      <div style={styles.filesHeader}>
        <span style={styles.filesTitle}>{loading ? '' : formatFileCount(files.length)}</span>
        <div style={styles.filesHeaderActions}>
          <div style={styles.expandBtns}>
            <button
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(false, !canToggleFolders)}
              title={t('Expand all')}
              disabled={!canToggleFolders}
              onClick={() => {
                if (!canToggleFolders) return;
                setCollapsed({});
              }}
            >
              <Codicon name="expand-all" style={{ fontSize: '13px' }} />
            </button>
            <button
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(false, !canToggleFolders)}
              title={t('Collapse all')}
              disabled={!canToggleFolders}
              onClick={collapseAllFolders}
            >
              <Codicon name="collapse-all" style={{ fontSize: '13px' }} />
            </button>
          </div>
          <div style={styles.viewToggle}>
            <button
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(viewMode === 'tree', false)}
              title={t('Tree view')}
              onClick={() => onViewModeChange('tree')}
            >
              <Codicon name="list-tree" style={{ fontSize: '13px' }} />
            </button>
            <button
              data-action-btn=""
              type="button"
              style={styles.toolbarButton(viewMode === 'flat', false)}
              title={t('Flat list')}
              onClick={() => onViewModeChange('flat')}
            >
              <Codicon name="list-flat" style={{ fontSize: '13px' }} />
            </button>
          </div>
        </div>
      </div>
      {loading ? (
        <div style={styles.loadingRow}>{t('Loading files...')}</div>
      ) : files.length === 0 ? (
        <div style={styles.loadingRow}>{t('No changed files')}</div>
      ) : viewMode === 'tree' ? (
        <div style={styles.treeRoot}>
          {buildFileTree(files).map(node => (
            <PushFileTreeNode
              key={node.kind === 'dir' ? node.path : node.file.path}
              node={node}
              depth={0}
              collapsed={collapsed}
              iconTheme={iconTheme}
              onToggle={key => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))}
              onOpenFile={onOpenFile}
            />
          ))}
        </div>
      ) : (
        <div style={styles.treeRoot}>
          {files.map(file => (
            <PushFileRow key={file.path} file={file} depth={0} iconTheme={iconTheme} onOpenFile={onOpenFile} />
          ))}
        </div>
      )}
    </div>
  );
}

function PushFileTreeNode({ node, depth, collapsed, iconTheme, onToggle, onOpenFile }: {
  node: FileTreeNode;
  depth: number;
  collapsed: Record<string, boolean>;
  iconTheme?: IconThemeData | null;
  onToggle: (key: string) => void;
  onOpenFile: (file: PushCommitFile) => void;
}) {
  if (node.kind === 'file') {
    return <PushFileRow file={node.file} depth={depth} iconTheme={iconTheme} onOpenFile={onOpenFile} />;
  }

  const open = !collapsed[node.path];
  return (
    <div>
      <div style={styles.dirRow(depth)} onClick={() => onToggle(node.path)} title={node.path}>
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.folderChevron} />
        <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={ICON_SIZE} />
        <span style={styles.folderName}>{node.name}</span>
        <span style={styles.fileCountBadge}>{node.fileCount}</span>
      </div>
      {open && node.children.map(child => (
        <PushFileTreeNode
          key={child.kind === 'dir' ? child.path : child.file.path}
          node={child}
          depth={depth + 1}
          collapsed={collapsed}
          iconTheme={iconTheme}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  );
}

function PushFileRow({ file, depth, iconTheme, onOpenFile }: {
  file: PushCommitFile;
  depth: number;
  iconTheme?: IconThemeData | null;
  onOpenFile: (file: PushCommitFile) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const fileName = fileNameOf(file.path);
  const dir = directoryOf(file.path);
  const color = statusColor(file.status);

  return (
    <div
      style={styles.fileRow(depth, hovered)}
      title={file.path}
      onClick={() => onOpenFile(file)}
      onDoubleClick={() => onOpenFile(file)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FileIcon name={fileName} theme={iconTheme} size={ICON_SIZE} />
      <div style={styles.fileNameGroup}>
        <span style={styles.fileName(color)}>{fileName}</span>
        {depth === 0 && dir && <span style={styles.dirPath}>{dir}</span>}
      </div>
      <div style={styles.fileStats}>
        {typeof file.added === 'number' || typeof file.removed === 'number' ? (
          <span style={styles.lineStats}>
            {typeof file.added === 'number' && <span style={styles.added}>+{file.added}</span>}
            {typeof file.removed === 'number' && <span style={styles.removed}>-{file.removed}</span>}
          </span>
        ) : null}
        <span style={styles.statusLetter(color)}>{statusLetter(file.status)}</span>
      </div>
    </div>
  );
}

function AggregatedChangesView({ commits, filesByHash, files, loading, fileViewMode, iconTheme, onFileViewModeChange, onOpenCommitFile }: {
  commits: UnpushedCommit[];
  filesByHash: Record<string, PushCommitFile[]>;
  files: PushCommitFile[];
  loading: boolean;
  fileViewMode: PushFileViewMode;
  iconTheme?: IconThemeData | null;
  onFileViewModeChange: (mode: PushFileViewMode) => void;
  onOpenCommitFile: (hash: string, file: PushCommitFile) => void;
}) {
  return (
    <PushFileList
      files={files}
      loading={loading}
      viewMode={fileViewMode}
      iconTheme={iconTheme}
      description={t('Aggregated changes from all commits to push')}
      onViewModeChange={onFileViewModeChange}
      onOpenFile={file => {
        const hash = findSourceCommitHash(commits, filesByHash, file);
        if (hash) onOpenCommitFile(hash, file);
      }}
    />
  );
}

function RepoSection({ repoStatus, repoMeta, unpushed, checked, canCheck, onToggle, onOpenInLog, onUndoCommit, onRequestCommitFiles, onOpenCommitFile, onSquash, onDropCommits, onRevertCommits, onEditCommitMsg, iconTheme, singleRepo }: {
  repoStatus: RepoStatus;
  repoMeta: RepoMeta | undefined;
  unpushed: Props['unpushedMap'][string] | undefined;
  checked: boolean;
  canCheck: boolean;
  onToggle: (repoId: string) => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  onRequestCommitFiles: (repoId: string, hash: string) => Promise<PushCommitFile[]>;
  onOpenCommitFile: (repoId: string, hash: string, file: PushCommitFile) => void;
  onSquash: (repoId: string, hashes: string[], oldestHash: string, combinedMessage: string, commits: { hash: string; shortHash: string; message: string }[]) => void;
  onDropCommits: (repoId: string, hashes: string[], oldestHash: string) => void;
  onRevertCommits: (repoId: string, hashes: string[]) => void;
  onEditCommitMsg: (repoId: string, hash: string, currentMessage: string) => void;
  iconTheme?: IconThemeData | null;
  singleRepo?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const [pushViewMode, setPushViewMode] = useState<PushViewMode>('commits');
  const [fileViewMode, setFileViewMode] = useState<PushFileViewMode>('tree');
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  const [autoExpandedCommitsKey, setAutoExpandedCommitsKey] = useState('');
  const [filesByHash, setFilesByHash] = useState<Record<string, PushCommitFile[]>>({});
  const [loadingCommitHash, setLoadingCommitHash] = useState<string | null>(null);
  const [aggregatedFiles, setAggregatedFiles] = useState<PushCommitFile[]>([]);
  const [loadingAggregatedFiles, setLoadingAggregatedFiles] = useState(false);
  const [multiSelectHashes, setMultiSelectHashes] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<CommitCtxMenuState | null>(null);
  const [hovered, setHovered] = useState(false);

  const rawName = repoMeta?.name ?? baseNameFromPath(repoStatus.repoId) ?? repoStatus.repoId;
  const isWorktree = repoMeta?.isWorktree;
  const worktreeBranch = isWorktree
    ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
    : undefined;
  const mainRepoName = baseNameFromPath(repoMeta?.mainWorktreePath);
  const repoName = worktreeBranch ? (mainRepoName ?? rawName) : rawName;
  const branchLabel = repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name;
  const branchClr = branchInfoColor(repoStatus.branch);
  const repoColor = repoMeta?.color ?? '#4ec9b0';
  const ahead = repoStatus.branch.aheadBehind?.ahead ?? 0;
  const behind = repoStatus.branch.aheadBehind?.behind ?? 0;
  const hasUpstream = !!repoStatus.branch.upstream;
  const commits = useMemo(() => unpushed?.commits ?? [], [unpushed?.commits]);
  const commitHashesKey = commits.map(commit => commit.hash).join(',');
  const commitCount = hasUpstream ? ahead : commits.length;
  const selectedCommitFiles = expandedCommitHash ? (filesByHash[expandedCommitHash] ?? []) : [];
  const loadingSelectedCommitFiles = loadingCommitHash === expandedCommitHash;
  const canTogglePushView = commits.length > 0 && !unpushed?.loading && !unpushed?.error;
  const branchTitle = repoStatus.branch.detachedTag
    ? t('Tag: {0} (detached HEAD)', repoStatus.branch.detachedTag)
    : repoStatus.branch.detachedHash
      ? t('Detached HEAD at {0}', repoStatus.branch.detachedHash)
      : branchLabel;

  useEffect(() => {
    if (pushViewMode !== 'commits' || commits.length === 0 || !commitHashesKey) return;
    if (autoExpandedCommitsKey === commitHashesKey) return;
    setExpandedCommitHash(commits[0].hash);
    setAutoExpandedCommitsKey(commitHashesKey);
  }, [autoExpandedCommitsKey, commitHashesKey, commits, pushViewMode]);

  useEffect(() => {
    if (expandedCommitHash && commits.some(commit => commit.hash === expandedCommitHash)) return;
    setExpandedCommitHash(null);
  }, [commitHashesKey, commits, expandedCommitHash]);

  useEffect(() => {
    let active = true;
    if (!expandedCommitHash || filesByHash[expandedCommitHash]) {
      return () => { active = false; };
    }

    setLoadingCommitHash(expandedCommitHash);
    void onRequestCommitFiles(repoStatus.repoId, expandedCommitHash)
      .then(files => {
        if (!active) return;
        setFilesByHash(prev => ({ ...prev, [expandedCommitHash]: files }));
      })
      .finally(() => {
        if (!active) return;
        setLoadingCommitHash(current => current === expandedCommitHash ? null : current);
      });

    return () => { active = false; };
  }, [expandedCommitHash, filesByHash, onRequestCommitFiles, repoStatus.repoId]);

  useEffect(() => {
    let active = true;
    if (pushViewMode !== 'changes') {
      return () => { active = false; };
    }
    if (commits.length === 0) {
      setAggregatedFiles([]);
      return () => { active = false; };
    }

    const cachedGroups = commits
      .map(commit => filesByHash[commit.hash])
      .filter((files): files is PushCommitFile[] => Array.isArray(files));
    const missingCommits = commits.filter(commit => !filesByHash[commit.hash]);

    if (missingCommits.length === 0) {
      setAggregatedFiles(mergeUniqueFiles(cachedGroups));
      return () => { active = false; };
    }

    setLoadingAggregatedFiles(true);
    void Promise.all(missingCommits.map(commit => onRequestCommitFiles(repoStatus.repoId, commit.hash)))
      .then(groups => {
        if (!active) return;
        const fetched = Object.fromEntries(missingCommits.map((commit, index) => [commit.hash, groups[index] ?? []]));
        setFilesByHash(prev => ({ ...prev, ...fetched }));
        setAggregatedFiles(mergeUniqueFiles([...cachedGroups, ...groups]));
      })
      .catch(() => {
        if (active) setAggregatedFiles(mergeUniqueFiles(cachedGroups));
      })
      .finally(() => {
        if (active) setLoadingAggregatedFiles(false);
      });

    return () => { active = false; };
  }, [commitHashesKey, commits, filesByHash, onRequestCommitFiles, pushViewMode, repoStatus.repoId]);

  const toggleCommitSelection = (hash: string) => {
    setMultiSelectHashes(prev => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const handleCommitContextMenu = (event: React.MouseEvent, commit: UnpushedCommit, isHead: boolean) => {
    event.preventDefault();
    event.stopPropagation();
    let selectedHashes: Set<string>;
    if (multiSelectHashes.has(commit.hash) && multiSelectHashes.size > 1) {
      selectedHashes = multiSelectHashes;
    } else {
      selectedHashes = new Set([commit.hash]);
      setMultiSelectHashes(selectedHashes);
    }
    const isSingle = selectedHashes.size === 1;
    setCtxMenu({
      x: event.clientX,
      y: event.clientY,
      repoId: repoStatus.repoId,
      selectedHashes: Array.from(selectedHashes),
      commits,
      isHead: isSingle && isHead,
      singleHash: isSingle ? commit.hash : null,
    });
  };

  const getOrderedSelection = () => {
    const hashes = ctxMenu?.selectedHashes ?? [];
    const ordered = commits.filter(commit => hashes.includes(commit.hash));
    const oldestHash = ordered[ordered.length - 1]?.hash ?? hashes[hashes.length - 1];
    return { hashes, ordered, oldestHash };
  };

  const handleEditMsg = () => {
    if (!ctxMenu?.singleHash) return;
    const commit = commits.find(item => item.hash === ctxMenu.singleHash);
    if (!commit) return;
    onEditCommitMsg(repoStatus.repoId, ctxMenu.singleHash, commit.message);
  };

  const handleDropSingle = () => {
    if (!ctxMenu?.singleHash) return;
    onDropCommits(repoStatus.repoId, [ctxMenu.singleHash], ctxMenu.singleHash);
  };

  const handleRevertSingle = () => {
    if (!ctxMenu?.singleHash) return;
    onRevertCommits(repoStatus.repoId, [ctxMenu.singleHash]);
  };

  const handleViewInLog = () => {
    if (!ctxMenu?.singleHash) return;
    onOpenInLog(ctxMenu.singleHash, repoStatus.repoId);
  };

  const handleSquash = () => {
    if (!ctxMenu || ctxMenu.selectedHashes.length < 2) return;
    const { hashes, ordered, oldestHash } = getOrderedSelection();
    const combinedMessage = ordered.map(commit => commit.message).join('\n\n');
    onSquash(repoStatus.repoId, hashes, oldestHash, combinedMessage, ordered.map(commit => ({
      hash: commit.hash,
      shortHash: commit.shortHash,
      message: commit.message,
    })));
    setMultiSelectHashes(new Set());
  };

  const handleDropCommits = () => {
    if (!ctxMenu || ctxMenu.selectedHashes.length < 2) return;
    const { hashes, oldestHash } = getOrderedSelection();
    onDropCommits(repoStatus.repoId, hashes, oldestHash);
    setMultiSelectHashes(new Set());
  };

  const handleRevertCommits = () => {
    if (!ctxMenu || ctxMenu.selectedHashes.length < 2) return;
    const { hashes } = getOrderedSelection();
    onRevertCommits(repoStatus.repoId, hashes);
    setMultiSelectHashes(new Set());
  };

  const handleBodyClick = (event: React.MouseEvent) => {
    if (!(event.target as HTMLElement).closest('[data-commit-row]')) {
      setMultiSelectHashes(new Set());
    }
  };

  return (
    <div style={styles.repoRoot}>
      <div
        style={styles.repoHeader(repoColor)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {!singleRepo && (
          <input
            type="checkbox"
            checked={checked}
            disabled={!canCheck}
            onChange={() => onToggle(repoStatus.repoId)}
            onClick={event => event.stopPropagation()}
            style={{ ...styles.checkbox, ...nativeCheckboxBorderStyle(), opacity: canCheck ? 1 : 0.35, cursor: canCheck ? 'pointer' : 'default' }}
            title={!canCheck ? t('Nothing to push') : checked ? t('Exclude from push') : t('Include in push')}
          />
        )}
        <div style={styles.headerMain} onClick={() => setExpanded(value => !value)}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '11px', opacity: 0.65, flexShrink: 0 }} />
          <span style={styles.dot(repoColor)} />
          <span style={styles.repoName}>{repoName}</span>
          <span style={styles.branchBadge(branchClr)} title={branchTitle}>
            <Codicon name={worktreeBranch ? 'repo-clone' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0, opacity: 0.8 }} />
            <span style={styles.branchName}>{branchLabel}</span>
          </span>
          {(commitCount > 0 || canTogglePushView || behind > 0 || !hasUpstream) && (
            <div style={styles.repoRightGroup}>
              <button
                type="button"
                data-action-btn=""
                style={styles.repoModeButton(!canTogglePushView, hovered)}
                disabled={!canTogglePushView}
                title={pushViewMode === 'commits' ? t('Show aggregated changes') : t('Show commit list')}
                onClick={event => {
                  event.stopPropagation();
                  if (!canTogglePushView) return;
                  setPushViewMode(value => value === 'commits' ? 'changes' : 'commits');
                  setExpanded(true);
                }}
              >
                <Codicon name={pushViewMode === 'commits' ? 'diff-multiple' : 'list-unordered'} />
              </button>
              {commitCount > 0 ? (
                <span style={styles.aheadBadge}>
                  <Codicon name="arrow-up" style={{ fontSize: '10px', marginRight: '2px' }} />
                  {commitCount}
                </span>
              ) : behind > 0 ? (
                <span style={styles.behindBadge}>
                  <Codicon name="arrow-down" style={{ fontSize: '10px', marginRight: '2px' }} />
                  {behind}
                </span>
              ) : !hasUpstream ? (
                <span style={styles.publishBadge}>
                  <Codicon name="cloud-upload" style={{ fontSize: '10px', marginRight: '3px' }} />
                  {t('Unpublished')}
                </span>
              ) : null}
            </div>
          )}
        </div>
      </div>

      {expanded && (
        <div style={styles.repoBody} onClick={handleBodyClick}>
          {hasUpstream && ahead === 0 && behind === 0 ? (
            <div style={styles.upToDate}>
              <Codicon name="check" style={{ marginRight: '6px', opacity: 0.6 }} />
              {t('Up to date')}
            </div>
          ) : hasUpstream && ahead === 0 && behind > 0 ? (
            <div style={styles.behindRow}>
              <Codicon name="arrow-down" style={{ marginRight: '6px', opacity: 0.7, flexShrink: 0 }} />
              <span>{behind === 1 ? t('{0} commit to pull from {1}', behind, repoStatus.branch.upstream ?? '') : t('{0} commits to pull from {1}', behind, repoStatus.branch.upstream ?? '')}</span>
            </div>
          ) : unpushed?.loading ? (
            <div style={styles.loadingRow}>{t('Loading commits…')}</div>
          ) : unpushed?.error ? (
            <div style={styles.errorRow}>
              <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
              {unpushed.error}
            </div>
          ) : commits.length > 0 ? (
            pushViewMode === 'changes' ? (
              <AggregatedChangesView
                commits={commits}
                filesByHash={filesByHash}
                files={aggregatedFiles}
                loading={loadingAggregatedFiles}
                fileViewMode={fileViewMode}
                iconTheme={iconTheme}
                onFileViewModeChange={setFileViewMode}
                onOpenCommitFile={(hash, file) => onOpenCommitFile(repoStatus.repoId, hash, file)}
              />
            ) : (
              <div style={styles.commitList}>
                {commits.map((commit, index) => (
                  <CommitRow
                    key={commit.hash}
                    commit={commit}
                    repoId={repoStatus.repoId}
                    isHead={index === 0}
                    expanded={commit.hash === expandedCommitHash}
                    selected={multiSelectHashes.has(commit.hash)}
                    files={commit.hash === expandedCommitHash ? selectedCommitFiles : []}
                    loadingFiles={commit.hash === expandedCommitHash ? loadingSelectedCommitFiles : false}
                    fileViewMode={fileViewMode}
                    iconTheme={iconTheme}
                    onToggle={() => {
                      setMultiSelectHashes(new Set());
                      setExpandedCommitHash(current => current === commit.hash ? null : commit.hash);
                    }}
                    onSelect={() => toggleCommitSelection(commit.hash)}
                    onContextMenu={event => handleCommitContextMenu(event, commit, index === 0)}
                    onFileViewModeChange={setFileViewMode}
                    onOpenFile={file => onOpenCommitFile(repoStatus.repoId, commit.hash, file)}
                    onOpenInLog={onOpenInLog}
                    onUndoCommit={onUndoCommit}
                  />
                ))}
              </div>
            )
          ) : !hasUpstream ? (
            <div style={styles.unpublishedRow}>
              <Codicon name="cloud-upload" style={{ marginRight: '6px', opacity: 0.7, flexShrink: 0 }} />
              <span>{t('Local branch — not published to any remote yet')}</span>
            </div>
          ) : (
            <div style={styles.loadingRow}>{t('No commits found')}</div>
          )}
        </div>
      )}

      {ctxMenu && (
        <CommitContextMenu
          state={ctxMenu}
          onSquash={handleSquash}
          onDropCommits={handleDropCommits}
          onRevertCommits={handleRevertCommits}
          onEditMsg={handleEditMsg}
          onUndo={() => onUndoCommit(repoStatus.repoId)}
          onRevertSingle={handleRevertSingle}
          onDropSingle={handleDropSingle}
          onViewInLog={handleViewInLog}
          onClose={() => { setCtxMenu(null); setMultiSelectHashes(new Set()); }}
        />
      )}
    </div>
  );
}

export function PushTab(props: Props) {
  const { repos, repoMetas, iconTheme, unpushedMap, onPush, onOpenInLog, onUndoCommit, onRequestCommitFiles, onOpenCommitFile, onSquash, onDropCommits, onRevertCommits, onEditCommitMsg } = props;
  const metaMap = new Map(repoMetas.map(meta => [meta.id, meta]));
  const isSingleRepo = repos.length === 1;
  const [checked, setChecked] = useState<Set<string>>(() => new Set<string>());

  const canPushRepo = (repo: RepoStatus) => {
    const ahead = repo.branch.aheadBehind?.ahead ?? 0;
    const hasUpstream = !!repo.branch.upstream;
    return (hasUpstream && ahead > 0) || !hasUpstream;
  };

  useEffect(() => {
    setChecked(prev => {
      const toRemove = repos.filter(repo => prev.has(repo.repoId) && !canPushRepo(repo));
      if (toRemove.length === 0) return prev;
      const next = new Set(prev);
      toRemove.forEach(repo => next.delete(repo.repoId));
      return next;
    });
  }, [repos, unpushedMap]);

  const toggleRepo = (repoId: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  const pushButtonLabel = (targets: RepoStatus[]) => {
    const hasPublish = targets.some(repo => !repo.branch.upstream);
    const hasPush = targets.some(repo => !!repo.branch.upstream);
    const publishCount = targets.filter(repo => !repo.branch.upstream).length;
    if (hasPublish && hasPush) return publishCount === 1 ? t('Push & Publish Branch') : t('Push & Publish Branches');
    if (hasPublish) return targets.length === 1 ? t('Publish Branch') : t('Publish Branches');
    return t('Push');
  };

  if (isSingleRepo) {
    const solo = repos[0];
    const canPush = canPushRepo(solo);
    return (
      <div style={css.root}>
        <div style={css.list}>
          <RepoSection
            key={solo.repoId}
            repoStatus={solo}
            repoMeta={metaMap.get(solo.repoId)}
            unpushed={unpushedMap[solo.repoId]}
            checked={false}
            canCheck={false}
            onToggle={() => {}}
            onOpenInLog={onOpenInLog}
            onUndoCommit={onUndoCommit}
            onRequestCommitFiles={onRequestCommitFiles}
            onOpenCommitFile={onOpenCommitFile}
            onSquash={onSquash}
            onDropCommits={onDropCommits}
            onRevertCommits={onRevertCommits}
            onEditCommitMsg={onEditCommitMsg}
            iconTheme={iconTheme}
            singleRepo
          />
        </div>
        <div style={css.footer}>
          <button data-primary-action-btn="" style={css.pushBtn(canPush)} disabled={!canPush} onClick={() => onPush(solo.repoId)}>
            <Codicon name="cloud-upload" style={{ marginRight: '6px' }} />
            {pushButtonLabel([solo])}
          </button>
        </div>
      </div>
    );
  }

  const checkedRepos = repos.filter(repo => checked.has(repo.repoId));
  const pushableChecked = checkedRepos.filter(canPushRepo);
  const canPush = pushableChecked.length > 0;

  const handlePush = () => {
    if (!canPush) return;
    if (pushableChecked.length === 1) {
      onPush(pushableChecked[0].repoId);
    } else {
      pushableChecked.forEach(repo => onPush(repo.repoId));
    }
  };

  return (
    <div style={css.root}>
      <div style={css.list}>
        {repos.map(repoStatus => (
          <RepoSection
            key={repoStatus.repoId}
            repoStatus={repoStatus}
            repoMeta={metaMap.get(repoStatus.repoId)}
            unpushed={unpushedMap[repoStatus.repoId]}
            checked={checked.has(repoStatus.repoId)}
            canCheck={canPushRepo(repoStatus)}
            onToggle={toggleRepo}
            onOpenInLog={onOpenInLog}
            onUndoCommit={onUndoCommit}
            onRequestCommitFiles={onRequestCommitFiles}
            onOpenCommitFile={onOpenCommitFile}
            onSquash={onSquash}
            onDropCommits={onDropCommits}
            onRevertCommits={onRevertCommits}
            onEditCommitMsg={onEditCommitMsg}
            iconTheme={iconTheme}
          />
        ))}
      </div>

      <div style={css.footer}>
        {checkedRepos.length > 0 && (
          <div style={css.pills}>
            {checkedRepos.map(repo => {
              const meta = metaMap.get(repo.repoId);
              const color = meta?.color ?? '#4ec9b0';
              const rawName = meta?.name ?? baseNameFromPath(repo.repoId) ?? repo.repoId;
              const wtBranch = meta?.isWorktree
                ? (repo.branch.detachedTag ?? repo.branch.detachedHash ?? repo.branch.name)
                : undefined;
              const displayName = wtBranch
                ? `${baseNameFromPath(meta?.mainWorktreePath) ?? rawName} (${wtBranch})`
                : rawName;
              const ahead = repo.branch.aheadBehind?.ahead ?? 0;
              return (
                <span key={repo.repoId} style={css.pill(color)}>
                  <button data-action-btn="" style={css.pillRemove(color)} title={t('Remove {0}', displayName)} onClick={() => toggleRepo(repo.repoId)}>
                    <Codicon name="close" style={{ fontSize: '10px' }} />
                  </button>
                  {displayName}
                  {ahead > 0 && (
                    <span style={css.pillCount}>
                      <Codicon name="arrow-up" style={{ fontSize: '8px', marginRight: '1px' }} />
                      {ahead}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        <button data-primary-action-btn="" style={css.pushBtn(canPush)} disabled={!canPush} onClick={handlePush}>
          <Codicon name="cloud-upload" style={{ marginRight: '6px' }} />
          {pushButtonLabel(pushableChecked)}
        </button>
      </div>
    </div>
  );
}

const ctxStyles = {
  menu: {
    position: 'fixed' as const,
    zIndex: 9999,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    padding: '3px 0',
    minWidth: '170px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    fontSize: '12px',
    color: 'var(--vscode-menu-foreground)',
  },
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '7px',
    padding: '5px 12px',
    cursor: 'pointer',
    background: 'transparent',
    userSelect: 'none' as const,
  },
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground, var(--vscode-panel-border))',
    margin: '3px 0',
  } as React.CSSProperties,
};

const css = {
  root: { display: 'flex', flexDirection: 'column' as const, flex: 1, height: '100%', minHeight: 0, overflow: 'hidden' },
  list: { flex: 1, overflowY: 'auto' as const, minHeight: 0 },
  footer: {
    flexShrink: 0,
    display: 'flex', flexDirection: 'column' as const, gap: '6px',
    padding: '8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
    position: 'sticky' as const,
    bottom: 0,
    zIndex: 2,
  } as React.CSSProperties,
  pills: { display: 'flex', flexWrap: 'wrap' as const, gap: '4px' } as React.CSSProperties,
  pill: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    padding: '1px 7px 1px 4px', borderRadius: '10px',
    fontSize: '11px', lineHeight: '16px',
    background: color + '28', color,
    border: `1px solid ${color}60`,
  }),
  pillRemove: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none', color,
    cursor: 'pointer', padding: '0 1px', borderRadius: '50%', lineHeight: 1,
  }),
  pillCount: {
    display: 'inline-flex', alignItems: 'center',
    background: 'rgba(255,255,255,0.15)', borderRadius: '7px',
    padding: '0 3px', fontSize: '10px', minWidth: '14px', height: '14px',
    justifyContent: 'center', boxSizing: 'border-box' as const,
  } as React.CSSProperties,
  pushBtn: (enabled: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none', borderRadius: '3px', padding: '6px 12px',
    cursor: enabled ? 'pointer' : 'default',
    fontSize: '12px', fontFamily: 'var(--vscode-font-family)',
    opacity: enabled ? 1 : 0.45, width: '100%',
  }),
};

const styles = {
  repoRoot: { borderBottom: '1px solid var(--vscode-panel-border)' } as React.CSSProperties,
  repoHeader: (color: string): React.CSSProperties => ({
    display: 'flex', alignItems: 'center',
    padding: '4px 8px', minHeight: '26px',
    background: color + '14', borderBottom: '1px solid var(--vscode-panel-border)',
    boxSizing: 'border-box',
  }),
  checkbox: {
    margin: '0 2px 0 0', flexShrink: 0,
    accentColor: 'var(--vscode-button-background)',
  } as React.CSSProperties,
  headerMain: {
    display: 'flex', alignItems: 'center', gap: '6px',
    flex: 1, minWidth: 0, cursor: 'pointer',
  } as React.CSSProperties,
  dot: (color: string): React.CSSProperties => ({
    width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
  }),
  repoName: {
    fontSize: '11px', fontWeight: 'bold' as const, opacity: 0.9,
    textTransform: 'uppercase' as const, letterSpacing: 0, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flexShrink: 1,
  },
  branchBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    fontSize: '10px', fontWeight: 600,
    background: `${color}33`, color, border: `1px solid ${color}88`,
    borderRadius: '3px', padding: '1px 5px',
    flexShrink: 1, minWidth: 0, maxWidth: '160px', marginLeft: '4px',
    overflow: 'hidden',
  }),
  branchName: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0,
  } as React.CSSProperties,
  aheadBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 'bold' as const,
    flexShrink: 0,
  } as React.CSSProperties,
  behindBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--vscode-inputValidation-warningBackground, #6b4f00)', color: 'var(--vscode-inputValidation-warningForeground, #cca700)',
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 'bold' as const,
    flexShrink: 0,
  } as React.CSSProperties,
  publishBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 500 as const,
    flexShrink: 0,
  } as React.CSSProperties,
  repoRightGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  repoModeButton: (disabled: boolean, visible: boolean): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, padding: 0, border: 'none', borderRadius: '3px',
    background: 'transparent', color: 'var(--vscode-icon-foreground)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: visible ? (disabled ? 0.35 : 0.8) : 0,
    pointerEvents: visible && !disabled ? 'auto' : 'none',
    transition: 'opacity 0.1s',
    flexShrink: 0,
  }),
  repoBody: { background: 'var(--vscode-sideBar-background)' } as React.CSSProperties,
  upToDate: {
    display: 'flex', alignItems: 'center', padding: '8px 12px', fontSize: '12px', opacity: 0.5,
  } as React.CSSProperties,
  behindRow: {
    display: 'flex', alignItems: 'center',
    padding: '12px 8px', fontSize: '12px', opacity: 0.75,
    color: 'var(--vscode-inputValidation-warningForeground, #cca700)',
  } as React.CSSProperties,
  unpublishedRow: {
    display: 'flex', alignItems: 'center',
    padding: '12px 8px', fontSize: '12px', opacity: 0.5,
  } as React.CSSProperties,
  loadingRow: { padding: '8px 12px', fontSize: '12px', opacity: 0.45, fontStyle: 'italic' as const } as React.CSSProperties,
  errorRow: {
    display: 'flex', alignItems: 'flex-start', padding: '6px 10px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)',
  } as React.CSSProperties,
  commitList: { display: 'flex', flexDirection: 'column' as const } as React.CSSProperties,
  commitCard: (_expanded: boolean, selected: boolean): React.CSSProperties => ({
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: selected ? 'var(--vscode-list-inactiveSelectionBackground)' : 'transparent',
  }),
  commitRow: {
    display: 'grid',
    gridTemplateColumns: '48px 1fr auto',
    gridTemplateRows: 'auto auto',
    gap: '0 8px',
    padding: '7px 12px',
    alignItems: 'center',
    cursor: 'pointer',
    boxSizing: 'border-box',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  commitHash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '10px',
    opacity: 0.55, gridRow: '1', gridColumn: '1',
    display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  commitMessage: {
    fontSize: '12px', fontWeight: 500, gridRow: '1', gridColumn: '2',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  commitMeta: {
    fontSize: '10px', opacity: 0.45, gridRow: '2', gridColumn: '2',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
    display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  commitStats: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  statAdd: { color: 'var(--vscode-gitDecoration-addedResourceForeground)' } as React.CSSProperties,
  statDel: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)' } as React.CSSProperties,
  commitActions: (visible: boolean): React.CSSProperties => ({
    gridRow: '1 / 3', gridColumn: '3',
    display: 'flex', alignItems: 'center', gap: '4px', alignSelf: 'center',
    opacity: visible ? 1 : 0, transition: 'opacity 0.1s',
  }),
  actionBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer', padding: '2px', borderRadius: '3px', opacity: 0.65,
  } as React.CSSProperties,
  commitDetails: {
    paddingBottom: '6px',
  } as React.CSSProperties,
  messagePanel: {
    padding: '8px 26px',
    borderBottom: '1px dashed var(--vscode-panel-border)',
  } as React.CSSProperties,
  bodyBlock: {
    marginBottom: 0,
    color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-editor-font-family)',
  } as React.CSSProperties,
  bodyText: {
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontSize: '11px',
    lineHeight: 1.45,
    opacity: 0.9,
  } as React.CSSProperties,
  footerText: (withTopBorder: boolean): React.CSSProperties => ({
    margin: withTopBorder ? '8px 0 0' : 0,
    paddingTop: withTopBorder ? 8 : 0,
    borderTop: withTopBorder ? '1px dashed var(--vscode-panel-border)' : 'none',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'var(--vscode-editor-font-family)',
    fontSize: '11px',
    lineHeight: 1.45,
    opacity: 0.8,
  }),
  fileListRoot: {
    background: 'var(--vscode-sideBar-background)',
  } as React.CSSProperties,
  fileListDescription: {
    padding: '8px 12px 6px',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
  } as React.CSSProperties,
  filesHeader: {
    borderBottom: '1px solid var(--vscode-panel-border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '5px 10px 5px 16px',
    minHeight: 30,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  filesTitle: {
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '11px',
    fontWeight: 500,
    minWidth: 54,
  } as React.CSSProperties,
  filesHeaderActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
  } as React.CSSProperties,
  expandBtns: {
    display: 'flex',
    gap: '2px',
  } as React.CSSProperties,
  viewToggle: {
    display: 'flex',
    gap: '2px',
    marginLeft: '4px',
    paddingLeft: '4px',
    borderLeft: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  toolbarButton: (active: boolean, disabled: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px 4px',
    border: 'none',
    borderRadius: '3px',
    background: active ? 'var(--vscode-toolbar-activeBackground)' : 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.3 : active ? 1 : 0.5,
  }),
  treeRoot: {
    padding: '2px 0',
  } as React.CSSProperties,
  dirRow: (depth: number): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minHeight: 24,
    padding: `0 8px 0 ${TREE_BASE_PAD + depth * TREE_LEVEL_PAD}px`,
    cursor: 'pointer',
    boxSizing: 'border-box',
    minWidth: 0,
    overflow: 'hidden',
  }),
  folderChevron: {
    fontSize: '12px',
    opacity: 0.65,
    flexShrink: 0,
  } as React.CSSProperties,
  folderName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    opacity: 0.85,
  },
  fileCountBadge: {
    marginLeft: 'auto',
    fontSize: '10px',
    padding: '0 6px',
    borderRadius: '999px',
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    opacity: 0.85,
    flexShrink: 0,
  } as React.CSSProperties,
  fileRow: (depth: number, hovered: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    minHeight: 24,
    padding: `0 8px 0 ${TREE_BASE_PAD + depth * TREE_LEVEL_PAD + 18}px`,
    cursor: 'pointer',
    boxSizing: 'border-box',
    background: hovered ? 'var(--vscode-list-hoverBackground)' : undefined,
  }),
  fileNameGroup: {
    display: 'flex',
    alignItems: 'baseline',
    minWidth: 0,
    gap: '6px',
    flex: 1,
  } as React.CSSProperties,
  fileName: (color: string): React.CSSProperties => ({
    color,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '12px',
  }),
  dirPath: {
    color: 'var(--vscode-descriptionForeground)',
    opacity: 0.65,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '11px',
  } as React.CSSProperties,
  fileStats: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  lineStats: {
    display: 'flex',
    gap: '4px',
    alignItems: 'center',
    fontSize: '10px',
    flexShrink: 0,
  } as React.CSSProperties,
  added: {
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
  } as React.CSSProperties,
  removed: {
    color: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  } as React.CSSProperties,
  statusLetter: (color: string): React.CSSProperties => ({
    color,
    fontSize: '11px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontWeight: 700,
    minWidth: 12,
    textAlign: 'center',
  }),
};
