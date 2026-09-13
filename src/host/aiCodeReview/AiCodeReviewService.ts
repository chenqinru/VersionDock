import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import { calculateCodeReviewOutputTokens } from '../ai/outputTokenBudget';
import type { AiRuntimeProvider } from '../ai/types';
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

  getProvider(): AiRuntimeProvider { return this.provider.getProvider(); }
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
      temperature: 0,
      taskKind: 'code-review',
      repoRootPaths: options.context.repoRootPaths,
      selectedPaths: Array.from(new Set(Array.from(options.context.anchors.values()).map(anchor => anchor.filePath))),
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
      return `# 任务\n\n审查下面带稳定锚点的未提交变更。${truncated ? '输入已按 Token 预算裁剪，只能评价可见内容。' : ''}\n\n## 必做检查\n\n1. 逐个检查所有可见的 [A…] 变更锚点，不得只抽查部分变更。\n2. 对改名、标识符、配置值、路由、权限、阶段名和任务名的变化，核对 related unchanged lines 中是否仍存在未同步引用。\n3. related unchanged lines 只作为同文件证据；问题仍必须定位到引入风险的 [A…] 变更锚点。\n4. 返回 pass 前，确认每个可见锚点都已按正确性、安全性、数据完整性和兼容性检查；证据不足时不要猜测。\n\n<code_review_context>\n${context}\n</code_review_context>`;
    }
    return `# Task\n\nReview the following uncommitted changes with stable anchors.${truncated ? ' The input was trimmed to the token budget; assess only visible evidence.' : ''}\n\n## Required checks\n\n1. Inspect every visible [A…] change anchor; do not sample only part of the diff.\n2. For renamed identifiers, configuration values, routes, permissions, stage names, and job names, check related unchanged lines for references that were not updated.\n3. Related unchanged lines are same-file evidence only; every finding must still point to the [A…] change anchor that introduced the risk.\n4. Before returning pass, check every visible anchor for correctness, security, data integrity, and compatibility. Do not speculate when evidence is insufficient.\n\n<code_review_context>\n${context}\n</code_review_context>`;
  }
}
