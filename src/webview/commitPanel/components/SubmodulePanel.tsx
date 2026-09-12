import React, { useState } from 'react';
import type { RepoSubmodules, SubmoduleItem } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { t } from '../../shared/i18n';
import { branchColor, headColor, readableAccentColor } from '../../shared/branchColors';

export interface SubmodulePanelProps {
  repos: RepoSubmodules[];
  loading: boolean;
  initialLoaded?: boolean;
  error: string | null;
  multiRepo: boolean;
  activeOps?: Record<string, string | undefined>;
  highlightSubmodulePath?: string | null;
  onInit: (parentRepoId: string, submodulePath: string) => void;
  onUpdate: (parentRepoId: string, submodulePath: string, recursive?: boolean, remote?: boolean) => void;
  onUpdateAll: (parentRepoId?: string, recursive?: boolean) => void;
  onSync: (parentRepoId: string, submodulePath?: string) => void;
  onDeinit: (parentRepoId: string, submodulePath: string) => void;
  onRemove: (parentRepoId: string, submodulePath: string) => void;
  onAdd: (parentRepoId?: string) => void;
  onRefresh: () => void;
  onResolveConflict?: (parentRepoId: string, submodulePath: string, side: 'ours' | 'theirs') => void;
  onOpenConflict?: (parentRepoId: string, submodulePath: string, companionPath?: string) => void;
  onOpenInNewWindow: (absPath: string) => void;
  onOpenInOS: (absPath: string) => void;
  onRevealInExplorer: (parentRepoId: string, relPath: string) => void;
}

const IS_MAC = navigator.userAgent.includes('Mac');
const IS_WIN = navigator.userAgent.includes('Windows');
const REVEAL_OS_LABEL = IS_MAC ? t('Reveal in Finder') : IS_WIN ? t('Show in Explorer') : t('Show in File Manager');

function submoduleCtxItems(sub: SubmoduleItem): ContextMenuEntry[] {
  const items: ContextMenuEntry[] = [];
  if (sub.syncStatus === 'conflict') {
    if (sub.isTypeChange) {
      items.push(
        {
          id: 'resolve-merge-editor',
          label: t('Resolve in Merge Editor'),
          icon: 'git-merge',
        },
        { separator: true },
      );
    } else {
      const hasOurs = !sub.conflictStages || !!sub.conflictStages.ours;
      const hasTheirs = !sub.conflictStages || !!sub.conflictStages.theirs;
      items.push(
        {
          id: 'resolve-ours',
          label: hasOurs
            ? t('Resolve Conflict: Use Current (Ours)')
            : t('Resolve Conflict: Accept Deletion (Ours)'),
          icon: hasOurs ? 'check' : 'trash',
        },
        {
          id: 'resolve-theirs',
          label: hasTheirs
            ? t('Resolve Conflict: Use Incoming (Theirs)')
            : t('Resolve Conflict: Accept Deletion (Theirs)'),
          icon: hasTheirs ? 'fold-down' : 'trash',
        },
        { separator: true },
      );
    }
  }
  if (!sub.initialized) {
    items.push({ id: 'init', label: t('Initialize Submodule'), icon: 'cloud-download' });
  } else {
    items.push(
      { id: 'update', label: t('Update Submodule'), icon: 'sync' },
      { id: 'update-remote', label: t('Update from Remote'), icon: 'cloud-download' },
    );
  }
  items.push(
    { separator: true },
    { id: 'explorer', label: t('Reveal in Explorer'), icon: 'folder-opened' },
    { id: 'newwindow', label: t('Open in New Window'), icon: 'link-external' },
    { id: 'os', label: REVEAL_OS_LABEL, icon: 'folder' },
    { separator: true },
  );
  if (sub.initialized) {
    items.push(
      { id: 'sync', label: t('Sync URL to Git Config'), icon: 'refresh' },
      { id: 'deinit', label: t('Deinitialize Submodule'), icon: 'clear-all', danger: true },
    );
  }
  items.push(
    { id: 'remove', label: t('Remove Submodule'), icon: 'trash', danger: true },
  );
  return items;
}

function SubmoduleRow({
  sub,
  parentRepoId,
  isHighlighted,
  activeOp,
  onInit,
  onUpdate,
  onSync,
  onDeinit,
  onRemove,
  onOpenInNewWindow,
  onOpenInOS,
  onRevealInExplorer,
  onResolveConflict,
  onOpenConflict,
}: {
  sub: SubmoduleItem;
  parentRepoId: string;
  isHighlighted?: boolean;
  activeOp?: string;
  onInit: SubmodulePanelProps['onInit'];
  onUpdate: SubmodulePanelProps['onUpdate'];
  onSync: SubmodulePanelProps['onSync'];
  onDeinit: SubmodulePanelProps['onDeinit'];
  onRemove: SubmodulePanelProps['onRemove'];
  onResolveConflict?: SubmodulePanelProps['onResolveConflict'];
  onOpenConflict?: SubmodulePanelProps['onOpenConflict'];
  onOpenInNewWindow: SubmodulePanelProps['onOpenInNewWindow'];
  onOpenInOS: SubmodulePanelProps['onOpenInOS'];
  onRevealInExplorer: SubmodulePanelProps['onRevealInExplorer'];
}) {
  const [hovered, setHovered] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const rawBranch = sub.currentBranch && sub.currentBranch !== 'HEAD' ? sub.currentBranch : undefined;
  const isDetachedCommit = sub.isDetached || !rawBranch || sub.currentBranch === 'HEAD';
  const branchLabel = isDetachedCommit
    ? (rawBranch || (sub.headCommit ? sub.headCommit.slice(0, 8) : '') || (sub.initialized ? t('detached HEAD') : ''))
    : (rawBranch || sub.branch || (sub.headCommit ? sub.headCommit.slice(0, 8) : ''));
  const branchClr = isDetachedCommit ? headColor() : branchLabel ? branchColor(branchLabel) : undefined;

  const isOperating = Boolean(activeOp);

  return (
    <div style={row.root} data-row-divider="">
      <div
        className="versiondock-list-row"
        data-list-row=""
        style={{
          ...row.header,
          background: isHighlighted
            ? 'var(--vscode-list-activeSelectionBackground, rgba(0, 120, 215, 0.2))'
            : hovered
              ? 'var(--vscode-list-hoverBackground)'
              : 'transparent',
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
        title={`${sub.name} (${sub.path})\n${sub.url}`}
      >
        <Codicon
          name={sub.initialized ? 'repo' : 'repo-clone'}
          style={{ fontSize: '13px', flexShrink: 0, opacity: sub.initialized ? 1 : 0.6 }}
        />
        <div style={row.info}>
          <div style={row.titleLine}>
            <span style={row.nameText} title={sub.path}>{sub.path}</span>
            {sub.name !== sub.path && (
              <span style={row.aliasText} title={sub.name}>({sub.name})</span>
            )}
            {sub.initialized ? (
              <span style={row.statusBadge('green')}>{t('Initialized')}</span>
            ) : (
              <span style={row.statusBadge('amber')}>{t('Uninitialized')}</span>
            )}
            {sub.syncStatus === 'conflict' && (
              <span style={row.statusBadge('red')}>
                {sub.isTypeChange ? t('Type-Change Conflict') : t('Conflict')}
              </span>
            )}
            {sub.isDirty && (
              <span style={row.statusBadge('amber')}>{t('Dirty')}</span>
            )}
            {Boolean(sub.unpushedCount && sub.unpushedCount > 0) && (
              <span style={row.statusBadge('purple')} title={t('{0} commits unpushed to remote', sub.unpushedCount ?? 0)}>
                {t('{0} unpushed', sub.unpushedCount ?? 0)}
              </span>
            )}
          </div>

          <div style={row.metaLine}>
            {sub.syncStatus === 'out-of-sync' && (
              <span
                style={row.statusBadge('neutral')}
                title={
                  sub.recordedCommit && sub.headCommit
                    ? `${t('Recorded in Parent:')} ${sub.recordedCommit}\n${t('Current HEAD:')} ${sub.headCommit}`
                    : t('Out of sync with parent commit')
                }
              >
                {sub.recordedCommit
                  ? t('Parent: {0}', sub.recordedCommit.slice(0, 8))
                  : t('Out of sync')}
              </span>
            )}
            {branchLabel ? (
              <span style={row.branchBadge(branchClr)} title={branchLabel}>
                <Codicon name={isDetachedCommit ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0 }} />
                <span style={row.branchName}>{branchLabel}</span>
              </span>
            ) : null}
            {sub.branch && (
              <span style={row.trackingBranch} title={t('Tracked branch: {0}', sub.branch)}>
                <Codicon name="link" style={{ fontSize: '9px' }} />
                <span>{sub.branch}</span>
              </span>
            )}
            <span style={row.urlText} title={sub.url}>{sub.url}</span>
          </div>
        </div>

        {/* Action buttons */}
        <div style={row.actions}>
          {isOperating ? (
            <span style={row.loadingText}>
              <Codicon name="loading~spin" />
            </span>
          ) : (
            <>
              {!sub.initialized ? (
                <button
                  data-primary-action-btn=""
                  style={row.primaryBtn}
                  title={t('Initialize this submodule (git submodule init && update)')}
                  onClick={e => { e.stopPropagation(); onInit(parentRepoId, sub.path); }}
                >
                  <Codicon name="cloud-download" style={{ marginRight: '4px', fontSize: '13px' }} />
                  {t('Initialize')}
                </button>
              ) : (
                <>
                  {sub.syncStatus === 'conflict' && (() => {
                    if (sub.isTypeChange) {
                      return (
                        <button
                          data-primary-action-btn=""
                          style={{ ...row.primaryBtn, backgroundColor: 'var(--vscode-editorWarning-foreground, #cca700)', color: '#000' }}
                          title={t('Resolve in Merge Editor')}
                          onClick={e => { e.stopPropagation(); onOpenConflict?.(parentRepoId, sub.path, sub.companionPath); }}
                        >
                          <Codicon name="git-merge" style={{ marginRight: '4px', fontSize: '13px' }} />
                          {t('Resolve in Merge Editor')}
                        </button>
                      );
                    }
                    const hasOurs = !sub.conflictStages || !!sub.conflictStages.ours;
                    return (
                      <button
                        data-primary-action-btn=""
                        style={{ ...row.primaryBtn, backgroundColor: 'var(--vscode-editorWarning-foreground, #cca700)', color: '#000' }}
                        title={hasOurs ? t('Resolve Conflict: Use Current Pointer (Ours)') : t('Resolve Conflict: Accept Deletion (Ours)')}
                        onClick={e => { e.stopPropagation(); onResolveConflict?.(parentRepoId, sub.path, 'ours'); }}
                      >
                        <Codicon name={hasOurs ? 'check' : 'trash'} style={{ marginRight: '4px', fontSize: '13px' }} />
                        {hasOurs ? t('Use Ours') : t('Delete (Ours)')}
                      </button>
                    );
                  })()}
                  {sub.syncStatus === 'out-of-sync' && (
                    <button
                      data-primary-action-btn=""
                      style={row.primaryBtn}
                      title={t('Align submodule with recorded parent commit')}
                      onClick={e => { e.stopPropagation(); onUpdate(parentRepoId, sub.path, false, false); }}
                    >
                      <Codicon name="arrow-swap" style={{ marginRight: '4px', fontSize: '13px' }} />
                      {t('Align')}
                    </button>
                  )}
                  {hovered && (
                    <>
                      <button
                        data-action-btn=""
                        style={row.iconBtn}
                        title={t('Reveal in Explorer')}
                        onClick={e => { e.stopPropagation(); onRevealInExplorer(parentRepoId, sub.path); }}
                      >
                        <Codicon name="folder-opened" />
                      </button>
                      <button
                        data-action-btn=""
                        style={row.iconBtn}
                        title={t('Update from Remote')}
                        onClick={e => { e.stopPropagation(); onUpdate(parentRepoId, sub.path, true, true); }}
                      >
                        <Codicon name="cloud-download" />
                      </button>
                      <button
                        data-action-btn=""
                        style={row.iconBtn}
                        title={t('Open in New Window')}
                        onClick={e => { e.stopPropagation(); onOpenInNewWindow(sub.absPath); }}
                      >
                        <Codicon name="link-external" />
                      </button>
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={submoduleCtxItems(sub)}
          onSelect={id => {
            setCtxMenu(null);
            if (id === 'init') onInit(parentRepoId, sub.path);
            else if (id === 'update') onUpdate(parentRepoId, sub.path, false, false);
            else if (id === 'update-remote') onUpdate(parentRepoId, sub.path, true, true);
            else if (id === 'resolve-merge-editor') onOpenConflict?.(parentRepoId, sub.path, sub.companionPath);
            else if (id === 'resolve-ours') onResolveConflict?.(parentRepoId, sub.path, 'ours');
            else if (id === 'resolve-theirs') onResolveConflict?.(parentRepoId, sub.path, 'theirs');
            else if (id === 'sync') onSync(parentRepoId, sub.path);
            else if (id === 'deinit') onDeinit(parentRepoId, sub.path);
            else if (id === 'remove') onRemove(parentRepoId, sub.path);
            else if (id === 'newwindow') onOpenInNewWindow(sub.absPath);
            else if (id === 'os') onOpenInOS(sub.absPath);
            else if (id === 'explorer') onRevealInExplorer(parentRepoId, sub.path);
          }}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function SubmoduleRepoGroup({
  repo,
  multiRepo,
  activeOps,
  highlightSubmodulePath,
  onInit,
  onUpdate,
  onUpdateAll,
  onSync,
  onDeinit,
  onRemove,
  onAdd,
  onResolveConflict,
  onOpenConflict,
  onOpenInNewWindow,
  onOpenInOS,
  onRevealInExplorer,
  isFirst = false,
}: {
  repo: RepoSubmodules;
  multiRepo: boolean;
  activeOps?: Record<string, string | undefined>;
  highlightSubmodulePath?: string | null;
  onInit: SubmodulePanelProps['onInit'];
  onUpdate: SubmodulePanelProps['onUpdate'];
  onUpdateAll: SubmodulePanelProps['onUpdateAll'];
  onSync: SubmodulePanelProps['onSync'];
  onDeinit: SubmodulePanelProps['onDeinit'];
  onRemove: SubmodulePanelProps['onRemove'];
  onAdd: SubmodulePanelProps['onAdd'];
  onResolveConflict?: SubmodulePanelProps['onResolveConflict'];
  onOpenConflict?: SubmodulePanelProps['onOpenConflict'];
  onOpenInNewWindow: SubmodulePanelProps['onOpenInNewWindow'];
  onOpenInOS: SubmodulePanelProps['onOpenInOS'];
  onRevealInExplorer: SubmodulePanelProps['onRevealInExplorer'];
  isFirst?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);

  const hasSubmodules = repo.submodules.length > 0;
  const projectColor = readableAccentColor(repo.repoColor);
  const uninitCount = repo.submodules.filter((s: SubmoduleItem) => !s.initialized).length;
  const outOfSyncCount = repo.submodules.filter((s: SubmoduleItem) => s.syncStatus === 'out-of-sync').length;
  const isUpdatingAll = activeOps?.[`${repo.repoId}:__all__`] === 'update-all' || activeOps?.['__all__'] === 'update-all';

  return (
    <div className="versiondock-repo-group" data-first={isFirst ? 'true' : undefined} style={group.root}>
      {multiRepo && (
        <div
          className="versiondock-repo-header"
          style={{ ...group.header, '--repo-color': projectColor } as React.CSSProperties}
          onClick={() => setCollapsed(prev => !prev)}
        >
          <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={{ fontSize: '11px', marginRight: '2px', flexShrink: 0 }} />
          <span style={group.dot(projectColor)} />
          <span style={group.title}>{repo.repoName}</span>
          {hasSubmodules && <span style={group.badge}>{repo.submodules.length}</span>}
          {uninitCount > 0 && (
            <span style={row.statusBadge('amber')} title={t('{0} uninitialized submodules', uninitCount)}>
              {t('{0} uninit', uninitCount)}
            </span>
          )}
          {outOfSyncCount > 0 && (
            <span
              style={{ ...row.statusBadge('neutral'), cursor: isUpdatingAll ? 'default' : 'pointer' }}
              title={t('Align all submodules with parent commits (git submodule update --recursive)')}
              onClick={e => {
                e.stopPropagation();
                if (!isUpdatingAll) onUpdateAll(repo.repoId, true);
              }}
            >
              {isUpdatingAll && <Codicon name="loading~spin" style={{ fontSize: '9px', marginRight: '3px' }} />}
              {t('{0} out of sync', outOfSyncCount)}
            </span>
          )}
          <div style={group.actions}>
            {hasSubmodules && (
              <button
                data-action-btn=""
                disabled={isUpdatingAll}
                style={{
                  ...group.headerBtn,
                  opacity: isUpdatingAll ? 0.6 : (uninitCount > 0 || outOfSyncCount > 0) ? 1 : 0.7,
                }}
                title={t('Align all submodules with parent commits (git submodule update --init --recursive)')}
                onClick={e => {
                  e.stopPropagation();
                  if (!isUpdatingAll) onUpdateAll(repo.repoId, true);
                }}
              >
                <Codicon name={isUpdatingAll ? 'loading~spin' : 'arrow-swap'} style={{ fontSize: '12px' }} />
              </button>
            )}
            <button
              data-action-btn=""
              style={group.headerBtn}
              title={t('Add Submodule to {0}', repo.repoName)}
              onClick={e => { e.stopPropagation(); onAdd(repo.repoId); }}
            >
              <Codicon name="add" style={{ fontSize: '12px' }} />
            </button>
          </div>
        </div>
      )}

      {!collapsed && (
        <div style={group.body}>
          {!hasSubmodules ? (
            <div style={css.empty}>{t('No submodules')}</div>
          ) : (
            repo.submodules.map((sub: SubmoduleItem) => {
              const opKey = `${repo.repoId}:${sub.path}`;
              return (
                <SubmoduleRow
                  key={sub.path}
                  sub={sub}
                  parentRepoId={repo.repoId}
                  isHighlighted={highlightSubmodulePath === sub.path}
                  activeOp={activeOps?.[opKey]}
                  onInit={onInit}
                  onUpdate={onUpdate}
                  onSync={onSync}
                  onDeinit={onDeinit}
                  onRemove={onRemove}
                  onResolveConflict={onResolveConflict}
                  onOpenConflict={onOpenConflict}
                  onOpenInNewWindow={onOpenInNewWindow}
                  onOpenInOS={onOpenInOS}
                  onRevealInExplorer={onRevealInExplorer}
                />
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

export function SubmodulePanel({
  repos,
  loading,
  initialLoaded = true,
  error,
  multiRepo,
  activeOps,
  highlightSubmodulePath,
  onInit,
  onUpdate,
  onUpdateAll,
  onSync,
  onDeinit,
  onRemove,
  onAdd,
  onRefresh: _onRefresh,
  onResolveConflict,
  onOpenConflict,
  onOpenInNewWindow,
  onOpenInOS,
  onRevealInExplorer,
}: SubmodulePanelProps) {
  const isInitialLoading = !initialLoaded && repos.length === 0;

  return (
    <div style={css.container}>
      {error && (
        <div style={css.errorBanner}>
          <Codicon name="error" style={{ marginRight: '6px' }} />
          {error}
        </div>
      )}

      {loading && (
        <div style={css.progressBar}>
          <div style={css.progressIndicator} />
        </div>
      )}

      {isInitialLoading ? (
        <div style={css.empty}>
          <Codicon name="loading" style={{ animation: 'spin 1s linear infinite', marginRight: '6px' }} />
          {t('Loading submodules…')}
        </div>
      ) : repos.length === 0 ? (
        <div style={css.empty}>{t('No repositories with submodules')}</div>
      ) : (
        <div style={css.repoList}>
          {repos.map((repo: RepoSubmodules, idx) => (
            <SubmoduleRepoGroup
              key={repo.repoId}
              isFirst={idx === 0}
              repo={repo}
              multiRepo={multiRepo}
              activeOps={activeOps}
              highlightSubmodulePath={highlightSubmodulePath}
              onInit={onInit}
              onUpdate={onUpdate}
              onUpdateAll={onUpdateAll}
              onSync={onSync}
              onDeinit={onDeinit}
              onRemove={onRemove}
              onAdd={onAdd}
              onResolveConflict={onResolveConflict}
              onOpenConflict={onOpenConflict}
              onOpenInNewWindow={onOpenInNewWindow}
              onOpenInOS={onOpenInOS}
              onRevealInExplorer={onRevealInExplorer}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ── Styles ───────────────────────────────────────────────────────────────────

const css: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
  },
  repoList: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
  },
  empty: {
    padding: '16px 12px',
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center' as const,
  },
  errorState: {
    display: 'flex',
    alignItems: 'center',
    padding: '16px',
    fontSize: '12px',
    color: 'var(--vscode-errorForeground)',
  },
};

const group = {
  root: {
    display: 'flex',
    flexDirection: 'column',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 8px',
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  dot: (clr: string): React.CSSProperties => ({
    width: 8,
    height: 8,
    borderRadius: '50%',
    backgroundColor: clr,
    flexShrink: 0,
  }),
  title: {
    fontSize: '11px',
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginRight: '6px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  badge: {
    fontSize: '10px',
    padding: '1px 5px',
    borderRadius: '10px',
    backgroundColor: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    marginRight: '6px',
    flexShrink: 0,
  } as React.CSSProperties,
  actions: {
    marginLeft: 'auto',
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 0,
  } as React.CSSProperties,
  headerBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '3px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--vscode-descriptionForeground)',
    height: '20px',
    lineHeight: 1,
  } as React.CSSProperties,
  body: {
    display: 'flex',
    flexDirection: 'column',
  } as React.CSSProperties,
};

const row = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    borderBottom: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    padding: '6px 10px',
    cursor: 'default',
    gap: '8px',
    minHeight: '42px',
    boxSizing: 'border-box',
  } as React.CSSProperties,
  info: {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    minWidth: 0,
    gap: '3px',
    overflow: 'hidden',
  } as React.CSSProperties,
  titleLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'nowrap',
    minWidth: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  nameText: {
    fontSize: '12px',
    fontWeight: 600,
    color: 'var(--vscode-foreground)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flexShrink: 1,
    minWidth: 0,
  } as React.CSSProperties,
  aliasText: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    opacity: 0.7,
    whiteSpace: 'nowrap',
    flexShrink: 0,
  } as React.CSSProperties,
  pathText: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    opacity: 0.8,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as React.CSSProperties,
  statusBadge: (tone: string): React.CSSProperties => {
    let bg = 'rgba(128, 128, 128, 0.2)';
    let fg = 'inherit';
    if (tone === 'green') {
      bg = 'rgba(78, 198, 93, 0.15)';
      fg = 'var(--vscode-gitDecoration-untrackedResourceForeground, #4ec65d)';
    } else if (tone === 'amber') {
      bg = 'rgba(204, 167, 0, 0.15)';
      fg = 'var(--vscode-editorWarning-foreground, #cca700)';
    } else if (tone === 'blue') {
      bg = 'rgba(56, 139, 253, 0.15)';
      fg = 'var(--vscode-textLink-foreground, #388bfd)';
    } else if (tone === 'red') {
      bg = 'rgba(248, 81, 73, 0.15)';
      fg = 'var(--vscode-errorForeground, #f85149)';
    } else if (tone === 'purple') {
      bg = 'rgba(163, 113, 247, 0.15)';
      fg = 'var(--vscode-gitDecoration-modifiedResourceForeground, #a371f7)';
    } else if (tone === 'neutral') {
      bg = 'var(--vscode-badge-background, rgba(128, 128, 128, 0.18))';
      fg = 'var(--vscode-badge-foreground, var(--vscode-descriptionForeground))';
    }
    return {
      fontSize: '9.5px',
      padding: '0 4px',
      borderRadius: '3px',
      backgroundColor: bg,
      color: fg,
      fontWeight: 500,
      whiteSpace: 'nowrap',
      flexShrink: 0,
    };
  },
  metaLine: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '10.5px',
    color: 'var(--vscode-descriptionForeground)',
    flexWrap: 'nowrap',
    minWidth: 0,
    overflow: 'hidden',
  } as React.CSSProperties,
  branchBadge: (clr?: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    color: clr ?? 'inherit',
    fontWeight: 500,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  }),
  branchName: {
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  trackingBranch: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    opacity: 0.85,
    flexShrink: 0,
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  urlText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    opacity: 0.6,
    flex: 1,
    minWidth: 0,
  } as React.CSSProperties,
  actions: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    marginLeft: 'auto',
    flexShrink: 0,
    whiteSpace: 'nowrap',
  } as React.CSSProperties,
  primaryBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    height: '22px',
    padding: '0 10px',
    backgroundColor: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 500,
    lineHeight: 1,
    flexShrink: 0,
    boxSizing: 'border-box',
    userSelect: 'none',
  } as React.CSSProperties,
  secondaryBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '2px 8px',
    backgroundColor: 'var(--vscode-button-secondaryBackground, rgba(128, 128, 128, 0.18))',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: 'none',
    borderRadius: '3px',
    cursor: 'pointer',
    fontSize: '11px',
    fontWeight: 500,
    lineHeight: '16px',
    flexShrink: 0,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  iconBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3px',
    backgroundColor: 'transparent',
    color: 'inherit',
    border: 'none',
    borderRadius: '2px',
    cursor: 'pointer',
    opacity: 0.8,
  } as React.CSSProperties,
  linkBtn: {
    backgroundColor: 'transparent',
    color: 'var(--vscode-textLink-foreground)',
    border: 'none',
    cursor: 'pointer',
    padding: 0,
    fontSize: '12px',
    textDecoration: 'underline',
  } as React.CSSProperties,
  loadingText: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
};
