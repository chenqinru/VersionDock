import { create } from 'zustand';
import type { BranchInfo, CommitNode, FileDiff, LineRange, RepoMeta, TagInfo } from '../../shared/types';
import type { CompareSide, IconThemeData } from '../../../host/types/messages';

export type { CompareSide };

export interface CommitFilters {
  text: string;
  author: string;
  branch: string;
  dateFrom: string;
  dateTo: string;
  repoId: string | null;
  path: string;
  lineRange?: LineRange;
}

export interface CommitFileEntry {
  path: string;
  status: string;
  added?: number;
  removed?: number;
}

export interface LogViewFileEntry extends CommitFileEntry {
  repoId: string;
  commitHash: string;
}

export type CommitSelectionMode = 'single' | 'toggle' | 'range';

export interface ComparePaneState {
  commits: CommitNode[];
  hasMore: boolean;
  loading: boolean;
  filterText: string;
  filterAuthor: string;
  filterBranch: string;
  filterDateFrom: string;
  filterDateTo: string;
  filterPath: string;
}

export interface CompareState {
  repoId: string;
  repoName: string;
  baseRef: string;
  targetRef: string;
  baseOnly: ComparePaneState;
  targetOnly: ComparePaneState;
}

interface LogState {
  repos: RepoMeta[];
  initialized: boolean;
  branches: BranchInfo[];
  tags: TagInfo[];
  iconTheme: IconThemeData | null;
  mode: 'log' | 'compare';
  commits: CommitNode[];
  hasMore: boolean;
  selectedCommitHashes: string[];
  primarySelectedHash: string | null;
  selectionAnchorHash: string | null;
  selectedFile: { repoId: string; path: string; status: string; commitHash?: string } | null;
  commitFilesByKey: Record<string, CommitFileEntry[]>;
  currentDiff: FileDiff | null;
  loadingCommits: boolean;
  backgroundLoading: boolean;
  loadingFilesByKey: Record<string, boolean>;
  loadingDiff: boolean;
  filterRepoId: string | null;
  branchFilter: string;
  commitFilters: CommitFilters;
  error: string | null;
  pendingScrollHash: string | null;
  replaceCommitsOnNextBatch: boolean;
  compareState: CompareState | null;

  hasWorkspaceFolder: boolean;
  setRepos: (repos: RepoMeta[], hasWorkspaceFolder?: boolean) => void;
  setBranches: (branches: BranchInfo[]) => void;
  updateTags: (repoId: string, tags: TagInfo[]) => void;
  setIconTheme: (theme: IconThemeData | null) => void;
  appendCommits: (commits: CommitNode[], isLast: boolean) => void;
  beginCommitsReload: () => void;
  openCompare: (compareState: Omit<CompareState, 'baseOnly' | 'targetOnly'>) => void;
  closeCompare: () => void;
  setComparePaneState: (side: CompareSide, pane: Partial<ComparePaneState>, append?: boolean) => void;
  selectCommit: (commit: CommitNode | null, mode?: CommitSelectionMode, sourceCommits?: CommitNode[]) => void;
  setCommitFiles: (repoId: string, hash: string, files: CommitFileEntry[]) => void;
  setLoadingFiles: (repoId: string, hash: string, value: boolean) => void;
  selectFile: (file: { repoId: string; path: string; status: string; commitHash?: string } | null) => void;
  setDiff: (diff: FileDiff | null) => void;
  setLoadingCommits: (v: boolean) => void;
  setBackgroundLoading: (v: boolean) => void;
  setLoadingDiff: (v: boolean) => void;
  setFilterRepoId: (id: string | null) => void;
  setBranchFilter: (filter: string) => void;
  setCommitFilters: (filters: Partial<CommitFilters>) => void;
  updateBranches: (repoId: string, branches: BranchInfo[]) => void;
  setError: (err: string | null) => void;
  setPendingScrollHash: (hash: string | null) => void;
  clearSelection: () => void;
}

const defaultCommitFilters: CommitFilters = {
  text: '',
  author: '',
  branch: '',
  dateFrom: '',
  dateTo: '',
  repoId: null,
  path: '',
  lineRange: undefined,
};

function commitKey(repoId: string, hash: string): string {
  return `${repoId}:${hash}`;
}

function findCommitIndex(commits: CommitNode[], key: string): number {
  return commits.findIndex(commit => commitKey(commit.repoId, commit.hash) === key);
}

function dedupeHashes(hashes: string[]): string[] {
  return Array.from(new Set(hashes.filter(Boolean)));
}

function dedupeCommits(commits: CommitNode[]): CommitNode[] {
  const seen = new Set<string>();
  return commits.filter(commit => {
    const key = commitKey(commit.repoId, commit.hash);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createEmptyComparePane(): ComparePaneState {
  return {
    commits: [],
    hasMore: true,
    loading: false,
    filterText: '',
    filterAuthor: '',
    filterBranch: '',
    filterDateFrom: '',
    filterDateTo: '',
    filterPath: '',
  };
}

export const useLogStore = create<LogState>((set, get) => ({
  repos: [],
  initialized: false,
  hasWorkspaceFolder: true,
  branches: [],
  tags: [],
  iconTheme: null,
  mode: 'log',
  commits: [],
  hasMore: true,
  selectedCommitHashes: [],
  primarySelectedHash: null,
  selectionAnchorHash: null,
  selectedFile: null,
  commitFilesByKey: {},
  currentDiff: null,
  loadingCommits: false,
  backgroundLoading: false,
  loadingFilesByKey: {},
  loadingDiff: false,
  filterRepoId: null,
  branchFilter: '',
  commitFilters: { ...defaultCommitFilters },
  error: null,
  pendingScrollHash: null,
  replaceCommitsOnNextBatch: false,
  compareState: null,

  setRepos: (repos, hasWorkspaceFolder) => set({ repos, initialized: true, ...(hasWorkspaceFolder !== undefined ? { hasWorkspaceFolder } : {}) }),
  setBranches: (branches) => set({ branches }),
  updateTags: (repoId, tags) => set(s => ({
    tags: [...s.tags.filter(t => t.repoId !== repoId), ...tags],
  })),
  setIconTheme: (iconTheme) => set({ iconTheme }),
  appendCommits: (commits, isLast) => set(s => {
    const replacing = s.replaceCommitsOnNextBatch;
    const nextCommits = dedupeCommits(replacing ? commits : [...s.commits, ...commits]);
    let nextSelectedHashes = s.selectedCommitHashes;
    let nextPrimarySelectedHash = s.primarySelectedHash;
    let nextSelectionAnchorHash = s.selectionAnchorHash;
    let nextSelectedFile = s.selectedFile;
    let nextCurrentDiff = s.currentDiff;

    if (replacing) {
      const availableHashes = new Set(nextCommits.map(commit => commitKey(commit.repoId, commit.hash)));
      nextSelectedHashes = s.selectedCommitHashes.filter(hash => availableHashes.has(hash));
      if (nextSelectedHashes.length === 0 && nextCommits.length > 0) {
        nextSelectedHashes = [commitKey(nextCommits[0].repoId, nextCommits[0].hash)];
      }
      nextPrimarySelectedHash = nextSelectedHashes.includes(s.primarySelectedHash ?? '')
        ? s.primarySelectedHash
        : (nextSelectedHashes[0] ?? null);
      nextSelectionAnchorHash = nextSelectedHashes.includes(s.selectionAnchorHash ?? '')
        ? s.selectionAnchorHash
        : nextPrimarySelectedHash;
      if (nextPrimarySelectedHash !== s.primarySelectedHash) {
        nextSelectedFile = null;
        nextCurrentDiff = null;
      }
    } else if (s.primarySelectedHash == null && nextCommits.length > 0) {
      const firstKey = commitKey(nextCommits[0].repoId, nextCommits[0].hash);
      nextSelectedHashes = [firstKey];
      nextPrimarySelectedHash = firstKey;
      nextSelectionAnchorHash = firstKey;
    }

    return {
      commits: nextCommits,
      selectedCommitHashes: dedupeHashes(nextSelectedHashes),
      primarySelectedHash: nextPrimarySelectedHash,
      selectionAnchorHash: nextSelectionAnchorHash,
      selectedFile: nextSelectedFile,
      currentDiff: nextCurrentDiff,
      loadingCommits: false,
      backgroundLoading: false,
      hasMore: !isLast,
      replaceCommitsOnNextBatch: false,
    };
  }),
  beginCommitsReload: () => set({
    mode: 'log',
    hasMore: true,
    loadingCommits: true,
    backgroundLoading: false,
    replaceCommitsOnNextBatch: true,
    compareState: null,
  }),
  openCompare: (compare) => set({
    mode: 'compare',
    compareState: {
      ...compare,
      baseOnly: { ...createEmptyComparePane(), loading: true },
      targetOnly: { ...createEmptyComparePane(), loading: true },
    },
    commitFilters: {
      ...get().commitFilters,
      branch: '',
    },
    selectedCommitHashes: [],
    primarySelectedHash: null,
    selectionAnchorHash: null,
    selectedFile: null,
    currentDiff: null,
    pendingScrollHash: null,
  }),
  closeCompare: () => set({
    mode: 'log',
    compareState: null,
    selectedCommitHashes: [],
    primarySelectedHash: null,
    selectionAnchorHash: null,
    selectedFile: null,
    currentDiff: null,
  }),
  setComparePaneState: (side, pane, append = false) => set(s => {
    if (!s.compareState) return {};
    const currentPane = s.compareState[side];
    return {
      compareState: {
        ...s.compareState,
        [side]: {
          ...currentPane,
          ...pane,
          commits: append
            ? [...currentPane.commits, ...(pane.commits ?? [])]
            : (pane.commits ?? currentPane.commits),
        },
      },
    };
  }),
  selectCommit: (commit, mode = 'single', sourceCommits) => set(s => {
    if (!commit) {
      return {
        selectedCommitHashes: [],
        primarySelectedHash: null,
        selectionAnchorHash: null,
        selectedFile: null,
        currentDiff: null,
      };
    }

    const hash = commitKey(commit.repoId, commit.hash);
    const currentSelection = new Set(s.selectedCommitHashes);
    const commitSource = sourceCommits ?? s.commits;
    let nextSelectedHashes: string[] = [];
    let nextPrimarySelectedHash = hash;
    let nextSelectionAnchorHash = s.selectionAnchorHash ?? s.primarySelectedHash ?? hash;

    if (mode === 'single') {
      nextSelectedHashes = [hash];
      nextSelectionAnchorHash = hash;
    } else if (mode === 'toggle') {
      if (currentSelection.has(hash)) {
        currentSelection.delete(hash);
      } else {
        currentSelection.add(hash);
      }
      nextSelectedHashes = Array.from(currentSelection);
      if (nextSelectedHashes.length === 0) {
        nextSelectedHashes = [hash];
      }
      nextSelectionAnchorHash = s.selectionAnchorHash ?? s.primarySelectedHash ?? hash;
      if (!nextSelectedHashes.includes(nextSelectionAnchorHash)) {
        nextSelectionAnchorHash = hash;
      }
      if (!nextSelectedHashes.includes(hash)) {
        nextPrimarySelectedHash = nextSelectedHashes[0];
      }
    } else {
      const anchorHash = s.selectionAnchorHash ?? s.primarySelectedHash ?? hash;
      const anchorIndex = findCommitIndex(commitSource, anchorHash);
      const targetIndex = findCommitIndex(commitSource, hash);
      if (anchorIndex < 0 || targetIndex < 0) {
        nextSelectedHashes = [hash];
        nextSelectionAnchorHash = hash;
      } else {
        const [from, to] = anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        nextSelectedHashes = commitSource.slice(from, to + 1).map(item => commitKey(item.repoId, item.hash));
        nextSelectionAnchorHash = anchorHash;
      }
    }

    const deduped = dedupeHashes(nextSelectedHashes);
    const selectionChanged = deduped.length !== s.selectedCommitHashes.length
      || deduped.some((selectedHash, index) => selectedHash !== s.selectedCommitHashes[index])
      || nextPrimarySelectedHash !== s.primarySelectedHash;

    return {
      selectedCommitHashes: deduped,
      primarySelectedHash: nextPrimarySelectedHash,
      selectionAnchorHash: nextSelectionAnchorHash,
      selectedFile: selectionChanged ? null : s.selectedFile,
      currentDiff: selectionChanged ? null : s.currentDiff,
    };
  }),
  setCommitFiles: (repoId, hash, files) => set(s => ({
    commitFilesByKey: {
      ...s.commitFilesByKey,
      [commitKey(repoId, hash)]: files,
    },
    loadingFilesByKey: {
      ...s.loadingFilesByKey,
      [commitKey(repoId, hash)]: false,
    },
  })),
  setLoadingFiles: (repoId, hash, value) => set(s => ({
    loadingFilesByKey: {
      ...s.loadingFilesByKey,
      [commitKey(repoId, hash)]: value,
    },
  })),
  selectFile: (file) => set({ selectedFile: file }),
  setDiff: (diff) => set({ currentDiff: diff, loadingDiff: false }),
  setLoadingCommits: (v) => set({ loadingCommits: v }),
  setBackgroundLoading: (v) => set({ backgroundLoading: v }),
  setLoadingDiff: (v) => set({ loadingDiff: v }),
  setFilterRepoId: (id) => set({ filterRepoId: id }),
  setBranchFilter: (filter) => set({ branchFilter: filter }),
  setCommitFilters: (filters) => set(s => ({ commitFilters: { ...s.commitFilters, ...filters } })),
  updateBranches: (repoId, branches) => set(s => ({
    branches: [...s.branches.filter(b => b.repoId !== repoId), ...branches],
  })),
  setError: (err) => set({ error: err }),
  setPendingScrollHash: (hash) => set({ pendingScrollHash: hash }),
  clearSelection: () => set({
    selectedCommitHashes: [],
    primarySelectedHash: null,
    selectionAnchorHash: null,
    selectedFile: null,
    currentDiff: null,
  }),
}));

export function getCommitKey(repoId: string, hash: string): string {
  return commitKey(repoId, hash);
}
