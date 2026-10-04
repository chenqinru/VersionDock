import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { getWebviewI18nPayload, t } from './l10n';
import { loadColorTheme } from './ColorThemeService';
import { getWebviewScrollbarHead } from './webviewScrollbars';

export function generateNonce(): string {
  return crypto.randomBytes(16).toString('base64');
}

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  appName: 'commitPanel' | 'gitLog' | 'mergeEditor' | 'conflicts' | 'undockedPanel' | 'aiCommitComposer' | 'aiCodeReview',
  title: string,
  initialConfig?: Record<string, unknown>,
): string {
  const nonce = generateNonce();
  const i18n = getWebviewI18nPayload();
  const i18nPayload = JSON.stringify(i18n).replace(/</g, '\\u003c');
  const colorThemePayload = JSON.stringify(loadColorTheme()).replace(/</g, '\\u003c');
  const appNamePayload = JSON.stringify(appName).replace(/</g, '\\u003c');
  const initialConfigPayload = JSON.stringify(initialConfig ?? {}).replace(/</g, '\\u003c');

  const jsUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'out', 'webview', appName, 'index.js')
  );

  const codiconCssUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data: https:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `worker-src blob:`,
    `font-src ${webview.cspSource} data:`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="${i18n.locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${codiconCssUri}">
  <title>${t(title)}</title>
  ${getWebviewScrollbarHead(nonce)}
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; overflow: hidden; height: 100vh; }
    #root { height: 100vh; display: flex; flex-direction: column; }
    body.cursor-host { max-width: calc(100vw - 1px); }

    /* Keep compact VersionDock badges on one theme-controlled color. */
    :root {
      --versiondock-badge-background: var(--vscode-badge-background, var(--vscode-button-background, #0078d4));
      --versiondock-badge-foreground: var(--vscode-badge-foreground, var(--vscode-button-foreground, #ffffff));
    }

    /* ── Themed checkboxes ──────────────────────────────────────────────────── */
    input[type="checkbox"] {
      appearance: none;
      -webkit-appearance: none;
      width: 14px;
      height: 14px;
      border: 1.5px solid var(--vscode-focusBorder, #007fd4);
      border-radius: 3px;
      background: transparent;
      cursor: pointer;
      flex-shrink: 0;
      position: relative;
      vertical-align: middle;
      transition: background 0.12s, border-color 0.12s, box-shadow 0.12s;
    }
    input[type="checkbox"]:hover {
      background: var(--vscode-focusBorder, #007fd4)22;
      box-shadow: 0 0 0 2px var(--vscode-focusBorder, #007fd4)33;
    }
    input[type="checkbox"]:checked,
    input[type="checkbox"]:indeterminate {
      background: var(--vscode-focusBorder, #007fd4);
      border-color: var(--vscode-focusBorder, #007fd4);
    }
    input[type="checkbox"]:checked::after {
      content: '';
      position: absolute;
      left: 3px;
      top: 0px;
      width: 4px;
      height: 8px;
      border: 2px solid #fff;
      border-top: none;
      border-left: none;
      transform: rotate(45deg);
    }
    input[type="checkbox"]:indeterminate::after {
      content: '';
      position: absolute;
      left: 2px;
      top: 5px;
      width: 8px;
      height: 2px;
      background: #fff;
      border-radius: 1px;
    }
    input[type="checkbox"]:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }
    input[type="checkbox"]:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    body[data-versiondock-checkbox-low-contrast] input[type="checkbox"]:not(:disabled) {
      border-color: color-mix(in srgb, var(--vscode-foreground, #cccccc) 62%, transparent);
    }

    /* ── Hover actions in file rows ─────────────────────────────────────────── */
    .file-row:hover .file-actions { opacity: 1 !important; }
    .file-row .file-actions { opacity: 0; transition: opacity 0.1s; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__VERSIONDOCK_I18N__ = ${i18nPayload};
    window.__VERSIONDOCK_COLOR_THEME__ = ${colorThemePayload};
    window.__VERSIONDOCK_APP_NAME__ = ${appNamePayload};
    window.__INITIAL_CONFIG__ = ${initialConfigPayload};
    if (/Cursor/.test(navigator.userAgent)) document.body.classList.add('cursor-host');

    (() => {
      const contrastRatio = (foreground, background, fallbackBackground) => {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return Number.POSITIVE_INFINITY;

        context.fillStyle = fallbackBackground;
        context.fillRect(0, 0, 2, 1);
        context.fillStyle = background;
        context.fillRect(0, 0, 2, 1);
        context.fillStyle = foreground;
        context.fillRect(1, 0, 1, 1);

        const pixels = context.getImageData(0, 0, 2, 1).data;
        const luminance = (offset) => {
          const channels = [pixels[offset], pixels[offset + 1], pixels[offset + 2]].map(channel => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const backgroundLuminance = luminance(0);
        const foregroundLuminance = luminance(4);
        const lighter = Math.max(foregroundLuminance, backgroundLuminance);
        const darker = Math.min(foregroundLuminance, backgroundLuminance);
        return (lighter + 0.05) / (darker + 0.05);
      };
      const updateCheckboxContrast = () => {
        const styles = getComputedStyle(document.body);
        const border = styles.getPropertyValue('--vscode-focusBorder').trim() || '#007fd4';
        const surfaceToken = window.__VERSIONDOCK_APP_NAME__ === 'commitPanel'
          ? '--vscode-sideBar-background'
          : '--vscode-editor-background';
        const fallbackBackground = document.body.classList.contains('vscode-light')
          || document.body.classList.contains('vscode-high-contrast-light')
          ? '#ffffff'
          : '#1e1e1e';
        const background = styles.getPropertyValue(surfaceToken).trim()
          || styles.backgroundColor
          || fallbackBackground;
        document.body.toggleAttribute(
          'data-versiondock-checkbox-low-contrast',
          contrastRatio(border, background, fallbackBackground) < 2,
        );
      };
      updateCheckboxContrast();
      new MutationObserver(updateCheckboxContrast).observe(document.body, {
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
    })();
  </script>
  <script nonce="${nonce}" type="module" src="${jsUri}"></script>
</body>
</html>`;
}
