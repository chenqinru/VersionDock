import type {
  BranchInfo,
  ChangelistData,
  CommitNode,
  GraphCommitNode,
  FileDiff,
  FileStatus,
  MergeConflictFile,
  RepoMeta,
  RepoSubmodules,
  WorkspaceStatus,
  LineRange,
  ConflictNodeKind,
  ConflictPropertyValue,
  ConflictType,
} from './git';
import type { WorktreeEntry } from '../git/WorkspaceGitManager';
import type { IconThemeData } from '../utils/IconThemeService';
import type {
  ComposerApplyResult,
  ComposerCommitGroup,
  ComposerPreparedSource,
} from '../aiCommitComposer/types';
import type {
  CodeReviewCandidate,
  CodeReviewFinding,
  CodeReviewReport,
} from '../aiCodeReview/types';

export type { CodeReviewCandidate } from '../aiCodeReview/types';
export type { RepoSubmodules, SubmoduleItem, SubmoduleSyncStatus } from './git';

export interface MergeParentCommit {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorDate: string;
  parentIndex: number; // which parent branch (1 = first non-main, 2 = second, ...)
}

/**
 * A direct parent of a merge commit and the number of files that differ from
 * that parent. The file list is requested lazily when the row is expanded.
 */
export interface MergeParentChange {
  hash: string;
  shortHash: string;
  message: string;
  authorName: string;
  authorDate: string;
  parentIndex: number;
  fileCount: number;
}

// ─── Shelve (patch-based, PhpStorm-style) ────────────────────────────────────

export interface ShelveEntry {
  id: string;           // unique id = filename without extension
  name: string;         // user-provided description
  date: string;         // ISO date string
  branch?: string;      // source branch (missing for shelves created by older versions)
  files: Array<{ path: string; status: string }>;
  patchFile: string;    // relative path inside .versiondock/shelf/
  changelistAssignments?: Array<{ path: string; changelistId: string; changelistName: string }>;
}

// ─── Stash (native git stash) ────────────────────────────────────────────────

export interface StashEntry {
  ref: string;      // e.g. "stash@{0}"
  oid?: string;     // stable stash commit id; ref indices can change after push/drop
  index: number;    // 0, 1, 2...
  message: string;  // description
  fullMessage?: string; // complete description including the body
  date: string;     // ISO date
  branch: string;   // branch name
  files?: Array<{ path: string; status: string }>;
}

// ─── Push (unpushed commits) ─────────────────────────────────────────────────

export interface UnpushedCommit {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  fullMessage?: string;
  author: string;
  date: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

export interface PushCommitFile {
  path: string;
  status: string;
  added?: number;
  removed?: number;
}

export interface IncomingCommit {
  hash: string;
  shortHash: string;
  message: string;
  body?: string;
  fullMessage?: string;
  author: string;
  date: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
  potentialConflictPaths?: string[];
  parents?: string[];
}

export type SyncPullStrategy = 'default' | 'rebase' | 'merge' | 'ff-only';

export interface CommitGenerateMessageTarget {
  repoId: string;
  paths: string[];
}

export interface ComposerWorkingCandidate {
  repoId: string;
  paths: string[];
  stagedOnly: boolean;
}

// ─── Subtree (native git subtree) ────────────────────────────────────────────

export interface SubtreeEntry {
  id: string;
  repoId: string;
  name: string;
  prefix: string;
  repository: string;
  ref: string;
  defaultSquash: boolean;
  lastSplitBranch?: string;
}

export interface SubtreePushStatus {
  loading?: boolean;
  aheadCount?: number;
  hasUpdates?: boolean;
  remoteRef?: string;
  splitHash?: string;
  remoteHash?: string;
  error?: string;
}

export type SubtreeOp = 'add' | 'pull' | 'push' | 'split' | 'merge' | 'remove' | 'register' | 'edit' | 'delete';
export type CommitPanelTab = 'changes' | 'shelf' | 'stash' | 'push' | 'worktree' | 'subtree' | 'submodule' | 'sync';

// ─── Commit Panel: Host → WebView ────────────────────────────────────────────

export type HostToCommitMsg =
  | { type: 'COMMIT_STATUS_UPDATE'; repos: RepoMeta[]; status: WorkspaceStatus; iconTheme?: IconThemeData; fileViewMode?: 'flat' | 'tree'; defaultCommitAction?: 'commit' | 'commitAndPush'; defaultSaveAction?: 'stash' | 'shelve'; hasWorkspaceFolder?: boolean; noVerify?: boolean }
  | { type: 'COMMIT_ICON_THEME_UPDATE'; iconTheme: IconThemeData | null }
  | { type: 'COMMIT_DIFF_RESULT'; requestId: string; diff: FileDiff | null; error?: string }
  | { type: 'COMMIT_WORKTREE_DIFF_STARTED'; repoId: string; repoName: string; repoColor: string; baseRef: string; currentRef: string; files: FileStatus[] }
  | { type: 'COMMIT_WORKTREE_DIFF_FILES_RESULT'; requestId: string; repoId: string; baseRef: string; currentRef: string; files: FileStatus[]; error?: string }
  | { type: 'COMMIT_WORKTREE_DIFF_RESULT'; requestId: string; diff: FileDiff | null; error?: string }
  | { type: 'COMMIT_OP_RESULT'; requestId: string; ok: boolean; output?: string; error?: string; repoId?: string; committedRepoIds?: string[]; handled?: boolean }
  | { type: 'COMMIT_AMEND_RESET'; repoIds: string[] }
  | { type: 'COMMIT_BRANCHES_UPDATE'; repoId: string; branches: BranchInfo[] }
  | { type: 'COMMIT_REMOTES_RESULT'; requestId: string; remotes: string[]; error?: string }
  | { type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT'; requestId: string; message: string; error?: string; repoId?: string }
  | { type: 'COMMIT_MESSAGE_HISTORY_RESULT'; requestId: string; messages: string[] }
  | { type: 'COMMIT_GENERATE_MESSAGE_RESULT'; requestId: string; message?: string; error?: string; repoId?: string }
  | { type: 'SHELVE_LIST_RESULT'; requestId: string; repoId: string; shelves: ShelveEntry[]; error?: string }
  | { type: 'SHELVE_DIFF_RESULT'; requestId: string; repoId: string; shelveId: string; filePath: string; diff: string; error?: string }
  | { type: 'SHELVE_OP_RESULT'; requestId: string; repoId: string; op: 'push' | 'apply' | 'drop'; ok: boolean; error?: string; hasConflicts?: boolean; conflictFiles?: string[] }
  | { type: 'STASH_COUNT_RESULT'; requestId: string; repoId: string; count: number; error?: string }
  | { type: 'STASH_LIST_RESULT'; requestId: string; repoId: string; stashes: StashEntry[]; error?: string }
  | { type: 'STASH_FILES_RESULT'; requestId: string; repoId: string; stashRef: string; stashOid?: string; files: Array<{ path: string; status: string }>; error?: string }
  | { type: 'STASH_SHOW_RESULT'; requestId: string; diff: string; error?: string }
  | { type: 'STASH_OP_RESULT'; requestId: string; repoId: string; op: 'apply' | 'pop' | 'drop' | 'push'; ok: boolean; error?: string }
  | { type: 'PUSH_UNPUSHED_RESULT'; requestId?: string; repoId?: string; commits?: UnpushedCommit[]; repos?: Array<{ repoId: string; commits: UnpushedCommit[]; error?: string }>; error?: string }
  | { type: 'PUSH_SYNC_COUNTS_RESULT'; requestId?: string; counts: Record<string, { unpushed: number; incoming: number }> }
  | { type: 'PUSH_COMMITS_STATS_UPDATE'; repoId: string; stats: Record<string, { filesChanged: number; additions: number; deletions: number }>; kind?: 'outgoing' | 'incoming' }
  | { type: 'PUSH_COMMIT_FILES_RESULT'; requestId: string; repoId: string; hash: string; files: PushCommitFile[]; error?: string }
  | { type: 'PUSH_AGGREGATED_DIFF_RESULT'; requestId: string; repoId: string; files: PushCommitFile[]; error?: string }
  | { type: 'PUSH_SQUASH_RESULT'; requestId: string; repoId?: string; ok: boolean; error?: string }
  | { type: 'PUSH_DROP_RESULT'; requestId: string; repoId?: string; ok: boolean; error?: string }
  | { type: 'PUSH_REVERT_RESULT'; requestId: string; repoId?: string; ok: boolean; error?: string }
  | { type: 'PUSH_EDIT_MSG_RESULT'; requestId: string; repoId?: string; ok: boolean; error?: string }
  | { type: 'SYNC_INCOMING_RESULT'; requestId?: string; repoId?: string; commits?: IncomingCommit[]; repos?: Array<{ repoId: string; commits: IncomingCommit[]; error?: string }>; error?: string }
  | { type: 'SYNC_INCOMING_COMMIT_FILES_RESULT'; requestId: string; repoId: string; hash: string; files: PushCommitFile[]; error?: string }
  | { type: 'SYNC_INCOMING_AGGREGATED_DIFF_RESULT'; requestId: string; repoId: string; files: PushCommitFile[]; error?: string }
  | { type: 'SYNC_FETCH_RESULT'; requestId: string; repoId?: string; ok: boolean; error?: string; partial?: boolean }
  | { type: 'SYNC_PULL_RESULT'; requestId: string; repoId?: string; ok: boolean; error?: string }
  | { type: 'COMMIT_SET_MESSAGE'; message: string; requestId?: string }
  | { type: 'COMMIT_SET_ACTIVE_TAB'; tab: CommitPanelTab }
  | { type: 'COMMIT_TRIGGER_ACTION'; andPush: boolean }
  | { type: 'CHANGELISTS_UPDATE'; changelists: ChangelistData[]; viewMode: 'simplified' | 'changelists' | 'vscode' }
  | { type: 'SUBMODULE_OP_RESULT'; requestId: string; parentRepoId: string; submodulePath: string; op: 'init' | 'deinit' | 'update' | 'sync' | 'add' | 'remove' | 'update-all' | 'resolve-conflict'; ok: boolean; error?: string }
  | { type: 'SUBMODULE_LIST_RESULT'; repos: RepoSubmodules[]; error?: string }
  | { type: 'SUBMODULE_DIFF_SUMMARY_RESULT'; requestId: string; parentRepoId: string; submodulePath: string; oldHash?: string; newHash?: string; parentCommit?: string; indexCommit?: string; headCommit?: string; summary?: string; error?: string }
  | { type: 'SUBMODULE_PUSH_RESULT'; requestId: string; repoId: string; ok: boolean; error?: string }
  | { type: 'SUBMODULE_PULL_RESULT'; requestId: string; repoId: string; ok: boolean; output?: string; error?: string }
  | { type: 'WORKTREE_LIST_RESULT'; repos: Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }> }
  | { type: 'WORKTREE_OP_RESULT'; requestId: string; repoId: string; op: 'create' | 'delete' | 'prune' | 'lock' | 'unlock'; ok: boolean; error?: string }
  | { type: 'SUBTREE_LIST_RESULT'; entries: SubtreeEntry[]; error?: string }
  | { type: 'SUBTREE_STATUS_RESULT'; statuses: Record<string, SubtreePushStatus> }
  | { type: 'SUBTREE_OP_RESULT'; requestId: string; repoId: string; entryId?: string; op: SubtreeOp; ok: boolean; output?: string; error?: string }
  | { type: 'COMMIT_HIDDEN_REPOS_UPDATE'; hiddenRepoIds: string[] }
  | { type: 'COMMIT_REFRESH_START' }
  | { type: 'COMMIT_EXPAND_ALL' }
  | { type: 'COMMIT_COLLAPSE_ALL' }
  | { type: 'COMMIT_SELECT_ALL' }
  | { type: 'COMMIT_INVERT_SELECTION' }
  | { type: 'COMMIT_SET_FILE_VIEW_MODE'; mode: 'flat' | 'tree' }
  | { type: 'COMMIT_SWITCH_TAB'; tab: CommitPanelTab };

// ─── Commit Panel: WebView → Host ────────────────────────────────────────────

export type CommitToHostMsg =
  | { type: 'COMMIT_WEBVIEW_ERROR'; message: string; stack?: string; componentStack?: string }
  | { type: 'COMMIT_REQUEST_STATUS'; refreshSubtrees?: boolean }
  | { type: 'COMMIT_SELECTION_STATE_CHANGED'; isAllSelected: boolean; hasSelectable: boolean }
  | { type: 'COMMIT_ACTIVE_TAB_CHANGED'; tab: CommitPanelTab; viewMode?: 'flat' | 'tree'; expandMode?: 'expand' | 'collapse' }
  | { type: 'COMMIT_EXPAND_MODE_CHANGED'; expandMode: 'expand' | 'collapse' }
  | { type: 'COMMIT_REQUEST_DIFF'; requestId: string; repoId: string; filePath: string; staged: boolean }
  | { type: 'COMMIT_REQUEST_WORKTREE_DIFF_FILES'; requestId: string; repoId: string; baseRef: string }
  | { type: 'COMMIT_REQUEST_WORKTREE_DIFF'; requestId: string; repoId: string; baseRef: string; filePath: string }
  | { type: 'COMMIT_OPEN_WORKTREE_DIFF'; repoId: string; baseRef: string; filePath: string }
  | { type: 'COMMIT_STAGE_FILES'; requestId: string; repoId: string; paths: string[] }
  | { type: 'COMMIT_UNSTAGE_FILES'; requestId: string; repoId: string; paths: string[] }
  | { type: 'COMMIT_STAGE_ALL'; requestId: string; repoId: string }
  | { type: 'COMMIT_UNSTAGE_ALL'; requestId: string; repoId: string }
  | { type: 'COMMIT_STAGE_ALL_MULTI'; requestId: string; repoIds: string[] }
  | { type: 'COMMIT_UNSTAGE_ALL_MULTI'; requestId: string; repoIds: string[] }
  | { type: 'COMMIT_DO_COMMIT'; requestId: string; repoId: string; message: string; amend: boolean; noVerify?: boolean }
  | { type: 'COMMIT_DO_COMMIT_PUSH'; requestId: string; repoId: string; message: string; amend: boolean; noVerify?: boolean }
  | { type: 'COMMIT_DO_COMMIT_MULTI'; requestId: string; repos: Array<{ repoId: string; message: string; amend: boolean; filesToStage: string[]; filesToUnstage: string[] }>; andPush: boolean; noVerify?: boolean }
  | { type: 'COMMIT_DO_STASH_MULTI'; requestId: string; message: string; repos: Array<{ repoId: string; paths: string[] }> }
  | { type: 'COMMIT_DO_SHELVE_MULTI'; requestId: string; name: string; repos: Array<{ repoId: string; paths: string[] }> }
  | { type: 'COMMIT_GET_LAST_COMMIT_MESSAGE'; requestId: string; repoId: string }
  | { type: 'COMMIT_REQUEST_MESSAGE_HISTORY'; requestId: string; repoIds: string[]; limit?: number }
  | { type: 'COMMIT_PULL_ALL' }
  | { type: 'COMMIT_PULL_REPO'; requestId: string; repoId: string }
  | { type: 'COMMIT_GET_REMOTES'; requestId: string; repoId: string }
  | { type: 'COMMIT_PUSH_REPO'; requestId: string; repoId: string; remote?: string; force?: boolean }
  | { type: 'COMMIT_PUSH_MULTI'; requestId: string; targets: Array<{ repoId: string; remote?: string }>; force?: boolean }
  | { type: 'SYNC_PUSH_TAGS'; requestId: string; repoId: string; remote?: string }
  | { type: 'SYNC_PUSH_TAGS_MULTI'; requestId: string; repoIds: string[] }
  | { type: 'COMMIT_DISCARD_FILE'; requestId: string; repoId: string; path: string }
  | { type: 'COMMIT_DISCARD_FILES'; requestId: string; files: Array<{ repoId: string; path: string }> }
  | { type: 'COMMIT_OPEN_DIFF'; repoId: string; filePath: string; staged: boolean }
  | { type: 'COMMIT_SHOW_DIFF_TAB'; repoId: string; filePath: string }
  | { type: 'COMMIT_OPEN_FILE'; repoId: string; filePath: string }
  | { type: 'COMMIT_DELETE_FILE'; requestId: string; repoId: string; filePath: string }
  | { type: 'COMMIT_DELETE_FOLDER'; requestId: string; repoId: string; folderPath: string }
  | { type: 'COMMIT_ADD_TO_GITIGNORE'; repoId: string; entryPath: string }
  | { type: 'COMMIT_ADD_TO_SVN_IGNORE'; repoId: string; entryPath: string }
  | { type: 'COMMIT_MANAGE_SVN_IGNORE'; repoId: string }
  | { type: 'COMMIT_SHOW_BRANCH_MENU'; repoId?: string }
  | { type: 'COMMIT_OPEN_CONFLICTS' }
  | { type: 'COMMIT_ABORT_OPERATION'; requestId: string; repoIds: string[] }
  | { type: 'COMMIT_RESTORE_CONFLICTS'; requestId: string; repoIds: string[] }
  | { type: 'COMMIT_OPEN_MERGE_EDITOR'; repoId: string; filePath: string }
  | { type: 'COMMIT_ACCEPT_OURS'; requestId: string; repoId: string; filePath: string }
  | { type: 'COMMIT_ACCEPT_THEIRS'; requestId: string; repoId: string; filePath: string }
  | { type: 'COMMIT_GENERATE_MESSAGE'; requestId: string; repoIds?: string[]; targets?: CommitGenerateMessageTarget[] }
  | { type: 'COMMIT_CANCEL_GENERATE_MESSAGE'; requestId: string }
  | { type: 'COMMIT_OPEN_AI_COMPOSER'; candidates: ComposerWorkingCandidate[] }
  | { type: 'COMMIT_OPEN_AI_REVIEW'; candidates: CodeReviewCandidate[] }
  | { type: 'SHELVE_LIST'; requestId: string; repoId: string }
  | { type: 'SHELVE_PUSH'; requestId: string; repoId: string; name: string; paths?: string[] }
  | { type: 'SHELVE_APPLY'; requestId: string; repoId: string; shelveId: string; paths?: string[]; drop?: boolean }
  | { type: 'SHELVE_DROP'; requestId: string; repoId: string; shelveId: string }
  | { type: 'SHELVE_GET_FILE_DIFF'; requestId: string; repoId: string; shelveId: string; filePath: string }
  | { type: 'SHELVE_OPEN_FILE_DIFF'; repoId: string; shelveId: string; filePath: string }
  | { type: 'STASH_COUNT'; requestId: string; repoId: string }
  | { type: 'STASH_LIST'; requestId: string; repoId: string }
  | { type: 'STASH_GET_FILES'; requestId: string; repoId: string; stashRef: string; stashOid?: string }
  | { type: 'STASH_PUSH'; requestId: string; repoId: string; message: string; paths?: string[] }
  | { type: 'STASH_SHOW'; requestId: string; repoId: string; stashRef: string; filePath: string }
  | { type: 'STASH_APPLY'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_POP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_DROP'; requestId: string; repoId: string; stashRef: string }
  | { type: 'STASH_OPEN_FILE_DIFF'; repoId: string; stashRef: string; filePath: string }
  | { type: 'PUSH_GET_SYNC_COUNTS'; requestId: string; repoIds?: string[] }
  | { type: 'PUSH_GET_UNPUSHED'; requestId: string; repoId: string }
  | { type: 'PUSH_GET_COMMIT_FILES'; requestId: string; repoId: string; hash: string }
  | { type: 'PUSH_GET_AGGREGATED_DIFF'; requestId: string; repoId: string; oldestHash?: string }
  | { type: 'PUSH_OPEN_COMMIT_FILE_DIFF'; repoId: string; hash: string; filePath: string; fileStatus?: string }
  | { type: 'PUSH_OPEN_AGGREGATED_FILE_DIFF'; repoId: string; oldestHash?: string; filePath: string; fileStatus?: string }
  | { type: 'PUSH_SQUASH_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string; message: string; commits: { hash: string; shortHash: string; message: string }[] }
  | { type: 'PUSH_DROP_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string }
  | { type: 'PUSH_REVERT_COMMITS'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'PUSH_EDIT_COMMIT_MSG'; requestId: string; repoId: string; hash: string; currentMessage: string }
  | { type: 'SYNC_GET_INCOMING'; requestId: string; repoId: string }
  | { type: 'SYNC_GET_INCOMING_COMMIT_FILES'; requestId: string; repoId: string; hash: string }
  | { type: 'SYNC_GET_INCOMING_AGGREGATED_DIFF'; requestId: string; repoId: string; oldestHash?: string }
  | { type: 'SYNC_OPEN_INCOMING_COMMIT_FILE_DIFF'; repoId: string; hash: string; filePath: string; fileStatus?: string }
  | { type: 'SYNC_OPEN_INCOMING_AGGREGATED_FILE_DIFF'; repoId: string; oldestHash?: string; filePath: string; fileStatus?: string }
  | { type: 'SYNC_FETCH_REPO'; requestId: string; repoId: string }
  | { type: 'SYNC_FETCH_ALL'; requestId: string }
  | { type: 'SYNC_DO_PULL'; requestId: string; repoId: string; strategy?: SyncPullStrategy }
  | { type: 'SYNC_DO_PULL_MULTI'; requestId: string; repoIds: string[]; strategy?: SyncPullStrategy }
  | { type: 'SYNC_DO_SYNC'; requestId: string; repoId: string; strategy?: SyncPullStrategy; remote?: string }
  | { type: 'SYNC_DO_SYNC_MULTI'; requestId: string; repoIds: string[]; strategy?: SyncPullStrategy }
  | { type: 'SYNC_CHERRY_PICK'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'SYNC_CREATE_BRANCH_FROM_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'COMMIT_OPEN_ALL_CHANGES'; repoId: string; section?: 'staged' | 'unstaged' }
  | { type: 'COMMIT_OPEN_LOG'; hash: string; repoId: string }
  | { type: 'COMMIT_UNDO_COMMIT'; requestId: string; repoId: string }
  | { type: 'CHANGELISTS_CREATE'; name: string }
  | { type: 'CHANGELISTS_CREATE_PROMPT' }
  | { type: 'CHANGELISTS_RENAME'; id: string; name: string }
  | { type: 'CHANGELISTS_RENAME_PROMPT'; id: string; currentName: string }
  | { type: 'CHANGELISTS_DELETE'; id: string }
  | { type: 'CHANGELISTS_MOVE_FILES'; assignments: Array<{ repoId: string; path: string; changelistId: string }> }
  | { type: 'CHANGELISTS_MOVE_FILES_PROMPT'; files: Array<{ repoId: string; path: string }> }
  | { type: 'CHANGELISTS_SHELVE'; changelistId: string; requestId: string }
  | { type: 'CHANGELISTS_STASH'; changelistId: string; requestId: string }
  | { type: 'COMMIT_SET_FILE_VIEW_MODE'; mode: 'flat' | 'tree' }
  | { type: 'SUBMODULE_REQUEST_LIST' }
  | { type: 'SUBMODULE_INIT'; requestId: string; parentRepoId: string; submodulePath: string }
  | { type: 'SUBMODULE_DEINIT'; requestId: string; parentRepoId: string; submodulePath: string; force?: boolean }
  | { type: 'SUBMODULE_UPDATE'; requestId: string; parentRepoId: string; submodulePath: string; recursive?: boolean; remote?: boolean }
  | { type: 'SUBMODULE_UPDATE_ALL'; recursive?: boolean; parentRepoId?: string; init?: boolean }
  | { type: 'SUBMODULE_ADD_PROMPT'; repoId?: string }
  | { type: 'SUBMODULE_SYNC'; requestId: string; parentRepoId: string; submodulePath?: string }
  | { type: 'SUBMODULE_REMOVE'; requestId: string; parentRepoId: string; submodulePath: string }
  | { type: 'SUBMODULE_RESOLVE_CONFLICT'; requestId: string; parentRepoId: string; submodulePath: string; side: 'ours' | 'theirs' }
  | { type: 'SUBMODULE_GET_DIFF_SUMMARY'; requestId: string; parentRepoId: string; submodulePath: string }
  | { type: 'SUBMODULE_PUSH'; requestId: string; repoId: string }
  | { type: 'SUBMODULE_PULL'; requestId: string; repoId: string; rebase?: boolean }
  | { type: 'SUBMODULE_OPEN_CONFLICT'; parentRepoId: string; submodulePath: string; companionPath?: string }
  | { type: 'NOTIFY_ERROR'; message: string; repoId?: string }
  | { type: 'NOTIFY_INFO'; message: string; repoId?: string }
  | { type: 'COMMIT_REVEAL_IN_EXPLORER'; repoId: string; filePath: string }
  | { type: 'COMMIT_REVEAL_IN_OS'; repoId: string; filePath: string }
  | { type: 'WORKTREE_REQUEST_LIST' }
  | { type: 'WORKTREE_CREATE_PROMPT'; repoId: string }
  | { type: 'WORKTREE_CREATE'; requestId: string; repoId: string; worktreePath: string; branch?: string; newBranch?: string; commitish?: string; noTrack?: boolean }
  | { type: 'WORKTREE_DELETE'; requestId: string; repoId: string; worktreePath: string; force?: boolean }
  | { type: 'WORKTREE_PRUNE'; requestId: string; repoId: string }
  | { type: 'WORKTREE_LOCK'; requestId: string; repoId: string; worktreePath: string; reason?: string }
  | { type: 'WORKTREE_UNLOCK'; requestId: string; repoId: string; worktreePath: string }
  | { type: 'WORKTREE_OPEN_IN_EXPLORER'; repoId: string; worktreePath: string }
  | { type: 'WORKTREE_OPEN_IN_NEW_WINDOW'; worktreePath: string }
  | { type: 'WORKTREE_OPEN_IN_OS'; worktreePath: string }
  | { type: 'WORKTREE_ADD_TO_WORKSPACE'; worktreePath: string }
  | { type: 'SUBTREE_REQUEST_LIST'; checkStatuses?: boolean; force?: boolean }
  | { type: 'SUBTREE_ADD_PROMPT'; repoId?: string }
  | { type: 'SUBTREE_REGISTER_PROMPT'; repoId?: string }
  | { type: 'SUBTREE_EDIT_PROMPT'; entryId: string }
  | { type: 'SUBTREE_DELETE_REGISTRY'; requestId: string; entryId: string }
  | { type: 'SUBTREE_PULL'; requestId: string; entryId: string }
  | { type: 'SUBTREE_PUSH'; requestId: string; entryId: string }
  | { type: 'SUBTREE_SPLIT_PROMPT'; requestId: string; entryId: string }
  | { type: 'SUBTREE_MERGE_PROMPT'; requestId: string; entryId: string }
  | { type: 'SUBTREE_REMOVE'; requestId: string; entryId: string }
  | { type: 'SUBTREE_REVEAL_PREFIX'; entryId: string }
  | { type: 'COMMIT_INIT_REPO' }
  | { type: 'COMMIT_OPEN_FOLDER' }
  | { type: 'COMMIT_CLONE_REPO' }
  | { type: 'COMMIT_HIDE_REPO'; repoId: string }
  | { type: 'COMMIT_UNHIDE_REPO'; repoId: string }
  | { type: 'COMMIT_MANAGE_HIDDEN_REPOS' }
  | { type: 'COMMIT_MANAGE_REPO'; repoId: string }
  | { type: 'COMMIT_VIEW_GIT_LOG'; repoId: string };

// ─── Git Log: Host → WebView ─────────────────────────────────────────────────

export type { IconThemeData };

export interface TagInfo {
  name: string;
  hash: string;
  date: string;
  repoId: string;
}

export interface LogCommitPathEntry {
  repoId: string;
  hash: string;
  path: string;
  status?: string;
}

export type CompareSide = 'baseOnly' | 'targetOnly';

export type HostToLogMsg =
  | { type: 'LOG_INIT_DATA'; repos: RepoMeta[]; branches: BranchInfo[]; iconTheme?: IconThemeData; hasWorkspaceFolder?: boolean }
  | { type: 'LOG_ICON_THEME_UPDATE'; iconTheme: IconThemeData | null }
  | { type: 'LOG_APPLY_HISTORY_FILTER'; repoId: string; filePath: string; lineRange?: LineRange }
  | { type: 'LOG_COMMITS_BATCH'; commits: CommitNode[]; isLast: boolean; batchIndex: number; generation?: number; requestId?: string; repoErrors?: Array<{ repoId: string; error: string }> }
  | { type: 'LOG_GRAPH_COMMITS'; commits: GraphCommitNode[]; generation: number; requestId: string }
  | { type: 'LOG_DIFF_RESULT'; requestId: string; files: Array<{ path: string; status: string }>; diff: FileDiff | null; error?: string }
  | { type: 'LOG_COMMIT_FILES'; requestId: string; files: Array<{ path: string; status: string; added?: number; removed?: number }>; mergeParentChanges?: MergeParentChange[]; error?: string }
  | { type: 'LOG_BRANCH_OP_RESULT'; requestId: string; ok: boolean; output?: string; error?: string }
  | { type: 'LOG_REFS_UPDATE'; repoId: string; branches: BranchInfo[] }
  | { type: 'LOG_TAGS_UPDATE'; repoId: string; tags: TagInfo[] }
  | { type: 'LOG_COMMIT_TAGS_RESULT'; requestId: string; tags: string[] }
  | { type: 'LOG_REMOTES_RESULT'; requestId: string; remotes: string[]; error?: string }
  | { type: 'LOG_REFRESH' }
  | { type: 'LOG_MERGE_COMMITS_RESULT'; requestId: string; commits: MergeParentCommit[]; error?: string }
  | { type: 'LOG_MERGE_PARENT_FILES_RESULT'; requestId: string; files: Array<{ path: string; status: string; added?: number; removed?: number }>; error?: string }
  | { type: 'LOG_FILE_OP_RESULT'; requestId: string; ok: boolean; error?: string }
  | { type: 'LOG_COMMIT_BRANCHES_RESULT'; requestId: string; branches: { local: string[]; remote: string[]; tags: string[] } }
  | { type: 'LOG_SCROLL_TO_COMMIT'; hash: string; repoId: string }
  | { type: 'LOG_COMMIT_MESSAGE_RESULT'; requestId: string; fullMessage: string; error?: string }
  | { type: 'LOG_COMPARE_STARTED'; repoId: string; repoName: string; baseRef: string; targetRef: string }
  | { type: 'LOG_COMPARE_COMMITS_RESULT'; requestId: string; side: CompareSide; commits: CommitNode[]; isLast: boolean; error?: string }
  | { type: 'LOG_FILTER_BY_REPO'; repoId: string | null; branch?: string | null }
  | { type: 'LOG_DIFF_OPENED'; repoId: string; filePath: string; error?: string };

// ─── Git Log: WebView → Host ─────────────────────────────────────────────────

export type LogToHostMsg =
  | { type: 'LOG_REQUEST_COMMITS'; repoIds: string[] | null; limit: number; skip: number; generation?: number; requestId?: string; filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; filterPath?: string; lineRange?: LineRange }
  | { type: 'LOG_REQUEST_GRAPH_COMMITS'; repoIds: string[] | null; generation: number; requestId: string }
  | { type: 'LOG_REQUEST_COMMIT_FILES'; requestId: string; repoId: string; hash: string; parents?: string[]; includeMergeParentChanges?: boolean; prefetchContent?: boolean }
  | { type: 'LOG_REQUEST_FILE_DIFF'; requestId: string; repoId: string; hash: string; filePath: string }
  | { type: 'LOG_OPEN_FILE_DIFF'; repoId: string; hash: string; filePath: string; fileStatus?: string; lineRange?: LineRange }
  | { type: 'LOG_OPEN_FILE_RANGE_DIFF'; repoId: string; fromHash: string; toHash: string; filePath: string; lineRange?: LineRange }
  | { type: 'LOG_OPEN_FILE'; repoId: string; filePath: string; lineRange?: LineRange }
  | { type: 'LOG_REVERT_FILE'; requestId: string; repoId: string; hash: string; filePath: string; fileStatus?: string }
  | { type: 'LOG_APPLY_COMMIT_PATHS'; requestId: string; repoId: string; entries: LogCommitPathEntry[] }
  | { type: 'LOG_RESTORE_COMMIT_PATHS'; requestId: string; repoId: string; entries: LogCommitPathEntry[] }
  | { type: 'LOG_CHECKOUT'; requestId: string; repoId: string; branchName: string; createNew?: boolean; from?: string }
  | { type: 'LOG_PULL'; requestId: string; repoId: string; branchName?: string }
  | { type: 'LOG_PUSH'; requestId: string; repoId: string; remote?: string; force?: boolean }
  | { type: 'LOG_MERGE'; requestId: string; repoId: string; from: string }
  | { type: 'LOG_REBASE'; requestId: string; repoId: string; onto: string }
  | { type: 'LOG_COMPARE_WITH_CURRENT'; branches: Array<{ repoId: string; branchName: string }> }
  | { type: 'LOG_SHOW_WORKTREE_DIFF'; branches: Array<{ repoId: string; branchName: string }> }
  | { type: 'LOG_REQUEST_COMPARE_COMMITS'; requestId: string; repoId: string; baseRef: string; targetRef: string; side: CompareSide; limit: number; skip: number; filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; filterPath?: string }
  | { type: 'LOG_DELETE_BRANCH'; requestId: string; repoId: string; branchName: string; force: boolean }
  | { type: 'LOG_DELETE_BRANCH_MULTI'; requestId: string; repoIds: string[]; branchName: string }
  | { type: 'LOG_FETCH_ALL' }
  | { type: 'LOG_FETCH_REPO'; requestId: string; repoId: string }
  | { type: 'LOG_GET_REMOTES'; requestId: string; repoId: string }
  | { type: 'LOG_CHERRY_PICK'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REVERT_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_RESET_TO'; requestId: string; repoId: string; hash: string; mode: 'soft' | 'mixed' | 'hard' }
  | { type: 'LOG_CREATE_PATCH'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REQUEST_MERGE_COMMITS'; requestId: string; repoId: string; hash: string; parents: string[] }
  | { type: 'LOG_REQUEST_MERGE_PARENT_FILES'; requestId: string; repoId: string; hash: string; parentHash: string }
  | { type: 'LOG_DROP_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_SQUASH_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string; message: string; commits: { hash: string; shortHash: string; message: string }[] }
  | { type: 'LOG_OPEN_AI_COMPOSER'; repoId: string; hashes: string[] }
  | { type: 'LOG_CHERRY_PICK_MULTI'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_REVERT_COMMITS'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_DROP_COMMITS'; requestId: string; repoId: string; hashes: string[]; oldestHash: string }
  | { type: 'LOG_CREATE_PATCH_MULTI'; requestId: string; repoId: string; hashes: string[] }
  | { type: 'LOG_UNDO_COMMIT'; requestId: string; repoId: string }
  | { type: 'LOG_EDIT_COMMIT_MESSAGE'; requestId: string; repoId: string; hash: string; currentMessage: string }
  | { type: 'LOG_NEW_BRANCH_FROM_COMMIT'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_CREATE_TAG'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_DELETE_TAG'; requestId: string; repoId: string; tagName: string }
  | { type: 'LOG_DELETE_TAG_MULTI'; requestId: string; repoIds: string[]; tagName: string }
  | { type: 'LOG_PUSH_TAG'; requestId: string; repoId: string; tagName: string; remote: string }
  | { type: 'LOG_CHECKOUT_TAG'; requestId: string; repoId: string; tagName: string }
  | { type: 'LOG_MERGE_TAG'; requestId: string; repoId: string; tagName: string }
  | { type: 'LOG_MERGE_TAG_MULTI'; requestId: string; repoIds: string[]; tagName: string }
  | { type: 'LOG_REQUEST_COMMIT_TAGS'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REQUEST_TAGS'; repoId: string }
  | { type: 'LOG_MANAGE_COMMIT_TAGS'; repoId: string; hash: string; currentBranch: string }
  | { type: 'LOG_RESET_TO_PICK'; repoId: string; hash: string }
  | { type: 'LOG_PUSH_PICK'; repoId: string }
  | { type: 'LOG_PUSH_TAG_PICK'; repoId: string; tagName: string }
  | { type: 'LOG_REQUEST_COMMIT_BRANCHES'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_REQUEST_COMMIT_MESSAGE'; requestId: string; repoId: string; hash: string }
  | { type: 'LOG_SHOW_BRANCH_OPTIONS'; repoId: string; branchName: string }
  | { type: 'LOG_CHECKOUT_COMMIT'; requestId: string; repoId: string; hash: string; branchName?: string }
  | { type: 'LOG_REVEAL_IN_EXPLORER'; repoId: string; filePath: string }
  | { type: 'LOG_REVEAL_IN_OS'; repoId: string; filePath: string }
  | { type: 'LOG_INIT_REPO' }
  | { type: 'LOG_OPEN_FOLDER' }
  | { type: 'LOG_CLONE_REPO' }
  | {
      type: 'LOG_OPEN_EXTENDED_DETAIL';
      repoId: string;
      hash: string;
      initialCommit?: {
        message?: string;
        authorName?: string;
        authorEmail?: string;
        authorDate?: string;
        committerDate?: string;
        parents?: string[];
      };
      initialFiles?: Array<{ path: string; status: string; added?: number; removed?: number }>;
      initialMergeParentChanges?: MergeParentChange[];
    }
  | {
      type: 'LOG_OPEN_EXTENDED_DETAIL_MULTI';
      commits: Array<{
        repoId: string;
        hash: string;
        message?: string;
        authorName?: string;
        authorEmail?: string;
        authorDate?: string;
        committerDate?: string;
        parents?: string[];
        files?: Array<{ path: string; status: string; added?: number; removed?: number }>;
      }>;
    }
  | { type: 'LOG_OPEN_AI_EXPLANATION'; repoId: string; hash: string }
  | { type: 'LOG_OPEN_AI_EXPLANATION_MULTI'; commits: Array<{ repoId: string; hash: string }> }
  | { type: 'LOG_OPEN_COMMIT_CHANGES'; repoId: string; hash: string; files?: Array<{ path: string; status: string; added?: number; removed?: number }> }
  | { type: 'LOG_OPEN_COMMIT_CHANGES_MULTI'; groups: Array<{ repoId: string; fromHash?: string; toHash: string; files: Array<string | { path: string; status?: string }> }> }
  | { type: 'LOG_WEBVIEW_ERROR'; message: string; stack?: string; componentStack?: string }
  | { type: 'LOG_UNDOCK'; target: 'editorTab' | 'newWindow' | 'pick' };

// ─── Merge Editor: Host → WebView ────────────────────────────────────────────

export type HostToMergeMsg =
  | { type: 'MERGE_FILE_LOADED'; file: MergeConflictFile; iconTheme?: IconThemeData }
  | { type: 'MERGE_FILE_LOAD_FAILED'; error: string }
  | { type: 'MERGE_FILE_VERSIONS_LOADED'; requestId: string; versions?: { base: string; ours: string; theirs: string; language: string }; error?: string }
  | { type: 'MERGE_AI_RESOLVE_RESULT'; requestId: string; resolutions?: Array<{ index: number; lines: string[] }>; provider?: string; model?: string; promptSource?: 'workspace' | 'global' | 'builtin'; error?: string }
  | { type: 'MERGE_SAVE_RESULT'; requestId: string; ok: boolean; error?: string };

// ─── Merge Editor: WebView → Host ────────────────────────────────────────────

export type MergeToHostMsg =
  | { type: 'MERGE_READY' }
  | { type: 'MERGE_WEBVIEW_ERROR'; message: string; stack?: string; componentStack?: string }
  | { type: 'MERGE_REQUEST_FILE_VERSIONS'; requestId: string }
  | { type: 'MERGE_AI_RESOLVE'; requestId: string; conflictIndexes: number[] }
  | { type: 'MERGE_AI_CANCEL'; requestId: string }
  | { type: 'MERGE_SAVE_FILE'; requestId: string; resolvedContent: string; deleteFile?: boolean }
  | { type: 'MERGE_ACCEPT_OURS'; requestId: string }
  | { type: 'MERGE_ACCEPT_THEIRS'; requestId: string }
  | { type: 'MERGE_OPEN_FILE'; filePath: string }
  | { type: 'MERGE_CLOSE' };

// ─── AI Commit Composer ──────────────────────────────────────────────────────

export type HostToComposerMsg =
  | { type: 'COMPOSER_PHASE'; phase: 'scanning' | 'analyzing' | 'validating' | 'applying'; detail?: string }
  | { type: 'COMPOSER_SOURCE'; source: ComposerPreparedSource }
  | { type: 'COMPOSER_PLAN'; groups: ComposerCommitGroup[]; provider: string; model?: string; promptSource: 'workspace' | 'global' | 'builtin' }
  | { type: 'COMPOSER_MESSAGE_UPDATE'; requestId: string; groupId: string; message: string }
  | { type: 'COMPOSER_MESSAGE_RESULT'; requestId: string; groupId: string; message?: string; error?: string }
  | { type: 'COMPOSER_ERROR'; error: string }
  | { type: 'COMPOSER_APPLY_PROGRESS'; completed: number; total: number; message: string }
  | { type: 'COMPOSER_APPLY_RESULT'; result: ComposerApplyResult };

export type ComposerToHostMsg =
  | { type: 'COMPOSER_READY' }
  | { type: 'COMPOSER_REANALYZE' }
  | { type: 'COMPOSER_CANCEL' }
  | { type: 'COMPOSER_GENERATE_MESSAGE'; requestId: string; groupId: string; unitIds: string[] }
  | { type: 'COMPOSER_CANCEL_MESSAGE'; requestId: string }
  | { type: 'COMPOSER_APPLY'; groups: ComposerCommitGroup[] }
  | { type: 'COMPOSER_CLOSE' }
  | { type: 'COMPOSER_WEBVIEW_ERROR'; message: string; stack?: string };

// ─── AI Code Review ─────────────────────────────────────────────────────────

export type CodeReviewPhase = 'scanning' | 'analyzing' | 'validating' | 'completed' | 'error';

export type HostToCodeReviewMsg =
  | { type: 'CODE_REVIEW_PHASE'; phase: CodeReviewPhase; detail: string; fileCount?: number; repositoryCount?: number; truncated?: boolean; streamCharCount?: number }
  | { type: 'CODE_REVIEW_RESULT'; report: CodeReviewReport; provider: string; model?: string; promptSource: 'workspace' | 'global' | 'builtin'; durationMs: number; truncated: boolean }
  | { type: 'CODE_REVIEW_CANCELLED' }
  | { type: 'CODE_REVIEW_ERROR'; error: string }
  | { type: 'CODE_REVIEW_STALE'; finding: CodeReviewFinding };

export type CodeReviewToHostMsg =
  | { type: 'CODE_REVIEW_READY' }
  | { type: 'CODE_REVIEW_RERUN' }
  | { type: 'CODE_REVIEW_CANCEL' }
  | { type: 'CODE_REVIEW_OPEN_DIFF'; finding: CodeReviewFinding }
  | { type: 'CODE_REVIEW_WEBVIEW_ERROR'; message: string; stack?: string };

// ─── Conflicts: Host → WebView ─────────────────────────────────────────────

export interface ConflictListFile {
  repoId: string;
  repoName: string;
  repoColor: string;
  path: string;
  absolutePath: string;
  currentStatus: 'modified' | 'added' | 'deleted';
  incomingStatus: 'modified' | 'added' | 'deleted';
  nodeKind?: ConflictNodeKind;
  conflictType?: ConflictType;
  conflictTypes?: ConflictType[];
  propertyConflicts?: ConflictPropertyValue[];
}

export type HostToConflictsMsg =
  | { type: 'CONFLICTS_DATA'; files: ConflictListFile[]; isMerging: boolean; operationLabel: string; iconTheme?: IconThemeData }
  | { type: 'CONFLICTS_OP_RESULT'; requestId: string; ok: boolean; error?: string };

// ─── Conflicts: WebView → Host ─────────────────────────────────────────────

export type ConflictsToHostMsg =
  | { type: 'CONFLICTS_REQUEST_DATA' }
  | { type: 'CONFLICTS_WEBVIEW_ERROR'; message: string; stack?: string; componentStack?: string }
  | { type: 'CONFLICTS_OPEN_MERGE_EDITOR'; repoId: string; filePath: string }
  | { type: 'CONFLICTS_ACCEPT_OURS'; requestId: string; files: Array<{ repoId: string; path: string }> }
  | { type: 'CONFLICTS_ACCEPT_THEIRS'; requestId: string; files: Array<{ repoId: string; path: string }> };
