import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import { calculateCodeReviewOutputTokens } from '../ai/outputTokenBudget';
import type { AiProvider } from '../ai/types';
import { t } from '../utils/l10n';
import { CodeReviewPromptManager } from './CodeReviewPromptManager';
import type {
  CodeReviewFinding,
  CodeReviewGenerateOptions,
  CodeReviewGenerateResult,
  CodeReviewReport,
  CodeReviewSeverity,
  CodeReviewVerdict,
} from './types';

const SEVERITIES = new Set<CodeReviewSeverity>(['critical', 'high', 'medium', 'low']);
const VERDICTS = new Set<CodeReviewVerdict>(['pass', 'warning', 'block']);

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

function cleanJson(raw: string): string {
  let value = raw.trim();
  if (value.startsWith('```')) value = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return value.trim();
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(t('AI Code Review returned an invalid {0}.', field));
  return value.trim();
}

export class AiCodeReviewService {
  private readonly promptManager: CodeReviewPromptManager;

  constructor(context: vscode.ExtensionContext, private readonly provider: AiProviderService) {
    this.promptManager = new CodeReviewPromptManager(context);
  }

  getProvider(): AiProvider { return this.provider.getProvider(); }
  getMaxInputTokens(): Promise<number> { return this.provider.getMaxInputTokens(); }
  editPrompt(): Promise<void> { return this.promptManager.edit(); }
  resetPrompt(): Promise<void> { return this.promptManager.reset(); }

  async generate(options: CodeReviewGenerateOptions): Promise<CodeReviewGenerateResult> {
    throwIfCancelled(options.cancellationToken);
    const promptResolution = await this.promptManager.resolve(options.context.repoRootPaths);
    const userMessage = this.buildUserMessage(options.context.text, options.context.truncated);
    const result = await this.provider.generate({
      systemPrompt: promptResolution.prompt,
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: options.onDelta,
      maxOutputTokens: calculateCodeReviewOutputTokens(`${promptResolution.prompt}\n${userMessage}`, options.context.fileCount),
    });
    throwIfCancelled(options.cancellationToken);
    if (result.inputTruncated) throw new Error(t('AI input was truncated. Select fewer changes and try again.'));
    const report = this.parseReport(result.text, options.context);
    return { ...result, report, promptSource: promptResolution.source };
  }

  private parseReport(raw: string, context: CodeReviewGenerateOptions['context']): CodeReviewReport {
    let parsed: unknown;
    try { parsed = JSON.parse(cleanJson(raw)); }
    catch { throw new Error(t('AI Code Review returned invalid JSON.')); }
    if (!parsed || typeof parsed !== 'object') throw new Error(t('AI Code Review returned invalid JSON.'));
    const object = parsed as Record<string, unknown>;
    if (!VERDICTS.has(object.verdict as CodeReviewVerdict) || !Array.isArray(object.findings)) {
      throw new Error(t('AI Code Review returned an invalid report.'));
    }
    const ids = new Set<string>();
    const findings: CodeReviewFinding[] = object.findings.map((rawFinding, index) => {
      if (!rawFinding || typeof rawFinding !== 'object') throw new Error(t('AI Code Review returned an invalid finding.'));
      const finding = rawFinding as Record<string, unknown>;
      const id = requiredString(finding.id, `findings[${index}].id`);
      if (ids.has(id)) throw new Error(t('AI Code Review returned duplicate finding IDs.'));
      ids.add(id);
      const severity = finding.severity as CodeReviewSeverity;
      if (!SEVERITIES.has(severity)) throw new Error(t('AI Code Review returned an invalid severity.'));
      const anchorId = requiredString(finding.anchorId, `findings[${index}].anchorId`);
      const anchor = context.anchors.get(anchorId);
      if (!anchor) throw new Error(t('AI Code Review referenced an unknown diff location: {0}', anchorId));
      return {
        id,
        severity,
        title: requiredString(finding.title, `findings[${index}].title`),
        anchorId,
        repoId: anchor.repoId,
        repoName: anchor.repoName,
        filePath: anchor.filePath,
        source: anchor.source,
        oldLine: anchor.oldLine,
        newLine: anchor.newLine,
        evidence: requiredString(finding.evidence, `findings[${index}].evidence`),
        impact: requiredString(finding.impact, `findings[${index}].impact`),
        suggestion: requiredString(finding.suggestion, `findings[${index}].suggestion`),
      };
    });
    const calculatedVerdict: CodeReviewVerdict = findings.some(item => item.severity === 'critical' || item.severity === 'high')
      ? 'block'
      : findings.length > 0 ? 'warning' : 'pass';
    return {
      verdict: calculatedVerdict,
      summary: requiredString(object.summary, 'summary'),
      findings,
    };
  }

  private buildUserMessage(context: string, truncated: boolean): string {
    if (vscode.env.language.toLowerCase().startsWith('zh')) {
      return `# 任务\n\n审查下面带稳定锚点的未提交变更。${truncated ? '输入已按 Token 预算裁剪，只能评价可见内容。' : ''}\n\n<code_review_context>\n${context}\n</code_review_context>`;
    }
    return `# Task\n\nReview the following uncommitted changes with stable anchors.${truncated ? ' The input was trimmed to the token budget; assess only visible evidence.' : ''}\n\n<code_review_context>\n${context}\n</code_review_context>`;
  }
}
