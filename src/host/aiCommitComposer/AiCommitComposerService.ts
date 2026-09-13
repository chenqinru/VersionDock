import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import {
  calculateComposerJsonRepairOutputTokens,
  calculateComposerOutputTokens,
  calculateComposerRepairOutputTokens,
} from '../ai/outputTokenBudget';
import type { AiProviderGenerateResult } from '../ai/types';
import { estimateTokenCount, getContextTokenBudget } from '../ai/inputTokenBudget';
import type { VersionDockLogger } from '../utils/Logger';
import { t } from '../utils/l10n';
import { ComposerPromptManager } from './ComposerPromptManager';
import { CommitPromptManager } from '../aiCommitMessage/CommitPromptManager';
import type { ComposerAnalysisResult, ComposerAnalyzeOptions, ComposerCommitGroup } from './types';

function cleanJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('```')) return trimmed;
  return trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

type JsonParseResult =
  | { ok: true; value: unknown; mode: 'direct' | 'extracted' }
  | { ok: false; error: string };

function extractFirstJsonObject(raw: string): string | undefined {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < raw.length; index++) {
    const character = raw[index];
    if (start < 0) {
      if (character !== '{') continue;
      start = index;
      depth = 1;
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{') {
      depth++;
    } else if (character === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return undefined;
}

function tryParseJson(raw: string): JsonParseResult {
  const cleaned = cleanJson(raw);
  try {
    return { ok: true, value: JSON.parse(cleaned) as unknown, mode: 'direct' };
  } catch (error: unknown) {
    const directError = error instanceof Error ? error.message : String(error);
    const extracted = extractFirstJsonObject(cleaned);
    if (extracted && extracted !== cleaned) {
      try {
        return { ok: true, value: JSON.parse(extracted) as unknown, mode: 'extracted' };
      } catch (extractedError: unknown) {
        return {
          ok: false,
          error: extractedError instanceof Error ? extractedError.message : String(extractedError),
        };
      }
    }
    return { ok: false, error: directError };
  }
}

function isOutputLimitFinishReason(value?: string): boolean {
  return ['length', 'max_tokens', 'max_output_tokens'].includes(value?.trim().toLowerCase() ?? '');
}

function calculateExpandedOutputTokens(current: number, ceiling: number): number {
  const expanded = Math.max(current + 2_048, current * 1.5);
  return Math.min(ceiling, Math.ceil(expanded / 256) * 256);
}

export class AiCommitComposerService {
  private readonly promptManager: ComposerPromptManager;
  private readonly commitPromptManager: CommitPromptManager;

  constructor(
    context: vscode.ExtensionContext,
    private readonly provider: AiProviderService,
    private readonly logger?: VersionDockLogger,
  ) {
    this.promptManager = new ComposerPromptManager(context);
    this.commitPromptManager = new CommitPromptManager(context);
  }

  editPrompt(): Promise<void> { return this.promptManager.edit(); }
  resetPrompt(): Promise<void> { return this.promptManager.reset(); }

  async analyze(options: ComposerAnalyzeOptions, repoRootPath: string): Promise<ComposerAnalysisResult> {
    const requestId = crypto.randomUUID();
    const [prompt, commitPrompt] = await Promise.all([
      this.promptManager.resolve(repoRootPath),
      this.commitPromptManager.resolve([repoRootPath]),
    ]);
    const unitIdByModelId = new Map<string, string>();
    const unitPayload = options.source.units.map((unit, index) => {
      const modelId = `u${index + 1}`;
      unitIdByModelId.set(modelId, unit.id);
      return {
        id: modelId,
        filePath: unit.filePath,
        oldPath: unit.oldPath,
        kind: unit.kind,
        status: unit.status,
        atomic: unit.atomic,
        diff: unit.diff,
      };
    });
    const requiredUnitIds = unitPayload.map(unit => unit.id);
    const userMessage = JSON.stringify({
      mode: options.source.mode,
      vcs: options.source.vcsKind,
      branch: options.source.branch,
      units: unitPayload,
      requiredUnitIds,
    });
    const maxInputTokens = await this.provider.getMaxInputTokens();
    if (estimateTokenCount(userMessage) > getContextTokenBudget(maxInputTokens)) {
      throw new Error(t('AI Commit Composer context is too large. Select fewer changes and try again.'));
    }
    const systemPrompt = this.combinePrompts(prompt.prompt, commitPrompt.prompt);
    const maxOutputTokens = calculateComposerOutputTokens(
      `${systemPrompt}\n${userMessage}`,
      requiredUnitIds,
    );
    let result = await this.provider.generate({
      systemPrompt,
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: () => {},
      maxOutputTokens,
      taskKind: 'commit-composer',
      repoRootPaths: [repoRootPath],
      selectedPaths: Array.from(new Set(options.source.units.map(unit => unit.filePath))),
    });
    this.logGenerationCompleted(requestId, 'Generation completed', result, prompt.source, requiredUnitIds.length);
    if (result.inputTruncated) throw new Error(t('AI input was truncated. Select fewer changes and try again.'));

    const currentOutputTokens = result.maxOutputTokens ?? maxOutputTokens;
    const outputTokenCeiling = this.provider.getMaxOutputTokens();
    if (isOutputLimitFinishReason(result.finishReason) && outputTokenCeiling !== undefined) {
      const retryOutputTokens = calculateExpandedOutputTokens(currentOutputTokens, outputTokenCeiling);
      if (retryOutputTokens > currentOutputTokens) {
        this.logger?.warn('AICommitComposer', 'Output limit reached; retrying generation', {
          requestId,
          unitCount: requiredUnitIds.length,
          finishReason: result.finishReason,
          outputTokenCount: result.outputTokenCount,
          reasoningTokenCount: result.reasoningTokenCount,
          previousMaxOutputTokens: currentOutputTokens,
          retryMaxOutputTokens: retryOutputTokens,
          responseCharCount: result.text.length,
        });
        result = await this.provider.generate({
          systemPrompt,
          userMessage,
          cancellationToken: options.cancellationToken,
          onDelta: () => {},
          maxOutputTokens: retryOutputTokens,
          taskKind: 'commit-composer',
          repoRootPaths: [repoRootPath],
          selectedPaths: Array.from(new Set(options.source.units.map(unit => unit.filePath))),
        });
        this.logGenerationCompleted(requestId, 'Generation retry completed', result, prompt.source, requiredUnitIds.length);
        if (result.inputTruncated) throw new Error(t('AI input was truncated. Select fewer changes and try again.'));
      }
    }

    const parseResult = tryParseJson(result.text);
    let parsed: unknown;
    if (parseResult.ok) {
      parsed = parseResult.value;
      if (parseResult.mode === 'extracted') {
        this.logger?.info('AICommitComposer', 'Recovered embedded JSON response', {
          requestId,
          responseCharCount: result.text.length,
          finishReason: result.finishReason,
        });
      }
    } else {
      this.logger?.warn('AICommitComposer', 'Invalid JSON response; attempting repair', {
        requestId,
        unitCount: requiredUnitIds.length,
        finishReason: result.finishReason,
        outputTokenCount: result.outputTokenCount,
        reasoningTokenCount: result.reasoningTokenCount,
        maxOutputTokens: result.maxOutputTokens,
        responseCharCount: result.text.length,
        parseError: parseResult.error,
      });
      parsed = await this.repairInvalidJson({
        requestId,
        invalidResponse: result.text,
        requiredUnitIds,
        promptSource: prompt.source,
        repoRootPath,
        cancellationToken: options.cancellationToken,
      });
    }
    let validation = this.validateGroups(parsed, new Set(requiredUnitIds));
    if (validation.missingIds.length > 0) {
      const realMissingIds = validation.missingIds.map(id => unitIdByModelId.get(id)!).filter(Boolean);
      const missingFiles = validation.missingIds.map(id => unitPayload.find(unit => unit.id === id)?.filePath).filter(Boolean);
      this.logger?.warn('AICommitComposer', 'Coverage incomplete; attempting repair', {
        requestId,
        unitCount: requiredUnitIds.length,
        coveredCount: requiredUnitIds.length - validation.missingIds.length,
        missingCount: validation.missingIds.length,
        missingIds: realMissingIds,
        missingFiles,
        maxOutputTokens: result.maxOutputTokens,
        responseCharCount: result.text.length,
      });
      validation = {
        groups: await this.repairCoverage({
          requestId,
          groups: validation.groups,
          missingIds: validation.missingIds,
          unitPayload,
          unitIdByModelId,
          promptSource: prompt.source,
          repoRootPath,
          cancellationToken: options.cancellationToken,
        }),
        missingIds: [],
      };
    }
    const groups = validation.groups.map(group => ({
      ...group,
      unitIds: group.unitIds.map(id => unitIdByModelId.get(id)!),
    }));
    return {
      groups,
      provider: result.provider,
      model: result.model,
      promptSource: prompt.source,
      maxOutputTokens: result.maxOutputTokens,
    };
  }

  private async repairInvalidJson(options: {
    requestId: string;
    invalidResponse: string;
    requiredUnitIds: string[];
    promptSource: 'workspace' | 'global' | 'builtin';
    repoRootPath: string;
    cancellationToken: vscode.CancellationToken;
  }): Promise<unknown> {
    const systemPrompt = this.buildJsonRepairPrompt();
    const userMessage = JSON.stringify({
      invalidResponse: options.invalidResponse,
      requiredUnitIds: options.requiredUnitIds,
    });
    const maxOutputTokens = calculateComposerJsonRepairOutputTokens(
      `${systemPrompt}\n${userMessage}`,
      options.invalidResponse,
    );
    const result = await this.provider.generate({
      systemPrompt,
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: () => {},
      maxOutputTokens,
      taskKind: 'json-repair',
      repoRootPaths: [options.repoRootPath],
    });
    this.logGenerationCompleted(
      options.requestId,
      'JSON repair generation completed',
      result,
      options.promptSource,
      options.requiredUnitIds.length,
    );
    if (result.inputTruncated) throw new Error(t('AI input was truncated. Select fewer changes and try again.'));

    const parseResult = tryParseJson(result.text);
    if (parseResult.ok) {
      this.logger?.info('AICommitComposer', 'JSON repair completed', {
        requestId: options.requestId,
        parseMode: parseResult.mode,
        responseCharCount: result.text.length,
        finishReason: result.finishReason,
      });
      return parseResult.value;
    }
    this.logger?.warn('AICommitComposer', 'JSON repair failed', {
      requestId: options.requestId,
      finishReason: result.finishReason,
      outputTokenCount: result.outputTokenCount,
      reasoningTokenCount: result.reasoningTokenCount,
      maxOutputTokens: result.maxOutputTokens,
      responseCharCount: result.text.length,
      parseError: parseResult.error,
    });
    throw new Error(t('AI Commit Composer returned invalid JSON.'));
  }

  private async repairCoverage(options: {
    requestId: string;
    groups: ComposerCommitGroup[];
    missingIds: string[];
    unitPayload: Array<Record<string, unknown> & { id: string; filePath: string }>;
    unitIdByModelId: Map<string, string>;
    promptSource: 'workspace' | 'global' | 'builtin';
    repoRootPath: string;
    cancellationToken: vscode.CancellationToken;
  }): Promise<ComposerCommitGroup[]> {
    const unitById = new Map(options.unitPayload.map(unit => [unit.id, unit]));
    const systemPrompt = this.buildRepairPrompt();
    const userMessage = JSON.stringify({
      existingGroups: options.groups.map(group => ({
        id: group.id,
        message: group.message,
        rationale: group.rationale,
        units: group.unitIds.map(id => {
          const unit = unitById.get(id)!;
          return { id, filePath: unit.filePath, kind: unit.kind, status: unit.status };
        }),
      })),
      missingUnits: options.missingIds.map(id => unitById.get(id)),
      requiredUnitIds: options.missingIds,
    });
    const maxOutputTokens = calculateComposerRepairOutputTokens(
      `${systemPrompt}\n${userMessage}`,
      options.missingIds.length,
    );
    const result = await this.provider.generate({
      systemPrompt,
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: () => {},
      maxOutputTokens,
      taskKind: 'json-repair',
      repoRootPaths: [options.repoRootPath],
    });
    this.logGenerationCompleted(
      options.requestId,
      'Coverage repair generation completed',
      result,
      options.promptSource,
      options.missingIds.length,
    );
    if (result.inputTruncated) throw new Error(t('AI input was truncated. Select fewer changes and try again.'));

    try {
      const parseResult = tryParseJson(result.text);
      if (!parseResult.ok) throw new Error(parseResult.error);
      const repaired = this.applyCoverageRepair(
        parseResult.value,
        options.groups,
        new Set(options.missingIds),
      );
      const repairedRealIds = options.missingIds.map(id => options.unitIdByModelId.get(id)!).filter(Boolean);
      this.logger?.info('AICommitComposer', 'Coverage repair completed', {
        requestId: options.requestId,
        repairedCount: repairedRealIds.length,
        repairedIds: repairedRealIds,
        responseCharCount: result.text.length,
      });
      return repaired;
    } catch (error: unknown) {
      this.logger?.warn('AICommitComposer', 'Coverage repair failed', {
        requestId: options.requestId,
        missingCount: options.missingIds.length,
        missingIds: options.missingIds.map(id => options.unitIdByModelId.get(id)!).filter(Boolean),
        responseCharCount: result.text.length,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(t('AI Commit Composer omitted one or more change units.'));
    }
  }

  private combinePrompts(composerPrompt: string, commitPrompt: string): string {
    const chinese = vscode.env.language.toLowerCase().startsWith('zh');
    const bridge = chinese
      ? `# 系统提交消息提示词\n\n以下提示词是 VersionDock 当前生效的提交消息提示词。每个 groups[].message 的语言、格式、类型、scope、summary 和正文都必须遵守它。其中要求“只输出提交消息”的规则仅适用于 message 字段，不得破坏 Composer 的 JSON 输出协议。\n\n<commit-message-prompt>\n${commitPrompt}\n</commit-message-prompt>\n\n# 最终输出优先级\n\n仍然只输出 Composer 约定的 JSON；不要在 JSON 外输出任何内容。输出前必须对照用户消息末尾的 requiredUnitIds 逐项检查，确保每个短 ID 恰好出现一次。`
      : `# Active system commit-message prompt\n\nThe following is VersionDock's active commit-message prompt. Every groups[].message must follow its language, format, type, scope, summary, and body rules. Any instruction to "output only the commit message" applies only to each message field and must not replace the Composer JSON contract.\n\n<commit-message-prompt>\n${commitPrompt}\n</commit-message-prompt>\n\n# Final output priority\n\nStill return only the Composer JSON contract, with no content outside the JSON. Before responding, check every short ID in requiredUnitIds and include each exactly once.`;
    return `${composerPrompt}\n\n${bridge}`;
  }

  private buildRepairPrompt(): string {
    return vscode.env.language.toLowerCase().startsWith('zh')
      ? `# AI 提交编排覆盖修复\n\n已有提交分组结构有效，但遗漏了部分变更单元。请根据已有分组的提交信息、理由和文件摘要，把 requiredUnitIds 中的每个短 ID 分配给语义最接近的一个已有分组。\n\n只返回 JSON，不要 Markdown、解释或代码块：\n{"assignments":[{"unitId":"u1","groupId":"group-1"}]}\n\n每个 requiredUnitIds 必须且只能出现一次；groupId 必须来自 existingGroups；不得返回其他 unitId，也不得修改提交信息。`
      : `# AI Commit Composer coverage repair\n\nThe existing commit groups are structurally valid but omitted some change units. Assign every short ID in requiredUnitIds to the closest existing group using its message, rationale, and file summaries.\n\nReturn JSON only, with no Markdown, explanation, or code fence:\n{"assignments":[{"unitId":"u1","groupId":"group-1"}]}\n\nEvery requiredUnitId must appear exactly once. groupId must come from existingGroups. Do not return other unit IDs or modify commit messages.`;
  }

  private buildJsonRepairPrompt(): string {
    return vscode.env.language.toLowerCase().startsWith('zh')
      ? `# AI 提交编排 JSON 修复\n\n请把 invalidResponse 修复成语法有效的 JSON。只修复 JSON 语法、代码围栏和多余说明，不得改写已有提交信息、分组理由或 unitId，不得凭空补充 invalidResponse 中不存在的分组。\n\n只返回 JSON，不要 Markdown、解释或代码块。输出结构必须为：\n{"groups":[{"id":"group-1","message":"feat(scope): summary\\n\\n- detail","rationale":"分组原因","unitIds":["u1"]}]}\n\n如果原响应末尾不完整，请删除无法恢复的残缺对象并闭合 JSON；后续程序会根据 requiredUnitIds 单独补齐遗漏单元。`
      : `# AI Commit Composer JSON repair\n\nRepair invalidResponse into syntactically valid JSON. Fix JSON syntax, code fences, and extra prose only. Do not rewrite existing commit messages, rationales, or unit IDs, and do not invent groups that are absent from invalidResponse.\n\nReturn JSON only, with no Markdown, explanation, or code fence. The output shape must be:\n{"groups":[{"id":"group-1","message":"feat(scope): summary\\n\\n- detail","rationale":"Grouping reason","unitIds":["u1"]}]}\n\nIf the response ends with an incomplete object, remove that unrecoverable fragment and close the JSON. The application will repair omitted requiredUnitIds separately.`;
  }

  private logGenerationCompleted(
    requestId: string,
    message: string,
    result: AiProviderGenerateResult,
    promptSource: 'workspace' | 'global' | 'builtin',
    unitCount: number,
  ): void {
    this.logger?.info('AICommitComposer', message, {
      requestId,
      provider: result.provider,
      model: result.model,
      promptSource,
      unitCount,
      inputCharCount: result.inputCharCount,
      inputTokenCount: result.inputTokenCount,
      inputTokenBudget: result.inputTokenBudget,
      maxInputTokens: result.maxInputTokens,
      maxOutputTokens: result.maxOutputTokens,
      finishReason: result.finishReason,
      outputTokenCount: result.outputTokenCount,
      reasoningTokenCount: result.reasoningTokenCount,
      inputTruncated: result.inputTruncated,
      responseCharCount: result.text.length,
      streamChunkCount: result.streamChunkCount,
      streamCharCount: result.streamCharCount,
      firstTokenLatencyMs: result.firstTokenLatencyMs,
      durationMs: result.durationMs,
    });
  }

  private validateGroups(value: unknown, expectedIds: Set<string>): { groups: ComposerCommitGroup[]; missingIds: string[] } {
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
    return { groups, missingIds: Array.from(expectedIds).filter(id => !seen.has(id)) };
  }

  private applyCoverageRepair(
    value: unknown,
    groups: ComposerCommitGroup[],
    expectedIds: Set<string>,
  ): ComposerCommitGroup[] {
    const rawAssignments = value && typeof value === 'object' && 'assignments' in value
      ? (value as { assignments?: unknown }).assignments
      : undefined;
    if (!Array.isArray(rawAssignments)) throw new Error('Coverage repair returned invalid assignments.');
    const groupById = new Map(groups.map(group => [group.id, { ...group, unitIds: [...group.unitIds] }]));
    const seen = new Set<string>();
    for (const raw of rawAssignments) {
      if (!raw || typeof raw !== 'object') throw new Error('Coverage repair returned an invalid assignment.');
      const assignment = raw as Record<string, unknown>;
      const unitId = typeof assignment.unitId === 'string' ? assignment.unitId : '';
      const groupId = typeof assignment.groupId === 'string' ? assignment.groupId : '';
      const group = groupById.get(groupId);
      if (!expectedIds.has(unitId) || seen.has(unitId) || !group) {
        throw new Error('Coverage repair returned duplicate or unknown IDs.');
      }
      seen.add(unitId);
      group.unitIds.push(unitId);
    }
    if (seen.size !== expectedIds.size) throw new Error('Coverage repair still omitted change units.');
    return groups.map(group => groupById.get(group.id)!);
  }
}
