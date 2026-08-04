import React, { useState, useMemo, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import type { CommitNode, LineRange, RepoMeta, MergeParentCommit } from '../../shared/types';
import { getVsCodeApi } from '../../shared/vscodeApi';
import type { HostToLogMsg, LogCommitPathEntry, LogToHostMsg, IconThemeData } from '../../../host/types/messages';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { groupRefs, branchColor, tagColor, headColor, splitRemoteRefName } from '../utils/refs';
import { formatDateTime } from '../../shared/dateUtils';
import type { RefGroup } from '../utils/refs';
import { isPrimaryBranch } from '../../shared/branchUtils';
import { AuthorAvatar } from './AuthorAvatar';
import { t } from '../../shared/i18n';
import type { LogViewFileEntry } from '../store/logStore';
import { scopedKey } from '../../shared/scopedKey';
import { isSameHistoryFilePath } from '../utils/historyPath';
import { readableAccentColor } from '../../shared/branchColors';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function previousSvnRevision(hash: string): string | undefined {
  const revision = Number.parseInt(hash.replace(/^r/i, ''), 10);
  return Number.isFinite(revision) ? `r${Math.max(0, revision - 1)}` : undefined;
}

function splitCommitMessage(fullMessage: string | null, fallbackSubject: string): { subject: string; body: string } {
  if (!fullMessage) return { subject: fallbackSubject, body: '' };
  const lines = fullMessage.replace(/\r\n/g, '\n').split('\n');
  const subject = lines[0]?.trim() || fallbackSubject;
  let bodyStart = 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart += 1;
  return { subject, body: lines.slice(bodyStart).join('\n').trimEnd() };
}

const IS_MAC = navigator.userAgent.includes('Mac');
const IS_WIN = navigator.userAgent.includes('Windows');
const REVEAL_OS_LABEL = IS_MAC ? t('Reveal in Finder') : IS_WIN ? t('Show in Explorer') : t('Show in File Manager');
const DETAIL_SPLITTER_SIZE = 4;
const INTERACTION_STYLE = `
.versiondock-detail-row[data-selected="false"]:hover {
  background: var(--vscode-list-hoverBackground) !important;
}
.versiondock-detail-row[data-selected="true"]:hover {
  filter: brightness(1.08);
}
.versiondock-detail-icon-row:hover {
  background: var(--vscode-toolbar-hoverBackground) !important;
}
[data-context-menu-item]:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)) !important;
}
`;

function clampInfoSectionHeight(height: number, containerHeight: number): number {
  const minPaneHeight = Math.min(160, Math.max(96, Math.floor((containerHeight - DETAIL_SPLITTER_SIZE) / 4)));
  const maxInfoHeight = Math.max(minPaneHeight, containerHeight - DETAIL_SPLITTER_SIZE - minPaneHeight);
  return Math.min(maxInfoHeight, Math.max(minPaneHeight, height));
}

interface Props {
  commit: CommitNode | null;
  commits: CommitNode[];
  files: LogViewFileEntry[];
  groupedEntries: Record<string, LogViewFileEntry[]>;
  selectedFile: { repoId: string; path: string; status: string; commitHash?: string } | null;
  loadingFiles: boolean;
  repoColor?: string;
  repos: RepoMeta[];
  remoteNamesByRepo: Readonly<Record<string, readonly string[]>>;
  iconTheme?: IconThemeData | null;
  isMultiCommitSelection: boolean;
  activeHistoryPath?: string;
  activeLineRange?: LineRange;
  onSelectFile: (file: { repoId: string; path: string; status: string; commitHash?: string } | null) => void;
  onClose?: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
  A: 'var(--vscode-gitDecoration-addedResourceForeground)',
  D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  C: 'var(--vscode-gitDecoration-addedResourceForeground)',
};

function normalizeStatus(status: string): string {
  return status.replace(/\d+$/, '');
}

interface TreeNode {
  name: string;
  fullPath: string;
  children: Map<string, TreeNode>;
  file: LogViewFileEntry | null;
  fileCount: number;
  descendantFiles: LogViewFileEntry[];
  isRepoRoot?: boolean;
  repoId?: string;
  repoColor?: string;
  repoName?: string;
  repoRootPath?: string;
}

interface ContextMenuState {
  x: number;
  y: number;
  files: LogViewFileEntry[];
  file?: LogViewFileEntry;
}

type ContainingBranches = { local: string[]; remote: string[]; tags: string[] };

function makeNode(name: string, fullPath: string, isRepoRoot = false, repoId?: string, repoColor?: string): TreeNode {
  return { name, fullPath, children: new Map(), file: null, fileCount: 0, descendantFiles: [], isRepoRoot, repoId, repoColor };
}

function computeNodeStats(node: TreeNode): { count: number; files: LogViewFileEntry[] } {
  if (node.file) {
    node.fileCount = 1;
    node.descendantFiles = [node.file];
    return { count: 1, files: [node.file] };
  }
  let count = 0;
  const files: LogViewFileEntry[] = [];
  for (const child of node.children.values()) {
    const childStats = computeNodeStats(child);
    count += childStats.count;
    files.push(...childStats.files);
  }
  node.fileCount = count;
  node.descendantFiles = files;
  return { count, files };
}

function collapseSingleChildDirs(node: TreeNode): TreeNode {
  if (node.file) return node;
  const nextChildren = new Map<string, TreeNode>();
  for (const [key, child] of node.children.entries()) {
    nextChildren.set(key, collapseSingleChildDirs(child));
  }
  const collapsedNode = { ...node, children: nextChildren };
  if (collapsedNode.isRepoRoot) return collapsedNode;
  if (collapsedNode.children.size === 1) {
    const child = Array.from(collapsedNode.children.values())[0];
    if (!child.file && !child.isRepoRoot) {
      return {
        ...child,
        name: collapsedNode.name ? `${collapsedNode.name}/${child.name}` : child.name,
      };
    }
  }
  return collapsedNode;
}

function buildTree(files: LogViewFileEntry[], repoNameById: Record<string, string>, repoRootPathById: Record<string, string>, repoColorById: Record<string, string>, groupByRepo: boolean): TreeNode {
  const root = makeNode('', '');

  for (const file of files) {
    const repoName = repoNameById[file.repoId] ?? file.repoId;
    const parts = groupByRepo ? [repoName, ...file.path.split('/')] : file.path.split('/');
    let node = root;
    let accumulated = '';
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      const isRepoRoot = groupByRepo && index === 0;
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      const key = isRepoRoot ? scopedKey(file.repoId, part) : accumulated;
      if (!node.children.has(key)) {
        node.children.set(key, makeNode(part, key, isRepoRoot, isRepoRoot ? file.repoId : undefined, isRepoRoot ? repoColorById[file.repoId] : undefined));
      }
      node = node.children.get(key)!;
      if (index === parts.length - 1) {
        node.file = file;
        node.repoName = repoName;
        node.repoRootPath = repoRootPathById[file.repoId];
      }
    }
  }

  computeNodeStats(root);
  return root;
}

function remoteLabel(group: RefGroup): string {
  const remoteName = group.remoteName || t('remote');
  return `${remoteName}/${group.label}`;
}

function formatRefLabel(group: RefGroup): string {
  if (group.isSvnRevision) return group.label;
  if (group.isRemoteHead) return `${group.remoteName || t('remote')}/HEAD`;
  if (group.isRemote) return remoteLabel(group);
  return group.label;
}

function badgeTitle(group: RefGroup): string {
  if (group.isSvnRevision) {
    return group.label === 'HEAD' ? t('SVN repository HEAD revision') : t('SVN working copy BASE revision');
  }
  if (group.isRemoteHead) return t('Remote HEAD ({0})', `${group.remoteName || t('remote')}/HEAD`);
  if (group.isDetached && group.isHead) return t('HEAD (detached)');
  if (group.isTag) return group.isDetached ? t('Tag: {0} (HEAD)', group.label) : t('Tag: {0}', group.label);
  if (group.isRemote) return t('Remote: {0}', remoteLabel(group));
  return t('Local: {0}', group.label);
}

function headBadgeTitle(group: RefGroup): string {
  return t('HEAD -> {0}', group.label);
}

function RefBadgeIcon({ group }: { group: RefGroup }) {
  const style: React.CSSProperties = { fontSize: '11px', flexShrink: 0, lineHeight: 1 };
  if (group.isSvnRevision) return <Codicon name="versions" style={style} />;
  if (group.isRemoteHead) return <Codicon name="milestone" style={style} />;
  if (group.isDetached && group.isHead) return <Codicon name="warning" style={style} />;
  if (group.isTag) return <Codicon name="tag" style={style} />;
  if (group.isRemote) return <Codicon name="cloud" style={style} />;
  return <Codicon name="git-branch" style={style} />;
}

function ContextMenu({ state, onShowDiff, onEditSource, onRevert, onCherryPick, onRevealExplorer, onRevealOS, onClose }: {
  state: ContextMenuState;
  onShowDiff?: () => void;
  onEditSource?: () => void;
  onRevert?: () => void;
  onCherryPick?: () => void;
  onRevealExplorer?: () => void;
  onRevealOS?: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { offsetWidth, offsetHeight } = el;
    const margin = 6;
    setPosition({
      x: Math.max(margin, Math.min(state.x, window.innerWidth - offsetWidth - margin)),
      y: Math.max(margin, Math.min(state.y, window.innerHeight - offsetHeight - margin)),
    });
  }, [state.x, state.y]);

  useEffect(() => {
    const closeIfOutside = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', closeIfOutside, true);
    document.addEventListener('keydown', keyHandler);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', closeIfOutside, true);
      document.removeEventListener('keydown', keyHandler);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  const items = [
    onShowDiff ? { label: t('Show Diff'), icon: 'diff', action: onShowDiff } : null,
    onEditSource ? { label: t('Open file'), icon: 'go-to-file', action: onEditSource } : null,
    onRevealExplorer ? { label: t('Reveal in Explorer'), icon: 'list-tree', action: onRevealExplorer } : null,
    onRevealOS ? { label: REVEAL_OS_LABEL, icon: 'folder-opened', action: onRevealOS } : null,
    onRevert ? { label: t('Revert Selected Changes'), icon: 'discard', action: onRevert } : null,
    onCherryPick ? { label: t('Cherry-Pick Selected Changes'), icon: 'git-commit', action: onCherryPick } : null,
  ].filter(Boolean) as Array<{ label: string; icon: string; action: () => void }>;

  if (items.length === 0) return null;

  return (
    <div ref={menuRef} style={menuStyles.container(position?.x ?? state.x, position?.y ?? state.y)} onContextMenu={e => e.preventDefault()}>
      {items.map(item => (
        <div data-context-menu-item="" key={item.label} style={menuStyles.item} onClick={() => { item.action(); onClose(); }}>
          <Codicon name={item.icon} style={menuStyles.icon} />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function TreeDir({ node, depth, selectedFile, onOpen, onFileContextMenu, onDirectoryContextMenu, allExpanded, iconTheme }: {
  node: TreeNode;
  depth: number;
  selectedFile: { repoId: string; path: string; status: string; commitHash?: string } | null;
  onOpen: (file: LogViewFileEntry) => void;
  onFileContextMenu: (event: React.MouseEvent, file: LogViewFileEntry) => void;
  onDirectoryContextMenu: (event: React.MouseEvent, node: TreeNode) => void;
  allExpanded: boolean | null;
  iconTheme?: IconThemeData | null;
}) {
  const [localOpen, setLocalOpen] = useState(true);
  const open = allExpanded !== null ? allExpanded : localOpen;
  const indent = depth * 14;

  if (node.file) {
    const file = node.file;
    const isRepoRootChange = file.path === '.';
    const isSelected = selectedFile?.repoId === file.repoId && selectedFile?.path === file.path;
    const status = normalizeStatus(file.status);
    const statusColor = STATUS_COLORS[status] ?? 'var(--vscode-foreground)';
    const displayName = isRepoRootChange ? node.repoName ?? file.repoId : node.name;
    return (
      <div
        style={styles.fileRow(isSelected)}
        className="versiondock-detail-row"
        data-selected={isSelected}
        onClick={isRepoRootChange ? undefined : () => onOpen(file)}
        onContextMenu={isRepoRootChange ? undefined : (event => {
          event.preventDefault();
          onFileContextMenu(event, file);
        })}
        title={isRepoRootChange ? node.repoRootPath ?? node.repoName ?? file.repoId : `${file.path}\n${t('Click to open diff')}`}
      >
        <div style={{ width: indent + 18, flexShrink: 0 }} />
        {isRepoRootChange ? (
          <Codicon name="repo" style={{ fontSize: '14px', flexShrink: 0 }} />
        ) : (
          <FileIcon name={node.name} theme={iconTheme} size={14} style={styles.fileIconBase} />
        )}
        <span style={styles.fileName(statusColor, isSelected)}>{displayName}</span>
        {(file.added != null || file.removed != null) && (
          <span style={styles.lineStats}>
            {file.added != null && <span style={styles.added}>+{file.added}</span>}
            {file.removed != null && <span style={styles.removed}>-{file.removed}</span>}
          </span>
        )}
        <span style={styles.statusLetter(statusColor)}>{status}</span>
      </div>
    );
  }

  const folderBaseName = node.name.includes('/') ? node.name.split('/').pop()! : node.name;
  const isRepoRoot = !!node.isRepoRoot;
  return (
    <>
      <div
        style={isRepoRoot ? styles.repoRootRow : styles.dirRow}
        className="versiondock-detail-row"
        data-selected={false}
        title={node.fullPath}
        onClick={() => { if (allExpanded === null) setLocalOpen(current => !current); }}
        onContextMenu={event => {
          event.preventDefault();
          onDirectoryContextMenu(event, node);
        }}
      >
        <div style={{ width: indent, flexShrink: 0 }} />
        <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={styles.chevron} />
        {isRepoRoot ? (
          <span style={styles.repoRootDot(node.repoColor ?? 'var(--vscode-foreground)')} />
        ) : (
          <FileIcon name={folderBaseName} isFolder isOpen={open} theme={iconTheme} size={16} style={styles.folderIconBase} />
        )}
        <span style={isRepoRoot ? styles.repoRootName : styles.dirName}>{isRepoRoot ? node.name.toUpperCase() : node.name}</span>
        <span style={styles.fileCountBadge}>{node.fileCount}</span>
      </div>
      {open && Array.from(node.children.values())
        .sort((left, right) => {
          if (!left.file && right.file) return -1;
          if (left.file && !right.file) return 1;
          return left.name.localeCompare(right.name);
        })
        .map(child => (
          <TreeDir
            key={child.fullPath}
            node={child}
            depth={depth + 1}
            selectedFile={selectedFile}
            onOpen={onOpen}
            onFileContextMenu={onFileContextMenu}
            onDirectoryContextMenu={onDirectoryContextMenu}
            allExpanded={allExpanded}
            iconTheme={iconTheme}
          />
        ))}
    </>
  );
}

export function CommitDetail({ commit, commits, files, groupedEntries, selectedFile, loadingFiles, repoColor, repos, remoteNamesByRepo, iconTheme, isMultiCommitSelection, activeHistoryPath, activeLineRange, onSelectFile, onClose }: Props) {
  const [viewMode, setViewMode] = useState<'tree' | 'flat'>('tree');
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);
  const [containingBranches, setContainingBranches] = useState<ContainingBranches>({ local: [], remote: [], tags: [] });
  const [loadingBranches, setLoadingBranches] = useState(false);
  const [aggregateContainingBranches, setAggregateContainingBranches] = useState<Record<string, ContainingBranches>>({});
  const [loadingAggregateBranchKeys, setLoadingAggregateBranchKeys] = useState<Set<string>>(() => new Set());
  const [refsExpanded, setRefsExpanded] = useState(false);
  const [fullCommitMessages, setFullCommitMessages] = useState<Record<string, string>>({});
  const [loadingCommitMessageKeys, setLoadingCommitMessageKeys] = useState<Set<string>>(() => new Set());
  const [mergeCommits, setMergeCommits] = useState<MergeParentCommit[]>([]);
  const [loadingMerge, setLoadingMerge] = useState(false);
  const [selectedMergeHash, setSelectedMergeHash] = useState<string | null>(null);
  const [mergeFiles, setMergeFiles] = useState<LogViewFileEntry[]>([]);
  const [loadingMergeFiles, setLoadingMergeFiles] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [infoSectionHeight, setInfoSectionHeight] = useState<number | null>(null);
  const [expandedCommitMessageKeys, setExpandedCommitMessageKeys] = useState<Set<string>>(() => new Set());
  const [commitMessagesExpandedByDefault, setCommitMessagesExpandedByDefault] = useState(() => (
    getVsCodeApi().getState<{ commitMessagesExpandedByDefault?: boolean }>()?.commitMessagesExpandedByDefault === true
  ));
  const pendingRef = useRef<Map<string, (msg: HostToLogMsg) => void>>(new Map());
  const commitMessageCacheRef = useRef<Map<string, string>>(new Map());
  const containingBranchesCacheRef = useRef<Map<string, ContainingBranches>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const infoSectionRef = useRef<HTMLDivElement>(null);

  const repoNameById = useMemo(() => Object.fromEntries(repos.map(repo => [repo.id, repo.name])), [repos]);
  const repoRootPathById = useMemo(() => Object.fromEntries(repos.map(repo => [repo.id, repo.rootPath])), [repos]);
  const repoColorById = useMemo(() => Object.fromEntries(repos.map(repo => [repo.id, readableAccentColor(repo.color)])), [repos]);
  const repoKindById = useMemo(() => Object.fromEntries(repos.map(repo => [repo.id, repo.kind ?? 'git'])), [repos]);
  const involvedRepoIds = useMemo(() => Array.from(new Set(commits.map(selectedCommit => selectedCommit.repoId))), [commits]);
  const showRepoGrouping = repos.length > 1;
  const selectedMergeCommit = useMemo(() => (
    selectedMergeHash ? mergeCommits.find(mergeCommit => mergeCommit.hash === selectedMergeHash) ?? null : null
  ), [mergeCommits, selectedMergeHash]);
  const activeFiles = selectedMergeHash ? mergeFiles : files;
  const activeLoadingFiles = selectedMergeHash ? loadingMergeFiles : loadingFiles;
  const primaryCommitMessageKey = commit ? scopedKey(commit.repoId, commit.hash) : '';
  const fullCommitMessage = primaryCommitMessageKey ? fullCommitMessages[primaryCommitMessageKey] ?? null : null;
  const loadingCommitMessage = primaryCommitMessageKey ? loadingCommitMessageKeys.has(primaryCommitMessageKey) : false;
  const displayedCommitMessage = useMemo(
    () => splitCommitMessage(fullCommitMessage, commit?.message ?? ''),
    [commit?.message, fullCommitMessage],
  );
  const selectedCommitMessageKeys = useMemo(
    () => isMultiCommitSelection
      ? commits.map(selectedCommit => scopedKey(selectedCommit.repoId, selectedCommit.hash))
      : primaryCommitMessageKey ? [primaryCommitMessageKey] : [],
    [commits, isMultiCommitSelection, primaryCommitMessageKey],
  );
  const singleCommitMessageExpanded = primaryCommitMessageKey
    ? expandedCommitMessageKeys.has(primaryCommitMessageKey)
    : false;
  const singleCommitMessageCanExpand = Boolean(displayedCommitMessage.body);

  const toggleCommitMessage = useCallback((messageKey: string) => {
    setExpandedCommitMessageKeys(current => {
      const next = new Set(current);
      if (next.has(messageKey)) next.delete(messageKey);
      else next.add(messageKey);
      return next;
    });
  }, []);

  const toggleCommitMessagesExpandedByDefault = useCallback(() => {
    const nextExpandedByDefault = !commitMessagesExpandedByDefault;
    setCommitMessagesExpandedByDefault(nextExpandedByDefault);
    const vscodeApi = getVsCodeApi();
    const currentState = vscodeApi.getState<Record<string, unknown>>() ?? {};
    vscodeApi.setState({ ...currentState, commitMessagesExpandedByDefault: nextExpandedByDefault });
    setExpandedCommitMessageKeys(new Set(nextExpandedByDefault ? selectedCommitMessageKeys : []));
  }, [commitMessagesExpandedByDefault, selectedCommitMessageKeys]);

  const tree = useMemo(() => buildTree(activeFiles, repoNameById, repoRootPathById, repoColorById, showRepoGrouping), [activeFiles, repoNameById, repoRootPathById, repoColorById, showRepoGrouping]);
  const visibleTreeChildren = useMemo(() => (
    Array.from(tree.children.values())
      .sort((left, right) => {
        if (!left.file && right.file) return -1;
        if (left.file && !right.file) return 1;
        return left.name.localeCompare(right.name);
      })
      .map(child => collapseSingleChildDirs(child))
  ), [tree]);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToLogMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      if ('requestId' in msg && msg.requestId && pendingRef.current.has(msg.requestId as string)) {
        const resolve = pendingRef.current.get(msg.requestId as string)!;
        pendingRef.current.delete(msg.requestId as string);
        resolve(msg);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => {
    setRefsExpanded(false);
  }, [commit?.hash, isMultiCommitSelection]);

  useEffect(() => {
    setExpandedCommitMessageKeys(new Set(commitMessagesExpandedByDefault ? selectedCommitMessageKeys : []));
  }, [commitMessagesExpandedByDefault, selectedCommitMessageKeys]);

  useEffect(() => {
    const targets = isMultiCommitSelection ? commits : commit ? [commit] : [];
    const missingTargets = targets.filter(target => !commitMessageCacheRef.current.has(scopedKey(target.repoId, target.hash)));
    setFullCommitMessages(current => {
      const next = { ...current };
      for (const target of targets) {
        const cacheKey = scopedKey(target.repoId, target.hash);
        if (commitMessageCacheRef.current.has(cacheKey)) {
          next[cacheKey] = commitMessageCacheRef.current.get(cacheKey) ?? '';
        }
      }
      return next;
    });
    setLoadingCommitMessageKeys(new Set(missingTargets.map(target => scopedKey(target.repoId, target.hash))));
    if (missingTargets.length === 0) return;

    let cancelled = false;
    const pendingRequests = pendingRef.current;
    const requestIds: string[] = [];
    for (const target of missingTargets) {
      const cacheKey = scopedKey(target.repoId, target.hash);
      const requestId = generateId();
      requestIds.push(requestId);
      pendingRequests.set(requestId, (msg) => {
        if (cancelled || msg.type !== 'LOG_COMMIT_MESSAGE_RESULT') return;
        if (!msg.error) commitMessageCacheRef.current.set(cacheKey, msg.fullMessage);
        setFullCommitMessages(current => ({ ...current, [cacheKey]: msg.error ? '' : msg.fullMessage }));
        setLoadingCommitMessageKeys(current => {
          const next = new Set(current);
          next.delete(cacheKey);
          return next;
        });
      });
      getVsCodeApi().postMessage({
        type: 'LOG_REQUEST_COMMIT_MESSAGE',
        requestId,
        repoId: target.repoId,
        hash: target.hash,
      } satisfies LogToHostMsg);
    }

    return () => {
      cancelled = true;
      requestIds.forEach(requestId => pendingRequests.delete(requestId));
    };
  }, [commit, commits, isMultiCommitSelection]);

  useEffect(() => {
    if (!isMultiCommitSelection) {
      setAggregateContainingBranches({});
      setLoadingAggregateBranchKeys(new Set());
      return;
    }

    const targets = commits.map(selectedCommit => ({
      repoId: selectedCommit.repoId,
      hash: selectedCommit.hash,
      key: scopedKey(selectedCommit.repoId, selectedCommit.hash),
    }));
    const cachedBranches: Record<string, ContainingBranches> = {};
    const missingTargets = targets.filter(target => {
      const cached = containingBranchesCacheRef.current.get(target.key);
      if (!cached) return true;
      cachedBranches[target.key] = cached;
      return false;
    });
    setAggregateContainingBranches(cachedBranches);
    setLoadingAggregateBranchKeys(new Set(missingTargets.map(target => target.key)));
    if (missingTargets.length === 0) return;

    let cancelled = false;
    const pendingRequests = pendingRef.current;
    const requestIds: string[] = [];
    for (const target of missingTargets) {
      const requestId = generateId();
      requestIds.push(requestId);
      pendingRequests.set(requestId, (msg) => {
        if (cancelled || msg.type !== 'LOG_COMMIT_BRANCHES_RESULT') return;
        containingBranchesCacheRef.current.set(target.key, msg.branches);
        setAggregateContainingBranches(current => ({ ...current, [target.key]: msg.branches }));
        setLoadingAggregateBranchKeys(current => {
          const next = new Set(current);
          next.delete(target.key);
          return next;
        });
      });
      getVsCodeApi().postMessage({
        type: 'LOG_REQUEST_COMMIT_BRANCHES',
        requestId,
        repoId: target.repoId,
        hash: target.hash,
      } satisfies LogToHostMsg);
    }

    return () => {
      cancelled = true;
      requestIds.forEach(requestId => pendingRequests.delete(requestId));
    };
  }, [commits, isMultiCommitSelection]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const infoSection = infoSectionRef.current;
    if (!container || !infoSection) return;

    const updateHeight = () => {
      const containerHeight = container.getBoundingClientRect().height;
      if (containerHeight <= DETAIL_SPLITTER_SIZE) return;
      setInfoSectionHeight(current => clampInfoSectionHeight(
        current ?? infoSection.getBoundingClientRect().height,
        containerHeight,
      ));
    };

    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!commit || isMultiCommitSelection) {
      setContainingBranches({ local: [], remote: [], tags: [] });
      setMergeCommits([]);
      setSelectedMergeHash(null);
      setMergeFiles([]);
      setLoadingBranches(false);
      setLoadingMerge(false);
      setLoadingMergeFiles(false);
      return;
    }

    setSelectedMergeHash(null);
    setMergeFiles([]);
    setLoadingMergeFiles(false);
    setLoadingBranches(true);
    const pendingRequests = pendingRef.current;
    const requestIds: string[] = [];
    const branchesRequestId = generateId();
    requestIds.push(branchesRequestId);
    pendingRequests.set(branchesRequestId, (msg) => {
      if (msg.type === 'LOG_COMMIT_BRANCHES_RESULT') {
        setContainingBranches(msg.branches);
        setLoadingBranches(false);
      }
    });
    getVsCodeApi().postMessage({
      type: 'LOG_REQUEST_COMMIT_BRANCHES',
      requestId: branchesRequestId,
      repoId: commit.repoId,
      hash: commit.hash,
    } satisfies LogToHostMsg);

    if (commit.parents.length >= 2) {
      setLoadingMerge(true);
      const mergeRequestId = generateId();
      requestIds.push(mergeRequestId);
      pendingRequests.set(mergeRequestId, (msg) => {
        if (msg.type === 'LOG_MERGE_COMMITS_RESULT') {
          setMergeCommits(msg.commits);
          setLoadingMerge(false);
        }
      });
      getVsCodeApi().postMessage({
        type: 'LOG_REQUEST_MERGE_COMMITS',
        requestId: mergeRequestId,
        repoId: commit.repoId,
        hash: commit.hash,
        parents: commit.parents,
      } satisfies LogToHostMsg);
    } else {
      setMergeCommits([]);
      setLoadingMerge(false);
    }

    return () => {
      requestIds.forEach(requestId => pendingRequests.delete(requestId));
    };
  }, [commit, isMultiCommitSelection]);

  const buildPathEntries = useCallback((targetFiles: LogViewFileEntry[]): LogCommitPathEntry[] => {
    const entries = targetFiles.flatMap(file => (
      groupedEntries[scopedKey(file.repoId, file.path)] ?? [file]
    ));
    return Array.from(new Map(entries.map(entry => [scopedKey(entry.repoId, entry.commitHash, entry.path), {
      repoId: entry.repoId,
      hash: entry.commitHash,
      path: entry.path,
      status: entry.status,
    }])).values());
  }, [groupedEntries]);

  const handleOpenDiff = useCallback((file: LogViewFileEntry) => {
    onSelectFile(file);
    const lineRange = activeHistoryPath && isSameHistoryFilePath(activeHistoryPath, file.path)
      ? activeLineRange
      : undefined;
    const repoCommits = commits.filter(selectedCommit => selectedCommit.repoId === file.repoId);
    if (repoCommits.length > 1) {
      const newest = repoCommits[0];
      const oldest = repoCommits[repoCommits.length - 1];
      const fromHash = oldest.parents[0];
      if (!fromHash) {
        window.alert(t('Cannot compare this file because the oldest selected commit has no parent.'));
        return;
      }
      getVsCodeApi().postMessage({
        type: 'LOG_OPEN_FILE_RANGE_DIFF',
        repoId: file.repoId,
        fromHash,
        toHash: newest.hash,
        filePath: file.path,
        lineRange,
      } satisfies LogToHostMsg);
      return;
    }
    getVsCodeApi().postMessage({
      type: 'LOG_OPEN_FILE_DIFF',
      repoId: file.repoId,
      hash: file.commitHash,
      filePath: file.path,
      fileStatus: file.status,
      lineRange,
    } satisfies LogToHostMsg);
  }, [activeHistoryPath, activeLineRange, commits, onSelectFile]);

  const handleOpenSource = useCallback((file: LogViewFileEntry) => {
    const isActiveHistoryFile = !!activeHistoryPath && isSameHistoryFilePath(activeHistoryPath, file.path);
    const lineRange = isActiveHistoryFile ? activeLineRange : undefined;
    getVsCodeApi().postMessage({
      type: 'LOG_OPEN_FILE',
      repoId: file.repoId,
      filePath: isActiveHistoryFile ? activeHistoryPath : file.path,
      lineRange,
    } satisfies LogToHostMsg);
  }, [activeHistoryPath, activeLineRange]);

  const handleApplyFiles = useCallback((targetFiles: LogViewFileEntry[]) => {
    const entries = buildPathEntries(targetFiles);
    if (entries.length === 0) return;
    getVsCodeApi().postMessage({
      type: 'LOG_APPLY_COMMIT_PATHS',
      requestId: generateId(),
      repoId: entries[0].repoId,
      entries,
    } satisfies LogToHostMsg);
  }, [buildPathEntries]);

  const handleRestoreFiles = useCallback((targetFiles: LogViewFileEntry[]) => {
    const entries = buildPathEntries(targetFiles);
    if (entries.length === 0) return;
    getVsCodeApi().postMessage({
      type: 'LOG_RESTORE_COMMIT_PATHS',
      requestId: generateId(),
      repoId: entries[0].repoId,
      entries,
    } satisfies LogToHostMsg);
  }, [buildPathEntries]);

  const handleRevealInExplorer = useCallback((file: LogViewFileEntry) => {
    const filePath = activeHistoryPath && isSameHistoryFilePath(activeHistoryPath, file.path)
      ? activeHistoryPath
      : file.path;
    getVsCodeApi().postMessage({
      type: 'LOG_REVEAL_IN_EXPLORER',
      repoId: file.repoId,
      filePath,
    } satisfies LogToHostMsg);
  }, [activeHistoryPath]);

  const handleRevealInOS = useCallback((file: LogViewFileEntry) => {
    const filePath = activeHistoryPath && isSameHistoryFilePath(activeHistoryPath, file.path)
      ? activeHistoryPath
      : file.path;
    getVsCodeApi().postMessage({
      type: 'LOG_REVEAL_IN_OS',
      repoId: file.repoId,
      filePath,
    } satisfies LogToHostMsg);
  }, [activeHistoryPath]);

  const handleOpenSelectedChanges = useCallback(() => {
    if (!commit) return;
    if (!isMultiCommitSelection) {
      getVsCodeApi().postMessage({ type: 'LOG_OPEN_COMMIT_CHANGES', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg);
      return;
    }

    const filesByRepo = new Map<string, Set<string>>();
    for (const file of activeFiles) {
      const repoFiles = filesByRepo.get(file.repoId) ?? new Set<string>();
      repoFiles.add(file.path);
      filesByRepo.set(file.repoId, repoFiles);
    }

    const groups = involvedRepoIds.flatMap(repoId => {
      const repoCommits = commits.filter(selectedCommit => selectedCommit.repoId === repoId);
      const newest = repoCommits[0];
      const oldest = repoCommits[repoCommits.length - 1];
      const repoFiles = filesByRepo.get(repoId);
      if (!newest || !oldest || !repoFiles || repoFiles.size === 0) return [];
      return [{
        repoId,
        fromHash: repoKindById[repoId] === 'svn'
          ? previousSvnRevision(oldest.hash)
          : oldest.parents[0],
        toHash: newest.hash,
        files: Array.from(repoFiles),
      }];
    });

    if (groups.length === 0) return;
    getVsCodeApi().postMessage({ type: 'LOG_OPEN_COMMIT_CHANGES_MULTI', groups } satisfies LogToHostMsg);
  }, [activeFiles, commit, commits, involvedRepoIds, isMultiCommitSelection, repoKindById]);

  const handleOpenExtendedDetail = useCallback(() => {
    if (!commit) return;
    if (!isMultiCommitSelection) {
      getVsCodeApi().postMessage({ type: 'LOG_OPEN_EXTENDED_DETAIL', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg);
      return;
    }
    getVsCodeApi().postMessage({
      type: 'LOG_OPEN_EXTENDED_DETAIL_MULTI',
      commits: commits.map(selectedCommit => ({ repoId: selectedCommit.repoId, hash: selectedCommit.hash })),
    } satisfies LogToHostMsg);
  }, [commit, commits, isMultiCommitSelection]);

  const selectMergeCommit = useCallback((mergeCommit: MergeParentCommit) => {
    if (!commit || isMultiCommitSelection) return;
    if (selectedMergeHash === mergeCommit.hash) {
      setSelectedMergeHash(null);
      setMergeFiles([]);
      setLoadingMergeFiles(false);
      return;
    }

    setSelectedMergeHash(mergeCommit.hash);
    setMergeFiles([]);
    setLoadingMergeFiles(true);
    const requestId = generateId();
    pendingRef.current.set(requestId, (msg) => {
      if (msg.type === 'LOG_COMMIT_FILES') {
        setMergeFiles(msg.files.map(file => ({
          ...file,
          repoId: commit.repoId,
          commitHash: mergeCommit.hash,
        })));
        setLoadingMergeFiles(false);
      }
    });
    getVsCodeApi().postMessage({
      type: 'LOG_REQUEST_COMMIT_FILES',
      requestId,
      repoId: commit.repoId,
      hash: mergeCommit.hash,
    } satisfies LogToHostMsg);
  }, [commit, isMultiCommitSelection, selectedMergeHash]);

  const handleSectionResizeMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const onMove = (moveEvent: MouseEvent) => {
      setInfoSectionHeight(clampInfoSectionHeight(rect.bottom - moveEvent.clientY, rect.height));
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const repoName = commit ? repoNameById[commit.repoId] ?? commit.repoId : null;
  const selectedTimeRange = commits.length > 0
    ? `${formatDateTime(commits[commits.length - 1].authorDate)} - ${formatDateTime(commits[0].authorDate)}`
    : '';

  return (
    <div ref={containerRef} style={styles.container} onContextMenu={event => event.preventDefault()}>
      <style>{INTERACTION_STYLE}</style>
      <div style={styles.fileSection}>
        <div style={styles.fileListToolbar}>
          <span style={styles.fileCount}>
            {activeFiles.length === 1 ? t('{0} file', activeFiles.length) : t('{0} files', activeFiles.length)}
            {selectedMergeCommit ? ` · ${selectedMergeCommit.shortHash}` : ''}
          </span>
          {viewMode === 'tree' && (
            <div style={styles.expandBtns}>
              <button className="versiondock-detail-icon-row" style={styles.toggleBtn(false)} onClick={() => setAllExpanded(true)} title={t('Expand all')}>
                <Codicon name="expand-all" style={{ fontSize: '13px' }} />
              </button>
              <button className="versiondock-detail-icon-row" style={styles.toggleBtn(false)} onClick={() => setAllExpanded(false)} title={t('Collapse all')}>
                <Codicon name="collapse-all" style={{ fontSize: '13px' }} />
              </button>
            </div>
          )}
          <div style={styles.viewToggle}>
            <button className="versiondock-detail-icon-row" style={styles.toggleBtn(viewMode === 'tree')} onClick={() => { setViewMode('tree'); setAllExpanded(null); }} title={t('Tree view')}>
              <Codicon name="list-tree" style={{ fontSize: '13px' }} />
            </button>
            <button className="versiondock-detail-icon-row" style={styles.toggleBtn(viewMode === 'flat')} onClick={() => { setViewMode('flat'); setAllExpanded(null); }} title={t('Flat list')}>
              <Codicon name="list-flat" style={{ fontSize: '13px' }} />
            </button>
          </div>
        </div>

        {contextMenu && (
          <ContextMenu
            state={contextMenu}
            onShowDiff={contextMenu.file ? () => handleOpenDiff(contextMenu.file!) : undefined}
            onEditSource={contextMenu.file ? () => handleOpenSource(contextMenu.file!) : undefined}
            onRevealExplorer={contextMenu.file ? () => handleRevealInExplorer(contextMenu.file!) : undefined}
            onRevealOS={contextMenu.file ? () => handleRevealInOS(contextMenu.file!) : undefined}
            onRevert={contextMenu.files.every(file => repoKindById[file.repoId] !== 'svn') ? () => handleRestoreFiles(contextMenu.files) : undefined}
            onCherryPick={contextMenu.files.every(file => repoKindById[file.repoId] !== 'svn') ? () => handleApplyFiles(contextMenu.files) : undefined}
            onClose={() => setContextMenu(null)}
          />
        )}

        <div style={styles.fileList}>
          {activeLoadingFiles && <div style={styles.loading}>{t('Loading files...')}</div>}
          {!activeLoadingFiles && activeFiles.length === 0 && <div style={styles.loading}>{t('No changed files')}</div>}

          {!activeLoadingFiles && viewMode === 'tree' && visibleTreeChildren.map(child => (
            <TreeDir
              key={child.fullPath}
              node={child}
              depth={0}
              selectedFile={selectedFile}
              onOpen={handleOpenDiff}
              onFileContextMenu={(event, file) => setContextMenu({
                x: event.clientX,
                y: event.clientY,
                files: groupedEntries[scopedKey(file.repoId, file.path)] ?? [file],
                file,
              })}
              onDirectoryContextMenu={(event, node) => {
                if (node.descendantFiles.length === 0) return;
                setContextMenu({
                  x: event.clientX,
                  y: event.clientY,
                  files: node.descendantFiles,
                });
              }}
              allExpanded={allExpanded}
              iconTheme={iconTheme}
            />
          ))}

          {!activeLoadingFiles && viewMode === 'flat' && activeFiles.map(file => {
            const isRepoRootChange = file.path === '.';
            const isSelected = selectedFile?.repoId === file.repoId && selectedFile?.path === file.path;
            const status = normalizeStatus(file.status);
            const statusColor = STATUS_COLORS[status] ?? 'var(--vscode-foreground)';
            const fileName = isRepoRootChange ? repoNameById[file.repoId] ?? file.repoId : (file.path.split('/').pop() ?? file.path);
            const dir = isRepoRootChange ? repoRootPathById[file.repoId] ?? fileName : (file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '');
            return (
              <div
                key={scopedKey(file.repoId, file.commitHash, file.path)}
                style={styles.fileRow(isSelected)}
                className="versiondock-detail-row"
                data-selected={isSelected}
                onClick={isRepoRootChange ? undefined : () => handleOpenDiff(file)}
                onContextMenu={isRepoRootChange ? undefined : (event => {
                  event.preventDefault();
                  setContextMenu({
                    x: event.clientX,
                    y: event.clientY,
                    files: groupedEntries[scopedKey(file.repoId, file.path)] ?? [file],
                    file,
                  });
                })}
                title={isRepoRootChange ? dir : `${file.path}\n${t('Click to open diff')}`}
              >
                <div style={{ width: 4, flexShrink: 0 }} />
                {isRepoRootChange ? (
                <Codicon name="repo" style={{ fontSize: '14px', flexShrink: 0 }} />
                ) : (
                  <FileIcon name={fileName} theme={iconTheme} size={14} style={styles.fileIconBase} />
                )}
                <span style={styles.fileName(statusColor, isSelected)}>{fileName}</span>
                {dir && <span style={styles.dirPath}>{dir}</span>}
                {showRepoGrouping && <span style={styles.repoPill}>{repoNameById[file.repoId] ?? file.repoId}</span>}
                {(file.added != null || file.removed != null) && (
                  <span style={styles.lineStats}>
                    {file.added != null && <span style={styles.added}>+{file.added}</span>}
                    {file.removed != null && <span style={styles.removed}>-{file.removed}</span>}
                  </span>
                )}
                <span style={styles.statusLetter(statusColor)}>{status}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={styles.sectionSplitter} onMouseDown={handleSectionResizeMouseDown} />

      <div ref={infoSectionRef} style={styles.infoSection(infoSectionHeight)}>
        {isMultiCommitSelection ? (
          <div style={styles.multiSummary}>
            <div style={styles.summaryHeader}>
              <div style={styles.summaryTitle}>{t('Aggregated commit selection')}</div>
              <div style={styles.detailActions}>
                {commit && (
                  <>
                    <button
                      className="versiondock-detail-icon-row"
                      data-top-action-btn=""
                      style={styles.topActionBtn}
                      title={t('Open extended commit detail')}
                      onClick={handleOpenExtendedDetail}
                    >
                      <Codicon name="open-preview" style={{ fontSize: '15px' }} />
                    </button>
                    <button
                      className="versiondock-detail-icon-row"
                      data-top-action-btn=""
                      style={styles.topActionBtn}
                      title={t('Open Changes')}
                      onClick={handleOpenSelectedChanges}
                    >
                      <Codicon name="diff-multiple" style={{ fontSize: '15px' }} />
                    </button>
                  </>
                )}
                <button
                  className="versiondock-detail-icon-row"
                  data-top-action-btn=""
                  style={styles.topActionBtn}
                  title={commitMessagesExpandedByDefault ? t('Collapse commit messages by default') : t('Expand commit messages by default')}
                  aria-pressed={commitMessagesExpandedByDefault}
                  onClick={toggleCommitMessagesExpandedByDefault}
                >
                  <Codicon name={commitMessagesExpandedByDefault ? 'collapse-all' : 'expand-all'} style={{ fontSize: '14px' }} />
                </button>
                {onClose && (
                  <button
                    className="versiondock-detail-icon-row"
                    data-top-action-btn=""
                    style={styles.topActionBtn}
                    title={t('Close commit detail')}
                    onClick={onClose}
                  >
                    <Codicon name="layout-sidebar-right" style={{ fontSize: '15px' }} />
                  </button>
                )}
              </div>
            </div>
            <div style={styles.summaryMetaRow}>
              <span>{commits.length === 1 ? t('{0} commit selected', commits.length) : t('{0} commits selected', commits.length)}</span>
              <span>{t('{0} repositories involved', involvedRepoIds.length)}</span>
            </div>
            <div style={styles.summaryMetaRow}>
              <span>{t('Selected time range')}</span>
              <span>{selectedTimeRange}</span>
            </div>
            <div style={styles.summaryList}>
              {commits.map((selectedCommit, index) => {
                const messageKey = scopedKey(selectedCommit.repoId, selectedCommit.hash);
                const message = splitCommitMessage(fullCommitMessages[messageKey] ?? null, selectedCommit.message);
                const loadingMessage = loadingCommitMessageKeys.has(messageKey);
                const messageExpanded = expandedCommitMessageKeys.has(messageKey);
                const messageCanExpand = Boolean(message.body);
                const selectedBranches = aggregateContainingBranches[messageKey];
                const selectedRefGroups = groupRefs(Array.from(new Set([
                  ...selectedCommit.refs,
                  ...(selectedBranches?.local ?? []).map(branch => branch.startsWith('refs/') ? branch : `refs/heads/${branch}`),
                  ...(selectedBranches?.remote ?? []).map(branch => branch.startsWith('refs/') ? branch : `refs/remotes/${branch}`),
                  ...(selectedBranches?.tags ?? []).map(tag => tag.startsWith('refs/tags/') ? tag : `refs/tags/${tag}`),
                ])), repoKindById[selectedCommit.repoId] ?? 'git', remoteNamesByRepo[selectedCommit.repoId] ?? []);
                const selectedHeadGroup = selectedRefGroups.find(group => group.isHead && !group.isDetached && !group.isRemoteHead && !group.isSvnRevision);
                const loadingSelectedBranches = loadingAggregateBranchKeys.has(messageKey);
                return (
                  <div key={messageKey} style={styles.summaryItem(index === commits.length - 1)}>
                    <div style={styles.summaryRepoRow}>
                      <Codicon name="repo" style={styles.repoIcon} />
                      <span style={styles.repoName(repoColorById[selectedCommit.repoId])}>
                        {repoNameById[selectedCommit.repoId] ?? selectedCommit.repoId}
                      </span>
                    </div>
                    <div style={styles.summaryMessageCard}>
                      <div style={styles.messageTitleRow}>
                        <div style={{ ...styles.summaryMessage, ...(messageExpanded ? styles.messageTitleExpanded : {}) }}>{message.subject}</div>
                        {messageCanExpand && (
                          <button
                            type="button"
                            className="versiondock-detail-icon-row"
                            style={styles.messageExpandButton}
                            title={messageExpanded ? t('Click to collapse') : t('Click to expand')}
                            aria-expanded={messageExpanded}
                            onClick={() => toggleCommitMessage(messageKey)}
                          >
                            <Codicon name={messageExpanded ? 'chevron-up' : 'chevron-down'} style={styles.messageExpandIcon} />
                          </button>
                        )}
                        {!messageCanExpand && <span style={styles.messageExpandPlaceholder} aria-hidden="true" />}
                      </div>
                      {messageExpanded && !loadingMessage && message.body ? (
                        <div style={styles.summaryMessageBody}>{message.body}</div>
                      ) : null}
                    </div>
                    <div style={styles.summaryItemMeta}>
                      <AuthorAvatar authorName={selectedCommit.authorName} authorEmail={selectedCommit.authorEmail} size={20} />
                      <div style={styles.summaryItemMetaText}>
                        <span>{selectedCommit.authorName}</span>
                        <span style={styles.dot}>·</span>
                        <span>{formatDateTime(selectedCommit.authorDate)}</span>
                        <span style={styles.dot}>·</span>
                        <span style={styles.metaHashGroup} title={selectedCommit.hash}>
                          <Codicon name="git-commit" style={styles.metaHashIcon} />
                          <span style={styles.metaHash}>{selectedCommit.shortHash}</span>
                        </span>
                      </div>
                    </div>
                    {(selectedRefGroups.length > 0 || loadingSelectedBranches) && (
                      <div style={styles.summaryRefsRow}>
                        {selectedHeadGroup && (
                          <span style={styles.refBadge(headColor(), true)} title={headBadgeTitle(selectedHeadGroup)}>
                            <Codicon name="arrow-right" style={{ fontSize: '9px', flexShrink: 0, lineHeight: 1 }} />
                            HEAD
                          </span>
                        )}
                        {selectedRefGroups.map(group => {
                          const isSpecialHead = group.isRemoteHead
                            || (group.isHead && group.isDetached)
                            || (group.isSvnRevision && group.label === 'HEAD');
                          const color = group.isTag ? tagColor() : isSpecialHead ? headColor() : branchColor(group.label, false);
                          return (
                            <span
                              key={group.key}
                              style={styles.refBadge(color, (group.isHead || group.isDetached) && !group.isRemoteHead)}
                              title={badgeTitle(group)}
                            >
                              <RefBadgeIcon group={group} />
                              <span style={styles.refBadgeLabel}>{formatRefLabel(group)}</span>
                            </span>
                          );
                        })}
                        {loadingSelectedBranches && selectedRefGroups.length === 0 && (
                          <span style={styles.refsLoadingLabel}>...</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ) : commit ? (
          <div style={styles.singleInfo}>
            {repoName && (
              <div style={styles.repoRow}>
                <Codicon name="repo" style={styles.repoIcon} />
                <span style={styles.repoName(repoColor ? readableAccentColor(repoColor) : undefined)}>{repoName}</span>
                <div style={styles.detailActions}>
                  <button
                    className="versiondock-detail-icon-row"
                    data-top-action-btn=""
                    style={styles.topActionBtn}
                    title={t('Open extended commit detail')}
                    onClick={handleOpenExtendedDetail}
                  >
                    <Codicon name="open-preview" style={{ fontSize: '15px' }} />
                  </button>
                  <button
                    className="versiondock-detail-icon-row"
                    data-top-action-btn=""
                    style={styles.topActionBtn}
                    title={t('Open Changes')}
                    onClick={handleOpenSelectedChanges}
                  >
                    <Codicon name="diff-multiple" style={{ fontSize: '15px' }} />
                  </button>
                  <button
                    className="versiondock-detail-icon-row"
                    data-top-action-btn=""
                    style={styles.topActionBtn}
                    title={commitMessagesExpandedByDefault ? t('Collapse commit messages by default') : t('Expand commit messages by default')}
                    aria-pressed={commitMessagesExpandedByDefault}
                    onClick={toggleCommitMessagesExpandedByDefault}
                  >
                    <Codicon name={commitMessagesExpandedByDefault ? 'collapse-all' : 'expand-all'} style={{ fontSize: '14px' }} />
                  </button>
                  {onClose && (
                    <button
                      className="versiondock-detail-icon-row"
                      data-top-action-btn=""
                      style={styles.topActionBtn}
                      title={t('Close commit detail')}
                      onClick={onClose}
                    >
                      <Codicon name="layout-sidebar-right" style={{ fontSize: '15px' }} />
                    </button>
                  )}
                </div>
              </div>
            )}
            <div style={styles.commitMessageCard}>
              <div style={styles.messageTitleRow}>
                <div style={{ ...styles.message, ...(singleCommitMessageExpanded ? styles.messageTitleExpanded : {}) }}>{displayedCommitMessage.subject}</div>
                {singleCommitMessageCanExpand && (
                  <button
                    type="button"
                    className="versiondock-detail-icon-row"
                    style={styles.messageExpandButton}
                    title={singleCommitMessageExpanded ? t('Click to collapse') : t('Click to expand')}
                    aria-expanded={singleCommitMessageExpanded}
                    onClick={() => toggleCommitMessage(primaryCommitMessageKey)}
                  >
                    <Codicon name={singleCommitMessageExpanded ? 'chevron-up' : 'chevron-down'} style={styles.messageExpandIcon} />
                  </button>
                )}
                {!singleCommitMessageCanExpand && <span style={styles.messageExpandPlaceholder} aria-hidden="true" />}
              </div>
              {singleCommitMessageExpanded && !loadingCommitMessage && displayedCommitMessage.body ? (
                <div style={styles.commitMessageBody}>{displayedCommitMessage.body}</div>
              ) : null}
            </div>
            <div style={styles.authorRow}>
              <AuthorAvatar authorName={commit.authorName} authorEmail={commit.authorEmail} size={20} />
              <div style={styles.meta}>
                <span>{commit.authorName}</span>
                <span style={styles.dot}>·</span>
                <span>{formatDateTime(commit.authorDate)}</span>
                <span style={styles.dot}>·</span>
                <span style={styles.metaHashGroup} title={commit.hash}>
                  <Codicon name="git-commit" style={styles.metaHashIcon} />
                  <span style={styles.metaHash}>{commit.shortHash}</span>
                </span>
              </div>
            </div>
            {(() => {
              const LIMIT = 5;
              const remoteNames = remoteNamesByRepo[commit.repoId] ?? [];
              const refGroups = groupRefs(commit.refs, repoKindById[commit.repoId] ?? 'git', remoteNames);
              const refLabels = new Set(refGroups.map(group => group.label));
              type Badge =
                | { kind: 'ref'; group: RefGroup }
                | { kind: 'local'; name: string }
                | { kind: 'remote'; name: string; remoteName: string }
                | { kind: 'tag'; name: string };

              const splitRemote = (branch: string) => splitRemoteRefName(branch, remoteNames);
              const stripRemote = (branch: string) => splitRemote(branch)?.name ?? branch;
              const getRemote = (branch: string) => splitRemote(branch)?.remoteName ?? '';
              const isHEADRef = (branch: string) => stripRemote(branch).toUpperCase() === 'HEAD';

              const revisionBadges = refGroups.filter(group => group.isSvnRevision).map(group => ({ kind: 'ref' as const, group }));
              const headBadges = refGroups.filter(group => group.isHead && !group.isSvnRevision).map(group => ({ kind: 'ref' as const, group }));
              const refTagBadges = refGroups.filter(group => group.isTag).map(group => ({ kind: 'ref' as const, group }));
              const refLocalPrimary = refGroups.filter(group => !group.isHead && !group.isTag && group.isLocal && isPrimaryBranch(group.label)).map(group => ({ kind: 'ref' as const, group }));
              const refLocalOther = refGroups.filter(group => !group.isHead && !group.isTag && group.isLocal && !isPrimaryBranch(group.label)).map(group => ({ kind: 'ref' as const, group }));
              const refRemotePrimary = refGroups.filter(group => !group.isHead && !group.isTag && group.isRemote && isPrimaryBranch(group.label)).map(group => ({ kind: 'ref' as const, group }));
              const refRemoteOther = refGroups.filter(group => !group.isHead && !group.isTag && group.isRemote && !isPrimaryBranch(group.label)).map(group => ({ kind: 'ref' as const, group }));

              const localOnly = containingBranches.local;
              const extraLocalPrimary = localOnly.filter(branch => !refLabels.has(branch) && isPrimaryBranch(branch)).map(name => ({ kind: 'local' as const, name }));
              const extraLocalOther = localOnly.filter(branch => !refLabels.has(branch) && !isPrimaryBranch(branch)).map(name => ({ kind: 'local' as const, name }));
              const extraRemotePrimary = containingBranches.remote
                .filter(branch => !isHEADRef(branch) && !refLabels.has(stripRemote(branch)) && isPrimaryBranch(stripRemote(branch)))
                .map(branch => ({ kind: 'remote' as const, name: stripRemote(branch), remoteName: getRemote(branch) }));
              const extraRemoteOther = containingBranches.remote
                .filter(branch => !isHEADRef(branch) && !refLabels.has(stripRemote(branch)) && !isPrimaryBranch(stripRemote(branch)))
                .map(branch => ({ kind: 'remote' as const, name: stripRemote(branch), remoteName: getRemote(branch) }));
              const extraTags = containingBranches.tags.filter(tag => !refLabels.has(tag)).map(name => ({ kind: 'tag' as const, name }));

              const allBadges: Badge[] = [
                ...revisionBadges,
                ...headBadges,
                ...refTagBadges,
                ...refLocalPrimary,
                ...extraLocalPrimary,
                ...refLocalOther,
                ...extraLocalOther,
                ...refRemotePrimary,
                ...extraRemotePrimary,
                ...refRemoteOther,
                ...extraRemoteOther,
                ...extraTags,
              ];

              if (allBadges.length === 0 && !loadingBranches) return null;
              const visible = refsExpanded ? allBadges : allBadges.slice(0, LIMIT);
              const hiddenCount = allBadges.length - LIMIT;

              function renderBadge(badge: Badge, key: string) {
                if (badge.kind === 'ref') {
                  const group = badge.group;
                  const isSpecialHead = group.isRemoteHead
                    || (group.isHead && group.isDetached)
                    || (group.isSvnRevision && group.label === 'HEAD');
                  const color = group.isTag ? tagColor() : isSpecialHead ? headColor() : branchColor(group.label, false);
                  return (
                    <span key={key} style={styles.refBadge(color, (group.isHead || group.isDetached) && !group.isRemoteHead)} title={badgeTitle(group)}>
                      <RefBadgeIcon group={group} />
                      <span style={styles.refBadgeLabel}>{formatRefLabel(group)}</span>
                    </span>
                  );
                }
                if (badge.kind === 'tag') {
                  const color = tagColor();
                  return (
                    <span key={key} style={styles.refBadge(color)} title={t('Tag: {0}', badge.name)}>
                      <Codicon name="tag" style={{ fontSize: '11px', flexShrink: 0, lineHeight: 1 }} />
                      <span style={styles.refBadgeLabel}>{badge.name}</span>
                    </span>
                  );
                }
                const isRemote = badge.kind === 'remote';
                const remoteName = isRemote ? badge.remoteName || t('remote') : '';
                const label = isRemote ? `${remoteName}/${badge.name}` : badge.name;
                const color = branchColor(badge.name, false);
                return (
                  <span key={key} style={styles.refBadge(color)} title={isRemote ? t('Remote branch: {0}', label) : t('Branch: {0}', label)}>
                    <Codicon name={isRemote ? 'cloud' : 'git-branch'} style={{ fontSize: '11px', flexShrink: 0, lineHeight: 1 }} />
                    <span style={styles.refBadgeLabel}>{label}</span>
                  </span>
                );
              }

              const nonDetachedHeadGroup = refGroups.find(group => group.isHead && !group.isDetached && !group.isRemoteHead && !group.isSvnRevision);
              return (
                <div style={refsExpanded ? styles.refsRowExpanded : styles.refsRow}>
                  {nonDetachedHeadGroup && (
                    <span style={styles.refBadge(headColor(), true)} title={headBadgeTitle(nonDetachedHeadGroup)}>
                      <Codicon name="arrow-right" style={{ fontSize: '9px', flexShrink: 0, lineHeight: 1 }} />
                      HEAD
                    </span>
                  )}
                  {visible.map((badge, index) => renderBadge(badge, String(index)))}
                  {!refsExpanded && hiddenCount > 0 && (
                    <span
                      style={styles.refsShowMore}
                      onClick={() => setRefsExpanded(true)}
                      title={t('Show {0} more', hiddenCount)}
                    >
                      {t('+{0} more', hiddenCount)}
                    </span>
                  )}
                  {loadingBranches && allBadges.length === 0 && <span style={styles.refsLoadingLabel}>...</span>}
                  {refsExpanded && allBadges.length > LIMIT && (
                    <span
                      style={{ ...styles.refsShowMore, width: '100%', marginTop: '2px' }}
                      onClick={() => setRefsExpanded(false)}
                    >
                      {t('Show less')}
                    </span>
                  )}
                </div>
              );
            })()}
            {(commit.parents.length >= 2 || loadingMerge || mergeCommits.length > 0) && (
              <div style={styles.mergeSection}>
                <div style={styles.mergeSectionTitle}>
                  <Codicon name="git-merge" style={{ fontSize: '11px' }} />
                  <span>{t('Merged commits')}</span>
                </div>
                {loadingMerge && <div style={styles.mergeLoading}>{t('Loading...')}</div>}
                {!loadingMerge && mergeCommits.length === 0 && <div style={styles.mergeLoading}>{t('No commits found')}</div>}
                {!loadingMerge && mergeCommits.map(mergeCommit => {
                  const isActive = selectedMergeHash === mergeCommit.hash;
                  return (
                    <div key={mergeCommit.hash}>
                      <div
                        style={styles.mergeCommitRow(isActive)}
                        className="versiondock-detail-row"
                        data-selected={isActive}
                        title={`${mergeCommit.hash}\n${t('Click to view files')}`}
                        onClick={() => selectMergeCommit(mergeCommit)}
                      >
                        <Codicon name={isActive ? 'chevron-down' : 'chevron-right'} style={styles.mergeChevron} />
                        <span style={styles.metaHashGroup}>
                          <Codicon name="git-commit" style={styles.metaHashIcon} />
                          <span style={styles.metaHash}>{mergeCommit.shortHash}</span>
                        </span>
                        <span style={styles.mergeMessage}>{mergeCommit.message}</span>
                        <span style={styles.mergeMeta}>{mergeCommit.authorName}</span>
                      </div>
                      {isActive && (
                        <div style={styles.mergeFileList}>
                          {loadingMergeFiles && <div style={styles.mergeLoading}>{t('Loading files...')}</div>}
                          {!loadingMergeFiles && mergeFiles.length === 0 && <div style={styles.mergeLoading}>{t('No changed files')}</div>}
                          {!loadingMergeFiles && mergeFiles.map(file => {
                            const status = normalizeStatus(file.status);
                            const statusColor = STATUS_COLORS[status] ?? 'var(--vscode-foreground)';
                            const fileName = file.path.split('/').pop() ?? file.path;
                            return (
                              <div
                                key={scopedKey(file.repoId, file.commitHash, file.path)}
                                style={styles.mergeFileRow}
                                className="versiondock-detail-row"
                                data-selected={false}
                                title={file.path}
                                onClick={() => handleOpenDiff(file)}
                              >
                                <FileIcon name={fileName} theme={iconTheme} size={13} style={{ flexShrink: 0 }} />
                                <span style={{ ...styles.mergeMessage, color: statusColor }}>{fileName}</span>
                                {(file.added != null || file.removed != null) && (
                                  <span style={styles.lineStats}>
                                    {file.added != null && <span style={styles.added}>+{file.added}</span>}
                                    {file.removed != null && <span style={styles.removed}>-{file.removed}</span>}
                                  </span>
                                )}
                                <span style={styles.mergeFileStatus(statusColor)}>{status}</span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ) : (
          <div style={styles.emptyInfo}>{t('Select a commit to view details')}</div>
        )}
      </div>
    </div>
  );
}

const menuStyles = {
  container: (x: number, y: number): React.CSSProperties => ({
    position: 'fixed',
    left: x,
    top: y,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    padding: '3px 0',
    zIndex: 9999,
    minWidth: '190px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
  }),
  item: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '4px 12px',
    fontSize: '12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    userSelect: 'none',
  } as React.CSSProperties,
  icon: {
    fontSize: '13px',
    flexShrink: 0,
  } as React.CSSProperties,
};

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    height: '100%',
    borderLeft: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
    position: 'relative' as const,
  },
  detailActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  topActionBtn: {
    width: '22px',
    height: '22px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    borderRadius: '3px',
    color: 'var(--vscode-foreground)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as React.CSSProperties,
  fileSection: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column' as const,
  },
  sectionSplitter: {
    height: `${DETAIL_SPLITTER_SIZE}px`,
    flexShrink: 0,
    cursor: 'row-resize',
    background: 'transparent',
    backgroundImage: 'linear-gradient(to bottom, transparent 1px, var(--vscode-panel-border) 1px, var(--vscode-panel-border) 2px, transparent 2px)',
    backgroundRepeat: 'no-repeat',
    transition: 'background 0.15s',
  } as React.CSSProperties,
  infoSection: (height: number | null): React.CSSProperties => ({
    flex: height == null ? '0 1 auto' : `0 0 ${height}px`,
    minHeight: height == null ? '220px' : 0,
    maxHeight: height == null ? '48%' : 'none',
    overflowY: 'auto' as const,
    display: 'flex',
    flexDirection: 'column' as const,
  }),
  repoRootRow: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    overflow: 'hidden',
    gap: '5px',
    padding: '2px 10px 2px 0',
    cursor: 'pointer',
    minHeight: '22px',
    color: 'var(--vscode-foreground)',
    userSelect: 'none',
  } as React.CSSProperties,
  repoRootDot: (color: string): React.CSSProperties => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  repoRootName: {
    flex: 1,
    minWidth: 0,
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    fontSize: '10px',
    color: 'var(--vscode-foreground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  singleInfo: {
    padding: '9px 12px 12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  multiSummary: {
    padding: '10px 12px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  summaryHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
  } as React.CSSProperties,
  summaryTitle: {
    fontSize: '12px',
    fontWeight: 700,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  summaryMetaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '8px',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  summaryList: {
    display: 'flex',
    flexDirection: 'column' as const,
    marginTop: '4px',
  } as React.CSSProperties,
  summaryItem: (isLast: boolean): React.CSSProperties => ({
    padding: '8px 0 12px',
    borderBottom: isLast ? 'none' : '1px solid var(--vscode-panel-border)',
  }),
  summaryRepoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    marginBottom: '6px',
    minWidth: 0,
  } as React.CSSProperties,
  summaryMessageCard: {
    padding: '10px 12px',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
    background: 'var(--vscode-textCodeBlock-background, var(--vscode-input-background))',
  } as React.CSSProperties,
  summaryMessage: {
    flex: 1,
    minWidth: 0,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '12px',
    fontWeight: 400,
    lineHeight: 1.45,
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    userSelect: 'text' as const,
  } as React.CSSProperties,
  summaryItemMeta: {
    display: 'flex',
    gap: '6px',
    marginTop: '8px',
    alignItems: 'center',
  } as React.CSSProperties,
  summaryItemMetaText: {
    display: 'flex',
    gap: '6px',
    minWidth: 0,
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    alignItems: 'center',
    flexWrap: 'wrap' as const,
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  summaryRefsRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
    marginTop: '7px',
  } as React.CSSProperties,
  summaryMessageBody: {
    marginTop: '8px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '12px',
    lineHeight: 1.45,
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    userSelect: 'text' as const,
  } as React.CSSProperties,
  emptyInfo: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    fontSize: '13px',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  repoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    marginBottom: '2px',
    minWidth: 0,
  } as React.CSSProperties,
  repoIcon: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  repoName: (color?: string): React.CSSProperties => ({
    fontSize: '11px',
    fontWeight: 600,
    color: color ?? 'var(--vscode-foreground)',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  }),
  repoPill: {
    fontSize: '10px',
    padding: '0 6px',
    borderRadius: '999px',
    background: 'var(--versiondock-badge-background)',
    color: 'var(--versiondock-badge-foreground)',
    flexShrink: 0,
  } as React.CSSProperties,
  hash: {
    fontFamily: 'monospace',
    fontSize: '11px',
    color: 'var(--versiondock-badge-foreground)',
    padding: '1px 4px',
    background: 'var(--versiondock-badge-background)',
    borderRadius: '3px',
    flexShrink: 0,
  } as React.CSSProperties,
  message: {
    flex: 1,
    minWidth: 0,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontWeight: 400,
    fontSize: '12px',
    lineHeight: 1.45,
    color: 'var(--vscode-foreground)',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    userSelect: 'text' as const,
  } as React.CSSProperties,
  messageTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    minWidth: 0,
  } as React.CSSProperties,
  messageExpandButton: {
    width: '18px',
    height: '18px',
    padding: 0,
    border: 'none',
    borderRadius: '3px',
    background: 'transparent',
    color: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    flexShrink: 0,
  } as React.CSSProperties,
  messageExpandPlaceholder: {
    width: '18px',
    height: '18px',
    flexShrink: 0,
  } as React.CSSProperties,
  messageExpandIcon: {
    fontSize: '12px',
    flexShrink: 0,
  } as React.CSSProperties,
  messageTitleExpanded: {
    whiteSpace: 'pre-wrap' as const,
    overflow: 'visible',
    textOverflow: 'clip',
    wordBreak: 'break-word' as const,
  } as React.CSSProperties,
  commitMessageCard: {
    marginTop: '2px',
    marginBottom: '3px',
    padding: '10px 12px',
    background: 'var(--vscode-textCodeBlock-background, var(--vscode-input-background))',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '4px',
  } as React.CSSProperties,
  commitMessageBody: {
    marginTop: '8px',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '12px',
    lineHeight: 1.45,
    color: 'var(--vscode-foreground)',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    userSelect: 'text' as const,
  } as React.CSSProperties,
  authorRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '3px',
    marginBottom: '5px',
  },
  meta: {
    display: 'flex',
    gap: '6px',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    flexWrap: 'wrap' as const,
    alignItems: 'center',
  },
  metaHash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '10px',
  } as React.CSSProperties,
  metaHashGroup: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
  } as React.CSSProperties,
  metaHashIcon: {
    fontSize: '11px',
    flexShrink: 0,
  } as React.CSSProperties,
  dot: {
    color: 'var(--vscode-descriptionForeground)',
  },
  refsRow: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
  },
  refsRowExpanded: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '4px',
    maxHeight: '160px',
    overflowY: 'auto' as const,
    paddingRight: '2px',
  },
  refsShowMore: {
    fontSize: '10px',
    color: 'var(--vscode-textLink-foreground)',
    cursor: 'pointer',
    alignSelf: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  refsLoadingLabel: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    alignSelf: 'center',
  } as React.CSSProperties,
  refBadge: (color: string, isHead = false): React.CSSProperties => ({
    fontSize: '10px',
    padding: '0 6px',
    height: '16px',
    lineHeight: '16px',
    borderRadius: '3px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    maxWidth: '160px',
    overflow: 'hidden',
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
    boxSizing: 'border-box' as const,
    fontWeight: isHead ? 700 : 500,
  }),
  refBadgeLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  } as React.CSSProperties,
  mergeSection: {
    marginTop: '6px',
    borderTop: '1px solid var(--vscode-panel-border)',
    paddingTop: '6px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  },
  mergeSectionTitle: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    marginBottom: '2px',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  mergeLoading: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    padding: '2px 0',
  } as React.CSSProperties,
  mergeCommitRow: (active: boolean): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 4px',
    fontSize: '11px',
    cursor: 'pointer',
    borderRadius: '3px',
    background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
  }),
  mergeChevron: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    flexShrink: 0,
  } as React.CSSProperties,
  mergeFileList: {
    marginLeft: '16px',
    marginBottom: '2px',
    borderLeft: '1px solid var(--vscode-panel-border)',
    paddingLeft: '6px',
  } as React.CSSProperties,
  mergeFileRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '1px 4px',
    fontSize: '11px',
    cursor: 'pointer',
    borderRadius: '2px',
  } as React.CSSProperties,
  mergeFileStatus: (color: string): React.CSSProperties => ({
    fontSize: '10px',
    fontWeight: 700,
    color,
    flexShrink: 0,
  }),
  mergeMessage: {
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  mergeMeta: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    flexShrink: 0,
    maxWidth: '80px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  fileListToolbar: {
    display: 'flex',
    alignItems: 'center',
    padding: '3px 10px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    gap: '4px',
  } as React.CSSProperties,
  fileCount: {
    flex: 1,
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
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
  toggleBtn: (active: boolean): React.CSSProperties => ({
    background: active ? 'var(--vscode-toolbar-activeBackground)' : 'transparent',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-descriptionForeground)',
    padding: '2px 4px',
    display: 'flex',
    alignItems: 'center',
  }),
  fileList: {
    flex: 1,
    overflowY: 'auto' as const,
    fontSize: '12px',
  },
  fileRow: (selected: boolean, hovered = false, ctxActive = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingRight: '10px',
    paddingTop: '2px',
    paddingBottom: '2px',
    cursor: 'pointer',
    background: selected
      ? 'var(--vscode-list-activeSelectionBackground)'
      : ctxActive
        ? 'var(--vscode-list-inactiveSelectionBackground)'
        : hovered
          ? 'var(--vscode-list-hoverBackground)'
          : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    minHeight: '22px',
    userSelect: 'none',
  }),
  dirRow: {
    display: 'flex',
    alignItems: 'center',
    minWidth: 0,
    overflow: 'hidden',
    gap: '3px',
    padding: '2px 10px 2px 0',
    cursor: 'pointer',
    minHeight: '22px',
    color: 'var(--vscode-foreground)',
    userSelect: 'none',
  } as React.CSSProperties,
  chevron: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    flexShrink: 0,
    width: '14px',
  } as React.CSSProperties,
  fileIconBase: {
  } as React.CSSProperties,
  folderIconBase: {
    color: 'var(--vscode-symbolIcon-folderForeground, #dcb67a)',
  } as React.CSSProperties,
  dirName: {
    fontSize: '12px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
    minWidth: 0,
  },
  fileCountBadge: {
    fontSize: '10px',
    background: 'var(--versiondock-badge-background)',
    color: 'var(--versiondock-badge-foreground)',
    borderRadius: '8px',
    padding: '0 5px',
    minWidth: '16px',
    textAlign: 'center' as const,
    flexShrink: 0,
  } as React.CSSProperties,
  statusLetter: (color: string) => ({
    fontSize: '11px',
    fontWeight: 'bold' as const,
    color,
    minWidth: '14px',
    flexShrink: 0,
  }),
  fileName: (color: string, selected: boolean) => ({
    color: selected ? 'inherit' : color,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: 1,
  }),
  dirPath: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    maxWidth: '80px',
  },
  lineStats: {
    display: 'flex',
    gap: '3px',
    flexShrink: 0,
    fontSize: '10px',
    fontFamily: 'monospace',
  } as React.CSSProperties,
  added: {
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
  } as React.CSSProperties,
  removed: {
    color: 'var(--vscode-gitDecoration-deletedResourceForeground)',
  } as React.CSSProperties,
  loading: {
    padding: '8px',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center' as const,
  },
};
