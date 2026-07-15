import type { RepoMeta } from '../types/git';
import { t } from './l10n';

type RepoKind = RepoMeta['kind'];

export function getRepoKindLabel(kind?: RepoKind): string {
  return kind === 'svn' ? 'SVN' : 'Git';
}

export function getRepoKindDetail(kind?: RepoKind): string {
  return kind === 'svn' ? t('SVN working copy') : t('Git repository');
}

export function formatRepoLabel(meta: Pick<RepoMeta, 'name' | 'kind'>, icon?: string): string {
  const prefix = icon ? `${icon} ` : '';
  return `${prefix}${meta.name} [${getRepoKindLabel(meta.kind)}]`;
}

export function formatRepoName(meta: Pick<RepoMeta, 'name' | 'kind'>): string {
  return `${meta.name} (${getRepoKindLabel(meta.kind)})`;
}
