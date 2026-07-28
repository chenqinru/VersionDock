import * as vscode from 'vscode';
import { WorkspaceVcsManager } from './vcs/WorkspaceVcsManager';
import { CommitPanelProvider } from './panels/CommitPanelProvider';
import { GitLogPanelProvider } from './panels/GitLogPanelProvider';
import { MergeEditorProvider } from './panels/MergeEditorProvider';
import { ConflictsPanelProvider } from './panels/ConflictsPanelProvider';
import { UndockedPanelProvider } from './panels/UndockedPanelProvider';
import { BranchStatusBar } from './ui/BranchStatusBar';
import { BadgeController } from './ui/BadgeController';
import { registerCommands } from './commands/registerCommands';
import { ShelveDocumentProvider } from './utils/ShelveDocumentProvider';
import { FileAnnotationController } from './ui/FileAnnotationController';
import { GitProfileService } from './git/GitProfileService';
import { ProfileStatusBar } from './ui/ProfileStatusBar';
import { t } from './utils/l10n';

async function showViewModeQuickpick(globalState: vscode.Memento): Promise<void> {
  const SHOWN_KEY = 'hasShownViewModeQuickpick';
  if (globalState.get<boolean>(SHOWN_KEY)) return;

  type Item = vscode.QuickPickItem & { value: string };
  const items: Item[] = [
    {
      label: `$(layout) ${t('Simplified')}`,
      description: t('Default'),
      detail: t('Staged and Unstaged sections grouped per repository'),
      value: 'simplified',
    },
    {
      label: `$(list-tree) ${t('Changelists')}`,
      description: t('PhpStorm-style'),
      detail: t('Files grouped into named changelists across repositories'),
      value: 'changelists',
    },
    {
      label: `$(source-control) ${t('VS Code')}`,
      description: t('Native-style'),
      detail: t('Staged Changes / Changes sections with inline stage/unstage buttons'),
      value: 'vscode',
    },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: t('VersionDock — Choose your preferred view mode'),
    placeHolder: t('Select how changed files are displayed (you can change this later in Settings)'),
    ignoreFocusOut: true,
  });

  await globalState.update(SHOWN_KEY, true);

  if (picked) {
    await vscode.workspace.getConfiguration('versiondock').update('changesViewMode', picked.value, vscode.ConfigurationTarget.Global);
  }
}

async function maybeNotifyUnpushedCommits(manager: WorkspaceVcsManager, commitPanel: CommitPanelProvider): Promise<void> {
  if (!vscode.workspace.getConfiguration('versiondock').get<boolean>('notifyOnUnpushedCommits', true)) return;

  // SVN commits are sent directly to the server and do not have a Git-style
  // "unpushed" state. Avoid invoking the inherited Git implementation for SVN
  // working copies during startup refresh.
  const metas = manager.getRepoMetas().filter(m => m.kind !== 'svn');
  const countResults = await Promise.allSettled(
    metas.map(async m => {
      const repo = manager.getRepo(m.id);
      return repo ? repo.getUnpushedCount() : 0;
    })
  );

  const counts = countResults
    .filter((r): r is PromiseFulfilledResult<number> => r.status === 'fulfilled')
    .map(r => r.value);

  const totalAhead = counts.reduce((sum, c) => sum + c, 0);
  if (totalAhead === 0) return;

  const reposWithAhead = counts.filter(c => c > 0).length;
  const message = reposWithAhead === 1
    ? (totalAhead === 1
      ? t('VersionDock: {0} unpushed commit ready to push.', totalAhead)
      : t('VersionDock: {0} unpushed commits ready to push.', totalAhead))
    : (totalAhead === 1
      ? t('VersionDock: {0} unpushed commit across {1} repository.', totalAhead, reposWithAhead)
      : t('VersionDock: {0} unpushed commits across {1} repositories.', totalAhead, reposWithAhead));

  const goToPush = t('Go to Push');
  const picked = await vscode.window.showInformationMessage(message, goToPush, t('Dismiss'));

  if (picked === goToPush) {
    await vscode.commands.executeCommand('versiondock.commitPanel.focus');
    commitPanel.switchToTab('push');
  }
}

async function maybeNotifyIncomingCommits(manager: WorkspaceVcsManager, globalState: vscode.Memento): Promise<void> {
  const DO_NOT_SHOW_KEY = 'doNotShowIncomingCommitsNotification';
  if (globalState.get<boolean>(DO_NOT_SHOW_KEY)) return;
  if (!vscode.workspace.getConfiguration('versiondock').get<boolean>('notifyOnIncomingCommits', true)) return;

  const metas = manager.getRepoMetas().filter(m => !m.isWorktree);
  const branchResults = await Promise.allSettled(
    metas.map(async m => {
      const repo = manager.getRepo(m.id);
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
    await globalState.update(DO_NOT_SHOW_KEY, true);
  } else if (picked === pull) {
    const metaById = new Map(metas.map(m => [m.id, m]));
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pulling…'), cancellable: false },
      async () => {
        const results = await manager.pullAll(false);
        const failed = results.filter(r => !r.ok);
        const ok = results.filter(r => r.ok);
        if (failed.length === 0) {
          vscode.window.showInformationMessage(
            ok.length === 1
              ? t('VersionDock: {0} repository updated.', ok.length)
              : t('VersionDock: {0} repositories updated.', ok.length)
          );
        } else {
          const failedDesc = failed.map(r => {
            const name = metaById.get(r.repoId)?.name ?? r.repoId;
            return `${name}: ${r.message}`;
          }).join('; ');
          vscode.window.showWarningMessage(
            `VersionDock: ${ok.length} updated, ${failed.length} failed: ${failedDesc}`
          );
        }
      }
    );
  }
}

async function runStartupRefresh(
  manager: WorkspaceVcsManager,
  badge: BadgeController,
  commitPanel: CommitPanelProvider,
  globalState: vscode.Memento,
): Promise<void> {
  try {
    const fetchOnStartup = vscode.workspace.getConfiguration('versiondock').get<boolean>('fetchOnStartup', false);
    if (fetchOnStartup) await manager.fetchAll();

    const status = await manager.getAllStatusesFresh();
    badge.update(status);
    await maybeNotifyIncomingCommits(manager, globalState);
    await maybeNotifyUnpushedCommits(manager, commitPanel);
  } catch (error) {
    console.error('[VersionDock] Startup refresh failed:', error);
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const manager = new WorkspaceVcsManager(context);

  // DEV ONLY: uncomment to reset the quickpick flag
  //context.globalState.update('hasShownViewModeQuickpick', false);

  const shelveDocProvider = new ShelveDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ShelveDocumentProvider.scheme, shelveDocProvider),
    shelveDocProvider,
  );

  const badge = new BadgeController();
  badge.startLoading();

  const log = vscode.window.createOutputChannel(t('VersionDock Profiles'));
  context.subscriptions.push(log);

  const profileService = new GitProfileService(context, log);

  const commitPanel = new CommitPanelProvider(context.extensionUri, manager, context.globalStorageUri.fsPath, shelveDocProvider, undefined, profileService, context.globalState, context.workspaceState);

  const logPanel = new GitLogPanelProvider(context.extensionUri, manager, shelveDocProvider);
  const mergeEditor = new MergeEditorProvider(context.extensionUri, manager);
  const conflictsPanel = new ConflictsPanelProvider(context.extensionUri, manager, mergeEditor);
  const undockedPanel = new UndockedPanelProvider(context.extensionUri, commitPanel, logPanel);
  commitPanel.setMergeEditorProvider(mergeEditor);
  commitPanel.setLogProvider(logPanel);
  commitPanel.setBadgeController(badge);
  commitPanel.setUndockedPanel(undockedPanel);
  logPanel.setCommitPanel(commitPanel);
  logPanel.setUndockedPanel(undockedPanel);

  // Apply saved hidden repos immediately, before either webview opens.
  const savedHidden = manager.normalizeRepoIds(context.workspaceState.get<string[]>('versiondock.hiddenRepoIds', []));
  if (savedHidden.length > 0) {
    badge.setHiddenRepoIds(savedHidden);
    logPanel.notifyHiddenReposChanged(savedHidden);
  }

  const branchStatusBar = new BranchStatusBar(manager, () => {
    vscode.commands.executeCommand('versiondock.commitPanel.focus');
  });

  const profileStatusBar = new ProfileStatusBar(profileService, manager);

  const annotationController = new FileAnnotationController(manager, logPanel);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(CommitPanelProvider.viewType, commitPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(GitLogPanelProvider.viewType, logPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewPanelSerializer(UndockedPanelProvider.viewType, {
      deserializeWebviewPanel(panel: vscode.WebviewPanel): Thenable<void> {
        panel.dispose();
        return Promise.resolve();
      },
    }),
    manager,
    badge,
    commitPanel,
    logPanel,
    mergeEditor,
    conflictsPanel,
    undockedPanel,
    branchStatusBar,
    profileStatusBar,
    profileService,
    annotationController,
  );

  registerCommands(context, commitPanel, logPanel, mergeEditor, conflictsPanel, branchStatusBar, annotationController, profileStatusBar, manager);
  // The first-run preference prompt must not block extension activation. Until
  // activation resolves, contributed commands and views are unavailable.
  void showViewModeQuickpick(context.globalState).catch(error => {
    console.error('[VersionDock] Failed to show the view-mode picker:', error);
  });
  void runStartupRefresh(manager, badge, commitPanel, context.globalState);
}

export function deactivate(): void {}
