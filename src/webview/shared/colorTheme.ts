export interface ColorToken {
  scope?: string | string[];
  settings: {
    foreground?: string;
    background?: string;
    fontStyle?: string;
  };
}

export interface WebviewColorThemeData {
  name: string;
  type: 'dark' | 'light';
  fg: string;
  bg: string;
  base: 'vs' | 'vs-dark' | 'hc-black' | 'hc-light';
  inherit: boolean;
  rules: Array<{ token: string; foreground?: string; background?: string; fontStyle?: string }>;
  colors: Record<string, string>;
  settings: ColorToken[];
}

interface MonacoThemeApi {
  editor: {
    defineTheme: (themeName: string, themeData: WebviewColorThemeData) => void;
    setTheme: (themeName: string) => void;
  };
}

declare global {
  interface Window {
    __VERSIONDOCK_COLOR_THEME__?: WebviewColorThemeData;
  }
}

export const VERSIONDOCK_MONACO_THEME = 'versiondock-vscode-theme';

export function registerVersionDockMonacoTheme(monaco: MonacoThemeApi): string {
  const theme = window.__VERSIONDOCK_COLOR_THEME__;
  if (!theme) return getFallbackMonacoTheme();

  monaco.editor.defineTheme(VERSIONDOCK_MONACO_THEME, theme);
  return VERSIONDOCK_MONACO_THEME;
}

export function getVersionDockColorTheme(): WebviewColorThemeData | null {
  return window.__VERSIONDOCK_COLOR_THEME__ ?? null;
}

function getFallbackMonacoTheme(): string {
  const body = document.body;
  if (body.classList.contains('vscode-high-contrast-light')) return 'hc-light';
  if (body.classList.contains('vscode-high-contrast')) return 'hc-black';
  if (body.classList.contains('vscode-dark')) return 'vs-dark';
  return 'vs';
}
