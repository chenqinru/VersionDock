import type * as vscode from 'vscode';
import type { AiProvider } from '../ai/types';

export type AiCommitExplanationMode = 'single' | 'aggregate';
export type AiCommitExplanationPromptSource = 'workspace' | 'global' | 'builtin';

export interface CommitExplanationFile {
  path: string;
  status: string;
  added?: number;
  removed?: number;
}

export interface CommitExplanationCommit {
  repoId: string;
  repoName: string;
  repoRootPath: string;
  vcsKind: 'git' | 'svn';
  hash: string;
  shortHash: string;
  fullMessage: string;
  authorName: string;
  authorDate: string;
  files: CommitExplanationFile[];
}

export interface AiCommitExplanationContext {
  mode: AiCommitExplanationMode;
  text: string;
  repoRootPaths: string[];
  vcsKinds: Array<'git' | 'svn'>;
  repositoryCount: number;
  commitCount: number;
  fileCount: number;
  contextCharCount: number;
  truncated: boolean;
}

export interface AiCommitExplanationGenerateOptions {
  context: AiCommitExplanationContext;
  cancellationToken: vscode.CancellationToken;
  onDelta: (delta: string) => void;
}

export interface AiCommitExplanationGenerateResult {
  explanation: string;
  provider: AiProvider;
  model?: string;
  promptSource: AiCommitExplanationPromptSource;
  inputCharCount: number;
  inputTokenCount?: number;
  inputTokenBudget?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  inputTruncated: boolean;
  streamed: boolean;
  streamChunkCount: number;
  streamCharCount: number;
  firstTokenLatencyMs?: number;
  durationMs: number;
}
