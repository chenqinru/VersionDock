import type { DiffLine, FileDiff } from '../types/git';
import { estimateTokenCount, splitLinesByTokenBudget } from './tokenBudget';

export interface DiffContextOptions {
  linesAroundChange?: number;
  unavailableLine?: string;
  binaryLine?: string;
  noTextLine?: string;
}

export function countDiffChanges(diff: FileDiff | null): { added: number; removed: number } {
  if (!diff || diff.isBinary) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.type === 'add') added++;
      else if (line.type === 'remove') removed++;
    }
  }
  return { added, removed };
}

export function formatDiffStats(diff: FileDiff | null, fallback?: { added?: number; removed?: number }): string {
  const counted = countDiffChanges(diff);
  const useCountedStats = !!diff && !diff.isBinary && diff.hunks.length > 0;
  const added = useCountedStats ? counted.added : fallback?.added ?? (diff ? counted.added : undefined);
  const removed = useCountedStats ? counted.removed : fallback?.removed ?? (diff ? counted.removed : undefined);
  const stats = [
    added === undefined ? '' : `+${added}`,
    removed === undefined ? '' : `-${removed}`,
  ].filter(Boolean).join(' ');
  return stats ? ` (${stats})` : '';
}

function formatDiffLine(line: DiffLine): string {
  if (line.type === 'add') return `+${line.content}`;
  if (line.type === 'remove') return `-${line.content}`;
  return ` ${line.content}`;
}

function selectHunkLines(hunk: FileDiff['hunks'][number], linesAroundChange: number): string[] {
  const includedLineIndexes = new Set<number>();
  for (let index = 0; index < hunk.lines.length; index++) {
    if (hunk.lines[index].type === 'context') continue;
    const start = Math.max(0, index - linesAroundChange);
    const end = Math.min(hunk.lines.length - 1, index + linesAroundChange);
    for (let includedIndex = start; includedIndex <= end; includedIndex++) includedLineIndexes.add(includedIndex);
  }
  const lines: string[] = [];
  let previousIndex: number | undefined;
  for (const index of Array.from(includedLineIndexes).sort((left, right) => left - right)) {
    if (previousIndex !== undefined && index > previousIndex + 1) lines.push('...');
    lines.push(formatDiffLine(hunk.lines[index]));
    previousIndex = index;
  }
  return lines;
}

function makeBlocks(label: string, sectionLabel: string, lines: string[], tokenBudget: number): string[][] {
  const headingReserve = estimateTokenCount(`## ${label} · ${sectionLabel}`) + 16;
  const contentBudget = Math.max(64, tokenBudget - headingReserve);
  const chunks = splitLinesByTokenBudget(lines, contentBudget);
  return chunks.map((chunk, index) => [
    `## ${label} · ${sectionLabel}${chunks.length > 1 ? ` · part ${index + 1}/${chunks.length}` : ''}`,
    ...chunk.map(line => `  ${line}`),
  ]);
}

export function buildDiffDetailBlocks(
  label: string,
  diff: FileDiff | null,
  tokenBudget: number,
  options: DiffContextOptions = {},
): string[][] {
  if (!diff) return [[`## ${label}`, options.unavailableLine ?? '  [diff unavailable]']];
  if (diff.isBinary) return [[`## ${label}`, options.binaryLine ?? '  [binary file]']];

  const linesAroundChange = options.linesAroundChange ?? 3;
  const blocks: string[][] = [];
  for (let hunkIndex = 0; hunkIndex < diff.hunks.length; hunkIndex++) {
    const hunk = diff.hunks[hunkIndex];
    const selectedLines = selectHunkLines(hunk, linesAroundChange);
    if (!selectedLines.length) continue;
    blocks.push(...makeBlocks(
      label,
      `hunk ${hunkIndex + 1}/${diff.hunks.length} ${hunk.header}`,
      selectedLines,
      tokenBudget,
    ));
  }

  if (!blocks.length && diff.modifiedContent && !diff.originalContent) {
    const contentLines = diff.modifiedContent.split(/\r?\n/).filter(Boolean).map(line => `+${line}`);
    blocks.push(...makeBlocks(label, 'new content', contentLines, tokenBudget));
  }
  return blocks.length > 0
    ? blocks
    : [[`## ${label}`, options.noTextLine ?? '  [no textual diff]']];
}
