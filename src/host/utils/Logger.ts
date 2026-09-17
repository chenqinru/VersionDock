import * as vscode from 'vscode';

export type LogDetails = Record<string, unknown>;

const SENSITIVE_KEY = /(?:password|passwd|api[_-]?key|token|secret|credential|authorization|email)/i;
// Token accounting fields are numeric diagnostics, not authentication secrets.
// Keep this as an exact allowlist so accessToken and similar keys stay redacted.
const SAFE_TOKEN_METRIC_KEYS = new Set([
  'firsttokenlatencyms',
  'inputtokencount',
  'inputtokenbudget',
  'maxinputtokens',
  'outputtokencount',
  'outputtokenbudget',
  'maxoutputtokens',
  'previousmaxoutputtokens',
  'retrymaxoutputtokens',
  'reasoningtokencount',
]);
const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

function isSensitiveKey(key: string): boolean {
  return !SAFE_TOKEN_METRIC_KEYS.has(key.toLowerCase()) && SENSITIVE_KEY.test(key);
}

function sanitizeText(value: string): string {
  return value
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi, '$1<redacted>@')
    .replace(/([?&](?:access_token|private_token|refresh_token|api[_-]?key|token|secret|password|passwd)=)[^&#\s"']+/gi, '$1<redacted>')
    .replace(/(--password(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1<redacted>')
    .replace(/("--(?:password|token|secret)"\s*,\s*)"[^"]*"/gi, '$1"<redacted>"')
    .replace(/('--(?:password|token|secret)'\s*,\s*)'[^']*'/gi, "$1'<redacted>'")
    .replace(/("-m"\s*,\s*)"[^"]*"/gi, '$1"<redacted>"')
    .replace(/('-m'\s*,\s*)'[^']*'/gi, "$1'<redacted>'")
    .replace(/(\b(?:-m|--message)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1<redacted>')
    .replace(/(["']user\.name=)[^"']*(["'])/gi, '$1<redacted>$2')
    .replace(/(\buser\.name=)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1<redacted>')
    .replace(/\b((?:access[_-]|private[_-]|refresh[_-])?token|password|passwd|secret|authorization|api[_-]?key)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi, '$1=<redacted>')
    .replace(EMAIL_ADDRESS, '<redacted-email>');
}

function formatValue(key: string, value: unknown): string {
  if (isSensitiveKey(key)) return '"<redacted>"';
  if (typeof value === 'string') return JSON.stringify(sanitizeText(value));
  if (value instanceof Error) return JSON.stringify(sanitizeText(value.message));

  try {
    const serialized = JSON.stringify(value, (nestedKey, nestedValue) => {
      if (nestedKey && isSensitiveKey(nestedKey)) return '<redacted>';
      return typeof nestedValue === 'string' ? sanitizeText(nestedValue) : nestedValue;
    });
    return serialized === undefined ? String(value) : sanitizeText(serialized);
  } catch {
    return sanitizeText(String(value));
  }
}

function formatDetails(details?: LogDetails): string {
  if (!details) return '';
  const entries = Object.entries(details);
  if (entries.length === 0) return '';
  return ` ${entries.map(([key, value]) => `${key}=${formatValue(key, value)}`).join(' ')}`;
}

function formatError(error: unknown): string {
  if (error === undefined || error === null) return '';
  if (error instanceof Error) return sanitizeText(error.stack ?? error.message);
  return sanitizeText(String(error));
}

export class VersionDockLogger implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('VersionDock', { log: true });

  trace(scope: string, message: string, details?: LogDetails): void {
    this.channel.trace(this.format(scope, message, details));
  }

  debug(scope: string, message: string, details?: LogDetails): void {
    this.channel.debug(this.format(scope, message, details));
  }

  info(scope: string, message: string, details?: LogDetails): void {
    this.channel.info(this.format(scope, message, details));
  }

  warn(scope: string, message: string, details?: LogDetails): void {
    this.channel.warn(this.format(scope, message, details));
  }

  error(scope: string, message: string, error?: unknown, details?: LogDetails): void {
    const cause = formatError(error);
    this.channel.error(`${this.format(scope, message, details)}${cause ? `\n${cause}` : ''}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }

  private format(scope: string, message: string, details?: LogDetails): string {
    return `[${scope}] ${sanitizeText(message)}${formatDetails(details)}`;
  }
}
