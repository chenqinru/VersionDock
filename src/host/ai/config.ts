import * as vscode from 'vscode';
import type { AiProvider, AiProviderConfig } from './types';

export type { AiProvider, AiProviderConfig } from './types';

function getConfigString(
  config: vscode.WorkspaceConfiguration,
  key: string,
  defaultValue = '',
): string {
  return (config.get<string>(key, defaultValue) ?? defaultValue).trim();
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
  };
}
