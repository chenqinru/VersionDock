import * as path from 'path';
import { t } from './l10n';

export interface ResolvedRepoPath {
  absolutePath: string;
  relativePath: string;
}

export interface ResolveRepoPathOptions {
  allowAbsolute?: boolean;
  allowRoot?: boolean;
}

export function isSameOrChildPath(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

/**
 * Resolve a path against a repository root and reject paths that escape it.
 * Webview-originated paths should keep allowAbsolute disabled.
 */
export function resolveRepoPath(
  rootPath: string,
  filePath: string,
  options: ResolveRepoPathOptions = {},
): ResolvedRepoPath {
  if (typeof filePath !== 'string' || filePath.includes('\0')) {
    throw new Error(t('Path is outside the repository: {0}', String(filePath)));
  }
  if (!options.allowAbsolute && path.isAbsolute(filePath)) {
    throw new Error(t('Path is outside the repository: {0}', filePath));
  }

  const normalizedRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(normalizedRoot, filePath);
  if (!isSameOrChildPath(normalizedRoot, absolutePath)) {
    throw new Error(t('Path is outside the repository: {0}', filePath));
  }

  const relative = path.relative(normalizedRoot, absolutePath);
  if (!options.allowRoot && relative === '') {
    throw new Error(t('Path is outside the repository: {0}', filePath));
  }

  return {
    absolutePath,
    relativePath: relative.split(path.sep).join('/'),
  };
}
