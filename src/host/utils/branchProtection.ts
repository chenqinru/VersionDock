import * as vscode from 'vscode';

/**
 * Converts a simple glob-like pattern (e.g. "release/*", "main", "feature/**") into a RegExp.
 */
export function globToRegExp(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return /^$/;
  }
  // Escape special regex characters except '*' and '?'
  const escaped = trimmed
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Gets the list of configured protected branch patterns.
 */
export function getProtectedBranchPatterns(): string[] {
  const config = vscode.workspace.getConfiguration('versiondock');
  const patterns = config.get<string[]>('git.protectedBranches', ['master', 'main']);
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return ['master', 'main'];
  }
  return patterns.map(p => String(p).trim()).filter(Boolean);
}

/**
 * Checks whether a branch name matches any protected branch pattern.
 */
export function isBranchProtected(branchName: string, customPatterns?: string[]): boolean {
  const name = branchName.trim();
  if (!name || name === 'HEAD') {
    return false;
  }

  // Strip remote prefix if present (e.g., "origin/main" -> "main")
  const normalized = name.replace(/^remotes\/[^/]+\//, '');

  const patterns = customPatterns ?? getProtectedBranchPatterns();
  for (const pattern of patterns) {
    if (!pattern) continue;
    // Exact match or glob match
    if (pattern.includes('*') || pattern.includes('?')) {
      if (globToRegExp(pattern).test(normalized) || globToRegExp(pattern).test(name)) {
        return true;
      }
    } else {
      if (
        normalized.toLowerCase() === pattern.toLowerCase() ||
        name.toLowerCase() === pattern.toLowerCase() ||
        name.toLowerCase().endsWith(`/${pattern.toLowerCase()}`)
      ) {
        return true;
      }
    }
  }

  return false;
}
