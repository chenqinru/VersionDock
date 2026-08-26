import React, { useState, useRef, useLayoutEffect, forwardRef } from 'react';
import type { BranchInfo, RepoMeta, TagInfo } from '../../shared/types';
import { isPrimaryBranch } from '../../shared/branchUtils';
import { Codicon } from '../../shared/Codicon';
import { t } from '../../shared/i18n';
import { baseNameFromPath } from '../../shared/pathUtils';
import { readableAccentColor } from '../../shared/branchColors';
import { branchRevisionRef } from '../utils/refs';

const PUSH_COLOR = 'var(--vscode-gitDecoration-addedResourceForeground)';
const PULL_COLOR = 'var(--vscode-charts-blue, #64b5f6)';

interface Props {
  repos: RepoMeta[];
  branches: BranchInfo[];
  tags: TagInfo[];
  loading: boolean;
  filter: string;
  selectedBranchFilter: string;
  selectedBranchRepoIds: readonly string[] | null;
  selectedRepoId: string | null;
  onFilterChange: (v: string) => void;
  onBranchFilterSelect: (branchName: string, repoIds: string[]) => void;
  onRepoFilterSelect: (repoId: string) => void;
  onCheckout: (repoIds: string[], branchName: string) => void;
  onMerge: (repoId: string, from: string) => void;
  onRebase: (repoId: string, onto: string) => void;
  onCompareWithCurrent: (branches: Array<{ repoId: string; branchName: string }>) => void;
  onShowWorktreeDiff: (branches: Array<{ repoId: string; branchName: string }>) => void;
  onDelete: (repoIds: string[], branchName: string) => void;
  onFetchRepo: (repoId: string) => void;
  onPull: (repoId: string, branchName?: string) => void;
  onPush: (repoId: string) => void;
  onCheckoutTag: (repoIds: string[], tagName: string) => void;
  onMergeTag: (repoIds: string[], tagName: string) => void;
  onPushTag: (repoId: string, tagName: string) => void;
  onDeleteTag: (repoIds: string[], tagName: string) => void;
  onCollapse: () => void;
}

type SectionKey = string; // 'local' | 'remote:<name>' | 'tags'

function stripRemotePrefix(name: string): string {
  return name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
}

function getBranchBaseName(branch: BranchInfo): string {
  if (!branch.isRemote) return branch.name;
  const prefix = branch.remoteName ? `${branch.remoteName}/` : '';
  return prefix && branch.name.startsWith(prefix)
    ? branch.name.slice(prefix.length)
    : stripRemotePrefix(branch.name);
}

interface MergedBranch {
  key: string;
  vcsKind: 'git' | 'svn';
  baseName: string;
  isPrimary: boolean;
  isHead: boolean;
  instances: BranchInfo[];
  repoIds: string[];
}

function buildMergedBranches(
  branches: BranchInfo[],
  repoKindMap: Record<string, 'git' | 'svn'>,
  sectionKey: string,
): MergedBranch[] {
  const map = new Map<string, MergedBranch>();
  for (const b of branches) {
    const baseName = getBranchBaseName(b);
    const vcsKind = repoKindMap[b.repoId] ?? 'git';
    const key = `${sectionKey}:${vcsKind}:${baseName}`;
    const existing = map.get(key);
    if (existing) {
      existing.instances.push(b);
      if (!existing.repoIds.includes(b.repoId)) existing.repoIds.push(b.repoId);
      if (b.isHead) existing.isHead = true;
    } else {
      map.set(key, {
        key,
        vcsKind,
        baseName,
        isPrimary: isPrimaryBranch(baseName),
        isHead: b.isHead,
        instances: [b],
        repoIds: [b.repoId],
      });
    }
  }
  return Array.from(map.values());
}

function sortMerged(list: MergedBranch[]): MergedBranch[] {
  return [...list].sort((a, b) => {
    if (a.isHead !== b.isHead) return a.isHead ? -1 : 1;
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.baseName.localeCompare(b.baseName);
  });
}

function sumAheadBehind(branches: readonly BranchInfo[]): { ahead: number; behind: number } | undefined {
  let ahead = 0;
  let behind = 0;
  let hasTrackingInfo = false;

  for (const branch of branches) {
    if (!branch.aheadBehind) continue;
    hasTrackingInfo = true;
    ahead += branch.aheadBehind.ahead;
    behind += branch.aheadBehind.behind;
  }

  return hasTrackingInfo ? { ahead, behind } : undefined;
}

interface MergedTag {
  key: string;
  vcsKind: 'git' | 'svn';
  name: string;
  repoIds: string[];
}

function buildMergedTags(tags: TagInfo[], repoKindMap: Record<string, 'git' | 'svn'>): MergedTag[] {
  const map = new Map<string, MergedTag>();
  for (const t of tags) {
    const vcsKind = repoKindMap[t.repoId] ?? 'git';
    const key = `${vcsKind}:${t.name}`;
    const existing = map.get(key);
    if (existing) {
      if (!existing.repoIds.includes(t.repoId)) existing.repoIds.push(t.repoId);
    } else {
      map.set(key, { key, vcsKind, name: t.name, repoIds: [t.repoId] });
    }
  }
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export const BranchSidebar = forwardRef<HTMLDivElement, Props>(function BranchSidebar({
  repos, branches, tags, loading, filter, selectedBranchFilter, onFilterChange, onBranchFilterSelect,
  selectedBranchRepoIds, selectedRepoId, onRepoFilterSelect,
  onCheckout, onMerge, onRebase, onCompareWithCurrent, onShowWorktreeDiff, onDelete, onFetchRepo: _onFetchRepo, onPull, onPush,
  onCheckoutTag, onMergeTag, onPushTag, onDeleteTag, onCollapse,
}, ref) {
  const [collapsed, setCollapsed] = useState<Set<SectionKey>>(new Set());
  const [activeItem, setActiveItem] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ merged: MergedBranch; x: number; y: number } | null>(null);
  const [tagContextMenu, setTagContextMenu] = useState<{ mergedTag: MergedTag; x: number; y: number } | null>(null);

  function toggle(key: SectionKey) {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  const repoColorMap = Object.fromEntries(repos.map(r => [r.id, readableAccentColor(r.color)]));
  const repoKindMap: Record<string, 'git' | 'svn'> = Object.fromEntries(
    repos.map(r => [r.id, r.kind ?? 'git']),
  );

  const filtered = filter
    ? branches.filter(b => b.name.toLowerCase().includes(filter.toLowerCase()))
    : branches;

  // Exclude detached HEAD pseudo-branch from Local list — it shows up as a tag row instead
  const localMerged = sortMerged(buildMergedBranches(
    filtered.filter(b => !b.isRemote && b.name !== 'HEAD'),
    repoKindMap,
    'local',
  ));

  // Group remote branches by remote name (e.g. "origin", "upstream"), sorted alphabetically
  const remoteBranches = filtered.filter(b => b.isRemote && getBranchBaseName(b) !== 'HEAD');
  const remoteGroupsMap = new Map<string, BranchInfo[]>();
  for (const b of remoteBranches) {
    const rName = b.remoteName ?? b.name.split('/')[0] ?? 'remote';
    if (!remoteGroupsMap.has(rName)) remoteGroupsMap.set(rName, []);
    remoteGroupsMap.get(rName)!.push(b);
  }
  const remoteGroups: { name: string; merged: MergedBranch[] }[] = Array.from(remoteGroupsMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bs]) => ({
      name,
      merged: sortMerged(buildMergedBranches(bs, repoKindMap, `remote:${name}`)),
    }));

  // Active detached tag name(s) — shown as "current" in the Tags section
  const activeDetachedTags = new Set(
    branches
      .filter(b => b.detachedTag)
      .map(b => `${repoKindMap[b.repoId] ?? 'git'}:${b.detachedTag!}`),
  );

  const mergedTags = buildMergedTags(
    filter ? tags.filter(t => t.name.toLowerCase().includes(filter.toLowerCase())) : tags,
    repoKindMap,
  );

  const multiRepo = repos.length > 1;
  const showVcsBadges = repos.some(repo => repo.kind === 'svn')
    && repos.some(repo => repo.kind !== 'svn');

  function primaryInstance(merged: MergedBranch): BranchInfo {
    return merged.instances.find(i => i.isHead) ?? merged.instances[0];
  }

  function revisionRef(merged: MergedBranch): string {
    return branchRevisionRef(primaryInstance(merged), merged.vcsKind);
  }

  function isSelectedBranchScope(merged: MergedBranch, branchName: string): boolean {
    if (selectedBranchFilter !== branchName) return false;
    if (!selectedBranchRepoIds) return true;
    if (selectedBranchRepoIds.length !== merged.repoIds.length) return false;
    const selected = new Set(selectedBranchRepoIds);
    return merged.repoIds.every(repoId => selected.has(repoId));
  }

  return (
    <div ref={ref} style={styles.container} onClick={() => { setContextMenu(null); setTagContextMenu(null); }}>
      <style>{INTERACTION_STYLE}</style>
      {/* Sticky header: search + repo list */}
      <div style={styles.stickyHeader}>
        <div style={styles.searchBox}>
          <div style={styles.searchInputWrap}>
            <Codicon name="filter" style={styles.searchIcon} />
            <input
              style={styles.searchInput}
              value={filter}
              onChange={e => onFilterChange(e.target.value)}
              placeholder={t('Filter branches & tags...')}
            />
          </div>
          <button style={styles.collapseBtn} onClick={onCollapse} title={t('Collapse sidebar')}>
            <div data-top-action-btn="" style={styles.collapseBtnInner}>
              <Codicon name="layout-sidebar-left" style={{ fontSize: '14px' }} />
            </div>
          </button>
        </div>
        {loading && (
          <div role="status" aria-live="polite" style={styles.loadingRow}>
            <Codicon name="loading~spin" style={styles.loadingIcon} />
            <span>{t('Loading branches…')}</span>
          </div>
        )}

        {repos.length > 1 && (
          <div style={styles.repoList}>
            {repos.map(repo => {
              const activeKey = `repo:${repo.id}`;
              const isClickSelected = activeItem === activeKey;
              const isFilterSelected = selectedRepoId === repo.id;
              const headBranch = repo.isWorktree
                ? branches.find(b => b.repoId === repo.id && b.isHead)
                : undefined;
              const wtBranch = headBranch
                ? (headBranch.detachedTag ?? headBranch.detachedHash ?? headBranch.name)
                : undefined;
              const displayName = wtBranch
                ? `${baseNameFromPath(repo.mainWorktreePath) ?? repo.name} (${wtBranch})`
                : repo.name;
              return (
                <div
                  key={repo.id}
                  style={styles.repoRow(isClickSelected, isFilterSelected)}
                  className="versiondock-sidebar-row"
                  data-selected={isClickSelected}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isClickSelected}
                  title={t('Double-click to filter commits by repository: {0}', displayName)}
                  onClick={() => setActiveItem(activeKey)}
                  onDoubleClick={() => onRepoFilterSelect(repo.id)}
                  onKeyDown={e => {
                    if (e.key !== 'Enter' && e.key !== ' ') return;
                    e.preventDefault();
                    onRepoFilterSelect(repo.id);
                  }}
                >
                  <span style={styles.repoDot(readableAccentColor(repo.color))} />
                  <span style={styles.repoName}>{displayName}</span>
                  {repo.isSubmodule && (
                    <span style={styles.submoduleBadge} title={repo.submodulePath ? t('Submodule: {0}', repo.submodulePath) : t('Submodule')}>
                      SUB
                    </span>
                  )}
                  {showVcsBadges && (
                    <span
                      style={styles.vcsBadge(repo.kind === 'svn' ? 'svn' : 'git')}
                      title={repo.kind === 'svn' ? t('SVN working copy') : 'Git'}
                    >
                      {repo.kind === 'svn' ? 'SVN' : 'GIT'}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* LOCAL section */}
      <div style={styles.sectionHeader} onClick={() => toggle('local')}>
        <span style={styles.chevron}>{collapsed.has('local') ? '▶' : '▼'}</span>
        <Codicon name="git-branch" style={styles.sectionIcon} />
        <span style={styles.sectionLabel}>{t('Local')}</span>
        <span style={styles.count}>{localMerged.length}</span>
      </div>
      {!collapsed.has('local') && localMerged.map(m => (
        <BranchRow
          key={m.key}
          merged={m}
          repoColorMap={repoColorMap}
          multiRepo={multiRepo}
          isSvn={m.vcsKind === 'svn'}
          showVcsBadge={showVcsBadges}
          isClickSelected={activeItem === `branch:local:${m.key}`}
          isFilterSelected={isSelectedBranchScope(m, revisionRef(m))}
          isCtxActive={contextMenu?.merged.key === m.key}
          onClick={() => setActiveItem(`branch:local:${m.key}`)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setContextMenu({ merged: m, x: e.clientX, y: e.clientY });
          }}
          onDoubleClick={() => onBranchFilterSelect(revisionRef(m), m.repoIds)}
        />
      ))}

      {/* REMOTE sections — one per remote name (origin, upstream, …) */}
      {remoteGroups.map(({ name, merged }) => {
        const sectionKey = `remote:${name}`;
        return (
          <React.Fragment key={sectionKey}>
            <div style={styles.sectionHeader} onClick={() => toggle(sectionKey)}>
              <span style={styles.chevron}>{collapsed.has(sectionKey) ? '▶' : '▼'}</span>
              <Codicon name="cloud" style={styles.sectionIcon} />
              <span style={styles.sectionLabel}>{name.charAt(0).toUpperCase() + name.slice(1)}</span>
              <span style={styles.count}>{merged.length}</span>
            </div>
            {!collapsed.has(sectionKey) && merged.map(m => {
              const fullName = revisionRef(m);
              return (
                <BranchRow
                  key={m.key}
                  merged={m}
                  repoColorMap={repoColorMap}
                  multiRepo={multiRepo}
                  isSvn={m.vcsKind === 'svn'}
                  showVcsBadge={showVcsBadges}
                  isClickSelected={activeItem === `branch:${sectionKey}:${m.key}`}
                  isFilterSelected={isSelectedBranchScope(m, fullName)}
                  isCtxActive={contextMenu?.merged.key === m.key}
                  onClick={() => setActiveItem(`branch:${sectionKey}:${m.key}`)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setContextMenu({ merged: m, x: e.clientX, y: e.clientY });
                  }}
                  onDoubleClick={() => onBranchFilterSelect(fullName, m.repoIds)}
                />
              );
            })}
          </React.Fragment>
        );
      })}

      {/* TAGS section */}
      {mergedTags.length > 0 && (
        <>
          <div style={styles.sectionHeader} onClick={() => toggle('tags')}>
            <span style={styles.chevron}>{collapsed.has('tags') ? '▶' : '▼'}</span>
            <Codicon name="tag" style={styles.sectionIcon} />
            <span style={styles.sectionLabel}>{t('Tags')}</span>
            <span style={styles.count}>{mergedTags.length}</span>
          </div>
          {!collapsed.has('tags') && mergedTags.map(mt => (
            <TagRow
              key={mt.key}
              mergedTag={mt}
              repoColorMap={repoColorMap}
              multiRepo={multiRepo}
              isSvn={mt.vcsKind === 'svn'}
              showVcsBadge={showVcsBadges}
              isActive={activeDetachedTags.has(mt.key)}
              isClickSelected={activeItem === `tag:${mt.key}`}
              isCtxActive={tagContextMenu?.mergedTag.key === mt.key}
              onClick={() => setActiveItem(`tag:${mt.key}`)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTagContextMenu({ mergedTag: mt, x: e.clientX, y: e.clientY });
              }}
            />
          ))}
        </>
      )}

      {/* Branch context menu */}
      {contextMenu && (() => {
        const inst = primaryInstance(contextMenu.merged);
        const isSvn = contextMenu.merged.vcsKind === 'svn';
        return (
          <ContextMenu
            merged={contextMenu.merged}
            x={contextMenu.x}
            y={contextMenu.y}
            isSvn={isSvn}
            isRemote={inst.isRemote}
            canDelete={!contextMenu.merged.isHead && !inst.isRemote}
            canCompare={!contextMenu.merged.isHead}
            onClose={() => setContextMenu(null)}
            onCheckout={() => { onCheckout(contextMenu.merged.repoIds, inst.name); setContextMenu(null); }}
            onCompareWithCurrent={() => {
              onCompareWithCurrent(contextMenu.merged.instances.map(item => ({
                repoId: item.repoId,
                branchName: branchRevisionRef(item, contextMenu.merged.vcsKind),
              })));
              setContextMenu(null);
            }}
            onShowWorktreeDiff={() => {
              onShowWorktreeDiff(contextMenu.merged.instances.map(item => ({
                repoId: item.repoId,
                branchName: branchRevisionRef(item, contextMenu.merged.vcsKind),
              })));
              setContextMenu(null);
            }}
            onMerge={() => { onMerge(inst.repoId, branchRevisionRef(inst, contextMenu.merged.vcsKind)); setContextMenu(null); }}
            onRebase={() => { onRebase(inst.repoId, branchRevisionRef(inst, contextMenu.merged.vcsKind)); setContextMenu(null); }}
            onDelete={() => { onDelete(contextMenu.merged.repoIds, inst.name); setContextMenu(null); }}
            onPull={() => { onPull(inst.repoId, inst.isRemote ? undefined : inst.name); setContextMenu(null); }}
            onPush={() => { onPush(inst.repoId); setContextMenu(null); }}
          />
        );
      })()}

      {/* Tag context menu */}
      {tagContextMenu && (
        <TagContextMenu
          mergedTag={tagContextMenu.mergedTag}
          x={tagContextMenu.x}
          y={tagContextMenu.y}
          isSvn={tagContextMenu.mergedTag.vcsKind === 'svn'}
          canDelete={!activeDetachedTags.has(tagContextMenu.mergedTag.key)}
          onClose={() => setTagContextMenu(null)}
          onCheckout={() => { onCheckoutTag(tagContextMenu.mergedTag.repoIds, tagContextMenu.mergedTag.name); setTagContextMenu(null); }}
          onMerge={() => { onMergeTag(tagContextMenu.mergedTag.repoIds, tagContextMenu.mergedTag.name); setTagContextMenu(null); }}
          onPush={() => { onPushTag(tagContextMenu.mergedTag.repoIds[0], tagContextMenu.mergedTag.name); setTagContextMenu(null); }}
          onDelete={() => { onDeleteTag(tagContextMenu.mergedTag.repoIds, tagContextMenu.mergedTag.name); setTagContextMenu(null); }}
        />
      )}
    </div>
  );
});

function BranchRow({ merged, repoColorMap, multiRepo, isSvn, showVcsBadge, isClickSelected, isFilterSelected, isCtxActive, onClick, onContextMenu, onDoubleClick }: {
  merged: MergedBranch;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  isSvn: boolean;
  showVcsBadge: boolean;
  isClickSelected: boolean;
  isFilterSelected: boolean;
  isCtxActive: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDoubleClick: () => void;
}) {
  const { baseName, isPrimary, isHead, repoIds } = merged;
  const isRemote = merged.instances[0].isRemote;
  const headRepoCount = merged.instances.filter(instance => instance.isHead).length;
  const aheadBehind = sumAheadBehind(merged.instances);
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={styles.branchRow(isFilterSelected, isClickSelected, hovered, isCtxActive, isHead)}
      className="versiondock-sidebar-row"
      data-selected={isClickSelected}
      role="button"
      tabIndex={0}
      aria-pressed={isClickSelected}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onKeyDown={e => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        onDoubleClick();
      }}
      title={`${baseName}\n${isSvn ? t('Double-click to filter by this branch · Right-click for SVN actions') : t('Double-click to filter by this branch · Right-click for Git actions')}`}
    >
      <Codicon
        name={isPrimary ? 'star-full' : isRemote ? 'cloud' : 'git-branch'}
        style={styles.branchIcon(isPrimary, isHead)}
        title={isHead
          ? (multiRepo
            ? t('Current HEAD in {0} of {1} repositories', headRepoCount, repoIds.length)
            : t('Current HEAD'))
          : isPrimary ? t('Primary branch') : undefined}
      />

      <span style={styles.branchName(isHead, isPrimary)}>{baseName}</span>

      {showVcsBadge && (
        <span style={styles.vcsBadge(isSvn ? 'svn' : 'git')}>
          {isSvn ? 'SVN' : 'GIT'}
        </span>
      )}

      {isHead && (
        <span
          style={styles.headBadge}
          title={multiRepo
            ? t('Current HEAD in {0} of {1} repositories', headRepoCount, repoIds.length)
            : t('current branch')}
        >
          {multiRepo && headRepoCount > 0 && headRepoCount < repoIds.length
            ? `HEAD ${headRepoCount}/${repoIds.length}`
            : 'HEAD'}
        </span>
      )}

      {multiRepo && (
        <span style={styles.dotGroup}>
          {repoIds.map(id => (
            <span key={id} style={styles.repoDot(repoColorMap[id] ?? '#888')} />
          ))}
        </span>
      )}

      {aheadBehind && (aheadBehind.ahead > 0 || aheadBehind.behind > 0) && (
        <span style={styles.aheadBehind}>
          {aheadBehind.ahead > 0 && <span style={styles.pushIndicator}>↑{aheadBehind.ahead}</span>}
          {aheadBehind.behind > 0 && <span style={styles.pullIndicator}>↓{aheadBehind.behind}</span>}
        </span>
      )}
    </div>
  );
}

function TagRow({ mergedTag, repoColorMap, multiRepo, isSvn, showVcsBadge, isActive, isClickSelected, isCtxActive, onClick, onContextMenu }: {
  mergedTag: MergedTag;
  repoColorMap: Record<string, string>;
  multiRepo: boolean;
  isSvn: boolean;
  showVcsBadge: boolean;
  isActive: boolean;
  isClickSelected: boolean;
  isCtxActive: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={styles.branchRow(false, isClickSelected, hovered, isCtxActive)}
      className="versiondock-sidebar-row"
      data-selected={isClickSelected}
      role="button"
      tabIndex={0}
      aria-pressed={isClickSelected}
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onContextMenu={onContextMenu}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onClick();
      }}
      title={`${t('Tag: {0}', mergedTag.name)}${isActive ? ` (${t('current')})` : ''}\n${t('Right-click for actions')}`}
    >
      <Codicon
        name="tag"
        style={{
          ...styles.branchIcon(false, isActive),
          color: isActive
            ? 'var(--vscode-gitDecoration-addedResourceForeground)'
            : 'var(--vscode-gitDecoration-modifiedResourceForeground)',
          opacity: 1,
        }}
      />
      <span style={styles.branchName(isActive, false)}>{mergedTag.name}</span>
      {showVcsBadge && (
        <span style={styles.vcsBadge(isSvn ? 'svn' : 'git')}>
          {isSvn ? 'SVN' : 'GIT'}
        </span>
      )}
      {multiRepo && (
        <span style={styles.dotGroup}>
          {mergedTag.repoIds.map(id => (
            <span key={id} style={styles.repoDot(repoColorMap[id] ?? '#888')} />
          ))}
        </span>
      )}
    </div>
  );
}

function useClampedPosition(x: number, y: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  useLayoutEffect(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = rect.right > vw ? Math.max(0, x - (rect.right - vw) - 4) : x;
    const top = rect.bottom > vh ? Math.max(0, y - (rect.bottom - vh) - 4) : y;
    setPos({ left, top });
  }, [x, y]);
  return { ref, pos };
}

function useDismissOnBlur(onClose: () => void) {
  useLayoutEffect(() => {
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const blurHandler = () => onClose();
    const visibilityHandler = () => {
      if (document.visibilityState !== 'visible') onClose();
    };
    document.addEventListener('keydown', keyHandler);
    document.addEventListener('visibilitychange', visibilityHandler);
    window.addEventListener('blur', blurHandler);
    return () => {
      document.removeEventListener('keydown', keyHandler);
      document.removeEventListener('visibilitychange', visibilityHandler);
      window.removeEventListener('blur', blurHandler);
    };
  }, [onClose]);
}

type MenuItem = { icon: string; label: string; action: () => void; danger?: boolean } | { sep: true };

const INTERACTION_STYLE = `
.versiondock-sidebar-row[data-selected="false"]:hover {
  background: var(--vscode-list-hoverBackground) !important;
}
.versiondock-sidebar-row[data-selected="true"]:hover {
  filter: brightness(1.08);
}
[data-top-action-btn]:hover {
  background: var(--vscode-toolbar-hoverBackground) !important;
  opacity: 1 !important;
}
[data-context-menu-item]:hover {
  background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground)) !important;
}
`;

function MenuItemRow({ item }: { item: MenuItem }) {
  if ('sep' in item) return <div style={styles.separator} />;
  return (
    <div
      data-context-menu-item=""
      role="menuitem"
      tabIndex={0}
      style={styles.menuItem(item.danger)}
      onClick={item.action}
      onKeyDown={event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        item.action();
      }}
    >
      <Codicon name={item.icon} style={styles.menuIcon} />
      {item.label}
    </div>
  );
}

function TagContextMenu({ mergedTag, x, y, isSvn, canDelete, onClose, onCheckout, onMerge, onPush, onDelete }: {
  mergedTag: MergedTag;
  x: number; y: number;
  isSvn: boolean;
  canDelete: boolean;
  onClose: () => void;
  onCheckout: () => void;
  onMerge: () => void;
  onPush: () => void;
  onDelete: () => void;
}) {
  const { ref, pos } = useClampedPosition(x, y);
  useDismissOnBlur(onClose);
  const items: MenuItem[] = [
    { icon: 'arrow-right', label: isSvn ? t('Switch to "{0}"', mergedTag.name) : t('Checkout "{0}"', mergedTag.name), action: onCheckout },
    { sep: true },
    { icon: 'git-merge', label: isSvn ? t('Merge tag into working copy') : t('Merge into current'), action: onMerge },
    ...(!isSvn ? [
      { icon: 'cloud-upload', label: t('Push to remote...'), action: onPush },
    ] satisfies MenuItem[] : []),
    ...(canDelete ? [{ sep: true as const }, { icon: 'trash', label: isSvn ? t('Delete SVN tag') : t('Delete tag'), action: onDelete, danger: true }] : []),
  ];

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div ref={ref} role="menu" style={styles.contextMenu(pos.left, pos.top)}>
        {items.map((item, i) => <MenuItemRow key={i} item={item} />)}
      </div>
    </>
  );
}

function ContextMenu({ merged, x, y, isSvn, isRemote, canDelete, canCompare, onClose, onCheckout, onCompareWithCurrent, onShowWorktreeDiff, onMerge, onRebase, onDelete, onPull, onPush }: {
  merged: MergedBranch;
  x: number; y: number;
  isSvn: boolean;
  isRemote: boolean;
  canDelete: boolean;
  canCompare: boolean;
  onClose: () => void;
  onCheckout: () => void;
  onCompareWithCurrent: () => void;
  onShowWorktreeDiff: () => void;
  onMerge: () => void;
  onRebase: () => void;
  onDelete: () => void;
  onPull: () => void;
  onPush: () => void;
}) {
  const { ref, pos } = useClampedPosition(x, y);
  useDismissOnBlur(onClose);
  const items: MenuItem[] = [
    { icon: 'arrow-right', label: isSvn ? t("Switch to '{0}'", merged.baseName) : t("Checkout '{0}'", merged.baseName), action: onCheckout },
    { sep: true },
    ...(!isSvn && canCompare ? [
      { icon: 'git-compare', label: t('Compare with Current'), action: onCompareWithCurrent },
      { icon: 'diff-multiple', label: t('Show Diff with Working Tree'), action: onShowWorktreeDiff },
      { sep: true as const },
    ] : []),
    { icon: 'git-merge', label: isSvn ? t('Merge into working copy') : t('Merge into current'), action: onMerge },
    ...(!isSvn ? [{ icon: 'repo-forked', label: t("Rebase onto '{0}'", merged.baseName), action: onRebase }] satisfies MenuItem[] : []),
    ...(!isRemote ? [
      { sep: true as const },
      { icon: 'cloud-download', label: isSvn ? t('Update') : t('Pull'), action: onPull },
      ...(!isSvn ? [{ icon: 'cloud-upload', label: t('Push...'), action: onPush }] satisfies MenuItem[] : []),
    ] : []),
    ...(canDelete ? [{ sep: true as const }, { icon: 'trash', label: isSvn ? t('Delete SVN branch') : t('Delete branch'), action: onDelete, danger: true }] : []),
  ];

  return (
    <>
      <div style={styles.backdrop} onClick={onClose} />
      <div ref={ref} role="menu" style={styles.contextMenu(pos.left, pos.top)}>
        {items.map((item, i) => <MenuItemRow key={i} item={item} />)}
      </div>
    </>
  );
}


const styles = {
  container: {
    width: '220px',
    flexShrink: 0,
    borderRight: '1px solid var(--vscode-panel-border)',
    overflowY: 'auto' as const,
    overflowX: 'hidden' as const,
    background: 'var(--vscode-sideBar-background)',
    display: 'flex',
    flexDirection: 'column' as const,
    fontSize: '12px',
    color: 'var(--vscode-foreground)',
    position: 'relative' as const,
    userSelect: 'none' as const,
  },
  stickyHeader: {
    position: 'sticky' as const,
    top: 0,
    zIndex: 10,
    background: 'var(--vscode-sideBar-background)',
  },
  searchBox: {
    borderBottom: '1px solid var(--vscode-panel-border)',
    display: 'flex',
    alignItems: 'stretch',
    height: '35px',
  },
  searchInputWrap: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    alignItems: 'center',
    background: 'var(--vscode-input-background)',
    paddingLeft: '8px',
    gap: '5px',
  } as React.CSSProperties,
  searchIcon: {
    fontSize: '13px',
    flexShrink: 0,
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  searchInput: {
    flex: 1,
    minWidth: 0,
    padding: '0 6px 0 0',
    background: 'transparent',
    color: 'var(--vscode-input-foreground)',
    border: 'none',
    fontSize: '12px',
    outline: 'none',
    height: '100%',
    boxSizing: 'border-box' as const,
  },
  loadingRow: {
    height: '26px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '6px',
    color: 'var(--vscode-progressBar-background)',
    background: 'var(--vscode-sideBar-background)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    fontSize: '11px',
    flexShrink: 0,
  } as React.CSSProperties,
  loadingIcon: {
    fontSize: '13px',
  } as React.CSSProperties,
  collapseBtn: {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'none',
    border: 'none',
    borderLeft: '1px solid var(--vscode-panel-border)',
    cursor: 'pointer',
    padding: '0 5px',
    borderRadius: 0,
    color: 'var(--vscode-descriptionForeground)',
  } as React.CSSProperties,
  collapseBtnInner: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '3px 3px',
    borderRadius: '3px',
  } as React.CSSProperties,
  repoList: {
    borderBottom: '1px solid var(--vscode-panel-border)',
    padding: '3px 0',
  },
  repoRow: (active: boolean, filterSelected = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 8px',
    fontSize: '11px',
    color: active ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    background: active ? 'var(--vscode-list-activeSelectionBackground)' : 'transparent',
    cursor: 'pointer',
    outline: filterSelected ? '1px solid var(--vscode-focusBorder)' : 'none',
    outlineOffset: '-1px',
  }),
  repoName: {
    flex: 1,
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.04em',
    fontSize: '10px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  repoDot: (color: string): React.CSSProperties => ({
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  submoduleBadge: {
    fontSize: '9px',
    fontWeight: 'bold',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--versiondock-badge-foreground)',
    background: 'var(--versiondock-badge-background)',
    borderRadius: '3px',
    padding: '1px 4px',
    flexShrink: 0,
    marginLeft: '4px',
  } as React.CSSProperties,
  iconBtn: {
    background: 'transparent',
    border: 'none',
    color: 'var(--vscode-descriptionForeground)',
    cursor: 'pointer',
    padding: '1px 2px',
    display: 'flex',
    alignItems: 'center',
  } as React.CSSProperties,
  sectionHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '4px 8px',
    cursor: 'pointer',
    userSelect: 'none' as const,
    background: 'var(--vscode-sideBarSectionHeader-background)',
    borderBottom: '1px solid var(--vscode-panel-border)',
    color: 'var(--vscode-foreground)',
  },
  vcsBadge: (kind: 'git' | 'svn'): React.CSSProperties => ({
    fontSize: '9px',
    fontWeight: 'bold' as const,
    color: 'var(--versiondock-badge-foreground)',
    background: kind === 'svn'
      ? 'var(--vscode-charts-purple, #8957e5)'
      : 'var(--vscode-charts-orange, #f05033)',
    borderRadius: '3px',
    padding: '1px 4px',
    lineHeight: '12px',
    flexShrink: 0,
  }),
  chevron: {
    fontSize: '9px',
    width: '10px',
    flexShrink: 0,
  },
  sectionIcon: {
    fontSize: '13px',
    flexShrink: 0,
  } as React.CSSProperties,
  sectionLabel: {
    flex: 1,
    fontSize: '11px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.06em',
    color: 'var(--vscode-foreground)',
  },
  count: {
    background: 'var(--versiondock-badge-background)',
    color: 'var(--versiondock-badge-foreground)',
    borderRadius: '8px',
    padding: '0 5px',
    fontSize: '10px',
    flexShrink: 0,
  },
  branchRow: (isFilterSelected: boolean, isClickSelected = false, hovered = false, ctxActive = false, isHead = false): React.CSSProperties => ({
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    padding: '2px 8px 2px 12px',
    borderLeft: isHead ? '2px solid var(--vscode-textLink-foreground)' : '2px solid transparent',
    cursor: 'pointer',
    background: isClickSelected
      ? 'var(--vscode-list-activeSelectionBackground)'
      : isFilterSelected
        ? 'var(--vscode-list-hoverBackground)'
        : ctxActive
          ? 'var(--vscode-list-inactiveSelectionBackground)'
          : hovered
            ? 'var(--vscode-list-hoverBackground)'
            : 'transparent',
    color: isClickSelected ? 'var(--vscode-list-activeSelectionForeground)' : 'var(--vscode-foreground)',
    fontSize: '12px',
    minHeight: '22px',
    outline: isFilterSelected ? '1px solid var(--vscode-focusBorder)' : 'none',
    outlineOffset: '-1px',
  }),
  branchIcon: (isPrimary: boolean, isHead: boolean): React.CSSProperties => ({
    fontSize: '13px',
    flexShrink: 0,
    color: isHead
      ? 'var(--vscode-textLink-foreground)'
      : isPrimary
        ? 'var(--vscode-descriptionForeground)'
        : 'var(--vscode-foreground)',
    opacity: isPrimary || isHead ? 1 : 0.7,
  }),
  branchName: (isHead: boolean, isPrimary: boolean): React.CSSProperties => ({
    flex: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    fontWeight: isHead ? 600 : isPrimary ? 500 : 'normal',
  }),
  headBadge: {
    fontSize: '9px',
    fontWeight: 700,
    lineHeight: '14px',
    height: '14px',
    padding: '0 4px',
    borderRadius: '3px',
    color: 'var(--versiondock-badge-foreground)',
    background: 'var(--versiondock-badge-background)',
    flexShrink: 0,
    letterSpacing: '0.02em',
  } as React.CSSProperties,
  dotGroup: {
    display: 'flex',
    gap: '2px',
    alignItems: 'center',
    flexShrink: 0,
  } as React.CSSProperties,
  aheadBehind: {
    display: 'flex',
    gap: '2px',
    fontSize: '10px',
    flexShrink: 0,
  },
  pushIndicator: {
    color: PUSH_COLOR,
    fontWeight: 600,
  } as React.CSSProperties,
  pullIndicator: {
    color: PULL_COLOR,
    fontWeight: 600,
  } as React.CSSProperties,
  backdrop: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 100,
  },
  contextMenu: (x: number, y: number) => ({
    position: 'fixed' as const,
    left: x,
    top: y,
    zIndex: 101,
    background: 'var(--vscode-menu-background)',
    border: '1px solid var(--vscode-menu-border)',
    borderRadius: '4px',
    boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
    minWidth: '180px',
    padding: '4px 0',
    fontSize: '12px',
  }),
  menuItem: (danger?: boolean): React.CSSProperties => ({
    padding: '4px 12px',
    cursor: 'pointer',
    color: danger ? 'var(--vscode-errorForeground)' : 'var(--vscode-menu-foreground)',
    whiteSpace: 'nowrap' as const,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  }),
  menuIcon: {
    fontSize: '14px',
    flexShrink: 0,
  } as React.CSSProperties,
  menuItemDisabled: {
    padding: '4px 12px',
    color: 'var(--vscode-disabledForeground)',
    whiteSpace: 'nowrap' as const,
    fontStyle: 'italic',
    fontSize: '11px',
  } as React.CSSProperties,
  separator: {
    height: '1px',
    background: 'var(--vscode-menu-separatorBackground)',
    margin: '4px 0',
  } as React.CSSProperties,
};
