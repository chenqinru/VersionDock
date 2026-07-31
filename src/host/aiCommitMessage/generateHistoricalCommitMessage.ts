import * as path from 'path';
import * as vscode from 'vscode';
import type { GitService } from '../git/GitService';
import type { DiffLine, FileDiff } from '../types/git';
import type { VersionDockLogger } from '../utils/Logger';
import { t } from '../utils/l10n';
import type { AiCommitMessageService } from './AiCommitMessageService';
import type { AiCommitMessageGenerationContext } from './types';

const MAX_FILES = 100;
const MAX_LINES_PER_FILE = 80;
const MAX_HUNKS_PER_FILE = 8;
const LINES_AROUND_CHANGE = 3;
const MAX_CONTEXT_CHARS = 64_000;

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

function formatDiffLine(line: DiffLine): string {
  if (line.type === 'add') return `+${line.content}`;
  if (line.type === 'remove') return `-${line.content}`;
  return ` ${line.content}`;
}

function summarizeDiff(diff: FileDiff | null): { lines: string[]; truncated: boolean } {
  if (!diff) return { lines: [], truncated: false };
  const lines: string[] = [];
  if (diff.isBinary) return { lines: ['  binary file'], truncated: false };
  let truncated = diff.hunks.length > MAX_HUNKS_PER_FILE;
  for (const hunk of diff.hunks.slice(0, MAX_HUNKS_PER_FILE)) {
    const includedLineIndexes = new Set<number>();
    for (let index = 0; index < hunk.lines.length; index++) {
      if (hunk.lines[index].type === 'context') continue;
      const start = Math.max(0, index - LINES_AROUND_CHANGE);
      const end = Math.min(hunk.lines.length - 1, index + LINES_AROUND_CHANGE);
      for (let includedIndex = start; includedIndex <= end; includedIndex++) {
        includedLineIndexes.add(includedIndex);
      }
    }
    if (includedLineIndexes.size === 0) continue;
    if (lines.length >= MAX_LINES_PER_FILE) {
      truncated = true;
      break;
    }
    lines.push(`  ${hunk.header}`);
    let previousIndex: number | undefined;
    for (const index of Array.from(includedLineIndexes).sort((left, right) => left - right)) {
      if (previousIndex !== undefined && index > previousIndex + 1) {
        if (lines.length >= MAX_LINES_PER_FILE) {
          truncated = true;
          break;
        }
        lines.push('  ...');
      }
      if (lines.length >= MAX_LINES_PER_FILE) {
        truncated = true;
        break;
      }
      lines.push(`  ${formatDiffLine(hunk.lines[index])}`);
      previousIndex = index;
    }
    if (lines.length >= MAX_LINES_PER_FILE) {
      truncated = true;
      break;
    }
  }
  if (lines.length === 0 && diff.modifiedContent && !diff.originalContent) {
    const contentLines = diff.modifiedContent.split(/\r?\n/);
    lines.push(...contentLines.slice(0, MAX_LINES_PER_FILE).filter(Boolean).map(line => `  +${line}`));
    truncated = contentLines.length > MAX_LINES_PER_FILE;
  }
  return { lines, truncated };
}

async function buildContext(
  repo: GitService,
  hashes: string[],
  cancellationToken: vscode.CancellationToken,
): Promise<AiCommitMessageGenerationContext> {
  const lines: string[] = [];
  let contextCharCount = 0;
  let fileCount = 0;
  let truncated = false;
  const appendLines = (nextLines: string[]): void => {
    for (const line of nextLines) {
      if (lines.length > 0) contextCharCount++;
      lines.push(line);
      contextCharCount += line.length;
    }
  };

  appendLines([`[Git] ${path.basename(repo.rootPath)}`]);
  for (const hash of hashes) {
    throwIfCancelled(cancellationToken);
    const files = await repo.getCommitFiles(hash);
    throwIfCancelled(cancellationToken);
    if (files.length === 0) continue;

    appendLines([`Commit ${hash.slice(0, 7)}`]);
    for (const file of files) {
      throwIfCancelled(cancellationToken);
      if (fileCount >= MAX_FILES) {
        truncated = true;
        break;
      }
      fileCount++;
      appendLines([`${file.status.toUpperCase()} ${file.path}`]);
      const diff = await repo.getFileDiff(repo.repoId, hash, file.path).catch(() => null);
      throwIfCancelled(cancellationToken);
      const summary = summarizeDiff(diff);
      appendLines(summary.lines);
      if (summary.truncated) truncated = true;
      if (contextCharCount >= MAX_CONTEXT_CHARS) {
        truncated = true;
        break;
      }
    }
    if (fileCount >= MAX_FILES || contextCharCount >= MAX_CONTEXT_CHARS) {
      truncated = true;
      break;
    }
  }

  if (fileCount === 0) throw new Error(t('No changes to generate a commit message from.'));
  const context = lines.join('\n');
  const text = context.length > MAX_CONTEXT_CHARS
    ? `${context.slice(0, MAX_CONTEXT_CHARS)}\n...`
    : context;
  return {
    text,
    repoRootPaths: [repo.rootPath],
    vcsKinds: ['git'],
    repositoryCount: 1,
    fileCount,
    contextCharCount: text.length,
    truncated,
  };
}

export async function generateHistoricalCommitMessage(
  options: HistoricalCommitMessageGenerationOptions,
): Promise<string> {
  const context = await buildContext(options.repo, options.hashes, options.cancellationToken);
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

    options.logger?.info('AICommitMessage', `Generated historical commit message\n${result.message}`);
    options.logger?.info('AICommitMessage', 'Historical generation completed', {
      requestId: options.requestId,
      provider: result.provider,
      model: result.model,
      promptSource: result.promptSource,
      inputCharCount: result.inputCharCount,
      inputTruncated: result.inputTruncated,
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
