import * as vscode from 'vscode';
import { getWebviewHtml } from '../utils/webviewHtml';
import { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { LogCommitPathEntry, LogToHostMsg, HostToLogMsg } from '../types/messages';
import type { BranchInfo, LineRange } from '../types/git';
import { loadIconTheme } from '../utils/IconThemeService';
import { ShelveDocumentProvider } from '../utils/ShelveDocumentProvider';
import type { CommitPanelProvider } from './CommitPanelProvider';
import type { UndockedPanelProvider } from './UndockedPanelProvider';
import { t } from '../utils/l10n';
import { openSquashEditor } from './SquashEditorPanel';
import { openEditMessageEditor } from './EditMessageEditorPanel';
import { formatRepoLabel } from '../utils/repoLabels';
import { toGitUri } from '../utils/resourceUri';
import type { SvnService } from '../svn/SvnService';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const SVN_CHANGE_RESOURCE_CONCURRENCY = 4;

function mergeCurrentIntoBranches(branches: BranchInfo[], current: BranchInfo): BranchInfo[] {
  if (!current.detachedTag && !current.detachedHash) return branches; // normal branch — already in list
  const filtered = branches.filter(b => !(b.repoId === current.repoId && b.isHead));
  return [...filtered, current];
}

type DeleteTagChoice = 'local' | 'remote' | 'both' | null;
type HistoryFilter = { repoId: string; filePath: string; lineRange?: LineRange };
type ChangesResource = [vscode.Uri, vscode.Uri, vscode.Uri];

async function confirmDeleteTag(tagName: string, title: string): Promise<DeleteTagChoice> {
  const pick = await vscode.window.showWarningMessage(
    t('Delete tag "{0}"?', tagName),
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
      vscode.window.showWarningMessage(t('VersionDock: No remotes configured.'));
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
    vscode.window.showWarningMessage(t('VersionDock: Tag "{0}" deleted locally, but no remotes configured.', tagName));
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
  private commitPanel?: CommitPanelProvider;
  private undockedPanel?: UndockedPanelProvider;
  private activeReplyTarget: 'sidebar' | 'undocked' = 'sidebar';
  private readonly replyTargetByRequestId = new Map<string, 'sidebar' | 'undocked'>();
  private readonly svnDiffOpenTasks = new Map<string, Promise<void>>();
  private pendingHistoryFilter?: HistoryFilter;
  private hiddenRepoIds: string[] = [];
  private pendingFilterRepoId: string | null = null;
  private pendingFilterBranch: string | null = null;

  setCommitPanel(provider: CommitPanelProvider): void {
    this.commitPanel = provider;
  }

  setUndockedPanel(provider: UndockedPanelProvider): void {
    this.undockedPanel = provider;
  }

  handleUndockedMessage(msg: LogToHostMsg, _provider: UndockedPanelProvider): void {
    if (msg.type === 'LOG_UNDOCK') return;
    this.activeReplyTarget = 'undocked';
    this.handleMessage(msg, 'undocked').finally(() => { this.activeReplyTarget = 'sidebar'; });
  }

  notifyHiddenReposChanged(hiddenRepoIds: string[]): void {
    this.hiddenRepoIds = hiddenRepoIds;
    this.getFilteredBranches().then(branches => {
      this.post({ type: 'LOG_INIT_DATA', repos: this.getVisibleRepos(), branches });
    });
  }

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly shelveDocProvider: ShelveDocumentProvider
  ) {
    // Register manager listeners here so they fire even when the panel has never been opened.
    // this.post() silently drops messages when the webview is not yet resolved — that's fine,
    // because resolveWebviewView performs an explicit initial sync when the panel first opens.
    this.managerListeners.push(
      this.manager.onBranchChange(async () => {
        const repos = this.getVisibleRepos();
        const branches = await this.getFilteredBranches();
        this.post({ type: 'LOG_INIT_DATA', repos, branches });
        if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
        this.refreshDebounce = setTimeout(() => this.post({ type: 'LOG_REFRESH' }), 300);
      }),
      this.manager.onReposChange(async () => {
        const repos = this.getVisibleRepos();
        const branches = await this.getFilteredBranches();
        this.post({ type: 'LOG_INIT_DATA', repos, branches });
        if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
        this.refreshDebounce = setTimeout(() => this.post({ type: 'LOG_REFRESH' }), 300);
      })
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
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
      (msg: LogToHostMsg) => this.handleMessage(msg, 'sidebar'),
      null,
      this.disposables
    );

    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('workbench.iconTheme') || e.affectsConfiguration('workbench.colorTheme')) {
          if (this.view) {
            loadIconTheme(this.view.webview).then(iconTheme => {
              this.post({ type: 'LOG_ICON_THEME_UPDATE', iconTheme });
            });
          }
        }
      })
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.pendingFilterRepoId !== null) {
        const repoId = this.pendingFilterRepoId;
        const branch = this.pendingFilterBranch;
        this.pendingFilterRepoId = null;
        this.pendingFilterBranch = null;
        // Small delay to let the webview finish its initial LOG_REQUEST_COMMITS round-trip
        setTimeout(() => this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch }), 150);
      }
    });

    webviewView.onDidDispose(() => {
      this.view = undefined;
      this.disposables.forEach(d => d.dispose());
      this.disposables = [];
    });
  }

  /** Focus/reveal the Git Log panel in the bottom bar. */
  focus(): void {
    vscode.commands.executeCommand(`${GitLogPanelProvider.viewType}.focus`);
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
  focusRepo(repoId: string, branch?: string): void {
    this.pendingFilterRepoId = repoId;
    this.pendingFilterBranch = branch ?? null;
    this.focus();
    if (this.view?.visible) {
      this.post({ type: 'LOG_FILTER_BY_REPO', repoId, branch });
      this.pendingFilterRepoId = null;
      this.pendingFilterBranch = null;
    }
  }

  /** Trigger a full log refresh — call this after any operation that creates new commits. */
  refresh(): void {
    this.post({ type: 'LOG_REFRESH' });
  }

  private post(msg: HostToLogMsg): void {
    if (msg.type === 'LOG_INIT_DATA') {
      const m = msg as typeof msg & { hasWorkspaceFolder?: boolean };
      if (m.hasWorkspaceFolder === undefined) m.hasWorkspaceFolder = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    }
    const requestId = 'requestId' in msg ? msg.requestId : undefined;
    const replyTarget = requestId ? this.replyTargetByRequestId.get(requestId) : undefined;
    const target = replyTarget ?? this.activeReplyTarget;
    if (requestId && replyTarget) this.replyTargetByRequestId.delete(requestId);

    if (target === 'undocked') {
      this.undockedPanel?.postToLog(msg);
      return;
    }
    this.view?.webview.postMessage(msg);
    if (
      msg.type === 'LOG_INIT_DATA'
      || msg.type === 'LOG_REFRESH'
      || msg.type === 'LOG_REFS_UPDATE'
      || msg.type === 'LOG_TAGS_UPDATE'
    ) {
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
        description: branch.branchName,
        branch,
      };
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: t('Choose a repository for "{0}"', branches[0].branchName.replace(/^[^/]+\//, '')),
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
    options?: { fileStatus?: string; lineRange?: LineRange },
  ): Promise<void> {
    const relativePath = repo.resolveRepoPath(filePath).relativePath;
    const lineRange = options?.lineRange;
    const rangeKey = lineRange ? `${lineRange.start}-${lineRange.end}` : '';
    const taskKey = `${repo.repoId}:${hash}:${relativePath}:${options?.fileStatus ?? ''}:${rangeKey}`;
    const existingTask = this.svnDiffOpenTasks.get(taskKey);
    if (existingTask) {
      await existingTask;
      return;
    }

    const task = (async () => {
      // The file list already tells us whether this revision added or deleted the file.
      // Fetching both revision contents directly avoids a redundant `svn diff` round trip;
      // SvnService also caches and coalesces these immutable `svn cat` requests.
      const contents = await repo.getRevisionFileContents(hash, relativePath, options?.fileStatus);
      const normalizedStatus = (options?.fileStatus ?? '').toUpperCase();
      if (!contents.originalContent && !contents.modifiedContent && normalizedStatus !== 'A' && normalizedStatus !== 'D') {
        vscode.window.showInformationMessage(t('VersionDock: No SVN diff available for {0}.', relativePath));
        return;
      }

      const requestId = `${hash}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const leftUri = ShelveDocumentProvider.buildUri(repo.repoId, `svn-${requestId}-base`, relativePath);
      const rightUri = ShelveDocumentProvider.buildUri(repo.repoId, `svn-${requestId}-${hash}`, relativePath);
      this.shelveDocProvider.set(leftUri, contents.originalContent);
      this.shelveDocProvider.set(rightUri, contents.modifiedContent);
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
      await this.revealLineRange(rightUri, lineRange);
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

  private async buildSvnCommitChangeResources(
    repo: SvnService,
    files: Array<{ path: string; status?: string }>,
    loadContents: (
      file: { path: string; status?: string },
      relativePath: string,
    ) => Promise<{ originalContent: string; modifiedContent: string }>,
  ): Promise<ChangesResource[]> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const eligibleFiles = files.filter(file => file.status?.toUpperCase() !== 'U');
    const resources: ChangesResource[] = [];

    for (let offset = 0; offset < eligibleFiles.length; offset += SVN_CHANGE_RESOURCE_CONCURRENCY) {
      const batch = eligibleFiles.slice(offset, offset + SVN_CHANGE_RESOURCE_CONCURRENCY);
      const batchResources = await Promise.all(batch.map(async (file, index): Promise<ChangesResource | null> => {
        try {
          const resolvedPath = repo.resolveRepoPath(file.path);
          const relativePath = resolvedPath.relativePath;
          const contents = await loadContents(file, relativePath);
          const normalizedStatus = (file.status ?? '').toUpperCase();
          if (!contents.originalContent && !contents.modifiedContent && normalizedStatus !== 'A' && normalizedStatus !== 'D') {
            return null;
          }

          const resourceIndex = offset + index;
          const leftUri = ShelveDocumentProvider.buildUri(
            repo.repoId,
            `svn-changes-${requestId}-${resourceIndex}-base`,
            relativePath,
          );
          const rightUri = ShelveDocumentProvider.buildUri(
            repo.repoId,
            `svn-changes-${requestId}-${resourceIndex}-modified`,
            relativePath,
          );
          this.shelveDocProvider.set(leftUri, contents.originalContent);
          this.shelveDocProvider.set(rightUri, contents.modifiedContent);
          return [vscode.Uri.file(resolvedPath.absolutePath), leftUri, rightUri];
        } catch {
          return null;
        }
      }));
      resources.push(...batchResources.filter((resource): resource is ChangesResource => resource !== null));
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

  private async applyCommitPathEntries(
    repo: import('../git/GitService').GitService,
    entries: LogCommitPathEntry[],
    direction: 'apply' | 'restore',
  ): Promise<void> {
    for (const entry of entries) {
      const resolvedPath = repo.resolveRepoPath(entry.path);
      if (direction === 'apply') {
        if (entry.status === 'D') {
          await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { useTrash: false }).catch(() => undefined);
          continue;
        }
        await repo.checkoutFileFromCommit(entry.hash, resolvedPath.relativePath);
        continue;
      }

      if (entry.status === 'A') {
        await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { useTrash: false }).catch(() => undefined);
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

  private async getFilteredBranches() {
    const ids = new Set(this.getNonWorktreeRepos().map(r => r.id));
    const all = await this.manager.getAllBranches();
    return all.filter(b => ids.has(b.repoId));
  }

  private async handleMessage(msg: LogToHostMsg, replyTarget: 'sidebar' | 'undocked' = 'sidebar'): Promise<void> {
    const requestId = 'requestId' in msg ? msg.requestId : undefined;
    if (requestId) this.replyTargetByRequestId.set(requestId, replyTarget);

    switch (msg.type) {
      case 'LOG_REQUEST_COMMITS': {
        const maxCommits = vscode.workspace.getConfiguration('versiondock').get<number>('graphMaxCommits', 1000);
        if (msg.skip >= maxCommits) {
          this.post({ type: 'LOG_COMMITS_BATCH', commits: [], isLast: true, batchIndex: 0, generation: msg.generation, requestId: msg.requestId });
          return;
        }
        const limit = Math.min(msg.limit, maxCommits - msg.skip);

        const repos = this.getVisibleRepos();
        const [branches, iconTheme] = await Promise.all([
          this.getFilteredBranches(),
          this.view ? loadIconTheme(this.view.webview) : Promise.resolve(undefined),
        ]);
        this.post({ type: 'LOG_INIT_DATA', repos, branches, iconTheme });

        // Send tags for all repos
        for (const meta of repos) {
          const repo = this.manager.getRepo(meta.id);
          if (!repo) continue;
          repo.getTags().then(rawTags => {
            this.post({ type: 'LOG_TAGS_UPDATE', repoId: meta.id, tags: rawTags.map(t => ({ ...t, repoId: meta.id })) });
          }).catch(() => {});
        }

        const logRepoIds = msg.repoIds.length > 0
          ? msg.repoIds.filter(id => !this.manager.getRepoMetas().find(m => m.id === id)?.isWorktree && !this.hiddenRepoIds.includes(id))
          : this.getVisibleRepos().map(r => r.id);
        const commits = await this.manager.getInterleavedLog(logRepoIds, limit, msg.skip, {
          filterText: msg.filterText,
          filterAuthor: msg.filterAuthor,
          filterBranch: msg.filterBranch,
          filterDateFrom: msg.filterDateFrom,
          filterDateTo: msg.filterDateTo,
          filterPath: msg.filterPath,
          lineRange: msg.lineRange,
        });
        this.post({ type: 'LOG_COMMITS_BATCH', commits, isLast: commits.length < limit, batchIndex: 0, generation: msg.generation, requestId: msg.requestId });
        this.flushPendingHistoryFilter();
        break;
      }

      case 'LOG_WEBVIEW_ERROR': {
        console.error('[VersionDock Git Log webview]', msg.message, msg.stack ?? '', msg.componentStack ?? '');
        vscode.window.showErrorMessage(t('VersionDock Log error: {0}', msg.message));
        break;
      }

      case 'LOG_REQUEST_COMMIT_FILES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: t('Repo not found') }); return; }
        try {
          const files = await repo.getCommitFiles(msg.hash, msg.parents);
          this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files });
        } catch (e: unknown) {
          this.post({ type: 'LOG_COMMIT_FILES', requestId: msg.requestId, files: [], error: String(e) });
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
        if (!repo) return;
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
            break;
          }
          await this.openDiffBetweenRefs(repo, msg.filePath, `${msg.hash}~1`, msg.hash, title, msg.lineRange);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock: Cannot open diff: {0}', String(e)));
        }
        break;
      }

      case 'LOG_OPEN_FILE_RANGE_DIFF': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        try {
          const path = await import('path');
          const fileName = path.basename(msg.filePath);
          if (repo.kind === 'svn') {
            await this.openSvnRevisionDiffEditor(
              repo as SvnService,
              msg.toHash,
              msg.filePath,
              t('{0} ({1})', fileName, msg.toHash),
              { lineRange: msg.lineRange },
            );
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
          vscode.window.showErrorMessage(t('VersionDock: Cannot open diff: {0}', String(e)));
        }
        break;
      }

      case 'LOG_OPEN_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
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
          vscode.window.showErrorMessage(t('VersionDock: Cannot open file: {0}', String(e)));
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

      case 'LOG_OPEN_FOLDER':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;

      case 'LOG_CLONE_REPO':
        await vscode.commands.executeCommand('git.clone');
        break;

      case 'LOG_REVERT_FILE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          const resolvedPath = repo.resolveRepoPath(msg.filePath);
          if (msg.fileStatus === 'A') {
            // File was added in this commit — reverting means deleting it from the working tree
            await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { useTrash: false });
          } else {
            await repo.revertFileToParent(msg.hash, resolvedPath.relativePath);
          }
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Cannot revert file: {0}', String(e)));
        }
        break;
      }

      case 'LOG_APPLY_COMMIT_PATHS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const uniqueEntries = Array.from(new Map(msg.entries.map(entry => [`${entry.repoId}:${entry.hash}:${entry.path}`, entry])).values());
        if (uniqueEntries.length === 0) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
          return;
        }
        const targetLabel = uniqueEntries.length === 1
          ? `'${uniqueEntries[0].path.split('/').pop() ?? uniqueEntries[0].path}'`
          : t('{0} paths', uniqueEntries.length);
        const confirm = await vscode.window.showWarningMessage(
          t('Apply changes from the selected commit scope to {0}?', targetLabel),
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
        } catch (e: unknown) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Cannot apply selected changes: {0}', String(e)));
        }
        break;
      }

      case 'LOG_RESTORE_COMMIT_PATHS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const uniqueEntries = Array.from(new Map(msg.entries.map(entry => [`${entry.repoId}:${entry.hash}:${entry.path}`, entry])).values());
        if (uniqueEntries.length === 0) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: true });
          return;
        }
        const targetLabel = uniqueEntries.length === 1
          ? `'${uniqueEntries[0].path.split('/').pop() ?? uniqueEntries[0].path}'`
          : t('{0} paths', uniqueEntries.length);
        const confirm = await vscode.window.showWarningMessage(
          t('Revert changes from the selected commit scope for {0}?', targetLabel),
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
        } catch (e: unknown) {
          this.post({ type: 'LOG_FILE_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Cannot revert selected changes: {0}', String(e)));
        }
        break;
      }

      case 'LOG_CHECKOUT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.checkout(msg.branchName, msg.createNew, msg.from);
          // _pendingDetachedTag is cleared inside GitService.checkout().
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
          const merged = mergeCurrentIntoBranches(branches, current);
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_PULL': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: repo.kind === 'svn' ? t('VersionDock: Updating') : t('VersionDock: Pulling'), cancellable: false },
          async () => {
            try {
              const output = msg.branchName ? await repo.pullBranch(msg.branchName) : await repo.pull();
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true, output });
              this.post({ type: 'LOG_REFRESH' });
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
            }
          }
        );
        break;
      }

      case 'LOG_PUSH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pushing'), cancellable: false },
          async () => {
            try {
              await repo.push(msg.force, msg.remote);
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              this.post({ type: 'LOG_REFRESH' });
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
            }
          }
        );
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
        if (repo.kind === 'svn') {
          try {
            await repo.merge(msg.from);
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
            this.post({ type: 'LOG_REFRESH' });
            vscode.window.showInformationMessage(t('VersionDock: Merged SVN branch "{0}" into the working copy.', msg.from));
          } catch (e: unknown) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
            vscode.window.showErrorMessage(t('VersionDock: SVN merge failed: {0}', String(e)));
          }
          break;
        }
        try {
          await repo.merge(msg.from);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          const errMsg = String(e);
          const isDirty = errMsg.includes('Your local changes') || errMsg.includes('overwritten by merge') || (e as { gitErrorCode?: string })?.gitErrorCode === 'DirtyWorkTree';
          if (isDirty) {
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
                await repo.stashPush(t('WIP before merge of {0}', msg.from));
                await repo.merge(msg.from);
                this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              } catch (e2: unknown) {
                this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e2) });
              }
            }
            break;
          }
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT')) {
            repo.getCurrentBranch().then(current => {
              const mergeMsg = `Merge branch '${msg.from}' into '${current.name}'`;
              this.commitPanel?.prefillCommitMessage(mergeMsg);
            }).catch(() => {});
            vscode.window.showWarningMessage(
              t('VersionDock: Merge conflicts detected. Use the Merge Editor to resolve them.'),
              t('Open Commit Panel')
            ).then(choice => {
              if (choice) vscode.commands.executeCommand('versiondock.commitPanel.focus');
            });
          }
        }
        break;
      }

      case 'LOG_REBASE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.rebase(msg.onto);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
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
          const baseRef = current.detachedTag ?? current.detachedHash ?? current.name;
          this.focus();
          this.post({
            type: 'LOG_COMPARE_STARTED',
            repoId: target.repoId,
            repoName: meta.name,
            baseRef,
            targetRef: target.branchName,
          });
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock: Cannot start compare: {0}', String(e)));
        }
        break;
      }

      case 'LOG_SHOW_WORKTREE_DIFF': {
        const target = await this.pickBranchTarget(msg.branches);
        if (!target) break;
        try {
          await this.commitPanel?.startWorktreeDiff(target.repoId, target.branchName);
        } catch (e: unknown) {
          vscode.window.showErrorMessage(t('VersionDock: Cannot open worktree diff: {0}', String(e)));
        }
        break;
      }

      case 'LOG_REQUEST_COMPARE_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) {
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
          t('Delete branch "{0}"?', msg.branchName), { modal: true }, t('Delete')
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
          vscode.window.showWarningMessage(t('VersionDock: Cannot delete "{0}" — it is currently checked out in all target repositories.', msg.branchName));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Checked out' });
          return;
        }
        const skippedMsg = checkedOutIn.length > 0
          ? ` (skipped in: ${checkedOutIn.join(', ')} — currently checked out)`
          : '';
        const repoCount = eligibleRepoIds.length;
        const confirm = await vscode.window.showWarningMessage(
          repoCount === 1
            ? t('Delete branch "{0}" in {1} repository?{2}', msg.branchName, repoCount, skippedMsg)
            : t('Delete branch "{0}" in {1} repositories?{2}', msg.branchName, repoCount, skippedMsg),
          { modal: true }, t('Delete'), t('Force Delete')
        );
        if (!confirm) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        const force = confirm === t('Force Delete');
        const errors: string[] = [];
        for (const repoId of eligibleRepoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await repo.deleteBranch(msg.branchName, force);
            const branches = await repo.getBranches();
            this.post({ type: 'LOG_REFS_UPDATE', repoId, branches });
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        }
        break;
      }

      case 'LOG_FETCH_ALL': {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Fetching all'), cancellable: false },
          async () => { await this.manager.fetchAll(); }
        );
        const branches = await this.getFilteredBranches();
        const repos = this.getVisibleRepos();
        this.post({ type: 'LOG_INIT_DATA', repos, branches });
        this.post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_FETCH_REPO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.fetchAll();
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const branches = await repo.getBranches();
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_CHERRY_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.cherryPick(msg.hash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            const choice = await vscode.window.showWarningMessage(
              t('Cherry-pick of {0} has conflicts. Resolve them in the editor, then choose an action.', msg.hash.slice(0, 7)),
              t('Continue'), t('Skip'), t('Abort')
            );
            if (choice === t('Continue')) {
              await repo.cherryPickContinue();
            } else if (choice === t('Skip')) {
              await repo.cherryPickSkip();
            } else if (choice === t('Abort')) {
              await repo.cherryPickAbort();
            }
          } else {
            vscode.window.showErrorMessage(t('VersionDock: Cherry-pick failed: {0}', errMsg));
          }
        }
        break;
      }

      case 'LOG_REVERT_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        {
          const confirm = await vscode.window.showWarningMessage(
            t('Revert commit {0}? This creates a new commit that undoes the changes.', msg.hash.slice(0, 7)),
            { modal: true }, t('Revert')
          );
          if (confirm !== t('Revert')) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }
        try {
          await repo.revertCommit(msg.hash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            const choice = await vscode.window.showWarningMessage(
              t('Revert of {0} has conflicts. Resolve them in the editor, then choose an action.', msg.hash.slice(0, 7)),
              t('Continue'), t('Abort')
            );
            if (choice === t('Continue')) {
              await repo.revertContinue();
            } else if (choice === t('Abort')) {
              await repo.revertAbort();
            }
          } else {
            vscode.window.showErrorMessage(t('VersionDock: Revert failed: {0}', errMsg));
          }
        }
        break;
      }

      case 'LOG_RESET_TO': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const modeLabel = msg.mode === 'hard' ? t('Hard Reset (discard all changes)') : msg.mode === 'mixed' ? t('Mixed Reset (keep unstaged)') : t('Soft Reset (keep staged)');
        const confirm = await vscode.window.showWarningMessage(
          t('Reset current branch to {0}? ({1})', msg.hash.slice(0, 7), modeLabel),
          { modal: true }, t('Reset')
        );
        if (confirm !== t('Reset')) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.resetTo(msg.hash, msg.mode);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Reset failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_CREATE_PATCH': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          const patch = await repo.createPatch(msg.hash);
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(`${msg.hash.slice(0, 7)}.patch`),
            filters: { 'Patch files': ['patch'], 'All files': ['*'] },
          });
          if (uri) {
            await vscode.workspace.fs.writeFile(uri, Buffer.from(patch, 'utf8'));
            vscode.window.showInformationMessage(t('Patch saved to {0}', uri.fsPath));
          }
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Create patch failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_CHERRY_PICK_MULTI': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.cherryPickMulti(msg.hashes);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not apply')) {
            const choice = await vscode.window.showWarningMessage(
              t('Cherry-pick has conflicts. Resolve them, then choose an action.'),
              t('Continue'), t('Skip'), t('Abort')
            );
            if (choice === t('Continue')) await repo.cherryPickContinue();
            else if (choice === t('Skip')) await repo.cherryPickSkip();
            else await repo.cherryPickAbort();
          } else {
            vscode.window.showErrorMessage(t('VersionDock: Cherry-pick failed: {0}', errMsg));
          }
        }
        break;
      }

      case 'LOG_REVERT_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        {
          const confirm = await vscode.window.showWarningMessage(
            t('Revert {0} commits? This creates new commits that undo the changes.', msg.hashes.length),
            { modal: true }, t('Revert')
          );
          if (confirm !== t('Revert')) {
            this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
            return;
          }
        }
        try {
          await repo.revertCommits(msg.hashes);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          const errMsg = String(e);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errMsg });
          if (errMsg.includes('CONFLICT') || errMsg.includes('could not revert')) {
            const choice = await vscode.window.showWarningMessage(
              t('Revert has conflicts. Resolve them, then choose an action.'),
              t('Continue'), t('Abort')
            );
            if (choice === t('Continue')) await repo.revertContinue();
            else await repo.revertAbort();
          } else {
            vscode.window.showErrorMessage(t('VersionDock: Revert failed: {0}', errMsg));
          }
        }
        break;
      }

      case 'LOG_DROP_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const confirm = await vscode.window.showWarningMessage(
          t('Drop {0} commits? This rewrites history and cannot be undone.', msg.hashes.length),
          { modal: true }, t('Drop')
        );
        if (confirm !== t('Drop')) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.dropCommits(msg.oldestHash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Drop commits failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_CREATE_PATCH_MULTI': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
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
          vscode.window.showInformationMessage(t('{0} patches saved to {1}', msg.hashes.length, folderPath));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Create patches failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_DROP_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const confirm = await vscode.window.showWarningMessage(
          t('Drop commit {0}? This rewrites history. Only drop unpushed commits — dropping a pushed commit will require a force push.', msg.hash.slice(0, 7)),
          { modal: true }, t('Drop')
        );
        if (confirm !== t('Drop')) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.dropCommit(msg.hash);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Drop commit failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_SQUASH_COMMITS': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const squashValidation = await repo.canSquashCommitRange(msg.hashes);
        if (!squashValidation.ok || !squashValidation.oldestHash) {
          const reason = squashValidation.reason ?? t('Selected commits cannot be squashed.');
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: reason });
          vscode.window.showWarningMessage(reason);
          return;
        }
        const fullMessages = await Promise.all(msg.hashes.map(h => repo.getFullCommitMessage(h).then(m => m.trim())));
        const fullCombined = fullMessages.join('\n\n');
        const fullCommits = msg.commits.map((c, i) => ({ ...c, message: fullMessages[i] ?? c.message }));
        const result = await openSquashEditor(this.extensionUri, msg.hashes.length, fullCombined, fullCommits);
        if (!result.confirmed) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Cancelled') });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Squashing {0} commits…', squashValidation.hashes.length), cancellable: false },
            () => repo.squashCommits(squashValidation.hashes, result.message),
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          vscode.window.showInformationMessage(t('VersionDock: Squash completed.'));
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Squash failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_UNDO_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
          const confirm = await vscode.window.showWarningMessage(
            t('Undo last commit? Changes will be moved back to the staged area.'),
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
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Undo commit failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_EDIT_COMMIT_MESSAGE': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const fullMessage = (await repo.getFullCommitMessage(msg.hash)).trim();
        const result = await openEditMessageEditor(this.extensionUri, msg.hash.slice(0, 7), fullMessage);
        if (!result.confirmed) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Cancelled') });
          return;
        }
        try {
          await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Updating commit message…'), cancellable: false },
            () => repo.rewordCommit(result.message),
          );
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          vscode.window.showInformationMessage(t('VersionDock: Commit message updated.'));
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Edit commit message failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_NEW_BRANCH_FROM_COMMIT': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        const shortRef = msg.hash.slice(0, 7);
        const branchName = await vscode.window.showInputBox({
          prompt: repo.kind === 'svn' ? t('Create SVN branch from revision {0}', shortRef) : t('Create new branch from {0}', shortRef),
          placeHolder: t('my-feature-branch'),
          validateInput: v => v.trim() ? undefined : t('Branch name cannot be empty'),
        });
        if (!branchName) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Cancelled' });
          return;
        }
        try {
          await repo.createBranchFromCommit(branchName.trim(), msg.hash);
          const branches = await repo.getBranches();
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches });
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Create branch failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_CREATE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
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
          const rawTags = await repo.getTags();
          this.post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags: rawTags.map(t => ({ ...t, repoId: msg.repoId })) });
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Create tag failed: {0}', String(e)));
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
          const rawTags = await repo.getTags();
          const tags = rawTags.map(t => ({ ...t, repoId: msg.repoId }));
          this.post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags });
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
          const tags = await repo.getTagsForCommit(msg.hash).catch(() => [] as string[]);
        if (tags.length === 0) {
          vscode.window.showInformationMessage(t('VersionDock: No tags on this commit.'));
          return;
        }
        await this.showManageCommitTagsMenu(repo, msg.repoId, msg.hash, tags, msg.currentBranch);
        break;
      }

      case 'LOG_DELETE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.deleteTag(msg.tagName);
          const rawTags = await repo.getTags();
          this.post({ type: 'LOG_TAGS_UPDATE', repoId: msg.repoId, tags: rawTags.map(t => ({ ...t, repoId: msg.repoId })) });
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Delete tag failed: {0}', String(e)));
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
          vscode.window.showWarningMessage(t('VersionDock: Cannot delete tag "{0}" — HEAD is detached on it in all target repositories.', msg.tagName));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: 'Checked out' });
          return;
        }
        const skippedMsg = checkedOutTagIn.length > 0
          ? ` (skipped in: ${checkedOutTagIn.join(', ')} — HEAD detached on this tag)`
          : '';
        const repoCount = eligibleRepoIds.length;
        const choice = await (async (): Promise<DeleteTagChoice> => {
          const pick = await vscode.window.showWarningMessage(
            repoCount === 1
              ? t('Delete tag "{0}" in {1} repository?{2}', msg.tagName, repoCount, skippedMsg)
              : t('Delete tag "{0}" in {1} repositories?{2}', msg.tagName, repoCount, skippedMsg),
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
        for (const repoId of eligibleRepoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await deleteTagWithRemoteOption(repo, msg.tagName, choice);
            const rawTags = await repo.getTags();
            this.post({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
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
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pushing tag "{0}" to {1}…', msg.tagName, msg.remote), cancellable: false },
          async () => {
            try {
              await repo.pushTag(msg.tagName, msg.remote);
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
              vscode.window.showInformationMessage(t('VersionDock: Tag "{0}" pushed to "{1}".', msg.tagName, msg.remote));
            } catch (e: unknown) {
              this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
              vscode.window.showErrorMessage(t('VersionDock: Push tag failed: {0}', String(e)));
            }
          }
        );
        break;
      }

      case 'LOG_CHECKOUT_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
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
          vscode.window.showInformationMessage(t('VersionDock: Checked out tag "{0}" (detached HEAD).', msg.tagName));
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Checkout tag failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_MERGE_TAG': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) { this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: t('Repo not found') }); return; }
        try {
          await repo.mergeTag(msg.tagName);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          this.post({ type: 'LOG_REFRESH' });
          vscode.window.showInformationMessage(t('VersionDock: Merged tag "{0}".', msg.tagName));
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Merge tag failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_MERGE_TAG_MULTI': {
        const errors: string[] = [];
        for (const repoId of msg.repoIds) {
          const repo = this.manager.getRepo(repoId);
          if (!repo) continue;
          try {
            await repo.mergeTag(msg.tagName);
          } catch (e: unknown) {
            const meta = this.getNonWorktreeRepos().find(m => m.id === repoId);
            errors.push(`${meta?.name ?? repoId}: ${String(e)}`);
          }
        }
        if (errors.length > 0) {
          vscode.window.showWarningMessage(t('VersionDock: {0} error(s): {1}', errors.length, errors.join('; ')));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: errors.join('; ') });
        } else {
          vscode.window.showInformationMessage(t('VersionDock: Merged tag "{0}" in {1} repositories.', msg.tagName, msg.repoIds.length));
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
        }
        this.post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_RESET_TO_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        type ModeItem = vscode.QuickPickItem & { mode: 'soft' | 'mixed' | 'hard' };
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
          this.post({ type: 'LOG_REFRESH' });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: reqId, ok: false, error: String(e) });
          vscode.window.showErrorMessage(t('VersionDock: Reset failed: {0}', String(e)));
        }
        break;
      }

      case 'LOG_PUSH_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) { vscode.window.showWarningMessage(t('VersionDock: No remotes configured.')); return; }
        const remotePick = remotes.length === 1
          ? remotes[0]
          : (await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: t('Push — Select remote') }
            ) as { label: string; remote: string } | undefined)?.remote;
        if (!remotePick) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pushing to {0}…', remotePick), cancellable: false },
          async () => {
            try {
              await repo.push(false, remotePick);
              vscode.window.showInformationMessage(t('VersionDock: Pushed to "{0}" successfully.', remotePick));
            } catch (e: unknown) {
              vscode.window.showErrorMessage(t('VersionDock: Push failed: {0}', String(e)));
            }
          }
        );
        this.post({ type: 'LOG_REFRESH' });
        break;
      }

      case 'LOG_PUSH_TAG_PICK': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) return;
        const remotes = await repo.getRemotes().catch(() => [] as string[]);
        if (remotes.length === 0) { vscode.window.showWarningMessage(t('VersionDock: No remotes configured.')); return; }
        const remotePick = remotes.length === 1
          ? remotes[0]
          : (await vscode.window.showQuickPick(
              remotes.map(r => ({ label: `$(cloud-upload) ${r}`, remote: r })),
              { title: t('Push tag "{0}" — Select remote', msg.tagName) }
            ) as { label: string; remote: string } | undefined)?.remote;
        if (!remotePick) return;
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock: Pushing tag "{0}" to {1}…', msg.tagName, remotePick), cancellable: false },
          async () => {
            try {
              await repo.pushTag(msg.tagName, remotePick);
              vscode.window.showInformationMessage(t('VersionDock: Tag "{0}" pushed to "{1}".', msg.tagName, remotePick));
            } catch (e: unknown) {
              vscode.window.showErrorMessage(t('VersionDock: Push tag failed: {0}', String(e)));
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
        try {
          await repo.checkout(target);
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: true });
          const [branches, current] = await Promise.all([repo.getBranches(), repo.getCurrentBranch()]);
          const merged = mergeCurrentIntoBranches(branches, current);
          this.post({ type: 'LOG_REFS_UPDATE', repoId: msg.repoId, branches: merged });
        } catch (e: unknown) {
          this.post({ type: 'LOG_BRANCH_OP_RESULT', requestId: msg.requestId, ok: false, error: String(e) });
        }
        break;
      }

      case 'LOG_OPEN_EXTENDED_DETAIL': {
        const { openCommitDetailPanel } = await import('./CommitDetailPanel');
        await openCommitDetailPanel(this.extensionUri, this.manager, msg.repoId, msg.hash);
        break;
      }

      case 'LOG_OPEN_EXTENDED_DETAIL_MULTI': {
        const { openAggregatedCommitDetailPanel } = await import('./CommitDetailPanel');
        await openAggregatedCommitDetailPanel(this.extensionUri, this.manager, msg.commits);
        break;
      }

      case 'LOG_OPEN_COMMIT_CHANGES': {
        const repo = this.manager.getRepo(msg.repoId);
        if (!repo) break;
        const files = await repo.getCommitFiles(msg.hash);
        if (repo.kind === 'svn') {
          const svnRepo = repo as SvnService;
          const resources = await this.buildSvnCommitChangeResources(
            svnRepo,
            files,
            (file, relativePath) => svnRepo.getRevisionFileContents(msg.hash, relativePath, file.status),
          );
          if (resources.length === 0) {
            await vscode.window.showInformationMessage(t('No SVN file changes to open.'));
            break;
          }
          await vscode.commands.executeCommand(
            'vscode.changes',
            t('Changes in {0}', msg.hash.slice(0, 8)),
            resources,
          );
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
        await vscode.commands.executeCommand('vscode.changes', t('Changes in {0}', msg.hash.slice(0, 8)), resources);
        break;
      }

      case 'LOG_OPEN_COMMIT_CHANGES_MULTI': {
        const resources: ChangesResource[] = [];
        for (const group of msg.groups) {
          const repo = this.manager.getRepo(group.repoId);
          if (!repo) continue;
          if (repo.kind === 'svn') {
            const svnRepo = repo as SvnService;
            resources.push(...await this.buildSvnCommitChangeResources(
              svnRepo,
              group.files.map(filePath => ({ path: filePath })),
              (_file, relativePath) => svnRepo.getRevisionRangeFileContents(group.fromHash, group.toHash, relativePath),
            ));
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
          for (const filePath of group.files) {
            const relativePath = repo.resolveRepoPath(filePath).relativePath;
            const label = vscode.Uri.file(repo.resolveRepoPath(relativePath).absolutePath);
            resources.push([
              label,
              gitUri(group.fromHash || EMPTY_TREE, relativePath),
              gitUri(group.toHash, relativePath),
            ]);
          }
        }
        if (resources.length === 0) {
          await vscode.window.showInformationMessage(t('No changed files'));
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
        const rawTags = await repo.getTags();
        this.post({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
        this.post({ type: 'LOG_REFRESH' });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Create tag failed: {0}', String(e)));
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
            this.post({ type: 'LOG_REFRESH' });
            vscode.window.showInformationMessage(t('VersionDock: Merged tag "{0}" into "{1}".', tagName, currentBranch));
          } catch (e: unknown) {
            vscode.window.showErrorMessage(t('VersionDock: Merge tag failed: {0}', String(e)));
          }
        },
      },
      { label: '', kind: vscode.QuickPickItemKind.Separator, action: async () => {} },
      {
        label: `$(trash) ${t('Delete "{0}"', tagName)}`,
        action: async () => {
          const choice = await confirmDeleteTag(tagName, t('Delete tag "{0}"?', tagName));
          if (!choice) return;
          try {
            await deleteTagWithRemoteOption(repo, tagName, choice);
            const rawTags = await repo.getTags();
            this.post({ type: 'LOG_TAGS_UPDATE', repoId, tags: rawTags.map(t => ({ ...t, repoId })) });
            this.post({ type: 'LOG_REFRESH' });
            vscode.window.showInformationMessage(t('VersionDock: Deleted tag "{0}".', tagName));
          } catch (e: unknown) {
            vscode.window.showErrorMessage(t('VersionDock: Delete tag failed: {0}', String(e)));
          }
        },
      },
    ];

    const pick = await vscode.window.showQuickPick(actionItems, {
      title: t('Tag: {0}', tagName),
    }) as ActionItem | undefined;

    if (pick) await pick.action();
  }

  dispose(): void {
    this.managerListeners.forEach(d => d.dispose());
    this.disposables.forEach(d => d.dispose());
    if (this.refreshDebounce) { clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
  }
}
