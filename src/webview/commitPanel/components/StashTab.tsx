import React, { useState } from 'react';
import type { StashEntry } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { FileIcon } from '../../shared/FileIcon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import type { ViewMode, LayoutDensity } from '../store/commitStore';
import { useCommitStore } from '../store/commitStore';
import { t } from '../../shared/i18n';
import { branchColor, readableAccentColor } from '../../shared/branchColors';
import { getCommitMessageTitle } from '../../shared/commitMessage';
import { scopedKey } from '../../shared/scopedKey';
import { HighlightedText, matchSpeedSearchItem } from '../../shared/speedSearch';

interface Props {
  repoId: string;
  repoName: string;
  repoColor: string;
  multiRepo: boolean;
  isFirst?: boolean;
  worktreeBranch?: string;
  worktreeBranchColor?: string;
  mainRepoName?: string;
  stashes: StashEntry[];
  loading: boolean;
  error: string | null;
  viewMode: ViewMode;
  onApply: (repoId: string, stashRef: string) => void;
  onPop: (repoId: string, stashRef: string) => void;
  onDrop: (repoId: string, stashRef: string) => void;
  onOpenFileDiff: (repoId: string, stashRef: string, filePath: string) => void;
  expansionCommand: ExpansionCommand;
  stashFilesMap?: Record<string, { loading: boolean; files?: StashEntry['files']; error?: string }>;
  onRequestStashFiles?: (repoId: string, stashRef: string, stashOid?: string) => void;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}

export interface ExpansionCommand {
  sequence: number;
  expanded: boolean;
}

const STASH_CTX_ITEMS: ContextMenuEntry[] = [
  { id: 'pop',   label: t('Pop (apply & drop)'), icon: 'desktop-download' },
  { id: 'apply', label: t('Apply (keep stash)'), icon: 'arrow-down' },
  { separator: true },
  { id: 'drop',  label: t('Delete'),             icon: 'trash', danger: true },
];

const STATUS_COLORS: Record<string, string> = {
  modified:  'var(--vscode-gitDecoration-modifiedResourceForeground)',
  added:     'var(--vscode-gitDecoration-addedResourceForeground)',
  deleted:   'var(--vscode-gitDecoration-deletedResourceForeground)',
  renamed:   'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
  untracked: 'var(--vscode-gitDecoration-untrackedResourceForeground)',
};
const STATUS_LETTERS: Record<string, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U',
};

const ICON_SIZE = 16;
const BASE_PAD  = 20;
const LEVEL_PAD = 20;

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

// ── Tree data structure ───────────────────────────────────────────────────────

type StashFile = NonNullable<StashEntry['files']>[number];
interface TreeDir  { kind: 'dir';  name: string; path: string; children: TreeNode[] }
interface TreeFile { kind: 'file'; name: string; file: StashFile }
type TreeNode = TreeDir | TreeFile;

function buildTree(files: StashFile[]): TreeNode[] {
  const root: TreeDir = { kind: 'dir', name: '', path: '', children: [] };
  for (const file of files) {
    const parts = file.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      const dirPath = parts.slice(0, i + 1).join('/');
      let child = node.children.find((c): c is TreeDir => c.kind === 'dir' && c.name === part);
      if (!child) {
        child = { kind: 'dir', name: part, path: dirPath, children: [] };
        node.children.push(child);
      }
      node = child;
    }
    node.children.push({ kind: 'file', name: parts[parts.length - 1], file });
  }
  return collapseSingleChildDirs(root.children);
}

function collapseSingleChildDirs(nodes: TreeNode[]): TreeNode[] {
  return nodes.map(node => {
    if (node.kind === 'file') return node;
    const children = collapseSingleChildDirs(node.children);
    if (children.length === 1 && children[0].kind === 'dir') {
      const only = children[0] as TreeDir;
      return { kind: 'dir' as const, name: `${node.name}/${only.name}`, path: only.path, children: only.children };
    }
    return { ...node, children };
  });
}

function countFiles(node: TreeDir): number {
  let c = 0;
  for (const ch of node.children) {
    if (ch.kind === 'file') c++;
    else c += countFiles(ch);
  }
  return c;
}

function collectDirPaths(nodes: TreeNode[], paths: string[] = []): string[] {
  for (const node of nodes) {
    if (node.kind !== 'dir') continue;
    paths.push(node.path);
    collectDirPaths(node.children, paths);
  }
  return paths;
}

// ── File row ──────────────────────────────────────────────────────────────────

function FileRow({ file, repoId, entry, depth = 0, onOpenFileDiff, speedSearchQuery, activeSpeedSearchKey }: {
  file: StashFile;
  repoId: string;
  entry: StashEntry;
  depth?: number;
  onOpenFileDiff: Props['onOpenFileDiff'];
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}) {
  const [hovered, setHovered] = useState(false);
  const iconTheme = useCommitStore(s => s.iconTheme);
  const itemKey = scopedKey(repoId, entry.ref, file.path);
  const isSpeedSearchActive = activeSpeedSearchKey === itemKey;
  const fname = file.path.split('/').pop() ?? file.path;
  const dir = file.path.includes('/') ? file.path.split('/').slice(0, -1).join('/') : '';
  const color = STATUS_COLORS[file.status] ?? 'var(--vscode-foreground)';
  const letter = STATUS_LETTERS[file.status] ?? 'M';
  const paddingLeft = BASE_PAD + depth * LEVEL_PAD;

  return (
    <div
      data-speed-search-key={itemKey}
      style={{
        display: 'flex', alignItems: 'center', minHeight: '22px', fontSize: '12px',
        gap: '3px', paddingLeft, paddingRight: '8px', cursor: 'pointer',
        background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent',
      }}
      onClick={() => onOpenFileDiff(repoId, entry.ref, file.path)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={t('{0} — click to open diff', file.path)}
    >
      <FileIcon name={fname} theme={iconTheme} size={ICON_SIZE} />
      <span style={{ color, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        <HighlightedText text={fname} query={speedSearchQuery} isActive={isSpeedSearchActive} />
      </span>
      {depth === 0 && dir && (
        <span style={{ fontSize: '11px', color: 'var(--vscode-descriptionForeground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, maxWidth: '80px' }}>
          <HighlightedText text={dir} query={speedSearchQuery} />
        </span>
      )}
      <span style={{ fontSize: '10px', fontWeight: 'bold', color, flexShrink: 0, width: '12px', textAlign: 'center' }}>{letter}</span>
    </div>
  );
}

// ── Tree directory node ───────────────────────────────────────────────────────

function TreeDirNode({ node, depth, repoId, entry, onOpenFileDiff, openDirs, toggleDir, speedSearchQuery, activeSpeedSearchKey }: {
  node: TreeDir;
  depth: number;
  repoId: string;
  entry: StashEntry;
  onOpenFileDiff: Props['onOpenFileDiff'];
  openDirs: Set<string>;
  toggleDir: (path: string) => void;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}) {
  const [hovered, setHovered] = useState(false);
  const iconTheme = useCommitStore(s => s.iconTheme);
  const open = openDirs.has(node.path);
  const paddingLeft = BASE_PAD + depth * LEVEL_PAD;
  const fc = countFiles(node);

  return (
    <div>
      <div
        data-list-row=""
        style={{
          display: 'flex', alignItems: 'center', minHeight: '22px', fontSize: '12px',
          paddingLeft, paddingRight: '8px', gap: '0',
          minWidth: 0, overflow: 'hidden', boxSizing: 'border-box',
          background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent',
          color: 'var(--vscode-foreground)',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div
          style={{ display: 'flex', alignItems: 'center', gap: '4px', flex: 1, minWidth: 0, overflow: 'hidden', cursor: 'pointer', userSelect: 'none', paddingLeft: '2px' }}
          onClick={() => toggleDir(node.path)}
          title={node.path}
        >
          <Codicon name={open ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '12px', width: '12px', flexShrink: 0 }} />
          <FileIcon name={node.name} isFolder isOpen={open} theme={iconTheme} size={ICON_SIZE} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <HighlightedText text={node.name} query={speedSearchQuery} />
          </span>
          <span style={{ fontSize: '10px', color: 'var(--vscode-descriptionForeground)', flexShrink: 0 }}>{fc}</span>
        </div>
      </div>
      {open && node.children.map(child =>
        child.kind === 'dir'
          ? <TreeDirNode key={child.path} node={child} depth={depth + 1} repoId={repoId} entry={entry} onOpenFileDiff={onOpenFileDiff} openDirs={openDirs} toggleDir={toggleDir} speedSearchQuery={speedSearchQuery} activeSpeedSearchKey={activeSpeedSearchKey} />
          : <FileRow key={child.file.path} file={child.file} repoId={repoId} entry={entry} depth={depth + 1} onOpenFileDiff={onOpenFileDiff} speedSearchQuery={speedSearchQuery} activeSpeedSearchKey={activeSpeedSearchKey} />
      )}
    </div>
  );
}

// ── Single stash entry row ────────────────────────────────────────────────────

function StashRow({ entry, repoId, viewMode, onApply, onPop, onDrop, onOpenFileDiff, expansionCommand, stashFilesMap, onRequestStashFiles, speedSearchQuery, activeSpeedSearchKey }: {
  entry: StashEntry;
  repoId: string;
  viewMode: ViewMode;
  onApply: Props['onApply'];
  onPop: Props['onPop'];
  onDrop: Props['onDrop'];
  onOpenFileDiff: Props['onOpenFileDiff'];
  expansionCommand: ExpansionCommand;
  stashFilesMap?: Props['stashFilesMap'];
  onRequestStashFiles?: Props['onRequestStashFiles'];
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}) {
  const [hovered, setHovered] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  // Per-directory open state (tree mode)
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set());
  const fullMessage = entry.fullMessage || entry.message || entry.ref;
  const messageTitle = getCommitMessageTitle(fullMessage, entry.ref);

  const stashIdentity = entry.oid ?? entry.ref;
  const fileState = stashFilesMap?.[stashIdentity];
  const files = React.useMemo(() => fileState?.files ?? entry.files ?? [], [entry.files, fileState?.files]);
  const hasLoadedFiles = fileState?.files !== undefined || entry.files !== undefined;
  const filesLoading = Boolean(fileState?.loading);

  const treeNodes = React.useMemo(
    () => viewMode === 'tree' ? buildTree(files) : null,
    [files, viewMode],
  );
  const allDirPaths = React.useMemo(
    () => treeNodes ? collectDirPaths(treeNodes) : [],
    [treeNodes],
  );

  const stashEntryKey = scopedKey(repoId, entry.ref);
  const isStashEntryActive = activeSpeedSearchKey === stashEntryKey;

  const matchedFiles = React.useMemo(() => {
    if (!speedSearchQuery) return [];
    return files.filter(f => matchSpeedSearchItem(f.path, speedSearchQuery).matched);
  }, [files, speedSearchQuery]);

  const savedExpandedBeforeSearch = React.useRef<boolean | null>(null);
  const savedOpenDirsBeforeSearch = React.useRef<Set<string> | null>(null);
  const expandedRef = React.useRef(expanded);
  expandedRef.current = expanded;
  const openDirsRef = React.useRef(openDirs);
  openDirsRef.current = openDirs;

  React.useEffect(() => {
    if (speedSearchQuery) {
      if (savedExpandedBeforeSearch.current === null) {
        savedExpandedBeforeSearch.current = expandedRef.current;
        savedOpenDirsBeforeSearch.current = new Set(openDirsRef.current);
      }
      if (matchedFiles.length > 0) {
        setExpanded(true);
        const dirsToOpen = new Set<string>();
        for (const f of matchedFiles) {
          const parts = f.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            dirsToOpen.add(parts.slice(0, i).join('/'));
          }
        }
        setOpenDirs(prev => new Set([...prev, ...dirsToOpen]));
      }
    } else {
      if (savedExpandedBeforeSearch.current !== null) {
        setExpanded(savedExpandedBeforeSearch.current);
        savedExpandedBeforeSearch.current = null;
      }
      if (savedOpenDirsBeforeSearch.current !== null) {
        setOpenDirs(savedOpenDirsBeforeSearch.current);
        savedOpenDirsBeforeSearch.current = null;
      }
    }
  }, [speedSearchQuery, matchedFiles]);

  // Sync with expand/collapse all (only when sequence > 0 and changed)
  const lastExpansionSeqRef = React.useRef(expansionCommand?.sequence ?? 0);
  React.useEffect(() => {
    if (!expansionCommand || expansionCommand.sequence === 0) return;
    if (expansionCommand.sequence === lastExpansionSeqRef.current) return;
    lastExpansionSeqRef.current = expansionCommand.sequence;

    setExpanded(expansionCommand.expanded);
    setOpenDirs(expansionCommand.expanded ? new Set(allDirPaths) : new Set());
    if (expansionCommand.expanded && !fileState?.files && (!entry.files || entry.files.length === 0)) {
      onRequestStashFiles?.(repoId, entry.ref, entry.oid);
    }
  }, [allDirPaths, entry.files, entry.oid, entry.ref, expansionCommand, fileState?.files, onRequestStashFiles, repoId]);

  const toggleDir = (path: string) => {
    setOpenDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  const handleToggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextExpanded = !expanded;
    setExpanded(nextExpanded);
    if (nextExpanded && !fileState?.files && (!entry.files || entry.files.length === 0)) {
      onRequestStashFiles?.(repoId, entry.ref, entry.oid);
    }
  };

  return (
    <div className="versiondock-card" style={row.root}>
      {/* Header */}
      <div
        data-speed-search-key={stashEntryKey}
        className="versiondock-card-header"
        style={{ ...row.header, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
        onClick={handleToggleExpand}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        title={entry.ref}
      >
        <button data-action-btn="" style={row.chevronBtn} onClick={handleToggleExpand}>
          <Codicon name={expanded ? 'chevron-down' : 'chevron-right'} style={{ fontSize: '11px' }} />
        </button>
        <Codicon name="save" style={{ fontSize: '13px', flexShrink: 0 }} />
        <div style={row.info}>
          <span style={row.name}>
            <span style={row.message} title={fullMessage}>
              <HighlightedText text={messageTitle} query={speedSearchQuery} isActive={isStashEntryActive} />
            </span>
            {entry.branch && (
              <span style={row.branchBadge(branchColor(entry.branch))} title={entry.branch}>
                <Codicon name="git-branch" style={{ fontSize: '10px', flexShrink: 0 }} />
                <span style={row.branchBadgeLabel}>{entry.branch}</span>
              </span>
            )}
          </span>
          <span style={row.meta}>
            {hasLoadedFiles && (
              <span style={row.fileCount}>
                {files.length === 1 ? t('{0} file', files.length) : t('{0} files', files.length)}
              </span>
            )}
            <span style={row.date}>{formatDate(entry.date)}</span>
          </span>
        </div>
        {hovered && (
          <div style={row.actions}>
            <button data-action-btn="" style={row.btn} title={t('Pop (apply and drop)')} onClick={e => { e.stopPropagation(); onPop(repoId, entry.ref); }}>
              <Codicon name="desktop-download" />
            </button>
            <button data-action-btn="" style={row.btn} title={t('Apply (keep stash)')} onClick={e => { e.stopPropagation(); onApply(repoId, entry.ref); }}>
              <Codicon name="arrow-down" />
            </button>
            <button data-action-btn="" style={{ ...row.btn, color: 'var(--vscode-errorForeground)' }} title={t('Drop stash')} onClick={e => { e.stopPropagation(); onDrop(repoId, entry.ref); }}>
              <Codicon name="trash" />
            </button>
          </div>
        )}
      </div>

      {/* Expanded body */}
      {expanded && (
        <div className="versiondock-card-body" style={row.fileList}>
          {filesLoading ? (
            <div style={{ ...row.emptyFiles, display: 'flex', alignItems: 'center', gap: '6px' }}>
              <Codicon name="loading~spin" style={{ fontSize: '12px' }} />
              {t('Loading files…')}
            </div>
          ) : fileState?.error ? (
            <div style={{ ...row.emptyFiles, color: 'var(--vscode-errorForeground)' }}>{fileState.error}</div>
          ) : files.length === 0 ? (
            <div style={row.emptyFiles}>{t('No files')}</div>
          ) : viewMode === 'tree' && treeNodes ? (
            treeNodes.map(node =>
              node.kind === 'dir'
                ? <TreeDirNode key={node.path} node={node} depth={0} repoId={repoId} entry={entry} onOpenFileDiff={onOpenFileDiff} openDirs={openDirs} toggleDir={toggleDir} speedSearchQuery={speedSearchQuery} activeSpeedSearchKey={activeSpeedSearchKey} />
                : <FileRow key={node.file.path} file={node.file} repoId={repoId} entry={entry} depth={0} onOpenFileDiff={onOpenFileDiff} speedSearchQuery={speedSearchQuery} activeSpeedSearchKey={activeSpeedSearchKey} />
            )
          ) : (
            files.map(f => (
              <FileRow key={f.path} file={f} repoId={repoId} entry={entry} onOpenFileDiff={onOpenFileDiff} speedSearchQuery={speedSearchQuery} activeSpeedSearchKey={activeSpeedSearchKey} />
            ))
          )}
        </div>
      )}

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x} y={ctxMenu.y}
          items={STASH_CTX_ITEMS}
          onSelect={id => {
            setCtxMenu(null);
            if (id === 'pop')   onPop(repoId, entry.ref);
            if (id === 'apply') onApply(repoId, entry.ref);
            if (id === 'drop')  onDrop(repoId, entry.ref);
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function StashTab({
  repoId, repoName, repoColor, multiRepo,
  worktreeBranch, worktreeBranchColor, mainRepoName,
  stashes, loading, error, viewMode,
  onApply, onPop, onDrop, onOpenFileDiff,
  expansionCommand,
  stashFilesMap,
  onRequestStashFiles,
  speedSearchQuery,
  activeSpeedSearchKey,
  isFirst = false,
}: Props) {
  const projectColor = readableAccentColor(repoColor);
  const layoutDensity = useCommitStore(s => s.layoutDensity);
  const [hovered, setHovered] = useState(false);

  return (
    <div style={css.root(isFirst, layoutDensity)}>
      {multiRepo && (
        <div
          style={css.repoHeader(projectColor, layoutDensity, hovered)}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <span style={css.dot(projectColor)} />
          <span style={css.repoName}>{worktreeBranch ? mainRepoName ?? repoName : repoName}</span>
          {worktreeBranch && (
            <span style={css.worktreeBadge(worktreeBranchColor ?? branchColor(worktreeBranch))} title={worktreeBranch}>
              <Codicon name="repo-clone" style={{ fontSize: '10px', flexShrink: 0 }} />
              <span style={css.branchBadgeLabel}>{worktreeBranch}</span>
            </span>
          )}
        </div>
      )}
      {error && (
        <div style={css.errorRow}>
          <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
          {error}
        </div>
      )}
      {loading && stashes.length === 0 ? (
        <div style={css.empty}>{t('Loading…')}</div>
      ) : stashes.length === 0 ? (
        <div style={css.empty}>{t('No stashes')}</div>
      ) : (
        stashes.map(entry => (
          <StashRow
            key={entry.oid ?? entry.ref}
            entry={entry}
            repoId={repoId}
            viewMode={viewMode}
            onApply={onApply}
            onPop={onPop}
            onDrop={onDrop}
            onOpenFileDiff={onOpenFileDiff}
            expansionCommand={expansionCommand}
            stashFilesMap={stashFilesMap}
            onRequestStashFiles={onRequestStashFiles}
            speedSearchQuery={speedSearchQuery}
            activeSpeedSearchKey={activeSpeedSearchKey}
          />
        ))
      )}
    </div>
  );
}

export type { Props as StashTabProps };

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  root: (isFirst: boolean, density: LayoutDensity = 'comfortable'): React.CSSProperties => {
    if (density === 'compact') {
      return { display: 'flex', flexDirection: 'column', borderBottom: '1px solid var(--vscode-panel-border)' };
    }
    return {
      display: 'flex',
      flexDirection: 'column',
      marginTop: isFirst ? '4px' : '6px',
    };
  },
  repoHeader: (color: string, density: LayoutDensity = 'comfortable', hovered = false): React.CSSProperties => {
    if (density === 'compact') {
      return {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', minHeight: '26px',
        background: hovered ? color + '33' : color + '22', borderBottom: '1px solid var(--vscode-panel-border)',
        boxSizing: 'border-box',
        transition: 'background 0.12s',
      };
    }
    return {
      display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', minHeight: '27px',
      background: hovered ? color + '28' : color + '1c',
      border: `1px solid ${color}${hovered ? '55' : '38'}`,
      borderRadius: '6px',
      margin: '0 6px',
      boxSizing: 'border-box',
      transition: 'background 0.12s, border-color 0.12s',
    };
  },
  dot: (color: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  repoName: { fontSize: '11px', fontWeight: 'bold' as const, textTransform: 'uppercase' as const, letterSpacing: '0.04em' },
  worktreeBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    fontSize: '10px', fontWeight: 600, background: `${color}33`, color,
    border: `1px solid ${color}88`, borderRadius: '3px', padding: '1px 5px',
    flexShrink: 1, minWidth: 0, maxWidth: '160px', overflow: 'hidden',
  }),
  branchBadgeLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 } as React.CSSProperties,
  errorRow: {
    display: 'flex', alignItems: 'flex-start', padding: '4px 8px', fontSize: '11px',
    color: 'var(--vscode-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)',
  } as React.CSSProperties,
  empty: { padding: '16px 12px', fontSize: '12px', color: 'var(--vscode-descriptionForeground)', textAlign: 'center' as const },
};

const row = {
  root: { borderBottom: '1px solid var(--vscode-panel-border)' } as React.CSSProperties,
  header: {
    display: 'flex', alignItems: 'center', gap: '5px',
    padding: '5px 8px 5px 4px', cursor: 'pointer', minHeight: '32px',
    minWidth: 0, overflow: 'hidden',
  } as React.CSSProperties,
  chevronBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '1px 3px', display: 'flex', alignItems: 'center',
    color: 'var(--vscode-foreground)', flexShrink: 0,
  } as React.CSSProperties,
  info: { display: 'flex', flexDirection: 'column' as const, flex: 1, minWidth: 0 },
  name: { fontSize: '12px', overflow: 'hidden', whiteSpace: 'nowrap' as const, display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } as React.CSSProperties,
  message: { flex: '0 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const } as React.CSSProperties,
  branchBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: '3px',
    fontSize: '10px', fontWeight: 600, padding: '1px 5px', borderRadius: '3px', flexShrink: 0,
    minWidth: 0, maxWidth: 'min(160px, 40%)', overflow: 'hidden',
    background: `${color}33`, color, border: `1px solid ${color}88`,
  }),
  branchBadgeLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 } as React.CSSProperties,
  meta: { display: 'flex', gap: '8px', marginTop: '2px' } as React.CSSProperties,
  fileCount: { fontSize: '10px', color: 'var(--vscode-descriptionForeground)' },
  date: { fontSize: '10px', color: 'var(--vscode-descriptionForeground)', whiteSpace: 'nowrap' as const },
  actions: { display: 'flex', gap: '2px', flexShrink: 0 } as React.CSSProperties,
  btn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    padding: '2px 4px', borderRadius: '3px', fontSize: '13px',
    display: 'flex', alignItems: 'center',
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  fileList: {
    display: 'flex', flexDirection: 'column' as const,
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)',
  } as React.CSSProperties,
  emptyFiles: { padding: '6px 24px', fontSize: '11px', color: 'var(--vscode-descriptionForeground)' },
};
