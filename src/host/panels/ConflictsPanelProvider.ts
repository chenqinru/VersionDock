import * as vscode from 'vscode';
import { registerWebviewScrollbars } from '../utils/webviewScrollbars';
import * as path from 'path';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { getWebviewHtml } from '../utils/webviewHtml';
import { loadIconTheme } from '../utils/IconThemeService';
import type { ConflictsToHostMsg, ConflictListFile, HostToConflictsMsg } from '../types/messages';
import type { MergeEditorProvider } from './MergeEditorProvider';
import { t } from '../utils/l10n';
import { showGitErrorMessage } from '../utils/gitError';
import type { VersionDockLogger } from '../utils/Logger';

export class ConflictsPanelProvider implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private disposables: vscode.Disposable[] = [];
  private refreshGeneration = 0;
  private autoStashCleanupPrompts = new Set<string>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly mergeEditorProvider: MergeEditorProvider,
    private readonly logger: VersionDockLogger,
  ) {
    this.disposables.push(this.manager.onStatusChange(() => {
      if (!this.panel) return;
      void this.refresh().catch(error => this.logger.error('ConflictsPanel', 'Failed to refresh after repository status change', error));
    }));
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal();
      void this.refresh().catch(error => this.logger.error('ConflictsPanel', 'Failed to refresh panel', error));
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'versiondock.conflicts',
      t('Conflicts'),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          this.extensionUri,
          vscode.Uri.file(vscode.env.appRoot),
          ...vscode.extensions.all.map(e => vscode.Uri.file(e.extensionPath)),
        ],
      },
    );
    panel.iconPath = new vscode.ThemeIcon('warning');

    registerWebviewScrollbars(panel);
    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'conflicts', t('Conflicts'));
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
        void this.refresh().catch(error => this.logger.error('ConflictsPanel', 'Failed to refresh theme data', error));
      }
    });
    panel.webview.onDidReceiveMessage((msg: ConflictsToHostMsg) => {
      void this.handleMessage(msg).catch(error => {
        this.logger.error('ConflictsPanel', 'Webview message failed', error, { messageType: msg.type });
      });
    });
    panel.onDidDispose(() => {
      configWatcher.dispose();
      this.panel = undefined;
      this.logger.debug('ConflictsPanel', 'Panel closed');
    });
    this.panel = panel;
    this.logger.info('ConflictsPanel', 'Panel opened');
    void this.refresh().catch(error => this.logger.error('ConflictsPanel', 'Failed to initialize panel', error));
  }

  async refresh(): Promise<void> {
    if (!this.panel) return;
    const generation = ++this.refreshGeneration;
    const startedAt = Date.now();
    const [status, states, iconTheme] = await Promise.all([
      this.manager.getAllStatusesFresh(),
      Promise.all(this.manager.getRepoMetas().map(async meta => {
        const repo = this.manager.getRepo(meta.id);
        return repo ? repo.getMergeRebaseState().catch(() => null) : null;
      })),
      loadIconTheme(this.panel.webview).catch(() => undefined),
    ]);
    const metaMap = new Map(this.manager.getRepoMetas().map(meta => [meta.id, meta]));
    const pendingAutoStashes = new Map(this.manager.getRepoMetas().flatMap(meta => {
      const pending = this.manager.getRepo(meta.id)?.getPendingPullAutoStash();
      return pending ? [[meta.id, pending] as const] : [];
    }));
    const files: ConflictListFile[] = [];
    for (const repoStatus of status.repos) {
      const meta = metaMap.get(repoStatus.repoId);
      const repo = this.manager.getRepo(repoStatus.repoId);
      const conflictStatuses = await repo?.getConflictFileStatuses().catch(() => new Map()) ?? new Map();
      const seen = new Set<string>();
      for (const file of [...repoStatus.unstagedFiles, ...repoStatus.stagedFiles]) {
        if (file.status !== 'conflicted' || seen.has(file.path)) continue;
        seen.add(file.path);
        const sideStatus = conflictStatuses.get(file.path) ?? { currentStatus: 'modified' as const, incomingStatus: 'modified' as const };
        files.push({
          repoId: repoStatus.repoId,
          repoName: meta?.name ?? path.basename(repoStatus.repoId),
          repoColor: meta?.color ?? '#4ec9b0',
          path: file.path,
          absolutePath: file.absolutePath,
          currentStatus: sideStatus.currentStatus,
          incomingStatus: sideStatus.incomingStatus,
          nodeKind: sideStatus.nodeKind,
          conflictType: sideStatus.conflictType,
          conflictTypes: sideStatus.conflictTypes,
          propertyConflicts: sideStatus.propertyConflicts,
        });
      }
    }

    if (!this.panel || generation !== this.refreshGeneration) return;
    const hasAutoStashConflicts = status.repos.some(repoStatus =>
      repoStatus.conflictCount > 0 && pendingAutoStashes.has(repoStatus.repoId)
    );
    this.post({
      type: 'CONFLICTS_DATA',
      files,
      isMerging: states.some(Boolean) || hasAutoStashConflicts,
      operationLabel: hasAutoStashConflicts
        ? t('Restoring local changes after update')
        : states.some(state => state === 'rebase') ? t('Rebase in progress') : t('Merge in progress'),
      iconTheme,
    });
    this.logger.debug('ConflictsPanel', 'Conflict data refreshed', {
      repositoryCount: status.repos.length,
      conflictFileCount: files.length,
      durationMs: Date.now() - startedAt,
    });
    await this.offerAutoStashCleanup(status.repos, pendingAutoStashes, metaMap);
  }

  private async offerAutoStashCleanup(
    statuses: Awaited<ReturnType<WorkspaceGitManager['getAllStatusesFresh']>>['repos'],
    pendingAutoStashes: ReadonlyMap<string, { hash: string; shortHash: string }>,
    metaMap: ReadonlyMap<string, ReturnType<WorkspaceGitManager['getRepoMetas']>[number]>,
  ): Promise<void> {
    for (const status of statuses) {
      const pending = pendingAutoStashes.get(status.repoId);
      if (!pending || status.conflictCount > 0) continue;
      const promptKey = `${status.repoId}\0${pending.hash}`;
      if (this.autoStashCleanupPrompts.has(promptKey)) continue;
      this.autoStashCleanupPrompts.add(promptKey);

      const repo = this.manager.getRepo(status.repoId);
      if (!repo) continue;
      const repoName = metaMap.get(status.repoId)?.name ?? status.repoId;
      const deleteBackup = t('Delete Backup');
      const keepBackup = t('Keep in Stash');
      const picked = await vscode.window.showInformationMessage(
        t(
          'VersionDock [{0}]: All conflicts from restoring local changes are resolved. Delete auto-stash backup {1}?',
          repoName,
          pending.shortHash,
        ),
        deleteBackup,
        keepBackup,
      );

      if (picked === deleteBackup) {
        try {
          const dropped = await repo.dropPendingPullAutoStash();
          if (dropped) {
            vscode.window.showInformationMessage(
              t('VersionDock [{0}]: Auto-stash backup {1} deleted.', repoName, pending.shortHash),
            );
            await vscode.commands.executeCommand('versiondock.refreshCommitPanel');
          }
        } catch (error: unknown) {
          void showGitErrorMessage(
            t('VersionDock [{0}]: Could not delete auto-stash backup {1}: {2}', repoName, pending.shortHash, String(error)),
            {
              repoName,
              onUnlocked: async () => {
                await this.manager.getAllStatusesFresh();
              },
            }
          );
        }
      } else {
        // Dismiss and explicit keep both retain the stash without repeatedly
        // prompting during subsequent status refreshes.
        repo.clearPendingPullAutoStash();
      }
    }
  }

  private post(msg: HostToConflictsMsg): void {
    this.panel?.webview.postMessage(msg);
  }

  private async handleMessage(msg: ConflictsToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'CONFLICTS_WEBVIEW_ERROR':
        this.logger.error('ConflictsWebview', msg.message, msg.stack, { componentStack: msg.componentStack });
        break;
      case 'CONFLICTS_REQUEST_DATA':
        await this.refresh();
        break;
      case 'CONFLICTS_OPEN_MERGE_EDITOR': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        if (repo.kind === 'svn') {
          const conflict = (await repo.getConflictFileStatuses().catch(() => new Map())).get(msg.filePath);
          if (msg.filePath === '.' || (conflict && (conflict.nodeKind === 'directory' || conflict.conflictType !== 'text'))) {
            vscode.window.showInformationMessage(
              t('VersionDock [{0}]: SVN property and directory conflicts cannot be opened in the text merge editor. Use a conflict action instead.', repo.meta.name),
            );
            return;
          }
        }
        const resolvedPath = repo.resolveRepoPath(msg.filePath, { allowRoot: repo.kind === 'svn' });
        this.mergeEditorProvider.openForFile(resolvedPath.absolutePath, msg.repoId, resolvedPath.relativePath);
        break;
      }
      case 'CONFLICTS_ACCEPT_OURS':
      case 'CONFLICTS_ACCEPT_THEIRS': {
        const startedAt = Date.now();
        const strategy = msg.type === 'CONFLICTS_ACCEPT_OURS' ? 'current' : 'incoming';
        try {
          const targets = new Map<string, { repo: NonNullable<ReturnType<WorkspaceGitManager['getRepo']>>; paths: string[] }>();
          for (const file of msg.files) {
            const repo = this.manager.getRepo(file.repoId);
            if (!repo) throw new Error(t('Repo not found'));
            const resolvedPath = repo.resolveRepoPath(file.path, { allowRoot: repo.kind === 'svn' });
            const relativePath = repo.kind === 'svn' && !resolvedPath.relativePath ? '.' : resolvedPath.relativePath;
            const target = targets.get(file.repoId);
            if (target) target.paths.push(relativePath);
            else targets.set(file.repoId, { repo, paths: [relativePath] });
          }
          for (const { repo, paths } of targets.values()) {
            await repo.runWithGitWriteLock(async () => {
              for (const relativePath of paths) {
                if (msg.type === 'CONFLICTS_ACCEPT_OURS') await repo.acceptOurs(relativePath);
                else await repo.acceptTheirs(relativePath);
              }
            });
          }
          this.post({ type: 'CONFLICTS_OP_RESULT', requestId: msg.requestId, ok: true });
          this.logger.info('ConflictsPanel', 'Conflict files accepted', {
            strategy,
            fileCount: msg.files.length,
            durationMs: Date.now() - startedAt,
          });
          await this.refresh();
          await vscode.commands.executeCommand('versiondock.refreshCommitPanel');
        } catch (e: unknown) {
          this.logger.error('ConflictsPanel', 'Failed to accept conflict files', e, {
            strategy,
            fileCount: msg.files.length,
            durationMs: Date.now() - startedAt,
          });
          this.post({ type: 'CONFLICTS_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach(d => d.dispose());
  }
}
