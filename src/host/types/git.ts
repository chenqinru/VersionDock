export interface RepoMeta {
  id: string;              // stable repo instance id: "<rootPath>::<kind>"
  name: string;
  rootPath: string;
  color: string;
  kind?: 'git' | 'svn';
  remoteUrl?: string;
  relativeUrl?: string;
  isSubmodule?: boolean;
  parentRepoId?: string;
  submodulePath?: string;  // path relative to the parent repo for submodules or nested VCS roots
  depth?: number;          // 0 = top-level repo, 1 = direct child repo/submodule, 2 = nested child
  isWorktree?: boolean;    // true when this workspace folder is a linked git worktree
  mainWorktreePath?: string; // rootPath of the main worktree repo
}

export type SubmoduleSyncStatus = 'synced' | 'out-of-sync' | 'uninitialized' | 'conflict';

export interface SubmoduleEntry {
  name: string;
  path: string;       // path relative to parent repo
  url: string;
  repoId: string;     // stable git repo instance id for the submodule
  initialized: boolean;
  headCommit?: string;
  recordedCommit?: string;
  indexCommit?: string;
  branch?: string;
  syncStatus?: SubmoduleSyncStatus;
  conflictStages?: {
    base?: string;
    ours?: string;
    theirs?: string;
  };
  isDetached?: boolean;
  currentBranch?: string;
  isDirty: boolean;
  unpushedCount?: number;
  isTypeChange?: boolean;
  companionPath?: string;
}

export interface SubmoduleItem extends SubmoduleEntry {
  absPath: string;
  parentRepoId: string;
  syncStatus: SubmoduleSyncStatus;
}

export interface RepoSubmodules {
  repoId: string;
  repoName: string;
  repoColor: string;
  submodules: SubmoduleItem[];
}

export interface BranchInfo {
  repoId: string;
  name: string;
  fullName: string;
  isHead: boolean;
  isRemote: boolean;
  remoteName?: string;
  upstream?: string;
  aheadBehind?: { ahead: number; behind: number };
  lastCommitHash?: string;
  lastCommitDate?: string;
  detachedTag?: string;   // set when HEAD is detached on a tag
  detachedHash?: string;  // short commit hash when HEAD is detached without a tag
  isProtected?: boolean;  // true if branch matches protected branch patterns
  isGone?: boolean;       // true if upstream tracking branch was deleted on remote
}

export interface LineRange {
  start: number;
  end: number;
}

export interface GraphCommitNode {
  hash: string;
  repoId: string;
  committerDate: string;
  parents: string[];
  refs: string[];
}

export interface CommitNode extends GraphCommitNode {
  shortHash: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  unpushed?: boolean;
  incoming?: boolean;
  lane?: number;
  totalLanes?: number;
  graphLines?: GraphLine[];
}

export type CommitLogList = CommitNode[] & {
  hasMore?: boolean;
  repoErrors?: Array<{ repoId: string; error: string }>;
};

export interface GraphLine {
  fromLane: number;
  toLane: number;
  type: 'join-in' | 'fork-out' | 'pass-through' | 'collapsed-out' | 'collapsed-in';
  repoId: string;
  color?: string;
}

export type GitFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'submodule';

export type ConflictNodeKind = 'file' | 'directory';
export type ConflictType = 'text' | 'property' | 'tree' | 'unknown';

export interface ConflictPropertyValue {
  name: string;
  currentValue?: string;
  incomingValue?: string;
}

export interface ConflictFileStatus {
  currentStatus: 'modified' | 'added' | 'deleted';
  incomingStatus: 'modified' | 'added' | 'deleted';
  nodeKind?: ConflictNodeKind;
  conflictType?: ConflictType;
  conflictTypes?: ConflictType[];
  propertyConflicts?: ConflictPropertyValue[];
}

export interface SubmoduleStatus {
  isSubmodule: boolean;
  hasGitlinkChange: boolean;
  hasTrackedChanges: boolean;
  hasUntrackedChanges: boolean;
}

export interface FileStatus {
  repoId: string;
  path: string;
  absolutePath: string;
  oldPath?: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  added?: number;
  removed?: number;
  submodule?: SubmoduleStatus;
  isTruncated?: boolean;
  truncationReason?: 'entry-limit' | 'depth-limit';
}

export interface DiffLine {
  type: 'context' | 'add' | 'remove';
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface FileDiff {
  repoId: string;
  oldPath: string;
  newPath: string;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
  hunks: DiffHunk[];
  originalContent?: string;
  modifiedContent?: string;
  language?: string;
}

export interface ConflictBlock {
  index: number;
  oursLabel: string;
  theirsLabel: string;
  oursLines: string[];
  baseLines: string[];
  theirsLines: string[];
  startLine: number;
  endLine: number;
}

export interface MergeConflictFile {
  absolutePath: string;
  relativePath: string;
  repoId: string;
  conflicts: ConflictBlock[];
  oursLabel: string;
  theirsLabel: string;
  content: string;
  oursStatus?: 'modified' | 'added' | 'deleted';
  theirsStatus?: 'modified' | 'added' | 'deleted';
  baseContent?: string;
  oursContent?: string;
  theirsContent?: string;
  language?: string;
}

export interface MergeFileVersions {
  base: string;
  ours: string;
  theirs: string;
  language: string;
}

export interface WorkspaceStatus {
  repos: RepoStatus[];
}

// ─── Changelists ─────────────────────────────────────────────────────────────

export interface ChangelistFileAssignment {
  repoId: string;
  path: string;
}

export interface ChangelistData {
  id: string;
  name: string;
  color?: string;
  // repoId → file paths belonging to this changelist
  fileAssignments: Record<string, string[]>;
}

export const CHANGELIST_DEFAULT_ID = 'default';
export const CHANGELIST_UNVERSIONED_ID = 'unversioned';

export interface RepoStatus {
  repoId: string;
  branch: BranchInfo;
  stagedFiles: FileStatus[];
  unstagedFiles: FileStatus[];
  isDetachedHead: boolean;
  conflictCount: number;
  operationState: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
}
