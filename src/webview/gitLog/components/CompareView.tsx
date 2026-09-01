import React, { useLayoutEffect, useRef, useState } from 'react';
import type { CommitNode, RepoMeta } from '../../shared/types';
import type { CommitSelectionMode, ComparePaneState, CompareSide, CompareState } from '../store/logStore';
import { CommitList } from './CommitList';
import type { LaidOutCommit } from '../utils/graphLayout';
import { Codicon } from '../../shared/Codicon';
import { t } from '../../shared/i18n';
import { readableAccentColor } from '../../shared/branchColors';
import {
  AuthorPicker,
  ClearFiltersButton,
  DateRangePicker,
  DebouncedInput,
  FILTER_INPUT_STYLE,
  type AuthorOption,
} from './CommitFiltersBar';

interface Props {
  compareState: CompareState;
  repoColors: Record<string, string>;
  repos: RepoMeta[];
  authorOptions: AuthorOption[];
  currentBranchByRepo: Record<string, string>;
  remoteNamesByRepo: Readonly<Record<string, readonly string[]>>;
  baseCommits: LaidOutCommit[];
  targetCommits: LaidOutCommit[];
  selectedHashes: string[];
  primarySelectedHash: string | null;
  onSelectCommit: (side: CompareSide, commit: CommitNode, mode: CommitSelectionMode) => void;
  onLoadMore: (side: CompareSide) => void;
  onFilterChange: (side: CompareSide, partial: Partial<ComparePaneState>) => void;
  onClose: () => void;
}

const INTERACTION_STYLE = `
[data-compare-close-btn]:hover {
  background: var(--vscode-toolbar-hoverBackground) !important;
  opacity: 1 !important;
}
`;

function formatRefLabel(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes|tags)\//, '');
}

export function CompareView({
  compareState,
  repoColors,
  repos,
  authorOptions,
  currentBranchByRepo,
  remoteNamesByRepo,
  baseCommits,
  targetCommits,
  selectedHashes,
  primarySelectedHash,
  onSelectCommit,
  onLoadMore,
  onFilterChange,
  onClose,
}: Props) {
  const [topPaneHeight, setTopPaneHeight] = useState<number | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const repoColor = readableAccentColor(repoColors[compareState.repoId] ?? repos.find(repo => repo.id === compareState.repoId)?.color ?? '#888');
  const baseLabel = formatRefLabel(compareState.baseRef);
  const targetLabel = formatRefLabel(compareState.targetRef);

  useLayoutEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;

    const clampHeight = (height: number, stackHeight: number) => {
      const minHeight = Math.min(160, Math.max(96, Math.floor((stackHeight - 4) / 3)));
      const maxHeight = Math.max(minHeight, stackHeight - 4 - minHeight);
      return Math.min(maxHeight, Math.max(minHeight, height));
    };

    const updateHeight = () => {
      const stackHeight = stack.getBoundingClientRect().height;
      if (stackHeight <= 0) return;
      setTopPaneHeight(current => clampHeight(current ?? Math.floor((stackHeight - 4) / 2), stackHeight));
    };

    updateHeight();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(stack);
    return () => observer.disconnect();
  }, []);

  const handleSplitterMouseDown = (event: React.MouseEvent) => {
    event.preventDefault();
    const rect = stackRef.current?.getBoundingClientRect();
    if (!rect) return;

    const onMove = (moveEvent: MouseEvent) => {
      const minHeight = Math.min(160, Math.max(96, Math.floor((rect.height - 4) / 3)));
      const maxHeight = Math.max(minHeight, rect.height - 4 - minHeight);
      const nextHeight = moveEvent.clientY - rect.top;
      setTopPaneHeight(Math.min(maxHeight, Math.max(minHeight, nextHeight)));
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
  };

  return (
    <div style={styles.container}>
      <style>{INTERACTION_STYLE}</style>
      <div style={styles.header}>
        <span style={styles.headerLabel}>{t('Compare')}</span>
        <span style={styles.headerRepoBadge} title={compareState.repoName}>
          <span style={styles.headerRepoDot(repoColor)} />
          <span style={styles.headerRepoName}>{compareState.repoName}</span>
        </span>
        <span style={styles.headerTitle}>{t('{0} vs {1}', baseLabel, targetLabel)}</span>
        <button data-compare-close-btn="" style={styles.closeButton} onClick={onClose} title={t('Close Compare')}>
          <Codicon name="close" style={{ fontSize: '14px' }} />
        </button>
      </div>

      <div ref={stackRef} style={styles.stack}>
        <div style={styles.topPaneSlot(topPaneHeight)}>
          <ComparePane
            pane={compareState.targetOnly}
            title={t('Exists in {0} but not in {1}', targetLabel, baseLabel)}
            emptyText={t('{0} contains all commits from {1}', baseLabel, targetLabel)}
            commits={targetCommits}
            selectedHashes={selectedHashes}
            primarySelectedHash={primarySelectedHash}
            repos={repos}
            authorOptions={authorOptions}
            currentBranchByRepo={currentBranchByRepo}
            remoteNamesByRepo={remoteNamesByRepo}
            onSelect={(commit, mode) => onSelectCommit('targetOnly', commit, mode)}
            onLoadMore={() => onLoadMore('targetOnly')}
            onFilterChange={(partial) => onFilterChange('targetOnly', partial)}
          />
        </div>
        <div
          style={styles.splitter}
          onMouseDown={handleSplitterMouseDown}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundImage = 'linear-gradient(to bottom, transparent 1px, var(--vscode-focusBorder) 1px, var(--vscode-focusBorder) 2px, transparent 2px)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundImage = 'linear-gradient(to bottom, transparent 1px, var(--vscode-panel-border) 1px, var(--vscode-panel-border) 2px, transparent 2px)'; }}
        />
        <div style={styles.bottomPaneSlot}>
          <ComparePane
            pane={compareState.baseOnly}
            title={t('Exists in {0} but not in {1}', baseLabel, targetLabel)}
            emptyText={t('{0} contains all commits from {1}', targetLabel, baseLabel)}
            commits={baseCommits}
            selectedHashes={selectedHashes}
            primarySelectedHash={primarySelectedHash}
            repos={repos}
            authorOptions={authorOptions}
            currentBranchByRepo={currentBranchByRepo}
            remoteNamesByRepo={remoteNamesByRepo}
            onSelect={(commit, mode) => onSelectCommit('baseOnly', commit, mode)}
            onLoadMore={() => onLoadMore('baseOnly')}
            onFilterChange={(partial) => onFilterChange('baseOnly', partial)}
          />
        </div>
      </div>
    </div>
  );
}

function ComparePane({
  pane,
  title,
  emptyText,
  commits,
  selectedHashes,
  primarySelectedHash,
  repos,
  authorOptions,
  currentBranchByRepo,
  remoteNamesByRepo,
  onSelect,
  onLoadMore,
  onFilterChange,
}: {
  pane: ComparePaneState;
  title: string;
  emptyText: string;
  commits: LaidOutCommit[];
  selectedHashes: string[];
  primarySelectedHash: string | null;
  repos: RepoMeta[];
  authorOptions: AuthorOption[];
  currentBranchByRepo: Record<string, string>;
  remoteNamesByRepo: Readonly<Record<string, readonly string[]>>;
  onSelect: (commit: LaidOutCommit, mode: CommitSelectionMode) => void;
  onLoadMore: () => void;
  onFilterChange: (partial: Partial<ComparePaneState>) => void;
}) {
  const hasFilters = !!(
    pane.filterText
    || pane.filterAuthor
    || pane.filterBranch
    || pane.filterDateFrom
    || pane.filterDateTo
    || pane.filterPath
  );

  return (
    <div style={styles.pane}>
      <div style={styles.toolbar}>
        <style>{FILTER_INPUT_STYLE}</style>
        <DebouncedInput
          icon="search"
          placeholder={t('Search commits…')}
          value={pane.filterText}
          onChange={(value) => onFilterChange({ filterText: value })}
          debounceMs={250}
          style={styles.textFilter}
        />
        <AuthorPicker
          value={pane.filterAuthor}
          options={authorOptions}
          onChange={(value) => onFilterChange({ filterAuthor: value })}
          style={styles.authorFilter}
        />
        <DateRangePicker
          from={pane.filterDateFrom}
          to={pane.filterDateTo}
          onFromChange={(value) => onFilterChange({ filterDateFrom: value })}
          onToChange={(value) => onFilterChange({ filterDateTo: value })}
          style={styles.dateFilter}
        />
        {hasFilters && (
          <ClearFiltersButton onClick={() => onFilterChange({
            filterText: '',
            filterAuthor: '',
            filterBranch: '',
            filterDateFrom: '',
            filterDateTo: '',
            filterPath: '',
          })} />
        )}
      </div>

      <div style={styles.notice} title={title}>{title}</div>

      <div style={styles.listWrap}>
        {pane.loading && commits.length === 0 ? (
          <div style={styles.empty}>{t('Loading...')}</div>
        ) : commits.length === 0 ? (
          <div style={styles.empty}>{emptyText}</div>
        ) : (
          <CommitList
            commits={commits}
            selectedHashes={selectedHashes}
            primarySelectedHash={primarySelectedHash}
            repos={repos}
            currentBranchByRepo={currentBranchByRepo}
            headHashByRepo={{}}
            remoteNamesByRepo={remoteNamesByRepo}
            onSelect={onSelect}
            onLoadMore={onLoadMore}
            hasMore={pane.hasMore}
            storeHasMore={pane.hasMore}
            loading={pane.loading}
            backgroundLoading={false}
          />
        )}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: '30px',
    padding: '0 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
    flexShrink: 0,
    fontSize: '12px',
  } as React.CSSProperties,
  headerLabel: {
    color: 'var(--vscode-descriptionForeground)',
    flexShrink: 0,
  },
  headerTitle: {
    fontWeight: 600,
    minWidth: 0,
  },
  headerRepoBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '5px',
    minWidth: 0,
    maxWidth: '180px',
    flexShrink: 1,
  } as React.CSSProperties,
  headerRepoDot: (color: string): React.CSSProperties => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  headerRepoName: {
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    fontSize: '10px',
    color: 'var(--vscode-sideBarSectionHeader-foreground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  closeButton: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '22px',
    height: '22px',
    border: 'none',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    borderRadius: '3px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  stack: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    background: 'var(--vscode-editor-background)',
  },
  topPaneSlot: (height: number | null): React.CSSProperties => ({
    display: 'flex',
    flexDirection: 'column',
    flex: height == null ? '1 1 0' : `0 0 ${height}px`,
    minHeight: 0,
    overflow: 'hidden',
  }),
  bottomPaneSlot: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
  },
  splitter: {
    height: '4px',
    flexShrink: 0,
    cursor: 'row-resize',
    background: 'transparent',
    backgroundImage: 'linear-gradient(to bottom, transparent 1px, var(--vscode-panel-border) 1px, var(--vscode-panel-border) 2px, transparent 2px)',
    backgroundRepeat: 'no-repeat',
    transition: 'background 0.15s',
  },
  pane: {
    display: 'flex',
    flexDirection: 'column' as const,
    flex: 1,
    minHeight: 0,
    background: 'var(--vscode-editor-background)',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    flexWrap: 'nowrap' as const,
    minHeight: '32px',
    padding: '4px 8px',
    flexShrink: 0,
    overflow: 'hidden',
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
    position: 'relative' as const,
    zIndex: 20,
  } as React.CSSProperties,
  textFilter: {
    flex: '0 1 280px',
    width: '280px',
    minWidth: '140px',
  } as React.CSSProperties,
  authorFilter: {
    flex: '0 1 220px',
    width: '220px',
    minWidth: '120px',
  } as React.CSSProperties,
  dateFilter: {
    flex: '0 1 215px',
    width: '215px',
    minWidth: '190px',
    maxWidth: '225px',
  } as React.CSSProperties,
  notice: {
    padding: '5px 8px',
    fontSize: '12px',
    color: 'var(--vscode-editorWarning-foreground, #cca700)',
    background: 'color-mix(in srgb, var(--vscode-editorWarning-background, #cca700) 18%, transparent)',
    borderTop: '1px solid var(--vscode-panel-border)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    flexShrink: 0,
  },
  listWrap: {
    position: 'relative' as const,
    display: 'flex',
    flexDirection: 'column' as const,
    flex: '1 1 0',
    height: 0,
    minHeight: 0,
    minWidth: 0,
    overflow: 'hidden',
  },
  empty: {
    position: 'absolute' as const,
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    textAlign: 'center' as const,
    padding: '16px',
    color: 'var(--vscode-descriptionForeground)',
    fontSize: '12px',
  },
};
