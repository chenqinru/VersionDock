import * as vscode from 'vscode';
import defaultBundle from '../../../l10n/bundle.l10n.json';

export const t = vscode.l10n.t;

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
