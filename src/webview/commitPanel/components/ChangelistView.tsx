import React from 'react';
import type { ChangelistData, FileStatus, RepoMeta, RepoStatus } from '../../shared/types';
import { CHANGELIST_DEFAULT_ID, CHANGELIST_UNVERSIONED_ID } from '../../shared/types';
import type { ViewMode } from '../store/commitStore';
import type { IconThemeData } from '../../../host/types/messages';
import { ChangelistGroup } from './ChangelistGroup';
import { baseNameFromPath } from '../../shared/pathUtils';
import { SingleRepoHeader } from './ProjectGroup';
import { mergeRepoFiles } from '../utils/mergeRepoFiles';
import { scopedKey } from '../../shared/scopedKey';

interface Props {
  changelists: ChangelistData[];
  repos: RepoStatus[];
  repoMetas: RepoMeta[];
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
  onStage?: (file: FileStatus) => void;
  onHeaderContextMenu: (e: React.MouseEvent, changelistId: string) => void;
  onRepoContextMenu: (e: React.MouseEvent, repoId: string, changelistId?: string) => void;
  onOpenChanges: (repoId: string) => void;
  onBranchClick: (repoId: string) => void;
  iconTheme?: IconThemeData | null;
  activeFolderPath?: string | null;
  ctxFile?: { repoId: string; path: string } | null;
  speedSearchQuery?: string;
  activeSpeedSearchKey?: string | null;
}

export function ChangelistView({
  changelists, repos, repoMetas,
  selectedFile, viewMode,
  isFileSelected, isCollapsed, toggleCollapsed,
  onToggleFile, onSetFiles, onSelectFile, onContextMenu, onFolderContextMenu,
  onOpenFile, onRollback, onResolveMerge, onStage, onHeaderContextMenu, onRepoContextMenu, onOpenChanges, onBranchClick, iconTheme, activeFolderPath, ctxFile,
  speedSearchQuery, activeSpeedSearchKey,
}: Props) {
  // Build a lookup: repoId+path → changelist id
  const fileToChangelist = new Map<string, string>();
  for (const cl of changelists) {
    for (const [repoId, paths] of Object.entries(cl.fileAssignments)) {
      for (const p of paths) fileToChangelist.set(scopedKey(repoId, p), cl.id);
    }
  }

  const metaMap = new Map(repoMetas.map(m => [m.id, m]));
  const singleRepo = repos.length === 1;
  const multiRepo = repos.length > 1;

  // For each changelist, compute which files (from the live git status) belong to it
  const changelistFiles = new Map<string, Map<string, FileStatus[]>>(); // clId → repoId → files
  for (const cl of changelists) {
    changelistFiles.set(cl.id, new Map());
  }

  for (const r of repos) {
    // Unversioned Files: always computed live from git status (untracked files), never from fileAssignments
    const unvMap = changelistFiles.get(CHANGELIST_UNVERSIONED_ID);
    if (unvMap) {
      const untracked = r.unstagedFiles.filter(f => f.status === 'untracked');
      if (untracked.length > 0) {
        unvMap.set(r.repoId, untracked);
      }
    }

    // All other files: merge staged + unstaged into a stable path-sorted list.
    for (const file of mergeRepoFiles(r, { includeUntracked: false })) {
      const key = scopedKey(r.repoId, file.path);
      const clId = fileToChangelist.get(key) ?? CHANGELIST_DEFAULT_ID;

      const clMap = changelistFiles.get(clId);
      if (!clMap) continue;
      if (!clMap.has(r.repoId)) clMap.set(r.repoId, []);
      clMap.get(r.repoId)!.push(file);
    }
  }

  const handleEmptyContextMenu = (e: React.MouseEvent) => {
    if (e.target !== e.currentTarget) return;
    e.preventDefault();
    onHeaderContextMenu(e, 'empty');
  };

  const singleRepoStatus = singleRepo ? repos[0] : null;
  const singleMeta = singleRepoStatus ? metaMap.get(singleRepoStatus.repoId) : null;

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}
      onContextMenu={handleEmptyContextMenu}
    >
      {singleRepoStatus && (
        <SingleRepoHeader
          repoStatus={singleRepoStatus}
          repoName={singleMeta?.name ?? singleRepoStatus.repoId.split('/').pop() ?? singleRepoStatus.repoId}
          repoColor={singleMeta?.color ?? '#4ec9b0'}
          isSubmodule={singleMeta?.isSubmodule}
          submodulePath={singleMeta?.submodulePath}
          isWorktree={singleMeta?.isWorktree}
          mainWorktreePath={singleMeta?.mainWorktreePath}
          onBranchClick={onBranchClick}
          onRepoContextMenu={(e, rid) => onRepoContextMenu(e, rid)}
          onOpenAllChanges={() => {}}
          hideOpenChanges
        />
      )}
      {changelists.map(cl => {
        const clMap = changelistFiles.get(cl.id) ?? new Map<string, FileStatus[]>();

        const buildGroup = (repoId: string, files: FileStatus[]) => {
          const meta = metaMap.get(repoId);
          const repoStatus = repos.find(r => r.repoId === repoId);
          return {
            repoId,
            repoName: meta?.name ?? baseNameFromPath(repoId) ?? repoId,
            repoRootPath: meta?.rootPath,
            repoColor: meta?.color ?? '#4ec9b0',
            repoStatus,
            files,
            isSubmodule: meta?.isSubmodule,
            submodulePath: meta?.submodulePath,
            isWorktree: meta?.isWorktree,
            mainWorktreePath: meta?.mainWorktreePath,
          };
        };

        const repoGroups = Array.from(clMap.entries())
          .filter(([, files]) => files.length > 0)
          .map(([repoId, files]) => buildGroup(repoId, files));

        // Hide "Unversioned Files" when empty
        if (cl.id === CHANGELIST_UNVERSIONED_ID && repoGroups.length === 0) return null;

        // For "Changes": show all repos, but exclude repos that already appear in any other changelist (including Unversioned Files)
        const reposInOtherChangelists = new Set<string>();
        if (cl.id === CHANGELIST_DEFAULT_ID) {
          for (const other of changelists) {
            if (other.id === CHANGELIST_DEFAULT_ID) continue;
            const otherMap = changelistFiles.get(other.id);
            if (!otherMap) continue;
            for (const [rid, files] of otherMap.entries()) {
              if (files.length > 0) reposInOtherChangelists.add(rid);
            }
          }
        }

        const allRepoGroups = !singleRepo && cl.id === CHANGELIST_DEFAULT_ID
          ? repos
              .filter(r => !reposInOtherChangelists.has(r.repoId) || (clMap.get(r.repoId)?.length ?? 0) > 0)
              .map(r => buildGroup(r.repoId, clMap.get(r.repoId) ?? []))
          : repoGroups;

        return (
          <ChangelistGroup
            key={cl.id}
            changelist={cl}
            repoGroups={allRepoGroups}
            multiRepo={multiRepo}
            singleRepo={singleRepo}
            selectedFile={selectedFile}
            viewMode={viewMode}
            isFileSelected={isFileSelected}
            isCollapsed={isCollapsed}
            toggleCollapsed={toggleCollapsed}
            onToggleFile={onToggleFile}
            onSetFiles={onSetFiles}
            onSelectFile={onSelectFile}
            onContextMenu={onContextMenu}
            onFolderContextMenu={onFolderContextMenu}
            onOpenFile={onOpenFile}
            onRollback={onRollback}
            onResolveMerge={onResolveMerge}
            onStage={onStage}
            onHeaderContextMenu={onHeaderContextMenu}
            onRepoContextMenu={onRepoContextMenu}
            onOpenChanges={onOpenChanges}
            onBranchClick={onBranchClick}
            iconTheme={iconTheme}
            activeFolderPath={activeFolderPath}
            ctxFile={ctxFile}
            speedSearchQuery={speedSearchQuery}
            activeSpeedSearchKey={activeSpeedSearchKey}
          />
        );
      })}
      {/* Spacer to ensure the empty area below also captures right-click */}
      <div style={{ flex: 1, minHeight: '40px' }} onContextMenu={e => { e.preventDefault(); onHeaderContextMenu(e, 'empty'); }} />
    </div>
  );
}
