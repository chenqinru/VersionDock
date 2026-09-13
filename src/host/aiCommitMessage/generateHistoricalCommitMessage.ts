import * as path from 'path';
import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { FileDiff } from '../types/git';
import type { VersionDockLogger } from '../utils/Logger';
import { t } from '../utils/l10n';
import { buildDiffDetailBlocks, formatDiffStats, countDiffChanges } from '../ai/diffContext';
import { buildFairContext, getFairDetailBlockTokenBudget, type FairContextGroup } from '../ai/fairContext';
import { getContextTokenBudget } from '../ai/inputTokenBudget';
import type { AiCommitMessageService } from './AiCommitMessageService';
import type { AiCommitMessageGenerationContext } from './types';

const LINES_AROUND_CHANGE = 3;

export interface HistoricalCommitMessageGenerationOptions {
  service: AiCommitMessageService;
  repo: GitService;
  hashes: string[];
  requestId: string;
  cancellationToken: vscode.CancellationToken;
  onMessage: (message: string) => void;
  logger?: VersionDockLogger;
}

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

async function buildContext(
  repo: GitService,
  hashes: string[],
  maxInputTokens: number,
  cancellationToken: vscode.CancellationToken,
): Promise<AiCommitMessageGenerationContext> {
  const contextTokenBudget = getContextTokenBudget(maxInputTokens);
  const preparedGroups: Array<{
    headingLines: string[];
    entries: Array<{ label: string; summary: string; diff: FileDiff | null }>;
  }> = [];
  for (const hash of hashes) {
    throwIfCancelled(cancellationToken);
    const files = await repo.getCommitFiles(hash);
    throwIfCancelled(cancellationToken);
    if (files.length === 0) continue;

    const entries: typeof preparedGroups[number]['entries'] = [];
    for (const file of files) {
      throwIfCancelled(cancellationToken);
      const diff = await repo.getFileDiff(repo.repoId, hash, file.path).catch(() => null);
      throwIfCancelled(cancellationToken);
      const label = `${file.status.toUpperCase()} ${file.path}`;
      entries.push({ label, summary: `${label}${formatDiffStats(diff, file)}`, diff });
    }
    preparedGroups.push({ headingLines: [`Commit ${hash.slice(0, 7)}`, 'Changed files:'], entries });
  }

  const entryCount = preparedGroups.reduce((total, group) => total + group.entries.length, 0);
  if (entryCount === 0) throw new Error(t('No changes to generate a commit message from.'));
  const detailBlockTokenBudget = getFairDetailBlockTokenBudget(contextTokenBudget, entryCount);
  const groups: FairContextGroup[] = preparedGroups.map(group => ({
    headingLines: group.headingLines,
    entries: group.entries.map(entry => ({
      summary: entry.summary,
      detailBlocks: buildDiffDetailBlocks(entry.label, entry.diff, detailBlockTokenBudget, {
        linesAroundChange: LINES_AROUND_CHANGE,
        unavailableLine: '  [diff unavailable]',
      }),
    })),
  }));
  const context = buildFairContext(
    ['# Change summary', `[Git] ${path.basename(repo.rootPath)}`],
    groups,
    contextTokenBudget,
  );
  if (context.includedEntryCount === 0) {
    throw new Error(t('AI prompt exceeds the configured input limit of {0} tokens.', maxInputTokens));
  }
  const text = context.text;

  let totalAdditions = 0;
  let totalDeletions = 0;
  const selectedPaths = new Set<string>();
  for (const group of preparedGroups) {
    for (const entry of group.entries) {
      selectedPaths.add(entry.label.replace(/^[A-Z?]+\s+/, ''));
      const { added, removed } = countDiffChanges(entry.diff);
      totalAdditions += added;
      totalDeletions += removed;
    }
  }

  return {
    text,
    repoRootPaths: [repo.rootPath],
    selectedPaths: Array.from(selectedPaths),
    vcsKinds: ['git'],
    repositoryCount: 1,
    fileCount: context.includedEntryCount,
    totalAdditions,
    totalDeletions,
    contextCharCount: text.length,
    truncated: context.truncated,
  };
}

export async function generateHistoricalCommitMessage(
  options: HistoricalCommitMessageGenerationOptions,
): Promise<string> {
  const maxInputTokens = await options.service.getMaxInputTokens();
  throwIfCancelled(options.cancellationToken);
  const context = await buildContext(options.repo, options.hashes, maxInputTokens, options.cancellationToken);
  const provider = options.service.getProvider();
  const startedAt = Date.now();
  let streamedMessage = '';
  const emitDelta = (delta: string): void => {
    if (!delta || options.cancellationToken.isCancellationRequested) return;
    streamedMessage += delta;
    options.onMessage(streamedMessage);
  };

  options.logger?.info('AICommitMessage', 'Historical generation started', {
    requestId: options.requestId,
    provider,
    repositoryCount: context.repositoryCount,
    fileCount: context.fileCount,
    contextCharCount: context.contextCharCount,
    contextTruncated: context.truncated,
  });

  try {
    const result = await options.service.generate({
      context,
      cancellationToken: options.cancellationToken,
      onDelta: emitDelta,
    });
    throwIfCancelled(options.cancellationToken);

    if (!result.streamed) {
      streamedMessage = '';
      for (const character of result.message) {
        throwIfCancelled(options.cancellationToken);
        streamedMessage += character;
        options.onMessage(streamedMessage);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } else if (streamedMessage !== result.message) {
      streamedMessage = result.message;
      options.onMessage(result.message);
    }

    options.logger?.info('AICommitMessage', 'Historical generation completed', {
      requestId: options.requestId,
      provider: result.provider,
      model: result.model,
      promptSource: result.promptSource,
      inputCharCount: result.inputCharCount,
      inputTruncated: result.inputTruncated,
      maxOutputTokens: result.maxOutputTokens,
      streamChunkCount: result.streamChunkCount,
      streamCharCount: result.streamCharCount,
      firstTokenLatencyMs: result.firstTokenLatencyMs,
      durationMs: result.durationMs,
    });
    return result.message;
  } catch (error: unknown) {
    if (options.cancellationToken.isCancellationRequested || (error instanceof Error && error.message === 'Cancelled')) {
      options.logger?.info('AICommitMessage', 'Historical generation cancelled', {
        requestId: options.requestId,
        provider,
        durationMs: Date.now() - startedAt,
      });
    } else {
      options.logger?.error('AICommitMessage', 'Historical generation failed', error, {
        requestId: options.requestId,
        provider,
        durationMs: Date.now() - startedAt,
      });
    }
    throw error;
  }
}
