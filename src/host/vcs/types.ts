import type { BranchInfo, CommitNode, FileDiff, FileStatus, GraphCommitNode, RepoMeta, RepoStatus } from '../types/git';

export type VcsKind = 'git' | 'svn';

export interface VcsRepoMeta extends RepoMeta {
  kind: VcsKind;
  remoteUrl?: string;
  relativeUrl?: string;
}

export interface VcsRepoStatus extends RepoStatus {
  kind?: VcsKind;
}

export interface VcsFileStatus extends FileStatus {
  kind?: VcsKind;
  locked?: boolean;
  copied?: boolean;
}

export interface VcsCommitNode extends CommitNode {
  kind?: VcsKind;
}

export interface VcsProvider {
  readonly kind: VcsKind;
  readonly repoId: string;
  readonly rootPath: string;

  getStatus(): Promise<RepoStatus>;
  getStatusFresh(): Promise<RepoStatus>;
  getCurrentBranch(): Promise<BranchInfo>;
  getBranches(): Promise<BranchInfo[]>;
  getGraphLog(limit: number): Promise<GraphCommitNode[]>;
  getLog(limit: number, skip: number, opts?: Record<string, unknown>): Promise<CommitNode[]>;
  getCommitFiles(hash: string): Promise<Array<{ path: string; status: string; added?: number; removed?: number }>>;
  getFileDiff(repoId: string, hash: string, filePath: string): Promise<FileDiff | null>;
}
