import React, { useRef, useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { LaidOutCommit } from '../utils/graphLayout';
import { CommitRowSvg } from './CommitGraph';
import { ROW_HEIGHT } from '../utils/graphLayout';
import type { RepoMeta } from '../../shared/types';
import { groupRefs, branchColor, tagColor, headColor } from '../utils/refs';
import type { RefGroup } from '../utils/refs';
import { Codicon } from '../../shared/Codicon';
import { AiCommitComposerIcon } from '../../shared/AiCommitComposerIcon';
import { getVsCodeApi } from '../../shared/vscodeApi';
import type { LogToHostMsg } from '../../../host/types/messages';
import { AuthorAvatar } from './AuthorAvatar';
import { formatDateTime } from '../../shared/dateUtils';
import { t } from '../../shared/i18n';
import { getCommitKey, useLogStore, type CommitSelectionMode } from '../store/logStore';
import { scopedKey } from '../../shared/scopedKey';
import { readableAccentColor } from '../../shared/branchColors';

interface Props {
  commits: LaidOutCommit[];
  selectedHashes: string[];
  primarySelectedHash: string | null;
  repos: RepoMeta[];
  currentBranchByRepo: Record<string, string>;
  headHashByRepo: Record<string, string>;
  remoteNamesByRepo?: Readonly<Record<string, readonly string[]>>;
  onSelect: (commit: LaidOutCommit, mode: CommitSelectionMode) => void;
  onLoadMore: () => void;
  hasMore: boolean;
  storeHasMore: boolean;
  loading: boolean;
  backgroundLoading?: boolean;
  expandedRepoIds?: ReadonlySet<string>;
  onToggleRepoName?: (repoId: string) => void;
  onRetry?: () => void;
  scrollToHash?: string | null;
  onScrolledToHash?: () => void;
}

interface RepoBlock {
  repoId: string;
  name: string;
  color: string;
  startRow: number;
  rowCount: number;
}

const REPO_LABEL_WIDTH = 6;
const REPO_LABEL_WIDTH_EXPANDED = 110;
const REPO_BLOCK_GAP = 4;

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const SKELETON_ANIM_STYLE = `
@keyframes versiondock-skeleton-pulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.4; }
}
`;

const INTERACTION_STYLE = `
@keyframes versiondock-indeterminate-progress {
  0%   { transform: translateX(-110%); }
  100% { transform: translateX(305%); }
}
.versiondock-commit-row[data-selected="false"]:hover {
  background: var(--vscode-list-hoverBackground) !important;
}
.versiondock-commit-row[data-selected="true"]:hover {
  filter: brightness(1.08);
}
.versiondock-log-repo-strip:hover {
  filter: brightness(1.12);
}
[data-log-action-btn]:hover,
[data-top-action-btn]:hover {
  background: var(--vscode-toolbar-hoverBackground) !important;
  opacity: 1 !important;
}
[data-context-menu-item]:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)) !important;
}
.versiondock-bg-loading-fill {
  animation: versiondock-indeterminate-progress 1.1s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
`;

function CommitSkeleton() {
  const rows = Math.ceil(window.innerHeight / ROW_HEIGHT) + 2;
  return (
    <div
      style={skeletonStyles.container}
      role="status"
      aria-live="polite"
      aria-label={t('Loading commits…')}
    >
      <style>{SKELETON_ANIM_STYLE}</style>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} style={skeletonStyles.row(i, rows)}>
          <div style={skeletonStyles.graph} />
          <div style={skeletonStyles.message(i)} />
          <div style={skeletonStyles.meta} />
        </div>
      ))}
      <div style={skeletonStyles.overlay}>
        <Codicon name="loading~spin" style={skeletonStyles.loadingIcon} />
        <span>{t('Loading commits…')}</span>
      </div>
    </div>
  );
}

export function CommitList({ commits, selectedHashes, primarySelectedHash, repos, currentBranchByRepo, headHashByRepo, remoteNamesByRepo = {}, onSelect, onLoadMore, onRetry, hasMore, storeHasMore, loading, backgroundLoading, expandedRepoIds, onToggleRepoName, scrollToHash, onScrolledToHash }: Props) {
  const repoErrors = useLogStore(s => s.repoErrors);
  const parentRef = useRef<HTMLDivElement>(null);
  // Start as true — skeleton is always shown until commits arrive (handles first load correctly)
  const [showSkeleton, setShowSkeleton] = useState(true);
  const skeletonTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (skeletonTimerRef.current) {
      clearTimeout(skeletonTimerRef.current);
      skeletonTimerRef.current = null;
    }

    if (commits.length > 0) {
      // Commits have arrived: hide skeleton immediately for instant responsiveness
      setShowSkeleton(false);
      return;
    }

    if (commits.length === 0 && !storeHasMore) {
      // The server confirmed no commits (isLast=true with an empty batch).
      setShowSkeleton(false);
      return;
    }

    if (loading && commits.length === 0) {
      setShowSkeleton(true);
    }
  }, [commits.length, loading, storeHasMore]);

  const [localExpandedRepos, setLocalExpandedRepos] = useState<Set<string>>(new Set());
  const expandedRepos = expandedRepoIds ?? localExpandedRepos;
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ commit: LaidOutCommit; x: number; y: number; multiSelected: LaidOutCommit[] } | null>(null);
  const selectedHashSet = useMemo(() => new Set(selectedHashes), [selectedHashes]);
  const [popover, setPopover] = useState<{ commit: LaidOutCommit; rowTop: number; listRect: DOMRect; mouseX: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popoverHoveredRef = useRef(false);
  const closePopoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [containerWidth, setContainerWidth] = useState<number>(9999);
  const containerRoRef = useRef<ResizeObserver | null>(null);
  const loadMoreCommitCountRef = useRef(-1);

  const containerRefCb = useCallback((el: HTMLDivElement | null) => {
    if (containerRoRef.current) { containerRoRef.current.disconnect(); containerRoRef.current = null; }
    if (!el) return;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver(entries => {
      setContainerWidth(entries[0]?.contentRect.width ?? el.clientWidth);
    });
    ro.observe(el);
    containerRoRef.current = ro;
  }, []);
  const scrollContainerRef = useCallback((el: HTMLDivElement | null) => {
    (parentRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
    containerRefCb(el);
  }, [containerRefCb]);

  useEffect(() => () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (closePopoverTimerRef.current) clearTimeout(closePopoverTimerRef.current);
    containerRoRef.current?.disconnect();
    containerRoRef.current = null;
  }, []);

  const repoMeta = useMemo(() => {
    const map: Record<string, RepoMeta> = {};
    repos.forEach(r => { map[r.id] = r; });
    return map;
  }, [repos]);
  const multiRepo = repos.length > 1;

  const repoBlocks = useMemo((): RepoBlock[] => {
    if (!multiRepo || commits.length === 0) return [];
    const blocks: RepoBlock[] = [];
    let cur: RepoBlock | null = null;
    for (let i = 0; i < commits.length; i++) {
      const c = commits[i];
      const meta = repoMeta[c.repoId];
      if (!cur || cur.repoId !== c.repoId) {
        cur = { repoId: c.repoId, name: meta?.name ?? c.repoId, color: readableAccentColor(meta?.color ?? '#888'), startRow: i, rowCount: 1 };
        blocks.push(cur);
      } else {
        cur.rowCount++;
      }
    }
    return blocks;
  }, [commits, repoMeta, multiRepo]);
  const virtualizer = useVirtualizer({
    count: commits.length,
    getScrollElement: () => parentRef.current,
    // Commit rows stay contiguous so graph segments meet exactly at row
    // boundaries. Repository separation is drawn only in the label strip.
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });

  const items = virtualizer.getVirtualItems();

  const handleScroll = useCallback(() => {
    const el = parentRef.current;
    if (!el) return;
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_HEIGHT * 5;
    if (!nearBottom || !hasMore || loading || backgroundLoading) return;
    if (loadMoreCommitCountRef.current === commits.length) return;

    loadMoreCommitCountRef.current = commits.length;
    onLoadMore();
  }, [backgroundLoading, commits.length, hasMore, loading, onLoadMore]);

  useEffect(() => {
    if (showSkeleton) return;
    const el = parentRef.current;
    if (!el) return;
    el.addEventListener('scroll', handleScroll, { passive: true });
    // Re-check when a request finishes or the list size changes. This covers
    // the case where the user reached the bottom while loading was still true.
    handleScroll();
    return () => el.removeEventListener('scroll', handleScroll);
  }, [handleScroll, showSkeleton]);

  useEffect(() => {
    if (loading || !storeHasMore) {
      loadMoreCommitCountRef.current = -1;
    }
  }, [loading, storeHasMore]);

  useEffect(() => {
    if (!scrollToHash) return;
    const idx = commits.findIndex(c => getCommitKey(c.repoId, c.hash) === scrollToHash || c.hash === scrollToHash);
    if (idx >= 0) {
      virtualizer.scrollToIndex(idx, { align: 'center' });
      onSelect(commits[idx], 'single');
      onScrolledToHash?.();
      return;
    }
    // Commit not yet in the loaded list — keep fetching batches until found or exhausted
    if (hasMore && !loading) onLoadMore();
  }, [commits, hasMore, loading, onLoadMore, onScrolledToHash, onSelect, scrollToHash, virtualizer]);

  const anyExpanded = expandedRepos.size > 0;
  const labelColWidth = multiRepo ? (anyExpanded ? REPO_LABEL_WIDTH_EXPANDED : REPO_LABEL_WIDTH + 2) : 0;

  const scrollTop = virtualizer.scrollOffset ?? 0;

  function toggleRepo(repoId: string) {
    if (onToggleRepoName) {
      onToggleRepoName(repoId);
      return;
    }
    setLocalExpandedRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId); else next.add(repoId);
      return next;
    });
  }

  if (showSkeleton) {
    return <CommitSkeleton />;
  }

  if (commits.length === 0) {
    return (
      <div style={emptyStyles.container}>
        <Codicon name="history" style={emptyStyles.icon} />
        <div style={emptyStyles.title}>{t('No commits found')}</div>
      </div>
    );
  }

  return (
    <div style={styles.frame}>
      <div
        ref={scrollContainerRef}
        style={styles.container}
        onClick={() => { setContextMenu(null); setPopover(null); }}
      >
        <style>{INTERACTION_STYLE}</style>
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>

        {/* Repo label strips */}
        {multiRepo && repoBlocks.map((block) => {
          const blockTopPx = block.startRow * ROW_HEIGHT;
          const blockHeightPx = block.rowCount * ROW_HEIGHT;
          const leadingGap = block.startRow > 0 ? REPO_BLOCK_GAP : 0;
          const topPx = blockTopPx + leadingGap;
          const heightPx = Math.max(0, blockHeightPx - leadingGap);
          const expanded = expandedRepos.has(block.repoId);
          const nameOffset = Math.min(
            Math.max(scrollTop - topPx, 0),
            Math.max(0, heightPx - ROW_HEIGHT),
          );
          return (
            <div
              key={`strip-${block.repoId}-${block.startRow}`}
              style={styles.repoStrip(topPx, heightPx, block.color, expanded)}
              className="versiondock-log-repo-strip"
              onClick={() => toggleRepo(block.repoId)}
              title={block.name}
            >
              <span style={styles.repoStripBar(block.color)} />
              {expanded && (
                <span style={styles.repoStripName(nameOffset)}>{block.name}</span>
              )}
            </div>
          );
        })}

        {/* Commit rows (virtual) */}
        {items.map((vrow) => {
          const commit = commits[vrow.index];
          if (!commit) return null;
          const commitKey = getCommitKey(commit.repoId, commit.hash);
          const isSelected = commitKey === primarySelectedHash;
          const isMultiSelected = selectedHashSet.has(commitKey) && !isSelected;
          const isMergeCommit = commit.parents.length > 1;
          const repoKind = repoMeta[commit.repoId]?.kind ?? 'git';

          return (
            <div
              key={scopedKey(commit.repoId, commit.hash)}
              style={styles.row(vrow.start, isSelected, isMultiSelected, hoveredIndex === vrow.index, !isSelected && getCommitKey(contextMenu?.commit.repoId ?? '', contextMenu?.commit.hash ?? '') === commitKey)}
              className="versiondock-commit-row"
              data-selected={isSelected || isMultiSelected}
              onMouseEnter={(e) => {
                setHoveredIndex(vrow.index);
                if (closePopoverTimerRef.current) clearTimeout(closePopoverTimerRef.current);
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                // Don't restart the open-timer if popover for this commit is already showing
                if (popover && getCommitKey(popover.commit.repoId, popover.commit.hash) === commitKey) return;
                setPopover(null);
                const rowEl = e.currentTarget as HTMLElement;
                const mouseX = e.clientX;
                hoverTimerRef.current = setTimeout(() => {
                  const rect = rowEl.getBoundingClientRect();
                  const parent = parentRef.current;
                  if (!parent) return;
                  const listRect = parent.getBoundingClientRect();
                  setPopover({ commit, rowTop: rect.top, listRect, mouseX });
                }, 1000);
              }}
              onMouseLeave={() => {
                setHoveredIndex(null);
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                // Delay closing so mouse can travel into the popover
                closePopoverTimerRef.current = setTimeout(() => {
                  if (!popoverHoveredRef.current) setPopover(null);
                }, 120);
              }}
              onClick={(e) => {
                if (e.shiftKey) {
                  onSelect(commit, 'range');
                } else if (e.ctrlKey || e.metaKey) {
                  onSelect(commit, 'toggle');
                } else {
                  onSelect(commit, 'single');
                }
              }}
              onContextMenu={e => {
                e.preventDefault();
                e.stopPropagation();
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                setPopover(null);
                const isInSelection = selectedHashSet.has(commitKey);
                const multiSelected = isInSelection && selectedHashes.length > 1
                  ? commits.filter(c => selectedHashSet.has(getCommitKey(c.repoId, c.hash)))
                  : [];
                if (!isInSelection) {
                  onSelect(commit, 'single');
                }
                setContextMenu({ commit, x: e.clientX, y: e.clientY, multiSelected });
              }}
            >
              {labelColWidth > 0 && <div style={{ width: labelColWidth, flexShrink: 0 }} />}

              <CommitRowSvg
                commit={commit}
                isSelected={isSelected}
              />

              {commit.refs.length > 0 && (() => {
                const allGroups = mergeLocalRemote(groupRefs(commit.refs, repoKind, remoteNamesByRepo[commit.repoId] ?? []));
                // Exclude remoteHead from branch badges since it is a symbolic pointer, not a distinct branch
                const displayGroups = allGroups.filter(g => !g.isRemoteHead);
                const refsSpace = containerWidth - labelColWidth - 340;
                const MAX = refsSpace < 80 ? 0 : refsSpace < 170 ? 1 : 2;
                const visible = displayGroups.slice(0, MAX);
                const overflow = displayGroups.slice(MAX);
                return (
                  <div style={styles.refs}>
                    {visible.map(group => {
                      const color = badgeColor(group);
                      return (
                        <span key={group.key} style={styles.refBadge(color, group.isTag, (group.isHead || group.isDetached) && !group.isRemoteHead, isSelected)} title={badgeTitle(group)}>
                          <RefBadgeIcon group={group} />
                          <span style={styles.refBadgeLabel}>
                            {formatRefLabel(group)}
                          </span>
                        </span>
                      );
                    })}
                    {overflow.length > 0 && (
                      <span
                        style={styles.overflowLabel(badgeColor(overflow[0]), isSelected)}
                        title={overflow.map(g => badgeTitle(g)).join('\n')}
                      >
                        {visible.length === 0 ? `${overflow.length}` : `+${overflow.length}`}
                      </span>
                    )}
                  </div>
                );
              })()}
              <div style={styles.info}>
                <span style={styles.message(isMergeCommit, isSelected || isMultiSelected)}>{commit.message}</span>
              </div>

              {hoveredIndex === vrow.index && (
                <div style={styles.inlineActions}>
                  <button
                    data-log-action-btn=""
                    style={styles.inlineActionBtn}
                    title={t('Open Commit Detail')}
                    onClick={event => {
                      event.stopPropagation();
                      const store = useLogStore.getState();
                      const commitKey = getCommitKey(commit.repoId, commit.hash);
                      const cachedFiles = store.commitFilesByKey[commitKey];
                      const cachedMergeChanges = store.mergeParentChangesByKey[commitKey];
                      const isLoadingFiles = store.loadingFilesByKey[commitKey] === true;
                      getVsCodeApi().postMessage({
                        type: 'LOG_OPEN_EXTENDED_DETAIL',
                        repoId: commit.repoId,
                        hash: commit.hash,
                        initialCommit: {
                          message: commit.message,
                          authorName: commit.authorName,
                          authorEmail: commit.authorEmail,
                          authorDate: commit.authorDate,
                          committerDate: commit.committerDate,
                          parents: commit.parents,
                        },
                        initialFiles: !isLoadingFiles && cachedFiles
                          ? cachedFiles.map(file => ({
                              path: file.path,
                              status: file.status,
                              added: file.added,
                              removed: file.removed,
                            }))
                          : undefined,
                        initialMergeParentChanges: cachedMergeChanges,
                      } satisfies LogToHostMsg);
                    }}
                  >
                    <Codicon name="open-preview" style={{ fontSize: '15px', lineHeight: 1 }} />
                  </button>
                  <button
                    data-log-action-btn=""
                    style={styles.inlineActionBtn}
                    title={t('Open Changes')}
                    onClick={event => {
                      event.stopPropagation();
                      const store = useLogStore.getState();
                      const commitKey = getCommitKey(commit.repoId, commit.hash);
                      const cachedFiles = store.commitFilesByKey[commitKey];
                      const isLoadingFiles = store.loadingFilesByKey[commitKey] === true;
                      getVsCodeApi().postMessage({
                        type: 'LOG_OPEN_COMMIT_CHANGES',
                        repoId: commit.repoId,
                        hash: commit.hash,
                        files: !isLoadingFiles && cachedFiles
                          ? cachedFiles.map(file => ({
                              path: file.path,
                              status: file.status,
                              added: file.added,
                              removed: file.removed,
                            }))
                          : undefined,
                      } satisfies LogToHostMsg);
                    }}
                  >
                    <Codicon name="diff-multiple" style={{ fontSize: '15px', lineHeight: 1 }} />
                  </button>
                </div>
              )}
              {commit.incoming && (
                <Codicon name="arrow-down" style={styles.incomingIcon} title={t('Not updated')} />
              )}
              {commit.unpushed && (
                <Codicon name="arrow-up" style={styles.unpushedIcon} title={t('Not pushed')} />
              )}
              <div style={styles.meta}>
                <AuthorAvatar authorName={commit.authorName} authorEmail={commit.authorEmail} size={20} />
                <span style={styles.author}>{formatAuthorName(commit.authorName)}</span>
              </div>
              <span style={styles.date}>{formatDateTime(commit.authorDate)}</span>
            </div>
          );
        })}
        </div>

        {popover && (
          <CommitPopover
            commit={popover.commit}
            repoKind={repoMeta[popover.commit.repoId]?.kind ?? 'git'}
            remoteNames={remoteNamesByRepo[popover.commit.repoId] ?? []}
            rowTop={popover.rowTop}
            listRect={popover.listRect}
            mouseX={popover.mouseX}
            onClose={() => setPopover(null)}
            popoverHoveredRef={popoverHoveredRef}
            closePopoverTimerRef={closePopoverTimerRef}
          />
        )}

        {contextMenu && (
          <CommitContextMenu
            commit={contextMenu.commit}
            x={contextMenu.x}
            y={contextMenu.y}
            multiSelected={contextMenu.multiSelected}
            repoKind={repoMeta[contextMenu.commit.repoId]?.kind ?? 'git'}
            remoteNames={remoteNamesByRepo[contextMenu.commit.repoId] ?? []}
            allCommits={commits}
            currentBranchByRepo={currentBranchByRepo}
            headHashByRepo={headHashByRepo}
            onClose={() => setContextMenu(null)}
            onSquash={(selected) => {
              setContextMenu(null);
              let maxIdx = -1;
              let oldestHash = selected[0].hash;
              for (const c of selected) {
                const idx = commits.findIndex(x => getCommitKey(x.repoId, x.hash) === getCommitKey(c.repoId, c.hash));
                if (idx > maxIdx) { maxIdx = idx; oldestHash = c.hash; }
              }
              getVsCodeApi().postMessage({
                type: 'LOG_SQUASH_COMMITS',
                requestId: generateId(),
                repoId: selected[0].repoId,
                hashes: selected.map(c => c.hash),
                oldestHash,
                message: selected.map(c => c.message).join('\n\n'),
                commits: selected.map(c => ({ hash: c.hash, shortHash: c.hash.slice(0, 7), message: c.message })),
              } satisfies LogToHostMsg);
            }}
          />
        )}
      </div>

      {(backgroundLoading || (loading && commits.length > 0)) && (
        <>
          <div
            role="status"
            aria-live="polite"
            aria-label={t('Loading commits…')}
            style={styles.loadingMore}
          >
            <Codicon name="loading~spin" style={styles.loadingMoreIcon} />
            <span>{t('Loading commits…')}</span>
          </div>
          <div style={styles.bgLoadingBar}>
            <div className="versiondock-bg-loading-fill" style={styles.bgLoadingBarFill} />
          </div>
        </>
      )}

      {repoErrors && repoErrors.length > 0 && !loading && (() => {
        const errorDetailTooltip = repoErrors
          .map(e => `${repoMeta[e.repoId]?.name || e.repoId}: ${e.error}`)
          .join('\n');
        const firstError = repoErrors[0];
        const firstRepoName = repoMeta[firstError.repoId]?.name || firstError.repoId;
        const firstCleanError = firstError.error.replace(/^error:\s*/i, '').trim().split('\n')[0] || '';
        const summaryText = repoErrors.length === 1
          ? t('Failed to load {0}: {1}', firstRepoName, firstCleanError)
          : t('Failed to load logs for {0} repo(s) ({1}…): {2}', String(repoErrors.length), firstRepoName, firstCleanError);

        return (
          <div
            style={{
              position: 'absolute',
              bottom: 8,
              left: '50%',
              transform: 'translateX(-50%)',
              zIndex: 22,
              maxWidth: '90%',
              padding: '4px 10px',
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              border: '1px solid var(--vscode-inputValidation-errorBorder, #f14c4c)',
              borderRadius: '4px',
              background: 'var(--vscode-inputValidation-errorBackground, #5a1d1d)',
              color: 'var(--vscode-inputValidation-errorForeground, #ffffff)',
              fontSize: '11px',
              boxShadow: '0 2px 8px rgba(0, 0, 0, 0.35)',
            }}
            title={errorDetailTooltip}
          >
            <Codicon name="error" style={{ color: 'var(--vscode-errorForeground, #f14c4c)', flexShrink: 0 }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {summaryText}
            </span>
            <button
              style={{
                padding: '2px 8px',
                background: 'var(--vscode-button-background)',
                color: 'var(--vscode-button-foreground)',
                border: 'none',
                borderRadius: '2px',
                cursor: 'pointer',
                fontSize: '11px',
                flexShrink: 0,
              }}
              onClick={() => (onRetry ? onRetry() : onLoadMore())}
            >
              {t('Retry')}
            </button>
          </div>
        );
      })()}
    </div>
  );
}

function CommitPopover({ commit, repoKind, remoteNames, rowTop, listRect, mouseX, onClose, popoverHoveredRef, closePopoverTimerRef }: {
  commit: LaidOutCommit;
  repoKind: 'git' | 'svn';
  remoteNames: readonly string[];
  rowTop: number;
  listRect: DOMRect;
  mouseX: number;
  onClose: () => void;
  popoverHoveredRef: React.MutableRefObject<boolean>;
  closePopoverTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [stats, setStats] = useState<{ files: number; added: number; removed: number } | null>(null);
  // null = measuring, object = positioned and visible
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Fetch file stats on mount
  useEffect(() => {
    const reqId = generateId();
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg?.type === 'LOG_COMMIT_FILES' && msg.requestId === reqId) {
        window.removeEventListener('message', handler);
        const files = msg.files as Array<{ added?: number; removed?: number }>;
        const added = files.reduce((s: number, f: { added?: number }) => s + (f.added ?? 0), 0);
        const removed = files.reduce((s: number, f: { removed?: number }) => s + (f.removed ?? 0), 0);
        setStats({ files: files.length, added, removed });
      }
    };
    window.addEventListener('message', handler);
    getVsCodeApi().postMessage({ type: 'LOG_REQUEST_COMMIT_FILES', requestId: reqId, repoId: commit.repoId, hash: commit.hash, prefetchContent: false } satisfies LogToHostMsg);
    return () => window.removeEventListener('message', handler);
  }, [commit.hash, commit.repoId]);

  // Once stats arrive and the element is in the DOM (invisible), measure and position it
  useLayoutEffect(() => {
    if (!stats) return;
    const el = popoverRef.current;
    if (!el) return;
    const { offsetWidth: w, offsetHeight: h } = el;
    // Center on mouse X, clamped inside the list
    const left = Math.max(listRect.left, Math.min(listRect.right - w, mouseX - w / 2));
    // Prefer above the row; fall back to below if no room inside the list
    const preferTop = rowTop - h - 6;
    const top = preferTop >= listRect.top ? preferTop : rowTop + ROW_HEIGHT + 6;
    setPos({ top, left });
  }, [stats, rowTop, listRect, mouseX]);

  // Close on window blur
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('blur', close);
    return () => window.removeEventListener('blur', close);
  }, [onClose]);

  // Reset hover flag on unmount
  useEffect(() => () => { popoverHoveredRef.current = false; }, [popoverHoveredRef]);

  // Don't render at all until stats are fetched
  if (!stats) return null;

  const refGroups = mergeLocalRemote(groupRefs(commit.refs, repoKind, remoteNames));

  // Render invisible for measurement on first paint, visible once pos is computed
  const visible = pos !== null;

  return createPortal(
    <div
      ref={popoverRef}
      style={{
        ...popoverStyles.container,
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
      onMouseEnter={() => {
        popoverHoveredRef.current = true;
        if (closePopoverTimerRef.current) clearTimeout(closePopoverTimerRef.current);
      }}
      onMouseLeave={() => {
        popoverHoveredRef.current = false;
        onClose();
      }}
    >
      {/* Hash */}
      <div style={popoverStyles.row}>
        <Codicon name="git-commit" style={popoverStyles.icon} />
        <span style={popoverStyles.hash}>{commit.shortHash}</span>
      </div>

      {/* Author + date */}
      <div style={popoverStyles.row}>
        <AuthorAvatar authorName={commit.authorName} authorEmail={commit.authorEmail} size={16} />
        <span style={popoverStyles.author}>{commit.authorName}</span>
        <span style={popoverStyles.dot}>·</span>
        <span style={popoverStyles.date}>{formatDateTime(commit.authorDate)}</span>
      </div>

      {/* File stats */}
      <div style={popoverStyles.row}>
        <Codicon name="diff" style={popoverStyles.icon} />
        <span style={popoverStyles.statText}>
          {stats.files === 1 ? t('{0} file changed', stats.files) : t('{0} files changed', stats.files)}
        </span>
        {stats.added > 0 && <span style={popoverStyles.added}>+{stats.added}</span>}
        {stats.removed > 0 && <span style={popoverStyles.removed}>-{stats.removed}</span>}
      </div>

      {/* Ref badges */}
      {refGroups.length > 0 && (() => {
        const displayGroups = refGroups.filter(g => !g.isRemoteHead);
        return (
          <div style={popoverStyles.refs}>
            {displayGroups.map(group => {
              const color = badgeColor(group);
              return (
                <span key={group.key} style={popoverStyles.badge(color, (group.isHead || group.isDetached) && !group.isRemoteHead)} title={badgeTitle(group)}>
                  <RefBadgeIcon group={group} />
                  <span style={popoverStyles.badgeLabel}>
                    {formatRefLabel(group)}
                  </span>
                </span>
              );
            })}
          </div>
        );
      })()}

      <div style={popoverStyles.hint}>{t('Click for more details')}</div>
    </div>,
    document.body
  );
}

const popoverStyles = {
  container: {
    position: 'fixed',
    zIndex: 1000,
    background: 'var(--vscode-editorWidget-background)',
    border: '1px solid var(--vscode-widget-border)',
    borderRadius: '6px',
    padding: '8px 10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '5px',
    boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
    minWidth: '260px',
    maxWidth: '420px',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
  } as React.CSSProperties,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
  } as React.CSSProperties,
  icon: {
    fontSize: '12px',
    flexShrink: 0,
  } as React.CSSProperties,
  hash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontWeight: 600,
    fontSize: '12px',
    flexShrink: 0,
  } as React.CSSProperties,
  fullHash: {
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  },
  author: {
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  dot: { color: 'var(--vscode-descriptionForeground)', flexShrink: 0 } as React.CSSProperties,
  date: { color: 'var(--vscode-descriptionForeground)', flexShrink: 0, fontSize: '11px' } as React.CSSProperties,
  statText: { color: 'var(--vscode-descriptionForeground)' } as React.CSSProperties,
  added: {
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
    fontWeight: 600,
    fontSize: '11px',
    flexShrink: 0,
  } as React.CSSProperties,
  removed: {
    color: 'var(--vscode-gitDecoration-deletedResourceForeground)',
    fontWeight: 600,
    fontSize: '11px',
    flexShrink: 0,
  } as React.CSSProperties,
  refs: {
    display: 'flex',
    flexWrap: 'wrap' as const,
    gap: '3px',
    marginTop: '1px',
  } as React.CSSProperties,
  badge: (color: string, isHead = false): React.CSSProperties => ({
    fontSize: '10px',
    padding: '0 5px',
    height: '16px',
    lineHeight: '16px',
    borderRadius: '3px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    maxWidth: '180px',
    overflow: 'hidden',
    flexShrink: 0,
    boxSizing: 'border-box' as const,
    fontWeight: isHead ? 700 : 500,
  }),
  badgeLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
  } as React.CSSProperties,
  hint: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center',
    marginTop: '2px',
  } as React.CSSProperties,
};

function CommitContextMenu({ commit, x, y, multiSelected, repoKind, remoteNames, allCommits, currentBranchByRepo, headHashByRepo, onClose, onSquash }: {
  commit: LaidOutCommit;
  x: number;
  y: number;
  multiSelected: LaidOutCommit[];
  repoKind: 'git' | 'svn';
  remoteNames: readonly string[];
  allCommits: LaidOutCommit[];
  currentBranchByRepo: Record<string, string>;
  headHashByRepo: Record<string, string>;
  onClose: () => void;
  onSquash: (selected: LaidOutCommit[]) => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const isSvn = repoKind === 'svn';
  const commitRefGroups = groupRefs(commit.refs, repoKind, remoteNames);
  const tagsFromRefs = commitRefGroups.filter(group => group.isTag).map(group => group.label);
  const localBranchGroups = commitRefGroups.filter(group => group.isLocal && !group.isTag && !group.isDetached);
  const remoteBranchGroups = commitRefGroups.filter(group => group.isRemote && !group.isRemoteHead && !group.isTag);
  const primaryLocalGroup = localBranchGroups.find(group => group.isHead) ?? localBranchGroups[0];
  const primaryRemoteGroup = remoteBranchGroups[0];
  // SVN uses HEAD/BASE as revision markers rather than branch refs. Only the
  // current HEAD revision can safely offer the working-copy branch as a target.
  const checkoutTarget = isSvn
    ? commit.refs.includes('HEAD') ? currentBranchByRepo[commit.repoId] ?? null : null
    : primaryLocalGroup?.label
      ?? (primaryRemoteGroup ? `${primaryRemoteGroup.remoteName}/${primaryRemoteGroup.label}` : null);
  const branchOptionsTarget = isSvn ? checkoutTarget : primaryLocalGroup?.label ?? null;

  // Clamp menu position so it stays within the viewport (useLayoutEffect avoids flash)
  const [menuPos, setMenuPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    if (!menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = rect.right > vw ? Math.max(0, x - (rect.right - vw) - 4) : x;
    const top = rect.bottom > vh ? Math.max(0, y - (rect.bottom - vh) - 4) : y;
    if (left !== x || top !== y) setMenuPos({ left, top });
    else setMenuPos({ left: x, top: y });
  }, [x, y]);

  useEffect(() => {
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const blurHandler = () => onClose();
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') onClose();
    };
    document.addEventListener('keydown', keyHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    return () => {
      document.removeEventListener('keydown', keyHandler);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
    };
  }, [onClose]);

  const isMulti = multiSelected.length > 1 && multiSelected.every(c => c.repoId === multiSelected[0].repoId);
  const allUnpushed = isMulti && multiSelected.every(c => c.unpushed);
  const isHead = headHashByRepo[commit.repoId] === commit.hash;

  function send(msg: LogToHostMsg) {
    getVsCodeApi().postMessage(msg);
    onClose();
  }

  function copyHash() {
    navigator.clipboard.writeText(commit.hash).catch(() => {});
    onClose();
  }

  // Build index map once for sorting (higher index = older commit in log)
  const indexMap = new Map<string, number>();
  allCommits.forEach((c, i) => indexMap.set(getCommitKey(c.repoId, c.hash), i));
  const sortedOldestFirst = [...multiSelected].sort((a, b) => (
    (indexMap.get(getCommitKey(b.repoId, b.hash)) ?? 0)
    - (indexMap.get(getCommitKey(a.repoId, a.hash)) ?? 0)
  ));
  const sortedNewestFirst = [...multiSelected].sort((a, b) => (
    (indexMap.get(getCommitKey(a.repoId, a.hash)) ?? 0)
    - (indexMap.get(getCommitKey(b.repoId, b.hash)) ?? 0)
  ));

  const repoId = isMulti ? multiSelected[0].repoId : commit.repoId;
  const oldestHash = sortedOldestFirst[0]?.hash ?? commit.hash;

  if (isMulti) {
    return (
      <>
        <div style={ctxStyles.backdrop} onClick={onClose} />
        <div ref={menuRef} style={ctxStyles.menu(menuPos.left, menuPos.top)}>
          <div style={ctxStyles.header}>{multiSelected.length === 1 ? t('{0} commit selected', multiSelected.length) : t('{0} commits selected', multiSelected.length)}</div>
          <div style={ctxStyles.separator} />
          <div
            data-context-menu-item=""
            style={ctxStyles.item}
            onClick={() => send({
              type: 'LOG_OPEN_AI_EXPLANATION_MULTI',
              commits: sortedNewestFirst.map(selectedCommit => ({ repoId: selectedCommit.repoId, hash: selectedCommit.hash })),
            })}
          >
            <Codicon name="sparkle-filled" style={ctxStyles.icon} />
            <span>{t('AI Explain')}</span>
          </div>
          <div style={ctxStyles.separator} />
          <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_PATCH_MULTI', requestId: generateId(), repoId, hashes: multiSelected.map(c => c.hash) })}>
            <Codicon name="diff" style={ctxStyles.icon} />
            <span>{t('Create Patch...')}</span>
          </div>
          {!isSvn && (
            <>
              <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHERRY_PICK_MULTI', requestId: generateId(), repoId, hashes: sortedOldestFirst.map(c => c.hash) })}>
                <Codicon name="git-commit" style={ctxStyles.icon} />
                <span>{t('Cherry-Pick All')}</span>
              </div>
              <div style={ctxStyles.separator} />
              <div style={ctxStyles.itemDisabled}>
                <Codicon name="history" style={ctxStyles.icon} />
                <span>{t('Reset Current Branch to Here')}</span>
              </div>
              <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_REVERT_COMMITS', requestId: generateId(), repoId, hashes: sortedNewestFirst.map(c => c.hash) })}>
                <Codicon name="discard" style={ctxStyles.icon} />
                <span>{t('Revert Commits')}</span>
              </div>
            </>
          )}
          {allUnpushed && (
            <>
              <div style={ctxStyles.separator} />
              <div
                data-context-menu-item=""
                style={ctxStyles.aiComposerItem}
                onClick={() => send({
                  type: 'LOG_OPEN_AI_COMPOSER',
                  repoId,
                  hashes: sortedNewestFirst.map(selectedCommit => selectedCommit.hash),
                })}
              >
                <AiCommitComposerIcon style={ctxStyles.icon} />
                <span>{t('AI Reorganize Commits')}</span>
              </div>
              <div
                data-context-menu-item=""
                style={{ ...ctxStyles.item, color: 'var(--vscode-errorForeground)' }}
                onClick={() => send({ type: 'LOG_DROP_COMMITS', requestId: generateId(), repoId, hashes: multiSelected.map(c => c.hash), oldestHash })}
              >
                <Codicon name="trash" style={ctxStyles.icon} />
                <span>{t('Drop Commits')}</span>
              </div>
              <div data-context-menu-item="" style={ctxStyles.item} onClick={() => onSquash(multiSelected)}>
                <Codicon name="fold-down" style={ctxStyles.icon} />
                <span>{t('Squash {0} Commits...', multiSelected.length)}</span>
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <div style={ctxStyles.backdrop} onClick={onClose} />
      <div ref={menuRef} style={ctxStyles.menu(menuPos.left, menuPos.top)}>
        <div data-context-menu-item="" style={ctxStyles.item} onClick={copyHash}>
          <Codicon name="copy" style={ctxStyles.icon} />
          <span>{t('Copy Revision Number')}</span>
        </div>
        <div
          data-context-menu-item=""
          style={ctxStyles.item}
          onClick={() => multiSelected.length > 1
            ? send({
              type: 'LOG_OPEN_AI_EXPLANATION_MULTI',
              commits: sortedNewestFirst.map(selectedCommit => ({ repoId: selectedCommit.repoId, hash: selectedCommit.hash })),
            })
            : send({ type: 'LOG_OPEN_AI_EXPLANATION', repoId: commit.repoId, hash: commit.hash })}
        >
          <Codicon name="sparkle-filled" style={ctxStyles.icon} />
          <span>{t('AI Explain')}</span>
        </div>
        <div style={ctxStyles.separator} />
        <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_NEW_BRANCH_FROM_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          <Codicon name="git-branch" style={ctxStyles.icon} />
          <span>{t('New Branch...')}</span>
        </div>
        {tagsFromRefs.length === 0 ? (
          <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_TAG', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
            <Codicon name="tag" style={ctxStyles.icon} />
            <span>{t('New Tag...')}</span>
          </div>
        ) : (
          <div
            data-context-menu-item=""
            style={ctxStyles.item}
            onClick={() => {
              const currentBranch = currentBranchByRepo[commit.repoId] ?? '';
              send({ type: 'LOG_MANAGE_COMMIT_TAGS', repoId: commit.repoId, hash: commit.hash, currentBranch } satisfies LogToHostMsg);
            }}
          >
            <Codicon name="tag" style={ctxStyles.icon} />
            <span>{t('Manage Tags...')}</span>
          </div>
        )}
        <div style={ctxStyles.separator} />
        {checkoutTarget ? (
          <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHECKOUT_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash, branchName: checkoutTarget })}>
            <Codicon name="arrow-right" style={ctxStyles.icon} />
            <span>{t('Checkout...')}</span>
          </div>
        ) : (
          <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHECKOUT_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
            <Codicon name="arrow-right" style={ctxStyles.icon} />
            <span>{isSvn ? t('Update to Revision') : t('Checkout Revision')}</span>
          </div>
        )}
        {branchOptionsTarget && (
          <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_SHOW_BRANCH_OPTIONS', repoId: commit.repoId, branchName: branchOptionsTarget })}>
            <Codicon name="git-branch" style={ctxStyles.icon} />
            <span>{t('Branch options...')}</span>
          </div>
        )}
        <div style={ctxStyles.separator} />
        <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CREATE_PATCH', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
          <Codicon name="diff" style={ctxStyles.icon} />
          <span>{t('Create Patch...')}</span>
        </div>
        {!isSvn && (
          <>
            <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_CHERRY_PICK', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
              <Codicon name="git-commit" style={ctxStyles.icon} />
              <span>{t('Cherry-Pick')}</span>
            </div>
            <div style={ctxStyles.separator} />
            <div
              data-context-menu-item=""
              style={ctxStyles.item}
              onClick={() => send({ type: 'LOG_RESET_TO_PICK', repoId: commit.repoId, hash: commit.hash } satisfies LogToHostMsg)}
            >
              <Codicon name="history" style={ctxStyles.icon} />
              <span>{t('Reset Current Branch to Here...')}</span>
            </div>
            <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_REVERT_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}>
              <Codicon name="discard" style={ctxStyles.icon} />
              <span>{t('Revert Commit')}</span>
            </div>
          </>
        )}
        {commit.unpushed && isHead && (
          <>
            <div style={ctxStyles.separator} />
            {!isSvn && (
              <div
                data-context-menu-item=""
                style={ctxStyles.aiComposerItem}
                onClick={() => send({
                  type: 'LOG_OPEN_AI_COMPOSER',
                  repoId: commit.repoId,
                  hashes: [commit.hash],
                })}
              >
                <AiCommitComposerIcon style={ctxStyles.icon} />
                <span>{t('AI Reorganize Commits')}</span>
              </div>
            )}
            <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_EDIT_COMMIT_MESSAGE', requestId: generateId(), repoId: commit.repoId, hash: commit.hash, currentMessage: commit.message })}>
              <Codicon name="edit" style={ctxStyles.icon} />
              <span>{t('Edit Commit Message')}</span>
            </div>
            <div data-context-menu-item="" style={ctxStyles.item} onClick={() => send({ type: 'LOG_UNDO_COMMIT', requestId: generateId(), repoId: commit.repoId })}>
              <Codicon name="arrow-left" style={ctxStyles.icon} />
              <span>{t('Undo Commit')}</span>
            </div>
          </>
        )}
        {commit.unpushed && (
          <>
            <div style={ctxStyles.separator} />
            <div
              data-context-menu-item=""
              style={{ ...ctxStyles.item, color: 'var(--vscode-errorForeground)' }}
              onClick={() => send({ type: 'LOG_DROP_COMMIT', requestId: generateId(), repoId: commit.repoId, hash: commit.hash })}
            >
              <Codicon name="trash" style={ctxStyles.icon} />
              <span>{t('Drop Commit')}</span>
            </div>
          </>
        )}
      </div>
    </>
  );
}

const ctxStyles = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 200,
  },
  menu: (x: number, y: number): React.CSSProperties => ({
    position: 'fixed' as const,
    left: x,
    top: y,
    zIndex: 201,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border)',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    minWidth: '220px',
    padding: '4px 0',
    fontSize: '12px',
    userSelect: 'none' as const,
  }),
  header: {
    padding: '4px 12px',
    fontSize: '11px',
    color: 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
  } as React.CSSProperties,
  item: {
    padding: '4px 12px',
    cursor: 'pointer',
    color: 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  } as React.CSSProperties,
  aiComposerItem: {
    padding: '4px 12px',
    cursor: 'pointer',
    color: 'var(--vscode-textLink-foreground)',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontWeight: 600,
  } as React.CSSProperties,
  itemDisabled: {
    padding: '4px 12px',
    cursor: 'default',
    color: 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    opacity: 0.35,
    pointerEvents: 'none' as const,
  } as React.CSSProperties,
  icon: {
    fontSize: '14px',
    flexShrink: 0,
  } as React.CSSProperties,
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground)',
    margin: '4px 0',
  } as React.CSSProperties,
};

function mergeLocalRemote(groups: RefGroup[]): RefGroup[] {
  const merged: RefGroup[] = [];
  const branchesByLabel = new Map<string, RefGroup[]>();
  for (const g of groups) {
    if (g.isTag || g.isRemoteHead || g.isDetached || g.isSvnRevision) {
      merged.push(g);
      continue;
    }
    const bucket = branchesByLabel.get(g.label) ?? [];
    bucket.push(g);
    branchesByLabel.set(g.label, bucket);
  }
  for (const bucket of branchesByLabel.values()) {
    const locals = bucket.filter(group => group.isLocal);
    const remotes = bucket.filter(group => group.isRemote);
    // Keep the compact combined badge for the common one-local/one-remote
    // case. With multiple remotes, preserve every source instead of silently
    // collapsing all of them into whichever remote happened to be parsed first.
    if (locals.length === 1 && remotes.length === 1) {
      merged.push({
        ...locals[0],
        isRemote: true,
        remoteName: remotes[0].remoteName,
      });
    } else {
      merged.push(...bucket);
    }
  }
  // Order: detached HEAD, local branches, remote branches, tags, origin/HEAD last
  merged.sort((a, b) => {
    const rank = (g: RefGroup): number => {
      if (g.isSvnRevision) return g.label === 'HEAD' ? 0 : 1;
      if (g.isDetached) return 0;
      if (g.isRemoteHead) return 5;
      if (g.isTag) return 4;
      if (g.isRemote) return 3;
      return 2; // local (including isHead branch)
    };
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label);
  });
  return merged;
}

function formatAuthorName(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  return `${parts[0]} ${parts[parts.length - 1][0]}.`;
}

function remoteLabel(group: RefGroup): string {
  const r = group.remoteName || 'remote';
  return `${r}/${group.label}`;
}

function formatRefLabel(group: RefGroup): string {
  if (group.isSvnRevision) return group.label;
  if (group.isRemoteHead) return `${group.remoteName || t('remote')}/HEAD`;
  if (group.isLocal && group.isRemote) return `${group.remoteName || t('remote')} & ${group.label}`;
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
  if (group.isLocal && group.isRemote) return t('Local & remote: {0}', group.label);
  if (group.isRemote) return t('Remote: {0}', remoteLabel(group));
  return t('Local: {0}', group.label);
}

function badgeColor(group: RefGroup): string {
  if (group.isSvnRevision && group.label === 'HEAD') return headColor();
  if (group.isRemoteHead || (group.isHead && group.isDetached)) return headColor();
  if (group.isTag) return tagColor();
  // Never use headColor() for branch badges — that color is reserved for the explicit HEAD badge
  return branchColor(group.label, false);
}

function RefBadgeIcon({ group }: { group: RefGroup }) {
  const s: React.CSSProperties = { fontSize: '11px', flexShrink: 0, lineHeight: 1 };
  if (group.isSvnRevision) return <Codicon name="versions" style={s} />;
  if (group.isRemoteHead) return <Codicon name="milestone" style={s} />;
  if (group.isDetached && group.isHead) return <Codicon name="warning" style={s} />;
  if (group.isTag) return <Codicon name="tag" style={s} />;
  if (group.isLocal && group.isRemote) return (
    <>
      <Codicon name="git-branch" style={s} />
      <Codicon name="cloud" style={s} />
    </>
  );
  if (group.isRemote) return <Codicon name="cloud" style={s} />;
  if (group.isHead) return <Codicon name="git-branch" style={s} />;
  return <Codicon name="git-branch" style={s} />;
}


const skeletonStyles = {
  container: {
    flex: 1,
    minHeight: 0,
    position: 'relative' as const,
    overflowY: 'hidden' as const,
    overflowX: 'hidden' as const,
    background: 'var(--vscode-editor-background)',
    display: 'flex',
    flexDirection: 'column' as const,
    alignSelf: 'stretch' as const,
  },
  overlay: {
    position: 'absolute' as const,
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    color: 'var(--vscode-descriptionForeground)',
    background: 'color-mix(in srgb, var(--vscode-editor-background) 78%, transparent)',
    fontSize: '12px',
    pointerEvents: 'none' as const,
  } as React.CSSProperties,
  loadingIcon: {
    color: 'var(--vscode-progressBar-background)',
    fontSize: '15px',
  } as React.CSSProperties,
  row: (i: number, total: number): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    height: ROW_HEIGHT,
    paddingRight: '8px',
    flexShrink: 0,
    opacity: 1 - i * (0.6 / total),
    animation: `versiondock-skeleton-pulse 1.8s ease-in-out ${(i * 0.04).toFixed(2)}s infinite`,
  }),
  graph: {
    width: 24,
    height: 12,
    borderRadius: 6,
    background: 'var(--vscode-editor-foreground)',
    opacity: 0.1,
    flexShrink: 0,
  } as React.CSSProperties,
  message: (i: number): React.CSSProperties => ({
    flex: 1,
    height: 10,
    borderRadius: 5,
    background: 'var(--vscode-editor-foreground)',
    opacity: 0.08,
    maxWidth: `${55 + ((i * 37) % 30)}%`,
  }),
  meta: {
    width: 120,
    height: 10,
    borderRadius: 5,
    background: 'var(--vscode-editor-foreground)',
    opacity: 0.06,
    flexShrink: 0,
  } as React.CSSProperties,
};

const emptyStyles = {
  container: {
    flex: 1,
    minHeight: 0,
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '10px',
    color: 'var(--vscode-foreground)',
    background: 'var(--vscode-editor-background)',
  } as React.CSSProperties,
  icon: {
    fontSize: '28px',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  title: {
    fontSize: '13px',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
};

const styles = {
  frame: {
    flex: 1,
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    position: 'relative' as const,
    background: 'var(--vscode-editor-background)',
  } as React.CSSProperties,
  container: {
    flex: 1,
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
    position: 'relative' as const,
    background: 'var(--vscode-editor-background)',
    boxSizing: 'border-box',
  } as React.CSSProperties,
  repoStrip: (top: number, height: number, color: string, expanded: boolean): React.CSSProperties => ({
    position: 'absolute',
    top,
    left: 0,
    width: expanded ? REPO_LABEL_WIDTH_EXPANDED : REPO_LABEL_WIDTH,
    height,
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'stretch',
    cursor: 'pointer',
    zIndex: 3,
    userSelect: 'none' as const,
    overflow: 'hidden',
    borderRadius: expanded ? '0 3px 3px 0' : '0',
    background: expanded ? `${color}22` : 'transparent',
    border: expanded ? `1px solid ${color}55` : 'none',
    borderLeft: 'none',
    transition: 'width 0.15s ease, background 0.1s',
  }),
  repoStripBar: (color: string): React.CSSProperties => ({
    width: REPO_LABEL_WIDTH,
    minWidth: REPO_LABEL_WIDTH,
    height: '100%',
    background: color,
    flexShrink: 0,
  }),
  repoStripName: (offset: number): React.CSSProperties => ({
    alignSelf: 'flex-start',
    flex: 1,
    minWidth: 0,
    height: ROW_HEIGHT,
    boxSizing: 'border-box' as const,
    zIndex: 1,
    transform: `translateY(${offset}px)`,
    fontSize: '10px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--vscode-foreground)',
    whiteSpace: 'nowrap' as const,
    padding: '0 6px',
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis' as const,
    lineHeight: `${ROW_HEIGHT}px`,
  }),
  row: (top: number, selected: boolean, multiSelected = false, hovered = false, ctxActive = false): React.CSSProperties => ({
    position: 'absolute' as const,
    top,
    left: 0,
    right: 0,
    height: ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingRight: '8px',
    cursor: 'pointer',
    background: selected
      ? 'var(--vscode-list-activeSelectionBackground)'
      : multiSelected
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : ctxActive
      ? 'var(--vscode-list-inactiveSelectionBackground)'
      : hovered
      ? 'var(--vscode-list-hoverBackground)'
      : 'transparent',
    color: selected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    fontSize: '12px',
    zIndex: 2,
  }),
  refsMeasureRow: (labelColWidth: number): React.CSSProperties => ({
    position: 'absolute',
    visibility: 'hidden',
    pointerEvents: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    paddingRight: '8px',
    left: labelColWidth,
    right: 0,
    height: 0,
    overflow: 'hidden',
  }),
  refsMeasureFixed: {
    // Represents graph SVG + meta columns — fixed placeholder so refs gets compressed realistically.
    // 60px graph estimate + 180px meta estimate + some gap.
    flex: '1 3 0',
    minWidth: '300px',
    maxWidth: '500px',
  } as React.CSSProperties,
  info: {
    flex: '1 1 auto',
    display: 'flex',
    alignItems: 'center',
    overflow: 'hidden',
    minWidth: '60px',
  },
  refs: {
    display: 'flex',
    gap: '3px',
    flex: '0 0 auto',
    alignItems: 'center',
  },
  refBadge: (color: string, isTag: boolean, isHead = false, isRowSelected = false): React.CSSProperties => ({
    fontSize: '10px',
    padding: '0 6px',
    height: '16px',
    lineHeight: '16px',
    borderRadius: '3px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    background: isRowSelected ? color : `${color}33`,
    color: isRowSelected ? 'var(--vscode-editor-background)' : color,
    border: `1px solid ${isRowSelected ? color : `${color}88`}`,
    maxWidth: '160px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
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
  overflowLabel: (color: string, isRowSelected = false): React.CSSProperties => ({
    fontSize: '10px',
    fontWeight: 600,
    height: '16px',
    lineHeight: '14px',
    borderRadius: '3px',
    border: `1px solid ${isRowSelected ? color : `${color}88`}`,
    background: isRowSelected ? color : `color-mix(in srgb, var(--vscode-editor-background) 75%, ${color})`,
    color: isRowSelected ? 'var(--vscode-editor-background)' : color,
    padding: '0 5px',
    whiteSpace: 'nowrap',
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  }),
  message: (isMergeCommit = false, isSelected = false): React.CSSProperties => ({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flex: '1 1 0',
    minWidth: 0,
    // JetBrains de-emphasizes automatically generated merge commit messages.
    // Keep the selection foreground so selected rows remain readable.
    color: isSelected
      ? 'var(--vscode-list-activeSelectionForeground)'
      : isMergeCommit
      ? 'var(--vscode-descriptionForeground)'
      : 'inherit',
  }),
  meta: {
    display: 'flex',
    gap: '6px',
    alignItems: 'center',
    flex: '0 4 auto',
    maxWidth: '300px',
    minWidth: '20px',
    fontSize: '11px',
    overflow: 'hidden',
  },
  incomingIcon: {
    fontSize: '12px',
    color: 'var(--vscode-charts-blue, #64b5f6)',
    flexShrink: 0,
  } as React.CSSProperties,
  unpushedIcon: {
    fontSize: '12px',
    color: 'var(--vscode-gitDecoration-addedResourceForeground)',
    flexShrink: 0,
  } as React.CSSProperties,
  author: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 1,
    minWidth: 0,
  },
  date: {
    whiteSpace: 'nowrap' as const,
    flexShrink: 0,
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground)',
    marginLeft: '8px',
  },
  inlineActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '2px',
    flexShrink: 0,
    marginLeft: '4px',
  } as React.CSSProperties,
  inlineActionBtn: {
    width: '22px',
    height: '22px',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--vscode-foreground)',
    padding: 0,
    borderRadius: '3px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  } as React.CSSProperties,
  bgLoadingBar: {
    position: 'absolute' as const,
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    background: 'color-mix(in srgb, var(--vscode-progressBar-background) 15%, transparent)',
    overflow: 'hidden' as const,
    pointerEvents: 'none' as const,
    zIndex: 20,
  },
  bgLoadingBarFill: {
    height: '100%',
    width: '34%',
    background: 'var(--vscode-progressBar-background)',
    borderRadius: '999px',
    willChange: 'transform',
  } as React.CSSProperties,
  loadingMore: {
    position: 'absolute' as const,
    bottom: 8,
    left: '50%',
    transform: 'translateX(-50%)',
    zIndex: 21,
    minHeight: 26,
    padding: '0 10px',
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    border: '1px solid var(--vscode-widget-border, var(--vscode-panel-border))',
    borderRadius: '4px',
    background: 'var(--vscode-editorWidget-background, var(--vscode-editor-background))',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.28)',
    color: 'var(--vscode-foreground)',
    fontSize: '11px',
    whiteSpace: 'nowrap' as const,
    pointerEvents: 'none' as const,
  } as React.CSSProperties,
  loadingMoreIcon: {
    color: 'var(--vscode-progressBar-background)',
    fontSize: '14px',
  } as React.CSSProperties,
};
