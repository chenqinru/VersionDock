import * as vscode from 'vscode';
import * as fs from 'fs';
import { t } from './l10n';

export interface ShowGitErrorOptions {
  onUnlocked?: () => void | Promise<void>;
}

/**
 * Shows an error message in VS Code.
 * If the error is caused by a Git index.lock or GitOperationLock timeout,
 * it presents an interactive "Unlock" action button to let the user clean the lock file in one click.
 */
export async function showGitErrorMessage(
  errorOrMessage: unknown,
  options?: ShowGitErrorOptions,
): Promise<string | undefined> {
  const message = errorOrMessage instanceof Error ? errorOrMessage.message : String(errorOrMessage);

  // Detect Git index.lock paths from "Git index is busy: <path>" or simple-git stderr
  const lockMatch =
    message.match(/(?:Git index is busy|Unable to create|Another git process seems to be running).*?['"]?([^\s'"]+index\.lock)['"]?/i) ||
    message.match(/([^\s'"]+index\.lock)/i);

  if (lockMatch) {
    const lockPath = lockMatch[1].trim();
    const formattedMsg = message.startsWith('VersionDock') ? message : t('VersionDock: {0}', message);
    const action = await vscode.window.showErrorMessage(formattedMsg, t('Unlock'));

    if (action === t('Unlock')) {
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
        void vscode.window.showInformationMessage(t('VersionDock: Git index unlocked successfully.'));
        if (options?.onUnlocked) {
          await options.onUnlocked();
        }
      } catch (err) {
        void vscode.window.showErrorMessage(t('VersionDock: Failed to remove lock file: {0}', String(err)));
      }
    }
    return action;
  }

  // Normal error toast
  const formattedMsg = message.startsWith('VersionDock') ? message : t('VersionDock: {0}', message);
  return vscode.window.showErrorMessage(formattedMsg);
}
