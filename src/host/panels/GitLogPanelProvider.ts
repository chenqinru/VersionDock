import * as vscode from 'vscode';
import * as path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { GitService } from '../git/GitService';
import type { LogCommitPathEntry, LogToHostMsg, HostToLogMsg, LayoutDensity } from '../types/messages';
import type { BranchInfo, CommitLogList, LineRange, RepoMeta } from '../types/git';
import { loadIconTheme } from '../utils/IconThemeService';
import { ShelveDocumentProvider } from '../utils/ShelveDocumentProvider';
import type { CommitPanelProvider } from './CommitPanelProvider';
import type { UndockedPanelProvider } from './UndockedPanelProvider';
import { t } from '../utils/l10n';
import { showGitErrorMessage } from '../utils/gitError';
import { openSquashEditor } from './SquashEditorPanel';
import { openEditMessageEditor } from './EditMessageEditorPanel';
import { formatRepoLabel } from '../utils/repoLabels';
import { toGitUri } from '../utils/resourceUri';
import type { SvnService } from '../svn/SvnService';
import { checkoutSvnRepository } from '../svn/svnCheckout';
import { cloneGitRepository } from '../git/gitClone';
import { assertNoSymlinkAncestors } from '../utils/repoPath';
import { scopedKey } from '../utils/scopedKey';
import type { VersionDockLogger } from '../utils/Logger';
import type { AiCommitExplanationService } from '../aiCommitExplanation/AiCommitExplanationService';
import type { AiCommitMessageService } from '../aiCommitMessage/AiCommitMessageService';
import { generateHistoricalCommitMessage } from '../aiCommitMessage/generateHistoricalCommitMessage';
import type { AiCommitComposerProvider } from './AiCommitComposerProvider';
import { isRemoteRepositoryCancelled } from '../remote/types';
import { runPushWithProtection } from '../utils/pushProtection';
import type { UpdateSummaryService } from '../update/UpdateSummaryService';
import { buildPullRequestUrl } from '../utils/prUrlHelper';
import { validateBranchNameInput, sanitizeBranchName } from '../utils/branchNameSanitizer';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SVN_CHANGE_RESOURCE_CONCURRENCY = 4;

function getLogMetadataSignature(repos: readonly RepoMeta[], branches: readonly BranchInfo[]): string {
  const repoData = [...repos]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(repo => [
      repo.id,
      repo.name,
      repo.rootPath,
      repo.color,
      repo.kind ?? '',
      repo.parentRepoId ?? '',
      repo.submodulePath ?? '',
      repo.isWorktree ?? false,
      repo.mainWorktreePath ?? '',
    ]);
  const branchData = [...branches]
    .sort((left, right) => (
      left.repoId.localeCompare(right.repoId)
      || left.fullName.localeCompare(right.fullName)
      || left.name.localeCompare(right.name)
    ))
    .map(branch => [
      branch.repoId,
      branch.name,
      branch.fullName,
      branch.isHead,
      branch.isRemote,
      branch.remoteName ?? '',
      branch.upstream ?? '',
      branch.aheadBehind?.ahead ?? 0,
      branch.aheadBehind?.behind ?? 0,
      branch.lastCommitHash ?? '',
      branch.lastCommitDate ?? '',
      branch.detachedTag ?? '',
      branch.detachedHash ?? '',
    ]);
  return JSON.stringify([repoData, branchData]);
}

// Only fields that can change the visible commit set belong here. Tracking
// counts and dates still update the sidebar through LOG_INIT_DATA, but they do
// not justify reloading the commit list and graph.
function getLogContentSignature(repos: readonly RepoMeta[], branches: readonly BranchInfo[]): string {
  const repoData = [...repos]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(repo => [repo.id, repo.kind ?? '']);
  const branchData = [...branches]
    .sort((left, right) => (
      left.repoId.localeCompare(right.repoId)
      || left.fullName.localeCompare(right.fullName)
      || left.name.localeCompare(right.name)
    ))
    .map(branch => [
      branch.repoId,
      branch.fullName,
      branch.isHead,
      branch.isRemote,
      branch.lastCommitHash ?? '',
      branch.detachedTag ?? '',
      branch.detachedHash ?? '',
    ]);
  return JSON.stringify([repoData, branchData]);
}

function mergeCurrentIntoBranches(branches: BranchInfo[], current: BranchInfo): BranchInfo[] {
  if (!current.detachedTag && !current.detachedHash) return branches; // normal branch — already in list
  const filtered = branches.filter(b => !(b.repoId === current.repoId && b.isHead));
  return [...filtered, current];
}

type DeleteTagChoice = 'local' | 'remote' | 'both' | null;
type HistoryFilter = { repoId: string; filePath: string; lineRange?: LineRange };
type ChangesResource = [vscode.Uri, vscode.Uri, vscode.Uri];

function formatRevisionRefLabel(ref: string): string {
  return ref.replace(/^refs\/(?:heads|remotes|tags)\//, '');
}

async function confirmDeleteTag(title: string): Promise<DeleteTagChoice> {
  const pick = await vscode.window.showWarningMessage(
    title,
    { modal: true },
    t('Delete Local'),
    t('Delete on Remote'),
    t('Delete Local and Remote'),
  );
  if (!pick) return null;
  if (pick === t('Delete on Remote')) return 'remote';
  if (pick === t('Delete Local and Remote')) return 'both';
  return 'local';
}

async function deleteTagWithRemoteOption(
  repo: import('../git/GitService').GitService,
  tagName: string,
  choice: DeleteTagChoice,
  repoName?: string,
): Promise<void> {
  if (!choice) return;
  if (choice === 'local') {
    await repo.deleteTag(tagName);
    return;
  }
  const remotes = await repo.getRemotes().catch(() => [] as string[]);
  if (choice === 'remote') {
    // Remote only — don't delete locally
    if (remotes.length === 0) {
      vscode.window.showWarningMessage(
        repoName
          ? t('VersionDock [{0}]: No remotes configured.', repoName)
          : t('VersionDock: No remotes configured.')
      );
      return;
    }
    const remote = remotes.length === 1
      ? remotes[0]
      : (await vscode.window.showQuickPick(remotes.map(r => ({ label: r })), { title: t('Delete "{0}" from remote', tagName) }))?.label;
    if (!remote) return;
    await repo.deleteTagRemote(tagName, remote);
    return;
  }
  // 'both': delete local first, then remote
  await repo.deleteTag(tagName);
  if (remotes.length === 0) {
    vscode.window.showWarningMessage(
      repoName
        ? t('VersionDock [{0}]: Tag "{1}" deleted locally, but no remotes configured.', repoName, tagName)
        : t('VersionDock: Tag "{0}" deleted locally, but no remotes configured.', tagName)
    );
    return;
  }
  const remote = remotes.length === 1
    ? remotes[0]
    : (await vscode.window.showQuickPick(remotes.map(r => ({ label: r })), { title: t('Delete "{0}" from remote', tagName) }))?.label;
  if (!remote) return;
  await repo.deleteTagRemote(tagName, remote);
}


export class GitLogPanelProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'versiondock.gitLog';

  private view?: vscode.WebviewView;
  private disposables: vscode.Disposable[] = [];
  private readonly managerListeners: vscode.Disposable[] = [];
  private refreshDebounce: ReturnType<typeof setTimeout> | null = null;
  private lastLogMetadataSignature: string | null = null;
  private lastLogContentSignature: string | null = null;
  private pendingRefreshContentSignature: string | null = null;
  private managerSyncGeneration = 0;
  private readonly tagSyncGenerations = new Map<string, number>();
  private commitPanel?: CommitPanelProvider;
  private undockedPanel?: UndockedPanelProvider;
  private aiCommitComposerProvider?: AiCommitComposerProvider;
  private readonly replyTarget = new AsyncLocalStorage<'sidebar' | 'undocked'>();
  private readonly svnDiffOpenTasks = new Map<string, Promise<void>>();
  private pendingHistoryFilter?: HistoryFilter;
  private hiddenRepoIds: string[] = [];
  private pendingFilterRepoId: string | null = null;
  private pendingFilterBranch: string | null = null;
  private pendingAllBranchesTask: Promise<BranchInfo[]> | null = null;

  setCommitPanel(provider: CommitPanelProvider): void {
    this.commitPanel = provider;
  }

  setUndockedPanel(provider: UndockedPanelProvider): void {
    this.undockedPanel = provider;
  }

  setAiCommitComposerProvider(provider: AiCommitComposerProvider): void {
    this.aiCommitComposerProvider = provider;
  }

  handleUndockedMessage(msg: LogToHostMsg, _provider: UndockedPanelProvider): void {
    if (msg.type === 'LOG_UNDOCK') return;
    void this.replyTarget.run('undocked', () => this.handleMessage(msg)).catch(error => {
      this.logger.error('GitLog', 'Undocked panel message failed', error, { messageType: msg.type });
    });
  }

  notifyHiddenReposChanged(hiddenRepoIds: string[]): void {
    this.hiddenRepoIds = hiddenRepoIds;
    for (const [repoId, generation] of this.tagSyncGenerations) {
      this.tagSyncGenerations.set(repoId, generation + 1);
    }
    const generation = ++this.managerSyncGeneration;
    const repos = this.getVisibleRepos();
    void this.getFilteredBranches(repos).then(branches => {
      if (generation !== this.managerSyncGeneration) return;
      this.post({ type: 'LOG_INIT_DATA', repos, branches });
      this.post({ type: 'LOG_REFRESH' });
    }).catch(error => {
      this.logger.error('GitLog', 'Failed to apply hidden repositories', error);
    });
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly shelveDocProvider: ShelveDocumentProvider,
    private readonly aiCommitMessageService: AiCommitMessageService,
    private readonly aiCommitExplanationService: AiCommitExplanationService,
    private readonly logger: VersionDockLogger,
    private readonly updateSummaryService: UpdateSummaryService,
  ) {
    this.shelveDocProvider.setContentResolver(async (repoId, shelveId, filePath) => {
      if (shelveId === 'empty' || !shelveId) return '';
      const repo = this.manager.getRepo(repoId);
      if (!repo) return undefined;
      if (shelveId.startsWith('svn-')) {
        const revision = shelveId.slice(4);
        if (repo.kind === 'svn') {
          return await (repo as SvnService).getRevisionContentOrUndefined(revision, filePath);
        }
      }
      return undefined;
    });

    // Register manager listeners here so they fire even when the panel has never been opened.
    // this.post() silently drops messages when the webview is not yet resolved — that's fine,
    // because resolveWebviewView performs an explicit initial sync when the panel first opens.
    const syncManagerState = async () => {
      const generation = ++this.managerSyncGeneration;
      const repos = this.getVisibleRepos();
      const branches = await this.getFilteredBranches(repos);
      if (generation !== this.managerSyncGeneration) return;
      const metadataSignature = getLogMetadataSignature(repos, branches);
      if (metadataSignature === this.lastLogMetadataSignature) return;
      const contentSignature = getLogContentSignature(repos, branches);
      const contentChanged = contentSignature !== this.lastLogContentSignature;
      this.post({ type: 'LOG_INIT_DATA', repos, branches });
      if (!contentChanged) return;
      if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
      this.pendingRefreshContentSignature = contentSignature;
      this.refreshDebounce = setTimeout(() => {
        this.refreshDebounce = null;
        this.pendingRefreshContentSignature = null;
        this.post({ type: 'LOG_REFRESH' });
      }, 300);
    };
    const scheduleManagerSync = () => {
      void syncManagerState().catch(error => {
        this.logger.error('GitLog', 'Failed to synchronize repositories', error);
      });
    };
    this.managerListeners.push(
      this.manager.onBranchChange(scheduleManagerSync),
      this.manager.onReposChange(scheduleManagerSync),
    );
    if (this.manager.remoteService) {
      this.managerListeners.push(
        this.manager.remoteService.onDidChangeAccounts(() => {
          void this.manager.remoteService?.getConnectedAccounts().then(accounts => {
            this.post({ type: 'LOG_REMOTE_ACCOUNTS_RESULT', accounts: accounts ?? [] });
          }).catch(() => {});
        })
      );
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.disposables.forEach(disposable => disposable.dispose());
    this.disposables = [];
    this.view = webviewView;

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
      'gitLog',
      t('VersionDock: Git Log')
    );

    webviewView.webview.onDidReceiveMessage(
      (msg: LogToHostMsg) => {
        void this.replyTarget.run('sidebar', () => this.handleMessage(msg)).catch(error => {
          this.logger.error('GitLog', 'Sidebar message failed', error, { messageType: msg.type });
        });
      },
      null,
      this.disposables
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
          if (this.view) {
            void loadIconTheme(this.view.webview).then(iconTheme => {
              this.post({ type: 'LOG_ICON_THEME_UPDATE', iconTheme });
            }).catch(() => { /* icon theme optional */ });
          }
        }
        if (e.affectsConfiguration('versiondock.layoutDensity')) {
          this.post({ type: 'LOG_LAYOUT_DENSITY_UPDATE', layoutDensity: this.getLayoutDensity() });
        }
      })
    );

    this.disposables.push(
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible && this.pendingFilterRepoId !== null) {
          const repoId = this.pendingFilterRepoId;
          const branch = this.pendingFilterBranch;
          this.pendingFilterRepoId = null;
          this.pendingFilterBranch = null;
          // Small delay to let the webview finish its initial LOG_REQUEST_COMMITS round-trip
          setTimeout(() => this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch }), 150);
        }
      })
    );

    this.disposables.push(
      webviewView.onDidDispose(() => {
        if (this.view !== webviewView) return;
        this.view = undefined;
        const disposables = this.disposables;
        this.disposables = [];
        disposables.forEach(disposable => disposable.dispose());
      })
    );
  }

  /** Focus/reveal the Git Log panel in the bottom bar. */
  focus(): Thenable<void> {
    return vscode.commands.executeCommand(`${GitLogPanelProvider.viewType}.focus`);
  }

  async showFileHistoryForFile(filePath: string, lineRange?: LineRange): Promise<void> {
    const service = await this.manager.resolveServiceForFile(filePath, 'prompt', {
      title: t('Select Git or SVN Repository'),
      placeHolder: t('Select which repository history to open…'),
      notFoundMessage: t('The selected file is not inside a Git or SVN repository.'),
    });
    if (!service) {
      return;
    }
    const path = await import('path');
    const relativePath = path.relative(service.rootPath, filePath).split(path.sep).join('/');
    this.pendingHistoryFilter = { repoId: service.repoId, filePath: relativePath, lineRange };
    this.focus();
    this.flushPendingHistoryFilter();
  }

  /** Focus the panel and scroll to a specific commit. */
  selectCommit(hash: string, repoId: string): void {
    this.focus();
    this.post({ type: 'LOG_SCROLL_TO_COMMIT', hash, repoId });
  }

  /** Focus the panel and filter the log to a specific repository (and optionally branch). */
  focusRepo(repoId: string, branch?: string, target: 'sidebar' | 'undocked' = 'sidebar'): void {
    const repo = this.manager.getRepo(repoId);
    const filterBranch = branch && repo?.kind === 'git' && !branch.startsWith('refs/')
      ? `refs/heads/${branch}`
      : branch;
    if (target === 'undocked') {
      this.replyTarget.run('undocked', () => {
        this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch: filterBranch });
      });
      return;
    }
    this.pendingFilterRepoId = repoId;
    this.pendingFilterBranch = filterBranch ?? null;
    this.focus();
    if (this.view?.visible) {
      this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch: filterBranch });
      this.pendingFilterRepoId = null;
      this.pendingFilterBranch = null;
    }
  }

  /** Trigger a full log refresh — call this after any operation that creates new commits. */
  refresh(options?: { repoIds?: string[]; forceRemoteRefs?: boolean }): void {
    const forceRemoteRefs = options?.forceRemoteRefs ?? false;
    const repoIdFilter = options?.repoIds && options.repoIds.length > 0 ? new Set(options.repoIds) : undefined;
    for (const meta of this.manager.getRepoMetas()) {
      if (repoIdFilter && !repoIdFilter.has(meta.id)) {
        continue;
      }
      const repo = this.manager.getRepo(meta.id);
      if (repo?.kind === 'svn') {
        const svnRepo = repo as SvnService;
        svnRepo.clearLogHistoryCache();
        if (forceRemoteRefs) {
          svnRepo.clearBranchesCache();
          svnRepo.clearTagsCache();
        }
      }
    }
    if (forceRemoteRefs) {
      const visibleRepos = this.getVisibleRepos();
      const reposToFetch = repoIdFilter
        ? visibleRepos.filter(meta => repoIdFilter.has(meta.id))
        : visibleRepos;
      for (const meta of reposToFetch) {
        void this.refreshTags(meta.id, undefined, true).catch(() => {});
      }
      void (async () => {
        try {
          const branches = await this.getFilteredBranches(visibleRepos, { force: true, repoIds: options?.repoIds });
          this.post({ type: 'LOG_INIT_DATA', repos: visibleRepos, branches });
        } catch (error) {
          this.logger.error('GitLog', 'Failed to refresh branches on manual refresh', error);
        }
      })();
    }
    this.post({ type: 'LOG_REFRESH' });
  }

  private showOperationError(error: unknown, customPrefix?: string, repoName?: string): void {
    if (isRemoteRepositoryCancelled(error)) return;
    const rawMsg = (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, '');
    const message = customPrefix ? `${customPrefix}: ${rawMsg}` : rawMsg;
    void showGitErrorMessage(message, {
      repoName,
      onUnlocked: async () => {
        await this.manager.getAllStatusesFresh();
        this.refresh();
      },
    });
  }

  private acknowledgeFreshLogSnapshot(repos: readonly RepoMeta[], branches: readonly BranchInfo[]): void {
    const contentSignature = getLogContentSignature(repos, branches);
    if (contentSignature !== this.pendingRefreshContentSignature || !this.refreshDebounce) return;
    clearTimeout(this.refreshDebounce);
    this.refreshDebounce = null;
    this.pendingRefreshContentSignature = null;
  }

  private getLayoutDensity(): LayoutDensity {
    const raw = vscode.workspace.getConfiguration('versiondock').get<string>('layoutDensity', 'comfortable');
    return raw === 'compact' ? 'compact' : 'comfortable';
  }

  private post(msg: HostToLogMsg): void {
    if (msg.type === 'LOG_INIT_DATA') {
      const m = msg as typeof msg & { hasWorkspaceFolder?: boolean; layoutDensity?: LayoutDensity };
      if (m.hasWorkspaceFolder === undefined) m.hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      if (m.layoutDensity === undefined) m.layoutDensity = this.getLayoutDensity();
      this.lastLogMetadataSignature = getLogMetadataSignature(msg.repos, msg.branches);
      this.lastLogContentSignature = getLogContentSignature(msg.repos, msg.branches);
    }
    const broadcast = msg.type === 'LOG_INIT_DATA'
      || msg.type === 'LOG_ICON_THEME_UPDATE'
      || msg.type === 'LOG_LAYOUT_DENSITY_UPDATE'
      || msg.type === 'LOG_REFRESH'
      || msg.type === 'LOG_REFS_UPDATE'
      || msg.type === 'LOG_TAGS_UPDATE';
    if (this.replyTarget.getStore() === 'undocked') {
      this.undockedPanel?.postToLog(msg);
      if (broadcast) this.view?.webview.postMessage(msg);
      return;
    }
    this.view?.webview.postMessage(msg);
    if (broadcast) {
      this.undockedPanel?.postToLog(msg);
    }
  }

  private flushPendingHistoryFilter(): void {
    if (!this.view || !this.pendingHistoryFilter) return;
    const filter = this.pendingHistoryFilter;
    this.pendingHistoryFilter = undefined;
    this.post({ type: 'LOG_APPLY_HISTORY_FILTER', ...filter });
  }

  private async pickBranchTarget(
    branches: Array<{ repoId: string; branchName: string }>,
  ): Promise<{ repoId: string; branchName: string } | null> {
    if (branches.length === 0) return null;
    if (branches.length === 1) return branches[0];

    const metas = this.manager.getRepoMetas();
    const items = branches.map(branch => {
      const meta = metas.find(item => item.id === branch.repoId);
      return {
        label: meta ? formatRepoLabel(meta) : branch.repoId,
        description: formatRevisionRefLabel(branch.branchName),
        branch,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Choose a repository for "{0}"', formatRevisionRefLabel(branches[0].branchName)),
      matchOnDescription: true,
    });
    return picked?.branch ?? null;
  }

  private async openDiffBetweenRefs(
    repo: import('../git/GitService').GitService,
    filePath: string,
    leftRef: string,
    rightRef: string,
    title: string,
    lineRange?: LineRange,
  ): Promise<void> {
    const resolvedPath = repo.resolveRepoPath(filePath);
    const relativePath = resolvedPath.relativePath;
    const resolvedLeftRef = await repo.hasFileAtRef(leftRef, relativePath) ? leftRef : EMPTY_TREE;
    const resolvedRightRef = await repo.hasFileAtRef(rightRef, relativePath) ? rightRef : EMPTY_TREE;
    const absolutePath = resolvedPath.absolutePath;
    const gitUri = (ref: string) => toGitUri(absolutePath, ref);

    await vscode.commands.executeCommand(
      'vscode.diff',
      gitUri(resolvedLeftRef),
      gitUri(resolvedRightRef),
      title,
      lineRange
        ? {
            preview: true,
            selection: new vscode.Range(lineRange.start - 1, 0, lineRange.end - 1, 0),
          }
        : { preview: true },
    );
  }

  private async openSvnRevisionDiffEditor(
    repo: SvnService,
    hash: string,
    filePath: string,
    title: string,
    options?: { fileStatus?: string; lineRange?: LineRange; fromHash?: string },
  ): Promise<void> {
    const relativePath = repo.resolveRepoPath(filePath).relativePath;
    const lineRange = options?.lineRange;
    const fromHash = options?.fromHash;
    const taskKey = scopedKey(
      repo.repoId,
      fromHash ?? '',
      hash,
      relativePath,
      options?.fileStatus ?? '',
      String(lineRange?.start ?? ''),
      String(lineRange?.end ?? ''),
    );
    const existingTask = this.svnDiffOpenTasks.get(taskKey);
    if (existingTask) {
      await existingTask;
      return;
    }

    const task = (async () => {
      const repoName = this.manager.getRepoMeta(repo.repoId)?.name || path.basename(repo.rootPath) || repo.repoId;
      const statusMessage = vscode.window.setStatusBarMessage(t('VersionDock [{0}]: Loading diff for {1}…', repoName, relativePath));
      try {
        // The file list already tells us whether this revision added or deleted the file.
        // Fetching revision contents directly avoids a redundant `svn diff` round trip;
        // SvnService also caches and coalesces these immutable `svn cat` requests.
        const contents = fromHash !== undefined
          ? await repo.getRevisionRangeFileContents(fromHash, hash, relativePath)
          : await repo.getRevisionFileContents(hash, relativePath, options?.fileStatus);
        if (contents.isBinary) {
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Binary file — no diff available', repoName));
          return;
        }
        const normalizedStatus = (options?.fileStatus ?? '').toUpperCase();
        if (!contents.originalContent && !contents.modifiedContent && normalizedStatus !== 'A' && normalizedStatus !== 'D') {
          vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN diff available for {1}.', repoName, relativePath));
          return;
        }

        const leftRef = fromHash ?? `r${Math.max(0, Number(hash.replace(/^r/i, '')) - 1)}`;
        const leftUri = ShelveDocumentProvider.buildUri(repo.repoId, `svn-${leftRef}`, relativePath);
        const rightUri = ShelveDocumentProvider.buildUri(repo.repoId, `svn-${hash}`, relativePath);
        this.shelveDocProvider.set(leftUri, contents.originalContent);
        this.shelveDocProvider.set(rightUri, contents.modifiedContent);

        const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
        const isAlreadyActiveDiff = activeTab?.input instanceof vscode.TabInputTextDiff
          && activeTab.input.original.toString() === leftUri.toString()
          && activeTab.input.modified.toString() === rightUri.toString();

        if (!isAlreadyActiveDiff) {
          await vscode.commands.executeCommand(
            'vscode.diff',
            leftUri,
            rightUri,
            title,
            lineRange
              ? {
                  preview: true,
                  selection: new vscode.Range(lineRange.start - 1, 0, lineRange.end - 1, 0),
                }
              : { preview: true },
          );
        }
        await this.revealLineRange(rightUri, lineRange);
      } finally {
        statusMessage.dispose();
      }
    })();

    this.svnDiffOpenTasks.set(taskKey, task);
    try {
      await task;
    } finally {
      if (this.svnDiffOpenTasks.get(taskKey) === task) {
        this.svnDiffOpenTasks.delete(taskKey);
      }
    }
  }

  private buildSvnCommitChangeResourcesSync(
    repo: SvnService,
    fromRef: string,
    toRef: string,
    files: Array<{ path: string; status?: string }>,
  ): ChangesResource[] {
    const eligibleFiles = files.filter(file => file.status?.toUpperCase() !== 'U');
    const resources: ChangesResource[] = [];

    for (const file of eligibleFiles) {
      const resolvedPath = repo.resolveRepoPath(file.path);
      const relativePath = resolvedPath.relativePath;
      const status = (file.status ?? 'M').toUpperCase();

      const leftUri = status === 'A'
        ? ShelveDocumentProvider.buildUri(repo.repoId, 'empty', relativePath)
        : ShelveDocumentProvider.buildUri(repo.repoId, `svn-${fromRef}`, relativePath);

      const rightUri = status === 'D'
        ? ShelveDocumentProvider.buildUri(repo.repoId, 'empty', relativePath)
        : ShelveDocumentProvider.buildUri(repo.repoId, `svn-${toRef}`, relativePath);

      resources.push([vscode.Uri.file(resolvedPath.absolutePath), leftUri, rightUri]);
    }

    return resources;
  }

  private async revealLineRange(uri: vscode.Uri, lineRange?: LineRange): Promise<void> {
    if (!lineRange) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      const editor = vscode.window.visibleTextEditors.find(item => item.document.uri.toString() === uri.toString());
      if (editor) {
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        const startLine = Math.min(Math.max(0, lineRange.start - 1), lastLine);
        const endLine = Math.min(Math.max(startLine, lineRange.end - 1), lastLine);
        const range = new vscode.Range(startLine, 0, endLine, editor.document.lineAt(endLine).range.end.character);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  private async deleteWorkingPath(
    repo: import('../git/GitService').GitService,
    filePath: string,
  ): Promise<void> {
    const resolvedPath = repo.resolveRepoPath(filePath);
    assertNoSymlinkAncestors(repo.rootPath, resolvedPath.absolutePath);
    const uri = vscode.Uri.file(resolvedPath.absolutePath);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return;
      throw error;
    }
    const isDirectory = (stat.type & vscode.FileType.Directory) !== 0
      && (stat.type & vscode.FileType.SymbolicLink) === 0;
    await vscode.workspace.fs.delete(uri, { recursive: isDirectory, useTrash: false });
  }

  private async applyCommitPathEntries(
    repo: import('../git/GitService').GitService,
    entries: LogCommitPathEntry[],
    direction: 'apply' | 'restore',
  ): Promise<void> {
    for (const entry of entries) {
      const resolvedPath = repo.resolveRepoPath(entry.path);
      if (direction === 'apply') {
        if (entry.status === 'D') {
          await this.deleteWorkingPath(repo, resolvedPath.relativePath);
          continue;
        }
        await repo.checkoutFileFromCommit(entry.hash, resolvedPath.relativePath);
        continue;
      }

      if (entry.status === 'A') {
        await this.deleteWorkingPath(repo, resolvedPath.relativePath);
        continue;
      }
      await repo.revertFileToParent(entry.hash, resolvedPath.relativePath);
    }
  }

  private getNonWorktreeRepos() {
    return this.manager.getRepoMetas().filter(m => !m.isWorktree);
  }

  private getVisibleRepos() {
    return this.getNonWorktreeRepos().filter(m => !this.hiddenRepoIds.includes(m.id));
  }

  private getRequestedVisibleRepoIds(
    requestedRepoIds: string[] | null,
    repos = this.getVisibleRepos(),
  ): string[] {
    if (requestedRepoIds === null) return repos.map(repo => repo.id);
    const visibleRepoIds = new Set(repos.map(repo => repo.id));
    return requestedRepoIds.filter(repoId => visibleRepoIds.has(repoId));
  }

  private async getFilteredBranches(repos = this.getVisibleRepos(), options?: { force?: boolean; repoIds?: string[] }): Promise<BranchInfo[]> {
    const ids = new Set(repos.map(r => r.id));
    if (options?.force || options?.repoIds) {
      const all = await this.manager.getAllBranches(options);
      return all.filter(b => ids.has(b.repoId));
    }
    if (!this.pendingAllBranchesTask) {
      const task = this.manager.getAllBranches().finally(() => {
        if (this.pendingAllBranchesTask === task) {
          this.pendingAllBranchesTask = null;
        }
      });
      this.pendingAllBranchesTask = task;
    }
    const all = await this.pendingAllBranchesTask;
    return all.filter(b => ids.has(b.repoId));
  }

  private getCachedFilteredBranches(repos = this.getVisibleRepos()): BranchInfo[] {
    const ids = new Set(repos.map(r => r.id));
    const all = this.manager.getCachedBranches();
    const result = all.filter(b => ids.has(b.repoId));
    const presentRepoIds = new Set(result.map(b => b.repoId));
    for (const repoMeta of repos) {
      if (!presentRepoIds.has(repoMeta.id)) {
        const repo = this.manager.getRepo(repoMeta.id);
        const cachedBranch = (repo as { getCachedBranch?: () => BranchInfo | undefined })?.getCachedBranch?.();
        if (cachedBranch) {
          result.push(cachedBranch);
        }
      }
    }
    return result;
  }

  private async refreshTags(
    repoId: string,
    repo = this.manager.getRepo(repoId),
    force = false,
  ): Promise<void> {
    if (!repo) return;
    const generation = (this.tagSyncGenerations.get(repoId) ?? 0) + 1;
    this.tagSyncGenerations.set(repoId, generation);
    const rawTags: Array<{ name: string; hash: string; date: string }> = await (repo.kind === 'svn' ? (repo as SvnService).getTags({ force }) : repo.getTags());
    if (this.tagSyncGenerations.get(repoId) !== generation) return;
    if (!this.getVisibleRepos().some(visible => visible.id === repoId)) return;
    this.post({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(tag => ({ ...tag, repoId })) });
  }

  private async handleMessage(msg: LogToHostMsg): Promise<void> {
    switch (msg.type) {
      case 'LOG_SET_LAYOUT_DENSITY': {
        await vscode.workspace.getConfiguration('versiondock').update('layoutDensity', msg.density, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'LOG_REQUEST_GRAPH_COMMITS': {
        const maxCommits = vscode.workspace.getConfiguration('versiondock').get<number>('graphMaxCommits', 1000);
        const logRepoIds = this.getRequestedVisibleRepoIds(msg.repoIds);
        if (logRepoIds.length === 0 || maxCommits <= 0) {
          this.post({
            type: 'LOG_GRAPH_COMMITS',
            commits: [],
            generation: msg.generation,
            requestId: msg.requestId,
          });
          break;
        }
        try {
          const commits = await this.manager.getInterleavedGraphLog(logRepoIds, maxCommits);
          this.post({
            type: 'LOG_GRAPH_COMMITS',
            commits,
            generation: msg.generation,
            requestId: msg.requestId,
          });
        } catch (error) {
          this.logger.error('GitLog', 'Failed to load graph commits', error);
          this.post({
            type: 'LOG_GRAPH_COMMITS',
            commits: [],
            generation: msg.generation,
            requestId: msg.requestId,
          });
        }
        break;
      }

      case 'LOG_REQUEST_COMMITS': {
        const maxCommits = vscode.workspace.getConfiguration('versiondock').get<number>('graphMaxCommits', 1000);
        if (msg.skip >= maxCommits) {
          this.post({ type: 'LOG_COMMITS_BATCH', commits: [], isLast: true, batchIndex: 0, generation: msg.generation, requestId: msg.requestId });
          return;
        }
        const limit = Math.min(msg.limit, maxCommits - msg.skip);

        const repos = this.getVisibleRepos();
        const metadataGeneration = this.managerSyncGeneration;
        // Metadata changes on a fresh load/filter (skip=0), not while fetching
        // later commit pages. Avoid repeating branch/tag CLI calls and theme
        // parsing on every scroll batch.
        if (msg.skip === 0) {
          // Immediately post available repos and known cached branches so the
          // Webview initializes instantly (store.initialized = true) without
          // waiting for remote SVN branch ls CLI round-trips.
          const initialBranches = this.getCachedFilteredBranches(repos);
          this.post({ type: 'LOG_INIT_DATA', repos, branches: initialBranches, isInitialPartial: true });

          void (async () => {
            try {
              const [branches, iconTheme] = await Promise.all([
                this.getFilteredBranches(repos),
                this.view ? loadIconTheme(this.view.webview) : Promise.resolve(undefined),
              ]);
              if (metadataGeneration === this.managerSyncGeneration) {
                this.acknowledgeFreshLogSnapshot(repos, branches);
                this.post({ type: 'LOG_INIT_DATA', repos, branches, iconTheme, isInitialPartial: false });

                void this.manager.remoteService?.getConnectedAccounts().then(accounts => {
                  this.post({ type: 'LOG_REMOTE_ACCOUNTS_RESULT', accounts: accounts ?? [] });
                }).catch(() => {});

                // Send tags for all visible repos without blocking the commit batch.
                for (const meta of repos) {
                  void this.refreshTags(meta.id, undefined, false).catch(() => {});
                }
              }
            } catch (error) {
              this.logger.error('GitLog', 'Failed to load branches on commit request', error);
            }
          })();
        }

        const logRepoIds = this.getRequestedVisibleRepoIds(msg.repoIds, repos);
        // WorkspaceGitManager treats an empty id list as "all repositories".
        // At this boundary, however, empty means that the requested/visible set
        // is genuinely empty; passing it through would leak hidden, removed, or
        // worktree commits back into the log.
        if (logRepoIds.length === 0) {
          this.post({
            type: 'LOG_COMMITS_BATCH',
            commits: [],
            isLast: true,
            batchIndex: 0,
            generation: msg.generation,
            requestId: msg.requestId,
          });
          this.flushPendingHistoryFilter();
          break;
        }
        try {
          const consumer = this.replyTarget.getStore() ?? 'sidebar';
          const commits = await this.manager.getInterleavedLog(logRepoIds, limit, msg.skip, {
            filterText: msg.filterText,
            filterAuthor: msg.filterAuthor,
            filterBranch: msg.filterBranch,
            filterDateFrom: msg.filterDateFrom,
            filterDateTo: msg.filterDateTo,
            filterPath: msg.filterPath,
            lineRange: msg.lineRange,
            consumer,
          });
          const explicitHasMore = (commits as CommitLogList).hasMore;
          const repoErrors = (commits as CommitLogList).repoErrors;
          const isLast = explicitHasMore !== undefined ? !explicitHasMore : commits.length < limit;
          this.post({
            type: 'LOG_COMMITS_BATCH',
            commits,
            isLast,
            batchIndex: 0,
            generation: msg.generation,
            requestId: msg.requestId,
            repoErrors: repoErrors && repoErrors.length > 0 ? repoErrors : undefined,
          });
        } catch (error) {
          this.logger.error('GitLog', 'Failed to load interleaved log', error);
          this.post({ type: 'LOG_COMMITS_BATCH', commits: [], isLast: true, batchIndex: 0, generation: msg.generation, requestId: msg.requestId });
        }
        this.flushPendingHistoryFilter();
        break;
      }

      case 'LOG_WEBVIEW_ERROR': {
        this.logger.error('GitLogWebview', msg.message, msg.stack, { componentStack: msg.componentStack });
        void showGitErrorMessage(t('VersionDock Log error: {0}', msg.message), {
          onUnlocked: async () => {
            await this.manager.getAllStatusesFresh();
            this.refresh();
          },
        });
        break;
      }

      case 'LOG_REQUEST_COMMIT_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: t('Repo not found') }); return; }
        try {
          const [files, mergeParentChanges] = await Promise.all([
            repo.getCommitFilesForLogDetail(msg.hash, msg.parents),
            msg.includeMergeParentChanges
              ? repo.getMergeParentChanges(msg.hash, msg.parents).catch(() => [])
              : Promise.resolve(undefined),
          ]);
          this.post({
            type: 'LOG_COMMIT_FILES',
            requestId: msg.requestId,
            files,
            ...(mergeParentChanges ? { mergeParentChanges } : {}),
          });
          if (msg.prefetchContent !== false && repo.kind === 'svn' && files.length > 0) {
            const svnRepo = repo as SvnService;
            void svnRepo.prefetchRevisionFiles(msg.hash, files);
          }
        } catch (e: unknown) {
          this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: String(e) });
        }
        break;
      }

      case 'LOG_REQUEST_MERGE_PARENT_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_MERGE_PARENT_FILES_RESULT', requestId: msg.requestId, files: [], error: t('Repo not found') }); return; }
        try {
          const files = await repo.getMergeParentFiles(msg.hash, msg.parentHash);
          this.post({ type: 'LOG_MERGE_PARENT_FILES_RESULT', requestId: msg.requestId, files });
        } catch (e: unknown) {
          this.post({ type: 'LOG_MERGE_PARENT_FILES_RESULT', requestId: msg.requestId, files: [], error: String(e) });
        }
        break;
      }

      case 'LOG_REQUEST_MERGE_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits: [], error: t('Repo not found') }); return; }
        try {
          const commits = await repo.getMergeCommits(msg.hash, msg.parents);
          this.post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits });
        } catch (e: unknown) {
          this.post({ type: 'LOG_MERGE_COMMITS_RESULT', requestId: msg.requestId, commits: [], error: String(e) });
        }
        break;
      }

      case 'LOG_REQUEST_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff: null, error: t('Repo not found') }); return; }
        try {
          const relativePath = repo.resolveRepoPath(msg.filePath).relativePath;
          const diff = await repo.getFileDiff(msg.repoId, msg.hash, relativePath);
          this.post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff });
        } catch (e: unknown) {
          this.post({ type: 'LOG_DIFF_RESULT', requestId: msg.requestId, files: [], diff: null, error: String(e) });
        }
        break;
      }

      case 'LOG_OPEN_FILE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'LOG_DIFF_OPENED', repoId: msg.repoId, filePath: msg.filePath });
          return;
        }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          const nodePath = await import('path');
          const status = msg.fileStatus ?? 'M';
          const fileName = nodePath.basename(msg.filePath);
          let title: string;
          if (status === 'A') {
            title    = t('{0} (added in {1})', fileName, msg.hash.slice(0, 7));
          } else if (status === 'D') {
            title    = t('{0} (deleted in {1})', fileName, msg.hash.slice(0, 7));
          } else {
            title    = t('{0} ({1})', fileName, msg.hash.slice(0, 7));
          }
          if (repo.kind === 'svn') {
            await this.openSvnRevisionDiffEditor(repo as SvnService, msg.hash, msg.filePath, title, {
              fileStatus: status,
              lineRange: msg.lineRange,
            });
            this.post({ type: 'LOG_DIFF_OPENED', repoId: msg.repoId, filePath: msg.filePath });
            break;
          }
          await this.openDiffBetweenRefs(repo, msg.filePath, `${msg.hash}~1`, msg.hash, title, msg.lineRange);
        } catch (e: unknown) {
          this.showOperationError(e, t('VersionDock: Cannot open diff'), repoName);
        } finally {
          this.post({ type: 'LOG_DIFF_OPENED', repoId: msg.repoId, filePath: msg.filePath });
        }
        break;
      }

      case 'LOG_OPEN_FILE_RANGE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'LOG_DIFF_OPENED', repoId: msg.repoId, filePath: msg.filePath });
          return;
        }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          const pathMod = await import('path');
          const fileName = pathMod.basename(msg.filePath);
          if (repo.kind === 'svn') {
            await this.openSvnRevisionDiffEditor(
              repo as SvnService,
              msg.toHash,
              msg.filePath,
              t('{0} ({1}..{2})', fileName, msg.fromHash, msg.toHash),
              { fromHash: msg.fromHash, lineRange: msg.lineRange },
            );
            this.post({ type: 'LOG_DIFF_OPENED', repoId: msg.repoId, filePath: msg.filePath });
            break;
          }
          await this.openDiffBetweenRefs(
            repo,
            msg.filePath,
            msg.fromHash,
            msg.toHash,
            t('{0} ({1}..{2})', fileName, msg.fromHash.slice(0, 7), msg.toHash.slice(0, 7)),
            msg.lineRange,
          );
        } catch (e: unknown) {
          this.showOperationError(e, t('VersionDock: Cannot open diff'), repoName);
        } finally {
          this.post({ type: 'LOG_DIFF_OPENED', repoId: msg.repoId, filePath: msg.filePath });
        }
        break;
      }

      case 'LOG_OPEN_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          const uri = vscode.Uri.file(repo.resolveRepoPath(msg.filePath).absolutePath);
          await vscode.commands.executeCommand(
            'vscode.open',
            uri,
            msg.lineRange
              ? { selection: new vscode.Range(msg.lineRange.start - 1, 0, msg.lineRange.end - 1, 0) }
              : undefined,
          );
        } catch (e: unknown) {
          this.showOperationError(e, t('VersionDock: Cannot open file'), repoName);
        }
        break;
      }

      case 'LOG_REVEAL_IN_EXPLORER': {
        const repoRE = this.manager.getRepo(msg.repoId);
        if (!repoRE) return;
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(repoRE.resolveRepoPath(msg.filePath).absolutePath));
        break;
      }

      case 'LOG_REVEAL_IN_OS': {
        const repoOS = this.manager.getRepo(msg.repoId);
        if (!repoOS) return;
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(repoOS.resolveRepoPath(msg.filePath).absolutePath));
        break;
      }

      case 'LOG_INIT_REPO': {
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) break;
        await vscode.commands.executeCommand('git.init', folder.uri);
        await new Promise(r => setTimeout(r, 1000));
        this.manager.reinitializeAndRefresh();
        break;
      }

      case 'LOG_CHECKOUT_SVN_REPO': {
        await checkoutSvnRepository(this.manager);
        this.refresh();
        break;
      }

      case 'LOG_OPEN_FOLDER':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;

      case 'LOG_CLONE_REPO':
        await cloneGitRepository(this.manager);
        this.refresh();
        break;

      case 'LOG_MANAGE_REMOTE_ACCOUNTS': {
        await this.manager.remoteService?.manageAccounts();
        const accounts = await this.manager.remoteService?.getConnectedAccounts().catch(() => []) ?? [];
        this.post({ type: 'LOG_REMOTE_ACCOUNTS_RESULT', accounts });
        break;
      }

      case 'LOG_RESOLVE_AVATARS': {
        const remoteService = this.manager.remoteService;
        if (!remoteService) {
          this.post({ type: 'LOG_AVATARS_RESOLVED', avatars: {} });
          break;
        }
        let remotes: string[] = [];
        if (msg.repoId) {
          const repo = this.manager.getRepo(msg.repoId);
          if (repo) {
            try {
              const withUrls = await repo.getRemotesWithUrls().catch(() => []);
              remotes = withUrls.flatMap(r => [r.fetchUrl, r.pushUrl]).filter(Boolean);
            } catch {
              // Fallback to name-only getRemotes if needed
              try {
                remotes = await repo.getRemotes().catch(() => []);
              } catch {
                // Ignore
              }
            }
          }
        } else {
          for (const meta of this.manager.getRepoMetas()) {
            const repo = this.manager.getRepo(meta.id);
            if (!repo) continue;
            try {
              const withUrls = await repo.getRemotesWithUrls().catch(() => []);
              remotes.push(...withUrls.flatMap(r => [r.fetchUrl, r.pushUrl]).filter(Boolean));
            } catch {
              // Ignore
            }
          }
        }
        const authorsMap: Record<string, string> = {};
        if (msg.authors) {
          for (const a of msg.authors) {
            if (a.name && a.email) {
              authorsMap[a.email.trim().toLowerCase()] = a.name.trim();
            }
          }
        }
        const avatars = await remoteService.avatarService.resolveAvatars(msg.emails, remotes, authorsMap);
        this.post({ type: 'LOG_AVATARS_RESOLVED', avatars });
        break;
      }

      case 'LOG_REQUEST_REMOTE_ACCOUNTS': {
        const accounts = await this.manager.remoteService?.getConnectedAccounts().catch(() => []) ?? [];
        this.post({ type: 'LOG_REMOTE_ACCOUNTS_RESULT', accounts });
        break;
      }

      case 'LOG_REVERT_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          const resolvedPath = repo.resolveRepoPath(msg.filePath);
          if (msg.fileStatus === 'A') {
            // File was added in this commit — reverting means deleting it from the working tree
            await this.deleteWorkingPath(repo, resolvedPath.relativePath);
          } else {
            await repo.revertFileToParent(msg.hash, resolvedPath.relativePath);
          }
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
          this.manager.notifyDataInvalidated({
            scopes: ['workingTree'],
            repoIds: [msg.repoId],
          });
        } catch (e: unknown) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          void showGitErrorMessage(t('VersionDock [{0}]: Cannot revert file: {1}', repoName, String(e)), {
            repoName,
            onUnlocked: async () => {
              await this.manager.getAllStatusesFresh();
              this.refresh({ repoIds: [msg.repoId] });
            },
          });
        }
        break;
      }

      case 'LOG_APPLY_COMMIT_PATHS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const uniqueEntries = Array.from(new Map(msg.entries.map(entry => [scopedKey(entry.repoId, entry.hash, entry.path), entry])).values());
        if (uniqueEntries.length === 0) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
          return;
        }
        const targetLabel = uniqueEntries.length === 1
          ? `'${uniqueEntries[0].path.split('/').pop() ?? uniqueEntries[0].path}'`
          : t('{0} paths', uniqueEntries.length);
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Apply changes from the selected commit scope to {1}?', repoName, targetLabel),
          { modal: true },
          t('Apply'),
        );
        if (confirm !== t('Apply')) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await this.applyCommitPathEntries(repo, uniqueEntries, 'apply');
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          this.manager.notifyDataInvalidated({
            scopes: ['workingTree'],
            repoIds: [msg.repoId],
          });
        } catch (e: unknown) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          void showGitErrorMessage(t('VersionDock [{0}]: Cannot apply selected changes: {1}', repoName, String(e)), {
            repoName,
            onUnlocked: async () => {
              await this.manager.getAllStatusesFresh();
              this.refresh({ repoIds: [msg.repoId] });
            },
          });
        }
        break;
      }

      case 'LOG_RESTORE_COMMIT_PATHS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const uniqueEntries = Array.from(new Map(msg.entries.map(entry => [scopedKey(entry.repoId, entry.hash, entry.path), entry])).values());
        if (uniqueEntries.length === 0) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
          return;
        }
        const targetLabel = uniqueEntries.length === 1
          ? `'${uniqueEntries[0].path.split('/').pop() ?? uniqueEntries[0].path}'`
          : t('{0} paths', uniqueEntries.length);
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Revert changes from the selected commit scope for {1}?', repoName, targetLabel),
          { modal: true },
          t('Revert'),
        );
        if (confirm !== t('Revert')) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await this.applyCommitPathEntries(repo, uniqueEntries, 'restore');
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          this.manager.notifyDataInvalidated({
            scopes: ['workingTree'],
            repoIds: [msg.repoId],
          });
        } catch (e: unknown) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          void showGitErrorMessage(t('VersionDock [{0}]: Cannot revert selected changes: {1}', repoName, String(e)), {
            repoName,
            onUnlocked: async () => {
              await this.manager.getAllStatusesFresh();
              this.refresh({ repoIds: [msg.repoId] });
            },
          });
        }
        break;
      }

      case 'LOG_CHECKOUT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath);
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Checking out "{1}"…', repoName, msg.branchName), cancellable: false },
          async () => {
            try {
              await repo.checkout(msg.branchName, msg.createNew, msg.from);
              // _pendingDetachedTag is cleared inside GitService.checkout().
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
              const merged = mergeCurrentIntoBranches(branches, current);
              this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
              this.post({ type: 'LOG_REFRESH' });
            } catch (e: unknown) {
              const errMsg = String(e);
              if (errMsg.includes('Your local changes') || errMsg.includes('overwritten by checkout')) {
                const stashAndCheckout = t('Stash and checkout');
                const bringChanges = t('Bring changes');
                const choice = await vscode.window.showWarningMessage(
                  t('VersionDock [{0}]: Your local changes would be overwritten by checkout. Choose how to handle them:', repoName),
                  stashAndCheckout, bringChanges, t('Cancel')
                );
                if (choice === stashAndCheckout) {
                  try {
                    await repo.runWithGitWriteLock(async () => {
                      await repo.stashPush(`WIP before checkout to ${msg.branchName}`);
                      await repo.checkout(msg.branchName, msg.createNew, msg.from);
                    });
                    this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
                    const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
                    const merged = mergeCurrentIntoBranches(branches, current);
                    this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
                    this.post({ type: 'LOG_REFRESH' });
                    vscode.window.showInformationMessage(t('VersionDock [{0}]: Changes stashed, switched to "{1}".', repoName, msg.branchName));
                    return;
                  } catch (err: unknown) {
                    this.showOperationError(err, undefined, repoName);
                  }
                } else if (choice === bringChanges) {
                  try {
                    await repo.runWithGitWriteLock(async () => {
                      await repo.stashPush(`WIP migrating to ${msg.branchName}`);
                      await repo.checkout(msg.branchName, msg.createNew, msg.from);
                      await repo.stashPop();
                    });
                    this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
                    const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
                    const merged = mergeCurrentIntoBranches(branches, current);
                    this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
                    this.post({ type: 'LOG_REFRESH' });
                    vscode.window.showInformationMessage(t('VersionDock [{0}]: Changes migrated to "{1}".', repoName, msg.branchName));
                    return;
                  } catch (err: unknown) {
                    this.showOperationError(err, undefined, repoName);
                  }
                }
              }
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
              this.showOperationError(e, undefined, repoName);
            }
          }
        );
        break;
      }

      case 'LOG_PULL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }

        const currentBranch = await repo.getCurrentBranch().catch(() => undefined);
        const isCurrent = !msg.branchName || msg.branchName === currentBranch?.name;
        let useRebase = false;
        if (repo.kind !== 'svn' && isCurrent) {
          const updateMethod = vscode.workspace
            .getConfiguration('versiondock')
            .get<'rebase' | 'merge' | 'prompt'>('updateProject.method', 'rebase');

          if (updateMethod === 'prompt') {
            const pick = await vscode.window.showQuickPick(
              [
                {
                  label: `$(repo-forked) ${t('Rebase the current branch on top of incoming changes')}`,
                  rebase: true,
                },
                {
                  label: `$(git-merge) ${t('Merge incoming changes into the current branch')}`,
                  rebase: false,
                },
              ],
              { title: t('Update Project — Strategy') }
            ) as { label: string; rebase: boolean } | undefined;

            if (!pick) return;
            useRebase = pick.rebase;
          } else {
            useRebase = updateMethod === 'rebase';
          }
        }

        const repoMeta = this.manager.getRepoMeta(msg.repoId);
        const repoName = repoMeta?.name || path.basename(repo.rootPath) || msg.repoId;

        let trackedResult: Awaited<ReturnType<UpdateSummaryService['run']>> | undefined;
        await this.manager.runWithStatusUpdatesSuppressed(async () => {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Updating…', repoName), cancellable: false },
            async () => {
              try {
                trackedResult = await this.updateSummaryService.run({
                  repoId: msg.repoId,
                  branchName: msg.branchName,
                  execute: target => {
                    if (repo.kind === 'svn') {
                      return msg.branchName ? target.pullBranch(msg.branchName) : target.pull();
                    }
                    if (isCurrent) {
                      return useRebase ? target.pullRebase() : target.pull();
                    }
                    return target.pullBranch(msg.branchName!);
                  },
                });
                if (!trackedResult.ok) throw new Error(trackedResult.error ?? t('Unknown error'));
                this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true, output: trackedResult.output });
                const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
                const merged = mergeCurrentIntoBranches(branches, current);
                this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
                this.manager.notifyBranchesChanged();
                this.refresh({ repoIds: [msg.repoId] });
              } catch (e: unknown) {
                this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
                this.showOperationError(e, undefined, repoName);
              }
            }
          );
        });
        if (trackedResult?.ok) await this.updateSummaryService.notify([trackedResult]);
        break;
      }

      case 'LOG_PUSH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoMeta = this.manager.getRepoMeta(msg.repoId);
        const repoName = repoMeta?.name || msg.repoId;
        const pushResult = await runPushWithProtection(repo, {
          repoName,
          force: msg.force,
          remote: msg.remote,
          logger: this.logger,
        });

        if (pushResult.success) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          if (!pushResult.rebased && !pushResult.forced) {
            void this.notifyPushSuccess(repo, undefined, msg.remote);
          }
          const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
          const merged = mergeCurrentIntoBranches(branches, current);
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
          this.manager.notifyBranchesChanged();
          this.manager.notifyDataInvalidated({
            scopes: ['unpushed'],
            repoIds: [msg.repoId],
          });
          this.refresh({ repoIds: [msg.repoId] });
        } else if (pushResult.cancelled) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
        } else {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(pushResult.error) });
          this.showOperationError(pushResult.error, undefined, repoName);
        }
        break;
      }

      case 'LOG_GET_REMOTES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: t('Repo not found') }); return; }
        try {
          const remotes = await repo.getRemotes();
          this.post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes });
        } catch (e: unknown) {
          this.post({ type: 'LOG_REMOTES_RESULT', requestId: msg.requestId, remotes: [], error: String(e) });
        }
        break;
      }

      case 'LOG_MERGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath);
        if (repo.kind === 'svn') {
          try {
            await repo.merge(msg.from);
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
            const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
            const merged = mergeCurrentIntoBranches(branches, current);
            this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
            this.manager.notifyBranchesChanged();
            this.refresh({ repoIds: [msg.repoId] });
            vscode.window.showInformationMessage(t('VersionDock [{0}]: Merged SVN branch "{1}" into the working copy.', repoName, msg.from));
          } catch (e: unknown) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
            this.showOperationError(e, t('VersionDock [{0}]: SVN merge failed', repoName), repoName);
          }
          break;
        }
        let dirtyError: unknown;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Merging "{1}"…', repoName, msg.from), cancellable: false },
          async () => {
            try {
              await repo.merge(msg.from);
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
              const merged = mergeCurrentIntoBranches(branches, current);
              this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
              this.manager.notifyBranchesChanged();
              this.refresh({ repoIds: [msg.repoId] });
            } catch (e: unknown) {
              const errMsg = String(e);
              const isDirty = errMsg.includes('Your local changes') || errMsg.includes('overwritten by merge') || (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree';
              if (isDirty) {
                dirtyError = e;
                return;
              }
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
              if (errMsg.includes('CONFLICT')) {
                const requestedTarget = this.replyTarget.getStore() ?? 'sidebar';
                const commitTarget = requestedTarget === 'undocked' && this.undockedPanel?.hasCommitPane()
                  ? 'undocked'
                  : 'sidebar';
                void repo.getCurrentBranch().then(current => {
                  const mergeMsg = `Merge branch '${msg.from}' into '${current.name}'`;
                  this.commitPanel?.prefillCommitMessage(mergeMsg, commitTarget);
                }).catch(() => {});
                const warning = t('VersionDock [{0}]: Merge conflicts detected. Review and resolve them in the Conflicts panel.', repoName);
                void vscode.window.showWarningMessage(warning, t('Open Conflict List')).then(choice => {
                  if (choice) void vscode.commands.executeCommand('versiondock.openConflicts');
                });
              } else {
                this.showOperationError(e, undefined, repoName);
              }
            }
          }
        );
        if (dirtyError) {
          const errMsg = String(dirtyError);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          const repoMeta = this.getNonWorktreeRepos().find(m => m.id === msg.repoId);
          const repoName = repoMeta?.name ?? msg.repoId;
          const pick = await vscode.window.showQuickPick(
            [
              { label: `$(archive) ${t('Stash and merge')}`, detail: t('Save local changes to stash, then merge'), value: 'stash' },
              { label: `$(close) ${t('Cancel')}`, detail: '', value: 'cancel' },
            ],
            {
              title: t('VersionDock [{0}]: Uncommitted changes', repoName),
              placeHolder: t('Local changes would be overwritten by merging "{0}"', msg.from),
              ignoreFocusOut: true,
            }
          );
          if (pick?.value === 'stash') {
            try {
              await repo.runWithGitWriteLock(async () => {
                await repo.stashPush(t('WIP before merge of {0}', msg.from));
                await repo.merge(msg.from);
              });
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
              const merged = mergeCurrentIntoBranches(branches, current);
              this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
              this.manager.notifyBranchesChanged();
              this.refresh({ repoIds: [msg.repoId] });
            } catch (e2: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e2) });
              this.showOperationError(e2, undefined, repoName);
            }
          }
        }
        break;
      }

      case 'LOG_REBASE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoMeta = this.getNonWorktreeRepos().find(m => m.id === msg.repoId);
        const repoName = repoMeta?.name ?? repo.meta.name ?? msg.repoId;
        try {
          await repo.rebase(msg.onto);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
          const merged = mergeCurrentIntoBranches(branches, current);
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
          this.manager.notifyBranchesChanged();
          this.refresh({ repoIds: [msg.repoId] });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, undefined, repoName);
        }
        break;
      }

      case 'LOG_COMPARE_WITH_CURRENT': {
        const target = await this.pickBranchTarget(msg.branches);
        if (!target) break;
        const repo = this.manager.getRepo(target.repoId);
        const meta = this.manager.getRepoMetas().find(item => item.id === target.repoId);
        if (!repo || !meta) break;
        try {
          const current = await repo.getCurrentBranch();
          const baseRef = repo.kind === 'svn'
            ? (current.detachedTag ?? current.detachedHash ?? current.name)
            : current.detachedTag
              ? `refs/tags/${current.detachedTag}`
              : (current.detachedHash ?? (current.fullName.startsWith('refs/heads/')
                  ? current.fullName
                  : `refs/heads/${current.name}`));
          if (this.replyTarget.getStore() !== 'undocked') {
            void this.focus();
          }
          this.post({
            type: 'LOG_COMPARE_STARTED',
            repoId: target.repoId,
            repoName: meta.name,
            baseRef,
            targetRef: target.branchName,
          });
        } catch (e: unknown) {
          this.showOperationError(e, t('VersionDock: Cannot start compare'), meta.name);
        }
        break;
      }

      case 'LOG_SHOW_WORKTREE_DIFF': {
        const target = await this.pickBranchTarget(msg.branches);
        if (!target) break;
        const targetRepoName = this.manager.getRepoMeta(target.repoId)?.name || target.repoId;
        try {
          await this.commitPanel?.startWorktreeDiff(
            target.repoId,
            target.branchName,
            this.replyTarget.getStore() ?? 'sidebar',
          );
        } catch (e: unknown) {
          this.showOperationError(e, t('VersionDock: Cannot open worktree diff'), targetRepoName);
        }
        break;
      }

      case 'LOG_REQUEST_COMPARE_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        const visible = this.getVisibleRepos().some(meta => meta.id === msg.repoId);
        if (!repo || !visible) {
          this.post({
            type: 'LOG_COMPARE_COMMITS_RESULT',
            requestId: msg.requestId,
            side: msg.side,
            commits: [],
            isLast: true,
            error: t('Repo not found'),
          });
          return;
        }
        try {
          const commits = await repo.getCompareLog(msg.limit, msg.skip, {
            baseRef: msg.baseRef,
            targetRef: msg.targetRef,
            side: msg.side,
            filterText: msg.filterText,
            filterAuthor: msg.filterAuthor,
            filterBranch: msg.filterBranch,
            filterDateFrom: msg.filterDateFrom,
            filterDateTo: msg.filterDateTo,
            filterPath: msg.filterPath,
          });
          this.post({
            type: 'LOG_COMPARE_COMMITS_RESULT',
            requestId: msg.requestId,
            side: msg.side,
            commits,
            isLast: commits.length < msg.limit,
          });
        } catch (e: unknown) {
          this.post({
            type: 'LOG_COMPARE_COMMITS_RESULT',
            requestId: msg.requestId,
            side: msg.side,
            commits: [],
            isLast: true,
            error: String(e),
          });
        }
        break;
      }

      case 'LOG_DELETE_BRANCH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Delete branch "{1}"?', repo.meta.name, msg.branchName), { modal: true }, t('Delete')
        );
        if (confirm !== t('Delete')) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.deleteBranch(msg.branchName, msg.force);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const branches = await repo.getBranches();
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, undefined, repo.meta.name);
        }
        break;
      }

      case 'LOG_DELETE_BRANCH_MULTI': {
        // Check if the branch is currently checked out in any of the target repos
        const checkedOutIn: string[] = [];
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          const current = await repo.getCurrentBranch().catch(() => null);
          if (current && (current.name === msg.branchName || current.detachedTag === msg.branchName)) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            checkedOutIn.push(meta?.name ?? repoId);
          }
        }
        const eligibleRepoIds = msg.repoIds.filter(id => {
          const meta = this.getNonWorktreeRepos().find(m => m.id === id);
          return !checkedOutIn.includes(meta?.name ?? id);
        });
        if (eligibleRepoIds.length === 0) {
          const singleName = msg.repoIds.length === 1 ? (this.manager.getRepoMeta(msg.repoIds[0])?.name ?? msg.repoIds[0]) : undefined;
          vscode.window.showWarningMessage(
            singleName
              ? t('VersionDock [{0}]: Cannot delete "{1}" — it is currently checked out.', singleName, msg.branchName)
              : t('VersionDock: Cannot delete "{0}" — it is currently checked out in all target repositories.', msg.branchName)
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Checked out' });
          return;
        }
        const skippedMsg = checkedOutIn.length > 0
          ? ` (skipped in: ${checkedOutIn.join(', ')} — currently checked out)`
          : '';
        const repoCount = eligibleRepoIds.length;
        const singleMeta = repoCount === 1 ? this.getNonWorktreeRepos().find(m => m.id === eligibleRepoIds[0]) : undefined;
        const confirm = await vscode.window.showWarningMessage(
          singleMeta
            ? t('VersionDock [{0}]: Delete branch "{1}"?{2}', singleMeta.name, msg.branchName, skippedMsg)
            : (repoCount === 1
                ? t('Delete branch "{0}" in {1} repository?{2}', msg.branchName, repoCount, skippedMsg)
                : t('Delete branch "{0}" in {1} repositories?{2}', msg.branchName, repoCount, skippedMsg)),
          { modal: true }, t('Delete'), t('Force Delete')
        );
        if (!confirm) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        const force = confirm === t('Force Delete');
        const errors: string[] = [];
        let succeededCount = 0;
        for (const repoId of eligibleRepoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await repo.deleteBranch(msg.branchName, force);
            const branches = await repo.getBranches();
            this.post({ type: 'LOG_REFS_UPDATE', repoId, branches });
            succeededCount++;
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          const singleName = eligibleRepoIds.length === 1 ? (this.manager.getRepoMeta(eligibleRepoIds[0])?.name ?? eligibleRepoIds[0]) : undefined;
          vscode.window.showWarningMessage(
            singleName
              ? t('VersionDock [{0}]: {1}', singleName, errors.join('; '))
              : succeededCount > 0
                ? t('VersionDock: Deleted branch "{0}" in {1} repos, {2} failed: {3}', msg.branchName, succeededCount, errors.length, errors.join('; '))
                : t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; '))
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.refresh({ repoIds: msg.repoIds, forceRemoteRefs: true });
        }
        break;
      }

      case 'LOG_FETCH_ALL': {
        const metas = this.manager.getRepoMetas();
        const title = metas.length === 1
          ? t('VersionDock [{0}]: Fetching all', metas[0].name)
          : t('VersionDock: Fetching all');
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title, cancellable: false },
          async () => { await this.manager.fetchAll(); }
        );
        this.manager.notifyBranchesChanged();
        this.refresh({ forceRemoteRefs: true });
        break;
      }

      case 'LOG_FETCH_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoMeta = this.manager.getRepoMeta(msg.repoId);
        const repoName = repoMeta?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          await repo.fetchAll();
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          if (repo.kind === 'svn') {
            this.manager.notifyBranchesChanged();
            this.refresh({ repoIds: [msg.repoId], forceRemoteRefs: true });
          } else {
            const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
            const merged = mergeCurrentIntoBranches(branches, current);
            this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
            this.manager.notifyBranchesChanged();
            this.refresh({ repoIds: [msg.repoId] });
          }
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, undefined, repoName);
        }
        break;
      }

      case 'LOG_CHERRY_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath);
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Cherry-picking commit {1}…', repoName, msg.hash.slice(0, 7)), cancellable: false },
            () => repo.cherryPick(msg.hash)
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.refresh({ repoIds: [msg.repoId] });
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
          this.manager.notifyDataInvalidated({
            scopes: ['workingTree', 'unpushed', 'subtree'],
            repoIds: [msg.repoId],
          });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            const choice = await vscode.window.showWarningMessage(
              t('VersionDock [{0}]: Cherry-pick of {1} has conflicts. Resolve them in the editor, then choose an action.', repoName, msg.hash.slice(0, 7)),
              t('Continue'), t('Skip'), t('Abort')
            );
            if (choice === t('Continue')) {
              await repo.cherryPickContinue();
              this.refresh({ repoIds: [msg.repoId] });
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
              this.manager.notifyDataInvalidated({
                scopes: ['workingTree', 'unpushed', 'subtree'],
                repoIds: [msg.repoId],
              });
            } else if (choice === t('Skip')) {
              await repo.cherryPickSkip();
              this.refresh({ repoIds: [msg.repoId] });
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
              this.manager.notifyDataInvalidated({
                scopes: ['workingTree', 'unpushed', 'subtree'],
                repoIds: [msg.repoId],
              });
            } else if (choice === t('Abort')) {
              await repo.cherryPickAbort();
              this.refresh({ repoIds: [msg.repoId] });
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
              this.manager.notifyDataInvalidated({
                scopes: ['workingTree', 'unpushed', 'subtree'],
                repoIds: [msg.repoId],
              });
              vscode.window.showInformationMessage(t('VersionDock [{0}]: Cherry-pick aborted. The repository has been restored.', repoName));
            }
          } else {
            void showGitErrorMessage(t('VersionDock [{0}]: Cherry-pick failed: {1}', repoName, errMsg), {
              repoName,
              onUnlocked: async () => {
                await this.manager.getAllStatusesFresh();
                this.refresh({ repoIds: [msg.repoId] });
              },
            });
          }
        }
        break;
      }

      case 'LOG_REVERT_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath);
        {
          const confirm = await vscode.window.showWarningMessage(
            t('VersionDock [{0}]: Revert commit {1}? This creates a new commit that undoes the changes.', repoName, msg.hash.slice(0, 7)),
            { modal: true }, t('Revert')
          );
          if (confirm !== t('Revert')) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Reverting commit {1}…', repoName, msg.hash.slice(0, 7)), cancellable: false },
            () => repo.revertCommit(msg.hash)
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.refresh({ repoIds: [msg.repoId] });
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
          this.manager.notifyDataInvalidated({
            scopes: ['workingTree', 'unpushed', 'subtree'],
            repoIds: [msg.repoId],
          });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            const choice = await vscode.window.showWarningMessage(
              t('VersionDock [{0}]: Revert of {1} has conflicts. Resolve them in the editor, then choose an action.', repoName, msg.hash.slice(0, 7)),
              t('Continue'), t('Abort')
            );
            if (choice === t('Continue')) {
              await repo.revertContinue();
              this.refresh({ repoIds: [msg.repoId] });
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
              this.manager.notifyDataInvalidated({
                scopes: ['workingTree', 'unpushed', 'subtree'],
                repoIds: [msg.repoId],
              });
            } else if (choice === t('Abort')) {
              await repo.revertAbort();
              this.refresh({ repoIds: [msg.repoId] });
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
              this.manager.notifyDataInvalidated({
                scopes: ['workingTree', 'unpushed', 'subtree'],
                repoIds: [msg.repoId],
              });
              vscode.window.showInformationMessage(t('VersionDock [{0}]: Revert aborted. The repository has been restored.', repoName));
            }
          } else {
            void showGitErrorMessage(t('VersionDock [{0}]: Revert failed: {1}', repoName, errMsg), {
              repoName,
              onUnlocked: async () => {
                await this.manager.getAllStatusesFresh();
                this.refresh({ repoIds: [msg.repoId] });
              },
            });
          }
        }
        break;
      }

      case 'LOG_RESET_TO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const modeLabel = msg.mode === 'hard' ? t('Hard Reset (discard all changes)') : msg.mode === 'mixed' ? t('Mixed Reset (keep unstaged)') : t('Soft Reset (keep staged)');
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Reset current branch to {1}? ({2})', repoName, msg.hash.slice(0, 7), modeLabel),
          { modal: true }, t('Reset')
        );
        if (confirm !== t('Reset')) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.resetTo(msg.hash, msg.mode);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.refresh({ repoIds: [msg.repoId] });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          void showGitErrorMessage(t('VersionDock [{0}]: Reset failed: {1}', repoName, String(e)), {
            repoName,
            onUnlocked: async () => {
              await this.manager.getAllStatusesFresh();
              this.refresh({ repoIds: [msg.repoId] });
            },
          });
        }
        break;
      }

      case 'LOG_CREATE_PATCH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          const patch = await repo.createPatch(msg.hash);
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${msg.hash.slice(0, 7)}.patch`),
            filters: { 'Patch files': ['patch'], 'All files': ['*'] },
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(patch, 'utf8'));
            vscode.window.showInformationMessage(t('VersionDock [{0}]: Patch saved to {1}', repoName, uri.fsPath));
          }
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Create patch failed'), repoName);
        }
        break;
      }

      case 'LOG_CHERRY_PICK_MULTI': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name ?? msg.repoId;
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Cherry-picking {1} commits…', repoName, msg.hashes.length), cancellable: false },
            () => repo.cherryPickMulti(msg.hashes)
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            const choice = await vscode.window.showWarningMessage(
              t('VersionDock [{0}]: Cherry-pick has conflicts. Resolve them, then choose an action.', repoName),
              t('Continue'), t('Skip'), t('Abort')
            );
            if (choice === t('Continue')) {
              await repo.cherryPickContinue();
              this.post({ type: 'LOG_REFRESH' });
              await this.manager.refreshStatusNow();
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
            } else if (choice === t('Skip')) {
              await repo.cherryPickSkip();
              this.post({ type: 'LOG_REFRESH' });
              await this.manager.refreshStatusNow();
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
            } else {
              await repo.cherryPickAbort();
            }
          } else {
            this.showOperationError(errMsg, t('VersionDock: Cherry-pick failed'), repoName);
          }
        }
        break;
      }

      case 'LOG_REVERT_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name ?? msg.repoId;
        {
          const confirm = await vscode.window.showWarningMessage(
            t('VersionDock [{0}]: Revert {1} commits? This creates new commits that undo the changes.', repoName, msg.hashes.length),
            { modal: true }, t('Revert')
          );
          if (confirm !== t('Revert')) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Reverting {1} commits…', repoName, msg.hashes.length), cancellable: false },
            () => repo.revertCommits(msg.hashes)
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            const choice = await vscode.window.showWarningMessage(
              t('VersionDock [{0}]: Revert has conflicts. Resolve them, then choose an action.', repoName),
              t('Continue'), t('Abort')
            );
            if (choice === t('Continue')) {
              await repo.revertContinue();
              this.post({ type: 'LOG_REFRESH' });
              await this.manager.refreshStatusNow();
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
            } else {
              await repo.revertAbort();
            }
          } else {
            this.showOperationError(errMsg, t('VersionDock: Revert failed'), repoName);
          }
        }
        break;
      }

      case 'LOG_DROP_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Drop {1} commits? This rewrites history and cannot be undone.', repoName, msg.hashes.length),
          { modal: true }, t('Drop')
        );
        if (confirm !== t('Drop')) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Dropping {1} commits…', repoName, msg.hashes.length), cancellable: false },
            () => repo.dropCommits(msg.oldestHash)
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Drop commits failed'), repoName);
        }
        break;
      }

      case 'LOG_CREATE_PATCH_MULTI': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          const folderUris = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            canSelectMany: false,
            openLabel: t('Save patches here'),
          });
          if (!folderUris || folderUris.length === 0) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
            return;
          }
          const folderPath = folderUris[0].fsPath;
          const path = await import('path');
          for (const hash of msg.hashes) {
            const patch = await repo.createPatch(hash);
            const filePath = path.join(folderPath, `${hash.slice(0, 7)}.patch`);
            await vscode.workspace.fs.writeFile(vscode.Uri.file(filePath), Buffer.from(patch, 'utf8'));
          }
          vscode.window.showInformationMessage(t('VersionDock [{0}]: {1} patches saved to {2}', repoName, msg.hashes.length, folderPath));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Create patches failed'), repoName);
        }
        break;
      }

      case 'LOG_DROP_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Drop commit {1}? This rewrites history. Only drop unpushed commits — dropping a pushed commit will require a force push.', repoName, msg.hash.slice(0, 7)),
          { modal: true }, t('Drop')
        );
        if (confirm !== t('Drop')) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Dropping commit {1}…', repoName, msg.hash.slice(0, 7)), cancellable: false },
            () => repo.dropCommit(msg.hash)
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Drop commit failed'), repoName);
        }
        break;
      }

      case 'LOG_SQUASH_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const squashValidation = await repo.canSquashCommitRange(msg.hashes);
        if (!squashValidation.ok || !squashValidation.oldestHash) {
          const reason = squashValidation.reason ?? t('Selected commits cannot be squashed.');
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: reason });
          vscode.window.showWarningMessage(t('VersionDock [{0}]: {1}', repoName, reason));
          return;
        }
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
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Cancelled') });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Squashing {1} commits…', repoName, squashValidation.hashes.length), cancellable: false },
            () => repo.squashCommits(squashValidation.hashes, result.message),
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Squash completed.', repoName));
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Squash failed'), repoName);
        }
        break;
      }

      case 'LOG_OPEN_AI_COMPOSER': {
        if (!this.aiCommitComposerProvider) {
          vscode.window.showErrorMessage(t('VersionDock: AI Commit Composer is unavailable.'));
          return;
        }
        this.aiCommitComposerProvider.openHistory(msg.repoId, msg.hashes);
        break;
      }

      case 'LOG_UNDO_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const confirm = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Undo last commit? Changes will be moved back to the staged area.', repoName),
          { modal: true }, t('Undo Commit')
        );
        if (confirm !== t('Undo Commit')) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.undoCommit();
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Undo commit failed'), repoName);
        }
        break;
      }

      case 'LOG_EDIT_COMMIT_MESSAGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
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
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Cancelled') });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Updating commit message…', repoName), cancellable: false },
            () => repo.rewordCommit(result.message),
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Commit message updated.', repoName));
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Edit commit message failed'), repoName);
        }
        break;
      }

      case 'LOG_NEW_BRANCH_FROM_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const shortRef = msg.hash.slice(0, 7);
        const branchName = await vscode.window.showInputBox({
          prompt: repo.kind === 'svn' ? t('Create SVN branch from revision {0}', shortRef) : t('Create new branch from {0}', shortRef),
          placeHolder: t('my-feature-branch'),
          validateInput: v => validateBranchNameInput(v),
        });
        if (!branchName) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.createBranchFromCommit(sanitizeBranchName(branchName.trim()), msg.hash);
          const branches = await repo.getBranches();
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Create branch failed'), repoName);
        }
        break;
      }

      case 'LOG_CREATE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const shortRef = msg.hash.slice(0, 7);
        const tagName = await vscode.window.showInputBox({
          prompt: repo.kind === 'svn' ? t('Create SVN tag from revision {0}', shortRef) : t('Tag name for commit {0}', shortRef),
          placeHolder: t('v1.0.0'),
          validateInput: v => v.trim() ? undefined : t('Tag name cannot be empty'),
        });
        if (!tagName) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.createTag(tagName.trim(), msg.hash);
          await this.refreshTags(msg.repoId, repo);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Create tag failed'), repoName);
        }
        break;
      }

      case 'LOG_REQUEST_COMMIT_BRANCHES': {
        const repo = this.manager.getRepo(msg.repoId);
        const branches = repo
          ? await repo.getBranchesContaining(msg.hash).catch(() => ({ local: [], remote: [], tags: [] }))
          : { local: [], remote: [], tags: [] };
        this.post({ type: 'LOG_COMMIT_BRANCHES_RESULT', requestId: msg.requestId, branches });
        break;
      }

      case 'LOG_REQUEST_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          await this.refreshTags(msg.repoId, repo);
        } catch { /* ignore */ }
        break;
      }

      case 'LOG_REQUEST_COMMIT_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        const tags = repo ? await repo.getTagsForCommit(msg.hash).catch(() => []) : [];
        this.post({ type: 'LOG_COMMIT_TAGS_RESULT', requestId: msg.requestId, tags });
        break;
      }

      case 'LOG_MANAGE_COMMIT_TAGS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const tags = await repo.getTagsForCommit(msg.hash).catch(() => [] as string[]);
        if (tags.length === 0) {
          vscode.window.showInformationMessage(t('VersionDock [{0}]: No tags on this commit.', repoName));
          return;
        }
        await this.showManageCommitTagsMenu(repo, msg.repoId, msg.hash, tags, msg.currentBranch);
        break;
      }

      case 'LOG_DELETE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        try {
          await repo.deleteTag(msg.tagName);
          await this.refreshTags(msg.repoId, repo);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Delete tag failed'), repoName);
        }
        break;
      }

      case 'LOG_DELETE_TAG_MULTI': {
        // Tags can't be "checked out" in the same sense, but prevent deleting the
        // tag that HEAD is currently detached on.
        const checkedOutTagIn: string[] = [];
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          const current = await repo.getCurrentBranch().catch(() => null);
          if (current?.detachedTag === msg.tagName) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            checkedOutTagIn.push(meta?.name ?? repoId);
          }
        }
        const eligibleRepoIds = msg.repoIds.filter(id => {
          const meta = this.getNonWorktreeRepos().find(m => m.id === id);
          return !checkedOutTagIn.includes(meta?.name ?? id);
        });
        if (eligibleRepoIds.length === 0) {
          const singleName = msg.repoIds.length === 1 ? (this.manager.getRepoMeta(msg.repoIds[0])?.name ?? msg.repoIds[0]) : undefined;
          vscode.window.showWarningMessage(
            singleName
              ? t('VersionDock [{0}]: Cannot delete tag "{1}" — HEAD is detached on it.', singleName, msg.tagName)
              : t('VersionDock: Cannot delete tag "{0}" — HEAD is detached on it in all target repositories.', msg.tagName)
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Checked out' });
          return;
        }
        const skippedMsg = checkedOutTagIn.length > 0
          ? ` (skipped in: ${checkedOutTagIn.join(', ')} — HEAD detached on this tag)`
          : '';
        const repoCount = eligibleRepoIds.length;
        const singleMeta = repoCount === 1 ? this.getNonWorktreeRepos().find(m => m.id === eligibleRepoIds[0]) : undefined;
        const choice = await (async (): Promise<DeleteTagChoice> => {
          const pick = await vscode.window.showWarningMessage(
            singleMeta
              ? t('VersionDock [{0}]: Delete tag "{1}"?{2}', singleMeta.name, msg.tagName, skippedMsg)
              : (repoCount === 1
                  ? t('Delete tag "{0}" in {1} repository?{2}', msg.tagName, repoCount, skippedMsg)
                  : t('Delete tag "{0}" in {1} repositories?{2}', msg.tagName, repoCount, skippedMsg)),
            { modal: true }, t('Delete Local'), t('Delete on Remote'), t('Delete Local and Remote')
          );
          if (!pick) return null;
          if (pick === t('Delete on Remote')) return 'remote';
          if (pick === t('Delete Local and Remote')) return 'both';
          return 'local';
        })();
        if (!choice) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        const errors: string[] = [];
        let succeededCount = 0;
        for (const repoId of eligibleRepoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
          try {
            await deleteTagWithRemoteOption(repo, msg.tagName, choice, meta?.name ?? repoId);
            await this.refreshTags(repoId, repo);
            succeededCount++;
          } catch (e: unknown) {
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          const singleName = eligibleRepoIds.length === 1 ? (this.manager.getRepoMeta(eligibleRepoIds[0])?.name ?? eligibleRepoIds[0]) : undefined;
          vscode.window.showWarningMessage(
            singleName
              ? t('VersionDock [{0}]: {1}', singleName, errors.join('; '))
              : succeededCount > 0
                ? t('VersionDock: Deleted tag "{0}" in {1} repos, {2} failed: {3}', msg.tagName, succeededCount, errors.length, errors.join('; '))
                : t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; '))
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        this.post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_PUSH_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Pushing tag "{1}" to {2}…', repoName, msg.tagName, msg.remote), cancellable: false },
          async () => {
            try {
              await repo.pushTag(msg.tagName, msg.remote);
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              vscode.window.showInformationMessage(t('VersionDock [{0}]: Tag "{1}" pushed to "{2}".', repoName, msg.tagName, msg.remote));
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
              this.showOperationError(e, t('VersionDock: Push tag failed'), repoName);
            }
          }
        );
        break;
      }

      case 'LOG_CHECKOUT_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Checking out tag "{1}"…', repoName, msg.tagName), cancellable: false },
          async () => {
            try {
              await repo.checkoutTag(msg.tagName);
              // _pendingDetachedTag is now set inside GitService.checkoutTag().
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              const branches = await repo.getBranches();
              const detachedHeadEntry: BranchInfo = {
                repoId: msg.repoId,
                name: 'HEAD',
                fullName: 'HEAD',
                isHead: true,
                isRemote: false,
                detachedTag: msg.tagName,
              };
              this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: [...branches, detachedHeadEntry] });
              this.post({ type: 'LOG_REFRESH' });
              vscode.window.showInformationMessage(t('VersionDock [{0}]: Checked out tag "{1}" (detached HEAD).', repoName, msg.tagName));
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
              this.showOperationError(e, t('VersionDock: Checkout tag failed'), repoName);
            }
          }
        );
        break;
      }

      case 'LOG_MERGE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Merging tag "{1}"…', repoName, msg.tagName), cancellable: false },
          async () => {
            try {
              await repo.mergeTag(msg.tagName);
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              this.refresh({ repoIds: [msg.repoId] });
              await this.manager.refreshStatusNow();
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
              vscode.window.showInformationMessage(t('VersionDock [{0}]: Merged tag "{1}".', repoName, msg.tagName));
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
              this.showOperationError(e, t('VersionDock: Merge tag failed'), repoName);
            }
          }
        );
        break;
      }

      case 'LOG_MERGE_TAG_MULTI': {
        const errors: string[] = [];
        let succeededCount = 0;
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await repo.mergeTag(msg.tagName);
            succeededCount++;
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          const singleName = msg.repoIds.length === 1 ? (this.manager.getRepoMeta(msg.repoIds[0])?.name ?? msg.repoIds[0]) : undefined;
          vscode.window.showWarningMessage(
            singleName
              ? t('VersionDock [{0}]: {1}', singleName, errors.join('; '))
              : succeededCount > 0
                ? t('VersionDock: Merged tag "{0}" in {1} repos, {2} failed: {3}', msg.tagName, succeededCount, errors.length, errors.join('; '))
                : t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; '))
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else if (msg.repoIds.length === 1) {
          const singleName = this.manager.getRepoMeta(msg.repoIds[0])?.name ?? msg.repoIds[0];
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Merged tag "{1}".', singleName, msg.tagName));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } else {
          vscode.window.showInformationMessage(t('VersionDock: Merged tag "{0}" in {1} repositories.', msg.tagName, succeededCount));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        this.refresh({ repoIds: msg.repoIds });
        await this.manager.refreshStatusNow();
        this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
        break;
      }

      case 'LOG_RESET_TO_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        type ModeItem = vscode.QuickPickItem & { mode: 'soft' | 'mixed' | 'hard' };
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const pick = await vscode.window.showQuickPick(
          [
            { label: `$(arrow-down) ${t('Soft')}`, description: t('Keep staged and unstaged changes'), mode: 'soft' as const },
            { label: `$(discard) ${t('Mixed')}`, description: t('Keep unstaged changes, unstage staged changes'), mode: 'mixed' as const },
            { label: `$(trash) ${t('Hard')}`, description: t('Discard all local changes'), mode: 'hard' as const },
          ] satisfies ModeItem[],
          { title: t('Reset Current Branch to {0}', msg.hash.slice(0, 7)) }
        ) as ModeItem | undefined;
        if (!pick) return;
        const reqId = msg.hash + pick.mode;
        try {
          await repo.resetTo(msg.hash, pick.mode);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: reqId, ok: true });
          this.refresh({ repoIds: [msg.repoId] });
          await this.manager.refreshStatusNow();
          this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: reqId, ok: false, error: String(e) });
          this.showOperationError(e, t('VersionDock: Reset failed'), repoName);
        }
        break;
      }

      case 'LOG_PUSH_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        const remotePick = remotes.length === 1
          ? remotes[0]
          : remotes.length > 1
            ? (await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: t('Push — Select remote') }
            ) as { label: string; remote: string } | undefined)?.remote
            : undefined;
        if (remotes.length > 1 && !remotePick) return;
        const repoMeta = this.manager.getRepoMeta(msg.repoId);
        const repoName = repoMeta?.name || msg.repoId;
        const pushResult = await runPushWithProtection(repo, {
          repoName,
          remote: remotePick,
          logger: this.logger,
        });
        if (pushResult.success) {
          if (!pushResult.rebased && !pushResult.forced) {
            vscode.window.showInformationMessage(remotePick
              ? t('VersionDock [{0}]: Pushed to "{1}" successfully.', repoName, remotePick)
              : t('VersionDock [{0}]: Remote created and branch pushed successfully.', repoName));
          }
          this.manager.notifyDataInvalidated({
            scopes: ['unpushed'],
            repoIds: [msg.repoId],
          });
        } else if (!pushResult.cancelled) {
          this.showOperationError(pushResult.error, t('VersionDock: Push failed'), repoName);
        }
        this.refresh({ repoIds: [msg.repoId] });
        await this.manager.refreshStatusNow();
        break;
      }

      case 'LOG_PUSH_TAG_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) { vscode.window.showWarningMessage(t('VersionDock [{0}]: No remotes configured.', repoName)); return; }
        const remotePick = remotes.length === 1
          ? remotes[0]
          : (await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: t('Push tag "{0}" — Select remote', msg.tagName) }
            ) as { label: string; remote: string } | undefined)?.remote;
        if (!remotePick) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Pushing tag "{1}" to {2}…', repoName, msg.tagName, remotePick), cancellable: false },
          async () => {
            try {
              await repo.pushTag(msg.tagName, remotePick);
              vscode.window.showInformationMessage(t('VersionDock [{0}]: Tag "{1}" pushed to "{2}".', repoName, msg.tagName, remotePick));
            } catch (e: unknown) {
              this.showOperationError(e, t('VersionDock: Push tag failed'), repoName);
            }
          }
        );
        break;
      }

      case 'LOG_REQUEST_COMMIT_MESSAGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
          this.post({ type: 'LOG_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, fullMessage: '', error: t('Repo not found') });
          return;
        }
        try {
          const fullMessage = (await repo.getFullCommitMessage(msg.hash)).replace(/\r\n/g, '\n').trimEnd();
          this.post({ type: 'LOG_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, fullMessage });
        } catch (e: unknown) {
          this.post({ type: 'LOG_COMMIT_MESSAGE_RESULT', requestId: msg.requestId, fullMessage: '', error: String(e) });
        }
        break;
      }

      case 'LOG_SHOW_BRANCH_OPTIONS': {
        await vscode.commands.executeCommand('versiondock.showBranchOptions', msg.repoId, msg.branchName);
        break;
      }

      case 'LOG_CHECKOUT_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const repoName = this.manager.getRepoMeta(msg.repoId)?.name || path.basename(repo.rootPath) || msg.repoId;
        let target: string;
        if (msg.branchName) {
          type CheckoutItem = vscode.QuickPickItem & { value: 'branch' | 'revision' };
          const isSvn = repo.kind === 'svn';
          const pick = await vscode.window.showQuickPick<CheckoutItem>(
            [
              { label: `$(arrow-right) ${isSvn ? t("Switch to '{0}'", msg.branchName) : t("Checkout branch '{0}'", msg.branchName)}`, description: msg.branchName, value: 'branch' },
              { label: `$(git-commit) ${isSvn ? t('Update to Revision') : t('Checkout revision (detached HEAD)')}`, description: msg.hash.slice(0, 8), value: 'revision' },
            ],
            { title: isSvn ? t('SVN Switch / Update') : t('Checkout') }
          );
          if (!pick) break;
          target = pick.value === 'branch' ? msg.branchName : msg.hash;
        } else {
          target = msg.hash;
        }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: Checking out "{1}"…', repoName, target), cancellable: false },
          async () => {
            try {
              await repo.checkout(target);
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
              const merged = mergeCurrentIntoBranches(branches, current);
              this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
              await this.manager.refreshStatusNow();
              this.manager.notifyBranchesChanged({ refreshStatus: false, refreshDerivedData: false });
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
              this.showOperationError(e, undefined, repoName);
            }
          }
        );
        break;
      }

      case 'LOG_OPEN_EXTENDED_DETAIL': {
        const { openCommitDetailPanel } = await import('./CommitDetailPanel');
        await openCommitDetailPanel(
          this.extensionUri,
          this.manager,
          this.aiCommitExplanationService,
          this.logger,
          msg.repoId,
          msg.hash,
          false,
          {
            initialCommit: msg.initialCommit,
            initialFiles: msg.initialFiles,
            initialMergeParentChanges: msg.initialMergeParentChanges,
          },
        );
        break;
      }

      case 'LOG_OPEN_EXTENDED_DETAIL_MULTI': {
        const { openAggregatedCommitDetailPanel } = await import('./CommitDetailPanel');
        await openAggregatedCommitDetailPanel(this.extensionUri, this.manager, this.aiCommitExplanationService, this.logger, msg.commits);
        break;
      }

      case 'LOG_OPEN_AI_EXPLANATION': {
        const { openCommitDetailPanel } = await import('./CommitDetailPanel');
        await openCommitDetailPanel(this.extensionUri, this.manager, this.aiCommitExplanationService, this.logger, msg.repoId, msg.hash, true);
        break;
      }

      case 'LOG_OPEN_AI_EXPLANATION_MULTI': {
        const { openAggregatedCommitDetailPanel } = await import('./CommitDetailPanel');
        await openAggregatedCommitDetailPanel(this.extensionUri, this.manager, this.aiCommitExplanationService, this.logger, msg.commits, true);
        break;
      }

      case 'LOG_OPEN_COMMIT_CHANGES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        const title = t('Changes in {0}', msg.hash.slice(0, 8));
        const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
        if (activeTab?.label && (activeTab.label === title || activeTab.label.startsWith(title))) {
          break;
        }
        const files = msg.files && msg.files.length > 0
          ? msg.files
          : await repo.getCommitFiles(msg.hash);
        if (repo.kind === 'svn') {
          const svnRepo = repo as SvnService;
          const fromRef = `r${Math.max(0, Number(msg.hash.replace(/^r/i, '')) - 1)}`;
          const toRef = msg.hash;
          const resources = this.buildSvnCommitChangeResourcesSync(
            svnRepo,
            fromRef,
            toRef,
            files,
          );
          if (resources.length === 0) {
            await vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN file changes to open.', this.manager.getRepoMeta(msg.repoId)?.name || msg.repoId));
            break;
          }
          await vscode.commands.executeCommand(
            'vscode.changes',
            title,
            resources,
          );
          void svnRepo.prefetchRevisionFiles(toRef, files);
          break;
        }
        const commitMeta = await repo.getCommitMeta(msg.hash);
        const parentHash = commitMeta.parents[0] ?? EMPTY_TREE;
        const gitUri = (ref: string, filePath: string): vscode.Uri => {
          const fileUri = vscode.Uri.file(repo.resolveRepoPath(filePath).absolutePath);
          return vscode.Uri.from({
            scheme: 'git',
            path: fileUri.path,
            query: JSON.stringify({ path: fileUri.fsPath, ref }),
          });
        };
        const resources = files
          .filter(file => file.status !== 'U')
          .map(file => {
            const relativePath = repo.resolveRepoPath(file.path).relativePath;
            const label = vscode.Uri.file(repo.resolveRepoPath(relativePath).absolutePath);
            const original = gitUri(file.status === 'A' ? EMPTY_TREE : parentHash, relativePath);
            const modified = gitUri(file.status === 'D' ? EMPTY_TREE : msg.hash, relativePath);
            return [label, original, modified] as [vscode.Uri, vscode.Uri, vscode.Uri];
          });
        await vscode.commands.executeCommand('vscode.changes', title, resources);
        break;
      }

      case 'LOG_OPEN_COMMIT_CHANGES_MULTI': {
        const resources: ChangesResource[] = [];
        for (const group of msg.groups) {
          const repo = this.manager.getRepo(group.repoId);
          if (!repo) continue;
          const normalizedFiles = group.files.map(f => typeof f === 'string' ? { path: f, status: undefined } : f);
          if (repo.kind === 'svn') {
            const svnRepo = repo as SvnService;
            const fromRef = group.fromHash ?? `r${Math.max(0, Number(group.toHash.replace(/^r/i, '')) - 1)}`;
            const toRef = group.toHash;
            resources.push(...this.buildSvnCommitChangeResourcesSync(
              svnRepo,
              fromRef,
              toRef,
              normalizedFiles,
            ));
            void svnRepo.prefetchRevisionFiles(toRef, normalizedFiles);
            continue;
          }
          const gitUri = (ref: string, filePath: string): vscode.Uri => {
            const fileUri = vscode.Uri.file(repo.resolveRepoPath(filePath).absolutePath);
            return vscode.Uri.from({
              scheme: 'git',
              path: fileUri.path,
              query: JSON.stringify({ path: fileUri.fsPath, ref }),
            });
          };
          for (const file of normalizedFiles) {
            const relativePath = repo.resolveRepoPath(file.path).relativePath;
            const label = vscode.Uri.file(repo.resolveRepoPath(relativePath).absolutePath);
            resources.push([
              label,
              gitUri(group.fromHash || EMPTY_TREE, relativePath),
              gitUri(group.toHash, relativePath),
            ]);
          }
        }
        if (resources.length === 0) {
          const singleRepoId = msg.groups.every(g => g.repoId === msg.groups[0]?.repoId) ? msg.groups[0]?.repoId : undefined;
          const singleRepoName = singleRepoId ? (this.manager.getRepoMeta(singleRepoId)?.name ?? singleRepoId) : undefined;
          await vscode.window.showInformationMessage(
            singleRepoName
              ? t('VersionDock [{0}]: No changed files', singleRepoName)
              : t('VersionDock: No changed files')
          );
          break;
        }
        await vscode.commands.executeCommand('vscode.changes', t('Aggregated commit selection'), resources);
        break;
      }

      case 'LOG_UNDOCK': {
        if (!this.undockedPanel) break;
        if (msg.target === 'pick') {
          await this.undockedPanel.pickAndOpen();
        } else {
          this.undockedPanel.open(msg.target);
        }
        break;
      }
    }
  }

  private async showManageCommitTagsMenu(
    repo: import('../git/GitService').GitService,
    repoId: string,
    hash: string,
    tags: string[],
    currentBranch: string,
  ): Promise<void> {
    const repoName = this.manager.getRepoMeta(repoId)?.name || path.basename(repo.rootPath) || repoId;
    type TagListItem = vscode.QuickPickItem & { tagName: string | null };

    // Step 1: always show the tag list + "New Tag..." so the user picks a tag first
    const tagListItems: TagListItem[] = [
      { label: `$(add) ${t('New Tag...')}`, tagName: null },
      { label: '', kind: vscode.QuickPickItemKind.Separator, tagName: null },
      ...tags.map(t => ({ label: `$(tag) ${t}`, tagName: t })),
    ];

    const tagPick = await vscode.window.showQuickPick(tagListItems, {
      title: t('Tags on commit {0}', hash.slice(0, 7)),
      placeHolder: t('Select a tag or create a new one'),
    }) as TagListItem | undefined;
    if (!tagPick) return;

    // "New Tag..." selected
    if (tagPick.tagName === null) {
      const newName = await vscode.window.showInputBox({
        prompt: t('Tag name for commit {0}', hash.slice(0, 7)),
        placeHolder: t('v1.0.0'),
        validateInput: v => v.trim() ? undefined : t('Tag name cannot be empty'),
      });
      if (!newName) return;
      try {
        await repo.createTag(newName.trim(), hash);
        await this.refreshTags(repoId, repo);
        this.refresh({ repoIds: [repoId] });
      } catch (e: unknown) {
        this.showOperationError(e, t('VersionDock: Create tag failed'), repoName);
      }
      return;
    }

    // Step 2: show actions for the selected tag
    const tagName = tagPick.tagName;
    type ActionItem = vscode.QuickPickItem & { action: () => Promise<void> | void };
    const actionItems: ActionItem[] = [
      {
        label: `$(arrow-left) ${t('Back')}`,
        action: () => this.showManageCommitTagsMenu(repo, repoId, hash, tags, currentBranch),
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(git-merge) ${t('Merge "{0}" into "{1}"', tagName, currentBranch)}`,
        action: async () => {
          try {
            await repo.mergeTag(tagName);
            this.refresh({ repoIds: [repoId] });
            vscode.window.showInformationMessage(t('VersionDock [{0}]: Merged tag "{1}" into "{2}".', repoName, tagName, currentBranch));
          } catch (e: unknown) {
            this.showOperationError(e, t('VersionDock: Merge tag failed'), repoName);
          }
        },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(trash) ${t('Delete "{0}"', tagName)}`,
        action: async () => {
          const choice = await confirmDeleteTag(t('VersionDock [{0}]: Delete tag "{1}"?', repoName, tagName));
          if (!choice) return;
          try {
            await deleteTagWithRemoteOption(repo, tagName, choice, repoName);
            await this.refreshTags(repoId, repo);
            this.refresh({ repoIds: [repoId] });
            vscode.window.showInformationMessage(t('VersionDock [{0}]: Deleted tag "{1}".', repoName, tagName));
          } catch (e: unknown) {
            this.showOperationError(e, t('VersionDock: Delete tag failed'), repoName);
          }
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(actionItems, {
      title: t('Tag: {0}', tagName),
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  private async notifyPushSuccess(repo: GitService, branchName?: string, remoteName?: string): Promise<void> {
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

  dispose(): void {
    this.managerListeners.forEach(d => d.dispose());
    this.disposables.forEach(d => d.dispose());
    if (this.refreshDebounce) { clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }
}
