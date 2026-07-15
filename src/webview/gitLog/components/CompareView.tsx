import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CommitNode, RepoMeta } from '../../shared/types';
import type { CommitSelectionMode, ComparePaneState, CompareSide, CompareState } from '../store/logStore';
import { CommitList } from './CommitList';
import type { LaidOutCommit } from '../utils/graphLayout';
import { Codicon } from '../../shared/Codicon';
import { t } from '../../shared/i18n';

interface Props {
  compareState: CompareState;
  repoColors: Record<string, string>;
  repos: RepoMeta[];
  currentBranchByRepo: Record<string, string>;
  baseCommits: LaidOutCommit[];
  targetCommits: LaidOutCommit[];
  selectedHashes: string[];
  primarySelectedHash: string | null;
  onSelectCommit: (side: CompareSide, commit: CommitNode, mode: CommitSelectionMode) => void;
  onLoadMore: (side: CompareSide) => void;
  onFilterChange: (side: CompareSide, partial: Partial<ComparePaneState>) => void;
  onClose: () => void;
}

export function CompareView({
  compareState,
  repoColors,
  repos,
  currentBranchByRepo,
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
  const repoColor = repoColors[compareState.repoId] ?? repos.find(repo => repo.id === compareState.repoId)?.color ?? '#888';

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
      <div style={styles.header}>
        <span style={styles.headerLabel}>{t('Compare')}</span>
        <span style={styles.headerRepoBadge} title={compareState.repoName}>
          <span style={styles.headerRepoDot(repoColor)} />
          <span style={styles.headerRepoName}>{compareState.repoName}</span>
        </span>
        <span style={styles.headerTitle}>{t('{0} vs {1}', compareState.baseRef, compareState.targetRef)}</span>
        <button style={styles.closeButton} onClick={onClose} title={t('Close Compare')}>
          <Codicon name="close" style={{ fontSize: '14px' }} />
        </button>
      </div>

      <div ref={stackRef} style={styles.stack}>
        <div style={styles.topPaneSlot(topPaneHeight)}>
          <ComparePane
            pane={compareState.targetOnly}
            title={t('Exists in {0} but not in {1}', compareState.targetRef, compareState.baseRef)}
            emptyText={t('{0} contains all commits from {1}', compareState.baseRef, compareState.targetRef)}
            commits={targetCommits}
            selectedHashes={selectedHashes}
            primarySelectedHash={primarySelectedHash}
            repos={repos}
            currentBranchByRepo={currentBranchByRepo}
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
            title={t('Exists in {0} but not in {1}', compareState.baseRef, compareState.targetRef)}
            emptyText={t('{0} contains all commits from {1}', compareState.targetRef, compareState.baseRef)}
            commits={baseCommits}
            selectedHashes={selectedHashes}
            primarySelectedHash={primarySelectedHash}
            repos={repos}
            currentBranchByRepo={currentBranchByRepo}
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
  currentBranchByRepo,
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
  currentBranchByRepo: Record<string, string>;
  onSelect: (commit: LaidOutCommit, mode: CommitSelectionMode) => void;
  onLoadMore: () => void;
  onFilterChange: (partial: Partial<ComparePaneState>) => void;
}) {
  const [draft, setDraft] = useState({
    filterText: pane.filterText,
    filterAuthor: pane.filterAuthor,
    filterDateFrom: pane.filterDateFrom,
    filterDateTo: pane.filterDateTo,
  });
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setDraft({
      filterText: pane.filterText,
      filterAuthor: pane.filterAuthor,
      filterDateFrom: pane.filterDateFrom,
      filterDateTo: pane.filterDateTo,
    });
  }, [pane.filterAuthor, pane.filterDateFrom, pane.filterDateTo, pane.filterText]);

  const updateDraft = (partial: Partial<typeof draft>) => {
    const next = { ...draft, ...partial };
    setDraft(next);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onFilterChange(next), 250);
  };

  return (
    <div style={styles.pane}>
      <div style={styles.toolbar}>
        <FilterInput
          icon="search"
          width={180}
          placeholder={t('Search commits…')}
          value={draft.filterText}
          onChange={(value) => updateDraft({ filterText: value })}
        />
        <FilterInput
          icon="person"
          width={150}
          placeholder={t('Author…')}
          value={draft.filterAuthor}
          onChange={(value) => updateDraft({ filterAuthor: value })}
        />
        <DateRangeFilter
          from={draft.filterDateFrom}
          to={draft.filterDateTo}
          onFromChange={(value) => updateDraft({ filterDateFrom: value })}
          onToChange={(value) => updateDraft({ filterDateTo: value })}
        />
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

function FilterInput({
  icon,
  width,
  placeholder,
  value,
  onChange,
}: {
  icon: string;
  width: number;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div style={{ ...styles.fieldWrap, width }}>
      <Codicon name={icon} style={styles.fieldIcon} />
      <input
        style={styles.fieldInput}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      {value && (
        <button style={styles.fieldClear} onClick={() => onChange('')} tabIndex={-1}>
          <Codicon name="close" style={{ fontSize: '10px' }} />
        </button>
      )}
    </div>
  );
}

function DateRangeFilter({
  from,
  to,
  onFromChange,
  onToChange,
}: {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
}) {
  return (
    <div style={styles.dateRange}>
      <Codicon name="calendar" style={styles.fieldIcon} />
      <input
        style={styles.dateInput}
        placeholder={t('From YYYY-MM-DD')}
        value={from}
        onChange={(event) => onFromChange(event.target.value)}
      />
      <span style={styles.dateSep}>→</span>
      <input
        style={styles.dateInput}
        placeholder={t('To YYYY-MM-DD')}
        value={to}
        onChange={(event) => onToChange(event.target.value)}
      />
      {(from || to) && (
        <button style={styles.fieldClear} onClick={() => { onFromChange(''); onToChange(''); }} tabIndex={-1}>
          <Codicon name="close" style={{ fontSize: '10px' }} />
        </button>
      )}
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
    flexWrap: 'wrap' as const,
    minHeight: '32px',
    padding: '4px 8px',
    flexShrink: 0,
    borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)',
  } as React.CSSProperties,
  fieldWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    padding: '0 6px',
    height: '26px',
    boxSizing: 'border-box' as const,
  },
  fieldIcon: {
    fontSize: '13px',
    opacity: 0.45,
    flexShrink: 0,
    lineHeight: 1,
  } as React.CSSProperties,
  fieldInput: {
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    flex: 1,
    minWidth: 0,
    padding: 0,
  } as React.CSSProperties,
  fieldClear: {
    background: 'transparent',
    border: 'none',
    padding: '1px',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    opacity: 0.4,
    display: 'flex',
    alignItems: 'center',
    lineHeight: 1,
    flexShrink: 0,
  } as React.CSSProperties,
  dateRange: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
    padding: '0 6px',
    height: '26px',
    boxSizing: 'border-box' as const,
  },
  dateInput: {
    width: '108px',
    background: 'transparent',
    border: 'none',
    outline: 'none',
    color: 'var(--vscode-input-foreground)',
    fontSize: '12px',
    padding: 0,
  } as React.CSSProperties,
  dateSep: {
    fontSize: '11px',
    opacity: 0.5,
    flexShrink: 0,
  },
  input: {
    background: 'var(--vscode-input-background)',
    border: '1px solid var(--vscode-input-border)',
    borderRadius: '4px',
  },
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
