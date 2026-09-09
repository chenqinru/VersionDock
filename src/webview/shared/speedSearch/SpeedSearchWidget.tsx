import React, { useEffect, useRef, useState } from 'react';
import { Codicon } from '../Codicon';
import { t } from '../i18n';

import type { UseSpeedSearchResult } from './useSpeedSearch';

export interface SpeedSearchWidgetProps<T = unknown> {
  speedSearch?: UseSpeedSearchResult<T>;
  isOpen?: boolean;
  query?: string;
  onQueryChange?: (query: string) => void;
  matchCount?: number;
  currentMatchIndex?: number;
  onNext?: () => void;
  onPrev?: () => void;
  onClose?: () => void;
  inputRef?: React.RefObject<HTMLInputElement>;
  style?: React.CSSProperties;
  placeholder?: string;
  extraActions?: React.ReactNode;
}

const widgetStyle: React.CSSProperties = {
  position: 'absolute',
  top: '6px',
  right: '18px', // 避开最右侧垂直滚动条，避免骑跨或穿越滚动条
  zIndex: 100,
  display: 'flex',
  alignItems: 'center',
  background: 'var(--vscode-editorWidget-background, #252526)',
  color: 'var(--vscode-editorWidget-foreground, var(--vscode-foreground))',
  border: '1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border, #454545))',
  borderRadius: '4px',
  boxShadow: '0 4px 10px rgba(0, 0, 0, 0.35)',
  padding: '3px 6px',
  gap: '3px',
  fontSize: '12px',
  maxWidth: 'calc(100% - 32px)', // 左右安全边距，自适应窄面板
  boxSizing: 'border-box',
  animation: 'speedSearchFadeIn 120ms ease-out',
};

const inputContainerStyle: React.CSSProperties = {
  position: 'relative',
  display: 'flex',
  alignItems: 'center',
  background: 'var(--vscode-input-background, #3c3c3c)',
  border: '1px solid var(--vscode-input-border, transparent)',
  borderRadius: '3px',
  padding: '1px 5px',
  height: '24px',
  boxSizing: 'border-box',
  flex: '1 1 auto',
  minWidth: '60px',
  maxWidth: '220px',
  overflow: 'hidden',
};

const inputStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--vscode-input-foreground, #cccccc)',
  fontSize: '12px',
  flex: '1 1 auto',
  width: '100%',
  minWidth: '30px',
  padding: '0 2px',
};

const countStyle: React.CSSProperties = {
  fontSize: '11px',
  color: 'var(--vscode-descriptionForeground, #999999)',
  whiteSpace: 'nowrap',
  padding: '0 4px',
  flexShrink: 0,
  textAlign: 'center',
  userSelect: 'none',
};

const noMatchCountStyle: React.CSSProperties = {
  ...countStyle,
  color: 'var(--vscode-errorForeground, #f48771)',
};

function SpeedSearchIconButton({
  title,
  disabled,
  onClick,
  children,
}: {
  title: string;
  disabled?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  const [hovered, setHovered] = useState(false);
  const [active, setActive] = useState(false);

  return (
    <button
      type="button"
      style={{
        background: disabled
          ? 'transparent'
          : active
            ? 'var(--vscode-toolbar-activeBackground, rgba(90, 93, 94, 0.45))'
            : hovered
              ? 'var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31))'
              : 'transparent',
        border: 'none',
        color: disabled
          ? 'var(--vscode-disabledForeground, rgba(204, 204, 204, 0.35))'
          : 'var(--vscode-foreground, #cccccc)',
        cursor: disabled ? 'default' : 'pointer',
        padding: '2px 4px',
        borderRadius: '3px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        opacity: disabled ? 0.35 : 1,
        transition: 'background-color 0.1s ease',
        flexShrink: 0,
        boxSizing: 'border-box',
        height: '22px',
        minWidth: '22px',
      }}
      title={title}
      disabled={disabled}
      onMouseEnter={() => !disabled && setHovered(true)}
      onMouseLeave={() => { setHovered(false); setActive(false); }}
      onMouseDown={() => !disabled && setActive(true)}
      onMouseUp={() => setActive(false)}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function SpeedSearchWidget<T = unknown>(props: SpeedSearchWidgetProps<T>) {
  const {
    speedSearch,
    style,
    placeholder,
    extraActions,
  } = props;

  const isOpen = speedSearch ? speedSearch.isOpen : (props.isOpen ?? true);
  const query = speedSearch ? speedSearch.query : (props.query ?? '');
  const onQueryChange = speedSearch ? speedSearch.setQuery : (props.onQueryChange ?? (() => {}));
  const matchCount = speedSearch ? speedSearch.matches.length : (props.matchCount ?? 0);
  const currentMatchIndex = speedSearch ? speedSearch.activeIndex : (props.currentMatchIndex ?? 0);
  const onNext = speedSearch ? speedSearch.nextMatch : (props.onNext ?? (() => {}));
  const onPrev = speedSearch ? speedSearch.prevMatch : (props.onPrev ?? (() => {}));
  const onClose = speedSearch ? speedSearch.closeSearch : (props.onClose ?? (() => {}));

  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = props.inputRef || speedSearch?.inputRef || internalInputRef;

  useEffect(() => {
    if (!isOpen) return;
    // 唤起打开时自动聚焦并将光标定位到末尾，避免全选导致键入下一个字符时覆盖已有字符
    const el = inputRef.current;
    if (el) {
      el.focus();
      const len = el.value.length;
      el.setSelectionRange(len, len);
    }
  }, [inputRef, isOpen]);

  if (!isOpen) {
    return null;
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      onNext();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      onPrev();
    }
  };

  const hasQuery = Boolean(query.trim());
  const countText = !hasQuery
    ? ''
    : matchCount === 0
      ? t('No matches')
      : `${currentMatchIndex + 1} / ${matchCount}`;

  return (
    <div
      style={{ ...widgetStyle, ...style }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div style={inputContainerStyle}>
        <Codicon
          name="search"
          style={{
            fontSize: '12px',
            color: 'var(--vscode-input-placeholderForeground, #888888)',
            marginRight: '2px',
          }}
        />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || t('Search files...')}
          style={inputStyle}
          spellCheck={false}
          autoComplete="off"
        />
        {hasQuery && (
          <span style={matchCount === 0 ? noMatchCountStyle : countStyle}>
            {countText}
          </span>
        )}
      </div>

      <SpeedSearchIconButton
        title={t('Previous match (Shift+Enter / Up)')}
        disabled={matchCount === 0}
        onClick={(e) => {
          e.preventDefault();
          onPrev();
        }}
      >
        <Codicon name="arrow-up" style={{ fontSize: '13px' }} />
      </SpeedSearchIconButton>

      <SpeedSearchIconButton
        title={t('Next match (Enter / Down)')}
        disabled={matchCount === 0}
        onClick={(e) => {
          e.preventDefault();
          onNext();
        }}
      >
        <Codicon name="arrow-down" style={{ fontSize: '13px' }} />
      </SpeedSearchIconButton>

      {extraActions}

      <SpeedSearchIconButton
        title={t('Close (Escape)')}
        onClick={(e) => {
          e.preventDefault();
          onClose();
        }}
      >
        <Codicon name="close" style={{ fontSize: '13px' }} />
      </SpeedSearchIconButton>
    </div>
  );
}
