import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { buildFairContext, getFairDetailBlockTokenBudget, type FairContextGroup } from '../ai/fairContext';
import { getContextTokenBudget, splitLinesByTokenBudget } from '../ai/inputTokenBudget';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { FileDiff, FileStatus } from '../types/git';
import { t } from '../utils/l10n';
import type { CodeReviewAnchor, CodeReviewCandidate, CodeReviewContext, CodeReviewDiffSource } from './types';

function throwIfCancelled(token: vscode.CancellationToken): void {
  if (token.isCancellationRequested) throw new Error('Cancelled');
}

export function fingerprintDiff(diff: FileDiff | null): string {
  if (!diff) return crypto.createHash('sha256').update('missing').digest('hex');
  const text = JSON.stringify({
    oldPath: diff.oldPath,
    newPath: diff.newPath,
    isBinary: diff.isBinary,
    hunks: diff.hunks,
    originalContent: diff.originalContent,
    modifiedContent: diff.modifiedContent,
  });
  return crypto.createHash('sha256').update(text).digest('hex');
}

function mergeStatuses(status: { stagedFiles: FileStatus[]; unstagedFiles: FileStatus[] }): Map<string, FileStatus> {
  const files = new Map<string, FileStatus>();
  for (const file of [...status.stagedFiles, ...status.unstagedFiles]) {
    const existing = files.get(file.path);
    files.set(file.path, existing ? { ...existing, staged: existing.staged || file.staged, unstaged: existing.unstaged || file.unstaged } : file);
  }
  return files;
}

function renderAnchoredBlocks(
  diff: FileDiff | null,
  baseLabel: string,
  anchorPrefix: string,
  anchorCounter: { value: number },
  anchors: Map<string, CodeReviewAnchor>,
  anchorBase: Omit<CodeReviewAnchor, 'id' | 'oldLine' | 'newLine'>,
  blockBudget: number,
): string[][] {
  if (!diff) return [[`## ${baseLabel}`, '  [diff unavailable]']];
  if (diff.isBinary) return [[`## ${baseLabel}`, '  [binary file; textual review unavailable]']];
  const blocks: string[][] = [];
  for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
    const hunk = diff.hunks[hunkIndex];
    const lines = hunk.lines.map(line => {
      const prefix = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
      const oldLabel = line.oldLineNo === undefined ? '-' : String(line.oldLineNo);
      const newLabel = line.newLineNo === undefined ? '-' : String(line.newLineNo);
      if (line.type === 'context') return `       ${prefix} old:${oldLabel} new:${newLabel} | ${line.content}`;
      const id = `${anchorPrefix}${++anchorCounter.value}`;
      anchors.set(id, { ...anchorBase, id, oldLine: line.oldLineNo, newLine: line.newLineNo });
      return `[${id}] ${prefix} old:${oldLabel} new:${newLabel} | ${line.content}`;
    });
    const chunks = splitLinesByTokenBudget(lines, Math.max(128, blockBudget - 64));
    blocks.push(...chunks.map((chunk, chunkIndex) => [
      `## ${baseLabel} · hunk ${hunkIndex + 1}/${diff.hunks.length}${chunks.length > 1 ? ` · part ${chunkIndex + 1}/${chunks.length}` : ''}`,
      `  ${hunk.header}`,
      ...chunk.map(line => `  ${line}`),
    ]));
  }
  return blocks.length ? blocks : [[`## ${baseLabel}`, '  [no textual diff]']];
}

export async function buildCodeReviewContext(
  manager: WorkspaceGitManager,
  candidates: CodeReviewCandidate[],
  maxInputTokens: number,
  cancellationToken: vscode.CancellationToken,
): Promise<CodeReviewContext> {
  const workspaceStatus = await manager.getAllStatuses();
  const statusByRepo = new Map(workspaceStatus.repos.map(status => [status.repoId, status]));
  const metaByRepo = new Map(manager.getRepoMetas().map(meta => [meta.id, meta]));
  const prepared: Array<{
    headingLines: string[];
    entries: Array<{ summary: string; repoId: string; repoName: string; filePath: string; source: CodeReviewDiffSource; diff: FileDiff | null; rootPath: string; vcs: 'git' | 'svn' }>;
  }> = [];
  const repoRootPaths = new Set<string>();
  const vcsKinds = new Set<'git' | 'svn'>();
  const repoIds = new Set<string>();

  for (const candidate of candidates) {
    throwIfCancelled(cancellationToken);
    const repo = manager.getRepo(candidate.repoId);
    const status = statusByRepo.get(candidate.repoId);
    if (!repo || !status) continue;
    const meta = metaByRepo.get(candidate.repoId);
    const repoName = meta?.name ?? candidate.repoId;
    const rootPath = meta?.rootPath ?? repo.rootPath;
    const vcs = repo.kind === 'svn' ? 'svn' : 'git';
    const files = mergeStatuses(status);
    const entries: typeof prepared[number]['entries'] = [];
    for (const filePath of Array.from(new Set(candidate.paths))) {
      throwIfCancelled(cancellationToken);
      const file = files.get(filePath);
      if (!file) continue;
      const sources: CodeReviewDiffSource[] = vcs === 'svn'
        ? ['working']
        : candidate.stagedOnly ? (file.staged ? ['staged'] : []) : [
          ...(file.staged ? ['staged' as const] : []),
          ...(file.unstaged ? ['working' as const] : []),
        ];
      for (const source of sources) {
        const diff = source === 'staged'
          ? await repo.getStagedDiff(candidate.repoId, filePath).catch(() => null)
          : await repo.getUnstagedDiff(candidate.repoId, filePath).catch(() => null);
        entries.push({
          summary: `${file.status.toUpperCase()} ${filePath} [${source}]`,
          repoId: candidate.repoId,
          repoName,
          filePath,
          source,
          diff,
          rootPath,
          vcs,
        });
      }
    }
    if (entries.length) {
      prepared.push({ headingLines: [`[${vcs.toUpperCase()}] ${repoName}`, `Branch: ${status.branch.detachedTag ?? status.branch.detachedHash ?? status.branch.name}`], entries });
      repoRootPaths.add(rootPath);
      vcsKinds.add(vcs);
      repoIds.add(candidate.repoId);
    }
  }

  const entryCount = prepared.reduce((sum, group) => sum + group.entries.length, 0);
  if (!entryCount) throw new Error(t('No selected changes are available for AI Code Review.'));
  const tokenBudget = getContextTokenBudget(maxInputTokens);
  const blockBudget = getFairDetailBlockTokenBudget(tokenBudget, entryCount);
  const anchors = new Map<string, CodeReviewAnchor>();
  const anchorCounter = { value: 0 };
  const groups: FairContextGroup[] = prepared.map(group => ({
    headingLines: group.headingLines,
    entries: group.entries.map(entry => {
      const fingerprint = fingerprintDiff(entry.diff);
      return {
        summary: entry.summary,
        detailBlocks: renderAnchoredBlocks(
          entry.diff,
          `${entry.filePath} [${entry.source}]`,
          'A',
          anchorCounter,
          anchors,
          { repoId: entry.repoId, repoName: entry.repoName, filePath: entry.filePath, source: entry.source, fingerprint },
          blockBudget,
        ),
      };
    }),
  }));
  const context = buildFairContext([
    '# Selected uncommitted changes',
    'Only report findings that reference one of the visible [A…] anchors.',
  ], groups, tokenBudget);
  const visibleAnchors = new Map(Array.from(anchors).filter(([id]) => context.text.includes(`[${id}]`)));
  return {
    text: context.text,
    repoRootPaths: Array.from(repoRootPaths),
    vcsKinds: Array.from(vcsKinds),
    repositoryCount: repoIds.size,
    fileCount: entryCount,
    contextCharCount: context.text.length,
    truncated: context.truncated,
    anchors: visibleAnchors,
  };
}
