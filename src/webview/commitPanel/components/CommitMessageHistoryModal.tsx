import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Codicon } from '../../shared/Codicon';
import { t } from '../../shared/i18n';

interface Props {
  messages: string[];
  loading: boolean;
  onSelect: (message: string) => void;
  onClose: () => void;
}

export function CommitMessageHistoryModal({ messages, loading, onSelect, onClose }: Props) {
  useEffect(() => {
    const keyHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    const blurHandler = () => onClose();
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') onClose();
    };
    document.addEventListener('keydown', keyHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    return () => {
      document.removeEventListener('keydown', keyHandler);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
    };
  }, [onClose]);

  return createPortal(
    <div style={styles.backdrop} onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('Commit message history')}
        style={styles.modal}
        onClick={event => event.stopPropagation()}
      >
        <div style={styles.header}>
          <Codicon name="history" style={{ fontSize: '15px', opacity: 0.8 }} />
          <span style={styles.title}>{t('Commit message history')}</span>
          <button data-action-btn="" style={styles.closeButton} onClick={onClose} title={t('Cancel')}>
            <Codicon name="close" />
          </button>
        </div>

        <div style={styles.subtitle}>{t('Select a previous commit message to use.')}</div>

        <div style={styles.list}>
          {loading && messages.length === 0 ? (
            <div style={styles.emptyState}>
              <Codicon name="loading~spin" style={{ fontSize: '16px' }} />
              <span>{t('Loading…')}</span>
            </div>
          ) : messages.length === 0 ? (
            <div style={styles.emptyState}>
              <Codicon name="history" style={{ fontSize: '18px', opacity: 0.6 }} />
              <span>{t('No commit message history')}</span>
            </div>
          ) : (
            messages.map((message, index) => {
              const [subject, ...bodyLines] = message.split('\n');
              const body = bodyLines.join('\n').trim();
              return (
                <button
                  key={`${message}\0${index}`}
                  type="button"
                  data-action-btn=""
                  style={styles.messageButton}
                  title={message}
                  onClick={() => onSelect(message)}
                >
                  <span style={styles.subject}>{subject}</span>
                  {body && <span style={styles.body}>{body}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

const styles = {
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 9000,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.55)',
  },
  modal: {
    width: '440px',
    maxWidth: '90vw',
    maxHeight: '70vh',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden',
    background: 'var(--vscode-editor-background)',
    border: '1px solid var(--vscode-panel-border)',
    borderRadius: '6px',
    boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
    color: 'var(--vscode-foreground)',
    fontFamily: 'var(--vscode-font-family)',
    fontSize: '12px',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    padding: '10px 12px 8px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    flexShrink: 0,
  },
  title: {
    flex: 1,
    fontSize: '13px',
    fontWeight: 600,
  },
  closeButton: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '2px 4px',
    border: 'none',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    opacity: 0.65,
  } as React.CSSProperties,
  subtitle: {
    padding: '7px 12px',
    borderBottom: '1px solid var(--vscode-panel-border)',
    opacity: 0.6,
    fontSize: '11px',
    flexShrink: 0,
  },
  list: {
    flex: 1,
    minHeight: '96px',
    overflowY: 'auto' as const,
    padding: '4px 0',
  },
  emptyState: {
    minHeight: '96px',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    opacity: 0.55,
  },
  messageButton: {
    width: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'stretch',
    gap: '3px',
    padding: '7px 12px',
    border: 'none',
    borderBottom: '1px solid color-mix(in srgb, var(--vscode-panel-border) 60%, transparent)',
    background: 'transparent',
    color: 'var(--vscode-foreground)',
    cursor: 'pointer',
    textAlign: 'left' as const,
    fontFamily: 'var(--vscode-font-family)',
  },
  subject: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontSize: '12px',
    fontWeight: 600,
    lineHeight: 1.4,
  },
  body: {
    display: '-webkit-box',
    overflow: 'hidden',
    WebkitBoxOrient: 'vertical' as const,
    WebkitLineClamp: 2,
    whiteSpace: 'pre-wrap' as const,
    opacity: 0.65,
    fontSize: '11px',
    lineHeight: 1.4,
  },
};
