import { create } from 'zustand';
import type { ChangelistData, FileDiff, FileStatus, RepoMeta, RepoStatus, WorkspaceStatus } from '../../shared/types';
import type { IconThemeData } from '../../../host/types/messages';
import { scopedKey } from '../../shared/scopedKey';

export type ViewMode = 'flat' | 'tree';

const STASH_VIEW_MODE_KEY = 'versiondock:stash-view-mode';

function loadStashViewMode(): ViewMode {
  try {
    return localStorage.getItem(STASH_VIEW_MODE_KEY) === 'flat' ? 'flat' : 'tree';
  } catch {
    return 'tree';
  }
}

function saveStashViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(STASH_VIEW_MODE_KEY, mode);
  } catch {
    // Webview storage can be unavailable; the in-memory setting still works.
  }
}

export interface WorktreeDiffState {
  repoId: string;
  repoName: string;
  repoColor: string;
  baseRef: string;
  currentRef: string;
  files: FileStatus[];
  selectedFile: FileStatus | null;
  currentDiff: FileDiff | null;
  loadingFiles: boolean;
  loadingDiff: boolean;
  error: string | null;
}

// fileSelections[repoId] = Set of file paths the user has checked
export type FileSelections = Record<string, Set<string>>;

export interface CommitState {
  status: WorkspaceStatus | null;
  repoMetas: RepoMeta[];
  iconTheme: IconThemeData | null;
  panelMode: 'changes' | 'worktreeDiff';
  repoSelections: Record<string, boolean>;
  fileSelections: FileSelections;
  seenFiles: Record<string, Set<string>>;
  // collapsed state for repo headers and tree dirs (key = repoId or dirPath)
  collapsedKeys: Set<string>;
  selectedFile: { repoId: string; path: string } | null;
  currentDiff: FileDiff | null;
  loadingDiff: boolean;
  commitMessage: string;
  amendFlags: Record<string, boolean>;
  viewMode: ViewMode;
  shelveViewMode: ViewMode;
  stashViewMode: ViewMode;
  shelveCollapsedKeys: Set<string>;
  loading: boolean;
  error: string | null;
  worktreeDiffState: WorktreeDiffState | null;
  changelists: ChangelistData[];
  changesViewMode: 'simplified' | 'changelists' | 'vscode';
  defaultCommitAction: 'commit' | 'commitAndPush';
  defaultSaveAction: 'stash' | 'shelve';
  hasWorkspaceFolder: boolean;
  noVerify: boolean;

  setStatus: (repos: RepoMeta[], status: WorkspaceStatus, iconTheme?: IconThemeData | null, fileViewMode?: 'flat' | 'tree', defaultCommitAction?: 'commit' | 'commitAndPush', defaultSaveAction?: 'stash' | 'shelve', hasWorkspaceFolder?: boolean, noVerify?: boolean) => void;
  setNoVerify: (v: boolean) => void;
  setRepoSelection: (repoId: string, selected: boolean) => void;
  toggleFileSelection: (repoId: string, path: string) => void;
  setFileSelections: (repoId: string, paths: string[], selected: boolean) => void;
  selectAllFiles: () => void;
  invertFileSelections: () => void;
  isFileSelected: (repoId: string, path: string) => boolean;
  getSelectedFilesForRepo: (repoId: string) => string[];
  selectFile: (repoId: string, path: string) => void;
  setDiff: (diff: FileDiff | null) => void;
  setLoadingDiff: (v: boolean) => void;
  setCommitMessage: (msg: string) => void;
  setAmend: (repoId: string, v: boolean) => void;
  setViewMode: (mode: ViewMode) => void;
  setShelveViewMode: (mode: ViewMode) => void;
  setStashViewMode: (mode: ViewMode) => void;
  isShelveCollapsed: (key: string) => boolean;
  toggleShelveCollapsed: (key: string) => void;
  shelveExpandAll: (keys: string[]) => void;
  shelveCollapseAll: () => void;
  setLoading: (v: boolean) => void;
  setError: (err: string | null) => void;
  startWorktreeDiff: (state: Omit<WorktreeDiffState, 'selectedFile' | 'currentDiff' | 'loadingFiles' | 'loadingDiff' | 'error'>) => void;
  closeWorktreeDiff: () => void;
  setWorktreeDiffFiles: (files: FileStatus[], currentRef: string) => void;
  selectWorktreeDiffFile: (file: FileStatus | null) => void;
  setWorktreeDiffDiff: (diff: FileDiff | null) => void;
  setWorktreeDiffLoadingDiff: (v: boolean) => void;
  setWorktreeDiffError: (err: string | null) => void;
  setChangelists: (changelists: ChangelistData[], viewMode: 'simplified' | 'changelists' | 'vscode') => void;
  getRepoStatus: (repoId: string) => RepoStatus | undefined;
  getSelectedRepos: () => string[];
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  setCollapsedKeys: (keys: Set<string>) => void;
  setShelveCollapsedKeys: (keys: Set<string>) => void;
  expandAll: () => void;
  collapseAll: () => void;
}

function allFilePaths(repoStatus: RepoStatus): string[] {
  const paths = new Set<string>();
  for (const f of repoStatus.stagedFiles) paths.add(f.path);
  for (const f of repoStatus.unstagedFiles) paths.add(f.path);
  return Array.from(paths);
}

function loadPersistedSelection(mode: 'simplified' | 'changelists', repoId: string): Set<string> | null {
  try {
    const raw = localStorage.getItem(`versiondock:${mode}:selection:${repoId}`);
    if (!raw) return null;
    return new Set(JSON.parse(raw) as string[]);
  } catch { return null; }
}

function savePersistedSelection(mode: 'simplified' | 'changelists', repoId: string, paths: Set<string>) {
  try {
    localStorage.setItem(`versiondock:${mode}:selection:${repoId}`, JSON.stringify(Array.from(paths)));
  } catch { /* ignore */ }
}

export const useCommitStore = create<CommitState>((set, get) => ({
  status: null,
  repoMetas: [],
  iconTheme: null,
  panelMode: 'changes',
  repoSelections: {},
  fileSelections: {},
  seenFiles: {},
  collapsedKeys: new Set(),
  selectedFile: null,
  currentDiff: null,
  loadingDiff: false,
  commitMessage: '',
  amendFlags: {},
  viewMode: 'tree',
  shelveViewMode: 'tree',
  stashViewMode: loadStashViewMode(),
  shelveCollapsedKeys: new Set(),
  loading: false,
  error: null,
  worktreeDiffState: null,
  changelists: [],
  changesViewMode: 'simplified',
  defaultCommitAction: 'commit',
  defaultSaveAction: 'stash',
  hasWorkspaceFolder: true,
  noVerify: false,

  setNoVerify: (v) => set({ noVerify: v }),

  setStatus: (repoMetas, status, iconTheme, fileViewMode, defaultCommitAction, defaultSaveAction, hasWorkspaceFolder, noVerify) => {
    const prev = get().repoSelections;
    const prevFiles = get().fileSelections;
    const prevSeen = get().seenFiles;
    const prevCollapsed = get().collapsedKeys;
    const { changesViewMode } = get();
    const repoSelections: Record<string, boolean> = {};
    const fileSelections: FileSelections = {};
    const seenFiles: Record<string, Set<string>> = {};
    const collapsedKeys = new Set(prevCollapsed);

    for (const r of status.repos) {
      const repoCollapseKey = scopedKey('repo', r.repoId);
      repoSelections[r.repoId] = prev[r.repoId] ?? true;
      const currentPaths = allFilePaths(r);
      const prevSelectedSet = prevFiles[r.repoId];
      const prevSeenSet = prevSeen[r.repoId];
      const savedSelection = !prevSeenSet && (changesViewMode === 'simplified' || changesViewMode === 'changelists') ? loadPersistedSelection(changesViewMode, r.repoId) : null;
      const next = new Set<string>();
      for (const p of currentPaths) {
        const isFirstLoad = !prevSeenSet;
        const isNew = !isFirstLoad && !prevSeenSet.has(p);
        if (isFirstLoad) {
          // Initial load: in simplified/changelists mode restore from localStorage
          if (changesViewMode === 'simplified' || changesViewMode === 'changelists') {
            if (savedSelection?.has(p)) next.add(p);
            continue;
          }
          next.add(p);
        } else if (isNew) {
          // File appeared after initial load — never auto-select
        } else if (prevSelectedSet?.has(p)) {
          next.add(p);
        }
      }
      fileSelections[r.repoId] = next;
      seenFiles[r.repoId] = new Set(currentPaths);

      // Auto-collapse repos with no changes; auto-expand only when changes appear on a previously empty repo
      if (!(r.repoId in prev)) {
        if (currentPaths.length === 0) collapsedKeys.add(repoCollapseKey);
      } else {
        const wasCollapsed = prevCollapsed.has(repoCollapseKey);
        const prevHadFiles = (prevSeen[r.repoId]?.size ?? 0) > 0;
        if (wasCollapsed && currentPaths.length > 0 && !prevHadFiles) {
          collapsedKeys.delete(repoCollapseKey);
        }
      }
    }
    set({ repoMetas, status, repoSelections, fileSelections, seenFiles, collapsedKeys, ...(iconTheme !== undefined ? { iconTheme } : {}), ...(fileViewMode !== undefined ? { viewMode: fileViewMode } : {}), ...(defaultCommitAction !== undefined ? { defaultCommitAction } : {}), ...(defaultSaveAction !== undefined ? { defaultSaveAction } : {}), ...(hasWorkspaceFolder !== undefined ? { hasWorkspaceFolder } : {}), ...(noVerify !== undefined ? { noVerify } : {}) });
  },

  setRepoSelection: (repoId, selected) =>
    set(s => ({ repoSelections: { ...s.repoSelections, [repoId]: selected } })),

  toggleFileSelection: (repoId, path) =>
    set(s => {
      const prev = new Set(s.fileSelections[repoId] ?? []);
      if (prev.has(path)) prev.delete(path);
      else prev.add(path);
      if (s.changesViewMode === 'simplified' || s.changesViewMode === 'changelists') savePersistedSelection(s.changesViewMode, repoId, prev);
      return { fileSelections: { ...s.fileSelections, [repoId]: prev } };
    }),

  setFileSelections: (repoId, paths, selected) =>
    set(s => {
      const next = new Set(s.fileSelections[repoId] ?? []);
      for (const p of paths) {
        if (selected) next.add(p);
        else next.delete(p);
      }
      if (s.changesViewMode === 'simplified' || s.changesViewMode === 'changelists') savePersistedSelection(s.changesViewMode, repoId, next);
      return { fileSelections: { ...s.fileSelections, [repoId]: next } };
    }),

  selectAllFiles: () => {
    const { status, changesViewMode } = get();
    if (!status?.repos) return;
    const nextFileSelections: FileSelections = {};
    for (const r of status.repos) {
      const paths = allFilePaths(r);
      const next = new Set(paths);
      nextFileSelections[r.repoId] = next;
      if (changesViewMode === 'simplified' || changesViewMode === 'changelists') {
        savePersistedSelection(changesViewMode, r.repoId, next);
      }
    }
    set({ fileSelections: nextFileSelections });
  },

  invertFileSelections: () => {
    const { status, fileSelections, changesViewMode } = get();
    if (!status?.repos) return;
    const nextFileSelections: FileSelections = {};
    for (const r of status.repos) {
      const paths = allFilePaths(r);
      const currentSelected = fileSelections[r.repoId] ?? new Set<string>();
      const next = new Set<string>();
      for (const p of paths) {
        if (!currentSelected.has(p)) {
          next.add(p);
        }
      }
      nextFileSelections[r.repoId] = next;
      if (changesViewMode === 'simplified' || changesViewMode === 'changelists') {
        savePersistedSelection(changesViewMode, r.repoId, next);
      }
    }
    set({ fileSelections: nextFileSelections });
  },

  isFileSelected: (repoId, path) =>
    get().fileSelections[repoId]?.has(path) ?? false,

  getSelectedFilesForRepo: (repoId) =>
    Array.from(get().fileSelections[repoId] ?? []),

  selectFile: (repoId, path) =>
    set({ selectedFile: { repoId, path }, currentDiff: null }),

  setDiff: (diff) => set({ currentDiff: diff, loadingDiff: false }),
  setLoadingDiff: (v) => set({ loadingDiff: v }),
  setCommitMessage: (msg) => set({ commitMessage: msg }),
  setAmend: (repoId, v) => set(s => ({ amendFlags: { ...s.amendFlags, [repoId]: v } })),
  setViewMode: (mode) => set({ viewMode: mode }),
  setShelveViewMode: (mode) => set({ shelveViewMode: mode }),
  setStashViewMode: (mode) => {
    saveStashViewMode(mode);
    set({ stashViewMode: mode });
  },
  // shelveCollapsedKeys tracks *expanded* items — absence means collapsed (default)
  isShelveCollapsed: (key) => !get().shelveCollapsedKeys.has(key),
  toggleShelveCollapsed: (key) => set(s => {
    const next = new Set(s.shelveCollapsedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    return { shelveCollapsedKeys: next };
  }),
  shelveExpandAll: (keys) => {
    set({ shelveCollapsedKeys: new Set(keys) });
  },
  setShelveCollapsedKeys: (keys) => {
    set({ shelveCollapsedKeys: new Set(keys) });
  },
  shelveCollapseAll: () => {
    // Collapsing = removing from the expanded set = empty set
    set({ shelveCollapsedKeys: new Set() });
  },
  setLoading: (v) => set({ loading: v }),
  setError: (err) => set({ error: err }),
  startWorktreeDiff: (state) => set({
    panelMode: 'worktreeDiff',
    worktreeDiffState: {
      ...state,
      selectedFile: null,
      currentDiff: null,
      loadingFiles: false,
      loadingDiff: false,
      error: null,
    },
  }),
  closeWorktreeDiff: () => set({
    panelMode: 'changes',
    worktreeDiffState: null,
  }),
  setWorktreeDiffFiles: (files, currentRef) => set(s => {
    if (!s.worktreeDiffState) return {};
    return {
      worktreeDiffState: {
        ...s.worktreeDiffState,
        files,
        currentRef,
        loadingFiles: false,
        error: null,
      },
    };
  }),
  selectWorktreeDiffFile: (file) => set(s => {
    if (!s.worktreeDiffState) return {};
    return {
      worktreeDiffState: {
        ...s.worktreeDiffState,
        selectedFile: file,
        currentDiff: file ? null : null,
      },
    };
  }),
  setWorktreeDiffDiff: (diff) => set(s => {
    if (!s.worktreeDiffState) return {};
    return {
      worktreeDiffState: {
        ...s.worktreeDiffState,
        currentDiff: diff,
        loadingDiff: false,
      },
    };
  }),
  setWorktreeDiffLoadingDiff: (v) => set(s => {
    if (!s.worktreeDiffState) return {};
    return {
      worktreeDiffState: {
        ...s.worktreeDiffState,
        loadingDiff: v,
      },
    };
  }),
  setWorktreeDiffError: (err) => set(s => {
    if (!s.worktreeDiffState) return {};
    return {
      worktreeDiffState: {
        ...s.worktreeDiffState,
        error: err,
        loadingFiles: false,
        loadingDiff: false,
      },
    };
  }),
  setChangelists: (changelists, viewMode) => {
    set({ changelists, changesViewMode: viewMode });
  },

  getRepoStatus: (repoId) => get().status?.repos.find(r => r.repoId === repoId),

  getSelectedRepos: () => {
    const { repoSelections, status } = get();
    return (status?.repos ?? [])
      .filter(r => repoSelections[r.repoId] !== false)
      .map(r => r.repoId);
  },

  isCollapsed: (key) => get().collapsedKeys.has(key),
  toggleCollapsed: (key) => set(s => {
    const next = new Set(s.collapsedKeys);
    if (next.has(key)) next.delete(key); else next.add(key);
    return { collapsedKeys: next };
  }),
  setCollapsedKeys: (keys: Set<string>) => set({ collapsedKeys: new Set(keys) }),
  expandAll: () => set({ collapsedKeys: new Set() }),
  collapseAll: () => {
    const { status, changesViewMode, changelists } = get();
    const keys = new Set<string>();
    if (changesViewMode === 'vscode') {
      keys.add('vscode-section:staged');
      keys.add('vscode-section:unstaged');
      set({ collapsedKeys: keys });
      return;
    }
    if (changesViewMode === 'changelists') {
      for (const changelist of changelists) keys.add(scopedKey('changelist', changelist.id));
      set({ collapsedKeys: keys });
      return;
    }
    for (const r of status?.repos ?? []) {
      keys.add(scopedKey('repo', r.repoId));
      // Add all dir paths from staged + unstaged files
      const allPaths = [...r.stagedFiles, ...r.unstagedFiles].map(f => f.path);
      for (const p of allPaths) {
        const parts = p.split('/');
        for (let i = 1; i < parts.length; i++) {
          keys.add(scopedKey('tree-dir', r.repoId, parts.slice(0, i).join('/')));
        }
      }
    }
    set({ collapsedKeys: keys });
  },
}));
