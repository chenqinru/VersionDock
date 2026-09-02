import * as vscode from 'vscode';
import { t } from './l10n';

/**
 * Gets the configured branch name clean character (defaults to '-').
 */
export function getBranchCleanCharacter(): string {
  const config = vscode.workspace.getConfiguration('versiondock');
  const char = config.get<string>('git.branchCleanCharacter', '-');
  return char && char.length > 0 ? char.charAt(0) : '-';
}

/**
 * Sanitizes an input string into a valid Git branch name according to git-check-ref-format rules:
 * - Replaces whitespace and invalid Git characters (~, ^, :, ?, *, [, \, @{, .., control chars) with replacementChar.
 * - Collapses consecutive replacement characters and slashes.
 * - Trims leading and trailing dots, slashes, and replacement characters.
 * - Removes trailing '.lock'.
 */
export function sanitizeBranchName(input: string, replacementChar = '-'): string {
  if (!input) return '';

  const rep = replacementChar || '-';
  // Escape replacement char for safe regex building
  const escapedRep = rep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  let sanitized = input
    // Replace ASCII control characters (0-31, 127)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, rep)
    // Replace whitespace (space, tab, newline, non-breaking space)
    .replace(/\s+/g, rep)
    // Replace git ref invalid characters: ~, ^, :, ?, *, [, \, @{
    .replace(/[~^:?*[\\\]]/g, rep)
    .replace(/@\{/g, rep)
    // Replace consecutive dots (..)
    .replace(/\.{2,}/g, rep)
    // Collapse consecutive replacement characters
    .replace(new RegExp(`${escapedRep}{2,}`, 'g'), rep)
    // Collapse consecutive slashes
    .replace(/\/{2,}/g, '/');

  // Strip trailing .lock
  sanitized = sanitized.replace(/\.lock$/i, '');

  // Strip leading and trailing invalid characters (dots, slashes, replacement char)
  const trimRegex = new RegExp(`^[./${escapedRep}]+|[./${escapedRep}]+$`, 'g');
  sanitized = sanitized.replace(trimRegex, '');

  return sanitized;
}

/**
 * Validation helper for vscode.window.showInputBox.
 * Shows informational warning with sanitized preview when input has invalid chars.
 */
export function validateBranchNameInput(
  input: string,
  replacementChar?: string,
): vscode.InputBoxValidationMessage | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return {
      message: t('Branch name cannot be empty'),
      severity: vscode.InputBoxValidationSeverity.Error,
    };
  }

  const cleanChar = replacementChar ?? getBranchCleanCharacter();
  const sanitized = sanitizeBranchName(trimmed, cleanChar);

  if (!sanitized) {
    return {
      message: t('Branch name must contain at least one valid character'),
      severity: vscode.InputBoxValidationSeverity.Error,
    };
  }

  if (sanitized !== trimmed) {
    return {
      message: t('Contains invalid characters. Will be formatted as: "{0}"', sanitized),
      severity: vscode.InputBoxValidationSeverity.Info,
    };
  }

  return undefined;
}
