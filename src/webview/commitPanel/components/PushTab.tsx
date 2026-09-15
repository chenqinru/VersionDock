import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { IncomingCommit, PushCommitFile, SyncPullStrategy, UnpushedCommit } from '../../shared/msgTypes';
import type { RepoStatus, RepoMeta } from '../../shared/types';
import type { IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { branchInfoColor, readableAccentColor } from '../../shared/branchColors';
import { t } from '../../shared/i18n';
import { baseNameFromPath } from '../../shared/pathUtils';
import { nativeCheckboxBorderStyle } from '../../shared/nativeCheckboxStyle';
import { getCommitMessageTitle } from '../../shared/commitMessage';
import type { ExpansionCommand } from './StashTab';
import { HighlightedText, SpeedSearchWidget, useSpeedSearch } from '../../shared/speedSearch';
import { AuthorAvatar } from './AuthorAvatar';

const PUSH_COLOR = 'var(--vscode-gitDecoration-addedResourceForeground)';
const PULL_COLOR = 'var(--vscode-charts-blue, #64b5f6)';
const WARNING_COLOR = 'var(--vscode-inputValidation-warningForeground, #cca700)';

export interface IncomingRepoData {
  loading: boolean;
  commits: IncomingCommit[];
  error?: string;
}

export type PushCommitFilesResult =
  | PushCommitFile[]
  | {
      files: PushCommitFile[];
      isMerge?: boolean;
    };

export interface PushTabProps {
  isActive?: boolean;
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
  iconTheme?: IconThemeData | null;
  unpushedMap: Record<string, { loading: boolean; commits: UnpushedCommit[]; error?: string }>;
  incomingMap?: Record<string, IncomingRepoData>;
  onPush: (repoId: string) => void;
  onPushMulti?: (repoIds: string[]) => void;
  onPushAll: () => void;
  onForcePush?: (repoId: string) => void;
  onForcePushMulti?: (repoIds: string[]) => void;
  onPushTags?: (repoId: string) => void;
  onPushTagsMulti?: (repoIds: string[]) => void;
  onPull?: (repoId: string, strategy?: SyncPullStrategy) => void;
  onPullMulti?: (repoIds: string[], strategy?: SyncPullStrategy) => void;
  onSync?: (repoId: string, strategy?: SyncPullStrategy) => void;
  onSyncMulti?: (repoIds: string[], strategy?: SyncPullStrategy) => void;
  onFetch?: (repoId: string) => void;
  onFetchAll?: () => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  onRequestCommitFiles: (repoId: string, hash: string) => Promise<PushCommitFilesResult>;
  onRequestAggregatedDiff?: (repoId: string, oldestHash?: string) => Promise<PushCommitFile[]>;
  onOpenAggregatedFile: (repoId: string, oldestHash: string | undefined, file: PushCommitFile) => void;
  onOpenCommitFile: (repoId: string, hash: string, file: PushCommitFile) => void;
  onRequestIncomingCommitFiles?: (repoId: string, hash: string) => Promise<PushCommitFilesResult>;
  onRequestIncomingAggregatedDiff?: (repoId: string) => Promise<PushCommitFile[]>;
  onOpenIncomingAggregatedFile?: (repoId: string, file: PushCommitFile) => void;
  onOpenIncomingCommitFile?: (repoId: string, hash: string, file: PushCommitFile) => void;
  onSquash: (repoId: string, hashes: string[], oldestHash: string, combinedMessage: string, commits: { hash: string; shortHash: string; message: string }[]) => void;
  onDropCommits: (repoId: string, hashes: string[], oldestHash: string) => void;
  onRevertCommits: (repoId: string, hashes: string[]) => void;
  onEditCommitMsg: (repoId: string, hash: string, currentMessage: string) => void;
  onCherryPick?: (repoId: string, hashes: string[]) => void;
  onCreateBranchFromCommit?: (repoId: string, hash: string) => void;
  onBranchClick?: (repoId: string) => void;
  expansionCommand?: ExpansionCommand;
  viewMode?: PushFileViewMode;
  onExpansionChange?: (expanded: boolean) => void;
  selectionCommand?: { sequence: number; action: 'selectAll' | 'invert' };
  onSelectionChange?: (isAllSelected: boolean, hasSelectable: boolean) => void;
}

export interface RepoLoadedFiles {
  pushViewMode?: PushViewMode;
  filesByHash: Record<string, PushCommitFile[]>;
  incomingFilesByHash: Record<string, PushCommitFile[]>;
  aggregatedFiles: PushCommitFile[];
  aggregatedIncomingFiles: PushCommitFile[];
}

export type PushSpeedSearchItem =
  | {
      kind: 'commit';
      key: string;
      repoId: string;
      hash: string;
      shortHash: string;
      message: string;
      author: string;
      isIncoming: boolean;
    }
  | {
      kind: 'file';
      key: string;
      repoId: string;
      commitHash?: string;
      path: string;
      file: PushCommitFile;
      isIncoming: boolean;
    };

type Props = PushTabProps;

export type DirectionFilter = 'all' | 'outgoing' | 'incoming' | 'none';

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

interface IncomingCommitCtxMenuState {
  x: number;
  y: number;
  repoId: string;
  selectedHashes: string[];
  singleHash: string | null;
  hasMergeCommit?: boolean;
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

function mergeUniqueFiles(fileGroups: PushCommitFile[][]): PushCommitFile[] {
  const merged = new Map<string, PushCommitFile>();
  for (const files of fileGroups) {
    for (const file of files) {
      if (!merged.has(file.path)) merged.set(file.path, file);
    }
  }
  return [...merged.values()];
}

function MenuItem({
  icon,
  label,
  danger,
  disabled,
  title,
  onClick,
}: {
  icon: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <div
      title={title}
      style={{
        ...ctxStyles.item,
        ...(danger ? { color: 'var(--vscode-errorForeground)' } : {}),
        ...(disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}),
      }}
      onMouseEnter={event => {
        if (!disabled) event.currentTarget.style.background = 'var(--vscode-list-hoverBackground)';
      }}
      onMouseLeave={event => {
        if (!disabled) event.currentTarget.style.background = 'transparent';
      }}
      onClick={disabled ? undefined : onClick}
    >
      <Codicon name={icon} style={{ fontSize: '13px' }} />
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
    const outsideHandler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const blurHandler = () => onClose();
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') onClose();
    };
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    window.addEventListener('pagehide', blurHandler);
    return () => {
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
      window.removeEventListener('pagehide', blurHandler);
    };
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

function IncomingCommitContextMenu({ state, onCherryPick, onCreateBranch, onViewInLog, onClose }: {
  state: IncomingCommitCtxMenuState;
  onCherryPick: (hashes: string[]) => void;
  onCreateBranch: (hash: string) => void;
  onViewInLog: (hash: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const n = state.selectedHashes.length;
  const cherryPickDisabled = Boolean(state.hasMergeCommit);
  const cherryPickTitle = cherryPickDisabled
    ? t('Merge commits cannot be cherry-picked directly')
    : undefined;

  useEffect(() => {
    const outsideHandler = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const blurHandler = () => onClose();
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') onClose();
    };
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    window.addEventListener('pagehide', blurHandler);
    return () => {
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
      window.removeEventListener('pagehide', blurHandler);
    };
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
      {n === 1 && state.singleHash && (
        <>
          <MenuItem icon="go-to-file" label={t('View in Git Log')} onClick={wrap(() => onViewInLog(state.singleHash!))} />
          <MenuItem
            icon="pinned"
            label={t('Cherry-pick Commit')}
            disabled={cherryPickDisabled}
            title={cherryPickTitle}
            onClick={wrap(() => onCherryPick([state.singleHash!]))}
          />
          <MenuItem icon="git-branch" label={t('New Branch from Here…')} onClick={wrap(() => onCreateBranch(state.singleHash!))} />
        </>
      )}
      {n >= 2 && (
        <MenuItem
          icon="pinned"
          label={t('Cherry-pick {0} commits', n)}
          disabled={cherryPickDisabled}
          title={cherryPickTitle}
          onClick={wrap(() => onCherryPick(state.selectedHashes))}
        />
      )}
    </div>
  );
}

function CommitRow({
  commit,
  repoId,
  isHead,
  expanded,
  selected,
  files,
  loadingFiles,
  fileViewMode,
  iconTheme,
  onToggle,
  onSelect,
  onContextMenu,
  onFileViewModeChange: _onFileViewModeChange,
  onOpenFile,
  onOpenInLog,
  onUndoCommit,
  isIncoming,
  showDirectionBadge = true,
  potentialConflicts,
  speedSearchQuery,
  activeSpeedSearchKey,
  isMerge,
}: {
  commit: UnpushedCommit | IncomingCommit;
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
  onFileViewModeChange?: (mode: PushFileViewMode) => void;
  onOpenFile: (file: PushCommitFile) => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  isIncoming?: boolean;
  showDirectionBadge?: boolean;
  potentialConflicts?: Set<string>;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
  isMerge?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const fullMessage = commit.fullMessage || (commit.body ? `${commit.message}\n\n${commit.body}` : commit.message);
  const messageTitle = getCommitMessageTitle(fullMessage, commit.message);
  const commitKey = isIncoming ? `push:incoming:${repoId}:${commit.hash}` : `push:commit:${repoId}:${commit.hash}`;
  const isSpeedSearchActive = activeSpeedSearchKey === commitKey;

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
    <div className="versiondock-card" style={styles.commitCard(expanded, selected)} data-row-divider="">
      <div
        data-commit-row="true"
        data-speed-search-key={commitKey}
        className="versiondock-card-header versiondock-list-row"
        data-list-row=""
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
        <div style={styles.commitLeft}>
          {showDirectionBadge && (
            <span
              style={styles.commitDirectionIcon(!!isIncoming)}
              title={isIncoming ? t('Incoming (Update)') : t('Outgoing (Push)')}
            >
              <Codicon name={isIncoming ? 'arrow-down' : 'arrow-up'} style={{ fontSize: '11px' }} />
            </span>
          )}
          <span style={styles.commitHash}>
            <HighlightedText text={commit.shortHash} query={speedSearchQuery} isActive={isSpeedSearchActive} />
          </span>
        </div>
        <div style={styles.commitInfo}>
          <span style={styles.commitMessage} title={fullMessage}>
            <HighlightedText text={messageTitle} query={speedSearchQuery} isActive={isSpeedSearchActive} />
          </span>
          <span style={styles.commitMeta}>
            <AuthorAvatar
              authorName={commit.author}
              authorEmail={commit.authorEmail ?? ''}
              repoId={repoId}
              size={15}
              fontSize={7}
            />
            <span style={{ ...styles.commitMetaText, marginLeft: '5px' }}>
              {commit.author} · {formatDate(commit.date)}
            </span>
            {commit.filesChanged != null && (
              <span style={styles.commitStats}>
                &nbsp;·&nbsp;{formatFileCount(commit.filesChanged)}
                {commit.additions != null && commit.additions > 0 && <span style={styles.statAdd}>&nbsp;+{commit.additions}</span>}
                {commit.deletions != null && commit.deletions > 0 && <span style={styles.statDel}>&nbsp;-{commit.deletions}</span>}
              </span>
            )}
          </span>
        </div>
        {hovered && (
          <div style={styles.commitActions}>
            {!isIncoming && isHead && (
              <button
                data-action-btn=""
                style={styles.actionBtn}
                title={t('Undo this commit (keeps changes as unstaged)')}
                onClick={event => { event.stopPropagation(); onUndoCommit(repoId); }}
              >
                <Codicon name="arrow-left" />
              </button>
            )}
            <button
              data-action-btn=""
              style={styles.actionBtn}
              title={t('Open in Log')}
              onClick={event => { event.stopPropagation(); onOpenInLog(commit.hash, repoId); }}
            >
              <Codicon name="go-to-file" />
            </button>
          </div>
        )}
      </div>

      {expanded && (
        <div className="versiondock-card-body" style={styles.commitDetails}>
          {isMerge && !loadingFiles && files.length === 0 ? (
            <div style={styles.noMergeConflicts}>
              <Codicon name="info" style={{ marginRight: '6px', fontSize: '13px', verticalAlign: 'text-bottom' }} />
              {t('No changes relative to first parent')}
            </div>
          ) : (
            <PushFileList
              files={files}
              loading={loadingFiles}
              viewMode={fileViewMode}
              iconTheme={iconTheme}
              potentialConflicts={potentialConflicts}
              onOpenFile={onOpenFile}
              speedSearchQuery={speedSearchQuery}
              activeSpeedSearchKey={activeSpeedSearchKey}
              itemKeyPrefix={commitKey}
            />
          )}
        </div>
      )}
    </div>
  );
}

function PushFileList({ files, loading, viewMode, iconTheme, onOpenFile, potentialConflicts, speedSearchQuery, activeSpeedSearchKey, itemKeyPrefix }: {
  files: PushCommitFile[];
  loading: boolean;
  viewMode: PushFileViewMode;
  iconTheme?: IconThemeData | null;
  onOpenFile: (file: PushCommitFile) => void;
  potentialConflicts?: Set<string>;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
  itemKeyPrefix?: string;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const savedCollapsedBeforeSearchRef = useRef<Record<string, boolean> | null>(null);
  const lastExpandedQueryRef = useRef<string | null>(null);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  useEffect(() => {
    setCollapsed({});
  }, [files]);

  useEffect(() => {
    const trimmed = speedSearchQuery?.trim().toLowerCase() ?? '';
    if (trimmed) {
      if (lastExpandedQueryRef.current !== trimmed) {
        lastExpandedQueryRef.current = trimmed;
        if (!savedCollapsedBeforeSearchRef.current) {
          savedCollapsedBeforeSearchRef.current = { ...collapsedRef.current };
        }
        setCollapsed(prev => {
          const next = { ...prev };
          for (const f of files) {
            const fileName = fileNameOf(f.path).toLowerCase();
            if (f.path.toLowerCase().includes(trimmed) || fileName.includes(trimmed)) {
              const parts = f.path.split('/');
              for (let i = 1; i < parts.length; i++) {
                next[parts.slice(0, i).join('/')] = false;
              }
            }
          }
          return next;
        });
      }
    } else if (lastExpandedQueryRef.current !== null) {
      lastExpandedQueryRef.current = null;
      if (savedCollapsedBeforeSearchRef.current) {
        setCollapsed(savedCollapsedBeforeSearchRef.current);
        savedCollapsedBeforeSearchRef.current = null;
      }
    }
  }, [speedSearchQuery, files]);

  return (
    <div style={{ ...styles.fileListRoot, position: 'relative' }}>
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
              potentialConflicts={potentialConflicts}
              onToggle={key => setCollapsed(prev => ({ ...prev, [key]: !prev[key] }))}
              onOpenFile={onOpenFile}
              speedSearchQuery={speedSearchQuery}
              activeSpeedSearchKey={activeSpeedSearchKey}
              itemKeyPrefix={itemKeyPrefix}
            />
          ))}
        </div>
      ) : (
        <div style={styles.treeRoot}>
          {files.map(file => (
            <PushFileRow
              key={file.path}
              file={file}
              depth={0}
              iconTheme={iconTheme}
              isPotentialConflict={potentialConflicts?.has(file.path)}
              onOpenFile={onOpenFile}
              speedSearchQuery={speedSearchQuery}
              activeSpeedSearchKey={activeSpeedSearchKey}
              itemKeyPrefix={itemKeyPrefix}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PushFileTreeNode({ node, depth, collapsed, iconTheme, onToggle, onOpenFile, potentialConflicts, speedSearchQuery, activeSpeedSearchKey, itemKeyPrefix }: {
  node: FileTreeNode;
  depth: number;
  collapsed: Record<string, boolean>;
  iconTheme?: IconThemeData | null;
  onToggle: (key: string) => void;
  onOpenFile: (file: PushCommitFile) => void;
  potentialConflicts?: Set<string>;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
  itemKeyPrefix?: string;
}) {
  const [hovered, setHovered] = useState(false);

  if (node.kind === 'file') {
    return (
      <PushFileRow
        file={node.file}
        depth={depth}
        iconTheme={iconTheme}
        isPotentialConflict={potentialConflicts?.has(node.file.path)}
        onOpenFile={onOpenFile}
        speedSearchQuery={speedSearchQuery}
        activeSpeedSearchKey={activeSpeedSearchKey}
        itemKeyPrefix={itemKeyPrefix}
      />
    );
  }

  const open = !collapsed[node.path];
  return (
    <div>
      <div
        data-list-row=""
        style={styles.dirRow(depth, hovered)}
        onClick={() => onToggle(node.path)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        title={node.path}
      >
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.folderChevron} />
        <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={ICON_SIZE} />
        <span style={styles.folderName}>
          <HighlightedText text={node.name} query={speedSearchQuery} />
        </span>
        <span style={styles.fileCountBadge}>{node.fileCount}</span>
      </div>
      {open && node.children.map(child => (
        <PushFileTreeNode
          key={child.kind === 'dir' ? child.path : child.file.path}
          node={child}
          depth={depth + 1}
          collapsed={collapsed}
          iconTheme={iconTheme}
          potentialConflicts={potentialConflicts}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          speedSearchQuery={speedSearchQuery}
          activeSpeedSearchKey={activeSpeedSearchKey}
          itemKeyPrefix={itemKeyPrefix}
        />
      ))}
    </div>
  );
}

function PushFileRow({ file, depth, iconTheme, onOpenFile, isPotentialConflict, speedSearchQuery, activeSpeedSearchKey, itemKeyPrefix }: {
  file: PushCommitFile;
  depth: number;
  iconTheme?: IconThemeData | null;
  onOpenFile: (file: PushCommitFile) => void;
  isPotentialConflict?: boolean;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
  itemKeyPrefix?: string;
}) {
  const [hovered, setHovered] = useState(false);
  const fileName = fileNameOf(file.path);
  const dir = directoryOf(file.path);
  const color = statusColor(file.status);
  const itemKey = itemKeyPrefix ? `${itemKeyPrefix}:${file.path}` : file.path;
  const isSpeedSearchActive = activeSpeedSearchKey === itemKey;

  return (
    <div
      data-speed-search-key={itemKey}
      className="versiondock-file-row"
      data-list-row=""
      style={styles.fileRow(depth, hovered)}
      title={isPotentialConflict ? `${file.path} (${t('Potential conflict: this file has local uncommitted modifications')})` : file.path}
      onClick={() => onOpenFile(file)}
      onDoubleClick={() => onOpenFile(file)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <FileIcon name={fileName} theme={iconTheme} size={ICON_SIZE} />
      <div style={styles.fileNameGroup}>
        <span style={styles.fileName(color)}>
          <HighlightedText text={fileName} query={speedSearchQuery} isActive={isSpeedSearchActive} />
        </span>
        {isPotentialConflict && (
          <span
            title={t('Potential conflict: this file has local uncommitted modifications')}
            style={{ display: 'inline-flex', alignItems: 'center', color: WARNING_COLOR, fontSize: '11px', flexShrink: 0 }}
          >
            <Codicon name="warning" style={{ fontSize: '11px' }} />
          </span>
        )}
        {depth === 0 && dir && (
          <span style={styles.dirPath}>
            <HighlightedText text={dir} query={speedSearchQuery} />
          </span>
        )}
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

function AggregatedChangesView({
  files,
  loading,
  fileViewMode,
  iconTheme,
  onOpenFile,
  potentialConflicts,
  speedSearchQuery,
  activeSpeedSearchKey,
  repoId,
  isIncoming,
}: {
  files: PushCommitFile[];
  loading: boolean;
  fileViewMode: PushFileViewMode;
  iconTheme?: IconThemeData | null;
  onOpenFile: (file: PushCommitFile) => void;
  potentialConflicts?: Set<string>;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
  repoId: string;
  isIncoming?: boolean;
}) {
  return (
    <div className="versiondock-card-body" style={{ borderTop: '1px solid var(--vscode-panel-border)', paddingBottom: '6px' }}>
      <PushFileList
        files={files}
        loading={loading}
        viewMode={fileViewMode}
        iconTheme={iconTheme}
        potentialConflicts={potentialConflicts}
        onOpenFile={onOpenFile}
        speedSearchQuery={speedSearchQuery}
        activeSpeedSearchKey={activeSpeedSearchKey}
        itemKeyPrefix={`push:agg:${repoId}:${isIncoming ? 'in' : 'out'}`}
      />
    </div>
  );
}

function RepoSection({
  repoStatus,
  repoMeta,
  unpushed,
  incoming,
  checked,
  canCheck,
  onToggle,
  onOpenInLog,
  onUndoCommit,
  onRequestCommitFiles,
  onRequestAggregatedDiff,
  onOpenAggregatedFile,
  onOpenCommitFile,
  onRequestIncomingCommitFiles,
  onRequestIncomingAggregatedDiff,
  onOpenIncomingAggregatedFile,
  onOpenIncomingCommitFile,
  onFetch,
  onSquash,
  onDropCommits,
  onRevertCommits,
  onEditCommitMsg,
  onCherryPick,
  onCreateBranchFromCommit,
  onBranchClick,
  iconTheme,
  singleRepo,
  directionFilter = 'all',
  onToggleDirectionFilter,
  isExpanded,
  onToggleExpanded,
  expansionCommand,
  externalFileViewMode,
  speedSearchQuery,
  activeSpeedSearchKey,
  activeCommit,
  onFilesLoaded,
  isFirst = false,
}: {
  repoStatus: RepoStatus;
  repoMeta: RepoMeta | undefined;
  unpushed: Props['unpushedMap'][string] | undefined;
  incoming?: IncomingRepoData;
  checked: boolean;
  canCheck: boolean;
  onToggle: (repoId: string) => void;
  onOpenInLog: (hash: string, repoId: string) => void;
  onUndoCommit: (repoId: string) => void;
  onRequestCommitFiles: (repoId: string, hash: string) => Promise<PushCommitFilesResult>;
  onRequestAggregatedDiff?: (repoId: string, oldestHash?: string) => Promise<PushCommitFile[]>;
  onOpenAggregatedFile: (repoId: string, oldestHash: string | undefined, file: PushCommitFile) => void;
  onOpenCommitFile: (repoId: string, hash: string, file: PushCommitFile) => void;
  onRequestIncomingCommitFiles?: (repoId: string, hash: string) => Promise<PushCommitFilesResult>;
  onRequestIncomingAggregatedDiff?: (repoId: string) => Promise<PushCommitFile[]>;
  onOpenIncomingAggregatedFile?: (repoId: string, file: PushCommitFile) => void;
  onOpenIncomingCommitFile?: (repoId: string, hash: string, file: PushCommitFile) => void;
  onFetch?: (repoId: string) => void;
  onSquash: (repoId: string, hashes: string[], oldestHash: string, combinedMessage: string, commits: { hash: string; shortHash: string; message: string }[]) => void;
  onDropCommits: (repoId: string, hashes: string[], oldestHash: string) => void;
  onRevertCommits: (repoId: string, hashes: string[]) => void;
  onEditCommitMsg: (repoId: string, hash: string, currentMessage: string) => void;
  onCherryPick?: (repoId: string, hashes: string[]) => void;
  onCreateBranchFromCommit?: (repoId: string, hash: string) => void;
  onBranchClick?: (repoId: string) => void;
  iconTheme?: IconThemeData | null;
  singleRepo?: boolean;
  directionFilter?: DirectionFilter;
  onToggleDirectionFilter?: (target: 'outgoing' | 'incoming') => void;
  isExpanded?: boolean;
  onToggleExpanded?: () => void;
  expansionCommand?: ExpansionCommand;
  externalFileViewMode?: PushFileViewMode;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
  activeCommit?: { hash: string; isIncoming: boolean } | null;
  onFilesLoaded?: (repoId: string, files: RepoLoadedFiles) => void;
  isFirst?: boolean;
}) {
  const [internalExpanded, setInternalExpanded] = useState(true);
  const expanded = isExpanded !== undefined ? isExpanded : internalExpanded;
  const handleToggleExpanded = onToggleExpanded ?? (() => setInternalExpanded(v => !v));

  const [pushViewMode, setPushViewMode] = useState<PushViewMode>('commits');
  const [fileViewMode, setFileViewMode] = useState<PushFileViewMode>(externalFileViewMode ?? 'tree');

  useEffect(() => {
    if (externalFileViewMode) {
      setFileViewMode(externalFileViewMode);
    }
  }, [externalFileViewMode]);
  const [expandedCommitHash, setExpandedCommitHash] = useState<string | null>(null);
  const [autoExpandedCommitsKey, setAutoExpandedCommitsKey] = useState('');
  const [filesByHash, setFilesByHash] = useState<Record<string, PushCommitFile[]>>({});
  const filesByHashRef = useRef(filesByHash);
  filesByHashRef.current = filesByHash;
  const [isMergeByHash, setIsMergeByHash] = useState<Record<string, boolean>>({});

  const inFlightCommitHashesRef = useRef<Set<string>>(new Set());
  const inFlightIncomingHashesRef = useRef<Set<string>>(new Set());
  const activePrefetchCountRef = useRef(0);
  const scheduleNextPrefetchRef = useRef<() => void>(() => {});

  useEffect(() => {
    inFlightCommitHashesRef.current.clear();
    inFlightIncomingHashesRef.current.clear();
    activePrefetchCountRef.current = 0;
    scheduleNextPrefetchRef.current = () => {};
  }, [repoStatus.repoId]);

  useEffect(() => {
    if (!expansionCommand || expansionCommand.sequence === 0) return;
    if (!expansionCommand.expanded) {
      setExpandedCommitHash(null);
      setExpandedIncomingHash(null);
    }
  }, [expansionCommand]);
  const [loadingCommitHash, setLoadingCommitHash] = useState<string | null>(null);
  const [aggregatedFiles, setAggregatedFiles] = useState<PushCommitFile[]>([]);
  const [loadingAggregatedFiles, setLoadingAggregatedFiles] = useState(false);
  const [multiSelectHashes, setMultiSelectHashes] = useState<Set<string>>(new Set());
  const [ctxMenu, setCtxMenu] = useState<CommitCtxMenuState | null>(null);

  // Incoming state
  const [expandedIncomingHash, setExpandedIncomingHash] = useState<string | null>(null);
  const [incomingFilesByHash, setIncomingFilesByHash] = useState<Record<string, PushCommitFile[]>>({});
  const incomingFilesByHashRef = useRef(incomingFilesByHash);
  incomingFilesByHashRef.current = incomingFilesByHash;
  const [loadingIncomingHash, setLoadingIncomingHash] = useState<string | null>(null);
  const [aggregatedIncomingFiles, setAggregatedIncomingFiles] = useState<PushCommitFile[]>([]);
  const [loadingAggregatedIncomingFiles, setLoadingAggregatedIncomingFiles] = useState(false);
  const [multiSelectIncomingHashes, setMultiSelectIncomingHashes] = useState<Set<string>>(new Set());
  const [incomingCtxMenu, setIncomingCtxMenu] = useState<IncomingCommitCtxMenuState | null>(null);

  const lastAutoExpandedCommitRef = useRef<string | null>(null);

  useEffect(() => {
    if (!speedSearchQuery) {
      lastAutoExpandedCommitRef.current = null;
      return;
    }
    if (!activeCommit || !activeCommit.hash) return;

    const commitKey = `${activeCommit.isIncoming ? 'in' : 'out'}:${activeCommit.hash}`;
    if (lastAutoExpandedCommitRef.current !== commitKey) {
      lastAutoExpandedCommitRef.current = commitKey;
      if (activeCommit.isIncoming) {
        setExpandedIncomingHash(activeCommit.hash);
      } else {
        setExpandedCommitHash(activeCommit.hash);
      }
    }
  }, [speedSearchQuery, activeCommit]);

  const rawName = repoMeta?.name ?? baseNameFromPath(repoStatus.repoId) ?? repoStatus.repoId;
  const isWorktree = repoMeta?.isWorktree;
  const worktreeBranch = isWorktree
    ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
    : undefined;
  const mainRepoName = baseNameFromPath(repoMeta?.mainWorktreePath);
  const repoName = worktreeBranch ? (mainRepoName ?? rawName) : rawName;
  const branchLabel = repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name;
  const branchClr = branchInfoColor(repoStatus.branch);
  const repoColor = readableAccentColor(repoMeta?.color ?? '#4ec9b0');
  const ahead = repoStatus.branch.aheadBehind?.ahead ?? 0;
  const behind = repoStatus.branch.aheadBehind?.behind ?? 0;
  const isGone = !!repoStatus.branch.isGone;
  const hasUpstream = !!repoStatus.branch.upstream && !isGone;
  const commits = useMemo(() => unpushed?.commits ?? [], [unpushed?.commits]);
  const commitHashesKey = commits.map(commit => commit.hash).join(',');
  const commitCount = hasUpstream ? ahead : commits.length;
  const selectedCommitFiles = expandedCommitHash ? (filesByHash[expandedCommitHash] ?? []) : [];
  const loadingSelectedCommitFiles = loadingCommitHash === expandedCommitHash;

  const incomingCommits = useMemo(() => incoming?.commits ?? [], [incoming?.commits]);
  const incomingCount = behind > 0 ? behind : incomingCommits.length;

  type MixedCommitItem =
    | { kind: 'outgoing'; commit: UnpushedCommit; isHead: boolean }
    | { kind: 'incoming'; commit: IncomingCommit; isHead: boolean };

  const allMixedCommits = useMemo<MixedCommitItem[]>(() => {
    const items: MixedCommitItem[] = [
      ...commits.map((c, idx) => ({ kind: 'outgoing' as const, commit: c, isHead: idx === 0 })),
      ...incomingCommits.map(c => ({ kind: 'incoming' as const, commit: c, isHead: false })),
    ];
    return items.sort((a, b) => {
      const timeA = new Date(a.commit.date).getTime() || 0;
      const timeB = new Date(b.commit.date).getTime() || 0;
      return timeB - timeA;
    });
  }, [commits, incomingCommits]);

  const potentialConflicts = useMemo(() => {
    const set = new Set<string>();
    for (const c of incomingCommits) {
      if (c.potentialConflictPaths) {
        for (const p of c.potentialConflictPaths) set.add(p);
      }
    }
    return set;
  }, [incomingCommits]);


  const isOutgoingActive = directionFilter === 'all' || directionFilter === 'outgoing';
  const isIncomingActive = directionFilter === 'all' || directionFilter === 'incoming';

  const getOutgoingTitle = () => {
    return isOutgoingActive
      ? t('Outgoing selected. Click to deselect')
      : t('Outgoing not selected. Click to select');
  };

  const getIncomingTitle = () => {
    return isIncomingActive
      ? t('Incoming selected. Click to deselect')
      : t('Incoming not selected. Click to select');
  };

  const hasAnyCommits = directionFilter === 'all'
    ? (commits.length > 0 || incomingCommits.length > 0)
    : directionFilter === 'incoming'
      ? incomingCommits.length > 0
      : directionFilter === 'outgoing'
        ? commits.length > 0
        : false;
  const hasLoading = directionFilter === 'all'
    ? ((incoming?.loading && incomingCommits.length === 0) || (unpushed?.loading && commits.length === 0))
    : directionFilter === 'incoming'
      ? (incoming?.loading && incomingCommits.length === 0)
      : (unpushed?.loading && commits.length === 0);
  const hasError = directionFilter === 'all'
    ? (incoming?.error && incomingCommits.length === 0) || (unpushed?.error && commits.length === 0)
    : directionFilter === 'incoming'
      ? (incoming?.error && incomingCommits.length === 0)
      : (unpushed?.error && commits.length === 0);
  const canTogglePushView = hasAnyCommits && !hasLoading && !hasError;
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
      .then(res => {
        if (!active) return;
        const resultFiles = Array.isArray(res) ? res : (res.files ?? []);
        const isMergeCommit = Array.isArray(res) ? false : Boolean(res.isMerge);

        setFilesByHash(prev => ({ ...prev, [expandedCommitHash]: resultFiles }));
        if (isMergeCommit) {
          setIsMergeByHash(prev => ({ ...prev, [expandedCommitHash]: true }));
        }
      })
      .finally(() => {
        if (!active) return;
        setLoadingCommitHash(current => current === expandedCommitHash ? null : current);
      });

    return () => { active = false; };
  }, [expandedCommitHash, filesByHash, onRequestCommitFiles, repoStatus.repoId]);

  useEffect(() => {
    let active = true;
    if (pushViewMode !== 'changes' || directionFilter === 'incoming') {
      return () => { active = false; };
    }
    if (commits.length === 0) {
      setAggregatedFiles([]);
      return () => { active = false; };
    }

    setLoadingAggregatedFiles(true);
    const loadPerCommitFallback = async (): Promise<PushCommitFile[]> => {
      const currentFilesByHash = filesByHashRef.current;
      const cachedGroups = commits
        .map(commit => currentFilesByHash[commit.hash])
        .filter((files): files is PushCommitFile[] => Array.isArray(files));
      const missingCommits = commits.filter(commit => !currentFilesByHash[commit.hash]);
      if (missingCommits.length === 0) return mergeUniqueFiles(cachedGroups);

      const groups = await Promise.all(missingCommits.map(async commit => {
        const res = await onRequestCommitFiles(repoStatus.repoId, commit.hash);
        return Array.isArray(res) ? res : (res.files ?? []);
      }));
      const fetched = Object.fromEntries(missingCommits.map((commit, index) => [commit.hash, groups[index] ?? []]));
      if (active) setFilesByHash(prev => ({ ...prev, ...fetched }));
      return mergeUniqueFiles([...cachedGroups, ...groups]);
    };

    void (async () => {
      try {
        const files = onRequestAggregatedDiff
          ? await onRequestAggregatedDiff(repoStatus.repoId, commits[commits.length - 1]?.hash)
          : await loadPerCommitFallback();
        if (active) setAggregatedFiles(files);
      } catch {
        try {
          const files = await loadPerCommitFallback();
          if (active) setAggregatedFiles(files);
        } catch {
          if (active) setAggregatedFiles([]);
        }
      } finally {
        if (active) setLoadingAggregatedFiles(false);
      }
    })();

    return () => { active = false; };
  }, [commitHashesKey, commits, directionFilter, onRequestAggregatedDiff, onRequestCommitFiles, pushViewMode, repoStatus.repoId]);

  // Incoming commit selection & files (do not auto-expand first commit)
  useEffect(() => {
    if (expandedIncomingHash && !incomingCommits.some(c => c.hash === expandedIncomingHash)) {
      setExpandedIncomingHash(null);
    }
  }, [expandedIncomingHash, incomingCommits]);

  useEffect(() => {
    let active = true;
    if (directionFilter === 'outgoing' || !expandedIncomingHash || incomingFilesByHash[expandedIncomingHash]) {
      return () => { active = false; };
    }
    const req = onRequestIncomingCommitFiles ?? onRequestCommitFiles;
    setLoadingIncomingHash(expandedIncomingHash);
    void req(repoStatus.repoId, expandedIncomingHash)
      .then(res => {
        if (!active) return;
        const resultFiles = Array.isArray(res) ? res : (res.files ?? []);
        const isMergeCommit = Array.isArray(res) ? false : Boolean(res.isMerge);

        setIncomingFilesByHash(prev => ({ ...prev, [expandedIncomingHash]: resultFiles }));
        if (isMergeCommit) {
          setIsMergeByHash(prev => ({ ...prev, [expandedIncomingHash]: true }));
        }
      })
      .finally(() => {
        if (!active) return;
        setLoadingIncomingHash(curr => curr === expandedIncomingHash ? null : curr);
      });
    return () => { active = false; };
  }, [directionFilter, expandedIncomingHash, incomingFilesByHash, onRequestCommitFiles, onRequestIncomingCommitFiles, repoStatus.repoId]);

  // Incoming aggregated diff
  useEffect(() => {
    let active = true;
    if (directionFilter === 'outgoing' || pushViewMode !== 'changes') {
      return () => { active = false; };
    }
    if (incomingCommits.length === 0) {
      setAggregatedIncomingFiles([]);
      return () => { active = false; };
    }
    setLoadingAggregatedIncomingFiles(true);

    const loadIncomingFallback = async (): Promise<PushCommitFile[]> => {
      const req = onRequestIncomingCommitFiles ?? onRequestCommitFiles;
      const groups = await Promise.all(
        incomingCommits.map(async c => {
          try {
            const res = await req(repoStatus.repoId, c.hash);
            return Array.isArray(res) ? res : (res.files ?? []);
          } catch {
            return [];
          }
        })
      );
      return mergeUniqueFiles(groups);
    };

    void (async () => {
      try {
        let files: PushCommitFile[] = [];
        if (onRequestIncomingAggregatedDiff) {
          files = await onRequestIncomingAggregatedDiff(repoStatus.repoId);
        }
        if (!files || files.length === 0) {
          files = await loadIncomingFallback();
        }
        if (active) setAggregatedIncomingFiles(files);
      } catch {
        try {
          const fallback = await loadIncomingFallback();
          if (active) setAggregatedIncomingFiles(fallback);
        } catch {
          if (active) setAggregatedIncomingFiles([]);
        }
      } finally {
        if (active) setLoadingAggregatedIncomingFiles(false);
      }
    })();

    return () => { active = false; };
  }, [directionFilter, incomingCommits, onRequestCommitFiles, onRequestIncomingAggregatedDiff, onRequestIncomingCommitFiles, pushViewMode, repoStatus.repoId]);

  // 当开启搜索时，在 commits 模式下预取当前方向可视提交的文件，确保完整索引（受限并发与可取消）
  useEffect(() => {
    if (!speedSearchQuery || pushViewMode !== 'commits') return;
    let cancelled = false;

    type FetchTask = {
      hash: string;
      isIncoming: boolean;
    };

    const tasks: FetchTask[] = [];

    if (directionFilter === 'all' || directionFilter === 'outgoing') {
      for (const c of commits) {
        if (!filesByHashRef.current[c.hash] && loadingCommitHash !== c.hash && !inFlightCommitHashesRef.current.has(c.hash)) {
          tasks.push({ hash: c.hash, isIncoming: false });
        }
      }
    }
    if ((directionFilter === 'all' || directionFilter === 'incoming') && onRequestIncomingCommitFiles) {
      for (const c of incomingCommits) {
        if (!incomingFilesByHashRef.current[c.hash] && loadingIncomingHash !== c.hash && !inFlightIncomingHashesRef.current.has(c.hash)) {
          tasks.push({ hash: c.hash, isIncoming: true });
        }
      }
    }

    if (tasks.length === 0) return;

    const CONCURRENCY_LIMIT = 4;
    let taskIndex = 0;

    const runNext = () => {
      if (cancelled) return;
      while (activePrefetchCountRef.current < CONCURRENCY_LIMIT && taskIndex < tasks.length) {
        const task = tasks[taskIndex++];
        activePrefetchCountRef.current++;
        if (task.isIncoming) {
          inFlightIncomingHashesRef.current.add(task.hash);
          void onRequestIncomingCommitFiles!(repoStatus.repoId, task.hash)
            .then(res => {
              const fetched = Array.isArray(res) ? res : (res.files ?? []);
              if (!Array.isArray(res) && res.isMerge) {
                setIsMergeByHash(prev => ({ ...prev, [task.hash]: true }));
              }
              setIncomingFilesByHash(prev => ({ ...prev, [task.hash]: fetched }));
            })
            .catch(() => {
              setIncomingFilesByHash(prev => ({ ...prev, [task.hash]: [] }));
            })
            .finally(() => {
              inFlightIncomingHashesRef.current.delete(task.hash);
              activePrefetchCountRef.current = Math.max(0, activePrefetchCountRef.current - 1);
              scheduleNextPrefetchRef.current();
            });
        } else {
          inFlightCommitHashesRef.current.add(task.hash);
          void onRequestCommitFiles(repoStatus.repoId, task.hash)
            .then(res => {
              const fetched = Array.isArray(res) ? res : (res.files ?? []);
              if (!Array.isArray(res) && res.isMerge) {
                setIsMergeByHash(prev => ({ ...prev, [task.hash]: true }));
              }
              setFilesByHash(prev => ({ ...prev, [task.hash]: fetched }));
            })
            .catch(() => {
              setFilesByHash(prev => ({ ...prev, [task.hash]: [] }));
            })
            .finally(() => {
              inFlightCommitHashesRef.current.delete(task.hash);
              activePrefetchCountRef.current = Math.max(0, activePrefetchCountRef.current - 1);
              scheduleNextPrefetchRef.current();
            });
        }
      }
    };

    scheduleNextPrefetchRef.current = runNext;
    runNext();

    return () => {
      cancelled = true;
      if (scheduleNextPrefetchRef.current === runNext) {
        scheduleNextPrefetchRef.current = () => {};
      }
    };
  }, [speedSearchQuery, pushViewMode, directionFilter, commits, incomingCommits, loadingCommitHash, loadingIncomingHash, onRequestCommitFiles, onRequestIncomingCommitFiles, repoStatus.repoId]);

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
    onEditCommitMsg(repoStatus.repoId, ctxMenu.singleHash, commit.fullMessage || commit.message);
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

  const toggleIncomingCommitSelection = (hash: string) => {
    setMultiSelectIncomingHashes(prev => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  };

  const handleIncomingContextMenu = (event: React.MouseEvent, commit: IncomingCommit) => {
    event.preventDefault();
    event.stopPropagation();
    let selectedHashes: Set<string>;
    if (multiSelectIncomingHashes.has(commit.hash) && multiSelectIncomingHashes.size > 1) {
      selectedHashes = multiSelectIncomingHashes;
    } else {
      selectedHashes = new Set([commit.hash]);
      setMultiSelectIncomingHashes(selectedHashes);
    }
    const isSingle = selectedHashes.size === 1;
    let orderedHashes: string[];
    const incomingCommits = incoming?.commits ?? [];
    if (isSingle) {
      orderedHashes = [commit.hash];
    } else {
      // incomingCommits 是按时间降序（新到旧，index 0 为最新）。
      // Cherry-pick 必须按拓扑与时间由旧到新应用，因此对匹配到的提交做逆序排列。
      const sorted = incomingCommits
        .filter(c => selectedHashes.has(c.hash))
        .map(c => c.hash)
        .reverse();
      const remaining = Array.from(selectedHashes).filter(h => !sorted.includes(h));
      orderedHashes = [...sorted, ...remaining];
    }
    const incomingCommit = commit as IncomingCommit;
    const hasMergeCommit = isSingle
      ? Boolean(incomingCommit.parents && incomingCommit.parents.length > 1)
      : incomingCommits
          .filter(c => selectedHashes.has(c.hash))
          .some(c => Boolean(c.parents && c.parents.length > 1));
    setIncomingCtxMenu({
      x: event.clientX,
      y: event.clientY,
      repoId: repoStatus.repoId,
      selectedHashes: orderedHashes,
      singleHash: isSingle ? commit.hash : null,
      hasMergeCommit,
    });
  };

  const handleBodyClick = (event: React.MouseEvent) => {
    if (!(event.target as HTMLElement).closest('[data-commit-row]')) {
      setMultiSelectHashes(new Set());
      setMultiSelectIncomingHashes(new Set());
    }
  };

  useEffect(() => {
    onFilesLoaded?.(repoStatus.repoId, {
      pushViewMode,
      filesByHash,
      incomingFilesByHash,
      aggregatedFiles,
      aggregatedIncomingFiles,
    });
  }, [repoStatus.repoId, pushViewMode, filesByHash, incomingFilesByHash, aggregatedFiles, aggregatedIncomingFiles, onFilesLoaded]);

  return (
    <div className="versiondock-repo-section" data-first={isFirst ? 'true' : undefined} style={styles.repoRoot}>
      <div
        className="versiondock-repo-header"
        style={{ ...styles.repoHeader, '--repo-color': repoColor } as React.CSSProperties}
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
        <div style={styles.headerMain} onClick={handleToggleExpanded}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '11px', flexShrink: 0 }} />
          <span style={styles.dot(repoColor)} />
          <span style={styles.repoName}>{repoName}</span>
          <span
            data-branch-switch-badge=""
            style={styles.branchBadge(branchClr)}
            onClick={e => { e.stopPropagation(); onBranchClick?.(repoStatus.repoId); }}
            title={branchTitle}
          >
            <Codicon name={worktreeBranch ? 'repo-clone' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0 }} />
            <span style={styles.branchName}>{branchLabel}</span>
          </span>
          {(commitCount > 0 || canTogglePushView || incomingCount > 0 || !hasUpstream || Boolean(onFetch)) && (
            <div style={styles.repoRightGroup}>
              {onFetch && (
                <button
                  type="button"
                  data-action-btn=""
                  style={styles.repoModeButton(false, false)}
                  title={t('Fetch remote changes')}
                  onClick={event => {
                    event.stopPropagation();
                    onFetch(repoStatus.repoId);
                  }}
                >
                  <Codicon name="cloud-download" />
                </button>
              )}
              <button
                type="button"
                data-action-btn=""
                data-active={pushViewMode === 'changes' ? 'true' : undefined}
                style={styles.repoModeButton(!canTogglePushView, pushViewMode === 'changes')}
                disabled={!canTogglePushView}
                title={pushViewMode === 'commits' ? t('Show aggregated changes') : t('Show commit list')}
                onClick={event => {
                  event.stopPropagation();
                  if (!canTogglePushView) return;
                  setPushViewMode(value => value === 'commits' ? 'changes' : 'commits');
                  if (!expanded) handleToggleExpanded();
                }}
              >
                <Codicon name={pushViewMode === 'commits' ? 'diff-multiple' : 'list-unordered'} />
              </button>
              {commitCount > 0 && incomingCount > 0 ? (
                <>
                  <span
                    style={{
                      ...styles.directionBadge(PUSH_COLOR),
                      cursor: 'pointer',
                      opacity: isOutgoingActive ? 1 : 0.45,
                      border: isOutgoingActive ? `1px solid ${PUSH_COLOR}` : '1px solid transparent',
                      background: isOutgoingActive
                        ? 'color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #81c784) 22%, transparent)'
                        : 'transparent',
                    }}
                    title={getOutgoingTitle()}
                    onClick={event => {
                      event.stopPropagation();
                      onToggleDirectionFilter?.('outgoing');
                    }}
                  >
                    <Codicon name="arrow-up" style={{ fontSize: '10px', marginRight: '2px' }} />
                    {commitCount}
                  </span>
                  <span
                    style={{
                      ...styles.directionBadge(PULL_COLOR),
                      cursor: 'pointer',
                      opacity: isIncomingActive ? 1 : 0.45,
                      border: isIncomingActive ? `1px solid ${PULL_COLOR}` : '1px solid transparent',
                      background: isIncomingActive
                        ? 'color-mix(in srgb, var(--vscode-charts-blue, #64b5f6) 22%, transparent)'
                        : 'transparent',
                    }}
                    title={getIncomingTitle()}
                    onClick={event => {
                      event.stopPropagation();
                      onToggleDirectionFilter?.('incoming');
                    }}
                  >
                    <Codicon name="arrow-down" style={{ fontSize: '10px', marginRight: '2px' }} />
                    {incomingCount}
                  </span>
                </>
              ) : commitCount > 0 ? (
                <span
                  style={{
                    ...styles.directionBadge(PUSH_COLOR),
                    cursor: 'pointer',
                    opacity: isOutgoingActive ? 1 : 0.45,
                    border: isOutgoingActive ? `1px solid ${PUSH_COLOR}` : '1px solid transparent',
                    background: isOutgoingActive
                      ? 'color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #81c784) 22%, transparent)'
                      : 'transparent',
                  }}
                  title={getOutgoingTitle()}
                  onClick={event => {
                    event.stopPropagation();
                    onToggleDirectionFilter?.('outgoing');
                  }}
                >
                  <Codicon name="arrow-up" style={{ fontSize: '10px', marginRight: '2px' }} />
                  {commitCount}
                </span>
              ) : incomingCount > 0 ? (
                <span
                  style={{
                    ...styles.directionBadge(PULL_COLOR),
                    cursor: 'pointer',
                    opacity: isIncomingActive ? 1 : 0.45,
                    border: isIncomingActive ? `1px solid ${PULL_COLOR}` : '1px solid transparent',
                    background: isIncomingActive
                      ? 'color-mix(in srgb, var(--vscode-charts-blue, #64b5f6) 22%, transparent)'
                      : 'transparent',
                  }}
                  title={getIncomingTitle()}
                  onClick={event => {
                    event.stopPropagation();
                    onToggleDirectionFilter?.('incoming');
                  }}
                >
                  <Codicon name="arrow-down" style={{ fontSize: '10px', marginRight: '2px' }} />
                  {incomingCount}
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
          {hasUpstream && ahead === 0 && behind === 0 && commits.length === 0 && incomingCommits.length === 0 ? (
            <div style={styles.upToDate}>
              <Codicon name="check" style={{ marginRight: '6px' }} />
              {t('Up to date')}
            </div>
          ) : directionFilter === 'none' ? (
            <div style={styles.loadingRow}>
              {t('No commit type selected')}
            </div>
          ) : pushViewMode === 'changes' ? (
            /* ── Changes View (Aggregated) ── */
            directionFilter === 'incoming' ? (
              <AggregatedChangesView
                files={aggregatedIncomingFiles}
                loading={loadingAggregatedIncomingFiles}
                fileViewMode={fileViewMode}
                iconTheme={iconTheme}
                potentialConflicts={potentialConflicts}
                onOpenFile={file => onOpenIncomingAggregatedFile?.(repoStatus.repoId, file)}
                speedSearchQuery={speedSearchQuery}
                activeSpeedSearchKey={activeSpeedSearchKey}
                repoId={repoStatus.repoId}
                isIncoming={true}
              />
            ) : directionFilter === 'outgoing' ? (
              <AggregatedChangesView
                files={aggregatedFiles}
                loading={loadingAggregatedFiles}
                fileViewMode={fileViewMode}
                iconTheme={iconTheme}
                onOpenFile={file => onOpenAggregatedFile(repoStatus.repoId, commits[commits.length - 1]?.hash, file)}
                speedSearchQuery={speedSearchQuery}
                activeSpeedSearchKey={activeSpeedSearchKey}
                repoId={repoStatus.repoId}
                isIncoming={false}
              />
            ) : (
              /* directionFilter === 'all' */
              <div>
                {incomingCommits.length > 0 && (
                  <div>
                    <div style={styles.aggSectionHeader}>
                      <Codicon name="arrow-down" style={{ color: PULL_COLOR, marginRight: '5px' }} />
                      <span>{t('Incoming Changes ({0})', aggregatedIncomingFiles.length)}</span>
                    </div>
                    <AggregatedChangesView
                      files={aggregatedIncomingFiles}
                      loading={loadingAggregatedIncomingFiles}
                      fileViewMode={fileViewMode}
                      iconTheme={iconTheme}
                      potentialConflicts={potentialConflicts}
                      onOpenFile={file => onOpenIncomingAggregatedFile?.(repoStatus.repoId, file)}
                      speedSearchQuery={speedSearchQuery}
                      activeSpeedSearchKey={activeSpeedSearchKey}
                      repoId={repoStatus.repoId}
                      isIncoming={true}
                    />
                  </div>
                )}
                {commits.length > 0 && (
                  <div>
                    <div style={styles.aggSectionHeader}>
                      <Codicon name="arrow-up" style={{ color: PUSH_COLOR, marginRight: '5px' }} />
                      <span>{t('Outgoing Changes ({0})', aggregatedFiles.length)}</span>
                    </div>
                    <AggregatedChangesView
                      files={aggregatedFiles}
                      loading={loadingAggregatedFiles}
                      fileViewMode={fileViewMode}
                      iconTheme={iconTheme}
                      onOpenFile={file => onOpenAggregatedFile(repoStatus.repoId, commits[commits.length - 1]?.hash, file)}
                      speedSearchQuery={speedSearchQuery}
                      activeSpeedSearchKey={activeSpeedSearchKey}
                      repoId={repoStatus.repoId}
                      isIncoming={false}
                    />
                  </div>
                )}
              </div>
            )
          ) : (
            /* ── Commits View ── */
            directionFilter === 'incoming' ? (
              incoming?.loading && incomingCommits.length === 0 ? (
                <div style={styles.loadingRow}>{t('Loading commits…')}</div>
              ) : incoming?.error ? (
                <div style={styles.errorRow}>
                  <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
                  {incoming.error}
                </div>
              ) : incomingCommits.length > 0 ? (
                <div style={styles.commitList}>
                  {incomingCommits.map(commit => (
                    <CommitRow
                      key={commit.hash}
                      commit={commit}
                      repoId={repoStatus.repoId}
                      isHead={false}
                      expanded={commit.hash === expandedIncomingHash}
                      selected={multiSelectIncomingHashes.has(commit.hash)}
                      files={commit.hash === expandedIncomingHash ? (incomingFilesByHash[commit.hash] ?? []) : []}
                      loadingFiles={commit.hash === expandedIncomingHash ? loadingIncomingHash === commit.hash : false}
                      fileViewMode={fileViewMode}
                      iconTheme={iconTheme}
                      isIncoming
                      showDirectionBadge={true}
                      potentialConflicts={commit.potentialConflictPaths ? new Set(commit.potentialConflictPaths) : undefined}
                      speedSearchQuery={speedSearchQuery}
                      activeSpeedSearchKey={activeSpeedSearchKey}
                      isMerge={Boolean(isMergeByHash[commit.hash] || (commit.parents && commit.parents.length >= 2))}
                      onToggle={() => {
                        setMultiSelectIncomingHashes(new Set());
                        setExpandedIncomingHash(current => current === commit.hash ? null : commit.hash);
                      }}
                      onSelect={() => toggleIncomingCommitSelection(commit.hash)}
                      onContextMenu={event => handleIncomingContextMenu(event, commit)}
                      onFileViewModeChange={setFileViewMode}
                      onOpenFile={file => onOpenIncomingCommitFile?.(repoStatus.repoId, commit.hash, file)}
                      onOpenInLog={onOpenInLog}
                      onUndoCommit={() => {}}
                    />
                  ))}
                </div>
              ) : incomingCount > 0 ? (
                <div style={styles.behindRow}>
                  <Codicon name="arrow-down" style={{ marginRight: '6px', flexShrink: 0 }} />
                  <span>{incomingCount === 1 ? t('{0} commit to update from {1}', incomingCount, repoStatus.branch.upstream ?? '') : t('{0} commits to update from {1}', incomingCount, repoStatus.branch.upstream ?? '')}</span>
                </div>
              ) : (
                <div style={styles.upToDate}>
                  <Codicon name="check" style={{ marginRight: '6px' }} />
                  {t('Up to date')}
                </div>
              )
            ) : directionFilter === 'outgoing' ? (
              hasUpstream && ahead === 0 && behind === 0 ? (
                <div style={styles.upToDate}>
                  <Codicon name="check" style={{ marginRight: '6px' }} />
                  {t('Up to date')}
                </div>
              ) : unpushed?.loading && commits.length === 0 ? (
                <div style={styles.loadingRow}>{t('Loading commits…')}</div>
              ) : unpushed?.error ? (
                <div style={styles.errorRow}>
                  <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
                  {unpushed.error}
                </div>
              ) : commits.length > 0 ? (
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
                      showDirectionBadge={true}
                      speedSearchQuery={speedSearchQuery}
                      activeSpeedSearchKey={activeSpeedSearchKey}
                      isMerge={Boolean(isMergeByHash[commit.hash] || (commit.parents && commit.parents.length >= 2))}
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
              ) : !hasUpstream ? (
                <div style={styles.unpublishedRow}>
                  <Codicon name="cloud-upload" style={{ marginRight: '6px', flexShrink: 0 }} />
                  <span>{t('Local branch — not published to any remote yet')}</span>
                </div>
              ) : (
                <div style={styles.upToDate}>
                  <Codicon name="check" style={{ marginRight: '6px' }} />
                  {t('Up to date')}
                </div>
              )
            ) : (
              /* ── directionFilter === 'all' (Mixed Timeline) ── */
              allMixedCommits.length > 0 ? (
                <div style={styles.commitList}>
                  {allMixedCommits.map(item => {
                    if (item.kind === 'incoming') {
                      return (
                        <CommitRow
                          key={`in-${item.commit.hash}`}
                          commit={item.commit}
                          repoId={repoStatus.repoId}
                          isHead={false}
                          expanded={item.commit.hash === expandedIncomingHash}
                          selected={multiSelectIncomingHashes.has(item.commit.hash)}
                          files={item.commit.hash === expandedIncomingHash ? (incomingFilesByHash[item.commit.hash] ?? []) : []}
                          loadingFiles={item.commit.hash === expandedIncomingHash ? loadingIncomingHash === item.commit.hash : false}
                          fileViewMode={fileViewMode}
                          iconTheme={iconTheme}
                          isIncoming
                          showDirectionBadge={true}
                          potentialConflicts={item.commit.potentialConflictPaths ? new Set(item.commit.potentialConflictPaths) : undefined}
                          speedSearchQuery={speedSearchQuery}
                          activeSpeedSearchKey={activeSpeedSearchKey}
                          isMerge={Boolean(isMergeByHash[item.commit.hash] || (item.commit.parents && item.commit.parents.length >= 2))}
                          onToggle={() => {
                            setMultiSelectIncomingHashes(new Set());
                            setExpandedIncomingHash(current => current === item.commit.hash ? null : item.commit.hash);
                          }}
                          onSelect={() => toggleIncomingCommitSelection(item.commit.hash)}
                          onContextMenu={event => handleIncomingContextMenu(event, item.commit)}
                          onFileViewModeChange={setFileViewMode}
                          onOpenFile={file => onOpenIncomingCommitFile?.(repoStatus.repoId, item.commit.hash, file)}
                          onOpenInLog={onOpenInLog}
                          onUndoCommit={() => {}}
                        />
                      );
                    } else {
                      return (
                        <CommitRow
                          key={`out-${item.commit.hash}`}
                          commit={item.commit}
                          repoId={repoStatus.repoId}
                          isHead={item.isHead}
                          expanded={item.commit.hash === expandedCommitHash}
                          selected={multiSelectHashes.has(item.commit.hash)}
                          files={item.commit.hash === expandedCommitHash ? selectedCommitFiles : []}
                          loadingFiles={item.commit.hash === expandedCommitHash ? loadingSelectedCommitFiles : false}
                          fileViewMode={fileViewMode}
                          iconTheme={iconTheme}
                          showDirectionBadge={true}
                          speedSearchQuery={speedSearchQuery}
                          activeSpeedSearchKey={activeSpeedSearchKey}
                          isMerge={Boolean(isMergeByHash[item.commit.hash] || (item.commit.parents && item.commit.parents.length >= 2))}
                          onToggle={() => {
                            setMultiSelectHashes(new Set());
                            setExpandedCommitHash(current => current === item.commit.hash ? null : item.commit.hash);
                          }}
                          onSelect={() => toggleCommitSelection(item.commit.hash)}
                          onContextMenu={event => handleCommitContextMenu(event, item.commit, item.isHead)}
                          onFileViewModeChange={setFileViewMode}
                          onOpenFile={file => onOpenCommitFile(repoStatus.repoId, item.commit.hash, file)}
                          onOpenInLog={onOpenInLog}
                          onUndoCommit={onUndoCommit}
                        />
                      );
                    }
                  })}
                </div>
              ) : hasUpstream && ahead === 0 && behind === 0 ? (
                <div style={styles.upToDate}>
                  <Codicon name="check" style={{ marginRight: '6px' }} />
                  {t('Up to date')}
                </div>
              ) : (unpushed?.loading || incoming?.loading) ? (
                <div style={styles.loadingRow}>{t('Loading commits…')}</div>
              ) : (unpushed?.error || incoming?.error) ? (
                <div style={styles.errorRow}>
                  <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
                  {unpushed?.error || incoming?.error}
                </div>
              ) : !hasUpstream ? (
                <div style={styles.unpublishedRow}>
                  <Codicon name="cloud-upload" style={{ marginRight: '6px', flexShrink: 0 }} />
                  <span>{t('Local branch — not published to any remote yet')}</span>
                </div>
              ) : (
                <div style={styles.upToDate}>
                  <Codicon name="check" style={{ marginRight: '6px' }} />
                  {t('Up to date')}
                </div>
              )
            )
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

      {incomingCtxMenu && (
        <IncomingCommitContextMenu
          state={incomingCtxMenu}
          onCherryPick={hashes => onCherryPick?.(repoStatus.repoId, hashes)}
          onCreateBranch={hash => onCreateBranchFromCommit?.(repoStatus.repoId, hash)}
          onViewInLog={hash => onOpenInLog(hash, repoStatus.repoId)}
          onClose={() => { setIncomingCtxMenu(null); setMultiSelectIncomingHashes(new Set()); }}
        />
      )}

    </div>
  );
}

interface SplitDropdownButtonItem {
  icon: string;
  label: string;
  danger?: boolean;
  onSelect: () => void;
}

interface SplitDropdownButtonProps {
  enabled: boolean;
  chevronEnabled?: boolean;
  icon: string;
  label: string;
  title?: string;
  disabledTitle?: string;
  fullWidth?: boolean;
  dropdownAlign?: 'left' | 'right';
  items: SplitDropdownButtonItem[];
  onMainClick: () => void;
  colorVariant?: 'default' | 'pull' | 'push';
}

function SplitDropdownButton({
  enabled,
  chevronEnabled,
  icon,
  label,
  title,
  disabledTitle,
  fullWidth,
  dropdownAlign = 'left',
  items,
  onMainClick,
  colorVariant = 'default',
}: SplitDropdownButtonProps) {
  const [open, setOpen] = useState(false);
  const [hoverMain, setHoverMain] = useState(false);
  const [pressedMain, setPressedMain] = useState(false);
  const [hoverChevron, setHoverChevron] = useState(false);
  const [pressedChevron, setPressedChevron] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hasItems = items.length > 0;
  const isChevronActive = (chevronEnabled ?? enabled) && hasItems;

  useEffect(() => {
    if (!open) return;
    const outsideHandler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const blurHandler = () => setOpen(false);
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') setOpen(false);
    };
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outsideHandler, true);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    window.addEventListener('pagehide', blurHandler);
    window.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', outsideHandler, true);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
      window.removeEventListener('pagehide', blurHandler);
      window.removeEventListener('keydown', keyHandler);
    };
  }, [open]);

  let bg = 'var(--vscode-button-background)';
  let bgHover = 'var(--vscode-button-hoverBackground, var(--vscode-button-background))';
  let fg = 'var(--vscode-button-foreground)';

  if (colorVariant === 'pull') {
    bg = 'color-mix(in srgb, var(--vscode-charts-blue, #1f6feb) 85%, #0d419d 15%)';
    bgHover = bg;
    fg = '#ffffff';
  } else if (colorVariant === 'push') {
    bg = 'color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #238636) 75%, #196c2e 25%)';
    bgHover = bg;
    fg = '#ffffff';
  }

  const childStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: bg,
    color: fg,
    border: 'none',
    fontSize: '12px',
    fontFamily: 'var(--vscode-font-family)',
    userSelect: 'none',
    whiteSpace: 'nowrap',
    outline: 'none',
  };

  const dropItemStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '6px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    userSelect: 'none',
    whiteSpace: 'nowrap',
  };

  const isWholeButtonDisabled = !enabled && !isChevronActive;

  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        display: 'flex',
        flex: fullWidth ? 1 : undefined,
        width: fullWidth ? '100%' : undefined,
        opacity: isWholeButtonDisabled ? 0.45 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          flex: 1,
          width: '100%',
          border: '1px solid var(--vscode-button-border, transparent)',
          borderRadius: '3px',
          overflow: 'hidden',
          backgroundColor: bg,
          ['--split-btn-bg' as string]: bg,
          ['--split-btn-hover-bg' as string]: bgHover,
          ['--split-btn-fg' as string]: fg,
        }}
      >
        <button
          data-split-main-btn=""
          style={{
            ...childStyle,
            flex: 1,
            gap: '6px',
            padding: '6px 12px',
            cursor: enabled ? 'pointer' : 'default',
            opacity: enabled ? 1 : 0.5,
            backgroundColor: hoverMain && enabled ? bgHover : bg,
            transform: enabled && pressedMain ? 'translateY(1px) scale(0.995)' : 'none',
            filter: enabled && pressedMain ? 'brightness(0.92)' : 'none',
            transition: 'background-color 80ms ease, transform 60ms ease, filter 60ms ease',
          }}
          disabled={!enabled}
          title={enabled ? (title ?? label) : (disabledTitle ?? '')}
          onClick={() => { if (enabled) onMainClick(); }}
          onMouseEnter={() => setHoverMain(true)}
          onMouseLeave={() => {
            setHoverMain(false);
            setPressedMain(false);
          }}
          onMouseDown={() => { if (enabled) setPressedMain(true); }}
          onMouseUp={() => setPressedMain(false)}
        >
          <Codicon name={icon} style={{ fontSize: '13px', flexShrink: 0 }} />
          <span>{label}</span>
        </button>
        {hasItems && (
          <>
            <div
              style={{
                width: '1px',
                alignSelf: 'stretch',
                padding: '4px 0',
                flexShrink: 0,
                display: 'flex',
                backgroundColor: 'inherit',
              }}
            >
              <div
                style={{
                  flex: 1,
                  backgroundColor: fg,
                  opacity: 0.3,
                }}
              />
            </div>
            <button
              data-split-chevron-btn=""
              style={{
                ...childStyle,
                padding: '6px 8px',
                cursor: isChevronActive ? 'pointer' : 'default',
                opacity: isChevronActive ? 1 : 0.5,
                backgroundColor: hoverChevron && isChevronActive ? bgHover : bg,
                transform: isChevronActive && pressedChevron ? 'translateY(1px) scale(0.995)' : 'none',
                filter: isChevronActive && pressedChevron ? 'brightness(0.92)' : 'none',
                transition: 'background-color 80ms ease, transform 60ms ease, filter 60ms ease',
              }}
              disabled={!isChevronActive}
              title={t('More Actions...')}
              onClick={() => { if (isChevronActive) setOpen(o => !o); }}
              onMouseEnter={() => setHoverChevron(true)}
              onMouseLeave={() => {
                setHoverChevron(false);
                setPressedChevron(false);
              }}
              onMouseDown={() => { if (isChevronActive) setPressedChevron(true); }}
              onMouseUp={() => setPressedChevron(false)}
            >
              <Codicon name="chevron-down" style={{ fontSize: '11px' }} />
            </button>
          </>
        )}
      </div>
      {open && hasItems && (
        <div
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 4px)',
            ...(dropdownAlign === 'right' ? { right: 0 } : { left: 0 }),
            background: 'var(--vscode-menu-background, var(--vscode-sideBar-background))',
            border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
            borderRadius: '4px',
            boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
            zIndex: 9999,
            minWidth: '170px',
            padding: '3px 0',
          }}
        >
          {items.map(item => (
            <SplitDropItem
              key={item.label}
              icon={item.icon}
              label={item.label}
              danger={item.danger}
              itemStyle={dropItemStyle}
              onSelect={() => {
                item.onSelect();
                setOpen(false);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function SplitDropItem({
  icon,
  label,
  danger,
  itemStyle,
  onSelect,
}: {
  icon: string;
  label: string;
  danger?: boolean;
  itemStyle: React.CSSProperties;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      style={{
        ...itemStyle,
        background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent',
        color: danger ? 'var(--vscode-errorForeground, #f48771)' : 'var(--vscode-menu-foreground)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={onSelect}
    >
      <Codicon name={icon} style={{ fontSize: '13px', flexShrink: 0 }} />
      <span>{label}</span>
    </div>
  );
}

export function PushTab(props: Props) {
  const {
    isActive,
    repos,
    repoMetas,
    iconTheme,
    unpushedMap,
    incomingMap,
    onPush,
    onPushMulti,
    onForcePush,
    onForcePushMulti,
    onPushTags,
    onPushTagsMulti,
    onPull,
    onPullMulti,
    onSync,
    onSyncMulti,
    onFetch,
    onFetchAll,
    onOpenInLog,
    onUndoCommit,
    onRequestCommitFiles,
    onRequestAggregatedDiff,
    onOpenAggregatedFile,
    onOpenCommitFile,
    onRequestIncomingCommitFiles,
    onRequestIncomingAggregatedDiff,
    onOpenIncomingAggregatedFile,
    onOpenIncomingCommitFile,
    onSquash,
    onDropCommits,
    onRevertCommits,
    onEditCommitMsg,
    onCherryPick,
    onCreateBranchFromCommit,
    onBranchClick,
    expansionCommand,
    viewMode,
    onExpansionChange,
    selectionCommand,
    onSelectionChange,
  } = props;
  const metaMap = new Map(repoMetas.map(meta => [meta.id, meta]));
  const isSingleRepo = repos.length === 1;
  const [checked, setChecked] = useState<Set<string>>(() => new Set<string>());

  const [repoLoadedFiles, setRepoLoadedFiles] = useState<Record<string, RepoLoadedFiles>>({});
  const handleFilesLoaded = useCallback((repoId: string, files: RepoLoadedFiles) => {
    setRepoLoadedFiles(prev => {
      if (prev[repoId] === files) return prev;
      return { ...prev, [repoId]: files };
    });
  }, []);

  const [repoDirectionFilters, setRepoDirectionFilters] = useState<Record<string, DirectionFilter>>({});

  const getRepoDirectionFilter = useCallback((repoId: string): DirectionFilter => {
    return repoDirectionFilters[repoId] ?? 'all';
  }, [repoDirectionFilters]);

  const toggleRepoDirectionFilter = useCallback((repoId: string, target: 'outgoing' | 'incoming') => {
    setRepoDirectionFilters(prev => {
      const curr = prev[repoId] ?? 'all';
      const outgoingActive = curr === 'all' || curr === 'outgoing';
      const incomingActive = curr === 'all' || curr === 'incoming';

      const nextOutgoing = target === 'outgoing' ? !outgoingActive : outgoingActive;
      const nextIncoming = target === 'incoming' ? !incomingActive : incomingActive;

      let next: DirectionFilter = 'all';
      if (nextOutgoing && nextIncoming) next = 'all';
      else if (nextOutgoing) next = 'outgoing';
      else if (nextIncoming) next = 'incoming';
      else next = 'none';

      return { ...prev, [repoId]: next };
    });
  }, []);

  const isRepoOutgoingActive = useCallback((repoId: string) => {
    const filter = repoDirectionFilters[repoId] ?? 'all';
    return filter === 'all' || filter === 'outgoing';
  }, [repoDirectionFilters]);

  const isRepoIncomingActive = useCallback((repoId: string) => {
    const filter = repoDirectionFilters[repoId] ?? 'all';
    return filter === 'all' || filter === 'incoming';
  }, [repoDirectionFilters]);

  const allSpeedSearchItems = useMemo<PushSpeedSearchItem[]>(() => {
    const items: PushSpeedSearchItem[] = [];

    for (const repo of repos) {
      const repoId = repo.repoId;
      const dirFilter: DirectionFilter = repoDirectionFilters[repoId] ?? 'all';
      if (dirFilter === 'none') continue;

      const isOutgoing = dirFilter === 'all' || dirFilter === 'outgoing';
      const isIncoming = dirFilter === 'all' || dirFilter === 'incoming';

      const unpushed = unpushedMap[repoId];
      const incoming = incomingMap?.[repoId];
      const filesInfo = repoLoadedFiles[repoId];
      const mode = filesInfo?.pushViewMode ?? 'commits';

      if (mode === 'changes') {
        // 聚合变更视图：只索引匹配方向的聚合文件
        if (filesInfo) {
          if (isOutgoing) {
            for (const f of filesInfo.aggregatedFiles) {
              items.push({
                kind: 'file',
                key: `push:agg:${repoId}:out:${f.path}`,
                repoId,
                path: f.path,
                file: f,
                isIncoming: false,
              });
            }
          }
          if (isIncoming) {
            for (const f of filesInfo.aggregatedIncomingFiles) {
              items.push({
                kind: 'file',
                key: `push:agg:${repoId}:in:${f.path}`,
                repoId,
                path: f.path,
                file: f,
                isIncoming: true,
              });
            }
          }
        }
      } else {
        // 提交列表视图：索引匹配方向的提交项及其实际已加载的文件
        // 1. Commits (Outgoing)
        if (isOutgoing && unpushed?.commits) {
          for (const c of unpushed.commits) {
            items.push({
              kind: 'commit',
              key: `push:commit:${repoId}:${c.hash}`,
              repoId,
              hash: c.hash,
              shortHash: c.shortHash,
              message: c.message,
              author: c.author,
              isIncoming: false,
            });
          }
        }

        // 2. Commits (Incoming)
        if (isIncoming && incoming?.commits) {
          for (const c of incoming.commits) {
            items.push({
              kind: 'commit',
              key: `push:incoming:${repoId}:${c.hash}`,
              repoId,
              hash: c.hash,
              shortHash: c.shortHash,
              message: c.message,
              author: c.author,
              isIncoming: true,
            });
          }
        }

        // 3. Commit files
        if (filesInfo) {
          if (isOutgoing) {
            for (const [hash, files] of Object.entries(filesInfo.filesByHash)) {
              for (const f of files) {
                items.push({
                  kind: 'file',
                  key: `push:file:${repoId}:out:${hash}:${f.path}`,
                  repoId,
                  commitHash: hash,
                  path: f.path,
                  file: f,
                  isIncoming: false,
                });
              }
            }
          }
          if (isIncoming) {
            for (const [hash, files] of Object.entries(filesInfo.incomingFilesByHash)) {
              for (const f of files) {
                items.push({
                  kind: 'file',
                  key: `push:file:${repoId}:in:${hash}:${f.path}`,
                  repoId,
                  commitHash: hash,
                  path: f.path,
                  file: f,
                  isIncoming: true,
                });
              }
            }
          }
        }
      }
    }

    return items;
  }, [repos, repoDirectionFilters, unpushedMap, incomingMap, repoLoadedFiles]);

  const listRef = useRef<HTMLDivElement | null>(null);

  const speedSearch = useSpeedSearch<PushSpeedSearchItem>({
    items: allSpeedSearchItems,
    getItemKey: item => item.key,
    getItemPath: item => item.kind === 'commit' ? `${item.shortHash} ${item.message}` : item.path,
    getItemName: item => item.kind === 'commit' ? item.message : fileNameOf(item.path),
    containerRef: listRef,
    enabled: isActive ?? true,
  });

  const [collapsedRepoIds, setCollapsedRepoIds] = useState<Set<string>>(() => new Set<string>());

  const lastAutoExpandedRepoIdRef = useRef<string | null>(null);

  // 当搜索匹配到折叠的仓库时，自动展开该仓库（仅当活跃命中仓库切换时自动展开一次，避免用户手动收起时循环强制展开）
  useEffect(() => {
    if (!speedSearch.query) {
      lastAutoExpandedRepoIdRef.current = null;
      return;
    }
    const matchedRepoId = speedSearch.activeItem?.repoId;
    if (!matchedRepoId) return;

    if (lastAutoExpandedRepoIdRef.current !== matchedRepoId) {
      lastAutoExpandedRepoIdRef.current = matchedRepoId;
      setCollapsedRepoIds(prev => {
        if (!prev.has(matchedRepoId)) return prev;
        const next = new Set(prev);
        next.delete(matchedRepoId);
        return next;
      });
    }
  }, [speedSearch.query, speedSearch.activeItem]);

  const getActiveCommitForRepo = useCallback((repoId: string): { hash: string; isIncoming: boolean } | null => {
    const item = speedSearch.activeItem;
    if (!item || item.repoId !== repoId) return null;
    const hash = item.kind === 'commit' ? item.hash : item.commitHash;
    if (!hash) return null;
    return { hash, isIncoming: item.isIncoming };
  }, [speedSearch.activeItem]);

  useEffect(() => {
    if (!expansionCommand || expansionCommand.sequence === 0) return;
    if (expansionCommand.expanded) {
      setCollapsedRepoIds(new Set());
    } else {
      setCollapsedRepoIds(new Set(repos.map(r => r.repoId)));
    }
  }, [expansionCommand, repos]);

  const toggleRepoExpanded = useCallback((repoId: string) => {
    setCollapsedRepoIds(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      const allCollapsed = next.size === repos.length;
      onExpansionChange?.(!allCollapsed);
      return next;
    });
  }, [repos.length, onExpansionChange]);

  const repoHasUpstream = useCallback((repo: RepoStatus) => !!repo.branch.upstream && !repo.branch.isGone, []);

  const canPushRepo = useCallback((repo: RepoStatus) => {
    const ahead = repo.branch.aheadBehind?.ahead ?? 0;
    const hasUpstream = repoHasUpstream(repo);
    return (hasUpstream && ahead > 0) || !hasUpstream;
  }, [repoHasUpstream]);

  const canPullRepo = useCallback((repo: RepoStatus) => {
    const behind = repo.branch.aheadBehind?.behind ?? 0;
    const incomingCount = incomingMap?.[repo.repoId]?.commits?.length ?? 0;
    return behind > 0 || incomingCount > 0;
  }, [incomingMap]);

  useEffect(() => {
    setChecked(prev => {
      const toRemove = repos.filter(repo => prev.has(repo.repoId) && !canPushRepo(repo) && !canPullRepo(repo));
      if (toRemove.length === 0) return prev;
      const next = new Set(prev);
      toRemove.forEach(repo => next.delete(repo.repoId));
      return next;
    });
  }, [canPullRepo, canPushRepo, repos]);

  const toggleRepo = (repoId: string) => {
    setChecked(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId);
      else next.add(repoId);
      return next;
    });
  };

  const eligibleRepos = useMemo(
    () => isSingleRepo ? [] : repos.filter(repo => canPushRepo(repo) || canPullRepo(repo)),
    [isSingleRepo, repos, canPushRepo, canPullRepo]
  );
  const lastSelectionSeqRef = useRef(0);

  useEffect(() => {
    if (!selectionCommand || selectionCommand.sequence === 0 || selectionCommand.sequence === lastSelectionSeqRef.current) return;
    lastSelectionSeqRef.current = selectionCommand.sequence;
    if (selectionCommand.action === 'selectAll') {
      setChecked(new Set(eligibleRepos.map(r => r.repoId)));
    } else if (selectionCommand.action === 'invert') {
      setChecked(prev => {
        const next = new Set<string>();
        for (const r of eligibleRepos) {
          if (!prev.has(r.repoId)) next.add(r.repoId);
        }
        return next;
      });
    }
  }, [selectionCommand, eligibleRepos]);

  useEffect(() => {
    const hasSelectable = eligibleRepos.length > 0;
    const isAllSelected = hasSelectable && eligibleRepos.every(r => checked.has(r.repoId));
    onSelectionChange?.(isAllSelected, hasSelectable);
  }, [checked, eligibleRepos, onSelectionChange]);

  const pushButtonLabel = (targets: RepoStatus[]) => {
    const hasPublish = targets.some(repo => !repoHasUpstream(repo));
    const hasPush = targets.some(repo => repoHasUpstream(repo));
    const publishCount = targets.filter(repo => !repoHasUpstream(repo)).length;
    let label = t('Push');
    if (hasPublish && hasPush) {
      label = publishCount === 1 ? t('Push & Publish Branch') : t('Push & Publish Branches');
    } else if (hasPublish) {
      label = targets.length === 1 ? t('Publish Branch') : t('Publish Branches');
    }
    return targets.length > 1 ? `${label} (${targets.length})` : label;
  };

  const formatSyncLabel = (behind: number, ahead: number) => {
    if (behind > 0 && ahead > 0) return `${t('Sync')} ↓${behind} ↑${ahead}`;
    if (behind > 0) return `${t('Sync')} ↓${behind}`;
    if (ahead > 0) return `${t('Sync')} ↑${ahead}`;
    return t('Sync');
  };

  if (isSingleRepo) {
    const solo = repos[0];
    const soloFilter = getRepoDirectionFilter(solo.repoId);
    const canPush = canPushRepo(solo);
    const canPull = canPullRepo(solo);
    const ahead = solo.branch.aheadBehind?.ahead ?? 0;
    const behind = solo.branch.aheadBehind?.behind ?? 0;
    const syncLabel = formatSyncLabel(behind, ahead);

    const soloPullItems: SplitDropdownButtonItem[] = [
      {
        icon: 'git-merge',
        label: t('Update Strategy: Rebase'),
        onSelect: () => onPull?.(solo.repoId, 'rebase'),
      },
      {
        icon: 'git-merge',
        label: t('Update Strategy: Merge'),
        onSelect: () => onPull?.(solo.repoId, 'merge'),
      },
      {
        icon: 'arrow-right',
        label: t('Update Strategy: Fast-Forward Only'),
        onSelect: () => onPull?.(solo.repoId, 'ff-only'),
      },
    ];

    const soloPushItems: SplitDropdownButtonItem[] = [
      {
        icon: 'warning',
        label: t('Safe Force Push...'),
        danger: true,
        onSelect: () => onForcePush?.(solo.repoId),
      },
      {
        icon: 'tag',
        label: t('Push All Tags'),
        onSelect: () => onPushTags?.(solo.repoId),
      },
    ];

    const renderSoloButtons = () => {
      if (soloFilter === 'incoming') {
        return (
          <SplitDropdownButton
            fullWidth
            colorVariant="pull"
            enabled={canPull}
            icon="cloud-download"
            label={t('Update')}
            items={soloPullItems}
            dropdownAlign="right"
            onMainClick={() => onPull?.(solo.repoId)}
          />
        );
      }
      if (soloFilter === 'outgoing') {
        const isPurePush = repoHasUpstream(solo);
        return (
          <SplitDropdownButton
            fullWidth
            colorVariant={isPurePush ? 'push' : 'default'}
            enabled={canPush}
            chevronEnabled={isPurePush}
            icon="cloud-upload"
            label={pushButtonLabel([solo])}
            items={isPurePush ? soloPushItems : []}
            dropdownAlign="right"
            onMainClick={() => onPush(solo.repoId)}
          />
        );
      }
      if (soloFilter === 'none') {
        return (
          <SplitDropdownButton
            fullWidth
            enabled={false}
            chevronEnabled={false}
            icon="sync"
            label={t('Sync')}
            items={[]}
            dropdownAlign="right"
            onMainClick={() => {}}
          />
        );
      }
      // soloFilter === 'all' (根据当前的单向/双向差异显示精确操作)
      if (!repoHasUpstream(solo)) {
        return (
          <SplitDropdownButton
            fullWidth
            enabled={canPush}
            icon="cloud-upload"
            label={pushButtonLabel([solo])}
            items={[]}
            dropdownAlign="right"
            onMainClick={() => onPush(solo.repoId)}
          />
        );
      }
      if (canPull && !canPush) {
        return (
          <SplitDropdownButton
            fullWidth
            colorVariant="pull"
            enabled
            icon="cloud-download"
            label={t('Update')}
            items={soloPullItems}
            dropdownAlign="right"
            onMainClick={() => onPull?.(solo.repoId)}
          />
        );
      }
      if (canPush && !canPull) {
        return (
          <SplitDropdownButton
            fullWidth
            colorVariant="push"
            enabled
            icon="cloud-upload"
            label={pushButtonLabel([solo])}
            items={soloPushItems}
            dropdownAlign="right"
            onMainClick={() => onPush(solo.repoId)}
          />
        );
      }
      if (canPull && canPush) {
        return (
          <SplitDropdownButton
            fullWidth
            enabled
            icon="sync"
            label={syncLabel}
            items={[]}
            onMainClick={() => onSync?.(solo.repoId)}
          />
        );
      }
      return (
        <SplitDropdownButton
          fullWidth
          enabled={Boolean(onFetch)}
          icon="cloud-download"
          label={t('Fetch')}
          items={[]}
          onMainClick={() => onFetch?.(solo.repoId)}
        />
      );
    };

    return (
      <div className="versiondock-push-root" style={css.root}>
        <div className="versiondock-push-card" style={css.listCard}>
          {speedSearch.isOpen && (
            <SpeedSearchWidget
              speedSearch={speedSearch}
              placeholder={t('Search files or commits...')}
            />
          )}
          <div ref={listRef} className="versiondock-commit-scroll-container" style={css.list}>
            <RepoSection
              key={solo.repoId}
              isFirst={true}
              repoStatus={solo}
              repoMeta={metaMap.get(solo.repoId)}
              unpushed={unpushedMap[solo.repoId]}
              incoming={incomingMap?.[solo.repoId]}
              checked={false}
              canCheck={false}
              onToggle={() => {}}
              onOpenInLog={onOpenInLog}
              onUndoCommit={onUndoCommit}
              onRequestCommitFiles={onRequestCommitFiles}
              onRequestAggregatedDiff={onRequestAggregatedDiff}
              onOpenAggregatedFile={onOpenAggregatedFile}
              onOpenCommitFile={onOpenCommitFile}
              onRequestIncomingCommitFiles={onRequestIncomingCommitFiles}
              onRequestIncomingAggregatedDiff={onRequestIncomingAggregatedDiff}
              onOpenIncomingAggregatedFile={onOpenIncomingAggregatedFile}
              onOpenIncomingCommitFile={onOpenIncomingCommitFile}
              onFetch={onFetch}
              onSquash={onSquash}
              onDropCommits={onDropCommits}
              onRevertCommits={onRevertCommits}
              onEditCommitMsg={onEditCommitMsg}
              onCherryPick={onCherryPick}
              onCreateBranchFromCommit={onCreateBranchFromCommit}
              onBranchClick={onBranchClick}
              iconTheme={iconTheme}
              singleRepo
              directionFilter={soloFilter}
              onToggleDirectionFilter={target => toggleRepoDirectionFilter(solo.repoId, target)}
              isExpanded={!collapsedRepoIds.has(solo.repoId)}
              onToggleExpanded={() => toggleRepoExpanded(solo.repoId)}
              expansionCommand={expansionCommand}
              externalFileViewMode={viewMode}
              speedSearchQuery={speedSearch.query}
              activeSpeedSearchKey={speedSearch.activeKey}
              activeCommit={getActiveCommitForRepo(solo.repoId)}
              onFilesLoaded={handleFilesLoaded}
            />
          </div>
        </div>
        <div className="versiondock-push-footer" style={css.footer}>
          {renderSoloButtons()}
        </div>
      </div>
    );
  }

  const checkedRepos = repos.filter(repo => checked.has(repo.repoId));
  const pushableChecked = checkedRepos.filter(repo => canPushRepo(repo) && isRepoOutgoingActive(repo.repoId));
  const pullableChecked = checkedRepos.filter(repo => canPullRepo(repo) && isRepoIncomingActive(repo.repoId));

  const totalBehind = pullableChecked.reduce((acc, r) => acc + (r.branch.aheadBehind?.behind ?? 0), 0);
  const totalAhead = pushableChecked.reduce((acc, r) => acc + (r.branch.aheadBehind?.ahead ?? 0), 0);

  const handlePush = () => {
    if (pushableChecked.length === 0) return;
    if (pushableChecked.length === 1) {
      onPush(pushableChecked[0].repoId);
    } else if (onPushMulti) {
      onPushMulti(pushableChecked.map(repo => repo.repoId));
    } else {
      pushableChecked.forEach(repo => onPush(repo.repoId));
    }
  };

  const handlePull = () => {
    if (pullableChecked.length === 0) return;
    if (pullableChecked.length === 1) {
      onPull?.(pullableChecked[0].repoId);
    } else if (onPullMulti) {
      onPullMulti(pullableChecked.map(r => r.repoId));
    } else {
      pullableChecked.forEach(repo => onPull?.(repo.repoId));
    }
  };

  const handleSync = (strategy?: SyncPullStrategy) => {
    const pullOnlyTargets: string[] = [];
    const pushOnlyTargets: string[] = [];
    const syncTargets: string[] = [];

    for (const repo of checkedRepos) {
      const canPull = canPullRepo(repo) && isRepoIncomingActive(repo.repoId);
      const canPush = canPushRepo(repo) && isRepoOutgoingActive(repo.repoId);
      if (canPull && canPush && repoHasUpstream(repo)) {
        syncTargets.push(repo.repoId);
      } else if (canPull) {
        pullOnlyTargets.push(repo.repoId);
      } else if (canPush) {
        pushOnlyTargets.push(repo.repoId);
      }
    }

    // 每个仓库只执行它当前需要的操作，避免单向差异被扩大为先拉取再推送。
    if (pushOnlyTargets.length === 1) {
      onPush(pushOnlyTargets[0]);
    } else if (pushOnlyTargets.length > 1) {
      if (onPushMulti) {
        onPushMulti(pushOnlyTargets);
      } else {
        pushOnlyTargets.forEach(id => onPush(id));
      }
    }

    if (pullOnlyTargets.length === 1) {
      onPull?.(pullOnlyTargets[0], strategy);
    } else if (pullOnlyTargets.length > 1) {
      if (onPullMulti) {
        onPullMulti(pullOnlyTargets, strategy);
      } else {
        pullOnlyTargets.forEach(id => onPull?.(id, strategy));
      }
    }

    if (syncTargets.length === 1) {
      onSync?.(syncTargets[0], strategy);
    } else if (syncTargets.length > 1) {
      if (onSyncMulti) {
        onSyncMulti(syncTargets, strategy);
      } else {
        syncTargets.forEach(id => onSync?.(id, strategy));
      }
    }
  };

  const multiPullItems: SplitDropdownButtonItem[] = [
    {
      icon: 'git-merge',
      label: t('Update Strategy: Rebase'),
      onSelect: () => {
        if (pullableChecked.length === 0) return;
        if (pullableChecked.length === 1) onPull?.(pullableChecked[0].repoId, 'rebase');
        else if (onPullMulti) onPullMulti(pullableChecked.map(r => r.repoId), 'rebase');
        else pullableChecked.forEach(r => onPull?.(r.repoId, 'rebase'));
      },
    },
    {
      icon: 'git-merge',
      label: t('Update Strategy: Merge'),
      onSelect: () => {
        if (pullableChecked.length === 0) return;
        if (pullableChecked.length === 1) onPull?.(pullableChecked[0].repoId, 'merge');
        else if (onPullMulti) onPullMulti(pullableChecked.map(r => r.repoId), 'merge');
        else pullableChecked.forEach(r => onPull?.(r.repoId, 'merge'));
      },
    },
    {
      icon: 'arrow-right',
      label: t('Update Strategy: Fast-Forward Only'),
      onSelect: () => {
        if (pullableChecked.length === 0) return;
        if (pullableChecked.length === 1) onPull?.(pullableChecked[0].repoId, 'ff-only');
        else if (onPullMulti) onPullMulti(pullableChecked.map(r => r.repoId), 'ff-only');
        else pullableChecked.forEach(r => onPull?.(r.repoId, 'ff-only'));
      },
    },
  ];

  const multiPushItems: SplitDropdownButtonItem[] = [
    {
      icon: 'warning',
      label: t('Safe Force Push...'),
      danger: true,
      onSelect: () => {
        if (pushableChecked.length === 0) return;
        if (pushableChecked.length === 1) {
          onForcePush?.(pushableChecked[0].repoId);
        } else if (onForcePushMulti) {
          onForcePushMulti(pushableChecked.map(r => r.repoId));
        } else {
          pushableChecked.forEach(r => onForcePush?.(r.repoId));
        }
      },
    },
    {
      icon: 'tag',
      label: t('Push All Tags'),
      onSelect: () => {
        if (checkedRepos.length === 0) return;
        if (checkedRepos.length === 1) {
          onPushTags?.(checkedRepos[0].repoId);
        } else if (onPushTagsMulti) {
          onPushTagsMulti(checkedRepos.map(r => r.repoId));
        } else {
          checkedRepos.forEach(r => onPushTags?.(r.repoId));
        }
      },
    },
  ];

  const renderMultiButtons = () => {
    const hasChecked = checkedRepos.length > 0;
    const hasPullTargets = pullableChecked.length > 0;
    const hasPushTargets = pushableChecked.length > 0;

    const unpublishedChecked = checkedRepos.filter(repo => !repoHasUpstream(repo) && isRepoOutgoingActive(repo.repoId));
    const publishedChecked = checkedRepos.filter(repo => repoHasUpstream(repo));

    if (hasChecked && hasPushTargets && !hasPullTargets) {
      const isPurePush = pushableChecked.every(repo => repoHasUpstream(repo));
      return (
        <SplitDropdownButton
          fullWidth
          colorVariant={isPurePush ? 'push' : 'default'}
          enabled
          chevronEnabled={isPurePush}
          icon="cloud-upload"
          label={pushButtonLabel(pushableChecked)}
          items={isPurePush ? multiPushItems : []}
          dropdownAlign="right"
          onMainClick={handlePush}
        />
      );
    }
    if (hasChecked && hasPullTargets && !hasPushTargets) {
      return (
        <SplitDropdownButton
          fullWidth
          colorVariant="pull"
          enabled
          icon="cloud-download"
          label={pullableChecked.length > 1 ? `${t('Update')} (${pullableChecked.length})` : t('Update')}
          items={multiPullItems}
          dropdownAlign="right"
          onMainClick={handlePull}
        />
      );
    }

    let syncLabel: string;
    if (hasChecked && unpublishedChecked.length > 0 && publishedChecked.length > 0) {
      const base = unpublishedChecked.length === 1 ? t('Sync & Publish Branch') : t('Sync & Publish Branches');
      if (totalBehind > 0 && totalAhead > 0) {
        syncLabel = `${base} ↓${totalBehind} ↑${totalAhead}`;
      } else if (totalBehind > 0) {
        syncLabel = `${base} ↓${totalBehind}`;
      } else if (totalAhead > 0) {
        syncLabel = `${base} ↑${totalAhead}`;
      } else {
        syncLabel = base;
      }
    } else {
      syncLabel = hasChecked ? formatSyncLabel(totalBehind, totalAhead) : t('Sync');
    }

    if (hasChecked && hasPullTargets && hasPushTargets) {
      return (
        <SplitDropdownButton
          fullWidth
          enabled
          icon="sync"
          label={syncLabel}
          items={[]}
          onMainClick={() => handleSync()}
        />
      );
    }

    return (
      <SplitDropdownButton
        fullWidth
        enabled={Boolean(onFetchAll || onFetch)}
        icon="cloud-download"
        label={t('Fetch All')}
        items={[]}
        onMainClick={() => onFetchAll ? onFetchAll() : checkedRepos.forEach(r => onFetch?.(r.repoId))}
      />
    );
  };

  return (
    <div className="versiondock-push-root" style={css.root}>
      <div className="versiondock-push-card" style={css.listCard}>
        {speedSearch.isOpen && (
          <SpeedSearchWidget
            speedSearch={speedSearch}
            placeholder={t('Search files or commits...')}
          />
        )}
        <div ref={listRef} className="versiondock-commit-scroll-container" style={css.list}>
          {repos.map((repoStatus, idx) => (
            <RepoSection
              key={repoStatus.repoId}
              isFirst={idx === 0}
              repoStatus={repoStatus}
              repoMeta={metaMap.get(repoStatus.repoId)}
              unpushed={unpushedMap[repoStatus.repoId]}
              incoming={incomingMap?.[repoStatus.repoId]}
              checked={checked.has(repoStatus.repoId)}
              canCheck={canPushRepo(repoStatus) || canPullRepo(repoStatus)}
              onToggle={toggleRepo}
              onOpenInLog={onOpenInLog}
              onUndoCommit={onUndoCommit}
              onRequestCommitFiles={onRequestCommitFiles}
              onRequestAggregatedDiff={onRequestAggregatedDiff}
              onOpenAggregatedFile={onOpenAggregatedFile}
              onOpenCommitFile={onOpenCommitFile}
              onRequestIncomingCommitFiles={onRequestIncomingCommitFiles}
              onRequestIncomingAggregatedDiff={onRequestIncomingAggregatedDiff}
              onOpenIncomingAggregatedFile={onOpenIncomingAggregatedFile}
              onOpenIncomingCommitFile={onOpenIncomingCommitFile}
              onFetch={onFetch}
              onSquash={onSquash}
              onDropCommits={onDropCommits}
              onRevertCommits={onRevertCommits}
              onEditCommitMsg={onEditCommitMsg}
              onCherryPick={onCherryPick}
              onCreateBranchFromCommit={onCreateBranchFromCommit}
              onBranchClick={onBranchClick}
              iconTheme={iconTheme}
              directionFilter={getRepoDirectionFilter(repoStatus.repoId)}
              onToggleDirectionFilter={target => toggleRepoDirectionFilter(repoStatus.repoId, target)}
              isExpanded={!collapsedRepoIds.has(repoStatus.repoId)}
              onToggleExpanded={() => toggleRepoExpanded(repoStatus.repoId)}
              expansionCommand={expansionCommand}
              externalFileViewMode={viewMode}
              speedSearchQuery={speedSearch.query}
              activeSpeedSearchKey={speedSearch.activeKey}
              activeCommit={getActiveCommitForRepo(repoStatus.repoId)}
              onFilesLoaded={handleFilesLoaded}
            />
          ))}
        </div>
      </div>

      <div className="versiondock-push-footer" style={css.footer}>
        {checkedRepos.length > 0 && (
          <div style={css.pills}>
            {checkedRepos.map(repo => {
              const meta = metaMap.get(repo.repoId);
              const color = readableAccentColor(meta?.color ?? '#4ec9b0');
              const rawName = meta?.name ?? baseNameFromPath(repo.repoId) ?? repo.repoId;
              const wtBranch = meta?.isWorktree
                ? (repo.branch.detachedTag ?? repo.branch.detachedHash ?? repo.branch.name)
                : undefined;
              const displayName = wtBranch
                ? `${baseNameFromPath(meta?.mainWorktreePath) ?? rawName} (${wtBranch})`
                : rawName;
              const ahead = repo.branch.aheadBehind?.ahead ?? 0;
              const behind = repo.branch.aheadBehind?.behind ?? 0;
              return (
                <span key={repo.repoId} style={css.pill(color)}>
                  <button data-action-btn="" style={css.pillRemove(color)} title={t('Remove {0}', displayName)} onClick={() => toggleRepo(repo.repoId)}>
                    <Codicon name="close" style={{ fontSize: '10px' }} />
                  </button>
                  {displayName}
                  {isRepoOutgoingActive(repo.repoId) && ahead > 0 && (
                    <span style={css.pillCount}>
                      <Codicon name="arrow-up" style={{ fontSize: '8px', marginRight: '1px' }} />
                      {ahead}
                    </span>
                  )}
                  {isRepoIncomingActive(repo.repoId) && behind > 0 && (
                    <span style={{ ...css.pillCount, color: PULL_COLOR }}>
                      <Codicon name="arrow-down" style={{ fontSize: '8px', marginRight: '1px' }} />
                      {behind}
                    </span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {renderMultiButtons()}
      </div>
    </div>
  );
}

export const SyncTab = PushTab;

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
  root: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    height: '100%',
    minHeight: 0,
    position: 'relative' as const,
  },
  listCard: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    position: 'relative' as const,
    background: 'var(--vscode-sideBar-background)',
    boxSizing: 'border-box' as const,
  },
  list: { flex: 1, overflowY: 'auto' as const, minHeight: 0 },
  footer: {
    position: 'relative' as const,
    zIndex: 10,
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
    padding: '6px 8px',
    background: 'var(--vscode-sideBar-background)',
    boxSizing: 'border-box' as const,
  },
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
};

const styles = {
  repoRoot: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  repoHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: '0 8px',
    boxSizing: 'border-box' as const,
  },
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
    fontSize: '11px', fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const, letterSpacing: '0.05em', minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, flexShrink: 1,
  },
  branchBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'none' as const,
    letterSpacing: 0,
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    borderRadius: '3px',
    padding: '1px 5px',
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '160px',
    marginLeft: '4px',
    cursor: 'pointer',
    userSelect: 'none' as const,
    overflow: 'hidden',
  }),
  branchName: {
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0,
  } as React.CSSProperties,
  directionBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center',
    color,
    border: `1px solid color-mix(in srgb, ${color} 38%, transparent)`,
    background: `color-mix(in srgb, ${color} 12%, transparent)`,
    borderRadius: '8px', padding: '1px 6px', fontSize: '10px', fontWeight: 'bold' as const,
    lineHeight: '14px',
    flexShrink: 0,
  }),
  publishBadge: {
    display: 'inline-flex', alignItems: 'center',
    background: 'var(--versiondock-badge-background)', color: 'var(--versiondock-badge-foreground)',
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
  repoModeButton: (disabled: boolean, active = false): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 20, height: 20, padding: 0, border: 'none', borderRadius: '3px',
    background: active ? 'var(--vscode-toolbar-activeBackground, rgba(128, 128, 128, 0.24))' : 'transparent',
    color: active ? 'var(--vscode-foreground)' : 'var(--vscode-icon-foreground)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.35 : undefined,
    pointerEvents: disabled ? 'none' : 'auto',
    transition: 'opacity 0.1s, background-color 0.1s',
    flexShrink: 0,
  }),
  repoBody: { background: 'var(--vscode-sideBar-background)' } as React.CSSProperties,
  aggSectionHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 12px 4px',
    fontSize: '11px',
    fontWeight: 600,
    color: 'var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground))',
    opacity: 0.85,
    borderTop: '1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.15))',
    background: 'var(--vscode-sideBarSectionHeader-background, transparent)',
  } as React.CSSProperties,
  upToDate: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '8px 12px', fontSize: '12px', color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  behindRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '12px 8px', fontSize: '12px',
    color: 'var(--vscode-inputValidation-warningForeground, #cca700)',
  } as React.CSSProperties,
  unpublishedRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '12px 8px', fontSize: '12px', color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  loadingRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: '8px 12px', fontSize: '12px', color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center' as const,
  } as React.CSSProperties,
  errorRow: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '6px 10px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)',
    textAlign: 'center' as const,
  } as React.CSSProperties,
  commitList: { display: 'flex', flexDirection: 'column' as const } as React.CSSProperties,
  commitCard: (_expanded: boolean, selected: boolean): React.CSSProperties => ({
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: selected ? 'var(--vscode-list-inactiveSelectionBackground)' : 'transparent',
  }),
  commitRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '7px 12px',
    cursor: 'pointer',
    boxSizing: 'border-box',
    userSelect: 'none' as const,
    minWidth: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  commitLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    flexShrink: 0,
    alignSelf: 'flex-start',
    marginTop: '1px',
    minWidth: '60px',
  } as React.CSSProperties,
  commitHash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    display: 'flex', alignItems: 'center', minWidth: '44px',
    lineHeight: '14px',
  } as React.CSSProperties,
  commitDirectionIcon: (isIncoming: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: isIncoming ? PULL_COLOR : PUSH_COLOR,
    flexShrink: 0,
    lineHeight: 1,
  }),
  commitInfo: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minWidth: 0,
    gap: '2px',
  } as React.CSSProperties,
  commitMessage: {
    fontSize: '12px', fontWeight: 500,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
    minWidth: 0,
    lineHeight: '16px',
    display: 'block',
  } as React.CSSProperties,
  commitMeta: {
    fontSize: '10px', color: 'var(--vscode-descriptionForeground)',
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
    display: 'flex', alignItems: 'center', minWidth: 0,
    lineHeight: '14px',
  } as React.CSSProperties,
  commitMetaText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
    flexShrink: 1,
  } as React.CSSProperties,
  commitStats: {
    display: 'inline-flex',
    alignItems: 'center',
    flexShrink: 0,
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  statAdd: { color: 'var(--vscode-gitDecoration-addedResourceForeground)' } as React.CSSProperties,
  statDel: { color: 'var(--vscode-gitDecoration-deletedResourceForeground)' } as React.CSSProperties,
  commitActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 0,
    marginLeft: 'auto',
  } as React.CSSProperties,
  actionBtn: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'transparent', border: 'none',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer', padding: '2px 4px', borderRadius: '3px',
  } as React.CSSProperties,
  commitDetails: {
    borderTop: '1px solid var(--vscode-panel-border)',
    paddingBottom: '6px',
  } as React.CSSProperties,
  fileListRoot: {
    background: 'var(--vscode-sideBar-background)',
  } as React.CSSProperties,
  treeRoot: {
    padding: '2px 0',
  } as React.CSSProperties,
  dirRow: (depth: number, hovered = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minHeight: 24,
    padding: `0 8px 0 ${TREE_BASE_PAD + depth * TREE_LEVEL_PAD}px`,
    cursor: 'pointer',
    boxSizing: 'border-box',
    minWidth: 0,
    overflow: 'hidden',
    background: hovered ? 'var(--vscode-list-hoverBackground)' : undefined,
  }),
  folderChevron: {
    fontSize: '12px',
    flexShrink: 0,
  } as React.CSSProperties,
  folderName: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
  },
  fileCountBadge: {
    marginLeft: 'auto',
    fontSize: '10px',
    padding: '0 6px',
    borderRadius: '999px',
    background: 'var(--versiondock-badge-background)',
    color: 'var(--versiondock-badge-foreground)',
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
  noMergeConflicts: {
    padding: '8px 10px 7px',
    fontSize: '12px',
    fontWeight: 400,
    textAlign: 'center' as const,
    color: 'var(--vscode-descriptionForeground)',
    opacity: 0.72,
  } as React.CSSProperties,
};
