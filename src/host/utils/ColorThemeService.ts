import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface WebviewColorThemeData {
  name: string;
  type: 'dark' | 'light';
  fg: string;
  bg: string;
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>;
  colors: Record<string, string>;
  settings: RawThemeRule[];
}

interface ThemeContribution { id?: string; label?: string; path?: string }
export interface RawThemeRule { scope?: string | string[]; settings: { foreground?: string; background?: string; fontStyle?: string } }
interface RawThemeJson {
  name?: string;
  include?: string;
  colors?: Record<string, string>;
  tokenColors?: RawThemeRule[] | string;
  settings?: RawThemeRule[];
}

export function loadColorTheme(): WebviewColorThemeData {
  const base = getBaseTheme();
  const type = base === 'vs' || base === 'hc-light' ? 'light' : 'dark';
  const fallback = createFallbackTheme('VS Code', base, type);

  try {
    const themePath = findActiveThemePath();
    if (!themePath) return fallback;
    const json = loadThemeJson(themePath, new Set());
    const tokens = readResolvedTokenColors(json);
    const colors = json.colors ?? {};
    const fg = colors['editor.foreground'] ?? colors.foreground ?? (type === 'light' ? '#333333' : '#cccccc');
    const bg = colors['editor.background'] ?? (type === 'light' ? '#ffffff' : '#1e1e1e');

    return {
      name: `versiondock-${json.name ?? 'VS Code'}`,
      type,
      fg,
      bg,
      base,
      inherit: true,
      rules: toMonacoRules(tokens),
      colors,
      settings: [
        { settings: { foreground: fg, background: bg } },
        ...tokens,
      ],
    };
  } catch {
    return fallback;
  }
}

function createFallbackTheme(name: string, base: WebviewColorThemeData['base'], type: WebviewColorThemeData['type']): WebviewColorThemeData {
  const fg = type === 'light' ? '#333333' : '#cccccc';
  const bg = type === 'light' ? '#ffffff' : '#1e1e1e';
  const settings: RawThemeRule[] = [{ settings: { foreground: fg, background: bg } }];

  return {
    name: `versiondock-${name || 'fallback'}`,
    type,
    fg,
    bg,
    base,
    inherit: true,
    rules: [],
    colors: {},
    settings,
  };
}

function getBaseTheme(): WebviewColorThemeData['base'] {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'vs';
    case vscode.ColorThemeKind.HighContrast:
      return 'hc-black';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'hc-light';
    case vscode.ColorThemeKind.Dark:
    default:
      return 'vs-dark';
  }
}

function findActiveThemePath(): string | undefined {
  const colorTheme = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
  if (!colorTheme) return undefined;
  const target = normalizeThemeName(colorTheme);

  for (const ext of vscode.extensions.all) {
    const themes: ThemeContribution[] = ext.packageJSON?.contributes?.themes ?? [];
    for (const theme of themes) {
      if (!theme.path) continue;
      const themePath = path.resolve(ext.extensionPath, theme.path);
      const themeName = readThemeName(themePath);
      if (
        normalizeThemeName(theme.id) === target ||
        normalizeThemeName(theme.label) === target ||
        normalizeThemeName(themeName) === target
      ) {
        return themePath;
      }
    }
  }

  return undefined;
}

function normalizeThemeName(name: string | undefined): string {
  return (name ?? '').replace(/^default\s+/i, '').replace(/^%|%$/g, '').trim().toLowerCase();
}

function readThemeName(themePath: string): string {
  try {
    return parseJsonc(fs.readFileSync(themePath, 'utf8')).name ?? '';
  } catch {
    return '';
  }
}

function loadThemeJson(themePath: string, seen: Set<string>): RawThemeJson {
  const normalized = path.normalize(themePath);
  if (seen.has(normalized)) return {};
  seen.add(normalized);

  const current = parseJsonc(fs.readFileSync(normalized, 'utf8'));
  const include = typeof current.include === 'string'
    ? loadThemeJson(path.resolve(path.dirname(normalized), current.include), seen)
    : {};

  return {
    name: current.name ?? include.name,
    colors: { ...(include.colors ?? {}), ...(current.colors ?? {}) },
    tokenColors: [...readResolvedTokenColors(include), ...readResolvedTokenColors(current, normalized)],
  };
}

function readResolvedTokenColors(theme: RawThemeJson, themePath?: string): RawThemeRule[] {
  const tokens = theme.tokenColors ?? theme.settings ?? [];
  if (typeof tokens === 'string') {
    if (!themePath) return [];
    return readResolvedTokenColors(loadThemeJson(path.resolve(path.dirname(themePath), tokens), new Set()));
  }
  return tokens;
}

function toMonacoRules(tokenColors: RawThemeRule[]): WebviewColorThemeData['rules'] {
  const rules: WebviewColorThemeData['rules'] = [];

  for (const rule of tokenColors) {
    if (!rule.scope || !rule.settings) continue;
    const scopes = Array.isArray(rule.scope) ? rule.scope : rule.scope.split(',');
    for (const scope of scopes) {
      const token = scope.trim();
      if (!token) continue;
      rules.push({
        token,
        foreground: stripHash(rule.settings.foreground),
        background: stripHash(rule.settings.background),
        fontStyle: rule.settings.fontStyle,
      });
    }
  }

  return rules;
}

function stripHash(value?: string): string | undefined {
  return value?.replace(/^#/, '');
}

function parseJsonc(text: string): RawThemeJson {
  let result = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (text[i] === '"') {
      result += text[i++];
      while (i < text.length) {
        if (text[i] === '\\') { result += text[i++]; result += text[i++]; continue; }
        result += text[i];
        if (text[i++] === '"') break;
      }
      continue;
    }
    result += text[i++];
  }

  return normalizeThemeJson(JSON.parse(result.replace(/,(\s*[}\]])/g, '$1')));
}

function normalizeThemeJson(value: unknown): RawThemeJson {
  if (Array.isArray(value)) return { tokenColors: value.filter(isThemeRule) };
  if (!isRecord(value)) return {};
  return {
    name: typeof value.name === 'string' ? value.name : undefined,
    include: typeof value.include === 'string' ? value.include : undefined,
    colors: readStringMap(value.colors),
    tokenColors: readTokenColors(value.tokenColors),
    settings: readTokenColors(value.settings),
  };
}

function readTokenColors(value: unknown): RawThemeRule[] | string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  return value.filter(isThemeRule);
}

function isThemeRule(value: unknown): value is RawThemeRule {
  if (!isRecord(value)) return false;
  const scope = value.scope;
  const settings = value.settings;
  const validScope = typeof scope === 'string' || (Array.isArray(scope) && scope.every(item => typeof item === 'string'));
  return validScope && isRecord(settings);
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
