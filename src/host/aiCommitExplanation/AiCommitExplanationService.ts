import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import { calculateCommitExplanationOutputTokens } from '../ai/outputTokenBudget';
import type { AiProvider } from '../ai/types';
import { t } from '../utils/l10n';
import { CommitExplanationPromptManager } from './CommitExplanationPromptManager';
import type {
  AiCommitExplanationGenerateOptions,
  AiCommitExplanationGenerateResult,
} from './types';

function cleanExplanation(raw: string): string {
  let content = raw.trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
  }
  return content.trim();
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

export class AiCommitExplanationService {
  private readonly promptManager: CommitExplanationPromptManager;

  constructor(
    context: vscode.ExtensionContext,
    private readonly aiProviderService: AiProviderService,
  ) {
    this.promptManager = new CommitExplanationPromptManager(context);
  }

  getProvider(): AiProvider {
    return this.aiProviderService.getProvider();
  }

  getMaxInputTokens(): Promise<number> {
    return this.aiProviderService.getMaxInputTokens();
  }

  async editPrompt(): Promise<void> {
    await this.promptManager.edit();
  }

  async resetPrompt(): Promise<void> {
    await this.promptManager.reset();
  }

  async generate(options: AiCommitExplanationGenerateOptions): Promise<AiCommitExplanationGenerateResult> {
    throwIfCancelled(options.cancellationToken);
    const promptResolution = await this.promptManager.resolve(options.context.repoRootPaths);
    throwIfCancelled(options.cancellationToken);
    const userMessage = this.buildUserMessage(options.context);
    const maxOutputTokens = calculateCommitExplanationOutputTokens(
      `${promptResolution.prompt}\n${userMessage}`,
      options.context.commitCount,
      options.context.fileCount,
    );

    const result = await this.aiProviderService.generate({
      systemPrompt: promptResolution.prompt,
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: options.onDelta,
      maxOutputTokens,
    });
    throwIfCancelled(options.cancellationToken);

    const explanation = cleanExplanation(result.text);
    if (!explanation) throw new Error(t('AI provider did not return a commit explanation.'));
    return {
      ...result,
      explanation,
      promptSource: promptResolution.source,
    };
  }

  private buildUserMessage(context: AiCommitExplanationGenerateOptions['context']): string {
    const vcsLabel = context.vcsKinds.length > 1 ? 'Git/SVN' : (context.vcsKinds[0] ?? 'VCS').toUpperCase();
    const modeLabel = context.mode === 'aggregate' ? 'aggregate' : 'single';
    if (vscode.env.language.toLowerCase().startsWith('zh')) {
      return `# 任务\n\n请解释以下 ${vcsLabel} ${modeLabel === 'aggregate' ? '聚合提交' : '单个提交'}。上下文包含 ${context.commitCount} 个提交、${context.repositoryCount} 个仓库和 ${context.fileCount} 个文件${context.truncated ? '，部分超大变更已截断' : ''}。\n\n<commit_context>\n${context.text}\n</commit_context>`;
    }
    return `# Task\n\nExplain the following ${vcsLabel} ${modeLabel} commit context. It contains ${context.commitCount} commit(s), ${context.repositoryCount} repository/repositories, and ${context.fileCount} file(s)${context.truncated ? '; some oversized changes were truncated' : ''}.\n\n<commit_context>\n${context.text}\n</commit_context>`;
  }
}
