export type GitUpdateSnapshot = {
  kind: 'git';
  repoId: string;
  branchName: string;
  beforeHeadHash?: string;
  upstreamRef?: string;
};

export type SvnUpdateSnapshot = {
  kind: 'svn';
  repoId: string;
  branchName: string;
  workingCopyUrl: string;
  beforeRevision?: number;
  incomingHashes: string[];
};

export type VcsUpdateSnapshot = GitUpdateSnapshot | SvnUpdateSnapshot;

export type UpdateCommitSelection = {
  repoId: string;
  hash: string;
  message?: string;
  authorName?: string;
  authorEmail?: string;
  authorDate?: string;
  committerDate?: string;
  parents?: string[];
  files?: Array<{ path: string; status: string; added?: number; removed?: number }>;
};
