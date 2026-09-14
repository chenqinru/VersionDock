import React, { useEffect, useCallback, useRef, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useLogStore, getCommitKey, type CommitFileEntry, type CommitFilters, type CommitSelectionMode, type CompareSide, type LogViewFileEntry, type LayoutDensity } from './store/logStore';
import { BranchSidebar } from './components/BranchSidebar';
import { CommitList } from './components/CommitList';
import { CommitDetail } from './components/CommitDetail';
import { CommitFiltersBar, type AuthorOption } from './components/CommitFiltersBar';
import { CompareView } from './components/CompareView';
import { assignLanes, type GraphLayoutData, type LaidOutCommit, type LaidOutGraphCommit } from './utils/graphLayout';
import { filterFilesForHistoryPath } from './utils/historyPath';
import { ResizeHandle } from '../shared/ResizeHandle';
import { useResize } from '../shared/useResize';
import { getVsCodeApi } from '../shared/vscodeApi';
import { t } from '../shared/i18n';
import { Codicon } from '../shared/Codicon';
import { scopedKey } from '../shared/scopedKey';
import { GLOBAL_DENSITY_STYLES } from '../shared/densityGlobalStyles';
import type { CommitNode } from '../shared/types';
import type { LogToHostMsg, HostToLogMsg } from '../../host/types/messages';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const LOG_PAGE_SIZE = 100;

// A branch or tag hides rows but preserves ancestry and can reuse the
// permanent --all layout. Content/date/path filters remove intermediate
// commits, so only those filters break topology.
function hasTopologyBreakingFilters(filters: CommitFilters): boolean {
  return !!(
    filters.text
    || filters.author
    || filters.dateFrom
    || filters.dateTo
    || filters.path
    || filters.lineRange
  );
}

function layoutVisibleCommits(
  commits: CommitNode[],
  graphCommits: LaidOutGraphCommit[],
  repoKindById: Readonly<Record<string, 'git' | 'svn'>>,
  remoteNamesByRepo: Readonly<Record<string, readonly string[]>>,
): LaidOutCommit[] {
  if (commits.length === 0) return [];
  if (graphCommits.length < commits.length) {
    return assignLanes(commits, false, repoKindById, remoteNamesByRepo);
  }

  const graphRowByKey = new Map<string, number>();
  graphCommits.forEach((commit, row) => {
    graphRowByKey.set(scopedKey(commit.repoId, commit.hash), row);
  });
  const matchesVisiblePrefix = commits.every((commit, row) => (
    graphRowByKey.get(scopedKey(commit.repoId, commit.hash)) === row
  ));
  if (!matchesVisiblePrefix) {
    return assignLanes(commits, false, repoKindById, remoteNamesByRepo);
  }

  const layoutByKey = new Map<string, GraphLayoutData>();
  for (const commit of graphCommits) {
    layoutByKey.set(scopedKey(commit.repoId, commit.hash), {
      lane: commit.lane,
      totalLanes: commit.totalLanes,
      graphLines: commit.graphLines,
      dotColor: commit.dotColor,
    });
  }

  return commits.map(commit => {
    const layout = layoutByKey.get(scopedKey(commit.repoId, commit.hash))!;
    return { ...commit, ...layout };
  });
}

function toViewFiles(repoId: string, hash: string, files: CommitFileEntry[]): LogViewFileEntry[] {
  return files.map(file => ({
    ...file,
    repoId,
    commitHash: hash,
  }));
}

interface CachedAuthorOption extends AuthorOption {
  commitKeys: Set<string>;
}

function reportWebviewError(message: string, stack?: string, componentStack?: string): void {
  try {
    getVsCodeApi().postMessage({
      type: 'LOG_WEBVIEW_ERROR',
      message,
      stack,
      componentStack,
    } satisfies LogToHostMsg);
  } catch {
    // Ignore reporting failures; the fallback UI below is still useful.
  }
}

function formatUnknownError(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

export function GitLogApp() {
  const store = useLogStore();
  const { setCommitFiles, setCommitFilters, setLoadingFiles, selectCommit, setPendingScrollHash } = store;
  const pendingRef = useRef<Map<string, (msg: HostToLogMsg) => void>>(new Map());
  const { panelRef: sidebarRef, onMouseDown: onSidebarResize, onKeyDown: onSidebarResizeKeyDown } = useResize('right', 220, 120, 400);
  const { panelRef: detailRef, onMouseDown: onDetailResize, onKeyDown: onDetailResizeKeyDown } = useResize('left', 320, 220, 680);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reloadRef = useRef<() => void>(() => {});
  const loadMoreRef = useRef<() => void>(() => {});
  const filterRepoRef = useRef<(repoId: string | null, branch?: string | null) => void>(() => {});
  const bgGenRef = useRef(0);
  const activeRequestIdRef = useRef<string | null>(null);
  const activeGraphRequestIdRef = useRef<string | null>(null);
  const activeCompareRequestIdsRef = useRef<Record<CompareSide, string | null>>({
    baseOnly: null,
    targetOnly: null,
  });
  const compareInitKeyRef = useRef('');
  const authorCacheRef = useRef<Map<string, CachedAuthorOption>>(new Map());
  const stableLaidOutCommitsRef = useRef<{ viewScope: string; commits: LaidOutCommit[] }>({
    viewScope: '',
    commits: [],
  });
  const [authorOptions, setAuthorOptions] = useState<AuthorOption[]>([]);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [detailCollapsed, setDetailCollapsed] = useState(false);
  const [expandedRepoIds, setExpandedRepoIds] = useState<Set<string>>(new Set());
  const isUndocked = (window as Window & { __VERSIONDOCK_APP_NAME__?: string }).__VERSIONDOCK_APP_NAME__ === 'undockedPanel';
  const layoutDensity = store.layoutDensity;
  const densityStyles = useMemo(() => getDensityStyles(layoutDensity), [layoutDensity]);

  const send = useCallback((msg: LogToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  const requestGraphCommits = useCallback((filters: CommitFilters, generation: number) => {
    if (hasTopologyBreakingFilters(filters)) {
      activeGraphRequestIdRef.current = null;
      useLogStore.getState().setLoadingGraphCommits(false);
      return;
    }
    const requestId = generateId();
    activeGraphRequestIdRef.current = requestId;
    useLogStore.getState().setLoadingGraphCommits(true);
    send({
      type: 'LOG_REQUEST_GRAPH_COMMITS',
      repoIds: filters.repoId ? [filters.repoId] : filters.repoIds,
      generation,
      requestId,
    });
  }, [send]);

  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const err = formatUnknownError(event.error ?? event.message);
      reportWebviewError(err.message, err.stack);
    };
    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      const err = formatUnknownError(event.reason);
      reportWebviewError(err.message, err.stack);
    };

    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
    };
  }, []);

  const requestCompareCommits = useCallback((side: CompareSide, append = false, overrides?: Partial<import('./store/logStore').ComparePaneState>) => {
    const state = useLogStore.getState();
    const compare = state.compareState;
    if (!compare) return;

    const pane = compare[side];
    if (append && (pane.loading || !pane.hasMore)) return;
    const filters = { ...pane, ...overrides };
    const requestId = generateId();
    const previousRequestId = activeCompareRequestIdsRef.current[side];
    if (previousRequestId) pendingRef.current.delete(previousRequestId);
    activeCompareRequestIdsRef.current[side] = requestId;
    const compareKey = scopedKey(compare.repoId, compare.baseRef, compare.targetRef);
    state.setComparePaneState(side, { loading: true }, append);
    const timeout = setTimeout(() => {
      if (pendingRef.current.has(requestId)) {
        pendingRef.current.delete(requestId);
        if (activeCompareRequestIdsRef.current[side] === requestId) {
          activeCompareRequestIdsRef.current[side] = null;
          useLogStore.getState().setComparePaneState(side, { loading: false }, append);
        }
      }
    }, 15_000);
    pendingRef.current.set(requestId, (msg) => {
      clearTimeout(timeout);
      if (msg.type !== 'LOG_COMPARE_COMMITS_RESULT' || msg.side !== side) return;
      if (activeCompareRequestIdsRef.current[side] !== requestId) return;
      activeCompareRequestIdsRef.current[side] = null;
      const freshState = useLogStore.getState();
      const freshCompare = freshState.compareState;
      if (!freshCompare || scopedKey(freshCompare.repoId, freshCompare.baseRef, freshCompare.targetRef) !== compareKey) return;
      freshState.setComparePaneState(side, {
        commits: msg.commits,
        hasMore: !msg.isLast,
        loading: false,
      }, append);
      if (msg.error) freshState.setError(msg.error);
    });
    send({
      type: 'LOG_REQUEST_COMPARE_COMMITS',
      requestId,
      repoId: compare.repoId,
      baseRef: compare.baseRef,
      targetRef: compare.targetRef,
      side,
      limit: LOG_PAGE_SIZE,
      skip: append ? pane.commits.length : 0,
      filterText: filters.filterText || undefined,
      filterAuthor: filters.filterAuthor || undefined,
      filterBranch: filters.filterBranch || undefined,
      filterDateFrom: filters.filterDateFrom || undefined,
      filterDateTo: filters.filterDateTo || undefined,
      filterPath: filters.filterPath || undefined,
    });
  }, [send]);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToLogMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;

      if ('requestId' in msg && msg.requestId && pendingRef.current.has(msg.requestId as string)) {
        const resolve = pendingRef.current.get(msg.requestId as string)!;
        pendingRef.current.delete(msg.requestId as string);
        resolve(msg);
      }

      switch (msg.type) {
        case 'LOG_INIT_DATA':
          store.setRepos(msg.repos, msg.hasWorkspaceFolder);
          store.setBranches(msg.branches, msg.isInitialPartial ?? false);
          if (msg.layoutDensity) store.setLayoutDensity(msg.layoutDensity);
          if (msg.iconTheme) store.setIconTheme(msg.iconTheme);
          break;
        case 'LOG_LAYOUT_DENSITY_UPDATE':
          store.setLayoutDensity(msg.layoutDensity);
          break;
        case 'LOG_ICON_THEME_UPDATE':
          store.setIconTheme(msg.iconTheme);
          break;
        case 'LOG_COMMITS_BATCH': {
          if (msg.requestId && activeRequestIdRef.current && msg.requestId !== activeRequestIdRef.current) break;
          if (msg.generation !== undefined && msg.generation !== bgGenRef.current) break;
          const hasErrors = !!(msg.repoErrors && msg.repoErrors.length > 0);
          if (hasErrors) {
            console.warn('[GitLog] Some repositories failed to load logs:', msg.repoErrors);
            store.setRepoErrors(msg.repoErrors ?? null);
          } else {
            store.setRepoErrors(null);
          }
          store.appendCommits(msg.commits, msg.isLast);
          if (msg.commits.length === 0 && !msg.isLast && !hasErrors) {
            loadMoreRef.current();
          }
          break;
        }
        case 'LOG_GRAPH_COMMITS':
          if (msg.requestId !== activeGraphRequestIdRef.current) break;
          if (msg.generation !== bgGenRef.current) break;
          activeGraphRequestIdRef.current = null;
          store.setGraphCommits(msg.commits);
          break;
        case 'LOG_REFS_UPDATE':
          store.updateBranches(msg.repoId, msg.branches);
          break;
        case 'LOG_TAGS_UPDATE':
          store.updateTags(msg.repoId, msg.tags);
          break;
        case 'LOG_REFRESH':
          reloadRef.current();
          break;
        case 'LOG_APPLY_HISTORY_FILTER': {
          const filters = {
            repoId: msg.repoId,
            repoIds: null,
            branch: '',
            path: msg.filePath,
            lineRange: msg.lineRange,
          };
          store.setCommitFilters(filters);
          reloadCommits(filters);
          break;
        }
        case 'LOG_SCROLL_TO_COMMIT':
          store.setPendingScrollHash(getCommitKey(msg.repoId, msg.hash));
          break;
        case 'LOG_COMPARE_STARTED':
          store.openCompare({
            repoId: msg.repoId,
            repoName: msg.repoName,
            baseRef: msg.baseRef,
            targetRef: msg.targetRef,
          });
          break;
        case 'LOG_FILTER_BY_REPO':
          filterRepoRef.current(msg.repoId, msg.branch ?? null);
          break;
        case 'LOG_REMOTES_RESULT':
          break;
        default:
          break;
      }
    };

    window.addEventListener('message', handler);
    store.beginCommitsReload();
    const requestId = generateId();
    activeRequestIdRef.current = requestId;
    send({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: null,
      limit: LOG_PAGE_SIZE,
      skip: 0,
      generation: bgGenRef.current,
      requestId,
    });
    requestGraphCommits(useLogStore.getState().commitFilters, bgGenRef.current);

    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (store.mode !== 'compare' || !store.compareState) {
      compareInitKeyRef.current = '';
      for (const side of ['baseOnly', 'targetOnly'] as const) {
        const requestId = activeCompareRequestIdsRef.current[side];
        if (requestId) pendingRef.current.delete(requestId);
        activeCompareRequestIdsRef.current[side] = null;
      }
      return;
    }
    const compareKey = scopedKey(store.compareState.repoId, store.compareState.baseRef, store.compareState.targetRef);
    if (compareInitKeyRef.current === compareKey) return;
    compareInitKeyRef.current = compareKey;
    requestCompareCommits('baseOnly');
    requestCompareCommits('targetOnly');
  }, [requestCompareCommits, store.compareState, store.mode]);

  const reloadCommits = useCallback((overrides?: Partial<import('./store/logStore').CommitFilters>) => {
    bgGenRef.current += 1;
    const requestId = generateId();
    activeRequestIdRef.current = requestId;
    authorCacheRef.current.clear();
    setAuthorOptions([]);

    const f = { ...useLogStore.getState().commitFilters, ...overrides };
    useLogStore.getState().beginCommitsReload();
    send({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: f.repoId ? [f.repoId] : f.repoIds,
      limit: LOG_PAGE_SIZE,
      skip: 0,
      generation: bgGenRef.current,
      requestId,
      filterText: f.text || undefined,
      filterAuthor: f.author || undefined,
      filterBranch: f.branch || undefined,
      filterDateFrom: f.dateFrom || undefined,
      filterDateTo: f.dateTo || undefined,
      filterPath: f.path || undefined,
      lineRange: f.lineRange,
    });
    requestGraphCommits(f, bgGenRef.current);
  }, [requestGraphCommits, send]);

  const reloadCompare = useCallback(() => {
    if (!useLogStore.getState().compareState) return;
    requestCompareCommits('baseOnly');
    requestCompareCommits('targetOnly');
  }, [requestCompareCommits]);

  reloadRef.current = () => {
    if (useLogStore.getState().mode === 'compare') {
      reloadCompare();
      return;
    }
    reloadCommits();
  };

  const handleLoadMore = useCallback(() => {
    const s = useLogStore.getState();
    if (s.loadingCommits || s.backgroundLoading || !s.hasMore) return;
    const f = s.commitFilters;
    s.setBackgroundLoading(true);
    send({
      type: 'LOG_REQUEST_COMMITS',
      repoIds: f.repoId ? [f.repoId] : f.repoIds,
      limit: LOG_PAGE_SIZE,
      skip: s.commits.length,
      generation: bgGenRef.current,
      requestId: activeRequestIdRef.current ?? undefined,
      filterText: f.text || undefined,
      filterAuthor: f.author || undefined,
      filterBranch: f.branch || undefined,
      filterDateFrom: f.dateFrom || undefined,
      filterDateTo: f.dateTo || undefined,
      filterPath: f.path || undefined,
      lineRange: f.lineRange,
    });
  }, [send]);

  loadMoreRef.current = handleLoadMore;

  const compareCommits = useMemo(() => (
    store.compareState
      ? [...store.compareState.baseOnly.commits, ...store.compareState.targetOnly.commits]
      : []
  ), [store.compareState]);

  const activeCommitSource = store.mode === 'compare' ? compareCommits : store.commits;
  const isCommitListReloading = store.mode === 'log' && store.loadingCommits;

  const selectedCommits = useMemo(() => {
    const selected = new Set(store.selectedCommitHashes);
    const seen = new Set<string>();
    return activeCommitSource.filter(commit => {
      const key = getCommitKey(commit.repoId, commit.hash);
      if (!selected.has(key) || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [activeCommitSource, store.selectedCommitHashes]);

  const primarySelectedCommit = useMemo(() => (
    store.primarySelectedHash
      ? activeCommitSource.find(commit => getCommitKey(commit.repoId, commit.hash) === store.primarySelectedHash) ?? null
      : null
  ), [activeCommitSource, store.primarySelectedHash]);

  useEffect(() => {
    if (isCommitListReloading && store.commits.length === 0) return;
    selectedCommits.forEach(commit => {
      const key = getCommitKey(commit.repoId, commit.hash);
      if (store.commitFilesByKey[key] || store.loadingFilesByKey[key]) return;
      setLoadingFiles(commit.repoId, commit.hash, true);
      const requestId = generateId();
      const timeout = setTimeout(() => {
        if (pendingRef.current.has(requestId)) {
          pendingRef.current.delete(requestId);
          setLoadingFiles(commit.repoId, commit.hash, false);
        }
      }, 15_000);
      pendingRef.current.set(requestId, (msg) => {
        clearTimeout(timeout);
        if (msg.type === 'LOG_COMMIT_FILES') {
          setCommitFiles(commit.repoId, commit.hash, msg.files, msg.mergeParentChanges);
        }
      });
      getVsCodeApi().postMessage({
        type: 'LOG_REQUEST_COMMIT_FILES',
        requestId,
        repoId: commit.repoId,
        hash: commit.hash,
        parents: commit.parents,
        includeMergeParentChanges: commit.parents.length >= 2,
        prefetchContent: true,
      } satisfies LogToHostMsg);
    });
  }, [isCommitListReloading, selectedCommits, setCommitFiles, setLoadingFiles, store.commitFilesByKey, store.commits.length, store.loadingFilesByKey]);

  const repoColors = useMemo(() => {
    const map: Record<string, string> = {};
    store.repos.forEach(repo => { map[repo.id] = repo.color; });
    return map;
  }, [store.repos]);
  const repoKindById = useMemo<Record<string, 'git' | 'svn'>>(() => (
    Object.fromEntries(store.repos.map(repo => [repo.id, repo.kind ?? 'git']))
  ), [store.repos]);
  const remoteNamesByRepo = useMemo<Record<string, string[]>>(() => {
    const namesByRepo = new Map<string, Set<string>>();
    for (const branch of store.branches) {
      if (!branch.isRemote || !branch.remoteName) continue;
      const names = namesByRepo.get(branch.repoId) ?? new Set<string>();
      names.add(branch.remoteName);
      namesByRepo.set(branch.repoId, names);
    }
    return Object.fromEntries(
      Array.from(namesByRepo, ([repoId, names]) => [repoId, Array.from(names).sort((a, b) => b.length - a.length)]),
    );
  }, [store.branches]);

  const hasTopologyBreakingFilter = hasTopologyBreakingFilters(store.commitFilters);
  const hasRevisionFilter = !!store.commitFilters.branch;
  const viewScope = useMemo(() => JSON.stringify({
    repoIds: store.repos.map(repo => repo.id).sort(),
    filters: store.commitFilters,
  }), [store.commitFilters, store.repos]);
  const laidOutGraphCommits = useMemo(
    () => assignLanes(store.graphCommits, false, repoKindById, remoteNamesByRepo),
    [store.graphCommits, remoteNamesByRepo, repoKindById],
  );
  const laidOutCommits = useMemo(
    () => {
      if (isCommitListReloading && store.commits.length === 0) return [];
      if (store.commits.length === 0) return [];
      if (hasTopologyBreakingFilter) {
        return assignLanes(store.commits, true, repoKindById, remoteNamesByRepo);
      }
      if (hasRevisionFilter) {
        return assignLanes(
          store.commits,
          false,
          repoKindById,
          remoteNamesByRepo,
          store.graphCommits.length > 0 ? store.graphCommits : undefined,
        );
      }
      if (laidOutGraphCommits.length === 0) {
        // Provisional layout while graph commits are arriving in background:
        // Render commits immediately to make first screen instant!
        return assignLanes(store.commits, false, repoKindById, remoteNamesByRepo);
      }
      return layoutVisibleCommits(
        store.commits,
        laidOutGraphCommits,
        repoKindById,
        remoteNamesByRepo,
      );
    },
    [
      store.commits,
      store.graphCommits,
      isCommitListReloading,
      laidOutGraphCommits,
      hasRevisionFilter,
      hasTopologyBreakingFilter,
      remoteNamesByRepo,
      repoKindById,
    ],
  );
  useEffect(() => {
    if (store.mode !== 'log' || isCommitListReloading) return;
    stableLaidOutCommitsRef.current = { viewScope, commits: laidOutCommits };
  }, [isCommitListReloading, laidOutCommits, store.mode, viewScope]);
  const preservesVisibleContent = isCommitListReloading
    && stableLaidOutCommitsRef.current.viewScope === viewScope
    && stableLaidOutCommitsRef.current.commits.length > 0;
  const visibleLaidOutCommits = preservesVisibleContent
    ? stableLaidOutCommitsRef.current.commits
    : laidOutCommits;
  const laidOutCompareBase = useMemo(() => (
    store.compareState ? assignLanes(store.compareState.baseOnly.commits, true, repoKindById, remoteNamesByRepo) : []
  ), [remoteNamesByRepo, repoKindById, store.compareState]);
  const laidOutCompareTarget = useMemo(() => (
    store.compareState ? assignLanes(store.compareState.targetOnly.commits, true, repoKindById, remoteNamesByRepo) : []
  ), [remoteNamesByRepo, repoKindById, store.compareState]);

  const currentBranchByRepo = useMemo(() => {
    const map: Record<string, string> = {};
    store.branches.forEach(branch => {
      if (branch.isHead && !branch.isRemote) map[branch.repoId] = branch.name;
    });
    return map;
  }, [store.branches]);

  const headHashByRepo = useMemo(() => {
    const map: Record<string, string> = {};
    store.branches.forEach(branch => {
      if (branch.isHead && !branch.isRemote && branch.lastCommitHash) map[branch.repoId] = branch.lastCommitHash;
    });
    return map;
  }, [store.branches]);

  const sortedSelectedCommits = useMemo(() => {
    const indexByHash = new Map<string, number>();
    activeCommitSource.forEach((commit, index) => indexByHash.set(getCommitKey(commit.repoId, commit.hash), index));
    return [...selectedCommits].sort((a, b) => (
      (indexByHash.get(getCommitKey(a.repoId, a.hash)) ?? 0)
      - (indexByHash.get(getCommitKey(b.repoId, b.hash)) ?? 0)
    ));
  }, [activeCommitSource, selectedCommits]);

  const selectedCommitFiles = useMemo(() => {
    if (isCommitListReloading && !preservesVisibleContent) return [];
    const historyPath = store.commitFilters.path;
    return sortedSelectedCommits.flatMap(commit => {
      const files = toViewFiles(
        commit.repoId,
        commit.hash,
        store.commitFilesByKey[getCommitKey(commit.repoId, commit.hash)] ?? [],
      );
      return historyPath ? filterFilesForHistoryPath(files, historyPath) : files;
    });
  }, [isCommitListReloading, preservesVisibleContent, sortedSelectedCommits, store.commitFilesByKey, store.commitFilters.path]);

  const aggregatedFiles = useMemo(() => {
    if (sortedSelectedCommits.length <= 1) return selectedCommitFiles;

    const ordered = [...selectedCommitFiles].reverse();
    const fileMap = new Map<string, LogViewFileEntry>();
    for (const file of ordered) {
      const key = scopedKey(file.repoId, file.path);
      const existing = fileMap.get(key);
      if (!existing) {
        fileMap.set(key, { ...file });
        continue;
      }
      const existingAdded = existing.added ?? 0;
      const existingRemoved = existing.removed ?? 0;
      fileMap.set(key, {
        ...file,
        added: (file.added ?? 0) + existingAdded || undefined,
        removed: (file.removed ?? 0) + existingRemoved || undefined,
      });
    }
    return Array.from(fileMap.values());
  }, [selectedCommitFiles, sortedSelectedCommits.length]);

  const selectedCommitFilesByPath = useMemo(() => {
    const map: Record<string, LogViewFileEntry[]> = {};
    for (const file of selectedCommitFiles) {
      const key = scopedKey(file.repoId, file.path);
      if (!map[key]) map[key] = [];
      map[key].push(file);
    }
    return map;
  }, [selectedCommitFiles]);

  const selectedRepoColor = primarySelectedCommit ? repoColors[primarySelectedCommit.repoId] : undefined;
  const hasSelectedCommit = sortedSelectedCommits.length > 0;
  const isMultiCommitSelection = sortedSelectedCommits.length > 1;
  const mergeParentChanges = !isMultiCommitSelection && primarySelectedCommit
    ? store.mergeParentChangesByKey[getCommitKey(primarySelectedCommit.repoId, primarySelectedCommit.hash)] ?? []
    : [];
  const detailLoading = (isCommitListReloading && !preservesVisibleContent)
    || sortedSelectedCommits.some(commit => {
      const key = getCommitKey(commit.repoId, commit.hash);
      return store.commitFilesByKey[key] === undefined || store.loadingFilesByKey[key];
    });
  const filterRepos = useMemo(() => (
    store.mode === 'compare' && store.compareState
      ? store.repos.filter(repo => repo.id === store.compareState!.repoId)
      : store.repos
  ), [store.compareState, store.mode, store.repos]);

  const repoNamesExpanded = store.repos.length > 1 && store.repos.every(repo => expandedRepoIds.has(repo.id));
  const toggleAllRepoNames = useCallback(() => {
    setExpandedRepoIds(current => {
      const allExpanded = store.repos.length > 1 && store.repos.every(repo => current.has(repo.id));
      return allExpanded ? new Set() : new Set(store.repos.map(repo => repo.id));
    });
  }, [store.repos]);
  const toggleRepoName = useCallback((repoId: string) => {
    setExpandedRepoIds(current => {
      const next = new Set(current);
      if (next.has(repoId)) next.delete(repoId); else next.add(repoId);
      return next;
    });
  }, []);

  useEffect(() => {
    let changed = false;
    const cache = authorCacheRef.current;
    for (const commit of store.commits) {
      const name = commit.authorName || commit.authorEmail;
      const email = commit.authorEmail;
      const value = email || name;
      if (!value) continue;
      const commitKey = getCommitKey(commit.repoId, commit.hash);
      const current = cache.get(value);
      if (current) {
        if (!current.commitKeys.has(commitKey)) {
          current.commitKeys.add(commitKey);
          current.count = current.commitKeys.size;
          changed = true;
        }
      } else {
        cache.set(value, { name, email, value, count: 1, commitKeys: new Set([commitKey]) });
        changed = true;
      }
    }
    if (!changed) return;
    setAuthorOptions(
      Array.from(cache.values())
        .map(({ commitKeys: _commitKeys, ...option }) => option)
        .sort((left, right) => left.name.localeCompare(right.name))
    );
  }, [store.commits]);

  const handleFilterChange = useCallback((key: Exclude<keyof import('./store/logStore').CommitFilters, 'repoIds'>, value: string) => {
    if (store.mode === 'compare' && key === 'branch') return;
    const scopeReset = key === 'branch' ? { repoIds: null } : {};
    setCommitFilters({ [key]: value, ...scopeReset });
    if (key === 'text' || key === 'author') {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      searchDebounceRef.current = setTimeout(() => reloadCommits({ [key]: value, ...scopeReset }), 0);
    } else {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      reloadCommits({ [key]: value, ...scopeReset });
    }
  }, [reloadCommits, setCommitFilters, store.mode]);

  const handleRepoChange = useCallback((repoId: string | null) => {
    setCommitFilters({ repoId, repoIds: null });
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits({ repoId, repoIds: null });
  }, [reloadCommits, setCommitFilters]);

  filterRepoRef.current = (repoId: string | null, branch?: string | null) => {
    const filters: { repoId: string | null; repoIds: null; branch?: string; path?: string; lineRange?: undefined } = { repoId, repoIds: null };
    filters.branch = branch ?? '';
    filters.path = '';
    filters.lineRange = undefined;
    store.setCommitFilters(filters);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits(filters);
  };

  const handleClearFilters = useCallback(() => {
    const cleared = { text: '', author: '', branch: '', dateFrom: '', dateTo: '', repoId: null, repoIds: null, path: '', lineRange: undefined };
    setCommitFilters(cleared);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    reloadCommits(cleared);
  }, [reloadCommits, setCommitFilters]);

  const handleSelectCommit = useCallback((commit: LaidOutCommit, mode: CommitSelectionMode) => {
    selectCommit(commit, mode);
  }, [selectCommit]);

  const handleScrolledToHash = useCallback(() => {
    setPendingScrollHash(null);
  }, [setPendingScrollHash]);

  const showNoRepo = store.repos.length === 0 && store.initialized;
  const noRepoOverlay = showNoRepo ? (
    <div style={noRepoOverlayStyle}>
      {!store.hasWorkspaceFolder ? (
        <>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5' }}>
            {t('You have not yet opened a folder.')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '220px' }}>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_OPEN_FOLDER' })}>{t('Open Folder')}</button>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_CLONE_REPO' })}>{t('Clone Git Repository...')}</button>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_CHECKOUT_SVN_REPO' })}>{t('Checkout SVN Repository...')}</button>
          </div>
        </>
      ) : (
        <>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5' }}>
            {t("The folder currently open doesn't have a Git or SVN repository. You can initialize a local repository, or clone / checkout from Git or SVN.")}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '220px' }}>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_INIT_REPO' })}>
              {t('Initialize Git Repository')}
            </button>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_CLONE_REPO' })}>
              {t('Clone Git Repository...')}
            </button>
            <button style={initRepoBtnStyle} onClick={() => send({ type: 'LOG_CHECKOUT_SVN_REPO' })}>
              {t('Checkout SVN Repository...')}
            </button>
          </div>
        </>
      )}
    </div>
  ) : null;

  return (
    <div
      style={{ ...appStyle, position: 'relative' }}
      data-density={layoutDensity}
      className="versiondock-log-root"
      onContextMenu={event => event.preventDefault()}
    >
      <style>{GLOBAL_DENSITY_STYLES}</style>
      {noRepoOverlay}
      {store.mode !== 'compare' && (
        <CommitFiltersBar
          filters={store.commitFilters}
          branches={store.branches}
          tags={store.tags}
          repos={filterRepos}
          authorOptions={authorOptions}
          onFilterChange={handleFilterChange}
          onRepoChange={handleRepoChange}
          onClear={handleClearFilters}
          onFetchAll={() => send({ type: 'LOG_FETCH_ALL' })}
          repoNamesExpanded={repoNamesExpanded}
          onToggleRepoNames={toggleAllRepoNames}
          onUndock={(target) => send({ type: 'LOG_UNDOCK', target })}
          hideUndock={isUndocked}
          disableBranchFilter={false}
        />
      )}

      <div style={{
        ...densityStyles.mainLayout,
        ...(store.mode === 'compare' && layoutDensity !== 'compact' ? { paddingTop: '6px' } : {}),
        visibility: showNoRepo ? 'hidden' : 'visible',
      }}>
        {sidebarCollapsed ? (
          <div style={densityStyles.collapsedSidebarStrip}>
            <button data-top-action-btn="" style={expandSidebarBtn} onClick={() => setSidebarCollapsed(false)} title={t('Expand sidebar')}>
              <Codicon name="layout-sidebar-left-off" style={{ fontSize: '14px' }} />
            </button>
          </div>
        ) : (
          <>
            <BranchSidebar
              ref={sidebarRef}
              repos={store.repos.filter(repo => !repo.isWorktree)}
              branches={store.branches}
              tags={store.tags}
              loading={!store.initialized || store.loadingBranches}
              filter={store.branchFilter}
              selectedBranchFilter={store.commitFilters.branch}
              selectedBranchRepoIds={store.commitFilters.repoIds}
              selectedRepoId={store.commitFilters.repoId}
              onFilterChange={store.setBranchFilter}
              onBranchFilterSelect={(branchName: string, repoIds: string[]) => {
                const filters = { branch: branchName, repoId: null, repoIds };
                setCommitFilters(filters);
                if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
                reloadCommits(filters);
              }}
              onRepoFilterSelect={handleRepoChange}
              onCheckout={(repoIds, branch) => {
                repoIds.forEach(repoId => {
                  getVsCodeApi().postMessage({ type: 'LOG_CHECKOUT', requestId: generateId(), repoId, branchName: branch } satisfies LogToHostMsg);
                });
              }}
              onMerge={(repoId, from) => {
                getVsCodeApi().postMessage({ type: 'LOG_MERGE', requestId: generateId(), repoId, from } satisfies LogToHostMsg);
              }}
              onRebase={(repoId, onto) => {
                getVsCodeApi().postMessage({ type: 'LOG_REBASE', requestId: generateId(), repoId, onto } satisfies LogToHostMsg);
              }}
              onCompareWithCurrent={(branches) => {
                getVsCodeApi().postMessage({ type: 'LOG_COMPARE_WITH_CURRENT', branches } satisfies LogToHostMsg);
              }}
              onShowWorktreeDiff={(branches) => {
                getVsCodeApi().postMessage({ type: 'LOG_SHOW_WORKTREE_DIFF', branches } satisfies LogToHostMsg);
              }}
              onDelete={(repoIds, branchName) => {
                getVsCodeApi().postMessage({ type: 'LOG_DELETE_BRANCH_MULTI', requestId: generateId(), repoIds, branchName } satisfies LogToHostMsg);
              }}
              onFetchRepo={(repoId) => {
                getVsCodeApi().postMessage({ type: 'LOG_FETCH_REPO', requestId: generateId(), repoId } satisfies LogToHostMsg);
              }}
              onPull={(repoId, branchName) => {
                getVsCodeApi().postMessage({ type: 'LOG_PULL', requestId: generateId(), repoId, branchName } satisfies LogToHostMsg);
              }}
              onPush={(repoId) => {
                getVsCodeApi().postMessage({ type: 'LOG_PUSH_PICK', repoId } satisfies LogToHostMsg);
              }}
              onCheckoutTag={(repoIds, tagName) => {
                repoIds.forEach(repoId => {
                  getVsCodeApi().postMessage({ type: 'LOG_CHECKOUT_TAG', requestId: generateId(), repoId, tagName } satisfies LogToHostMsg);
                });
              }}
              onMergeTag={(repoIds, tagName) => {
                getVsCodeApi().postMessage({ type: 'LOG_MERGE_TAG_MULTI', requestId: generateId(), repoIds, tagName } satisfies LogToHostMsg);
              }}
              onPushTag={(repoId, tagName) => {
                getVsCodeApi().postMessage({ type: 'LOG_PUSH_TAG_PICK', repoId, tagName } satisfies LogToHostMsg);
              }}
              onDeleteTag={(repoIds, tagName) => {
                getVsCodeApi().postMessage({ type: 'LOG_DELETE_TAG_MULTI', requestId: generateId(), repoIds, tagName } satisfies LogToHostMsg);
              }}
              onCollapse={() => setSidebarCollapsed(true)}
            />
            <ResizeHandle onMouseDown={onSidebarResize} onKeyDown={onSidebarResizeKeyDown} style={densityStyles.resizeHandleStyle} />
          </>
        )}

        {store.mode === 'compare' && store.compareState ? (
          <CompareView
            compareState={store.compareState}
            repoColors={repoColors}
            repos={filterRepos}
            authorOptions={authorOptions}
            currentBranchByRepo={currentBranchByRepo}
            remoteNamesByRepo={remoteNamesByRepo}
            baseCommits={laidOutCompareBase}
            targetCommits={laidOutCompareTarget}
            selectedHashes={store.selectedCommitHashes}
            primarySelectedHash={store.primarySelectedHash}
            onSelectCommit={(side, commit, mode) => {
              const source = side === 'baseOnly'
                ? store.compareState?.baseOnly.commits
                : store.compareState?.targetOnly.commits;
              store.selectCommit(commit, mode, source);
            }}
            onLoadMore={(side) => {
              requestCompareCommits(side, true);
            }}
            onFilterChange={(side, partial) => {
              store.setComparePaneState(side, partial);
              requestCompareCommits(side, false, partial);
            }}
            onClose={() => {
              store.closeCompare();
              reloadCommits();
            }}
          />
        ) : (
          <CommitList
            commits={visibleLaidOutCommits}
            selectedHashes={store.selectedCommitHashes}
            primarySelectedHash={store.primarySelectedHash}
            repos={store.repos}
            currentBranchByRepo={currentBranchByRepo}
            headHashByRepo={headHashByRepo}
            remoteNamesByRepo={remoteNamesByRepo}
            onSelect={handleSelectCommit}
            onLoadMore={handleLoadMore}
            onRetry={reloadCommits}
            hasMore={store.hasMore && !isCommitListReloading && !store.backgroundLoading}
            storeHasMore={store.hasMore}
            loading={isCommitListReloading && store.commits.length === 0}
            backgroundLoading={store.backgroundLoading || store.loadingGraphCommits}
            expandedRepoIds={expandedRepoIds}
            onToggleRepoName={toggleRepoName}
            scrollToHash={store.pendingScrollHash}
            onScrolledToHash={handleScrolledToHash}
          />
        )}

        {hasSelectedCommit && (
          detailCollapsed ? (
            <div style={densityStyles.collapsedDetailStrip}>
              <button
                data-top-action-btn=""
                style={expandSidebarBtn}
                onClick={() => setDetailCollapsed(false)}
                title={t('Expand commit detail')}
              >
                <Codicon name="layout-sidebar-right-off" style={{ fontSize: '14px' }} />
              </button>
            </div>
          ) : (
            <>
              <ResizeHandle onMouseDown={onDetailResize} onKeyDown={onDetailResizeKeyDown} style={densityStyles.resizeHandleStyle} />
              <div ref={detailRef} style={densityStyles.detailPane}>
                <CommitDetail
                  commit={primarySelectedCommit}
                  commits={sortedSelectedCommits}
                  files={aggregatedFiles}
                  mergeParentChanges={mergeParentChanges}
                  groupedEntries={selectedCommitFilesByPath}
                  selectedFile={store.selectedFile}
                  loadingFiles={detailLoading}
                  repoColor={selectedRepoColor}
                  repos={store.repos}
                  remoteNamesByRepo={remoteNamesByRepo}
                  iconTheme={store.iconTheme}
                  isMultiCommitSelection={isMultiCommitSelection}
                  activeHistoryPath={store.commitFilters.path}
                  activeLineRange={store.commitFilters.lineRange}
                  layoutDensity={layoutDensity}
                  onSelectFile={store.selectFile}
                  onCollapse={() => setDetailCollapsed(true)}
                />
              </div>
            </>
          )
        )}
      </div>
    </div>
  );
}

const noRepoOverlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, zIndex: 10,
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  gap: '12px', padding: '24px',
  background: 'var(--vscode-sideBar-background)', color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
};

const initRepoBtnStyle: React.CSSProperties = {
  background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
  border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
  fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: 500,
};

const appStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--vscode-editor-background)',
  color: 'var(--vscode-foreground)',
  fontFamily: 'var(--vscode-font-family)',
  fontSize: 'var(--vscode-font-size)',
  overflow: 'hidden',
  userSelect: 'none',
};

function getDensityStyles(density: LayoutDensity) {
  if (density === 'compact') {
    return {
      mainLayout: {
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
        userSelect: 'none',
        padding: 0,
        boxSizing: 'border-box',
      } as React.CSSProperties,
      collapsedSidebarStrip: {
        width: '28px',
        flexShrink: 0,
        borderRight: '1px solid var(--vscode-panel-border)',
        background: 'var(--vscode-sideBar-background)',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '6px',
        boxSizing: 'border-box',
      } as React.CSSProperties,
      collapsedDetailStrip: {
        width: '28px',
        flexShrink: 0,
        borderLeft: '1px solid var(--vscode-panel-border)',
        background: 'var(--vscode-sideBar-background)',
        display: 'flex',
        justifyContent: 'center',
        paddingTop: '6px',
        boxSizing: 'border-box',
      } as React.CSSProperties,
      detailPane: {
        width: '320px',
        flexShrink: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        userSelect: 'text',
        borderLeft: '1px solid var(--vscode-panel-border)',
        background: 'var(--vscode-editor-background)',
        boxSizing: 'border-box',
      } as React.CSSProperties,
      resizeHandleStyle: {
        width: '4px',
        borderRadius: 0,
      } as React.CSSProperties,
    };
  }

  return {
    mainLayout: {
      display: 'flex',
      flex: 1,
      overflow: 'hidden',
      userSelect: 'none',
      padding: '0 6px 6px 6px',
      boxSizing: 'border-box',
    } as React.CSSProperties,
    collapsedSidebarStrip: {
      width: '28px',
      flexShrink: 0,
      border: '1px solid var(--vscode-panel-border)',
      borderRadius: '8px',
      background: 'var(--vscode-sideBar-background)',
      display: 'flex',
      justifyContent: 'center',
      paddingTop: '6px',
      marginRight: '6px',
      boxSizing: 'border-box',
    } as React.CSSProperties,
    collapsedDetailStrip: {
      width: '28px',
      flexShrink: 0,
      border: '1px solid var(--vscode-panel-border)',
      borderRadius: '8px',
      background: 'var(--vscode-sideBar-background)',
      display: 'flex',
      justifyContent: 'center',
      paddingTop: '6px',
      marginLeft: '6px',
      boxSizing: 'border-box',
    } as React.CSSProperties,
    detailPane: {
      width: '320px',
      flexShrink: 0,
      overflow: 'hidden',
      display: 'flex',
      flexDirection: 'column',
      userSelect: 'text',
      borderRadius: '8px',
      border: '1px solid var(--vscode-panel-border)',
      background: 'var(--vscode-editor-background)',
      boxSizing: 'border-box',
    } as React.CSSProperties,
    resizeHandleStyle: {
      width: '6px',
      borderRadius: '3px',
    } as React.CSSProperties,
  };
}

const expandSidebarBtn: React.CSSProperties = {
  width: '22px',
  height: '22px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 'none',
  borderRadius: '3px',
  background: 'transparent',
  color: 'var(--vscode-descriptionForeground)',
  cursor: 'pointer',
};

class GitLogErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    const err = formatUnknownError(error);
    return { error: [err.message, err.stack].filter(Boolean).join('\n') };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    const err = formatUnknownError(error);
    reportWebviewError(err.message, err.stack, info.componentStack ?? undefined);
  }

  render(): React.ReactNode {
    if (this.state.error) {
      return (
        <div style={errorFallbackStyle}>
          <div style={errorTitleStyle}>{t('Git Log render failed')}</div>
          <pre style={errorBodyStyle}>{this.state.error}</pre>
        </div>
      );
    }

    return this.props.children;
  }
}

const errorFallbackStyle: React.CSSProperties = {
  height: '100vh',
  boxSizing: 'border-box',
  padding: '12px',
  overflow: 'auto',
  background: 'var(--vscode-editor-background)',
  color: 'var(--vscode-errorForeground, #f48771)',
  fontFamily: 'var(--vscode-font-family)',
  userSelect: 'text',
};

const errorTitleStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 600,
  marginBottom: '8px',
};

const errorBodyStyle: React.CSSProperties = {
  margin: 0,
  whiteSpace: 'pre-wrap',
  fontSize: '11px',
  lineHeight: 1.45,
  fontFamily: 'var(--vscode-editor-font-family, monospace)',
};

if ((window as Window & { __VERSIONDOCK_APP_NAME__?: string }).__VERSIONDOCK_APP_NAME__ !== 'undockedPanel') {
  createRoot(document.getElementById('root')!).render(
    <GitLogErrorBoundary>
      <GitLogApp />
    </GitLogErrorBoundary>
  );
}
