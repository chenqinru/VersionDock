import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { GitService, type MergeCommitResult } from './GitService';
import { SvnService } from '../svn/SvnService';
import type { WorktreeEntry } from './GitService';
import { getVscodeGitApi, getVscodeRepository } from './VscodeGitApi';
import type { BranchInfo, CommitNode, GraphCommitNode, LineRange, RepoMeta, RepoStatus, WorkspaceStatus } from '../types/git';
import { PROJECT_COLORS } from '../types/workspace';
import { t } from '../utils/l10n';
import { formatRepoLabel, getRepoKindDetail } from '../utils/repoLabels';
import type { VersionDockLogger } from '../utils/Logger';
import type { PublishMissingRemote } from '../remote/types';
import { GitHubRemoteProvider } from '../remote/GitHubRemoteProvider';
import { GitLabRemoteProvider } from '../remote/GitLabRemoteProvider';
import { setRemoteProtectedBranches } from '../utils/branchProtection';

const MAX_SUBMODULE_DEPTH = 5;
const DEFAULT_REPOSITORY_SCAN_MAX_DEPTH = 1;
const DEFAULT_REPOSITORY_SCAN_IGNORED_FOLDERS = ['node_modules'];

type StatusListener = (status: WorkspaceStatus) => void;
export type StatusOperationListener = (inProgress: boolean, kind?: StatusOperationKind, label?: string) => void;
type StatusOperationKind = 'checkout' | 'squash' | 'merge' | 'commit' | 'rebase' | 'cherry-pick' | 'revert' | 'sync' | 'stash';
type BranchListener = () => void;
type WorktreeListener = (repoId: string) => void;
type RepoKind = NonNullable<RepoMeta['kind']>;
type ServiceResolutionMode = 'git' | 'svn' | 'prompt' | 'preferGit';
type ResolveServiceOptions = {
  title?: string;
  placeHolder?: string;
  notFoundMessage?: string;
};

function getWorkspaceStatusSignature(status: WorkspaceStatus): string {
  return status.repos
    .map(repo => {
      const files = [...repo.stagedFiles, ...repo.unstagedFiles]
        .map(file => `${file.path}\u0000${file.oldPath ?? ''}\u0000${file.status}\u0000${file.staged ? '1' : '0'}\u0000${file.unstaged ? '1' : '0'}`)
        .sort()
        .join('\u0001');
      return [
        repo.repoId,
        repo.branch.name,
        repo.isDetachedHead ? '1' : '0',
        repo.conflictCount,
        repo.operationState ?? '',
        files,
      ].join('\u0002');
    })
    .sort()
    .join('\u0003');
}

function getRepositoryMetadataSignature(repos: readonly RepoMeta[]): string {
  return JSON.stringify(
    [...repos]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(repo => [
        repo.id,
        repo.name,
        repo.rootPath,
        repo.color,
        repo.kind ?? '',
        repo.remoteUrl ?? '',
        repo.relativeUrl ?? '',
        repo.isSubmodule ?? false,
        repo.parentRepoId ?? '',
        repo.submodulePath ?? '',
        repo.depth ?? 0,
        repo.isWorktree ?? false,
        repo.mainWorktreePath ?? '',
      ]),
  );
}

function gitErrorDetail(error: unknown): string {
  const value = error as { stderr?: unknown; gitErrorCode?: unknown; message?: unknown } | undefined;
  const stderr = typeof value?.stderr === 'string' ? value.stderr.trim() : '';
  if (stderr) return stderr;
  if (typeof value?.gitErrorCode === 'string' && value.gitErrorCode) return value.gitErrorCode;
  if (typeof value?.message === 'string' && value.message) return value.message;
  return 'Unknown error';
}

export type { WorktreeEntry };

const FALLBACK_SCAN_MAX_DEPTH = 4;
// SVN discovery historically scanned four levels independently of the Git
// repository-scan preference. Preserve that behaviour: the public setting and
// its documentation currently apply to Git repositories only.
const SVN_REPOSITORY_SCAN_MAX_DEPTH = FALLBACK_SCAN_MAX_DEPTH;
const FALLBACK_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.gradle',
  'venv',
  '.venv',
  'coverage',
  '.cache',
  'Pods',
  'DerivedData',
  '.output',
  'temp',
  'tmp',
  '.next',
  '.nuxt',
  '.turbo',
]);

function isWithinPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function normalizePathForId(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function buildRepoId(rootPath: string, kind: RepoKind): string {
  return `${normalizePathForId(rootPath)}::${kind}`;
}

function isPathEqual(a: string, b: string): boolean {
  const normA = path.normalize(a);
  const normB = path.normalize(b);
  return process.platform === 'win32'
    ? normA.toLowerCase() === normB.toLowerCase()
    : normA === normB;
}

function extractMainWorktreePath(repoPath: string): string | undefined {
  const gitDir = path.join(repoPath, '.git');
  try {
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isFile()) return undefined;
    const content = fs.readFileSync(gitDir, 'utf8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/m);
    const gitdirPath = match?.[1]?.trim();
    if (!gitdirPath) return undefined;
    const resolvedGitdir = path.resolve(repoPath, gitdirPath);
    // Worktree pointers point to a directory matching `.../.git/worktrees/<name>`
    // Support POSIX `/` and Windows `\` delimiters and case insensitivity on Windows.
    const worktreeMatch = resolvedGitdir.match(/^(.*?)[/\\]\.git[/\\]worktrees(?:[/\\]|$)/i);
    if (worktreeMatch) {
      return path.normalize(worktreeMatch[1]);
    }
  } catch {
    // Linked worktree detection is best-effort
  }
  return undefined;
}

interface LogCandidate<T extends GraphCommitNode> {
  commit: T;
  logIndex: number;
  insertionOrder: number;
}

function javaHashMapCapacity(size: number): number {
  let capacity = 16;
  while (size > capacity * 0.75) capacity *= 2;
  return capacity;
}

function javaStringHash(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index++) {
    hash = (Math.imul(31, hash) + value.charCodeAt(index)) | 0;
  }
  return hash;
}

function javaHashBucket(value: string, capacity: number): number {
  const hash = javaStringHash(value);
  return (hash ^ (hash >>> 16)) & (capacity - 1);
}

function compareLogCandidates<T extends GraphCommitNode>(
  a: LogCandidate<T>,
  b: LogCandidate<T>,
  hashCapacity: number,
): number {
  const byDate = new Date(b.commit.committerDate).getTime()
    - new Date(a.commit.committerDate).getTime();
  if (byDate !== 0) return byDate;

  // JetBrains VcsLogMultiRepoJoiner stores the next commit from every root in
  // a Java HashMap and, for equal timestamps, keeps the last entry encountered
  // during bucket iteration. Its internal storage ids are not available here,
  // so use the stable Git hash as the equivalent commit key and reproduce the
  // same Java bucket traversal explicitly instead of depending on JS Map order.
  const byBucket = javaHashBucket(b.commit.hash, hashCapacity)
    - javaHashBucket(a.commit.hash, hashCapacity);
  if (byBucket !== 0) return byBucket;

  return b.insertionOrder - a.insertionOrder;
}

function interleaveCommitLogs<T extends GraphCommitNode>(logs: T[][]): T[] {
  const positions = logs.map(() => 0);
  const commits: T[] = [];
  const totalCommits = logs.reduce((total, log) => total + log.length, 0);
  const active: Array<LogCandidate<T>> = [];
  let nextInsertionOrder = 0;

  for (let logIndex = 0; logIndex < logs.length; logIndex++) {
    const commit = logs[logIndex][0];
    if (!commit) continue;
    active.push({ commit, logIndex, insertionOrder: nextInsertionOrder++ });
  }
  const hashCapacity = javaHashMapCapacity(active.length);

  while (active.length > 0 && commits.length < totalCommits) {
    let selectedIndex = 0;
    for (let index = 1; index < active.length; index++) {
      if (compareLogCandidates(active[index], active[selectedIndex], hashCapacity) < 0) {
        selectedIndex = index;
      }
    }

    const selected = active[selectedIndex];
    commits.push(selected.commit);
    positions[selected.logIndex]++;
    const nextCommit = logs[selected.logIndex][positions[selected.logIndex]];
    if (nextCommit) {
      active[selectedIndex] = {
        commit: nextCommit,
        logIndex: selected.logIndex,
        insertionOrder: nextInsertionOrder++,
      };
    } else {
      active.splice(selectedIndex, 1);
    }
  }

  return commits;
}

type RepositoryScanIgnore = (candidatePath: string) => boolean;

function findNestedRepoPaths(
  rootPath: string,
  maxDepth = FALLBACK_SCAN_MAX_DEPTH,
  isIgnored: RepositoryScanIgnore = () => false,
): string[] {
  const discovered: string[] = [];
  const visited = new Set<string>();

  const walk = (currentPath: string, depth: number): void => {
    if (depth > maxDepth || visited.has(currentPath)) return;
    if (depth > 0 && isIgnored(currentPath)) return;
    visited.add(currentPath);

    const gitPath = path.join(currentPath, '.git');
    if (fs.existsSync(gitPath)) {
      discovered.push(currentPath);
      return;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (FALLBACK_SCAN_SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(currentPath, entry.name), depth + 1);
    }
  };

  walk(rootPath, 0);
  return discovered;
}

function findNestedSvnRepoPaths(
  rootPath: string,
  maxDepth = FALLBACK_SCAN_MAX_DEPTH,
  isIgnored: RepositoryScanIgnore = () => false,
): string[] {
  const discovered: string[] = [];
  const visited = new Set<string>();

  const walk = (currentPath: string, depth: number): void => {
    if (depth > maxDepth || visited.has(currentPath)) return;
    if (depth > 0 && isIgnored(currentPath)) return;
    visited.add(currentPath);

    const svnPath = path.join(currentPath, '.svn');
    if (fs.existsSync(svnPath)) {
      discovered.push(currentPath);
      return;
    }

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (FALLBACK_SCAN_SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(currentPath, entry.name), depth + 1);
    }
  };

  walk(rootPath, 0);
  return discovered;
}

export class WorkspaceGitManager implements vscode.Disposable {
  private repos = new Map<string, GitService>();
  private repoMetas = new Map<string, RepoMeta>();
  /** Per-repo watchers — recreated on reinitialize(). */
  private watchers: vscode.Disposable[] = [];
  /** Global workspace listeners — created once in constructor, disposed in dispose(). */
  private globalListeners: vscode.Disposable[] = [];
  private statusListeners: StatusListener[] = [];
  private statusOperationListeners: StatusOperationListener[] = [];
  private branchListeners: BranchListener[] = [];
  private reposListeners: BranchListener[] = [];
  private worktreeListeners: WorktreeListener[] = [];
  private refreshDebounce: NodeJS.Timeout | null = null;
  private refreshFollowUp: NodeJS.Timeout | null = null;
  private branchDebounce: NodeJS.Timeout | null = null;
  private autoRefreshTimer: NodeJS.Timeout | null = null;
  private autoFetchTimer: NodeJS.Timeout | null = null;
  /** Watchers for .git creation under workspace folders — rebuilt when folders/settings change. */
  private gitInitWatchers: vscode.Disposable[] = [];
  private prevHeads = new Map<string, string>();      // repoId → branch name
  private prevCommits = new Map<string, string>();    // repoId → commit hash
  private prevUntracked = new Map<string, Set<string>>(); // repoId → known untracked paths
  private readonly gitignoreRulesCache = new Map<string, string[]>();
  private initialStatusDone = false;
  private repositoryGeneration = 0;
  private refreshInFlight = false;
  private refreshPending = false;
  private statusUpdateSuppressionDepth = 0;
  private lastPublishedStatus: WorkspaceStatus | null = null;
  private mergeCompletionTasks = new Map<string, Promise<MergeCommitResult | undefined>>();
  /** Set after a branch/HEAD change so intermediate checkout states are never published. */
  private statusStabilizationSignature: string | null | undefined;
  private disposed = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly logger: VersionDockLogger,
    private readonly publishMissingRemote?: PublishMissingRemote,
  ) {
    this.globalListeners.push(
      // Workspace folder changes → rebuild everything and push fresh status to listeners
      vscode.workspace.onDidChangeWorkspaceFolders(() => { this.reinitialize(); this.scheduleRefresh(); }),

      // File saved inside a repo → refresh status (immediate + follow-up for slow git index updates)
      vscode.workspace.onDidSaveTextDocument((doc) => {
        const filePath = doc.uri.fsPath;
        const inRepo = Array.from(this.repoMetas.values()).some(m => isWithinPath(m.rootPath, filePath));
        if (inRepo) {
          this.scheduleRefresh();
          // Schedule a follow-up refresh in case git hasn't updated its index yet
          if (this.refreshFollowUp) clearTimeout(this.refreshFollowUp);
          this.refreshFollowUp = setTimeout(() => this.scheduleRefresh(), 1200);
        }
      }),

      // File-explorer operations (create/delete/rename via VSCode UI or extensions)
      vscode.workspace.onDidCreateFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidDeleteFiles(() => this.scheduleRefresh()),
      vscode.workspace.onDidRenameFiles(() => this.scheduleRefresh()),

      // Repository discovery settings affect the repo set, watcher patterns, and colors.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('versiondock.repositoryScanMaxDepth') ||
          e.affectsConfiguration('versiondock.repositoryScanIgnoredFolders') ||
          e.affectsConfiguration('versiondock.git.excludeIgnoredDirectories') ||
          e.affectsConfiguration('versiondock.projectColors')
        ) {
          this.reinitialize();
          this.setupGitInitWatchers();
          this.scheduleRefresh();
        }
        if (e.affectsConfiguration('versiondock.autoRefreshInterval')) {
          this.setupAutoRefreshTimer();
        }
        if (e.affectsConfiguration('versiondock.git.autoFetchInterval')) {
          this.setupAutoFetchTimer();
        }
      }),

      // A folder already in the workspace may become a git repo (via git init or clone).
      // Watch for .git creation under workspace folders to trigger reinitialize.
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.setupGitInitWatchers()),
    );

    this.reinitialize();
    this.setupGitInitWatchers();
    this.setupAutoRefreshTimer();
    this.setupAutoFetchTimer();

    // If vscode.git is not yet initialized at startup, re-run setup once it is.
    // This ensures watchers use the VS Code git API rather than the filesystem fallback,
    // and that the initial status is fetched after git repos are fully loaded.
    const gitApi = getVscodeGitApi();
    if (gitApi && gitApi.state === 'uninitialized') {
      const d = gitApi.onDidChangeState((state) => {
        if (state === 'initialized') {
          d.dispose();
          this.attachGitApiRepoListeners();
          this.reinitialize();
          this.scheduleRefresh();
        }
      });
      this.globalListeners.push(d);
    } else if (gitApi) {
      this.attachGitApiRepoListeners();
    } else if (!gitApi) {
      // vscode.git extension is not yet active (activates after us) — watch for it.
      // When it activates, reinitialize so proper vsRepo watchers replace the
      // FileSystemWatcher fallback.
      const d = vscode.extensions.onDidChange(() => {
        if (getVscodeGitApi()) {
          d.dispose();
          this.attachGitApiRepoListeners();
          this.reinitialize();
          this.scheduleRefresh();
        }
      });
      this.globalListeners.push(d);
    }
  }

  private createGitService(repoId: string, rootPath: string): GitService {
    return new GitService(
      repoId,
      rootPath,
      (operation, kind, label) => this.runWithStatusUpdatesSuppressed(operation, kind, label),
      async () => { await this.refreshStatusNow(); },
      this.publishMissingRemote,
      this.logger,
    );
  }

  private createSvnService(repoId: string, rootPath: string): SvnService {
    return new SvnService(
      repoId,
      rootPath,
      (operation, kind, label) => this.runWithStatusUpdatesSuppressed(operation, kind, label),
      async () => { await this.refreshStatusNow(); },
      this.publishMissingRemote,
      this.logger,
    );
  }

  private attachGitApiRepoListeners(): void {
    const gitApi = getVscodeGitApi();
    if (!gitApi) return;
    this.globalListeners.push(
      gitApi.onDidOpenRepository(() => {
        this.reinitialize();
        this.scheduleRefresh();
      }),
      gitApi.onDidCloseRepository(() => {
        this.reinitialize();
        this.scheduleRefresh();
      }),
    );
  }

  private buildRepoMeta(
    repoPath: string,
    repoIndex: number,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    customColors: Record<string, string>,
  ): RepoMeta {
    const owner = workspaceFolders
      .filter(folder => isWithinPath(folder.uri.fsPath, repoPath))
      .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0];
    const ownerPath = owner?.uri.fsPath;
    const relativePath = ownerPath ? path.relative(ownerPath, repoPath).split(path.sep).join('/') : '';
    const name = relativePath ? path.basename(repoPath) : (owner?.name ?? path.basename(repoPath));
    const color = owner && !relativePath
      ? (customColors[owner.name] ?? PROJECT_COLORS[repoIndex % PROJECT_COLORS.length])
      : PROJECT_COLORS[repoIndex % PROJECT_COLORS.length];
    const mainWorktreePath = extractMainWorktreePath(repoPath);
    const workspacePaths = workspaceFolders.map(folder => folder.uri.fsPath);
    const isWorktree = !!mainWorktreePath && workspacePaths.some(wp => isPathEqual(wp, mainWorktreePath));
    return { id: buildRepoId(repoPath, 'git'), name, rootPath: repoPath, color, depth: 0, isWorktree, mainWorktreePath, kind: 'git' };
  }

  private buildSvnRepoMeta(
    repoPath: string,
    repoIndex: number,
    workspaceFolders: readonly vscode.WorkspaceFolder[],
    customColors: Record<string, string>,
  ): RepoMeta {
    const owner = workspaceFolders
      .filter(folder => isWithinPath(folder.uri.fsPath, repoPath))
      .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length)[0];
    const ownerPath = owner?.uri.fsPath;
    const relativePath = ownerPath ? path.relative(ownerPath, repoPath).split(path.sep).join('/') : '';
    const name = relativePath ? path.basename(repoPath) : (owner?.name ?? path.basename(repoPath));
    const color = owner && !relativePath
      ? (customColors[`${owner.name}:svn`] ?? customColors[owner.name] ?? PROJECT_COLORS[repoIndex % PROJECT_COLORS.length])
      : PROJECT_COLORS[repoIndex % PROJECT_COLORS.length];
    return { id: buildRepoId(repoPath, 'svn'), name, rootPath: repoPath, color, depth: 0, kind: 'svn' };
  }

  private applyNestedRepoMetadata(): void {
    const metas = Array.from(this.repoMetas.values()).sort((left, right) => left.rootPath.length - right.rootPath.length);
    for (const meta of metas) {
      if (meta.isSubmodule) continue;
      const parent = metas
        .filter(candidate => candidate.id !== meta.id && candidate.rootPath !== meta.rootPath && isWithinPath(candidate.rootPath, meta.rootPath))
        .sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
      if (!parent) continue;
      meta.parentRepoId = parent.id;
      meta.submodulePath = path.relative(parent.rootPath, meta.rootPath).split(path.sep).join('/');
      meta.depth = (parent.depth ?? 0) + 1;
    }
  }

  private setupRepoStructureWatchers(repoPath: string, repoId: string): void {
    const gitmodulesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoPath, '.gitmodules')
    );
    const onGitmodulesChanged = () => { this.reinitialize(); this.scheduleRefresh(); };
    gitmodulesWatcher.onDidChange(onGitmodulesChanged);
    gitmodulesWatcher.onDidCreate(onGitmodulesChanged);
    gitmodulesWatcher.onDidDelete(onGitmodulesChanged);
    this.watchers.push(gitmodulesWatcher);

    const worktreesDir = path.join(repoPath, '.git', 'worktrees');
    const worktreeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(worktreesDir, '**')
    );
    const onWorktreesChanged = () => { this.worktreeListeners.forEach(listener => listener(repoId)); };
    worktreeWatcher.onDidChange(onWorktreesChanged);
    worktreeWatcher.onDidCreate(onWorktreesChanged);
    worktreeWatcher.onDidDelete(onWorktreesChanged);
    this.watchers.push(worktreeWatcher);
  }

  private reinitialize(): void {
    const previousMetadataSignature = getRepositoryMetadataSignature(
      Array.from(this.repoMetas.values()),
    );
    this.repositoryGeneration++;
    this.disposeWatchers();
    this.repos.clear();
    this.repoMetas.clear();
    this.prevHeads.clear();
    this.prevCommits.clear();
    this.prevUntracked.clear();
    this.gitignoreRulesCache.clear();
    this.initialStatusDone = false;

    const folders = vscode.workspace.workspaceFolders ?? [];
    const customColors = vscode.workspace.getConfiguration('versiondock').get<Record<string, string>>('projectColors', {});
    const discoveredGitRepoPaths: string[] = [];
    const seenGitRepoPaths = new Set<string>();
    const gitApi = getVscodeGitApi();
    const colorIdx = { value: 0 };

    if (gitApi?.state === 'initialized') {
      for (const repository of gitApi.repositories) {
        if (repository.kind !== 'repository' && repository.kind !== 'submodule') continue;
        const repoPath = repository.rootUri.fsPath;
        if (!folders.some(folder => isWithinPath(folder.uri.fsPath, repoPath))) continue;
        if (seenGitRepoPaths.has(repoPath)) continue;
        seenGitRepoPaths.add(repoPath);
        discoveredGitRepoPaths.push(repoPath);
      }
    }

    for (const folder of folders) {
      const repoPath = folder.uri.fsPath;
      const gitDir = path.join(repoPath, '.git');
      if (!fs.existsSync(gitDir) || seenGitRepoPaths.has(repoPath)) continue;
      seenGitRepoPaths.add(repoPath);
      discoveredGitRepoPaths.push(repoPath);
    }

    const repositoryScanMaxDepth = this.getRepositoryScanMaxDepth();
    if (repositoryScanMaxDepth > 0) {
      for (const folder of folders) {
        for (const repoPath of findNestedRepoPaths(
          folder.uri.fsPath,
          repositoryScanMaxDepth,
          candidatePath => this.isRepositoryScanIgnored(candidatePath, folder.uri.fsPath),
        )) {
          const depth = this.repositoryScanDepth(folder.uri.fsPath, repoPath);
          if (depth < 0 || depth > repositoryScanMaxDepth) continue;
          if (this.isRepositoryScanIgnored(repoPath, folder.uri.fsPath)) continue;
          if (seenGitRepoPaths.has(repoPath)) continue;
          seenGitRepoPaths.add(repoPath);
          discoveredGitRepoPaths.push(repoPath);
        }
      }
    }

    discoveredGitRepoPaths.forEach((repoPath) => {
      const meta = this.buildRepoMeta(repoPath, colorIdx.value++, folders, customColors);
      this.repoMetas.set(meta.id, meta);
      this.repos.set(meta.id, this.createGitService(meta.id, meta.rootPath));
      this.setupWatcher(meta.rootPath, meta.id);
      if ((meta.depth ?? 0) === 0 && !meta.isWorktree) {
        this.discoverSubmodules(meta.rootPath, meta.id, 1, colorIdx, customColors);
      }
      this.setupRepositoryAuxWatchers(meta.rootPath, meta.id);
    });

    for (const folder of folders) {
      for (const repoPath of findNestedSvnRepoPaths(
        folder.uri.fsPath,
        SVN_REPOSITORY_SCAN_MAX_DEPTH,
        candidatePath => this.isRepositoryScanIgnored(candidatePath, folder.uri.fsPath),
      )) {
        const meta = this.buildSvnRepoMeta(repoPath, colorIdx.value++, folders, customColors);
        if (this.repos.has(meta.id)) continue;
        this.repoMetas.set(meta.id, meta);
        this.repos.set(meta.id, this.createSvnService(meta.id, meta.rootPath));
        this.setupSvnWatcher(meta.rootPath);
      }
    }

    this.applyNestedRepoMetadata();
    const metas = Array.from(this.repoMetas.values());
    this.logger.debug('Repositories', 'Repository discovery completed', {
      repositoryCount: metas.length,
      gitRepositoryCount: metas.filter(meta => meta.kind !== 'svn').length,
      svnRepositoryCount: metas.filter(meta => meta.kind === 'svn').length,
      generation: this.repositoryGeneration,
    });
    // vscode.git can become ready after VersionDock and force a watcher-only
    // rebuild. Only notify consumers when discovery actually changed the
    // repository metadata; otherwise the Git Log reloads a second time after
    // its initial data has already rendered.
    if (getRepositoryMetadataSignature(metas) !== previousMetadataSignature) {
      this.reposListeners.forEach(l => l());
    }
    void this.syncRemoteProtectedBranchesSilently();
  }

  private getRepositoryScanMaxDepth(): number {
    const value = vscode.workspace
      .getConfiguration('versiondock')
      .get<number>('repositoryScanMaxDepth', DEFAULT_REPOSITORY_SCAN_MAX_DEPTH);

    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return DEFAULT_REPOSITORY_SCAN_MAX_DEPTH;
    }
    return Math.min(10, Math.max(0, Math.floor(value)));
  }

  private getRepositoryScanIgnoredFolders(): string[] {
    const value = vscode.workspace
      .getConfiguration('versiondock')
      .get<string[]>('repositoryScanIgnoredFolders', DEFAULT_REPOSITORY_SCAN_IGNORED_FOLDERS);

    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      : DEFAULT_REPOSITORY_SCAN_IGNORED_FOLDERS;
  }

  private detectLinkedWorktree(rootPath: string): { isWorktree: boolean; mainWorktreePath?: string } {
    const mainWorktreePath = extractMainWorktreePath(rootPath);
    if (!mainWorktreePath) {
      return { isWorktree: false };
    }

    // Only treat as worktree if the main repo is also known/open in this workspace.
    // If opened standalone, behave as a normal repo.
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const isWorktree = workspacePaths.some(wp => isPathEqual(wp, mainWorktreePath))
      || this.getRepo(buildRepoId(mainWorktreePath, 'git')) !== undefined;
    return { isWorktree, mainWorktreePath };
  }

  private setupRepositoryAuxWatchers(repoPath: string, repoId: string): void {
    // Always watch .gitmodules regardless of whether VS Code Git API is available —
    // setupWatcher() returns early when vsRepo is found and skips the FileSystemWatcher fallback.
    const gitmodulesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repoPath, '.gitmodules')
    );
    const onGitmodulesChanged = () => { this.reinitialize(); this.setupGitInitWatchers(); this.scheduleRefresh(); };
    gitmodulesWatcher.onDidChange(onGitmodulesChanged);
    gitmodulesWatcher.onDidCreate(onGitmodulesChanged);
    gitmodulesWatcher.onDidDelete(onGitmodulesChanged);
    this.watchers.push(gitmodulesWatcher);

    // Watch .git/worktrees/ so the panel updates when worktrees are added/removed.
    // Linked worktrees have .git as a file; their main repo owns .git/worktrees/.
    const gitDir = path.join(repoPath, '.git');
    try {
      if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) return;
    } catch {
      return;
    }

    const worktreesDir = path.join(gitDir, 'worktrees');
    const worktreeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(worktreesDir, '**')
    );
    const onWorktreesChanged = () => { this.worktreeListeners.forEach(l => l(repoId)); };
    worktreeWatcher.onDidChange(onWorktreesChanged);
    worktreeWatcher.onDidCreate(onWorktreesChanged);
    worktreeWatcher.onDidDelete(onWorktreesChanged);
    this.watchers.push(worktreeWatcher);
  }

  private repositoryScanDepth(workspaceRoot: string, candidatePath: string): number {
    const rel = path.relative(workspaceRoot, candidatePath);
    if (!rel) return 0;
    if (rel.startsWith('..') || path.isAbsolute(rel)) return -1;
    return rel.split(path.sep).filter(Boolean).length;
  }

  private getGitignoreRules(dirPath: string): string[] {
    if (this.gitignoreRulesCache.has(dirPath)) {
      return this.gitignoreRulesCache.get(dirPath)!;
    }
    const gitignorePath = path.join(dirPath, '.gitignore');
    try {
      if (fs.existsSync(gitignorePath)) {
        const content = fs.readFileSync(gitignorePath, 'utf8');
        const rules = content
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.length > 0 && !line.startsWith('#') && !line.startsWith('!'))
          .map(line => line.replace(/\\/g, '/').replace(/\/+$/, ''));
        this.gitignoreRulesCache.set(dirPath, rules);
        return rules;
      }
    } catch {
      // ignore read error
    }
    this.gitignoreRulesCache.set(dirPath, []);
    return [];
  }

  private isRepositoryScanIgnored(candidatePath: string, workspaceRoot: string): boolean {
    const rel = path.relative(workspaceRoot, candidatePath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;

    const normalizedRel = rel.split(path.sep).join('/');
    const parts = normalizedRel.split('/').filter(Boolean);
    if (parts.includes('.git')) return true;

    const configuredIgnored = this.getRepositoryScanIgnoredFolders().some(rawPattern => {
      const pattern = rawPattern.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
      if (!pattern) return false;
      if (!pattern.includes('/')) return parts.includes(pattern);
      return normalizedRel === pattern || normalizedRel.startsWith(`${pattern}/`);
    });
    if (configuredIgnored) return true;

    const excludeIgnored = vscode.workspace
      .getConfiguration('versiondock')
      .get<boolean>('git.excludeIgnoredDirectories', true);

    if (excludeIgnored) {
      const rootRules = this.getGitignoreRules(workspaceRoot);
      for (const rule of rootRules) {
        if (!rule) continue;
        const cleanRule = rule.replace(/^\/+/, '');
        if (!cleanRule.includes('/')) {
          if (parts.includes(cleanRule)) return true;
        } else {
          if (normalizedRel === cleanRule || normalizedRel.startsWith(`${cleanRule}/`)) return true;
        }
      }

      let currentDir = path.dirname(candidatePath);
      while (currentDir.length >= workspaceRoot.length && currentDir.startsWith(workspaceRoot)) {
        if (currentDir !== workspaceRoot) {
          const dirRules = this.getGitignoreRules(currentDir);
          const relToDir = path.relative(currentDir, candidatePath).split(path.sep).join('/');
          const relParts = relToDir.split('/').filter(Boolean);
          for (const rule of dirRules) {
            if (!rule) continue;
            const cleanRule = rule.replace(/^\/+/, '');
            if (!cleanRule.includes('/')) {
              if (relParts.includes(cleanRule)) return true;
            } else {
              if (relToDir === cleanRule || relToDir.startsWith(`${cleanRule}/`)) return true;
            }
          }
        }
        currentDir = path.dirname(currentDir);
      }
    }

    return false;
  }

  private discoverNestedRepositories(
    workspaceRoot: string,
    maxDepth: number,
    colorIdx: { value: number },
    customColors: Record<string, string>,
  ): void {
    const visit = (parentPath: string, parentDepth: number) => {
      if (parentDepth >= maxDepth) return;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(parentPath, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;

        const childPath = path.join(parentPath, entry.name);
        if (this.isRepositoryScanIgnored(childPath, workspaceRoot)) continue;

        const childDepth = parentDepth + 1;
        const gitDir = path.join(childPath, '.git');
        if (fs.existsSync(gitDir)) {
          this.registerScannedRepository(childPath, workspaceRoot, colorIdx, customColors);
          continue;
        }

        if (childDepth < maxDepth) {
          visit(childPath, childDepth);
        }
      }
    };

    visit(workspaceRoot, 0);
  }

  private registerScannedRepository(
    repoPath: string,
    workspaceRoot: string,
    colorIdx: { value: number },
    customColors: Record<string, string>,
  ): void {
    const normalizedRepoPath = path.normalize(repoPath);
    const repoId = buildRepoId(normalizedRepoPath, 'git');
    if (this.repos.has(repoId)) return;

    const relPath = path.relative(workspaceRoot, normalizedRepoPath).split(path.sep).join('/');
    const displayName = relPath && !relPath.startsWith('..') ? relPath : path.basename(normalizedRepoPath);
    const basename = path.basename(normalizedRepoPath);
    const customColor = customColors[displayName] ?? customColors[basename];
    const color = customColor ?? PROJECT_COLORS[colorIdx.value++ % PROJECT_COLORS.length];
    const { isWorktree, mainWorktreePath } = this.detectLinkedWorktree(normalizedRepoPath);

    const meta: RepoMeta = {
      id: repoId,
      name: displayName,
      rootPath: normalizedRepoPath,
      color,
      depth: 0,
      isWorktree,
      mainWorktreePath,
      kind: 'git',
    };
    this.repoMetas.set(repoId, meta);
    this.repos.set(repoId, this.createGitService(repoId, normalizedRepoPath));
    this.setupWatcher(normalizedRepoPath, repoId);
    this.discoverSubmodules(normalizedRepoPath, repoId, 1, colorIdx, customColors);
    this.setupRepositoryAuxWatchers(normalizedRepoPath, repoId);
  }

  private discoverSubmodules(
    parentPath: string,
    parentRepoId: string,
    depth: number,
    colorIdx: { value: number },
    customColors: Record<string, string>,
  ): void {
    if (depth > MAX_SUBMODULE_DEPTH) return;

    const gitmodulesPath = path.join(parentPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return;

    let raw: string;
    try { raw = fs.readFileSync(gitmodulesPath, 'utf8'); } catch { return; }

    // Parse submodule paths from .gitmodules
    const subPaths: string[] = [];
    for (const line of raw.split('\n')) {
      const kvMatch = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
      if (kvMatch) subPaths.push(kvMatch[1].trim());
    }

    for (const subRelPath of subPaths) {
      const subAbsPath = path.join(parentPath, subRelPath);
      const subGitDir = path.join(subAbsPath, '.git');

      // Submodule may be uninitialized — .git may not exist yet
      if (!fs.existsSync(subAbsPath)) continue;

      // Avoid double-registering a path that's already a workspace folder
      const subRepoId = buildRepoId(subAbsPath, 'git');
      if (this.repos.has(subRepoId)) continue;

      // A submodule path must stay inside its parent repository.
      if (!isWithinPath(parentPath, subAbsPath)) continue;

      const subName = path.basename(subRelPath);
      // Each submodule gets its own color slot — same as a regular workspace folder.
      const color = customColors[subName] ?? PROJECT_COLORS[colorIdx.value++ % PROJECT_COLORS.length];

      const meta: RepoMeta = {
        id: subRepoId,
        name: subName,
        rootPath: subAbsPath,
        color,
        isSubmodule: true,
        parentRepoId,
        submodulePath: subRelPath,
        depth,
        kind: 'git',
      };
      this.repoMetas.set(subRepoId, meta);
      this.repos.set(subRepoId, this.createGitService(subRepoId, subAbsPath));

      // Only set up watcher if the submodule is initialized (has .git)
      if (fs.existsSync(subGitDir)) {
        this.setupWatcher(subAbsPath, subRepoId);
      } else {
        const autoInit = vscode.workspace
          .getConfiguration('versiondock')
          .get<boolean>('git.cloneRecursiveSubmodules', true);
        if (autoInit) {
          const parentRepo = this.repos.get(parentRepoId);
          if (parentRepo && parentRepo.kind === 'git') {
            void parentRepo.updateSubmodule(subRelPath, true, true).then(() => {
              if (fs.existsSync(subGitDir)) {
                this.setupWatcher(subAbsPath, subRepoId);
                this.scheduleRefresh();
              }
            }).catch(error => {
              this.logger.debug('WorkspaceGitManager', 'Failed to auto-init submodule', { subRelPath, error: String(error) });
            });
          }
        }
      }

      // Recurse into nested submodules
      this.discoverSubmodules(subAbsPath, subRepoId, depth + 1, colorIdx, customColors);
    }
  }

  private setupWatcher(repoPath: string, repoId: string): void {
    // Primary: VS Code Git API state changes — fired for all git operations
    // (built-in git, VersionDock, terminal, other extensions).
    const vsRepo = getVscodeRepository(repoPath);
    if (vsRepo) {
      this.prevHeads.set(repoId, vsRepo.state.HEAD?.name ?? '');
      this.prevCommits.set(repoId, vsRepo.state.HEAD?.commit ?? '');
      const d = vsRepo.state.onDidChange(() => {
        const currentHead = vsRepo.state.HEAD?.name ?? '';
        const currentCommit = vsRepo.state.HEAD?.commit ?? '';
        const prevHead = this.prevHeads.get(repoId) ?? '';
        const prevCommit = this.prevCommits.get(repoId) ?? '';
        if (currentHead !== prevHead) {
          // Branch checkout — fire both refresh and branch listeners.
          this.prevHeads.set(repoId, currentHead);
          this.prevCommits.set(repoId, currentCommit);
          this.beginStatusStabilization();
          this.scheduleRefresh();
          this.scheduleBranchRefresh();
        } else if (currentCommit !== prevCommit) {
          // New commit / pull / rebase — branch name unchanged but commit moved.
          // Fire branch listeners so the log panel refreshes.
          this.prevCommits.set(repoId, currentCommit);
          this.beginStatusStabilization();
          this.scheduleRefresh();
          this.scheduleBranchRefresh();
        } else {
          this.scheduleRefresh();
        }
      });
      this.watchers.push(d);
      // vsRepo.state.onDidChange covers git index changes but may miss rapid
      // working-tree edits that haven't been staged. Also watch saved documents
      // inside this repo — onDidSaveTextDocument is already set up in constructor.
      return;
    }

    // Fallback: FileSystemWatcher when vscode.git is unavailable.
    // Watch .git/index (stage changes), .git/HEAD + refs (branch changes),
    // and all working-tree file creates/changes/deletes.
    const ignoredPathPattern = /(?:^|[\\/])(node_modules|\.git|\.svn|dist|build|target|out|\.next|\.nuxt|\.cache|vendor)(?:[\\/]|$)/;
    const shouldIgnore = (uri?: vscode.Uri) => Boolean(uri && ignoredPathPattern.test(uri.fsPath));

    const onChanged = (uri?: vscode.Uri) => {
      if (shouldIgnore(uri)) return;
      this.scheduleRefresh();
    };
    const onBranchChanged = (uri?: vscode.Uri) => {
      if (shouldIgnore(uri)) return;
      this.scheduleRefresh();
      this.scheduleBranchRefresh();
    };

    // .git internals
    const w1 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.git/index'));
    const w2 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.git/HEAD'));
    const w3 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.git/refs/**'));
    // Working-tree: all three events (create, change, delete) — excludes .git itself
    const w4 = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '**/*'));
    // .gitmodules watcher is already created in reinitialize() for all workspace folders

    w1.onDidChange(onChanged); w1.onDidCreate(onChanged); w1.onDidDelete(onChanged);
    w2.onDidChange(onBranchChanged); w2.onDidCreate(onBranchChanged);
    w3.onDidChange(onBranchChanged); w3.onDidCreate(onBranchChanged); w3.onDidDelete(onBranchChanged);
    w4.onDidCreate(onChanged); w4.onDidChange(onChanged); w4.onDidDelete(onChanged);

    this.watchers.push(w1, w2, w3, w4);
  }

  private setupSvnWatcher(repoPath: string): void {
    const ignoredPathPattern = /(?:^|[\\/])(node_modules|\.git|\.svn|dist|build|target|out|\.next|\.nuxt|\.cache|vendor)(?:[\\/]|$)/;
    const shouldIgnore = (uri?: vscode.Uri) => Boolean(uri && ignoredPathPattern.test(uri.fsPath));

    const onChanged = (uri?: vscode.Uri) => {
      if (shouldIgnore(uri)) return;
      this.scheduleRefresh();
    };
    const onBranchChanged = (uri?: vscode.Uri) => {
      if (shouldIgnore(uri)) return;
      this.scheduleRefresh();
      this.scheduleBranchRefresh();
    };

    const wcDb = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.svn/wc.db'));
    const entries = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '.svn/entries'));
    const workingTree = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(repoPath, '**/*'));

    wcDb.onDidChange(onBranchChanged); wcDb.onDidCreate(onBranchChanged); wcDb.onDidDelete(onBranchChanged);
    entries.onDidChange(onBranchChanged); entries.onDidCreate(onBranchChanged); entries.onDidDelete(onBranchChanged);
    workingTree.onDidCreate(onChanged); workingTree.onDidChange(onChanged); workingTree.onDidDelete(onChanged);

    this.watchers.push(wcDb, entries, workingTree);
  }

  private scheduleRefresh(): void {
    if (this.disposed) return;
    if (this.refreshDebounce) clearTimeout(this.refreshDebounce);
    this.refreshDebounce = setTimeout(() => {
      this.refreshDebounce = null;
      this.refreshPending = true;
      void this.drainRefreshQueue().catch(error => {
        this.logger.error('Repositories', 'Failed to refresh repository status', error);
      });
    }, 300);
  }

  private async drainRefreshQueue(): Promise<void> {
    if (this.refreshInFlight || this.disposed) return;
    this.refreshInFlight = true;
    try {
      do {
        this.refreshPending = false;
        await this.refreshStatuses();
      } while (this.refreshPending && !this.disposed);
    } finally {
      this.refreshInFlight = false;
      if (this.refreshPending && !this.disposed) {
        void this.drainRefreshQueue().catch(error => {
          this.logger.error('Repositories', 'Failed to refresh repository status', error);
        });
      }
    }
  }

  private async refreshStatuses(): Promise<void> {
    if (this.statusUpdateSuppressionDepth > 0) return;
    const generation = this.repositoryGeneration;
    const status = await this.getAllStatusesFresh();
    if (this.statusUpdateSuppressionDepth > 0) return;
    // Repository discovery can be rebuilt while Git/SVN commands are still in
    // flight. Never publish results produced by services from the old repo set.
    if (this.disposed || generation !== this.repositoryGeneration) return;

    if (this.statusStabilizationSignature !== undefined) {
      const signature = getWorkspaceStatusSignature(status);
      if (this.statusStabilizationSignature === null || this.statusStabilizationSignature !== signature) {
        this.statusStabilizationSignature = signature;
        this.scheduleRefresh();
        return;
      }
      this.statusStabilizationSignature = undefined;
    }

    this.publishStatus(status);
  }

  private beginStatusStabilization(): void {
    this.statusStabilizationSignature = null;
  }

  private publishStatus(status: WorkspaceStatus): void {
    this.detectNewUntrackedFiles(status);
    this.lastPublishedStatus = status;
    this.statusListeners.forEach(l => l(status));

    const autoCommitMerge = vscode.workspace.getConfiguration('versiondock').get<boolean>('git.autoCommitResolvedMerge', true);
    for (const repoStatus of status.repos) {
      if (repoStatus.operationState === 'merge' && repoStatus.conflictCount === 0 && autoCommitMerge) {
        void this.completeMergeIfResolved(repoStatus.repoId).catch(error => {
          this.logger.error('Repositories', 'Failed to auto-commit resolved merge', error, { repoId: repoStatus.repoId });
        });
      } else {
        this.promptResolvedOperationIfApplicable(repoStatus);
      }
    }
  }

  private promptedResolvedOps = new Set<string>();

  private promptResolvedOperationIfApplicable(repoStatus: RepoStatus): void {
    if (repoStatus.conflictCount > 0) {
      this.promptedResolvedOps.delete(repoStatus.repoId);
      return;
    }
    const op = repoStatus.operationState;
    if (!op) {
      this.promptedResolvedOps.delete(repoStatus.repoId);
      return;
    }
    if (op !== 'rebase' && op !== 'cherry-pick' && op !== 'revert' && op !== 'merge') return;

    const opKey = `${repoStatus.repoId}:${op}`;
    if (this.promptedResolvedOps.has(opKey)) return;
    this.promptedResolvedOps.add(opKey);

    const repo = this.repos.get(repoStatus.repoId);
    if (!repo) return;
    const meta = this.repoMetas.get(repoStatus.repoId);
    const repoName = meta?.name ?? repoStatus.repoId;

    if (op === 'merge') {
      const commitLabel = t('Commit Merge');
      const abortLabel = t('Abort Merge');
      const message = t('VersionDock [{0}]: All conflicts resolved. Complete merge commit?', repoName);

      void vscode.window.showInformationMessage(message, commitLabel, abortLabel).then(async choice => {
        if (!choice) return;
        if (choice === commitLabel) {
          try {
            await this.completeMergeIfResolved(repoStatus.repoId);
            this.notifyBranchesChanged();
          } catch (error: unknown) {
            vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repoName, String(error)));
          }
        } else if (choice === abortLabel) {
          try {
            await repo.abortMerge();
            this.notifyBranchesChanged();
            vscode.window.showInformationMessage(t('VersionDock [{0}]: Operation aborted. The repository has been restored.', repoName));
          } catch (error: unknown) {
            vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repoName, String(error)));
          }
        }
      });
      return;
    }

    const continueLabel = op === 'rebase'
      ? t('Continue Rebase')
      : op === 'cherry-pick'
        ? t('Continue Cherry-Pick')
        : t('Continue Revert');
    const abortLabel = op === 'rebase'
      ? t('Abort Rebase')
      : op === 'cherry-pick'
        ? t('Abort Cherry-Pick')
        : t('Abort Revert');

    const message = op === 'rebase'
      ? t('VersionDock [{0}]: All conflicts resolved. Continue rebase?', repoName)
      : op === 'cherry-pick'
        ? t('VersionDock [{0}]: All conflicts resolved. Continue cherry-pick?', repoName)
        : t('VersionDock [{0}]: All conflicts resolved. Continue revert?', repoName);

    void vscode.window.showInformationMessage(message, continueLabel, abortLabel).then(async choice => {
      if (!choice) return;
      if (choice === continueLabel) {
        try {
          if (op === 'rebase') await repo.rebaseContinue();
          else if (op === 'cherry-pick') await repo.cherryPickContinue();
          else if (op === 'revert') await repo.revertContinue();
          this.notifyBranchesChanged();
        } catch (error: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repoName, String(error)));
        }
      } else if (choice === abortLabel) {
        try {
          if (op === 'rebase') await repo.abortRebase();
          else if (op === 'cherry-pick') await repo.cherryPickAbort();
          else if (op === 'revert') await repo.revertAbort();
          this.notifyBranchesChanged();
          vscode.window.showInformationMessage(t('VersionDock [{0}]: Operation aborted. The repository has been restored.', repoName));
        } catch (error: unknown) {
          vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', repoName, String(error)));
        }
      }
    });
  }

  async checkAndNotifyGoneBranches(): Promise<void> {
    const gitRepos = Array.from(this.repos.values()).filter(r => r.kind !== 'svn');
    for (const repo of gitRepos) {
      const goneBranches = await repo.getGoneBranches().catch(() => []);
      if (goneBranches.length > 0) {
        const meta = this.repoMetas.get(repo.repoId);
        const repoName = meta?.name ?? repo.repoId;
        const pruneAction = t('Prune Branches');
        const count = goneBranches.length;
        const msg = count === 1
          ? t('VersionDock [{0}]: Local branch "{1}" has a deleted remote tracking branch.', repoName, goneBranches[0])
          : t('VersionDock [{0}]: {1} local branches have deleted remote tracking branches.', repoName, count);
        void vscode.window.showInformationMessage(msg, pruneAction, t('Dismiss')).then(async choice => {
          if (choice === pruneAction) {
            const picked = await vscode.window.showQuickPick(
              goneBranches.map(b => ({ label: `$(git-branch) ${b}`, branchName: b })),
              { canPickMany: true, title: t('Select branches to delete in {0}', repoName) }
            );
            if (picked && picked.length > 0) {
              for (const item of picked) {
                await repo.deleteBranch(item.branchName, false).catch(e => {
                  vscode.window.showErrorMessage(t('Failed to delete branch {0}: {1}', item.branchName, String(e)));
                });
              }
              this.notifyBranchesChanged();
            }
          }
        });
      }
    }
  }

  async completeMergeIfResolved(repoId: string): Promise<MergeCommitResult | undefined> {
    const existingTask = this.mergeCompletionTasks.get(repoId);
    if (existingTask) return existingTask;

    const repo = this.repos.get(repoId);
    if (!repo) return undefined;
    const task = this.runWithStatusUpdatesSuppressed(async () => {
      const result = await repo.commitMergeIfResolved();
      if (result) {
        vscode.window.showInformationMessage(
          t('VersionDock: Merged "{0}" into "{1}" and committed.', result.sourceBranch ?? t('the incoming branch'), result.targetBranch)
        );
      }
      return result;
    }, 'merge').finally(() => {
      if (this.mergeCompletionTasks.get(repoId) === task) this.mergeCompletionTasks.delete(repoId);
    });
    this.mergeCompletionTasks.set(repoId, task);
    return task;
  }

  private setupAutoRefreshTimer(): void {
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }

    const configuredSeconds = vscode.workspace
      .getConfiguration('versiondock')
      .get<number>('autoRefreshInterval', 0);
    if (typeof configuredSeconds !== 'number' || !Number.isFinite(configuredSeconds) || configuredSeconds <= 0) return;

    const intervalMs = Math.min(2_147_483_647, Math.max(1000, configuredSeconds * 1000));
    this.autoRefreshTimer = setInterval(() => this.scheduleRefresh(), intervalMs);
  }

  private setupAutoFetchTimer(): void {
    if (this.autoFetchTimer) {
      clearInterval(this.autoFetchTimer);
      this.autoFetchTimer = null;
    }

    const configuredMinutes = vscode.workspace
      .getConfiguration('versiondock')
      .get<number>('git.autoFetchInterval', 15);
    if (typeof configuredMinutes !== 'number' || !Number.isFinite(configuredMinutes) || configuredMinutes <= 0) return;

    const intervalMs = Math.min(2_147_483_647, Math.max(60_000, configuredMinutes * 60_000));
    this.autoFetchTimer = setInterval(() => {
      void this.autoFetchSilently();
    }, intervalMs);
  }

  private async autoFetchSilently(): Promise<void> {
    const repos = Array.from(this.repos.values()).filter(r => r.kind !== 'svn');
    if (repos.length === 0) return;
    try {
      await Promise.allSettled(repos.map(repo => repo.fetchAll()));
      this.scheduleRefresh();
      this.notifyBranchesChanged();
      void this.syncRemoteProtectedBranchesSilently();
    } catch (error) {
      this.logger.warn('WorkspaceGitManager', 'Background auto-fetch failed', { error: String(error) });
    }
  }

  private async syncRemoteProtectedBranchesSilently(): Promise<void> {
    const syncEnabled = vscode.workspace
      .getConfiguration('versiondock')
      .get<boolean>('git.syncProtectedBranchesFromGitHub', true);
    if (!syncEnabled) return;

    const githubProvider = new GitHubRemoteProvider(this.logger);
    let gitlabProvider: GitLabRemoteProvider | undefined;

    for (const [repoId, repo] of this.repos.entries()) {
      if (repo.kind !== 'git') continue;
      try {
        const remotes = await repo.getRemotes();
        const originUrl = remotes[0];
        if (!originUrl) continue;

        let protectedBranches: string[] = [];
        if (/github\.com/i.test(originUrl)) {
          protectedBranches = await githubProvider.getProtectedBranches(originUrl);
        } else {
          if (!gitlabProvider && this.context) {
            gitlabProvider = new GitLabRemoteProvider(this.context, this.logger);
          }
          if (gitlabProvider) {
            protectedBranches = await gitlabProvider.getProtectedBranches(originUrl);
          }
        }

        if (protectedBranches.length > 0) {
          setRemoteProtectedBranches(repoId, protectedBranches);
          this.logger.debug('WorkspaceGitManager', 'Synced remote protected branches', {
            repoId,
            count: protectedBranches.length,
            branches: protectedBranches,
          });
        }
      } catch (err) {
        this.logger.debug('WorkspaceGitManager', 'Silent sync of remote protected branches skipped', { repoId, error: String(err) });
      }
    }
  }

  reinitializeAndRefresh(): void {
    this.reinitialize();
    this.setupGitInitWatchers();
    this.scheduleRefresh();
  }

  private detectNewUntrackedFiles(status: WorkspaceStatus): void {
    const newlyUntracked: Array<{ repo: GitService; relPath: string }> = [];

    for (const repoStatus of status.repos) {
      const repoId = repoStatus.repoId;
      const repo = this.repos.get(repoId);
      if (!repo) continue;

      const currentUntracked = new Set(
        repoStatus.unstagedFiles.filter(f => f.status === 'untracked').map(f => f.path)
      );
      const prev = this.prevUntracked.get(repoId);

      if (prev && this.initialStatusDone) {
        for (const p of currentUntracked) {
          if (!prev.has(p)) newlyUntracked.push({ repo, relPath: p });
        }
      }

      this.prevUntracked.set(repoId, currentUntracked);
    }

    this.initialStatusDone = true;

    if (newlyUntracked.length > 0) {
      const cfg = vscode.workspace.getConfiguration('versiondock');
      const enabled = cfg.get<boolean>('promptAddUntrackedToGit', true);
      const viewMode = cfg.get<string>('changesViewMode', 'simplified');
      if (enabled && viewMode !== 'simplified') {
        void this.promptAddToGit(newlyUntracked);
      }
    }
  }

  private async promptAddToGit(
    files: Array<{ repo: GitService; relPath: string }>,
  ): Promise<void> {
    const names = files.map(f => f.relPath);
    const kind = files.some(f => f.repo.kind === 'svn') ? 'SVN' : 'Git';
    const label = names.length === 1
      ? t('Do you want to add "{0}" to {1}?', names[0], kind)
      : t('Do you want to add {0} new files to {1}?', names.length, kind);

    const add = t('Add');
    const answer = await vscode.window.showInformationMessage(label, add, t('Cancel'));
    if (answer !== add) return;

    for (const { repo, relPath } of files) {
      await repo.stageFiles([relPath]).catch(() => {});
    }
    this.scheduleRefresh();
  }

  notifyBranchesChanged(): void {
    this.scheduleRefresh();
    this.scheduleBranchRefresh();
  }

  private scheduleBranchRefresh(): void {
    if (this.branchDebounce) clearTimeout(this.branchDebounce);
    this.branchDebounce = setTimeout(() => {
      this.branchDebounce = null;
      this.branchListeners.forEach(l => l());
    }, 400);
  }

  onBranchChange(listener: BranchListener): vscode.Disposable {
    this.branchListeners.push(listener);
    return new vscode.Disposable(() => {
      this.branchListeners = this.branchListeners.filter(l => l !== listener);
    });
  }

  onReposChange(listener: BranchListener): vscode.Disposable {
    this.reposListeners.push(listener);
    return new vscode.Disposable(() => {
      this.reposListeners = this.reposListeners.filter(l => l !== listener);
    });
  }

  onWorktreeChange(listener: WorktreeListener): vscode.Disposable {
    this.worktreeListeners.push(listener);
    return new vscode.Disposable(() => {
      this.worktreeListeners = this.worktreeListeners.filter(l => l !== listener);
    });
  }

  async getWorktrees(repoId: string): Promise<WorktreeEntry[]> {
    const repo = this.repos.get(repoId);
    if (!repo) return [];
    try { return await repo.getWorktrees(); } catch { return []; }
  }

  async getAllWorktrees(): Promise<Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }>> {
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    const results: Array<{ repoId: string; repoName: string; repoColor: string; worktrees: WorktreeEntry[]; isLinkedWorktree: boolean }> = [];
    for (const [repoId, repo] of this.repos) {
      const meta = this.repoMetas.get(repoId);
      if (!meta) continue;
      if ((meta.kind ?? 'git') !== 'git') continue;
      if (meta.isSubmodule) continue;
      if (meta.isWorktree) continue;
      // Detect standalone linked worktree: .git is a file even though isWorktree is false
      // (isWorktree is false when the main repo is not in the same workspace)
      const gitDir = path.join(meta.rootPath, '.git');
      const isLinkedWorktree = fs.existsSync(gitDir) && fs.statSync(gitDir).isFile();
      try {
        const worktrees = (await repo.getWorktrees()).map(w => ({
          ...w,
          isInWorkspace: workspacePaths.some(wp => isWithinPath(wp, w.path)),
        }));
        results.push({ repoId, repoName: meta.name, repoColor: meta.color, worktrees, isLinkedWorktree });
      } catch {
        results.push({ repoId, repoName: meta.name, repoColor: meta.color, worktrees: [], isLinkedWorktree });
      }
    }
    return results;
  }

  private disposeWatchers(): void {
    this.watchers.forEach(d => d.dispose());
    this.watchers = [];
    if (this.refreshDebounce) { clearTimeout(this.refreshDebounce); this.refreshDebounce = null; }
    if (this.refreshFollowUp) { clearTimeout(this.refreshFollowUp); this.refreshFollowUp = null; }
    if (this.branchDebounce) { clearTimeout(this.branchDebounce); this.branchDebounce = null; }
  }

  onStatusChange(listener: StatusListener): vscode.Disposable {
    this.statusListeners.push(listener);
    return new vscode.Disposable(() => {
      this.statusListeners = this.statusListeners.filter(l => l !== listener);
    });
  }

  onStatusOperationChange(listener: StatusOperationListener): vscode.Disposable {
    this.statusOperationListeners.push(listener);
    return new vscode.Disposable(() => {
      this.statusOperationListeners = this.statusOperationListeners.filter(l => l !== listener);
    });
  }

  async runWithStatusUpdatesSuppressed<T>(operation: () => Promise<T>, kind?: StatusOperationKind, label?: string): Promise<T> {
    if (this.statusUpdateSuppressionDepth === 0) {
      this.beginStatusStabilization();
      this.statusOperationListeners.forEach(listener => listener(true, kind, label));
    }
    this.statusUpdateSuppressionDepth += 1;
    try {
      return await operation();
    } finally {
      this.statusUpdateSuppressionDepth -= 1;
      if (this.statusUpdateSuppressionDepth === 0) {
        this.scheduleRefresh();
        this.statusOperationListeners.forEach(listener => listener(false, kind, label));
      }
    }
  }

  getRepoMetas(): RepoMeta[] {
    return Array.from(this.repoMetas.values());
  }

  getRepo(repoId: string): GitService | undefined {
    const direct = this.repos.get(repoId);
    if (direct || process.platform !== 'win32') return direct;
    const lower = repoId.toLowerCase();
    for (const [id, repo] of this.repos.entries()) {
      if (id.toLowerCase() === lower) return repo;
    }
    return undefined;
  }

  normalizeRepoIds(repoIds: string[]): string[] {
    return Array.from(new Set(repoIds.map(repoId => {
      if (this.getRepo(repoId)) return repoId;
      const gitRepoId = buildRepoId(repoId, 'git');
      if (this.getRepo(gitRepoId)) return gitRepoId;
      const svnRepoId = buildRepoId(repoId, 'svn');
      if (this.getRepo(svnRepoId)) return svnRepoId;
      return repoId;
    })));
  }

  getRepoMeta(repoId: string): RepoMeta | undefined {
    const direct = this.repoMetas.get(repoId);
    if (direct || process.platform !== 'win32') return direct;
    const lower = repoId.toLowerCase();
    for (const [id, meta] of this.repoMetas.entries()) {
      if (id.toLowerCase() === lower) return meta;
    }
    return undefined;
  }

  getServicesForFile(filePath: string): GitService[] {
    const allMatches = Array.from(this.repoMetas.values())
      .filter(meta => isWithinPath(meta.rootPath, filePath));
    const maxRootLength = allMatches.reduce((max, meta) => Math.max(max, meta.rootPath.length), 0);
    const metas = allMatches
      .filter(meta => meta.rootPath.length === maxRootLength)
      .sort((left, right) => {
        if ((left.kind ?? 'git') === (right.kind ?? 'git')) return left.id.localeCompare(right.id);
        return (left.kind ?? 'git') === 'git' ? -1 : 1;
      });
    return metas
      .map(meta => this.repos.get(meta.id))
      .filter((repo): repo is GitService => !!repo);
  }

  async resolveServiceForFile(
    filePath: string,
    mode: ServiceResolutionMode,
    options: ResolveServiceOptions = {},
  ): Promise<GitService | undefined> {
    const matches = this.getServicesForFile(filePath);
    const filtered = mode === 'prompt' || mode === 'preferGit'
      ? matches
      : matches.filter(repo => repo.kind === mode);

    if (filtered.length === 0) {
      if (options.notFoundMessage) vscode.window.showWarningMessage(options.notFoundMessage);
      return undefined;
    }

    if (mode !== 'prompt' || filtered.length === 1) return filtered[0];

    const items = filtered.flatMap(repo => {
      const meta = this.repoMetas.get(repo.repoId);
      if (!meta) return [];
      return [{
        label: formatRepoLabel(meta),
        description: meta.rootPath,
        detail: getRepoKindDetail(meta.kind),
        repoId: meta.id,
      }];
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: options.title ?? t('Select Git or SVN Repository'),
      placeHolder: options.placeHolder ?? t('Select the repository to use for this file…'),
      matchOnDescription: true,
      matchOnDetail: true,
    });
    return picked ? this.repos.get(picked.repoId) : undefined;
  }

  getServiceForFile(filePath: string): GitService | undefined {
    return this.getServicesForFile(filePath)[0];
  }

  /**
   * Build a map of repoId → Set of submodule relative paths registered under it.
   * Used to reclassify those entries in the parent's file list as 'submodule'
   * instead of 'modified', so the UI can display them with the correct letter.
   */
  private buildSubmodulePaths(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const meta of this.repoMetas.values()) {
      if (!meta.isSubmodule || !meta.parentRepoId || !meta.submodulePath) continue;
      if (!map.has(meta.parentRepoId)) map.set(meta.parentRepoId, new Set());
      map.get(meta.parentRepoId)!.add(meta.submodulePath);
    }
    return map;
  }

  private buildNestedRepoPaths(): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const child of this.repoMetas.values()) {
      // Match VS Code's git SCM behaviour more closely: nested Git repositories
      // should be treated as foreign repos owned by themselves, but nested SVN
      // working copies should still appear in the parent Git repo if Git reports
      // them there. This keeps mixed Git+SVN workspaces aligned with the native
      // SCM count while still avoiding duplicate ownership for nested Git repos.
      if (child.isSubmodule || child.kind === 'svn') continue;
      for (const parent of this.repoMetas.values()) {
        if (parent.id === child.id) continue;
        if (!isWithinPath(parent.rootPath, child.rootPath)) continue;
        const relPath = path.relative(parent.rootPath, child.rootPath).split(path.sep).join('/');
        if (!relPath) continue;
        if (this.getGitmodulesSubmodulePaths(parent.rootPath).has(relPath)) continue;
        if (!map.has(parent.id)) map.set(parent.id, new Set());
        map.get(parent.id)!.add(relPath);
      }
    }
    return map;
  }

  private getGitmodulesSubmodulePaths(repoPath: string): Set<string> {
    const result = new Set<string>();
    const gitmodulesPath = path.join(repoPath, '.gitmodules');
    if (!fs.existsSync(gitmodulesPath)) return result;
    let raw = '';
    try { raw = fs.readFileSync(gitmodulesPath, 'utf8'); } catch { return result; }
    for (const line of raw.split('\n')) {
      const kvMatch = line.match(/^\s*path\s*=\s*(.+?)\s*$/);
      if (kvMatch) result.add(kvMatch[1].trim().split(path.sep).join('/'));
    }
    return result;
  }

  private applyNestedRepoOwnership(repos: import('../types/git').RepoStatus[]): import('../types/git').RepoStatus[] {
    const nestedRepoPaths = this.buildNestedRepoPaths();
    return repos.map(repoStatus => {
      const childPaths = nestedRepoPaths.get(repoStatus.repoId);
      if (!childPaths || childPaths.size === 0) return repoStatus;
      const isOwnedByNestedRepo = (filePath: string) => {
        const normalized = filePath.split(path.sep).join('/');
        for (const childPath of childPaths) {
          if (normalized === childPath || normalized.startsWith(`${childPath}/`)) return true;
        }
        return false;
      };
      const stagedFiles = repoStatus.stagedFiles.filter(file => !isOwnedByNestedRepo(file.path));
      const unstagedFiles = repoStatus.unstagedFiles.filter(file => !isOwnedByNestedRepo(file.path));
      return {
        ...repoStatus,
        stagedFiles,
        unstagedFiles,
        conflictCount: [...stagedFiles, ...unstagedFiles].filter(file => file.status === 'conflicted').length,
      };
    });
  }

  private applySubmoduleStatus(repos: import('../types/git').RepoStatus[]): import('../types/git').RepoStatus[] {
    const submodulePaths = this.buildSubmodulePaths();
    return repos.map(r => {
      const subPaths = submodulePaths.get(r.repoId);

      const reclassify = (f: import('../types/git').FileStatus) =>
        subPaths?.has(f.path) ? { ...f, status: 'submodule' as const } : f;

      // Hide any file/directory whose absolute path sits inside a nested git
      // repository — i.e. absolutePath/.git exists (or absolutePath is itself
      // inside such a directory). This matches VS Code's built-in behaviour of
      // not surfacing files from foreign repos in the parent's status panel.
      // We check the first path component so "deep/nested-repo/foo.ts" is also
      // caught even though git reports only "deep/nested-repo/" as untracked.
      const isInsideNestedRepo = (f: import('../types/git').FileStatus): boolean => {
        // Walk from the file's absolute path (inclusive) up to the repo root.
        // git status reports nested repo directories as the directory itself
        // (e.g. "deep/nested-repo/"), so absolutePath IS the nested repo root —
        // we must check it first, then its ancestors.
        // repoId includes the VCS kind suffix ("<root>::git" / "::svn").
        // Path traversal must use the real filesystem root from metadata.
        const repoRoot = this.repoMetas.get(r.repoId)?.rootPath;
        if (!repoRoot) return false;
        let dir = f.absolutePath;
        while (dir !== repoRoot && isWithinPath(repoRoot, dir)) {
          if (fs.existsSync(path.join(dir, '.git'))) return true;
          dir = path.dirname(dir);
        }
        return false;
      };

      return {
        ...r,
        stagedFiles: r.stagedFiles.map(reclassify).filter(f => !isInsideNestedRepo(f)),
        unstagedFiles: r.unstagedFiles.map(reclassify).filter(f => !isInsideNestedRepo(f)),
      };
    });
  }

  async getAllStatuses(): Promise<WorkspaceStatus> {
    if (this.statusUpdateSuppressionDepth > 0 && this.lastPublishedStatus) return this.lastPublishedStatus;
    const results = await Promise.allSettled(
      Array.from(this.repos.values()).map(r => r.getStatus())
    );
    return {
      repos: this.applyNestedRepoOwnership(this.applySubmoduleStatus(
        results
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<GitService['getStatus']>>> => r.status === 'fulfilled')
          .map(r => r.value)
      )),
    };
  }

  /** Like getAllStatuses but forces VSCode's git extension to re-read from disk first. */
  async getAllStatusesFresh(): Promise<WorkspaceStatus> {
    if (this.statusUpdateSuppressionDepth > 0 && this.lastPublishedStatus) return this.lastPublishedStatus;
    const results = await Promise.allSettled(
      Array.from(this.repos.values()).map(r => r.getStatusFresh())
    );
    return {
      repos: this.applyNestedRepoOwnership(this.applySubmoduleStatus(
        results
          .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<GitService['getStatus']>>> => r.status === 'fulfilled')
          .map(r => r.value)
      )),
    };
  }

  async refreshStatusNow(): Promise<WorkspaceStatus> {
    const generation = this.repositoryGeneration;
    const status = await this.getAllStatusesFresh();
    if (this.disposed || generation !== this.repositoryGeneration) return status;
    this.statusStabilizationSignature = undefined;
    this.publishStatus(status);
    return status;
  }

  async getAllBranches(): Promise<BranchInfo[]> {
    const [allBranches, currentBranches] = await Promise.all([
      Promise.allSettled(Array.from(this.repos.values()).map(r => r.getBranches())),
      Promise.allSettled(Array.from(this.repos.values()).map(r => r.getCurrentBranch())),
    ]);

    const branches = allBranches
      .filter((r): r is PromiseFulfilledResult<BranchInfo[]> => r.status === 'fulfilled')
      .flatMap(r => r.value);

    // Merge in getCurrentBranch results: they carry isHead:true and detachedTag.
    // In normal HEAD, getBranches() already marks the right branch isHead:true so
    // the current branch entry is a duplicate — skip it. In detached HEAD on a tag,
    // getBranches() has no isHead:true entry, so we append the HEAD entry so the
    // sidebar knows which tag is active.
    for (const r of currentBranches) {
      if (r.status !== 'fulfilled') continue;
      const cur = r.value;
      if (!cur.detachedTag && !cur.detachedHash) continue; // normal branch — already handled by getBranches()
      // Remove any existing entry for this repoId that might have isHead:true (safety)
      const idx = branches.findIndex(b => b.repoId === cur.repoId && b.isHead);
      if (idx >= 0) branches.splice(idx, 1);
      branches.push(cur);
    }

    // For worktree repos, duplicate their isHead branch entry under the main repo's repoId.
    // The Log Panel shows commits with repoId=mainRepo (since worktrees are filtered out),
    // so headHashByRepo in the webview must be keyed by mainRepo to correctly identify HEAD.
    for (const [repoId, meta] of this.repoMetas) {
      if (!meta.isWorktree || !meta.mainWorktreePath) continue;
      const headBranch = branches.find(b => b.repoId === repoId && b.isHead);
      if (!headBranch) continue;
      const mainRepoId = buildRepoId(meta.mainWorktreePath, 'git');
      // Only add if the main repo doesn't already have an isHead entry with the same hash
      const mainAlreadyHasThisHead = branches.some(
        b => b.repoId === mainRepoId && b.isHead && b.lastCommitHash === headBranch.lastCommitHash
      );
      if (!mainAlreadyHasThisHead) {
        branches.push({ ...headBranch, repoId: mainRepoId });
      }
    }

    return branches;
  }

  async getInterleavedLog(repoIds: string[], limit: number, skip: number, opts?: { filterText?: string; filterAuthor?: string; filterBranch?: string; filterDateFrom?: string; filterDateTo?: string; filterPath?: string; lineRange?: LineRange }): Promise<CommitNode[]> {
    const targets = repoIds.length > 0
      ? repoIds.map(id => this.repos.get(id)).filter(Boolean) as GitService[]
      : Array.from(this.repos.values());

    const pageEnd = Math.max(limit + skip, limit);

    // Build a map from main repo path → worktree GitServices, so getLog can collect
    // unpushed hashes from worktree branches (which appear in the log via --all)
    const worktreesByMainRepo = new Map<string, GitService[]>();
    for (const [repoId, meta] of this.repoMetas) {
      if (meta.isWorktree && meta.mainWorktreePath) {
        const wtService = this.repos.get(repoId);
        if (!wtService) continue;
        const list = worktreesByMainRepo.get(meta.mainWorktreePath) ?? [];
        list.push(wtService);
        worktreesByMainRepo.set(meta.mainWorktreePath, list);
      }
    }

    const results = await Promise.allSettled(
      targets.map(r => r.getLog(pageEnd, 0, { ...opts, worktreeServices: worktreesByMainRepo.get(r.rootPath) ?? [] }))
    );
    const commitLogs = results
      .filter((r): r is PromiseFulfilledResult<CommitNode[]> => r.status === 'fulfilled')
      .map(r => r.value);
    // Each service already returns Git's date order. Merge only the current
    // head of each repository so the workspace log remains date-ordered when
    // several repositories are shown together.
    const allCommits = interleaveCommitLogs(commitLogs);
    return allCommits.slice(skip, skip + limit);
  }

  async getInterleavedGraphLog(repoIds: string[], maxCommits: number): Promise<GraphCommitNode[]> {
    if (maxCommits <= 0) return [];
    const targets = repoIds.length > 0
      ? repoIds.map(id => this.repos.get(id)).filter(Boolean) as GitService[]
      : Array.from(this.repos.values());
    const results = await Promise.allSettled(
      targets.map(repo => {
        const kind = this.repoMetas.get(repo.repoId)?.kind ?? 'git';
        // JetBrains builds its permanent Git layout from the complete graph.
        // Truncating this lightweight topology can change layout indices near
        // the newest commits when older branches merge, so Git must remain
        // complete even though the detailed commit list stays paginated.
        // However, in ultra-large repositories (e.g. hundreds of thousands of commits),
        // an unbounded topology query causes severe memory exhaustion (OOM) and UI freezing.
        // We cap Git topology at a safe upper bound (50,000 commits) to preserve graph
        // stability while preventing out-of-memory crashes.
        // SVN history is linear and may involve a remote request, so its
        // topology can safely retain the configured display limit.
        const gitCap = 50_000;
        return repo.getGraphLog(kind === 'svn' ? maxCommits : gitCap);
      }),
    );
    const graphLogs = results
      .filter((result): result is PromiseFulfilledResult<GraphCommitNode[]> => result.status === 'fulfilled')
      .map(result => result.value);
    return interleaveCommitLogs(graphLogs);
  }

  async fetchAll(): Promise<void> {
    const startedAt = Date.now();
    const repos = Array.from(this.repos.entries());
    this.logger.info('Git', 'Fetching all repositories', { repositoryCount: repos.length });
    const results = await Promise.allSettled(repos.map(([, repo]) => repo.fetchAll()));
    let failedCount = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') return;
      failedCount += 1;
      const [repoId] = repos[index];
      const meta = this.repoMetas.get(repoId);
      const repoName = meta?.name ?? repoId;
      this.logger.error('Git', 'Fetch failed', result.reason, { repoId, repoName });
    });
    this.logger.info('Git', 'Fetch all completed', {
      repositoryCount: repos.length,
      failedCount,
      durationMs: Date.now() - startedAt,
    });
    void this.checkAndNotifyGoneBranches();
  }

  async pullAll(
    rebase = false,
    onProgress?: (completed: number, total: number, repo: GitService) => void,
  ): Promise<Array<{ repoId: string; ok: boolean; message: string }>> {
    const startedAt = Date.now();
    const repos = Array.from(this.repos.values());
    this.logger.info('VCS', 'Pulling all repositories', { repositoryCount: repos.length, rebase });
    const results: Array<{ repoId: string; ok: boolean; message: string }> = [];
    for (let i = 0; i < repos.length; i++) {
      const r = repos[i];
      onProgress?.(i, repos.length, r);
      try {
        const pullPromise = rebase ? r.pullRebase() : r.pull();
        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(() => reject(new Error(t('Pull timed out after 45 seconds.'))), 45_000);
        });
        const message = await Promise.race([pullPromise, timeoutPromise]);
        results.push({ repoId: r.repoId, ok: true, message });
      } catch (error: unknown) {
        results.push({ repoId: r.repoId, ok: false, message: gitErrorDetail(error) });
      }
    }
    this.logger.info('VCS', 'Pull all completed', {
      repositoryCount: repos.length,
      failedCount: results.filter(result => !result.ok).length,
      durationMs: Date.now() - startedAt,
    });
    this.notifyBranchesChanged();
    return results;
  }

  private setupGitInitWatchers(): void {
    this.gitInitWatchers.forEach(d => d.dispose());
    this.gitInitWatchers = [];

    const gitMaxDepth = this.getRepositoryScanMaxDepth();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const onMetadataCreated = (maxDepth: number) => (metadataUri: vscode.Uri) => {
        const repoPath = path.dirname(metadataUri.fsPath);
        const depth = this.repositoryScanDepth(folder.uri.fsPath, repoPath);
        if (depth < 0 || depth > maxDepth) return;
        if (this.isRepositoryScanIgnored(repoPath, folder.uri.fsPath)) return;
        this.reinitialize();
        this.setupGitInitWatchers();
        this.scheduleRefresh();
      };

      // At depth 0 only the workspace root can become a repo. Keep Git and SVN
      // watchers independent so a same-path mixed working copy can gain either
      // VCS after the workspace has already opened.
      if (gitMaxDepth > 0 || !this.repos.has(buildRepoId(folder.uri.fsPath, 'git'))) {
        const gitWatcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder.uri, gitMaxDepth > 0 ? '**/.git' : '.git')
        );
        gitWatcher.onDidCreate(onMetadataCreated(gitMaxDepth));
        this.gitInitWatchers.push(gitWatcher);
      }
      const svnWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder.uri, '**/.svn')
      );
      svnWatcher.onDidCreate(onMetadataCreated(SVN_REPOSITORY_SCAN_MAX_DEPTH));
      this.gitInitWatchers.push(svnWatcher);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.repositoryGeneration++;
    this.refreshPending = false;
    this.disposeWatchers();
    if (this.autoRefreshTimer) {
      clearInterval(this.autoRefreshTimer);
      this.autoRefreshTimer = null;
    }
    if (this.autoFetchTimer) {
      clearInterval(this.autoFetchTimer);
      this.autoFetchTimer = null;
    }
    this.gitInitWatchers.forEach(d => d.dispose());
    this.globalListeners.forEach(d => d.dispose());
    this.globalListeners = [];
  }
}
