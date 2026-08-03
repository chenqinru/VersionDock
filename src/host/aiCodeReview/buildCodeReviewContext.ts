import * as crypto from 'crypto';
import type * as vscode from 'vscode';
import { buildFairContext, getFairDetailBlockTokenBudget, type FairContextGroup } from '../ai/fairContext';
import { getContextTokenBudget, splitLinesByTokenBudget } from '../ai/inputTokenBudget';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { FileDiff, FileStatus } from '../types/git';
import { t } from '../utils/l10n';
import type { CodeReviewAnchor, CodeReviewCandidate, CodeReviewContext, CodeReviewDiffSource } from './types';

const RELATED_CONTEXT_RADIUS = 1;
const MAX_RELATED_CHANGED_TOKENS = 32;
const MAX_RELATED_MATCH_LINES = 24;
const REVIEW_TOKEN_PATTERN = /[A-Za-z_$][A-Za-z0-9_$.:/-]{2,}/g;
const REVIEW_TOKEN_STOP_WORDS = new Set([
  'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default',
  'else', 'export', 'extends', 'false', 'final', 'finally', 'for', 'from', 'function', 'if',
  'implements', 'import', 'interface', 'let', 'new', 'null', 'number', 'object', 'package',
  'private', 'protected', 'public', 'return', 'static', 'string', 'super', 'switch', 'this',
  'throw', 'throws', 'true', 'try', 'undefined', 'var', 'void', 'while',
]);

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

function extractReviewTokens(value: string): string[] {
  const tokens = new Set<string>();
  for (const rawToken of value.match(REVIEW_TOKEN_PATTERN) ?? []) {
    const token = rawToken.replace(/[.:/-]+$/g, '').toLowerCase();
    if (token.length < 3 || token.length > 96 || REVIEW_TOKEN_STOP_WORDS.has(token)) continue;
    tokens.add(token);
  }
  return Array.from(tokens);
}

function collectChangedReviewTokens(diff: FileDiff): string[] {
  const added = new Set<string>();
  const removed = new Set<string>();
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'context') continue;
      const target = line.type === 'add' ? added : removed;
      for (const token of extractReviewTokens(line.content)) target.add(token);
    }
  }
  const changedOnly = new Set([
    ...Array.from(added).filter(token => !removed.has(token)),
    ...Array.from(removed).filter(token => !added.has(token)),
  ]);
  const retained = new Set([
    ...changedOnly,
    ...Array.from(added).filter(token => removed.has(token)),
  ]);
  return Array.from(retained)
    .sort((left, right) => Number(changedOnly.has(right)) - Number(changedOnly.has(left)) || right.length - left.length || left.localeCompare(right))
    .slice(0, MAX_RELATED_CHANGED_TOKENS);
}

function renderRelatedContextBlocks(diff: FileDiff, baseLabel: string, blockBudget: number): string[][] {
  if (diff.isBinary) return [];
  const useOriginal = diff.isDeleted || diff.modifiedContent === undefined;
  const snapshot = useOriginal ? diff.originalContent : diff.modifiedContent;
  if (!snapshot) return [];
  const changedTokens = collectChangedReviewTokens(diff);
  if (!changedTokens.length) return [];

  const changedLineNumbers = new Set<number>();
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      const lineNumber = useOriginal ? line.oldLineNo : line.newLineNo;
      if (lineNumber !== undefined) changedLineNumbers.add(lineNumber);
    }
  }

  const tokenRanks = new Map(changedTokens.map((token, index) => [token, index]));
  const snapshotLines = snapshot.split(/\r?\n/);
  const matches: Array<{ index: number; tokens: string[]; rank: number }> = [];
  for (let index = 0; index < snapshotLines.length; index++) {
    if (changedLineNumbers.has(index + 1)) continue;
    const lineTokens = new Set(extractReviewTokens(snapshotLines[index]));
    const tokens = changedTokens.filter(token => lineTokens.has(token));
    if (!tokens.length) continue;
    matches.push({
      index,
      tokens,
      rank: Math.min(...tokens.map(token => tokenRanks.get(token) ?? Number.MAX_SAFE_INTEGER)),
    });
  }
  const selectedMatches = matches
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .slice(0, MAX_RELATED_MATCH_LINES);
  if (!selectedMatches.length) return [];

  const matchedTokensByLine = new Map(selectedMatches.map(match => [match.index, match.tokens]));
  const includedIndexes = new Set<number>();
  for (const match of selectedMatches) {
    const start = Math.max(0, match.index - RELATED_CONTEXT_RADIUS);
    const end = Math.min(snapshotLines.length - 1, match.index + RELATED_CONTEXT_RADIUS);
    for (let index = start; index <= end; index++) {
      if (!changedLineNumbers.has(index + 1)) includedIndexes.add(index);
    }
  }
  const renderedLines = Array.from(includedIndexes)
    .sort((left, right) => left - right)
    .map(index => {
      const relatedTokens = matchedTokensByLine.get(index);
      const prefix = relatedTokens ? `[related:${relatedTokens.join(',')}]` : '          ';
      return `${prefix} line:${index + 1} | ${snapshotLines[index]}`;
    });
  const contentBudget = Math.max(128, blockBudget - 96);
  const chunks = splitLinesByTokenBudget(renderedLines, contentBudget);
  const snapshotLabel = useOriginal ? 'pre-change snapshot' : 'post-change snapshot';
  return chunks.map((chunk, index) => [
    `## ${baseLabel} · related unchanged lines in ${snapshotLabel}${chunks.length > 1 ? ` · part ${index + 1}/${chunks.length}` : ''}`,
    '  Same-file context only. Findings must still reference a changed [A…] anchor.',
    ...chunk.map(line => `  ${line}`),
  ]);
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
  if (!blocks.length) return [[`## ${baseLabel}`, '  [no textual diff]']];
  const relatedBlocks = renderRelatedContextBlocks(diff, baseLabel, blockBudget);
  return relatedBlocks.length ? [blocks[0], ...relatedBlocks, ...blocks.slice(1)] : blocks;
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
    'Sections labeled "related unchanged lines" contain bounded same-file evidence for cross-reference checks; they are context only, not finding anchors.',
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
