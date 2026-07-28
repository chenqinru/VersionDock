import React from 'react';
import { t } from './i18n';

interface Props {
  onMouseDown: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}

export function ResizeHandle({ onMouseDown, onKeyDown }: Props) {
  return (
    <div
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      role="separator"
      aria-label={t('Resize panel')}
      aria-orientation="vertical"
      tabIndex={0}
      style={{
        width: '4px',
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'transparent',
        position: 'relative',
        zIndex: 10,
        transition: 'background 0.15s',
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-focusBorder)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    />
  );
}
