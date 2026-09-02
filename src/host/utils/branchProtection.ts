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

const remoteProtectedBranchesMap = new Map<string, Set<string>>();

/**
 * Registers protected branch names fetched dynamically from remote repositories (e.g. GitHub).
 */
export function setRemoteProtectedBranches(repoId: string, branches: string[]): void {
  remoteProtectedBranchesMap.set(repoId, new Set(branches.map(b => b.trim()).filter(Boolean)));
}

/**
 * Gets the list of configured protected branch patterns, optionally merged with remote-synced branches.
 */
export function getProtectedBranchPatterns(repoId?: string): string[] {
  const config = vscode.workspace.getConfiguration('versiondock');
  const patterns = config.get<string[]>('git.protectedBranches', ['master', 'main']);
  const result = new Set<string>(
    Array.isArray(patterns) ? patterns.map(p => String(p).trim()).filter(Boolean) : ['master', 'main']
  );

  if (repoId && remoteProtectedBranchesMap.has(repoId)) {
    const remoteBranches = remoteProtectedBranchesMap.get(repoId)!;
    for (const b of remoteBranches) result.add(b);
  }

  return Array.from(result);
}

/**
 * Checks whether a branch name matches any protected branch pattern.
 */
export function isBranchProtected(branchName: string, customPatterns?: string[], repoId?: string): boolean {
  const name = branchName.trim();
  if (!name || name === 'HEAD') {
    return false;
  }

  // Strip remote prefix if present (e.g., "origin/main" -> "main")
  const normalized = name.replace(/^remotes\/[^/]+\//, '');

  const patterns = customPatterns ?? getProtectedBranchPatterns(repoId);
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
