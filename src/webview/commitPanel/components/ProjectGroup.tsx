import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FileStatus, RepoStatus } from '../../shared/types';
import type { ViewMode } from '../store/commitStore';
import { useCommitStore, type LayoutDensity } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { FileTree } from './FileTree';
import { Codicon } from '../../shared/Codicon';
import { t } from '../../shared/i18n';
import { baseNameFromPath } from '../../shared/pathUtils';
import { branchInfoColor, readableAccentColor } from '../../shared/branchColors';
import { mergeRepoFiles } from '../utils/mergeRepoFiles';
import { scopedKey } from '../../shared/scopedKey';
import { nativeCheckboxBorderStyle } from '../../shared/nativeCheckboxStyle';

interface Props {
  repoStatus: RepoStatus;
  repoName: string;
  repoRootPath?: string;
  repoColor: string;
  showVcsBadge: boolean;
  isFirst?: boolean;
  isSubmodule?: boolean;
  submodulePath?: string;
  isWorktree?: boolean;
  mainWorktreePath?: string;
  kind?: 'git' | 'svn';
  selectedFile: { repoId: string; path: string } | null;
  viewMode: ViewMode;
  isFileSelected: (repoId: string, path: string) => boolean;
  isCollapsed: (key: string) => boolean;
  toggleCollapsed: (key: string) => void;
  onToggleFile: (repoId: string, path: string) => void;
  onSetFiles: (repoId: string, paths: string[], selected: boolean) => void;
  onSelectFile: (file: FileStatus) => void;
  onContextMenu: (e: React.MouseEvent, file: FileStatus) => void;
  onFolderContextMenu: (e: React.MouseEvent, repoId: string, folderPath: string, files: FileStatus[]) => void;
  onOpenFile: (file: FileStatus) => void;
  onRollback: (files: FileStatus[]) => void;
  onResolveMerge: (file: FileStatus) => void;
  onBranchClick: (repoId: string) => void;
  onRepoContextMenu: (e: React.MouseEvent, repoId: string) => void;
  onOpenAllChanges: (repoId: string) => void;
  iconTheme?: IconThemeData | null;
  activeFolderPath?: string | null;
  ctxFile?: { repoId: string; path: string } | null;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}

export function ProjectGroup({
  repoStatus, repoName, repoRootPath, repoColor, showVcsBadge, isFirst = false,
  isSubmodule, submodulePath, isWorktree, mainWorktreePath, kind,
  selectedFile, viewMode,
  isFileSelected, isCollapsed, toggleCollapsed,
  onToggleFile, onSetFiles, onSelectFile, onContextMenu, onFolderContextMenu, onOpenFile, onRollback, onResolveMerge,
  onBranchClick, onRepoContextMenu, onOpenAllChanges, iconTheme, activeFolderPath, ctxFile,
  speedSearchQuery, activeSpeedSearchKey,
}: Props) {
  const repoId = repoStatus.repoId;
  const repoCollapseKey = scopedKey('repo', repoId);
  const collapsed = isCollapsed(repoCollapseKey);
  const branchClr = branchInfoColor(repoStatus.branch);
  const projectColor = readableAccentColor(repoColor);
  const { stagedFiles, unstagedFiles } = repoStatus;

  const allFiles = useMemo(
    () => mergeRepoFiles({ stagedFiles, unstagedFiles }),
    [stagedFiles, unstagedFiles],
  );

  const totalFiles = allFiles.length;
  const selectedCount = allFiles.filter(f => isFileSelected(repoId, f.path)).length;
  const allSelected = totalFiles > 0 && selectedCount === totalFiles;
  const someSelected = selectedCount > 0 && !allSelected;

  const toggleAll = () => {
    onSetFiles(repoId, allFiles.map(f => f.path), !allSelected);
  };

  const [hovered, setHovered] = useState(false);
  const layoutDensity = useCommitStore(s => s.layoutDensity);

  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <div style={styles.container(isFirst, layoutDensity)}>
      <div
        style={styles.header(projectColor, isFirst, layoutDensity, hovered)}
        onContextMenu={e => { e.preventDefault(); onRepoContextMenu(e, repoId); }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={allSelected}
          onChange={totalFiles > 0 ? toggleAll : () => {}}
          onClick={(e) => e.stopPropagation()}
          disabled={totalFiles === 0}
          style={{ ...styles.repoCheckbox, ...nativeCheckboxBorderStyle(), ...(totalFiles === 0 ? { opacity: 0.3, cursor: 'default', pointerEvents: 'none' } : {}) }}
          title={totalFiles > 0 ? t('Select all files in this repo') : undefined}
        />

        <div style={styles.headerMain} onClick={() => toggleCollapsed(repoCollapseKey)}>
          <Codicon name={collapsed ? 'chevron-right' : 'chevron-down'} style={styles.chevron} />
          <span style={styles.dot(projectColor)} />
          <span style={styles.name}>
            {isWorktree && mainWorktreePath ? baseNameFromPath(mainWorktreePath) ?? repoName : repoName}
          </span>
          {isSubmodule && (
            <span style={styles.submoduleBadge} title={submodulePath ? t('Submodule: {0}', submodulePath) : t('Submodule')}>
              {t('SUB')}
            </span>
          )}
          {showVcsBadge && (
            <span
              style={styles.vcsBadge(kind === 'svn' ? 'svn' : 'git')}
              title={kind === 'svn' ? t('SVN working copy') : 'Git'}
            >
              {kind === 'svn' ? 'SVN' : 'GIT'}
            </span>
          )}
          <span
            data-branch-switch-badge=""
            style={styles.branchBadge(branchClr)}
            onClick={(e) => { e.stopPropagation(); onBranchClick(repoId); }}
            title={repoStatus.branch.detachedTag
              ? t('Tag: {0} (detached HEAD)', repoStatus.branch.detachedTag)
              : repoStatus.branch.detachedHash
                ? t('Detached HEAD at {0}', repoStatus.branch.detachedHash)
                : repoStatus.branch.name}
          >
            <Codicon name={isWorktree ? 'repo-clone' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0 }} />
            <span style={styles.branchName}>{repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name}</span>
          </span>
          {totalFiles > 0 && (
            <div style={styles.rightGroup}>
              <button
                data-action-btn=""
                style={{ ...styles.openChangesBtn, opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none' }}
                onClick={e => { e.stopPropagation(); onOpenAllChanges(repoId); }}
                title={t('Open all changes')}
              >
                <Codicon name="diff-multiple" />
              </button>
              <span style={styles.countBadge(selectedCount > 0)}>
                {selectedCount}/{totalFiles}
              </span>
            </div>
          )}
        </div>
      </div>

      {!collapsed && (
        <div style={styles.body}>
          {allFiles.length > 0 ? (
            <FileTree
              repoId={repoId}
              repoName={repoName}
              repoRootPath={repoRootPath}
              files={allFiles}
              iconTheme={iconTheme}
              selectedFile={selectedFile}
              onSelect={onSelectFile}
              onToggleFile={onToggleFile}
              onSetFiles={onSetFiles}
              isFileSelected={isFileSelected}
              isCollapsed={isCollapsed}
              toggleCollapsed={toggleCollapsed}
              onContextMenu={onContextMenu}
              onFolderContextMenu={onFolderContextMenu}
              onOpenFile={onOpenFile}
              onRollback={onRollback}
              onResolveMerge={onResolveMerge}
              viewMode={viewMode}
              activeFolderPath={activeFolderPath}
              ctxFile={ctxFile}
              speedSearchQuery={speedSearchQuery}
              activeSpeedSearchKey={activeSpeedSearchKey}
            />
          ) : (
            <div style={styles.noChanges}>{t('No changes')}</div>
          )}
        </div>
      )}
      {layoutDensity === 'compact' ? (
        <div style={{ borderBottom: '1px solid var(--vscode-panel-border)' }} />
      ) : !collapsed && allFiles.length > 0 ? (
        <div style={{ borderBottom: '1px solid var(--vscode-panel-border)', marginTop: '4px' }} />
      ) : null}
    </div>
  );
}

interface SingleRepoHeaderProps {
  repoStatus: RepoStatus;
  repoName: string;
  repoColor: string;
  isSubmodule?: boolean;
  submodulePath?: string;
  isWorktree?: boolean;
  mainWorktreePath?: string;
  onBranchClick: (repoId: string) => void;
  onRepoContextMenu: (e: React.MouseEvent, repoId: string) => void;
  onOpenAllChanges: (repoId: string) => void;
  hideOpenChanges?: boolean;
}

export function SingleRepoHeader({ repoStatus, repoName, repoColor, isSubmodule, submodulePath, isWorktree, mainWorktreePath, onBranchClick, onRepoContextMenu, onOpenAllChanges, hideOpenChanges }: SingleRepoHeaderProps) {
  const repoId = repoStatus.repoId;
  const branchClr = branchInfoColor(repoStatus.branch);
  const projectColor = readableAccentColor(repoColor);
  const [hovered, setHovered] = useState(false);
  const layoutDensity = useCommitStore(s => s.layoutDensity);

  return (
    <div
      style={styles.header(projectColor, true, layoutDensity, hovered)}
      onContextMenu={e => { e.preventDefault(); onRepoContextMenu(e, repoId); }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={styles.headerMain} onClick={() => onBranchClick(repoId)}>
        <span style={styles.dot(projectColor)} />
        <span style={styles.name}>
          {isWorktree && mainWorktreePath ? baseNameFromPath(mainWorktreePath) ?? repoName : repoName}
        </span>
        {isSubmodule && (
          <span style={styles.submoduleBadge} title={submodulePath ? t('Submodule: {0}', submodulePath) : t('Submodule')}>
            {t('SUB')}
          </span>
        )}
        <span
          data-branch-switch-badge=""
          style={styles.branchBadge(branchClr)}
          onClick={e => { e.stopPropagation(); onBranchClick(repoId); }}
          title={repoStatus.branch.detachedTag
            ? t('Tag: {0} (detached HEAD)', repoStatus.branch.detachedTag)
            : repoStatus.branch.detachedHash
              ? t('Detached HEAD at {0}', repoStatus.branch.detachedHash)
              : repoStatus.branch.name}
        >
          <Codicon name={isWorktree ? 'repo-clone' : repoStatus.branch.detachedTag ? 'tag' : repoStatus.branch.detachedHash ? 'git-commit' : 'git-branch'} style={{ fontSize: '10px', flexShrink: 0 }} />
          <span style={styles.branchName}>{repoStatus.branch.detachedTag ?? repoStatus.branch.detachedHash ?? repoStatus.branch.name}</span>
        </span>
        {!hideOpenChanges && (
          <div style={styles.rightGroup}>
            <button
              data-action-btn=""
              style={{ ...styles.openChangesBtn, opacity: hovered ? 1 : 0, pointerEvents: hovered ? 'auto' : 'none' }}
              onClick={e => { e.stopPropagation(); onOpenAllChanges(repoId); }}
              title={t('Open all changes')}
            >
              <Codicon name="diff-multiple" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  container: (isFirst: boolean, density: LayoutDensity = 'comfortable'): React.CSSProperties => {
    if (density === 'compact') return {};
    return {
      marginTop: isFirst ? '4px' : '6px',
    };
  },
  header: (color: string, _isFirst: boolean, density: LayoutDensity = 'comfortable', hovered = false): React.CSSProperties => {
    if (density === 'compact') {
      return {
        display: 'flex',
        alignItems: 'center',
        background: hovered ? color + '33' : color + '22',
        height: '26px',
        boxSizing: 'border-box',
        transition: 'background 0.12s',
      };
    }
    return {
      display: 'flex',
      alignItems: 'center',
      background: hovered ? color + '28' : color + '1c',
      border: `1px solid ${color}${hovered ? '55' : '38'}`,
      borderRadius: '6px',
      height: '27px',
      margin: '0 6px',
      boxSizing: 'border-box',
      transition: 'background 0.12s, border-color 0.12s',
    };
  },
  repoCheckbox: {
    margin: '0 0 0 6px',
    flexShrink: 0,
    accentColor: 'var(--vscode-button-background)',
  } as React.CSSProperties,
  headerMain: {
    display: 'flex',
    alignItems: 'center',
    gap: '4px',
    padding: '3px 8px 3px 4px',
    cursor: 'pointer',
    flex: 1,
    fontSize: '11px',
    fontWeight: 'bold' as const,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
    color: 'var(--vscode-foreground)',
    userSelect: 'none' as const,
    minWidth: 0,
  },
  chevron: {
    fontSize: '12px',
    flexShrink: 0,
  },
  dot: (color: string): React.CSSProperties => ({
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: color,
    flexShrink: 0,
  }),
  name: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    flexShrink: 10,
    minWidth: '20px',
  } as React.CSSProperties,
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
  } as React.CSSProperties,
  vcsBadge: (kind: 'git' | 'svn'): React.CSSProperties => ({
    fontSize: '9px',
    fontWeight: 'bold',
    letterSpacing: 0,
    color: 'var(--versiondock-badge-foreground)',
    background: kind === 'svn'
      ? 'var(--vscode-charts-purple, #8957e5)'
      : 'var(--vscode-charts-orange, #f05033)',
    borderRadius: '3px',
    padding: '1px 4px',
    flexShrink: 0,
  }),
  branchBadge: (color: string): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    gap: '3px',
    fontSize: '10px',
    fontWeight: 600,
    textTransform: 'none' as const,
    letterSpacing: 0,
    background: `${color}33`,
    color,
    border: `1px solid ${color}88`,
    borderRadius: '3px',
    padding: '1px 5px',
    flexShrink: 1,
    minWidth: '0',
    maxWidth: '160px',
    marginLeft: '4px',
    cursor: 'pointer',
    overflow: 'hidden',
  }),
  branchName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
    minWidth: 0,
  } as React.CSSProperties,
  rightGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: '1px',
    marginLeft: 'auto',
    flexShrink: 0,
  } as React.CSSProperties,
  countBadge: (hasSelected: boolean): React.CSSProperties => ({
    background: hasSelected ? 'var(--versiondock-badge-background)' : 'transparent',
    color: hasSelected ? 'var(--versiondock-badge-foreground)' : 'var(--vscode-descriptionForeground)',
    borderRadius: '8px',
    padding: hasSelected ? '1px 5px' : '0',
    fontSize: '10px',
    fontWeight: 'bold',
    flexShrink: 0,
    minWidth: '18px',
    textAlign: 'center',
  }),
  openChangesBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    color: 'var(--vscode-descriptionForeground)',
    padding: '2px 4px',
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    borderRadius: '3px',
  } as React.CSSProperties,
  body: {
    display: 'flex',
    flexDirection: 'column' as const,
  },
  noChanges: {
    padding: '12px 8px',
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground)',
    textAlign: 'center' as const,
  },
};
