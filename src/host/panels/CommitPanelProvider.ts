import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import { ShelveService } from '../git/ShelveService';
import { ChangelistService } from '../git/ChangelistService';
import { ShelveDocumentProvider, applyPatchToContent } from '../utils/ShelveDocumentProvider';
import type { CommitGenerateMessageTarget, CommitPanelTab, CommitToHostMsg, HostToCommitMsg, SubtreeEntry, SubtreeOp, SubtreePushStatus } from '../types/messages';
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
import { buildDiffDetailBlocks, formatDiffStats } from '../ai/diffContext';
import { buildFairContext, getFairDetailBlockTokenBudget, type FairContextGroup } from '../ai/fairContext';
import { getContextTokenBudget } from '../ai/inputTokenBudget';
import { isRemoteRepositoryCancelled } from '../remote/types';
import { withGitPushProgress } from '../utils/pushProgress';
import type { UpdateSummaryService } from '../update/UpdateSummaryService';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const AI_COMMIT_CONTEXT_LINES_AROUND_CHANGE = 3;
const SUBTREE_STATE_KEY = 'versiondock.subtrees';
const CUSTOM_SUBTREE_PREFIX_ID = '__custom_prefix__';
const SUBTREE_STATUS_CACHE_TTL_MS = 60_000;

type SubtreeRefPickItem = vscode.QuickPickItem & { value: string; custom?: boolean };
type CachedSubtreeStatus = { key: string; checkedAt: number; status: SubtreePushStatus };
type SubtreeStatusRefreshOptions = {
  force?: boolean;
  forceEntryIds?: Set<string>;
  notifyStatusUpdates?: boolean;
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

export class CommitPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'versiondock.commitPanel';
  private view?: vscode.WebviewView;
  private logProvider?: GitLogPanelProvider;
  private undockedPanel?: UndockedPanelProvider;
  private aiCommitComposerProvider?: AiCommitComposerProvider;
  private aiCodeReviewProvider?: AiCodeReviewProvider;
  private changelistService?: ChangelistService;
  private badgeController?: import('../ui/BadgeController').BadgeController;
  private readonly replyTarget = new AsyncLocalStorage<'sidebar' | 'undocked'>();
  private readonly managerListeners: vscode.Disposable[] = [];
  private viewListeners: vscode.Disposable[] = [];
  private branchSyncGeneration = 0;
  private repoSyncGeneration = 0;
  private pendingSidebarMessages: HostToCommitMsg[] = [];
  private sidebarReady = false;
  private sidebarViewGeneration = 0;

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${CommitPanelProvider.viewType}.focus`);
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

  private getShelveService(repoId: string): ShelveService | undefined {
    const repo = this.manager.getRepo(repoId);
    if (!repo) return undefined;
    if (!this.shelveServices.has(repoId)) {
      this.shelveServices.set(repoId, new ShelveService(repo.rootPath, this.globalStoragePath));
    }
    return this.shelveServices.get(repoId);
  }

  private updateVcsContext(metas: RepoMeta[] = this.manager.getRepoMetas()): void {
    const hasGitRepo = metas.some(meta => meta.kind !== 'svn');
    const hasSvnRepo = metas.some(meta => meta.kind === 'svn');
    void vscode.commands.executeCommand('setContext', 'versiondock.hasGitRepo', hasGitRepo);
    void vscode.commands.executeCommand('setContext', 'versiondock.hasSvnRepo', hasSvnRepo);
    void vscode.commands.executeCommand('setContext', 'versiondock.svnOnly', hasSvnRepo && !hasGitRepo);
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
    this.updateVcsContext();

    this.managerListeners.push(
      this.manager.onStatusChange((status) => {
        this.postChangelistsUpdate(status);
        this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
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

    this.managerListeners.push(this.manager.onBranchChange(() => {
      void postAllBranches().catch(error => {
        this.logger?.error('CommitPanel', 'Failed to refresh branches', error);
      });
    }));

    const syncRepos = async () => {
      const generation = ++this.repoSyncGeneration;
      const status = await this.manager.getAllStatusesFresh();
      if (generation !== this.repoSyncGeneration) return;
      this.postChangelistsUpdate(status);
      this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
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
      vscode.window.showWarningMessage(t('VersionDock: No Git identity configured. Set a profile before committing.'));
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
      const m = msg as typeof msg & { fileViewMode?: 'flat' | 'tree'; defaultCommitAction?: 'commit' | 'commitAndPush'; defaultSaveAction?: 'stash' | 'shelve'; hasWorkspaceFolder?: boolean };
      if (m.fileViewMode === undefined) m.fileViewMode = this.getFileViewMode();
      if (m.defaultCommitAction === undefined) m.defaultCommitAction = this.getDefaultCommitAction();
      if (m.defaultSaveAction === undefined) m.defaultSaveAction = this.getDefaultSaveAction();
      if (m.hasWorkspaceFolder === undefined) m.hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    }
    const broadcast = msg.type === 'COMMIT_STATUS_UPDATE'
      || msg.type === 'COMMIT_BRANCHES_UPDATE'
      || msg.type === 'COMMIT_HIDDEN_REPOS_UPDATE'
      || msg.type === 'CHANGELISTS_UPDATE'
      || msg.type === 'SHELVE_LIST_RESULT'
      || msg.type === 'STASH_COUNT_RESULT'
      || msg.type === 'STASH_LIST_RESULT'
      || msg.type === 'PUSH_UNPUSHED_RESULT'
      || msg.type === 'WORKTREE_LIST_RESULT'
      || msg.type === 'SUBTREE_LIST_RESULT'
      || msg.type === 'SUBTREE_STATUS_RESULT';
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
        t('SVN directory conflicts cannot be edited as text. Choose a conflict side or resolve the directory manually.'),
      );
      return;
    }

    const resource = await this.prepareSvnWorkingDiffResource(repo, filePath);
    if (!resource) {
      if (!workingStat?.isFile()) {
        await vscode.window.showInformationMessage(t('VersionDock: No SVN diff available for {0}.', path.basename(resolvedPath.relativePath)));
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
      await vscode.window.showInformationMessage(t('SVN does not use staged changes.'));
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
      await vscode.window.showInformationMessage(t('No SVN file changes to open.'));
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
      await vscode.window.showInformationMessage(t('No SVN file changes to open.'));
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
      await vscode.window.showWarningMessage(t('VersionDock: Could not open {0} SVN change(s): {1}', errors.length, errors.join('; ')));
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

  /** Reads fresh status after a stage/unstage op. simple-git reads directly from the git index so it's always accurate once the op completes. */
  private async refreshStatusAfterOp(): Promise<WorkspaceStatus> {
    return this.manager.getAllStatusesFresh();
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

  private async buildAiCommitMessageContext(
    targets: CommitGenerateMessageTarget[] | undefined,
    repoIds: string[] | undefined,
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
    const vcsKinds = new Set<'git' | 'svn'>();

    for (const target of normalizedTargets) {
      throwIfCancellationRequested(cancellationToken);
      const status = statusByRepo.get(target.repoId);
      if (!status) continue;
      const service = this.manager.getRepo(status.repoId);
      if (!service) continue;
      const repoMeta = repoMetas.get(status.repoId);
      const repoName = repoMeta?.name ?? path.basename(status.repoId);
      const vcsKind = service.kind === 'svn' ? 'SVN' : 'Git';
      const filesByPath = this.mergeAiFileStatuses(status);
      const files = target.paths.map(filePath => filesByPath.get(filePath)).filter((file): file is FileStatus => !!file);
      if (files.length === 0) continue;
      includedRepoIds.add(status.repoId);
      includedRepoRootPaths.add(repoMeta?.rootPath ?? service.rootPath);
      vcsKinds.add(service.kind === 'svn' ? 'svn' : 'git');
      const groupEntries: typeof preparedGroups[number]['entries'] = [];
      for (const file of files) {
        throwIfCancellationRequested(cancellationToken);

        const includeStaged = file.staged;
        const includeUnstaged = file.unstaged && (target.source === 'selected' || target.source === 'working');
        const diffSources = [
          ...(includeStaged ? [{ label: 'staged' as const, diff: () => service.getStagedDiff(status.repoId, file.path) }] : []),
          ...(includeUnstaged ? [{ label: 'working' as const, diff: () => service.getUnstagedDiff(status.repoId, file.path) }] : []),
        ];
        const sources: typeof groupEntries[number]['sources'] = [];
        for (const source of diffSources) {
          throwIfCancellationRequested(cancellationToken);
          const diff = await source.diff().catch(() => null);
          throwIfCancellationRequested(cancellationToken);
          sources.push({ label: source.label, diff });
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
      vcsKinds: Array.from(vcsKinds),
      repositoryCount: includedRepoIds.size,
      fileCount: context.includedEntryCount,
      contextCharCount: text.length,
      truncated: context.truncated,
    };
  }

  private async generateCommitMessage(
    targets: CommitGenerateMessageTarget[] | undefined,
    repoIds: string[] | undefined,
    requestId: string,
    cancellationToken: vscode.CancellationToken,
  ): Promise<string> {
    const context = await this.buildAiCommitMessageContext(targets, repoIds, cancellationToken);
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
    const current = this.getHiddenRepoIds();
    if (!current.includes(repoId)) {
      await this.setHiddenRepoIds([...current, repoId]);
    }
  }

  async unhideRepo(repoId: string): Promise<void> {
    const current = this.getHiddenRepoIds();
    await this.setHiddenRepoIds(current.filter(id => id !== repoId));
  }

  async manageHiddenRepos(): Promise<void> {
    const hidden = this.getHiddenRepoIds();
    if (hidden.length === 0) {
      vscode.window.showInformationMessage(t('VersionDock: No hidden repositories.'));
      return;
    }
    const allMetas = this.manager.getRepoMetas();
    const items = hidden.map(id => {
      const meta = allMetas.find(m => m.id === id);
      return { label: `$(eye) ${meta?.name ?? id}`, repoId: id };
    });
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: t('Select repositories to show again'),
      canPickMany: true,
      title: t('Hidden Repositories'),
    });
    if (!picked || picked.length === 0) return;
    const toUnhide = picked.map(p => p.repoId);
    await this.setHiddenRepoIds(hidden.filter(id => !toUnhide.includes(id)));
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

  private getSubtreeEntries(): SubtreeEntry[] {
    return [...(this.getSubtreeStore()?.get<SubtreeEntry[]>(SUBTREE_STATE_KEY, []) ?? [])];
  }

  private async saveSubtreeEntries(entries: SubtreeEntry[]): Promise<void> {
    await this.getSubtreeStore()?.update(SUBTREE_STATE_KEY, entries);
  }

  private async refreshSubtreeList(options: SubtreeStatusRefreshOptions = {}): Promise<void> {
    const entries = this.getSubtreeEntries();
    this.post({ type: 'SUBTREE_LIST_RESULT', entries });
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

  private invalidateSubtreeStatus(entryId?: string): void {
    if (entryId) {
      this.subtreeStatusCache.delete(entryId);
      this.subtreeStatusTasks.delete(entryId);
      this.notifiedSubtreeUpdateKeys.delete(entryId);
      return;
    }
    this.subtreeStatusCache.clear();
    this.subtreeStatusTasks.clear();
    this.notifiedSubtreeUpdateKeys.clear();
  }

  private getSubtreeStatusTask(entry: SubtreeEntry): Promise<SubtreePushStatus> {
    const key = this.getSubtreeStatusCacheKey(entry);
    const existing = this.subtreeStatusTasks.get(entry.id);
    if (existing?.key === key) return existing.task;

    const task = (async (): Promise<SubtreePushStatus> => {
      const repo = this.manager.getRepo(entry.repoId);
      if (!repo) return { error: t('Repo not found') };
      try {
        return await repo.getSubtreePushStatus(entry.prefix, entry.repository, entry.ref);
      } catch (e: unknown) {
        return { error: String(e) };
      }
    })();

    this.subtreeStatusTasks.set(entry.id, { key, task });
    void task.then(status => {
      if (this.subtreeStatusTasks.get(entry.id)?.task === task) {
        this.subtreeStatusCache.set(entry.id, { key, status, checkedAt: Date.now() });
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
    const totalAhead = changed.reduce((sum, item) => sum + (item.status.aheadCount ?? 0), 0);
    if (totalAhead > 0) {
      const message = changed.length === 1
        ? t('VersionDock: Subtree "{0}" has {1} to push.', changed[0].entry.name, totalAhead)
        : t('VersionDock: {0} subtrees have {1} to push.', changed.length, totalAhead);
      vscode.window.showInformationMessage(message);
      return;
    }

    const message = changed.length === 1
      ? t('VersionDock: Subtree "{0}" has updates to push.', changed[0].entry.name)
      : t('VersionDock: {0} subtrees have updates to push.', changed.length);
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
      initialStatuses[entryId] = { loading: true };
    }
    this.post({ type: 'SUBTREE_STATUS_RESULT', statuses: initialStatuses });

    if (staleEntries.length === 0) {
      if (options.notifyStatusUpdates) this.notifySubtreeStatusUpdates(entries, initialStatuses);
      return;
    }

    await Promise.all(staleEntries.map(entry => this.getSubtreeStatusTask(entry)));

    const currentEntries = this.getSubtreeEntries();
    const statuses = this.collectSubtreeStatusSnapshot(currentEntries);
    this.post({ type: 'SUBTREE_STATUS_RESULT', statuses });
    if (options.notifyStatusUpdates) this.notifySubtreeStatusUpdates(currentEntries, statuses);
  }

  private async postCommitStatusUpdate(options: { includeIconTheme?: boolean; refreshSubtrees?: boolean } = {}): Promise<void> {
    const [repos, status, iconTheme] = await Promise.all([
      Promise.resolve(this.manager.getRepoMetas()),
      this.manager.getAllStatuses(),
      options.includeIconTheme && this.view
        ? loadIconTheme(this.view.webview)
        : Promise.resolve(undefined),
    ]);
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
      vscode.window.showInformationMessage(t('No Git repositories found in this workspace.'));
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
      vscode.window.showWarningMessage(t('VersionDock: Repository not found.'));
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

  private async refreshAfterSubtreeOp(entryId?: string): Promise<void> {
    this.invalidateSubtreeStatus(entryId);
    const status = await this.refreshStatusAfterOp();
    this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
    this.postChangelistsUpdate(status);
    this.logProvider?.refresh();
    this.postSubtreeList(entryId ? { forceEntryIds: new Set([entryId]) } : { force: true });
  }

  private async upsertSubtreeEntry(entry: SubtreeEntry, options: { postList?: boolean; forceStatusRefresh?: boolean } = {}): Promise<void> {
    this.invalidateSubtreeStatus(entry.id);
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
    this.invalidateSubtreeStatus(entryId);
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
        { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Adding subtree {0}', result.entry.name), cancellable: false },
        async () => repo.addSubtree(result.entry.prefix, result.entry.repository, result.entry.ref, result.entry.defaultSquash, result.message),
      );
      await this.upsertSubtreeEntry(result.entry, { postList: false });
      await this.refreshAfterSubtreeOp(result.entry.id);
      vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" added.', result.entry.name));
    } catch (e: unknown) {
      vscode.window.showErrorMessage(t('VersionDock: Failed to add subtree — {0}', String(e)));
    }
  }

  private async registerSubtreeFromPrompt(repoId?: string): Promise<void> {
    const result = await this.promptSubtreeEntry('register', undefined, repoId);
    if (!result) return;
    const repo = this.manager.getRepo(result.entry.repoId);
    if (!repo) return;
    const absPrefix = repo.resolveRepoPath(result.entry.prefix).absolutePath;
    if (!fs.existsSync(absPrefix)) {
      vscode.window.showWarningMessage(t('VersionDock: Prefix "{0}" does not exist in this repository.', result.entry.prefix));
      return;
    }
    try {
      await this.upsertSubtreeEntry(result.entry);
      vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" registered.', result.entry.name));
    } catch (e: unknown) {
      vscode.window.showErrorMessage(t('VersionDock: Failed to register subtree — {0}', String(e)));
    }
  }

  private async editSubtreeFromPrompt(entryId: string): Promise<void> {
    const existing = this.findSubtreeEntry(entryId);
    if (!existing) {
      vscode.window.showWarningMessage(t('VersionDock: Subtree entry not found.'));
      return;
    }
    const result = await this.promptSubtreeEntry('edit', existing);
    if (!result) return;
    try {
      await this.upsertSubtreeEntry(result.entry);
      vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" updated.', result.entry.name));
    } catch (e: unknown) {
      vscode.window.showErrorMessage(t('VersionDock: Failed to update subtree — {0}', String(e)));
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
      vscode.window.showErrorMessage(t('VersionDock: {0}', error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op, ok: false, error });
      return;
    }
    try {
      let output = '';
      if (op === 'pull') {
        await this.ensureSubtreeClean(repo, 'pull');
        output = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pulling subtree {0}…', entry.name), cancellable: false },
          async () => repo.pullSubtree(entry.prefix, entry.repository, entry.ref, entry.defaultSquash),
        );
      } else if (op === 'push') {
        const confirm = await vscode.window.showWarningMessage(
          t('Push subtree "{0}" from prefix "{1}" to "{2}" ref "{3}"? This pushes only the subtree history, not the parent repository.', entry.name, entry.prefix, entry.repository, entry.ref),
          { modal: true },
          t('Push Subtree'),
        );
        if (confirm !== t('Push Subtree')) {
          this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op, ok: false, error: 'Cancelled' });
          return;
        }
        output = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pushing subtree {0}…', entry.name), cancellable: false },
          async () => repo.pushSubtree(entry.prefix, entry.repository, entry.ref),
        );
      } else if (op === 'remove') {
        await this.ensureSubtreeClean(repo, 'remove');
        const confirm = await vscode.window.showWarningMessage(
          t('Remove subtree "{0}" from prefix "{1}"? This stages the deletion but does not commit it.', entry.name, entry.prefix),
          { modal: true },
          t('Remove'),
        );
        if (confirm !== t('Remove')) {
          this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op, ok: false, error: 'Cancelled' });
          return;
        }
        output = await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Removing subtree {0}…', entry.name), cancellable: false },
          async () => repo.removeSubtree(entry.prefix),
        );
      }
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op, ok: true, output });
      await this.refreshAfterSubtreeOp(entry.id);
      if (op === 'pull') {
        vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" pulled.', entry.name));
      } else if (op === 'push') {
        vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" pushed.', entry.name));
      } else if (op === 'remove') {
        vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" removed from working tree.', entry.name));
      }
    } catch (e: unknown) {
      const error = String(e);
      const message = op === 'pull'
        ? t('VersionDock: Failed to pull subtree "{0}" — {1}', entry.name, error)
        : op === 'push'
          ? t('VersionDock: Failed to push subtree "{0}" — {1}', entry.name, error)
          : t('VersionDock: Failed to remove subtree "{0}" — {1}', entry.name, error);
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
      vscode.window.showErrorMessage(t('VersionDock: {0}', error));
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
        { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Splitting subtree {0}…', entry.name), cancellable: false },
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
        vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" split to branch "{1}".', entry.name, branch));
      } else {
        vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" split.', entry.name));
      }
    } catch (e: unknown) {
      const error = String(e);
      vscode.window.showErrorMessage(t('VersionDock: Failed to split subtree "{0}" — {1}', entry.name, error));
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
      vscode.window.showErrorMessage(t('VersionDock: {0}', error));
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
        { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Merging subtree {0}…', entry.name), cancellable: false },
        async () => repo.mergeSubtree(entry.prefix, commit, squash, message),
      );
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'merge', ok: true, output });
      await this.refreshAfterSubtreeOp(entry.id);
      vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" merged.', entry.name));
    } catch (e: unknown) {
      const error = String(e);
      vscode.window.showErrorMessage(t('VersionDock: Failed to merge subtree "{0}" — {1}', entry.name, error));
      this.post({ type: 'SUBTREE_OP_RESULT', requestId, repoId: entry.repoId, entryId, op: 'merge', ok: false, error });
    }
  }

  private async pickSubtreeEntry(title: string): Promise<SubtreeEntry | undefined> {
    const entries = this.getSubtreeEntries();
    if (entries.length === 0) {
      vscode.window.showInformationMessage(t('No subtrees registered in this workspace.'));
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
          this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, message: '', error: t('Repo not found') });
          return;
        }
        try {
          const message = await repo.getLastCommitMessage();
          this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, message });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_LAST_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, message: '', error: String(e) });
        }
        break;
      }

      case 'COMMIT_ACTIVE_TAB_CHANGED': {
        this.activeTab = msg.tab;
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
          vscode.window.showErrorMessage(t('VersionDock: Cannot open diff: {0}', String(e)));
        }
        break;
      }

      case 'COMMIT_STAGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.stageFiles(msg.paths);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_UNSTAGE_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.unstageFiles(msg.paths);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_STAGE_ALL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.stageAll();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_UNSTAGE_ALL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.unstageAll();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
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
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          const creds = repo.kind === 'svn' ? undefined : await this.getCommitCredentials(repo.repoId);
          const output = await repo.commit(msg.message, msg.amend, creds, detail => {
            this.logger?.debug('Commit', detail, { repoId: msg.repoId, requestId: msg.requestId });
          });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, output });
          this.logger?.info('Commit', 'Commit completed', {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
          this.logProvider?.refresh();
          const status = await this.refreshStatusAfterOp();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.logger?.error('Commit', 'Commit failed', e, {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
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
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          const creds = repo.kind === 'svn' ? undefined : await this.getCommitCredentials(repo.repoId);
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('Commit'), cancellable: false },
            async () => {
              await repo.commit(msg.message, msg.amend, creds, detail => {
                this.logger?.debug('Commit', detail, { repoId: msg.repoId, requestId: msg.requestId });
              });
            },
          );
          if (repo.kind !== 'svn') {
            await withGitPushProgress(repo, t('VersionDock: Pushing'), () => repo.push());
          }
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          this.logger?.info('Commit', 'Commit and push completed', {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
          this.logProvider?.refresh();
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
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
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: cancelled ? 'Cancelled' : String(e) });
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
              t('VersionDock: Cannot push — no remote configured for: {0}. Add a remote first (git remote add <name> <url>).', noRemoteRepos.join(', ')),
            );
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'No remote configured' });
            return;
          }
        }
        const runMultiCommit = async (): Promise<void> => {
            const errors: string[] = [];
            let cancelled = false;
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
            for (const r of ordered) {
              const repo = this.manager.getRepo(r.repoId);
              if (!repo) { errors.push(`${r.repoId}: not found`); continue; }
              try {
                if (repo.kind === 'svn') {
                  // SVN permits leading/trailing whitespace in node names.
                  // Preserve repository paths byte-for-byte instead of treating
                  // them like user-entered labels.
                  const selectedPaths = Array.from(new Set(r.filesToStage.filter(p => p.length > 0)));
                  const svnRepo = repo as typeof repo & { commitPaths?: (message: string, paths: string[]) => Promise<string> };
                  if (svnRepo.commitPaths) {
                    await svnRepo.commitPaths(r.message, selectedPaths);
                  } else {
                    await repo.commit(r.message, false);
                  }
                  continue;
                }
                // Stage/unstage according to user selection before committing
                await repo.runWithGitWriteLock(async () => {
                  if (r.filesToUnstage.length > 0) await repo.unstageFiles(r.filesToUnstage);
                  if (r.filesToStage.length > 0) await repo.stageFiles(r.filesToStage);
                  const creds = await this.getCommitCredentials(repo.repoId);
                  await repo.commit(r.message, r.amend, creds, detail => {
                    this.logger?.debug('Commit', detail, { repoId: r.repoId, requestId: msg.requestId });
                  });
                });
                if (msg.andPush) {
                  await withGitPushProgress(repo, t('VersionDock: Pushing'), () => repo.push());
                }
              } catch (e: unknown) {
                const repoName = (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo.rootPath)) || r.repoId;
                if (isRemoteRepositoryCancelled(e)) {
                  cancelled = true;
                  this.logger?.info('Commit', 'Repository commit and push cancelled', {
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
                  errors.push(`${repoName}: ${String(e)}`);
                }
              }
            }
            if (errors.length > 0 || cancelled) {
              this.logger?.warn('Commit', 'Multi-repository commit completed with failures', {
                repositoryCount: msg.repos.length,
                failedCount: errors.length + (cancelled ? 1 : 0),
                requestId: msg.requestId,
                andPush: msg.andPush,
                durationMs: Date.now() - startedAt,
              });
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.length > 0 ? errors.join('\n') : 'Cancelled' });
            } else {
              this.logger?.info('Commit', 'Multi-repository commit completed', {
                repositoryCount: msg.repos.length,
                requestId: msg.requestId,
                andPush: msg.andPush,
                durationMs: Date.now() - startedAt,
              });
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
              this.logProvider?.refresh();
            }
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
        };
        if (msg.andPush) {
          // Publishing may open QuickPick/InputBox controls. Do not keep a
          // surrounding progress notification visible while that happens.
          await runMultiCommit();
        } else {
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: msg.repos.length === 1
                ? t('VersionDock: Committing {0} repository', msg.repos.length)
                : t('VersionDock: Committing {0} repositories', msg.repos.length),
              cancellable: false,
            },
            runMultiCommit,
          );
        }
        break;
      }

      case 'COMMIT_DO_STASH_MULTI': {
        const startedAt = Date.now();
        this.logger?.info('Stash', 'Multi-repository stash started', {
          repositoryCount: msg.repos.length,
          requestId: msg.requestId,
        });
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: msg.repos.length === 1
              ? t('VersionDock: Stashing {0} repository', msg.repos.length)
              : t('VersionDock: Stashing {0} repositories', msg.repos.length),
            cancellable: false,
          },
          async () => {
            const errors: string[] = [];
            const affectedRepoIds: string[] = [];
            for (const r of msg.repos) {
              const repo = this.manager.getRepo(r.repoId);
              if (!repo) { errors.push(`${r.repoId}: not found`); continue; }
              if (repo.kind === 'svn') continue;
              try {
                const safePaths = r.paths?.map(filePath => repo.resolveRepoPath(filePath).relativePath);
                await repo.stashPush(msg.message, safePaths);
                affectedRepoIds.push(r.repoId);
              } catch (e: unknown) {
                const repoName = (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo.rootPath)) || r.repoId;
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
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
            } else {
              this.logger?.info('Stash', 'Multi-repository stash completed', {
                repositoryCount: msg.repos.length,
                requestId: msg.requestId,
                durationMs: Date.now() - startedAt,
              });
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
            }
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
            for (const repoId of affectedRepoIds) {
              this.post({ type: 'STASH_OP_RESULT', requestId: `${msg.requestId}-${repoId}`, repoId, op: 'push', ok: true });
            }
          }
        );
        break;
      }

      case 'COMMIT_DO_SHELVE_MULTI': {
        const startedAt = Date.now();
        this.logger?.info('Shelve', 'Multi-repository shelve started', {
          repositoryCount: msg.repos.length,
          requestId: msg.requestId,
        });
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: msg.repos.length === 1
              ? t('VersionDock: Shelving {0} repository', msg.repos.length)
              : t('VersionDock: Shelving {0} repositories', msg.repos.length),
            cancellable: false,
          },
          async () => {
            const errors: string[] = [];
            const affectedRepoIds: string[] = [];
            const clSvc = this.getOrCreateChangelistService();
            for (const r of msg.repos) {
              const shelveSvc = this.getShelveService(r.repoId);
              const repo = this.manager.getRepo(r.repoId);
              if (!shelveSvc || !repo) { errors.push(`${r.repoId}: not found`); continue; }
              if (repo.kind === 'svn') continue;
              try {
                const safePaths = r.paths?.map(filePath => repo.resolveRepoPath(filePath).relativePath);
                const clAssignments = clSvc ? this.buildChangelistAssignments(clSvc, r.repoId, safePaths) : undefined;
                await shelveSvc.push(msg.name, safePaths, clAssignments);
                affectedRepoIds.push(r.repoId);
              } catch (e: unknown) {
                const repoName = (this.manager.getRepoMeta(r.repoId)?.name ?? path.basename(repo.rootPath)) || r.repoId;
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
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
            } else {
              this.logger?.info('Shelve', 'Multi-repository shelve completed', {
                repositoryCount: msg.repos.length,
                requestId: msg.requestId,
                durationMs: Date.now() - startedAt,
              });
              this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
            }
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            this.postChangelistsUpdate(status);
            for (const repoId of affectedRepoIds) {
              this.post({ type: 'SHELVE_OP_RESULT', requestId: `${msg.requestId}-${repoId}`, repoId, op: 'push', ok: true });
            }
          }
        );
        break;
      }

      case 'COMMIT_PULL_ALL': {
        let trackedResults: Awaited<ReturnType<UpdateSummaryService['runAll']>> | undefined;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pulling all repositories'), cancellable: false },
          async () => {
            if (this.updateSummaryService) {
              trackedResults = await this.updateSummaryService.runAll(
                this.manager.getRepoMetas().map(meta => ({ repoId: meta.id, execute: repo => repo.pull() })),
              );
            } else {
              const results = await this.manager.pullAll();
              const failed = results.filter(r => !r.ok);
              if (failed.length === 0) return;
              const failedDescription = failed.map(result => {
                const name = this.manager.getRepoMeta(result.repoId)?.name ?? result.repoId;
                return `${name}: ${result.message}`;
              }).join('; ');
              vscode.window.showWarningMessage(t('VersionDock: {0} pull(s) failed: {1}', failed.length, failedDescription));
            }
          }
        );
        if (trackedResults) await this.updateSummaryService?.notify(trackedResults);
        break;
      }

      case 'COMMIT_PULL_REPO': {
        const startedAt = Date.now();
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        this.logger?.info('VCS', 'Pull started', { repoId: msg.repoId, requestId: msg.requestId, vcs: repo.kind });
        try {
          const result = this.updateSummaryService
            ? await this.updateSummaryService.run({ repoId: msg.repoId, execute: target => target.pull() })
            : { repoId: msg.repoId, tracked: false, ok: true, output: await repo.pull(), commits: [], files: [] };
          if (!result.ok) throw new Error(result.error ?? t('Unknown error'));
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true, output: result.output });
          this.logger?.info('VCS', 'Pull completed', {
            repoId: msg.repoId,
            requestId: msg.requestId,
            vcs: repo.kind,
            durationMs: Date.now() - startedAt,
          });
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
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
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
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        this.logger?.info('Git', 'Push started', {
          repoId: msg.repoId,
          requestId: msg.requestId,
          remote: msg.remote,
        });
        await withGitPushProgress(repo, t('VersionDock: Pushing'), async () => {
          try {
            await repo.push(false, msg.remote);
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
            this.logger?.info('Git', 'Push completed', {
              repoId: msg.repoId,
              requestId: msg.requestId,
              remote: msg.remote,
              durationMs: Date.now() - startedAt,
            });
            this.logProvider?.refresh();
            const status = await this.manager.getAllStatusesFresh();
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          } catch (e: unknown) {
            const cancelled = isRemoteRepositoryCancelled(e);
            if (!cancelled) {
              this.logger?.error('Git', 'Push failed', e, {
                repoId: msg.repoId,
                requestId: msg.requestId,
                remote: msg.remote,
                durationMs: Date.now() - startedAt,
              });
            } else {
              this.logger?.info('Git', 'Push cancelled', {
                repoId: msg.repoId,
                requestId: msg.requestId,
                remote: msg.remote,
                durationMs: Date.now() - startedAt,
              });
            }
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: cancelled ? 'Cancelled' : String(e) });
          }
        });
        break;
      }

      case 'COMMIT_DISCARD_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const confirm = await vscode.window.showWarningMessage(
          t('Discard changes to {0}? This cannot be undone.', msg.path),
          { modal: true }, t('Discard')
        );
        if (confirm !== t('Discard')) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.discardFile(msg.path);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_DISCARD_FILES': {
        const n = msg.files.length;
        const confirm = await vscode.window.showWarningMessage(
          n === 1
            ? t('Discard changes to {0} file? This cannot be undone.', n)
            : t('Discard changes to {0} files? This cannot be undone.', n),
          { modal: true }, t('Discard')
        );
        if (confirm !== t('Discard')) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          break;
        }
        const errors: string[] = [];
        for (const f of msg.files) {
          const repo = this.manager.getRepo(f.repoId);
          if (!repo) { errors.push(t('{0}: Repo not found', f.path)); continue; }
          try { await repo.discardFile(f.path); }
          catch (e: unknown) { errors.push(`${f.path}: ${String(e)}`); }
        }
        if (errors.length > 0) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('\n') });
        } else {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
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
            vscode.window.showErrorMessage(t('VersionDock: Cannot open SVN diff: {0}', String(e)));
          }
          break;
        }
        const resolvedPath = repo.resolveRepoPath(msg.filePath);
        const absUri = vscode.Uri.file(resolvedPath.absolutePath);
        if (fs.existsSync(absUri.fsPath) && fs.statSync(absUri.fsPath).isDirectory()) {
          vscode.window.showInformationMessage(t('VersionDock: Open the submodule repository section to inspect nested file changes.'));
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
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        let resolvedPath: ReturnType<typeof repo.resolveRepoPath>;
        try {
          resolvedPath = repo.resolveRepoPath(msg.filePath);
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          t('Delete {0}? This cannot be undone.', resolvedPath.relativePath),
          { modal: true }, t('Delete')
        );
        if (confirm !== t('Delete')) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          assertNoSymlinkAncestors(repo.rootPath, resolvedPath.absolutePath);
          await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { useTrash: true });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_DELETE_FOLDER': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        let resolvedPath: ReturnType<typeof repo.resolveRepoPath>;
        try {
          resolvedPath = repo.resolveRepoPath(msg.folderPath);
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          return;
        }
        const confirm = await vscode.window.showWarningMessage(
          t('Delete folder "{0}" and all its contents? This cannot be undone.', resolvedPath.relativePath),
          { modal: true }, t('Delete')
        );
        if (confirm !== t('Delete')) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          assertNoSymlinkAncestors(repo.rootPath, resolvedPath.absolutePath, { includeTarget: true });
          await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { recursive: true, useTrash: true });
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
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
          vscode.window.showInformationMessage(t('"{0}" is already in {1}', entry, path.relative(repo.rootPath, targetPath)));
          return;
        }
        const newContent = existing.endsWith('\n') || existing === ''
          ? existing + entry + '\n'
          : existing + '\n' + entry + '\n';
        fs.writeFileSync(targetPath, newContent, 'utf8');
        vscode.window.showInformationMessage(t('Added "{0}" to {1}', entry, path.relative(repo.rootPath, targetPath)));

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
            vscode.window.showInformationMessage(t('"{0}" is already in SVN ignore for {1}', result.entry, result.directoryPath || '.'));
          } else {
            vscode.window.showInformationMessage(t('Added "{0}" to SVN ignore for {1}', result.entry, result.directoryPath || '.'));
          }
          const status = await this.manager.getAllStatusesFresh();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repo.repoId, String(e)));
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
              vscode.window.showInformationMessage(t('"{0}" is already in SVN ignore for {1}', result.entry, result.directoryPath || '.'));
            } else {
              vscode.window.showInformationMessage(t('Added "{0}" to SVN ignore for {1}', result.entry, result.directoryPath || '.'));
            }
            const status = await this.manager.getAllStatusesFresh();
            this.postChangelistsUpdate(status);
            this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
            return;
          }

          if (entries.length === 0) {
            vscode.window.showInformationMessage(t('No SVN ignore entries found.'));
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
            t('Remove selected SVN ignore entries?'),
            { modal: true },
            t('Remove'),
          );
          if (confirm !== t('Remove')) return;

          await svn.removeIgnoreEntries(selected.map(item => item.entry));
          vscode.window.showInformationMessage(t('Removed {0} SVN ignore entries.', selected.length));
          const status = await this.manager.getAllStatusesFresh();
          this.postChangelistsUpdate(status);
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repo.repoId, String(e)));
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
          const confirm = await vscode.window.showWarningMessage(
            fileCount === 1
              ? t('Restore the conflicted file to the current branch version? This discards its index and working tree changes.')
              : t('Restore {0} conflicted files to their current branch versions? This discards their index and working tree changes.', fileCount),
            { modal: true },
            t('Restore Current Branch'),
          );
          if (confirm !== t('Restore Current Branch')) {
            this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            break;
          }

          const errors: string[] = [];
          for (const target of targets) {
            for (const filePath of target.paths) {
              try {
                await target.repo.discardFile(filePath);
              } catch (error: unknown) {
                errors.push(`${filePath}: ${String(error)}`);
              }
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
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          const relativePath = repo.resolveRepoPath(msg.filePath).relativePath;
          if (msg.type === 'COMMIT_ACCEPT_OURS') await repo.acceptOurs(relativePath);
          else await repo.acceptTheirs(relativePath);
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'COMMIT_GENERATE_MESSAGE': {
        const cancellationSource = new vscode.CancellationTokenSource();
        this.activeCommitMessageGenerations.set(msg.requestId, cancellationSource);
        try {
          const message = await this.generateCommitMessage(msg.targets, msg.repoIds, msg.requestId, cancellationSource.token);
          throwIfCancellationRequested(cancellationSource.token);
          this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, message });
        } catch (e: unknown) {
          const error = cancellationSource.token.isCancellationRequested
            ? 'Cancelled'
            : e instanceof Error ? e.message : String(e);
          this.post({ type: 'COMMIT_GENERATE_MESSAGE_RESULT', requestId: msg.requestId, error });
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
          vscode.window.showErrorMessage(t('AI Commit Composer is unavailable.'));
          return;
        }
        await this.aiCommitComposerProvider.openWorking(msg.candidates);
        break;
      }

      case 'COMMIT_OPEN_AI_REVIEW': {
        if (!this.aiCodeReviewProvider) {
          vscode.window.showErrorMessage(t('AI Code Review is unavailable.'));
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
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          // Restore changelist assignments if present
          if (clAssignments?.length) {
            await this.restoreChangelistAssignments(msg.repoId, clAssignments);
          }
          this.postChangelistsUpdate(status);
          this.post({ type: 'SHELVE_OP_RESULT', requestId: msg.requestId, repoId: msg.repoId, op: 'apply', ok: true });
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
        const confirmDrop = await vscode.window.showWarningMessage(
          t('Delete this shelved changelist? This cannot be undone.'),
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
            leftUri,    // left = current file (or empty if deleted)
            afterUri,   // right = after applying shelf
            `${fileName} (Working Tree ↔ After Unshelve)`
          );
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
            `${fileName} (Working Tree ↔ ${msg.stashRef})`
          );
        } catch (e) {
          vscode.window.showErrorMessage(t('VersionDock: Cannot open stash diff — {0}', String(e)));
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
          t('Drop this stash? This cannot be undone.'),
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

      case 'PUSH_GET_UNPUSHED': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits: [], error: t('Repo not found') });
          return;
        }
        try {
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
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
          const files = await repo.getCommitFiles(msg.hash);
          this.post({ type: 'PUSH_COMMIT_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, hash: msg.hash, files });
        } catch (e: unknown) {
          this.post({ type: 'PUSH_COMMIT_FILES_RESULT', requestId: msg.requestId, repoId: msg.repoId, hash: msg.hash, files: [], error: String(e) });
        }
        break;
      }

      case 'PUSH_OPEN_COMMIT_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          await this.openCommitDiffEditor(repo, msg.hash, msg.filePath, msg.fileStatus);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock: Cannot open diff: {0}', String(e)));
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
        if (!repo) { this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
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
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, ok: false, error: t('Cancelled') });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Squashing {0} commits…', msg.hashes.length), cancellable: false },
            () => repo.squashCommits(msg.hashes, result.message),
          );
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, ok: true });
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          this.post({ type: 'PUSH_SQUASH_RESULT', requestId: msg.requestId, ok: false, error: t('Squash failed: {0}', String(e)) });
        }
        break;
      }

      case 'PUSH_DROP_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const drop = t('Drop');
        const confirm = await vscode.window.showWarningMessage(
          t('Drop {0} commits? This rewrites history and cannot be undone.', msg.hashes.length),
          { modal: true }, drop
        );
        if (confirm !== drop) { this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, ok: false, error: t('Cancelled') }); return; }
        try {
          await repo.dropCommits(msg.oldestHash);
          this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, ok: true });
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          this.post({ type: 'PUSH_DROP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Drop failed: {0}', String(e)));
        }
        break;
      }

      case 'PUSH_REVERT_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const revert = t('Revert');
        const confirm = await vscode.window.showWarningMessage(
          t('Revert {0} commits? This creates new commits that undo the changes.', msg.hashes.length),
          { modal: true }, revert
        );
        if (confirm !== revert) { this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, ok: false, error: t('Cancelled') }); return; }
        try {
          await repo.revertCommits(msg.hashes);
          this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, ok: true });
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'PUSH_REVERT_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            const continueAction = t('Continue');
            const abortAction = t('Abort');
            const choice = await vscode.window.showWarningMessage(
              t('Revert has conflicts. Resolve them, then choose an action.'),
              continueAction, abortAction
            );
            if (choice === continueAction) await repo.revertContinue();
            else await repo.revertAbort();
          } else {
            vscode.window.showErrorMessage(t('VersionDock: Revert failed: {0}', errMsg));
          }
        }
        break;
      }

      case 'PUSH_EDIT_COMMIT_MSG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
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
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, ok: false, error: t('Cancelled') });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Updating commit message…'), cancellable: false },
            () => repo.rewordCommit(result.message),
          );
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, ok: true });
          const commits = await repo.getUnpushedCommits();
          this.post({ type: 'PUSH_UNPUSHED_RESULT', requestId: msg.requestId, repoId: msg.repoId, commits });
          this.logProvider?.refresh();
        } catch (e: unknown) {
          this.post({ type: 'PUSH_EDIT_MSG_RESULT', requestId: msg.requestId, ok: false, error: t('Edit commit message failed: {0}', String(e)) });
        }
        break;
      }

      case 'COMMIT_OPEN_LOG': {
        this.logProvider?.selectCommit(msg.hash, msg.repoId);
        break;
      }

      case 'COMMIT_UNDO_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const confirm = await vscode.window.showWarningMessage(
          t('Undo last commit? Changes will be kept as unstaged (git reset --soft HEAD~1).'),
          { modal: true }, t('Undo Commit')
        );
        if (confirm !== t('Undo Commit')) { this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' }); return; }
        try {
          await repo.undoCommit();
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: true });
          const status = await this.manager.getAllStatusesFresh();
          this.post({ type: 'COMMIT_STATUS_UPDATE', repos: this.manager.getRepoMetas(), status });
        } catch (e: unknown) {
          this.post({ type: 'COMMIT_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
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
          t('Delete "{0}"? Its files will be moved to Changes.', clName),
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
        if (filesByRepo.size === 0) { vscode.window.showInformationMessage(t('No files in this changelist to shelve.')); break; }
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
            vscode.window.showErrorMessage(t('Shelve failed for repo {0}: {1}', repoId, String(e)));
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
            vscode.window.showErrorMessage(t('Stash failed for repo {0}: {1}', repoId, String(e)));
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
            vscode.window.showErrorMessage(t('VersionDock: Cannot open SVN diff: {0}', String(e)));
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
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pushing submodule {0}', path.basename(subRepoPush.rootPath) || subRepoPush.rootPath), cancellable: false },
          async () => {
            try {
              await subRepoPush.pushSubmodule();
              this.post({ type: 'SUBMODULE_PUSH_RESULT', requestId: msg.requestId, repoId: msg.repoId, ok: true });
              this.logProvider?.refresh();
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

      case 'SUBMODULE_INIT': {
        const parentRepo = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepo) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: false, error: t('Repo not found') });
          return;
        }
        try {
          await parentRepo.initSubmodule(msg.submodulePath);
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: true });
          // Re-discover so the newly-initialized submodule gets its own GitService
          // scheduleRefresh will re-send status to the webview
        } catch (e: unknown) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'init', ok: false, error: String(e) });
        }
        break;
      }

      case 'SUBMODULE_DEINIT': {
        const parentRepoD = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepoD) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: t('Repo not found') });
          return;
        }
        const confirmDeinit = await vscode.window.showWarningMessage(
          t('Deinit submodule "{0}"? The working directory will be cleared.', msg.submodulePath),
          { modal: true }, t('Deinit')
        );
        if (confirmDeinit !== t('Deinit')) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await parentRepoD.deinitSubmodule(msg.submodulePath, msg.force);
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: true });
        } catch (e: unknown) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'deinit', ok: false, error: String(e) });
        }
        break;
      }

      case 'SUBMODULE_UPDATE': {
        const parentRepoU = this.manager.getRepo(msg.parentRepoId);
        if (!parentRepoU) {
          this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: false, error: t('Repo not found') });
          return;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Updating submodule {0}', msg.submodulePath), cancellable: false },
          async () => {
            try {
              await parentRepoU.updateSubmodule(msg.submodulePath, true, msg.recursive);
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: true });
              // Check if the submodule is now in detached HEAD (almost always true after update)
              const subRepoPath = path.join(parentRepoU.rootPath, msg.submodulePath);
              const subMeta = this.manager.getRepoMetas().find(candidate =>
                candidate.kind !== 'svn' && candidate.rootPath === subRepoPath
              );
              const subRepo = subMeta ? this.manager.getRepo(subMeta.id) : undefined;
              if (subRepo) {
                const subStatus = await subRepo.getStatus().catch(() => null);
                if (subStatus?.isDetachedHead) {
                  this.post({ type: 'SUBMODULE_DETACHED_HEAD_WARNING', repoId: subRepo.repoId, headCommit: subStatus.branch.detachedHash ?? subStatus.branch.detachedTag ?? 'HEAD' });
                }
              }
            } catch (e: unknown) {
              this.post({ type: 'SUBMODULE_OP_RESULT', requestId: msg.requestId, parentRepoId: msg.parentRepoId, submodulePath: msg.submodulePath, op: 'update', ok: false, error: String(e) });
            }
          }
        );
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

        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Creating worktree…'), cancellable: false },
            async () => {
              await repoCP.createWorktree(worktreePath.trim(), {
                branch: picked.isNew ? undefined : picked.branchName,
                newBranch: newBranchName,
              });
            }
          );
          const repos = await this.manager.getAllWorktrees();
          this.post({ type: 'WORKTREE_LIST_RESULT', repos });
          vscode.window.showInformationMessage(t('VersionDock: Worktree created at {0}', worktreePath.trim()));
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock: Failed to create worktree — {0}', String(e)));
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
        this.postSubtreeList({ notifyStatusUpdates: true });
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
        const confirm = await vscode.window.showWarningMessage(
          t('Delete registry for subtree "{0}" at prefix "{1}"? This only removes the saved association and does not delete files.', entry.name, entry.prefix),
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
        await this.removeSubtreeEntry(msg.entryId);
        vscode.window.showInformationMessage(t('VersionDock: Subtree "{0}" registry deleted.', entry.name));
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
        vscode.window.showErrorMessage(t('VersionDock: {0}', msg.message));
        break;
      }

      case 'NOTIFY_INFO': {
        vscode.window.showInformationMessage(t('VersionDock: {0}', msg.message));
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
    await this.postCommitStatusUpdate(options);
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
