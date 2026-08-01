import { TokenBudgetTextBuilder } from './inputTokenBudget';

export interface FairContextEntry {
  summary: string;
  detailBlocks: string[][];
}

export interface FairContextGroup {
  headingLines: string[];
  entries: FairContextEntry[];
}

export interface FairContextResult {
  text: string;
  truncated: boolean;
  includedEntryCount: number;
}

function appendLines(builder: TokenBudgetTextBuilder, lines: string[]): boolean {
  for (const line of lines) {
    if (!builder.append(line)) return false;
  }
  return true;
}

/**
 * Writes every group and file summary first, then adds one detail block from
 * each file per round so an early large file cannot consume the whole budget.
 */
export function buildFairContext(
  preambleLines: string[],
  groups: FairContextGroup[],
  tokenBudget: number,
): FairContextResult {
  const builder = new TokenBudgetTextBuilder(tokenBudget);
  let includedEntryCount = 0;
  if (!appendLines(builder, preambleLines)) {
    return { text: builder.toString(), truncated: true, includedEntryCount };
  }

  for (const group of groups) {
    if (!appendLines(builder, ['', ...group.headingLines])) {
      return { text: builder.toString(), truncated: true, includedEntryCount };
    }
    for (const entry of group.entries) {
      if (!builder.append(entry.summary)) {
        return { text: builder.toString(), truncated: true, includedEntryCount };
      }
      includedEntryCount++;
    }
  }

  const entries = groups.flatMap(group => group.entries);
  const detailRoundCount = entries.reduce((maximum, entry) => Math.max(maximum, entry.detailBlocks.length), 0);
  if (detailRoundCount === 0) {
    return { text: builder.toString(), truncated: false, includedEntryCount };
  }
  if (!appendLines(builder, ['', '# Diff details'])) {
    return { text: builder.toString(), truncated: true, includedEntryCount };
  }

  for (let round = 0; round < detailRoundCount; round++) {
    for (const entry of entries) {
      const block = entry.detailBlocks[round];
      if (!block) continue;
      if (!appendLines(builder, ['', ...block])) {
        return { text: builder.toString(), truncated: true, includedEntryCount };
      }
    }
  }
  return { text: builder.toString(), truncated: false, includedEntryCount };
}

export function getFairDetailBlockTokenBudget(totalTokenBudget: number, entryCount: number): number {
  const fairShare = Math.floor(totalTokenBudget / Math.max(1, entryCount * 2));
  return Math.max(256, Math.min(8_192, fairShare));
}
