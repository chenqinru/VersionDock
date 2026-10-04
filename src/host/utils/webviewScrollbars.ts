import * as vscode from 'vscode';
import { initializeWebviewScrollbars } from './webviewScrollbarRuntime';

type ScrollbarVisibility = 'system' | 'auto' | 'visible';

function getScrollbarAppearance(): { modernUi: boolean; reduceMotion: 'on' | 'off' | 'auto' } {
  const config = vscode.workspace.getConfiguration('workbench');
  const reduceMotion = config.get<string>('reduceMotion', 'auto');
  return {
    modernUi: config.get<boolean>('experimental.modernUI', false) === true,
    reduceMotion: reduceMotion === 'on' || reduceMotion === 'off' ? reduceMotion : 'auto',
  };
}

function getScrollbarVisibility(): ScrollbarVisibility {
  const value = vscode.workspace.getConfiguration('versiondock').get<string>('scrollbarVisibility', 'system');
  return value === 'auto' || value === 'visible' ? value : 'system';
}

/** Attach before assigning HTML, and dispose with the owning panel/view. */
export function registerWebviewScrollbars(owner: vscode.WebviewPanel | vscode.WebviewView): vscode.Disposable {
  const update = () => {
    void owner.webview.postMessage({
      type: 'VERSIONDOCK_SCROLLBAR_VISIBILITY_UPDATE',
      visibility: getScrollbarVisibility(),
      ...getScrollbarAppearance(),
    }).then(undefined, () => { /* The view may have been disposed. */ });
  };
  const disposables = [
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('versiondock.scrollbarVisibility')
        || event.affectsConfiguration('workbench.experimental.modernUI')
        || event.affectsConfiguration('workbench.reduceMotion')) update();
    }),
    owner.webview.onDidReceiveMessage((message: { type?: string } | null) => {
      if (message?.type === 'VERSIONDOCK_SCROLLBAR_READY') update();
    }),
  ];
  if ('onDidChangeVisibility' in owner) {
    disposables.push(owner.onDidChangeVisibility(() => { if (owner.visible) update(); }));
  } else {
    disposables.push(owner.onDidChangeViewState(() => { if (owner.visible) update(); }));
  }
  const registration = vscode.Disposable.from(...disposables);
  const onDispose = owner.onDidDispose(() => {
    registration.dispose();
    onDispose.dispose();
  });
  return vscode.Disposable.from(registration, onDispose);
}

export function getWebviewScrollbarHead(nonce: string): string {
  const appearance = getScrollbarAppearance();
  const forcedRoot = 'html:is([data-versiondock-scrollbar-visibility="auto"], [data-versiondock-scrollbar-visibility="visible"])';
  const forcedTargets = `:is(${forcedRoot}, ${forcedRoot} *)`;
  return `<style>
    ${forcedRoot} {
      --versiondock-scrollbar-size: 10px;
      --versiondock-scrollbar-radius: 0px;
    }
    ${forcedRoot}[data-versiondock-scrollbar-modern-ui="true"] {
      --versiondock-scrollbar-size: 8px;
      --versiondock-scrollbar-radius: var(--vscode-cornerRadius-small, 4px);
    }
    /* Native scrolling stays intact; only its bars and reserved gutter are removed. */
    ${forcedTargets} {
      scrollbar-width: none !important;
      scrollbar-gutter: auto !important;
    }
    ${forcedTargets}::-webkit-scrollbar {
      display: none !important;
      width: 0 !important;
      height: 0 !important;
    }
    ${forcedRoot} [data-versiondock-scrollbar-layer] {
      display: contents;
      pointer-events: none;
    }
    ${forcedRoot} [data-versiondock-scrollbar-viewport] {
      position: fixed;
      pointer-events: none;
    }
    ${forcedRoot} [data-versiondock-scrollbar-viewport] > [data-versiondock-overlay-scrollbar] {
      position: absolute;
      opacity: 0;
      pointer-events: none;
      touch-action: none;
    }
    ${forcedRoot} [data-versiondock-scrollbar-viewport] [role="scrollbar"] {
      position: absolute;
      background: var(--vscode-scrollbarSlider-background, rgba(121, 121, 121, 0.4));
    }
    ${forcedRoot} [data-versiondock-scrollbar-viewport] [role="scrollbar"]:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    html[data-versiondock-scrollbar-visibility="visible"] [data-versiondock-overlay-scrollbar],
    html[data-versiondock-scrollbar-visibility="auto"] [data-versiondock-scrollbar-container]:hover > [data-versiondock-overlay-scrollbar] {
      opacity: 1 !important;
      pointer-events: auto !important;
    }
    ${forcedRoot} [data-versiondock-overlay-scrollbar] {
      transition: opacity 800ms linear !important;
    }
    html[data-versiondock-scrollbar-visibility="visible"] [data-versiondock-overlay-scrollbar],
    html[data-versiondock-scrollbar-visibility="auto"] [data-versiondock-overlay-scrollbar][data-versiondock-scrollbar-active],
    html[data-versiondock-scrollbar-visibility="auto"] [data-versiondock-scrollbar-container]:hover > [data-versiondock-overlay-scrollbar] {
      transition-duration: 100ms !important;
    }
    ${forcedRoot} [data-versiondock-overlay-scrollbar="vertical"] {
      width: var(--versiondock-scrollbar-size) !important;
    }
    ${forcedRoot} [data-versiondock-overlay-scrollbar="horizontal"] {
      height: var(--versiondock-scrollbar-size) !important;
    }
    ${forcedRoot} [data-versiondock-overlay-scrollbar] > [role="scrollbar"] {
      border-radius: var(--versiondock-scrollbar-radius) !important;
    }
    ${forcedRoot} [data-versiondock-overlay-scrollbar] > [role="scrollbar"]:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground, rgba(100, 100, 100, 0.7)) !important;
    }
    ${forcedRoot} [data-versiondock-overlay-scrollbar] > [role="scrollbar"]:active {
      background: var(--vscode-scrollbarSlider-activeBackground, rgba(100, 100, 100, 0.9)) !important;
    }
    ${forcedRoot} [data-versiondock-overlay-scrollbar="vertical"] > [role="scrollbar"] {
      right: 0 !important;
      width: var(--versiondock-scrollbar-size) !important;
    }
    ${forcedRoot} [data-versiondock-overlay-scrollbar="horizontal"] > [role="scrollbar"] {
      bottom: 0 !important;
      height: var(--versiondock-scrollbar-size) !important;
    }
    ${forcedRoot}[data-versiondock-scrollbar-reduce-motion="on"] [data-versiondock-overlay-scrollbar] {
      transition: none !important;
    }
    @media (prefers-reduced-motion: reduce) {
      ${forcedRoot}:not([data-versiondock-scrollbar-reduce-motion="off"]) [data-versiondock-overlay-scrollbar] {
        transition: none !important;
      }
    }
    @media (forced-colors: active) {
      ${forcedRoot} [data-versiondock-overlay-scrollbar] > [role="scrollbar"] {
        background: CanvasText !important;
      }
    }
  </style>
  <script nonce="${nonce}">
    document.documentElement.dataset.versiondockScrollbarVisibility = ${JSON.stringify(getScrollbarVisibility())};
    document.documentElement.dataset.versiondockScrollbarModernUi = ${JSON.stringify(String(appearance.modernUi))};
    document.documentElement.dataset.versiondockScrollbarReduceMotion = ${JSON.stringify(appearance.reduceMotion)};
    (${initializeWebviewScrollbars.toString()})();
  </script>`;
}
