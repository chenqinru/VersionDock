import type { RepoMeta } from '../types/git';
import { t } from './l10n';

type RepoKind = RepoMeta['kind'];

let isMixedRepoWorkspaceProvider: (() => boolean) | undefined;

export function setMixedRepoWorkspaceProvider(provider: (() => boolean) | undefined): void {
  isMixedRepoWorkspaceProvider = provider;
}

export function isMixedRepoWorkspace(): boolean {
  return isMixedRepoWorkspaceProvider ? isMixedRepoWorkspaceProvider() : false;
}

export function checkMixedRepoWorkspace(metas: Array<Pick<RepoMeta, 'kind'>>): boolean {
  const hasGit = metas.some(m => m.kind !== 'svn');
  const hasSvn = metas.some(m => m.kind === 'svn');
  return hasGit && hasSvn;
}

export function getRepoKindLabel(kind?: RepoKind): string {
  return kind === 'svn' ? 'SVN' : 'Git';
}

export function getRepoKindDetail(kind?: RepoKind): string {
  return kind === 'svn' ? t('SVN working copy') : t('Git repository');
}

export function formatRepoLabel(
  meta: Pick<RepoMeta, 'name' | 'kind'>,
  icon?: string,
  showKind?: boolean,
): string {
  const prefix = icon ? `${icon} ` : '';
  const displayKind = showKind ?? isMixedRepoWorkspace();
  return displayKind
    ? `${prefix}${meta.name} [${getRepoKindLabel(meta.kind)}]`
    : `${prefix}${meta.name}`;
}

export function formatRepoName(
  meta: Pick<RepoMeta, 'name' | 'kind'>,
  showKind?: boolean,
): string {
  const displayKind = showKind ?? isMixedRepoWorkspace();
  return displayKind
    ? `${meta.name} (${getRepoKindLabel(meta.kind)})`
    : meta.name;
}

