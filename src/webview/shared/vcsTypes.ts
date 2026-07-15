import type { BranchInfo, CommitNode, FileDiff, FileStatus, RepoMeta, RepoStatus } from './types';

export type VcsKind = 'git' | 'svn';

export interface VcsRepoMeta extends RepoMeta {
  kind: VcsKind;
}

export interface VcsRepoStatus extends RepoStatus {
  kind?: VcsKind;
}

export interface VcsFileStatus extends FileStatus {
  kind?: VcsKind;
}

export interface VcsCommitNode extends CommitNode {
  kind?: VcsKind;
}

export type VcsFileDiff = FileDiff;
export type VcsBranchInfo = BranchInfo;
