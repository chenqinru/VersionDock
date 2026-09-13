import type * as vscode from 'vscode';
import { buildDiffDetailBlocks, formatDiffStats } from '../ai/diffContext';
import { buildFairContext, getFairDetailBlockTokenBudget, type FairContextGroup } from '../ai/fairContext';
import { getContextTokenBudget } from '../ai/inputTokenBudget';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { FileDiff } from '../types/git';
import type {
  AiCommitExplanationContext,
  AiCommitExplanationMode,
  CommitExplanationCommit,
} from './types';

const LINES_AROUND_CHANGE = 3;

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

export async function buildCommitExplanationContext(
  manager: WorkspaceGitManager,
  mode: AiCommitExplanationMode,
  commits: CommitExplanationCommit[],
  maxInputTokens: number,
  cancellationToken: vscode.CancellationToken,
): Promise<AiCommitExplanationContext> {
  const contextTokenBudget = getContextTokenBudget(maxInputTokens);
  const preparedGroups: Array<{
    headingLines: string[];
    entries: Array<{ label: string; summary: string; diff: FileDiff | null }>;
  }> = [];
  const repoRootPaths = new Set<string>();
  const vcsKinds = new Set<'git' | 'svn'>();
  const repoIds = new Set<string>();
  const selectedPaths = new Set<string>();

  for (let commitIndex = 0; commitIndex < commits.length; commitIndex++) {
    throwIfCancelled(cancellationToken);
    const commit = commits[commitIndex];
    const repo = manager.getRepo(commit.repoId);
    if (!repo) continue;

    repoRootPaths.add(commit.repoRootPath);
    vcsKinds.add(commit.vcsKind);
    repoIds.add(commit.repoId);
    const entries: typeof preparedGroups[number]['entries'] = [];
    for (const file of commit.files) {
      throwIfCancelled(cancellationToken);
      selectedPaths.add(file.path);
      const diff = await repo.getFileDiff(commit.repoId, commit.hash, file.path).catch(() => null);
      throwIfCancelled(cancellationToken);
      const label = `${file.status.toUpperCase()} ${file.path}`;
      entries.push({ label, summary: `${label}${formatDiffStats(diff, file)}`, diff });
    }
    preparedGroups.push({
      headingLines: [
        `## Commit ${commitIndex + 1}: ${commit.shortHash}`,
        `Repository: ${commit.repoName} (${commit.vcsKind.toUpperCase()})`,
        `Author: ${commit.authorName}`,
        `Date: ${commit.authorDate}`,
        'Message:',
        commit.fullMessage.trim() || '(empty)',
        'Changed files:',
      ],
      entries,
    });
  }

  const entryCount = preparedGroups.reduce((total, group) => total + group.entries.length, 0);
  const detailBlockTokenBudget = getFairDetailBlockTokenBudget(contextTokenBudget, entryCount);
  const groups: FairContextGroup[] = preparedGroups.map(group => ({
    headingLines: group.headingLines,
    entries: group.entries.map(entry => ({
      summary: entry.summary,
      detailBlocks: buildDiffDetailBlocks(entry.label, entry.diff, detailBlockTokenBudget, {
        linesAroundChange: LINES_AROUND_CHANGE,
      }),
    })),
  }));
  const context = buildFairContext(
    [`Mode: ${mode}`, `Commit count: ${commits.length}`],
    groups,
    contextTokenBudget,
  );
  const text = context.text;

  return {
    mode,
    text,
    repoRootPaths: Array.from(repoRootPaths),
    selectedPaths: Array.from(selectedPaths),
    vcsKinds: Array.from(vcsKinds),
    repositoryCount: repoIds.size,
    commitCount: commits.length,
    fileCount: context.includedEntryCount,
    contextCharCount: text.length,
    truncated: context.truncated,
  };
}
