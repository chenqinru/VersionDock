import * as vscode from 'vscode';
import type { AiProviderService } from '../ai/AiProviderService';
import { calculateMergeOutputTokens } from '../ai/outputTokenBudget';
import { t } from '../utils/l10n';
import { MergePromptManager } from './MergePromptManager';
import type {
  AiMergeConflictGenerateOptions,
  AiMergeConflictGenerateResult,
  AiMergeConflictResolution,
} from './types';

const CONTEXT_LINES_AROUND_CONFLICT = 30;
const CONFLICT_MARKER_LINE = /^(?:<{7}|\|{7}|={7}|>{7})(?:\s.*)?$/m;

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

function stripCodeFence(raw: string): string {
  let content = raw.trim();
  if (content.startsWith('```')) {
    content = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  return content.trim();
}

export class AiMergeConflictService {
  private readonly promptManager: MergePromptManager;

  constructor(
    context: vscode.ExtensionContext,
    private readonly aiProviderService: AiProviderService,
  ) {
    this.promptManager = new MergePromptManager(context);
  }

  getProvider() {
    return this.aiProviderService.getProvider();
  }

  async editPrompt(): Promise<void> {
    await this.promptManager.edit();
  }

  async resetPrompt(): Promise<void> {
    await this.promptManager.reset();
  }

  async generate(options: AiMergeConflictGenerateOptions): Promise<AiMergeConflictGenerateResult> {
    throwIfCancelled(options.cancellationToken);
    const requestedIndexes = Array.from(new Set(options.conflictIndexes)).sort((left, right) => left - right);
    if (requestedIndexes.length === 0) throw new Error(t('No unresolved conflicts to resolve with AI.'));

    const promptResolution = await this.promptManager.resolve(options.repoRootPaths);
    throwIfCancelled(options.cancellationToken);
    const selectedConflicts = requestedIndexes.map(index => {
      const conflict = options.file.conflicts.find(candidate => candidate.index === index);
      if (!conflict) throw new Error(t('Conflict {0} is no longer available. Reopen the Merge Editor.', index + 1));
      return conflict;
    });
    const userMessage = this.buildUserMessage(options, requestedIndexes);
    const maxOutputTokens = calculateMergeOutputTokens(
      `${promptResolution.prompt}\n${userMessage}`,
      selectedConflicts.map(conflict => ({
        currentText: conflict.oursLines.join('\n'),
        baseText: conflict.baseLines.join('\n'),
        incomingText: conflict.theirsLines.join('\n'),
      })),
    );
    const result = await this.aiProviderService.generate({
      systemPrompt: promptResolution.prompt,
      userMessage,
      cancellationToken: options.cancellationToken,
      onDelta: () => undefined,
      maxOutputTokens,
    });
    throwIfCancelled(options.cancellationToken);
    if (result.inputTruncated) {
      throw new Error(t('The conflict context exceeds the selected AI model input limit. Choose a model with a larger context window.'));
    }

    return {
      ...result,
      resolutions: this.parseResolutions(result.text, requestedIndexes),
      promptSource: promptResolution.source,
    };
  }

  private buildUserMessage(options: AiMergeConflictGenerateOptions, requestedIndexes: number[]): string {
    const contentLines = options.file.content.split('\n');
    const conflictsByIndex = new Map(options.file.conflicts.map(conflict => [conflict.index, conflict]));
    const sections = requestedIndexes.map(index => {
      const conflict = conflictsByIndex.get(index);
      if (!conflict) throw new Error(t('Conflict {0} is no longer available. Reopen the Merge Editor.', index + 1));
      const before = contentLines.slice(Math.max(0, conflict.startLine - CONTEXT_LINES_AROUND_CONFLICT), conflict.startLine);
      const after = contentLines.slice(conflict.endLine + 1, conflict.endLine + 1 + CONTEXT_LINES_AROUND_CONFLICT);
      return [
        `## Conflict ${index}`,
        '',
        '### Context before',
        this.codeBlock(before),
        '',
        `### Current (${conflict.oursLabel})`,
        this.codeBlock(conflict.oursLines),
        '',
        '### Base',
        this.codeBlock(conflict.baseLines),
        '',
        `### Incoming (${conflict.theirsLabel})`,
        this.codeBlock(conflict.theirsLines),
        '',
        '### Context after',
        this.codeBlock(after),
      ].join('\n');
    });

    return [
      '# Task',
      '',
      `Resolve the requested conflicts in ${options.file.relativePath}.`,
      `Language: ${options.file.language ?? 'plaintext'}`,
      '',
      '# Required output protocol',
      '',
      'Return exactly one valid JSON object and nothing else:',
      '{"resolutions":[{"index":0,"content":"resolved source code"}]}',
      '',
      `Required indexes: ${requestedIndexes.join(', ')}`,
      '- Every required index must appear exactly once.',
      '- content must contain only the replacement source for that conflict block.',
      '- Use an empty content string when the entire block should be deleted.',
      '- Encode newlines and quotes according to JSON syntax.',
      '',
      ...sections,
    ].join('\n');
  }

  private codeBlock(lines: string[]): string {
    return lines.length > 0 ? lines.join('\n') : '(empty)';
  }

  private parseResolutions(raw: string, requestedIndexes: number[]): AiMergeConflictResolution[] {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripCodeFence(raw));
    } catch {
      throw new Error(t('AI returned an invalid conflict resolution format. No code was changed.'));
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { resolutions?: unknown }).resolutions)) {
      throw new Error(t('AI returned an invalid conflict resolution format. No code was changed.'));
    }

    const requested = new Set(requestedIndexes);
    const seen = new Set<number>();
    const resolutions: AiMergeConflictResolution[] = [];
    for (const item of (parsed as { resolutions: unknown[] }).resolutions) {
      if (!item || typeof item !== 'object') {
        throw new Error(t('AI returned an invalid conflict resolution format. No code was changed.'));
      }
      const index = (item as { index?: unknown }).index;
      const content = (item as { content?: unknown }).content;
      if (!Number.isInteger(index) || typeof content !== 'string' || !requested.has(index as number) || seen.has(index as number)) {
        throw new Error(t('AI returned incomplete or duplicate conflict resolutions. No code was changed.'));
      }
      if (CONFLICT_MARKER_LINE.test(content)) {
        throw new Error(t('AI returned code that still contains conflict markers. No code was changed.'));
      }
      seen.add(index as number);
      const normalized = content.replace(/\r\n/g, '\n');
      resolutions.push({ index: index as number, lines: normalized === '' ? [] : normalized.split('\n') });
    }

    if (seen.size !== requested.size || requestedIndexes.some(index => !seen.has(index))) {
      throw new Error(t('AI returned incomplete or duplicate conflict resolutions. No code was changed.'));
    }
    return resolutions.sort((left, right) => left.index - right.index);
  }
}
