import React from 'react';

interface Props {
  children: React.ReactNode;
  title: string;
  onError?: (error: Error, componentStack?: string) => void;
}

interface State {
  error: Error | null;
}

export class WebviewErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.onError?.(error, info.componentStack ?? undefined);
  }

  render(): React.ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={styles.container} role="alert">
        <div style={styles.title}>{this.props.title}</div>
        <pre style={styles.body}>{[this.state.error.message, this.state.error.stack].filter(Boolean).join('\n')}</pre>
      </div>
    );
  }
}

const styles = {
  container: {
    height: '100%',
    boxSizing: 'border-box',
    padding: '12px',
    overflow: 'auto',
    background: 'var(--vscode-editor-background)',
    color: 'var(--vscode-errorForeground, #f48771)',
    fontFamily: 'var(--vscode-font-family)',
    userSelect: 'text',
  } as React.CSSProperties,
  title: { fontSize: '13px', fontWeight: 600, marginBottom: '8px' } as React.CSSProperties,
  body: {
    margin: 0,
    whiteSpace: 'pre-wrap',
    fontSize: '11px',
    lineHeight: 1.45,
    fontFamily: 'var(--vscode-editor-font-family, monospace)',
  } as React.CSSProperties,
};
