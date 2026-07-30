function normalizeHistoryPath(filePath: string): string {
  return filePath
    .replace(/\\/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/\/+$/, '');
}

/**
 * `git log -L` can follow a file into a subtree split commit where the commit
 * stores the path without the current working-tree prefix.
 */
export function isSameHistoryFilePath(historyPath: string, commitPath: string): boolean {
  const normalizedHistoryPath = normalizeHistoryPath(historyPath);
  const normalizedCommitPath = normalizeHistoryPath(commitPath);
  if (!normalizedHistoryPath || !normalizedCommitPath) return false;
  return normalizedHistoryPath === normalizedCommitPath
    || normalizedHistoryPath.endsWith(`/${normalizedCommitPath}`)
    || normalizedCommitPath.endsWith(`/${normalizedHistoryPath}`);
}

export function filterFilesForHistoryPath<T extends { path: string }>(files: T[], historyPath: string): T[] {
  const normalizedHistoryPath = normalizeHistoryPath(historyPath);
  const exactMatches = files.filter(file => normalizeHistoryPath(file.path) === normalizedHistoryPath);
  if (exactMatches.length > 0) return exactMatches;

  const mappedMatches = files.filter(file => isSameHistoryFilePath(normalizedHistoryPath, file.path));
  if (mappedMatches.length <= 1) return mappedMatches;

  // Prefer the most specific suffix when both `file.yml` and `config/file.yml`
  // appear in the same commit.
  const maxPathLength = Math.max(...mappedMatches.map(file => normalizeHistoryPath(file.path).length));
  return mappedMatches.filter(file => normalizeHistoryPath(file.path).length === maxPathLength);
}
