import * as vscode from 'vscode';
import { generateNonce } from '../utils/webviewHtml';
import { loadIconTheme, type IconThemeData } from '../utils/IconThemeService';
import { getWebviewI18nPayload, t, type WebviewI18nPayload } from '../utils/l10n';
import { showGitErrorMessage } from '../utils/gitError';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { toGitUri } from '../utils/resourceUri';
import { assertNoSymlinkAncestors } from '../utils/repoPath';
import { scopedKey } from '../utils/scopedKey';
import type { AiCommitExplanationService } from '../aiCommitExplanation/AiCommitExplanationService';
import { buildCommitExplanationContext } from '../aiCommitExplanation/buildCommitExplanationContext';
import type { CommitExplanationCommit, CommitExplanationFile } from '../aiCommitExplanation/types';
import type { VersionDockLogger } from '../utils/Logger';
import type { MergeParentChange, RemoteAccountInfo } from '../types/messages';
import { ShelveDocumentProvider } from '../utils/ShelveDocumentProvider';

function isAccountCompatibleWithRepo(
  acc: RemoteAccountInfo,
  repoRemoteUrl?: string
): boolean {
  if (!repoRemoteUrl) return false;
  const lowerRemote = repoRemoteUrl.toLowerCase();
  const isGitHubRepo = lowerRemote.includes('github.com') || lowerRemote.includes('github');
  const isGiteeRepo = lowerRemote.includes('gitee.com') || lowerRemote.includes('gitee');
  let isGitLabRepo = lowerRemote.includes('gitlab');

  if (!isGitLabRepo && acc.provider === 'gitlab' && acc.host) {
    try {
      const parsedHost = new URL(acc.host).hostname.toLowerCase();
      if (parsedHost && lowerRemote.includes(parsedHost)) {
        isGitLabRepo = true;
      }
    } catch {
      // Ignore URL parse error
    }
  }

  if (acc.provider === 'github') {
    return isGitHubRepo;
  }

  if (acc.provider === 'gitee') {
    return isGiteeRepo;
  }

  if (acc.provider === 'gitlab') {
    return isGitLabRepo && !isGitHubRepo && !isGiteeRepo;
  }

  return false;
}

function findConnectedAvatar(
  authorName: string,
  authorEmail: string,
  remoteAccounts: RemoteAccountInfo[],
  repoRemoteUrl?: string,
): string | null {
  if (!remoteAccounts || remoteAccounts.length === 0) return null;

  const compatibleAccounts = remoteAccounts.filter(acc => isAccountCompatibleWithRepo(acc, repoRemoteUrl));
  if (compatibleAccounts.length === 0) return null;

  const cleanName = (authorName || '').trim().toLowerCase();
  const cleanEmail = (authorEmail || '').trim().toLowerCase();
  const emailPrefix = cleanEmail.includes('@') ? cleanEmail.split('@')[0]! : cleanEmail;
  const strippedEmailPrefix = emailPrefix.replace(/\d+$/, '');
  const strippedName = cleanName.replace(/\d+$/, '');

  for (const acc of compatibleAccounts) {
    if (!acc.avatarUrl) continue;
    const username = (acc.username || '').trim().toLowerCase();
    const displayName = (acc.name || '').trim().toLowerCase();
    const emails = (acc.emails || []).map(e => e.trim().toLowerCase());

    if (cleanName && cleanName === username) return acc.avatarUrl;
    if (cleanName && displayName && cleanName === displayName) return acc.avatarUrl;
    if (cleanEmail && emails.includes(cleanEmail)) return acc.avatarUrl;
    if (emailPrefix && emailPrefix === username) return acc.avatarUrl;
    if (strippedEmailPrefix.length >= 3 && strippedEmailPrefix === username) return acc.avatarUrl;
    if (strippedName.length >= 3 && strippedName === username) return acc.avatarUrl;
    if (displayName && strippedName.length >= 3 && strippedName === displayName.replace(/\d+$/, '')) {
      return acc.avatarUrl;
    }
  }

  return null;
}

type CommitDetailFile = {
  repoId?: string;
  repoName?: string;
  repoColor?: string;
  path: string;
  status: string;
  added?: number;
  removed?: number;
  hash?: string;
  fromHash?: string;
  toHash?: string;
};

type CommitSummary = {
  repoId: string;
  repoName: string;
  repoColor: string;
  hash: string;
  shortHash: string;
  message: string;
  fullMessage: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerDate: string;
  parents: string[];
  branches: { local: string[]; remote: string[]; tags: string[] };
  repoRootPath: string;
  vcsKind: 'git' | 'svn';
  files: CommitExplanationFile[];
};

type CommitSummaryView = Omit<CommitSummary, 'repoRootPath' | 'vcsKind' | 'files'>;

type CommitExplanationWebviewMessage =
  | { type: 'generateExplanation'; requestId: string }
  | { type: 'cancelExplanation'; requestId: string };

type CommitDetailRepo = {
  kind?: string;
  rootPath: string;
  repoId: string;
  resolveRepoPath(filePath: string): { absolutePath: string; relativePath: string };
  getFileDiff(repoId: string, hash: string, filePath: string): Promise<{ originalContent?: string; modifiedContent?: string } | null>;
  getRevisionFileContents?(hash: string, filePath: string, status?: string): Promise<{ originalContent: string; modifiedContent: string; isBinary?: boolean }>;
  getRevisionRangeFileContents?(fromHash: string | undefined, toHash: string, filePath: string): Promise<{ originalContent: string; modifiedContent: string; isBinary?: boolean }>;
};

type CommitDetailSelection = { repoId: string; hash: string };
type AggregatedCommitDetailOptions = { title?: string; message?: string };

const AGGREGATED_DETAIL_CONCURRENCY = 4;

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      results[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const singleCommitDetailPanels = new Map<string, vscode.WebviewPanel>();
const aggregatedCommitDetailPanels = new Map<string, vscode.WebviewPanel>();
const pendingSingleCommitDetails = new Map<string, Promise<void>>();
const pendingAggregatedCommitDetails = new Map<string, Promise<void>>();

function getLayoutDensity(): 'comfortable' | 'compact' {
  const raw = vscode.workspace.getConfiguration('versiondock').get<string>('layoutDensity', 'comfortable');
  return raw === 'compact' ? 'compact' : 'comfortable';
}

function singleCommitDetailKey(repoId: string, hash: string): string {
  return scopedKey(repoId, hash);
}

function formatShortRef(ref?: string): string {
  if (!ref) return '';
  const trimmed = ref.trim();
  if (/^r\d+$/i.test(trimmed)) return trimmed;
  return trimmed.slice(0, 7);
}

function aggregatedCommitDetailKey(commits: CommitDetailSelection[], context = 'selection'): string {
  const unique = new Map<string, CommitDetailSelection>();
  for (const commit of commits) {
    unique.set(singleCommitDetailKey(commit.repoId, commit.hash), commit);
  }
  return `${context}:${JSON.stringify(Array.from(unique.values()).sort((left, right) => (
    left.repoId.localeCompare(right.repoId) || left.hash.localeCompare(right.hash)
  )))}`;
}

export type SingleCommitInitialData = {
  initialCommit?: {
    message?: string;
    authorName?: string;
    authorEmail?: string;
    authorDate?: string;
    committerDate?: string;
    parents?: string[];
  };
  initialFiles?: Array<{ path: string; status: string; added?: number; removed?: number }>;
  initialMergeParentChanges?: MergeParentChange[];
};

export async function openCommitDetailPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  aiCommitExplanationService: AiCommitExplanationService,
  logger: VersionDockLogger,
  repoId: string,
  hash: string,
  autoExplain = false,
  initialData?: SingleCommitInitialData,
): Promise<void> {
  const panelKey = singleCommitDetailKey(repoId, hash);
  const existingPanel = singleCommitDetailPanels.get(panelKey);
  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const pending = pendingSingleCommitDetails.get(panelKey);
  if (pending) {
    await pending;
    singleCommitDetailPanels.get(panelKey)?.reveal(vscode.ViewColumn.One);
    return;
  }

  const opening = createCommitDetailPanel(
    extensionUri,
    manager,
    aiCommitExplanationService,
    logger,
    repoId,
    hash,
    autoExplain,
    initialData,
  );

  pendingSingleCommitDetails.set(panelKey, opening);
  try {
    await opening;
  } finally {
    if (pendingSingleCommitDetails.get(panelKey) === opening) {
      pendingSingleCommitDetails.delete(panelKey);
    }
  }
}

async function createCommitDetailPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  aiCommitExplanationService: AiCommitExplanationService,
  logger: VersionDockLogger,
  repoId: string,
  hash: string,
  autoExplain: boolean,
  initialData?: SingleCommitInitialData,
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    const repoName = manager.getRepoMeta(repoId)?.name ?? repoId;
    vscode.window.showErrorMessage(t('VersionDock [{0}]: Repository not found.', repoName));
    return;
  }

  let commitInfo: Awaited<ReturnType<typeof repo.getCommitMeta>> | null = null;
  let files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
  let mergeParentChanges: MergeParentChange[] = [];
  let fullMessage = '';
  let branches: { local: string[]; remote: string[]; tags: string[] } = { local: [], remote: [], tags: [] };

  if (initialData?.initialCommit) {
    fullMessage = initialData.initialCommit.message ?? '';
    commitInfo = {
      hash,
      shortHash: hash.replace(/^r/i, '').slice(0, 7) || hash,
      message: (initialData.initialCommit.message ?? '').split('\n')[0] || hash,
      authorName: initialData.initialCommit.authorName ?? t('Unknown'),
      authorEmail: initialData.initialCommit.authorEmail ?? '',
      authorDate: initialData.initialCommit.authorDate ?? '',
      committerDate: initialData.initialCommit.committerDate ?? '',
      parents: initialData.initialCommit.parents ?? [],
    };
  }

  if (initialData?.initialFiles !== undefined) {
    files = initialData.initialFiles;
  }
  if (initialData?.initialMergeParentChanges !== undefined) {
    mergeParentChanges = initialData.initialMergeParentChanges;
  }

  const needCommitInfo = !commitInfo;
  const needFiles = initialData?.initialFiles === undefined;

  try {
    if (!commitInfo) {
      const [msgResult, metaResult] = await Promise.all([
        repo.getFullCommitMessage(hash),
        repo.getCommitMeta(hash),
      ]);
      fullMessage = msgResult;
      commitInfo = metaResult ?? { hash, shortHash: hash.slice(0, 7), message: '', authorName: '', authorEmail: '', authorDate: '', committerDate: '', parents: [] };
    }
    const resolvedCommitInfo = commitInfo;

    const needMergeParentChanges = resolvedCommitInfo.parents.length >= 2 && mergeParentChanges.length === 0;
    const needBranches = branches.local.length === 0 && branches.remote.length === 0 && branches.tags.length === 0;

    if (needFiles || needBranches || needMergeParentChanges) {
      const [loadedFiles, loadedBranches, loadedMergeChanges] = await Promise.all([
        needFiles
          ? repo.getCommitFilesForLogDetail(hash, resolvedCommitInfo.parents)
          : Promise.resolve(files),
        needBranches
          ? repo.getBranchesContaining(hash).catch(() => ({ local: [], remote: [], tags: [] }))
          : Promise.resolve(branches),
        needMergeParentChanges
          ? repo.getMergeParentChanges(hash, resolvedCommitInfo.parents).catch(() => [])
          : Promise.resolve(mergeParentChanges),
      ]);
      if (needFiles) files = loadedFiles;
      if (needBranches) branches = loadedBranches;
      if (needMergeParentChanges) mergeParentChanges = loadedMergeChanges;
    }
  } catch (e: unknown) {
    const repoName = manager.getRepoMetas().find(r => r.id === repoId)?.name ?? repoId;
    vscode.window.showErrorMessage(t('VersionDock [{0}]: Failed to load commit details: {1}', repoName, String(e)));
    return;
  }

  if (!commitInfo) return;

  const repoMeta = manager.getRepoMetas().find(r => r.id === repoId);
  const repoName = repoMeta?.name ?? repoId;
  const repoColor = repoMeta?.color ?? '#4ec9b0';
  // Keep the main file tree aligned with the Git Log change list. Parent
  // change trees disable this grouping locally to avoid a nested repo root.
  const showRepoGrouping = manager.getRepoMetas().length > 1;

  const nonce = generateNonce();

  const panel = vscode.window.createWebviewPanel(
    'versiondockCommitDetail',
    t('Commit {0}', commitInfo.shortHash),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        extensionUri,
        vscode.Uri.file(vscode.env.appRoot),
        ...vscode.extensions.all.map(extension => vscode.Uri.file(extension.extensionPath)),
      ],
    }
  );
  panel.iconPath = new vscode.ThemeIcon('git-commit');
  const panelKey = singleCommitDetailKey(repoId, hash);
  singleCommitDetailPanels.set(panelKey, panel);
  const configListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('versiondock.layoutDensity')) {
      panel.webview.postMessage({
        type: 'LAYOUT_DENSITY_UPDATE',
        layoutDensity: getLayoutDensity(),
      });
    }
  });
  panel.onDidDispose(() => {
    configListener.dispose();
    if (singleCommitDetailPanels.get(panelKey) === panel) {
      singleCommitDetailPanels.delete(panelKey);
    }
  });
  const [iconTheme, i18n] = await Promise.all([
    loadIconTheme(panel.webview),
    Promise.resolve(getWebviewI18nPayload()),
  ]);

  const codiconUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
  ).toString();

  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${panel.webview.cspSource}`,
    `img-src ${panel.webview.cspSource} data: https:`,
  ].join('; ');

  const explanationCommits: CommitExplanationCommit[] = [{
    repoId,
    repoName,
    repoRootPath: repoMeta?.rootPath ?? repo.rootPath,
    vcsKind: repo.kind === 'svn' ? 'svn' : 'git',
    hash,
    shortHash: commitInfo.shortHash,
    fullMessage: fullMessage.trim() || commitInfo.message,
    authorName: commitInfo.authorName,
    authorDate: commitInfo.authorDate,
    files,
  }];
  registerCommitExplanationHandlers(
    panel,
    manager,
    aiCommitExplanationService,
    logger,
    'single',
    explanationCommits,
  );

  let authorAvatarUrl: string | null = null;
  let remotes: string[] = [];
  try {
    const withUrls = await repo.getRemotesWithUrls().catch(() => []);
    remotes = withUrls.flatMap(r => [r.fetchUrl, r.pushUrl]).filter(Boolean);
  } catch {
    // Ignore
  }
  const connectedAccounts = await manager.remoteService?.getConnectedAccounts().catch(() => []) ?? [];
  const matchedAvatar = findConnectedAvatar(commitInfo.authorName, commitInfo.authorEmail, connectedAccounts, remotes[0]);
  if (matchedAvatar) {
    authorAvatarUrl = matchedAvatar;
  } else if (manager.remoteService?.avatarService && commitInfo.authorEmail) {
    const avatarMap = manager.remoteService.avatarService.getCachedAvatars([commitInfo.authorEmail], remotes);
    authorAvatarUrl = avatarMap[commitInfo.authorEmail.trim().toLowerCase()] ?? null;
  }

  panel.webview.html = getHtml(nonce, csp, codiconUri, {
    repoName, repoId, hash,
    repoColor,
    repoKind: repo.kind,
    showRepoGrouping,
    layoutDensity: getLayoutDensity(),
    mode: 'single',
    autoExplain,
    i18n,
    iconTheme,
    shortHash: commitInfo.shortHash,
    message: commitInfo.message,
    fullMessage: fullMessage.trim(),
    authorName: commitInfo.authorName,
    authorEmail: commitInfo.authorEmail,
    authorAvatarUrl,
    authorDate: commitInfo.authorDate,
    committerDate: commitInfo.committerDate,
    parents: commitInfo.parents,
    files: files.map(file => ({
      ...file,
      repoId,
      repoName,
      repoColor,
      hash,
    })),
    mergeParentChanges,
    branches,
  });

  panel.webview.onDidReceiveMessage(async (msg: { type: string; filePath?: string; fileStatus?: string; repoId?: string; hash?: string; fromHash?: string; toHash?: string; parentHash?: string; requestId?: string; emails?: string[]; authors?: Array<{ name?: string; email: string }> }) => {
    if (msg.type === 'resolveAvatars' && Array.isArray(msg.emails)) {
      const remoteService = manager.remoteService;
      if (remoteService) {
        const authorsMap: Record<string, string> = {};
        if (Array.isArray(msg.authors)) {
          for (const a of msg.authors) {
            if (a.name && a.email) {
              authorsMap[a.email.trim().toLowerCase()] = a.name.trim();
            }
          }
        }
        const avatars = await remoteService.avatarService.resolveAvatars(msg.emails, remotes, authorsMap).catch(() => ({}));
        panel.webview.postMessage({ type: 'avatarsResolved', avatars });
      }
      return;
    }
    if (msg.type === 'getMergeParentFiles' && msg.hash && msg.parentHash && msg.requestId) {
      try {
        const parentFiles = await repo.getMergeParentFiles(msg.hash, msg.parentHash);
        panel.webview.postMessage({ type: 'mergeParentFilesResult', requestId: msg.requestId, files: parentFiles });
      } catch {
        panel.webview.postMessage({ type: 'mergeParentFilesResult', requestId: msg.requestId, files: [] });
      }
      return;
    }
    if (msg.type === 'openDiff' && msg.filePath) {
      try {
        const pathMod = await import('path');
        const status = msg.fileStatus ?? 'M';
        const diffHash = msg.hash ?? hash; // support merge commit files
        const fileName = pathMod.basename(msg.filePath);
        const title = msg.fromHash && msg.toHash
          ? t('{0} ({1}..{2})', fileName, formatShortRef(msg.fromHash), formatShortRef(msg.toHash))
          : status === 'A'
            ? t('{0} (added in {1})', fileName, formatShortRef(diffHash))
            : status === 'D'
              ? t('{0} (deleted in {1})', fileName, formatShortRef(diffHash))
              : t('{0} ({1})', fileName, formatShortRef(diffHash));
        if (msg.fromHash && msg.toHash) {
          await openCommitRangeFileDiff(repo, msg.fromHash, msg.toHash, msg.filePath, status, title, repoName);
        } else {
          await openCommitFileDiff(repo, diffHash, msg.filePath, status, title, repoName);
        }
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open diff: {1}', repoName, String(e)));
      }
    } else if (msg.type === 'openFile' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(repo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('vscode.open', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open file: {1}', repoName, String(e)));
      }
    } else if (msg.type === 'revealInExplorer' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(repo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('revealInExplorer', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open file: {1}', repoName, String(e)));
      }
    } else if (msg.type === 'revealInOS' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(repo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('revealFileInOS', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open file: {1}', repoName, String(e)));
      }
    } else if (msg.type === 'revertFile' && msg.filePath) {
      if (repo.kind === 'svn') {
        vscode.window.showWarningMessage(t('VersionDock [{0}]: Revert Selected Changes is not supported for SVN commit detail.', repoName));
        return;
      }
      try {
        const resolvedPath = repo.resolveRepoPath(msg.filePath);
        const confirmed = await vscode.window.showWarningMessage(
          t('VersionDock [{0}]: Revert changes to "{1}" from commit {2}?', repoName, resolvedPath.relativePath, commitInfo!.shortHash),
          { modal: true }, t('Revert')
        );
        if (confirmed !== t('Revert')) return;
        if (msg.fileStatus === 'A') {
          assertNoSymlinkAncestors(repo.rootPath, resolvedPath.absolutePath);
          await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { useTrash: false });
        } else {
          await repo.revertFileToParent(hash, resolvedPath.relativePath);
        }
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Reverted "{1}".', repoName, resolvedPath.relativePath));
        panel.webview.postMessage({ type: 'revertDone', filePath: resolvedPath.relativePath });
        manager.notifyDataInvalidated({
          scopes: ['workingTree'],
          repoIds: [repo.repoId],
        });
      } catch (e: unknown) {
        void showGitErrorMessage(t('VersionDock [{0}]: Revert failed: {1}', repoName, String(e)), {
          repoName,
          onUnlocked: async () => {
            await manager.getAllStatusesFresh();
          },
        });
      }
    }
  });
}

export type AggregatedCommitInput = {
  repoId: string;
  hash: string;
  message?: string;
  authorName?: string;
  authorEmail?: string;
  authorDate?: string;
  committerDate?: string;
  parents?: string[];
  files?: Array<{ path: string; status: string; added?: number; removed?: number }>;
};

export async function openAggregatedCommitDetailPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  aiCommitExplanationService: AiCommitExplanationService,
  logger: VersionDockLogger,
  commits: AggregatedCommitInput[],
  autoExplain = false,
  options: AggregatedCommitDetailOptions = {},
): Promise<void> {
  const panelKey = aggregatedCommitDetailKey(commits, options.title ?? 'selection');
  const existingPanel = aggregatedCommitDetailPanels.get(panelKey);
  if (existingPanel) {
    existingPanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const pending = pendingAggregatedCommitDetails.get(panelKey);
  if (pending) {
    await pending;
    aggregatedCommitDetailPanels.get(panelKey)?.reveal(vscode.ViewColumn.One);
    return;
  }

  const opening = createAggregatedCommitDetailPanel(
    extensionUri,
    manager,
    aiCommitExplanationService,
    logger,
    commits,
    autoExplain,
    options,
  );

  pendingAggregatedCommitDetails.set(panelKey, opening);
  try {
    await opening;
  } finally {
    if (pendingAggregatedCommitDetails.get(panelKey) === opening) {
      pendingAggregatedCommitDetails.delete(panelKey);
    }
  }
}

async function createAggregatedCommitDetailPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  aiCommitExplanationService: AiCommitExplanationService,
  logger: VersionDockLogger,
  commits: AggregatedCommitInput[],
  autoExplain: boolean,
  options: AggregatedCommitDetailOptions,
): Promise<void> {
  if (commits.length === 0) return;

  const repoMetas = manager.getRepoMetas();
  const repoMetaById = new Map(repoMetas.map(repo => [repo.id, repo]));
  const commitSummaries: CommitSummary[] = [];
  const fileEntries: CommitDetailFile[] = [];

  try {
    const details = await mapWithConcurrency(commits, AGGREGATED_DETAIL_CONCURRENCY, async selection => {
      const repo = manager.getRepo(selection.repoId);
      if (!repo) return undefined;
      const repoMeta = repoMetaById.get(selection.repoId);
      const repoName = repoMeta?.name ?? selection.repoId;
      const repoColor = repoMeta?.color ?? '#4ec9b0';

      let commitInfo: { hash: string; shortHash: string; message: string; authorName: string; authorEmail: string; authorDate: string; committerDate: string; parents: string[] };
      let fullMessage: string;
      let files: Array<{ path: string; status: string; added?: number; removed?: number }>;
      let branches: { local: string[]; remote: string[]; tags: string[] } = { local: [], remote: [], tags: [] };

      if (selection.files !== undefined && selection.message !== undefined && selection.authorName !== undefined) {
        fullMessage = selection.message;
        commitInfo = {
          hash: selection.hash,
          shortHash: selection.hash.replace(/^r/i, '').slice(0, 7) || selection.hash,
          message: selection.message.split('\n')[0] || selection.hash,
          authorName: selection.authorName,
          authorEmail: selection.authorEmail ?? '',
          authorDate: selection.authorDate ?? '',
          committerDate: selection.committerDate ?? '',
          parents: selection.parents ?? [],
        };
        files = selection.files;
      } else {
        const [metaData, branchesResult] = await Promise.all([
          Promise.all([
            selection.authorName !== undefined
              ? Promise.resolve({
                  hash: selection.hash,
                  shortHash: selection.hash.replace(/^r/i, '').slice(0, 7) || selection.hash,
                  message: (selection.message ?? '').split('\n')[0] || selection.hash,
                  authorName: selection.authorName,
                  authorEmail: selection.authorEmail ?? '',
                  authorDate: selection.authorDate ?? '',
                  committerDate: selection.committerDate ?? '',
                  parents: selection.parents ?? [],
                })
              : repo.getCommitMeta(selection.hash),
            selection.message !== undefined
              ? Promise.resolve(selection.message)
              : repo.getFullCommitMessage(selection.hash),
          ]),
          repo.getBranchesContaining(selection.hash).catch(() => ({ local: [], remote: [], tags: [] })),
        ]);
        commitInfo = metaData[0];
        fullMessage = metaData[1];
        branches = branchesResult;
        files = selection.files !== undefined
          ? selection.files
          : await repo.getCommitFilesForLogDetail(selection.hash, commitInfo.parents);
      }

      const summary: CommitSummary = {
        repoId: selection.repoId,
        repoName,
        repoColor,
        repoRootPath: repoMeta?.rootPath ?? repo.rootPath,
        vcsKind: repo.kind === 'svn' ? 'svn' : 'git',
        hash: commitInfo.hash,
        shortHash: commitInfo.shortHash,
        message: commitInfo.message,
        fullMessage: fullMessage.trim() || commitInfo.message,
        authorName: commitInfo.authorName,
        authorEmail: commitInfo.authorEmail,
        authorDate: commitInfo.authorDate,
        committerDate: commitInfo.committerDate,
        parents: commitInfo.parents,
        branches,
        files,
      };
      const entries = files.map(file => ({
        ...file,
        repoId: selection.repoId,
        repoName,
        repoColor,
        hash: selection.hash,
      }));
      return { summary, entries };
    });
    for (const detail of details) {
      if (!detail) continue;
      commitSummaries.push(detail.summary);
      fileEntries.push(...detail.entries);
    }
  } catch (e: unknown) {
    const singleRepoId = commits.every(s => s.repoId === commits[0]?.repoId) ? commits[0]?.repoId : undefined;
    const singleRepoName = singleRepoId ? (manager.getRepoMeta(singleRepoId)?.name ?? singleRepoId) : undefined;
    vscode.window.showErrorMessage(
      singleRepoName
        ? t('VersionDock [{0}]: Failed to load commit details: {1}', singleRepoName, String(e))
        : t('VersionDock: Failed to load commit details: {0}', String(e))
    );
    return;
  }

  if (commitSummaries.length === 0) {
    const singleRepoId = commits.every(s => s.repoId === commits[0]?.repoId) ? commits[0]?.repoId : undefined;
    const singleRepoName = singleRepoId ? (manager.getRepoMeta(singleRepoId)?.name ?? singleRepoId) : undefined;
    vscode.window.showErrorMessage(
      singleRepoName
        ? t('VersionDock [{0}]: Repository not found.', singleRepoName)
        : t('VersionDock: Repository not found.')
    );
    return;
  }

  const rangeByRepo = new Map<string, { fromHash?: string; toHash: string }>();
  for (const repoId of Array.from(new Set(commitSummaries.map(commit => commit.repoId)))) {
    const repoCommits = commitSummaries.filter(commit => commit.repoId === repoId);
    const newest = repoCommits[0];
    const oldest = repoCommits[repoCommits.length - 1];
    if (newest && oldest) {
      rangeByRepo.set(repoId, { fromHash: oldest.parents[0], toHash: newest.hash });
    }
  }

  const aggregatedMap = new Map<string, CommitDetailFile>();
  for (const file of [...fileEntries].reverse()) {
    const key = scopedKey(file.repoId ?? '', file.path);
    const existing = aggregatedMap.get(key);
    const range = file.repoId ? rangeByRepo.get(file.repoId) : undefined;
    if (!existing) {
      aggregatedMap.set(key, {
        ...file,
        fromHash: range?.fromHash,
        toHash: range?.toHash,
      });
      continue;
    }
    aggregatedMap.set(key, {
      ...file,
      fromHash: range?.fromHash,
      toHash: range?.toHash,
      added: (file.added ?? 0) + (existing.added ?? 0) || undefined,
      removed: (file.removed ?? 0) + (existing.removed ?? 0) || undefined,
    });
  }

  const involvedRepoIds = Array.from(new Set(commitSummaries.map(commit => commit.repoId)));
  const selectedTimeRange = commitSummaries.length > 0
    ? `${commitSummaries[commitSummaries.length - 1].authorDate} - ${commitSummaries[0].authorDate}`
    : '';
  const nonce = generateNonce();
  const panel = vscode.window.createWebviewPanel(
    'versiondockCommitDetail',
    options.title ?? t('Aggregated commit selection'),
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        extensionUri,
        vscode.Uri.file(vscode.env.appRoot),
        ...vscode.extensions.all.map(extension => vscode.Uri.file(extension.extensionPath)),
      ],
    }
  );
  panel.iconPath = new vscode.ThemeIcon('git-commit');
  const panelKey = aggregatedCommitDetailKey(commits, options.title ?? 'selection');
  aggregatedCommitDetailPanels.set(panelKey, panel);
  const configListener = vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('versiondock.layoutDensity')) {
      panel.webview.postMessage({
        type: 'LAYOUT_DENSITY_UPDATE',
        layoutDensity: getLayoutDensity(),
      });
    }
  });
  panel.onDidDispose(() => {
    configListener.dispose();
    if (aggregatedCommitDetailPanels.get(panelKey) === panel) {
      aggregatedCommitDetailPanels.delete(panelKey);
    }
  });
  const [iconTheme, i18n] = await Promise.all([
    loadIconTheme(panel.webview),
    Promise.resolve(getWebviewI18nPayload()),
  ]);
  const codiconUri = panel.webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
  ).toString();
  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${panel.webview.cspSource}`,
    `img-src ${panel.webview.cspSource} data: https:`,
  ].join('; ');

  const firstCommit = commitSummaries[0];
  registerCommitExplanationHandlers(
    panel,
    manager,
    aiCommitExplanationService,
    logger,
    'aggregate',
    commitSummaries,
  );

  const allEmails = Array.from(new Set(commitSummaries.map(c => c.authorEmail).filter(Boolean)));
  const allRemotes: string[] = [];
  for (const rId of involvedRepoIds) {
    const r = manager.getRepo(rId);
    if (r) {
      try {
        const withUrls = await r.getRemotesWithUrls().catch(() => []);
        allRemotes.push(...withUrls.flatMap(x => [x.fetchUrl, x.pushUrl]).filter(Boolean));
      } catch {
        // Ignore
      }
    }
  }
  const connectedAccounts = await manager.remoteService?.getConnectedAccounts().catch(() => []) ?? [];
  let avatarUrlsByEmail: Record<string, string | null> = {};

  for (const c of commitSummaries) {
    const matched = findConnectedAvatar(c.authorName, c.authorEmail, connectedAccounts, allRemotes[0]);
    if (matched) {
      avatarUrlsByEmail[c.authorEmail.trim().toLowerCase()] = matched;
    }
  }

  if (manager.remoteService?.avatarService && allEmails.length > 0) {
    const remoteAvatars = manager.remoteService.avatarService.getCachedAvatars(allEmails, allRemotes);
    avatarUrlsByEmail = { ...remoteAvatars, ...avatarUrlsByEmail };
  }

  panel.webview.html = getHtml(nonce, csp, codiconUri, {
    repoName: involvedRepoIds.length === 1 ? firstCommit.repoName : t('{0} repositories involved', involvedRepoIds.length),
    repoId: firstCommit.repoId,
    hash: commits.map(commit => commit.hash).join(','),
    repoColor: firstCommit.repoColor,
    repoKind: 'git',
    showRepoGrouping: repoMetas.length > 1 || involvedRepoIds.length > 1,
    layoutDensity: getLayoutDensity(),
    mode: 'aggregate',
    autoExplain,
    i18n,
    iconTheme,
    shortHash: commitSummaries.length === 1 ? t('{0} commit selected', commitSummaries.length) : t('{0} commits selected', commitSummaries.length),
    message: options.message ?? t('Aggregated commit selection'),
    fullMessage: commitSummaries.map(commit => commit.fullMessage || commit.message).join('\n\n'),
    authorName: options.message ?? t('Aggregated commit selection'),
    authorEmail: '',
    authorAvatarUrl: null,
    avatarUrlsByEmail,
    authorDate: firstCommit.authorDate,
    committerDate: firstCommit.committerDate,
    parents: [],
    files: Array.from(aggregatedMap.values()),
    mergeParentChanges: [],
    branches: { local: [], remote: [], tags: [] },
    commits: commitSummaries.map(({ repoRootPath: _repoRootPath, vcsKind: _vcsKind, files: _files, ...commit }) => commit),
    selectedTimeRange,
    involvedRepoCount: involvedRepoIds.length,
  });

  panel.webview.onDidReceiveMessage(async (msg: { type: string; filePath?: string; fileStatus?: string; repoId?: string; hash?: string; fromHash?: string; toHash?: string; emails?: string[]; authors?: Array<{ name?: string; email: string }> }) => {
    if (msg.type === 'resolveAvatars' && Array.isArray(msg.emails)) {
      const remoteService = manager.remoteService;
      if (remoteService) {
        const authorsMap: Record<string, string> = {};
        if (Array.isArray(msg.authors)) {
          for (const a of msg.authors) {
            if (a.name && a.email) {
              authorsMap[a.email.trim().toLowerCase()] = a.name.trim();
            }
          }
        }
        const avatars = await remoteService.avatarService.resolveAvatars(msg.emails, allRemotes, authorsMap).catch(() => ({}));
        panel.webview.postMessage({ type: 'avatarsResolved', avatars });
      }
      return;
    }
    const targetRepoId = msg.repoId ?? firstCommit.repoId;
    const targetRepo = manager.getRepo(targetRepoId);
    if (!targetRepo) return;
    const targetRepoName = manager.getRepoMeta(targetRepoId)?.name || targetRepoId;
    if (msg.type === 'openDiff' && msg.filePath) {
      try {
        const pathMod = await import('path');
        const fileName = pathMod.basename(msg.filePath);
        const title = msg.fromHash && msg.toHash
          ? t('{0} ({1}..{2})', fileName, formatShortRef(msg.fromHash), formatShortRef(msg.toHash))
          : t('{0} ({1})', fileName, formatShortRef(msg.hash ?? firstCommit.hash));
        if (msg.fromHash && msg.toHash) {
          await openCommitRangeFileDiff(targetRepo, msg.fromHash, msg.toHash, msg.filePath, msg.fileStatus ?? 'M', title, targetRepoName);
        } else {
          await openCommitFileDiff(targetRepo, msg.hash ?? firstCommit.hash, msg.filePath, msg.fileStatus ?? 'M', title, targetRepoName);
        }
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open diff: {1}', targetRepoName, String(e)));
      }
    } else if (msg.type === 'openFile' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(targetRepo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('vscode.open', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open file: {1}', targetRepoName, String(e)));
      }
    } else if (msg.type === 'revealInExplorer' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(targetRepo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('revealInExplorer', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open file: {1}', targetRepoName, String(e)));
      }
    } else if (msg.type === 'revealInOS' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(targetRepo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('revealFileInOS', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: Cannot open file: {1}', targetRepoName, String(e)));
      }
    }
  });
}

function registerCommitExplanationHandlers(
  panel: vscode.WebviewPanel,
  manager: WorkspaceGitManager,
  service: AiCommitExplanationService,
  logger: VersionDockLogger,
  mode: 'single' | 'aggregate',
  commits: CommitExplanationCommit[],
): void {
  let activeGeneration: { requestId: string; cancellation: vscode.CancellationTokenSource } | undefined;

  const cancelActive = (requestId?: string): void => {
    if (!activeGeneration || (requestId && activeGeneration.requestId !== requestId)) return;
    activeGeneration.cancellation.cancel();
  };

  panel.onDidDispose(() => {
    cancelActive();
    activeGeneration?.cancellation.dispose();
    activeGeneration = undefined;
  });

  panel.webview.onDidReceiveMessage(async (msg: CommitExplanationWebviewMessage) => {
    if (msg.type === 'cancelExplanation') {
      cancelActive(msg.requestId);
      return;
    }
    if (msg.type !== 'generateExplanation') return;

    cancelActive();
    activeGeneration?.cancellation.dispose();
    const cancellation = new vscode.CancellationTokenSource();
    const generation = { requestId: msg.requestId, cancellation };
    activeGeneration = generation;
    const provider = service.getProvider();
    const startedAt = Date.now();

    const postIfActive = (message: Record<string, unknown>): void => {
      if (activeGeneration !== generation || cancellation.token.isCancellationRequested) return;
      void panel.webview.postMessage({ ...message, requestId: msg.requestId });
    };

    logger.info('AICommitExplanation', 'Generation started', {
      requestId: msg.requestId,
      provider,
      mode,
      commitCount: commits.length,
      repositoryCount: new Set(commits.map(commit => commit.repoId)).size,
    });

    try {
      postIfActive({ type: 'aiExplanationStatus', phase: 'reading' });
      await Promise.resolve();
      postIfActive({ type: 'aiExplanationStatus', phase: 'analyzing' });
      const maxInputTokens = await service.getMaxInputTokens();
      if (cancellation.token.isCancellationRequested) throw new Error('Cancelled');
      const context = await buildCommitExplanationContext(manager, mode, commits, maxInputTokens, cancellation.token);
      postIfActive({
        type: 'aiExplanationStatus',
        phase: 'thinking',
        contextTruncated: context.truncated,
        fileCount: context.fileCount,
      });

      let streamedText = '';
      const result = await service.generate({
        context,
        cancellationToken: cancellation.token,
        onDelta: delta => {
          if (!delta) return;
          streamedText += delta;
          postIfActive({ type: 'aiExplanationDelta', delta });
        },
      });
      if (activeGeneration !== generation || cancellation.token.isCancellationRequested) throw new Error('Cancelled');

      postIfActive({
        type: 'aiExplanationResult',
        explanation: result.explanation,
        provider: result.provider,
        model: result.model,
        promptSource: result.promptSource,
        durationMs: result.durationMs,
        contextTruncated: context.truncated,
        inputTruncated: result.inputTruncated,
        streamed: result.streamed,
        streamedCharCount: streamedText.length,
      });
      logger.info('AICommitExplanation', 'Generation completed', {
        requestId: msg.requestId,
        provider: result.provider,
        model: result.model,
        mode,
        promptSource: result.promptSource,
        commitCount: context.commitCount,
        repositoryCount: context.repositoryCount,
        fileCount: context.fileCount,
        contextCharCount: context.contextCharCount,
        contextTruncated: context.truncated,
        inputTruncated: result.inputTruncated,
        maxOutputTokens: result.maxOutputTokens,
        streamChunkCount: result.streamChunkCount,
        firstTokenLatencyMs: result.firstTokenLatencyMs,
        durationMs: result.durationMs,
      });
    } catch (error: unknown) {
      const cancelled = cancellation.token.isCancellationRequested
        || (error instanceof Error && error.message === 'Cancelled');
      if (activeGeneration === generation) {
        void panel.webview.postMessage({
          type: cancelled ? 'aiExplanationCancelled' : 'aiExplanationResult',
          requestId: msg.requestId,
          ...(cancelled ? {} : { error: error instanceof Error ? error.message : String(error) }),
        });
      }
      if (cancelled) {
        logger.info('AICommitExplanation', 'Generation cancelled', {
          requestId: msg.requestId,
          provider,
          mode,
          durationMs: Date.now() - startedAt,
        });
      } else {
        logger.error('AICommitExplanation', 'Generation failed', error, {
          requestId: msg.requestId,
          provider,
          mode,
          durationMs: Date.now() - startedAt,
        });
      }
    } finally {
      if (activeGeneration === generation) activeGeneration = undefined;
      cancellation.dispose();
    }
  });
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function guessLanguageId(filePath: string): string | undefined {
  const ext = filePath.includes('.') ? filePath.split('.').pop()!.toLowerCase() : '';
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    json: 'json',
    jsonc: 'jsonc',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    java: 'java',
    kt: 'kotlin',
    go: 'go',
    rs: 'rust',
    py: 'python',
    php: 'php',
    vue: 'vue',
    css: 'css',
    scss: 'scss',
    html: 'html',
    xml: 'xml',
    sh: 'shellscript',
    bash: 'shellscript',
    zsh: 'shellscript',
    sql: 'sql',
    tf: 'terraform',
    hcl: 'terraform',
  };
  return map[ext];
}

async function openSvnDiffWithProvider(
  repoId: string,
  fromRef: string,
  toRef: string,
  relativePath: string,
  originalContent: string,
  modifiedContent: string,
  title: string,
): Promise<void> {
  const provider = ShelveDocumentProvider.shared;
  if (provider) {
    const leftUri = ShelveDocumentProvider.buildUri(repoId, `svn-${fromRef}`, relativePath);
    const rightUri = ShelveDocumentProvider.buildUri(repoId, `svn-${toRef}`, relativePath);
    provider.set(leftUri, originalContent);
    provider.set(rightUri, modifiedContent);

    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    const isAlreadyActiveDiff = activeTab?.input instanceof vscode.TabInputTextDiff
      && activeTab.input.original.toString() === leftUri.toString()
      && activeTab.input.modified.toString() === rightUri.toString();

    if (!isAlreadyActiveDiff) {
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title, { preview: true });
    }
    return;
  }

  const language = guessLanguageId(relativePath);
  const [leftDoc, rightDoc] = await Promise.all([
    vscode.workspace.openTextDocument({ language, content: originalContent }),
    vscode.workspace.openTextDocument({ language, content: modifiedContent }),
  ]);
  await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, title, { preview: true });
}

async function openCommitFileDiff(
  repo: CommitDetailRepo,
  diffHash: string,
  filePath: string,
  status: string,
  title: string,
  repoName?: string,
): Promise<void> {
  const resolvedPath = repo.resolveRepoPath(filePath);
  const relativePath = resolvedPath.relativePath;
  const displayRepoName = repoName || repo.repoId;
  if (repo.kind === 'svn') {
    let originalContent = '';
    let modifiedContent = '';
    if (typeof repo.getRevisionFileContents === 'function') {
      const contents = await repo.getRevisionFileContents(diffHash, relativePath, status);
      if (contents.isBinary) {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Binary file — no diff available', displayRepoName));
        return;
      }
      originalContent = contents.originalContent;
      modifiedContent = contents.modifiedContent;
    } else {
      const diff = await repo.getFileDiff(repo.repoId, diffHash, relativePath);
      if (!diff) {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN diff available for {1}.', displayRepoName, relativePath));
        return;
      }
      originalContent = diff.originalContent ?? '';
      modifiedContent = diff.modifiedContent ?? '';
    }
    const normalizedStatus = (status ?? '').toUpperCase();
    if (!originalContent && !modifiedContent && normalizedStatus !== 'A' && normalizedStatus !== 'D') {
      vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN diff available for {1}.', displayRepoName, relativePath));
      return;
    }
    await openSvnDiffWithProvider(repo.repoId, 'base', diffHash, relativePath, originalContent, modifiedContent, title);
    return;
  }

  const gitUri = (ref: string) => toGitUri(resolvedPath.absolutePath, ref);
  const normalizedStatus = status.replace(/\d+$/, '') || status;
  const leftRef = normalizedStatus === 'A' ? EMPTY_TREE : `${diffHash}~1`;
  const rightRef = normalizedStatus === 'D' ? EMPTY_TREE : diffHash;
  await vscode.commands.executeCommand('vscode.diff', gitUri(leftRef), gitUri(rightRef), title, { preview: true });
}

async function openCommitRangeFileDiff(
  repo: CommitDetailRepo,
  fromHash: string,
  toHash: string,
  filePath: string,
  status: string,
  title: string,
  repoName?: string,
): Promise<void> {
  const displayRepoName = repoName || repo.repoId;
  if (repo.kind === 'svn') {
    const resolvedPath = repo.resolveRepoPath(filePath);
    const relativePath = resolvedPath.relativePath;
    let originalContent = '';
    let modifiedContent = '';
    if (typeof repo.getRevisionRangeFileContents === 'function') {
      const contents = await repo.getRevisionRangeFileContents(fromHash, toHash, relativePath);
      if (contents.isBinary) {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: Binary file — no diff available', displayRepoName));
        return;
      }
      originalContent = contents.originalContent;
      modifiedContent = contents.modifiedContent;
    } else {
      const diff = await repo.getFileDiff(repo.repoId, toHash, relativePath);
      if (!diff) {
        vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN diff available for {1}.', displayRepoName, relativePath));
        return;
      }
      originalContent = diff.originalContent ?? '';
      modifiedContent = diff.modifiedContent ?? '';
    }
    const normalizedStatus = (status ?? '').toUpperCase();
    if (!originalContent && !modifiedContent && normalizedStatus !== 'A' && normalizedStatus !== 'D') {
      vscode.window.showInformationMessage(t('VersionDock [{0}]: No SVN diff available for {1}.', displayRepoName, relativePath));
      return;
    }
    await openSvnDiffWithProvider(repo.repoId, fromHash, toHash, relativePath, originalContent, modifiedContent, title);
    return;
  }

  const resolvedPath = repo.resolveRepoPath(filePath);
  const gitUri = (ref: string) => toGitUri(resolvedPath.absolutePath, ref);
  const normalizedStatus = status.replace(/\d+$/, '') || status;
  const leftRef = normalizedStatus === 'A' ? EMPTY_TREE : fromHash;
  const rightRef = normalizedStatus === 'D' ? EMPTY_TREE : toHash;
  await vscode.commands.executeCommand('vscode.diff', gitUri(leftRef), gitUri(rightRef), title, { preview: true });
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escJson(v: unknown): string {
  return JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

interface PanelData {
  mode: 'single' | 'aggregate';
  autoExplain: boolean;
  repoName: string;
  repoId: string;
  repoColor: string;
  repoKind: string;
  showRepoGrouping: boolean;
  layoutDensity: 'comfortable' | 'compact';
  i18n: WebviewI18nPayload;
  iconTheme: IconThemeData;
  hash: string;
  shortHash: string;
  message: string;
  fullMessage: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerDate: string;
  parents: string[];
  files: CommitDetailFile[];
  mergeParentChanges?: MergeParentChange[];
  branches: { local: string[]; remote: string[]; tags: string[]; isHead?: boolean };
  commits?: CommitSummaryView[];
  selectedTimeRange?: string;
  involvedRepoCount?: number;
  authorAvatarUrl?: string | null;
  avatarUrlsByEmail?: Record<string, string | null>;
}

function splitCommitMessage(fullMessage: string, fallbackSubject: string): { subject: string; body: string } {
  if (!fullMessage) return { subject: fallbackSubject, body: '' };
  const lines = fullMessage.replace(/\r\n/g, '\n').split('\n');
  const subject = lines[0]?.trim() || fallbackSubject;
  let bodyStart = 1;
  while (bodyStart < lines.length && lines[bodyStart].trim() === '') bodyStart += 1;
  return { subject, body: lines.slice(bodyStart).join('\n').trimEnd() };
}

function getAuthorInitials(authorName: string): string {
  const parts = authorName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) {
    const word = parts[0] ?? '';
    return (word.length > 1 ? word[0] + word[1] : word[0] ?? '?').toUpperCase();
  }
  return `${parts[0]?.[0] ?? ''}${parts[parts.length - 1]?.[0] ?? ''}`.toUpperCase();
}

function getAvatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
  return `hsl(${Math.abs(h) % 360}, 55%, 45%)`;
}

function getHtml(nonce: string, csp: string, codiconUri: string, data: PanelData): string {
  // remote entries come in as "origin/feat" — split into remote + name
  const allBranches = [
    ...(data.branches.isHead ? [{ type: 'head' as const, name: 'HEAD', remote: '' }] : []),
    ...data.branches.local.map(b => ({ type: 'local' as const,  name: b, remote: '' })),
    ...data.branches.remote.map(b => {
      const slash = b.indexOf('/');
      return slash >= 0
        ? { type: 'remote' as const, name: b.slice(slash + 1), remote: b.slice(0, slash) }
        : { type: 'remote' as const, name: b, remote: '' };
    }),
    ...data.branches.tags.map(b => ({ type: 'tag' as const, name: b, remote: '' })),
  ];

  const authorInitials = getAuthorInitials(data.authorName);
  const authorAvatarSeed = data.authorEmail.trim() || data.authorName.trim();
  const authorBg = data.authorAvatarUrl ? 'none' : getAvatarColor(authorAvatarSeed);
  const fullMsgDisplay = data.fullMessage || data.message;
  const canRevert = data.mode !== 'aggregate' && data.repoKind !== 'svn';
  const aggregateRangeStart = data.commits?.[data.commits.length - 1]?.authorDate ?? '';
  const aggregateRangeEnd = data.commits?.[0]?.authorDate ?? '';
  const leftPanelContent = data.mode === 'aggregate' ? `
      <div>
        <div class="section-label">${escHtml(t('Details'))}</div>
        <div class="meta-grid">
          <span class="meta-key">${escHtml(data.message)}</span>
          <span class="meta-val normal">${escHtml(data.commits?.length === 1 ? t('{0} commit selected', data.commits.length) : t('{0} commits selected', data.commits?.length ?? 0))}</span>
          <span class="meta-key">${escHtml(t('Repository'))}</span>
          <span class="meta-val normal">${escHtml(t('{0} repositories involved', data.involvedRepoCount ?? 0))}</span>
          <span class="meta-key">${escHtml(t('Selected time range'))}</span>
          <span class="meta-val normal" id="selectedTimeRange" data-range-start="${escHtml(aggregateRangeStart)}" data-range-end="${escHtml(aggregateRangeEnd)}">${escHtml(data.selectedTimeRange ?? '')}</span>
        </div>
      </div>
      <div>
        <div class="section-label">${escHtml(data.message)}</div>
        <div class="commit-summary-list">
          ${(data.commits ?? []).map((commit, index, allCommits) => {
            const commitMessage = splitCommitMessage(commit.fullMessage, commit.message);
            const initials = getAuthorInitials(commit.authorName);
            const commitAvatarUrl = data.avatarUrlsByEmail?.[commit.authorEmail.trim().toLowerCase()];
            const commitAvatarSeed = commit.authorEmail.trim() || commit.authorName.trim();
            const commitBg = commitAvatarUrl ? 'none' : getAvatarColor(commitAvatarSeed);
            return `
            <div class="commit-summary-item${index === allCommits.length - 1 ? ' last' : ''}">
              <div class="commit-summary-repo" style="--versiondock-project-color:${escHtml(commit.repoColor)}">
                <span class="codicon codicon-repo"></span>
                <span>${escHtml(commit.repoName)}</span>
              </div>
              <div class="commit-summary-card">
                <div class="commit-summary-message">${escHtml(commitMessage.subject)}</div>
                ${commitMessage.body ? `<pre class="commit-summary-body">${escHtml(commitMessage.body)}</pre>` : ''}
              </div>
              <div class="commit-summary-meta">
                <span class="commit-summary-avatar" data-author-avatar data-author-name="${escHtml(commit.authorName)}" data-author-email="${escHtml(commit.authorEmail)}" data-author-initials="${escHtml(initials)}" data-avatar-size="20" title="${escHtml(commit.authorName)} &lt;${escHtml(commit.authorEmail)}&gt;" style="background: ${escHtml(commitBg)}; color: #fff;">
                  ${commitAvatarUrl
                    ? `<img src="${escHtml(commitAvatarUrl)}" alt="${escHtml(commit.authorName)}" style="width:20px;height:20px;border-radius:50%;object-fit:cover;" onerror="this.remove();" />`
                    : escHtml(initials)
                  }
                </span>
                <span>${escHtml(commit.authorName)}</span>
                <span class="commit-summary-dot">·</span>
                <span data-local-date="${escHtml(commit.authorDate)}">${escHtml(commit.authorDate)}</span>
                <span class="commit-summary-dot">·</span>
                <span class="commit-summary-meta-hash" title="${escHtml(commit.hash)}"><span class="codicon codicon-git-commit"></span>${escHtml(commit.shortHash)}</span>
              </div>
              ${commit.branches.local.length > 0 || commit.branches.remote.length > 0 || commit.branches.tags.length > 0
                ? `<div class="refs-row commit-summary-refs" data-commit-refs data-commit-repo-id="${escHtml(commit.repoId)}" data-commit-hash="${escHtml(commit.hash)}"></div>`
                : ''}
            </div>`;
          }).join('')}
        </div>
      </div>` : `
      <div>
        <div class="section-label">${escHtml(t('Author'))}</div>
        <div class="author-row">
          <div class="avatar" id="authorAvatar" data-author-avatar data-author-name="${escHtml(data.authorName)}" data-author-email="${escHtml(data.authorEmail)}" data-author-initials="${escHtml(authorInitials)}" data-avatar-size="36" title="${escHtml(data.authorName)} &lt;${escHtml(data.authorEmail)}&gt;" style="background: ${escHtml(authorBg)}; color: #fff;">
            ${data.authorAvatarUrl
              ? `<img src="${escHtml(data.authorAvatarUrl)}" alt="${escHtml(data.authorName)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;" onerror="this.remove();" />`
              : escHtml(authorInitials)
            }
          </div>
          <div class="author-meta">
            <span class="author-name">${escHtml(data.authorName)}</span>
            <span class="author-email">${escHtml(data.authorEmail)}</span>
          </div>
        </div>
      </div>
      <div>
        <div class="section-label">${escHtml(t('Details'))}</div>
        <div class="meta-grid">
          <span class="meta-key">${escHtml(t('Hash'))}</span>
          <span class="meta-val">${escHtml(data.hash)}</span>
          <span class="meta-key">${escHtml(t('Author date'))}</span>
          <span class="meta-val normal" id="authorDate">${escHtml(data.authorDate)}</span>
          <span class="meta-key">${escHtml(t('Commit date'))}</span>
          <span class="meta-val normal" id="committerDate">${escHtml(data.committerDate)}</span>
          <span class="meta-key">${escHtml(t('Repository'))}</span>
          <span class="meta-val normal">${escHtml(data.repoName)}</span>
        </div>
      </div>
      ${allBranches.length > 0 ? `<div id="refsSection">
        <div class="section-label">${escHtml(t('Branches & tags'))}</div>
        <div class="refs-row" id="refsRow"></div>
      </div>` : ''}
      <div>
        <div class="section-label">${escHtml(t('Commit message'))}</div>
        <pre class="commit-message">${escHtml(fullMsgDisplay)}</pre>
      </div>`;

  return `<!DOCTYPE html>
<html lang="${escHtml(data.i18n.locale)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${codiconUri}">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; overflow: hidden; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      display: flex; flex-direction: column;
    }
    :root {
      --versiondock-badge-background: var(--vscode-badge-background, var(--vscode-button-background, #0078d4));
      --versiondock-badge-foreground: var(--vscode-badge-foreground, var(--vscode-button-foreground, #ffffff));
    }

    /* ── Top toolbar ── */
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .toolbar-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; color: var(--vscode-descriptionForeground);
    }
    .toolbar-message {
      flex: 1; font-weight: 500;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .toolbar-actions { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    .ai-explain-btn {
      position: relative; isolation: isolate; overflow: hidden;
      height: 28px; padding: 0 11px;
      display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      border: none;
      border-radius: 6px; cursor: pointer;
      background: linear-gradient(125deg, #7657ff, #2f8fff);
      color: #ffffff; font: inherit; font-size: 12px; font-weight: 600;
      box-shadow: none; white-space: nowrap;
      transition: filter 140ms ease, transform 140ms ease;
    }
    .ai-explain-btn > * { position: relative; z-index: 2; }
    .ai-explain-btn::after {
      content: ''; position: absolute; pointer-events: none; opacity: 0; z-index: 1;
      top: -55%; left: -28%; width: 10%; height: 210%;
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.96), transparent);
      box-shadow: 0 0 5px rgba(222, 239, 255, 0.7);
    }
    .ai-explain-btn:hover:not(:disabled) { filter: brightness(1.08); transform: translateY(-1px); }
    .ai-explain-btn:hover:not(:disabled)::after { animation: aiSlashEdge 880ms cubic-bezier(0.22, 0.7, 0.22, 1) both; }
    .ai-explain-btn:active:not(:disabled) { transform: translateY(0); filter: brightness(0.98); }
    .ai-explain-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px;
    }
    .ai-explain-btn[data-busy="true"] {
      animation: aiButtonBreathe 1.8s ease-in-out infinite;
    }
    .ai-explain-btn[data-busy="true"] .codicon { animation: aiStopBreathe 1.1s ease-in-out infinite; }

    /* ── Split layout ── */
    .split { display: flex; flex: 1; overflow: hidden; }

    /* ── Left panel ── */
    .left-panel {
      width: 50%; min-width: 260px; max-width: 680px;
      display: flex; flex-direction: column;
      border-right: 1px solid var(--vscode-panel-border);
      overflow-y: auto;
      padding: 20px 24px;
      gap: 20px;
      scrollbar-width: thin;
      scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
    }

    /* ── AI explanation ── */
    .ai-explanation {
      position: relative; isolation: isolate; overflow: hidden;
      display: flex; flex-direction: column; gap: 11px;
      flex-shrink: 0;
      padding: 14px 15px 12px;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 68%, #7657ff 32%);
      border-radius: 8px;
      background: linear-gradient(145deg,
        color-mix(in srgb, var(--vscode-editor-background) 92%, #7657ff 8%),
        color-mix(in srgb, var(--vscode-editor-background) 94%, #2f8fff 6%));
      box-shadow: 0 8px 24px color-mix(in srgb, #4f63df 14%, transparent);
      animation: aiPanelEnter 180ms ease-out both;
    }
    .ai-explanation.hidden { display: none; }
    .ai-explanation::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 2px;
      background: linear-gradient(90deg, #7657ff, #2f8fff, #7657ff);
      background-size: 220% 100%;
    }
    .ai-explanation[data-state="generating"]::before { animation: aiSpectrum 1.8s linear infinite; }
    .ai-explanation[data-state="error"]::before { background: var(--vscode-errorForeground); }
    .ai-header { display: flex; align-items: center; gap: 9px; min-width: 0; }
    .ai-orb {
      position: relative; width: 30px; height: 30px; flex-shrink: 0;
      display: inline-flex; align-items: center; justify-content: center;
      border-radius: 50%; color: #ffffff;
      background: linear-gradient(125deg, #7657ff, #2f8fff);
      box-shadow: 0 0 0 3px color-mix(in srgb, #7657ff 14%, transparent), 0 4px 12px color-mix(in srgb, #2f8fff 30%, transparent);
    }
    .ai-orb::after {
      content: ''; position: absolute; inset: -4px; border-radius: inherit;
      border: 1px solid color-mix(in srgb, #2f8fff 52%, transparent); opacity: 0;
    }
    .ai-explanation[data-state="generating"] .ai-orb::after { animation: aiOrbRing 1.6s ease-out infinite; }
    .ai-heading { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 2px; }
    .ai-title { font-size: 12px; font-weight: 700; letter-spacing: 0.01em; }
    .ai-status { font-size: 11px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-live-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
      background: #58b6ff; box-shadow: 0 0 7px rgba(47,143,255,0.62); opacity: 0;
    }
    .ai-explanation[data-state="generating"] .ai-live-dot { opacity: 1; animation: aiDotPulse 1s ease-in-out infinite; }
    .ai-stages { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .ai-stage {
      position: relative; display: flex; align-items: center; gap: 5px;
      min-width: 0; color: var(--vscode-descriptionForeground); font-size: 10px;
      transition: color 160ms ease;
    }
    .ai-stage::before {
      content: ''; width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
      background: var(--vscode-descriptionForeground); transition: transform 160ms ease, background 160ms ease;
    }
    .ai-stage.active { color: var(--vscode-foreground); }
    .ai-stage.active::before { transform: scale(1.4); background: #7657ff; box-shadow: 0 0 6px rgba(118,87,255,0.58); }
    .ai-stage.done { color: var(--vscode-foreground); }
    .ai-stage.done::before { background: #2f8fff; }
    .ai-stage-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-output {
      min-height: 42px;
      padding: 8px 10px;
      border-left: 2px solid #7657ff;
      border-radius: 0 6px 6px 0;
      background: linear-gradient(90deg,
        color-mix(in srgb, var(--vscode-editor-background) 88%, #7657ff 12%),
        color-mix(in srgb, var(--vscode-editor-background) 96%, #2f8fff 4%));
      color: var(--vscode-editor-foreground);
      font-size: 12px; line-height: 1.62; word-break: break-word;
    }
    .ai-output:empty { display: none; }
    .ai-output h3 { margin: 11px 0 4px; font-size: 12px; line-height: 1.45; color: color-mix(in srgb, var(--vscode-foreground) 72%, #7657ff 28%); }
    .ai-output h3:first-child { margin-top: 0; }
    .ai-output p { margin: 3px 0; }
    .ai-output ul { margin: 4px 0 5px 17px; padding: 0; }
    .ai-output li { margin: 3px 0; padding-left: 1px; }
    .ai-output li::marker { color: #2f8fff; }
    .ai-output pre {
      margin: 6px 0; padding: 8px 10px; overflow-x: auto;
      border: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, #2f8fff 28%);
      border-radius: 4px; background: color-mix(in srgb, var(--vscode-textCodeBlock-background) 94%, #2f8fff 6%);
      font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; line-height: 1.5; white-space: pre-wrap;
    }
    .ai-cursor {
      display: inline-block; width: 6px; height: 1.05em; margin-left: 2px; vertical-align: -2px;
      border-radius: 1px; background: #2f8fff; box-shadow: 0 0 5px rgba(47,143,255,0.45); animation: aiCursorBlink 740ms steps(1) infinite;
    }
    .ai-placeholder { display: flex; align-items: center; gap: 7px; color: color-mix(in srgb, var(--vscode-descriptionForeground) 78%, #2f8fff 22%); font-size: 11px; }
    .ai-thinking-dots { display: inline-flex; gap: 3px; }
    .ai-thinking-dots i { width: 4px; height: 4px; border-radius: 50%; background: currentColor; animation: aiThinkingDot 1s ease-in-out infinite; }
    .ai-thinking-dots i:nth-child(2) { animation-delay: 120ms; }
    .ai-thinking-dots i:nth-child(3) { animation-delay: 240ms; }
    .ai-error { display: none; color: var(--vscode-errorForeground); font-size: 11px; line-height: 1.5; white-space: pre-wrap; }
    .ai-error.visible { display: block; }
    .ai-footer { display: none; align-items: center; gap: 8px; flex-wrap: wrap; padding-top: 8px; border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 72%, #2f8fff 28%); }
    .ai-footer.visible { display: flex; }
    .ai-meta { flex: 1; min-width: 120px; font-size: 10px; color: var(--vscode-descriptionForeground); }
    .ai-warning { display: none; align-items: center; gap: 4px; color: var(--vscode-editorWarning-foreground, #cca700); font-size: 10px; }
    .ai-warning.visible { display: inline-flex; }
    @keyframes aiPanelEnter { from { opacity: 0; transform: translateY(-5px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes aiSpectrum { to { background-position: -220% 0; } }
    @keyframes aiButtonBreathe { 0%,100% { filter: brightness(1); } 50% { filter: brightness(1.12); } }
    @keyframes aiStopBreathe { 0%,100% { transform: scale(1); opacity: 0.85; } 50% { transform: scale(1.16); opacity: 1; } }
    @keyframes aiSlashEdge {
      0% { transform: translate3d(0, 0, 0) skewX(-22deg); opacity: 0; }
      22% { opacity: 0.35; }
      48% { opacity: 1; }
      100% { transform: translate3d(1550%, 0, 0) skewX(-22deg); opacity: 0; }
    }
    @keyframes aiOrbRing { 0% { opacity: 0.55; transform: scale(0.84); } 70%,100% { opacity: 0; transform: scale(1.22); } }
    @keyframes aiDotPulse { 0%,100% { opacity: 0.4; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.15); } }
    @keyframes aiCursorBlink { 0%,48% { opacity: 1; } 49%,100% { opacity: 0; } }
    @keyframes aiThinkingDot { 0%,60%,100% { opacity: 0.28; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-2px); } }
    @media (max-width: 640px) {
      .ai-explain-label { display: none; }
      .ai-explain-btn { width: 30px; padding: 4px; }
      .ai-stage-label { display: none; }
      .ai-stages { grid-template-columns: repeat(3, 22px); }
    }
    @media (prefers-reduced-motion: reduce) {
      .ai-explanation, .ai-explain-btn::after { animation: none !important; transition: none !important; }
      .ai-explain-btn { transition: none !important; }
      .ai-explain-btn:hover:not(:disabled) { transform: none; }
    }
    .section-label {
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground); margin-bottom: 6px;
    }
    .author-row { display: flex; align-items: center; gap: 10px; }
    .avatar {
      width: 36px; height: 36px; border-radius: 50%;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      display: flex; align-items: center; justify-content: center;
      font-size: 13px; font-weight: 600; line-height: 1;
      flex-shrink: 0; overflow: hidden; user-select: none;
    }
    .author-meta { display: flex; flex-direction: column; gap: 2px; }
    .author-name { font-weight: 500; }
    .author-email { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .meta-grid {
      display: grid; grid-template-columns: max-content 1fr;
      gap: 4px 14px; align-items: start;
    }
    .meta-key { color: var(--vscode-descriptionForeground); font-size: 12px; white-space: nowrap; }
    .meta-val { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
    .meta-val.normal { font-family: var(--vscode-font-family); word-break: normal; }
    .refs-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .ref-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 7px; border-radius: 10px;
      font-size: 11px; font-weight: 500;
      border: 1px solid currentColor;
    }
    .ref-badge .codicon { font-size: 10px; }
    .ref-local  { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
    .ref-remote { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
    .ref-tag    { color: var(--vscode-gitDecoration-untrackedResourceForeground, #73c6e7); }
    .commit-message {
      background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px; padding: 12px 14px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; line-height: 1.45;
      white-space: pre-wrap; word-break: break-word;
    }
    .commit-summary-list { display: flex; flex-direction: column; }
    .commit-summary-item {
      padding: 8px 0 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .commit-summary-item.last { border-bottom: none; }
    .commit-summary-repo {
      display: flex; align-items: center; gap: 4px;
      margin-bottom: 6px; min-width: 0;
      font-size: 11px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.04em;
      color: color-mix(in srgb, var(--versiondock-project-color) 70%, var(--vscode-foreground));
    }
    .commit-summary-repo .codicon { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .commit-summary-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      padding: 10px 12px;
      background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    }
    .commit-summary-message {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; font-weight: 400; line-height: 1.45;
      white-space: pre-wrap; word-break: break-word;
    }
    .commit-summary-body {
      margin-top: 8px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; line-height: 1.45;
      white-space: pre-wrap; word-break: break-word;
    }
    .commit-summary-meta {
      display: flex; align-items: center; gap: 6px;
      margin-top: 8px; font-size: 11px; color: var(--vscode-descriptionForeground);
      flex-wrap: wrap;
    }
    .commit-summary-avatar {
      width: 20px; height: 20px; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      font-size: 9px; font-weight: 600; line-height: 1;
      flex-shrink: 0; overflow: hidden; user-select: none;
    }
    .commit-summary-dot { color: var(--vscode-descriptionForeground); }
    .commit-summary-meta-hash {
      display: inline-flex; align-items: center; gap: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; white-space: nowrap;
    }
    .commit-summary-meta-hash .codicon { font-size: 11px; color: var(--vscode-descriptionForeground); }
    .commit-summary-refs { margin-top: 6px; }

    /* ── Right panel ── */
    .right-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative; }
    .file-toolbar {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .file-count { font-size: 11px; color: var(--vscode-descriptionForeground); flex: 1; padding-left: 4px; }
    .tb-btn {
      background: none; border: none; cursor: pointer;
      padding: 3px 4px; border-radius: 3px;
      color: var(--vscode-descriptionForeground);
      display: flex; align-items: center;
      font-size: 13px;
    }
    .tb-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .tb-btn.active { opacity: 1; background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }

    .file-list { flex: 1; overflow-y: auto; padding: 2px 0; }

    .no-merge-conflicts {
      padding: 8px 10px 7px;
      font-size: 12px;
      font-weight: 400;
      text-align: center;
      color: var(--vscode-descriptionForeground);
      opacity: 0.72;
    }

    .merge-parent-group { border-top: 1px solid var(--vscode-panel-border); }
    .merge-parent-row {
      display: flex; align-items: center; gap: 5px;
      min-height: 22px; padding: 2px 10px 2px 4px;
      font-size: 12px; cursor: pointer; user-select: none;
      box-sizing: border-box;
      width: 100%;
    }
    .merge-parent-row:hover { background: var(--vscode-list-hoverBackground); }
    .merge-parent-row.active { background: var(--vscode-list-inactiveSelectionBackground); }
    .merge-parent-row.active:hover { background: var(--vscode-list-hoverBackground); }
    .merge-parent-chevron { font-size: 10px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
    .merge-parent-commit-icon { font-size: 12px; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
    .merge-parent-title { flex-shrink: 0; font-size: 11px; }
    .merge-parent-message { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .merge-parent-count { flex-shrink: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .merge-parent-files { margin-bottom: 3px; }
    .merge-parent-loading { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 4px 8px 4px 22px; }

    /* Flat rows */
    .file-row {
      display: flex; align-items: center; gap: 4px;
      min-height: 22px; padding: 2px 10px 2px 0; cursor: pointer; user-select: none;
      box-sizing: border-box;
      width: 100%;
    }
    .file-row:hover { background: var(--vscode-list-hoverBackground); }
    .file-row.ctx-active { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); }
    .row-indent { flex-shrink: 0; }
    .row-icon { font-size: 14px; flex-shrink: 0; }
    .row-name { font-size: 12px; white-space: nowrap; font-weight: 500; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .row-dir { font-size: 11px; color: var(--vscode-descriptionForeground); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .row-tail { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; }
    .row-stats { display: flex; gap: 3px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); flex-shrink: 0; }
    .row-status { font-size: 10px; font-weight: 700; flex-shrink: 0; margin-right: 6px; }
    .added   { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
    .removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }

    /* Tree dir rows */
    .dir-row {
      display: flex; align-items: center; gap: 3px;
      min-height: 22px; padding: 2px 10px 2px 0; cursor: pointer; user-select: none;
      box-sizing: border-box;
      width: 100%;
    }
    .dir-row:hover { background: var(--vscode-list-hoverBackground); }
    .dir-name { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .dir-badge {
      font-size: 10px;
      background: var(--versiondock-badge-background);
      color: var(--versiondock-badge-foreground);
      border-radius: 8px; padding: 0 5px; flex-shrink: 0; margin-left: auto;
    }

    /* ── 统一布局密度与悬浮系统（Layout Density & Floating Hover System） ── */
    [data-density="comfortable"] .file-row,
    [data-density="comfortable"] .dir-row,
    [data-density="comfortable"] .merge-parent-row {
      margin-left: 6px !important;
      margin-right: 6px !important;
      border-radius: 5px !important;
      width: auto !important;
      box-sizing: border-box !important;
      transition: background 0.12s ease, color 0.12s ease !important;
    }

    [data-density="compact"] .file-row,
    [data-density="compact"] .dir-row,
    [data-density="compact"] .merge-parent-row {
      margin-left: 0 !important;
      margin-right: 0 !important;
      border-radius: 0 !important;
      width: 100% !important;
      box-sizing: border-box !important;
    }

    /* Speed search */
    .speed-search-widget {
      position: absolute;
      top: 36px;
      right: 16px;
      z-index: 50;
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border-radius: 4px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-widget-border, #454545);
      font-size: 12px;
    }
    .speed-search-input {
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #cccccc);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      padding: 2px 6px;
      font-size: 12px;
      outline: none;
      width: 140px;
    }
    .speed-search-input:focus {
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    .speed-search-count {
      font-size: 11px;
      color: var(--vscode-descriptionForeground, #888888);
      white-space: nowrap;
      min-width: 36px;
    }
    .speed-search-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground, #cccccc);
      cursor: pointer;
      padding: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 2px;
      opacity: 0.75;
    }
    .speed-search-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31));
    }
    mark.speed-search-highlight {
      background-color: #ffd600;
      color: #000000;
      font-weight: 600;
      border-radius: 2px;
      padding: 0 2px;
    }
    .file-row.speed-search-active mark.speed-search-highlight {
      background-color: #ff9100;
      color: #000000;
      font-weight: 700;
    }
    .file-row.speed-search-active {
      background: var(--vscode-list-activeSelectionBackground, rgba(255, 255, 255, 0.1)) !important;
      outline: 1px solid var(--vscode-list-focusOutline, #007fd4);
    }

    /* Context menu */
    .ctx-menu {
      position: fixed;
      background: var(--vscode-menu-background);
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 4px; padding: 3px 0;
      min-width: 200px; z-index: 9999;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
    }
    .ctx-menu.hidden { display: none; }
    .ctx-item {
      display: flex; align-items: center; gap: 8px;
      padding: 5px 12px; font-size: 12px; cursor: pointer;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
    }
    .ctx-item:hover { background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)); }
    .ctx-sep { height: 1px; background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border)); margin: 3px 0; }
    .ctx-item.danger { color: var(--vscode-errorForeground); }

  </style>
</head>
<body data-density="${escHtml(data.layoutDensity)}">
  <div class="toolbar">
    <span class="codicon codicon-git-commit" style="color:var(--vscode-descriptionForeground)"></span>
    <span class="toolbar-hash">${escHtml(data.shortHash)}</span>
    <span class="toolbar-message">${escHtml(data.message)}</span>
    <div class="toolbar-actions">
      <button class="ai-explain-btn" id="btnAiExplain" data-busy="false" title="${escHtml(t('Explain commit with AI'))}">
        <span class="codicon codicon-sparkle-filled" id="aiExplainIcon"></span>
        <span class="ai-explain-label" id="aiExplainLabel">${escHtml(t('AI Explain'))}</span>
      </button>
    </div>
  </div>

  <div class="split">
    <div class="left-panel">
      <section class="ai-explanation hidden" id="aiExplanation" data-state="idle" aria-label="${escHtml(t('AI Commit Explanation'))}">
        <div class="ai-header">
          <span class="ai-orb" aria-hidden="true"><span class="codicon codicon-sparkle"></span></span>
          <div class="ai-heading">
            <span class="ai-title">${escHtml(t('AI Commit Explanation'))}</span>
            <span class="ai-status" id="aiStatus" role="status" aria-live="polite">${escHtml(data.mode === 'aggregate' ? t('Ready to explain the selected commits') : t('Ready to explain this commit'))}</span>
          </div>
          <span class="ai-live-dot" aria-hidden="true"></span>
        </div>
        <div class="ai-stages" id="aiStages" aria-hidden="true">
          <div class="ai-stage" data-ai-stage="reading"><span class="ai-stage-label">${escHtml(t('Read commit'))}</span></div>
          <div class="ai-stage" data-ai-stage="analyzing"><span class="ai-stage-label">${escHtml(t('Analyze changes'))}</span></div>
          <div class="ai-stage" data-ai-stage="thinking"><span class="ai-stage-label">${escHtml(t('Compose explanation'))}</span></div>
        </div>
        <div class="ai-placeholder" id="aiPlaceholder">
          <span>${escHtml(t('AI is preparing the explanation'))}</span>
          <span class="ai-thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <div class="ai-output" id="aiOutput"></div>
        <div class="ai-error" id="aiError"></div>
        <div class="ai-footer" id="aiFooter">
          <span class="ai-meta" id="aiMeta"></span>
          <span class="ai-warning" id="aiWarning"><span class="codicon codicon-warning"></span>${escHtml(t('Some oversized changes were truncated'))}</span>
        </div>
      </section>
${leftPanelContent}
    </div>

    <div class="right-panel">
      <div class="file-toolbar">
        <span class="file-count" id="fileCount"></span>
        <button class="tb-btn" id="btnExpandAll" title="${escHtml(t('Expand all'))}" style="display:none"><span class="codicon codicon-expand-all"></span></button>
        <button class="tb-btn" id="btnCollapseAll" title="${escHtml(t('Collapse all'))}" style="display:none"><span class="codicon codicon-collapse-all"></span></button>
        <button class="tb-btn active" id="btnTree" title="${escHtml(t('Tree view'))}"><span class="codicon codicon-list-tree"></span></button>
        <button class="tb-btn" id="btnFlat" title="${escHtml(t('Flat list'))}"><span class="codicon codicon-list-flat"></span></button>
      </div>
      <div class="speed-search-widget" id="speedSearchWidget" style="display: none;">
        <input type="text" class="speed-search-input" id="speedSearchInput" placeholder="${escHtml(t('Search files...'))}" />
        <span class="speed-search-count" id="speedSearchCount">0/0</span>
        <button class="speed-search-btn" id="speedSearchPrev" title="${escHtml(t('Previous match (Shift+Enter / Up)'))}"><span class="codicon codicon-arrow-up"></span></button>
        <button class="speed-search-btn" id="speedSearchNext" title="${escHtml(t('Next match (Enter / Down)'))}"><span class="codicon codicon-arrow-down"></span></button>
        <button class="speed-search-btn" id="speedSearchClose" title="${escHtml(t('Close (Escape)'))}"><span class="codicon codicon-close"></span></button>
      </div>
      <div class="file-list" id="fileList"></div>
    </div>
  </div>

  <div class="ctx-menu hidden" id="ctxMenu">
    <div class="ctx-item" id="ctxDiff"><span class="codicon codicon-diff"></span>${escHtml(t('Show Diff'))}</div>
    <div class="ctx-item" id="ctxEdit"><span class="codicon codicon-go-to-file"></span>${escHtml(t('Open file'))}</div>
    ${canRevert ? `<div class="ctx-sep"></div>
    <div class="ctx-item danger" id="ctxRevert"><span class="codicon codicon-discard"></span>${escHtml(t('Revert Selected Changes'))}</div>` : ''}
    <div class="ctx-sep"></div>
    <div class="ctx-item" id="ctxRevealExp"><span class="codicon codicon-list-tree"></span>${escHtml(t('Reveal in Explorer'))}</div>
    <div class="ctx-item" id="ctxRevealOS"><span class="codicon codicon-folder-opened"></span><span id="revealOsLabel"></span></div>
  </div>

  <script id="__data" type="application/json">${escJson({
    files: data.files,
    parents: data.parents,
    mergeParentChanges: data.mergeParentChanges ?? [],
    hash: data.hash,
    repoId: data.repoId,
    repoName: data.repoName,
    repoColor: data.repoColor,
    repoKind: data.repoKind,
    showRepoGrouping: data.showRepoGrouping,
    authorDate: data.authorDate,
    committerDate: data.committerDate,
    authorEmail: data.authorEmail,
    authorName: data.authorName,
    mode: data.mode,
    autoExplain: data.autoExplain,
    branches: allBranches,
    commits: data.commits ?? [],
    iconTheme: data.iconTheme,
    i18n: data.i18n,
  })}</script>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // ── Load all dynamic data from JSON data block ──
    const __d = JSON.parse(document.getElementById('__data').textContent);
    const FILES = __d.files;
    const ICON_THEME = __d.iconTheme || { type: 'none' };
    const I18N = __d.i18n || { locale: 'en', bundle: {} };
    const LOCALE = I18N.locale || 'en';
    const IS_MAC = navigator.userAgent.includes('Mac');
    const IS_WIN = navigator.userAgent.includes('Windows');

    function formatI18n(template, args) {
      if (!args || args.length === 0) return template;
      return template.replace(/\\{(\\d+)\\}/g, (match, index) => {
        const value = args[Number(index)];
        return value === undefined ? match : String(value);
      });
    }
    function t(message, ...args) {
      const template = I18N.bundle?.[message] || message;
      return formatI18n(template, args);
    }

    const REVEAL_OS_LABEL = IS_MAC ? t('Reveal in Finder') : IS_WIN ? t('Show in Explorer') : t('Show in File Manager');
    document.getElementById('revealOsLabel').textContent = REVEAL_OS_LABEL;

    // ── Escape helpers ──
    function escText(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }
    function escAttr(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── AI commit explanation ──
    const aiPanel = document.getElementById('aiExplanation');
    const aiButton = document.getElementById('btnAiExplain');
    const aiButtonIcon = document.getElementById('aiExplainIcon');
    const aiButtonLabel = document.getElementById('aiExplainLabel');
    const aiStatus = document.getElementById('aiStatus');
    const aiOutput = document.getElementById('aiOutput');
    const aiPlaceholder = document.getElementById('aiPlaceholder');
    const aiError = document.getElementById('aiError');
    const aiFooter = document.getElementById('aiFooter');
    const aiMeta = document.getElementById('aiMeta');
    const aiWarning = document.getElementById('aiWarning');
    const aiStageElements = Array.from(document.querySelectorAll('[data-ai-stage]'));
    const readyAiStatus = __d.mode === 'aggregate'
      ? t('Ready to explain the selected commits')
      : t('Ready to explain this commit');
    let activeAiRequestId = null;
    let aiBusy = false;
    let aiTargetText = '';
    let aiDisplayedText = '';
    let aiTypingHandle = null;
    let pendingAiResult = null;

    function aiRequestId() {
      return 'ai-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }

    function setAiButton(busy, hasResult) {
      aiBusy = busy;
      aiButton.dataset.busy = busy ? 'true' : 'false';
      aiButtonIcon.className = 'codicon codicon-' + (busy ? 'stop-circle' : 'sparkle-filled');
      aiButtonLabel.textContent = busy ? t('Stop') : hasResult ? t('Explain again') : t('AI Explain');
      aiButton.title = busy ? t('Stop AI commit explanation') : hasResult ? t('Explain commits again with AI') : t('Explain commit with AI');
      aiButton.setAttribute('aria-busy', busy ? 'true' : 'false');
    }

    function setAiStages(phase, completed) {
      const order = ['reading', 'analyzing', 'thinking'];
      const effectivePhase = phase === 'writing' ? 'thinking' : phase;
      const currentIndex = order.indexOf(effectivePhase);
      aiStageElements.forEach((element, index) => {
        element.classList.toggle('active', !completed && index === currentIndex);
        element.classList.toggle('done', completed || (currentIndex >= 0 && index < currentIndex));
      });
    }

    function setAiPhase(phase, fileCount) {
      setAiStages(phase, false);
      if (phase === 'reading') aiStatus.textContent = t('Reading commit information…');
      if (phase === 'analyzing') aiStatus.textContent = t('Analyzing changed files…');
      if (phase === 'thinking') aiStatus.textContent = fileCount == null
        ? t('Organizing the explanation…')
        : t('Organizing an explanation for {0} files…', fileCount);
      if (phase === 'writing') aiStatus.textContent = t('AI is writing the explanation…');
    }

    function appendAiCursor(container) {
      const cursor = document.createElement('span');
      cursor.className = 'ai-cursor';
      cursor.setAttribute('aria-hidden', 'true');
      const last = container.lastElementChild;
      if (last?.tagName === 'UL' && last.lastElementChild) last.lastElementChild.appendChild(cursor);
      else if (last) last.appendChild(cursor);
      else container.appendChild(cursor);
    }

    function renderAiMarkdown(text, showCursor) {
      const fragment = document.createDocumentFragment();
      const lines = String(text || '').replace(/\\r\\n/g, '\\n').split('\\n');
      let list = null;
      let codeBlock = null;

      for (const line of lines) {
        if (line.trim().startsWith(String.fromCharCode(96, 96, 96))) {
          if (codeBlock) {
            fragment.appendChild(codeBlock);
            codeBlock = null;
          } else {
            codeBlock = document.createElement('pre');
          }
          list = null;
          continue;
        }
        if (codeBlock) {
          codeBlock.textContent += (codeBlock.textContent ? '\\n' : '') + line;
          continue;
        }
        const heading = /^##\\s+(.+)$/.exec(line);
        if (heading) {
          const element = document.createElement('h3');
          element.textContent = heading[1];
          fragment.appendChild(element);
          list = null;
          continue;
        }
        const bullet = /^[-*]\\s+(.+)$/.exec(line);
        if (bullet) {
          if (!list) {
            list = document.createElement('ul');
            fragment.appendChild(list);
          }
          const item = document.createElement('li');
          item.textContent = bullet[1];
          list.appendChild(item);
          continue;
        }
        if (!line.trim()) {
          list = null;
          continue;
        }
        const paragraph = document.createElement('p');
        paragraph.textContent = line;
        fragment.appendChild(paragraph);
        list = null;
      }
      if (codeBlock) fragment.appendChild(codeBlock);
      aiOutput.replaceChildren(fragment);
      if (showCursor) appendAiCursor(aiOutput);
    }

    function finishAiTypingIfReady() {
      if (!pendingAiResult || aiDisplayedText !== aiTargetText) return;
      const result = pendingAiResult;
      pendingAiResult = null;
      activeAiRequestId = null;
      aiPanel.dataset.state = 'complete';
      aiPlaceholder.style.display = 'none';
      renderAiMarkdown(aiDisplayedText, false);
      setAiStages('thinking', true);
      aiStatus.textContent = t('Explanation complete');
      const provider = result.provider || t('AI');
      const model = result.model ? ' · ' + result.model : '';
      const duration = typeof result.durationMs === 'number' ? ' · ' + (result.durationMs / 1000).toFixed(1) + 's' : '';
      aiMeta.textContent = provider + model + duration;
      aiWarning.classList.toggle('visible', !!result.contextTruncated || !!result.inputTruncated);
      aiFooter.classList.add('visible');
      setAiButton(false, true);
    }

    function scheduleAiTyping() {
      if (aiTypingHandle !== null) return;
      const tick = () => {
        aiTypingHandle = null;
        const remaining = aiTargetText.length - aiDisplayedText.length;
        if (remaining > 0) {
          const chunkSize = remaining > 600 ? 12 : remaining > 240 ? 6 : remaining > 80 ? 3 : 1;
          aiDisplayedText = aiTargetText.slice(0, aiDisplayedText.length + chunkSize);
          renderAiMarkdown(aiDisplayedText, true);
        }
        if (aiDisplayedText.length < aiTargetText.length) {
          aiTypingHandle = window.setTimeout(tick, 12);
        } else {
          finishAiTypingIfReady();
        }
      };
      aiTypingHandle = window.setTimeout(tick, 12);
    }

    function resetAiSurface() {
      if (aiTypingHandle !== null) window.clearTimeout(aiTypingHandle);
      aiTypingHandle = null;
      aiTargetText = '';
      aiDisplayedText = '';
      pendingAiResult = null;
      aiOutput.replaceChildren();
      aiError.textContent = '';
      aiError.classList.remove('visible');
      aiMeta.textContent = '';
      aiWarning.classList.remove('visible');
      aiFooter.classList.remove('visible');
      aiPlaceholder.style.display = '';
      aiPlaceholder.firstElementChild.textContent = t('AI is preparing the explanation');
      aiStatus.textContent = readyAiStatus;
      setAiStages('', false);
    }

    function startAiExplanation() {
      if (aiBusy) return;
      resetAiSurface();
      activeAiRequestId = aiRequestId();
      aiPanel.classList.remove('hidden');
      aiPanel.dataset.state = 'generating';
      setAiButton(true, false);
      setAiPhase('reading');
      vscode.postMessage({ type: 'generateExplanation', requestId: activeAiRequestId });
    }

    function stopAiExplanation(notifyHost = true) {
      if (!aiBusy || !activeAiRequestId) return;
      const requestId = activeAiRequestId;
      activeAiRequestId = null;
      if (notifyHost) vscode.postMessage({ type: 'cancelExplanation', requestId });
      if (aiTypingHandle !== null) window.clearTimeout(aiTypingHandle);
      aiTypingHandle = null;
      aiDisplayedText = aiTargetText;
      renderAiMarkdown(aiDisplayedText, false);
      aiPanel.dataset.state = 'cancelled';
      aiPlaceholder.style.display = aiDisplayedText ? 'none' : '';
      aiPlaceholder.firstElementChild.textContent = t('Explanation stopped');
      aiStatus.textContent = t('Explanation stopped');
      aiFooter.classList.add('visible');
      aiMeta.textContent = t('Partial output was kept');
      setAiButton(false, true);
    }

    function showAiError(message) {
      if (aiTypingHandle !== null) window.clearTimeout(aiTypingHandle);
      aiTypingHandle = null;
      pendingAiResult = null;
      activeAiRequestId = null;
      aiPanel.dataset.state = 'error';
      aiPlaceholder.style.display = 'none';
      renderAiMarkdown(aiDisplayedText, false);
      aiStatus.textContent = t('AI explanation failed');
      aiError.textContent = message || t('Unknown error');
      aiError.classList.add('visible');
      aiFooter.classList.remove('visible');
      aiMeta.textContent = '';
      setAiButton(false, true);
    }

    aiButton.addEventListener('click', () => {
      if (aiBusy) stopAiExplanation();
      else startAiExplanation();
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (!message || message.requestId !== activeAiRequestId) return;
      if (message.type === 'aiExplanationStatus') {
        setAiPhase(message.phase, message.fileCount);
        if (message.contextTruncated) aiWarning.classList.add('visible');
        return;
      }
      if (message.type === 'aiExplanationDelta') {
        if (pendingAiResult) return;
        aiPlaceholder.style.display = 'none';
        setAiPhase('writing');
        aiTargetText += String(message.delta || '');
        scheduleAiTyping();
        return;
      }
      if (message.type === 'aiExplanationCancelled') {
        stopAiExplanation(false);
        return;
      }
      if (message.type === 'aiExplanationResult') {
        if (message.error) {
          showAiError(String(message.error));
          return;
        }
        const finalText = String(message.explanation || '');
        if (!finalText) {
          showAiError(t('AI provider did not return a commit explanation.'));
          return;
        }
        if (!finalText.startsWith(aiDisplayedText)) aiDisplayedText = '';
        aiTargetText = finalText;
        pendingAiResult = message;
        aiPlaceholder.style.display = 'none';
        setAiPhase('writing');
        scheduleAiTyping();
      }
    });

    if (__d.autoExplain) window.requestAnimationFrame(startAiExplanation);

    // ── Date formatting ──
    function fmtDate(iso) {
      if (!iso) return iso;
      try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleDateString(LOCALE, { year: 'numeric', month: 'short', day: 'numeric' })
             + ' ' + d.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
      } catch { return iso; }
    }
    const authorDateEl = document.getElementById('authorDate');
    const committerDateEl = document.getElementById('committerDate');
    if (authorDateEl) authorDateEl.textContent = fmtDate(__d.authorDate);
    if (committerDateEl) committerDateEl.textContent = fmtDate(__d.committerDate);
    document.querySelectorAll('[data-local-date]').forEach(el => {
      el.textContent = fmtDate(el.dataset.localDate || '');
    });
    const selectedTimeRangeEl = document.getElementById('selectedTimeRange');
    if (selectedTimeRangeEl) {
      const rangeStart = selectedTimeRangeEl.dataset.rangeStart || '';
      const rangeEnd = selectedTimeRangeEl.dataset.rangeEnd || '';
      selectedTimeRangeEl.textContent = rangeStart && rangeEnd
        ? fmtDate(rangeStart) + ' - ' + fmtDate(rangeEnd)
        : rangeStart || rangeEnd;
    }

    // ── Status colors ──
    const STATUS_COLOR = {
      M: 'var(--vscode-gitDecoration-modifiedResourceForeground)',
      A: 'var(--vscode-gitDecoration-addedResourceForeground)',
      D: 'var(--vscode-gitDecoration-deletedResourceForeground)',
      R: 'var(--vscode-gitDecoration-renamedResourceForeground, #73c991)',
      C: 'var(--vscode-gitDecoration-addedResourceForeground)',
      U: 'var(--vscode-gitDecoration-conflictingResourceForeground)',
    };
    function normalizeStatus(status) {
      return String(status || 'M').replace(/\\d+$/, '') || 'M';
    }
    function statusColor(status) {
      return STATUS_COLOR[normalizeStatus(status)] || 'var(--vscode-foreground)';
    }

    // ── Icon helpers ──
    const EXT_TO_LANG = {
      ts: 'typescript', tsx: 'typescriptreact',
      js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript',
      py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
      java: 'java', kt: 'kotlin', swift: 'swift',
      cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
      php: 'php', lua: 'lua', r: 'r', dart: 'dart',
      html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less', sass: 'sass',
      json: 'json', jsonc: 'jsonc', xml: 'xml', yaml: 'yaml', yml: 'yaml',
      md: 'markdown', markdown: 'markdown',
      sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', fish: 'fish',
      sql: 'sql', graphql: 'graphql',
      vue: 'vue', svelte: 'svelte',
      toml: 'toml', ini: 'ini',
      dockerfile: 'dockerfile',
      tf: 'terraform', hcl: 'terraform',
      proto: 'proto3',
      ps1: 'powershell', psm1: 'powershell',
      bat: 'bat', cmd: 'bat',
    };
    const EXT_CODICONS = {
      ts:'symbol-variable', tsx:'symbol-variable', js:'symbol-variable', jsx:'symbol-variable',
      json:'json', jsonc:'json', md:'markdown', mdx:'markdown',
      html:'symbol-method', htm:'symbol-method',
      css:'symbol-color', scss:'symbol-color', less:'symbol-color',
      svg:'symbol-color', png:'symbol-color', jpg:'symbol-color', jpeg:'symbol-color',
      py:'symbol-namespace', rb:'symbol-namespace', go:'symbol-namespace', rs:'symbol-namespace',
      java:'symbol-namespace', kt:'symbol-namespace', swift:'symbol-namespace', cs:'symbol-namespace',
      cpp:'symbol-namespace', c:'symbol-namespace', h:'symbol-namespace',
      sh:'terminal', bash:'terminal', zsh:'terminal',
      yml:'list-ordered', yaml:'list-ordered', toml:'list-ordered', ini:'list-ordered',
      lock:'lock', sql:'database', xml:'symbol-structure', proto:'symbol-structure',
      txt:'file-text', log:'output',
    };
    function ensureFontInjected(theme) {
      if (!theme || theme.type !== 'font' || !theme.fontFaceUri || !theme.fontId) return;
      const styleId = 'versiondock-commit-detail-font-' + theme.fontId;
      if (document.getElementById(styleId)) return;
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = '@font-face { font-family: "' + theme.fontId + '"; src: url("' + theme.fontFaceUri + '") format("' + (theme.fontFormat || 'woff') + '"); font-weight: normal; font-style: normal; }';
      document.head.appendChild(style);
    }
    ensureFontInjected(ICON_THEME);
    function fallbackCodicon(name, isFolder, isOpen) {
      if (isFolder) return isOpen ? 'folder-opened' : 'folder';
      const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
      return EXT_CODICONS[ext] || 'file';
    }
    function resolveIconName(theme, fileName, isFolder, isOpen) {
      const lower = fileName.toLowerCase();
      if (isFolder) {
        if (isOpen) return theme.folderNamesExpanded?.[lower] || theme.folderExpanded || null;
        return theme.folderNames?.[lower] || theme.folder || null;
      }
      const exactFile = theme.fileNames?.[lower];
      if (exactFile) return exactFile;
      const parts = lower.split('.');
      if (parts.length > 1) {
        for (let i = 1; i < parts.length; i += 1) {
          const suffix = parts.slice(i).join('.');
          const bySuffix = theme.fileExtensions?.[suffix];
          if (bySuffix) return bySuffix;
        }
        const ext = parts[parts.length - 1];
        const langId = EXT_TO_LANG[ext];
        if (langId) {
          const byLang = theme.languageIds?.[langId];
          if (byLang) return byLang;
        }
      }
      return theme.file || null;
    }
    function themedIconHtml(name, isFolder, isOpen, size = 14) {
      if (!ICON_THEME || ICON_THEME.type === 'none') {
        const icon = fallbackCodicon(name, isFolder, isOpen);
        return '<span class="codicon codicon-' + icon + '" style="font-size:' + size + 'px;flex-shrink:0;" aria-hidden="true"></span>';
      }
      const iconName = resolveIconName(ICON_THEME, name, isFolder, isOpen);
      if (ICON_THEME.type === 'svg' && iconName) {
        const uri = ICON_THEME.svgMap?.[iconName];
        if (uri) {
          return '<img src="' + escAttr(uri) + '" width="' + size + '" height="' + size + '" style="flex-shrink:0;object-fit:contain;" aria-hidden="true">';
        }
      }
      if (ICON_THEME.type === 'font' && iconName) {
        const char = ICON_THEME.charMap?.[iconName];
        const color = ICON_THEME.colorMap?.[iconName] || 'inherit';
        if (char) {
          return '<span style="font-family:&quot;' + escAttr(ICON_THEME.fontId) + '&quot;;font-size:' + size + 'px;color:' + escAttr(color) + ';line-height:1;user-select:none;flex-shrink:0;" aria-hidden="true">' + escText(char) + '</span>';
        }
      }
      const icon = fallbackCodicon(name, isFolder, isOpen);
      return '<span class="codicon codicon-' + icon + '" style="font-size:' + size + 'px;flex-shrink:0;" aria-hidden="true"></span>';
    }
    function fileIconHtml(name) {
      return themedIconHtml(name, false, false, 14);
    }
    function folderIconHtml(name, open) {
      return themedIconHtml(name, true, open, 16);
    }

    function formatFileCount(count) {
      return count === 1 ? t('{0} file', count) : t('{0} files', count);
    }

    // ── Stats HTML helper ──
    function statsHtml(f) {
      let s = '';
      if (f.added   != null) s += '<span class="added">+' + f.added   + '</span>';
      if (f.removed != null) s += '<span class="removed">-' + f.removed + '</span>';
      return s ? '<span class="row-stats">' + s + '</span>' : '';
    }

    // ── Context menu ──
    const ctxMenu  = document.getElementById('ctxMenu');
    let ctxPath = null, ctxStatus = null, ctxHash = null, ctxRepoId = null, ctxFromHash = null, ctxToHash = null;

    function fileDatasetAttrs(f, status) {
      let attrs = ' data-path="' + escAttr(f.path) + '" data-status="' + escAttr(status) + '"';
      if (f.repoId) attrs += ' data-repo-id="' + escAttr(f.repoId) + '"';
      if (f.hash) attrs += ' data-hash="' + escAttr(f.hash) + '"';
      if (f.fromHash) attrs += ' data-from-hash="' + escAttr(f.fromHash) + '"';
      if (f.toHash) attrs += ' data-to-hash="' + escAttr(f.toHash) + '"';
      return attrs;
    }

    function showCtx(x, y, row) {
      ctxPath = row.dataset.path;
      ctxStatus = row.dataset.status;
      ctxHash = row.dataset.hash || null;
      ctxRepoId = row.dataset.repoId || null;
      ctxFromHash = row.dataset.fromHash || null;
      ctxToHash = row.dataset.toHash || null;
      const revertItem = document.getElementById('ctxRevert');
      if (revertItem) revertItem.style.display = ctxFromHash ? 'none' : '';
      ctxMenu.classList.remove('hidden');
      requestAnimationFrame(() => {
        const margin = 4;
        const { offsetWidth: w, offsetHeight: h } = ctxMenu;
        ctxMenu.style.left = Math.max(margin, Math.min(x, window.innerWidth  - w - margin)) + 'px';
        ctxMenu.style.top  = Math.max(margin, Math.min(y, window.innerHeight - h - margin)) + 'px';
      });
    }
    function hideCtx() {
      ctxMenu.classList.add('hidden');
      document.querySelectorAll('.file-row.ctx-active').forEach(el => el.classList.remove('ctx-active'));
    }
    document.addEventListener('mousedown', e => { if (!ctxMenu.contains(e.target)) hideCtx(); }, true);
    window.addEventListener('blur', hideCtx);

    document.getElementById('ctxDiff').addEventListener('click',      () => { if (ctxPath) vscode.postMessage({ type: 'openDiff',         filePath: ctxPath, fileStatus: ctxStatus, repoId: ctxRepoId, hash: ctxHash, fromHash: ctxFromHash, toHash: ctxToHash }); hideCtx(); });
    document.getElementById('ctxEdit').addEventListener('click',      () => { if (ctxPath) vscode.postMessage({ type: 'openFile',         filePath: ctxPath, repoId: ctxRepoId }); hideCtx(); });
    if (document.getElementById('ctxRevert')) {
      document.getElementById('ctxRevert').addEventListener('click',  () => { if (ctxPath) vscode.postMessage({ type: 'revertFile', filePath: ctxPath, fileStatus: ctxStatus }); hideCtx(); });
    }
    document.getElementById('ctxRevealExp').addEventListener('click', () => { if (ctxPath) vscode.postMessage({ type: 'revealInExplorer', filePath: ctxPath, repoId: ctxRepoId }); hideCtx(); });
    document.getElementById('ctxRevealOS').addEventListener('click',  () => { if (ctxPath) vscode.postMessage({ type: 'revealInOS',       filePath: ctxPath, repoId: ctxRepoId }); hideCtx(); });

    // ── Tree builder ──
    function makeNode(name, fullPath, isRepoRoot = false, repoColor = '') {
      return { name, fullPath, isRepoRoot, repoColor, children: new Map(), file: null, fileCount: 0 };
    }
    function buildTree(files, scope = '', groupByRepo = __d.showRepoGrouping) {
      const root = makeNode('', '');
      const scopePrefix = scope ? scope + ':' : '';
      for (const f of files) {
        const parts = groupByRepo ? [f.repoName || __d.repoName, ...f.path.split('/')] : f.path.split('/');
        let node = root;
        let acc = '';
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          const isRepoRoot = groupByRepo && i === 0;
          acc = acc ? acc + '/' + p : p;
          const key = scopePrefix + (isRepoRoot ? ((f.repoId || __d.repoId) + ':' + p) : ((f.repoId || __d.repoId) + ':' + acc));
          if (!node.children.has(key)) node.children.set(key, makeNode(p, key, isRepoRoot, f.repoColor || __d.repoColor));
          node = node.children.get(key);
          if (i === parts.length - 1) node.file = f;
        }
      }
      countFiles(root);
      return root;
    }
    function countFiles(node) {
      if (node.file) { node.fileCount = 1; return 1; }
      let n = 0;
      for (const c of node.children.values()) n += countFiles(c);
      node.fileCount = n;
      return n;
    }
    function collapseDirs(node) {
      if (node.file) return node;
      if (node.isRepoRoot) {
        const nc = new Map();
        for (const [k, v] of node.children) nc.set(k, collapseDirs(v));
        return { ...node, children: nc };
      }
      if (node.children.size === 1) {
        const [, child] = node.children.entries().next().value;
        if (!child.file) {
          const col = collapseDirs(child);
          const joined = node.name ? node.name + '/' + col.name : col.name;
          return { ...col, name: joined };
        }
      }
      const nc = new Map();
      for (const [k, v] of node.children) nc.set(k, collapseDirs(v));
      return { ...node, children: nc };
    }

    // ── Render state ──
    const persistedState = (typeof vscode !== 'undefined' && typeof vscode.getState === 'function') ? (vscode.getState() || {}) : {};
    let viewMode = persistedState.viewMode || 'tree';
    // Map<fullPath, boolean> — open/closed state per dir node
    const dirOpen = new Map(Array.isArray(persistedState.dirOpen) ? persistedState.dirOpen : []);
    // forceAll: null = use dirOpen, true = all open, false = all closed
    let forceAll = null;

    function persistState() {
      try {
        if (typeof vscode !== 'undefined' && typeof vscode.setState === 'function') {
          vscode.setState({
            ...vscode.getState(),
            viewMode,
            dirOpen: Array.from(dirOpen.entries()),
            expandedMergeParentHashes: Array.from(expandedMergeParentHashes),
            mergeParentFilesByHash: Array.from(mergeParentFilesByHash.entries()),
          });
        }
      } catch {}
    }

    function isDirOpen(fullPath) {
      if (forceAll !== null) return forceAll;
      if (!dirOpen.has(fullPath)) return true; // default open
      return dirOpen.get(fullPath);
    }
    function toggleDir(fullPath) {
      forceAll = null;
      dirOpen.set(fullPath, !isDirOpen(fullPath));
      persistState();
      render();
    }

    const MERGE_PARENT_CHANGES = Array.isArray(__d.mergeParentChanges) ? __d.mergeParentChanges : [];
    const expandedMergeParentHashes = new Set(Array.isArray(persistedState.expandedMergeParentHashes) ? persistedState.expandedMergeParentHashes : []);
    const mergeParentFilesByHash = new Map(Array.isArray(persistedState.mergeParentFilesByHash) ? persistedState.mergeParentFilesByHash : []);
    const loadingMergeParentHashes = new Set();
    const pendingMergeParentRequests = new Map();

    window.addEventListener('message', event => {
      const requestId = event.data?.requestId;
      const callback = requestId ? pendingMergeParentRequests.get(requestId) : null;
      if (!callback) return;
      pendingMergeParentRequests.delete(requestId);
      callback(event.data);
    });

    function mergeParentRequestId() {
      return 'merge-parent-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    }

    function mergeParentFiles(parent) {
      const files = mergeParentFilesByHash.get(parent.hash);
      if (!files) return undefined;
      return files.map(file => ({
        ...file,
        repoId: __d.repoId,
        repoName: __d.repoName,
        repoColor: __d.repoColor,
        hash: __d.hash,
        fromHash: parent.hash,
        toHash: __d.hash,
      }));
    }

    function toggleMergeParent(parentHash) {
      if (!parentHash) return;
      if (expandedMergeParentHashes.has(parentHash)) {
        expandedMergeParentHashes.delete(parentHash);
        persistState();
        render();
        return;
      }
      expandedMergeParentHashes.add(parentHash);
      persistState();
      if (mergeParentFilesByHash.has(parentHash) || loadingMergeParentHashes.has(parentHash)) {
        render();
        return;
      }
      loadingMergeParentHashes.add(parentHash);
      render();
      const requestId = mergeParentRequestId();
      pendingMergeParentRequests.set(requestId, result => {
        loadingMergeParentHashes.delete(parentHash);
        mergeParentFilesByHash.set(parentHash, result.files || []);
        persistState();
        render();
      });
      vscode.postMessage({ type: 'getMergeParentFiles', hash: __d.hash, parentHash, requestId });
    }

    // ── Speed search ──
    const speedSearchWidget = document.getElementById('speedSearchWidget');
    const speedSearchInput = document.getElementById('speedSearchInput');
    const speedSearchCount = document.getElementById('speedSearchCount');
    const speedSearchPrevBtn = document.getElementById('speedSearchPrev');
    const speedSearchNextBtn = document.getElementById('speedSearchNext');
    const speedSearchCloseBtn = document.getElementById('speedSearchClose');

    let speedSearchOpen = false;
    let speedSearchQuery = '';
    let speedSearchMatches = [];
    let speedSearchActiveIndex = -1;
    let speedSearchActiveKey = null;
    let speedSearchSnapshot = null;

    function getMatchSegments(text, query) {
      if (!query) return [{ text, isMatch: false }];
      const lowerText = text.toLowerCase();
      const lowerQuery = query.toLowerCase();
      const segments = [];
      let lastIndex = 0;
      let matchIndex = lowerText.indexOf(lowerQuery, lastIndex);
      while (matchIndex !== -1) {
        if (matchIndex > lastIndex) {
          segments.push({ text: text.slice(lastIndex, matchIndex), isMatch: false });
        }
        segments.push({ text: text.slice(matchIndex, matchIndex + lowerQuery.length), isMatch: true });
        lastIndex = matchIndex + lowerQuery.length;
        matchIndex = lowerText.indexOf(lowerQuery, lastIndex);
      }
      if (lastIndex < text.length) {
        segments.push({ text: text.slice(lastIndex), isMatch: false });
      }
      return segments;
    }

    function highlightText(text, query) {
      if (!query) return escText(text);
      const segments = getMatchSegments(text, query);
      return segments.map(seg => {
        if (seg.isMatch) {
          return '<mark class="speed-search-highlight">' + escText(seg.text) + '</mark>';
        }
        return escText(seg.text);
      }).join('');
    }

    function matchSpeedSearchItem(filePath, query) {
      if (!query) return false;
      const trimmed = query.trim();
      if (!trimmed) return false;
      const normalizedQuery = trimmed.toLowerCase();
      const normalizedPath = filePath.toLowerCase();
      const fileName = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
      const normalizedFileName = fileName.toLowerCase();

      if (normalizedQuery.includes('/')) {
        return normalizedPath.includes(normalizedQuery);
      }
      if (normalizedFileName.includes(normalizedQuery)) {
        return true;
      }
      return normalizedPath.includes(normalizedQuery);
    }

    function getAllSearchableFiles() {
      const items = [];
      for (const f of FILES) {
        const rowKey = (f.repoId ? f.repoId + ':' : '') + f.path;
        items.push({
          id: rowKey,
          label: f.path.includes('/') ? f.path.split('/').pop() : f.path,
          path: f.path,
          repoId: f.repoId || __d.repoId,
          repoName: f.repoName || __d.repoName,
          repoColor: f.repoColor || __d.repoColor,
          fromHash: null,
        });
      }
      for (const parent of MERGE_PARENT_CHANGES) {
        if (expandedMergeParentHashes.has(parent.hash)) {
          const pFiles = mergeParentFiles(parent);
          if (pFiles) {
            for (const f of pFiles) {
              const rowKey = parent.hash + ':' + (f.repoId ? f.repoId + ':' : '') + f.path;
              items.push({
                id: rowKey,
                label: f.path.includes('/') ? f.path.split('/').pop() : f.path,
                path: f.path,
                repoId: f.repoId || __d.repoId,
                repoName: f.repoName || __d.repoName,
                repoColor: f.repoColor || __d.repoColor,
                fromHash: parent.hash,
              });
            }
          }
        }
      }
      return items;
    }

    function expandAncestorsForFile(item) {
      const groupByRepo = __d.showRepoGrouping;
      const scopePrefix = item.fromHash ? 'merge-parent-' + item.fromHash + ':' : '';
      const parts = groupByRepo ? [item.repoName || __d.repoName, ...item.path.split('/')] : item.path.split('/');
      let acc = '';
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        const isRepoRoot = groupByRepo && i === 0;
        acc = acc ? acc + '/' + p : p;
        const key = scopePrefix + (isRepoRoot ? ((item.repoId || __d.repoId) + ':' + p) : ((item.repoId || __d.repoId) + ':' + acc));
        dirOpen.set(key, true);
      }
    }

    function updateSpeedSearch() {
      const query = speedSearchQuery.trim();
      const allFiles = getAllSearchableFiles();
      if (!query) {
        speedSearchMatches = [];
        speedSearchActiveIndex = -1;
        speedSearchActiveKey = null;
        speedSearchCount.textContent = '0/0';
        if (speedSearchSnapshot) {
          dirOpen.clear();
          for (const [k, v] of speedSearchSnapshot) dirOpen.set(k, v);
          speedSearchSnapshot = null;
        }
        render();
        return;
      }

      if (!speedSearchSnapshot) {
        speedSearchSnapshot = new Map(dirOpen);
      }

      const matches = [];
      for (const item of allFiles) {
        if (matchSpeedSearchItem(item.path, query)) {
          matches.push(item);
        }
      }
      speedSearchMatches = matches;

      if (matches.length > 0) {
        for (const item of matches) {
          expandAncestorsForFile(item);
        }
        let nextIndex = 0;
        if (speedSearchActiveKey) {
          const found = matches.findIndex(m => m.id === speedSearchActiveKey);
          if (found !== -1) nextIndex = found;
        }
        speedSearchActiveIndex = nextIndex;
        speedSearchActiveKey = matches[nextIndex].id;
        speedSearchCount.textContent = (nextIndex + 1) + '/' + matches.length;
      } else {
        speedSearchActiveIndex = -1;
        speedSearchActiveKey = null;
        speedSearchCount.textContent = '0/0';
      }

      render();
      if (speedSearchActiveKey) {
        scrollToActiveMatch(speedSearchActiveKey);
      }
    }

    function scrollToActiveMatch(key) {
      document.querySelectorAll('.file-row.speed-search-active').forEach(el => el.classList.remove('speed-search-active'));
      if (!key) return;
      const row = document.querySelector('.file-row[data-search-key="' + CSS.escape(key) + '"]');
      if (row) {
        row.classList.add('speed-search-active');
        row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    function speedSearchNext() {
      if (speedSearchMatches.length === 0) return;
      const nextIndex = (speedSearchActiveIndex + 1) % speedSearchMatches.length;
      speedSearchActiveIndex = nextIndex;
      speedSearchActiveKey = speedSearchMatches[nextIndex].id;
      speedSearchCount.textContent = (nextIndex + 1) + '/' + speedSearchMatches.length;
      scrollToActiveMatch(speedSearchActiveKey);
    }

    function speedSearchPrev() {
      if (speedSearchMatches.length === 0) return;
      const prevIndex = (speedSearchActiveIndex - 1 + speedSearchMatches.length) % speedSearchMatches.length;
      speedSearchActiveIndex = prevIndex;
      speedSearchActiveKey = speedSearchMatches[prevIndex].id;
      speedSearchCount.textContent = (prevIndex + 1) + '/' + speedSearchMatches.length;
      scrollToActiveMatch(speedSearchActiveKey);
    }

    function openSpeedSearch(initialChar) {
      speedSearchOpen = true;
      speedSearchWidget.style.display = 'flex';
      if (initialChar !== undefined) {
        speedSearchInput.value = initialChar;
        speedSearchQuery = initialChar;
        updateSpeedSearch();
      } else {
        speedSearchInput.select();
      }
      speedSearchInput.focus();
    }

    function closeSpeedSearch() {
      speedSearchOpen = false;
      speedSearchWidget.style.display = 'none';
      speedSearchInput.value = '';
      speedSearchQuery = '';
      updateSpeedSearch();
    }

    // ── Tree rendering ──
    function renderTreeNode(node, depth, buf) {
      if (node.file) {
        const f = node.file;
        const status = normalizeStatus(f.status);
        const col = statusColor(status);
        const rowKey = (f.fromHash ? f.fromHash + ':' : '') + (f.repoId ? f.repoId + ':' : '') + f.path;
        const isActive = speedSearchActiveKey === rowKey;
        buf.push(
          '<div class="file-row' + (isActive ? ' speed-search-active' : '') + '"' + fileDatasetAttrs(f, status) + ' data-search-key="' + escAttr(rowKey) + '" title="' + escAttr(f.path) + '\\n' + escAttr(t('Click to open diff')) + '">' +
          '<div class="row-indent" style="width:' + (depth * 14 + 18) + 'px"></div>' +
          fileIconHtml(node.name) +
          '<span class="row-name" style="color:' + col + '">' + highlightText(node.name, speedSearchQuery) + '</span>' +
          '<span class="row-tail">' +
          statsHtml(f) +
          '<span class="row-status" style="color:' + col + '">' + escText(status) + '</span>' +
          '</span>' +
          '</div>'
        );
        return;
      }
      const open = isDirOpen(node.fullPath);
      if (node.isRepoRoot) {
        buf.push(
          '<div class="dir-row" data-dir="' + escAttr(node.fullPath) + '">' +
          '<div class="row-indent" style="width:0px"></div>' +
          '<span class="codicon ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="font-size:10px;width:14px;flex-shrink:0;"></span>' +
          '<span style="width:8px;height:8px;border-radius:50%;background:color-mix(in srgb, ' + escAttr(node.repoColor || __d.repoColor || '#4ec9b0') + ' 70%, var(--vscode-foreground));flex-shrink:0;"></span>' +
          '<span class="dir-name" style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">' + highlightText(node.name, speedSearchQuery) + '</span>' +
          '<span class="dir-badge">' + node.fileCount + '</span>' +
          '</div>'
        );
      } else {
        const folderBase = node.name.includes('/') ? node.name.split('/').pop() : node.name;
        buf.push(
          '<div class="dir-row" data-dir="' + escAttr(node.fullPath) + '">' +
          '<div class="row-indent" style="width:' + (depth * 14) + 'px"></div>' +
          '<span class="codicon ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="font-size:10px;width:14px;flex-shrink:0;"></span>' +
          folderIconHtml(folderBase, open) +
          '<span class="dir-name">' + highlightText(node.name, speedSearchQuery) + '</span>' +
          '<span class="dir-badge">' + node.fileCount + '</span>' +
          '</div>'
        );
      }
      if (open) {
        const sorted = Array.from(node.children.values()).sort((a, b) => {
          if (!a.file && b.file) return -1;
          if (a.file && !b.file) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const child of sorted) renderTreeNode(child, depth + 1, buf);
      }
    }

    function renderFlat(files = FILES, isMergeParent = false) {
      const buf = [];
      for (const f of files) {
        const status = normalizeStatus(f.status);
        const col  = statusColor(status);
        const name = f.path.includes('/') ? f.path.split('/').pop() : f.path;
        const dir  = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        const rowKey = (f.fromHash ? f.fromHash + ':' : '') + (f.repoId ? f.repoId + ':' : '') + f.path;
        const isActive = speedSearchActiveKey === rowKey;
        buf.push(
          '<div class="file-row' + (isActive ? ' speed-search-active' : '') + '"' + fileDatasetAttrs(f, status) + ' data-search-key="' + escAttr(rowKey) + '" title="' + escAttr(f.path) + '\\n' + escAttr(t('Click to open diff')) + '">' +
          '<div class="row-indent" style="width:' + (isMergeParent ? 18 : 4) + 'px"></div>' +
          fileIconHtml(name) +
          '<span class="row-name" style="color:' + col + '">' + highlightText(name, speedSearchQuery) + '</span>' +
          (dir ? '<span class="row-dir">' + highlightText(dir, speedSearchQuery) + '</span>' : '') +
          '<span class="row-tail">' +
          statsHtml(f) +
          '<span class="row-status" style="color:' + col + '">' + escText(status) + '</span>' +
          '</span>' +
          '</div>'
        );
      }
      return buf.join('');
    }

    function renderMergeParentGroup(parent) {
      const expanded = expandedMergeParentHashes.has(parent.hash);
      const files = mergeParentFiles(parent);
      const loading = loadingMergeParentHashes.has(parent.hash);
      const buf = [
        '<div class="merge-parent-group">',
        '<div class="merge-parent-row' + (expanded ? ' active' : '') + '" data-parent-hash="' + escAttr(parent.hash) + '" title="' + escAttr(parent.hash + '\\n' + (parent.message || '')) + '">',
        '<span class="codicon codicon-' + (expanded ? 'chevron-down' : 'chevron-right') + ' merge-parent-chevron"></span>',
        '<span class="codicon codicon-git-commit merge-parent-commit-icon"></span>',
        '<span class="merge-parent-title">' + escText(t('Changes from {0}', parent.shortHash)) + '</span>',
        parent.message ? '<span class="merge-parent-message">' + escText(parent.message) + '</span>' : '',
        '<span class="merge-parent-count">' + escText(formatFileCount(parent.fileCount)) + '</span>',
        '</div>',
      ];
      if (expanded) {
        buf.push('<div class="merge-parent-files">');
        if (loading || files === undefined) {
          buf.push('<div class="merge-parent-loading">' + escText(t('Loading files...')) + '</div>');
        } else if (files.length === 0) {
          buf.push('<div class="merge-parent-loading">' + escText(t('No changed files')) + '</div>');
        } else if (viewMode === 'flat') {
          buf.push(renderFlat(files, true));
        } else {
          const tree = buildTree(files, 'merge-parent-' + parent.hash, false);
          const treeBuf = [];
          const sorted = Array.from(tree.children.values()).sort((a, b) => {
            if (!a.file && b.file) return -1;
            if (a.file && !b.file) return 1;
            return a.name.localeCompare(b.name);
          });
          for (const child of sorted) renderTreeNode(collapseDirs(child), 1, treeBuf);
          buf.push(treeBuf.join(''));
        }
        buf.push('</div>');
      }
      buf.push('</div>');
      return buf.join('');
    }

    function render() {
      const listEl = document.getElementById('fileList');
      const fileCountEl = document.getElementById('fileCount');
      const btnExpandAll    = document.getElementById('btnExpandAll');
      const btnCollapseAll  = document.getElementById('btnCollapseAll');
      fileCountEl.textContent = formatFileCount(FILES.length);
      const buf = [];
      if (FILES.length === 0 && __d.parents && __d.parents.length >= 2) {
        buf.push('<div class="no-merge-conflicts">' + escText(t('No merge conflicts')) + '</div>');
      }
      if (viewMode === 'flat') {
        buf.push(renderFlat(FILES));
        btnExpandAll.style.display   = 'none';
        btnCollapseAll.style.display = 'none';
      } else {
        const tree = buildTree(FILES);
        const root = tree;
        const sorted = Array.from(root.children.values()).sort((a, b) => {
          if (!a.file && b.file) return -1;
          if (a.file && !b.file) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const child of sorted) renderTreeNode(collapseDirs(child), 0, buf);
        btnExpandAll.style.display   = '';
        btnCollapseAll.style.display = '';
      }
      for (const parent of MERGE_PARENT_CHANGES) buf.push(renderMergeParentGroup(parent));
      listEl.innerHTML = buf.join('');
      if (speedSearchActiveKey) {
        requestAnimationFrame(() => {
          scrollToActiveMatch(speedSearchActiveKey);
        });
      }
    }

    // ── Event delegation on file list ──
    const listEl = document.getElementById('fileList');
    listEl.addEventListener('click', e => {
      const parentRow = e.target.closest('.merge-parent-row');
      const dirRow  = e.target.closest('.dir-row');
      const fileRow = e.target.closest('.file-row');
      if (parentRow) { toggleMergeParent(parentRow.dataset.parentHash); return; }
      if (dirRow)  { toggleDir(dirRow.dataset.dir); return; }
      if (fileRow) { vscode.postMessage({ type: 'openDiff', filePath: fileRow.dataset.path, fileStatus: fileRow.dataset.status, repoId: fileRow.dataset.repoId, hash: fileRow.dataset.hash, fromHash: fileRow.dataset.fromHash, toHash: fileRow.dataset.toHash }); }
    });
    listEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      const row = e.target.closest('.file-row');
      if (!row) return;
      document.querySelectorAll('.file-row.ctx-active').forEach(el => el.classList.remove('ctx-active'));
      row.classList.add('ctx-active');
      showCtx(e.clientX, e.clientY, row);
    });

    // ── Toolbar buttons ──
    document.getElementById('btnTree').addEventListener('click', () => {
      viewMode = 'tree'; forceAll = null;
      document.getElementById('btnTree').classList.add('active');
      document.getElementById('btnFlat').classList.remove('active');
      persistState();
      render();
    });
    document.getElementById('btnFlat').addEventListener('click', () => {
      viewMode = 'flat';
      document.getElementById('btnFlat').classList.add('active');
      document.getElementById('btnTree').classList.remove('active');
      persistState();
      render();
    });
    document.getElementById('btnExpandAll').addEventListener('click', () => {
      forceAll = true; render();
    });
    document.getElementById('btnCollapseAll').addEventListener('click', () => {
      forceAll = false; render();
    });

    // ── Initial render ──
    if (viewMode === 'flat') {
      document.getElementById('btnFlat')?.classList.add('active');
      document.getElementById('btnTree')?.classList.remove('active');
    }
    render();

    // ── Speed search events ──
    speedSearchInput.addEventListener('input', e => {
      speedSearchQuery = e.target.value;
      updateSpeedSearch();
    });
    speedSearchPrevBtn.addEventListener('click', speedSearchPrev);
    speedSearchNextBtn.addEventListener('click', speedSearchNext);
    speedSearchCloseBtn.addEventListener('click', closeSpeedSearch);

    window.addEventListener('keydown', e => {
      const isFindShortcut =
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        (e.key === 'f' || e.key === 'F' || e.code === 'KeyF');

      if (isFindShortcut) {
        e.preventDefault();
        e.stopPropagation();
        openSpeedSearch();
        return;
      }

      if (e.isComposing || e.defaultPrevented) return;

      const isInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable;
      if (isInput) {
        if (e.target === speedSearchInput) {
          if (e.key === 'Escape') {
            e.preventDefault();
            closeSpeedSearch();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            if (e.shiftKey) speedSearchPrev();
            else speedSearchNext();
          } else if (e.key === 'ArrowDown') {
            e.preventDefault();
            speedSearchNext();
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            speedSearchPrev();
          }
        }
        return;
      }

      if (e.target.tagName === 'BUTTON' && (e.key === ' ' || e.key === 'Enter')) {
        return;
      }

      if (!ctxMenu.classList.contains('hidden')) {
        return;
      }

      if (e.key === 'Escape' && speedSearchOpen) {
        e.preventDefault();
        closeSpeedSearch();
        return;
      }

      if (speedSearchOpen) {
        if (e.key === 'ArrowDown' || e.key === 'Enter') {
          e.preventDefault();
          if (e.shiftKey && e.key === 'Enter') speedSearchPrev();
          else speedSearchNext();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          speedSearchPrev();
          return;
        }
      }

      if (!e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== ' ') {
        e.preventDefault();
        openSpeedSearch(e.key);
      }
    }, true);

    // ── Author avatars (Host AvatarService integration + fallback) ──
    try {
      (function() {
        const avatarElements = Array.from(document.querySelectorAll('[data-author-avatar]'));

        // Listen for host resolved avatars
        window.addEventListener('message', function(event) {
          const msg = event.data;
          if (msg && msg.type === 'avatarsResolved' && msg.avatars) {
            avatarElements.forEach(function(avatarEl) {
              if (avatarEl.querySelector('img')) return;
              const email = (avatarEl.dataset.authorEmail || '').trim().toLowerCase();
              const url = msg.avatars[email];
              if (url) {
                const size = Number(avatarEl.dataset.avatarSize || '20');
                const authorName = avatarEl.dataset.authorName || '';
                const img = document.createElement('img');
                img.src = url;
                img.alt = authorName;
                img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;object-fit:cover;display:block;';
                img.onerror = function() {
                  img.remove();
                  avatarEl.textContent = avatarEl.dataset.authorInitials || '';
                };
                avatarEl.textContent = '';
                avatarEl.appendChild(img);
              }
            });
          }
        });

        // Request resolution for pending avatars from host
        const pendingEmails = [];
        const pendingAuthors = [];
        avatarElements.forEach(function(el) {
          if (!el.querySelector('img') && el.dataset.authorEmail) {
            const em = el.dataset.authorEmail.trim().toLowerCase();
            if (!pendingEmails.includes(em)) {
              pendingEmails.push(em);
              pendingAuthors.push({ email: em, name: el.dataset.authorName || '' });
            }
          }
        });
        if (pendingEmails.length > 0) {
          vscode.postMessage({ type: 'resolveAvatars', emails: pendingEmails, authors: pendingAuthors });
        }
      })();
    } catch (_) {}

    // ── Branch / tag badges — runs after render, isolated ──
    try {
      const PAL_D = [
        '#6aaed0', '#cc6a9a', '#6ab86a', '#cc7070',
        '#8c70cc', '#cc7a50', '#4aaa9a', '#cc8060',
        '#a0cc6a', '#6a8ecc', '#cc6ab0', '#7acc80',
        '#cc6060', '#6accc0', '#b870cc', '#6ab0d0',
      ];
      const PAL_L = [
        '#2e6898', '#962860', '#2a7828', '#963232',
        '#4a2e96', '#963818', '#1a7a6a', '#964018',
        '#587818', '#2a4e98', '#962878', '#2a7840',
        '#982020', '#287878', '#6a2496', '#2a6890',
      ];
      const PRIM  = ['main','master','develop','dev','trunk','release'];
      const dark  = () => document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
      function normB(n) {
        if (n.startsWith('refs/heads/')) return n.slice('refs/heads/'.length);
        if (n.startsWith('refs/remotes/')) {
          const remoteRef = n.slice('refs/remotes/'.length);
          const slash = remoteRef.indexOf('/');
          return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
        }
        return n;
      }
      function parseC(raw) {
        const s = raw.trim();
        const hex = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
        if (hex) return [parseInt(hex[1],16),parseInt(hex[2],16),parseInt(hex[3],16)];
        const rgb = /^rgba?\\(\\s*(\\d+)\\s*,\\s*(\\d+)\\s*,\\s*(\\d+)/i.exec(s);
        return rgb ? [parseInt(rgb[1],10),parseInt(rgb[2],10),parseInt(rgb[3],10)] : null;
      }
      function lum(r,g,b) {
        const c = v => { const n=v/255; return n<=0.03928?n/12.92:Math.pow((n+0.055)/1.055,2.4); };
        return 0.2126*c(r)+0.7152*c(g)+0.0722*c(b);
      }
      function toHex(r,g,b) { return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join(''); }
      function darken(raw,threshold) {
        const rgb=parseC(raw); if(!rgb) return raw;
        let [r,g,b]=rgb; let l=lum(r,g,b);
        while(l>threshold){ r=Math.round(r*0.82);g=Math.round(g*0.82);b=Math.round(g*0.82);l=lum(r,g,b); }
        return toHex(r,g,b);
      }
      function lighten(raw,threshold) {
        const rgb=parseC(raw); if(!rgb) return raw;
        let [r,g,b]=rgb; let l=lum(r,g,b);
        while(l<threshold){
          r=Math.min(255,Math.round(r*1.15+8));g=Math.min(255,Math.round(g*1.15+8));b=Math.min(255,Math.round(g*1.15+8));
          const next=lum(r,g,b); if(next===l) break; l=next;
        }
        return toHex(r,g,b);
      }
      function primaryColor() {
        const raw = getComputedStyle(document.body).getPropertyValue('--vscode-button-background').trim() || '#0078d4';
        return dark() ? lighten(raw,0.28) : darken(raw,0.22);
      }
      function hashB(n) { let h=0; const s=normB(n); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h%PAL_D.length; }
      function bColor(n) {
        if (PRIM.includes(normB(n).toLowerCase())) return primaryColor();
        return (dark() ? PAL_D : PAL_L)[hashB(n)];
      }
      const tColor = () => dark() ? '#909090' : '#707070';
      const hColor = () => dark() ? '#c9a84c' : '#8a6914';

      function primaryBranchRank(name) {
        const lower = normB(name).toLowerCase();
        if (lower === 'main' || lower === 'master' || lower === 'trunk') return 1;
        if (lower === 'develop' || lower === 'dev' || lower === 'release') return 2;
        return 3;
      }
      function compareBranches(a, b) {
        const rankA = primaryBranchRank(a.name);
        const rankB = primaryBranchRank(b.name);
        if (rankA !== rankB) return rankA - rankB;
        const fullA = a.remote ? (a.remote + '/' + a.name) : a.name;
        const fullB = b.remote ? (b.remote + '/' + b.name) : b.name;
        return fullA.localeCompare(fullB);
      }

      function normalizeBranches(branchesInput) {
        if (!branchesInput) return [];
        const isPrimary = n => PRIM.includes(normB(n).toLowerCase());
        let items = [];
        let hasHead = false;
        if (Array.isArray(branchesInput)) {
          items = branchesInput;
          hasHead = branchesInput.some(b => b.type === 'head' || (b.name && b.name.toUpperCase() === 'HEAD'));
        } else if (typeof branchesInput === 'object') {
          hasHead = Boolean(branchesInput.isHead) || (branchesInput.local || []).some(n => n.toUpperCase() === 'HEAD');
          for (const name of branchesInput.local || []) items.push({ type: 'local', name, remote: '' });
          for (const remoteBranch of branchesInput.remote || []) {
            const slash = remoteBranch.indexOf('/');
            const remote = slash >= 0 ? remoteBranch.slice(0, slash) : '';
            const name = slash >= 0 ? remoteBranch.slice(slash + 1) : remoteBranch;
            items.push({ type: 'remote', name, remote });
          }
          for (const name of branchesInput.tags || []) items.push({ type: 'tag', name, remote: '' });
        }

        const validItems = items.filter(b => b.type !== 'head' && !(b.type === 'remote' && b.name.toUpperCase() === 'HEAD') && !(b.type === 'local' && b.name.toUpperCase() === 'HEAD'));

        const localPrimary = validItems
          .filter(b => b.type === 'local' && isPrimary(b.name))
          .sort(compareBranches);
        const localOther = validItems
          .filter(b => b.type === 'local' && !isPrimary(b.name))
          .sort(compareBranches);
        const remotePrimary = validItems
          .filter(b => b.type === 'remote' && isPrimary(b.name))
          .sort(compareBranches);
        const remoteOther = validItems
          .filter(b => b.type === 'remote' && !isPrimary(b.name))
          .sort(compareBranches);
        const sortedTags = validItems
          .filter(b => b.type === 'tag')
          .sort((a, b) => a.name.localeCompare(b.name));

        const result = [];
        if (hasHead) {
          result.push({ type: 'head', name: 'HEAD', remote: '' });
        }
        result.push(...localPrimary, ...localOther, ...remotePrimary, ...remoteOther, ...sortedTags);
        return result;
      }

      function appendBranchBadges(refsRow, branches) {
        if (!refsRow) return;
        refsRow.innerHTML = '';
        for (const b of branches) {
          if (b.type === 'remote' && b.name.toUpperCase() === 'HEAD') continue;
          const isHead = b.name.toUpperCase() === 'HEAD';
          const color = b.type === 'tag' ? tColor() : isHead ? hColor() : bColor(b.name);
          const icon  = b.type === 'tag' ? 'tag' : isHead ? 'arrow-right' : b.type === 'remote' ? 'cloud' : 'git-branch';
          const label = b.type === 'remote' && b.remote ? b.remote + '/' + b.name : b.name;
          const sp = document.createElement('span');
          sp.title = b.type === 'tag'
            ? t('Tag: {0}', label)
            : b.type === 'remote'
              ? t('Remote: {0}', label)
              : isHead
                ? t('HEAD')
                : t('Local: {0}', label);
          sp.style.cssText = 'font-size:10px;padding:0 6px;height:16px;line-height:16px;border-radius:3px;display:inline-flex;align-items:center;gap:3px;background:' + color + '33;color:' + color + ';border:1px solid ' + color + '88;max-width:160px;overflow:hidden;white-space:nowrap;flex-shrink:0;box-sizing:border-box;font-weight:500;margin:2px;';
          sp.innerHTML = '<span class="codicon codicon-' + icon + '" style="font-size:10px;flex-shrink:0;line-height:1"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">' + escText(label) + '</span>';
          refsRow.appendChild(sp);
        }
      }

      const refsRow = document.getElementById('refsRow');
      if (refsRow) appendBranchBadges(refsRow, normalizeBranches(__d.branches));

      document.querySelectorAll('[data-commit-refs]').forEach(commitRefsRow => {
        const repoId = commitRefsRow.dataset.commitRepoId || '';
        const hash = commitRefsRow.dataset.commitHash || '';
        const commit = (__d.commits || []).find(item => item.repoId === repoId && item.hash === hash);
        if (commit) appendBranchBadges(commitRefsRow, normalizeBranches(commit.branches));
      });
    } catch(e) { /* badges are optional */ }

    // ── Revert feedback & density update ──
    window.addEventListener('message', e => {
      if (e.data?.type === 'revertDone') {
        const row = document.querySelector('[data-path="' + CSS.escape(e.data.filePath) + '"]');
        if (row) { row.style.opacity = '0.4'; }
      } else if (e.data?.type === 'LAYOUT_DENSITY_UPDATE') {
        document.body.setAttribute('data-density', e.data.layoutDensity);
      }
    });
  </script>
</body>
</html>`;
}
