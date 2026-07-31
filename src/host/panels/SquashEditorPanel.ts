import * as vscode from 'vscode';
import type { AiCommitMessageEditorGenerator } from '../aiCommitMessage/types';
import { generateNonce } from '../utils/webviewHtml';
import { getWebviewI18nPayload, t } from '../utils/l10n';

export interface SquashEditorResult {
  confirmed: boolean;
  message: string;
}

export interface SquashCommitInfo {
  hash: string;
  shortHash: string;
  message: string;
}

export async function openSquashEditor(
  extensionUri: vscode.Uri,
  commitCount: number,
  commits: SquashCommitInfo[],
  generateCommitMessage: AiCommitMessageEditorGenerator,
): Promise<SquashEditorResult> {
  return new Promise(resolve => {
    const nonce = generateNonce();
    const i18n = getWebviewI18nPayload();
    const panel = vscode.window.createWebviewPanel(
      'versiondockSquash',
      t('Squash {0} commits', commitCount),
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: false }
    );

    const codiconUri = panel.webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, 'media', 'codicons', 'codicon.css')
    );

    const csp = [
      `default-src 'none'`,
      `style-src ${panel.webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${panel.webview.cspSource}`,
    ].join('; ');

    panel.webview.html = getHtml(nonce, csp, codiconUri.toString(), i18n.locale, commitCount, commits);

    let settled = false;
    let activeGeneration: vscode.CancellationTokenSource | undefined;
    const cancelGeneration = () => {
      const source = activeGeneration;
      activeGeneration = undefined;
      source?.cancel();
      source?.dispose();
    };
    const settle = (result: SquashEditorResult) => {
      if (settled) return;
      settled = true;
      cancelGeneration();
      panel.dispose();
      resolve(result);
    };

    panel.webview.onDidReceiveMessage((msg: { type: string; message?: string }) => {
      if (msg.type === 'confirm') settle({ confirmed: true, message: msg.message ?? '' });
      else if (msg.type === 'cancel') settle({ confirmed: false, message: '' });
      else if (msg.type === 'cancelGeneration') cancelGeneration();
      else if (msg.type === 'generate' && !activeGeneration) {
        const source = new vscode.CancellationTokenSource();
        activeGeneration = source;
        void generateCommitMessage(
          source.token,
          message => void panel.webview.postMessage({ type: 'generationUpdate', message }),
        ).then(message => {
          if (activeGeneration !== source || source.token.isCancellationRequested) return;
          void panel.webview.postMessage({ type: 'generationComplete', message });
        }).catch((error: unknown) => {
          if (activeGeneration !== source || source.token.isCancellationRequested) return;
          const message = error instanceof Error ? error.message : String(error);
          void panel.webview.postMessage({ type: 'generationError', message });
        }).finally(() => {
          if (activeGeneration === source) activeGeneration = undefined;
          source.dispose();
        });
      }
    });

    panel.onDidDispose(() => {
      cancelGeneration();
      settle({ confirmed: false, message: '' });
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getHtml(nonce: string, csp: string, codiconUri: string, locale: string, commitCount: number, commits: SquashCommitInfo[]): string {
  const commitRows = commits.map(c =>
    `<div class="commit-row">
      <span class="commit-hash">${escapeHtml(c.shortHash)}</span>
      <span class="commit-msg">${escapeHtml(c.message)}</span>
    </div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="${escapeHtml(locale)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${codiconUri}">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
      height: 100vh;
      display: flex; flex-direction: column;
    }
    .header {
      display: flex; align-items: center; gap: 8px;
      padding: 16px 24px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    .header-icon {
      font-size: 18px;
      opacity: 0.7;
      color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d);
    }
    .header-title {
      font-size: 15px; font-weight: 600;
    }
    .header-sub {
      font-size: 12px; opacity: 0.55; margin-top: 1px;
    }
    .body {
      flex: 1; display: flex; flex-direction: column;
      padding: 20px 24px; gap: 10px; overflow: auto;
    }
    .label {
      font-size: 11px; opacity: 0.55;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .commit-list {
      display: flex; flex-direction: column;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 3px;
      overflow: hidden;
      flex-shrink: 0;
    }
    .commit-row {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 5px 10px;
      font-size: 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .commit-row:last-child { border-bottom: none; }
    .commit-hash {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; opacity: 0.5; flex-shrink: 0;
    }
    .commit-msg {
      min-width: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.5;
      opacity: 0.85;
    }
    .message-editor {
      position: relative;
      isolation: isolate;
    }
    textarea {
      position: relative; z-index: 1;
      display: block; min-height: 160px;
      width: 100%; resize: none;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      padding: 10px 38px 10px 12px;
      font-family: var(--vscode-editor-font-family, var(--vscode-font-family));
      font-size: 13px; line-height: 1.6;
      outline: none;
      background-clip: padding-box;
    }
    textarea:focus {
      border-color: var(--vscode-focusBorder);
    }
    textarea[data-generating="true"] {
      border-color: transparent;
      cursor: default;
      animation: ai-textarea-breathe 1.2s ease-in-out infinite;
    }
    .ai-marquee-border {
      position: absolute;
      inset: 0;
      z-index: 0;
      overflow: hidden;
      border-radius: 4px;
      pointer-events: none;
      box-shadow: 0 0 8px color-mix(in srgb, var(--vscode-focusBorder) 32%, transparent);
    }
    .ai-marquee-border[hidden] { display: none; }
    .ai-marquee-border::before {
      content: '';
      position: absolute;
      inset: -220%;
      background: conic-gradient(
        from 0deg,
        transparent 0deg,
        transparent 250deg,
        var(--vscode-charts-blue, #3794ff) 285deg,
        var(--vscode-charts-purple, #a371f7) 315deg,
        var(--vscode-focusBorder, #007acc) 345deg,
        transparent 360deg
      );
      animation: ai-marquee-spin 1.45s linear infinite;
    }
    @keyframes ai-marquee-spin { to { transform: rotate(1turn); } }
    @keyframes ai-textarea-breathe {
      0%, 100% { filter: brightness(0.82); }
      50% { filter: brightness(0.55); }
    }
    .btn-ai {
      position: absolute;
      top: 7px;
      right: 7px;
      z-index: 2;
      padding: 3px;
      background: transparent;
      color: var(--vscode-foreground);
      opacity: 0.72;
      line-height: 1;
    }
    .btn-ai:hover { background: var(--vscode-toolbar-hoverBackground); opacity: 1; }
    .generation-error {
      display: none;
      margin-top: 6px;
      color: var(--vscode-errorForeground);
      font-size: 12px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .generation-error.visible { display: block; }
    @media (prefers-reduced-motion: reduce) {
      textarea[data-generating="true"] { animation: none; filter: brightness(0.7); }
    }
    .footer {
      display: flex; align-items: center; justify-content: flex-end; gap: 8px;
      padding: 12px 24px 20px;
      border-top: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
    }
    button {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 16px; border-radius: 3px;
      font-family: var(--vscode-font-family);
      font-size: 13px; cursor: pointer; border: none;
    }
    .btn-cancel {
      background: var(--vscode-button-secondaryBackground, transparent);
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      border: 1px solid var(--vscode-button-border, var(--vscode-panel-border));
    }
    .btn-cancel:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
    }
    .btn-confirm {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    .btn-confirm:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    .btn-confirm:disabled {
      opacity: 0.45; cursor: default;
    }
  </style>
</head>
<body>
  <div class="header">
    <span class="codicon codicon-fold header-icon"></span>
    <div>
      <div class="header-title">${escapeHtml(t('Squash {0} commits', commitCount))}</div>
      <div class="header-sub">${escapeHtml(t('Edit the combined commit message below, then confirm.'))}</div>
    </div>
  </div>
  <div class="body">
    ${commitRows ? `<div>
      <div class="label" style="margin-bottom:6px">${escapeHtml(t('Commits being squashed'))}</div>
      <div class="commit-list">${commitRows}</div>
    </div>` : ''}
    <div>
      <div class="label" style="margin-bottom:6px">${escapeHtml(t('Commit message'))}</div>
      <div class="message-editor">
        <span class="ai-marquee-border" id="aiMarquee" aria-hidden="true" hidden></span>
        <textarea id="msg" autofocus spellcheck="false" data-generating="false"></textarea>
        <button class="btn-ai" id="aiBtn" title="${escapeHtml(t('Generate commit message with AI'))}" aria-label="${escapeHtml(t('Generate commit message with AI'))}">
          <span class="codicon codicon-sparkle" id="aiIcon"></span>
        </button>
      </div>
      <div class="generation-error" id="generationError" role="alert"></div>
    </div>
  </div>
  <div class="footer">
    <button class="btn-cancel" id="cancelBtn">
      <span class="codicon codicon-close" style="font-size:13px"></span>
      ${escapeHtml(t('Cancel'))}
    </button>
    <button class="btn-confirm" id="confirmBtn">
      <span class="codicon codicon-check" style="font-size:13px"></span>
      ${escapeHtml(t('Confirm Squash'))}
    </button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const ta = document.getElementById('msg');
    const confirmBtn = document.getElementById('confirmBtn');
    const aiBtn = document.getElementById('aiBtn');
    const aiIcon = document.getElementById('aiIcon');
    const aiMarquee = document.getElementById('aiMarquee');
    const generationError = document.getElementById('generationError');
    const generateTitle = ${JSON.stringify(t('Generate commit message with AI'))};
    const stopTitle = ${JSON.stringify(t('Stop generating commit message'))};
    const generatingPlaceholder = ${JSON.stringify(t('Generating commit message…'))};
    let generating = false;

    const update = () => { confirmBtn.disabled = generating || !ta.value.trim(); };
    const setGenerating = value => {
      generating = value;
      ta.readOnly = value;
      ta.dataset.generating = value ? 'true' : 'false';
      ta.placeholder = value ? generatingPlaceholder : '';
      aiMarquee.hidden = !value;
      aiIcon.className = 'codicon ' + (value ? 'codicon-stop-circle' : 'codicon-sparkle');
      aiBtn.title = value ? stopTitle : generateTitle;
      aiBtn.setAttribute('aria-label', aiBtn.title);
      update();
    };
    const hideGenerationError = () => {
      generationError.textContent = '';
      generationError.classList.remove('visible');
    };
    ta.addEventListener('input', update);
    update();

    ta.focus();
    ta.setSelectionRange(0, ta.value.length);

    aiBtn.addEventListener('click', () => {
      hideGenerationError();
      if (generating) {
        setGenerating(false);
        vscode.postMessage({ type: 'cancelGeneration' });
        return;
      }
      ta.value = '';
      setGenerating(true);
      vscode.postMessage({ type: 'generate' });
    });

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'generationUpdate') {
        ta.value = message.message || '';
        update();
      } else if (message.type === 'generationComplete') {
        ta.value = message.message || ta.value;
        setGenerating(false);
      } else if (message.type === 'generationError') {
        setGenerating(false);
        generationError.textContent = message.message || '';
        generationError.classList.add('visible');
      }
    });

    document.getElementById('cancelBtn').addEventListener('click', () => {
      vscode.postMessage({ type: 'cancel' });
    });
    confirmBtn.addEventListener('click', () => {
      if (generating) return;
      const msg = ta.value.trim();
      if (!msg) return;
      vscode.postMessage({ type: 'confirm', message: msg });
    });

    document.addEventListener('keydown', e => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        if (generating) return;
        const msg = ta.value.trim();
        if (msg) vscode.postMessage({ type: 'confirm', message: msg });
      }
    });
  </script>
</body>
</html>`;
}
