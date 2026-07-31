import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import { t } from '../utils/l10n';
import { ComposerPromptManager } from './ComposerPromptManager';
import { CommitPromptManager } from '../aiCommitMessage/CommitPromptManager';
import type { ComposerAnalysisResult, ComposerAnalyzeOptions, ComposerCommitGroup } from './types';

const MAX_CONTEXT_CHARS = 120_000;
const MAX_OUTPUT_TOKENS = 8192;

function cleanJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

export class AiCommitComposerService {
  private readonly promptManager: ComposerPromptManager;
  private readonly commitPromptManager: CommitPromptManager;

  constructor(context: vscode.ExtensionContext, private readonly provider: AiProviderService) {
    this.promptManager = new ComposerPromptManager(context);
    this.commitPromptManager = new CommitPromptManager(context);
  }

  editPrompt(): Promise<void> { return this.promptManager.edit(); }
  resetPrompt(): Promise<void> { return this.promptManager.reset(); }

  async analyze(options: ComposerAnalyzeOptions, repoRootPath: string): Promise<ComposerAnalysisResult> {
    const [prompt, commitPrompt] = await Promise.all([
      this.promptManager.resolve(repoRootPath),
      this.commitPromptManager.resolve([repoRootPath]),
    ]);
    const unitPayload = options.source.units.map(unit => ({
      id: unit.id,
      filePath: unit.filePath,
      oldPath: unit.oldPath,
      kind: unit.kind,
      status: unit.status,
      atomic: unit.atomic,
      diff: unit.diff,
    }));
    const userMessage = JSON.stringify({
      mode: options.source.mode,
      vcs: options.source.vcsKind,
      branch: options.source.branch,
      units: unitPayload,
    });
    if (userMessage.length > MAX_CONTEXT_CHARS) {
      throw new Error(t('AI Commit Composer context is too large. Select fewer changes and try again.'));
    }
    const result = await this.provider.generate({
      systemPrompt: this.combinePrompts(prompt.prompt, commitPrompt.prompt),
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: () => {},
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    if (result.inputTruncated) throw new Error(t('AI input was truncated. Select fewer changes and try again.'));

    let parsed: unknown;
    try { parsed = JSON.parse(cleanJson(result.text)); }
    catch { throw new Error(t('AI Commit Composer returned invalid JSON.')); }
    const groups = this.validateGroups(parsed, new Set(options.source.units.map(unit => unit.id)));
    return { groups, provider: result.provider, model: result.model, promptSource: prompt.source };
  }

  private combinePrompts(composerPrompt: string, commitPrompt: string): string {
    const chinese = vscode.env.language.toLowerCase().startsWith('zh');
    const bridge = chinese
      ? `# 系统提交消息提示词\n\n以下提示词是 VersionDock 当前生效的提交消息提示词。每个 groups[].message 的语言、格式、类型、scope、summary 和正文都必须遵守它。其中要求“只输出提交消息”的规则仅适用于 message 字段，不得破坏 Composer 的 JSON 输出协议。\n\n<commit-message-prompt>\n${commitPrompt}\n</commit-message-prompt>\n\n# 最终输出优先级\n\n仍然只输出 Composer 约定的 JSON；不要在 JSON 外输出任何内容。`
      : `# Active system commit-message prompt\n\nThe following is VersionDock's active commit-message prompt. Every groups[].message must follow its language, format, type, scope, summary, and body rules. Any instruction to "output only the commit message" applies only to each message field and must not replace the Composer JSON contract.\n\n<commit-message-prompt>\n${commitPrompt}\n</commit-message-prompt>\n\n# Final output priority\n\nStill return only the Composer JSON contract, with no content outside the JSON.`;
    return `${composerPrompt}\n\n${bridge}`;
  }

  private validateGroups(value: unknown, expectedIds: Set<string>): ComposerCommitGroup[] {
    const rawGroups = value && typeof value === 'object' && 'groups' in value
      ? (value as { groups?: unknown }).groups
      : undefined;
    if (!Array.isArray(rawGroups) || rawGroups.length === 0) throw new Error(t('AI Commit Composer returned no commit groups.'));
    const seen = new Set<string>();
    const groups = rawGroups.map((raw, index) => {
      if (!raw || typeof raw !== 'object') throw new Error(t('AI Commit Composer returned an invalid commit group.'));
      const candidate = raw as Record<string, unknown>;
      const message = typeof candidate.message === 'string' ? candidate.message.trim() : '';
      const unitIds = Array.isArray(candidate.unitIds) ? candidate.unitIds.filter((id): id is string => typeof id === 'string') : [];
      if (!message || unitIds.length === 0) throw new Error(t('AI Commit Composer returned an incomplete commit group.'));
      for (const id of unitIds) {
        if (!expectedIds.has(id) || seen.has(id)) throw new Error(t('AI Commit Composer returned duplicate or unknown change units.'));
        seen.add(id);
      }
      return {
        id: `group-${index + 1}`,
        message,
        rationale: typeof candidate.rationale === 'string' ? candidate.rationale.trim() : '',
        unitIds,
      };
    });
    if (seen.size !== expectedIds.size) throw new Error(t('AI Commit Composer omitted one or more change units.'));
    return groups;
  }
}
