import * as vscode from 'vscode';
import { CommitPanelProvider } from '../panels/CommitPanelProvider';
import { GitLogPanelProvider } from '../panels/GitLogPanelProvider';
import { MergeEditorProvider } from '../panels/MergeEditorProvider';
import { ConflictsPanelProvider } from '../panels/ConflictsPanelProvider';
import { BranchStatusBar } from '../ui/BranchStatusBar';
import { FileAnnotationController } from '../ui/FileAnnotationController';
import { ProfileStatusBar } from '../ui/ProfileStatusBar';
import { t } from '../utils/l10n';
import { showGitErrorMessage } from '../utils/gitError';
import type { LineRange } from '../types/git';
import type { WorkspaceGitManager } from '../git/WorkspaceGitManager';
import { formatRepoLabel } from '../utils/repoLabels';
import { validateBranchNameInput, sanitizeBranchName } from '../utils/branchNameSanitizer';
import { showConflictActionsMenu } from './showConflictActionsMenu';
import { checkoutSvnRepository } from '../svn/svnCheckout';

function getScmResourceUri(resource: unknown): vscode.Uri | undefined {
  if (resource instanceof vscode.Uri) return resource;
  if (resource && typeof resource === 'object') {
    const candidate = resource as { resourceUri?: unknown; uri?: unknown };
    if (candidate.resourceUri instanceof vscode.Uri) return candidate.resourceUri;
    if (candidate.uri instanceof vscode.Uri) return candidate.uri;
  }
  return undefined;
}

function getSelectionLineRange(selection: vscode.Selection): LineRange {
  const startLine = selection.start.line + 1;
  let endLine = selection.end.line;
  if (selection.end.character === 0 && selection.end.line > selection.start.line) {
    endLine -= 1;
  }
  return {
    start: startLine,
    end: endLine + 1,
  };
}

export function registerCommands(
  context: vscode.ExtensionContext,
  commitPanel: CommitPanelProvider,
  logPanel: GitLogPanelProvider,
  mergeEditor: MergeEditorProvider,
  conflictsPanel: ConflictsPanelProvider,
  branchStatusBar: BranchStatusBar,
  annotationController: FileAnnotationController,
  profileStatusBar: ProfileStatusBar,
  manager?: WorkspaceGitManager,
): void {
  context.subscriptions.push(
    // Focus the Git Log panel in the bottom bar
    vscode.commands.registerCommand('versiondock.openLog', () => {
      return logPanel.focus();
    }),

    vscode.commands.registerCommand('versiondock.refreshCommitPanel', () => {
      return commitPanel.refresh({ refreshSubtrees: commitPanel.isSubtreeTabActive() });
    }),

    vscode.commands.registerCommand('versiondock.selectAll', () => {
      commitPanel.selectAll();
    }),

    vscode.commands.registerCommand('versiondock.invertSelection', () => {
      commitPanel.invertSelection();
    }),

    vscode.commands.registerCommand('versiondock.expandAll', () => {
      commitPanel.expandAll();
    }),

    vscode.commands.registerCommand('versiondock.expandAll.checked', () => {
      commitPanel.expandAll();
    }),

    vscode.commands.registerCommand('versiondock.collapseAll', () => {
      commitPanel.collapseAll();
    }),

    vscode.commands.registerCommand('versiondock.collapseAll.checked', () => {
      commitPanel.collapseAll();
    }),

    vscode.commands.registerCommand('versiondock.setFileViewModeToFlat', () => {
      return commitPanel.setFileViewMode('flat');
    }),

    vscode.commands.registerCommand('versiondock.setFileViewModeToFlat.checked', () => {
      return commitPanel.setFileViewMode('flat');
    }),

    vscode.commands.registerCommand('versiondock.setFileViewModeToTree', () => {
      return commitPanel.setFileViewMode('tree');
    }),

    vscode.commands.registerCommand('versiondock.setFileViewModeToTree.checked', () => {
      return commitPanel.setFileViewMode('tree');
    }),

    vscode.commands.registerCommand('versiondock.openMergeEditor', (resource?: unknown) => {
      const uri = getScmResourceUri(resource);
      if (uri?.scheme === 'file') {
        mergeEditor.openForFile(uri.fsPath);
        return;
      }
      mergeEditor.openCurrentEditorFile();
    }),

    vscode.commands.registerCommand('versiondock.openConflicts', () => {
      conflictsPanel.open();
    }),

    vscode.commands.registerCommand('versiondock.showConflictActions', async () => {
      if (!manager) return;
      await showConflictActionsMenu(manager, conflictsPanel);
    }),

    vscode.commands.registerCommand('versiondock.openMergeEditorFromSCM', (resource?: unknown) => {
      const uri = getScmResourceUri(resource);
      if (!uri || uri.scheme !== 'file') {
        mergeEditor.openCurrentEditorFile();
        return;
      }
      mergeEditor.openForFile(uri.fsPath);
    }),

    vscode.commands.registerCommand('versiondock.showFileHistory', async (resource?: unknown) => {
      const uri = getScmResourceUri(resource) ?? vscode.window.activeTextEditor?.document.uri;
      if (!uri || uri.scheme !== 'file') {
        vscode.window.showWarningMessage(t('VersionDock: Open a local file to show file history.'));
        return;
      }
      await logPanel.showFileHistoryForFile(uri.fsPath);
    }),

    vscode.commands.registerCommand('versiondock.showSelectionHistory', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== 'file') {
        vscode.window.showWarningMessage(t('VersionDock: Open a local file to show selection history.'));
        return;
      }
      const { selection } = editor;
      if (selection.isEmpty) {
        vscode.window.showWarningMessage(t('VersionDock: Select one or more lines to show selection history.'));
        return;
      }
      await logPanel.showFileHistoryForFile(editor.document.uri.fsPath, getSelectionLineRange(selection));
    }),

    vscode.commands.registerCommand('versiondock.commit', () => {
      return commitPanel.triggerCommitAction(false);
    }),

    vscode.commands.registerCommand('versiondock.commitAndPush', () => {
      return commitPanel.triggerCommitAction(true);
    }),

    vscode.commands.registerCommand('versiondock.pull', (repoId?: string) => {
      return branchStatusBar.pull(repoId);
    }),

    vscode.commands.registerCommand('versiondock.push', () => {
      return branchStatusBar.push();
    }),

    vscode.commands.registerCommand('versiondock.fetchAll', async () => {
      await branchStatusBar.fetchAll();
    }),

    vscode.commands.registerCommand('versiondock.showBranchMenu', (repoId?: string) => {
      return branchStatusBar.showMenu(repoId);
    }),

    vscode.commands.registerCommand('versiondock.showBranchOptions', (repoId: string, branchName: string) => {
      return branchStatusBar.showBranchOptions(repoId, branchName);
    }),

    vscode.commands.registerCommand('versiondock.updateProject', () => {
      return branchStatusBar.updateProject();
    }),

    vscode.commands.registerCommand('versiondock.openSettings', () => {
      return vscode.commands.executeCommand('workbench.action.openSettings', '@ext:chenqinru.versiondock');
    }),

    vscode.commands.registerCommand('versiondock.openGitAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.openAnnotations(editor);
    }),

    vscode.commands.registerCommand('versiondock.closeGitAnnotations', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) annotationController.closeAnnotations(editor);
    }),

    vscode.commands.registerCommand('versiondock.openGitGhostText', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.openGhostText(editor);
    }),

    vscode.commands.registerCommand('versiondock.closeGitGhostText', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) annotationController.closeGhostText(editor);
    }),

    vscode.commands.registerCommand('versiondock.openSvnAnnotations', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.openAnnotations(editor);
    }),

    vscode.commands.registerCommand('versiondock.closeSvnAnnotations', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) annotationController.closeAnnotations(editor);
    }),

    vscode.commands.registerCommand('versiondock.openSvnGhostText', async () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) await annotationController.openGhostText(editor);
    }),

    vscode.commands.registerCommand('versiondock.closeSvnGhostText', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) annotationController.closeGhostText(editor);
    }),

    vscode.commands.registerCommand('versiondock.navigateToAnnotationCommit', (hash: string, repoId: string) => {
      annotationController.navigateToCommit(hash, repoId);
    }),

    vscode.commands.registerCommand('versiondock.manageHiddenRepos', () => {
      return commitPanel.manageHiddenRepos();
    }),

    vscode.commands.registerCommand('versiondock.manageProfiles', () => {
      return profileStatusBar.showMenu();
    }),

    vscode.commands.registerCommand('versiondock.switchProfile', () => {
      return profileStatusBar.switchProfile();
    }),

    vscode.commands.registerCommand('versiondock.reloadRepositories', () => {
      if (manager) {
        manager.reinitializeAndRefresh();
      }
    }),

    // ── Submodule commands ────────────────────────────────────────────────────

    vscode.commands.registerCommand('versiondock.submodule.init', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, false);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_INIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath });
    }),

    vscode.commands.registerCommand('versiondock.submodule.update', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_UPDATE', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, recursive: false });
    }),

    vscode.commands.registerCommand('versiondock.submodule.updateRecursive', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_UPDATE', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, recursive: true });
    }),

    vscode.commands.registerCommand('versiondock.submodule.deinit', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_DEINIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, force: false });
    }),

    vscode.commands.registerCommand('versiondock.submodule.deinitForce', async (repoId?: string) => {
      const sub = await pickSubmodule(manager, repoId, true);
      if (!sub) return;
      const reqId = Math.random().toString(36).slice(2);
      commitPanel.handleSubmoduleCommand({ type: 'SUBMODULE_DEINIT', requestId: reqId, parentRepoId: sub.parentRepoId, submodulePath: sub.submodulePath, force: true });
    }),

    vscode.commands.registerCommand('versiondock.submodule.openInNewWindow', async (repoId?: string) => {
      const metas = manager?.getRepoMetas().filter(m => m.isSubmodule) ?? [];
      let target = repoId ? metas.find(m => m.id === repoId) : undefined;
      if (!target && metas.length === 1) target = metas[0];
      if (!target) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: m.name, description: m.submodulePath, id: m.id })),
          { title: t('Open Submodule in New Window'), placeHolder: t('Select a submodule…') }
        );
        if (!picked) return;
        target = metas.find(m => m.id === picked.id);
      }
      if (target) {
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(target.rootPath), { forceNewWindow: true });
      }
    }),

    // ── Worktree commands ─────────────────────────────────────────────────────
    vscode.commands.registerCommand('versiondock.worktree.add', async () => {
      if (!commitPanel) return;
      // Determine which repo to use
      const metas = manager?.getRepoMetas().filter(m => (m.kind ?? 'git') === 'git' && !m.isSubmodule && !m.isWorktree) ?? [];
      let repoId: string | undefined;
      if (metas.length === 1) {
        repoId = metas[0].id;
      } else if (metas.length > 1) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: formatRepoLabel(m), description: m.rootPath, id: m.id })),
          { title: t('New Worktree — Select Repository'), placeHolder: t('Select a repository…') }
        );
        if (!picked) return;
        repoId = picked.id;
      }
      if (!repoId) return;
      commitPanel.handleSubmoduleCommand({ type: 'WORKTREE_CREATE_PROMPT', repoId });
    }),

    vscode.commands.registerCommand('versiondock.worktree.prune', async () => {
      if (!commitPanel) return;
      const metas = manager?.getRepoMetas().filter(m => (m.kind ?? 'git') === 'git' && !m.isSubmodule && !m.isWorktree) ?? [];
      let repoId: string | undefined;
      if (metas.length === 1) {
        repoId = metas[0].id;
      } else if (metas.length > 1) {
        const picked = await vscode.window.showQuickPick(
          metas.map(m => ({ label: formatRepoLabel(m), description: m.rootPath, id: m.id })),
          { title: t('Prune Worktrees — Select Repository'), placeHolder: t('Select a repository…') }
        );
        if (!picked) return;
        repoId = picked.id;
      }
      if (!repoId) return;
      commitPanel.handleSubmoduleCommand({ type: 'WORKTREE_PRUNE', requestId: Math.random().toString(36).slice(2), repoId });
    }),

    // ── Subtree commands ─────────────────────────────────────────────────────
    vscode.commands.registerCommand('versiondock.subtree.add', () => {
      return commitPanel.handleSubtreeCommand('add');
    }),

    vscode.commands.registerCommand('versiondock.subtree.pull', () => {
      return commitPanel.handleSubtreeCommand('pull');
    }),

    vscode.commands.registerCommand('versiondock.subtree.push', () => {
      return commitPanel.handleSubtreeCommand('push');
    }),

    vscode.commands.registerCommand('versiondock.subtree.split', () => {
      return commitPanel.handleSubtreeCommand('split');
    }),

    vscode.commands.registerCommand('versiondock.subtree.merge', () => {
      return commitPanel.handleSubtreeCommand('merge');
    }),

    vscode.commands.registerCommand('versiondock.subtree.remove', () => {
      return commitPanel.handleSubtreeCommand('remove');
    }),

    vscode.commands.registerCommand('versiondock.subtree.manage', () => {
      return commitPanel.handleSubtreeCommand('manage');
    }),

    // ── SVN commands ────────────────────────────────────────────────────────
    vscode.commands.registerCommand('versiondock.svn.cleanup', async (repoId?: string) => {
      const picked = await pickSvnRepo(manager, repoId);
      if (!picked) return;
      const svn = picked.repo as typeof picked.repo & { cleanup?: () => Promise<string> };
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: SVN cleanup', picked.meta.name), cancellable: false },
        async () => {
          await svn.cleanup?.();
        }
      );
      await commitPanel.refresh();
    }),

    vscode.commands.registerCommand('versiondock.svn.resolveWorking', async (resource?: unknown) => {
      const target = await pickSvnFile(manager, resource);
      if (!target) return;
      const svn = target.repo as typeof target.repo & { resolveWorking?: (filePath: string) => Promise<void> };
      await svn.resolveWorking?.(target.relativePath);
      await commitPanel.refresh();
    }),

    vscode.commands.registerCommand('versiondock.svn.lock', async (resource?: unknown) => {
      const target = await pickSvnFile(manager, resource);
      if (!target) return;
      const message = await vscode.window.showInputBox({
        title: t('SVN Lock'),
        prompt: t('Optional lock message'),
        placeHolder: t('Lock message'),
      });
      if (message === undefined) return;
      const svn = target.repo as typeof target.repo & { lock?: (paths: string[], message?: string) => Promise<string> };
      await svn.lock?.([target.relativePath], message);
      await commitPanel.refresh();
    }),

    vscode.commands.registerCommand('versiondock.svn.unlock', async (resource?: unknown) => {
      const target = await pickSvnFile(manager, resource);
      if (!target) return;
      const svn = target.repo as typeof target.repo & { unlock?: (paths: string[]) => Promise<string> };
      await svn.unlock?.([target.relativePath]);
      await commitPanel.refresh();
    }),

    vscode.commands.registerCommand('versiondock.svn.relocate', async (repoId?: string) => {
      const picked = await pickSvnRepo(manager, repoId);
      if (!picked) return;
      const svn = picked.repo as typeof picked.repo & {
        getRepositoryInfo: () => Promise<{ url: string; rootUrl: string; relativeUrl: string }>;
        relocateRepository: (newRootUrl: string) => Promise<void>;
      };
      let info: { url: string; rootUrl: string; relativeUrl: string };
      try {
        info = await svn.getRepositoryInfo();
      } catch (e: unknown) {
        vscode.window.showErrorMessage(t('VersionDock [{0}]: {1}', picked.meta.name, String(e)));
        return;
      }
      const newRootUrl = await vscode.window.showInputBox({
        title: t('SVN Relocate — {0}', picked.meta.name),
        prompt: t('Current: {0}. Enter the new SVN repository root URL', info.rootUrl),
        value: info.rootUrl,
        placeHolder: info.rootUrl || 'https://svn.example.com/repository',
        validateInput: value => {
          const trimmed = value.trim();
          if (!trimmed) return t('SVN repository URL cannot be empty.');
          if (trimmed === info.rootUrl) return t('New SVN repository URL is the same as the current URL.');
          return undefined;
        },
      });
      if (newRootUrl === undefined) return;
      const targetUrl = newRootUrl.trim();
      const confirm = await vscode.window.showWarningMessage(
        t('VersionDock [{0}]: Relocate SVN working copy from "{1}" to "{2}"?', picked.meta.name, info.rootUrl, targetUrl),
        {
          modal: true,
          detail: t('This runs svn switch --relocate and changes the repository root URL for the working copy.'),
        },
        t('Relocate'),
      );
      if (confirm !== t('Relocate')) return;

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: t('VersionDock [{0}]: SVN relocating…', picked.meta.name), cancellable: false },
          async () => {
            await svn.relocateRepository(targetUrl);
          },
        );
        vscode.window.showInformationMessage(t('VersionDock [{0}]: SVN repository relocated to "{1}".', picked.meta.name, targetUrl));
        await commitPanel.refresh();
        logPanel.refresh();
        await branchStatusBar.refresh();
      } catch (e: unknown) {
        void showGitErrorMessage(t('VersionDock [{0}]: {1}', picked.meta.name, String(e)), {
          repoName: picked.meta.name,
          onUnlocked: async () => {
            await manager?.getAllStatusesFresh();
          },
        });
      }
    }),

    vscode.commands.registerCommand('versiondock.svn.switch', async (repoId?: string) => {
      const picked = await pickSvnRepo(manager, repoId);
      if (!picked) return;
      const branches = await picked.repo.getBranches().catch(() => []);
      const tags = await picked.repo.getTags().catch(() => []);
      const items = [
        ...branches.map(branch => ({ label: `$(git-branch) ${branch.name}`, value: branch.name })),
        ...tags.map(tag => ({ label: `$(tag) ${tag.name}`, value: `tags/${tag.name}` })),
      ];
      const selected = await vscode.window.showQuickPick(items, {
        title: t('SVN Switch — {0}', picked.meta.name),
        placeHolder: t('Select a trunk, branch, or tag'),
      });
      if (!selected) return;
      await picked.repo.checkout(selected.value);
      await commitPanel.refresh();
      logPanel.refresh();
    }),

    vscode.commands.registerCommand('versiondock.svn.createBranch', async (repoId?: string) => {
      const picked = await pickSvnRepo(manager, repoId);
      if (!picked) return;
      const name = await vscode.window.showInputBox({
        title: t('SVN Create Branch'),
        prompt: t('Branch name under /branches'),
        validateInput: v => validateBranchNameInput(v),
      });
      if (!name) return;
      await picked.repo.createBranch(sanitizeBranchName(name.trim()));
      logPanel.refresh();
    }),

    vscode.commands.registerCommand('versiondock.svn.createTag', async (repoId?: string) => {
      const picked = await pickSvnRepo(manager, repoId);
      if (!picked) return;
      const name = await vscode.window.showInputBox({
        title: t('SVN Create Tag'),
        prompt: t('Tag name under /tags'),
        validateInput: v => v.trim() ? undefined : t('Tag name cannot be empty'),
      });
      if (!name) return;
      const current = await picked.repo.getCurrentBranch().catch(() => undefined);
      await picked.repo.createTag(name.trim(), current?.lastCommitHash ?? '');
      logPanel.refresh();
    }),

    vscode.commands.registerCommand('versiondock.svn.checkout', async (targetDir?: string) => {
      await checkoutSvnRepository(manager, targetDir);
      logPanel.refresh();
    }),
  );

  // ─────────────────────────────────────────────────────────────────────────

  // Track files with conflict markers so we know when they've been resolved
  const conflictedFiles = new Set<string>();

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(doc => {
      if (doc.uri.scheme !== 'file') return;
      if (doc.getText().includes('<<<<<<<')) {
        conflictedFiles.add(doc.uri.fsPath);
      }
    }),

    vscode.workspace.onDidChangeTextDocument(e => {
      if (e.document.uri.scheme !== 'file') return;
      if (e.document.getText().includes('<<<<<<<')) {
        conflictedFiles.add(e.document.uri.fsPath);
      }
    }),

    vscode.workspace.onDidSaveTextDocument(doc => {
      if (doc.uri.scheme !== 'file') return;
      if (!conflictedFiles.has(doc.uri.fsPath)) return;
      if (!doc.getText().includes('<<<<<<<')) {
        conflictedFiles.delete(doc.uri.fsPath);
        // Delay to run after VS Code's built-in SCM view focus
        setTimeout(() => {
          vscode.commands.executeCommand('versiondock.commitPanel.focus');
        }, 300);
      }
    }),
  );
}

async function pickSvnRepo(
  manager: WorkspaceGitManager | undefined,
  repoId?: string,
): Promise<{ meta: NonNullable<ReturnType<WorkspaceGitManager['getRepoMetas']>[number]>; repo: NonNullable<ReturnType<WorkspaceGitManager['getRepo']>> } | undefined> {
  const metas = manager?.getRepoMetas().filter(meta => meta.kind === 'svn') ?? [];
  if (metas.length === 0) {
    vscode.window.showInformationMessage(t('VersionDock: No SVN working copies found in this workspace.'));
    return undefined;
  }

  let meta = repoId ? metas.find(item => item.id === repoId) : undefined;
  if (!meta && metas.length === 1) meta = metas[0];
  if (!meta) {
    const picked = await vscode.window.showQuickPick(
      metas.map(item => ({ label: formatRepoLabel(item), description: item.rootPath, id: item.id })),
      { title: t('Select SVN Working Copy'), placeHolder: t('Select an SVN working copy…') }
    );
    if (!picked) return undefined;
    meta = metas.find(item => item.id === picked.id);
  }
  if (!meta) return undefined;
  const repo = manager?.getRepo(meta.id);
  return repo ? { meta, repo } : undefined;
}

async function pickSvnFile(
  manager: WorkspaceGitManager | undefined,
  resource?: unknown,
): Promise<{ repo: NonNullable<ReturnType<WorkspaceGitManager['getRepo']>>; relativePath: string } | undefined> {
  const uri = getScmResourceUri(resource) ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== 'file') {
    vscode.window.showWarningMessage(t('VersionDock: Open a local SVN file first.'));
    return undefined;
  }
  const service = manager ? await manager.resolveServiceForFile(uri.fsPath, 'svn', {
    notFoundMessage: t('The selected file is not inside an SVN working copy.'),
  }) : undefined;
  if (!service) {
    return undefined;
  }
  const repo = manager?.getRepo(service.repoId);
  if (!repo || repo.kind !== 'svn') return undefined;
  const path = await import('path');
  return {
    repo,
    relativePath: path.relative(repo.rootPath, uri.fsPath).split(path.sep).join('/'),
  };
}

async function pickSubmodule(
  manager: WorkspaceGitManager | undefined,
  repoId: string | undefined,
  _requireInitialized: boolean,
): Promise<{ parentRepoId: string; submodulePath: string } | undefined> {
  const metas = manager?.getRepoMetas().filter(m => m.isSubmodule) ?? [];
  if (metas.length === 0) {
    vscode.window.showInformationMessage(t('VersionDock: No submodules found in this workspace.'));
    return undefined;
  }

  let meta = repoId ? metas.find(m => m.id === repoId) : undefined;
  if (!meta && metas.length === 1) meta = metas[0];
  if (!meta) {
    const picked = await vscode.window.showQuickPick(
      metas.map(m => ({ label: m.name, description: m.submodulePath ?? '', id: m.id })),
      { title: t('Select Submodule'), placeHolder: t('Select a submodule…') }
    );
    if (!picked) return undefined;
    meta = metas.find(m => m.id === picked.id);
  }
  if (!meta?.parentRepoId || !meta.submodulePath) return undefined;
  return { parentRepoId: meta.parentRepoId, submodulePath: meta.submodulePath };
}
