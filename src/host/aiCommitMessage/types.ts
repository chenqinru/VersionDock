import type { AiProvider } from '../ai/types';

export type AiCommitPromptSource = 'workspace' | 'global' | 'builtin';

export interface AiCommitMessageGenerationContext {
  text: string;
  repoRootPaths: string[];
  vcsKinds: Array<'git' | 'svn'>;
  repositoryCount: number;
  fileCount: number;
  contextCharCount: number;
  truncated: boolean;
}

export interface AiCommitMessageGenerateOptions {
  context: AiCommitMessageGenerationContext;
  cancellationToken: import('vscode').CancellationToken;
  onDelta: (delta: string) => void;
}

export interface AiCommitMessageGenerateResult {
  message: string;
  provider: AiProvider;
  model?: string;
  promptSource: AiCommitPromptSource;
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

export type AiCommitMessageEditorGenerator = (
  cancellationToken: import('vscode').CancellationToken,
  onMessage: (message: string) => void,
) => Promise<string>;
