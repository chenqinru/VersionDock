import React from 'react';
import { Codicon } from './Codicon';

interface Props {
  size?: number;
  style?: React.CSSProperties;
  className?: string;
}

export function AiCommitComposerIcon({ size = 16, style, className }: Props) {
  return (
    <span
      className={className}
      style={{
        position: 'relative',
        display: 'inline-block',
        width: size,
        height: size,
        flexShrink: 0,
        pointerEvents: 'none',
        ...style,
      }}
      aria-hidden="true"
    >
      <Codicon
        name="layers"
        style={{ position: 'absolute', left: 0, bottom: 0, fontSize: size * 0.875 }}
      />
      <Codicon
        name="sparkle-filled"
        style={{ position: 'absolute', top: size * -0.125, right: size * -0.125, fontSize: size * 0.625 }}
      />
    </span>
  );
}
