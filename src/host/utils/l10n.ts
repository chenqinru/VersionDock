import * as vscode from 'vscode';
import defaultBundle from '../../../l10n/bundle.l10n.json';

let isMultiRepoProvider: (() => boolean) | undefined;

export function setMultiRepoProvider(provider: () => boolean): void {
  isMultiRepoProvider = provider;
}

export function isMultiRepo(): boolean {
  return isMultiRepoProvider ? isMultiRepoProvider() : false;
}

/**
 * Formats a message according to the current workspace repository mode:
 * - In single-repo mode (repoCount <= 1), strips any redundant `VersionDock [{repoName}]` prefix.
 * - In multi-repo mode (repoCount > 1), keeps the repository name prefix.
 */
export function formatRepoMessage(text: string): string {
  if (isMultiRepo()) {
    return text;
  }
  return text.replace(/^VersionDock\s*\[[^\]]+\]\s*(警告：|Warning:\s*|：|:\s*)/, (_match, p1: string) => {
    if (p1.startsWith('警告')) return 'VersionDock 警告：';
    if (p1.startsWith('Warning')) return 'VersionDock Warning: ';
    if (p1.includes('：')) return 'VersionDock：';
    return 'VersionDock: ';
  });
}

export function t(message: string, ...args: Array<string | number | boolean>): string;
export function t(message: string, args: Record<string, any>): string;
export function t(options: { message: string; args?: Array<string | number | boolean> | Record<string, any>; comment?: string | string[] }): string;
export function t(...args: any[]): string {
  // @ts-expect-error vscode.l10n.t overload delegate
  const raw = vscode.l10n.t(...args);
  return formatRepoMessage(raw);
}

export interface WebviewI18nPayload {
  locale: string;
  bundle: Record<string, string>;
}

export function getWebviewI18nPayload(): WebviewI18nPayload {
  return {
    locale: vscode.env.language,
    bundle: {
      ...defaultBundle,
      ...(vscode.l10n.bundle ?? {}),
    },
  };
}
