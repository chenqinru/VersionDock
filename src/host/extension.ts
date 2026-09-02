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
import { VersionDockLogger } from './utils/Logger';
import { AiProviderService } from './ai/AiProviderService';
import { AiCommitMessageService } from './aiCommitMessage/AiCommitMessageService';
import { AiMergeConflictService } from './aiMergeConflict/AiMergeConflictService';
import { AiCommitExplanationService } from './aiCommitExplanation/AiCommitExplanationService';
import { AiCommitComposerService } from './aiCommitComposer/AiCommitComposerService';
import { AiCommitComposerProvider } from './panels/AiCommitComposerProvider';
import { AiCodeReviewService } from './aiCodeReview/AiCodeReviewService';
import { AiCodeReviewProvider } from './panels/AiCodeReviewProvider';
import { RemoteRepositoryService } from './remote/RemoteRepositoryService';
import type { WorkspaceStatus } from './types/git';
import { UpdateSummaryService } from './update/UpdateSummaryService';

async function maybeResetViewLocationsOnStartup(logger: VersionDockLogger): Promise<void> {
  const enabled = vscode.workspace.getConfiguration('versiondock').get<boolean>('resetViewLocationsOnStartup', false);
  if (!enabled) return;

  try {
    await vscode.commands.executeCommand('workbench.action.resetViewLocations');
    logger.info('Startup', 'Reset view locations');
  } catch (error) {
    logger.error('Startup', 'Failed to reset view locations', error);
  }
}

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

async function maybeNotifyIncomingCommits(
  manager: WorkspaceVcsManager,
  globalState: vscode.Memento,
  updateSummaryService: UpdateSummaryService,
): Promise<void> {
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
    let results: Awaited<ReturnType<UpdateSummaryService['runAll']>> = [];
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pulling…'), cancellable: false },
      async () => {
        results = await updateSummaryService.runAll(metas.map(meta => ({
          repoId: meta.id,
          execute: repo => repo.pull(),
        })));
      }
    );
    manager.notifyBranchesChanged();
    await updateSummaryService.notify(results);
  }
}

async function maybeNotifyConflicts(status: WorkspaceStatus): Promise<void> {
  const conflictCount = status.repos.reduce((total, repo) => total + repo.conflictCount, 0);
  if (conflictCount === 0) return;

  const picked = await vscode.window.showWarningMessage(
    t('VersionDock: Merge conflicts detected. Use the Merge Editor to resolve them.'),
    t('Open Merge List'),
  );
  if (picked === t('Open Merge List')) {
    await vscode.commands.executeCommand('versiondock.openConflicts');
  }
}

async function runStartupRefresh(
  manager: WorkspaceVcsManager,
  badge: BadgeController,
  commitPanel: CommitPanelProvider,
  globalState: vscode.Memento,
  logger: VersionDockLogger,
  updateSummaryService: UpdateSummaryService,
): Promise<void> {
  const startedAt = Date.now();
  const fetchOnStartup = vscode.workspace.getConfiguration('versiondock').get<boolean>('fetchOnStartup', false);
  logger.info('Startup', 'Refreshing repository state', {
    repositoryCount: manager.getRepoMetas().length,
    fetchOnStartup,
  });
  try {
    if (fetchOnStartup) await manager.fetchAll();

    const status = await manager.getAllStatusesFresh();
    badge.update(status);
    await maybeNotifyConflicts(status);
    await maybeNotifyIncomingCommits(manager, globalState, updateSummaryService);
    await maybeNotifyUnpushedCommits(manager, commitPanel);
    logger.info('Startup', 'Repository refresh completed', {
      repositoryCount: status.repos.length,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    logger.error('Startup', 'Repository refresh failed', error, {
      durationMs: Date.now() - startedAt,
    });
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const logger = new VersionDockLogger();
  context.subscriptions.push(logger);
  logger.info('Extension', 'Activating', {
    workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0,
  });

  // Set default menu toggle contexts immediately on activation
  void vscode.commands.executeCommand('setContext', 'versiondock.isExpanded', true);
  void vscode.commands.executeCommand('setContext', 'versiondock.isCollapsed', false);
  const initialFileViewMode = context.globalState.get<'flat' | 'tree'>('fileViewMode', 'tree') ?? 'tree';
  void vscode.commands.executeCommand('setContext', 'versiondock.isTreeFileView', initialFileViewMode === 'tree');
  void vscode.commands.executeCommand('setContext', 'versiondock.isFlatFileView', initialFileViewMode === 'flat');

  await maybeResetViewLocationsOnStartup(logger);

  const remoteRepositoryService = new RemoteRepositoryService(context, logger);
  const manager = new WorkspaceVcsManager(context, logger, remoteRepositoryService.publishMissingRemote);

  // DEV ONLY: uncomment to reset the quickpick flag
  //context.globalState.update('hasShownViewModeQuickpick', false);

  const shelveDocProvider = new ShelveDocumentProvider();
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ShelveDocumentProvider.scheme, shelveDocProvider),
    shelveDocProvider,
  );

  const badge = new BadgeController();
  badge.startLoading();

  const profileService = new GitProfileService(context, logger);
  const aiProviderService = new AiProviderService();
  const aiCommitMessageService = new AiCommitMessageService(context, aiProviderService);
  const aiMergeConflictService = new AiMergeConflictService(context, aiProviderService, logger);
  const aiCommitExplanationService = new AiCommitExplanationService(context, aiProviderService);
  const aiCommitComposerService = new AiCommitComposerService(context, aiProviderService, logger);
  const aiCodeReviewService = new AiCodeReviewService(context, aiProviderService);
  const updateSummaryService = new UpdateSummaryService(
    context.extensionUri,
    manager,
    aiCommitExplanationService,
    logger,
    context.globalStorageUri.fsPath,
  );

  const commitPanel = new CommitPanelProvider(context.extensionUri, manager, context.globalStorageUri.fsPath, shelveDocProvider, aiCommitMessageService, undefined, profileService, context.globalState, context.workspaceState, logger, updateSummaryService);

  const logPanel = new GitLogPanelProvider(context.extensionUri, manager, shelveDocProvider, aiCommitMessageService, aiCommitExplanationService, logger, updateSummaryService);
  const mergeEditor = new MergeEditorProvider(context.extensionUri, manager, aiMergeConflictService, logger);
  const conflictsPanel = new ConflictsPanelProvider(context.extensionUri, manager, mergeEditor, logger);
  const aiCommitComposer = new AiCommitComposerProvider(context.extensionUri, manager, aiCommitComposerService, aiCommitMessageService, logger);
  const aiCodeReview = new AiCodeReviewProvider(context.extensionUri, manager, aiCodeReviewService, commitPanel, logger);
  const undockedPanel = new UndockedPanelProvider(context.extensionUri, commitPanel, logPanel, logger);
  commitPanel.setMergeEditorProvider(mergeEditor);
  commitPanel.setLogProvider(logPanel);
  commitPanel.setBadgeController(badge);
  commitPanel.setUndockedPanel(undockedPanel);
  logPanel.setCommitPanel(commitPanel);
  logPanel.setUndockedPanel(undockedPanel);
  commitPanel.setAiCommitComposerProvider(aiCommitComposer);
  commitPanel.setAiCodeReviewProvider(aiCodeReview);
  logPanel.setAiCommitComposerProvider(aiCommitComposer);

  // Apply saved hidden repos immediately, before either webview opens.
  const savedHidden = manager.normalizeRepoIds(context.workspaceState.get<string[]>('versiondock.hiddenRepoIds', []));
  if (savedHidden.length > 0) {
    badge.setHiddenRepoIds(savedHidden);
    logPanel.notifyHiddenReposChanged(savedHidden);
  }

  const branchStatusBar = new BranchStatusBar(manager, () => {
    vscode.commands.executeCommand('versiondock.commitPanel.focus');
  }, logger, updateSummaryService);

  const profileStatusBar = new ProfileStatusBar(profileService, manager, logger);

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
    aiCommitComposer,
    aiCodeReview,
    undockedPanel,
    branchStatusBar,
    profileStatusBar,
    profileService,
    remoteRepositoryService,
    annotationController,
    vscode.commands.registerCommand('versiondock.manageRemoteAccounts', () => remoteRepositoryService.manageAccounts()),
    vscode.commands.registerCommand('versiondock.aiCommitMessage.editPrompt', () => aiCommitMessageService.editPrompt()),
    vscode.commands.registerCommand('versiondock.aiCommitMessage.resetPrompt', () => aiCommitMessageService.resetPrompt()),
    vscode.commands.registerCommand('versiondock.aiMergeConflict.editPrompt', () => aiMergeConflictService.editPrompt()),
    vscode.commands.registerCommand('versiondock.aiMergeConflict.resetPrompt', () => aiMergeConflictService.resetPrompt()),
    vscode.commands.registerCommand('versiondock.aiCommitExplanation.editPrompt', () => aiCommitExplanationService.editPrompt()),
    vscode.commands.registerCommand('versiondock.aiCommitExplanation.resetPrompt', () => aiCommitExplanationService.resetPrompt()),
    vscode.commands.registerCommand('versiondock.aiCommitComposer.editPrompt', () => aiCommitComposer.editPrompt()),
    vscode.commands.registerCommand('versiondock.aiCommitComposer.resetPrompt', () => aiCommitComposer.resetPrompt()),
    vscode.commands.registerCommand('versiondock.aiCodeReview.editPrompt', () => aiCodeReview.editPrompt()),
    vscode.commands.registerCommand('versiondock.aiCodeReview.resetPrompt', () => aiCodeReview.resetPrompt()),
  );

  registerCommands(context, commitPanel, logPanel, mergeEditor, conflictsPanel, branchStatusBar, annotationController, profileStatusBar, manager);
  // The first-run preference prompt must not block extension activation. Until
  // activation resolves, contributed commands and views are unavailable.
  void showViewModeQuickpick(context.globalState).catch(error => {
    logger.error('Extension', 'Failed to show the view-mode picker', error);
  });
  const metas = manager.getRepoMetas();
  logger.info('Extension', 'Activated', {
    repositoryCount: metas.length,
    gitRepositoryCount: metas.filter(meta => meta.kind !== 'svn').length,
    svnRepositoryCount: metas.filter(meta => meta.kind === 'svn').length,
  });
  void runStartupRefresh(manager, badge, commitPanel, context.globalState, logger, updateSummaryService);
}

export function deactivate(): void {}
