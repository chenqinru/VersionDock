import React, { useEffect, useCallback, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useCommitStore } from './store/commitStore';
import { ProjectGroup } from './components/ProjectGroup';
import { ChangelistView } from './components/ChangelistView';
import { VscodeView } from './components/VscodeView';
import { UnifiedCommitForm } from './components/UnifiedCommitForm';
import { ContextMenu, type ContextMenuEntry } from './components/ContextMenu';
import { ShelvePanel, getShelveExpansionKeys } from './components/ShelvePanel';
import { StashTab, type ExpansionCommand } from './components/StashTab';
import { PushTab } from './components/PushTab';
import { WorktreeDiffPanel } from './components/WorktreeDiffPanel';
import { WorktreePanel } from './components/WorktreePanel';
import { SubtreePanel } from './components/SubtreePanel';
import { ConflictBanner, type ConflictBannerAction } from './components/ConflictBanner';
import { getVsCodeApi } from '../shared/vscodeApi';
import { Codicon } from '../shared/Codicon';
import type { CommitToHostMsg, HostToCommitMsg, ShelveEntry, StashEntry, UnpushedCommit, PushCommitFile, WorktreeEntry, SubtreeEntry, SubtreeOp, SubtreePushStatus } from '../shared/msgTypes';
import type { FileStatus } from '../shared/types';
import { t } from '../shared/i18n';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../shared/types';
import { baseNameFromPath } from '../shared/pathUtils';
import { branchInfoColor } from '../shared/branchColors';

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
  { id: 'unstage',  label: t('Unstage'),   icon: 'remove' },
  { separator: true },
  { id: 'refresh',  label: t('Refresh'),   icon: 'refresh' },
];

const SUBMODULE_FILE_UNSTAGED_ITEMS: ContextMenuEntry[] = [
  { id: 'stage',    label: t('Stage'),     icon: 'add' },
  { separator: true },
  { id: 'refresh',  label: t('Refresh'),   icon: 'refresh' },
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

type TabId = 'changes' | 'shelf' | 'stash' | 'push' | 'worktree' | 'subtree';
const ALL_TABS: TabId[] = ['changes', 'shelf', 'stash', 'worktree', 'subtree', 'push'];
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

  // ── Shelve state ──────────────────────────────────────────────────────────
  const [shelveMap, setShelveMap]       = useState<Record<string, ShelveEntry[]>>({});
  const [shelveLoading, setShelveLoading] = useState<Record<string, boolean>>({});
  const [shelveError, setShelveError]   = useState<Record<string, string | null>>({});

  // ── Stash state ───────────────────────────────────────────────────────────
  const [stashMap, setStashMap]       = useState<Record<string, StashEntry[]>>({});
  const [stashCountMap, setStashCountMap] = useState<Record<string, number>>({});
  const [stashLoading, setStashLoading] = useState<Record<string, boolean>>({});
  const [stashError, setStashError]   = useState<Record<string, string | null>>({});
  const [stashExpansionCommand, setStashExpansionCommand] = useState<ExpansionCommand>({ sequence: 0, expanded: false });

  // ── Worktree state ────────────────────────────────────────────────────────
  const [worktreeRepos, setWorktreeRepos] = useState<Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }>>([]);
  const [worktreeLoading, setWorktreeLoading] = useState(false);
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

  // ── Subtree state ────────────────────────────────────────────────────────
  const [subtreeEntries, setSubtreeEntries] = useState<SubtreeEntry[]>([]);
  const [subtreeLoading, setSubtreeLoading] = useState(false);
  const [subtreeOps, setSubtreeOps] = useState<Record<string, SubtreeOp | undefined>>({});
  const [subtreeStatuses, setSubtreeStatuses] = useState<Record<string, SubtreePushStatus | undefined>>({});
  const [subtreeError, setSubtreeError] = useState<string | null>(null);
  const subtreeEntriesRef = useRef<SubtreeEntry[]>([]);
  const lastSubtreeListRequestAtRef = useRef(0);
  const commitStatusRefreshPendingRef = useRef(false);
  const tabCountBootstrappedRepoIdsRef = useRef<Set<string>>(new Set());
  const tabCountWorktreeRequestedRef = useRef(false);
  const tabCountSubtreeRequestedRef = useRef(false);

  // ── Hidden repositories ───────────────────────────────────────────────────
  const [hiddenRepoIds, setHiddenRepoIds] = useState<string[]>([]);
  const hiddenRepoIdsRef = useRef<Set<string>>(new Set());

  // ── Submodule detached HEAD warnings ─────────────────────────────────────
  // repoId → headCommit — shown as dismissable banner above the file tree
  const [detachedWarnings, setDetachedWarnings] = useState<Record<string, string>>({});

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

  // ── Push / unpushed state ─────────────────────────────────────────────────
  const [unpushedMap, setUnpushedMap] = useState<Record<string, { loading: boolean; commits: UnpushedCommit[]; error?: string }>>({});

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

  // ── Dropdowns ─────────────────────────────────────────────────────────────
  const [viewMenuOpen, setViewMenuOpen]             = useState(false);
  const [shelveViewMenuOpen, setShelveViewMenuOpen] = useState(false);
  const viewMenuRef       = useRef<HTMLDivElement>(null);
  const shelveViewMenuRef = useRef<HTMLDivElement>(null);

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
    if (options.refreshSubtrees) {
      setSubtreeLoading(true);
      setSubtreeError(null);
    }
    send({ type: 'COMMIT_REQUEST_STATUS', refreshSubtrees: options.refreshSubtrees });
  }, [send, subtreeLoading]);

  // Close view-menus on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (viewMenuRef.current && !viewMenuRef.current.contains(e.target as Node)) setViewMenuOpen(false);
      if (shelveViewMenuRef.current && !shelveViewMenuRef.current.contains(e.target as Node)) setShelveViewMenuOpen(false);
    };
    document.addEventListener('mousedown', h, true);
    return () => document.removeEventListener('mousedown', h, true);
  }, []);

  const notifyError = useCallback((message: string) => {
    send({ type: 'NOTIFY_ERROR', message } satisfies CommitToHostMsg);
  }, [send]);

  const notifyInfo = useCallback((message: string) => {
    send({ type: 'NOTIFY_INFO', message } satisfies CommitToHostMsg);
  }, [send]);

  useEffect(() => {
    send({ type: 'COMMIT_ACTIVE_TAB_CHANGED', tab: activeTab });
  }, [activeTab, send]);

  // ── Message handler ───────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent<HostToCommitMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;

      const requestVisibleGitPushData = () => {
        const freshState = useCommitStore.getState();
        const metaById = new Map(freshState.repoMetas.map(meta => [meta.id, meta]));
        for (const repo of freshState.status?.repos ?? []) {
          if (hiddenRepoIdsRef.current.has(repo.repoId)) continue;
          if (metaById.get(repo.repoId)?.kind === 'svn') continue;
          requestUnpushedCommits(repo.repoId);
        }
      };

      if ('requestId' in msg && msg.requestId && pendingRef.current.has(msg.requestId as string)) {
        const resolve = pendingRef.current.get(msg.requestId as string)!;
        pendingRef.current.delete(msg.requestId as string);
        resolve(msg);
      }

      switch (msg.type) {
        case 'COMMIT_STATUS_UPDATE':
          commitStatusRefreshPendingRef.current = false;
          store.setStatus(msg.repos, msg.status, msg.iconTheme, msg.fileViewMode, msg.defaultCommitAction, msg.defaultSaveAction, msg.hasWorkspaceFolder);
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
          break;
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
          if (msg.ok) {
            // Refresh push tab after any successful operation (commit, undo, push, etc.)
            const currentRepos = useCommitStore.getState().status?.repos ?? [];
            currentRepos.forEach(r => requestUnpushedCommits(r.repoId));
          } else if (msg.error && msg.error !== 'Cancelled') {
            notifyError(msg.error);
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
        case 'COMMIT_GENERATE_MESSAGE_RESULT':
          if (activeGenerateRequestIdRef.current !== msg.requestId) break;
          activeGenerateRequestIdRef.current = null;
          setGeneratingMessage(false);
          if (msg.message) store.setCommitMessage(msg.message);
          else if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;
        case 'COMMIT_SET_MESSAGE':
          if (msg.requestId && activeGenerateRequestIdRef.current !== msg.requestId) break;
          store.setCommitMessage(msg.message);
          break;
        case 'COMMIT_SET_ACTIVE_TAB':
          setActiveTab(msg.tab);
          if (msg.tab === 'push') requestVisibleGitPushData();
          if (msg.tab === 'subtree') {
            setSubtreeLoading(true);
            setSubtreeError(null);
            send({ type: 'SUBTREE_REQUEST_LIST' });
          }
          break;
        case 'COMMIT_TRIGGER_ACTION':
          commitActionRef.current(msg.andPush);
          break;
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
            if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          } else {
            if (msg.hasConflicts && msg.conflictFiles?.length) {
              notifyInfo(t('Conflicts in {0} file(s) — merge editor opened', msg.conflictFiles.length));
            }
            // Refresh the shelf list for the affected repo after any successful op
            setShelveLoading(prev => ({ ...prev, [msg.repoId]: true }));
            getVsCodeApi().postMessage({ type: 'SHELVE_LIST', requestId: generateId(), repoId: msg.repoId } satisfies CommitToHostMsg);
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
            setStashCountMap(prev => ({ ...prev, [msg.repoId]: msg.stashes.length }));
            setStashError(prev => ({ ...prev, [msg.repoId]: null }));
          }
          break;

        case 'STASH_OP_RESULT':
          if (!msg.ok) {
            if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          } else {
            // Refresh stash list for affected repo
            setStashLoading(prev => ({ ...prev, [msg.repoId]: true }));
            getVsCodeApi().postMessage({ type: 'STASH_COUNT', requestId: generateId(), repoId: msg.repoId } satisfies CommitToHostMsg);
            getVsCodeApi().postMessage({ type: 'STASH_LIST', requestId: generateId(), repoId: msg.repoId } satisfies CommitToHostMsg);
          }
          break;

        case 'PUSH_UNPUSHED_RESULT':
          setUnpushedMap(prev => ({
            ...prev,
            [msg.repoId]: { loading: false, commits: msg.commits, error: msg.error },
          }));
          break;

        case 'PUSH_SQUASH_RESULT':
          if (msg.ok) notifyInfo(t('Squash completed.'));
          else if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;
        case 'PUSH_DROP_RESULT':
        case 'PUSH_REVERT_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;
        case 'PUSH_EDIT_MSG_RESULT':
          if (msg.ok) notifyInfo(t('Commit message updated.'));
          else if (msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;

        case 'SUBMODULE_OP_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;

        case 'SUBMODULE_DETACHED_HEAD_WARNING':
          setDetachedWarnings(prev => ({ ...prev, [msg.repoId]: msg.headCommit }));
          break;

        case 'SUBMODULE_PUSH_RESULT':
        case 'SUBMODULE_PULL_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;

        case 'WORKTREE_LIST_RESULT':
          setWorktreeLoading(false);
          setWorktreeRepos(msg.repos);
          break;

        case 'WORKTREE_OP_RESULT':
          if (!msg.ok && msg.error && msg.error !== 'Cancelled') notifyError(msg.error);
          break;

        case 'SUBTREE_LIST_RESULT':
          if (msg.error) {
            setSubtreeLoading(false);
            setSubtreeError(msg.error);
          } else {
            subtreeEntriesRef.current = msg.entries;
            setSubtreeEntries(msg.entries);
            setSubtreeStatuses(prev => {
              const next: Record<string, SubtreePushStatus | undefined> = {};
              for (const entry of msg.entries) {
                next[entry.id] = { ...prev[entry.id], loading: true };
              }
              return next;
            });
            setSubtreeError(null);
          }
          break;

        case 'SUBTREE_STATUS_RESULT':
          setSubtreeStatuses(prev => {
            const next = { ...prev, ...msg.statuses };
            const hasLoading = subtreeEntriesRef.current.some(entry => next[entry.id]?.loading);
            if (!hasLoading) setSubtreeLoading(false);
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
          break;

        case 'COMMIT_HIDDEN_REPOS_UPDATE':
          hiddenRepoIdsRef.current = new Set(msg.hiddenRepoIds);
          setHiddenRepoIds(msg.hiddenRepoIds);
          break;

        case 'COMMIT_SWITCH_TAB':
          setActiveTab(msg.tab);
          if (msg.tab === 'push') requestVisibleGitPushData();
          break;
      }
    };
    window.addEventListener('message', handler);
    requestCommitStatus();
    return () => window.removeEventListener('message', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Shelve callbacks ──────────────────────────────────────────────────────

  const requestShelveList = useCallback((repoId: string) => {
    setShelveLoading(prev => ({ ...prev, [repoId]: true }));
    send({ type: 'SHELVE_LIST', requestId: generateId(), repoId });
  }, [send]);

  const confirmShelve = useCallback((repoId: string, name: string, paths?: string[]) => {
    if (!name.trim()) return;
    send({ type: 'SHELVE_PUSH', requestId: generateId(), repoId, name: name.trim(), paths });
    setShelvePrompt(null);
  }, [send]);

  const handleUnshelve = useCallback((repoId: string, shelveId: string) => {
    send({ type: 'SHELVE_APPLY', requestId: generateId(), repoId, shelveId });
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

  const requestStashCount = useCallback((repoId: string) => {
    send({ type: 'STASH_COUNT', requestId: generateId(), repoId });
  }, [send]);

  const requestStashList = useCallback((repoId: string) => {
    setStashLoading(prev => ({ ...prev, [repoId]: true }));
    send({ type: 'STASH_LIST', requestId: generateId(), repoId });
  }, [send]);

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

  const requestWorktreeList = useCallback(() => {
    setWorktreeLoading(true);
    setWorktreeError(null);
    send({ type: 'WORKTREE_REQUEST_LIST' });
  }, [send]);

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

  // ── Subtree callbacks ────────────────────────────────────────────────────

  const requestSubtreeList = useCallback((force = false) => {
    const now = Date.now();
    if (!force && lastSubtreeListRequestAtRef.current > 0 && now - lastSubtreeListRequestAtRef.current < SUBTREE_LIST_REQUEST_THROTTLE_MS) {
      return;
    }
    lastSubtreeListRequestAtRef.current = now;
    setSubtreeLoading(true);
    setSubtreeError(null);
    send({ type: 'SUBTREE_REQUEST_LIST' });
  }, [send]);

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

  // ── Push / unpushed callbacks ─────────────────────────────────────────────

  const requestUnpushedCommits = useCallback((repoId: string) => {
    setUnpushedMap(prev => ({
      ...prev,
      // Keep existing commits visible while refreshing; only clear on first load
      [repoId]: prev[repoId]
        ? { ...prev[repoId], loading: true }
        : { loading: true, commits: [] },
    }));
    send({ type: 'PUSH_GET_UNPUSHED', requestId: generateId(), repoId });
  }, [send]);

  const requestPushCommitFiles = useCallback((repoId: string, hash: string): Promise<PushCommitFile[]> => {
    const requestId = generateId();
    return new Promise(resolve => {
      pendingRef.current.set(requestId, msg => {
        if (msg.type !== 'PUSH_COMMIT_FILES_RESULT') {
          resolve([]);
          return;
        }
        if (msg.error && msg.error !== 'Cancelled') {
          notifyError(msg.error);
        }
        resolve(msg.files);
      });
      send({ type: 'PUSH_GET_COMMIT_FILES', requestId, repoId, hash });
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
      store.setError(t('Inspect file changes in the submodule repository section. Parent repos only track the gitlink update.'));
      return;
    }
    const isStaged = repoStatus?.stagedFiles.some(f => f.path === filePath) ?? false;
    send({ type: 'COMMIT_OPEN_DIFF', repoId, filePath, staged: isStaged });
  }, [store, send]);

  const allRepos = store.status?.repos ?? [];
  const repos = hiddenRepoIds.length > 0 ? allRepos.filter(r => !hiddenRepoIds.includes(r.repoId)) : allRepos;
  const metaMap = new Map(store.repoMetas.map(m => [m.id, m]));
  const commitMessageHistoryRepoKey = repos.map(repo => repo.repoId).sort().join('\0');

  useEffect(() => {
    const repoIds = commitMessageHistoryRepoKey ? commitMessageHistoryRepoKey.split('\0') : [];
    if (repoIds.length === 0) {
      activeCommitMessageHistoryRequestIdRef.current = null;
      setCommitMessageHistory([]);
      setCommitMessageHistoryLoading(false);
      return;
    }
    const requestId = generateId();
    activeCommitMessageHistoryRequestIdRef.current = requestId;
    setCommitMessageHistory([]);
    setCommitMessageHistoryLoading(true);
    send({ type: 'COMMIT_REQUEST_MESSAGE_HISTORY', requestId, repoIds, limit: COMMIT_MESSAGE_HISTORY_FETCH_LIMIT });
    return () => {
      if (activeCommitMessageHistoryRequestIdRef.current === requestId) {
        activeCommitMessageHistoryRequestIdRef.current = null;
      }
    };
  }, [commitMessageHistoryRepoKey, send]);
  const isSvnRepo = (repoId: string) => metaMap.get(repoId)?.kind === 'svn';
  const gitRepos = repos.filter(repo => !isSvnRepo(repo.repoId));
  const showVcsBadges = gitRepos.length > 0 && gitRepos.length < repos.length;
  const gitRepoMetas = store.repoMetas.filter(meta => meta.kind !== 'svn');
  const visibleTabs = gitRepos.length > 0 ? ALL_TABS : SVN_ONLY_TABS;
  const visibleRepoIds = new Set(repos.map(repo => repo.repoId));
  const multiRepo = repos.length >= 1;
  const totalConflictCount = repos.reduce((sum, repo) => sum + repo.conflictCount, 0);
  const conflictRepoIds = repos.filter(repo => repo.conflictCount > 0).map(repo => repo.repoId);
  const abortableConflictRepos = repos.filter(repo =>
    repo.conflictCount > 0 && (repo.operationState === 'merge' || repo.operationState === 'rebase')
  );
  const abortableConflictRepoIds = abortableConflictRepos.map(repo => repo.repoId);
  const abortableConflictStates = new Set(abortableConflictRepos.map(repo => repo.operationState));
  const abortOperationLabel = abortableConflictStates.size > 1
    ? t('Abort Merge/Rebase')
    : abortableConflictStates.has('rebase')
      ? t('Abort Rebase')
      : t('Abort Merge');
  const abortOperationTitle = abortableConflictStates.size > 1
    ? t('Merge or rebase in progress — abort and restore previous state')
    : abortableConflictStates.has('rebase')
      ? t('Rebase in progress — abort and restore previous state')
      : t('Merge in progress — abort and restore previous state');
  const restorableConflictRepoIds = repos
    .filter(repo => repo.conflictCount > 0 && repo.operationState === null && metaMap.get(repo.repoId)?.kind !== 'svn')
    .map(repo => repo.repoId);
  const conflictRepoCount = conflictRepoIds.length;
  const conflictRepoSummary = conflictRepoCount === 1
    ? t('{0} repository', conflictRepoCount)
    : t('{0} repositories', conflictRepoCount);
  const conflictFileSummary = totalConflictCount === 1
    ? t('{0} unresolved conflict file', totalConflictCount)
    : t('{0} unresolved conflict files', totalConflictCount);
  const conflictSummary = conflictRepoCount > 0
    ? `${conflictRepoSummary} ${t('·')} ${conflictFileSummary}`
    : '';
  const conflictBannerActions: ConflictBannerAction[] = totalConflictCount > 0 ? [
    {
      id: 'resolve',
      label: t('Resolve Conflicts'),
      title: t('Open the conflicts panel to resolve files'),
      tone: 'primary',
      onClick: () => send({ type: 'COMMIT_OPEN_CONFLICTS' }),
    },
    ...(abortableConflictRepoIds.length > 0 ? [{
      id: 'abort',
      label: abortOperationLabel,
      title: abortOperationTitle,
      tone: 'danger' as const,
      onClick: () => send({ type: 'COMMIT_ABORT_OPERATION', requestId: generateId(), repoIds: abortableConflictRepoIds }),
    }] : []),
    ...(restorableConflictRepoIds.length > 0 ? [{
      id: 'restore',
      label: t('Restore Current Branch'),
      title: t('Discard conflicted index and working tree changes, then restore the current branch versions'),
      tone: 'danger' as const,
      onClick: () => send({ type: 'COMMIT_RESTORE_CONFLICTS', requestId: generateId(), repoIds: restorableConflictRepoIds }),
    }] : []),
  ] : [];

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) setActiveTab('changes');
  }, [activeTab, visibleTabs]);

  // Keep unpushed-commit counts fresh for repos without upstream so the Push tab badge
  // shows the correct number even before the tab is opened. Upstream repos are live via aheadBehind.ahead.
  // Full refresh on every status update is intentionally avoided to prevent visual noise.
  const noUpstreamKey = gitRepos.filter(r => !r.branch.upstream).map(r => r.repoId).join('\0');
  useEffect(() => {
    if (!noUpstreamKey) return;
    noUpstreamKey.split('\0').forEach(id => requestUnpushedCommits(id));
  }, [noUpstreamKey, requestUnpushedCommits]);

  const gitRepoKey = gitRepos.map(repo => repo.repoId).join('\0');
  useEffect(() => {
    if (!gitRepoKey) return;
    const bootstrappedRepoIds = tabCountBootstrappedRepoIdsRef.current;
    for (const repoId of gitRepoKey.split('\0')) {
      if (bootstrappedRepoIds.has(repoId)) continue;
      bootstrappedRepoIds.add(repoId);
      requestStashCount(repoId);
      requestShelveList(repoId);
    }
    if (!tabCountWorktreeRequestedRef.current) {
      tabCountWorktreeRequestedRef.current = true;
      requestWorktreeList();
    }
    if (!tabCountSubtreeRequestedRef.current) {
      tabCountSubtreeRequestedRef.current = true;
      requestSubtreeList();
    }
  }, [gitRepoKey, requestShelveList, requestStashCount, requestSubtreeList, requestWorktreeList]);

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
      case 'refresh':
        requestCommitStatus({ refreshSubtrees: activeTab === 'subtree' });
        break;
    }
  }, [activeTab, confirmShelve, ctxMenu, openDiff, doStash, requestCommitStatus, send]);

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
    const remote = useCommitStore.getState().getRepoStatus(repoId)?.branch.remoteName ?? 'origin';
    send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId, remote });
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
    for (const r of allRepos) {
      if (isSvnRepo(r.repoId)) continue;
      if ((r.branch.aheadBehind?.ahead ?? 0) > 0) {
        const remote = r.branch.remoteName ?? 'origin';
        send({ type: 'COMMIT_PUSH_REPO', requestId: generateId(), repoId: r.repoId, remote });
      }
    }
  };

  // ── Autopilot ─────────────────────────────────────────────────────────────

  const buildGenerateMessageSelection = useCallback(() => {
    const freshState = useCommitStore.getState();
    const currentRepos = freshState.status?.repos ?? [];
    if (freshState.changesViewMode === 'vscode') {
      return {
        repoIds: currentRepos
          .filter(repo => vscodeSelectedRepos.has(repo.repoId))
          .map(repo => repo.repoId),
        targets: [],
      };
    }

    const repoIds = currentRepos
      .filter(repo => freshState.repoSelections[repo.repoId] !== false)
      .map(repo => repo.repoId);
    const selectedTargets = currentRepos
      .filter(repo => repoIds.includes(repo.repoId))
      .map(repo => ({
        repoId: repo.repoId,
        paths: freshState.getSelectedFilesForRepo(repo.repoId),
      }))
      .filter(target => target.paths.length > 0);

    return { repoIds, targets: selectedTargets };
  }, [vscodeSelectedRepos]);

  const doAutopilot = useCallback(() => {
    if (generatingMessage) return;
    const requestId = generateId();
    activeGenerateRequestIdRef.current = requestId;
    store.setCommitMessage('');
    setGeneratingMessage(true);
    send({ type: 'COMMIT_GENERATE_MESSAGE', requestId, ...buildGenerateMessageSelection() });
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
        <span style={{ opacity: 0.5, fontSize: '13px' }}>{t('Loading repositories…')}</span>
      </div>
    );
  }

  if (repos.length === 0 && store.status) {
    if (!store.hasWorkspaceFolder) {
      return (
        <div style={{ ...css.fullCenter, flexDirection: 'column', gap: '12px', padding: '24px' }}>
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
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
          <div style={{ textAlign: 'center', color: 'var(--vscode-foreground)', fontSize: '13px', lineHeight: '1.5', opacity: 0.8 }}>
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
        <div style={{ textAlign: 'center', opacity: 0.45 }}>
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
    const sanitizeAmendTargets = <T extends { repoId: string; amend: boolean }>(targets: T[]): T[] => {
      const onlyTarget = targets.length === 1 ? targets[0] : null;
      const repoStatus = onlyTarget ? currentRepos.find(repo => repo.repoId === onlyTarget.repoId) : null;
      const amendRepoId = onlyTarget
        && metaMap.get(onlyTarget.repoId)?.kind !== 'svn'
        && (repoStatus?.branch.aheadBehind?.ahead ?? 0) > 0
        ? onlyTarget.repoId
        : null;
      return targets.map(target => ({
        ...target,
        amend: target.repoId === amendRepoId && target.amend,
      }));
    };

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
      const safeTargets = sanitizeAmendTargets(targets);
      store.setLoading(true);
      const requestId = generateId();
      pendingCommitMessagesRef.current.set(requestId, freshState.commitMessage.trim());
      getVsCodeApi().postMessage({ type: 'COMMIT_DO_COMMIT_MULTI', requestId, repos: safeTargets, andPush } satisfies CommitToHostMsg);
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
    const safeTargets = sanitizeAmendTargets(targets);
    store.setLoading(true);
    store.setError(null);
    const requestId = generateId();
    pendingCommitMessagesRef.current.set(requestId, freshState.commitMessage.trim());
    getVsCodeApi().postMessage({ type: 'COMMIT_DO_COMMIT_MULTI', requestId, repos: safeTargets, andPush } satisfies CommitToHostMsg);
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

      {/* ── Toolbar ── */}
      <div style={css.toolbar}>
        <div style={css.toolbarLeft}>
          <button data-action-btn="" style={css.iconBtn} title={t('Refresh')} onClick={() => requestCommitStatus({ refreshSubtrees: activeTab === 'subtree' })}>
            <Codicon name="refresh" />
          </button>
          {activeTab === 'changes' && (<>
            <button data-action-btn="" style={css.iconBtn} title={t('Rollback')} onClick={() => {
              const allFiles: Array<{ repoId: string; path: string }> = [];
              for (const r of repos) {
                const seen = new Set<string>();
                for (const f of [...r.unstagedFiles, ...r.stagedFiles]) {
                  if (!seen.has(f.path)) { seen.add(f.path); allFiles.push({ repoId: f.repoId, path: f.path }); }
                }
              }
              if (allFiles.length > 0) send({ type: 'COMMIT_DISCARD_FILES', requestId: generateId(), files: allFiles });
            }}>
              <Codicon name="discard" />
            </button>
            <button data-action-btn="" style={css.iconBtn} title={t('Expand all')} onClick={() => store.expandAll()}>
              <Codicon name="expand-all" />
            </button>
            <button data-action-btn="" style={css.iconBtn} title={t('Collapse all')} onClick={() => store.collapseAll()}>
              <Codicon name="collapse-all" />
            </button>
            <div ref={viewMenuRef} style={{ position: 'relative' }}>
              <button data-action-btn="" style={css.iconBtn} title={t('View options')} onClick={() => setViewMenuOpen(o => !o)}>
                <Codicon name="eye" />
              </button>
              {viewMenuOpen && (
                <div style={{ ...css.dropdownPanel, left: 0 }}>
                  <div style={css.dropdownTitle}>{t('View')}</div>
                  {(['flat', 'tree'] as const).map(mode => (
                    <div
                      key={mode}
                      style={{ ...css.dropdownItem, fontWeight: store.viewMode === mode ? 'bold' : 'normal' }}
                      onClick={() => { store.setViewMode(mode); send({ type: 'COMMIT_SET_FILE_VIEW_MODE', mode }); setViewMenuOpen(false); }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Codicon name={mode === 'flat' ? 'list-unordered' : 'list-tree'} style={{ marginRight: '6px' }} />
                      {mode === 'flat' ? t('Flat list') : t('Tree view')}
                      {store.viewMode === mode && <Codicon name="check" style={{ marginLeft: 'auto' }} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>)}
          {activeTab === 'shelf' && (<>
            <button data-action-btn="" style={css.iconBtn} title={t('Expand all')} onClick={() => {
              const keys = Object.entries(shelveMap)
                .flatMap(([repoId, shelves]) => getShelveExpansionKeys(repoId, shelves));
              store.shelveExpandAll(keys);
            }}>
              <Codicon name="expand-all" />
            </button>
            <button data-action-btn="" style={css.iconBtn} title={t('Collapse all')} onClick={() => {
              store.shelveCollapseAll();
            }}>
              <Codicon name="collapse-all" />
            </button>
            <div ref={shelveViewMenuRef} style={{ position: 'relative' }}>
              <button data-action-btn="" style={css.iconBtn} title={t('View options')} onClick={() => setShelveViewMenuOpen(o => !o)}>
                <Codicon name="eye" />
              </button>
              {shelveViewMenuOpen && (
                <div style={{ ...css.dropdownPanel, left: 0 }}>
                  <div style={css.dropdownTitle}>{t('View')}</div>
                  {(['flat', 'tree'] as const).map(mode => (
                    <div
                      key={mode}
                      style={{ ...css.dropdownItem, fontWeight: store.shelveViewMode === mode ? 'bold' : 'normal' }}
                      onClick={() => { store.setShelveViewMode(mode); setShelveViewMenuOpen(false); }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--vscode-list-hoverBackground)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <Codicon name={mode === 'flat' ? 'list-unordered' : 'list-tree'} style={{ marginRight: '6px' }} />
                      {mode === 'flat' ? t('Flat list') : t('Tree view')}
                      {store.shelveViewMode === mode && <Codicon name="check" style={{ marginLeft: 'auto' }} />}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>)}
          {activeTab === 'stash' && (<>
            <button data-action-btn="" style={css.iconBtn} title={t('Expand all')} onClick={() => {
              setStashExpansionCommand(command => ({ sequence: command.sequence + 1, expanded: true }));
            }}>
              <Codicon name="expand-all" />
            </button>
            <button data-action-btn="" style={css.iconBtn} title={t('Collapse all')} onClick={() => {
              setStashExpansionCommand(command => ({ sequence: command.sequence + 1, expanded: false }));
            }}>
              <Codicon name="collapse-all" />
            </button>
          </>)}
          {hiddenRepoIds.length > 0 && (
            <button
              data-action-btn=""
              style={{ ...css.iconBtn, position: 'relative' }}
              title={hiddenRepoIds.length === 1
                ? t('{0} hidden repository — click to manage', hiddenRepoIds.length)
                : t('{0} hidden repositories — click to manage', hiddenRepoIds.length)}
              onClick={() => send({ type: 'COMMIT_MANAGE_HIDDEN_REPOS' })}
            >
              <Codicon name="eye-closed" />
              <span style={{
                position: 'absolute', top: '1px', right: '1px',
                background: 'var(--vscode-badge-background)', color: 'var(--vscode-badge-foreground)',
                borderRadius: '8px', fontSize: '9px', lineHeight: '14px',
                minWidth: '14px', height: '14px', textAlign: 'center', padding: '0 3px',
              }}>{hiddenRepoIds.length}</span>
            </button>
          )}
        </div>
      </div>

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
        const totalWorktrees = worktreeRepos.reduce((sum, repo) => (
          visibleRepoIds.has(repo.repoId) ? sum + repo.worktrees.length : sum
        ), 0);
        const totalSubtrees = subtreeEntries.reduce((sum, entry) => (
          visibleRepoIds.has(entry.repoId) ? sum + 1 : sum
        ), 0);
        const totalToPush = gitRepos.reduce((sum, r) => {
          if (r.branch.upstream) return sum + (r.branch.aheadBehind?.ahead ?? 0);
          return sum + (unpushedMap[r.repoId]?.commits?.length ?? 0);
        }, 0);
        const tabCounts: Record<TabId, number> = {
          changes: totalChanges,
          shelf: totalShelves,
          stash: totalStashes,
          worktree: totalWorktrees,
          subtree: totalSubtrees,
          push: totalToPush,
        };
        return (
          <div style={css.tabBar}>
            {visibleTabs.map(tab => {
              const changesLabel = (store.changesViewMode === 'changelists' || store.changesViewMode === 'vscode') ? t('Commit') : t('Changes');
              const label = tab === 'changes' ? changesLabel : tab === 'shelf' ? t('Shelf') : tab === 'stash' ? t('Stash') : tab === 'worktree' ? t('Worktrees') : tab === 'subtree' ? t('Subtrees') : t('Push');
              const iconName = tab === 'changes' ? 'source-control' : tab === 'shelf' ? 'archive' : tab === 'stash' ? 'save' : tab === 'worktree' ? 'repo-clone' : tab === 'subtree' ? 'repo' : 'cloud-upload';
              const count = tabCounts[tab];
              return (
                <button
                  data-action-btn=""
                  key={tab}
                  style={css.tab(activeTab === tab)}
                  title={`${label} (${count})`}
                  onClick={() => {
                    setActiveTab(tab);
                    if (tab === 'shelf') gitRepos.forEach(r => requestShelveList(r.repoId));
                    if (tab === 'stash') gitRepos.forEach(r => requestStashList(r.repoId));
                    if (tab === 'push') gitRepos.forEach(r => requestUnpushedCommits(r.repoId));
                    if (tab === 'worktree') requestWorktreeList();
                    if (tab === 'subtree') requestSubtreeList();
                  }}
                >
                  <Codicon
                    name={iconName}
                    style={{ marginRight: activeTab === tab ? '5px' : '0', fontSize: '13px', transition: 'margin 0.15s' }}
                  />
                  {activeTab === tab && (
                    <span style={{ animation: 'gs-tab-label-in 0.18s ease-out both', overflow: 'hidden', display: 'inline-block' }}>
                      {label}
                    </span>
                  )}
                  {count > 0 && (
                    <span style={css.tabBadge}>{count}</span>
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

        {activeTab === 'changes' && (<>

          {totalConflictCount > 0 && (
            <ConflictBanner summary={conflictSummary} actions={conflictBannerActions} />
          )}

          {/* File list */}
          <div style={css.repoList}>
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
                onRepoContextMenu={(e, rid, staged) => setRepoCtxMenu({ x: e.clientX, y: e.clientY, repoId: rid, stagedSection: staged })}
                onBranchClick={rid => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId: rid })}
                onOpenStagedChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid, section: 'staged' })}
                onOpenUnstagedChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid, section: 'unstaged' })}
                iconTheme={store.iconTheme}
                activeFolderPath={activeFolderPath}
                selectedRepos={vscodeSelectedRepos}
                onToggleRepoSelection={toggleVscodeRepoSelection}
                onOpenAllChanges={rid => send({ type: 'COMMIT_OPEN_ALL_CHANGES', repoId: rid } satisfies CommitToHostMsg)}
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
              />
            ) : (
              repos.map((repoStatus, idx) => {
                const repoId = repoStatus.repoId;
                const meta = metaMap.get(repoId);
                const repoName = meta?.name ?? baseNameFromPath(repoId) ?? repoId;
                const repoColor = meta?.color ?? '#4ec9b0';
                const detachedCommit = meta?.isSubmodule ? detachedWarnings[repoId] : undefined;
                return (
                  <React.Fragment key={repoId}>
                    {detachedCommit && (
                      <div style={css.detachedBanner}>
                        <Codicon name="git-commit" style={{ flexShrink: 0, opacity: 0.8 }} />
                        <span style={{ flex: 1 }}>
                          {t('{0} is in detached HEAD ({1}). Checkout a branch to commit.', repoName, detachedCommit)}
                        </span>
                        <button
                          data-secondary-action-btn=""
                          style={css.detachedBannerBtn}
                          onClick={() => send({ type: 'COMMIT_SHOW_BRANCH_MENU', repoId })}
                          title={t('Checkout or create a branch')}
                        >
                          {t('Checkout branch')}
                        </button>
                        <button
                          data-action-btn=""
                          style={{ ...css.detachedBannerBtn, background: 'transparent', opacity: 0.5 }}
                          onClick={() => setDetachedWarnings(prev => { const n = { ...prev }; delete n[repoId]; return n; })}
                          title={t('Dismiss')}
                        >
                          ✕
                        </button>
                      </div>
                    )}
                    <ProjectGroup
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
                    />
                  </React.Fragment>
                );
              })
            )}
          </div>

          {/* Shelve name prompt — appears above commit form */}
          {shelvePrompt && (
            <div style={css.shelvePromptBar}>
              <Codicon name="archive" style={{ flexShrink: 0, opacity: 0.65, fontSize: '14px' }} />
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
            onAmendToggle={repoId => store.setAmend(repoId, !(store.amendFlags[repoId] ?? false))}
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
              for (const repoStatus of repos) {
                if (isSvnRepo(repoStatus.repoId)) continue;
                const selectedPaths = store.getSelectedFilesForRepo(repoStatus.repoId);
                if (selectedPaths.length === 0) continue;
                confirmShelve(repoStatus.repoId, name, selectedPaths);
              }
              store.setCommitMessage('');
            }}
            onStash={() => {
              const message = store.commitMessage.trim() || t('WIP stash');
              for (const repoStatus of repos) {
                if (isSvnRepo(repoStatus.repoId)) continue;
                const selectedPaths = store.getSelectedFilesForRepo(repoStatus.repoId);
                if (selectedPaths.length === 0) continue;
                doStash(repoStatus.repoId, message, selectedPaths);
              }
            }}
          />

        </>)}

        {activeTab === 'shelf' && (
          /* Shelf tab */
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
                  onUnshelveFile={handleUnshelveFile}
                  onDrop={handleDropShelve}
                  onRequestList={requestShelveList}
                  onOpenFileDiff={handleOpenFileDiff}
                />
              );
            })}
          </div>
        )}

        {activeTab === 'stash' && (
          /* Stash tab */
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
                  viewMode={store.viewMode}
                  onApply={handleStashApply}
                  onPop={handleStashPop}
                  onDrop={handleStashDrop}
                  onOpenFileDiff={handleStashShowFileDiff}
                  expansionCommand={stashExpansionCommand}
                />
              );
            })}
          </div>
        )}

        {activeTab === 'push' && (
          /* Push tab — manages its own scroll, footer anchored at bottom */
          <div style={{ display: 'flex', flex: 1, flexDirection: 'column', minHeight: 0 }}>
            <PushTab
              repos={gitRepos}
              repoMetas={gitRepoMetas}
              iconTheme={store.iconTheme}
              unpushedMap={unpushedMap}
              onPush={doPush}
              onPushAll={doPushAll}
              onOpenInLog={doOpenInLog}
              onUndoCommit={doUndoCommit}
              onRequestCommitFiles={requestPushCommitFiles}
              onOpenCommitFile={openPushCommitFileDiff}
              onSquash={doSquash}
              onDropCommits={doDropCommits}
              onRevertCommits={doRevertCommits}
              onEditCommitMsg={doEditCommitMsg}
            />
          </div>
        )}

        {activeTab === 'worktree' && (
          /* Worktree tab */
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
        )}

        {activeTab === 'subtree' && (
          /* Subtree tab */
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
  toolbar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '2px 6px', borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)', flexShrink: 0, gap: '4px',
  },
  toolbarLeft:  { display: 'flex', alignItems: 'center', gap: '1px' } as React.CSSProperties,
  iconBtn: {
    background: 'transparent', border: 'none', color: 'var(--vscode-foreground)',
    cursor: 'pointer', padding: '4px 5px', borderRadius: '3px',
    fontSize: '14px', display: 'flex', alignItems: 'center', opacity: 0.8,
  } as React.CSSProperties,
  dropdownPanel: {
    position: 'absolute' as const, top: '100%', left: 0, zIndex: 1000,
    background: 'var(--vscode-menu-background, var(--vscode-editor-background))',
    border: '1px solid var(--vscode-menu-border, var(--vscode-panel-border))',
    borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    minWidth: '200px', maxWidth: '280px', padding: '4px 0', fontSize: '12px',
  },
  dropdownTitle: {
    padding: '4px 12px', fontSize: '10px', opacity: 0.5,
    textTransform: 'uppercase' as const, letterSpacing: '0.05em',
  },
  dropdownItem: {
    display: 'flex', alignItems: 'center', padding: '5px 12px', cursor: 'pointer',
    background: 'transparent', overflow: 'hidden', textOverflow: 'ellipsis' as const,
    whiteSpace: 'nowrap' as const, gap: '4px',
  } as React.CSSProperties,
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
    color: 'inherit', opacity: 0.7, display: 'flex', alignItems: 'center', flexShrink: 0,
    fontSize: '13px', borderRadius: '2px',
  } as React.CSSProperties,
  tabBar: {
    display: 'flex', borderBottom: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)', flexShrink: 0,
  } as React.CSSProperties,
  tab: (active: boolean): React.CSSProperties => ({
    display: 'flex', alignItems: 'center',
    padding: active ? '5px 12px' : '5px 10px',
    fontSize: '12px',
    cursor: 'pointer', background: 'transparent', border: 'none',
    borderBottom: active ? '2px solid var(--vscode-focusBorder)' : '2px solid transparent',
    opacity: active ? 1 : 0.6, fontFamily: 'var(--vscode-font-family)',
    fontWeight: active ? '600' : 'normal', whiteSpace: 'nowrap' as const,
    transition: 'opacity 0.1s, border-color 0.1s', color: 'var(--vscode-foreground)',
  }),
  tabBadge: {
    background: 'var(--vscode-badge-background)',
    color: 'var(--vscode-badge-foreground)',
    borderRadius: '8px',
    padding: '0 5px',
    fontSize: '10px',
    fontWeight: 'bold' as const,
    lineHeight: '16px',
    marginLeft: '5px',
    flexShrink: 0,
    minWidth: '16px',
    textAlign: 'center' as const,
  } as React.CSSProperties,
  main: { display: 'flex', flexDirection: 'column' as const, flex: 1, overflow: 'hidden' },
  repoList: { flex: 1, overflowY: 'auto' as const },
  // Shelve name prompt bar (above commit form)
  detachedBanner: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px',
    background: 'color-mix(in srgb, var(--vscode-statusBarItem-warningBackground, #c6a300) 15%, transparent)',
    borderBottom: '1px solid color-mix(in srgb, var(--vscode-statusBarItem-warningBackground, #c6a300) 35%, transparent)',
    fontSize: '11px', color: 'var(--vscode-foreground)', flexShrink: 0,
  } as React.CSSProperties,
  detachedBannerBtn: {
    background: 'var(--vscode-button-secondaryBackground, rgba(255,255,255,0.1))',
    color: 'var(--vscode-button-secondaryForeground, var(--vscode-foreground))',
    border: 'none', borderRadius: '3px', padding: '2px 7px', cursor: 'pointer',
    fontSize: '11px', flexShrink: 0,
  } as React.CSSProperties,
  shelvePromptBar: {
    display: 'flex', alignItems: 'center', gap: '6px', padding: '5px 8px',
    borderTop: '1px solid var(--vscode-panel-border)',
    background: 'var(--vscode-editor-background)', flexShrink: 0,
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
    fontSize: '13px', display: 'flex', alignItems: 'center', opacity: 0.6,
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
