import React, { useMemo } from 'react';
import { getMatchSegments } from './matchUtils';

interface HighlightedTextProps {
  text: string;
  query?: string;
  className?: string;
  style?: React.CSSProperties;
  highlightStyle?: React.CSSProperties;
  isActive?: boolean;
}

const DEFAULT_HIGHLIGHT_STYLE: React.CSSProperties = {
  background: '#ffd600',
  color: '#000000',
  fontWeight: 600,
  borderRadius: '2px',
  padding: '0 2px',
  fontStyle: 'normal',
};

const ACTIVE_HIGHLIGHT_STYLE: React.CSSProperties = {
  background: '#ff9100',
  color: '#000000',
  fontWeight: 700,
  borderRadius: '2px',
  padding: '0 2px',
  fontStyle: 'normal',
  boxShadow: '0 0 0 1.5px #ffd600',
};

export function HighlightedText({
  text,
  query,
  className,
  style,
  highlightStyle,
  isActive = false,
}: HighlightedTextProps) {
  const segments = useMemo(() => getMatchSegments(text, query), [text, query]);

  if (!query || (segments.length === 1 && !segments[0].isMatch)) {
    return <span className={className} style={style}>{text}</span>;
  }

  const activeStyle = isActive
    ? { ...ACTIVE_HIGHLIGHT_STYLE, ...highlightStyle }
    : { ...DEFAULT_HIGHLIGHT_STYLE, ...highlightStyle };

  return (
    <span className={className} style={style}>
      {segments.map((seg, idx) =>
        seg.isMatch ? (
          <mark key={idx} style={activeStyle}>
            {seg.text}
          </mark>
        ) : (
          <React.Fragment key={idx}>{seg.text}</React.Fragment>
        ),
      )}
    </span>
  );
}
