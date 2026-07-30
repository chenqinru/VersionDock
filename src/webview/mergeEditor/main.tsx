import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useMergeStore, type Resolution } from './store/mergeStore';
import {
  buildBaseNormalEdits,
  buildContentFromResolutions,
  buildNonConflictingSelectionsForScope,
  buildNormalEditsForNonConflictingSelections,
  buildNormalEditsForNonConflictingScope,
  getMergeToolbarCounts,
  type NonConflictingChangeScope,
  type NonConflictingSelection,
  type NonConflictingSelections,
  ThreeWayLayout,
} from './components/ThreeWayLayout';
import { getVsCodeApi } from '../shared/vscodeApi';
import { FileIcon } from '../shared/FileIcon';
import { WebviewErrorBoundary } from '../shared/WebviewErrorBoundary';
import type { HostToMergeMsg, IconThemeData, MergeToHostMsg } from '../../host/types/messages';
import { t } from '../shared/i18n';
import type { MergeConflictFile } from '../shared/types';
import { Codicon } from '../shared/Codicon';

const SYNC_SCROLL_STORAGE_KEY = 'versiondock.merge.syncScroll';

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

function App() {
  const store = useMergeStore();
  const [currentConflictIndex, setCurrentConflictIndex] = useState(0);
  const [iconTheme, setIconTheme] = useState<IconThemeData | null>(null);
  const [syncScrollEnabled, setSyncScrollEnabled] = useState(readSyncScrollSetting);
  const [appliedNonConflictingScope, setAppliedNonConflictingScope] = useState<NonConflictingChangeScope | null>(null);
  const [nonConflictingSelections, setNonConflictingSelections] = useState<NonConflictingSelections>({});

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
        case 'MERGE_FILE_VERSIONS_LOADED':
          if (msg.error) state.setError(msg.error);
          break;
        case 'MERGE_SAVE_RESULT':
          state.setSaving(false);
          if (msg.ok) state.setSavedOk(true);
          else state.setError(msg.error ?? t('Save failed'));
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

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

  if (!store.file) return <div style={styles.loading}>{t('Loading merge editor...')}</div>;

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

  return (
    <div style={styles.app}>
      <div style={styles.pathHeader}>
        <FileIcon name={fileName} theme={iconTheme} size={16} style={styles.fileIcon} />
        <span style={styles.pathText}>{store.file.relativePath}</span>
      </div>

      {store.error && <div style={styles.error}>{store.error}</div>}

      <div style={styles.mergeToolbar}>
        <div style={styles.toolbarLeft}>
          <button
            style={styles.navButton(!canGoToPreviousUnresolved)}
            disabled={!canGoToPreviousUnresolved}
            onClick={goToPreviousUnresolvedConflict}
            title={t('Previous Unresolved Conflict')}
          >
            ↑
          </button>
          <button
            style={styles.navButton(!canGoToNextUnresolved)}
            disabled={!canGoToNextUnresolved}
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
              style={styles.scopeButton(!canApplyNonConflicting, appliedNonConflictingScope === scope)}
              disabled={!canApplyNonConflicting}
              title={t('Apply {0} non-conflicting changes', scope === 'left' ? t('Left') : scope === 'all' ? t('All') : t('Right'))}
              onClick={() => handleApplyNonConflicting(scope)}
            >
              <span style={styles.scopeIcon}>{scope === 'left' ? '»' : scope === 'all' ? '⇄' : '«'}</span>
              {scope === 'left' ? t('Left') : scope === 'all' ? t('All') : t('Right')}
            </button>
          ))}
          <button
            style={styles.scopeButton(!canCancelNonConflicting)}
            disabled={!canCancelNonConflicting}
            title={t('Restore non-conflicting changes to Base')}
            onClick={handleCancelNonConflicting}
          >
            <Codicon name="discard" style={styles.scopeIcon} />
            {t('Cancel application')}
          </button>
          <span style={styles.separator} />
          <label style={styles.syncLabel}>
            <input type="checkbox" checked={syncScrollEnabled} onChange={handleSyncScrollToggle} style={styles.syncInput} />
            {t('Synchronous Scrolling')}
          </label>
        </div>
        <span style={styles.toolbarStats}>{t('{0} changes · {1} conflicts', toolbarCounts.changeCount, toolbarCounts.conflictCount)} · {unresolved > 0 ? t('{0} conflicts remaining', unresolved) : t('All conflicts resolved')}</span>
      </div>

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
      />

      <div style={styles.footer}>
        <div style={styles.footerGroup}>
          <button style={styles.footerButton(store.saving)} disabled={store.saving} onClick={() => acceptSide('ours')}>{t('Accept Current')}</button>
          <button style={styles.footerButton(store.saving)} disabled={store.saving} onClick={() => acceptSide('theirs')}>{t('Accept Incoming')}</button>
          <button style={styles.footerButton(!canResetMerge)} disabled={!canResetMerge} onClick={resetMerge}>{t('Reset')}</button>
        </div>
        <div style={styles.footerGroup}>
          <button style={styles.footerButton()} onClick={() => send({ type: 'MERGE_CLOSE' })}>{t('Cancel')}</button>
          <button style={styles.applyButton} disabled={store.saving || unresolved > 0} onClick={saveResolved}>{store.saving ? t('Saving...') : t('Apply')}</button>
        </div>
      </div>
    </div>
  );
}

const styles = {
  app: { height: '100vh', display: 'flex', flexDirection: 'column' as const, background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)', fontFamily: 'var(--vscode-font-family)', overflow: 'hidden' },
  loading: { height: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', opacity: 0.65, background: 'var(--vscode-editor-background)', color: 'var(--vscode-foreground)' },
  pathHeader: { height: 34, display: 'flex', alignItems: 'center', gap: 8, padding: '0 12px', borderBottom: '1px solid var(--vscode-panel-border)', flexShrink: 0 },
  fileIcon: { width: 16, height: 16, flexShrink: 0 } as React.CSSProperties,
  pathText: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, fontSize: 13 },
  error: { padding: '6px 12px', color: 'var(--vscode-inputValidation-errorForeground)', background: 'var(--vscode-inputValidation-errorBackground)', borderBottom: '1px solid var(--vscode-inputValidation-errorBorder)', fontSize: 12 },
  mergeToolbar: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, minHeight: 30, padding: '4px 12px', borderBottom: '1px solid var(--vscode-panel-border)', fontSize: 12, flexShrink: 0 },
  toolbarLeft: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } as React.CSSProperties,
  navButton: (disabled?: boolean): React.CSSProperties => ({ border: '1px solid var(--vscode-panel-border)', borderRadius: 3, background: 'transparent', color: disabled ? 'var(--vscode-disabledForeground)' : 'var(--vscode-foreground)', padding: '1px 7px', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.55 : 1 }),
  separator: { width: 1, height: 18, background: 'var(--vscode-panel-border)', flexShrink: 0 } as React.CSSProperties,
  toolbarLabel: { opacity: 0.78, whiteSpace: 'nowrap' as const },
  scopeButton: (disabled?: boolean, active?: boolean): React.CSSProperties => ({ display: 'inline-flex', alignItems: 'center', gap: 4, border: `1px solid ${active ? 'var(--vscode-focusBorder)' : 'var(--vscode-panel-border)'}`, borderRadius: 3, background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent', color: disabled ? 'var(--vscode-disabledForeground)' : active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)', padding: '2px 8px', fontSize: 12, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.65 : 1 }),
  scopeIcon: { color: 'var(--vscode-textLink-foreground)', fontSize: 13, lineHeight: '16px' },
  syncLabel: { display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' as const },
  syncInput: { margin: 0 },
  toolbarStats: { opacity: 0.7, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' } as React.CSSProperties,
  footer: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', borderTop: '1px solid var(--vscode-panel-border)', flexShrink: 0 },
  footerGroup: { display: 'flex', gap: 8 },
  footerButton: (disabled = false): React.CSSProperties => ({ padding: '5px 14px', border: '1px solid var(--vscode-button-border, transparent)', borderRadius: 3, background: 'var(--vscode-button-secondaryBackground)', color: disabled ? 'var(--vscode-disabledForeground)' : 'var(--vscode-button-secondaryForeground)', cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.62 : 1 }),
  applyButton: { padding: '5px 14px', border: '1px solid var(--vscode-button-border, transparent)', borderRadius: 3, background: 'var(--vscode-button-background)', color: 'var(--vscode-button-foreground)', cursor: 'pointer' },
};

createRoot(document.getElementById('root')!).render(
  <WebviewErrorBoundary title={t('Merge Editor render failed')}>
    <App />
  </WebviewErrorBoundary>,
);
