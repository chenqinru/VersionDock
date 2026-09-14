import * as vscode from 'vscode';
import type { AiApiProtocol, AiCliProvider, AiExecutionMode, AiProvider, AiProviderConfig } from './types';

export type { AiProvider, AiProviderConfig } from './types';

export const DEFAULT_AI_MAX_INPUT_TOKENS = 128_000;
export const MIN_AI_MAX_INPUT_TOKENS = 4_096;
export const DEFAULT_AI_MAX_OUTPUT_TOKENS = 128_000;
export const MIN_AI_MAX_OUTPUT_TOKENS = 1_024;
export const MAX_AI_MAX_OUTPUT_TOKENS = 128_000;
export const DEFAULT_AI_CLI_TIMEOUT_SECONDS = 300;
export const MIN_AI_CLI_TIMEOUT_SECONDS = 30;
export const MAX_AI_CLI_TIMEOUT_SECONDS = 1_800;

const DEFAULT_AI_API_URLS: Partial<Record<AiProvider, string>> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  claude: 'https://api.anthropic.com/v1/messages',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

const DEFAULT_OPENAI_RESPONSES_API_URL = 'https://api.openai.com/v1/responses';

const ROOT_API_PATHS: Partial<Record<AiProvider, string>> = {
  openai: '/v1/chat/completions',
  claude: '/v1/messages',
  gemini: '/v1beta/openai/chat/completions',
  custom: '/v1/chat/completions',
};

function effectiveApiProtocol(provider: AiProvider, protocol: AiApiProtocol): AiApiProtocol {
  return provider === 'openai' || provider === 'custom' ? protocol : 'chat-completions';
}

export function resolveAiApiUrl(
  provider: AiProvider,
  configuredUrl: string,
  protocol: AiApiProtocol = 'chat-completions',
): string {
  const resolvedProtocol = effectiveApiProtocol(provider, protocol);
  const trimmed = configuredUrl.trim();
  if (!trimmed) {
    return provider === 'openai' && resolvedProtocol === 'responses'
      ? DEFAULT_OPENAI_RESPONSES_API_URL
      : DEFAULT_AI_API_URLS[provider] ?? '';
  }
  const parsed = new URL(trimmed);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  let resolvedPath: string | undefined;
  if (resolvedProtocol === 'responses' && (pathname === '/' || pathname === '/v1')) {
    resolvedPath = '/v1/responses';
  } else if (resolvedProtocol === 'responses' && pathname === '/v1/chat/completions') {
    resolvedPath = '/v1/responses';
  } else if (resolvedProtocol === 'chat-completions' && pathname === '/v1/responses') {
    resolvedPath = '/v1/chat/completions';
  } else if (pathname === '/') {
    resolvedPath = ROOT_API_PATHS[provider];
  } else if (pathname === '/v1') {
    resolvedPath = provider === 'claude'
      ? '/v1/messages'
      : provider === 'gemini'
        ? '/v1beta/openai/chat/completions'
        : '/v1/chat/completions';
  } else if (provider === 'gemini' && (pathname === '/v1beta' || pathname === '/v1beta/openai')) {
    resolvedPath = '/v1beta/openai/chat/completions';
  }
  if (!resolvedPath) return trimmed;
  parsed.pathname = resolvedPath;
  return parsed.toString();
}

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
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  const value = config.get<number>(key, defaultValue);
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
    : defaultValue;
}

export function getAiProviderConfig(): AiProviderConfig {
  const config = vscode.workspace.getConfiguration('versiondock');
  const executionMode: AiExecutionMode = getConfigString(config, 'ai.executionMode', 'provider') === 'agent-cli'
    ? 'agent-cli'
    : 'provider';
  const configuredProvider = getConfigString(config, 'ai.provider', 'github-copilot').toLowerCase();
  const provider: AiProvider = configuredProvider === 'openai'
    || configuredProvider === 'claude'
    || configuredProvider === 'gemini'
    || configuredProvider === 'custom'
    ? configuredProvider
    : 'github-copilot';
  const configuredCliProvider = getConfigString(config, 'ai.cli.provider', 'claude').toLowerCase();
  const cliProvider: AiCliProvider = configuredCliProvider === 'codex'
    || configuredCliProvider === 'antigravity'
    || configuredCliProvider === 'opencode'
    ? configuredCliProvider
    : 'claude';
  const apiProtocol: AiApiProtocol = getConfigString(config, 'ai.apiProtocol', 'chat-completions') === 'responses'
    ? 'responses'
    : 'chat-completions';

  return {
    executionMode,
    provider,
    apiProtocol,
    apiKey: getConfigString(config, 'ai.apiKey'),
    apiUrl: getConfigString(config, 'ai.apiUrl'),
    model: getConfigString(config, 'ai.model'),
    maxInputTokens: getConfigNumber(
      config,
      'ai.maxInputTokens',
      DEFAULT_AI_MAX_INPUT_TOKENS,
      MIN_AI_MAX_INPUT_TOKENS,
    ),
    maxOutputTokens: getConfigNumber(
      config,
      'ai.maxOutputTokens',
      DEFAULT_AI_MAX_OUTPUT_TOKENS,
      MIN_AI_MAX_OUTPUT_TOKENS,
      MAX_AI_MAX_OUTPUT_TOKENS,
    ),
    cliProvider,
    cliModel: getConfigString(config, 'ai.cli.model'),
    cliTimeoutSeconds: getConfigNumber(
      config,
      'ai.cli.timeoutSeconds',
      DEFAULT_AI_CLI_TIMEOUT_SECONDS,
      MIN_AI_CLI_TIMEOUT_SECONDS,
      MAX_AI_CLI_TIMEOUT_SECONDS,
    ),
    cliExecutablePaths: {
      claude: getConfigString(config, 'ai.cli.claudePath', 'claude'),
      codex: getConfigString(config, 'ai.cli.codexPath', 'codex'),
      antigravity: getConfigString(config, 'ai.cli.antigravityPath', 'agy'),
      opencode: getConfigString(config, 'ai.cli.opencodePath', 'opencode'),
    },
  };
}
