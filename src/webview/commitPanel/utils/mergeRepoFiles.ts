import type { FileStatus, RepoStatus } from '../../shared/types';

interface Options {
  includeUntracked?: boolean;
}

export function mergeRepoFiles(
  repoStatus: Pick<RepoStatus, 'stagedFiles' | 'unstagedFiles'>,
  options: Options = {},
): FileStatus[] {
  const { includeUntracked = true } = options;
  const filesByPath = new Map<string, FileStatus>();

  for (const file of [...repoStatus.stagedFiles, ...repoStatus.unstagedFiles]) {
    if (!file.path) continue;
    if (!includeUntracked && file.status === 'untracked') continue;

    const existing = filesByPath.get(file.path);
    filesByPath.set(
      file.path,
      existing
        ? {
            ...existing,
            absolutePath: existing.absolutePath || file.absolutePath,
            oldPath: existing.oldPath ?? file.oldPath,
            staged: existing.staged || file.staged,
            unstaged: existing.unstaged || file.unstaged,
          }
        : file,
    );
  }

  return Array.from(filesByPath.values()).sort((left, right) => left.path.localeCompare(right.path));
}
