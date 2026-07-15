import { create } from 'zustand';
import type { MergeConflictFile } from '../../shared/types';

export type CustomResolution = { type: 'custom'; lines: string[] };
export type Resolution = 'ours' | 'theirs' | 'both' | 'unresolved' | CustomResolution;
export type NormalEdits = Record<number, string[]>;

interface MergeState {
  file: MergeConflictFile | null;
  resultContent: string;
  resolutions: Record<number, Resolution>;
  normalEdits: NormalEdits;
  language: string;
  savedOk: boolean;
  saving: boolean;
  error: string | null;

  setFile: (file: MergeConflictFile) => void;
  setResultContent: (content: string) => void;
  resolveBlock: (index: number, resolution: Resolution) => void;
  setNormalEdit: (index: number, lines: string[]) => void;
  setNormalEdits: (edits: NormalEdits) => void;
  setSaving: (v: boolean) => void;
  setSavedOk: (v: boolean) => void;
  setError: (err: string | null) => void;
  unresolvedCount: () => number;
}

export const useMergeStore = create<MergeState>((set, get) => ({
  file: null,
  resultContent: '',
  resolutions: {},
  normalEdits: {},
  language: 'plaintext',
  savedOk: false,
  saving: false,
  error: null,

  setFile: (file) => {
    // Build initial result content (raw conflict file content)
    const resolutions: Record<number, Resolution> = {};
    file.conflicts.forEach((_, i) => { resolutions[i] = 'unresolved'; });
    set({ file, resolutions, normalEdits: {}, language: file.language ?? 'plaintext', savedOk: false, error: null });
  },

  setResultContent: (content) => set({ resultContent: content, savedOk: false }),

  resolveBlock: (index, resolution) => set(s => ({
    resolutions: { ...s.resolutions, [index]: resolution },
    savedOk: false,
  })),

  setNormalEdit: (index, lines) => set(s => ({
    normalEdits: { ...s.normalEdits, [index]: lines },
    savedOk: false,
  })),

  setNormalEdits: (edits) => set({ normalEdits: edits, savedOk: false }),

  setSaving: (v) => set({ saving: v }),
  setSavedOk: (v) => set({ savedOk: v }),
  setError: (err) => set({ error: err }),

  unresolvedCount: () => {
    const { resolutions } = get();
    return Object.values(resolutions).filter(r => r === 'unresolved').length;
  },
}));
