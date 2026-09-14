import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager, buildRepoId, type DataInvalidationEvent } from '../git/WorkspaceGitManager';
import { type GitService, parseGitmodulesFileSync, parseGitConfigEntries } from '../git/GitService';
import { ShelveService } from '../git/ShelveService';
import { ChangelistService } from '../git/ChangelistService';
import { ShelveDocumentProvider, applyPatchToContent, extractBaseAndTargetFromPatch } from '../utils/ShelveDocumentProvider';
import type { CommitGenerateMessageTarget, CommitPanelTab, CommitToHostMsg, HostToCommitMsg, LayoutDensity, SubtreeEntry, SubtreeOp, SubtreePushStatus, SyncPullStrategy } from '../types/messages';
import type { FileDiff, FileStatus, RepoMeta, RepoStatus, WorkspaceStatus } from '../types/git';
import { CHANGELIST_UNVERSIONED_ID } from '../types/git';
import { loadIconTheme } from '../utils/IconThemeService';
import type { MergeEditorProvider } from './MergeEditorProvider';
import type { GitLogPanelProvider } from './GitLogPanelProvider';
import type { UndockedPanelProvider } from './UndockedPanelProvider';
import { openSquashEditor } from './SquashEditorPanel';
import { openEditMessageEditor } from './EditMessageEditorPanel';
import type { GitProfileService } from '../git/GitProfileService';
import type { SvnIgnoreEntry, SvnIgnoreUpdateResult } from '../svn/SvnService';
import { t } from '../utils/l10n';
import { showGitErrorMessage } from '../utils/gitError';
import { collectAbortOperationTargets, runAbortOperationFlow } from '../utils/abortOperation';
import { toGitUri } from '../utils/resourceUri';
import { assertNoSymlinkAncestors } from '../utils/repoPath';
import type { VersionDockLogger } from '../utils/Logger';
import type { AiCommitMessageService } from '../aiCommitMessage/AiCommitMessageService';
import type { AiCommitMessageGenerationContext } from '../aiCommitMessage/types';
import { generateHistoricalCommitMessage } from '../aiCommitMessage/generateHistoricalCommitMessage';
import type { AiCommitComposerProvider } from './AiCommitComposerProvider';
import type { AiCodeReviewProvider } from './AiCodeReviewProvider';
import type { CodeReviewDiffSource } from '../aiCodeReview/types';
import { buildDiffDetailBlocks, formatDiffStats, countDiffChanges } from '../ai/diffContext';
import { buildFairContext, getFairDetailBlockTokenBudget, type FairContextGroup } from '../ai/fairContext';
import { getContextTokenBudget } from '../ai/inputTokenBudget';
import { isRemoteRepositoryCancelled } from '../remote/types';
import { runPushWithProtection } from '../utils/pushProtection';
import { withGitPushProgress } from '../utils/pushProgress';
import type { UpdateSummaryService, TrackedUpdateResult } from '../update/UpdateSummaryService';
import type { BranchStatusBar } from '../ui/BranchStatusBar';
import { checkCommitSafety, isSensitivePath } from '../utils/commitSafetyCheck';
import { sanitizeBranchName, validateBranchNameInput, getBranchCleanCharacter } from '../utils/branchNameSanitizer';
import { buildPullRequestUrl } from '../utils/prUrlHelper';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const AI_COMMIT_CONTEXT_LINES_AROUND_CHANGE = 3;
const SUBTREE_STATE_KEY = 'versiondock.subtrees';
const SUBTREE_STATUS_CACHE_KEY = 'versiondock.subtreeStatusCache';
const SUBTREE_SPLIT_CACHE_KEY = 'versiondock.subtreeSplitCache';
const CUSTOM_SUBTREE_PREFIX_ID = '__custom_prefix__';
const SUBTREE_STATUS_CACHE_TTL_MS = 60_000;

type SubtreeRefPickItem = vscode.QuickPickItem & { value: string; custom?: boolean };
type CachedSubtreeStatus = { key: string; checkedAt: number; status: SubtreePushStatus };
type SerializedSubtreeStatusCache = Record<string, CachedSubtreeStatus>;
type SerializedSubtreeSplitCache = Record<string, Record<string, { lastCommit: string; splitHash: string }>>;
type SubtreeStatusRefreshOptions = {
  force?: boolean;
  forceEntryIds?: Set<string>;
  notifyStatusUpdates?: boolean;
  skipStatuses?: boolean;
  background?: boolean;
};
type SvnIgnoreRepo = {
  addIgnoreEntry(entryPath: string): Promise<SvnIgnoreUpdateResult>;
  listIgnoreEntries(): Promise<SvnIgnoreEntry[]>;
  removeIgnoreEntries(entries: SvnIgnoreEntry[]): Promise<void>;
};
type SvnIgnorePickItem = vscode.QuickPickItem & { entry: SvnIgnoreEntry };
type SvnIgnoreActionPickItem = vscode.QuickPickItem & { action: 'add' | 'remove' };
type SvnIgnoreCandidatePickItem = vscode.QuickPickItem & { filePath?: string; custom?: boolean };
type NormalizedCommitGenerateMessageTarget = CommitGenerateMessageTarget & { source: 'selected' | 'staged' | 'working' };

function throwIfCancellationRequested(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

function findFailedSubmoduleDescendant(repoId: string, failedSubmoduleIds: Set<string>, repoMetas: RepoMeta[]): RepoMeta | undefined {
  if (failedSubmoduleIds.size === 0) return undefined;
  for (const failedId of failedSubmoduleIds) {
    let curr = repoMetas.find(m => m.id === failedId);
    while (curr && curr.parentRepoId) {
      if (curr.parentRepoId === repoId) {
        return repoMetas.find(m => m.id === failedId) || curr;
      }
      const parentId: string = curr.parentRepoId;
      curr = repoMetas.find(m => m.id === parentId);
    }
  }
  return undefined;
}

export class CommitPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'versiondock.commitPanel';
  private view?: vscode.WebviewView;
  private logProvider?: GitLogPanelProvider;
  private undockedPanel?: UndockedPanelProvider;
  private aiCommitComposerProvider?: AiCommitComposerProvider;
  private aiCodeReviewProvider?: AiCodeReviewProvider;
  private changelistService?: ChangelistService;
  private branchStatusBar?: BranchStatusBar;
  private badgeController?: import('../ui/BadgeController').BadgeController;
  private readonly replyTarget = new AsyncLocalStorage<'sidebar' | 'undocked'>();
  private readonly managerListeners: vscode.Disposable[] = [];
  private viewListeners: vscode.Disposable[] = [];
  private branchSyncGeneration = 0;
  private repoSyncGeneration = 0;
  private pendingSidebarMessages: HostToCommitMsg[] = [];
  private sidebarReady = false;
  private sidebarViewGeneration = 0;

  private currentTabFileViewMode: 'flat' | 'tree' = 'tree';
  private currentTabIsCollapsed = false;
  private hasConflicts = false;

  private updateConflictContext(hasConflicts: boolean): void {
    if (this.hasConflicts !== hasConflicts) {
      this.hasConflicts = hasConflicts;
      void vscode.commands.executeCommand('setContext', 'versiondock.hasConflicts', hasConflicts);
    }
  }

  private updateViewAndExpandContext(fileViewMode: 'flat' | 'tree' = this.getFileViewMode(), isCollapsed: boolean = false): void {
    void vscode.commands.executeCommand('setContext', 'versiondock.fileViewMode', fileViewMode);
    void vscode.commands.executeCommand('setContext', 'versiondock.isTreeFileView', fileViewMode === 'tree');
    void vscode.commands.executeCommand('setContext', 'versiondock.isFlatFileView', fileViewMode === 'flat');
    void vscode.commands.executeCommand('setContext', 'versiondock.expandMode', isCollapsed ? 'collapse' : 'expand');
    void vscode.commands.executeCommand('setContext', 'versiondock.isExpanded', !isCollapsed);
    void vscode.commands.executeCommand('setContext', 'versiondock.isCollapsed', isCollapsed);
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${CommitPanelProvider.viewType}.focus`);
  }

  expandAll(): void {
    this.currentTabIsCollapsed = false;
    this.updateViewAndExpandContext(this.currentTabFileViewMode, false);
    this.post({ type: 'COMMIT_EXPAND_ALL' });
  }

  collapseAll(): void {
    this.currentTabIsCollapsed = true;
    this.updateViewAndExpandContext(this.currentTabFileViewMode, true);
    this.post({ type: 'COMMIT_COLLAPSE_ALL' });
  }

  selectAll(): void {
    this.post({ type: 'COMMIT_SELECT_ALL' });
  }

  invertSelection(): void {
    this.post({ type: 'COMMIT_INVERT_SELECTION' });
  }

  async setFileViewMode(mode: 'flat' | 'tree'): Promise<void> {
    await this.globalState?.update('fileViewMode', mode);
    this.currentTabFileViewMode = mode;
    this.updateViewAndExpandContext(mode, this.currentTabIsCollapsed);
    this.post({ type: 'COMMIT_SET_FILE_VIEW_MODE', mode });
  }

  async triggerCommitAction(andPush: boolean): Promise<void> {
    const message: HostToCommitMsg = { type: 'COMMIT_TRIGGER_ACTION', andPush };
    this.postSidebarWhenReady(message);
    try {
      await this.focus();
    } catch (error) {
      this.removePendingSidebarMessage(message);
      throw error;
    }
  }

  setBranchStatusBar(statusBar: BranchStatusBar): void {
    this.branchStatusBar = statusBar;
  }

  setMergeEditorProvider(provider: MergeEditorProvider): void {
    this.mergeEditorProvider = provider;
  }

  setLogProvider(provider: GitLogPanelProvider): void {
    this.logProvider = provider;
  }

  setUndockedPanel(provider: UndockedPanelProvider): void {
    this.undockedPanel = provider;
  }

  setAiCommitComposerProvider(provider: AiCommitComposerProvider): void {
    this.aiCommitComposerProvider = provider;
  }

  setAiCodeReviewProvider(provider: AiCodeReviewProvider): void {
    this.aiCodeReviewProvider = provider;
  }

  async openCodeReviewDiff(repoId: string, filePath: string, source: CodeReviewDiffSource): Promise<void> {
    const repo = this.manager.getRepo(repoId);
    if (!repo) throw new Error(t('Repo not found'));
    if (repo.kind === 'svn') {
      await this.openSvnWorkingDiffEditor(repo, filePath);
      return;
    }
    const resolved = repo.resolveRepoPath(filePath);
    const absoluteUri = vscode.Uri.file(resolved.absolutePath);
    const title = source === 'staged'
      ? t('{0} (Index ↔ HEAD)', resolved.relativePath)
      : t('{0} (Working Tree ↔ Index)', resolved.relativePath);
    const leftUri = toGitUri(resolved.absolutePath, source === 'staged' ? '~' : '');
    let rightUri = source === 'staged' ? toGitUri(resolved.absolutePath, '') : absoluteUri;
    if (source === 'working' && !fs.existsSync(resolved.absolutePath)) {
      rightUri = ShelveDocumentProvider.buildUri(repo.repoId, `review-empty-${Date.now()}`, resolved.relativePath);
      this.shelveDocProvider.set(rightUri, '');
    }
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
  }

  handleUndockedMessage(msg: CommitToHostMsg, _provider: UndockedPanelProvider): void {
    void this.replyTarget.run('undocked', () => this.handleMessage(msg)).catch(error => {
      this.logger?.error('CommitPanel', 'Undocked panel message failed', error, { messageType: msg.type });
    });
  }

  setBadgeController(controller: import('../ui/BadgeController').BadgeController): void {
    this.badgeController = controller;
  }

  prefillCommitMessage(message: string, target: 'sidebar' | 'undocked' = 'sidebar'): void {
    const effectiveTarget = target === 'undocked' && this.undockedPanel?.hasCommitPane()
      ? 'undocked'
      : 'sidebar';
    if (effectiveTarget === 'sidebar') {
      this.postSidebarWhenReady({ type: 'COMMIT_SET_MESSAGE', message });
      return;
    }
    this.replyTarget.run(effectiveTarget, () => {
      this.post({ type: 'COMMIT_SET_MESSAGE', message });
    });
  }
  private shelveServices = new Map<string, ShelveService>();
  private subtreeStatusCache = new Map<string, CachedSubtreeStatus>();
  private subtreeStatusTasks = new Map<string, { key: string; task: Promise<SubtreePushStatus> }>();
  private notifiedSubtreeUpdateKeys = new Map<string, string>();
  private activeCommitMessageGenerations = new Map<string, vscode.CancellationTokenSource>();
  private activeTab: CommitPanelTab = 'changes';
  private lastRepoCommitHashes = new Map<string, string>();
  private knownRepoIds = new Set<string>();

  private getShelveService(repoId: string): ShelveService | undefined {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return undefined;
    if (!this.shelveServices.has(repoId)) {
      this.shelveServices.set(
        repoId,
        new ShelveService(
          repo.rootPath,
          this.globalStoragePath,
          (op, kind, label) => this.manager.runWithStatusUpdatesSuppressed(op, kind, label),
        ),
      );
    }
    return this.shelveServices.get(repoId);
  }

  private updateVcsContext(metas: RepoMeta[] = this.manager.getRepoMetas()): void {
    const hasGitRepo = metas.some(meta => meta.kind !== 'svn');
    const hasSvnRepo = metas.some(meta => meta.kind === 'svn');
    void vscode.commands.executeCommand('setContext', 'versiondock.hasGitRepo', hasGitRepo);
    void vscode.commands.executeCommand('setContext', 'versiondock.hasSvnRepo', hasSvnRepo);
    void vscode.commands.executeCommand('setContext', 'versiondock.svnOnly', hasSvnRepo && !hasGitRepo);
    void vscode.commands.executeCommand('setContext', 'versiondock.isMultiRepo', metas.length > 1);
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly globalStoragePath: string,
    private readonly shelveDocProvider: ShelveDocumentProvider,
    private readonly aiCommitMessageService: AiCommitMessageService,
    private mergeEditorProvider?: MergeEditorProvider,
    private readonly profileService?: GitProfileService,
    private readonly globalState?: vscode.Memento,
    private readonly workspaceState?: vscode.Memento,
    private readonly logger?: VersionDockLogger,
    private readonly updateSummaryService?: UpdateSummaryService,
  ) {
    this.currentTabFileViewMode = this.getFileViewMode();
    this.restoreSubtreeCaches();
    this.knownRepoIds = new Set(this.manager.getRepoMetas().map(m => m.id));
    this.updateVcsContext();
    this.updateViewAndExpandContext(this.currentTabFileViewMode, false);

    this.managerListeners.push(
      this.manager.onStatusChange((status, context) => {
        let hasCommitChanged = false;
        const changedRepoIds: string[] = [];
        if (Array.isArray(status?.repos)) {
          for (const repoStatus of status.repos) {
            const commitHash = repoStatus.branch?.lastCommitHash || repoStatus.branch?.detachedHash;
            if (commitHash) {
              const prev = this.lastRepoCommitHashes.get(repoStatus.repoId);
              if (prev && prev !== commitHash) {
                hasCommitChanged = true;
                changedRepoIds.push(repoStatus.repoId);
              }
              this.lastRepoCommitHashes.set(repoStatus.repoId, commitHash);
            }
          }
        }

        const hasConflicts = Array.isArray(status?.repos) && status.repos.some(repo => (repo.conflictCount || 0) > 0);
        this.updateConflictContext(hasConflicts);

        this.postChangelistsUpdate(status);
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });

        if (hasCommitChanged) {
          const unhandledUnpushedRepoIds = context?.source === 'invalidation' && context.scopes?.includes('unpushed')
            ? changedRepoIds.filter(id => context.suppressedRepoIds && !context.suppressedRepoIds.includes(id))
            : changedRepoIds;

          const isSubtreeHandledByEvent = context?.source === 'invalidation' && context.scopes?.includes('subtree')
            && (!context.suppressedRepoIds || changedRepoIds.every(id => context.suppressedRepoIds!.includes(id)));

          if (!isSubtreeHandledByEvent) {
            this.invalidateSubtreeStatus(undefined, { remote: false });
            if (this.isSubtreeTabActive()) {
              void this.refreshSubtreeList({ force: false });
            }
          }

          if (unhandledUnpushedRepoIds.length > 0) {
            void this.broadcastUnpushedCommits(unhandledUnpushedRepoIds);
          }
        }
      })
    );

    const postAllBranches = async () => {
      const generation = ++this.branchSyncGeneration;
      const repos = this.manager.getRepoMetas().flatMap(meta => {
        const repo = this.manager.getRepo(meta.id);
        return repo ? [{ meta, repo }] : [];
      });
      const results = await Promise.allSettled(
        repos.map(async ({ meta, repo }) => ({ repoId: meta.id, branches: await repo.getBranches() })),
      );
      if (generation !== this.branchSyncGeneration) return;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          this.post({ type: 'COMMIT_BRANCHES_UPDATE', ...result.value });
        }
      }
    };

    this.managerListeners.push(this.manager.onBranchChange((options) => {
      if (options?.refreshDerivedData !== false) {
        this.invalidateSubtreeStatus(undefined, { remote: false });
        if (this.isSubtreeTabActive()) {
          void this.refreshSubtreeList({ force: false });
        }
        void this.broadcastUnpushedCommits();
        void this.broadcastIncomingCommits();
      }
      void postAllBranches().catch(error => {
        this.logger?.error('CommitPanel', 'Failed to refresh branches', error);
      });
    }));

    const syncRepos = async () => {
      const generation = ++this.repoSyncGeneration;
      const status = await this.manager.getAllStatusesFresh();
      if (generation !== this.repoSyncGeneration) return;

      const currentMetas = this.manager.getRepoMetas();
      const currentIds = new Set(currentMetas.map(m => m.id));
      let reposSetChanged = currentIds.size !== this.knownRepoIds.size;
      if (!reposSetChanged) {
        for (const id of currentIds) {
          if (!this.knownRepoIds.has(id)) {
            reposSetChanged = true;
            break;
          }
        }
      }
      this.knownRepoIds = currentIds;

      if (reposSetChanged) {
        this.invalidateSubtreeStatus(undefined, { remote: false });
      }
      this.postChangelistsUpdate(status);
      this.post({ type: 'COMMIT_STATUS_UPDATE', repos: currentMetas, status });
      if (reposSetChanged && this.isSubtreeTabActive()) {
        void this.refreshSubtreeList({ force: false });
      }
      await postAllBranches();
    };
    this.managerListeners.push(this.manager.onReposChange(() => {
      void syncRepos().catch(error => {
        this.logger?.error('CommitPanel', 'Failed to synchronize repositories', error);
      });
    }));

    this.managerListeners.push(
      this.manager.onWorktreeChange(() => {
        void (async () => {
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        })().catch(error => {
          this.logger?.error('CommitPanel', 'Failed to refresh worktrees', error);
        });
      }),
    );

    this.managerListeners.push(
      this.manager.onDataInvalidated((event) => {
        void this.handleDataInvalidated(event).catch(error => {
          this.logger?.error('CommitPanel', 'Failed to handle data invalidation', error);
        });
      }),
    );
  }

  /**
   * Resolves the effective profile for the repo and returns credentials for -c injection.
   * For local/global fallback sources no injection is needed — git already has the right config natively.
   * Never writes to .git/config — credentials are injected only for the duration of the commit command.
   */
  private async getCommitCredentials(repoId: string): Promise<{ gitName: string; gitEmail: string } | undefined> {
    if (!this.profileService) return undefined;

    // For submodules, resolve the profile using the parent repo path so they
    // inherit the same identity as the parent.
    const meta = this.manager.getRepoMeta(repoId);
    const parentMeta = meta?.isSubmodule && meta.parentRepoId
      ? this.manager.getRepoMeta(meta.parentRepoId)
      : undefined;
    const resolvedPath = parentMeta?.rootPath ?? meta?.rootPath;
    if (!resolvedPath) return undefined;

    const result = await this.profileService.getEffectiveProfile(resolvedPath);
    if (!result) {
      vscode.window.showWarningMessage(t('VersionDock [{0}]: No Git identity configured. Set a profile before committing.', meta?.name ?? repoId));
      return undefined;
    }
    if (result.source === 'local' || result.source === 'global') return undefined;
    const { gitName, gitEmail } = result.profile;
    if (!gitName && !gitEmail) return undefined;
    return { gitName, gitEmail };
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposeViewListeners();
    this.view = webviewView;
    this.sidebarReady = false;
    this.sidebarViewGeneration += 1;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.file(vscode.env.appRoot),
        ...vscode.extensions.all.map(e => vscode.Uri.file(e.extensionPath)),
      ],
    };

    webviewView.webview.html = getWebviewHtml(
      webviewView.webview,
      this.extensionUri,
      'commitPanel',
      'VersionDock Commit'
    );

    this.viewListeners.push(
      webviewView.webview.onDidReceiveMessage((msg: CommitToHostMsg) => {
        void this.replyTarget.run('sidebar', () => this.handleMessage(msg)).catch(error => {
          this.logger?.error('CommitPanel', 'Sidebar message failed', error, { messageType: msg.type });
        });
      })
    );

    // Refresh status whenever the panel becomes visible (e.g. user switches to it)
    this.viewListeners.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          void this.manager.getAllStatuses().then(status => {
            this.postChangelistsUpdate(status);
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          }).catch(error => {
            this.logger?.error('CommitPanel', 'Failed to refresh visible panel', error);
          });
        }
      })
    );

    // Sync current state — send changelists first so setStatus can read the correct viewMode
    void this.manager.getAllStatuses().then(status => {
      this.postChangelistsUpdate(status);
      this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status, fileViewMode: this.getFileViewMode() });
      this.post({ type: 'COMMIT_HIDDEN_REPOS_UPDATE', hiddenRepoIds: this.getHiddenRepoIds() });
      void loadIconTheme(webviewView.webview).then(iconTheme => {
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status, iconTheme, fileViewMode: this.getFileViewMode() });
      }).catch(() => { /* icon theme optional */ });
    }).catch(error => {
      this.logger?.error('CommitPanel', 'Failed to initialize panel', error);
    });

    // Re-send icon theme when the user changes icon or color theme
    const configWatcher = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
        if (this.view) {
          void loadIconTheme(this.view.webview).then(async iconTheme => {
            const status = await this.manager.getAllStatuses();
            if (this.view) {
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status, iconTheme });
            }
          }).catch(() => { /* icon theme optional */ });
        }
      }
      if (e.affectsConfiguration('versiondock.layoutDensity')) {
        this.post({ type: 'COMMIT_LAYOUT_DENSITY_UPDATE', layoutDensity: this.getLayoutDensity() });
      }
      if (e.affectsConfiguration('versiondock.changesViewMode') || e.affectsConfiguration('versiondock.defaultCommitAction') || e.affectsConfiguration('versiondock.defaultSaveAction')) {
        this.changelistService?.setChangelistMode(this.getChangesViewMode() === 'changelists');
        void this.manager.getAllStatuses().then(status => {
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        }).catch(error => {
          this.logger?.error('CommitPanel', 'Failed to apply configuration', error);
        });
      }
    });

    this.viewListeners.push(
      configWatcher,
      webviewView.onDidDispose(() => {
        if (this.view !== webviewView) return;
        this.view = undefined;
        this.sidebarReady = false;
        this.sidebarViewGeneration += 1;
        this.disposeViewListeners();
      })
    );
  }

  private disposeViewListeners(): void {
    const listeners = this.viewListeners;
    this.viewListeners = [];
    listeners.forEach(disposable => disposable.dispose());
  }

  private post(msg: HostToCommitMsg): void {
    if (msg.type === 'COMMIT_STATUS_UPDATE') {
      this.badgeController?.update(msg.status);
      this.updateVcsContext(msg.repos);
      const m = msg as typeof msg & { fileViewMode?: 'flat' | 'tree'; defaultCommitAction?: 'commit' | 'commitAndPush'; defaultSaveAction?: 'stash' | 'shelve'; hasWorkspaceFolder?: boolean; layoutDensity?: LayoutDensity };
      if (m.fileViewMode === undefined) m.fileViewMode = this.getFileViewMode();
      if (m.defaultCommitAction === undefined) m.defaultCommitAction = this.getDefaultCommitAction();
      if (m.defaultSaveAction === undefined) m.defaultSaveAction = this.getDefaultSaveAction();
      if (m.hasWorkspaceFolder === undefined) m.hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      if (m.noVerify === undefined) m.noVerify = vscode.workspace.getConfiguration('versiondock').get<boolean>('git.noVerify', false);
      if (m.layoutDensity === undefined) m.layoutDensity = this.getLayoutDensity();
    }
    const broadcast = msg.type === 'COMMIT_STATUS_UPDATE'
      || msg.type === 'COMMIT_LAYOUT_DENSITY_UPDATE'
      || msg.type === 'COMMIT_BRANCHES_UPDATE'
      || msg.type === 'COMMIT_HIDDEN_REPOS_UPDATE'
      || msg.type === 'CHANGELISTS_UPDATE'
      || msg.type === 'SHELVE_LIST_RESULT'
      || msg.type === 'STASH_COUNT_RESULT'
      || msg.type === 'STASH_LIST_RESULT'
      || msg.type === 'PUSH_UNPUSHED_RESULT'
      || msg.type === 'WORKTREE_LIST_RESULT'
      || msg.type === 'SUBTREE_LIST_RESULT'
      || msg.type === 'SUBTREE_STATUS_RESULT'
      || msg.type === 'COMMIT_AMEND_RESET'
      || msg.type === 'PUSH_COMMITS_STATS_UPDATE';
    if (this.replyTarget.getStore() === 'undocked') {
      this.undockedPanel?.postToCommit(msg);
      if (broadcast) this.view?.webview.postMessage(msg);
      return;
    }
    this.view?.webview.postMessage(msg);
    if (broadcast) {
      this.undockedPanel?.postToCommit(msg);
    }
  }

  private postSidebarWhenReady(msg: HostToCommitMsg): void {
    if (!this.view || !this.sidebarReady) {
      this.pendingSidebarMessages.push(msg);
      return;
    }
    this.replyTarget.run('sidebar', () => this.post(msg));
  }

  private removePendingSidebarMessage(msg: HostToCommitMsg): void {
    const pendingIndex = this.pendingSidebarMessages.indexOf(msg);
    if (pendingIndex >= 0) this.pendingSidebarMessages.splice(pendingIndex, 1);
  }

  private flushPendingSidebarMessages(): void {
    if (!this.view || !this.sidebarReady || this.pendingSidebarMessages.length === 0) return;
    const pending = this.pendingSidebarMessages;
    this.pendingSidebarMessages = [];
    this.replyTarget.run('sidebar', () => {
      for (const message of pending) this.post(message);
    });
  }

  private async openWorktreeDiffEditor(
    repo: import('../git/GitService').GitService,
    baseRef: string,
    filePath: string,
  ): Promise<void> {
    const resolvedPath = repo.resolveRepoPath(filePath);
    const relativePath = resolvedPath.relativePath;
    const absolutePath = resolvedPath.absolutePath;
    const fileName = path.basename(relativePath);

    let leftUri: vscode.Uri;
    if (fs.existsSync(absolutePath)) {
      leftUri = vscode.Uri.file(absolutePath);
    } else {
      leftUri = ShelveDocumentProvider.buildUri(repo.repoId, `worktree-empty-${baseRef}`, relativePath);
      this.shelveDocProvider.set(leftUri, '');
    }

    const rightRef = await repo.hasFileAtRef(baseRef, relativePath) ? baseRef : EMPTY_TREE;
    const rightUri = toGitUri(absolutePath, rightRef);

    await vscode.commands.executeCommand(
      'vscode.diff',
      leftUri,
      rightUri,
      t('{0} (Working Tree ↔ {1})', fileName, baseRef),
      { preview: true },
    );
  }

  private async openCommitDiffEditor(
    repo: import('../git/GitService').GitService,
    hash: string,
    filePath: string,
    fileStatus?: string,
  ): Promise<void> {
    const resolvedPath = repo.resolveRepoPath(filePath);
    const relativePath = resolvedPath.relativePath;
    const absolutePath = resolvedPath.absolutePath;
    const fileName = path.basename(relativePath);
    const leftRef = await repo.hasFileAtRef(`${hash}~1`, relativePath) ? `${hash}~1` : EMPTY_TREE;
    const rightRef = await repo.hasFileAtRef(hash, relativePath) ? hash : EMPTY_TREE;
    const gitUri = (ref: string) => toGitUri(absolutePath, ref);
    const title = fileStatus?.startsWith('A')
      ? t('{0} (added in {1})', fileName, hash.slice(0, 7))
      : fileStatus?.startsWith('D')
        ? t('{0} (deleted in {1})', fileName, hash.slice(0, 7))
        : t('{0} ({1})', fileName, hash.slice(0, 7));

    await vscode.commands.executeCommand(
      'vscode.diff',
      gitUri(leftRef),
      gitUri(rightRef),
      title,
      { preview: true },
    );
  }

  private async openAggregatedCommitDiffEditor(
    repo: import('../git/GitService').GitService,
    oldestHash: string | undefined,
    filePath: string,
    fileStatus?: string,
  ): Promise<void> {
    const resolvedPath = repo.resolveRepoPath(filePath);
    const relativePath = resolvedPath.relativePath;
    const absolutePath = resolvedPath.absolutePath;
    const fileName = path.basename(relativePath);
    const aggregateBase = await repo.getUnpushedAggregateBase(oldestHash);
    if (!aggregateBase) throw new Error(t('Cannot determine the base revision for aggregated changes.'));

    const leftRef = await repo.hasFileAtRef(aggregateBase, relativePath) ? aggregateBase : EMPTY_TREE;
    const rightRef = await repo.hasFileAtRef('HEAD', relativePath) ? 'HEAD' : EMPTY_TREE;
    const title = fileStatus?.startsWith('A')
      ? t('{0} (added in unpushed changes)', fileName)
      : fileStatus?.startsWith('D')
        ? t('{0} (deleted in unpushed changes)', fileName)
        : t('{0} (all unpushed changes)', fileName);

    await vscode.commands.executeCommand(
      'vscode.diff',
      toGitUri(absolutePath, leftRef),
      toGitUri(absolutePath, rightRef),
      title,
      { preview: true },
    );
  }

  private async openIncomingAggregatedCommitDiffEditor(
    repo: import('../git/GitService').GitService,
    filePath: string,
    fileStatus?: string,
  ): Promise<void> {
    const resolvedPath = repo.resolveRepoPath(filePath);
    const relativePath = resolvedPath.relativePath;
    const absolutePath = resolvedPath.absolutePath;
    const fileName = path.basename(relativePath);

    let baseRef = 'HEAD';
    try {
      const mb = await repo.getMergeBase('HEAD', '@{u}');
      if (mb) baseRef = mb;
    } catch {
      // fallback
    }

    const leftRef = await repo.hasFileAtRef(baseRef, relativePath) ? baseRef : EMPTY_TREE;
    const rightRef = await repo.hasFileAtRef('@{u}', relativePath) ? '@{u}' : EMPTY_TREE;
    const title = fileStatus?.startsWith('A')
      ? t('{0} (added in incoming changes)', fileName)
      : fileStatus?.startsWith('D')
        ? t('{0} (deleted in incoming changes)', fileName)
        : t('{0} (all incoming changes)', fileName);

    await vscode.commands.executeCommand(
      'vscode.diff',
      toGitUri(absolutePath, leftRef),
      toGitUri(absolutePath, rightRef),
      title,
      { preview: true },
    );
  }

  private async prepareSvnWorkingDiffResource(
    repo: import('../git/GitService').GitService,
    filePath: string,
  ): Promise<{ labelUri: vscode.Uri; leftUri: vscode.Uri; rightUri: vscode.Uri; title: string } | null> {
    const resolvedPath = repo.resolveRepoPath(filePath);
    const relativePath = resolvedPath.relativePath;
    let workingStat: fs.Stats | undefined;
    try { workingStat = fs.statSync(resolvedPath.absolutePath); } catch { /* missing conflicted path */ }
    if (workingStat?.isDirectory()) return null;

    const diff = await repo.getUnstagedDiff(repo.repoId, relativePath);
    const fileName = path.basename(relativePath);
    const hasWorkingFile = workingStat?.isFile() ?? false;
    const fileUri = vscode.Uri.file(resolvedPath.absolutePath);
    const leftUri = this.buildSvnDiffUri(repo, relativePath, 'base');
    const rightUri = this.buildSvnDiffUri(repo, relativePath, 'working');
    if (!diff) {
      let baseContent = '';
      if (!hasWorkingFile) {
        // A missing SVN conflict file still has a useful BASE/working view.
        // Load BASE from SVN and represent the missing working copy as empty
        // virtual content instead of opening a nonexistent file URI.
        const versions = await repo.getFileVersions(relativePath).catch(() => undefined);
        if (!versions) return null;
        baseContent = versions.base;
      }
      let workingContent = '';
      if (hasWorkingFile) {
        try { workingContent = fs.readFileSync(resolvedPath.absolutePath, 'utf8'); } catch { /* keep empty */ }
      }
      this.shelveDocProvider.set(leftUri, hasWorkingFile ? '' : baseContent);
      this.shelveDocProvider.set(rightUri, workingContent);
      return {
        labelUri: hasWorkingFile ? fileUri : leftUri,
        leftUri,
        rightUri,
        title: t('{0} (SVN Base ↔ Working Copy)', fileName),
      };
    }
    this.shelveDocProvider.set(leftUri, diff.originalContent ?? '');
    this.shelveDocProvider.set(rightUri, diff.modifiedContent ?? '');
    return {
      labelUri: hasWorkingFile ? fileUri : leftUri,
      leftUri,
      rightUri,
      title: t('{0} (SVN Base ↔ Working Copy)', fileName),
    };
  }

  private buildSvnDiffUri(
    repo: import('../git/GitService').GitService,
    filePath: string,
    side: 'base' | 'working',
  ): vscode.Uri {
    const relPath = filePath.replace(/\\/g, '/').replace(/^\/+/, '');
    return vscode.Uri.from({
      scheme: ShelveDocumentProvider.scheme,
      authority: 'svn',
      path: `/${relPath}`,
      query: JSON.stringify({ repoId: repo.repoId, side, id: `${Date.now()}-${Math.random().toString(36).slice(2)}` }),
    });
  }

  private async openSvnWorkingDiffEditor(
    repo: import('../git/GitService').GitService,
    filePath: string,
    options: { preview?: boolean } = {},
  ): Promise<void> {
    const resolvedPath = repo.resolveRepoPath(filePath);
    let workingStat: fs.Stats | undefined;
    try { workingStat = fs.statSync(resolvedPath.absolutePath); } catch { /* missing conflicted path */ }
    if (workingStat?.isDirectory()) {
      await vscode.window.showInformationMessage(
        t('VersionDock [{0}]: SVN directory conflicts cannot be edited as text. Choose a conflict side or resolve the directory manually.', repo.meta.name),
      );
      return;
    }

    const resource = await this.prepareSvnWorkingDiffResource(repo, filePath);
    if (!resource) {
      if (!workingStat?.isFile()) {
        await vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN diff available for {1}.', repo.name, path.basename(resolvedPath.relativePath)));
        return;
      }
      await vscode.window.showTextDocument(vscode.Uri.file(resolvedPath.absolutePath), { preview: options.preview ?? true });
      return;
    }
    await vscode.commands.executeCommand(
      'vscode.diff',
      resource.leftUri,
      resource.rightUri,
      resource.title,
      { preview: options.preview ?? true },
    );
  }

  private async openSvnAllChanges(
    repo: import('../git/GitService').GitService,
    section?: 'staged' | 'unstaged',
  ): Promise<void> {
    if (section === 'staged') {
      await vscode.window.showInformationMessage(t('VersionDock [{0}]: SVN does not use staged changes.', repo.meta.name));
      return;
    }

    const status = await repo.getStatus();
    const filesByPath = new Map<string, { path: string; status: string }>();

    for (const file of [...status.unstagedFiles, ...status.stagedFiles]) {
      if (!file.path) continue;
      try {
        const absolutePath = repo.resolveRepoPath(file.path).absolutePath;
        if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) continue;
      } catch {
        continue;
      }
      filesByPath.set(file.path, { path: file.path, status: file.status });
    }

    const statusRank: Record<string, number> = {
      conflicted: 0,
      modified: 1,
      added: 2,
      deleted: 3,
      untracked: 4,
    };
    const files = Array.from(filesByPath.values()).sort((left, right) => {
      const leftRank = statusRank[left.status] ?? 99;
      const rightRank = statusRank[right.status] ?? 99;
      return leftRank - rightRank || left.path.localeCompare(right.path);
    });
    if (files.length === 0) {
      await vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN file changes to open.', repo.meta.name));
      return;
    }

    const resources: Array<{ labelUri: vscode.Uri; leftUri: vscode.Uri; rightUri: vscode.Uri; title: string }> = [];
    const errors: string[] = [];
    for (const file of files) {
      try {
        const resource = await this.prepareSvnWorkingDiffResource(repo, file.path);
        if (resource) resources.push(resource);
      } catch (e: unknown) {
        errors.push(`${file.path}: ${String(e)}`);
      }
    }
    if (resources.length === 0) {
      await vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN file changes to open.', repo.meta.name));
      return;
    }
    try {
      await vscode.commands.executeCommand(
        'vscode.changes',
        t('SVN: Changes ({0} files)', resources.length),
        resources.map(resource => [resource.labelUri, resource.leftUri, resource.rightUri]),
      );
    } catch {
      for (const resource of resources) {
        await vscode.commands.executeCommand(
          'vscode.diff',
          resource.leftUri,
          resource.rightUri,
          resource.title,
          { preview: false },
        );
      }
    }
    if (errors.length > 0) {
      await vscode.window.showWarningMessage(t('VersionDock [{0}]: Could not open {1} SVN change(s): {2}', repo.meta.name, errors.length, errors.join('; ')));
    }
  }

  async startWorktreeDiff(
    repoId: string,
    baseRef: string,
    target: 'sidebar' | 'undocked' = 'sidebar',
  ): Promise<void> {
    const repo = this.manager.getRepo(repoId);
    const meta = this.manager.getRepoMetas().find(item => item.id === repoId);
    if (!repo || !meta) return;

    const [files, current] = await Promise.all([
      repo.getWorktreeDiffFiles(baseRef),
      repo.getCurrentBranch(),
    ]);
    const currentRef = current.detachedTag ?? current.detachedHash ?? current.name;
    const effectiveTarget = target === 'undocked' && this.undockedPanel?.hasCommitPane()
      ? 'undocked'
      : 'sidebar';
    if (effectiveTarget === 'sidebar') {
      const startMessage: HostToCommitMsg = {
        type: 'COMMIT_WORKTREE_DIFF_STARTED',
        repoId,
        repoName: meta.name,
        repoColor: meta.color,
        baseRef,
        currentRef,
        files,
      };
      const switchMessage: HostToCommitMsg = { type: 'COMMIT_SWITCH_TAB', tab: 'worktree' };
      this.postSidebarWhenReady(startMessage);
      this.postSidebarWhenReady(switchMessage);
      try {
        await this.focus();
      } catch (error) {
        this.removePendingSidebarMessage(startMessage);
        this.removePendingSidebarMessage(switchMessage);
        throw error;
      }
      return;
    }
    this.replyTarget.run(effectiveTarget, () => {
      this.post({
        type: 'COMMIT_WORKTREE_DIFF_STARTED',
        repoId,
        repoName: meta.name,
        repoColor: meta.color,
        baseRef,
        currentRef,
        files,
      });
      this.switchToTab('worktree');
    });
  }

  switchToTab(tab: 'changes' | 'shelf' | 'stash' | 'worktree' | 'push'): void {
    if (this.replyTarget.getStore() === 'undocked' && this.undockedPanel?.hasCommitPane()) {
      this.post({ type: 'COMMIT_SWITCH_TAB', tab });
      return;
    }
    this.postSidebarWhenReady({ type: 'COMMIT_SWITCH_TAB', tab });
  }

  /** Reads fresh status after a stage/unstage/commit op. Uses refreshStatusNow with suppression bypass to immediately publish fresh state. */
  private async refreshStatusAfterOp(): Promise<WorkspaceStatus> {
    return this.manager.refreshStatusNow(undefined, { bypassSuppression: true });
  }

  private async pickSvnIgnorePath(
    repo: { getStatus(): Promise<{ unstagedFiles: FileStatus[]; stagedFiles: FileStatus[] }> },
  ): Promise<string | undefined> {
    const status = await repo.getStatus().catch(() => undefined);
    const untrackedPaths = Array.from(new Set(
      (status?.unstagedFiles ?? [])
        .filter(file => file.status === 'untracked')
        .map(file => file.path),
    )).sort((left, right) => left.localeCompare(right));

    const customItem: SvnIgnoreCandidatePickItem = {
      label: `$(edit) ${t('Enter custom SVN ignore path...')}`,
      custom: true,
    };

    if (untrackedPaths.length > 0) {
      const picked = await vscode.window.showQuickPick<SvnIgnoreCandidatePickItem>(
        [
          ...untrackedPaths.map(filePath => ({ label: filePath, filePath })),
          { label: '', kind: vscode.QuickPickItemKind.Separator },
          customItem,
        ],
        {
          title: t('Add SVN Ignore...'),
          placeHolder: t('Select an unversioned file or folder to ignore'),
          matchOnDescription: true,
        },
      );
      if (!picked) return undefined;
      if (!picked.custom) return picked.filePath;
    }

    return vscode.window.showInputBox({
      title: t('Add SVN Ignore...'),
      prompt: t('Enter a path relative to the repository root'),
      placeHolder: 'path/to/file-or-folder',
      validateInput: value => value.trim() ? undefined : t('SVN ignore target cannot be empty.'),
    });
  }

  private getChangesViewMode(): 'simplified' | 'changelists' | 'vscode' {
    return vscode.workspace.getConfiguration('versiondock').get<'simplified' | 'changelists' | 'vscode'>('changesViewMode', 'simplified');
  }

  private getFileViewMode(): 'flat' | 'tree' {
    return this.globalState?.get<'flat' | 'tree'>('fileViewMode', 'tree') ?? 'tree';
  }

  private getLayoutDensity(): LayoutDensity {
    const raw = vscode.workspace.getConfiguration('versiondock').get<string>('layoutDensity', 'comfortable');
    return raw === 'compact' ? 'compact' : 'comfortable';
  }

  private resolveAiCommitMessageTargets(
    statuses: WorkspaceStatus['repos'],
    targets?: CommitGenerateMessageTarget[],
    repoIds?: string[],
  ): NormalizedCommitGenerateMessageTarget[] {
    const requestedRepoIds = repoIds ? new Set(repoIds) : undefined;
    const scopedStatuses = requestedRepoIds
      ? statuses.filter(status => requestedRepoIds.has(status.repoId))
      : statuses;
    const statusByRepo = new Map(scopedStatuses.map(status => [status.repoId, status]));
    const selectedTargets = (targets ?? [])
      .map(target => ({
        repoId: target.repoId,
        paths: Array.from(new Set(target.paths.filter(filePath => filePath.length > 0))),
        source: 'selected' as const,
      }))
      .filter(target => target.paths.length > 0 && statusByRepo.has(target.repoId));

    if (selectedTargets.length > 0) return selectedTargets;

    return scopedStatuses.flatMap(status => {
      const service = this.manager.getRepo(status.repoId);
      const useWorkingChanges = service?.kind === 'svn' || status.stagedFiles.length === 0;
      const files = useWorkingChanges ? status.unstagedFiles : status.stagedFiles;
      const paths = Array.from(new Set(files.map(file => file.path).filter(Boolean)));
      return paths.length > 0 ? [{
        repoId: status.repoId,
        paths,
        source: useWorkingChanges ? 'working' as const : 'staged' as const,
      }] : [];
    });
  }

  private mergeAiFileStatuses(status: RepoStatus): Map<string, FileStatus> {
    const filesByPath = new Map<string, FileStatus>();
    for (const file of [...status.stagedFiles, ...status.unstagedFiles]) {
      if (!file.path) continue;
      const existing = filesByPath.get(file.path);
      filesByPath.set(file.path, existing ? {
        ...existing,
        absolutePath: existing.absolutePath || file.absolutePath,
        oldPath: existing.oldPath ?? file.oldPath,
        staged: existing.staged || file.staged,
        unstaged: existing.unstaged || file.unstaged,
      } : file);
    }
    return filesByPath;
  }

  private isLockfilePath(filePath: string): boolean {
    const base = path.basename(filePath).toLowerCase();
    return (
      base === 'package-lock.json' ||
      base === 'pnpm-lock.yaml' ||
      base === 'yarn.lock' ||
      base === 'cargo.lock' ||
      base === 'go.sum' ||
      base === 'composer.lock'
    );
  }

  private getCommitContextFilePriority(filePath: string): number {
    if (this.isLockfilePath(filePath)) return 4;
    const ext = path.extname(filePath).toLowerCase();
    if (/^\.(ts|tsx|js|jsx|vue|svelte|py|go|rs|java|c|cpp|cc|h|hpp|cs|php|rb|swift|kt|dart|scala|m|mm)$/.test(ext)) {
      return 1;
    }
    if (/^\.(css|scss|sass|less|html|htm|sh|bash|zsh|sql|graphql)$/.test(ext)) {
      return 2;
    }
    return 3;
  }

  private extractSemanticBranchIntent(branchName: string | undefined): string | undefined {
    if (!branchName) return undefined;
    const trimmed = branchName.trim();
    const normalized = trimmed.toLowerCase();
    const trivial = new Set(['main', 'master', 'dev', 'develop', 'release', 'trunk', 'head', 'detached', 'test']);
    if (trivial.has(normalized)) return undefined;
    if (/^[0-9a-f]{7,40}$/i.test(trimmed)) return undefined;
    return trimmed;
  }

  private async buildAiCommitMessageContext(
    targets: CommitGenerateMessageTarget[] | undefined,
    repoIds: string[] | undefined,
    userPrompt: string | undefined,
    cancellationToken: vscode.CancellationToken,
  ): Promise<AiCommitMessageGenerationContext> {
    throwIfCancellationRequested(cancellationToken);
    const ws = await this.manager.getAllStatuses();
    throwIfCancellationRequested(cancellationToken);
    const normalizedTargets = this.resolveAiCommitMessageTargets(ws.repos, targets, repoIds);
    const repoMetas = new Map(this.manager.getRepoMetas().map(meta => [meta.id, meta]));
    const statusByRepo = new Map(ws.repos.map(status => [status.repoId, status]));
    const contextTokenBudget = getContextTokenBudget(await this.aiCommitMessageService.getMaxInputTokens());
    const preparedGroups: Array<{
      headingLines: string[];
      entries: Array<{
        label: string;
        summary: string;
        sources: Array<{ label: string; diff: FileDiff | null }>;
      }>;
    }> = [];
    const includedRepoIds = new Set<string>();
    const includedRepoRootPaths = new Set<string>();
    const selectedPaths = new Set<string>();
    const vcsKinds = new Set<'git' | 'svn'>();
    const candidateBranchIntents: string[] = [];
    let totalAdditions = 0;
    let totalDeletions = 0;

    for (const target of normalizedTargets) {
      throwIfCancellationRequested(cancellationToken);
      const status = statusByRepo.get(target.repoId);
      if (!status) continue;
      const service = this.manager.getRepo(status.repoId);
      if (!service) continue;
      const repoMeta = repoMetas.get(status.repoId);
      const repoName = repoMeta?.name ?? path.basename(status.repoId);
      const vcsKind = service.kind === 'svn' ? 'SVN' : 'Git';
      const branchName = status.branch.name;
      const branchIntent = this.extractSemanticBranchIntent(branchName);
      if (branchIntent && !candidateBranchIntents.includes(branchIntent)) {
        candidateBranchIntents.push(branchIntent);
      }

      const filesByPath = this.mergeAiFileStatuses(status);
      const rawFiles = target.paths.map(filePath => filesByPath.get(filePath)).filter((file): file is FileStatus => !!file);
      if (rawFiles.length === 0) continue;
      // 核心业务代码排在前面，锁文件排在最后
      const files = [...rawFiles].sort((a, b) => this.getCommitContextFilePriority(a.path) - this.getCommitContextFilePriority(b.path));

      includedRepoIds.add(status.repoId);
      includedRepoRootPaths.add(repoMeta?.rootPath ?? service.rootPath);
      vcsKinds.add(service.kind === 'svn' ? 'svn' : 'git');
      const groupEntries: typeof preparedGroups[number]['entries'] = [];
      for (const file of files) {
        throwIfCancellationRequested(cancellationToken);
        selectedPaths.add(file.path);

        const includeStaged = file.staged;
        const includeUnstaged = file.unstaged && (target.source === 'selected' || target.source === 'working');
        const diffSources = [
          ...(includeStaged ? [{ label: 'staged' as const, diff: () => service.getStagedDiff(status.repoId, file.path) }] : []),
          ...(includeUnstaged ? [{ label: 'working' as const, diff: () => service.getUnstagedDiff(status.repoId, file.path) }] : []),
        ];
        const isSensitive = isSensitivePath(file.path);
        const isLock = this.isLockfilePath(file.path);
        const sources: typeof groupEntries[number]['sources'] = [];
        for (const source of diffSources) {
          throwIfCancellationRequested(cancellationToken);
          if (isSensitive) {
            // Protect private credentials, env secrets, and keys from being sent to external AI providers.
            // Provide a synthetic sanitized diff so AI can still acknowledge the file in the commit message.
            const sanitizedDiff: FileDiff = {
              repoId: status.repoId,
              oldPath: file.path,
              newPath: file.path,
              isBinary: false,
              isNew: file.status === 'added' || file.status === 'untracked',
              isDeleted: file.status === 'deleted',
              hunks: [{
                header: '@@ -0,0 +1,1 @@',
                oldStart: 0,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                lines: [{
                  type: 'add',
                  content: '[SENSITIVE FILE CONTENT EXCLUDED FOR PRIVACY]',
                  newLineNo: 1,
                }],
              }],
              language: 'plaintext',
            };
            sources.push({ label: source.label, diff: sanitizedDiff });
            continue;
          }

          const diff = await source.diff().catch(() => null);
          throwIfCancellationRequested(cancellationToken);

          if (diff) {
            const { added, removed } = countDiffChanges(diff);
            totalAdditions += added;
            totalDeletions += removed;
          }

          if (isLock && diff) {
            // 依赖锁定文件（如 package-lock.json）不展开大块 diff，保留极简摘要以节约 token 并避免冲淡核心代码
            const compactLockDiff: FileDiff = {
              ...diff,
              hunks: [{
                header: '@@ dependency lockfile @@',
                oldStart: 0,
                oldLines: 0,
                newStart: 0,
                newLines: 0,
                lines: [{
                  type: 'context',
                  content: '[dependency lockfile diff omitted to prioritize core logic]',
                }],
              }],
            };
            sources.push({ label: source.label, diff: compactLockDiff });
          } else {
            sources.push({ label: source.label, diff });
          }
        }
        if (!sources.length) continue;
        const sourceSummary = sources.map(source => (
          `${service.kind === 'git' ? source.label : 'working'}${formatDiffStats(source.diff, file)}`
        )).join(', ');
        const label = `${file.status.toUpperCase()} ${file.path}`;
        groupEntries.push({
          label,
          summary: `${label}${sourceSummary ? ` [${sourceSummary}]` : ''}`,
          sources,
        });
      }
      if (groupEntries.length) {
        preparedGroups.push({
          headingLines: [
            `[${vcsKind}] ${repoName} (${status.branch.detachedTag ?? status.branch.detachedHash ?? status.branch.name})`,
            'Changed files:',
          ],
          entries: groupEntries,
        });
      }
    }

    const entryCount = preparedGroups.reduce((total, group) => total + group.entries.length, 0);
    const detailBlockTokenBudget = getFairDetailBlockTokenBudget(contextTokenBudget, entryCount);
    const groups: FairContextGroup[] = preparedGroups.map(group => ({
      headingLines: group.headingLines,
      entries: group.entries.map(entry => ({
        summary: entry.summary,
        detailBlocks: entry.sources.flatMap(source => buildDiffDetailBlocks(
          `${entry.label}${source.label ? ` [${source.label}]` : ''}`,
          source.diff,
          detailBlockTokenBudget,
          { linesAroundChange: AI_COMMIT_CONTEXT_LINES_AROUND_CHANGE },
        )),
      })),
    }));
    const context = buildFairContext(['# Change summary'], groups, contextTokenBudget);
    const text = context.text;
    if (!text) throw new Error(t('No changes to generate a commit message from.'));

    return {
      text,
      repoRootPaths: Array.from(includedRepoRootPaths),
      selectedPaths: Array.from(selectedPaths),
      vcsKinds: Array.from(vcsKinds),
      repositoryCount: includedRepoIds.size,
      fileCount: context.includedEntryCount,
      totalAdditions,
      totalDeletions,
      userPrompt,
      branchIntent: candidateBranchIntents.length === 1 ? candidateBranchIntents[0] : undefined,
      contextCharCount: text.length,
      truncated: context.truncated,
    };
  }

  private async generateCommitMessage(
    targets: CommitGenerateMessageTarget[] | undefined,
    repoIds: string[] | undefined,
    userPrompt: string | undefined,
    requestId: string,
    cancellationToken: vscode.CancellationToken,
  ): Promise<string> {
    const context = await this.buildAiCommitMessageContext(targets, repoIds, userPrompt, cancellationToken);
    return this.generateCommitMessageFromContext(
      context,
      requestId,
      cancellationToken,
      message => this.post({ type: 'COMMIT_SET_MESSAGE', requestId, message }),
    );
  }

  private async generateCommitMessageFromContext(
    context: AiCommitMessageGenerationContext,
    requestId: string,
    cancellationToken: vscode.CancellationToken,
    onMessage: (message: string) => void,
  ): Promise<string> {
    const provider = this.aiCommitMessageService.getProvider();
    const startedAt = Date.now();
    let streamedMessage = '';

    const emitDelta = (delta: string): void => {
      if (!delta || cancellationToken.isCancellationRequested) return;
      streamedMessage += delta;
      onMessage(streamedMessage);
    };

    this.logger?.info('AICommitMessage', 'Generation started', {
      requestId,
      provider,
      repositoryCount: context.repositoryCount,
      fileCount: context.fileCount,
      contextCharCount: context.contextCharCount,
      vcs: context.vcsKinds.join('+'),
      contextTruncated: context.truncated,
    });

    try {
      const result = await this.aiCommitMessageService.generate({
        context,
        cancellationToken,
        onDelta: emitDelta,
      });
      throwIfCancellationRequested(cancellationToken);

      if (!result.streamed) {
        streamedMessage = '';
        for (const character of result.message) {
          throwIfCancellationRequested(cancellationToken);
          streamedMessage += character;
          onMessage(streamedMessage);
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } else if (streamedMessage !== result.message) {
        streamedMessage = result.message;
        onMessage(result.message);
      }

      this.logger?.info('AICommitMessage', 'Generation completed', {
        requestId,
        provider: result.provider,
        model: result.model,
        promptSource: result.promptSource,
        inputCharCount: result.inputCharCount,
        inputTruncated: result.inputTruncated,
        maxOutputTokens: result.maxOutputTokens,
        ...(result.inputTokenCount === undefined ? {} : {
          inputTokenCount: result.inputTokenCount,
          inputTokenBudget: result.inputTokenBudget,
          maxInputTokens: result.maxInputTokens,
        }),
        streamChunkCount: result.streamChunkCount,
        streamCharCount: result.streamCharCount,
        firstTokenLatencyMs: result.firstTokenLatencyMs,
        durationMs: result.durationMs,
      });
      return result.message;
    } catch (error: unknown) {
      if (cancellationToken.isCancellationRequested || (error instanceof Error && error.message === 'Cancelled')) {
        this.logger?.info('AICommitMessage', 'Generation cancelled', {
          requestId,
          provider,
          durationMs: Date.now() - startedAt,
        });
      } else {
        this.logger?.error('AICommitMessage', 'Generation failed', error, {
          requestId,
          provider,
          durationMs: Date.now() - startedAt,
        });
      }
      throw error;
    }
  }

  private getDefaultCommitAction(): 'commit' | 'commitAndPush' {
    return vscode.workspace.getConfiguration('versiondock').get<'commit' | 'commitAndPush'>('defaultCommitAction', 'commit');
  }

  private getDefaultSaveAction(): 'stash' | 'shelve' {
    return vscode.workspace.getConfiguration('versiondock').get<'stash' | 'shelve'>('defaultSaveAction', 'stash');
  }

  private getHiddenRepoIds(): string[] {
    const saved = this.workspaceState?.get<string[]>('versiondock.hiddenRepoIds', []) ?? [];
    return this.manager.normalizeRepoIds(saved);
  }

  private async setHiddenRepoIds(ids: string[]): Promise<void> {
    await this.workspaceState?.update('versiondock.hiddenRepoIds', ids);
    this.post({ type: 'COMMIT_HIDDEN_REPOS_UPDATE', hiddenRepoIds: ids });
    this.logProvider?.notifyHiddenReposChanged(ids);
    this.badgeController?.setHiddenRepoIds(ids);
  }

  async hideRepo(repoId: string): Promise<void> {
    const allMetas = this.manager.getRepoMetas();
    const current = this.getHiddenRepoIds();
    const remainingVisible = allMetas.filter(m => !current.includes(m.id) && m.id !== repoId);
    if (remainingVisible.length === 0) {
      vscode.window.showWarningMessage(t('VersionDock: At least one repository must remain visible.'));
      return;
    }
    if (!current.includes(repoId)) {
      await this.setHiddenRepoIds([...current, repoId]);
    }
  }

  async unhideRepo(repoId: string): Promise<void> {
    const current = this.getHiddenRepoIds();
    await this.setHiddenRepoIds(current.filter(id => id !== repoId));
  }

  async manageHiddenRepos(): Promise<void> {
    const allMetas = this.manager.getRepoMetas();
    if (allMetas.length === 0) return;
    const hidden = this.getHiddenRepoIds();
    if (allMetas.length <= 1 && hidden.length === 0) {
      vscode.window.showInformationMessage(t('VersionDock: Only one repository in current workspace.'));
      return;
    }
    const items: Array<vscode.QuickPickItem & { repoId: string }> = allMetas.map(meta => {
      const isVisible = !hidden.includes(meta.id);
      return {
        label: meta.name,
        description: meta.rootPath,
        picked: isVisible,
        repoId: meta.id,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: t('Select repositories to display in the panel (uncheck to hide)'),
      canPickMany: true,
      title: t('Manage Repository Visibility'),
    });
    if (!picked) return;
    const visibleRepoIds = new Set(picked.map(p => p.repoId));
    if (visibleRepoIds.size === 0) {
      vscode.window.showWarningMessage(t('VersionDock: At least one repository must remain visible.'));
      return;
    }
    const newHidden = allMetas.map(m => m.id).filter(id => !visibleRepoIds.has(id));
    await this.setHiddenRepoIds(newHidden);
  }

  private getOrCreateChangelistService(): ChangelistService | undefined {
    if (this.changelistService) return this.changelistService;
    const folderPath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folderPath) return undefined;
    this.changelistService = new ChangelistService(folderPath, this.globalStoragePath, this.getChangesViewMode() === 'changelists');
    return this.changelistService;
  }

  private postChangelistsUpdate(status?: WorkspaceStatus): void {
    const svc = this.getOrCreateChangelistService();
    if (!svc) return;
    if (status) svc.reconcile(status.repos);
    this.post({
      type: 'CHANGELISTS_UPDATE',
      changelists: svc.getAll(),
      viewMode: this.getChangesViewMode(),
    });
  }

  private buildChangelistAssignments(
    svc: ChangelistService,
    repoId: string,
    paths?: string[],
  ): Array<{ path: string; changelistId: string; changelistName: string }> | undefined {
    const result: Array<{ path: string; changelistId: string; changelistName: string }> = [];
    for (const cl of svc.getAll()) {
      const clPaths = cl.fileAssignments[repoId] ?? [];
      for (const p of clPaths) {
        if (!paths || paths.includes(p)) {
          result.push({ path: p, changelistId: cl.id, changelistName: cl.name });
        }
      }
    }
    return result.length > 0 ? result : undefined;
  }

  private async restoreChangelistAssignments(
    repoId: string,
    assignments: Array<{ path: string; changelistId: string; changelistName: string }>,
  ): Promise<void> {
    const svc = this.getOrCreateChangelistService();
    if (!svc) return;
    // Ensure all target changelists exist (recreate if deleted)
    const existing = svc.getAll();
    const neededIds = [...new Set(assignments.map(a => a.changelistId))];
    for (const id of neededIds) {
      const { CHANGELIST_DEFAULT_ID: DEF, CHANGELIST_UNVERSIONED_ID: UNV } = await import('../types/git');
      if (id === DEF || id === UNV) continue;
      if (!existing.find(c => c.id === id)) {
        const name = assignments.find(a => a.changelistId === id)?.changelistName ?? id;
        const newCl = svc.create(name);
        // Override the auto-generated id to match the original (so assignments work)
        // We can't do that easily, so instead remap to the new id
        const newId = newCl.id;
        for (const a of assignments) {
          if (a.changelistId === id) a.changelistId = newId;
        }
      }
    }
    svc.moveFiles(assignments.map(a => ({ repoId, path: a.path, changelistId: a.changelistId })));
  }

  private async stageUnversionedFiles(
    svc: ChangelistService,
    assignments: Array<{ repoId: string; path: string; changelistId: string }>,
  ): Promise<void> {
    const unversionedCl = svc.getAll().find(c => c.id === CHANGELIST_UNVERSIONED_ID);
    if (!unversionedCl) return;
    const byRepo = new Map<string, string[]>();
    for (const { repoId, path: filePath, changelistId } of assignments) {
      if (changelistId === CHANGELIST_UNVERSIONED_ID) continue;
      const unvPaths = unversionedCl.fileAssignments[repoId] ?? [];
      if (!unvPaths.includes(filePath)) continue;
      if (!byRepo.has(repoId)) byRepo.set(repoId, []);
      byRepo.get(repoId)!.push(filePath);
    }
    for (const [repoId, paths] of byRepo) {
      const repo = this.manager.getRepo(repoId);
      if (repo) await repo.stageFiles(paths).catch(() => {});
    }
  }

  private getSubtreeStore(): vscode.Memento | undefined {
    return this.workspaceState ?? this.globalState;
  }

  private restoreSubtreeCaches(): void {
    const store = this.getSubtreeStore();
    if (!store) return;
    try {
      const savedStatuses = store.get<SerializedSubtreeStatusCache>(SUBTREE_STATUS_CACHE_KEY);
      if (savedStatuses && typeof savedStatuses === 'object') {
        for (const [id, cached] of Object.entries(savedStatuses)) {
          if (cached && typeof cached === 'object' && cached.key && cached.status) {
            this.subtreeStatusCache.set(id, cached);
          }
        }
      }
    } catch (e) {
      this.logger?.warn('CommitPanel', 'Failed to restore subtree status cache', { error: String(e) });
    }
  }

  private persistSubtreeStatusCache(): void {
    const store = this.getSubtreeStore();
    if (!store) return;
    const obj: SerializedSubtreeStatusCache = {};
    for (const [id, cached] of this.subtreeStatusCache.entries()) {
      if (cached && !cached.status?.loading) {
        obj[id] = cached;
      }
    }
    void store.update(SUBTREE_STATUS_CACHE_KEY, obj);
  }

  private restoreRepoSubtreeSplitCache(repo: GitService): void {
    const store = this.getSubtreeStore();
    if (!store) return;
    try {
      const saved = store.get<SerializedSubtreeSplitCache>(SUBTREE_SPLIT_CACHE_KEY);
      if (saved && saved[repo.repoId]) {
        repo.restoreSubtreeSplitCache(saved[repo.repoId]);
      }
    } catch (e) {
      this.logger?.warn('CommitPanel', 'Failed to restore subtree split cache for repo', { error: String(e) });
    }
  }

  private persistRepoSubtreeSplitCache(repo: GitService): void {
    const store = this.getSubtreeStore();
    if (!store) return;
    try {
      const saved = store.get<SerializedSubtreeSplitCache>(SUBTREE_SPLIT_CACHE_KEY) ?? {};
      const repoCache = repo.exportSubtreeSplitCache();
      if (Object.keys(repoCache).length > 0) {
        saved[repo.repoId] = { ...(saved[repo.repoId] ?? {}), ...repoCache };
        void store.update(SUBTREE_SPLIT_CACHE_KEY, saved);
      }
    } catch (e) {
      this.logger?.warn('CommitPanel', 'Failed to persist subtree split cache for repo', { error: String(e) });
    }
  }

  private getSubtreeEntries(): SubtreeEntry[] {
    return [...(this.getSubtreeStore()?.get<SubtreeEntry[]>(SUBTREE_STATE_KEY, []) ?? [])];
  }

  private async saveSubtreeEntries(entries: SubtreeEntry[]): Promise<void> {
    await this.getSubtreeStore()?.update(SUBTREE_STATE_KEY, entries);
  }

  private invalidateAllSubtreeRemoteCaches(): void {
    for (const meta of this.manager.getRepoMetas()) {
      const repo = this.manager.getRepo(meta.id);
      if (repo && repo.kind === 'git') {
        (repo as GitService).invalidateSubtreeRemoteCache();
      }
    }
  }

  private async refreshSubtreeList(options: SubtreeStatusRefreshOptions = {}): Promise<void> {
    if (options.force) {
      // Invalidate remote hash cache on forced refresh to query live remote references.
      this.invalidateAllSubtreeRemoteCaches();
    } else if (options.forceEntryIds) {
      for (const id of options.forceEntryIds) {
        const entry = this.findSubtreeEntry(id);
        if (entry) {
          const repo = this.manager.getRepo(entry.repoId);
          if (repo && repo.kind === 'git') {
            (repo as GitService).invalidateSubtreeRemoteCache(entry.repository);
          }
        }
      }
    }
    const entries = this.getSubtreeEntries();
    this.post({ type: 'SUBTREE_LIST_RESULT', entries });
    if (options.skipStatuses) return;
    await this.postSubtreeStatuses(entries, options);
  }

  private postSubtreeList(options: SubtreeStatusRefreshOptions = {}): void {
    void this.refreshSubtreeList(options);
  }

  private getSubtreeStatusCacheKey(entry: SubtreeEntry): string {
    return [entry.repoId, entry.prefix, entry.repository, entry.ref].join('\0');
  }

  private getCachedSubtreeStatus(entry: SubtreeEntry): CachedSubtreeStatus | undefined {
    const cached = this.subtreeStatusCache.get(entry.id);
    if (!cached || cached.key !== this.getSubtreeStatusCacheKey(entry)) return undefined;
    return cached;
  }

  private invalidateSubtreeStatus(entryId?: string, options?: { remote?: boolean }): void {
    if (entryId) {
      this.subtreeStatusCache.delete(entryId);
      this.subtreeStatusTasks.delete(entryId);
      this.notifiedSubtreeUpdateKeys.delete(entryId);
      if (options?.remote) {
        const entry = this.findSubtreeEntry(entryId);
        if (entry) {
          const repo = this.manager.getRepo(entry.repoId);
          if (repo && repo.kind === 'git') {
            (repo as GitService).invalidateSubtreeRemoteCache(entry.repository);
          }
        }
      }
      this.persistSubtreeStatusCache();
      return;
    }
    this.subtreeStatusCache.clear();
    this.subtreeStatusTasks.clear();
    this.notifiedSubtreeUpdateKeys.clear();
    if (options?.remote) {
      for (const meta of this.manager.getRepoMetas()) {
        const repo = this.manager.getRepo(meta.id);
        if (repo && repo.kind === 'git') {
          (repo as GitService).invalidateSubtreeRemoteCache();
        }
      }
    }
    this.persistSubtreeStatusCache();
  }

  private getSubtreeStatusTask(entry: SubtreeEntry, options?: { forceRemote?: boolean }): Promise<SubtreePushStatus> {
    const key = this.getSubtreeStatusCacheKey(entry);
    const existing = this.subtreeStatusTasks.get(entry.id);
    if (existing?.key === key && !options?.forceRemote) return existing.task;

    const task = (async (): Promise<SubtreePushStatus> => {
      const repo = this.manager.getRepo(entry.repoId);
      if (!repo) return { error: t('Repo not found') };
      try {
        if (repo.kind === 'git') {
          this.restoreRepoSubtreeSplitCache(repo as GitService);
        }
        const status = await repo.getSubtreePushStatus(
          entry.prefix,
          entry.repository,
          entry.ref,
          { forceRemote: options?.forceRemote },
        );
        if (repo.kind === 'git') {
          this.persistRepoSubtreeSplitCache(repo as GitService);
        }
        return status;
      } catch (e: unknown) {
        return { error: String(e) };
      }
    })();

    this.subtreeStatusTasks.set(entry.id, { key, task });
    void task.then(status => {
      if (this.subtreeStatusTasks.get(entry.id)?.task === task) {
        this.subtreeStatusCache.set(entry.id, { key, status, checkedAt: Date.now() });
        this.persistSubtreeStatusCache();
      }
    }).finally(() => {
      if (this.subtreeStatusTasks.get(entry.id)?.task === task) {
        this.subtreeStatusTasks.delete(entry.id);
      }
    });
    return task;
  }

  private collectSubtreeStatusSnapshot(entries: SubtreeEntry[]): Record<string, SubtreePushStatus> {
    const statuses: Record<string, SubtreePushStatus> = {};
    for (const entry of entries) {
      statuses[entry.id] = this.getCachedSubtreeStatus(entry)?.status ?? { loading: true };
    }
    return statuses;
  }

  private notifySubtreeStatusUpdates(entries: SubtreeEntry[], statuses: Record<string, SubtreePushStatus>): void {
    const changed: Array<{ entry: SubtreeEntry; status: SubtreePushStatus }> = [];
    for (const entry of entries) {
      const status = statuses[entry.id];
      const hasUpdates = Boolean(status?.hasUpdates || (status?.aheadCount ?? 0) > 0);
      if (!hasUpdates) {
        this.notifiedSubtreeUpdateKeys.delete(entry.id);
        continue;
      }

      const notificationKey = [
        status.remoteRef ?? entry.ref,
        status.splitHash ?? '',
        status.remoteHash ?? '',
        status.aheadCount ?? '',
        status.hasUpdates ? 'updates' : '',
      ].join(':');
      if (this.notifiedSubtreeUpdateKeys.get(entry.id) === notificationKey) continue;
      this.notifiedSubtreeUpdateKeys.set(entry.id, notificationKey);
      changed.push({ entry, status });
    }

    if (changed.length === 0) return;
    const singleRepoName = changed.length === 1
      ? (this.manager.getRepoMeta(changed[0].entry.repoId)?.name || changed[0].entry.repoId)
      : undefined;
    const totalAhead = changed.reduce((sum, item) => sum + (item.status.aheadCount ?? 0), 0);
    if (totalAhead > 0) {
      const message = singleRepoName
        ? t('VersionDock [{0}]: Subtree "{1}" has {2} to push.', singleRepoName, changed[0].entry.name, totalAhead)
        : (changed.length === 1
          ? t('VersionDock: Subtree "{0}" has {1} to push.', changed[0].entry.name, totalAhead)
          : t('VersionDock: {0} subtrees have {1} to push.', changed.length, totalAhead));
      vscode.window.showInformationMessage(message);
      return;
    }

    const message = singleRepoName
      ? t('VersionDock [{0}]: Subtree "{1}" has updates to push.', singleRepoName, changed[0].entry.name)
      : (changed.length === 1
        ? t('VersionDock: Subtree "{0}" has updates to push.', changed[0].entry.name)
        : t('VersionDock: {0} subtrees have updates to push.', changed.length));
    vscode.window.showInformationMessage(message);
  }

  private async postSubtreeStatuses(
    entries: SubtreeEntry[] = this.getSubtreeEntries(),
    options: SubtreeStatusRefreshOptions = {},
  ): Promise<void> {
    const now = Date.now();
    const staleEntries: SubtreeEntry[] = [];
    const staleEntryIds = new Set<string>();
    for (const entry of entries) {
      const cached = this.getCachedSubtreeStatus(entry);
      const force = options.force || options.forceEntryIds?.has(entry.id);
      if (force || !cached || now - cached.checkedAt >= SUBTREE_STATUS_CACHE_TTL_MS) {
        staleEntries.push(entry);
        staleEntryIds.add(entry.id);
      }
    }

    const initialStatuses = this.collectSubtreeStatusSnapshot(entries);
    for (const entryId of staleEntryIds) {
      const isForced = Boolean(options.force || options.forceEntryIds?.has(entryId));
      if (isForced || !initialStatuses[entryId] || initialStatuses[entryId].loading) {
        initialStatuses[entryId] = { loading: true };
      }
    }
    this.post({ type: 'SUBTREE_STATUS_RESULT', statuses: initialStatuses });

    if (staleEntries.length === 0) {
      if (options.notifyStatusUpdates) this.notifySubtreeStatusUpdates(entries, initialStatuses);
      return;
    }

    await Promise.all(
      staleEntries.map(async entry => {
        try {
          const isForced = Boolean(options.force || options.forceEntryIds?.has(entry.id));
          const status = await this.getSubtreeStatusTask(entry, { forceRemote: isForced });
          this.post({ type: 'SUBTREE_STATUS_RESULT', statuses: { [entry.id]: status } });
        } catch {
          // Handled internally in getSubtreeStatusTask
        }
      })
    );

    const currentEntries = this.getSubtreeEntries();
    const statuses = this.collectSubtreeStatusSnapshot(currentEntries);
    this.post({ type: 'SUBTREE_STATUS_RESULT', statuses });
    if (options.notifyStatusUpdates) this.notifySubtreeStatusUpdates(currentEntries, statuses);
  }

  private async postCommitStatusUpdate(options: { includeIconTheme?: boolean; refreshSubtrees?: boolean; fresh?: boolean } = {}): Promise<void> {
    const [repos, status, iconTheme] = await Promise.all([
      Promise.resolve(this.manager.getRepoMetas()),
      options.fresh ? this.manager.getAllStatusesFresh() : this.manager.getAllStatuses(),
      options.includeIconTheme && this.view
        ? loadIconTheme(this.view.webview)
        : Promise.resolve(undefined),
    ]);
    const hasConflicts = Array.isArray(status?.repos) && status.repos.some(repo => (repo.conflictCount || 0) > 0);
    this.updateConflictContext(hasConflicts);
    this.badgeController?.update(status);
    this.post({ type: 'COMMIT_STATUS_UPDATE', repos, status, iconTheme });
    this.postChangelistsUpdate(status);
    if (options.refreshSubtrees) {
      await this.refreshSubtreeList({ force: true });
    }
  }

  private normalizeSubtreePrefix(prefix: string): string {
    const raw = prefix.trim().replace(/\\/g, '/');
    if (!raw) throw new Error(t('Subtree prefix is required.'));
    if (path.isAbsolute(raw) || /^[a-zA-Z]:\//.test(raw)) {
      throw new Error(t('Subtree prefix must be relative to the repository root.'));
    }
    const trimmed = raw.replace(/^\/+|\/+$/g, '');
    const parts = trimmed.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) {
      throw new Error(t('Subtree prefix cannot contain "." or "..".'));
    }
    return parts.join('/');
  }

  private createSubtreeId(repoId: string, prefix: string): string {
    return `${repoId}:${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
  }

  private findSubtreeEntry(entryId: string): SubtreeEntry | undefined {
    return this.getSubtreeEntries().find(entry => entry.id === entryId);
  }

  private validateSubtreeEntry(
    input: Omit<SubtreeEntry, 'id'> & { id?: string },
    existingId?: string,
  ): SubtreeEntry {
    const repo = this.manager.getRepo(input.repoId);
    if (!repo) throw new Error(t('Repo not found'));

    const prefix = this.normalizeSubtreePrefix(input.prefix);
    const repository = input.repository.trim();
    const ref = input.ref.trim();
    if (!repository) throw new Error(t('Subtree repository is required.'));
    if (!ref) throw new Error(t('Subtree ref is required.'));

    const duplicate = this.getSubtreeEntries().find(entry =>
      entry.repoId === input.repoId
      && entry.prefix === prefix
      && entry.id !== existingId
    );
    if (duplicate) {
      throw new Error(t('A subtree is already registered for prefix "{0}".', prefix));
    }

    const name = input.name.trim() || path.posix.basename(prefix);
    return {
      id: existingId ?? input.id ?? this.createSubtreeId(input.repoId, prefix),
      repoId: input.repoId,
      name,
      prefix,
      repository,
      ref,
      defaultSquash: input.defaultSquash,
      lastSplitBranch: input.lastSplitBranch,
    };
  }

  private async pickSubtreeRepo(repoId?: string): Promise<RepoMeta | undefined> {
    const metas = this.manager.getRepoMetas();
    if (repoId) {
      const meta = metas.find(item => item.id === repoId);
      if (meta) return meta;
    }
    if (metas.length === 0) {
      vscode.window.showInformationMessage(t('VersionDock: No Git repositories found in this workspace.'));
      return undefined;
    }
    if (metas.length === 1) return metas[0];
    const picked = await vscode.window.showQuickPick(
      metas.map(meta => ({ label: meta.name, description: meta.rootPath, id: meta.id })),
      { title: t('Select Repository'), placeHolder: t('Select a repository…'), matchOnDescription: true },
    );
    return picked ? metas.find(meta => meta.id === picked.id) : undefined;
  }

  private async pickSubtreePrefix(
    repo: import('../git/GitService').GitService,
    currentValue = '',
  ): Promise<string | undefined> {
    if (currentValue) {
      const input = await vscode.window.showInputBox({
        title: t('Subtree Prefix'),
        prompt: t('Path relative to the repository root'),
        value: currentValue,
        placeHolder: t('e.g. vendor/project-a'),
      });
      return input?.trim();
    }

    const candidates = await repo.listTopLevelSubtreeCandidates();
    const customItem = { label: `$(edit) ${t('Enter custom prefix…')}`, id: CUSTOM_SUBTREE_PREFIX_ID };
    const picked = await vscode.window.showQuickPick(
      [
        customItem,
        ...candidates.map(candidate => ({ label: candidate, description: t('Top-level folder'), id: candidate })),
      ],
      { title: t('Subtree Prefix'), placeHolder: t('Select a top-level folder or enter a custom prefix') },
    );
    if (!picked) return undefined;
    if (picked.id !== CUSTOM_SUBTREE_PREFIX_ID) return picked.id;
    const input = await vscode.window.showInputBox({
      title: t('Subtree Prefix'),
      prompt: t('Path relative to the repository root'),
      placeHolder: t('e.g. vendor/project-a'),
    });
    return input?.trim();
  }

  private async pickSubtreeSquash(defaultSquash: boolean): Promise<boolean | undefined> {
    const items: Array<vscode.QuickPickItem & { value: boolean }> = [
      {
        label: defaultSquash ? `$(check) ${t('Squash history')}` : t('Squash history'),
        description: t('Use --squash'),
        value: true,
      },
      {
        label: !defaultSquash ? `$(check) ${t('Keep full history')}` : t('Keep full history'),
        description: t('Do not use --squash'),
        value: false,
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Subtree History Mode'),
      placeHolder: t('Choose how subtree history is merged'),
    });
    return picked?.value;
  }

  private async pickSubtreeRef(
    repo: import('../git/GitService').GitService,
    repository: string,
    currentValue = 'main',
  ): Promise<string | undefined> {
    const refs = await repo.listSubtreeRepositoryRefs(repository).catch(() => []);
    const items: SubtreeRefPickItem[] = refs
      .sort((left, right) => {
        if (left.type !== right.type) return left.type === 'branch' ? -1 : 1;
        return left.name.localeCompare(right.name);
      })
      .map(ref => ({
        label: ref.name,
        description: ref.type === 'branch' ? t('Branch') : t('Tag'),
        value: ref.name,
      }));

    return new Promise(resolve => {
      const quickPick = vscode.window.createQuickPick<SubtreeRefPickItem>();
      let settled = false;
      const finish = (value: string | undefined): void => {
        if (settled) return;
        settled = true;
        quickPick.hide();
        quickPick.dispose();
        resolve(value);
      };
      const updateItems = (): void => {
        const typed = quickPick.value.trim();
        const exact = items.find(item => item.value === typed);
        const customItem: SubtreeRefPickItem | undefined = typed && !exact
          ? {
              label: `$(edit) ${t('Use "{0}" as subtree ref', typed)}`,
              description: t('Custom ref'),
              value: typed,
              custom: true,
            }
          : undefined;
        quickPick.items = customItem ? [customItem, ...items] : items;
        if (customItem) {
          quickPick.activeItems = [customItem];
        } else if (exact) {
          quickPick.activeItems = [exact];
        }
      };

      quickPick.title = t('Subtree Ref');
      quickPick.placeholder = t('Select a branch/tag or type a custom ref');
      quickPick.matchOnDescription = true;
      quickPick.value = currentValue;
      quickPick.onDidChangeValue(updateItems);
      quickPick.onDidAccept(() => {
        const active = quickPick.activeItems[0];
        const typed = quickPick.value.trim();
        finish(active?.value.trim() || typed || undefined);
      });
      quickPick.onDidHide(() => finish(undefined));
      updateItems();
      quickPick.show();
    });
  }

  private async promptSubtreeEntry(
    mode: 'add' | 'register' | 'edit',
    existing?: SubtreeEntry,
    repoId?: string,
  ): Promise<{ entry: SubtreeEntry; message?: string } | undefined> {
    const meta = existing
      ? this.manager.getRepoMetas().find(item => item.id === existing.repoId)
      : await this.pickSubtreeRepo(repoId);
    if (!meta) return undefined;

    const repo = this.manager.getRepo(meta.id);
    if (!repo) {
      vscode.window.showWarningMessage(t('VersionDock [{0}]: Repository not found.', meta.name));
      return undefined;
    }

    const prefix = await this.pickSubtreePrefix(repo, existing?.prefix);
    if (!prefix) return undefined;

    const repository = await vscode.window.showInputBox({
      title: t('Subtree Repository'),
      prompt: t('Remote URL or local repository path'),
      value: existing?.repository ?? '',
      placeHolder: t('e.g. https://github.com/org/project.git'),
    });
    if (!repository?.trim()) return undefined;

    const ref = await this.pickSubtreeRef(repo, repository.trim(), existing?.ref ?? 'main');
    if (!ref?.trim()) return undefined;

    const defaultName = existing?.name ?? path.posix.basename(this.normalizeSubtreePrefix(prefix));
    const name = await vscode.window.showInputBox({
      title: t('Subtree Name'),
      prompt: t('Display name in the Subtree panel'),
      value: defaultName,
    });
    if (!name?.trim()) return undefined;

    const squash = await this.pickSubtreeSquash(existing?.defaultSquash ?? true);
    if (squash === undefined) return undefined;

    const entry = this.validateSubtreeEntry({
      id: existing?.id,
      repoId: meta.id,
      name: name.trim(),
      prefix,
      repository,
      ref,
      defaultSquash: squash,
      lastSplitBranch: existing?.lastSplitBranch,
    }, existing?.id);

    let message: string | undefined;
    if (mode === 'add') {
      const messageInput = await vscode.window.showInputBox({
        title: t('Subtree Commit Message'),
        prompt: t('Optional merge commit message'),
        value: t('Add subtree {0}', entry.name),
      });
      if (messageInput === undefined) return undefined;
      message = messageInput.trim();
    }

    return { entry, message };
  }

  private async ensureSubtreeClean(repo: import('../git/GitService').GitService, op: SubtreeOp): Promise<void> {
    const operation = op === 'add'
      ? t('add subtree')
      : op === 'pull'
        ? t('pull subtree')
        : op === 'merge'
          ? t('merge subtree')
          : op === 'remove'
            ? t('remove subtree')
            : t('run subtree operation');
    const state = await repo.getMergeRebaseState();
    if (state) {
      throw new Error(t('Cannot {0}: repository has an active {1}.', operation, state));
    }
    if (await repo.hasUncommittedChanges()) {
      throw new Error(t('Cannot {0}: commit, stash, or rollback local changes first.', operation));
    }
  }

  private async broadcastUnpushedCommits(repoIds?: string[]): Promise<void> {
    try {
      const allMetas = this.manager.getRepoMetas();
      const targetMetas = repoIds && repoIds.length > 0
        ? allMetas.filter(m => repoIds.includes(m.id))
        : allMetas;
      const repos = targetMetas.flatMap(meta => {
        const repo = this.manager.getRepo(meta.id);
        return repo && repo.kind !== 'svn' ? [{ id: meta.id, repo }] : [];
      });
      const unpushedList = await Promise.all(
        repos.map(async ({ id, repo }) => {
          try {
            const commits = await repo.getUnpushedCommits();
            return { repoId: id, commits };
          } catch (e: unknown) {
            return { repoId: id, commits: [], error: String(e) };
          }
        })
      );
      this.post({ type: 'PUSH_UNPUSHED_RESULT', repos: unpushedList });
      for (const item of unpushedList) {
        if (item.commits && item.commits.length > 0) {
          const r = this.manager.getRepo(item.repoId);
          if (r && r.kind !== 'svn') {
            this.triggerCommitsStatsUpdate(r as GitService, item.repoId, 'outgoing');
          }
        }
      }
    } catch { /* ignore */ }
  }

  private triggerCommitsStatsUpdate(repo: GitService, repoId: string, kind: 'outgoing' | 'incoming'): void {
    const p = kind === 'outgoing' ? repo.getUnpushedCommitsStats() : repo.getIncomingCommitsStats();
    void p.then(stats => {
      if (stats && Object.keys(stats).length > 0) {
        this.post({ type: 'PUSH_COMMITS_STATS_UPDATE', repoId, stats, kind });
      }
    }).catch(() => {});
  }

  private async broadcastIncomingCommits(repoIds?: string[], requestId?: string): Promise<void> {
    try {
      const allMetas = this.manager.getRepoMetas();
      const targetMetas = repoIds && repoIds.length > 0
        ? allMetas.filter(m => repoIds.includes(m.id))
        : allMetas;
      const gitRepos = targetMetas.flatMap(meta => {
        const repo = this.manager.getRepo(meta.id);
        return repo && repo.kind !== 'svn' ? [{ id: meta.id, repo: repo as GitService }] : [];
      });
      await Promise.all(gitRepos.map(async ({ id, repo }) => {
        try {
          const commits = await repo.getIncomingCommits();
          this.post({ type: 'SYNC_INCOMING_RESULT', requestId: requestId ?? '', repoId: id, commits });
          if (commits.length > 0) {
            this.triggerCommitsStatsUpdate(repo, id, 'incoming');
          }
        } catch (e: unknown) {
          this.post({ type: 'SYNC_INCOMING_RESULT', requestId: requestId ?? '', repoId: id, commits: [], error: String(e) });
        }
      }));
    } catch { /* ignore */ }
  }

  private async handleDataInvalidated(event: DataInvalidationEvent): Promise<void> {
    const scopes = new Set(event.scopes);
    if (scopes.has('workspace')) {
      await this.manager.reinitializeAndRefresh();
      this.logProvider?.refresh();
    }
    if (scopes.has('workingTree') || scopes.has('workspace')) {
      // refreshStatusNow() internally publishes status with context, which triggers onStatusChange
      // to send COMMIT_STATUS_UPDATE and CHANGELISTS_UPDATE without redundant derived data checks.
      await this.manager.refreshStatusNow({
        source: 'invalidation',
        scopes: event.scopes,
        suppressedRepoIds: event.repoIds,
      });
    }
    if (scopes.has('unpushed') || scopes.has('incoming')) {
      void this.broadcastUnpushedCommits(event.repoIds);
      void this.broadcastIncomingCommits(event.repoIds);
    }
    if (scopes.has('subtree')) {
      this.invalidateSubtreeStatus(undefined, { remote: event.force ?? false });
      if (this.isSubtreeTabActive()) {
        void this.refreshSubtreeList({ force: event.force ?? false });
      }
    }
    if (scopes.has('worktree')) {
      void (async () => {
        try {
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (error) {
          this.logger?.error('CommitPanel', 'Failed to refresh worktrees on invalidation', error);
        }
      })();
    }
    const targetMetas = event.repoIds && event.repoIds.length > 0
      ? this.manager.getRepoMetas().filter(m => event.repoIds!.includes(m.id))
      : this.manager.getRepoMetas();

    if (scopes.has('stash')) {
      for (const meta of targetMetas) {
        if (meta.kind !== 'svn') {
          const repo = this.manager.getRepo(meta.id);
          if (repo && repo.kind === 'git') {
            void repo.stashList().then(stashes => {
              this.post({ type: 'STASH_LIST_RESULT', requestId: '', repoId: meta.id, stashes });
              this.post({ type: 'STASH_COUNT_RESULT', requestId: '', repoId: meta.id, count: stashes.length });
            }).catch(() => {});
          }
        }
      }
    }
    if (scopes.has('shelf')) {
      for (const meta of targetMetas) {
        const svc = this.getShelveService(meta.id);
        if (svc) {
          void svc.list().then(shelves => {
            this.post({ type: 'SHELVE_LIST_RESULT', requestId: '', repoId: meta.id, shelves });
          }).catch(() => {});
        }
      }
    }
  }

  private async refreshAfterSubtreeOp(entryId?: string): Promise<void> {
    this.invalidateSubtreeStatus(entryId, { remote: true });
    const status = await this.refreshStatusAfterOp();
    this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
    this.postChangelistsUpdate(status);
    this.logProvider?.refresh();
    void this.broadcastUnpushedCommits();
    this.postSubtreeList(entryId ? { forceEntryIds: new Set([entryId]) } : { force: true });
  }

  private async upsertSubtreeEntry(entry: SubtreeEntry, options: { postList?: boolean; forceStatusRefresh?: boolean } = {}): Promise<void> {
    this.invalidateSubtreeStatus(entry.id, { remote: true });
    const entries = this.getSubtreeEntries();
    const idx = entries.findIndex(item => item.id === entry.id);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    await this.saveSubtreeEntries(entries);
    if (options.postList !== false) {
      this.postSubtreeList(options.forceStatusRefresh === false ? {} : { forceEntryIds: new Set([entry.id]) });
    }
  }

  private async removeSubtreeEntry(entryId: string): Promise<void> {
    this.invalidateSubtreeStatus(entryId, { remote: false });
    await this.saveSubtreeEntries(this.getSubtreeEntries().filter(entry => entry.id !== entryId));
    this.postSubtreeList();
  }

  private async createSubtreeFromPrompt(repoId?: string): Promise<void> {
    const result = await this.promptSubtreeEntry('add', undefined, repoId);
    if (!result) return;
    const repo = this.manager.getRepo(result.entry.repoId);
    if (!repo) return;
    try {
      await this.ensureSubtreeClean(repo, 'add');
      if (!(await repo.isPathEmptyOrMissing(result.entry.prefix))) {
        throw new Error(t('Cannot add subtree: prefix "{0}" already exists and is not empty.', result.entry.prefix));
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Adding subtree {1}', repo.meta.name, result.entry.name), cancellable: false },
        async () => repo.addSubtree(result.entry.prefix, result.entry.repository, result.entry.ref, result.entry.defaultSquash, result.message),
      );
      await this.upsertSubtreeEntry(result.entry, { postList: false });
      await this.refreshAfterSubtreeOp(result.entry.id);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" added.', repo.meta.name, result.entry.name));
    } catch (e: unknown) {
      vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to add subtree — {1}', repo.meta.name, String(e)));
    }
  }

  private async registerSubtreeFromPrompt(repoId?: string): Promise<void> {
    const result = await this.promptSubtreeEntry('register', undefined, repoId);
    if (!result) return;
    const repo = this.manager.getRepo(result.entry.repoId);
    if (!repo) return;
    const absPrefix = repo.resolveRepoPath(result.entry.prefix).absolutePath;
    if (!fs.existsSync(absPrefix)) {
      vscode.window.showWarningMessage(t('VersionDock [{0}]: Prefix "{1}" does not exist in this repository.', repo.meta.name, result.entry.prefix));
      return;
    }
    try {
      await this.upsertSubtreeEntry(result.entry);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" registered.', repo.meta.name, result.entry.name));
    } catch (e: unknown) {
      vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to register subtree — {1}', repo.meta.name, String(e)));
    }
  }

  private async editSubtreeFromPrompt(entryId: string): Promise<void> {
    const existing = this.findSubtreeEntry(entryId);
    if (!existing) {
      vscode.window.showWarningMessage(t('VersionDock: Subtree entry not found.'));
      return;
    }
    const repoName = this.manager.getRepoMeta(existing.repoId)?.name || existing.repoId;
    const result = await this.promptSubtreeEntry('edit', existing);
    if (!result) return;
    try {
      await this.upsertSubtreeEntry(result.entry);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" updated.', repoName, result.entry.name));
    } catch (e: unknown) {
      vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to update subtree — {1}', repoName, String(e)));
    }
  }

  private async runSubtreeEntryOp(
    requestId: string,
    entryId: string,
    op: Exclude<SubtreeOp, 'add' | 'register' | 'edit' | 'delete'>,
  ): Promise<void> {
    const entry = this.findSubtreeEntry(entryId);
    if (!entry) {
      const error = t('Subtree entry not found.');
      vscode.window.showErrorMessage(t('VersionDock: {0}', error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: '', entryId, op, ok: false, error });
      return;
    }
    const repo = this.manager.getRepo(entry.repoId);
    if (!repo) {
      const error = t('Repo not found');
      const repoName = this.manager.getRepoMeta(entry.repoId)?.name ?? entry.repoId;
      vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repoName, error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op, ok: false, error });
      return;
    }
    try {
      let output = '';
      if (op === 'pull') {
        await this.ensureSubtreeClean(repo, 'pull');
        output = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Pulling subtree {1}…', repo.meta.name, entry.name), cancellable: false },
          async () => repo.pullSubtree(entry.prefix, entry.repository, entry.ref, entry.defaultSquash),
        );
      } else if (op === 'push') {
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Push subtree "{1}" from prefix "{2}" to "{3}" ref "{4}"? This pushes only the subtree history, not the parent repository.', repo.meta.name, entry.name, entry.prefix, entry.repository, entry.ref),
          { modal: true },
          t('Push Subtree'),
        );
        if (confirm !== t('Push Subtree')) {
          this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'push', ok: false, error: 'Cancelled' });
          return;
        }
        output = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Pushing subtree {1}…', repo.meta.name, entry.name), cancellable: false },
          async () => repo.pushSubtree(entry.prefix, entry.repository, entry.ref),
        );
      } else if (op === 'remove') {
        await this.ensureSubtreeClean(repo, 'remove');
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Remove subtree "{1}" from prefix "{2}"? This stages the deletion but does not commit it.', repo.meta.name, entry.name, entry.prefix),
          { modal: true },
          t('Remove'),
        );
        if (confirm !== t('Remove')) {
          this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op, ok: false, error: 'Cancelled' });
          return;
        }
        output = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Removing subtree {1}…', repo.meta.name, entry.name), cancellable: false },
          async () => repo.removeSubtree(entry.prefix),
        );
      }
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op, ok: true, output });
      await this.refreshAfterSubtreeOp(entry.id);
      if (op === 'pull') {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" pulled.', repo.meta.name, entry.name));
      } else if (op === 'push') {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" pushed.', repo.meta.name, entry.name));
      } else if (op === 'remove') {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" removed from working tree.', repo.meta.name, entry.name));
      }
    } catch (e: unknown) {
      const error = String(e);
      const message = op === 'pull'
        ? t('VersionDock [{0}]: Failed to pull subtree "{1}" — {2}', repo.meta.name, entry.name, error)
        : op === 'push'
          ? t('VersionDock [{0}]: Failed to push subtree "{1}" — {2}', repo.meta.name, entry.name, error)
          : t('VersionDock [{0}]: Failed to remove subtree "{1}" — {2}', repo.meta.name, entry.name, error);
      vscode.window.showErrorMessage(message);
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op, ok: false, error });
    }
  }

  private async splitSubtreeFromPrompt(requestId: string, entryId: string): Promise<void> {
    const entry = this.findSubtreeEntry(entryId);
    if (!entry) {
      const error = t('Subtree entry not found.');
      vscode.window.showErrorMessage(t('VersionDock: {0}', error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: '', entryId, op: 'split', ok: false, error });
      return;
    }
    const repo = this.manager.getRepo(entry.repoId);
    if (!repo) {
      const error = t('Repo not found');
      const repoName = this.manager.getRepoMeta(entry.repoId)?.name ?? entry.repoId;
      vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repoName, error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'split', ok: false, error });
      return;
    }

    const defaultBranch = entry.lastSplitBranch ?? `subtree/${entry.name.replace(/\s+/g, '-').toLowerCase()}`;
    const branch = (await vscode.window.showInputBox({
      title: t('Subtree Split Branch'),
      prompt: t('Optional branch to create from the split result'),
      value: defaultBranch,
    }))?.trim();
    if (branch === undefined) return;

    const annotate = (await vscode.window.showInputBox({
      title: t('Subtree Split Annotate'),
      prompt: t('Optional commit message prefix for split commits'),
      placeHolder: t('e.g. [{0}] ', entry.name),
    }))?.trim();
    if (annotate === undefined) return;

    const rejoinPick = await vscode.window.showQuickPick(
      [
        { label: t('Split only'), value: false },
        { label: t('Split and rejoin'), description: t('Uses --rejoin and requires a clean repository'), value: true },
      ],
      { title: t('Subtree Split Mode') },
    );
    if (!rejoinPick) return;

    const onto = (await vscode.window.showInputBox({
      title: t('Subtree Split Onto'),
      prompt: t('Optional --onto commit'),
      placeHolder: t('Leave empty for default'),
    }))?.trim();
    if (onto === undefined) return;

    const commit = (await vscode.window.showInputBox({
      title: t('Subtree Split Commit'),
      prompt: t('Optional commit to split from'),
      placeHolder: t('Leave empty for HEAD'),
    }))?.trim();
    if (commit === undefined) return;

    try {
      if (rejoinPick.value) await this.ensureSubtreeClean(repo, 'split');
      const output = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Splitting subtree {1}…', repo.meta.name, entry.name), cancellable: false },
        async () => repo.splitSubtree(
          entry.prefix,
          branch || undefined,
          annotate || undefined,
          rejoinPick.value,
          onto || undefined,
          commit || undefined,
        ),
      );
      if (branch) {
        await this.upsertSubtreeEntry({ ...entry, lastSplitBranch: branch }, { postList: false });
      }
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'split', ok: true, output });
      await this.refreshAfterSubtreeOp(entry.id);
      if (branch) {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" split to branch "{2}".', repo.meta.name, entry.name, branch));
      } else {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" split.', repo.meta.name, entry.name));
      }
    } catch (e: unknown) {
      const error = String(e);
      vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to split subtree "{1}" — {2}', repo.meta.name, entry.name, error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'split', ok: false, error });
    }
  }

  private async mergeSubtreeFromPrompt(requestId: string, entryId: string): Promise<void> {
    const entry = this.findSubtreeEntry(entryId);
    if (!entry) {
      const error = t('Subtree entry not found.');
      vscode.window.showErrorMessage(t('VersionDock: {0}', error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: '', entryId, op: 'merge', ok: false, error });
      return;
    }
    const repo = this.manager.getRepo(entry.repoId);
    if (!repo) {
      const error = t('Repo not found');
      const repoName = this.manager.getRepoMeta(entry.repoId)?.name ?? entry.repoId;
      vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repoName, error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'merge', ok: false, error });
      return;
    }
    const commit = (await vscode.window.showInputBox({
      title: t('Subtree Merge Commit'),
      prompt: t('Commit, branch, or tag to merge into the subtree prefix'),
      value: entry.ref,
    }))?.trim();
    if (!commit) return;
    const squash = await this.pickSubtreeSquash(entry.defaultSquash);
    if (squash === undefined) return;
    const message = (await vscode.window.showInputBox({
      title: t('Subtree Merge Message'),
      prompt: t('Optional merge commit message'),
      value: t('Merge subtree {0}', entry.name),
    }))?.trim();
    if (message === undefined) return;
    try {
      await this.ensureSubtreeClean(repo, 'merge');
      const output = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Merging subtree {1}…', repo.meta.name, entry.name), cancellable: false },
        async () => repo.mergeSubtree(entry.prefix, commit, squash, message),
      );
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'merge', ok: true, output });
      await this.refreshAfterSubtreeOp(entry.id);
      vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" merged.', repo.meta.name, entry.name));
    } catch (e: unknown) {
      const error = String(e);
      vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to merge subtree "{1}" — {2}', repo.meta.name, entry.name, error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'merge', ok: false, error });
    }
  }

  private async pickSubtreeEntry(title: string): Promise<SubtreeEntry | undefined> {
    const entries = this.getSubtreeEntries();
    if (entries.length === 0) {
      vscode.window.showInformationMessage(t('VersionDock: No subtrees registered in this workspace.'));
      return undefined;
    }
    if (entries.length === 1) return entries[0];
    const metaMap = new Map(this.manager.getRepoMetas().map(meta => [meta.id, meta]));
    const picked = await vscode.window.showQuickPick(
      entries.map(entry => {
        const meta = metaMap.get(entry.repoId);
        return {
          label: entry.name,
          description: entry.prefix,
          detail: `${meta?.name ?? entry.repoId} · ${entry.repository} · ${entry.ref}`,
          entryId: entry.id,
        };
      }),
      { title, matchOnDescription: true, matchOnDetail: true },
    );
    return picked ? entries.find(entry => entry.id === picked.entryId) : undefined;
  }

  private async handleMessage(msg: CommitToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'COMMIT_READ_CLIPBOARD': {
        try {
          const text = await vscode.env.clipboard.readText();
          this.post({ type: 'COMMIT_READ_CLIPBOARD_RESULT', requestId: msg.requestId, text });
        } catch {
          this.post({ type: 'COMMIT_READ_CLIPBOARD_RESULT', requestId: msg.requestId, text: '' });
        }
        break;
      }

      case 'COMMIT_WRITE_CLIPBOARD': {
        try {
          await vscode.env.clipboard.writeText(msg.text);
        } catch {
          // ignore
        }
        break;
      }

      case 'COMMIT_WEBVIEW_ERROR': {
        this.logger?.error('CommitPanelWebview', msg.message, msg.stack, { componentStack: msg.componentStack });
        break;
      }

      case 'COMMIT_REQUEST_STATUS': {
        const isSidebarRequest = this.replyTarget.getStore() !== 'undocked';
        const sidebarGeneration = this.sidebarViewGeneration;
        await this.postCommitStatusUpdate({ includeIconTheme: true, refreshSubtrees: msg.refreshSubtrees });
        if (isSidebarRequest && sidebarGeneration === this.sidebarViewGeneration && this.view) {
          this.sidebarReady = true;
          this.flushPendingSidebarMessages();
        }
        break;
      }

      case 'COMMIT_REQUEST_MESSAGE_HISTORY': {
        const limit = Math.min(100, Math.max(1, Math.floor(msg.limit ?? 50)));
        const repoIds = this.manager.normalizeRepoIds(msg.repoIds);
        const batches = await Promise.all(repoIds.map(async repoId => {
          const repo = this.manager.getRepo(repoId);
          if (!repo) return [];
          return repo.getRecentCommitMessages(limit).catch(() => []);
        }));
        const seen = new Set<string>();
        const messages = batches
          .flat()
          .sort((left, right) => right.timestamp - left.timestamp)
          .flatMap(entry => {
            const message = entry.message.replace(/\r\n/g, '\n').trim();
            if (!message || seen.has(message)) return [];
            seen.add(message);
            return [message];
          })
          .slice(0, limit);
        this.post({ type: 'COMMIT_MESSAGE_HISTORY_RESULT', requestId: msg.requestId, messages });
        break;
      }

      case 'COMMIT_GET_LAST_COMMIT_MESSAGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, repoId: msg.repoId, message: '', error: t('Repo not found') });
          return;
        }
        try {
          const message = await repo.getLastCommitMessage();
          this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, repoId: msg.repoId, message });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, repoId: msg.repoId, message: '', error: String(e) });
        }
        break;
      }

      case 'COMMIT_ACTIVE_TAB_CHANGED': {
        this.activeTab = msg.tab;
        if (msg.viewMode) {
          this.currentTabFileViewMode = msg.viewMode;
        }
        if (msg.expandMode) {
          this.currentTabIsCollapsed = msg.expandMode === 'collapse';
        }
        this.updateViewAndExpandContext(this.currentTabFileViewMode, this.currentTabIsCollapsed);
        break;
      }

      case 'COMMIT_EXPAND_MODE_CHANGED': {
        this.currentTabIsCollapsed = msg.expandMode === 'collapse';
        this.updateViewAndExpandContext(this.currentTabFileViewMode, this.currentTabIsCollapsed);
        break;
      }

      case 'COMMIT_SELECTION_STATE_CHANGED': {
        void vscode.commands.executeCommand('setContext', 'versiondock.isAllSelected', msg.isAllSelected);
        void vscode.commands.executeCommand('setContext', 'versiondock.canSelectAll', msg.hasSelectable);
        break;
      }

      case 'COMMIT_REQUEST_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff: null, error: t('Repo not found') });
          return;
        }
        try {
          const relativePath = repo.resolveRepoPath(msg.filePath).relativePath;
          const diff = msg.staged
            ? await repo.getStagedDiff(msg.repoId, relativePath)
            : await repo.getUnstagedDiff(msg.repoId, relativePath);
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_DIFF_RESULT', requestId: msg.requestId, diff: null, error: String(e) });
        }
        break;
      }

      case 'COMMIT_REQUEST_WORKTREE_DIFF_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({
            type: 'COMMIT_WORKTREE_DIFF_FILES_RESULT',
            requestId: msg.requestId,
            repoId: msg.repoId,
            baseRef: msg.baseRef,
            currentRef: 'HEAD',
            files: [],
            error: t('Repo not found'),
          });
          return;
        }
        try {
          const [files, current] = await Promise.all([
            repo.getWorktreeDiffFiles(msg.baseRef),
            repo.getCurrentBranch(),
          ]);
          this.post({
            type: 'COMMIT_WORKTREE_DIFF_FILES_RESULT',
            requestId: msg.requestId,
            repoId: msg.repoId,
            baseRef: msg.baseRef,
            currentRef: current.detachedTag ?? current.detachedHash ?? current.name,
            files,
          });
        } catch (e: unknown) {
          this.post({
            type: 'COMMIT_WORKTREE_DIFF_FILES_RESULT',
            requestId: msg.requestId,
            repoId: msg.repoId,
            baseRef: msg.baseRef,
            currentRef: 'HEAD',
            files: [],
            error: String(e),
          });
        }
        break;
      }

      case 'COMMIT_REQUEST_WORKTREE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'COMMIT_WORKTREE_DIFF_RESULT', requestId: msg.requestId, diff: null, error: t('Repo not found') });
          return;
        }
        try {
          const relativePath = repo.resolveRepoPath(msg.filePath).relativePath;
          const diff = await repo.getWorktreeFileDiff(msg.repoId, msg.baseRef, relativePath);
          this.post({ type: 'COMMIT_WORKTREE_DIFF_RESULT', requestId: msg.requestId, diff });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_WORKTREE_DIFF_RESULT', requestId: msg.requestId, diff: null, error: String(e) });
        }
        break;
      }

      case 'COMMIT_OPEN_WORKTREE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          await this.openWorktreeDiffEditor(repo, msg.baseRef, msg.filePath);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open diff: {1}', repo.meta.name, String(e)));
        }
        break;
      }

      case 'COMMIT_STAGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        try {
          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            await repo.stageFiles(msg.paths);
          }, 'stage', t('Staging changes…'));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_UNSTAGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        try {
          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            await repo.unstageFiles(msg.paths);
          }, 'stage', t('Unstaging changes…'));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_STAGE_ALL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        try {
          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            await repo.stageAll();
          }, 'stage', t('Staging all changes…'));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_UNSTAGE_ALL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        try {
          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            await repo.unstageAll();
          }, 'stage', t('Unstaging all changes…'));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_STAGE_ALL_MULTI': {
        const repoIds = msg.repoIds;
        const total = repoIds.length;
        const stepIncrement = total > 0 ? 100 / total : undefined;
        const runStageAllMulti = async (
          progress?: vscode.Progress<{ message?: string; increment?: number }>,
        ) => {
          const errors: string[] = [];
          for (let i = 0; i < total; i++) {
            const repoId = repoIds[i];
            const repo = this.manager.getRepo(repoId);
            const repoName = (this.manager.getRepoMeta(repoId)?.name ?? path.basename(repo?.rootPath ?? '')) || repoId;
            progress?.report({
              message: total > 1 ? `(${i + 1}/${total}) ${repoName}` : repoName,
              increment: stepIncrement,
            });
            if (!repo) {
              errors.push(`${repoName}: ${t('Repo not found')}`);
              continue;
            }
            try {
              await repo.stageAll();
            } catch (e: unknown) {
              errors.push(`${repoName}: ${String(e)}`);
            }
          }
          if (errors.length > 0) {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
          } else {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          }
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        };

        await this.manager.runWithStatusUpdatesSuppressed(async () => {
          if (total <= 1) {
            await runStageAllMulti();
          } else {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: t('VersionDock: Staging {0} repositories…', total),
                cancellable: false,
              },
              progress => runStageAllMulti(progress),
            );
          }
        }, 'stage', t('Staging all changes…'));
        break;
      }

      case 'COMMIT_UNSTAGE_ALL_MULTI': {
        const repoIds = msg.repoIds;
        const total = repoIds.length;
        const stepIncrement = total > 0 ? 100 / total : undefined;
        const runUnstageAllMulti = async (
          progress?: vscode.Progress<{ message?: string; increment?: number }>,
        ) => {
          const errors: string[] = [];
          for (let i = 0; i < total; i++) {
            const repoId = repoIds[i];
            const repo = this.manager.getRepo(repoId);
            const repoName = (this.manager.getRepoMeta(repoId)?.name ?? path.basename(repo?.rootPath ?? '')) || repoId;
            progress?.report({
              message: total > 1 ? `(${i + 1}/${total}) ${repoName}` : repoName,
              increment: stepIncrement,
            });
            if (!repo) {
              errors.push(`${repoName}: ${t('Repo not found')}`);
              continue;
            }
            try {
              await repo.unstageAll();
            } catch (e: unknown) {
              errors.push(`${repoName}: ${String(e)}`);
            }
          }
          if (errors.length > 0) {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
          } else {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          }
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        };

        await this.manager.runWithStatusUpdatesSuppressed(async () => {
          if (total <= 1) {
            await runUnstageAllMulti();
          } else {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: t('VersionDock: Unstaging {0} repositories…', total),
                cancellable: false,
              },
              progress => runUnstageAllMulti(progress),
            );
          }
        }, 'stage', t('Unstaging all changes…'));
        break;
      }

      case 'COMMIT_DO_COMMIT': {
        const startedAt = Date.now();
        this.logger?.info('Commit', 'Commit started', {
          repoId: msg.repoId,
          requestId: msg.requestId,
          amend: msg.amend,
        });
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        const isSafe = await this.validateCommitSafety(repo);
        if (!isSafe) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled by user safety check', repoId: msg.repoId });
          return;
        }
        try {
          const creds = repo.kind === 'svn' ? undefined : await this.getCommitCredentials(repo.repoId);
          const output = await this.manager.runWithStatusUpdatesSuppressed(async () => {
            return await repo.commit(msg.message, msg.amend, creds, detail => {
              this.logger?.debug('Commit', detail, { repoId: msg.repoId, requestId: msg.requestId });
            }, msg.noVerify);
          }, 'commit', t('VersionDock [{0}]: Committing changes…', repo.meta.name));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, output, repoId: msg.repoId });
          this.post({ type: 'COMMIT_AMEND_RESET', repoIds: [msg.repoId] });
          this.logger?.info('Commit', 'Commit completed', {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
          this.logProvider?.refresh({ repoIds: [msg.repoId] });
          const status = await this.refreshStatusAfterOp();
          this.invalidateSubtreeStatus(undefined, { remote: false });
          void this.broadcastUnpushedCommits();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          if (this.isSubtreeTabActive()) {
            void this.refreshSubtreeList({ force: false });
          }
          void this.notifyDetachedHeadCommitIfApplicable(repo);
        } catch (e: unknown) {
          this.logger?.error('Commit', 'Commit failed', e, {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_DO_COMMIT_PUSH': {
        const startedAt = Date.now();
        this.logger?.info('Commit', 'Commit and push started', {
          repoId: msg.repoId,
          requestId: msg.requestId,
          amend: msg.amend,
        });
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        const isSafe = await this.validateCommitSafety(repo);
        if (!isSafe) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled by user safety check', repoId: msg.repoId });
          return;
        }
        try {
          const creds = repo.kind === 'svn' ? undefined : await this.getCommitCredentials(repo.repoId);
          await repo.commit(msg.message, msg.amend, creds, detail => {
            this.logger?.debug('Commit', detail, { repoId: msg.repoId, requestId: msg.requestId });
          }, msg.noVerify);
          this.post({ type: 'COMMIT_AMEND_RESET', repoIds: [msg.repoId] });
          if (repo.kind !== 'svn') {
            const pushResult = await runPushWithProtection(repo, {
              repoName: this.manager.getRepoMeta(msg.repoId)?.name ?? path.basename(repo.rootPath),
              logger: this.logger,
              beforePush: () => this.checkUnpushedSubmodules(msg.repoId),
            });
            if (!pushResult.success) {
              if (pushResult.cancelled) {
                this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId });
                return;
              }
              throw pushResult.error;
            }
            if (!pushResult.rebased && !pushResult.forced) {
              void this.notifyPushSuccess(repo);
            }
          }
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          this.logger?.info('Commit', 'Commit and push completed', {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
          this.logProvider?.refresh({ repoIds: [msg.repoId] });
          const status = await this.refreshStatusAfterOp();
          this.invalidateSubtreeStatus(undefined, { remote: false });
          void this.broadcastUnpushedCommits();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          if (this.isSubtreeTabActive()) {
            void this.refreshSubtreeList({ force: false });
          }
        } catch (e: unknown) {
          const cancelled = isRemoteRepositoryCancelled(e);
          if (cancelled) {
            this.logger?.info('Commit', 'Commit and push cancelled', {
              repoId: msg.repoId,
              requestId: msg.requestId,
              vcs: repo.kind,
              durationMs: Date.now() - startedAt,
            });
          } else {
            this.logger?.error('Commit', 'Commit and push failed', e, {
              repoId: msg.repoId,
              requestId: msg.requestId,
              vcs: repo.kind,
              durationMs: Date.now() - startedAt,
            });
          }
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: cancelled ? 'Cancelled' : String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_DO_COMMIT_MULTI': {
        const startedAt = Date.now();
        this.logger?.info('Commit', 'Multi-repository commit started', {
          repositoryCount: msg.repos.length,
          requestId: msg.requestId,
          andPush: msg.andPush,
        });
        // Multi-repository commit-and-push remains explicit: creating a
        // remote for several repositories would require a separate provider
        // choice for each repository and could leave a partial batch.
        if (msg.andPush) {
          const noRemoteRepos: string[] = [];
          for (const r of msg.repos) {
            const repo = this.manager.getRepo(r.repoId);
            if (!repo || repo.kind === 'svn') continue;
            const remotes = await repo.getRemotes().catch(() => [] as string[]);
            const repoName = (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo.rootPath)) || r.repoId;
            if (remotes.length === 0) noRemoteRepos.push(repoName);
          }
          if (noRemoteRepos.length > 0) {
            this.logger?.warn('Commit', 'Multi-repository commit and push stopped because remotes are missing', {
              repositoryCount: msg.repos.length,
              missingRemoteCount: noRemoteRepos.length,
              requestId: msg.requestId,
            });
            vscode.window.showInformationMessage(
              noRemoteRepos.length === 1
                ? t('VersionDock [{0}]: Cannot push — no remote configured. Add a remote first (git remote add <name> <url>).', noRemoteRepos[0])
                : t('VersionDock: Cannot push — no remote configured for: {0}. Add a remote first (git remote add <name> <url>).', noRemoteRepos.join(', ')),
            );
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'No remote configured' });
            return;
          }
        }
        const runMultiCommit = async (
          progress?: vscode.Progress<{ message?: string; increment?: number }>,
        ): Promise<void> => {
            // Commit submodules before parent repos so the parent's pointer update
            // always refers to an already-committed submodule state.
            const repoMetas = this.manager.getRepoMetas();
            const ordered = [...msg.repos].sort((a, b) => {
              const aMeta = repoMetas.find(m => m.id === a.repoId);
              const bMeta = repoMetas.find(m => m.id === b.repoId);
              const aDepth = aMeta?.depth ?? 0;
              const bDepth = bMeta?.depth ?? 0;
              return bDepth - aDepth; // deeper (submodules) first
            });

            const total = ordered.length;
            const stepIncrement = total > 0 ? 100 / total : undefined;
            const committedRepoIds = new Set<string>();
            const commitErrors: string[] = [];
            const pushedRepoIds = new Set<string>();
            const pushCancelledRepoIds = new Set<string>();
            const pushErrors: string[] = [];
            const failedSubmoduleIds = new Set<string>();
            const failedPushSubmoduleIds = new Set<string>();

            for (let i = 0; i < ordered.length; i++) {
              const r = ordered[i];
              const repo = this.manager.getRepo(r.repoId);
              const repoMeta = repoMetas.find(m => m.id === r.repoId);
              const repoName = (repoMeta?.name ?? path.basename(repo?.rootPath ?? '')) || r.repoId;

              progress?.report({
                message: total > 1 ? `(${i + 1}/${total}) ${repoName}` : repoName,
                increment: stepIncrement,
              });

              if (!repo) {
                commitErrors.push(`${repoName}: not found`);
                continue;
              }

              // Submodule dependency safety: if a child submodule failed to commit or push earlier,
              // skip committing the parent repo to prevent committing an invalid submodule pointer.
              if (failedSubmoduleIds.size > 0) {
                const failedDescendant = findFailedSubmoduleDescendant(r.repoId, failedSubmoduleIds, repoMetas);
                if (failedDescendant) {
                  failedSubmoduleIds.add(r.repoId);
                  const childName = failedDescendant.name || failedDescendant.id;
                  const reason = failedPushSubmoduleIds.has(failedDescendant.id)
                    ? t('Skipped because child submodule "{0}" failed to push.', childName)
                    : t('Skipped because child submodule "{0}" failed to commit.', childName);
                  commitErrors.push(`${repoName}: ${reason}`);
                  continue;
                }
              }

              try {
                if (repo.kind === 'svn') {
                  const selectedPaths = Array.from(new Set(r.filesToStage.filter(p => p.length > 0)));
                  const svnRepo = repo as typeof repo & { commitPaths?: (message: string, paths: string[]) => Promise<string> };
                  if (svnRepo.commitPaths) {
                    await svnRepo.commitPaths(r.message, selectedPaths);
                  } else {
                    await repo.commit(r.message, false);
                  }
                  committedRepoIds.add(r.repoId);
                  continue;
                }
                // Stage/unstage according to user selection before committing
                await repo.runWithGitWriteLock(async () => {
                  if (r.filesToUnstage.length > 0) await repo.unstageFiles(r.filesToUnstage);
                  if (r.filesToStage.length > 0) await repo.stageFiles(r.filesToStage);
                  const creds = await this.getCommitCredentials(repo.repoId);
                  await repo.commit(r.message, r.amend, creds, detail => {
                    this.logger?.debug('Commit', detail, { repoId: r.repoId, requestId: msg.requestId });
                  }, msg.noVerify);
                });
                committedRepoIds.add(r.repoId);
              } catch (e: unknown) {
                if (repoMeta?.isSubmodule || (repoMeta?.depth ?? 0) > 0) {
                  failedSubmoduleIds.add(r.repoId);
                }
                const repoName = (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo.rootPath)) || r.repoId;
                if (isRemoteRepositoryCancelled(e)) {
                  this.logger?.info('Commit', 'Repository commit cancelled', {
                    repoId: r.repoId,
                    requestId: msg.requestId,
                    vcs: repo.kind,
                  });
                } else {
                  this.logger?.error('Commit', 'Repository commit failed', e, {
                    repoId: r.repoId,
                    requestId: msg.requestId,
                    vcs: repo.kind,
                  });
                  commitErrors.push(`${repoName}: ${String(e)}`);
                }
                continue;
              }

              if (msg.andPush) {
                const isSubmodule = Boolean(repoMeta?.isSubmodule || (repoMeta?.depth ?? 0) > 0);
                try {
                  const pushResult = await runPushWithProtection(repo, {
                    repoName: (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo.rootPath)) || r.repoId,
                    logger: this.logger,
                    silentOnSuccess: msg.repos.length > 1,
                    suppressProgress: msg.repos.length > 1,
                    beforePush: () => this.checkUnpushedSubmodules(r.repoId),
                  });
                  if (pushResult.success) {
                    pushedRepoIds.add(r.repoId);
                  } else if (pushResult.cancelled) {
                    pushCancelledRepoIds.add(r.repoId);
                    if (isSubmodule) {
                      failedSubmoduleIds.add(r.repoId);
                      failedPushSubmoduleIds.add(r.repoId);
                    }
                  } else {
                    if (isSubmodule) {
                      failedSubmoduleIds.add(r.repoId);
                      failedPushSubmoduleIds.add(r.repoId);
                    }
                    pushErrors.push(`${repoName}: ${pushResult.error ? String(pushResult.error) : t('Push failed')}`);
                  }
                } catch (pushErr: unknown) {
                  if (isSubmodule) {
                    failedSubmoduleIds.add(r.repoId);
                    failedPushSubmoduleIds.add(r.repoId);
                  }
                  if (isRemoteRepositoryCancelled(pushErr)) {
                    pushCancelledRepoIds.add(r.repoId);
                  } else {
                    pushErrors.push(`${repoName}: ${String(pushErr)}`);
                  }
                }
              }
            }

            if (!msg.andPush) {
              if (commitErrors.length > 0) {
                this.logger?.warn('Commit', 'Multi-repository commit completed with failures', {
                  repositoryCount: msg.repos.length,
                  failedCount: commitErrors.length,
                  succeededCount: committedRepoIds.size,
                  requestId: msg.requestId,
                  durationMs: Date.now() - startedAt,
                });
                let errorMessage = commitErrors.join('\n');
                if (committedRepoIds.size > 0) {
                  errorMessage = `${t('VersionDock: {0} repositories committed successfully, {1} failed:', committedRepoIds.size, commitErrors.length)}\n\n${errorMessage}`;
                }
                this.post({
                  type: 'COMMIT_OP_RESULT',
                  requestId: msg.requestId,
                  ok: false,
                  error: errorMessage,
                  committedRepoIds: Array.from(committedRepoIds),
                });
              } else {
                this.logger?.info('Commit', 'Multi-repository commit completed', {
                  repositoryCount: msg.repos.length,
                  requestId: msg.requestId,
                  durationMs: Date.now() - startedAt,
                });
                this.post({
                  type: 'COMMIT_OP_RESULT',
                  requestId: msg.requestId,
                  ok: true,
                  committedRepoIds: Array.from(committedRepoIds),
                });
                this.logProvider?.refresh({ repoIds: msg.repos.map(r => r.repoId) });
              }
            } else {
              const allPushTargetCount = ordered.filter(r => this.manager.getRepo(r.repoId)?.kind !== 'svn').length;
              const isAllPushed = committedRepoIds.size === total && pushedRepoIds.size === allPushTargetCount;

              if (isAllPushed) {
                this.logger?.info('Commit', 'Multi-repository commit and push completed successfully', {
                  repositoryCount: msg.repos.length,
                  requestId: msg.requestId,
                  durationMs: Date.now() - startedAt,
                });
                this.post({
                  type: 'COMMIT_OP_RESULT',
                  requestId: msg.requestId,
                  ok: true,
                  committedRepoIds: Array.from(committedRepoIds),
                });
                const singleRepoName = msg.repos.length === 1 ? this.manager.getRepoMeta(msg.repos[0].repoId)?.name : undefined;
                if (singleRepoName) {
                  vscode.window.showInformationMessage(t('VersionDock [{0}]: Commits committed and pushed successfully.', singleRepoName));
                } else {
                  vscode.window.showInformationMessage(t('VersionDock: Commits committed and pushed successfully across {0} repositories.', msg.repos.length));
                }
                this.logProvider?.refresh({ repoIds: msg.repos.map(r => r.repoId) });
              } else {
                const totalFailures = commitErrors.length + pushErrors.length;
                const totalCancelled = pushCancelledRepoIds.size;
                this.logger?.warn('Commit', 'Multi-repository commit and push completed with partial results', {
                  repositoryCount: msg.repos.length,
                  committedCount: committedRepoIds.size,
                  pushedCount: pushedRepoIds.size,
                  cancelledCount: totalCancelled,
                  failedCount: totalFailures,
                  requestId: msg.requestId,
                  durationMs: Date.now() - startedAt,
                });

                if (committedRepoIds.size === 0 && totalFailures === 0 && totalCancelled > 0) {
                  this.post({
                    type: 'COMMIT_OP_RESULT',
                    requestId: msg.requestId,
                    ok: false,
                    error: 'Cancelled',
                    committedRepoIds: Array.from(committedRepoIds),
                  });
                } else {
                  const details = [...commitErrors, ...pushErrors];
                  let summaryHeader: string;
                  const committedCount = committedRepoIds.size;
                  const pushedCount = pushedRepoIds.size;
                  const cancelledCount = totalCancelled;
                  const failedCount = totalFailures;

                  if (cancelledCount > 0 && failedCount > 0) {
                    summaryHeader = t(
                      'VersionDock: {0} committed, {1} pushed, {2} cancelled, {3} failed:',
                      committedCount,
                      pushedCount,
                      cancelledCount,
                      failedCount
                    );
                  } else if (cancelledCount > 0) {
                    summaryHeader = t(
                      'VersionDock: {0} committed, {1} pushed, {2} cancelled.',
                      committedCount,
                      pushedCount,
                      cancelledCount
                    );
                  } else if (failedCount > 0) {
                    summaryHeader = t(
                      'VersionDock: {0} committed, {1} pushed, {2} failed:',
                      committedCount,
                      pushedCount,
                      failedCount
                    );
                  } else {
                    summaryHeader = t(
                      'VersionDock: {0} committed, {1} pushed.',
                      committedCount,
                      pushedCount
                    );
                  }
                  const finalError = details.length > 0 ? `${summaryHeader}\n\n${details.join('\n')}` : summaryHeader;
                  this.post({
                    type: 'COMMIT_OP_RESULT',
                    requestId: msg.requestId,
                    ok: false,
                    error: finalError,
                    committedRepoIds: Array.from(committedRepoIds),
                  });
                }
                this.logProvider?.refresh({ repoIds: Array.from(committedRepoIds) });
              }
            }
            if (committedRepoIds.size > 0) {
              this.post({ type: 'COMMIT_AMEND_RESET', repoIds: Array.from(committedRepoIds) });
            }
            const status = await this.refreshStatusAfterOp();
            this.invalidateSubtreeStatus(undefined, { remote: false });
            void this.broadcastUnpushedCommits();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
            if (this.isSubtreeTabActive()) {
              void this.refreshSubtreeList({ force: false });
            }
        };
        const label = msg.andPush
          ? t('Committing and pushing changes…')
          : t('Committing changes…');
        await this.manager.runWithStatusUpdatesSuppressed(async () => {
          if (msg.repos.length === 1) {
            // Single repository commits complete quickly; avoid showing a transient progress notification.
            await runMultiCommit();
          } else {
            const title = msg.andPush
              ? t('VersionDock: Committing and pushing {0} repositories…', msg.repos.length)
              : t('VersionDock: Committing {0} repositories', msg.repos.length);
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title,
                cancellable: false,
              },
              progress => runMultiCommit(progress),
            );
          }
        }, 'commit', label);
        break;
      }

      case 'COMMIT_DO_STASH_MULTI': {
        const startedAt = Date.now();
        this.logger?.info('Stash', 'Multi-repository stash started', {
          repositoryCount: msg.repos.length,
          requestId: msg.requestId,
        });
        const runStash = async (
          progress?: vscode.Progress<{ message?: string; increment?: number }>,
        ) => {
          const errors: string[] = [];
          const affectedRepoIds: string[] = [];
          const total = msg.repos.length;
          const stepIncrement = total > 0 ? 100 / total : undefined;
          for (let i = 0; i < total; i++) {
            const r = msg.repos[i];
            const repo = this.manager.getRepo(r.repoId);
            const repoName = (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo?.rootPath ?? '')) || r.repoId;
            progress?.report({
              message: total > 1 ? `(${i + 1}/${total}) ${repoName}` : repoName,
              increment: stepIncrement,
            });
            if (!repo) { errors.push(`${r.repoId}: not found`); continue; }
            if (repo.kind === 'svn') continue;
            try {
              const safePaths = r.paths?.map(filePath => repo.resolveRepoPath(filePath).relativePath);
              await repo.stashPush(msg.message, safePaths);
              affectedRepoIds.push(r.repoId);
            } catch (e: unknown) {
              this.logger?.error('Stash', 'Repository stash failed', e, {
                repoId: r.repoId,
                requestId: msg.requestId,
                vcs: repo.kind,
              });
              errors.push(`${repoName}: ${String(e)}`);
            }
          }
          if (errors.length > 0) {
            this.logger?.warn('Stash', 'Multi-repository stash completed with failures', {
              repositoryCount: msg.repos.length,
              failedCount: errors.length,
              requestId: msg.requestId,
              durationMs: Date.now() - startedAt,
            });
            let errorMessage = errors.join('\n');
            if (affectedRepoIds.length > 0) {
              errorMessage = `${t('VersionDock: Stashed in {0} repositories, {1} failed:', affectedRepoIds.length, errors.length)}\n\n${errorMessage}`;
            }
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errorMessage });
          } else {
            this.logger?.info('Stash', 'Multi-repository stash completed', {
              repositoryCount: msg.repos.length,
              requestId: msg.requestId,
              durationMs: Date.now() - startedAt,
            });
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          }
          const status = await this.refreshStatusAfterOp();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.postChangelistsUpdate(status);
          for (const repoId of affectedRepoIds) {
            this.post({ type: 'STASH_OP_RESULT', requestId: `${msg.requestId}-${repoId}`, repoId, op: 'push', ok: true });
          }
        };

        await this.manager.runWithStatusUpdatesSuppressed(async () => {
          if (msg.repos.length === 1) {
            await runStash();
          } else {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: t('VersionDock: Stashing {0} repositories…', msg.repos.length),
                cancellable: false,
              },
              progress => runStash(progress),
            );
          }
        }, 'stash', t('Stashing changes…'));
        break;
      }

      case 'COMMIT_DO_SHELVE_MULTI': {
        const startedAt = Date.now();
        this.logger?.info('Shelve', 'Multi-repository shelve started', {
          repositoryCount: msg.repos.length,
          requestId: msg.requestId,
        });
        const runShelve = async (
          progress?: vscode.Progress<{ message?: string; increment?: number }>,
        ) => {
          const errors: string[] = [];
          const affectedRepoIds: string[] = [];
          const clSvc = this.getOrCreateChangelistService();
          const total = msg.repos.length;
          const stepIncrement = total > 0 ? 100 / total : undefined;
          for (let i = 0; i < total; i++) {
            const r = msg.repos[i];
            const shelveSvc = this.getShelveService(r.repoId);
            const repo = this.manager.getRepo(r.repoId);
            const repoName = (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo?.rootPath ?? '')) || r.repoId;
            progress?.report({
              message: total > 1 ? `(${i + 1}/${total}) ${repoName}` : repoName,
              increment: stepIncrement,
            });
            if (!shelveSvc || !repo) { errors.push(`${r.repoId}: not found`); continue; }
            if (repo.kind === 'svn') continue;
            try {
              const safePaths = r.paths?.map(filePath => repo.resolveRepoPath(filePath).relativePath);
              const clAssignments = clSvc ? this.buildChangelistAssignments(clSvc, r.repoId, safePaths) : undefined;
              await shelveSvc.push(msg.name, safePaths, clAssignments);
              affectedRepoIds.push(r.repoId);
            } catch (e: unknown) {
              const repoName = (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo?.rootPath ?? '')) || r.repoId;
              this.logger?.error('Shelve', 'Repository shelve failed', e, {
                repoId: r.repoId,
                requestId: msg.requestId,
                vcs: repo.kind,
              });
              errors.push(`${repoName}: ${String(e)}`);
            }
          }
          if (errors.length > 0) {
            this.logger?.warn('Shelve', 'Multi-repository shelve completed with failures', {
              repositoryCount: msg.repos.length,
              failedCount: errors.length,
              requestId: msg.requestId,
              durationMs: Date.now() - startedAt,
            });
            let errorMessage = errors.join('\n');
            if (affectedRepoIds.length > 0) {
              errorMessage = `${t('VersionDock: Shelved in {0} repositories, {1} failed:', affectedRepoIds.length, errors.length)}\n\n${errorMessage}`;
            }
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errorMessage });
          } else {
            this.logger?.info('Shelve', 'Multi-repository shelve completed', {
              repositoryCount: msg.repos.length,
              requestId: msg.requestId,
              durationMs: Date.now() - startedAt,
            });
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          }
          const status = await this.refreshStatusAfterOp();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.postChangelistsUpdate(status);
          for (const repoId of affectedRepoIds) {
            this.post({ type: 'SHELVE_OP_RESULT', requestId: `${msg.requestId}-${repoId}`, repoId, op: 'push', ok: true });
          }
        };

        await this.manager.runWithStatusUpdatesSuppressed(async () => {
          if (msg.repos.length === 1) {
            await runShelve();
          } else {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: t('VersionDock: Shelving {0} repositories…', msg.repos.length),
                cancellable: false,
              },
              progress => runShelve(progress),
            );
          }
        }, 'stash', t('Shelving changes…'));
        break;
      }

      case 'COMMIT_PULL_ALL': {
        let trackedResults: Awaited<ReturnType<UpdateSummaryService['runAll']>> | undefined;
        const metas = this.manager.getRepoMetas();
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: metas.length === 1
              ? t('VersionDock [{0}]: Updating repository…', metas[0].name)
              : t('VersionDock: Updating all repositories'),
            cancellable: false,
          },
          async progress => {
            if (this.updateSummaryService) {
              const count = metas.length;
              trackedResults = await this.updateSummaryService.runAll(
                metas.map(meta => ({ repoId: meta.id, execute: repo => repo.pull() })),
                (completed, total, target) => {
                  const name = this.manager.getRepoMeta(target.repoId)?.name ?? target.repoId;
                  progress.report({
                    message: `(${completed + 1}/${total}) ${name}`,
                    increment: count > 0 ? 100 / count : undefined,
                  });
                },
              );
            } else {
              const count = metas.length;
              const results = await this.manager.pullAll(
                false,
                (completed, total, repo) => {
                  const name = this.manager.getRepoMeta(repo.repoId)?.name ?? repo.repoId;
                  progress.report({
                    message: `(${completed + 1}/${total}) ${name}`,
                    increment: count > 0 ? 100 / count : undefined,
                  });
                },
              );
              const failed = results.filter(r => !r.ok);
              if (failed.length === 0) return;
              const successCount = results.length - failed.length;
              const failedDescription = failed.map(result => {
                const name = this.manager.getRepoMeta(result.repoId)?.name ?? result.repoId;
                return `${name}: ${result.message}`;
              }).join('; ');
              if (failed.length === 1 && results.length === 1) {
                vscode.window.showWarningMessage(t('VersionDock [{0}]: Update failed: {1}', this.manager.getRepoMeta(failed[0].repoId)?.name ?? failed[0].repoId, failed[0].message));
              } else if (successCount > 0) {
                vscode.window.showWarningMessage(t('VersionDock: {0} update(s) succeeded, {1} failed: {2}', successCount, failed.length, failedDescription));
              } else {
                vscode.window.showWarningMessage(t('VersionDock: {0} update(s) failed: {1}', failed.length, failedDescription));
              }
            }
          }
        );
        this.manager.notifyBranchesChanged();
        const pullStatus = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: pullStatus });
        if (trackedResults) await this.updateSummaryService?.notify(trackedResults);
        break;
      }

      case 'COMMIT_PULL_REPO': {
        const startedAt = Date.now();
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        this.logger?.info('VCS', 'Pull started', { repoId: msg.repoId, requestId: msg.requestId, vcs: repo.kind });
        try {
          const result = this.updateSummaryService
            ? await this.updateSummaryService.run({ repoId: msg.repoId, execute: target => target.pull() })
            : { repoId: msg.repoId, tracked: false, ok: true, output: await repo.pull(), commits: [], files: [] };
          if (!result.ok) throw new Error(result.error ?? t('Unknown error'));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, output: result.output, repoId: msg.repoId });
          this.logger?.info('VCS', 'Pull completed', {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
          this.manager.notifyBranchesChanged();
          const pullStatus = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: pullStatus });
          await this.updateSummaryService?.notify([result]);
        } catch (e: unknown) {
          this.logger?.error('VCS', 'Pull failed', e, {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_GET_REMOTES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: t('Repo not found') }); return; }
        try {
          const remotes = await repo.getRemotes();
          this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: String(e) });
        }
        break;
      }

      case 'COMMIT_PUSH_REPO': {
        const startedAt = Date.now();
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }

        const repoMeta = this.manager.getRepoMeta(msg.repoId);
        const repoName = repoMeta?.name || path.basename(repo.rootPath) || msg.repoId;
        this.logger?.info('Git', 'Push started', {
          repoId: msg.repoId,
          requestId: msg.requestId,
          remote: msg.remote,
          force: msg.force,
        });

        if (msg.force) {
          const currentBranch = await repo.getCurrentBranch?.();
          const branchName = currentBranch?.name || 'HEAD';
          const forceBtn = t('Force Push');
          const choice = await vscode.window.showWarningMessage(
            t(
              'VersionDock [{0}]: Are you sure you want to Force Push to branch "{1}"? Remote commits not present locally will be overwritten.',
              repoName,
              branchName,
            ),
            { modal: true },
            forceBtn,
          );
          if (choice !== forceBtn) {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId });
            return;
          }
        }

        const pushResult = await this.manager.runWithStatusUpdatesSuppressed(async () => {
          return await runPushWithProtection(repo, {
            repoName,
            remote: msg.remote,
            force: msg.force,
            logger: this.logger,
            beforePush: () => this.checkUnpushedSubmodules(msg.repoId),
          });
        }, 'sync', t('Updating…'));

        if (pushResult.success) {
          this.logger?.info('Git', 'Push completed', {
            repoId: msg.repoId,
            requestId: msg.requestId,
            remote: msg.remote,
            rebased: pushResult.rebased,
            forced: pushResult.forced,
            durationMs: Date.now() - startedAt,
          });
          this.logProvider?.refresh({ repoIds: [msg.repoId] });
          this.invalidateSubtreeStatus(undefined, { remote: false });
          await this.broadcastUnpushedCommits([msg.repoId]);
          if (this.isSubtreeTabActive()) {
            void this.refreshSubtreeList({ force: false });
          }
          await this.refreshStatusAfterOp();
          if (!pushResult.rebased && !pushResult.forced) {
            void this.notifyPushSuccess(repo, undefined, msg.remote);
          }
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
        } else if (pushResult.cancelled) {
          this.logger?.info('Git', 'Push cancelled', {
            repoId: msg.repoId,
            requestId: msg.requestId,
            remote: msg.remote,
            durationMs: Date.now() - startedAt,
          });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId });
        } else {
          this.logger?.error('Git', 'Push failed', pushResult.error, {
            repoId: msg.repoId,
            requestId: msg.requestId,
            remote: msg.remote,
            durationMs: Date.now() - startedAt,
          });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(pushResult.error), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_PUSH_MULTI': {
        const startedAt = Date.now();
        this.logger?.info('Git', 'Multi-repository push started', {
          targetCount: msg.targets.length,
          requestId: msg.requestId,
          force: msg.force,
        });

        const repoMetas = this.manager.getRepoMetas();
        // Sort deeper (submodules) first to ensure child commits reach remote before parent updates
        const ordered = [...msg.targets].sort((a, b) => {
          const aMeta = repoMetas.find(m => m.id === a.repoId);
          const bMeta = repoMetas.find(m => m.id === b.repoId);
          const aDepth = aMeta?.depth ?? 0;
          const bDepth = bMeta?.depth ?? 0;
          return bDepth - aDepth;
        });

        if (msg.force) {
          const forceBtn = t('Force Push');
          const repoNames = ordered.map(t => repoMetas.find(m => m.id === t.repoId)?.name || t.repoId).join(', ');
          const choice = await vscode.window.showWarningMessage(
            ordered.length === 1
              ? t('VersionDock [{0}]: Are you sure you want to Force Push? Remote commits not present locally will be overwritten.', repoNames)
              : t(
                  'VersionDock: Are you sure you want to Force Push {0} repositories ({1})? Remote commits not present locally will be overwritten.',
                  ordered.length,
                  repoNames,
                ),
            { modal: true },
            forceBtn,
          );
          if (choice !== forceBtn) {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }

        const runPushQueue = async (
          progress?: vscode.Progress<{ message?: string; increment?: number }>,
        ): Promise<void> => {
          const total = ordered.length;
          const stepIncrement = total > 0 ? 100 / total : undefined;
          const succeededRepoIds: string[] = [];
          const cancelledRepoIds: string[] = [];
          const skippedRepoNames: string[] = [];
          const errors: string[] = [];
          const failedSubmoduleIds = new Set<string>();

          for (let i = 0; i < total; i++) {
            const target = ordered[i];
            const repo = this.manager.getRepo(target.repoId);
            const repoMeta = repoMetas.find(m => m.id === target.repoId);
            const repoName = (repoMeta?.name ?? path.basename(repo?.rootPath ?? '')) || target.repoId;

            progress?.report({
              message: total > 1 ? `(${i + 1}/${total}) ${repoName}` : repoName,
              increment: stepIncrement,
            });

            if (!repo) {
              errors.push(`${repoName}: not found`);
              continue;
            }

            // Submodule safety: skip parent repos if child submodule push failed
            if (failedSubmoduleIds.size > 0) {
              const failedDescendant = findFailedSubmoduleDescendant(target.repoId, failedSubmoduleIds, repoMetas);
              if (failedDescendant) {
                failedSubmoduleIds.add(target.repoId);
                const childName = failedDescendant.name || failedDescendant.id;
                errors.push(`${repoName}: ${t('Skipped because child submodule "{0}" failed to push.', childName)}`);
                continue;
              }
            }

            try {
              const pushResult = await runPushWithProtection(repo, {
                repoName,
                remote: target.remote,
                force: msg.force,
                silentOnSuccess: msg.targets.length > 1,
                suppressProgress: msg.targets.length > 1,
                logger: this.logger,
                beforePush: () => this.checkUnpushedSubmodules(target.repoId),
              });

              if (pushResult.success) {
                succeededRepoIds.push(target.repoId);
              } else if (pushResult.cancelled) {
                cancelledRepoIds.push(target.repoId);
                const remaining = ordered.slice(i + 1);
                for (const rem of remaining) {
                  const remName = (repoMetas.find(m => m.id === rem.repoId)?.name) || rem.repoId;
                  skippedRepoNames.push(remName);
                }
                break;
              } else {
                if (repoMeta?.isSubmodule || (repoMeta?.depth ?? 0) > 0) {
                  failedSubmoduleIds.add(target.repoId);
                }
                errors.push(`${repoName}: ${pushResult.error ? String(pushResult.error) : t('Push failed')}`);
              }
            } catch (err) {
              if (repoMeta?.isSubmodule || (repoMeta?.depth ?? 0) > 0) {
                failedSubmoduleIds.add(target.repoId);
              }
              errors.push(`${repoName}: ${String(err)}`);
            }
          }

          const hasFailures = errors.length > 0;
          const hasCancelled = cancelledRepoIds.length > 0;
          const hasSkipped = skippedRepoNames.length > 0;

          if (hasFailures || hasCancelled || hasSkipped) {
            const succeededCount = succeededRepoIds.length;
            const cancelledCount = cancelledRepoIds.length;
            const skippedCount = skippedRepoNames.length;
            const failedCount = errors.length;

            this.logger?.warn('Git', 'Multi-repository push completed with partial results', {
              targetCount: msg.targets.length,
              succeededCount,
              cancelledCount,
              skippedCount,
              failedCount,
              requestId: msg.requestId,
              durationMs: Date.now() - startedAt,
            });

            if (succeededCount === 0 && !hasFailures && hasCancelled) {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            } else {
              const details = [...errors];
              if (skippedRepoNames.length > 0) {
                details.push(t('Skipped: {0}', skippedRepoNames.join(', ')));
              }
              let summaryHeader: string;
              if (skippedCount > 0) {
                if (succeededCount > 0 && failedCount > 0) {
                  summaryHeader = t(
                    'VersionDock: {0} repositories pushed successfully, {1} cancelled, {2} skipped, {3} failed:',
                    succeededCount,
                    cancelledCount,
                    skippedCount,
                    failedCount
                  );
                } else if (succeededCount > 0) {
                  summaryHeader = t(
                    'VersionDock: {0} repositories pushed successfully, {1} cancelled, {2} skipped.',
                    succeededCount,
                    cancelledCount,
                    skippedCount
                  );
                } else {
                  summaryHeader = t(
                    'VersionDock: {0} repositories failed, {1} cancelled, {2} skipped:',
                    failedCount,
                    cancelledCount,
                    skippedCount
                  );
                }
              } else if (succeededCount > 0 && cancelledCount > 0 && failedCount > 0) {
                summaryHeader = t(
                  'VersionDock: {0} repositories pushed successfully, {1} cancelled, {2} failed:',
                  succeededCount,
                  cancelledCount,
                  failedCount
                );
              } else if (succeededCount > 0 && cancelledCount > 0) {
                summaryHeader = t(
                  'VersionDock: {0} repositories pushed successfully, {1} cancelled.',
                  succeededCount,
                  cancelledCount
                );
              } else if (succeededCount > 0 && failedCount > 0) {
                summaryHeader = t(
                  'VersionDock: {0} repositories pushed successfully, {1} failed:',
                  succeededCount,
                  failedCount
                );
              } else if (cancelledCount > 0 && failedCount > 0) {
                summaryHeader = t(
                  'VersionDock: {0} repositories failed, {1} cancelled:',
                  failedCount,
                  cancelledCount
                );
              } else {
                summaryHeader = errors.length > 0 ? errors.join('\n') : 'Cancelled';
              }
              const finalMessage = details.length > 0 && summaryHeader !== details.join('\n')
                ? `${summaryHeader}\n\n${details.join('\n')}`
                : summaryHeader;

              this.logProvider?.refresh({ repoIds: msg.targets.map(t => t.repoId) });
              this.invalidateSubtreeStatus(undefined, { remote: false });
              await this.broadcastUnpushedCommits(msg.targets.map(t => t.repoId));
              if (this.isSubtreeTabActive()) {
                void this.refreshSubtreeList({ force: false });
              }
              await this.refreshStatusAfterOp();

              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: finalMessage });
            }
          } else {
            this.logger?.info('Git', 'Multi-repository push completed successfully', {
              targetCount: msg.targets.length,
              requestId: msg.requestId,
              durationMs: Date.now() - startedAt,
            });

            this.logProvider?.refresh({ repoIds: msg.targets.map(t => t.repoId) });
            this.invalidateSubtreeStatus(undefined, { remote: false });
            await this.broadcastUnpushedCommits(msg.targets.map(t => t.repoId));
            if (this.isSubtreeTabActive()) {
              void this.refreshSubtreeList({ force: false });
            }
            await this.refreshStatusAfterOp();

            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
            if (succeededRepoIds.length === 1) {
              const singleRepo = this.manager.getRepo(succeededRepoIds[0]);
              if (singleRepo) {
                void this.notifyPushSuccess(singleRepo, undefined, ordered[0]?.remote);
              }
            } else if (succeededRepoIds.length > 1) {
              vscode.window.showInformationMessage(t('VersionDock: Commits pushed successfully across {0} repositories.', succeededRepoIds.length));
            }
          }
        };

        await this.manager.runWithStatusUpdatesSuppressed(async () => {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: ordered.length === 1
                ? t('VersionDock [{0}]: Pushing changes…', repoMetas.find(m => m.id === ordered[0].repoId)?.name || '')
                : t('VersionDock: Pushing {0} repositories…', ordered.length),
              cancellable: false,
            },
            progress => runPushQueue(progress),
          );
        }, 'sync', t('Updating…'));
        break;
      }

      case 'COMMIT_DISCARD_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Discard changes to {1}? This cannot be undone.', repo.meta.name, msg.path),
          { modal: true }, t('Discard')
        );
        if (confirm !== t('Discard')) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId }); return; }
        try {
          await repo.discardFile(msg.path);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          const status = await this.refreshStatusAfterOp();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_DISCARD_FILES': {
        const n = msg.files.length;
        const singleRepoId = msg.files.every(f => f.repoId === msg.files[0]?.repoId) ? msg.files[0]?.repoId : undefined;
        const singleRepoName = singleRepoId ? this.manager.getRepoMeta(singleRepoId)?.name : undefined;
        const confirm = await vscode.window.showWarningMessage(
          singleRepoName
            ? (n === 1
                ? t('VersionDock [{0}]: Discard changes to {1} file? This cannot be undone.', singleRepoName, n)
                : t('VersionDock [{0}]: Discard changes to {1} files? This cannot be undone.', singleRepoName, n))
            : (n === 1
                ? t('VersionDock: Discard changes to {0} file? This cannot be undone.', n)
                : t('VersionDock: Discard changes to {0} files? This cannot be undone.', n)),
          { modal: true }, t('Discard')
        );
        if (confirm !== t('Discard')) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: singleRepoId });
          break;
        }
        const errors: string[] = [];
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: singleRepoName
              ? (n === 1
                ? t('VersionDock [{0}]: Discarding changes to {1} file…', singleRepoName, n)
                : t('VersionDock [{0}]: Discarding changes to {1} files…', singleRepoName, n))
              : (n === 1
                ? t('VersionDock: Discarding changes to {0} file…', n)
                : t('VersionDock: Discarding changes to {0} files…', n)),
            cancellable: false,
          },
          async () => {
            for (const f of msg.files) {
              const repo = this.manager.getRepo(f.repoId);
              if (!repo) { errors.push(t('{0}: Repo not found', f.path)); continue; }
              try { await repo.discardFile(f.path); }
              catch (e: unknown) {
                const errStr = String(e);
                if (errStr.includes('did not match any file(s) known to git')) continue;
                errors.push(`${f.path}: ${errStr}`);
              }
            }
          }
        );
        if (errors.length > 0) {
          const discardedCount = msg.files.length - errors.length;
          let errorMessage = errors.join('\n');
          if (discardedCount > 0) {
            errorMessage = singleRepoName
              ? `${t('VersionDock [{0}]: Discarded {1} file(s), {2} failed:', singleRepoName, discardedCount, errors.length)}\n\n${errorMessage}`
              : `${t('VersionDock: Discarded {0} file(s), {1} failed:', discardedCount, errors.length)}\n\n${errorMessage}`;
          }
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errorMessage, repoId: singleRepoId });
        } else {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: singleRepoId });
        }
        const status = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        break;
      }

      case 'COMMIT_OPEN_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        if (repo.kind === 'svn') {
          try {
            await this.openSvnWorkingDiffEditor(repo, msg.filePath);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open SVN diff: {1}', repo.meta.name, String(e)));
          }
          break;
        }
        const resolvedPath = repo.resolveRepoPath(msg.filePath);
        const absUri = vscode.Uri.file(resolvedPath.absolutePath);
        if (fs.existsSync(absUri.fsPath) && fs.statSync(absUri.fsPath).isDirectory()) {
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Open the submodule repository section to inspect nested file changes.', repo.meta.name));
          return;
        }
        // git.openChange opens the native VS Code diff (index↔worktree or HEAD↔index)
        // depending on which group the file is in. Passing the file URI is enough.
        try {
          await vscode.commands.executeCommand('git.openChange', absUri);
        } catch {
          // Fallback: manual vscode.diff with git: URI scheme
          const ref = msg.staged ? '' : '~';
          const gitUri = absUri.with({
            scheme: 'git',
            query: JSON.stringify({ path: absUri.fsPath, ref }),
          });
          const title = msg.staged
            ? `${resolvedPath.relativePath} (Index ↔ HEAD)`
            : `${resolvedPath.relativePath} (Working Tree)`;
          await vscode.commands.executeCommand('vscode.diff', gitUri, absUri, title);
        }
        break;
      }

      case 'COMMIT_SHOW_DIFF_TAB': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        if (repo.kind === 'svn') {
          await this.openSvnWorkingDiffEditor(repo, msg.filePath);
          break;
        }
        const resolvedPath = repo.resolveRepoPath(msg.filePath);
        const absPath = vscode.Uri.file(resolvedPath.absolutePath);
        await vscode.commands.executeCommand('git.openChange', absPath).then(
          undefined,
          // fallback: open as diff with HEAD
          () => vscode.commands.executeCommand('vscode.diff',
            absPath.with({ scheme: 'git', query: JSON.stringify({ path: absPath.fsPath, ref: 'HEAD' }) }),
            absPath,
            `${resolvedPath.relativePath} (Working Tree)`
          )
        );
        break;
      }

      case 'COMMIT_OPEN_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const absPath = vscode.Uri.file(repo.resolveRepoPath(msg.filePath).absolutePath);
        try {
          const stat = await vscode.workspace.fs.stat(absPath);
          if ((stat.type & vscode.FileType.Directory) !== 0) {
            await vscode.commands.executeCommand('revealInExplorer', absPath);
            break;
          }
        } catch {
          // Fall through to the normal open path.
        }
        await vscode.window.showTextDocument(absPath, { preview: false });
        break;
      }

      case 'COMMIT_DELETE_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        let resolvedPath: ReturnType<typeof repo.resolveRepoPath>;
        try {
          resolvedPath = repo.resolveRepoPath(msg.filePath);
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Delete {1}? This cannot be undone.', repo.meta.name, resolvedPath.relativePath),
          { modal: true }, t('Delete')
        );
        if (confirm !== t('Delete')) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId }); return; }
        try {
          assertNoSymlinkAncestors(repo.rootPath, resolvedPath.absolutePath);
          await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { useTrash: true });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_DELETE_FOLDER': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        let resolvedPath: ReturnType<typeof repo.resolveRepoPath>;
        try {
          resolvedPath = repo.resolveRepoPath(msg.folderPath);
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Delete folder "{1}" and all its contents? This cannot be undone.', repo.meta.name, resolvedPath.relativePath),
          { modal: true }, t('Delete')
        );
        if (confirm !== t('Delete')) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId }); return; }
        try {
          assertNoSymlinkAncestors(repo.rootPath, resolvedPath.absolutePath, { includeTarget: true });
          await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { recursive: true, useTrash: true });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_ADD_TO_GITIGNORE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const ignoredPath = repo.resolveRepoPath(msg.entryPath);

        // Find all .gitignore files in the repo
        const rootUri = vscode.Uri.file(repo.rootPath);
        const gitignoreFiles = await vscode.workspace.findFiles(
          new vscode.RelativePattern(rootUri, '**/.gitignore'),
          new vscode.RelativePattern(rootUri, '**/node_modules/**'),
          20
        );

        // Sort: root .gitignore first, then alphabetical
        gitignoreFiles.sort((a, b) => {
          const aRel = path.relative(repo.rootPath, a.fsPath);
          const bRel = path.relative(repo.rootPath, b.fsPath);
          if (aRel === '.gitignore') return -1;
          if (bRel === '.gitignore') return 1;
          return aRel.localeCompare(bRel);
        });

        // If no .gitignore exists, create one at the root
        let targetPath: string;
        if (gitignoreFiles.length === 0) {
          targetPath = path.join(repo.rootPath, '.gitignore');
        } else if (gitignoreFiles.length === 1) {
          targetPath = gitignoreFiles[0].fsPath;
        } else {
          // Let user pick
          const picks = gitignoreFiles.map(f => ({
            label: path.relative(repo.rootPath, f.fsPath),
            fsPath: f.fsPath,
          }));
          const picked = await vscode.window.showQuickPick(picks, {
            title: t('Add to .gitignore'),
            placeHolder: t('Select which .gitignore to update'),
          });
          if (!picked) return;
          targetPath = picked.fsPath;
        }

        // Determine the entry to add (relative to the .gitignore's directory)
        const gitignoreDir = path.dirname(targetPath);
        let entry = path.relative(gitignoreDir, ignoredPath.absolutePath);
        // Normalise to forward slashes
        entry = entry.split(path.sep).join('/');

        // Append to .gitignore if not already present
        let existing = '';
        try { existing = fs.readFileSync(targetPath, 'utf8'); } catch { /* new file */ }
        const lines = existing.split('\n').map(l => l.trim());
        if (lines.includes(entry) || lines.includes('/' + entry)) {
          vscode.window.showInformationMessage(t('VersionDock [{0}]: "{1}" is already in {2}', repo.meta.name, entry, path.relative(repo.rootPath, targetPath)));
          return;
        }
        const newContent = existing.endsWith('\n') || existing === ''
          ? existing + entry + '\n'
          : existing + '\n' + entry + '\n';
        fs.writeFileSync(targetPath, newContent, 'utf8');
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Added "{1}" to {2}', repo.meta.name, entry, path.relative(repo.rootPath, targetPath)));

        // Refresh status so the newly-ignored file disappears
        const status = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        break;
      }

      case 'COMMIT_ADD_TO_SVN_IGNORE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind !== 'svn') return;
        const svn = repo as unknown as Partial<SvnIgnoreRepo>;
        if (typeof svn.addIgnoreEntry !== 'function') return;
        try {
          const result = await svn.addIgnoreEntry(msg.entryPath);
          if (result.alreadyExists) {
            vscode.window.showInformationMessage(t('VersionDock [{0}]: "{1}" is already in SVN ignore for {2}', repo.meta.name, result.entry, result.directoryPath || '.'));
          } else {
            vscode.window.showInformationMessage(t('VersionDock [{0}]: Added "{1}" to SVN ignore for {2}', repo.meta.name, result.entry, result.directoryPath || '.'));
          }
          const status = await this.manager.getAllStatusesFresh();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repo.meta.name, String(e)));
        }
        break;
      }

      case 'COMMIT_MANAGE_SVN_IGNORE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind !== 'svn') return;
        const svn = repo as unknown as Partial<SvnIgnoreRepo>;
        if (
          typeof svn.addIgnoreEntry !== 'function'
          || typeof svn.listIgnoreEntries !== 'function'
          || typeof svn.removeIgnoreEntries !== 'function'
        ) return;
        try {
          const entries = await svn.listIgnoreEntries();
          const actionItems: SvnIgnoreActionPickItem[] = [
            { label: `$(add) ${t('Add SVN Ignore...')}`, action: 'add' },
            ...(entries.length > 0
              ? [{ label: `$(trash) ${t('Remove SVN Ignore Entries...')}`, action: 'remove' } satisfies SvnIgnoreActionPickItem]
              : []),
          ];
          const action = await vscode.window.showQuickPick(actionItems, {
            title: t('Manage SVN Ignore...'),
            placeHolder: t('Choose an SVN ignore action'),
          });
          if (!action) return;

          if (action.action === 'add') {
            const entryPath = await this.pickSvnIgnorePath(repo);
            if (!entryPath) return;
            const result = await svn.addIgnoreEntry(entryPath);
            if (result.alreadyExists) {
              vscode.window.showInformationMessage(t('VersionDock [{0}]: "{1}" is already in SVN ignore for {2}', repo.meta.name, result.entry, result.directoryPath || '.'));
            } else {
              vscode.window.showInformationMessage(t('VersionDock [{0}]: Added "{1}" to SVN ignore for {2}', repo.meta.name, result.entry, result.directoryPath || '.'));
            }
            const status = await this.manager.getAllStatusesFresh();
            this.postChangelistsUpdate(status);
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            return;
          }

          if (entries.length === 0) {
            vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN ignore entries found.', repo.meta.name));
            return;
          }

          const picks: SvnIgnorePickItem[] = entries.map(entry => ({
            label: entry.entry,
            description: entry.directoryPath || '.',
            detail: entry.fullPath,
            entry,
          }));
          const selected = await vscode.window.showQuickPick(picks, {
            title: t('Remove SVN Ignore Entries...'),
            placeHolder: t('Select SVN ignore entries to remove'),
            canPickMany: true,
            matchOnDescription: true,
            matchOnDetail: true,
          });
          if (!selected || selected.length === 0) return;

          const confirm = await vscode.window.showWarningMessage(
            t('VersionDock [{0}]: Remove selected SVN ignore entries?', repo.meta.name),
            { modal: true },
            t('Remove'),
          );
          if (confirm !== t('Remove')) return;

          await svn.removeIgnoreEntries(selected.map(item => item.entry));
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Removed {1} SVN ignore entries.', repo.meta.name, selected.length));
          const status = await this.manager.getAllStatusesFresh();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repo.meta.name, String(e)));
        }
        break;
      }

      case 'COMMIT_SHOW_BRANCH_MENU': {
        await vscode.commands.executeCommand('versiondock.showBranchMenu', msg.repoId);
        break;
      }

      case 'COMMIT_OPEN_CONFLICTS': {
        await vscode.commands.executeCommand('versiondock.openConflicts');
        break;
      }

      case 'COMMIT_ABORT_OPERATION': {
        try {
          const targets = await collectAbortOperationTargets(this.manager, msg.repoIds);
          if (targets.length === 0) throw new Error(t('No merge or rebase in progress'));
          const result = await runAbortOperationFlow(this.manager, targets);
          if (!result.ok && 'cancelled' in result) {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            break;
          }
          if (!result.ok) throw new Error(result.error);

          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_RESTORE_CONFLICTS': {
        try {
          const targets: Array<{ repo: GitService; paths: string[] }> = [];
          for (const repoId of [...new Set(msg.repoIds)]) {
            const meta = this.manager.getRepoMetas().find(item => item.id === repoId);
            const repo = this.manager.getRepo(repoId);
            if (!meta || !repo) throw new Error(t('Repo not found'));
            if (meta.kind !== 'git') throw new Error(t('Only Git conflicts can be restored to the current branch version.'));

            const operationState = await repo.getOperationState();
            if (operationState) {
              throw new Error(t('Cannot restore conflicted files while another Git operation is in progress.'));
            }

            const status = await repo.getStatusFresh();
            const paths = [...new Set([...status.stagedFiles, ...status.unstagedFiles]
              .filter(file => file.status === 'conflicted')
              .map(file => file.path))];
            if (paths.length > 0) targets.push({ repo, paths });
          }

          const fileCount = targets.reduce((sum, target) => sum + target.paths.length, 0);
          if (fileCount === 0) throw new Error(t('No restorable conflicted files found'));
          const singleTarget = targets.length === 1 ? targets[0] : undefined;
          const confirm = await vscode.window.showWarningMessage(
            singleTarget
              ? (fileCount === 1
                  ? t('VersionDock [{0}]: Restore the conflicted file to the current branch version? This discards its index and working tree changes.', singleTarget.repo.meta.name)
                  : t('VersionDock [{0}]: Restore {1} conflicted files to their current branch versions? This discards their index and working tree changes.', singleTarget.repo.meta.name, fileCount))
              : (fileCount === 1
                  ? t('VersionDock: Restore the conflicted file to the current branch version? This discards its index and working tree changes.')
                  : t('VersionDock: Restore {0} conflicted files to their current branch versions? This discards their index and working tree changes.', fileCount)),
            { modal: true },
            t('Restore Current Branch'),
          );
          if (confirm !== t('Restore Current Branch')) {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            break;
          }

          const errors: string[] = [];
          for (const target of targets) {
            const errorCountBeforeTarget = errors.length;
            for (const filePath of target.paths) {
              try {
                await target.repo.discardFile(filePath);
              } catch (error: unknown) {
                const errStr = String(error);
                if (errStr.includes('did not match any file(s) known to git')) continue;
                errors.push(`${filePath}: ${errStr}`);
              }
            }
            if (errors.length === errorCountBeforeTarget) {
              // The user explicitly discarded the conflicted auto-stash
              // application. Keep its stash entry as the only remaining copy
              // and suppress the normal resolved-conflict cleanup prompt.
              target.repo.clearPendingPullAutoStash();
            }
          }

          const status = await this.manager.getAllStatusesFresh();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          if (errors.length > 0) throw new Error(errors.join('\n'));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_OPEN_MERGE_EDITOR': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const resolvedPath = repo.resolveRepoPath(msg.filePath);
        this.mergeEditorProvider?.openForFile(resolvedPath.absolutePath, msg.repoId, resolvedPath.relativePath);
        if (!this.mergeEditorProvider) {
          await vscode.window.showTextDocument(vscode.Uri.file(resolvedPath.absolutePath));
        }
        break;
      }

      case 'COMMIT_ACCEPT_OURS':
      case 'COMMIT_ACCEPT_THEIRS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        try {
          const relativePath = repo.resolveRepoPath(msg.filePath).relativePath;
          if (msg.type === 'COMMIT_ACCEPT_OURS') await repo.acceptOurs(relativePath);
          else await repo.acceptTheirs(relativePath);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'COMMIT_GENERATE_MESSAGE': {
        const uniqueRepoIds = new Set<string>();
        if (msg.repoIds) {
          for (const id of msg.repoIds) if (id) uniqueRepoIds.add(id);
        }
        if (msg.targets) {
          for (const target of msg.targets) if (target.repoId) uniqueRepoIds.add(target.repoId);
        }
        const singleRepoId = uniqueRepoIds.size === 1 ? Array.from(uniqueRepoIds)[0] : undefined;

        const cancellationSource = new vscode.CancellationTokenSource();
        this.activeCommitMessageGenerations.set(msg.requestId, cancellationSource);
        try {
          const message = await this.generateCommitMessage(msg.targets, msg.repoIds, msg.userPrompt, msg.requestId, cancellationSource.token);
          throwIfCancellationRequested(cancellationSource.token);
          this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, repoId: singleRepoId, message });
        } catch (e: unknown) {
          const error = cancellationSource.token.isCancellationRequested
            ? 'Cancelled'
            : e instanceof Error ? e.message : String(e);
          this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, repoId: singleRepoId, error });
        } finally {
          if (this.activeCommitMessageGenerations.get(msg.requestId) === cancellationSource) {
            this.activeCommitMessageGenerations.delete(msg.requestId);
          }
          cancellationSource.dispose();
        }
        break;
      }

      case 'COMMIT_OPEN_AI_COMPOSER': {
        if (!this.aiCommitComposerProvider) {
          vscode.window.showErrorMessage(t('VersionDock: AI Commit Composer is unavailable.'));
          return;
        }
        await this.aiCommitComposerProvider.openWorking(msg.candidates);
        break;
      }

      case 'COMMIT_OPEN_AI_REVIEW': {
        if (!this.aiCodeReviewProvider) {
          vscode.window.showErrorMessage(t('VersionDock: AI Code Review is unavailable.'));
          return;
        }
        this.aiCodeReviewProvider.open(msg.candidates);
        break;
      }

      case 'COMMIT_CANCEL_GENERATE_MESSAGE': {
        this.activeCommitMessageGenerations.get(msg.requestId)?.cancel();
        break;
      }

      case 'SHELVE_LIST': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves: [], error: t('Repo not found') }); return; }
        try {
          const shelves = await svc.list();
          this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves });
        } catch (e: unknown) {
          this.post({ type: 'SHELVE_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelves: [], error: String(e) });
        }
        break;
      }

      case 'SHELVE_PUSH': {
        const svc = this.getShelveService(msg.repoId);
        const repo = this.manager.getRepo(msg.repoId);
        if (!svc || !repo) { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: t('Repo not found') }); return; }
        try {
          const paths = msg.paths?.map(filePath => repo.resolveRepoPath(filePath).relativePath);
          // Capture changelist assignments for the shelved files, if in changelists mode
          const clSvc = this.getOrCreateChangelistService();
          const clAssignments = clSvc ? this.buildChangelistAssignments(clSvc, msg.repoId, paths) : undefined;
          await svc.push(msg.name, paths, clAssignments);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.postChangelistsUpdate(status);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: String(e) });
        }
        break;
      }

      case 'SHELVE_APPLY': {
        const svc = this.getShelveService(msg.repoId);
        const repo = this.manager.getRepo(msg.repoId);
        if (!svc || !repo) { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: t('Repo not found') }); return; }
        try {
          const paths = msg.paths?.map(filePath => repo.resolveRepoPath(filePath).relativePath);
          const clAssignments = await svc.apply(msg.shelveId, paths);
          if (msg.drop && (!paths || paths.length === 0)) {
            svc.drop(msg.shelveId);
          }
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          // Restore changelist assignments if present
          if (clAssignments?.length) {
            await this.restoreChangelistAssignments(msg.repoId, clAssignments);
          }
          this.postChangelistsUpdate(status);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: msg.drop ? 'drop' : 'apply', ok: true });
        } catch (e: unknown) {
          const err = e as { code?: string; conflictFiles?: string[] };
          if (err.code === 'SHELVE_CONFLICT' && err.conflictFiles?.length) {
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
            this.post({
              type: 'SHELVE_OP_RESULT',
              requestId: msg.requestId,
              repoId: msg.repoId,
              op: 'apply',
              ok: true,
              hasConflicts: true,
              conflictFiles: err.conflictFiles,
            });
            for (const filePath of err.conflictFiles) {
              const resolvedPath = repo.resolveRepoPath(filePath);
              this.mergeEditorProvider?.openForFile(resolvedPath.absolutePath, msg.repoId, resolvedPath.relativePath);
              if (!this.mergeEditorProvider) {
                await vscode.window.showTextDocument(vscode.Uri.file(resolvedPath.absolutePath), { preview: false });
              }
            }
          } else {
            this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: String(e) });
          }
        }
        break;
      }

      case 'SHELVE_DROP': {
        const svc = this.getShelveService(msg.repoId);
        if (!svc) { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || msg.repoId;
        const confirmDrop = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Delete this shelved changelist? This cannot be undone.', repoName),
          { modal: true }, t('Delete')
        );
        if (confirmDrop !== t('Delete')) { this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Cancelled' }); return; }
        try {
          svc.drop(msg.shelveId);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: String(e) });
        }
        break;
      }

      case 'SHELVE_GET_FILE_DIFF': {
        const svc = this.getShelveService(msg.repoId);
        const repo = this.manager.getRepo(msg.repoId);
        if (!svc || !repo) { this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: msg.filePath, diff: '', error: t('Repo not found') }); return; }
        try {
          const relativePath = repo.resolveRepoPath(msg.filePath).relativePath;
          const diff = svc.getFileDiff(msg.shelveId, relativePath);
          this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: relativePath, diff });
        } catch (e: unknown) {
          this.post({ type: 'SHELVE_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, shelveId: msg.shelveId, filePath: msg.filePath, diff: '', error: String(e) });
        }
        break;
      }

      case 'SHELVE_OPEN_FILE_DIFF': {
        const svc = this.getShelveService(msg.repoId);
        const repo = this.manager.getRepo(msg.repoId);
        if (!svc || !repo) return;
        try {
          const resolvedPath = repo.resolveRepoPath(msg.filePath);
          const diffChunk = svc.getFileDiff(msg.shelveId, resolvedPath.relativePath);
          const absFilePath = resolvedPath.absolutePath;
          const fileName = resolvedPath.relativePath.split('/').pop() ?? resolvedPath.relativePath;
          const shelves = await svc.list();
          const shelfName = shelves.find(s => s.id === msg.shelveId)?.name || msg.shelveId;

          const comparisonBase = vscode.workspace
            .getConfiguration('versiondock')
            .get<'local' | 'parent'>('diff.shelveComparisonBase', 'local');

          if (comparisonBase === 'parent') {
            const { baseContent, targetContent } = extractBaseAndTargetFromPatch(diffChunk);
            const leftUri = ShelveDocumentProvider.buildUri(msg.repoId, `${msg.shelveId}-base`, resolvedPath.relativePath);
            this.shelveDocProvider.set(leftUri, baseContent);
            const rightUri = ShelveDocumentProvider.buildUri(msg.repoId, `${msg.shelveId}-target`, resolvedPath.relativePath);
            this.shelveDocProvider.set(rightUri, targetContent);

            await vscode.commands.executeCommand(
              'vscode.diff',
              leftUri,
              rightUri,
              t('{0} (Base Commit ↔ Shelve: {1})', fileName, shelfName),
            );
          } else {
            // Read current working tree content (empty string if file doesn't exist)
            let currentContent = '';
            const fileExists = fs.existsSync(absFilePath);
            if (fileExists) {
              try { currentContent = fs.readFileSync(absFilePath, 'utf8'); } catch { /* unreadable */ }
            }

            // Apply the patch to get what the file would look like after unshelving
            const afterContent = applyPatchToContent(diffChunk, currentContent);

            // Right side: virtual doc showing post-unshelve content
            const afterUri = ShelveDocumentProvider.buildUri(msg.repoId, msg.shelveId, resolvedPath.relativePath);
            this.shelveDocProvider.set(afterUri, afterContent);

            // Left side: actual current working tree file, or virtual empty doc if file doesn't exist
            let leftUri: vscode.Uri;
            if (fileExists) {
              leftUri = vscode.Uri.file(absFilePath);
            } else {
              leftUri = ShelveDocumentProvider.buildUri(msg.repoId, `${msg.shelveId}-before`, resolvedPath.relativePath);
              this.shelveDocProvider.set(leftUri, '');
            }

            await vscode.commands.executeCommand(
              'vscode.diff',
              leftUri,
              afterUri,
              t('{0} (Working Tree ↔ Shelve: {1})', fileName, shelfName),
            );
          }
        } catch { /* silently ignore if file cannot be diffed */ }
        break;
      }

      case 'STASH_OPEN_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const resolvedPath = repo.resolveRepoPath(msg.filePath);
          const fileName = resolvedPath.relativePath.split('/').pop() ?? resolvedPath.relativePath;
          const absPath = resolvedPath.absolutePath;
          const safeRef = msg.stashRef.replace(/[{}]/g, '_');

          const comparisonBase = vscode.workspace
            .getConfiguration('versiondock')
            .get<'local' | 'parent'>('diff.shelveComparisonBase', 'local');

          if (comparisonBase === 'parent') {
            const parentContent = await repo.getStashParentFileContent(msg.stashRef, resolvedPath.relativePath);
            const leftUri = ShelveDocumentProvider.buildUri(msg.repoId, `${safeRef}-base`, resolvedPath.relativePath);
            this.shelveDocProvider.set(leftUri, parentContent);

            const stashedContent = await repo.getStashFileContent(msg.stashRef, resolvedPath.relativePath);
            const rightUri = ShelveDocumentProvider.buildUri(msg.repoId, safeRef, resolvedPath.relativePath);
            this.shelveDocProvider.set(rightUri, stashedContent);

            await vscode.commands.executeCommand(
              'vscode.diff',
              leftUri,
              rightUri,
              t('{0} (Base Commit ↔ {1})', fileName, msg.stashRef),
            );
          } else {
            // Left: current working tree content (virtual doc to avoid VSCode git extension interference)
            let currentContent = '';
            try {
              if (fs.existsSync(absPath)) currentContent = fs.readFileSync(absPath, 'utf8');
            } catch { /* unreadable, keep empty */ }
            const currentUri = ShelveDocumentProvider.buildUri(msg.repoId, `${safeRef}-current`, resolvedPath.relativePath);
            this.shelveDocProvider.set(currentUri, currentContent);

            // Right: stashed version — tracked path first, then untracked (stash@{N}^3)
            const stashedContent = await repo.getStashFileContent(msg.stashRef, resolvedPath.relativePath);
            const stashUri = ShelveDocumentProvider.buildUri(msg.repoId, safeRef, resolvedPath.relativePath);
            this.shelveDocProvider.set(stashUri, stashedContent);

            await vscode.commands.executeCommand(
              'vscode.diff',
              currentUri,
              stashUri,
              t('{0} (Working Tree ↔ {1})', fileName, msg.stashRef),
            );
          }
        } catch (e) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open stash diff — {1}', repo.meta.name, String(e)));
        }
        break;
      }

      case 'STASH_COUNT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_COUNT_RESULT', requestId: msg.requestId, repoId: msg.repoId, count: 0, error: t('Repo not found') });
          return;
        }
        try {
          const count = await repo.stashCount();
          this.post({ type: 'STASH_COUNT_RESULT', requestId: msg.requestId, repoId: msg.repoId, count });
        } catch (e: unknown) {
          this.post({ type: 'STASH_COUNT_RESULT', requestId: msg.requestId, repoId: msg.repoId, count: 0, error: String(e) });
        }
        break;
      }

      case 'STASH_LIST': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes: [], error: t('Repo not found') });
          return;
        }
        try {
          const stashes = await repo.stashList();
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes });
        } catch (e: unknown) {
          this.post({ type: 'STASH_LIST_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashes: [], error: String(e) });
        }
        break;
      }

      case 'STASH_GET_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashRef: msg.stashRef, stashOid: msg.stashOid, files: [], error: t('Repo not found') });
          return;
        }
        try {
          const files = await repo.getStashFiles(msg.stashOid ?? msg.stashRef);
          this.post({ type: 'STASH_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashRef: msg.stashRef, stashOid: msg.stashOid, files });
        } catch (e: unknown) {
          this.post({ type: 'STASH_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, stashRef: msg.stashRef, stashOid: msg.stashOid, files: [], error: String(e) });
        }
        break;
      }

      case 'STASH_SHOW': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff: '', error: t('Repo not found') });
          return;
        }
        try {
          const relativePath = repo.resolveRepoPath(msg.filePath).relativePath;
          const diff = await repo.stashShow(msg.stashRef, relativePath);
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff });
        } catch (e: unknown) {
          this.post({ type: 'STASH_SHOW_RESULT', requestId: msg.requestId, diff: '', error: String(e) });
        }
        break;
      }

      case 'STASH_APPLY': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await repo.stashApply(msg.stashRef);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: false, error: String(e) });
        }
        break;
      }

      case 'STASH_POP': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await repo.stashPop(msg.stashRef);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'pop', ok: false, error: String(e) });
        }
        break;
      }

      case 'STASH_DROP': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: t('Repo not found') });
          return;
        }
        const confirmDrop = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Drop this stash? This cannot be undone.', repo.meta.name),
          { modal: true }, t('Drop')
        );
        if (confirmDrop !== t('Drop')) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.stashDrop(msg.stashRef);
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'drop', ok: false, error: String(e) });
        }
        break;
      }

      case 'PUSH_GET_SYNC_COUNTS': {
        try {
          const allMetas = this.manager.getRepoMetas();
          const targetMetas = msg.repoIds && msg.repoIds.length > 0
            ? allMetas.filter(m => msg.repoIds!.includes(m.id))
            : allMetas;
          const counts: Record<string, { unpushed: number; incoming: number }> = {};
          await Promise.all(targetMetas.map(async meta => {
            const repo = this.manager.getRepo(meta.id);
            if (!repo || repo.kind === 'svn') {
              counts[meta.id] = { unpushed: 0, incoming: 0 };
              return;
            }
            try {
              const gitRepo = repo as GitService;
              const res = await gitRepo.getSyncCounts();
              counts[meta.id] = res;
            } catch {
              counts[meta.id] = { unpushed: 0, incoming: 0 };
            }
          }));
          this.post({ type: 'PUSH_SYNC_COUNTS_RESULT', requestId: msg.requestId, counts });
        } catch {
          this.post({ type: 'PUSH_SYNC_COUNTS_RESULT', requestId: msg.requestId, counts: {} });
        }
        break;
      }

      case 'PUSH_GET_UNPUSHED': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: t('Repo not found') });
          return;
        }
        try {
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          if (commits.length > 0 && repo.kind !== 'svn') {
            this.triggerCommitsStatsUpdate(repo as GitService, msg.repoId, 'outgoing');
          }
        } catch (e: unknown) {
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: String(e) });
        }
        break;
      }

      case 'PUSH_GET_COMMIT_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'PUSH_COMMIT_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, hash: msg.hash, files: [], error: t('Repo not found') });
          return;
        }
        try {
          if (repo.kind !== 'svn') {
            const gitRepo = repo as GitService;
            const parents = await gitRepo.getCommitParents(msg.hash).catch(() => []);
            if (parents.length >= 2) {
              const files = await gitRepo.getCommitFilesForLogDetail(msg.hash, parents).catch(() => []);
              this.post({
                type: 'PUSH_COMMIT_FILES_RESULT',
                requestId: msg.requestId,
                repoId: msg.repoId,
                hash: msg.hash,
                files,
                isMerge: true,
              });
              break;
            }
          }
          const files = await repo.getCommitFiles(msg.hash);
          this.post({ type: 'PUSH_COMMIT_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, hash: msg.hash, files, isMerge: false });
        } catch (e: unknown) {
          this.post({ type: 'PUSH_COMMIT_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, hash: msg.hash, files: [], error: String(e) });
        }
        break;
      }

      case 'PUSH_GET_AGGREGATED_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'PUSH_AGGREGATED_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, files: [], error: t('Repo not found') });
          return;
        }
        try {
          const files = await repo.getUnpushedAggregatedChanges(msg.oldestHash);
          this.post({ type: 'PUSH_AGGREGATED_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, files });
        } catch (e: unknown) {
          this.post({ type: 'PUSH_AGGREGATED_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, files: [], error: String(e) });
        }
        break;
      }

      case 'PUSH_OPEN_COMMIT_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          await this.openCommitDiffEditor(repo as GitService, msg.hash, msg.filePath, msg.fileStatus);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open diff: {1}', repo.meta.name, String(e)));
        }
        break;
      }

      case 'PUSH_OPEN_AGGREGATED_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') return;
        try {
          await this.openAggregatedCommitDiffEditor(repo as GitService, msg.oldestHash, msg.filePath, msg.fileStatus);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open aggregated diff: {1}', repo.meta.name, String(e)));
        }
        break;
      }

      case 'SYNC_GET_INCOMING': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') {
          this.post({ type: 'SYNC_INCOMING_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: t('Repo not found') });
          return;
        }
        try {
          const commits = await (repo as GitService).getIncomingCommits();
          this.post({ type: 'SYNC_INCOMING_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          if (commits.length > 0) {
            this.triggerCommitsStatsUpdate(repo as GitService, msg.repoId, 'incoming');
          }
        } catch (e: unknown) {
          this.post({ type: 'SYNC_INCOMING_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: String(e) });
        }
        break;
      }

      case 'SYNC_GET_INCOMING_COMMIT_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') {
          this.post({ type: 'SYNC_INCOMING_COMMIT_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, hash: msg.hash, files: [], error: t('Repo not found') });
          return;
        }
        try {
          const gitRepo = repo as GitService;
          const parents = await gitRepo.getCommitParents(msg.hash).catch(() => []);
          if (parents.length >= 2) {
            const files = await gitRepo.getCommitFilesForLogDetail(msg.hash, parents).catch(() => []);
            this.post({
              type: 'SYNC_INCOMING_COMMIT_FILES_RESULT',
              requestId: msg.requestId,
              repoId: msg.repoId,
              hash: msg.hash,
              files,
              isMerge: true,
            });
            break;
          }
          const files = await gitRepo.getCommitFiles(msg.hash);
          this.post({ type: 'SYNC_INCOMING_COMMIT_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, hash: msg.hash, files, isMerge: false });
        } catch (e: unknown) {
          this.post({ type: 'SYNC_INCOMING_COMMIT_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, hash: msg.hash, files: [], error: String(e) });
        }
        break;
      }

      case 'SYNC_GET_INCOMING_AGGREGATED_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') {
          this.post({ type: 'SYNC_INCOMING_AGGREGATED_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, files: [], error: t('Repo not found') });
          return;
        }
        try {
          const files = await (repo as GitService).getIncomingAggregatedChanges();
          this.post({ type: 'SYNC_INCOMING_AGGREGATED_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, files });
        } catch (e: unknown) {
          this.post({ type: 'SYNC_INCOMING_AGGREGATED_DIFF_RESULT', requestId: msg.requestId, repoId: msg.repoId, files: [], error: String(e) });
        }
        break;
      }

      case 'SYNC_OPEN_INCOMING_COMMIT_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') return;
        try {
          await this.openCommitDiffEditor(repo as GitService, msg.hash, msg.filePath, msg.fileStatus);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open diff: {1}', repo.meta.name, String(e)));
        }
        break;
      }

      case 'SYNC_OPEN_INCOMING_AGGREGATED_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') return;
        try {
          await this.openIncomingAggregatedCommitDiffEditor(repo as GitService, msg.filePath, msg.fileStatus);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open aggregated diff: {1}', repo.meta.name, String(e)));
        }
        break;
      }

      case 'SYNC_FETCH_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') {
          this.post({ type: 'SYNC_FETCH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Repo not found') });
          return;
        }
        const repoMeta = this.manager.getRepoMeta(msg.repoId);
        const repoName = repoMeta?.name || path.basename(repo.rootPath) || msg.repoId;
        const progressTitle = t('VersionDock [{0}]: Fetching all remotes…', repoName);

        const fetchRepoOp = async () => {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: progressTitle,
              cancellable: false,
            },
            async () => {
              await (repo as GitService).fetchSingleRepo();
              await this.manager.refreshStatusNow();
              const commits = await (repo as GitService).getIncomingCommits();
              this.post({ type: 'SYNC_INCOMING_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
              if (commits.length > 0) {
                this.triggerCommitsStatsUpdate(repo as GitService, msg.repoId, 'incoming');
              }
              this.post({ type: 'SYNC_FETCH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
            }
          );
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Fetch complete.', repoName));
        };

        try {
          if (this.branchStatusBar) {
            await this.branchStatusBar.withOperationProgress(fetchRepoOp, 'sync', repoName);
          } else {
            await fetchRepoOp();
          }
        } catch (e: unknown) {
          this.post({ type: 'SYNC_FETCH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Fetch failed — {1}', repoName, String(e)));
        }
        break;
      }

      case 'SYNC_FETCH_ALL': {
        const allMetas = this.manager.getRepoMetas();
        const gitRepos = allMetas.filter(m => m.kind !== 'svn');
        const progressTitle = allMetas.length === 1
          ? t('VersionDock [{0}]: Fetching all remotes…', allMetas[0].name)
          : t('VersionDock: Fetching all remotes…');

        const fetchAllOp = async () => {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: progressTitle,
              cancellable: false,
            },
            async () => {
              const errors: string[] = [];
              await Promise.all(gitRepos.map(async m => {
                const repo = this.manager.getRepo(m.id);
                if (repo && repo.kind !== 'svn') {
                  try {
                    await (repo as GitService).fetchAll();
                  } catch (err) {
                    errors.push(`${m.name || m.id}: ${String(err)}`);
                  }
                }
              }));
              await this.manager.refreshStatusNow();
              this.manager.notifyBranchesChanged();

              if (errors.length === gitRepos.length && gitRepos.length > 0) {
                this.post({ type: 'SYNC_FETCH_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
                if (gitRepos.length === 1) {
                  vscode.window.showErrorMessage(t('VersionDock [{0}]: Fetch failed — {1}', this.manager.getRepoMeta(gitRepos[0].id)?.name ?? gitRepos[0].id, errors[0]));
                } else {
                  vscode.window.showErrorMessage(t('VersionDock: Fetch failed for all repositories:\n{0}', errors.join('\n')));
                }
              } else if (errors.length > 0) {
                this.post({ type: 'SYNC_FETCH_RESULT', requestId: msg.requestId, ok: false, partial: true, error: errors.join('\n') });
                vscode.window.showWarningMessage(t('VersionDock: Fetch partially succeeded. Some repositories failed:\n{0}', errors.join('\n')));
              } else {
                this.post({ type: 'SYNC_FETCH_RESULT', requestId: msg.requestId, ok: true });
                if (allMetas.length === 1) {
                  vscode.window.showInformationMessage(t('VersionDock [{0}]: Fetch complete.', allMetas[0].name));
                } else {
                  vscode.window.showInformationMessage(t('VersionDock: Fetch complete.'));
                }
              }
            }
          );
        };

        try {
          if (this.branchStatusBar) {
            await this.branchStatusBar.withOperationProgress(fetchAllOp, 'sync');
          } else {
            await fetchAllOp();
          }
        } catch (e: unknown) {
          this.post({ type: 'SYNC_FETCH_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'SYNC_DO_PULL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'SYNC_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Repo not found') });
          return;
        }
        try {
          let effectiveStrategy: SyncPullStrategy | undefined = msg.strategy ?? 'default';
          if (repo.kind !== 'svn') {
            effectiveStrategy = await this.resolveEffectivePullStrategy(msg.strategy);
            if (!effectiveStrategy) {
              this.post({ type: 'SYNC_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: 'Cancelled' });
              return;
            }
          }

          const repoMeta = this.manager.getRepoMeta(msg.repoId);
          const repoName = repoMeta?.name || path.basename(repo.rootPath) || msg.repoId;

          let trackedResult: TrackedUpdateResult | undefined;
          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: t('VersionDock [{0}]: Updating…', repoName),
                cancellable: false,
              },
              async () => {
                if (this.updateSummaryService) {
                  trackedResult = await this.updateSummaryService.run({
                    repoId: msg.repoId,
                    execute: async target => {
                      if (repo.kind === 'svn') {
                        return target.pull();
                      }
                      return target.pullWithCustomStrategy(effectiveStrategy);
                    },
                  });
                  if (!trackedResult.ok) {
                    throw new Error(trackedResult.error ?? t('Unknown error'));
                  }
                } else {
                  if (repo.kind === 'svn') {
                    await repo.pull();
                  } else {
                    await (repo as GitService).pullWithCustomStrategy(effectiveStrategy);
                  }
                }
              },
            );

            this.logProvider?.refresh({ repoIds: [msg.repoId] });
            this.invalidateSubtreeStatus(undefined, { remote: false });
            await this.broadcastUnpushedCommits([msg.repoId]);
            if (repo.kind !== 'svn') {
              const gitRepo = repo as GitService;
              const incoming = await gitRepo.getIncomingCommits?.().catch(() => []);
              this.post({ type: 'SYNC_INCOMING_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: incoming ?? [] });
            }
            if (this.isSubtreeTabActive()) {
              void this.refreshSubtreeList({ force: false });
            }
            this.manager.notifyBranchesChanged();
            await this.refreshStatusAfterOp();
            this.post({ type: 'SYNC_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
          }, 'sync', t('Updating…'));

          if (trackedResult) {
            await this.updateSummaryService?.notify([trackedResult]);
          }
        } catch (e: unknown) {
          this.post({ type: 'SYNC_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: String(e) });
        }
        break;
      }

      case 'SYNC_DO_PULL_MULTI': {
        try {
          const hasGitRepos = msg.repoIds.some(id => this.manager.getRepo(id)?.kind !== 'svn');
          let effectiveStrategy: SyncPullStrategy | undefined = msg.strategy ?? 'default';
          if (hasGitRepos) {
            effectiveStrategy = await this.resolveEffectivePullStrategy(msg.strategy);
            if (!effectiveStrategy) {
              this.post({ type: 'SYNC_PULL_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
              return;
            }
          }

          let trackedResults: TrackedUpdateResult[] | undefined;
          let hasError = false;
          let firstError = '';

          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: msg.repoIds.length === 1
                  ? t('VersionDock [{0}]: Updating project…', this.manager.getRepoMeta(msg.repoIds[0])?.name || '')
                  : t('VersionDock: Updating all projects…'),
                cancellable: false,
              },
              async progress => {
                const count = msg.repoIds.length;
                if (this.updateSummaryService) {
                  trackedResults = await this.updateSummaryService.runAll(
                    msg.repoIds.map(repoId => ({
                      repoId,
                      execute: async target => {
                        const r = this.manager.getRepo(repoId);
                        if (r?.kind === 'svn') {
                          return target.pull();
                        }
                        return target.pullWithCustomStrategy(effectiveStrategy);
                      },
                    })),
                    (completed, total, target) => {
                      const name = this.manager.getRepoMeta(target.repoId)?.name ?? target.repoId;
                      progress.report({
                        message: `(${completed + 1}/${total}) ${name}`,
                        increment: count > 0 ? 100 / count : undefined,
                      });
                    },
                  );
                  const failed = trackedResults.filter(r => !r.ok);
                  if (failed.length > 0) {
                    hasError = true;
                    firstError = failed[0]?.error || t('Update failed');
                  }
                } else {
                  let index = 0;
                  for (const repoId of msg.repoIds) {
                    const repo = this.manager.getRepo(repoId);
                    if (!repo) {
                      index++;
                      continue;
                    }
                    const name = this.manager.getRepoMeta(repoId)?.name ?? repoId;
                    progress.report({
                      message: `(${index + 1}/${count}) ${name}`,
                      increment: count > 0 ? 100 / count : undefined,
                    });
                    try {
                      if (repo.kind === 'svn') {
                        await repo.pull();
                      } else {
                        await (repo as GitService).pullWithCustomStrategy(effectiveStrategy);
                      }
                    } catch (err) {
                      hasError = true;
                      firstError = String(err);
                    }
                    index++;
                  }
                }
              },
            );
            this.logProvider?.refresh({ repoIds: msg.repoIds });
            this.invalidateSubtreeStatus(undefined, { remote: false });
            await this.broadcastUnpushedCommits(msg.repoIds);
            await this.broadcastIncomingCommits(msg.repoIds, msg.requestId);
            if (this.isSubtreeTabActive()) {
              void this.refreshSubtreeList({ force: false });
            }
            this.manager.notifyBranchesChanged();
            await this.refreshStatusAfterOp();
            this.post({ type: 'SYNC_PULL_RESULT', requestId: msg.requestId, ok: !hasError, error: hasError ? firstError : undefined });
          }, 'sync', t('Updating…'));

          if (trackedResults && trackedResults.length > 0) {
            await this.updateSummaryService?.notify(trackedResults);
          }
        } catch (e: unknown) {
          this.post({ type: 'SYNC_PULL_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'SYNC_DO_SYNC': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId });
          return;
        }
        try {
          const repoMeta = this.manager.getRepoMeta(msg.repoId);
          const repoName = repoMeta?.name || path.basename(repo.rootPath) || msg.repoId;

          let shouldUpdate = false;
          let effectiveStrategy: SyncPullStrategy | undefined;
          if (repo.kind === 'svn') {
            shouldUpdate = true;
          } else {
            const gitRepo = repo as GitService;
            const currentBranch = await gitRepo.getCurrentBranch?.().catch(() => undefined);
            if (currentBranch?.upstream) {
              effectiveStrategy = await this.resolveEffectivePullStrategy(msg.strategy);
              if (!effectiveStrategy) {
                this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId });
                return;
              }
              shouldUpdate = true;
            }
          }

          let trackedResult: TrackedUpdateResult | undefined;
          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            if (shouldUpdate) {
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: t('VersionDock [{0}]: Updating…', repoName),
                  cancellable: false,
                },
                async () => {
                  if (repo.kind === 'svn') {
                    if (this.updateSummaryService) {
                      trackedResult = await this.updateSummaryService.run({
                        repoId: msg.repoId,
                        execute: async target => target.pull(),
                      });
                      if (!trackedResult.ok) throw new Error(trackedResult.error ?? t('Unknown error'));
                    } else {
                      await repo.pull();
                    }
                  } else {
                    const gitRepo = repo as GitService;
                    if (this.updateSummaryService) {
                      trackedResult = await this.updateSummaryService.run({
                        repoId: msg.repoId,
                        execute: async target => target.pullWithCustomStrategy(effectiveStrategy),
                      });
                      if (!trackedResult.ok) throw new Error(trackedResult.error ?? t('Unknown error'));
                    } else {
                      await gitRepo.pullWithCustomStrategy(effectiveStrategy);
                    }
                  }
                },
              );
              this.manager.notifyBranchesChanged();
            }

            const status = await repo.getStatus?.();
            if (status && status.conflictCount && status.conflictCount > 0) {
              const resolveBtn = t('Resolve Conflicts');
              const conflictMsg = t('VersionDock [{0}]: Sync stopped due to merge conflicts. Please resolve conflicts before pushing.', repoName);
              void vscode.window.showWarningMessage(
                conflictMsg,
                resolveBtn,
              ).then(choice => {
                if (choice === resolveBtn) {
                  void vscode.commands.executeCommand('versiondock.openConflicts');
                }
              });
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: conflictMsg, repoId: msg.repoId });
              if (trackedResult) {
                await this.updateSummaryService?.notify([trackedResult]);
              }
              return;
            }

            const pushResult = await runPushWithProtection(repo, {
              repoName,
              remote: msg.remote,
              logger: this.logger,
              beforePush: () => this.checkUnpushedSubmodules(msg.repoId),
            });

            if (pushResult.success) {
              this.logProvider?.refresh({ repoIds: [msg.repoId] });
              this.invalidateSubtreeStatus(undefined, { remote: false });
              await this.broadcastUnpushedCommits([msg.repoId]);
              if (repo.kind !== 'svn') {
                const gitRepo = repo as GitService;
                const incoming = await gitRepo.getIncomingCommits?.().catch(() => []);
                this.post({ type: 'SYNC_INCOMING_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: incoming ?? [] });
              }
              if (this.isSubtreeTabActive()) {
                void this.refreshSubtreeList({ force: false });
              }
              await this.refreshStatusAfterOp();
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
              if (trackedResult) {
                await this.updateSummaryService?.notify([trackedResult]);
              }
            } else if (pushResult.cancelled) {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId });
              if (trackedResult) {
                await this.updateSummaryService?.notify([trackedResult]);
              }
            } else {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: pushResult.error ? String(pushResult.error) : t('Push failed'), repoId: msg.repoId });
              if (trackedResult) {
                await this.updateSummaryService?.notify([trackedResult]);
              }
            }
          }, 'sync', t('Syncing…'));
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'SYNC_DO_SYNC_MULTI': {
        try {
          let hasError = false;
          const errors: string[] = [];
          const pulledRepoIds: string[] = [];
          const reposToUpdate: string[] = [];

          for (const repoId of msg.repoIds) {
            const repo = this.manager.getRepo(repoId);
            if (!repo) continue;
            if (repo.kind === 'svn') {
              reposToUpdate.push(repoId);
            } else {
              const gitRepo = repo as GitService;
              const currentBranch = await gitRepo.getCurrentBranch?.().catch(() => undefined);
              if (currentBranch?.upstream) {
                reposToUpdate.push(repoId);
              } else {
                pulledRepoIds.push(repoId);
              }
            }
          }

          let effectiveStrategy: SyncPullStrategy | undefined = msg.strategy ?? 'default';
          if (reposToUpdate.some(id => this.manager.getRepo(id)?.kind !== 'svn')) {
            effectiveStrategy = await this.resolveEffectivePullStrategy(msg.strategy);
            if (!effectiveStrategy) {
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
              return;
            }
          }

          let trackedResults: TrackedUpdateResult[] | undefined;
          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            if (reposToUpdate.length > 0) {
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: reposToUpdate.length === 1
                    ? t('VersionDock [{0}]: Updating project…', this.manager.getRepoMeta(reposToUpdate[0])?.name || '')
                    : t('VersionDock: Updating all projects…'),
                  cancellable: false,
                },
                async progress => {
                  const count = reposToUpdate.length;
                  if (this.updateSummaryService) {
                    trackedResults = await this.updateSummaryService.runAll(
                      reposToUpdate.map(repoId => ({
                        repoId,
                        execute: async target => {
                          const r = this.manager.getRepo(repoId);
                          if (r?.kind === 'svn') {
                            return target.pull();
                          }
                          return target.pullWithCustomStrategy(effectiveStrategy);
                        },
                      })),
                      (completed, total, target) => {
                        const name = this.manager.getRepoMeta(target.repoId)?.name ?? target.repoId;
                        progress.report({
                          message: `(${completed + 1}/${total}) ${name}`,
                          increment: count > 0 ? 100 / count : undefined,
                        });
                      },
                    );
                    for (const tr of trackedResults) {
                      const repoMeta = this.manager.getRepoMeta(tr.repoId);
                      const repoName = repoMeta?.name || path.basename(this.manager.getRepo(tr.repoId)?.rootPath ?? '') || tr.repoId;
                      if (tr.ok) {
                        pulledRepoIds.push(tr.repoId);
                      } else {
                        hasError = true;
                        errors.push(`${repoName} (${t('Update')}): ${tr.error ?? t('Unknown error')}`);
                      }
                    }
                  } else {
                    let index = 0;
                    for (const repoId of reposToUpdate) {
                      const repo = this.manager.getRepo(repoId);
                      if (!repo) {
                        index++;
                        continue;
                      }
                      const repoMeta = this.manager.getRepoMeta(repoId);
                      const repoName = repoMeta?.name || path.basename(repo.rootPath) || repoId;
                      progress.report({
                        message: `(${index + 1}/${count}) ${repoName}`,
                        increment: count > 0 ? 100 / count : undefined,
                      });
                      try {
                        if (repo.kind === 'svn') {
                          await repo.pull();
                        } else {
                          await (repo as GitService).pullWithCustomStrategy(effectiveStrategy);
                        }
                        pulledRepoIds.push(repoId);
                      } catch (err) {
                        hasError = true;
                        errors.push(`${repoName} (${t('Update')}): ${String(err)}`);
                      }
                      index++;
                    }
                  }
                },
              );
              this.manager.notifyBranchesChanged();
            }

            if (pulledRepoIds.length > 0) {
              await vscode.window.withProgress(
                {
                  location: vscode.ProgressLocation.Notification,
                  title: pulledRepoIds.length === 1
                    ? t('VersionDock [{0}]: Pushing changes…', this.manager.getRepoMeta(pulledRepoIds[0])?.name || '')
                    : t('VersionDock: Pushing {0} repositories…', pulledRepoIds.length),
                  cancellable: false,
                },
                async pushProgress => {
                  const totalPush = pulledRepoIds.length;
                  for (let i = 0; i < totalPush; i++) {
                    const repoId = pulledRepoIds[i];
                    const repo = this.manager.getRepo(repoId);
                    if (!repo) continue;
                    const status = await repo.getStatus?.();
                    if (status && status.conflictCount && status.conflictCount > 0) {
                      continue;
                    }
                    const repoMeta = this.manager.getRepoMeta(repoId);
                    const repoName = repoMeta?.name || path.basename(repo.rootPath) || repoId;
                    pushProgress.report({
                      message: totalPush > 1 ? `(${i + 1}/${totalPush}) ${repoName}` : repoName,
                      increment: totalPush > 0 ? 100 / totalPush : undefined,
                    });
                    const pushResult = await runPushWithProtection(repo, {
                      repoName,
                      logger: this.logger,
                      silentOnSuccess: totalPush > 1,
                      suppressProgress: totalPush > 1,
                      beforePush: () => this.checkUnpushedSubmodules(repoId),
                    });
                    if (!pushResult.success) {
                      hasError = true;
                      if (pushResult.cancelled) {
                        errors.push(`${repoName} (Push): ${t('Push cancelled')}`);
                      } else {
                        errors.push(`${repoName} (Push): ${pushResult.error ? String(pushResult.error) : t('Push failed')}`);
                      }
                    }
                  }
                },
              );
            }

            this.logProvider?.refresh({ repoIds: msg.repoIds });
            this.invalidateSubtreeStatus(undefined, { remote: false });
            await this.broadcastUnpushedCommits(msg.repoIds);
            await this.broadcastIncomingCommits(msg.repoIds, msg.requestId);
            if (this.isSubtreeTabActive()) {
              void this.refreshSubtreeList({ force: false });
            }
            await this.refreshStatusAfterOp();
            this.post({
              type: 'COMMIT_OP_RESULT',
              requestId: msg.requestId,
              ok: !hasError,
              error: hasError ? errors.join('\n') : undefined,
            });
          }, 'sync', t('Syncing…'));

          if (trackedResults && trackedResults.length > 0) {
            await this.updateSummaryService?.notify(trackedResults);
          }
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'SYNC_PUSH_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId });
          return;
        }
        const repoMeta = this.manager.getRepoMeta(msg.repoId);
        const repoName = repoMeta?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          await withGitPushProgress(
            repo,
            msg.remote
              ? t('VersionDock [{0}]: Pushing tags to {1}…', repoName, msg.remote)
              : t('VersionDock [{0}]: Pushing tags…', repoName),
            () => (repo as GitService).pushTags(msg.remote),
          );
          vscode.window.showInformationMessage(t('VersionDock [{0}]: tags pushed successfully.', repoName));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
        } catch (err: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: push tags failed — {1}', repoName, String(err)));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(err), repoId: msg.repoId });
        }
        break;
      }

      case 'SYNC_PUSH_TAGS_MULTI': {
        const succeededRepoIds: string[] = [];
        const errors: string[] = [];
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo || repo.kind === 'svn') continue;
          const repoMeta = this.manager.getRepoMeta(repoId);
          const repoName = repoMeta?.name || path.basename(repo.rootPath) || repoId;
          try {
            const gitRepo = repo as GitService;
            await gitRepo.pushTags();
            succeededRepoIds.push(repoId);
          } catch (err: unknown) {
            errors.push(`${repoName}: ${String(err)}`);
          }
        }
        if (errors.length === 0) {
          const singleName = msg.repoIds.length === 1 ? (this.manager.getRepoMeta(msg.repoIds[0])?.name || msg.repoIds[0]) : undefined;
          if (singleName) {
            vscode.window.showInformationMessage(t('VersionDock [{0}]: Tags pushed successfully.', singleName));
          } else {
            vscode.window.showInformationMessage(t('VersionDock: tags pushed successfully for all selected repositories.'));
          }
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, handled: true });
        } else if (succeededRepoIds.length > 0) {
          vscode.window.showWarningMessage(
            t('VersionDock: Tags pushed in {0} repositories, {1} failed: {2}', succeededRepoIds.length, errors.length, errors.join('; '))
          );
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n'), handled: true });
        } else {
          const singleName = msg.repoIds.length === 1 ? (this.manager.getRepoMeta(msg.repoIds[0])?.name || msg.repoIds[0]) : undefined;
          if (singleName) {
            vscode.window.showErrorMessage(t('VersionDock [{0}]: push tags failed — {1}', singleName, errors[0] ?? ''));
          } else {
            vscode.window.showErrorMessage(
              t('VersionDock: Push tags failed in all {0} repositories: {1}', errors.length, errors.join('; '))
            );
          }
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n'), handled: true });
        }
        break;
      }

      case 'SYNC_CHERRY_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo || repo.kind === 'svn') {
          const repoName = this.manager.getRepoMeta(msg.repoId)?.name ?? msg.repoId;
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Repo not found', repoName));
          return;
        }
        const gitRepo = repo as GitService;
        const count = msg.hashes.length;
        if (count === 0) return;

        try {
          if (count === 1) {
            const shortHash = msg.hashes[0].slice(0, 7);
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Cherry-picking commit {1}…', repo.meta.name, shortHash), cancellable: false },
              () => gitRepo.cherryPick(msg.hashes[0])
            );
          } else {
            await vscode.window.withProgress(
              { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Cherry-picking {1} commits…', repo.meta.name, count), cancellable: false },
              () => gitRepo.cherryPickMulti(msg.hashes)
            );
          }
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
          this.manager.notifyDataInvalidated({
            scopes: ['workingTree', 'unpushed', 'subtree'],
            repoIds: [msg.repoId],
          });
        } catch (e: unknown) {
          const errMsg = String(e);
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            let activeChoice = await vscode.window.showWarningMessage(
              t('VersionDock [{0}]: Cherry-pick has conflicts. Resolve them in the editor, then choose an action.', repo.meta.name),
              t('Continue'), t('Skip'), t('Abort')
            );
            while (activeChoice === t('Continue') || activeChoice === t('Skip')) {
              try {
                if (activeChoice === t('Continue')) {
                  await gitRepo.cherryPickContinue();
                } else {
                  await gitRepo.cherryPickSkip();
                }
                break;
              } catch (stepErr: unknown) {
                const stepErrMsg = String(stepErr);
                if (stepErrMsg.includes('CONFLICT') || stepErrMsg.includes('could not apply')) {
                  activeChoice = await vscode.window.showWarningMessage(
                    t('VersionDock [{0}]: Cherry-pick has conflicts. Resolve them in the editor, then choose an action.', repo.meta.name),
                    t('Continue'), t('Skip'), t('Abort')
                  );
                  if (activeChoice === t('Abort')) {
                    await gitRepo.cherryPickAbort();
                    break;
                  }
                } else {
                  vscode.window.showErrorMessage(t('VersionDock [{0}]: Cherry-pick failed: {1}', repo.meta.name, stepErrMsg));
                  break;
                }
              }
            }
            if (activeChoice === t('Abort')) {
              await gitRepo.cherryPickAbort().catch(() => undefined);
            }
            await this.manager.refreshStatusNow();
            this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
            this.manager.notifyDataInvalidated({
              scopes: ['workingTree', 'unpushed', 'subtree'],
              repoIds: [msg.repoId],
            });
          } else {
            vscode.window.showErrorMessage(t('VersionDock [{0}]: Cherry-pick failed: {1}', repo.meta.name, errMsg));
          }
        }
        break;
      }

      case 'SYNC_CREATE_BRANCH_FROM_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          const repoName = this.manager.getRepoMeta(msg.repoId)?.name ?? msg.repoId;
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Repo not found', repoName));
          return;
        }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath);
        const shortRef = msg.hash.slice(0, 7);
        const branchName = await vscode.window.showInputBox({
          prompt: repo.kind === 'svn' ? t('Create SVN branch from revision {0}', shortRef) : t('Create new branch from {0}', shortRef),
          placeHolder: t('my-feature-branch'),
          validateInput: v => validateBranchNameInput(v),
        });
        if (!branchName) return;

        try {
          await repo.createBranchFromCommit(sanitizeBranchName(branchName.trim()), msg.hash);
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged();
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: Create branch failed: {1}', repoName, String(e)));
        }
        break;
      }

      case 'STASH_PUSH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          const paths = msg.paths?.map(filePath => repo.resolveRepoPath(filePath).relativePath);
          await repo.stashPush(msg.message, paths);
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.postChangelistsUpdate(status);
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'STASH_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'push', ok: false, error: String(e) });
        }
        break;
      }

      case 'PUSH_SQUASH_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const fullMessages = await Promise.all(msg.hashes.map(h => repo.getFullCommitMessage(h).then(m => m.trim())));
        const fullCommits = msg.commits.map((c, i) => ({ ...c, message: fullMessages[i] ?? c.message }));
        const result = await openSquashEditor(
          this.extensionUri,
          msg.hashes.length,
          fullCommits,
          (cancellationToken, onMessage) => generateHistoricalCommitMessage({
            service: this.aiCommitMessageService,
            repo,
            hashes: msg.hashes,
            requestId: `${msg.requestId}:squash`,
            cancellationToken,
            onMessage,
            logger: this.logger,
          }),
        );
        if (!result.confirmed) {
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Cancelled') });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Squashing {1} commits…', repoName, msg.hashes.length), cancellable: false },
            () => repo.squashCommits(msg.hashes, result.message),
          );
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          if (commits.length > 0 && repo.kind !== 'svn') {
            this.triggerCommitsStatsUpdate(repo as GitService, msg.repoId, 'outgoing');
          }
          this.logProvider?.refresh({ repoIds: [msg.repoId] });
          this.invalidateSubtreeStatus(undefined, { remote: false });
          if (this.isSubtreeTabActive()) {
            void this.refreshSubtreeList({ force: false });
          }
          await this.manager.refreshStatusNow();
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Squash completed.', repoName));
        } catch (e: unknown) {
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('VersionDock [{0}]: Squash failed: {1}', repoName, String(e)) });
        }
        break;
      }

      case 'PUSH_DROP_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Drop {1} commit(s)? This will hard reset the branch and delete these commits permanently.', repoName, msg.hashes.length),
          { modal: true }, t('Drop Commits')
        );
        if (confirm !== t('Drop Commits')) { this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: 'Cancelled' }); return; }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Dropping {1} commits…', repoName, msg.hashes.length), cancellable: false },
            () => repo.dropCommits(msg.oldestHash),
          );
          this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          if (commits.length > 0 && repo.kind !== 'svn') {
            this.triggerCommitsStatsUpdate(repo as GitService, msg.repoId, 'outgoing');
          }
          this.logProvider?.refresh({ repoIds: [msg.repoId] });
          this.invalidateSubtreeStatus(undefined, { remote: false });
          if (this.isSubtreeTabActive()) {
            void this.refreshSubtreeList({ force: false });
          }
          await this.manager.refreshStatusNow();
        } catch (e: unknown) {
          this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('VersionDock [{0}]: Drop failed: {1}', repoName, String(e)) });
        }
        break;
      }

      case 'PUSH_REVERT_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Revert {1} commit(s)? New inverse commits will be created on the current branch.', repoName, msg.hashes.length),
          { modal: true }, t('Revert Commits')
        );
        if (confirm !== t('Revert Commits')) { this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: 'Cancelled' }); return; }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Reverting {1} commits…', repoName, msg.hashes.length), cancellable: false },
            () => repo.revertCommits(msg.hashes),
          );
          this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          if (commits.length > 0 && repo.kind !== 'svn') {
            this.triggerCommitsStatsUpdate(repo as GitService, msg.repoId, 'outgoing');
          }
          this.logProvider?.refresh({ repoIds: [msg.repoId] });
          this.invalidateSubtreeStatus(undefined, { remote: false });
          if (this.isSubtreeTabActive()) {
            void this.refreshSubtreeList({ force: false });
          }
          await this.manager.refreshStatusNow();
        } catch (e: unknown) {
          const errMsg = String(e);
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            void vscode.window.showWarningMessage(
              t('VersionDock [{0}]: Revert has conflicts. Review and resolve them in the Conflicts panel, then commit or abort.', repoName),
              t('Open Conflict List')
            ).then(choice => {
              if (choice) void vscode.commands.executeCommand('versiondock.openConflicts');
            });
          }
          this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('VersionDock [{0}]: Revert failed: {1}', repoName, errMsg) });
        }
        break;
      }

      case 'PUSH_EDIT_COMMIT_MSG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const fullMessage = (await repo.getFullCommitMessage(msg.hash)).trim();
        const result = await openEditMessageEditor(
          this.extensionUri,
          msg.hash.slice(0, 7),
          fullMessage,
          (cancellationToken, onMessage) => generateHistoricalCommitMessage({
            service: this.aiCommitMessageService,
            repo,
            hashes: [msg.hash],
            requestId: `${msg.requestId}:edit`,
            cancellationToken,
            onMessage,
            logger: this.logger,
          }),
        );
        if (!result.confirmed) {
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Cancelled') });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Updating commit message…', repoName), cancellable: false },
            () => repo.rewordCommit(result.message),
          );
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          if (commits.length > 0 && repo.kind !== 'svn') {
            this.triggerCommitsStatsUpdate(repo as GitService, msg.repoId, 'outgoing');
          }
          this.logProvider?.refresh({ repoIds: [msg.repoId] });
          this.invalidateSubtreeStatus(undefined, { remote: false });
          if (this.isSubtreeTabActive()) {
            void this.refreshSubtreeList({ force: false });
          }
          await this.manager.refreshStatusNow();
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Commit message updated.', repoName));
        } catch (e: unknown) {
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('VersionDock [{0}]: Edit commit message failed: {1}', repoName, String(e)) });
        }
        break;
      }

      case 'COMMIT_OPEN_LOG': {
        this.logProvider?.selectCommit(msg.hash, msg.repoId);
        break;
      }

      case 'COMMIT_UNDO_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found'), repoId: msg.repoId }); return; }
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Undo last commit? Changes will be kept as unstaged (git reset --soft HEAD~1).', repo.meta.name),
          { modal: true }, t('Undo Commit')
        );
        if (confirm !== t('Undo Commit')) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled', repoId: msg.repoId }); return; }
        try {
          await this.manager.runWithStatusUpdatesSuppressed(async () => {
            await repo.undoCommit();
            this.invalidateSubtreeStatus(undefined, { remote: false });
            this.logProvider?.refresh({ repoIds: [msg.repoId] });
            if (this.isSubtreeTabActive()) {
              void this.refreshSubtreeList({ force: false });
            }
            const commits = await repo.getUnpushedCommits();
            this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
            if (commits.length > 0 && repo.kind !== 'svn') {
              this.triggerCommitsStatsUpdate(repo as GitService, msg.repoId, 'outgoing');
            }
            await this.refreshStatusAfterOp();
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, repoId: msg.repoId });
          }, 'commit', t('Undoing commit…'));
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e), repoId: msg.repoId });
        }
        break;
      }

      case 'CHANGELISTS_CREATE': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          svc.create(msg.name);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_CREATE_PROMPT': {
        const name = await vscode.window.showInputBox({
          title: t('New Changelist'),
          prompt: t('Enter a name for the new changelist'),
          placeHolder: t('Changelist name…'),
          validateInput: v => v.trim() ? undefined : t('Name cannot be empty'),
        });
        if (!name) break;
        const svcCreate = this.getOrCreateChangelistService();
        if (svcCreate) {
          svcCreate.create(name.trim());
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_RENAME': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          svc.rename(msg.id, msg.name);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_RENAME_PROMPT': {
        const newName = await vscode.window.showInputBox({
          title: t('Rename Changelist'),
          prompt: t('Rename "{0}"', msg.currentName),
          value: msg.currentName,
          validateInput: v => v.trim() ? undefined : t('Name cannot be empty'),
        });
        if (!newName) break;
        const svcRename = this.getOrCreateChangelistService();
        if (svcRename) {
          svcRename.rename(msg.id, newName.trim());
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_DELETE': {
        const svcDel = this.getOrCreateChangelistService();
        if (!svcDel) break;
        const clToDelete = svcDel.getAll().find(c => c.id === msg.id);
        const clName = clToDelete?.name ?? t('this changelist');
        const confirmed = await vscode.window.showWarningMessage(
          t('VersionDock: Delete "{0}"? Its files will be moved to Changes.', clName),
          { modal: true }, t('Delete')
        );
        if (confirmed !== t('Delete')) break;
        svcDel.delete(msg.id);
        this.postChangelistsUpdate();
        break;
      }

      case 'CHANGELISTS_MOVE_FILES': {
        const svc = this.getOrCreateChangelistService();
        if (svc) {
          await this.stageUnversionedFiles(svc, msg.assignments);
          svc.moveFiles(msg.assignments);
          this.postChangelistsUpdate();
        }
        break;
      }

      case 'CHANGELISTS_MOVE_FILES_PROMPT': {
        const svcMove = this.getOrCreateChangelistService();
        if (!svcMove) break;
        const allCls = svcMove.getAll().filter(cl => cl.id !== CHANGELIST_UNVERSIONED_ID);
        const picks = allCls.map(cl => ({ label: cl.name, description: cl.id }));
        const picked = await vscode.window.showQuickPick(picks, {
          title: t('Move to Changelist'),
          placeHolder: t('Select a changelist…'),
        });
        if (!picked) break;
        const assignments = msg.files.map(f => ({ ...f, changelistId: picked.description! }));
        await this.stageUnversionedFiles(svcMove, assignments);
        svcMove.moveFiles(assignments);
        this.postChangelistsUpdate();
        break;
      }

      case 'CHANGELISTS_SHELVE': {
        const clSvc = this.getOrCreateChangelistService();
        if (!clSvc) break;
        const clForShelve = clSvc.getAll().find(c => c.id === msg.changelistId);
        if (!clForShelve) break;
        // Gather files per repo for this changelist
        const filesByRepo = new Map<string, string[]>();
        for (const [repoId, paths] of Object.entries(clForShelve.fileAssignments)) {
          const repo = this.manager.getRepo(repoId);
          if (paths.length > 0 && repo?.kind !== 'svn') filesByRepo.set(repoId, paths);
        }
        if (filesByRepo.size === 0) { vscode.window.showInformationMessage(t('VersionDock: No files in this changelist to shelve.')); break; }
        const shelveName = await vscode.window.showInputBox({
          title: t('Shelve "{0}"', clForShelve.name),
          value: clForShelve.name,
          placeHolder: t('Shelve name…'),
          validateInput: v => v.trim() ? undefined : t('Name cannot be empty'),
        });
        if (!shelveName) break;
        for (const [repoId, paths] of filesByRepo) {
          const shelveSvc = this.getShelveService(repoId);
          const repo = this.manager.getRepo(repoId);
          if (!shelveSvc || !repo) continue;
          const safePaths = paths.map(filePath => repo.resolveRepoPath(filePath).relativePath);
          const clAssignments = this.buildChangelistAssignments(clSvc, repoId, safePaths);
          try {
            await shelveSvc.push(shelveName.trim(), safePaths, clAssignments);
          } catch (e: unknown) {
            const repoName = this.manager.getRepoMeta(repoId)?.name ?? repoId;
            void showGitErrorMessage(t('VersionDock [{0}]: Shelve failed: {1}', repoName, String(e)), {
              repoName,
              onUnlocked: async () => {
                const status = await this.manager.getAllStatusesFresh();
                this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
              },
            });
          }
        }
        const shelveStatus = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: shelveStatus });
        this.postChangelistsUpdate(shelveStatus);
        this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: [...filesByRepo.keys()][0], op: 'push', ok: true });
        break;
      }

      case 'CHANGELISTS_STASH': {
        const clSvcStash = this.getOrCreateChangelistService();
        if (!clSvcStash) break;
        const clForStash = clSvcStash.getAll().find(c => c.id === msg.changelistId);
        if (!clForStash) break;
        const stashName = await vscode.window.showInputBox({
          title: t('Stash "{0}"', clForStash.name),
          value: clForStash.name,
          placeHolder: t('Stash message…'),
          validateInput: v => v.trim() ? undefined : t('Message cannot be empty'),
        });
        if (!stashName) break;
        for (const [repoId, paths] of Object.entries(clForStash.fileAssignments)) {
          if (paths.length === 0) continue;
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          if (repo.kind === 'svn') continue;
          try {
            const safePaths = paths.map(filePath => repo.resolveRepoPath(filePath).relativePath);
            await repo.stashPush(stashName.trim(), safePaths);
          } catch (e: unknown) {
            const repoName = this.manager.getRepoMeta(repoId)?.name ?? repoId;
            void showGitErrorMessage(t('VersionDock [{0}]: Stash failed: {1}', repoName, String(e)), {
              repoName,
              onUnlocked: async () => {
                const status = await this.manager.getAllStatusesFresh();
                this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
              },
            });
          }
        }
        const stashStatus = await this.manager.getAllStatusesFresh();
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status: stashStatus });
        this.postChangelistsUpdate(stashStatus);
        break;
      }

      case 'COMMIT_OPEN_ALL_CHANGES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        if (repo.kind === 'svn') {
          try {
            await this.openSvnAllChanges(repo, msg.section);
          } catch (e: unknown) {
            vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open SVN diff: {1}', repo.meta.name, String(e)));
          }
          break;
        }

        try {
          const repoUri = vscode.Uri.file(repo.rootPath);

          // Direct section shortcut (vscode view mode buttons)
          if (msg.section === 'staged') {
            await vscode.commands.executeCommand('git.viewStagedChanges', repoUri);
            return;
          }
          if (msg.section === 'unstaged') {
            await vscode.commands.executeCommand('git.viewChanges', repoUri);
            return;
          }

          const status = await repo.getStatus();
          const hasUnstaged  = status.unstagedFiles.filter((f: { status: string }) => f.status !== 'untracked').length > 0;
          const hasUntracked = status.unstagedFiles.filter((f: { status: string }) => f.status === 'untracked').length > 0;
          const hasStaged   = status.stagedFiles.length > 0;

          const options: vscode.QuickPickItem[] = [];
          if (hasUnstaged)  options.push({ label: `$(diff) ${t('Unstaged Changes')}`,  description: 'git.viewChanges' });
          if (hasUntracked) options.push({ label: `$(new-file) ${t('Untracked Files')}`, description: 'git.viewUntrackedChanges' });
          if (hasStaged)    options.push({ label: `$(diff-added) ${t('Staged Changes')}`, description: 'git.viewStagedChanges' });

          if (options.length === 0) return;

          if (options.length === 1) {
            await vscode.commands.executeCommand(options[0].description!, repoUri);
            return;
          }

          const picked = await vscode.window.showQuickPick(options, { placeHolder: t('Open changes…') });
          if (picked) {
            await vscode.commands.executeCommand(picked.description!, repoUri);
          }
        } catch { /* command unavailable */ }
        break;
      }

      case 'COMMIT_SET_FILE_VIEW_MODE': {
        await this.globalState?.update('fileViewMode', msg.mode);
        this.currentTabFileViewMode = msg.mode;
        this.updateViewAndExpandContext(msg.mode, this.currentTabIsCollapsed);
        break;
      }

      case 'COMMIT_HIDE_REPO': {
        await this.hideRepo(msg.repoId);
        break;
      }

      case 'COMMIT_UNHIDE_REPO': {
        await this.unhideRepo(msg.repoId);
        break;
      }

      case 'COMMIT_MANAGE_HIDDEN_REPOS': {
        await this.manageHiddenRepos();
        break;
      }

      case 'COMMIT_MANAGE_REPO': {
        await vscode.commands.executeCommand('versiondock.showBranchMenu', msg.repoId);
        break;
      }

      case 'COMMIT_VIEW_GIT_LOG': {
        const meta = this.manager.getRepoMetas().find(m => m.id === msg.repoId);
        let logRepoId = msg.repoId;
        let branch: string | undefined;
        if (meta?.isWorktree && meta.mainWorktreePath) {
          // Worktrees are not shown in the Log Panel — use the parent repo and filter by branch
          logRepoId = this.manager.getRepoMetas().find(candidate =>
            candidate.kind !== 'svn' && candidate.rootPath === meta.mainWorktreePath
          )?.id ?? msg.repoId;
          const status = await this.manager.getAllStatuses();
          const repoStatus = status.repos.find(r => r.repoId === msg.repoId);
          const branchName = repoStatus?.branch?.name;
          if (branchName && !repoStatus?.isDetachedHead) {
            branch = branchName;
          }
        }
        this.logProvider?.focusRepo(logRepoId, branch, this.replyTarget.getStore() ?? 'sidebar');
        break;
      }

      case 'SUBMODULE_PUSH': {
        const subRepoPush = this.manager.getRepo(msg.repoId);
        if (!subRepoPush) {
          this.post({ type: 'SUBMODULE_PUSH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Repo not found') });
          return;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Pushing submodule…', subRepoPush.meta.name), cancellable: false },
          async () => {
            try {
              await subRepoPush.pushSubmodule();
              this.post({ type: 'SUBMODULE_PUSH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
              this.logProvider?.refresh({ repoIds: [msg.repoId] });
            } catch (e: unknown) {
              this.post({ type: 'SUBMODULE_PUSH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: String(e) });
            }
          }
        );
        break;
      }

      case 'SUBMODULE_PULL': {
        const subRepoPull = this.manager.getRepo(msg.repoId);
        if (!subRepoPull) {
          this.post({ type: 'SUBMODULE_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: t('Repo not found') });
          return;
        }
        try {
          const output = await subRepoPull.pullSubmodule(msg.rebase);
          this.post({ type: 'SUBMODULE_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true, output });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'SUBMODULE_PULL_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: false, error: String(e) });
        }
        break;
      }

      case 'SUBMODULE_REQUEST_LIST': {
        try {
          const repos = await this.manager.getAllSubmodules();
          this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
        } catch (e: unknown) {
          this.post({ type: 'SUBMODULE_LIST_RESULT', repos: [], error: String(e) });
        }
        break;
      }

      case 'SUBMODULE_INIT': {
        const parentRepo = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepo || parentRepo.kind !== 'git') {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: false, error: t('Repo not found') });
          return;
        }
        const gitRepo = parentRepo as GitService;
        const configUrl = await gitRepo.getSubmoduleConfigUrl(msg.submodulePath);
        const parentRemoteUrl = await gitRepo.getDefaultRemoteUrl().catch(() => undefined);
        let allowFileProtocol = false;
        if (this.isLocalSubmoduleUrl(configUrl, parentRemoteUrl)) {
          const allowed = await this.confirmLocalSubmoduleProtocol(msg.submodulePath, configUrl, gitRepo.meta.name);
          if (!allowed) {
            this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: false, error: 'Cancelled' });
            return;
          }
          allowFileProtocol = true;
        }

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('VersionDock [{0}]: Initializing submodule "{1}"…', parentRepo.meta.name, path.basename(msg.submodulePath) || msg.submodulePath),
            cancellable: false,
          },
          async () => {
            try {
              try {
                await gitRepo.initSubmodule(msg.submodulePath, allowFileProtocol);
              } catch (initErr: unknown) {
                const initErrMsg = initErr instanceof Error ? initErr.message : String(initErr);
                if (!allowFileProtocol && (initErrMsg.includes("transport 'file' not allowed") || initErrMsg.includes('protocol.file.allow'))) {
                  const retryConfirm = await vscode.window.showWarningMessage(
                    t(
                      'VersionDock [{0}]: A nested submodule in "{1}" references a local path or file protocol. Do you want to allow local submodule operations and retry?',
                      parentRepo.meta.name,
                      path.basename(msg.submodulePath) || msg.submodulePath
                    ),
                    { modal: true },
                    t('Allow Local Submodule & Retry')
                  );
                  if (retryConfirm === t('Allow Local Submodule & Retry')) {
                    await gitRepo.initSubmodule(msg.submodulePath, true);
                  } else {
                    throw initErr;
                  }
                } else {
                  throw initErr;
                }
              }
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: true });
              this.manager.notifyDataInvalidated({
                scopes: ['workspace', 'workingTree', 'unpushed'],
                repoIds: [msg.parentRepoId],
              });
              this.manager.reinitializeAndRefresh();
              const repos = await this.manager.getAllSubmodules();
              this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
            } catch (e: unknown) {
              const errStr = e instanceof Error ? e.message : String(e);
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: false, error: errStr });
              void vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to initialize submodule "{1}" — {2}', parentRepo.meta.name, msg.submodulePath, errStr));
            }
          }
        );
        break;
      }

      case 'SUBMODULE_DEINIT': {
        const parentRepoD = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepoD) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: t('Repo not found') });
          return;
        }
        const confirmDeinit = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Deinit submodule "{1}"? The working directory will be cleared.', parentRepoD.meta.name, msg.submodulePath),
          { modal: true }, t('Deinit')
        );
        if (confirmDeinit !== t('Deinit')) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: 'Cancelled' });
          return;
        }
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: t('VersionDock [{0}]: Deinitializing submodule "{1}"…', parentRepoD.meta.name, path.basename(msg.submodulePath) || msg.submodulePath),
            cancellable: false,
          },
          async () => {
            try {
              try {
                await parentRepoD.deinitSubmodule(msg.submodulePath, msg.force);
              } catch (firstErr: unknown) {
                const errStr = String((firstErr as { message?: string })?.message || firstErr);
                if (!msg.force && (errStr.includes('local modifications') || errStr.includes('--force') || errStr.includes('-f'))) {
                  const forceChoice = await vscode.window.showWarningMessage(
                    t('VersionDock [{0}]: Submodule "{1}" has uncommitted changes or detached HEAD. Discard changes and force deinitialize?', parentRepoD.meta.name, msg.submodulePath),
                    { modal: true },
                    t('Force Deinitialize')
                  );
                  if (forceChoice === t('Force Deinitialize')) {
                    await parentRepoD.deinitSubmodule(msg.submodulePath, true);
                  } else {
                    throw firstErr;
                  }
                } else {
                  throw firstErr;
                }
              }
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: true });
              this.manager.notifyDataInvalidated({
                scopes: ['workspace', 'workingTree', 'unpushed', 'subtree'],
                repoIds: [msg.parentRepoId],
              });
              this.manager.reinitializeAndRefresh();
              const repos = await this.manager.getAllSubmodules();
              this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
            } catch (e: unknown) {
              const errMsg = e instanceof Error ? e.message : String(e);
              void vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to deinitialize submodule "{1}" — {2}', parentRepoD.meta.name, msg.submodulePath, errMsg));
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: errMsg });
            }
          }
        );
        break;
      }

      case 'SUBMODULE_UPDATE': {
        const parentRepoU = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepoU || parentRepoU.kind !== 'git') {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: false, error: t('Repo not found') });
          return;
        }
        const gitRepoU = parentRepoU as GitService;
        const configUrlU = await gitRepoU.getSubmoduleConfigUrl(msg.submodulePath);
        const parentRemoteUrlU = await gitRepoU.getDefaultRemoteUrl().catch(() => undefined);
        let allowFileProtocolU = false;
        if (this.isLocalSubmoduleUrl(configUrlU, parentRemoteUrlU)) {
          const allowed = await this.confirmLocalSubmoduleProtocol(msg.submodulePath, configUrlU, gitRepoU.meta.name);
          if (!allowed) {
            this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: false, error: 'Cancelled' });
            return;
          }
          allowFileProtocolU = true;
        }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Updating submodule "{1}"…', parentRepoU.meta.name, path.basename(msg.submodulePath) || msg.submodulePath), cancellable: false },
          async () => {
            try {
              try {
                await gitRepoU.updateSubmodule(msg.submodulePath, true, msg.recursive, msg.remote, allowFileProtocolU);
              } catch (updateErr: unknown) {
                const updateErrMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
                if (!allowFileProtocolU && (updateErrMsg.includes("transport 'file' not allowed") || updateErrMsg.includes('protocol.file.allow'))) {
                  const retryConfirm = await vscode.window.showWarningMessage(
                    t(
                      'VersionDock [{0}]: A nested submodule in "{1}" references a local path or file protocol. Do you want to allow local submodule operations and retry?',
                      parentRepoU.meta.name,
                      path.basename(msg.submodulePath) || msg.submodulePath
                    ),
                    { modal: true },
                    t('Allow Local Submodule & Retry')
                  );
                  if (retryConfirm === t('Allow Local Submodule & Retry')) {
                    await gitRepoU.updateSubmodule(msg.submodulePath, true, msg.recursive, msg.remote, true);
                  } else {
                    throw updateErr;
                  }
                } else {
                  throw updateErr;
                }
              }
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: true });
              this.manager.notifyDataInvalidated({
                scopes: ['workingTree', 'unpushed'],
                repoIds: [msg.parentRepoId],
              });
              const repos = await this.manager.getAllSubmodules();
              this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
            } catch (e: unknown) {
              const errMsg = e instanceof Error ? e.message : String(e);
              void vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to update submodule "{1}" — {2}', parentRepoU.meta.name, msg.submodulePath, errMsg));
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: false, error: errMsg });
            }
          }
        );
        break;
      }

      case 'SUBMODULE_UPDATE_ALL': {
        const reqId = Math.random().toString(36).slice(2);
        const singleParentMeta = msg.parentRepoId ? this.manager.getRepoMeta(msg.parentRepoId) : undefined;
        const progressTitle = singleParentMeta
          ? t('VersionDock [{0}]: Updating all submodules…', singleParentMeta.name)
          : t('VersionDock: Updating all submodules…');
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: progressTitle, cancellable: false },
          async () => {
            try {
              let parentRepos: GitService[] = [];
              if (msg.parentRepoId) {
                const targetRepo = this.manager.getRepo(msg.parentRepoId);
                if (targetRepo && targetRepo.kind === 'git') {
                  parentRepos = [targetRepo as GitService];
                } else {
                  throw new Error(t('Repository not found: {0}', msg.parentRepoId));
                }
              } else {
                parentRepos = this.manager.getRepoMetas()
                  .filter(m => {
                    if ((m.kind ?? 'git') !== 'git' || m.isWorktree) return false;
                    const hasGitmodules = fs.existsSync(path.join(m.rootPath, '.gitmodules'));
                    return hasGitmodules || (!m.isSubmodule && !m.parentRepoId);
                  })
                  .map(m => this.manager.getRepo(m.id))
                  .filter((r): r is GitService => !!r && r.kind === 'git');
              }

              let anyLocalSubmodule = false;
              for (const repo of parentRepos) {
                const parentRemote = await repo.getDefaultRemoteUrl().catch(() => undefined);
                const subs = await repo.getSubmoduleList().catch(() => []);
                for (const sub of subs) {
                  const url = (await repo.getSubmoduleConfigUrl(sub.path)) || sub.url;
                  if (this.isLocalSubmoduleUrl(url, parentRemote)) {
                    anyLocalSubmodule = true;
                    break;
                  }
                }
                if (anyLocalSubmodule) break;

                // 若包含递归更新，同时扫描当前已初始化的所有下级子模块的 .gitmodules 与本地 config
                if (msg.recursive ?? true) {
                  const nestedPaths = repo.collectSubmodulePathsRecursive(repo.rootPath);
                  for (const nPath of nestedPaths) {
                    const nGitmodules = path.join(nPath, '.gitmodules');
                    if (fs.existsSync(nGitmodules)) {
                      const nestedEntries = parseGitmodulesFileSync(nGitmodules);
                      for (const ne of nestedEntries) {
                        let neUrl = ne.url;
                        const nGitConfig = path.join(nPath, '.git', 'config');
                        if (fs.existsSync(nGitConfig)) {
                          try {
                            const confEntries = parseGitConfigEntries(fs.readFileSync(nGitConfig, 'utf8'));
                            const overrideUrl = confEntries.find(e => e.name === ne.name)?.url;
                            if (overrideUrl) neUrl = overrideUrl;
                          } catch {
                            // 忽略无法读取配置的异常
                          }
                        }
                        if (this.isLocalSubmoduleUrl(neUrl, parentRemote)) {
                          anyLocalSubmodule = true;
                          break;
                        }
                      }
                    }
                    if (anyLocalSubmodule) break;
                  }
                }
                if (anyLocalSubmodule) break;
              }

              let allowFileProtocolAll = false;
              if (anyLocalSubmodule) {
                const allowed = await this.confirmLocalSubmoduleProtocol(t('One or more submodules'), t('local path or file protocol'), singleParentMeta?.name);
                if (!allowed) {
                  this.post({ type: 'SUBMODULE_OP_RESULT', requestId: reqId, parentRepoId: msg.parentRepoId ?? '', submodulePath: '', op: 'update-all', ok: false, error: 'Cancelled' });
                  return;
                }
                allowFileProtocolAll = true;
              }

              const runUpdates = async (allowFile: boolean) => {
                for (const repo of parentRepos) {
                  await repo.updateAllSubmodules(msg.recursive ?? true, msg.init ?? true, allowFile);
                }
              };

              try {
                await runUpdates(allowFileProtocolAll);
              } catch (updateErr: unknown) {
                const updateErrMsg = updateErr instanceof Error ? updateErr.message : String(updateErr);
                if (!allowFileProtocolAll && (updateErrMsg.includes("transport 'file' not allowed") || updateErrMsg.includes('protocol.file.allow'))) {
                  const retryConfirm = await vscode.window.showWarningMessage(
                    singleParentMeta
                      ? t('VersionDock [{0}]: A nested submodule references a local path or file protocol. Do you want to allow local submodule operations and retry?', singleParentMeta.name)
                      : t('A nested submodule references a local path or file protocol. Do you want to allow local submodule operations and retry?'),
                    { modal: true },
                    t('Allow Local Submodule & Retry')
                  );
                  if (retryConfirm === t('Allow Local Submodule & Retry')) {
                    allowFileProtocolAll = true;
                    await runUpdates(true);
                  } else {
                    throw updateErr;
                  }
                } else {
                  throw updateErr;
                }
              }

              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: reqId, parentRepoId: msg.parentRepoId ?? '', submodulePath: '', op: 'update-all', ok: true });
              this.manager.notifyDataInvalidated({
                scopes: ['workingTree', 'unpushed'],
                repoIds: msg.parentRepoId ? [msg.parentRepoId] : undefined,
              });
              const repos = await this.manager.getAllSubmodules();
              this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
            } catch (e: unknown) {
              const errMsg = e instanceof Error ? e.message : String(e);
              let userFriendlyMsg = singleParentMeta
                ? t('VersionDock [{0}]: Failed to update all submodules: {1}', singleParentMeta.name, errMsg)
                : t('VersionDock: Failed to update all submodules: {0}', errMsg);
              if (errMsg.includes("transport 'file' not allowed") || errMsg.includes('protocol.file.allow')) {
                userFriendlyMsg = singleParentMeta
                  ? t(
                      'VersionDock [{0}]: A nested submodule references a local path or file protocol which requires authorization. Please run submodule update with local protocol permission allowed.',
                      singleParentMeta.name
                    )
                  : t(
                      'VersionDock: A nested submodule references a local path or file protocol which requires authorization. Please run submodule update with local protocol permission allowed.'
                    );
              }
              void vscode.window.showErrorMessage(userFriendlyMsg);
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: reqId, parentRepoId: msg.parentRepoId ?? '', submodulePath: '', op: 'update-all', ok: false, error: userFriendlyMsg });
            }
          }
        );
        break;
      }

      case 'SUBMODULE_ADD_PROMPT': {
        let parentRepoId = msg.repoId;
        const candidateMetas = this.manager.getRepoMetas().filter(m => (m.kind ?? 'git') === 'git' && !m.isSubmodule && !m.isWorktree);
        if (candidateMetas.length === 0) {
          vscode.window.showWarningMessage(t('VersionDock: No suitable Git repository found for adding a submodule.'));
          return;
        }
        if (!parentRepoId) {
          if (candidateMetas.length === 1) {
            parentRepoId = candidateMetas[0].id;
          } else {
            const picked = await vscode.window.showQuickPick(
              candidateMetas.map(m => ({ label: m.name, description: m.rootPath, id: m.id })),
              { title: t('Select Parent Repository'), placeHolder: t('Choose parent repository to add submodule into…') }
            );
            if (!picked) return;
            parentRepoId = picked.id;
          }
        }
        const parentRepoA = this.manager.getRepo(parentRepoId);
        if (!parentRepoA) return;

        const url = await vscode.window.showInputBox({
          title: t('Add Submodule (1/3): Repository URL'),
          prompt: t('Enter Git repository URL (e.g., https://github.com/org/repo.git)'),
          placeHolder: 'https://github.com/example/repo.git',
          validateInput: val => (!val || !val.trim() ? t('URL is required') : null),
        });
        if (!url || !url.trim()) return;

        let defaultPath = '';
        const cleanUrl = url.trim().replace(/\.git$/, '');
        const lastSlash = Math.max(cleanUrl.lastIndexOf('/'), cleanUrl.lastIndexOf(':'));
        if (lastSlash >= 0) {
          defaultPath = cleanUrl.slice(lastSlash + 1);
        }

        const subPath = await vscode.window.showInputBox({
          title: t('Add Submodule (2/3): Local Path'),
          prompt: t('Enter relative path inside the parent repository'),
          value: defaultPath,
          validateInput: val => (!val || !val.trim() ? t('Path is required') : null),
        });
        if (!subPath || !subPath.trim()) return;

        const branch = await vscode.window.showInputBox({
          title: t('Add Submodule (3/3): Branch (Optional)'),
          prompt: t('Enter branch to track, or leave empty for default remote branch'),
          placeHolder: t('Leave empty for default branch'),
        });
        if (branch === undefined) return;

        let allowFileProtocol = false;
        const trimmedUrl = url.trim();
        const parentRepoName = this.manager.getRepoMeta(parentRepoId)?.name || path.basename(parentRepoA.rootPath) || parentRepoId;
        const parentRemoteUrl = await (parentRepoA as GitService).getDefaultRemoteUrl().catch(() => undefined);
        if (this.isLocalSubmoduleUrl(trimmedUrl, parentRemoteUrl)) {
          const allowed = await this.confirmLocalSubmoduleProtocol(subPath.trim() || trimmedUrl, trimmedUrl, parentRepoName);
          if (!allowed) return;
          allowFileProtocol = true;
        }
        const reqId = Math.random().toString(36).slice(2);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Adding submodule {1}', parentRepoName, subPath), cancellable: false },
          async () => {
            try {
              await (parentRepoA as GitService).addSubmodule(url.trim(), subPath.trim(), branch?.trim() || undefined, allowFileProtocol);
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: reqId, parentRepoId, submodulePath: subPath.trim(), op: 'add', ok: true });
              this.manager.notifyDataInvalidated({
                scopes: ['workspace', 'workingTree', 'unpushed', 'subtree'],
                repoIds: [parentRepoId],
              });
              const repos = await this.manager.getAllSubmodules();
              this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
              vscode.window.showInformationMessage(t('VersionDock [{0}]: Submodule "{1}" added successfully.', parentRepoName, subPath.trim()));
            } catch (e: unknown) {
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: reqId, parentRepoId, submodulePath: subPath.trim(), op: 'add', ok: false, error: String(e) });
              vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to add submodule: {1}', parentRepoName, String(e)));
            }
          }
        );
        break;
      }

      case 'SUBMODULE_SYNC': {
        const parentRepoS = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepoS || parentRepoS.kind !== 'git') {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath ?? '', op: 'sync', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await (parentRepoS as GitService).syncSubmodule(msg.submodulePath);
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath ?? '', op: 'sync', ok: true });
          const repos = await this.manager.getAllSubmodules();
          this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
        } catch (e: unknown) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath ?? '', op: 'sync', ok: false, error: String(e) });
        }
        break;
      }

      case 'SUBMODULE_REMOVE': {
        const parentRepoR = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepoR || parentRepoR.kind !== 'git') {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'remove', ok: false, error: t('Repo not found') });
          return;
        }

        // 探测子模块是否有未提交修改或未推送提交风险
        let riskWarning = '';
        try {
          const allSubs = await this.manager.getAllSubmodules(true);
          const pGroup = allSubs.find(g => g.repoId === msg.parentRepoId);
          const targetSub = pGroup?.submodules.find(s => s.path === msg.submodulePath);
          if (targetSub) {
            const risks: string[] = [];
            if (targetSub.isDirty) risks.push(t('uncommitted local changes'));
            if ((targetSub.unpushedCount ?? 0) > 0) risks.push(t('{0} unpushed commits', targetSub.unpushedCount ?? 0));
            if (risks.length > 0) {
              riskWarning = ' ' + t('WARNING: Submodule has {0}. Removing will permanently delete these modifications!', risks.join(' & '));
            }
          }
        } catch {
          // ignore risk detection failure
        }

        const confirmRemove = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Remove submodule "{1}"? This will deinitialize, unregister from .gitmodules, and delete its files.{2}', parentRepoR.meta.name, msg.submodulePath, riskWarning),
          { modal: true }, t('Remove Submodule')
        );
        if (confirmRemove !== t('Remove Submodule')) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'remove', ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await (parentRepoR as GitService).removeSubmodule(msg.submodulePath);
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'remove', ok: true });
          this.manager.notifyDataInvalidated({
            scopes: ['workspace', 'workingTree', 'unpushed', 'subtree'],
            repoIds: [msg.parentRepoId],
          });
          const repos = await this.manager.getAllSubmodules();
          this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
        } catch (e: unknown) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'remove', ok: false, error: String(e) });
        }
        break;
      }

      case 'SUBMODULE_RESOLVE_CONFLICT': {
        const parentRepo = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepo || parentRepo.kind !== 'git') {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'resolve-conflict', ok: false, error: t('Repo not found') });
          return;
        }
        const gitRepo = parentRepo as GitService;
        try {
          const isDeleteSide = await gitRepo.isSubmoduleConflictDeleteSide(msg.submodulePath, msg.side);
          let removeDirectory = false;
          let force = false;
          if (isDeleteSide) {
            const isDirty = await gitRepo.isSubmoduleDirty(msg.submodulePath).catch(() => false);
            if (isDirty) {
              const dirtyChoice = await vscode.window.showWarningMessage(
                t(
                  'VersionDock [{0}]: WARNING: Submodule "{1}" has uncommitted local changes or unpushed commits. Deleting the directory will permanently discard these changes! Do you want to proceed?',
                  gitRepo.meta.name,
                  path.basename(msg.submodulePath) || msg.submodulePath
                ),
                { modal: true },
                t('Force Delete Directory'),
                t('Keep Local Directory')
              );
              if (!dirtyChoice) {
                this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'resolve-conflict', ok: false, error: 'Cancelled' });
                return;
              }
              if (dirtyChoice === t('Force Delete Directory')) {
                removeDirectory = true;
                force = true;
              } else {
                removeDirectory = false;
              }
            } else {
              const choice = await vscode.window.showWarningMessage(
                t(
                  'VersionDock [{0}]: Submodule "{1}" was removed on the selected side. Do you also want to remove its local directory and Git metadata from disk?',
                  gitRepo.meta.name,
                  path.basename(msg.submodulePath) || msg.submodulePath
                ),
                { modal: true },
                t('Remove Directory & Metadata'),
                t('Keep Local Directory')
              );
              if (!choice) {
                this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'resolve-conflict', ok: false, error: 'Cancelled' });
                return;
              }
              removeDirectory = choice === t('Remove Directory & Metadata');
            }
          }

          const resolveRes = await gitRepo.resolveSubmoduleConflict(msg.submodulePath, msg.side, { removeDirectory, force });
          if (resolveRes?.cleanupWarning) {
            void vscode.window.showWarningMessage(
              t('VersionDock [{0}]: Submodule conflict resolved in Git, but failed to clean up directory on disk: {1}', gitRepo.meta.name, resolveRes.cleanupWarning)
            );
          }
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'resolve-conflict', ok: true });
          this.manager.notifyDataInvalidated({
            scopes: ['workingTree', 'workspace'],
            repoIds: [msg.parentRepoId],
          });
          const repos = await this.manager.getAllSubmodules();
          this.post({ type: 'SUBMODULE_LIST_RESULT', repos });
        } catch (e: unknown) {
          const errMsg = e instanceof Error ? e.message : String(e);
          void vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to resolve submodule conflict — {1}', gitRepo.meta.name, errMsg));
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'resolve-conflict', ok: false, error: errMsg });
        }
        break;
      }

      case 'SUBMODULE_OPEN_CONFLICT': {
        const parentRepo = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepo || parentRepo.kind !== 'git') {
          return;
        }
        const gitRepo = parentRepo as GitService;
        const targetPath = msg.companionPath || msg.submodulePath;
        try {
          const resolved = gitRepo.resolveRepoPath(targetPath);
          if (this.mergeEditorProvider) {
            this.mergeEditorProvider.openForFile(resolved.absolutePath, msg.parentRepoId, resolved.relativePath);
          } else {
            void vscode.commands.executeCommand('vscode.open', vscode.Uri.file(resolved.absolutePath));
          }
        } catch (err) {
          void vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to open conflict in editor: {1}', gitRepo.meta.name, String(err)));
        }
        break;
      }

      case 'SUBMODULE_GET_DIFF_SUMMARY': {
        const parentRepo = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepo || parentRepo.kind !== 'git') {
          this.post({ type: 'SUBMODULE_DIFF_SUMMARY_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, error: t('Repo not found') });
          return;
        }
        try {
          const diffSummary = await (parentRepo as GitService).getSubmoduleDiffSummary(msg.submodulePath);
          this.post({
            type: 'SUBMODULE_DIFF_SUMMARY_RESULT',
            requestId: msg.requestId,
            parentRepoId: msg.parentRepoId,
            submodulePath: msg.submodulePath,
            oldHash: diffSummary.oldHash,
            newHash: diffSummary.newHash,
            parentCommit: diffSummary.parentCommit,
            indexCommit: diffSummary.indexCommit,
            headCommit: diffSummary.headCommit,
            summary: diffSummary.summary,
          });
        } catch (e: unknown) {
          this.post({ type: 'SUBMODULE_DIFF_SUMMARY_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, error: String(e) });
        }
        break;
      }

      case 'WORKTREE_REQUEST_LIST': {
        const repos = await this.manager.getAllWorktrees();
        this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        break;
      }

      case 'WORKTREE_CREATE_PROMPT': {
        const repoCP = this.manager.getRepo(msg.repoId);
        if (!repoCP) return;

        // Step 1: pick branch or "new branch"
        const branches = await repoCP.getBranches();
        const NEW_BRANCH_ID = '__new__';
        const branchItems: Array<{ label: string; description?: string; branchName: string; isNew?: boolean }> = [
          { label: `$(add) ${t('Create new branch…')}`, branchName: NEW_BRANCH_ID, isNew: true },
          ...branches.map(b => ({
            label: b.isRemote ? `$(cloud) ${b.name}` : `$(git-branch) ${b.name}`,
            description: b.isHead ? t('(current)') : undefined,
            branchName: b.name,
          })),
        ];
        const picked = await vscode.window.showQuickPick(branchItems, {
          placeHolder: t('Select branch for new worktree'),
          title: t('New Worktree — Branch'),
          matchOnDescription: true,
        });
        if (!picked) return;

        // If "new branch" chosen, ask for the name
        let newBranchName: string | undefined;
        let baseBranchName = picked.branchName;
        if (picked.isNew) {
          const input = await vscode.window.showInputBox({
            prompt: t('New branch name'),
            placeHolder: t('e.g. feature/my-feature'),
            title: t('New Worktree — New Branch Name'),
          });
          if (!input?.trim()) return;
          newBranchName = input.trim();
          baseBranchName = newBranchName;
        }

        // Step 2: worktree path — format: <repo-folder-name>--<branch-name>
        const repoParent = path.dirname(repoCP.rootPath);
        const repoFolderName = path.basename(repoCP.rootPath);
        const defaultPath = path.join(repoParent, `${repoFolderName}--${baseBranchName.replace(/\//g, '-')}`);
        const worktreePath = await vscode.window.showInputBox({
          prompt: t('Path for the new worktree directory'),
          value: defaultPath,
          title: t('New Worktree — Directory Path'),
        });
        if (!worktreePath?.trim()) return;

        const repoName = this.manager.getRepoMeta(repoCP.repoId)?.name || repoFolderName;
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Creating worktree…', repoName), cancellable: false },
            async () => {
              await repoCP.createWorktree(worktreePath.trim(), {
                branch: picked.isNew ? undefined : picked.branchName,
                newBranch: newBranchName,
              });
            }
          );
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Worktree created at {1}', repoName, worktreePath.trim()));
        } catch (e: unknown) {
          void showGitErrorMessage(t('VersionDock [{0}]: Failed to create worktree — {1}', repoName, String(e)), {
            repoName,
            onUnlocked: async () => {
              const status = await this.manager.getAllStatusesFresh();
              this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            },
          });
        }
        break;
      }

      case 'WORKTREE_CREATE': {
        const repoWC = this.manager.getRepo(msg.repoId);
        if (!repoWC) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'create', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await repoWC.createWorktree(msg.worktreePath, { branch: msg.branch, newBranch: msg.newBranch, commitish: msg.commitish, noTrack: msg.noTrack });
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'create', ok: true });
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'create', ok: false, error: String(e) });
        }
        break;
      }

      case 'WORKTREE_DELETE': {
        const repoWD = this.manager.getRepo(msg.repoId);
        if (!repoWD) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'delete', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await repoWD.deleteWorktree(msg.worktreePath, msg.force);
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'delete', ok: true });
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'delete', ok: false, error: String(e) });
        }
        break;
      }

      case 'WORKTREE_PRUNE': {
        const repoWP = this.manager.getRepo(msg.repoId);
        if (!repoWP) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'prune', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await repoWP.pruneWorktrees();
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'prune', ok: true });
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'prune', ok: false, error: String(e) });
        }
        break;
      }

      case 'WORKTREE_LOCK': {
        const repoWL = this.manager.getRepo(msg.repoId);
        if (!repoWL) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'lock', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await repoWL.lockWorktree(msg.worktreePath, msg.reason);
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'lock', ok: true });
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'lock', ok: false, error: String(e) });
        }
        break;
      }

      case 'WORKTREE_UNLOCK': {
        const repoWU = this.manager.getRepo(msg.repoId);
        if (!repoWU) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'unlock', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await repoWU.unlockWorktree(msg.worktreePath);
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'unlock', ok: true });
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
        } catch (e: unknown) {
          this.post({ type: 'WORKTREE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'unlock', ok: false, error: String(e) });
        }
        break;
      }

      case 'WORKTREE_OPEN_IN_EXPLORER': {
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(msg.worktreePath));
        break;
      }

      case 'WORKTREE_OPEN_IN_NEW_WINDOW': {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(msg.worktreePath), { forceNewWindow: true });
        break;
      }

      case 'WORKTREE_OPEN_IN_OS': {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.worktreePath));
        break;
      }

      case 'WORKTREE_ADD_TO_WORKSPACE': {
        const uri = vscode.Uri.file(msg.worktreePath);
        const folders = vscode.workspace.workspaceFolders ?? [];
        vscode.workspace.updateWorkspaceFolders(folders.length, 0, { uri });
        break;
      }

      case 'SUBTREE_REQUEST_LIST': {
        this.postSubtreeList({
          notifyStatusUpdates: Boolean(msg.checkStatuses),
          skipStatuses: !msg.checkStatuses,
          force: Boolean(msg.force),
        });
        break;
      }

      case 'SUBTREE_ADD_PROMPT': {
        await this.createSubtreeFromPrompt(msg.repoId);
        break;
      }

      case 'SUBTREE_REGISTER_PROMPT': {
        await this.registerSubtreeFromPrompt(msg.repoId);
        break;
      }

      case 'SUBTREE_EDIT_PROMPT': {
        await this.editSubtreeFromPrompt(msg.entryId);
        break;
      }

      case 'SUBTREE_DELETE_REGISTRY': {
        const entry = this.findSubtreeEntry(msg.entryId);
        if (!entry) {
          const error = t('Subtree entry not found.');
          vscode.window.showErrorMessage(t('VersionDock: {0}', error));
          this.post({
            type: 'SUBTREE_OP_RESULT',
            requestId: msg.requestId,
            repoId: '',
            entryId: msg.entryId,
            op: 'delete',
            ok: false,
            error,
          });
          break;
        }
        const repoMeta = this.manager.getRepoMeta(entry.repoId);
        const confirm = await vscode.window.showWarningMessage(
          repoMeta
            ? t('VersionDock [{0}]: Delete registry for subtree "{1}" at prefix "{2}"? This only removes the saved association and does not delete files.', repoMeta.name, entry.name, entry.prefix)
            : t('Delete registry for subtree "{0}" at prefix "{1}"? This only removes the saved association and does not delete files.', entry.name, entry.prefix),
          { modal: true },
          t('Delete Registry'),
        );
        if (confirm !== t('Delete Registry')) {
          this.post({
            type: 'SUBTREE_OP_RESULT',
            requestId: msg.requestId,
            repoId: entry.repoId,
            entryId: msg.entryId,
            op: 'delete',
            ok: false,
            error: 'Cancelled',
          });
          break;
        }
        const repoName = this.manager.getRepoMeta(entry.repoId)?.name || entry.repoId;
        await this.removeSubtreeEntry(msg.entryId);
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Subtree "{1}" registry deleted.', repoName, entry.name));
        this.post({
          type: 'SUBTREE_OP_RESULT',
          requestId: msg.requestId,
          repoId: entry.repoId,
          entryId: msg.entryId,
          op: 'delete',
          ok: true,
        });
        break;
      }

      case 'SUBTREE_PULL': {
        await this.runSubtreeEntryOp(msg.requestId, msg.entryId, 'pull');
        break;
      }

      case 'SUBTREE_PUSH': {
        await this.runSubtreeEntryOp(msg.requestId, msg.entryId, 'push');
        break;
      }

      case 'SUBTREE_REMOVE': {
        await this.runSubtreeEntryOp(msg.requestId, msg.entryId, 'remove');
        break;
      }

      case 'SUBTREE_SPLIT_PROMPT': {
        await this.splitSubtreeFromPrompt(msg.requestId, msg.entryId);
        break;
      }

      case 'SUBTREE_MERGE_PROMPT': {
        await this.mergeSubtreeFromPrompt(msg.requestId, msg.entryId);
        break;
      }

      case 'SUBTREE_REVEAL_PREFIX': {
        const entry = this.findSubtreeEntry(msg.entryId);
        if (!entry) return;
        const repo = this.manager.getRepo(entry.repoId);
        if (!repo) return;
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(repo.resolveRepoPath(entry.prefix).absolutePath));
        break;
      }

      case 'NOTIFY_ERROR': {
        const repoName = msg.repoId ? (this.manager.getRepoMeta(msg.repoId)?.name ?? msg.repoId) : undefined;
        void showGitErrorMessage(msg.message, {
          repoName,
          onUnlocked: async () => {
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          },
        });
        break;
      }

      case 'NOTIFY_INFO': {
        const repoName = msg.repoId ? (this.manager.getRepoMeta(msg.repoId)?.name ?? msg.repoId) : undefined;
        if (repoName) {
          vscode.window.showInformationMessage(t('VersionDock [{0}]: {1}', repoName, msg.message));
        } else {
          vscode.window.showInformationMessage(t('VersionDock: {0}', msg.message));
        }
        break;
      }

      case 'COMMIT_INIT_REPO': {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) break;
        await vscode.commands.executeCommand('git.init', folder.uri);
        await new Promise(r => setTimeout(r, 500));
        this.manager.reinitializeAndRefresh();
        this.logProvider?.refresh();
        break;
      }

      case 'COMMIT_OPEN_FOLDER':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;

      case 'COMMIT_CLONE_REPO':
        await vscode.commands.executeCommand('git.clone');
        break;

      case 'COMMIT_REVEAL_IN_EXPLORER': {
        const repoRE = this.manager.getRepo(msg.repoId);
        if (!repoRE) return;
        const resolvedPath = repoRE.resolveRepoPath(msg.filePath);
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(resolvedPath.absolutePath));
        break;
      }

      case 'COMMIT_REVEAL_IN_OS': {
        const repoOS = this.manager.getRepo(msg.repoId);
        if (!repoOS) return;
        const resolvedPath = repoOS.resolveRepoPath(msg.filePath);
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(resolvedPath.absolutePath));
        break;
      }
    }
  }

  handleSubmoduleCommand(msg: import('../types/messages').CommitToHostMsg): void {
    void this.handleMessage(msg);
  }

  private async checkUnpushedSubmodules(repoId: string): Promise<boolean> {
    try {
      const allSubs = await this.manager.getAllSubmodules(true);
      // 收集当前仓库直接与间接下属的所有包含未推送提交的子模块
      const unpushedSubs: import('../types/git').SubmoduleItem[] = [];
      const queue = [repoId];
      const visited = new Set<string>();

      while (queue.length > 0) {
        const curId = queue.shift()!;
        if (visited.has(curId)) continue;
        visited.add(curId);

        const targetGitId = curId.endsWith('::git') ? curId : buildRepoId(curId, 'git');
        const parentGroup = allSubs.find(g => g.repoId === curId || g.repoId === targetGitId);
        if (!parentGroup) continue;

        for (const sub of parentGroup.submodules) {
          if ((sub.unpushedCount ?? 0) > 0) {
            unpushedSubs.push(sub);
          }
          if (sub.repoId && !visited.has(sub.repoId)) {
            queue.push(sub.repoId);
          }
        }
      }

      if (unpushedSubs.length > 0) {
        const repoMeta = this.manager.getRepoMeta(repoId);
        const repoName = repoMeta?.name || repoId;
        const subNames = unpushedSubs.map(s => `${s.name} (${s.unpushedCount} ${t('unpushed')})`).join(', ');
        const choice = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Submodules have unpushed commits: {1}. Pushing the parent repository now may cause CI or teammate build failures. Do you want to continue pushing?', repoName, subNames),
          { modal: true },
          t('Push Anyway')
        );
        return choice === t('Push Anyway');
      }
    } catch {
      // ignore submodule detection error
    }
    return true;
  }

  private isLocalSubmoduleUrl(url?: string, parentRemoteUrl?: string): boolean {
    const trimmedUrl = url?.trim();
    if (!trimmedUrl) return false;

    if (trimmedUrl.startsWith('file://') || path.isAbsolute(trimmedUrl)) {
      return true;
    }

    if (trimmedUrl.startsWith('./') || trimmedUrl.startsWith('../')) {
      // 若父仓库配置了远程网络 URL（如 https://, http://, ssh://, git:// 或 scp 格式 git@...），
      // Git 在解析相对 submodule url 时会相对于该网络 remote 解析为远程网络地址，而非本地 file 协议。
      if (parentRemoteUrl) {
        const trimmedParent = parentRemoteUrl.trim();
        const isNetworkRemote = /^(https?|ssh|git):\/\//i.test(trimmedParent) || /^[\w.-]+@[\w.-]+:/i.test(trimmedParent);
        if (isNetworkRemote) {
          return false;
        }
      }
      return true;
    }

    return false;
  }

  private async confirmLocalSubmoduleProtocol(submoduleNameOrPath: string, url?: string, parentRepoName?: string): Promise<boolean> {
    const trimmedUrl = url?.trim() || '';
    const message = parentRepoName
      ? t(
          'VersionDock [{0}]: The submodule "{1}" references a local path or file protocol ("{2}"). Git restricts local submodule operations by default to prevent unauthorized repository access. Do you want to allow this local submodule operation?',
          parentRepoName,
          submoduleNameOrPath,
          trimmedUrl
        )
      : t(
          'VersionDock: The submodule "{0}" references a local path or file protocol ("{1}"). Git restricts local submodule operations by default to prevent unauthorized repository access. Do you want to allow this local submodule operation?',
          submoduleNameOrPath,
          trimmedUrl
        );
    const confirm = await vscode.window.showWarningMessage(
      message,
      { modal: true },
      t('Allow Local Submodule')
    );
    return confirm === t('Allow Local Submodule');
  }

  async handleSubtreeCommand(op: 'add' | 'pull' | 'push' | 'split' | 'merge' | 'remove' | 'manage'): Promise<void> {
    if (op === 'manage') {
      const message: HostToCommitMsg = { type: 'COMMIT_SET_ACTIVE_TAB', tab: 'subtree' };
      this.postSidebarWhenReady(message);
      try {
        await this.focus();
      } catch (error) {
        this.removePendingSidebarMessage(message);
        throw error;
      }
      this.postSubtreeList({ notifyStatusUpdates: true });
      return;
    }
    if (op === 'add') {
      await this.createSubtreeFromPrompt();
      return;
    }

    const entry = await this.pickSubtreeEntry(t('Select Subtree'));
    if (!entry) return;
    const requestId = Math.random().toString(36).slice(2);
    if (op === 'pull' || op === 'push' || op === 'remove') {
      await this.runSubtreeEntryOp(requestId, entry.id, op);
      return;
    }
    if (op === 'split') {
      await this.splitSubtreeFromPrompt(requestId, entry.id);
      return;
    }
    await this.mergeSubtreeFromPrompt(requestId, entry.id);
  }

  isSubtreeTabActive(): boolean {
    return this.activeTab === 'subtree';
  }

  async refresh(options: { refreshSubtrees?: boolean } = {}): Promise<void> {
    this.post({ type: 'COMMIT_REFRESH_START' });
    const refreshSubtrees = Boolean(options.refreshSubtrees ?? this.isSubtreeTabActive());
    if (refreshSubtrees) {
      const entries = this.getSubtreeEntries();
      const initialStatuses: Record<string, SubtreePushStatus> = {};
      for (const entry of entries) {
        initialStatuses[entry.id] = { loading: true };
      }
      this.post({ type: 'SUBTREE_STATUS_RESULT', statuses: initialStatuses });
    }
    await vscode.window.withProgress(
      { location: { viewId: CommitPanelProvider.viewType } },
      async () => {
        await Promise.all([
          this.postCommitStatusUpdate({ fresh: true, ...options, refreshSubtrees: false }),
          refreshSubtrees ? this.refreshSubtreeList({ force: true }) : Promise.resolve(),
        ]);
      }
    );
  }

  async validateCommitSafety(repo: GitService, selectedFilePaths?: string[]): Promise<boolean> {
    if (repo.kind === 'svn') return true;

    // 1. Detached HEAD or Rebase in progress pre-flight check
    const warnDetached = vscode.workspace.getConfiguration('versiondock').get<boolean>('guard.warnOnDetachedHead', true);
    if (warnDetached) {
      const current = await repo.getCurrentBranch().catch(() => undefined);
      const isDetached = current && (current.name === 'HEAD' || Boolean(current.detachedTag) || Boolean(current.detachedHash));
      const opState = await repo.getOperationState().catch(() => null);

      if (isDetached) {
        const createBranchAndCommit = t('Create Branch & Commit');
        const commitAnyway = t('Commit Anyway');
        const warningMessage = t('VersionDock [{0}] Warning: You are committing to a detached HEAD. To keep these changes safe on a branch, create a branch now or commit anyway.', repo.meta.name);
        const choice = await vscode.window.showWarningMessage(
          warningMessage,
          { modal: true },
          createBranchAndCommit,
          commitAnyway,
        );
        if (!choice) return false;
        if (choice === createBranchAndCommit) {
          const defaultCleanChar = getBranchCleanCharacter();
          const newBranchInput = await vscode.window.showInputBox({
            title: t('Create Branch & Commit'),
            prompt: t('Enter new branch name'),
            validateInput: v => validateBranchNameInput(v, defaultCleanChar),
          });
          if (!newBranchInput || !newBranchInput.trim()) return false;
          const sanitizedBranch = sanitizeBranchName(newBranchInput.trim(), defaultCleanChar);
          try {
            await repo.checkout(sanitizedBranch, true);
            this.manager.notifyBranchesChanged();
            this.logProvider?.refresh({ repoIds: [repo.repoId], forceRemoteRefs: true });
          } catch (e) {
            vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to create branch: {1}', repo.meta.name, String(e)));
            return false;
          }
        }
      } else if (opState === 'rebase') {
        const commitAnyway = t('Commit Anyway');
        const warningMessage = t('VersionDock [{0}] Warning: A rebase operation is currently in progress. Do you want to commit anyway?', repo.meta.name);
        const choice = await vscode.window.showWarningMessage(
          warningMessage,
          { modal: true },
          commitAnyway,
        );
        if (choice !== commitAnyway) return false;
      }
    }

    // 2. File issues pre-flight check
    let filesToCheck = selectedFilePaths;
    if (!filesToCheck || filesToCheck.length === 0) {
      const status = await repo.getStatus().catch(() => undefined);
      if (!status) return true;
      filesToCheck = status.stagedFiles.map(f => f.path);
      if (filesToCheck.length === 0) {
        filesToCheck = status.unstagedFiles.map(f => f.path);
      }
    }
    if (!filesToCheck || filesToCheck.length === 0) return true;

    const safetyResult = checkCommitSafety(repo.rootPath, filesToCheck);
    if (!safetyResult.hasIssues) return true;

    const details: string[] = [];
    if (safetyResult.sensitiveFiles.length > 0) {
      details.push(t('Sensitive files: {0}', safetyResult.sensitiveFiles.join(', ')));
    }
    if (safetyResult.largeFiles.length > 0) {
      const list = safetyResult.largeFiles.map(f => `${f.path} (${f.sizeFormatted})`).join(', ');
      details.push(t('Large files: {0}', list));
    }
    if (safetyResult.invalidFileNameFiles.length > 0) {
      const list = safetyResult.invalidFileNameFiles.map(f => `${f.path} (${f.reason})`).join(', ');
      details.push(t('Incompatible / invalid file names: {0}', list));
    }
    if (safetyResult.crlfFiles.length > 0) {
      const list = safetyResult.crlfFiles.slice(0, 5).join(', ') + (safetyResult.crlfFiles.length > 5 ? ` (+${safetyResult.crlfFiles.length - 5})` : '');
      details.push(t('CRLF line separators: {0}', list));
    }

    const warningMessage = t(
      'VersionDock [{0}] Warning: The commit contains potential issues:\n{1}\nDo you want to commit anyway?',
      repo.meta.name,
      details.join('\n')
    );
    const commitAnyway = t('Commit Anyway');
    const choice = await vscode.window.showWarningMessage(warningMessage, { modal: true }, commitAnyway);
    return choice === commitAnyway;
  }

  async notifyDetachedHeadCommitIfApplicable(repo: GitService): Promise<void> {
    if (repo.kind === 'svn') return;
    const current = await repo.getCurrentBranch().catch(() => undefined);
    if (!current) return;
    const isDetached = current.name === 'HEAD' || Boolean(current.detachedTag) || Boolean(current.detachedHash);
    if (!isDetached) return;

    const repoName = this.manager.getRepoMeta(repo.repoId)?.name || path.basename(repo.rootPath);
    const createBranchLabel = t('Create Branch');
    const msg = t('VersionDock [{0}]: You have committed to a detached HEAD. Create a new branch to keep these changes?', repoName);
    void vscode.window.showWarningMessage(msg, createBranchLabel, t('Dismiss')).then(async choice => {
      if (choice === createBranchLabel) {
        const newBranchName = await vscode.window.showInputBox({
          title: t('Create Branch from Current Commit'),
          prompt: t('Enter new branch name'),
          validateInput: v => (v.trim() ? undefined : t('Branch name cannot be empty')),
        });
        if (newBranchName && newBranchName.trim()) {
          try {
            await repo.checkout(newBranchName.trim(), true);
            this.manager.notifyBranchesChanged();
            this.logProvider?.refresh({ repoIds: [repo.repoId], forceRemoteRefs: true });
            vscode.window.showInformationMessage(t('VersionDock [{0}]: Branch "{1}" created.', repoName, newBranchName.trim()));
          } catch (e) {
            vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to create branch: {1}', repoName, String(e)));
          }
        }
      }
    });
  }

  async notifyPushSuccess(repo: GitService, branchName?: string, remoteName?: string): Promise<void> {
    if (repo.kind === 'svn') return;
    const targetBranch = branchName ?? (await repo.getCurrentBranch().catch(() => undefined))?.name;
    if (!targetBranch || targetBranch === 'HEAD') return;

    const remotes = await repo.getRemotesWithUrls().catch(() => []);
    const matchingRemote = remoteName ? remotes.find(r => r.name === remoteName) : remotes[0];
    const remoteUrl = matchingRemote?.pushUrl || matchingRemote?.fetchUrl || '';
    const prInfo = remoteUrl ? buildPullRequestUrl(remoteUrl, targetBranch) : undefined;
    const repoName = this.manager.getRepoMeta(repo.repoId)?.name || path.basename(repo.rootPath);

    if (prInfo) {
      const createPrLabel = t('Create Pull Request');
      const msg = t('VersionDock [{0}]: Branch "{1}" pushed to {2}.', repoName, targetBranch, prInfo.platform);
      void vscode.window.showInformationMessage(msg, createPrLabel, t('Dismiss')).then(choice => {
        if (choice === createPrLabel) {
          void vscode.env.openExternal(vscode.Uri.parse(prInfo.url));
        }
      });
    } else {
      const remoteLabel = remoteName ?? matchingRemote?.name ?? 'remote';
      const msg = t('VersionDock [{0}]: Branch "{1}" pushed successfully to "{2}".', repoName, targetBranch, remoteLabel);
      void vscode.window.showInformationMessage(msg);
    }
  }

  private async resolveEffectivePullStrategy(
    strategy?: SyncPullStrategy,
  ): Promise<SyncPullStrategy | undefined> {
    if (strategy && strategy !== 'default') {
      return strategy;
    }
    const updateMethod = vscode.workspace
      .getConfiguration('versiondock')
      .get<'rebase' | 'merge' | 'prompt'>('updateProject.method', 'rebase');

    if (updateMethod === 'prompt') {
      const pick = (await vscode.window.showQuickPick(
        [
          {
            label: `$(repo-forked) ${t('Rebase the current branch on top of incoming changes')}`,
            strategy: 'rebase' as const,
          },
          {
            label: `$(git-merge) ${t('Merge incoming changes into the current branch')}`,
            strategy: 'merge' as const,
          },
        ],
        { title: t('Update Project — Strategy') },
      )) as { label: string; strategy: 'rebase' | 'merge' } | undefined;

      if (!pick) {
        return undefined;
      }
      return pick.strategy;
    }
    return updateMethod === 'rebase' ? 'rebase' : 'merge';
  }

  dispose(): void {
    this.disposeViewListeners();
    this.managerListeners.forEach(disposable => disposable.dispose());
    this.managerListeners.length = 0;
    for (const source of this.activeCommitMessageGenerations.values()) {
      source.cancel();
      source.dispose();
    }
    this.activeCommitMessageGenerations.clear();
    this.view = undefined;
    this.sidebarReady = false;
    this.sidebarViewGeneration += 1;
    this.pendingSidebarMessages = [];
  }
}
