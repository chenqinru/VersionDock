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
import { IncomingCommitsNotifier } from './update/IncomingCommitsNotifier';
import { UnpushedCommitsNotifier } from './update/UnpushedCommitsNotifier';

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

async function maybeNotifyConflicts(manager: WorkspaceVcsManager, status: WorkspaceStatus): Promise<void> {
  const conflictingRepos = status.repos.filter(repo => repo.conflictCount > 0);
  if (conflictingRepos.length === 0) return;

  const repoName = conflictingRepos.length === 1
    ? (manager.getRepoMeta(conflictingRepos[0].repoId)?.name ?? conflictingRepos[0].repoId)
    : undefined;

  const title = repoName
    ? t('VersionDock [{0}]: Merge conflicts detected. Use the Merge Editor to resolve them.', repoName)
    : t('VersionDock: Merge conflicts detected. Use the Merge Editor to resolve them.');

  const picked = await vscode.window.showWarningMessage(
    title,
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
  incomingCommitsNotifier: IncomingCommitsNotifier,
  unpushedCommitsNotifier: UnpushedCommitsNotifier,
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
    logger.info('Startup', 'Repository refresh completed', {
      repositoryCount: status.repos.length,
      durationMs: Date.now() - startedAt,
    });

    // Run notifications asynchronously in background so startup lifecycle and UI spinners finish immediately
    void maybeNotifyConflicts(manager, status).catch(err => logger.error('Startup', 'Failed to notify conflicts', err));
    void incomingCommitsNotifier.checkAndNotify().catch(err => logger.error('Startup', 'Failed to check incoming commits', err));
    void unpushedCommitsNotifier.checkAndNotify().catch(err => logger.error('Startup', 'Failed to check unpushed commits', err));
  } catch (error) {
    logger.error('Startup', 'Repository refresh failed', error, {
      durationMs: Date.now() - startedAt,
    });
    badge.stopLoading();
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

  const incomingCommitsNotifier = new IncomingCommitsNotifier(
    manager,
    context.globalState,
    updateSummaryService,
    logger,
  );

  const commitPanel = new CommitPanelProvider(context.extensionUri, manager, context.globalStorageUri.fsPath, shelveDocProvider, aiCommitMessageService, undefined, profileService, context.globalState, context.workspaceState, logger, updateSummaryService);

  const unpushedCommitsNotifier = new UnpushedCommitsNotifier(
    manager,
    commitPanel,
    logger,
  );

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
    incomingCommitsNotifier,
    unpushedCommitsNotifier,
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
  void runStartupRefresh(manager, badge, commitPanel, context.globalState, logger, updateSummaryService, incomingCommitsNotifier, unpushedCommitsNotifier);
}

export function deactivate(): void {}
