import React from 'react';

interface Props {
  name: string;
  style?: React.CSSProperties;
  title?: string;
  className?: string;
}

export function Codicon({ name, style, title, className }: Props) {
  const [iconName, ...modifiers] = name.split('~').filter(Boolean);
  const modifierClasses = modifiers.map(modifier => `codicon-modifier-${modifier}`).join(' ');
  const classes = [
    'codicon',
    `codicon-${iconName}`,
    modifierClasses,
    className,
  ].filter(Boolean).join(' ');

  return (
    <i
      className={classes}
      style={style}
      title={title}
      aria-hidden="true"
    />
  );
}

/** Returns the Monaco theme matching the current VS Code color theme. */
export function getVsCodeMonacoTheme(): string {
  const body = document.body;
  if (body.classList.contains('vscode-high-contrast-light')) return 'hc-light';
  if (body.classList.contains('vscode-high-contrast')) return 'hc-black';
  if (body.classList.contains('vscode-dark')) return 'vs-dark';
  return 'vs';
}
