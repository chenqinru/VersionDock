import * as vscode from 'vscode';
import type { AiCodeReviewService } from '../aiCodeReview/AiCodeReviewService';
import { buildCodeReviewContext, fingerprintDiff } from '../aiCodeReview/buildCodeReviewContext';
import type { CodeReviewCandidate, CodeReviewContext, CodeReviewFinding } from '../aiCodeReview/types';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { CodeReviewToHostMsg, HostToCodeReviewMsg } from '../types/messages';
import type { VersionDockLogger } from '../utils/Logger';
import { t } from '../utils/l10n';
import { getWebviewHtml } from '../utils/webviewHtml';
import type { CommitPanelProvider } from './CommitPanelProvider';

export class AiCodeReviewProvider implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private candidates: CodeReviewCandidate[] = [];
  private context?: CodeReviewContext;
  private activeReview?: vscode.CancellationTokenSource;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: WorkspaceGitManager,
    private readonly service: AiCodeReviewService,
    private readonly commitPanel: CommitPanelProvider,
    private readonly logger?: VersionDockLogger,
  ) {}

  open(candidates: CodeReviewCandidate[]): void {
    const valid = candidates
      .filter(candidate => candidate.paths.length > 0 && this.manager.getRepo(candidate.repoId))
      .map(candidate => ({ ...candidate, paths: Array.from(new Set(candidate.paths)) }));
    if (!valid.length) {
      vscode.window.showWarningMessage(t('Select changes before opening AI Code Review.'));
      return;
    }
    this.cancel();
    this.panel?.dispose();
    this.candidates = valid;
    this.context = undefined;
    const panel = vscode.window.createWebviewPanel(
      'versiondock.aiCodeReview',
      t('AI Code Review'),
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    panel.iconPath = new vscode.ThemeIcon('sparkle-filled');
    this.panel = panel;
    panel.webview.onDidReceiveMessage((message: CodeReviewToHostMsg) => void this.handleMessage(message));
    panel.onDidDispose(() => {
      this.cancel();
      if (this.panel === panel) this.panel = undefined;
    });
    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, 'aiCodeReview', t('AI Code Review'));
  }

  editPrompt(): Promise<void> { return this.service.editPrompt(); }
  resetPrompt(): Promise<void> { return this.service.resetPrompt(); }

  dispose(): void {
    this.cancel();
    this.panel?.dispose();
  }

  private async handleMessage(message: CodeReviewToHostMsg): Promise<void> {
    try {
      if (message.type === 'CODE_REVIEW_READY' || message.type === 'CODE_REVIEW_RERUN') await this.runReview();
      else if (message.type === 'CODE_REVIEW_CANCEL') this.cancel(true);
      else if (message.type === 'CODE_REVIEW_OPEN_DIFF') await this.openFinding(message.finding);
      else if (message.type === 'CODE_REVIEW_WEBVIEW_ERROR') {
        this.logger?.error('AICodeReview', 'Webview error', new Error(message.message), { stack: message.stack });
      }
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger?.error('AICodeReview', 'Operation failed', error);
      this.post({ type: 'CODE_REVIEW_ERROR', error: detail });
    }
  }

  private async runReview(): Promise<void> {
    this.cancel();
    const cancellation = new vscode.CancellationTokenSource();
    this.activeReview = cancellation;
    this.context = undefined;
    const provider = this.service.getProvider();
    const startedAt = Date.now();
    try {
      this.post({ type: 'CODE_REVIEW_PHASE', phase: 'scanning', detail: t('Scanning selected changes…') });
      const maxInputTokens = await this.service.getMaxInputTokens();
      const context = await buildCodeReviewContext(this.manager, this.candidates, maxInputTokens, cancellation.token);
      if (cancellation.token.isCancellationRequested) throw new Error('Cancelled');
      this.context = context;
      this.post({
        type: 'CODE_REVIEW_PHASE',
        phase: 'analyzing',
        detail: t('Cross-checking behavior, safety, and edge cases…'),
        fileCount: context.fileCount,
        repositoryCount: context.repositoryCount,
        truncated: context.truncated,
      });
      let streamCharCount = 0;
      let lastActivityAt = 0;
      const result = await this.service.generate({
        context,
        cancellationToken: cancellation.token,
        onDelta: delta => {
          if (!delta || cancellation.token.isCancellationRequested) return;
          streamCharCount += delta.length;
          const now = Date.now();
          if (now - lastActivityAt < 100) return;
          lastActivityAt = now;
          this.post({
            type: 'CODE_REVIEW_PHASE',
            phase: 'analyzing',
            detail: t('AI is reviewing the visible diff…'),
            fileCount: context.fileCount,
            repositoryCount: context.repositoryCount,
            truncated: context.truncated,
            streamCharCount,
          });
        },
      });
      if (cancellation.token.isCancellationRequested) throw new Error('Cancelled');
      this.post({ type: 'CODE_REVIEW_PHASE', phase: 'validating', detail: t('Validating findings and code locations…'), truncated: context.truncated });
      this.post({
        type: 'CODE_REVIEW_RESULT',
        report: result.report,
        provider: result.provider,
        model: result.model,
        promptSource: result.promptSource,
        durationMs: result.durationMs,
        truncated: context.truncated,
      });
      this.logger?.info('AICodeReview', 'Review completed', {
        provider: result.provider,
        model: result.model,
        promptSource: result.promptSource,
        repositoryCount: context.repositoryCount,
        fileCount: context.fileCount,
        findingCount: result.report.findings.length,
        verdict: result.report.verdict,
        contextTruncated: context.truncated,
        streamCharCount,
        durationMs: Date.now() - startedAt,
      });
    } catch (error: unknown) {
      const cancelled = cancellation.token.isCancellationRequested || (error instanceof Error && error.message === 'Cancelled');
      if (this.activeReview === cancellation) {
        this.post(cancelled
          ? { type: 'CODE_REVIEW_CANCELLED' }
          : { type: 'CODE_REVIEW_ERROR', error: error instanceof Error ? error.message : String(error) });
      }
      if (!cancelled) this.logger?.error('AICodeReview', 'Review failed', error, { provider, durationMs: Date.now() - startedAt });
    } finally {
      if (this.activeReview === cancellation) this.activeReview = undefined;
      cancellation.dispose();
    }
  }

  private async openFinding(finding: CodeReviewFinding): Promise<void> {
    const anchor = this.context?.anchors.get(finding.anchorId);
    if (!anchor || anchor.repoId !== finding.repoId || anchor.filePath !== finding.filePath || anchor.source !== finding.source) {
      this.post({ type: 'CODE_REVIEW_STALE', finding });
      return;
    }
    const repo = this.manager.getRepo(anchor.repoId);
    if (!repo) throw new Error(t('Repo not found'));
    const currentDiff = anchor.source === 'staged'
      ? await repo.getStagedDiff(anchor.repoId, anchor.filePath).catch(() => null)
      : await repo.getUnstagedDiff(anchor.repoId, anchor.filePath).catch(() => null);
    if (fingerprintDiff(currentDiff) !== anchor.fingerprint) {
      this.post({ type: 'CODE_REVIEW_STALE', finding });
      return;
    }
    await this.commitPanel.openCodeReviewDiff(anchor.repoId, anchor.filePath, anchor.source);
  }

  private cancel(notify = false): void {
    const active = this.activeReview;
    if (!active) return;
    this.activeReview = undefined;
    active.cancel();
    if (notify) this.post({ type: 'CODE_REVIEW_CANCELLED' });
  }

  private post(message: HostToCodeReviewMsg): void { void this.panel?.webview.postMessage(message); }
}
