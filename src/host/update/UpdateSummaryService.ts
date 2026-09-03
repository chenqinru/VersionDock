import * as vscode from 'vscode';
import type { AiCommitExplanationService } from '../aiCommitExplanation/AiCommitExplanationService';
import type { GitService } from '../git/GitService';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { openAggregatedCommitDetailPanel } from '../panels/CommitDetailPanel';
import { t } from '../utils/l10n';
import type { VersionDockLogger } from '../utils/Logger';
import { scopedKey } from '../utils/scopedKey';
import type { UpdateCommitSelection, VcsUpdateSnapshot } from './types';
import { ShelveService } from '../git/ShelveService';

const UPDATE_DETAILS_CONCURRENCY = 4;

export type TrackedUpdateResult = {
  repoId: string;
  tracked: boolean;
  ok: boolean;
  output?: string;
  error?: string;
  skippedReason?: string;
  commits: UpdateCommitSelection[];
  files: string[];
  summaryError?: string;
};

export type UpdateTarget = {
  repoId: string;
  branchName?: string;
  execute(repo: GitService): Promise<string>;
};

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export class UpdateSummaryService {
  private readonly shelveServices = new Map<string, ShelveService>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly aiCommitExplanationService: AiCommitExplanationService,
    private readonly logger: VersionDockLogger,
    private readonly globalStoragePath?: string,
  ) {}

  private getShelveService(repo: GitService): ShelveService | undefined {
    if (!this.globalStoragePath || repo.kind === 'svn') return undefined;
    if (!this.shelveServices.has(repo.repoId)) {
      this.shelveServices.set(
        repo.repoId,
        new ShelveService(
          repo.rootPath,
          this.globalStoragePath,
          (op, kind, label) => this.manager.runWithStatusUpdatesSuppressed(op, kind, label),
        ),
      );
    }
    return this.shelveServices.get(repo.repoId);
  }

  async run(target: UpdateTarget): Promise<TrackedUpdateResult> {
    const repo = this.manager.getRepo(target.repoId);
    if (!repo) {
      return {
        repoId: target.repoId,
        tracked: false,
        ok: false,
        error: t('Repo not found'),
        commits: [],
        files: [],
      };
    }

    const repoName = this.manager.getRepoMeta(target.repoId)?.name ?? target.repoId;
    let snapshot: VcsUpdateSnapshot | undefined;
    let snapshotError: string | undefined;
    let trackingRequested = !this.manager.getRepoMeta(target.repoId)?.isSubmodule;
    if (trackingRequested && target.branchName) {
      const currentBranch = await repo.getCurrentBranch().catch(() => undefined);
      if (currentBranch && currentBranch.name !== target.branchName) trackingRequested = false;
    }
    if (trackingRequested) {
      try {
        snapshot = await repo.captureUpdateSnapshot(target.branchName);
      } catch (error: unknown) {
        snapshotError = errorText(error);
        this.logger.warn('UpdateSummary', 'Failed to capture update snapshot', {
          repoId: target.repoId,
          vcs: repo.kind,
          error: snapshotError,
        });
      }
    }

    // Working tree auto-clean before update (JetBrains-style)
    let shelvedBackupId: string | undefined;
    let shelfBackupName = '';
    let stashedBackup = false;
    let shelveSvc: ShelveService | undefined;

    if (repo.kind === 'git') {
      const statusBefore = await repo.getStatus().catch(() => undefined);
      const isDirty = Boolean(
        statusBefore && (statusBefore.stagedFiles.length > 0 || statusBefore.unstagedFiles.length > 0),
      );

      if (isDirty) {
        const cleanStrategy = vscode.workspace
          .getConfiguration('versiondock')
          .get<'shelve' | 'stash'>('updateProject.cleanWorkingTree', 'shelve');
        const timestamp = new Date().toLocaleTimeString();

        if (cleanStrategy === 'shelve') {
          shelveSvc = this.getShelveService(repo);
          if (shelveSvc) {
            try {
              shelfBackupName = `Auto-shelved before update (${timestamp})`;
              const shelf = await shelveSvc.push(shelfBackupName);
              shelvedBackupId = shelf.id;
              this.logger.info('UpdateSummary', 'Auto-shelved local changes before update', {
                repoId: target.repoId,
                shelfId: shelf.id,
              });
            } catch (shelveErr) {
              this.logger.warn('UpdateSummary', 'Auto-shelve failed, falling back to stash', {
                repoId: target.repoId,
                error: errorText(shelveErr),
              });
            }
          }
        }

        if (!shelvedBackupId) {
          try {
            await repo.stashPush(`Auto-stashed before update (${timestamp})`);
            stashedBackup = true;
            this.logger.info('UpdateSummary', 'Auto-stashed local changes before update', {
              repoId: target.repoId,
            });
          } catch (stashErr) {
            this.logger.error('UpdateSummary', 'Failed to auto-stash local changes', stashErr, {
              repoId: target.repoId,
            });
          }
        }
      }
    }

    try {
      const output = await target.execute(repo);

      // Restore working tree after update
      await this.restoreWorkingTreeAfterUpdate(repo, repoName, shelveSvc, shelvedBackupId, shelfBackupName, stashedBackup);

      const statusAfterUpdate = await repo.getStatusFresh().catch(() => undefined);
      if (statusAfterUpdate && (statusAfterUpdate.conflictCount > 0 || statusAfterUpdate.operationState)) {
        return {
          repoId: target.repoId,
          tracked: trackingRequested,
          ok: false,
          output,
          error: t('Update stopped with conflicts or an unfinished version-control operation.'),
          commits: [],
          files: [],
        };
      }
      if (!snapshot) {
        return {
          repoId: target.repoId,
          tracked: trackingRequested,
          ok: true,
          output,
          commits: [],
          files: [],
          summaryError: snapshotError ?? (trackingRequested ? t('Update snapshot is unavailable.') : undefined),
        };
      }
      if (snapshot.kind === 'git' && (!snapshot.upstreamRef || !snapshot.beforeHeadHash)) {
        return {
          repoId: target.repoId,
          tracked: true,
          ok: true,
          output,
          skippedReason: t('Current branch has no upstream tracking branch.'),
          commits: [],
          files: [],
        };
      }

      try {
        const hashes = await repo.getUpdateCommitHashes(snapshot);
        const commits = hashes.map(hash => ({ repoId: target.repoId, hash }));
        const filesByCommit = await mapWithConcurrency(
          hashes,
          UPDATE_DETAILS_CONCURRENCY,
          hash => repo.getCommitFilesForLogDetail(hash),
        );
        const files = Array.from(new Set(filesByCommit.flatMap(entries => entries.map(entry => entry.path))));
        return { repoId: target.repoId, tracked: true, ok: true, output, commits, files };
      } catch (error: unknown) {
        const summaryError = errorText(error);
        this.logger.error('UpdateSummary', 'Update completed but summary collection failed', error, {
          repoId: target.repoId,
          vcs: repo.kind,
        });
        return {
          repoId: target.repoId,
          tracked: true,
          ok: true,
          output,
          commits: [],
          files: [],
          summaryError,
        };
      }
    } catch (error: unknown) {
      // Ensure working tree is restored even on update error
      await this.restoreWorkingTreeAfterUpdate(repo, repoName, shelveSvc, shelvedBackupId, shelfBackupName, stashedBackup);

      return {
        repoId: target.repoId,
        tracked: trackingRequested,
        ok: false,
        error: errorText(error),
        commits: [],
        files: [],
      };
    }
  }

  private async restoreWorkingTreeAfterUpdate(
    repo: GitService,
    repoName: string,
    shelveSvc?: ShelveService,
    shelvedBackupId?: string,
    shelfBackupName?: string,
    stashedBackup?: boolean,
  ): Promise<void> {
    if (shelvedBackupId && shelveSvc) {
      try {
        await shelveSvc.apply(shelvedBackupId);
        const statusAfterRestore = await repo.getStatusFresh().catch(() => undefined);
        if (statusAfterRestore && statusAfterRestore.conflictCount > 0) {
          void vscode.window.showWarningMessage(
            t(
              'VersionDock [{0}]: Conflicts detected while restoring local changes. Shelve backup has been retained: "{1}".',
              repoName,
              shelfBackupName || 'Auto-shelved backup',
            ),
          );
        } else {
          shelveSvc.drop(shelvedBackupId);
        }
      } catch {
        void vscode.window.showWarningMessage(
          t(
            'VersionDock [{0}]: Conflicts detected while restoring local changes. Shelve backup has been retained: "{1}".',
            repoName,
            shelfBackupName || 'Auto-shelved backup',
          ),
        );
      }
    } else if (stashedBackup) {
      try {
        await repo.stashPop();
      } catch {
        void vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Conflicts detected while restoring stashed changes.', repoName),
        );
      }
    }
  }

  async runAll(
    targets: readonly UpdateTarget[],
    onProgress?: (completed: number, total: number, currentTarget: UpdateTarget) => void,
  ): Promise<TrackedUpdateResult[]> {
    const results: TrackedUpdateResult[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i];
      onProgress?.(i, targets.length, target);
      // Single-repo timeout safeguard: 45s prevents a single hanging network connection from stalling the entire queue
      const runPromise = this.run(target);
      const timeoutPromise = new Promise<TrackedUpdateResult>((_, reject) => {
        setTimeout(() => reject(new Error(t('Operation timed out after 45 seconds.'))), 45_000);
      });
      try {
        results.push(await Promise.race([runPromise, timeoutPromise]));
      } catch (error: unknown) {
        results.push({
          repoId: target.repoId,
          tracked: true,
          ok: false,
          error: errorText(error),
          commits: [],
          files: [],
        });
      }
    }
    return results;
  }

  async notify(results: readonly TrackedUpdateResult[]): Promise<void> {
    const relevant = results.filter(result => result.tracked);
    const failed = results.filter(result => !result.ok);
    if (relevant.length === 0) {
      if (failed.length > 0) {
        void vscode.window.showErrorMessage(t('VersionDock: Update failed: {0}', this.describeFailures(failed)));
      }
      return;
    }

    const succeeded = relevant.filter(result => result.ok);
    const skipped = succeeded.filter(result => result.skippedReason);
    const summaryFailures = succeeded.filter(result => result.summaryError);
    const commits = Array.from(new Map(
      succeeded.flatMap(result => result.commits)
        .map(commit => [scopedKey(commit.repoId, commit.hash), commit] as const),
    ).values());
    const fileCount = new Set(
      succeeded.flatMap(result => result.files.map(filePath => scopedKey(result.repoId, filePath))),
    ).size;
    const updatedRepoCount = new Set(commits.map(commit => commit.repoId)).size;
    const viewDetails = t('View update details');

    const config = vscode.workspace.getConfiguration('versiondock');
    const showUpdateNotification = config.get<boolean>(
      'updateProject.showUpdateNotification',
      config.get<boolean>('updateProject.showUpdateInfo', true),
    );

    const openDetailsPanel = (): void => {
      void Promise.resolve(
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('VersionDock: Loading update details…'),
            cancellable: false,
          },
          () => openAggregatedCommitDetailPanel(
            this.extensionUri,
            this.manager,
            this.aiCommitExplanationService,
            this.logger,
            commits,
            false,
            { title: t('Update details'), message: t('Update details') },
          ),
        ),
      ).catch(error => {
        this.logger.error('UpdateSummary', 'Failed to open update details', error);
      });
    };

    let notification: Thenable<string | undefined> | undefined;
    if (succeeded.length === 0) {
      const description = this.describeFailures(failed);
      void vscode.window.showErrorMessage(t('VersionDock: Update failed: {0}', description));
      return;
    }

    if (failed.length > 0) {
      const message = t(
        'VersionDock: {0} repositories updated, {1} failed; {2} files changed in {3} commits. {4}',
        succeeded.length,
        failed.length,
        fileCount,
        commits.length,
        this.describeFailures(failed),
      );
      if (commits.length === 0) {
        void vscode.window.showWarningMessage(message);
        return;
      }
      notification = vscode.window.showWarningMessage(message, viewDetails);
    } else if (summaryFailures.length > 0) {
      const message = commits.length > 0
        ? t(
          'VersionDock: Updated {0} files in {1} commits; details could not be calculated for {2} repositories.',
          fileCount,
          commits.length,
          summaryFailures.length,
        )
        : t('VersionDock: Update completed, but update details could not be calculated for {0} repositories.', summaryFailures.length);
      if (commits.length === 0) {
        void vscode.window.showWarningMessage(message);
        return;
      }
      notification = vscode.window.showWarningMessage(message, viewDetails);
    } else if (commits.length > 0) {
      const message = updatedRepoCount > 1
        ? t('VersionDock: {0} repositories updated {1} files in {2} commits.', updatedRepoCount, fileCount, commits.length)
        : t('VersionDock: Updated {0} files in {1} commits.', fileCount, commits.length);

      if (showUpdateNotification) {
        notification = vscode.window.showInformationMessage(message, viewDetails);
      }
    } else if (skipped.length > 0) {
      const skipItem = skipped[0];
      const noUpstreamMsg = t('Current branch has no upstream tracking branch.');
      if (skipItem.skippedReason === noUpstreamMsg) {
        const pushLabel = t('Push to Remote');
        void vscode.window.showWarningMessage(
          t('VersionDock: Update skipped because the current branch has no remote tracking branch.'),
          pushLabel
        ).then(async choice => {
          if (choice === pushLabel) {
            const repo = this.manager.getRepo(skipItem.repoId);
            if (repo) {
              await repo.push();
              vscode.window.showInformationMessage(t('VersionDock: Pushed and configured remote tracking.'));
            }
          }
        });
      } else {
        void vscode.window.showWarningMessage(t('VersionDock: Update skipped: {0}', skipItem.skippedReason ?? ''));
      }
      return;
    } else {
      void vscode.window.showInformationMessage(t('VersionDock: Already up to date. No files updated.'));
      return;
    }

    if (!notification) return;
    void Promise.resolve(notification).then(picked => {
      if (picked === viewDetails) {
        openDetailsPanel();
      }
    }).catch(error => {
      this.logger.error('UpdateSummary', 'Failed to handle update notification', error);
    });
  }

  private describeFailures(results: readonly TrackedUpdateResult[]): string {
    return results.map(result => {
      const name = this.manager.getRepoMeta(result.repoId)?.name ?? result.repoId;
      return `${name}: ${result.error ?? t('Unknown error')}`;
    }).join('; ');
  }
}
