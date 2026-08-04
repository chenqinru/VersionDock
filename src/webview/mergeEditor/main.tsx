import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useMergeStore, type Resolution } from './store/mergeStore';
import {
  buildBaseNormalEdits,
  buildContentFromResolutions,
  buildNonConflictingSelectionsForScope,
  buildNormalEditsForNonConflictingSelections,
  buildNormalEditsForNonConflictingScope,
  diffLineChanges,
  getEffectiveConflictBlocks,
  getMergeToolbarCounts,
  type NonConflictingChangeScope,
  type NonConflictingSelection,
  type NonConflictingSelections,
  type AiMergeDraft,
  ThreeWayLayout,
} from './components/ThreeWayLayout';
import { getVsCodeApi } from '../shared/vscodeApi';
import { FileIcon } from '../shared/FileIcon';
import { WebviewErrorBoundary } from '../shared/WebviewErrorBoundary';
import type { HostToMergeMsg, IconThemeData, MergeToHostMsg } from '../../host/types/messages';
import { t } from '../shared/i18n';
import type { MergeConflictFile } from '../shared/types';
import { Codicon } from '../shared/Codicon';
import { nativeCheckboxBorderStyle } from '../shared/nativeCheckboxStyle';

const SYNC_SCROLL_STORAGE_KEY = 'versiondock.merge.syncScroll';

type AiPhase = 'idle' | 'analyzing' | 'typing' | 'completed';
type AiResolveResultMessage = Extract<HostToMergeMsg, { type: 'MERGE_AI_RESOLVE_RESULT' }>;

interface AiUiState {
  phase: AiPhase;
  current: number;
  total: number;
  provider?: string;
  model?: string;
}

interface AiRunSnapshot {
  resolutions: Record<number, Resolution>;
  normalEdits: Record<number, string[]>;
  resultContent: string;
  nonConflictingSelections: NonConflictingSelections;
  appliedNonConflictingScope: NonConflictingChangeScope | null;
  currentConflictIndex: number;
}

const IDLE_AI_STATE: AiUiState = { phase: 'idle', current: 0, total: 0 };

const AI_MERGE_STYLES = `
  @keyframes versiondock-ai-orbit {
    to { transform: rotate(360deg); }
  }
  @keyframes versiondock-ai-status-scan {
    0% { transform: translateX(-120%); opacity: 0; }
    18% { opacity: 0.72; }
    82% { opacity: 0.72; }
    100% { transform: translateX(420%); opacity: 0; }
  }
  @keyframes versiondock-ai-button-breathe {
    0%, 100% { filter: brightness(1); }
    50% { filter: brightness(1.12); }
  }
  @keyframes versiondock-ai-stop-breathe {
    0%, 100% { transform: scale(1); opacity: 0.85; }
    50% { transform: scale(1.16); opacity: 1; }
  }
  @keyframes versiondock-ai-slash-edge {
    0% { transform: translate3d(0, 0, 0) skewX(-22deg); opacity: 0; }
    22% { opacity: 0.35; }
    48% { opacity: 1; }
    100% { transform: translate3d(1550%, 0, 0) skewX(-22deg); opacity: 0; }
  }
  .versiondock-ai-resolve-button {
    position: relative;
    isolation: isolate;
    overflow: hidden;
    box-shadow: none;
  }
  .versiondock-ai-resolve-button > * {
    position: relative;
    z-index: 2;
  }
  .versiondock-ai-resolve-button::after {
    content: '';
    position: absolute;
    pointer-events: none;
    opacity: 0;
    z-index: 1;
    top: -55%;
    left: -28%;
    width: 10%;
    height: 210%;
    background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.96), transparent);
    box-shadow: 0 0 5px rgba(222, 239, 255, 0.7);
  }
  .versiondock-ai-resolve-button:hover:not(:disabled) {
    filter: brightness(1.08);
    transform: translateY(-1px);
  }
  .versiondock-ai-resolve-button:hover:not(:disabled)::after {
    animation: versiondock-ai-slash-edge 880ms cubic-bezier(0.22, 0.7, 0.22, 1) both;
  }
  .versiondock-ai-resolve-button:active:not(:disabled) {
    transform: translateY(0);
    filter: brightness(0.98);
  }
  .versiondock-ai-resolve-button:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 2px;
  }
  .versiondock-ai-resolve-button[data-running="true"] {
    animation: versiondock-ai-button-breathe 1.8s ease-in-out infinite;
  }
  .versiondock-ai-resolve-button[data-running="true"] .codicon {
    animation: versiondock-ai-stop-breathe 1.1s ease-in-out infinite;
  }
  .versiondock-ai-status[data-running="true"]::after {
    content: '';
    position: absolute;
    inset: auto auto 0 0;
    width: 28%;
    height: 1px;
    background: linear-gradient(90deg, transparent, var(--vscode-focusBorder), transparent);
    animation: versiondock-ai-status-scan 1.65s ease-in-out infinite;
  }
  .versiondock-ai-orbit {
    animation: versiondock-ai-orbit 1.2s linear infinite;
  }
  @media (prefers-reduced-motion: reduce) {
    .versiondock-ai-resolve-button { transition: none !important; }
    .versiondock-ai-resolve-button:hover:not(:disabled) { transform: none; }
    .versiondock-ai-resolve-button::after { animation: none !important; }
  }
`;

function normalEditsEqual(left: Record<number, string[]> | null, right: Record<number, string[]> | null): boolean {
  if (!left || !right) return left === right;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(key => {
    const index = Number(key);
    const leftLines = left[index] ?? [];
    const rightLines = right[index] ?? [];
    return leftLines.length === rightLines.length && leftLines.every((line, lineIndex) => line === rightLines[lineIndex]);
  });
}

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function readSyncScrollSetting() {
  try {
    return localStorage.getItem(SYNC_SCROLL_STORAGE_KEY) !== 'false';
  } catch {
    return true;
  }
}

function shouldDeleteResolvedFile(file: MergeConflictFile, resultContent: string, resolutions: Record<number, Resolution>): boolean {
  const deletedSide = file.oursStatus === 'deleted' ? 'ours' : file.theirsStatus === 'deleted' ? 'theirs' : undefined;
  if (!deletedSide || resultContent !== '' || file.conflicts.length === 0) return false;
  return file.conflicts.every((_, index) => resolutions[index] === deletedSide);
}

function cloneResolutions(resolutions: Record<number, Resolution>): Record<number, Resolution> {
  return Object.fromEntries(Object.entries(resolutions).map(([key, resolution]) => [
    Number(key),
    typeof resolution === 'object'
      ? { ...resolution, lines: [...resolution.lines], acceptedSides: [...resolution.acceptedSides] }
      : resolution,
  ]));
}

function cloneNormalEdits(edits: Record<number, string[]>): Record<number, string[]> {
  return Object.fromEntries(Object.entries(edits).map(([key, lines]) => [Number(key), [...lines]]));
}

function codeLinesEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}

function trimBoundaryBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === '') start += 1;
  while (end > start && lines[end - 1].trim() === '') end -= 1;
  return lines.slice(start, end);
}

function codeLinesEqualIgnoringBoundaryBlanks(left: string[], right: string[]): boolean {
  return codeLinesEqual(trimBoundaryBlankLines(left), trimBoundaryBlankLines(right));
}

function normalizeCodeForComparison(lines: string[]): string {
  return trimBoundaryBlankLines(lines).join('\n').replace(/\s+/g, ' ').trim();
}

function comparableCodeLines(lines: string[]): string[] {
  return lines
    .map(line => line.trim().replace(/\s+/g, ' '))
    .filter(line => line.length > 0);
}

function sideSpecificCodeLines(sideLines: string[], otherSideLines: string[]): string[] {
  const comparableSide = comparableCodeLines(sideLines);
  const comparableOtherSide = comparableCodeLines(otherSideLines);
  return diffLineChanges(comparableOtherSide, comparableSide).flatMap(change => change.lines);
}

function containsLinesInOrder(lines: string[], expectedLines: string[]): boolean {
  if (expectedLines.length === 0) return false;
  const comparableLines = comparableCodeLines(lines);
  let expectedIndex = 0;
  for (const line of comparableLines) {
    if (line !== expectedLines[expectedIndex]) continue;
    expectedIndex += 1;
    if (expectedIndex === expectedLines.length) return true;
  }
  return false;
}

function findLineSlice(lines: string[], slice: string[]): { start: number; end: number } | null {
  const candidate = trimBoundaryBlankLines(slice);
  if (candidate.length === 0 || candidate.length > lines.length) return null;
  for (let start = 0; start <= lines.length - candidate.length; start += 1) {
    if (candidate.every((line, index) => line === lines[start + index])) {
      return { start, end: start + candidate.length };
    }
  }
  return null;
}

function expandAiResolutionLines(
  markerConflict: MergeConflictFile['conflicts'][number],
  effectiveConflict: MergeConflictFile['conflicts'][number],
  resolvedLines: string[],
): string[] {
  const matchesMarkerOurs = codeLinesEqualIgnoringBoundaryBlanks(resolvedLines, markerConflict.oursLines);
  const matchesMarkerTheirs = codeLinesEqualIgnoringBoundaryBlanks(resolvedLines, markerConflict.theirsLines);
  if (matchesMarkerOurs && matchesMarkerTheirs) {
    return codeLinesEqual(effectiveConflict.oursLines, effectiveConflict.theirsLines)
      ? [...effectiveConflict.oursLines]
      : [...resolvedLines];
  }
  if (matchesMarkerOurs) return [...effectiveConflict.oursLines];
  if (matchesMarkerTheirs) return [...effectiveConflict.theirsLines];

  const oursSlice = findLineSlice(effectiveConflict.oursLines, markerConflict.oursLines);
  const theirsSlice = findLineSlice(effectiveConflict.theirsLines, markerConflict.theirsLines);
  if (oursSlice && !theirsSlice) {
    return [
      ...effectiveConflict.oursLines.slice(0, oursSlice.start),
      ...resolvedLines,
      ...effectiveConflict.oursLines.slice(oursSlice.end),
    ];
  }
  if (!oursSlice && theirsSlice) {
    return [
      ...effectiveConflict.theirsLines.slice(0, theirsSlice.start),
      ...resolvedLines,
      ...effectiveConflict.theirsLines.slice(theirsSlice.end),
    ];
  }
  if (!oursSlice || !theirsSlice) return [...resolvedLines];

  const oursPrefix = effectiveConflict.oursLines.slice(0, oursSlice.start);
  const theirsPrefix = effectiveConflict.theirsLines.slice(0, theirsSlice.start);
  const oursSuffix = effectiveConflict.oursLines.slice(oursSlice.end);
  const theirsSuffix = effectiveConflict.theirsLines.slice(theirsSlice.end);
  if (!codeLinesEqual(oursPrefix, theirsPrefix) || !codeLinesEqual(oursSuffix, theirsSuffix)) return [...resolvedLines];
  return [...oursPrefix, ...resolvedLines, ...oursSuffix];
}

function inferAiAcceptedSides(
  conflict: MergeConflictFile['conflicts'][number],
  resolvedLines: string[],
): Array<'ours' | 'theirs'> {
  const resolvedCode = normalizeCodeForComparison(resolvedLines);
  const matchesOurs = resolvedCode === normalizeCodeForComparison(conflict.oursLines);
  const matchesTheirs = resolvedCode === normalizeCodeForComparison(conflict.theirsLines);
  if (matchesOurs && matchesTheirs) return ['ours', 'theirs'];
  if (matchesOurs) return ['ours'];
  if (matchesTheirs) return ['theirs'];

  const keepsOurs = containsLinesInOrder(
    resolvedLines,
    sideSpecificCodeLines(conflict.oursLines, conflict.theirsLines),
  );
  const keepsTheirs = containsLinesInOrder(
    resolvedLines,
    sideSpecificCodeLines(conflict.theirsLines, conflict.oursLines),
  );
  if (keepsOurs && keepsTheirs) return ['ours', 'theirs'];
  if (keepsOurs) return ['ours'];
  if (keepsTheirs) return ['theirs'];
  return [];
}

function waitForAnimationFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

function waitForDelay(milliseconds: number): Promise<void> {
  return new Promise(resolve => window.setTimeout(resolve, milliseconds));
}

function App() {
  const store = useMergeStore();
  const [currentConflictIndex, setCurrentConflictIndex] = useState(0);
  const [iconTheme, setIconTheme] = useState<IconThemeData | null>(null);
  const [syncScrollEnabled, setSyncScrollEnabled] = useState(readSyncScrollSetting);
  const [appliedNonConflictingScope, setAppliedNonConflictingScope] = useState<NonConflictingChangeScope | null>(null);
  const [nonConflictingSelections, setNonConflictingSelections] = useState<NonConflictingSelections>({});
  const [aiState, setAiState] = useState<AiUiState>(IDLE_AI_STATE);
  const [aiDraft, setAiDraft] = useState<AiMergeDraft | null>(null);
  const aiRequestIdRef = useRef<string | null>(null);
  const aiRunTokenRef = useRef(0);
  const aiSnapshotRef = useRef<AiRunSnapshot | null>(null);
  const handleAiResultRef = useRef<(msg: AiResolveResultMessage) => void>(() => undefined);

  const send = useCallback((msg: MergeToHostMsg) => {
    getVsCodeApi().postMessage(msg);
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent<HostToMergeMsg>) => {
      const msg = event.data;
      if (!msg?.type) return;
      const state = useMergeStore.getState();
      switch (msg.type) {
        case 'MERGE_FILE_LOADED':
          aiRunTokenRef.current += 1;
          aiRequestIdRef.current = null;
          aiSnapshotRef.current = null;
          setAiState(IDLE_AI_STATE);
          setAiDraft(null);
          state.setFile(msg.file);
          setAppliedNonConflictingScope(null);
          setNonConflictingSelections({});
          {
            const baseNormalEdits = buildBaseNormalEdits(msg.file);
            if (baseNormalEdits) {
              const initializedState = useMergeStore.getState();
              initializedState.setNormalEdits(baseNormalEdits);
              initializedState.setResultContent(buildContentFromResolutions(msg.file, initializedState.resolutions, baseNormalEdits));
            } else {
              state.setResultContent(msg.file.content);
            }
          }
          if (msg.iconTheme !== undefined) setIconTheme(msg.iconTheme ?? null);
          if (msg.file.baseContent === undefined || msg.file.oursContent === undefined || msg.file.theirsContent === undefined) {
            state.setError(t('Unable to load three-way versions. Result pane is still available.'));
          }
          break;
        case 'MERGE_FILE_LOAD_FAILED':
          state.setError(msg.error);
          break;
        case 'MERGE_FILE_VERSIONS_LOADED':
          if (msg.error) state.setError(msg.error);
          break;
        case 'MERGE_AI_RESOLVE_RESULT':
          handleAiResultRef.current(msg);
          break;
        case 'MERGE_SAVE_RESULT':
          state.setSaving(false);
          if (msg.ok) state.setSavedOk(true);
          else state.setError(msg.error ?? t('Save failed'));
          break;
      }
    };
    window.addEventListener('message', handler);
    send({ type: 'MERGE_READY' });
    return () => window.removeEventListener('message', handler);
  }, [send]);

  const saveResolved = useCallback(() => {
    const state = useMergeStore.getState();
    if (state.resultContent.includes('<<<<<<<') || state.resultContent.includes('>>>>>>>')) {
      state.setError(t('Resolve all conflict markers before saving.'));
      return;
    }
    if (!state.file) return;
    state.setSaving(true);
    send({
      type: 'MERGE_SAVE_FILE',
      requestId: generateId(),
      resolvedContent: state.resultContent,
      deleteFile: shouldDeleteResolvedFile(state.file, state.resultContent, state.resolutions),
    });
  }, [send]);

  const unresolvedConflictIndexes = useMemo(() => {
    if (!store.file) return [];
    return store.file.conflicts
      .map((_, index) => index)
      .filter(index => store.resolutions[index] === 'unresolved');
  }, [store.file, store.resolutions]);
  const toolbarCounts = useMemo(
    () => store.file ? getMergeToolbarCounts(store.file) : { changeCount: 0, conflictCount: 0, nonConflictingCount: 0 },
    [store.file]
  );
  const nonConflictingChoices = useMemo(() => {
    if (!store.file) return null;
    return {
      base: buildBaseNormalEdits(store.file),
      left: buildNormalEditsForNonConflictingScope(store.file, 'left'),
      all: buildNormalEditsForNonConflictingScope(store.file, 'all'),
      right: buildNormalEditsForNonConflictingScope(store.file, 'right'),
    };
  }, [store.file]);
  const nonConflictingSelectionChoices = useMemo(() => {
    if (!store.file) return null;
    return {
      left: buildNonConflictingSelectionsForScope(store.file, 'left'),
      all: buildNonConflictingSelectionsForScope(store.file, 'all'),
      right: buildNonConflictingSelectionsForScope(store.file, 'right'),
    };
  }, [store.file]);

  const restoreAiSnapshot = useCallback(() => {
    const snapshot = aiSnapshotRef.current;
    const state = useMergeStore.getState();
    if (!snapshot || !state.file) return;
    state.file.conflicts.forEach((_, index) => {
      state.resolveBlock(index, snapshot.resolutions[index] ?? 'unresolved');
    });
    state.setNormalEdits(cloneNormalEdits(snapshot.normalEdits));
    state.setResultContent(snapshot.resultContent);
    setNonConflictingSelections({ ...snapshot.nonConflictingSelections });
    setAppliedNonConflictingScope(snapshot.appliedNonConflictingScope);
    setCurrentConflictIndex(snapshot.currentConflictIndex);
  }, []);

  const stopAiResolution = useCallback(() => {
    const requestId = aiRequestIdRef.current;
    if (requestId && aiState.phase === 'analyzing') {
      send({ type: 'MERGE_AI_CANCEL', requestId });
    }
    aiRunTokenRef.current += 1;
    restoreAiSnapshot();
    aiRequestIdRef.current = null;
    aiSnapshotRef.current = null;
    setAiDraft(null);
    setAiState(IDLE_AI_STATE);
  }, [aiState.phase, restoreAiSnapshot, send]);

  const handleAiResolveResult = useCallback((msg: AiResolveResultMessage) => {
    if (msg.requestId !== aiRequestIdRef.current) return;
    aiRequestIdRef.current = null;

    if (msg.error || !msg.resolutions) {
      aiRunTokenRef.current += 1;
      restoreAiSnapshot();
      aiSnapshotRef.current = null;
      setAiDraft(null);
      setAiState(IDLE_AI_STATE);
      if (msg.error && msg.error !== 'Cancelled') {
        useMergeStore.getState().setError(t('AI conflict resolution failed: {0}', msg.error));
      }
      return;
    }

    const resolutions = [...msg.resolutions].sort((left, right) => left.index - right.index);
    const runToken = ++aiRunTokenRef.current;
    setAiState({
      phase: 'typing',
      current: 0,
      total: resolutions.length,
      provider: msg.provider,
      model: msg.model,
    });

    void (async () => {
      try {
        const initialState = useMergeStore.getState();
        const snapshot = aiSnapshotRef.current;
        if (!snapshot || !initialState.file) return;
        const effectiveConflicts = getEffectiveConflictBlocks(initialState.file);

        const baseNormalEdits = nonConflictingChoices?.base;
        const allNormalEdits = nonConflictingChoices?.all;
        const allSelections = nonConflictingSelectionChoices?.all;
        const canAutoApplyNonConflicting = Boolean(
          baseNormalEdits
          && allNormalEdits
          && allSelections
          && Object.keys(snapshot.nonConflictingSelections).length === 0
          && normalEditsEqual(snapshot.normalEdits, baseNormalEdits),
        );

        if (canAutoApplyNonConflicting && allSelections && initialState.file) {
          const animatedSelections: NonConflictingSelections = {};
          for (const blockIndex of Object.keys(allSelections).map(Number).sort((left, right) => left - right)) {
            if (aiRunTokenRef.current !== runToken) return;
            animatedSelections[blockIndex] = allSelections[blockIndex];
            const normalEdits = buildNormalEditsForNonConflictingSelections(initialState.file, animatedSelections);
            if (normalEdits) {
              const currentState = useMergeStore.getState();
              currentState.setNormalEdits(normalEdits);
              currentState.setResultContent(buildContentFromResolutions(initialState.file, currentState.resolutions, normalEdits));
              setNonConflictingSelections({ ...animatedSelections });
              setAppliedNonConflictingScope(Object.keys(animatedSelections).length === Object.keys(allSelections).length ? 'all' : null);
            }
            await waitForDelay(80);
          }
        }

        for (let position = 0; position < resolutions.length; position += 1) {
          if (aiRunTokenRef.current !== runToken) return;
          const resolution = resolutions[position];
          const markerConflict = initialState.file.conflicts.find(conflict => conflict.index === resolution.index);
          const effectiveConflict = effectiveConflicts.find(conflict => conflict.index === resolution.index);
          if (!markerConflict || !effectiveConflict) throw new Error(t('Conflict {0} is no longer available. Reopen the Merge Editor.', resolution.index + 1));
          const expandedLines = expandAiResolutionLines(markerConflict, effectiveConflict, resolution.lines);
          const text = expandedLines.join('\n');
          setCurrentConflictIndex(resolution.index);
          setAiState({
            phase: 'typing',
            current: position + 1,
            total: resolutions.length,
            provider: msg.provider,
            model: msg.model,
          });

          if (text.length === 0) {
            setAiDraft({ index: resolution.index, content: '' });
            await waitForDelay(220);
          } else {
            const targetDuration = Math.min(6_000, Math.max(1_100, text.length * 11));
            const frameCount = Math.max(1, Math.floor(targetDuration / 16));
            const charactersPerFrame = Math.max(1, Math.ceil(text.length / frameCount));
            for (let cursor = charactersPerFrame; cursor < text.length + charactersPerFrame; cursor += charactersPerFrame) {
              if (aiRunTokenRef.current !== runToken) return;
              setAiDraft({ index: resolution.index, content: text.slice(0, Math.min(cursor, text.length)) });
              await waitForAnimationFrame();
            }
          }

          if (aiRunTokenRef.current !== runToken) return;
          const currentState = useMergeStore.getState();
          if (!currentState.file) return;
          const customResolution: Resolution = {
            type: 'custom',
            lines: expandedLines,
            acceptedSides: inferAiAcceptedSides(effectiveConflict, expandedLines),
            resolvedByAi: true,
          };
          const nextResolutions = { ...currentState.resolutions, [resolution.index]: customResolution };
          currentState.resolveBlock(resolution.index, customResolution);
          currentState.setResultContent(buildContentFromResolutions(currentState.file, nextResolutions, currentState.normalEdits));
          setAiDraft(null);
          await waitForDelay(140);
        }

        if (aiRunTokenRef.current !== runToken) return;
        aiSnapshotRef.current = null;
        setAiDraft(null);
        setAiState({
          phase: 'completed',
          current: resolutions.length,
          total: resolutions.length,
          provider: msg.provider,
          model: msg.model,
        });
      } catch (error: unknown) {
        if (aiRunTokenRef.current !== runToken) return;
        restoreAiSnapshot();
        aiSnapshotRef.current = null;
        setAiDraft(null);
        setAiState(IDLE_AI_STATE);
        useMergeStore.getState().setError(t('AI conflict resolution failed: {0}', error instanceof Error ? error.message : String(error)));
      }
    })();
  }, [nonConflictingChoices, nonConflictingSelectionChoices, restoreAiSnapshot]);

  handleAiResultRef.current = handleAiResolveResult;

  const startAiResolution = useCallback(() => {
    const state = useMergeStore.getState();
    if (!state.file) return;
    const conflictIndexes = state.file.conflicts
      .map((_, index) => index)
      .filter(index => state.resolutions[index] === 'unresolved');
    if (conflictIndexes.length === 0) return;

    aiRunTokenRef.current += 1;
    aiSnapshotRef.current = {
      resolutions: cloneResolutions(state.resolutions),
      normalEdits: cloneNormalEdits(state.normalEdits),
      resultContent: state.resultContent,
      nonConflictingSelections: { ...nonConflictingSelections },
      appliedNonConflictingScope,
      currentConflictIndex,
    };
    state.setError(null);
    setAiDraft(null);
    const requestId = generateId();
    aiRequestIdRef.current = requestId;
    setAiState({ phase: 'analyzing', current: 0, total: conflictIndexes.length });
    send({ type: 'MERGE_AI_RESOLVE', requestId, conflictIndexes });
  }, [appliedNonConflictingScope, currentConflictIndex, nonConflictingSelections, send]);

  useEffect(() => {
    if (!store.file || store.file.conflicts.length === 0) return;
    if (currentConflictIndex >= store.file.conflicts.length) {
      setCurrentConflictIndex(Math.max(0, store.file.conflicts.length - 1));
    }
  }, [currentConflictIndex, store.file]);

  const focusFirstUnresolvedConflict = useCallback(() => {
    if (unresolvedConflictIndexes.length === 0) return;
    setCurrentConflictIndex(unresolvedConflictIndexes[0]);
  }, [unresolvedConflictIndexes]);

  const goToPreviousUnresolvedConflict = useCallback(() => {
    const previous = [...unresolvedConflictIndexes].reverse().find(index => index < currentConflictIndex);
    if (previous === undefined) return;
    setCurrentConflictIndex(previous);
  }, [currentConflictIndex, unresolvedConflictIndexes]);

  const goToNextUnresolvedConflict = useCallback(() => {
    const next = unresolvedConflictIndexes.find(index => index > currentConflictIndex);
    if (next === undefined) return;
    setCurrentConflictIndex(next);
  }, [currentConflictIndex, unresolvedConflictIndexes]);

  const handleApplyNonConflicting = useCallback((scope: NonConflictingChangeScope) => {
    if (!store.file) return;
    const normalEdits = nonConflictingChoices?.[scope] ?? null;
    if (!normalEdits) {
      store.setError(t('Unable to apply non-conflicting changes for this file.'));
      return;
    }

    store.setNormalEdits(normalEdits);
    store.setResultContent(buildContentFromResolutions(store.file, store.resolutions, normalEdits));
    setNonConflictingSelections(nonConflictingSelectionChoices?.[scope] ?? {});
    setAppliedNonConflictingScope(scope);
    if (scope === 'all') focusFirstUnresolvedConflict();
  }, [focusFirstUnresolvedConflict, nonConflictingChoices, nonConflictingSelectionChoices, store]);

  const handleCancelNonConflicting = useCallback(() => {
    if (!store.file || !nonConflictingChoices?.base) return;
    store.setNormalEdits(nonConflictingChoices.base);
    store.setResultContent(buildContentFromResolutions(store.file, store.resolutions, nonConflictingChoices.base));
    setNonConflictingSelections({});
    setAppliedNonConflictingScope(null);
  }, [nonConflictingChoices, store]);

  const handleNormalEdit = useCallback((index: number, lines: string[]) => {
    // Editing the result customizes its text, but it must not forget which
    // non-conflicting side blocks were already accepted.
    setAppliedNonConflictingScope(null);
    store.setNormalEdit(index, lines);
  }, [store]);

  const handleSelectNonConflicting = useCallback((blockIndex: number, selection: NonConflictingSelection | 'base') => {
    if (!store.file) return;
    const nextSelections = { ...nonConflictingSelections };
    if (selection === 'base') delete nextSelections[blockIndex];
    else nextSelections[blockIndex] = selection;

    const normalEdits = buildNormalEditsForNonConflictingSelections(store.file, nextSelections);
    if (!normalEdits) {
      store.setError(t('Unable to apply non-conflicting changes for this file.'));
      return;
    }
    setNonConflictingSelections(nextSelections);
    setAppliedNonConflictingScope(null);
    store.setNormalEdits(normalEdits);
    store.setResultContent(buildContentFromResolutions(store.file, store.resolutions, normalEdits));
  }, [nonConflictingSelections, store]);

  const handleSyncScrollToggle = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const enabled = event.currentTarget.checked;
    setSyncScrollEnabled(enabled);
    try {
      localStorage.setItem(SYNC_SCROLL_STORAGE_KEY, String(enabled));
    } catch {
      // The current editor should still honor the toggle even if storage is unavailable.
    }
  }, []);

  const acceptSide = useCallback((side: 'ours' | 'theirs') => {
    if (!store.file) return;
    const nextResolutions = { ...store.resolutions };
    store.file.conflicts.forEach((_, index) => {
      nextResolutions[index] = side;
      store.resolveBlock(index, side);
    });
    store.setResultContent(buildContentFromResolutions(store.file, nextResolutions, store.normalEdits));
  }, [store]);

  const resetMerge = useCallback(() => {
    if (!store.file) return;
    aiRunTokenRef.current += 1;
    aiRequestIdRef.current = null;
    aiSnapshotRef.current = null;
    setAiDraft(null);
    setAiState(IDLE_AI_STATE);
    const unresolvedResolutions: Record<number, Resolution> = {};
    store.file.conflicts.forEach((_, index) => {
      unresolvedResolutions[index] = 'unresolved';
      store.resolveBlock(index, 'unresolved');
    });

    const baseNormalEdits = buildBaseNormalEdits(store.file);
    if (baseNormalEdits) {
      store.setNormalEdits(baseNormalEdits);
      store.setResultContent(buildContentFromResolutions(store.file, unresolvedResolutions, baseNormalEdits));
    } else {
      store.setNormalEdits({});
      store.setResultContent(store.file.content);
    }
    store.setError(null);
    setNonConflictingSelections({});
    setAppliedNonConflictingScope(null);
    setCurrentConflictIndex(0);
  }, [store]);

  if (!store.file) {
    return (
      <div style={styles.loading}>
        {store.error
          ? <span style={styles.loadingError}>{store.error}</span>
          : t('Loading merge editor...')}
      </div>
    );
  }

  const unresolved = store.unresolvedCount();
  const fileName = store.file.relativePath.split('/').pop() ?? store.file.relativePath;
  const previousUnresolvedIndex = [...unresolvedConflictIndexes].reverse().find(index => index < currentConflictIndex);
  const nextUnresolvedIndex = unresolvedConflictIndexes.find(index => index > currentConflictIndex);
  const canGoToPreviousUnresolved = previousUnresolvedIndex !== undefined;
  const canGoToNextUnresolved = nextUnresolvedIndex !== undefined;
  const canApplyNonConflicting = toolbarCounts.nonConflictingCount > 0;
  const canCancelNonConflicting = canApplyNonConflicting
    && Boolean(nonConflictingChoices?.base)
    && (Object.keys(nonConflictingSelections).length > 0 || !normalEditsEqual(store.normalEdits, nonConflictingChoices?.base ?? null));
  const canResetMerge = !store.saving && (
    Object.values(store.resolutions).some(resolution => resolution !== 'unresolved')
    || Object.keys(nonConflictingSelections).length > 0
    || (nonConflictingChoices?.base
      ? !normalEditsEqual(store.normalEdits, nonConflictingChoices.base)
      : Object.keys(store.normalEdits).length > 0)
  );
  const aiBusy = aiState.phase === 'analyzing' || aiState.phase === 'typing';
  const aiStatusMessage = aiState.phase === 'analyzing'
    ? t('AI is analyzing {0} conflicts…', aiState.total)
    : aiState.phase === 'typing'
      ? t('AI is writing conflict {0} of {1}…', aiState.current, aiState.total)
      : aiState.phase === 'completed'
        ? t('AI resolved {0} conflicts. Review the result before applying.', aiState.total)
        : '';
  const aiResultStatusLabel = aiState.phase === 'analyzing'
    ? t('AI analyzing')
    : aiState.phase === 'typing'
      ? t('AI writing {0}/{1}', aiState.current, aiState.total)
      : aiState.phase === 'completed'
        ? t('AI complete')
        : undefined;
  const aiProgress = aiState.phase === 'analyzing'
    ? 18
    : aiState.total > 0 ? Math.max(0, Math.min(100, (aiState.current / aiState.total) * 100)) : 0;

  return (
    <div style={styles.app}>
      <style>{AI_MERGE_STYLES}</style>
      <div style={styles.pathHeader}>
        <FileIcon name={fileName} theme={iconTheme} size={16} style={styles.fileIcon} />
        <span style={styles.pathText}>{store.file.relativePath}</span>
        <button
          type="button"
          className="versiondock-ai-resolve-button"
          data-running={aiBusy || undefined}
          style={styles.aiResolveButton(unresolved === 0 && !aiBusy)}
          disabled={unresolved === 0 && !aiBusy}
          onClick={aiBusy ? stopAiResolution : startAiResolution}
          title={aiBusy ? t('Stop AI conflict resolution') : t('Resolve all remaining conflicts with AI')}
        >
          <Codicon name={aiBusy ? 'stop-circle' : 'sparkle-filled'} style={styles.aiResolveIcon} />
          <span>{aiBusy ? t('Stop AI') : unresolved > 0 ? t('Resolve {0} conflicts with AI', unresolved) : t('AI resolved')}</span>
        </button>
      </div>

      {store.error && <div style={styles.error}>{store.error}</div>}

      <div style={styles.mergeToolbar}>
        <div style={styles.toolbarLeft}>
          <button
            style={styles.navButton(!canGoToPreviousUnresolved || aiBusy)}
            disabled={!canGoToPreviousUnresolved || aiBusy}
            onClick={goToPreviousUnresolvedConflict}
            title={t('Previous Unresolved Conflict')}
          >
            ↑
          </button>
          <button
            style={styles.navButton(!canGoToNextUnresolved || aiBusy)}
            disabled={!canGoToNextUnresolved || aiBusy}
            onClick={goToNextUnresolvedConflict}
            title={t('Next Unresolved Conflict')}
          >
            ↓
          </button>
          <span style={styles.separator} />
          <span style={styles.toolbarLabel}>{t('Apply non-conflicting changes:')}</span>
          {(['left', 'all', 'right'] as const).map(scope => (
            <button
              key={scope}
              style={styles.scopeButton(!canApplyNonConflicting || aiBusy, appliedNonConflictingScope === scope)}
              disabled={!canApplyNonConflicting || aiBusy}
              title={t('Apply {0} non-conflicting changes', scope === 'left' ? t('Left') : scope === 'all' ? t('All') : t('Right'))}
              onClick={() => handleApplyNonConflicting(scope)}
            >
              <span style={styles.scopeIcon}>{scope === 'left' ? '»' : scope === 'all' ? '⇄' : '«'}</span>
              {scope === 'left' ? t('Left') : scope === 'all' ? t('All') : t('Right')}
            </button>
          ))}
          <button
            style={styles.scopeButton(!canCancelNonConflicting || aiBusy)}
            disabled={!canCancelNonConflicting || aiBusy}
            title={t('Restore non-conflicting changes to Base')}
            onClick={handleCancelNonConflicting}
          >
            <Codicon name="discard" style={styles.scopeIcon} />
            {t('Cancel application')}
          </button>
          <span style={styles.separator} />
          <label style={styles.syncLabel}>
            <input type="checkbox" checked={syncScrollEnabled} onChange={handleSyncScrollToggle} style={{ ...styles.syncInput, ...nativeCheckboxBorderStyle() }} />
            {t('Synchronous Scrolling')}
          </label>
        </div>
        <span style={styles.toolbarStats}>{t('{0} changes · {1} conflicts', toolbarCounts.changeCount, toolbarCounts.conflictCount)} · {unresolved > 0 ? t('{0} conflicts remaining', unresolved) : t('All conflicts resolved')}</span>
      </div>

      {aiState.phase !== 'idle' && (
        <div
          className="versiondock-ai-status"
          data-running={aiBusy || undefined}
          style={styles.aiStatus(aiState.phase)}
          role="status"
          aria-live="polite"
        >
          <span className={aiBusy ? 'versiondock-ai-orbit' : undefined} style={styles.aiStatusIconWrap}>
            <Codicon name={aiState.phase === 'completed' ? 'check' : 'sparkle'} style={styles.aiStatusIcon(aiState.phase)} />
          </span>
          <span style={styles.aiStatusText}>{aiStatusMessage}</span>
          {(aiState.provider || aiState.model) && (
            <span style={styles.aiProviderLabel}>{[aiState.provider, aiState.model].filter(Boolean).join(' · ')}</span>
          )}
          <span style={styles.aiProgressTrack} aria-hidden="true">
            <span style={styles.aiProgressFill(aiProgress, aiState.phase)} />
          </span>
        </div>
      )}

      <ThreeWayLayout
        file={store.file}
        resolutions={store.resolutions}
        normalEdits={store.normalEdits}
        nonConflictingSelections={nonConflictingSelections}
        language={store.language}
        onResultChange={store.setResultContent}
        onResolveBlock={store.resolveBlock}
        onNormalEdit={handleNormalEdit}
        onSelectNonConflicting={handleSelectNonConflicting}
        currentConflictIndex={currentConflictIndex}
        syncScrollEnabled={syncScrollEnabled}
        readOnly={aiBusy}
        aiDraft={aiDraft}
        resultStatusLabel={aiResultStatusLabel}
        showCompletionNotice={unresolved === 0 && !store.saving && !aiBusy}
        onApplyResolved={saveResolved}
      />

      <div style={styles.footer}>
        <div style={styles.footerGroup}>
          <button style={styles.footerButton(store.saving || aiBusy)} disabled={store.saving || aiBusy} onClick={() => acceptSide('ours')}>{t('Accept Current')}</button>
          <button style={styles.footerButton(store.saving || aiBusy)} disabled={store.saving || aiBusy} onClick={() => acceptSide('theirs')}>{t('Accept Incoming')}</button>
          <button style={styles.footerButton(!canResetMerge || aiBusy)} disabled={!canResetMerge || aiBusy} onClick={resetMerge}>{t('Reset')}</button>
        </div>
        <div style={styles.footerGroup}>
          <button style={styles.footerButton(aiBusy)} disabled={aiBusy} onClick={() => send({ type: 'MERGE_CLOSE' })}>{t('Cancel')}</button>
          <button style={styles.applyButton(store.saving || unresolved > 0 || aiBusy)} disabled={store.saving || unresolved > 0 || aiBusy} onClick={saveResolved}>{store.saving ? t('Saving...') : t('Apply')}</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  app: { height: '100vh', display: 'flex', flexDirection: 'column' as const, background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)', fontFamily: 'var(--vscode-font-family)', overflow: 'hidden' },
  loading: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--vscode-editor-background)', color: 'var(--vscode-descriptionForeground)' },
  loadingError: { maxWidth: 720, padding: 24, color: 'var(--vscode-errorForeground)', whiteSpace: 'pre-wrap' as const, textAlign: 'center' as const },
  pathHeader: { height: 40, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px 0 12px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 },
  fileIcon: { width: 16, height: 16, flexShrink: 0 } as React.CSSProperties,
  pathText: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontSize: 13 },
  aiResolveButton: (disabled: boolean): React.CSSProperties => ({
    minWidth: 0,
    height: 28,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    padding: '0 11px',
    border: 'none',
    borderRadius: 6,
    boxSizing: 'border-box',
    background: 'linear-gradient(125deg, #7657ff, #2f8fff)',
    color: '#ffffff',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 12,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'filter 140ms ease, transform 140ms ease',
  }),
  aiResolveIcon: { fontSize: 15, lineHeight: '15px', color: 'currentColor' },
  error: { padding: '6px 12px', color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)', borderBottom: '1px solid var(--vscode-inputValidation-errorBorder)', fontSize: 12 },
  mergeToolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 30, padding: '4px 12px', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12, flexShrink: 0 },
  toolbarLeft: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } as React.CSSProperties,
  navButton: (disabled?: boolean): React.CSSProperties => ({ border: '1px solid var(--vscode-panel-border)', borderRadius: 3, background: 'transparent', color: disabled ? 'var(--vscode-disabledForeground)' : 'var(--vscode-foreground)', padding: '1px 7px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }),
  separator: { width: 1, height: 18, background: 'var(--vscode-panel-border)', flexShrink: 0 } as React.CSSProperties,
  toolbarLabel: { color: 'var(--vscode-descriptionForeground)', whiteSpace: 'nowrap' as const },
  scopeButton: (disabled?: boolean, active?: boolean): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px solid ${active ? 'var(--vscode-focusBorder)' : 'var(--vscode-panel-border)'}`, borderRadius: 3, background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent', color: disabled ? 'var(--vscode-disabledForeground)' : active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)', padding: '2px 8px', fontSize: 12, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.65 : 1 }),
  scopeIcon: { color: 'var(--vscode-textLink-foreground)', fontSize: 13, lineHeight: '16px' },
  syncLabel: { display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const },
  syncInput: { margin: 0 },
  toolbarStats: { color: 'var(--vscode-descriptionForeground)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' } as React.CSSProperties,
  aiStatus: (phase: AiPhase): React.CSSProperties => ({
    position: 'relative',
    minHeight: 28,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '0 12px',
    overflow: 'hidden',
    flexShrink: 0,
    borderBottom: '1px solid color-mix(in srgb, var(--vscode-focusBorder) 34%, var(--vscode-panel-border))',
    background: phase === 'completed'
      ? 'color-mix(in srgb, var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground)) 7%, var(--vscode-editor-background))'
      : 'color-mix(in srgb, var(--vscode-focusBorder) 7%, var(--vscode-editor-background))',
    color: 'var(--vscode-foreground)',
    fontSize: 11,
  }),
  aiStatusIconWrap: { width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  aiStatusIcon: (phase: AiPhase): React.CSSProperties => ({
    fontSize: 13,
    color: phase === 'completed'
      ? 'var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground))'
      : 'var(--vscode-focusBorder, var(--vscode-textLink-foreground))',
  }),
  aiStatusText: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontWeight: 550 },
  aiProviderLabel: { marginLeft: 'auto', color: 'var(--vscode-descriptionForeground)', whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '30%' },
  aiProgressTrack: { width: 88, height: 2, overflow: 'hidden', flexShrink: 0, borderRadius: 2, background: 'color-mix(in srgb, var(--vscode-foreground) 14%, transparent)' },
  aiProgressFill: (progress: number, phase: AiPhase): React.CSSProperties => ({
    display: 'block',
    width: `${progress}%`,
    height: '100%',
    borderRadius: 2,
    background: phase === 'completed'
      ? 'var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground))'
      : 'var(--vscode-focusBorder, var(--vscode-textLink-foreground))',
    transition: 'width 180ms ease',
  }),
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--vscode-panel-border)', flexShrink: 0 },
  footerGroup: { display: 'flex', gap: 8 },
  footerButton: (disabled = false): React.CSSProperties => ({ padding: '5px 14px', border: '1px solid var(--vscode-button-border, transparent)', borderRadius: 3, background: 'var(--vscode-button-secondaryBackground)', color: disabled ? 'var(--vscode-disabledForeground)' : 'var(--vscode-button-secondaryForeground)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.62 : 1 }),
  applyButton: (disabled = false): React.CSSProperties => ({ padding: '5px 14px', border: '1px solid var(--vscode-button-border, transparent)', borderRadius: 3, background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1, fontWeight: 600 }),
};

createRoot(document.getElementById('root')!).render(
  <WebviewErrorBoundary
    title={t('Merge Editor render failed')}
    onError={(error, componentStack) => {
      getVsCodeApi().postMessage({
        type: 'MERGE_WEBVIEW_ERROR',
        message: error.message,
        stack: error.stack,
        componentStack,
      } satisfies MergeToHostMsg);
    }}
  >
    <App />
  </WebviewErrorBoundary>,
);
