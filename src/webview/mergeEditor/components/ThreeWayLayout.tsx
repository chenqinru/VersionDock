import React, { useEffect, useMemo, useRef } from 'react';
import type { BundledLanguage, Highlighter, SpecialLanguage, ThemeRegistrationRaw } from 'shiki';
import type { ConflictBlock, MergeConflictFile } from '../../shared/types';
import type { NormalEdits, Resolution } from '../store/mergeStore';
import { t } from '../../shared/i18n';
import { getVersionDockColorTheme, type WebviewColorThemeData } from '../../shared/colorTheme';
import { useShiki } from '../../shared/useShiki';

interface Props {
  file: MergeConflictFile;
  resultContent: string;
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  language: string;
  onResultChange: (content: string) => void;
  onResolveBlock: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
  currentConflictIndex: number;
  syncScrollEnabled: boolean;
}

type Segment = NormalSegment | ConflictSegment;
interface NormalSegment { kind: 'normal'; lines: string[] }
interface ConflictSegment { kind: 'conflict'; index: number; block: ConflictBlock }
type PaneSide = 'left' | 'center' | 'right';
export type NonConflictingChangeScope = 'left' | 'all' | 'right';

type MergeBlockState = 'equal' | 'modified_left' | 'modified_right' | 'modified_both' | 'conflict';

interface SideChange {
  baseStart: number;
  baseEnd: number;
  lines: string[];
}

interface ThreeWayBlock {
  state: MergeBlockState;
  baseLines: string[];
  leftLines: string[];
  rightLines: string[];
}

const CODE_LINE_HEIGHT = 21;
const CONFLICT_HEADER_HEIGHT = 26;

function splitConflictSegments(content: string, file: MergeConflictFile): Segment[] {
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

function splitLines(content: string): string[] {
  return content.split('\n');
}

function diffLineChanges(baseLines: string[], sideLines: string[]): SideChange[] {
  const baseLength = baseLines.length;
  const sideLength = sideLines.length;
  const table = Array.from({ length: baseLength + 1 }, () => new Array<number>(sideLength + 1).fill(0));

  for (let i = baseLength - 1; i >= 0; i -= 1) {
    for (let j = sideLength - 1; j >= 0; j -= 1) {
      table[i][j] = baseLines[i] === sideLines[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }

  const changes: SideChange[] = [];
  let baseStart: number | null = null;
  let replacementLines: string[] = [];

  const ensureChange = (index: number) => {
    if (baseStart === null) baseStart = index;
  };

  const flush = (baseEnd: number) => {
    if (baseStart === null) return;
    changes.push({ baseStart, baseEnd, lines: replacementLines });
    baseStart = null;
    replacementLines = [];
  };

  let i = 0;
  let j = 0;
  while (i < baseLength || j < sideLength) {
    if (i < baseLength && j < sideLength && baseLines[i] === sideLines[j]) {
      flush(i);
      i += 1;
      j += 1;
      continue;
    }

    const deleteScore = i < baseLength ? table[i + 1][j] : -1;
    const insertScore = j < sideLength ? table[i][j + 1] : -1;
    if (j < sideLength && (i >= baseLength || insertScore >= deleteScore)) {
      ensureChange(i);
      replacementLines.push(sideLines[j]);
      j += 1;
    } else if (i < baseLength) {
      ensureChange(i);
      i += 1;
    }
  }

  flush(i);
  return changes;
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
  if (!file.baseContent || !file.oursContent || !file.theirsContent) return null;

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

function nonConflictingResultLines(block: ThreeWayBlock, scope: NonConflictingChangeScope): string[] {
  if (block.state === 'modified_left') return scope === 'right' ? block.baseLines : block.leftLines;
  if (block.state === 'modified_right') return scope === 'left' ? block.baseLines : block.rightLines;
  if (block.state === 'modified_both') return scope === 'right' ? block.rightLines : block.leftLines;
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
  if (!blocks) return { changeCount: conflictCount, conflictCount, nonConflictingCount: 0 };

  return {
    changeCount: blocks.filter(block => block.state !== 'equal').length,
    conflictCount,
    nonConflictingCount: blocks.filter(isApplicableNonConflictingBlock).length,
  };
}

export function buildNormalEditsForNonConflictingScope(file: MergeConflictFile, scope: NonConflictingChangeScope, previousEdits: NormalEdits): NormalEdits | null {
  const blocks = compatibleThreeWayBlocks(file);
  if (!blocks) return null;

  const groups = Array.from({ length: file.conflicts.length + 1 }, () => [] as string[]);
  let groupIndex = 0;

  for (const block of blocks) {
    if (block.state === 'conflict') {
      groupIndex += 1;
      continue;
    }
    groups[Math.min(groupIndex, groups.length - 1)].push(...nonConflictingResultLines(block, scope));
  }

  const refs = normalSegmentRefs(splitConflictSegments(file.content, file));
  const representedGroups = new Set(refs.map(ref => ref.groupIndex));
  const hasUnrepresentedContent = groups.some((lines, index) => lines.length > 0 && !representedGroups.has(index));
  if (hasUnrepresentedContent) return null;

  const nextEdits: NormalEdits = { ...previousEdits };
  refs.forEach(ref => {
    nextEdits[ref.segmentIndex] = groups[ref.groupIndex] ?? [];
  });

  return nextEdits;
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
  if (segment.kind === 'normal') return visibleLineCount(normalLines ?? segment.lines);
  if (side === 'left') return visibleLineCount(segment.block.oursLines);
  if (side === 'right') return visibleLineCount(segment.block.theirsLines);
  if (isResolvedResolution(resolution)) return visibleLineCount(resolveLines(segment.block, resolution));
  return Math.max(segment.block.oursLines.length, segment.block.theirsLines.length, 1);
}

function visibleLineCount(lines: string[]): number {
  return Math.max(lines.length, 1);
}

function comparedLineCount(block: ConflictBlock, resolution?: Resolution): number {
  const resolvedLines = isResolvedResolution(resolution) ? resolveLines(block, resolution) : [];
  return Math.max(visibleLineCount(block.oursLines), visibleLineCount(block.theirsLines), resolvedLines.length);
}

function sideConflictMinHeight(block: ConflictBlock, resolution?: Resolution): number {
  return comparedLineCount(block, resolution) * CODE_LINE_HEIGHT;
}

function resultConflictMinHeight(block: ConflictBlock, resolution?: Resolution): number | undefined {
  if (!isResolvedResolution(resolution)) return undefined;
  return sideConflictMinHeight(block, resolution);
}

function sideResolution(side: PaneSide): 'ours' | 'theirs' {
  return side === 'left' ? 'ours' : 'theirs';
}

function includesResolutionSide(resolution: Resolution | undefined, side: 'ours' | 'theirs'): boolean {
  if (resolution === 'both') return true;
  return resolution === side;
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
  const refs = [useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null), useRef<HTMLDivElement>(null)] as const;
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

export function ThreeWayLayout({ file, language, resolutions, normalEdits, onResultChange, onResolveBlock, onNormalEdit, currentConflictIndex, syncScrollEnabled }: Props) {
  const segments = useMemo(() => splitConflictSegments(file.content, file), [file]);
  const { refs, onScroll } = useSyncedScroll(syncScrollEnabled);

  useEffect(() => {
    const container = refs[1].current;
    const active = container?.querySelector(`[data-conflict-index="${currentConflictIndex}"]`) as HTMLElement | null;
    if (!container || !active) return;
    container.scrollTop = Math.max(0, active.offsetTop - 120);
  }, [currentConflictIndex, file]);

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
      <div style={styles.grid}>
        <Column refEl={refs[0]} title={t('Left (Current)')} side="left" segments={segments} resolutions={resolutions} normalEdits={normalEdits} language={language} activeConflictIndex={currentConflictIndex} onScroll={onScroll(0)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} />
        <Column refEl={refs[1]} title={t('Center (Result)')} side="center" segments={segments} resolutions={resolutions} normalEdits={normalEdits} language={language} activeConflictIndex={currentConflictIndex} onScroll={onScroll(1)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} />
        <Column refEl={refs[2]} title={t('Right (Incoming)')} side="right" segments={segments} resolutions={resolutions} normalEdits={normalEdits} language={language} activeConflictIndex={currentConflictIndex} onScroll={onScroll(2)} onResolve={applyResolution} onNormalEdit={applyNormalEdit} />
      </div>
    </div>
  );
}

function Column({ refEl, title, side, segments, resolutions, normalEdits, language, activeConflictIndex, onScroll, onResolve, onNormalEdit }: {
  refEl: React.RefObject<HTMLDivElement>;
  title: string;
  side: PaneSide;
  segments: Segment[];
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  language: string;
  activeConflictIndex: number;
  onScroll: (event: React.UIEvent<HTMLDivElement>) => void;
  onResolve: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
}) {
  let lineNo = 1;
  return (
    <div ref={refEl} style={styles.column} onScroll={onScroll}>
      <div style={styles.columnTitle}>{title}</div>
      <div style={styles.codeWrap}>
        {segments.map((segment, index) => {
          const start = lineNo;
          const resolution = segment.kind === 'conflict' ? resolutions[segment.index] : undefined;
          const normalLines = segment.kind === 'normal' && side === 'center' ? normalEdits[index] : undefined;
          lineNo += lineCount(segment, side, resolution, normalLines);
          const active = segment.kind === 'conflict' && segment.index === activeConflictIndex;
          return <SegmentView key={index} segmentIndex={index} segment={segment} side={side} startLine={start} language={language} resolution={resolution} normalLines={normalLines} active={active} onResolve={onResolve} onNormalEdit={onNormalEdit} />;
        })}
      </div>
    </div>
  );
}

function SegmentView({ segmentIndex, segment, side, startLine, language, resolution, normalLines, active, onResolve, onNormalEdit }: {
  segmentIndex: number;
  segment: Segment;
  side: PaneSide;
  startLine: number;
  language: string;
  resolution?: Resolution;
  normalLines?: string[];
  active: boolean;
  onResolve: (index: number, resolution: Resolution) => void;
  onNormalEdit: (index: number, lines: string[]) => void;
}) {
  if (segment.kind === 'normal') {
    if (side === 'center') {
      const lines = normalLines ?? segment.lines;
      return (
        <EditableCodeBlock
          value={linesToEditableValue(lines)}
          startLine={startLine}
          language={language}
          onChange={value => onNormalEdit(segmentIndex, editableValueToLines(value))}
        />
      );
    }
    return <CodeLines lines={segment.lines} startLine={startLine} language={language} />;
  }

  const resolved = isResolvedResolution(resolution);

  if (side === 'center') {
    if (resolved) {
      const lines = resolveLines(segment.block, resolution);
      return (
        <div data-conflict-index={segment.index} style={{ ...styles.conflictBlock(side, resolution, active), minHeight: resultConflictMinHeight(segment.block, resolution) }}>
          <ConflictHeader side="center" resolution={resolution} onReset={() => onResolve(segment.index, 'unresolved')} />
          <div style={styles.resultContentArea(resolution === 'ours' ? 'mine' : resolution === 'theirs' ? 'theirs' : undefined)}>
            <EditableCodeBlock
              value={linesToEditableValue(lines)}
              startLine={startLine}
              language={language}
              onChange={value => onResolve(segment.index, { type: 'custom', lines: editableValueToLines(value) })}
            />
          </div>
        </div>
      );
    }

    return (
      <div data-conflict-index={segment.index} style={styles.conflictBlock(side, 'unresolved', active)}>
        <ConflictHeader side="center" resolution={resolution} />
        <div style={styles.resultContentArea('mine')}>
          <EditableCodeBlock
            value={linesToEditableValue(segment.block.oursLines)}
            startLine={startLine}
            language={language}
            dim={segment.block.oursLines.length === 0}
            onChange={value => onResolve(segment.index, { type: 'custom', lines: editableValueToLines(value) })}
          />
        </div>
        <div style={styles.incomingSeparator}>{t('Incoming')} ↓</div>
        <div style={styles.ghostBlock}>
          <CodeLines lines={segment.block.theirsLines.length === 0 ? [''] : segment.block.theirsLines} startLine={startLine} language={language} dim />
        </div>
      </div>
    );
  }

  const lines = side === 'left' ? segment.block.oursLines : segment.block.theirsLines;
  const accepted = (side === 'left' && resolution === 'ours') || (side === 'right' && resolution === 'theirs');
  const currentSide = sideResolution(side);

  return (
    <div data-conflict-index={segment.index} style={{ ...styles.conflictBlock(side, accepted ? resolution : 'unresolved', active), minHeight: sideConflictMinHeight(segment.block, resolution) + CONFLICT_HEADER_HEIGHT }}>
      <ConflictHeader
        side={side}
        resolution={resolution}
        onAccept={() => onResolve(segment.index, addResolutionSide(resolution, currentSide))}
        onDelete={() => onResolve(segment.index, removeResolutionSide(resolution, currentSide))}
      />
      <CodeLines lines={lines.length === 0 ? [''] : lines} startLine={startLine} language={language} dim={lines.length === 0} />
    </div>
  );
}

function ConflictHeader({ side, resolution, onAccept, onDelete, onReset }: {
  side: PaneSide;
  resolution?: Resolution;
  onAccept?: () => void;
  onDelete?: () => void;
  onReset?: () => void;
}) {
  const resolved = isResolvedResolution(resolution);

  if (side === 'center') {
    return (
      <div style={styles.conflictHeader('center')}>
        <span style={styles.resultHeaderText}>{t('Result')}</span>
        {resolved && <button style={styles.inlineButton('undo')} onClick={onReset} title={t('Reset')}>{'\u21a9'}</button>}
      </div>
    );
  }

  const currentSide = sideResolution(side);
  const appliedHere = includesResolutionSide(resolution, currentSide);
  const acceptDisabled = appliedHere;
  const deleteDisabled = !appliedHere;

  if (side === 'left') {
    return (
      <div style={styles.conflictHeader(side)}>
        <button style={styles.inlineButton('delete', deleteDisabled)} disabled={deleteDisabled} onClick={onDelete} title={t('Delete')}>{'\u2715'}</button>
        <button style={styles.inlineButton('mine', acceptDisabled)} disabled={acceptDisabled} onClick={onAccept} title={t('Accept Current')}>{t('Accept Current')} {'\u25b6'}</button>
      </div>
    );
  }

  return (
    <div style={styles.conflictHeader(side)}>
      <button style={styles.inlineButton('theirs', acceptDisabled)} disabled={acceptDisabled} onClick={onAccept} title={t('Accept Incoming')}>{'\u25c0'} {t('Accept Incoming')}</button>
      <button style={styles.inlineButton('delete', deleteDisabled)} disabled={deleteDisabled} onClick={onDelete} title={t('Delete')}>{'\u2715'}</button>
    </div>
  );
}

function CodeLines({ lines, startLine, language, dim }: { lines: string[]; startLine: number; language: string; dim?: boolean }) {
  const highlighter = useShiki();
  const colorTheme = getVersionDockColorTheme();

  const renderedLines = useMemo(() => {
    return lines.map(line => renderShikiLine(highlighter, line, language, colorTheme));
  }, [colorTheme, highlighter, language, lines]);

  return (
    <>
      {lines.map((line, index) => (
        <div key={index} style={styles.codeLine(dim)}>
          <span style={styles.lineNo}>{startLine + index}</span>
          <span style={styles.codeText}>{renderedLines[index] ?? (line || ' ')}</span>
        </div>
      ))}
    </>
  );
}

function EditableCodeBlock({ value, startLine, language, dim, onChange }: {
  value: string;
  startLine: number;
  language: string;
  dim?: boolean;
  onChange: (value: string) => void;
}) {
  const highlighter = useShiki();
  const colorTheme = getVersionDockColorTheme();
  const lines = useMemo(() => {
    const split = value.split('\n');
    return split.length > 0 ? split : [''];
  }, [value]);
  const renderedLines = useMemo(() => {
    return lines.map(line => renderShikiLine(highlighter, line, language, colorTheme));
  }, [colorTheme, highlighter, language, lines]);
  const lineTotal = Math.max(lines.length, 1);
  const lineNumbers = Array.from({ length: lineTotal }, (_, index) => startLine + index);
  const contentWidth = `${Math.max(24, ...lines.map(line => line.length + 1))}ch`;

  return (
    <div style={styles.editableBlock(dim)}>
      <div style={styles.editableLineNumbers}>
        {lineNumbers.map(line => (
          <span key={line} style={styles.editableLineNo}>{line}</span>
        ))}
      </div>
      <div style={styles.editableTextWrap(lineTotal, contentWidth)}>
        <div aria-hidden="true" style={styles.editableHighlight}>
          {lines.map((line, index) => (
            <div key={index} style={styles.editableHighlightLine}>
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

function renderShikiLine(highlighter: Highlighter | null, line: string, language: string, colorTheme: WebviewColorThemeData | null): React.ReactNode {
  if (!highlighter) return line || ' ';

  const theme = getShikiTheme(colorTheme);
  if (typeof theme !== 'string') highlighter.loadThemeSync(theme);

  try {
    const result = highlighter.codeToTokens(line || ' ', {
      lang: normalizeShikiLang(language),
      theme,
    });
    const tokenLines = Array.isArray(result)
      ? result
      : ((result as unknown as { tokens?: Array<Array<{ content: string; color?: string; fontStyle?: string }>> }).tokens ?? []);
    const firstLine: Array<{ content: string; color?: string; fontStyle?: string }> = tokenLines[0] ?? [];

    if (firstLine.length === 0) return line || ' ';
    return firstLine.map((token, index) => (
      <span key={index} style={{ color: token.color, fontStyle: token.fontStyle }}>{token.content}</span>
    ));
  } catch {
    return line || ' ';
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

function normalizeShikiLang(language: string): BundledLanguage | SpecialLanguage {
  const lang = language.toLowerCase();
  if (lang === 'typescriptreact' || lang === 'tsx') return 'tsx';
  if (lang === 'javascriptreact' || lang === 'jsx') return 'jsx';
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

const mineBg = 'rgba(46, 160, 67, 0.18)';
const mineHeaderBg = 'rgba(46, 160, 67, 0.10)';
const mineBorder = 'rgba(76, 175, 80, 0.85)';
const mineText = '#c8e6c9';
const theirsBg = 'rgba(33, 150, 243, 0.18)';
const theirsHeaderBg = 'rgba(33, 150, 243, 0.10)';
const theirsBorder = 'rgba(33, 150, 243, 0.85)';
const theirsText = '#bbdefb';
const resultBorder = 'var(--vscode-panel-border)';
const unresolvedCenterBg = 'var(--vscode-editor-background)';

const styles = {
  container: { display: 'flex', flexDirection: 'column' as const, flex: 1, minHeight: 0 },
  grid: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1fr)', flex: 1, minHeight: 0 },
  column: { overflow: 'auto', borderRight: '1px solid var(--vscode-panel-border)', minWidth: 0 },
  columnTitle: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 2,
    padding: '6px 12px',
    fontSize: 12,
    fontWeight: 600,
    background: 'var(--vscode-editorGroupHeader-tabsBackground, #252526)',
    borderBottom: '1px solid var(--vscode-panel-border)',
  },
  codeWrap: { width: 'max-content', minWidth: '100%', paddingBottom: 28 },
  conflictBlock: (side: 'left' | 'center' | 'right', state?: Resolution, active?: boolean): React.CSSProperties => {
    const isMine = side === 'left' || state === 'ours';
    const isTheirs = side === 'right' || state === 'theirs';
    const border = isMine ? mineBorder : isTheirs ? theirsBorder : resultBorder;
    const background = side === 'center'
      ? state === 'ours'
        ? mineBg
        : state === 'theirs'
          ? theirsBg
          : isResolvedResolution(state)
            ? 'var(--vscode-editor-background)'
            : unresolvedCenterBg
      : side === 'left'
        ? mineBg
        : theirsBg;

    return {
      position: 'relative',
      background,
      borderTop: `1px solid ${resultBorder}`,
      borderBottom: `1px solid ${resultBorder}`,
      boxShadow: active ? `0 0 0 1px var(--vscode-focusBorder, #007fd4) inset` : undefined,
      outline: active ? `1px solid ${border}` : undefined,
      outlineOffset: -1,
    };
  },
  conflictHeader: (side: PaneSide): React.CSSProperties => ({
    height: CONFLICT_HEADER_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-start',
    gap: 4,
    padding: side === 'center' ? '0 8px' : '0 6px',
    background: side === 'left'
      ? mineHeaderBg
      : side === 'right'
        ? theirsHeaderBg
        : 'var(--vscode-editor-background)',
    borderBottom: side === 'center' ? '1px solid var(--vscode-panel-border)' : `1px solid ${side === 'left' ? mineBorder : theirsBorder}`,
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 12,
    userSelect: 'none' as const,
  }),
  resultHeaderText: {
    color: 'var(--vscode-foreground)',
    fontSize: 12,
    fontWeight: 600,
  },
  inlineButton: (kind: 'mine' | 'theirs' | 'delete' | 'undo', disabled = false): React.CSSProperties => ({
    height: 20,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minWidth: kind === 'mine' || kind === 'theirs' ? 104 : 26,
    padding: kind === 'mine' || kind === 'theirs' ? '0 9px' : 0,
    borderRadius: 3,
    border: `1px solid ${
      kind === 'mine'
        ? mineBorder
        : kind === 'theirs'
          ? theirsBorder
          : kind === 'delete'
            ? '#e57373'
            : 'var(--vscode-button-border, #555)'
    }`,
    background: kind === 'mine'
      ? mineBg
      : kind === 'theirs'
        ? theirsBg
        : kind === 'delete'
          ? '#4a1a1a'
          : 'transparent',
    color: kind === 'mine'
      ? mineText
      : kind === 'theirs'
        ? theirsText
        : kind === 'delete'
          ? '#ffcdd2'
          : 'var(--vscode-foreground)',
    cursor: disabled ? 'default' : 'pointer',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 11,
    fontWeight: 600,
    lineHeight: '18px',
    opacity: disabled ? 0.35 : 1,
    whiteSpace: 'nowrap' as const,
  }),
  resultContentArea: (kind?: 'mine' | 'theirs'): React.CSSProperties => ({
    minHeight: '1.5em',
    position: 'relative',
    background: kind === 'mine' ? mineBg : kind === 'theirs' ? theirsBg : 'transparent',
  }),
  incomingSeparator: {
    padding: '2px 12px',
    background: 'rgba(33, 150, 243, 0.08)',
    borderTop: '1px dashed rgba(33, 150, 243, 0.3)',
    color: 'var(--vscode-descriptionForeground)',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 10,
    letterSpacing: '0.05em',
    pointerEvents: 'none' as const,
    userSelect: 'none' as const,
  },
  ghostBlock: { background: 'rgba(33, 150, 243, 0.10)', opacity: 0.55, pointerEvents: 'none' as const, userSelect: 'none' as const },
  codeLine: (dim?: boolean): React.CSSProperties => ({ display: 'flex', minHeight: 21, lineHeight: '21px', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 'var(--vscode-editor-font-size, 13px)', opacity: dim ? 0.45 : 1 }),
  lineNo: { width: 36, paddingRight: 10, textAlign: 'right' as const, color: 'var(--vscode-editorLineNumber-foreground, #6e7681)', userSelect: 'none' as const, flexShrink: 0 },
  codeText: { whiteSpace: 'pre' as const, paddingRight: 16 },
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
    width: 36,
    flexShrink: 0,
    userSelect: 'none' as const,
  },
  editableLineNo: {
    display: 'block',
    height: CODE_LINE_HEIGHT,
    lineHeight: `${CODE_LINE_HEIGHT}px`,
    paddingRight: 10,
    textAlign: 'right' as const,
    color: 'var(--vscode-editorLineNumber-foreground, #6e7681)',
  },
  editableTextWrap: (lineTotal: number, contentWidth: string): React.CSSProperties => ({
    position: 'relative',
    flex: 1,
    width: '100%',
    minWidth: contentWidth,
    height: lineTotal * CODE_LINE_HEIGHT,
    minHeight: CODE_LINE_HEIGHT,
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
  editableHighlightLine: {
    height: CODE_LINE_HEIGHT,
    minHeight: CODE_LINE_HEIGHT,
    lineHeight: `${CODE_LINE_HEIGHT}px`,
  },
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
