import * as vscode from 'vscode';
import type { AiProvider, AiProviderConfig } from './types';

export type { AiProvider, AiProviderConfig } from './types';

export const DEFAULT_AI_MAX_INPUT_TOKENS = 128_000;
export const MIN_AI_MAX_INPUT_TOKENS = 4_096;

function getConfigString(
  config: vscode.WorkspaceConfiguration,
  key: string,
  defaultValue = '',
): string {
  return (config.get<string>(key, defaultValue) ?? defaultValue).trim();
}

function getConfigNumber(
  config: vscode.WorkspaceConfiguration,
  key: string,
  defaultValue: number,
): number {
  const value = config.get<number>(key, defaultValue);
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(MIN_AI_MAX_INPUT_TOKENS, Math.floor(value))
    : defaultValue;
}

export function getAiProviderConfig(): AiProviderConfig {
  const config = vscode.workspace.getConfiguration('versiondock');
  const configuredProvider = getConfigString(config, 'ai.provider', 'github-copilot').toLowerCase();
  const provider: AiProvider = configuredProvider === 'openai'
    || configuredProvider === 'claude'
    || configuredProvider === 'gemini'
    || configuredProvider === 'custom'
    ? configuredProvider
    : 'github-copilot';

  return {
    provider,
    apiKey: getConfigString(config, 'ai.apiKey'),
    apiUrl: getConfigString(config, 'ai.apiUrl'),
    model: getConfigString(config, 'ai.model'),
    maxInputTokens: getConfigNumber(config, 'ai.maxInputTokens', DEFAULT_AI_MAX_INPUT_TOKENS),
  };
}
