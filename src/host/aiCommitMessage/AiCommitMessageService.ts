import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import type { AiProvider } from '../ai/types';
import { t } from '../utils/l10n';
import { CommitPromptManager } from './CommitPromptManager';
import type {
  AiCommitMessageGenerateOptions,
  AiCommitMessageGenerateResult,
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

  getProvider(): AiProvider {
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

    const result = await this.aiProviderService.generate({
      systemPrompt: promptResolution.prompt,
      userMessage: this.buildUserMessage(options.context.text, options.context.vcsKinds),
      cancellationToken: options.cancellationToken,
      onDelta: options.onDelta,
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

  private buildUserMessage(context: string, vcsKinds: Array<'git' | 'svn'>): string {
    const vcsLabel = vcsKinds.length > 1 ? 'Git/SVN' : (vcsKinds[0] ?? 'VCS').toUpperCase();
    if (vscode.env.language.toLowerCase().startsWith('zh')) {
      return `# 任务\n\n## ${vcsLabel} 变更上下文\n\n基于以下变更 Diff 生成一条提交信息：\n\n\`\`\`diff\n${context}\n\`\`\``;
    }
    return `# Task\n\n## ${vcsLabel} Change Context\n\nGenerate one commit message from the following change diff:\n\n\`\`\`diff\n${context}\n\`\`\``;
  }
}
