import * as vscode from 'vscode';
import { t } from './l10n';
import { isRemoteRepositoryCancelled } from '../remote/types';
import { withGitPushProgress } from './pushProgress';
import { isBranchProtected } from './branchProtection';

export interface PushProtectionTargetRepo {
  repoId?: string;
  name?: string;
  rootPath?: string;
  push(force?: boolean, remote?: string): Promise<void>;
  pullRebase?(): Promise<string>;
  getRemotes(): Promise<string[]>;
  getCurrentBranch?(): Promise<{ name: string } | undefined>;
}

export interface RunPushOptions {
  repoName?: string;
  force?: boolean;
  remote?: string;
  silentOnSuccess?: boolean;
  logger?: {
    info(category: string, message: string, detail?: unknown): void;
    warn(category: string, message: string, detail?: unknown): void;
    error(category: string, message: string, error?: unknown, detail?: unknown): void;
  };
}

export type PushExecutionResult =
  | { success: true; rebased: boolean; forced: boolean }
  | { success: false; cancelled: true }
  | { success: false; cancelled: false; error: unknown; isPushRejected?: boolean };

/**
 * Determines whether a Git error was caused by non-fast-forward push rejection.
 */
export function isPushRejectedError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === 'object' && error !== null) {
    const obj = error as Record<string, unknown>;
    if (obj.gitErrorCode === 'PushRejected' || obj.gitErrorCode === 'GitError.PushRejected') {
      return true;
    }
  }
  const msg = error instanceof Error ? `${error.message}\n${(error as { stderr?: string }).stderr ?? ''}` : String(error);
  // Exclude permission / auth errors that might mention rejecting keys
  if (/Permission denied|Authentication failed|could not read Username|Invalid username or password/i.test(msg)) {
    return false;
  }
  return (
    /PushRejected/i.test(msg) ||
    /non-fast-forward/i.test(msg) ||
    /tip of your current branch is behind/i.test(msg) ||
    /remote contains work that you do not have locally/i.test(msg) ||
    (/\[rejected\]/i.test(msg) && /fetch first|need to fetch|behind/i.test(msg))
  );
}

/**
 * Validates whether the push operation is allowed on protected branches.
 */
async function validateProtectedBranchPush(
  repo: PushProtectionTargetRepo,
  repoName: string,
  force: boolean,
): Promise<boolean> {
  if (!repo.getCurrentBranch) return true;
  try {
    const currentBranch = await repo.getCurrentBranch();
    const branchName = currentBranch?.name;
    if (!branchName || branchName === 'HEAD') return true;

    if (!isBranchProtected(branchName)) {
      return true;
    }

    // High-severity warning for Force Push to protected branch
    if (force) {
      const forceAnyway = t('Force Push Anyway');
      const choice = await vscode.window.showWarningMessage(
        t(
          'VersionDock [{0}]: You are about to Force Push to protected branch "{1}"! This may permanently overwrite remote commits. Are you sure you want to proceed?',
          repoName,
          branchName,
        ),
        { modal: true },
        forceAnyway,
      );
      return choice === forceAnyway;
    }

    // Normal push confirmation for protected branch if configured
    const showPushDialog = vscode.workspace
      .getConfiguration('versiondock')
      .get<boolean>('git.showPushDialogForProtectedBranches', true);

    if (showPushDialog) {
      const pushBtn = t('Push');
      const choice = await vscode.window.showWarningMessage(
        t(
          'VersionDock [{0}]: You are pushing to protected branch "{1}". Do you want to proceed?',
          repoName,
          branchName,
        ),
        { modal: true },
        pushBtn,
      );
      return choice === pushBtn;
    }

    return true;
  } catch {
    return true;
  }
}

/**
 * Runs a Git push operation wrapped with JetBrains-style protection:
 * If the push is rejected because the remote is ahead, it prompts the user to
 * Rebase & Push, Force Push, or Cancel, and automatically handles the rebase + retry workflow.
 */
export async function runPushWithProtection(
  repo: PushProtectionTargetRepo,
  options?: RunPushOptions,
): Promise<PushExecutionResult> {
  const repoName = options?.repoName || repo.name || repo.repoId || 'Repository';
  const force = options?.force ?? false;
  const remote = options?.remote;

  // 0. Protected branch pre-check
  const allowed = await validateProtectedBranchPush(repo, repoName, force);
  if (!allowed) {
    return { success: false, cancelled: true };
  }

  // 1. Initial push attempt (wrapped with push progress)
  try {
    await withGitPushProgress(
      repo,
      options?.remote
        ? t('VersionDock: Pushing to {0}…', options.remote)
        : t('VersionDock: Pushing'),
      () => repo.push(force, remote),
    );
    return { success: true, rebased: false, forced: force };
  } catch (error: unknown) {
    if (isRemoteRepositoryCancelled(error)) {
      return { success: false, cancelled: true };
    }

    if (!isPushRejectedError(error)) {
      return { success: false, cancelled: false, error };
    }

    // 2. Detected PushRejected - check configuration
    const mode = vscode.workspace
      .getConfiguration('versiondock')
      .get<'prompt' | 'rebaseAndRetry' | 'error'>('git.onPushRejected', 'prompt');

    if (mode === 'error') {
      return { success: false, cancelled: false, error, isPushRejected: true };
    }

    let shouldRebase = mode === 'rebaseAndRetry';
    let shouldForce = false;

    if (mode === 'prompt') {
      const rebaseBtn = t('Rebase & Push');
      const forceBtn = t('Force Push');

      const choice = await vscode.window.showWarningMessage(
        t(
          'VersionDock [{0}]: Push was rejected because the remote contains work that you do not have locally.',
          repoName,
        ),
        rebaseBtn,
        forceBtn,
      );

      if (choice === rebaseBtn) {
        shouldRebase = true;
      } else if (choice === forceBtn) {
        shouldForce = true;
      } else {
        return { success: false, cancelled: true };
      }
    }

    // 3. Handle Rebase & Retry
    if (shouldRebase) {
      if (!repo.pullRebase) {
        return {
          success: false,
          cancelled: false,
          error: new Error(t('VersionDock [{0}]: Rebase is not supported on this repository.', repoName)),
        };
      }

      options?.logger?.info('Git', 'Auto-rebasing before push retry', { repoName, remote });

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('VersionDock [{0}]: Rebasing on remote…', repoName),
            cancellable: false,
          },
          async () => {
            await repo.pullRebase!();
          },
        );
      } catch (rebaseErr: unknown) {
        options?.logger?.error('Git', 'Rebase failed during push recovery', rebaseErr, { repoName });
        return { success: false, cancelled: false, error: rebaseErr };
      }

      // Retry push after successful rebase
      options?.logger?.info('Git', 'Retrying push after rebase', { repoName, remote });
      try {
        await withGitPushProgress(
          repo,
          options?.remote
            ? t('VersionDock: Pushing to {0}…', options.remote)
            : t('VersionDock: Pushing'),
          () => repo.push(false, remote),
        );

        if (!options?.silentOnSuccess) {
          void vscode.window.showInformationMessage(
            t('VersionDock [{0}]: Rebased and pushed successfully.', repoName),
          );
        }
        return { success: true, rebased: true, forced: false };
      } catch (retryErr: unknown) {
        options?.logger?.error('Git', 'Push retry after rebase failed', retryErr, { repoName });
        return { success: false, cancelled: isRemoteRepositoryCancelled(retryErr), error: retryErr };
      }
    }

    // 4. Handle Force Push
    if (shouldForce) {
      const forceAllowed = await validateProtectedBranchPush(repo, repoName, true);
      if (!forceAllowed) {
        return { success: false, cancelled: true };
      }

      options?.logger?.info('Git', 'Executing force push per user request', { repoName, remote });
      try {
        await withGitPushProgress(
          repo,
          options?.remote
            ? t('VersionDock: Pushing to {0}…', options.remote)
            : t('VersionDock: Pushing'),
          () => repo.push(true, remote),
        );

        if (!options?.silentOnSuccess) {
          void vscode.window.showInformationMessage(
            t('VersionDock [{0}]: Force pushed successfully.', repoName),
          );
        }
        return { success: true, rebased: false, forced: true };
      } catch (forceErr: unknown) {
        options?.logger?.error('Git', 'Force push failed', forceErr, { repoName });
        return { success: false, cancelled: isRemoteRepositoryCancelled(forceErr), error: forceErr };
      }
    }

    return { success: false, cancelled: true };
  }
}
