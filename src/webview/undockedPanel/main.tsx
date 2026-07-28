import './setupDispatch';

import React from 'react';
import { createRoot } from 'react-dom/client';
import { CommitApp } from '../commitPanel/main';
import { GitLogApp } from '../gitLog/main';
import { ResizeHandle } from '../shared/ResizeHandle';
import { useResize } from '../shared/useResize';
import { WebviewErrorBoundary } from '../shared/WebviewErrorBoundary';
import { t } from '../shared/i18n';

declare const window: Window & { __INITIAL_CONFIG__?: { showCommit?: boolean } };

function UndockedApp() {
  const { panelRef: commitRef, onMouseDown: onCommitResize, onKeyDown: onCommitResizeKeyDown } = useResize('right', 420, 280, 720);
  const showCommit = window.__INITIAL_CONFIG__?.showCommit !== false;

  return (
    <div style={styles.root}>
      {showCommit && (
        <>
          <div ref={commitRef} style={styles.commitPane}>
            <WebviewErrorBoundary title={t('Commit panel render failed')}>
              <CommitApp />
            </WebviewErrorBoundary>
          </div>
          <ResizeHandle onMouseDown={onCommitResize} onKeyDown={onCommitResizeKeyDown} />
        </>
      )}
      <div style={styles.logPane}>
        <WebviewErrorBoundary title={t('Git Log render failed')}>
          <GitLogApp />
        </WebviewErrorBoundary>
      </div>
    </div>
  );
}

const styles = {
  root: {
    display: 'flex',
    flexDirection: 'row' as const,
    height: '100vh',
    overflow: 'hidden',
    background: 'var(--vscode-editor-background)',
    color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: 'var(--vscode-font-size)',
  },
  commitPane: {
    width: '420px',
    flexShrink: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
    borderRight: '1px solid var(--vscode-panel-border)',
  },
  logPane: {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column' as const,
  },
};

createRoot(document.getElementById('root')!).render(<UndockedApp />);
