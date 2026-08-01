import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { AiCommitComposerService } from '../aiCommitComposer/AiCommitComposerService';
import { GitComposerExecutor, type PreparedGitComposerSession } from '../aiCommitComposer/GitComposerExecutor';
import type { ComposerApplyResult, ComposerChangeUnit, ComposerCommitGroup, ComposerPreparedSource } from '../aiCommitComposer/types';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { VersionDockLogger } from '../utils/Logger';
import { t } from '../utils/l10n';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { ComposerToHostMsg, ComposerWorkingCandidate, HostToComposerMsg } from '../types/messages';
import type { FileDiff } from '../types/git';
import type { AiCommitMessageService } from '../aiCommitMessage/AiCommitMessageService';
import type { AiCommitMessageGenerationContext } from '../aiCommitMessage/types';
import { estimateTokenCount, getContextTokenBudget } from '../ai/inputTokenBudget';

type OpenRequest =
  | { mode: 'working'; candidate: ComposerWorkingCandidate }
  | { mode: 'history'; repoId: string; hashes: string[] };

interface PreparedSvnSession {
  source: ComposerPreparedSource;
  fingerprint: string;
  paths: string[];
}

type PreparedSession = PreparedGitComposerSession | PreparedSvnSession;

function isGitSession(session: PreparedSession): session is PreparedGitComposerSession {
  return session.source.vcsKind === 'git';
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function renderDiff(unit: { filePath: string; diff: FileDiff | null }): string {
  const diff = unit.diff;
  if (!diff) return `diff -- ${unit.filePath}\n`;
  if (diff.isBinary) return `diff -- ${unit.filePath}\nBinary file changed\n`;
  return diff.hunks.map(hunk => [hunk.header, ...hunk.lines.map(line => `${line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' '}${line.content}`)].join('\n')).join('\n');
}

export class AiCommitComposerProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private request?: OpenRequest;
  private session?: PreparedSession;
  private activeAnalysis?: vscode.CancellationTokenSource;
  private readonly activeMessageGenerations = new Map<string, vscode.CancellationTokenSource>();
  private readonly gitExecutor = new GitComposerExecutor();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly aiService: AiCommitComposerService,
    private readonly aiCommitMessageService: AiCommitMessageService,
    private readonly logger?: VersionDockLogger,
  ) {}

  async openWorking(candidates: ComposerWorkingCandidate[]): Promise<void> {
    const valid = candidates.filter(candidate => candidate.paths.length > 0 && this.manager.getRepo(candidate.repoId));
    if (!valid.length) {
      vscode.window.showWarningMessage(t('Select changes from one repository before opening AI Commit Composer.'));
      return;
    }
    let candidate = valid[0];
    if (valid.length > 1) {
      const metas = new Map(this.manager.getRepoMetas().map(meta => [meta.id, meta]));
      const picked = await vscode.window.showQuickPick(valid.map(item => ({
        label: metas.get(item.repoId)?.name ?? item.repoId,
        description: t('{0} selected files', item.paths.length),
        candidate: item,
      })), { title: t('Select repository for AI Commit Composer'), ignoreFocusOut: true });
      if (!picked) return;
      candidate = picked.candidate;
    }
    this.open({ mode: 'working', candidate });
  }

  openHistory(repoId: string, hashes: string[]): void {
    this.open({ mode: 'history', repoId, hashes });
  }

  editPrompt(): Promise<void> { return this.aiService.editPrompt(); }
  resetPrompt(): Promise<void> { return this.aiService.resetPrompt(); }

  dispose(): void {
    this.cancelAnalysis();
    this.cancelAllMessageGenerations();
    this.panel?.dispose();
  }

  private open(request: OpenRequest): void {
    this.cancelAnalysis();
    this.cancelAllMessageGenerations();
    this.panel?.dispose();
    this.request = request;
    this.session = undefined;
    const panel = vscode.window.createWebviewPanel(
      'versiondock.aiCommitComposer',
      t('AI Commit Composer'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    panel.iconPath = new vscode.ThemeIcon('sparkle-filled');
    this.panel = panel;
    panel.webview.onDidReceiveMessage((message: ComposerToHostMsg) => void this.handleMessage(message));
    panel.onDidDispose(() => {
      this.cancelAnalysis();
      this.cancelAllMessageGenerations();
      if (this.panel === panel) this.panel = undefined;
    });
    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'aiCommitComposer', t('AI Commit Composer'));
  }

  private async handleMessage(message: ComposerToHostMsg): Promise<void> {
    try {
      if (message.type === 'COMPOSER_READY') {
        await this.prepareAndAnalyze();
      } else if (message.type === 'COMPOSER_REANALYZE') {
        await this.prepareAndAnalyze();
      } else if (message.type === 'COMPOSER_CANCEL') {
        this.cancelAnalysis();
      } else if (message.type === 'COMPOSER_GENERATE_MESSAGE') {
        await this.generateGroupCommitMessage(message.requestId, message.groupId, message.unitIds);
      } else if (message.type === 'COMPOSER_CANCEL_MESSAGE') {
        this.cancelMessageGeneration(message.requestId);
      } else if (message.type === 'COMPOSER_APPLY') {
        await this.apply(message.groups);
      } else if (message.type === 'COMPOSER_CLOSE') {
        this.panel?.dispose();
      } else if (message.type === 'COMPOSER_WEBVIEW_ERROR') {
        this.logger?.error('AICommitComposer', 'Webview error', new Error(message.message), { stack: message.stack });
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.error('AICommitComposer', 'Operation failed', error);
      this.post({ type: 'COMPOSER_ERROR', error: detail });
    }
  }

  private async prepareAndAnalyze(): Promise<void> {
    if (!this.request) return;
    this.cancelAllMessageGenerations();
    this.post({ type: 'COMPOSER_PHASE', phase: 'scanning', detail: t('Scanning change boundaries…') });
    const metaMap = new Map(this.manager.getRepoMetas().map(meta => [meta.id, meta]));
    const repoId = this.request.mode === 'working' ? this.request.candidate.repoId : this.request.repoId;
    const repo = this.manager.getRepo(repoId);
    if (!repo) throw new Error(t('Repo not found'));
    const repoName = metaMap.get(repoId)?.name ?? repoId;
    if (this.request.mode === 'history') {
      if (repo.kind === 'svn') throw new Error(t('SVN committed history cannot be reorganized.'));
      this.session = await this.gitExecutor.prepareHistory(repo, repoName, this.request.hashes);
    } else if (repo.kind === 'svn') {
      this.session = await this.prepareSvn(repoId, repoName, this.request.candidate.paths);
    } else {
      this.session = await this.gitExecutor.prepareWorking(repo, repoName, this.request.candidate.paths, this.request.candidate.stagedOnly);
    }
    this.post({ type: 'COMPOSER_SOURCE', source: this.session.source });
    await this.analyze();
  }

  private async prepareSvn(repoId: string, repoName: string, paths: string[]): Promise<PreparedSvnSession> {
    const repo = this.manager.getRepo(repoId);
    if (!repo) throw new Error(t('Repo not found'));
    const uniquePaths = Array.from(new Set(paths.map(filePath => repo.resolveRepoPath(filePath).relativePath))).sort();
    const units: ComposerChangeUnit[] = [];
    const fingerprints: string[] = [];
    for (const filePath of uniquePaths) {
      const diff = await repo.getUnstagedDiff(repoId, filePath);
      if (!diff) continue;
      const text = renderDiff({ filePath, diff });
      const added = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.type === 'add').length, 0);
      const removed = diff.hunks.reduce((sum, hunk) => sum + hunk.lines.filter(line => line.type === 'remove').length, 0);
      const id = `file-${hash(`${filePath}\n${text}`).slice(0, 16)}`;
      units.push({ id, filePath, kind: 'file', status: diff.isNew ? 'added' : diff.isDeleted ? 'deleted' : diff.isBinary ? 'binary' : 'modified', title: filePath, diff: text, language: diff.language ?? 'plaintext', added, removed, atomic: true });
      fingerprints.push(`${id}:${hash(text)}`);
    }
    if (!units.length) throw new Error(t('No selected changes are available for AI Commit Composer.'));
    const branch = (await repo.getCurrentBranch()).name;
    return {
      source: { sessionId: crypto.randomUUID(), mode: 'working', repoId, repoName, vcsKind: 'svn', branch, sourceLabel: t('Selected SVN working changes'), units },
      fingerprint: hash(fingerprints.join('\0')),
      paths: uniquePaths,
    };
  }

  private async analyze(): Promise<void> {
    if (!this.session) return;
    this.cancelAnalysis();
    const cancellation = new vscode.CancellationTokenSource();
    this.activeAnalysis = cancellation;
    this.post({ type: 'COMPOSER_PHASE', phase: 'analyzing', detail: t('Identifying intent and dependencies…') });
    try {
      const repo = this.manager.getRepo(this.session.source.repoId);
      if (!repo) throw new Error(t('Repo not found'));
      const result = await this.aiService.analyze({ source: this.session.source, cancellationToken: cancellation.token }, repo.rootPath);
      if (cancellation.token.isCancellationRequested) return;
      this.post({ type: 'COMPOSER_PHASE', phase: 'validating', detail: t('Validating complete change coverage…') });
      this.post({ type: 'COMPOSER_PLAN', ...result });
    } finally {
      if (this.activeAnalysis === cancellation) this.activeAnalysis = undefined;
      cancellation.dispose();
    }
  }

  private async apply(groups: ComposerCommitGroup[]): Promise<void> {
    if (!this.session) throw new Error(t('Analyze changes before applying the Composer plan.'));
    this.validateGroupCoverage(this.session.source, groups);
    this.cancelAnalysis();
    this.cancelAllMessageGenerations();
    this.post({ type: 'COMPOSER_PHASE', phase: 'applying', detail: t('Creating composed commits…') });
    const repo = this.manager.getRepo(this.session.source.repoId);
    if (!repo) throw new Error(t('Repo not found'));
    let result: ComposerApplyResult;
    if (isGitSession(this.session)) {
      result = await this.gitExecutor.apply(repo, this.session, groups, (completed, total, message) => {
        this.post({ type: 'COMPOSER_APPLY_PROGRESS', completed, total, message });
      });
    } else {
      const refreshed = await this.prepareSvn(this.session.source.repoId, this.session.source.repoName, this.session.paths);
      if (refreshed.fingerprint !== this.session.fingerprint) throw new Error(t('Selected changes changed after analysis. Analyze them again.'));
      const svnRepo = repo as typeof repo & { commitPaths?: (message: string, paths: string[]) => Promise<string> };
      if (!svnRepo.commitPaths) throw new Error(t('SVN selective commit is unavailable.'));
      const unitPath = new Map(this.session.source.units.map(unit => [unit.id, unit.filePath]));
      let completed = 0;
      try {
        for (const group of groups) {
          this.post({ type: 'COMPOSER_APPLY_PROGRESS', completed, total: groups.length, message: group.message.split('\n')[0] });
          await svnRepo.commitPaths(group.message, group.unitIds.map(id => unitPath.get(id)!).filter(Boolean));
          completed++;
        }
      } catch (error: unknown) {
        throw new Error(t('SVN committed {0} of {1} groups before failing: {2}', completed, groups.length, error instanceof Error ? error.message : String(error)));
      }
      result = { commitCount: completed, commitHashes: [], completedGroups: completed };
    }
    await this.manager.getAllStatusesFresh();
    this.post({ type: 'COMPOSER_APPLY_RESULT', result });
  }

  private cancelAnalysis(): void {
    this.activeAnalysis?.cancel();
    this.activeAnalysis?.dispose();
    this.activeAnalysis = undefined;
  }

  private async generateGroupCommitMessage(requestId: string, groupId: string, unitIds: string[]): Promise<void> {
    if (!this.session) {
      this.post({ type: 'COMPOSER_MESSAGE_RESULT', requestId, groupId, error: t('Analyze changes before generating a commit message.') });
      return;
    }
    this.cancelMessageGeneration(requestId);
    const cancellation = new vscode.CancellationTokenSource();
    this.activeMessageGenerations.set(requestId, cancellation);
    let streamedMessage = '';
    try {
      const maxInputTokens = await this.aiCommitMessageService.getMaxInputTokens();
      if (cancellation.token.isCancellationRequested) return;
      const context = this.buildCommitMessageContext(this.session.source, unitIds, maxInputTokens);
      const result = await this.aiCommitMessageService.generate({
        context,
        cancellationToken: cancellation.token,
        onDelta: delta => {
          if (!delta || cancellation.token.isCancellationRequested) return;
          streamedMessage += delta;
          this.post({ type: 'COMPOSER_MESSAGE_UPDATE', requestId, groupId, message: streamedMessage });
        },
      });
      if (cancellation.token.isCancellationRequested) return;
      this.post({ type: 'COMPOSER_MESSAGE_RESULT', requestId, groupId, message: result.message });
    } catch (error: unknown) {
      if (!cancellation.token.isCancellationRequested) {
        this.post({ type: 'COMPOSER_MESSAGE_RESULT', requestId, groupId, error: error instanceof Error ? error.message : String(error) });
      }
    } finally {
      if (this.activeMessageGenerations.get(requestId) === cancellation) this.activeMessageGenerations.delete(requestId);
      cancellation.dispose();
    }
  }

  private buildCommitMessageContext(
    source: ComposerPreparedSource,
    unitIds: string[],
    maxInputTokens: number,
  ): AiCommitMessageGenerationContext {
    const unitsById = new Map(source.units.map(unit => [unit.id, unit]));
    const uniqueIds = Array.from(new Set(unitIds));
    const units = uniqueIds.map(id => unitsById.get(id)).filter((unit): unit is ComposerChangeUnit => Boolean(unit));
    if (units.length !== uniqueIds.length || units.length === 0) throw new Error(t('Select at least one change before generating a commit message.'));
    const text = [
      `[${source.vcsKind.toUpperCase()}] ${source.repoName} (${source.branch})`,
      ...units.flatMap(unit => [`${unit.status.toUpperCase()} ${unit.filePath}`, unit.diff]),
    ].join('\n');
    if (estimateTokenCount(text) > getContextTokenBudget(maxInputTokens)) {
      throw new Error(t('AI Commit Composer context is too large. Select fewer changes and try again.'));
    }
    return {
      text,
      repoRootPaths: [this.manager.getRepo(source.repoId)?.rootPath ?? ''],
      vcsKinds: [source.vcsKind],
      repositoryCount: 1,
      fileCount: new Set(units.map(unit => unit.filePath)).size,
      contextCharCount: text.length,
      truncated: false,
    };
  }

  private cancelMessageGeneration(requestId: string): void {
    const source = this.activeMessageGenerations.get(requestId);
    if (!source) return;
    this.activeMessageGenerations.delete(requestId);
    source.cancel();
    source.dispose();
  }

  private cancelAllMessageGenerations(): void {
    for (const requestId of Array.from(this.activeMessageGenerations.keys())) this.cancelMessageGeneration(requestId);
  }

  private validateGroupCoverage(source: ComposerPreparedSource, groups: ComposerCommitGroup[]): void {
    const expected = new Set(source.units.map(unit => unit.id));
    const seen = new Set<string>();
    if (!groups.length || groups.some(group => !group.message.trim() || !group.unitIds.length)) {
      throw new Error(t('Every commit group needs a message and at least one change.'));
    }
    for (const group of groups) for (const id of group.unitIds) {
      if (!expected.has(id) || seen.has(id)) throw new Error(t('Every change unit must be assigned exactly once.'));
      seen.add(id);
    }
    if (seen.size !== expected.size) throw new Error(t('Every change unit must be assigned exactly once.'));
  }

  private post(message: HostToComposerMsg): void {
    void this.panel?.webview.postMessage(message);
  }
}
