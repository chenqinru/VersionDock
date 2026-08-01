import type * as vscode from 'vscode';

export type ComposerMode = 'working' | 'history';
export type ComposerUnitKind = 'hunk' | 'file';

export interface ComposerChangeUnit {
  id: string;
  filePath: string;
  oldPath?: string;
  kind: ComposerUnitKind;
  status: string;
  title: string;
  diff: string;
  language: string;
  added: number;
  removed: number;
  atomic: boolean;
}

export interface ComposerCommitGroup {
  id: string;
  message: string;
  rationale: string;
  unitIds: string[];
}

export interface ComposerPreparedSource {
  sessionId: string;
  mode: ComposerMode;
  repoId: string;
  repoName: string;
  vcsKind: 'git' | 'svn';
  branch: string;
  sourceLabel: string;
  units: ComposerChangeUnit[];
  originalCommitCount?: number;
}

export interface ComposerAnalysisResult {
  groups: ComposerCommitGroup[];
  provider: string;
  model?: string;
  promptSource: 'workspace' | 'global' | 'builtin';
  maxOutputTokens?: number;
}

export interface ComposerAnalyzeOptions {
  source: ComposerPreparedSource;
  cancellationToken: vscode.CancellationToken;
}

export interface ComposerApplyResult {
  commitCount: number;
  commitHashes: string[];
  backupRef?: string;
  recoveryCommand?: string;
  completedGroups?: number;
}
