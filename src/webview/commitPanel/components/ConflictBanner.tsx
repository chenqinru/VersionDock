import React, { useLayoutEffect } from 'react';
import { Codicon } from '../../shared/Codicon';
import { t } from '../../shared/i18n';

export interface ConflictBannerAction {
  id: string;
  label: string;
  title: string;
  tone: 'primary' | 'danger';
  onClick: () => void;
}

interface Props {
  summary: string;
  actions: ConflictBannerAction[];
}

const STYLE_ID = 'versiondock-conflict-banner-styles';

export function ConflictBanner({ summary, actions }: Props) {
  useLayoutEffect(() => {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      @keyframes vd-conflict-banner-in {
        from { opacity: 0; transform: translateY(-4px); }
        to { opacity: 1; transform: translateY(0); }
      }

      .vd-conflict-banner {
        position: relative;
        display: flex;
        align-items: center;
        gap: 9px;
        width: 100%;
        min-height: 44px;
        padding: 7px 9px 7px 10px;
        box-sizing: border-box;
        flex-shrink: 0;
        overflow: hidden;
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 7%, var(--vscode-sideBar-background));
        border-bottom: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 24%, var(--vscode-panel-border));
        font-family: var(--vscode-font-family);
        animation: vd-conflict-banner-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
      }

      .vd-conflict-banner::before {
        content: '';
        position: absolute;
        inset: 0 auto 0 0;
        width: 2px;
        background: var(--vscode-editorWarning-foreground, #cca700);
        box-shadow: 0 0 8px color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 55%, transparent);
      }

      .vd-conflict-banner__signal {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        flex: 0 0 24px;
        border-radius: 6px;
        color: var(--vscode-editorWarning-foreground, #cca700);
        background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 13%, transparent);
        border: 1px solid color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 25%, transparent);
      }

      .vd-conflict-banner__copy {
        display: grid;
        gap: 1px;
        flex: 1;
        min-width: 110px;
        line-height: 1.25;
      }

      .vd-conflict-banner__title {
        overflow: hidden;
        color: var(--vscode-foreground);
        font-size: 11px;
        font-weight: 650;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .vd-conflict-banner__summary {
        overflow: hidden;
        color: var(--vscode-descriptionForeground);
        font-size: 10px;
        font-weight: 500;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .vd-conflict-banner__actions {
        display: flex;
        align-items: center;
        gap: 5px;
        margin-left: auto;
        flex-shrink: 0;
      }

      .vd-conflict-banner__action {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        height: 26px;
        padding: 0 9px;
        box-sizing: border-box;
        border-radius: 4px;
        font-family: var(--vscode-font-family);
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
        white-space: nowrap;
        cursor: pointer;
        transition: transform 120ms ease, background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
      }

      .vd-conflict-banner__action:hover {
        transform: translateY(-1px);
      }

      .vd-conflict-banner__action:active {
        transform: translateY(0);
      }

      .vd-conflict-banner__action:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 2px;
      }

      .vd-conflict-banner__action--primary {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
        border: 1px solid transparent;
      }

      .vd-conflict-banner__action--primary:hover {
        background: var(--vscode-button-hoverBackground);
        box-shadow: 0 2px 7px color-mix(in srgb, var(--vscode-button-background) 35%, transparent);
      }

      .vd-conflict-banner__action--danger {
        color: var(--vscode-statusBarItem-errorForeground, #ffffff);
        background: var(--vscode-statusBarItem-errorBackground, #b42318);
        border: 1px solid transparent;
      }

      .vd-conflict-banner__action--danger:hover {
        background: color-mix(in srgb, var(--vscode-statusBarItem-errorBackground, #b42318) 92%, white);
        box-shadow: 0 2px 7px color-mix(in srgb, var(--vscode-statusBarItem-errorBackground, #b42318) 26%, transparent);
      }

      @media (prefers-reduced-motion: reduce) {
        .vd-conflict-banner,
        .vd-conflict-banner__action {
          animation: none;
          transition: none;
        }
      }
    `;
    document.head.appendChild(style);
  }, []);

  return (
    <section className="vd-conflict-banner" aria-label={t('There are still unresolved conflicts')}>
      <span className="vd-conflict-banner__signal" aria-hidden="true">
        <Codicon name="git-merge" style={{ fontSize: '13px' }} />
      </span>
      <span className="vd-conflict-banner__copy" aria-live="polite">
        <span className="vd-conflict-banner__title">{t('There are still unresolved conflicts')}</span>
        <span className="vd-conflict-banner__summary" title={summary}>{summary}</span>
      </span>
      <span className="vd-conflict-banner__actions">
        {actions.map(action => (
          <button
            key={action.id}
            type="button"
            className={`vd-conflict-banner__action vd-conflict-banner__action--${action.tone}`}
            title={action.title}
            onClick={action.onClick}
          >
            {action.label}
          </button>
        ))}
      </span>
    </section>
  );
}
