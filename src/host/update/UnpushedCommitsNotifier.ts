import * as vscode from 'vscode';
import type { WorkspaceVcsManager } from '../vcs/WorkspaceVcsManager';
import type { CommitPanelProvider } from '../panels/CommitPanelProvider';
import type { VersionDockLogger } from '../utils/Logger';
import { t } from '../utils/l10n';

const STARTUP_WINDOW_MS = 3 * 60 * 1000;
const DEBOUNCE_DELAY_MS = 500;

export class UnpushedCommitsNotifier implements vscode.Disposable {
  private hasNotifiedThisSession = false;
  private isChecking = false;
  private startupListeners: vscode.Disposable[] = [];
  private debounceTimer: NodeJS.Timeout | null = null;
  private startupExpirationTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(
    private readonly manager: WorkspaceVcsManager,
    private readonly commitPanel: CommitPanelProvider,
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
    if (!vscode.workspace.getConfiguration('versiondock').get<boolean>('notifyOnUnpushedCommits', true)) return true;
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
      const metas = this.manager.getRepoMetas().filter(m => m.kind !== 'svn' && !m.isWorktree);
      if (metas.length === 0) return;

      const countResults = await Promise.allSettled(
        metas.map(async m => {
          const repo = this.manager.getRepo(m.id);
          return repo ? repo.getUnpushedCount() : 0;
        })
      );

      const counts = countResults
        .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
        .map(r => r.value);

      const totalAhead = counts.reduce((sum, c) => sum + c, 0);
      if (totalAhead === 0) return;

      this.hasNotifiedThisSession = true;
      this.cleanupStartupListeners();

      const reposWithAhead = counts.filter(c => c > 0).length;
      const singleRepo = reposWithAhead === 1
        ? metas.find((_, i) => {
          const r = countResults[i];
          return r.status === 'fulfilled' && r.value > 0;
        })
        : undefined;
      const singleRepoName = singleRepo?.name;
      const message = singleRepoName
        ? (totalAhead === 1
          ? t('VersionDock [{0}]: {1} unpushed commit ready to push.', singleRepoName, totalAhead)
          : t('VersionDock [{0}]: {1} unpushed commits ready to push.', singleRepoName, totalAhead))
        : (totalAhead === 1
          ? t('VersionDock: {0} unpushed commit across {1} repository.', totalAhead, reposWithAhead)
          : t('VersionDock: {0} unpushed commits across {1} repositories.', totalAhead, reposWithAhead));

      const goToPush = t('Go to Push');
      const picked = await vscode.window.showInformationMessage(message, goToPush, t('Dismiss'));

      if (picked === goToPush) {
        await vscode.commands.executeCommand('versiondock.commitPanel.focus');
        this.commitPanel.switchToTab('push');
      }
    } catch (error) {
      this.logger.error('UnpushedCommitsNotifier', 'Failed to check or notify unpushed commits', error);
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
