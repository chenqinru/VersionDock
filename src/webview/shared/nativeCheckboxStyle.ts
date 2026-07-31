import type { CSSProperties } from 'react';

const CHECKBOX_BORDER = 'var(--vscode-checkbox-border, var(--vscode-focusBorder, #007fd4))';

/** Keep the native checkbox rendering while making its state border visible. */
export function nativeCheckboxBorderStyle(): CSSProperties {
  return {
    borderRadius: '3px',
    boxShadow: `inset 0 0 0 0px ${CHECKBOX_BORDER}`,
  };
}
