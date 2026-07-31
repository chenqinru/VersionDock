import type * as vscode from 'vscode';
import type { AiProvider } from '../ai/types';
import type { MergeConflictFile } from '../types/git';

export type AiMergePromptSource = 'workspace' | 'global' | 'builtin';

export interface AiMergeConflictResolution {
  index: number;
  lines: string[];
}

export interface AiMergeConflictGenerateOptions {
  file: MergeConflictFile;
  conflictIndexes: number[];
  repoRootPaths: string[];
  cancellationToken: vscode.CancellationToken;
}

export interface AiMergeConflictGenerateResult {
  resolutions: AiMergeConflictResolution[];
  provider: AiProvider;
  model?: string;
  promptSource: AiMergePromptSource;
  inputCharCount: number;
  inputTokenCount?: number;
  inputTokenBudget?: number;
  maxInputTokens?: number;
  streamed: boolean;
  streamChunkCount: number;
  streamCharCount: number;
  firstTokenLatencyMs?: number;
  durationMs: number;
}
