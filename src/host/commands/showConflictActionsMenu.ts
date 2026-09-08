import * as vscode from 'vscode';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import type { ConflictsPanelProvider } from '../panels/ConflictsPanelProvider';
import type { GitService } from '../git/GitService';
import {
  collectAbortOperationTargets,
  runAbortOperationFlow,
  getAbortOperationLabel,
  getAbortOperationDescription,
} from '../utils/abortOperation';
import { t } from '../utils/l10n';

interface ConflictActionItem extends vscode.QuickPickItem {
  action: () => Promise<void> | void;
}

export async function showConflictActionsMenu(
  manager: WorkspaceGitManager,
  conflictsPanel: ConflictsPanelProvider,
): Promise<void> {
  const status = await manager.getAllStatusesFresh();
  const conflictingRepos = status.repos.filter(r => (r.conflictCount || 0) > 0);

  if (conflictingRepos.length === 0) {
    void vscode.commands.executeCommand('setContext', 'versiondock.hasConflicts', false);
    void vscode.window.showInformationMessage(t('No unresolved conflicts found.'));
    return;
  }

  void vscode.commands.executeCommand('setContext', 'versiondock.hasConflicts', true);

  const totalConflicts = conflictingRepos.reduce((sum, r) => sum + (r.conflictCount || 0), 0);
  const conflictRepoCount = conflictingRepos.length;

  const repoSummary = conflictRepoCount === 1
    ? t('{0} repository', conflictRepoCount)
    : t('{0} repositories', conflictRepoCount);
  const fileSummary = totalConflicts === 1
    ? t('{0} unresolved conflict file', totalConflicts)
    : t('{0} unresolved conflict files', totalConflicts);
  const conflictSummary = `${repoSummary} · ${fileSummary}`;

  const abortTargets = await collectAbortOperationTargets(
    manager,
    conflictingRepos.map(r => r.repoId),
  );

  const restorableRepos: Array<{ repo: GitService; paths: string[]; metaName: string }> = [];
  for (const cr of conflictingRepos) {
    const meta = manager.getRepoMeta(cr.repoId);
    const repo = manager.getRepo(cr.repoId);
    if (!meta || !repo || meta.kind === 'svn') continue;
    const opState = await repo.getOperationState();
    if (opState) continue;
    const fresh = await repo.getStatusFresh();
    const paths = [...new Set([...fresh.stagedFiles, ...fresh.unstagedFiles]
      .filter(f => f.status === 'conflicted')
      .map(f => f.path))];
    if (paths.length > 0) {
      restorableRepos.push({ repo, paths, metaName: meta.name });
    }
  }

  const items: ConflictActionItem[] = [];

  // 1. Resolve Conflicts
  items.push({
    label: `$(git-merge) ${t('Resolve Conflicts')}`,
    description: conflictSummary,
    detail: t('Open the conflicts panel to resolve files'),
    action: () => {
      conflictsPanel.open();
    },
  });

  // 2. Abort Operation (Rebase/Merge/Cherry-pick/Revert)
  if (abortTargets.length > 0) {
    const abortLabel = getAbortOperationLabel(abortTargets);
    const abortDesc = getAbortOperationDescription(abortTargets);
    items.push({
      label: `$(close) ${abortLabel}`,
      description: abortTargets.map(target => target.meta.name).join(', '),
      detail: abortDesc,
      action: async () => {
        const result = await runAbortOperationFlow(manager, abortTargets);
        if (!result.ok && 'error' in result) {
          void vscode.window.showErrorMessage(result.error);
        }
        await manager.refreshStatusNow();
      },
    });
  }

  // 3. Restore Current Branch
  const totalRestorableFiles = restorableRepos.reduce((sum, r) => sum + r.paths.length, 0);
  if (totalRestorableFiles > 0) {
    items.push({
      label: `$(discard) ${t('Restore Current Branch')}`,
      description: totalRestorableFiles === 1
        ? t('{0} unresolved conflict file', totalRestorableFiles)
        : t('{0} unresolved conflict files', totalRestorableFiles),
      detail: t('Discard conflicted index and working tree changes, then restore the current branch versions'),
      action: async () => {
        const singleTarget = restorableRepos.length === 1 ? restorableRepos[0] : undefined;
        const confirm = await vscode.window.showWarningMessage(
          singleTarget
            ? (totalRestorableFiles === 1
                ? t('VersionDock [{0}]: Restore the conflicted file to the current branch version? This discards its index and working tree changes.', singleTarget.metaName)
                : t('VersionDock [{0}]: Restore {1} conflicted files to their current branch versions? This discards their index and working tree changes.', singleTarget.metaName, totalRestorableFiles))
            : (totalRestorableFiles === 1
                ? t('VersionDock: Restore the conflicted file to the current branch version? This discards its index and working tree changes.')
                : t('VersionDock: Restore {0} conflicted files to their current branch versions? This discards their index and working tree changes.', totalRestorableFiles)),
          { modal: true },
          t('Restore Current Branch'),
        );
        if (confirm !== t('Restore Current Branch')) return;

        for (const target of restorableRepos) {
          for (const filePath of target.paths) {
            try {
              await target.repo.discardFile(filePath);
            } catch (err) {
              void vscode.window.showErrorMessage(String(err));
            }
          }
        }
        await manager.refreshStatusNow();
      },
    });
  }

  const selected = await vscode.window.showQuickPick(items, {
    title: `VersionDock: ${t('There are still unresolved conflicts')}`,
    placeHolder: t('Select an action to resolve or handle conflicts'),
  });

  if (selected) {
    await selected.action();
  }
}
