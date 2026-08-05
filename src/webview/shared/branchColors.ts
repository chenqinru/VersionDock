import { isPrimaryBranch } from './branchUtils';
import type { BranchInfo } from './types';

export const HEAD_COLOR_DARK = '#c9a84c';
export const HEAD_COLOR_LIGHT = '#8a6914';

// Tag color — neutral grey so tags do not compete with branch colors.
const TAG_COLOR_DARK = '#909090';
const TAG_COLOR_LIGHT = '#707070';

const PALETTE_DARK: readonly string[] = [
  '#6aaed0', '#cc6a9a', '#6ab86a', '#cc7070',
  '#8c70cc', '#cc7a50', '#4aaa9a', '#cc8060',
  '#a0cc6a', '#6a8ecc', '#cc6ab0', '#7acc80',
  '#cc6060', '#6accc0', '#b870cc', '#6ab0d0',
];

const PALETTE_LIGHT: readonly string[] = [
  '#2e6898', '#962860', '#2a7828', '#963232',
  '#4a2e96', '#963818', '#1a7a6a', '#964018',
  '#587818', '#2a4e98', '#962878', '#2a7840',
  '#982020', '#287878', '#6a2496', '#2a6890',
];

function parseColor(raw: string): [number, number, number] | null {
  const s = raw.trim();
  const hex = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (rgb) return [parseInt(rgb[1]), parseInt(rgb[2]), parseInt(rgb[3])];
  return null;
}

function luminance(r: number, g: number, b: number): number {
  const s = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * s(r) + 0.7152 * s(g) + 0.0722 * s(b);
}

function toHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

export function darkenToThreshold(raw: string, threshold: number): string {
  const rgb = parseColor(raw);
  if (!rgb) return raw;
  let [r, g, b] = rgb;
  let lum = luminance(r, g, b);
  while (lum > threshold) {
    r = Math.round(r * 0.82);
    g = Math.round(g * 0.82);
    b = Math.round(b * 0.82);
    lum = luminance(r, g, b);
  }
  return toHex(r, g, b);
}

export function lightenToThreshold(raw: string, threshold: number): string {
  const rgb = parseColor(raw);
  if (!rgb) return raw;
  let [r, g, b] = rgb;
  let lum = luminance(r, g, b);
  while (lum < threshold) {
    r = Math.min(255, Math.round(r * 1.15 + 8));
    g = Math.min(255, Math.round(g * 1.15 + 8));
    b = Math.min(255, Math.round(b * 1.15 + 8));
    const next = luminance(r, g, b);
    if (next === lum) break; // no progress (already at 255)
    lum = next;
  }
  return toHex(r, g, b);
}

export function isDarkTheme(): boolean {
  return typeof document !== 'undefined' &&
    (document.body.classList.contains('vscode-dark') ||
      document.body.classList.contains('vscode-high-contrast'));
}

function readCssVar(...vars: string[]): string {
  if (typeof document === 'undefined') return '';
  for (const v of vars) {
    const val = getComputedStyle(document.body).getPropertyValue(v).trim() ||
      getComputedStyle(document.documentElement).getPropertyValue(v).trim();
    if (val) return val;
  }
  return '';
}

export function primaryBranchColor(): string {
  const raw = readCssVar('--vscode-button-background') || '#0078d4';
  return isDarkTheme() ? lightenToThreshold(raw, 0.28) : darkenToThreshold(raw, 0.22);
}

/** Keep repository accents readable when their stored palette was authored for a different theme. */
export function readableAccentColor(raw: string): string {
  return isDarkTheme() ? lightenToThreshold(raw, 0.18) : darkenToThreshold(raw, 0.3);
}

export function headColor(): string {
  return isDarkTheme() ? HEAD_COLOR_DARK : HEAD_COLOR_LIGHT;
}

export function tagColor(): string {
  return isDarkTheme() ? TAG_COLOR_DARK : TAG_COLOR_LIGHT;
}

export function currentPalette(): readonly string[] {
  return isDarkTheme() ? PALETTE_DARK : PALETTE_LIGHT;
}

// Normalize only unambiguous full refs. Short names containing a slash may be
// local branches (feature/foo), so stripping their first segment corrupts both
// primary-branch detection and the stable color assignment.
export function normalizeBranchName(name: string): string {
  if (name.startsWith('refs/heads/')) return name.slice('refs/heads/'.length);
  if (name.startsWith('refs/remotes/')) {
    const remoteRef = name.slice('refs/remotes/'.length);
    const slash = remoteRef.indexOf('/');
    return slash >= 0 ? remoteRef.slice(slash + 1) : remoteRef;
  }
  return name;
}

export function branchPaletteIndex(name: string): number {
  const normalized = normalizeBranchName(name);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash % PALETTE_DARK.length;
}

// Returns the color for a branch name. isHead=true gives the reserved HEAD color
// for non-primary branches. Primary branches always get the VSCode primary color.
export function branchColor(name: string, isHead = false): string {
  const normalized = normalizeBranchName(name);
  if (isPrimaryBranch(normalized)) return primaryBranchColor();
  if (isHead) return headColor();
  return currentPalette()[branchPaletteIndex(normalized)];
}

export function branchInfoColor(branch: Pick<BranchInfo, 'name' | 'detachedTag' | 'detachedHash'>): string {
  if (branch.detachedTag) return tagColor();
  if (branch.detachedHash) return headColor();
  return branchColor(branch.name);
}
