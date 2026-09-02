import * as vscode from 'vscode';
import { t } from './l10n';
import { isRemoteRepositoryCancelled } from '../remote/types';
import { withGitPushProgress } from './pushProgress';
import { isBranchProtected } from './branchProtection';

export interface PushProtectionTargetRepo {
  repoId?: string;
  name?: string;
  rootPath?: string;
  kind?: 'git' | 'svn';
  push(force?: boolean, remote?: string): Promise<void>;
  pull?(): Promise<string>;
  pullRebase?(): Promise<string>;
  getRemotes(): Promise<string[]>;
  getCurrentBranch?(): Promise<{ name: string } | undefined>;
  getStatus?(): Promise<{ stagedFiles: unknown[]; unstagedFiles: unknown[]; conflictCount?: number; operationState?: string | null }>;
  stashPush?(message?: string): Promise<void>;
  stashPop?(stashRef?: string): Promise<void>;
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

    if (!isBranchProtected(branchName, undefined, repo.repoId)) {
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
 * Rebase/Merge & Push, Force Push, or Cancel, and automatically handles the clean working tree,
 * update, and push retry workflow.
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

    const updateMethod = vscode.workspace
      .getConfiguration('versiondock')
      .get<'rebase' | 'merge' | 'prompt'>('updateProject.method', 'rebase');
    const isMergePreferred = updateMethod === 'merge';

    let shouldUpdate = mode === 'rebaseAndRetry';
    let selectedUpdateMethod: 'rebase' | 'merge' = isMergePreferred ? 'merge' : 'rebase';
    let shouldForce = false;

    if (mode === 'prompt') {
      const updateBtn = isMergePreferred ? t('Merge & Push') : t('Rebase & Push');
      const forceBtn = t('Force Push');

      const choice = await vscode.window.showWarningMessage(
        t(
          'VersionDock [{0}]: Push was rejected because the remote contains work that you do not have locally.',
          repoName,
        ),
        updateBtn,
        forceBtn,
      );

      if (choice === updateBtn) {
        shouldUpdate = true;
        selectedUpdateMethod = isMergePreferred ? 'merge' : 'rebase';
      } else if (choice === forceBtn) {
        shouldForce = true;
      } else {
        return { success: false, cancelled: true };
      }
    }

    // 3. Handle Update & Retry (with clean working tree protection)
    if (shouldUpdate) {
      options?.logger?.info('Git', `Auto-updating (${selectedUpdateMethod}) before push retry`, { repoName, remote });

      // 3.1 Check dirty working tree and auto-clean (Auto-stash)
      let autoStashed = false;
      if (repo.getStatus && repo.stashPush) {
        try {
          const statusBefore = await repo.getStatus();
          const isDirty = (statusBefore.stagedFiles.length > 0) || (statusBefore.unstagedFiles.length > 0);
          if (isDirty) {
            const timestamp = new Date().toLocaleTimeString();
            await repo.stashPush(`Auto-stashed before push retry (${timestamp})`);
            autoStashed = true;
            options?.logger?.info('Git', 'Auto-stashed local changes before update and push retry', { repoName });
          }
        } catch (stashErr) {
          options?.logger?.warn('Git', 'Failed to auto-stash dirty working tree before push retry', { repoName, error: String(stashErr) });
        }
      }

      // 3.2 Execute pull with configured strategy
      const updateTitle = selectedUpdateMethod === 'merge'
        ? t('VersionDock [{0}]: Merging remote changes…', repoName)
        : t('VersionDock [{0}]: Rebasing on remote…', repoName);

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: updateTitle,
            cancellable: false,
          },
          async () => {
            if (selectedUpdateMethod === 'merge' && repo.pull) {
              await repo.pull();
            } else if (repo.pullRebase) {
              await repo.pullRebase();
            } else if (repo.pull) {
              await repo.pull();
            } else {
              throw new Error(t('VersionDock [{0}]: Pull/Rebase is not supported on this repository.', repoName));
            }
          },
        );
      } catch (updateErr: unknown) {
        if (autoStashed && repo.stashPop) {
          try {
            await repo.stashPop();
          } catch { /* ignore pop error on update failure */ }
        }
        options?.logger?.error('Git', 'Update failed during push recovery', updateErr, { repoName });
        return { success: false, cancelled: false, error: updateErr };
      }

      // 3.3 Restore working tree after update
      if (autoStashed && repo.stashPop) {
        try {
          await repo.stashPop();
          options?.logger?.info('Git', 'Auto-restored stashed changes after update', { repoName });
        } catch (popErr) {
          options?.logger?.warn('Git', 'Conflicts detected while restoring stashed changes during push recovery', { repoName, error: String(popErr) });
          void vscode.window.showWarningMessage(
            t('VersionDock [{0}]: Conflicts detected while restoring stashed changes.', repoName),
          );
          return { success: false, cancelled: false, error: popErr };
        }
      }

      // 3.4 Verify conflict status after update
      if (repo.getStatus) {
        const statusAfter = await repo.getStatus().catch(() => undefined);
        if (statusAfter && ((statusAfter.conflictCount ?? 0) > 0 || statusAfter.operationState)) {
          return {
            success: false,
            cancelled: false,
            error: new Error(t('VersionDock [{0}]: Update stopped with conflicts. Please resolve conflicts before pushing.', repoName)),
          };
        }
      }

      // 3.5 Retry push after successful update
      options?.logger?.info('Git', 'Retrying push after update', { repoName, remote });
      try {
        await withGitPushProgress(
          repo,
          options?.remote
            ? t('VersionDock: Pushing to {0}…', options.remote)
            : t('VersionDock: Pushing'),
          () => repo.push(false, remote),
        );

        if (!options?.silentOnSuccess) {
          const successMsg = selectedUpdateMethod === 'merge'
            ? t('VersionDock [{0}]: Merged and pushed successfully.', repoName)
            : t('VersionDock [{0}]: Rebased and pushed successfully.', repoName);
          void vscode.window.showInformationMessage(successMsg);
        }
        return { success: true, rebased: selectedUpdateMethod === 'rebase', forced: false };
      } catch (retryErr: unknown) {
        options?.logger?.error('Git', 'Push retry after update failed', retryErr, { repoName });
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
