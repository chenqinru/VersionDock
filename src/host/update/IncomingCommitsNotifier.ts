import * as vscode from 'vscode';
import type { WorkspaceVcsManager } from '../vcs/WorkspaceVcsManager';
import type { UpdateSummaryService } from './UpdateSummaryService';
import type { VersionDockLogger } from '../utils/Logger';
import { t } from '../utils/l10n';

export const DO_NOT_SHOW_INCOMING_KEY = 'doNotShowIncomingCommitsNotification';
const STARTUP_WINDOW_MS = 3 * 60 * 1000;
const DEBOUNCE_DELAY_MS = 500;

export class IncomingCommitsNotifier implements vscode.Disposable {
  private hasNotifiedThisSession = false;
  private isChecking = false;
  private startupListeners: vscode.Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private startupExpirationTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly manager: WorkspaceVcsManager,
    private readonly globalState: vscode.Memento,
    private readonly updateSummaryService: UpdateSummaryService,
    private readonly logger: VersionDockLogger,
  ) {
    this.setupStartupListeners();
  }

  private setupStartupListeners(): void {
    if (this.isNotificationDisabled()) {
      return;
    }

    const onEvent = () => this.scheduleCheck();

    this.startupListeners.push(
      this.manager.onStatusChange(onEvent),
      this.manager.onBranchChange(onEvent),
    );

    this.startupExpirationTimer = setTimeout(() => {
      this.cleanupStartupListeners();
    }, STARTUP_WINDOW_MS);
  }

  private scheduleCheck(): void {
    if (this.disposed || this.hasNotifiedThisSession || this.isNotificationDisabled()) {
      this.cleanupStartupListeners();
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      void this.checkAndNotify();
    }, DEBOUNCE_DELAY_MS);
  }

  public isNotificationDisabled(): boolean {
    if (this.globalState.get<boolean>(DO_NOT_SHOW_INCOMING_KEY)) return true;
    if (!vscode.workspace.getConfiguration('versiondock').get<boolean>('notifyOnIncomingCommits', true)) return true;
    return false;
  }

  public async checkAndNotify(): Promise<void> {
    if (this.disposed || this.hasNotifiedThisSession || this.isChecking) return;
    if (this.isNotificationDisabled()) {
      this.cleanupStartupListeners();
      return;
    }

    this.isChecking = true;
    try {
      const metas = this.manager.getRepoMetas().filter(m => !m.isWorktree);
      if (metas.length === 0) return;

      const branchResults = await Promise.allSettled(
        metas.map(async m => {
          const repo = this.manager.getRepo(m.id);
          return repo ? repo.getCurrentBranch() : null;
        })
      );

      type BranchInfo = Awaited<ReturnType<NonNullable<ReturnType<WorkspaceVcsManager['getRepo']>>['getCurrentBranch']>>;
      const branches = branchResults
        .filter((r): r is PromiseFulfilledResult<BranchInfo | null> => r.status === 'fulfilled')
        .map(r => r.value)
        .filter((b): b is BranchInfo => b !== null);

      const totalBehind = branches.reduce((sum, b) => sum + (b.aheadBehind?.behind ?? 0), 0);
      if (totalBehind === 0) return;

      this.hasNotifiedThisSession = true;
      this.cleanupStartupListeners();

      const reposWithBehind = branches.filter(b => (b.aheadBehind?.behind ?? 0) > 0).length;
      const message = reposWithBehind === 1
        ? (totalBehind === 1
          ? t('VersionDock: {0} incoming commit available to pull.', totalBehind)
          : t('VersionDock: {0} incoming commits available to pull.', totalBehind))
        : (totalBehind === 1
          ? t('VersionDock: {0} incoming commit across {1} repository.', totalBehind, reposWithBehind)
          : t('VersionDock: {0} incoming commits across {1} repositories.', totalBehind, reposWithBehind));

      const pull = t('Pull');
      const dismiss = t('Dismiss');
      const doNotShow = t("Don't show again");

      const picked = await vscode.window.showInformationMessage(message, pull, dismiss, doNotShow);

      if (picked === doNotShow) {
        await this.globalState.update(DO_NOT_SHOW_INCOMING_KEY, true);
      } else if (picked === pull) {
        let results: Awaited<ReturnType<UpdateSummaryService['runAll']>> = [];
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pulling…'), cancellable: false },
          async () => {
            results = await this.updateSummaryService.runAll(metas.map(meta => ({
              repoId: meta.id,
              execute: repo => repo.pull(),
            })));
          }
        );
        this.manager.notifyBranchesChanged();
        await this.updateSummaryService.notify(results);
      }
    } catch (error) {
      this.logger.error('IncomingCommitsNotifier', 'Failed to check or notify incoming commits', error);
    } finally {
      this.isChecking = false;
    }
  }

  private cleanupStartupListeners(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.startupExpirationTimer) {
      clearTimeout(this.startupExpirationTimer);
      this.startupExpirationTimer = null;
    }
    for (const d of this.startupListeners) {
      d.dispose();
    }
    this.startupListeners = [];
  }

  public dispose(): void {
    this.disposed = true;
    this.cleanupStartupListeners();
  }
}
