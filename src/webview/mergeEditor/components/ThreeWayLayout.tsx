import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { HighlighterCore, SpecialLanguage, ThemeRegistrationRaw } from 'shiki/core';
import type { ConflictBlock, MergeConflictFile } from '../../shared/types';
import type { NormalEdits, Resolution } from '../store/mergeStore';
import { t } from '../../shared/i18n';
import { getVersionDockColorTheme, type WebviewColorThemeData } from '../../shared/colorTheme';
import { useShiki } from '../../shared/useShiki';
import { Codicon } from '../../shared/Codicon';

interface Props {
  file: MergeConflictFile;
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  nonConflictingSelections: NonConflictingSelections;
  language: string;
  onResultChange: (content: string) => void;
  onResolveBlock: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
  onSelectNonConflicting: (blockIndex: number, selection: NonConflictingSelection | 'base') => void;
  currentConflictIndex: number;
  syncScrollEnabled: boolean;
}

type Segment = NormalSegment | ConflictSegment;
interface NormalSegment { kind: 'normal'; lines: string[] }
interface ConflictSegment { kind: 'conflict'; index: number; block: ConflictBlock }
type PaneSide = 'left' | 'center' | 'right';
export type NonConflictingChangeScope = 'left' | 'all' | 'right';
export type NonConflictingSelection = 'left' | 'right';
export type NonConflictingSelections = Record<number, NonConflictingSelection>;

type MergeBlockState = 'equal' | 'modified_left' | 'modified_right' | 'modified_both' | 'conflict';

interface SideChange {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

interface LineMatch {
  baseIndex: number;
  sideIndex: number;
}

interface ThreeWayBlock {
  state: MergeBlockState;
  baseLines: string[];
  leftLines: string[];
  rightLines: string[];
}

interface NormalBlockRef {
  blockIndex: number;
  block: ThreeWayBlock;
}

const CODE_LINE_HEIGHT = 21;
const CONNECTOR_GUTTER_WIDTH = 'clamp(40px, 3vw, 48px)';
const MERGE_SCROLLBAR_STYLES = `
  .versiondock-merge-pane {
    scrollbar-width: none !important;
    -ms-overflow-style: none;
  }
  .versiondock-merge-pane::-webkit-scrollbar {
    width: 0 !important;
    height: 0 !important;
    display: none !important;
    background: transparent !important;
  }
  .versiondock-merge-pane::-webkit-scrollbar-track,
  .versiondock-merge-pane::-webkit-scrollbar-track-piece,
  .versiondock-merge-pane::-webkit-scrollbar-thumb,
  .versiondock-merge-pane::-webkit-scrollbar-corner {
    display: none !important;
    background: transparent !important;
  }
  .versiondock-block-action-button {
    background: transparent !important;
    border-color: transparent !important;
  }
  .versiondock-block-action-button--accept:hover:not(:disabled) {
    background: color-mix(in srgb, var(--vscode-foreground) 9%, transparent) !important;
    color: var(--vscode-textLink-activeForeground, var(--vscode-foreground)) !important;
    opacity: 1 !important;
  }
  .versiondock-block-action-button--reset {
    border-left-color: color-mix(in srgb, var(--vscode-foreground) 14%, transparent) !important;
    color: var(--vscode-descriptionForeground, var(--vscode-foreground)) !important;
  }
  .versiondock-block-action-button--reset:hover:not(:disabled) {
    background: color-mix(in srgb, var(--vscode-foreground) 9%, transparent) !important;
    color: var(--vscode-foreground) !important;
    opacity: 1 !important;
  }
  .versiondock-block-action-button:active:not(:disabled) {
    opacity: 0.68 !important;
  }
  .versiondock-block-action-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
`;
const MAX_STABLE_LCS_CELLS = 1_000_000;
// Exact LCS remains quadratic in time even with linear-space reconstruction.
// Above this budget we conservatively treat the changed middle as one block.
// That can disable the convenience "apply non-conflicting" action for a very
// large divergent file, but it cannot silently apply a wrong merge result.
const MAX_EXACT_DIFF_CELLS = 4_000_000;

function splitConflictSegments(content: string, file: MergeConflictFile): Segment[] {
  const threeWayBlocks = compatibleThreeWayBlocks(file);
  if (threeWayBlocks) {
    const segments: Segment[] = [];
    let normalLines: string[] = [];
    let hasNormalBlock = false;
    let conflictIndex = 0;

    const flushNormal = () => {
      if (!hasNormalBlock) return;
      segments.push({ kind: 'normal', lines: normalLines });
      normalLines = [];
      hasNormalBlock = false;
    };

    threeWayBlocks.forEach(block => {
      if (block.state !== 'conflict') {
        normalLines.push(...block.baseLines);
        hasNormalBlock = true;
        return;
      }

      flushNormal();
      const parsedBlock = file.conflicts[conflictIndex];
      if (parsedBlock) {
        segments.push({
          kind: 'conflict',
          index: conflictIndex,
          block: {
            ...parsedBlock,
            oursLines: block.leftLines,
            baseLines: block.baseLines,
            theirsLines: block.rightLines,
          },
        });
      }
      conflictIndex += 1;
    });
    flushNormal();
    return segments;
  }

  const lines = content.split('\n');
  const segments: Segment[] = [];
  let normal: string[] = [];
  let i = 0;
  let conflictIndex = 0;

  while (i < lines.length) {
    if (!lines[i].startsWith('<<<<<<<')) {
      normal.push(lines[i]);
      i += 1;
      continue;
    }

    if (normal.length > 0) {
      segments.push({ kind: 'normal', lines: normal });
      normal = [];
    }

    const block = file.conflicts[conflictIndex];
    i += 1;
    while (i < lines.length && !lines[i].startsWith('=======') && !lines[i].startsWith('|||||||')) i += 1;
    while (i < lines.length && !lines[i].startsWith('=======')) i += 1;
    if (i < lines.length && lines[i].startsWith('=======')) i += 1;
    while (i < lines.length && !lines[i].startsWith('>>>>>>>')) i += 1;
    if (i < lines.length && lines[i].startsWith('>>>>>>>')) i += 1;

    if (block) segments.push({ kind: 'conflict', index: conflictIndex, block });
    conflictIndex += 1;
  }

  if (normal.length > 0) segments.push({ kind: 'normal', lines: normal });
  return segments;
}

function linesEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((line, index) => line === right[index]);
}

function changedLineFlags(baseLines: string[], displayedLines: string[]): boolean[] {
  const matchedLines = new Set(findLineMatches(baseLines, displayedLines).map(match => match.sideIndex));
  return displayedLines.map((_, index) => !matchedLines.has(index));
}

function splitLines(content: string): string[] {
  return content.split('\n');
}

function lcsPrefixLengths(
  left: string[], leftStart: number, leftEnd: number,
  right: string[], rightStart: number, rightEnd: number,
): Uint32Array {
  const rightLength = rightEnd - rightStart;
  let previous = new Uint32Array(rightLength + 1);
  let current = new Uint32Array(rightLength + 1);

  for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
    current[0] = 0;
    for (let offset = 1; offset <= rightLength; offset += 1) {
      current[offset] = left[leftIndex] === right[rightStart + offset - 1]
        ? previous[offset - 1] + 1
        : Math.max(previous[offset], current[offset - 1]);
    }
    [previous, current] = [current, previous];
  }

  return previous;
}

function lcsSuffixLengths(
  left: string[], leftStart: number, leftEnd: number,
  right: string[], rightStart: number, rightEnd: number,
): Uint32Array {
  const rightLength = rightEnd - rightStart;
  let previous = new Uint32Array(rightLength + 1);
  let current = new Uint32Array(rightLength + 1);

  for (let leftIndex = leftEnd - 1; leftIndex >= leftStart; leftIndex -= 1) {
    current[rightLength] = 0;
    for (let offset = rightLength - 1; offset >= 0; offset -= 1) {
      current[offset] = left[leftIndex] === right[rightStart + offset]
        ? previous[offset + 1] + 1
        : Math.max(previous[offset], current[offset + 1]);
    }
    [previous, current] = [current, previous];
  }

  return previous;
}

function findLcsSplit(
  left: string[], leftStart: number, leftMid: number, leftEnd: number,
  right: string[], rightStart: number, rightEnd: number,
): number {
  const prefix = lcsPrefixLengths(left, leftStart, leftMid, right, rightStart, rightEnd);
  const suffix = lcsSuffixLengths(left, leftMid, leftEnd, right, rightStart, rightEnd);
  let bestOffset = 0;
  let bestScore = -1;

  for (let offset = 0; offset < prefix.length; offset += 1) {
    const score = prefix[offset] + suffix[offset];
    if (score > bestScore) {
      bestScore = score;
      bestOffset = offset;
    }
  }
  return rightStart + bestOffset;
}

function collectLcsMatches(
  left: string[], leftStart: number, leftEnd: number,
  right: string[], rightStart: number, rightEnd: number,
  output: Array<{ leftIndex: number; rightIndex: number }>,
): void {
  if (leftStart >= leftEnd || rightStart >= rightEnd) return;

  if (leftEnd - leftStart === 1) {
    for (let rightIndex = rightStart; rightIndex < rightEnd; rightIndex += 1) {
      if (left[leftStart] === right[rightIndex]) {
        output.push({ leftIndex: leftStart, rightIndex });
        break;
      }
    }
    return;
  }

  if (rightEnd - rightStart === 1) {
    for (let leftIndex = leftStart; leftIndex < leftEnd; leftIndex += 1) {
      if (left[leftIndex] === right[rightStart]) {
        output.push({ leftIndex, rightIndex: rightStart });
        break;
      }
    }
    return;
  }

  const leftMid = leftStart + Math.floor((leftEnd - leftStart) / 2);
  const rightMid = findLcsSplit(left, leftStart, leftMid, leftEnd, right, rightStart, rightEnd);
  collectLcsMatches(left, leftStart, leftMid, right, rightStart, rightMid, output);
  collectLcsMatches(left, leftMid, leftEnd, right, rightMid, rightEnd, output);
}

function findStableLineMatches(baseLines: string[], sideLines: string[]): LineMatch[] {
  const columnCount = sideLines.length + 1;
  const table = new Uint32Array((baseLines.length + 1) * columnCount);
  const cell = (baseIndex: number, sideIndex: number) => baseIndex * columnCount + sideIndex;

  for (let baseIndex = baseLines.length - 1; baseIndex >= 0; baseIndex -= 1) {
    for (let sideIndex = sideLines.length - 1; sideIndex >= 0; sideIndex -= 1) {
      table[cell(baseIndex, sideIndex)] = baseLines[baseIndex] === sideLines[sideIndex]
        ? table[cell(baseIndex + 1, sideIndex + 1)] + 1
        : Math.max(table[cell(baseIndex + 1, sideIndex)], table[cell(baseIndex, sideIndex + 1)]);
    }
  }

  const matches: LineMatch[] = [];
  const preferSkippingSide = sideLines.length >= baseLines.length;
  let baseIndex = 0;
  let sideIndex = 0;
  while (baseIndex < baseLines.length && sideIndex < sideLines.length) {
    if (
      baseLines[baseIndex] === sideLines[sideIndex]
      && table[cell(baseIndex, sideIndex)] === table[cell(baseIndex + 1, sideIndex + 1)] + 1
    ) {
      matches.push({ baseIndex, sideIndex });
      baseIndex += 1;
      sideIndex += 1;
      continue;
    }

    const skipBaseScore = table[cell(baseIndex + 1, sideIndex)];
    const skipSideScore = table[cell(baseIndex, sideIndex + 1)];
    if (skipSideScore > skipBaseScore || (skipSideScore === skipBaseScore && preferSkippingSide)) sideIndex += 1;
    else baseIndex += 1;
  }
  return matches;
}

function findLineMatches(baseLines: string[], sideLines: string[]): LineMatch[] {
  if ((baseLines.length + 1) * (sideLines.length + 1) <= MAX_STABLE_LCS_CELLS) {
    return findStableLineMatches(baseLines, sideLines);
  }

  if (sideLines.length <= baseLines.length) {
    const matches: Array<{ leftIndex: number; rightIndex: number }> = [];
    collectLcsMatches(baseLines, 0, baseLines.length, sideLines, 0, sideLines.length, matches);
    return matches.map(match => ({ baseIndex: match.leftIndex, sideIndex: match.rightIndex }));
  }

  // Hirschberg uses O(length of the right sequence) memory, so swap the
  // sequences when the side is longer and map the coordinates back.
  const matches: Array<{ leftIndex: number; rightIndex: number }> = [];
  collectLcsMatches(sideLines, 0, sideLines.length, baseLines, 0, baseLines.length, matches);
  return matches.map(match => ({ baseIndex: match.rightIndex, sideIndex: match.leftIndex }));
}

function shiftPureDeletionToLaterBoundary(baseLines: string[], change: SideChange): SideChange {
  if (change.lines.length > 0 || change.baseStart >= change.baseEnd) return change;

  let baseStart = change.baseStart;
  let baseEnd = change.baseEnd;
  // Repeated structural lines such as `}` followed by a blank line can make an
  // LCS attach a deletion to the preceding method. Shift equal boundary lines
  // forward so the deleted block keeps its complete trailing structure, which
  // matches JetBrains' merge-view cleanup without changing the resulting text.
  while (baseEnd < baseLines.length && baseLines[baseStart] === baseLines[baseEnd]) {
    baseStart += 1;
    baseEnd += 1;
  }
  return { ...change, baseStart, baseEnd };
}

export function diffLineChanges(baseLines: string[], sideLines: string[]): SideChange[] {
  const baseLength = baseLines.length;
  const sideLength = sideLines.length;
  let prefixLength = 0;
  while (
    prefixLength < baseLength
    && prefixLength < sideLength
    && baseLines[prefixLength] === sideLines[prefixLength]
  ) {
    prefixLength += 1;
  }

  let suffixLength = 0;
  while (
    suffixLength < baseLength - prefixLength
    && suffixLength < sideLength - prefixLength
    && baseLines[baseLength - suffixLength - 1] === sideLines[sideLength - suffixLength - 1]
  ) {
    suffixLength += 1;
  }

  const baseMiddleEnd = baseLength - suffixLength;
  const sideMiddleEnd = sideLength - suffixLength;
  if (prefixLength === baseMiddleEnd && prefixLength === sideMiddleEnd) return [];

  const baseMiddle = baseLines.slice(prefixLength, baseMiddleEnd);
  const sideMiddle = sideLines.slice(prefixLength, sideMiddleEnd);
  if (baseMiddle.length > 0 && sideMiddle.length > Math.floor(MAX_EXACT_DIFF_CELLS / baseMiddle.length)) {
    return [{ baseStart: prefixLength, baseEnd: baseMiddleEnd, lines: sideMiddle }]
      .map(change => shiftPureDeletionToLaterBoundary(baseLines, change));
  }

  const matches = findLineMatches(baseMiddle, sideMiddle);
  const changes: SideChange[] = [];
  let baseCursor = 0;
  let sideCursor = 0;

  for (const match of matches) {
    if (baseCursor < match.baseIndex || sideCursor < match.sideIndex) {
      changes.push({
        baseStart: prefixLength + baseCursor,
        baseEnd: prefixLength + match.baseIndex,
        lines: sideMiddle.slice(sideCursor, match.sideIndex),
      });
    }
    baseCursor = match.baseIndex + 1;
    sideCursor = match.sideIndex + 1;
  }

  if (baseCursor < baseMiddle.length || sideCursor < sideMiddle.length) {
    changes.push({
      baseStart: prefixLength + baseCursor,
      baseEnd: baseMiddleEnd,
      lines: sideMiddle.slice(sideCursor),
    });
  }

  return changes.map(change => shiftPureDeletionToLaterBoundary(baseLines, change));
}

function applyRegionChanges(baseLines: string[], changes: SideChange[], start: number, end: number): string[] {
  const output: string[] = [];
  let cursor = start;

  for (const change of changes) {
    if (change.baseStart > cursor) output.push(...baseLines.slice(cursor, change.baseStart));
    output.push(...change.lines);
    cursor = Math.max(cursor, change.baseEnd);
  }

  if (cursor < end) output.push(...baseLines.slice(cursor, end));
  return output;
}

function createThreeWayBlock(baseLines: string[], leftLines: string[], rightLines: string[]): ThreeWayBlock {
  const leftChanged = !linesEqual(baseLines, leftLines);
  const rightChanged = !linesEqual(baseLines, rightLines);
  let state: MergeBlockState = 'equal';

  if (leftChanged && rightChanged && linesEqual(leftLines, rightLines)) state = 'modified_both';
  else if (leftChanged && !rightChanged) state = 'modified_left';
  else if (!leftChanged && rightChanged) state = 'modified_right';
  else if (leftChanged && rightChanged) state = 'conflict';

  return { state, baseLines, leftLines, rightLines };
}

function parseThreeWayBlocks(file: MergeConflictFile): ThreeWayBlock[] | null {
  // Empty content is a valid side of add/delete conflicts; only an absent
  // version means three-way analysis is unavailable.
  if (file.baseContent === undefined || file.oursContent === undefined || file.theirsContent === undefined) return null;

  const baseLines = splitLines(file.baseContent);
  const leftChanges = diffLineChanges(baseLines, splitLines(file.oursContent));
  const rightChanges = diffLineChanges(baseLines, splitLines(file.theirsContent));
  const blocks: ThreeWayBlock[] = [];

  let baseCursor = 0;
  let leftCursor = 0;
  let rightCursor = 0;

  while (leftCursor < leftChanges.length || rightCursor < rightChanges.length) {
    const nextLeftStart = leftChanges[leftCursor]?.baseStart ?? Number.POSITIVE_INFINITY;
    const nextRightStart = rightChanges[rightCursor]?.baseStart ?? Number.POSITIVE_INFINITY;
    const regionStart = Math.min(nextLeftStart, nextRightStart);

    if (regionStart === Number.POSITIVE_INFINITY) break;
    if (baseCursor < regionStart) {
      const equalLines = baseLines.slice(baseCursor, regionStart);
      blocks.push(createThreeWayBlock(equalLines, equalLines, equalLines));
      baseCursor = regionStart;
    }

    let regionEnd = regionStart;
    let scanLeft = leftCursor;
    let scanRight = rightCursor;
    const leftRegionChanges: SideChange[] = [];
    const rightRegionChanges: SideChange[] = [];
    let expanded = true;

    while (expanded) {
      expanded = false;
      while (scanLeft < leftChanges.length && leftChanges[scanLeft].baseStart <= regionEnd) {
        const change = leftChanges[scanLeft];
        leftRegionChanges.push(change);
        regionEnd = Math.max(regionEnd, change.baseEnd);
        scanLeft += 1;
        expanded = true;
      }
      while (scanRight < rightChanges.length && rightChanges[scanRight].baseStart <= regionEnd) {
        const change = rightChanges[scanRight];
        rightRegionChanges.push(change);
        regionEnd = Math.max(regionEnd, change.baseEnd);
        scanRight += 1;
        expanded = true;
      }
    }

    const baseRegionLines = baseLines.slice(regionStart, regionEnd);
    const leftRegionLines = leftRegionChanges.length > 0
      ? applyRegionChanges(baseLines, leftRegionChanges, regionStart, regionEnd)
      : baseRegionLines;
    const rightRegionLines = rightRegionChanges.length > 0
      ? applyRegionChanges(baseLines, rightRegionChanges, regionStart, regionEnd)
      : baseRegionLines;

    blocks.push(createThreeWayBlock(baseRegionLines, leftRegionLines, rightRegionLines));
    leftCursor = scanLeft;
    rightCursor = scanRight;
    baseCursor = regionEnd;
  }

  if (baseCursor < baseLines.length) {
    const equalLines = baseLines.slice(baseCursor);
    blocks.push(createThreeWayBlock(equalLines, equalLines, equalLines));
  }

  return blocks;
}

function isApplicableNonConflictingBlock(block: ThreeWayBlock): boolean {
  return block.state === 'modified_left' || block.state === 'modified_right' || block.state === 'modified_both';
}

function nonConflictingResultLines(block: ThreeWayBlock, selection?: NonConflictingSelection): string[] {
  if (selection === 'left') return block.leftLines;
  if (selection === 'right') return block.rightLines;
  return block.baseLines;
}

function compatibleThreeWayBlocks(file: MergeConflictFile): ThreeWayBlock[] | null {
  const blocks = parseThreeWayBlocks(file);
  if (!blocks) return null;
  const parsedConflictCount = blocks.filter(block => block.state === 'conflict').length;
  return parsedConflictCount === file.conflicts.length ? blocks : null;
}

function normalSegmentRefs(segments: Segment[]): Array<{ segmentIndex: number; groupIndex: number }> {
  let groupIndex = 0;
  const refs: Array<{ segmentIndex: number; groupIndex: number }> = [];

  segments.forEach((segment, segmentIndex) => {
    if (segment.kind === 'normal') refs.push({ segmentIndex, groupIndex });
    else groupIndex = segment.index + 1;
  });

  return refs;
}

export function getMergeToolbarCounts(file: MergeConflictFile): { changeCount: number; conflictCount: number; nonConflictingCount: number } {
  const conflictCount = file.conflicts.length;
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return { changeCount: 0, conflictCount, nonConflictingCount: 0 };

  const nonConflictingCount = blocks.filter(isApplicableNonConflictingBlock).length;

  return {
    changeCount: nonConflictingCount,
    conflictCount,
    nonConflictingCount,
  };
}

export function buildNonConflictingSelectionsForScope(file: MergeConflictFile, scope: NonConflictingChangeScope): NonConflictingSelections | null {
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return null;

  const selections: NonConflictingSelections = {};
  blocks.forEach((block, blockIndex) => {
    if (block.state === 'modified_left' && scope !== 'right') selections[blockIndex] = 'left';
    else if (block.state === 'modified_right' && scope !== 'left') selections[blockIndex] = 'right';
    else if (block.state === 'modified_both') selections[blockIndex] = scope === 'right' ? 'right' : 'left';
  });
  return selections;
}

export function buildNormalEditsForNonConflictingSelections(file: MergeConflictFile, selections: NonConflictingSelections): NormalEdits | null {
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return null;

  const groups = Array.from({ length: file.conflicts.length + 1 }, () => [] as string[]);
  let groupIndex = 0;

  blocks.forEach((block, blockIndex) => {
    if (block.state === 'conflict') {
      groupIndex += 1;
      return;
    }
    groups[Math.min(groupIndex, groups.length - 1)].push(...nonConflictingResultLines(block, selections[blockIndex]));
  });

  const refs = normalSegmentRefs(splitConflictSegments(file.content, file));
  const representedGroups = new Set(refs.map(ref => ref.groupIndex));
  const hasUnrepresentedContent = groups.some((lines, index) => lines.length > 0 && !representedGroups.has(index));
  if (hasUnrepresentedContent) return null;

  const nextEdits: NormalEdits = {};
  refs.forEach(ref => {
    nextEdits[ref.segmentIndex] = groups[ref.groupIndex] ?? [];
  });

  return nextEdits;
}

export function buildNormalEditsForNonConflictingScope(file: MergeConflictFile, scope: NonConflictingChangeScope): NormalEdits | null {
  const selections = buildNonConflictingSelectionsForScope(file, scope);
  return selections ? buildNormalEditsForNonConflictingSelections(file, selections) : null;
}

export function buildBaseNormalEdits(file: MergeConflictFile): NormalEdits | null {
  return buildNormalEditsForNonConflictingSelections(file, {});
}

function buildNormalBlockRefs(file: MergeConflictFile): Record<number, NormalBlockRef[]> | null {
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return null;

  const groups = Array.from({ length: file.conflicts.length + 1 }, () => [] as NormalBlockRef[]);
  let groupIndex = 0;
  blocks.forEach((block, blockIndex) => {
    if (block.state === 'conflict') {
      groupIndex += 1;
      return;
    }
    groups[Math.min(groupIndex, groups.length - 1)].push({ blockIndex, block });
  });

  const refs: Record<number, NormalBlockRef[]> = {};
  normalSegmentRefs(splitConflictSegments(file.content, file)).forEach(ref => {
    refs[ref.segmentIndex] = groups[ref.groupIndex] ?? [];
  });
  return refs;
}

function resolveLines(block: ConflictBlock, resolution: Resolution): string[] {
  if (isCustomResolution(resolution)) return resolution.lines;
  if (resolution === 'ours') return block.oursLines;
  if (resolution === 'theirs') return block.theirsLines;
  if (resolution === 'both') return [...block.oursLines, ...block.theirsLines];
  return block.baseLines;
}

function isCustomResolution(resolution: Resolution | undefined): resolution is Extract<Resolution, { type: 'custom' }> {
  return typeof resolution === 'object' && resolution?.type === 'custom';
}

function isResolvedResolution(resolution: Resolution | undefined): resolution is Exclude<Resolution, 'unresolved' | undefined> {
  return Boolean(resolution) && resolution !== 'unresolved';
}

function editableValueToLines(value: string): string[] {
  return value === '' ? [] : value.split('\n');
}

function linesToEditableValue(lines: string[]): string {
  return lines.join('\n');
}

function markerLines(block: ConflictBlock): string[] {
  const lines = [`<<<<<<< ${block.oursLabel}`, ...block.oursLines];
  if (block.baseLines.length > 0) lines.push('||||||| base', ...block.baseLines);
  lines.push('=======', ...block.theirsLines, `>>>>>>> ${block.theirsLabel}`);
  return lines;
}

export function buildContentFromResolutions(file: MergeConflictFile, resolutions: Record<number, Resolution>, normalEdits: NormalEdits = {}): string {
  const segments = splitConflictSegments(file.content, file);
  const lines: string[] = [];
  for (const [index, segment] of segments.entries()) {
    if (segment.kind === 'normal') {
      lines.push(...(normalEdits[index] ?? segment.lines));
      continue;
    }
    const resolution = resolutions[segment.index] ?? 'unresolved';
    lines.push(...(resolution === 'unresolved' ? markerLines(segment.block) : resolveLines(segment.block, resolution)));
  }
  return lines.join('\n');
}

function lineCount(segment: Segment, side: PaneSide, resolution?: Resolution, normalLines?: string[]): number {
  if (segment.kind === 'normal') return (normalLines ?? segment.lines).length;
  if (side === 'left') return segment.block.oursLines.length;
  if (side === 'right') return segment.block.theirsLines.length;
  if (isResolvedResolution(resolution)) return resolveLines(segment.block, resolution).length;
  return segment.block.baseLines.length;
}

function sideResolution(side: PaneSide): 'ours' | 'theirs' {
  return side === 'left' ? 'ours' : 'theirs';
}

function acceptedResolutionSides(resolution: Resolution | undefined): Array<'ours' | 'theirs'> {
  if (isCustomResolution(resolution)) return resolution.acceptedSides;
  if (resolution === 'both') return ['ours', 'theirs'];
  if (resolution === 'ours' || resolution === 'theirs') return [resolution];
  return [];
}

function includesResolutionSide(resolution: Resolution | undefined, side: 'ours' | 'theirs'): boolean {
  return acceptedResolutionSides(resolution).includes(side);
}

function addResolutionSide(resolution: Resolution | undefined, side: 'ours' | 'theirs'): Resolution {
  if (resolution === 'both' || resolution === side) return resolution;
  if (resolution === 'ours' || resolution === 'theirs') return 'both';
  return side;
}

function removeResolutionSide(resolution: Resolution | undefined, side: 'ours' | 'theirs'): Resolution {
  if (resolution === 'both') return side === 'ours' ? 'theirs' : 'ours';
  if (resolution === side) return 'unresolved';
  return resolution ?? 'unresolved';
}

function useSyncedScroll(enabled = true) {
  const leftRef = useRef<HTMLDivElement>(null);
  const centerRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const refs = useMemo(() => [leftRef, centerRef, rightRef] as const, []);
  const syncing = useRef(false);
  const onScroll = (source: number) => (event: React.UIEvent<HTMLDivElement>) => {
    if (!enabled || syncing.current) return;
    syncing.current = true;
    for (let i = 0; i < refs.length; i++) {
      if (i === source || !refs[i].current) continue;
      refs[i].current!.scrollTop = event.currentTarget.scrollTop;
      refs[i].current!.scrollLeft = event.currentTarget.scrollLeft;
    }
    syncing.current = false;
  };
  return { refs, onScroll };
}

interface ConnectorShape {
  key: string;
  kind: 'conflict' | 'change';
  side: 'left' | 'right';
  index: number;
  changeTone?: ChangeTone;
  fillPath: string;
  outlinePath: string;
  active: boolean;
}

type RibbonDirection = 'ltr' | 'rtl';

// Adapted from git-conflict-resolver's MIT-licensed "Satin Ribbon" renderer.
// Each adjacent pane pair keeps its own direction so the three-pane layout can
// retain the original 70%/30% taper and 45% Bezier control-point geometry.
function connectorBandPath(source: DOMRect, target: DOMRect, root: DOMRect, sourceOuterEdge: number, sourceInnerEdge: number, targetInnerEdge: number, targetOuterEdge: number, direction: RibbonDirection): Pick<ConnectorShape, 'fillPath' | 'outlinePath'> {
  const sourceOuterX = sourceOuterEdge - root.left;
  const sourceX = sourceInnerEdge - root.left;
  const targetX = targetInnerEdge - root.left;
  const targetOuterX = targetOuterEdge - root.left;
  const sourceTop = source.top - root.top;
  const sourceBottom = source.bottom - root.top;
  const targetTop = target.top - root.top;
  const targetBottom = target.bottom - root.top;
  const gutterWidth = targetX - sourceX;
  const taperX = sourceX + gutterWidth * (direction === 'ltr' ? 0.70 : 0.30);
  const curveStartX = direction === 'ltr' ? sourceX : taperX;
  const curveEndX = direction === 'ltr' ? taperX : targetX;
  const controlDistance = Math.max(1, (curveEndX - curveStartX) * 0.45);
  const topPath = direction === 'ltr'
    ? `M ${sourceOuterX} ${sourceTop} L ${sourceX} ${sourceTop} C ${sourceX + controlDistance} ${sourceTop}, ${taperX - controlDistance} ${targetTop}, ${taperX} ${targetTop} L ${targetOuterX} ${targetTop}`
    : `M ${sourceOuterX} ${sourceTop} L ${taperX} ${sourceTop} C ${taperX + controlDistance} ${sourceTop}, ${targetX - controlDistance} ${targetTop}, ${targetX} ${targetTop} L ${targetOuterX} ${targetTop}`;
  const returnPath = direction === 'ltr'
    ? `L ${taperX} ${targetBottom} C ${taperX - controlDistance} ${targetBottom}, ${sourceX + controlDistance} ${sourceBottom}, ${sourceX} ${sourceBottom} L ${sourceOuterX} ${sourceBottom} Z`
    : `L ${targetX} ${targetBottom} C ${targetX - controlDistance} ${targetBottom}, ${taperX + controlDistance} ${sourceBottom}, ${taperX} ${sourceBottom} L ${sourceOuterX} ${sourceBottom} Z`;
  const outlineTopPath = direction === 'ltr'
    ? `M ${sourceX} ${sourceTop} C ${sourceX + controlDistance} ${sourceTop}, ${taperX - controlDistance} ${targetTop}, ${taperX} ${targetTop} L ${targetX} ${targetTop}`
    : `M ${sourceX} ${sourceTop} L ${taperX} ${sourceTop} C ${taperX + controlDistance} ${sourceTop}, ${targetX - controlDistance} ${targetTop}, ${targetX} ${targetTop}`;
  const outlineBottomPath = direction === 'ltr'
    ? `M ${sourceX} ${sourceBottom} C ${sourceX + controlDistance} ${sourceBottom}, ${taperX - controlDistance} ${targetBottom}, ${taperX} ${targetBottom} L ${targetX} ${targetBottom}`
    : `M ${sourceX} ${sourceBottom} L ${taperX} ${sourceBottom} C ${taperX + controlDistance} ${sourceBottom}, ${targetX - controlDistance} ${targetBottom}, ${targetX} ${targetBottom}`;
  return {
    fillPath: `${topPath} L ${targetOuterX} ${targetBottom} ${returnPath}`,
    outlinePath: `${outlineTopPath} ${outlineBottomPath}`,
  };
}

function MergeConnectorOverlay({ layoutRef, paneRefs, conflicts, resolutions, normalEdits, nonConflictingSelections, activeConflictIndex }: {
  layoutRef: React.RefObject<HTMLDivElement>;
  paneRefs: readonly React.RefObject<HTMLDivElement>[];
  conflicts: ConflictBlock[];
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  nonConflictingSelections: NonConflictingSelections;
  activeConflictIndex: number;
}) {
  const [shapes, setShapes] = useState<ConnectorShape[]>([]);
  const [clipBounds, setClipBounds] = useState({ top: 0, height: 0, width: 0 });

  useEffect(() => {
    const layout = layoutRef.current;
    const panes = paneRefs.map(ref => ref.current);
    if (!layout || panes.some(pane => !pane)) return;
    const concretePanes = panes as HTMLDivElement[];

    let frame = 0;
    const renderConnectors = () => {
        const rootRect = layout.getBoundingClientRect();
        const titleAreas = concretePanes
          .map(pane => pane.querySelector('[data-merge-column-title]')?.getBoundingClientRect())
          .filter((rect): rect is DOMRect => Boolean(rect));
        const viewportTop = titleAreas.length > 0 ? Math.max(...titleAreas.map(rect => rect.bottom - rootRect.top)) : 0;
        const viewportBottom = Math.min(...concretePanes.map(pane => pane.getBoundingClientRect().bottom - rootRect.top));
        const paneRects = concretePanes.map(pane => pane.getBoundingClientRect());
        const nextShapes: ConnectorShape[] = [];
        const isVisible = (...bounds: DOMRect[]) => (
          Math.max(...bounds.map(bound => bound.bottom)) > rootRect.top + viewportTop
          && Math.min(...bounds.map(bound => bound.top)) < rootRect.top + viewportBottom
        );

        for (let conflictIndex = 0; conflictIndex < conflicts.length; conflictIndex += 1) {
          const selector = `[data-conflict-index="${conflictIndex}"]`;
          const conflictBounds = (pane: HTMLDivElement): DOMRect | undefined => {
            const block = pane.querySelector<HTMLElement>(selector);
            const anchor = block?.querySelector<HTMLElement>('[data-merge-connector-anchor]');
            return (anchor ?? block)?.getBoundingClientRect();
          };
          const left = conflictBounds(concretePanes[0]);
          const center = conflictBounds(concretePanes[1]);
          const right = conflictBounds(concretePanes[2]);
          if (!left || !center || !right) continue;

          if (!isVisible(left, center, right)) continue;

          nextShapes.push({
            key: `left-${conflictIndex}`,
            kind: 'conflict',
            side: 'left',
            index: conflictIndex,
            active: conflictIndex === activeConflictIndex,
            ...connectorBandPath(left, center, rootRect, paneRects[0].left, paneRects[0].right, paneRects[1].left, paneRects[1].right, 'ltr'),
          });
          nextShapes.push({
            key: `right-${conflictIndex}`,
            kind: 'conflict',
            side: 'right',
            index: conflictIndex,
            active: conflictIndex === activeConflictIndex,
            ...connectorBandPath(center, right, rootRect, paneRects[1].left, paneRects[1].right, paneRects[2].left, paneRects[2].right, 'rtl'),
          });
        }

        const changeIndexes = new Set<number>();
        concretePanes.forEach(pane => {
          pane.querySelectorAll<HTMLElement>('[data-change-block-index]').forEach(node => {
            const index = Number(node.dataset.changeBlockIndex);
            if (Number.isInteger(index)) changeIndexes.add(index);
          });
        });
        const changeBounds = (pane: HTMLDivElement, blockIndex: number): DOMRect | undefined => {
          const nodes = Array.from(pane.querySelectorAll<HTMLElement>(`[data-change-block-index="${blockIndex}"]`));
          if (nodes.length === 0) return undefined;
          const bounds = nodes.map(node => node.getBoundingClientRect());
          const paneRect = pane.getBoundingClientRect();
          const top = Math.min(...bounds.map(bound => bound.top));
          const bottom = Math.max(...bounds.map(bound => bound.bottom));
          return new DOMRect(paneRect.left, top, paneRect.width, Math.max(1, bottom - top));
        };
        const readChangeTone = (pane: HTMLDivElement, blockIndex: number): ChangeTone => {
          const tone = pane.querySelector<HTMLElement>(`[data-change-block-index="${blockIndex}"][data-change-tone]`)?.dataset.changeTone;
          return tone === 'added' || tone === 'deleted' || tone === 'accepted' ? tone : 'modified';
        };

        [...changeIndexes].sort((left, right) => left - right).forEach(blockIndex => {
          const center = changeBounds(concretePanes[1], blockIndex);
          if (!center) return;
          const left = changeBounds(concretePanes[0], blockIndex);
          const right = changeBounds(concretePanes[2], blockIndex);

          if (left && isVisible(left, center)) {
            nextShapes.push({
              key: `change-left-${blockIndex}`,
              kind: 'change',
              side: 'left',
              index: blockIndex,
              changeTone: readChangeTone(concretePanes[0], blockIndex),
              active: false,
              ...connectorBandPath(left, center, rootRect, paneRects[0].left, paneRects[0].right, paneRects[1].left, paneRects[1].right, 'ltr'),
            });
          }
          if (right && isVisible(center, right)) {
            nextShapes.push({
              key: `change-right-${blockIndex}`,
              kind: 'change',
              side: 'right',
              index: blockIndex,
              changeTone: readChangeTone(concretePanes[2], blockIndex),
              active: false,
              ...connectorBandPath(center, right, rootRect, paneRects[1].left, paneRects[1].right, paneRects[2].left, paneRects[2].right, 'rtl'),
            });
          }
        });

        setClipBounds({
          top: viewportTop,
          height: Math.max(0, viewportBottom - viewportTop),
          width: rootRect.width,
        });
        setShapes(nextShapes);
    };
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(renderConnectors);
    };

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(layout);
    concretePanes.forEach(pane => {
      pane.addEventListener('scroll', update, { passive: true });
      resizeObserver.observe(pane);
    });
    renderConnectors();

    return () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      concretePanes.forEach(pane => pane.removeEventListener('scroll', update));
    };
  }, [activeConflictIndex, conflicts, layoutRef, nonConflictingSelections, normalEdits, paneRefs, resolutions]);

  const clipId = 'versiondock-merge-connector-clip';
  return (
    <svg aria-hidden="true" style={styles.connectorOverlay}>
      <defs>
        <clipPath id={clipId}>
          <rect x="0" y={clipBounds.top} width={clipBounds.width} height={clipBounds.height} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {shapes.map(shape => {
          const selected = shape.kind === 'conflict'
            ? includesResolutionSide(resolutions[shape.index], sideResolution(shape.side))
            : nonConflictingSelections[shape.index] === shape.side;
          const outlinedSelection = selected;
          const tone = shape.kind === 'conflict' ? 'conflict' : shape.changeTone ?? 'modified';
          const color = tone === 'accepted' || tone === 'added'
            ? acceptedRibbon
            : tone === 'deleted'
              ? deletedRibbon
              : tone === 'modified'
                ? modifiedRibbon
                : conflictRibbon;
          return (
            <g key={shape.key} style={styles.connectorShape}>
              <path
                d={outlinedSelection ? shape.outlinePath : shape.fillPath}
                fill={outlinedSelection ? 'none' : color}
                stroke={outlinedSelection
                  ? shape.kind === 'conflict' ? conflictBoundaryColor : appliedBoundaryColor(shape.changeTone ?? 'modified')
                  : undefined}
                strokeWidth={outlinedSelection ? 1 : undefined}
                strokeDasharray={outlinedSelection ? '1 2' : undefined}
                strokeLinecap={outlinedSelection ? 'round' : undefined}
                style={styles.connectorPath}
              />
            </g>
          );
        })}
      </g>
    </svg>
  );
}

function BlockActionBar({ side, kind, selected, resettable, onAccept, onReset }: {
  side: 'left' | 'right';
  kind: 'conflict' | 'change';
  selected: boolean;
  resettable: boolean;
  onAccept: () => void;
  onReset: () => void;
}) {
  const acceptLabel = side === 'left' ? t('Accept Current') : t('Accept Incoming');
  const resetLabel = kind === 'conflict' ? t('Reset') : t('Cancel application');
  const directionIcon = <Codicon name={side === 'left' ? 'arrow-right' : 'arrow-left'} style={styles.blockActionDirectionIcon} />;
  const acceptAction = (
    <button
      type="button"
      className="versiondock-block-action-button versiondock-block-action-button--accept"
      style={styles.blockActionButton('accept')}
      onClick={onAccept}
      title={acceptLabel}
      aria-label={acceptLabel}
    >
      {side === 'left' && directionIcon}
      <span>{acceptLabel}</span>
      {side === 'right' && directionIcon}
    </button>
  );
  const acceptedStatus = (
    <span style={styles.blockActionStatus} title={acceptLabel}>
      <Codicon name="check" style={styles.blockActionStatusIcon} />
      <span>{t('Accepted')}</span>
    </span>
  );
  const resetAction = resettable ? (
    <button
      type="button"
      className="versiondock-block-action-button versiondock-block-action-button--reset"
      style={styles.blockActionButton('reset')}
      onClick={onReset}
      title={resetLabel}
      aria-label={resetLabel}
    >
      <Codicon name="discard" style={styles.blockActionResetIcon} />
    </button>
  ) : null;

  return (
    <div style={styles.blockActionBar}>
      <span className="versiondock-block-action-segmented" style={styles.blockActionGroup}>
        {selected ? acceptedStatus : acceptAction}
        {resetAction}
      </span>
    </div>
  );
}

export function ThreeWayLayout({ file, language, resolutions, normalEdits, nonConflictingSelections, onResultChange, onResolveBlock, onNormalEdit, onSelectNonConflicting, currentConflictIndex, syncScrollEnabled }: Props) {
  const layoutRef = useRef<HTMLDivElement>(null);
  const segments = useMemo(() => splitConflictSegments(file.content, file), [file]);
  const normalVersionLines = useMemo(() => ({
    base: buildBaseNormalEdits(file),
    left: buildNormalEditsForNonConflictingScope(file, 'left'),
    right: buildNormalEditsForNonConflictingScope(file, 'right'),
    blocks: buildNormalBlockRefs(file),
  }), [file]);
  const { refs, onScroll } = useSyncedScroll(syncScrollEnabled);

  useEffect(() => {
    const container = refs[1].current;
    const active = container?.querySelector(`[data-conflict-index="${currentConflictIndex}"]`) as HTMLElement | null;
    if (!container || !active) return;
    container.scrollTop = Math.max(0, active.offsetTop - 180);
  }, [currentConflictIndex, file, refs]);

  const applyResolution = (index: number, resolution: Resolution) => {
    const segment = segments.find(item => item.kind === 'conflict' && item.index === index) as ConflictSegment | undefined;
    if (!segment) return;
    onResolveBlock(index, resolution);
    onResultChange(buildContentFromResolutions(file, { ...resolutions, [index]: resolution }, normalEdits));
  };

  const applyNormalEdit = (index: number, lines: string[]) => {
    const nextNormalEdits = { ...normalEdits, [index]: lines };
    onNormalEdit(index, lines);
    onResultChange(buildContentFromResolutions(file, resolutions, nextNormalEdits));
  };

  return (
    <div style={styles.container}>
      <style>{MERGE_SCROLLBAR_STYLES}</style>
      <div ref={layoutRef} style={styles.grid}>
        <Column refEl={refs[0]} title={`${t('Current')} · ${file.oursLabel}`} side="left" segments={segments} resolutions={resolutions} normalEdits={normalEdits} baseNormalLines={normalVersionLines.base} normalVersionLines={normalVersionLines.left} normalBlockRefs={normalVersionLines.blocks} nonConflictingSelections={nonConflictingSelections} language={language} onScroll={onScroll(0)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} onSelectNonConflicting={onSelectNonConflicting} />
        <div style={styles.connectorGutter} />
        <Column refEl={refs[1]} title={`${t('Result')} · ${file.relativePath}`} side="center" segments={segments} resolutions={resolutions} normalEdits={normalEdits} baseNormalLines={normalVersionLines.base} normalBlockRefs={normalVersionLines.blocks} nonConflictingSelections={nonConflictingSelections} language={language} onScroll={onScroll(1)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} onSelectNonConflicting={onSelectNonConflicting} />
        <div style={styles.connectorGutter} />
        <Column refEl={refs[2]} title={`${t('Incoming')} · ${file.theirsLabel}`} side="right" segments={segments} resolutions={resolutions} normalEdits={normalEdits} baseNormalLines={normalVersionLines.base} normalVersionLines={normalVersionLines.right} normalBlockRefs={normalVersionLines.blocks} nonConflictingSelections={nonConflictingSelections} language={language} onScroll={onScroll(2)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} onSelectNonConflicting={onSelectNonConflicting} />
        <MergeConnectorOverlay layoutRef={layoutRef} paneRefs={refs} conflicts={file.conflicts} resolutions={resolutions} normalEdits={normalEdits} nonConflictingSelections={nonConflictingSelections} activeConflictIndex={currentConflictIndex} />
      </div>
    </div>
  );
}

interface VerticalScrollbarMetrics {
  visible: boolean;
  top: number;
  height: number;
  trackHeight: number;
}

interface HorizontalScrollbarMetrics {
  visible: boolean;
  left: number;
  width: number;
  trackWidth: number;
}

const OVERLAY_SCROLLBAR_HIDE_DELAY_MS = 700;

function useTransientScrollbarVisibility() {
  const [active, setActive] = useState(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current === null) return;
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = null;
  }, []);

  const holdVisible = useCallback(() => {
    clearHideTimer();
    setActive(true);
  }, [clearHideTimer]);

  const showTemporarily = useCallback(() => {
    clearHideTimer();
    setActive(true);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setActive(false);
    }, OVERLAY_SCROLLBAR_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  useEffect(() => clearHideTimer, [clearHideTimer]);

  return { active, holdVisible, showTemporarily };
}

function OverlayVerticalScrollbar({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const [metrics, setMetrics] = useState<VerticalScrollbarMetrics>({ visible: false, top: 0, height: 0, trackHeight: 0 });
  const dragRef = useRef<{ pointerId: number; startY: number; startScrollTop: number } | null>(null);
  const { active, holdVisible, showTemporarily } = useTransientScrollbarVisibility();

  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;

    const update = () => {
      const titleHeight = pane.querySelector<HTMLElement>('[data-merge-column-title]')?.offsetHeight ?? 29;
      const horizontalScrollbarHeight = pane.scrollWidth > pane.clientWidth + 1 ? 10 : 0;
      const trackHeight = Math.max(0, pane.clientHeight - titleHeight - horizontalScrollbarHeight);
      const scrollableHeight = Math.max(0, pane.scrollHeight - pane.clientHeight);
      if (scrollableHeight === 0 || trackHeight === 0) {
        setMetrics({ visible: false, top: 0, height: 0, trackHeight });
        return;
      }

      const height = Math.min(trackHeight, Math.max(28, trackHeight * (pane.clientHeight / pane.scrollHeight)));
      const travel = Math.max(0, trackHeight - height);
      const top = scrollableHeight > 0 ? (pane.scrollTop / scrollableHeight) * travel : 0;
      setMetrics({ visible: true, top, height, trackHeight });
    };

    const handleScroll = () => {
      update();
      if (dragRef.current) holdVisible();
      else showTemporarily();
    };

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(pane);
    const codeArea = pane.querySelector<HTMLElement>('[data-merge-code-area]');
    if (codeArea) resizeObserver.observe(codeArea);
    pane.addEventListener('scroll', handleScroll, { passive: true });
    update();
    return () => {
      resizeObserver.disconnect();
      pane.removeEventListener('scroll', handleScroll);
    };
  }, [holdVisible, scrollRef, showTemporarily]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const pane = scrollRef.current;
    if (!pane) return;
    event.preventDefault();
    holdVisible();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startScrollTop: pane.scrollTop };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pane = scrollRef.current;
    const drag = dragRef.current;
    if (!pane || !drag || drag.pointerId !== event.pointerId) return;
    const travel = Math.max(1, metrics.trackHeight - metrics.height);
    const scrollableHeight = Math.max(0, pane.scrollHeight - pane.clientHeight);
    pane.scrollTop = drag.startScrollTop + ((event.clientY - drag.startY) / travel) * scrollableHeight;
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    showTemporarily();
  };

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const pane = scrollRef.current;
    if (!pane) return;
    showTemporarily();
    const rect = event.currentTarget.getBoundingClientRect();
    const travel = Math.max(1, metrics.trackHeight - metrics.height);
    const targetTop = Math.max(0, Math.min(travel, event.clientY - rect.top - metrics.height / 2));
    pane.scrollTop = (targetTop / travel) * Math.max(0, pane.scrollHeight - pane.clientHeight);
  };

  if (!metrics.visible) return null;
  return (
    <div style={styles.overlayScrollbarTrack(metrics.trackHeight, active)} onPointerDown={onTrackPointerDown}>
      <div
        role="scrollbar"
        aria-label={t('Vertical scrollbar')}
        aria-orientation="vertical"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, (scrollRef.current?.scrollHeight ?? 0) - (scrollRef.current?.clientHeight ?? 0))}
        aria-valuenow={scrollRef.current?.scrollTop ?? 0}
        style={styles.overlayScrollbarThumb(metrics.top, metrics.height)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      />
    </div>
  );
}

function OverlayHorizontalScrollbar({ scrollRef }: { scrollRef: React.RefObject<HTMLDivElement> }) {
  const [metrics, setMetrics] = useState<HorizontalScrollbarMetrics>({ visible: false, left: 0, width: 0, trackWidth: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null);
  const { active, holdVisible, showTemporarily } = useTransientScrollbarVisibility();

  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;

    const update = () => {
      const verticalScrollbarWidth = pane.scrollHeight > pane.clientHeight + 1 ? 10 : 0;
      const trackWidth = Math.max(0, pane.clientWidth - verticalScrollbarWidth);
      const scrollableWidth = Math.max(0, pane.scrollWidth - pane.clientWidth);
      if (scrollableWidth === 0 || trackWidth === 0) {
        setMetrics({ visible: false, left: 0, width: 0, trackWidth });
        return;
      }

      const width = Math.min(trackWidth, Math.max(28, trackWidth * (pane.clientWidth / pane.scrollWidth)));
      const travel = Math.max(0, trackWidth - width);
      const left = scrollableWidth > 0 ? (pane.scrollLeft / scrollableWidth) * travel : 0;
      setMetrics({ visible: true, left, width, trackWidth });
    };

    const handleScroll = () => {
      update();
      if (dragRef.current) holdVisible();
      else showTemporarily();
    };

    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(pane);
    const codeArea = pane.querySelector<HTMLElement>('[data-merge-code-area]');
    if (codeArea) resizeObserver.observe(codeArea);
    pane.addEventListener('scroll', handleScroll, { passive: true });
    update();
    return () => {
      resizeObserver.disconnect();
      pane.removeEventListener('scroll', handleScroll);
    };
  }, [holdVisible, scrollRef, showTemporarily]);

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const pane = scrollRef.current;
    if (!pane) return;
    event.preventDefault();
    holdVisible();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startScrollLeft: pane.scrollLeft };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const pane = scrollRef.current;
    const drag = dragRef.current;
    if (!pane || !drag || drag.pointerId !== event.pointerId) return;
    const travel = Math.max(1, metrics.trackWidth - metrics.width);
    const scrollableWidth = Math.max(0, pane.scrollWidth - pane.clientWidth);
    pane.scrollLeft = drag.startScrollLeft + ((event.clientX - drag.startX) / travel) * scrollableWidth;
  };

  const stopDragging = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    showTemporarily();
  };

  const onTrackPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    const pane = scrollRef.current;
    if (!pane) return;
    showTemporarily();
    const rect = event.currentTarget.getBoundingClientRect();
    const travel = Math.max(1, metrics.trackWidth - metrics.width);
    const targetLeft = Math.max(0, Math.min(travel, event.clientX - rect.left - metrics.width / 2));
    pane.scrollLeft = (targetLeft / travel) * Math.max(0, pane.scrollWidth - pane.clientWidth);
  };

  if (!metrics.visible) return null;
  return (
    <div style={styles.overlayHorizontalScrollbarTrack(metrics.trackWidth, active)} onPointerDown={onTrackPointerDown}>
      <div
        role="scrollbar"
        aria-label={t('Horizontal scrollbar')}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={Math.max(0, (scrollRef.current?.scrollWidth ?? 0) - (scrollRef.current?.clientWidth ?? 0))}
        aria-valuenow={scrollRef.current?.scrollLeft ?? 0}
        style={styles.overlayHorizontalScrollbarThumb(metrics.left, metrics.width)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={stopDragging}
        onPointerCancel={stopDragging}
      />
    </div>
  );
}

function Column({ refEl, title, side, segments, resolutions, normalEdits, baseNormalLines, normalVersionLines, normalBlockRefs, nonConflictingSelections, language, onScroll, onResolve, onNormalEdit, onSelectNonConflicting }: {
  refEl: React.RefObject<HTMLDivElement>;
  title: string;
  side: PaneSide;
  segments: Segment[];
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  baseNormalLines?: NormalEdits | null;
  normalVersionLines?: NormalEdits | null;
  normalBlockRefs?: Record<number, NormalBlockRef[]> | null;
  nonConflictingSelections: NonConflictingSelections;
  language: string;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  onResolve: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
  onSelectNonConflicting: (blockIndex: number, selection: NonConflictingSelection | 'base') => void;
}) {
  let lineNo = 1;
  return (
    <div style={styles.columnFrame}>
      <div ref={refEl} className="versiondock-merge-pane" data-merge-pane={side} style={styles.column} onScroll={onScroll}>
        <div data-merge-column-title style={styles.columnTitle} title={title}>{title}</div>
        <div data-merge-code-area style={styles.codeWrap}>
          {segments.map((segment, index) => {
          const start = lineNo;
          const resolution = segment.kind === 'conflict' ? resolutions[segment.index] : undefined;
          const normalLines = segment.kind === 'normal'
            ? side === 'center' ? normalEdits[index] : normalVersionLines?.[index]
            : undefined;
          const displayedNormalLines = segment.kind === 'normal' ? normalLines ?? segment.lines : undefined;
          const changeFlags = displayedNormalLines
            ? changedLineFlags(baseNormalLines?.[index] ?? (segment.kind === 'normal' ? segment.lines : []), displayedNormalLines)
            : undefined;
          const resultAreaVisuals = segment.kind === 'normal' && side === 'center' && normalBlockRefs?.[index]
            ? buildResultChangeAreaVisuals(normalBlockRefs[index], nonConflictingSelections)
            : undefined;
          const displayedChangeFlags = resultAreaVisuals && resultAreaVisuals.flags.length === displayedNormalLines?.length
            ? resultAreaVisuals.flags
            : changeFlags;
          const displayedChangeTones = resultAreaVisuals && resultAreaVisuals.tones.length === displayedNormalLines?.length
            ? resultAreaVisuals.tones
            : undefined;
          const displayedChangeBlockRanges = resultAreaVisuals && resultAreaVisuals.flags.length === displayedNormalLines?.length
            ? resultAreaVisuals.ranges
            : undefined;
          lineNo += lineCount(segment, side, resolution, normalLines);
            return <SegmentView key={index} segmentIndex={index} segment={segment} side={side} startLine={start} language={language} resolution={resolution} normalLines={normalLines} normalBlocks={normalBlockRefs?.[index]} nonConflictingSelections={nonConflictingSelections} changeFlags={displayedChangeFlags} changeTones={displayedChangeTones} changeBlockRanges={displayedChangeBlockRanges} onResolve={onResolve} onNormalEdit={onNormalEdit} onSelectNonConflicting={onSelectNonConflicting} />;
          })}
        </div>
      </div>
      <OverlayVerticalScrollbar scrollRef={refEl} />
      <OverlayHorizontalScrollbar scrollRef={refEl} />
    </div>
  );
}

function SegmentView({ segmentIndex, segment, side, startLine, language, resolution, normalLines, normalBlocks, nonConflictingSelections, changeFlags, changeTones, changeBlockRanges, onResolve, onNormalEdit, onSelectNonConflicting }: {
  segmentIndex: number;
  segment: Segment;
  side: PaneSide;
  startLine: number;
  language: string;
  resolution?: Resolution;
  normalLines?: string[];
  normalBlocks?: NormalBlockRef[];
  nonConflictingSelections: NonConflictingSelections;
  changeFlags?: boolean[];
  changeTones?: ChangeTone[];
  changeBlockRanges?: ChangeBlockRange[];
  onResolve: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
  onSelectNonConflicting: (blockIndex: number, selection: NonConflictingSelection | 'base') => void;
}) {
  if (segment.kind === 'normal') {
    if (side === 'center') {
      const lines = normalLines ?? segment.lines;
      return (
        <EditableCodeBlock
          value={linesToEditableValue(lines)}
          startLine={startLine}
          language={language}
          changeFlags={changeFlags}
          changeTones={changeTones}
          changeBlockRanges={changeBlockRanges}
          onChange={value => onNormalEdit(segmentIndex, editableValueToLines(value))}
        />
      );
    }
    if (normalBlocks) {
      return <NormalSideBlocks blocks={normalBlocks} side={side} startLine={startLine} language={language} selections={nonConflictingSelections} onSelect={onSelectNonConflicting} />;
    }
    return <CodeLines lines={normalLines ?? segment.lines} startLine={startLine} language={language} changeFlags={changeFlags} changeTone="modified" />;
  }

  const resolved = isResolvedResolution(resolution);

  if (side === 'center') {
    const lines = resolved ? resolveLines(segment.block, resolution) : segment.block.baseLines;
    if (lines.length === 0) {
      return (
        <div
          data-conflict-index={segment.index}
          style={resolved ? styles.emptyAppliedConflictAnchor : styles.emptyBlockAnchor('conflict')}
        />
      );
    }
    return (
      <div data-conflict-index={segment.index} style={resolved ? styles.appliedConflictBlock : styles.conflictBlock}>
        <EditableCodeBlock
          value={linesToEditableValue(lines)}
          startLine={startLine}
          language={language}
          dim={lines.length === 0}
          onChange={value => onResolve(segment.index, {
            type: 'custom',
            lines: editableValueToLines(value),
            acceptedSides: acceptedResolutionSides(resolution),
          })}
        />
      </div>
    );
  }

  const lines = side === 'left' ? segment.block.oursLines : segment.block.theirsLines;
  const currentSide = sideResolution(side);
  const accepted = includesResolutionSide(resolution, currentSide);
  const resettable = accepted || isCustomResolution(resolution);
  const accept = () => onResolve(segment.index, addResolutionSide(resolution, currentSide));
  const reset = () => onResolve(
    segment.index,
    isCustomResolution(resolution) ? 'unresolved' : removeResolutionSide(resolution, currentSide),
  );

  return (
    <div data-conflict-index={segment.index} style={accepted ? styles.appliedConflictSideBlock : styles.conflictBlock}>
      <BlockActionBar side={side} kind="conflict" selected={accepted} resettable={resettable} onAccept={accept} onReset={reset} />
      <div
        data-merge-connector-anchor
        style={lines.length > 0
          ? accepted ? styles.appliedConflictContentAnchor : styles.connectorContentAnchor
          : accepted ? styles.emptyAppliedConflictAnchor : styles.emptyBlockAnchor('conflict')}
      >
        {lines.length > 0 && <CodeLines lines={lines} startLine={startLine} language={language} />}
      </div>
    </div>
  );
}

type ChangeTone = 'modified' | 'added' | 'deleted' | 'accepted';

interface ChangeBlockRange {
  blockIndex: number;
  startLine: number;
  lineCount: number;
  tone: ChangeTone;
  applied: boolean;
}

function buildResultChangeAreaVisuals(blocks: NormalBlockRef[], selections: NonConflictingSelections): { flags: boolean[]; tones: ChangeTone[]; ranges: ChangeBlockRange[] } {
  const flags: boolean[] = [];
  const tones: ChangeTone[] = [];
  const ranges: ChangeBlockRange[] = [];
  let lineCursor = 0;
  blocks.forEach(({ block, blockIndex }) => {
    const resultLines = nonConflictingResultLines(block, selections[blockIndex]);
    const applicable = isApplicableNonConflictingBlock(block);
    const selected = Boolean(selections[blockIndex]);
    const insertion = block.baseLines.length === 0 && (block.leftLines.length > 0 || block.rightLines.length > 0);
    const deletion = block.baseLines.length > 0 && (
      (block.state === 'modified_left' && block.leftLines.length === 0)
      || (block.state === 'modified_right' && block.rightLines.length === 0)
      || (block.state === 'modified_both' && block.leftLines.length === 0 && block.rightLines.length === 0)
    );
    const tone: ChangeTone = insertion ? 'added' : deletion ? 'deleted' : 'modified';
    if (applicable) ranges.push({ blockIndex, startLine: lineCursor, lineCount: resultLines.length, tone, applied: selected });
    resultLines.forEach(() => {
      flags.push(applicable && !selected);
      tones.push(tone);
    });
    lineCursor += resultLines.length;
  });
  return { flags, tones, ranges };
}

function NormalSideBlocks({ blocks, side, startLine, language, selections, onSelect }: {
  blocks: NormalBlockRef[];
  side: 'left' | 'right';
  startLine: number;
  language: string;
  selections: NonConflictingSelections;
  onSelect: (blockIndex: number, selection: NonConflictingSelection | 'base') => void;
}) {
  let lineNo = startLine;
  return (
    <>
      {blocks.map(({ block, blockIndex }) => {
        const lines = side === 'left' ? block.leftLines : block.rightLines;
        const flags = changedLineFlags(block.baseLines, lines);
        const changedOnSide = side === 'left'
          ? block.state === 'modified_left' || block.state === 'modified_both'
          : block.state === 'modified_right' || block.state === 'modified_both';
        const changeTone: ChangeTone = block.baseLines.length === 0 && lines.length > 0
          ? 'added'
          : block.baseLines.length > 0 && lines.length === 0
            ? 'deleted'
            : 'modified';
        const applied = selections[blockIndex] === side;
        const blockStartLine = lineNo;
        lineNo += lines.length;
        if (lines.length === 0 && !changedOnSide) return null;
        return (
          <div
            key={blockIndex}
            style={styles.normalChangeBlock}
          >
            {changedOnSide && (
              <BlockActionBar
                side={side}
                kind="change"
                selected={applied}
                resettable={applied}
                onAccept={() => onSelect(blockIndex, side)}
                onReset={() => onSelect(blockIndex, 'base')}
              />
            )}
            {changedOnSide ? (
              <div
                data-change-block-index={blockIndex}
                data-change-tone={changeTone}
                style={lines.length > 0
                  ? styles.connectorContentAnchor
                  : styles.emptyChangeConnectorAnchor(changeTone, applied)}
              >
                {lines.length > 0 && (
                  <>
                    {applied && <span aria-hidden="true" style={styles.appliedChangeMarker(changeTone)} />}
                    <CodeLines
                      lines={lines}
                      startLine={blockStartLine}
                      language={language}
                      changeFlags={applied ? undefined : flags}
                      changeTone={changeTone}
                    />
                  </>
                )}
              </div>
            ) : lines.length > 0 ? (
              <CodeLines lines={lines} startLine={blockStartLine} language={language} />
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function CodeLines({ lines, startLine, language, dim, changeFlags, changeTone }: {
  lines: string[];
  startLine: number;
  language: string;
  dim?: boolean;
  changeFlags?: boolean[];
  changeTone?: ChangeTone;
}) {
  const highlighter = useShiki();
  const colorTheme = getVersionDockColorTheme();
  const displayedLines = useMemo(() => lines.length > 0 ? lines : [''], [lines]);

  const renderedLines = useMemo(() => {
    return renderShikiLines(highlighter, displayedLines, language, colorTheme);
  }, [colorTheme, displayedLines, highlighter, language]);

  return (
    <>
      {displayedLines.map((line, index) => {
        const changed = Boolean(changeFlags?.[index]);
        return (
          <div key={index} style={styles.codeLine(
            dim,
            changed ? changeTone : undefined,
            changed && !changeFlags?.[index - 1],
            changed && !changeFlags?.[index + 1],
          )}>
            <span style={styles.lineNo}>{startLine + index}</span>
            <span style={styles.codeText}>{renderedLines[index] ?? (line || ' ')}</span>
          </div>
        );
      })}
    </>
  );
}

function EditableCodeBlock({ value, startLine, language, dim, changeFlags, changeTones, changeBlockRanges, onChange }: {
  value: string;
  startLine: number;
  language: string;
  dim?: boolean;
  changeFlags?: boolean[];
  changeTones?: ChangeTone[];
  changeBlockRanges?: ChangeBlockRange[];
  onChange: (value: string) => void;
}) {
  const highlighter = useShiki();
  const colorTheme = getVersionDockColorTheme();
  const lines = useMemo(() => {
    const split = value.split('\n');
    return split.length > 0 ? split : [''];
  }, [value]);
  const renderedLines = useMemo(() => {
    return renderShikiLines(highlighter, lines, language, colorTheme);
  }, [colorTheme, highlighter, language, lines]);
  const lineTotal = Math.max(lines.length, 1);
  const lineNumbers = Array.from({ length: lineTotal }, (_, index) => startLine + index);
  const contentWidth = `${Math.max(24, ...lines.map(line => line.length + 1))}ch`;

  return (
    <div style={styles.editableBlock(dim)}>
      <div style={styles.editableLineNumbers}>
        {lineNumbers.map((line, index) => (
          <span key={line} style={styles.editableLineNo(
            changeFlags?.[index] ? changeTones?.[index] : undefined,
            Boolean(changeFlags?.[index] && !changeFlags?.[index - 1]),
            Boolean(changeFlags?.[index] && !changeFlags?.[index + 1]),
          )}>{line}</span>
        ))}
      </div>
      <div style={styles.editableTextWrap(lineTotal, contentWidth)}>
        {changeBlockRanges?.map(range => (
          <span
            key={range.blockIndex}
            data-change-block-index={range.blockIndex}
            data-change-tone={range.tone}
            data-change-applied={range.applied || undefined}
            style={styles.changeBlockMarker(range.startLine, range.lineCount, range.tone, range.applied)}
          />
        ))}
        <div aria-hidden="true" style={styles.editableHighlight}>
          {lines.map((line, index) => (
            <div key={index} style={styles.editableHighlightLine(
              changeFlags?.[index] ? changeTones?.[index] : undefined,
              Boolean(changeFlags?.[index] && !changeFlags?.[index - 1]),
              Boolean(changeFlags?.[index] && !changeFlags?.[index + 1]),
            )}>
              {renderedLines[index] ?? (line || ' ')}
            </div>
          ))}
        </div>
        <textarea
          value={value}
          onChange={event => onChange(event.currentTarget.value)}
          rows={lineTotal}
          wrap="off"
          spellCheck={false}
          style={styles.resultTextarea(lineTotal)}
        />
      </div>
    </div>
  );
}

type SupportedShikiLanguage =
  | 'javascript' | 'typescript' | 'json' | 'css' | 'html' | 'markdown' | 'java'
  | 'xml' | 'yaml' | 'php' | 'python' | 'go' | 'shellscript' | SpecialLanguage;

interface ShikiToken {
  content: string;
  color?: string;
  fontStyle?: string;
}

const loadedCustomThemes = new WeakMap<HighlighterCore, Set<string>>();

function ensureShikiTheme(highlighter: HighlighterCore, theme: ThemeRegistrationRaw): void {
  if (!theme.name) {
    highlighter.loadThemeSync(theme);
    return;
  }
  let loaded = loadedCustomThemes.get(highlighter);
  if (!loaded) {
    loaded = new Set();
    loadedCustomThemes.set(highlighter, loaded);
  }
  if (loaded.has(theme.name)) return;
  highlighter.loadThemeSync(theme);
  loaded.add(theme.name);
}

function renderShikiLines(
  highlighter: HighlighterCore | null,
  lines: string[],
  language: string,
  colorTheme: WebviewColorThemeData | null,
): React.ReactNode[] {
  if (!highlighter) return lines.map(line => line || ' ');

  const theme = getShikiTheme(colorTheme);
  if (typeof theme !== 'string') ensureShikiTheme(highlighter, theme);

  try {
    // Tokenizing a segment in one pass is both faster and more accurate for
    // multiline constructs than invoking Shiki independently for every line.
    const tokenize = highlighter.codeToTokens as unknown as (
      code: string,
      options: { lang: SupportedShikiLanguage; theme: string | ThemeRegistrationRaw },
    ) => unknown;
    const result = tokenize(lines.join('\n') || ' ', {
      lang: normalizeShikiLang(language),
      theme,
    });
    const tokenLines = Array.isArray(result)
      ? result
      : ((result as { tokens?: ShikiToken[][] }).tokens ?? []);
    return lines.map((line, lineIndex) => {
      const tokens: ShikiToken[] = tokenLines[lineIndex] ?? [];
      if (tokens.length === 0) return line || ' ';
      return tokens.map((token, tokenIndex) => (
        <span key={tokenIndex} style={{ color: token.color, fontStyle: token.fontStyle }}>{token.content}</span>
      ));
    });
  } catch {
    return lines.map(line => line || ' ');
  }
}

function getShikiTheme(colorTheme: WebviewColorThemeData | null): 'github-light' | 'github-dark' | ThemeRegistrationRaw {
  if (colorTheme) {
    return {
      name: colorTheme.name,
      type: colorTheme.type,
      fg: colorTheme.fg,
      bg: colorTheme.bg,
      colors: colorTheme.colors,
      settings: colorTheme.settings,
    };
  }
  return document.body.classList.contains('vscode-light') ? 'github-light' : 'github-dark';
}

function normalizeShikiLang(language: string): SupportedShikiLanguage {
  const lang = language.toLowerCase();
  if (lang === 'typescriptreact' || lang === 'tsx') return 'typescript';
  if (lang === 'javascriptreact' || lang === 'jsx') return 'javascript';
  if (lang === 'plaintext') return 'text';
  if (lang === 'shell' || lang === 'bash' || lang === 'zsh') return 'shellscript';
  if (lang === 'typescript') return 'typescript';
  if (lang === 'javascript') return 'javascript';
  if (lang === 'json') return 'json';
  if (lang === 'java') return 'java';
  if (lang === 'css') return 'css';
  if (lang === 'html') return 'html';
  if (lang === 'markdown') return 'markdown';
  if (lang === 'php') return 'php';
  if (lang === 'python') return 'python';
  if (lang === 'go') return 'go';
  if (lang === 'xml') return 'xml';
  if (lang === 'yaml') return 'yaml';
  return 'typescript';
}

// Use VS Code's semantic diff/merge colors directly. Themes are responsible
// for choosing suitable light, dark, and high-contrast values; keeping the
// same token for code blocks and ribbons also prevents the connector gutter
// from visually fading the change color a second time.
const conflictBg = 'var(--vscode-diffEditor-removedTextBackground, color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 22%, transparent))';
const conflictRibbon = conflictBg;
const modifiedBg = 'var(--vscode-merge-incomingContentBackground, color-mix(in srgb, var(--vscode-editorInfo-foreground, #3794ff) 22%, transparent))';
const modifiedRibbon = modifiedBg;
const deletedBg = 'color-mix(in srgb, var(--vscode-editor-foreground) 18%, var(--vscode-editor-background))';
const deletedRibbon = deletedBg;
const acceptedBg = 'var(--vscode-diffEditor-insertedTextBackground, color-mix(in srgb, var(--vscode-gitDecoration-addedResourceForeground, #73c991) 24%, transparent))';
const acceptedRibbon = acceptedBg;
const addedBg = acceptedBg;
const conflictBoundaryColor = 'var(--vscode-editorOverviewRuler-deletedForeground, var(--vscode-editorError-foreground, #f14c4c))';

function appliedBoundaryColor(tone: ChangeTone): string {
  if (tone === 'added' || tone === 'accepted') {
    return 'var(--vscode-editorOverviewRuler-addedForeground, var(--vscode-editorGutter-addedBackground, #73c991))';
  }
  if (tone === 'deleted') {
    return 'var(--vscode-disabledForeground, var(--vscode-descriptionForeground, #8c8c8c))';
  }
  return 'var(--vscode-editorInfo-foreground, #3794ff)';
}

function changeLineVisual(tone?: ChangeTone, _startsChange = false, _endsChange = false): React.CSSProperties {
  if (!tone) return {};
  const background = tone === 'accepted'
    ? acceptedBg
    : tone === 'added'
      ? addedBg
      : tone === 'deleted'
        ? deletedBg
        : modifiedBg;
  return { background };
}

const styles = {
  container: { display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0 },
  grid: { position: 'relative' as const, display: 'grid', gridTemplateColumns: `minmax(0, 1fr) ${CONNECTOR_GUTTER_WIDTH} minmax(0, 1fr) ${CONNECTOR_GUTTER_WIDTH} minmax(0, 1fr)`, flex: 1, minHeight: 0, overflow: 'hidden', background: 'var(--vscode-editor-background)' },
  columnFrame: { position: 'relative' as const, zIndex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', background: 'var(--vscode-editor-background)' },
  column: { position: 'relative' as const, width: '100%', height: '100%', overflowX: 'auto' as const, overflowY: 'auto' as const, scrollbarGutter: 'auto', minWidth: 0, background: 'var(--vscode-editor-background)' },
  overlayScrollbarTrack: (height: number, active: boolean): React.CSSProperties => ({ position: 'absolute', top: 29, right: 0, zIndex: 9, width: 10, height, background: 'transparent', touchAction: 'none', opacity: active ? 1 : 0, pointerEvents: active ? 'auto' : 'none', transition: 'opacity 120ms ease' }),
  overlayScrollbarThumb: (top: number, height: number): React.CSSProperties => ({
    position: 'absolute',
    top,
    right: 2,
    width: 6,
    height,
    borderRadius: 6,
    background: 'var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4))',
    cursor: 'default',
    touchAction: 'none',
  }),
  overlayHorizontalScrollbarTrack: (width: number, active: boolean): React.CSSProperties => ({
    position: 'absolute',
    left: 0,
    bottom: 0,
    zIndex: 9,
    width,
    height: 10,
    background: 'transparent',
    touchAction: 'none',
    opacity: active ? 1 : 0,
    pointerEvents: active ? 'auto' : 'none',
    transition: 'opacity 120ms ease',
  }),
  overlayHorizontalScrollbarThumb: (left: number, width: number): React.CSSProperties => ({
    position: 'absolute',
    left,
    bottom: 2,
    width,
    height: 6,
    borderRadius: 6,
    background: 'var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4))',
    cursor: 'default',
    touchAction: 'none',
  }),
  connectorGutter: {
    position: 'relative' as const,
    zIndex: 0,
    minWidth: 0,
    background: 'var(--vscode-editor-background)',
    borderLeft: '1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent)',
    borderRight: '1px solid color-mix(in srgb, var(--vscode-panel-border) 70%, transparent)',
    pointerEvents: 'none' as const,
  },
  connectorOverlay: { position: 'absolute' as const, inset: 0, zIndex: 0, width: '100%', height: '100%', overflow: 'visible', pointerEvents: 'none' as const },
  connectorShape: { transition: 'opacity 120ms ease' },
  connectorPath: { mixBlendMode: 'normal' as const },
  blockActionBar: {
    position: 'sticky',
    top: 29,
    zIndex: 4,
    width: '100%',
    height: CODE_LINE_HEIGHT,
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    padding: '1px 0',
    background: 'var(--vscode-editor-background)',
    userSelect: 'none',
  } as React.CSSProperties,
  blockActionGroup: {
    position: 'sticky' as const,
    left: 6,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 0,
    width: 'max-content',
    height: 19,
    overflow: 'hidden',
    borderRadius: 5,
    background: 'color-mix(in srgb, var(--vscode-foreground) 8%, transparent)',
  },
  blockActionButton: (kind: 'accept' | 'reset'): React.CSSProperties => ({
    minWidth: kind === 'accept' ? 0 : 21,
    height: 19,
    padding: kind === 'accept' ? '0 6px' : 0,
    border: '1px solid transparent',
    borderRadius: 0,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 11,
    fontWeight: 500,
    lineHeight: '17px',
    whiteSpace: 'nowrap',
    color: kind === 'accept'
      ? 'var(--vscode-foreground)'
      : 'var(--vscode-descriptionForeground, var(--vscode-foreground))',
    opacity: kind === 'accept' ? 0.9 : 0.78,
    cursor: 'pointer',
    transition: 'background-color 80ms ease, color 80ms ease, opacity 80ms ease',
  }),
  blockActionStatus: {
    height: 19,
    padding: '0 6px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    color: 'var(--vscode-foreground)',
    fontSize: 11,
    fontWeight: 500,
    lineHeight: '19px',
    whiteSpace: 'nowrap' as const,
  },
  blockActionDirectionIcon: { fontSize: 11, lineHeight: '11px', pointerEvents: 'none' as const },
  blockActionStatusIcon: { color: 'var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-foreground)))', fontSize: 11, lineHeight: '11px', pointerEvents: 'none' as const },
  blockActionResetIcon: { fontSize: 13, lineHeight: '13px', pointerEvents: 'none' as const },
  columnTitle: {
    position: 'sticky' as const,
    top: 0,
    left: 0,
    zIndex: 6,
    width: '100%',
    height: 29,
    boxSizing: 'border-box' as const,
    display: 'flex',
    alignItems: 'center',
    padding: '0 10px',
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--vscode-descriptionForeground)',
    background: 'var(--vscode-editor-background)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    userSelect: 'none' as const,
  },
  codeWrap: { width: 'max-content', minWidth: '100%', paddingTop: 4, paddingBottom: 32 },
  conflictBlock: {
    position: 'relative',
    minHeight: CODE_LINE_HEIGHT,
    background: conflictBg,
  } as React.CSSProperties,
  appliedConflictBlock: {
    position: 'relative',
    minHeight: CODE_LINE_HEIGHT,
    borderTop: `1px dotted ${conflictBoundaryColor}`,
    borderBottom: `1px dotted ${conflictBoundaryColor}`,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  appliedConflictSideBlock: {
    position: 'relative',
    minHeight: CODE_LINE_HEIGHT,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  emptyAppliedConflictAnchor: {
    position: 'relative',
    width: '100%',
    height: 2,
    minHeight: 2,
    borderTop: `2px dotted ${conflictBoundaryColor}`,
    boxSizing: 'border-box',
    pointerEvents: 'none',
  } as React.CSSProperties,
  emptyBlockAnchor: (tone: 'conflict' | ChangeTone): React.CSSProperties => ({
    position: 'relative',
    width: '100%',
    height: 2,
    minHeight: 2,
    background: tone === 'conflict' ? conflictBg : changeLineVisual(tone).background,
    pointerEvents: 'none',
  }),
  connectorContentAnchor: {
    position: 'relative' as const,
    width: '100%',
  },
  appliedConflictContentAnchor: {
    position: 'relative',
    width: '100%',
    borderTop: `1px dotted ${conflictBoundaryColor}`,
    borderBottom: `1px dotted ${conflictBoundaryColor}`,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  emptyChangeConnectorAnchor: (tone: ChangeTone, applied: boolean): React.CSSProperties => ({
    position: 'relative',
    width: '100%',
    height: 2,
    minHeight: 2,
    boxSizing: 'border-box',
    background: applied ? undefined : changeLineVisual(tone).background,
    borderTop: applied ? `2px dotted ${appliedBoundaryColor(tone)}` : undefined,
    pointerEvents: 'none',
  }),
  normalChangeBlock: { position: 'relative' as const },
  appliedChangeMarker: (tone: ChangeTone): React.CSSProperties => ({
    position: 'absolute',
    inset: 0,
    zIndex: 2,
    borderTop: `1px dotted ${appliedBoundaryColor(tone)}`,
    borderBottom: `1px dotted ${appliedBoundaryColor(tone)}`,
    boxSizing: 'border-box',
    pointerEvents: 'none',
  }),
  codeLine: (dim?: boolean, changeTone?: ChangeTone, startsChange?: boolean, endsChange?: boolean): React.CSSProperties => ({ position: 'relative', display: 'flex', minHeight: 21, lineHeight: '21px', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 'var(--vscode-editor-font-size, 13px)', opacity: dim ? 0.45 : 1, ...changeLineVisual(changeTone, startsChange, endsChange) }),
  lineNo: { width: 44, paddingRight: 12, textAlign: 'right' as const, color: 'var(--vscode-editorLineNumber-foreground, #6e7681)', userSelect: 'none' as const, flexShrink: 0 },
  codeText: { whiteSpace: 'pre', paddingRight: 16, flexShrink: 0 },
  editableBlock: (dim?: boolean): React.CSSProperties => ({
    display: 'flex',
    width: 'max-content',
    minWidth: '100%',
    minHeight: CODE_LINE_HEIGHT,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    opacity: dim ? 0.45 : 1,
  }),
  editableLineNumbers: {
    width: 44,
    flexShrink: 0,
    userSelect: 'none' as const,
  },
  editableLineNo: (changeTone?: ChangeTone, startsChange?: boolean, endsChange?: boolean): React.CSSProperties => ({
    display: 'block',
    height: CODE_LINE_HEIGHT,
    lineHeight: `${CODE_LINE_HEIGHT}px`,
    paddingRight: 12,
    textAlign: 'right' as const,
    color: 'var(--vscode-editorLineNumber-foreground, #6e7681)',
    ...changeLineVisual(changeTone, startsChange, endsChange),
  }),
  editableTextWrap: (lineTotal: number, contentWidth: string): React.CSSProperties => ({
    position: 'relative',
    flex: 1,
    width: '100%',
    minWidth: contentWidth,
    height: lineTotal * CODE_LINE_HEIGHT,
    minHeight: CODE_LINE_HEIGHT,
  }),
  changeBlockMarker: (startLine: number, lineCount: number, tone: ChangeTone, applied: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: startLine * CODE_LINE_HEIGHT - (lineCount === 0 ? 1 : 0),
    left: applied || lineCount === 0 ? -44 : 0,
    right: 0,
    height: lineCount === 0 ? 2 : lineCount * CODE_LINE_HEIGHT,
    zIndex: applied ? 2 : undefined,
    background: !applied && lineCount === 0 ? changeLineVisual(tone).background : undefined,
    borderTop: applied ? `${lineCount === 0 ? 2 : 1}px dotted ${appliedBoundaryColor(tone)}` : undefined,
    borderBottom: applied && lineCount > 0 ? `1px dotted ${appliedBoundaryColor(tone)}` : undefined,
    boxSizing: 'border-box',
    pointerEvents: 'none',
  }),
  editableHighlight: {
    position: 'absolute',
    inset: 0,
    margin: 0,
    padding: '0 16px 0 0',
    overflow: 'hidden',
    pointerEvents: 'none' as const,
    whiteSpace: 'pre' as const,
    color: 'var(--vscode-editor-foreground, var(--vscode-foreground))',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    lineHeight: `${CODE_LINE_HEIGHT}px`,
  } as React.CSSProperties,
  editableHighlightLine: (changeTone?: ChangeTone, startsChange?: boolean, endsChange?: boolean): React.CSSProperties => ({
    width: 'calc(100% + 16px)',
    height: CODE_LINE_HEIGHT,
    minHeight: CODE_LINE_HEIGHT,
    lineHeight: `${CODE_LINE_HEIGHT}px`,
    ...changeLineVisual(changeTone, startsChange, endsChange),
  }),
  resultTextarea: (lineTotal: number): React.CSSProperties => ({
    position: 'relative',
    display: 'block',
    width: '100%',
    height: lineTotal * CODE_LINE_HEIGHT,
    minHeight: CODE_LINE_HEIGHT,
    padding: '0 16px 0 0',
    border: 'none',
    outline: 'none',
    resize: 'none' as const,
    overflow: 'hidden',
    background: 'transparent',
    color: 'transparent',
    caretColor: 'var(--vscode-editor-foreground, var(--vscode-foreground))',
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
    fontSize: 'var(--vscode-editor-font-size, 13px)',
    lineHeight: `${CODE_LINE_HEIGHT}px`,
    whiteSpace: 'pre' as const,
  }),
};
