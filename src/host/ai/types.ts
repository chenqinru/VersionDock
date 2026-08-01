import type * as vscode from 'vscode';

export type AiProvider = 'github-copilot' | 'openai' | 'claude' | 'gemini' | 'custom';

export interface AiProviderConfig {
  provider: AiProvider;
  apiKey: string;
  apiUrl: string;
  model: string;
  maxInputTokens: number;
}

export interface AiProviderGenerateOptions {
  systemPrompt: string;
  userMessage: string;
  cancellationToken: vscode.CancellationToken;
  onDelta: (delta: string) => void;
  maxOutputTokens?: number;
}

export interface AiProviderGenerateResult {
  text: string;
  provider: AiProvider;
  model?: string;
  inputCharCount: number;
  inputTokenCount?: number;
  inputTokenBudget?: number;
  maxInputTokens?: number;
  inputTruncated: boolean;
  streamed: boolean;
  streamChunkCount: number;
  streamCharCount: number;
  firstTokenLatencyMs?: number;
  durationMs: number;
}
