import * as vscode from 'vscode';
import { generateNonce } from '../utils/webviewHtml';
import { loadIconTheme, type IconThemeData } from '../utils/IconThemeService';
import { getWebviewI18nPayload, t, type WebviewI18nPayload } from '../utils/l10n';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { toGitUri } from '../utils/resourceUri';
import { assertNoSymlinkAncestors } from '../utils/repoPath';
import { scopedKey } from '../utils/scopedKey';
import type { AiCommitExplanationService } from '../aiCommitExplanation/AiCommitExplanationService';
import { buildCommitExplanationContext } from '../aiCommitExplanation/buildCommitExplanationContext';
import type { CommitExplanationCommit, CommitExplanationFile } from '../aiCommitExplanation/types';
import type { VersionDockLogger } from '../utils/Logger';

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
};

export async function openCommitDetailPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  aiCommitExplanationService: AiCommitExplanationService,
  logger: VersionDockLogger,
  repoId: string,
  hash: string,
  autoExplain = false,
): Promise<void> {
  const repo = manager.getRepo(repoId);
  if (!repo) {
    vscode.window.showErrorMessage(t('VersionDock: Repository not found.'));
    return;
  }

  let commitInfo: Awaited<ReturnType<typeof repo.getCommitMeta>> | null = null;
  let files: Array<{ path: string; status: string; added?: number; removed?: number }> = [];
  let fullMessage = '';
  let branches: { local: string[]; remote: string[]; tags: string[] } = { local: [], remote: [], tags: [] };

  try {
    [fullMessage, commitInfo] = await Promise.all([
      repo.getFullCommitMessage(hash),
      repo.getCommitMeta(hash),
    ]);
    commitInfo ??= { hash, shortHash: hash.slice(0, 7), message: '', authorName: '', authorEmail: '', authorDate: '', committerDate: '', parents: [] };
    [files, branches] = await Promise.all([
      repo.getCommitFiles(hash, commitInfo.parents),
      repo.getBranchesContaining(hash).catch(() => ({ local: [], remote: [], tags: [] })),
    ]);
  } catch (e: unknown) {
    vscode.window.showErrorMessage(t('VersionDock: Failed to load commit details: {0}', String(e)));
    return;
  }

  const repoMeta = manager.getRepoMetas().find(r => r.id === repoId);
  const repoName = repoMeta?.name ?? repoId;
  const repoColor = repoMeta?.color ?? '#4ec9b0';
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
    `img-src ${panel.webview.cspSource} https://gravatar.com https://avatars.githubusercontent.com data:`,
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

  panel.webview.html = getHtml(nonce, csp, codiconUri, {
    repoName, repoId, hash,
    repoColor,
    repoKind: repo.kind,
    showRepoGrouping,
    mode: 'single',
    autoExplain,
    i18n,
    iconTheme,
    shortHash: commitInfo.shortHash,
    message: commitInfo.message,
    fullMessage: fullMessage.trim(),
    authorName: commitInfo.authorName,
    authorEmail: commitInfo.authorEmail,
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
    branches,
  });

  panel.webview.onDidReceiveMessage(async (msg: { type: string; filePath?: string; fileStatus?: string; repoId?: string; hash?: string; fromHash?: string; toHash?: string; parents?: string[]; requestId?: string }) => {
    if (msg.type === 'getMergeCommits' && msg.hash && msg.parents && msg.requestId) {
      try {
        const commits = await repo.getMergeCommits(msg.hash, msg.parents);
        panel.webview.postMessage({ type: 'mergeCommitsResult', requestId: msg.requestId, commits });
      } catch {
        panel.webview.postMessage({ type: 'mergeCommitsResult', requestId: msg.requestId, commits: [] });
      }
      return;
    }
    if (msg.type === 'getMergeFiles' && msg.hash && msg.requestId) {
      try {
        const mergeFiles = await repo.getCommitFiles(msg.hash);
        panel.webview.postMessage({ type: 'mergeFilesResult', requestId: msg.requestId, files: mergeFiles });
      } catch {
        panel.webview.postMessage({ type: 'mergeFilesResult', requestId: msg.requestId, files: [] });
      }
      return;
    }
    if (msg.type === 'openDiff' && msg.filePath) {
      try {
        const pathMod = await import('path');
        const status = msg.fileStatus ?? 'M';
        const diffHash = msg.hash ?? hash; // support merge commit files
        const fileName = pathMod.basename(msg.filePath);
        const title = status === 'A'
          ? t('{0} (added in {1})', fileName, diffHash.slice(0, 7))
          : status === 'D'
            ? t('{0} (deleted in {1})', fileName, diffHash.slice(0, 7))
            : t('{0} ({1})', fileName, diffHash.slice(0, 7));
        if (msg.fromHash && msg.toHash) {
          await openCommitRangeFileDiff(repo, msg.fromHash, msg.toHash, msg.filePath, status, title);
        } else {
          await openCommitFileDiff(repo, diffHash, msg.filePath, status, title);
        }
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Cannot open diff: {0}', String(e)));
      }
    } else if (msg.type === 'openFile' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(repo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('vscode.open', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Cannot open file: {0}', String(e)));
      }
    } else if (msg.type === 'revealInExplorer' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(repo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('revealInExplorer', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Cannot open file: {0}', String(e)));
      }
    } else if (msg.type === 'revealInOS' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(repo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('revealFileInOS', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Cannot open file: {0}', String(e)));
      }
    } else if (msg.type === 'revertFile' && msg.filePath) {
      if (repo.kind === 'svn') {
        vscode.window.showWarningMessage(t('VersionDock: Revert Selected Changes is not supported for SVN commit detail.'));
        return;
      }
      try {
        const resolvedPath = repo.resolveRepoPath(msg.filePath);
        const confirmed = await vscode.window.showWarningMessage(
          t('Revert changes to "{0}" from commit {1}?', resolvedPath.relativePath, commitInfo!.shortHash),
          { modal: true }, t('Revert')
        );
        if (confirmed !== t('Revert')) return;
        if (msg.fileStatus === 'A') {
          assertNoSymlinkAncestors(repo.rootPath, resolvedPath.absolutePath);
          await vscode.workspace.fs.delete(vscode.Uri.file(resolvedPath.absolutePath), { useTrash: false });
        } else {
          await repo.revertFileToParent(hash, resolvedPath.relativePath);
        }
        vscode.window.showInformationMessage(t('VersionDock: Reverted "{0}".', resolvedPath.relativePath));
        panel.webview.postMessage({ type: 'revertDone', filePath: resolvedPath.relativePath });
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Revert failed: {0}', String(e)));
      }
    }
  });
}

export async function openAggregatedCommitDetailPanel(
  extensionUri: vscode.Uri,
  manager: WorkspaceGitManager,
  aiCommitExplanationService: AiCommitExplanationService,
  logger: VersionDockLogger,
  commits: Array<{ repoId: string; hash: string }>,
  autoExplain = false,
): Promise<void> {
  if (commits.length === 0) return;

  const repoMetas = manager.getRepoMetas();
  const repoMetaById = new Map(repoMetas.map(repo => [repo.id, repo]));
  const commitSummaries: CommitSummary[] = [];
  const fileEntries: CommitDetailFile[] = [];

  try {
    for (const selection of commits) {
      const repo = manager.getRepo(selection.repoId);
      if (!repo) continue;
      const [commitInfo, fullMessage, branches] = await Promise.all([
        repo.getCommitMeta(selection.hash),
        repo.getFullCommitMessage(selection.hash),
        repo.getBranchesContaining(selection.hash).catch(() => ({ local: [], remote: [], tags: [] })),
      ]);
      const repoMeta = repoMetaById.get(selection.repoId);
      const repoName = repoMeta?.name ?? selection.repoId;
      const repoColor = repoMeta?.color ?? '#4ec9b0';
      const files = await repo.getCommitFiles(selection.hash, commitInfo.parents);
      commitSummaries.push({
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
      });
      fileEntries.push(...files.map(file => ({
        ...file,
        repoId: selection.repoId,
        repoName,
        repoColor,
        hash: selection.hash,
      })));
    }
  } catch (e: unknown) {
    vscode.window.showErrorMessage(t('VersionDock: Failed to load commit details: {0}', String(e)));
    return;
  }

  if (commitSummaries.length === 0) {
    vscode.window.showErrorMessage(t('VersionDock: Repository not found.'));
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
    t('Aggregated commit selection'),
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
    `img-src ${panel.webview.cspSource} https://gravatar.com https://avatars.githubusercontent.com data:`,
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

  panel.webview.html = getHtml(nonce, csp, codiconUri, {
    repoName: involvedRepoIds.length === 1 ? firstCommit.repoName : t('{0} repositories involved', involvedRepoIds.length),
    repoId: firstCommit.repoId,
    hash: commits.map(commit => commit.hash).join(','),
    repoColor: firstCommit.repoColor,
    repoKind: 'git',
    showRepoGrouping: repoMetas.length > 1 || involvedRepoIds.length > 1,
    mode: 'aggregate',
    autoExplain,
    i18n,
    iconTheme,
    shortHash: commitSummaries.length === 1 ? t('{0} commit selected', commitSummaries.length) : t('{0} commits selected', commitSummaries.length),
    message: t('Aggregated commit selection'),
    fullMessage: commitSummaries.map(commit => commit.fullMessage || commit.message).join('\n\n'),
    authorName: t('Aggregated commit selection'),
    authorEmail: '',
    authorDate: firstCommit.authorDate,
    committerDate: firstCommit.committerDate,
    parents: [],
    files: Array.from(aggregatedMap.values()),
    branches: { local: [], remote: [], tags: [] },
    commits: commitSummaries.map(({ repoRootPath: _repoRootPath, vcsKind: _vcsKind, files: _files, ...commit }) => commit),
    selectedTimeRange,
    involvedRepoCount: involvedRepoIds.length,
  });

  panel.webview.onDidReceiveMessage(async (msg: { type: string; filePath?: string; fileStatus?: string; repoId?: string; hash?: string; fromHash?: string; toHash?: string; requestId?: string }) => {
    const targetRepoId = msg.repoId ?? firstCommit.repoId;
    const targetRepo = manager.getRepo(targetRepoId);
    if (!targetRepo) return;
    if (msg.type === 'openDiff' && msg.filePath) {
      try {
        const pathMod = await import('path');
        const fileName = pathMod.basename(msg.filePath);
        const title = msg.fromHash && msg.toHash
          ? t('{0} ({1})', fileName, msg.toHash.slice(0, 7))
          : t('{0} ({1})', fileName, (msg.hash ?? firstCommit.hash).slice(0, 7));
        if (msg.fromHash && msg.toHash) {
          await openCommitRangeFileDiff(targetRepo, msg.fromHash, msg.toHash, msg.filePath, msg.fileStatus ?? 'M', title);
        } else {
          await openCommitFileDiff(targetRepo, msg.hash ?? firstCommit.hash, msg.filePath, msg.fileStatus ?? 'M', title);
        }
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Cannot open diff: {0}', String(e)));
      }
    } else if (msg.type === 'openFile' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(targetRepo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('vscode.open', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Cannot open file: {0}', String(e)));
      }
    } else if (msg.type === 'revealInExplorer' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(targetRepo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('revealInExplorer', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Cannot open file: {0}', String(e)));
      }
    } else if (msg.type === 'revealInOS' && msg.filePath) {
      try {
        const fileUri = vscode.Uri.file(targetRepo.resolveRepoPath(msg.filePath).absolutePath);
        vscode.commands.executeCommand('revealFileInOS', fileUri);
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock: Cannot open file: {0}', String(e)));
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

async function openCommitFileDiff(
  repo: CommitDetailRepo,
  diffHash: string,
  filePath: string,
  status: string,
  title: string,
): Promise<void> {
  const resolvedPath = repo.resolveRepoPath(filePath);
  const relativePath = resolvedPath.relativePath;
  if (repo.kind === 'svn') {
    const diff = await repo.getFileDiff(repo.repoId, diffHash, relativePath);
    if (!diff) {
      vscode.window.showInformationMessage(t('VersionDock: No SVN diff available for {0}.', relativePath));
      return;
    }
    const language = guessLanguageId(relativePath);
    const [leftDoc, rightDoc] = await Promise.all([
      vscode.workspace.openTextDocument({ language, content: diff.originalContent ?? '' }),
      vscode.workspace.openTextDocument({ language, content: diff.modifiedContent ?? '' }),
    ]);
    await vscode.commands.executeCommand('vscode.diff', leftDoc.uri, rightDoc.uri, title, { preview: true });
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
): Promise<void> {
  if (repo.kind === 'svn') {
    await openCommitFileDiff(repo, toHash, filePath, status, title);
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
  branches: { local: string[]; remote: string[]; tags: string[] };
  commits?: CommitSummaryView[];
  selectedTimeRange?: string;
  involvedRepoCount?: number;
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

function getHtml(nonce: string, csp: string, codiconUri: string, data: PanelData): string {
  // remote entries come in as "origin/feat" — split into remote + name
  const allBranches = [
    ...data.branches.local.map(b => ({ type: 'local',  name: b, remote: '' })),
    ...data.branches.remote.map(b => {
      const slash = b.indexOf('/');
      return slash >= 0
        ? { type: 'remote', name: b.slice(slash + 1), remote: b.slice(0, slash) }
        : { type: 'remote', name: b, remote: '' };
    }),
    ...data.branches.tags.map(b => ({ type: 'tag', name: b, remote: '' })),
  ];

  const authorInitials = getAuthorInitials(data.authorName);
  const fullMsgDisplay = data.fullMessage || data.message;
  const canRevert = data.mode !== 'aggregate' && data.repoKind !== 'svn';
  const aggregateRangeStart = data.commits?.[data.commits.length - 1]?.authorDate ?? '';
  const aggregateRangeEnd = data.commits?.[0]?.authorDate ?? '';
  const leftPanelContent = data.mode === 'aggregate' ? `
      <div>
        <div class="section-label">${escHtml(t('Details'))}</div>
        <div class="meta-grid">
          <span class="meta-key">${escHtml(t('Aggregated commit selection'))}</span>
          <span class="meta-val normal">${escHtml(data.commits?.length === 1 ? t('{0} commit selected', data.commits.length) : t('{0} commits selected', data.commits?.length ?? 0))}</span>
          <span class="meta-key">${escHtml(t('Repository'))}</span>
          <span class="meta-val normal">${escHtml(t('{0} repositories involved', data.involvedRepoCount ?? 0))}</span>
          <span class="meta-key">${escHtml(t('Selected time range'))}</span>
          <span class="meta-val normal" id="selectedTimeRange" data-range-start="${escHtml(aggregateRangeStart)}" data-range-end="${escHtml(aggregateRangeEnd)}">${escHtml(data.selectedTimeRange ?? '')}</span>
        </div>
      </div>
      <div>
        <div class="section-label">${escHtml(t('Aggregated commit selection'))}</div>
        <div class="commit-summary-list">
          ${(data.commits ?? []).map((commit, index, allCommits) => {
            const commitMessage = splitCommitMessage(commit.fullMessage, commit.message);
            const initials = getAuthorInitials(commit.authorName);
            return `
            <div class="commit-summary-item${index === allCommits.length - 1 ? ' last' : ''}">
              <div class="commit-summary-repo" style="color:${escHtml(commit.repoColor)}">
                <span class="codicon codicon-repo"></span>
                <span>${escHtml(commit.repoName)}</span>
              </div>
              <div class="commit-summary-card">
                <div class="commit-summary-message">${escHtml(commitMessage.subject)}</div>
                ${commitMessage.body ? `<pre class="commit-summary-body">${escHtml(commitMessage.body)}</pre>` : ''}
              </div>
              <div class="commit-summary-meta">
                <span class="commit-summary-avatar" data-author-avatar data-author-name="${escHtml(commit.authorName)}" data-author-email="${escHtml(commit.authorEmail)}" data-avatar-size="20" title="${escHtml(commit.authorName)} &lt;${escHtml(commit.authorEmail)}&gt;">${escHtml(initials)}</span>
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
          <div class="avatar" id="authorAvatar" data-author-avatar data-author-name="${escHtml(data.authorName)}" data-author-email="${escHtml(data.authorEmail)}" data-avatar-size="36" title="${escHtml(data.authorName)} &lt;${escHtml(data.authorEmail)}&gt;">${escHtml(authorInitials)}</div>
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

    /* ── Top toolbar ── */
    .toolbar {
      display: flex; align-items: center; gap: 8px;
      padding: 8px 16px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .toolbar-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px; opacity: 0.6;
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
      background-size: 100% 100%; background-position: 0 0;
      color: #ffffff; font: inherit; font-size: 12px; font-weight: 600;
      box-shadow: none; white-space: nowrap;
      transition: filter 140ms ease, transform 140ms ease, background-position 240ms ease;
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
      background-position: 100% 0;
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
      background-size: 220% 100%; opacity: 0.82;
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
    .ai-status { font-size: 11px; opacity: 0.62; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ai-live-dot {
      width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0;
      background: #58b6ff; box-shadow: 0 0 7px rgba(47,143,255,0.62); opacity: 0;
    }
    .ai-explanation[data-state="generating"] .ai-live-dot { opacity: 1; animation: aiDotPulse 1s ease-in-out infinite; }
    .ai-stages { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .ai-stage {
      position: relative; display: flex; align-items: center; gap: 5px;
      min-width: 0; color: var(--vscode-descriptionForeground); font-size: 10px; opacity: 0.48;
      transition: opacity 160ms ease, color 160ms ease;
    }
    .ai-stage::before {
      content: ''; width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0;
      background: var(--vscode-descriptionForeground); transition: transform 160ms ease, background 160ms ease;
    }
    .ai-stage.active { opacity: 1; color: var(--vscode-foreground); }
    .ai-stage.active::before { transform: scale(1.4); background: #7657ff; box-shadow: 0 0 6px rgba(118,87,255,0.58); }
    .ai-stage.done { opacity: 0.76; }
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
      .ai-explanation, .ai-explanation::before, .ai-orb::after, .ai-live-dot,
      .ai-explain-btn, .ai-explain-btn .codicon, .ai-explain-btn::after,
      .ai-thinking-dots i, .ai-cursor { animation: none !important; transition: none !important; }
      .ai-explain-btn:hover:not(:disabled) { transform: none; }
      .ai-explain-btn::after { opacity: 0 !important; }
      .ai-cursor { opacity: 1; }
    }
    .section-label {
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      opacity: 0.5; margin-bottom: 6px;
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
    .author-email { font-size: 11px; opacity: 0.55; }
    .meta-grid {
      display: grid; grid-template-columns: max-content 1fr;
      gap: 4px 14px; align-items: start;
    }
    .meta-key { opacity: 0.55; font-size: 12px; white-space: nowrap; }
    .meta-val { font-size: 12px; font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
    .meta-val.normal { font-family: var(--vscode-font-family); word-break: normal; }
    .refs-row { display: flex; flex-wrap: wrap; gap: 4px; }
    .ref-badge {
      display: inline-flex; align-items: center; gap: 4px;
      padding: 2px 7px; border-radius: 10px;
      font-size: 11px; font-weight: 500;
      border: 1px solid currentColor; opacity: 0.9;
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
    }
    .commit-summary-repo .codicon { font-size: 11px; opacity: 0.65; }
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
      margin-top: 8px; font-size: 11px; opacity: 0.65;
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
    .commit-summary-dot { opacity: 0.55; }
    .commit-summary-meta-hash {
      display: inline-flex; align-items: center; gap: 3px;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; white-space: nowrap;
    }
    .commit-summary-meta-hash .codicon { font-size: 11px; opacity: 0.75; }
    .commit-summary-refs { margin-top: 6px; }

    /* ── Right panel ── */
    .right-panel { flex: 1; display: flex; flex-direction: column; overflow: hidden; }
    .file-toolbar {
      display: flex; align-items: center; gap: 4px;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .file-count { font-size: 11px; opacity: 0.55; flex: 1; padding-left: 4px; }
    .tb-btn {
      background: none; border: none; cursor: pointer;
      padding: 3px 4px; border-radius: 3px;
      color: var(--vscode-foreground); opacity: 0.6;
      display: flex; align-items: center;
      font-size: 13px;
    }
    .tb-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .tb-btn.active { opacity: 1; background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); }

    .file-list { flex: 1; overflow-y: auto; padding: 2px 0; }

    /* Flat rows */
    .file-row {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 8px 3px 0; cursor: pointer; user-select: none;
    }
    .file-row:hover { background: var(--vscode-list-hoverBackground); }
    .file-row.ctx-active { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); }
    .row-indent { flex-shrink: 0; }
    .row-icon { font-size: 14px; flex-shrink: 0; opacity: 0.85; }
    .row-name { font-size: 12px; white-space: nowrap; font-weight: 500; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .row-dir { font-size: 11px; opacity: 0.45; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .row-tail { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; flex-shrink: 0; }
    .row-stats { display: flex; gap: 3px; font-size: 11px; font-family: var(--vscode-editor-font-family, monospace); flex-shrink: 0; }
    .row-status { font-size: 10px; font-weight: 700; flex-shrink: 0; opacity: 0.85; margin-right: 6px; }
    .added   { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
    .removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }

    /* Tree dir rows */
    .dir-row {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 8px 3px 0; cursor: pointer; user-select: none;
    }
    .dir-row:hover { background: var(--vscode-list-hoverBackground); }
    .dir-name { font-size: 12px; white-space: nowrap; opacity: 0.85; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
    .dir-badge {
      font-size: 10px; opacity: 0.45;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      border-radius: 8px; padding: 0 5px; flex-shrink: 0; margin-left: auto;
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

    /* ── Merged commits ── */
    .merge-section {
      display: flex; flex-direction: column; gap: 2px;
      flex-shrink: 0; max-height: 200px; overflow-y: auto;
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .merge-title {
      display: flex; align-items: center; gap: 5px;
      font-size: 10px; font-weight: 600;
      text-transform: uppercase; letter-spacing: 0.06em;
      opacity: 0.5; margin-bottom: 4px;
    }
    .merge-loading { font-size: 11px; opacity: 0.5; padding: 4px 0; }
    .merge-commit-row {
      display: flex; align-items: center; gap: 5px;
      padding: 3px 6px; border-radius: 3px; cursor: pointer;
      font-size: 11px;
    }
    .merge-commit-row:hover { background: var(--vscode-list-hoverBackground); }
    .merge-commit-row.active { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); }
    .merge-hash { font-family: var(--vscode-editor-font-family, monospace); opacity: 0.6; flex-shrink: 0; }
    .merge-msg { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .merge-author { opacity: 0.45; flex-shrink: 0; font-size: 10px; }
    .merge-files { padding-left: 16px; display: flex; flex-direction: column; gap: 1px; margin-bottom: 2px; }
    .merge-file-row {
      display: flex; align-items: center; gap: 5px;
      padding: 2px 4px; border-radius: 3px; cursor: pointer; font-size: 11px;
    }
    .merge-file-row:hover { background: var(--vscode-list-hoverBackground); }
    .merge-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .merge-file-status { font-size: 10px; font-weight: 700; flex-shrink: 0; }
  </style>
</head>
<body>
  <div class="toolbar">
    <span class="codicon codicon-git-commit" style="opacity:0.6"></span>
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
      ${data.parents.length >= 2 ? `<div class="merge-section" id="mergeSection">
        <div class="merge-title"><span class="codicon codicon-git-merge" style="font-size:11px"></span>${escHtml(t('Merged commits'))}</div>
        <div id="mergeList"><div class="merge-loading">${escHtml(t('Loading...'))}</div></div>
      </div>` : ''}
      <div class="file-toolbar">
        <span class="file-count" id="fileCount"></span>
        <button class="tb-btn" id="btnExpandAll" title="${escHtml(t('Expand all'))}" style="display:none"><span class="codicon codicon-expand-all"></span></button>
        <button class="tb-btn" id="btnCollapseAll" title="${escHtml(t('Collapse all'))}" style="display:none"><span class="codicon codicon-collapse-all"></span></button>
        <button class="tb-btn active" id="btnTree" title="${escHtml(t('Tree view'))}"><span class="codicon codicon-list-tree"></span></button>
        <button class="tb-btn" id="btnFlat" title="${escHtml(t('Flat list'))}"><span class="codicon codicon-list-flat"></span></button>
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
    const reduceAiMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
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
      if (reduceAiMotion) {
        aiDisplayedText = aiTargetText;
        renderAiMarkdown(aiDisplayedText, aiBusy && !pendingAiResult);
        finishAiTypingIfReady();
        return;
      }
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
        return '<span class="codicon codicon-' + icon + '" style="font-size:' + size + 'px;opacity:0.75;flex-shrink:0;" aria-hidden="true"></span>';
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
      return '<span class="codicon codicon-' + icon + '" style="font-size:' + size + 'px;opacity:0.75;flex-shrink:0;" aria-hidden="true"></span>';
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
    function buildTree(files) {
      const root = makeNode('', '');
      for (const f of files) {
        const parts = __d.showRepoGrouping ? [f.repoName || __d.repoName, ...f.path.split('/')] : f.path.split('/');
        let node = root;
        let acc = '';
        for (let i = 0; i < parts.length; i++) {
          const p = parts[i];
          const isRepoRoot = __d.showRepoGrouping && i === 0;
          acc = acc ? acc + '/' + p : p;
          const key = isRepoRoot ? ((f.repoId || __d.repoId) + ':' + p) : ((f.repoId || __d.repoId) + ':' + acc);
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
    let viewMode = 'tree';
    // Map<fullPath, boolean> — open/closed state per dir node
    const dirOpen = new Map();
    // forceAll: null = use dirOpen, true = all open, false = all closed
    let forceAll = null;

    function isDirOpen(fullPath) {
      if (forceAll !== null) return forceAll;
      if (!dirOpen.has(fullPath)) return true; // default open
      return dirOpen.get(fullPath);
    }
    function toggleDir(fullPath) {
      forceAll = null;
      dirOpen.set(fullPath, !isDirOpen(fullPath));
      render();
    }

    // ── Tree rendering ──
    function renderTreeNode(node, depth, buf) {
      if (node.file) {
        const f = node.file;
        const status = normalizeStatus(f.status);
        const col = statusColor(status);
        buf.push(
          '<div class="file-row"' + fileDatasetAttrs(f, status) + ' title="' + escAttr(f.path) + '\\n' + escAttr(t('Click to open diff')) + '">' +
          '<div class="row-indent" style="width:' + (depth * 14 + 4) + 'px"></div>' +
          fileIconHtml(node.name) +
          '<span class="row-name" style="color:' + col + '">' + escText(node.name) + '</span>' +
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
          '<div class="row-indent" style="width:2px"></div>' +
          '<span class="codicon ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="font-size:12px;opacity:0.6;flex-shrink:0;"></span>' +
          '<span style="width:8px;height:8px;border-radius:50%;background:' + escAttr(node.repoColor || __d.repoColor || '#4ec9b0') + ';flex-shrink:0;"></span>' +
          '<span class="dir-name" style="font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;">' + escText(node.name) + '</span>' +
          '<span class="dir-badge">' + node.fileCount + '</span>' +
          '</div>'
        );
      } else {
        const folderBase = node.name.includes('/') ? node.name.split('/').pop() : node.name;
        buf.push(
          '<div class="dir-row" data-dir="' + escAttr(node.fullPath) + '">' +
          '<div class="row-indent" style="width:' + (depth * 14 + 2) + 'px"></div>' +
          '<span class="codicon ' + (open ? 'codicon-chevron-down' : 'codicon-chevron-right') + '" style="font-size:12px;opacity:0.6;flex-shrink:0;"></span>' +
          folderIconHtml(folderBase, open) +
          '<span class="dir-name">' + escText(node.name) + '</span>' +
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

    function renderFlat() {
      const buf = [];
      for (const f of FILES) {
        const status = normalizeStatus(f.status);
        const col  = statusColor(status);
        const name = f.path.includes('/') ? f.path.split('/').pop() : f.path;
        const dir  = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
        buf.push(
          '<div class="file-row"' + fileDatasetAttrs(f, status) + ' title="' + escAttr(f.path) + '\\n' + escAttr(t('Click to open diff')) + '">' +
          '<div class="row-indent" style="width:4px"></div>' +
          fileIconHtml(name) +
          '<span class="row-name" style="color:' + col + '">' + escText(name) + '</span>' +
          (dir ? '<span class="row-dir">' + escText(dir) + '</span>' : '') +
          '<span class="row-tail">' +
          statsHtml(f) +
          '<span class="row-status" style="color:' + col + '">' + escText(status) + '</span>' +
          '</span>' +
          '</div>'
        );
      }
      return buf.join('');
    }

    function render() {
      const listEl = document.getElementById('fileList');
      const fileCountEl = document.getElementById('fileCount');
      const btnExpandAll    = document.getElementById('btnExpandAll');
      const btnCollapseAll  = document.getElementById('btnCollapseAll');
      fileCountEl.textContent = formatFileCount(FILES.length);
      if (viewMode === 'flat') {
        listEl.innerHTML = renderFlat();
        btnExpandAll.style.display   = 'none';
        btnCollapseAll.style.display = 'none';
      } else {
        const tree = buildTree(FILES);
        const root = tree;
        const buf = [];
        const sorted = Array.from(root.children.values()).sort((a, b) => {
          if (!a.file && b.file) return -1;
          if (a.file && !b.file) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const child of sorted) renderTreeNode(collapseDirs(child), 0, buf);
        listEl.innerHTML = buf.join('');
        btnExpandAll.style.display   = '';
        btnCollapseAll.style.display = '';
      }
    }

    // ── Event delegation on file list ──
    const listEl = document.getElementById('fileList');
    listEl.addEventListener('click', e => {
      const dirRow  = e.target.closest('.dir-row');
      const fileRow = e.target.closest('.file-row');
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
      render();
    });
    document.getElementById('btnFlat').addEventListener('click', () => {
      viewMode = 'flat';
      document.getElementById('btnFlat').classList.add('active');
      document.getElementById('btnTree').classList.remove('active');
      render();
    });
    document.getElementById('btnExpandAll').addEventListener('click', () => {
      forceAll = true; render();
    });
    document.getElementById('btnCollapseAll').addEventListener('click', () => {
      forceAll = false; render();
    });

    // ── Initial render ──
    render();

    // ── Author avatars (Gravatar / GitHub) — matches the Git log avatar rules ──
    try {
      (async () => {
        function avatarColor(seed) {
          let h = 0;
          for (let i = 0; i < seed.length; i++) h = seed.charCodeAt(i) + ((h << 5) - h);
          return 'hsl(' + (Math.abs(h) % 360) + ',55%,45%)';
        }

        function authorInitials(name) {
          const parts = String(name || '').trim().split(/\\s+/).filter(Boolean);
          if (parts.length === 0) return '?';
          if (parts.length === 1) {
            const word = parts[0] || '';
            return (word.length > 1 ? word[0] + word[1] : word[0] || '?').toUpperCase();
          }
          return ((parts[0][0] || '') + (parts[parts.length - 1][0] || '')).toUpperCase();
        }

        function isBlankImage(url) {
          return new Promise(resolve => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
              try {
                const c = document.createElement('canvas');
                c.width = 8; c.height = 8;
                const ctx = c.getContext('2d');
                if (!ctx) { resolve(false); return; }
                ctx.drawImage(img, 0, 0, 8, 8);
                const px = ctx.getImageData(0, 0, 8, 8).data;
                const uniq = new Set();
                for (let i = 0; i < px.length; i += 4)
                  uniq.add((Math.round(px[i]/16) << 8) | (Math.round(px[i+1]/16) << 4) | Math.round(px[i+2]/16));
                resolve(uniq.size <= 3);
              } catch { resolve(false); }
            };
            img.onerror = () => resolve(true);
            img.src = url;
          });
        }

        async function resolveAvatarUrl(authorEmail, size) {
          if (!authorEmail.trim()) return null;
          if (authorEmail.toLowerCase().endsWith('@users.noreply.github.com')) {
            const local = authorEmail.split('@')[0] || '';
            const username = local.includes('+') ? local.split('+')[1] : local;
            if (username) {
              const url = 'https://avatars.githubusercontent.com/' + username + '?size=' + (size * 2);
              if (!(await isBlankImage(url))) return url;
            }
            return null;
          }
          const norm = authorEmail.trim().toLowerCase();
          const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
          const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
          const url = 'https://gravatar.com/avatar/' + hex + '?s=' + (size * 2) + '&d=404';
          return (await isBlankImage(url)) ? null : url;
        }

        const avatarElements = Array.from(document.querySelectorAll('[data-author-avatar]'));
        await Promise.all(avatarElements.map(async avatarEl => {
          const authorName = avatarEl.dataset.authorName || '';
          const authorEmail = avatarEl.dataset.authorEmail || '';
          const size = Number(avatarEl.dataset.avatarSize || '20');
          const avatarSeed = authorEmail.trim() || authorName.trim();
          avatarEl.textContent = authorInitials(authorName);
          avatarEl.style.background = avatarColor(avatarSeed);
          avatarEl.style.color = '#fff';
          avatarEl.style.opacity = authorEmail.trim() ? '0.4' : '1';

          const url = await resolveAvatarUrl(authorEmail, size);
          avatarEl.style.opacity = '1';
          if (!url) return;

          const img = document.createElement('img');
          img.src = url;
          img.alt = authorName;
          img.style.cssText = 'width:' + size + 'px;height:' + size + 'px;border-radius:50%;object-fit:cover;';
          img.onerror = () => {
            avatarEl.textContent = authorInitials(authorName);
            avatarEl.style.background = avatarColor(avatarSeed);
          };
          avatarEl.textContent = '';
          avatarEl.style.background = 'none';
          avatarEl.appendChild(img);
        }));
      })();
    } catch(e) { /* avatars are optional */ }

    // ── Branch / tag badges — runs after render, isolated ──
    try {
      const PAL_D = ['#6a9fc2','#a07cb0','#5aaa96','#b87c5a','#7a9e5a','#b09050','#7085b8','#a06060','#5a8fa0','#908060','#7aaa70','#9a7060'];
      const PAL_L = ['#2a6090','#6a3a80','#2a7a68','#8a4a28','#3a6a28','#7a5a18','#3a4a88','#7a2828','#1a5a70','#605030','#3a6a30','#603828'];
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
        while(l>threshold){ r=Math.round(r*0.82);g=Math.round(g*0.82);b=Math.round(b*0.82);l=lum(r,g,b); }
        return toHex(r,g,b);
      }
      function lighten(raw,threshold) {
        const rgb=parseC(raw); if(!rgb) return raw;
        let [r,g,b]=rgb; let l=lum(r,g,b);
        while(l<threshold){
          r=Math.min(255,Math.round(r*1.15+8));g=Math.min(255,Math.round(g*1.15+8));b=Math.min(255,Math.round(b*1.15+8));
          const next=lum(r,g,b); if(next===l) break; l=next;
        }
        return toHex(r,g,b);
      }
      function primaryColor() {
        const raw = getComputedStyle(document.body).getPropertyValue('--vscode-button-background').trim() || '#0078d4';
        return dark() ? lighten(raw,0.18) : darken(raw,0.3);
      }
      function hashB(n) { let h=0; const s=normB(n); for(let i=0;i<s.length;i++) h=(h*31+s.charCodeAt(i))>>>0; return h%PAL_D.length; }
      function bColor(n) {
        if (PRIM.includes(normB(n).toLowerCase())) return primaryColor();
        return (dark() ? PAL_D : PAL_L)[hashB(n)];
      }
      const tColor = () => dark() ? '#4aaa9a' : '#1a7a6a';

      function normalizeBranches(branches) {
        const result = [];
        for (const name of branches?.local || []) result.push({ type: 'local', name, remote: '' });
        for (const remoteBranch of branches?.remote || []) {
          const slash = remoteBranch.indexOf('/');
          result.push(slash >= 0
            ? { type: 'remote', name: remoteBranch.slice(slash + 1), remote: remoteBranch.slice(0, slash) }
            : { type: 'remote', name: remoteBranch, remote: '' });
        }
        for (const name of branches?.tags || []) result.push({ type: 'tag', name, remote: '' });
        return result;
      }

      function appendBranchBadges(refsRow, branches) {
        for (const b of branches) {
          const color = b.type === 'tag' ? tColor() : bColor(b.name);
          const icon  = b.type === 'tag' ? 'tag' : b.type === 'remote' ? 'cloud' : 'git-branch';
          const label = b.type === 'remote' && b.remote ? b.remote + '/' + b.name : b.name;
          const sp = document.createElement('span');
          sp.title = b.type === 'tag'
            ? t('Tag: {0}', label)
            : b.type === 'remote'
              ? t('Remote: {0}', label)
              : t('Local: {0}', label);
          sp.style.cssText = 'font-size:10px;padding:0 6px;height:16px;line-height:16px;border-radius:3px;display:inline-flex;align-items:center;gap:3px;background:' + color + '33;color:' + color + ';border:1px solid ' + color + '88;max-width:160px;overflow:hidden;white-space:nowrap;flex-shrink:0;box-sizing:border-box;font-weight:500;margin:2px;';
          sp.innerHTML = '<span class="codicon codicon-' + icon + '" style="font-size:10px;flex-shrink:0;line-height:1"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">' + escText(label) + '</span>';
          refsRow.appendChild(sp);
        }
      }

      const refsRow = document.getElementById('refsRow');
      if (refsRow) appendBranchBadges(refsRow, __d.branches || []);

      document.querySelectorAll('[data-commit-refs]').forEach(commitRefsRow => {
        const repoId = commitRefsRow.dataset.commitRepoId || '';
        const hash = commitRefsRow.dataset.commitHash || '';
        const commit = (__d.commits || []).find(item => item.repoId === repoId && item.hash === hash);
        if (commit) appendBranchBadges(commitRefsRow, normalizeBranches(commit.branches));
      });
    } catch(e) { /* badges are optional */ }

    // ── Merged commits ──
    try {
      const mergeListEl = document.getElementById('mergeList');
      if (mergeListEl && __d.parents && __d.parents.length >= 2) {
        const pending = new Map();
        let selectedMergeHash = null;

        window.addEventListener('message', e => {
          const cb = pending.get(e.data?.requestId);
          if (cb) { pending.delete(e.data.requestId); cb(e.data); }
        });

        function reqId() { return Math.random().toString(36).slice(2); }

        function renderMergeList(commits, mergeFiles) {
          const buf = [];
          for (const c of commits) {
            const isActive = selectedMergeHash === c.hash;
            buf.push(
              '<div class="merge-commit-row' + (isActive ? ' active' : '') + '" data-hash="' + escAttr(c.hash) + '" title="' + escAttr(c.hash) + '">' +
              '<span class="codicon codicon-' + (isActive ? 'chevron-down' : 'chevron-right') + '" style="font-size:10px;opacity:0.5;flex-shrink:0"></span>' +
              '<span class="merge-hash">' + escText(c.shortHash) + '</span>' +
              '<span class="merge-msg">' + escText(c.message) + '</span>' +
              '<span class="merge-author">' + escText(c.authorName) + '</span>' +
              '</div>'
            );
            if (isActive) {
              buf.push('<div class="merge-files">');
              if (!mergeFiles) {
                buf.push('<div class="merge-loading">' + escText(t('Loading files...')) + '</div>');
              } else if (mergeFiles.length === 0) {
                buf.push('<div class="merge-loading">' + escText(t('No changed files')) + '</div>');
              } else {
                for (const f of mergeFiles) {
                  const status = normalizeStatus(f.status);
                  const col = statusColor(status);
                  const name = f.path.includes('/') ? f.path.split('/').pop() : f.path;
                  buf.push(
                    '<div class="merge-file-row" data-path="' + escAttr(f.path) + '" data-status="' + escAttr(status) + '" data-hash="' + escAttr(c.hash) + '" title="' + escAttr(f.path) + '\\n' + escAttr(t('Click to open diff')) + '">' +
                    fileIconHtml(name) +
                    '<span class="merge-file-name" style="color:' + col + '">' + escText(name) + '</span>' +
                    statsHtml(f) +
                    '<span class="merge-file-status" style="color:' + col + '">' + escText(status) + '</span>' +
                    '</div>'
                  );
                }
              }
              buf.push('</div>');
            }
          }
          mergeListEl.innerHTML = buf.join('');
        }

        // Load merge commits
        const rid = reqId();
        pending.set(rid, data => {
          const commits = data.commits || [];
          if (commits.length === 0) {
            mergeListEl.innerHTML = '<div class="merge-loading">' + escText(t('No commits found')) + '</div>';
            return;
          }
          renderMergeList(commits, null);

          mergeListEl.addEventListener('click', e => {
            const row = e.target.closest('.merge-commit-row');
            const fileRow = e.target.closest('.merge-file-row');
            if (fileRow) {
              vscode.postMessage({ type: 'openDiff', filePath: fileRow.dataset.path, fileStatus: fileRow.dataset.status, hash: fileRow.dataset.hash });
              return;
            }
            if (!row) return;
            const clickedHash = row.dataset.hash;
            if (selectedMergeHash === clickedHash) {
              selectedMergeHash = null;
              renderMergeList(commits, null);
              // restore main file list
              document.getElementById('fileCount').textContent = formatFileCount(FILES.length);
              render();
              return;
            }
            selectedMergeHash = clickedHash;
            renderMergeList(commits, null);
            // Load files for this merge commit
            const frid = reqId();
            pending.set(frid, fdata => {
              const mf = fdata.files || [];
              renderMergeList(commits, mf);
              // Show merge commit files in right panel
              document.getElementById('fileCount').textContent = formatFileCount(mf.length) + ' · ' + (commits.find(c => c.hash === selectedMergeHash)?.shortHash || '');
              const listEl2 = document.getElementById('fileList');
              const buf2 = [];
              for (const f of mf) {
                const status = normalizeStatus(f.status);
                const col = statusColor(status);
                const name = f.path.includes('/') ? f.path.split('/').pop() : f.path;
                const dir  = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
                buf2.push(
                  '<div class="file-row" data-path="' + escAttr(f.path) + '" data-status="' + escAttr(status) + '" data-hash="' + escAttr(selectedMergeHash) + '" title="' + escAttr(f.path) + '\\n' + escAttr(t('Click to open diff')) + '">' +
                  '<div class="row-indent" style="width:4px"></div>' +
                  fileIconHtml(name) +
                  '<span class="row-name" style="color:' + col + '">' + escText(name) + '</span>' +
                  (dir ? '<span class="row-dir">' + escText(dir) + '</span>' : '') +
                  '<span class="row-tail">' +
                  statsHtml(f) +
                  '<span class="row-status" style="color:' + col + '">' + escText(status) + '</span>' +
                  '</span>' +
                  '</div>'
                );
              }
              listEl2.innerHTML = buf2.join('');
            });
            vscode.postMessage({ type: 'getMergeFiles', hash: clickedHash, requestId: frid });
          });
        });
        vscode.postMessage({ type: 'getMergeCommits', hash: __d.hash, parents: __d.parents, requestId: rid });
      }
    } catch(e) { /* merge section is optional */ }

    // ── Revert feedback ──
    window.addEventListener('message', e => {
      if (e.data?.type === 'revertDone') {
        const row = document.querySelector('[data-path="' + CSS.escape(e.data.filePath) + '"]');
        if (row) { row.style.opacity = '0.4'; }
      }
    });
  </script>
</body>
</html>`;
}
