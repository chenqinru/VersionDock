import React, { useEffect, useCallback, useRef, useState, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { useCommitStore } from './store/commitStore';
import { ProjectGroup } from './components/ProjectGroup';
import { ChangelistView } from './components/ChangelistView';
import { VscodeView } from './components/VscodeView';
import { UnifiedCommitForm } from './components/UnifiedCommitForm';
import { ContextMenu, type ContextMenuEntry } from './components/ContextMenu';
import { ShelvePanel, getShelveExpansionKeys, shelveEntryKey, shelveDirKey } from './components/ShelvePanel';
import { StashTab, type ExpansionCommand } from './components/StashTab';
import { PushTab } from './components/PushTab';
import { WorktreeDiffPanel } from './components/WorktreeDiffPanel';
import { WorktreePanel } from './components/WorktreePanel';
import { SubtreePanel } from './components/SubtreePanel';
import { SubmodulePanel } from './components/SubmodulePanel';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import { SpeedSearchWidget, useSpeedSearch } from '../shared/speedSearch';
import type { CommitToHostMsg, HostToCommitMsg, ShelveEntry, StashEntry, UnpushedCommit, PushCommitFile, IncomingCommit, SyncPullStrategy, WorktreeEntry, SubtreeEntry, SubtreeOp, SubtreePushStatus, RepoSubmodules, SubmoduleItem } from '../shared/msgTypes';
import type { FileStatus } from '../shared/types';
import { t } from '../shared/i18n';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../shared/types';
import { baseNameFromPath } from '../shared/pathUtils';
import { branchInfoColor } from '../shared/branchColors';
import { scopedKey } from '../shared/scopedKey';

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const COMMIT_MESSAGE_HISTORY_LIMIT = 50;
const COMMIT_MESSAGE_HISTORY_FETCH_LIMIT = 100;
const GENERATED_COMMIT_MESSAGE_PATTERNS = [
  /^Merge commit ['"][0-9a-f]{7,40}['"](?: .+)?$/i,
  /^Merge (?:branch|remote-tracking branch|tag) .+$/i,
  /^Merge pull request #\d+ from .+$/i,
  /^Merged in .+ \(pull request #\d+\)$/i,
  /^(?:Squashed|Merged) ['"].+['"] changes from [0-9a-f]{7,40}(?:\.\.[0-9a-f]{7,40})?$/i,
];

function isGeneratedCommitMessage(message: string): boolean {
  const subject = message.split('\n', 1)[0]?.trim() ?? '';
  return GENERATED_COMMIT_MESSAGE_PATTERNS.some(pattern => pattern.test(subject));
}

function mergeCommitMessageHistory(...groups: string[][]): string[] {
  const seen = new Set<string>();
  return groups.flat().flatMap(message => {
    const normalized = message.replace(/\r\n/g, '\n').trim();
    if (!normalized || isGeneratedCommitMessage(normalized) || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  }).slice(0, COMMIT_MESSAGE_HISTORY_LIMIT);
}

// ── Context menu items ────────────────────────────────────────────────────────

const IS_MAC = navigator.userAgent.includes('Mac');
const IS_WIN = navigator.userAgent.includes('Windows');
const REVEAL_OS_LABEL = IS_MAC ? t('Reveal in Finder') : IS_WIN ? t('Show in Explorer') : t('Show in File Manager');

const FILE_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'rollback',        label: t('Rollback'),            icon: 'discard' },
  { id: 'shelve',          label: t('Shelve'),              icon: 'archive' },
  { id: 'stash',           label: t('Stash'),               icon: 'save' },
  { id: 'diff',            label: t('Show Diff'),           icon: 'diff' },
  { id: 'jump',            label: t('Jump to Source'),      icon: 'go-to-file' },
  { id: 'reveal-explorer', label: t('Reveal in Explorer'),  icon: 'list-tree' },
  { id: 'reveal-os',       label: REVEAL_OS_LABEL,       icon: 'folder-opened' },
  { separator: true },
  { id: 'gitignore',       label: t('Add to .gitignore'),   icon: 'exclude' },
  { separator: true },
  { id: 'delete',          label: t('Delete'),              icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',         label: t('Refresh'),             icon: 'refresh' },
];

const FILE_CONTEXT_ITEMS_CONFLICT: ContextMenuEntry[] = [
  { id: 'resolve',   label: t('Resolve Conflicts'),  icon: 'git-merge' },
  { id: 'accept-yours', label: t('Accept Yours'), icon: 'check' },
  { id: 'accept-theirs', label: t('Accept Theirs'), icon: 'check-all' },
  { separator: true },
  ...FILE_CONTEXT_ITEMS,
];

const FOLDER_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'rollback',  label: t('Rollback'),           icon: 'discard' },
  { id: 'shelve',    label: t('Shelve Changes'),      icon: 'archive' },
  { id: 'stash',     label: t('Stash Changes'),       icon: 'save' },
  { separator: true },
  { id: 'gitignore', label: t('Add to .gitignore'),  icon: 'exclude' },
  { separator: true },
  { id: 'delete',    label: t('Delete'),              icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',   label: t('Refresh'),             icon: 'refresh' },
];

const REPO_CONTEXT_ITEMS: ContextMenuEntry[] = [
  { id: 'rollback',     label: t('Rollback'),            icon: 'discard' },
  { id: 'shelve',       label: t('Shelve Changes'),       icon: 'archive' },
  { id: 'stash',        label: t('Stash Changes'),        icon: 'save' },
  { separator: true },
  { id: 'manage-repo',  label: t('Manage Repository'),    icon: 'git-branch' },
  { id: 'view-git-log', label: t('View Git Log'),         icon: 'git-commit' },
  { separator: true },
  { id: 'hide-repo',    label: t('Hide Repository'),      icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',      label: t('Refresh'),              icon: 'refresh' },
];

const VSCODE_FILE_STAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'unstage',         label: t('Unstage'),              icon: 'remove' },
  { separator: true },
  { id: 'diff',            label: t('Show Diff'),            icon: 'diff' },
  { id: 'jump',            label: t('Jump to Source'),       icon: 'go-to-file' },
  { id: 'reveal-explorer', label: t('Reveal in Explorer'),   icon: 'list-tree' },
  { id: 'reveal-os',       label: REVEAL_OS_LABEL,        icon: 'folder-opened' },
  { separator: true },
  { id: 'refresh',         label: t('Refresh'),              icon: 'refresh' },
];

const VSCODE_FILE_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage',           label: t('Stage'),                icon: 'add' },
  { id: 'rollback',        label: t('Rollback'),             icon: 'discard' },
  { id: 'shelve',          label: t('Shelve'),               icon: 'archive' },
  { id: 'stash',           label: t('Stash'),                icon: 'save' },
  { separator: true },
  { id: 'diff',            label: t('Show Diff'),            icon: 'diff' },
  { id: 'jump',            label: t('Jump to Source'),       icon: 'go-to-file' },
  { id: 'reveal-explorer', label: t('Reveal in Explorer'),   icon: 'list-tree' },
  { id: 'reveal-os',       label: REVEAL_OS_LABEL,        icon: 'folder-opened' },
  { separator: true },
  { id: 'gitignore',       label: t('Add to .gitignore'),    icon: 'exclude' },
  { separator: true },
  { id: 'delete',          label: t('Delete'),               icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',         label: t('Refresh'),              icon: 'refresh' },
];

const VSCODE_FOLDER_STAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'unstage',  label: t('Unstage Folder'),       icon: 'remove' },
  { separator: true },
  { id: 'refresh',  label: t('Refresh'),              icon: 'refresh' },
];

const VSCODE_FOLDER_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage',    label: t('Stage Folder'),         icon: 'add' },
  { id: 'rollback', label: t('Rollback'),             icon: 'discard' },
  { id: 'shelve',   label: t('Shelve Changes'),        icon: 'archive' },
  { id: 'stash',    label: t('Stash Changes'),         icon: 'save' },
  { separator: true },
  { id: 'gitignore',label: t('Add to .gitignore'),    icon: 'exclude' },
  { separator: true },
  { id: 'delete',   label: t('Delete'),               icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',  label: t('Refresh'),              icon: 'refresh' },
];

const VSCODE_REPO_STAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'unstage-all',  label: t('Unstage All'),        icon: 'remove' },
  { separator: true },
  { id: 'manage-repo',  label: t('Manage Repository'),  icon: 'git-branch' },
  { id: 'view-git-log', label: t('View Git Log'),        icon: 'git-commit' },
  { separator: true },
  { id: 'hide-repo',    label: t('Hide Repository'),     icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',      label: t('Refresh'),             icon: 'refresh' },
];

const VSCODE_REPO_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage-all',    label: t('Stage All'),           icon: 'add' },
  { id: 'rollback',     label: t('Rollback'),            icon: 'discard' },
  { id: 'shelve',       label: t('Shelve Changes'),       icon: 'archive' },
  { id: 'stash',        label: t('Stash Changes'),        icon: 'save' },
  { separator: true },
  { id: 'manage-repo',  label: t('Manage Repository'),   icon: 'git-branch' },
  { id: 'view-git-log', label: t('View Git Log'),         icon: 'git-commit' },
  { separator: true },
  { id: 'hide-repo',    label: t('Hide Repository'),      icon: 'eye-closed' },
  { separator: true },
  { id: 'refresh',      label: t('Refresh'),             icon: 'refresh' },
];

const SUBMODULE_FILE_STAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'unstage',                     label: t('Unstage'),                               icon: 'remove' },
  { separator: true },
  { id: 'submodule-update-parent',     label: t('Update Submodule (Sync to Commit)'),    icon: 'sync' },
  { id: 'submodule-reveal-panel',      label: t('Reveal in Submodules Panel'),           icon: 'repo-clone' },
  { id: 'submodule-diff',              label: t('Show Pointer Diff'),                     icon: 'diff' },
  { separator: true },
  { id: 'submodule-open-window',       label: t('Open in New Window'),                    icon: 'link-external' },
  { id: 'refresh',                     label: t('Refresh'),                               icon: 'refresh' },
];

const SUBMODULE_FILE_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage',                       label: t('Stage'),                                 icon: 'add' },
  { separator: true },
  { id: 'submodule-update-parent',     label: t('Update Submodule (Sync to Commit)'),    icon: 'sync' },
  { id: 'submodule-reveal-panel',      label: t('Reveal in Submodules Panel'),           icon: 'repo-clone' },
  { id: 'submodule-diff',              label: t('Show Pointer Diff'),                     icon: 'diff' },
  { separator: true },
  { id: 'submodule-open-window',       label: t('Open in New Window'),                    icon: 'link-external' },
  { id: 'refresh',                     label: t('Refresh'),                               icon: 'refresh' },
];

const CHANGELIST_EMPTY_AREA_ITEMS: ContextMenuEntry[] = [
  { id: 'cl-new',   label: t('New Changelist…'), icon: 'add' },
  { separator: true },
  { id: 'refresh',  label: t('Refresh'),         icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_FIXED: ContextMenuEntry[] = [
  { id: 'cl-rollback', label: t('Rollback'),          icon: 'discard' },
  { id: 'cl-shelve',   label: t('Shelve Changes'),    icon: 'archive' },
  { id: 'cl-stash',    label: t('Stash Changes'),     icon: 'save' },
  { separator: true },
  { id: 'cl-new',      label: t('New Changelist…'),   icon: 'add' },
  { separator: true },
  { id: 'refresh',     label: t('Refresh'),           icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_UNVERSIONED: ContextMenuEntry[] = [
  { id: 'cl-rollback',   label: t('Rollback'),         icon: 'discard' },
  { id: 'cl-shelve',     label: t('Shelve Changes'),   icon: 'archive' },
  { id: 'cl-stash',      label: t('Stash Changes'),    icon: 'save' },
  { separator: true },
  { id: 'cl-add-to-git', label: t('Add to Git'),       icon: 'add' },
  { separator: true },
  { id: 'cl-new',        label: t('New Changelist…'),  icon: 'add' },
  { separator: true },
  { id: 'refresh',       label: t('Refresh'),          icon: 'refresh' },
];

const CHANGELIST_HEADER_ITEMS_CUSTOM: ContextMenuEntry[] = [
  { id: 'cl-rollback', label: t('Rollback'),          icon: 'discard' },
  { id: 'cl-shelve',   label: t('Shelve Changes'),    icon: 'archive' },
  { id: 'cl-stash',    label: t('Stash Changes'),     icon: 'save' },
  { separator: true },
  { id: 'cl-new',      label: t('New Changelist…'),   icon: 'add' },
  { id: 'cl-rename',   label: t('Rename Changelist…'), icon: 'edit' },
  { separator: true },
  { id: 'cl-delete',   label: t('Delete Changelist'),  icon: 'trash', danger: true },
  { separator: true },
  { id: 'refresh',     label: t('Refresh'),           icon: 'refresh' },
];

type TabId = 'changes' | 'shelf' | 'stash' | 'push' | 'worktree' | 'subtree' | 'submodule' | 'sync';
const ALL_TABS: TabId[] = ['changes', 'shelf', 'stash', 'submodule', 'worktree', 'subtree', 'push'];
const SVN_ONLY_TABS: TabId[] = ['changes'];
const SUBTREE_LIST_REQUEST_THROTTLE_MS = 60_000;

const SVN_GIT_ONLY_MENU_IDS = new Set([
  'shelve',
  'stash',
  'unstage',
  'unstage-all',
  'cl-shelve',
  'cl-stash',
]);

const SVN_IGNORE_MENU_ITEM: ContextMenuEntry = { id: 'svn-ignore', label: t('Add to SVN Ignore'), icon: 'exclude' };
const SVN_MANAGE_IGNORE_MENU_ITEM: ContextMenuEntry = { id: 'svn-manage-ignore', label: t('Manage SVN Ignore...'), icon: 'list-unordered' };

function compactContextMenuItems(items: ContextMenuEntry[]): ContextMenuEntry[] {
  const compacted: ContextMenuEntry[] = [];
  for (const item of items) {
    if ('separator' in item && item.separator) {
      const prev = compacted[compacted.length - 1];
      if (!prev || ('separator' in prev && prev.separator)) continue;
      compacted.push(item);
      continue;
    }
    compacted.push(item);
  }
  while (compacted.length > 0) {
    const last = compacted[compacted.length - 1];
    if ('separator' in last && last.separator) compacted.pop();
    else break;
  }
  return compacted;
}

function svnContextMenuItems(items: ContextMenuEntry[], allowAdd: boolean, includeManage = true): ContextMenuEntry[] {
  const filtered: ContextMenuEntry[] = [];
  for (const item of items) {
    if ('separator' in item && item.separator) {
      filtered.push(item);
      continue;
    }
    if (item.id === 'gitignore') {
      if (allowAdd) filtered.push(SVN_IGNORE_MENU_ITEM);
      continue;
    }
    if (item.id === 'add-to-git' || item.id === 'cl-add-to-git' || item.id === 'stage' || item.id === 'stage-all') {
      if (allowAdd) filtered.push({ ...item, label: t('Add to SVN') });
      continue;
    }
    if (SVN_GIT_ONLY_MENU_IDS.has(item.id)) continue;
    filtered.push(item);
  }
  if (includeManage) {
    filtered.push({ separator: true }, SVN_MANAGE_IGNORE_MENU_ITEM);
  }
  return compactContextMenuItems(filtered);
}

function changedPaths(repoStatus: Pick<FileStatus, 'path'>[] | undefined): string[] {
  if (!repoStatus) return [];
  return Array.from(new Set(repoStatus.map(file => file.path).filter(Boolean)));
}

export function CommitApp() {
  const store = useCommitStore();
  const pendingRef = useRef<Map<string, (msg: HostToCommitMsg) => void>>(new Map());
  const commitActionRef = useRef<(andPush: boolean) => void>(() => {});
  // Renders that return an empty/loading state must not retain a previously
  // mounted commit action with stale repository metadata.
  commitActionRef.current = () => {};

  // ── Tab ───────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabId>('changes');
  const activeTabRef = useRef<TabId>('changes');
  activeTabRef.current = activeTab;
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(() => new Set<TabId>(['changes']));
  const visitedTabsRef = useRef<Set<TabId>>(visitedTabs);
  visitedTabsRef.current = visitedTabs;
  const lastTabSyncAtRef = useRef<Partial<Record<TabId, number>>>({});
  const pendingSyncTimersRef = useRef<Partial<Record<TabId, ReturnType<typeof setTimeout>>>>({});
  const dirtyTabsRef = useRef<Set<TabId>>(new Set());
  const inFlightStashRequestsRef = useRef<Set<string>>(new Set());

  const markTabDirty = useCallback((...tabs: TabId[]) => {
    for (const tab of tabs) {
      dirtyTabsRef.current.add(tab);
      delete lastTabSyncAtRef.current[tab];
      if (pendingSyncTimersRef.current[tab]) {
        clearTimeout(pendingSyncTimersRef.current[tab]);
        delete pendingSyncTimersRef.current[tab];
      }
      if (tab === 'subtree') {
        lastSubtreeListRequestAtRef.current = 0;
        lastSubtreeStatusCheckAtRef.current = 0;
        subtreeStatusCheckingRef.current = false;
      }
    }
  }, []);

  // ── Shelve state ──────────────────────────────────────────────────────────
  const [shelveMap, setShelveMap]       = useState<Record<string, ShelveEntry[]>>({});
  const shelveMapRef = useRef<Record<string, ShelveEntry[]>>({});
  shelveMapRef.current = shelveMap;
  const [shelveLoading, setShelveLoading] = useState<Record<string, boolean>>({});
  const [shelveError, setShelveError]   = useState<Record<string, string | null>>({});

  // ── Stash state ───────────────────────────────────────────────────────────
  const [stashMap, setStashMap]       = useState<Record<string, StashEntry[]>>({});
  const [stashCountMap, setStashCountMap] = useState<Record<string, number>>({});
  const [stashLoading, setStashLoading] = useState<Record<string, boolean>>({});
  const [stashError, setStashError]   = useState<Record<string, string | null>>({});
  const [stashExpansionCommand, setStashExpansionCommand] = useState<ExpansionCommand>({ sequence: 0, expanded: false });
  const [pushExpansionCommand, setPushExpansionCommand] = useState<ExpansionCommand>({ sequence: 0, expanded: true });
  const [pushSelectionCommand, setPushSelectionCommand] = useState<{ sequence: number; action: 'selectAll' | 'invert' }>({ sequence: 0, action: 'selectAll' });
  const [pushSelectionState, setPushSelectionState] = useState<{ isAllSelected: boolean; hasSelectable: boolean }>({ isAllSelected: false, hasSelectable: false });
  const [stashFilesMap, setStashFilesMap] = useState<Record<string, Record<string, { loading: boolean; files?: StashEntry['files']; error?: string }>>>({});

  // ── Worktree state ────────────────────────────────────────────────────────
  const [worktreeRepos, setWorktreeRepos] = useState<Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }>>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

  // ── Subtree state ────────────────────────────────────────────────────────
  const [subtreeEntries, setSubtreeEntries] = useState<SubtreeEntry[]>([]);
  const [subtreeLoading, setSubtreeLoading] = useState(false);
  const [subtreeOps, setSubtreeOps] = useState<Record<string, SubtreeOp | undefined>>({});
  const [subtreeStatuses, setSubtreeStatuses] = useState<Record<string, SubtreePushStatus | undefined>>({});
  const subtreeStatusesRef = useRef<Record<string, SubtreePushStatus | undefined>>({});
  subtreeStatusesRef.current = subtreeStatuses;
  const [subtreeError, setSubtreeError] = useState<string | null>(null);
  const subtreeEntriesRef = useRef<SubtreeEntry[]>(subtreeEntries);
  subtreeEntriesRef.current = subtreeEntries;
  const lastSubtreeListRequestAtRef = useRef(0);
  const lastSubtreeStatusCheckAtRef = useRef(0);
  const subtreeStatusCheckingRef = useRef(false);
  const commitStatusRefreshPendingRef = useRef(false);
  const tabCountBootstrappedRepoIdsRef = useRef<Set<string>>(new Set());
  const tabCountWorktreeRequestedRef = useRef(false);
  const tabCountSubtreeRequestedRef = useRef(false);
  const tabCountSubmoduleRequestedRef = useRef(false);

  // ── Submodule state ───────────────────────────────────────────────────────
  const [submoduleRepos, setSubmoduleRepos] = useState<RepoSubmodules[]>([]);
  const submoduleReposRef = useRef<RepoSubmodules[]>(submoduleRepos);
  submoduleReposRef.current = submoduleRepos;
  const [submoduleLoading, setSubmoduleLoading] = useState(false);
  const [submoduleInitialLoaded, setSubmoduleInitialLoaded] = useState(false);
  const submoduleInitialLoadedRef = useRef(false);
  submoduleInitialLoadedRef.current = submoduleInitialLoaded;
  const [submoduleError, setSubmoduleError] = useState<string | null>(null);
  const [submoduleOps, setSubmoduleOps] = useState<Record<string, string | undefined>>({});
  const [highlightSubmodulePath, setHighlightSubmodulePath] = useState<string | null>(null);
  const [submoduleDiffModal, setSubmoduleDiffModal] = useState<{
    open: boolean;
    parentRepoId: string;
    submodulePath: string;
    oldHash?: string;
    newHash?: string;
    parentCommit?: string;
    indexCommit?: string;
    headCommit?: string;
    summary?: string;
    loading?: boolean;
    error?: string;
  } | null>(null);

  // ── Hidden repositories ───────────────────────────────────────────────────
  const [hiddenRepoIds, setHiddenRepoIds] = useState<string[]>([]);
  const hiddenRepoIdsRef = useRef<Set<string>>(new Set());

  // Track unstaged file counts per repo to detect new changes for auto-expand in vscode mode
  const prevUnstagedCountsRef = useRef<Map<string, number>>(new Map());

  // ── Vscode mode: repo selection for commit ───────────────────────────────
  const [vscodeSelectedRepos, setVscodeSelectedRepos] = useState<Set<string>>(new Set());

  // Sync: when repos change, add any new repo as selected by default
  useEffect(() => {
    const currentRepoIds = (store.status?.repos ?? []).map(r => r.repoId);
    setVscodeSelectedRepos(prev => {
      const next = new Set(prev);
      for (const id of currentRepoIds) if (!next.has(id)) next.add(id);
      return next;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(store.status?.repos ?? []).map(r => r.repoId).join('\0')]);

  const toggleVscodeRepoSelection = (repoId: string) => {
    setVscodeSelectedRepos(prev => {
      const next = new Set(prev);
      if (next.has(repoId)) next.delete(repoId); else next.add(repoId);
      return next;
    });
  };

  // ── Push / unpushed & incoming state ───────────────────────────────────────
  const [unpushedMap, setUnpushedMap] = useState<Record<string, { loading: boolean; commits: UnpushedCommit[]; error?: string }>>({});
  const [incomingMap, setIncomingMap] = useState<Record<string, { loading: boolean; commits: IncomingCommit[]; error?: string }>>({});

  // ── Shelve name prompt (triggered by context menu or commit bar button) ────
  const [shelvePrompt, setShelvePrompt] = useState<{
    repoId: string;
    paths?: string[];
    defaultName: string;
  } | null>(null);
  const [shelvePromptName, setShelvePromptName] = useState('');
  const shelvePromptRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (shelvePrompt) {
      setShelvePromptName(shelvePrompt.defaultName);
      setTimeout(() => shelvePromptRef.current?.focus(), 30);
    }
  }, [shelvePrompt]);

  // ── Inject tab label animation keyframes once ─────────────────────────────
  useEffect(() => {
    const id = 'versiondock-tab-kf';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      @keyframes gs-tab-label-in {
        from { opacity: 0; transform: translateX(-6px); max-width: 0; }
        to   { opacity: 1; transform: translateX(0);    max-width: 80px; }
      }
    `;
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    const id = 'versiondock-action-btn-hover';
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id;
    s.textContent = `
      [data-action-btn]:not(:disabled):hover {
        background: var(--vscode-toolbar-hoverBackground) !important;
        opacity: 1 !important;
      }
      [data-secondary-action-btn]:not(:disabled):hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground)) !important;
        opacity: 1 !important;
      }
      [data-primary-action-btn]:not(:disabled):hover {
        background: var(--vscode-button-hoverBackground, var(--vscode-toolbar-hoverBackground)) !important;
        opacity: 1 !important;
      }
      [data-danger-action-btn]:not(:disabled):hover {
        background: color-mix(in srgb, var(--vscode-errorForeground) 86%, white) !important;
        opacity: 1 !important;
      }
      [data-split-main-btn]:not(:disabled):hover,
      [data-split-chevron-btn]:not(:disabled):hover {
        background: var(--split-btn-hover-bg) !important;
        opacity: 1 !important;
      }
      [data-split-main-btn]:not(:disabled):active,
      [data-split-chevron-btn]:not(:disabled):active {
        filter: brightness(0.9) !important;
        transform: translateY(1px) scale(0.995);
      }
      [data-branch-switch-badge] {
        transition: transform 120ms ease, filter 120ms ease, box-shadow 120ms ease;
      }
      [data-branch-switch-badge]:hover {
        transform: translateY(-1px);
        filter: brightness(1.12);
        box-shadow: 0 2px 7px color-mix(in srgb, currentColor 28%, transparent);
      }
      [data-branch-switch-badge]:active {
        transform: translateY(0);
      }
      @media (prefers-reduced-motion: reduce) {
        [data-branch-switch-badge] {
          transition: none;
        }
        [data-branch-switch-badge]:hover {
          transform: none;
        }
      }
    `;
    document.head.appendChild(s);
  }, []);

  // ── Autopilot ─────────────────────────────────────────────────────────────
  const [generatingMessage, setGeneratingMessage]   = useState(false);
  const activeGenerateRequestIdRef = useRef<string | null>(null);
  const [commitMessageHistory, setCommitMessageHistory] = useState<string[]>([]);
  const [commitMessageHistoryLoading, setCommitMessageHistoryLoading] = useState(false);
  const activeCommitMessageHistoryRequestIdRef = useRef<string | null>(null);
  const pendingCommitMessagesRef = useRef<Map<string, string>>(new Map());
  const successfulCommitMessagesRef = useRef<string[]>([]);

  // ── Selected file (highlighted when diff is open or on right-click) ──────
  const [selectedFile, setSelectedFile] = useState<FileStatus | null>(null);

  // ── Context menus ─────────────────────────────────────────────────────────
  const [ctxFile, setCtxFile] = useState<{ repoId: string; path: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; file: FileStatus } | null>(null);
  const [activeFolderPath, setActiveFolderPath] = useState<string | null>(null);
  const [folderCtxMenu, setFolderCtxMenu] = useState<{
    x: number; y: number; repoId: string; folderPath: string; files: FileStatus[];
  } | null>(null);
  const [repoCtxMenu, setRepoCtxMenu] = useState<{ x: number; y: number; repoId: string; changelistId?: string; stagedSection?: boolean } | null>(null);
  // vscode-mode: staged flag attached to file/folder ctx menus
  const [ctxMenuStaged, setCtxMenuStaged] = useState<boolean>(false);
  const [folderCtxMenuStaged, setFolderCtxMenuStaged] = useState<boolean>(false);
  const [clHeaderCtxMenu, setClHeaderCtxMenu] = useState<{ x: number; y: number; changelistId: string } | null>(null);

  const send = useCallback((msg: CommitToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  const requestCommitStatus = useCallback((options: { refreshSubtrees?: boolean } = {}) => {
    if (options.refreshSubtrees) {
      if (subtreeLoading) return;
    } else if (commitStatusRefreshPendingRef.current) {
      return;
    }

    commitStatusRefreshPendingRef.current = true;
    lastTabSyncAtRef.current = {};
    lastSubtreeListRequestAtRef.current = 0;
    lastSubtreeStatusCheckAtRef.current = 0;
    subtreeStatusCheckingRef.current = false;
    if (options.refreshSubtrees) {
      setSubtreeLoading(true);
      setSubtreeError(null);
    }
    send({ type: 'COMMIT_REQUEST_STATUS', refreshSubtrees: options.refreshSubtrees });
  }, [send, subtreeLoading]);

  const notifyError = useCallback((message: string, repoId?: string) => {
    send({ type: 'NOTIFY_ERROR', message, repoId } satisfies CommitToHostMsg);
  }, [send]);

  const notifyInfo = useCallback((message: string, repoId?: string) => {
    send({ type: 'NOTIFY_INFO', message, repoId } satisfies CommitToHostMsg);
  }, [send]);

  const currentViewMode: 'flat' | 'tree' = useMemo(() => {
    if (activeTab === 'shelf') return store.shelveViewMode;
    if (activeTab === 'stash') return store.stashViewMode;
    return store.viewMode;
  }, [activeTab, store.shelveViewMode, store.stashViewMode, store.viewMode]);

  const currentExpandMode: 'expand' | 'collapse' = useMemo(() => {
    if (activeTab === 'changes') {
      return store.collapsedKeys.size === 0 ? 'expand' : 'collapse';
    }
    if (activeTab === 'shelf') {
      return store.shelveCollapsedKeys.size > 0 ? 'expand' : 'collapse';
    }
    if (activeTab === 'stash') {
      return stashExpansionCommand.expanded ? 'expand' : 'collapse';
    }
    if (activeTab === 'push') {
      return pushExpansionCommand.expanded ? 'expand' : 'collapse';
    }
    return 'expand';
  }, [activeTab, store.collapsedKeys, store.shelveCollapsedKeys, stashExpansionCommand.expanded, pushExpansionCommand.expanded]);

  useEffect(() => {
    send({
      type: 'COMMIT_ACTIVE_TAB_CHANGED',
      tab: activeTab,
      viewMode: currentViewMode,
      expandMode: currentExpandMode,
    });
  }, [activeTab, currentViewMode, currentExpandMode, send]);

  // ── Tab data request & sync functions ────────────────────────────────────

  const requestShelveList = useCallback((repoId: string, silent = false) => {
    if (!silent) {
      setShelveLoading(prev => ({ ...prev, [repoId]: true }));
    }
    send({ type: 'SHELVE_LIST', requestId: generateId(), repoId });
  }, [send]);

  const requestStashCount = useCallback((repoId: string) => {
    send({ type: 'STASH_COUNT', requestId: generateId(), repoId });
  }, [send]);

  const requestStashList = useCallback((repoId: string, silent = false) => {
    if (!silent) {
      setStashLoading(prev => ({ ...prev, [repoId]: true }));
    }
    send({ type: 'STASH_LIST', requestId: generateId(), repoId });
  }, [send]);

  const requestWorktreeList = useCallback((silent = false) => {
    if (!silent) {
      setWorktreeLoading(true);
    }
    setWorktreeError(null);
    send({ type: 'WORKTREE_REQUEST_LIST' });
  }, [send]);

  const requestSubmoduleList = useCallback((silent = false) => {
    if (!silent && (!submoduleInitialLoadedRef.current || submoduleReposRef.current.length === 0)) {
      setSubmoduleLoading(true);
    }
    setSubmoduleError(null);
    send({ type: 'SUBMODULE_REQUEST_LIST' });
  }, [send]);

  const requestUnpushedCommits = useCallback((repoId: string, silent = false) => {
    setUnpushedMap(prev => ({
      ...prev,
      // Keep existing commits visible while refreshing; only clear on first load
      [repoId]: prev[repoId]
        ? { ...prev[repoId], loading: !silent }
        : { loading: true, commits: [] },
    }));
    send({ type: 'PUSH_GET_UNPUSHED', requestId: generateId(), repoId });
  }, [send]);

  const requestIncomingCommits = useCallback((repoId: string, silent = false) => {
    setIncomingMap(prev => ({
      ...prev,
      [repoId]: prev[repoId]
        ? { ...prev[repoId], loading: !silent }
        : { loading: true, commits: [] },
    }));
    send({ type: 'SYNC_GET_INCOMING', requestId: generateId(), repoId });
  }, [send]);

  const requestSubtreeList = useCallback((force = false, checkStatuses = false) => {
    const now = Date.now();
    if (checkStatuses) {
      if (!force) {
        if (subtreeStatusCheckingRef.current) {
          return;
        }
        if (lastSubtreeStatusCheckAtRef.current > 0 && now - lastSubtreeStatusCheckAtRef.current < SUBTREE_LIST_REQUEST_THROTTLE_MS) {
          return;
        }
      }
      subtreeStatusCheckingRef.current = true;
      lastSubtreeStatusCheckAtRef.current = now;
      lastSubtreeListRequestAtRef.current = now;
    } else {
      if (!force && lastSubtreeListRequestAtRef.current > 0 && now - lastSubtreeListRequestAtRef.current < SUBTREE_LIST_REQUEST_THROTTLE_MS) {
        return;
      }
      lastSubtreeListRequestAtRef.current = now;
    }

    if (subtreeEntriesRef.current.length === 0) {
      setSubtreeLoading(true);
    }
    setSubtreeError(null);
    if (force && subtreeEntriesRef.current.length > 0) {
      setSubtreeStatuses(prev => {
        const next = { ...prev };
        for (const entry of subtreeEntriesRef.current) {
          next[entry.id] = { ...prev[entry.id], loading: true };
        }
        return next;
      });
    }
    send({ type: 'SUBTREE_REQUEST_LIST', checkStatuses, force });
  }, [send]);

  const syncTabDataRef = useRef<(tab: TabId, force?: boolean) => void>(() => {});

  const syncTabData = useCallback((tab: TabId, force = false) => {
    if (pendingSyncTimersRef.current[tab]) {
      clearTimeout(pendingSyncTimersRef.current[tab]);
      delete pendingSyncTimersRef.current[tab];
    }

    const now = Date.now();
    const last = lastTabSyncAtRef.current[tab] ?? 0;
    if (!force && now - last < 5000) {
      if (!pendingSyncTimersRef.current[tab]) {
        const remaining = Math.max(100, 5000 - (now - last) + 50);
        pendingSyncTimersRef.current[tab] = setTimeout(() => {
          delete pendingSyncTimersRef.current[tab];
          if (activeTabRef.current === tab) {
            syncTabDataRef.current(tab, true);
          } else {
            dirtyTabsRef.current.add(tab);
          }
        }, remaining);
      }
      return;
    }
    lastTabSyncAtRef.current[tab] = now;

    const currentRepos = (useCommitStore.getState().status?.repos ?? [])
      .filter(repo => !hiddenRepoIdsRef.current.has(repo.repoId));
    const gitRepoList = currentRepos.filter(r => useCommitStore.getState().repoMetas.find(m => m.id === r.repoId)?.kind !== 'svn');

    if (tab === 'shelf') {
      gitRepoList.forEach(r => requestShelveList(r.repoId, true));
    } else if (tab === 'stash') {
      gitRepoList.forEach(r => {
        requestStashCount(r.repoId);
        requestStashList(r.repoId, true);
      });
    } else if (tab === 'push') {
      gitRepoList.forEach(r => {
        requestUnpushedCommits(r.repoId, true);
        requestIncomingCommits(r.repoId, true);
      });
    } else if (tab === 'worktree') {
      requestWorktreeList(true);
    } else if (tab === 'subtree') {
      requestSubtreeList(false, true);
    } else if (tab === 'submodule') {
      requestSubmoduleList(true);
    }
  }, [requestShelveList, requestStashCount, requestStashList, requestUnpushedCommits, requestIncomingCommits, requestWorktreeList, requestSubtreeList, requestSubmoduleList]);

  syncTabDataRef.current = syncTabData;

  const switchTab = useCallback((rawTab: TabId) => {
    const tab: TabId = rawTab === 'sync' ? 'push' : rawTab;
    setActiveTab(tab);
    const isFirstVisit = !visitedTabsRef.current.has(tab);
    if (isFirstVisit) {
      setVisitedTabs(prev => {
        const next = new Set(prev).add(tab);
        visitedTabsRef.current = next;
        return next;
      });
    }

    const isDirty = dirtyTabsRef.current.has(tab);
    if (isDirty || isFirstVisit) {
      dirtyTabsRef.current.delete(tab);
      syncTabData(tab, true);
    } else {
      syncTabData(tab, false);
    }
  }, [syncTabData]);

  // ── Message handler ───────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent<HostToCommitMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;

      if ('requestId' in msg && msg.requestId && pendingRef.current.has(msg.requestId as string)) {
        const resolve = pendingRef.current.get(msg.requestId as string)!;
        pendingRef.current.delete(msg.requestId as string);
        resolve(msg);
      }

      switch (msg.type) {
        case 'COMMIT_REFRESH_START': {
          commitStatusRefreshPendingRef.current = true;
          for (const timer of Object.values(pendingSyncTimersRef.current)) {
            if (timer) clearTimeout(timer);
          }
          pendingSyncTimersRef.current = {};
          lastTabSyncAtRef.current = {};
          lastSubtreeListRequestAtRef.current = 0;
          lastSubtreeStatusCheckAtRef.current = 0;
          subtreeStatusCheckingRef.current = false;
          dirtyTabsRef.current.clear();
          const currentTab = activeTabRef.current;
          const visited = visitedTabsRef.current;
          for (const tab of visited) {
            if (tab !== currentTab && tab !== 'changes') {
              markTabDirty(tab);
            }
          }
          const freshRepos = useCommitStore.getState().status?.repos ?? [];
          const gitRepoList = freshRepos.filter(r => useCommitStore.getState().repoMetas.find(m => m.id === r.repoId)?.kind !== 'svn');
          gitRepoList.forEach(r => requestShelveList(r.repoId, currentTab !== 'shelf'));
          if (currentTab === 'stash') gitRepoList.forEach(r => { requestStashCount(r.repoId); requestStashList(r.repoId, true); });
          if (currentTab === 'push') gitRepoList.forEach(r => { requestUnpushedCommits(r.repoId, true); requestIncomingCommits(r.repoId, true); });
          if (currentTab === 'worktree') requestWorktreeList(true);
          if (currentTab === 'submodule') requestSubmoduleList(true);
          // The host refresh path owns subtree refreshes so expensive split/remote
          // checks are not started twice by the same manual refresh.
          break;
        }
        case 'COMMIT_STATUS_UPDATE': {
          const isManualRefresh = commitStatusRefreshPendingRef.current;
          commitStatusRefreshPendingRef.current = false;
          store.setStatus(msg.repos, msg.status, msg.iconTheme, msg.fileViewMode, msg.defaultCommitAction, msg.defaultSaveAction, msg.hasWorkspaceFolder, msg.noVerify);
          if (Array.isArray(msg.status.repos) && useCommitStore.getState().changesViewMode === 'vscode') {
            const prevCounts = prevUnstagedCountsRef.current;
            let hasNewChanges = false;
            for (const repo of msg.status.repos) {
              const prev = prevCounts.get(repo.repoId) ?? 0;
              const curr = (repo.unstagedFiles ?? []).length;
              if (prev === 0 && curr > 0) hasNewChanges = true;
              prevCounts.set(repo.repoId, curr);
            }
            if (hasNewChanges && useCommitStore.getState().isCollapsed('vscode-section:unstaged')) {
              useCommitStore.getState().toggleCollapsed('vscode-section:unstaged');
            }
          } else if (Array.isArray(msg.status.repos)) {
            const prevCounts = prevUnstagedCountsRef.current;
            for (const repo of msg.status.repos) {
              prevCounts.set(repo.repoId, (repo.unstagedFiles ?? []).length);
            }
          }

          // Always keep stash and shelve count badges updated on status updates
          const currentGitRepos = (msg.status?.repos ?? []).filter(r => msg.repos.find(m => m.id === r.repoId)?.kind !== 'svn');
          currentGitRepos.forEach(r => {
            requestStashCount(r.repoId);
            requestShelveList(r.repoId, true);
          });

          const currentTab = activeTabRef.current;
          if (!isManualRefresh && currentTab !== 'changes') {
            syncTabData(currentTab, false);
          }

          const visited = visitedTabsRef.current;
          for (const tab of visited) {
            if (tab !== currentTab && tab !== 'changes') {
              markTabDirty(tab);
            }
          }
          break;
        }
        case 'COMMIT_ICON_THEME_UPDATE':
          useCommitStore.setState({ iconTheme: msg.iconTheme });
          break;
        case 'CHANGELISTS_UPDATE':
          store.setChangelists(msg.changelists, msg.viewMode);
          break;
        case 'COMMIT_WORKTREE_DIFF_STARTED':
          store.startWorktreeDiff({
            repoId: msg.repoId,
            repoName: msg.repoName,
            repoColor: msg.repoColor,
            baseRef: msg.baseRef,
            currentRef: msg.currentRef,
            files: msg.files,
          });
          break;
        case 'COMMIT_WORKTREE_DIFF_FILES_RESULT':
          if (msg.error) {
            store.setWorktreeDiffError(msg.error);
          } else {
            store.setWorktreeDiffFiles(msg.files, msg.currentRef);
          }
          break;
        case 'COMMIT_WORKTREE_DIFF_RESULT':
          if (msg.error && msg.error !== 'Cancelled') {
            store.setWorktreeDiffError(msg.error);
          } else {
            store.setWorktreeDiffDiff(msg.diff);
          }
          break;
        case 'COMMIT_OP_RESULT':
          store.setLoading(false);
          {
            const committedMessage = pendingCommitMessagesRef.current.get(msg.requestId);
            pendingCommitMessagesRef.current.delete(msg.requestId);
            if (msg.ok && committedMessage) {
              successfulCommitMessagesRef.current = mergeCommitMessageHistory(
                [committedMessage],
                successfulCommitMessagesRef.current,
              );
              setCommitMessageHistory(prev => mergeCommitMessageHistory(
                successfulCommitMessagesRef.current,
                prev,
              ));
            }
          }
          if (!msg.ok && msg.error && msg.error !== 'Cancelled' && !msg.handled) {
            notifyError(msg.error, msg.repoId);
          }
          break;
        case 'COMMIT_MESSAGE_HISTORY_RESULT':
          if (activeCommitMessageHistoryRequestIdRef.current !== msg.requestId) break;
          activeCommitMessageHistoryRequestIdRef.current = null;
          setCommitMessageHistoryLoading(false);
          setCommitMessageHistory(mergeCommitMessageHistory(
            successfulCommitMessagesRef.current,
            msg.messages,
          ));
          break;
        case 'COMMIT_LAST_COMMIT_MESSAGE_RESULT':
          if (msg.message && !useCommitStore.getState().commitMessage.trim()) {
            store.setCommitMessage(msg.message);
          } else if (msg.error) notifyError(msg.error, msg.repoId);
          break;
        case 'COMMIT_GENERATE_MESSAGE_RESULT':
          if (activeGenerateRequestIdRef.current !== msg.requestId) break;
          activeGenerateRequestIdRef.current = null;
          setGeneratingMessage(false);
          if (msg.message) store.setCommitMessage(msg.message);
          else if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.repoId);
          break;
        case 'COMMIT_SET_MESSAGE':
          if (msg.requestId && activeGenerateRequestIdRef.current !== msg.requestId) break;
          store.setCommitMessage(msg.message);
          break;
        case 'COMMIT_SET_ACTIVE_TAB':
          switchTab(msg.tab);
          break;
        case 'COMMIT_TRIGGER_ACTION':
          commitActionRef.current(msg.andPush);
          break;
        case 'COMMIT_EXPAND_ALL': {
          const currentTab = activeTabRef.current;
          if (currentTab === 'changes') {
            store.expandAll();
          } else if (currentTab === 'shelf') {
            const keys = Object.entries(shelveMapRef.current)
              .flatMap(([repoId, shelves]) => getShelveExpansionKeys(repoId, shelves));
            store.shelveExpandAll(keys);
          } else if (currentTab === 'stash') {
            setStashExpansionCommand(command => ({ sequence: command.sequence + 1, expanded: true }));
          } else if (currentTab === 'push') {
            setPushExpansionCommand(command => ({ sequence: command.sequence + 1, expanded: true }));
          }
          break;
        }
        case 'COMMIT_COLLAPSE_ALL': {
          const currentTab = activeTabRef.current;
          if (currentTab === 'changes') {
            store.collapseAll();
          } else if (currentTab === 'shelf') {
            store.shelveCollapseAll();
          } else if (currentTab === 'stash') {
            setStashExpansionCommand(command => ({ sequence: command.sequence + 1, expanded: false }));
          } else if (currentTab === 'push') {
            setPushExpansionCommand(command => ({ sequence: command.sequence + 1, expanded: false }));
          }
          break;
        }
        case 'COMMIT_SELECT_ALL': {
          const currentTab = activeTabRef.current;
          if (currentTab === 'changes') {
            store.selectAllFiles();
          } else if (currentTab === 'push' || currentTab === 'sync') {
            setPushSelectionCommand(command => ({ sequence: command.sequence + 1, action: 'selectAll' }));
          }
          break;
        }
        case 'COMMIT_INVERT_SELECTION': {
          const currentTab = activeTabRef.current;
          if (currentTab === 'changes') {
            store.invertFileSelections();
          } else if (currentTab === 'push' || currentTab === 'sync') {
            setPushSelectionCommand(command => ({ sequence: command.sequence + 1, action: 'invert' }));
          }
          break;
        }
        case 'COMMIT_SET_FILE_VIEW_MODE': {
          const currentTab = activeTabRef.current;
          if (currentTab === 'changes') {
            store.setViewMode(msg.mode);
            send({ type: 'COMMIT_SET_FILE_VIEW_MODE', mode: msg.mode });
          } else if (currentTab === 'shelf') {
            store.setShelveViewMode(msg.mode);
          } else if (currentTab === 'stash') {
            store.setStashViewMode(msg.mode);
          } else if (currentTab === 'push') {
            store.setViewMode(msg.mode);
          }
          break;
        }
        case 'SHELVE_LIST_RESULT':
          setShelveLoading(prev => ({ ...prev, [msg.repoId]: false }));
          if (msg.error) {
            setShelveError(prev => ({ ...prev, [msg.repoId]: msg.error ?? null }));
          } else {
            setShelveMap(prev => ({ ...prev, [msg.repoId]: msg.shelves }));
            setShelveError(prev => ({ ...prev, [msg.repoId]: null }));
          }
          break;
        case 'SHELVE_OP_RESULT':
          if (!msg.ok) {
            if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.repoId);
          } else {
            if (msg.hasConflicts && msg.conflictFiles?.length) {
              notifyInfo(t('Conflicts in {0} file(s) — merge editor opened', msg.conflictFiles.length), msg.repoId);
            }
            if (activeTabRef.current === 'shelf') {
              requestShelveList(msg.repoId, false);
            } else {
              requestShelveList(msg.repoId, true);
              markTabDirty('shelf');
            }
          }
          break;

        case 'STASH_COUNT_RESULT':
          if (!msg.error) {
            setStashCountMap(prev => ({ ...prev, [msg.repoId]: msg.count }));
          }
          break;

        case 'STASH_LIST_RESULT':
          setStashLoading(prev => ({ ...prev, [msg.repoId]: false }));
          if (msg.error) {
            setStashError(prev => ({ ...prev, [msg.repoId]: msg.error ?? null }));
          } else {
            setStashMap(prev => ({ ...prev, [msg.repoId]: msg.stashes }));
            setStashFilesMap(prev => {
              const validIdentities = new Set(msg.stashes.map(stash => stash.oid ?? stash.ref));
              const currentRepoCache = prev[msg.repoId] ?? {};
              const nextRepoCache = Object.fromEntries(
                Object.entries(currentRepoCache).filter(([identity]) => validIdentities.has(identity)),
              );
              if (Object.keys(nextRepoCache).length === Object.keys(currentRepoCache).length) return prev;
              return { ...prev, [msg.repoId]: nextRepoCache };
            });
            setStashCountMap(prev => ({ ...prev, [msg.repoId]: msg.stashes.length }));
            setStashError(prev => ({ ...prev, [msg.repoId]: null }));
            dirtyTabsRef.current.delete('stash');
          }
          break;

        case 'STASH_FILES_RESULT':
          {
            const stashIdentity = msg.stashOid ?? msg.stashRef;
            inFlightStashRequestsRef.current.delete(`${msg.repoId}:${stashIdentity}`);
            setStashFilesMap(prev => ({
              ...prev,
              [msg.repoId]: {
                ...(prev[msg.repoId] ?? {}),
                [stashIdentity]: { loading: false, files: msg.files, error: msg.error },
              },
            }));
          }
          break;

        case 'STASH_OP_RESULT':
          if (!msg.ok) {
            if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.repoId);
          } else {
            inFlightStashRequestsRef.current.clear();
            // Reset cached files for affected repo
            setStashFilesMap(prev => {
              const next = { ...prev };
              delete next[msg.repoId];
              return next;
            });
            // 数量始终刷新更新角标
            getVsCodeApi().postMessage({ type: 'STASH_COUNT', requestId: generateId(), repoId: msg.repoId } satisfies CommitToHostMsg);
            if (activeTabRef.current === 'stash') {
              setStashLoading(prev => ({ ...prev, [msg.repoId]: true }));
              getVsCodeApi().postMessage({ type: 'STASH_LIST', requestId: generateId(), repoId: msg.repoId } satisfies CommitToHostMsg);
            } else {
              markTabDirty('stash');
            }
          }
          break;

        case 'PUSH_UNPUSHED_RESULT':
          if (msg.repos) {
            setUnpushedMap(prev => {
              const next = { ...prev };
              for (const item of msg.repos!) {
                next[item.repoId] = { loading: false, commits: item.commits, error: item.error };
              }
              return next;
            });
            dirtyTabsRef.current.delete('push');
          } else if (msg.repoId) {
            setUnpushedMap(prev => ({
              ...prev,
              [msg.repoId!]: { loading: false, commits: msg.commits ?? [], error: msg.error },
            }));
            dirtyTabsRef.current.delete('push');
          }
          break;

        case 'PUSH_SQUASH_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.repoId);
          break;
        case 'PUSH_DROP_RESULT':
        case 'PUSH_REVERT_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.repoId);
          break;
        case 'PUSH_EDIT_MSG_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.repoId);
          break;

        case 'SYNC_INCOMING_RESULT':
          if (msg.repos) {
            setIncomingMap(prev => {
              const next = { ...prev };
              for (const item of msg.repos!) {
                next[item.repoId] = { loading: false, commits: item.commits ?? [], error: item.error };
              }
              return next;
            });
            dirtyTabsRef.current.delete('push');
          } else if (msg.repoId) {
            setIncomingMap(prev => ({
              ...prev,
              [msg.repoId!]: { loading: false, commits: msg.commits ?? [], error: msg.error },
            }));
            dirtyTabsRef.current.delete('push');
          }
          break;

        case 'SYNC_FETCH_RESULT':
          if (msg.partial) {
            // 部分成功已由 Host 侧弹出警告，Webview 不重复弹出 Fetch completed
          } else if (msg.ok) {
            const currentGitRepos = (useCommitStore.getState().status?.repos ?? []).filter(r => useCommitStore.getState().repoMetas.find(m => m.id === r.repoId)?.kind !== 'svn');
            const targetRepoId = msg.repoId ?? (currentGitRepos.length === 1 ? currentGitRepos[0].repoId : undefined);
            notifyInfo(t('Fetch completed.'), targetRepoId);
          } else if (msg.error) {
            notifyError(msg.error, msg.repoId);
          }
          if (msg.ok || msg.partial) {
            const currentGitRepos = (useCommitStore.getState().status?.repos ?? []).filter(r => useCommitStore.getState().repoMetas.find(m => m.id === r.repoId)?.kind !== 'svn');
            currentGitRepos.forEach(r => {
              requestIncomingCommits(r.repoId, true);
              requestUnpushedCommits(r.repoId, true);
            });
          }
          break;

        case 'SYNC_PULL_RESULT':
          if (msg.ok) {
            const currentGitRepos = (useCommitStore.getState().status?.repos ?? []).filter(r => useCommitStore.getState().repoMetas.find(m => m.id === r.repoId)?.kind !== 'svn');
            currentGitRepos.forEach(r => {
              requestIncomingCommits(r.repoId, true);
              requestUnpushedCommits(r.repoId, true);
            });
          } else if (msg.error) {
            notifyError(msg.error, msg.repoId);
          }
          break;

        case 'SUBMODULE_OP_RESULT': {
          setSubmoduleOps(prev => {
            const next = { ...prev };
            if (msg.op === 'update-all') {
              if (msg.parentRepoId) delete next[`${msg.parentRepoId}:__all__`];
              delete next['__all__'];
            } else {
              delete next[`${msg.parentRepoId}:${msg.submodulePath}`];
            }
            return next;
          });
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.parentRepoId);
          else if (msg.ok && (msg.op === 'init' || msg.op === 'deinit' || msg.op === 'update' || msg.op === 'sync' || msg.op === 'update-all' || msg.op === 'add' || msg.op === 'remove')) {
            requestCommitStatus({ refreshSubtrees: false });
          }
          break;
        }

        case 'SUBMODULE_LIST_RESULT':
          setSubmoduleInitialLoaded(true);
          submoduleInitialLoadedRef.current = true;
          setSubmoduleLoading(false);
          setSubmoduleRepos(msg.repos);
          dirtyTabsRef.current.delete('submodule');
          if (msg.error) setSubmoduleError(msg.error);
          else setSubmoduleError(null);
          break;

        case 'SUBMODULE_DIFF_SUMMARY_RESULT':
          setSubmoduleDiffModal(prev => {
            if (!prev || prev.parentRepoId !== msg.parentRepoId || prev.submodulePath !== msg.submodulePath) return prev;
            return {
              ...prev,
              loading: false,
              oldHash: msg.oldHash,
              newHash: msg.newHash,
              parentCommit: msg.parentCommit,
              indexCommit: msg.indexCommit,
              headCommit: msg.headCommit,
              summary: msg.summary,
              error: msg.error,
            };
          });
          break;

        case 'SUBMODULE_PUSH_RESULT':
        case 'SUBMODULE_PULL_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.repoId);
          break;

        case 'WORKTREE_LIST_RESULT':
          setWorktreeLoading(false);
          setWorktreeRepos(msg.repos);
          dirtyTabsRef.current.delete('worktree');
          break;

        case 'WORKTREE_OP_RESULT':
          if (!msg.ok) {
            if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error, msg.repoId);
          } else {
            if (activeTabRef.current === 'worktree') {
              requestWorktreeList(true);
            } else {
              markTabDirty('worktree');
            }
          }
          break;

        case 'SUBTREE_LIST_RESULT':
          setSubtreeLoading(false);
          if (msg.error) {
            setSubtreeError(msg.error);
            subtreeStatusCheckingRef.current = false;
          } else {
            subtreeEntriesRef.current = msg.entries;
            setSubtreeEntries(msg.entries);
            setSubtreeError(null);
            dirtyTabsRef.current.delete('subtree');
            if (msg.entries.length === 0) {
              subtreeStatusCheckingRef.current = false;
            }
          }
          break;

        case 'SUBTREE_STATUS_RESULT':
          setSubtreeStatuses(prev => {
            const next = { ...prev, ...msg.statuses };
            subtreeStatusesRef.current = next;
            const hasPending = subtreeEntriesRef.current.some(entry => next[entry.id]?.loading);
            if (!hasPending) {
              subtreeStatusCheckingRef.current = false;
            }
            return next;
          });
          break;

        case 'SUBTREE_OP_RESULT':
          if (msg.entryId) {
            setSubtreeOps(prev => {
              const next = { ...prev };
              delete next[msg.entryId!];
              return next;
            });
          }
          if (msg.ok) {
            if (activeTabRef.current !== 'push') markTabDirty('push');
            if (activeTabRef.current !== 'subtree') markTabDirty('subtree');
          }
          break;

        case 'COMMIT_HIDDEN_REPOS_UPDATE':
          hiddenRepoIdsRef.current = new Set(msg.hiddenRepoIds);
          setHiddenRepoIds(msg.hiddenRepoIds);
          break;

        case 'COMMIT_SWITCH_TAB':
          switchTab(msg.tab);
          break;
      }
    };
    window.addEventListener('message', handler);
    requestCommitStatus();
    return () => {
      window.removeEventListener('message', handler);
      for (const timer of Object.values(pendingSyncTimersRef.current)) {
        if (timer) clearTimeout(timer);
      }
      pendingSyncTimersRef.current = {};
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Shelve callbacks ──────────────────────────────────────────────────────

  const confirmShelve = useCallback((repoId: string, name: string, paths?: string[]) => {
    if (!name.trim()) return;
    send({ type: 'SHELVE_PUSH', requestId: generateId(), repoId, name: name.trim(), paths });
    setShelvePrompt(null);
  }, [send]);

  const handleUnshelve = useCallback((repoId: string, shelveId: string) => {
    send({ type: 'SHELVE_APPLY', requestId: generateId(), repoId, shelveId });
  }, [send]);

  const handleUnshelveAndDrop = useCallback((repoId: string, shelveId: string) => {
    send({ type: 'SHELVE_APPLY', requestId: generateId(), repoId, shelveId, drop: true });
  }, [send]);

  const handleUnshelveFile = useCallback((repoId: string, shelveId: string, filePath: string) => {
    send({ type: 'SHELVE_APPLY', requestId: generateId(), repoId, shelveId, paths: [filePath] });
  }, [send]);

  const handleDropShelve = useCallback((repoId: string, shelveId: string) => {
    send({ type: 'SHELVE_DROP', requestId: generateId(), repoId, shelveId });
  }, [send]);

  const handleOpenFileDiff = useCallback((repoId: string, shelveId: string, filePath: string) => {
    send({ type: 'SHELVE_OPEN_FILE_DIFF', repoId, shelveId, filePath });
  }, [send]);

  // ── Stash callbacks ───────────────────────────────────────────────────────

  const handleStashApply = useCallback((repoId: string, stashRef: string) => {
    send({ type: 'STASH_APPLY', requestId: generateId(), repoId, stashRef });
  }, [send]);

  const handleStashPop = useCallback((repoId: string, stashRef: string) => {
    send({ type: 'STASH_POP', requestId: generateId(), repoId, stashRef });
  }, [send]);

  const handleStashDrop = useCallback((repoId: string, stashRef: string) => {
    send({ type: 'STASH_DROP', requestId: generateId(), repoId, stashRef });
  }, [send]);

  const handleStashShowFileDiff = useCallback((repoId: string, stashRef: string, filePath: string) => {
    send({ type: 'STASH_OPEN_FILE_DIFF', repoId, stashRef, filePath });
  }, [send]);

  // ── Worktree callbacks ────────────────────────────────────────────────────

  const handleWorktreeDelete = useCallback((repoId: string, worktreePath: string, force: boolean) => {
    send({ type: 'WORKTREE_DELETE', requestId: generateId(), repoId, worktreePath, force });
  }, [send]);

  const handleWorktreeLock = useCallback((repoId: string, worktreePath: string) => {
    send({ type: 'WORKTREE_LOCK', requestId: generateId(), repoId, worktreePath });
  }, [send]);

  const handleWorktreeUnlock = useCallback((repoId: string, worktreePath: string) => {
    send({ type: 'WORKTREE_UNLOCK', requestId: generateId(), repoId, worktreePath });
  }, [send]);

  const handleWorktreePrune = useCallback((repoId: string) => {
    send({ type: 'WORKTREE_PRUNE', requestId: generateId(), repoId });
  }, [send]);

  const handleWorktreeOpenInExplorer = useCallback((repoId: string, worktreePath: string) => {
    send({ type: 'WORKTREE_OPEN_IN_EXPLORER', repoId, worktreePath });
  }, [send]);

  const handleWorktreeOpenInNewWindow = useCallback((worktreePath: string) => {
    send({ type: 'WORKTREE_OPEN_IN_NEW_WINDOW', worktreePath });
  }, [send]);

  const handleWorktreeOpenInOS = useCallback((worktreePath: string) => {
    send({ type: 'WORKTREE_OPEN_IN_OS', worktreePath });
  }, [send]);

  const handleWorktreeAddToWorkspace = useCallback((worktreePath: string) => {
    send({ type: 'WORKTREE_ADD_TO_WORKSPACE', worktreePath });
  }, [send]);

  const handleWorktreeRequestCreate = useCallback((repoId: string) => {
    send({ type: 'WORKTREE_CREATE_PROMPT', repoId } as CommitToHostMsg);
  }, [send]);

  // ── Stash files callback ──────────────────────────────────────────────────
  const requestStashFiles = useCallback((repoId: string, stashRef: string, stashOid?: string) => {
    const stashIdentity = stashOid ?? stashRef;
    inFlightStashRequestsRef.current.add(`${repoId}:${stashIdentity}`);
    setStashFilesMap(prev => ({
      ...prev,
      [repoId]: {
        ...(prev[repoId] ?? {}),
        [stashIdentity]: { loading: true, files: prev[repoId]?.[stashIdentity]?.files },
      },
    }));
    send({ type: 'STASH_GET_FILES', requestId: generateId(), repoId, stashRef, stashOid });
  }, [send]);

  // ── Subtree callbacks ────────────────────────────────────────────────────

  const handleSubtreeAdd = useCallback((repoId?: string) => {
    send({ type: 'SUBTREE_ADD_PROMPT', repoId });
  }, [send]);

  const handleSubtreeRegister = useCallback((repoId?: string) => {
    send({ type: 'SUBTREE_REGISTER_PROMPT', repoId });
  }, [send]);

  const handleSubtreePull = useCallback((entryId: string) => {
    setSubtreeOps(prev => ({ ...prev, [entryId]: 'pull' }));
    send({ type: 'SUBTREE_PULL', requestId: generateId(), entryId });
  }, [send]);

  const handleSubtreePush = useCallback((entryId: string) => {
    setSubtreeOps(prev => ({ ...prev, [entryId]: 'push' }));
    send({ type: 'SUBTREE_PUSH', requestId: generateId(), entryId });
  }, [send]);

  const handleSubtreeSplit = useCallback((entryId: string) => {
    send({ type: 'SUBTREE_SPLIT_PROMPT', requestId: generateId(), entryId });
  }, [send]);

  const handleSubtreeMerge = useCallback((entryId: string) => {
    send({ type: 'SUBTREE_MERGE_PROMPT', requestId: generateId(), entryId });
  }, [send]);

  const handleSubtreeRemove = useCallback((entryId: string) => {
    setSubtreeOps(prev => ({ ...prev, [entryId]: 'remove' }));
    send({ type: 'SUBTREE_REMOVE', requestId: generateId(), entryId });
  }, [send]);

  const handleSubtreeEdit = useCallback((entryId: string) => {
    send({ type: 'SUBTREE_EDIT_PROMPT', entryId });
  }, [send]);

  const handleSubtreeDeleteRegistry = useCallback((entryId: string) => {
    setSubtreeOps(prev => ({ ...prev, [entryId]: 'delete' }));
    send({ type: 'SUBTREE_DELETE_REGISTRY', requestId: generateId(), entryId });
  }, [send]);

  const handleSubtreeReveal = useCallback((entryId: string) => {
    send({ type: 'SUBTREE_REVEAL_PREFIX', entryId });
  }, [send]);

  // ── Submodule callbacks ──────────────────────────────────────────────────

  const handleSubmoduleRefresh = useCallback(() => {
    requestSubmoduleList(false);
  }, [requestSubmoduleList]);

  const handleSubmoduleInit = useCallback((parentRepoId: string, submodulePath: string) => {
    setSubmoduleOps(prev => ({ ...prev, [`${parentRepoId}:${submodulePath}`]: 'init' }));
    send({ type: 'SUBMODULE_INIT', requestId: generateId(), parentRepoId, submodulePath });
  }, [send]);

  const handleSubmoduleUpdate = useCallback((parentRepoId: string, submodulePath: string, recursive = false, remote = false) => {
    setSubmoduleOps(prev => ({ ...prev, [`${parentRepoId}:${submodulePath}`]: 'update' }));
    send({ type: 'SUBMODULE_UPDATE', requestId: generateId(), parentRepoId, submodulePath, recursive, remote });
  }, [send]);

  const handleSubmoduleUpdateAll = useCallback((parentRepoId?: string, recursive = true, init = true) => {
    const opKey = parentRepoId ? `${parentRepoId}:__all__` : '__all__';
    setSubmoduleOps(prev => ({ ...prev, [opKey]: 'update-all' }));
    send({ type: 'SUBMODULE_UPDATE_ALL', parentRepoId, recursive, init });
  }, [send]);

  const handleSubmoduleOpenConflict = useCallback((parentRepoId: string, submodulePath: string, companionPath?: string) => {
    send({ type: 'SUBMODULE_OPEN_CONFLICT', parentRepoId, submodulePath, companionPath });
  }, [send]);

  const handleSubmoduleResolveConflict = useCallback((parentRepoId: string, submodulePath: string, side: 'ours' | 'theirs') => {
    setSubmoduleOps(prev => ({ ...prev, [`${parentRepoId}:${submodulePath}`]: 'update' }));
    send({ type: 'SUBMODULE_RESOLVE_CONFLICT', requestId: generateId(), parentRepoId, submodulePath, side });
  }, [send]);

  const handleSubmoduleSync = useCallback((parentRepoId: string, submodulePath?: string) => {
    if (submodulePath) {
      setSubmoduleOps(prev => ({ ...prev, [`${parentRepoId}:${submodulePath}`]: 'sync' }));
    }
    send({ type: 'SUBMODULE_SYNC', requestId: generateId(), parentRepoId, submodulePath });
  }, [send]);

  const handleSubmoduleDeinit = useCallback((parentRepoId: string, submodulePath: string) => {
    setSubmoduleOps(prev => ({ ...prev, [`${parentRepoId}:${submodulePath}`]: 'deinit' }));
    send({ type: 'SUBMODULE_DEINIT', requestId: generateId(), parentRepoId, submodulePath });
  }, [send]);

  const handleSubmoduleRemove = useCallback((parentRepoId: string, submodulePath: string) => {
    setSubmoduleOps(prev => ({ ...prev, [`${parentRepoId}:${submodulePath}`]: 'remove' }));
    send({ type: 'SUBMODULE_REMOVE', requestId: generateId(), parentRepoId, submodulePath });
  }, [send]);

  const handleSubmoduleAdd = useCallback((parentRepoId?: string) => {
    send({ type: 'SUBMODULE_ADD_PROMPT', repoId: parentRepoId });
  }, [send]);

  const handleSubmoduleOpenInNewWindow = useCallback((absPath: string) => {
    send({ type: 'WORKTREE_OPEN_IN_NEW_WINDOW', worktreePath: absPath });
  }, [send]);

  const handleSubmoduleOpenInOS = useCallback((absPath: string) => {
    send({ type: 'WORKTREE_OPEN_IN_OS', worktreePath: absPath });
  }, [send]);

  const handleSubmoduleRevealInExplorer = useCallback((parentRepoId: string, relPath: string) => {
    send({ type: 'COMMIT_REVEAL_IN_EXPLORER', repoId: parentRepoId, filePath: relPath });
  }, [send]);

  const openSubmoduleDiffSummary = useCallback((parentRepoId: string, submodulePath: string) => {
    setSubmoduleDiffModal({
      open: true,
      parentRepoId,
      submodulePath,
      loading: true,
    });
    send({ type: 'SUBMODULE_GET_DIFF_SUMMARY', requestId: generateId(), parentRepoId, submodulePath });
  }, [send]);

  // ── Push / unpushed callbacks ─────────────────────────────────────────────

  const requestPushCommitFiles = useCallback((repoId: string, hash: string): Promise<PushCommitFile[]> => {
    const requestId = generateId();
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        if (pendingRef.current.has(requestId)) {
          pendingRef.current.delete(requestId);
          resolve([]);
        }
      }, 15_000);
      pendingRef.current.set(requestId, msg => {
        clearTimeout(timeout);
        if (msg.type !== 'PUSH_COMMIT_FILES_RESULT') {
          resolve([]);
          return;
        }
        if (msg.error && msg.error !== 'Cancelled') {
          notifyError(msg.error, repoId);
        }
        resolve(msg.files);
      });
      send({ type: 'PUSH_GET_COMMIT_FILES', requestId, repoId, hash });
    });
  }, [notifyError, send]);

  const requestAggregatedPushDiff = useCallback((repoId: string, oldestHash?: string): Promise<PushCommitFile[]> => {
    const requestId = generateId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingRef.current.has(requestId)) {
          pendingRef.current.delete(requestId);
          reject(new Error(t('Timed out loading aggregated changes.')));
        }
      }, 15_000);
      pendingRef.current.set(requestId, msg => {
        clearTimeout(timeout);
        if (msg.type !== 'PUSH_AGGREGATED_DIFF_RESULT') {
          reject(new Error(t('Unexpected aggregated changes response.')));
          return;
        }
        if (msg.error) {
          if (msg.error !== 'Cancelled') notifyError(msg.error, repoId);
          reject(new Error(msg.error));
          return;
        }
        resolve(msg.files ?? []);
      });
      send({ type: 'PUSH_GET_AGGREGATED_DIFF', requestId, repoId, oldestHash });
    });
  }, [notifyError, send]);

  const openPushCommitFileDiff = useCallback((repoId: string, hash: string, file: PushCommitFile) => {
    send({
      type: 'PUSH_OPEN_COMMIT_FILE_DIFF',
      repoId,
      hash,
      filePath: file.path,
      fileStatus: file.status,
    });
  }, [send]);

  const openAggregatedPushFileDiff = useCallback((repoId: string, oldestHash: string | undefined, file: PushCommitFile) => {
    send({
      type: 'PUSH_OPEN_AGGREGATED_FILE_DIFF',
      repoId,
      oldestHash,
      filePath: file.path,
      fileStatus: file.status,
    });
  }, [send]);

  const requestAggregatedIncomingDiff = useCallback((repoId: string): Promise<PushCommitFile[]> => {
    const requestId = generateId();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (pendingRef.current.has(requestId)) {
          pendingRef.current.delete(requestId);
          reject(new Error(t('Timed out loading aggregated incoming changes.')));
        }
      }, 15_000);
      pendingRef.current.set(requestId, msg => {
        clearTimeout(timeout);
        if (msg.type !== 'SYNC_INCOMING_AGGREGATED_DIFF_RESULT') {
          reject(new Error(t('Unexpected aggregated changes response.')));
          return;
        }
        if (msg.error) {
          if (msg.error !== 'Cancelled') notifyError(msg.error, repoId);
          reject(new Error(msg.error));
          return;
        }
        resolve(msg.files ?? []);
      });
      send({ type: 'SYNC_GET_INCOMING_AGGREGATED_DIFF', requestId, repoId });
    });
  }, [notifyError, send]);

  const openIncomingCommitFileDiff = useCallback((repoId: string, hash: string, file: PushCommitFile) => {
    send({
      type: 'SYNC_OPEN_INCOMING_COMMIT_FILE_DIFF',
      repoId,
      hash,
      filePath: file.path,
      fileStatus: file.status,
    });
  }, [send]);

  const openAggregatedIncomingFileDiff = useCallback((repoId: string, file: PushCommitFile) => {
    send({
      type: 'SYNC_OPEN_INCOMING_AGGREGATED_FILE_DIFF',
      repoId,
      filePath: file.path,
      fileStatus: file.status,
    });
  }, [send]);

  const selectWorktreeDiffFile = useCallback((file: FileStatus) => {
    store.selectWorktreeDiffFile(file);
    send({
      type: 'COMMIT_OPEN_WORKTREE_DIFF',
      repoId: file.repoId,
      baseRef: store.worktreeDiffState?.baseRef ?? 'HEAD',
      filePath: file.path,
    });
  }, [send, store]);

  // ── Diff open ─────────────────────────────────────────────────────────────
  const openDiff = useCallback((repoId: string, filePath: string) => {
    const repoStatus = store.status?.repos.find(r => r.repoId === repoId);
    const file = [...(repoStatus?.stagedFiles ?? []), ...(repoStatus?.unstagedFiles ?? [])]
      .find(item => item.path === filePath);
    if (file?.submodule?.isSubmodule) {
      openSubmoduleDiffSummary(repoId, filePath);
      return;
    }
    const isStaged = repoStatus?.stagedFiles.some(f => f.path === filePath) ?? false;
    send({ type: 'COMMIT_OPEN_DIFF', repoId, filePath, staged: isStaged });
  }, [store, send, openSubmoduleDiffSummary]);

  const repos = useMemo(() => {
    const all = store.status?.repos ?? [];
    return hiddenRepoIds.length > 0 ? all.filter(r => !hiddenRepoIds.includes(r.repoId)) : all;
  }, [store.status?.repos, hiddenRepoIds]);
  const metaMap = useMemo(() => new Map(store.repoMetas.map(m => [m.id, m])), [store.repoMetas]);
  const requestCommitMessageHistory = useCallback(() => {
    const repoIds = repos.map(repo => repo.repoId);
    if (repoIds.length === 0) {
      activeCommitMessageHistoryRequestIdRef.current = null;
      setCommitMessageHistory([]);
      setCommitMessageHistoryLoading(false);
      return;
    }
    const requestId = generateId();
    activeCommitMessageHistoryRequestIdRef.current = requestId;
    setCommitMessageHistoryLoading(true);
    send({ type: 'COMMIT_REQUEST_MESSAGE_HISTORY', requestId, repoIds, limit: COMMIT_MESSAGE_HISTORY_FETCH_LIMIT });
    setTimeout(() => {
      if (activeCommitMessageHistoryRequestIdRef.current === requestId) {
        setCommitMessageHistoryLoading(false);
      }
    }, 15_000);
  }, [repos, send]);
  const isSvnRepo = useCallback((repoId: string) => metaMap.get(repoId)?.kind === 'svn', [metaMap]);
  const gitRepos = useMemo(() => repos.filter(repo => !isSvnRepo(repo.repoId)), [repos, isSvnRepo]);
  const totalToPush = gitRepos.reduce((sum, r) => {
    if (r.branch.upstream && !r.branch.isGone) return sum + (r.branch.aheadBehind?.ahead ?? 0);
    return sum + (unpushedMap[r.repoId]?.commits?.length ?? 0);
  }, 0);
  const totalToPull = gitRepos.reduce((sum, r) => {
    const behind = r.branch.aheadBehind?.behind ?? 0;
    if (behind > 0) return sum + behind;
    return sum + (incomingMap[r.repoId]?.commits?.length ?? 0);
  }, 0);
  const showVcsBadges = gitRepos.length > 0 && gitRepos.length < repos.length;
  const gitRepoMetas = store.repoMetas.filter(meta => meta.kind !== 'svn');
  const visibleTabs = (repos.length > 0 && gitRepos.length === 0) ? SVN_ONLY_TABS : ALL_TABS;
  const visibleRepoIds = new Set(repos.map(repo => repo.repoId));
  const multiRepo = repos.length >= 1;

  // ── Changes speed search ───────────────────────────────────────────────────
  const changesScrollContainerRef = useRef<HTMLDivElement>(null);
  const savedCollapsedKeysBeforeSearchRef = useRef<Set<string> | null>(null);

  interface ChangesSpeedSearchItem {
    file: FileStatus;
    staged?: boolean;
    key: string;
  }

  const allChangesFiles = useMemo<ChangesSpeedSearchItem[]>(() => {
    const list: ChangesSpeedSearchItem[] = [];
    if (store.changesViewMode === 'vscode') {
      for (const r of repos) {
        for (const f of r.stagedFiles) {
          list.push({
            file: f,
            staged: true,
            key: scopedKey(f.repoId, 'staged', f.path),
          });
        }
        for (const f of r.unstagedFiles) {
          list.push({
            file: f,
            staged: false,
            key: scopedKey(f.repoId, 'unstaged', f.path),
          });
        }
      }
    } else {
      const seen = new Set<string>();
      for (const r of repos) {
        for (const f of [...r.stagedFiles, ...r.unstagedFiles]) {
          const k = scopedKey(f.repoId, f.path);
          if (!seen.has(k)) {
            seen.add(k);
            list.push({
              file: f,
              key: k,
            });
          }
        }
      }
    }
    return list;
  }, [repos, store.changesViewMode]);

  const changesSpeedSearch = useSpeedSearch<ChangesSpeedSearchItem>({
    items: allChangesFiles,
    getItemKey: item => item.key,
    getItemPath: item => item.file.path,
    getItemName: item => (item.file.path === '.' ? (metaMap.get(item.file.repoId)?.name ?? item.file.repoId) : (item.file.path.split('/').pop() ?? item.file.path)),
    containerRef: changesScrollContainerRef,
    enabled: activeTab === 'changes' && store.panelMode !== 'worktreeDiff',
    onActiveChange: (item) => {
      if (item) {
        setSelectedFile(item.file);
      }
    },
    onExpandParents: (matchedItems) => {
      const currentCollapsed = useCommitStore.getState().collapsedKeys;
      if (!savedCollapsedKeysBeforeSearchRef.current) {
        savedCollapsedKeysBeforeSearchRef.current = new Set(currentCollapsed);
      }
      const nextCollapsed = new Set(currentCollapsed);
      let changed = false;
      const removeKey = (k: string) => {
        if (nextCollapsed.has(k)) {
          nextCollapsed.delete(k);
          changed = true;
        }
      };
      for (const item of matchedItems) {
        const f = item.file;
        removeKey(scopedKey('repo', f.repoId));
        if (item.staged !== undefined) {
          const section = item.staged ? 'staged' : 'unstaged';
          removeKey(`vscode-section:${section}`);
          removeKey(scopedKey('vscode-repo', section, f.repoId));
          const parts = f.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            const dirPath = parts.slice(0, i).join('/');
            removeKey(scopedKey('vscode-dir', section, f.repoId, dirPath));
          }
        } else {
          removeKey('vscode-section:staged');
          removeKey('vscode-section:unstaged');
          removeKey(scopedKey('vscode-repo', 'staged', f.repoId));
          removeKey(scopedKey('vscode-repo', 'unstaged', f.repoId));
          const parts = f.path.split('/');
          for (let i = 1; i < parts.length; i++) {
            const dirPath = parts.slice(0, i).join('/');
            removeKey(scopedKey('tree-dir', f.repoId, dirPath));
            removeKey(scopedKey('vscode-dir', 'staged', f.repoId, dirPath));
            removeKey(scopedKey('vscode-dir', 'unstaged', f.repoId, dirPath));
          }
          for (const cl of store.changelists) {
            removeKey(scopedKey('changelist', cl.id));
            removeKey(scopedKey('changelist-repo', cl.id, f.repoId));
          }
          removeKey(scopedKey('changelist-repo', '', f.repoId));
        }
      }
      if (changed) {
        store.setCollapsedKeys(nextCollapsed);
      }
    },
    onRestoreCollapsed: () => {
      if (savedCollapsedKeysBeforeSearchRef.current) {
        store.setCollapsedKeys(savedCollapsedKeysBeforeSearchRef.current);
        savedCollapsedKeysBeforeSearchRef.current = null;
      }
    },
  });

  // ── Shelf Speed Search ──────────────────────────────────────────────────
  interface ShelveSpeedSearchItem {
    repoId: string;
    shelveId: string;
    path: string;
    status: string;
  }
  const allShelveFiles = useMemo<ShelveSpeedSearchItem[]>(() => {
    const list: ShelveSpeedSearchItem[] = [];
    for (const repo of gitRepos) {
      const shelves = shelveMap[repo.repoId] ?? [];
      for (const entry of shelves) {
        for (const file of entry.files) {
          list.push({
            repoId: repo.repoId,
            shelveId: entry.id,
            path: file.path,
            status: file.status,
          });
        }
      }
    }
    return list;
  }, [gitRepos, shelveMap]);

  const savedShelveCollapsedKeysRef = useRef<Set<string> | null>(null);
  const shelveScrollContainerRef = useRef<HTMLDivElement | null>(null);

  const shelveSpeedSearch = useSpeedSearch<ShelveSpeedSearchItem>({
    items: allShelveFiles,
    getItemKey: item => scopedKey(item.repoId, item.shelveId, item.path),
    getItemPath: item => item.path,
    getItemName: item => item.path.split('/').pop() ?? item.path,
    containerRef: shelveScrollContainerRef,
    enabled: activeTab === 'shelf' && store.panelMode !== 'worktreeDiff',
    onExpandParents: (matchedItems) => {
      const currentExpanded = useCommitStore.getState().shelveCollapsedKeys;
      if (!savedShelveCollapsedKeysRef.current) {
        savedShelveCollapsedKeysRef.current = new Set(currentExpanded);
      }
      const nextExpanded = new Set(currentExpanded);
      let changed = false;
      for (const item of matchedItems) {
        const entryK = shelveEntryKey(item.repoId, item.shelveId);
        if (!nextExpanded.has(entryK)) {
          nextExpanded.add(entryK);
          changed = true;
        }
        const parts = item.path.split('/');
        for (let i = 1; i < parts.length; i++) {
          const dirK = shelveDirKey(item.repoId, item.shelveId, parts.slice(0, i).join('/'));
          if (!nextExpanded.has(dirK)) {
            nextExpanded.add(dirK);
            changed = true;
          }
        }
      }
      if (changed) {
        store.setShelveCollapsedKeys(nextExpanded);
      }
    },
    onRestoreCollapsed: () => {
      if (savedShelveCollapsedKeysRef.current) {
        store.setShelveCollapsedKeys(savedShelveCollapsedKeysRef.current);
        savedShelveCollapsedKeysRef.current = null;
      }
    },
  });

  // ── Stash Speed Search ──────────────────────────────────────────────────
  type StashSpeedSearchItem =
    | {
        kind: 'stash';
        repoId: string;
        stashRef: string;
        message: string;
        branch?: string;
      }
    | {
        kind: 'file';
        repoId: string;
        stashRef: string;
        path: string;
        status: string;
      };

  const allStashItems = useMemo<StashSpeedSearchItem[]>(() => {
    const list: StashSpeedSearchItem[] = [];
    for (const repo of gitRepos) {
      const stashes = stashMap[repo.repoId] ?? [];
      const repoFilesMap = stashFilesMap[repo.repoId];
      for (const entry of stashes) {
        list.push({
          kind: 'stash',
          repoId: repo.repoId,
          stashRef: entry.ref,
          message: entry.message || entry.ref,
          branch: entry.branch,
        });
        const stashIdentity = entry.oid ?? entry.ref;
        const files = repoFilesMap?.[stashIdentity]?.files ?? entry.files ?? [];
        for (const file of files) {
          list.push({
            kind: 'file',
            repoId: repo.repoId,
            stashRef: entry.ref,
            path: file.path,
            status: file.status,
          });
        }
      }
    }
    return list;
  }, [gitRepos, stashMap, stashFilesMap]);

  const stashScrollContainerRef = useRef<HTMLDivElement | null>(null);

  const stashSpeedSearch = useSpeedSearch<StashSpeedSearchItem>({
    items: allStashItems,
    getItemKey: item => item.kind === 'stash' ? scopedKey(item.repoId, item.stashRef) : scopedKey(item.repoId, item.stashRef, item.path),
    getItemPath: item => item.kind === 'stash' ? item.message : item.path,
    getItemName: item => item.kind === 'stash' ? item.message : (item.path.split('/').pop() ?? item.path),
    containerRef: stashScrollContainerRef,
    enabled: activeTab === 'stash' && store.panelMode !== 'worktreeDiff',
  });

  // 当处于 Stash 页且开启搜索时，自动预取尚未加载文件列表的 Stash 项
  useEffect(() => {
    if (activeTab !== 'stash' || !stashSpeedSearch.isOpen || store.panelMode === 'worktreeDiff') return;
    for (const repo of gitRepos) {
      const stashes = stashMap[repo.repoId] ?? [];
      const repoFilesMap = stashFilesMap[repo.repoId];
      for (const entry of stashes) {
        const stashIdentity = entry.oid ?? entry.ref;
        const fileState = repoFilesMap?.[stashIdentity];
        const reqKey = `${repo.repoId}:${stashIdentity}`;
        if (!fileState?.files && !fileState?.loading && !inFlightStashRequestsRef.current.has(reqKey)) {
          requestStashFiles(repo.repoId, entry.ref, entry.oid);
        }
      }
    }
  }, [activeTab, stashSpeedSearch.isOpen, store.panelMode, gitRepos, stashMap, stashFilesMap, requestStashFiles]);

  // ── Selection state for Select All / Invert button ───────────────────────
  const changesTotalFiles = repos.reduce((sum, r) => sum + r.stagedFiles.length + r.unstagedFiles.length, 0);
  const changesSelectedFilesCount = repos.reduce((sum, r) => sum + (store.fileSelections[r.repoId]?.size ?? 0), 0);
  const changesHasSelectable = changesTotalFiles > 0;
  const changesIsAllSelected = changesHasSelectable && changesSelectedFilesCount === changesTotalFiles;

  const currentTabHasSelectable = activeTab === 'changes'
    ? changesHasSelectable
    : (activeTab === 'push' || activeTab === 'sync')
      ? pushSelectionState.hasSelectable
      : false;

  const currentTabIsAllSelected = activeTab === 'changes'
    ? changesIsAllSelected
    : (activeTab === 'push' || activeTab === 'sync')
      ? pushSelectionState.isAllSelected
      : false;

  useEffect(() => {
    send({
      type: 'COMMIT_SELECTION_STATE_CHANGED',
      isAllSelected: currentTabIsAllSelected,
      hasSelectable: currentTabHasSelectable,
    });
  }, [currentTabIsAllSelected, currentTabHasSelectable, send]);

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) switchTab('changes');
  }, [activeTab, visibleTabs, switchTab]);

  // Keep unpushed-commit counts fresh for repos without upstream so the Sync tab badge
  // shows the correct number even before the tab is opened. Upstream repos are live via aheadBehind.ahead.
  // Full refresh on every status update is intentionally avoided to prevent visual noise.
  const noUpstreamKey = gitRepos.filter(r => !r.branch.upstream || r.branch.isGone).map(r => r.repoId).join('\0');
  useEffect(() => {
    if (!noUpstreamKey) return;
    noUpstreamKey.split('\0').forEach(id => requestUnpushedCommits(id, true));
  }, [noUpstreamKey, requestUnpushedCommits]);

  const gitRepoKey = gitRepos.map(repo => repo.repoId).join('\0');
  useEffect(() => {
    if (!gitRepoKey) return;
    const bootstrappedRepoIds = tabCountBootstrappedRepoIdsRef.current;
    for (const repoId of gitRepoKey.split('\0')) {
      if (bootstrappedRepoIds.has(repoId)) continue;
      bootstrappedRepoIds.add(repoId);
      requestStashCount(repoId);
      requestShelveList(repoId, true);
    }
    if (!tabCountWorktreeRequestedRef.current) {
      tabCountWorktreeRequestedRef.current = true;
      requestWorktreeList(true);
    }
    if (!tabCountSubtreeRequestedRef.current) {
      tabCountSubtreeRequestedRef.current = true;
      requestSubtreeList(false, false);
    }
    if (!tabCountSubmoduleRequestedRef.current) {
      tabCountSubmoduleRequestedRef.current = true;
      requestSubmoduleList(true);
    }
  }, [gitRepoKey, requestShelveList, requestStashCount, requestSubtreeList, requestWorktreeList, requestSubmoduleList]);

  // ── Context menu handlers ─────────────────────────────────────────────────

  const doStash = useCallback((repoId: string, message: string, paths?: string[]) => {
    send({ type: 'STASH_PUSH', requestId: generateId(), repoId, message, paths } satisfies CommitToHostMsg);
  }, [send]);

  const getRepoActionPaths = useCallback((repoId: string): string[] => {
    const freshState = useCommitStore.getState();
    const selectedPaths = freshState.getSelectedFilesForRepo(repoId);
    if (selectedPaths.length > 0) return selectedPaths;

    const repoStatus = freshState.status?.repos.find(repo => repo.repoId === repoId);
    return changedPaths(repoStatus ? [...repoStatus.stagedFiles, ...repoStatus.unstagedFiles] : undefined);
  }, []);

  const handleContextMenuSelect = useCallback((id: string) => {
    const file = ctxMenu?.file;
    if (!file) return;
    switch (id) {
      case 'stage':
        send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: file.repoId, paths: [file.path] });
        break;
      case 'unstage':
        send({ type: 'COMMIT_UNSTAGE_FILES', requestId: generateId(), repoId: file.repoId, paths: [file.path] });
        break;
      case 'resolve':
        send({ type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: file.repoId, filePath: file.path });
        break;
      case 'accept-yours':
        send({ type: 'COMMIT_ACCEPT_OURS', requestId: generateId(), repoId: file.repoId, filePath: file.path });
        break;
      case 'accept-theirs':
        send({ type: 'COMMIT_ACCEPT_THEIRS', requestId: generateId(), repoId: file.repoId, filePath: file.path });
        break;
      case 'rollback':
        send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: file.repoId, path: file.path });
        break;
      case 'shelve':
        confirmShelve(file.repoId, t('Changes'), [file.path]);
        break;
      case 'stash':
        doStash(file.repoId, t('WIP stash'), [file.path]);
        break;
      case 'diff':
        openDiff(file.repoId, file.path);
        break;
      case 'jump':
        send({ type: 'COMMIT_OPEN_FILE', repoId: file.repoId, filePath: file.path });
        break;
      case 'reveal-explorer':
        send({ type: 'COMMIT_REVEAL_IN_EXPLORER', repoId: file.repoId, filePath: file.path });
        break;
      case 'reveal-os':
        send({ type: 'COMMIT_REVEAL_IN_OS', repoId: file.repoId, filePath: file.path });
        break;
      case 'gitignore':
        send({ type: 'COMMIT_ADD_TO_GITIGNORE', repoId: file.repoId, entryPath: file.path });
        break;
      case 'svn-ignore':
        send({ type: 'COMMIT_ADD_TO_SVN_IGNORE', repoId: file.repoId, entryPath: file.path });
        break;
      case 'svn-manage-ignore':
        send({ type: 'COMMIT_MANAGE_SVN_IGNORE', repoId: file.repoId });
        break;
      case 'delete':
        send({ type: 'COMMIT_DELETE_FILE', requestId: generateId(), repoId: file.repoId, filePath: file.path });
        break;
      case 'submodule-update-parent':
        handleSubmoduleUpdate(file.repoId, file.path, false, false);
        break;
      case 'submodule-reveal-panel':
        setHighlightSubmodulePath(file.path);
        switchTab('submodule');
        break;
      case 'submodule-diff':
        openSubmoduleDiffSummary(file.repoId, file.path);
        break;
      case 'submodule-open-window': {
        const repoMeta = store.repoMetas.find(m => m.id === file.repoId);
        if (repoMeta) {
          const abs = `${repoMeta.rootPath}/${file.path}`.replace(/\\/g, '/');
          handleSubmoduleOpenInNewWindow(abs);
        }
        break;
      }
      case 'refresh':
        requestCommitStatus({ refreshSubtrees: activeTab === 'subtree' });
        break;
    }
  }, [activeTab, confirmShelve, ctxMenu, openDiff, doStash, requestCommitStatus, send, handleSubmoduleUpdate, switchTab, openSubmoduleDiffSummary, store.repoMetas, handleSubmoduleOpenInNewWindow]);

  const handleFolderContextMenuSelect = useCallback((id: string) => {
    const ctx = folderCtxMenu;
    if (!ctx) return;
    switch (id) {
      case 'stage':
        send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: ctx.repoId, paths: ctx.files.map(f => f.path) });
        break;
      case 'unstage':
        send({ type: 'COMMIT_UNSTAGE_FILES', requestId: generateId(), repoId: ctx.repoId, paths: ctx.files.map(f => f.path) });
        break;
      case 'rollback':
        send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: ctx.files.map(f => ({ repoId: f.repoId, path: f.path })) });
        break;
      case 'shelve':
        confirmShelve(ctx.repoId, t('Changes'), ctx.files.map(f => f.path));
        break;
      case 'stash':
        doStash(ctx.repoId, t('WIP stash'), ctx.files.map(f => f.path));
        break;
      case 'gitignore':
        send({ type: 'COMMIT_ADD_TO_GITIGNORE', repoId: ctx.repoId, entryPath: ctx.folderPath });
        break;
      case 'svn-ignore':
        send({ type: 'COMMIT_ADD_TO_SVN_IGNORE', repoId: ctx.repoId, entryPath: ctx.folderPath });
        break;
      case 'svn-manage-ignore':
        send({ type: 'COMMIT_MANAGE_SVN_IGNORE', repoId: ctx.repoId });
        break;
      case 'delete':
        send({ type: 'COMMIT_DELETE_FOLDER', requestId: generateId(), repoId: ctx.repoId, folderPath: ctx.folderPath });
        break;
      case 'refresh':
        requestCommitStatus({ refreshSubtrees: activeTab === 'subtree' });
        break;
    }
  }, [activeTab, confirmShelve, folderCtxMenu, doStash, requestCommitStatus, send]);

  const handleRepoContextMenuSelect = useCallback((id: string) => {
    const ctx = repoCtxMenu;
    if (!ctx) return;
    const repoStatus = repos.find(r => r.repoId === ctx.repoId);
    switch (id) {
      case 'stage-all':
        send({ type: 'COMMIT_STAGE_ALL', requestId: generateId(), repoId: ctx.repoId });
        break;
      case 'unstage-all':
        send({ type: 'COMMIT_UNSTAGE_ALL', requestId: generateId(), repoId: ctx.repoId });
        break;
      case 'rollback': {
        const fileMap = new Map<string, FileStatus>();
        for (const f of repoStatus?.unstagedFiles ?? []) fileMap.set(f.path, f);
        for (const f of repoStatus?.stagedFiles ?? []) fileMap.set(f.path, f);
        const allFiles = Array.from(fileMap.values());
        if (allFiles.length > 0) {
          send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: allFiles.map(f => ({ repoId: f.repoId, path: f.path })) });
        }
        break;
      }
      case 'shelve':
        confirmShelve(ctx.repoId, t('Changes'), getRepoActionPaths(ctx.repoId));
        break;
      case 'stash':
        doStash(ctx.repoId, t('WIP stash'), getRepoActionPaths(ctx.repoId));
        break;
      case 'manage-repo':
        send({ type: 'COMMIT_MANAGE_REPO', repoId: ctx.repoId });
        break;
      case 'view-git-log':
        send({ type: 'COMMIT_VIEW_GIT_LOG', repoId: ctx.repoId });
        break;
      case 'hide-repo':
        send({ type: 'COMMIT_HIDE_REPO', repoId: ctx.repoId });
        break;
      case 'refresh':
        requestCommitStatus({ refreshSubtrees: activeTab === 'subtree' });
        break;
    }
  }, [activeTab, repoCtxMenu, repos, doStash, confirmShelve, getRepoActionPaths, requestCommitStatus, send]);

  // ── Changelist actions ────────────────────────────────────────────────────

  const handleClHeaderContextMenuSelect = useCallback((id: string) => {
    const ctx = clHeaderCtxMenu;
    if (!ctx) return;
    switch (id) {
      case 'cl-rollback': {
        const cl = store.changelists.find(c => c.id === ctx.changelistId);
        if (!cl) break;
        const files = Object.entries(cl.fileAssignments).flatMap(([repoId, paths]) =>
          paths.map(path => ({ repoId, path }))
        );
        if (files.length > 0) send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files } satisfies CommitToHostMsg);
        break;
      }
      case 'cl-shelve':
        send({ type: 'CHANGELISTS_SHELVE', changelistId: ctx.changelistId, requestId: generateId() } satisfies CommitToHostMsg);
        break;
      case 'cl-stash':
        send({ type: 'CHANGELISTS_STASH', changelistId: ctx.changelistId, requestId: generateId() } satisfies CommitToHostMsg);
        break;
      case 'cl-add-to-git': {
        const untrackedByRepo = new Map<string, string[]>();
        for (const r of repos) {
          const paths = r.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path);
          if (paths.length > 0) untrackedByRepo.set(r.repoId, paths);
        }
        for (const [repoId, paths] of untrackedByRepo) {
          send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId, paths } satisfies CommitToHostMsg);
        }
        break;
      }
      case 'cl-new':
        send({ type: 'CHANGELISTS_CREATE_PROMPT' } satisfies CommitToHostMsg);
        break;
      case 'cl-rename': {
        const cl = store.changelists.find(c => c.id === ctx.changelistId);
        if (cl) send({ type: 'CHANGELISTS_RENAME_PROMPT', id: cl.id, currentName: cl.name } satisfies CommitToHostMsg);
        break;
      }
      case 'cl-delete':
        send({ type: 'CHANGELISTS_DELETE', id: ctx.changelistId } satisfies CommitToHostMsg);
        break;
      case 'refresh':
        requestCommitStatus({ refreshSubtrees: activeTab === 'subtree' });
        break;
    }
  }, [activeTab, clHeaderCtxMenu, repos, requestCommitStatus, send, store.changelists]);

  // ── Push actions ──────────────────────────────────────────────────────────

  const doPush = (repoId: string) => {
    const remote = useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName;
    send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId, remote });
  };

  const doPushMulti = (repoIds: string[]) => {
    const targets = repoIds
      .filter(id => !isSvnRepo(id))
      .map(repoId => ({
        repoId,
        remote: useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName,
      }));
    if (targets.length === 0) return;
    if (targets.length === 1) {
      send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId: targets[0].repoId, remote: targets[0].remote });
    } else {
      send({ type: 'COMMIT_PUSH_MULTI', requestId: generateId(), targets });
    }
  };

  const doForcePush = (repoId: string) => {
    const remote = useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName;
    send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId, remote, force: true });
  };

  const doForcePushMulti = (repoIds: string[]) => {
    const targets = repoIds
      .filter(id => !isSvnRepo(id))
      .map(repoId => ({
        repoId,
        remote: useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName,
      }));
    if (targets.length === 0) return;
    if (targets.length === 1) {
      send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId: targets[0].repoId, remote: targets[0].remote, force: true });
    } else {
      send({ type: 'COMMIT_PUSH_MULTI', requestId: generateId(), targets, force: true });
    }
  };

  const doPushTags = (repoId: string) => {
    const remote = useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName;
    send({ type: 'SYNC_PUSH_TAGS', requestId: generateId(), repoId, remote });
  };

  const doPushTagsMulti = (repoIds: string[]) => {
    send({ type: 'SYNC_PUSH_TAGS_MULTI', requestId: generateId(), repoIds });
  };

  const doSync = (repoId: string, strategy?: SyncPullStrategy) => {
    const remote = useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName;
    send({ type: 'SYNC_DO_SYNC', requestId: generateId(), repoId, strategy, remote });
  };

  const doSyncMulti = (repoIds: string[], strategy?: SyncPullStrategy) => {
    send({ type: 'SYNC_DO_SYNC_MULTI', requestId: generateId(), repoIds, strategy });
  };

  const doSquash = (repoId: string, hashes: string[], oldestHash: string, combinedMessage: string, commits: { hash: string; shortHash: string; message: string }[]) => {
    send({ type: 'PUSH_SQUASH_COMMITS', requestId: generateId(), repoId, hashes, oldestHash, message: combinedMessage, commits } satisfies CommitToHostMsg);
  };

  const doDropCommits = (repoId: string, hashes: string[], oldestHash: string) => {
    send({ type: 'PUSH_DROP_COMMITS', requestId: generateId(), repoId, hashes, oldestHash } satisfies CommitToHostMsg);
  };

  const doRevertCommits = (repoId: string, hashes: string[]) => {
    send({ type: 'PUSH_REVERT_COMMITS', requestId: generateId(), repoId, hashes } satisfies CommitToHostMsg);
  };

  const doEditCommitMsg = (repoId: string, hash: string, currentMessage: string) => {
    send({ type: 'PUSH_EDIT_COMMIT_MSG', requestId: generateId(), repoId, hash, currentMessage } satisfies CommitToHostMsg);
  };

  const doOpenInLog = (hash: string, repoId: string) => {
    send({ type: 'COMMIT_OPEN_LOG', hash, repoId });
  };

  const doUndoCommit = (repoId: string) => {
    send({ type: 'COMMIT_UNDO_COMMIT', requestId: generateId(), repoId });
  };

  const doPushAll = () => {
    const allRepos = useCommitStore.getState().status?.repos ?? [];
    const targets = allRepos
      .filter(r => !isSvnRepo(r.repoId) && (r.branch.aheadBehind?.ahead ?? 0) > 0)
      .map(r => ({
        repoId: r.repoId,
        remote: r.branch.remoteName,
      }));
    if (targets.length === 0) return;
    if (targets.length === 1) {
      send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId: targets[0].repoId, remote: targets[0].remote });
    } else {
      send({ type: 'COMMIT_PUSH_MULTI', requestId: generateId(), targets });
    }
  };

  // ── Autopilot ─────────────────────────────────────────────────────────────

  const buildGenerateMessageSelection = useCallback(() => {
    const freshState = useCommitStore.getState();
    const currentRepos = freshState.status?.repos ?? [];
    if (freshState.changesViewMode === 'vscode') {
      const metaById = new Map(freshState.repoMetas.map(meta => [meta.id, meta]));
      return {
        repoIds: currentRepos
          .filter(repo => {
            if (!vscodeSelectedRepos.has(repo.repoId)) return false;
            return metaById.get(repo.repoId)?.kind === 'svn'
              ? repo.stagedFiles.length + repo.unstagedFiles.length > 0
              : repo.stagedFiles.length > 0;
          })
          .map(repo => repo.repoId),
        targets: [],
      };
    }

    const selectedTargets = currentRepos
      .filter(repo => freshState.repoSelections[repo.repoId] !== false)
      .map(repo => ({
        repoId: repo.repoId,
        paths: freshState.getSelectedFilesForRepo(repo.repoId),
      }))
      .filter(target => target.paths.length > 0);

    return { repoIds: selectedTargets.map(target => target.repoId), targets: selectedTargets };
  }, [vscodeSelectedRepos]);

  const doAutopilot = useCallback(() => {
    if (generatingMessage) return;
    const selection = buildGenerateMessageSelection();
    if (selection.repoIds.length === 0 && selection.targets.length === 0) return;
    const requestId = generateId();
    activeGenerateRequestIdRef.current = requestId;
    store.setCommitMessage('');
    setGeneratingMessage(true);
    send({ type: 'COMMIT_GENERATE_MESSAGE', requestId, ...selection });
  }, [buildGenerateMessageSelection, generatingMessage, send, store]);

  const stopAutopilot = useCallback(() => {
    const requestId = activeGenerateRequestIdRef.current;
    if (!requestId) return;
    activeGenerateRequestIdRef.current = null;
    setGeneratingMessage(false);
    send({ type: 'COMMIT_CANCEL_GENERATE_MESSAGE', requestId });
  }, [send]);

  const openComposer = useCallback(() => {
    const freshState = useCommitStore.getState();
    const currentRepos = freshState.status?.repos ?? [];
    const metaById = new Map(freshState.repoMetas.map(meta => [meta.id, meta]));
    const candidates = currentRepos.flatMap(repo => {
      if (freshState.changesViewMode === 'vscode') {
        if (!vscodeSelectedRepos.has(repo.repoId)) return [];
        const isSvn = metaById.get(repo.repoId)?.kind === 'svn';
        const paths = isSvn
          ? Array.from(new Set([...repo.stagedFiles, ...repo.unstagedFiles].map(file => file.path)))
          : repo.stagedFiles.map(file => file.path);
        return paths.length ? [{ repoId: repo.repoId, paths, stagedOnly: !isSvn }] : [];
      }
      if (freshState.repoSelections[repo.repoId] === false) return [];
      const paths = freshState.getSelectedFilesForRepo(repo.repoId);
      return paths.length ? [{ repoId: repo.repoId, paths, stagedOnly: false }] : [];
    });
    send({ type: 'COMMIT_OPEN_AI_COMPOSER', candidates });
  }, [send, vscodeSelectedRepos]);

  const openCodeReview = useCallback(() => {
    const freshState = useCommitStore.getState();
    const currentRepos = freshState.status?.repos ?? [];
    const metaById = new Map(freshState.repoMetas.map(meta => [meta.id, meta]));
    const candidates = currentRepos.flatMap(repo => {
      if (freshState.changesViewMode === 'vscode') {
        if (!vscodeSelectedRepos.has(repo.repoId)) return [];
        const isSvn = metaById.get(repo.repoId)?.kind === 'svn';
        const paths = isSvn
          ? Array.from(new Set([...repo.stagedFiles, ...repo.unstagedFiles].map(file => file.path)))
          : repo.stagedFiles.map(file => file.path);
        return paths.length ? [{ repoId: repo.repoId, paths, stagedOnly: !isSvn }] : [];
      }
      if (freshState.repoSelections[repo.repoId] === false) return [];
      const paths = freshState.getSelectedFilesForRepo(repo.repoId);
      return paths.length ? [{ repoId: repo.repoId, paths, stagedOnly: false }] : [];
    });
    send({ type: 'COMMIT_OPEN_AI_REVIEW', candidates });
  }, [send, vscodeSelectedRepos]);

  // ── Loading / empty states ────────────────────────────────────────────────

  if (repos.length === 0 && !store.status) {
    return (
      <div style={css.fullCenter}>
          <span style={{ color: 'var(--vscode-descriptionForeground)', fontSize: '13px' }}>{t('Loading repositories…')}</span>
      </div>
    );
  }

  if (repos.length === 0 && store.status) {
    if (!store.hasWorkspaceFolder) {
      return (
        <div style={{ ...css.fullCenter, flexDirection: 'column', gap: '12px', padding: '24px' }}>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5' }}>
            {t('You have not yet opened a folder.')}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', width: '100%', maxWidth: '200px' }}>
            <button data-primary-action-btn="" style={css.initRepoBtn} onClick={() => send({ type: 'COMMIT_OPEN_FOLDER' } as CommitToHostMsg)}>{t('Open Folder')}</button>
            <button data-primary-action-btn="" style={css.initRepoBtn} onClick={() => send({ type: 'COMMIT_CLONE_REPO' } as CommitToHostMsg)}>{t('Clone Repository')}</button>
          </div>
        </div>
      );
    }
    if (store.repoMetas.length === 0) {
      return (
        <div style={{ ...css.fullCenter, flexDirection: 'column', gap: '12px', padding: '24px' }}>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5' }}>
            {t("The folder currently open doesn't have a Git repository. You can initialize a repository which will enable source control features powered by Git.")}
          </div>
          <button
            data-primary-action-btn=""
            style={css.initRepoBtn}
            onClick={() => send({ type: 'COMMIT_INIT_REPO' } as CommitToHostMsg)}
          >
            {t('Initialize Repository')}
          </button>
        </div>
      );
    }
    return (
      <div style={css.fullCenter}>
        <div style={{ textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>
          <div style={{ fontSize: '22px' }}>✓</div>
          <div style={{ fontSize: '13px', marginTop: '6px' }}>{t('No changes in workspace')}</div>
        </div>
      </div>
    );
  }

  // ── Commit action ─────────────────────────────────────────────────────────

  const doCommit = (andPush: boolean) => {
    // Read fresh state at commit time to avoid stale closure values
    const freshState = useCommitStore.getState();
    if (!freshState.commitMessage.trim()) return;
    const currentRepos = freshState.status?.repos ?? [];

    // In vscode mode, commit only what's already staged — no stage/unstage manipulation
    if (freshState.changesViewMode === 'vscode') {
      const selectedSet = vscodeSelectedRepos;
      const targets = currentRepos
        .filter(r => {
          const meta = metaMap.get(r.repoId);
          if (meta?.kind === 'svn') {
            return selectedSet.has(r.repoId) && [...r.stagedFiles, ...r.unstagedFiles].length > 0;
          }
          return r.stagedFiles.length > 0 && selectedSet.has(r.repoId);
        })
        .map(r => {
          const meta = metaMap.get(r.repoId);
          const allPaths = [...r.stagedFiles, ...r.unstagedFiles].map(file => file.path);
          return {
            repoId: r.repoId,
            message: freshState.commitMessage,
            amend: meta?.kind === 'svn' ? false : (freshState.amendFlags[r.repoId] ?? false),
            filesToStage: meta?.kind === 'svn' ? allPaths : [],
            filesToUnstage: [],
          };
        });
      if (targets.length === 0) return;
      store.setLoading(true);
      const requestId = generateId();
      pendingCommitMessagesRef.current.set(requestId, freshState.commitMessage.trim());
      getVsCodeApi().postMessage({ type: 'COMMIT_DO_COMMIT_MULTI', requestId, repos: targets, andPush, noVerify: freshState.noVerify } satisfies CommitToHostMsg);
      return;
    }

    const targets = currentRepos
      .filter(r => freshState.repoSelections[r.repoId] !== false)
      .map(r => {
        const repoId = r.repoId;
        const meta = metaMap.get(repoId);
        const selectedPaths = new Set(freshState.getSelectedFilesForRepo(repoId));
        if (meta?.kind === 'svn') {
          return { repoId, message: freshState.commitMessage, amend: false, filesToStage: Array.from(selectedPaths), filesToUnstage: [] };
        }
        const stagedPaths = new Set(r.stagedFiles.map(f => f.path));
        const unstagedPaths = new Set(r.unstagedFiles.map(f => f.path));
        // Include partially-staged files so their unstaged changes are also committed.
        const filesToStage = Array.from(selectedPaths).filter(p => !stagedPaths.has(p) || unstagedPaths.has(p));
        const filesToUnstage = r.stagedFiles.map(f => f.path).filter(p => !selectedPaths.has(p));
        return { repoId, message: freshState.commitMessage, amend: freshState.amendFlags[repoId] ?? false, filesToStage, filesToUnstage };
      })
      .filter(r => {
        const repoStatus = currentRepos.find(rs => rs.repoId === r.repoId)!;
        const stagedAfter = new Set(repoStatus.stagedFiles.map(f => f.path));
        for (const p of r.filesToUnstage) stagedAfter.delete(p);
        for (const p of r.filesToStage) stagedAfter.add(p);
        return stagedAfter.size > 0;
      });
    if (targets.length === 0) return;
    store.setLoading(true);
    store.setError(null);
    const requestId = generateId();
    pendingCommitMessagesRef.current.set(requestId, freshState.commitMessage.trim());
    getVsCodeApi().postMessage({ type: 'COMMIT_DO_COMMIT_MULTI', requestId, repos: targets, andPush, noVerify: freshState.noVerify } satisfies CommitToHostMsg);
  };
  commitActionRef.current = doCommit;

  // ── Render ────────────────────────────────────────────────────────────────

  if (store.panelMode === 'worktreeDiff' && store.worktreeDiffState) {
    return (
      <WorktreeDiffPanel
        state={store.worktreeDiffState}
        iconTheme={store.iconTheme}
        onClose={() => store.closeWorktreeDiff()}
        onSelectFile={selectWorktreeDiffFile}
        onOpenFile={(file) => send({ type: 'COMMIT_OPEN_FILE', repoId: file.repoId, filePath: file.path })}
      />
    );
  }

  return (
    <div style={css.app} onContextMenu={e => e.preventDefault()}>

      {/* ── Tab bar ── */}
      {(() => {
        const totalChanges = repos.reduce((sum, repo) => {
          const paths = new Set<string>();
          for (const file of repo.stagedFiles) paths.add(file.path);
          for (const file of repo.unstagedFiles) paths.add(file.path);
          return sum + paths.size;
        }, 0);
        const totalShelves = Object.entries(shelveMap).reduce((sum, [repoId, shelves]) => (
          visibleRepoIds.has(repoId) ? sum + shelves.length : sum
        ), 0);
        const totalStashes = gitRepos.reduce((sum, repo) => (
          sum + (stashCountMap[repo.repoId] ?? stashMap[repo.repoId]?.length ?? 0)
        ), 0);
        const totalSubmodules = submoduleRepos.reduce((sum, repo) => (
          visibleRepoIds.has(repo.repoId) ? sum + repo.submodules.length : sum
        ), 0);
        const totalSubmoduleIssues = submoduleRepos.reduce((sum, repo) => (
          visibleRepoIds.has(repo.repoId)
            ? sum + repo.submodules.filter((s: SubmoduleItem) => !s.initialized || s.syncStatus === 'out-of-sync').length
            : sum
        ), 0);
        const totalWorktrees = worktreeRepos.reduce((sum, repo) => (
          visibleRepoIds.has(repo.repoId) ? sum + repo.worktrees.length : sum
        ), 0);
        const totalSubtrees = subtreeEntries.reduce((sum, entry) => (
          visibleRepoIds.has(entry.repoId) ? sum + 1 : sum
        ), 0);
        const tabCounts: Record<TabId, number> = {
          changes: totalChanges,
          shelf: totalShelves,
          stash: totalStashes,
          submodule: totalSubmodules,
          worktree: totalWorktrees,
          subtree: totalSubtrees,
          push: totalToPush + totalToPull,
          sync: totalToPush + totalToPull,
        };
        return (
          <div style={css.tabBar}>
            {visibleTabs.map(tab => {
              const changesLabel = (store.changesViewMode === 'changelists' || store.changesViewMode === 'vscode') ? t('Commit') : t('Changes');
              const label = tab === 'changes' ? changesLabel : tab === 'shelf' ? t('Shelf') : tab === 'stash' ? t('Stash') : tab === 'submodule' ? t('Submodules') : tab === 'worktree' ? t('Worktrees') : tab === 'subtree' ? t('Subtrees') : t('Sync');
              const iconName = tab === 'changes' ? 'source-control' : tab === 'shelf' ? 'archive' : tab === 'stash' ? 'save' : tab === 'submodule' ? 'repo-clone' : tab === 'worktree' ? 'worktree' : tab === 'subtree' ? 'repo' : 'sync';
              const count = tabCounts[tab];
              const isActive = activeTab === tab;
              return (
                <button
                  data-action-btn=""
                  key={tab}
                  style={css.tab(isActive)}
                  title={tab === 'push'
                    ? `${label} (${t('{0} incoming, {1} outgoing', totalToPull, totalToPush)})`
                    : tab === 'submodule' && totalSubmoduleIssues > 0
                      ? `${label} (${count}, ${t('{0} issues', totalSubmoduleIssues)})`
                      : `${label} (${count})`}
                  onClick={() => switchTab(tab)}
                >
                  <Codicon
                    name={iconName}
                    style={{ marginRight: isActive ? '5px' : '0', fontSize: '13px', transition: 'margin 0.15s' }}
                  />
                  {isActive && (
                    <span style={{ animation: 'gs-tab-label-in 0.18s ease-out both', overflow: 'hidden', display: 'inline-block' }}>
                      {label}
                    </span>
                  )}
                  {count > 0 && (
                    <span style={css.tabBadge(isActive)}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        );
      })()}

      {/* ── Error / info notification bar ── */}
      {store.error && (
        <div style={css.notificationBar}>
          <Codicon name="warning" style={{ flexShrink: 0, fontSize: '13px' }} />
          <span style={css.notificationText}>{store.error}</span>
          <button data-action-btn="" style={css.notificationClose} onClick={() => store.setError(null)} title={t('Dismiss')}>
            <Codicon name="close" />
          </button>
        </div>
      )}

      {/* ── Tab content ── */}
      <div style={css.main}>

        {visitedTabs.has('changes') && (
          <div style={{ display: activeTab === 'changes' ? 'flex' : 'none', flexDirection: 'column', flex: 1, minHeight: 0, position: 'relative' }}>
            {activeTab === 'changes' && changesSpeedSearch.isOpen && (
              <SpeedSearchWidget speedSearch={changesSpeedSearch} />
            )}

          {/* File list */}
          <div ref={changesScrollContainerRef} className="versiondock-commit-scroll-container" style={css.repoList}>
            {store.changesViewMode === 'vscode' ? (
              <VscodeView
                repos={repos}
                repoMetas={store.repoMetas}
                selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                ctxFile={ctxFile}
                viewMode={store.viewMode}
                isCollapsed={store.isCollapsed}
                toggleCollapsed={store.toggleCollapsed}
                onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                onContextMenu={(e, file, staged) => {
                  setCtxFile({ repoId: file.repoId, path: file.path });
                  setCtxMenuStaged(staged);
                  setCtxMenu({ x: e.clientX, y: e.clientY, file });
                }}
                onFolderContextMenu={(e, rid, folderPath, files, staged) => {
                  setActiveFolderPath(folderPath);
                  setFolderCtxMenuStaged(staged);
                  setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files });
                }}
                onOpenFile={f => send({ type: 'COMMIT_OPEN_FILE', repoId: f.repoId, filePath: f.path })}
                onRollback={files => {
                  if (files.length === 1) {
                    send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: files[0].repoId, path: files[0].path });
                  } else {
                    send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                  }
                }}
                onResolveMerge={f => send({ type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                onStageFiles={(rid, paths) => { store.isCollapsed('vscode-section:staged') && store.toggleCollapsed('vscode-section:staged'); send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: rid, paths }); }}
                onUnstageFiles={(rid, paths) => { store.isCollapsed('vscode-section:unstaged') && store.toggleCollapsed('vscode-section:unstaged'); send({ type: 'COMMIT_UNSTAGE_FILES', requestId: generateId(), repoId: rid, paths }); }}
                onStageAll={rid => { store.isCollapsed('vscode-section:staged') && store.toggleCollapsed('vscode-section:staged'); send({ type: 'COMMIT_STAGE_ALL', requestId: generateId(), repoId: rid }); }}
                onUnstageAll={rid => { store.isCollapsed('vscode-section:unstaged') && store.toggleCollapsed('vscode-section:unstaged'); send({ type: 'COMMIT_UNSTAGE_ALL', requestId: generateId(), repoId: rid }); }}
                onStageAllMulti={rids => { store.isCollapsed('vscode-section:staged') && store.toggleCollapsed('vscode-section:staged'); send({ type: 'COMMIT_STAGE_ALL_MULTI', requestId: generateId(), repoIds: rids }); }}
                onUnstageAllMulti={rids => { store.isCollapsed('vscode-section:unstaged') && store.toggleCollapsed('vscode-section:unstaged'); send({ type: 'COMMIT_UNSTAGE_ALL_MULTI', requestId: generateId(), repoIds: rids }); }}
                onRepoContextMenu={(e, rid, staged) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, stagedSection: staged })}
                onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                onOpenStagedChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid, section: 'staged' })}
                onOpenUnstagedChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid, section: 'unstaged' })}
                iconTheme={store.iconTheme}
                activeFolderPath={activeFolderPath}
                selectedRepos={vscodeSelectedRepos}
                onToggleRepoSelection={toggleVscodeRepoSelection}
                onOpenAllChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
                speedSearchQuery={changesSpeedSearch.query}
                activeSpeedSearchKey={changesSpeedSearch.activeKey}
              />
            ) : store.changesViewMode === 'changelists' ? (
              <ChangelistView
                changelists={store.changelists}
                repos={repos}
                repoMetas={store.repoMetas}
                selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                viewMode={store.viewMode}
                isFileSelected={store.isFileSelected}
                isCollapsed={store.isCollapsed}
                toggleCollapsed={store.toggleCollapsed}
                onToggleFile={store.toggleFileSelection}
                onSetFiles={store.setFileSelections}
                onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                onContextMenu={(e, file) => { setCtxFile({ repoId: file.repoId, path: file.path }); setCtxMenu({ x: e.clientX, y: e.clientY, file }); }}
                onFolderContextMenu={(e, rid, folderPath, files) => { setActiveFolderPath(folderPath); setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files }); }}
                onOpenFile={f => send({ type: 'COMMIT_OPEN_FILE', repoId: f.repoId, filePath: f.path })}
                onRollback={files => {
                  if (files.length === 1) {
                    send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: files[0].repoId, path: files[0].path });
                  } else {
                    send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                  }
                }}
                onResolveMerge={f => send({ type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                onHeaderContextMenu={(e, clId) => setClHeaderCtxMenu({ x: e.clientX, y: e.clientY, changelistId: clId })}
                onRepoContextMenu={(e, rid, clId) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, changelistId: clId })}
                onOpenChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
                onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                iconTheme={store.iconTheme}
                activeFolderPath={activeFolderPath}
                ctxFile={ctxFile}
                speedSearchQuery={changesSpeedSearch.query}
                activeSpeedSearchKey={changesSpeedSearch.activeKey}
              />
            ) : (
              repos.map((repoStatus, idx) => {
                const repoId = repoStatus.repoId;
                const meta = metaMap.get(repoId);
                const repoName = meta?.name ?? baseNameFromPath(repoId) ?? repoId;
                const repoColor = meta?.color ?? '#4ec9b0';
                return (
                  <ProjectGroup
                    key={repoId}
                    isFirst={idx === 0}
                    repoStatus={repoStatus}
                    repoName={repoName}
                    repoRootPath={meta?.rootPath}
                    repoColor={repoColor}
                    showVcsBadge={showVcsBadges}
                      isSubmodule={meta?.isSubmodule}
                      submodulePath={meta?.submodulePath}
                      isWorktree={meta?.isWorktree}
                      mainWorktreePath={meta?.mainWorktreePath}
                      kind={meta?.kind}
                      selectedFile={selectedFile ? { repoId: selectedFile.repoId, path: selectedFile.path } : null}
                      viewMode={store.viewMode}
                      isFileSelected={store.isFileSelected}
                      isCollapsed={store.isCollapsed}
                      toggleCollapsed={store.toggleCollapsed}
                      onToggleFile={store.toggleFileSelection}
                      onSetFiles={store.setFileSelections}
                      onSelectFile={f => { setSelectedFile(f); openDiff(f.repoId, f.path); }}
                      onContextMenu={(e, file) => { setCtxFile({ repoId: file.repoId, path: file.path }); setCtxMenu({ x: e.clientX, y: e.clientY, file }); }}
                      onFolderContextMenu={(e, rid, folderPath, files) => { setActiveFolderPath(folderPath); setFolderCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, folderPath, files }); }}
                      onOpenFile={f => send({ type: 'COMMIT_OPEN_FILE', repoId: f.repoId, filePath: f.path })}
                      onRollback={files => {
                        if (files.length === 1) {
                          send({ type: 'COMMIT_DISCARD_FILE', requestId: generateId(), repoId: files[0].repoId, path: files[0].path });
                        } else {
                          send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: files.map(f => ({ repoId: f.repoId, path: f.path })) });
                        }
                      }}
                      onResolveMerge={f => send({ type: 'COMMIT_OPEN_MERGE_EDITOR', repoId: f.repoId, filePath: f.path })}
                      onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                      onRepoContextMenu={(e, rid) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid })}
                      onOpenAllChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
                      iconTheme={store.iconTheme}
                      activeFolderPath={activeFolderPath}
                      ctxFile={ctxFile}
                      speedSearchQuery={changesSpeedSearch.query}
                      activeSpeedSearchKey={changesSpeedSearch.activeKey}
                    />
                );
              })
            )}
          </div>

          {/* Shelve name prompt — appears above commit form */}
          {shelvePrompt && (
            <div style={css.shelvePromptBar}>
              <Codicon name="archive" style={{ flexShrink: 0, fontSize: '14px' }} />
              <input
                ref={shelvePromptRef}
                style={css.shelvePromptInput}
                value={shelvePromptName}
                onChange={e => setShelvePromptName(e.target.value)}
                placeholder={t('Shelve name…')}
                onKeyDown={e => {
                  if (e.key === 'Enter') confirmShelve(shelvePrompt.repoId, shelvePromptName, shelvePrompt.paths);
                  if (e.key === 'Escape') setShelvePrompt(null);
                }}
              />
              <button
                data-primary-action-btn=""
                style={css.shelvePromptOk}
                onClick={() => confirmShelve(shelvePrompt.repoId, shelvePromptName, shelvePrompt.paths)}
                disabled={!shelvePromptName.trim()}
                title={t('Confirm shelve')}
              >
                <Codicon name="check" />
              </button>
              <button data-action-btn="" style={css.shelvePromptCancel} onClick={() => setShelvePrompt(null)} title={t('Cancel')}>
                <Codicon name="close" />
              </button>
            </div>
          )}

          {/* Commit form */}
          <UnifiedCommitForm
            message={store.commitMessage}
            messageHistory={commitMessageHistory}
            messageHistoryLoading={commitMessageHistoryLoading}
            repoStatuses={repos}
            repoMetas={store.repoMetas}
            amendFlags={store.amendFlags}
            unpushedMap={unpushedMap}
            loading={store.loading}
            changesViewMode={store.changesViewMode}
            defaultCommitAction={store.defaultCommitAction}
            defaultSaveAction={store.defaultSaveAction}
            vscodeSelectedRepos={store.changesViewMode === 'vscode' ? vscodeSelectedRepos : undefined}
            getSelectedFilesForRepo={store.getSelectedFilesForRepo}
            onDeselectRepo={repoId => {
              if (store.changesViewMode === 'vscode') {
                toggleVscodeRepoSelection(repoId);
              } else {
                const r = repos.find(r => r.repoId === repoId);
                if (!r) return;
                const allPaths = [...r.stagedFiles, ...r.unstagedFiles].map(f => f.path);
                store.setFileSelections(repoId, allPaths, false);
              }
            }}
            onMessageChange={msg => store.setCommitMessage(msg)}
            onAmendToggle={repoId => {
              const newValue = !(store.amendFlags[repoId] ?? false);
              store.setAmend(repoId, newValue);
              if (newValue) {
                send({ type: 'COMMIT_GET_LAST_COMMIT_MESSAGE', requestId: generateId(), repoId });
              }
            }}
            onCommit={() => doCommit(false)}
            onCommitAndPush={() => doCommit(true)}
            onPush={doPush}
            onPushAll={doPushAll}
            onAutopilot={doAutopilot}
            onStopAutopilot={stopAutopilot}
            onOpenComposer={openComposer}
            onOpenCodeReview={openCodeReview}
            generatingMessage={generatingMessage}
            onShelve={() => {
              const name = store.commitMessage.trim();
              if (!name) return;
              const targets: Array<{ repoId: string; paths: string[] }> = [];
              for (const repoStatus of repos) {
                if (isSvnRepo(repoStatus.repoId)) continue;
                const selectedPaths = store.getSelectedFilesForRepo(repoStatus.repoId);
                if (selectedPaths.length === 0) continue;
                targets.push({ repoId: repoStatus.repoId, paths: selectedPaths });
              }
              if (targets.length === 0) return;
              store.setLoading(true);
              getVsCodeApi().postMessage({
                type: 'COMMIT_DO_SHELVE_MULTI',
                requestId: generateId(),
                name,
                repos: targets,
              } satisfies CommitToHostMsg);
              store.setCommitMessage('');
            }}
            onStash={() => {
              const message = store.commitMessage.trim() || t('WIP stash');
              const targets: Array<{ repoId: string; paths: string[] }> = [];
              for (const repoStatus of repos) {
                if (isSvnRepo(repoStatus.repoId)) continue;
                const selectedPaths = store.getSelectedFilesForRepo(repoStatus.repoId);
                if (selectedPaths.length === 0) continue;
                targets.push({ repoId: repoStatus.repoId, paths: selectedPaths });
              }
              if (targets.length === 0) return;
              store.setLoading(true);
              getVsCodeApi().postMessage({
                type: 'COMMIT_DO_STASH_MULTI',
                requestId: generateId(),
                message,
                repos: targets,
              } satisfies CommitToHostMsg);
            }}
            noVerify={store.noVerify}
            onNoVerifyChange={v => store.setNoVerify(v)}
            onRequestMessageHistory={requestCommitMessageHistory}
          />

        </div>)}

        {visitedTabs.has('shelf') && (
          /* Shelf tab */
          <div ref={shelveScrollContainerRef} style={{ display: activeTab === 'shelf' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, position: 'relative' }}>
            {activeTab === 'shelf' && shelveSpeedSearch.isOpen && (
              <SpeedSearchWidget speedSearch={shelveSpeedSearch} />
            )}
            <div style={css.repoList}>
              {gitRepos.map(repoStatus => {
                const repoId = repoStatus.repoId;
                const meta = metaMap.get(repoId);
                const repoName = meta?.name ?? baseNameFromPath(repoId) ?? repoId;
                const repoColor = meta?.color ?? '#4ec9b0';
                const worktreeBranch = meta?.isWorktree
                  ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
                  : undefined;
                const mainRepoName = baseNameFromPath(meta?.mainWorktreePath);
                return (
                  <ShelvePanel
                    key={repoId}
                    repoId={repoId}
                    repoName={repoName}
                    repoColor={repoColor}
                    worktreeBranch={worktreeBranch}
                    worktreeBranchColor={meta?.isWorktree ? branchInfoColor(repoStatus.branch) : undefined}
                    mainRepoName={mainRepoName}
                    multiRepo={multiRepo}
                    shelves={shelveMap[repoId] ?? []}
                    loading={shelveLoading[repoId] ?? false}
                    error={shelveError[repoId] ?? null}
                    viewMode={store.shelveViewMode}
                    onUnshelve={handleUnshelve}
                    onUnshelveAndDrop={handleUnshelveAndDrop}
                    onUnshelveFile={handleUnshelveFile}
                    onDrop={handleDropShelve}
                    onOpenFileDiff={handleOpenFileDiff}
                    speedSearchQuery={shelveSpeedSearch.query}
                    activeSpeedSearchKey={shelveSpeedSearch.activeKey}
                  />
                );
              })}
            </div>
          </div>
        )}

        {visitedTabs.has('stash') && (
          /* Stash tab */
          <div ref={stashScrollContainerRef} style={{ display: activeTab === 'stash' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, position: 'relative' }}>
            {activeTab === 'stash' && stashSpeedSearch.isOpen && (
              <SpeedSearchWidget speedSearch={stashSpeedSearch} />
            )}
            <div style={css.repoList}>
              {gitRepos.map(repoStatus => {
                const repoId = repoStatus.repoId;
                const meta = metaMap.get(repoId);
                const repoName = meta?.name ?? baseNameFromPath(repoId) ?? repoId;
                const repoColor = meta?.color ?? '#4ec9b0';
                const worktreeBranch = meta?.isWorktree
                  ? (repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name)
                  : undefined;
                const mainRepoName = baseNameFromPath(meta?.mainWorktreePath);
                return (
                  <StashTab
                    key={repoId}
                    repoId={repoId}
                    repoName={repoName}
                    repoColor={repoColor}
                    worktreeBranch={worktreeBranch}
                    worktreeBranchColor={meta?.isWorktree ? branchInfoColor(repoStatus.branch) : undefined}
                    mainRepoName={mainRepoName}
                    multiRepo={multiRepo}
                    stashes={stashMap[repoId] ?? []}
                    loading={stashLoading[repoId] ?? false}
                    error={stashError[repoId] ?? null}
                    viewMode={store.stashViewMode}
                    onApply={handleStashApply}
                    onPop={handleStashPop}
                    onDrop={handleStashDrop}
                    onOpenFileDiff={handleStashShowFileDiff}
                    expansionCommand={stashExpansionCommand}
                    stashFilesMap={stashFilesMap[repoId]}
                    onRequestStashFiles={requestStashFiles}
                    speedSearchQuery={stashSpeedSearch.query}
                    activeSpeedSearchKey={stashSpeedSearch.activeKey}
                  />
                );
              })}
            </div>
          </div>
        )}

        {visitedTabs.has('push') && (
          /* Sync tab — manages its own scroll, footer anchored at bottom */
          <div style={{ display: activeTab === 'push' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0, position: 'relative' }}>
            <PushTab
              isActive={activeTab === 'push'}
              repos={gitRepos}
              repoMetas={gitRepoMetas}
              iconTheme={store.iconTheme}
              unpushedMap={unpushedMap}
              incomingMap={incomingMap}
              onPush={doPush}
              onPushMulti={doPushMulti}
              onPushAll={doPushAll}
              onForcePush={doForcePush}
              onForcePushMulti={doForcePushMulti}
              onPushTags={doPushTags}
              onPushTagsMulti={doPushTagsMulti}
              onSync={doSync}
              onSyncMulti={doSyncMulti}
              onPull={(repoId, strategy) => send({ type: 'SYNC_DO_PULL', requestId: generateId(), repoId, strategy })}
              onPullMulti={(repoIds, strategy) => send({ type: 'SYNC_DO_PULL_MULTI', requestId: generateId(), repoIds, strategy })}
              onFetch={repoId => send({ type: 'SYNC_FETCH_REPO', requestId: generateId(), repoId })}
              onFetchAll={() => send({ type: 'SYNC_FETCH_ALL', requestId: generateId() })}
              onOpenInLog={doOpenInLog}
              onUndoCommit={doUndoCommit}
              onRequestCommitFiles={requestPushCommitFiles}
              onRequestAggregatedDiff={requestAggregatedPushDiff}
              onOpenAggregatedFile={openAggregatedPushFileDiff}
              onOpenCommitFile={openPushCommitFileDiff}
              onRequestIncomingCommitFiles={requestPushCommitFiles}
              onRequestIncomingAggregatedDiff={requestAggregatedIncomingDiff}
              onOpenIncomingAggregatedFile={openAggregatedIncomingFileDiff}
              onOpenIncomingCommitFile={openIncomingCommitFileDiff}
              onSquash={doSquash}
              onDropCommits={doDropCommits}
              onRevertCommits={doRevertCommits}
              onEditCommitMsg={doEditCommitMsg}
              onCherryPick={(repoId, hashes) => send({ type: 'SYNC_CHERRY_PICK', requestId: generateId(), repoId, hashes })}
              onCreateBranchFromCommit={(repoId, hash) => send({ type: 'SYNC_CREATE_BRANCH_FROM_COMMIT', requestId: generateId(), repoId, hash })}
              onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
              expansionCommand={pushExpansionCommand}
              viewMode={store.viewMode}
              onExpansionChange={expanded => setPushExpansionCommand(prev => ({ ...prev, expanded }))}
              selectionCommand={pushSelectionCommand}
              onSelectionChange={(isAllSelected, hasSelectable) => setPushSelectionState({ isAllSelected, hasSelectable })}
            />
          </div>
        )}

        {visitedTabs.has('submodule') && (
          /* Submodule tab */
          <div style={{ display: activeTab === 'submodule' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <div style={css.repoList}>
              <SubmodulePanel
                repos={submoduleRepos}
                loading={submoduleLoading}
                initialLoaded={submoduleInitialLoaded}
                error={submoduleError}
                multiRepo={multiRepo}
                activeOps={submoduleOps}
                highlightSubmodulePath={highlightSubmodulePath}
                onInit={handleSubmoduleInit}
                onUpdate={handleSubmoduleUpdate}
                onUpdateAll={handleSubmoduleUpdateAll}
                onSync={handleSubmoduleSync}
                onDeinit={handleSubmoduleDeinit}
                onRemove={handleSubmoduleRemove}
                onAdd={handleSubmoduleAdd}
                onRefresh={handleSubmoduleRefresh}
                onResolveConflict={handleSubmoduleResolveConflict}
                onOpenConflict={handleSubmoduleOpenConflict}
                onOpenInNewWindow={handleSubmoduleOpenInNewWindow}
                onOpenInOS={handleSubmoduleOpenInOS}
                onRevealInExplorer={handleSubmoduleRevealInExplorer}
              />
            </div>
          </div>
        )}

        {visitedTabs.has('worktree') && (
          /* Worktree tab */
          <div style={{ display: activeTab === 'worktree' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <div style={css.repoList}>
              <WorktreePanel
                repos={worktreeRepos}
                loading={worktreeLoading}
                error={worktreeError}
                multiRepo={multiRepo}
                onDelete={handleWorktreeDelete}
                onLock={handleWorktreeLock}
                onUnlock={handleWorktreeUnlock}
                onPrune={handleWorktreePrune}
                onOpenInExplorer={handleWorktreeOpenInExplorer}
                onOpenInNewWindow={handleWorktreeOpenInNewWindow}
                onOpenInOS={handleWorktreeOpenInOS}
                onAddToWorkspace={handleWorktreeAddToWorkspace}
                onRequestCreate={handleWorktreeRequestCreate}
              />
            </div>
          </div>
        )}

        {visitedTabs.has('subtree') && (
          /* Subtree tab */
          <div style={{ display: activeTab === 'subtree' ? 'flex' : 'none', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <div style={css.repoList}>
              <SubtreePanel
                entries={subtreeEntries}
                repoMetas={gitRepoMetas}
                loading={subtreeLoading}
                activeOps={subtreeOps}
                statuses={subtreeStatuses}
                error={subtreeError}
                multiRepo={multiRepo}
                onAdd={handleSubtreeAdd}
                onRegister={handleSubtreeRegister}
                onPull={handleSubtreePull}
                onPush={handleSubtreePush}
                onSplit={handleSubtreeSplit}
                onMerge={handleSubtreeMerge}
                onRemove={handleSubtreeRemove}
                onEdit={handleSubtreeEdit}
                onDeleteRegistry={handleSubtreeDeleteRegistry}
                onReveal={handleSubtreeReveal}
              />
            </div>
          </div>
        )}

      </div>

      {/* File context menu */}
      {ctxMenu && (() => {
        const file = ctxMenu.file;
        const isUntracked = file.status === 'untracked';
        const isSubmodule = file.status === 'submodule';
        const isSvn = isSvnRepo(file.repoId);
        const hasCustomCls = store.changelists.some(cl => cl.id !== CHANGELIST_DEFAULT_ID && cl.id !== CHANGELIST_UNVERSIONED_ID);
        const baseItems = file.status === 'conflicted' ? FILE_CONTEXT_ITEMS_CONFLICT : FILE_CONTEXT_ITEMS;
        let items: ContextMenuEntry[] = baseItems;
        if (isSubmodule) {
          items = ctxMenuStaged ? SUBMODULE_FILE_STAGED_ITEMS : SUBMODULE_FILE_UNSTAGED_ITEMS;
        } else if (store.changesViewMode === 'vscode') {
          items = ctxMenuStaged ? VSCODE_FILE_STAGED_ITEMS : VSCODE_FILE_UNSTAGED_ITEMS;
        } else if (store.changesViewMode === 'changelists') {
          if (isUntracked) {
            items = [
              { id: 'add-to-git', label: t('Add to Git'),        icon: 'add' },
              { id: 'rollback',   label: t('Rollback'),           icon: 'discard' },
              { id: 'shelve',     label: t('Shelve'),             icon: 'archive' },
              { id: 'stash',      label: t('Stash'),              icon: 'save' },
              { id: 'diff',       label: t('Show Diff'),          icon: 'diff' },
              { id: 'jump',       label: t('Jump to Source'),     icon: 'go-to-file' },
              { separator: true },
              { id: 'gitignore',  label: t('Add to .gitignore'), icon: 'exclude' },
              { separator: true },
              { id: 'delete',     label: t('Delete'),             icon: 'trash', danger: true },
              { separator: true },
              { id: 'refresh',    label: t('Refresh'),            icon: 'refresh' },
            ];
          } else {
            items = hasCustomCls
              ? [...baseItems, { separator: true }, { id: 'move-to-cl', label: t('Move to Changelist…'), icon: 'list-unordered' }]
              : baseItems;
          }
        }
        if (isSvn) {
          items = svnContextMenuItems(items, isUntracked);
        }
        return (
          <ContextMenu
            x={ctxMenu.x} y={ctxMenu.y}
            items={items}
            onSelect={id => {
              if (id === 'add-to-git') {
                send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: file.repoId, paths: [file.path] } satisfies CommitToHostMsg);
                setCtxMenu(null); setCtxFile(null);
              } else if (id === 'move-to-cl') {
                send({ type: 'CHANGELISTS_MOVE_FILES_PROMPT', files: [{ repoId: file.repoId, path: file.path }] } satisfies CommitToHostMsg);
                setCtxMenu(null); setCtxFile(null);
              } else {
                handleContextMenuSelect(id);
              }
            }}
            onClose={() => { setCtxMenu(null); setCtxFile(null); }}
          />
        );
      })()}

      {/* Folder context menu */}
      {folderCtxMenu && (() => {
        const files = folderCtxMenu.files;
        const allUntracked = files.length > 0 && files.every(f => f.status === 'untracked');
        const isSvn = isSvnRepo(folderCtxMenu.repoId);
        const hasCustomCls = store.changelists.some(cl => cl.id !== CHANGELIST_DEFAULT_ID && cl.id !== CHANGELIST_UNVERSIONED_ID);
        let items: ContextMenuEntry[] = FOLDER_CONTEXT_ITEMS;
        if (store.changesViewMode === 'vscode') {
          items = folderCtxMenuStaged ? VSCODE_FOLDER_STAGED_ITEMS : VSCODE_FOLDER_UNSTAGED_ITEMS;
        } else if (store.changesViewMode === 'changelists') {
          if (allUntracked) {
            items = [
              { id: 'add-to-git', label: t('Add to Git'),        icon: 'add' },
              { id: 'rollback',   label: t('Rollback'),           icon: 'discard' },
              { id: 'shelve',     label: t('Shelve Changes'),     icon: 'archive' },
              { id: 'stash',      label: t('Stash Changes'),      icon: 'save' },
              { separator: true },
              { id: 'gitignore',  label: t('Add to .gitignore'), icon: 'exclude' },
              { separator: true },
              { id: 'delete',     label: t('Delete'),             icon: 'trash', danger: true },
              { separator: true },
              { id: 'refresh',    label: t('Refresh'),            icon: 'refresh' },
            ];
          } else {
            items = hasCustomCls
              ? [...FOLDER_CONTEXT_ITEMS, { separator: true }, { id: 'move-to-cl', label: t('Move to Changelist…'), icon: 'list-unordered' }]
              : FOLDER_CONTEXT_ITEMS;
          }
        }
        if (isSvn) {
          items = svnContextMenuItems(items, allUntracked);
        }
        return (
          <ContextMenu
            x={folderCtxMenu.x} y={folderCtxMenu.y}
            items={items}
            onSelect={id => {
              if (id === 'add-to-git') {
                send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: folderCtxMenu.repoId, paths: files.map(f => f.path) } satisfies CommitToHostMsg);
                setFolderCtxMenu(null); setActiveFolderPath(null);
              } else if (id === 'move-to-cl') {
                send({ type: 'CHANGELISTS_MOVE_FILES_PROMPT', files: files.map(f => ({ repoId: f.repoId, path: f.path })) } satisfies CommitToHostMsg);
                setFolderCtxMenu(null); setActiveFolderPath(null);
              } else {
                handleFolderContextMenuSelect(id);
              }
            }}
            onClose={() => { setFolderCtxMenu(null); setActiveFolderPath(null); }}
          />
        );
      })()}

      {repoCtxMenu && (() => {
        const hasCustomCls = store.changelists.some(cl => cl.id !== CHANGELIST_DEFAULT_ID && cl.id !== CHANGELIST_UNVERSIONED_ID);
        const isInDefaultCl = !repoCtxMenu.changelistId || repoCtxMenu.changelistId === CHANGELIST_DEFAULT_ID;
        const isSvn = isSvnRepo(repoCtxMenu.repoId);
        const repoStatus = repos.find(r => r.repoId === repoCtxMenu.repoId);
        const hasUntracked = (repoStatus?.unstagedFiles ?? []).some(file => file.status === 'untracked');
        let repoItems = REPO_CONTEXT_ITEMS;
        if (store.changesViewMode === 'vscode') {
          repoItems = repoCtxMenu.stagedSection ? VSCODE_REPO_STAGED_ITEMS : VSCODE_REPO_UNSTAGED_ITEMS;
        } else if (store.changesViewMode === 'changelists') {
          const baseItems: ContextMenuEntry[] = [
            { id: 'rollback',     label: t('Rollback'),              icon: 'discard' },
            { id: 'shelve',       label: t('Shelve Changes'),         icon: 'archive' },
            { id: 'stash',        label: t('Stash Changes'),          icon: 'save' },
            { separator: true },
            ...(!isInDefaultCl ? [{ id: 'add-to-git', label: t('Add to Git'), icon: 'add' } as ContextMenuEntry] : []),
            ...(hasCustomCls ? [{ id: 'move-to-cl', label: t('Move to Changelist…'), icon: 'list-unordered' } as ContextMenuEntry] : []),
            { separator: true },
            { id: 'manage-repo',  label: t('Manage Repository'),      icon: 'git-branch' },
            { id: 'view-git-log', label: t('View Git Log'),           icon: 'git-commit' },
            { separator: true },
            { id: 'hide-repo',    label: t('Hide Repository'),        icon: 'eye-closed' },
            { separator: true },
            { id: 'refresh',      label: t('Refresh'),                icon: 'refresh' },
          ];
          repoItems = baseItems;
        }
        if (isSvn) {
          repoItems = svnContextMenuItems(repoItems, hasUntracked);
        }
        return (
          <ContextMenu
            x={repoCtxMenu.x} y={repoCtxMenu.y}
            items={repoItems}
            onSelect={id => {
              if (id === 'move-to-cl') {
                const ctx = repoCtxMenu;
                const repoStatus = repos.find(r => r.repoId === ctx.repoId);
                const allRepoFiles: Array<{ repoId: string; path: string }> = [];
                if (repoStatus) {
                  const seen = new Set<string>();
                  for (const f of [...repoStatus.unstagedFiles, ...repoStatus.stagedFiles]) {
                    if (!seen.has(f.path)) { seen.add(f.path); allRepoFiles.push({ repoId: f.repoId, path: f.path }); }
                  }
                }
                if (allRepoFiles.length > 0) {
                  send({ type: 'CHANGELISTS_MOVE_FILES_PROMPT', files: allRepoFiles } satisfies CommitToHostMsg);
                }
                setRepoCtxMenu(null);
              } else if (id === 'add-to-git') {
                const repoStatus = repos.find(r => r.repoId === repoCtxMenu.repoId);
                const untrackedPaths = repoStatus?.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path) ?? [];
                if (untrackedPaths.length > 0) {
                  send({ type: 'COMMIT_STAGE_FILES', requestId: generateId(), repoId: repoCtxMenu.repoId, paths: untrackedPaths } satisfies CommitToHostMsg);
                }
                setRepoCtxMenu(null);
              } else if (id === 'svn-manage-ignore') {
                send({ type: 'COMMIT_MANAGE_SVN_IGNORE', repoId: repoCtxMenu.repoId } satisfies CommitToHostMsg);
                setRepoCtxMenu(null);
              } else {
                handleRepoContextMenuSelect(id);
              }
            }}
            onClose={() => setRepoCtxMenu(null)}
          />
        );
      })()}

      {/* Changelist header context menu (also used for empty-space click) */}
      {clHeaderCtxMenu && (() => {
        const isEmpty = clHeaderCtxMenu.changelistId === 'empty';
        const isUnversioned = clHeaderCtxMenu.changelistId === CHANGELIST_UNVERSIONED_ID;
        const isFixed = clHeaderCtxMenu.changelistId === CHANGELIST_DEFAULT_ID || isUnversioned;
        const baseItems = isEmpty
          ? CHANGELIST_EMPTY_AREA_ITEMS
          : isUnversioned
            ? CHANGELIST_HEADER_ITEMS_UNVERSIONED
            : isFixed
              ? CHANGELIST_HEADER_ITEMS_FIXED
              : CHANGELIST_HEADER_ITEMS_CUSTOM;
        const cl = store.changelists.find(item => item.id === clHeaderCtxMenu.changelistId);
        const assignedRepoIds = cl
          ? Object.entries(cl.fileAssignments).filter(([, paths]) => paths.length > 0).map(([repoId]) => repoId)
          : [];
        const hasSvnTargets = assignedRepoIds.some(repoId => isSvnRepo(repoId));
        const hasGitTargets = assignedRepoIds.some(repoId => !isSvnRepo(repoId));
        const items = !isEmpty && hasSvnTargets && !hasGitTargets
          ? svnContextMenuItems(baseItems, isUnversioned, false)
          : baseItems;
        return (
          <ContextMenu
            x={clHeaderCtxMenu.x} y={clHeaderCtxMenu.y}
            items={items}
            onSelect={handleClHeaderContextMenuSelect}
            onClose={() => setClHeaderCtxMenu(null)}
          />
        );
      })()}

      {submoduleDiffModal && (
        <div style={css.modalOverlay} onClick={() => setSubmoduleDiffModal(null)}>
          <div style={css.modalBox} onClick={e => e.stopPropagation()}>
            <div style={css.modalHeader}>
              <span className="codicon codicon-references" style={{ marginRight: 6, color: 'var(--vscode-editorWarning-foreground)' }} />
              <span style={{ fontWeight: 600 }}>{t('Submodule Pointer Details')}</span>
              <button
                style={css.modalCloseBtn}
                title={t('Close')}
                onClick={() => setSubmoduleDiffModal(null)}
              >
                ✕
              </button>
            </div>
            <div style={css.modalBody}>
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 11, color: 'var(--vscode-descriptionForeground)', marginBottom: 2 }}>
                  {t('Path')}:
                </div>
                <div style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 12, fontWeight: 500 }}>
                  {submoduleDiffModal.submodulePath}
                </div>
              </div>

              {submoduleDiffModal.loading ? (
                <div style={{ padding: '16px 0', textAlign: 'center', color: 'var(--vscode-descriptionForeground)' }}>
                  <span className="codicon codicon-loading codicon-modifier-spin" style={{ marginRight: 6 }} />
                  {t('Loading...')}
                </div>
              ) : (
                <>
                  <div style={css.compareBox}>
                    <div style={css.compareCol}>
                      <div style={css.compareLabel}>{t('Recorded in Parent (HEAD)')}</div>
                      <div style={css.compareCommit}>
                        <span className="codicon codicon-git-commit" style={{ marginRight: 4, opacity: 0.7 }} />
                        {(submoduleDiffModal.parentCommit ?? submoduleDiffModal.oldHash)?.slice(0, 8) || '00000000'}
                      </div>
                    </div>
                    {submoduleDiffModal.indexCommit && submoduleDiffModal.indexCommit !== submoduleDiffModal.parentCommit && (
                      <>
                        <div style={{ display: 'flex', alignItems: 'center', opacity: 0.5 }}>
                          <span className="codicon codicon-arrow-right" />
                        </div>
                        <div style={css.compareCol}>
                          <div style={css.compareLabel}>{t('Staged in Index')}</div>
                          <div style={{ ...css.compareCommit, color: 'var(--vscode-gitDecoration-stageModifiedResourceForeground, #89d185)' }}>
                            <span className="codicon codicon-git-commit" style={{ marginRight: 4, opacity: 0.7 }} />
                            {submoduleDiffModal.indexCommit.slice(0, 8)}
                          </div>
                        </div>
                      </>
                    )}
                    <div style={{ display: 'flex', alignItems: 'center', opacity: 0.5 }}>
                      <span className="codicon codicon-arrow-right" />
                    </div>
                    <div style={css.compareCol}>
                      <div style={css.compareLabel}>{t('Current Submodule HEAD')}</div>
                      <div style={css.compareCommit}>
                        <span className="codicon codicon-git-commit" style={{ marginRight: 4, opacity: 0.7 }} />
                        {(submoduleDiffModal.headCommit ?? submoduleDiffModal.newHash)?.slice(0, 8) || '00000000'}
                      </div>
                    </div>
                  </div>

                  {submoduleDiffModal.summary && (
                    <div style={{ marginTop: 10, padding: 6, backgroundColor: 'var(--vscode-textCodeBlock-background, rgba(0,0,0,0.1))', borderRadius: 3, fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 11, whiteSpace: 'pre-wrap', maxHeight: 100, overflowY: 'auto' }}>
                      {submoduleDiffModal.summary}
                    </div>
                  )}

                  {submoduleDiffModal.error && (
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--vscode-errorForeground)' }}>
                      {submoduleDiffModal.error}
                    </div>
                  )}
                </>
              )}
            </div>
            <div style={css.modalFooter}>
              <button
                style={css.modalSecondaryBtn}
                onClick={() => {
                  setActiveTab('submodule');
                  setHighlightSubmodulePath(submoduleDiffModal.submodulePath);
                  setSubmoduleDiffModal(null);
                }}
              >
                <span className="codicon codicon-link-external" style={{ marginRight: 4, fontSize: 12 }} />
                {t('View in Submodule Panel')}
              </button>
              <button
                style={css.modalPrimaryBtn}
                onClick={() => {
                  handleSubmoduleUpdate(submoduleDiffModal.parentRepoId, submoduleDiffModal.submodulePath, false);
                  setSubmoduleDiffModal(null);
                }}
              >
                <span className="codicon codicon-refresh" style={{ marginRight: 4, fontSize: 12 }} />
                {t('Align Submodule with Parent')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const css = {
  app: {
    display: 'flex', flexDirection: 'column' as const, height: '100vh',
    background: 'var(--vscode-sideBar-background)', color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)', fontSize: 'var(--vscode-font-size)', overflow: 'hidden',
    userSelect: 'none' as const,
  },
  notificationBar: {
    display: 'flex', alignItems: 'flex-start', gap: '7px',
    padding: '6px 8px 6px 10px', flexShrink: 0,
    background: 'var(--vscode-inputValidation-warningBackground, rgba(255,170,0,0.12))',
    borderBottom: '1px solid var(--vscode-inputValidation-warningBorder, rgba(255,170,0,0.4))',
    color: 'var(--vscode-editorWarning-foreground, #e9ae00)',
    fontSize: '11px', lineHeight: '1.5',
  } as React.CSSProperties,
  notificationText: {
    flex: 1, wordBreak: 'break-word' as const, minWidth: 0,
  } as React.CSSProperties,
  notificationClose: {
    background: 'transparent', border: 'none', cursor: 'pointer', padding: '1px 2px',
    color: 'var(--vscode-descriptionForeground)', display: 'flex', alignItems: 'center', flexShrink: 0,
    fontSize: '13px', borderRadius: '2px',
  } as React.CSSProperties,
  tabBar: {
    display: 'flex', borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)', flexShrink: 0,
  } as React.CSSProperties,
  tab: (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center',
    padding: active ? '5px 12px' : '5px 10px',
    fontSize: '12px',
    cursor: 'pointer', background: 'transparent', border: 'none',
    borderBottom: active ? '2px solid var(--vscode-focusBorder)' : '2px solid transparent',
    opacity: 1,
    color: active ? 'var(--vscode-foreground)' : 'var(--vscode-descriptionForeground)',
    fontFamily: 'var(--vscode-font-family)',
    fontWeight: active ? '600' : 'normal', whiteSpace: 'nowrap' as const,
    transition: 'color 0.1s, border-color 0.1s',
  }),
  tabBadge: (active: boolean): React.CSSProperties => ({
    background: 'var(--versiondock-badge-background)',
    color: 'var(--versiondock-badge-foreground)',
    borderRadius: '8px',
    padding: '0 5px',
    fontSize: '10px',
    fontWeight: 'bold' as const,
    lineHeight: '16px',
    marginLeft: '5px',
    flexShrink: 0,
    minWidth: '16px',
    textAlign: 'center' as const,
    opacity: active ? 1 : 0.65,
    transition: 'opacity 0.15s',
  }),
  main: { display: 'flex', flexDirection: 'column' as const, flex: 1, overflow: 'hidden' },
  repoList: { flex: 1, overflowY: 'auto' as const },
  // Shelve name prompt bar (above commit form)
  shelvePromptBar: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-sideBar-background)', flexShrink: 0,
  } as React.CSSProperties,
  shelvePromptInput: {
    flex: 1, background: 'var(--vscode-input-background)', color: 'var(--vscode-input-foreground)',
    border: '1px solid var(--vscode-focusBorder)', borderRadius: '3px',
    padding: '3px 6px', fontSize: '12px', fontFamily: 'var(--vscode-font-family)', outline: 'none',
  } as React.CSSProperties,
  shelvePromptOk: {
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
    border: 'none', borderRadius: '3px', padding: '3px 7px', cursor: 'pointer',
    fontSize: '13px', display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  shelvePromptCancel: {
    background: 'transparent', color: 'var(--vscode-foreground)', border: 'none',
    borderRadius: '3px', padding: '3px 5px', cursor: 'pointer',
    fontSize: '13px', display: 'flex', alignItems: 'center',
  } as React.CSSProperties,
  fullCenter: {
    height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--vscode-sideBar-background)', color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)',
  },
  initRepoBtn: {
    background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)',
    border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
    fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: '500' as const,
  },
  secondaryBtn: {
    background: 'var(--vscode-button-secondaryBackground)', color: 'var(--vscode-button-secondaryForeground)',
    border: 'none', borderRadius: '4px', padding: '6px 16px', cursor: 'pointer',
    fontSize: '13px', fontFamily: 'var(--vscode-font-family)', fontWeight: '500' as const,
  },
  modalOverlay: {
    position: 'fixed' as const,
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.45)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '16px',
  } as React.CSSProperties,
  modalBox: {
    backgroundColor: 'var(--vscode-sideBar-background)',
    border: '1px solid var(--vscode-widget-border, var(--vscode-panel-border))',
    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    borderRadius: '4px',
    width: '100%',
    maxWidth: '420px',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
  } as React.CSSProperties,
  modalHeader: {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 12px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontSize: '12px',
  } as React.CSSProperties,
  modalCloseBtn: {
    marginLeft: 'auto',
    background: 'none',
    border: 'none',
    color: 'var(--vscode-foreground)',
    opacity: 0.7,
    cursor: 'pointer',
    fontSize: '12px',
    padding: '2px 4px',
  } as React.CSSProperties,
  modalBody: {
    padding: '12px',
    fontSize: '12px',
  } as React.CSSProperties,
  compareBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 10px',
    backgroundColor: 'var(--vscode-editor-background)',
    borderRadius: '4px',
    border: '1px solid var(--vscode-widget-border, rgba(128,128,128,0.2))',
  } as React.CSSProperties,
  compareCol: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
  } as React.CSSProperties,
  compareLabel: {
    fontSize: '10px',
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  compareCommit: {
    display: 'flex',
    alignItems: 'center',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: '11px',
    fontWeight: 600,
  } as React.CSSProperties,
  modalFooter: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    padding: '8px 12px',
    borderTop: '1px solid var(--vscode-panel-border)',
    backgroundColor: 'var(--vscode-sideBarSectionHeader-background, transparent)',
  } as React.CSSProperties,
  modalPrimaryBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 10px',
    backgroundColor: 'var(--vscode-button-background)',
    color: 'var(--vscode-button-foreground)',
    border: 'none',
    borderRadius: '2px',
    cursor: 'pointer',
    fontSize: '11px',
  } as React.CSSProperties,
  modalSecondaryBtn: {
    display: 'flex',
    alignItems: 'center',
    padding: '4px 10px',
    backgroundColor: 'var(--vscode-button-secondaryBackground)',
    color: 'var(--vscode-button-secondaryForeground)',
    border: 'none',
    borderRadius: '2px',
    cursor: 'pointer',
    fontSize: '11px',
  } as React.CSSProperties,
};

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e.message + '\n' + e.stack }; }
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    getVsCodeApi().postMessage({
      type: 'COMMIT_WEBVIEW_ERROR',
      message: error.message,
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    } satisfies CommitToHostMsg);
  }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 16, color: 'red', fontFamily: 'monospace', fontSize: 11, whiteSpace: 'pre-wrap', userSelect: 'text' }}>
        {this.state.error}
      </div>
    );
    return this.props.children;
  }
}

if ((window as Window & { __VERSIONDOCK_APP_NAME__?: string }).__VERSIONDOCK_APP_NAME__ !== 'undockedPanel') {
  createRoot(document.getElementById('root')!).render(<ErrorBoundary><CommitApp /></ErrorBoundary>);
}
