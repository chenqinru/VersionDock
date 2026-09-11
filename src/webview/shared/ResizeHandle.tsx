import React from 'react';
import { t } from './i18n';

interface Props {
  onMouseDown: (e: React.MouseEvent) => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  style?: React.CSSProperties;
}

export function ResizeHandle({ onMouseDown, onKeyDown, style }: Props) {
  return (
    <div
      onMouseDown={onMouseDown}
      onKeyDown={onKeyDown}
      role="separator"
      aria-label={t('Resize panel')}
      aria-orientation="vertical"
      tabIndex={0}
      style={{
        width: '6px',
        flexShrink: 0,
        cursor: 'col-resize',
        background: 'transparent',
        position: 'relative',
        zIndex: 10,
        borderRadius: '3px',
        transition: 'background 0.15s',
        ...style,
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'var(--vscode-focusBorder)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.background = 'transparent'; }}
    />
  );
}
