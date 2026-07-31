import type * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { DiffLine, FileDiff } from '../types/git';
import type {
  AiCommitExplanationContext,
  AiCommitExplanationMode,
  CommitExplanationCommit,
} from './types';

const MAX_FILES = 100;
const MAX_LINES_PER_FILE = 80;
const MAX_HUNKS_PER_FILE = 8;
const LINES_AROUND_CHANGE = 3;
const MAX_CONTEXT_CHARS = 64_000;

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

function formatDiffLine(line: DiffLine): string {
  if (line.type === 'add') return `+${line.content}`;
  if (line.type === 'remove') return `-${line.content}`;
  return ` ${line.content}`;
}

function summarizeDiff(diff: FileDiff | null): { lines: string[]; truncated: boolean } {
  if (!diff) return { lines: ['  [diff unavailable]'], truncated: false };
  if (diff.isBinary) return { lines: ['  [binary file]'], truncated: false };

  const lines: string[] = [];
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
      if (previousIndex !== undefined && index > previousIndex + 1) lines.push('  ...');
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
  return { lines: lines.length > 0 ? lines : ['  [no textual diff]'], truncated };
}

function formatFileStats(file: CommitExplanationCommit['files'][number]): string {
  const stats = [
    file.added === undefined ? '' : `+${file.added}`,
    file.removed === undefined ? '' : `-${file.removed}`,
  ].filter(Boolean).join(' ');
  return stats ? ` (${stats})` : '';
}

export async function buildCommitExplanationContext(
  manager: WorkspaceGitManager,
  mode: AiCommitExplanationMode,
  commits: CommitExplanationCommit[],
  cancellationToken: vscode.CancellationToken,
): Promise<AiCommitExplanationContext> {
  const lines: string[] = [];
  const repoRootPaths = new Set<string>();
  const vcsKinds = new Set<'git' | 'svn'>();
  const repoIds = new Set<string>();
  let contextCharCount = 0;
  let fileCount = 0;
  let truncated = false;

  const appendLine = (line: string): boolean => {
    const separatorLength = lines.length === 0 ? 0 : 1;
    const remaining = MAX_CONTEXT_CHARS - contextCharCount - separatorLength;
    if (remaining <= 0) {
      truncated = true;
      return false;
    }
    if (line.length > remaining) {
      lines.push(`${line.slice(0, Math.max(0, remaining - 3))}...`);
      contextCharCount = MAX_CONTEXT_CHARS;
      truncated = true;
      return false;
    }
    lines.push(line);
    contextCharCount += separatorLength + line.length;
    return true;
  };

  appendLine(`Mode: ${mode}`);
  appendLine(`Commit count: ${commits.length}`);

  for (let commitIndex = 0; commitIndex < commits.length; commitIndex++) {
    throwIfCancelled(cancellationToken);
    const commit = commits[commitIndex];
    const repo = manager.getRepo(commit.repoId);
    if (!repo) continue;

    repoRootPaths.add(commit.repoRootPath);
    vcsKinds.add(commit.vcsKind);
    repoIds.add(commit.repoId);
    if (!appendLine('')) break;
    if (!appendLine(`## Commit ${commitIndex + 1}: ${commit.shortHash}`)) break;
    if (!appendLine(`Repository: ${commit.repoName} (${commit.vcsKind.toUpperCase()})`)) break;
    if (!appendLine(`Author: ${commit.authorName}`)) break;
    if (!appendLine(`Date: ${commit.authorDate}`)) break;
    if (!appendLine('Message:')) break;
    if (!appendLine(commit.fullMessage.trim() || '(empty)')) break;
    if (!appendLine('Changed files:')) break;

    for (const file of commit.files) {
      throwIfCancelled(cancellationToken);
      if (fileCount >= MAX_FILES) {
        truncated = true;
        break;
      }
      fileCount += 1;
      if (!appendLine(`${file.status.toUpperCase()} ${file.path}${formatFileStats(file)}`)) break;

      const diff = await repo.getFileDiff(commit.repoId, commit.hash, file.path).catch(() => null);
      throwIfCancelled(cancellationToken);
      const summary = summarizeDiff(diff);
      if (summary.truncated) truncated = true;
      for (const line of summary.lines) {
        if (!appendLine(line)) break;
      }
      if (contextCharCount >= MAX_CONTEXT_CHARS) break;
    }
    if (fileCount >= MAX_FILES || contextCharCount >= MAX_CONTEXT_CHARS) break;
  }

  return {
    mode,
    text: lines.join('\n'),
    repoRootPaths: Array.from(repoRootPaths),
    vcsKinds: Array.from(vcsKinds),
    repositoryCount: repoIds.size,
    commitCount: commits.length,
    fileCount,
    contextCharCount,
    truncated,
  };
}
