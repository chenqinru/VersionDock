import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import { calculateCommitMessageOutputTokens } from '../ai/outputTokenBudget';
import type { AiRuntimeProvider } from '../ai/types';
import { t } from '../utils/l10n';
import { CommitPromptManager } from './CommitPromptManager';
import type {
  AiCommitMessageGenerateOptions,
  AiCommitMessageGenerateResult,
  AiCommitMessageGenerationContext,
} from './types';

function cleanCommitMessage(raw: string): string {
  let content = raw.trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```[\w-]*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return content.trim();
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

export class AiCommitMessageService {
  private readonly commitPromptManager: CommitPromptManager;

  constructor(
    context: vscode.ExtensionContext,
    private readonly aiProviderService: AiProviderService,
  ) {
    this.commitPromptManager = new CommitPromptManager(context);
  }

  getProvider(): AiRuntimeProvider {
    return this.aiProviderService.getProvider();
  }

  getMaxInputTokens(): Promise<number> {
    return this.aiProviderService.getMaxInputTokens();
  }

  async editPrompt(): Promise<void> {
    await this.commitPromptManager.edit();
  }

  async resetPrompt(): Promise<void> {
    await this.commitPromptManager.reset();
  }

  async generate(options: AiCommitMessageGenerateOptions): Promise<AiCommitMessageGenerateResult> {
    throwIfCancelled(options.cancellationToken);
    const promptResolution = await this.commitPromptManager.resolve(options.context.repoRootPaths);
    throwIfCancelled(options.cancellationToken);
    const userMessage = this.buildUserMessage(options.context);
    const maxOutputTokens = calculateCommitMessageOutputTokens(`${promptResolution.prompt}\n${userMessage}`);

    const result = await this.aiProviderService.generate({
      systemPrompt: promptResolution.prompt,
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: options.onDelta,
      maxOutputTokens,
      taskKind: 'commit-message',
      repoRootPaths: options.context.repoRootPaths,
      selectedPaths: options.context.selectedPaths,
    });
    throwIfCancelled(options.cancellationToken);

    const message = cleanCommitMessage(result.text);
    if (!message) throw new Error(t('AI provider did not return a commit message.'));
    return {
      ...result,
      message,
      promptSource: promptResolution.source,
    };
  }

  private buildUserMessage(context: AiCommitMessageGenerationContext): string {
    const vcsLabel = context.vcsKinds.length > 1 ? 'Git/SVN' : (context.vcsKinds[0] ?? 'VCS').toUpperCase();
    const isZh = vscode.env.language.toLowerCase().startsWith('zh');

    const hasLineStats = context.totalAdditions !== undefined || context.totalDeletions !== undefined;

    if (isZh) {
      const statsNote = hasLineStats
        ? `共 ${context.fileCount} 个文件，+${context.totalAdditions ?? 0}/-${context.totalDeletions ?? 0} 行。`
        : `共 ${context.fileCount} 个文件。`;

      const promptSections: string[] = ['# 任务'];
      if (context.userPrompt?.trim()) {
        promptSections.push(`【用户草稿】${context.userPrompt.trim()}\n仅将其作为意图线索；如与选中 Diff 不一致，以 Diff 为准。`);
      }
      if (context.branchIntent?.trim()) {
        promptSections.push(`【分支名】${context.branchIntent.trim()}\n仅用于辅助理解，不得据此补充 Diff 无法证明的内容。`);
      }
      promptSections.push(`【变更统计】${statsNote}${context.truncated ? '\n变更上下文已按 Token 预算裁剪，只能根据可见证据总结，不得推测被省略的内容。' : ''}`);
      promptSections.push(`## ${vcsLabel} 变更上下文\n\n基于以下变更 Diff 生成提交信息：\n\n\`\`\`diff\n${context.text}\n\`\`\``);

      return promptSections.join('\n\n');
    }

    const statsNote = hasLineStats
      ? `${context.fileCount} file(s), +${context.totalAdditions ?? 0}/-${context.totalDeletions ?? 0} lines.`
      : `${context.fileCount} file(s).`;

    const promptSections: string[] = ['# Task'];
    if (context.userPrompt?.trim()) {
      promptSections.push(`[User Draft] ${context.userPrompt.trim()}\nUse it only as an intent clue. If it conflicts with the selected diff, follow the diff.`);
    }
    if (context.branchIntent?.trim()) {
      promptSections.push(`[Branch Name] ${context.branchIntent.trim()}\nUse it only as supporting context. Do not add claims that the diff does not support.`);
    }
    promptSections.push(`[Change Statistics] ${statsNote}${context.truncated ? '\nThe change context was trimmed to the token budget. Summarize only visible evidence and do not infer omitted contents.' : ''}`);
    promptSections.push(`## ${vcsLabel} Change Context\n\nGenerate a commit message from the following change diff:\n\n\`\`\`diff\n${context.text}\n\`\`\``);

    return promptSections.join('\n\n');
  }
}
