import React, { useMemo, useState } from 'react';
import type { RepoMeta } from '../../shared/types';
import type { SubtreeEntry, SubtreeOp, SubtreePushStatus } from '../../shared/msgTypes';
import { Codicon } from '../../shared/Codicon';
import { ContextMenu, type ContextMenuEntry } from './ContextMenu';
import { t } from '../../shared/i18n';
import { branchColor, readableAccentColor } from '../../shared/branchColors';

interface Props {
  entries: SubtreeEntry[];
  repoMetas: RepoMeta[];
  loading: boolean;
  activeOps: Record<string, SubtreeOp | undefined>;
  statuses: Record<string, SubtreePushStatus | undefined>;
  error: string | null;
  multiRepo: boolean;
  onAdd: (repoId?: string) => void;
  onRegister: (repoId?: string) => void;
  onPull: (entryId: string) => void;
  onPush: (entryId: string) => void;
  onSplit: (entryId: string) => void;
  onMerge: (entryId: string) => void;
  onRemove: (entryId: string) => void;
  onEdit: (entryId: string) => void;
  onDeleteRegistry: (entryId: string) => void;
  onReveal: (entryId: string) => void;
}

const ROW_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'pull', label: t('Pull Subtree'), icon: 'cloud-download' },
  { id: 'push', label: t('Push Subtree'), icon: 'cloud-upload' },
  { id: 'split', label: t('Split Subtree'), icon: 'git-branch' },
  { id: 'merge', label: t('Merge Subtree'), icon: 'git-merge' },
  { separator: true },
  { id: 'reveal', label: t('Reveal Prefix'), icon: 'folder-opened' },
  { id: 'edit', label: t('Edit Registry'), icon: 'edit' },
  { id: 'delete-registry', label: t('Delete Registry'), icon: 'trash' },
  { separator: true },
  { id: 'remove', label: t('Remove Subtree Files'), icon: 'trash', danger: true },
];

function subtreeOpLabel(op: SubtreeOp | undefined): string | null {
  if (op === 'pull') return t('Pulling...');
  if (op === 'push') return t('Pushing...');
  if (op === 'split') return t('Splitting...');
  if (op === 'merge') return t('Merging...');
  if (op === 'remove') return t('Removing...');
  if (op === 'delete') return t('Deleting...');
  return null;
}

function subtreeStatusLabel(status: SubtreePushStatus | undefined): string {
  if (!status || status.loading) return t('Checking...');
  if (status.error && status.hasUpdates) return t('Updates');
  if (status.error) return t('Status unavailable');
  if (status.aheadCount && status.aheadCount > 0) return t('{0} to push', status.aheadCount);
  if (status.hasUpdates) return t('Updates');
  return t('Up to date');
}

function subtreeStatusTone(status: SubtreePushStatus | undefined): 'loading' | 'updated' | 'clean' | 'error' {
  if (!status || status.loading) return 'loading';
  if (status.error && !status.hasUpdates) return 'error';
  if (status.hasUpdates || (status.aheadCount ?? 0) > 0) return 'updated';
  return 'clean';
}

function repoStatusSummary(entries: SubtreeEntry[], statuses: Record<string, SubtreePushStatus | undefined>): string | null {
  let loading = false;
  let hasUnknownUpdates = false;
  let totalAhead = 0;
  for (const entry of entries) {
    const status = statuses[entry.id];
    if (!status || status.loading) {
      loading = true;
      continue;
    }
    if (status.aheadCount && status.aheadCount > 0) {
      totalAhead += status.aheadCount;
      continue;
    }
    if (status.hasUpdates) hasUnknownUpdates = true;
  }
  if (totalAhead > 0) return t('{0} to push', totalAhead);
  if (hasUnknownUpdates) return t('Updates');
  if (loading) return t('Checking...');
  return null;
}

function SubtreeRow({ entry, repoColor, activeOp, status, onPull, onPush, onSplit, onMerge, onRemove, onEdit, onDeleteRegistry, onReveal }: {
  entry: SubtreeEntry;
  repoColor: string;
  activeOp?: SubtreeOp;
  status?: SubtreePushStatus;
  onPull: (entryId: string) => void;
  onPush: (entryId: string) => void;
  onSplit: (entryId: string) => void;
  onMerge: (entryId: string) => void;
  onRemove: (entryId: string) => void;
  onEdit: (entryId: string) => void;
  onDeleteRegistry: (entryId: string) => void;
  onReveal: (entryId: string) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const activeLabel = subtreeOpLabel(activeOp);
  const disabled = Boolean(activeOp);
  const statusLabel = subtreeStatusLabel(status);
  const statusTone = subtreeStatusTone(status);
  const projectColor = readableAccentColor(repoColor);

  const runAction = (id: string) => {
    if (disabled) return;
    if (id === 'pull') onPull(entry.id);
    if (id === 'push') onPush(entry.id);
    if (id === 'split') onSplit(entry.id);
    if (id === 'merge') onMerge(entry.id);
    if (id === 'remove') onRemove(entry.id);
    if (id === 'edit') onEdit(entry.id);
    if (id === 'delete-registry') onDeleteRegistry(entry.id);
    if (id === 'reveal') onReveal(entry.id);
  };

  return (
    <div style={row.root} data-row-divider="">
      <div
        className="versiondock-list-row"
        data-list-row=""
        style={{ ...row.header, background: hovered ? 'var(--vscode-list-hoverBackground)' : 'transparent' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onContextMenu={e => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}
      >
        <Codicon name="repo" style={{ fontSize: '13px', color: projectColor, flexShrink: 0, marginTop: '2px' }} />
        <div style={row.info}>
          <div style={row.titleLine}>
            <span style={row.name}>{entry.name}</span>
            <span style={row.badge}>{entry.defaultSquash ? t('squash') : t('full history')}</span>
            {entry.lastSplitBranch && (
              <span style={row.branchBadge(branchColor(entry.lastSplitBranch))} title={entry.lastSplitBranch}>
                <Codicon name="git-branch" style={{ fontSize: '10px', flexShrink: 0 }} />
                <span style={row.branchBadgeLabel}>{entry.lastSplitBranch}</span>
              </span>
            )}
            <span style={row.statusBadge(statusTone)} title={status?.error ?? statusLabel}>{statusLabel}</span>
          </div>
          <div style={row.pathLine} title={entry.prefix}>
            <Codicon name="folder" style={row.metaIcon} />
            <span style={row.prefix}>{entry.prefix}</span>
          </div>
          <div style={row.remoteLine}>
            <Codicon name="link" style={row.metaIcon} />
            <span style={row.repository} title={entry.repository}>{entry.repository}</span>
            <span style={row.ref} title={entry.ref}>{entry.ref}</span>
          </div>
        </div>
        <div style={{ ...row.actions }}>
          {activeLabel ? (
            <span style={row.busyBadge} title={activeLabel}>
              <Codicon name="sync" style={{ fontSize: '11px' }} />
              <span>{activeLabel}</span>
            </span>
          ) : (
            <>
              <button data-action-btn="" style={row.btn} title={t('Pull Subtree')} disabled={disabled} onClick={e => { e.stopPropagation(); onPull(entry.id); }}>
                <Codicon name="cloud-download" />
              </button>
              <button data-action-btn="" style={row.btn} title={t('More')} disabled={disabled} onClick={e => { e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY }); }}>
                <Codicon name="ellipsis" />
              </button>
            </>
          )}
        </div>
      </div>
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ROW_CONTEXT_ITEMS}
          onSelect={runAction}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

function RepoSection({ meta, entries, activeOps, statuses, multiRepo, onAdd, onRegister, onPull, onPush, onSplit, onMerge, onRemove, onEdit, onDeleteRegistry, onReveal, isFirst = false }: {
  meta: RepoMeta;
  entries: SubtreeEntry[];
  activeOps: Record<string, SubtreeOp | undefined>;
  statuses: Record<string, SubtreePushStatus | undefined>;
  multiRepo: boolean;
  onAdd: (repoId?: string) => void;
  onRegister: (repoId?: string) => void;
  onPull: (entryId: string) => void;
  onPush: (entryId: string) => void;
  onSplit: (entryId: string) => void;
  onMerge: (entryId: string) => void;
  onRemove: (entryId: string) => void;
  onEdit: (entryId: string) => void;
  onDeleteRegistry: (entryId: string) => void;
  onReveal: (entryId: string) => void;
  isFirst?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const summary = repoStatusSummary(entries, statuses);

  return (
    <div className="versiondock-repo-group" data-first={isFirst ? 'true' : undefined} style={css.repoSection}>
      {multiRepo && (
        <div
          className="versiondock-repo-header"
          style={{ ...css.repoHeader, '--repo-color': meta.color } as React.CSSProperties}
          onClick={() => setCollapsed(v => !v)}
        >
          <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={{ fontSize: '11px', flexShrink: 0 }} />
          <span style={css.dot(meta.color)} />
          <span style={css.repoName}>{meta.name}</span>
          {summary && <span style={css.repoStatus}>{summary}</span>}
          <div style={css.headerActions}>
            <button
              data-action-btn=""
              style={css.headerBtn}
              title={t('Add Subtree from Repository')}
              onClick={e => { e.stopPropagation(); onAdd(meta.id); }}
            >
              <Codicon name="add" style={{ fontSize: '12px' }} />
            </button>
            <button
              data-action-btn=""
              style={css.headerBtn}
              title={t('Register Existing Directory')}
              onClick={e => { e.stopPropagation(); onRegister(meta.id); }}
            >
              <Codicon name="list-tree" style={{ fontSize: '12px' }} />
            </button>
          </div>
        </div>
      )}
      {!collapsed && (
        entries.length === 0 ? (
          <div style={css.empty}>{t('No subtrees registered')}</div>
        ) : (
          entries.map(entry => (
            <SubtreeRow
              key={entry.id}
              entry={entry}
              repoColor={meta.color}
              activeOp={activeOps[entry.id]}
              status={statuses[entry.id]}
              onPull={onPull}
              onPush={onPush}
              onSplit={onSplit}
              onMerge={onMerge}
              onRemove={onRemove}
              onEdit={onEdit}
              onDeleteRegistry={onDeleteRegistry}
              onReveal={onReveal}
            />
          ))
        )
      )}
      {!multiRepo && (
        <div style={css.singleRepoActions}>
          <button data-secondary-action-btn="" style={css.actionBtn} onClick={() => onAdd(meta.id)}>
            <Codicon name="add" style={{ marginRight: '4px', fontSize: '12px' }} />
            {t('Add Subtree')}
          </button>
          <button data-secondary-action-btn="" style={css.actionBtn} onClick={() => onRegister(meta.id)}>
            <Codicon name="list-tree" style={{ marginRight: '4px', fontSize: '12px' }} />
            {t('Register Existing')}
          </button>
        </div>
      )}
    </div>
  );
}

export function SubtreePanel({
  entries,
  repoMetas,
  loading,
  activeOps,
  statuses,
  error,
  multiRepo,
  onAdd,
  onRegister,
  onPull,
  onPush,
  onSplit,
  onMerge,
  onRemove,
  onEdit,
  onDeleteRegistry,
  onReveal,
}: Props) {
  const grouped = useMemo(() => {
    const byRepo = new Map<string, SubtreeEntry[]>();
    for (const entry of entries) {
      if (!byRepo.has(entry.repoId)) byRepo.set(entry.repoId, []);
      byRepo.get(entry.repoId)!.push(entry);
    }
    return repoMetas.map(meta => ({
      meta,
      entries: (byRepo.get(meta.id) ?? []).sort((left, right) => left.prefix.localeCompare(right.prefix)),
    }));
  }, [entries, repoMetas]);

  if (loading && entries.length === 0) return <div style={css.empty}>{t('Loading...')}</div>;
  if (error) return (
    <div style={css.errorRow}>
      <Codicon name="warning" style={{ marginRight: '4px', flexShrink: 0 }} />
      {error}
    </div>
  );

  if (grouped.length === 0) {
    return <div style={css.empty}>{t('No Git repositories found in this workspace.')}</div>;
  }

  return (
    <div style={css.root}>
      {grouped.map((group, idx) => (
        <RepoSection
          key={group.meta.id}
          isFirst={idx === 0}
          meta={group.meta}
          entries={group.entries}
          activeOps={activeOps}
          statuses={statuses}
          multiRepo={multiRepo}
          onAdd={onAdd}
          onRegister={onRegister}
          onPull={onPull}
          onPush={onPush}
          onSplit={onSplit}
          onMerge={onMerge}
          onRemove={onRemove}
          onEdit={onEdit}
          onDeleteRegistry={onDeleteRegistry}
          onReveal={onReveal}
        />
      ))}
    </div>
  );
}

const css = {
  root: { display: 'flex', flexDirection: 'column' as const },
  repoSection: {} as React.CSSProperties,
  repoHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '0 8px',
    boxSizing: 'border-box' as const,
    cursor: 'pointer',
    userSelect: 'none' as const,
  } as React.CSSProperties,
  dot: (color: string): React.CSSProperties => ({ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }),
  repoName: { fontSize: '11px', fontWeight: 'bold' as const, textTransform: 'uppercase' as const, letterSpacing: '0.05em', flex: 1 },
  repoStatus: {
    flexShrink: 0,
    maxWidth: '92px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    padding: '1px 5px',
    borderRadius: '3px',
    fontSize: '10px',
    color: 'var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow))',
    background: 'color-mix(in srgb, var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow)) 16%, transparent)',
  } as React.CSSProperties,
  headerActions: { marginLeft: 'auto', display: 'flex', gap: '2px' },
  headerBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: '2px 4px',
    borderRadius: '3px',
    display: 'flex',
    alignItems: 'center',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  singleRepoActions: {
    display: 'flex',
    gap: '4px',
    padding: '6px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
  } as React.CSSProperties,
  actionBtn: {
    display: 'flex',
    alignItems: 'center',
    fontSize: '11px',
    background: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '3px',
    padding: '3px 8px',
    cursor: 'pointer',
  } as React.CSSProperties,
  empty: { padding: '16px 12px', fontSize: '12px', color: 'var(--vscode-descriptionForeground)', textAlign: 'center' as const },
  errorRow: {
    display: 'flex',
    alignItems: 'flex-start',
    padding: '4px 8px',
    fontSize: '11px',
    color: 'var(--vscode-errorForeground)',
    background: 'var(--vscode-inputValidation-errorBackground)',
  } as React.CSSProperties,
};

const row = {
  root: { borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 50%, transparent)' } as React.CSSProperties,
  header: {
    display: 'grid',
    gridTemplateColumns: '16px minmax(0, 1fr) auto',
    alignItems: 'start',
    gap: '6px',
    padding: '6px 8px 7px',
    cursor: 'default',
    minHeight: '58px',
    boxSizing: 'border-box',
  } as React.CSSProperties,
  info: { display: 'flex', flexDirection: 'column' as const, minWidth: 0, gap: '3px' },
  titleLine: { display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0 } as React.CSSProperties,
  name: { fontSize: '12px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 },
  badge: {
    fontSize: '9px',
    padding: '1px 5px',
    borderRadius: '3px',
    background: 'var(--versiondock-badge-background)',
    color: 'var(--versiondock-badge-foreground)',
    flexShrink: 0,
  } as React.CSSProperties,
  branchBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '10px',
    fontWeight: 600,
    padding: '1px 5px',
    borderRadius: '3px',
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    flexShrink: 1,
    minWidth: 0,
    maxWidth: '160px',
    overflow: 'hidden',
  }),
  branchBadgeLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 } as React.CSSProperties,
  statusBadge: (tone: 'loading' | 'updated' | 'clean' | 'error'): React.CSSProperties => {
    const color = tone === 'updated'
      ? 'var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow))'
      : tone === 'clean'
        ? 'var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green))'
        : tone === 'error'
          ? 'var(--vscode-errorForeground)'
          : 'var(--vscode-descriptionForeground)';
    return {
      flexShrink: 0,
      maxWidth: '86px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      padding: '1px 5px',
      borderRadius: '3px',
      fontSize: '10px',
      lineHeight: '14px',
      color,
      border: `1px solid color-mix(in srgb, ${color} 38%, transparent)`,
      background: `color-mix(in srgb, ${color} 12%, transparent)`,
    };
  },
  pathLine: { display: 'flex', alignItems: 'center', gap: '4px', minWidth: 0, fontSize: '11px', color: 'var(--vscode-descriptionForeground)' } as React.CSSProperties,
  remoteLine: { display: 'flex', alignItems: 'center', gap: '5px', minWidth: 0, fontSize: '11px', color: 'var(--vscode-descriptionForeground)' } as React.CSSProperties,
  metaIcon: { fontSize: '11px', flexShrink: 0 } as React.CSSProperties,
  prefix: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0 },
  repository: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, minWidth: 0, flex: 1 },
  ref: {
    flexShrink: 0,
    maxWidth: '96px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    padding: '0 4px',
    border: '1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent)',
    borderRadius: '3px',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  actions: { display: 'flex', alignItems: 'center', gap: '1px', flexShrink: 0, transition: 'opacity 0.12s ease', marginTop: '-1px' },
  btn: {
    background: 'transparent',
    border: 'none',
    width: '20px',
    height: '20px',
    padding: '0',
    cursor: 'pointer',
    color: 'var(--vscode-descriptionForeground)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '3px',
  } as React.CSSProperties,
  busyBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    minWidth: 0,
    maxWidth: '92px',
    padding: '2px 5px',
    borderRadius: '3px',
    fontSize: '10px',
    lineHeight: '14px',
    color: 'var(--vscode-progressBar-background)',
    background: 'color-mix(in srgb, var(--vscode-progressBar-background) 16%, transparent)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } as React.CSSProperties,
};
