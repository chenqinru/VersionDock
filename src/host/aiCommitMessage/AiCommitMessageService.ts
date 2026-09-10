import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import { calculateCommitMessageOutputTokens } from '../ai/outputTokenBudget';
import type { AiProvider } from '../ai/types';
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
    const userMessage = this.buildUserMessage(options.context);
    const maxOutputTokens = calculateCommitMessageOutputTokens(`${promptResolution.prompt}\n${userMessage}`);

    const result = await this.aiProviderService.generate({
      systemPrompt: promptResolution.prompt,
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: options.onDelta,
      maxOutputTokens,
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

    const totalLines = (context.totalAdditions ?? 0) + (context.totalDeletions ?? 0);
    const hasLineStats = context.totalAdditions !== undefined || context.totalDeletions !== undefined;
    const isSmallChange = context.fileCount <= 2 && (hasLineStats ? totalLines <= 25 : true);

    if (isZh) {
      const statsNote = hasLineStats
        ? `（共 ${context.fileCount} 个文件，+${context.totalAdditions ?? 0}/-${context.totalDeletions ?? 0} 行）`
        : `（共 ${context.fileCount} 个文件）`;
      const scaleInstruction = isSmallChange
        ? `【改动规模感知】本次属于轻量/微小改动${statsNote}。请严格仅输出 1 行 Header，严禁输出任何 Body 正文，切勿拆解凑数！`
        : `【改动规模感知】本次改动涉及多处或较大规模${statsNote}。若 Header 足以自解释则无需正文；若确需说明，至多提供 1~3 条精炼要点，严禁空洞套话。`;

      return `# 任务\n\n${scaleInstruction}\n\n## ${vcsLabel} 变更上下文\n\n基于以下变更 Diff 生成提交信息：\n\n\`\`\`diff\n${context.text}\n\`\`\``;
    }

    const statsNote = hasLineStats
      ? `(${context.fileCount} file(s), +${context.totalAdditions ?? 0}/-${context.totalDeletions ?? 0} lines)`
      : `(${context.fileCount} file(s))`;
    const scaleInstruction = isSmallChange
      ? `[Scale Guidance] This is a small/atomic change ${statsNote}. Output only a single Header line. Strictly DO NOT output any Body text or bullet points!`
      : `[Scale Guidance] This is a substantial change ${statsNote}. If the Header is self-explanatory, do not output a Body; if details are needed, provide at most 1 to 3 concise bullets. Avoid generic fluff.`;

    return `# Task\n\n${scaleInstruction}\n\n## ${vcsLabel} Change Context\n\nGenerate a commit message from the following change diff:\n\n\`\`\`diff\n${context.text}\n\`\`\``;
  }
}
