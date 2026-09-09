import * as vscode from 'vscode';
import * as fs from 'fs';
import { t, formatRepoMessage } from './l10n';
import { isPushRejectedError } from './pushProtection';

export interface ShowGitErrorOptions {
  repoName?: string;
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
  const repoName = options?.repoName;

  const formatMsg = (raw: string): string => {
    if (repoName) {
      if (raw.startsWith('VersionDock [')) return formatRepoMessage(raw);
      const stripped = raw.replace(/^VersionDock(?::|：)\s*/, '');
      return t('VersionDock [{0}]: {1}', repoName, stripped);
    }
    const formatted = raw.startsWith('VersionDock') ? raw : t('VersionDock: {0}', raw);
    return formatRepoMessage(formatted);
  };

  // Detect Git index.lock paths from "Git index is busy: <path>" or simple-git stderr
  const lockMatch =
    message.match(/(?:Git index is busy|Unable to create|Another git process seems to be running).*?['"]?([^\s'"]+index\.lock)['"]?/i) ||
    message.match(/([^\s'"]+index\.lock)/i);

  if (lockMatch) {
    const lockPath = lockMatch[1].trim();
    const formattedMsg = formatMsg(message);
    const action = await vscode.window.showErrorMessage(formattedMsg, t('Unlock'));

    if (action === t('Unlock')) {
      try {
        if (fs.existsSync(lockPath)) {
          fs.unlinkSync(lockPath);
        }
        const successMsg = repoName
          ? t('VersionDock [{0}]: Git index unlocked successfully.', repoName)
          : t('VersionDock: Git index unlocked successfully.');
        void vscode.window.showInformationMessage(successMsg);
        if (options?.onUnlocked) {
          await options.onUnlocked();
        }
      } catch (err) {
        const failMsg = repoName
          ? t('VersionDock [{0}]: Failed to remove lock file: {1}', repoName, String(err))
          : t('VersionDock: Failed to remove lock file: {0}', String(err));
        void vscode.window.showErrorMessage(failMsg);
      }
    }
    return action;
  }

  // Detect authentication / permission errors
  const isAuthError =
    message.includes('Permission denied (publickey)') ||
    message.includes('Authentication failed') ||
    message.includes('could not read Username for') ||
    message.includes('Invalid username or password');

  if (isAuthError) {
    const diagnostic = repoName
      ? t('VersionDock [{0}]: Remote authentication failed (SSH key not configured or access token expired). Please check your credentials.', repoName)
      : t('VersionDock: Remote authentication failed (SSH key not configured or access token expired). Please check your credentials.');
    return vscode.window.showErrorMessage(`${diagnostic}\n\n${message}`);
  }

  // Detect push rejection (non-fast-forward)
  if (isPushRejectedError(errorOrMessage)) {
    const diagnostic = repoName
      ? t('VersionDock [{0}]: Push rejected because the remote contains work that you do not have locally. Please update or rebase before pushing.', repoName)
      : t('VersionDock: Push rejected because the remote contains work that you do not have locally. Please update or rebase before pushing.');
    return vscode.window.showErrorMessage(`${diagnostic}\n\n${message}`);
  }

  // Detect merge / rebase / cherry-pick / revert conflicts
  const isConflict =
    message.includes('CONFLICT') ||
    message.includes('Merge conflict') ||
    message.includes('could not apply') ||
    message.includes('Resolve all conflicts manually') ||
    message.includes('Automatic merge failed; fix conflicts') ||
    message.includes('Fix conflicts and then run') ||
    message.includes('Patch failed at');

  if (isConflict) {
    const resolveLabel = t('Resolve Conflicts');
    const diagnostic = repoName
      ? t('VersionDock [{0}]: Merge conflicts detected. Use the Merge Editor to resolve them.', repoName)
      : t('VersionDock: Merge conflicts detected. Use the Merge Editor to resolve them.');
    const action = await vscode.window.showErrorMessage(
      `${diagnostic}\n\n${message.replace(/^VersionDock(\s*\[[^\]]+\])?:\s*/, '')}`,
      resolveLabel,
    );
    if (action === resolveLabel) {
      await vscode.commands.executeCommand('versiondock.openConflicts');
    }
    return action;
  }

  // Normal error toast
  const formattedMsg = formatMsg(message);
  return vscode.window.showErrorMessage(formattedMsg);
}
