import type * as vscode from 'vscode';

export type AiProvider = 'github-copilot' | 'openai' | 'claude' | 'gemini' | 'custom';
export type AiExecutionMode = 'provider' | 'agent-cli';
export type AiCliProvider = 'claude' | 'codex' | 'antigravity' | 'opencode';
export type AiRuntimeProvider = AiProvider | `${AiCliProvider}-cli`;
export type AiTaskKind =
  | 'commit-message'
  | 'commit-explanation'
  | 'code-review'
  | 'commit-composer'
  | 'merge-conflict'
  | 'json-repair';

export interface AiProviderConfig {
  executionMode: AiExecutionMode;
  provider: AiProvider;
  apiKey: string;
  apiUrl: string;
  model: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  cliProvider: AiCliProvider;
  cliModel: string;
  cliTimeoutSeconds: number;
  cliExecutablePaths: Record<AiCliProvider, string>;
}

export interface AiProviderGenerateOptions {
  systemPrompt: string;
  userMessage: string;
  cancellationToken: vscode.CancellationToken;
  onDelta: (delta: string) => void;
  maxOutputTokens?: number;
  temperature?: number;
  taskKind?: AiTaskKind;
  repoRootPaths?: string[];
  selectedPaths?: string[];
  outputSchema?: Record<string, unknown>;
}

export interface AiProviderGenerateResult {
  text: string;
  provider: AiRuntimeProvider;
  model?: string;
  inputCharCount: number;
  inputTokenCount?: number;
  inputTokenBudget?: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  finishReason?: string;
  outputTokenCount?: number;
  reasoningTokenCount?: number;
  inputTruncated: boolean;
  streamed: boolean;
  streamChunkCount: number;
  streamCharCount: number;
  firstTokenLatencyMs?: number;
  durationMs: number;
}
